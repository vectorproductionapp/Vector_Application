import math
import re
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify
from firebase_config import db
from firebase_admin import firestore
from auth_utils import roles_required
from read_cache import cached_read

models_bp = Blueprint("models", __name__)
models_collection = db.collection("models")
# `item_codes` is the normalized catalog.  BOQ rows retain `code` for
# backwards compatibility, while `itemCodeId` references this document.
item_codes_collection = db.collection("item_codes")
suppliers_collection = db.collection("suppliers")
item_code_counter = db.collection("_counters").document("boq_item_codes")


def _delete_document_tree(document_ref):
    """Delete a Firestore document and every nested subcollection document."""
    for collection_ref in document_ref.collections():
        for child_doc in collection_ref.stream():
            _delete_document_tree(child_doc.reference)
    document_ref.delete()


def _delete_linked_transactions(model_id, phase_ids=None):
    """Remove PO and invoice records belonging to deleted model phases."""
    phase_ids = set(phase_ids or [])

    def belongs_to_deleted_scope(data):
        if data.get("modelId") != model_id:
            return False
        return not phase_ids or data.get("phaseId") in phase_ids

    deleted_po_details = 0
    deleted_invoices = 0
    for doc in db.collection("po_details").stream():
        if belongs_to_deleted_scope(doc.to_dict() or {}):
            doc.reference.delete()
            deleted_po_details += 1
    for doc in db.collection("invoices").stream():
        if belongs_to_deleted_scope(doc.to_dict() or {}):
            doc.reference.delete()
            deleted_invoices += 1

    return deleted_po_details, deleted_invoices


def _save_suppliers(rows):
    """Keep a reusable supplier catalogue from saved BOQ entries."""
    suppliers = {
        (row.get("vendor") or "").strip().casefold(): (row.get("vendor") or "").strip()
        for row in rows if (row.get("vendor") or "").strip()
    }
    if not suppliers:
        return

    # Firestore supports up to 10 values in an `in` query.  Query each chunk
    # once and commit all missing suppliers in one batch instead of making a
    # network round trip for every BOQ row.
    existing = set()
    normalized_names = list(suppliers)
    for start in range(0, len(normalized_names), 10):
        chunk = normalized_names[start:start + 10]
        existing.update(
            (doc.to_dict() or {}).get("normalizedName", "")
            for doc in suppliers_collection.where("normalizedName", "in", chunk).stream()
        )

    batch = db.batch()
    created_at = datetime.now(timezone.utc)
    missing = [name for name in normalized_names if name not in existing]
    for normalized_name in missing:
        batch.set(suppliers_collection.document(), {
            "name": suppliers[normalized_name],
            "normalizedName": normalized_name,
            "createdAt": created_at,
        })
    if missing:
        batch.commit()


def _serialize(doc):
    d = doc.to_dict()
    return {
        "id": doc.id,
        "name": d.get("name"),
        "date": d.get("date").isoformat() if d.get("date") else None,
    }


@models_bp.route("/models", methods=["POST"])
@roles_required("admin")
def create_model():
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"success": False, "message": "Model name is required"}), 400

    try:
        normalized_name = name.lower()
        existing = models_collection.where("normalizedName", "==", normalized_name).limit(1).get()
        if len(existing) > 0:
            return jsonify({"success": False, "message": "Model already exists"}), 409

        doc_ref = models_collection.document()
        created_at = datetime.now(timezone.utc)
        doc_ref.set({
            "name": name,
            "normalizedName": normalized_name,
            "date": created_at,
        })
        return jsonify({
            "success": True,
            "message": "Model created",
            "id": doc_ref.id,
            "name": name,
            "date": created_at.isoformat(),
        }), 201
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to create model: {exc}"}), 500


@models_bp.route("/models", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge", "user")
@cached_read("models", ttl_seconds=300)
def list_models():
    try:
        docs = models_collection.order_by("date").stream()
        return jsonify({"success": True, "models": [_serialize(doc) for doc in docs]}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch models: {exc}"}), 500


@models_bp.route("/suppliers", methods=["GET"])
@roles_required("admin", "coadmin")
@cached_read("suppliers", ttl_seconds=300)
def list_suppliers():
    try:
        suppliers = [
            (doc.to_dict() or {}).get("name", "").strip()
            for doc in suppliers_collection.stream()
        ]
        return jsonify({"success": True, "suppliers": sorted({name for name in suppliers if name}, key=str.casefold)}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch suppliers: {exc}"}), 500


@models_bp.route("/models/<model_id>", methods=["PUT"])
@roles_required("admin")
def update_model(model_id):
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    update_fields = {}
    if "name" in data:
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"success": False, "message": "Model name cannot be empty"}), 400
        update_fields["name"] = name
        update_fields["normalizedName"] = name.lower()

    if not update_fields:
        return jsonify({"success": False, "message": "Nothing to update"}), 400

    try:
        models_collection.document(model_id).update(update_fields)
        return jsonify({"success": True, "message": "Model updated"}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to update model: {exc}"}), 500


@models_bp.route("/models/<model_id>", methods=["DELETE"])
@roles_required("admin")
def delete_model(model_id):
    try:
        _delete_linked_transactions(model_id)
        _delete_document_tree(models_collection.document(model_id))
        return jsonify({"success": True, "message": "Model deleted"}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to delete model: {exc}"}), 500


def _phase_doc(model_id):
    return models_collection.document(model_id).collection("phases")


def _serialize_phase(doc):
    d = doc.to_dict()
    return {
        "id": doc.id,
        "name": d.get("name"),
        "itemCodeId": d.get("itemCodeId", ""),
        "itemCode": d.get("itemCode", ""),
        "date": d.get("date").isoformat() if d.get("date") else None,
    }


@models_bp.route("/models/<model_id>/phases", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge", "user")
@cached_read("phases", ttl_seconds=300)
def list_phases(model_id):
    try:
        phases = _phase_doc(model_id).order_by("date").stream()
        return jsonify({"success": True, "phases": [_serialize_phase(doc) for doc in phases]}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch phases: {exc}"}), 500


@models_bp.route("/models/<model_id>/phases", methods=["POST"])
@roles_required("admin")
def create_phase(model_id):
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"success": False, "message": "Phase name is required"}), 400

    item_code = _normalise_item_code(data.get("itemCode")) if data.get("itemCode") else ""
    if data.get("itemCode") and not item_code:
        return jsonify({"success": False, "message": "Item Code cannot be blank or contain a slash"}), 400

    try:
        phases_collection = _phase_doc(model_id)
        normalized_name = name.lower()
        existing = phases_collection.where("normalizedName", "==", normalized_name).limit(1).get()
        if len(existing) > 0:
            return jsonify({"success": False, "message": "Phase already exists"}), 409

        item_code_id = ""
        if item_code:
            # The catalog document is the normalized entity / foreign-key target.
            item_code_doc = _item_code_ref(item_code).get()
            if not item_code_doc.exists:
                return jsonify({"success": False, "message": "Select an existing Item Code or create a new one"}), 400
            item_code_id = item_code_doc.id

        doc_ref = phases_collection.document()
        created_at = datetime.now(timezone.utc)
        doc_ref.set({
            "name": name,
            "normalizedName": normalized_name,
            "itemCodeId": item_code_id,
            "itemCode": item_code,
            "date": created_at,
        })
        return jsonify({
            "success": True,
            "message": "Phase created",
            "id": doc_ref.id,
            "name": name,
            "itemCodeId": item_code_id,
            "itemCode": item_code,
            "date": created_at.isoformat(),
        }), 201
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to create phase: {exc}"}), 500
def _boq_collection(model_id, phase_id):
    return (
        models_collection.document(model_id)
        .collection("phases")
        .document(phase_id)
        .collection("boqs")
    )


def _item_code_number(value):
    """Return the numeric part of an ITM code, or zero for other values."""
    if not isinstance(value, str):
        return 0
    match = re.fullmatch(r"ITM-(\d+)", value.strip(), re.IGNORECASE)
    return int(match.group(1)) if match else 0


def _normalise_item_code(value):
    """Return a stable catalog code, preserving legacy non-ITM codes.

    Newly generated codes use the ITM-001 sequence.  Existing BOQ records may
    use a different code format, however, and must remain selectable instead
    of being silently omitted from the Item Code catalog.
    """
    if not isinstance(value, str):
        return ""
    code = value.strip()
    if not code or "/" in code:
        return ""
    match = re.fullmatch(r"ITM-(\d+)", code, re.IGNORECASE)
    if match:
        return f"ITM-{int(match.group(1)):03d}"
    return code.upper()


def _item_code_ref(code):
    # Using the canonical code as the document id gives Firestore-level
    # uniqueness without requiring a relational database migration.
    return item_codes_collection.document(code)


def _highest_existing_item_code():
    """Supports installations that already have BOQ rows before the counter."""
    highest = 0
    for boq_doc in db.collection_group("boqs").stream():
        for row in (boq_doc.to_dict() or {}).get("rows", []) or []:
            highest = max(highest, _item_code_number(row.get("code")))
    return highest


def _sync_legacy_item_codes():
    """Backfill the catalog from all existing phase and BOQ item codes.

    This is intentionally idempotent: `create` preserves the original
    `createdAt` and a concurrent backfill simply sees an already-existing
    document.  It doubles as a no-downtime migration for existing Firestore
    installations.
    """
    def add_to_catalog(value, source):
        code = _normalise_item_code(value)
        if not code:
            return
        try:
            _item_code_ref(code).create({
                "code": code,
                "createdAt": datetime.now(timezone.utc),
                "source": source,
            })
        except Exception as exc:
            # Firestore raises AlreadyExists for a normal concurrent/repeated
            # backfill. Other failures must be returned to the caller.
            if "AlreadyExists" not in exc.__class__.__name__ and "409" not in str(exc):
                raise

    # Item Codes can be created while a phase is created, before that phase
    # contains any BOQ rows. Include those phase-level values in the global
    # dropdown catalogue as well.
    for model_doc in models_collection.stream():
        for phase_doc in model_doc.reference.collection("phases").stream():
            add_to_catalog((phase_doc.to_dict() or {}).get("itemCode"), "legacy-phase")

    for boq_doc in db.collection_group("boqs").stream():
        for row in (boq_doc.to_dict() or {}).get("rows", []) or []:
            add_to_catalog(row.get("code"), "legacy-boq")


def _highest_catalog_item_code():
    highest = 0
    for doc in item_codes_collection.stream():
        highest = max(highest, _item_code_number((doc.to_dict() or {}).get("code")))
    return highest


@firestore.transactional
def _reserve_item_code_numbers(transaction, minimum_last_number, quantity):
    """Reserve a contiguous, globally unique block of BOQ item numbers."""
    counter_snapshot = item_code_counter.get(transaction=transaction)
    counter_data = counter_snapshot.to_dict() if counter_snapshot.exists else {}
    current_last_number = max(
        int(counter_data.get("lastItemCodeNumber", 0) or 0),
        minimum_last_number,
    )
    next_last_number = current_last_number + quantity
    transaction.set(item_code_counter, {
        "lastItemCodeNumber": next_last_number,
        "updatedAt": datetime.now(timezone.utc),
    }, merge=True)
    return range(current_last_number + 1, next_last_number + 1)


@firestore.transactional
def _create_next_item_code(transaction, minimum_last_number):
    """Atomically reserve and persist one unique Item Code catalog record."""
    # Keep all reads and writes in this one transaction.  Calling a second
    # @transactional helper here creates a nested transaction and can prevent
    # Firestore from committing the generated code.
    counter_snapshot = item_code_counter.get(transaction=transaction)
    counter_data = counter_snapshot.to_dict() if counter_snapshot.exists else {}
    current_last_number = max(
        int(counter_data.get("lastItemCodeNumber", 0) or 0),
        minimum_last_number,
    )
    next_last_number = current_last_number + 1
    code = f"ITM-{next_last_number:03d}"
    code_ref = _item_code_ref(code)
    transaction.create(code_ref, {
        "code": code,
        "createdAt": datetime.now(timezone.utc),
        "source": "generated",
    })
    transaction.set(item_code_counter, {
        "lastItemCodeNumber": next_last_number,
        "updatedAt": datetime.now(timezone.utc),
    }, merge=True)
    return {"id": code_ref.id, "code": code}


def _generate_next_item_code():
    """Generate a code with transaction retries for concurrent requests."""
    # The full legacy scan is needed only once, before the counter exists.
    # Running it for every new code made the dropdown and BOQ saves slower as
    # the BOQ collection grew.
    counter_exists = item_code_counter.get().exists
    if not counter_exists:
        _sync_legacy_item_codes()
    # Firestore retries transaction contention itself.  The small outer retry
    # also covers a legacy document appearing between the catalog scan and
    # transaction commit.
    last_error = None
    for _ in range(3):
        try:
            minimum = max(_highest_existing_item_code(), _highest_catalog_item_code()) if not counter_exists else 0
            return _create_next_item_code(db.transaction(), minimum)
        except Exception as exc:
            last_error = exc
    raise last_error


@models_bp.route("/item-codes", methods=["GET"])
@roles_required("admin", "coadmin")
@cached_read("item-codes", ttl_seconds=300)
def list_item_codes():
    """Return all known Item Codes for the searchable BOQ combobox."""
    try:
        item_codes = []
        for doc in item_codes_collection.stream():
            data = doc.to_dict() or {}
            code = _normalise_item_code(data.get("code") or doc.id)
            if code:
                item_codes.append({
                    "id": doc.id,
                    "code": code,
                    "desc": data.get("desc", ""),
                    "createdAt": data.get("createdAt").isoformat() if data.get("createdAt") else None,
                })
        item_codes.sort(key=lambda item: (
            _item_code_number(item["code"]) == 0,
            _item_code_number(item["code"]),
            item["code"],
        ))
        return jsonify({"success": True, "itemCodes": item_codes}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch Item Codes: {exc}"}), 500


@models_bp.route("/item-codes/generate", methods=["POST"])
@roles_required("admin")
def generate_item_code():
    """Create and reserve the next sequential Item Code for a BOQ row."""
    try:
        item_code = _generate_next_item_code()
        return jsonify({"success": True, "message": "Item Code generated", "itemCode": item_code}), 201
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to generate Item Code: {exc}"}), 500


def _assign_global_item_codes(rows, existing_rows=None):
    """Resolve BOQ rows to catalog Item Codes, preserving legacy payloads."""
    prepared_rows = [dict(row) for row in rows]
    rows_needing_codes = [
        row for row in prepared_rows if not _normalise_item_code(row.get("code"))
    ]

    if rows_needing_codes:
        for row in rows_needing_codes:
            generated = _generate_next_item_code()
            row["code"] = generated["code"]
            row["itemCodeId"] = generated["id"]

    codes = {_normalise_item_code(row.get("code")) for row in prepared_rows}
    if "" in codes:
        raise ValueError("Item Code cannot be blank or contain a slash")
    code_docs = {doc.id: doc for doc in db.get_all([_item_code_ref(code) for code in codes])}
    missing_codes = sorted(code for code in codes if code not in code_docs or not code_docs[code].exists)
    if missing_codes:
        raise ValueError(f"Item Code {missing_codes[0]} does not exist. Select an existing code or create a new one.")

    batch = db.batch()
    for row in prepared_rows:
        code = _normalise_item_code(row.get("code"))
        code_doc = code_docs[code]
        row["code"] = code
        row["itemCodeId"] = code_doc.id
        description = (row.get("desc") or "").strip()
        if description:
            batch.set(code_doc.reference, {"desc": description}, merge=True)
    if prepared_rows:
        batch.commit()

    return prepared_rows


def _serialize_boq(doc):
    d = doc.to_dict()
    return {
        "id": doc.id,
        "rows": d.get("rows", []),
        "date": d.get("date").isoformat() if d.get("date") else None,
    }


def _parse_pagination_params(args):
    try:
        page = int(args.get("page", 1))
    except (TypeError, ValueError):
        page = 1

    try:
        limit = int(args.get("limit", 10))
    except (TypeError, ValueError):
        limit = 10

    if page < 1:
        page = 1
    if limit < 1:
        limit = 10
    if limit > 100:
        limit = 100

    return page, limit


@models_bp.route("/models/<model_id>/phases/<phase_id>/boq", methods=["GET"])
@roles_required("admin", "coadmin")
@cached_read("boq", ttl_seconds=120)
def get_boq(model_id, phase_id):
    try:
        docs = list(_boq_collection(model_id, phase_id).limit(1).stream())
        if not docs:
            return jsonify({"success": True, "boq": None}), 200

        page, limit = _parse_pagination_params(request.args)
        boq_doc = docs[0]
        boq_data = _serialize_boq(boq_doc)
        rows = boq_data.get("rows", []) or []

        total_count = len(rows)
        total_pages = max(1, math.ceil(total_count / limit))
        if page > total_pages:
            page = total_pages

        offset = (page - 1) * limit
        page_rows = rows[offset:offset + limit]

        return jsonify({
            "success": True,
            "boq": {
                **boq_data,
                "rows": page_rows,
                "allRows": rows,
                "pagination": {
                    "page": page,
                    "limit": limit,
                    "totalCount": total_count,
                    "totalPages": total_pages,
                    "hasNextPage": page < total_pages,
                    "hasPrevPage": page > 1,
                },
            },
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch BOQ: {exc}"}), 500


@models_bp.route("/models/<model_id>/phases/<phase_id>/boq", methods=["POST"])
@roles_required("admin")
def create_boq(model_id, phase_id):
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    rows = data.get("rows")
    if not rows or not isinstance(rows, list):
        return jsonify({"success": False, "message": "BOQ rows are required"}), 400

    try:
        boq_collection = _boq_collection(model_id, phase_id)
        # Enforce only one BOQ per phase
        existing = list(boq_collection.limit(1).stream())
        if existing:
            return jsonify({"success": False, "message": "BOQ already exists for this phase"}), 409

        rows = _assign_global_item_codes(rows)
        _save_suppliers(rows)
        doc_ref = boq_collection.document()
        created_at = datetime.now(timezone.utc)
        doc_ref.set({"rows": rows, "date": created_at})
        return jsonify({
            "success": True,
            "message": "BOQ created",
            "id": doc_ref.id,
            "rows": rows,
            "date": created_at.isoformat(),
        }), 201
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to create BOQ: {exc}"}), 500


@models_bp.route("/models/<model_id>/phases/<phase_id>", methods=["PUT"])
@roles_required("admin")
def update_phase(model_id, phase_id):
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    update_fields = {}
    if "name" in data:
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"success": False, "message": "Phase name cannot be empty"}), 400
        update_fields["name"] = name
        update_fields["normalizedName"] = name.lower()

    if not update_fields:
        return jsonify({"success": False, "message": "Nothing to update"}), 400

    try:
        _phase_doc(model_id).document(phase_id).update(update_fields)
        return jsonify({"success": True, "message": "Phase updated"}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to update phase: {exc}"}), 500


@models_bp.route("/models/<model_id>/phases/<phase_id>/boq/<boq_id>", methods=["PUT"])
@roles_required("admin")
def update_boq(model_id, phase_id, boq_id):
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    rows = data.get("rows")
    if rows is None or not isinstance(rows, list):
        return jsonify({"success": False, "message": "BOQ rows are required"}), 400

    try:
        boq_ref = _boq_collection(model_id, phase_id).document(boq_id)
        existing_boq = boq_ref.get()
        if not existing_boq.exists:
            return jsonify({"success": False, "message": "BOQ not found"}), 404

        rows = _assign_global_item_codes(rows, (existing_boq.to_dict() or {}).get("rows", []))
        _save_suppliers(rows)
        boq_ref.update({"rows": rows})
        return jsonify({"success": True, "message": "BOQ updated"}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to update BOQ: {exc}"}), 500


@models_bp.route("/models/<model_id>/phases/<phase_id>/boq/<boq_id>", methods=["DELETE"])
@roles_required("admin")
def delete_boq(model_id, phase_id, boq_id):
    try:
        _boq_collection(model_id, phase_id).document(boq_id).delete()
        return jsonify({"success": True, "message": "BOQ deleted"}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to delete BOQ: {exc}"}), 500
    
@models_bp.route("/boq/phases", methods=["GET"])
@roles_required("admin", "coadmin")
@cached_read("boq-phases", ttl_seconds=300)
def list_boq_phases():
    """
    Returns every phase across every model, tagged with its parent model,
    so the PO Details form can populate a single searchable Phase dropdown
    without needing a separate Model selector.
    """
    try:
        active_models = {
            model_doc.id: (model_doc.to_dict() or {})
            for model_doc in models_collection.stream()
        }
        phase_docs = db.collection_group("phases").stream()
        results = []
 
        for phase_doc in phase_docs:
            phase_data = phase_doc.to_dict() or {}
            model_ref = phase_doc.reference.parent.parent  # models/<model_id>
            if model_ref is None:
                continue

            # Firestore does not automatically remove subcollections when an
            # older model document is deleted. Never expose those orphaned
            # phases in the PO form.
            model_data = active_models.get(model_ref.id)
            if model_data is None:
                continue
 
            results.append({
                "modelId": model_ref.id,
                "modelName": model_data.get("name", ""),
                "phaseId": phase_doc.id,
                "phaseName": phase_data.get("name", ""),
            })
 
        results.sort(key=lambda r: (r["modelName"].lower(), r["phaseName"].lower()))
        return jsonify({"success": True, "phases": results}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch BOQ phases: {exc}"}), 500
    


@models_bp.route("/models/bulk-delete", methods=["POST"])
@roles_required("admin")
def bulk_delete_models():
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    ids = data.get("ids")
    if not ids or not isinstance(ids, list) or len(ids) == 0:
        return jsonify({"success": False, "message": "Model ids are required"}), 400

    deleted = []
    failed = []

    for model_id in ids:
        try:
            _delete_linked_transactions(model_id)
            _delete_document_tree(models_collection.document(model_id))
            deleted.append(model_id)
        except Exception:
            failed.append(model_id)

    return jsonify({
        "success": True,
        "message": f"Deleted {len(deleted)} of {len(ids)} model(s)",
        "deleted": deleted,
        "failed": failed,
    }), 200   


@models_bp.route("/models/<model_id>/phases/bulk-delete", methods=["POST"])
@roles_required("admin")
def bulk_delete_phases(model_id):
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    ids = data.get("ids")
    if not ids or not isinstance(ids, list) or len(ids) == 0:
        return jsonify({"success": False, "message": "Phase ids are required"}), 400

    deleted = []
    failed = []
    phases_collection = _phase_doc(model_id)

    for phase_id in ids:
        try:
            _delete_linked_transactions(model_id, [phase_id])
            _delete_document_tree(phases_collection.document(phase_id))
            deleted.append(phase_id)
        except Exception:
            failed.append(phase_id)

    return jsonify({
        "success": True,
        "message": f"Deleted {len(deleted)} of {len(ids)} phase(s)",
        "deleted": deleted,
        "failed": failed,
    }), 200

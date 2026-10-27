from datetime import datetime, timezone
import math

from flask import Blueprint, request, jsonify

from firebase_config import db
from auth_utils import roles_required
from read_cache import cached_read, invalidate_read_cache
from date_range import in_date_range, read_date_range
from attachments import delete_files, entries_of, normalise_entries, upload_files

podetails_bp = Blueprint("po_details", __name__)
po_details_collection = db.collection("po_details")

REQUIRED_FIELDS = [
    "phase", "modelId", "phaseId", "po", "supplier", "date", "code", "make", "model",
    "desc", "qty", "rate", "expectedDeliveryDate", "status"
]

# Everything the PO Details form submits.
ALLOWED_FIELDS = [
    "phase", "modelId", "phaseId", "po", "supplier", "date", "code", "make", "model",
    "desc", "qty", "rate", "gstRate", "expectedDeliveryDate", "status",
    "image", "imageName", "attachments",
]

# One storage folder for PO attachments; invoice lines use their own.
ATTACHMENT_PREFIX = "po-attachments"

# How many records a single attachment lookup may cover.
MAX_IMAGE_IDS = 50

MAX_NAME_CHARS = 160


def _header_doc_id(model_id, phase_id, phase_name, po):
    """A stable document id for one PO number (per phase, per model)."""
    model_id = str(model_id or "").strip()
    phase_id = str(phase_id or "").strip()
    phase_name = str(phase_name or "").strip()
    po = str(po or "").strip()
    parts = [model_id, phase_id, phase_name, po]
    raw = "|".join(parts)
    import hashlib
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _header_ref(model_id, phase_id, phase_name, po):
    return po_details_collection.document(_header_doc_id(model_id, phase_id, phase_name, po))


def _text(value):
    return "" if value is None else str(value).strip()


def _gst_rate(data, strict=False):
    """Extract and validate GST rate from record data."""
    raw = data.get("gstRate")
    if raw is None or str(raw).strip() == "":
        if strict:
            raise ValueError("GST % is required")
        return 18  # Default fallback
    try:
        rate = float(raw)
    except (ValueError, TypeError):
        if strict:
            raise ValueError("GST % must be a number")
        return 18
    # Normalise 18% style input to 18, and 0.18 style to 18
    if rate < 1:
        rate = round(rate * 100)
    return int(round(rate))


def _calc_totals(rate, qty, gst_rate):
    """Calculate basic price, GST and total for a PO line."""
    base = float(rate or 0) * float(qty or 0)
    gst = base * (gst_rate / 100)
    total = base + gst
    return round(base, 2), round(gst, 2), round(base + gst, 2)


def _text(value):
    return "" if value is None else str(value).strip()


def _validated_record(data):
    """Validate one PO payload and build the Firestore-ready record."""
    for f in REQUIRED_FIELDS:
        if not _text(data.get(f)):
            raise ValueError(f"Missing required field: {f}")

    gst_rate = _gst_rate(data, strict=True)
    base, gst, total = _calc_totals(data.get("rate"), data.get("qty"), gst_rate)

    record = {k: _text(data.get(k)) for k in ALLOWED_FIELDS}
    record["qty"] = float(data.get("qty") or 0)
    record["rate"] = float(data.get("rate") or 0)
    record["gstRate"] = float(data.get("gstRate") or 0)
    record["basicPrice"] = round(base, 2)
    record["gst"] = round(gst, 2)
    record["value"] = round(total, 2)
    record["gstRate"] = gst_rate
    return record


def _serialize(doc, include_image=False):
    d = doc.to_dict()
    files = _attachment_files(d)
    payload = {
        "id": doc.id,
        "phase": d.get("phase", ""),
        "modelId": d.get("modelId", ""),
        "phaseId": d.get("phaseId", ""),
        "po": d.get("po", ""),
        "supplier": d.get("supplier", ""),
        "date": d.get("date", ""),
        "code": d.get("code", ""),
        "make": d.get("make", ""),
        "model": d.get("model", ""),
        "desc": d.get("desc", ""),
        "qty": d.get("qty", 0),
        "rate": d.get("rate", 0),
        "gst": d.get("gst", 0),
        "gstRate": d.get("gstRate", 0),
        "basicPrice": d.get("basicPrice", 0),
        "value": d.get("value", 0),
        "expectedDeliveryDate": d.get("expectedDeliveryDate", ""),
        "status": d.get("status", ""),
        "hasImage": bool(files),
        "attachmentCount": len(files),
        "imageName": files[0]["name"] if files else "",
        "attachments": [{k: v for k, v in e.items() if k != "data"} for e in files],
        "createdAt": d.get("createdAt").isoformat() if d.get("createdAt") else None,
        "updatedAt": d.get("updatedAt").isoformat() if d.get("updatedAt") else None,
    }
    if include_image:
        payload["attachments"] = files
    return payload


def _attachment_files(data):
    return entries_of(data)


def _attachments_payload(value, strict=False):
    return normalise_entries(value, strict=strict)


def _parse_pagination_params(args):
    try:
        page = int(args.get("page", 1))
    except (TypeError, ValueError):
        page = 1
    try:
        limit = int(args.get("limit", 10))
    except (TypeError, ValueError):
        limit = 10
    return max(1, page), min(100, max(1, limit))


def _header_files_map():
    files = {}
    try:
        for doc in db.collection("po_headers").stream():
            entries = _attachment_files(doc.to_dict() or {})
            if entries:
                files[doc.id] = entries
    except Exception:
        return files
    return files


def _row_matches_filters(row, search, filters):
    """True when a serialized row passes the active search + field filters.

    Field values compare case-insensitively so `pending` / `Pending` / `PENDING`
    all match — users type PO numbers and statuses in either case.
    """
    if search and not any(search in _text(row.get(key)).lower() for key in _SEARCH_KEYS):
        return False
    for field, value in filters:
        # Present filters always compare, even against an empty value: the
        # caller only sends a field when it actually wants to scope the rows.
        if _text(row.get(field)).lower() != value.lower():
            return False
    return True


# Columns scanned by the UI's free-text search box (mirrors `columns` in PODetails.jsx).
_SEARCH_KEYS = ("phase", "po", "supplier", "date", "code", "desc", "qty", "rate", "gstRate", "gst", "value", "status")

# Fields the PageFilter dropdown offers (mirrors PO_FILTER_FIELDS).
_FILTER_FIELDS = frozenset({"phase", "po", "supplier", "code", "status"})

# Date columns the toolbar range may target. Keeps a hand-written `dateField`
# from probing fields the endpoint does not expose.
_DATE_COLUMNS = frozenset({"date", "expectedDeliveryDate"})


@podetails_bp.route("/po-details", methods=["GET"])
@cached_read("po-details", ttl_seconds=120)
def list_po_details():
    """
    Supports pagination via `?page=<n>&limit=<n>` query params (defaults: page=1, limit=10)
    plus optional server-side filters `?q=<text>&filterField=<key>&filterValue=<value>`.
    `totals.poValue`, `totals.poValueExclGst`, `totals.poGst` and
    `pagination.totalCount` always cover every row that matches the active
    filters, not just the requested page.

    Response shape:

    {

        "success": true,

        "poDetails": [...10 rows...],

        "pagination": {

            "page": 1,

            "limit": 10,

            "totalCount": 97,

            "totalPages": 10,

            "hasNextPage": true,

            "hasPrevPage": false

        },

        "totals": { "poValue": 1234567.89, "poValueExclGst": 1046074.49, "poGst": 188493.4 }

    }

    """
    try:
        page, limit = _parse_pagination_params(request.args)

        base_query = po_details_collection.order_by("createdAt", direction="DESCENDING")

        # Optional server-side filters (?q=...&filterField=...&filterValue=...)
        # mirroring the UI's search box and PageFilter dropdown, so the row
        # count and `totals.poValue` always describe the filtered set.
        # The params may repeat (the card drill-down sends a PO + phase pair).
        search = (request.args.get("q") or "").strip().lower()
        raw_fields = request.args.getlist("filterField")
        raw_values = request.args.getlist("filterValue")
        filters = []
        for raw_field, raw_value in zip(raw_fields, raw_values):
            field = (raw_field or "").strip()
            if field in _FILTER_FIELDS:
                filters.append((field, str(raw_value or "")))

        # Inclusive range on the PO date, shared with the other list pages.
        date_field, date_from, date_to = read_date_range(request.args, default_field="date")
        if date_field not in _DATE_COLUMNS:
            date_field = "date"

        # One pass over every PO row: apply the filters, collect the matching
        # rows and accumulate the grand total.  Firestore cannot filter by
        # substring, so that happens here; `cached_read` keeps repeat views cheap.
        # A PO's files live on its header document, so every line of that PO
        # reports the same single set.
        header_files = _header_files_map()
        filtered_rows = []
        all_rows = []
        total_value = 0
        total_value_excl_gst = 0
        total_gst = 0
        for doc in base_query.stream():
            row = _serialize(doc)
            po_files = header_files.get(_header_doc_id(
                row.get("modelId", ""), row.get("phaseId", ""), row.get("phase", ""), row.get("po", "")
            ))
            if po_files is not None:
                row["attachments"] = [{k: v for k, v in e.items() if k != "data"} for e in po_files]
                row["attachmentCount"] = len(po_files)
                row["hasImage"] = bool(po_files)
                row["imageName"] = po_files[0]["name"] if po_files else ""
            all_rows.append(row)
            # The date range narrows the set before the totals accumulate, so
            # the badge always describes what the table is showing.
            if not in_date_range(row.get(date_field), date_from, date_to):
                continue
            if not _row_matches_filters(row, search, filters):
                continue
            filtered_rows.append(row)
            try:
                row_value = float(row.get("value") or 0)
                row_gst = float(row.get("gst") or 0)
            except (TypeError, ValueError):
                continue
            total_value += row_value
            total_gst += row_gst
            # value = base (qty x rate) + gst, so the pre-GST figure is the
            # same total minus the GST portion of every line.
            total_value_excl_gst += row_value - row_gst
        total_value = round(total_value, 2)
        total_value_excl_gst = round(total_value_excl_gst, 2)
        total_gst = round(total_gst, 2)

        # The page reads "phase first, then PO number", so the paged rows are
        # ordered the same way instead of purely by newest-created.
        filtered_rows.sort(
            key=lambda row: (
                _text(row.get("phase")).lower(),
                _text(row.get("po")).lower(),
                _text(row.get("date")),
                _text(row.get("code")).lower(),
            )
        )

        # Distinct values per filterable field over the whole collection, so
        # the PageFilter dropdown never loses options while a filter is active.
        filter_options = {
            key: sorted({_text(row.get(key)) for row in all_rows if _text(row.get(key))},
                        key=lambda value: value.lower())
            for key in sorted(_FILTER_FIELDS)
        }

        total_count = len(filtered_rows)

        total_pages = max(1, math.ceil(total_count / limit))

        # Clamp page to the last valid page if the caller asks for something
        # beyond the end of the data (e.g. after rows were deleted).
        if page > total_pages:
            page = total_pages

        offset = (page - 1) * limit
        page_rows = filtered_rows[offset:offset + limit]

        return jsonify({
            "success": True,
            "poDetails": page_rows,
            # Every row the active search/filters/date range matched, so the
            # table's export covers the whole result set and not just the page.
            "allRows": filtered_rows,
            "totals": {"poValue": total_value, "poValueExclGst": total_value_excl_gst, "poGst": total_gst},
            "filterOptions": filter_options,
            "pagination": {
                "page": page,
                "limit": limit,
                "totalCount": total_count,
                "totalPages": total_pages,
                "hasNextPage": page < total_pages,
                "hasPrevPage": page > 1,
            },
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch PO Details: {exc}"}), 500


@podetails_bp.route("/po-details/groups", methods=["GET"])
@cached_read("po-details-groups", ttl_seconds=120)
def list_po_groups():
    """Card view for the PO Details page.

    Mirrors the Models grid but with this project's own order: one card per
    phase, with that phase's PO numbers as a second-level card grid
    (Phases -> POs -> line items).  Grouping keys are lower-cased so `po-12`
    and `PO-12` land on the same card, and both levels read A-Z.
    """
    try:
        groups = {}
        for doc in po_details_collection.order_by("createdAt", direction="DESCENDING").stream():
            row = _serialize(doc)
            po_name = _text(row.get("po")) or "Untitled PO"
            phase_name = _text(row.get("phase")) or "Unassigned"
            date = _text(row.get("date"))
            try:
                value = float(row.get("value") or 0)
            except (TypeError, ValueError):
                value = 0.0
            try:
                gst = float(row.get("gst") or 0)
            except (TypeError, ValueError):
                gst = 0.0
            # value = base (qty x rate) + gst, so the pre-GST figure is the
            # same line minus its GST portion.
            base = value - gst

            group = groups.setdefault(phase_name.lower(), {
                "phase": phase_name,
                "date": date,
                "rowCount": 0,
                "totalValue": 0.0,
                "totalGst": 0.0,
                "totalValueExclGst": 0.0,
                "pos": {},
            })
            group["rowCount"] += 1
            group["totalValue"] += value
            group["totalGst"] += gst
            group["totalValueExclGst"] += base

            po = group["pos"].setdefault(po_name.lower(), {
                "po": po_name,
                "date": date,
                "supplier": _text(row.get("supplier")),
                "rowCount": 0,
                "totalValue": 0.0,
                "totalGst": 0.0,
                "totalValueExclGst": 0.0,
            })
            # The lines of one PO can disagree about the supplier, so keep the
            # first line that actually names one rather than freezing on the
            # first line seen.  Rows stream createdAt DESC, so this ends up as
            # the newest supplier recorded for the PO.
            if not po["supplier"]:
                po["supplier"] = _text(row.get("supplier"))
            po["rowCount"] += 1
            po["totalValue"] += value
            po["totalGst"] += gst
            po["totalValueExclGst"] += base

        payload = []
        for group in groups.values():
            group["totalValue"] = round(group["totalValue"], 2)
            group["totalGst"] = round(group["totalGst"], 2)
            group["totalValueExclGst"] = round(group["totalValueExclGst"], 2)
            group["pos"] = sorted(
                (
                    {
                        **po,
                        "totalValue": round(po["totalValue"], 2),
                        "totalGst": round(po["totalGst"], 2),
                        "totalValueExclGst": round(po["totalValueExclGst"], 2),
                    }
                    for po in group["pos"].values()
                ),
                key=lambda item: item["po"].lower(),
            )
            payload.append(group)

        # Phase first, then PO number - both alphabetically.
        payload.sort(key=lambda item: item["phase"].lower())

        return jsonify({"success": True, "phases": payload}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch PO groups: {exc}"}), 500


# ----------------------------------------------------------------------
# CREATE PO Detail
# ----------------------------------------------------------------------
@podetails_bp.route("/po-details", methods=["POST"])
@roles_required("admin", "coadmin", "production_incharge")
def create_po_detail():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    missing = [f for f in REQUIRED_FIELDS if not _text(data.get(f))]
    if missing:
        return jsonify({"success": False, "message": f"Missing required fields: {', '.join(missing)}"}), 400

    try:
        record = _validated_record(data)
    except ValueError as exc:
        return jsonify({"success": False, "message": str(exc)}), 400

    try:
        doc_ref = po_details_collection.document()
        created_at = datetime.now(timezone.utc)
        record["createdAt"] = created_at
        record["updatedAt"] = created_at
        doc_ref.set(record)
        invalidate_read_cache()
        return jsonify({
            "success": True,
            "message": "PO Detail created successfully",
            "id": doc_ref.id,
            **{k: v for k, v in record.items() if k not in ("createdAt", "updatedAt")},
            "createdAt": created_at.isoformat(),
            "updatedAt": created_at.isoformat(),
        }), 201
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to create PO Detail: {exc}"}), 500


# ----------------------------------------------------------------------
# Attachment lookup for the PO table's file strip
# ----------------------------------------------------------------------
@podetails_bp.route("/po-details/images", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge", "user")
def list_po_detail_images():
    """Full files (inline bytes included) for a set of line ids.

    The list endpoint strips inline bytes to stay small, so the strip asks for
    them here. This route was missing: the request fell through to
    `/po-details/<detail_id>` with the id "images" and came back 404 whenever a
    line held an inline file (e.g. one saved while Storage was unavailable).
    Mirrors `/invoices/images`.
    """
    ids = [value.strip() for value in (request.args.get("ids") or "").split(",") if value.strip()]
    ids = ids[:MAX_IMAGE_IDS]
    if not ids:
        return jsonify({"success": True, "attachments": {}}), 200

    try:
        # Same precedence as the list endpoint: a PO's header files, when it
        # has any, stand for every line; otherwise the line's own files.
        header_files = _header_files_map()
        files = {}
        for detail_id in ids:
            doc = po_details_collection.document(detail_id).get()
            if not doc.exists:
                continue
            data = doc.to_dict() or {}
            attachments = header_files.get(_header_doc_id(
                data.get("modelId", ""), data.get("phaseId", ""), data.get("phase", ""), data.get("po", "")
            ))
            if attachments is None:
                attachments = _attachment_files(data)
            if attachments:
                files[detail_id] = attachments
        return jsonify({"success": True, "attachments": files}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch PO attachments: {exc}"}), 500


# ----------------------------------------------------------------------
# GET SINGLE PO Detail
# ----------------------------------------------------------------------
@podetails_bp.route("/po-details/<detail_id>", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge", "user")
def get_po_detail(detail_id):
    try:
        doc = po_details_collection.document(detail_id).get()
        if not doc.exists:
            return jsonify({"success": False, "message": "PO Detail not found"}), 404
        return jsonify({"success": True, "poDetail": _serialize(doc, include_image=True)}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch PO Detail: {exc}"}), 500


# ----------------------------------------------------------------------
# UPDATE PO Detail
# ----------------------------------------------------------------------
@podetails_bp.route("/po-details/<detail_id>", methods=["PUT"])
@roles_required("admin", "coadmin", "production_incharge")
def update_po_detail(detail_id):
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    update_fields = {k: v for k, v in data.items() if k in ALLOWED_FIELDS}
    if not update_fields:
        return jsonify({"success": False, "message": "Nothing to update"}), 400

    doc_ref = po_details_collection.document(detail_id)
    existing_doc = doc_ref.get()
    if not existing_doc.exists:
        return jsonify({"success": False, "message": "PO Detail not found"}), 404

    existing_data = existing_doc.to_dict() or {}

    # Recalculate totals if qty, rate, or gstRate changed
    if {"qty", "rate", "gstRate"}.intersection(update_fields):
        merged = {**existing_data, **update_fields}
        gst_rate = _gst_rate(merged, strict=True)
        base, gst, total = _calc_totals(merged.get("rate"), merged.get("qty"), gst_rate)
        update_fields["basicPrice"] = base
        update_fields["gst"] = gst
        update_fields["value"] = total
        update_fields["gstRate"] = gst_rate

    try:
        update_fields["updatedAt"] = datetime.now(timezone.utc)
        doc_ref.update(update_fields)
        updated_doc = doc_ref.get()
        return jsonify({"success": True, "message": "PO Detail updated", "poDetail": _serialize(updated_doc)}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to update PO Detail: {exc}"}), 500


# ----------------------------------------------------------------------
# DELETE PO Detail
# ----------------------------------------------------------------------
@podetails_bp.route("/po-details/<detail_id>", methods=["DELETE"])
@roles_required("admin", "coadmin", "production_incharge")
def delete_po_detail(detail_id):
    try:
        doc_ref = po_details_collection.document(detail_id)
        if not doc_ref.get().exists:
            return jsonify({"success": False, "message": "PO Detail not found"}), 404
        doc_ref.delete()
        invalidate_read_cache()
        return jsonify({"success": True, "message": "PO Detail deleted"}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to delete PO Detail: {exc}"}), 500


# ----------------------------------------------------------------------
# BULK DELETE PO Details
# ----------------------------------------------------------------------
@podetails_bp.route("/po-details/bulk-delete", methods=["POST"])
@roles_required("admin", "coadmin", "production_incharge")
def bulk_delete_po_details():
    data = request.get_json(silent=True) or {}
    ids = data.get("ids", [])
    if not isinstance(ids, list) or not ids:
        return jsonify({"success": False, "message": "No PO Detail ids provided"}), 400

    deleted = 0
    missing = []
    try:
        batch = db.batch()
        for detail_id in ids:
            doc_ref = po_details_collection.document(detail_id)
            if not doc_ref.get().exists:
                missing.append(detail_id)
                continue
            batch.delete(doc_ref)
            deleted += 1
        if deleted:
            batch.commit()
            invalidate_read_cache()
        if deleted == 0:
            return jsonify({"success": False, "message": "No PO Details were deleted"}), 404
        return jsonify({
            "success": True,
            "message": f"{deleted} PO Detail(s) deleted",
            "deleted": deleted,
            "missing": missing,
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to bulk delete: {exc}"}), 500


# ----------------------------------------------------------------------
# ATTACHMENT UPLOAD / DELETE
# ----------------------------------------------------------------------
@podetails_bp.route("/po-details/attachments/upload", methods=["POST"])
@roles_required("admin", "coadmin", "production_incharge")
def upload_po_attachments():
    """Store files in Firebase Storage and return their metadata.

    The record only keeps that metadata, so a PO can hold as many (and as
    large) files as the user likes - Firestore's 1 MiB limit does not apply.
    """
    data = request.get_json(silent=True) or {}
    files = data.get("files") or []
    if not isinstance(files, list) or not files:
        return jsonify({"success": False, "message": "No files to upload"}), 400

    try:
        entries, used_storage = upload_files(ATTACHMENT_PREFIX, files)
    except ValueError as exc:
        return jsonify({"success": False, "message": str(exc)}), 400
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to upload attachments: {exc}"}), 500

    if not entries:
        return jsonify({"success": False, "message": "None of the files could be stored"}), 400

    return jsonify({"success": True, "attachments": entries, "storage": used_storage}), 200


@podetails_bp.route("/po-details/attachments", methods=["DELETE"])
@roles_required("admin", "coadmin", "production_incharge")
def delete_po_attachments():
    """Remove the stored files behind the given attachment metadata."""
    data = request.get_json(silent=True) or {}
    entries = data.get("attachments") or []
    if not isinstance(entries, list) or not entries:
        return jsonify({"success": True, "message": "Nothing to delete"}), 200

    try:
        removed = delete_files(entries)
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to delete attachments: {exc}"}), 500

    return jsonify({"success": True, "message": f"{removed} file(s) removed", "removed": removed}), 200
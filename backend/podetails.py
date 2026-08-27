import math

from datetime import datetime, timezone
 
from flask import Blueprint, request, jsonify

from firebase_config import db
from read_cache import cached_read
from auth_utils import roles_required
 
podetails_bp = Blueprint("podetails", __name__)

po_details_collection = db.collection("po_details")
 
REQUIRED_FIELDS = ["phase", "po", "date", "code", "desc", "qty", "rate", "expectedDeliveryDate", "status"]
 
# Everything the frontend PO Details form submits.

ALLOWED_FIELDS = [

    "phase", "modelId", "phaseId", "po", "date", "code", "make", "model",

    "desc", "qty", "rate", "expectedDeliveryDate", "status",

]
 
DEFAULT_PAGE_SIZE = 10

MAX_PAGE_SIZE = 100
 
 
def _serialize(doc):

    d = doc.to_dict()

    return {

        "id": doc.id,

        "phase": d.get("phase", ""),

        "modelId": d.get("modelId", ""),

        "phaseId": d.get("phaseId", ""),

        "po": d.get("po", ""),

        "date": d.get("date", ""),

        "code": d.get("code", ""),

        "make": d.get("make", ""),

        "model": d.get("model", ""),

        "desc": d.get("desc", ""),

        "qty": d.get("qty", 0),

        "rate": d.get("rate", 0),

        "gst": d.get("gst", 0),

        "value": d.get("value", 0),

        "expectedDeliveryDate": d.get("expectedDeliveryDate", ""),

        "status": d.get("status", ""),

        "createdAt": d.get("createdAt").isoformat() if d.get("createdAt") else None,

        "updatedAt": d.get("updatedAt").isoformat() if d.get("updatedAt") else None,

    }
 
 
def _coerce_numeric(data):

    """Best-effort conversion of qty/rate to numbers; raises ValueError on bad input."""

    qty = data.get("qty", 0)

    rate = data.get("rate", 0)
 
    qty = float(qty) if str(qty).strip() != "" else 0

    rate = float(rate) if str(rate).strip() != "" else 0
 
    return qty, rate
 
 
def _parse_pagination_params(args):

    """

    Parses & sanitizes `page` / `limit` query params.

    Falls back to sane defaults on missing/invalid input instead of erroring out,

    since pagination params are optional (GET /po-details still works with none).

    """

    try:

        page = int(args.get("page", 1))

    except (TypeError, ValueError):

        page = 1
 
    try:

        limit = int(args.get("limit", DEFAULT_PAGE_SIZE))

    except (TypeError, ValueError):

        limit = DEFAULT_PAGE_SIZE
 
    if page < 1:

        page = 1

    if limit < 1:

        limit = DEFAULT_PAGE_SIZE

    if limit > MAX_PAGE_SIZE:

        limit = MAX_PAGE_SIZE
 
    return page, limit
 
 
@podetails_bp.route("/po-details", methods=["POST"])

def create_po_detail():

    data = request.get_json(silent=True)

    if not data:

        return jsonify({"success": False, "message": "Request body must be JSON"}), 400
 
    missing = [f for f in REQUIRED_FIELDS if not str(data.get(f, "")).strip()]

    if missing:

        return jsonify({"success": False, "message": f"Missing required fields: {', '.join(missing)}"}), 400
 
    try:

        qty, rate = _coerce_numeric(data)

    except (ValueError, TypeError):

        return jsonify({"success": False, "message": "Qty Ordered and Unit Rate must be valid numbers"}), 400
 
    try:

        # Data integrity: recompute GST/value server-side rather than trusting the client.

        base_value = qty * rate

        gst = round(base_value * 0.18, 2)

        value = round(base_value + gst, 2)
 
        doc_ref = po_details_collection.document()

        created_at = datetime.now(timezone.utc)
 
        record = {k: data.get(k, "") for k in ALLOWED_FIELDS}

        record["qty"] = qty

        record["rate"] = rate

        record["gst"] = gst

        record["value"] = value

        record["createdAt"] = created_at

        record["updatedAt"] = created_at
 
        doc_ref.set(record)
 
        return jsonify({

            "success": True,

            "message": "PO Detail created",

            "po": {

                "id": doc_ref.id,

                **{k: record[k] for k in record if k not in ("createdAt", "updatedAt")},

                "createdAt": created_at.isoformat(),

                "updatedAt": created_at.isoformat(),

            },

        }), 201

    except Exception as exc:

        return jsonify({"success": False, "message": f"Failed to create PO Detail: {exc}"}), 500
 
 
@podetails_bp.route("/po-details", methods=["GET"])
@cached_read("po-details", ttl_seconds=120)

def list_po_details():

    """

    Supports pagination via `?page=<n>&limit=<n>` query params (defaults: page=1, limit=10).

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

        }

    }

    """

    try:

        page, limit = _parse_pagination_params(request.args)

        base_query = po_details_collection.order_by("createdAt", direction="DESCENDING")
 
        # Firestore aggregation query for total count — avoids pulling every

        # document into memory just to know how many pages exist.

        try:

            count_result = base_query.count(alias="total").get()

            total_count = count_result[0][0].value

        except Exception:

            # Fallback for older google-cloud-firestore versions without

            # aggregation query support.

            total_count = len(list(base_query.stream()))
 
        total_pages = max(1, math.ceil(total_count / limit))

        # Clamp page to the last valid page if the caller asks for something

        # beyond the end of the data (e.g. after rows were deleted).

        if page > total_pages:

            page = total_pages
 
        offset = (page - 1) * limit

        docs = base_query.offset(offset).limit(limit).stream()
 
        return jsonify({

            "success": True,

            "poDetails": [_serialize(doc) for doc in docs],

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
 
 
@podetails_bp.route("/po-details/invoice-options", methods=["GET"])
@cached_read("invoice-options", ttl_seconds=120)
def invoice_options():
    """Return PO lines for one BOQ phase for the Invoice form."""
    model_id = request.args.get("modelId", "").strip()
    phase_id = request.args.get("phaseId", "").strip()
    if not model_id or not phase_id:
        return jsonify({"success": False, "message": "modelId and phaseId are required"}), 400
    try:
        # Avoids adding a composite Firestore index to the existing collection.
        lines = []
        for doc in po_details_collection.order_by("createdAt", direction="DESCENDING").stream():
            data = doc.to_dict()
            if data.get("modelId") == model_id and data.get("phaseId") == phase_id:
                lines.append(_serialize(doc))
        return jsonify({"success": True, "poDetails": lines}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch invoice PO options: {exc}"}), 500


@podetails_bp.route("/po-details/<po_id>", methods=["GET"])

def get_po_detail(po_id):

    try:

        doc = po_details_collection.document(po_id).get()

        if not doc.exists:

            return jsonify({"success": False, "message": "PO Detail not found"}), 404

        return jsonify({"success": True, "po": _serialize(doc)}), 200

    except Exception as exc:

        return jsonify({"success": False, "message": f"Failed to fetch PO Detail: {exc}"}), 500
 
 
@podetails_bp.route("/po-details/<po_id>", methods=["PUT"])

def update_po_detail(po_id):

    data = request.get_json(silent=True)

    if not data:

        return jsonify({"success": False, "message": "Request body must be JSON"}), 400
 
    update_fields = {k: v for k, v in data.items() if k in ALLOWED_FIELDS}

    if not update_fields:

        return jsonify({"success": False, "message": "Nothing to update"}), 400
 
    if "qty" in update_fields or "rate" in update_fields:

        try:

            doc_ref = po_details_collection.document(po_id)

            existing_doc = doc_ref.get()

            if not existing_doc.exists:

                return jsonify({"success": False, "message": "PO Detail not found"}), 404
 
            existing = existing_doc.to_dict()

            qty = float(update_fields.get("qty", existing.get("qty", 0)))

            rate = float(update_fields.get("rate", existing.get("rate", 0)))

            update_fields["qty"] = qty

            update_fields["rate"] = rate

            base_value = qty * rate

            update_fields["gst"] = round(base_value * 0.18, 2)

            update_fields["value"] = round(base_value + update_fields["gst"], 2)

        except (ValueError, TypeError):

            return jsonify({"success": False, "message": "Qty Ordered and Unit Rate must be valid numbers"}), 400
 
    try:

        doc_ref = po_details_collection.document(po_id)

        if not doc_ref.get().exists:

            return jsonify({"success": False, "message": "PO Detail not found"}), 404
 
        update_fields["updatedAt"] = datetime.now(timezone.utc)

        doc_ref.update(update_fields)

        return jsonify({"success": True, "message": "PO Detail updated"}), 200

    except Exception as exc:

        return jsonify({"success": False, "message": f"Failed to update PO Detail: {exc}"}), 500
 
 
@podetails_bp.route("/po-details/bulk-delete", methods=["POST"])
@roles_required("admin", "coadmin")
def bulk_delete_po_details():
    data = request.get_json(silent=True) or {}
    ids = data.get("ids", [])

    if not isinstance(ids, list) or not ids:
        return jsonify({"success": False, "message": "No PO detail IDs provided"}), 400

    deleted = []
    failed = []

    for po_id in ids:
        try:
            doc_ref = po_details_collection.document(str(po_id))
            if doc_ref.get().exists:
                doc_ref.delete()
                deleted.append(str(po_id))
            else:
                failed.append(str(po_id))
        except Exception:
            failed.append(str(po_id))

    return jsonify({
        "success": True,
        "message": f"Deleted {len(deleted)} PO detail(s)",
        "deleted": deleted,
        "failed": failed,
    }), 200


@podetails_bp.route("/po-details/<po_id>", methods=["DELETE"])
@roles_required("admin", "coadmin")
def delete_po_detail(po_id):

    try:

        doc_ref = po_details_collection.document(po_id)

        if not doc_ref.get().exists:

            return jsonify({"success": False, "message": "PO Detail not found"}), 404
 
        doc_ref.delete()

        return jsonify({"success": True, "message": "PO Detail deleted"}), 200

    except Exception as exc:

        return jsonify({"success": False, "message": f"Failed to delete PO Detail: {exc}"}), 500
 

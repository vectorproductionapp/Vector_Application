from datetime import datetime, timezone
import math
 
from flask import Blueprint, request, jsonify
from firebase_config import db
from read_cache import cached_read
 
invoice_bp = Blueprint("invoices", __name__)
invoices_collection = db.collection("invoices")
 
REQUIRED_FIELDS = ["invoice", "date", "phase", "po", "code", "desc", "qtyInv", "qtyRecv", "verifiedBy"]
DEFAULT_PAGE_SIZE = 10
MAX_PAGE_SIZE = 100
 
# Everything the Invoices form submits.
ALLOWED_FIELDS = [
    "invoice", "date", "modelId", "phaseId", "phase", "po", "code", "desc", "qtyInv", "qtyRecv", "verifiedBy",
]
 
 
def _serialize(doc):
    d = doc.to_dict()
    return {
        "id": doc.id,
        "invoice": d.get("invoice", ""),
        "date": d.get("date", ""),
        "modelId": d.get("modelId", ""),
        "phaseId": d.get("phaseId", ""),
        "phase": d.get("phase", ""),
        "po": d.get("po", ""),
        "code": d.get("code", ""),
        "desc": d.get("desc", ""),
        "qtyInv": d.get("qtyInv", 0),
        "qtyRecv": d.get("qtyRecv", 0),
        "verifiedBy": d.get("verifiedBy", ""),
        "createdAt": d.get("createdAt").isoformat() if d.get("createdAt") else None,
        "updatedAt": d.get("updatedAt").isoformat() if d.get("updatedAt") else None,
    }
 
 
def _coerce_qty(value, fallback=0):
    """Best-effort conversion of a qty field to a number; raises ValueError on bad input."""
    return float(value) if str(value).strip() != "" else fallback


def _parse_pagination_params(args):
    try:
        page = int(args.get("page", 1))
    except (TypeError, ValueError):
        page = 1
    try:
        limit = int(args.get("limit", DEFAULT_PAGE_SIZE))
    except (TypeError, ValueError):
        limit = DEFAULT_PAGE_SIZE
    return max(1, page), min(MAX_PAGE_SIZE, max(1, limit))
 
 
@invoice_bp.route("/invoices", methods=["POST"])
def create_invoice():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400
 
    missing = [f for f in REQUIRED_FIELDS if not str(data.get(f, "")).strip()]
    if missing:
        return jsonify({"success": False, "message": f"Missing required fields: {', '.join(missing)}"}), 400
 
    try:
        qty_inv = _coerce_qty(data.get("qtyInv", 0))
        qty_recv = _coerce_qty(data.get("qtyRecv", 0))
    except (ValueError, TypeError):
        return jsonify({"success": False, "message": "Qty Invoiced and Qty Received must be valid numbers"}), 400
 
    try:
        doc_ref = invoices_collection.document()
        created_at = datetime.now(timezone.utc)
 
        record = {k: data.get(k, "") for k in ALLOWED_FIELDS}
        record["qtyInv"] = qty_inv
        record["qtyRecv"] = qty_recv
        record["createdAt"] = created_at
        record["updatedAt"] = created_at
 
        doc_ref.set(record)
 
        return jsonify({
            "success": True,
            "message": "Invoice saved successfully",
            "invoice": {
                "id": doc_ref.id,
                **{k: record[k] for k in record if k not in ("createdAt", "updatedAt")},
                "createdAt": created_at.isoformat(),
                "updatedAt": created_at.isoformat(),
            },
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to create Invoice: {exc}"}), 500
 
 
@invoice_bp.route("/invoices", methods=["GET"])
@cached_read("invoices", ttl_seconds=120)
def list_invoices():
    try:
        page, limit = _parse_pagination_params(request.args)
        base_query = invoices_collection.order_by("createdAt", direction="DESCENDING")
        try:
            total_count = base_query.count(alias="total").get()[0][0].value
        except Exception:
            total_count = len(list(base_query.stream()))
        total_pages = max(1, math.ceil(total_count / limit))
        page = min(page, total_pages)
        docs = base_query.offset((page - 1) * limit).limit(limit).stream()
        return jsonify({
            "success": True,
            "invoices": [_serialize(doc) for doc in docs],
            "pagination": {"page": page, "limit": limit, "totalCount": total_count,
                           "totalPages": total_pages, "hasNextPage": page < total_pages,
                           "hasPrevPage": page > 1},
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch Invoices: {exc}"}), 500
 
 
@invoice_bp.route("/invoices/<invoice_id>", methods=["GET"])
def get_invoice(invoice_id):
    try:
        doc = invoices_collection.document(invoice_id).get()
        if not doc.exists:
            return jsonify({"success": False, "message": "Invoice not found"}), 404
        return jsonify({"success": True, "invoice": _serialize(doc)}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch Invoice: {exc}"}), 500
 
 
@invoice_bp.route("/invoices/<invoice_id>", methods=["PUT"])
def update_invoice(invoice_id):
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400
 
    update_fields = {k: v for k, v in data.items() if k in ALLOWED_FIELDS}
    if not update_fields:
        return jsonify({"success": False, "message": "Nothing to update"}), 400
 
    doc_ref = invoices_collection.document(invoice_id)
    existing_doc = doc_ref.get()
    if not existing_doc.exists:
        return jsonify({"success": False, "message": "Invoice not found"}), 404
 
    existing = existing_doc.to_dict()
 
    if "qtyInv" in update_fields:
        try:
            update_fields["qtyInv"] = _coerce_qty(update_fields["qtyInv"], existing.get("qtyInv", 0))
        except (ValueError, TypeError):
            return jsonify({"success": False, "message": "Qty Invoiced must be a valid number"}), 400
 
    if "qtyRecv" in update_fields:
        try:
            update_fields["qtyRecv"] = _coerce_qty(update_fields["qtyRecv"], existing.get("qtyRecv", 0))
        except (ValueError, TypeError):
            return jsonify({"success": False, "message": "Qty Received must be a valid number"}), 400
 
    try:
        update_fields["updatedAt"] = datetime.now(timezone.utc)
        doc_ref.update(update_fields)
        updated_doc = doc_ref.get()
        return jsonify({
            "success": True,
            "message": "Invoice updated",
            "invoice": _serialize(updated_doc),
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to update Invoice: {exc}"}), 500
 
 
@invoice_bp.route("/invoices/<invoice_id>", methods=["DELETE"])
def delete_invoice(invoice_id):
    try:
        doc_ref = invoices_collection.document(invoice_id)
        if not doc_ref.get().exists:
            return jsonify({"success": False, "message": "Invoice not found"}), 404
 
        doc_ref.delete()
        return jsonify({"success": True, "message": "Invoice deleted"}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to delete Invoice: {exc}"}), 500
 
 
# ----------------------------------------------------------------------
# Bulk delete, mirroring the Daily Production / Assembly bulk-delete
# endpoint: accepts a list of ids, deletes each in a batch, and reports
# how many were removed. Matches what the Invoices frontend calls at
# POST /invoices/bulk-delete from the toolbar's select-mode multi-delete
# flow.
# ----------------------------------------------------------------------
@invoice_bp.route("/invoices/bulk-delete", methods=["POST"])
def bulk_delete_invoices():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400
 
    ids = data.get("ids")
    if not isinstance(ids, list) or not ids:
        return jsonify({"success": False, "message": "No Invoice ids provided"}), 400
 
    try:
        batch = db.batch()
        deleted_count = 0
        missing_ids = []
 
        for invoice_id in ids:
            doc_ref = invoices_collection.document(invoice_id)
            if not doc_ref.get().exists:
                missing_ids.append(invoice_id)
                continue
            batch.delete(doc_ref)
            deleted_count += 1
 
        if deleted_count:
            batch.commit()
 
        if deleted_count == 0:
            return jsonify({
                "success": False,
                "message": "None of the selected Invoices could be found",
            }), 404
 
        message = f"{deleted_count} Invoice(s) deleted"
        if missing_ids:
            message += f" ({len(missing_ids)} were already removed)"
 
        return jsonify({
            "success": True,
            "message": message,
            "deletedCount": deleted_count,
            "missingIds": missing_ids,
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to delete Invoices: {exc}"}), 500
 

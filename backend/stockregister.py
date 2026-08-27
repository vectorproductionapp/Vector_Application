import math
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from flask import Blueprint, jsonify, request

from firebase_config import db
from auth_utils import roles_required
from read_cache import cached_read

stockregister_bp = Blueprint("stockregister", __name__)


def _number(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0


def _parse_pagination_params(args):
    try:
        page = int(args.get("page", 1))
    except (TypeError, ValueError):
        page = 1
    try:
        limit = int(args.get("limit", 10))
    except (TypeError, ValueError):
        limit = 10
    return max(1, page), min(10000, max(1, limit))


def _stock_key(data):
    """A phase/item key keeps one stock balance per material and phase."""
    return (
        data.get("modelId", ""),
        data.get("phaseId", "") or data.get("phase", ""),
        data.get("code", ""),
    )


def _production_key(data):
    """The finished model/phase identifies the BOQ that production consumes."""
    return (data.get("modelId", ""), data.get("phaseId", ""))


def _collection_docs(path):
    """Read a collection once and return its documents for stock calculation."""
    return list(db.collection(path).stream())


@stockregister_bp.route("/stock-register", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge")
@cached_read("stock-register", ttl_seconds=120)
def list_stock_register():
    """Read-only material stock derived from PO, invoice and BOQ data."""
    try:
        items = {}
        po_line_keys = {}
        completed_production = {}

        # These are independent Firestore reads. Fetching them sequentially
        # made users wait for the sum of every network round trip before the
        # first table page could be calculated.
        with ThreadPoolExecutor(max_workers=6) as executor:
            model_future = executor.submit(_collection_docs, "models")
            phase_future = executor.submit(lambda: list(db.collection_group("phases").stream()))
            assembly_future = executor.submit(_collection_docs, "assembly_units")
            po_future = executor.submit(_collection_docs, "po_details")
            boq_future = executor.submit(lambda: list(db.collection_group("boqs").stream()))
            invoice_future = executor.submit(_collection_docs, "invoices")

            model_docs = model_future.result()
            phase_docs = phase_future.result()
            assembly_docs = assembly_future.result()
            po_docs = po_future.result()
            boq_docs = boq_future.result()
            invoice_docs = invoice_future.result()

        active_model_ids = {doc.id for doc in model_docs}
        phase_names = {}
        for phase_doc in phase_docs:
            phase_data = phase_doc.to_dict() or {}
            model_ref = phase_doc.reference.parent.parent
            if model_ref:
                phase_names[(model_ref.id, phase_doc.id)] = phase_data.get("name", "")

        # Workbook rule: only a Completed unit that has passed QC consumes
        # material.  Each unit consumes the BOQ quantity-per-unit (reqQty).
        for doc in assembly_docs:
            data = doc.to_dict() or {}
            if data.get("stage") != "Completed" or data.get("qc") != "Passed":
                continue
            key = _production_key(data)
            completed_production[key] = completed_production.get(key, 0) + _number(data.get("qty"))

        # PO lines define the materials being tracked.  No stock documents are
        # created or changed by this endpoint.
        for doc in po_docs:
            data = doc.to_dict() or {}
            code = data.get("code", "")
            if not code:
                continue
            key = _stock_key(data)
            item = items.setdefault(key, {
                "phase": data.get("phase", ""),
                "code": code,
                "desc": data.get("desc", ""),
                "make": data.get("make", ""),
                "model": data.get("model", ""),
                "uom": "",
                "reqQty": 0,
                "opening": 0,
                "purchased": 0,
                "consumed": 0,
                "minLevel": 0,
            })
            if not item["desc"]:
                item["desc"] = data.get("desc", "")
            if not item["make"]:
                item["make"] = data.get("make", "")
            if not item["model"]:
                item["model"] = data.get("model", "")
            po_line_keys[(data.get("po", ""), code)] = key

        # BOQ buffer quantities provide the configured minimum-stock level.
        # Collection-group reads cover every model/phase without writes.
        for boq_doc in boq_docs:
            boq = boq_doc.to_dict() or {}
            phase_ref = boq_doc.reference.parent.parent
            model_ref = phase_ref.parent.parent if phase_ref else None
            phase_id = phase_ref.id if phase_ref else ""
            model_id = model_ref.id if model_ref else ""
            if not model_id or model_id not in active_model_ids:
                continue
            # Read all phase names once above instead of fetching a parent
            # phase document for every BOQ document.
            phase_name = phase_names.get((model_id, phase_id), "")
            for row in boq.get("rows", []) or []:
                code = row.get("code", "")
                if not code:
                    continue
                key = (model_id, phase_id or phase_name, code)
                item = items.get(key)
                if item is None and phase_name:
                    item = items.get((model_id, phase_name, code))
                if item is None:
                    continue
                # BOQ is the authoritative material/BOM definition, matching
                # the workbook's BOQ lookup formulas.
                item["desc"] = row.get("desc", "") or item["desc"]
                item["make"] = row.get("make", "") or item["make"]
                item["model"] = row.get("model", "") or item["model"]
                if not item["uom"]:
                    item["uom"] = row.get("uom", "")
                item["reqQty"] = _number(row.get("reqQty"))
                item["minLevel"] = _number(row.get("minStockQty"))
                item["consumed"] = completed_production.get(
                    (model_id, phase_id), 0
                ) * item["reqQty"]

        # Qty Received on an invoice is the stock received against that PO.
        for doc in invoice_docs:
            data = doc.to_dict() or {}
            code = data.get("code", "")
            if not code:
                continue
            po_number = data.get("po", "")
            po_key = (po_number, code)
            if po_number and po_key not in po_line_keys:
                continue
            key = po_line_keys.get(po_key, _stock_key(data))
            item = items.get(key)
            if item is None:
                continue
            item["purchased"] += _number(data.get("qtyRecv"))
            if not item["desc"]:
                item["desc"] = data.get("desc", "")

        rows = []
        for item in items.values():
            item["closing"] = item["opening"] + item["purchased"] - item["consumed"]
            item["status"] = "REORDER - BELOW MIN" if item["closing"] < item["minLevel"] else "OK"
            item["lastUpdated"] = datetime.now().date().isoformat()
            for field in ("opening", "purchased", "consumed", "closing", "minLevel", "reqQty"):
                value = _number(item[field])
                item[field] = int(value) if value.is_integer() else value
            rows.append(item)

        rows.sort(key=lambda row: (row["phase"].lower(), row["code"].lower()))
        page, limit = _parse_pagination_params(request.args)
        total_count = len(rows)
        total_pages = max(1, math.ceil(total_count / limit))
        page = min(page, total_pages)
        start = (page - 1) * limit
        response = jsonify({
            "success": True,
            "stockRows": rows[start:start + limit],
            "pagination": {"page": page, "limit": limit, "totalCount": total_count,
                           "totalPages": total_pages, "hasNextPage": page < total_pages,
                           "hasPrevPage": page > 1},
        })
        response.headers["Cache-Control"] = "no-store"
        return response, 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch stock register: {exc}"}), 500

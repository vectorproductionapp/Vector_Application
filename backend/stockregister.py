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


def _phase_candidates(model_id, phase_id, phase_name, code):
    """The same stock row can be addressed by phase id (BOQ, production) or by
    phase name (invoices), so both spellings must resolve to one row."""
    candidates = []
    for phase in (phase_id, phase_name):
        if phase:
            candidate = (model_id, phase, code)
            if candidate not in candidates:
                candidates.append(candidate)
    return candidates


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
    """Read-only material stock derived from invoices and the BOQ.

    Only materials that appear on an invoice are listed: the invoice creates
    the row and its Qty Received adds to `purchased`.  The BOQ then enriches
    those rows (description, make, model, UOM, qty per unit, minimum level),
    and completed + QC-passed assembly units drive `consumed`.  PO Details is
    deliberately not a source - an item shows up here only once it is
    available on an invoice.
    """
    try:
        items = {}       # stock key -> row
        aliases = {}     # (modelId, phase id OR phase name, code) -> stock key
        completed_production = {}

        # These are independent Firestore reads. Fetching them sequentially
        # made users wait for the sum of every network round trip before the
        # first table page could be calculated.
        with ThreadPoolExecutor(max_workers=5) as executor:
            model_future = executor.submit(_collection_docs, "models")
            phase_future = executor.submit(lambda: list(db.collection_group("phases").stream()))
            assembly_future = executor.submit(_collection_docs, "assembly_units")
            boq_future = executor.submit(lambda: list(db.collection_group("boqs").stream()))
            invoice_future = executor.submit(_collection_docs, "invoices")

            model_docs = model_future.result()
            phase_docs = phase_future.result()
            assembly_docs = assembly_future.result()
            boq_docs = boq_future.result()
            invoice_docs = invoice_future.result()

        active_model_ids = {doc.id for doc in model_docs}
        model_names = {}
        for doc in model_docs:
            model_names[doc.id] = (doc.to_dict() or {}).get("name", "")
        phase_names = {}
        for phase_doc in phase_docs:
            phase_data = phase_doc.to_dict() or {}
            model_ref = phase_doc.reference.parent.parent
            if model_ref:
                phase_names[(model_ref.id, phase_doc.id)] = phase_data.get("name", "")

        def find_item(model_id, phase_id, phase_name, code):
            for candidate in _phase_candidates(model_id, phase_id, phase_name, code):
                key = aliases.get(candidate)
                if key is not None and key in items:
                    return key
                if candidate in items:
                    return candidate
            return None

        def remember_item(key, model_id, phase_id, phase_name, code):
            for candidate in _phase_candidates(model_id, phase_id, phase_name, code):
                aliases.setdefault(candidate, key)

        # Workbook rule: only a Completed unit that has passed QC consumes
        # material.  Each unit consumes the BOQ quantity-per-unit (reqQty).
        for doc in assembly_docs:
            data = doc.to_dict() or {}
            if data.get("stage") != "Completed" or data.get("qc") != "Passed":
                continue
            key = _production_key(data)
            completed_production[key] = completed_production.get(key, 0) + _number(data.get("qty"))

        # Invoices are the only source of rows: a material enters the register
        # when it appears on an invoice, and Qty Received is the stock in.
        # No stock documents are created or changed by this endpoint.
        for doc in invoice_docs:
            data = doc.to_dict() or {}
            code = data.get("code", "")
            if not code:
                continue
            model_id = data.get("modelId", "")
            phase_id = data.get("phaseId", "")
            phase_name = data.get("phase", "")
            key = find_item(model_id, phase_id, phase_name, code)
            if key is None:
                key = (model_id, phase_id or phase_name, code)
                items[key] = {
                    "phase": phase_name,
                    "code": code,
                    "desc": data.get("desc", ""),
                    "make": "",
                    "model": "",
                    "uom": "",
                    "reqQty": 0,
                    "opening": 0,
                    "purchased": 0,
                    "consumed": 0,
                    "minLevel": 0,
                }
                remember_item(key, model_id, phase_id, phase_name, code)
            item = items[key]
            item["purchased"] += _number(data.get("qtyRecv"))
            if not item["desc"]:
                item["desc"] = data.get("desc", "")

        # The BOQ only enriches rows an invoice created - a material that has
        # never been invoiced stays out of the register.  BOQ is the
        # authoritative BOM definition, matching the workbook's lookup rules.
        for boq_doc in boq_docs:
            boq = boq_doc.to_dict() or {}
            phase_ref = boq_doc.reference.parent.parent
            model_ref = phase_ref.parent.parent if phase_ref else None
            phase_id = phase_ref.id if phase_ref else ""
            model_id = model_ref.id if model_ref else ""
            if not model_id or model_id not in active_model_ids:
                continue
            phase_name = phase_names.get((model_id, phase_id), "")
            for row in boq.get("rows", []) or []:
                code = row.get("code", "")
                if not code:
                    continue
                key = find_item(model_id, phase_id, phase_name, code)
                if key is None:
                    # Not available on any invoice yet: not in the register.
                    continue
                item = items[key]
                item["desc"] = row.get("desc", "") or item["desc"]
                item["make"] = row.get("make", "") or item["make"]
                item["model"] = row.get("model", "") or item["model"] or model_names.get(model_id, "")
                if not item["uom"]:
                    item["uom"] = row.get("uom", "")
                item["reqQty"] = _number(row.get("reqQty"))
                item["minLevel"] = _number(row.get("minStockQty"))
                item["consumed"] = completed_production.get(
                    (model_id, phase_id), 0
                ) * item["reqQty"]
                # Both spellings of this row now resolve to the same item.
                remember_item(key, model_id, phase_id, phase_name, code)

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

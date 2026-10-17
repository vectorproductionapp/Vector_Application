
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


def _sort_timestamp(value):
    """Seconds for an ISO date string, or 0 when absent/unparseable.

    Sorting needs a number. The ISO strings in this collection compare
    correctly as text, but they cannot be negated the way a number can, and
    `updatedAt` is sometimes missing, so a numeric stamp keeps one ordering
    expression for every row.
    """
    text = str(value or "").strip()
    if not text:
        return 0.0
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


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


def _consumed_by_phase(assembly_docs):
    """Total production quantity per (modelId, phaseId).

    Every recorded production unit consumes material the moment it is created -
    regardless of stage, QC or packaging status.  This is the single source of
    truth for that rule; the stock register and the dashboard both call it.

    Accepts either Firestore document snapshots (``.to_dict()``) or plain
    dictionaries, so the dashboard can pass already-serialised docs.
    """
    consumed = {}
    for entry in assembly_docs:
        data = entry.to_dict() if hasattr(entry, "to_dict") else (entry or {})
        qty = _number(data.get("qty"))
        if not qty:
            continue
        key = _production_key(data)
        consumed[key] = consumed.get(key, 0) + qty
    return consumed


def _collection_docs(path):
    """Read a collection once and return its documents for stock calculation."""
    return list(db.collection(path).stream())


# Columns scanned by the UI's free-text search box (mirrors `columns` in
# StockRegister.jsx).  Values are stringified exactly like the client does.
_SEARCH_KEYS = ("phase", "code", "desc", "make", "model", "reqQty", "opening",
                "purchased", "consumed", "closing", "minLevel", "status",
                "lastUpdated")

# Fields the PageFilter dropdown offers (mirrors STOCK_FILTER_FIELDS).
_FILTER_FIELDS = frozenset({"phase", "make", "model", "status"})


def _text(value):
    return "" if value is None else str(value).strip()


def _row_matches_filters(row, search, filters):
    """True when a serialized stock row passes the active search + field filters.

    Values compare case-insensitively so `pending` / `Pending` behave the same
    on both sides of the app.  Firestore cannot filter by substring, so this
    runs in Python - but it runs over the *whole* register, before slicing, so
    paging, the row count and the totals all describe the same rows.
    """
    if search and not any(search in _text(row.get(key)).lower() for key in _SEARCH_KEYS):
        return False
    for field, value in filters:
        if _text(row.get(field)).lower() != value.lower():
            return False
    return True


def _sale_priority(status):
    """Priority order for sale dispatch status (higher = more advanced)."""
    priority = {
        "": 0, "cancelled": 0, "pending": 1, "processing": 2,
        "demo": 3, "dispatched": 4, "delivered": 5
    }
    return priority.get(str(status or "").strip().casefold(), 0)


def _get_delivered_serials():
    """Serials that a delivered sale has taken out of stock.

    Firestore `==` is case-sensitive, and this app stores dispatch as title case
    ("Delivered", legacy "Dispatched"). Querying for the lowercase words matched
    nothing, so every packed unit looked unsold and "Sold Units" always read 0.
    Firestore cannot compare case-insensitively, so the comparison happens here
    instead, and only "Delivered" counts - the same rule the dashboard uses - so
    both pages report one stock figure rather than two.
    """
    delivered_serials = set()
    for doc in db.collection("sale_register").stream():
        data = doc.to_dict() or {}
        dispatch = str(data.get("dispatch") or "").strip().casefold()
        if dispatch != "delivered":
            continue
        numbers = data.get("serialNumbers")
        if isinstance(numbers, list):
            serials = [str(value).strip() for value in numbers if str(value).strip()]
        else:
            # Older records keep one comma-joined `serial`.
            single = str(data.get("serial") or "").strip()
            serials = [part.strip() for part in single.split(",") if part.strip()]
        delivered_serials.update(serial.casefold() for serial in serials)

    return delivered_serials


@stockregister_bp.route("/stock-register", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge")
@cached_read("stock-register", ttl_seconds=120)
def list_stock_register():
    """Read-only material stock derived from invoices and the BOQ.

    Only materials that appear on an invoice are listed: the invoice creates
    the row and its Qty Received adds to `purchased`.  The BOQ then enriches
    those rows (description, make, model, UOM, qty per unit, minimum level),
    and recorded assembly units drive `consumed` - every production unit
    counts the moment it is recorded, whatever its stage or QC status.  PO
    Details is deliberately not a source - an item shows up here only once it
    is available on an invoice.

    Supports `?page=&limit=` plus `?q=<text>&filterField=<key>&filterValue=<value>`
    (the filter params may repeat).  Filters are applied to the whole register
    before slicing, so `pagination.totalCount` always covers every matching
    row, not just the requested page.
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

        # Every production unit consumes material the moment it is recorded -
        # regardless of stage, QC or packaging.  Each unit consumes the BOQ
        # quantity-per-unit (reqQty).
        completed_production = _consumed_by_phase(assembly_docs)

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
                # Invoices are the only source of rows. A row the BOQ never
                # matches means the material was invoiced but its BOM line is
                # gone, which is why such rows show blank make/model/BOM values.
                item["inBoq"] = False
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
                # The BOM still defines this material, so the row is not orphaned.
                item["inBoq"] = True
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

        # Toolbar filters run here rather than in the browser: the client used
        # to slice to one page first and then filter those few rows, so a
        # search or PageFilter silently matched only the visible page.
        search = (request.args.get("q") or "").strip().lower()
        raw_fields = request.args.getlist("filterField")
        raw_values = request.args.getlist("filterValue")
        filters = []
        for raw_field, raw_value in zip(raw_fields, raw_values):
            field = (raw_field or "").strip()
            if field in _FILTER_FIELDS:
                filters.append((field, str(raw_value or "")))

        filtered_rows = [row for row in rows if _row_matches_filters(row, search, filters)]

        # Distinct values per filterable field over the whole register so the
        # PageFilter dropdown never loses options while a filter is active.
        filter_options = {
            key: sorted({_text(row.get(key)) for row in rows if _text(row.get(key))},
                        key=lambda value: value.lower())
            for key in sorted(_FILTER_FIELDS)
        }

        page, limit = _parse_pagination_params(request.args)
        total_count = len(filtered_rows)
        total_pages = max(1, math.ceil(total_count / limit))
        page = min(page, total_pages)
        start = (page - 1) * limit
        response = jsonify({
            "success": True,
            "stockRows": filtered_rows[start:start + limit],
            "filterOptions": filter_options,
            "pagination": {"page": page, "limit": limit, "totalCount": total_count,
                           "totalPages": total_pages, "hasNextPage": page < total_pages,
                           "hasPrevPage": page > 1},
        })
        response.headers["Cache-Control"] = "no-store"
        return response, 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch stock register: {exc}"}), 500


# ---- Finished Goods Stock (Packed units vs Delivered units) ----

_FG_SEARCH_KEYS = ("model", "serial", "phase", "packagedBy", "packagedDate", "status")
_FG_FILTER_FIELDS = frozenset({"model", "phase", "status"})


def _fg_row_matches_filters(row, search, filters):
    if search and not any(search in _text(row.get(key)).lower() for key in _FG_SEARCH_KEYS):
        return False
    for field, value in filters:
        if _text(row.get(field)).lower() != value.lower():
            return False
    return True


@stockregister_bp.route("/stock-register/finished-goods", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge")
@cached_read("stock-register-finished-goods", ttl_seconds=120)
def list_finished_goods_stock():
    """Finished goods inventory: QC-passed units (In Stock) vs Delivered units (Sold).

    - In Stock: assembly_units with QC=Passed, serial NOT in delivered sales, whatever
      the packaging status - the same rule as Daily Production's Stock Status
    - Sold: assembly_units with QC=Passed, serial IN delivered sales (dispatch=Delivered)
    - Matches by serial number to determine actual availability.
    - "Delivered" only, not "Dispatched": a dispatched-but-not-delivered unit is
      still counted as stock by the dashboard, and both pages must agree.
    """
    try:
        # Get delivered serials from sales register
        delivered_serials = _get_delivered_serials()

        # Fetch all QC-passed assembly units
        assembly_docs = list(db.collection("assembly_units").stream())
        
        packed_units = []
        for doc in assembly_docs:
            data = doc.to_dict() or {}
            # Only consider QC-passed units
            if str(data.get("qc", "")).strip().casefold() != "passed":
                continue
            
            serial = str(data.get("serial", "")).strip()
            if not serial:
                continue
            
            # Determine status by checking if serial is in delivered sales
            serial_key = serial.casefold()
            is_delivered = serial_key in delivered_serials
            status = "Sold" if is_delivered else "In Stock"
            
            # A QC-passed unit is stock whether or not it has been packed yet,
            # matching Daily Production's Stock Status; the Packaging Status
            # column shows which ones are still pending.
            packaging_status = str(data.get("packagingStatus", "")).strip()
            
            packed_units.append({
                "id": doc.id,
                "modelId": data.get("modelId", ""),
                "model": data.get("model", ""),
                "phaseId": data.get("phaseId", ""),
                "phase": data.get("phase", ""),
                "serial": serial,
                "packagingStatus": packaging_status,
                "packagedBy": data.get("packagedBy", ""),
                "packagedById": data.get("packagedById", ""),
                # When it was packed; older units only have their last update.
                "packagedDate": (data.get("packagedAt") or data.get("updatedAt")).isoformat()
                if (data.get("packagedAt") or data.get("updatedAt")) else None,
                "assembledBy": data.get("assembledBy", ""),
                "assembledDate": data.get("date", ""),
                "qcBy": data.get("qcBy", ""),
                "status": status,
                "isDelivered": is_delivered,
            })

        # Sort: In Stock first, then Sold; newest packaged date first inside each
        # group. Undated rows score 0, which the negated stamp pushes behind every
        # dated row instead of ahead of them.
        packed_units.sort(key=lambda u: (
            0 if u["status"] == "In Stock" else 1,
            -_sort_timestamp(u["packagedDate"]),
        ))

        # Apply search and filters
        search = (request.args.get("q") or "").strip().lower()
        raw_fields = request.args.getlist("filterField")
        raw_values = request.args.getlist("filterValue")
        filters = []
        for raw_field, raw_value in zip(raw_fields, raw_values):
            field = (raw_field or "").strip()
            if field in _FG_FILTER_FIELDS:
                filters.append((field, str(raw_value or "")))

        filtered_units = [u for u in packed_units if _fg_row_matches_filters(u, search, filters)]

        # Filter options for dropdowns
        filter_options = {
            key: sorted({_text(u.get(key)) for u in packed_units if _text(u.get(key))},
                        key=lambda value: value.lower())
            for key in sorted(_FG_FILTER_FIELDS)
        }

        page, limit = _parse_pagination_params(request.args)
        total_count = len(filtered_units)
        total_pages = max(1, math.ceil(total_count / limit))
        page = min(page, total_pages)
        start = (page - 1) * limit

        response = jsonify({
            "success": True,
            "finishedGoods": filtered_units[start:start + limit],
            "filterOptions": filter_options,
            "summary": {
                "inStock": sum(1 for u in packed_units if u["status"] == "In Stock"),
                "sold": sum(1 for u in packed_units if u["status"] == "Sold"),
                "total": len(packed_units),
            },
            "pagination": {"page": page, "limit": limit, "totalCount": total_count,
                           "totalPages": total_pages, "hasNextPage": page < total_pages,
                           "hasPrevPage": page > 1},
        })
        response.headers["Cache-Control"] = "no-store"
        return response, 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch finished goods stock: {exc}"}), 500


# ---- Debug: Check for duplicate serials in assembly_units ----
@stockregister_bp.route("/stock-register/debug/assembly-serials", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge")
def debug_assembly_serials():
    """Debug endpoint to find duplicate serials in assembly_units."""
    try:
        assembly_docs = list(db.collection("assembly_units").stream())
        
        serial_counts = {}
        qc_passed = []
        all_serials = []
        
        for doc in assembly_docs:
            data = doc.to_dict() or {}
            serial = str(data.get("serial", "")).strip()
            if not serial:
                continue
            all_serials.append(serial)
            serial_key = serial.casefold()
            serial_counts[serial_key] = serial_counts.get(serial_key, 0) + 1
            
            if str(data.get("qc", "")).strip().casefold() == "passed":
                qc_passed.append({
                    "serial": serial,
                    "packagingStatus": str(data.get("packagingStatus", "")).strip(),
                    "docId": doc.id,
                    "model": data.get("model", ""),
                    "phase": data.get("phase", ""),
                })
        
        duplicates = {serial: count for serial, count in serial_counts.items() if count > 1}
        
        # Get delivered serials from sales
        sales_collection = db.collection("sale_register")
        delivered_serials = set()
        for status in ["delivered", "dispatched"]:
            docs = sales_collection.where("dispatch", "==", status).stream()
            for doc in docs:
                data = doc.to_dict() or {}
                serials = data.get("serialNumbers")
                if not isinstance(serials, list):
                    legacy_serial = str(data.get("serial", "")).strip()
                    serials = [legacy_serial] if legacy_serial else []
                for s in serials:
                    if s:
                        delivered_serials.add(str(s).strip().casefold())
        
        # Classify each QC-passed unit
        for unit in qc_passed:
            unit["isDelivered"] = unit["serial"].casefold() in delivered_serials
            unit["status"] = "Sold" if unit["isDelivered"] else ("In Stock" if unit["packagingStatus"] == "Packed" else "Not Packed")
        
        return jsonify({
            "success": True,
            "totalAssemblyUnits": len(all_serials),
            "uniqueSerials": len(serial_counts),
            "duplicateSerials": duplicates,
            "qcPassedCount": len(qc_passed),
            "deliveredSerialsCount": len(delivered_serials),
            "units": qc_passed,
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Debug error: {exc}"}), 500

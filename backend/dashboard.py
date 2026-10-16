from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from flask import Blueprint, jsonify, request

from firebase_config import db
from auth_utils import roles_required
from read_cache import cached_read
from stockregister import _consumed_by_phase


dashboard_bp = Blueprint("dashboard", __name__)

USER_ACTIVITY_FIELDS = {
    "assembly": ("assembledById", "assembledBy"),
    "qc": ("qcById", "qcBy"),
    "packaging": ("packagedById", "packagedBy"),
}


def _number(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0


def _display_number(value):
    return int(value) if float(value).is_integer() else value


def _unit_value_total(sales):
    """Total of Unit Cost x Qty across sales, ignoring the GST-inclusive value.

    The dashboard's Sales Value KPI reports the unit-level spend rather than
    the stored PO value, so it lines up with the Basic Price total the table
    pages show.
    """
    total = 0
    for sale in sales:
        if sale.get("dispatch") == "Cancelled":
            continue
        total += _number(sale.get("unitCost")) * _number(sale.get("qty"))
    return total


def _packed_period(date_value, weekly=False):
    """Return a stable day or ISO-week key for an assembly date."""
    try:
        parsed = datetime.fromisoformat(str(date_value).replace("Z", "+00:00"))
        iso = parsed.isocalendar()
        return f"{iso.year}-W{iso.week:02d}" if weekly else parsed.date().isoformat()
    except (TypeError, ValueError):
        return "Undated"


def _assigned_to_current_user(data, id_field, name_field):
    """Match immutable account IDs first and support legacy name-only rows."""
    assigned_id = str(data.get(id_field) or "").strip()
    current_id = str(request.user.get("sub") or "").strip()
    if assigned_id:
        return bool(current_id and assigned_id == current_id)
    assigned_name = str(data.get(name_field) or "").strip().casefold()
    current_name = str(request.user.get("name") or "").strip().casefold()
    return bool(assigned_name and current_name and assigned_name == current_name)


def _activity_docs(all_docs, activity, user_scoped):
    if not user_scoped:
        return all_docs
    id_field, name_field = USER_ACTIVITY_FIELDS[activity]
    return [
        data for data in all_docs
        if _assigned_to_current_user(data, id_field, name_field)
    ]


def _stock_reorder_count(assembly_docs, po_docs, invoice_docs, boq_docs):
    """Reproduce the stock register's calculated closing-stock rule."""
    # Same rule as the stock register: any recorded production unit counts as
    # consumed, whatever its stage or QC status.
    completed_by_phase = _consumed_by_phase(assembly_docs)

    items = {}
    po_keys = {}
    for data in po_docs:
        code = data.get("code", "")
        if not code:
            continue
        key = (data.get("modelId", ""), data.get("phaseId", "") or data.get("phase", ""), code)
        items.setdefault(key, {"reqQty": 0, "minLevel": 0, "purchased": 0, "consumed": 0})
        po_keys[(data.get("po", ""), code)] = key

    for boq_doc in boq_docs:
        boq = boq_doc.to_dict() or {}
        phase_ref = boq_doc.reference.parent.parent
        model_ref = phase_ref.parent.parent if phase_ref else None
        model_id = model_ref.id if model_ref else ""
        phase_id = phase_ref.id if phase_ref else ""
        # The phase ID is already available from the parent reference.  Do
        # not fetch each parent phase document here: that turns a dashboard
        # request into hundreds of serial Firestore reads for large BOQs.
        phase_name = ""

        for row in boq.get("rows", []) or []:
            code = row.get("code", "")
            if not code:
                continue
            key = (model_id, phase_id or phase_name, code)
            item = items.setdefault(key, {"reqQty": 0, "minLevel": 0, "purchased": 0, "consumed": 0})
            item["reqQty"] = _number(row.get("reqQty"))
            item["minLevel"] = _number(row.get("minStockQty"))
            item["consumed"] = completed_by_phase.get((model_id, phase_id), 0) * item["reqQty"]

    for data in invoice_docs:
        code = data.get("code", "")
        if not code:
            continue
        key = (data.get("modelId", ""), data.get("phaseId", "") or data.get("phase", ""), code)
        key = po_keys.get((data.get("po", ""), code), key)
        item = items.setdefault(key, {"reqQty": 0, "minLevel": 0, "purchased": 0, "consumed": 0})
        item["purchased"] += _number(data.get("qtyRecv"))

    return sum(1 for item in items.values() if item["purchased"] - item["consumed"] < item["minLevel"])


def _stream_collection(name):
    return [(doc.to_dict() or {}) for doc in db.collection(name).stream()]


# A sale counts as dispatched once it leaves the warehouse.  The register calls
# that state "Delivered" now; sales saved before the rename still say
# "Dispatched", so both spellings are counted.
DISPATCHED_STATUSES = ("Dispatched", "Delivered")

# A unit is "added to stock" once assembly has finished it, or once packaging
# has sealed it. Either milestone means the unit physically exists as stock, so
# both are counted - and each unit is only ever counted once.
STOCK_STAGE = "Completed"
STOCK_PACKAGING = "Packed"


def _sale_serials(sale):
    """Every serial a sale covers.

    Newer sale records split a multi-serial dispatch into `serialNumbers`, while
    older ones (and single-unit sales) keep a comma-joined `serial`. Both are
    merged so a serial is matched regardless of which shape it was saved in.
    """
    serials = set()
    numbers = sale.get("serialNumbers")
    if isinstance(numbers, list):
        serials.update(value.strip() for value in map(str, numbers) if value.strip())
    single = str(sale.get("serial") or "").strip()
    if single:
        serials.update(part.strip() for part in single.split(",") if part.strip())
    return serials


def _sales_dashboard_data(sales_docs, model_names, include_all_active_sales=False):
    """Build the sales chart payload for either Vector or Customer Sales."""
    dispatched = [
        sale for sale in sales_docs
        if sale.get("dispatch") != "Cancelled"
        and (include_all_active_sales or sale.get("dispatch") in DISPATCHED_STATUSES)
    ]
    locations = defaultdict(float); location_by_day = defaultdict(float); location_by_week = defaultdict(float)
    client_by_day = defaultdict(float); sales_by_month = defaultdict(float); sales_by_model_month = defaultdict(float)
    end_user_location_by_day = defaultdict(float); end_user_client_by_day = defaultdict(float)
    for sale in sales_docs:
        if sale.get("dispatch") == "Cancelled":
            continue
        period = _packed_period(sale.get("date")); model = (sale.get("model") or "Unspecified").strip() or "Unspecified"
        sales_by_model_month[(period[:7], model)] += _number(sale.get("qty"))
    for sale in dispatched:
        location = (sale.get("location") or "Unspecified").strip() or "Unspecified"; quantity = _number(sale.get("qty"))
        locations[location] += quantity
        location_by_day[(_packed_period(sale.get("date")), location)] += quantity
        location_by_week[(_packed_period(sale.get("date"), weekly=True), location)] += quantity
        client = (sale.get("client") or "Unspecified").strip() or "Unspecified"
        client_by_day[(_packed_period(sale.get("date")), client)] += quantity
        end_user_location = (sale.get("endUserLocation") or sale.get("location") or "Unspecified").strip() or "Unspecified"
        end_user_location_by_day[(_packed_period(sale.get("date")), end_user_location)] += quantity
        end_user_client = (sale.get("endUserClient") or sale.get("client") or "Unspecified").strip() or "Unspecified"
        end_user_client_by_day[(_packed_period(sale.get("date")), end_user_client)] += quantity
        sales_by_month[_packed_period(sale.get("date"))[:7]] += quantity
    return {
        "kpis": {"sold": _display_number(sum(_number(sale.get("qty")) for sale in dispatched)), "salesValue": _unit_value_total(sales_docs)},
        "modelNames": sorted(set(model_names) | {model for _, model in sales_by_model_month}, key=str.casefold),
        "locationSalesByDay": [{"period": period, "location": location, "units": _display_number(units)} for (period, location), units in sorted(location_by_day.items())],
        "clientSalesByDay": [{"period": period, "client": client, "units": _display_number(units)} for (period, client), units in sorted(client_by_day.items())],
        "endUserLocationByDay": [{"period": period, "location": location, "units": _display_number(units)} for (period, location), units in sorted(end_user_location_by_day.items())],
        "endUserClientByDay": [{"period": period, "client": client, "units": _display_number(units)} for (period, client), units in sorted(end_user_client_by_day.items())],
        "salesByMonth": [{"period": period, "units": _display_number(units)} for period, units in sorted(sales_by_month.items())],
        "salesByModelMonth": [{"period": period, "model": model, "units": _display_number(units)} for (period, model), units in sorted(sales_by_model_month.items())],
    }


@dashboard_bp.route("/dashboard", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge", "user")
@cached_read("dashboard", ttl_seconds=120)
def get_dashboard():
    """Return the dashboard's operational snapshot from live Firestore data."""
    try:
        # Production incharges only need production and quality data.  Avoid
        # loading the large sales/stock collections for their dashboard.
        production_scoped = request.user.get("role") in {"user", "production_incharge"}
        user_scoped = request.user.get("role") == "user"
        with ThreadPoolExecutor(max_workers=7) as executor:
            assembly_future = executor.submit(_stream_collection, "assembly_units")
            defect_future = executor.submit(_stream_collection, "defective_units")
            if production_scoped:
                model_future = sale_future = customer_sale_future = invoice_future = po_future = boq_future = None
            else:
                model_future = executor.submit(_stream_collection, "models")
                sale_future = executor.submit(_stream_collection, "sale_register")
                customer_sale_future = executor.submit(_stream_collection, "customer_sales")
                invoice_future = executor.submit(_stream_collection, "invoices")
                po_future = executor.submit(_stream_collection, "po_details")
                boq_future = executor.submit(lambda: list(db.collection_group("boqs").stream()))
            assembly_docs = assembly_future.result()
            defect_docs = defect_future.result()
            model_docs = model_future.result() if model_future else []
            sale_docs = sale_future.result() if sale_future else []
            customer_sale_docs = customer_sale_future.result() if customer_sale_future else []
            invoice_docs = invoice_future.result() if invoice_future else []
            po_docs = po_future.result() if po_future else []
            boq_docs = boq_future.result() if boq_future else []
        if production_scoped:
            model_docs = sale_docs = customer_sale_docs = invoice_docs = po_docs = boq_docs = []

        assembly_activity_docs = _activity_docs(assembly_docs, "assembly", user_scoped)
        qc_activity_docs = _activity_docs(assembly_docs, "qc", user_scoped)
        packaging_activity_docs = _activity_docs(assembly_docs, "packaging", user_scoped)

        stage_totals = defaultdict(float)
        qc_passed = 0
        qc_failed = 0
        qc_inspection = 0
        packed = 0

        for unit in assembly_activity_docs:
            quantity = _number(unit.get("qty"))
            stage_totals[unit.get("stage", "")] += quantity
        semi_finished = stage_totals["Semi Finished"]

        for unit in qc_activity_docs:
            quantity = _number(unit.get("qty"))
            qc = unit.get("qc", "")
            if qc == "Passed":
                qc_passed += quantity
            elif qc == "Failed":
                qc_failed += quantity
            elif qc in ("Under Inspection", "Pending"):
                qc_inspection += quantity

        for unit in packaging_activity_docs:
            quantity = _number(unit.get("qty"))
            if unit.get("packagingStatus") == "Packed":
                packed += quantity

        sales_value = _unit_value_total(sale_docs)
        dispatched_sales = [sale for sale in sale_docs if sale.get("dispatch") in DISPATCHED_STATUSES]
        # "Total qty delivered" counts a sale once it has actually been
        # delivered, not while it is only marked dispatched. Compared with
        # casefold because dispatch is stored as title case and older rows may
        # differ; the Finished Goods page uses the same rule so the two agree.
        delivered_sales = [
            sale for sale in sale_docs
            if str(sale.get("dispatch") or "").strip().casefold() == "delivered"
        ]
        units_sold = sum(_number(sale.get("qty")) for sale in delivered_sales)

        # Serials that have left the warehouse. A device is identified by its
        # serial in both collections, so this is what links a sale back to the
        # unit it consumed.
        sold_serials = set()
        for sale in delivered_sales:
            sold_serials |= _sale_serials(sale)

        # Stock that is still physically available: units added to stock, minus
        # the ones already delivered. Counting the whole `qty` and not just the
        # document keeps a multi-unit record honest, and the floor at zero stops
        # a sale that was entered before its unit existed from showing negative.
        in_stock_added = 0
        in_stock_sold = 0
        for unit in assembly_activity_docs:
            quantity = _number(unit.get("qty"))
            stage = str(unit.get("stage") or "").strip()
            packaging = str(unit.get("packagingStatus") or "").strip()
            if stage != STOCK_STAGE and packaging != STOCK_PACKAGING:
                continue
            in_stock_added += quantity
            if str(unit.get("serial") or "").strip() in sold_serials:
                in_stock_sold += quantity
        in_stock = max(0, in_stock_added - in_stock_sold)
        locations = defaultdict(float)
        location_by_day = defaultdict(float)
        location_by_week = defaultdict(float)
        client_by_day = defaultdict(float)
        end_user_location_by_day = defaultdict(float)
        end_user_client_by_day = defaultdict(float)
        sales_by_month = defaultdict(float)
        sales_by_model_month = defaultdict(float)
        production_by_model = defaultdict(float)
        packed_by_day = defaultdict(float)
        packed_by_week = defaultdict(float)
        qc_by_day = defaultdict(float)
        qc_by_week = defaultdict(float)
        assembled_by_user_day = defaultdict(float)
        assembled_by_user_week = defaultdict(float)
        packaged_by_user_day = defaultdict(float)
        packaged_by_user_week = defaultdict(float)
        assembled_by_month = defaultdict(float)
        assembled_by_month_user = defaultdict(float)
        qc_by_month_status = defaultdict(float)
        qc_by_month_status_user = defaultdict(float)
        packaged_by_month_status = defaultdict(float)
        packaged_by_month_status_user = defaultdict(float)
        # Day-level status splits. The monthly buckets above cannot answer "how
        # much in this date range", so these carry the same status/user detail
        # one day at a time for the analytics date filter.
        qc_by_day_status_user = defaultdict(float)
        packaged_by_day_status_user = defaultdict(float)
        # The model sales trend should reflect every active sale as soon as it
        # is recorded. Dispatch status is intentionally only used for the
        # separate dispatch KPIs and dispatch charts below.
        for sale in sale_docs:
            if sale.get("dispatch") == "Cancelled":
                continue
            period = _packed_period(sale.get("date"))
            quantity = _number(sale.get("qty"))
            model = (sale.get("model") or "Unspecified").strip() or "Unspecified"
            sales_by_model_month[(period[:7], model)] += quantity

        for sale in dispatched_sales:
            location = (sale.get("location") or "Unspecified").strip() or "Unspecified"
            quantity = _number(sale.get("qty"))
            locations[location] += quantity
            location_by_day[(_packed_period(sale.get("date")), location)] += quantity
            location_by_week[(_packed_period(sale.get("date"), weekly=True), location)] += quantity
            client = (sale.get("client") or "Unspecified").strip() or "Unspecified"
            client_by_day[(_packed_period(sale.get("date")), client)] += quantity
            end_user_location = (sale.get("endUserLocation") or location).strip() or "Unspecified"
            end_user_location_by_day[(_packed_period(sale.get("date")), end_user_location)] += quantity
            end_user_client = (sale.get("endUserClient") or client).strip() or "Unspecified"
            end_user_client_by_day[(_packed_period(sale.get("date")), end_user_client)] += quantity
            period = _packed_period(sale.get("date"))
            sales_by_month[period[:7]] += quantity

        scoped_user_name = (
            str(request.user.get("name") or request.user.get("email") or "Current user").strip()
            if user_scoped else ""
        )

        for unit in assembly_activity_docs:
            period = _packed_period(unit.get("date"))
            month = period[:7] if period != "Undated" else period
            quantity = _number(unit.get("qty"))
            model = (unit.get("model") or "Unspecified").strip() or "Unspecified"
            production_by_model[model] += quantity
            assembled_user = scoped_user_name or (unit.get("assembledBy") or "").strip() or "Unassigned"
            assembled_by_user_day[(_packed_period(unit.get("date")), assembled_user)] += quantity
            assembled_by_user_week[(_packed_period(unit.get("date"), weekly=True), assembled_user)] += quantity
            assembled_by_month[month] += quantity
            assembled_by_month_user[(month, assembled_user)] += quantity

        for unit in qc_activity_docs:
            period = _packed_period(unit.get("date"))
            month = period[:7] if period != "Undated" else period
            quantity = _number(unit.get("qty"))
            qc_status = (unit.get("qc") or "Pending").strip() or "Pending"
            qc_by_month_status[(month, qc_status)] += quantity
            qc_user = scoped_user_name or (unit.get("qcBy") or "Unassigned").strip() or "Unassigned"
            qc_by_month_status_user[(month, qc_status, qc_user)] += quantity
            qc_by_day_status_user[(period, qc_status, qc_user)] += quantity
            if unit.get("qcBy") or unit.get("qcById"):
                qc_by_day[(_packed_period(unit.get("date")), qc_user)] += quantity
                qc_by_week[(_packed_period(unit.get("date"), weekly=True), qc_user)] += quantity

        for unit in packaging_activity_docs:
            period = _packed_period(unit.get("date"))
            month = period[:7] if period != "Undated" else period
            quantity = _number(unit.get("qty"))
            model = (unit.get("model") or "Unspecified").strip() or "Unspecified"
            packaging_status = (unit.get("packagingStatus") or "Pending").strip() or "Pending"
            packaged_by_month_status[(month, packaging_status)] += quantity
            packaged_user = scoped_user_name or (unit.get("packagedBy") or "Unassigned").strip() or "Unassigned"
            packaged_by_month_status_user[(month, packaging_status, packaged_user)] += quantity
            packaged_by_day_status_user[(period, packaging_status, packaged_user)] += quantity
            if unit.get("packagingStatus") == "Packed":
                packed_by_day[( _packed_period(unit.get("date")), model)] += quantity
                packed_by_week[(_packed_period(unit.get("date"), weekly=True), model)] += quantity
                packaged_by_user_day[(_packed_period(unit.get("date")), packaged_user)] += quantity
                packaged_by_user_week[(_packed_period(unit.get("date"), weekly=True), packaged_user)] += quantity

        parts = defaultdict(float)
        for defect in defect_docs:
            part = (defect.get("part") or "Unspecified").strip() or "Unspecified"
            parts[part] += 1

        qc_total = qc_passed + qc_failed
        quality_pass_rate = round((qc_passed / qc_total) * 100) if qc_total else 0
        reorder_count = 0 if user_scoped else _stock_reorder_count(assembly_docs, po_docs, invoice_docs, boq_docs)

        # "Total Unit" is defined as the sum of the five pipeline buckets the
        # cards below it already show, so the headline always agrees with the
        # row of figures under it. The buckets are counted independently, so a
        # unit that somehow carries both a production stage and a QC verdict
        # would be counted in both - that matches what the cards display.
        total_units = (
            stage_totals["In Production"]
            + semi_finished
            + qc_passed
            + qc_failed
            + qc_inspection
        )

        return jsonify({
            "success": True,
            "kpis": {
                "total": _display_number(total_units),
                "inProduction": _display_number(stage_totals["In Production"]),
                "semiFinished": _display_number(semi_finished),
                "qcInspection": _display_number(qc_inspection),
                "qcFailed": _display_number(qc_failed),
                "qcPassed": _display_number(qc_passed),
                "packed": _display_number(packed),
                "inStock": _display_number(in_stock),
                "inStockAdded": _display_number(in_stock_added),
                "inStockSold": _display_number(in_stock_sold),
                "sold": _display_number(units_sold),
                "salesValue": sales_value,
                "defects": len(defect_docs),
                "reorder": reorder_count,
            },
            "qualityPassRate": quality_pass_rate,
            "dispatchLocationCount": len(locations) + len({loc for (_, loc) in end_user_location_by_day.keys() if loc != "Unspecified"}),
            "modelNames": sorted({
                (model.get("name") or "").strip()
                for model in model_docs
                if (model.get("name") or "").strip()
            }, key=str.casefold),
            "customerSales": _sales_dashboard_data(customer_sale_docs, [
                (model.get("name") or "").strip() for model in model_docs if (model.get("name") or "").strip()
            ], include_all_active_sales=True),
            "locationSales": [
                {"location": location, "units": _display_number(units)}
                for location, units in sorted(locations.items(), key=lambda item: (-item[1], item[0].lower()))
            ],
            "locationSalesByDay": [
                {"period": period, "location": location, "units": _display_number(units)}
                for (period, location), units in sorted(location_by_day.items())
            ],
            "locationSalesByWeek": [
                {"period": period, "location": location, "units": _display_number(units)}
                for (period, location), units in sorted(location_by_week.items())
            ],
            "clientSalesByDay": [
                {"period": period, "client": client, "units": _display_number(units)}
                for (period, client), units in sorted(client_by_day.items())
            ],
            "endUserLocationByDay": [
                {"period": period, "location": location, "units": _display_number(units)}
                for (period, location), units in sorted(end_user_location_by_day.items())
            ],
            "endUserClientByDay": [
                {"period": period, "client": client, "units": _display_number(units)}
                for (period, client), units in sorted(end_user_client_by_day.items())
            ],
            "salesByMonth": [
                {"period": period, "units": _display_number(units)}
                for period, units in sorted(sales_by_month.items())
            ],
            "salesByModelMonth": [
                {"period": period, "model": model, "units": _display_number(units)}
                for (period, model), units in sorted(sales_by_model_month.items())
            ],
            "productionByModel": [
                {"model": model, "units": _display_number(units)}
                for model, units in sorted(production_by_model.items(), key=lambda item: (-item[1], item[0].lower()))
            ],
            "assembledByMonth": [
                {"period": period, "units": _display_number(units)}
                for period, units in sorted(assembled_by_month.items())
            ],
            "assembledByMonthUser": [
                {"period": period, "user": user, "units": _display_number(units)}
                for (period, user), units in sorted(assembled_by_month_user.items())
            ],
            "qcByMonthStatus": [
                {"period": period, "status": status, "units": _display_number(units)}
                for (period, status), units in sorted(qc_by_month_status.items())
            ],
            "qcByMonthStatusUser": [
                {"period": period, "status": status, "user": user, "units": _display_number(units)}
                for (period, status, user), units in sorted(qc_by_month_status_user.items())
            ],
            "packagedByMonthStatus": [
                {"period": period, "status": status, "units": _display_number(units)}
                for (period, status), units in sorted(packaged_by_month_status.items())
            ],
            "packagedByMonthStatusUser": [
                {"period": period, "status": status, "user": user, "units": _display_number(units)}
                for (period, status, user), units in sorted(packaged_by_month_status_user.items())
            ],
            "qcByDayStatusUser": [
                {"period": period, "status": status, "user": user, "units": _display_number(units)}
                for (period, status, user), units in sorted(qc_by_day_status_user.items())
            ],
            "packagedByDayStatusUser": [
                {"period": period, "status": status, "user": user, "units": _display_number(units)}
                for (period, status, user), units in sorted(packaged_by_day_status_user.items())
            ],
            "packedByDay": [
                {"period": period, "model": model, "units": _display_number(units)}
                for (period, model), units in sorted(packed_by_day.items())
            ],
            "packedByWeek": [
                {"period": period, "model": model, "units": _display_number(units)}
                for (period, model), units in sorted(packed_by_week.items())
            ],
            "qcByUserDay": [
                {"period": period, "user": user, "units": _display_number(units)}
                for (period, user), units in sorted(qc_by_day.items())
            ],
            "qcByUserWeek": [
                {"period": period, "user": user, "units": _display_number(units)}
                for (period, user), units in sorted(qc_by_week.items())
            ],
            "assembledByUserDay": [
                {"period": period, "user": user, "units": _display_number(units)}
                for (period, user), units in sorted(assembled_by_user_day.items())
            ],
            "assembledByUserWeek": [
                {"period": period, "user": user, "units": _display_number(units)}
                for (period, user), units in sorted(assembled_by_user_week.items())
            ],
            "packagedByUserDay": [
                {"period": period, "user": user, "units": _display_number(units)}
                for (period, user), units in sorted(packaged_by_user_day.items())
            ],
            "packagedByUserWeek": [
                {"period": period, "user": user, "units": _display_number(units)}
                for (period, user), units in sorted(packaged_by_user_week.items())
            ],
            "defectiveParts": [
                {"name": part, "count": _display_number(count)}
                for part, count in sorted(parts.items(), key=lambda item: (-item[1], item[0].lower()))
            ],
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to build dashboard: {exc}"}), 500

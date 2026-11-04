from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

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


def _has_recorded_status(value):
    """Ignore blank/dash placeholders rather than counting them as a status."""
    return str(value or "").strip().casefold() not in {"", "-", "–", "—"}


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


# The plant runs on India time; a UTC stamp taken after midnight IST must land
# on the IST day the work was done.
_IST = timezone(timedelta(hours=5, minutes=30))


def _event_period(unit, stamp_field, weekly=False, fallbacks=("date",)):
    """Day / ISO-week key for when a step happened.

    `stamp_field` is the moment the step was recorded (e.g. `packagedAt`).
    Units saved before that field existed fall back, in order, to `fallbacks`.
    """
    for field in (stamp_field, *fallbacks):
        value = unit.get(field)
        if not value:
            continue
        if isinstance(value, datetime):
            if value.tzinfo is not None:
                value = value.astimezone(_IST)
            iso = value.isocalendar()
            return f"{iso.year}-W{iso.week:02d}" if weekly else value.date().isoformat()
        return _packed_period(value, weekly=weekly)
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


def _stream_phase_plans():
    """Every phase of every model: two reads in total (all models, then all
    phases at once) instead of one phases read per model."""
    model_names = {
        doc.id: str((doc.to_dict() or {}).get("name") or "").strip()
        for doc in db.collection("models").stream()
    }
    plans = []
    for phase_doc in db.collection_group("phases").stream():
        model_ref = phase_doc.reference.parent.parent
        # Only phases stored under an existing models/<id> document.
        if model_ref is None or model_ref.parent.id != "models" or model_ref.id not in model_names:
            continue
        phase = phase_doc.to_dict() or {}
        plans.append({
            "modelId": model_ref.id,
            "model": model_names[model_ref.id],
            "phaseId": phase_doc.id,
            "phase": str(phase.get("name") or "").strip(),
            "target": phase.get("target"),
            "startDate": phase.get("startDate"),
            "endDate": phase.get("endDate"),
        })
    # Same order as before: model by model, then phase.
    plans.sort(key=lambda plan: (plan["modelId"], plan["phaseId"]))
    return plans


def _phase_roadmap_data(phase_plans, assembly_docs):
    """Each phase plus the units entered against it ("built").

    A unit belongs to a phase by its phaseId (phase ids are unique). Older
    units saved without a phaseId fall back to model + phase name, matched by
    the model id when the unit has one, otherwise by the model name.
    """
    units_by_phase_id = defaultdict(float)
    units_by_model_id_and_name = defaultdict(float)
    units_by_model_name_and_name = defaultdict(float)
    for unit in assembly_docs:
        quantity = _number(unit.get("qty"))
        phase_id = str(unit.get("phaseId") or "").strip()
        if phase_id:
            units_by_phase_id[phase_id] += quantity
            continue
        phase_name = str(unit.get("phase") or "").strip().casefold()
        if not phase_name:
            continue
        model_id = str(unit.get("modelId") or "").strip()
        if model_id:
            units_by_model_id_and_name[(model_id, phase_name)] += quantity
        else:
            model_name = str(unit.get("model") or unit.get("modelName") or "").strip().casefold()
            units_by_model_name_and_name[(model_name, phase_name)] += quantity

    roadmap = []
    for phase in phase_plans:
        model_id = str(phase.get("modelId") or "").strip()
        model_name = str(phase.get("model") or "").strip().casefold()
        phase_id = str(phase.get("phaseId") or "").strip()
        phase_name = str(phase.get("phase") or "").strip().casefold()
        units = units_by_phase_id.get(phase_id, 0) if phase_id else 0
        if phase_name:
            units += units_by_model_id_and_name.get((model_id, phase_name), 0) if model_id else 0
            units += units_by_model_name_and_name.get((model_name, phase_name), 0)
        roadmap.append({
            **phase,
            "units": _display_number(units),
        })
    return roadmap


def _matches_dashboard_model(data, model_name, model_ids):
    name = str(data.get("model") or data.get("modelName") or "").strip()
    model_id = str(data.get("modelId") or "").strip()
    return name.casefold() == model_name.casefold() or bool(model_id and model_id in model_ids)


def _production_units_by_model(units):
    """Group all recorded production quantities by model for dashboard reporting."""
    totals = defaultdict(float)
    for unit in units:
        model = str(unit.get("model") or unit.get("modelName") or "").strip() or "Unspecified"
        totals[model] += _number(unit.get("qty"))
    return [
        {"model": model, "units": _display_number(units)}
        for model, units in sorted(totals.items(), key=lambda item: (-item[1], item[0].casefold()))
    ]


def _defective_parts_by_model(defects):
    counts = defaultdict(float)
    for defect in defects:
        model = str(defect.get("model") or defect.get("modelName") or "").strip() or "Unspecified"
        part = str(defect.get("part") or "").strip() or "Unspecified"
        counts[(part, model)] += 1
    return [
        {"name": part, "model": model, "count": _display_number(count)}
        for (part, model), count in sorted(
            counts.items(), key=lambda item: (item[0][0].casefold(), item[0][1].casefold())
        )
    ]


# A sale counts as dispatched once it leaves the warehouse.  The register calls
# that state "Delivered" now; sales saved before the rename still say
# "Dispatched", so both spellings are counted.
DISPATCHED_STATUSES = ("Dispatched", "Delivered")


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
    actual_dispatched = [
        sale for sale in sales_docs
        if sale.get("dispatch") in DISPATCHED_STATUSES
    ]
    locations = defaultdict(float); location_by_day = defaultdict(float); location_by_week = defaultdict(float)
    client_by_day = defaultdict(float); sales_by_month = defaultdict(float); sales_by_model_month = defaultdict(float)
    end_user_location_by_day = defaultdict(float); end_user_client_by_day = defaultdict(float)
    dispatched_by_model_month = defaultdict(float); dispatched_by_model_day = defaultdict(float)
    end_user_location_by_model_day = defaultdict(float); end_user_client_by_model_day = defaultdict(float)
    sales_by_model_day = defaultdict(float)
    for sale in sales_docs:
        if sale.get("dispatch") == "Cancelled":
            continue
        period = _packed_period(sale.get("date")); model = (sale.get("model") or "Unspecified").strip() or "Unspecified"
        sales_by_model_month[(period[:7], model)] += _number(sale.get("qty"))
        sales_by_model_day[(period, model)] += _number(sale.get("qty"))
    for sale in dispatched:
        location = (sale.get("location") or "Unspecified").strip() or "Unspecified"; quantity = _number(sale.get("qty"))
        locations[location] += quantity
        location_by_day[(_packed_period(sale.get("date")), location)] += quantity
        location_by_week[(_packed_period(sale.get("date"), weekly=True), location)] += quantity
        client = (sale.get("client") or "Unspecified").strip() or "Unspecified"
        client_by_day[(_packed_period(sale.get("date")), client)] += quantity
        # End-customer series only: a sale without end-customer details is left
        # out rather than shown under the client's name or location.
        end_user_location = str(sale.get("endUserLocation") or "").strip()
        if end_user_location:
            end_user_location_by_day[(_packed_period(sale.get("date")), end_user_location)] += quantity
        end_user_client = str(sale.get("endUserClient") or "").strip()
        if end_user_client:
            end_user_client_by_day[(_packed_period(sale.get("date")), end_user_client)] += quantity
        sales_by_month[_packed_period(sale.get("date"))[:7]] += quantity
    for sale in actual_dispatched:
        period = _packed_period(sale.get("date"))
        model = (sale.get("model") or "Unspecified").strip() or "Unspecified"
        quantity = _number(sale.get("qty"))
        dispatched_by_model_month[(period[:7], model)] += quantity
        dispatched_by_model_day[(period, model)] += quantity
        end_user_location = str(sale.get("endUserLocation") or "").strip()
        if end_user_location:
            end_user_location_by_model_day[(period, end_user_location, model)] += quantity
        end_user_client = str(sale.get("endUserClient") or "").strip()
        if end_user_client:
            end_user_client_by_model_day[(period, end_user_client, model)] += quantity
    return {
        "kpis": {"sold": _display_number(sum(_number(sale.get("qty")) for sale in dispatched)), "salesValue": _unit_value_total(sales_docs)},
        "modelNames": sorted(set(model_names) | {model for _, model in sales_by_model_month}, key=str.casefold),
        "locationSalesByDay": [{"period": period, "location": location, "units": _display_number(units)} for (period, location), units in sorted(location_by_day.items())],
        "clientSalesByDay": [{"period": period, "client": client, "units": _display_number(units)} for (period, client), units in sorted(client_by_day.items())],
        "endUserLocationByDay": [{"period": period, "location": location, "units": _display_number(units)} for (period, location), units in sorted(end_user_location_by_day.items())],
        "endUserClientByDay": [{"period": period, "client": client, "units": _display_number(units)} for (period, client), units in sorted(end_user_client_by_day.items())],
        "salesByMonth": [{"period": period, "units": _display_number(units)} for period, units in sorted(sales_by_month.items())],
        "salesByModelMonth": [{"period": period, "model": model, "units": _display_number(units)} for (period, model), units in sorted(sales_by_model_month.items())],
        "salesByModelDay": [{"period": period, "model": model, "units": _display_number(units)} for (period, model), units in sorted(sales_by_model_day.items())],
        "dispatchedByModelMonth": [{"period": period, "model": model, "units": _display_number(units)} for (period, model), units in sorted(dispatched_by_model_month.items())],
        "dispatchedByModelDay": [{"period": period, "model": model, "units": _display_number(units)} for (period, model), units in sorted(dispatched_by_model_day.items())],
        "endUserLocationByModelDay": [{"period": period, "location": location, "model": model, "units": _display_number(units)} for (period, location, model), units in sorted(end_user_location_by_model_day.items())],
        "endUserClientByModelDay": [{"period": period, "client": client, "model": model, "units": _display_number(units)} for (period, client, model), units in sorted(end_user_client_by_model_day.items())],
    }


@dashboard_bp.route("/dashboard", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge", "user")
@cached_read("dashboard", ttl_seconds=120)
def get_dashboard():
    """Return the dashboard's operational snapshot from live Firestore data."""
    try:
        # Production roles only need production and quality data, so the large
        # purchase/BOQ collections are skipped for them.  Sales are still loaded
        # for every role: the In Stock and Sold Units cards every role sees are
        # wrong without them (nothing sold, nothing subtracted from stock).
        production_scoped = request.user.get("role") in {"user", "production_incharge"}
        user_scoped = request.user.get("role") == "user"
        with ThreadPoolExecutor(max_workers=7) as executor:
            assembly_future = executor.submit(_stream_collection, "assembly_units")
            defect_future = executor.submit(_stream_collection, "defective_units")
            sale_future = executor.submit(_stream_collection, "sale_register")
            phase_plan_future = executor.submit(_stream_phase_plans)
            if production_scoped:
                model_future = customer_sale_future = invoice_future = po_future = boq_future = None
            else:
                model_future = executor.submit(
                    lambda: [
                        dict(doc.to_dict() or {}, id=doc.id)
                        for doc in db.collection("models").stream()
                    ]
                )
                customer_sale_future = executor.submit(_stream_collection, "customer_sales")
                invoice_future = executor.submit(_stream_collection, "invoices")
                po_future = executor.submit(_stream_collection, "po_details")
                boq_future = executor.submit(lambda: list(db.collection_group("boqs").stream()))
            assembly_docs = assembly_future.result()
            defect_docs = defect_future.result()
            model_docs = model_future.result() if model_future else []
            sale_docs = sale_future.result() if sale_future else []
            phase_plans = phase_plan_future.result()
            customer_sale_docs = customer_sale_future.result() if customer_sale_future else []
            invoice_docs = invoice_future.result() if invoice_future else []
            po_docs = po_future.result() if po_future else []
            boq_docs = boq_future.result() if boq_future else []
        if production_scoped:
            model_docs = customer_sale_docs = invoice_docs = po_docs = boq_docs = []

        all_model_names = {
            str(model.get("name") or "").strip()
            for model in model_docs
            if str(model.get("name") or "").strip()
        }
        for collection in (assembly_docs, sale_docs, customer_sale_docs, defect_docs):
            all_model_names.update(
                str(data.get("model") or data.get("modelName") or "").strip()
                for data in collection
                if str(data.get("model") or data.get("modelName") or "").strip()
            )
        all_model_names.update(
            str(phase.get("model") or "").strip()
            for phase in phase_plans
            if str(phase.get("model") or "").strip()
        )

        completed_model_docs = assembly_docs
        if user_scoped:
            completed_model_docs = [
                unit for unit in assembly_docs
                if any(_assigned_to_current_user(unit, id_field, name_field)
                       for id_field, name_field in USER_ACTIVITY_FIELDS.values())
            ]
        completed_by_model = _production_units_by_model(completed_model_docs)

        selected_model = str(request.args.get("model") or "").strip()
        if selected_model:
            selected_model_key = selected_model.casefold()
            selected_model_ids = {
                str(model.get("id") or "").strip()
                for model in model_docs
                if str(model.get("name") or "").strip().casefold() == selected_model_key
                and str(model.get("id") or "").strip()
            }

            assembly_docs = [
                data for data in assembly_docs
                if _matches_dashboard_model(data, selected_model, selected_model_ids)
            ]
            sale_docs = [
                data for data in sale_docs
                if _matches_dashboard_model(data, selected_model, selected_model_ids)
            ]
            customer_sale_docs = [
                data for data in customer_sale_docs
                if _matches_dashboard_model(data, selected_model, selected_model_ids)
            ]
            defect_docs = [
                data for data in defect_docs
                if _matches_dashboard_model(data, selected_model, selected_model_ids)
            ]
            po_docs = [
                data for data in po_docs
                if _matches_dashboard_model(data, selected_model, selected_model_ids)
            ]
            invoice_docs = [
                data for data in invoice_docs
                if _matches_dashboard_model(data, selected_model, selected_model_ids)
            ]
            if selected_model_ids:
                boq_docs = [
                    doc for doc in boq_docs
                    if doc.reference.parent.parent
                    and doc.reference.parent.parent.parent.parent.id in selected_model_ids
                ]
            else:
                boq_docs = []
            phase_plans = [
                phase for phase in phase_plans
                if _matches_dashboard_model(phase, selected_model, selected_model_ids)
            ]

        assembly_activity_docs = _activity_docs(assembly_docs, "assembly", user_scoped)
        qc_activity_docs = _activity_docs(assembly_docs, "qc", user_scoped)
        packaging_activity_docs = _activity_docs(assembly_docs, "packaging", user_scoped)

        # The KPI cards open Daily Production filtered to their bucket, so they
        # must count the same units that page lists.  For a regular user that is
        # every unit they assembled, QC'd or packed - one set for all cards,
        # rather than "assembled" for stage cards and "QC'd" for QC cards, which
        # never matched the list.  Managers see the whole register.  (The charts
        # below keep the per-activity split: they chart who did which work.)
        if user_scoped:
            kpi_docs = [
                unit for unit in assembly_docs
                if any(_assigned_to_current_user(unit, id_field, name_field)
                       for id_field, name_field in USER_ACTIVITY_FIELDS.values())
            ]
        else:
            kpi_docs = assembly_docs

        stage_totals = defaultdict(float)
        qc_passed = 0
        qc_failed = 0
        qc_inspection = 0
        packed = 0

        for unit in kpi_docs:
            quantity = _number(unit.get("qty"))
            stage_totals[unit.get("stage", "")] += quantity
        semi_finished = stage_totals["Semi Finished"]

        for unit in kpi_docs:
            quantity = _number(unit.get("qty"))
            qc = unit.get("qc", "")
            if qc == "Passed":
                qc_passed += quantity
            elif qc == "Failed":
                qc_failed += quantity
            elif qc in ("Under Inspection", "Pending"):
                qc_inspection += quantity

        for unit in kpi_docs:
            quantity = _number(unit.get("qty"))
            if unit.get("packagingStatus") == "Packed":
                packed += quantity

        # Sales are loaded for every role (stock needs them), but the money
        # figure stays with admin / coadmin - the page shows "Restricted" to
        # the others, so the number is not sent to them at all.
        sales_value = 0 if production_scoped else _unit_value_total(sale_docs)
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
        sold_serials = {serial.casefold() for serial in sold_serials}

        # Stock that is still physically available: units added to stock, minus
        # the ones already delivered. Counting the whole `qty` and not just the
        # document keeps a multi-unit record honest, and the floor at zero stops
        # a sale that was entered before its unit existed from showing negative.
        # Managers see stock company-wide.  A regular user's In Stock / Sold
        # cards open their own Daily Production list (Stock Status filter), so
        # they count the same units that list holds: every unit they assembled,
        # QC'd or packed - and "sold" there means dispatched or delivered.
        if user_scoped:
            for sale in dispatched_sales:
                sold_serials |= {serial.casefold() for serial in _sale_serials(sale)}
        in_stock_added = 0
        in_stock_sold = 0
        # Unsold QC-passed units split by packaging, so the dashboard can show
        # packed stock and QC-passed stock (packed or still pending) apart.
        in_stock_packed = 0
        in_stock_packing_pending = 0
        for unit in kpi_docs:
            quantity = _number(unit.get("qty"))
            # Same rule as Daily Production and Finished Goods: a unit is stock
            # once it passes QC, packed or not.
            if str(unit.get("qc") or "").strip().casefold() != "passed":
                continue
            in_stock_added += quantity
            if str(unit.get("serial") or "").strip().casefold() in sold_serials:
                in_stock_sold += quantity
            elif str(unit.get("packagingStatus") or "").strip().casefold() == "packed":
                in_stock_packed += quantity
            else:
                in_stock_packing_pending += quantity
        in_stock = max(0, in_stock_added - in_stock_sold)

        # Per-model QC and queue counts for the "First-pass yield by model"
        # and "Floor alerts" panels. Same units and rules as the cards above.
        floor_by_model = defaultdict(lambda: {"qcPassed": 0, "qcFailed": 0, "qcInspection": 0, "waitingForPacking": 0})
        for unit in kpi_docs:
            quantity = _number(unit.get("qty"))
            model = (unit.get("model") or "Unspecified").strip() or "Unspecified"
            qc = str(unit.get("qc") or "").strip()
            row = floor_by_model[model]
            if qc == "Passed":
                row["qcPassed"] += quantity
                if (
                    str(unit.get("serial") or "").strip().casefold() not in sold_serials
                    and str(unit.get("packagingStatus") or "").strip().casefold() != "packed"
                ):
                    row["waitingForPacking"] += quantity
            elif qc == "Failed":
                row["qcFailed"] += quantity
            elif qc in ("Under Inspection", "Pending"):
                row["qcInspection"] += quantity
        if user_scoped:
            units_sold = in_stock_sold
        locations = defaultdict(float)
        location_by_day = defaultdict(float)
        location_by_week = defaultdict(float)
        client_by_day = defaultdict(float)
        end_user_location_by_day = defaultdict(float)
        end_user_client_by_day = defaultdict(float)
        sales_by_month = defaultdict(float)
        sales_by_model_month = defaultdict(float)
        sales_by_model = defaultdict(
            lambda: {"units": 0, "deliveredUnits": 0, "salesValue": 0}
        )
        dispatched_by_model_month = defaultdict(float)
        dispatched_by_model_day = defaultdict(float)
        end_user_location_by_model_day = defaultdict(float)
        end_user_client_by_model_day = defaultdict(float)
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
        # Same counts split by model too, for the "by model" assembly chart.
        assembled_by_month_user_model = defaultdict(float)
        # QC and packaging per model too, for the "by model" charts.
        qc_by_month_status_user_model = defaultdict(float)
        packaged_by_month_status_user_model = defaultdict(float)
        qc_by_month_status = defaultdict(float)
        qc_by_month_status_user = defaultdict(float)
        packaged_by_month_status = defaultdict(float)
        packaged_by_month_status_user = defaultdict(float)
        # Day-level status splits. The monthly buckets above cannot answer "how
        # much in this date range", so these carry the same status/user detail
        # one day at a time for the analytics date filter.
        qc_by_day_status_user = defaultdict(float)
        packaged_by_day_status_user = defaultdict(float)
        qc_by_user_model_day = defaultdict(float)
        qc_by_user_model_week = defaultdict(float)
        # Day-wise series split by model, for the drill-down of the "by model"
        # charts (same dates and rules as the monthly series).
        sales_by_model_day = defaultdict(float)
        assembled_by_day_user_model = defaultdict(float)
        qc_by_day_status_user_model = defaultdict(float)
        packaged_by_day_status_user_model = defaultdict(float)
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
            sales_by_model_day[(period, model)] += quantity
            sales_by_model[model]["units"] += quantity
            if str(sale.get("dispatch") or "").strip().casefold() == "delivered":
                sales_by_model[model]["deliveredUnits"] += quantity
            if not production_scoped:
                sales_by_model[model]["salesValue"] += (
                    _number(sale.get("unitCost")) * quantity
                )

        for sale in dispatched_sales:
            location = (sale.get("location") or "Unspecified").strip() or "Unspecified"
            quantity = _number(sale.get("qty"))
            locations[location] += quantity
            location_by_day[(_packed_period(sale.get("date")), location)] += quantity
            location_by_week[(_packed_period(sale.get("date"), weekly=True), location)] += quantity
            client = (sale.get("client") or "Unspecified").strip() or "Unspecified"
            client_by_day[(_packed_period(sale.get("date")), client)] += quantity
            # End-customer series only: a sale without end-customer details is
            # left out rather than shown under the client's name or location.
            end_user_location = str(sale.get("endUserLocation") or "").strip()
            if end_user_location:
                end_user_location_by_day[(_packed_period(sale.get("date")), end_user_location)] += quantity
            end_user_client = str(sale.get("endUserClient") or "").strip()
            if end_user_client:
                end_user_client_by_day[(_packed_period(sale.get("date")), end_user_client)] += quantity
            period = _packed_period(sale.get("date"))
            sales_by_month[period[:7]] += quantity
            model = (sale.get("model") or "Unspecified").strip() or "Unspecified"
            dispatched_by_model_month[(period[:7], model)] += quantity
            dispatched_by_model_day[(period, model)] += quantity
            if end_user_location:
                end_user_location_by_model_day[(period, end_user_location, model)] += quantity
            if end_user_client:
                end_user_client_by_model_day[(period, end_user_client, model)] += quantity

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
            assembled_by_month_user_model[(month, assembled_user, model)] += quantity
            assembled_by_day_user_model[(period, assembled_user, model)] += quantity

        for unit in qc_activity_docs:
            period = _packed_period(unit.get("date"))
            month = period[:7] if period != "Undated" else period
            quantity = _number(unit.get("qty"))
            qc_status = str(unit.get("qc") or "").strip()
            if not _has_recorded_status(qc_status):
                continue
            qc_by_month_status[(month, qc_status)] += quantity
            qc_user = scoped_user_name or (unit.get("qcBy") or "Unassigned").strip() or "Unassigned"
            model = str(unit.get("model") or unit.get("modelName") or "").strip() or "Unspecified"
            qc_by_month_status_user[(month, qc_status, qc_user)] += quantity
            qc_by_month_status_user_model[(month, qc_status, qc_user, model)] += quantity
            qc_by_day_status_user[(period, qc_status, qc_user)] += quantity
            qc_by_day_status_user_model[(period, qc_status, qc_user, model)] += quantity
            if unit.get("qcBy") or unit.get("qcById"):
                # Counted on the day QC was done (older units: assembly date).
                qc_day = _event_period(unit, "qcAt")
                qc_week = _event_period(unit, "qcAt", weekly=True)
                qc_by_day[(qc_day, qc_user)] += quantity
                qc_by_week[(qc_week, qc_user)] += quantity
                qc_by_user_model_day[(qc_day, qc_user, model)] += quantity
                qc_by_user_model_week[(qc_week, qc_user, model)] += quantity

        for unit in packaging_activity_docs:
            period = _packed_period(unit.get("date"))
            month = period[:7] if period != "Undated" else period
            quantity = _number(unit.get("qty"))
            model = (unit.get("model") or "Unspecified").strip() or "Unspecified"
            packaging_status = str(unit.get("packagingStatus") or "").strip()
            if not _has_recorded_status(packaging_status):
                continue
            packaged_by_month_status[(month, packaging_status)] += quantity
            packaged_user = scoped_user_name or (unit.get("packagedBy") or "Unassigned").strip() or "Unassigned"
            packaged_by_month_status_user[(month, packaging_status, packaged_user)] += quantity
            packaged_by_month_status_user_model[(month, packaging_status, packaged_user, model)] += quantity
            packaged_by_day_status_user[(period, packaging_status, packaged_user)] += quantity
            packaged_by_day_status_user_model[(period, packaging_status, packaged_user, model)] += quantity
            if unit.get("packagingStatus") == "Packed":
                packed_by_day[( _packed_period(unit.get("date")), model)] += quantity
                packed_by_week[(_packed_period(unit.get("date"), weekly=True), model)] += quantity
                # Counted on the day it was packed. Units packed before
                # `packagedAt` existed use their last update, which is what the
                # Finished Goods "Packaged Date" shows, then the assembly date.
                packaged_by_user_day[(_event_period(unit, "packagedAt", fallbacks=("updatedAt", "date")), packaged_user)] += quantity
                packaged_by_user_week[(_event_period(unit, "packagedAt", weekly=True, fallbacks=("updatedAt", "date")), packaged_user)] += quantity

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
                "inStockPacked": _display_number(in_stock_packed),
                "inStockPackingPending": _display_number(in_stock_packing_pending),
                "sold": _display_number(units_sold),
                "salesValue": sales_value,
                "defects": len(defect_docs),
                "reorder": reorder_count,
            },
            "qualityPassRate": quality_pass_rate,
            # Distinct end-customer cities, ignoring case and spacing so
            # "mumbai" and "Mumbai" count once (matches the dashboard card).
            "dispatchLocationCount": len({" ".join(loc.split()).casefold() for (_, loc) in end_user_location_by_day.keys() if loc != "Unspecified"}),
            "modelNames": sorted(all_model_names, key=str.casefold),
            "completedByModel": completed_by_model,
            "floorByModel": [
                {"model": model, **{key: _display_number(value) for key, value in counts.items()}}
                for model, counts in sorted(floor_by_model.items(), key=lambda item: item[0].casefold())
            ],
            "phaseRoadmap": _phase_roadmap_data(
                phase_plans, kpi_docs if user_scoped else assembly_docs
            ),
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
            "salesByModel": [
                {
                    "model": model,
                    "units": _display_number(totals["units"]),
                    "deliveredUnits": _display_number(totals["deliveredUnits"]),
                    **({"salesValue": _display_number(totals["salesValue"])} if not production_scoped else {}),
                }
                for model, totals in sorted(sales_by_model.items(), key=lambda item: item[0].casefold())
            ],
            "dispatchedByModelMonth": [
                {"period": period, "model": model, "units": _display_number(units)}
                for (period, model), units in sorted(dispatched_by_model_month.items())
            ],
            "dispatchedByModelDay": [
                {"period": period, "model": model, "units": _display_number(units)}
                for (period, model), units in sorted(dispatched_by_model_day.items())
            ],
            "endUserLocationByModelDay": [
                {"period": period, "location": location, "model": model, "units": _display_number(units)}
                for (period, location, model), units in sorted(end_user_location_by_model_day.items())
            ],
            "endUserClientByModelDay": [
                {"period": period, "client": client, "model": model, "units": _display_number(units)}
                for (period, client, model), units in sorted(end_user_client_by_model_day.items())
            ],
            "productionByModel": [
                {"model": model, "units": _display_number(units)}
                for model, units in sorted(production_by_model.items(), key=lambda item: (-item[1], item[0].lower()))
            ],
            "assembledByMonth": [
                {"period": period, "units": _display_number(units)}
                for period, units in sorted(assembled_by_month.items())
            ],
            "qcByMonthStatusUserModel": [
                {"period": period, "status": status, "user": user, "model": model, "units": _display_number(units)}
                for (period, status, user, model), units in sorted(qc_by_month_status_user_model.items())
            ],
            "packagedByMonthStatusUserModel": [
                {"period": period, "status": status, "user": user, "model": model, "units": _display_number(units)}
                for (period, status, user, model), units in sorted(packaged_by_month_status_user_model.items())
            ],
            "assembledByMonthUserModel": [
                {"period": period, "user": user, "model": model, "units": _display_number(units)}
                for (period, user, model), units in sorted(assembled_by_month_user_model.items())
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
            "assembledByDayUserModel": [
                {"period": period, "user": user, "model": model, "units": _display_number(units)}
                for (period, user, model), units in sorted(assembled_by_day_user_model.items())
            ],
            "qcByDayStatusUserModel": [
                {"period": period, "status": status, "user": user, "model": model, "units": _display_number(units)}
                for (period, status, user, model), units in sorted(qc_by_day_status_user_model.items())
            ],
            "packagedByDayStatusUserModel": [
                {"period": period, "status": status, "user": user, "model": model, "units": _display_number(units)}
                for (period, status, user, model), units in sorted(packaged_by_day_status_user_model.items())
            ],
            "salesByModelDay": [
                {"period": period, "model": model, "units": _display_number(units)}
                for (period, model), units in sorted(sales_by_model_day.items())
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
            "qcByUserModelDay": [
                {"period": period, "user": user, "model": model, "units": _display_number(units)}
                for (period, user, model), units in sorted(qc_by_user_model_day.items())
            ],
            "qcByUserModelWeek": [
                {"period": period, "user": user, "model": model, "units": _display_number(units)}
                for (period, user, model), units in sorted(qc_by_user_model_week.items())
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
            "defectivePartsByModel": _defective_parts_by_model(defect_docs),
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to build dashboard: {exc}"}), 500

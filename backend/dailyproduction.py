from datetime import datetime, timezone
import math
import re
 
from flask import Blueprint, request, jsonify
from firebase_config import db, users_collection
from auth_utils import roles_required
from read_cache import cached_read, invalidate_read_cache
from date_range import in_date_range, read_date_range
 
dailyproduction_bp = Blueprint("dailyproduction", __name__)
assembly_collection = db.collection("assembly_units")
sales_collection = db.collection("sale_register")
 
REQUIRED_FIELDS = [
    "modelId", "phaseId", "stage", "assembledBy", "serial", "date", "qty",
]
DEFAULT_PAGE_SIZE = 10
MAX_PAGE_SIZE = 100

# Fields the status cards filter on. A card count ignores these so the cards do
# not zero each other out; every other filter still narrows them.
_CARD_FILTER_FIELDS = frozenset({"stage", "qc"})
 
# Everything the dailyproduction Production (Assembly) form submits.
ALLOWED_FIELDS = [
    "modelId", "model", "phaseId", "phase", "stage", "assembledBy", "assembledById",
    "serial", "date", "qty", "remarks", "qc", "qcBy", "qcById",
    "packagingStatus", "packagedBy", "packagedById", "qcInspection",
    "qcFailureHistory",
]

QC_INSPECTION_REQUIRED_CHECKS = (
    "acVoltage230V", "outputLow170V", "outputHigh250V", "frequency50Hz",
    "ledInputOn", "ledOutputOn", "ledOutputLow", "ledOutputHigh",
    "inputFuse10A", "frontPanelLcd", "parameterLeds", "loadRun",
    "individualPort", "schedulingOutlets", "cutoffAlert", "temperatureAlert",
    "wattageLogs", "deviceDiscovery",
)

MANAGER_ROLES = ("admin", "coadmin", "production_incharge")
ALL_PRODUCTION_ROLES = (*MANAGER_ROLES, "user")
# Roles that can be assigned to assembly/QC/packaging fields on a unit.
ASSIGNABLE_ROLES = ("user", "production_incharge")
USER_STATUS_FIELDS = {
    "stage": ("assembledById", "assembledBy"),
    "qc": ("qcById", "qcBy"),
    "packagingStatus": ("packagedById", "packagedBy"),
}


def _status_card_totals(entries):
    """Quantity per production/QC bucket, for the page's status cards.

    Mirrors the dashboard KPI arithmetic in `_sales_dashboard_data`: whole `qty`
    rather than a document count, `Semi Finished` read off the stage totals, and
    both "Under Inspection" and "Pending" treated as awaiting a QC decision.
    """
    in_production = 0.0
    semi_finished = 0.0
    qc_passed = 0.0
    qc_failed = 0.0
    qc_inspection = 0.0

    for entry in entries:
        row = entry["row"]
        try:
            quantity = float(row.get("qty") or 0)
        except (TypeError, ValueError):
            quantity = 0.0
        stage = str(row.get("stage") or "").strip()
        if stage == "In Production":
            in_production += quantity
        elif stage == "Semi Finished":
            semi_finished += quantity
        qc = str(row.get("qc") or "").strip()
        if qc == "Passed":
            qc_passed += quantity
        elif qc == "Failed":
            qc_failed += quantity
        elif qc in ("Under Inspection", "Pending"):
            qc_inspection += quantity

    return {
        "inProduction": in_production,
        "semiFinished": semi_finished,
        "qcPassed": qc_passed,
        "qcFailed": qc_failed,
        "qcInspection": qc_inspection,
    }


def _stock_status(data, sale_status_by_serial=None):
    """Mirror the Daily_Production Stock Status formula in the workbook."""
    if data.get("qc") != "Passed":
        return ""

    dispatch_status = str((sale_status_by_serial or {}).get(data.get("serial", ""), "")).strip().casefold()
    if dispatch_status in {"dispatched", "delivered"}:
        return "Dispatched"
    if dispatch_status == "demo":
        return "Demo"
    return "In Stock"


def _qc_inspection_is_complete(report):
    """A QC pass is valid only after the report header and every check pass."""
    if not isinstance(report, dict):
        return False
    if not all(str(report.get(field, "")).strip() for field in
               ("inspectionDate", "checkedBy", "verifiedBy")):
        return False
    checks = report.get("checks")
    if not isinstance(checks, dict):
        return False
    return all(checks.get(key) == "Passed" for key in QC_INSPECTION_REQUIRED_CHECKS)


def _qc_inspection_is_filled(report):
    """A failed attempt is auditable only when its header and all checks are filled."""
    if not isinstance(report, dict):
        return False
    if not all(str(report.get(field, "")).strip() for field in
               ("inspectionDate", "checkedBy", "verifiedBy")):
        return False
    checks = report.get("checks")
    if not isinstance(checks, dict):
        return False
    return all(checks.get(key) in ("Passed", "Failed") for key in QC_INSPECTION_REQUIRED_CHECKS)


def _serialize_qc_failure_history(history):
    if not isinstance(history, list):
        return []
    serialized = []
    for raw_entry in history:
        if not isinstance(raw_entry, dict):
            continue
        entry = dict(raw_entry)
        failed_at = entry.get("failedAt")
        if hasattr(failed_at, "isoformat"):
            entry["failedAt"] = failed_at.isoformat()
        failed_checks = entry.get("failedChecks")
        entry["failedChecks"] = [
            key for key in failed_checks
            if key in QC_INSPECTION_REQUIRED_CHECKS
        ] if isinstance(failed_checks, list) else []
        checks = entry.get("checks")
        entry["checks"] = {
            key: status for key, status in checks.items()
            if key in QC_INSPECTION_REQUIRED_CHECKS and status in ("Passed", "Failed")
        } if isinstance(checks, dict) else {}
        serialized.append(entry)
    return serialized


def _sale_statuses_by_serial(docs):
    """Choose the most advanced sale state when legacy duplicate records exist."""
    priority = {"": 0, "cancelled": 0, "pending": 1, "processing": 2, "demo": 3,
                "dispatched": 4, "delivered": 5}
    statuses = {}
    for sale in docs:
        data = sale.to_dict() or {}
        serials = data.get("serialNumbers")
        if not isinstance(serials, list):
            serials = [value.strip() for value in str(data.get("serial", "")).split(",") if value.strip()]
        status = str(data.get("dispatch", "")).strip()
        for serial in serials:
            current = statuses.get(serial, "")
            if priority.get(status.casefold(), 0) >= priority.get(str(current).casefold(), 0):
                statuses[serial] = status
    return statuses


def _sale_statuses_for_serials(serials):
    """Fetch sale status only for the assembly rows displayed on this page.

    Reading the whole sale register for every Production page was increasingly
    expensive as the register grew.  Firestore supports up to 30 values for
    these queries, so chunk the page's serials and merge legacy ``serial`` and
    current ``serialNumbers`` records.
    """
    serials = list({str(serial or "").strip() for serial in serials if str(serial or "").strip()})
    if not serials:
        return {}

    docs_by_id = {}
    for start in range(0, len(serials), 30):
        batch = serials[start:start + 30]
        for doc in sales_collection.where("serial", "in", batch).stream():
            docs_by_id[doc.id] = doc
        for doc in sales_collection.where("serialNumbers", "array_contains_any", batch).stream():
            docs_by_id[doc.id] = doc
    return _sale_statuses_by_serial(docs_by_id.values())


def _serialize(doc, sale_status_by_serial=None):
    d = doc.to_dict()
    return {
        "id": doc.id,
        "modelId": d.get("modelId", ""),
        "model": d.get("model", ""),
        "phaseId": d.get("phaseId", ""),
        "phase": d.get("phase", ""),
        "stage": d.get("stage", ""),
        "assembledBy": d.get("assembledBy", ""),
        "assembledById": d.get("assembledById", ""),
        "serial": d.get("serial", ""),
        "date": d.get("date", ""),
        "qty": d.get("qty", 0),
        "remarks": d.get("remarks", ""),
        "qc": d.get("qc", ""),
        "qcBy": d.get("qcBy", ""),
        "qcById": d.get("qcById", ""),
        "packagingStatus": d.get("packagingStatus", ""),
        "packagedBy": d.get("packagedBy", ""),
        "packagedById": d.get("packagedById", ""),
        "qcInspection": d.get("qcInspection", {}),
        "qcFailureHistory": _serialize_qc_failure_history(d.get("qcFailureHistory", [])),
        "qcInspectionComplete": _qc_inspection_is_complete(d.get("qcInspection")),
        "stockStatus": _stock_status(d, sale_status_by_serial),
        "createdAt": d.get("createdAt").isoformat() if d.get("createdAt") else None,
        "updatedAt": d.get("updatedAt").isoformat() if d.get("updatedAt") else None,
    }


def _assigned_to_current_user(data, id_field, name_field):
    """Use immutable account IDs when present; support legacy name-only rows."""
    assigned_id = str(data.get(id_field) or "").strip()
    current_id = str(request.user.get("sub") or "").strip()
    if assigned_id:
        return bool(current_id and assigned_id == current_id)
    assigned_name = str(data.get(name_field) or "").strip().casefold()
    current_name = str(request.user.get("name") or "").strip().casefold()
    return bool(assigned_name and current_name and assigned_name == current_name)


def _is_visible_to_current_user(data):
    return any(
        _assigned_to_current_user(data, id_field, name_field)
        for id_field, name_field in USER_STATUS_FIELDS.values()
    )
 
 
def _coerce_qty(value, fallback=0):
    """Best-effort conversion of qty to a number; raises ValueError on bad input."""
    return float(value) if str(value).strip() != "" else fallback


# Columns scanned by the UI's free-text search box (mirrors `columns` in
# DailyProduction.jsx).  Values are stringified exactly like the client does.
_SEARCH_KEYS = ("date", "phase", "model", "qty", "serial", "stage",
                "assembledBy", "qc", "qcBy", "packagingStatus",
                "packagedBy", "remarks", "stockStatus")

# Fields the PageFilter dropdown offers (mirrors PRODUCTION_FILTER_FIELDS).
_FILTER_FIELDS = frozenset({
    "model", "phase", "stage", "assembledBy", "qc", "qcBy",
    "packagingStatus", "packagedBy", "stockStatus",
})

# Date columns the toolbar range may target. Keeps a hand-written `dateField`
# from probing fields the endpoint does not expose.
_DATE_COLUMNS = frozenset({"date"})


def _text(value):
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return "" if value is None else str(value).strip()


def _date_sort_value(value):
    """One comparable form of a stored production date.

    A date reaches the register either as a Firestore timestamp or as a
    `YYYY-MM-DD` string, and a unit can also carry a full ISO timestamp, so all
    three are reduced to `YYYYMMDDhhmmss`.  An unreadable or missing date
    returns `None` and the unit sinks to the bottom of the list.
    """
    if hasattr(value, "isoformat"):
        value = value.isoformat()
    match = re.match(
        r"^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})?)?",
        str(value or "").strip(),
    )
    if not match:
        return None
    year, month, day, hour, minute, second = match.groups()
    return f"{year}{month}{day}{hour or '00'}{minute or '00'}{(second or '00')[:2]}"


def _toolbar_entry(doc):
    """The stored fields the toolbar can search or filter on.

    `stockStatus` is filled in by the caller because it is derived from the sale
    register rather than stored; the raw document is kept so it can be derived
    without a second `to_dict()` call.
    """
    data = doc.to_dict() or {}
    return {
        "doc": doc,
        "data": data,
        "row": {
            "date": data.get("date", ""),
            "phase": data.get("phase", ""),
            "model": data.get("model", ""),
            "qty": data.get("qty", 0),
            "serial": data.get("serial", ""),
            "stage": data.get("stage", ""),
            "assembledBy": data.get("assembledBy", ""),
            "qc": data.get("qc", ""),
            "qcBy": data.get("qcBy", ""),
            "packagingStatus": data.get("packagingStatus", ""),
            "packagedBy": data.get("packagedBy", ""),
            "remarks": data.get("remarks", ""),
            "stockStatus": "",
        },
    }


def _matches(row, search, filters):
    """True when a unit passes the active search + PageFilter selection.

    Values compare case-insensitively so `pending` / `Pending` behave the same
    on both sides of the app.
    """
    if search and not any(search in _text(row.get(key)).lower() for key in _SEARCH_KEYS):
        return False
    for field, value in filters:
        cell = _text(row.get(field)).lower()
        # "Under Inspection" is the "awaiting a QC decision" bucket: the status
        # cards and dashboard KPI count Pending units in it too, so the list a
        # card opens has to include them or it shows fewer units than the card.
        if field == "qc" and value.lower() == "under inspection":
            if cell not in ("under inspection", "pending"):
                return False
            continue
        if cell != value.lower():
            return False
    return True


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


@dailyproduction_bp.route("/production-users", methods=["GET"])
@roles_required(*MANAGER_ROLES)
@cached_read("production-users", ttl_seconds=300)
def list_production_users():
    """Return safe user display names for production assignment dropdowns."""
    try:
        users = []
        for doc in users_collection.stream():
            data = doc.to_dict() or {}
            # Match Manage Users: legacy accounts without a role are users.
            role = str(data.get("role", "user") or "user").strip().lower()
            if role not in ASSIGNABLE_ROLES:
                continue
            name = str(data.get("name") or "").strip()
            if name:
                users.append({"id": doc.id, "name": name})
        users.sort(key=lambda item: item["name"].casefold())
        return jsonify({"success": True, "users": users}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch production users: {exc}"}), 500
 
 
def _existing_serials(serials, exclude_id=None):
    """Serials from ``serials`` that another assembly unit already uses.

    A serial identifies one physical device, so it may be recorded only once.
    Firestore matches exactly, so the as-typed, upper and lower spellings are
    all queried and compared case-insensitively.
    """
    wanted = {str(serial or "").strip().casefold() for serial in serials if str(serial or "").strip()}
    variants = sorted({
        variant
        for serial in serials if str(serial or "").strip()
        for variant in (str(serial).strip(), str(serial).strip().upper(), str(serial).strip().lower())
    })
    taken = set()
    for start in range(0, len(variants), 30):
        for doc in assembly_collection.where("serial", "in", variants[start:start + 30]).stream():
            if doc.id == exclude_id:
                continue
            value = str((doc.to_dict() or {}).get("serial", "")).strip()
            if value.casefold() in wanted:
                taken.add(value)
    return sorted(taken, key=str.casefold)


@dailyproduction_bp.route("/assembly", methods=["POST"])
@roles_required(*MANAGER_ROLES)
def create_assembly_unit():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400
 
    missing = [f for f in REQUIRED_FIELDS if not str(data.get(f, "")).strip()]
    if missing:
        return jsonify({"success": False, "message": f"Missing required fields: {', '.join(missing)}"}), 400
 
    try:
        qty = _coerce_qty(data.get("qty", 0))
    except (ValueError, TypeError):
        return jsonify({"success": False, "message": "Quantity must be a valid number"}), 400
    if qty <= 0:
        return jsonify({"success": False, "message": "Quantity must be greater than zero"}), 400
    if not float(qty).is_integer():
        return jsonify({"success": False, "message": "Quantity must be a whole number"}), 400

    serial_numbers = data.get("serialNumbers")
    if not isinstance(serial_numbers, list):
        serial_numbers = [data.get("serial", "")]
    serial_numbers = [str(serial or "").strip() for serial in serial_numbers]
    if len(serial_numbers) != int(qty) or any(not serial for serial in serial_numbers):
        return jsonify({"success": False, "message": f"Please provide {int(qty)} serial number(s)"}), 400
    if len({serial.lower() for serial in serial_numbers}) != len(serial_numbers):
        return jsonify({"success": False, "message": "Duplicate serial numbers are not allowed"}), 400
    taken = _existing_serials(serial_numbers)
    if taken:
        return jsonify({
            "success": False,
            "message": f"Serial number already exists: {', '.join(taken)}",
        }), 409

    if data.get("qc") and data.get("stage") != "Completed":
        return jsonify({
            "success": False,
            "message": "Complete assembly before updating QC",
        }), 400
    if data.get("qc") == "Passed" and not _qc_inspection_is_complete(data.get("qcInspection")):
        return jsonify({
            "success": False,
            "message": "Complete every QC inspection field before marking QC as Passed",
        }), 400
    if data.get("packagingStatus") and (
        data.get("qc") != "Passed" or not _qc_inspection_is_complete(data.get("qcInspection"))
    ):
        return jsonify({
            "success": False,
            "message": "Complete and pass the QC inspection before updating packaging",
        }), 400
 
    try:
        created_at = datetime.now(timezone.utc)
        created_units = []
        # One assembler per serial number: the person who completed that unit.
        assembled_by_map = data.get("assembledByMap")
        if not isinstance(assembled_by_map, dict):
            assembled_by_map = {}
        for serial in serial_numbers:
            doc_ref = assembly_collection.document()
            record = {k: data.get(k, "") for k in ALLOWED_FIELDS}
            record["qcFailureHistory"] = (
                data.get("qcFailureHistory")
                if isinstance(data.get("qcFailureHistory"), list)
                else []
            )
            entry = assembled_by_map.get(serial) or assembled_by_map.get(str(serial).strip()) or {}
            if isinstance(entry, dict):
                if entry.get("assembledBy"):
                    record["assembledBy"] = entry["assembledBy"]
                if entry.get("assembledById"):
                    record["assembledById"] = entry["assembledById"]
            record["serial"] = serial
            record["qty"] = 1
            record["createdAt"] = created_at
            record["updatedAt"] = created_at
            # When QC / packaging happened, so the dashboard's per-user activity
            # can be filtered by that day rather than the assembly date.
            record["qcAt"] = created_at if record.get("qc") else None
            record["packagedAt"] = created_at if record.get("packagingStatus") == "Packed" else None
            doc_ref.set(record)
            created_units.append({
                "id": doc_ref.id,
                **{k: record[k] for k in record if k not in ("createdAt", "updatedAt", "qcAt", "packagedAt")},
                "createdAt": created_at.isoformat(),
                "updatedAt": created_at.isoformat(),
            })
 
        # Stock is derived from these units, so drop the cached stock pages -
        # otherwise the register keeps showing the pre-assembly closing stock
        # for up to the 120s cache TTL.
        invalidate_read_cache()

        return jsonify({
            "success": True,
            "message": f"{len(created_units)} Assembly Unit(s) saved successfully",
            "assemblyUnits": created_units,
        }), 201
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to create Assembly Unit: {exc}"}), 500
 
 
@dailyproduction_bp.route("/assembly", methods=["GET"])
@roles_required(*ALL_PRODUCTION_ROLES)
@cached_read("assembly", ttl_seconds=120)
def list_assembly_units():
    """Paged assembly units, scoped by the toolbar's search and PageFilter.

    Supports `?page=&limit=` plus `?q=<text>&filterField=<key>&filterValue=<value>`
    (the filter params may repeat).  Firestore pages by offset and cannot express
    a substring search, so the filters are applied here over every unit the
    caller may see *before* the page is cut - previously the browser filtered
    only the rows the API had just returned, so a search matched one page at a
    time.  `pagination.totalCount` always covers every matching unit.

    Rows come back newest production date first.  This is the only page that
    reads `/assembly`, so the ordering is a Daily Production table change only.
    """
    try:
        page, limit = _parse_pagination_params(request.args)

        search = (request.args.get("q") or "").strip().lower()
        filters = []
        for raw_field, raw_value in zip(request.args.getlist("filterField"),
                                        request.args.getlist("filterValue")):
            field = (raw_field or "").strip()
            if field in _FILTER_FIELDS:
                filters.append((field, str(raw_value or "")))

        # Inclusive range on the production date (`?dateField=date&filterField=
        # dateFrom&filterValue=...&filterField=dateTo&filterValue=...`).
        date_field, date_from, date_to = read_date_range(request.args, default_field="date")
        if date_field not in _DATE_COLUMNS:
            date_field = "date"

        base_query = assembly_collection.order_by("createdAt", direction="DESCENDING")
        docs = list(base_query.stream())
        if request.user.get("role") == "user":
            # Legacy assignment fields require a compatibility filter in Python.
            docs = [doc for doc in docs if _is_visible_to_current_user(doc.to_dict() or {})]

        entries = [_toolbar_entry(doc) for doc in docs]

        # `stockStatus` is derived from the sale register and is non-empty only
        # for QC-passed units, so those are the only serials worth looking up.
        # The result is reused for both filtering and the page's own rows, which
        # keeps this to the same lookup the endpoint already made per page.
        sale_status_by_serial = _sale_statuses_for_serials(
            entry["row"]["serial"] for entry in entries if entry["row"]["qc"] == "Passed"
        )
        for entry in entries:
            entry["row"]["stockStatus"] = _stock_status(entry["data"], sale_status_by_serial)

        matched = [
            entry for entry in entries
            if in_date_range(entry["row"].get(date_field), date_from, date_to)
            and _matches(entry["row"], search, filters)
        ]

        # Counts for the page's status cards. They honour the search and the date
        # range, but deliberately ignore `stage` and `qc`: those are the fields
        # the cards filter on, so counting them here would make every other card
        # collapse to zero as soon as one card is active. The buckets and the
        # spelling match the dashboard KPI cards, so the two pages agree.
        card_filters = [(f, v) for f, v in filters if f not in _CARD_FILTER_FIELDS]
        card_scope = [
            entry for entry in entries
            if in_date_range(entry["row"].get(date_field), date_from, date_to)
            and _matches(entry["row"], search, card_filters)
        ]
        summary = _status_card_totals(card_scope)

        # Production is read as a diary: the newest production date leads, not
        # whichever unit happens to have been entered last.  Undated units sit
        # at the bottom instead of jumping to the top.
        matched.sort(
            key=lambda entry: _date_sort_value(entry["data"].get("date")) or "",
            reverse=True,
        )

        # Distinct values per filterable field over every visible unit, so the
        # PageFilter dropdown never loses options while a filter is active.
        filter_options = {
            key: sorted({_text(entry["row"].get(key)) for entry in entries
                         if _text(entry["row"].get(key))},
                        key=str.lower)
            for key in sorted(_FILTER_FIELDS)
        }

        total_count = len(matched)
        total_pages = max(1, math.ceil(total_count / limit))
        page = min(page, total_pages)
        page_entries = matched[(page - 1) * limit:page * limit]

        return jsonify({
            "success": True,
            "assemblyUnits": [_serialize(entry["doc"], sale_status_by_serial) for entry in page_entries],
            # Every unit the active search/filters/date range matched, so the
            # table's export covers the whole result set and not just the page.
            "allRows": [_serialize(entry["doc"], sale_status_by_serial) for entry in matched],
            "filterOptions": filter_options,
            "summary": summary,
            "pagination": {"page": page, "limit": limit, "totalCount": total_count,
                           "totalPages": total_pages, "hasNextPage": page < total_pages,
                           "hasPrevPage": page > 1},
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch Assembly Units: {exc}"}), 500
 
 
@dailyproduction_bp.route("/assembly/<unit_id>", methods=["GET"])
@roles_required(*ALL_PRODUCTION_ROLES)
def get_assembly_unit(unit_id):
    try:
        doc = assembly_collection.document(unit_id).get()
        if not doc.exists:
            return jsonify({"success": False, "message": "Assembly Unit not found"}), 404
        data = doc.to_dict() or {}
        if request.user.get("role") == "user" and not _is_visible_to_current_user(data):
            return jsonify({"success": False, "message": "This task is not assigned to you"}), 403
        sale_status_by_serial = _sale_statuses_by_serial(
            sales_collection.where("serial", "==", data.get("serial", "")).stream()
        )
        return jsonify({"success": True, "assemblyUnit": _serialize(doc, sale_status_by_serial)}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch Assembly Unit: {exc}"}), 500
 
 
@dailyproduction_bp.route("/assembly/<unit_id>", methods=["PUT"])
@roles_required(*ALL_PRODUCTION_ROLES)
def update_assembly_unit(unit_id):
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400
 
    update_fields = {k: v for k, v in data.items() if k in ALLOWED_FIELDS}
    if not update_fields:
        return jsonify({"success": False, "message": "Nothing to update"}), 400
 
    doc_ref = assembly_collection.document(unit_id)
    existing_doc = doc_ref.get()
    if not existing_doc.exists:
        return jsonify({"success": False, "message": "Assembly Unit not found"}), 404

    existing_data = existing_doc.to_dict() or {}
    if request.user.get("role") == "user":
        requested_fields = set(data).intersection(ALLOWED_FIELDS)
        invalid_fields = requested_fields.difference((*USER_STATUS_FIELDS.keys(), "qcInspection"))
        if invalid_fields:
            return jsonify({
                "success": False,
                "message": "Users can update only the status of a task assigned to them",
            }), 403
        if not requested_fields:
            return jsonify({"success": False, "message": "Nothing to update"}), 400
        if "qcInspection" in requested_fields and not (
            data.get("qc") == "Passed" and "qc" in requested_fields
        ):
            return jsonify({
                "success": False,
                "message": "The QC report must be submitted together with a Passed QC status",
            }), 400
        for field in requested_fields.difference({"qcInspection"}):
            id_field, name_field = USER_STATUS_FIELDS[field]
            if not _assigned_to_current_user(existing_data, id_field, name_field):
                return jsonify({"success": False, "message": "This task is not assigned to you"}), 403

    if "serial" in update_fields:
        update_fields["serial"] = str(update_fields["serial"] or "").strip()
        if update_fields["serial"].casefold() != str(existing_data.get("serial", "")).strip().casefold():
            taken = _existing_serials([update_fields["serial"]], exclude_id=unit_id)
            if taken:
                return jsonify({
                    "success": False,
                    "message": f"Serial number already exists: {', '.join(taken)}",
                }), 409

    candidate = {**existing_data, **update_fields}
    if update_fields.get("qc") and candidate.get("stage") != "Completed":
        return jsonify({"success": False, "message": "Complete assembly before updating QC"}), 400
    if "qc" in update_fields and update_fields["qc"] == "Passed" and not _qc_inspection_is_complete(
        candidate.get("qcInspection")
    ):
        return jsonify({
            "success": False,
            "message": "Complete every QC inspection field before marking QC as Passed",
        }), 400
    if (
        update_fields.get("qcInspection")
        and not _qc_inspection_is_complete(candidate.get("qcInspection"))
    ):
        return jsonify({"success": False, "message": "The QC inspection report is incomplete"}), 400
    if "packagingStatus" in update_fields and update_fields["packagingStatus"] and (
        candidate.get("qc") != "Passed" or not _qc_inspection_is_complete(candidate.get("qcInspection"))
    ):
        return jsonify({
            "success": False,
            "message": "Complete and pass the QC inspection before updating packaging",
        }), 400
    if "stage" in update_fields and update_fields["stage"] != "Completed":
        update_fields.update({
            "qc": "",
            "qcBy": "",
            "qcById": "",
            "qcInspection": {},
            "packagingStatus": "",
            "packagedBy": "",
            "packagedById": "",
        })
    if "qc" in update_fields and update_fields["qc"] != "Passed":
        update_fields.update({
            "qcInspection": {},
            "packagingStatus": "",
            "packagedBy": "",
            "packagedById": "",
        })

    # Stamp the moment QC was decided and the unit was packed (cleared when
    # they are reset), so per-user activity reports the day the work was done.
    now = datetime.now(timezone.utc)
    if "qc" in update_fields:
        new_qc = str(update_fields["qc"] or "").strip()
        if not new_qc:
            update_fields["qcAt"] = None
        elif new_qc != str(existing_data.get("qc") or "").strip():
            update_fields["qcAt"] = now
    if "packagingStatus" in update_fields:
        if update_fields["packagingStatus"] != "Packed":
            update_fields["packagedAt"] = None
        elif existing_data.get("packagingStatus") != "Packed":
            update_fields["packagedAt"] = now

    merged_data = {**existing_data, **update_fields}
    missing = [field for field in REQUIRED_FIELDS if not str(merged_data.get(field, "")).strip()]
    if missing:
        return jsonify({"success": False, "message": f"Missing required fields: {', '.join(missing)}"}), 400
 
    if "qty" in update_fields:
        try:
            existing = existing_doc.to_dict()
            update_fields["qty"] = _coerce_qty(update_fields["qty"], existing.get("qty", 0))
        except (ValueError, TypeError):
            return jsonify({"success": False, "message": "Quantity must be a valid number"}), 400
        if update_fields["qty"] <= 0:
            return jsonify({"success": False, "message": "Quantity must be greater than zero"}), 400
 
    try:
        update_fields["updatedAt"] = now
        doc_ref.update(update_fields)
        updated_doc = doc_ref.get()
        return jsonify({
            "success": True,
            "message": "Assembly Unit updated",
            "assemblyUnit": _serialize(updated_doc),
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to update Assembly Unit: {exc}"}), 500
 
 
@dailyproduction_bp.route("/assembly/<unit_id>/qc-failures", methods=["POST"])
@roles_required(*ALL_PRODUCTION_ROLES)
def append_qc_failure(unit_id):
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    report = data.get("qcInspection")
    if not _qc_inspection_is_filled(report):
        return jsonify({
            "success": False,
            "message": "Fill every QC inspection field before saving the failure log",
        }), 400

    failed_checks = [
        key for key in QC_INSPECTION_REQUIRED_CHECKS
        if report.get("checks", {}).get(key) == "Failed"
    ]
    if not failed_checks:
        return jsonify({
            "success": False,
            "message": "A failure log must contain at least one failed QC check",
        }), 400

    doc_ref = assembly_collection.document(unit_id)
    existing_doc = doc_ref.get()
    if not existing_doc.exists:
        return jsonify({"success": False, "message": "Assembly Unit not found"}), 404

    existing_data = existing_doc.to_dict() or {}
    if existing_data.get("stage") != "Completed":
        return jsonify({"success": False, "message": "Complete assembly before updating QC"}), 400
    if request.user.get("role") == "user" and not _assigned_to_current_user(
        existing_data, "qcById", "qcBy"
    ):
        return jsonify({"success": False, "message": "This QC task is not assigned to you"}), 403

    failed_at = datetime.now(timezone.utc)
    failure_entry = {
        "id": failed_at.isoformat(),
        "failedAt": failed_at,
        "inspectionDate": str(report.get("inspectionDate", "")).strip(),
        "checkedBy": str(report.get("checkedBy", "")).strip(),
        "verifiedBy": str(report.get("verifiedBy", "")).strip(),
        "authorizedBy": str(report.get("authorizedBy", "")).strip(),
        "failedChecks": failed_checks,
        "checks": {
            key: report.get("checks", {}).get(key)
            for key in QC_INSPECTION_REQUIRED_CHECKS
        },
    }
    history = existing_data.get("qcFailureHistory")
    if not isinstance(history, list):
        history = []
    history = [*history, failure_entry]

    try:
        doc_ref.update({
            "qc": "Failed",
            "qcAt": failed_at,
            "qcInspection": {},
            "qcFailureHistory": history,
            "packagingStatus": "",
            "packagedBy": "",
            "packagedById": "",
            "packagedAt": None,
            "updatedAt": failed_at,
        })
        updated_doc = doc_ref.get()
        return jsonify({
            "success": True,
            "message": "QC failure logged",
            "assemblyUnit": _serialize(updated_doc),
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to save QC failure: {exc}"}), 500


@dailyproduction_bp.route("/assembly/<unit_id>", methods=["DELETE"])
@roles_required(*MANAGER_ROLES)
def delete_assembly_unit(unit_id):
    try:
        doc_ref = assembly_collection.document(unit_id)
        if not doc_ref.get().exists:
            return jsonify({"success": False, "message": "Assembly Unit not found"}), 404
 
        doc_ref.delete()
        return jsonify({"success": True, "message": "Assembly Unit deleted"}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to delete Assembly Unit: {exc}"}), 500
 
 
# ----------------------------------------------------------------------
# NEW: bulk delete. This route was missing entirely, which is the root
# cause of the "Delete" button not working from the toolbar's
# select-mode multi-delete flow — the frontend called
# POST /assembly/bulk-delete, got a 404, and the request always failed.
# Mirrors the equivalent PO Details bulk-delete endpoint: accepts a list
# of ids, deletes each in a batch, and reports how many were removed.
# ----------------------------------------------------------------------
@dailyproduction_bp.route("/assembly/bulk-delete", methods=["POST"])
@roles_required(*MANAGER_ROLES)
def bulk_delete_assembly_units():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400
 
    ids = data.get("ids")
    if not isinstance(ids, list) or not ids:
        return jsonify({"success": False, "message": "No Assembly Unit ids provided"}), 400
 
    try:
        batch = db.batch()
        deleted_count = 0
        missing_ids = []
 
        for unit_id in ids:
            doc_ref = assembly_collection.document(unit_id)
            if not doc_ref.get().exists:
                missing_ids.append(unit_id)
                continue
            batch.delete(doc_ref)
            deleted_count += 1
 
        if deleted_count:
            batch.commit()
 
        if deleted_count == 0:
            return jsonify({
                "success": False,
                "message": "None of the selected Assembly Units could be found",
            }), 404
 
        message = f"{deleted_count} Assembly Unit(s) deleted"
        if missing_ids:
            message += f" ({len(missing_ids)} were already removed)"
 
        return jsonify({
            "success": True,
            "message": message,
            "deletedCount": deleted_count,
            "missingIds": missing_ids,
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to delete Assembly Units: {exc}"}), 500
 

from datetime import datetime, timezone
import math
 
from flask import Blueprint, request, jsonify
from firebase_config import db, users_collection
from auth_utils import roles_required
from read_cache import cached_read
 
dailyproduction_bp = Blueprint("dailyproduction", __name__)
assembly_collection = db.collection("assembly_units")
sales_collection = db.collection("sale_register")
 
REQUIRED_FIELDS = [
    "modelId", "phaseId", "stage", "assembledBy", "serial", "date", "qty",
]
DEFAULT_PAGE_SIZE = 10
MAX_PAGE_SIZE = 100
 
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
USER_STATUS_FIELDS = {
    "stage": ("assembledById", "assembledBy"),
    "qc": ("qcById", "qcBy"),
    "packagingStatus": ("packagedById", "packagedBy"),
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
            if str(data.get("role", "user") or "user").strip().lower() != "user":
                continue
            name = str(data.get("name") or "").strip()
            if name:
                users.append({"id": doc.id, "name": name})
        users.sort(key=lambda item: item["name"].casefold())
        return jsonify({"success": True, "users": users}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch production users: {exc}"}), 500
 
 
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
        for serial in serial_numbers:
            doc_ref = assembly_collection.document()
            record = {k: data.get(k, "") for k in ALLOWED_FIELDS}
            record["qcFailureHistory"] = (
                data.get("qcFailureHistory")
                if isinstance(data.get("qcFailureHistory"), list)
                else []
            )
            record["serial"] = serial
            record["qty"] = 1
            record["createdAt"] = created_at
            record["updatedAt"] = created_at
            doc_ref.set(record)
            created_units.append({
                "id": doc_ref.id,
                **{k: record[k] for k in record if k not in ("createdAt", "updatedAt")},
                "createdAt": created_at.isoformat(),
                "updatedAt": created_at.isoformat(),
            })
 
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
    try:
        page, limit = _parse_pagination_params(request.args)
        base_query = assembly_collection.order_by("createdAt", direction="DESCENDING")
        if request.user.get("role") == "user":
            # Legacy assignment fields require a compatibility filter in
            # Python. Managers use the paginated Firestore path below.
            all_docs = list(base_query.stream())
            all_docs = [doc for doc in all_docs if _is_visible_to_current_user(doc.to_dict() or {})]
            total_count = len(all_docs)
            total_pages = max(1, math.ceil(total_count / limit))
            page = min(page, total_pages)
            docs = all_docs[(page - 1) * limit:page * limit]
        else:
            try:
                total_count = base_query.count(alias="total").get()[0][0].value
            except Exception:
                # Retain compatibility with older Firestore clients.
                total_count = len(list(base_query.stream()))
            total_pages = max(1, math.ceil(total_count / limit))
            page = min(page, total_pages)
            docs = list(base_query.offset((page - 1) * limit).limit(limit).stream())

        sale_status_by_serial = _sale_statuses_for_serials(
            (doc.to_dict() or {}).get("serial", "") for doc in docs
        )
        return jsonify({
            "success": True,
            "assemblyUnits": [_serialize(doc, sale_status_by_serial) for doc in docs],
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
        update_fields["updatedAt"] = datetime.now(timezone.utc)
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
            "qcInspection": {},
            "qcFailureHistory": history,
            "packagingStatus": "",
            "packagedBy": "",
            "packagedById": "",
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
 

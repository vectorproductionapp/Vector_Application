import math
import uuid
from datetime import datetime, timezone
 
from flask import Blueprint, request, jsonify
from firebase_config import db
from auth_utils import roles_required
from read_cache import cached_read
 
saleregister_bp = Blueprint("saleregister", __name__)
sales_collection = db.collection("sale_register")
customer_sales_collection = db.collection("customer_sales")
assembly_collection = db.collection("assembly_units")
 
REQUIRED_FIELDS = [
    "poNo", "clientPoDate", "client", "clientContact", "location", "model", "qty", "dispatch", "value",
    "unitCost", "gstRate", "invoiceNumber", "invoiceDate", "warrantyPeriod", "warrantyStartDate",
    "expectedDispatchDate", "actualDispatchDate",
]
 
# Fields that belong on a sale record — everything the frontend form submits,
# including the newly added dispatch/warranty/financial record-keeping fields.
ALLOWED_FIELDS = [
    "date", "poNo", "client", "clientContact", "location", "modelId", "model", "serial", "serialNumbers", "qty", "dispatch", "value",
    "clientPoDate", "expectedDispatchDate", "actualDispatchDate", "invoiceNumber", "invoiceDate",
    "unitCost", "gstRate", "warrantyPeriod", "warrantyStartDate", "warrantyEndDate",
]
 
# Warranty Period is now stored as an integer number of years (1-5), set by
# the frontend dropdown — not free text like the old "24 Months" default.
VALID_WARRANTY_YEARS = {1, 2, 3, 4, 5}
VALID_GST_RATES = {0, 5, 18, 28}
 
 
def _serialize(doc):
    d = doc.to_dict()
    serial_numbers = d.get("serialNumbers")
    if not isinstance(serial_numbers, list):
        legacy_serial = str(d.get("serial", "")).strip()
        serial_numbers = [legacy_serial] if legacy_serial else []
    serial_numbers = [str(value).strip() for value in serial_numbers]
    return {
        "id": doc.id,
        "date": d.get("date") or d.get("clientPoDate", ""),
        "poNo": d.get("poNo", ""),
        "client": d.get("client", ""),
        "clientContact": d.get("clientContact", ""),
        "location": d.get("location", ""),
        "modelId": d.get("modelId", ""),
        "model": d.get("model", ""),
        "serial": ", ".join(serial_numbers),
        "serialNumbers": serial_numbers,
        "qty": d.get("qty", 0),
        "dispatch": d.get("dispatch", ""),
        "value": d.get("value", 0),
        "clientPoDate": d.get("clientPoDate", ""),
        "expectedDispatchDate": d.get("expectedDispatchDate", ""),
        "actualDispatchDate": d.get("actualDispatchDate", ""),
        "invoiceNumber": d.get("invoiceNumber", ""),
        "invoiceDate": d.get("invoiceDate", ""),
        "unitCost": d.get("unitCost", ""),
        "gstRate": d.get("gstRate", ""),
        "warrantyPeriod": d.get("warrantyPeriod", ""),
        "warrantyStartDate": d.get("warrantyStartDate", ""),
        "warrantyEndDate": d.get("warrantyEndDate", ""),
        "createdAt": d.get("createdAt").isoformat() if d.get("createdAt") else None,
        "updatedAt": d.get("updatedAt").isoformat() if d.get("updatedAt") else None,
    }


def _serialize_customer_sale(doc):
    data = doc.to_dict() or {}
    return {
        **{key: data.get(key, "") for key in ALLOWED_FIELDS},
        "id": doc.id,
        "parentSaleId": data.get("parentSaleId", ""),
        "createdAt": data.get("createdAt").isoformat() if data.get("createdAt") else None,
        "updatedAt": data.get("updatedAt").isoformat() if data.get("updatedAt") else None,
    }


def _attach_customer_sales(sales):
    """Attach the separately stored customer sale to its corresponding sale row."""
    for sale in sales:
        customer_doc = customer_sales_collection.document(sale["id"]).get()
        sale["customerSale"] = _serialize_customer_sale(customer_doc) if customer_doc.exists else None
    return sales
 
 
def _coerce_serial_numbers(data, qty):
    raw = data.get("serialNumbers")
    if raw is None:
        legacy = str(data.get("serial", "")).strip()
        serial_numbers = [legacy] if legacy else []
    elif isinstance(raw, list):
        serial_numbers = [str(value).strip() for value in raw]
    else:
        raise ValueError("Serial Numbers must be an array.")
    if len(serial_numbers) != qty:
        raise ValueError(f"Exactly {qty} Serial Number(s) are required.")
    if any(not value for value in serial_numbers):
        raise ValueError("Every Serial Number is required.")
    if len(set(value.casefold() for value in serial_numbers)) != len(serial_numbers):
        raise ValueError("Duplicate Serial Numbers are not allowed.")
    return serial_numbers


def _record_serials(data):
    raw = data.get("serialNumbers")
    if isinstance(raw, list):
        return [str(value).strip() for value in raw if str(value).strip()]
    legacy = str(data.get("serial", "")).strip()
    return [value.strip() for value in legacy.split(",") if value.strip()]


def _validate_client_contact(value):
    contact = str(value).strip()
    if len(contact) != 10 or not contact.isdigit():
        raise ValueError("Client Contact must contain exactly 10 digits.")
    return contact


def _reserved_serials(exclude_sale_id=None):
    """Serials on non-cancelled sales cannot be assigned to another sale."""
    reserved = set()
    for doc in sales_collection.stream():
        if exclude_sale_id and doc.id == exclude_sale_id:
            continue
        data = doc.to_dict() or {}
        if str(data.get("dispatch", "")).strip().casefold() == "cancelled":
            continue
        reserved.update(serial.casefold() for serial in _record_serials(data))
    return reserved


def _available_assembly_units(model_id="", model_name="", exclude_sale_id=None):
    """Return QC-passed production units that are not reserved by another sale."""
    model_id = str(model_id or "").strip()
    model_name = str(model_name or "").strip().casefold()
    reserved = _reserved_serials(exclude_sale_id)
    available = []
    seen_serials = set()

    for doc in assembly_collection.stream():
        data = doc.to_dict() or {}
        serial = str(data.get("serial", "")).strip()
        normalized_serial = serial.casefold()
        if not serial or str(data.get("qc", "")).strip().casefold() != "passed":
            continue
        unit_model_id = str(data.get("modelId", "")).strip()
        if model_id:
            if unit_model_id and unit_model_id != model_id:
                continue
            if not unit_model_id and not model_name:
                continue
        if model_name and str(data.get("model", "")).strip().casefold() != model_name:
            continue
        if normalized_serial in reserved or normalized_serial in seen_serials:
            continue
        seen_serials.add(normalized_serial)
        available.append({
            "id": doc.id,
            "modelId": data.get("modelId", ""),
            "model": data.get("model", ""),
            "serial": serial,
            "stockStatus": "In Stock",
        })

    available.sort(key=lambda item: item["serial"].casefold())
    return available


def _validate_available_serials(data, serial_numbers, exclude_sale_id=None):
    available = _available_assembly_units(
        model_id=data.get("modelId", ""),
        model_name=data.get("model", ""),
        exclude_sale_id=exclude_sale_id,
    )
    available_serials = {item["serial"].casefold() for item in available}
    unavailable = [serial for serial in serial_numbers if serial.casefold() not in available_serials]
    if unavailable:
        raise ValueError(
            "These serial numbers are not in stock for the selected model: "
            + ", ".join(unavailable)
        )


@saleregister_bp.route("/sales/available-serials", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge")
@cached_read("available-serials", ttl_seconds=120)
def list_available_serials():
    try:
        serials = _available_assembly_units(
            model_id=request.args.get("modelId", ""),
            model_name=request.args.get("model", ""),
            exclude_sale_id=request.args.get("excludeSaleId"),
        )
        return jsonify({"success": True, "serials": serials}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch available serials: {exc}"}), 500
 
 
def _coerce_numeric(data):
    """Convert sale quantities and amounts; raises ValueError on invalid values."""
    qty = data.get("qty", 0)
    value = data.get("value", 0)
    unit_cost = data.get("unitCost", "")
 
    qty = int(qty) if str(qty).strip() != "" else 0
    value = float(value) if str(value).strip() != "" else 0
    unit_cost = float(unit_cost) if str(unit_cost).strip() != "" else ""
 
    return qty, value, unit_cost
 
 
def _coerce_gst_rate(raw):
    if raw is None or str(raw).strip() == "":
        raise ValueError("GST Rate is required.")
    try:
        rate = int(raw)
    except (ValueError, TypeError):
        raise ValueError("GST Rate must be a valid GST percentage.")
    if rate not in VALID_GST_RATES:
        raise ValueError("GST Rate must be Nil (0%), 5%, 18%, or 28%.")
    return rate
 
 
def _calculate_po_value(unit_cost, qty, gst_rate):
    if unit_cost == "":
        raise ValueError("Unit Cost is required to calculate PO Value.")
    return round(unit_cost * qty * (1 + gst_rate / 100), 2)
 
 
def _coerce_warranty_period(raw):
    """
    Warranty Period is stored as an int 1-5 (years), or "" if not selected.
    Raises ValueError if a non-empty value isn't one of the allowed years.
    """
    if raw is None or str(raw).strip() == "":
        return ""
    try:
        years = int(raw)
    except (ValueError, TypeError):
        raise ValueError("Warranty Period must be a whole number of years (1-5).")
    if years not in VALID_WARRANTY_YEARS:
        raise ValueError("Warranty Period must be between 1 and 5 years.")
    return years
 
 
def _parse_pagination_params(args):
    try:
        page = int(args.get("page", 1))
    except (TypeError, ValueError):
        page = 1
 
    try:
        limit = int(args.get("limit", 10))
    except (TypeError, ValueError):
        limit = 10
 
    if page < 1:
        page = 1
    if limit < 1:
        limit = 10
    if limit > 100:
        limit = 100
 
    return page, limit
 
 
@saleregister_bp.route("/sales", methods=["POST"])
def create_sale():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400
 
    missing = [f for f in REQUIRED_FIELDS if not str(data.get(f, "")).strip()]
    if missing:
        return jsonify({"success": False, "message": f"Missing required fields: {', '.join(missing)}"}), 400

    try:
        data["clientContact"] = _validate_client_contact(data.get("clientContact"))
    except ValueError as exc:
        return jsonify({"success": False, "message": str(exc)}), 400
 
    try:
        qty, value, unit_cost = _coerce_numeric(data)
    except (ValueError, TypeError):
        return jsonify({"success": False, "message": "Qty, PO Value, and Unit Cost must be valid numbers"}), 400
 
    try:
        serial_numbers = _coerce_serial_numbers(data, qty)
        _validate_available_serials(data, serial_numbers)
    except ValueError as exc:
        return jsonify({"success": False, "message": str(exc)}), 400
 
    try:
        gst_rate = _coerce_gst_rate(data.get("gstRate"))
        value = _calculate_po_value(unit_cost, qty, gst_rate)
    except ValueError as exc:
        return jsonify({"success": False, "message": str(exc)}), 400
 
    try:
        warranty_period = _coerce_warranty_period(data.get("warrantyPeriod"))
    except ValueError as exc:
        return jsonify({"success": False, "message": str(exc)}), 400
 
    try:
        created_at = datetime.now(timezone.utc)
        per_unit_value = _calculate_po_value(unit_cost, 1, gst_rate)
        batch = db.batch()
        created_records = []

        for serial_number in serial_numbers:
            doc_ref = sales_collection.document()
            record = {k: data.get(k, "") for k in ALLOWED_FIELDS}
            record["date"] = record.get("date") or record.get("clientPoDate", "")
            record["qty"] = 1
            record["serialNumbers"] = [serial_number]
            record["serial"] = serial_number
            record["value"] = per_unit_value
            record["unitCost"] = unit_cost
            record["gstRate"] = gst_rate
            record["warrantyPeriod"] = warranty_period
            record["createdAt"] = created_at
            record["updatedAt"] = created_at
            batch.set(doc_ref, record)
            created_records.append((doc_ref.id, record))

        batch.commit()
        first_id, first_record = created_records[0]
 
        return jsonify({
            "success": True,
            "message": f"Created {len(created_records)} sale record(s)",
            "id": first_id,
            "createdIds": [record_id for record_id, _ in created_records],
            **{k: first_record[k] for k in first_record if k not in ("createdAt", "updatedAt")},
            "createdAt": created_at.isoformat(),
            "updatedAt": created_at.isoformat(),
        }), 201
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to create sale: {exc}"}), 500
 
 
@saleregister_bp.route("/sales", methods=["GET"])
@cached_read("sales", ttl_seconds=120)
def list_sales():
    try:
        page, limit = _parse_pagination_params(request.args)
        search = str(request.args.get("search", "")).strip().casefold()
        base_query = sales_collection.order_by("createdAt", direction="DESCENDING")
        all_docs = list(base_query.stream()) if search else None
        if search:
            matching_docs = []
            for doc in all_docs:
                serialized = _serialize(doc)
                searchable = " ".join(str(serialized.get(key, "")) for key in ("poNo", "client", "location", "model", "serial", "dispatch"))
                searchable += " " + " ".join(serialized.get("serialNumbers", []))
                if search in searchable.casefold():
                    matching_docs.append(doc)
            total_count = len(matching_docs)
            total_pages = max(1, math.ceil(total_count / limit))
            page = min(page, total_pages)
            docs = matching_docs[(page - 1) * limit: page * limit]
        else:
            docs = None
 
        if not search:
            try:
                count_result = base_query.count(alias="total").get()
                total_count = count_result[0][0].value
            except Exception:
                total_count = len(list(base_query.stream()))
 
        total_pages = max(1, math.ceil(total_count / limit))
        if page > total_pages:
            page = total_pages
 
        offset = (page - 1) * limit
        if docs is None:
            docs = base_query.offset(offset).limit(limit).stream()
 
        return jsonify({
            "success": True,
            "sales": _attach_customer_sales([_serialize(doc) for doc in docs]),
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
        return jsonify({"success": False, "message": f"Failed to fetch sales: {exc}"}), 500
 
 
@saleregister_bp.route("/sales/<sale_id>", methods=["GET"])
def get_sale(sale_id):
    try:
        doc = sales_collection.document(sale_id).get()
        if not doc.exists:
            return jsonify({"success": False, "message": "Sale not found"}), 404
        return jsonify({"success": True, "sale": _attach_customer_sales([_serialize(doc)])[0]}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch sale: {exc}"}), 500
 
 
@saleregister_bp.route("/sales/<sale_id>", methods=["PUT"])
def update_sale(sale_id):
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400
 
    update_fields = {k: v for k, v in data.items() if k in ALLOWED_FIELDS}
    if "clientPoDate" in update_fields and not update_fields.get("date"):
        update_fields["date"] = update_fields["clientPoDate"]
 
    if not update_fields:
        return jsonify({"success": False, "message": "Nothing to update"}), 400

    if "clientContact" in update_fields:
        try:
            update_fields["clientContact"] = _validate_client_contact(update_fields["clientContact"])
        except ValueError as exc:
            return jsonify({"success": False, "message": str(exc)}), 400
 
    if "warrantyPeriod" in update_fields:
        try:
            update_fields["warrantyPeriod"] = _coerce_warranty_period(update_fields["warrantyPeriod"])
        except ValueError as exc:
            return jsonify({"success": False, "message": str(exc)}), 400
 
    try:
        doc_ref = sales_collection.document(sale_id)
        existing = doc_ref.get()
        if not existing.exists:
            return jsonify({"success": False, "message": "Sale not found"}), 404
        existing_data = existing.to_dict() or {}

        existing_serials = existing_data.get("serialNumbers")
        if not isinstance(existing_serials, list):
            legacy_serial = str(existing_data.get("serial", "")).strip()
            existing_serials = [value.strip() for value in legacy_serial.split(",") if value.strip()]
        submitted_serials = update_fields.get("serialNumbers", existing_serials)
        selected_serial = str(submitted_serials[0]).strip() if len(submitted_serials) == 1 else ""
        legacy_remaining_serials = [
            str(value).strip() for value in existing_serials
            if str(value).strip() and str(value).strip().casefold() != selected_serial.casefold()
        ] if len(existing_serials) > 1 and selected_serial else []
        serial_fields_changed = (
            int(update_fields.get("qty", existing_data.get("qty", 0))) != int(existing_data.get("qty", 0))
            or [str(value).strip() for value in submitted_serials] != [str(value).strip() for value in existing_serials]
        )
        model_changed = (
            str(update_fields.get("modelId", existing_data.get("modelId", ""))).strip()
            != str(existing_data.get("modelId", "")).strip()
            or str(update_fields.get("model", existing_data.get("model", ""))).strip().casefold()
            != str(existing_data.get("model", "")).strip().casefold()
        )
        dispatch_reactivating = (
            str(existing_data.get("dispatch", "")).strip().casefold() == "cancelled"
            and str(update_fields.get("dispatch", existing_data.get("dispatch", ""))).strip().casefold() != "cancelled"
        )
 
        # Recalculate the total whenever an input that affects it changes.
        # Combining the saved record with the submitted fields also supports
        # a partial API update safely.
        if {"qty", "unitCost", "gstRate"}.intersection(update_fields):
            financial_values = {**existing_data, **update_fields}
            qty, _, unit_cost = _coerce_numeric(financial_values)
            gst_rate = _coerce_gst_rate(financial_values.get("gstRate"))
            update_fields["qty"] = qty
            update_fields["unitCost"] = unit_cost
            update_fields["gstRate"] = gst_rate
            update_fields["value"] = _calculate_po_value(unit_cost, qty, gst_rate)
        elif "value" in update_fields:
            # PO Value is calculated, not user-entered.
            update_fields.pop("value")
 
        if serial_fields_changed:
            current = {**existing_data, **update_fields}
            qty = int(current.get("qty", 0))
            update_fields["serialNumbers"] = _coerce_serial_numbers(current, qty)
            update_fields["serial"] = ", ".join(update_fields["serialNumbers"])
        else:
            update_fields.pop("serialNumbers", None)
            update_fields.pop("serial", None)

        if serial_fields_changed or model_changed or dispatch_reactivating:
            candidate = {**existing_data, **update_fields}
            candidate_serials = _record_serials(candidate)
            _validate_available_serials(candidate, candidate_serials, exclude_sale_id=sale_id)

        # A legacy document may contain several serials. When one of its
        # visually separated rows is edited, keep that serial on this document
        # and create independent qty=1 documents for every remaining serial.
        if legacy_remaining_serials and len(submitted_serials) == 1:
            split_source = {**existing_data, **update_fields}
            split_source["qty"] = 1
            split_source["value"] = _calculate_po_value(
                float(split_source.get("unitCost", 0)), 1, int(split_source.get("gstRate", 0))
            )
            split_source["updatedAt"] = datetime.now(timezone.utc)
            batch = db.batch()
            for remaining_serial in legacy_remaining_serials:
                sibling_ref = sales_collection.document()
                sibling = {**split_source, "serial": remaining_serial, "serialNumbers": [remaining_serial]}
                batch.set(sibling_ref, sibling)
            batch.commit()
 
        update_fields["updatedAt"] = datetime.now(timezone.utc)
        doc_ref.update(update_fields)
        updated_doc = doc_ref.get()
        return jsonify({"success": True, "message": "Sale updated", **_serialize(updated_doc)}), 200
    except ValueError as exc:
        return jsonify({"success": False, "message": str(exc)}), 400
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to update sale: {exc}"}), 500


@saleregister_bp.route("/sales/<sale_id>/customer-sale", methods=["PUT"])
@roles_required("admin", "coadmin", "production_incharge")
def save_customer_sale(sale_id):
    """Store the customer-sale form against its parent sale record."""
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    try:
        doc_ref = sales_collection.document(sale_id)
        if not doc_ref.get().exists:
            return jsonify({"success": False, "message": "Sale not found"}), 404

        customer_sale = {key: data.get(key, "") for key in ALLOWED_FIELDS}
        customer_sale["date"] = customer_sale.get("date") or customer_sale.get("clientPoDate", "")
        now = datetime.now(timezone.utc)
        customer_ref = customer_sales_collection.document(sale_id)
        existing_customer_sale = customer_ref.get()
        customer_sale["parentSaleId"] = sale_id
        customer_sale["createdAt"] = existing_customer_sale.to_dict().get("createdAt", now) if existing_customer_sale.exists else now
        customer_sale["updatedAt"] = now
        customer_ref.set(customer_sale)
        return jsonify({"success": True, "message": "Customer sale saved", "customerSale": _serialize_customer_sale(customer_ref.get())}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to save customer sale: {exc}"}), 500
 
 
@saleregister_bp.route("/sales/bulk-delete", methods=["POST"])
def bulk_delete_sales():
    data = request.get_json(silent=True) or {}
    ids = data.get("ids", [])
 
    if not isinstance(ids, list) or not ids:
        return jsonify({"success": False, "message": "No sale IDs provided"}), 400
 
    deleted = []
    failed = []
 
    for sale_id in ids:
        try:
            doc_ref = sales_collection.document(str(sale_id))
            if doc_ref.get().exists:
                doc_ref.delete()
                deleted.append(str(sale_id))
            else:
                failed.append(str(sale_id))
        except Exception:
            failed.append(str(sale_id))
 
    return jsonify({
        "success": True,
        "message": f"Deleted {len(deleted)} sale(s)",
        "deleted": deleted,
        "failed": failed,
    }), 200
 
 
@saleregister_bp.route("/sales/<sale_id>", methods=["DELETE"])
def delete_sale(sale_id):
    try:
        doc_ref = sales_collection.document(sale_id)
        if not doc_ref.get().exists:
            return jsonify({"success": False, "message": "Sale not found"}), 404
 
        doc_ref.delete()
        return jsonify({"success": True, "message": "Sale deleted"}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to delete sale: {exc}"}), 500
 
 
 

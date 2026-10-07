import math
import re

from datetime import datetime, timezone
 
from flask import Blueprint, request, jsonify

from firebase_config import db
from read_cache import cached_read, invalidate_read_cache
from auth_utils import roles_required
from attachments import delete_files, entries_of, normalise_entries, upload_files
 
podetails_bp = Blueprint("podetails", __name__)

po_details_collection = db.collection("po_details")
# One document per PO (model + phase + PO number).  PO attachments live here so
# a PO keeps a single set of files instead of one set per item line.
po_headers_collection = db.collection("po_headers")
 
REQUIRED_FIELDS = ["phase", "po", "date", "code", "desc", "qty", "rate", "expectedDeliveryDate", "status"]
 
# Everything the frontend PO Details form submits.

ALLOWED_FIELDS = [

    "phase", "modelId", "phaseId", "po", "supplier", "date", "code", "make", "model",

    "desc", "qty", "rate", "gstRate", "expectedDeliveryDate", "status", "image", "imageName", "attachments",

]
 
DEFAULT_PAGE_SIZE = 10

MAX_PAGE_SIZE = 100

# Ceiling for the Excel bulk-upload endpoint so a single request cannot
# saturate Firestore with unbounded writes.

MAX_BULK_ROWS = 500

# GST percentage used whenever a payload does not carry its own rate.
DEFAULT_GST_RATE = 18.0

# How many records a single attachment lookup may cover.
MAX_IMAGE_IDS = 50

# Shared with attachments.py: the stored name of a supplier/file is trimmed.
MAX_NAME_CHARS = 160

# One storage folder for PO attachments; invoices use their own.
ATTACHMENT_PREFIX = "po-attachments"


def _gst_rate(source, strict=False):
    """Read a GST percentage (0-100) from a payload or a stored document.

    Writes use `strict=True` so a bad value fails loudly; reads fall back to
    the default rate, which keeps pre-existing rows (created at 18%) intact.
    """
    raw = source.get("gstRate") if isinstance(source, dict) else None
    if raw is None or str(raw).strip() == "":
        return DEFAULT_GST_RATE

    try:
        rate = float(str(raw).replace(",", "").strip())
    except (TypeError, ValueError):
        if strict:
            raise ValueError("GST % must be a number")
        return DEFAULT_GST_RATE

    if rate < 0 or rate > 100:
        if strict:
            raise ValueError("GST % must be between 0 and 100")
        rate = min(max(rate, 0.0), 100.0)

    return round(rate, 4)


def _attachment_files(data):
    """All files of a stored document (Storage URLs and legacy inline files)."""
    return entries_of(data)


def _attachments_payload(value, strict=False):
    """Validate a submitted attachment list before it is stored."""
    return normalise_entries(value, strict=strict)


def _header_doc_id(model_id, phase_id, phase, po):
    """A stable document id for one PO.

    The model id, the phase (id when present, otherwise the name) and the PO
    number identify a purchase order, so every item line of that PO maps to the
    same header document - which is where its attachments are stored.
    """
    parts = [str(model_id or ""), str(phase_id or phase or ""), str(po or "")]
    key = "__".join(re.sub(r"[^A-Za-z0-9_.:-]", "_", part) for part in parts)
    return key or "po"


def _header_ref(data):
    return po_headers_collection.document(
        _header_doc_id(
            data.get("modelId", ""),
            data.get("phaseId", ""),
            data.get("phase", ""),
            data.get("po", ""),
        )
    )


def _header_files_map():
    """Every PO header's files, keyed by header document id."""
    files = {}
    try:
        for doc in po_headers_collection.stream():
            entries = _attachment_files(doc.to_dict() or {})
            if entries:
                files[doc.id] = entries
    except Exception:
        return files
    return files


def _drop_po_header_if_orphaned(snapshot_data):
    """Remove a PO header once its last item line is gone."""
    try:
        remaining = [
            doc
            for doc in po_details_collection.stream()
            if _header_doc_id(
                (doc.to_dict() or {}).get("modelId", ""),
                (doc.to_dict() or {}).get("phaseId", ""),
                (doc.to_dict() or {}).get("phase", ""),
                (doc.to_dict() or {}).get("po", ""),
            )
            == _header_doc_id(
                snapshot_data.get("modelId", ""),
                snapshot_data.get("phaseId", ""),
                snapshot_data.get("phase", ""),
                snapshot_data.get("po", ""),
            )
        ]
        if not remaining:
            ref = _header_ref(snapshot_data)
            header = ref.get()
            if header.exists:
                try:
                    delete_files(_attachment_files(header.to_dict() or {}))
                except Exception:
                    pass
                ref.delete()
    except Exception:
        pass


@podetails_bp.route("/po-details/header", methods=["POST"])
@roles_required("admin", "coadmin", "production_incharge", "user")
def upsert_po_header():
    """Store the PO-level record: its header fields and its single set of files.

    The Add PO form keeps one attachment section for the whole PO, so the file
    list is written here instead of on every item line.
    """
    data = request.get_json(silent=True) or {}
    po = str(data.get("po", "")).strip()
    if not po:
        return jsonify({"success": False, "message": "PO number is required"}), 400

    try:
        attachments = _attachments_payload(data.get("attachments"), strict=True)
    except ValueError as exc:
        return jsonify({"success": False, "message": str(exc)}), 400

    try:
        ref = _header_ref({**data, "po": po})
        record = {
            "modelId": data.get("modelId", ""),
            "phaseId": data.get("phaseId", ""),
            "phase": data.get("phase", ""),
            "po": po,
            "date": data.get("date", ""),
            "supplier": data.get("supplier", ""),
            "attachments": attachments,
            "updatedAt": datetime.now(timezone.utc),
        }
        ref.set(record, merge=True)
        invalidate_read_cache()
        return jsonify({
            "success": True,
            "header": {
                "id": ref.id,
                **{k: v for k, v in record.items() if k != "updatedAt"},
                "updatedAt": record["updatedAt"].isoformat(),
            },
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to save PO header: {exc}"}), 500


@podetails_bp.route("/po-details/header", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge", "user")
def get_po_header():
    """The PO-level record, used to reopen the Add/Edit form with its files."""
    po = str(request.args.get("po", "")).strip()
    if not po:
        return jsonify({"success": False, "message": "PO number is required"}), 400

    try:
        snapshot = _header_ref({
            "modelId": request.args.get("modelId", ""),
            "phaseId": request.args.get("phaseId", ""),
            "phase": request.args.get("phase", ""),
            "po": po,
        }).get()
        if not snapshot.exists:
            return jsonify({"success": True, "header": None}), 200
        data = snapshot.to_dict() or {}
        return jsonify({"success": True, "header": {
            "id": snapshot.id,
            "modelId": data.get("modelId", ""),
            "phaseId": data.get("phaseId", ""),
            "phase": data.get("phase", ""),
            "po": data.get("po", ""),
            "date": data.get("date", ""),
            "supplier": data.get("supplier", ""),
            "attachments": _attachment_files(data),
        }}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch PO header: {exc}"}), 500


def _serialize(doc, include_image=False):

    d = doc.to_dict()
    files = _attachment_files(d)

    payload = {

        "id": doc.id,

        "phase": d.get("phase", ""),

        "modelId": d.get("modelId", ""),

        "phaseId": d.get("phaseId", ""),

        "po": d.get("po", ""),

        "supplier": d.get("supplier", ""),

        "date": d.get("date", ""),

        "code": d.get("code", ""),

        "make": d.get("make", ""),

        "model": d.get("model", ""),

        "desc": d.get("desc", ""),

        "qty": d.get("qty", 0),

        "rate": d.get("rate", 0),

        "gst": d.get("gst", 0),

        "gstRate": _gst_rate(d),

        "value": d.get("value", 0),

        "expectedDeliveryDate": d.get("expectedDeliveryDate", ""),

        "status": d.get("status", ""),

        # List endpoints carry only the file metadata, so the toolbar strip can
        # render thumbnails without a second request. Inline (legacy) files keep
        # their bytes out of the list and are fetched on demand.
        "hasImage": bool(files),

        "attachmentCount": len(files),

        "imageName": files[0]["name"] if files else "",

        "attachments": [
            {k: v for k, v in entry.items() if k != "data"} for entry in files
        ],

        "createdAt": d.get("createdAt").isoformat() if d.get("createdAt") else None,

        "updatedAt": d.get("updatedAt").isoformat() if d.get("updatedAt") else None,

    }

    if include_image:
        payload["attachments"] = files

    return payload


def _coerce_numeric(data):

    """Best-effort conversion of qty/rate to numbers; raises ValueError on bad input."""

    qty = data.get("qty", 0)

    rate = data.get("rate", 0)

    qty = float(qty) if str(qty).strip() != "" else 0

    rate = float(rate) if str(rate).strip() != "" else 0

    return qty, rate


def _validated_record(data):

    """Validate one PO payload and build the Firestore-ready record.

    Raises ValueError with a user-facing message when the payload is invalid.
    Shared by the single-create and Excel bulk-upload endpoints so both apply
    exactly the same rules.
    """

    missing = [
        f for f in REQUIRED_FIELDS
        if data.get(f) is None or not str(data.get(f)).strip()
    ]

    if missing:
        raise ValueError(f"Missing required fields: {', '.join(missing)}")

    try:
        qty, rate = _coerce_numeric(data)
    except (ValueError, TypeError) as exc:
        raise ValueError("Qty Ordered and Unit Rate must be valid numbers") from exc

    # Data integrity: recompute GST/value server-side rather than trusting the
    # client.  The GST percentage itself comes from the payload so each product
    # can carry its own rate (defaults to 18%).
    gst_rate = _gst_rate(data, strict=True)
    base_value = qty * rate
    gst = round(base_value * gst_rate / 100, 2)
    value = round(base_value + gst, 2)

    record = {k: data.get(k, "") for k in ALLOWED_FIELDS}
    record["supplier"] = _text(data.get("supplier"))[:MAX_NAME_CHARS]
    record["attachments"] = _attachments_payload(data.get("attachments"), strict=True)
    if data.get("attachments") is not None:
        # The file list is authoritative now, so the legacy single-file fields
        # are cleared - otherwise reads would fall back to them.
        record["image"] = None
        record["imageName"] = ""
    else:
        record["image"] = None
        record["imageName"] = _text(data.get("imageName"))[:MAX_NAME_CHARS]
    record["qty"] = qty
    record["rate"] = rate
    record["gstRate"] = gst_rate
    record["gst"] = gst
    record["value"] = value
    return record


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
 
 
# Columns scanned by the UI's free-text search box (mirrors `columns` in
# PODetails.jsx).  Values are stringified exactly like the client does.
_SEARCH_KEYS = ("phase", "po", "supplier", "date", "code", "desc", "qty", "rate", "gstRate", "gst", "value", "status")

# Fields the PageFilter dropdown offers (mirrors PO_FILTER_FIELDS).
_FILTER_FIELDS = frozenset({"phase", "po", "supplier", "code", "status"})


def _text(value):
    return "" if value is None else str(value).strip()


def _row_matches_filters(row, search, filters):
    """True when a serialized row passes the active search + field filters.

    Field values compare case-insensitively so `pending` / `Pending` / `PENDING`
    all match — users type PO numbers and statuses in either case.
    """
    if search and not any(search in _text(row.get(key)).lower() for key in _SEARCH_KEYS):
        return False
    for field, value in filters:
        # Present filters always compare, even against an empty value: the
        # caller only sends a field when it actually wants to scope the rows.
        if _text(row.get(field)).lower() != value.lower():
            return False
    return True


@podetails_bp.route("/po-details", methods=["POST"])

def create_po_detail():

    data = request.get_json(silent=True)

    if not data:

        return jsonify({"success": False, "message": "Request body must be JSON"}), 400

    try:

        record = _validated_record(data)

    except ValueError as exc:

        return jsonify({"success": False, "message": str(exc)}), 400

    try:

        doc_ref = po_details_collection.document()

        created_at = datetime.now(timezone.utc)

        record["createdAt"] = created_at

        record["updatedAt"] = created_at

        doc_ref.set(record)

        invalidate_read_cache()

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


@podetails_bp.route("/po-details/bulk", methods=["POST"])

def bulk_create_po_details():
    """Create many PO Details at once from the Excel bulk-upload modal.

    Body: {"rows": [{...same shape as POST /po-details...}, ...]}

    Validation runs per row so one bad line never rejects the whole file.
    """
    payload = request.get_json(silent=True) or {}
    rows = payload.get("rows")

    if not isinstance(rows, list) or not rows:
        return jsonify({"success": False, "message": "No PO rows provided"}), 400

    if len(rows) > MAX_BULK_ROWS:
        return jsonify({
            "success": False,
            "message": f"Too many rows: {len(rows)} provided, limit is {MAX_BULK_ROWS} per upload",
        }), 400

    created = []
    errors = []
    created_at = datetime.now(timezone.utc)

    for index, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            errors.append({"row": index, "message": "Row is not a valid object"})
            continue

        try:
            record = _validated_record(row)
        except ValueError as exc:
            errors.append({"row": index, "message": str(exc)})
            continue

        try:
            doc_ref = po_details_collection.document()
            record["createdAt"] = created_at
            record["updatedAt"] = created_at
            doc_ref.set(record)
            created.append({
                "id": doc_ref.id,
                **{k: record[k] for k in record if k not in ("createdAt", "updatedAt")},
            })
        except Exception as exc:
            errors.append({"row": index, "message": f"Failed to save row: {exc}"})

    if not created:
        return jsonify({
            "success": False,
            "message": f"No PO Details were created ({len(errors)} row(s) failed)",
            "created": 0,
            "errors": errors,
            "failed": len(errors),
        }), 400

    message = f"Created {len(created)} PO Detail(s)"
    if errors:
        message += f", {len(errors)} row(s) skipped"

    invalidate_read_cache()

    return jsonify({
        "success": True,
        "message": message,
        "created": created,
        "createdCount": len(created),
        "errors": errors,
        "failed": len(errors),
    }), 201

 
@podetails_bp.route("/po-details", methods=["GET"])
@cached_read("po-details", ttl_seconds=120)

def list_po_details():

    """

    Supports pagination via `?page=<n>&limit=<n>` query params (defaults: page=1, limit=10)
    plus optional server-side filters `?q=<text>&filterField=<key>&filterValue=<value>`.
    `totals.poValue`, `totals.poValueExclGst`, `totals.poGst` and
    `pagination.totalCount` always cover every row that matches the active
    filters, not just the requested page.

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

        },

        "totals": { "poValue": 1234567.89, "poValueExclGst": 1046074.49, "poGst": 188493.4 }

    }

    """

    try:

        page, limit = _parse_pagination_params(request.args)

        base_query = po_details_collection.order_by("createdAt", direction="DESCENDING")

        # Optional server-side filters (?q=...&filterField=...&filterValue=...)
        # mirroring the UI's search box and PageFilter dropdown, so the row
        # count and `totals.poValue` always describe the filtered set.
        # The params may repeat (the card drill-down sends a PO + phase pair).
        search = (request.args.get("q") or "").strip().lower()
        raw_fields = request.args.getlist("filterField")
        raw_values = request.args.getlist("filterValue")
        filters = []
        for raw_field, raw_value in zip(raw_fields, raw_values):
            field = (raw_field or "").strip()
            if field in _FILTER_FIELDS:
                filters.append((field, str(raw_value or "")))
 
        # One pass over every PO row: apply the filters, collect the matching
        # rows and accumulate the grand total.  Firestore cannot filter by
        # substring, so that happens here; `cached_read` keeps repeat views cheap.
        # A PO's files live on its header document, so every line of that PO
        # reports the same single set.
        header_files = _header_files_map()
        filtered_rows = []
        all_rows = []
        total_value = 0
        total_value_excl_gst = 0
        total_gst = 0
        for doc in base_query.stream():
            row = _serialize(doc)
            po_files = header_files.get(_header_doc_id(
                row.get("modelId", ""), row.get("phaseId", ""), row.get("phase", ""), row.get("po", "")
            ))
            if po_files is not None:
                row["attachments"] = [{k: v for k, v in e.items() if k != "data"} for e in po_files]
                row["attachmentCount"] = len(po_files)
                row["hasImage"] = bool(po_files)
                row["imageName"] = po_files[0]["name"] if po_files else ""
            all_rows.append(row)
            if not _row_matches_filters(row, search, filters):
                continue
            filtered_rows.append(row)
            try:
                row_value = float(row.get("value") or 0)
                row_gst = float(row.get("gst") or 0)
            except (TypeError, ValueError):
                continue
            total_value += row_value
            total_gst += row_gst
            # value = base (qty x rate) + gst, so the pre-GST figure is the
            # same total minus the GST portion of every line.
            total_value_excl_gst += row_value - row_gst
        total_value = round(total_value, 2)
        total_value_excl_gst = round(total_value_excl_gst, 2)
        total_gst = round(total_gst, 2)

        # The page reads "phase first, then PO number", so the paged rows are
        # ordered the same way instead of purely by newest-created.
        filtered_rows.sort(
            key=lambda row: (
                _text(row.get("phase")).lower(),
                _text(row.get("po")).lower(),
                _text(row.get("date")),
                _text(row.get("code")).lower(),
            )
        )

        # Distinct values per filterable field over the whole collection, so
        # the PageFilter dropdown never loses options while a filter is active.
        filter_options = {
            key: sorted({_text(row.get(key)) for row in all_rows if _text(row.get(key))},
                        key=lambda value: value.lower())
            for key in sorted(_FILTER_FIELDS)
        }

        total_count = len(filtered_rows)
 
        total_pages = max(1, math.ceil(total_count / limit))

        # Clamp page to the last valid page if the caller asks for something
        # beyond the end of the data (e.g. after rows were deleted).
        if page > total_pages:
            page = total_pages

        offset = (page - 1) * limit
        page_rows = filtered_rows[offset:offset + limit]

        return jsonify({

            "success": True,

            "poDetails": page_rows,

            "totals": {"poValue": total_value, "poValueExclGst": total_value_excl_gst, "poGst": total_gst},

            "filterOptions": filter_options,

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
 
 
@podetails_bp.route("/po-details/groups", methods=["GET"])
@cached_read("po-details-groups", ttl_seconds=120)
def list_po_groups():
    """Card view for the PO Details page.

    Mirrors the Models grid but with this project's own order: one card per
    phase, with that phase's PO numbers as a second-level card grid
    (Phases -> POs -> line items).  Grouping keys are lower-cased so `po-12`
    and `PO-12` land on the same card, and both levels read A-Z.
    """
    try:
        groups = {}
        for doc in po_details_collection.order_by("createdAt", direction="DESCENDING").stream():
            row = _serialize(doc)
            po_name = _text(row.get("po")) or "Untitled PO"
            phase_name = _text(row.get("phase")) or "Unassigned"
            date = _text(row.get("date"))
            try:
                value = float(row.get("value") or 0)
            except (TypeError, ValueError):
                value = 0.0
            try:
                gst = float(row.get("gst") or 0)
            except (TypeError, ValueError):
                gst = 0.0
            # value = base (qty x rate) + gst, so the pre-GST figure is the
            # same line minus its GST portion.
            base = value - gst

            group = groups.setdefault(phase_name.lower(), {
                "phase": phase_name,
                "date": date,
                "rowCount": 0,
                "totalValue": 0.0,
                "totalGst": 0.0,
                "totalValueExclGst": 0.0,
                "pos": {},
            })
            group["rowCount"] += 1
            group["totalValue"] += value
            group["totalGst"] += gst
            group["totalValueExclGst"] += base

            po = group["pos"].setdefault(po_name.lower(), {
                "po": po_name,
                "date": date,
                "rowCount": 0,
                "totalValue": 0.0,
                "totalGst": 0.0,
                "totalValueExclGst": 0.0,
            })
            po["rowCount"] += 1
            po["totalValue"] += value
            po["totalGst"] += gst
            po["totalValueExclGst"] += base

        payload = []
        for group in groups.values():
            group["totalValue"] = round(group["totalValue"], 2)
            group["totalGst"] = round(group["totalGst"], 2)
            group["totalValueExclGst"] = round(group["totalValueExclGst"], 2)
            group["pos"] = sorted(
                (
                    {
                        **po,
                        "totalValue": round(po["totalValue"], 2),
                        "totalGst": round(po["totalGst"], 2),
                        "totalValueExclGst": round(po["totalValueExclGst"], 2),
                    }
                    for po in group["pos"].values()
                ),
                key=lambda item: item["po"].lower(),
            )
            payload.append(group)

        # Phase first, then PO number - both alphabetically.
        payload.sort(key=lambda item: item["phase"].lower())

        return jsonify({"success": True, "phases": payload}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch PO groups: {exc}"}), 500


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

        payload = _serialize(doc, include_image=True)

        # The PO's files live on its header, so a single row read has to merge
        # them in - otherwise opening the row's details showed no attachments.
        data = doc.to_dict() or {}
        header = po_headers_collection.document(_header_doc_id(
            data.get("modelId", ""), data.get("phaseId", ""), data.get("phase", ""), data.get("po", "")
        )).get()
        if header.exists:
            files = _attachment_files(header.to_dict() or {})
            if files:
                payload["attachments"] = files
                payload["attachmentCount"] = len(files)
                payload["hasImage"] = True
                payload["imageName"] = files[0]["name"]

        return jsonify({"success": True, "po": payload}), 200

    except Exception as exc:

        return jsonify({"success": False, "message": f"Failed to fetch PO Detail: {exc}"}), 500
 
 
@podetails_bp.route("/po-details/images", methods=["GET"])
def list_po_images():
    """Files for a set of line ids, used by the attachment strip.

    The list endpoint only reports `hasImage`, so the preview strip asks for
    the files of just the rows it is about to show.  A PO keeps one set of
    files on its header, so every line of that PO returns the same list.
    """
    ids = [value for value in (request.args.get("ids") or "").split(",") if value.strip()]
    ids = [value.strip() for value in ids][:MAX_IMAGE_IDS]
    if not ids:
        return jsonify({"success": True, "attachments": {}}), 200

    try:
        headers = {}
        files = {}
        for po_id in ids:
            doc = po_details_collection.document(po_id).get()
            if not doc.exists:
                continue
            data = doc.to_dict() or {}
            key = _header_doc_id(
                data.get("modelId", ""), data.get("phaseId", ""), data.get("phase", ""), data.get("po", "")
            )
            if key not in headers:
                snapshot = po_headers_collection.document(key).get()
                headers[key] = _attachment_files(snapshot.to_dict() or {}) if snapshot.exists else []
            attachments = headers[key] or _attachment_files(data)
            if attachments:
                files[po_id] = attachments
        return jsonify({"success": True, "attachments": files}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch PO attachments: {exc}"}), 500
 
 
@podetails_bp.route("/po-details/attachments/upload", methods=["POST"])
def upload_po_attachments():
    """Store files in Firebase Storage and return their metadata.

    The record only keeps that metadata, so a PO line can hold as many (and as
    large) files as the user likes - the 1 MiB Firestore limit does not apply.
    """
    data = request.get_json(silent=True) or {}
    files = data.get("files") or []
    if not isinstance(files, list) or not files:
        return jsonify({"success": False, "message": "No files to upload"}), 400

    try:
        entries, used_storage = upload_files(ATTACHMENT_PREFIX, files)
    except ValueError as exc:
        return jsonify({"success": False, "message": str(exc)}), 400
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to upload attachments: {exc}"}), 500

    if not entries:
        return jsonify({"success": False, "message": "None of the files could be stored"}), 400

    return jsonify({"success": True, "attachments": entries, "storage": used_storage}), 200
 
 
@podetails_bp.route("/po-details/attachments", methods=["DELETE"])
def delete_po_attachments():
    """Remove the stored files behind the given attachment metadata."""
    data = request.get_json(silent=True) or {}
    entries = data.get("attachments") or []
    if not isinstance(entries, list) or not entries:
        return jsonify({"success": True, "message": "Nothing to delete"}), 200

    try:
        removed = delete_files(entries)
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to delete attachments: {exc}"}), 500

    return jsonify({"success": True, "message": f"{removed} file(s) removed", "removed": removed}), 200
 
 
@podetails_bp.route("/po-details/<po_id>", methods=["PUT"])

def update_po_detail(po_id):

    data = request.get_json(silent=True)

    if not data:

        return jsonify({"success": False, "message": "Request body must be JSON"}), 400
 
    update_fields = {k: v for k, v in data.items() if k in ALLOWED_FIELDS}

    if not update_fields:

        return jsonify({"success": False, "message": "Nothing to update"}), 400
 
    if "gstRate" in update_fields:
        try:
            update_fields["gstRate"] = _gst_rate(update_fields, strict=True)
        except ValueError as exc:
            return jsonify({"success": False, "message": str(exc)}), 400

    if "attachments" in update_fields:
        try:
            update_fields["attachments"] = _attachments_payload(update_fields.get("attachments"), strict=True)
        except ValueError as exc:
            return jsonify({"success": False, "message": str(exc)}), 400
        # The list is now authoritative, so the legacy single-file fields are
        # cleared too - otherwise reads would fall back to them and a file the
        # user just deleted would reappear.
        update_fields["image"] = None
        update_fields["imageName"] = ""
        # A PO keeps one set of files, stored on its header.  The line is only
        # used to work out which PO this row belongs to.
        try:
            existing_doc = po_details_collection.document(po_id).get()
            if existing_doc.exists:
                current = existing_doc.to_dict() or {}
                _header_ref(current).set({
                    "modelId": current.get("modelId", ""),
                    "phaseId": current.get("phaseId", ""),
                    "phase": current.get("phase", ""),
                    "po": current.get("po", ""),
                    "date": current.get("date", ""),
                    "supplier": current.get("supplier", ""),
                    "attachments": update_fields["attachments"],
                    "updatedAt": datetime.now(timezone.utc),
                }, merge=True)
        except Exception as exc:
            return jsonify({"success": False, "message": f"Failed to save PO attachments: {exc}"}), 500
        update_fields.pop("attachments", None)

    if "imageName" in update_fields:
        update_fields["imageName"] = _text(update_fields.get("imageName"))[:MAX_NAME_CHARS]

    if "qty" in update_fields or "rate" in update_fields or "gstRate" in update_fields:

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

            gst_rate = _gst_rate(
                update_fields if "gstRate" in update_fields else existing,
                strict="gstRate" in update_fields,
            )
            update_fields["gstRate"] = gst_rate
            update_fields["gst"] = round(base_value * gst_rate / 100, 2)

            update_fields["value"] = round(base_value + update_fields["gst"], 2)

        except (ValueError, TypeError):

            return jsonify({"success": False, "message": "Qty Ordered, Unit Rate and GST % must be valid numbers"}), 400
 
    try:

        doc_ref = po_details_collection.document(po_id)

        if not doc_ref.get().exists:

            return jsonify({"success": False, "message": "PO Detail not found"}), 404
 
        update_fields["updatedAt"] = datetime.now(timezone.utc)

        doc_ref.update(update_fields)

        invalidate_read_cache()

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
            snapshot = doc_ref.get()
            if snapshot.exists:
                # Stored files go with the record.
                try:
                    delete_files(_attachment_files(snapshot.to_dict() or {}))
                except Exception:
                    pass
                data = snapshot.to_dict() or {}
                doc_ref.delete()
                deleted.append(str(po_id))
                # The PO header only goes once its last line is gone.
                _drop_po_header_if_orphaned(data)
            else:
                failed.append(str(po_id))
        except Exception:
            failed.append(str(po_id))

    invalidate_read_cache()

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

        snapshot = doc_ref.get()

        if not snapshot.exists:

            return jsonify({"success": False, "message": "PO Detail not found"}), 404
 
        # Stored files go with the record, so Storage does not fill up.
        try:
            delete_files(_attachment_files(snapshot.to_dict() or {}))
        except Exception:
            pass

        data = snapshot.to_dict() or {}

        doc_ref.delete()

        # The PO header only goes once its last line is gone.
        _drop_po_header_if_orphaned(data)

        invalidate_read_cache()

        return jsonify({"success": True, "message": "PO Detail deleted"}), 200

    except Exception as exc:

        return jsonify({"success": False, "message": f"Failed to delete PO Detail: {exc}"}), 500
 

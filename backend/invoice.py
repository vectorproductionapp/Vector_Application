from datetime import datetime, timezone
import math
import re
 
from flask import Blueprint, request, jsonify
from firebase_config import db
from read_cache import cached_read, invalidate_read_cache
from auth_utils import roles_required
from attachments import delete_files, entries_of, normalise_entries, upload_files
 
invoice_bp = Blueprint("invoices", __name__)
invoices_collection = db.collection("invoices")
# One document per invoice number.  The files of an invoice are shared by every
# one of its item lines, so they are stored here rather than on each line.
invoice_headers_collection = db.collection("invoice_headers")
 
REQUIRED_FIELDS = ["invoice", "date", "phase", "po", "code", "desc", "qtyInv", "qtyRecv", "verifiedBy"]
DEFAULT_PAGE_SIZE = 10
MAX_PAGE_SIZE = 100
 
# Everything the Invoices form submits.
ALLOWED_FIELDS = [
    "invoice", "date", "modelId", "phaseId", "phase", "po", "code", "desc", "qtyInv", "qtyRecv", "verifiedBy",
    "image", "imageName", "attachments",
]

# One storage folder for invoice attachments; PO lines use their own.
ATTACHMENT_PREFIX = "invoice-attachments"

# How many records a single attachment lookup may cover.
MAX_IMAGE_IDS = 50

MAX_NAME_CHARS = 160


def _header_doc_id(invoice):
    """A stable document id for one invoice number."""
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]", "_", str(invoice or "").strip())
    return cleaned or "invoice"


def _header_ref(data):
    return invoice_headers_collection.document(_header_doc_id(data.get("invoice", "")))


def _normalize_key(value):
    """Comparison form of an identifier.

    An invoice number typed as `inv-2201`, `INV-2201` or ` INV-2201 ` is the same
    invoice, which is how the card view already groups them. Collapsing runs of
    whitespace keeps a pasted number from looking like a new one.
    """
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def _quantity(value):
    """Quantities compare by value, so `5` and `"5.0"` are the same entry."""
    try:
        return round(float(value), 6)
    except (TypeError, ValueError):
        return _normalize_key(value)


def _line_identity(data):
    """What makes two lines of an invoice one entry rather than two.

    The same item billed for the same quantities twice on one invoice is a
    double entry; different quantities are two genuine deliveries.
    """
    return (
        _normalize_key(data.get("po")),
        _normalize_key(data.get("code")),
        _quantity(data.get("qtyInv")),
        _quantity(data.get("qtyRecv")),
    )


def _existing_invoice_lines(invoice_key):
    """Every stored line of one invoice number, found in a single pass.

    The number is compared in Python instead of with a Firestore `where`, so
    lines saved before this normalisation existed are still matched. Returns
    `(doc_id, data)` pairs so a caller can tell a line apart from itself.
    """
    lines = []
    for doc in invoices_collection.stream():
        data = doc.to_dict() or {}
        if _normalize_key(data.get("invoice")) == invoice_key:
            lines.append((doc.id, data))
    return lines


# One save posts one request per item block, all sharing a submission id, so the
# later blocks of a brand new invoice are not mistaken for duplicates of the
# first one. A number already stored under a different submission is a real
# duplicate and is refused.
SUBMISSION_FIELD = "submissionId"
MAX_SUBMISSION_CHARS = 64


def _header_files_map():
    """Every invoice's files, keyed by header document id."""
    files = {}
    try:
        for doc in invoice_headers_collection.stream():
            entries = _attachment_files(doc.to_dict() or {})
            if entries:
                files[doc.id] = entries
    except Exception:
        return files
    return files


def _merge_header_files(payload, files):
    """Point one serialised row at its invoice's shared files."""
    if not files:
        return payload
    payload["attachments"] = [{k: v for k, v in e.items() if k != "data"} for e in files]
    payload["attachmentCount"] = len(files)
    payload["hasImage"] = True
    payload["imageName"] = files[0]["name"]
    return payload


def _drop_invoice_header_if_orphaned(snapshot_data):
    """Remove the invoice header once its last line is gone."""
    try:
        key = _header_doc_id((snapshot_data or {}).get("invoice", ""))
        remaining = [
            doc
            for doc in invoices_collection.stream()
            if _header_doc_id((doc.to_dict() or {}).get("invoice", "")) == key
        ]
        if not remaining:
            ref = invoice_headers_collection.document(key)
            header = ref.get()
            if header.exists:
                try:
                    delete_files(_attachment_files(header.to_dict() or {}))
                except Exception:
                    pass
                ref.delete()
    except Exception:
        pass


def _attachment_files(data):
    """All files of a stored document (Storage URLs and legacy inline files)."""
    return entries_of(data)


def _attachments_payload(value, strict=False):
    """Validate a submitted attachment list before it is stored."""
    return normalise_entries(value, strict=strict)


def _serialize(doc, include_image=False):
    d = doc.to_dict()
    files = _attachment_files(d)
    payload = {
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
        # List endpoints only advertise that an image exists; the bytes travel
        # on the single-record route (or the bulk images route).
        "hasImage": bool(files),
        "attachmentCount": len(files),
        "imageName": files[0]["name"] if files else "",
        # List payloads carry metadata only, so the strip can render thumbnails
        # without a second request.
        "attachments": [{k: v for k, v in entry.items() if k != "data"} for entry in files],
        "createdAt": d.get("createdAt").isoformat() if d.get("createdAt") else None,
        "updatedAt": d.get("updatedAt").isoformat() if d.get("updatedAt") else None,
    }
    if include_image:
        payload["attachments"] = files
    return payload
 
 
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
 
 
@invoice_bp.route("/invoices/header", methods=["POST"])
@roles_required("admin", "coadmin", "production_incharge", "user")
def upsert_invoice_header():
    """Store the invoice-level record: its files, shared by every item line."""
    data = request.get_json(silent=True) or {}
    invoice = str(data.get("invoice", "")).strip()
    if not invoice:
        return jsonify({"success": False, "message": "Invoice number is required"}), 400

    try:
        attachments = _attachments_payload(data.get("attachments"), strict=True)
    except ValueError as exc:
        return jsonify({"success": False, "message": str(exc)}), 400

    try:
        ref = _header_ref({"invoice": invoice})
        record = {
            "invoice": invoice,
            "date": data.get("date", ""),
            "phase": data.get("phase", ""),
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
        return jsonify({"success": False, "message": f"Failed to save invoice attachments: {exc}"}), 500


@invoice_bp.route("/invoices/header", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge", "user")
def get_invoice_header():
    """The invoice's shared files, used to reopen the form with them."""
    invoice = str(request.args.get("invoice", "")).strip()
    if not invoice:
        return jsonify({"success": False, "message": "Invoice number is required"}), 400

    try:
        snapshot = invoice_headers_collection.document(_header_doc_id(invoice)).get()
        if not snapshot.exists:
            return jsonify({"success": True, "header": None}), 200
        data = snapshot.to_dict() or {}
        return jsonify({"success": True, "header": {
            "id": snapshot.id,
            "invoice": data.get("invoice", ""),
            "date": data.get("date", ""),
            "phase": data.get("phase", ""),
            "attachments": _attachment_files(data),
        }}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch invoice header: {exc}"}), 500


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
        attachments = _attachments_payload(data.get("attachments"), strict=True)
    except ValueError as exc:
        return jsonify({"success": False, "message": str(exc)}), 400

    invoice_number = _text(data.get("invoice"))
    submission_id = _text(data.get(SUBMISSION_FIELD))[:MAX_SUBMISSION_CHARS]
    # The edit form sets this when it adds an item to the invoice it already has
    # open. That is not a duplicate - it is another line of the same invoice.
    append_to_existing = bool(data.get("existingInvoice"))

    try:
        existing_lines = _existing_invoice_lines(_normalize_key(invoice_number))
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to verify Invoice No: {exc}"}), 500

    # An invoice number belongs to exactly one invoice, so a line carrying a
    # number that is already stored is refused rather than filed a second time.
    # The exception is this same submission, which is still filling in the
    # invoice number it created a moment ago.
    continues_submission = bool(submission_id) and all(
        line.get(SUBMISSION_FIELD) == submission_id for _, line in existing_lines
    )
    if existing_lines and not append_to_existing and not continues_submission:
        return jsonify({
            "success": False,
            "message": (
                f"Invoice No {invoice_number} already exists. "
                "Open it from the invoice card and add the new items there."
            ),
        }), 409

    identity = _line_identity(data)
    if any(_line_identity(line) == identity for _, line in existing_lines):
        return jsonify({
            "success": False,
            "message": (
                f"Invoice No {invoice_number} already has item "
                f"{_text(data.get('code'))} with the same quantities."
            ),
        }), 409

    try:
        doc_ref = invoices_collection.document()
        created_at = datetime.now(timezone.utc)
 
        record = {k: data.get(k, "") for k in ALLOWED_FIELDS}
        record["attachments"] = attachments
        # The file list is authoritative now, so the legacy single-file fields
        # are cleared - otherwise reads would fall back to them.
        record["image"] = None
        record["imageName"] = ""
        record["qtyInv"] = qty_inv
        record["qtyRecv"] = qty_recv
        record["createdAt"] = created_at
        record["updatedAt"] = created_at
        # Kept so the remaining item blocks of this save are recognised as the
        # same invoice rather than as duplicates of it.
        record[SUBMISSION_FIELD] = submission_id
 
        doc_ref.set(record)

        invalidate_read_cache()

        hidden = ("createdAt", "updatedAt", SUBMISSION_FIELD)
        return jsonify({
            "success": True,
            "message": "Invoice saved successfully",
            "invoice": {
                "id": doc_ref.id,
                **{k: record[k] for k in record if k not in hidden},
                "createdAt": created_at.isoformat(),
                "updatedAt": created_at.isoformat(),
            },
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to create Invoice: {exc}"}), 500
 
 
# Columns scanned by the UI's free-text search box (mirrors `columns` in
# Invoices.jsx).  Values are stringified exactly like the client does.
_SEARCH_KEYS = ("phase", "invoice", "date", "po", "code", "desc", "qtyInv", "qtyRecv", "verifiedBy")

# Fields the PageFilter dropdown offers (mirrors INVOICE_FILTER_FIELDS).
_FILTER_FIELDS = frozenset({"phase", "invoice", "po", "code", "verifiedBy"})


def _text(value):
    return "" if value is None else str(value).strip()


def _row_matches_filters(row, search, filters):
    """True when a serialized row passes the active search + field filters.

    Values compare case-insensitively so `pending` / `Pending` and `po-12` /
    `PO-12` behave the same on both sides of the app.
    """
    if search and not any(search in _text(row.get(key)).lower() for key in _SEARCH_KEYS):
        return False
    for field, value in filters:
        if _text(row.get(field)).lower() != value.lower():
            return False
    return True


@invoice_bp.route("/invoices", methods=["GET"])
@cached_read("invoices", ttl_seconds=120)
def list_invoices():
    """Paged invoice lines, scoped by the card drill-down and the toolbar filters.

    Supports `?page=&limit=` plus `?q=<text>&filterField=<key>&filterValue=<value>`;
    the filter params may repeat so the phase card and the invoice card can be
    combined with the PageFilter selection.  `pagination.totalCount` always
    covers every matching row, not just the requested page.
    """
    try:
        page, limit = _parse_pagination_params(request.args)

        search = (request.args.get("q") or "").strip().lower()
        raw_fields = request.args.getlist("filterField")
        raw_values = request.args.getlist("filterValue")
        filters = []
        for raw_field, raw_value in zip(raw_fields, raw_values):
            field = (raw_field or "").strip()
            if field in _FILTER_FIELDS:
                filters.append((field, str(raw_value or "")))

        all_rows = []
        filtered_rows = []
        header_files = _header_files_map()
        for doc in invoices_collection.order_by("createdAt", direction="DESCENDING").stream():
            row = _serialize(doc)
            _merge_header_files(row, header_files.get(_header_doc_id(row.get("invoice", ""))))
            all_rows.append(row)
            if _row_matches_filters(row, search, filters):
                filtered_rows.append(row)

        # The page reads "phase first, then invoice number" - same order as the
        # cards the user drilled down through.
        filtered_rows.sort(
            key=lambda row: (
                _text(row.get("phase")).lower(),
                _text(row.get("invoice")).lower(),
                _text(row.get("date")),
                _text(row.get("code")).lower(),
            )
        )

        # Distinct values per filterable field over the whole collection so the
        # PageFilter dropdown never loses options while a filter is active.
        filter_options = {
            key: sorted({_text(row.get(key)) for row in all_rows if _text(row.get(key))},
                        key=lambda value: value.lower())
            for key in sorted(_FILTER_FIELDS)
        }

        total_count = len(filtered_rows)
        total_pages = max(1, math.ceil(total_count / limit))
        page = min(page, total_pages)
        offset = (page - 1) * limit

        return jsonify({
            "success": True,
            "invoices": filtered_rows[offset:offset + limit],
            "filterOptions": filter_options,
            "pagination": {"page": page, "limit": limit, "totalCount": total_count,
                           "totalPages": total_pages, "hasNextPage": page < total_pages,
                           "hasPrevPage": page > 1},
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch Invoices: {exc}"}), 500


@invoice_bp.route("/invoices/groups", methods=["GET"])
@cached_read("invoices-groups", ttl_seconds=120)
def list_invoice_groups():
    """Card view for the Invoices page: one card per phase, then per invoice.

    Mirrors the PO Details drill-down (phase -> invoice -> line items) and
    groups case-insensitively so `po-12` / `PO-12` land on the same card.
    """
    try:
        groups = {}
        for doc in invoices_collection.order_by("createdAt", direction="DESCENDING").stream():
            row = _serialize(doc)
            phase_name = _text(row.get("phase")) or "Unassigned"
            invoice_name = _text(row.get("invoice")) or "Untitled Invoice"
            date = _text(row.get("date"))

            group = groups.setdefault(phase_name.lower(), {
                "phase": phase_name,
                "date": date,
                "rowCount": 0,
                "invoices": {},
            })
            group["rowCount"] += 1

            invoice = group["invoices"].setdefault(invoice_name.lower(), {
                "invoice": invoice_name,
                "date": date,
                "po": _text(row.get("po")),
                "rowCount": 0,
            })
            invoice["rowCount"] += 1

        payload = []
        for group in groups.values():
            group["invoices"] = sorted(
                group["invoices"].values(),
                key=lambda item: item["invoice"].lower(),
            )
            payload.append(group)

        payload.sort(key=lambda item: item["phase"].lower())

        return jsonify({"success": True, "phases": payload}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch invoice cards: {exc}"}), 500
 
 
@invoice_bp.route("/invoices/<invoice_id>", methods=["GET"])
def get_invoice(invoice_id):
    try:
        doc = invoices_collection.document(invoice_id).get()
        if not doc.exists:
            return jsonify({"success": False, "message": "Invoice not found"}), 404
        payload = _serialize(doc, include_image=True)
        # An invoice's files are shared by all of its lines and live on the
        # header, so a single-line read has to merge them in.
        data = doc.to_dict() or {}
        header = invoice_headers_collection.document(_header_doc_id(data.get("invoice", ""))).get()
        if header.exists:
            files = _attachment_files(header.to_dict() or {})
            if files:
                payload["attachments"] = files
                payload["attachmentCount"] = len(files)
                payload["hasImage"] = True
                payload["imageName"] = files[0]["name"]
        return jsonify({"success": True, "invoice": payload}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch Invoice: {exc}"}), 500


@invoice_bp.route("/invoices/images", methods=["GET"])
def list_invoice_images():
    """Files for a set of line ids, used by the attachment strip.

    Every line of an invoice reports the same set, because the files are stored
    once against the invoice number.
    """
    ids = [value.strip() for value in (request.args.get("ids") or "").split(",") if value.strip()]
    ids = ids[:MAX_IMAGE_IDS]
    if not ids:
        return jsonify({"success": True, "attachments": {}}), 200

    try:
        files = {}
        headers = {}
        for invoice_id in ids:
            doc = invoices_collection.document(invoice_id).get()
            if not doc.exists:
                continue
            data = doc.to_dict() or {}
            key = _header_doc_id(data.get("invoice", ""))
            if key not in headers:
                snapshot = invoice_headers_collection.document(key).get()
                headers[key] = _attachment_files(snapshot.to_dict() or {}) if snapshot.exists else []
            attachments = headers[key] or _attachment_files(data)
            if attachments:
                files[invoice_id] = attachments
        return jsonify({"success": True, "attachments": files}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch invoice attachments: {exc}"}), 500
 
 
@invoice_bp.route("/invoices/attachments/upload", methods=["POST"])
def upload_invoice_attachments():
    """Store files in Firebase Storage and return their metadata.

    The record only keeps that metadata, so an invoice can hold as many (and as
    large) files as the user likes - Firestore's 1 MiB limit does not apply.
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
 
 
@invoice_bp.route("/invoices/attachments", methods=["DELETE"])
def delete_invoice_attachments():
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
 
    # Renaming a line moves its invoice number, which must not land on a number
    # another invoice already owns.
    if "invoice" in update_fields:
        new_number = _text(update_fields.get("invoice"))
        if not new_number:
            return jsonify({"success": False, "message": "Invoice No cannot be blank"}), 400
        if _normalize_key(new_number) != _normalize_key(existing.get("invoice")):
            try:
                taken = [
                    doc_id
                    for doc_id, _ in _existing_invoice_lines(_normalize_key(new_number))
                    if doc_id != invoice_id
                ]
            except Exception as exc:
                return jsonify({"success": False, "message": f"Failed to verify Invoice No: {exc}"}), 500
            if taken:
                return jsonify({
                    "success": False,
                    "message": f"Invoice No {new_number} already exists.",
                }), 409

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

    if "attachments" in update_fields:
        try:
            update_fields["attachments"] = _attachments_payload(update_fields.get("attachments"), strict=True)
        except ValueError as exc:
            return jsonify({"success": False, "message": str(exc)}), 400
        # The invoice keeps one set of files, stored against its number, so the
        # change goes to the header and the line keeps no copy of its own.
        invoice_number = update_fields.get("invoice") or existing.get("invoice", "")
        try:
            invoice_headers_collection.document(_header_doc_id(invoice_number)).set({
                "invoice": invoice_number,
                "date": update_fields.get("date") or existing.get("date", ""),
                "phase": update_fields.get("phase") or existing.get("phase", ""),
                "attachments": update_fields["attachments"],
                "updatedAt": datetime.now(timezone.utc),
            }, merge=True)
        except Exception as exc:
            return jsonify({"success": False, "message": f"Failed to save invoice attachments: {exc}"}), 500
        update_fields.pop("attachments", None)
        # The list is now authoritative, so the legacy single-file fields are
        # cleared too - otherwise reads would fall back to them and a file the
        # user just deleted would reappear.
        update_fields["image"] = None
        update_fields["imageName"] = ""

    if "imageName" in update_fields:
        update_fields["imageName"] = _text(update_fields.get("imageName"))[:MAX_NAME_CHARS]
 
    try:
        update_fields["updatedAt"] = datetime.now(timezone.utc)
        doc_ref.update(update_fields)
        updated_doc = doc_ref.get()
        invalidate_read_cache()
        return jsonify({
            "success": True,
            "message": "Invoice updated",
            "invoice": _serialize(updated_doc, include_image=True),
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to update Invoice: {exc}"}), 500
 
 
@invoice_bp.route("/invoices/<invoice_id>", methods=["DELETE"])
def delete_invoice(invoice_id):
    try:
        doc_ref = invoices_collection.document(invoice_id)
        snapshot = doc_ref.get()
        if not snapshot.exists:
            return jsonify({"success": False, "message": "Invoice not found"}), 404

        # Stored files go with the record, so Storage does not fill up.
        try:
            delete_files(_attachment_files(snapshot.to_dict() or {}))
        except Exception:
            pass

        doc_ref.delete()
        _drop_invoice_header_if_orphaned(snapshot.to_dict() or {})
        invalidate_read_cache()
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
        removed = []
 
        for invoice_id in ids:
            doc_ref = invoices_collection.document(invoice_id)
            snapshot = doc_ref.get()
            if not snapshot.exists:
                missing_ids.append(invoice_id)
                continue
            data = snapshot.to_dict() or {}
            # Stored files go with the record.
            try:
                delete_files(_attachment_files(data))
            except Exception:
                pass
            batch.delete(doc_ref)
            removed.append(data)
            deleted_count += 1
 
        if deleted_count:
            batch.commit()
            # An invoice's files only go once its last line is gone.
            for data in removed:
                _drop_invoice_header_if_orphaned(data)
 
        if deleted_count == 0:
            return jsonify({
                "success": False,
                "message": "None of the selected Invoices could be found",
            }), 404
 
        message = f"{deleted_count} Invoice(s) deleted"
        if missing_ids:
            message += f" ({len(missing_ids)} were already removed)"
 
        invalidate_read_cache()

        return jsonify({
            "success": True,
            "message": message,
            "deletedCount": deleted_count,
            "missingIds": missing_ids,
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to delete Invoices: {exc}"}), 500
 

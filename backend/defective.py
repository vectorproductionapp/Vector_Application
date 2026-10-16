import json
import uuid
import math
from datetime import datetime, timezone
from urllib.parse import quote, unquote, urlparse

from flask import Blueprint, request, jsonify
from firebase_config import db, bucket
from auth_utils import roles_required
from read_cache import cached_read
from date_range import in_date_range, read_date_range

defects_bp = Blueprint("defects", __name__)
defects_collection = db.collection("defective_units")

REQUIRED_FIELDS = ["date", "make", "model", "serial", "part", "problem", "observations", "solution", "scratches", "dent", "status"]

ALLOWED_UPDATE_FIELDS = [
    "date", "make", "model", "serial", "part", "problem",
    "observations", "solution", "scratches", "dent", "status",
]


def _serialize(doc):
    d = doc.to_dict()
    return {
        "id": doc.id,
        "date": d.get("date"),
        "make": d.get("make"),
        "model": d.get("model"),
        "serial": d.get("serial"),
        "part": d.get("part"),
        "problem": d.get("problem"),
        "observations": d.get("observations", ""),
        "solution": d.get("solution", ""),
        "scratches": d.get("scratches", ""),
        "dent": d.get("dent", ""),
        "status": d.get("status"),
        "attachments": d.get("attachments", []),
        "createdAt": d.get("createdAt").isoformat() if d.get("createdAt") else None,
    }


def _upload_attachments(files):
    """Upload files and return Firebase download URLs without object ACLs."""
    urls = []
    for file in files:
        if not file or file.filename == "":
            continue
        ext = file.filename.rsplit(".", 1)[-1] if "." in file.filename else ""
        blob_name = f"defective-units/{uuid.uuid4().hex}.{ext}" if ext else f"defective-units/{uuid.uuid4().hex}"
        blob = bucket.blob(blob_name)
        download_token = str(uuid.uuid4())
        blob.metadata = {"firebaseStorageDownloadTokens": download_token}
        blob.upload_from_file(file, content_type=file.content_type)
        encoded_name = quote(blob_name, safe="")
        urls.append(
            f"https://firebasestorage.googleapis.com/v0/b/{bucket.name}/o/"
            f"{encoded_name}?alt=media&token={download_token}"
        )
    return urls


def _attachment_blob_name(url):
    """Extract an object path from legacy or Firebase download URLs."""
    parsed = urlparse(url)
    firebase_prefix = f"/v0/b/{bucket.name}/o/"
    if parsed.path.startswith(firebase_prefix):
        return unquote(parsed.path[len(firebase_prefix):])
    legacy_prefix = f"{bucket.name}/"
    if legacy_prefix in url:
        return unquote(url.split(legacy_prefix, 1)[1].split("?", 1)[0])
    return None


def _delete_attachment_blobs(urls):
    """Best-effort removal of the Storage objects behind these URLs."""
    removed = 0
    for url in urls or []:
        blob_path = _attachment_blob_name(url)
        if not blob_path:
            continue
        try:
            bucket.blob(blob_path).delete()
            removed += 1
        except Exception:
            # A missing object (or ACL rules) must not abort the record update.
            pass
    return removed


@defects_bp.route("/defects", methods=["POST"])
@roles_required("admin", "coadmin", "production_incharge")
def create_defect():
    data = request.form
    if not data:
        return jsonify({"success": False, "message": "Request must be form-data"}), 400

    missing = [f for f in REQUIRED_FIELDS if not str(data.get(f, "")).strip()]
    if missing:
        return jsonify({"success": False, "message": f"Missing required fields: {', '.join(missing)}"}), 400

    try:
        files = request.files.getlist("attachment")
        attachment_urls = _upload_attachments(files)

        doc_ref = defects_collection.document()
        created_at = datetime.now(timezone.utc)
        record = {
            "date": data.get("date", ""),
            "make": data.get("make", ""),
            "model": data.get("model", ""),
            "serial": data.get("serial", ""),
            "part": data.get("part", ""),
            "problem": data.get("problem", ""),
            "observations": data.get("observations", ""),
            "solution": data.get("solution", ""),
            "scratches": data.get("scratches", ""),
            "dent": data.get("dent", ""),
            "status": data.get("status", "Open"),
            "attachments": attachment_urls,
            "createdAt": created_at,
        }
        doc_ref.set(record)

        return jsonify({
            "success": True,
            "message": "Defective unit created",
            "id": doc_ref.id,
            **{k: record[k] for k in record if k != "createdAt"},
            "createdAt": created_at.isoformat(),
        }), 201
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to create defective unit: {exc}"}), 500


@defects_bp.route("/defects", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge")
@cached_read("defects", ttl_seconds=120)
def list_defects():
    try:
        try:
            page = max(1, int(request.args.get("page", 1)))
        except (TypeError, ValueError):
            page = 1
        try:
            limit = min(100, max(1, int(request.args.get("limit", 10))))
        except (TypeError, ValueError):
            limit = 10

        base_query = defects_collection.order_by("createdAt", direction="DESCENDING")

        # Search, PageFilter and the date range all run over the whole
        # collection first, then the page is cut, so nothing on another page is
        # silently missed.
        search = (request.args.get("q") or "").strip().lower()
        # Normalised through the shared helper so `DD-MM-YYYY` from the picker
        # and the stored `YYYY-MM-DD` text compare as the same day. This page has
        # a single date column, so `dateField` is fixed to it.
        _date_field, from_date, to_date = read_date_range(
            request.args, default_field="date"
        )
        filters = []
        for raw_field, raw_value in zip(request.args.getlist("filterField"),
                                        request.args.getlist("filterValue")):
            field = (raw_field or "").strip()
            if field in _DEFECT_FILTER_FIELDS:
                filters.append((field, str(raw_value or "").strip()))

        all_rows = [_serialize(doc) for doc in base_query.stream()]
        matching_rows = [row for row in all_rows
                         if _defect_row_matches(row, search, filters, from_date, to_date)]

        # Distinct values per filterable field over every defect, so the
        # PageFilter dropdown keeps its full option list while a filter is on.
        filter_options = {
            key: sorted({_defect_text(row.get(key)) for row in all_rows
                         if _defect_text(row.get(key))},
                        key=str.lower)
            for key in sorted(_DEFECT_FILTER_FIELDS)
        }

        total_count = len(matching_rows)
        total_pages = max(1, math.ceil(total_count / limit))
        page = min(page, total_pages)
        offset = (page - 1) * limit
        defects = matching_rows[offset:offset + limit]

        return jsonify({
            "success": True,
            "defects": defects,
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
        return jsonify({"success": False, "message": f"Failed to fetch defective units: {exc}"}), 500


# Columns the Defective Units search box scans (mirrors `columns` in
# DefectiveUnits.jsx).
_DEFECT_SEARCH_KEYS = ("date", "make", "model", "serial", "part", "problem",
                       "observations", "scratches", "dent", "status")

# Fields the PageFilter dropdown offers (mirrors DEFECT_FILTER_FIELDS).
_DEFECT_FILTER_FIELDS = frozenset({"make", "model", "part", "status"})


def _defect_text(value):
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return ", ".join(str(item) for item in value)
    return str(value).strip()


def _defect_row_matches(row, search, filters, from_date="", to_date=""):
    """True when a defect passes the active search, PageFilter and date range.

    Every comparison is case-insensitive so `open` / `Open` behave the same on
    both sides of the app.  This runs over the whole collection before the page
    is cut, so a hit on page 2 is still found while page 1 is on screen.
    """
    if search and not any(search in _defect_text(row.get(key)).lower() for key in _DEFECT_SEARCH_KEYS):
        return False
    for field, value in filters:
        if _defect_text(row.get(field)).lower() != value.lower():
            return False
    if from_date or to_date:
        row_date = row.get("date")
        if not in_date_range(row_date, from_date, to_date):
            return False
    return True


@defects_bp.route("/defects/bulk-delete", methods=["POST"])
@roles_required("admin", "coadmin", "production_incharge")
def bulk_delete_defects():
    """Delete the rows selected by the Defective Units toolbar."""
    data = request.get_json(silent=True) or {}
    ids = data.get("ids")
    if not isinstance(ids, list) or not ids:
        return jsonify({"success": False, "message": "No defective unit IDs provided"}), 400

    try:
        deleted = []
        missing = []
        batch = db.batch()

        # De-duplicate IDs so a repeated selection cannot inflate the count.
        for defect_id in dict.fromkeys(str(item) for item in ids if item):
            doc_ref = defects_collection.document(defect_id)
            if doc_ref.get().exists:
                batch.delete(doc_ref)
                deleted.append(defect_id)
            else:
                missing.append(defect_id)

        if deleted:
            batch.commit()

        if not deleted:
            return jsonify({
                "success": False,
                "message": "None of the selected defective units could be found",
                "missingIds": missing,
            }), 404

        return jsonify({
            "success": True,
            "message": f"Deleted {len(deleted)} defective unit(s)",
            "deletedCount": len(deleted),
            "missingIds": missing,
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to delete defective units: {exc}"}), 500


@defects_bp.route("/defects/<defect_id>", methods=["GET"])
@roles_required("admin", "coadmin", "production_incharge")
def get_defect(defect_id):
    try:
        doc = defects_collection.document(defect_id).get()
        if not doc.exists:
            return jsonify({"success": False, "message": "Defective unit not found"}), 404
        return jsonify({"success": True, "defect": _serialize(doc)}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to fetch defective unit: {exc}"}), 500


@defects_bp.route("/defects/<defect_id>", methods=["PUT"])
@roles_required("admin", "coadmin", "production_incharge")
def update_defect(defect_id):
    # Now accepts multipart/form-data (like create_defect) so edits can
    # include new attachment uploads, not just plain JSON text fields.
    data = request.form
    if not data:
        return jsonify({"success": False, "message": "Request must be form-data"}), 400

    update_fields = {k: v for k, v in data.items() if k in ALLOWED_UPDATE_FIELDS}

    try:
        doc_ref = defects_collection.document(defect_id)
        doc = doc_ref.get()
        if not doc.exists:
            return jsonify({"success": False, "message": "Defective unit not found"}), 404

        # Merge any newly uploaded files with the attachment list the client
        # asked to keep.  `keepAttachments` is a JSON array of the URLs that
        # survive this save; anything previously stored but absent from it is
        # removed from Storage as well as from the record.  When the field is
        # absent (an older client) every existing attachment is kept.
        existing_urls = [str(u) for u in (doc.to_dict().get("attachments") or []) if u]
        files = [f for f in request.files.getlist("attachment") if f and f.filename]

        # Uploading is the only step that can fail for reasons outside our
        # control (Storage auth, a disabled billing account).  Report it but
        # still apply the field edits and the attachment removals, so a failed
        # upload never blocks deleting a file or correcting the record.
        new_urls = []
        upload_error = ""
        if files:
            try:
                new_urls = _upload_attachments(files)
            except Exception as exc:
                upload_error = str(exc)

        raw_keep = data.get("keepAttachments")
        if raw_keep is None or str(raw_keep).strip() == "":
            keep = list(existing_urls)
        else:
            try:
                parsed_keep = json.loads(raw_keep)
                keep = [str(u) for u in parsed_keep if u] if isinstance(parsed_keep, list) else list(existing_urls)
            except (TypeError, ValueError):
                keep = list(existing_urls)

        # Never let a client smuggle in a URL that was not already stored.
        keep = [url for url in keep if url in existing_urls]
        final_urls = keep + new_urls
        removed_urls = [url for url in existing_urls if url not in keep]

        if new_urls or raw_keep is not None:
            update_fields["attachments"] = final_urls
        _delete_attachment_blobs(removed_urls)

        if not update_fields:
            return jsonify({"success": False, "message": "Nothing to update"}), 400

        doc_ref.update(update_fields)
        if upload_error:
            # The record saved; only the new file did not land.
            return jsonify({
                "success": False,
                "partial": True,
                "message": "Details saved, but the new attachment could not be uploaded to cloud storage.",
                "uploadError": upload_error,
                "attachments": final_urls,
                "removedAttachments": len(removed_urls),
            }), 207
        return jsonify({
            "success": True,
            "message": "Defective unit updated",
            "attachments": final_urls,
            "removedAttachments": len(removed_urls),
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to update defective unit: {exc}"}), 500


@defects_bp.route("/defects/<defect_id>/attachments", methods=["DELETE"])
@roles_required("admin", "coadmin", "production_incharge")
def delete_defect_attachments(defect_id):
    """Drop specific attachments from a defect record and from Storage.

    Body: `{"urls": ["<stored url>", ...]}`.  Only URLs that are currently on
    the record are touched, so a stale client cannot delete another row's file.
    """
    data = request.get_json(silent=True) or {}
    urls = data.get("urls")
    if not isinstance(urls, list) or not urls:
        return jsonify({"success": False, "message": "No attachment URLs supplied"}), 400

    try:
        doc_ref = defects_collection.document(defect_id)
        doc = doc_ref.get()
        if not doc.exists:
            return jsonify({"success": False, "message": "Defective unit not found"}), 404

        existing = [str(u) for u in (doc.to_dict().get("attachments") or []) if u]
        requested = {str(u) for u in urls}
        removed = [url for url in existing if url in requested]
        if not removed:
            return jsonify({"success": False, "message": "No matching attachments"}), 404

        kept = [url for url in existing if url not in requested]
        doc_ref.update({"attachments": kept})
        _delete_attachment_blobs(removed)
        return jsonify({
            "success": True,
            "message": f"Removed {len(removed)} attachment(s)",
            "attachments": kept,
            "removedCount": len(removed),
        }), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to delete attachments: {exc}"}), 500


@defects_bp.route("/defects/<defect_id>", methods=["DELETE"])
@roles_required("admin", "coadmin", "production_incharge")
def delete_defect(defect_id):
    try:
        doc_ref = defects_collection.document(defect_id)
        doc = doc_ref.get()
        if not doc.exists:
            return jsonify({"success": False, "message": "Defective unit not found"}), 404

        # best-effort cleanup of uploaded files
        for url in doc.to_dict().get("attachments", []):
            try:
                blob_path = _attachment_blob_name(url)
                if blob_path:
                    bucket.blob(blob_path).delete()
            except Exception:
                pass

        doc_ref.delete()
        return jsonify({"success": True, "message": "Defective unit deleted"}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to delete defective unit: {exc}"}), 500

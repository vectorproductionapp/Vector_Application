"""One place to find and download every file the app holds.

Uploaded files live with the record they belong to - invoice and PO headers
(and, on older records, their item lines) and defective-unit photos - so this
module only reads: it lists them and streams them back for download.  QC
reports are not uploads; they are generated in the browser from each unit's
saved `qcInspection`, so the listing hands that data to the client instead of a
file.

Nothing here writes. The zip endpoint is a POST only because its id list can
outgrow a URL; /documents has no live-refresh scope, so it broadcasts nothing.
"""

import base64
import io
import posixpath
import re
import zipfile
from datetime import datetime, timezone
from urllib.parse import unquote, urlparse

import requests
from firebase_admin import storage
from flask import Blueprint, Response, jsonify, request

from attachments import blob_name_from_url, entries_of
from auth_utils import roles_required
from dailyproduction import _qc_inspection_is_complete
from firebase_config import bucket, db
from invoice import _header_doc_id as invoice_header_id
from podetails import _header_doc_id as po_header_id

documents_bp = Blueprint("documents", __name__)

DOCUMENT_ROLES = ("admin", "coadmin", "production_incharge")

# Collections that hold uploaded files, and how each one is labelled.
_SOURCES = {
    "invoice_header": ("invoice_headers", "Invoice"),
    "invoice_line": ("invoices", "Invoice"),
    "po_header": ("po_headers", "PO"),
    "po_line": ("po_details", "PO"),
    "defect": ("defective_units", "Defect Photo"),
}

_CATEGORY_FOLDERS = {"Invoice": "Invoices", "PO": "PO Details", "Defect Photo": "Defect Photos"}

_DATA_URL = re.compile(r"^data:([\w.+-]+/[\w.+-]+);base64,(.+)$", re.DOTALL)

# A zip is built in memory, so cap how much one request may pull.
MAX_ZIP_FILES = 500
MAX_ZIP_BYTES = 300 * 1024 * 1024


def _text(value):
    return "" if value is None else str(value).strip()


def _storage_location(url):
    """`(bucket_name, object_path)` from any Firebase / GCS download URL.

    Unlike `blob_name_from_url`, the bucket is read from the URL itself, so a
    file uploaded while a different bucket was configured is still found.
    """
    if not url or url.startswith("data:"):
        return None, None
    parsed = urlparse(url)
    if parsed.netloc == "firebasestorage.googleapis.com":
        match = re.match(r"^/v0/b/([^/]+)/o/(.+)$", parsed.path)
        if match:
            return match.group(1), unquote(match.group(2))
    if parsed.netloc in ("storage.googleapis.com", "storage.cloud.google.com"):
        parts = parsed.path.lstrip("/").split("/", 1)
        if len(parts) == 2:
            return parts[0], unquote(parts[1])
    if parsed.netloc.endswith(".storage.googleapis.com"):
        return parsed.netloc[: -len(".storage.googleapis.com")], unquote(parsed.path.lstrip("/"))
    if parsed.scheme == "gs":
        return parsed.netloc, unquote(parsed.path.lstrip("/"))
    return None, None


def _defect_entries(data):
    """Defect photos: bare download URLs, or objects with url/path/data."""
    entries = []
    serial = _text(data.get("serial")) or "unit"
    raw = data.get("attachments")
    if raw is None:
        raw = data.get("attachment")
    for index, item in enumerate(raw if isinstance(raw, list) else [raw] if raw else []):
        if isinstance(item, dict):
            url = _text(item.get("url") or item.get("src"))
            path = _text(item.get("path"))
            inline = _text(item.get("data"))
            name = _text(item.get("name") or item.get("filename"))
            mime = _text(item.get("type"))
        else:
            url, path, inline, name, mime = _text(item), "", "", "", ""
        if url.startswith("data:"):
            inline, url = url, ""
        elif url and not urlparse(url).scheme:
            # A bare object path such as `defective-units/<id>.jpg`.
            path, url = path or url.lstrip("/"), ""
        if not (url or path or inline):
            continue
        if not path and url:
            path = _storage_location(url)[1] or ""
        if not mime and inline:
            match = _DATA_URL.match(inline)
            mime = match.group(1) if match else ""
        extension = posixpath.splitext(path or urlparse(url).path)[1] or (
            f".{mime.split('/')[-1]}" if "/" in mime else ".jpg")
        entries.append({
            "name": name or f"defect-{serial}-{index + 1}{extension}",
            "type": mime,
            "url": url,
            "path": path,
            "data": inline,
        })
    return entries


def _entries_for(source, data):
    return _defect_entries(data) if source == "defect" else entries_of(data)


def _describe(source, doc_id, data):
    """Reference, detail and date shown next to each file of a record."""
    if source.startswith("invoice"):
        return _text(data.get("invoice")), _text(data.get("phase")), _text(data.get("date"))
    if source.startswith("po"):
        return _text(data.get("po")), _text(data.get("supplier")) or _text(data.get("phase")), _text(data.get("date"))
    detail = " · ".join(part for part in (_text(data.get("model")), _text(data.get("part"))) if part)
    return _text(data.get("serial")), detail, _text(data.get("date"))


def _norm(value):
    """Comparison form of an invoice / PO number or phase name."""
    return re.sub(r"\s+", " ", _text(value)).casefold()


def _joined(values):
    """Distinct non-empty values in first-seen order, comma-joined."""
    seen = []
    for value in values:
        text = _text(value)
        if text and text not in seen:
            seen.append(text)
    return ", ".join(seen)


def _total(lines, key):
    total = 0.0
    found = False
    for line in lines:
        raw = line.get(key)
        if raw is None or _text(raw) == "":
            continue
        try:
            total += float(raw)
            found = True
        except (TypeError, ValueError):
            continue
    if not found:
        return ""
    return int(total) if float(total).is_integer() else round(total, 2)


def _lines_by(collection, *keys):
    """Every line of a collection, grouped by the normalised `keys`."""
    groups = {}
    for doc in db.collection(collection).stream():
        data = doc.to_dict() or {}
        groups.setdefault(tuple(_norm(data.get(key)) for key in keys), []).append(data)
    return groups


def _invoice_fields(record, lines):
    """All invoice parameters; a header's lines are the items on that invoice."""
    lines = lines or [record]
    return {
        "invoice": _text(record.get("invoice")),
        "invoiceDate": _text(record.get("date")) or _joined(line.get("date") for line in lines),
        "phase": _text(record.get("phase")) or _joined(line.get("phase") for line in lines),
        "po": _joined(line.get("po") for line in lines),
        "code": _joined(line.get("code") for line in lines),
        "desc": _joined(line.get("desc") for line in lines),
        "qtyInv": _total(lines, "qtyInv"),
        "qtyRecv": _total(lines, "qtyRecv"),
        "verifiedBy": _joined(line.get("verifiedBy") for line in lines),
        "lineCount": len([line for line in lines if line.get("code") or line.get("desc")]),
    }


def _basic_price(line):
    """Pre-GST amount of one PO line.

    Lines saved before `basicPrice` was stored lack it, so it is worked out as
    qty x rate (equal to value - gst), the same base the PO form computes.
    """
    stored = line.get("basicPrice")
    if stored is not None and _text(stored) != "":
        return stored
    try:
        return round(float(line.get("qty")) * float(line.get("rate")), 2)
    except (TypeError, ValueError):
        pass
    try:
        return round(float(line.get("value")) - float(line.get("gst") or 0), 2)
    except (TypeError, ValueError):
        return None


def _po_fields(record, lines):
    """All PO parameters; a header's lines are the items on that PO."""
    lines = lines or [record]
    return {
        "po": _text(record.get("po")),
        "supplier": _text(record.get("supplier")) or _joined(line.get("supplier") for line in lines),
        "poDate": _text(record.get("date")) or _joined(line.get("date") for line in lines),
        "phase": _text(record.get("phase")) or _joined(line.get("phase") for line in lines),
        "code": _joined(line.get("code") for line in lines),
        "desc": _joined(line.get("desc") for line in lines),
        "make": _joined(line.get("make") for line in lines),
        "model": _joined(line.get("model") for line in lines),
        "qty": _total(lines, "qty"),
        "rate": _joined(line.get("rate") for line in lines),
        "basicPrice": _total([{"basicPrice": _basic_price(line)} for line in lines], "basicPrice"),
        "gst": _total(lines, "gst"),
        "value": _total(lines, "value"),
        "expectedDeliveryDate": _joined(line.get("expectedDeliveryDate") for line in lines),
        "status": _joined(line.get("status") for line in lines),
        "lineCount": len([line for line in lines if line.get("code") or line.get("desc")]),
    }


def _defect_fields(record):
    return {key: _text(record.get(key)) for key in (
        "serial", "date", "make", "model", "part", "problem", "observations",
        "solution", "scratches", "dent", "status")}


def _scope(*records):
    """Which model(s) / phase(s) a document belongs to.

    Used by the Models page, whose card download picks the documents of one
    model or phase. IDs are the reliable link; names cover records that only
    store a name (invoice headers, defect reports).
    """
    model_ids, phase_ids, model_names, phase_names = set(), set(), set(), set()
    for record in records:
        if not isinstance(record, dict):
            continue
        if _text(record.get("modelId")):
            model_ids.add(_text(record.get("modelId")))
        if _text(record.get("phaseId")):
            phase_ids.add(_text(record.get("phaseId")))
        if _text(record.get("model")):
            model_names.add(_norm(record.get("model")))
        if _text(record.get("phase")):
            phase_names.add(_norm(record.get("phase")))
    return {
        "modelIds": sorted(model_ids),
        "phaseIds": sorted(phase_ids),
        "modelNames": sorted(model_names),
        "phaseNames": sorted(phase_names),
    }


def _collect_files():
    """Every uploaded file, one row each, with header copies listed once."""
    items = []
    seen = set()
    # Item lines, so a header row can show every parameter of its invoice / PO.
    invoice_lines = _lines_by("invoices", "invoice")
    po_lines = _lines_by("po_details", "po", "phase")
    # Show exactly the files the Invoices / PO Details pages show, so a file
    # deleted there never lingers here (or in a card download):
    # - Invoices: an invoice's header files stand for every line; a line's own
    #   files show only when the header has none (`list_invoice_images`).
    # - PO Details: a PO header counts only under the id the page looks it up
    #   by (`podetails._header_doc_id`); then it replaces the lines' files.
    #   Headers stored under an older id are never read by the page, so
    #   their stale copies are left out here too.
    invoice_headers_with_files = {
        doc.id for doc in db.collection("invoice_headers").stream()
        if entries_of(doc.to_dict() or {})
    }
    po_headers_in_use = set()
    for doc in db.collection("po_headers").stream():
        data = doc.to_dict() or {}
        page_id = po_header_id(data.get("modelId", ""), data.get("phaseId", ""), data.get("phase", ""), data.get("po", ""))
        if doc.id == page_id and entries_of(data):
            po_headers_in_use.add(doc.id)

    for source in ("invoice_header", "po_header", "invoice_line", "po_line", "defect"):
        collection, category = _SOURCES[source]
        for doc in db.collection(collection).stream():
            data = doc.to_dict() or {}
            if source == "po_header" and doc.id not in po_headers_in_use:
                continue
            if source == "invoice_line" and invoice_header_id(data.get("invoice", "")) in invoice_headers_with_files:
                continue
            if source == "po_line" and po_header_id(
                    data.get("modelId", ""), data.get("phaseId", ""), data.get("phase", ""), data.get("po", "")
            ) in po_headers_in_use:
                continue
            entries = _entries_for(source, data)
            if not entries:
                continue
            reference, detail, date = _describe(source, doc.id, data)
            # A header whose lines are all gone is a leftover: its invoice / PO
            # was deleted (e.g. with its phase) but the files stayed behind.
            record_status = "Active"
            # Only invoice / PO lines name the model (a PO line's "model" is
            # the part's model, not the product), so names come from the
            # header's phase and ids from the lines.
            if source == "invoice_header":
                lines = invoice_lines.get((_norm(data.get("invoice")),))
                fields = _invoice_fields(data, lines)
                scope = _scope({"phase": data.get("phase")}, *[
                    {"modelId": line.get("modelId"), "phaseId": line.get("phaseId"), "phase": line.get("phase")}
                    for line in lines or []])
                if not lines:
                    record_status = "Invoice deleted"
            elif source == "invoice_line":
                fields = _invoice_fields(data, [data])
                scope = _scope({k: data.get(k) for k in ("modelId", "phaseId", "phase")})
            elif source == "po_header":
                lines = po_lines.get((_norm(data.get("po")), _norm(data.get("phase"))))
                fields = _po_fields(data, lines)
                scope = _scope({k: data.get(k) for k in ("modelId", "phaseId", "phase")}, *[
                    {"modelId": line.get("modelId"), "phaseId": line.get("phaseId")} for line in lines or []])
                if not lines:
                    record_status = "PO deleted"
            elif source == "po_line":
                fields = _po_fields(data, [data])
                scope = _scope({k: data.get(k) for k in ("modelId", "phaseId", "phase")})
            else:
                fields = _defect_fields(data)
                # Defect reports carry the product model's name only.
                scope = _scope({"model": data.get("model")})
            for index, entry in enumerate(entries):
                key = entry.get("path") or entry.get("url") or (
                    category, reference.casefold(), entry.get("name"), entry.get("size"))
                if key in seen:
                    continue
                seen.add(key)
                items.append({
                    "id": f"{source}:{doc.id}:{index}",
                    "kind": "file",
                    "category": category,
                    "reference": reference,
                    "detail": detail,
                    "date": date,
                    "name": entry.get("name") or f"file-{index + 1}",
                    "type": entry.get("type") or "",
                    "size": entry.get("size"),
                    "recordStatus": record_status,
                    "scope": scope,
                    "fields": fields,
                })
    return items


def _collect_qc_reports():
    """Units with a completed QC report; the client renders each as a PDF."""
    reports = []
    for doc in db.collection("assembly_units").stream():
        data = doc.to_dict() or {}
        report = data.get("qcInspection")
        if not _qc_inspection_is_complete(report):
            continue
        serial = _text(data.get("serial"))
        reports.append({
            "id": f"qc:{doc.id}",
            "kind": "qc",
            "category": "QC Report",
            "reference": serial,
            "detail": " · ".join(part for part in (_text(data.get("model")), _text(data.get("phase"))) if part),
            "date": _text(report.get("inspectionDate")),
            "name": f"qc-report-{serial or doc.id}.pdf",
            "type": "application/pdf",
            "size": None,
            "model": _text(data.get("model")),
            "serial": serial,
            "qcInspection": report,
            "recordStatus": "Active",
            "scope": _scope({k: data.get(k) for k in ("modelId", "phaseId", "model", "phase")}),
            "fields": {
                "serial": serial,
                "model": _text(data.get("model")),
                "phase": _text(data.get("phase")),
                "stage": _text(data.get("stage")),
                "assembledBy": _text(data.get("assembledBy")),
                "assembledDate": _text(data.get("date")),
                "qcBy": _text(data.get("qcBy")),
                "qc": _text(data.get("qc")),
                "inspectionDate": _text(report.get("inspectionDate")),
                "checkedBy": _text(report.get("checkedBy")),
                "verifiedBy": _text(report.get("verifiedBy")),
                "authorizedBy": _text(report.get("authorizedBy")),
                "packagingStatus": _text(data.get("packagingStatus")),
            },
        })
    return reports


def _matches(item, category, search):
    if category and item["category"] != category:
        return False
    if search:
        haystack = " ".join(
            [_text(item.get(key)) for key in ("category", "reference", "detail", "date", "name")]
            + [_text(value) for value in (item.get("fields") or {}).values()]
        )
        if search not in haystack.casefold():
            return False
    return True


def _read_args():
    return _text(request.args.get("category")), _text(request.args.get("q")).casefold()


def _load_entry(item_id, with_record=False):
    """Resolve `source:doc:index` back to its stored entry (and its record)."""
    missing = (None, None, None) if with_record else (None, None)
    try:
        source, doc_id, index = item_id.split(":", 2)
        index = int(index)
    except ValueError:
        return missing
    if source not in _SOURCES:
        return missing
    snapshot = db.collection(_SOURCES[source][0]).document(doc_id).get()
    if not snapshot.exists:
        return missing
    data = snapshot.to_dict() or {}
    entries = _entries_for(source, data)
    if not 0 <= index < len(entries):
        return missing
    if with_record:
        return source, entries[index], data
    return source, entries[index]


def _file_bytes(entry):
    """Bytes and content type of one entry.

    Tried in order: inline data, the Storage object (in whichever bucket its
    URL names), then the download URL itself, which carries its own access
    token - so a file is still served when its path cannot be resolved.
    """
    data = _text(entry.get("data"))
    if data:
        match = _DATA_URL.match(data)
        if match:
            return base64.b64decode(match.group(2)), match.group(1)

    url = _text(entry.get("url"))
    url_bucket, url_path = _storage_location(url)
    path = _text(entry.get("path")) or url_path or blob_name_from_url(url) or ""
    errors = []
    if path:
        try:
            target = bucket
            if url_bucket and url_bucket != getattr(bucket, "name", None):
                target = storage.bucket(url_bucket)
            blob = target.blob(path)
            content = blob.download_as_bytes()
            return content, entry.get("type") or blob.content_type or "application/octet-stream"
        except Exception as exc:  # fall through to the URL
            errors.append(f"storage: {exc}")

    if url.startswith(("http://", "https://")):
        try:
            response = requests.get(url, timeout=30)
            response.raise_for_status()
            mime = entry.get("type") or response.headers.get("Content-Type") or "application/octet-stream"
            return response.content, mime.split(";")[0]
        except Exception as exc:
            errors.append(f"url: {exc}")

    if errors:
        detail = "; ".join(errors)
        if "billing account" in detail.lower():
            location = url_bucket or getattr(bucket, "name", "") or "cloud storage"
            raise FileNotFoundError(
                f"The file is stored in '{location}', but that Google Cloud project's billing "
                "account is closed, so Google refuses to serve it. Re-enable billing on that "
                "project to download it."
            )
        raise FileNotFoundError(detail)
    raise FileNotFoundError("This file has no stored location")


def _safe_name(name):
    cleaned = re.sub(r'[\\/:*?"<>|\r\n]+', "_", _text(name)).strip(" .")
    return cleaned or "file"


def _attachment_header(filename):
    ascii_name = filename.encode("ascii", "ignore").decode() or "file"
    return f'attachment; filename="{ascii_name}"'


@documents_bp.route("/documents", methods=["GET"])
@roles_required(*DOCUMENT_ROLES)
def list_documents():
    try:
        category, search = _read_args()
        items = _collect_files() + _collect_qc_reports()
        counts = {}
        for item in items:
            counts[item["category"]] = counts.get(item["category"], 0) + 1
        filtered = [item for item in items if _matches(item, category, search)]
        # Newest first; undated rows go last.
        filtered.sort(key=lambda item: item.get("date") or "", reverse=True)
        response = jsonify({"success": True, "documents": filtered, "counts": counts, "total": len(items)})
        response.headers["Cache-Control"] = "no-store"
        return response, 200
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to list documents: {exc}"}), 500


@documents_bp.route("/documents/download", methods=["GET"])
@roles_required(*DOCUMENT_ROLES)
def download_document():
    item_id = _text(request.args.get("id"))
    source, entry = _load_entry(item_id)
    if not entry:
        return jsonify({"success": False, "message": "File not found"}), 404
    try:
        content, mime = _file_bytes(entry)
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to download file: {exc}"}), 500
    return Response(content, mimetype=mime, headers={
        "Content-Disposition": _attachment_header(_safe_name(entry.get("name"))),
        "Cache-Control": "no-store",
    })


@documents_bp.route("/documents/zip", methods=["POST"])
@roles_required(*DOCUMENT_ROLES)
def download_documents_zip():
    """The uploaded files named in `ids`, as one zip.

    The page sends the ids of exactly the rows it shows (or the rows the user
    selected), so every filter - type, search, Filter dialog, date range - is
    honoured without being re-implemented here. QC reports are generated in the
    browser and are not part of the zip.

    A POST because the id list can be too long for a URL. It writes nothing:
    `scope_for_path` has no live scope for /documents, so no refresh is
    broadcast.
    """
    try:
        body = request.get_json(silent=True) or {}
        raw_ids = body.get("ids")
        if not isinstance(raw_ids, list):
            return jsonify({"success": False, "message": "ids must be a list"}), 400
        ids = []
        for value in raw_ids:
            item_id = _text(value)
            if item_id and not item_id.startswith("qc:") and item_id not in ids:
                ids.append(item_id)
        if not ids:
            return jsonify({"success": False, "message": "No uploaded files were selected"}), 400
        if len(ids) > MAX_ZIP_FILES:
            return jsonify({
                "success": False,
                "message": f"Too many files ({len(ids)}). Select {MAX_ZIP_FILES} or fewer.",
            }), 400

        buffer = io.BytesIO()
        used_names = set()
        total = 0
        failed = []
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for item_id in ids:
                source, entry, data = _load_entry(item_id, with_record=True)
                if not entry:
                    failed.append(f"{item_id} (record or file no longer exists)")
                    continue
                try:
                    content, _ = _file_bytes(entry)
                except Exception as exc:
                    failed.append(f"{entry.get('name') or item_id}: {exc}")
                    continue
                total += len(content)
                if total > MAX_ZIP_BYTES:
                    return jsonify({
                        "success": False,
                        "message": "The selected files are too large for one zip. Select fewer files and try again.",
                    }), 400
                category = _SOURCES[source][1]
                reference = _describe(source, "", data)[0]
                folder = _CATEGORY_FOLDERS.get(category, "Files")
                reference = _safe_name(reference) if reference else "Unreferenced"
                name = f"{folder}/{reference}/{_safe_name(entry.get('name'))}"
                base, extension = posixpath.splitext(name)
                counter = 2
                while name.casefold() in used_names:
                    name = f"{base} ({counter}){extension}"
                    counter += 1
                used_names.add(name.casefold())
                archive.writestr(name, content)
            if failed:
                archive.writestr(
                    "MISSING-FILES.txt",
                    "These files could not be read from storage:\n" + "\n".join(failed),
                )
        if failed and len(failed) == len(ids):
            return jsonify({
                "success": False,
                "message": "None of the selected files could be read. " + failed[0],
            }), 502

        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
        return Response(buffer.getvalue(), mimetype="application/zip", headers={
            "Content-Disposition": _attachment_header(f"vector-documents-{stamp}.zip"),
            "Cache-Control": "no-store",
        })
    except Exception as exc:
        return jsonify({"success": False, "message": f"Failed to build the zip: {exc}"}), 500

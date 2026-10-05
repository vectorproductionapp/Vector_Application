"""Shared attachment handling for PO lines and invoices.

Files live in Firebase Storage (the same bucket the defective-unit photos use),
so a record can hold as many files as the user likes without hitting Firestore's
1 MiB document limit - the document only stores small metadata per file:

    {"name": "po-scan.jpg", "type": "image/jpeg", "size": 48213,
     "url": "https://firebasestorage.../po-attachments/<id>", "path": "po-attachments/<id>"}

Records written before this existed keep their inline `data:` URLs; both shapes
are handled on read so nothing is lost.
"""

import base64
import re
import uuid
from urllib.parse import quote, unquote, urlparse

from firebase_config import bucket

# A pragmatic guard against a runaway multi-select, not a storage limit.
MAX_FILES = 40

# Inline (legacy) attachments still have to fit inside the Firestore document.
MAX_INLINE_TOTAL_CHARS = 900_000
MAX_NAME_CHARS = 160

_DATA_URL = re.compile(r"^data:([\w.+-]+/[\w.+-]+);base64,(.+)$", re.DOTALL)

# Extensions we name explicitly when a file arrives without one.
_MIME_EXTENSIONS = {
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "text/plain": "txt",
    "text/csv": "csv",
    "application/zip": "zip",
}


def _download_url(blob_name, token):
    return (
        f"https://firebasestorage.googleapis.com/v0/b/{bucket.name}/o/"
        f"{quote(blob_name, safe='')}?alt=media&token={token}"
    )


def _extension_for(mime):
    ext = _MIME_EXTENSIONS.get(mime, (mime.split("/")[-1] or "bin").replace("+xml", ""))
    return re.sub(r"[^a-z0-9]", "", ext.lower())[:8] or "bin"


def _derived_name(mime, context=None):
    """A real file name for an entry that was stored without one.

    Older records kept only the bytes in `image` with no `imageName`, which made
    the UI fall back to a generic "Attached PDF".  Naming it after the record it
    belongs to (item code, invoice number or PO number) is far more useful.
    """
    source = context or {}
    base = ""
    for field in ("code", "invoice", "po"):
        value = str(source.get(field) or "").strip()
        if value:
            base = value
            break
    base = re.sub(r"[\\/:*?\"<>|]", "-", base)[:80]
    return f"{base}.{_extension_for(mime)}" if base else f"document.{_extension_for(mime)}"


_PLACEHOLDER_BUCKETS = ("your-project-id", "your-project", "your_bucket", "example")


def storage_configured():
    """False when FIREBASE_STORAGE_BUCKET is still the placeholder value.

    Uploads then fall back to inline storage, so the feature keeps working (with
    Firestore's size ceiling) until a real bucket is configured.
    """
    name = (getattr(bucket, "name", "") or "").strip()
    if not name:
        return False
    return not any(marker in name for marker in _PLACEHOLDER_BUCKETS)


def upload_files(prefix, files):
    """Store `[{name, type, data}]` and return `(entries, used_storage)`.

    `data` is a data URL (what the browser produces after compressing an image).
    With a real Storage bucket the bytes go to Storage and the entry carries a
    download URL; otherwise they are kept inline on the record, subject to
    Firestore's document limit.
    """
    entries = []
    inline_budget = 0
    use_storage = storage_configured()

    for item in files or []:
        if not isinstance(item, dict):
            continue
        match = _DATA_URL.match(str(item.get("data") or "").strip())
        if not match:
            continue
        mime, payload = match.group(1), match.group(2)
        try:
            blob_bytes = base64.b64decode(payload, validate=False)
        except Exception:
            continue

        safe_name = (str(item.get("name") or "").strip() or "file")[:MAX_NAME_CHARS]
        if safe_name == "file":
            # The client sent no name: keep the extension meaningful rather than
            # storing a bare "file", so the list never shows a generic label.
            safe_name = f"document.{_extension_for(mime)}"
        stored = False

        if use_storage:
            try:
                extension = safe_name.rsplit(".", 1)[-1].lower() if "." in safe_name else _extension_for(mime)
                extension = re.sub(r"[^a-z0-9]", "", extension)[:8] or "bin"
                blob_name = f"{prefix}/{uuid.uuid4().hex}.{extension}"
                blob = bucket.blob(blob_name)
                token = str(uuid.uuid4())
                blob.metadata = {"firebaseStorageDownloadTokens": token, "name": safe_name}
                blob.upload_from_string(blob_bytes, content_type=mime)
                entries.append({
                    "name": safe_name,
                    "type": mime,
                    "size": len(blob_bytes),
                    "url": _download_url(blob_name, token),
                    "path": blob_name,
                })
                stored = True
            except Exception:
                # Bucket missing/unreachable: fall back to inline for this file.
                use_storage = False

        if not stored:
            data = f"data:{mime};base64,{payload}"
            inline_budget += len(data)
            if inline_budget > MAX_INLINE_TOTAL_CHARS:
                raise ValueError("Attachments are too large in total; please use smaller files")
            entries.append({"name": safe_name, "type": mime, "data": data})

    return entries, use_storage


def delete_files(entries):
    """Remove the Storage objects behind the given metadata entries."""
    removed = 0
    for item in entries or []:
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or "").strip()
        if not path:
            url = str(item.get("url") or "")
            if url:
                path = blob_name_from_url(url) or ""
        if not path:
            continue
        try:
            bucket.blob(path).delete()
            removed += 1
        except Exception:
            continue
    return removed


def blob_name_from_url(url):
    """Recover the object path from a Firebase Storage download URL."""
    if not url:
        return None
    parsed = urlparse(url)
    prefix = f"/v0/b/{bucket.name}/o/"
    if parsed.path.startswith(prefix):
        return unquote(parsed.path[len(prefix):])
    legacy = f"{bucket.name}/"
    if legacy in url:
        return unquote(url.split(legacy, 1)[1].split("?", 1)[0])
    return None


def _entry(item, strict=False, inline_budget=None, context=None):
    """Normalise one stored entry (Storage URL and/or legacy inline data)."""
    if not isinstance(item, dict):
        return None

    name = str(item.get("name") or "").strip()[:MAX_NAME_CHARS]
    mime = str(item.get("type") or "").strip()[:80]
    url = str(item.get("url") or "").strip()

    data = str(item.get("data") or "").strip()
    if not url and data:
        match = _DATA_URL.match(data)
        if not match:
            if strict:
                raise ValueError("Attachment must be an uploaded image or PDF")
            return None
        mime = mime or match.group(1)
        data = data[:MAX_INLINE_TOTAL_CHARS]
        if inline_budget is not None:
            inline_budget[0] += len(data)
    else:
        data = ""

    if not url and not data:
        return None

    if not name:
        # Never leave a file nameless: the UI would show a generic label.
        name = _derived_name(mime, context)

    entry = {"name": name, "type": mime}
    if url:
        entry["url"] = url
        path = str(item.get("path") or "").strip() or (blob_name_from_url(url) or "")
        if path:
            entry["path"] = path
    if data:
        entry["data"] = data
    if item.get("size") is not None:
        try:
            entry["size"] = int(item["size"])
        except (TypeError, ValueError):
            pass
    return entry


def normalise_entries(value, strict=False, context=None):
    """Validate a submitted attachment list; returns the cleaned list."""
    if value is None:
        return None
    if not isinstance(value, list):
        if strict:
            raise ValueError("Attachments must be a list of files")
        return None

    budget = [0]
    entries = []
    for item in value:
        entry = _entry(item, strict=strict, inline_budget=budget, context=context)
        if entry:
            entries.append(entry)

    if len(entries) > MAX_FILES:
        if strict:
            raise ValueError(f"You can attach up to {MAX_FILES} files")
        entries = entries[:MAX_FILES]
    if budget[0] > MAX_INLINE_TOTAL_CHARS:
        if strict:
            raise ValueError("Attachments are too large in total; please use smaller files")
        return None
    return entries


def entries_of(data):
    """Every file of a stored document, whichever shape it was written in."""
    entries = []
    for item in (data or {}).get("attachments") or []:
        entry = _entry(item, context=data)
        if entry:
            entries.append(entry)

    if not entries:
        # Legacy single-file shape: the bytes were kept in `image` and the name,
        # when it was kept at all, in `imageName`.
        legacy = _entry({
            "name": (data or {}).get("imageName"),
            "type": None,
            "data": (data or {}).get("image"),
        }, context=data)
        if legacy:
            entries.append(legacy)
    return entries

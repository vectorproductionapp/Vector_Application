"""Clean up the files that belong to invoice and PO records being deleted.

Invoice files are stored once per invoice number (`invoice_headers`), and older
PO files once per PO (`po_headers`), separately from the item lines. Deleting
lines from the Invoices / PO pages already drops a header once its last line
is gone, but the cascades in models.py (deleting a model, a phase or an Item
Code) deleted lines directly and left those headers - and their files - behind.
Those leftovers then still showed in Stock Register > Documents.

Only the invoice numbers / POs touched by a deletion are checked, so older
leftovers are never removed as a side effect of an unrelated delete.
"""

import re

from attachments import delete_files, entries_of
from firebase_config import db
from invoice import _drop_invoice_header_if_orphaned


def _norm(value):
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def release_line_files(data):
    """Delete the stored files of one invoice / PO line about to be removed."""
    try:
        delete_files(entries_of(data or {}))
    except Exception:
        # A file that cannot be reached must not block the record delete.
        pass


def drop_orphaned_headers(invoice_lines=(), po_lines=()):
    """Remove headers (and their files) whose last line was just deleted.

    `invoice_lines` / `po_lines` are the data of the lines that were removed.
    """
    seen_invoices = set()
    for data in invoice_lines:
        number = _norm((data or {}).get("invoice"))
        if not number or number in seen_invoices:
            continue
        seen_invoices.add(number)
        _drop_invoice_header_if_orphaned(data)

    po_keys = {(_norm(d.get("po")), _norm(d.get("phase"))) for d in po_lines if d and d.get("po")}
    if not po_keys:
        return
    try:
        remaining = set()
        for doc in db.collection("po_details").stream():
            data = doc.to_dict() or {}
            remaining.add((_norm(data.get("po")), _norm(data.get("phase"))))
        for header in db.collection("po_headers").stream():
            data = header.to_dict() or {}
            key = (_norm(data.get("po")), _norm(data.get("phase")))
            if key in po_keys and key not in remaining:
                release_line_files(data)
                header.reference.delete()
    except Exception:
        pass

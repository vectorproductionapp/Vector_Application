"""Shared inclusive date-range filtering for the paged list endpoints.

Firestore cannot compare two date columns in one query, so a toolbar date range
is applied here over the rows an endpoint is already walking. Every list page
stores its dates in one of a few shapes - ISO text, DD-MM-YYYY text, or a
Firestore Timestamp - so the normalisation lives in one place instead of being
re-invented per endpoint.

Query contract (all paged list endpoints):

    ?dateField=<column>
    &filterField=dateFrom&filterValue=YYYY-MM-DD
    &filterField=dateTo&filterValue=YYYY-MM-DD

`dateFrom`/`dateTo` ride along with the ordinary repeated filter pairs so the
frontend can build them with the same helper it uses for the PageFilter modal.
A row is kept when its own date falls inside the range; a row with no date at
all cannot satisfy a range and is dropped, which is what makes "pick a range
with no records" report nothing rather than quietly returning everything.
"""

import re
from datetime import date, datetime, timezone


# DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY, and the two-digit-year variants.
_DMY_RE = re.compile(r"^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})")
# A bare epoch value, which Firestore hands back for Timestamp fields.
_EPOCH_RE = re.compile(r"^\d{10,13}$")


def normalize_date(value):
    """Return `value` as `YYYY-MM-DD`, or `""` when it is not a usable date.

    Accepts datetime/date objects, Firestore Timestamps, ISO strings and
    timestamps (`2026-10-09T12:33:00Z`), epoch seconds/milliseconds, and the
    DD-MM-YYYY text the forms submit.
    """
    if value is None or value == "":
        return ""

    # Firestore Timestamp, or a plain datetime/date.
    if hasattr(value, "tzinfo") and hasattr(value, "year"):
        return value.strftime("%Y-%m-%d")
    if hasattr(value, "date") and callable(value.date) and not isinstance(value, str):
        # google-cloud Timestamp: prefer its .date() over the naive .year pair
        # because a Timestamp constructed from a naive datetime reads as UTC.
        parsed = getattr(value, "datetime", None)
        if parsed is not None:
            return parsed.strftime("%Y-%m-%d")
        return value.date().strftime("%Y-%m-%d")

    text = str(value).strip()
    if not text:
        return ""

    # Already ISO: 2026-10-09, optionally with a time part.
    if len(text) >= 10 and text[4] == "-" and text[7] == "-":
        return text[:10]

    if _EPOCH_RE.match(text):
        number = int(text)
        # Ten digits is seconds, thirteen is milliseconds.
        if len(text) == 13:
            number //= 1000
        try:
            return datetime.fromtimestamp(number, tz=timezone.utc).strftime("%Y-%m-%d")
        except (OverflowError, OSError, ValueError):
            return ""

    match = _DMY_RE.match(text)
    if match:
        day, month, year = match.groups()
        year = int(year)
        if year < 100:
            year += 2000
        try:
            return date(year, int(month), int(day)).strftime("%Y-%m-%d")
        except ValueError:
            return ""

    # Anything else: let Python try the obvious layouts before giving up.
    for layout in ("%Y/%m/%d", "%d/%m/%Y", "%m/%d/%Y", "%Y%m%d", "%b %d, %Y", "%d %b %Y"):
        try:
            return datetime.strptime(text[:len(layout) + 8].strip(), layout).strftime("%Y-%m-%d")
        except ValueError:
            continue

    return ""


def read_date_range(args, default_field="date"):
    """Pull the range out of a request's repeated filter params.

    Returns `(field, start, end)`. `start`/`end` are `""` when the caller did
    not send that side, and `field` falls back to `default_field` so endpoints
    with a single obvious date column need not send `dateField` at all.
    """
    field = (args.get("dateField") or "").strip() or default_field
    start = ""
    end = ""
    for raw_field, raw_value in zip(args.getlist("filterField"), args.getlist("filterValue")):
        name = (raw_field or "").strip()
        if name == "dateFrom":
            start = normalize_date(raw_value)
        elif name == "dateTo":
            end = normalize_date(raw_value)
    return field, start, end


def in_date_range(value, start, end):
    """Whether `value` sits inside the inclusive range.

    An empty side means "unbounded". When a range is active but the row has no
    readable date the row is rejected - otherwise selecting a range that
    contains nothing would still list every undated row.
    """
    start = normalize_date(start)
    end = normalize_date(end)
    if not start and not end:
        return True
    day = normalize_date(value)
    if not day:
        return False
    if start and day < start:
        return False
    if end and day > end:
        return False
    return True
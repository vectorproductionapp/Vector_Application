"""Optional, backward-compatible response trimming for list endpoints.

Callers can ask for less data:

* `?includeAllRows=0` drops `allRows` (every matching row, used only by
  Export Excel) from the response.  Without the parameter `allRows` is
  returned as before.
* `?fields=id,serial,model` keeps only those keys in each row (`id` is
  always kept).  Without it every field is returned as before.
"""


def wants_all_rows(args):
    value = str(args.get("includeAllRows", "1")).strip().lower()
    return value not in {"0", "false", "no", "off"}


def requested_fields(args):
    raw = str(args.get("fields") or "").strip()
    if not raw:
        return None
    fields = {part.strip() for part in raw.split(",") if part.strip()}
    return (fields | {"id"}) if fields else None


def select_fields(rows, fields):
    """Rows with only `fields` kept; unchanged when `fields` is None."""
    if not fields:
        return rows
    return [
        {key: value for key, value in row.items() if key in fields} if isinstance(row, dict) else row
        for row in rows
    ]


def parse_optional_page(args, default_limit=50, max_limit=500):
    """(page, limit) when the caller passed `limit` or `page`, else None."""
    if args.get("limit") is None and args.get("page") is None:
        return None
    try:
        page = int(args.get("page", 1))
    except (TypeError, ValueError):
        page = 1
    try:
        limit = int(args.get("limit", default_limit))
    except (TypeError, ValueError):
        limit = default_limit
    return max(1, page), min(max_limit, max(1, limit))

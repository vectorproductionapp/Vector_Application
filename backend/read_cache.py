"""Read-through helpers for the paged list endpoints.

The Firestore-backed read cache is deliberately switched off.  Every endpoint
decorated with `cached_read` now answers straight from Firestore, so a screen
can never show a stored copy of an older response - what the user sees is what
the database holds at that moment.

The two names below are kept because nineteen endpoints import them:

    @cached_read("invoices", ttl_seconds=120)   -> now a pass-through
    invalidate_read_cache()                     -> now a no-op

`ttl_seconds` is accepted and ignored so the call sites stay untouched and the
change stays a single-file revert.  With no cache there is nothing to
invalidate, which also removes the whole class of "I saved but the page still
shows the old value" bugs that a forgotten invalidation used to cause.
"""


def cached_read(name, ttl_seconds=120):
    """Return the view unchanged: no response is read from or written to a cache."""
    def decorate(view):
        return view
    return decorate


def invalidate_read_cache():
    """No-op: there is no cache to invalidate."""
    return None

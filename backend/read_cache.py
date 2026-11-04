"""Read-through helpers for the list endpoints.

Most endpoints decorated with `cached_read` answer straight from Firestore:
for them the decorator is a pass-through, so a table always shows what the
database holds.

Only the names in MEMORY_TTL_SECONDS are cached, in this process's memory,
for a short time.  `/dashboard` reads every production collection and is
requested several times within a few seconds (page load, model switch,
refresh after a save), so a 45-second copy saves most of those reads:

* the key is the caller (user id + role) plus the full query string, so one
  user never sees another user's numbers;
* any successful write in this process calls `invalidate_read_cache()`, so the
  user who saved sees the new numbers at once;
* every write also stamps `realtime_notices/_any`.  Before serving a copy,
  the cache reads that one document and drops the copy if anything changed
  after it was computed, so other instances never serve stale numbers;
* identical requests that arrive together wait for one computation instead of
  each reading Firestore.
"""

import threading
import time
from functools import wraps

from flask import Response, request

# name -> seconds a cached response stays valid.
MEMORY_TTL_SECONDS = {"dashboard": 45}
MAX_ENTRIES = 200

# Saves stamped up to this many seconds before a copy was computed still
# count as newer (allows for clock skew between instances and Firestore).
CLOCK_SKEW_SECONDS = 2

_entries = {}  # key -> (expires_at, computed_at_epoch, body_bytes, status, content_type)
_key_locks = {}
_lock = threading.Lock()
_generation = [0]


def _cache_key(name):
    user = getattr(request, "user", None) or {}
    return (name, str(user.get("sub") or ""), str(user.get("role") or ""), request.full_path)


def _key_lock(key):
    with _lock:
        lock = _key_locks.get(key)
        if lock is None:
            lock = _key_locks[key] = threading.Lock()
        return lock


def _last_change_time():
    try:
        from realtime_notices import last_change_time

        return last_change_time()
    except Exception:
        # Firestore unreachable: fall back to the TTL alone.
        return None


def _cached_response(key):
    with _lock:
        entry = _entries.get(key)
        if not entry:
            return None
        expires_at, computed_at, body, status, content_type = entry
        if expires_at <= time.monotonic():
            _entries.pop(key, None)
            return None
    changed_at = _last_change_time()
    if changed_at is not None and changed_at >= computed_at - CLOCK_SKEW_SECONDS:
        with _lock:
            if _entries.get(key) is entry:
                _entries.pop(key, None)
        return None
    response = Response(body, status=status, content_type=content_type)
    # Not "hit": the browser's own GET cache skips storing responses marked
    # "hit" (see src/components/Api.js).
    response.headers["X-Vector-Cache"] = "memory"
    return response


def cached_read(name, ttl_seconds=120):
    """Cache the view in memory when `name` is listed in MEMORY_TTL_SECONDS.

    `ttl_seconds` is the old Firestore-cache setting and is ignored.
    """
    memory_ttl = MEMORY_TTL_SECONDS.get(name)

    def decorate(view):
        if not memory_ttl:
            return view

        @wraps(view)
        def wrapper(*args, **kwargs):
            if request.method != "GET":
                return view(*args, **kwargs)
            key = _cache_key(name)
            cached = _cached_response(key)
            if cached is not None:
                return cached
            with _key_lock(key):
                # Another thread may have filled it while this one waited.
                cached = _cached_response(key)
                if cached is not None:
                    return cached
                generation = _generation[0]
                computed_at = time.time()
                result = view(*args, **kwargs)
                response = result
                status = None
                if isinstance(result, tuple):
                    response, status = result[0], (result[1] if len(result) > 1 else None)
                if isinstance(response, Response):
                    status = status or response.status_code
                    # Skip storing when a write happened meanwhile: the
                    # numbers just computed may already be out of date.
                    if status == 200 and generation == _generation[0]:
                        with _lock:
                            if len(_entries) >= MAX_ENTRIES:
                                _entries.clear()
                            _entries[key] = (
                                time.monotonic() + memory_ttl,
                                computed_at,
                                response.get_data(),
                                status,
                                response.content_type,
                            )
                return result

        return wrapper

    return decorate


def invalidate_read_cache():
    """Drop every in-memory copy (called after each successful write)."""
    with _lock:
        _generation[0] += 1
        _entries.clear()
        _key_locks.clear()

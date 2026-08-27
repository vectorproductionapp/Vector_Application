"""Shared Firestore-backed read cache for expensive page endpoints.

The cache stores the already-built API payload, not a second copy of the
business data.  Every successful data write advances one version document, so
old page snapshots are immediately bypassed without changing existing logic.
"""

import hashlib
import time
from functools import wraps

from firebase_admin import firestore
from flask import jsonify, make_response, request

from firebase_config import db


_VERSION_REF = db.collection("_system_cache").document("read_version")
_CACHE_COLLECTION = db.collection("_system_read_cache")


def _scope():
    user = getattr(request, "user", {}) or {}
    # Never share a response between roles or users.
    return f"{user.get('role', 'anonymous')}:{user.get('sub') or user.get('id') or user.get('userId') or user.get('email', 'anonymous')}"


def _cache_id(name):
    query = "&".join(f"{key}={value}" for key, value in sorted(request.args.items(multi=True)))
    value = f"{name}|{request.path}|{query}|{_scope()}"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _version():
    snapshot = _VERSION_REF.get()
    return int((snapshot.to_dict() or {}).get("value", 0)) if snapshot.exists else 0


def cached_read(name, ttl_seconds=120):
    """Cache a successful JSON GET response in Firestore for a short period."""
    def decorate(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            cache_id = _cache_id(name)
            try:
                version = _version()
                cached = _CACHE_COLLECTION.document(cache_id).get()
                entry = cached.to_dict() if cached.exists else None
                if entry and entry.get("version") == version and entry.get("expiresAt", 0) > time.time():
                    response = jsonify(entry["payload"])
                    response.headers["X-Vector-Read-Cache"] = "hit"
                    return response, int(entry.get("status", 200))
            except Exception:
                # Caching is an optimization; a cache outage must never block data.
                version = None

            response = make_response(view(*args, **kwargs))
            payload = response.get_json(silent=True)
            if response.status_code < 300 and isinstance(payload, (dict, list)) and version is not None:
                try:
                    _CACHE_COLLECTION.document(cache_id).set({
                        "version": version,
                        "status": response.status_code,
                        "payload": payload,
                        "expiresAt": time.time() + ttl_seconds,
                        "updatedAt": firestore.SERVER_TIMESTAMP,
                    })
                    response.headers["X-Vector-Read-Cache"] = "miss"
                except Exception:
                    pass
            return response
        return wrapped
    return decorate


def invalidate_read_cache():
    """Make all existing cache entries stale in one lightweight write."""
    try:
        _VERSION_REF.set({
            "value": firestore.Increment(1),
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }, merge=True)
    except Exception:
        pass

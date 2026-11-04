"""Live "something changed" notices through Firestore.

This replaces the old always-open ``/ws`` WebSocket.  Open browser sockets kept
a Cloud Run request open around the clock, and Cloud Run bills for every second
a request is open.  Now:

1. After every successful POST/PUT/PATCH/DELETE, the request writes one small
   document, ``realtime_notices/{scope}`` = ``{action, updatedAt, updatedBy}``.
2. The browser listens to those documents directly in Firestore
   (``onSnapshot``) and refetches only the scope that changed.  That listener
   talks to Firestore, not to Cloud Run, so an idle tab costs nothing here.
3. Browsers sign in to Firebase with a custom token from
   ``POST /realtime/token`` (the app's own JWT is required).  The Firestore
   rules let only signed-in custom-token users read ``realtime_notices``, and
   nobody but this backend (Admin SDK) can write them.

Cloud Run needs one IAM grant for the token endpoint: the service account must
be able to sign tokens (``roles/iam.serviceAccountTokenCreator`` on itself).
See deployment/README.md.
"""

import logging

from flask import Blueprint, jsonify, request

from auth_utils import token_required

log = logging.getLogger("vector.realtime_notices")

NOTICES_COLLECTION = "realtime_notices"
# One extra doc stamped on every change, whatever the scope: the dashboard
# cache on every instance reads it (one read) to know whether its copy is
# older than the last save anywhere.
ANY_CHANGE_DOC = "_any"

# Request-path prefix -> live-update scope.  First match wins.
SCOPES_BY_PREFIX = (
    ("/po-details", "po_details"),
    ("/invoices", "invoices"),
    ("/assembly", "assembly_units"),
    ("/sales", "sales"),
    ("/defect", "defectives"),
    ("/stock-register", "stock_register"),
)

# A phase's BOQ lives under /models/<model>/phases/<phase>/boq, and a phase
# under /models/<model>/phases, so those are matched separately.
BOQ_PATH_MARKER = "/boq"


def last_change_time():
    """When anything last changed (epoch seconds), or None if unknown."""
    from firebase_config import db

    snapshot = db.collection(NOTICES_COLLECTION).document(ANY_CHANGE_DOC).get()
    if not snapshot.exists:
        return None
    updated_at = (snapshot.to_dict() or {}).get("updatedAt")
    return updated_at.timestamp() if hasattr(updated_at, "timestamp") else None


def scope_for_path(path):
    """Which live scope a successful write to `path` belongs to."""
    clean = (path or "").rstrip("/")
    if clean == "/models" or "/models/" in clean:
        if clean.endswith(BOQ_PATH_MARKER):
            return "boq"
        if "/phases" in clean:
            return "phases"
        return "models"
    for prefix, scope in SCOPES_BY_PREFIX:
        if clean.startswith(prefix):
            return scope
    return None


def record_change(scope, action="write", actor=None):
    """Write the `realtime_notices/{scope}` doc that open browsers listen to.

    A failure here must never fail the user's save, so it is logged and
    swallowed: the worst case is that other tabs refresh on their next load.
    """
    if not scope:
        return False
    try:
        from firebase_admin import firestore
        from firebase_config import db

        notices = db.collection(NOTICES_COLLECTION)
        batch = db.batch()
        batch.set(notices.document(scope), {
            "action": action,
            "updatedAt": firestore.SERVER_TIMESTAMP,
            "updatedBy": actor or "",
        })
        batch.set(notices.document(ANY_CHANGE_DOC), {
            "scope": scope,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
        batch.commit()
        return True
    except Exception:
        log.warning("could not write realtime notice scope=%s", scope, exc_info=True)
        return False


realtime_bp = Blueprint("realtime", __name__)


@realtime_bp.route("/realtime/token", methods=["POST"])
@token_required
def realtime_token():
    """A Firebase custom token so the browser can read `realtime_notices`.

    The browser calls this once per sign-in; Firebase then refreshes its own
    session with Google directly, so this endpoint is not called again while
    the tab stays open.
    """
    user_id = str(request.user.get("sub") or "").strip()
    if not user_id:
        return jsonify({"success": False, "message": "Invalid session"}), 401
    try:
        from firebase_admin import auth

        token = auth.create_custom_token(
            f"vector-{user_id}"[:128],
            {"vectorRole": str(request.user.get("role") or "")},
        )
        if isinstance(token, bytes):
            token = token.decode("utf-8")
        return jsonify({"success": True, "token": token}), 200
    except Exception as exc:
        # Live updates are optional: the page keeps working without them.
        log.warning("could not mint realtime token: %s", exc)
        return jsonify({"success": False, "message": "Live updates are unavailable"}), 503

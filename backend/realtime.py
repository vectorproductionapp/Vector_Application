"""Live updates for the browser over a WebSocket.

Why this exists
---------------
The pages used to poll every 12-30s, which refetched data that had not
changed and made lists jump around.  Instead, the write request that changes
something pushes a notice straight to the connected browsers, so an open page
refreshes only the view it is showing - no page reload, and no polling loop.

Nothing here polls Firestore.  The server broadcasts in-process, which covers a
single-process deployment (``python app.py``, or gunicorn with one worker or
threads).  Run gunicorn with a single worker process (``--workers 1
--threads N``) so every socket is held by the same process that handles writes.
"""

import json
import logging
import threading
import time

from auth_utils import decode_token

log = logging.getLogger("vector.realtime")

# Request-path prefix -> live-update scope.  Longest prefix wins.
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


def record_change(scope, action="write", doc_id=None, actor=None):
    """Tell every subscribed browser that `scope` changed.

    This is the whole mechanism: no polling, no background thread, no Firestore
    queries.  The write request that just succeeded hands the notice straight to
    the connected sockets.
    """
    if not scope:
        return 0
    delivered = broadcast(
        {
            "type": "changed",
            "scope": scope,
            "action": action,
            "id": doc_id or "",
            "actor": actor or "",
            "at": time.time(),
        }
    )
    log.info("realtime notice scope=%s action=%s clients=%s", scope, action, delivered)
    return delivered




# ---------------------------------------------------------------------------
# Connected clients
# ---------------------------------------------------------------------------

_clients = {}
_clients_lock = threading.Lock()
_next_id = [1]


def _register(ws):
    with _clients_lock:
        client_id = _next_id[0]
        _next_id[0] += 1
        _clients[client_id] = {"ws": ws, "scopes": set()}
    return client_id


def _unregister(client_id):
    with _clients_lock:
        _clients.pop(client_id, None)


def _send(ws, message):
    try:
        ws.send(json.dumps(message))
        return True
    except Exception:
        return False


def broadcast(message):
    """Deliver a message to every client subscribed to its scope."""
    scope = message.get("scope")
    with _clients_lock:
        targets = [
            entry["ws"]
            for entry in _clients.values()
            if not scope or not entry["scopes"] or scope in entry["scopes"]
        ]
    delivered = 0
    for ws in targets:
        if _send(ws, message):
            delivered += 1
    return delivered


def connection_count():
    with _clients_lock:
        return len(_clients)


# ---------------------------------------------------------------------------
# WebSocket endpoint + server
# ---------------------------------------------------------------------------


def _query_string(ws):
    """Query string of the upgrade request.

    flask-sock passes a ``simple_websocket.Server`` whose constructor stores
    the WSGI environ (``ws.environ``).  Older/other builds expose the raw
    request line instead (``GET /ws?token=... HTTP/1.1``), and a Flask
    request-like object exposes parsed ``args``.  Cover all three so the
    token is never lost - without it the server would reject every browser
    and the client would reconnect forever.
    """
    environ = getattr(ws, "environ", None)
    if isinstance(environ, dict):
        qs = environ.get("QUERY_STRING") or ""
        if qs:
            return qs
    try:
        raw = getattr(ws, "request", None)
        raw = getattr(raw, "raw_request", None) or ""
        if isinstance(raw, bytes):
            raw = raw.decode("latin-1", "replace")
        if isinstance(raw, str) and "?" in raw:
            return raw.split("?", 1)[1].split(" ", 1)[0]
    except Exception:
        pass
    try:
        args = getattr(ws, "args", None)
        token = args.get("token") if args is not None else None
        if token:
            from urllib.parse import urlencode

            return urlencode({"token": token})
    except Exception:
        pass
    return ""


def handle_socket(ws):
    """Serve one browser connection until it goes away."""
    query = _query_string(ws)

    token = ""
    for part in query.split("&"):
        if part.startswith("token="):
            from urllib.parse import unquote

            token = unquote(part[len("token=") :])

    identity = None
    if token:
        try:
            identity = decode_token(token)
        except Exception:
            identity = None

    if not identity:
        log.warning("realtime rejected connection: missing or invalid token")
        _send(ws, {"type": "unauthorized", "message": "Sign in again to receive live updates."})
        try:
            ws.close()
        except Exception:
            pass
        return

    client_id = _register(ws)
    _send(ws, {"type": "hello", "scopes": []})
    log.info("realtime client connected id=%s total=%s", client_id, connection_count())

    try:
        while True:
            message = ws.receive(timeout=1.0)
            if message is None:
                continue
            try:
                payload = json.loads(message)
            except (TypeError, ValueError):
                continue
            action = payload.get("action")
            if action == "subscribe":
                scopes = payload.get("scopes")
                scopes = [s for s in (scopes if isinstance(scopes, list) else []) if isinstance(s, str)]
                with _clients_lock:
                    entry = _clients.get(client_id)
                    if entry:
                        entry["scopes"] = set(scopes)
                _send(ws, {"type": "subscribed", "scopes": scopes})
            elif action == "ping":
                _send(ws, {"type": "pong"})
            elif action == "close":
                break
    except Exception:
        pass
    finally:
        _unregister(client_id)
        log.info("realtime client disconnected id=%s total=%s", client_id, connection_count())


def attach(app):
    """Serve `/ws` alongside the Flask routes.

    flask-sock wraps the WSGI app, so the WebSocket is handled before Flask
    routes the request and every WSGI server keeps working - including the
    development server used by `python app.py` and gunicorn in production.
    """
    from flask_sock import Sock

    if getattr(app, "_vector_realtime", False):
        return app

    sock = Sock(app)

    # Surface connect/disconnect/reject lines in the server log; the root
    # logger stays at WARNING, which would otherwise hide them.
    if not log.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        log.addHandler(handler)
    log.setLevel(logging.INFO)
    log.propagate = False

    @sock.route("/ws")
    def _ws_route(ws):  # pragma: no cover - exercised over a real socket
        handle_socket(ws)

    app._vector_realtime = True
    log.info("realtime WebSocket listening on /ws")
    return app


def run(app, host="0.0.0.0", port=5000, debug=False):
    """Serve HTTP and the WebSocket from one port."""
    attach(app)
    app.run(host=host, port=port, debug=debug, threaded=True)

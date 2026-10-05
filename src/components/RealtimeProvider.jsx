import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import api from "./Api";

/*
 * One WebSocket for the whole app.
 *
 * The server pushes `{"type":"changed","scope":"po_details",...}` the moment a
 * write succeeds, so a page that is open refreshes only the list it is showing -
 * no page reload, no polling.  Pages subscribe to the scopes they care about
 * with `useRealtime(scopes, handler)`; handlers are called at most once every
 * `debounceMs`, so a burst of saves results in a single quiet refresh.
 */

const RealtimeContext = createContext(null);

const TOKEN_KEY = "vector_auth";
const RECONNECT_MS = 3000;
const RECONNECT_MAX_MS = 30000;
const DEFAULT_DEBOUNCE_MS = 500;

// Where the socket lives when the app is served from the same origin (the CRA
// dev server proxies /ws).  REACT_APP_API_BASE_URL wins when it is configured.
function socketUrl() {
  const apiBase = (process.env.REACT_APP_API_BASE_URL || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const origin = apiBase || window.location.host;
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${origin}/ws`;
}

function readToken() {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return "";
    const parsed = JSON.parse(raw);
    return parsed?.token || "";
  } catch {
    return "";
  }
}

export function RealtimeProvider({ children }) {
  const socketRef = useRef(null);
  const handlersRef = useRef(new Map()); // scope -> Set<handler>
  const scopesRef = useRef(new Set());
  const reconnectRef = useRef(null);
  const attemptRef = useRef(0);
  // Token the server rejected; quiet until a sign-in issues a new one, so an
  // expired session cannot hammer /ws every few seconds.
  const rejectedTokenRef = useRef("");
  const [connected, setConnected] = useState(false);

  const sendSubscription = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ action: "subscribe", scopes: [...scopesRef.current] }));
  }, []);

  const connect = useCallback(() => {
    const token = readToken();
    if (!token) return;
    if (token === rejectedTokenRef.current) return;
    if (socketRef.current) return;

    let socket;
    try {
      socket = new WebSocket(`${socketUrl()}?token=${encodeURIComponent(token)}`);
    } catch {
      scheduleReconnect();
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      attemptRef.current = 0;
      setConnected(true);
      sendSubscription();
    };
    socket.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload.type === "unauthorized") {
        rejectedTokenRef.current = token;
        setConnected(false);
        const current = socketRef.current;
        socketRef.current = null;
        try {
          current?.close();
        } catch {
          /* ignore */
        }
        return;
      }
      if (payload.type !== "changed" || !payload.scope) return;
      const handlers = handlersRef.current.get(payload.scope);
      if (!handlers?.size) return;
      handlers.forEach((handler) => {
        try {
          handler(payload);
        } catch {
          /* a page failing to refresh must not break the socket */
        }
      });
    };
    socket.onclose = () => {
      setConnected(false);
      socketRef.current = null;
      scheduleReconnect();
    };
    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    };

    function scheduleReconnect() {
      if (rejectedTokenRef.current === token) return;
      if (reconnectRef.current) return;
      // Exponential backoff: quick for a blip, quiet for a dead server.
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MS * 2 ** attemptRef.current);
      attemptRef.current += 1;
      reconnectRef.current = setTimeout(() => {
        reconnectRef.current = null;
        connect();
      }, delay);
    }
  }, [sendSubscription]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
      if (socketRef.current) {
        socketRef.current.onclose = null;
        try {
          socketRef.current.close();
        } catch {
          /* ignore */
        }
      }
      socketRef.current = null;
    };
  }, [connect]);

  const subscribe = useCallback(
    (scope, handler) => {
      if (!scope) return () => {};
      if (!handlersRef.current.has(scope)) handlersRef.current.set(scope, new Set());
      handlersRef.current.get(scope).add(handler);
      scopesRef.current.add(scope);
      sendSubscription();
      return () => {
        const handlers = handlersRef.current.get(scope);
        handlers?.delete(handler);
        if (handlers && !handlers.size) {
          handlersRef.current.delete(scope);
          scopesRef.current.delete(scope);
          sendSubscription();
        }
      };
    },
    [sendSubscription]
  );

  const value = useMemo(() => ({ subscribe, connected }), [subscribe, connected]);

  // Close the socket when the tab is hidden for a while, and pick it straight
  // back up on return: fewer idle sockets, no user-visible delay.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") return;
      if (!socketRef.current) connect();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [connect]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

/**
 * Refresh quietly when one of `scopes` changes.
 *
 * `refresh` is expected to call the page's existing silent loader - it must never
 * reload the page.  Nothing runs while a form is open: pass a guard that returns
 * a message (or false) to skip that moment.
 */
export function useRealtime(scopes, refresh, { enabled = true, guard = null, debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
  const realtime = useContext(RealtimeContext);
  const refreshRef = useRef(refresh);
  const guardRef = useRef(guard);
  const timerRef = useRef(null);
  const lastRef = useRef(0);
  const pendingRef = useRef(false);

  refreshRef.current = refresh;
  guardRef.current = guard;

  const scopeKey = Array.isArray(scopes) ? scopes.join(",") : scopes || "";

  // Run the refresh once one is pending, the guard has cleared, and the
  // debounce window has passed.  This runs after every render: a notice that
  // arrived while a save (or open form) blocked it just waits here until the
  // state that blocked it changes - which always causes a render.
  const flush = useCallback(() => {
    if (!pendingRef.current) return;
    const guardValue = guardRef.current?.();
    if (guardValue === false) return;
    const now = Date.now();
    if (now - lastRef.current < debounceMs) {
      if (!timerRef.current) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          flushRef.current();
        }, debounceMs - (now - lastRef.current));
      }
      return;
    }
    pendingRef.current = false;
    lastRef.current = now;
    // The notice arrived because data changed somewhere: bypass the GET cache
    // so this refresh shows the new data, not a copy cached minutes ago.
    api.invalidateGetCache?.();
    refreshRef.current?.(guardValue);
  }, [debounceMs]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(flush);

  useEffect(() => {
    if (!realtime || !scopeKey || !enabled) return undefined;
    const list = scopeKey.split(",").filter(Boolean);

    const handler = () => {
      pendingRef.current = true;
      flush();
    };

    const unsubscribes = list.map((scope) => realtime.subscribe(scope, handler));
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      unsubscribes.forEach((off) => off());
    };
  }, [realtime, scopeKey, enabled, debounceMs, flush]);
}

export { api };

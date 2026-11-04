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
import { useAuth } from "../context/Auth";
import { loadFirebase, signOutRealtime } from "./realtimeFirebase";

/*
 * Live updates through Firestore.
 *
 * After every successful save the backend writes `realtime_notices/{scope}`
 * ({action, updatedAt, updatedBy}).  This provider listens to those documents
 * directly in Firestore (onSnapshot) for the scopes the open page asked for,
 * so a page refreshes only its own data - no page reload, no polling, and no
 * connection held open to Cloud Run (which bills for every open second).
 *
 * Pages use `useRealtime(scopes, refresh)`.  Refreshes are debounced: a burst
 * of saves results in one quiet refresh once the burst settles.
 *
 * Without Firebase config or sign-in, nothing breaks: pages just refresh on
 * their next load instead of live.
 */

const RealtimeContext = createContext(null);

const NOTICES_COLLECTION = "realtime_notices";
// Listeners are dropped after this long in a hidden tab and re-attached when
// the tab is shown again (a change made meanwhile triggers one refresh then).
const HIDDEN_DETACH_MS = 2 * 60_000;
const DEFAULT_DEBOUNCE_MS = 1500;
const MAX_WAIT_MS = 5000;

// `sub` (user id) from the app's JWT, to match the Firebase user to it.
function tokenSubject(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload)).sub || "";
  } catch {
    return "";
  }
}

export function RealtimeProvider({ children }) {
  const { token } = useAuth();
  const handlersRef = useRef(new Map()); // scope -> Set<handler>
  const listenersRef = useRef(new Map()); // scope -> unsubscribe
  const lastSeenRef = useRef(new Map()); // scope -> updatedAt millis
  const firebaseRef = useRef(null); // { db, firestoreApi } once signed in
  const [signedIn, setSignedIn] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const syncRef = useRef(() => {});

  // Sign in to Firebase with a custom token for the current app session.
  useEffect(() => {
    let cancelled = false;
    setSignedIn(false);
    firebaseRef.current = null;

    if (!token) {
      // Signed out (also after a reload, e.g. a 401 redirect to /login):
      // end any Firebase session left in this tab.
      signOutRealtime();
      return undefined;
    }

    (async () => {
      const { auth, authApi, db, firestoreApi } = await loadFirebase();
      await auth.authStateReady();
      if (cancelled) return;
      const wantedUid = `vector-${tokenSubject(token)}`;
      if (auth.currentUser?.uid !== wantedUid) {
        const response = await api.post("/realtime/token", null, {
          __vectorSuppressBusy: true,
          __vectorKeepCache: true,
        });
        if (cancelled) return;
        await authApi.signInWithCustomToken(auth, response.data.token);
      }
      if (cancelled) return;
      firebaseRef.current = { db, firestoreApi };
      setSignedIn(true);
    })().catch(() => {
      // Live updates are optional; the page keeps working without them.
    });

    return () => {
      cancelled = true;
    };
  }, [token]);

  // Hidden tab: keep listening for 2 minutes, then let go until it is shown.
  useEffect(() => {
    let timer = null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (!timer) timer = setTimeout(() => { timer = null; setVisible(false); }, HIDDEN_DETACH_MS);
      } else {
        if (timer) clearTimeout(timer);
        timer = null;
        setVisible(true);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const detach = useCallback((scope, forget) => {
    const off = listenersRef.current.get(scope);
    if (off) off();
    listenersRef.current.delete(scope);
    if (forget) lastSeenRef.current.delete(scope);
  }, []);

  const attach = useCallback((scope) => {
    const firebase = firebaseRef.current;
    if (!firebase || listenersRef.current.has(scope)) return;
    const { db, firestoreApi } = firebase;
    const off = firestoreApi.onSnapshot(
      firestoreApi.doc(db, NOTICES_COLLECTION, scope),
      (snapshot) => {
        const updatedAt = snapshot.get("updatedAt");
        const at = typeof updatedAt?.toMillis === "function" ? updatedAt.toMillis() : 0;
        const seen = lastSeenRef.current.get(scope);
        lastSeenRef.current.set(scope, at);
        // The first snapshot is the current state, not a change.
        if (seen === undefined || at <= seen) return;
        const notice = {
          type: "changed",
          scope,
          action: snapshot.get("action") || "",
          actor: snapshot.get("updatedBy") || "",
          at,
        };
        handlersRef.current.get(scope)?.forEach((handler) => {
          try {
            handler(notice);
          } catch {
            /* one page failing to refresh must not stop the others */
          }
        });
      },
      () => {
        // Permission or config problem: stop this listener quietly.
        listenersRef.current.delete(scope);
      }
    );
    listenersRef.current.set(scope, off);
  }, []);

  // Listen to exactly the scopes some mounted page needs, while allowed.
  const sync = useCallback(() => {
    const live = signedIn && visible;
    const wanted = live ? new Set(handlersRef.current.keys()) : new Set();
    [...listenersRef.current.keys()].forEach((scope) => {
      if (!wanted.has(scope)) detach(scope, !handlersRef.current.has(scope));
    });
    wanted.forEach(attach);
  }, [signedIn, visible, attach, detach]);
  syncRef.current = sync;

  useEffect(() => {
    sync();
  }, [sync]);

  useEffect(() => () => {
    [...listenersRef.current.keys()].forEach((scope) => detach(scope, true));
  }, [detach]);

  useEffect(() => {
    if (!token) {
      [...listenersRef.current.keys()].forEach((scope) => detach(scope, true));
      lastSeenRef.current.clear();
    }
  }, [token, detach]);

  const subscribe = useCallback((scope, handler) => {
    if (!scope) return () => {};
    if (!handlersRef.current.has(scope)) handlersRef.current.set(scope, new Set());
    handlersRef.current.get(scope).add(handler);
    syncRef.current();
    return () => {
      const handlers = handlersRef.current.get(scope);
      handlers?.delete(handler);
      if (handlers && !handlers.size) handlersRef.current.delete(scope);
      syncRef.current();
    };
  }, []);

  const value = useMemo(() => ({ subscribe, connected: signedIn }), [subscribe, signedIn]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

/**
 * Refresh quietly when one of `scopes` changes.
 *
 * `refresh` is expected to call the page's existing silent loader - it must never
 * reload the page.  Nothing runs while a form is open: pass a guard that returns
 * false to skip that moment; the refresh then waits until the guard clears.
 *
 * Refreshes wait until notices have been quiet for `debounceMs` (but never
 * longer than 5 s), so a bulk save refreshes once, not once per row.
 */
export function useRealtime(scopes, refresh, { enabled = true, guard = null, debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
  const realtime = useContext(RealtimeContext);
  const refreshRef = useRef(refresh);
  const guardRef = useRef(guard);
  const timerRef = useRef(null);
  const pendingRef = useRef(false);
  const firstNoticeRef = useRef(0);
  const lastNoticeRef = useRef(0);
  const changedScopesRef = useRef(new Set());

  refreshRef.current = refresh;
  guardRef.current = guard;

  const scopeKey = Array.isArray(scopes) ? scopes.join(",") : scopes || "";

  // Runs after every render too: a notice that arrived while a save (or an
  // open form) blocked it waits here until the blocking state changes.
  const flush = useCallback(() => {
    if (!pendingRef.current) return;
    const guardValue = guardRef.current?.();
    if (guardValue === false) return;
    const now = Date.now();
    const wait = Math.min(
      debounceMs - (now - lastNoticeRef.current),
      MAX_WAIT_MS - (now - firstNoticeRef.current)
    );
    if (wait > 0) {
      if (!timerRef.current) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          flushRef.current();
        }, wait);
      }
      return;
    }
    pendingRef.current = false;
    // Drop cached GETs for the changed scopes only, so this refresh shows
    // the new data while other pages keep their cached copies.
    api.invalidateGetCache?.([...changedScopesRef.current]);
    changedScopesRef.current.clear();
    refreshRef.current?.(guardValue);
  }, [debounceMs]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(flush);

  useEffect(() => {
    if (!realtime || !scopeKey || !enabled) return undefined;
    const list = scopeKey.split(",").filter(Boolean);

    const handler = (notice) => {
      const now = Date.now();
      if (!pendingRef.current) firstNoticeRef.current = now;
      lastNoticeRef.current = now;
      pendingRef.current = true;
      if (notice?.scope) changedScopesRef.current.add(notice.scope);
      flushRef.current();
    };

    const unsubscribes = list.map((scope) => realtime.subscribe(scope, handler));
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      unsubscribes.forEach((off) => off());
    };
  }, [realtime, scopeKey, enabled]);
}

export { api };

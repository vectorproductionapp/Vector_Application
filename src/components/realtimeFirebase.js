/*
 * Firebase, loaded only when a signed-in page first listens for live updates.
 *
 * The SDK is a separate chunk (dynamic import), so the login page and the
 * first paint never download it.
 *
 * Config: REACT_APP_FIREBASE_API_KEY / _AUTH_DOMAIN / _PROJECT_ID / _APP_ID
 * when set (local development); otherwise Firebase Hosting's own
 * `/__/firebase/init.json`, which every Hosting site serves for its project.
 */

let loading = null;

async function firebaseConfig() {
  const fromEnv = {
    apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
    authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
    appId: process.env.REACT_APP_FIREBASE_APP_ID,
  };
  if (fromEnv.apiKey && fromEnv.projectId) return fromEnv;
  const response = await fetch("/__/firebase/init.json", { credentials: "omit" });
  const type = response.headers.get("content-type") || "";
  if (!response.ok || !type.includes("json")) throw new Error("Firebase config is not available");
  return response.json();
}

/**
 * Resolves to { auth, authApi, db, firestoreApi }.  A failure is kept, so a
 * page without Firebase config never retries in a loop; the app simply works
 * without live updates.
 */
export function loadFirebase() {
  if (!loading) {
    loading = (async () => {
      const [{ initializeApp }, authApi, firestoreApi, config] = await Promise.all([
        import("firebase/app"),
        import("firebase/auth"),
        import("firebase/firestore"),
        firebaseConfig(),
      ]);
      const app = initializeApp(config, "vector-realtime");
      // Session persistence matches the app's own login (sessionStorage):
      // a reload keeps the Firebase sign-in, closing the tab ends it.
      const auth = authApi.initializeAuth(app, { persistence: authApi.browserSessionPersistence });
      const db = firestoreApi.getFirestore(app);
      return { auth, authApi, db, firestoreApi };
    })();
  }
  return loading;
}

/** The same promise, or null when Firebase was never loaded in this tab. */
export function loadedFirebase() {
  return loading;
}

// Firebase keeps its session in sessionStorage under keys like
// "firebase:authUser:<apiKey>:vector-realtime"; it survives a page reload.
function hasStoredFirebaseSession() {
  try {
    return Object.keys(sessionStorage).some((key) => key.startsWith("firebase:authUser:"));
  } catch {
    return false;
  }
}

/**
 * End the Firebase session (and with it every Firestore listener).  Called
 * on logout; safe to call when Firebase was never used in this tab.
 */
export async function signOutRealtime() {
  if (!loading && !hasStoredFirebaseSession()) return;
  try {
    const { auth, authApi } = await loadFirebase();
    await authApi.signOut(auth);
  } catch {
    // Nothing to end, or Firebase is unavailable.
  }
}

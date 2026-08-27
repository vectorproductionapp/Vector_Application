import axios from "axios";
import Swal from "sweetalert2";

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || "";
const STORAGE_KEY = "vector_auth";

const api = axios.create({ baseURL: API_BASE_URL });
let activeMutations = 0;
let activeRequests = 0;
// A save clears this cache immediately, so a few minutes of reuse makes page
// navigation fast without leaving users looking at outdated application data.
const GET_CACHE_TTL_MS = 3 * 60_000;
const PERF_LOGGING_ENABLED = process.env.NODE_ENV !== "production"
  || process.env.REACT_APP_API_PERF_LOGGING === "true";
const getCache = new Map();
const pendingGetRequests = new Map();

function cacheKey(config) {
  const params = new URLSearchParams(config.params || {}).toString();
  return `${config.baseURL || ""}${config.url || ""}${params ? `?${params}` : ""}`;
}

function requestKey(url, config = {}) {
  const params = new URLSearchParams(config.params || {}).toString();
  return `${config.baseURL || API_BASE_URL}${url}${params ? `?${params}` : ""}`;
}

function copyData(data) {
  return typeof structuredClone === "function"
    ? structuredClone(data)
    : JSON.parse(JSON.stringify(data));
}

function logGetTiming(config, outcome, response) {
  if (!PERF_LOGGING_ENABLED || !config.__vectorRequestStartedAt) return;
  const durationMs = performance.now() - config.__vectorRequestStartedAt;
  const cache = response?.headers?.["x-vector-cache"] || "network";
  const serverTiming = response?.headers?.["server-timing"] || "";
  console.debug(`[Vector API] GET ${outcome}`, {
    url: `${config.baseURL || ""}${config.url || ""}`,
    durationMs: Math.round(durationMs),
    cache,
    serverTiming,
    startedAt: new Date(config.__vectorRequestStartedAtEpoch).toISOString(),
  });
}

function publishRequestState() {
  window.dispatchEvent(new CustomEvent("vector:api-loading", {
    detail: { loading: activeRequests > 0, count: activeRequests },
  }));
}

function publishMutationState() {
  window.dispatchEvent(new CustomEvent("vector:api-busy", { detail: { busy: activeMutations > 0 } }));
  if (activeMutations > 0 && !Swal.isVisible()) {
    Swal.fire({
      title: "Processing…",
      text: "Please wait while we complete your request.",
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      didOpen: () => Swal.showLoading(),
      customClass: { popup: "swal-vector-popup" },
    });
  }
  if (activeMutations === 0 && Swal.isVisible()) Swal.close();
}

// Attach the stored JWT to every outgoing request.
api.interceptors.request.use((config) => {
  config.__vectorRequest = true;
  const method = String(config.method || "get").toLowerCase();
  if (method === "get") {
    config.__vectorRequestStartedAt = performance.now();
    config.__vectorRequestStartedAtEpoch = Date.now();
    // The page-wide loader is reserved for data reads. Mutations use the
    // existing busy state so saving does not cover the page with this loader.
    // Dropdown and background refreshes can opt out while retaining caching,
    // de-duplication, and timing diagnostics.
    config.__vectorTrackLoader = !config.__vectorSuppressLoader && !config.__vectorBackground;
    if (config.__vectorTrackLoader) {
      activeRequests += 1;
      publishRequestState();
    }
    // The global loader represents page data loading only. Saves already use
    // their own busy state and must not leave the page loader visible.
    const key = cacheKey(config);
    const cached = getCache.get(key);
    if (cached && Date.now() - cached.savedAt < GET_CACHE_TTL_MS) {
      config.adapter = () => Promise.resolve({
        data: copyData(cached.data), status: 200, statusText: "OK",
        headers: { "x-vector-cache": "hit" }, config, request: null,
      });
    } else if (cached) {
      getCache.delete(key);
    }
    config.__vectorCacheKey = key;
  } else if (!["head", "options"].includes(method)) {
    // A successful save can affect dashboard totals and every table, so do
    // not show stale data after any create, edit, or deletion.
    getCache.clear();
    config.__vectorMutation = true;
    // Inline forms can provide a clearer local saving state than the global
    // blocking popup. They opt in with __vectorSuppressBusy.
    if (!config.__vectorSuppressBusy) {
      config.__vectorShowBusy = true;
      activeMutations += 1;
      publishMutationState();
    }
  }
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const { token } = JSON.parse(raw);
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
  } catch {
    // ignore malformed storage
  }
  return config;
});

// If the token is missing/expired/rejected, bounce back to login.
api.interceptors.response.use(
  (response) => {
    if (response.config.__vectorCacheKey && response.headers?.["x-vector-cache"] !== "hit") {
      getCache.set(response.config.__vectorCacheKey, { data: copyData(response.data), savedAt: Date.now() });
    }
    if (response.config.__vectorTrackLoader) { activeRequests = Math.max(0, activeRequests - 1); publishRequestState(); }
    if (response.config.__vectorRequestStartedAt) logGetTiming(response.config, "complete", response);
    if (response.config.__vectorShowBusy) { activeMutations = Math.max(0, activeMutations - 1); publishMutationState(); }
    return response;
  },
  (error) => {
    if (error.config?.__vectorTrackLoader) { activeRequests = Math.max(0, activeRequests - 1); publishRequestState(); }
    if (error.config?.__vectorRequestStartedAt) logGetTiming(error.config, "failed", error.response);
    if (error.config?.__vectorShowBusy) { activeMutations = Math.max(0, activeMutations - 1); publishMutationState(); }
    if (error.response?.status === 401) {
      sessionStorage.removeItem(STORAGE_KEY);
      window.location.href = "/login";
    }
    return Promise.reject(error);
  }
);

// React Strict Mode (and rapid navigation) can start an identical GET before
// the first one has completed. Share that one network request instead of
// making Firestore perform the same read twice.
const axiosGet = api.get.bind(api);
api.get = (url, config = {}) => {
  if (config.__vectorNoDedupe) return axiosGet(url, config);

  const key = requestKey(url, config);
  const pending = pendingGetRequests.get(key);
  if (pending) return pending;

  const requestPromise = axiosGet(url, config);
  pendingGetRequests.set(key, requestPromise);
  requestPromise.then(
    () => pendingGetRequests.delete(key),
    () => pendingGetRequests.delete(key),
  );
  return requestPromise;
};

export default api;

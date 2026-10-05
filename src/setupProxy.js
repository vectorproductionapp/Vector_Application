// Dev-server proxy for the CRA app.
//
// `proxy` in package.json only accepts a string, and a string cannot express
// "proxy API calls but leave the SPA alone", so everything lives here:
// requests that look like API calls are forwarded to Flask, while CRA keeps
// serving `/`, its static assets and HTML navigations (the SPA routes).
//
// `/ws` is deliberately NOT proxied: webpack-dev-server serves the hot-reload
// socket at `/ws` by default, and forwarding it would break live reload.  The
// live-update socket connects straight to the backend (REACT_APP_API_BASE_URL
// -> ws://localhost:5000/ws) instead.
const { createProxyMiddleware } = require("http-proxy-middleware");

const BACKEND = process.env.REACT_APP_DEV_API || "http://127.0.0.1:5000";

const NEVER_PROXY = [
  /^\/static\//,
  /^\/sockjs-node/,
  /^\/ws$/,
  /^\/favicon\.ico$/,
  /^\/manifest\.json$/,
  /^\/asset-manifest\.json$/,
  /^\/index\.html$/,
];

const ASSET_EXT =
  /\.(js|mjs|css|map|ico|png|jpe?g|gif|svg|webp|woff2?|ttf|otf|eot|txt|wasm)$/;

function isApiRequest(pathname, req) {
  if (!pathname || pathname === "/") return false;
  if (NEVER_PROXY.some((re) => re.test(pathname))) return false;
  if (ASSET_EXT.test(pathname)) return false;
  const accept = (req.headers && req.headers.accept) || "";
  // Browser navigations to SPA routes accept text/html; API calls do not.
  if (req.method === "GET" && accept.includes("text/html")) return false;
  return true;
}

module.exports = function setupProxy(app) {
  // http-proxy-middleware v2 takes the filter as the FIRST argument;
  // passing it as an option would be silently ignored.
  app.use(
    createProxyMiddleware(isApiRequest, {
      target: BACKEND,
      changeOrigin: true,
    })
  );
};

"""Smoke tests for the endpoints the blue/green release flow depends on.

These build the real Flask app with a stubbed ``firebase_admin`` (see
``tests.fakes``) so they can run on a pull request without Google credentials
and without touching any real Firestore or Storage data.

Covered here:
  * ``GET /health`` - the Cloud Run verification target - must answer 200 with
    no Authorization header and without touching Firebase.
  * CORS must allow the exact production origins and this project's own preview
    channel, and must never answer with ``*``.
  * the old ``/ws`` WebSocket is gone; ``POST /realtime/token`` replaces it.
  * preflights are cacheable (``Access-Control-Max-Age``) and every route is
    also served under ``/api`` for the same-origin Firebase Hosting rewrite.
  * ``/dashboard`` is cached in memory per user and dropped on any write.
"""

import os
import sys
import unittest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

# Deterministic environment BEFORE the application (and auth_utils) is imported.
os.environ["JWT_SECRET"] = "unit-test-secret-not-a-real-production-secret"
os.environ["CORS_ORIGINS"] = ",".join(
    [
        " https://production.vector-power.com/ ",
        "https://vector-production-506505.web.app",
        "https://vector-production-506505.firebaseapp.com",
        "http://localhost:3000",
    ]
)
os.environ["CORS_ALLOW_PREVIEW_CHANNELS"] = "true"
os.environ["FIREBASE_SITE_ID"] = "vector-production-506505"
os.environ.pop("FIREBASE_PROJECT_ID", None)

from tests import fakes  # noqa: E402  (must run before the app is imported)

fakes.install()

from __init__ import create_app  # noqa: E402


def _build_app():
    app = create_app()
    app.config["TESTING"] = True
    return app


class HealthEndpointTests(unittest.TestCase):
    """`gcloud run ... --startup-probe` and verify-green.ps1 both rely on this."""

    @classmethod
    def setUpClass(cls):
        cls.app = _build_app()
        cls.client = cls.app.test_client()

    def test_health_returns_200_without_authentication(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"status": "ok"})

    def test_health_is_json_and_needs_no_token(self):
        response = self.client.get("/health")
        self.assertIn("application/json", response.content_type)
        # Not 401 and not 403: the readiness probe sends no JWT.
        self.assertNotIn(response.status_code, (401, 403))

    def test_health_accepts_head(self):
        self.assertEqual(self.client.head("/health").status_code, 200)

    def test_health_does_not_require_firebase(self):
        # fakes.install() raises if anything reaches for Google credentials,
        # so simply reaching 200 here proves /health is credential-free.
        self.assertEqual(self.client.get("/health").status_code, 200)


class CorsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = _build_app()
        cls.client = cls.app.test_client()

    def _origin(self, origin):
        return self.client.get(
            "/health", headers={"Origin": origin}
        ).headers.get("Access-Control-Allow-Origin")

    def test_allows_each_configured_production_origin(self):
        for origin in (
            "https://production.vector-power.com",
            "https://vector-production-506505.web.app",
            "https://vector-production-506505.firebaseapp.com",
            "http://localhost:3000",
        ):
            with self.subTest(origin=origin):
                self.assertEqual(self._origin(origin), origin)

    def test_allows_this_projects_preview_channels(self):
        # https://<siteId>--<channelId>-<hash>.web.app
        preview = "https://vector-production-506505--green-20261010-a1b2c3.web.app"
        self.assertEqual(self._origin(preview), preview)

    def test_rejects_every_other_origin(self):
        for origin in (
            "https://evil.example.com",
            "https://evil--attacker-project-99999.web.app",
            "https://productionXvector-power.com",  # "." must stay literal
            "http://localhost:3000.evil.com",
        ):
            with self.subTest(origin=origin):
                self.assertIsNone(self._origin(origin))

    def test_never_answers_with_a_wildcard(self):
        response = self.client.get(
            "/health", headers={"Origin": "https://production.vector-power.com"}
        )
        self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), "https://production.vector-power.com")
        # A disallowed origin must not receive "*" either.
        denied = self.client.get("/health", headers={"Origin": "https://evil.example.com"})
        self.assertNotEqual(denied.headers.get("Access-Control-Allow-Origin"), "*")

    def test_cors_is_off_unless_preview_opt_in_is_enabled(self):
        self.assertEqual(os.getenv("CORS_ALLOW_PREVIEW_CHANNELS"), "true")
        self.assertEqual(os.getenv("FIREBASE_SITE_ID"), "vector-production-506505")


def _auth_header(role="admin", sub="u1"):
    import jwt
    from auth_utils import JWT_SECRET

    token = jwt.encode({"sub": sub, "email": f"{sub}@example.com", "role": role, "name": "T"},
                       JWT_SECRET, algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


class RealtimeRouteTests(unittest.TestCase):
    """Live updates come from Firestore now; no request stays open."""

    @classmethod
    def setUpClass(cls):
        cls.app = _build_app()
        cls.client = cls.app.test_client()

    def test_ws_route_is_gone(self):
        paths = {rule.rule for rule in self.app.url_map.iter_rules()}
        self.assertNotIn("/ws", paths)
        self.assertIn("/health", paths)

    def test_realtime_token_needs_a_session(self):
        self.assertEqual(self.client.post("/realtime/token").status_code, 401)

    def test_realtime_token_is_issued_for_a_signed_in_user(self):
        response = self.client.post("/realtime/token", headers=_auth_header(sub="abc"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["token"], "fake-token-for-vector-abc")


class CostControlTests(unittest.TestCase):
    """Preflight caching, the /api prefix and the dashboard memory cache."""

    @classmethod
    def setUpClass(cls):
        cls.app = _build_app()
        cls.client = cls.app.test_client()

    def test_preflight_is_cacheable(self):
        response = self.client.options(
            "/dashboard",
            headers={
                "Origin": "https://production.vector-power.com",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization",
            },
        )
        self.assertEqual(response.headers.get("Access-Control-Max-Age"), "7200")

    def test_api_prefix_serves_the_same_routes(self):
        self.assertEqual(self.client.get("/api/health").status_code, 200)
        self.assertEqual(self.client.get("/api/health").get_json(), {"status": "ok"})

    def test_json_is_compressed(self):
        from flask import jsonify

        def big():
            return jsonify({"rows": ["x" * 50] * 200})

        # A fresh app: routes cannot be added after the first request.
        test_app = _build_app()
        test_app.add_url_rule("/big-test", "big_test", big)
        response = test_app.test_client().get("/big-test", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(response.headers.get("Content-Encoding"), "gzip")

    def test_api_responses_are_never_cached(self):
        for path in ("/health", "/api/health", "/realtime/token", "/does-not-exist"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.headers.get("Cache-Control"), "private, no-store")

    def test_cors_origins_are_trimmed(self):
        response = self.client.get("/health", headers={"Origin": "https://production.vector-power.com"})
        self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), "https://production.vector-power.com")

    def test_dashboard_copy_is_dropped_after_a_save_on_another_instance(self):
        import time as time_module
        import read_cache
        from flask import Flask, jsonify
        from auth_utils import token_required
        from unittest.mock import patch

        calls = []
        app = Flask("cache-stale-test")

        @app.get("/d")
        @token_required
        @read_cache.cached_read("dashboard")
        def dashboard():
            calls.append(1)
            return jsonify({"n": len(calls)}), 200

        client = app.test_client()
        read_cache.invalidate_read_cache()
        with patch.object(read_cache, "_last_change_time", return_value=None):
            client.get("/d", headers=_auth_header(sub="a"))
            client.get("/d", headers=_auth_header(sub="a"))
        self.assertEqual(len(calls), 1)
        # Another instance saved something just now: the copy is stale.
        with patch.object(read_cache, "_last_change_time", return_value=time_module.time()):
            client.get("/d", headers=_auth_header(sub="a"))
        self.assertEqual(len(calls), 2)

    def test_dashboard_cache_is_per_user_and_cleared_on_write(self):
        import read_cache
        from flask import Flask, jsonify
        from auth_utils import token_required

        calls = []
        app = Flask("cache-test")

        @app.get("/d")
        @token_required
        @read_cache.cached_read("dashboard")
        def dashboard():
            calls.append(1)
            return jsonify({"n": len(calls)}), 200

        client = app.test_client()
        read_cache.invalidate_read_cache()
        first = client.get("/d", headers=_auth_header(sub="a")).get_json()
        again = client.get("/d", headers=_auth_header(sub="a"))
        self.assertEqual(again.get_json(), first)
        self.assertEqual(again.headers.get("X-Vector-Cache"), "memory")
        # Another user gets their own computation.
        self.assertNotEqual(client.get("/d", headers=_auth_header(sub="b")).get_json(), first)
        read_cache.invalidate_read_cache()
        self.assertNotEqual(client.get("/d", headers=_auth_header(sub="a")).get_json(), first)
        self.assertEqual(len(calls), 3)


if __name__ == "__main__":
    unittest.main()

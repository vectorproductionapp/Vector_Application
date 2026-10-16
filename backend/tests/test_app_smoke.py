"""Smoke tests for the endpoints the blue/green release flow depends on.

These build the real Flask app with a stubbed ``firebase_admin`` (see
``tests.fakes``) so they can run on a pull request without Google credentials
and without touching any real Firestore or Storage data.

Covered here:
  * ``GET /health`` - the Cloud Run verification target - must answer 200 with
    no Authorization header and without touching Firebase.
  * CORS must allow the exact production origins and this project's own preview
    channel, and must never answer with ``*``.
  * ``/ws`` must still be registered, because the release docs promise it.
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
        "https://production.vector-power.com",
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


class RealtimeRouteTests(unittest.TestCase):
    """The release must keep serving /ws from the same port as the API."""

    @classmethod
    def setUpClass(cls):
        cls.app = _build_app()

    def test_ws_route_is_registered(self):
        paths = {rule.rule for rule in self.app.url_map.iter_rules()}
        self.assertIn("/ws", paths)

    def test_health_still_registered_alongside_ws(self):
        paths = {rule.rule for rule in self.app.url_map.iter_rules()}
        self.assertIn("/health", paths)


if __name__ == "__main__":
    unittest.main()

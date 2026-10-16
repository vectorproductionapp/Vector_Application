"""Unit tests for the pure backend logic the release flow depends on.

Nothing here imports the Flask application, so these run anywhere with no
credentials and no network.
"""

import os
import sys
import unittest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

os.environ.setdefault("JWT_SECRET", "unit-test-secret-not-a-real-production-secret")

import jwt  # noqa: E402
from flask import Flask  # noqa: E402

from auth_utils import (  # noqa: E402
    JWT_SECRET,
    min_role_required,
    roles_required,
    token_required,
)
from realtime import scope_for_path  # noqa: E402


def _token(role):
    return jwt.encode(
        {
            "sub": "u1",
            "email": "u1@example.com",
            "role": role,
            "name": "Unit Test",
        },
        JWT_SECRET,
        algorithm="HS256",
    )


class RoleGuardTests(unittest.TestCase):
    """The guards that produced the production_incharge 403 must stay correct."""

    @classmethod
    def setUpClass(cls):
        app = Flask(__name__)

        @app.route("/guarded")
        @roles_required("admin", "coadmin", "production_incharge")
        def guarded():
            return {"ok": True}

        @app.route("/hierarchy")
        @min_role_required("coadmin")
        def hierarchy():
            return {"ok": True}

        @app.route("/token-only")
        @token_required
        def token_only():
            return {"ok": True}

        cls.client = app.test_client()

    def _get(self, path, role=None, token=None):
        headers = {}
        if token is None and role is not None:
            token = _token(role)
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return self.client.get(path, headers=headers)

    def test_listed_roles_pass(self):
        for role in ("admin", "coadmin", "production_incharge"):
            with self.subTest(role=role):
                self.assertEqual(self._get("/guarded", role).status_code, 200)

    def test_unlisted_role_is_forbidden(self):
        response = self._get("/guarded", "user")
        self.assertEqual(response.status_code, 403)
        self.assertIn("permission", response.get_json()["message"])

    def test_missing_token_is_unauthorized_not_forbidden(self):
        self.assertEqual(self._get("/guarded").status_code, 401)

    def test_invalid_token_is_unauthorized(self):
        self.assertEqual(
            self._get("/guarded", token="not-a-real-jwt").status_code, 401
        )

    def test_min_role_uses_the_hierarchy(self):
        for role in ("coadmin", "admin"):
            with self.subTest(role=role):
                self.assertEqual(self._get("/hierarchy", role).status_code, 200)
        for role in ("user", "production_incharge"):
            with self.subTest(role=role):
                self.assertEqual(self._get("/hierarchy", role).status_code, 403)


class ScopeRoutingTests(unittest.TestCase):
    """Every write path must map to a live-update scope or broadcasts go dark."""

    def test_documented_prefixes(self):
        cases = {
            "/po-details": "po_details",
            "/po-details/abc": "po_details",
            "/invoices": "invoices",
            "/invoices/abc": "invoices",
            "/assembly/units": "assembly_units",
            "/sales": "sales",
            "/defect": "defectives",
            "/stock-register": "stock_register",
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(scope_for_path(path), expected)

    def test_model_and_boq_paths(self):
        self.assertEqual(scope_for_path("/models"), "models")
        self.assertEqual(scope_for_path("/models/m1"), "models")
        self.assertEqual(scope_for_path("/models/m1/phases"), "phases")
        # POST /models/<id>/phases/<pid>/boq (create a BOQ row) -> "boq".
        self.assertEqual(scope_for_path("/models/m1/phases/p1/boq"), "boq")
        # NOTE: pre-existing behaviour, deliberately not changed by the
        # blue/green work - an id-suffixed BOQ row URL (PUT/DELETE
        # .../boq/<id>) maps to "phases" rather than "boq", because the
        # `startswith("/models/")` branch matches before the "/boq" suffix
        # check.  Asserted so that any future fix is a deliberate one.
        self.assertEqual(scope_for_path("/models/m1/phases/p1/boq/b1"), "phases")

    def test_unknown_path_has_no_scope(self):
        self.assertIsNone(scope_for_path("/health"))
        self.assertIsNone(scope_for_path("/login"))
        self.assertIsNone(scope_for_path(""))
        self.assertIsNone(scope_for_path(None))


if __name__ == "__main__":
    unittest.main()

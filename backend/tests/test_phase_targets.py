"""Tests for phase target and schedule creation."""

import os
import sys
import unittest
from unittest.mock import patch

from flask import Flask

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

os.environ["JWT_SECRET"] = "unit-test-secret-not-a-real-production-secret"
os.environ.pop("FIREBASE_PROJECT_ID", None)

from tests import fakes  # noqa: E402

fakes.install()

from auth_utils import generate_token  # noqa: E402
import models  # noqa: E402


class _PhaseReference:
    def __init__(self):
        self.saved = None

    @property
    def id(self):
        return "phase-1"

    def set(self, data):
        self.saved = data

    def update(self, data):
        self.saved = data


class _PhaseCollection:
    def __init__(self):
        self.reference = _PhaseReference()

    def where(self, *args, **kwargs):
        return self

    def limit(self, *args, **kwargs):
        return self

    def get(self):
        return []

    def document(self, *args):
        return self.reference


class PhaseTargetTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.register_blueprint(models.models_bp)
        self.client = self.app.test_client()
        self.token = generate_token("admin-1", "admin@example.com", "admin")
        self.collection = _PhaseCollection()
        self.collection_patch = patch.object(models, "_phase_doc", return_value=self.collection)
        self.collection_patch.start()
        self.addCleanup(self.collection_patch.stop)

    def post_phase(self, body):
        return self.client.post(
            "/models/model-1/phases",
            json=body,
            headers={"Authorization": f"Bearer {self.token}"},
        )

    def test_create_phase_persists_target_and_schedule(self):
        response = self.post_phase({
            "name": "Phase 1",
            "target": 100,
            "startDate": "2026-08-01",
            "endDate": "2026-10-31",
        })

        self.assertEqual(response.status_code, 201, response.get_json())
        self.assertEqual(response.get_json()["target"], 100)
        self.assertEqual(self.collection.reference.saved["target"], 100)
        self.assertEqual(self.collection.reference.saved["startDate"], "2026-08-01")
        self.assertEqual(self.collection.reference.saved["endDate"], "2026-10-31")

    def test_create_phase_rejects_non_positive_target(self):
        response = self.post_phase({
            "name": "Phase 1",
            "target": 0,
            "startDate": "2026-08-01",
            "endDate": "2026-10-31",
        })

        self.assertEqual(response.status_code, 400)

    def test_create_phase_rejects_fractional_target(self):
        response = self.post_phase({
            "name": "Phase 1",
            "target": 10.5,
            "startDate": "2026-08-01",
            "endDate": "2026-10-31",
        })

        self.assertEqual(response.status_code, 400)

    def test_create_phase_rejects_end_date_before_start_date(self):
        response = self.post_phase({
            "name": "Phase 1",
            "target": 100,
            "startDate": "2026-10-31",
            "endDate": "2026-08-01",
        })

        self.assertEqual(response.status_code, 400)

    def test_create_phase_with_name_only(self):
        response = self.post_phase({"name": "Phase 5", "target": "", "startDate": "", "endDate": ""})

        self.assertEqual(response.status_code, 201, response.get_json())
        saved = self.collection.reference.saved
        self.assertIsNone(saved["target"])
        self.assertIsNone(saved["startDate"])
        self.assertIsNone(saved["endDate"])

    def test_create_phase_with_start_date_only(self):
        response = self.post_phase({"name": "Phase 5", "target": None, "startDate": "2026-11-01", "endDate": None})

        self.assertEqual(response.status_code, 201, response.get_json())
        self.assertEqual(self.collection.reference.saved["startDate"], "2026-11-01")
        self.assertIsNone(self.collection.reference.saved["endDate"])

    def test_create_phase_with_target_only(self):
        response = self.post_phase({"name": "Phase 5", "target": 40})

        self.assertEqual(response.status_code, 201, response.get_json())
        self.assertEqual(self.collection.reference.saved["target"], 40)
        self.assertNotIn("startDate", self.collection.reference.saved)

    def test_create_phase_rejects_invalid_date(self):
        response = self.post_phase({"name": "Phase 5", "startDate": "not-a-date"})

        self.assertEqual(response.status_code, 400)

    def test_update_phase_saves_name_target_and_schedule(self):
        response = self.client.put(
            "/models/model-1/phases/phase-1",
            json={
                "name": "Phase 1 revised",
                "target": 120,
                "startDate": "2026-09-01",
                "endDate": "2026-12-31",
            },
            headers={"Authorization": f"Bearer {self.token}"},
        )

        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(self.collection.reference.saved, {
            "name": "Phase 1 revised",
            "normalizedName": "phase 1 revised",
            "target": 120,
            "startDate": "2026-09-01",
            "endDate": "2026-12-31",
        })


if __name__ == "__main__":
    unittest.main()

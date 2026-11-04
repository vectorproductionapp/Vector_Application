"""Tests for status values included in the dashboard production charts."""

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

import dashboard as dashboard_module  # noqa: E402
from auth_utils import generate_token  # noqa: E402
from dashboard import (  # noqa: E402
    _defective_parts_by_model,
    _has_recorded_status,
    _matches_dashboard_model,
    _phase_roadmap_data,
    _production_units_by_model,
    _sales_dashboard_data,
    dashboard_bp,
)


class DashboardStatusTests(unittest.TestCase):
    def test_blank_and_dash_placeholders_are_not_recorded_statuses(self):
        for status in (None, "", " ", "-", " – ", "—"):
            with self.subTest(status=status):
                self.assertFalse(_has_recorded_status(status))

    def test_real_pending_status_is_counted(self):
        self.assertTrue(_has_recorded_status("Pending"))

    def test_dashboard_model_filter_matches_name_case_insensitively(self):
        self.assertTrue(_matches_dashboard_model({"model": "Vector A"}, "vector a", set()))
        self.assertFalse(_matches_dashboard_model({"model": "Vector B"}, "vector a", set()))

    def test_dashboard_model_filter_matches_model_id_for_legacy_rows(self):
        self.assertTrue(_matches_dashboard_model({"modelId": "model-1"}, "Vector A", {"model-1"}))
        self.assertFalse(_matches_dashboard_model({"modelId": "model-2"}, "Vector A", {"model-1"}))

    def test_phase_roadmap_uses_production_units_for_each_phase(self):
        roadmap = _phase_roadmap_data(
            [
                {"modelId": "model-1", "model": "Vector A", "phaseId": "phase-1", "phase": "Phase 1", "target": 100},
                {"modelId": "model-1", "model": "Vector A", "phaseId": "phase-2", "phase": "Phase 2", "target": 50},
            ],
            [
                {"modelId": "model-1", "phaseId": "phase-1", "qty": 2},
                {"modelId": "model-1", "phaseId": "phase-1", "qty": 3},
                {"modelId": "model-1", "phaseId": "phase-2", "qty": 4},
            ],
        )

        self.assertEqual([phase["units"] for phase in roadmap], [5, 4])

    def test_production_units_by_model_include_all_qc_statuses(self):
        totals = _production_units_by_model([
            {"model": "Vector A", "qc": "Passed", "qty": 2},
            {"model": "Vector A", "qc": "passed", "qty": 3},
            {"model": "Vector B", "qc": "Under Inspection", "qty": 8},
            {"model": "Vector B", "qc": "Failed", "qty": 4},
            {"model": "Vector B", "qc": "", "qty": 1},
        ])

        self.assertEqual(totals, [
            {"model": "Vector B", "units": 13},
            {"model": "Vector A", "units": 5},
        ])

    def test_defective_parts_are_grouped_by_model(self):
        parts = _defective_parts_by_model([
            {"model": "Vector A", "part": "Screen"},
            {"model": "Vector A", "part": "Screen"},
            {"model": "Vector B", "part": "Screen"},
            {"model": "Vector B", "part": "Keyboard"},
        ])

        self.assertEqual(parts, [
            {"name": "Keyboard", "model": "Vector B", "count": 1},
            {"name": "Screen", "model": "Vector A", "count": 2},
            {"name": "Screen", "model": "Vector B", "count": 1},
        ])

    def test_dispatched_series_are_grouped_by_model_and_end_user(self):
        sales = [
            {"date": "2025-01-03", "model": "Vector A", "qty": 2, "dispatch": "Delivered", "endUserClient": "Client X", "endUserLocation": "City X"},
            {"date": "2025-01-04", "model": "Vector B", "qty": 3, "dispatch": "Dispatched", "endUserClient": "Client X", "endUserLocation": "City X"},
            {"date": "2025-01-05", "model": "Vector A", "qty": 5, "dispatch": "Pending", "endUserClient": "Client X", "endUserLocation": "City X"},
            {"date": "2025-01-06", "model": "Vector B", "qty": 7, "dispatch": "Cancelled", "endUserClient": "Client Y", "endUserLocation": "City Y"},
        ]

        payload = _sales_dashboard_data(sales, [], include_all_active_sales=True)

        self.assertEqual(payload["dispatchedByModelMonth"], [
            {"period": "2025-01", "model": "Vector A", "units": 2},
            {"period": "2025-01", "model": "Vector B", "units": 3},
        ])
        self.assertEqual(payload["dispatchedByModelDay"], [
            {"period": "2025-01-03", "model": "Vector A", "units": 2},
            {"period": "2025-01-04", "model": "Vector B", "units": 3},
        ])
        self.assertEqual(payload["endUserClientByModelDay"], [
            {"period": "2025-01-03", "client": "Client X", "model": "Vector A", "units": 2},
            {"period": "2025-01-04", "client": "Client X", "model": "Vector B", "units": 3},
        ])

    def test_dashboard_returns_model_sales_value_for_existing_sales(self):
        app = Flask(__name__)
        app.register_blueprint(dashboard_bp)
        sales = [
            {"date": "2025-01-03", "model": "Vector A", "qty": 2, "unitCost": 100, "dispatch": "Pending"},
        ]
        collections = {
            "assembly_units": [],
            "defective_units": [],
            "sale_register": sales,
            "customer_sales": [],
            "invoices": [],
            "po_details": [],
        }
        token = generate_token("admin-1", "admin@example.com", "admin")

        with patch.object(
            dashboard_module,
            "_stream_collection",
            side_effect=lambda name: collections.get(name, []),
        ):
            response = app.test_client().get(
                "/dashboard",
                headers={"Authorization": f"Bearer {token}"},
            )

        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(
            response.get_json()["salesByModel"],
            [{"model": "Vector A", "units": 2, "deliveredUnits": 0, "salesValue": 200}],
        )

    def test_day_by_model_series_add_up_to_the_monthly_series(self):
        import read_cache

        app = Flask(__name__)
        app.register_blueprint(dashboard_bp)
        units = [
            {"date": "2026-10-01", "model": "Vector A", "qty": 1, "qc": "Passed", "packagingStatus": "Packed"},
            {"date": "2026-10-02", "model": "Vector B", "qty": 1, "qc": "Failed"},
            {"date": "2026-10-09", "model": "Vector A", "qty": 2, "qc": "Passed", "packagingStatus": "Pending"},
            {"date": "2026-11-03", "model": "Vector B", "qty": 1, "qc": "Passed", "packagingStatus": "Packed"},
        ]
        sales = [
            {"date": "2026-10-05", "model": "Vector A", "qty": 2, "dispatch": "Pending"},
            {"date": "2026-10-20", "model": "Vector A", "qty": 1, "dispatch": "Delivered"},
            {"date": "2026-10-21", "model": "Vector B", "qty": 4, "dispatch": "Cancelled"},
        ]
        collections = {"assembly_units": units, "sale_register": sales}
        token = generate_token("admin-1", "admin@example.com", "admin")
        read_cache.invalidate_read_cache()
        with patch.object(dashboard_module, "_stream_collection", side_effect=lambda name: collections.get(name, [])):
            body = app.test_client().get("/dashboard", headers={"Authorization": f"Bearer {token}"}).get_json()

        def totals(series, month_of, keys):
            result = {}
            for item in series:
                key = (month_of(item["period"]),) + tuple(item[k] for k in keys)
                result[key] = result.get(key, 0) + item["units"]
            return result

        month = lambda period: period[:7]  # noqa: E731
        same = lambda period: period  # noqa: E731
        pairs = (
            ("assembledByDayUserModel", "assembledByMonthUserModel", ("user", "model")),
            ("qcByDayStatusUserModel", "qcByMonthStatusUserModel", ("status", "user", "model")),
            ("packagedByDayStatusUserModel", "packagedByMonthStatusUserModel", ("status", "user", "model")),
            ("salesByModelDay", "salesByModelMonth", ("model",)),
        )
        for day_key, month_key, keys in pairs:
            with self.subTest(series=day_key):
                self.assertTrue(body[day_key])
                self.assertEqual(totals(body[day_key], month, keys), totals(body[month_key], same, keys))
        # Cancelled sales are left out of both.
        self.assertNotIn("Vector B", {item["model"] for item in body["salesByModelDay"]})


if __name__ == "__main__":
    unittest.main()

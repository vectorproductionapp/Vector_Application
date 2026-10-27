"""Tests for status values included in the dashboard production charts."""

import os
import sys
import unittest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

os.environ["JWT_SECRET"] = "unit-test-secret-not-a-real-production-secret"
os.environ.pop("FIREBASE_PROJECT_ID", None)

from tests import fakes  # noqa: E402

fakes.install()

from dashboard import _has_recorded_status  # noqa: E402


class DashboardStatusTests(unittest.TestCase):
    def test_blank_and_dash_placeholders_are_not_recorded_statuses(self):
        for status in (None, "", " ", "-", " – ", "—"):
            with self.subTest(status=status):
                self.assertFalse(_has_recorded_status(status))

    def test_real_pending_status_is_counted(self):
        self.assertTrue(_has_recorded_status("Pending"))


if __name__ == "__main__":
    unittest.main()

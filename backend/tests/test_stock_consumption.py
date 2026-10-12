"""Tests for the stock-consumption rule.

The stock register and the dashboard both derive `consumed` from the production
units.  The rule these tests pin down:

    Every recorded production unit consumes material the moment it is created,
    regardless of stage, QC or packaging status.

Before this rule, only units that were both Completed *and* QC-passed counted,
so a unit that had just been booked in did not reduce stock until it had
travelled all the way through QC.
"""

import os
import sys
import unittest

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

# Deterministic environment BEFORE the application (and auth_utils) is imported.
os.environ["JWT_SECRET"] = "unit-test-secret-not-a-real-production-secret"
os.environ.pop("FIREBASE_PROJECT_ID", None)

from tests import fakes  # noqa: E402  (must run before the app is imported)

fakes.install()

from stockregister import _consumed_by_phase  # noqa: E402


class _Doc:
    """Minimal stand-in for a Firestore document snapshot."""

    def __init__(self, data):
        self._data = data

    def to_dict(self):
        return self._data


def _unit(model_id, phase_id, qty, stage="Pending", qc="Pending", packaging="Pending"):
    return _Doc({
        "modelId": model_id,
        "phaseId": phase_id,
        "qty": qty,
        "stage": stage,
        "qc": qc,
        "packagingStatus": packaging,
    })


class ConsumedByPhaseTests(unittest.TestCase):
    """The consumption gate must not depend on stage, QC or packaging."""

    def test_a_just_recorded_unit_consumes(self):
        """A unit booked in with no stage / QC / packaging still reduces stock."""
        consumed = _consumed_by_phase([_unit("M1", "P1", 1)])
        self.assertEqual(consumed, {("M1", "P1"): 1})

    def test_completed_and_qc_passed_unit_consumes(self):
        consumed = _consumed_by_phase(
            [_unit("M1", "P1", 1, stage="Completed", qc="Passed", packaging="Packed")]
        )
        self.assertEqual(consumed, {("M1", "P1"): 1})

    def test_qc_failed_unit_still_consumes(self):
        """A unit that failed QC is still material that left the store."""
        consumed = _consumed_by_phase(
            [_unit("M1", "P1", 1, stage="Completed", qc="Failed")]
        )
        self.assertEqual(consumed, {("M1", "P1"): 1})

    def test_packed_unit_consumes(self):
        consumed = _consumed_by_phase(
            [_unit("M1", "P1", 1, stage="Completed", qc="Passed", packaging="Packed")]
        )
        self.assertEqual(consumed, {("M1", "P1"): 1})

    def test_quantities_are_summed_per_model_and_phase(self):
        consumed = _consumed_by_phase([
            _unit("M1", "P1", 1),
            _unit("M1", "P1", 2),
            _unit("M1", "P2", 1),
            _unit("M2", "P1", 1),
        ])
        self.assertEqual(
            consumed,
            {("M1", "P1"): 3, ("M1", "P2"): 1, ("M2", "P1"): 1},
        )

    def test_zero_and_missing_qty_are_ignored(self):
        consumed = _consumed_by_phase([
            _unit("M1", "P1", 0),
            _Doc({"modelId": "M1", "phaseId": "P1"}),
        ])
        self.assertEqual(consumed, {})

    def test_plain_dicts_are_accepted(self):
        """The dashboard passes already-serialised dicts, not snapshots."""
        consumed = _consumed_by_phase([
            {"modelId": "M1", "phaseId": "P1", "qty": 2},
        ])
        self.assertEqual(consumed, {("M1", "P1"): 2})

    def test_empty_input(self):
        self.assertEqual(_consumed_by_phase([]), {})


if __name__ == "__main__":
    unittest.main()

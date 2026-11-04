"""Units built per phase for the dashboard roadmap / "Running phases vs target" card."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import fakes  # noqa: E402

fakes.install()

import dashboard  # noqa: E402


PLANS = [
    {"modelId": "m1", "model": "VE-PC-G1", "phaseId": "p1", "phase": "Phase 1", "target": 100},
    {"modelId": "m1", "model": "VE-PC-G1", "phaseId": "p2", "phase": "Phase 2", "target": 100},
    {"modelId": "m2", "model": "VE-PC-G2", "phaseId": "p3", "phase": "Phase 1", "target": 40},
]


def units(rows):
    return {row["phaseId"]: row["units"] for row in dashboard._phase_roadmap_data(PLANS, rows)}


class PhaseRoadmapUnitsTest(unittest.TestCase):
    def test_counts_units_by_phase_id(self):
        result = units([
            {"modelId": "m1", "phaseId": "p1", "qty": 3},
            {"modelId": "m1", "phaseId": "p2", "qty": 2},
            {"modelId": "m2", "phaseId": "p3", "qty": 5},
        ])
        self.assertEqual(result, {"p1": 3, "p2": 2, "p3": 5})

    def test_phase_id_without_model_id_still_counts(self):
        self.assertEqual(units([{"phaseId": "p2", "qty": 4}])["p2"], 4)

    def test_legacy_unit_matched_by_model_name_and_phase_name(self):
        result = units([
            {"model": "ve-pc-g1", "phase": "phase 1", "qty": 2},
            {"modelId": "m2", "phase": "Phase 1", "qty": 1},
        ])
        self.assertEqual(result, {"p1": 2, "p2": 0, "p3": 1})

    def test_same_phase_name_on_other_model_is_not_mixed(self):
        result = units([{"model": "VE-PC-G2", "phase": "Phase 1", "qty": 7}])
        self.assertEqual(result["p1"], 0)
        self.assertEqual(result["p3"], 7)


if __name__ == "__main__":
    unittest.main()

"""Central matcher unit tests (no network, no credentials)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from matching import MAX_DISTANCE_KM, match_candidates, name_key, normalize_name


def hes(name="Atatürk Barajı", lon=38.5, lat=37.8, **props):
    properties = {"id": "hes177-001", "name": name, **props}
    return {"id": "hes177-001", "properties": properties,
            "geometry": {"type": "Point", "coordinates": [lon, lat]}}


class MatchingTest(unittest.TestCase):
    def test_turkish_normalization(self):
        self.assertEqual(name_key("Adıgüzel HES"), name_key("ADIGUZEL BARAJI"))
        self.assertNotIn("HES", normalize_name("Adıgüzel HES").split())

    def test_roman_numerals_and_parentheses_kept_out(self):
        self.assertEqual(name_key("Adıgüzel 2 HES"), name_key("Adıgüzel II (Pompaj) Barajı"))

    def test_exact_match_close_spatial(self):
        best, rejected = match_candidates(hes(), [{"providerTargetId": "t1", "name": "Atatürk Barajı",
                                                   "lon": 38.51, "lat": 37.81}], provider="dahiti")
        self.assertIsNotNone(best)
        self.assertEqual(best["matchConfidence"], "high")
        self.assertEqual(best["matchMethod"], "name+coordinate")
        self.assertEqual(rejected, [])

    def test_far_same_name_rejected(self):
        best, rejected = match_candidates(hes(), [{"providerTargetId": "t1", "name": "Atatürk Barajı",
                                                   "lon": 20.0, "lat": 40.0}], provider="dahiti")
        self.assertIsNone(best)
        self.assertEqual(len(rejected), 1)
        self.assertIn(str(int(MAX_DISTANCE_KM)), rejected[0]["rejectReason"])

    def test_close_spatial_with_basin_match(self):
        candidate = hes(name="X Barajı", lon=38.5, lat=37.8, basinName="Fırat")
        record = {"providerTargetId": "t2", "name": "Completely Different", "lon": 38.52, "lat": 37.82,
                  "basinName": "Fırat Havzası"}
        best, _ = match_candidates(candidate, [record], provider="hydroweb")
        self.assertIsNotNone(best)

    def test_ambiguous_prefers_better_rank(self):
        records = [{"providerTargetId": "far", "name": "Atatürk Barajı", "lon": 38.7, "lat": 37.9},
                   {"providerTargetId": "near", "name": "Atatürk Barajı", "lon": 38.51, "lat": 37.81}]
        best, _ = match_candidates(hes(), records, provider="dahiti")
        self.assertEqual(best["providerTargetId"], "near")

    def test_no_evidence_no_match(self):
        best, rejected = match_candidates(hes(), [{"providerTargetId": "t9", "name": "Qwerty Lake",
                                                   "lon": -100.0, "lat": 60.0}], provider="swot")
        self.assertIsNone(best)
        self.assertEqual(rejected, [])


if __name__ == "__main__":
    unittest.main()

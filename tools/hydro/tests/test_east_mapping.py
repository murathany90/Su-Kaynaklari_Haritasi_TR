"""East/Southeast big-dam mapping + missing-reason taxonomy tests."""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ROOT = Path(__file__).resolve().parents[3]


def load_hes():
    return json.loads((ROOT / "public/data/hes177/hes_177.geojson").read_text(encoding="utf-8"))


class EastMappingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.features = {str(f["properties"].get("id")): f for f in load_hes()["features"]}

    def test_big_five_present_with_dams(self):
        from matching import name_key
        expectations = {"hes177-025": "ATATURK", "hes177-105": "KEBAN", "hes177-093": "KARAKAYA",
                        "hes177-086": "ILISU", "hes177-059": "DERINER"}
        for hes_id, dam_part in expectations.items():
            props = self.features[hes_id]["properties"]
            self.assertIn(dam_part, name_key(props.get("damName") or props.get("name")))

    def test_ataturk_karakaya_keep_storage_and_polygon(self):
        for hes_id in ("hes177-025", "hes177-093"):
            props = self.features[hes_id]["properties"]
            self.assertTrue(props.get("reservoirIds"), hes_id)
            self.assertEqual(props.get("reservoirMatchConfidence"), "high")

    def test_keban_ilisu_deriner_have_polygons(self):
        for hes_id in ("hes177-105", "hes177-086", "hes177-059"):
            props = self.features[hes_id]["properties"]
            self.assertTrue(props.get("reservoirIds"), hes_id)
            self.assertIn("approximate", str(props.get("reservoirMatchMethod") or ""))

    def test_dam_reservoir_map_covers_all(self):
        mapping = json.loads((ROOT / "public/data/static/mappings/hes_dam_reservoir_map.json").read_text(encoding="utf-8"))
        self.assertEqual(mapping["hesCount"], 129)
        self.assertEqual(len(mapping["records"]), 129)
        required = {"hesId", "hesName", "damName", "reservoirName", "river", "basin", "coordinates",
                    "reservoirPolygonId", "storageType"}
        for row in mapping["records"]:
            self.assertTrue(required.issubset(row), row.get("hesId"))

    def test_missing_reasons_use_taxonomy(self):
        from audit_fullness_sources import MISSING_REASONS
        missing = json.loads((ROOT / "reports/fullness_missing_sources.json").read_text(encoding="utf-8"))
        self.assertIn("providersChecked", missing)
        self.assertIn("providersSkipped", missing)
        for record in missing["records"]:
            self.assertIn(record["reason"], MISSING_REASONS, record["hesId"])
            self.assertNotEqual(record["reason"], "no_match", record["hesId"])

    def test_skipped_not_in_checked(self):
        missing = json.loads((ROOT / "reports/fullness_missing_sources.json").read_text(encoding="utf-8"))
        overlap = set(missing["providersChecked"]) & set(missing["providersSkipped"])
        self.assertEqual(overlap, set())
        # Skipped entries carry reasons.
        for provider, reason in missing["providersSkipped"].items():
            self.assertTrue(reason, provider)


if __name__ == "__main__":
    unittest.main()

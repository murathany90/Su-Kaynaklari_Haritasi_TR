"""Calculation / history / integration tests (mocked providers only)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from audit_fullness_sources import (
    build_timeseries,
    complete_fullness_record,
    hypsometry_percent,
    make_result,
    select_best_fullness_record,
    volume_percent_raw,
)
from providers import dedupe_key
from storage_types import classify_storage


def record(source_class, value, **over):
    base = {"hesId": "hes177-t", "fullnessPercent": value, "sourceClass": source_class, "source": "canonical",
            "status": "available", "observedAt": "2026-09-15", "fetchedAt": "2026-09-16T00:00:00Z",
            "confidence": "medium", "isEstimated": source_class == "calculated_storage", "method": "test"}
    base.update(over)
    return base


class CalculationTest(unittest.TestCase):
    def test_valid_volume(self):
        raw, warning = volume_percent_raw({"activeVolumeHm3": 30, "minVolumeHm3": 10, "maxVolumeHm3": 110})
        self.assertAlmostEqual(raw, 30.0)
        self.assertIsNone(warning)

    def test_missing_fields(self):
        self.assertEqual(volume_percent_raw({"activeVolumeHm3": 30}), (None, None))

    def test_invalid_denominator(self):
        self.assertEqual(volume_percent_raw({"activeVolumeHm3": 30, "minVolumeHm3": 10, "maxVolumeHm3": 10}), (None, None))

    def test_over_100_warns(self):
        raw, warning = volume_percent_raw({"activeVolumeHm3": 200, "minVolumeHm3": 10, "maxVolumeHm3": 110})
        self.assertGreater(raw, 100)
        self.assertIsNotNone(warning)

    def test_negative_warns(self):
        raw, warning = volume_percent_raw({"activeVolumeHm3": -5, "minVolumeHm3": 10, "maxVolumeHm3": 110})
        self.assertLess(raw, 0)
        self.assertIsNotNone(warning)

    def test_run_of_river_not_applicable(self):
        hes = {"id": "h", "properties": {"id": "h", "hydroPlantStorageType": "run_of_river"}}
        result = make_result(hes, None, "2026-09-16T00:00:00Z", {}, None)
        self.assertEqual(result["status"], "not_applicable")
        self.assertIsNone(result["fullnessPercent"])

    def test_hypsometry_gates_percent(self):
        curve = {"levelsM": [100, 110], "volumesHm3": [50, 150]}
        percent, note = hypsometry_percent(curve, 105, None, 50, 150)
        self.assertAlmostEqual(percent, 50.0)
        percent, note = hypsometry_percent({}, 105, None, 50, 150)
        self.assertIsNone(percent)

    def test_resolver_priority_and_low_confidence(self):
        now = "2026-09-16T00:00:00Z"
        official = record("official_live", 64, source="epias", confidence="low")
        calculated = record("calculated_storage", 52, confidence="high")
        self.assertEqual(select_best_fullness_record([calculated, official], now)["sourceClass"], "official_live")
        old = record("official_live", 64, source="epias", observedAt="2024-01-01", confidence="low")
        fresh = record("satellite_altimetry", 58, source="swot", confidence="high")
        self.assertEqual(select_best_fullness_record([old, fresh], now)["sourceClass"], "satellite_altimetry")


class HistoryTest(unittest.TestCase):
    def test_dedupe_same_observation(self):
        key = lambda r: dedupe_key(r["hesId"], r.get("provider") or r.get("source"), r.get("observedAt"), r.get("sourceClass"))
        first = record("calculated_storage", 52)
        self.assertEqual(key(first), key(dict(first)))

    def test_new_observation_new_point(self):
        snapshots = {
            "a.json": {"pipelineRunAt": "2026-09-15T00:00:00Z", "records": [record("calculated_storage", 52, observedAt="2026-09-13")]},
            "b.json": {"pipelineRunAt": "2026-09-16T00:00:00Z", "records": [record("calculated_storage", 53, observedAt="2026-09-14")]},
        }
        import tempfile, json
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, payload in snapshots.items():
                (root / name).write_text(json.dumps(payload), encoding="utf-8")
            series = build_timeseries(root, "2026-09-16T00:00:00Z")
        self.assertEqual(series["observationCount"], 2)

    def test_windows_use_observation_dates(self):
        import tempfile, json
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "s.json").write_text(json.dumps({"pipelineRunAt": "2026-09-16T00:00:00Z", "records": [
                record("calculated_storage", 52, observedAt="2026-09-10"),
                record("calculated_storage", 53, observedAt="2026-01-01")]}), encoding="utf-8")
            series = build_timeseries(root, "2026-09-16T00:00:00Z")
        dates = sorted(p["date"] for r in series["records"] for p in r["points"])
        self.assertEqual(dates, ["2026-01-01", "2026-09-10"])


class IntegrationTest(unittest.TestCase):
    def test_raw_to_frontend_json(self):
        """raw provider row -> match -> resolver -> completed canonical record."""
        hes = {"id": "hes177-001", "properties": {"id": "hes177-001", "name": "Atatürk Barajı",
                                                  "minVolumeHm3": 10, "maxVolumeHm3": 110, "activeVolumeHm3": 30,
                                                  "basinName": "Fırat"},
               "geometry": {"type": "Point", "coordinates": [38.5, 37.8]}}
        rows = [{"provider": "dahiti", "providerTargetId": "d1", "name": "Atatürk",
                 "lon": 38.51, "lat": 37.81, "observedAt": "2026-09-15",
                 "sourceClass": "satellite_altimetry", "waterLevelM": 105.0}]
        stats: dict = {}
        result = make_result(hes, None, "2026-09-16T00:00:00Z", {}, None,
                             provider_obs={"dahiti": rows}, curves={}, provider_stats=stats)
        completed = complete_fullness_record(result)
        self.assertIn(completed["status"], {"available", "stale", "unavailable"})
        self.assertIn("provider", completed)
        self.assertIn("freshnessLabel", completed)
        # No hypsometry -> never an invented percent from level-only rows.
        if completed["source"] == "dahiti":
            self.assertIsNone(completed["fullnessPercent"])


if __name__ == "__main__":
    unittest.main()

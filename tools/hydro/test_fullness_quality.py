"""Targeted no-framework checks for fullness source and history semantics.

Also validates the published canonical snapshot against
``schemas/hes_fullness.schema.json`` with a stdlib-only checker (no extra
dependencies in CI).
"""

from __future__ import annotations

import json
import math
import tempfile
from pathlib import Path

from audit_fullness_sources import (
    complete_fullness_record,
    freshness_label,
    make_result,
    mark_last_known_good,
    merge_daily_snapshot,
    select_best_fullness_record,
    volume_percent_raw,
)
from matching import match_candidates
from providers import dedupe_key
from storage_types import classify_storage


def record(source_class: str, value: float, *, source: str = "canonical", observed: str = "2026-09-15", status: str = "available", confidence: str = "medium") -> dict:
    return {"hesId": "hes177-test", "fullnessPercent": value, "sourceClass": source_class, "source": source, "status": status, "observedAt": observed, "fetchedAt": "2026-09-16T00:00:00Z", "confidence": confidence, "isEstimated": source_class == "calculated_storage", "method": "test"}


def main() -> None:
    now = "2026-09-16T00:00:00Z"
    official = record("official_live", 64, source="epias", confidence="high")
    calculated = record("calculated_storage", 52)
    assert select_best_fullness_record([calculated, official], now)["sourceClass"] == "official_live"
    old_official = record("official_live", 64, source="epias", observed="2024-01-01")
    fresh_satellite = record("satellite_altimetry", 58, source="swot", observed="2026-09-15", confidence="high")
    assert select_best_fullness_record([old_official, fresh_satellite], now)["sourceClass"] == "satellite_altimetry"
    assert select_best_fullness_record([record("official_live", 150, source="epias")], now) is None
    assert select_best_fullness_record([record("official_live", 64, source="epias", observed="2027-01-01")], now) is None
    assert mark_last_known_good(official, now)["status"] == "available"
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "2026-09-16.json"
        payload = {"pipelineRunAt": now, "records": [calculated]}
        merged = merge_daily_snapshot(path, payload, now)
        assert len(merged["records"]) == 1
        path.write_text(json.dumps({"revision": 1, "records": [calculated]}), encoding="utf-8")
        merged_again = merge_daily_snapshot(path, payload, now)
        assert len(merged_again["records"]) == 1
    # Canonical contract fields on every selected record.
    completed = complete_fullness_record(dict(official))
    assert completed["provider"] == "EPİAŞ", completed
    assert completed["freshnessLabel"] in {"fresh", "stale", "old", "unknown"}, completed
    assert completed["observationTimestamp"] == completed["observedAt"], completed
    # Dedupe key: hesId + provider + observationTimestamp + sourceClass.
    assert dedupe_key("hes1", "epias", "2026-09-15", "official_live") == "hes1|epias|2026-09-15|official_live"
    assert dedupe_key("hes1", "epias", "2026-09-15", "official_live") != dedupe_key("hes1", "epias", "2026-09-16", "official_live")
    # Volume formula + out-of-range warning (never silent).
    raw, warning = volume_percent_raw({"activeVolumeHm3": 30, "minVolumeHm3": 10, "maxVolumeHm3": 110})
    assert raw is not None and abs(raw - 30.0) < 1e-9 and warning is None
    raw, warning = volume_percent_raw({"activeVolumeHm3": 200, "minVolumeHm3": 10, "maxVolumeHm3": 110})
    assert raw is not None and raw > 100 and warning is not None
    assert volume_percent_raw({"activeVolumeHm3": 30, "minVolumeHm3": 110, "maxVolumeHm3": 10}) == (None, None)
    # Storage classification provence; run_of_river -> not_applicable.
    assert classify_storage({"hydroPlantStorageType": "run_of_river"})["storageType"] == "run_of_river"
    assert classify_storage({"notes": "nehir tipi santral"})["storageType"] == "run_of_river"
    assert classify_storage({"minVolumeHm3": 10, "maxVolumeHm3": 110, "activeVolumeHm3": 30})["storageType"] == "storage"
    assert classify_storage({})["storageType"] == "unknown"
    ror_hes = {"id": "hes177-ror", "properties": {"id": "hes177-ror", "name": "Test", "hydroPlantStorageType": "run_of_river"}}
    ror_result = make_result(ror_hes, None, now, {}, None)
    assert ror_result["status"] == "not_applicable" and ror_result["fullnessPercent"] is None, ror_result
    # Central matcher: far same-name reservoir is rejected, never accepted.
    near_hes = {"id": "h1", "properties": {"id": "h1", "name": "Atatürk Barajı"},
                "geometry": {"type": "Point", "coordinates": [38.5, 37.8]}}
    far_record = {"providerTargetId": "x", "name": "Atatürk Barajı", "lon": 20.0, "lat": 40.0}
    best, rejected = match_candidates(near_hes, [far_record], provider="dahiti")
    assert best is None and len(rejected) == 1, (best, rejected)
    near_record = {"providerTargetId": "y", "name": "Atatürk Barajı", "lon": 38.51, "lat": 37.81}
    best, rejected = match_candidates(near_hes, [near_record], provider="dahiti")
    assert best is not None and best["matchConfidence"] == "high" and not rejected, (best, rejected)
    # Provider freshness policy: EPİAŞ >2d stale, >7d old.
    assert freshness_label("epias", 1) == "fresh"
    assert freshness_label("epias", 3) == "stale"
    assert freshness_label("epias", 8) == "old"
    assert freshness_label("swot", 30) == "fresh"
    validate_published_snapshot()
    print("fullness quality checks: PASS")


STATUSES = {"available", "stale", "unavailable", "not_applicable"}
SOURCE_CLASSES = {"official", "official_live", "official_published", "satellite_altimetry", "satellite_area", "calculated_storage", "historical", "mock"}
CONFIDENCES = {"high", "medium", "low"}
FRESHNESS_LABELS = {"fresh", "stale", "old", "unknown"}
STORAGE_TYPES = {"storage", "run_of_river", "regulator", "mixed", "unknown"}


def validate_published_snapshot() -> None:
    """Stdlib-only validation of the canonical snapshot against the schema."""
    root = Path(__file__).resolve().parents[2]
    schema = json.loads((root / "schemas" / "hes_fullness.schema.json").read_text(encoding="utf-8"))
    snapshot_path = root / "public" / "data" / "live" / "hes_fullness_latest.json"
    payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
    assert schema["required"] and all(key in payload for key in ("dataVersion", "pipelineRunAt", "status", "coverage", "records")), "snapshot envelope"
    records = payload["records"]
    assert isinstance(records, list) and len(records) == 129, f"expected 129 HES records, got {len(records) if isinstance(records, list) else type(records)}"
    ids = set()
    for record in records:
        for field in ("hesId", "status", "fullnessPercent", "sourceClass", "provider", "fetchedAt", "confidence", "method"):
            assert field in record, f"missing {field} in {record.get('hesId')}"
        assert record["status"] in STATUSES, record
        assert record["sourceClass"] in SOURCE_CLASSES, record
        assert record["confidence"] in CONFIDENCES, record
        assert record.get("freshnessLabel", "unknown") in FRESHNESS_LABELS, record
        assert record.get("storageType", "unknown") in STORAGE_TYPES, record
        value = record["fullnessPercent"]
        assert value is None or (isinstance(value, (int, float)) and math.isfinite(value) and 0 <= value <= 100), record
        assert record["hesId"] not in ids, f"duplicate {record['hesId']}"
        ids.add(record["hesId"])
        if record["status"] == "not_applicable":
            assert value is None, record
    print(f"snapshot schema checks: PASS ({len(records)} records)")


if __name__ == "__main__":
    main()

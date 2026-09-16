"""Targeted no-framework checks for fullness source and history semantics."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from audit_fullness_sources import mark_last_known_good, merge_daily_snapshot, select_best_fullness_record


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
    print("fullness quality checks: PASS")


if __name__ == "__main__":
    main()

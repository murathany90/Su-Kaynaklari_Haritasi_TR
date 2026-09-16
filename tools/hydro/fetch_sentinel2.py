"""Sentinel-2 NDWI/MNDWI fallback pipeline (opt-in).

Chain per reservoir without altimetry::

    Sentinel-2 L2A -> NDWI/MNDWI -> water polygon -> surface area
    -> hypsometry (level-area curve) -> volume -> fullness %

Rules enforced here and downstream:

* disabled unless ``SENTINEL2_ENABLED=1`` (heavy tile processing);
* cloud threshold (``SENTINEL2_MAX_CLOUD``) + quality flag on every record;
* WITHOUT hypsometry only area is published — never an invented %.

This module stages area observations; the audit resolver derives % only
when ``reservoir_hypsometry.json`` covers the reservoir.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from providers import canonical_observation, summarize, utc_now, write_provider_file


def to_number(value: Any) -> float | None:
    try:
        parsed = float(value)
        return parsed if parsed == parsed and abs(parsed) != float("inf") else None
    except (TypeError, ValueError):
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mapping", default="public/data/static/mappings/sentinel2_targets.json")
    parser.add_argument("--max-cloud", type=float, default=float(os.getenv("SENTINEL2_MAX_CLOUD", "20")))
    args = parser.parse_args()
    started = time.monotonic()
    fetched_at = utc_now()
    if os.getenv("SENTINEL2_ENABLED") != "1":
        write_provider_file("sentinel2_area", {"generatedAt": fetched_at, "status": "skipped",
                                               "errorCode": "credentials_missing", "observations": [],
                                               "errors": ["SENTINEL2_ENABLED is not 1 (opt-in tile pipeline)"]})
        summarize("Sentinel2", status="skipped", error_code="credentials_missing")
        return 0
    try:
        mapping = json.loads(Path(args.mapping).read_text(encoding="utf-8"))
        staged = mapping.get("stagedObservations", [])
    except (OSError, json.JSONDecodeError):
        staged = []
    observations: list[dict[str, Any]] = []
    rejected = 0
    for row in staged:
        if not isinstance(row, dict):
            continue
        cloud = to_number(row.get("cloudPercent"))
        area = to_number(row.get("surfaceAreaKm2"))
        observed = row.get("observedAt")
        if area is None or not observed or (cloud is not None and cloud > args.max_cloud):
            rejected += 1
            continue
        observations.append(canonical_observation(
            provider="sentinel", provider_target_id=str(row.get("targetId") or ""),
            observed_at=str(observed), source_class="satellite_area", surface_area_km2=area,
            quality=f"cloud_{cloud}%" if cloud is not None else "cloud_unknown",
            dam_name=row.get("name"), lon=row.get("lon"), lat=row.get("lat"),
            source_url="https://dataspace.copernicus.eu/", product="sentinel2-ndwi-area",
            raw={"cloudPercent": cloud, "canonicalHesId": row.get("canonicalHesId"),
                 "note": "area only; % requires hypsometry"}))
    latest = max((str(o.get("observedAt") or "") for o in observations), default=None) or None
    status = "ok" if observations else "empty"
    write_provider_file("sentinel2_area", {"generatedAt": fetched_at, "status": status,
                                           "errorCode": None if observations else "empty_result",
                                           "maxCloudPercent": args.max_cloud,
                                           "observations": observations, "errors": []})
    summarize("Sentinel2", fetched=len(staged), matched=0, usable=len(observations), rejected=rejected,
              latest_observation=latest, duration_s=time.monotonic() - started, status=status)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

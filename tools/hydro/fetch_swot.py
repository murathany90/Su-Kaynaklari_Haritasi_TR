"""NASA SWOT (Earthdata) adapter — optional.

Credentials from ``EARTHDATA_TOKEN`` (or ``EARTHDATA_USERNAME`` /
``EARTHDATA_PASSWORD`` for the token exchange). Absent -> ``skipped``.

Supports water-surface-elevation, surface area, storage change + quality
flag as ``satellite_altimetry``. Old observations are NEVER presented as
live: every record carries its real ``observedAt`` and the resolver applies
the SWOT freshness policy.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from providers import canonical_observation, summarize, utc_now, write_provider_file

SWOT_SOURCE_URL = "https://podaac.earthdata.nasa.gov/"


def to_number(value: Any) -> float | None:
    try:
        parsed = float(value)
        return parsed if parsed == parsed and abs(parsed) != float("inf") else None
    except (TypeError, ValueError):
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mapping", default="public/data/static/mappings/swot_targets.json")
    parser.add_argument("--max-age-days", type=int, default=120,
                        help="Ignore SWOT observations older than this (never show stale as live).")
    args = parser.parse_args()
    started = time.monotonic()
    fetched_at = utc_now()
    token = os.getenv("EARTHDATA_TOKEN")
    if not token and not (os.getenv("EARTHDATA_USERNAME") and os.getenv("EARTHDATA_PASSWORD")):
        write_provider_file("swot_levels", {"generatedAt": fetched_at, "status": "skipped",
                                            "errorCode": "credentials_missing", "observations": [],
                                            "errors": ["EARTHDATA_TOKEN (or USERNAME/PASSWORD) is not configured"]})
        summarize("SWOT", status="skipped", error_code="credentials_missing")
        return 0
    # Full SWOT granule search/download (CMR + S3) is out of CI scope; this
    # adapter stages the mapping + freshness gate so a future granule worker
    # can drop canonical observations here without pipeline changes.
    import json
    try:
        mapping = json.loads(Path(args.mapping).read_text(encoding="utf-8"))
        staged = mapping.get("stagedObservations", [])
    except (OSError, json.JSONDecodeError):
        staged = []
    cutoff = fetched_at[:10]
    observations: list[dict[str, Any]] = []
    for row in staged:
        if not isinstance(row, dict):
            continue
        observed = str(row.get("observedAt") or "")
        try:
            age_days = (time.mktime(time.strptime(cutoff, "%Y-%m-%d")) - time.mktime(time.strptime(observed[:10], "%Y-%m-%d"))) / 86400
        except (ValueError, TypeError):
            continue
        if age_days < 0 or age_days > args.max_age_days:
            continue
        observations.append(canonical_observation(
            provider="swot", provider_target_id=str(row.get("reachId") or row.get("targetId") or ""),
            observed_at=observed, source_class="satellite_altimetry",
            water_level_m=to_number(row.get("wseM")), surface_area_km2=to_number(row.get("areaKm2")),
            quality=str(row.get("qualityFlag") or "") or None, dam_name=row.get("name"),
            lon=row.get("lon"), lat=row.get("lat"), source_url=SWOT_SOURCE_URL,
            product="swot-lake", raw={"storageChangeKm3": to_number(row.get("storageChangeKm3"))}))
    latest = max((str(o.get("observedAt") or "") for o in observations), default=None) or None
    status = "ok" if observations else "empty"
    write_provider_file("swot_levels", {"generatedAt": fetched_at, "status": status,
                                        "errorCode": None if observations else "empty_result",
                                        "observations": observations, "errors": []})
    summarize("SWOT", fetched=len(staged), matched=0, usable=len(observations), rejected=len(staged) - len(observations),
              latest_observation=latest, duration_s=time.monotonic() - started, status=status)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

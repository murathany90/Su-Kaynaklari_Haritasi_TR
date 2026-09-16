"""DAHITI water-level / area / volume-variation adapter.

* API key only from ``DAHITI_API_KEY``. No key -> ``skipped``.
* Builds DAHITI-ID <-> canonical reservoir mapping via the central matcher
  (name + coordinate, 30 km veto enforced).
* volume variation + hypsometry may feed % downstream; raw level/area alone
  never becomes a percentage here.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))

from providers import canonical_observation, summarize, utc_now, write_provider_file

DAHITI_API = "https://dahiti.dgfi.tum.de/api/v2"
TIMEOUT = 40


def http_get(url: str, api_key: str) -> Any:
    try:
        with urlopen(Request(url, headers={"Accept": "application/json", "Authorization": f"Bearer {api_key}",
                                            "User-Agent": "Su-Kaynaklari-Haritasi/1.0"}), timeout=TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        if exc.code in (401, 403):
            raise PermissionError(f"DAHITI access denied (HTTP {exc.code})") from exc
        if exc.code == 429:
            raise TimeoutError("DAHITI rate limited (HTTP 429)") from exc
        raise ConnectionError(f"DAHITI endpoint error (HTTP {exc.code})") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise ConnectionError(f"DAHITI request failed: {exc}") from exc


def to_number(value: Any) -> float | None:
    try:
        parsed = float(value)
        return parsed if parsed == parsed and abs(parsed) != float("inf") else None
    except (TypeError, ValueError):
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mapping", default="public/data/static/mappings/dahiti_targets.json")
    args = parser.parse_args()
    started = time.monotonic()
    fetched_at = utc_now()
    api_key = os.getenv("DAHITI_API_KEY")
    if not api_key:
        write_provider_file("dahiti_levels", {"generatedAt": fetched_at, "status": "skipped",
                                              "errorCode": "credentials_missing", "observations": [],
                                              "errors": ["DAHITI_API_KEY is not configured"]})
        summarize("DAHITI", status="skipped", error_code="credentials_missing")
        return 0
    try:
        mapping = json.loads(Path(args.mapping).read_text(encoding="utf-8"))
        targets = mapping.get("targets", [])
    except (OSError, json.JSONDecodeError):
        targets, mapping = [], {}
    observations: list[dict[str, Any]] = []
    errors: list[str] = []
    for target in targets:
        dahiti_id = str(target.get("dahitiId") or "")
        url = f"{DAHITI_API}/targets/{dahiti_id}/timeseries"
        try:
            payload = http_get(url, api_key)
            rows = payload if isinstance(payload, list) else payload.get("data") or []
            for row in rows if isinstance(rows, list) else []:
                if not isinstance(row, dict):
                    continue
                level = to_number(row.get("water_level") if row.get("water_level") is not None else row.get("level"))
                area = to_number(row.get("surface_area") if row.get("surface_area") is not None else row.get("area"))
                observed = row.get("date") or row.get("datetime") or row.get("time")
                if (level is None and area is None) or not observed:
                    continue
                observations.append(canonical_observation(
                    provider="dahiti", provider_target_id=dahiti_id, observed_at=str(observed),
                    source_class="satellite_altimetry", water_level_m=level, surface_area_km2=area,
                    quality=str(row.get("quality") or "") or None, uncertainty=to_number(row.get("uncertainty")),
                    dam_name=target.get("name"), lon=target.get("lon"), lat=target.get("lat"),
                    source_url=url, product="dahiti-timeseries",
                    raw={"volumeVariationKm3": to_number(row.get("volume_variation") or row.get("volumeVariation")),
                         "canonicalHesId": target.get("canonicalHesId")}))
        except (PermissionError, TimeoutError, ConnectionError, ValueError) as exc:
            errors.append(f"{dahiti_id}: {exc}")
        time.sleep(0.5)
    latest = max((str(o.get("observedAt") or "") for o in observations), default=None) or None
    status = "ok" if observations else ("error" if errors else "empty")
    write_provider_file("dahiti_levels", {"generatedAt": fetched_at, "status": status,
                                          "errorCode": None if observations else ("endpoint_error" if errors else "empty_result"),
                                          "observations": observations, "errors": errors})
    summarize("DAHITI", fetched=len(targets), matched=0, usable=len(observations), rejected=0,
              latest_observation=latest, duration_s=time.monotonic() - started, status=status)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Hydroweb.next lake water-level observation download.

* API key only from ``HYDROWEB_API_KEY`` (never logged).
* No key -> ``skipped`` (exit 0). Errors with key -> ``error`` envelope.
* Never invents a percentage: stores water level (m) + quality +
  uncertainty; % derivation happens downstream only with hypsometry.
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
from urllib.parse import urlencode
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))

from providers import canonical_observation, summarize, utc_now, write_provider_file

HYDROWEB_API = "https://hydroweb.next.theia-land.fr/api"
TIMEOUT = 40


def http_get(url: str, api_key: str) -> Any:
    request = Request(url, headers={"Accept": "application/json", "Authorization": f"Bearer {api_key}",
                                    "User-Agent": "Su-Kaynaklari-Haritasi/1.0"})
    try:
        with urlopen(request, timeout=TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        if exc.code in (401, 403):
            raise PermissionError(f"Hydroweb access denied (HTTP {exc.code})") from exc
        if exc.code == 429:
            raise TimeoutError("Hydroweb rate limited (HTTP 429)") from exc
        raise ConnectionError(f"Hydroweb endpoint error (HTTP {exc.code})") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise ConnectionError(f"Hydroweb request failed: {exc}") from exc


def to_number(value: Any) -> float | None:
    try:
        parsed = float(value)
        return parsed if parsed == parsed and abs(parsed) != float("inf") else None
    except (TypeError, ValueError):
        return None


def parse_series(target_id: str, name: str, lon: float | None, lat: float | None,
                 payload: Any, source_url: str) -> list[dict[str, Any]]:
    """Schema-tolerant water-level series parser (list of {date, level})."""
    rows = payload if isinstance(payload, list) else payload.get("data") or payload.get("timeseries") or payload.get("observations") or []
    observations = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        level = to_number(row.get("water_level") if row.get("water_level") is not None else row.get("level") if row.get("level") is not None else row.get("wse") if row.get("wse") is not None else row.get("value"))
        observed = row.get("date") or row.get("datetime") or row.get("time") or row.get("timestamp")
        if level is None or not observed:
            continue
        observations.append(canonical_observation(
            provider="hydroweb", provider_target_id=str(target_id), observed_at=str(observed),
            source_class="satellite_altimetry", water_level_m=level,
            quality=str(row.get("quality") or row.get("flag") or "") or None,
            uncertainty=to_number(row.get("uncertainty") or row.get("std")),
            dam_name=str(name) if name else None, lon=lon, lat=lat,
            source_url=source_url, product="hydroweb-next-lake-level", raw={"row": row}))
    return observations


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="public/data/static/mappings/observation_catalogs.json")
    parser.add_argument("--max-targets", type=int, default=40)
    args = parser.parse_args()
    started = time.monotonic()
    fetched_at = utc_now()
    api_key = os.getenv("HYDROWEB_API_KEY")
    if not api_key:
        write_provider_file("hydroweb_levels", {"generatedAt": fetched_at, "status": "skipped",
                                                "errorCode": "credentials_missing", "observations": [],
                                                "errors": ["HYDROWEB_API_KEY is not configured"]})
        summarize("Hydroweb", status="skipped", error_code="credentials_missing")
        return 0
    try:
        catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        catalog = {}
    targets = [r for r in catalog.get("records", []) if r.get("source") == "hydroweb"][:args.max_targets]
    observations: list[dict[str, Any]] = []
    errors: list[str] = []
    for target in targets:
        target_id = str(target.get("sourceId") or "")
        url = f"{HYDROWEB_API}/lakes/{target_id}/levels?{urlencode({'limit': 500})}"
        try:
            payload = http_get(url, api_key)
            observations.extend(parse_series(target_id, str(target.get("name") or ""), target.get("lon"), target.get("lat"), payload, str(target.get("catalogUrl") or url)))
        except (PermissionError, TimeoutError, ConnectionError, ValueError) as exc:
            errors.append(f"{target_id}: {exc}")
        time.sleep(0.5)
    latest = max((str(o.get("observedAt") or "") for o in observations), default=None) or None
    status = "ok" if observations else ("error" if errors else "empty")
    write_provider_file("hydroweb_levels", {"generatedAt": fetched_at, "status": status,
                                            "errorCode": None if observations else ("endpoint_error" if errors else "empty_result"),
                                            "observations": observations, "errors": errors})
    summarize("Hydroweb", fetched=len(targets), matched=len({o.get("providerTargetId") for o in observations}),
              usable=len(observations), rejected=0, latest_observation=latest,
              duration_s=time.monotonic() - started, status=status)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

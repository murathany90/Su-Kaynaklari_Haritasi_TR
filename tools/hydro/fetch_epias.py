"""EPİAŞ active-fullness fetch.

* Credentials only from env (never logged, never committed).
* POST {base}/v1/dams/data/active-fullness with damName/basinName/page.
* Explicit error taxonomy; exit 2 when credentials exist but the fetch
  errors (must fail visibly in CI), exit 0 on ok / skipped / empty.
* Dam query list comes from the canonical inventory so every run covers
  the same dam/basin pairs (idempotent input).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import LIVE_DIR, write_json_atomic
from epias_client import fetch_active_fullness
from providers import read_provider_file, summarize, utc_now, write_provider_file


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def dam_queries(hes_path: Path, limit: int | None = None) -> list[dict[str, str]]:
    try:
        payload = json.loads(hes_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    queries: list[dict[str, str]] = []
    seen: set[str] = set()
    for feature in payload.get("features", []):
        props = feature.get("properties") or {}
        dam = str(props.get("damName") or props.get("name") or "").strip()
        basin = str(props.get("officialBasinName") or props.get("basinName") or "").strip()
        key = f"{dam}\u0001{basin}".casefold()
        if dam and key not in seen:
            seen.add(key)
            queries.append({"damName": dam, "basinName": basin})
        if limit and len(queries) >= limit:
            break
    return queries


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(LIVE_DIR / "epias_dams_latest.json"))
    parser.add_argument("--history-output", default=str(LIVE_DIR / "epias_dams_history.json"))
    parser.add_argument("--hes", default="public/data/hes177/hes_177.geojson")
    parser.add_argument("--max-dams", type=int, default=0, help="0 = all inventory dams")
    args = parser.parse_args()

    started = time.monotonic()
    generated_at = utc_now()
    output_path = Path(args.output)
    lkg_path = output_path.with_name("epias_dams_last_known_good.json")
    previous_lkg = read_json(lkg_path)

    queries = dam_queries(Path(args.hes), limit=args.max_dams or None)
    result = fetch_active_fullness(queries)
    observations = result.get("observations", [])
    # Legacy runtime shape: the audit resolver reads `records` with percent /
    # volume / date field variants — reuse the raw rows for compatibility.
    records = [{"damName": obs.get("damName"), "basinName": obs.get("basinName"),
                "activeFullness": obs.get("fullnessPercent"), "observedAt": obs.get("observedAt"),
                "activeVolume": (obs.get("raw") or {}).get("activeVolumeHm3"),
                "minVolumeHm3": (obs.get("raw") or {}).get("minVolumeHm3"),
                "maxVolumeHm3": (obs.get("raw") or {}).get("maxVolumeHm3"),
                "providerTargetId": obs.get("providerTargetId")} for obs in observations]
    status = result["status"]
    error_code = result.get("errorCode")
    latest_observation = max((str(o.get("observedAt") or "") for o in observations), default=None) or None

    payload: dict[str, Any] = {
        "generatedAt": generated_at, "source": "EPİAŞ Şeffaflık Platformu",
        "status": {"ok": "ok", "partial": "partial", "empty": "empty", "skipped": "requires_access", "error": "failed"}[status],
        "errorCode": error_code, "endpoint": result.get("endpoint"),
        "damQueries": len(queries), "records": records, "errors": result.get("errors", []),
        "lastSuccessfulFetch": previous_lkg.get("fetchedAt"),
        "lastSuccessfulObservation": previous_lkg.get("latestObservationAt"),
        "lastKnownGoodPath": str(lkg_path),
    }
    if status in ("ok", "partial") and records:
        payload.update({"lastSuccessfulFetch": generated_at, "lastSuccessfulObservation": latest_observation})
        write_json_atomic(lkg_path, {"generatedAt": generated_at, "fetchedAt": generated_at,
                                     "latestObservationAt": latest_observation, "source": payload["source"],
                                     "status": "ok", "records": records})
    write_json_atomic(output_path, payload)
    write_json_atomic(Path(args.history_output), {
        "generatedAt": generated_at, "source": payload["source"], "status": payload["status"],
        "errorCode": error_code, "records": records, "historyDate": str(date.today()),
        "latestAttempt": generated_at, "lastSuccessfulFetch": payload.get("lastSuccessfulFetch")})
    # Canonical provider observation file for the audit resolver.
    write_provider_file("epias_active_fullness", {
        "generatedAt": generated_at, "status": payload["status"], "errorCode": error_code,
        "endpoint": result.get("endpoint"), "observations": observations})

    summarize("EPİAŞ", fetched=len(records), matched=0, usable=sum(1 for r in records if r.get("activeFullness") is not None),
              rejected=0, latest_observation=latest_observation,
              duration_s=time.monotonic() - started, status=payload["status"], error_code=error_code)
    print(json.dumps({"status": payload["status"], "errorCode": error_code,
                      "records": len(records), "damQueries": len(queries)}, ensure_ascii=False, indent=2))
    # Visible failure only when credentials ARE configured but the fetch errored.
    if status == "error":
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

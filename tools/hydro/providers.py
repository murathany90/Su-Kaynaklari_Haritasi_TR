"""Shared building blocks for fullness provider adapters.

Every adapter speaks the same language:

* status envelope: ``ok`` | ``skipped`` (no credentials/disabled) |
  ``empty`` | ``error`` with an explicit machine-readable ``errorCode``
* canonical observation dicts (see :func:`canonical_observation`)
* observability: one summary line per provider, e.g.
  ``[Hydroweb] fetched=19 matched=3 usable=2 rejected=1``
* dedupe keys: ``hesId + provider + observationTimestamp + sourceClass``
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
OBS_DIR = ROOT / "public/data/live" / "providers"
MAPPING_DIR = ROOT / "public/data/static" / "mappings"

ERROR_CODES = {
    "credentials_missing",
    "auth_failed",
    "access_denied",
    "rate_limited",
    "endpoint_error",
    "schema_error",
    "empty_result",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def dedupe_key(hes_id: Any, provider: Any, observation_ts: Any, source_class: Any) -> str:
    """Stable idempotency key: hesId + provider + observationTimestamp + sourceClass."""
    parts = [str(hes_id or ""), str(provider or ""), str(observation_ts or ""), str(source_class or "")]
    return "|".join(part.strip() for part in parts)


def canonical_observation(
    *,
    provider: str,
    provider_target_id: str | None,
    observed_at: str | None,
    source_class: str,
    fullness_percent: float | None = None,
    water_level_m: float | None = None,
    surface_area_km2: float | None = None,
    volume_hm3: float | None = None,
    quality: str | None = None,
    uncertainty: float | None = None,
    dam_name: str | None = None,
    basin_name: str | None = None,
    lon: float | None = None,
    lat: float | None = None,
    source_url: str | None = None,
    product: str | None = None,
    raw: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One provider observation. Never invent a percentage: level/area-only
    observations keep ``fullnessPercent=None`` and downstream stages may only
    derive % when a validated hypsometry exists."""
    return {
        "provider": provider,
        "providerTargetId": provider_target_id,
        "observedAt": observed_at,
        "sourceClass": source_class,
        "fullnessPercent": fullness_percent,
        "waterLevelM": water_level_m,
        "surfaceAreaKm2": surface_area_km2,
        "volumeHm3": volume_hm3,
        "quality": quality,
        "uncertainty": uncertainty,
        "damName": dam_name,
        "basinName": basin_name,
        "lon": lon,
        "lat": lat,
        "sourceUrl": source_url,
        "product": product,
        "raw": raw or {},
    }


def summarize(provider: str, *, fetched: int = 0, matched: int = 0, usable: int = 0,
              rejected: int = 0, latest_observation: str | None = None,
              duration_s: float = 0.0, status: str = "ok", error_code: str | None = None) -> dict[str, Any]:
    summary = {
        "provider": provider,
        "status": status,
        "errorCode": error_code,
        "fetched": fetched,
        "matched": matched,
        "usable": usable,
        "rejected": rejected,
        "latestObservation": latest_observation,
        "durationS": round(duration_s, 2),
    }
    print(f"[{provider}] fetched={fetched} matched={matched} usable={usable} "
          f"rejected={rejected} latest={latest_observation or '—'} status={status}"
          + (f" error={error_code}" if error_code else ""))
    return summary


def write_provider_file(name: str, payload: dict[str, Any]) -> Path:
    OBS_DIR.mkdir(parents=True, exist_ok=True)
    path = OBS_DIR / f"{name}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def read_provider_file(name: str) -> dict[str, Any]:
    path = OBS_DIR / f"{name}.json"
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def sleep_between_requests(seconds: float) -> None:
    if seconds > 0:
        time.sleep(seconds)


def classify_http_error(status: int | None) -> str:
    if status in (401, 403):
        return "access_denied"
    if status == 429:
        return "rate_limited"
    if status is not None and 500 <= status <= 599:
        return "endpoint_error"
    return "endpoint_error"

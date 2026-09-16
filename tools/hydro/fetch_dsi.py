"""DSİ Yağış ve Baraj Doluluk adapter (public, no credentials).

Verified public surface (Angular bundle ``main-*.js`` on
https://yagisbarajdoluluk.dsi.gov.tr, probed 2026-09-16):

* ``GET {base}/api/Dashboard/latest-published-date``
  -> ``{"publishedDataDate": "YYYY-MM-DD"}`` (daily publication)
* ``GET {base}/api/DamMetrics/national/purpose-daily?from=&to=``
  -> per-purpose national averages (Energy/Irrigation/DrinkingWater)
* ``GET {base}/api/DamMetrics/province/daily?from=&to=``
  -> per-province aggregates (NOT per-dam; never used as HES %)

There is deliberately NO per-dam public endpoint in the bundle
(per-dam routes live under auth-only ``/api/admin/dam-metrics``), and the
page HTML is an empty SPA shell, so no HTML scraping is possible either.
Per-dam rows are therefore published ONLY when ``DSI_DAM_ENDPOINT`` points
at a real per-dam JSON feed (schema-tolerant parse); otherwise ``records``
stays empty with ``perDamAvailable=false`` — never invented percentages.

Output: ``public/data/live/dsi_dams_latest.json`` (+ canonical provider
file ``providers/dsi_levels.json``) with ``sourceClass=official_published``,
``provider=DSİ``, ``isEstimated=false``.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import LIVE_DIR, write_json_atomic
from providers import canonical_observation, summarize, utc_now, write_provider_file

DEFAULT_BASE_URL = "https://yagisbarajdolulukapi.dsi.gov.tr"
SOURCE_URL = "https://yagisbarajdoluluk.dsi.gov.tr"
TIMEOUT = 40
WINDOW_DAYS = 8

PERCENT_KEYS = ("activeFullnessPercent", "dolulukOraniYuzde", "occupancyRatePercent", "occupancyPercent",
                "fullnessPercent", "doluluk", "occupancy")
VOLUME_KEYS = ("activeVolume", "activeVolumeMillionM3", "activeVolumeHm3", "AktifHacimMilyarM3", "hacim")
DATE_KEYS = ("observationDate", "observedAt", "date", "tarih")
DAM_KEYS = ("damName", "barajAdi", "baraj", "name")


def http_get(url: str) -> Any:
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "Su-Kaynaklari-Haritasi/1.0"})
    try:
        with urlopen(request, timeout=TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        if exc.code in (401, 403):
            raise PermissionError(f"DSİ access denied (HTTP {exc.code})") from exc
        if exc.code == 429:
            raise TimeoutError("DSİ rate limited (HTTP 429)") from exc
        raise ConnectionError(f"DSİ endpoint error (HTTP {exc.code}): {url}") from exc
    except (URLError, TimeoutError, OSError, ValueError) as exc:
        raise ConnectionError(f"DSİ request failed: {exc} ({url})") from exc


def to_number(value: Any) -> float | None:
    try:
        parsed = float(value)
        return parsed if parsed == parsed and abs(parsed) != float("inf") else None
    except (TypeError, ValueError):
        return None


def first_present(row: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            return value
    return None


def normalize_dam_row(row: dict[str, Any], source_url: str) -> dict[str, Any] | None:
    """A per-dam row -> canonical observation, or None (unusable, counted)."""
    if not isinstance(row, dict):
        return None
    percent = to_number(first_present(row, PERCENT_KEYS))
    observed = first_present(row, DATE_KEYS)
    dam = first_present(row, DAM_KEYS)
    if percent is None or not observed or not dam:
        return None
    # Unit semantics: "MillionM3" == hm³ numerically; "MilyarM3" (billion m³) ×1000.
    volume_hm3: float | None = None
    for key in VOLUME_KEYS:
        raw_volume = to_number(row.get(key))
        if raw_volume is None:
            continue
        volume_hm3 = raw_volume * 1000 if "milyar" in key.lower() else raw_volume
        break
    return canonical_observation(
        provider="dsi", provider_target_id=str(first_present(row, ("damId", "id")) or ""),
        observed_at=str(observed), source_class="official_published", fullness_percent=percent,
        volume_hm3=volume_hm3,
        dam_name=str(dam), source_url=source_url, product="dsi-dam-daily",
        estimated=False, raw={"activeVolumeRaw": volume_hm3})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(LIVE_DIR / "dsi_dams_latest.json"))
    parser.add_argument("--window-days", type=int, default=WINDOW_DAYS)
    args = parser.parse_args()
    started = time.monotonic()
    fetched_at = utc_now()
    base = (os.getenv("DSI_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    today = date.today()
    start = (today - timedelta(days=args.window_days - 1)).isoformat()
    end = today.isoformat()
    errors: list[str] = []
    published_date: str | None = None
    purpose_daily: list[dict[str, Any]] = []
    province_daily: list[dict[str, Any]] = []
    per_dam_rows: list[dict[str, Any]] = []
    try:
        published = http_get(f"{base}/api/Dashboard/latest-published-date")
        published_date = str(published.get("publishedDataDate") or "") or None
    except (PermissionError, TimeoutError, ConnectionError) as exc:
        errors.append(str(exc))
    if published_date is None:
        payload = {"generatedAt": fetched_at, "source": "DSİ Yağış ve Baraj Doluluk", "status": "failed",
                   "errorCode": "endpoint_error", "sourceUrl": SOURCE_URL, "baseUrl": base, "records": [],
                   "perDamAvailable": False, "errors": errors or ["latest-published-date unreachable"]}
        write_json_atomic(Path(args.output), payload)
        write_provider_file("dsi_levels", {"generatedAt": fetched_at, "status": "error",
                                           "errorCode": "endpoint_error", "observations": [], "errors": errors})
        summarize("DSİ", status="error", error_code="endpoint_error", duration_s=time.monotonic() - started)
        print(json.dumps({"status": "failed", "records": 0}, ensure_ascii=False))
        return 0
    try:
        purpose_daily = http_get(f"{base}/api/DamMetrics/national/purpose-daily?{urlencode({'from': start, 'to': end})}") or []
    except (PermissionError, TimeoutError, ConnectionError) as exc:
        errors.append(str(exc))
    try:
        province_daily = http_get(f"{base}/api/DamMetrics/province/daily?{urlencode({'from': start, 'to': end})}") or []
    except (PermissionError, TimeoutError, ConnectionError) as exc:
        errors.append(str(exc))
    dam_endpoint = os.getenv("DSI_DAM_ENDPOINT")
    per_dam_available = False
    if dam_endpoint:
        try:
            raw = http_get(dam_endpoint)
            rows = raw if isinstance(raw, list) else raw.get("items") or raw.get("data") or []
            for row in rows if isinstance(rows, list) else []:
                normalized = normalize_dam_row(row, dam_endpoint)
                if normalized is not None:
                    per_dam_rows.append(normalized)
            per_dam_available = True
        except (PermissionError, TimeoutError, ConnectionError) as exc:
            errors.append(f"per-dam endpoint: {exc}")
    observations = per_dam_rows
    # Without a per-dam endpoint this file is metadata/health only: the
    # aggregates above must never be distributed as HES fullness.
    if not per_dam_available:
        write_provider_file("dsi_levels", {"generatedAt": fetched_at, "status": "skipped",
                                           "errorCode": "public_per_dam_endpoint_unavailable",
                                           "publishedDataDate": published_date,
                                           "note": "aggregates in dsi_dams_latest.json are metadata only",
                                           "observations": [], "errors": errors})
    else:
        write_provider_file("dsi_levels", {"generatedAt": fetched_at,
                                           "status": "ok" if observations else "empty",
                                           "errorCode": None if observations else "empty_result",
                                           "publishedDataDate": published_date,
                                           "observations": observations, "errors": errors})
    latest = max((str(o.get("observedAt") or "") for o in observations), default=None) or None
    if not isinstance(purpose_daily, list):
        purpose_daily = []
    if not isinstance(province_daily, list):
        province_daily = []
    energy_today = next((to_number(r.get("averageOccupancyRatePercent")) for r in purpose_daily
                         if isinstance(r, dict) and r.get("damPurpose") == "Energy" and str(r.get("observationDate")) == published_date), None)
    payload = {"generatedAt": fetched_at, "source": "DSİ Yağış ve Baraj Doluluk", "status": "ok",
               "errorCode": None, "sourceUrl": SOURCE_URL, "baseUrl": base,
               "publishedDataDate": published_date, "windowDays": args.window_days,
               "purposeDaily": purpose_daily, "provinceDaily": province_daily,
               "energyPurposeAveragePercent": energy_today, "records": observations,
               "perDamAvailable": per_dam_available,
               "perDamNote": None if per_dam_available else "no per-dam public endpoint; admin API is auth-only",
               "errors": errors}
    write_json_atomic(Path(args.output), payload)
    write_provider_file("dsi_levels", {"generatedAt": fetched_at,
                                       "status": "ok" if observations else "empty",
                                       "errorCode": None if observations else "empty_result",
                                       "publishedDataDate": published_date,
                                       "observations": observations, "errors": errors})
    summarize("DSİ", fetched=len(observations), matched=0,
              usable=sum(1 for o in observations if o.get("fullnessPercent") is not None),
              rejected=0, latest_observation=latest, duration_s=time.monotonic() - started, status="ok")
    print(json.dumps({"status": "ok", "publishedDataDate": published_date, "records": len(observations),
                      "perDamAvailable": per_dam_available, "energyAvg": energy_today}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

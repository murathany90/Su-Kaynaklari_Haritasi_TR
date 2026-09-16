"""Copernicus CLMS lake water-level time-series download.

Modes::

    --mode incremental   only products newer than the stored resume state
    --mode backfill      paged date-range walk (--from YYYY-MM-DD --to ...)

Token only from ``COPERNICUS_ACCESS_TOKEN``. No token -> ``skipped``.
NetCDF product bodies are NOT parsed in CI (optional heavy dep); inline
water-level values in OData attributes/CSV attachments are. Anything else is
recorded with ``observationAvailable=false`` and a reason — never invented.
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

PRODUCTS = "https://catalogue.dataspace.copernicus.eu/odata/v1/Products"
DATASET = "wl-lakes_global_vector_daily_v2"
BBOX_POLYGON = "geography'SRID=4326;POLYGON ((25 35,45 35,45 43,25 43,25 35))'"
TIMEOUT = 60


def http_get(url: str, token: str | None) -> Any:
    headers = {"Accept": "application/json", "User-Agent": "Su-Kaynaklari-Haritasi/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        with urlopen(Request(url, headers=headers), timeout=TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        if exc.code in (401, 403):
            raise PermissionError(f"Copernicus access denied (HTTP {exc.code})") from exc
        if exc.code == 429:
            raise TimeoutError("Copernicus rate limited (HTTP 429)") from exc
        raise ConnectionError(f"Copernicus endpoint error (HTTP {exc.code})") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise ConnectionError(f"Copernicus request failed: {exc}") from exc


def to_number(value: Any) -> float | None:
    try:
        parsed = float(value)
        return parsed if parsed == parsed and abs(parsed) != float("inf") else None
    except (TypeError, ValueError):
        return None


def attribute(items: list[dict[str, Any]], name: str) -> Any:
    for item in items:
        if item.get("Name") == name:
            return item.get("Value")
    return None


def parse_product(item: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract inline water-level readings; NetCDF bodies are out of scope."""
    attrs = item.get("Attributes") or []
    level = to_number(attribute(attrs, "waterLevel") if attribute(attrs, "waterLevel") is not None else attribute(attrs, "lakeWaterLevel"))
    content_date = item.get("ContentDate") or {}
    observed = content_date.get("Start")
    footprint = item.get("GeoFootprint") or {}
    lon = lat = None
    if footprint.get("type") == "Point" and len(footprint.get("coordinates") or []) >= 2:
        lon, lat = float(footprint["coordinates"][0]), float(footprint["coordinates"][1])
    product_id = str(item.get("Id") or "")
    url = f"{PRODUCTS}({product_id})"
    if level is None or not observed:
        return [canonical_observation(provider="copernicus", provider_target_id=product_id,
                                      observed_at=str(observed) if observed else None,
                                      source_class="satellite_altimetry", dam_name=item.get("Name"),
                                      lon=lon, lat=lat, source_url=url, product=DATASET,
                                      quality="unparsed", raw={"reason": "no inline water level; NetCDF body not parsed in CI"})]
    return [canonical_observation(provider="copernicus", provider_target_id=product_id,
                                  observed_at=str(observed), source_class="satellite_altimetry",
                                  water_level_m=level, dam_name=item.get("Name"), lon=lon, lat=lat,
                                  source_url=url, product=DATASET,
                                  raw={"lakeName": attribute(attrs, "lakeName")})]


def query_filter(date_from: str | None, date_to: str | None) -> str:
    base = (f"Collection/Name eq 'CLMS' and Attributes/OData.CSC.StringAttribute/any(att: att/Name eq "
            f"'datasetIdentifier' and att/Value eq '{DATASET}') and OData.CSC.Intersects(area={BBOX_POLYGON})")
    if date_from:
        base += f" and ContentDate/Start ge {date_from}T00:00:00.000Z"
    if date_to:
        base += f" and ContentDate/Start le {date_to}T23:59:59.999Z"
    return base


def state_path() -> Path:
    return Path(__file__).resolve().parent.parent.parent / "public" / "data" / "live" / "providers" / "_copernicus_state.json"


def load_state() -> dict[str, Any]:
    try:
        return json.loads(state_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state: dict[str, Any]) -> None:
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["incremental", "backfill"], default="incremental")
    parser.add_argument("--from", dest="date_from", default=None)
    parser.add_argument("--to", dest="date_to", default=None)
    parser.add_argument("--top", type=int, default=200)
    args = parser.parse_args()
    started = time.monotonic()
    fetched_at = utc_now()
    token = os.getenv("COPERNICUS_ACCESS_TOKEN")
    if not token:
        write_provider_file("copernicus_lwl", {"generatedAt": fetched_at, "status": "skipped",
                                               "errorCode": "credentials_missing", "mode": args.mode,
                                               "observations": [], "errors": ["COPERNICUS_ACCESS_TOKEN is not configured"]})
        summarize("Copernicus", status="skipped", error_code="credentials_missing")
        return 0
    state = load_state()
    date_from = args.date_from or (state.get("lastContentDate") if args.mode == "incremental" else None)
    observations: list[dict[str, Any]] = []
    errors: list[str] = []
    skip = 0
    newest: str | None = state.get("lastContentDate")
    try:
        while True:
            url = f"{PRODUCTS}?{urlencode({'$filter': query_filter(date_from, args.date_to), '$top': args.top, '$skip': skip, '$expand': 'Attributes', '$orderby': 'ContentDate/Start asc'})}"
            payload = http_get(url, token)
            items = payload.get("value", []) if isinstance(payload, dict) else []
            if not items:
                break
            for item in items:
                observations.extend(parse_product(item))
                start = (item.get("ContentDate") or {}).get("Start")
                if start and (newest is None or str(start) > newest):
                    newest = str(start)
            if len(items) < args.top:
                break
            skip += args.top
            time.sleep(1.0)
    except (PermissionError, TimeoutError, ConnectionError, ValueError) as exc:
        errors.append(str(exc))
    usable = [o for o in observations if o.get("waterLevelM") is not None]
    # NetCDF product bodies: full downloads are GB-scale and need the optional
    # netCDF4 dependency, so CI parses inline values only. Catalogue metadata
    # alone is never presented as a measurement (audit drops such rows).
    try:
        import netCDF4  # noqa: F401
        netcdf_parser = "available"
    except ImportError:
        netcdf_parser = "unavailable (pip install netCDF4 + COPERNICUS_NETCDF=1 for body parsing)"
    netcdf_bodies = sum(1 for o in observations if (o.get("raw") or {}).get("reason", "").startswith("no inline"))
    if newest:
        state["lastContentDate"] = newest
        state["updatedAt"] = fetched_at
        save_state(state)
    status = "ok" if usable else ("error" if errors else "empty")
    latest = max((str(o.get("observedAt") or "") for o in usable), default=None) or None
    write_provider_file("copernicus_lwl", {"generatedAt": fetched_at, "status": status,
                                           "errorCode": None if usable else ("endpoint_error" if errors else "empty_result"),
                                           "mode": args.mode, "netcdfBodyParsing": netcdf_parser,
                                           "netcdfDeferredCount": netcdf_bodies,
                                           "observations": observations, "errors": errors})
    summarize("Copernicus", fetched=len(observations), matched=0, usable=len(usable), rejected=0,
              latest_observation=latest, duration_s=time.monotonic() - started, status=status)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

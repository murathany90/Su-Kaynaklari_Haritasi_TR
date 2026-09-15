"""Fetch small, public observation catalogs used for fullness-source audit.

This job stores discovery metadata only. It never writes credentials and it
never turns a catalog match into a fullness percentage without an observation
and the method needed to validate that observation.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public/data/static/mappings/observation_catalogs.json"
TIMEOUT_SECONDS = 25
TURKEY_BBOX = "25,35,45,43"
HYDROWEB_ROOT = "https://hydroweb.next.theia-land.fr/api/catalog/stac"
COPERNICUS_PRODUCTS = "https://catalogue.dataspace.copernicus.eu/odata/v1/Products"


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def get_json(url: str, headers: dict[str, str] | None = None) -> tuple[dict[str, Any], dict[str, str]]:
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "Su-Kaynaklari-Haritasi/1.0", **(headers or {})})
    with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8")), {key.lower(): value for key, value in response.headers.items()}


def checksum(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def point_from_geometry(geometry: dict[str, Any] | None) -> tuple[float, float] | None:
    geometry = geometry or {}
    if geometry.get("type") == "Point" and len(geometry.get("coordinates") or []) >= 2:
        return float(geometry["coordinates"][0]), float(geometry["coordinates"][1])
    return None


def link(item: dict[str, Any], fallback: str) -> str:
    for candidate in item.get("links", []):
        if candidate.get("rel") in {"self", "item", "alternate"} and str(candidate.get("href", "")).startswith("http"):
            return str(candidate["href"])
    return fallback


def hydroweb_records(collection: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    url = f"{HYDROWEB_ROOT}/collections/{collection}/items?{urlencode({'bbox': TURKEY_BBOX, 'limit': 100})}"
    payload, headers = get_json(url)
    records: list[dict[str, Any]] = []
    for item in payload.get("features", []):
        point = point_from_geometry(item.get("geometry"))
        if not point:
            continue
        props = item.get("properties") or {}
        assets = item.get("assets") or {}
        records.append({
            "source": "hydroweb",
            "sourceId": str(item.get("id") or ""),
            "catalogCollection": collection,
            "name": props.get("lake_name") or props.get("name") or item.get("id"),
            "lon": point[0],
            "lat": point[1],
            "observedAt": props.get("datetime") or props.get("end_datetime"),
            "variables": sorted(str(key) for key in assets),
            "catalogUrl": link(item, url),
            "dataAccess": "requires_api_key",
            "observationAvailable": False,
        })
    return records, {"status": "catalog_available", "sourceUrl": url, "collection": collection, "recordCount": len(records), "dataAccess": "requires_api_key", "etag": headers.get("etag")}


def copernicus_records() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    polygon = "geography'SRID=4326;POLYGON ((25 35,45 35,45 43,25 43,25 35))'"
    query = {
        "$filter": "Collection/Name eq 'CLMS' and Attributes/OData.CSC.StringAttribute/any(att: att/Name eq 'datasetIdentifier' and att/Value eq 'wl-lakes_global_vector_daily_v2') and OData.CSC.Intersects(area=" + polygon + ")",
        "$top": "1000",
        "$expand": "Attributes",
    }
    url = f"{COPERNICUS_PRODUCTS}?{urlencode(query)}"
    payload, headers = get_json(url)
    records: list[dict[str, Any]] = []
    for item in payload.get("value", []):
        footprint = item.get("GeoFootprint") or {}
        point = point_from_geometry(footprint)
        if not point:
            # Product footprints are usually polygons. Their catalog match is
            # still retained without inventing a point or a measurement.
            coords = footprint.get("coordinates") if isinstance(footprint, dict) else None
            if footprint.get("type") == "Polygon" and coords and coords[0]:
                points = [point for point in coords[0] if len(point) >= 2]
                if points:
                    point = (sum(float(p[0]) for p in points) / len(points), sum(float(p[1]) for p in points) / len(points))
        if not point:
            continue
        records.append({
            "source": "copernicus",
            "sourceId": str(item.get("Id") or ""),
            "catalogCollection": "CLMS/wl-lakes_global_vector_daily_v2",
            "name": item.get("Name") or item.get("ContentDate", {}).get("Start"),
            "lon": point[0],
            "lat": point[1],
            "observedAt": (item.get("ContentDate") or {}).get("Start"),
            "variables": ["lake_water_level"],
            "catalogUrl": f"{COPERNICUS_PRODUCTS}({item.get('Id')})",
            "dataAccess": "requires_access_token",
            "observationAvailable": False,
        })
    return records, {"status": "catalog_available", "sourceUrl": url, "dataset": "wl-lakes_global_vector_daily_v2", "recordCount": len(records), "dataAccess": "requires_access_token", "etag": headers.get("etag")}


def previous_payload() -> dict[str, Any]:
    if not OUT.exists():
        return {}
    try:
        return json.loads(OUT.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def main() -> None:
    fetched_at = now()
    previous = previous_payload()
    previous_records = previous.get("records", [])
    registry: dict[str, dict[str, Any]] = {
        "dsi": {"status": "requires_access", "dataAccess": "official_endpoint_or_export_required", "sourceUrl": "https://www.dsi.gov.tr/"},
        "dahiti": {"status": "requires_access", "dataAccess": "api_key_required", "credentialsConfigured": bool(os.getenv("DAHITI_API_KEY")), "sourceUrl": "https://dahiti.dgfi.tum.de/en/api/doc/v2/"},
        "swot": {"status": "requires_access", "dataAccess": "Earthdata_credentials_required", "credentialsConfigured": bool(os.getenv("EARTHDATA_TOKEN")), "sourceUrl": "https://www.earthdata.nasa.gov/"},
        "g_realm": {"status": "not_queried", "dataAccess": "provider_catalog_required", "sourceUrl": "https://www.g-realm.com/"},
        "sentinel": {"status": "not_queried", "dataAccess": "provider_catalog_required", "sourceUrl": "https://dataspace.copernicus.eu/"},
    }
    records: list[dict[str, Any]] = []
    source_jobs = [("hydroweb", lambda: hydroweb_records("HYDROWEB_LAKES_OPE")), ("copernicus", copernicus_records)]
    for source, job in source_jobs:
        try:
            source_records, meta = job()
            records.extend(source_records)
            registry[source] = {**meta, "credentialsConfigured": bool(os.getenv("HYDROWEB_API_KEY" if source == "hydroweb" else "COPERNICUS_ACCESS_TOKEN")), "downloadedAt": fetched_at, "version": meta.get("collection") or meta.get("dataset") or "catalog", "checksum": checksum(source_records)}
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, KeyError, json.JSONDecodeError) as error:
            cached = [record for record in previous_records if record.get("source") == source]
            records.extend(cached)
            registry[source] = {"status": "stale_cache" if cached else "unavailable", "dataAccess": "catalog_request_failed", "error": str(error), "recordCount": len(cached), "cachedAt": previous.get("generatedAt")}
    registry["epias"] = {"status": "separate_runtime_fetch", "sourceUrl": "https://seffaflik.epias.com.tr/", "dataAccess": "credentials_or_public_export_required"}
    payload = {
        "generatedAt": fetched_at,
        "sourceRegistry": registry,
        "cacheMetadata": {source: {"source": source, "downloadedAt": fetched_at, "version": meta.get("version"), "etag": meta.get("etag"), "checksum": meta.get("checksum")} for source, meta in registry.items() if meta.get("status") in {"catalog_available", "stale_cache"}},
        "records": records,
        "recordCount": len(records),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"generatedAt": fetched_at, "recordCount": len(records), "sources": registry}, ensure_ascii=False))


if __name__ == "__main__":
    main()

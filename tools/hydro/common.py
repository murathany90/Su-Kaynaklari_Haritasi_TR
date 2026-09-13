"""Shared helpers for the hydrology data jobs.

The jobs deliberately keep the raw ArcGIS attributes alongside a small set of
canonical properties. This makes the frontend stable while preserving the
source data for auditing and later field mapping work.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import requests

ROOT = Path(__file__).resolve().parents[2]
STATIC_DIR = ROOT / "public" / "data" / "static"
LIVE_DIR = ROOT / "public" / "data" / "live"
MANIFEST_DIR = ROOT / "public" / "data" / "manifest"
CONFIG_DIR = ROOT / "public" / "data" / "config"

TATUS_BASE_URL = os.getenv(
    "TATUS_BASE_URL",
    "https://cbs1.tarimorman.gov.tr/server/rest/services/TATUS/FeatureServer",
).rstrip("/")

TATUS_LAYERS = {
    "flowStations": {"id": 3, "name": "Akım Gözlem İstasyonları", "geometry": "Point", "file": "flow_stations.geojson"},
    "hesStations": {"id": 4, "name": "Hes Gözlem İstasyonları", "geometry": "Point", "file": "hes_stations.geojson"},
    "lakeStations": {"id": 6, "name": "Göl Gözlem İstasyonları", "geometry": "Point", "file": "lake_stations.geojson"},
    "damStations": {"id": 7, "name": "Baraj Gözlem İstasyonları", "geometry": "Point", "file": "dam_stations.geojson"},
    "rivers": {"id": 8, "name": "Nehir", "geometry": "LineString", "file": "rivers.geojson", "overviewFile": "rivers_overview.geojson"},
    "basins": {"id": 11, "name": "Havza Sınırları", "geometry": "Polygon", "file": "basins.geojson"},
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_text(value: Any) -> str:
    text = "" if value is None else str(value)
    replacements = str.maketrans("ÇĞİÖŞÜçğıöşü", "CGIOSUcgiosu")
    return re.sub(r"[^a-z0-9]+", " ", text.lower().translate(replacements)).strip()


def first_value(properties: dict[str, Any], *names: str) -> Any:
    for name in names:
        value = properties.get(name)
        if value not in (None, ""):
            return value
    return None


def as_number(value: Any) -> float | None:
    try:
        return None if value in (None, "") else float(value)
    except (TypeError, ValueError):
        return None


def fetch_json(session: requests.Session, url: str, params: dict[str, Any] | None = None, **kwargs: Any) -> Any:
    response = session.get(url, params=params, timeout=kwargs.pop("timeout", 90))
    response.raise_for_status()
    payload = response.json()
    if isinstance(payload, dict) and payload.get("error"):
        raise RuntimeError(f"Remote API error: {payload['error']}")
    return payload


def query_tatus_layer(session: requests.Session, layer_id: int, page_size: int = 1000, base_url: str = TATUS_BASE_URL) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    base_url = base_url.rstrip("/")
    metadata = fetch_json(session, f"{base_url}/{layer_id}", {"f": "pjson"})
    max_record_count = int(metadata.get("maxRecordCount") or page_size)
    page_size = min(page_size, max_record_count)
    fields = "*"
    if layer_id == 8:
        fields = "OBJECTID,adi,nehir_kod,hidrolojik_kategori,strahler,olcek_sinifi,uzunluk,HAVZA_ID,Havza_Id_Text"

    def get_page(offset: int) -> list[dict[str, Any]]:
        payload = fetch_json(
            requests.Session(),
            f"{base_url}/{layer_id}/query",
            {
                "where": "1=1",
                "outFields": fields,
                "returnGeometry": "true",
                "outSR": "4326",
                "f": "geojson",
                "resultOffset": offset,
                "resultRecordCount": page_size,
                "maxAllowableOffset": "0.01" if layer_id == 8 else None,
            },
        )
        batch = payload.get("features", [])
        if not isinstance(batch, list):
            raise RuntimeError(f"TATUS layer {layer_id} returned an invalid feature array")
        return batch

    # ArcGIS exposes a very large river network. Get a stable count first and
    # download its pages concurrently; all other layers use a small sequential
    # loop to avoid unnecessary pressure on the service.
    if layer_id == 8:
        count_payload = fetch_json(session, f"{base_url}/{layer_id}/query", {"where": "1=1", "returnCountOnly": "true", "f": "pjson"})
        total = int(count_payload.get("count", 0))
        offsets = list(range(0, total, page_size))
        pages: dict[int, list[dict[str, Any]]] = {}
        with ThreadPoolExecutor(max_workers=12) as executor:
            futures = {executor.submit(get_page, offset): offset for offset in offsets}
            for future in as_completed(futures):
                pages[futures[future]] = future.result()
        features = [feature for offset in offsets for feature in pages[offset]]
    else:
        features = []
        offset = 0
        while True:
            batch = get_page(offset)
            features.extend(batch)
            if len(batch) < page_size:
                break
            offset += len(batch)
    return metadata, features


def canonicalize(layer_key: str, feature: dict[str, Any], index: int) -> dict[str, Any]:
    props = dict(feature.get("properties") or {})
    geometry = feature.get("geometry")
    object_id = first_value(props, "OBJECTID", "OBJECTID_1", "ID")
    entity_id = str(object_id if object_id is not None else f"tatus-{TATUS_LAYERS[layer_key]['id']}-{index + 1}")
    props["entityId"] = entity_id
    props["entityType"] = layer_key

    if layer_key == "flowStations":
        props.update({"id": entity_id, "name": first_value(props, "ISTADI", "AGINO"), "stationId": first_value(props, "AGINO", "OBJECTID"), "basinId": first_value(props, "HAVZA_ID"), "flow": None, "status": "no_data", "color": "#94a3b8", "width": 2.8})
    elif layer_key in {"hesStations", "lakeStations"}:
        props.update({"id": entity_id, "name": first_value(props, "IstAdi", "SuAdi", "IstNo"), "stationId": first_value(props, "IstNo", "OBJECTID"), "basinId": first_value(props, "HAVZA_ID"), "status": "no_data", "color": "#94a3b8", "radius": 7})
    elif layer_key == "damStations":
        props.update({"id": entity_id, "name": first_value(props, "BarajAdi", "OBJECTID"), "damName": first_value(props, "BarajAdi"), "basinId": first_value(props, "HAVZA_ID"), "occupancy": None, "status": "no_data", "color": "#94a3b8", "radius": 8})
    elif layer_key == "rivers":
        props.update({"id": entity_id, "name": first_value(props, "adi", "nehir_kod", "OBJECTID"), "riverCode": first_value(props, "nehir_kod"), "basinId": first_value(props, "HAVZA_ID", "Havza_Id_Text"), "lengthKm": (as_number(first_value(props, "uzunluk")) or 0) / 1000, "flow": None, "status": "no_data", "color": "#38bdf8", "width": 2.8})
    elif layer_key == "basins":
        props.update({"id": entity_id, "basinId": first_value(props, "ID", "OBJECTID_1"), "name": first_value(props, "HAVZA_ADI", "ETIKET", "ID"), "areaKm2": as_number(first_value(props, "ALAN_KM2")), "status": "no_data", "color": "#2563eb"})

    return {"type": "Feature", "id": entity_id, "geometry": geometry, "properties": props}


def feature_collection(layer_key: str, features: Iterable[dict[str, Any]]) -> dict[str, Any]:
    return {
        "type": "FeatureCollection",
        "features": [canonicalize(layer_key, feature, index) for index, feature in enumerate(features)],
    }


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False, suffix=".tmp") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
        temporary = Path(handle.name)
    os.replace(temporary, path)

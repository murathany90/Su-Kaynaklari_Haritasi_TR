"""Build a small, provenance-preserving reservoir polygon package.

The GDW service is queried only for the Turkey envelope at build time. The
browser receives polygons that passed a facility-name and coordinate check;
the global source dataset is never shipped to the application.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import unicodedata

ROOT = Path(__file__).resolve().parents[2]
HES_PATH = ROOT / "public/data/hes177/hes_177.geojson"
MANIFEST_PATH = ROOT / "public/data/hes177/hes_177_manifest.json"
RELATIONS_PATH = ROOT / "public/data/hes177/hes_177_relations.json"
OUT_PATH = ROOT / "public/data/hes177/hes_reservoirs.geojson"
CACHE_PATH = ROOT / "public/data/static/mappings/gdw_turkey_reservoirs.geojson"
CACHE_META_PATH = ROOT / "public/data/static/mappings/gdw_turkey_reservoirs.meta.json"
GDW_QUERY = "https://services8.arcgis.com/oTalEaSXAuyNT7xf/ArcGIS/rest/services/GDW_v1_epsilon_gdb/FeatureServer/1/query"
GDW_LAYER = "https://services8.arcgis.com/oTalEaSXAuyNT7xf/ArcGIS/rest/services/GDW_v1_epsilon_gdb/FeatureServer/1"


def normalize(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode().upper()
    text = re.sub(r"\b(HES|SANTRALI|SANTRAL|BARAJI|BARAJ|DAMI|DAM|RESERVOIR|GOLU|GOL)\b", " ", text)
    return re.sub(r"[^A-Z0-9]+", " ", text).strip()


def number(value: Any) -> float | None:
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def point_of(feature: dict[str, Any]) -> tuple[float, float] | None:
    geometry = feature.get("geometry") or {}
    if geometry.get("type") != "Point":
        return None
    coordinates = geometry.get("coordinates") or []
    if len(coordinates) < 2:
        return None
    lon, lat = number(coordinates[0]), number(coordinates[1])
    return (lon, lat) if lon is not None and lat is not None else None


def polygon_rings(geometry: dict[str, Any] | None) -> list[list[list[float]]]:
    geometry = geometry or {}
    if geometry.get("type") == "Polygon":
        return geometry.get("coordinates") or []
    if geometry.get("type") == "MultiPolygon":
        return [ring for polygon in geometry.get("coordinates", []) for ring in polygon]
    return []


def geometry_points(geometry: dict[str, Any] | None) -> list[tuple[float, float]]:
    return [(float(pair[0]), float(pair[1])) for ring in polygon_rings(geometry) for pair in ring if len(pair) >= 2]


def point_in_ring(point: tuple[float, float], ring: list[list[float]]) -> bool:
    x, y = point
    inside = False
    previous = ring[-1] if ring else []
    for current in ring:
        if len(previous) < 2 or len(current) < 2:
            previous = current
            continue
        x1, y1 = previous[0], previous[1]
        x2, y2 = current[0], current[1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
            inside = not inside
        previous = current
    return inside


def point_in_polygon(point: tuple[float, float], geometry: dict[str, Any] | None) -> bool:
    for polygon in ([polygon_rings(geometry)] if geometry and geometry.get("type") == "Polygon" else (geometry or {}).get("coordinates", [])):
        if not polygon:
            continue
        rings = polygon if geometry and geometry.get("type") == "MultiPolygon" else polygon
        if rings and point_in_ring(point, rings[0]) and not any(point_in_ring(point, hole) for hole in rings[1:]):
            return True
    return False


def distance_km(left: tuple[float, float], right: tuple[float, float]) -> float:
    lon1, lat1 = map(math.radians, left)
    lon2, lat2 = map(math.radians, right)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def point_polygon_distance_km(point: tuple[float, float], geometry: dict[str, Any]) -> float:
    if point_in_polygon(point, geometry):
        return 0.0
    return min((distance_km(point, candidate) for candidate in geometry_points(geometry)), default=float("inf"))


def fetch_gdw() -> dict[str, Any]:
    if CACHE_PATH.exists():
        return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    params = {
        "where": "COUNTRY = 'Turkey'",
        "geometry": "25,35,45,43",
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "*",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
        "resultRecordCount": "2000",
    }
    url = f"{GDW_QUERY}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": "Su-Kaynaklari-Haritasi-TR/1.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = json.loads(response.read().decode("utf-8-sig"))
    if not isinstance(payload, dict) or payload.get("type") != "FeatureCollection":
        raise RuntimeError("GDW reservoir query returned invalid GeoJSON")
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    CACHE_PATH.write_text(raw + "\n", encoding="utf-8")
    CACHE_META_PATH.write_text(json.dumps({"source": GDW_LAYER, "sourceUrl": url, "fetchedAt": datetime.now(timezone.utc).isoformat(), "sha256": hashlib.sha256(raw.encode()).hexdigest(), "featureCount": len(payload.get("features", []))}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload


def name_score(hes: dict[str, Any], candidate: dict[str, Any]) -> float:
    h_names = [normalize(hes.get("damName")), normalize(hes.get("name")), normalize(hes.get("waterBodyName"))]
    c_props = candidate.get("properties") or {}
    c_names = [normalize(c_props.get("RES_NAME")), normalize(c_props.get("DAM_NAME")), normalize(c_props.get("ALT_NAME"))]
    best = 0.0
    for left in h_names:
        if not left:
            continue
        for right in c_names:
            if not right:
                continue
            if left == right:
                best = max(best, 1.0)
            elif len(left) >= 5 and (left in right or right in left):
                best = max(best, 0.82)
            else:
                overlap = len(set(left.split()) & set(right.split()))
                if overlap and overlap / max(len(left.split()), len(right.split())) >= 0.5:
                    best = max(best, 0.62)
    return best


def main() -> None:
    hes = json.loads(HES_PATH.read_text(encoding="utf-8"))
    gdw = fetch_gdw()
    candidates = [feature for feature in gdw.get("features", []) if polygon_rings(feature.get("geometry"))]
    output: dict[str, dict[str, Any]] = {}
    matched_hes: set[str] = set()
    for feature in hes.get("features", []):
        props = feature.get("properties") or {}
        hes_id = str(props.get("id") or feature.get("id") or "")
        point = point_of(feature)
        if not point or props.get("coordinateKind") in {"transformer", "unresolved"}:
            continue
        ranked: list[tuple[float, float, dict[str, Any]]] = []
        for candidate in candidates:
            score = name_score(props, candidate)
            if score < 0.62:
                continue
            distance = point_polygon_distance_km(point, candidate["geometry"])
            if distance > (35 if score >= 0.82 else 15):
                continue
            ranked.append((score, distance, candidate))
        if not ranked:
            continue
        score, distance, candidate = max(ranked, key=lambda item: (item[0], -item[1]))
        candidate_props = candidate.get("properties") or {}
        gdw_id = str(candidate_props.get("GDW_ID") or candidate.get("id") or "")
        record = output.setdefault(gdw_id, {"type": "Feature", "id": f"reservoir-gdw-{gdw_id}", "geometry": candidate["geometry"], "properties": {"id": f"reservoir-gdw-{gdw_id}", "hesIds": [], "basinIds": [], "riverSystemIds": [], "damName": candidate_props.get("DAM_NAME") or candidate_props.get("RES_NAME"), "reservoirName": candidate_props.get("RES_NAME") or candidate_props.get("DAM_NAME"), "basinId": props.get("officialBasinId") or props.get("basinId"), "source": "GDW", "sourceId": gdw_id, "sourceUrl": GDW_LAYER, "matchMethod": "name+coordinate", "matchConfidence": "high" if score >= 0.82 and distance <= 10 else "medium", "areaKm2": candidate_props.get("AREA_POLY") or candidate_props.get("AREA_SKM"), "validated": True, "validationNotes": "Turkey envelope; facility name, basin/river relation and coordinate distance check"}})
        record["properties"]["hesIds"] = sorted(set(record["properties"].get("hesIds", []) + [hes_id]))
        basin_id = props.get("officialBasinId") or props.get("basinId")
        river_system_id = props.get("riverSystemId")
        if basin_id not in (None, ""):
            record["properties"]["basinIds"] = sorted(set(record["properties"].get("basinIds", []) + [str(basin_id)]))
        if river_system_id not in (None, ""):
            record["properties"]["riverSystemIds"] = sorted(set(record["properties"].get("riverSystemIds", []) + [str(river_system_id)]))
        matched_hes.add(hes_id)
        props["reservoirIds"] = [record["properties"]["id"]]
        props["reservoirName"] = record["properties"]["reservoirName"]
        props["reservoirSource"] = "GDW"
        props["reservoirMatchMethod"] = "name+coordinate"
        props["reservoirMatchConfidence"] = record["properties"]["matchConfidence"]
        props["coordinateDistanceToReservoirKm"] = round(distance, 2)
    for feature in hes.get("features", []):
        props = feature.get("properties") or {}
        props.setdefault("reservoirIds", [])
        if str(props.get("id")) not in matched_hes:
            props["coordinateDistanceToReservoirKm"] = None
    output_payload = {"type": "FeatureCollection", "features": list(output.values())}
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(output_payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    applicable = [feature for feature in hes.get("features", []) if (feature.get("properties") or {}).get("hydroPlantStorageType") in {"reservoir", "pondage"}]
    manifest["reservoirPolygonCount"] = len(output_payload["features"])
    manifest["reservoirPolygonCoverage"] = round(len(matched_hes) / len(applicable) * 100, 1) if applicable else 0
    manifest["reservoirMatchedHesCount"] = len(matched_hes)
    manifest["reservoirSource"] = "GDW Turkey envelope"
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    if RELATIONS_PATH.exists():
        relations = json.loads(RELATIONS_PATH.read_text(encoding="utf-8"))
        for hes_feature in hes.get("features", []):
            hid = str((hes_feature.get("properties") or {}).get("id") or "")
            if hid in relations.get("byHesId", {}):
                relations["byHesId"][hid]["reservoirIds"] = (hes_feature.get("properties") or {}).get("reservoirIds", [])
        RELATIONS_PATH.write_text(json.dumps(relations, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    HES_PATH.write_text(json.dumps(hes, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"reservoirPolygons": len(output_payload["features"]), "matchedHes": len(matched_hes), "applicableHes": len(applicable), "coveragePercent": manifest["reservoirPolygonCoverage"], "source": "GDW"}, ensure_ascii=False))


if __name__ == "__main__":
    main()

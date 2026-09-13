"""Build the browser-sized HES v3 GIS package.

The workbook is parsed by worksheet name and cell address.  TATUS queries are
used as build-time evidence; the browser receives only the focused HES package.
"""

from __future__ import annotations

import json
import math
import re
import urllib.request
import zipfile
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "docs" / "HES_177_Zenginlestirilmis_Envanter_v3.xlsx"
TATUS = ROOT / "public" / "data" / "static" / "tatus"
OUT = ROOT / "public" / "data" / "hes177"
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def clean(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


def number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        result = float(str(value).replace(",", "."))
    except ValueError:
        return None
    return result if math.isfinite(result) else None


def normalize(value: Any) -> str:
    """Normalize names without deleting I/II/III/IV facility suffixes."""
    text = str(value or "").upper().translate(str.maketrans("ÇĞİÖŞÜ", "CGIOSU"))
    text = re.sub(r"\b(BARAJI|BARAJ|BRJ|HES|SANTRALI|SANTRAL|VE)\b", " ", text)
    return re.sub(r"[^A-Z0-9IV]+", " ", text).strip()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def column_index(reference: str) -> int:
    letters = re.match(r"[A-Z]+", reference.upper())
    if not letters:
        return -1
    result = 0
    for character in letters.group(0):
        result = result * 26 + ord(character) - 64
    return result - 1


def workbook_target(archive: zipfile.ZipFile, sheet_name: str) -> str:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {item.attrib["Id"]: item.attrib["Target"] for item in relationships}
    for sheet in workbook.find(NS + "sheets"):
        if sheet.attrib.get("name") == sheet_name:
            target = targets[sheet.attrib[REL_NS + "id"]].lstrip("/")
            return target if target.startswith("xl/") else "xl/" + target
    raise ValueError(f"Worksheet not found: {sheet_name}")


def read_workbook_rows() -> list[dict[str, Any]]:
    with zipfile.ZipFile(WORKBOOK) as archive:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = ["".join(node.text or "" for node in item.iter(NS + "t")) for item in shared_root.findall(NS + "si")]
        sheet_root = ET.fromstring(archive.read(workbook_target(archive, "HES_177")))
        rows: list[dict[int, Any]] = []
        for row in sheet_root.find(NS + "sheetData").findall(NS + "row"):
            values: dict[int, Any] = {}
            for cell in row.findall(NS + "c"):
                raw_node = cell.find(NS + "v")
                raw = "" if raw_node is None else raw_node.text or ""
                if cell.get("t") == "s" and raw:
                    value: Any = shared[int(raw)]
                elif cell.get("t") == "inlineStr":
                    value = "".join(node.text or "" for node in cell.iter(NS + "t"))
                else:
                    value = raw
                values[column_index(cell.attrib.get("r", ""))] = clean(value)
            rows.append(values)
    header_row = next((row for row in rows if any(str(value or "").strip().upper() == "HES" for value in row.values()) and any("HAVZA" in normalize(value) and "ID" in normalize(value) for value in row.values())), None)
    if not header_row:
        raise ValueError("HES_177 header row not found")
    headers = {index: str(value) for index, value in header_row.items() if value}
    records: list[dict[str, Any]] = []
    for row in rows[rows.index(header_row) + 1 :]:
        if not row.get(1):
            continue
        records.append({headers[index]: clean(value) for index, value in row.items() if index in headers})
    return records


def feature_id(feature: dict[str, Any]) -> str:
    properties = feature.get("properties") or {}
    return str(properties.get("id") or properties.get("entityId") or feature.get("id") or "")


def basin_id(feature: dict[str, Any]) -> str:
    properties = feature.get("properties") or {}
    return str(properties.get("basinId") or properties.get("HAVZA_ID") or properties.get("ID") or "")


def point_of(feature: dict[str, Any] | None) -> tuple[float, float] | None:
    geometry = (feature or {}).get("geometry") or {}
    if geometry.get("type") != "Point" or len(geometry.get("coordinates", [])) < 2:
        return None
    try:
        return float(geometry["coordinates"][0]), float(geometry["coordinates"][1])
    except (TypeError, ValueError):
        return None


def geometry_points(geometry: dict[str, Any] | None) -> list[tuple[float, float]]:
    geometry = geometry or {}
    kind, coordinates = geometry.get("type"), geometry.get("coordinates")
    if kind == "Point":
        return [tuple(coordinates)]
    if kind in {"LineString", "MultiPoint"}:
        return [tuple(item) for item in coordinates]
    if kind in {"MultiLineString", "Polygon"}:
        return [tuple(item) for group in coordinates for item in group]
    if kind == "MultiPolygon":
        return [tuple(item) for polygon in coordinates for group in polygon for item in group]
    return []


def centroid(feature: dict[str, Any]) -> tuple[float, float] | None:
    points = geometry_points(feature.get("geometry"))
    return (sum(point[0] for point in points) / len(points), sum(point[1] for point in points) / len(points)) if points else None


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = map(math.radians, a)
    lon2, lat2 = map(math.radians, b)
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def parse_geojson(value: Any) -> dict[str, Any] | None:
    if not value or not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


def first_point(value: Any) -> tuple[float, float] | None:
    parsed = parse_geojson(value)
    if not parsed:
        return None
    features = parsed.get("features", []) if parsed.get("type") == "FeatureCollection" else [parsed]
    for feature in features:
        point = point_of(feature)
        if point:
            return point
    return None


def fetch_json(url: Any) -> dict[str, Any] | None:
    if not isinstance(url, str) or not url.startswith("http"):
        return None
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "HES177-build/3"})
        with urllib.request.urlopen(request, timeout=12) as response:
            parsed = json.loads(response.read().decode("utf-8-sig"))
            return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def fetch_unique(urls: set[str]) -> dict[str, dict[str, Any] | None]:
    result: dict[str, dict[str, Any] | None] = {}
    with ThreadPoolExecutor(max_workers=12) as executor:
        futures = {executor.submit(fetch_json, url): url for url in urls}
        for future in as_completed(futures):
            url = futures[future]
            try:
                result[url] = future.result()
            except Exception:
                result[url] = None
    return result


def feature_lines(payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    return [feature for feature in (payload or {}).get("features", []) if (feature.get("geometry") or {}).get("type") in {"LineString", "MultiLineString"}]


def feature_points(payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    return [feature for feature in (payload or {}).get("features", []) if point_of(feature)]


KNOWN_RIVER_HES = {
    "Fırat": {"ATATURK", "BIRECIK NIZIP", "KARKAMIS", "KARAKAYA", "KEBAN", "BAGISTAS1", "BAGISTAS2", "TERCAN", "YUKARI KALEKOY", "ASAGI KALEKOY", "BEYHAN1", "TATAR", "UZUNCAYIR", "KIGI", "OZLUCE", "PEMBELIK", "SEYRANTEPE", "MURSAL", "ALPASLAN1", "ALPASLAN2"},
    "Dicle": {"ILISU", "DICLE", "KRALKIZI", "BATMAN", "GARZAN", "SIRNAK", "SILOPI", "SIRVAN", "ALKUMRU", "CIZRE", "ULUDERE", "BALLI", "MUSATEPE", "KIRAZLIK"},
    "Kızılırmak": {"KARGI KIZILIRMAK", "HIRFANLI", "KESIKKOPRU", "ALTINKAYA", "DERBENT", "OSMANCIK"},
    "Sakarya": {"GOYNUK", "YENICE", "GOKCEKAYA", "KARAKAYA SAKARYA"},
    "Yeşilırmak": {"KAVSAK", "ALMUS", "KILICKAYA", "ALTINKAYA YESILIRMAK"},
    "Çoruh": {"YUSUFELI", "DERINER", "BORCKA", "MURATLI", "ARKUN", "ARTVIN"},
    "Seyhan": {"CATALAN", "YEDIGOZE", "KILAVUZLU", "SEYHAN"},
    "Ceyhan": {"ATATURK CEYHAN", "MENZELET", "SIR", "KANDIL", "BERKE", "SUGOZU"},
}


def known_river(*values: Any) -> str | None:
    text = normalize(" ".join(str(value or "") for value in values))
    for river, names in KNOWN_RIVER_HES.items():
        if any(token in text for token in names):
            return river
    direct = (("FIRAT", "Fırat"), ("DICLE", "Dicle"), ("KIZILIRMAK", "Kızılırmak"), ("SAKARYA", "Sakarya"), ("YESILIRMAK", "Yeşilırmak"), ("CORUH", "Çoruh"), ("SEYHAN", "Seyhan"), ("CEYHAN", "Ceyhan"), ("BUYUK MENDERES", "Büyük Menderes"), ("GEDIZ", "Gediz"))
    return next((name for token, name in direct if token in text), None)


def best_name(value: Any, candidates: list[tuple[str, str]]) -> tuple[str, float] | None:
    needle = normalize(value)
    if not needle:
        return None
    for identifier, name in candidates:
        candidate = normalize(name)
        if candidate and candidate == needle:
            return identifier, 1.0
    return None


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    rows = read_workbook_rows()
    dams_source = read_json(TATUS / "dam_stations.geojson")
    basins_source = read_json(TATUS / "basins.geojson")
    stations_source = read_json(TATUS / "hes_stations.geojson")
    basin_ids = {str(row.get("Havza ID")) for row in rows if row.get("Havza ID")}
    basin_by_id = {basin_id(feature): feature for feature in basins_source.get("features", [])}
    relevant_basins = [{**feature, "properties": {**(feature.get("properties") or {}), "hes177": True}} for bid, feature in basin_by_id.items() if bid in basin_ids]

    river_urls = {str(row.get("Akarsu Polyline GeoJSON URL")) for row in rows if row.get("Akarsu Polyline GeoJSON URL")}
    dam_urls = {str(row.get("TATUS Baraj Point GeoJSON URL")) for row in rows if row.get("TATUS Baraj Point GeoJSON URL")}
    fetched_rivers, fetched_dams = fetch_unique(river_urls | dam_urls), fetch_unique(dam_urls)

    hes_features: list[dict[str, Any]] = []
    for row in rows:
        sequence = int(float(row["Sıra"]))
        hes_id = f"hes177-{sequence:03d}"
        lon, lat = number(row.get("Boylam")), number(row.get("Enlem"))
        workbook_point = [lon, lat] if lon is not None and lat is not None and -180 <= lon <= 180 and -90 <= lat <= 90 else None
        geojson_point = first_point(row.get("HES Point GeoJSON"))
        point = list(geojson_point or workbook_point) if (geojson_point or workbook_point) else None
        status = str(row.get("Koordinat Durumu") or "")
        if geojson_point and "doğrulan" in status.lower():
            coordinate_source, coordinate_kind = "hes-point-geojson", "verified"
        elif workbook_point and "doğrulan" in status.lower():
            coordinate_source, coordinate_kind = "workbook-verified", "verified"
        elif "trafo" in status.lower():
            coordinate_source, coordinate_kind = "transformer", "transformer"
        else:
            coordinate_source, coordinate_kind = ("workbook", "verified") if point else (None, "unresolved")
        properties = {
            "id": hes_id, "entityId": hes_id, "entityType": "hes177", "name": row.get("HES"), "inventoryOrder": sequence,
            "basinId": str(row.get("Havza ID") or ""), "basinName": row.get("Havza (TATUS)") or row.get("Havza (Kaynak)"), "province": row.get("Bulunduğu İl"),
            "damName": row.get("Baraj / Rezervuar Eşleşmesi"), "installedPowerMw": number(row.get("Kurulu Güç (MW)")), "unitFlowM3s": number(row.get("Ünite Debisi (m³/sn)")),
            "maxWaterLevelM": number(row.get("Maksimum Su Seviyesi (m)")), "minWaterLevelM": number(row.get("Minimum Su Seviyesi (m)")), "maxVolumeHm3": number(row.get("Maksimum Hacim (hm³)")),
            "minVolumeHm3": number(row.get("Minimum Hacim (hm³)")), "activeVolumeHm3": number(row.get("Aktif Hacim (hm³)")), "waterEnergyMwh": number(row.get("Suyun Enerji Karşılığı (MWh)")),
            "epiasDate": row.get("EPİAŞ Veri Tarihi"), "dataQuality": row.get("Veri Kalitesi"), "sourceMatchMethod": row.get("Eşleşme Yöntemi"), "cascadeName": row.get("Kaskat Santrali"),
            "cascadeSourceValue": row.get("Kaskat Kaynak Değeri"), "notes": row.get("Not"), "coordinateStatus": row.get("Koordinat Durumu"), "coordinateType": row.get("Koordinat Tipi"),
            "coordinateSource": coordinate_source, "coordinateKind": coordinate_kind, "transformerId": row.get("Trafo Merkezi ID"), "transformerName": row.get("Trafo Merkezi Adı"),
            "riverNameSource": row.get("Akarsu Eşleme Durumu"), "riverCode": None, "riverQueryUrl": row.get("Akarsu Polyline GeoJSON URL"), "catchmentUrl": row.get("Su Toplama Alanı Polygon GeoJSON URL"),
            "catchmentLabel": row.get("Su Toplama Alanı Popup"), "gisConfidence": row.get("GIS Güven"), "gisNote": row.get("GIS Notu"), "hasDamMatch": False,
        }
        hes_features.append({"type": "Feature", "id": hes_id, "geometry": {"type": "Point", "coordinates": point} if point else None, "properties": properties})

    hes_by_id = {feature["properties"]["id"]: feature for feature in hes_features}
    hes_by_name = [(feature["properties"]["id"], feature["properties"]["name"]) for feature in hes_features]

    dam_records: dict[str, dict[str, Any]] = {}
    local_dams = dams_source.get("features", [])
    for row, hes in zip(rows, hes_features):
        props = hes["properties"]
        basin = props["basinId"]
        target_name = props.get("damName") or props.get("name")
        candidates = [feature for feature in local_dams if basin_id(feature) == basin]
        candidates += feature_points(fetched_dams.get(str(row.get("TATUS Baraj Point GeoJSON URL"))))
        inline = parse_geojson(row.get("TATUS Baraj Point GeoJSON"))
        candidates += feature_points(inline)
        chosen: list[dict[str, Any]] = []
        for candidate in candidates:
            candidate_props = candidate.get("properties") or {}
            candidate_name = candidate_props.get("BarajAdi") or candidate_props.get("damName") or candidate_props.get("name")
            candidate_point = point_of(candidate)
            exact = best_name(target_name, [("candidate", str(candidate_name or ""))])
            close = False
            if candidate_point and point_of(hes):
                close = haversine(candidate_point, point_of(hes)) <= 40
            if exact and (not point_of(hes) or close or candidate_name):
                chosen.append(candidate)
        if not chosen:
            continue
        points = [point_of(candidate) for candidate in chosen if point_of(candidate)]
        if not points:
            continue
        key = f"{basin}:{normalize(target_name)}"
        average = [sum(point[0] for point in points) / len(points), sum(point[1] for point in points) / len(points)]
        record = dam_records.setdefault(key, {"name": target_name, "basinId": basin, "basinName": props.get("basinName"), "points": [], "hesIds": [], "sourceIds": []})
        record["points"].extend(points)
        if props["id"] not in record["hesIds"]: record["hesIds"].append(props["id"])
        for candidate in chosen:
            candidate_id = feature_id(candidate)
            if candidate_id and candidate_id not in record["sourceIds"]: record["sourceIds"].append(candidate_id)
        props["hasDamMatch"] = True
        props["damMatchMethod"] = "name+basin+near-coordinate"

    dam_features: list[dict[str, Any]] = []
    dam_by_hes: dict[str, list[str]] = defaultdict(list)
    for index, (key, record) in enumerate(sorted(dam_records.items())):
        points = record["points"]
        center = [sum(point[0] for point in points) / len(points), sum(point[1] for point in points) / len(points)]
        dam_id = f"dam177-{index + 1:03d}"
        for hes_id in record["hesIds"]: dam_by_hes[hes_id].append(dam_id)
        dam_features.append({"type": "Feature", "id": dam_id, "geometry": {"type": "Point", "coordinates": center}, "properties": {"id": dam_id, "entityId": dam_id, "entityType": "hesDamPoints", "name": record["name"], "damName": record["name"], "basinId": record["basinId"], "basinName": record["basinName"], "hesIds": record["hesIds"], "pointCount": len(points), "coordinateSource": "TATUS Layer 7", "sourceIds": record["sourceIds"], "isProducer": True}})

    river_segments: dict[str, dict[str, Any]] = {}
    for row, hes in zip(rows, hes_features):
        url = str(row.get("Akarsu Polyline GeoJSON URL") or "")
        props = hes["properties"]
        known = known_river(props.get("name"), props.get("damName"))
        payload = fetched_rivers.get(url)
        lines = feature_lines(payload)
        for line in lines:
            line_props = line.get("properties") or {}
            code = str(line_props.get("nehir_kod") or line_props.get("riverCode") or feature_id(line))
            tatus_name = line_props.get("adi") or line_props.get("name")
            # A controlled HES-to-major-river match is stronger than a short
            # segment label returned by TATUS.
            line_name = known or (tatus_name if tatus_name and normalize(tatus_name) not in {"BILINMIYOR", "UNKNOWN"} else None)
            if not line_name:
                line_name = f"Adsız akarsu · {code}"
            key = f"{props['basinId']}:{code}:{json.dumps(line.get('geometry'), sort_keys=True)}"
            record = river_segments.setdefault(key, {"geometry": line.get("geometry"), "name": line_name, "riverName": line_name if not line_name.startswith("Adsız") else None, "riverCode": code, "basinId": props["basinId"], "hesIds": [], "source": "TATUS Layer 8", "matchMethod": "tatus-spatial+name" if known else "tatus-spatial", "confidence": "high" if known else "medium", "lengthKm": number(line_props.get("lengthKm")) or (number(line_props.get("uzunluk")) or 0) / 1000})
            if props["id"] not in record["hesIds"]: record["hesIds"].append(props["id"])
            if code and code not in (props.get("riverCode") or ""): props["riverCode"] = code
            if line_name and not line_name.startswith("Adsız"):
                props["riverName"], props["riverMatchMethod"], props["riverConfidence"] = line_name, record["matchMethod"], record["confidence"]

    # Collapse technical TATUS segments into one browser-facing feature per
    # named river system. Unnamed segments remain build-time evidence only and
    # are intentionally not exposed as sidebar rows.
    river_systems: dict[str, dict[str, Any]] = {}
    for record in river_segments.values():
        river_name = record.get("riverName")
        if not river_name:
            continue
        normalized_name = normalize(river_name)
        major_system = normalized_name in {"FIRAT", "DICLE", "KIZILIRMAK", "SAKARYA", "YESILIRMAK", "CORUH", "SEYHAN", "CEYHAN", "BUYUK MENDERES", "GEDIZ", "MURAT", "KARASU", "ARAS"}
        system_key = f"major:{normalized_name}" if major_system else f"{record['basinId']}:{normalized_name}"
        system = river_systems.setdefault(system_key, {"name": river_name, "basinId": record["basinId"], "basinIds": [], "hesIds": [], "codes": [], "geometries": [], "lengthKm": 0.0, "matchMethods": set(), "confidences": set()})
        if record["basinId"] not in system["basinIds"]: system["basinIds"].append(record["basinId"])
        geometry = record.get("geometry") or {}
        if geometry.get("type") == "LineString" and len(geometry.get("coordinates", [])) > 1:
            system["geometries"].append(geometry["coordinates"])
        elif geometry.get("type") == "MultiLineString":
            system["geometries"].extend([part for part in geometry.get("coordinates", []) if len(part) > 1])
        system["lengthKm"] += record.get("lengthKm") or 0
        system["matchMethods"].add(record["matchMethod"])
        system["confidences"].add(record["confidence"])
        for hes_id in record["hesIds"]:
            if hes_id not in system["hesIds"]: system["hesIds"].append(hes_id)
        if record["riverCode"] and record["riverCode"] not in system["codes"]: system["codes"].append(record["riverCode"])

    river_features: list[dict[str, Any]] = []
    river_system_ids_by_hes: dict[str, list[str]] = defaultdict(list)
    for index, system in enumerate(sorted(river_systems.values(), key=lambda item: (item["basinId"], item["name"])), start=1):
        river_id = f"river-system-{index:03d}"
        parts = system["geometries"]
        geometry = {"type": "LineString", "coordinates": parts[0]} if len(parts) == 1 else {"type": "MultiLineString", "coordinates": parts}
        confidence = "high" if "high" in system["confidences"] else "medium"
        properties = {"id": river_id, "entityId": river_id, "entityType": "hesRiverSystem", "name": system["name"], "riverName": system["name"], "riverSystemId": river_id, "riverCode": system["codes"][0] if system["codes"] else None, "riverCodes": system["codes"], "hesIds": system["hesIds"], "hesCount": len(system["hesIds"]), "installedPowerMw": sum(hes_by_id[hid]["properties"].get("installedPowerMw") or 0 for hid in system["hesIds"]), "basinId": system["basinId"], "basinIds": system["basinIds"], "geometrySource": "TATUS Layer 8", "matchMethod": "+".join(sorted(system["matchMethods"])), "confidence": confidence, "lengthKm": system["lengthKm"], "segmentCount": len(parts), "hes177": True}
        river_features.append({"type": "Feature", "id": river_id, "geometry": geometry, "properties": properties})
        for hes_id in system["hesIds"]: river_system_ids_by_hes[hes_id].append(river_id)
    for feature in river_features:
        for hes_id in feature["properties"]["hesIds"]:
            hes_by_id[hes_id]["properties"]["riverSystemId"] = feature["properties"]["riverSystemId"]

    station_features: list[dict[str, Any]] = []
    station_ids_by_hes: dict[str, list[str]] = defaultdict(list)
    for source in stations_source.get("features", []):
        source_point = point_of(source)
        if not source_point: continue
        sp = source.get("properties") or {}; basin = basin_id(source)
        nearest: tuple[str, float] | None = None
        for hes in hes_features:
            hp = point_of(hes)
            if basin != hes["properties"]["basinId"] or not hp: continue
            distance = haversine(source_point, hp)
            if nearest is None or distance < nearest[1]: nearest = (hes["properties"]["id"], distance)
        if not nearest or nearest[1] > 25: continue
        station_id = f"station177-{feature_id(source)}"
        station_ids_by_hes[nearest[0]].append(station_id)
        station_features.append({"type": "Feature", "id": station_id, "geometry": source["geometry"], "properties": {**sp, "id": station_id, "entityId": station_id, "entityType": "hesStations177", "name": sp.get("IstAdi") or sp.get("name"), "riverName": sp.get("SuAdi"), "basinId": basin, "hesId": nearest[0], "distanceKm": round(nearest[1], 2), "coordinateSource": "TATUS Layer 4"}})

    cascade_edges: list[dict[str, Any]] = []; unresolved_cascades: list[dict[str, Any]] = []; downstream: dict[str, set[str]] = defaultdict(set); upstream: dict[str, set[str]] = defaultdict(set)
    for hes in hes_features:
        raw = hes["properties"].get("cascadeName")
        if not raw or re.fullmatch(r"[0-9.]+", str(raw).strip()): continue
        target = best_name(raw, hes_by_name)
        if not target:
            unresolved_cascades.append({"hesId": hes["properties"]["id"], "value": raw}); continue
        target_id = target[0]; source_id = hes["properties"]["id"]
        if target_id == source_id: continue
        downstream[source_id].add(target_id); upstream[target_id].add(source_id)
        cascade_edges.append({"fromId": source_id, "toId": target_id, "fromName": hes["properties"]["name"], "toName": hes_by_id[target_id]["properties"]["name"]})
    relation_by_hes: dict[str, Any] = {}
    for hes in hes_features:
        p = hes["properties"]; hid = p["id"]
        river_ids = sorted(set(river_system_ids_by_hes.get(hid, [])))
        relation_by_hes[hid] = {"riverIds": river_ids, "riverSystemIds": river_ids, "riverSystemId": river_ids[0] if len(river_ids) == 1 else None, "riverName": p.get("riverName"), "riverMatchMethod": p.get("riverMatchMethod"), "riverConfidence": p.get("riverConfidence"), "damIds": dam_by_hes.get(hid, []), "stationIds": station_ids_by_hes.get(hid, []), "catchmentUrl": p.get("catchmentUrl"), "cascadeToId": next(iter(sorted(downstream[hid])), None), "cascadeFromIds": sorted(upstream[hid])}
        p.update({"riverIds": relation_by_hes[hid]["riverIds"], "riverSystemIds": relation_by_hes[hid]["riverSystemIds"], "riverSystemId": relation_by_hes[hid]["riverSystemId"], "damIds": relation_by_hes[hid]["damIds"], "stationIds": relation_by_hes[hid]["stationIds"], "cascadeToId": relation_by_hes[hid]["cascadeToId"], "cascadeFromIds": relation_by_hes[hid]["cascadeFromIds"], "isProducer": bool(p.get("hasDamMatch"))})

    cascade_features = []
    for edge in cascade_edges:
        source, target = hes_by_id[edge["fromId"]], hes_by_id[edge["toId"]]
        if point_of(source) and point_of(target):
            cascade_features.append({"type": "Feature", "id": f"cascade-{edge['fromId']}-{edge['toId']}", "geometry": {"type": "LineString", "coordinates": [source["geometry"]["coordinates"], target["geometry"]["coordinates"]]}, "properties": {**edge, "entityType": "hesCascade"}})

    station_count_by_basin = defaultdict(int)
    for feature in station_features: station_count_by_basin[basin_id(feature)] += 1
    summaries = []
    for basin in relevant_basins:
        bid = basin_id(basin); bp = basin.get("properties") or {}; h = [f for f in hes_features if f["properties"]["basinId"] == bid]; r = [f for f in river_features if bid in f["properties"].get("basinIds", [f["properties"].get("basinId")])]
        summaries.append({"basinId": bid, "name": bp.get("name") or bp.get("HAVZA_ADI"), "areaKm2": number(bp.get("areaKm2") or bp.get("ALAN_KM2")), "hesCount": len(h), "installedPowerMw": sum(f["properties"].get("installedPowerMw") or 0 for f in h), "riverCount": len(r), "riverLengthKm": sum(f["properties"].get("lengthKm") or 0 for f in r), "damCount": sum(1 for f in dam_features if f["properties"].get("basinId") == bid), "hesStationCount": station_count_by_basin[bid], "lakeStationCount": 0, "knownRiverNames": sorted({f["properties"]["riverName"] for f in r if f["properties"].get("riverName")})})

    def write(name: str, data: Any) -> None:
        (OUT / name).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    write("hes_177.geojson", {"type": "FeatureCollection", "features": hes_features})
    write("hes_rivers.geojson", {"type": "FeatureCollection", "features": river_features})
    write("hes_basins.geojson", {"type": "FeatureCollection", "features": relevant_basins})
    write("hes_dam_points.geojson", {"type": "FeatureCollection", "features": dam_features})
    write("hes_stations_177.geojson", {"type": "FeatureCollection", "features": station_features})
    write("hes_cascades.geojson", {"type": "FeatureCollection", "features": cascade_features})
    write("hes_177_relations.json", {"byHesId": relation_by_hes, "cascadeEdges": cascade_edges, "unresolvedCascades": unresolved_cascades, "basinSummaries": summaries, "riverGroups": {name: sorted({rid for feature in river_features if feature["properties"].get("riverName") == name for rid in feature["properties"].get("hesIds", [])}) for name in sorted({feature["properties"].get("riverName") for feature in river_features if feature["properties"].get("riverName")})}})
    coordinate_count = sum(bool(feature.get("geometry")) for feature in hes_features)
    verified = sum(feature["properties"].get("coordinateKind") == "verified" for feature in hes_features)
    dam_fallback = sum(feature["properties"].get("coordinateSource") == "tatus-dam-point" for feature in hes_features)
    transformer = sum(feature["properties"].get("coordinateKind") == "transformer" for feature in hes_features)
    manifest = {"version": 3, "source": str(WORKBOOK.relative_to(ROOT)).replace("\\", "/"), "hesCount": len(hes_features), "coordinateCount": coordinate_count, "verifiedCoordinateCount": verified, "damFallbackCoordinateCount": dam_fallback, "transformerCoordinateCount": transformer, "unresolvedCoordinateCount": len(hes_features) - coordinate_count, "basinCount": len(relevant_basins), "logicalRiverCount": len(river_features), "riverFeatureCount": len(river_features), "riverGeometryFeatureCount": len(river_segments), "riverSegmentCount": len(river_segments), "damCount": len(dam_features), "reservoirPolygonCount": 0, "hesStationCount": len(station_features), "lakeStationCount": 0, "cascadeEdgeCount": len(cascade_edges), "unresolvedCascadeCount": len(unresolved_cascades), "catchmentCount": sum(bool(feature["properties"].get("catchmentUrl")) for feature in hes_features), "generatedBy": "tools/build_hes177.py"}
    write("hes_177_manifest.json", manifest)
    print(json.dumps({"hes": len(hes_features), "coordinates": coordinate_count, "verified": verified, "transformer": transformer, "unresolved": len(hes_features) - coordinate_count, "basins": len(relevant_basins), "rivers": len(river_features), "dams": len(dam_features), "stations": len(station_features), "cascadeEdges": len(cascade_edges), "catchments": manifest["catchmentCount"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()

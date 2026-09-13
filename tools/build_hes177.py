"""Build the browser-sized 177 HES data package from the supplied workbook.

The workbook is intentionally read with the Python standard library so this
preprocessing step is reproducible on a clean checkout. Existing TATUS files
are used only as supporting geometry and controlled relationship evidence.
"""

from __future__ import annotations

import json
import math
import re
import zipfile
from collections import defaultdict, deque
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "docs" / "HES_177_Zenginlestirilmis_Envanter.xlsx"
TATUS = ROOT / "public" / "data" / "static" / "tatus"
OUT = ROOT / "public" / "data" / "hes177"
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


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
    text = str(value or "").upper().translate(str.maketrans("ÇĞİÖŞÜ", "CGIOSU"))
    text = re.sub(r"\b(BARAJI|BARAJ|BRJ|HES|SANTRALI|SANTRAL|VE|I|II|III|IV)\b", " ", text)
    return re.sub(r"[^A-Z0-9]+", " ", text).strip()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def read_workbook_rows() -> list[dict[str, Any]]:
    with zipfile.ZipFile(WORKBOOK) as archive:
        shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        shared = ["".join(node.text or "" for node in item.iter(NS + "t")) for item in shared_root.findall(NS + "si")]
        sheet_root = ET.fromstring(archive.read("xl/worksheets/sheet2.xml"))
        rows: list[list[Any]] = []
        for row in sheet_root.find(NS + "sheetData").findall(NS + "row"):
            values: list[Any] = []
            for cell in row.findall(NS + "c"):
                value = cell.find(NS + "v")
                raw = "" if value is None else value.text
                values.append(shared[int(raw)] if cell.get("t") == "s" and raw else raw)
            rows.append(values)
    headers = rows[2]
    return [{headers[index]: clean(value) for index, value in enumerate(row)} for row in rows[3:]]


def feature_id(feature: dict[str, Any]) -> str:
    properties = feature.get("properties") or {}
    return str(properties.get("id") or properties.get("entityId") or feature.get("id") or "")


def basin_id(feature: dict[str, Any]) -> str:
    properties = feature.get("properties") or {}
    return str(properties.get("basinId") or properties.get("HAVZA_ID") or properties.get("ID") or "")


def coordinates(feature: dict[str, Any]) -> tuple[float, float] | None:
    geometry = feature.get("geometry") or {}
    if geometry.get("type") != "Point" or len(geometry.get("coordinates", [])) < 2:
        return None
    return float(geometry["coordinates"][0]), float(geometry["coordinates"][1])


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = map(math.radians, a)
    lon2, lat2 = map(math.radians, b)
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def positions(geometry: dict[str, Any]) -> list[tuple[float, float]]:
    kind = geometry.get("type")
    coords = geometry.get("coordinates")
    if kind == "Point":
        return [tuple(coords)]
    if kind in {"LineString", "MultiPoint"}:
        return [tuple(item) for item in coords]
    if kind in {"MultiLineString", "Polygon"}:
        return [tuple(item) for group in coords for item in group]
    if kind == "MultiPolygon":
        return [tuple(item) for polygon in coords for group in polygon for item in group]
    return []


def centroid(feature: dict[str, Any]) -> tuple[float, float] | None:
    points = positions(feature.get("geometry") or {})
    if not points:
        return None
    return sum(point[0] for point in points) / len(points), sum(point[1] for point in points) / len(points)


def canonical_river(value: Any) -> str | None:
    text = normalize(value)
    for token, name in (
        ("FIRAT", "Fırat"),
        ("DICLE", "Dicle"),
        ("KIZILIRMAK", "Kızılırmak"),
        ("SAKARYA", "Sakarya"),
        ("YESILIRMAK", "Yeşilırmak"),
        ("CORUH", "Çoruh"),
        ("SEYHAN", "Seyhan"),
        ("CEYHAN", "Ceyhan"),
        ("BUYUK MENDERES", "Büyük Menderes"),
        ("GEDIZ", "Gediz"),
    ):
        if token in text:
            return name
    return None


KNOWN_HES_RIVERS = {
    "FIRAT": {"ATATURK", "BIRECIK NIZIP", "KARKAMIS", "KARAKAYA", "KEBAN", "BAGISTAS1", "BAGISTAS2", "TERCAN", "YUKARI KALEKOY", "ASAGI KALEKOY", "BEYHAN1", "TATAR", "UZUNCAYIR", "KIGI"},
    "DICLE": {"ILISU", "DICLE", "KRALKIZI", "BATMAN", "GARZAN", "SIRNAK", "SILOPI", "SIRVAN", "ALKUMRU", "CIZRE"},
}


def display_river_code(properties: dict[str, Any]) -> str:
    return str(properties.get("riverCode") or properties.get("nehir_kod") or properties.get("id") or "")


def best_name_match(value: Any, candidates: list[tuple[str, str]]) -> tuple[str, float] | None:
    needle = normalize(value)
    if not needle:
        return None
    exact = [identifier for identifier, name in candidates if normalize(name) == needle]
    if exact:
        return exact[0], 1.0
    best: tuple[str, float] | None = None
    for identifier, name in candidates:
        candidate = normalize(name)
        if not candidate:
            continue
        score = SequenceMatcher(None, needle, candidate).ratio()
        if needle in candidate or candidate in needle:
            score = max(score, 0.9)
        if best is None or score > best[1]:
            best = (identifier, score)
    return best if best and best[1] >= 0.88 else None


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    workbook_rows = read_workbook_rows()
    dams_source = read_json(TATUS / "dam_stations.geojson")
    rivers_source = read_json(TATUS / "rivers_overview.geojson")
    basins_source = read_json(TATUS / "basins.geojson")
    stations_source = read_json(TATUS / "hes_stations.geojson")

    basin_ids = {str(row["Havza ID"]) for row in workbook_rows if row.get("Havza ID")}
    basin_by_id = {basin_id(feature): feature for feature in basins_source["features"]}
    relevant_basins = [
        {**feature, "properties": {**(feature.get("properties") or {}), "hes177": True}}
        for identifier, feature in basin_by_id.items() if identifier in basin_ids
    ]

    dam_candidates: list[tuple[str, str, str]] = []
    for feature in dams_source["features"]:
        props = feature.get("properties") or {}
        dam_candidates.append((feature_id(feature), str(props.get("name") or props.get("damName") or props.get("BarajAdi") or ""), basin_id(feature)))

    major_station_points: dict[str, list[tuple[float, float]]] = defaultdict(list)
    major_station_records: list[tuple[str, str, tuple[float, float]]] = []
    station_features: list[dict[str, Any]] = []
    for feature in stations_source["features"]:
        props = feature.get("properties") or {}
        river_name = canonical_river(props.get("SuAdi"))
        point = coordinates(feature)
        if river_name and point:
            major_station_points[river_name].append(point)
            major_station_records.append((basin_id(feature), river_name, point))
            station_features.append({
                "type": "Feature", "geometry": feature["geometry"],
                "properties": {"id": feature_id(feature), "entityId": feature_id(feature), "name": props.get("name") or props.get("IstAdi"), "IstAdi": props.get("IstAdi"), "SuAdi": props.get("SuAdi"), "basinId": basin_id(feature), "riverName": river_name, "entityType": "hesRiverAnchors"},
            })

    # First build the authoritative 177 records and a controlled dam mapping.
    hes_features: list[dict[str, Any]] = []
    dam_links: dict[str, list[str]] = defaultdict(list)
    rows_by_name: dict[str, dict[str, Any]] = {}
    for row in workbook_rows:
        sequence = int(float(row["Sıra"]))
        hes_id = f"hes177-{sequence:03d}"
        name = str(row["HES"])
        rows_by_name[normalize(name)] = row
        lon, lat = number(row.get("Boylam")), number(row.get("Enlem"))
        point = [lon, lat] if lon is not None and lat is not None and -180 <= lon <= 180 and -90 <= lat <= 90 else None
        dam_match = best_name_match(row.get("Baraj / Rezervuar Eşleşmesi") or name, [(identifier, dam_name) for identifier, dam_name, dam_basin in dam_candidates if dam_basin == str(row.get("Havza ID") or "")])
        dam_id = dam_match[0] if dam_match and dam_match[1] >= 0.88 else None
        if dam_id:
            dam_links[dam_id].append(hes_id)
        properties = {
            "id": hes_id, "entityId": hes_id, "entityType": "hes177", "name": name,
            "inventoryOrder": sequence, "basinId": str(row.get("Havza ID") or ""), "basinName": row.get("Havza (TATUS)") or row.get("Havza (Kaynak)"),
            "province": row.get("Bulunduğu İl"), "damName": row.get("Baraj / Rezervuar Eşleşmesi"),
            "installedPowerMw": number(row.get("Kurulu Güç (MW)")), "unitFlowM3s": number(row.get("Ünite Debisi (m³/sn)")),
            "maxWaterLevelM": number(row.get("Maksimum Su Seviyesi (m)")), "minWaterLevelM": number(row.get("Minimum Su Seviyesi (m)")),
            "maxVolumeHm3": number(row.get("Maksimum Hacim (hm³)")), "minVolumeHm3": number(row.get("Minimum Hacim (hm³)")),
            "activeVolumeHm3": number(row.get("Aktif Hacim (hm³)")), "waterEnergyMwh": number(row.get("Suyun Enerji Karşılığı (MWh)")),
            "epiasDate": row.get("EPİAŞ Veri Tarihi"), "dataQuality": row.get("Veri Kalitesi"), "sourceMatchMethod": row.get("Eşleşme Yöntemi"),
            "cascadeName": row.get("Kaskat Santrali"), "cascadeSourceValue": row.get("Kaskat Kaynak Değeri"), "notes": row.get("Not"),
            "damMatchId": dam_id, "damMatchConfidence": "name" if dam_id else None,
        }
        hes_features.append({"type": "Feature", "id": hes_id, "geometry": {"type": "Point", "coordinates": point} if point else None, "properties": properties})

    # Infer only controlled river groups. Basin-only inference is retained as
    # low confidence metadata and is not presented as a cascade relationship.
    river_by_hes: dict[str, dict[str, Any]] = {}
    basin_primary = {"12": "Sakarya", "13": "Kızılırmak", "14": "Yeşilırmak", "15": "Kızılırmak", "18": "Seyhan", "20": "Ceyhan", "22": "Doğu Karadeniz", "23": "Çoruh", "7": "Büyük Menderes", "5": "Gediz"}
    for feature in hes_features:
        props = feature["properties"]
        name = str(props["name"])
        controlled_name = normalize(name)
        river_name = None
        if props["basinId"] == "21":
            for river_key, names in KNOWN_HES_RIVERS.items():
                if any(token in controlled_name for token in names):
                    river_name = "Fırat" if river_key == "FIRAT" else "Dicle"
                    break
        river_name = river_name or canonical_river(name) or canonical_river(props.get("damName"))
        method, confidence = "unmatched", "low"
        if river_name:
            method, confidence = "name", "high"
        elif props["basinId"] in basin_primary:
            river_name, method, confidence = basin_primary[props["basinId"]], "basin", "medium"
        elif feature["geometry"]:
            point = tuple(feature["geometry"]["coordinates"])
            nearest: tuple[str, float] | None = None
            for station_basin, candidate, anchor in major_station_records:
                if station_basin != props["basinId"]:
                    continue
                distance = haversine(point, anchor)
                if nearest is None or distance < nearest[1]:
                    nearest = (candidate, distance)
            if nearest and nearest[1] <= 35:
                river_name, method, confidence = nearest[0], "spatial", "medium"
        if river_name:
            river_by_hes[props["id"]] = {"riverName": river_name, "riverGroup": river_name, "riverMatchMethod": method, "riverConfidence": confidence}

    # Cascade links are only made to another workbook record. Numeric/sentinel
    # values and unresolved names remain explicitly unresolved in the manifest.
    hes_by_normalized_name = {normalize(feature["properties"]["name"]): feature for feature in hes_features}
    cascade_edges: list[dict[str, Any]] = []
    unresolved_cascades: list[dict[str, Any]] = []
    downstream: dict[str, set[str]] = defaultdict(set)
    upstream: dict[str, set[str]] = defaultdict(set)
    for feature in hes_features:
        props = feature["properties"]
        raw = props.get("cascadeName")
        if not raw or re.fullmatch(r"[0-9.]+", str(raw).strip()):
            continue
        target = hes_by_normalized_name.get(normalize(raw))
        if not target:
            match = best_name_match(raw, [(key, item["properties"]["name"]) for key, item in hes_by_normalized_name.items()])
            target = hes_by_normalized_name.get(match[0]) if match else None
        if not target or target["properties"]["id"] == props["id"]:
            unresolved_cascades.append({"hesId": props["id"], "value": raw})
            continue
        source_id, target_id = props["id"], target["properties"]["id"]
        cascade_edges.append({"fromId": source_id, "toId": target_id, "fromName": props["name"], "toName": target["properties"]["name"]})
        downstream[source_id].add(target_id)
        upstream[target_id].add(source_id)

    # Break accidental cycles deterministically before exposing graph metadata.
    valid_edges: list[dict[str, Any]] = []
    for edge in cascade_edges:
        source, target = edge["fromId"], edge["toId"]
        reachable = deque([target]); seen = {target}
        while reachable:
            current = reachable.popleft()
            for child in downstream[current]:
                if child not in seen:
                    seen.add(child); reachable.append(child)
        if source in seen:
            downstream[source].discard(target); upstream[target].discard(source); unresolved_cascades.append({"hesId": source, "value": target, "reason": "cycle"})
        else:
            valid_edges.append(edge)
    cascade_edges = valid_edges

    # Cascade-connected nodes inherit a named river only when the source or
    # target already has controlled evidence; this is never used for unrelated
    # same-basin facilities.
    changed = True
    while changed:
        changed = False
        for edge in cascade_edges:
            source, target = edge["fromId"], edge["toId"]
            if source in river_by_hes and target not in river_by_hes:
                river_by_hes[target] = {**river_by_hes[source], "riverMatchMethod": "cascade", "riverConfidence": "medium"}; changed = True
            elif target in river_by_hes and source not in river_by_hes:
                river_by_hes[source] = {**river_by_hes[target], "riverMatchMethod": "cascade", "riverConfidence": "medium"}; changed = True

    # Components and order are stable and useful to the UI.
    graph_nodes = {feature["properties"]["id"] for feature in hes_features}
    visited: set[str] = set(); chain_by_node: dict[str, tuple[str, int]] = {}
    for root in sorted(graph_nodes):
        if root in visited or (upstream[root] and any(parent not in visited for parent in upstream[root])):
            continue
        chain = f"cascade-{len({item[0] for item in chain_by_node.values()}) + 1:03d}"
        queue = deque([(root, 1)]); visited.add(root)
        while queue:
            node, order = queue.popleft(); chain_by_node[node] = (chain, order)
            for child in sorted(downstream[node]):
                if child not in visited: visited.add(child); queue.append((child, order + 1))
    for node in sorted(graph_nodes - visited):
        chain_by_node[node] = (None, None)  # type: ignore[assignment]

    relation_by_hes: dict[str, Any] = {}
    for feature in hes_features:
        props = feature["properties"]; node = props["id"]; river = river_by_hes.get(node, {})
        chain, order = chain_by_node.get(node, (None, None))
        relation_by_hes[node] = {**river, "damId": props.get("damMatchId"), "cascadeToId": next(iter(sorted(downstream[node])), None), "cascadeFromIds": sorted(upstream[node]), "cascadeChainId": chain, "cascadeOrder": order}
        props.update({"riverName": river.get("riverName"), "riverGroup": river.get("riverGroup"), "riverMatchMethod": river.get("riverMatchMethod"), "riverConfidence": river.get("riverConfidence"), "cascadeToId": relation_by_hes[node]["cascadeToId"], "cascadeFromIds": relation_by_hes[node]["cascadeFromIds"], "cascadeChainId": chain, "cascadeOrder": order, "isProducer": True})

    # Filter overview lines to HES basins, resolve named groups spatially where
    # TATUS anchors permit it, and retain unknowns as technical code labels.
    river_features: list[dict[str, Any]] = []
    group_members: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for source_feature in rivers_source["features"]:
        if basin_id(source_feature) not in basin_ids:
            continue
        props = source_feature.get("properties") or {}
        rid = feature_id(source_feature)
        center = centroid(source_feature)
        known = canonical_river(props.get("name") or props.get("adi"))
        if not known and center:
            segment_basin = basin_id(source_feature)
            nearest = min(((name, min((haversine(center, anchor) for station_basin, candidate, anchor in major_station_records if station_basin == segment_basin and candidate == name), default=99999)) for name in major_station_points), key=lambda item: item[1], default=(None, 99999))
            if nearest[0] and nearest[1] <= 42:
                known = nearest[0]
        code = display_river_code(props)
        river_name = known or f"Adsız akarsu · {code}"
        length = number(props.get("lengthKm")) or (number(props.get("uzunluk")) or 0) / 1000
        feature = {"type": "Feature", "id": f"river177-{rid}", "geometry": source_feature.get("geometry"), "properties": {**props, "id": f"river177-{rid}", "entityId": f"river177-{rid}", "entityType": "rivers", "name": river_name, "riverName": known, "riverCode": code, "lengthKm": length, "riverGroup": known, "isMajor": bool(known), "hes177": True}}
        river_features.append(feature)
        if known:
            group_members[known].append(feature)

    for group_name, members in group_members.items():
        if not members:
            continue
        geometry = {"type": "MultiLineString", "coordinates": [feature["geometry"]["coordinates"] for feature in members if feature.get("geometry", {}).get("type") == "LineString"]}
        if not geometry["coordinates"]:
            continue
        group_id = f"river-group-{normalize(group_name).lower().replace(' ', '-') }"
        group_basin = next((feature["properties"].get("basinId") for feature in members), None)
        station_ids = [feature["properties"]["id"] for feature in station_features if feature["properties"].get("riverName") == group_name and str(feature["properties"].get("basinId")) == str(group_basin)]
        river_features.append({"type": "Feature", "id": group_id, "geometry": geometry, "properties": {"id": group_id, "entityId": group_id, "entityType": "riverGroup", "name": group_name, "riverName": group_name, "riverGroup": group_name, "basinId": group_basin, "memberIds": [feature["properties"]["id"] for feature in members], "majorStationIds": station_ids, "lengthKm": sum(feature["properties"].get("lengthKm", 0) for feature in members), "isMajor": True, "hes177": True}})

    dam_features: list[dict[str, Any]] = []
    for source_feature in dams_source["features"]:
        identifier = feature_id(source_feature)
        if identifier not in dam_links:
            continue
        props = source_feature.get("properties") or {}
        linked_river = next((relation_by_hes.get(hes_id, {}).get("riverName") for hes_id in dam_links[identifier] if relation_by_hes.get(hes_id, {}).get("riverName")), None)
        dam_features.append({**source_feature, "properties": {**props, "id": f"dam177-{identifier}", "sourceId": identifier, "entityId": f"dam177-{identifier}", "entityType": "dams", "riverName": linked_river, "hes177": True, "linkedHesIds": dam_links[identifier], "isProducer": True}})
    linked_dam_ids = {item for values in dam_links.values() for item in values}
    for feature in hes_features:
        props = feature["properties"]
        if not feature.get("geometry") or not props.get("damName") or props["id"] in linked_dam_ids:
            continue
        source_id = f"inventory-{props['id']}"
        dam_features.append({"type": "Feature", "id": f"dam177-{source_id}", "geometry": feature["geometry"], "properties": {"id": f"dam177-{source_id}", "sourceId": source_id, "entityId": f"dam177-{source_id}", "entityType": "dams", "name": props["damName"], "damName": props["damName"], "riverName": relation_by_hes.get(props["id"], {}).get("riverName"), "basinId": props["basinId"], "basinName": props["basinName"], "hes177": True, "linkedHesIds": [props["id"]], "isProducer": True, "damMatchMethod": "inventory-coordinate"}})
    known_dam_names = {normalize(feature["properties"].get("name")) for feature in dam_features}
    for station in station_features:
        station_props = station["properties"]
        station_name = station_props.get("IstAdi") or station_props.get("name")
        if not station_name or not re.search(r"HES|BRJ|BARAJ|KEBAN|KARKAMIS|BAGISTAS|ILISU|ATATURK|KARAKAYA", normalize(station_name)):
            continue
        if normalize(station_name) in known_dam_names:
            continue
        matched_hes = best_name_match(station_name, [(feature["properties"]["id"], feature["properties"]["name"]) for feature in hes_features if feature["properties"].get("basinId") == station_props.get("basinId")])
        linked = [matched_hes[0]] if matched_hes else []
        dam_features.append({"type": "Feature", "id": f"dam177-anchor-{station_props['id']}", "geometry": station["geometry"], "properties": {"id": f"dam177-anchor-{station_props['id']}", "sourceId": f"anchor-{station_props['id']}", "entityId": f"dam177-anchor-{station_props['id']}", "entityType": "dams", "name": station_name, "damName": station_name, "riverName": station_props.get("riverName"), "basinId": station_props.get("basinId"), "hes177": True, "linkedHesIds": linked, "isProducer": True, "damMatchMethod": "tatus-anchor"}})

    cascade_geojson = {"type": "FeatureCollection", "features": []}
    for edge in cascade_edges:
        source = next((f for f in hes_features if f["properties"]["id"] == edge["fromId"]), None)
        target = next((f for f in hes_features if f["properties"]["id"] == edge["toId"]), None)
        if source and target and source.get("geometry") and target.get("geometry"):
            cascade_geojson["features"].append({"type": "Feature", "id": f"cascade-{edge['fromId']}-{edge['toId']}", "geometry": {"type": "LineString", "coordinates": [source["geometry"]["coordinates"], target["geometry"]["coordinates"]]}, "properties": {**edge, "entityType": "cascade"}})

    summaries: list[dict[str, Any]] = []
    for basin in relevant_basins:
        bid = basin_id(basin); basin_props = basin.get("properties") or {}; hes_in_basin = [f for f in hes_features if f["properties"].get("basinId") == bid]
        rivers_in_basin = [f for f in river_features if f["properties"].get("basinId") == bid and f["properties"].get("entityType") == "rivers"]
        main_names = sorted({str(f["properties"]["riverName"]) for f in rivers_in_basin if f["properties"].get("riverName")})
        summaries.append({"basinId": bid, "name": basin_props.get("name") or basin_props.get("HAVZA_ADI"), "areaKm2": number(basin_props.get("areaKm2") or basin_props.get("ALAN_KM2")), "hesCount": len(hes_in_basin), "installedPowerMw": sum(f["properties"].get("installedPowerMw") or 0 for f in hes_in_basin), "damCount": sum(1 for f in dam_features if f["properties"].get("basinId") == bid), "riverCount": len(rivers_in_basin), "riverLengthKm": sum(f["properties"].get("lengthKm") or 0 for f in rivers_in_basin), "mainRiverNames": main_names})

    def write(name: str, data: Any) -> None:
        (OUT / name).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    write("hes_177.geojson", {"type": "FeatureCollection", "features": hes_features})
    write("hes_rivers.geojson", {"type": "FeatureCollection", "features": river_features})
    write("hes_basins.geojson", {"type": "FeatureCollection", "features": relevant_basins})
    write("hes_dams.geojson", {"type": "FeatureCollection", "features": dam_features})
    write("hes_river_anchors.geojson", {"type": "FeatureCollection", "features": station_features})
    write("hes_cascades.geojson", cascade_geojson)
    write("hes_177_relations.json", {"byHesId": relation_by_hes, "cascadeEdges": cascade_edges, "unresolvedCascades": unresolved_cascades, "basinSummaries": summaries, "damLinks": dam_links, "riverGroups": {name: [f["properties"]["id"] for f in members] for name, members in group_members.items()}})
    write("hes_177_manifest.json", {"version": 1, "source": str(WORKBOOK.relative_to(ROOT)).replace("\\", "/"), "hesCount": len(hes_features), "coordinateCount": sum(bool(feature.get("geometry")) for feature in hes_features), "basinCount": len(relevant_basins), "riverFeatureCount": len(river_features), "riverSegmentCount": sum(feature["properties"].get("entityType") == "rivers" for feature in river_features), "damCount": len(dam_features), "cascadeEdgeCount": len(cascade_edges), "unresolvedCascadeCount": len(unresolved_cascades), "riverMatchedHesCount": len(river_by_hes), "generatedBy": "tools/build_hes177.py"})

    print(json.dumps({"hes": len(hes_features), "coordinates": sum(bool(feature.get("geometry")) for feature in hes_features), "basins": len(relevant_basins), "rivers": len(river_features), "dams": len(dam_features), "cascadeEdges": len(cascade_edges), "unresolvedCascades": len(unresolved_cascades), "riverMatchedHes": len(river_by_hes)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

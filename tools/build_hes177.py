"""Build the browser-sized HES v3 GIS package.

The workbook is parsed by worksheet name and cell address.  TATUS queries are
used as build-time evidence; the browser receives only the focused HES package.
"""

from __future__ import annotations

import json
import heapq
import math
import re
import urllib.request
import unicodedata
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
RIVER_REACH_MAPPING = ROOT / "public" / "data" / "static" / "mappings" / "river_reach_map.json"
MIN_INSTALLED_POWER_MW = 20.0
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


def fullness_from_active_volume(properties: dict[str, Any]) -> float | None:
    active = number(properties.get("activeVolumeHm3"))
    minimum = number(properties.get("minVolumeHm3"))
    maximum = number(properties.get("maxVolumeHm3"))
    if active is None or minimum is None or maximum is None or maximum <= minimum:
        return None
    # Workbook field is explicitly "Aktif Hacim". It is an active-storage
    # amount, not a current absolute reservoir volume, so it uses the active
    # storage range directly. Current-volume feeds use a different formula at
    # runtime (current - min) / (max - min).
    return max(0, min(100, (active / (maximum - minimum)) * 100))


def normalize(value: Any) -> str:
    """Normalize names without deleting I/II/III/IV facility suffixes."""
    text = str(value or "").upper().translate(str.maketrans({"Ç": "C", "Ğ": "G", "İ": "I", "I": "I", "Ö": "O", "Ş": "S", "Ü": "U", "Â": "A", "Î": "I", "Û": "U", "Ý": "I", "Ã": "A", "Ä": "A", "Å": "S"}))
    text = "".join(character for character in unicodedata.normalize("NFKD", text) if not unicodedata.combining(character))
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


def point_in_ring(point: tuple[float, float], ring: list[Any]) -> bool:
    """Return whether a lon/lat point is inside a polygon ring."""
    if len(ring) < 3:
        return False
    x, y = point
    inside = False
    previous = ring[-1]
    for current in ring:
        try:
            x1, y1 = float(previous[0]), float(previous[1])
            x2, y2 = float(current[0]), float(current[1])
        except (TypeError, ValueError, IndexError):
            previous = current
            continue
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
            inside = not inside
        previous = current
    return inside


def point_in_basin(point: tuple[float, float], feature: dict[str, Any]) -> bool:
    geometry = feature.get("geometry") or {}
    coordinates = geometry.get("coordinates") or []
    polygons = [coordinates] if geometry.get("type") == "Polygon" else coordinates if geometry.get("type") == "MultiPolygon" else []
    for polygon in polygons:
        if polygon and point_in_ring(point, polygon[0]) and not any(point_in_ring(point, hole) for hole in polygon[1:]):
            return True
    return False


def basin_for_point(point: tuple[float, float] | None, basins: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not point:
        return None
    return next((feature for feature in basins if point_in_basin(point, feature)), None)


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = map(math.radians, a)
    lon2, lat2 = map(math.radians, b)
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def line_distance_km(point: tuple[float, float] | None, geometry: dict[str, Any] | None) -> float:
    if not point:
        return float("inf")
    return min((haversine(point, (float(coordinate[0]), float(coordinate[1]))) for coordinate in geometry_points(geometry)), default=float("inf"))


def line_length_km(part: list[Any]) -> float:
    return sum(haversine(tuple(left), tuple(right)) for left, right in zip(part, part[1:]))


def unique_line_parts(*collections: list[list[Any]]) -> list[list[Any]]:
    """Preserve source order while removing identical coordinate sequences."""
    seen: set[str] = set()
    result: list[list[Any]] = []
    for collection in collections:
        for part in collection:
            key = json.dumps(part, separators=(",", ":"))
            if len(part) > 1 and key not in seen:
                seen.add(key)
                result.append(part)
    return result


def connected_line_components(parts: list[list[Any]], threshold_km: float = 8) -> list[list[list[Any]]]:
    """Group line parts by nearby endpoints without joining distant systems."""
    valid_parts = [part for part in parts if len(part) > 1]
    if not valid_parts:
        return []
    parent = list(range(len(valid_parts)))

    def root(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def join(left: int, right: int) -> None:
        left_root, right_root = root(left), root(right)
        if left_root != right_root:
            parent[right_root] = left_root

    # Spatial buckets avoid an O(n²) pair scan for the dense Kızılırmak source
    # network while retaining a final geographic-distance check.
    degree = threshold_km / 100
    buckets: dict[tuple[int, int], list[tuple[int, tuple[float, float]]]] = defaultdict(list)
    for index, part in enumerate(valid_parts):
        for endpoint in (tuple(part[0]), tuple(part[-1])):
            cell = (math.floor(endpoint[0] / degree), math.floor(endpoint[1] / degree))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for other_index, other_endpoint in buckets.get((cell[0] + dx, cell[1] + dy), []):
                        if other_index != index and haversine(endpoint, other_endpoint) <= threshold_km:
                            join(index, other_index)
            buckets[cell].append((index, endpoint))
    groups: dict[int, list[list[Any]]] = defaultdict(list)
    for index, part in enumerate(valid_parts):
        groups[root(index)].append(part)
    return list(groups.values())


def disconnected_components(parts: list[list[Any]], threshold_km: float = 8) -> int:
    return len(connected_line_components(parts, threshold_km))


def canonical_source_river_name(value: Any) -> str:
    normalized = normalize(value)
    aliases = {"FERAT": "FIRAT", "BUYUKMENDERES": "BUYUK MENDERES"}
    return aliases.get(normalized, normalized)


def hes_supported_corridors(parts: list[list[Any]], anchors: list[tuple[tuple[float, float], float]], support_distance_km: float = 25) -> tuple[list[list[Any]], int, int, int]:
    """Keep HES-proximal corridors and expose, rather than conceal, topology gaps."""
    candidate_groups = connected_line_components(parts)
    if not candidate_groups:
        return [], 0, 0, 0

    if not anchors:
        return parts, len(candidate_groups), len(candidate_groups), 0

    # Selecting every segment of a country-long connected network because one
    # HES touches it turns a logical river into technical segment spam. Retain
    # only pieces in the facility corridor, then report their actual component
    # count; no zero-disconnect metric is manufactured by picking a winner.
    selected = [part for part in parts if any(line_distance_km(point, {"type": "LineString", "coordinates": part}) <= support_distance_km for point, _ in anchors)]
    represented_components = len(connected_line_components(selected))
    return selected, len(candidate_groups), represented_components, len(parts) - len(selected)


def nearest_hes_corridors(parts: list[list[Any]], anchors: list[tuple[tuple[float, float], float]], limit_per_hes: int = 4, max_distance_km: float = 30) -> tuple[list[list[Any]], int, int, int]:
    """Use a small named-reach neighbourhood for each HES, not an entire network component."""
    candidate_groups = connected_line_components(parts)
    if not candidate_groups:
        return [], 0, 0, 0
    selected_indices: set[int] = set()
    for point, _ in anchors:
        ranked = sorted(((line_distance_km(point, {"type": "LineString", "coordinates": part}), index) for index, part in enumerate(parts)), key=lambda item: item[0])
        selected_indices.update(index for distance, index in ranked[:limit_per_hes] if distance <= max_distance_km)
    selected = [part for index, part in enumerate(parts) if index in selected_indices]
    represented_components = len(connected_line_components(selected))
    return selected, len(candidate_groups), represented_components, len(parts) - len(selected)


def network_route_parts(parts: list[list[Any]], anchors: list[tuple[tuple[float, float], float]], snap_km: float = 3) -> tuple[list[list[Any]], int]:
    """Connect HES anchors only across the selected source line network."""
    valid_parts = [part for part in parts if len(part) > 1]
    if len(valid_parts) < 2 or len(anchors) < 2:
        return [], 0

    node_points: list[tuple[float, float]] = []
    node_buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
    part_nodes: list[tuple[int, int]] = []
    bucket_size = max(snap_km / 100, 0.01)
    for part in valid_parts:
        endpoints = [tuple(part[0]), tuple(part[-1])]
        endpoint_nodes: list[int] = []
        for endpoint in endpoints:
            cell = (math.floor(endpoint[0] / bucket_size), math.floor(endpoint[1] / bucket_size))
            nearby_nodes = [candidate for dx in (-1, 0, 1) for dy in (-1, 0, 1) for candidate in node_buckets.get((cell[0] + dx, cell[1] + dy), [])]
            node = next((index for index in nearby_nodes if haversine(endpoint, node_points[index]) <= snap_km), None)
            if node is None:
                node = len(node_points)
                node_points.append(endpoint)
                node_buckets[cell].append(node)
            endpoint_nodes.append(node)
        part_nodes.append((endpoint_nodes[0], endpoint_nodes[1]))

    adjacency: dict[int, list[tuple[int, float, int]]] = defaultdict(list)
    for part_index, (left, right) in enumerate(part_nodes):
        weight = line_length_km(valid_parts[part_index])
        adjacency[left].append((right, weight, part_index))
        adjacency[right].append((left, weight, part_index))

    anchor_nodes = [min(range(len(node_points)), key=lambda index: haversine(point, node_points[index])) for point, _ in anchors]

    def shortest_paths(start: int) -> tuple[dict[int, float], dict[int, tuple[int, int]]]:
        distances = {start: 0.0}
        previous: dict[int, tuple[int, int]] = {}
        queue: list[tuple[float, int]] = [(0.0, start)]
        while queue:
            distance, node = heapq.heappop(queue)
            if distance != distances.get(node):
                continue
            for neighbour, weight, part_index in adjacency.get(node, []):
                candidate = distance + weight
                if candidate < distances.get(neighbour, float("inf")):
                    distances[neighbour] = candidate
                    previous[neighbour] = (node, part_index)
                    heapq.heappush(queue, (candidate, neighbour))
        return distances, previous

    def path_from(previous: dict[int, tuple[int, int]], start: int, target: int) -> list[int] | None:
        if target not in previous and target != start:
            return None
        path: list[int] = []
        node = target
        while node != start:
            node, part_index = previous[node]
            path.append(part_index)
        return path

    connected = {0}
    selected_indices: set[int] = set()
    remaining = set(range(1, len(anchor_nodes)))
    while remaining and connected:
        best: tuple[float, int, list[int]] | None = None
        for source_index in connected:
            distances, previous = shortest_paths(anchor_nodes[source_index])
            for target_index in remaining:
                route_parts = path_from(previous, anchor_nodes[source_index], anchor_nodes[target_index])
                if route_parts is not None and (best is None or distances[anchor_nodes[target_index]] < best[0]):
                    best = (distances[anchor_nodes[target_index]], target_index, route_parts)
        if best is None:
            break
        _, target_index, route_parts = best
        selected_indices.update(route_parts)
        connected.add(target_index)
        remaining.remove(target_index)

    routed = [valid_parts[index] for index in sorted(selected_indices)]
    return routed, len(connected)


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


def geometry_line_parts(geometry: dict[str, Any] | None) -> list[list[Any]]:
    geometry = geometry or {}
    if geometry.get("type") == "LineString":
        coordinates = geometry.get("coordinates", [])
        return [coordinates] if len(coordinates) > 1 else []
    if geometry.get("type") == "MultiLineString":
        return [part for part in geometry.get("coordinates", []) if len(part) > 1]
    return []


def feature_points(payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    return [feature for feature in (payload or {}).get("features", []) if point_of(feature)]


KNOWN_RIVER_HES = {
    "Araç": {"ARAC"},
    "Fırat": {"ATATURK", "BIRECIK NIZIP", "KARKAMIS", "KARAKAYA", "KARAKAYA DIYARBAKIR", "KEBAN", "BAGISTAS1", "BAGISTAS2", "TERCAN", "YUKARI KALEKOY", "ASAGI KALEKOY", "BEYHAN1", "TATAR", "UZUNCAYIR", "KIGI", "OZLUCE", "PEMBELIK", "SEYRANTEPE", "MURSAL", "ALPASLAN1", "ALPASLAN2"},
    "Dicle": {"ILISU", "DICLE", "KRALKIZI", "BATMAN", "GARZAN", "SIRNAK", "SILOPI", "SIRVAN", "ALKUMRU", "CIZRE", "ULUDERE", "BALLI", "MUSATEPE", "KIRAZLIK"},
    "Kızılırmak": {"KARGI KIZILIRMAK", "HIRFANLI", "KESIKKOPRU", "ALTINKAYA", "DERBENT", "OSMANCIK"},
    "Sakarya": {"GOYNUK", "YENICE", "GOKCEKAYA", "KARAKAYA SAKARYA"},
    "Yeşilırmak": {"KAVSAK", "ALMUS", "KILICKAYA", "ALTINKAYA YESILIRMAK"},
    "Çoruh": {"YUSUFELI", "DERINER", "BORCKA", "MURATLI", "ARKUN", "ARTVIN"},
    "Seyhan": {"CATALAN", "YEDIGOZE", "KILAVUZLU", "SEYHAN"},
    "Ceyhan": {"ATATURK CEYHAN", "MENZELET", "SIR", "KANDIL", "BERKE", "SUGOZU"},
    "Berdan": {"BERDAN"},
    "Dim": {"DIM"},
    "Manahoz": {"YUKARI MANAHOZ"},
}

RIVER_BASINS = {
    "FIRAT": {"21"}, "DICLE": {"21"}, "KIZILIRMAK": {"15"}, "SAKARYA": {"12"},
    "YESILIRMAK": {"14"}, "CORUH": {"23"}, "SEYHAN": {"18"}, "CEYHAN": {"20"},
    "BUYUK MENDERES": {"7"}, "GEDIZ": {"5"},
}

WATERBODY_WORDS = {"GOL", "GOLU", "GOLLER", "BARAJ", "REZERVUAR", "LAGUN", "LAGUNA", "SU ALANI"}


def is_waterbody_name(value: Any) -> bool:
    normalized = normalize(value)
    tokens = set(normalized.split())
    return bool(tokens & WATERBODY_WORDS) or any(token.startswith(("GOL", "BARAJ", "REZERVUAR", "LAGUN")) or token.endswith(("GOL", "GOLU", "GOLLER")) for token in tokens)

MAJOR_RIVER_NAMES = {"FIRAT", "DICLE", "KIZILIRMAK", "SAKARYA", "YESILIRMAK", "CORUH", "SEYHAN", "CEYHAN", "BUYUK MENDERES", "GEDIZ", "MURAT", "KARASU", "ARAS"}

BASIN_MAIN_RIVER = {"5": "Gediz", "7": "Büyük Menderes", "12": "Sakarya", "14": "Yeşilırmak", "15": "Kızılırmak", "18": "Seyhan", "20": "Ceyhan", "23": "Çoruh"}


def valid_river_name(value: Any, basin: Any) -> str | None:
    if not value:
        return None
    text = str(value).strip()
    normalized = normalize(text)
    if not normalized or normalized in {"BILINMIYOR", "UNKNOWN", "ADSIZ AKARSU"}:
        return None
    if is_waterbody_name(text):
        return None
    if normalized in RIVER_BASINS and str(basin) not in RIVER_BASINS[normalized]:
        return None
    return text


def known_river(*values: Any) -> str | None:
    facility = normalize(values[0] if values else "")
    for river, names in KNOWN_RIVER_HES.items():
        if facility in names:
            return river
    for value in values[1:]:
        candidate = str(value or "").strip()
        if normalize(candidate) in RIVER_BASINS:
            return candidate
    return None


def set_display_basin(properties: dict[str, Any]) -> None:
    """Keep official TATUS basin identity separate from the energy-facing river label."""
    official_id = str(properties.get("officialBasinId") or properties.get("basinId") or "")
    official_name = properties.get("officialBasinName") or properties.get("basinName")
    river = normalize(properties.get("riverName"))
    display_name = official_name
    display_id = official_id
    if official_id == "21" and river in {"FIRAT", "DICLE"}:
        display_name = "Fırat" if river == "FIRAT" else "Dicle"
        display_id = f"{official_id}-{river}"
    properties["displayBasinId"] = display_id
    properties["displayBasinName"] = display_name


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
    # The browser package is intentionally a 20 MW+ HES catalogue. Keep the
    # original workbook order/IDs, but remove sub-threshold plants before any
    # spatial, river, dam or cascade relation is built.
    rows = [row for row in read_workbook_rows() if (number(row.get("Kurulu Güç (MW)")) or 0) >= MIN_INSTALLED_POWER_MW]
    dams_source = read_json(TATUS / "dam_stations.geojson")
    basins_source = read_json(TATUS / "basins.geojson")
    stations_source = read_json(TATUS / "hes_stations.geojson")
    rivers_overview_source = read_json(TATUS / "rivers_overview.geojson")
    reach_mapping = read_json(RIVER_REACH_MAPPING).get("mappings", []) if RIVER_REACH_MAPPING.exists() else []
    reach_mapping_by_code = {str(item.get("riverCode")): item for item in reach_mapping if item.get("riverCode")}
    overview_lines = feature_lines(rivers_overview_source)
    basin_by_id = {basin_id(feature): feature for feature in basins_source.get("features", [])}

    river_urls = {str(row.get("Akarsu Polyline GeoJSON URL")) for row in rows if row.get("Akarsu Polyline GeoJSON URL")}
    dam_urls = {str(row.get("TATUS Baraj Point GeoJSON URL")) for row in rows if row.get("TATUS Baraj Point GeoJSON URL")}
    fetched_rivers, fetched_dams = fetch_unique(river_urls | dam_urls), fetch_unique(dam_urls)

    hes_features: list[dict[str, Any]] = []
    transformer_points: dict[str, tuple[float, float]] = {}
    for row in rows:
        sequence = int(float(row["Sıra"]))
        hes_id = f"hes177-{sequence:03d}"
        lon, lat = number(row.get("Boylam")), number(row.get("Enlem"))
        workbook_point = [lon, lat] if lon is not None and lat is not None and -180 <= lon <= 180 and -90 <= lat <= 90 else None
        geojson_point = first_point(row.get("HES Point GeoJSON"))
        status = str(row.get("Koordinat Durumu") or "")
        is_transformer = "trafo" in status.lower() or "transformer" in status.lower()
        hes_point = geojson_point or (workbook_point if not is_transformer else None)
        point = list(hes_point) if hes_point else None
        if geojson_point:
            coordinate_source, coordinate_kind = "hes-point-geojson", "verified"
        elif workbook_point and not is_transformer:
            coordinate_source, coordinate_kind = "workbook-hes-point", "verified"
        elif is_transformer and workbook_point:
            coordinate_source, coordinate_kind = "transformer", "transformer"
            transformer_points[hes_id] = (workbook_point[0], workbook_point[1])
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
            "riverNameSource": row.get("Akarsu Eşleme Durumu"), "riverCode": None, "riverQueryUrl": row.get("Akarsu Polyline GeoJSON URL"), "catchmentUrl": row.get("Su Toplama Alanı Polygon GeoJSON URL"), "waterBodyName": row.get("Baraj / Rezervuar Eşleşmesi"),
            "catchmentLabel": row.get("Su Toplama Alanı Popup"), "gisConfidence": row.get("GIS Güven"), "gisNote": row.get("GIS Notu"), "hasDamMatch": False,
        }
        properties["fullnessPercent"] = fullness_from_active_volume(properties)
        properties["fullnessSource"] = "H" if properties["fullnessPercent"] is not None else "—"
        properties["fullnessBasis"] = "active-volume/(max-volume-min-volume)" if properties["fullnessPercent"] is not None else None
        workbook_river_name = row.get("Akarsu / Nehir (Ön Eşleme)")
        if is_waterbody_name(workbook_river_name):
            properties["waterBodyName"] = workbook_river_name
            workbook_river_name = None
        properties["riverNameWorkbook"] = workbook_river_name
        properties["officialBasinId"] = properties["basinId"]
        properties["officialBasinName"] = properties["basinName"]
        properties["basinMatchMethod"] = "workbook-pending-spatial-validation"
        properties["basinConfidence"] = "medium"
        properties["basinSource"] = "workbook"
        properties["displayBasinId"] = properties["basinId"]
        properties["displayBasinName"] = properties["basinName"]
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
        comparison_point = point_of(hes) or transformer_points.get(props["id"])
        for candidate in candidates:
            candidate_props = candidate.get("properties") or {}
            candidate_name = candidate_props.get("BarajAdi") or candidate_props.get("damName") or candidate_props.get("name")
            candidate_point = point_of(candidate)
            exact = best_name(target_name, [("candidate", str(candidate_name or ""))])
            close = False
            if candidate_point and comparison_point:
                close = haversine(candidate_point, comparison_point) <= 40
            if exact and (comparison_point is None or close):
                chosen.append(candidate)
        if not chosen:
            fallback_point = point_of(hes) if props.get("coordinateKind") == "verified" else None
            if fallback_point and target_name:
                key = f"{basin}:{normalize(target_name)}"
                record = dam_records.setdefault(key, {"name": target_name, "basinId": basin, "basinName": props.get("basinName"), "points": [], "hesIds": [], "sourceIds": [], "coordinateSource": "verified-hes-point"})
                record["points"].append(fallback_point)
                if props["id"] not in record["hesIds"]:
                    record["hesIds"].append(props["id"])
                props["hasDamMatch"] = True
                props["damMatchMethod"] = "damName+verified-hes-point+basin"
                props["damMatchConfidence"] = "medium"
            continue
        points = [point_of(candidate) for candidate in chosen if point_of(candidate)]
        if not points:
            continue
        if not point_of(hes):
            center = (sum(point[0] for point in points) / len(points), sum(point[1] for point in points) / len(points))
            hes["geometry"] = {"type": "Point", "coordinates": list(center)}
            props["coordinateSource"], props["coordinateKind"], props["coordinateStatus"] = "tatus-dam-point", "dam", "TATUS doğrulanmış baraj noktası"
        key = f"{basin}:{normalize(target_name)}"
        average = [sum(point[0] for point in points) / len(points), sum(point[1] for point in points) / len(points)]
        record = dam_records.setdefault(key, {"name": target_name, "basinId": basin, "basinName": props.get("basinName"), "points": [], "hesIds": [], "sourceIds": [], "coordinateSource": "TATUS Layer 7"})
        record["points"].extend(points)
        if props["id"] not in record["hesIds"]: record["hesIds"].append(props["id"])
        for candidate in chosen:
            candidate_id = feature_id(candidate)
            if candidate_id and candidate_id not in record["sourceIds"]: record["sourceIds"].append(candidate_id)
        props["hasDamMatch"] = True
        props["damMatchMethod"] = "name+basin+near-coordinate"

    # Transformer coordinates remain only a last-resort map reference when no
    # HES or TATUS dam point was available.
    for hes in hes_features:
        props = hes["properties"]
        hes_id = props["id"]
        if not point_of(hes) and hes_id in transformer_points:
            hes["geometry"] = {"type": "Point", "coordinates": list(transformer_points[hes_id])}

    # Validate the official workbook basin against TATUS polygons. A
    # transformer-only point is retained as a low-confidence candidate and
    # never overrides the official basin identity.
    for hes in hes_features:
        props = hes["properties"]
        original_basin_id, original_basin_name = props.get("officialBasinId"), props.get("officialBasinName")
        source = props.get("coordinateSource")
        authoritative_point = point_of(hes) if source != "transformer" else None
        spatial = basin_for_point(authoritative_point, list(basin_by_id.values()))
        transformer_candidate = basin_for_point(point_of(hes), list(basin_by_id.values())) if source == "transformer" else None
        if spatial:
            spatial_props = spatial.get("properties") or {}
            props["basinId"] = basin_id(spatial)
            props["basinName"] = spatial_props.get("name") or spatial_props.get("HAVZA_ADI") or original_basin_name
            props["officialBasinId"], props["officialBasinName"] = props["basinId"], props["basinName"]
            props["basinMatchMethod"] = "hes-point-in-polygon" if source in {"hes-point-geojson", "workbook-hes-point"} else "dam-point-in-polygon"
            props["basinConfidence"] = "high"
            props["basinSource"] = "TATUS basins.geojson"
        else:
            props["basinMatchMethod"] = "workbook+transformer-candidate" if source == "transformer" and transformer_candidate else "workbook-no-spatial-match" if not authoritative_point else "point-outside-tatus-basins"
            props["basinConfidence"] = "low"
            props["basinSource"] = "workbook"
            props["basinId"], props["basinName"] = original_basin_id, original_basin_name
        if transformer_candidate:
            candidate_props = transformer_candidate.get("properties") or {}
            props["basinCandidateId"] = basin_id(transformer_candidate)
            props["basinCandidateName"] = candidate_props.get("name") or candidate_props.get("HAVZA_ADI")
        set_display_basin(props)

    final_basin_ids = {str(feature["properties"].get("basinId") or "") for feature in hes_features if feature["properties"].get("basinId")}
    relevant_basins = [{**feature, "properties": {**(feature.get("properties") or {}), "hes177": True}} for bid, feature in basin_by_id.items() if bid in final_basin_ids]

    dam_features: list[dict[str, Any]] = []
    dam_by_hes: dict[str, list[str]] = defaultdict(list)
    for index, (key, record) in enumerate(sorted(dam_records.items())):
        points = record["points"]
        center = [sum(point[0] for point in points) / len(points), sum(point[1] for point in points) / len(points)]
        dam_id = f"dam177-{index + 1:03d}"
        owner = hes_by_id[record["hesIds"][0]]["properties"] if record["hesIds"] else {}
        dam_basin_id = owner.get("basinId", record["basinId"])
        dam_basin_name = owner.get("basinName", record["basinName"])
        for hes_id in record["hesIds"]: dam_by_hes[hes_id].append(dam_id)
        dam_features.append({"type": "Feature", "id": dam_id, "geometry": {"type": "Point", "coordinates": center}, "properties": {"id": dam_id, "entityId": dam_id, "entityType": "hesDamPoints", "name": record["name"], "damName": record["name"], "basinId": dam_basin_id, "basinName": dam_basin_name, "hesIds": record["hesIds"], "pointCount": len(points), "coordinateSource": record.get("coordinateSource", "TATUS Layer 7"), "sourceIds": record["sourceIds"], "isProducer": bool(record["hesIds"]), "minVolumeHm3": owner.get("minVolumeHm3"), "maxVolumeHm3": owner.get("maxVolumeHm3"), "activeVolumeHm3": owner.get("activeVolumeHm3"), "fullnessPercent": owner.get("fullnessPercent"), "fullnessSource": owner.get("fullnessSource", "missing")}})

    # Layer 4 station names are a controlled fallback for HES records whose
    # Layer 8 query is empty. Accept only same-basin nearest stations.
    station_river_by_hes: dict[str, str] = {}
    station_point_by_hes: dict[str, tuple[float, float]] = {}
    for source in stations_source.get("features", []):
        source_point = point_of(source)
        source_props = source.get("properties") or {}
        station_river = valid_river_name(source_props.get("SuAdi"), basin_id(source))
        if not source_point or not station_river:
            continue
        station_name = normalize(source_props.get("IstAdi"))
        ranked: list[tuple[int, float, str]] = []
        for hes in hes_features:
            hes_name = normalize(hes["properties"].get("name"))
            hes_point = point_of(hes)
            compact_station_name = station_name.replace(" ", "")
            compact_hes_name = hes_name.replace(" ", "")
            same_name = bool(len(compact_station_name) >= 5 and len(compact_hes_name) >= 5 and (compact_station_name in compact_hes_name or compact_hes_name in compact_station_name))
            same_basin = basin_id(source) == str(hes["properties"].get("basinId"))
            river_name_match = bool(hes_name and hes_name.replace(" ", "") in normalize(station_river).replace(" ", ""))
            distance = haversine(source_point, hes_point) if hes_point else float("inf")
            if same_basin and river_name_match and hes_point and distance <= 15:
                ranked.append((0, distance, hes["properties"]["id"]))
            elif same_name and compact_station_name == compact_hes_name:
                ranked.append((0, distance, hes["properties"]["id"]))
            elif same_name:
                ranked.append((1, distance, hes["properties"]["id"]))
            elif hes_point and same_basin and distance <= 25:
                ranked.append((2, distance, hes["properties"]["id"]))
        if ranked:
            priority, distance, nearest_id = min(ranked, key=lambda item: (item[0], item[1]))
            station_point_by_hes[nearest_id] = source_point
            station_river_by_hes.setdefault(nearest_id, station_river)

    river_segments: dict[str, dict[str, Any]] = {}
    for row, hes in zip(rows, hes_features):
        url = str(row.get("Akarsu Polyline GeoJSON URL") or "")
        props = hes["properties"]
        workbook_river = valid_river_name(props.get("riverNameWorkbook"), props.get("basinId"))
        basin_main_river = BASIN_MAIN_RIVER.get(str(props.get("basinId")))
        explicit_river = workbook_river or known_river(props.get("name"), props.get("damName"))
        station_river = station_river_by_hes.get(props["id"])
        known = explicit_river or station_river or basin_main_river
        if known and not props.get("riverName"):
            props["riverName"] = known
            props["riverMatchMethod"] = "workbook-pre-mapping" if workbook_river else "controlled-facility-map" if explicit_river else "tatus-station-suadi" if station_river else "basin-main-river"
            props["riverConfidence"] = "high" if explicit_river else "medium"
        payload = fetched_rivers.get(url)
        lines = feature_lines(payload)
        if not lines:
            candidates = [line for line in overview_lines if basin_id(line) == str(props.get("basinId"))]
            match_point = point_of(hes) or station_point_by_hes.get(props["id"])
            nearest = sorted(candidates, key=lambda line: line_distance_km(match_point, line.get("geometry")))
            lines = nearest[:1] if nearest and line_distance_km(match_point, nearest[0].get("geometry")) <= 12 else []
        match_point = point_of(hes) or station_point_by_hes.get(props["id"])
        if match_point and lines:
            lines = sorted(lines, key=lambda line: (line_distance_km(match_point, line.get("geometry")), -(number((line.get("properties") or {}).get("strahler")) or 0), -(number((line.get("properties") or {}).get("uzunluk")) or 0)))[:1]
        for line in lines:
            line_props = line.get("properties") or {}
            code = str(line_props.get("nehir_kod") or line_props.get("riverCode") or feature_id(line))
            tatus_name = line_props.get("adi") or line_props.get("name")
            # A controlled HES-to-major-river match is stronger than a short
            # segment label returned by TATUS.
            line_name = explicit_river or station_river or valid_river_name(tatus_name, props.get("basinId")) or basin_main_river
            if is_waterbody_name(tatus_name) and not props.get("riverName"):
                props["waterBodyName"] = props.get("waterBodyName") or tatus_name
            if not line_name:
                # Keep the unresolved state in the canonical relation, rather
                # than leaking one technical pseudo-river per HES into the UI.
                continue
            key = f"{props['basinId']}:{code}:{json.dumps(line.get('geometry'), sort_keys=True)}"
            record = river_segments.setdefault(key, {"geometry": line.get("geometry"), "name": line_name, "riverName": line_name, "riverCode": code, "basinId": props["basinId"], "hesIds": [], "source": "TATUS Layer 8", "matchMethod": "workbook-pre-mapping" if workbook_river else "controlled-facility-map" if explicit_river else "basin-main-river" if basin_main_river and line_name == basin_main_river else "tatus-spatial", "confidence": "high" if explicit_river else "medium", "lengthKm": number(line_props.get("lengthKm")) or (number(line_props.get("uzunluk")) or 0) / 1000})
            if props["id"] not in record["hesIds"]: record["hesIds"].append(props["id"])
            if code and code not in (props.get("riverCode") or ""): props["riverCode"] = code
            props["riverName"], props["riverMatchMethod"], props["riverConfidence"] = line_name, record["matchMethod"], record["confidence"]

    # Propagate a named river only through an explicit, resolved cascade edge.
    # This is intentionally separate from basin-wide guessing.
    for hes in hes_features:
        props = hes["properties"]
        if props.get("riverName") or not props.get("cascadeName"):
            continue
        target = best_name(props.get("cascadeName"), hes_by_name)
        if not target:
            continue
        target_props = hes_by_id[target[0]]["properties"]
        target_name = target_props.get("riverName") or known_river(target_props.get("name"), target_props.get("damName"))
        if target_name and not str(target_name).startswith("Adsız"):
            props["riverName"], props["riverMatchMethod"], props["riverConfidence"] = target_name, "verified-cascade-chain", "medium"

    # Preserve a complete canonical relation for every HES without claiming a
    # false river identity. Unresolved records have no synthetic UI river.
    for hes in hes_features:
        props = hes["properties"]
        if props.get("riverName"):
            continue
        props["riverName"], props["riverMatchMethod"], props["riverConfidence"] = None, "unresolved", "low"

    for hes in hes_features:
        set_display_basin(hes["properties"])

    # Collapse technical TATUS segments into one browser-facing feature per
    # named river system. Unnamed segments remain build-time evidence only and
    # are intentionally not exposed as sidebar rows.
    river_systems: dict[str, dict[str, Any]] = {}
    for record in river_segments.values():
        river_name = record.get("riverName")
        if not river_name:
            continue
        normalized_name = normalize(river_name)
        major_system = normalized_name in MAJOR_RIVER_NAMES
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

    # A named HES remains part of its logical river system even when the
    # provider did not return a line for that individual query.
    for hes in hes_features:
        properties = hes["properties"]
        river_name = properties.get("riverName")
        if not river_name:
            continue
        normalized_name = normalize(river_name)
        major_system = normalized_name in MAJOR_RIVER_NAMES
        system_key = f"major:{normalized_name}" if major_system else f"{properties['basinId']}:{normalized_name}"
        system = river_systems.setdefault(system_key, {"name": river_name, "basinId": properties["basinId"], "basinIds": [], "hesIds": [], "codes": [], "geometries": [], "lengthKm": 0.0, "matchMethods": set(), "confidences": set()})
        if properties["basinId"] not in system["basinIds"]:
            system["basinIds"].append(properties["basinId"])
        if properties["id"] not in system["hesIds"]:
            system["hesIds"].append(properties["id"])
        system["matchMethods"].add(properties.get("riverMatchMethod") or "controlled-name")
        system["confidences"].add(properties.get("riverConfidence") or "medium")

    # The comprehensive TATUS network is build-time-only evidence. Extract
    # just the named, HES-basin corridors needed by the focused browser
    # package; no general hydrology network reaches runtime.
    source_parts_by_name_and_basin: dict[tuple[str, str], list[list[Any]]] = defaultdict(list)
    source_names = {canonical_source_river_name(system["name"]) for system in river_systems.values()}
    full_rivers_source = read_json(TATUS / "rivers.geojson")
    for source in full_rivers_source.get("features", []):
        source_name = canonical_source_river_name((source.get("properties") or {}).get("adi") or (source.get("properties") or {}).get("name"))
        source_basin = basin_id(source)
        if source_name not in source_names or not source_basin:
            continue
        geometry = source.get("geometry") or {}
        if geometry.get("type") == "LineString" and len(geometry.get("coordinates", [])) > 1:
            source_parts_by_name_and_basin[(source_name, source_basin)].append(geometry["coordinates"])
        elif geometry.get("type") == "MultiLineString":
            source_parts_by_name_and_basin[(source_name, source_basin)].extend(part for part in geometry.get("coordinates", []) if len(part) > 1)
    del full_rivers_source

    river_features: list[dict[str, Any]] = []
    disconnected_river_components = 0
    river_system_ids_by_hes: dict[str, list[str]] = defaultdict(list)
    for index, system in enumerate(sorted(river_systems.values(), key=lambda item: (item["basinId"], item["name"])), start=1):
        river_id = f"river-system-{index:03d}"
        focused_parts = system["geometries"]
        source_parts = [part for basin in system["basinIds"] for part in source_parts_by_name_and_basin.get((canonical_source_river_name(system["name"]), str(basin)), [])]
        anchors = [(point, float(hes_by_id[hes_id]["properties"].get("installedPowerMw") or 0)) for hes_id in system["hesIds"] if (point := point_of(hes_by_id[hes_id]))]
        overview_parts = [part for feature in overview_lines if basin_id(feature) in system["basinIds"] and any(line_distance_km(point, feature.get("geometry")) <= 35 for point, _ in anchors) for part in geometry_line_parts(feature.get("geometry"))]
        source_corridor, source_components, source_represented_components, source_omitted = nearest_hes_corridors(source_parts, anchors)
        focused_corridor, focused_components, focused_represented_components, focused_omitted = hes_supported_corridors(focused_parts, anchors)
        overview_corridor, overview_components, overview_represented_components, overview_omitted = hes_supported_corridors(overview_parts, anchors, support_distance_km=35)
        source_geometry = {"type": "MultiLineString", "coordinates": source_corridor}
        source_hes_count = sum(line_distance_km(point, source_geometry) <= 25 for point, _ in anchors)
        full_named_network = source_parts if canonical_source_river_name(system["name"]) in MAJOR_RIVER_NAMES else []
        candidate_network = unique_line_parts(full_named_network, source_corridor, focused_corridor, overview_corridor)
        routed_parts, routed_anchor_count = network_route_parts(candidate_network, anchors)
        # The named TATUS network provides the main stem where it reaches the
        # facilities; Layer 8 keeps direct HES reaches visible as well.  These
        # are merged rather than ranked so no valid corridor disappears merely
        # because another disconnected component scored higher.
        source_collections = [routed_parts, focused_corridor]
        source_labels = ["topology-routed corridor"] if routed_parts else []
        source_labels.extend(["Layer 8 HES corridors"] if focused_corridor else [])
        if source_corridor and source_hes_count > 0:
            source_collections.insert(0, source_corridor)
            source_labels.insert(0, "named river")
        if overview_corridor:
            source_collections.append(overview_corridor)
            source_labels.append("overview corridors")
        parts = unique_line_parts(*source_collections)
        geometry_source = "TATUS " + " + ".join(source_labels) if source_labels else "unavailable"
        candidate_segment_count = len(source_parts) + len(focused_parts) + len(overview_parts)
        omitted_segment_count = source_omitted + focused_omitted + overview_omitted
        if not parts:
            continue
        geometry = {"type": "LineString", "coordinates": parts[0]} if len(parts) == 1 else {"type": "MultiLineString", "coordinates": parts}
        components = disconnected_components(parts)
        disconnected_river_components += max(0, components - 1)
        confidence = "high" if "high" in system["confidences"] else "medium"
        direct_reaches = [reach_mapping_by_code[code] for code in system["codes"] if code in reach_mapping_by_code]
        # The static GEOGLOWS cache was built from overview reaches, while the
        # focused package uses Layer 8 HES corridors. When their river codes
        # differ, retain only nearby reaches from the same official basin and
        # expose the match method/confidence to the UI.
        system_geometry = {"type": "MultiLineString", "coordinates": parts}
        basin_candidates = [item for item in reach_mapping if str(item.get("riverCode") or "")[2:4].lstrip("0") in {str(bid).lstrip("0") for bid in system["basinIds"]} and item.get("representativePoint")]
        ranked_reaches = sorted(((line_distance_km(tuple(item["representativePoint"]), system_geometry), item) for item in basin_candidates), key=lambda item: item[0])
        nearest_distance = ranked_reaches[0][0] if ranked_reaches else float("inf")
        nearby_reaches = [item for distance, item in ranked_reaches if distance <= min(80, max(25, nearest_distance + 20))][:4]
        mapped_reaches = direct_reaches or nearby_reaches
        representative_reach = mapped_reaches[0] if mapped_reaches else None
        visible_length_km = sum(line_length_km(part) for part in parts)
        corridor_hes_count = sum(line_distance_km(point, geometry) <= 25 for point, _ in anchors)
        properties = {"id": river_id, "entityId": river_id, "entityType": "hesRiverSystem", "name": system["name"], "riverName": system["name"], "riverSystemId": river_id, "riverCode": system["codes"][0] if system["codes"] else None, "riverCodes": system["codes"], "hesIds": system["hesIds"], "hesCount": len(system["hesIds"]), "installedPowerMw": sum(hes_by_id[hid]["properties"].get("installedPowerMw") or 0 for hid in system["hesIds"]), "basinId": system["basinId"], "basinIds": system["basinIds"], "geometrySource": geometry_source, "matchMethod": "+".join(sorted(system["matchMethods"])), "confidence": confidence, "lengthKm": visible_length_km, "totalLengthKm": visible_length_km, "representedLengthKm": visible_length_km, "segmentCount": len(parts), "candidateSegmentCount": candidate_segment_count, "candidateComponentCount": source_components + focused_components + overview_components, "representedComponentCount": components, "sourceRepresentedComponentCount": source_represented_components, "focusedRepresentedComponentCount": focused_represented_components, "overviewRepresentedComponentCount": overview_represented_components, "routedAnchorCount": routed_anchor_count, "omittedDisconnectedSegmentCount": omitted_segment_count, "disconnectedComponents": components, "corridorHesCount": corridor_hes_count, "geoglowsLocalRiverIds": [str(item.get("localRiverId")) for item in mapped_reaches if item.get("localRiverId")], "geoglowsRiverIds": [item.get("geoglowsRiverId") for item in mapped_reaches if item.get("geoglowsRiverId") is not None], "geoglowsMatchMethod": "river-code" if direct_reaches else "same-basin-nearest-corridor" if mapped_reaches else "unmatched", "geoglowsMatchDistanceKm": round(nearest_distance, 2) if mapped_reaches and not direct_reaches else 0 if direct_reaches else None, "representativeLocalRiverId": str(representative_reach.get("localRiverId")) if representative_reach and representative_reach.get("localRiverId") else None, "representativeGeoglowsRiverId": representative_reach.get("geoglowsRiverId") if representative_reach else None, "hes177": True}
        river_features.append({"type": "Feature", "id": river_id, "geometry": geometry, "properties": properties})
        for hes_id in system["hesIds"]: river_system_ids_by_hes[hes_id].append(river_id)

    for feature in river_features:
        for hes_id in feature["properties"]["hesIds"]:
            hes_by_id[hes_id]["properties"]["riverSystemId"] = feature["properties"]["riverSystemId"]
    river_system_lookup = {(normalize(feature["properties"].get("riverName")), str(feature["properties"].get("basinId"))): feature["properties"].get("riverSystemId") for feature in river_features}
    for hes in hes_features:
        props = hes["properties"]
        if props.get("riverSystemId") or not props.get("riverName"):
            continue
        system_id = river_system_lookup.get((normalize(props.get("riverName")), str(props.get("basinId"))))
        if system_id:
            props["riverSystemId"] = system_id
            river_system_ids_by_hes[props["id"]].append(str(system_id))

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
        relation_by_hes[hid] = {"riverNameWorkbook": p.get("riverNameWorkbook"), "riverIds": river_ids, "riverSystemIds": river_ids, "riverSystemId": river_ids[0] if river_ids else None, "riverName": p.get("riverName"), "riverMatchMethod": p.get("riverMatchMethod"), "riverConfidence": p.get("riverConfidence"), "damIds": dam_by_hes.get(hid, []), "stationIds": [], "catchmentUrl": p.get("catchmentUrl"), "cascadeToId": next(iter(sorted(downstream[hid])), None), "cascadeFromIds": sorted(upstream[hid])}
        p.update({"riverIds": relation_by_hes[hid]["riverIds"], "riverSystemIds": relation_by_hes[hid]["riverSystemIds"], "riverSystemId": relation_by_hes[hid]["riverSystemId"], "damIds": relation_by_hes[hid]["damIds"], "stationIds": relation_by_hes[hid]["stationIds"], "cascadeToId": relation_by_hes[hid]["cascadeToId"], "cascadeFromIds": relation_by_hes[hid]["cascadeFromIds"], "isProducer": True})

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
        summaries.append({"basinId": bid, "name": bp.get("name") or bp.get("HAVZA_ADI"), "areaKm2": number(bp.get("areaKm2") or bp.get("ALAN_KM2")), "hesCount": len(h), "installedPowerMw": sum(f["properties"].get("installedPowerMw") or 0 for f in h), "riverCount": len(r), "riverLengthKm": sum(f["properties"].get("lengthKm") or 0 for f in r), "totalLengthKm": sum(f["properties"].get("lengthKm") or 0 for f in r), "damCount": sum(1 for f in dam_features if f["properties"].get("basinId") == bid), "hesStationCount": 0, "lakeStationCount": 0, "knownRiverNames": sorted({f["properties"]["riverName"] for f in r if f["properties"].get("riverName")})})

    def write(name: str, data: Any) -> None:
        (OUT / name).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    write("hes_177.geojson", {"type": "FeatureCollection", "features": hes_features})
    write("hes_rivers.geojson", {"type": "FeatureCollection", "features": river_features})
    write("hes_basins.geojson", {"type": "FeatureCollection", "features": relevant_basins})
    write("hes_dam_points.geojson", {"type": "FeatureCollection", "features": dam_features})
    write("hes_cascades.geojson", {"type": "FeatureCollection", "features": cascade_features})
    write("hes_177_relations.json", {"byHesId": relation_by_hes, "cascadeEdges": cascade_edges, "unresolvedCascades": unresolved_cascades, "basinSummaries": summaries, "riverGroups": {name: sorted({rid for feature in river_features if feature["properties"].get("riverName") == name for rid in feature["properties"].get("hesIds", [])}) for name in sorted({feature["properties"].get("riverName") for feature in river_features if feature["properties"].get("riverName")})}})
    coordinate_count = sum(bool(feature.get("geometry")) for feature in hes_features)
    verified = sum(feature["properties"].get("coordinateKind") == "verified" for feature in hes_features)
    dam_fallback = sum(feature["properties"].get("coordinateSource") == "tatus-dam-point" for feature in hes_features)
    transformer = sum(feature["properties"].get("coordinateKind") == "transformer" for feature in hes_features)
    producer_count = sum(feature["properties"].get("isProducer") is True for feature in hes_features)
    volume_fullness_count = sum(feature["properties"].get("fullnessPercent") is not None for feature in hes_features)
    river_unresolved = [feature for feature in hes_features if feature["properties"].get("riverMatchMethod") == "unresolved"]
    river_matched_count = len(hes_features) - len(river_unresolved)
    river_unmatched_hes = [feature["properties"]["id"] for feature in river_unresolved]
    river_unmatched_names = [feature["properties"].get("name") for feature in river_unresolved]
    display_basin_count = sum(bool(feature["properties"].get("displayBasinName")) for feature in hes_features)
    official_basin_count = sum(bool(feature["properties"].get("officialBasinName")) for feature in hes_features)
    spatial_verified_basin_count = sum(feature["properties"].get("basinMatchMethod") in {"hes-point-in-polygon", "dam-point-in-polygon"} for feature in hes_features)
    dam_fallback_basin_count = sum(feature["properties"].get("basinMatchMethod") == "dam-point-in-polygon" for feature in hes_features)
    workbook_basin_count = sum(feature["properties"].get("basinMatchMethod", "").startswith("workbook") or feature["properties"].get("basinSource") == "workbook" for feature in hes_features)
    transformer_candidate_count = sum(bool(feature["properties"].get("basinCandidateId")) for feature in hes_features)
    basin_selection_mismatch_count = sum(str(feature["properties"].get("basinId")) != str(feature["properties"].get("officialBasinId")) for feature in hes_features)
    river_cross_mismatch_count = sum(
        normalize(feature["properties"].get("riverName")) == "FIRAT" and normalize(feature["properties"].get("name")) in KNOWN_RIVER_HES["Dicle"]
        or normalize(feature["properties"].get("riverName")) == "DICLE" and normalize(feature["properties"].get("name")) in KNOWN_RIVER_HES["Fırat"]
        for feature in hes_features
    )
    manifest = {"version": 5, "source": str(WORKBOOK.relative_to(ROOT)).replace("\\", "/"), "minimumInstalledPowerMw": MIN_INSTALLED_POWER_MW, "hesCount": len(hes_features), "producerCount": producer_count, "riverMatchedCount": river_matched_count, "riverUnresolvedCount": len(river_unresolved), "riverUnmatchedCount": len(river_unmatched_hes), "riverUnmatchedHesIds": river_unmatched_hes, "riverUnmatchedHesNames": river_unmatched_names, "displayBasinCount": display_basin_count, "officialBasinCount": official_basin_count, "spatialVerifiedBasinCount": spatial_verified_basin_count, "damFallbackBasinCount": dam_fallback_basin_count, "workbookBasinCount": workbook_basin_count, "transformerCandidateCount": transformer_candidate_count, "basinSelectionMismatchCount": basin_selection_mismatch_count, "riverCrossMismatchCount": river_cross_mismatch_count, "coordinateCount": coordinate_count, "verifiedCoordinateCount": verified, "damFallbackCoordinateCount": dam_fallback, "transformerCoordinateCount": transformer, "unresolvedCoordinateCount": len(hes_features) - coordinate_count, "basinCount": len(relevant_basins), "logicalRiverCount": len(river_features), "riverFeatureCount": len(river_features), "riverGeometryFeatureCount": len(river_segments), "riverSegmentCount": len(river_segments), "disconnectedRiverComponents": disconnected_river_components, "damCount": len(dam_features), "reservoirPolygonCount": 0, "hesStationCount": 0, "lakeStationCount": 0, "cascadeEdgeCount": len(cascade_edges), "unresolvedCascadeCount": len(unresolved_cascades), "volumeCalculatedFullnessCount": volume_fullness_count, "epiasFullnessCount": 0, "fallbackMockFullnessCount": len(hes_features) - volume_fullness_count, "catchmentCount": sum(bool(feature["properties"].get("catchmentUrl")) for feature in hes_features), "generatedBy": "tools/build_hes177.py"}
    write("hes_177_manifest.json", manifest)
    print(json.dumps({"minimumInstalledPowerMw": MIN_INSTALLED_POWER_MW, "hes": len(hes_features), "producers": producer_count, "riverMatched": river_matched_count, "riverUnmatched": len(river_unmatched_hes), "displayBasins": display_basin_count, "officialBasins": official_basin_count, "spatialVerifiedBasins": spatial_verified_basin_count, "damFallbackBasins": dam_fallback_basin_count, "workbookBasins": workbook_basin_count, "transformerCandidates": transformer_candidate_count, "basinSelectionMismatches": basin_selection_mismatch_count, "riverCrossMismatches": river_cross_mismatch_count, "coordinates": coordinate_count, "verified": verified, "transformer": transformer, "unresolved": len(hes_features) - coordinate_count, "basins": len(relevant_basins), "rivers": len(river_features), "dams": len(dam_features), "stationSupport": len(station_features), "cascadeEdges": len(cascade_edges), "catchments": manifest["catchmentCount"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()

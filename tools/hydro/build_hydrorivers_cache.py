"""Create the small HydroRIVERS cache used by the HES canonical builder.

The upstream Europe shapefile is build-time input only. The checked-in cache
contains the main-stem reaches and the short downstream anchor paths needed
by the >=20 MW HES catalogue, together with provenance metadata.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_HES = ROOT / "public" / "data" / "hes177" / "hes_177.geojson"
DEFAULT_DAMS = ROOT / "public" / "data" / "hes177" / "hes_dam_points.geojson"
DEFAULT_OUTPUT = ROOT / "public" / "data" / "static" / "mappings" / "hydrorivers_hes177.geojson"
SOURCE_URL = "https://data.hydrosheds.org/file/HydroRIVERS/HydroRIVERS_v10_eu_shp.zip"
CELL_SIZE = 0.5


def number(value: bytes, integer: bool = False) -> int | float:
    text = value.decode("ascii", "ignore").strip()
    if not text:
        return 0
    return int(text) if integer else float(text)


def dbf_records(path: Path) -> list[dict[str, int | float]]:
    raw = path.read_bytes()
    header_length = struct.unpack_from("<H", raw, 8)[0]
    record_length = struct.unpack_from("<H", raw, 10)[0]
    record_count = struct.unpack_from("<I", raw, 4)[0]
    fields: list[tuple[str, int]] = []
    position = 32
    while position < header_length - 1 and raw[position] != 0x0D:
        name = raw[position:position + 11].split(b"\0", 1)[0].decode("ascii", "ignore")
        fields.append((name, raw[position + 16]))
        position += 32
    offsets: dict[str, tuple[int, int]] = {}
    cursor = 1
    for name, length in fields:
        offsets[name] = (cursor, length)
        cursor += length
    wanted = {"HYRIV_ID", "NEXT_DOWN", "MAIN_RIV", "LENGTH_KM", "ORD_STRA", "ORD_CLAS", "HYBAS_L12"}
    result: list[dict[str, int | float]] = []
    for index in range(record_count):
        row = raw[header_length + index * record_length:header_length + (index + 1) * record_length]
        if not row or row[0] == 0x2A:
            result.append({name: 0 for name in wanted})
            continue
        values: dict[str, int | float] = {}
        for name in wanted:
            start, length = offsets[name]
            values[name] = number(row[start:start + length], integer=name not in {"LENGTH_KM"})
        result.append(values)
    return result


def shape_header_and_bbox(content: bytes) -> tuple[int, tuple[float, float, float, float]]:
    return struct.unpack_from("<i", content, 0)[0], struct.unpack_from("<4d", content, 4)


def read_parts(file: BinaryIO, offset: int) -> list[list[list[float]]]:
    file.seek(offset)
    header = file.read(8)
    if len(header) != 8:
        return []
    content = file.read(struct.unpack(">I", header[4:8])[0] * 2)
    shape_type, _ = shape_header_and_bbox(content)
    if shape_type != 3 or len(content) < 44:
        return []
    part_count = struct.unpack_from("<i", content, 36)[0]
    point_count = struct.unpack_from("<i", content, 40)[0]
    starts = list(struct.unpack_from("<" + "i" * part_count, content, 44))
    points_offset = 44 + part_count * 4
    points = [list(struct.unpack_from("<2d", content, points_offset + index * 16)) for index in range(point_count)]
    return [points[starts[index]:starts[index + 1] if index + 1 < part_count else point_count] for index in range(part_count)]


def iter_shape_index(path: Path) -> tuple[list[int], list[tuple[float, float, float, float]], dict[tuple[int, int], list[int]]]:
    offsets: list[int] = []
    boxes: list[tuple[float, float, float, float]] = []
    grid: dict[tuple[int, int], list[int]] = defaultdict(list)
    with path.open("rb") as file:
        file.seek(100)
        while True:
            offset = file.tell()
            header = file.read(8)
            if len(header) != 8:
                break
            content = file.read(struct.unpack(">I", header[4:8])[0] * 2)
            if len(content) < 44:
                offsets.append(offset)
                boxes.append((0, 0, 0, 0))
                continue
            shape_type, box = shape_header_and_bbox(content)
            offsets.append(offset)
            boxes.append(box)
            if shape_type != 3:
                continue
            min_x, min_y, max_x, max_y = box
            for x in range(math.floor(min_x / CELL_SIZE), math.floor(max_x / CELL_SIZE) + 1):
                for y in range(math.floor(min_y / CELL_SIZE), math.floor(max_y / CELL_SIZE) + 1):
                    grid[(x, y)].append(len(offsets) - 1)
    return offsets, boxes, grid


def haversine(left: tuple[float, float], right: tuple[float, float]) -> float:
    lon1, lat1 = map(math.radians, left)
    lon2, lat2 = map(math.radians, right)
    dlon, dlat = lon2 - lon1, lat2 - lat1
    value = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(value))


def segment_distance(point: tuple[float, float], left: list[float], right: list[float]) -> float:
    scale = math.cos(math.radians(point[1]))
    px, py = point[0] * scale, point[1]
    ax, ay = left[0] * scale, left[1]
    bx, by = right[0] * scale, right[1]
    dx, dy = bx - ax, by - ay
    denominator = dx * dx + dy * dy
    ratio = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / denominator)) if denominator else 0.0
    return haversine(point, (ax / scale + ratio * dx / scale if scale else point[0], ay + ratio * dy))


def line_distance(point: tuple[float, float], parts: list[list[list[float]]]) -> float:
    return min((segment_distance(point, left, right) for part in parts for left, right in zip(part, part[1:])), default=float("inf"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True, help="HydroRIVERS_v10_eu_shp.zip extracted directory")
    parser.add_argument("--source-archive", type=Path, help="Original HydroRIVERS zip for provenance checksum")
    parser.add_argument("--hes", type=Path, default=DEFAULT_HES)
    parser.add_argument("--dams", type=Path, default=DEFAULT_DAMS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    base = args.source / "HydroRIVERS_v10_eu_shp" if (args.source / "HydroRIVERS_v10_eu_shp").exists() else args.source
    shp, dbf = base / "HydroRIVERS_v10_eu.shp", base / "HydroRIVERS_v10_eu.dbf"
    attrs = dbf_records(dbf)
    offsets, boxes, grid = iter_shape_index(shp)
    hes_features = json.loads(args.hes.read_text(encoding="utf-8")).get("features", [])
    dam_features = json.loads(args.dams.read_text(encoding="utf-8")).get("features", []) if args.dams.exists() else []
    dam_by_hes: dict[str, dict[str, Any]] = {}
    for dam in dam_features:
        for hes_id in (dam.get("properties") or {}).get("hesIds", []):
            dam_by_hes[str(hes_id)] = dam
    with shp.open("rb") as file:
        def nearest(point: tuple[float, float]) -> tuple[int | None, float]:
            candidates: set[int] = set()
            for radius in (2, 5, 12):
                candidates.clear()
                cell_x, cell_y = math.floor(point[0] / CELL_SIZE), math.floor(point[1] / CELL_SIZE)
                for x in range(cell_x - radius, cell_x + radius + 1):
                    for y in range(cell_y - radius, cell_y + radius + 1):
                        candidates.update(grid.get((x, y), []))
                best: tuple[int | None, float] = (None, float("inf"))
                for index in candidates:
                    if not attrs[index].get("HYRIV_ID"):
                        continue
                    min_x, min_y, max_x, max_y = boxes[index]
                    if point[0] < min_x - 0.5 or point[0] > max_x + 0.5 or point[1] < min_y - 0.5 or point[1] > max_y + 0.5:
                        continue
                    distance = line_distance(point, read_parts(file, offsets[index]))
                    if distance < best[1]: best = (index, distance)
                if best[0] is not None and best[1] <= 25: return best
            return best

        anchors: dict[int, list[str]] = defaultdict(list)
        anchors_by_system: dict[str, list[int]] = defaultdict(list)
        anchor_points_by_system: dict[str, list[tuple[float, float]]] = defaultdict(list)
        anchor_info: dict[str, dict[str, Any]] = {}
        for feature in hes_features:
            properties = feature.get("properties") or {}
            geometry = feature.get("geometry") or {}
            anchor_method = "hes-point"
            if properties.get("coordinateKind") == "transformer":
                dam_geometry = (dam_by_hes.get(str(properties.get("id"))) or {}).get("geometry") or {}
                if dam_geometry.get("type") == "Point":
                    geometry, anchor_method = dam_geometry, "dam-point"
                else:
                    # A transformer is an explicitly low-confidence last
                    # resort, but remains useful for a network anchor when no
                    # HES or dam point exists.
                    anchor_method = "transformer"
            if geometry.get("type") != "Point": continue
            point = (float(geometry["coordinates"][0]), float(geometry["coordinates"][1]))
            index, distance = nearest(point)
            if index is None or not math.isfinite(distance): continue
            hydro_id = int(attrs[index]["HYRIV_ID"])
            hes_id = str(properties.get("id"))
            system_key = str(properties.get("canonicalRiverName") or properties.get("riverName") or "").strip().upper()
            anchors[hydro_id].append(hes_id)
            if system_key:
                anchors_by_system[system_key].append(hydro_id)
                anchor_points_by_system[system_key].append(point)
            anchor_info[hes_id] = {"hydroRiversId": hydro_id, "hydroMainRiverId": int(attrs[index]["MAIN_RIV"]), "hydroMatchMethod": anchor_method, "hydroMatchDistanceKm": round(distance, 2), "hydroMatchConfidence": "low" if anchor_method == "transformer" else "high" if distance <= 3 else "medium" if distance <= 10 else "review"}
        attrs_by_id = {int(value["HYRIV_ID"]): value for value in attrs if value.get("HYRIV_ID")}
        features: list[dict[str, Any]] = []
        with shp.open("rb") as file:
            selected_by_system: dict[str, set[int]] = {}
            for system_key, system_anchor_ids in anchors_by_system.items():
                main_ids = {int(attrs_by_id[hydro_id]["MAIN_RIV"]) for hydro_id in system_anchor_ids if hydro_id in attrs_by_id}
                points = anchor_points_by_system[system_key]
                min_x, max_x = min(point[0] for point in points) - 0.45, max(point[0] for point in points) + 0.45
                min_y, max_y = min(point[1] for point in points) - 0.45, max(point[1] for point in points) + 0.45
                selected_ids = {int(value["HYRIV_ID"]) for index, value in enumerate(attrs) if value.get("MAIN_RIV") in main_ids and value.get("ORD_CLAS") == 1 and min_x <= boxes[index][2] and max_x >= boxes[index][0] and min_y <= boxes[index][3] and max_y >= boxes[index][1]}
                for hydro_id in system_anchor_ids:
                    current = hydro_id
                    for _ in range(180):
                        value = attrs_by_id.get(current)
                        if not value: break
                        selected_ids.add(current)
                        next_id = int(value.get("NEXT_DOWN") or 0)
                        if not next_id or next_id == current: break
                        current = next_id
                selected_by_system[system_key] = selected_ids
            # HydroRIVERS can use one MAIN_RIV for a trunk that contains two
            # named systems (most notably the Fırat/Dicle confluence). Keep a
            # reach in only the system whose HES anchors are geographically
            # closest; otherwise one river silently inherits the other river's
            # downstream geometry.
            systems_by_hydro_id: dict[int, list[str]] = defaultdict(list)
            for system_key, selected_ids in selected_by_system.items():
                for hydro_id in selected_ids:
                    systems_by_hydro_id[hydro_id].append(system_key)
            for hydro_id, system_keys in systems_by_hydro_id.items():
                if len(system_keys) < 2:
                    continue
                value = attrs_by_id.get(hydro_id)
                if not value:
                    continue
                index = attrs.index(value)
                parts = read_parts(file, offsets[index])
                if not parts:
                    continue
                owner = min(system_keys, key=lambda key: min((line_distance(point, parts) for point in anchor_points_by_system[key]), default=float("inf")))
                for system_key in system_keys:
                    if system_key != owner:
                        selected_by_system[system_key].discard(hydro_id)
            for system_key, selected_ids in selected_by_system.items():
                for index, value in enumerate(attrs):
                    hydro_id = int(value.get("HYRIV_ID") or 0)
                    if hydro_id not in selected_ids: continue
                    parts = read_parts(file, offsets[index])
                    if not parts: continue
                    geometry: dict[str, Any] = {"type": "LineString", "coordinates": parts[0]} if len(parts) == 1 else {"type": "MultiLineString", "coordinates": parts}
                    properties = {"id": f"hydrorivers-{system_key.lower()}-{hydro_id}", "hydroRiversId": hydro_id, "nextDown": int(value["NEXT_DOWN"] or 0), "mainRiverId": int(value["MAIN_RIV"] or 0), "orderClass": int(value["ORD_CLAS"] or 0), "strahler": int(value["ORD_STRA"] or 0), "lengthKm": float(value["LENGTH_KM"] or 0), "basinLevel12": int(value["HYBAS_L12"] or 0), "riverSystemKeys": [system_key], "anchorHesIds": anchors.get(hydro_id, [])}
                    features.append({"type": "Feature", "id": properties["id"], "geometry": geometry, "properties": properties})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    source_zip = args.source_archive if args.source_archive and args.source_archive.is_file() else args.source if args.source.is_file() else None
    checksum = hashlib.sha256(source_zip.read_bytes()).hexdigest() if source_zip else None
    payload = {"type": "FeatureCollection", "dataVersion": "hydrorivers-v10-hes177", "generatedAt": datetime.now(timezone.utc).isoformat(), "source": "HydroRIVERS v10 Europe", "sourceUrl": SOURCE_URL, "sourceSha256": checksum, "featureCount": len(features), "matchedHesCount": len(anchor_info), "anchorInfo": anchor_info, "features": features}
    args.output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"features": len(features), "matchedHes": len(anchor_info), "mainRivers": len(anchors_by_system), "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

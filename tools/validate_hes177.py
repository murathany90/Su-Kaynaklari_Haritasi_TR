"""Small regression validator for the generated 20 MW+ HES GIS package."""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "data" / "hes177"
MIN_POWER_MW = 20.0
WATERBODY_WORDS = ("GOL", "GOLU", "GOLLER", "BARAJ", "REZERVUAR", "LAGUN")


def load(name: str) -> Any:
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def normalize(value: Any) -> str:
    text = "".join(character for character in unicodedata.normalize("NFKD", str(value or "").upper()) if not unicodedata.combining(character))
    return re.sub(r"[^A-Z0-9]+", " ", text).strip()


def is_waterbody(value: Any) -> bool:
    tokens = set(normalize(value).split())
    return bool(tokens & set(WATERBODY_WORDS)) or any(token.startswith(WATERBODY_WORDS) for token in tokens)


def point_is_valid(feature: dict[str, Any]) -> bool:
    coordinates = ((feature.get("geometry") or {}).get("coordinates") or [])
    try:
        return len(coordinates) >= 2 and -180 <= float(coordinates[0]) <= 180 and -90 <= float(coordinates[1]) <= 90
    except (TypeError, ValueError):
        return False


def main() -> None:
    manifest = load("hes_177_manifest.json")
    hes = load("hes_177.geojson").get("features", [])
    rivers = load("hes_rivers.geojson").get("features", [])
    basins = load("hes_basins.geojson").get("features", [])
    dams = load("hes_dam_points.geojson").get("features", [])
    reservoirs = load("hes_reservoirs.geojson").get("features", []) if (DATA / "hes_reservoirs.geojson").exists() else []
    relations = load("hes_177_relations.json").get("byHesId", {})
    topology = load("river_topology_audit.json") if (DATA / "river_topology_audit.json").exists() else {"rivers": []}
    hes_ids = {str(feature.get("properties", {}).get("id") or feature.get("id")) for feature in hes}
    river_ids = {str(feature.get("properties", {}).get("riverSystemId") or feature.get("id")) for feature in rivers}
    basin_ids = {str(feature.get("properties", {}).get("basinId") or feature.get("id")) for feature in basins}
    river_unmatched = [feature["properties"].get("name") for feature in hes if feature["properties"].get("riverMatchMethod") == "unresolved"]
    invalid_relation_ids = [hid for hid, relation in relations.items() if hid not in hes_ids or any(str(rid) not in river_ids for rid in relation.get("riverIds", []))]
    geoglows_over_25 = [feature["properties"].get("riverName") for feature in rivers if feature["properties"].get("geoglowsMatchMethod") != "unmatched" and (feature["properties"].get("geoglowsMatchDistanceKm") or 0) > 25]
    waterbody_rivers = [feature["properties"].get("riverName") for feature in rivers if is_waterbody(feature["properties"].get("riverName"))]
    fullness_invalid = [feature["properties"].get("name") for feature in hes if feature["properties"].get("fullnessPercent") is not None and not 0 <= float(feature["properties"]["fullnessPercent"]) <= 100]
    fullness_semantic_errors = [feature["properties"].get("name") for feature in hes if feature["properties"].get("hydroPlantStorageType") == "run_of_river" and feature["properties"].get("fullnessPercent") is not None]
    missing_fullness_result = [feature["properties"].get("name") for feature in hes if not isinstance(feature["properties"].get("fullnessResult"), dict)]
    transformer_verified = [feature["properties"].get("name") for feature in hes if feature["properties"].get("coordinateKind") == "transformer" and feature["properties"].get("coordinateVerified") is True]
    invalid_reservoirs = [feature.get("id") for feature in reservoirs if not feature.get("geometry") or not isinstance((feature.get("properties") or {}).get("hesIds"), list) or (feature.get("properties") or {}).get("validated") is not True]
    cross_mismatch = [feature["properties"].get("name") for feature in hes if feature["properties"].get("basinId") == "21" and ((normalize(feature["properties"].get("riverName")) == "FIRAT" and normalize(feature["properties"].get("name")) in {"ILISU", "DICLE", "KRALKIZI"}) or (normalize(feature["properties"].get("riverName")) == "DICLE" and normalize(feature["properties"].get("name")) in {"ATATURK", "KEBAN", "KARAKAYA"}))]
    duplicate_ids = len(hes_ids) != len(hes)
    duplicate_names = len({normalize(feature["properties"].get("name")) for feature in hes}) != len(hes)
    disconnected = sum(max(0, int(feature["properties"].get("connectedComponentCount") or feature["properties"].get("disconnectedComponents") or 0) - 1) for feature in rivers)
    topology_disconnected = sum(max(0, int(feature.get("connectedComponentCount") or 0) - 1) for feature in topology.get("rivers", []))
    report = {
        "dataVersion": manifest.get("dataVersion"),
        "generatedAt": manifest.get("generatedAt"),
        "sourceCommit": manifest.get("sourceCommit"),
        "HES": len(hes),
        "Producer": f"{manifest.get('producerCount', 0)}/{len(hes)}",
        "River matched": f"{manifest.get('riverMatchedCount', 0)}/{len(hes)}",
        "River named": f"{manifest.get('riverNamedCount', 0)}/{len(hes)}",
        "River spatial verified": f"{manifest.get('riverSpatialVerifiedCount', 0)}/{len(hes)}",
        "River corridor coverage": manifest.get("riverCorridorCoverage", 0),
        "River unmatched": len(river_unmatched),
        "River unmatched names": river_unmatched,
        "Official basin": f"{manifest.get('officialBasinCount', 0)}/{len(hes)}",
        "Spatial basin verified": f"{manifest.get('spatialVerifiedBasinCount', 0)}/{len(hes)}",
        "Dam fallback basin": manifest.get("damFallbackBasinCount", 0),
        "Workbook basin": manifest.get("workbookBasinCount", 0),
        "Transformer candidates": manifest.get("transformerCandidateCount", 0),
        "Unresolved coordinates": manifest.get("unresolvedCoordinateCount", 0),
        "Display basin": f"{manifest.get('displayBasinCount', 0)}/{len(hes)}",
        "Fırat/Dicle cross mismatch": len(cross_mismatch),
        "Basin selection mismatch": manifest.get("basinSelectionMismatchCount", 0),
        "Logical rivers": len(rivers),
        "Disconnected river components": disconnected,
        "Topology audit disconnected components": topology_disconnected,
        "GEOGLOWS accepted over 25 km": len(geoglows_over_25),
        "Waterbody names used as river": len(waterbody_rivers),
        "Fullness out of range": len(fullness_invalid),
        "Fullness semantic errors": len(fullness_semantic_errors),
        "Missing FullnessResult": len(missing_fullness_result),
        "Reservoir polygons": len(reservoirs),
        "Invalid reservoir polygons": len(invalid_reservoirs),
        "Transformer marked verified": len(transformer_verified),
        "Duplicate HES ids": duplicate_ids,
        "Duplicate HES names": duplicate_names,
        "Invalid HES coordinates": sum(not point_is_valid(feature) for feature in hes if feature.get("geometry")),
        "Invalid relation ids": len(invalid_relation_ids),
        "Manifest count mismatches": {
            "hes": manifest.get("hesCount") != len(hes),
            "basin": manifest.get("basinCount") != len(basins),
            "river": manifest.get("logicalRiverCount") != len(rivers),
            "dam": manifest.get("damCount") != len(dams),
        },
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    failures = [key for key, value in report.items() if key in {"Fırat/Dicle cross mismatch", "Basin selection mismatch", "GEOGLOWS accepted over 25 km", "Waterbody names used as river", "Fullness out of range", "Invalid relation ids"} and value not in (0, False)]
    failures.extend(key for key, value in report["Manifest count mismatches"].items() if value)
    failures.extend(key for key in ("Fullness semantic errors", "Missing FullnessResult", "Invalid reservoir polygons", "Transformer marked verified") if report[key] != 0)
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()

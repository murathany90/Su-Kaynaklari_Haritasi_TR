"""Create the auditable local TATUS -> GEOGLOWS reach mapping scaffold.

GEOGLOWS IDs are not inferred from names. They are only populated by a future
reviewed mapping pass (or by an explicit mapping file), preventing false
hydrologic joins from appearing as live data.
"""

from __future__ import annotations

import argparse
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from common import MANIFEST_DIR, STATIC_DIR, utc_now, write_json_atomic

import requests


def representative_point(geometry: dict[str, Any] | None) -> list[float] | None:
    coordinates = (geometry or {}).get("coordinates")
    if not coordinates:
        return None
    if (geometry or {}).get("type") == "LineString":
        point = coordinates[len(coordinates) // 2]
        return [float(point[0]), float(point[1])]
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rivers", default=str(STATIC_DIR / "tatus" / "rivers_overview.geojson"))
    parser.add_argument("--output", default=str(STATIC_DIR / "mappings" / "river_reach_map.json"))
    parser.add_argument("--no-geoglows", action="store_true")
    args = parser.parse_args()
    source = json.loads(Path(args.rivers).read_text(encoding="utf-8"))
    rows = []
    for feature in source.get("features", []):
        props = feature.get("properties") or {}
        rows.append({
            "localRiverId": str(props.get("id")),
            "tatusObjectId": props.get("OBJECTID"),
            "name": props.get("name"),
            "riverCode": props.get("riverCode"),
            "representativePoint": representative_point(feature.get("geometry")),
            "geoglowsRiverId": None,
            "mappingMethod": "unmapped",
            "reviewRequired": True,
        })
    if not args.no_geoglows:
        base_url = os.getenv("GEOGLOWS_BASE_URL", "https://geoglows.ecmwf.int/api/v2").rstrip("/")
        def resolve(row: dict[str, Any]) -> dict[str, Any]:
            point = row.get("representativePoint")
            if not point:
                return row
            try:
                session = requests.Session()
                response = session.get(f"{base_url}/getriverid", params={"lon": point[0], "lat": point[1]}, timeout=30)
                response.raise_for_status()
                river_id = response.json().get("river_id")
                if river_id is not None:
                    row.update({"geoglowsRiverId": river_id, "mappingMethod": "geoglows_getriverid", "reviewRequired": False})
            except Exception as exc:
                row["mappingError"] = str(exc)
            return row

        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = [executor.submit(resolve, row) for row in rows]
            rows = [future.result() for future in as_completed(futures)]
        rows.sort(key=lambda row: row["localRiverId"])
    matched = sum(1 for row in rows if row.get("geoglowsRiverId"))
    status = "ok" if matched == len(rows) and rows else "partial" if matched else "review_required"
    payload = {"generatedAt": utc_now(), "status": status, "source": "TATUS layer 8 + GEOGLOWS getriverid", "count": len(rows), "matchedCount": matched, "mappings": rows}
    write_json_atomic(Path(args.output), payload)
    write_json_atomic(MANIFEST_DIR / "river_reach_map_manifest.json", {"generatedAt": payload["generatedAt"], "status": payload["status"], "count": len(rows), "matchedCount": matched, "reviewRequired": len(rows) - matched})
    print(json.dumps({"status": payload["status"], "count": len(rows), "matched": matched, "reviewRequired": len(rows) - matched}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

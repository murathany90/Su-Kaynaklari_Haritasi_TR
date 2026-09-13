"""Fetch the six TATUS GIS layers into versioned, frontend-ready GeoJSON."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import requests

from common import MANIFEST_DIR, STATIC_DIR, TATUS_BASE_URL, TATUS_LAYERS, feature_collection, query_tatus_layer, utc_now, write_json_atomic


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=TATUS_BASE_URL)
    args = parser.parse_args()

    session = requests.Session()
    session.headers.update({"User-Agent": "Su-Kaynaklari-Haritasi-TR/1.0"})
    fetched_at = utc_now()
    layer_results = []
    staged: list[tuple[Path, dict]] = []
    try:
        for key, config in TATUS_LAYERS.items():
            metadata, raw_features = query_tatus_layer(session, config["id"], base_url=args.base_url)
            collection = feature_collection(key, raw_features)
            target = STATIC_DIR / "tatus" / config["file"]
            staged.append((target, collection))
            result = {"key": key, "id": config["id"], "name": metadata.get("name", config["name"]), "geometry": metadata.get("geometryType"), "featureCount": len(raw_features), "maxRecordCount": metadata.get("maxRecordCount"), "source": f"{args.base_url.rstrip('/')}/{config['id']}", "status": "ok"}
            if key == "rivers":
                overview = {"type": "FeatureCollection", "features": [feature for feature in collection["features"] if float((feature.get("properties") or {}).get("lengthKm") or 0) >= 10]}
                staged.append((STATIC_DIR / "tatus" / config["overviewFile"], overview))
                result["overviewFeatureCount"] = len(overview["features"])
            layer_results.append(result)
            print(f"{key}: {len(raw_features)} features")
    except Exception as exc:
        print(f"TATUS fetch failed; existing generated files were kept: {exc}", file=sys.stderr)
        return 1

    for path, payload in staged:
        write_json_atomic(path, payload)
    manifest = {"generatedAt": fetched_at, "source": "TATUS", "baseUrl": args.base_url.rstrip("/"), "status": "ok", "layers": layer_results}
    write_json_atomic(MANIFEST_DIR / "tatus_manifest.json", manifest)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

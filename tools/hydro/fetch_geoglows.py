"""Fetch GEOGLOWS v2 data for reviewed reach mappings only.

No reviewed IDs means an explicit no-data result is produced; the job never
manufactures a forecast to make the UI look populated.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
from io import StringIO
from pathlib import Path
from typing import Any

import requests

from common import LIVE_DIR, STATIC_DIR, utc_now, write_json_atomic


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mapping", default=str(STATIC_DIR / "mappings" / "river_reach_map.json"))
    parser.add_argument("--output", default=str(LIVE_DIR / "geoglows_latest.json"))
    args = parser.parse_args()
    mapping = json.loads(Path(args.mapping).read_text(encoding="utf-8"))
    reviewed = [row for row in mapping.get("mappings", []) if row.get("geoglowsRiverId") and not row.get("reviewRequired")]
    base_url = os.getenv("GEOGLOWS_BASE_URL", "https://geoglows.ecmwf.int/api/v2").rstrip("/")
    payload: dict[str, Any] = {"generatedAt": utc_now(), "source": "GEOGLOWS v2", "baseUrl": base_url, "status": "no_reviewed_mappings", "records": [], "mappingCount": len(reviewed)}
    if reviewed:
        session = requests.Session()
        records = []
        errors = []
        for row in reviewed:
            river_id = row["geoglowsRiverId"]
            url = f"{base_url}/forecast/{river_id}"
            try:
                response = session.get(url, timeout=90)
                response.raise_for_status()
                text = response.text.lstrip()
                if text.startswith('{') or text.startswith('['):
                    data = response.json()
                else:
                    data = list(csv.DictReader(StringIO(text)))
                records.append({"localRiverId": row["localRiverId"], "geoglowsRiverId": river_id, "data": data})
            except Exception as exc:
                errors.append({"localRiverId": row["localRiverId"], "error": str(exc)})
        payload.update({"status": "ok" if records and not errors else "partial" if records else "failed", "records": records, "errors": errors})
    write_json_atomic(Path(args.output), payload)
    print(json.dumps({"status": payload["status"], "records": len(payload["records"]), "reviewedMappings": len(reviewed)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

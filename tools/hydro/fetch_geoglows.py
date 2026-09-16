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


def read_payload(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mapping", default=str(STATIC_DIR / "mappings" / "river_reach_map.json"))
    parser.add_argument("--output", default=str(LIVE_DIR / "geoglows_latest.json"))
    args = parser.parse_args()
    output_path = Path(args.output)
    previous = read_payload(output_path)
    mapping = json.loads(Path(args.mapping).read_text(encoding="utf-8"))
    reviewed = [row for row in mapping.get("mappings", []) if row.get("geoglowsRiverId") and not row.get("reviewRequired")]
    base_url = os.getenv("GEOGLOWS_BASE_URL", "https://geoglows.ecmwf.int/api/v2").rstrip("/")
    fetched_at = utc_now()
    payload: dict[str, Any] = {"generatedAt": fetched_at, "pipelineRunAt": fetched_at, "source": "GEOGLOWS v2", "baseUrl": base_url, "status": "no_reviewed_mappings", "records": [], "mappingCount": len(reviewed), "lastSuccessfulFetch": previous.get("lastSuccessfulFetch"), "lastKnownGood": False}
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
        if records:
            current_ids = {str(record.get("localRiverId")) for record in records}
            retained = [record for record in previous.get("records", []) if str(record.get("localRiverId")) not in current_ids]
            payload.update({"status": "ok" if not errors else "partial", "records": records, "errors": errors, "lastSuccessfulFetch": fetched_at, "lastKnownGood": False})
            if retained:
                payload["records"].extend(retained)
                payload["retainedLastKnownGoodCount"] = len(retained)
        else:
            payload.update({"status": "degraded", "records": previous.get("records", []), "errors": errors, "lastSuccessfulFetch": previous.get("lastSuccessfulFetch") or previous.get("generatedAt"), "lastKnownGood": bool(previous.get("records")), "fallbackReason": "GEOGLOWS request failed; last successful forecast retained"})
    write_json_atomic(output_path, payload)
    print(json.dumps({"status": payload["status"], "records": len(payload["records"]), "reviewedMappings": len(reviewed)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

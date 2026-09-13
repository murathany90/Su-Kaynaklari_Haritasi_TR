"""Server-side EPİAŞ adapter.

Credentials are read only from environment variables. Missing credentials or
an endpoint/schema mismatch produces an explicit status and empty records;
there is no fallback to synthetic fullness, flow, energy or KPI values.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import requests

from common import CONFIG_DIR, LIVE_DIR, STATIC_DIR, normalize_text, utc_now, write_json_atomic


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(LIVE_DIR / "epias_dams_latest.json"))
    parser.add_argument("--history-output", default=str(LIVE_DIR / "epias_dams_history.json"))
    args = parser.parse_args()
    username = os.getenv("EPIAS_USERNAME")
    password = os.getenv("EPIAS_PASSWORD")
    generated_at = utc_now()
    payload: dict[str, Any] = {"generatedAt": generated_at, "source": "EPİAŞ Şeffaflık Platformu", "status": "requires_access", "records": [], "errors": []}
    if not username or not password:
        payload["errors"].append("EPIAS_USERNAME/EPIAS_PASSWORD are not configured")
        write_json_atomic(Path(args.output), payload)
        write_json_atomic(Path(args.history_output), {"generatedAt": generated_at, "source": payload["source"], "status": payload["status"], "records": []})
        print(json.dumps({"status": payload["status"], "records": 0}, indent=2))
        return 0

    ticket_url = os.getenv("EPIAS_TGT_URL") or "https://giris.epias.com.tr/cas/v1/tickets"
    try:
        session = requests.Session()
        ticket_response = session.post(ticket_url, data={"username": username, "password": password}, headers={"Accept": "text/plain"}, timeout=60)
        ticket_response.raise_for_status()
        ticket = ticket_response.text.strip()
        if not ticket:
            raise RuntimeError("EPİAŞ ticket response was empty")
        payload.update({"status": "access_ready", "ticketConfigured": True})
    except Exception as exc:
        payload["status"] = "failed"
        payload["errors"].append(f"EPİAŞ authentication failed: {exc}")

    # Endpoint details are intentionally configurable until the account's
    # Swagger contract is selected. This keeps secrets out of the browser and
    # prevents a guessed request from being presented as official live data.
    endpoint = os.getenv("EPIAS_DAM_ENDPOINT")
    if payload["status"] == "access_ready" and endpoint:
        try:
            response = session.get(endpoint, headers={"TGT": ticket}, timeout=90)
            response.raise_for_status()
            raw = response.json()
            records = raw.get("body", raw) if isinstance(raw, dict) else raw
            if not isinstance(records, list):
                records = records.get("items", []) if isinstance(records, dict) else []
            payload.update({"status": "ok", "records": records, "endpoint": endpoint})
        except Exception as exc:
            payload["status"] = "failed"
            payload["errors"].append(f"EPİAŞ data request failed: {exc}")
    elif payload["status"] == "access_ready":
        payload["status"] = "requires_endpoint"
        payload["errors"].append("EPIAS_DAM_ENDPOINT is not configured")

    write_json_atomic(Path(args.output), payload)
    write_json_atomic(Path(args.history_output), {"generatedAt": generated_at, "source": payload["source"], "status": payload["status"], "records": payload.get("records", []), "historyDate": str(date.today())})
    print(json.dumps({"status": payload["status"], "records": len(payload.get("records", [])), "errors": payload["errors"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

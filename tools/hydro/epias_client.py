"""EPİAŞ active-fullness client with an explicit error taxonomy.

Endpoint contract (configurable, defaults below)::

    POST {EPIAS_BASE_URL}/v1/dams/data/active-fullness
    headers = {"TGT": ticket}
    json = {"damName": ..., "basinName": ..., "page": ...}

Error taxonomy (machine-readable ``errorCode``; credentials never logged)::

    credentials_missing | auth_failed | access_denied | rate_limited |
    endpoint_error | schema_error | empty_result

Exit codes for CI: 0 = ok / skipped (no credentials) / empty (no data but
reachable); 2 = error while credentials ARE configured (must be visible).
"""

from __future__ import annotations

import os
from typing import Any

import requests

from providers import canonical_observation, classify_http_error, sleep_between_requests, utc_now

DEFAULT_TGT_URL = "https://giris.epias.com.tr/cas/v1/tickets"
DEFAULT_BASE_URL = "https://seffaflik.epias.com.tr"
ACTIVE_FULLNESS_PATH = "/v1/dams/data/active-fullness"

# Schema-tolerant field aliases: EPİAŞ may rename fields without notice.
PERCENT_KEYS = ("activeFullness", "activeFullnessAmount", "fullnessPercent", "fullness", "occupancy", "doluluk", "dolulukOrani")
VOLUME_KEYS = ("activeVolume", "activeVolumeHm3", "active_volume", "hacim", "volume")
MIN_VOLUME_KEYS = ("minVolume", "minVolumeHm3", "minimumVolume", "minimumVolumeHm3")
MAX_VOLUME_KEYS = ("maxVolume", "maxVolumeHm3", "maximumVolume", "maximumVolumeHm3")
DATE_KEYS = ("observationDate", "observedAt", "date", "timestamp", "tarih", "gazDate")
DAM_KEYS = ("damName", "dam_name", "barajAdi", "baraj", "name")
BASIN_KEYS = ("basinName", "basin_name", "havzaAdi", "havza")


class EpiasError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def first_present(record: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        value = record.get(key)
        if value not in (None, ""):
            return value
    return None


def to_number(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    import math
    return parsed if math.isfinite(parsed) else None


def request_ticket(session: requests.Session, tgt_url: str, username: str, password: str) -> str:
    try:
        response = session.post(tgt_url, data={"username": username, "password": password},
                                headers={"Accept": "text/plain"}, timeout=60)
    except requests.RequestException as exc:
        raise EpiasError("auth_failed", f"TGT request failed: {exc}") from exc
    if response.status_code in (401, 403):
        raise EpiasError("auth_failed", f"TGT rejected credentials (HTTP {response.status_code})")
    if response.status_code == 429:
        raise EpiasError("rate_limited", "TGT rate limited (HTTP 429)")
    if not response.ok:
        raise EpiasError("auth_failed", f"TGT failed (HTTP {response.status_code})")
    ticket = response.text.strip()
    if not ticket:
        raise EpiasError("auth_failed", "TGT response was empty")
    return ticket


def fetch_dam_page(session: requests.Session, url: str, ticket: str, dam_name: str,
                   basin_name: str | None, page: int) -> Any:
    body: dict[str, Any] = {"damName": dam_name, "page": page}
    if basin_name:
        body["basinName"] = basin_name
    try:
        response = session.post(url, headers={"TGT": ticket, "Accept": "application/json",
                                              "Content-Type": "application/json"},
                                json=body, timeout=90)
    except requests.RequestException as exc:
        raise EpiasError("endpoint_error", f"active-fullness request failed for {dam_name}: {exc}") from exc
    if response.status_code in (401, 403):
        raise EpiasError("access_denied", f"active-fullness denied (HTTP {response.status_code})")
    if response.status_code == 429:
        raise EpiasError("rate_limited", "active-fullness rate limited (HTTP 429)")
    if not response.ok:
        raise EpiasError(classify_http_error(response.status_code),
                         f"active-fullness failed (HTTP {response.status_code})")
    try:
        return response.json()
    except ValueError as exc:
        raise EpiasError("schema_error", f"active-fullness returned non-JSON for {dam_name}: {exc}") from exc


def extract_rows(payload: Any) -> tuple[list[dict[str, Any]], bool]:
    """Return (row dicts, has_more_pages). Tolerates envelope variants."""
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)], False
    if not isinstance(payload, dict):
        raise EpiasError("schema_error", f"unexpected active-fullness envelope: {type(payload).__name__}")
    for key in ("items", "data", "body", "results", "content"):
        nested = payload.get(key)
        if isinstance(nested, list):
            has_more = bool(payload.get("hasMore") or payload.get("hasNext"))
            page_info = payload.get("page") or {}
            if isinstance(page_info, dict) and page_info.get("totalPages") and page_info.get("number") is not None:
                try:
                    has_more = has_more or int(page_info["number"]) + 1 < int(page_info["totalPages"])
                except (TypeError, ValueError):
                    pass
            return [row for row in nested if isinstance(row, dict)], has_more
    raise EpiasError("schema_error", f"active-fullness envelope has no row list (keys: {sorted(payload)})")


def normalize_row(row: dict[str, Any], fetched_at: str) -> dict[str, Any]:
    percent = to_number(first_present(row, PERCENT_KEYS))
    active_vol = to_number(first_present(row, VOLUME_KEYS))
    min_vol = to_number(first_present(row, MIN_VOLUME_KEYS))
    max_vol = to_number(first_present(row, MAX_VOLUME_KEYS))
    derived = None
    if percent is None and active_vol is not None and min_vol is not None and max_vol is not None and max_vol > min_vol:
        # Field semantics: activeVolume is the CURRENT absolute reservoir
        # volume -> (current - min) / (max - min). Workbook "Aktif Hacim" is a
        # different field (active-storage amount) handled in build_hes177.py.
        derived = max(0.0, min(100.0, (active_vol - min_vol) / (max_vol - min_vol) * 100))
    return canonical_observation(
        provider="epias",
        provider_target_id=str(first_present(row, ("damId", "id"))) if first_present(row, ("damId", "id")) is not None else None,
        observed_at=str(first_present(row, DATE_KEYS)) if first_present(row, DATE_KEYS) is not None else None,
        source_class="official_live",
        fullness_percent=percent if percent is not None else derived,
        volume_hm3=active_vol,
        dam_name=str(first_present(row, DAM_KEYS)) if first_present(row, DAM_KEYS) is not None else None,
        basin_name=str(first_present(row, BASIN_KEYS)) if first_present(row, BASIN_KEYS) is not None else None,
        source_url="https://seffaflik.epias.com.tr/",
        product="dams-active-fullness",
        raw={"activeVolumeHm3": active_vol, "minVolumeHm3": min_vol, "maxVolumeHm3": max_vol,
             "derivedFromCurrentVolume": derived is not None and percent is None, "fetchedAt": fetched_at},
    )


def fetch_active_fullness(dam_queries: list[dict[str, str]], *, base_url: str | None = None,
                          tgt_url: str | None = None, username: str | None = None,
                          password: str | None = None, endpoint: str | None = None,
                          max_pages_per_dam: int = 50, request_gap_s: float = 0.4) -> dict[str, Any]:
    """Fetch active fullness for each dam query. Returns envelope with
    ``status``/``errorCode``/``observations``. Never raises for transport
    errors — they are classified into the envelope."""
    fetched_at = utc_now()
    username = username if username is not None else os.getenv("EPIAS_USERNAME")
    password = password if password is not None else os.getenv("EPIAS_PASSWORD")
    if not username or not password:
        return {"status": "skipped", "errorCode": "credentials_missing", "fetchedAt": fetched_at,
                "observations": [], "errors": ["EPIAS_USERNAME/EPIAS_PASSWORD are not configured"]}
    tgt = tgt_url or os.getenv("EPIAS_TGT_URL") or DEFAULT_TGT_URL
    url = endpoint or os.getenv("EPIAS_DAM_ENDPOINT") or (base_url or os.getenv("EPIAS_BASE_URL") or DEFAULT_BASE_URL).rstrip("/") + ACTIVE_FULLNESS_PATH
    session = requests.Session()
    try:
        ticket = request_ticket(session, tgt, username, password)
    except EpiasError as exc:
        return {"status": "error", "errorCode": exc.code, "fetchedAt": fetched_at,
                "observations": [], "errors": [str(exc)]}
    observations: list[dict[str, Any]] = []
    errors: list[str] = []
    error_code: str | None = None
    for query in dam_queries:
        dam_name = str(query.get("damName") or "").strip()
        basin_name = str(query.get("basinName") or "").strip() or None
        if not dam_name:
            continue
        page = 0
        try:
            while page < max_pages_per_dam:
                payload = fetch_dam_page(session, url, ticket, dam_name, basin_name, page)
                rows, has_more = extract_rows(payload)
                for row in rows:
                    observations.append(normalize_row(row, fetched_at))
                if not has_more:
                    break
                page += 1
                sleep_between_requests(request_gap_s)
        except EpiasError as exc:
            error_code = error_code or exc.code
            errors.append(str(exc))
        sleep_between_requests(request_gap_s)
    if not observations and error_code:
        return {"status": "error", "errorCode": error_code, "fetchedAt": fetched_at,
                "observations": [], "errors": errors}
    if not observations:
        return {"status": "empty", "errorCode": "empty_result", "fetchedAt": fetched_at,
                "observations": [], "errors": errors or ["active-fullness returned no rows"]}
    return {"status": "ok" if not errors else "partial", "errorCode": error_code,
            "fetchedAt": fetched_at, "observations": observations, "errors": errors,
            "endpoint": url}

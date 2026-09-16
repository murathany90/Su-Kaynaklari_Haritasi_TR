"""Normalize fullness provenance and publish one small runtime snapshot.

This job intentionally publishes no synthetic production values. Inventory
volume calculations are marked as estimated/calculated, while unavailable
plants remain N/A until a verifiable source is configured.
"""

from __future__ import annotations

import csv
import json
import math
import os
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import sys as _sys

sys_path = Path(__file__).resolve().parent
if str(sys_path) not in _sys.path:
    _sys.path.insert(0, str(sys_path))

from matching import MAX_DISTANCE_KM, match_candidates
from providers import OBS_DIR as PROVIDER_OBS_DIR, classify_provider_health, dedupe_key, usable_observations
from storage_types import classify_storage, is_run_of_river

ROOT = Path(__file__).resolve().parents[2]
HES_PATH = ROOT / "public/data/hes177/hes_177.geojson"
MANIFEST_PATH = ROOT / "public/data/hes177/hes_177_manifest.json"
EPIAS_PATH = ROOT / "public/data/live/epias_dams_latest.json"
EPIAS_LKG_PATH = ROOT / "public/data/live/epias_dams_last_known_good.json"
EPIAS_OBS_PATH = PROVIDER_OBS_DIR / "epias_active_fullness.json"
LIVE_PATH = ROOT / "public/data/live/hes_fullness_latest.json"
AUDIT_PATH = ROOT / "public/data/hes177/fullness_source_audit.json"
RESERVOIRS_PATH = ROOT / "public/data/hes177/hes_reservoirs.geojson"
OBSERVATION_CATALOG_PATH = ROOT / "public/data/static/mappings/observation_catalogs.json"
HYPSOMETRY_PATH = ROOT / "public/data/static/mappings/reservoir_hypsometry.json"
CSV_PATH = ROOT / "reports/fullness_source_audit.csv"
MD_PATH = ROOT / "reports/fullness_source_audit.md"
MISSING_PATH = ROOT / "reports/fullness_missing_sources.json"
HISTORY_ROOT = ROOT / "public/data/history/fullness"
TIMESERIES_ROOT = ROOT / "public/data/timeseries"
HEALTH_PATH = ROOT / "public/data/health/hydrology_status.json"
REJECTED_PATH = ROOT / "public/data/quality/fullness_rejected.json"
DAM_RESERVOIR_MAP_PATH = ROOT / "public/data/static/mappings/hes_dam_reservoir_map.json"

PROVIDER_LABELS = {
    "epias": "EPİAŞ", "dsi": "DSİ", "dahiti": "DAHITI", "hydroweb": "Hydroweb",
    "copernicus": "Copernicus CLMS", "swot": "NASA SWOT", "g_realm": "G-REALM",
    "sentinel": "Sentinel-2", "canonical": "Envanter", "mock": "MOCK",
}

# Provider freshness policy: (stale_after_days, old_after_days).
# EPİAŞ daily feed: >2d stale, >7d old. SWOT revisits are sparse: wider gates.
PROVIDER_FRESHNESS_DAYS = {
    "epias": (2, 7), "dsi": (7, 30), "dahiti": (14, 45), "hydroweb": (14, 45),
    "copernicus": (14, 45), "swot": (60, 180), "sentinel": (14, 45),
    "canonical": (10, 30), "mock": (0, 0),
}

PROVIDER_OBS_FILES = {
    "epias": "epias_active_fullness.json", "dsi": "dsi_levels.json",
    "hydroweb": "hydroweb_levels.json",
    "copernicus": "copernicus_lwl.json", "dahiti": "dahiti_levels.json",
    "swot": "swot_levels.json", "sentinel": "sentinel2_area.json",
}

PROVIDER_SOURCE_CLASS = {
    "epias": "official_live", "dsi": "official_published",
    "hydroweb": "satellite_altimetry",
    "copernicus": "satellite_altimetry", "dahiti": "satellite_altimetry",
    "swot": "satellite_altimetry", "sentinel": "satellite_area",
}

# Resolver order (source-class priority lives in SOURCE_CLASS_PRIORITY):
# EPİAŞ official_live -> DSİ official_published -> Hydroweb/Copernicus/DAHITI
# -> SWOT/Sentinel -> calculated_storage -> unavailable.

MISSING_REASONS = ("not_applicable", "missing_inventory_volume", "missing_hypsometry",
                   "reservoir_not_mapped", "provider_not_configured", "matched_no_measurement",
                   "storage_type_unknown", "no_verified_source")

# User-facing Turkish sentences per reason code (mirrored in
# src/data/fullnessSources.ts reasonDisplayText; never show raw codes).
REASON_TR = {
    "not_applicable": "Doluluk uygulanamaz",
    "missing_inventory_volume": "Doluluk hesabı için hacim verisi eksik",
    "missing_hypsometry": "Kot-hacim eğrisi eksik",
    "reservoir_not_mapped": "Rezervuar eşleşmesi bulunamadı",
    "provider_not_configured": "Canlı veri kaynağı yapılandırılmamış",
    "matched_no_measurement": "Güncel ölçüm bulunamadı",
    "storage_type_unknown": "Tesis tipi doğrulanamadı",
    "no_verified_source": "Doğrulanmış veri yok",
}


def read_obs_file(provider_name: str) -> dict[str, Any]:
    """Provider observation file payload ({} when the fetcher never ran)."""
    path = PROVIDER_OBS_DIR / PROVIDER_OBS_FILES.get(provider_name, f"{provider_name}.json")
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {"status": "skipped", "errorCode": "unreadable_output", "observations": []}


def provider_health_snapshot(provider_obs: dict[str, list[dict[str, Any]]],
                             epias_payload: dict[str, Any]) -> dict[str, Any]:
    """Classify every provider as healthy | healthy_empty | skipped | failed.

    A provider without credentials (or a disabled/opt-in one) is *skipped*,
    never healthy — catalogue metadata alone does not count as a call.
    """
    healthy: list[str] = []
    healthy_empty: list[str] = []
    skipped: dict[str, str] = {}
    failed: dict[str, str] = {}
    try:
        catalog_registry = (json.loads(OBSERVATION_CATALOG_PATH.read_text(encoding="utf-8")).get("sourceRegistry", {}))
    except (OSError, json.JSONDecodeError):
        catalog_registry = {}
    names = sorted(set(PROVIDER_OBS_FILES) | {"epias", "dsi"})
    for name in names:
        rows = provider_obs.get(name, [])
        called = bool(rows) or (PROVIDER_OBS_DIR / PROVIDER_OBS_FILES.get(name, "")).exists()
        obs = read_obs_file(name)
        status: str | None = obs.get("status") if obs else None
        code: str | None = obs.get("errorCode") if obs else None
        if name == "epias" and not obs:
            # Legacy runtime file (the resolver reads it for records).
            legacy_status = str(epias_payload.get("status") or "")
            called = called or bool(epias_payload)
            mapping = {"requires_access": ("skipped", "credentials_missing"),
                       "requires_endpoint": ("skipped", "endpoint_not_configured"),
                       "ok": ("ok", None), "partial": ("partial", None),
                       "empty": ("empty", None), "failed": ("failed", "endpoint_error")}
            status, code = mapping.get(legacy_status, ("skipped", "endpoint_not_configured"))
            legacy_rows = epias_payload.get("records", []) if isinstance(epias_payload.get("records"), list) else []
            # Legacy runtime shape uses activeFullness; normalize for usability.
            rows = [{"fullnessPercent": r.get("activeFullness"), "observedAt": r.get("observedAt")}
                    if isinstance(r, dict) else {} for r in legacy_rows]
        usable = usable_observations(rows) if isinstance(rows, list) else 0
        category = classify_provider_health(called=called, status=status, error_code=code, usable=usable)
        if category == "healthy":
            healthy.append(name)
        elif category == "healthy_empty":
            healthy.append(name)
            healthy_empty.append(name)
        elif category == "skipped":
            if code:
                skipped[name] = code
            elif name == "sentinel":
                skipped[name] = "disabled_opt_in"
            elif (catalog_registry.get(name) or {}).get("credentialsConfigured") is False:
                skipped[name] = "credentials_missing"
            else:
                skipped[name] = "endpoint_not_configured"
        else:
            failed[name] = code or "endpoint_error"
    return {"healthy": sorted(healthy), "healthy_empty": sorted(healthy_empty),
            "skipped": skipped, "failed": failed}


def provider_query_state() -> tuple[list[str], dict[str, str]]:
    """Split providers into actually-queried vs skipped-with-reason.

    A provider counts as checked only when its fetcher really ran (obs file
    with a terminal status, or the always-run EPİAŞ/DSİ/corp discovery jobs).
    Credential-skipped providers go to ``skipped`` with their reason.
    """
    checked: list[str] = []
    skipped: dict[str, str] = {}
    try:
        catalog = json.loads(OBSERVATION_CATALOG_PATH.read_text(encoding="utf-8"))
        registry = catalog.get("sourceRegistry", {})
    except (OSError, json.JSONDecodeError):
        registry = {}
    # EPİAŞ + DSİ fetchers run on schedule (legacy EPİAŞ file / public DSİ
    # aggregates), so they always count as queried when their output exists.
    legacy_epias = ROOT / "public" / "data" / "live" / "epias_dams_latest.json"
    if legacy_epias.exists():
        checked.append("epias")
    for provider_name, filename in PROVIDER_OBS_FILES.items():
        path = PROVIDER_OBS_DIR / filename
        if not path.exists():
            if provider_name == "epias":
                continue
            if provider_name == "dsi":
                skipped[provider_name] = "dsi_fetch_never_ran"
                continue
            if provider_name == "sentinel":
                skipped[provider_name] = "disabled_opt_in (SENTINEL2_ENABLED!=1)"
                continue
            configured = (registry.get(provider_name) or {}).get("credentialsConfigured")
            skipped[provider_name] = "credentials_missing" if configured is False else "fetcher_output_missing"
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            skipped[provider_name] = "unreadable_output"
            continue
        status = str(payload.get("status") or "")
        if status == "skipped":
            skipped[provider_name] = str(payload.get("errorCode") or "skipped")
        elif provider_name not in checked:
            checked.append(provider_name)
    return sorted(set(checked)), skipped


def provider_of(source: Any) -> str:
    value = str(source or "canonical")
    return value if value in PROVIDER_LABELS else "canonical"


def freshness_label(provider: str, age_days: int | None) -> str:
    if age_days is None:
        return "unknown"
    stale_after, old_after = PROVIDER_FRESHNESS_DAYS.get(provider, (10, 30))
    if age_days > old_after:
        return "old"
    if age_days > stale_after:
        return "stale"
    return "fresh"

FRESHNESS_POLICY_DAYS = {
    "official_live": 3,
    "official_published": 10,
    "satellite_altimetry": 45,
    "satellite_area": 14,
    "calculated_storage": 10,
    "historical": 365,
    "mock": 0,
}

SOURCE_CLASS_PRIORITY = {
    "official_live": 0,
    "official": 0,
    "official_published": 1,
    "satellite_altimetry": 2,
    "satellite_area": 2,
    "calculated_storage": 3,
    "historical": 4,
    "mock": 9,
}

CONFIDENCE_PRIORITY = {"high": 3, "medium": 2, "low": 1}


def method_priority(method: Any) -> int:
    value = str(method or "").lower()
    if re.search(r"direct|normalized|official|epias|dsi", value):
        return 0
    if re.search(r"satellite|altimetry|wse|hypsometry|area", value):
        return 1
    if re.search(r"volume|inventory|canonical|storage", value):
        return 2
    if re.search(r"historical|last-known-good", value):
        return 3
    return 4


def number(value: Any) -> float | None:
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    except (TypeError, ValueError):
        return None


def clamp(value: float | None) -> float | None:
    return None if value is None else max(0.0, min(100.0, value))


def valid_percent(value: float | None) -> float | None:
    return value if value is not None and 0 <= value <= 100 else None


def observed_date(value: Any) -> str | None:
    if value in (None, ""):
        return None
    raw = number(value)
    if raw is not None and raw > 20000:
        return (datetime(1899, 12, 30, tzinfo=timezone.utc) + timedelta(days=raw)).date().isoformat()
    text = str(value).strip()
    return text if text else None


def parse_datetime(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = datetime.fromisoformat(observed_date(text) or "")
        except ValueError:
            return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def freshness_days(observed_at: Any, fetched_at: str, explicit: Any = None) -> int | None:
    if explicit not in (None, ""):
        try:
            return max(0, int(float(explicit)))
        except (TypeError, ValueError):
            pass
    observed = parse_datetime(observed_at)
    fetched = parse_datetime(fetched_at)
    if not observed or not fetched:
        return None
    return max(0, (fetched.date() - observed.date()).days)


def source_class(record: dict[str, Any]) -> str:
    value = str(record.get("sourceClass") or "calculated_storage")
    return "official_live" if value == "official" and str(record.get("source") or "") == "epias" else value


def record_is_usable(record: dict[str, Any] | None) -> bool:
    if not record or record.get("status") == "not_applicable":
        return False
    value = number(record.get("fullnessPercent"))
    return value is not None and 0 <= value <= 100


def select_best_fullness_record(records: list[dict[str, Any]], now: str | None = None) -> dict[str, Any] | None:
    """Choose a record using source class, freshness, confidence and observation time.

    This function is deliberately independent from file I/O so it can be used
    by regression checks and by future source adapters.
    """
    reference = parse_datetime(now) or datetime.now(timezone.utc)
    candidates: list[tuple[tuple[int, int, int, float, float], dict[str, Any]]] = []
    for record in records:
        if not record_is_usable(record):
            continue
        class_name = source_class(record)
        observed = parse_datetime(record.get("observedAt"))
        if observed and observed > reference + timedelta(days=1):
            continue
        age = freshness_days(record.get("observedAt"), now or reference.isoformat(), record.get("freshnessDays"))
        threshold = FRESHNESS_POLICY_DAYS.get(class_name, 10)
        stale = record.get("status") == "stale" or (age is not None and age > threshold)
        priority = 4 if stale and class_name in {"official_live", "official", "official_published", "satellite_altimetry", "satellite_area"} else SOURCE_CLASS_PRIORITY.get(class_name, 8)
        confidence = CONFIDENCE_PRIORITY.get(str(record.get("confidence") or "low"), 1)
        # Lower tuple values win. Recent observations and high confidence win
        # only after source class and freshness have been considered.
        candidates.append(((priority, method_priority(record.get("method")), -confidence, -(observed.timestamp() if observed else 0), -float(age or 0)), record))
    return min(candidates, key=lambda item: item[0])[1] if candidates else None


def mark_last_known_good(record: dict[str, Any], fetched_at: str) -> dict[str, Any]:
    result = dict(record)
    age = freshness_days(result.get("observedAt"), fetched_at, None)
    class_name = source_class(result)
    threshold = FRESHNESS_POLICY_DAYS.get(class_name, 10)
    result["sourceClass"] = class_name
    result["status"] = "stale" if age is None or age > threshold or result.get("status") == "stale" else "available"
    result["fetchedAt"] = fetched_at
    result["freshnessDays"] = age
    result["qualityFlags"] = sorted(set([*(result.get("qualityFlags") or []), "last_known_good"]))
    result["method"] = f"{result.get('method') or 'source-normalized'} · last-known-good"
    return result


def complete_fullness_record(record: dict[str, Any]) -> dict[str, Any]:
    result = dict(record)
    result["provider"] = result.get("provider") or PROVIDER_LABELS.get(provider_of(result.get("source")), str(result.get("source") or "Envanter"))
    result.setdefault("sourcePublishedAt", None)
    result.setdefault("rawValue", result.get("fullnessPercent"))
    result.setdefault("rawUnit", "%" if result.get("fullnessPercent") is not None else None)
    result.setdefault("uncertainty", None)
    result.setdefault("sourceUrl", None)
    result.setdefault("sourceStationId", None)
    result.setdefault("qualityFlags", [])
    result["freshnessLabel"] = result.get("freshnessLabel") or freshness_label(provider_of(result.get("source")), result.get("freshnessDays"))
    result["observationTimestamp"] = result.get("observationTimestamp") or result.get("observedAt")
    # Canonical output contract: missing values are null, never 0.
    if result.get("fullnessPercent") is None:
        result["fullnessPercent"] = None
    return result


def rejected_observations(hes: dict[str, Any], source: dict[str, Any] | None, fetched_at: str) -> list[dict[str, Any]]:
    props = hes.get("properties") or {}
    hes_id = str(props.get("id") or hes.get("id") or "")
    rejected: list[dict[str, Any]] = []
    if source:
        for key in ("fullnessPercent", "occupancy", "fullness", "activeFullness", "activeFullnessAmount", "doluluk"):
            value = number(source.get(key))
            if value is not None and not 0 <= value <= 100:
                rejected.append({"hesId": hes_id, "source": "epias", "field": key, "value": value, "reason": "fullness_out_of_range", "rejectedAt": fetched_at})
        observed = parse_datetime(source.get("observedAt") or source.get("date") or source.get("timestamp"))
        reference = parse_datetime(fetched_at)
        if observed and reference and observed > reference + timedelta(days=1):
            rejected.append({"hesId": hes_id, "source": "epias", "field": "observedAt", "value": observed.isoformat(), "reason": "observation_in_future", "rejectedAt": fetched_at})
    minimum = first_number(props, ["minVolumeHm3", "minimumVolumeHm3", "minVolume", "minimumVolume"])
    maximum = first_number(props, ["maxVolumeHm3", "maximumVolumeHm3", "maxVolume", "maximumVolume"])
    active = first_number(props, ["activeVolumeHm3", "activeVolume", "active_volume", "aktifHacim", "aktif_hacim"])
    if minimum is not None and maximum is not None and maximum <= minimum:
        rejected.append({"hesId": hes_id, "source": "canonical", "field": "volumeBounds", "value": {"min": minimum, "max": maximum}, "reason": "impossible_volume_bounds", "rejectedAt": fetched_at})
    if active is not None and maximum is not None and (active < 0 or active > maximum):
        rejected.append({"hesId": hes_id, "source": "canonical", "field": "activeVolumeHm3", "value": active, "reason": "active_volume_out_of_bounds", "rejectedAt": fetched_at})
    return rejected


def first_number(source: dict[str, Any], keys: list[str]) -> float | None:
    for key in keys:
        value = number(source.get(key))
        if value is not None:
            return value
    return None


def normalize(value: Any) -> str:
    text = "".join(character for character in unicodedata.normalize("NFKD", str(value or "").upper()) if not unicodedata.combining(character))
    text = re.sub(r"\b(HES|BARAJI|BARAJ|SANTRALI|SANTRAL|RESERVOIR|DAM|LAKE)\b", " ", text)
    return re.sub(r"[^A-Z0-9]+", " ", text).strip()


def point_of(feature: dict[str, Any]) -> tuple[float, float] | None:
    coordinates = ((feature.get("geometry") or {}).get("coordinates") or [])
    if (feature.get("geometry") or {}).get("type") != "Point" or len(coordinates) < 2:
        return None
    try:
        return float(coordinates[0]), float(coordinates[1])
    except (TypeError, ValueError):
        return None


def distance_km(left: tuple[float, float], right: tuple[float, float]) -> float:
    radius = 6371.0088
    lon1, lat1, lon2, lat2 = map(math.radians, (*left, *right))
    delta_lon, delta_lat = lon2 - lon1, lat2 - lat1
    haversine = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return radius * 2 * math.asin(math.sqrt(haversine))


def catalog_matches(hes: dict[str, Any], catalog_records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Discovery-catalog matches via the central matcher (name + coordinate,
    30 km veto enforced). Approximate transformer/unresolved geometries are
    excluded from spatial matching."""
    props = hes.get("properties") or {}
    if props.get("coordinateKind") in {"transformer", "unresolved"}:
        return {}
    matches: dict[str, dict[str, Any]] = {}
    for record in catalog_records:
        source = str(record.get("source") or "")
        try:
            record_point = (float(record.get("lon")), float(record.get("lat")))
        except (TypeError, ValueError):
            continue
        verdict, _ = match_candidates(hes, [{**record, "lon": record_point[0], "lat": record_point[1]}], provider=source)
        if verdict is None or verdict.get("rejected"):
            continue
        current = matches.get(source)
        ranked = (0 if verdict["matchMethod"].startswith("name") or verdict["matchMethod"] == "reservoir-polygon" else 1,
                  verdict.get("distanceKm") if verdict.get("distanceKm") is not None else 1e9)
        if current is None or ranked < current["rank"]:
            matches[source] = {"record": record, "distanceKm": verdict.get("distanceKm"),
                               "method": verdict["matchMethod"], "confidence": verdict["matchConfidence"], "rank": ranked}
    for match in matches.values():
        match.pop("rank", None)
    return matches


def load_provider_observations() -> dict[str, list[dict[str, Any]]]:
    """Read canonical provider observation files (may be skipped/empty)."""
    observations: dict[str, list[dict[str, Any]]] = {}
    for provider, filename in PROVIDER_OBS_FILES.items():
        path = PROVIDER_OBS_DIR / filename
        if not path.exists():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        rows = payload.get("observations", []) if isinstance(payload, dict) else []
        observations[provider] = [row for row in rows if isinstance(row, dict)]
    return observations


def load_hypsometry() -> dict[str, dict[str, Any]]:
    try:
        payload = json.loads(HYPSOMETRY_PATH.read_text(encoding="utf-8"))
        curves = payload.get("curves", {}) if isinstance(payload, dict) else {}
        return curves if isinstance(curves, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def provider_candidates(hes: dict[str, Any], provider: str, rows: list[dict[str, Any]],
                        curves: dict[str, dict[str, Any]], fetched_at: str,
                        audit_fields: dict[str, Any], stats: dict[str, int]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Match provider rows to one HES and build candidate fullness records.

    Returns (candidates, rejections). Raw level/area without a validated
    hypsometry curve is published as data-availability signal only (percent
    stays None) — never an invented percentage.
    """
    props = hes.get("properties") or {}
    hes_id = str(props.get("id") or hes.get("id") or "")
    best, rejected_rows = match_candidates(hes, rows, provider=provider)
    rejections = [{"hesId": hes_id, "source": provider, "field": "providerTargetId",
                   "value": item.get("providerTargetId"), "reason": item.get("rejectReason", "match_rejected"),
                   "rejectedAt": fetched_at} for item in rejected_rows]
    stats["rejected"] += len(rejected_rows)
    if best is None:
        return [], rejections
    stats["matched"] += 1
    row = best.get("record") or {}
    observed = observed_date(row.get("observedAt"))
    age = freshness_days(observed, fetched_at)
    freshness = freshness_label(provider, age)
    source_class = PROVIDER_SOURCE_CLASS.get(provider, "satellite_altimetry")
    base = {"hesId": hes_id, "provider": PROVIDER_LABELS.get(provider, provider), "source": provider,
            "observedAt": observed, "observationTimestamp": observed, "fetchedAt": fetched_at,
            "freshnessDays": age, "freshnessLabel": freshness,
            "sourceUrl": row.get("sourceUrl"), "sourceStationId": row.get("providerTargetId"),
            "matchMethod": best.get("matchMethod"), "matchConfidence": best.get("matchConfidence"),
            "distanceKm": best.get("distanceKm"), "providerTargetId": best.get("providerTargetId"),
            "canonicalHesId": hes_id, **audit_fields}
    # Catalogue-only metadata (no level/area/percent) is NOT an observation:
    # skip it here so it can never become a percentage downstream.
    raw_percent = number(row.get("fullnessPercent"))
    has_measure = (number(row.get("waterLevelM")) is not None or number(row.get("surfaceAreaKm2")) is not None
                   or raw_percent is not None)
    if not has_measure:
        raw_reason = str((row.get("raw") or {}).get("reason") or "")
        reason = "measurement_not_parsed" if "NetCDF" in raw_reason or "not parsed" in raw_reason else "matched_no_measurement"
        stats["rejected"] += 1
        return [], [{"hesId": hes_id, "source": provider, "field": "providerTargetId",
                     "value": best.get("providerTargetId"), "reason": reason,
                     "rejectedAt": fetched_at}]
    if raw_percent is not None and not 0 <= raw_percent <= 100:
        # Out-of-range provider value: preserved in the rejection, never fed
        # to the resolver (the resolver decides via record_is_usable).
        stats["rejected"] += 1
        return [], [{"hesId": hes_id, "source": provider, "field": "fullnessPercent",
                     "value": raw_percent, "reason": "volume_out_of_range",
                     "rejectedAt": fetched_at}]
    direct = valid_percent(number(row.get("fullnessPercent")))
    candidates: list[dict[str, Any]] = []
    if direct is not None:
        # Direct provider percentage (e.g. EPİAŞ active fullness).
        stale_after, _ = PROVIDER_FRESHNESS_DAYS.get(provider, (10, 30))
        estimated = row.get("isEstimated")
        estimated = bool(estimated) if estimated is not None else False
        candidates.append({**base, "fullnessPercent": direct,
                           "status": "stale" if age is not None and age > stale_after else "available",
                           "sourceClass": source_class,
                           "method": f"{provider}-direct-percent" if provider != "epias" else "epias-normalized-percent",
                           "confidence": "high" if best.get("matchConfidence") == "high" else "medium",
                           "isEstimated": estimated, "rawValue": direct, "rawUnit": "%",
                           "qualityFlags": [f"matched-{best.get('matchMethod')}"]})
        stats["usable"] += 1
        return candidates, rejections
    curve = curves.get(hes_id)
    minimum = first_number(props, ["minVolumeHm3", "minimumVolumeHm3", "minVolume", "minimumVolume"])
    maximum = first_number(props, ["maxVolumeHm3", "maximumVolumeHm3", "maxVolume", "maximumVolume"])
    percent, note = (None, "no-volume-curve")
    if curve:
        percent, note = hypsometry_percent(curve, number(row.get("waterLevelM")), number(row.get("surfaceAreaKm2")), minimum, maximum)
    if percent is not None:
        stale_after, _ = PROVIDER_FRESHNESS_DAYS.get(provider, (14, 45))
        candidates.append({**base, "fullnessPercent": percent,
                           "status": "stale" if age is not None and age > stale_after else "available",
                           "sourceClass": source_class, "method": f"{provider}-{note}",
                           "confidence": "high" if best.get("matchConfidence") == "high" else "medium",
                           "isEstimated": True, "rawValue": row.get("waterLevelM") if row.get("waterLevelM") is not None else row.get("surfaceAreaKm2"),
                           "rawUnit": "m" if row.get("waterLevelM") is not None else "km2",
                           "uncertainty": number(row.get("uncertainty")),
                           "qualityFlags": [f"matched-{best.get('matchMethod')}", "hypsometry-derived"]})
        stats["usable"] += 1
    else:
        # Availability signal only: level/area exists but no validated curve.
        candidates.append({**base, "fullnessPercent": None, "status": "unavailable",
                           "sourceClass": source_class, "method": f"{provider}-{note}-no-percent",
                           "confidence": "low", "isEstimated": False,
                           "rawValue": row.get("waterLevelM") if row.get("waterLevelM") is not None else row.get("surfaceAreaKm2"),
                           "rawUnit": "m" if row.get("waterLevelM") is not None else "km2" if row.get("surfaceAreaKm2") is not None else None,
                           "uncertainty": number(row.get("uncertainty")),
                           "reasonUnavailable": f"{PROVIDER_LABELS.get(provider, provider)} gözlemi var ancak doğrulanmış kot-hacim eğrisi yok",
                           "qualityFlags": [f"matched-{best.get('matchMethod')}", "no-hypsometry-no-percent"]})
    return candidates, rejections


def explicit_percent(source: dict[str, Any]) -> float | None:
    # In the source payload this field is a fullness percentage; physical
    # volume fields are handled separately by volume_percent().
    return valid_percent(first_number(source, ["fullnessPercent", "occupancy", "fullness", "activeFullness", "activeFullnessAmount", "doluluk"]))


def volume_percent_raw(source: dict[str, Any]) -> tuple[float | None, str | None]:
    """Workbook 'Aktif Hacim' semantics: active-storage amount over the active
    range -> active / (max - min). Returns (raw_value, warning)."""
    active = first_number(source, ["activeVolumeHm3", "activeVolume", "active_volume", "aktifHacim", "aktif_hacim"])
    minimum = first_number(source, ["minVolumeHm3", "minimumVolumeHm3", "minVolume", "minimumVolume"])
    maximum = first_number(source, ["maxVolumeHm3", "maximumVolumeHm3", "maxVolume", "maximumVolume"])
    if active is None or minimum is None or maximum is None or maximum <= minimum:
        return None, None
    raw = active / (maximum - minimum) * 100
    if raw > 100 or raw < 0:
        return raw, f"volume_out_of_range:{raw:.1f}"
    return raw, None


def volume_percent(source: dict[str, Any]) -> float | None:
    raw, _ = volume_percent_raw(source)
    return clamp(raw)


def current_volume_percent_raw(source: dict[str, Any]) -> tuple[float | None, str | None]:
    """Current absolute reservoir volume semantics: (current - min) / (max - min)."""
    current = first_number(source, ["currentVolumeHm3", "currentVolume", "current_volume", "dailyVolume", "daily_volume", "operatingVolume", "operating_volume", "hacim", "volume", "suHacmi"])
    minimum = first_number(source, ["minVolumeHm3", "minimumVolumeHm3", "minVolume", "minimumVolume"])
    maximum = first_number(source, ["maxVolumeHm3", "maximumVolumeHm3", "maxVolume", "maximumVolume"])
    if current is None or minimum is None or maximum is None or maximum <= minimum:
        return None, None
    raw = (current - minimum) / (maximum - minimum) * 100
    if raw > 100 or raw < 0:
        return raw, f"volume_out_of_range:{raw:.1f}"
    return raw, None


def current_volume_percent(source: dict[str, Any]) -> float | None:
    raw, _ = current_volume_percent_raw(source)
    return clamp(raw)


def hypsometry_percent(curve: dict[str, Any], level_m: float | None, area_km2: float | None,
                       min_volume: float | None, max_volume: float | None) -> tuple[float | None, str]:
    """Level/area -> volume via a validated curve, then volume -> %.
    Returns (percent, method_note). No curve -> (None, reason)."""
    levels = curve.get("levelsM") or []
    volumes = curve.get("volumesHm3") or []
    if not levels or not volumes or len(levels) != len(volumes) or len(levels) < 2:
        return None, "no-volume-curve"
    probe = None
    if level_m is not None:
        probe, axis = level_m, levels
    elif area_km2 is not None and curve.get("areasKm2") and len(curve["areasKm2"]) == len(levels):
        # area -> level via the same curve, then level -> volume below
        areas = curve["areasKm2"]
        probe, axis = area_km2, areas
        pairs = sorted(zip(axis, levels))
        probe = _interp(probe, [p[0] for p in pairs], [p[1] for p in pairs])
        if probe is None:
            return None, "area-outside-curve"
        axis = levels
    else:
        return None, "no-level-or-area"
    pairs = sorted(zip(axis, volumes))
    volume = _interp(probe, [p[0] for p in pairs], [p[1] for p in pairs])
    if volume is None or min_volume is None or max_volume is None or max_volume <= min_volume:
        return None, "volume-outside-curve" if volume is None else "missing-volume-bounds"
    raw = (volume - min_volume) / (max_volume - min_volume) * 100
    if raw > 100 or raw < 0:
        return clamp(raw), "hypsometry-clamped-out-of-range"
    return raw, "level-area-volume-curve"


def _interp(x: float, xs: list[float], ys: list[float]) -> float | None:
    if x < xs[0] or x > xs[-1]:
        return None
    for index in range(len(xs) - 1):
        if xs[index] <= x <= xs[index + 1]:
            span = xs[index + 1] - xs[index]
            ratio = 0.0 if span == 0 else (x - xs[index]) / span
            return ys[index] + ratio * (ys[index + 1] - ys[index])
    return ys[-1]


def epias_record(records: list[dict[str, Any]], hes: dict[str, Any]) -> dict[str, Any] | None:
    props = hes.get("properties") or {}
    hes_id = str(props.get("id") or hes.get("id") or "")
    names = {str(props.get(key) or "").strip().casefold() for key in ("name", "damName")}
    for record in records:
        ids = {str(record.get(key) or "") for key in ("hesId", "hesID", "entityId", "entity_id")}
        record_names = {str(record.get(key) or "").strip().casefold() for key in ("name", "damName", "dam_name")}
        if hes_id in ids or names.intersection(record_names):
            return record
    return None


def make_result(
    hes: dict[str, Any],
    epias: dict[str, Any] | None,
    fetched_at: str,
    source_matches: dict[str, dict[str, Any]],
    previous: dict[str, Any] | None = None,
    provider_obs: dict[str, list[dict[str, Any]]] | None = None,
    curves: dict[str, dict[str, Any]] | None = None,
    provider_stats: dict[str, dict[str, int]] | None = None,
) -> dict[str, Any]:
    props = hes.get("properties") or {}
    hes_id = str(props.get("id") or hes.get("id") or "")
    storage = classify_storage(props)
    storage_legacy = props.get("hydroPlantStorageType", "unknown")
    audit_fields = {
        "epiasMatch": epias is not None,
        "dsiMatch": False,
        "dahitiMatch": "dahiti" in source_matches,
        "hydrowebMatch": "hydroweb" in source_matches,
        "copernicusMatch": "copernicus" in source_matches,
        "swotMatch": "swot" in source_matches,
        "gRealmMatch": "g_realm" in source_matches,
        "gdwMatch": bool(props.get("reservoirIds")),
        "candidateSourceCount": len(source_matches) + (1 if epias else 0) + (1 if props.get("reservoirIds") else 0),
        "bestCatalogSource": next(iter(source_matches), None),
        "bestCatalogMethod": next((match["method"] for match in source_matches.values()), None),
        "catalogConfidence": next((match["confidence"] for match in source_matches.values()), None),
        "bestCatalogSourceUrl": next((match["record"].get("catalogUrl") for match in source_matches.values()), None),
        "bestCatalogDistanceKm": next((match.get("distanceKm") for match in source_matches.values()), None),
        "waterLevelAvailable": False,
        "surfaceAreaAvailable": False,
        "volumeAvailable": bool(props.get("activeVolumeHm3") is not None and props.get("maxVolumeHm3") is not None),
        "hypsometryAvailable": False,
        "fullnessDirectlyAvailable": explicit_percent(epias) is not None if epias else False,
        "fullnessCanBeCalculated": volume_percent(props) is not None,
    }
    storage_fields = {"storageType": storage["storageType"], "storageTypeProvenance": storage["storageTypeProvenance"],
                      "storageTypeConfidence": storage["storageTypeConfidence"], "provider": "Envanter"}
    if is_run_of_river(props, storage):
        return complete_fullness_record({"hesId": hes_id, "fullnessPercent": None, "status": "not_applicable", "sourceClass": "calculated_storage", "source": "canonical", "method": "run-of-river-no-reservoir", "observedAt": None, "sourcePublishedAt": None, "fetchedAt": fetched_at, "freshnessDays": None, "freshnessLabel": "unknown", "confidence": "high", "isEstimated": False, "reasonUnavailable": "run-of-river santralinde rezervuar doluluğu uygulanamaz", "qualityFlags": ["storage_type_run_of_river"], **storage_fields, **audit_fields})

    candidates: list[dict[str, Any]] = []
    range_warnings: list[dict[str, Any]] = []
    if epias:
        value = explicit_percent(epias)
        if value is not None:
            observed = observed_date(epias.get("observedAt") or epias.get("date") or epias.get("timestamp"))
            age = freshness_days(observed, fetched_at)
            stale_after, _ = PROVIDER_FRESHNESS_DAYS["epias"]
            candidates.append({"hesId": hes_id, "fullnessPercent": value, "status": "stale" if age is not None and age > stale_after else "available", "sourceClass": "official_live", "source": "epias", "provider": "EPİAŞ", "method": "epias-normalized-percent", "observedAt": observed, "sourcePublishedAt": observed_date(epias.get("sourcePublishedAt") or epias.get("publishedAt")), "fetchedAt": fetched_at, "freshnessDays": age, "freshnessLabel": freshness_label("epias", age), "confidence": "high", "isEstimated": False, "rawValue": value, "rawUnit": "%", "sourceUrl": "https://seffaflik.epias.com.tr/", "qualityFlags": [], **storage_fields, **audit_fields})
        current_raw, current_warning = current_volume_percent_raw(epias)
        if current_raw is not None:
            if current_warning:
                range_warnings.append({"hesId": hes_id, "source": "epias", "field": "currentVolume%", "value": round(current_raw, 2), "reason": current_warning, "rejectedAt": fetched_at})
            current_value = clamp(current_raw)
            observed = observed_date(epias.get("observedAt") or epias.get("date") or epias.get("timestamp"))
            age = freshness_days(observed, fetched_at)
            stale_after, _ = PROVIDER_FRESHNESS_DAYS["epias"]
            flags = ["derived_from_current_volume"] + ([current_warning] if current_warning else [])
            candidates.append({"hesId": hes_id, "fullnessPercent": current_value, "status": "stale" if age is not None and age > stale_after else "available", "sourceClass": "official_live", "source": "epias", "provider": "EPİAŞ", "method": "current-volume/(max-volume-min-volume)", "observedAt": observed, "sourcePublishedAt": observed_date(epias.get("sourcePublishedAt") or epias.get("publishedAt")), "fetchedAt": fetched_at, "freshnessDays": age, "freshnessLabel": freshness_label("epias", age), "confidence": "high", "isEstimated": True, "rawValue": current_value, "rawUnit": "%", "sourceUrl": "https://seffaflik.epias.com.tr/", "qualityFlags": flags, **storage_fields, **audit_fields})
    raw_value, range_warning = volume_percent_raw(props)
    if raw_value is not None:
        if range_warning:
            range_warnings.append({"hesId": hes_id, "source": "canonical", "field": "activeVolume%", "value": round(raw_value, 2), "reason": range_warning, "rejectedAt": fetched_at})
        value = clamp(raw_value)
        observed = observed_date(props.get("epiasDate"))
        age = freshness_days(observed, fetched_at)
        stale_after, _ = PROVIDER_FRESHNESS_DAYS["canonical"]
        flags = ["derived_from_inventory_volume"] + ([range_warning] if range_warning else [])
        candidates.append({"hesId": hes_id, "fullnessPercent": value, "status": "stale" if age is not None and age > stale_after else "available", "sourceClass": "calculated_storage", "source": "canonical", "provider": "Envanter", "method": "active-volume/(max-volume-min-volume)", "observedAt": observed, "sourcePublishedAt": None, "fetchedAt": fetched_at, "freshnessDays": age, "freshnessLabel": freshness_label("canonical", age), "confidence": "medium", "isEstimated": True, "rawValue": value, "rawUnit": "%", "qualityFlags": flags, **storage_fields, **audit_fields})
    provider_rejections: list[dict[str, Any]] = list(range_warnings)
    has_level_obs = False
    has_area_obs = False
    for provider_name, rows in (provider_obs or {}).items():
        stats = (provider_stats or {}).setdefault(provider_name, {"fetched": len(rows), "matched": 0, "usable": 0, "rejected": 0})
        stats["fetched"] = len(rows)
        new_candidates, new_rejections = provider_candidates(hes, provider_name, rows, curves or {}, fetched_at, {**storage_fields, **audit_fields}, stats)
        for candidate in new_candidates:
            # Raw measurement exists but no validated hypsometry: keep the
            # signal, never invent a percentage (candidate % stays None).
            if "no-hypsometry-no-percent" in (candidate.get("qualityFlags") or []):
                if candidate.get("rawUnit") == "m":
                    has_level_obs = True
                if candidate.get("rawUnit") == "km2":
                    has_area_obs = True
        candidates.extend(new_candidates)
        provider_rejections.extend(new_rejections)
    audit_fields["waterLevelAvailable"] = has_level_obs
    audit_fields["surfaceAreaAvailable"] = has_area_obs
    if record_is_usable(previous):
        candidates.append(mark_last_known_good(previous, fetched_at))
    selected = select_best_fullness_record(candidates, fetched_at)
    if selected:
        selected = {**selected, "waterLevelAvailable": has_level_obs, "surfaceAreaAvailable": has_area_obs}
        result = complete_fullness_record(selected)
        result["_providerRejections"] = provider_rejections
        return result
    reason = "katalog eşleşti ancak ölçüm indirme yetkisi yok" if source_matches else "EPİAŞ erişimi yok; doğrulanmış hacim/uydu serisi yok"
    result = complete_fullness_record({"hesId": hes_id, "fullnessPercent": None, "status": "unavailable", "sourceClass": "calculated_storage", "source": "canonical", "provider": "Envanter", "method": "no-verified-fullness-source", "observedAt": None, "sourcePublishedAt": None, "fetchedAt": fetched_at, "freshnessDays": None, "freshnessLabel": "unknown", "confidence": "low", "isEstimated": False, "reasonUnavailable": reason, "qualityFlags": ["no_data"], **storage_fields, **audit_fields})
    result["_providerRejections"] = provider_rejections
    return result


def read_payload(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_payload(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def environment_boolean(name: str) -> bool | None:
    value = os.getenv(name)
    if value is None:
        return None
    return value.strip().lower() in {"1", "true", "yes", "y"}


def merge_daily_snapshot(path: Path, payload: dict[str, Any], fetched_at: str) -> dict[str, Any]:
    previous = read_payload(path)
    previous_records = {str(record.get("hesId")): record for record in previous.get("records", []) if isinstance(record, dict)}
    merged: list[dict[str, Any]] = []
    for record in payload.get("records", []):
        hes_id = str(record.get("hesId"))
        old = previous_records.get(hes_id)
        best = select_best_fullness_record([record, old] if old else [record], fetched_at)
        if best is old and best is not None:
            best = mark_last_known_good(best, fetched_at)
        merged.append(best or record)
    merged.sort(key=lambda record: str(record.get("hesId", "")))
    revisions = int(previous.get("revision") or 0) + 1
    return {**payload, "revision": revisions, "records": merged}


def snapshot_date(path: Path) -> str | None:
    match = re.search(r"(\d{4}-\d{2}-\d{2})\.json$", path.name)
    return match.group(1) if match else None


def build_timeseries(history_root: Path, fetched_at: str) -> dict[str, Any]:
    # Idempotency: the same provider observation re-fetched never creates a
    # new point. Dedupe key = hesId + provider + observationTimestamp +
    # sourceClass (the snapshot/day is NOT part of the key: snapshot = shown
    # state, observation = provider measurement time).
    by_hes: dict[str, dict[str, dict[str, Any]]] = {}
    snapshots = sorted(history_root.rglob("*.json")) if history_root.exists() else []
    for path in snapshots:
        date_fallback = snapshot_date(path)
        snapshot = read_payload(path)
        for record in snapshot.get("records", []):
            if not isinstance(record, dict) or not record_is_usable(record):
                continue
            hes_id = str(record.get("hesId") or "")
            observed = str(record.get("observedAt") or date_fallback or "")
            if not hes_id or not observed:
                continue
            provider = provider_of(record.get("source"))
            key = dedupe_key(hes_id, provider, observed, source_class(record))
            point = {"date": observed, "value": clamp(number(record.get("fullnessPercent"))), "source": record.get("source"), "provider": record.get("provider") or PROVIDER_LABELS.get(provider, provider), "sourceClass": source_class(record), "confidence": record.get("confidence", "low"), "estimated": bool(record.get("isEstimated")), "status": record.get("status", "available"), "method": record.get("method"), "observedAt": record.get("observedAt"), "fetchedAt": record.get("fetchedAt") or snapshot.get("pipelineRunAt") or snapshot.get("generatedAt"), "dedupeKey": key}
            current = by_hes.setdefault(hes_id, {}).get(key)
            if current is None or str(point.get("fetchedAt") or "") >= str(current.get("fetchedAt") or ""):
                by_hes[hes_id][key] = point
    records = [{"hesId": hes_id, "points": sorted(points.values(), key=lambda point: (str(point.get("date")), str(point.get("source"))))} for hes_id, points in sorted(by_hes.items())]
    all_points = [point for record in records for point in record["points"]]
    return {"dataVersion": read_payload(MANIFEST_PATH).get("dataVersion"), "pipelineRunAt": fetched_at, "latestObservationAt": max((str(point["date"]) for point in all_points), default=None), "recordCount": len(records), "observationCount": len(all_points), "records": records}


def write_rolling_timeseries(history_root: Path, fetched_at: str) -> dict[str, Any]:
    full = build_timeseries(history_root, fetched_at)
    all_points = [point for record in full["records"] for point in record["points"]]
    reference = parse_datetime(fetched_at) or datetime.now(timezone.utc)
    for days in (7, 30, 90, 365):
        filtered_records = []
        for record in full["records"]:
            points = [point for point in record["points"] if (observed := parse_datetime(point.get("date"))) is not None and 0 <= (reference.date() - observed.date()).days <= days]
            if points:
                filtered_records.append({"hesId": record["hesId"], "points": points})
        write_payload(TIMESERIES_ROOT / f"hes_fullness_{days}d.json", {**full, "rangeDays": days, "recordCount": len(filtered_records), "observationCount": sum(len(record["points"]) for record in filtered_records), "records": filtered_records})
    return {"recordCount": len(full["records"]), "observationCount": len(all_points), "oldestObservationAt": min((str(point["date"] ) for point in all_points), default=None), "newestObservationAt": max((str(point["date"]) for point in all_points), default=None)}


def main() -> None:
    fetched_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    hes_payload = read_payload(HES_PATH)
    previous_latest = read_payload(LIVE_PATH)
    previous_health = read_payload(HEALTH_PATH)
    previous_records = {str(record.get("hesId")): record for record in previous_latest.get("records", []) if isinstance(record, dict)}
    epias_payload = read_payload(EPIAS_PATH)
    epias_records = [record for record in epias_payload.get("records", []) if isinstance(record, dict)]
    epias_lkg_payload = read_payload(EPIAS_LKG_PATH)
    epias_lkg_records = [record for record in epias_lkg_payload.get("records", []) if isinstance(record, dict)]
    catalog_payload = read_payload(OBSERVATION_CATALOG_PATH)
    catalog_records = [record for record in catalog_payload.get("records", []) if isinstance(record, dict)]
    source_matches_by_hes = {str((feature.get("properties") or {}).get("id")): catalog_matches(feature, catalog_records) for feature in hes_payload.get("features", [])}
    provider_obs = load_provider_observations()
    curves = load_hypsometry()
    provider_stats: dict[str, dict[str, int]] = {}
    records: list[dict[str, Any]] = []
    quality_rejections: list[dict[str, Any]] = []
    for feature in hes_payload.get("features", []):
        hes_id = str((feature.get("properties") or {}).get("id") or feature.get("id") or "")
        current_epias = epias_record(epias_records, feature)
        fallback = previous_records.get(hes_id)
        if fallback is None:
            fallback = epias_record(epias_lkg_records, feature)
        quality_rejections.extend(rejected_observations(feature, current_epias, fetched_at))
        result = make_result(feature, current_epias, fetched_at, source_matches_by_hes.get(hes_id, {}), fallback, provider_obs, curves, provider_stats)
        quality_rejections.extend(result.pop("_providerRejections", []))
        # Publish canonical storage classification on the feature (additive).
        storage_info = classify_storage(feature.get("properties") or {})
        (feature.setdefault("properties", {}) or {}).update({"storageType": storage_info["storageType"], "storageTypeProvenance": storage_info["storageTypeProvenance"], "storageTypeConfidence": storage_info["storageTypeConfidence"]})
        records.append(result)
    for provider_name, rows in provider_obs.items():
        stats = provider_stats.setdefault(provider_name, {"fetched": len(rows), "matched": 0, "usable": 0, "rejected": 0})
        latest = max((str(row.get("observedAt") or "") for row in rows), default=None) or None
        print(f"[{PROVIDER_LABELS.get(provider_name, provider_name)}] fetched={stats['fetched']} matched={stats['matched']} usable={stats['usable']} rejected={stats['rejected']} latest={latest or '—'}")
    by_id = {str(feature.get("properties", {}).get("id")): feature for feature in hes_payload.get("features", [])}
    for result in records:
        feature = by_id.get(result["hesId"])
        if feature:
            props = feature.setdefault("properties", {})
            props["fullnessResult"] = result
            props["fullnessStatus"] = result["status"]
            props["fullnessSourceClass"] = result["sourceClass"]
            props["fullnessSourceKey"] = result["source"]
            props["fullnessMethod"] = result["method"]
            props["fullnessIsEstimated"] = result["isEstimated"]
            props["fullnessObservedAt"] = result.get("observedAt")
            props["fullnessFreshnessDays"] = result.get("freshnessDays")
            props["fullnessConfidence"] = result.get("confidence")
            props["fullnessReasonUnavailable"] = result.get("reasonUnavailable")
            props["fullnessProvider"] = result.get("provider")
            props["fullnessFreshnessLabel"] = result.get("freshnessLabel")
    counts = {"available": sum(result["status"] == "available" for result in records), "stale": sum(result["status"] == "stale" for result in records), "notApplicable": sum(result["status"] == "not_applicable" for result in records), "unavailable": sum(result["status"] == "unavailable" for result in records), "officialLive": sum(result["sourceClass"] == "official_live" for result in records), "officialPublished": sum(result["sourceClass"] == "official_published" for result in records), "satellite": sum(result["sourceClass"] in {"satellite_altimetry", "satellite_area"} for result in records), "calculated": sum(result["sourceClass"] == "calculated_storage" and result["fullnessPercent"] is not None for result in records), "mock": sum(result["sourceClass"] == "mock" for result in records),
              "estimated": sum(result.get("isEstimated") is True and result.get("fullnessPercent") is not None for result in records), "measured": sum(result.get("isEstimated") is False and result.get("fullnessPercent") is not None for result in records),
              "fresh": sum(result.get("freshnessLabel") == "fresh" for result in records), "staleLabel": sum(result.get("freshnessLabel") == "stale" for result in records), "old": sum(result.get("freshnessLabel") == "old" for result in records),
              "confidenceHigh": sum(result.get("confidence") == "high" and result.get("fullnessPercent") is not None for result in records), "confidenceMedium": sum(result.get("confidence") == "medium" and result.get("fullnessPercent") is not None for result in records), "confidenceLow": sum(result.get("confidence") == "low" and result.get("fullnessPercent") is not None for result in records)}
    checked_providers, skipped_providers = provider_query_state()
    missing_sources = []
    not_applicable_list = []
    for result in records:
        feature = by_id.get(result["hesId"], {})
        props = feature.get("properties", {}) if isinstance(feature, dict) else {}
        if result["status"] == "not_applicable":
            result["missingReason"] = "not_applicable"
            result["reasonUnavailable"] = REASON_TR["not_applicable"]
            not_applicable_list.append({"hesId": result["hesId"], "name": props.get("name"),
                                        "storageType": result.get("storageType", "unknown"),
                                        "reason": "not_applicable"})
            continue
        if result["status"] != "unavailable":
            continue
        has_volumes = bool(result.get("volumeAvailable"))
        has_reservoir = bool(result.get("gdwMatch"))
        has_catalog = bool(result.get("bestCatalogSource"))
        storage = result.get("storageType", "unknown")
        if result.get("waterLevelAvailable") or result.get("surfaceAreaAvailable"):
            reason = "missing_hypsometry"
        elif storage == "storage" and has_reservoir and not has_volumes:
            reason = "missing_inventory_volume"
        elif storage == "storage" and not has_reservoir:
            reason = "reservoir_not_mapped"
        elif storage in ("regulator", "mixed") and not has_volumes:
            reason = "missing_inventory_volume"
        elif storage in ("regulator", "mixed") and not has_reservoir:
            reason = "reservoir_not_mapped"
        elif not checked_providers:
            reason = "provider_not_configured"
        elif has_catalog:
            reason = "matched_no_measurement"
        elif storage == "unknown":
            reason = "storage_type_unknown"
        else:
            reason = "no_verified_source"
        assert reason in MISSING_REASONS, reason
        result["missingReason"] = reason
        result["reasonUnavailable"] = REASON_TR[reason]
        missing_sources.append({"hesId": result["hesId"], "name": props.get("name"), "storageType": storage,
                                "providersChecked": checked_providers, "providersSkipped": skipped_providers,
                                "candidateSources": [result.get("bestCatalogSource")] if has_catalog else [],
                                "reason": reason})
    MISSING_PATH.parent.mkdir(parents=True, exist_ok=True)
    MISSING_PATH.write_text(json.dumps({"pipelineRunAt": fetched_at, "missingCount": len(missing_sources),
                                        "providersChecked": checked_providers, "providersSkipped": skipped_providers,
                                        "notApplicable": not_applicable_list,
                                        "records": missing_sources}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # Canonical HES -> dam/reservoir mapping (all 129 HES, every run).
    dam_map = []
    for feature in hes_payload.get("features", []):
        props = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        coords = geometry.get("coordinates") if geometry.get("type") == "Point" else None
        result = next((item for item in records if item["hesId"] == str(props.get("id") or feature.get("id") or "")), {})
        reservoir_ids = props.get("reservoirIds") or []
        dam_map.append({"hesId": str(props.get("id") or feature.get("id") or ""), "hesName": props.get("name"),
                        "damName": props.get("damName"), "reservoirName": props.get("reservoirName"),
                        "river": props.get("riverName"), "basin": props.get("officialBasinName") or props.get("basinName"),
                        "province": props.get("province"), "coordinates": coords, "coordinateKind": props.get("coordinateKind"),
                        "reservoirPolygonId": reservoir_ids[0] if reservoir_ids else None,
                        "reservoirMatchMethod": props.get("reservoirMatchMethod"),
                        "reservoirMatchConfidence": props.get("reservoirMatchConfidence"),
                        "storageType": result.get("storageType", "unknown"),
                        "storageTypeProvenance": result.get("storageTypeProvenance"),
                        "fullnessStatus": result.get("status")})
    DAM_RESERVOIR_MAP_PATH.parent.mkdir(parents=True, exist_ok=True)
    DAM_RESERVOIR_MAP_PATH.write_text(json.dumps({"pipelineRunAt": fetched_at, "hesCount": len(dam_map),
                                                  "mappedReservoirs": sum(1 for row in dam_map if row["reservoirPolygonId"]),
                                                  "records": dam_map}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    applicable = sum(result["status"] != "not_applicable" for result in records)
    coverage = {"hesCount": len(records), "applicableCount": applicable, "availableCount": counts["available"], "staleCount": counts["stale"], "notApplicableCount": counts["notApplicable"], "unavailableCount": counts["unavailable"], "officialLiveCount": counts["officialLive"], "officialPublishedCount": counts["officialPublished"], "officialCount": counts["officialLive"] + counts["officialPublished"], "satelliteCount": counts["satellite"], "calculatedCount": counts["calculated"], "mockCount": counts["mock"], "mockIncluded": False, "applicable": applicable, "available": counts["available"] + counts["stale"], "official": counts["officialLive"] + counts["officialPublished"], "satellite": counts["satellite"], "calculated": counts["calculated"], "stale": counts["stale"], "missing": counts["unavailable"], "notApplicable": counts["notApplicable"],
                "estimatedCount": counts["estimated"], "measuredCount": counts["measured"], "freshCount": counts["fresh"], "staleLabelCount": counts["staleLabel"], "oldCount": counts["old"],
                "confidenceHighCount": counts["confidenceHigh"], "confidenceMediumCount": counts["confidenceMedium"], "confidenceLowCount": counts["confidenceLow"]}
    latest_observation = max((parse_datetime(record.get("observedAt")) for record in records if record.get("fullnessPercent") is not None and parse_datetime(record.get("observedAt"))), default=None)
    latest_observation_at = latest_observation.isoformat().replace("+00:00", "Z") if latest_observation else None
    previous_observations = {dedupe_key(record.get("hesId"), provider_of(record.get("source")), record.get("observedAt"), record.get("sourceClass")) for record in previous_latest.get("records", []) if isinstance(record, dict) and record.get("fullnessPercent") is not None}
    new_observations = sum(dedupe_key(record.get("hesId"), provider_of(record.get("source")), record.get("observedAt"), record.get("sourceClass")) not in previous_observations for record in records if record.get("fullnessPercent") is not None)
    source_registry = {
        "epias": {"status": epias_payload.get("status", "missing"), "sourceUrl": "https://seffaflik.epias.com.tr/", "dataAccess": "credentials_or_public_export_required", "latestAttempt": epias_payload.get("generatedAt"), "lastSuccessfulFetch": epias_lkg_payload.get("fetchedAt") or epias_lkg_payload.get("generatedAt"), "lastSuccessfulObservation": epias_lkg_payload.get("latestObservationAt"), "error": epias_payload.get("errors", [])},
        "dsi": {"status": "public_aggregates", "sourceUrl": "https://yagisbarajdoluluk.dsi.gov.tr", "dataAccess": "public_api_no_auth__per_dam_admin_only", "note": "published-date + purpose/province aggregates are public; per-dam feed only via DSI_DAM_ENDPOINT"},
        "dahiti": {"status": "requires_access", "sourceUrl": "https://dahiti.dgfi.tum.de/en/api/doc/v2/", "dataAccess": "api_key_required"},
        "hydroweb": {"status": "not_queried", "sourceUrl": "https://hydroweb.next.theia-land.fr/help", "dataAccess": "catalog_or_api_key_required"},
        "copernicus": {"status": "not_queried", "sourceUrl": "https://land.copernicus.eu/en/products/water-bodies/water-level-lakes-near-real-time-v2.0", "dataAccess": "catalog_or_access_token_required"},
        "swot": {"status": "requires_access", "sourceUrl": "https://www.earthdata.nasa.gov/", "dataAccess": "Earthdata_credentials_required"},
        "g_realm": {"status": "not_queried", "sourceUrl": "https://www.g-realm.com/", "dataAccess": "provider_catalog_required"},
        "sentinel": {"status": "not_queried", "sourceUrl": "https://dataspace.copernicus.eu/", "dataAccess": "provider_catalog_required"},
    }
    source_registry.update(catalog_payload.get("sourceRegistry", {}))
    for provider_name, filename in PROVIDER_OBS_FILES.items():
        obs_path = PROVIDER_OBS_DIR / filename
        if not obs_path.exists():
            continue
        try:
            obs_payload = json.loads(obs_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        obs_list = obs_payload.get("observations", []) if isinstance(obs_payload, dict) else []
        latest_obs = max((str(row.get("observedAt") or "") for row in obs_list if isinstance(row, dict)), default=None) or None
        entry = dict(source_registry.get(provider_name, {}))
        entry.update({"observationFile": f"public/data/live/providers/{filename}", "observationStatus": obs_payload.get("status") if isinstance(obs_payload, dict) else None,
                      "observationErrorCode": obs_payload.get("errorCode") if isinstance(obs_payload, dict) else None,
                      "observationCount": len(obs_list), "latestObservationAt": latest_obs,
                      "downloadedAt": obs_payload.get("generatedAt") if isinstance(obs_payload, dict) else None})
        source_registry[provider_name] = entry
    failed_sources = [name for name, meta in source_registry.items() if str(meta.get("status", "")).lower() in {"failed", "unavailable", "requires_access", "requires_endpoint"}]
    status = "ok" if not failed_sources and counts["unavailable"] == 0 else "degraded" if failed_sources and any(record.get("status") == "stale" for record in records) else "partial"
    payload = {"dataVersion": read_payload(MANIFEST_PATH).get("dataVersion"), "pipelineRunAt": fetched_at, "latestObservationAt": latest_observation_at, "generatedAt": fetched_at, "status": status, "coverage": coverage, "sources": source_registry, "quality": {"rejectedCount": len(quality_rejections), "rejectedPath": str(REJECTED_PATH.relative_to(ROOT)).replace("\\", "/")}, "records": records}
    write_payload(LIVE_PATH, payload)
    write_payload(REJECTED_PATH, {"dataVersion": payload["dataVersion"], "pipelineRunAt": fetched_at, "rejectedCount": len(quality_rejections), "records": quality_rejections})
    AUDIT_PATH.write_text(json.dumps({"dataVersion": payload["dataVersion"], "pipelineRunAt": fetched_at, "latestObservationAt": latest_observation_at, "status": status, "sourceRegistry": source_registry, "catalogRecordCount": len(catalog_records), "quality": payload["quality"], "records": records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    fields = ["hesId", "status", "fullnessPercent", "sourceClass", "source", "provider", "method", "observedAt", "sourcePublishedAt", "fetchedAt", "freshnessDays", "freshnessLabel", "confidence", "isEstimated", "storageType", "epiasMatch", "dsiMatch", "dahitiMatch", "hydrowebMatch", "copernicusMatch", "swotMatch", "gRealmMatch", "gdwMatch", "candidateSourceCount", "bestCatalogSource", "bestCatalogSourceUrl", "bestCatalogDistanceKm", "catalogConfidence", "fullnessDirectlyAvailable", "fullnessCanBeCalculated", "reasonUnavailable"]
    with CSV_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader(); writer.writerows({field: record.get(field) for field in fields} for record in records)
    previous_coverage = previous_latest.get("coverage", {}) if isinstance(previous_latest, dict) else {}
    def before_after(key: str, current: int) -> str:
        old = previous_coverage.get(key)
        if old is None:
            return f"{current} (ilk ölçüm)"
        delta = current - int(old)
        return f"{current} ({'+' if delta >= 0 else ''}{delta})"
    total = len(records)
    storage_counts = {k: sum(1 for r in records if r.get("storageType") == k) for k in ("storage", "run_of_river", "regulator", "mixed", "unknown")}
    storage_total = storage_counts["storage"]
    mapped_total = sum(1 for r in records if r.get("gdwMatch"))
    mapped_storage = sum(1 for r in records if r.get("gdwMatch") and r.get("storageType") == "storage")
    applicable = sum(1 for r in records if r["status"] != "not_applicable")

    def pct(part: int, whole: int) -> str:
        return f"{part}/{whole} ({(100.0 * part / whole):.1f}%)" if whole else f"{part}/{whole} (—)"

    coverage_lines = [
        "## Storage classification (denominator: 129 total HES)",
        "",
        f"- Storage: {pct(storage_counts['storage'], total)}",
        f"- Run-of-river: {pct(storage_counts['run_of_river'], total)}",
        f"- Regulator: {pct(storage_counts['regulator'], total)}",
        f"- Mixed: {pct(storage_counts['mixed'], total)}",
        f"- Unknown: {pct(storage_counts['unknown'], total)}",
        "",
        "## Reservoir mapping",
        "",
        f"- Mapped: {pct(mapped_total, total)} of total HES",
        f"- Mapped: {pct(mapped_storage, storage_total)} of storage-classified HES",
        "",
        "## Fullness (denominator: 129 total HES; available also vs applicable)",
        "",
        f"- Official: {pct(counts['officialLive'] + counts['officialPublished'], total)}",
        f"- Satellite: {pct(counts['satellite'], total)}",
        f"- Estimated: {pct(counts['estimated'], total)}",
        f"- Unavailable: {pct(counts['unavailable'], total)}",
        f"- Not applicable: {pct(counts['notApplicable'], total)}",
        f"- Available (of applicable {applicable}): {pct(counts['available'] + counts['stale'], applicable)}",
        "",
        "## Before / after (vs previous snapshot)",
        "",
        "| Metric | Now (Δ) |",
        "|---|---|",
    ]
    coverage_now = {"official": counts["officialLive"] + counts["officialPublished"], "satellite": counts["satellite"],
                    "estimated": counts["estimated"], "unavailable": counts["unavailable"], "notApplicable": counts["notApplicable"]}
    coverage_lines += [f"| {key} | {before_after(key, value)} |" for key, value in coverage_now.items()]
    coverage_lines += ["", "## Full detail", "", "| Metric | Count |", "|---|---:|"] + [f"| {key} | {value} |" for key, value in counts.items()]
    coverage_lines += ["", "## Providers", "", "| Provider | Fetched | Matched | Usable | Rejected |", "|---|---:|---:|---:|---:|"] + [f"| {name} | {stats.get('fetched', 0)} | {stats.get('matched', 0)} | {stats.get('usable', 0)} | {stats.get('rejected', 0)} |" for name, stats in sorted(provider_stats.items())]
    coverage_lines += ["", "MOCK values are excluded from this production snapshot. Missing HES list with reasons: `reports/fullness_missing_sources.json`."]
    MD_PATH.write_text("# Fullness source audit\n\n" + f"Pipeline run: `{fetched_at}`\nLatest observation: `{latest_observation_at or '—'}`\nStatus: `{status}`\nNew observations: `{new_observations}`\n\nTotal HES: `{total}`\n\n" + "\n".join(coverage_lines) + "\n", encoding="utf-8")
    today = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
    history_root = Path(os.getenv("HYDRO_HISTORY_ROOT", str(HISTORY_ROOT)))
    history_path = history_root / f"{today:%Y}" / f"{today:%m}" / f"{today:%Y-%m-%d}.json"
    history_path.parent.mkdir(parents=True, exist_ok=True)
    daily_payload = merge_daily_snapshot(history_path, payload, fetched_at)
    write_payload(history_path, daily_payload)
    series_summary = write_rolling_timeseries(history_root, fetched_at)
    HEALTH_PATH.parent.mkdir(parents=True, exist_ok=True)
    health = provider_health_snapshot(provider_obs, epias_payload)
    write_payload(HEALTH_PATH, {"dataVersion": payload["dataVersion"], "pipelineRunAt": fetched_at, "latestObservationAt": latest_observation_at, "status": status, "workflowStatus": os.getenv("HYDRO_WORKFLOW_STATUS", "local"), "lastSuccessfulPipelineRunAt": fetched_at, "lastFailedPipelineRunAt": previous_health.get("lastFailedPipelineRunAt"), "historyPersisted": environment_boolean("HYDRO_HISTORY_PERSISTED") is True, "deploySucceeded": environment_boolean("HYDRO_DEPLOY_SUCCEEDED"), "sourcesHealthy": health["healthy"], "sourcesHealthyEmpty": health["healthy_empty"], "sourcesSkipped": health["skipped"], "sourcesFailed": health["failed"], "newObservations": new_observations, "staleRecords": counts["stale"], "qualityRejectedCount": len(quality_rejections), "coverage": coverage, "history": series_summary, "providerStats": provider_stats, "storageTypes": {k: sum(1 for r in records if r.get("storageType") == k) for k in ("storage", "run_of_river", "regulator", "mixed", "unknown")}})
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8")) if MANIFEST_PATH.exists() else {}
    manifest.update({"fullnessAvailableCount": counts["available"] + counts["stale"], "fullnessRealOrDerivedCount": counts["available"] + counts["stale"], "fullnessOfficialCount": counts["officialLive"] + counts["officialPublished"], "fullnessOfficialLiveCount": counts["officialLive"], "fullnessOfficialPublishedCount": counts["officialPublished"], "fullnessSatelliteCount": counts["satellite"], "fullnessCalculatedCount": counts["calculated"], "fullnessStaleCount": counts["stale"], "fullnessUnavailableCount": counts["unavailable"], "fullnessNotApplicableCount": counts["notApplicable"], "fullnessMockCount": 0, "volumeCalculatedFullnessCount": counts["calculated"], "epiasFullnessCount": counts["officialLive"], "fallbackMockFullnessCount": 0, "fullnessEstimatedCount": counts["estimated"], "fullnessMeasuredCount": counts["measured"], "fullnessFreshCount": counts["fresh"], "fullnessOldCount": counts["old"], "fullnessMissingSources": str(MISSING_PATH.relative_to(ROOT)).replace("\\", "/"), "fullnessCatalogMatchHesCount": sum(result.get("candidateSourceCount", 0) > 0 for result in records), "fullnessAuditRecordCount": len(records), "fullnessSourceAudit": str(AUDIT_PATH.relative_to(ROOT)).replace("\\", "/"), "observationCatalogGeneratedAt": catalog_payload.get("generatedAt"), "observationCatalogRecordCount": len(catalog_records), "fullnessSourceRegistry": source_registry, "fullnessProviderStats": provider_stats, "pipelineRunAt": fetched_at, "latestObservationAt": latest_observation_at, "fullnessStatus": status, "historyObservationCount": series_summary["observationCount"], "historyOldestObservationAt": series_summary["oldestObservationAt"], "historyNewestObservationAt": series_summary["newestObservationAt"]})
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    HES_PATH.write_text(json.dumps(hes_payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"hes": len(records), **counts, "newObservations": new_observations, "status": status, "latestObservationAt": latest_observation_at, "live": str(LIVE_PATH.relative_to(ROOT)), "history": series_summary}, ensure_ascii=False))


if __name__ == "__main__":
    main()

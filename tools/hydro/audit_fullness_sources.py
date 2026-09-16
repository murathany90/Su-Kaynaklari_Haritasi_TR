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

ROOT = Path(__file__).resolve().parents[2]
HES_PATH = ROOT / "public/data/hes177/hes_177.geojson"
MANIFEST_PATH = ROOT / "public/data/hes177/hes_177_manifest.json"
EPIAS_PATH = ROOT / "public/data/live/epias_dams_latest.json"
EPIAS_LKG_PATH = ROOT / "public/data/live/epias_dams_last_known_good.json"
LIVE_PATH = ROOT / "public/data/live/hes_fullness_latest.json"
AUDIT_PATH = ROOT / "public/data/hes177/fullness_source_audit.json"
RESERVOIRS_PATH = ROOT / "public/data/hes177/hes_reservoirs.geojson"
OBSERVATION_CATALOG_PATH = ROOT / "public/data/static/mappings/observation_catalogs.json"
CSV_PATH = ROOT / "reports/fullness_source_audit.csv"
MD_PATH = ROOT / "reports/fullness_source_audit.md"
HISTORY_ROOT = ROOT / "public/data/history/fullness"
TIMESERIES_ROOT = ROOT / "public/data/timeseries"
HEALTH_PATH = ROOT / "public/data/health/hydrology_status.json"
REJECTED_PATH = ROOT / "public/data/quality/fullness_rejected.json"

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
    result.setdefault("sourcePublishedAt", None)
    result.setdefault("rawValue", result.get("fullnessPercent"))
    result.setdefault("rawUnit", "%" if result.get("fullnessPercent") is not None else None)
    result.setdefault("uncertainty", None)
    result.setdefault("sourceUrl", None)
    result.setdefault("sourceStationId", None)
    result.setdefault("qualityFlags", [])
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
    props = hes.get("properties") or {}
    if props.get("coordinateKind") in {"transformer", "unresolved"}:
        return {}
    hes_point = point_of(hes)
    names = [normalize(props.get(key)) for key in ("name", "damName", "waterBodyName", "reservoirName") if normalize(props.get(key))]
    matches: dict[str, dict[str, Any]] = {}
    for record in catalog_records:
        record_name = normalize(record.get("name"))
        source = str(record.get("source") or "")
        try:
            record_point = (float(record.get("lon")), float(record.get("lat")))
        except (TypeError, ValueError):
            continue
        distance = distance_km(hes_point, record_point) if hes_point else float("inf")
        name_match = bool(record_name and any(record_name == name or (len(record_name) >= 5 and (record_name in name or name in record_name)) for name in names))
        spatial_match = source in {"hydroweb", "copernicus"} and math.isfinite(distance) and distance <= 15
        if not name_match and not spatial_match:
            continue
        if name_match or spatial_match:
            current = matches.get(source)
            ranked = (0 if name_match else 1, distance)
            if current is None or ranked < current["rank"]:
                matches[source] = {"record": record, "distanceKm": round(distance, 2) if math.isfinite(distance) else None, "method": "name+coordinate" if name_match and math.isfinite(distance) else "name" if name_match else "coordinate", "confidence": "high" if distance <= 10 else "medium", "rank": ranked}
    return matches


def explicit_percent(source: dict[str, Any]) -> float | None:
    # In the source payload this field is a fullness percentage; physical
    # volume fields are handled separately by volume_percent().
    return valid_percent(first_number(source, ["fullnessPercent", "occupancy", "fullness", "activeFullness", "activeFullnessAmount", "doluluk"]))


def volume_percent(source: dict[str, Any]) -> float | None:
    active = first_number(source, ["activeVolumeHm3", "activeVolume", "active_volume", "aktifHacim", "aktif_hacim"])
    minimum = first_number(source, ["minVolumeHm3", "minimumVolumeHm3", "minVolume", "minimumVolume"])
    maximum = first_number(source, ["maxVolumeHm3", "maximumVolumeHm3", "maxVolume", "maximumVolume"])
    if active is None or minimum is None or maximum is None or maximum <= minimum:
        return None
    return clamp(active / (maximum - minimum) * 100)


def current_volume_percent(source: dict[str, Any]) -> float | None:
    current = first_number(source, ["currentVolumeHm3", "currentVolume", "current_volume", "dailyVolume", "daily_volume", "operatingVolume", "operating_volume", "hacim", "volume", "suHacmi"])
    minimum = first_number(source, ["minVolumeHm3", "minimumVolumeHm3", "minVolume", "minimumVolume"])
    maximum = first_number(source, ["maxVolumeHm3", "maximumVolumeHm3", "maxVolume", "maximumVolume"])
    if current is None or minimum is None or maximum is None or maximum <= minimum:
        return None
    return clamp((current - minimum) / (maximum - minimum) * 100)


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
) -> dict[str, Any]:
    props = hes.get("properties") or {}
    hes_id = str(props.get("id") or hes.get("id") or "")
    storage = props.get("hydroPlantStorageType", "unknown")
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
    if storage == "run_of_river":
        return complete_fullness_record({"hesId": hes_id, "fullnessPercent": None, "status": "not_applicable", "sourceClass": "calculated_storage", "source": "canonical", "method": "run-of-river-no-reservoir", "observedAt": None, "sourcePublishedAt": None, "fetchedAt": fetched_at, "freshnessDays": None, "confidence": "high", "isEstimated": False, "reasonUnavailable": "run-of-river santralinde rezervuar doluluğu uygulanamaz", "qualityFlags": ["storage_type_run_of_river"], **audit_fields})

    candidates: list[dict[str, Any]] = []
    if epias:
        value = explicit_percent(epias)
        if value is not None:
            observed = observed_date(epias.get("observedAt") or epias.get("date") or epias.get("timestamp"))
            age = freshness_days(observed, fetched_at)
            candidates.append({"hesId": hes_id, "fullnessPercent": value, "status": "stale" if age is not None and age > FRESHNESS_POLICY_DAYS["official_live"] else "available", "sourceClass": "official_live", "source": "epias", "method": "epias-normalized-percent", "observedAt": observed, "sourcePublishedAt": observed_date(epias.get("sourcePublishedAt") or epias.get("publishedAt")), "fetchedAt": fetched_at, "freshnessDays": age, "confidence": "high", "isEstimated": False, "rawValue": value, "rawUnit": "%", "sourceUrl": "https://seffaflik.epias.com.tr/", "qualityFlags": [], **audit_fields})
        current_value = current_volume_percent(epias)
        if current_value is not None:
            observed = observed_date(epias.get("observedAt") or epias.get("date") or epias.get("timestamp"))
            age = freshness_days(observed, fetched_at)
            candidates.append({"hesId": hes_id, "fullnessPercent": current_value, "status": "stale" if age is not None and age > FRESHNESS_POLICY_DAYS["official_live"] else "available", "sourceClass": "official_live", "source": "epias", "method": "current-volume/(max-volume-min-volume)", "observedAt": observed, "sourcePublishedAt": observed_date(epias.get("sourcePublishedAt") or epias.get("publishedAt")), "fetchedAt": fetched_at, "freshnessDays": age, "confidence": "high", "isEstimated": True, "rawValue": current_value, "rawUnit": "%", "sourceUrl": "https://seffaflik.epias.com.tr/", "qualityFlags": ["derived_from_current_volume"], **audit_fields})
    value = volume_percent(props)
    if value is not None:
        observed = observed_date(props.get("epiasDate"))
        age = freshness_days(observed, fetched_at)
        candidates.append({"hesId": hes_id, "fullnessPercent": value, "status": "stale" if age is not None and age > FRESHNESS_POLICY_DAYS["calculated_storage"] else "available", "sourceClass": "calculated_storage", "source": "canonical", "method": "active-volume/(max-volume-min-volume)", "observedAt": observed, "sourcePublishedAt": None, "fetchedAt": fetched_at, "freshnessDays": age, "confidence": "medium", "isEstimated": True, "rawValue": value, "rawUnit": "%", "qualityFlags": ["derived_from_inventory_volume"], **audit_fields})
    if record_is_usable(previous):
        candidates.append(mark_last_known_good(previous, fetched_at))
    selected = select_best_fullness_record(candidates, fetched_at)
    if selected:
        return complete_fullness_record(selected)
    reason = "katalog eşleşti ancak ölçüm indirme yetkisi yok" if source_matches else "EPİAŞ erişimi yok; doğrulanmış hacim/uydu serisi yok"
    return complete_fullness_record({"hesId": hes_id, "fullnessPercent": None, "status": "unavailable", "sourceClass": "calculated_storage", "source": "canonical", "method": "no-verified-fullness-source", "observedAt": None, "sourcePublishedAt": None, "fetchedAt": fetched_at, "freshnessDays": None, "confidence": "low", "isEstimated": False, "reasonUnavailable": reason, "qualityFlags": ["no_data"], **audit_fields})


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
    by_hes: dict[str, dict[tuple[str, str], dict[str, Any]]] = {}
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
            key = (observed, str(record.get("source") or "canonical"))
            point = {"date": observed, "value": clamp(number(record.get("fullnessPercent"))), "source": record.get("source"), "sourceClass": source_class(record), "confidence": record.get("confidence", "low"), "estimated": bool(record.get("isEstimated")), "status": record.get("status", "available"), "method": record.get("method"), "observedAt": record.get("observedAt"), "fetchedAt": record.get("fetchedAt") or snapshot.get("pipelineRunAt") or snapshot.get("generatedAt")}
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
    records: list[dict[str, Any]] = []
    quality_rejections: list[dict[str, Any]] = []
    for feature in hes_payload.get("features", []):
        hes_id = str((feature.get("properties") or {}).get("id") or feature.get("id") or "")
        current_epias = epias_record(epias_records, feature)
        fallback = previous_records.get(hes_id)
        if fallback is None:
            fallback = epias_record(epias_lkg_records, feature)
        quality_rejections.extend(rejected_observations(feature, current_epias, fetched_at))
        records.append(make_result(feature, current_epias, fetched_at, source_matches_by_hes.get(hes_id, {}), fallback))
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
    counts = {"available": sum(result["status"] == "available" for result in records), "stale": sum(result["status"] == "stale" for result in records), "notApplicable": sum(result["status"] == "not_applicable" for result in records), "unavailable": sum(result["status"] == "unavailable" for result in records), "officialLive": sum(result["sourceClass"] == "official_live" for result in records), "officialPublished": sum(result["sourceClass"] == "official_published" for result in records), "satellite": sum(result["sourceClass"] in {"satellite_altimetry", "satellite_area"} for result in records), "calculated": sum(result["sourceClass"] == "calculated_storage" and result["fullnessPercent"] is not None for result in records), "mock": sum(result["sourceClass"] == "mock" for result in records)}
    applicable = sum(result["status"] != "not_applicable" for result in records)
    coverage = {"hesCount": len(records), "applicableCount": applicable, "availableCount": counts["available"], "staleCount": counts["stale"], "notApplicableCount": counts["notApplicable"], "unavailableCount": counts["unavailable"], "officialLiveCount": counts["officialLive"], "officialPublishedCount": counts["officialPublished"], "officialCount": counts["officialLive"] + counts["officialPublished"], "satelliteCount": counts["satellite"], "calculatedCount": counts["calculated"], "mockCount": counts["mock"], "mockIncluded": False, "applicable": applicable, "available": counts["available"] + counts["stale"], "official": counts["officialLive"] + counts["officialPublished"], "satellite": counts["satellite"], "calculated": counts["calculated"], "stale": counts["stale"], "missing": counts["unavailable"], "notApplicable": counts["notApplicable"]}
    latest_observation = max((parse_datetime(record.get("observedAt")) for record in records if record.get("fullnessPercent") is not None and parse_datetime(record.get("observedAt"))), default=None)
    latest_observation_at = latest_observation.isoformat().replace("+00:00", "Z") if latest_observation else None
    previous_observations = {(str(record.get("hesId")), str(record.get("observedAt")), str(record.get("source"))) for record in previous_latest.get("records", []) if isinstance(record, dict) and record.get("fullnessPercent") is not None}
    new_observations = sum((str(record.get("hesId")), str(record.get("observedAt")), str(record.get("source"))) not in previous_observations for record in records if record.get("fullnessPercent") is not None)
    source_registry = {
        "epias": {"status": epias_payload.get("status", "missing"), "sourceUrl": "https://seffaflik.epias.com.tr/", "dataAccess": "credentials_or_public_export_required", "latestAttempt": epias_payload.get("generatedAt"), "lastSuccessfulFetch": epias_lkg_payload.get("fetchedAt") or epias_lkg_payload.get("generatedAt"), "lastSuccessfulObservation": epias_lkg_payload.get("latestObservationAt"), "error": epias_payload.get("errors", [])},
        "dsi": {"status": "requires_access", "sourceUrl": "https://www.dsi.gov.tr/", "dataAccess": "official_endpoint_or_export_required"},
        "dahiti": {"status": "requires_access", "sourceUrl": "https://dahiti.dgfi.tum.de/en/api/doc/v2/", "dataAccess": "api_key_required"},
        "hydroweb": {"status": "not_queried", "sourceUrl": "https://hydroweb.next.theia-land.fr/help", "dataAccess": "catalog_or_api_key_required"},
        "copernicus": {"status": "not_queried", "sourceUrl": "https://land.copernicus.eu/en/products/water-bodies/water-level-lakes-near-real-time-v2.0", "dataAccess": "catalog_or_access_token_required"},
        "swot": {"status": "requires_access", "sourceUrl": "https://www.earthdata.nasa.gov/", "dataAccess": "Earthdata_credentials_required"},
        "g_realm": {"status": "not_queried", "sourceUrl": "https://www.g-realm.com/", "dataAccess": "provider_catalog_required"},
        "sentinel": {"status": "not_queried", "sourceUrl": "https://dataspace.copernicus.eu/", "dataAccess": "provider_catalog_required"},
    }
    source_registry.update(catalog_payload.get("sourceRegistry", {}))
    failed_sources = [name for name, meta in source_registry.items() if str(meta.get("status", "")).lower() in {"failed", "unavailable", "requires_access", "requires_endpoint"}]
    status = "ok" if not failed_sources and counts["unavailable"] == 0 else "degraded" if failed_sources and any(record.get("status") == "stale" for record in records) else "partial"
    payload = {"dataVersion": read_payload(MANIFEST_PATH).get("dataVersion"), "pipelineRunAt": fetched_at, "latestObservationAt": latest_observation_at, "generatedAt": fetched_at, "status": status, "coverage": coverage, "sources": source_registry, "quality": {"rejectedCount": len(quality_rejections), "rejectedPath": str(REJECTED_PATH.relative_to(ROOT)).replace("\\", "/")}, "records": records}
    write_payload(LIVE_PATH, payload)
    write_payload(REJECTED_PATH, {"dataVersion": payload["dataVersion"], "pipelineRunAt": fetched_at, "rejectedCount": len(quality_rejections), "records": quality_rejections})
    AUDIT_PATH.write_text(json.dumps({"dataVersion": payload["dataVersion"], "pipelineRunAt": fetched_at, "latestObservationAt": latest_observation_at, "status": status, "sourceRegistry": source_registry, "catalogRecordCount": len(catalog_records), "quality": payload["quality"], "records": records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    fields = ["hesId", "status", "fullnessPercent", "sourceClass", "source", "method", "observedAt", "sourcePublishedAt", "fetchedAt", "freshnessDays", "confidence", "isEstimated", "epiasMatch", "dsiMatch", "dahitiMatch", "hydrowebMatch", "copernicusMatch", "swotMatch", "gRealmMatch", "gdwMatch", "candidateSourceCount", "bestCatalogSource", "bestCatalogSourceUrl", "bestCatalogDistanceKm", "catalogConfidence", "fullnessDirectlyAvailable", "fullnessCanBeCalculated", "reasonUnavailable"]
    with CSV_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader(); writer.writerows({field: record.get(field) for field in fields} for record in records)
    MD_PATH.write_text("# Fullness source audit\n\n" + f"Pipeline run: `{fetched_at}`\nLatest observation: `{latest_observation_at or '—'}`\nStatus: `{status}`\nNew observations: `{new_observations}`\n\n" + "| Metric | Count |\n|---|---:|\n" + "\n".join(f"| {key} | {value} |" for key, value in counts.items()) + "\n\nMOCK values are excluded from this production snapshot. Unavailable sources remain N/A.\n", encoding="utf-8")
    today = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
    history_root = Path(os.getenv("HYDRO_HISTORY_ROOT", str(HISTORY_ROOT)))
    history_path = history_root / f"{today:%Y}" / f"{today:%m}" / f"{today:%Y-%m-%d}.json"
    history_path.parent.mkdir(parents=True, exist_ok=True)
    daily_payload = merge_daily_snapshot(history_path, payload, fetched_at)
    write_payload(history_path, daily_payload)
    series_summary = write_rolling_timeseries(history_root, fetched_at)
    HEALTH_PATH.parent.mkdir(parents=True, exist_ok=True)
    write_payload(HEALTH_PATH, {"dataVersion": payload["dataVersion"], "pipelineRunAt": fetched_at, "latestObservationAt": latest_observation_at, "status": status, "workflowStatus": os.getenv("HYDRO_WORKFLOW_STATUS", "local"), "lastSuccessfulPipelineRunAt": fetched_at, "lastFailedPipelineRunAt": previous_health.get("lastFailedPipelineRunAt"), "historyPersisted": environment_boolean("HYDRO_HISTORY_PERSISTED") is True, "deploySucceeded": environment_boolean("HYDRO_DEPLOY_SUCCEEDED"), "sourcesHealthy": [name for name in source_registry if name not in failed_sources], "sourcesFailed": failed_sources, "newObservations": new_observations, "staleRecords": counts["stale"], "qualityRejectedCount": len(quality_rejections), "coverage": coverage, "history": series_summary})
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8")) if MANIFEST_PATH.exists() else {}
    manifest.update({"fullnessAvailableCount": counts["available"] + counts["stale"], "fullnessRealOrDerivedCount": counts["available"] + counts["stale"], "fullnessOfficialCount": counts["officialLive"] + counts["officialPublished"], "fullnessOfficialLiveCount": counts["officialLive"], "fullnessOfficialPublishedCount": counts["officialPublished"], "fullnessSatelliteCount": counts["satellite"], "fullnessCalculatedCount": counts["calculated"], "fullnessStaleCount": counts["stale"], "fullnessUnavailableCount": counts["unavailable"], "fullnessNotApplicableCount": counts["notApplicable"], "fullnessMockCount": 0, "volumeCalculatedFullnessCount": counts["calculated"], "epiasFullnessCount": counts["officialLive"], "fallbackMockFullnessCount": 0, "fullnessCatalogMatchHesCount": sum(result.get("candidateSourceCount", 0) > 0 for result in records), "fullnessAuditRecordCount": len(records), "fullnessSourceAudit": str(AUDIT_PATH.relative_to(ROOT)).replace("\\", "/"), "observationCatalogGeneratedAt": catalog_payload.get("generatedAt"), "observationCatalogRecordCount": len(catalog_records), "fullnessSourceRegistry": source_registry, "pipelineRunAt": fetched_at, "latestObservationAt": latest_observation_at, "fullnessStatus": status, "historyObservationCount": series_summary["observationCount"], "historyOldestObservationAt": series_summary["oldestObservationAt"], "historyNewestObservationAt": series_summary["newestObservationAt"]})
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    HES_PATH.write_text(json.dumps(hes_payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"hes": len(records), **counts, "newObservations": new_observations, "status": status, "latestObservationAt": latest_observation_at, "live": str(LIVE_PATH.relative_to(ROOT)), "history": series_summary}, ensure_ascii=False))


if __name__ == "__main__":
    main()

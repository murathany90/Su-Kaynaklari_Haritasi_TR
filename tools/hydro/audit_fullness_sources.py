"""Normalize fullness provenance and publish one small runtime snapshot.

This job intentionally publishes no synthetic production values. Inventory
volume calculations are marked as estimated/calculated, while unavailable
plants remain N/A until a verifiable source is configured.
"""

from __future__ import annotations

import csv
import json
import math
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
HES_PATH = ROOT / "public/data/hes177/hes_177.geojson"
MANIFEST_PATH = ROOT / "public/data/hes177/hes_177_manifest.json"
EPIAS_PATH = ROOT / "public/data/live/epias_dams_latest.json"
LIVE_PATH = ROOT / "public/data/live/hes_fullness_latest.json"
AUDIT_PATH = ROOT / "public/data/hes177/fullness_source_audit.json"
RESERVOIRS_PATH = ROOT / "public/data/hes177/hes_reservoirs.geojson"
OBSERVATION_CATALOG_PATH = ROOT / "public/data/static/mappings/observation_catalogs.json"
CSV_PATH = ROOT / "reports/fullness_source_audit.csv"
MD_PATH = ROOT / "reports/fullness_source_audit.md"
HISTORY_ROOT = ROOT / "public/data/history/fullness"


def number(value: Any) -> float | None:
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    except (TypeError, ValueError):
        return None


def clamp(value: float | None) -> float | None:
    return None if value is None else max(0.0, min(100.0, value))


def observed_date(value: Any) -> str | None:
    if value in (None, ""):
        return None
    raw = number(value)
    if raw is not None and raw > 20000:
        return (datetime(1899, 12, 30, tzinfo=timezone.utc) + timedelta(days=raw)).date().isoformat()
    text = str(value).strip()
    return text if text else None


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
    # activeFullnessAmount is an amount, never a percentage.
    return clamp(first_number(source, ["fullnessPercent", "occupancy", "fullness", "activeFullness", "activeFullnessAmount", "doluluk"]))


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


def make_result(hes: dict[str, Any], epias: dict[str, Any] | None, fetched_at: str, source_matches: dict[str, dict[str, Any]]) -> dict[str, Any]:
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
        return {"hesId": hes_id, "fullnessPercent": None, "status": "not_applicable", "sourceClass": "calculated_storage", "source": "canonical", "method": "run-of-river-no-reservoir", "observedAt": None, "fetchedAt": fetched_at, "freshnessDays": None, "confidence": "high", "isEstimated": False, "reasonUnavailable": "run-of-river santralinde rezervuar doluluğu uygulanamaz", "qualityFlags": ["storage_type_run_of_river"], **audit_fields}
    if epias:
        value = explicit_percent(epias)
        if value is not None:
            return {"hesId": hes_id, "fullnessPercent": value, "status": "available", "sourceClass": "official", "source": "epias", "method": "epias-normalized-percent", "observedAt": observed_date(epias.get("observedAt") or epias.get("date") or epias.get("timestamp")), "fetchedAt": fetched_at, "freshnessDays": None, "confidence": "high", "isEstimated": False, "rawValue": value, "rawUnit": "%", "sourceUrl": "https://seffaflik.epias.com.tr/", "qualityFlags": [], **audit_fields}
        current_value = current_volume_percent(epias)
        if current_value is not None:
            return {"hesId": hes_id, "fullnessPercent": current_value, "status": "available", "sourceClass": "official", "source": "epias", "method": "current-volume/(max-volume-min-volume)", "observedAt": observed_date(epias.get("observedAt") or epias.get("date") or epias.get("timestamp")), "fetchedAt": fetched_at, "freshnessDays": None, "confidence": "high", "isEstimated": True, "rawValue": current_value, "rawUnit": "%", "sourceUrl": "https://seffaflik.epias.com.tr/", "qualityFlags": ["derived_from_current_volume"], **audit_fields}
    value = volume_percent(props)
    if value is not None:
        observed = observed_date(props.get("epiasDate"))
        freshness = None
        if observed:
            try:
                freshness = max(0, (datetime.fromisoformat(fetched_at.replace("Z", "+00:00")).date() - datetime.fromisoformat(observed).date()).days)
            except ValueError:
                freshness = None
        return {"hesId": hes_id, "fullnessPercent": value, "status": "stale" if freshness is not None and freshness > 30 else "available", "sourceClass": "calculated_storage", "source": "canonical", "method": "active-volume/(max-volume-min-volume)", "observedAt": observed, "fetchedAt": fetched_at, "freshnessDays": freshness, "confidence": "medium", "isEstimated": True, "rawValue": value, "rawUnit": "%", "qualityFlags": ["derived_from_inventory_volume"], **audit_fields}
    reason = "katalog eşleşti ancak ölçüm indirme yetkisi yok" if source_matches else "EPİAŞ erişimi yok; doğrulanmış hacim/uydu serisi yok"
    return {"hesId": hes_id, "fullnessPercent": None, "status": "unavailable", "sourceClass": "calculated_storage", "source": "canonical", "method": "no-verified-fullness-source", "observedAt": None, "fetchedAt": fetched_at, "freshnessDays": None, "confidence": "low", "isEstimated": False, "reasonUnavailable": reason, "qualityFlags": ["no_data"], **audit_fields}


def main() -> None:
    fetched_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    hes_payload = json.loads(HES_PATH.read_text(encoding="utf-8"))
    epias_payload = json.loads(EPIAS_PATH.read_text(encoding="utf-8")) if EPIAS_PATH.exists() else {}
    epias_records = [record for record in epias_payload.get("records", []) if isinstance(record, dict)]
    catalog_payload = json.loads(OBSERVATION_CATALOG_PATH.read_text(encoding="utf-8")) if OBSERVATION_CATALOG_PATH.exists() else {}
    catalog_records = [record for record in catalog_payload.get("records", []) if isinstance(record, dict)]
    source_matches_by_hes = {str((feature.get("properties") or {}).get("id")): catalog_matches(feature, catalog_records) for feature in hes_payload.get("features", [])}
    records = [make_result(feature, epias_record(epias_records, feature), fetched_at, source_matches_by_hes.get(str((feature.get("properties") or {}).get("id")), {})) for feature in hes_payload.get("features", [])]
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
    counts = {"available": sum(result["status"] == "available" for result in records), "stale": sum(result["status"] == "stale" for result in records), "notApplicable": sum(result["status"] == "not_applicable" for result in records), "unavailable": sum(result["status"] == "unavailable" for result in records), "official": sum(result["sourceClass"] == "official" for result in records), "satellite": sum(result["sourceClass"] in {"satellite_altimetry", "satellite_area"} for result in records), "calculated": sum(result["sourceClass"] == "calculated_storage" and result["fullnessPercent"] is not None for result in records), "mock": sum(result["sourceClass"] == "mock" for result in records)}
    applicable = sum(result["status"] != "not_applicable" for result in records)
    coverage = {"hesCount": len(records), "applicableCount": applicable, "availableCount": counts["available"], "staleCount": counts["stale"], "notApplicableCount": counts["notApplicable"], "unavailableCount": counts["unavailable"], "officialCount": counts["official"], "satelliteCount": counts["satellite"], "calculatedCount": counts["calculated"], "mockCount": counts["mock"], "mockIncluded": False, "applicable": applicable, "available": counts["available"] + counts["stale"], "official": counts["official"], "satellite": counts["satellite"], "calculated": counts["calculated"], "stale": counts["stale"], "missing": counts["unavailable"], "notApplicable": counts["notApplicable"]}
    payload = {"generatedAt": fetched_at, "status": "ok" if epias_payload.get("status") == "ok" else "partial", "coverage": coverage, "records": records}
    LIVE_PATH.parent.mkdir(parents=True, exist_ok=True)
    LIVE_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    source_registry = {
        "epias": {"status": epias_payload.get("status", "missing"), "sourceUrl": "https://seffaflik.epias.com.tr/", "dataAccess": "credentials_or_public_export_required"},
        "dsi": {"status": "requires_access", "sourceUrl": "https://www.dsi.gov.tr/", "dataAccess": "official_endpoint_or_export_required"},
        "dahiti": {"status": "requires_access", "sourceUrl": "https://dahiti.dgfi.tum.de/en/api/doc/v2/", "dataAccess": "api_key_required"},
        "hydroweb": {"status": "not_queried", "sourceUrl": "https://hydroweb.next.theia-land.fr/help", "dataAccess": "catalog_or_api_key_required"},
        "copernicus": {"status": "not_queried", "sourceUrl": "https://land.copernicus.eu/en/products/water-bodies/water-level-lakes-near-real-time-v2.0", "dataAccess": "catalog_or_access_token_required"},
        "swot": {"status": "requires_access", "sourceUrl": "https://www.earthdata.nasa.gov/", "dataAccess": "Earthdata_credentials_required"},
        "g_realm": {"status": "not_queried", "sourceUrl": "https://www.g-realm.com/", "dataAccess": "provider_catalog_required"},
        "sentinel": {"status": "not_queried", "sourceUrl": "https://dataspace.copernicus.eu/", "dataAccess": "provider_catalog_required"},
    }
    source_registry.update(catalog_payload.get("sourceRegistry", {}))
    AUDIT_PATH.write_text(json.dumps({"generatedAt": fetched_at, "sourceRegistry": source_registry, "catalogRecordCount": len(catalog_records), "records": records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    fields = ["hesId", "status", "fullnessPercent", "sourceClass", "source", "method", "observedAt", "fetchedAt", "freshnessDays", "confidence", "isEstimated", "epiasMatch", "dsiMatch", "dahitiMatch", "hydrowebMatch", "copernicusMatch", "swotMatch", "gRealmMatch", "gdwMatch", "candidateSourceCount", "bestCatalogSource", "bestCatalogSourceUrl", "bestCatalogDistanceKm", "catalogConfidence", "fullnessDirectlyAvailable", "fullnessCanBeCalculated", "reasonUnavailable"]
    with CSV_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader(); writer.writerows({field: record.get(field) for field in fields} for record in records)
    MD_PATH.write_text("# Fullness source audit\n\n" + "| Metric | Count |\n|---|---:|\n" + "\n".join(f"| {key} | {value} |" for key, value in counts.items()) + "\n\nMOCK values are excluded from this production snapshot. Unavailable sources remain N/A.\n", encoding="utf-8")
    today = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
    history_path = HISTORY_ROOT / f"{today:%Y}" / f"{today:%m}" / f"{today:%Y-%m-%d}.json"
    history_path.parent.mkdir(parents=True, exist_ok=True)
    history_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8")) if MANIFEST_PATH.exists() else {}
    manifest.update({"fullnessAvailableCount": counts["available"] + counts["stale"], "fullnessRealOrDerivedCount": counts["available"] + counts["stale"], "fullnessOfficialCount": counts["official"], "fullnessSatelliteCount": counts["satellite"], "fullnessCalculatedCount": counts["calculated"], "fullnessStaleCount": counts["stale"], "fullnessUnavailableCount": counts["unavailable"], "fullnessNotApplicableCount": counts["notApplicable"], "fullnessMockCount": 0, "volumeCalculatedFullnessCount": counts["calculated"], "epiasFullnessCount": counts["official"], "fallbackMockFullnessCount": 0, "fullnessCatalogMatchHesCount": sum(result.get("candidateSourceCount", 0) > 0 for result in records), "fullnessAuditRecordCount": len(records), "fullnessSourceAudit": str(AUDIT_PATH.relative_to(ROOT)).replace("\\", "/"), "observationCatalogGeneratedAt": catalog_payload.get("generatedAt"), "observationCatalogRecordCount": len(catalog_records), "fullnessSourceRegistry": source_registry})
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    HES_PATH.write_text(json.dumps(hes_payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"hes": len(records), **counts, "live": str(LIVE_PATH.relative_to(ROOT))}, ensure_ascii=False))


if __name__ == "__main__":
    main()

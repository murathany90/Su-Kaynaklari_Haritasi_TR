"""Normalize fullness provenance and publish one small runtime snapshot.

This job intentionally publishes no synthetic production values. Inventory
volume calculations are marked as estimated/calculated, while unavailable
plants remain N/A until a verifiable source is configured.
"""

from __future__ import annotations

import csv
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
HES_PATH = ROOT / "public/data/hes177/hes_177.geojson"
MANIFEST_PATH = ROOT / "public/data/hes177/hes_177_manifest.json"
EPIAS_PATH = ROOT / "public/data/live/epias_dams_latest.json"
LIVE_PATH = ROOT / "public/data/live/hes_fullness_latest.json"
AUDIT_PATH = ROOT / "public/data/hes177/fullness_source_audit.json"
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


def explicit_percent(source: dict[str, Any]) -> float | None:
    # activeFullnessAmount is an amount, never a percentage.
    return clamp(first_number(source, ["fullnessPercent", "occupancy", "fullness", "activeFullness", "doluluk"]))


def volume_percent(source: dict[str, Any]) -> float | None:
    active = first_number(source, ["activeVolumeHm3", "activeVolume", "active_volume", "aktifHacim", "aktif_hacim"])
    minimum = first_number(source, ["minVolumeHm3", "minimumVolumeHm3", "minVolume", "minimumVolume"])
    maximum = first_number(source, ["maxVolumeHm3", "maximumVolumeHm3", "maxVolume", "maximumVolume"])
    if active is None or minimum is None or maximum is None or maximum <= minimum:
        return None
    return clamp(active / (maximum - minimum) * 100)


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


def make_result(hes: dict[str, Any], epias: dict[str, Any] | None, fetched_at: str) -> dict[str, Any]:
    props = hes.get("properties") or {}
    hes_id = str(props.get("id") or hes.get("id") or "")
    storage = props.get("hydroPlantStorageType", "unknown")
    if storage == "run_of_river":
        return {"hesId": hes_id, "fullnessPercent": None, "status": "not_applicable", "sourceClass": "calculated_storage", "source": "canonical", "method": "run-of-river-no-reservoir", "observedAt": None, "fetchedAt": fetched_at, "freshnessDays": None, "confidence": "high", "isEstimated": False, "qualityFlags": ["storage_type_run_of_river"]}
    if epias:
        value = explicit_percent(epias)
        if value is not None:
            return {"hesId": hes_id, "fullnessPercent": value, "status": "available", "sourceClass": "official", "source": "epias", "method": "epias-normalized-percent", "observedAt": observed_date(epias.get("observedAt") or epias.get("date") or epias.get("timestamp")), "fetchedAt": fetched_at, "freshnessDays": None, "confidence": "high", "isEstimated": False, "rawValue": value, "rawUnit": "%", "sourceUrl": "https://seffaflik.epias.com.tr/", "qualityFlags": []}
    value = volume_percent(props)
    if value is not None:
        observed = observed_date(props.get("epiasDate"))
        freshness = None
        if observed:
            try:
                freshness = max(0, (datetime.fromisoformat(fetched_at.replace("Z", "+00:00")).date() - datetime.fromisoformat(observed).date()).days)
            except ValueError:
                freshness = None
        return {"hesId": hes_id, "fullnessPercent": value, "status": "stale" if freshness is not None and freshness > 30 else "available", "sourceClass": "calculated_storage", "source": "canonical", "method": "active-volume/(max-volume-min-volume)", "observedAt": observed, "fetchedAt": fetched_at, "freshnessDays": freshness, "confidence": "medium", "isEstimated": True, "rawValue": value, "rawUnit": "%", "qualityFlags": ["derived_from_inventory_volume"]}
    return {"hesId": hes_id, "fullnessPercent": None, "status": "unavailable", "sourceClass": "calculated_storage", "source": "canonical", "method": "no-verified-fullness-source", "observedAt": None, "fetchedAt": fetched_at, "freshnessDays": None, "confidence": "low", "isEstimated": False, "reasonUnavailable": "EPİAŞ erişimi yok; doğrulanmış hacim/uydu serisi yok", "qualityFlags": ["no_data"]}


def main() -> None:
    fetched_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    hes_payload = json.loads(HES_PATH.read_text(encoding="utf-8"))
    epias_payload = json.loads(EPIAS_PATH.read_text(encoding="utf-8")) if EPIAS_PATH.exists() else {}
    epias_records = [record for record in epias_payload.get("records", []) if isinstance(record, dict)]
    records = [make_result(feature, epias_record(epias_records, feature), fetched_at) for feature in hes_payload.get("features", [])]
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
    counts = {"available": sum(result["status"] == "available" for result in records), "stale": sum(result["status"] == "stale" for result in records), "notApplicable": sum(result["status"] == "not_applicable" for result in records), "unavailable": sum(result["status"] == "unavailable" for result in records), "official": sum(result["sourceClass"] == "official" for result in records), "satellite": sum(result["sourceClass"] in {"satellite_altimetry", "satellite_area"} for result in records), "calculated": sum(result["sourceClass"] == "calculated_storage" and result["fullnessPercent"] is not None for result in records), "mock": sum(result["sourceClass"] == "mock" for result in records)}
    payload = {"generatedAt": fetched_at, "status": "ok" if epias_payload.get("status") == "ok" else "partial", "coverage": {"hesCount": len(records), "availableCount": counts["available"], "staleCount": counts["stale"], "notApplicableCount": counts["notApplicable"], "unavailableCount": counts["unavailable"], "officialCount": counts["official"], "satelliteCount": counts["satellite"], "calculatedCount": counts["calculated"], "mockCount": counts["mock"], "mockIncluded": False}, "records": records}
    LIVE_PATH.parent.mkdir(parents=True, exist_ok=True)
    LIVE_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    AUDIT_PATH.write_text(json.dumps({"generatedAt": fetched_at, "sourceRegistry": {"epias": {"status": epias_payload.get("status", "missing"), "sourceUrl": "https://seffaflik.epias.com.tr/"}, "dsi": {"status": "requires_access"}, "dahiti": {"status": "not_queried", "sourceUrl": "https://dahiti.dgfi.tum.de/en/api/doc/v2/"}, "hydroweb": {"status": "not_queried", "sourceUrl": "https://hydroweb.next.theia-land.fr/help"}, "copernicus": {"status": "not_queried"}, "swot": {"status": "not_queried"}}, "records": records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    fields = ["hesId", "status", "fullnessPercent", "sourceClass", "source", "method", "observedAt", "fetchedAt", "freshnessDays", "confidence", "isEstimated", "reasonUnavailable"]
    with CSV_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader(); writer.writerows({field: record.get(field) for field in fields} for record in records)
    MD_PATH.write_text("# Fullness source audit\n\n" + "| Metric | Count |\n|---|---:|\n" + "\n".join(f"| {key} | {value} |" for key, value in counts.items()) + "\n\nMOCK values are excluded from this production snapshot. Unavailable sources remain N/A.\n", encoding="utf-8")
    today = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
    history_path = HISTORY_ROOT / f"{today:%Y}" / f"{today:%m}" / f"{today:%Y-%m-%d}.json"
    history_path.parent.mkdir(parents=True, exist_ok=True)
    history_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8")) if MANIFEST_PATH.exists() else {}
    manifest.update({"fullnessAvailableCount": counts["available"] + counts["stale"], "fullnessRealOrDerivedCount": counts["available"] + counts["stale"], "fullnessOfficialCount": counts["official"], "fullnessSatelliteCount": counts["satellite"], "fullnessCalculatedCount": counts["calculated"], "fullnessStaleCount": counts["stale"], "fullnessUnavailableCount": counts["unavailable"], "fullnessMockCount": 0, "volumeCalculatedFullnessCount": counts["calculated"], "epiasFullnessCount": counts["official"], "fallbackMockFullnessCount": 0})
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    HES_PATH.write_text(json.dumps(hes_payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"hes": len(records), **counts, "live": str(LIVE_PATH.relative_to(ROOT))}, ensure_ascii=False))


if __name__ == "__main__":
    main()

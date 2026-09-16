"""Canonical HES storage-type classification.

Canonical vocabulary (task spec)::

    storage | run_of_river | regulator | mixed | unknown

This is ADDITIVE: the workbook-derived ``hydroPlantStorageType``
(``reservoir``/``pondage``/``run_of_river``/``unknown``) is never rewritten.
The canonical ``storageType`` plus provenance/confidence is published in the
fullness record and feature properties, and the ``not_applicable`` decision
uses the canonical value.

Only ``run_of_river`` (explicit evidence) maps to ``not_applicable`` — never
``unavailable``. Everything without evidence stays ``unknown`` (applicable,
awaiting data) rather than being mislabeled river-type.
"""

from __future__ import annotations

import re
from typing import Any

RUN_OF_RIVER_TOKENS = (
    "run-of-river", "run of river", "nehir tipi", "nehir üstü", "nehir ustu",
    "barajsız", "barajsiz", "kanal tipi", "regülatör", "regulator",
)
REGULATOR_TOKENS = ("regülatör", "regulator", "regülator", "regülatör santral")
MIXED_TOKENS = ("pompaj", "pumped", "tersine", "reversible")


def evidence_text(props: dict[str, Any]) -> str:
    return " ".join(str(props.get(key) or "") for key in (
        "notes", "coordinateType", "storageTypeEvidence", "name", "damName",
        "plantType", "santralTipi", "tipi")).lower()


def classify_storage(props: dict[str, Any]) -> dict[str, Any]:
    """Return {storageType, storageTypeProvenance, storageTypeConfidence}."""
    legacy = str(props.get("hydroPlantStorageType") or "unknown").lower()
    text = evidence_text(props)
    has_regulator = any(token in text for token in REGULATOR_TOKENS)
    has_ror = legacy == "run_of_river" or any(token in text for token in RUN_OF_RIVER_TOKENS)
    has_mixed = any(token in text for token in MIXED_TOKENS)
    has_bounds = False
    try:
        min_v = float(props["minVolumeHm3"]) if props.get("minVolumeHm3") not in (None, "") else None
        max_v = float(props["maxVolumeHm3"]) if props.get("maxVolumeHm3") not in (None, "") else None
        has_bounds = min_v is not None and max_v is not None and max_v > min_v
    except (TypeError, ValueError, KeyError):
        has_bounds = False
    has_reservoir = bool(props.get("reservoirIds"))

    if has_ror and has_regulator:
        return {"storageType": "mixed", "storageTypeProvenance": "run-of-river evidence + regulator keyword",
                "storageTypeConfidence": "medium"}
    if has_ror:
        provenance = "workbook hydroPlantStorageType=run_of_river" if legacy == "run_of_river" else "run-of-river keyword evidence"
        return {"storageType": "run_of_river", "storageTypeProvenance": provenance, "storageTypeConfidence": "high"}
    if has_regulator and (has_bounds or has_reservoir):
        return {"storageType": "regulator", "storageTypeProvenance": "regulator keyword + storage evidence",
                "storageTypeConfidence": "medium"}
    if legacy in {"reservoir", "pondage"} or has_bounds or has_reservoir:
        detail = "pondage" if legacy == "pondage" else "volume-bounds" if has_bounds else "reservoir-polygon"
        return {"storageType": "storage", "storageTypeProvenance": f"storage evidence ({detail})",
                "storageTypeConfidence": "high" if legacy == "reservoir" else "medium"}
    if has_regulator:
        return {"storageType": "regulator", "storageTypeProvenance": "regulator keyword only",
                "storageTypeConfidence": "low"}
    return {"storageType": "unknown", "storageTypeProvenance": "no storage evidence",
            "storageTypeConfidence": "low"}


def storage_type_label(value: str | None) -> str:
    return {"storage": "Depolamalı", "run_of_river": "Nehir tipi",
            "regulator": "Regülatör", "mixed": "Karma", "unknown": "Bilinmiyor"}.get(str(value or "unknown"), "Bilinmiyor")


def is_run_of_river(props: dict[str, Any], classification: dict[str, Any] | None = None) -> bool:
    if str(props.get("hydroPlantStorageType") or "").lower() == "run_of_river":
        return True
    return (classification or {}).get("storageType") == "run_of_river"


def canonical_storage_summary(classifications: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"storage": 0, "run_of_river": 0, "regulator": 0, "mixed": 0, "unknown": 0}
    for item in classifications:
        key = str(item.get("storageType") or "unknown")
        counts[key] = counts.get(key, 0) + 1
    return counts

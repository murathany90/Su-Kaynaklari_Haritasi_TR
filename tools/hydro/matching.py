"""Central HES / reservoir matcher.

Normalization handles Turkish characters, HES/Barajı/Dam/Reservoir tokens,
punctuation, Roman numerals (kept as significant suffixes) and parentheses.

A match is accepted only on combined evidence — a bare name similarity is
never enough when coordinates exist for both sides::

    if name_match and distance_km > MAX_DISTANCE_KM:
        reject (or flag for manual review)

Output per (canonical HES, provider record)::

    {"matchMethod": ..., "matchConfidence": "high|medium|low",
     "distanceKm": ..., "providerTargetId": ..., "canonicalHesId": ...}
"""

from __future__ import annotations

import math
import re
import unicodedata
from typing import Any

#: A same-name reservoir farther than this is rejected, never accepted.
MAX_DISTANCE_KM = 30.0

#: Default spatial acceptance per provider family (km).
SPATIAL_RADIUS_KM = {
    "hydroweb": 15.0,
    "copernicus": 15.0,
    "dahiti": 15.0,
    "swot": 20.0,
    "sentinel": 15.0,
    "epias": 25.0,
    "g_realm": 20.0,
    "default": 15.0,
}

STOPWORDS = {"HES", "HESLER", "BARAJI", "BARAJ", "BARAJI ", "BRJ", "DAM", "DAMS",
             "RESERVOIR", "REZERVUAR", "GOLU", "GOL", "LAKE", "SANTRALI", "SANTRAL",
             "SANTRALI ", "HIDROELEKTRIK", " Ney".upper().strip(), "VE", "II", "III", "IV", "VI"}


def _strip_accents(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def normalize_name(value: Any) -> str:
    """Aggressive name key for cross-provider comparison (Roman numerals and
    parenthetical qualifiers are dropped here; the display name is untouched)."""
    text = _strip_accents(str(value or "").upper())
    text = re.sub(r"\([^)]*\)", " ", text)  # (I), (II), (pompaj), ...
    text = re.sub(r"\b(HES|HESLER|BARAJI|BARAJ|BRJ|DAMS?|RESERVOIRS?|REZERVUAR|GOL[UÜ]?|LAKES?|SANTRAL[IE]?|HIDROELEKTRIK|VE|NEHIR|CAYI|CAY)\b", " ", text)
    # Unit suffixes (I/II/III/IV and 1/2/3/4): provider dam records are per
    # reservoir, so unit numbers are insignificant for matching. Canonical
    # HES IDs stay distinct — only the match key is normalized.
    text = re.sub(r"\b([IVX]{1,4}|[1-9])\b", " ", text)
    text = re.sub(r"[^A-Z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def name_key(value: Any) -> str:
    return normalize_name(value)


def distance_km(left: tuple[float, float] | None, right: tuple[float, float] | None) -> float | None:
    if not left or not right:
        return None
    try:
        lon1, lat1, lon2, lat2 = map(math.radians, (*left, *right))
    except (TypeError, ValueError):
        return None
    hav = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    result = 6371.0088 * 2 * math.asin(math.sqrt(hav))
    return result if math.isfinite(result) else None


def name_similarity(left: str, right: str) -> float:
    """0..1 token-overlap similarity on normalized keys."""
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    a, b = set(left.split()), set(right.split())
    if not a or not b:
        return 0.0
    overlap = len(a & b) / max(len(a), len(b))
    contained = 1.0 if (left in right or right in left) and min(len(left), len(right)) >= 5 else 0.0
    return max(overlap, contained * 0.9)


def contributor(value: Any) -> tuple[float | None, float | None]:
    lon = value.get("lon") if isinstance(value, dict) else None
    lat = value.get("lat") if isinstance(value, dict) else None
    try:
        return (float(lon), float(lat)) if lon is not None and lat is not None else None
    except (TypeError, ValueError):
        return None


def feature_point(feature: dict[str, Any]) -> tuple[float, float] | None:
    geometry = feature.get("geometry") or {}
    coords = geometry.get("coordinates") or []
    if geometry.get("type") != "Point" or len(coords) < 2:
        return None
    try:
        return float(coords[0]), float(coords[1])
    except (TypeError, ValueError):
        return None


def candidate_names(props: dict[str, Any]) -> list[str]:
    names: list[str] = []
    for key in ("name", "damName", "waterBodyName", "reservoirName"):
        keyed = name_key(props.get(key))
        if keyed and keyed not in names:
            names.append(keyed)
    return names


def match_record(hes_feature: dict[str, Any], record: dict[str, Any], *,
                 provider: str = "", max_distance_km: float | None = None) -> dict[str, Any] | None:
    """Match one provider record against one canonical HES feature.

    Returns the match envelope or ``None`` (with ``rejectReason`` when the
    name matched but the distance veto fired).
    """
    props = hes_feature.get("properties") or {}
    canonical_id = str(props.get("id") or hes_feature.get("id") or "")
    hes_point = feature_point(hes_feature)
    hes_names = candidate_names(props)
    record_name = name_key(record.get("name") or record.get("damName"))
    record_point = contributor(record)
    if record_point is None:
        geometry = record.get("geometry") or {}
        coords = geometry.get("coordinates") or []
        if geometry.get("type") == "Point" and len(coords) >= 2:
            try:
                record_point = (float(coords[0]), float(coords[1]))
            except (TypeError, ValueError):
                record_point = None
    distance = distance_km(hes_point, record_point)
    similarity = max([name_similarity(record_name, name) for name in hes_names] or [0.0])

    def norm(value: Any) -> str:
        return re.sub(r"\s+", " ", str(value or "")).strip().casefold()

    basin_hit = bool(norm(props.get("basinName") or props.get("officialBasinName") or props.get("basinId"))
                     and norm(props.get("basinName") or props.get("officialBasinName") or props.get("basinId")) in norm(record.get("basinName") or record.get("basin") or "")
                     or norm(record.get("basinName") or record.get("basin") or "") and norm(record.get("basinName") or record.get("basin") or "") in norm(props.get("basinName") or props.get("officialBasinName") or props.get("basinId")))
    river_hit = bool(norm(props.get("riverName")) and norm(props.get("riverName")) in norm(record.get("riverName") or record.get("river") or ""))
    province_hit = bool(norm(props.get("province")) and norm(props.get("province")) == norm(record.get("province") or ""))
    reservoir_hit = bool((props.get("reservoirIds") or []) and record.get("providerTargetId") in (props.get("reservoirIds") or []))

    name_match = similarity >= 0.9
    fuzzy_match = 0.6 <= similarity < 0.9
    radius = SPATIAL_RADIUS_KM.get(provider, SPATIAL_RADIUS_KM["default"]) if max_distance_km is None else max_distance_km
    spatial_match = distance is not None and distance <= radius

    # Distance veto: a far same-name target is rejected, never accepted.
    if (name_match or fuzzy_match) and distance is not None and distance > MAX_DISTANCE_KM:
        return {"canonicalHesId": canonical_id, "providerTargetId": str(record.get("providerTargetId") or record.get("sourceId") or ""),
                "matchMethod": "rejected", "matchConfidence": "low", "distanceKm": round(distance, 2),
                "nameSimilarity": round(similarity, 3), "rejectReason": f"distance {distance:.1f} km > {MAX_DISTANCE_KM} km veto",
                "rejected": True}

    signals = sum([name_match, fuzzy_match, spatial_match, basin_hit, river_hit, province_hit, reservoir_hit])
    if not name_match and not (fuzzy_match and (spatial_match or basin_hit or river_hit)) and not (spatial_match and (basin_hit or river_hit or province_hit)) and not reservoir_hit:
        return None
    if name_match and spatial_match:
        method, confidence = "name+coordinate", "high" if distance is not None and distance <= 10 else "medium"
    elif reservoir_hit and (spatial_match or name_match or fuzzy_match):
        method, confidence = "reservoir-polygon", "high"
    elif name_match and (basin_hit or river_hit or province_hit):
        method, confidence = "name+basin-river", "medium"
    elif fuzzy_match and spatial_match:
        method, confidence = "fuzzy+coordinate", "medium"
    elif spatial_match and (basin_hit or river_hit):
        method, confidence = "coordinate+basin-river", "medium"
    elif name_match:
        method, confidence = "name", "medium" if basin_hit or river_hit or province_hit else "low"
    elif spatial_match:
        method, confidence = "coordinate", "low"
    else:
        method, confidence = "weak", "low"
    _ = signals
    return {"canonicalHesId": canonical_id,
            "providerTargetId": str(record.get("providerTargetId") or record.get("sourceId") or ""),
            "matchMethod": method, "matchConfidence": confidence,
            "distanceKm": round(distance, 2) if distance is not None else None,
            "nameSimilarity": round(similarity, 3),
            "basinHit": basin_hit, "riverHit": river_hit, "provinceHit": province_hit,
            "reservoirHit": reservoir_hit, "rejected": False}


def match_candidates(hes_feature: dict[str, Any], records: list[dict[str, Any]], *,
                     provider: str = "", max_distance_km: float | None = None) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Best non-rejected match + list of rejected (vetoed) candidates."""
    best: dict[str, Any] | None = None
    rejected: list[dict[str, Any]] = []
    rank = {"high": 0, "medium": 1, "low": 2}
    for record in records:
        verdict = match_record(hes_feature, record, provider=provider, max_distance_km=max_distance_km)
        if verdict is None:
            continue
        if verdict.get("rejected"):
            rejected.append({**verdict, "recordName": record.get("name") or record.get("damName")})
            continue
        key = (rank.get(str(verdict.get("matchConfidence")), 3),
               verdict.get("distanceKm") if verdict.get("distanceKm") is not None else 1e9,
               -(verdict.get("nameSimilarity") or 0))
        if best is None or key < best["_rank"]:
            best = {**verdict, "_rank": key, "record": record}
    if best is not None:
        best = {key: value for key, value in best.items() if key != "_rank"}
    return best, rejected

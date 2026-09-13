import type { Feature, FeatureCollection, Geometry, GeoJsonProperties, Position } from 'geojson';

type HydroFeature = { id?: string | number; geometry?: Geometry | null; properties?: GeoJsonProperties | null };

export function getRiverColor(flow: number, normalFlow: number): string {
  if (flow < normalFlow * 0.6) return '#fb4f72';
  if (flow > normalFlow * 1.4) return '#47c7ff';
  return '#29d3a2';
}

/** Relative color scale for real forecast rows when no observed baseline is available. */
export function getFlowScaleColor(flow: number, maxFlow: number): string {
  const ratio = maxFlow > 0 ? Math.min(1, Math.max(0, flow / maxFlow)) : 0.5;
  if (ratio < 0.5) return ratio < 0.25 ? '#38bdf8' : '#29d3a2';
  return ratio > 0.8 ? '#f7bf4f' : '#29d3a2';
}

export function getDamColor(occupancy: number): string {
  if (occupancy < 30) return '#fb4f72';
  if (occupancy >= 60) return '#31c9e8';
  return '#f7bf4f';
}

const BASIN_PALETTE_DARK = ['#8fb9b2', '#9ab4d0', '#c3a4b7', '#b8c79a', '#d0b18f', '#98c3c9', '#b5a8cf', '#cfb9a2', '#92bda9', '#b9b0d1', '#c4c59b', '#9bbad0', '#d1aeb2', '#a4c5ae', '#c0b29c', '#a5b9d0', '#c7a9bc', '#a9c5b8', '#d2bd96', '#9bb6c4', '#c0b2cf', '#b8c6a0', '#d0afa3', '#98c0c5', '#c6b09c'];
const BASIN_PALETTE_LIGHT = ['#4f8f88', '#6587a7', '#9b6d88', '#7f9a5c', '#a67b50', '#4f929c', '#806da4', '#9a7655', '#4e8d70', '#866fa6', '#8d925c', '#5d86a7', '#a86e76', '#5f9872', '#8b7155', '#6486a8', '#955f82', '#60917e', '#a27e4d', '#5b8594', '#866ea5', '#7d965d', '#a16d63', '#4e8e98', '#927557'];

export function getBasinColor(basinId: unknown, theme: 'dark' | 'light'): string {
  const numericId = Number(basinId);
  const index = Number.isFinite(numericId) ? Math.abs(Math.round(numericId) - 1) % 25 : 0;
  return (theme === 'light' ? BASIN_PALETTE_LIGHT : BASIN_PALETTE_DARK)[index];
}

export function isUnknownName(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const normalized = String(value).trim().toLocaleLowerCase('tr-TR');
  return !normalized || ['bilinmiyor', 'unknown', 'no_data', 'n/a', 'null'].includes(normalized);
}

export function displayName(properties: Record<string, unknown>, kind: 'river' | 'dam' | 'lake' | 'basin' | 'hes', id: string): string {
  const candidates = kind === 'river' ? [properties.name, properties.adi, properties.riverName] : kind === 'dam' ? [properties.name, properties.damName, properties.BarajAdi] : kind === 'lake' ? [properties.name, properties.IstAdi, properties.SuAdi] : kind === 'hes' ? [properties.name, properties.hesName, properties.IstAdi] : [properties.name, properties.HAVZA_ADI, properties.HavzaAdi];
  const value = candidates.find((candidate) => !isUnknownName(candidate));
  if (value !== undefined) return String(value);
  const labels = { river: 'Adsız akarsu', dam: 'Adsız baraj', lake: 'Adsız göl', basin: 'Adsız havza', hes: 'Adsız HES' };
  const riverCode = kind === 'river' && !isUnknownName(properties.riverCode ?? properties.nehir_kod) ? String(properties.riverCode ?? properties.nehir_kod) : id;
  return `${labels[kind]} · ${riverCode}`;
}

function propertiesOf(feature: HydroFeature): Record<string, unknown> {
  return (feature.properties ?? {}) as Record<string, unknown>;
}

function entityId(feature: HydroFeature): string {
  const properties = propertiesOf(feature);
  return String(properties.id ?? properties.entityId ?? feature.id ?? '');
}

function basinIdOf(feature: HydroFeature): string {
  const properties = propertiesOf(feature);
  return String(properties.basinId ?? properties.HAVZA_ID ?? properties.Havza_Id_Text ?? '');
}

function pointOf(feature: HydroFeature): [number, number] | null {
  if (feature.geometry?.type !== 'Point' || !Array.isArray(feature.geometry.coordinates)) return null;
  const coordinates = feature.geometry.coordinates as Position;
  return typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number' ? [coordinates[0], coordinates[1]] : null;
}

function normalizeName(value: unknown): string {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleUpperCase('tr-TR').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function comparableName(value: unknown): string {
  return normalizeName(value).replace(/\b(BARAJI?|BRJ|GIRIS|CIKIS|CIKISI|HES|CANSUYU|AGI|REGULATORU?|KOPRUSU|ISTASYONU|GOLU)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function namesRelate(left: unknown, right: unknown): boolean {
  const a = comparableName(left).replace(/ /g, '');
  const b = comparableName(right).replace(/ /g, '');
  if (a.length < 4 || b.length < 4) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const aTokens = new Set(comparableName(left).split(' ').filter((token) => token.length >= 4));
  return comparableName(right).split(' ').some((token) => token.length >= 4 && aTokens.has(token));
}

function distanceKm(left: [number, number], right: [number, number]): number {
  const latitudeScale = 111;
  const longitudeScale = 111 * Math.cos((((left[1] + right[1]) / 2) * Math.PI) / 180);
  return Math.hypot((right[0] - left[0]) * longitudeScale, (right[1] - left[1]) * latitudeScale);
}

function lineCoordinates(feature: HydroFeature): Position[] {
  if (feature.geometry?.type === 'LineString') return feature.geometry.coordinates;
  if (feature.geometry?.type === 'MultiLineString') return feature.geometry.coordinates.flat();
  return [];
}

function pointToLineKm(point: [number, number], feature: HydroFeature): number {
  const coordinates = lineCoordinates(feature);
  if (!coordinates.length) return Number.POSITIVE_INFINITY;
  return coordinates.reduce((minimum, coordinate) => {
    if (typeof coordinate[0] !== 'number' || typeof coordinate[1] !== 'number') return minimum;
    return Math.min(minimum, distanceKm(point, [coordinate[0], coordinate[1]]));
  }, Number.POSITIVE_INFINITY);
}

function endpointDistanceKm(left: HydroFeature, right: HydroFeature): number {
  const leftCoordinates = lineCoordinates(left);
  const rightCoordinates = lineCoordinates(right);
  if (!leftCoordinates.length || !rightCoordinates.length) return Number.POSITIVE_INFINITY;
  const leftEnds = [leftCoordinates[0], leftCoordinates[leftCoordinates.length - 1]];
  const rightEnds = [rightCoordinates[0], rightCoordinates[rightCoordinates.length - 1]];
  return Math.min(...leftEnds.flatMap((a) => rightEnds.map((b) => typeof a[0] === 'number' && typeof a[1] === 'number' && typeof b[0] === 'number' && typeof b[1] === 'number' ? distanceKm([a[0], a[1]], [b[0], b[1]]) : Number.POSITIVE_INFINITY)));
}

export function buildRiverNameMap(collection: FeatureCollection<Geometry, GeoJsonProperties>): Map<string, string> {
  const features = collection.features as HydroFeature[];
  const explicit = features.filter((feature) => !isUnknownName(propertiesOf(feature).name ?? propertiesOf(feature).adi));
  const names = new Map<string, string>();
  explicit.forEach((feature) => names.set(entityId(feature), displayName(propertiesOf(feature), 'river', entityId(feature))));
  features.filter((feature) => !names.has(entityId(feature))).forEach((feature) => {
    const nearbyNamed = explicit.filter((candidate) => basinIdOf(candidate) === basinIdOf(feature) && endpointDistanceKm(feature, candidate) <= 2.5);
    const uniqueNearbyNames = [...new Set(nearbyNamed.map((candidate) => displayName(propertiesOf(candidate), 'river', entityId(candidate))))];
    if (uniqueNearbyNames.length === 1) names.set(entityId(feature), uniqueNearbyNames[0]);
  });
  return names;
}

type MajorRiverDefinition = { key: string; name: string; basinId: string; stationToken: string; minStrahler: number; maxDistanceKm: number };

const MAJOR_RIVER_DEFINITIONS: MajorRiverDefinition[] = [
  { key: 'FIRAT', name: 'Fırat Nehri', basinId: '21', stationToken: 'FIRAT', minStrahler: 6, maxDistanceKm: 65 },
  { key: 'DICLE', name: 'Dicle Nehri', basinId: '21', stationToken: 'DICLE', minStrahler: 6, maxDistanceKm: 65 },
  { key: 'KIZILIRMAK', name: 'Kızılırmak', basinId: '15', stationToken: 'KIZILIRMAK', minStrahler: 5, maxDistanceKm: 55 },
  { key: 'SAKARYA', name: 'Sakarya Nehri', basinId: '12', stationToken: 'SAKARYA', minStrahler: 5, maxDistanceKm: 55 },
  { key: 'YESILIRMAK', name: 'Yeşilırmak', basinId: '14', stationToken: 'YESILIRMAK', minStrahler: 5, maxDistanceKm: 55 },
  { key: 'SEYHAN', name: 'Seyhan Nehri', basinId: '18', stationToken: 'SEYHAN', minStrahler: 5, maxDistanceKm: 55 },
  { key: 'CEYHAN', name: 'Ceyhan Nehri', basinId: '20', stationToken: 'CEYHAN', minStrahler: 5, maxDistanceKm: 55 },
  { key: 'CORUH', name: 'Çoruh Nehri', basinId: '23', stationToken: 'CORUH', minStrahler: 5, maxDistanceKm: 55 },
];

export type MajorRiverGroup = {
  id: string;
  name: string;
  basinId: string;
  memberIds: string[];
  facilityIds: string[];
  feature: Feature<Geometry, GeoJsonProperties>;
  representedLengthKm: number;
};

function stationName(feature: HydroFeature): unknown {
  const properties = propertiesOf(feature);
  return properties.SuAdi ?? properties.riverName ?? properties.name;
}

function isDamLikeStation(feature: HydroFeature): boolean {
  const value = normalizeName(propertiesOf(feature).IstAdi);
  return /BARAJ|BRJ|HES|KEBAN|KARKAMIS|ILISU|BAGISTAS/.test(value);
}

/** Builds named river groups from TATUS water-name observations without inventing a name for unrelated segments. */
export function buildMajorRiverGroups(rivers: FeatureCollection<Geometry, GeoJsonProperties>, hesStations: FeatureCollection<Geometry, GeoJsonProperties>): Map<string, MajorRiverGroup> {
  const riverFeatures = rivers.features as HydroFeature[];
  const stationFeatures = hesStations.features as HydroFeature[];
  const groups = new Map<string, MajorRiverGroup>();
  MAJOR_RIVER_DEFINITIONS.forEach((definition) => {
    const anchors = stationFeatures.filter((station) => basinIdOf(station) === definition.basinId && normalizeName(stationName(station)).includes(definition.stationToken) && pointOf(station));
    if (!anchors.length) return;
    const members = riverFeatures.filter((river) => {
      if (basinIdOf(river) !== definition.basinId || Number(propertiesOf(river).strahler) < definition.minStrahler) return false;
      const distance = Math.min(...anchors.map((anchor) => pointToLineKm(pointOf(anchor) as [number, number], river)));
      return distance <= definition.maxDistanceKm || namesRelate(propertiesOf(river).name, definition.name);
    });
    if (!members.length) return;
    const memberLines = members.map((member) => lineCoordinates(member)).filter((line) => line.length > 1);
    const anchorPoints = anchors.map((anchor) => pointOf(anchor)).filter((point): point is [number, number] => Boolean(point));
    const facilityAnchors = anchors.filter(isDamLikeStation).filter((station, index, candidates) => {
      const stationPoint = pointOf(station);
      if (!stationPoint) return false;
      return index === candidates.findIndex((candidate) => {
        const candidatePoint = pointOf(candidate);
        return candidatePoint && comparableName(propertiesOf(candidate).IstAdi) === comparableName(propertiesOf(station).IstAdi) && distanceKm(stationPoint, candidatePoint) <= 1;
      });
    });
    groups.set(`major-river:${definition.key}`, {
      id: `major-river:${definition.key}`,
      name: definition.name,
      basinId: definition.basinId,
      memberIds: members.map(entityId),
      facilityIds: facilityAnchors.map(entityId),
      feature: { type: 'Feature', id: `major-river:${definition.key}`, geometry: { type: 'GeometryCollection', geometries: [...memberLines.map((coordinates) => ({ type: 'LineString' as const, coordinates })), ...anchorPoints.map((coordinates) => ({ type: 'Point' as const, coordinates }))] }, properties: { id: `major-river:${definition.key}`, name: definition.name, riverName: definition.name, basinId: definition.basinId, majorStationIds: facilityAnchors.map(entityId), majorMemberIds: members.map(entityId) } },
      representedLengthKm: members.reduce((total, member) => { const value = Number(propertiesOf(member).lengthKm); return total + (Number.isFinite(value) ? value : 0); }, 0),
    });
  });
  return groups;
}

export type DamHesMatch = { damId: string; hesIds: string[] };

export function buildDamHesMapping(dams: FeatureCollection<Geometry, GeoJsonProperties>, hesStations: FeatureCollection<Geometry, GeoJsonProperties>): Map<string, DamHesMatch> {
  const hesFeatures = hesStations.features as HydroFeature[];
  const mapping = new Map<string, DamHesMatch>();
  (dams.features as HydroFeature[]).forEach((dam) => {
    const damProperties = propertiesOf(dam);
    const declaredHesIds = Array.isArray(damProperties.hesIds) ? damProperties.hesIds.map(String) : [];
    if (declaredHesIds.length) {
      mapping.set(entityId(dam), { damId: entityId(dam), hesIds: declaredHesIds });
      return;
    }
    const damName = damProperties.name ?? damProperties.damName ?? damProperties.BarajAdi;
    const damPoint = pointOf(dam);
    if (!damPoint || isUnknownName(damName)) return;
    const matched = hesFeatures.filter((hes) => {
      const hesProperties = propertiesOf(hes);
      const hesPoint = pointOf(hes);
      const hesName = hesProperties.name ?? hesProperties.IstAdi;
      return basinIdOf(dam) === basinIdOf(hes) && Boolean(hesPoint) && distanceKm(damPoint, hesPoint as [number, number]) <= 10 && namesRelate(damName, hesName);
    });
    if (matched.length) mapping.set(entityId(dam), { damId: entityId(dam), hesIds: matched.map(entityId) });
  });
  return mapping;
}

export function isElectricProducer(properties: Record<string, unknown>, hasHesMatch = false): boolean {
  return hasHesMatch || [properties.isHes, properties.isHES, properties.hes, properties.energyProducer, properties.producer, properties.isProducer].some((value) => value === true || value === 'true' || value === 1);
}

/** Stable demo fullness for MOCK mode. It never depends on render order. */
export function mockFullness(id: string): number {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return 25 + (Math.abs(hash) % 66);
}

export type RiverDamRelation = { ids: Set<string>; stationIds: Set<string>; confidence: 'name/spatial' | 'basin' };

export function relateRiverToDams(river: HydroFeature, dams: FeatureCollection<Geometry, GeoJsonProperties>, hesStations: FeatureCollection<Geometry, GeoJsonProperties>, damHesMapping: Map<string, DamHesMatch>): RiverDamRelation {
  const riverProperties = propertiesOf(river);
  const riverName = riverProperties.riverName ?? riverProperties.name ?? riverProperties.adi;
  const riverPointFeatures = hesStations.features as HydroFeature[];
  const majorStationIds = Array.isArray(riverProperties.majorStationIds) ? riverProperties.majorStationIds.map(String) : [];
  const strongIds = new Set<string>();
  (dams.features as HydroFeature[]).forEach((dam) => {
    const damProperties = propertiesOf(dam);
    if (basinIdOf(dam) !== basinIdOf(river)) return;
    const damMatch = damHesMapping.get(entityId(dam));
    const damPoint = pointOf(dam);
    const hesMatch = damMatch?.hesIds.some((hesId) => {
      const hes = riverPointFeatures.find((feature) => entityId(feature) === hesId);
      const hesProperties = hes ? propertiesOf(hes) : {};
      return namesRelate(riverName, hesProperties.SuAdi) || (damPoint && hes && pointToLineKm(damPoint, river) <= 8 && pointToLineKm(pointOf(hes) as [number, number], river) <= 8);
    });
    if (namesRelate(riverName, damProperties.riverName) || hesMatch || (damPoint && pointToLineKm(damPoint, river) <= 8 && !isUnknownName(riverName))) strongIds.add(entityId(dam));
  });
  if (strongIds.size || majorStationIds.length) return { ids: strongIds, stationIds: new Set(majorStationIds), confidence: 'name/spatial' };
  return { ids: new Set(), stationIds: new Set(), confidence: 'basin' };
}

export type BasinSummary = { areaKm2: number | null; riverCount: number; riverLengthKm: number; damCount: number; hesCount: number; lakeCount: number; mainRiverNames: string[] };

export function buildBasinSummaries(basins: FeatureCollection<Geometry, GeoJsonProperties>, rivers: FeatureCollection<Geometry, GeoJsonProperties>, dams: FeatureCollection<Geometry, GeoJsonProperties>, hesStations: FeatureCollection<Geometry, GeoJsonProperties>, lakes: FeatureCollection<Geometry, GeoJsonProperties>, riverNames: Map<string, string>): Map<string, BasinSummary> {
  const summaries = new Map<string, BasinSummary>();
  (basins.features as HydroFeature[]).forEach((basin) => {
    const properties = propertiesOf(basin);
    const area = Number(properties.areaKm2 ?? properties.ALAN_KM2);
    summaries.set(basinIdOf(basin), { areaKm2: Number.isFinite(area) ? area : null, riverCount: 0, riverLengthKm: 0, damCount: 0, hesCount: 0, lakeCount: 0, mainRiverNames: [] });
  });
  const namesByBasin = new Map<string, Map<string, { maxStrahler: number; lengthKm: number }>>();
  (rivers.features as HydroFeature[]).forEach((river) => {
    if (propertiesOf(river).entityType === 'riverGroup') return;
    const riverProperties = propertiesOf(river);
    const basinIds = Array.isArray(riverProperties.basinIds) ? riverProperties.basinIds.map(String) : [basinIdOf(river)];
    const validSummaries = basinIds.map((basinId) => [basinId, summaries.get(basinId)] as const).filter((entry): entry is readonly [string, BasinSummary] => Boolean(entry[1]));
    if (!validSummaries.length) return;
    const properties = riverProperties; const lengthKm = Number(properties.lengthKm ?? Number(properties.uzunluk) / 1000); const strahler = Number(properties.strahler);
    validSummaries.forEach(([, summary]) => { summary.riverCount += 1; if (Number.isFinite(lengthKm)) summary.riverLengthKm += lengthKm; });
    const name = riverNames.get(entityId(river)); if (!name || isUnknownName(name)) return;
    validSummaries.forEach(([basinId]) => { const basinNames = namesByBasin.get(basinId) ?? new Map<string, { maxStrahler: number; lengthKm: number }>(); const current = basinNames.get(name) ?? { maxStrahler: 0, lengthKm: 0 }; current.maxStrahler = Math.max(current.maxStrahler, Number.isFinite(strahler) ? strahler : 0); current.lengthKm += Number.isFinite(lengthKm) ? lengthKm : 0; basinNames.set(name, current); namesByBasin.set(basinId, basinNames); });
  });
  const count = (collection: FeatureCollection<Geometry, GeoJsonProperties>, key: 'damCount' | 'hesCount' | 'lakeCount') => (collection.features as HydroFeature[]).forEach((feature) => { const summary = summaries.get(basinIdOf(feature)); if (summary) summary[key] += 1; });
  count(dams, 'damCount'); count(hesStations, 'hesCount'); count(lakes, 'lakeCount');
  summaries.forEach((summary, basinId) => {
    const names = namesByBasin.get(basinId);
    summary.mainRiverNames = names ? [...names.entries()].sort((a, b) => b[1].maxStrahler - a[1].maxStrahler || b[1].lengthKm - a[1].lengthKm).slice(0, 5).map(([name]) => name) : [];
  });
  return summaries;
}

export function damIconBucket(occupancy: number | null): string {
  if (occupancy === null) return 'dam-pie-neutral';
  return `dam-pie-${Math.min(100, Math.max(0, Math.round(occupancy / 10) * 10))}`;
}

export function formatDataDate(value?: string | null): string {
  if (!value) return 'Veri tarihi yok';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
}

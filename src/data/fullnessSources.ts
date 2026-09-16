import type { FullnessHistoryPayload, FullnessPayload, FullnessResult } from '../types/hydrology';

type Properties = Record<string, unknown>;

const PERCENT_KEYS = ['fullnessPercent', 'occupancy', 'fullness', 'activeFullness', 'activeFullnessAmount', 'doluluk'];
const ENABLE_MOCK = import.meta.env.VITE_ENABLE_MOCK_HYDROLOGY === 'true';

export const FULLNESS_FRESHNESS_POLICY_DAYS = {
  official_live: 3,
  official_published: 10,
  satellite_altimetry: 45,
  satellite_area: 14,
  calculated_storage: 10,
  historical: 365,
  mock: 0,
} as const;

const SOURCE_PRIORITY: Record<string, number> = { official_live: 0, official: 0, official_published: 1, satellite_altimetry: 2, satellite_area: 2, calculated_storage: 3, historical: 4, mock: 9 };
const CONFIDENCE_PRIORITY: Record<string, number> = { high: 3, medium: 2, low: 1 };

function methodPriority(method: unknown): number {
  const value = String(method ?? '').toLowerCase();
  if (/(direct|normalized|official|epias|dsi)/.test(value)) return 0;
  if (/(satellite|altimetry|wse|hypsometry|area)/.test(value)) return 1;
  if (/(volume|inventory|canonical|storage)/.test(value)) return 2;
  if (/(historical|last-known-good)/.test(value)) return 3;
  return 4;
}

function numberOf(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value: number | null): number | null {
  return value === null ? null : Math.min(100, Math.max(0, value));
}

function validPercent(value: number | null): number | null {
  return value !== null && value >= 0 && value <= 100 ? value : null;
}

function dateOf(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizedSourceClass(record: Record<string, unknown>): string {
  const value = String(record.sourceClass ?? 'calculated_storage');
  return value === 'official' && String(record.source ?? '') === 'epias' ? 'official_live' : value;
}

function effectiveFreshness(record: Record<string, unknown>, reference: Date): number | null {
  const explicit = numberOf(record.freshnessDays);
  if (explicit !== null) return Math.max(0, Math.round(explicit));
  const observed = dateOf(record.observedAt);
  const fetched = dateOf(record.fetchedAt) ?? reference;
  return observed ? Math.max(0, Math.floor((fetched.getTime() - observed.getTime()) / 86400000)) : null;
}

/** Selects a fullness source without coupling the decision to a component or fetcher. */
export function selectBestFullnessRecord(records: Array<Record<string, unknown>>, referenceDate = new Date()): Record<string, unknown> | null {
  const candidates = records.flatMap((record) => {
    const value = validPercent(numberOf(record.fullnessPercent));
    if (value === null || record.status === 'not_applicable') return [];
    const observedDate = dateOf(record.observedAt);
    if (observedDate && observedDate.getTime() > referenceDate.getTime() + 86400000) return [];
    const sourceClass = normalizedSourceClass(record);
    const age = effectiveFreshness(record, referenceDate);
    const threshold = FULLNESS_FRESHNESS_POLICY_DAYS[sourceClass as keyof typeof FULLNESS_FRESHNESS_POLICY_DAYS] ?? 10;
    const stale = record.status === 'stale' || (age !== null && age > threshold);
    const priority = stale && ['official_live', 'official', 'official_published', 'satellite_altimetry', 'satellite_area'].includes(sourceClass) ? 4 : SOURCE_PRIORITY[sourceClass] ?? 8;
    const observed = observedDate?.getTime() ?? 0;
    return [{ record: { ...record, fullnessPercent: value, sourceClass, status: stale ? 'stale' : record.status ?? 'available', freshnessDays: age }, score: [priority, methodPriority(record.method), -(CONFIDENCE_PRIORITY[String(record.confidence ?? 'low')] ?? 1), -observed] as [number, number, number, number] }];
  });
  candidates.sort((left, right) => left.score[0] - right.score[0] || left.score[1] - right.score[1] || left.score[2] - right.score[2] || left.score[3] - right.score[3]);
  return candidates[0]?.record ?? null;
}

function firstNumber(source: Properties | null | undefined, keys: string[]): number | null {
  if (!source) return null;
  for (const key of keys) {
    const value = numberOf(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function calculatedStorage(properties: Properties): number | null {
  const active = firstNumber(properties, ['activeVolumeHm3', 'activeVolume', 'active_volume', 'aktifHacim', 'aktif_hacim']);
  const minimum = firstNumber(properties, ['minVolumeHm3', 'minimumVolumeHm3', 'minVolume', 'minimumVolume']);
  const maximum = firstNumber(properties, ['maxVolumeHm3', 'maximumVolumeHm3', 'maxVolume', 'maximumVolume']);
  if (active === null || minimum === null || maximum === null || maximum <= minimum) return null;
  return clamp((active / (maximum - minimum)) * 100);
}

function calculatedCurrentStorage(properties: Properties): number | null {
  const current = firstNumber(properties, ['currentVolumeHm3', 'currentVolume', 'current_volume', 'dailyVolume', 'daily_volume', 'operatingVolume', 'operating_volume', 'hacim', 'volume', 'suHacmi']);
  const minimum = firstNumber(properties, ['minVolumeHm3', 'minimumVolumeHm3', 'minVolume', 'minimumVolume']);
  const maximum = firstNumber(properties, ['maxVolumeHm3', 'maximumVolumeHm3', 'maxVolume', 'maximumVolume']);
  if (current === null || minimum === null || maximum === null || maximum <= minimum) return null;
  return clamp(((current - minimum) / (maximum - minimum)) * 100);
}

function isRunOfRiver(properties: Properties): boolean {
  return String(properties.hydroPlantStorageType ?? '').toLowerCase() === 'run_of_river';
}

function mockValue(id: string): number {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return 25 + (Math.abs(hash) % 66);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function resultFromRecord(record: Record<string, unknown>, hesId: string): FullnessResult | null {
  const value = validPercent(numberOf(record.fullnessPercent));
  const status = String(record.status ?? (value === null ? 'unavailable' : 'available')) as FullnessResult['status'];
  const storage = stringOf(record.storageType);
  return {
    hesId,
    fullnessPercent: value,
    status,
    sourceClass: (record.sourceClass ?? 'official') as FullnessResult['sourceClass'],
    source: (record.source ?? 'epias') as FullnessResult['source'],
    provider: stringOf(record.provider),
    freshnessLabel: (['fresh', 'stale', 'old', 'unknown'] as const).find((label) => label === record.freshnessLabel),
    storageType: (['storage', 'run_of_river', 'regulator', 'mixed', 'unknown'] as const).find((kind) => kind === storage),
    method: String(record.method ?? 'source-normalized'),
    observedAt: typeof record.observedAt === 'string' ? record.observedAt : null,
    sourcePublishedAt: typeof record.sourcePublishedAt === 'string' ? record.sourcePublishedAt : null,
    fetchedAt: typeof record.fetchedAt === 'string' ? record.fetchedAt : null,
    freshnessDays: numberOf(record.freshnessDays),
    confidence: (record.confidence ?? 'medium') as FullnessResult['confidence'],
    isEstimated: record.isEstimated === true,
    rawValue: numberOf(record.rawValue),
    rawUnit: typeof record.rawUnit === 'string' ? record.rawUnit : null,
    sourceUrl: typeof record.sourceUrl === 'string' ? record.sourceUrl : null,
    sourceStationId: typeof record.sourceStationId === 'string' ? record.sourceStationId : null,
    uncertainty: numberOf(record.uncertainty),
    qualityFlags: Array.isArray(record.qualityFlags) ? record.qualityFlags.map(String) : [],
    reasonUnavailable: typeof record.reasonUnavailable === 'string' ? record.reasonUnavailable : undefined,
  };
}

export function resolveHesFullness(
  hesId: string,
  properties: Properties | null | undefined,
  liveRecord?: Record<string, unknown> | null,
  dataMode: 'mock' | 'epias' = 'epias',
): FullnessResult {
  const source = properties ?? {};
  if (isRunOfRiver(source)) {
    return { hesId, fullnessPercent: null, status: 'not_applicable', sourceClass: 'calculated_storage', source: 'canonical', provider: 'Envanter', freshnessLabel: 'unknown', storageType: 'run_of_river', method: 'run-of-river-no-reservoir', observedAt: null, fetchedAt: null, freshnessDays: null, confidence: 'high', isEstimated: false, qualityFlags: ['storage_type_run_of_river'] };
  }
  const direct = validPercent(firstNumber(source, PERCENT_KEYS));
  const calculated = direct ?? calculatedStorage(source) ?? calculatedCurrentStorage(source);
  const candidates: Array<Record<string, unknown>> = [];
  if (liveRecord) candidates.push(liveRecord);
  if (source.fullnessResult && typeof source.fullnessResult === 'object') candidates.push(source.fullnessResult as Record<string, unknown>);
  if (calculated !== null) {
    const activeAvailable = calculatedStorage(source) !== null;
    candidates.push({ hesId, fullnessPercent: calculated, status: String(source.fullnessStatus ?? 'available'), sourceClass: 'calculated_storage', source: 'canonical', method: direct !== null ? 'canonical-percent' : activeAvailable ? 'active-volume/(max-volume-min-volume)' : 'current-volume/(max-volume-min-volume)', observedAt: typeof source.epiasDate === 'string' ? source.epiasDate : null, fetchedAt: null, freshnessDays: null, confidence: 'medium', isEstimated: true, rawValue: calculated, rawUnit: '%', qualityFlags: direct !== null ? [] : [activeAvailable ? 'derived_from_inventory_volume' : 'derived_from_current_volume'] });
  }
  const best = selectBestFullnessRecord(candidates);
  if (best && !(dataMode === 'mock' && ENABLE_MOCK && best.status === 'unavailable')) return resultFromRecord(best, hesId) as FullnessResult;
  const unavailable = candidates.find((record) => record.status === 'unavailable');
  if (unavailable && !(dataMode === 'mock' && ENABLE_MOCK)) return resultFromRecord(unavailable, hesId) as FullnessResult;
  if (dataMode === 'mock' && ENABLE_MOCK) {
    return { hesId, fullnessPercent: mockValue(hesId), status: 'available', sourceClass: 'mock', source: 'mock', method: 'development-seeded-value', observedAt: null, fetchedAt: null, freshnessDays: null, confidence: 'low', isEstimated: true, qualityFlags: ['development_only'] };
  }
  return { hesId, fullnessPercent: null, status: 'unavailable', sourceClass: 'calculated_storage', source: 'canonical', method: 'no-verified-fullness-source', observedAt: null, fetchedAt: null, freshnessDays: null, confidence: 'low', isEstimated: false, reasonUnavailable: 'verified fullness source unavailable', qualityFlags: ['no_data'] };
}

/** Resolves the nearest valid observation on or before a requested historical date. */
export function resolveHistoricalFullness(hesId: string, current: FullnessResult, history: FullnessHistoryPayload | null, requestedDate: string, maxAgeDays = 30): FullnessResult {
  const requested = dateOf(`${requestedDate}T23:59:59Z`);
  const points = history?.records?.find((record) => String(record.hesId) === hesId)?.points ?? [];
  if (!requested) return { ...current, status: 'unavailable', fullnessPercent: null, reasonUnavailable: 'geçersiz tarih sorgusu', isHistoricalView: true, requestedDate };
  if (requested.getTime() > Date.now() + 86400000) return { ...current, status: 'unavailable', fullnessPercent: null, reasonUnavailable: 'gelecek tarih sorgulanamaz', isHistoricalView: true, requestedDate };
  const valid = points.map((point) => ({ point, date: dateOf(point.date) })).filter((item): item is { point: NonNullable<typeof points[number]>; date: Date } => Boolean(item.date && Number.isFinite(item.point.value) && item.date.getTime() <= requested.getTime())).sort((left, right) => right.date.getTime() - left.date.getTime());
  const selected = valid[0];
  const age = selected ? Math.max(0, Math.floor((requested.getTime() - selected.date.getTime()) / 86400000)) : null;
  if (!selected || age === null || age > maxAgeDays) return { ...current, status: 'unavailable', fullnessPercent: null, observedAt: selected?.point.observedAt ?? null, freshnessDays: age, reasonUnavailable: `${requestedDate} için ${maxAgeDays} günlük gözlem penceresinde kayıt yok`, isHistoricalView: true, requestedDate };
  return { ...current, hesId, fullnessPercent: clamp(selected.point.value), status: selected.point.status === 'stale' ? 'stale' : 'available', sourceClass: selected.point.sourceClass ?? current.sourceClass, source: (selected.point.source ?? current.source) as FullnessResult['source'], method: selected.point.method ?? current.method, observedAt: selected.point.observedAt ?? selected.point.date, fetchedAt: selected.point.fetchedAt ?? null, freshnessDays: age, confidence: selected.point.confidence ?? current.confidence, isEstimated: selected.point.estimated ?? current.isEstimated, isHistoricalView: true, requestedDate };
}

/** Prefer the canonical snapshot, but let an explicitly available live source replace its N/A record. */
export function preferredFullnessRecord(primary: Record<string, unknown> | null | undefined, fallback: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const selected = selectBestFullnessRecord([primary, fallback].filter((record): record is Record<string, unknown> => Boolean(record)));
  return selected ?? primary ?? fallback ?? null;
}

export function fullnessSourceLabel(result: FullnessResult): string {
  if (result.status === 'not_applicable') return 'Uygulanamaz';
  if (result.status === 'unavailable') return 'N/A';
  const labels: Record<string, string> = { epias: 'EPİAŞ', dsi: 'DSİ', dahiti: 'DAHITI', hydroweb: 'Hydroweb', copernicus: 'CLMS', swot: 'SWOT', g_realm: 'G-REALM', sentinel: 'Uydu', canonical: 'Hacim', mock: 'MOCK' };
  return labels[result.source] ?? result.source;
}

function providerName(result: FullnessResult): string {
  const provider = typeof result.provider === 'string' && result.provider ? result.provider : null;
  return provider ?? fullnessSourceLabel(result);
}

function freshnessText(result: FullnessResult): string {
  const label = typeof result.freshnessLabel === 'string' ? result.freshnessLabel : null;
  if (label === 'fresh') return 'Taze';
  if (label === 'stale') return 'Eski';
  if (label === 'old') return 'Çok eski';
  return 'Bilinmiyor';
}

/** Explicit human-readable fullness description (never a bare N/A). */
export function describeFullness(result: FullnessResult): { cell: string; title: string } {
  const provider = providerName(result);
  const observed = typeof result.observedAt === 'string' && result.observedAt ? result.observedAt : '—';
  const confidence = result.confidence === 'high' ? 'Yüksek' : result.confidence === 'medium' ? 'Orta' : 'Düşük';
  if (result.status === 'not_applicable') {
    return { cell: 'Uygulanamaz', title: 'Doluluk uygulanamaz · Nehir tipi tesis' };
  }
  if (result.status === 'unavailable' || result.fullnessPercent === null) {
    const reason = typeof result.reasonUnavailable === 'string' && result.reasonUnavailable ? ` · ${result.reasonUnavailable}` : '';
    return { cell: 'Veri yok', title: `Doluluk verisi bulunamadı${reason}` };
  }
  const percent = `%${Math.round(result.fullnessPercent)}`;
  const freshness = freshnessText(result);
  if (result.sourceClass === 'official_live' || result.sourceClass === 'official' || result.sourceClass === 'official_published') {
    return { cell: percent, title: `Doluluk: ${percent} · Kaynak: ${provider} · Ölçüm: ${observed} · Tazelik: ${freshness}` };
  }
  if (result.sourceClass === 'satellite_altimetry' || result.sourceClass === 'satellite_area') {
    return { cell: percent, title: `Uydu tahmini: ${percent} · Kaynak: ${provider} · Ölçüm: ${observed} · Güven: ${confidence} · Tazelik: ${freshness}` };
  }
  return { cell: percent, title: `Tahmini doluluk: ${percent} · Kaynak: ${provider} · Güven: ${confidence} · Tazelik: ${freshness}` };
}

export function fullnessRecordsByHes(payload: FullnessPayload | null): Map<string, FullnessResult> {
  return new Map((payload?.records ?? []).map((record) => [String(record.hesId), record]));
}

export { ENABLE_MOCK };

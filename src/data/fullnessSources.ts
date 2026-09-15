import type { FullnessPayload, FullnessResult } from '../types/hydrology';

type Properties = Record<string, unknown>;

const PERCENT_KEYS = ['fullnessPercent', 'occupancy', 'fullness', 'activeFullness', 'activeFullnessAmount', 'doluluk'];
const ENABLE_MOCK = import.meta.env.VITE_ENABLE_MOCK_HYDROLOGY === 'true';

function numberOf(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value: number | null): number | null {
  return value === null ? null : Math.min(100, Math.max(0, value));
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

function resultFromRecord(record: Record<string, unknown>, hesId: string): FullnessResult | null {
  const value = clamp(numberOf(record.fullnessPercent));
  const status = String(record.status ?? (value === null ? 'unavailable' : 'available')) as FullnessResult['status'];
  if (status === 'unavailable' && value === null) return null;
  return {
    hesId,
    fullnessPercent: value,
    status,
    sourceClass: (record.sourceClass ?? 'official') as FullnessResult['sourceClass'],
    source: (record.source ?? 'epias') as FullnessResult['source'],
    method: String(record.method ?? 'source-normalized'),
    observedAt: typeof record.observedAt === 'string' ? record.observedAt : null,
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
    return { hesId, fullnessPercent: null, status: 'not_applicable', sourceClass: 'calculated_storage', source: 'canonical', method: 'run-of-river-no-reservoir', observedAt: null, fetchedAt: null, freshnessDays: null, confidence: 'high', isEstimated: false, qualityFlags: ['storage_type_run_of_river'] };
  }
  if (liveRecord) {
    const liveResult = resultFromRecord(liveRecord, hesId);
    if (liveResult) return liveResult;
  }
  const canonicalResult = source.fullnessResult && typeof source.fullnessResult === 'object' ? resultFromRecord(source.fullnessResult as Record<string, unknown>, hesId) : null;
  if (canonicalResult) return canonicalResult;
  const direct = clamp(firstNumber(source, PERCENT_KEYS));
  const calculated = direct ?? calculatedStorage(source) ?? calculatedCurrentStorage(source);
  if (calculated !== null) {
    const activeAvailable = calculatedStorage(source) !== null;
    return { hesId, fullnessPercent: calculated, status: String(source.fullnessStatus ?? 'available') as FullnessResult['status'], sourceClass: 'calculated_storage', source: 'canonical', method: direct !== null ? 'canonical-percent' : activeAvailable ? 'active-volume/(max-volume-min-volume)' : 'current-volume/(max-volume-min-volume)', observedAt: typeof source.epiasDate === 'string' ? source.epiasDate : null, fetchedAt: null, freshnessDays: null, confidence: 'medium', isEstimated: true, rawValue: calculated, rawUnit: '%', qualityFlags: direct !== null ? [] : [activeAvailable ? 'derived_from_inventory_volume' : 'derived_from_current_volume'] };
  }
  if (dataMode === 'mock' && ENABLE_MOCK) {
    return { hesId, fullnessPercent: mockValue(hesId), status: 'available', sourceClass: 'mock', source: 'mock', method: 'development-seeded-value', observedAt: null, fetchedAt: null, freshnessDays: null, confidence: 'low', isEstimated: true, qualityFlags: ['development_only'] };
  }
  return { hesId, fullnessPercent: null, status: 'unavailable', sourceClass: 'calculated_storage', source: 'canonical', method: 'no-verified-fullness-source', observedAt: null, fetchedAt: null, freshnessDays: null, confidence: 'low', isEstimated: false, reasonUnavailable: 'verified fullness source unavailable', qualityFlags: ['no_data'] };
}

export function fullnessSourceLabel(result: FullnessResult): string {
  if (result.status === 'not_applicable') return 'Uygulanamaz';
  if (result.status === 'unavailable') return 'N/A';
  const labels: Record<string, string> = { epias: 'EPİAŞ', dsi: 'DSİ', dahiti: 'DAHITI', hydroweb: 'Hydroweb', copernicus: 'CLMS', swot: 'SWOT', g_realm: 'G-REALM', sentinel: 'Uydu', canonical: 'Hacim', mock: 'MOCK' };
  return labels[result.source] ?? result.source;
}

export function fullnessRecordsByHes(payload: FullnessPayload | null): Map<string, FullnessResult> {
  return new Map((payload?.records ?? []).map((record) => [String(record.hesId), record]));
}

export { ENABLE_MOCK };

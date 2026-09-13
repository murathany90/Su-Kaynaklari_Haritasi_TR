import {
  emptyFeatureCollection,
  type EpiasPayload,
  type GeoglowsPayload,
  type HydroDataBundle,
  type HydroDataManifest,
  type HydrologyFeatureCollection,
  type Hes177Relations,
  type RiverMappingManifest,
} from '../types/hydrology';

const STATIC_FILES = {
  basins: '/data/hes177/hes_basins.geojson',
  rivers: '/data/hes177/hes_rivers.geojson',
  flowStations: '',
  hesStations: '/data/hes177/hes_river_anchors.geojson',
  damStations: '/data/hes177/hes_dams.geojson',
  lakes: '',
  hes177: '/data/hes177/hes_177.geojson',
} as const;

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function asFeatureCollection(value: unknown, path: string): HydrologyFeatureCollection {
  if (!value || typeof value !== 'object' || (value as { type?: string }).type !== 'FeatureCollection' || !Array.isArray((value as { features?: unknown[] }).features)) {
    throw new Error(`${path}: geçersiz GeoJSON FeatureCollection`);
  }
  return value as HydrologyFeatureCollection;
}

function asOptionalPayload<T extends object>(value: unknown): T {
  return value && typeof value === 'object' ? value as T : {} as T;
}

function reasonOf(result: PromiseSettledResult<unknown>): string {
  return result.status === 'rejected' ? result.reason instanceof Error ? result.reason.message : String(result.reason) : 'bilinmeyen hata';
}

/** Loads real static TATUS data and the latest generated live payloads. */
export async function loadHydroData(): Promise<HydroDataBundle> {
  const entries = await Promise.allSettled(
    Object.entries(STATIC_FILES).map(async ([key, path]) => [key, path ? asFeatureCollection(await readJson(path), path) : emptyFeatureCollection()] as const),
  );
  const bundle: HydroDataBundle = {
    basins: emptyFeatureCollection(), rivers: emptyFeatureCollection(), flowStations: emptyFeatureCollection(),
    hesStations: emptyFeatureCollection(), damStations: emptyFeatureCollection(), lakes: emptyFeatureCollection(), hes177: emptyFeatureCollection(), hes177Relations: null,
    manifest: null, mappingManifest: null, geoglows: null, epias: null, errors: [],
  };
  entries.forEach((entry, index) => {
    const key = Object.keys(STATIC_FILES)[index] as keyof typeof STATIC_FILES;
    if (entry.status === 'fulfilled') bundle[key] = entry.value[1];
    else bundle.errors.push(`${key}: ${reasonOf(entry)}`);
  });

  const optional = await Promise.allSettled([
    readJson<HydroDataManifest>('/data/manifest/tatus_manifest.json'),
    readJson<RiverMappingManifest>('/data/manifest/river_reach_map_manifest.json'),
    readJson<GeoglowsPayload>('/data/live/geoglows_latest.json'),
    readJson<EpiasPayload>('/data/live/epias_dams_latest.json'),
    readJson<Hes177Relations>('/data/hes177/hes_177_relations.json'),
  ]);
  if (optional[0].status === 'fulfilled') bundle.manifest = optional[0].value;
  else bundle.errors.push(`manifest: ${reasonOf(optional[0])}`);
  if (optional[1].status === 'fulfilled') bundle.mappingManifest = optional[1].value;
  else bundle.errors.push(`river mapping: ${reasonOf(optional[1])}`);
  if (optional[2].status === 'fulfilled') bundle.geoglows = asOptionalPayload<GeoglowsPayload>(optional[2].value);
  else bundle.errors.push(`GEOGLOWS: ${reasonOf(optional[2])}`);
  if (optional[3].status === 'fulfilled') bundle.epias = asOptionalPayload<EpiasPayload>(optional[3].value);
  else bundle.errors.push(`EPİAŞ: ${reasonOf(optional[3])}`);
  if (optional[4].status === 'fulfilled') bundle.hes177Relations = optional[4].value;
  else bundle.errors.push(`177 HES ilişkileri: ${reasonOf(optional[4])}`);
  return bundle;
}

export { STATIC_FILES };

export function getForecastTimestamps(payload: GeoglowsPayload | null): string[] {
  const timestamps = new Set<string>();
  (payload?.records ?? []).forEach((record) => {
    if (!Array.isArray(record.data)) return;
    record.data.forEach((row) => {
      if (row && typeof row === 'object' && typeof (row as Record<string, unknown>).datetime === 'string') timestamps.add((row as Record<string, unknown>).datetime as string);
    });
  });
  return [...timestamps].sort();
}

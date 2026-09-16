import {
  emptyFeatureCollection,
  type EpiasPayload,
  type FullnessPayload,
  type FullnessHistoryPayload,
  type GeoglowsPayload,
  type HydroDataBundle,
  type HydroDataManifest,
  type HydrologyFeatureCollection,
  type Hes177Relations,
  type RiverMappingManifest,
} from '../types/hydrology';

const DATA_BASE_URL = String(import.meta.env.VITE_HYDROLOGY_DATA_BASE_URL ?? '').replace(/\/$/, '');

const STATIC_FILES = {
  basins: '/data/hes177/hes_basins.geojson',
  rivers: '/data/hes177/hes_rivers.geojson',
  damStations: '/data/hes177/hes_dam_points.geojson',
  hes177: '/data/hes177/hes_177.geojson',
  cascades: '/data/hes177/hes_cascades.geojson',
  catchment: '',
  reservoirs: '/data/hes177/hes_reservoirs.geojson',
} as const;

async function readJson<T>(path: string): Promise<T> {
  const requestPath = /^https?:\/\//.test(path) ? path : `${DATA_BASE_URL}${path}`;
  const response = await fetch(requestPath, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${requestPath}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function versionedPath(path: string, version: string | number | null | undefined): string {
  return version === null || version === undefined ? path : `${path}?v=${encodeURIComponent(String(version))}`;
}

function asFeatureCollection(value: unknown, path: string): HydrologyFeatureCollection {
  if (!value || typeof value !== 'object' || (value as { type?: string }).type !== 'FeatureCollection' || !Array.isArray((value as { features?: unknown[] }).features)) {
    throw new Error(`${path}: invalid GeoJSON FeatureCollection`);
  }
  return value as HydrologyFeatureCollection;
}

function asOptionalPayload<T extends object>(value: unknown): T {
  return value && typeof value === 'object' ? value as T : {} as T;
}

function reasonOf(result: PromiseSettledResult<unknown>): string {
  return result.status === 'rejected' ? result.reason instanceof Error ? result.reason.message : String(result.reason) : 'unknown error';
}

function validateCanonicalCounts(bundle: HydroDataBundle, manifest: HydroDataManifest | null): void {
  if (!manifest) return;
  const checks: Array<[string, number | undefined, number]> = [
    ['HES', typeof manifest.hesCount === 'number' ? manifest.hesCount : undefined, bundle.hes177.features.length],
    ['basin', typeof manifest.basinCount === 'number' ? manifest.basinCount : undefined, bundle.basins.features.length],
    ['logical river', typeof manifest.logicalRiverCount === 'number' ? manifest.logicalRiverCount : undefined, bundle.rivers.features.length],
    ['dam', typeof manifest.damCount === 'number' ? manifest.damCount : undefined, bundle.damStations.features.length],
  ];
  checks.forEach(([label, expected, actual]) => {
    if (expected !== undefined && expected !== actual) bundle.errors.push(`canonical ${label} count: manifest ${expected}, runtime ${actual}`);
  });
}

/** Loads real static TATUS data and the latest generated live payloads. */
export async function loadHydroData(): Promise<HydroDataBundle> {
  const canonicalManifestResult = await Promise.allSettled([
    readJson<HydroDataManifest>('/data/hes177/hes_177_manifest.json'),
  ]);
  const canonicalManifest = canonicalManifestResult[0].status === 'fulfilled' ? canonicalManifestResult[0].value : null;
  const assetVersion = canonicalManifest?.dataVersion ?? canonicalManifest?.version;
  const entries = await Promise.allSettled(
    Object.entries(STATIC_FILES).map(async ([key, path]) => [key, path ? asFeatureCollection(await readJson(versionedPath(path, assetVersion)), path) : emptyFeatureCollection()] as const),
  );
  const bundle: HydroDataBundle = {
    basins: emptyFeatureCollection(), rivers: emptyFeatureCollection(), damStations: emptyFeatureCollection(), hes177: emptyFeatureCollection(), cascades: emptyFeatureCollection(), catchment: emptyFeatureCollection(), reservoirs: emptyFeatureCollection(), hes177Relations: null,
    manifest: null, hes177Manifest: canonicalManifest, mappingManifest: null, geoglows: null, epias: null, fullness: null, errors: [],
  };
  if (canonicalManifestResult[0].status === 'rejected') bundle.errors.push(`177 HES manifest: ${reasonOf(canonicalManifestResult[0])}`);
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
    readJson<FullnessPayload>(versionedPath('/data/live/hes_fullness_latest.json', assetVersion)),
    readJson<Hes177Relations>(versionedPath('/data/hes177/hes_177_relations.json', assetVersion)),
  ]);
  if (optional[0].status === 'fulfilled') bundle.manifest = optional[0].value;
  else bundle.errors.push(`manifest: ${reasonOf(optional[0])}`);
  if (optional[1].status === 'fulfilled') bundle.mappingManifest = optional[1].value;
  else bundle.errors.push(`river mapping: ${reasonOf(optional[1])}`);
  if (optional[2].status === 'fulfilled') bundle.geoglows = asOptionalPayload<GeoglowsPayload>(optional[2].value);
  else bundle.errors.push(`GEOGLOWS: ${reasonOf(optional[2])}`);
  if (optional[3].status === 'fulfilled') bundle.epias = asOptionalPayload<EpiasPayload>(optional[3].value);
  else bundle.errors.push(`EPIAS: ${reasonOf(optional[3])}`);
  if (optional[4].status === 'fulfilled') bundle.fullness = asOptionalPayload<FullnessPayload>(optional[4].value);
  else bundle.errors.push(`fullness: ${reasonOf(optional[4])}`);
  if (optional[5].status === 'fulfilled') bundle.hes177Relations = optional[5].value;
  else bundle.errors.push(`177 HES relations: ${reasonOf(optional[5])}`);
  validateCanonicalCounts(bundle, canonicalManifest);
  return bundle;
}

/** History is intentionally loaded only after the user opens/selects a HES. */
export async function loadFullnessHistory(version?: string | number | null): Promise<FullnessHistoryPayload> {
  return readJson<FullnessHistoryPayload>(versionedPath('/data/timeseries/hes_fullness_365d.json', version));
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

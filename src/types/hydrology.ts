import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';

export type HydrologyFeatureCollection = FeatureCollection<Geometry, GeoJsonProperties>;

export interface HydroSourceMeta {
  source: string;
  status: string;
  generatedAt?: string;
  featureCount?: number;
  error?: string;
}

export interface HydroDataManifest {
  version?: string | number;
  generatedAt?: string;
  dataVersion?: string;
  buildBaseCommit?: string | null;
  status?: string;
  source?: string;
  layers?: Array<{ key: string; featureCount?: number; status?: string; source?: string }>;
  [key: string]: unknown;
}

export type FullnessStatus = 'available' | 'stale' | 'not_applicable' | 'unavailable';
export type FullnessSourceClass = 'official' | 'official_live' | 'official_published' | 'satellite_altimetry' | 'satellite_area' | 'calculated_storage' | 'historical' | 'mock';
export type FullnessSource = 'epias' | 'dsi' | 'dahiti' | 'hydroweb' | 'copernicus' | 'swot' | 'g_realm' | 'sentinel' | 'canonical' | 'mock';
export type FullnessConfidence = 'high' | 'medium' | 'low';

export interface FullnessResult {
  hesId: string;
  fullnessPercent: number | null;
  status: FullnessStatus;
  sourceClass: FullnessSourceClass;
  source: FullnessSource;
  provider?: string;
  freshnessLabel?: 'fresh' | 'stale' | 'old' | 'unknown';
  storageType?: 'storage' | 'run_of_river' | 'regulator' | 'mixed' | 'unknown';
  method: string;
  observedAt: string | null;
  sourcePublishedAt?: string | null;
  fetchedAt: string | null;
  freshnessDays: number | null;
  confidence: FullnessConfidence;
  isEstimated: boolean;
  rawValue?: number | null;
  rawUnit?: string | null;
  sourceUrl?: string | null;
  sourceStationId?: string | null;
  uncertainty?: number | null;
  qualityFlags?: string[];
  reasonUnavailable?: string;
  [key: string]: unknown;
}

export interface FullnessPayload {
  dataVersion?: string;
  pipelineRunAt?: string;
  latestObservationAt?: string | null;
  generatedAt?: string;
  status?: string;
  sources?: Record<string, Record<string, unknown>>;
  coverage?: Record<string, unknown>;
  records?: FullnessResult[];
  [key: string]: unknown;
}

export interface FullnessHistoryPoint {
  date: string;
  value: number;
  source?: string;
  sourceClass?: FullnessSourceClass;
  confidence?: FullnessConfidence;
  estimated?: boolean;
  status?: FullnessStatus;
  method?: string;
  observedAt?: string | null;
  fetchedAt?: string | null;
}

export interface FullnessHistoryRecord {
  hesId: string;
  points: FullnessHistoryPoint[];
}

export interface FullnessHistoryPayload {
  dataVersion?: string;
  pipelineRunAt?: string;
  latestObservationAt?: string | null;
  rangeDays?: number;
  recordCount?: number;
  observationCount?: number;
  records?: FullnessHistoryRecord[];
}

export interface GeoglowsRecord {
  localRiverId?: string;
  geoglowsRiverId?: string | number;
  data?: unknown;
  [key: string]: unknown;
}

export interface GeoglowsPayload {
  generatedAt?: string;
  status?: string;
  records?: GeoglowsRecord[];
  [key: string]: unknown;
}

export interface RiverMappingManifest {
  count?: number;
  matchedCount?: number;
  status?: string;
  generatedAt?: string;
  [key: string]: unknown;
}

export interface EpiasPayload {
  generatedAt?: string;
  status?: string;
  records?: Array<Record<string, unknown>>;
  errors?: string[];
  [key: string]: unknown;
}

export type HydroLoadStatus = 'idle' | 'loading' | 'ready' | 'partial' | 'failed';

export interface HydroDataBundle {
  basins: HydrologyFeatureCollection;
  rivers: HydrologyFeatureCollection;
  damStations: HydrologyFeatureCollection;
  hes177: HydrologyFeatureCollection;
  cascades: HydrologyFeatureCollection;
  catchment: HydrologyFeatureCollection;
  reservoirs: HydrologyFeatureCollection;
  hes177Relations: Hes177Relations | null;
  manifest: HydroDataManifest | null;
  hes177Manifest: HydroDataManifest | null;
  mappingManifest: RiverMappingManifest | null;
  geoglows: GeoglowsPayload | null;
  epias: EpiasPayload | null;
  fullness: FullnessPayload | null;
  errors: string[];
}

export interface Hes177Relations {
  byHesId?: Record<string, Hes177Relation>;
  cascadeEdges?: Array<{ fromId: string; toId: string; fromName?: string; toName?: string }>;
  basinSummaries?: Array<Record<string, unknown>>;
  damLinks?: Record<string, string[]>;
  [key: string]: unknown;
}

export interface Hes177Relation {
  riverName?: string | null;
  riverGroup?: string | null;
  riverMatchMethod?: string | null;
  riverConfidence?: string | null;
  damId?: string | null;
  damIds?: string[];
  riverIds?: string[];
  riverSystemId?: string | null;
  riverSystemIds?: string[];
  catchmentUrl?: string | null;
  cascadeToId?: string | null;
  cascadeFromIds?: string[];
  cascadeChainId?: string | null;
  cascadeOrder?: number | null;
  [key: string]: unknown;
}

export function emptyFeatureCollection(): HydrologyFeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

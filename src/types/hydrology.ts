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
  generatedAt?: string;
  status?: string;
  source?: string;
  layers?: Array<{ key: string; featureCount?: number; status?: string; source?: string }>;
  [key: string]: unknown;
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
  flowStations: HydrologyFeatureCollection;
  hesStations: HydrologyFeatureCollection;
  damStations: HydrologyFeatureCollection;
  lakes: HydrologyFeatureCollection;
  hes177: HydrologyFeatureCollection;
  hes177Relations: Hes177Relations | null;
  manifest: HydroDataManifest | null;
  mappingManifest: RiverMappingManifest | null;
  geoglows: GeoglowsPayload | null;
  epias: EpiasPayload | null;
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
  cascadeToId?: string | null;
  cascadeFromIds?: string[];
  cascadeChainId?: string | null;
  cascadeOrder?: number | null;
  [key: string]: unknown;
}

export function emptyFeatureCollection(): HydrologyFeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

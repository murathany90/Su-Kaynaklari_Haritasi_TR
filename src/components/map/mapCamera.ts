import type { Feature, FeatureCollection, Geometry, GeoJsonProperties, Position } from 'geojson';
import type { Map as MapLibreMap, LngLatLike } from 'maplibre-gl';

export type Selection = { type: string; id: string };
export type FocusDatasets = {
  rivers: FeatureCollection<Geometry, GeoJsonProperties>;
  basins: FeatureCollection<Geometry, GeoJsonProperties>;
  flowStations: FeatureCollection<Geometry, GeoJsonProperties>;
  hesStations: FeatureCollection<Geometry, GeoJsonProperties>;
  dams: FeatureCollection<Geometry, GeoJsonProperties>;
  lakes: FeatureCollection<Geometry, GeoJsonProperties>;
  hes177: FeatureCollection<Geometry, GeoJsonProperties>;
  cascades: FeatureCollection<Geometry, GeoJsonProperties>;
  riverGroups?: Map<string, Feature<Geometry, GeoJsonProperties>>;
};

const FOCUS_PADDING = { top: 72, right: 72, bottom: 184, left: 72 };

function featureId(feature: Feature<Geometry, GeoJsonProperties>): string | null {
  const value = feature.properties?.id ?? feature.properties?.entityId ?? feature.properties?.OBJECTID ?? feature.id;
  return value === undefined || value === null ? null : String(value);
}

function basinFeatureId(feature: Feature<Geometry, GeoJsonProperties>): string | null {
  const value = feature.properties?.basinId ?? feature.properties?.HAVZA_ID ?? feature.properties?.ID;
  return value === undefined || value === null ? null : String(value);
}

function positions(geometry: Geometry | null): Position[] {
  if (!geometry) return [];
  if (geometry.type === 'Point') return [geometry.coordinates];
  if (geometry.type === 'MultiPoint' || geometry.type === 'LineString') return geometry.coordinates;
  if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') return geometry.coordinates.flat();
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat(2);
  if (geometry.type === 'GeometryCollection') return geometry.geometries.flatMap((item) => positions(item));
  return [];
}

function findFeature(selection: Selection, datasets: FocusDatasets): Feature<Geometry, GeoJsonProperties> | null {
  if (selection.type === 'river' && datasets.riverGroups?.has(selection.id)) return datasets.riverGroups.get(selection.id) ?? null;
  const collection = datasets[selection.type === 'river' ? 'rivers' : selection.type === 'basin' ? 'basins' : selection.type === 'lake' ? 'lakes' : selection.type === 'dam' ? 'dams' : selection.type === 'hes' ? 'hes177' : 'hesStations'];
  return collection?.features.find((feature) => (selection.type === 'basin' ? basinFeatureId(feature) : featureId(feature)) === selection.id) ?? null;
}

function boundsFor(points: Position[]): [[number, number], [number, number]] | null {
  if (!points.length) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  points.forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); });
  return [[minX, minY], [maxX, maxY]];
}

export function focusSelectedEntity(map: MapLibreMap, selection: Selection, datasets: FocusDatasets): boolean {
  const feature = findFeature(selection, datasets);
  if (!feature) return false;
  const points = positions(feature.geometry);
  if (!points.length) return false;
  if (selection.type === 'hes') {
    const relation = (feature.properties ?? {}) as Record<string, unknown>;
    const relatedIds = new Set([selection.id, ...(Array.isArray(relation.damIds) ? relation.damIds.map(String) : []), ...(Array.isArray(relation.stationIds) ? relation.stationIds.map(String) : [])]);
    const relatedPoints = [
      ...datasets.hes177.features,
      ...datasets.dams.features,
      ...datasets.hesStations.features,
    ].filter((candidate) => { const id = featureId(candidate); return id !== null && relatedIds.has(id); }).flatMap((candidate) => positions(candidate.geometry));
    if (relatedPoints.length > 1) {
      const relatedBounds = boundsFor(relatedPoints);
      if (relatedBounds) {
        map.fitBounds(relatedBounds, { padding: FOCUS_PADDING, maxZoom: 11, duration: 950, essential: true });
        return true;
      }
    }
  }
  if (feature.geometry?.type === 'Point') {
    map.flyTo({ center: points[0] as LngLatLike, zoom: selection.type === 'basin' ? 7.6 : 9.6, padding: FOCUS_PADDING, duration: 850, essential: true });
    return true;
  }
  const bounds = boundsFor(points);
  if (!bounds) return false;
  map.fitBounds(bounds, { padding: FOCUS_PADDING, maxZoom: selection.type === 'basin' ? 8 : 10, duration: 950, essential: true });
  return true;
}

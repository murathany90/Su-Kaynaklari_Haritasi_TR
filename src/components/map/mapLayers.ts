import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';
import type { FilterSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

export type OverlayCollection = FeatureCollection<Geometry, GeoJsonProperties>;

export type OverlayCollections = {
  rivers: OverlayCollection;
  basins: OverlayCollection;
  flowStations: OverlayCollection;
  hesStations: OverlayCollection;
  dams: OverlayCollection;
  lakes: OverlayCollection;
};

export type OverlayOptions = {
  rivers: boolean;
  flowStations: boolean;
  hesStations: boolean;
  dams: boolean;
  lakes: boolean;
  basins: boolean;
  outlineColor: string;
  selectedEntity: { type: string; id: string } | null;
};

const SOURCE_IDS = ['basins', 'rivers', 'flowStations', 'hesStations', 'dams', 'lakes'] as const;
const OVERLAY_LAYER_IDS = [
  'basins-fill', 'basins-outline', 'rivers-glow', 'rivers-core',
  'rivers-detail', 'rivers-selected', 'basins-selected', 'flow-stations', 'hes-stations',
  'lakes-halo', 'lakes-points', 'lakes-selected', 'dams-halo', 'dams-points', 'dams-selected',
] as const;

function setGeoJsonSource(map: MapLibreMap, id: string, data: OverlayCollection): void {
  const source = map.getSource(id) as GeoJSONSource | undefined;
  if (source) void source.setData(data).catch(() => undefined);
}

function addLayerIfMissing(map: MapLibreMap, layer: Parameters<MapLibreMap['addLayer']>[0]): void {
  if (!map.getLayer(layer.id)) map.addLayer(layer);
}

function setVisibility(map: MapLibreMap, id: string, visible: boolean): void {
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
}

/** Adds and reconciles native GeoJSON overlays after every MapLibre style swap. */
export function ensureHydrologyOverlay(map: MapLibreMap, collections: OverlayCollections, options: OverlayOptions): boolean {
  if (!map.isStyleLoaded()) return false;

  for (const id of SOURCE_IDS) {
    const data = collections[id];
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data });
    else setGeoJsonSource(map, id, data);
  }

  addLayerIfMissing(map, {
    id: 'basins-fill', type: 'fill', source: 'basins',
    paint: { 'fill-color': ['coalesce', ['get', 'color'], '#2563eb'], 'fill-opacity': 0.08 },
  });
  addLayerIfMissing(map, {
    id: 'basins-outline', type: 'line', source: 'basins',
    paint: { 'line-color': '#60a5fa', 'line-width': 1.2, 'line-opacity': 0.35 },
  });
  addLayerIfMissing(map, {
    id: 'rivers-glow', type: 'line', source: 'rivers',
    minzoom: 5,
    filter: ['>=', ['coalesce', ['get', 'strahler'], 0], 4],
    paint: { 'line-color': ['coalesce', ['get', 'color'], '#38bdf8'], 'line-width': ['+', ['coalesce', ['get', 'width'], 2.8], 7], 'line-opacity': 0.2, 'line-blur': 3 },
  });
  addLayerIfMissing(map, {
    id: 'rivers-core', type: 'line', source: 'rivers',
    minzoom: 5,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['coalesce', ['get', 'color'], '#38bdf8'], 'line-width': ['interpolate', ['linear'], ['zoom'], 5, ['*', ['coalesce', ['get', 'width'], 2.8], 0.45], 9, ['coalesce', ['get', 'width'], 2.8], 13, ['*', ['coalesce', ['get', 'width'], 2.8], 1.35]], 'line-opacity': 0.95 },
  });
  addLayerIfMissing(map, {
    id: 'rivers-detail', type: 'line', source: 'rivers', minzoom: 8,
    filter: ['<', ['coalesce', ['get', 'strahler'], 0], 4],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['coalesce', ['get', 'color'], '#38bdf8'], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.55, 13, 1.5], 'line-opacity': 0.72 },
  });
  addLayerIfMissing(map, {
    id: 'rivers-selected', type: 'line', source: 'rivers', minzoom: 4,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#f8fafc', 'line-width': ['+', ['coalesce', ['get', 'width'], 3], 3], 'line-opacity': 1 },
  });
  addLayerIfMissing(map, {
    id: 'flow-stations', type: 'circle', source: 'flowStations',
    minzoom: 6.5,
    paint: { 'circle-radius': 2.8, 'circle-color': ['coalesce', ['get', 'color'], '#94a3b8'], 'circle-opacity': 0.78, 'circle-stroke-width': 1, 'circle-stroke-color': options.outlineColor },
  });
  addLayerIfMissing(map, {
    id: 'hes-stations', type: 'circle', source: 'hesStations',
    minzoom: 6,
    paint: { 'circle-radius': 5, 'circle-color': '#a78bfa', 'circle-stroke-width': 1.5, 'circle-stroke-color': options.outlineColor },
  });
  addLayerIfMissing(map, {
    id: 'lakes-halo', type: 'circle', source: 'lakes',
    minzoom: 7,
    paint: { 'circle-radius': 18, 'circle-color': ['coalesce', ['get', 'color'], '#94a3b8'], 'circle-opacity': 0.16, 'circle-blur': 0.4 },
  });
  addLayerIfMissing(map, {
    id: 'lakes-points', type: 'circle', source: 'lakes',
    minzoom: 7,
    paint: { 'circle-radius': ['coalesce', ['get', 'radius'], 7], 'circle-color': ['coalesce', ['get', 'color'], '#94a3b8'], 'circle-opacity': 0.82, 'circle-stroke-width': 2, 'circle-stroke-color': options.outlineColor },
  });
  addLayerIfMissing(map, {
    id: 'dams-halo', type: 'circle', source: 'dams',
    minzoom: 7,
    paint: { 'circle-radius': ['+', ['coalesce', ['get', 'radius'], 8], 7], 'circle-color': ['coalesce', ['get', 'color'], '#94a3b8'], 'circle-opacity': 0.2, 'circle-blur': 0.4 },
  });
  addLayerIfMissing(map, {
    id: 'dams-points', type: 'circle', source: 'dams',
    minzoom: 7,
    paint: { 'circle-radius': ['coalesce', ['get', 'radius'], 8], 'circle-color': ['coalesce', ['get', 'color'], '#94a3b8'], 'circle-stroke-width': 2, 'circle-stroke-color': options.outlineColor },
  });
  addLayerIfMissing(map, {
    id: 'basins-selected', type: 'line', source: 'basins',
    paint: { 'line-color': '#f8fafc', 'line-width': 3, 'line-opacity': 1 },
  });
  addLayerIfMissing(map, {
    id: 'lakes-selected', type: 'circle', source: 'lakes', minzoom: 4,
    paint: { 'circle-radius': ['+', ['coalesce', ['get', 'radius'], 7], 4], 'circle-color': 'transparent', 'circle-stroke-width': 3, 'circle-stroke-color': '#f8fafc' },
  });
  addLayerIfMissing(map, {
    id: 'dams-selected', type: 'circle', source: 'dams', minzoom: 4,
    paint: { 'circle-radius': ['+', ['coalesce', ['get', 'radius'], 8], 4], 'circle-color': 'transparent', 'circle-stroke-width': 3, 'circle-stroke-color': '#f8fafc' },
  });

  setVisibility(map, 'basins-fill', options.basins);
  setVisibility(map, 'basins-outline', options.basins);
  setVisibility(map, 'rivers-glow', options.rivers);
  setVisibility(map, 'rivers-core', options.rivers);
  setVisibility(map, 'rivers-detail', options.rivers);
  setVisibility(map, 'rivers-selected', options.rivers);
  setVisibility(map, 'flow-stations', options.flowStations);
  setVisibility(map, 'hes-stations', options.hesStations);
  setVisibility(map, 'lakes-halo', options.lakes);
  setVisibility(map, 'lakes-points', options.lakes);
  setVisibility(map, 'dams-halo', options.dams);
  setVisibility(map, 'dams-points', options.dams);
  setVisibility(map, 'basins-selected', options.basins);
  setVisibility(map, 'lakes-selected', options.lakes);
  setVisibility(map, 'dams-selected', options.dams);
  const noSelection: FilterSpecification = ['==', ['get', 'id'], '__no_selection__'];
  const selectedFilter: FilterSpecification = options.selectedEntity ? ['==', ['get', 'id'], options.selectedEntity.id] : noSelection;
  if (map.getLayer('rivers-selected')) map.setFilter('rivers-selected', options.selectedEntity?.type === 'river' ? selectedFilter : noSelection);
  if (map.getLayer('basins-selected')) map.setFilter('basins-selected', options.selectedEntity?.type === 'basin' ? selectedFilter : noSelection);
  if (map.getLayer('lakes-selected')) map.setFilter('lakes-selected', options.selectedEntity?.type === 'lake' ? selectedFilter : noSelection);
  if (map.getLayer('dams-selected')) map.setFilter('dams-selected', options.selectedEntity?.type === 'dam' ? selectedFilter : noSelection);
  for (const id of ['flow-stations', 'lakes-points', 'dams-points']) {
    if (map.getLayer(id)) map.setPaintProperty(id, 'circle-stroke-color', options.outlineColor);
  }
  return SOURCE_IDS.every((id) => Boolean(map.getSource(id))) && OVERLAY_LAYER_IDS.every((id) => Boolean(map.getLayer(id)));
}

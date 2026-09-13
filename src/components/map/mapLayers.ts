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
  hes177: OverlayCollection;
  cascades: OverlayCollection;
  catchment: OverlayCollection;
};

export type OverlayOptions = {
  rivers: boolean;
  flowStations: boolean;
  hesStations: boolean;
  dams: boolean;
  lakes: boolean;
  basins: boolean;
  hes177: boolean;
  outlineColor: string;
  selectionColor: string;
  basinOutlineColor: string;
  riverGlowColor: string;
  selectedEntity: { type: string; id: string } | null;
  selectedBasinId: string | null;
  selectedRiverMemberIds: string[];
};

const SOURCE_IDS = ['basins', 'rivers', 'flowStations', 'hesStations', 'dams', 'lakes', 'hes177', 'cascades', 'catchment'] as const;
const HES_PIE_LAYER_ID = 'hes177-pie';
export const DAM_PIE_BUCKETS = ['neutral', ...Array.from({ length: 11 }, (_, index) => String(index * 10))];
export const DAM_PIE_LAYER_IDS = DAM_PIE_BUCKETS.map((bucket) => `dams-pie-${bucket}`);
const OVERLAY_LAYER_IDS = [
    'basins-fill', 'basins-outline', 'rivers-glow', 'rivers-core',
  'rivers-detail', 'rivers-flow', 'rivers-selected', 'basins-selected', 'flow-stations', 'hes-stations', 'hes-related',
  'lakes-halo', 'lakes-points', 'lakes-selected', 'dams-halo', 'dams-points', 'dams-related', 'dams-selected',
  ...DAM_PIE_LAYER_IDS, 'dams-producer', 'hes177-halo', 'hes177-points', 'hes177-related', HES_PIE_LAYER_ID, 'hes177-producer', 'hes177-selected', 'hes-cascades', 'hes-catchment-fill', 'hes-catchment-outline',
] as const;

const pendingDamImages = new WeakMap<MapLibreMap, Set<string>>();

function damPieSvg(percent: number | null): string {
  const base = '<circle cx="32" cy="32" r="27" fill="#a5f3fc" fill-opacity="0.72"/>';
  const frame = '<circle cx="32" cy="32" r="29" fill="none" stroke="#f8fafc" stroke-width="2.5"/><circle cx="32" cy="32" r="25" fill="none" stroke="#0e7490" stroke-opacity="0.7" stroke-width="1"/>';
  if (percent === null || percent <= 0) return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${base}${frame}</svg>`;
  if (percent >= 100) return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="27" fill="#075985" fill-opacity="0.94"/>${frame}</svg>`;
  const end = (Math.PI * 2 * percent) / 100 - Math.PI / 2;
  const x = 32 + 27 * Math.cos(end);
  const y = 32 + 27 * Math.sin(end);
  const largeArc = percent > 50 ? 1 : 0;
  const wedge = `<path d="M32 32 L32 5 A27 27 0 ${largeArc} 1 ${x} ${y} Z" fill="#075985" fill-opacity="0.94"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${base}${wedge}${frame}</svg>`;
}

function ensureDamPieImages(map: MapLibreMap, onReady: () => void): boolean {
  const pending = pendingDamImages.get(map) ?? new Set<string>();
  pendingDamImages.set(map, pending);
  let ready = true;
  DAM_PIE_BUCKETS.forEach((bucket) => {
    const id = `dam-pie-${bucket}`;
    if (map.hasImage(id) || pending.has(id)) return;
    ready = false;
    pending.add(id);
    const image = new Image();
    image.onload = () => {
      pending.delete(id);
      if (map.isStyleLoaded() && !map.hasImage(id)) map.addImage(id, image, { pixelRatio: 2 });
      if (!pending.size) onReady();
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(damPieSvg(bucket === 'neutral' ? null : Number(bucket)))}`;
  });
  return ready && pending.size === 0;
}

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
export function ensureHydrologyOverlay(map: MapLibreMap, collections: OverlayCollections, options: OverlayOptions, onImagesReady?: () => void): boolean {
  if (!map.isStyleLoaded()) return false;
  const pieImagesReady = ensureDamPieImages(map, onImagesReady ?? (() => undefined));

  for (const id of SOURCE_IDS) {
    const data = collections[id];
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data });
    else setGeoJsonSource(map, id, data);
  }

  addLayerIfMissing(map, {
    id: 'hes177-halo', type: 'circle', source: 'hes177', minzoom: 4,
    paint: { 'circle-radius': ['coalesce', ['get', 'visualRadius'], 6], 'circle-color': '#22d3ee', 'circle-opacity': ['case', ['get', 'dimmed'], 0.04, 0.2], 'circle-blur': 0.6 },
  });
  addLayerIfMissing(map, {
    id: 'hes177-points', type: 'circle', source: 'hes177', minzoom: 4,
    paint: { 'circle-radius': ['coalesce', ['get', 'visualRadius'], 6], 'circle-color': ['case', ['get', 'dimmed'], '#64748b', '#38bdf8'], 'circle-opacity': ['case', ['get', 'dimmed'], 0.2, 0.96], 'circle-stroke-width': 2, 'circle-stroke-color': '#f8fafc' },
  });
  addLayerIfMissing(map, {
    id: 'hes177-related', type: 'circle', source: 'hes177', minzoom: 4,
    filter: ['==', ['get', 'relatedToSelected'], true],
    paint: { 'circle-radius': ['+', ['coalesce', ['get', 'visualRadius'], 6], 4], 'circle-color': '#67e8f9', 'circle-opacity': 0.96, 'circle-stroke-width': 2, 'circle-stroke-color': '#f8fafc' },
  });
  if (pieImagesReady) addLayerIfMissing(map, {
    id: HES_PIE_LAYER_ID, type: 'symbol', source: 'hes177', minzoom: 4,
    layout: { 'icon-image': ['get', 'damIcon'], 'icon-size': ['/', ['coalesce', ['get', 'markerDiameterPx'], 12], 29], 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    paint: { 'icon-opacity': ['case', ['get', 'dimmed'], 0.2, 1] },
  });
  addLayerIfMissing(map, {
    id: 'hes177-producer', type: 'symbol', source: 'hes177', minzoom: 4,
    filter: ['==', ['get', 'isProducer'], true],
    layout: { 'text-field': '⚡', 'text-size': ['interpolate', ['linear'], ['zoom'], 5, 8, 10, 13], 'text-offset': [0.9, -0.9], 'text-allow-overlap': true, 'text-ignore-placement': true },
    paint: { 'text-color': '#fbbf24', 'text-halo-color': '#0f172a', 'text-halo-width': 1, 'text-opacity': ['case', ['get', 'dimmed'], 0.2, 1] },
  });
  addLayerIfMissing(map, {
    id: 'hes-catchment-fill', type: 'fill', source: 'catchment',
    paint: { 'fill-color': '#22d3ee', 'fill-opacity': 0.12 },
  });
  addLayerIfMissing(map, {
    id: 'hes-catchment-outline', type: 'line', source: 'catchment',
    paint: { 'line-color': '#22d3ee', 'line-width': 2, 'line-opacity': 0.82, 'line-dasharray': [2, 1.2] },
  });
  addLayerIfMissing(map, {
    id: 'hes-cascades', type: 'line', source: 'cascades', minzoom: 5,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#f59e0b', 'line-width': 1.5, 'line-opacity': 0.25, 'line-dasharray': [1.2, 2.2] },
  });
  addLayerIfMissing(map, {
    id: 'hes177-selected', type: 'circle', source: 'hes177', minzoom: 4,
    paint: { 'circle-radius': ['+', ['coalesce', ['get', 'visualRadius'], 6], 5], 'circle-color': 'transparent', 'circle-stroke-width': 3, 'circle-stroke-color': options.selectionColor },
  });
  addLayerIfMissing(map, {
    id: 'basins-fill', type: 'fill', source: 'basins',
    paint: { 'fill-color': ['coalesce', ['get', 'color'], '#2563eb'], 'fill-opacity': ['case', ['get', 'dimmed'], 0.04, 0.12] },
  });
  addLayerIfMissing(map, {
    id: 'basins-outline', type: 'line', source: 'basins',
    paint: { 'line-color': '#60a5fa', 'line-width': 1.1, 'line-opacity': ['case', ['get', 'dimmed'], 0.01, 0.04] },
  });
  addLayerIfMissing(map, {
    id: 'rivers-glow', type: 'line', source: 'rivers',
    minzoom: 4,
    filter: ['>=', ['coalesce', ['get', 'strahler'], 0], 4],
    paint: { 'line-color': ['coalesce', ['get', 'color'], '#38bdf8'], 'line-width': ['+', ['coalesce', ['get', 'width'], 3.4], 5], 'line-opacity': ['case', ['get', 'dimmed'], 0.03, 0.2], 'line-blur': 2.5 },
  });
  addLayerIfMissing(map, {
    id: 'rivers-core', type: 'line', source: 'rivers',
    minzoom: 4,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['coalesce', ['get', 'color'], '#38bdf8'], 'line-width': ['interpolate', ['linear'], ['zoom'], 5, ['*', ['coalesce', ['get', 'width'], 3.4], 0.7], 9, ['coalesce', ['get', 'width'], 3.4], 13, ['*', ['coalesce', ['get', 'width'], 3.4], 1.45]], 'line-opacity': ['case', ['get', 'dimmed'], 0.14, 0.98] },
  });
  addLayerIfMissing(map, {
    id: 'rivers-detail', type: 'line', source: 'rivers', minzoom: 8,
    filter: ['<', ['coalesce', ['get', 'strahler'], 0], 4],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['coalesce', ['get', 'color'], '#38bdf8'], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.55, 13, 1.5], 'line-opacity': ['case', ['get', 'dimmed'], 0.1, 0.72] },
  });
  addLayerIfMissing(map, {
    id: 'rivers-flow', type: 'line', source: 'rivers', minzoom: 4,
    filter: ['>=', ['coalesce', ['get', 'strahler'], 0], 4],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['coalesce', ['get', 'color'], options.riverGlowColor], 'line-width': ['+', ['coalesce', ['get', 'width'], 3.4], 1.1], 'line-opacity': ['case', ['get', 'dimmed'], 0.1, 0.78], 'line-dasharray': [0.15, 2.8] },
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
    id: 'hes-related', type: 'circle', source: 'hesStations',
    minzoom: 5,
    filter: ['==', ['get', 'relatedToSelected'], true],
    paint: { 'circle-radius': 8, 'circle-color': '#22d3ee', 'circle-opacity': 0.92, 'circle-stroke-width': 2, 'circle-stroke-color': '#f8fafc', 'circle-stroke-opacity': 0.95 },
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
    paint: { 'circle-radius': ['+', ['coalesce', ['get', 'radius'], 8], 7], 'circle-color': ['coalesce', ['get', 'color'], '#94a3b8'], 'circle-opacity': ['case', ['get', 'dimmed'], 0.04, 0.2], 'circle-blur': 0.4 },
  });
  addLayerIfMissing(map, {
    id: 'dams-points', type: 'circle', source: 'dams',
    minzoom: 7,
    paint: { 'circle-radius': 4, 'circle-color': ['coalesce', ['get', 'color'], '#94a3b8'], 'circle-opacity': ['case', ['get', 'dimmed'], 0.03, 0.08], 'circle-stroke-width': 1, 'circle-stroke-color': options.outlineColor },
  });
  addLayerIfMissing(map, {
    id: 'dams-related', type: 'circle', source: 'dams', minzoom: 6,
    filter: ['==', ['get', 'relatedToSelected'], true],
    paint: { 'circle-radius': ['+', ['coalesce', ['get', 'radius'], 8], 6], 'circle-color': 'transparent', 'circle-opacity': 1, 'circle-stroke-width': 2, 'circle-stroke-color': '#22d3ee', 'circle-stroke-opacity': 0.95 },
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
    paint: { 'circle-radius': ['+', ['coalesce', ['get', 'radius'], 8], 5], 'circle-color': 'transparent', 'circle-stroke-width': 3, 'circle-stroke-color': options.selectionColor, 'circle-stroke-opacity': 1 },
  });
  if (pieImagesReady) DAM_PIE_BUCKETS.forEach((bucket) => addLayerIfMissing(map, {
    id: `dams-pie-${bucket}`, type: 'symbol', source: 'dams', minzoom: 7,
    filter: ['==', ['get', 'damIcon'], `dam-pie-${bucket}`],
    layout: { 'icon-image': `dam-pie-${bucket}`, 'icon-size': ['interpolate', ['linear'], ['zoom'], 7, 0.34, 10, 0.5, 14, 0.7], 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    paint: { 'icon-opacity': ['case', ['get', 'dimmed'], 0.18, 1] },
  }));
  addLayerIfMissing(map, {
    id: 'dams-producer', type: 'symbol', source: 'dams', minzoom: 7,
    filter: ['==', ['get', 'isProducer'], true],
    layout: { 'text-field': '⚡', 'text-size': 11, 'text-offset': [1.2, -1.1], 'text-allow-overlap': true },
    paint: { 'text-color': '#fbbf24', 'text-halo-color': '#0f172a', 'text-halo-width': 1 },
  });
  ['hes-catchment-fill', 'hes-catchment-outline'].forEach((id) => { if (map.getLayer(id)) map.moveLayer(id); });
  ['hes177-halo', 'hes177-points', HES_PIE_LAYER_ID, 'hes177-related', 'hes177-producer', 'hes177-selected', 'hes-cascades'].forEach((id) => { if (map.getLayer(id)) map.moveLayer(id); });

  setVisibility(map, 'basins-fill', options.basins);
  setVisibility(map, 'basins-outline', options.basins);
  setVisibility(map, 'rivers-glow', options.rivers);
  setVisibility(map, 'rivers-core', options.rivers);
  setVisibility(map, 'rivers-detail', options.rivers);
  setVisibility(map, 'rivers-flow', options.rivers);
  setVisibility(map, 'rivers-selected', options.rivers);
  setVisibility(map, 'flow-stations', options.flowStations);
  setVisibility(map, 'hes-stations', options.hesStations);
  setVisibility(map, 'hes-related', options.rivers || options.selectedEntity?.type === 'river');
  setVisibility(map, 'lakes-halo', options.lakes);
  setVisibility(map, 'lakes-points', options.lakes);
  setVisibility(map, 'dams-halo', options.dams);
  setVisibility(map, 'dams-points', options.dams);
  setVisibility(map, 'dams-related', options.dams);
  setVisibility(map, 'basins-selected', options.basins);
  setVisibility(map, 'lakes-selected', options.lakes);
  setVisibility(map, 'dams-selected', options.dams);
  DAM_PIE_LAYER_IDS.forEach((id) => setVisibility(map, id, options.dams));
  setVisibility(map, 'dams-producer', options.dams);
  setVisibility(map, 'hes177-halo', options.hes177);
  setVisibility(map, 'hes177-points', options.hes177);
  setVisibility(map, 'hes177-related', options.hes177 && options.selectedEntity?.type === 'river');
  setVisibility(map, HES_PIE_LAYER_ID, options.hes177);
  setVisibility(map, 'hes177-producer', options.hes177);
  setVisibility(map, 'hes177-selected', options.hes177);
  setVisibility(map, 'hes-cascades', options.hes177);
  setVisibility(map, 'hes-catchment-fill', options.hes177);
  setVisibility(map, 'hes-catchment-outline', options.hes177);
  const noSelection: FilterSpecification = ['==', ['get', 'id'], '__no_selection__'];
  const selectedFilter: FilterSpecification = options.selectedEntity ? ['==', ['get', 'id'], options.selectedEntity.id] : noSelection;
  const selectedRiverFilter: FilterSpecification = options.selectedRiverMemberIds.length ? ['in', ['get', 'id'], ['literal', options.selectedRiverMemberIds]] : selectedFilter;
  if (map.getLayer('rivers-selected')) map.setFilter('rivers-selected', options.selectedEntity?.type === 'river' || (options.selectedEntity?.type === 'hes' && options.selectedRiverMemberIds.length > 0) ? selectedRiverFilter : noSelection);
  const selectedBasinFilter: FilterSpecification = options.selectedBasinId ? ['==', ['to-string', ['get', 'basinId']], String(options.selectedBasinId)] : noSelection;
  if (map.getLayer('basins-selected')) map.setFilter('basins-selected', selectedBasinFilter);
  if (map.getLayer('lakes-selected')) map.setFilter('lakes-selected', options.selectedEntity?.type === 'lake' ? selectedFilter : noSelection);
  if (map.getLayer('dams-selected')) map.setFilter('dams-selected', options.selectedEntity?.type === 'dam' ? selectedFilter : noSelection);
  if (map.getLayer('hes177-selected')) map.setFilter('hes177-selected', options.selectedEntity?.type === 'hes' ? selectedFilter : noSelection);
  for (const id of ['flow-stations', 'lakes-points', 'dams-points']) {
    if (map.getLayer(id)) map.setPaintProperty(id, 'circle-stroke-color', options.outlineColor);
  }
  if (map.getLayer('basins-outline')) map.setPaintProperty('basins-outline', 'line-color', options.basinOutlineColor);
  if (map.getLayer('basins-outline')) map.setPaintProperty('basins-outline', 'line-opacity', 0.04);
  if (map.getLayer('rivers-glow')) map.setPaintProperty('rivers-glow', 'line-opacity', 0.24);
  if (map.getLayer('rivers-selected')) map.setPaintProperty('rivers-selected', 'line-color', options.selectionColor);
  if (map.getLayer('basins-selected')) map.setPaintProperty('basins-selected', 'line-color', options.selectionColor);
  if (map.getLayer('dams-related')) map.setPaintProperty('dams-related', 'circle-stroke-color', options.riverGlowColor);
  if (map.getLayer('dams-selected')) map.setPaintProperty('dams-selected', 'circle-stroke-color', options.selectionColor);
  if (map.getLayer('hes-cascades')) map.setPaintProperty('hes-cascades', 'line-opacity', options.selectedEntity?.type === 'river' || options.selectedEntity?.type === 'hes' ? 0.8 : 0.25);
  const baseOverlayIds = OVERLAY_LAYER_IDS.filter((id) => id !== HES_PIE_LAYER_ID && !id.startsWith('dams-pie-'));
  return pieImagesReady && SOURCE_IDS.every((id) => Boolean(map.getSource(id))) && baseOverlayIds.every((id) => Boolean(map.getLayer(id)));
}

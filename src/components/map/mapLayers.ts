import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';
import type { ExpressionSpecification, FilterSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

export type OverlayCollection = FeatureCollection<Geometry, GeoJsonProperties>;

export type OverlayCollections = {
  rivers: OverlayCollection;
  basins: OverlayCollection;
  dams: OverlayCollection;
  hes177: OverlayCollection;
  cascades: OverlayCollection;
  catchment: OverlayCollection;
  reservoirs: OverlayCollection;
};

export type OverlayOptions = {
  rivers: boolean;
  dams: boolean;
  basins: boolean;
  hes177: boolean;
  reservoirs: boolean;
  outlineColor: string;
  selectionColor: string;
  basinOutlineColor: string;
  riverGlowColor: string;
  selectedEntity: { type: string; id: string } | null;
  selectedBasinId: string | null;
  selectedRiverMemberIds: string[];
};

const SOURCE_IDS = ['basins', 'rivers', 'dams', 'hes177', 'cascades', 'catchment', 'reservoirs'] as const;
export const HES_PIE_LAYER_ID = 'hes177-pie';
const PIE_BUCKETS = ['neutral', ...Array.from({ length: 21 }, (_, index) => String(index * 5))];
const OVERLAY_LAYER_IDS = [
  'basins-fill', 'basins-outline', 'basins-selected',
  'reservoirs-fill', 'reservoirs-outline', 'reservoirs-selected',
  'rivers-glow', 'rivers-core', 'rivers-flow', 'rivers-selected',
  'dams-halo', 'dams-points', 'dams-related', 'dams-selected',
  'hes177-halo', 'hes177-points', 'hes177-related', HES_PIE_LAYER_ID, 'hes177-producer', 'hes177-selected',
  'hes-cascades', 'hes-catchment-fill', 'hes-catchment-outline',
] as const;

const pendingImages = new WeakMap<MapLibreMap, Set<string>>();

function pieSvg(percent: number | null): string {
  const empty = '<circle cx="32" cy="32" r="29" fill="#bdebf5" fill-opacity="0.95"/>';
  const frame = '<circle cx="32" cy="32" r="30" fill="none" stroke="#f8fafc" stroke-width="2"/>';
  const center = '<circle cx="32" cy="32" r="2.8" fill="#0b2140" stroke="#ffffff" stroke-width="1.2"/>';
  if (percent === null || percent <= 0) return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${empty}${center}${frame}</svg>`;
  if (percent >= 100) return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="#1d4ed8"/>${center}${frame}</svg>`;
  const end = (Math.PI * 2 * percent) / 100 - Math.PI / 2;
  const x = 32 + 29 * Math.cos(end);
  const y = 32 + 29 * Math.sin(end);
  const arc = percent > 50 ? 1 : 0;
  const wedge = `<path d="M32 32 L32 3 A29 29 0 ${arc} 1 ${x} ${y} Z" fill="#1d4ed8"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${empty}${wedge}${center}${frame}</svg>`;
}

function ensurePieImages(map: MapLibreMap, onReady: () => void): boolean {
  const pending = pendingImages.get(map) ?? new Set<string>();
  pendingImages.set(map, pending);
  let ready = true;
  PIE_BUCKETS.forEach((bucket) => {
    const id = `dam-pie-${bucket}`;
    if (map.hasImage(id) || pending.has(id)) return;
    ready = false;
    pending.add(id);
    const image = new Image();
    image.onload = () => {
      pending.delete(id);
      try {
        if (!map.hasImage(id)) map.addImage(id, image, { pixelRatio: 2 });
      } catch {
        // A style swap may still be in progress. The next style event invokes
        // ensurePieImages again and retries the image registration.
      }
      if (!pending.size) onReady();
    };
    image.onerror = () => { pending.delete(id); if (!pending.size) onReady(); };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pieSvg(bucket === 'neutral' ? null : Number(bucket)))}`;
  });
  return ready && !pending.size;
}

function setSource(map: MapLibreMap, id: string, data: OverlayCollection): void {
  const source = map.getSource(id) as GeoJSONSource | undefined;
  if (source) void source.setData(data).catch(() => undefined);
}

function addLayer(map: MapLibreMap, layer: Parameters<MapLibreMap['addLayer']>[0]): void {
  if (!map.getLayer(layer.id)) map.addLayer(layer);
}

function visible(map: MapLibreMap, id: string, value: boolean): void {
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', value ? 'visible' : 'none');
}

/** Reconciles the focused HES overlays after every MapLibre style update. */
export function ensureHydrologyOverlay(map: MapLibreMap, collections: OverlayCollections, options: OverlayOptions, onImagesReady?: () => void): boolean {
  // `isStyleLoaded()` also waits for every remote basemap source. A rejected
  // or slow tile provider must not prevent local GeoJSON overlays from being
  // pushed into the map style. MapLibre exposes the parsed style as soon as
  // it is available; style events retry if an add operation is still too
  // early during a style swap.
  if (!map.getStyle()) return false;
  const imagesReady = ensurePieImages(map, onImagesReady ?? (() => undefined));
  SOURCE_IDS.forEach((id) => {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: collections[id] });
    else setSource(map, id, collections[id]);
  });

  addLayer(map, { id: 'basins-fill', type: 'fill', source: 'basins', paint: { 'fill-color': ['coalesce', ['get', 'color'], '#2563eb'], 'fill-opacity': ['case', ['get', 'dimmed'], 0.025, 0.12] } });
  addLayer(map, { id: 'basins-outline', type: 'line', source: 'basins', paint: { 'line-color': options.basinOutlineColor, 'line-width': 1, 'line-opacity': ['case', ['get', 'dimmed'], 0.01, 0.05] } });
  addLayer(map, { id: 'basins-selected', type: 'line', source: 'basins', filter: ['==', ['get', 'selected'], true], paint: { 'line-color': options.selectionColor, 'line-width': 2.5, 'line-opacity': 0.95 } });

  addLayer(map, { id: 'reservoirs-fill', type: 'fill', source: 'reservoirs', paint: { 'fill-color': '#38bdf8', 'fill-opacity': ['case', ['get', 'dimmed'], 0.02, 0.16] } });
  addLayer(map, { id: 'reservoirs-outline', type: 'line', source: 'reservoirs', layout: { 'line-join': 'round' }, paint: { 'line-color': '#67e8f9', 'line-width': 1, 'line-opacity': ['case', ['get', 'dimmed'], 0.05, 0.55] } });
  addLayer(map, { id: 'reservoirs-selected', type: 'line', source: 'reservoirs', filter: ['==', ['get', 'selected'], true], paint: { 'line-color': options.selectionColor, 'line-width': 2.2, 'line-opacity': 0.9 } });

  addLayer(map, { id: 'rivers-glow', type: 'line', source: 'rivers', minzoom: 4, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['coalesce', ['get', 'color'], options.riverGlowColor], 'line-width': ['+', ['coalesce', ['get', 'width'], 3], 4], 'line-opacity': ['case', ['get', 'dimmed'], 0.03, 0.18], 'line-blur': 2 } });
  addLayer(map, { id: 'rivers-core', type: 'line', source: 'rivers', minzoom: 4, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['coalesce', ['get', 'color'], '#38bdf8'], 'line-width': ['interpolate', ['linear'], ['zoom'], 5, ['*', ['coalesce', ['get', 'width'], 3], 0.75], 10, ['coalesce', ['get', 'width'], 3]], 'line-opacity': ['case', ['get', 'dimmed'], 0.12, 0.95] } });
  addLayer(map, { id: 'rivers-flow', type: 'line', source: 'rivers', minzoom: 5, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['coalesce', ['get', 'color'], options.riverGlowColor], 'line-width': ['+', ['coalesce', ['get', 'width'], 3], 1], 'line-opacity': ['case', ['get', 'dimmed'], 0.04, 0.68], 'line-dasharray': [0.2, 2.6] } });
  addLayer(map, { id: 'rivers-selected', type: 'line', source: 'rivers', minzoom: 4, filter: ['==', ['get', 'selectedRiver'], true], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': options.selectionColor, 'line-width': ['+', ['coalesce', ['get', 'width'], 3], 3], 'line-opacity': 1 } });

  addLayer(map, { id: 'dams-halo', type: 'circle', source: 'dams', minzoom: 6, paint: { 'circle-radius': ['+', ['coalesce', ['get', 'radius'], 6], 5], 'circle-color': '#38bdf8', 'circle-opacity': ['case', ['get', 'dimmed'], 0.02, 0.12], 'circle-blur': 0.45 } });
  addLayer(map, { id: 'dams-points', type: 'circle', source: 'dams', minzoom: 6, paint: { 'circle-radius': ['coalesce', ['get', 'radius'], 6], 'circle-color': ['coalesce', ['get', 'color'], '#64748b'], 'circle-opacity': ['case', ['get', 'dimmed'], 0.08, 0.65], 'circle-stroke-width': 1.4, 'circle-stroke-color': options.outlineColor } });
  addLayer(map, { id: 'dams-related', type: 'circle', source: 'dams', minzoom: 6, filter: ['==', ['get', 'relatedToSelected'], true], paint: { 'circle-radius': ['+', ['coalesce', ['get', 'radius'], 6], 4], 'circle-color': 'transparent', 'circle-stroke-width': 2, 'circle-stroke-color': '#22d3ee' } });
  addLayer(map, { id: 'dams-selected', type: 'circle', source: 'dams', minzoom: 6, filter: ['==', ['get', 'selected'], true], paint: { 'circle-radius': ['+', ['coalesce', ['get', 'radius'], 6], 5], 'circle-color': 'transparent', 'circle-stroke-width': 3, 'circle-stroke-color': options.selectionColor } });

  const sourceColorExpression: ExpressionSpecification = ['case', ['==', ['get', 'fullnessStatus'], 'unavailable'], '#94a3b8', ['==', ['get', 'fullnessStatus'], 'not_applicable'], '#64748b', ['match', ['get', 'fullnessSourceClass'], 'official_live', '#facc15', 'official', '#facc15', 'official_published', '#fb923c', 'satellite_altimetry', '#f87171', 'satellite_area', '#f87171', 'calculated_storage', '#22d3ee', 'not_applicable', '#64748b', '#94a3b8']] as ExpressionSpecification;
  addLayer(map, { id: 'hes177-halo', type: 'circle', source: 'hes177', minzoom: 4, paint: { 'circle-radius': ['+', ['coalesce', ['get', 'visualRadius'], 7], 3], 'circle-color': sourceColorExpression, 'circle-opacity': ['case', ['get', 'dimmed'], 0.02, 0.28], 'circle-blur': 0.7 } });
  addLayer(map, { id: 'hes177-points', type: 'circle', source: 'hes177', minzoom: 4, paint: { 'circle-radius': ['coalesce', ['get', 'visualRadius'], 7], 'circle-color': '#0f172a', 'circle-stroke-width': 1.2, 'circle-stroke-color': sourceColorExpression, 'circle-opacity': ['case', ['get', 'dimmed'], 0.1, 0.5] } });
  addLayer(map, { id: 'hes177-related', type: 'circle', source: 'hes177', minzoom: 4, filter: ['==', ['get', 'relatedToSelected'], true], paint: { 'circle-radius': ['+', ['coalesce', ['get', 'visualRadius'], 7], 3], 'circle-color': 'transparent', 'circle-stroke-width': 1.8, 'circle-stroke-color': '#67e8f9' } });
  addLayer(map, { id: HES_PIE_LAYER_ID, type: 'symbol', source: 'hes177', minzoom: 4, layout: { 'icon-image': ['get', 'damIcon'], 'icon-size': ['/', ['coalesce', ['get', 'markerDiameterPx'], 14], 32], 'icon-allow-overlap': true, 'icon-ignore-placement': true }, paint: { 'icon-opacity': ['case', ['get', 'dimmed'], 0.18, 1] } });
  addLayer(map, { id: 'hes177-producer', type: 'symbol', source: 'hes177', minzoom: 4, layout: { 'text-field': '⚡', 'text-size': ['interpolate', ['linear'], ['get', 'visualRadius'], 6, 7, 18, 12], 'text-offset': ['interpolate', ['linear'], ['get', 'visualRadius'], 6, ['literal', [0.75, -0.75]], 18, ['literal', [1.05, -1.05]]], 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': sourceColorExpression, 'text-halo-color': '#0f172a', 'text-halo-width': 1, 'text-opacity': ['case', ['get', 'dimmed'], 0.18, 1] } });
  addLayer(map, { id: 'hes177-selected', type: 'circle', source: 'hes177', minzoom: 4, filter: ['==', ['get', 'selected'], true], paint: { 'circle-radius': ['+', ['coalesce', ['get', 'visualRadius'], 7], 5], 'circle-color': 'transparent', 'circle-stroke-width': 3, 'circle-stroke-color': options.selectionColor } });
  addLayer(map, { id: 'hes-cascades', type: 'line', source: 'cascades', minzoom: 5, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#f59e0b', 'line-width': 1.25, 'line-opacity': 0.22, 'line-dasharray': [1.2, 2.2] } });
  addLayer(map, { id: 'hes-catchment-fill', type: 'fill', source: 'catchment', paint: { 'fill-color': '#22d3ee', 'fill-opacity': 0.12 } });
  addLayer(map, { id: 'hes-catchment-outline', type: 'line', source: 'catchment', paint: { 'line-color': '#22d3ee', 'line-width': 2, 'line-opacity': 0.82, 'line-dasharray': [2, 1.2] } });

  ['reservoirs-fill', 'reservoirs-outline', 'reservoirs-selected', 'hes-catchment-fill', 'hes-catchment-outline', 'hes177-halo', 'hes177-points', HES_PIE_LAYER_ID, 'hes177-related', 'hes177-producer', 'hes177-selected', 'hes-cascades'].forEach((id) => { if (map.getLayer(id)) map.moveLayer(id); });
  ['basins-fill', 'basins-outline', 'basins-selected'].forEach((id) => visible(map, id, options.basins));
  ['reservoirs-fill', 'reservoirs-outline', 'reservoirs-selected'].forEach((id) => visible(map, id, options.reservoirs));
  ['rivers-glow', 'rivers-core', 'rivers-flow', 'rivers-selected'].forEach((id) => visible(map, id, options.rivers));
  ['dams-halo', 'dams-points', 'dams-related', 'dams-selected'].forEach((id) => visible(map, id, options.dams));
  ['hes177-halo', 'hes177-points', 'hes177-related', HES_PIE_LAYER_ID, 'hes177-producer', 'hes177-selected', 'hes-cascades', 'hes-catchment-fill', 'hes-catchment-outline'].forEach((id) => visible(map, id, options.hes177));

  const noSelection: FilterSpecification = ['==', ['get', 'id'], '__no_selection__'];
  const selectedFilter: FilterSpecification = options.selectedEntity ? ['==', ['get', 'id'], options.selectedEntity.id] : noSelection;
  const selectedRiverFilter: FilterSpecification = options.selectedRiverMemberIds.length ? ['in', ['get', 'id'], ['literal', options.selectedRiverMemberIds]] : selectedFilter;
  if (map.getLayer('rivers-selected')) map.setFilter('rivers-selected', options.selectedEntity?.type === 'river' || (options.selectedEntity?.type === 'hes' && options.selectedRiverMemberIds.length > 0) ? selectedRiverFilter : noSelection);
  const selectedBasinFilter: FilterSpecification = options.selectedBasinId ? ['==', ['to-string', ['get', 'basinId']], String(options.selectedBasinId)] : noSelection;
  if (map.getLayer('basins-selected')) map.setFilter('basins-selected', selectedBasinFilter);
  if (map.getLayer('reservoirs-selected')) map.setFilter('reservoirs-selected', ['==', ['get', 'selected'], true]);
  if (map.getLayer('dams-selected')) map.setFilter('dams-selected', options.selectedEntity?.type === 'dam' ? selectedFilter : noSelection);
  if (map.getLayer('hes177-selected')) map.setFilter('hes177-selected', options.selectedEntity?.type === 'hes' ? selectedFilter : noSelection);
  if (map.getLayer('basins-outline')) map.setPaintProperty('basins-outline', 'line-color', options.basinOutlineColor);
  if (map.getLayer('rivers-selected')) map.setPaintProperty('rivers-selected', 'line-color', options.selectionColor);
  if (map.getLayer('basins-selected')) map.setPaintProperty('basins-selected', 'line-color', options.selectionColor);
  if (map.getLayer('hes-cascades')) map.setPaintProperty('hes-cascades', 'line-opacity', options.selectedEntity?.type === 'hes' ? 0.7 : 0.16);
  return imagesReady && SOURCE_IDS.every((id) => Boolean(map.getSource(id))) && OVERLAY_LAYER_IDS.every((id) => Boolean(map.getLayer(id)));
}

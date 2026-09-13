import type { FeatureCollection, LineString, Point } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

export type OverlayCollections = {
  rivers: FeatureCollection<LineString>;
  dams: FeatureCollection<Point>;
  lakes: FeatureCollection<Point>;
};

export type OverlayOptions = {
  rivers: boolean;
  dams: boolean;
  lakes: boolean;
  outlineColor: string;
};

const SOURCE_IDS = ['rivers', 'lakes', 'dams'] as const;
const OVERLAY_LAYER_IDS = [
  'rivers-glow', 'rivers-core', 'lakes-halo', 'lakes-points', 'dams-halo', 'dams-points',
] as const;

function setGeoJsonSource(map: MapLibreMap, id: string, data: FeatureCollection): void {
  const source = map.getSource(id) as GeoJSONSource | undefined;
  if (source) {
    // Updating a GeoJSON source is asynchronous. Consume transient worker
    // rejections during a style swap so they never become unhandled promises.
    void source.setData(data).catch(() => undefined);
  }
}

function addLayerIfMissing(map: MapLibreMap, layer: Parameters<MapLibreMap['addLayer']>[0]): void {
  if (!map.getLayer(layer.id)) map.addLayer(layer);
}

function setVisibility(map: MapLibreMap, id: string, visible: boolean): void {
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
}

/**
 * Reconciles the native MapLibre overlay with the current data and UI state.
 * It intentionally appends layers after the basemap so the overlay can never
 * be hidden underneath a background layer.
 */
export function ensureHydrologyOverlay(
  map: MapLibreMap,
  collections: OverlayCollections,
  options: OverlayOptions,
): boolean {
  if (!map.isStyleLoaded()) return false;

  if (!map.getSource('rivers')) map.addSource('rivers', { type: 'geojson', data: collections.rivers });
  else setGeoJsonSource(map, 'rivers', collections.rivers);

  addLayerIfMissing(map, {
    id: 'rivers-glow',
    type: 'line',
    source: 'rivers',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['+', ['get', 'width'], 7],
      'line-opacity': 0.25,
      'line-blur': 3,
    },
  });
  addLayerIfMissing(map, {
    id: 'rivers-core',
    type: 'line',
    source: 'rivers',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['get', 'width'],
      'line-opacity': 0.95,
    },
  });

  if (!map.getSource('lakes')) map.addSource('lakes', { type: 'geojson', data: collections.lakes });
  else setGeoJsonSource(map, 'lakes', collections.lakes);

  addLayerIfMissing(map, {
    id: 'lakes-halo', type: 'circle', source: 'lakes',
    paint: { 'circle-radius': 18, 'circle-color': ['get', 'color'], 'circle-opacity': 0.16, 'circle-blur': 0.4 },
  });
  addLayerIfMissing(map, {
    id: 'lakes-points', type: 'circle', source: 'lakes',
    paint: {
      'circle-radius': ['get', 'radius'],
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.82,
      'circle-stroke-width': 2,
      'circle-stroke-color': options.outlineColor,
    },
  });

  if (!map.getSource('dams')) map.addSource('dams', { type: 'geojson', data: collections.dams });
  else setGeoJsonSource(map, 'dams', collections.dams);

  addLayerIfMissing(map, {
    id: 'dams-halo', type: 'circle', source: 'dams',
    paint: {
      'circle-radius': ['+', ['get', 'radius'], 7],
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.2,
      'circle-blur': 0.4,
    },
  });
  addLayerIfMissing(map, {
    id: 'dams-points', type: 'circle', source: 'dams',
    paint: {
      'circle-radius': ['get', 'radius'],
      'circle-color': ['get', 'color'],
      'circle-stroke-width': 2,
      'circle-stroke-color': options.outlineColor,
    },
  });

  setVisibility(map, 'rivers-glow', options.rivers);
  setVisibility(map, 'rivers-core', options.rivers);
  setVisibility(map, 'lakes-halo', options.lakes);
  setVisibility(map, 'lakes-points', options.lakes);
  setVisibility(map, 'dams-halo', options.dams);
  setVisibility(map, 'dams-points', options.dams);
  if (map.getLayer('lakes-points')) map.setPaintProperty('lakes-points', 'circle-stroke-color', options.outlineColor);
  if (map.getLayer('dams-points')) map.setPaintProperty('dams-points', 'circle-stroke-color', options.outlineColor);

  return SOURCE_IDS.every((id) => Boolean(map.getSource(id))) && OVERLAY_LAYER_IDS.every((id) => Boolean(map.getLayer(id)));
}

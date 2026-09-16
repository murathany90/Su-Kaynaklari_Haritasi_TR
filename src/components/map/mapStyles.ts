import type { StyleSpecification } from 'maplibre-gl';
import type { BasemapType } from '../../store/useAppStore';

export const THEME_BACKGROUND = {
  dark: '#07111f',
  light: '#e7f0f7',
} as const;

const openFreeMapSource = {
  type: 'vector' as const,
  url: 'https://tiles.openfreemap.org/planet',
};

const style = (backgroundColor: string, palette: {
  water: string;
  waterway: string;
  landcover: string;
  roads: string;
  boundary: string;
}): StyleSpecification => ({
  version: 8,
  name: 'HydroScope OpenFreeMap basemap',
  sources: {
    openmaptiles: openFreeMapSource,
  },
  layers: [{
    id: 'basemap-background',
    type: 'background',
    paint: { 'background-color': backgroundColor },
  }, {
    id: 'basemap-landcover',
    type: 'fill',
    source: 'openmaptiles',
    'source-layer': 'landcover',
    filter: ['match', ['get', 'class'], ['wood', 'grass'], true, false],
    paint: { 'fill-color': palette.landcover, 'fill-opacity': 0.35 },
  }, {
    id: 'basemap-water',
    type: 'fill',
    source: 'openmaptiles',
    'source-layer': 'water',
    paint: { 'fill-color': palette.water, 'fill-opacity': 0.9 },
  }, {
    id: 'basemap-waterway',
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'waterway',
    minzoom: 3,
    paint: {
      'line-color': palette.waterway,
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 10, 2.5],
    },
  }, {
    id: 'basemap-roads',
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'transportation',
    minzoom: 5,
    filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'], true, false],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': palette.roads,
      'line-opacity': 0.7,
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 9, 2.2],
    },
  }, {
    id: 'basemap-boundaries',
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'boundary',
    minzoom: 3,
    filter: ['==', ['get', 'admin_level'], 2],
    paint: {
      'line-color': palette.boundary,
      'line-opacity': 0.62,
      'line-dasharray': [2, 2],
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 8, 1.2],
    },
  }],
});

const darkStyle: StyleSpecification = {
  ...style(THEME_BACKGROUND.dark, {
    water: '#123a5a',
    waterway: '#2c6e9d',
    landcover: '#163328',
    roads: '#38516a',
    boundary: '#5f7890',
  }),
};

const neutralStyle: StyleSpecification = {
  ...style('#d9e0e5', {
    water: '#b9cbd4',
    waterway: '#8ca9b6',
    landcover: '#d4d9d6',
    roads: '#aab2b8',
    boundary: '#8c969e',
  }),
};

const satelliteStyle: StyleSpecification = {
  version: 8,
  name: 'HydroScope satellite basemap',
  sources: {
    'basemap-raster': {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Tiles © Esri',
    },
  },
  layers: [{
    id: 'basemap-background',
    type: 'background',
    paint: { 'background-color': '#102331' },
  }, {
    id: 'basemap-raster',
    type: 'raster',
    source: 'basemap-raster',
    paint: { 'raster-opacity': 0.86 },
  }],
};

export const BASEMAP_RASTER_SOURCE = {
  type: 'raster' as const,
  tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  tileSize: 256,
  attribution: 'Tiles Â© Esri',
};

/** A source-free first style lets local GeoJSON layers attach before tiles load. */
export const getBasemapBootstrapStyle = (theme: 'dark' | 'light' = 'dark'): StyleSpecification => ({
  version: 8,
  name: 'HydroScope overlay bootstrap style',
  sources: {},
  layers: [{
    id: 'basemap-background',
    type: 'background',
    paint: { 'background-color': THEME_BACKGROUND[theme] },
  }],
});

/**
 * A raster fallback keeps the map usable when the vector basemap or its tile
 * source is unavailable. The hydrology overlay is added on top of this style
 * and therefore does not depend on OpenFreeMap completing its requests.
 */
export const getBasemapFallbackStyle = (theme: 'dark' | 'light' = 'dark'): StyleSpecification => ({
  ...satelliteStyle,
  name: 'HydroScope raster fallback basemap',
  layers: [{
    id: 'basemap-background',
    type: 'background',
    paint: { 'background-color': THEME_BACKGROUND[theme] },
  }, {
    id: 'basemap-raster',
    type: 'raster',
    source: 'basemap-raster',
    paint: { 'raster-opacity': theme === 'light' ? 0.72 : 0.48 },
  }],
});

/**
 * Local styles keep the hydrology overlay available even when an optional
 * third-party tile provider is unavailable. A remote basemap can be plugged
 * into these styles later without changing the overlay lifecycle.
 */
export const BASEMAP_STYLES: Record<BasemapType, StyleSpecification> = {
  dark: darkStyle,
  light: style(THEME_BACKGROUND.light, {
    water: '#a8cde7',
    waterway: '#5c9bc5',
    landcover: '#d7e8ce',
    roads: '#b29476',
    boundary: '#718096',
  }),
  neutral: neutralStyle,
  satellite: satelliteStyle,
  streets: style('#dbeafe', {
    water: '#b9d9ef',
    waterway: '#6ba6cf',
    landcover: '#d6ead2',
    roads: '#a97952',
    boundary: '#75869a',
  }),
};

export const getBasemapStyle = (basemap: BasemapType): StyleSpecification => (
  BASEMAP_STYLES[basemap] ?? BASEMAP_STYLES.dark
);

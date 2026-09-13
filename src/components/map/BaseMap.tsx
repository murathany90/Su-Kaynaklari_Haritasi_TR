import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { FeatureCollection, LineString, Point } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useAppStore } from '../../store/useAppStore';
import { DAMS_DATA, LAKES_DATA, RIVERS_DATA } from '../../data/mockData';
import { getDamColor, getDamMetrics, getRiverColor } from '../../data/hydrology';
import { getBasemapStyle, THEME_BACKGROUND } from './mapStyles';
import { ensureHydrologyOverlay, type OverlayCollections, type OverlayOptions } from './mapLayers';
import { focusSelectedEntity } from './mapCamera';

const INTERACTIVE_LAYERS = ['rivers-core', 'dams-points', 'lakes-points'] as const;

export function BaseMap() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const firstBasemapRef = useRef(useAppStore.getState().basemap);
  const themeRef = useRef(useAppStore.getState().theme);
  const dataRef = useRef<OverlayCollections | null>(null);
  const optionsRef = useRef<OverlayOptions | null>(null);
  const frameRef = useRef<number | null>(null);

  const timelineMonthIndex = useAppStore((state) => state.timelineMonthIndex);
  const layers = useAppStore((state) => state.layers);
  const basemap = useAppStore((state) => state.basemap);
  const theme = useAppStore((state) => state.theme);
  const selectedEntity = useAppStore((state) => state.selectedEntity);
  const setSelectedEntity = useAppStore((state) => state.setSelectedEntity);

  const collections = useMemo<OverlayCollections>(() => ({
    rivers: {
      type: 'FeatureCollection',
      features: RIVERS_DATA.map((river) => {
        const flow = river.seasonal_profile[timelineMonthIndex];
        const color = getRiverColor(flow, river.normal_flow);
        return {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: river.coords },
          properties: {
            id: river.id,
            name: river.name,
            flow,
            color,
            width: Math.min(8, Math.max(2.5, Math.log10(flow + 1) * 2.8)),
          },
        };
      }),
    } as FeatureCollection<LineString>,
    lakes: {
      type: 'FeatureCollection',
      features: LAKES_DATA.map((lake) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: lake.coords },
        properties: {
          id: lake.id,
          name: lake.name,
          color: lake.color,
          area_loss: lake.area_loss_pct,
          radius: Math.min(14, Math.max(8, Math.sqrt(lake.current_area_km2) * 0.4)),
        },
      })),
    } as FeatureCollection<Point>,
    dams: {
      type: 'FeatureCollection',
      features: DAMS_DATA.map((dam) => {
        const metrics = getDamMetrics(dam, timelineMonthIndex);
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: dam.coords },
          properties: {
            id: dam.id,
            name: dam.name,
            occupancy: metrics.occupancy,
            color: getDamColor(metrics.occupancy),
            radius: Math.min(13, Math.max(6, Math.log10(metrics.volume + 1) * 2.5)),
          },
        };
      }),
    } as FeatureCollection<Point>,
  }), [timelineMonthIndex]);

  const overlayOptions = useMemo<OverlayOptions>(() => ({
    rivers: layers.rivers,
    dams: layers.dams,
    lakes: layers.lakes,
    outlineColor: theme === 'light' ? '#ffffff' : '#07111f',
  }), [layers.dams, layers.lakes, layers.rivers, theme]);

  const syncOverlay = useCallback(() => {
    const map = mapRef.current;
    const currentData = dataRef.current;
    const currentOptions = optionsRef.current;
    if (!map || !currentData || !currentOptions || !map.isStyleLoaded()) return;

    try {
      ensureHydrologyOverlay(map, currentData, currentOptions);
      if (map.getLayer('basemap-background')) {
        map.setPaintProperty('basemap-background', 'background-color', THEME_BACKGROUND[themeRef.current]);
      }
      map.triggerRepaint();
    } catch {
      // Style transitions can briefly invalidate a source/layer operation.
      // The next styledata/load/idle event retries without noisy console logs.
    }
  }, []);

  const scheduleOverlaySync = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      syncOverlay();
    });
  }, [syncOverlay]);

  useEffect(() => {
    dataRef.current = collections;
    optionsRef.current = overlayOptions;
    scheduleOverlaySync();
  }, [collections, overlayOptions, scheduleOverlaySync]);

  // The map instance is created once. Overlay data is rehydrated on every
  // style lifecycle event, so an optional basemap cannot block native layers.
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    // Vite serves MapLibre's worker as a separate module asset. Explicitly
    // wiring it prevents GeoJSON sources from waiting forever on a blank
    // default worker URL in dev and production builds.
    maplibregl.setWorkerUrl(maplibreWorkerUrl);
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: getBasemapStyle(firstBasemapRef.current),
      center: [35.3, 39],
      zoom: 5.5,
      attributionControl: false,
      renderWorldCopies: false,
    });
    mapRef.current = map;

    const onStyleReady = () => scheduleOverlaySync();
    const onMapError = (event: maplibregl.ErrorEvent) => {
      // Basemap tiles are optional. MapLibre logs an error by default when a
      // remote tile is unavailable, although the local background and native
      // hydrology layers can still render normally.
      if (event.error?.message) return;
    };
    map.on('load', onStyleReady);
    map.on('style.load', onStyleReady);
    map.on('styledata', onStyleReady);
    map.on('idle', onStyleReady);
    map.on('error', onMapError);
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      map.off('load', onStyleReady);
      map.off('style.load', onStyleReady);
      map.off('styledata', onStyleReady);
      map.off('idle', onStyleReady);
      map.off('error', onMapError);
      map.remove();
      mapRef.current = null;
    };
  }, [scheduleOverlaySync]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || basemap === firstBasemapRef.current) return;

    firstBasemapRef.current = basemap;
    map.setStyle(getBasemapStyle(basemap), { diff: false });
    scheduleOverlaySync();
  }, [basemap, scheduleOverlaySync]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedEntity) return;

    const focus = () => {
      if (map.isStyleLoaded()) focusSelectedEntity(map, selectedEntity);
    };

    if (map.isStyleLoaded()) focus();
    else map.once('idle', focus);

    return () => {
      map.off('idle', focus);
    };
  }, [selectedEntity]);

  // A theme toggle only changes the local background paint. Keeping the
  // current style intact avoids tearing down native sources and layers.
  useEffect(() => {
    themeRef.current = theme;
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || !map.getLayer('basemap-background')) {
      scheduleOverlaySync();
      return;
    }

    map.setPaintProperty('basemap-background', 'background-color', THEME_BACKGROUND[theme]);
    map.triggerRepaint();
  }, [theme, scheduleOverlaySync]);

  useEffect(() => {
    const map = mapRef.current;
    const container = mapContainerRef.current;
    if (!map || !container) return;

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container);
    map.resize();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onClick = (event: maplibregl.MapMouseEvent) => {
      const availableLayers = INTERACTIVE_LAYERS.filter((layer) => Boolean(map.getLayer(layer)));
      if (!availableLayers.length) return;
      const feature = map.queryRenderedFeatures(event.point, { layers: [...availableLayers] })[0];
      const id = feature?.properties?.id;
      if (!feature || !id) return;

      if (feature.layer.id === 'rivers-core') setSelectedEntity({ type: 'river', id: String(id) });
      if (feature.layer.id === 'dams-points') setSelectedEntity({ type: 'dam', id: String(id) });
      if (feature.layer.id === 'lakes-points') setSelectedEntity({ type: 'lake', id: String(id) });
    };

    const onEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
    const onLeave = () => { map.getCanvas().style.cursor = ''; };
    map.on('click', onClick);
    INTERACTIVE_LAYERS.forEach((layer) => {
      map.on('mouseenter', layer, onEnter);
      map.on('mouseleave', layer, onLeave);
    });

    return () => {
      map.off('click', onClick);
      INTERACTIVE_LAYERS.forEach((layer) => {
        map.off('mouseenter', layer, onEnter);
        map.off('mouseleave', layer, onLeave);
      });
    };
  }, [setSelectedEntity]);

  return <div ref={mapContainerRef} className="absolute inset-0" aria-label="Türkiye hidroloji haritası" />;
}

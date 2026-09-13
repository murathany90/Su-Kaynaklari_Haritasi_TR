import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useAppStore } from '../../store/useAppStore';
import { getForecastTimestamps } from '../../services/hydroData';
import { getDamColor, getFlowScaleColor, getRiverColor } from '../../data/hydrology';
import { getBasemapStyle, THEME_BACKGROUND } from './mapStyles';
import { ensureHydrologyOverlay, type OverlayCollections, type OverlayOptions } from './mapLayers';
import { focusSelectedEntity } from './mapCamera';

const INTERACTIVE_LAYERS = ['rivers-core', 'dams-points', 'lakes-points', 'basins-fill'] as const;

function numberFrom(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function liveNumber(record: unknown, keys: string[]): number | null {
  if (Array.isArray(record)) {
    for (const item of record) {
      const value = liveNumber(item, keys);
      if (value !== null) return value;
    }
    return null;
  }
  if (!record || typeof record !== 'object') return null;
  const source = record as Record<string, unknown>;
  for (const key of keys) {
    const value = numberFrom(source[key]);
    if (value !== null) return value;
  }
  return null;
}

export function BaseMap() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const initialBasemapRef = useRef(useAppStore.getState().basemap);
  const themeRef = useRef(useAppStore.getState().theme);
  const dataRef = useRef<OverlayCollections | null>(null);
  const optionsRef = useRef<OverlayOptions | null>(null);
  const lastSyncedDataRef = useRef<OverlayCollections | null>(null);
  const lastSyncedOptionsRef = useRef<OverlayOptions | null>(null);
  const frameRef = useRef<number | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  const rivers = useAppStore((state) => state.rivers);
  const basins = useAppStore((state) => state.basins);
  const flowStations = useAppStore((state) => state.flowStations);
  const hesStations = useAppStore((state) => state.hesStations);
  const damStations = useAppStore((state) => state.damStations);
  const lakes = useAppStore((state) => state.lakes);
  const geoglows = useAppStore((state) => state.geoglows);
  const epias = useAppStore((state) => state.epias);
  const layers = useAppStore((state) => state.layers);
  const basemap = useAppStore((state) => state.basemap);
  const theme = useAppStore((state) => state.theme);
  const selectedEntity = useAppStore((state) => state.selectedEntity);
  const timelineIndex = useAppStore((state) => state.timelineIndex);
  const setSelectedEntity = useAppStore((state) => state.setSelectedEntity);

  const collections = useMemo<OverlayCollections>(() => {
    const geoglowsRecords = geoglows?.records ?? [];
    const timestamps = getForecastTimestamps(geoglows);
    const activeTimestamp = timestamps[timelineIndex];
    const epiasRecords = epias?.records ?? [];
    const activeForecastFlows = geoglowsRecords.flatMap((record) => {
      const rows = Array.isArray(record.data) ? record.data : [];
      const row = activeTimestamp ? rows.find((candidate) => candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).datetime === activeTimestamp) : rows[0];
      const value = liveNumber(row, ['flow', 'discharge', 'streamflow', 'flow_median', 'value']);
      return value === null ? [] : [value];
    });
    const maxForecastFlow = activeForecastFlows.length ? Math.max(...activeForecastFlows) : 0;
    const riverFeatures = rivers.features.map((feature) => {
      const id = String(feature.properties?.id ?? feature.id ?? '');
      const live = geoglowsRecords.find((record) => String(record.localRiverId ?? '') === id);
      const liveData = Array.isArray(live?.data) && activeTimestamp ? live.data.filter((row) => row && typeof row === 'object' && (row as Record<string, unknown>).datetime === activeTimestamp) : live?.data;
      const flow = liveNumber(liveData, ['flow', 'discharge', 'streamflow', 'flow_median', 'value']) ?? numberFrom(feature.properties?.flow);
      const normalFlow = numberFrom(feature.properties?.normalFlow);
      // A river without a real GEOGLOWS baseline stays neutral. Absolute
      // thresholds would falsely label unavailable forecasts as drought/flood.
      const color = flow !== null && normalFlow !== null ? getRiverColor(flow, normalFlow) : flow !== null ? getFlowScaleColor(flow, maxForecastFlow) : (feature.properties?.color as string | undefined) ?? '#38bdf8';
      const width = flow !== null ? Math.min(8, Math.max(2.8, Math.log10(Math.max(flow, 0) + 1) * 2.8)) : numberFrom(feature.properties?.width) ?? 2.8;
      return { ...feature, properties: { ...feature.properties, flow, color, width } };
    });
    const damFeatures = damStations.features.map((feature) => {
      const name = String(feature.properties?.name ?? '');
      const live = epiasRecords.find((record) => String(record.damName ?? record.name ?? '').toLocaleLowerCase('tr-TR') === name.toLocaleLowerCase('tr-TR'));
      const occupancy = liveNumber(live, ['occupancy', 'fullness', 'activeFullness', 'doluluk']) ?? numberFrom(feature.properties?.occupancy);
      return { ...feature, properties: { ...feature.properties, occupancy, color: occupancy === null ? '#94a3b8' : getDamColor(occupancy), radius: occupancy === null ? 8 : Math.min(13, Math.max(6, occupancy / 8)) } };
    });
    return { rivers: { ...rivers, features: riverFeatures }, basins, flowStations, hesStations, dams: { ...damStations, features: damFeatures }, lakes };
  }, [basins, damStations, epias, flowStations, geoglows, hesStations, lakes, rivers, timelineIndex]);

  const overlayOptions = useMemo<OverlayOptions>(() => ({
    rivers: layers.rivers,
    flowStations: layers.flowStations,
    hesStations: layers.hesStations,
    dams: layers.dams,
    lakes: layers.lakes,
    basins: layers.basins,
    outlineColor: theme === 'light' ? '#ffffff' : '#07111f',
    selectedEntity,
  }), [layers.basins, layers.dams, layers.flowStations, layers.hesStations, layers.lakes, layers.rivers, selectedEntity, theme]);

  const syncOverlay = useCallback((force = false) => {
    const map = mapRef.current;
    if (!map || !dataRef.current || !optionsRef.current || !map.isStyleLoaded()) return;
    if (!force && lastSyncedDataRef.current === dataRef.current && lastSyncedOptionsRef.current === optionsRef.current) return;
    try {
      ensureHydrologyOverlay(map, dataRef.current, optionsRef.current);
      lastSyncedDataRef.current = dataRef.current;
      lastSyncedOptionsRef.current = optionsRef.current;
      if (map.getLayer('basemap-background')) map.setPaintProperty('basemap-background', 'background-color', THEME_BACKGROUND[themeRef.current]);
      map.triggerRepaint();
    } catch {
      // A style swap can briefly invalidate the style object. styledata retries.
    }
  }, []);

  const scheduleOverlaySync = useCallback((force = false) => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => { frameRef.current = null; syncOverlay(force); });
  }, [syncOverlay]);

  useEffect(() => { dataRef.current = collections; optionsRef.current = overlayOptions; scheduleOverlaySync(); }, [collections, overlayOptions, scheduleOverlaySync]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    maplibregl.setWorkerUrl(maplibreWorkerUrl);
    const map = new maplibregl.Map({ container: mapContainerRef.current, style: getBasemapStyle(initialBasemapRef.current), center: [35.3, 39], zoom: 5.5, attributionControl: false, renderWorldCopies: false });
    mapRef.current = map;
    const onStyleReady = () => scheduleOverlaySync(true);
    const onStyleData = () => scheduleOverlaySync();
    const onMapError = (event: maplibregl.ErrorEvent) => {
      // MapLibre logs an unhandled error event when an optional remote tile
      // provider rejects a request. Mark it handled so a basemap outage does
      // not become an unhandled console error for the GIS panel.
      (event as unknown as { preventDefault?: () => void }).preventDefault?.();
    };
    map.on('load', onStyleReady);
    map.on('style.load', onStyleReady);
    map.on('styledata', onStyleData);
    map.on('error', onMapError);
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      map.off('load', onStyleReady); map.off('style.load', onStyleReady); map.off('styledata', onStyleData); map.off('error', onMapError);
      popupRef.current?.remove();
      map.remove(); mapRef.current = null;
    };
  }, [scheduleOverlaySync]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || basemap === initialBasemapRef.current) return;
    initialBasemapRef.current = basemap;
    map.setStyle(getBasemapStyle(basemap), { diff: false });
    scheduleOverlaySync();
  }, [basemap, scheduleOverlaySync]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedEntity) return;
    const focus = () => { if (map.isStyleLoaded()) focusSelectedEntity(map, selectedEntity, collections); };
    if (map.isStyleLoaded()) focus(); else map.once('style.load', focus);
    return () => { map.off('style.load', focus); };
  }, [collections, selectedEntity]);

  useEffect(() => {
    themeRef.current = theme;
    const map = mapRef.current;
    if (!map) return;
    if (!map.isStyleLoaded() || !map.getLayer('basemap-background')) { scheduleOverlaySync(); return; }
    map.setPaintProperty('basemap-background', 'background-color', THEME_BACKGROUND[theme]);
    map.triggerRepaint();
  }, [theme, scheduleOverlaySync]);

  useEffect(() => {
    const map = mapRef.current; const container = mapContainerRef.current;
    if (!map || !container) return;
    const observer = new ResizeObserver(() => map.resize()); observer.observe(container); map.resize();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onClick = (event: maplibregl.MapMouseEvent) => {
      const available = INTERACTIVE_LAYERS.filter((layer) => Boolean(map.getLayer(layer)));
      if (!available.length) return;
      const feature = map.queryRenderedFeatures(event.point, { layers: [...available] })[0];
      const id = feature?.properties?.id ?? feature?.properties?.entityId;
      if (!feature || id === undefined || id === null) return;
      if (feature.layer.id === 'rivers-core') setSelectedEntity({ type: 'river', id: String(id) });
      if (feature.layer.id === 'dams-points') setSelectedEntity({ type: 'dam', id: String(id) });
      if (feature.layer.id === 'lakes-points') setSelectedEntity({ type: 'lake', id: String(id) });
      if (feature.layer.id === 'basins-fill') setSelectedEntity({ type: 'basin', id: String(id) });
    };
    const onEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
    const onLeave = () => { map.getCanvas().style.cursor = ''; popupRef.current?.remove(); };
    const onMove = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const props = (feature.properties ?? {}) as Record<string, unknown>;
      const name = String(props.name ?? props.damName ?? props.adi ?? props.riverCode ?? props.id ?? 'Kaynak');
      const value = props.flow !== null && props.flow !== undefined ? `${Number(props.flow).toLocaleString('tr-TR')} m³/s` : props.occupancy !== null && props.occupancy !== undefined ? `%${Math.round(Number(props.occupancy))} doluluk` : 'Canlı değer yok';
      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: themeRef.current === 'light' ? 'hydro-tooltip hydro-tooltip-light' : 'hydro-tooltip' })
        .setLngLat(event.lngLat)
        .setText(`${name}\n${value}`)
        .addTo(map);
    };
    map.on('click', onClick); INTERACTIVE_LAYERS.forEach((layer) => { map.on('mouseenter', layer, onEnter); map.on('mouseleave', layer, onLeave); });
    INTERACTIVE_LAYERS.forEach((layer) => map.on('mousemove', layer, onMove));
    return () => { map.off('click', onClick); INTERACTIVE_LAYERS.forEach((layer) => { map.off('mouseenter', layer, onEnter); map.off('mouseleave', layer, onLeave); map.off('mousemove', layer, onMove); }); popupRef.current?.remove(); };
  }, [setSelectedEntity]);

  return <div ref={mapContainerRef} className="absolute inset-0" aria-label="Türkiye hidroloji haritası" />;
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useAppStore } from '../../store/useAppStore';
import { getForecastTimestamps } from '../../services/hydroData';
import { buildDamHesMapping, buildMajorRiverGroups, buildRiverNameMap, damIconBucket, displayName, getBasinColor, getDamColor, getFlowScaleColor, getRiverColor, isElectricProducer, mockFullness, relateRiverToDams } from '../../data/hydrology';
import { getBasemapStyle, THEME_BACKGROUND } from './mapStyles';
import { DAM_PIE_LAYER_IDS, ensureHydrologyOverlay, type OverlayCollections, type OverlayOptions } from './mapLayers';
import { focusSelectedEntity } from './mapCamera';
import { emptyFeatureCollection } from '../../types/hydrology';

const INTERACTIVE_LAYERS = ['rivers-core', 'dams-points', 'lakes-points', 'basins-fill', 'flow-stations', 'hes-stations', 'hes-related', 'hes177-points', 'hes177-pie', ...DAM_PIE_LAYER_IDS] as const;

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

function powerRadius(value: unknown): number {
  const power = numberFrom(value);
  if (power === null) return 1;
  if (power < 30) return 1;
  if (power <= 100) return 1.33 + ((power - 30) / 70) * 0.67;
  if (power <= 700) return 2 + ((power - 100) / 600) * 2;
  if (power <= 2400) return 4 + ((power - 700) / 1700) * 3;
  return 7;
}

function visualPowerRadius(value: unknown): number {
  const scale = powerRadius(value);
  if (scale <= 1.33) return 5;
  if (scale <= 2) return 6 + ((scale - 1.33) / 0.67) * 2;
  if (scale <= 4) return 8 + ((scale - 2) / 2) * 4.5;
  return 12.5 + ((Math.min(scale, 7) - 4) / 3) * 4.5;
}

const VECTOR_BASEMAP_PALETTES = {
  dark: { water: '#123a5a', waterway: '#2c6e9d', landcover: '#163328', roads: '#38516a', boundary: '#5f7890' },
  light: { water: '#a8cde7', waterway: '#5c9bc5', landcover: '#d7e8ce', roads: '#b29476', boundary: '#718096' },
} as const;

function applyVectorBasemapPalette(map: MapLibreMap, variant: 'dark' | 'light'): void {
  const palette = VECTOR_BASEMAP_PALETTES[variant];
  if (map.getLayer('basemap-background')) map.setPaintProperty('basemap-background', 'background-color', THEME_BACKGROUND[variant]);
  if (map.getLayer('basemap-landcover')) map.setPaintProperty('basemap-landcover', 'fill-color', palette.landcover);
  if (map.getLayer('basemap-water')) map.setPaintProperty('basemap-water', 'fill-color', palette.water);
  if (map.getLayer('basemap-waterway')) map.setPaintProperty('basemap-waterway', 'line-color', palette.waterway);
  if (map.getLayer('basemap-roads')) map.setPaintProperty('basemap-roads', 'line-color', palette.roads);
  if (map.getLayer('basemap-boundaries')) map.setPaintProperty('basemap-boundaries', 'line-color', palette.boundary);
}

function escapePopup(value: unknown): string {
  return String(value ?? '—').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

function popupValue(value: unknown, suffix = ''): string {
  if (value === null || value === undefined || value === '') return '—';
  return `${escapePopup(value)}${suffix}`;
}

function hesPopupHtml(properties: Record<string, unknown>): string {
  const producer = properties.isProducer === true ? '<span class="hydro-popup-producer">⚡</span>' : '';
  const occupancy = properties.occupancy === null || properties.occupancy === undefined ? '—' : `%${Math.round(Number(properties.occupancy))}`;
  return `<div class="hydro-click-popup"><div class="hydro-popup-head"><strong>${producer}${escapePopup(properties.name)}</strong><button type="button" data-popup-close aria-label="Kapat">×</button></div><div class="hydro-popup-sub">${popupValue(properties.basinName ?? properties.basinId)} · ${popupValue(properties.province)}</div><div class="hydro-popup-grid"><span>Kurulu güç</span><b>${popupValue(properties.installedPowerMw, ' MW')}</b><span>Akarsu</span><b>${popupValue(properties.riverName)}</b><span>Min / max seviye</span><b>${popupValue(properties.minWaterLevelM)} / ${popupValue(properties.maxWaterLevelM)} m</b><span>Min / max hacim</span><b>${popupValue(properties.minVolumeHm3)} / ${popupValue(properties.maxVolumeHm3)} hm³</b><span>Aktif hacim</span><b>${popupValue(properties.activeVolumeHm3, ' hm³')}</b><span>Ünite debisi</span><b>${popupValue(properties.unitFlowM3s, ' m³/sn')}</b><span>Kaskat</span><b>${popupValue(properties.cascadeName)}</b><span>Baraj</span><b>${popupValue(properties.damName)}</b><span>Doluluk</span><b>${occupancy}</b></div><div class="hydro-popup-actions"><button type="button" data-show-river>Akarsuyu göster</button><button type="button" data-show-basin>Havzayı göster</button><button type="button" data-show-cascade>Kaskadı göster</button><button type="button" data-show-catchment>Su alanı</button></div></div>`;
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
  const flowAnimationRef = useRef<number | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const clickPopupRef = useRef<maplibregl.Popup | null>(null);
  const [catchment, setCatchment] = useState(emptyFeatureCollection());

  const rivers = useAppStore((state) => state.rivers);
  const basins = useAppStore((state) => state.basins);
  const flowStations = useAppStore((state) => state.flowStations);
  const hesStations = useAppStore((state) => state.hesStations);
  const damStations = useAppStore((state) => state.damStations);
  const lakes = useAppStore((state) => state.lakes);
  const hes177 = useAppStore((state) => state.hes177);
  const cascades = useAppStore((state) => state.cascades);
  const hes177Relations = useAppStore((state) => state.hes177Relations);
  const geoglows = useAppStore((state) => state.geoglows);
  const epias = useAppStore((state) => state.epias);
  const layers = useAppStore((state) => state.layers);
  const basemap = useAppStore((state) => state.basemap);
  const theme = useAppStore((state) => state.theme);
  const selectedEntity = useAppStore((state) => state.selectedEntity);
  const timelineIndex = useAppStore((state) => state.timelineIndex);
  const dataMode = useAppStore((state) => state.dataMode);
  const activeCatchmentHesId = useAppStore((state) => state.activeCatchmentHesId);
  const setSelectedEntity = useAppStore((state) => state.setSelectedEntity);

  const riverNameMap = useMemo(() => buildRiverNameMap(rivers), [rivers]);
  const damHesMapping = useMemo(() => buildDamHesMapping(damStations, hesStations), [damStations, hesStations]);
  const majorRiverGroups = useMemo(() => buildMajorRiverGroups(rivers, hesStations), [hesStations, rivers]);

  const collections = useMemo<OverlayCollections>(() => {
    const geoglowsRecords = geoglows?.records ?? [];
    const timestamps = getForecastTimestamps(geoglows);
    const activeTimestamp = timestamps[timelineIndex];
    const epiasRecords = dataMode === 'epias' && epias?.status === 'ok' ? epias.records ?? [] : [];
    const activeForecastFlows = geoglowsRecords.flatMap((record) => {
      const rows = Array.isArray(record.data) ? record.data : [];
      const row = activeTimestamp ? rows.find((candidate) => candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).datetime === activeTimestamp) : rows[0];
      const value = liveNumber(row, ['flow', 'discharge', 'streamflow', 'flow_median', 'value']);
      return value === null ? [] : [value];
    });
    const maxForecastFlow = activeForecastFlows.length ? Math.max(...activeForecastFlows) : 0;
    const selectedRiver = selectedEntity?.type === 'river' ? rivers.features.find((feature) => String(feature.properties?.id ?? feature.id ?? '') === selectedEntity.id) ?? majorRiverGroups.get(selectedEntity.id)?.feature ?? null : null;
    const selectedRiverRelation = selectedRiver ? relateRiverToDams({ ...selectedRiver, properties: { ...selectedRiver.properties, riverName: riverNameMap.get(String(selectedRiver.properties?.id ?? selectedRiver.id ?? '')) ?? selectedRiver.properties?.riverName } }, damStations, hesStations, damHesMapping) : null;
    const selectedRiverHesIds = selectedEntity?.type === 'river' ? new Set(hes177.features.filter((feature) => {
      const relation = hes177Relations?.byHesId?.[String(feature.properties?.id ?? feature.id ?? '')];
      const riverHesIds = Array.isArray(selectedRiver?.properties?.hesIds) ? selectedRiver.properties.hesIds.map(String) : [];
      return riverHesIds.includes(String(feature.properties?.id ?? feature.id ?? '')) || relation?.riverIds?.map(String).includes(selectedEntity.id) || (selectedRiver?.properties?.riverName && relation?.riverName === selectedRiver.properties.riverName);
    }).map((feature) => String(feature.properties?.id ?? feature.id ?? ''))) : new Set<string>();
    const selectedRiverDamIds = new Set([...selectedRiverHesIds].flatMap((id) => hes177Relations?.byHesId?.[id]?.damIds?.map(String) ?? []));
    const basinNames = new Map(basins.features.map((feature) => [String(feature.properties?.basinId ?? feature.properties?.ID ?? feature.id ?? ''), String(feature.properties?.name ?? feature.properties?.HAVZA_ADI ?? '')]));
    const basinFeatures = basins.features.map((feature) => ({ ...feature, properties: { ...feature.properties, color: getBasinColor(feature.properties?.basinId ?? feature.properties?.ID ?? feature.id, theme) } }));
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
      return { ...feature, properties: { ...feature.properties, name: riverNameMap.get(id) ?? displayName(feature.properties ?? {}, 'river', id), riverName: riverNameMap.get(id), basinName: basinNames.get(String(feature.properties?.basinId ?? '')), flow, color, width, selectedRiver: Boolean((selectedRiver?.properties?.majorMemberIds as unknown[] | undefined)?.map(String).includes(id)) } };
    });
    const damFeatures = damStations.features.map((feature) => {
      const properties = feature.properties ?? {};
      const id = String(properties.id ?? feature.id ?? '');
      const name = displayName(properties, 'dam', id);
      const live = epiasRecords.find((record) => String(record.damName ?? record.name ?? '').toLocaleLowerCase('tr-TR') === name.toLocaleLowerCase('tr-TR'));
      const occupancy = dataMode === 'mock' ? Math.min(90, Math.max(25, mockFullness(id) + ((timelineIndex % 7) - 3))) : liveNumber(live, ['occupancy', 'fullness', 'activeFullness', 'doluluk']);
      const hesIds = Array.isArray(properties.hesIds) ? properties.hesIds.map(String) : damHesMapping.get(id)?.hesIds ?? [];
      const selectedHesRelation = selectedEntity?.type === 'hes' ? hes177Relations?.byHesId?.[selectedEntity.id] : undefined;
      const relatedToSelectedHes = Boolean(selectedHesRelation?.damIds?.map(String).includes(id));
      return { ...feature, properties: { ...properties, name, basinName: properties.basinName ?? properties.HavzaAdi, occupancy, damIcon: damIconBucket(occupancy), isProducer: isElectricProducer(properties, hesIds.length > 0), hesMatchIds: hesIds, relatedToSelected: (selectedRiverRelation?.ids.has(id) ?? false) || selectedRiverDamIds.has(id) || hesIds.some((hesId) => selectedRiverHesIds.has(hesId)) || relatedToSelectedHes, relatedConfidence: selectedRiverRelation?.confidence, color: occupancy === null ? '#94a3b8' : getDamColor(occupancy), radius: occupancy === null ? 8 : Math.min(13, Math.max(6, occupancy / 8)) } };
    });
    const enrichedHesStations = { ...hesStations, features: hesStations.features.map((feature) => ({ ...feature, properties: { ...feature.properties, relatedToSelected: selectedRiverRelation?.stationIds.has(String(feature.properties?.id ?? feature.id ?? '')) ?? false } })) };
    const enrichedHes177 = { ...hes177, features: hes177.features.map((feature) => {
      const id = String(feature.properties?.id ?? feature.id ?? '');
      const relation = hes177Relations?.byHesId?.[id];
      const live = relation?.riverIds?.length ? geoglowsRecords.find((record) => relation.riverIds?.map(String).includes(String(record.localRiverId ?? ''))) : undefined;
      const flow = liveNumber(live, ['flow', 'discharge', 'streamflow', 'flow_median', 'value']);
      const occupancy = dataMode === 'mock' ? Math.min(90, Math.max(25, mockFullness(id) + ((timelineIndex % 7) - 3))) : null;
      const selectedRiverName = selectedRiver?.properties?.riverName ?? selectedRiver?.properties?.name;
      const riverSelected = selectedEntity?.type === 'river' && Boolean((relation?.riverIds ?? []).map(String).includes(selectedEntity.id) || (selectedRiverName && relation?.riverName === selectedRiverName));
      return { ...feature, properties: { ...feature.properties, color: '#38bdf8', flow, occupancy, damIcon: damIconBucket(occupancy), powerRadius: powerRadius(feature.properties?.installedPowerMw), visualRadius: visualPowerRadius(feature.properties?.installedPowerMw), damLinked: Boolean(relation?.damIds?.length), relatedToSelected: riverSelected, selected: selectedEntity?.type === 'hes' && selectedEntity.id === id, cascadeDepth: relation?.cascadeOrder ?? null } };
    }) };
    return { rivers: { ...rivers, features: riverFeatures }, basins: { ...basins, features: basinFeatures }, flowStations, hesStations: enrichedHesStations, dams: { ...damStations, features: damFeatures }, lakes, hes177: enrichedHes177, cascades, catchment };
  }, [basins, cascades, catchment, damHesMapping, damStations, dataMode, epias, flowStations, geoglows, hes177, hes177Relations, hesStations, lakes, majorRiverGroups, riverNameMap, rivers, selectedEntity, theme, timelineIndex]);

  const overlayOptions = useMemo<OverlayOptions>(() => ({
    rivers: layers.rivers,
    flowStations: layers.flowStations,
    hesStations: layers.hesStations,
    dams: layers.dams,
    lakes: layers.lakes,
    basins: layers.basins,
    hes177: true,
    outlineColor: theme === 'light' ? '#475569' : '#07111f',
    selectionColor: theme === 'light' ? '#0f766e' : '#f8fafc',
    basinOutlineColor: theme === 'light' ? '#475569' : '#93c5fd',
    riverGlowColor: theme === 'light' ? '#0e7490' : '#38bdf8',
    selectedEntity,
    selectedBasinId: selectedEntity?.type === 'basin' ? selectedEntity.id : selectedEntity?.type === 'hes' ? String(hes177.features.find((feature) => String(feature.properties?.id ?? feature.id ?? '') === selectedEntity.id)?.properties?.basinId ?? '') || null : null,
    selectedRiverMemberIds: selectedEntity?.type === 'river' ? majorRiverGroups.get(selectedEntity.id)?.memberIds ?? [] : selectedEntity?.type === 'hes' ? hes177Relations?.byHesId?.[selectedEntity.id]?.riverIds?.map(String) ?? [] : [],
  }), [hes177.features, hes177Relations, layers.basins, layers.dams, layers.flowStations, layers.hesStations, layers.lakes, layers.rivers, majorRiverGroups, selectedEntity, theme]);

  const syncOverlay = useCallback(function syncOverlay(force = false) {
    const map = mapRef.current;
    if (!map || !dataRef.current || !optionsRef.current || !map.isStyleLoaded()) return;
    if (!force && lastSyncedDataRef.current === dataRef.current && lastSyncedOptionsRef.current === optionsRef.current) return;
    try {
      const synced = ensureHydrologyOverlay(map, dataRef.current, optionsRef.current, () => { requestAnimationFrame(() => syncOverlay(true)); });
      if (!synced) return;
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
      clickPopupRef.current?.remove();
    };
  }, [scheduleOverlaySync]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || basemap === initialBasemapRef.current) return;
    if ((basemap === 'dark' || basemap === 'light') && map.getLayer('basemap-background')) {
      initialBasemapRef.current = basemap;
      applyVectorBasemapPalette(map, basemap);
      map.triggerRepaint();
      return;
    }
    initialBasemapRef.current = basemap;
    lastSyncedDataRef.current = null;
    lastSyncedOptionsRef.current = null;
    map.setStyle(getBasemapStyle(basemap), { diff: false });
    scheduleOverlaySync();
  }, [basemap, scheduleOverlaySync]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedEntity) return;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const focus = () => {
      if (!map.isStyleLoaded()) { retryTimer = setTimeout(focus, 250); return; }
      focusSelectedEntity(map, selectedEntity, { ...collections, riverGroups: new Map([...majorRiverGroups.values()].map((group) => [group.id, group.feature])) });
    };
    focus();
    return () => { if (retryTimer) clearTimeout(retryTimer); };
  }, [collections, majorRiverGroups, selectedEntity]);

  useEffect(() => {
    let cancelled = false;
    if (!activeCatchmentHesId) {
      setCatchment(emptyFeatureCollection());
      return;
    }
    const feature = hes177.features.find((candidate) => String(candidate.properties?.id ?? candidate.id ?? '') === activeCatchmentHesId);
    const url = feature?.properties?.catchmentUrl;
    if (typeof url !== 'string' || !url.startsWith('http')) {
      setCatchment(emptyFeatureCollection());
      return;
    }
    fetch(url, { cache: 'force-cache' }).then(async (response) => {
      if (!response.ok) throw new Error(`catchment ${response.status}`);
      const value = await response.json() as { type?: string; features?: unknown[] };
      if (!cancelled && value.type === 'FeatureCollection' && Array.isArray(value.features)) setCatchment(value as typeof catchment);
    }).catch(() => { if (!cancelled) setCatchment(emptyFeatureCollection()); });
    return () => { cancelled = true; };
  }, [activeCatchmentHesId, hes177.features]);

  useEffect(() => {
    themeRef.current = theme;
    const map = mapRef.current;
    if (!map) return;
    if (!map.getLayer('basemap-background')) { scheduleOverlaySync(); return; }
    if (theme === 'dark' || theme === 'light') applyVectorBasemapPalette(map, theme);
    map.triggerRepaint();
  }, [theme, scheduleOverlaySync]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layers.rivers || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let phase = 0;
    let active = true;
    const tick = () => {
      if (!active || document.visibilityState !== 'visible') return;
      if (map.isStyleLoaded() && map.getLayer('rivers-flow') && map.getLayoutProperty('rivers-flow', 'visibility') !== 'none') {
        phase = (phase + 0.045) % 1;
        map.setPaintProperty('rivers-flow', 'line-dasharray', [0.12 + phase * 0.7, 2.35, 0.1 + phase * 0.3, 0.55]);
        map.triggerRepaint();
      }
      flowAnimationRef.current = requestAnimationFrame(tick);
    };
    const restart = () => {
      if (flowAnimationRef.current !== null) cancelAnimationFrame(flowAnimationRef.current);
      flowAnimationRef.current = document.visibilityState === 'visible' ? requestAnimationFrame(tick) : null;
    };
    document.addEventListener('visibilitychange', restart);
    restart();
    return () => { active = false; document.removeEventListener('visibilitychange', restart); if (flowAnimationRef.current !== null) cancelAnimationFrame(flowAnimationRef.current); };
  }, [layers.rivers]);

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
      clickPopupRef.current?.remove();
      clickPopupRef.current = null;
      const available = INTERACTIVE_LAYERS.filter((layer) => Boolean(map.getLayer(layer)));
      if (!available.length) return;
      const feature = map.queryRenderedFeatures(event.point, { layers: [...available] })[0];
      const id = feature?.properties?.id ?? feature?.properties?.entityId;
      if (!feature || id === undefined || id === null) return;
      if (feature.layer.id === 'rivers-core') setSelectedEntity({ type: 'river', id: String(id) });
      if (feature.layer.id === 'dams-points' || feature.layer.id.startsWith('dams-pie-')) setSelectedEntity({ type: 'dam', id: String(id) });
      if (feature.layer.id === 'lakes-points') setSelectedEntity({ type: 'lake', id: String(id) });
      if (feature.layer.id === 'basins-fill') setSelectedEntity({ type: 'basin', id: String(id) });
      if (feature.layer.id === 'hes-stations' || feature.layer.id === 'hes-related') setSelectedEntity({ type: 'station', id: String(id) });
      if (feature.layer.id === 'hes177-points' || feature.layer.id === 'hes177-pie') {
        const hesId = String(id);
        setSelectedEntity({ type: 'hes', id: hesId });
        const properties = (feature.properties ?? {}) as Record<string, unknown>;
        const relation = hes177Relations?.byHesId?.[hesId];
        const riverId = relation?.riverSystemId ?? relation?.riverIds?.[0];
        const basinId = properties.basinId === undefined || properties.basinId === null ? null : String(properties.basinId);
        const cascadeId = properties.cascadeToId === undefined || properties.cascadeToId === null ? null : String(properties.cascadeToId);
        const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, maxWidth: '280px', className: themeRef.current === 'light' ? 'hydro-click-popup-wrap hydro-tooltip-light' : 'hydro-click-popup-wrap' })
          .setLngLat(event.lngLat)
          .setHTML(hesPopupHtml(properties))
          .addTo(map);
        clickPopupRef.current = popup;
        const element = popup.getElement();
        element?.querySelector('[data-popup-close]')?.addEventListener('click', () => { popup.remove(); if (clickPopupRef.current === popup) clickPopupRef.current = null; });
        element?.querySelector('[data-show-river]')?.addEventListener('click', () => { if (riverId) useAppStore.getState().setSelectedEntity({ type: 'river', id: String(riverId) }); });
        element?.querySelector('[data-show-basin]')?.addEventListener('click', () => { if (basinId) useAppStore.getState().setSelectedEntity({ type: 'basin', id: basinId }); });
        element?.querySelector('[data-show-cascade]')?.addEventListener('click', () => { if (cascadeId) useAppStore.getState().setSelectedEntity({ type: 'hes', id: cascadeId }); });
        element?.querySelector('[data-show-catchment]')?.addEventListener('click', () => useAppStore.getState().toggleCatchment(hesId));
      }
    };
    const onEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
    const onLeave = () => { map.getCanvas().style.cursor = ''; popupRef.current?.remove(); };
    const onMove = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const props = (feature.properties ?? {}) as Record<string, unknown>;
      const layerId = feature.layer.id;
      const kind = layerId === 'basins-fill' ? 'basin' : layerId === 'lakes-points' ? 'lake' : layerId === 'rivers-core' ? 'river' : layerId === 'hes177-points' || layerId === 'hes177-pie' ? 'hes' : layerId === 'flow-stations' || layerId === 'hes-stations' || layerId === 'hes-related' ? 'station' : 'dam';
      const name = kind === 'station' ? displayName(props, 'lake', String(props.id ?? feature.id ?? '')) : displayName(props, kind, String(props.id ?? feature.id ?? ''));
      const detail = kind === 'hes' ? `${props.installedPowerMw ?? '—'} MW · ${String(props.riverName ?? 'Adsız akarsu')}` : kind === 'river' ? `${props.flow !== null && props.flow !== undefined ? `GEOGLOWS Model · ${Number(props.flow).toLocaleString('tr-TR')} m³/s` : 'GEOGLOWS model verisi yok'}\nHavza: ${String(props.basinName ?? props.HavzaAdi ?? props.basinId ?? '—')}` : kind === 'dam' ? `${props.occupancy !== null && props.occupancy !== undefined ? `Doluluk: %${Math.round(Number(props.occupancy))}` : 'EPİAŞ doluluk verisi yok'}${props.isProducer === true ? '\n⚡ Elektrik üretimi' : ''}` : kind === 'lake' ? `Alan: ${props.areaKm2 ? `${Number(props.areaKm2).toLocaleString('tr-TR')} km²` : 'veri yok'}` : kind === 'basin' ? `Alan: ${props.areaKm2 ? `${Number(props.areaKm2).toLocaleString('tr-TR')} km²` : 'özet veri yok'}` : 'TATUS gözlem istasyonu';
      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: themeRef.current === 'light' ? 'hydro-tooltip hydro-tooltip-light' : 'hydro-tooltip' })
        .setLngLat(event.lngLat)
        .setText(`${name}\n${detail}`)
        .addTo(map);
    };
    map.on('click', onClick); INTERACTIVE_LAYERS.forEach((layer) => { map.on('mouseenter', layer, onEnter); map.on('mouseleave', layer, onLeave); });
    INTERACTIVE_LAYERS.forEach((layer) => map.on('mousemove', layer, onMove));
    return () => { map.off('click', onClick); INTERACTIVE_LAYERS.forEach((layer) => { map.off('mouseenter', layer, onEnter); map.off('mouseleave', layer, onLeave); map.off('mousemove', layer, onMove); }); popupRef.current?.remove(); clickPopupRef.current?.remove(); };
  }, [dataMode, hes177Relations, setSelectedEntity]);

  return <div ref={mapContainerRef} className="absolute inset-0" aria-label="Türkiye hidroloji haritası" />;
}

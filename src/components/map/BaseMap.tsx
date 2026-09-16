import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useAppStore } from '../../store/useAppStore';
import { getForecastTimestamps } from '../../services/hydroData';
import { damIconBucket, displayName, getBasinColor, getDamColor, getFlowScaleColor } from '../../data/hydrology';
import { fullnessRecordsByHes, fullnessSourceLabel, preferredFullnessRecord, resolveHistoricalFullness, resolveHesFullness } from '../../data/fullnessSources';
import { getBasemapFallbackStyle, getBasemapStyle, THEME_BACKGROUND } from './mapStyles';
import { HES_PIE_LAYER_ID, ensureHydrologyOverlay, type OverlayCollections, type OverlayOptions } from './mapLayers';
import { focusSelectedEntity } from './mapCamera';
import { emptyFeatureCollection, type FullnessHistoryPoint } from '../../types/hydrology';

const INTERACTIVE_LAYERS = ['rivers-core', 'dams-points', 'basins-fill', 'reservoirs-outline', 'hes177-points', HES_PIE_LAYER_ID] as const;

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

function findHesEpiasRecord(records: Array<Record<string, unknown>>, hesId: string, properties: Record<string, unknown>): Record<string, unknown> | null {
  const names = [properties.damName, properties.name].filter(Boolean).map((value) => String(value).toLocaleLowerCase('tr-TR'));
  return records.find((record) => {
    const ids = [record.hesId, record.hesID, record.entityId, record.entity_id].filter(Boolean).map(String);
    const recordNames = [record.damName, record.dam_name, record.name].filter(Boolean).map((value) => String(value).toLocaleLowerCase('tr-TR'));
    return ids.includes(hesId) || recordNames.some((name) => names.includes(name));
  }) ?? null;
}

function visualPowerRadius(value: unknown): number {
  const power = numberFrom(value);
  if (power === null || power < 20) return 6;
  if (power <= 100) return 6 + ((power - 20) / 80) * 3;
  if (power <= 700) return 9 + ((power - 100) / 600) * 4;
  if (power <= 2400) return 13 + ((power - 700) / 1700) * 5;
  return 18;
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

function fullnessBadge(result: { fullnessPercent: number | null; status: string; sourceClass: string }): string {
  if (result.fullnessPercent === null) return result.status === 'not_applicable' ? 'N/A' : '—';
  if (result.sourceClass === 'mock') return 'M';
  if (result.sourceClass === 'official' || result.sourceClass === 'official_live') return 'E';
  if (result.sourceClass === 'official_published') return 'D';
  if (result.sourceClass === 'satellite_altimetry' || result.sourceClass === 'satellite_area') return 'U';
  return 'H';
}

function legacyHesPopupHtml(properties: Record<string, unknown>): string {
  const producer = properties.isProducer === true ? '<span class="hydro-popup-producer">⚡</span>' : '';
  const occupancy = properties.occupancy === null || properties.occupancy === undefined ? '—' : `%${Math.round(Number(properties.occupancy))}`;
  const displayBasin = properties.displayBasinName ?? properties.basinName ?? properties.basinId;
  const officialBasin = properties.officialBasinName ?? properties.basinName ?? properties.basinId;
  return `<div class="hydro-click-popup"><div class="hydro-popup-head"><strong>${producer}${escapePopup(properties.name)}</strong><button type="button" data-popup-close aria-label="Kapat">×</button></div><div class="hydro-popup-sub">${popupValue(displayBasin)} · ${popupValue(properties.province)}</div><div class="hydro-popup-grid"><span>Resmî havza</span><b>${popupValue(officialBasin)}</b><span>Akarsu</span><b>${popupValue(properties.riverName)}</b><span>Kurulu güç</span><b>${popupValue(properties.installedPowerMw, ' MW')}</b><span>Doluluk</span><b>${occupancy} ${popupValue(properties.fullnessSource)}</b><span>Min / max seviye</span><b>${popupValue(properties.minWaterLevelM)} / ${popupValue(properties.maxWaterLevelM)} m</b><span>Min / max hacim</span><b>${popupValue(properties.minVolumeHm3)} / ${popupValue(properties.maxVolumeHm3)} hm³</b><span>Aktif hacim</span><b>${popupValue(properties.activeVolumeHm3, ' hm³')}</b><span>Kaskat</span><b>${popupValue(properties.cascadeName)}</b><span>Baraj</span><b>${popupValue(properties.damName)}</b></div><div class="hydro-popup-actions"><button type="button" data-show-river>Akarsuyu göster</button><button type="button" data-show-basin>Havzayı göster</button><button type="button" data-show-cascade>Kaskadı göster</button><button type="button" data-show-catchment>Su alanı</button></div></div>`;
}

function historyTrendHtml(points: FullnessHistoryPoint[]): string {
  if (!points.length) return '<div class="hydro-popup-trend-empty">Tarihçe seçili HES detayında açılır</div>';
  const visible = points.slice(-30);
  const width = 220;
  const height = 34;
  const path = visible.map((point, index) => `${index ? 'L' : 'M'}${(visible.length === 1 ? width / 2 : (index / (visible.length - 1)) * width).toFixed(1)},${(height - (Math.max(0, Math.min(100, point.value)) / 100) * height).toFixed(1)}`).join(' ');
  const latest = visible[visible.length - 1];
  return `<div class="hydro-popup-trend"><div><span>Doluluk trendi</span><b>%${Math.round(latest.value)}</b></div><svg viewBox="0 0 ${width} ${height}" aria-label="Doluluk trendi"><path d="${path}" fill="none" stroke="#22d3ee" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg><small>${escapePopup(visible[0].date)} → ${escapePopup(latest.date)} · ${visible.length} gözlem</small></div>`;
}

function hesPopupHtml(properties: Record<string, unknown>, historyPoints: FullnessHistoryPoint[] = []): string {
  const producer = properties.isProducer === true ? '<span class="hydro-popup-producer">⚡</span>' : '';
  const fullness = properties.occupancy === null || properties.occupancy === undefined ? 'N/A' : `%${Math.round(Number(properties.occupancy))}`;
  const fullnessSource = properties.fullnessSourceKey ?? properties.fullnessSource ?? 'N/A';
  const observed = properties.fullnessObservedAt ?? 'N/A';
  const age = properties.fullnessFreshnessDays === null || properties.fullnessFreshnessDays === undefined ? '' : ` · ${properties.fullnessFreshnessDays} gün`;
  const historical = properties.fullnessIsHistorical === true ? `İstenen tarih: ${properties.fullnessRequestedDate ?? '—'} · gözlem: ${observed}` : '';
  const displayBasin = properties.displayBasinName ?? properties.basinName ?? properties.basinId;
  const officialBasin = properties.officialBasinName ?? properties.basinName ?? properties.basinId;
  const coordinateKind = properties.coordinateKind;
  const quality = coordinateKind === 'transformer' ? 'Yaklaşık elektrik bağlantı noktası — gerçek HES konumu değildir' : coordinateKind === 'dam' ? 'TATUS baraj noktası' : coordinateKind === 'hes' ? 'Doğrulanmış HES noktası' : 'Koordinat yok';
  const sourceUrl = typeof properties.fullnessSourceUrl === 'string' && /^https?:\/\//.test(properties.fullnessSourceUrl) ? `<a href="${escapePopup(properties.fullnessSourceUrl)}" target="_blank" rel="noreferrer">${escapePopup(fullnessSource)}</a>` : popupValue(fullnessSource);
  return `<div class="hydro-click-popup"><div class="hydro-popup-head"><strong>${producer}${escapePopup(properties.name)}</strong><button type="button" data-popup-close aria-label="Kapat">×</button></div><div class="hydro-popup-sub">${popupValue(displayBasin)} · ${popupValue(properties.province)}</div><div class="hydro-popup-grid"><span>Gösterim havzası</span><b>${popupValue(displayBasin)}</b><span>Resmî TATUS havzası</span><b>${popupValue(officialBasin)}</b><span>Akarsu</span><b>${popupValue(properties.riverName)}</b><span>Kurulu güç</span><b>${popupValue(properties.installedPowerMw, ' MW')}</b><span>Doluluk / kaynak</span><b>${fullness} · ${sourceUrl}</b><span>Yöntem / gözlem</span><b>${popupValue(properties.fullnessMethod)} · ${popupValue(observed)}${age}</b><span>Tarih görünümü</span><b>${popupValue(historical)}</b><span>Kaynak yayını</span><b>${popupValue(properties.fullnessSourcePublishedAt)}</b><span>Güven / tahmin</span><b>${popupValue(properties.fullnessConfidence)} · ${properties.fullnessEstimated === true ? 'tahmini' : 'ölçüm'}</b><span>Veri notu</span><b>${popupValue(properties.fullnessReasonUnavailable)}</b><span>Depolama</span><b>${popupValue(properties.hydroPlantStorageType)}</b><span>Min / max seviye</span><b>${popupValue(properties.minWaterLevelM)} / ${popupValue(properties.maxWaterLevelM)} m</b><span>Min / max hacim</span><b>${popupValue(properties.minVolumeHm3)} / ${popupValue(properties.maxVolumeHm3)} hm³</b><span>Aktif hacim</span><b>${popupValue(properties.activeVolumeHm3, ' hm³')}</b><span>Debi</span><b>${popupValue(properties.unitFlowM3s, ' m³/sn')}</b><span>Kaskat</span><b>${popupValue(properties.cascadeName)}</b><span>Baraj</span><b>${popupValue(properties.damName)}</b><span>Konum kalitesi</span><b>${quality}</b></div>${historyTrendHtml(historyPoints)}<div class="hydro-popup-actions"><button type="button" data-show-river>Akarsuyu göster</button><button type="button" data-show-basin>Havzayı göster</button><button type="button" data-show-cascade>Kaskadı göster</button><button type="button" data-show-catchment>Su alanı</button></div></div>`;
}

function bindHesPopupActions(popup: maplibregl.Popup, hesId: string, riverId: string | null, basinId: string | null, cascadeId: string | null): void {
  const element = popup.getElement();
  element?.querySelector('[data-popup-close]')?.addEventListener('click', () => popup.remove());
  element?.querySelector('[data-show-river]')?.addEventListener('click', () => { if (riverId) useAppStore.getState().setSelectedEntity({ type: 'river', id: riverId }); });
  element?.querySelector('[data-show-basin]')?.addEventListener('click', () => { if (basinId) useAppStore.getState().setSelectedEntity({ type: 'basin', id: basinId }); });
  element?.querySelector('[data-show-cascade]')?.addEventListener('click', () => { if (cascadeId) useAppStore.getState().setSelectedEntity({ type: 'hes', id: cascadeId }); });
  element?.querySelector('[data-show-catchment]')?.addEventListener('click', () => useAppStore.getState().toggleCatchment(hesId));
}

void legacyHesPopupHtml;

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
  const basemapFallbackRef = useRef(false);
  const overlayRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayBootstrapRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [catchment, setCatchment] = useState(emptyFeatureCollection());

  const rivers = useAppStore((state) => state.rivers);
  const basins = useAppStore((state) => state.basins);
  const damStations = useAppStore((state) => state.damStations);
  const reservoirs = useAppStore((state) => state.reservoirs);
  const hes177 = useAppStore((state) => state.hes177);
  const cascades = useAppStore((state) => state.cascades);
  const hes177Relations = useAppStore((state) => state.hes177Relations);
  const geoglows = useAppStore((state) => state.geoglows);
  const epias = useAppStore((state) => state.epias);
  const fullness = useAppStore((state) => state.fullness);
  const fullnessHistory = useAppStore((state) => state.fullnessHistory);
  const layers = useAppStore((state) => state.layers);
  const basemap = useAppStore((state) => state.basemap);
  const theme = useAppStore((state) => state.theme);
  const selectedEntity = useAppStore((state) => state.selectedEntity);
  const timelineIndex = useAppStore((state) => state.timelineIndex);
  const dataMode = useAppStore((state) => state.dataMode);
  const flowVisualization = useAppStore((state) => state.flowVisualization);
  const historicalDate = useAppStore((state) => state.historicalDate);
  const activeCatchmentHesId = useAppStore((state) => state.activeCatchmentHesId);
  const setSelectedEntity = useAppStore((state) => state.setSelectedEntity);
  const toggleCatchment = useAppStore((state) => state.toggleCatchment);

  const collections = useMemo<OverlayCollections>(() => {
    const geoglowsRecords = geoglows?.records ?? [];
    const timestamps = getForecastTimestamps(geoglows);
    const activeTimestamp = timestamps[timelineIndex];
    const epiasRecords = dataMode === 'epias' ? epias?.records ?? [] : [];
    const fullnessByHes = fullnessRecordsByHes(fullness);
    const fullnessFor = (id: string, properties: Record<string, unknown>, liveRecord?: Record<string, unknown> | null) => {
      const current = resolveHesFullness(id, properties, preferredFullnessRecord(fullnessByHes.get(id), liveRecord), dataMode);
      return historicalDate ? resolveHistoricalFullness(id, current, fullnessHistory, historicalDate) : current;
    };
    const activeForecastFlows = geoglowsRecords.flatMap((record) => {
      const rows = Array.isArray(record.data) ? record.data : [];
      const row = activeTimestamp ? rows.find((candidate) => candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).datetime === activeTimestamp) : rows[0];
      const value = liveNumber(row, ['flow', 'discharge', 'streamflow', 'flow_median', 'value']);
      return value === null ? [] : [value];
    });
    const maxForecastFlow = activeForecastFlows.length ? Math.max(...activeForecastFlows) : 0;
    const selectedRiver = selectedEntity?.type === 'river' ? rivers.features.find((feature) => String(feature.properties?.id ?? feature.id ?? '') === selectedEntity.id) ?? null : null;
    const selectedRiverHesIds = selectedEntity?.type === 'river'
      ? new Set(Array.isArray(selectedRiver?.properties?.hesIds) ? selectedRiver.properties.hesIds.map(String) : hes177.features.filter((feature) => {
        const relation = hes177Relations?.byHesId?.[String(feature.properties?.id ?? feature.id ?? '')];
        return relation?.riverIds?.map(String).includes(selectedEntity.id);
      }).map((feature) => String(feature.properties?.id ?? feature.id ?? '')))
      : new Set<string>();
    const selectedBasinHesIds = selectedEntity?.type === 'basin'
      ? new Set(hes177.features.filter((feature) => String(feature.properties?.basinId ?? '') === selectedEntity.id).map((feature) => String(feature.properties?.id ?? feature.id ?? '')))
      : new Set<string>();
    const selectedRiverDamIds = new Set([...selectedRiverHesIds].flatMap((id) => hes177Relations?.byHesId?.[id]?.damIds?.map(String) ?? []));
    const basinNames = new Map(basins.features.map((feature) => [String(feature.properties?.basinId ?? feature.properties?.ID ?? feature.id ?? ''), String(feature.properties?.name ?? feature.properties?.HAVZA_ADI ?? '')]));
    const basinFeatures = basins.features.map((feature) => {
      const id = String(feature.properties?.basinId ?? feature.properties?.ID ?? feature.id ?? '');
      const selectedBasinId = selectedEntity?.type === 'basin' ? selectedEntity.id : selectedEntity?.type === 'hes' ? String(hes177.features.find((candidate) => String(candidate.properties?.id ?? candidate.id ?? '') === selectedEntity.id)?.properties?.basinId ?? '') : null;
      return { ...feature, properties: { ...feature.properties, color: getBasinColor(id, theme), selected: Boolean(selectedBasinId && id === selectedBasinId), dimmed: Boolean(selectedBasinId && id !== selectedBasinId) } };
    });
    const riverFeatures = rivers.features.map((feature) => {
      const id = String(feature.properties?.id ?? feature.id ?? '');
      const localRiverIds = Array.isArray(feature.properties?.geoglowsLocalRiverIds) ? feature.properties.geoglowsLocalRiverIds.map(String) : [String(feature.properties?.representativeLocalRiverId ?? '')].filter(Boolean);
      const live = geoglowsRecords.find((record) => localRiverIds.includes(String(record.localRiverId ?? '')));
      const liveData = Array.isArray(live?.data) && activeTimestamp ? live.data.filter((row) => row && typeof row === 'object' && (row as Record<string, unknown>).datetime === activeTimestamp) : live?.data;
      const flow = liveNumber(liveData, ['flow', 'discharge', 'streamflow', 'flow_median', 'value']) ?? numberFrom(feature.properties?.flow);
      const color = flow !== null && flowVisualization ? getFlowScaleColor(flow, maxForecastFlow) : '#38bdf8';
      const width = flow !== null ? Math.min(8, Math.max(2.8, Math.log10(Math.max(flow, 0) + 1) * 2.8)) : numberFrom(feature.properties?.width) ?? 2.8;
      const relationRiverSelected = selectedEntity?.type === 'hes' ? hes177Relations?.byHesId?.[selectedEntity.id]?.riverIds?.map(String).includes(id) : false;
      const basinRelevant = selectedEntity?.type === 'basin' && (Array.isArray(feature.properties?.basinIds) ? feature.properties.basinIds.map(String).includes(selectedEntity.id) : String(feature.properties?.basinId ?? '') === selectedEntity.id);
      const riverRelevant = selectedEntity?.type === 'river' ? id === selectedEntity.id : selectedEntity?.type === 'basin' ? basinRelevant : relationRiverSelected;
      return { ...feature, properties: { ...feature.properties, name: displayName(feature.properties ?? {}, 'river', id), riverName: feature.properties?.riverName ?? feature.properties?.name, basinName: basinNames.get(String(feature.properties?.basinId ?? '')), flow, color, width, hasForecast: Boolean(live && Array.isArray(live.data) && live.data.length > 1), selectedRiver: riverRelevant, dimmed: Boolean(selectedEntity && !riverRelevant) } };
    });
    const damFeatures = damStations.features.map((feature) => {
      const properties = feature.properties ?? {};
      const id = String(properties.id ?? feature.id ?? '');
      const name = displayName(properties, 'dam', id);
      const live = epiasRecords.find((record) => String(record.damName ?? record.name ?? '').toLocaleLowerCase('tr-TR') === name.toLocaleLowerCase('tr-TR'));
      const hesIds = Array.isArray(properties.hesIds) ? properties.hesIds.map(String) : [];
      const linkedHesProperties = hesIds.length ? hes177.features.find((candidate) => String(candidate.properties?.id ?? candidate.id ?? '') === hesIds[0])?.properties ?? properties : properties;
      const selectedHesRelation = selectedEntity?.type === 'hes' ? hes177Relations?.byHesId?.[selectedEntity.id] : undefined;
      const relatedToSelectedHes = Boolean(selectedHesRelation?.damIds?.map(String).includes(id));
      const fullnessSeedId = hesIds[0] ?? id;
      const seededOccupancy = fullnessFor(fullnessSeedId, linkedHesProperties, live).fullnessPercent;
      const basinRelevant = selectedEntity?.type === 'basin' && String(properties.basinId ?? '') === selectedEntity.id;
      const damRelevant = selectedRiverDamIds.has(id) || hesIds.some((hesId) => selectedRiverHesIds.has(hesId) || selectedBasinHesIds.has(hesId)) || relatedToSelectedHes || basinRelevant || selectedEntity?.type === 'dam' && selectedEntity.id === id;
      return { ...feature, properties: { ...properties, name, basinName: properties.basinName ?? properties.HavzaAdi, occupancy: seededOccupancy, damIcon: damIconBucket(seededOccupancy), isProducer: hesIds.length > 0, hesMatchIds: hesIds, selected: selectedEntity?.type === 'dam' && selectedEntity.id === id, relatedToSelected: damRelevant, dimmed: Boolean(selectedEntity && !damRelevant), color: seededOccupancy === null ? '#94a3b8' : getDamColor(seededOccupancy), radius: seededOccupancy === null ? 8 : Math.min(13, Math.max(6, seededOccupancy / 8)) } };
    });
    const enrichedHes177 = { ...hes177, features: hes177.features.map((feature) => {
      const id = String(feature.properties?.id ?? feature.id ?? '');
      const relation = hes177Relations?.byHesId?.[id];
      const matchingRiver = rivers.features.find((river) => relation?.riverIds?.map(String).includes(String(river.properties?.id ?? river.id ?? '')));
      const localRiverIds = Array.isArray(matchingRiver?.properties?.geoglowsLocalRiverIds) ? matchingRiver.properties.geoglowsLocalRiverIds.map(String) : [];
      const live = geoglowsRecords.find((record) => localRiverIds.includes(String(record.localRiverId ?? '')));
      const flow = liveNumber(live?.data, ['flow', 'discharge', 'streamflow', 'flow_median', 'value']);
      const fullnessResult = fullnessFor(id, feature.properties ?? {}, findHesEpiasRecord(epiasRecords, id, feature.properties ?? {}));
      const selectedRiverName = selectedRiver?.properties?.riverName ?? selectedRiver?.properties?.name;
      const riverSelected = selectedEntity?.type === 'river' && Boolean((relation?.riverIds ?? []).map(String).includes(selectedEntity.id) || (selectedRiverName && relation?.riverName === selectedRiverName));
      const hesSelected = selectedEntity?.type === 'hes' && selectedEntity.id === id;
      const basinSelected = selectedEntity?.type === 'basin' && String(feature.properties?.basinId ?? '') === selectedEntity.id;
      const selectedHesRelation = selectedEntity?.type === 'hes' ? hes177Relations?.byHesId?.[selectedEntity.id] : undefined;
      const hesRelated = riverSelected || Boolean(selectedHesRelation?.cascadeFromIds?.map(String).includes(id) || String(selectedHesRelation?.cascadeToId ?? '') === id);
      const fullnessSourceKey = fullnessSourceLabel(fullnessResult);
      return { ...feature, properties: { ...feature.properties, color: '#38bdf8', flow, occupancy: fullnessResult.fullnessPercent, fullnessSource: fullnessBadge(fullnessResult), fullnessStatus: fullnessResult.status, fullnessSourceClass: fullnessResult.sourceClass, fullnessSourceKey, fullnessSourceUrl: fullnessResult.sourceUrl, fullnessMethod: fullnessResult.method, fullnessObservedAt: fullnessResult.observedAt, fullnessSourcePublishedAt: fullnessResult.sourcePublishedAt, fullnessFreshnessDays: fullnessResult.freshnessDays, fullnessConfidence: fullnessResult.confidence, fullnessEstimated: fullnessResult.isEstimated, fullnessReasonUnavailable: fullnessResult.reasonUnavailable, fullnessIsHistorical: fullnessResult.isHistoricalView === true, fullnessRequestedDate: fullnessResult.requestedDate, damIcon: damIconBucket(fullnessResult.fullnessPercent), visualRadius: visualPowerRadius(feature.properties?.installedPowerMw), markerDiameterPx: visualPowerRadius(feature.properties?.installedPowerMw) * 2, damLinked: Boolean(relation?.damIds?.length), isProducer: true, relatedToSelected: riverSelected || basinSelected || hesRelated, selected: hesSelected, dimmed: Boolean(selectedEntity && !hesSelected && !hesRelated && !riverSelected && !basinSelected), cascadeDepth: relation?.cascadeOrder ?? null } };
    }) };
    const reservoirFeatures = reservoirs.features.map((feature) => {
      const properties = feature.properties ?? {};
      const hesIds = Array.isArray(properties.hesIds) ? properties.hesIds.map(String) : [];
      const selectedHes = selectedEntity?.type === 'hes' && hesIds.includes(selectedEntity.id);
      const selectedRiverHes = selectedEntity?.type === 'river' && hesIds.some((id) => selectedRiverHesIds.has(id));
      const selectedBasin = selectedEntity?.type === 'basin' && String(properties.basinId ?? '') === selectedEntity.id;
      return { ...feature, properties: { ...properties, selected: selectedHes, dimmed: Boolean(selectedEntity && !selectedHes && !selectedRiverHes && !selectedBasin) } };
    });
    return { rivers: { ...rivers, features: riverFeatures }, basins: { ...basins, features: basinFeatures }, dams: { ...damStations, features: damFeatures }, hes177: enrichedHes177, cascades, catchment, reservoirs: { ...reservoirs, features: reservoirFeatures } };
  }, [basins, cascades, catchment, damStations, dataMode, epias, flowVisualization, fullness, fullnessHistory, geoglows, hes177, hes177Relations, historicalDate, reservoirs, rivers, selectedEntity, theme, timelineIndex]);

  const overlayOptions = useMemo<OverlayOptions>(() => ({
    rivers: layers.rivers,
    dams: layers.dams,
    basins: layers.basins,
    hes177: true,
    reservoirs: true,
    outlineColor: theme === 'light' ? '#475569' : '#07111f',
    selectionColor: theme === 'light' ? '#0f766e' : '#f8fafc',
    basinOutlineColor: theme === 'light' ? '#475569' : '#93c5fd',
    riverGlowColor: theme === 'light' ? '#0e7490' : '#38bdf8',
    selectedEntity,
    selectedBasinId: selectedEntity?.type === 'basin' ? selectedEntity.id : selectedEntity?.type === 'hes' ? String(hes177.features.find((feature) => String(feature.properties?.id ?? feature.id ?? '') === selectedEntity.id)?.properties?.basinId ?? '') || null : null,
    selectedRiverMemberIds: selectedEntity?.type === 'river' ? [selectedEntity.id] : selectedEntity?.type === 'hes' ? hes177Relations?.byHesId?.[selectedEntity.id]?.riverIds?.map(String) ?? [] : [],
  }), [hes177.features, hes177Relations, layers.basins, layers.dams, layers.rivers, selectedEntity, theme]);

  const syncOverlay = useCallback(function syncOverlay(force = false) {
    const map = mapRef.current;
    if (!map || !dataRef.current || !optionsRef.current || !map.getStyle()) return;
    if (!force && lastSyncedDataRef.current === dataRef.current && lastSyncedOptionsRef.current === optionsRef.current) return;
    const needsInitialRefresh = lastSyncedDataRef.current !== dataRef.current || lastSyncedOptionsRef.current !== optionsRef.current;
    try {
      const synced = ensureHydrologyOverlay(map, dataRef.current, optionsRef.current, () => { requestAnimationFrame(() => syncOverlay(true)); });
      if (!synced) {
        if (overlayRetryRef.current === null) {
          overlayRetryRef.current = setTimeout(() => {
            overlayRetryRef.current = null;
            syncOverlay(true);
          }, 250);
        }
        return;
      }
      lastSyncedDataRef.current = dataRef.current;
      lastSyncedOptionsRef.current = optionsRef.current;
      if (map.getLayer('basemap-background')) map.setPaintProperty('basemap-background', 'background-color', THEME_BACKGROUND[themeRef.current]);
      map.triggerRepaint();
      // Raster styles can finish their first render one frame after the
      // GeoJSON source is registered. Reconcile once more after that frame so
      // the first view does not require a manual layer toggle to paint.
      if (needsInitialRefresh && overlayRetryRef.current === null) {
        overlayRetryRef.current = setTimeout(() => {
          overlayRetryRef.current = null;
          syncOverlay(true);
        }, 350);
      }
    } catch {
      // A style swap can briefly invalidate the style object. Retry after the
      // style parser has had a chance to finish, even if no further tile event
      // is emitted by the fallback source.
      if (overlayRetryRef.current === null) {
        overlayRetryRef.current = setTimeout(() => {
          overlayRetryRef.current = null;
          syncOverlay(true);
        }, 250);
      }
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
    // Start with the raster-safe style for the default thematic basemaps. The
    // OpenFreeMap vector source can report a loaded style while returning no
    // visible tiles in a static-host production browser; that state used to
    // leave the canvas blank before the fallback timer could react. Hydrology
    // overlays are still inserted on top immediately, and users can switch to
    // the optional vector styles from the basemap menu when available.
    const initialStyle = initialBasemapRef.current === 'satellite'
      ? getBasemapStyle(initialBasemapRef.current)
      : getBasemapFallbackStyle(themeRef.current);
    const map = new maplibregl.Map({ container: mapContainerRef.current, style: initialStyle, center: [35.3, 39], zoom: 5.5, attributionControl: false, renderWorldCopies: false });
    mapRef.current = map;
    const onStyleReady = () => scheduleOverlaySync(true);
    const onStyleData = () => scheduleOverlaySync();
    const fallbackToRaster = () => {
      if (basemapFallbackRef.current || initialBasemapRef.current === 'satellite') return;
      basemapFallbackRef.current = true;
      lastSyncedDataRef.current = null;
      lastSyncedOptionsRef.current = null;
      map.setStyle(getBasemapFallbackStyle(themeRef.current), { diff: false });
    };
    const onMapError = (event: maplibregl.ErrorEvent) => {
      const details = event as unknown as { sourceId?: unknown; error?: unknown };
      const sourceId = String(details.sourceId ?? '').toLocaleLowerCase('en-US');
      const message = String(details.error instanceof Error ? details.error.message : details.error ?? '').toLocaleLowerCase('en-US');
      if (sourceId === 'openmaptiles' || message.includes('openfreemap') || message.includes('openmaptiles')) fallbackToRaster();
      // Handle optional remote tile errors at the map boundary. The local
      // hydrology layers remain available even when the basemap is not.
      (event as unknown as { preventDefault?: () => void }).preventDefault?.();
    };
    map.on('load', onStyleReady);
    map.on('style.load', onStyleReady);
    map.on('styledata', onStyleData);
    map.on('error', onMapError);
    let bootstrapAttempts = 0;
    const stopOverlayBootstrap = () => {
      if (overlayBootstrapRef.current !== null) {
        clearInterval(overlayBootstrapRef.current);
        overlayBootstrapRef.current = null;
      }
    };
    const bootstrapOverlays = () => {
      bootstrapAttempts += 1;
      scheduleOverlaySync(true);
      if ((map.getLayer('hes177-points') && map.getLayer('rivers-core')) || bootstrapAttempts >= 30) stopOverlayBootstrap();
    };
    const onFirstRender = () => bootstrapOverlays();
    map.on('render', onFirstRender);
    overlayBootstrapRef.current = setInterval(bootstrapOverlays, 500);
    const fallbackTimer = initialBasemapRef.current === 'satellite' ? null : setTimeout(() => {
      if (!map.getSource('openmaptiles')) return;
      let hasVisibleBasemap = false;
      try {
        hasVisibleBasemap = map.queryRenderedFeatures({ layers: ['basemap-landcover', 'basemap-water', 'basemap-roads', 'basemap-boundaries'] }).length > 0;
      } catch {
        hasVisibleBasemap = false;
      }
      if (!map.isSourceLoaded('openmaptiles') || !hasVisibleBasemap) fallbackToRaster();
    }, 4500);
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'GDW rezervuar poligonları · OpenFreeMap / OSM' }), 'bottom-right');
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (overlayRetryRef.current !== null) clearTimeout(overlayRetryRef.current);
      stopOverlayBootstrap();
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
      map.off('load', onStyleReady); map.off('style.load', onStyleReady); map.off('styledata', onStyleData); map.off('error', onMapError); map.off('render', onFirstRender);
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
    basemapFallbackRef.current = false;
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
      focusSelectedEntity(map, selectedEntity, collections);
    };
    focus();
    return () => { if (retryTimer) clearTimeout(retryTimer); };
  }, [collections, selectedEntity]);

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
    if (map.getLayer('basemap-background')) map.setPaintProperty('basemap-background', 'background-color', THEME_BACKGROUND[theme]);
    if (map.getLayer('basemap-raster')) map.setPaintProperty('basemap-raster', 'raster-opacity', theme === 'light' ? 0.72 : 0.48);
    map.triggerRepaint();
  }, [theme, scheduleOverlaySync]);

  useEffect(() => {
    const map = mapRef.current;
    const directionVerified = rivers.features.some((feature) => feature.properties?.flowDirectionVerified === true || feature.properties?.directionVerified === true);
    if (!map || !layers.rivers || !directionVerified || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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
  }, [layers.rivers, rivers.features]);

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
      if (!feature || id === undefined || id === null) {
        setSelectedEntity(null);
        if (activeCatchmentHesId) toggleCatchment(activeCatchmentHesId);
        return;
      }
      if (feature.layer.id === 'rivers-core') setSelectedEntity({ type: 'river', id: String(id) });
      if (feature.layer.id === 'dams-points') setSelectedEntity({ type: 'dam', id: String(id) });
      if (feature.layer.id === 'basins-fill') {
        const basinId = feature.properties?.basinId ?? feature.properties?.HAVZA_ID ?? feature.properties?.ID;
        if (basinId !== undefined && basinId !== null) setSelectedEntity({ type: 'basin', id: String(basinId) });
      }
      if (feature.layer.id === 'reservoirs-outline') {
        const hesId = Array.isArray(feature.properties?.hesIds) ? String(feature.properties.hesIds[0] ?? '') : '';
        if (hesId) setSelectedEntity({ type: 'hes', id: hesId });
        return;
      }
      if (feature.layer.id === 'hes177-points' || feature.layer.id === HES_PIE_LAYER_ID) {
        const hesId = String(id);
        setSelectedEntity({ type: 'hes', id: hesId });
        const properties = { ...((feature.properties ?? {}) as Record<string, unknown>) };
        const relation = hes177Relations?.byHesId?.[hesId];
        const riverId = relation?.riverSystemId ?? relation?.riverIds?.[0];
        const basinId = properties.basinId === undefined || properties.basinId === null ? null : String(properties.basinId);
        const cascadeId = properties.cascadeToId === undefined || properties.cascadeToId === null ? null : String(properties.cascadeToId);
        const historyPoints = fullnessHistory?.records?.find((record) => String(record.hesId) === hesId)?.points ?? [];
        const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, maxWidth: '280px', className: themeRef.current === 'light' ? 'hydro-click-popup-wrap hydro-tooltip-light' : 'hydro-click-popup-wrap' })
          .setLngLat(event.lngLat)
          .setHTML(hesPopupHtml(properties, historyPoints))
          .addTo(map);
        clickPopupRef.current = popup;
        popup.on('close', () => { if (clickPopupRef.current === popup) clickPopupRef.current = null; });
        bindHesPopupActions(popup, hesId, riverId ? String(riverId) : null, basinId, cascadeId ? String(cascadeId) : null);
      }
    };
    const onEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
    const onLeave = () => { map.getCanvas().style.cursor = ''; popupRef.current?.remove(); };
    const onMove = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const props = (feature.properties ?? {}) as Record<string, unknown>;
      const layerId = feature.layer.id;
      const kind = layerId === 'basins-fill' ? 'basin' : layerId === 'rivers-core' ? 'river' : layerId === 'reservoirs-outline' ? 'lake' : layerId === 'hes177-points' || layerId === HES_PIE_LAYER_ID ? 'hes' : 'dam';
      const name = displayName(props, kind, String(props.id ?? feature.id ?? ''));
      const detail = kind === 'hes' ? `${props.installedPowerMw ?? '—'} MW · ${String(props.riverName ?? 'Akarsu doğrulanamadı')}\nDoluluk: ${props.occupancy === null || props.occupancy === undefined ? '—' : `%${Math.round(Number(props.occupancy))} ${String(props.fullnessSource ?? '—')}`}` : kind === 'river' ? `${props.hasForecast ? 'GEOGLOWS tahmini mevcut' : 'GEOGLOWS tahmini yok'}\nHavza: ${String(props.basinName ?? props.HavzaAdi ?? props.basinId ?? '—')}` : kind === 'dam' ? `${props.occupancy !== null && props.occupancy !== undefined ? `Doluluk: %${Math.round(Number(props.occupancy))}` : 'Doluluk verisi yok'}${props.isProducer === true ? '\n⚡ Bağlı HES tesisi' : ''}` : `Alan: ${props.areaKm2 ? `${Number(props.areaKm2).toLocaleString('tr-TR')} km²` : 'özet veri yok'}`;
      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: themeRef.current === 'light' ? 'hydro-tooltip hydro-tooltip-light' : 'hydro-tooltip' })
        .setLngLat(event.lngLat)
        .setText(`${name}\n${detail}`)
        .addTo(map);
    };
    map.on('click', onClick); INTERACTIVE_LAYERS.forEach((layer) => { map.on('mouseenter', layer, onEnter); map.on('mouseleave', layer, onLeave); });
    INTERACTIVE_LAYERS.forEach((layer) => map.on('mousemove', layer, onMove));
    return () => { map.off('click', onClick); INTERACTIVE_LAYERS.forEach((layer) => { map.off('mouseenter', layer, onEnter); map.off('mouseleave', layer, onLeave); map.off('mousemove', layer, onMove); }); popupRef.current?.remove(); clickPopupRef.current?.remove(); };
  }, [activeCatchmentHesId, dataMode, fullnessHistory, hes177Relations, setSelectedEntity, toggleCatchment]);

  useEffect(() => {
    const popup = clickPopupRef.current;
    if (!popup || selectedEntity?.type !== 'hes') return;
    const feature = collections.hes177.features.find((candidate) => String(candidate.properties?.id ?? candidate.id ?? '') === selectedEntity.id);
    if (!feature) return;
    const properties = { ...((feature.properties ?? {}) as Record<string, unknown>) };
    const relation = hes177Relations?.byHesId?.[selectedEntity.id];
    const riverId = relation?.riverSystemId ?? relation?.riverIds?.[0];
    const basinId = properties.basinId === undefined || properties.basinId === null ? null : String(properties.basinId);
    const cascadeId = properties.cascadeToId === undefined || properties.cascadeToId === null ? null : String(properties.cascadeToId);
    const historyPoints = fullnessHistory?.records?.find((record) => String(record.hesId) === selectedEntity.id)?.points ?? [];
    popup.setHTML(hesPopupHtml(properties, historyPoints));
    bindHesPopupActions(popup, selectedEntity.id, riverId ? String(riverId) : null, basinId, cascadeId);
  }, [collections, fullnessHistory, hes177Relations, selectedEntity]);

  return <div ref={mapContainerRef} className="absolute inset-0" aria-label="Türkiye hidroloji haritası" />;
}

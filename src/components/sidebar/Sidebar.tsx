import React, { useMemo, useState } from 'react';
import { Activity, ArrowUpDown, Eye, EyeOff, Gauge, Mountain, Search, Waves, X, Zap } from 'lucide-react';
import { buildBasinSummaries, buildDamHesMapping, buildMajorRiverGroups, buildRiverNameMap, displayName, isElectricProducer, isUnknownName, relateRiverToDams } from '../../data/hydrology';
import { getForecastTimestamps } from '../../services/hydroData';
import { useAppStore, type TabType } from '../../store/useAppStore';
import { emptyFeatureCollection } from '../../types/hydrology';

type Detail = { label: string; value: string };
type Item = { id: string; name: string; subtitle?: string; basinName?: string; riverName?: string; metric?: string; status?: string; sourceBadge?: 'TATUS' | 'GEOGLOWS' | 'EPİAŞ'; sourceTime?: string; details: Detail[]; isProducer?: boolean; typeLabel: string; location: string; powerValue: number; sortText: string };
type SortKey = 'type' | 'name' | 'basin' | 'river' | 'power';
type ItemKind = TabType | 'dams' | 'lakes';
type FeatureCollectionLike = { features: Array<{ id?: string | number; properties?: Record<string, unknown> | null }> };

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(result) ? result : null;
}

function firstValue(properties: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = numeric(properties[key]);
    if (value !== null) return value;
  }
  return null;
}

function textValue(properties: Record<string, unknown>, keys: string[]): string | undefined {
  const value = keys.map((key) => properties[key]).find((candidate) => !isUnknownName(candidate));
  return value === undefined ? undefined : String(value);
}

function liveValue(record: unknown, keys: string[]): number | null {
  if (!record || typeof record !== 'object') return null;
  const source = record as Record<string, unknown>;
  return firstValue(source, keys);
}

function itemsFrom(collection: FeatureCollectionLike, kind: ItemKind, liveFlows: Map<string, { value: number; timestamp?: string }>, liveDams: Map<string, { value: number; timestamp?: string; record: Record<string, unknown> }>, generatedAt: string | undefined, riverNames: Map<string, string>, basinSummaries: Map<string, { areaKm2: number | null; riverCount: number; riverLengthKm: number; damCount: number; hesCount: number; hesStationCount: number; lakeCount: number; lakeStationCount: number; mainRiverNames: string[] }>, damHesMapping: Map<string, { damId: string; hesIds: string[] }>): Item[] {
  return collection.features.map((feature) => {
    const properties = feature.properties ?? {};
    const id = String(properties.id ?? properties.entityId ?? feature.id ?? '');
    const entityKind = kind === 'rivers' ? 'river' : kind === 'dams' ? 'dam' : kind === 'hes' ? 'hes' : 'basin';
    const name = kind === 'rivers' ? riverNames.get(id) ?? displayName(properties, entityKind, id) : displayName(properties, entityKind, id);
    const basin = textValue(properties, ['basinName', 'HavzaAdi', 'HAVZA_ADI', 'Havza_Id_Text']);
    const flow = kind === 'rivers' ? liveFlows.get(id) : undefined;
    const damLive = kind === 'dams' ? liveDams.get(name.toLocaleLowerCase('tr-TR')) : undefined;
    const occupancy = damLive?.value ?? firstValue(properties, ['occupancy', 'doluluk']);
    const area = firstValue(properties, ['areaKm2', 'ALAN_KM2']);
    const length = firstValue(properties, ['lengthKm']);
    const activeVolume = damLive ? firstValue(damLive.record, ['activeVolume', 'active_volume', 'hacim']) : firstValue(properties, ['activeVolume', 'active_volume', 'activeVolumeHm3']);
    const level = damLive ? firstValue(damLive.record, ['waterLevel', 'level', 'suSeviyesi']) : firstValue(properties, ['waterLevel', 'level']);
    const power = damLive ? firstValue(damLive.record, ['installedPower', 'power', 'kuruluGuc']) : firstValue(properties, ['installedPower', 'power', 'kuruluGuc', 'installedPowerMw']);
    const riverPower = firstValue(properties, ['installedPowerMw', 'totalPowerMw', 'installedPower']);
    const producer = kind === 'hes' ? Boolean(properties.isProducer) : kind === 'dams' && isElectricProducer(properties, damHesMapping.has(id)) || Boolean(damLive && isElectricProducer(damLive.record));
    const sourceBadge: Item['sourceBadge'] = flow ? 'GEOGLOWS' : damLive ? 'EPİAŞ' : undefined;
    const sourceTime = flow?.timestamp ?? damLive?.timestamp ?? generatedAt;
    const details: Detail[] = [];
    if (basin) details.push({ label: 'Havza', value: basin });
    if (kind === 'rivers') {
      if (length !== null) details.push({ label: 'Uzunluk', value: `${length.toLocaleString('tr-TR')} km` });
      details.push({ label: 'HES', value: `${Number(properties.hesCount ?? 0).toLocaleString('tr-TR')} tesis` });
      if (riverPower !== null) details.push({ label: 'Kurulu güç', value: `${riverPower.toLocaleString('tr-TR')} MW` });
      details.push({ label: 'GEOGLOWS', value: flow ? `${flow.value.toLocaleString('tr-TR')} m³/s` : 'Tahmin yok' });
      details.push({ label: 'Durum', value: flow ? 'Gerçek zaman serisi' : String(properties.status ?? 'veri yok') });
    } else if (kind === 'dams') {
      if (occupancy !== null) details.push({ label: 'Doluluk', value: `%${Math.round(occupancy)}` });
      if (activeVolume !== null) details.push({ label: 'Aktif hacim', value: activeVolume.toLocaleString('tr-TR') });
      if (level !== null) details.push({ label: 'Su seviyesi', value: level.toLocaleString('tr-TR') });
      if (power !== null) details.push({ label: 'Kurulu güç', value: power.toLocaleString('tr-TR') });
      details.push({ label: 'Tip', value: producer ? 'Elektrik üretimi doğrulandı' : 'Baraj / HES niteliği yok' });
    } else if (kind === 'hes') {
      if (power !== null) details.push({ label: 'Kurulu güç', value: `${power.toLocaleString('tr-TR')} MW` });
      const flowRate = firstValue(properties, ['unitFlowM3s']);
      if (flowRate !== null) details.push({ label: 'Ünite debisi', value: `${flowRate.toLocaleString('tr-TR')} m³/sn` });
      if (properties.damName) details.push({ label: 'Baraj / rezervuar', value: String(properties.damName) });
      if (properties.cascadeName && !/^[0-9.]+$/.test(String(properties.cascadeName))) details.push({ label: 'Kaskad', value: String(properties.cascadeName) });
      details.push({ label: 'Veri kalitesi', value: String(properties.dataQuality ?? '—') });
    } else if (kind === 'lakes') {
      if (area !== null) details.push({ label: 'Alan', value: `${area.toLocaleString('tr-TR')} km²` });
      details.push({ label: 'Gözlem', value: String(properties.status ?? 'veri yok') });
    } else {
      const summary = basinSummaries.get(String(properties.basinId ?? properties.HAVZA_ID ?? id));
      if (summary) {
        if (summary.areaKm2 !== null) details.push({ label: 'Alan', value: `${summary.areaKm2.toLocaleString('tr-TR')} km²` });
        details.push({ label: 'Akarsu', value: `${summary.riverCount} · ${summary.riverLengthKm.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} km` });
        details.push({ label: 'Baraj', value: String(summary.damCount) });
        details.push({ label: 'HES', value: String(summary.hesCount) });
        details.push({ label: 'HES ist.', value: String(summary.hesStationCount) });
        details.push({ label: 'Göl ist.', value: String(summary.lakeStationCount) });
        if (summary.mainRiverNames.length) details.push({ label: 'Ana akarsular', value: summary.mainRiverNames.join(', ') });
      }
    }
    const metric = kind === 'rivers' ? `${Number(properties.hesCount ?? 0).toLocaleString('tr-TR')} HES · ${riverPower !== null ? `${riverPower.toLocaleString('tr-TR')} MW` : length !== null ? `${length.toLocaleString('tr-TR')} km` : '—'}` : kind === 'dams' ? activeVolume !== null ? `${activeVolume.toLocaleString('tr-TR')} hacim` : occupancy !== null ? `%${Math.round(occupancy)}` : undefined : kind === 'hes' ? power !== null ? `${power.toLocaleString('tr-TR')} MW` : undefined : kind === 'lakes' || kind === 'basins' ? area !== null ? `${Math.round(area).toLocaleString('tr-TR')} km²` : undefined : undefined;
    const status = kind === 'rivers' ? flow ? 'GEOGLOWS tahmin mevcut' : 'GEOGLOWS tahmini yok' : kind === 'dams' ? damLive ? 'EPİAŞ verisi mevcut' : 'EPİAŞ doluluk verisi yok' : kind === 'hes' ? `177 HES · ${String(properties.dataQuality ?? 'kalite yok')}` : String(properties.status ?? 'veri yok');
    const typeLabel = kind === 'rivers' ? 'Akarsu' : kind === 'dams' ? 'Baraj/HES' : kind === 'hes' ? 'HES' : kind === 'lakes' ? 'Göl ist.' : 'Havza';
    const province = textValue(properties, ['Il', 'IL', 'il']);
    const location = kind === 'dams' ? province ?? basin ?? '—' : kind === 'hes' ? province ? `${province} · ${basin ?? '—'}` : basin ?? '—' : kind === 'basins' ? name : basin ?? province ?? '—';
    const rowSubtitle = kind === 'hes' ? textValue(properties, ['riverName']) ?? basin : basin;
    const riverName = kind === 'hes' ? textValue(properties, ['riverName']) : kind === 'rivers' ? name : undefined;
    return { id, name, subtitle: rowSubtitle, basinName: basin, riverName, metric, status, sourceBadge, sourceTime, details, isProducer: producer, typeLabel, location, powerValue: kind === 'hes' ? power ?? 0 : riverPower ?? 0, sortText: `${typeLabel} ${name} ${basin ?? ''} ${riverName ?? ''} ${location} ${status} ${String(properties.damName ?? '')}` };
  }).filter((item) => item.id && item.name);
}

function stationItemsFrom(collection: FeatureCollectionLike): Item[] {
  return collection.features.map((feature) => {
    const properties = feature.properties ?? {};
    const id = String(properties.id ?? properties.entityId ?? feature.id ?? '');
    const name = textValue(properties, ['IstAdi', 'name']) ?? `HES istasyonu · ${id}`;
    const water = textValue(properties, ['SuAdi']);
    const location = textValue(properties, ['Il', 'IL', 'il', 'HavzaAdi']) ?? 'Fırat-Dicle';
    return { id, name, subtitle: water, basinName: location, riverName: water, metric: 'HES', status: 'TATUS tesisi', sourceBadge: 'TATUS' as const, details: [{ label: 'Su', value: water ?? '—' }, { label: 'Konum', value: location }], typeLabel: 'Baraj/HES', location, powerValue: 0, sortText: `Baraj HES ${name} ${water ?? ''} ${location}` };
  });
}

export const Sidebar: React.FC = () => {
  const theme = useAppStore((s) => s.theme);
  const currentTab = useAppStore((s) => s.currentTab);
  const setTab = useAppStore((s) => s.setTab);
  const currentFilter = useAppStore((s) => s.currentFilter);
  const setFilter = useAppStore((s) => s.setFilter);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const selectedEntity = useAppStore((s) => s.selectedEntity);
  const setSelectedEntity = useAppStore((s) => s.setSelectedEntity);
  const toggleCatchment = useAppStore((s) => s.toggleCatchment);
  const toggleLayer = useAppStore((s) => s.toggleLayer);
  const layers = useAppStore((s) => s.layers);
  const rivers = useAppStore((s) => s.rivers);
  const dams = useAppStore((s) => s.damStations);
  const hesStations = useAppStore((s) => s.hesStations);
  const hes177 = useAppStore((s) => s.hes177);
  const hes177Relations = useAppStore((s) => s.hes177Relations);
  const basins = useAppStore((s) => s.basins);
  const geoglows = useAppStore((s) => s.geoglows);
  const epias = useAppStore((s) => s.epias);
  const manifest = useAppStore((s) => s.dataManifest);
  const timelineIndex = useAppStore((s) => s.timelineIndex);
  const dataStatus = useAppStore((s) => s.hydroDataStatus);
  const isLight = theme === 'light';
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const riverNameMap = useMemo(() => buildRiverNameMap(rivers), [rivers]);
  const damHesMapping = useMemo(() => buildDamHesMapping(dams, hesStations), [dams, hesStations]);
  const majorRiverGroups = useMemo(() => buildMajorRiverGroups(rivers, hesStations), [hesStations, rivers]);
  const lakes = useMemo(() => emptyFeatureCollection(), []);
  const basinSummaries = useMemo(() => buildBasinSummaries(basins, rivers, dams, hes177, hesStations, lakes, riverNameMap), [basins, dams, hes177, hesStations, lakes, riverNameMap, rivers]);
  const basinLabels = useMemo(() => new Map(basins.features.map((feature) => [String(feature.properties?.basinId ?? feature.properties?.ID ?? feature.id ?? ''), textValue(feature.properties ?? {}, ['name', 'HAVZA_ADI']) ?? ''])), [basins]);

  const liveMaps = useMemo(() => {
    const timestamps = getForecastTimestamps(geoglows);
    const timestamp = timestamps[timelineIndex];
    const flowMap = new Map<string, { value: number; timestamp?: string }>();
    (geoglows?.records ?? []).forEach((record) => {
      const rows = Array.isArray(record.data) ? record.data : [];
      const row = rows.find((candidate) => !timestamp || (candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).datetime === timestamp));
      const value = liveValue(row, ['flow_median', 'flow', 'discharge', 'streamflow', 'value']);
      if (value !== null && record.localRiverId) flowMap.set(String(record.localRiverId), { value, timestamp: row && typeof row === 'object' ? String((row as Record<string, unknown>).datetime ?? '') : undefined });
    });
    const damMap = new Map<string, { value: number; timestamp?: string; record: Record<string, unknown> }>();
    (epias?.records ?? []).forEach((record) => {
      const value = liveValue(record, ['occupancy', 'fullness', 'activeFullness', 'doluluk']);
      const name = record.damName ?? record.name;
      if (value !== null && name) damMap.set(String(name).toLocaleLowerCase('tr-TR'), { value, timestamp: record.datetime ? String(record.datetime) : undefined, record });
    });
    return { flowMap, damMap };
  }, [epias?.records, geoglows, timelineIndex]);

  const source = currentTab === 'rivers' ? rivers : currentTab === 'hes' ? hes177 : basins;
  const labeledSource = useMemo(() => {
    const withLabels = source.features.map((feature) => ({ ...feature, properties: { ...feature.properties, basinName: basinLabels.get(String(feature.properties?.basinId ?? feature.properties?.HAVZA_ID ?? '')) ?? feature.properties?.basinName } }));
    if (currentTab !== 'rivers') return { features: withLabels };
    if (withLabels.some((feature) => (feature.properties as Record<string, unknown> | null | undefined)?.entityType === 'hesRiverSystem')) return { features: withLabels.filter((feature) => { const properties = feature.properties as Record<string, unknown> | null | undefined; return !isUnknownName(properties?.riverName ?? properties?.name); }) };
    const grouped = [...majorRiverGroups.values()].map((group) => ({ ...group.feature, properties: { ...group.feature.properties, entityType: 'hesRivers', basinName: basinLabels.get(group.basinId), lengthKm: group.representedLengthKm, name: group.name, riverName: group.name } }));
    const groupedMembers = new Set([...majorRiverGroups.values()].flatMap((group) => group.memberIds.map(String)));
    return { features: [...grouped, ...withLabels.filter((feature) => { const id = (feature.properties as Record<string, unknown> | null | undefined)?.id ?? (feature as { id?: string | number }).id; return !groupedMembers.has(String(id ?? '')); })] };
  }, [basinLabels, currentTab, majorRiverGroups, source]);
  const list = useMemo(() => {
    const items = itemsFrom(labeledSource, currentTab, liveMaps.flowMap, liveMaps.damMap, manifest?.generatedAt, riverNameMap, basinSummaries, damHesMapping);
    return items;
  }, [basinSummaries, currentTab, damHesMapping, labeledSource, liveMaps, manifest?.generatedAt, riverNameMap]);
  const selectedRiver = selectedEntity?.type === 'river' ? rivers.features.find((feature) => String(feature.properties?.id ?? feature.id ?? '') === selectedEntity.id) ?? majorRiverGroups.get(selectedEntity.id)?.feature : null;
  const selectedRiverRelation = useMemo(() => selectedRiver ? relateRiverToDams({ ...selectedRiver, properties: { ...selectedRiver.properties, riverName: riverNameMap.get(String(selectedRiver.properties?.id ?? selectedRiver.id ?? '')) ?? selectedRiver.properties?.riverName } }, dams, hesStations, damHesMapping) : null, [damHesMapping, dams, hesStations, riverNameMap, selectedRiver]);
  const selectedRiverHesIds = useMemo(() => {
    if (!selectedRiver) return new Set<string>();
    const directRiverHesIds = Array.isArray(selectedRiver.properties?.hesIds) ? selectedRiver.properties.hesIds.map(String) : [];
    if (directRiverHesIds.length) return new Set(directRiverHesIds);
    const selectedName = String(selectedRiver.properties?.riverName ?? selectedRiver.properties?.name ?? '').toLocaleLowerCase('tr-TR');
    return new Set(hes177.features.filter((feature) => {
      const id = String(feature.properties?.id ?? feature.id ?? '');
      const relation = hes177Relations?.byHesId?.[id];
      const relationName = String(relation?.riverName ?? '').toLocaleLowerCase('tr-TR');
      const riverHesIds = Array.isArray(selectedRiver.properties?.hesIds) ? selectedRiver.properties.hesIds.map(String) : [];
      return riverHesIds.includes(id) || Boolean(selectedName && relationName && (selectedName.includes(relationName) || relationName.includes(selectedName))) || Boolean(relation?.riverIds?.includes(String(selectedRiver.properties?.id ?? selectedRiver.id ?? '')));
    }).map((feature) => String(feature.properties?.id ?? feature.id ?? '')));
  }, [hes177.features, hes177Relations, selectedRiver]);
  const selectedRiverDamIds = useMemo(() => new Set([...selectedRiverHesIds].flatMap((id) => hes177Relations?.byHesId?.[id]?.damIds?.map(String) ?? [])), [hes177Relations, selectedRiverHesIds]);
  const selectedHes = useMemo(() => selectedEntity?.type === 'hes' ? hes177.features.find((feature) => String(feature.properties?.id ?? feature.id ?? '') === selectedEntity.id) : null, [hes177.features, selectedEntity]);
  const relatedDams = useMemo(() => {
    if (!selectedRiverRelation) return [];
    const related = dams.features.filter((feature) => {
      const id = String(feature.properties?.id ?? feature.properties?.entityId ?? feature.id ?? '');
      const hesIds = Array.isArray(feature.properties?.hesIds) ? feature.properties.hesIds.map(String) : [];
      return selectedRiverDamIds.has(id) || hesIds.some((hesId) => selectedRiverHesIds.has(hesId)) || Boolean(selectedRiverRelation?.ids.has(id));
    });
    return itemsFrom({ features: related }, 'dams', liveMaps.flowMap, liveMaps.damMap, manifest?.generatedAt, riverNameMap, basinSummaries, damHesMapping).slice(0, 12);
  }, [basinSummaries, damHesMapping, dams.features, liveMaps, manifest?.generatedAt, riverNameMap, selectedRiverDamIds, selectedRiverHesIds, selectedRiverRelation]);
  const relatedStations = useMemo(() => {
    if (!selectedRiverRelation && !selectedRiverHesIds.size) return [];
    const stationIds = new Set([...selectedRiverHesIds].flatMap((id) => hes177Relations?.byHesId?.[id]?.stationIds?.map(String) ?? []));
    return stationItemsFrom({ features: hesStations.features.filter((feature) => stationIds.has(String(feature.properties?.id ?? feature.properties?.entityId ?? feature.id ?? '')) || Boolean(selectedRiverRelation?.stationIds.has(String(feature.properties?.id ?? feature.properties?.entityId ?? feature.id ?? '')))) });
  }, [hes177Relations, hesStations.features, selectedRiverHesIds, selectedRiverRelation]);
  const relatedHes = useMemo(() => itemsFrom({ features: hes177.features.filter((feature) => selectedRiverHesIds.has(String(feature.properties?.id ?? feature.id ?? ''))) }, 'hes', liveMaps.flowMap, liveMaps.damMap, manifest?.generatedAt, riverNameMap, basinSummaries, damHesMapping), [basinSummaries, damHesMapping, hes177.features, liveMaps, manifest?.generatedAt, riverNameMap, selectedRiverHesIds]);
  const relatedFacilities = useMemo(() => [...relatedHes, ...relatedDams, ...relatedStations].slice(0, 12), [relatedDams, relatedHes, relatedStations]);
  const filtered = useMemo(() => list.filter((item) => {
    const query = searchQuery.trim().toLocaleLowerCase('tr-TR');
    const majorRiverQuery = ['fırat', 'dicle', 'kızılırmak', 'sakarya', 'yeşilırmak', 'çoruh', 'seyhan', 'ceyhan'].includes(query);
    const queryMatch = majorRiverQuery && currentTab === 'hes' ? item.subtitle?.toLocaleLowerCase('tr-TR') === query : majorRiverQuery && currentTab === 'rivers' ? item.name.toLocaleLowerCase('tr-TR').includes(query) : item.sortText.toLocaleLowerCase('tr-TR').includes(query);
    const normalizedStatus = (item.status ?? '').toLocaleLowerCase('tr-TR');
    const filterMatch = currentFilter === 'all' || normalizedStatus.includes(currentFilter === 'drought' ? 'kurak' : currentFilter === 'flood' ? 'taşkın' : 'normal');
    return queryMatch && filterMatch;
  }), [currentFilter, currentTab, list, searchQuery]);
  const sorted = useMemo(() => [...filtered].sort((left, right) => {
    const direction = sortDirection === 'asc' ? 1 : -1;
    if (sortKey === 'power') return (left.powerValue - right.powerValue) * direction;
    const leftValue = sortKey === 'name' ? left.name : sortKey === 'type' ? left.typeLabel : sortKey === 'basin' ? left.basinName ?? '' : left.riverName ?? '';
    const rightValue = sortKey === 'name' ? right.name : sortKey === 'type' ? right.typeLabel : sortKey === 'basin' ? right.basinName ?? '' : right.riverName ?? '';
    return leftValue.localeCompare(rightValue, 'tr-TR') * direction;
  }), [filtered, sortDirection, sortKey]);

  const tabs: Array<{ id: TabType; label: string; icon: React.ReactNode; count: number }> = [
    { id: 'hes', label: '177 HES', icon: <Mountain className="h-4 w-4" />, count: hes177.features.length },
    { id: 'rivers', label: 'Akarsular', icon: <Waves className="h-4 w-4" />, count: rivers.features.filter((feature) => !isUnknownName(feature.properties?.riverName ?? feature.properties?.name)).length },
    { id: 'basins', label: 'Havzalar', icon: <Gauge className="h-4 w-4" />, count: basins.features.length },
  ];
  const selectionType = currentTab === 'rivers' ? 'river' : currentTab === 'hes' ? 'hes' : 'basin';
  const showFilters = currentTab === 'rivers';
  const layerControls: Array<{ key: keyof typeof layers; label: string }> = [
    { key: 'basins', label: 'Havzalar' }, { key: 'rivers', label: 'Akarsular' }, { key: 'dams', label: 'Barajlar' },
  ];
   const sortLabels: Record<SortKey, string> = { type: 'Tip', name: 'HES Adı', basin: 'Havza', river: 'Akarsu', power: 'Kurulu Güç' };
   const renderItem = (item: Item, type: string) => <button key={`${type}-${item.id}`} onClick={() => setSelectedEntity({ type, id: item.id })} className={`group mb-1 w-full rounded-lg border px-2 py-1.5 text-left transition ${isLight ? 'border-slate-200 bg-slate-50 hover:border-cyan-500/40 hover:bg-cyan-50' : 'border-transparent bg-slate-900/60 hover:border-cyan-500/30 hover:bg-slate-800/80'} ${selectedEntity?.type === type && selectedEntity.id === item.id ? 'ring-1 ring-cyan-400/70' : ''}`}>
     <div className="grid grid-cols-[2.7rem_minmax(0,1.45fr)_minmax(0,1fr)_minmax(0,1fr)_4.7rem] items-center gap-1.5">
      <span className="truncate font-mono text-[9px] uppercase text-slate-500">{item.typeLabel}</span>
      <span className={`flex min-w-0 items-center gap-1 truncate text-[11px] font-semibold ${isLight ? 'text-slate-700 group-hover:text-cyan-600' : 'text-slate-200 group-hover:text-cyan-300'}`}>{item.isProducer && <Zap className="h-3 w-3 shrink-0 text-amber-400" />}{item.name}</span>
      <span className="truncate text-[9px] text-slate-400" title={item.basinName}>{item.basinName ?? '—'}</span>
      <span className="truncate text-[9px] text-cyan-400/80" title={item.riverName}>{item.riverName ?? '—'}</span>
      <span className="truncate text-right font-mono text-[9px] text-cyan-500" title={item.metric}>{item.typeLabel === 'HES' && item.powerValue ? `${item.powerValue.toLocaleString('tr-TR')} MW` : item.metric ?? '—'}</span>
     </div>{item.typeLabel === 'Havza' && <div className="mt-2 grid grid-cols-3 gap-x-2 gap-y-1 border-t border-slate-700/20 pt-1.5 text-[8px] text-slate-500">{item.details.filter((detail) => ['Alan', 'Akarsu', 'Baraj', 'HES', 'HES ist.', 'Göl ist.', 'Ana akarsular'].includes(detail.label)).map((detail) => <span key={detail.label} className="truncate" title={detail.value}><b className="text-slate-400">{detail.label}:</b> {detail.value}</span>)}</div>}
   </button>;

  return (
    <aside className={`flex h-full min-h-0 w-full flex-col border-r shadow-2xl transition-colors ${isLight ? 'light-scrollbar border-slate-200 bg-white/95 text-slate-800' : 'border-slate-700/60 bg-slate-950/90 text-slate-100'}`}>
      <div className={`border-b p-4 ${isLight ? 'border-slate-200' : 'border-slate-800/80'}`}><div className="mb-3 flex items-center justify-between"><div><div className="flex items-center gap-2 text-sm font-bold"><Activity className="h-4 w-4 text-cyan-400" />HES & Hidroenerji</div><div className="mt-1 font-mono text-[9px] text-slate-500">TATUS · EPSG:4326 · {dataStatus === 'loading' ? 'yükleniyor' : dataStatus === 'failed' ? 'veri hatası' : 'kaynak veri'}</div></div><button onClick={() => useAppStore.getState().toggleSidebar()} className={`rounded-lg p-1.5 ${isLight ? 'text-slate-400 hover:bg-slate-100 hover:text-slate-700' : 'text-slate-500 hover:bg-slate-800 hover:text-white'}`} aria-label="Paneli kapat"><X className="h-4 w-4" /></button></div><div className="relative"><Search className={`absolute left-3 top-2.5 h-4 w-4 ${isLight ? 'text-slate-400' : 'text-slate-500'}`} /><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Katmanlarda ara..." className={`w-full rounded-xl border py-2 pl-9 pr-3 text-xs outline-none transition ${isLight ? 'border-slate-200 bg-slate-50 text-slate-700 placeholder:text-slate-400 focus:border-cyan-500/70' : 'border-slate-700 bg-slate-900/70 placeholder:text-slate-600 focus:border-cyan-500/70'}`} /></div></div>
      <div className={`grid grid-cols-4 gap-1 border-b p-2 ${isLight ? 'border-slate-200' : 'border-slate-800/80'}`}>{tabs.map((tab) => <button key={tab.id} onClick={() => setTab(tab.id)} className={`flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-[9px] transition ${currentTab === tab.id ? 'bg-cyan-500/15 text-cyan-500' : isLight ? 'text-slate-500 hover:bg-slate-100' : 'text-slate-500 hover:bg-slate-800/70 hover:text-slate-300'}`}>{tab.icon}<span className="text-center leading-3">{tab.label}</span><span className="font-mono text-[8px] opacity-70">{tab.count.toLocaleString('tr-TR')}</span></button>)}</div>
      <div className={`border-b px-3 py-2 ${isLight ? 'border-slate-200' : 'border-slate-800/80'}`}><div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-slate-500">Harita katmanları</div><div className="grid grid-cols-3 gap-1">{layerControls.map(({ key, label }) => <button key={key} onClick={() => toggleLayer(key)} className={`flex items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-[9px] transition ${layers[key] ? 'bg-cyan-500/15 text-cyan-500' : isLight ? 'bg-slate-100 text-slate-400' : 'bg-slate-900 text-slate-600'}`} aria-pressed={layers[key]}>{layers[key] ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}{label}</button>)}</div></div>
      {showFilters && <div className={`flex gap-1 overflow-x-auto border-b px-3 py-2 ${isLight ? 'border-slate-200' : 'border-slate-800/80'}`}>{[['all', 'Tümü'], ['drought', 'Kuraklık'], ['normal', 'Normal'], ['flood', 'Taşkın']].map(([value, label]) => <button key={value} onClick={() => setFilter(value as typeof currentFilter)} className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[9px] ${currentFilter === value ? isLight ? 'bg-slate-200 text-slate-700' : 'bg-slate-700 text-slate-100' : isLight ? 'text-slate-500 hover:text-slate-800' : 'text-slate-500 hover:text-slate-300'}`}>{label}</button>)}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="mb-1 flex items-center justify-between rounded-lg border border-cyan-500/15 bg-cyan-500/5 px-2 py-1.5 font-mono text-[9px] text-slate-500"><span>Kaynaklar: TATUS · GEOGLOWS · EPİAŞ</span><span>{sorted.length.toLocaleString('tr-TR')} kayıt</span></div>
        <div className={`mb-2 grid grid-cols-[2.7rem_minmax(0,1.45fr)_minmax(0,1fr)_minmax(0,1fr)_4.7rem] items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-[8px] uppercase tracking-wide text-slate-500 ${isLight ? 'bg-slate-100' : 'bg-slate-900/80'}`}>{(Object.keys(sortLabels) as SortKey[]).map((key) => <button key={key} type="button" onClick={() => { if (sortKey === key) setSortDirection((value) => value === 'asc' ? 'desc' : 'asc'); else { setSortKey(key); setSortDirection('asc'); } }} className={`truncate text-left transition hover:text-cyan-400 ${key === 'power' ? 'text-right' : ''}`} title={`${sortLabels[key]} göre sırala`}>{sortLabels[key]} {sortKey === key ? <ArrowUpDown className="inline h-3 w-3" /> : null}</button>)}</div>
        {selectedHes && <div className={`mb-3 rounded-xl border p-2 ${isLight ? 'border-cyan-200 bg-cyan-50' : 'border-cyan-500/20 bg-cyan-500/5'}`}><div className="flex items-center justify-between gap-2"><span className="truncate text-[11px] font-semibold text-cyan-400">{String(selectedHes.properties?.name ?? 'HES')}</span><span className="font-mono text-[9px] text-amber-400">{selectedHes.properties?.isProducer ? '⚡ ' : ''}{String(selectedHes.properties?.dataQuality ?? '—')}</span></div><div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[9px] text-slate-500"><span>Havza: {String(selectedHes.properties?.basinName ?? '—')}</span><span>İl: {String(selectedHes.properties?.province ?? '—')}</span><span>Güç: {numeric(selectedHes.properties?.installedPowerMw)?.toLocaleString('tr-TR') ?? '—'} MW</span><span>Debi: {numeric(selectedHes.properties?.unitFlowM3s)?.toLocaleString('tr-TR') ?? '—'} m³/sn</span><span>Min / max seviye: {numeric(selectedHes.properties?.minWaterLevelM)?.toLocaleString('tr-TR') ?? '—'} / {numeric(selectedHes.properties?.maxWaterLevelM)?.toLocaleString('tr-TR') ?? '—'} m</span><span>Min / max hacim: {numeric(selectedHes.properties?.minVolumeHm3)?.toLocaleString('tr-TR') ?? '—'} / {numeric(selectedHes.properties?.maxVolumeHm3)?.toLocaleString('tr-TR') ?? '—'} hm³</span><span>Aktif hacim: {numeric(selectedHes.properties?.activeVolumeHm3)?.toLocaleString('tr-TR') ?? '—'} hm³</span><span>Kaskat: {String(selectedHes.properties?.cascadeName ?? '—')}</span><span>Akarsu: {String(selectedHes.properties?.riverName ?? '—')}</span><span>Baraj: {String(selectedHes.properties?.damName ?? '—')}</span></div><div className="mt-2 grid grid-cols-2 gap-1"><button onClick={() => { const riverId = Array.isArray(selectedHes.properties?.riverIds) ? String(selectedHes.properties.riverIds[0] ?? '') : ''; if (riverId) setSelectedEntity({ type: 'river', id: riverId }); }} className="rounded border border-cyan-500/25 px-1.5 py-1 text-[8px] text-cyan-400">Akarsuyu Göster</button><button onClick={() => toggleCatchment(String(selectedHes.properties?.id ?? selectedHes.id ?? ''))} className="rounded border border-cyan-500/25 px-1.5 py-1 text-[8px] text-cyan-400">Su Alanını Göster</button><button onClick={() => { const cascadeId = selectedHes.properties?.cascadeToId ? String(selectedHes.properties.cascadeToId) : null; if (cascadeId) setSelectedEntity({ type: 'hes', id: cascadeId }); }} className="rounded border border-amber-500/25 px-1.5 py-1 text-[8px] text-amber-400">Kaskadı Göster</button><button onClick={() => { const basinId = String(selectedHes.properties?.basinId ?? ''); if (basinId) setSelectedEntity({ type: 'basin', id: basinId }); }} className="rounded border border-violet-500/25 px-1.5 py-1 text-[8px] text-violet-400">Havzayı Göster</button></div></div>}
        {currentTab === 'rivers' && selectedRiver && relatedFacilities.length > 0 && <div className="mb-3 rounded-xl border border-cyan-500/25 bg-cyan-500/5 p-2"><div className="mb-1 text-[10px] font-semibold text-cyan-500">{selectedRiverHesIds.size > 0 || selectedRiverRelation?.confidence === 'name/spatial' ? 'İlgili Barajlar / HES' : 'Aynı Havzadaki Tesisler'}</div><div className="mb-2 text-[9px] text-slate-500">{selectedRiverHesIds.size > 0 || selectedRiverRelation?.confidence === 'name/spatial' ? 'HES v3 nehir adı/kodu ve kontrollü coğrafi yakınlık eşleşmesi.' : 'Yalnızca basinId üzerinden eşleşen tesisler · kesin kaskad ilişkisi değildir.'}</div>{relatedFacilities.slice(0, 4).map((item) => renderItem(item, item.typeLabel === 'HES' ? 'hes' : item.typeLabel === 'Baraj/HES' && item.status === 'TATUS tesisi' ? 'station' : 'dam'))}</div>}
        {dataStatus === 'loading' && <div className="p-4 text-center text-xs text-slate-500">Gerçek TATUS verileri yükleniyor…</div>}{dataStatus !== 'loading' && !sorted.length && <div className="p-6 text-center text-xs leading-5 text-slate-500">Bu filtre için kayıt yok.<br />Kaynakta veri bulunmuyorsa sentetik kayıt gösterilmez.</div>}{sorted.map((item) => renderItem(item, selectionType))}
      </div>
      <div className={`border-t p-3 font-mono text-[9px] ${isLight ? 'border-slate-200 text-slate-500' : 'border-slate-800/80 text-slate-600'}`}><details><summary className="cursor-pointer text-slate-500">Veri Kaynakları</summary><div className="mt-2 space-y-1 leading-4">Geometri: TATUS + HydroRIVERS + OSM<br />Debi/Tahmin: GEOGLOWS / ECMWF<br />HES Teknik Veri: HES 177 v3<br />Baraj/Rezervuar: TATUS + GDW + OSM<br />Havza: TATUS</div></details><div className="mt-2">Seçim haritada otomatik yakınlaştırılır · Kaynakta olmayan alanlar gizlenir</div></div>
    </aside>
  );
};

import React, { useMemo } from 'react';
import { Activity, Droplets, Eye, EyeOff, Gauge, Mountain, Search, Waves, X, Zap } from 'lucide-react';
import { buildBasinSummaries, buildDamHesMapping, buildRiverNameMap, displayName, formatDataDate, isElectricProducer, isUnknownName, relateRiverToDams } from '../../data/hydrology';
import { getForecastTimestamps } from '../../services/hydroData';
import { useAppStore, type TabType } from '../../store/useAppStore';

type Detail = { label: string; value: string };
type Item = { id: string; name: string; subtitle?: string; metric?: string; status?: string; sourceBadge?: 'TATUS' | 'GEOGLOWS' | 'EPİAŞ'; sourceTime?: string; details: Detail[]; isProducer?: boolean };
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

function itemsFrom(collection: FeatureCollectionLike, kind: TabType, liveFlows: Map<string, { value: number; timestamp?: string }>, liveDams: Map<string, { value: number; timestamp?: string; record: Record<string, unknown> }>, generatedAt: string | undefined, riverNames: Map<string, string>, basinSummaries: Map<string, { areaKm2: number | null; riverCount: number; riverLengthKm: number; damCount: number; hesCount: number; lakeCount: number; mainRiverNames: string[] }>, damHesMapping: Map<string, { damId: string; hesIds: string[] }>): Item[] {
  return collection.features.map((feature) => {
    const properties = feature.properties ?? {};
    const id = String(properties.id ?? properties.entityId ?? feature.id ?? '');
    const entityKind = kind === 'rivers' ? 'river' : kind === 'dams' ? 'dam' : kind === 'lakes' ? 'lake' : 'basin';
    const name = kind === 'rivers' ? riverNames.get(id) ?? displayName(properties, entityKind, id) : displayName(properties, entityKind, id);
    const basin = textValue(properties, ['basinName', 'HavzaAdi', 'HAVZA_ADI', 'Havza_Id_Text']);
    const flow = kind === 'rivers' ? liveFlows.get(id) : undefined;
    const damLive = kind === 'dams' ? liveDams.get(name.toLocaleLowerCase('tr-TR')) : undefined;
    const occupancy = damLive?.value ?? firstValue(properties, ['occupancy', 'doluluk']);
    const area = firstValue(properties, ['areaKm2', 'ALAN_KM2']);
    const length = firstValue(properties, ['lengthKm']);
    const activeVolume = damLive ? firstValue(damLive.record, ['activeVolume', 'active_volume', 'hacim']) : firstValue(properties, ['activeVolume', 'active_volume']);
    const level = damLive ? firstValue(damLive.record, ['waterLevel', 'level', 'suSeviyesi']) : firstValue(properties, ['waterLevel', 'level']);
    const power = damLive ? firstValue(damLive.record, ['installedPower', 'power', 'kuruluGuc']) : firstValue(properties, ['installedPower', 'power', 'kuruluGuc']);
    const producer = kind === 'dams' && isElectricProducer(properties, damHesMapping.has(id)) || Boolean(damLive && isElectricProducer(damLive.record));
    const sourceBadge: Item['sourceBadge'] = flow ? 'GEOGLOWS' : damLive ? 'EPİAŞ' : undefined;
    const sourceTime = flow?.timestamp ?? damLive?.timestamp ?? generatedAt;
    const details: Detail[] = [];
    if (basin) details.push({ label: 'Havza', value: basin });
    if (kind === 'rivers') {
      if (length !== null) details.push({ label: 'Uzunluk', value: `${length.toLocaleString('tr-TR')} km` });
      details.push({ label: 'GEOGLOWS', value: flow ? `${flow.value.toLocaleString('tr-TR')} m³/s` : 'Tahmin yok' });
      details.push({ label: 'Durum', value: flow ? 'Gerçek zaman serisi' : String(properties.status ?? 'veri yok') });
    } else if (kind === 'dams') {
      if (occupancy !== null) details.push({ label: 'Doluluk', value: `%${Math.round(occupancy)}` });
      if (activeVolume !== null) details.push({ label: 'Aktif hacim', value: activeVolume.toLocaleString('tr-TR') });
      if (level !== null) details.push({ label: 'Su seviyesi', value: level.toLocaleString('tr-TR') });
      if (power !== null) details.push({ label: 'Kurulu güç', value: power.toLocaleString('tr-TR') });
      details.push({ label: 'Tip', value: producer ? 'Elektrik üretimi doğrulandı' : 'Baraj / HES niteliği yok' });
    } else if (kind === 'lakes') {
      if (area !== null) details.push({ label: 'Alan', value: `${area.toLocaleString('tr-TR')} km²` });
      details.push({ label: 'Gözlem', value: String(properties.status ?? 'veri yok') });
    } else {
      const summary = basinSummaries.get(String(properties.basinId ?? properties.HAVZA_ID ?? id));
      if (summary) {
        if (summary.areaKm2 !== null) details.push({ label: 'Alan', value: `${summary.areaKm2.toLocaleString('tr-TR')} km²` });
        details.push({ label: 'Akarsu', value: `${summary.riverCount} · ${summary.riverLengthKm.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} km` });
        details.push({ label: 'Baraj', value: String(summary.damCount) });
        details.push({ label: 'HES ist.', value: String(summary.hesCount) });
        details.push({ label: 'Göl ist.', value: String(summary.lakeCount) });
        if (summary.mainRiverNames.length) details.push({ label: 'Ana akarsular', value: summary.mainRiverNames.join(', ') });
      }
    }
    const metric = kind === 'rivers' && flow ? `${flow.value.toLocaleString('tr-TR')} m³/s` : kind === 'dams' && occupancy !== null ? `%${Math.round(occupancy)}` : kind === 'lakes' || kind === 'basins' ? area !== null ? `${Math.round(area).toLocaleString('tr-TR')} km²` : undefined : undefined;
    const status = kind === 'rivers' ? flow ? 'GEOGLOWS tahmin mevcut' : 'GEOGLOWS tahmini yok' : kind === 'dams' ? damLive ? 'EPİAŞ verisi mevcut' : 'EPİAŞ doluluk verisi yok' : String(properties.status ?? 'veri yok');
    return { id, name, subtitle: basin, metric, status, sourceBadge, sourceTime, details, isProducer: producer };
  }).filter((item) => item.id && item.name);
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
  const toggleLayer = useAppStore((s) => s.toggleLayer);
  const layers = useAppStore((s) => s.layers);
  const rivers = useAppStore((s) => s.rivers);
  const dams = useAppStore((s) => s.damStations);
  const hesStations = useAppStore((s) => s.hesStations);
  const lakes = useAppStore((s) => s.lakes);
  const basins = useAppStore((s) => s.basins);
  const geoglows = useAppStore((s) => s.geoglows);
  const epias = useAppStore((s) => s.epias);
  const manifest = useAppStore((s) => s.dataManifest);
  const timelineIndex = useAppStore((s) => s.timelineIndex);
  const dataStatus = useAppStore((s) => s.hydroDataStatus);
  const isLight = theme === 'light';

  const riverNameMap = useMemo(() => buildRiverNameMap(rivers), [rivers]);
  const damHesMapping = useMemo(() => buildDamHesMapping(dams, hesStations), [dams, hesStations]);
  const basinSummaries = useMemo(() => buildBasinSummaries(basins, rivers, dams, hesStations, lakes, riverNameMap), [basins, dams, hesStations, lakes, riverNameMap, rivers]);

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

  const source = currentTab === 'rivers' ? rivers : currentTab === 'dams' ? dams : currentTab === 'lakes' ? lakes : basins;
  const list = useMemo(() => itemsFrom(source, currentTab, liveMaps.flowMap, liveMaps.damMap, manifest?.generatedAt, riverNameMap, basinSummaries, damHesMapping), [basinSummaries, currentTab, damHesMapping, liveMaps, manifest?.generatedAt, riverNameMap, source]);
  const selectedRiver = selectedEntity?.type === 'river' ? rivers.features.find((feature) => String(feature.properties?.id ?? feature.id ?? '') === selectedEntity.id) : null;
  const selectedRiverRelation = useMemo(() => selectedRiver ? relateRiverToDams({ ...selectedRiver, properties: { ...selectedRiver.properties, riverName: riverNameMap.get(String(selectedRiver.properties?.id ?? selectedRiver.id ?? '')) } }, dams, hesStations, damHesMapping) : null, [damHesMapping, dams, hesStations, riverNameMap, selectedRiver]);
  const relatedDams = useMemo(() => {
    if (!selectedRiverRelation) return [];
    const related = dams.features.filter((feature) => selectedRiverRelation.ids.has(String(feature.properties?.id ?? feature.properties?.entityId ?? feature.id ?? '')));
    return itemsFrom({ features: related }, 'dams', liveMaps.flowMap, liveMaps.damMap, manifest?.generatedAt, riverNameMap, basinSummaries, damHesMapping).slice(0, 12);
  }, [basinSummaries, damHesMapping, dams.features, liveMaps, manifest?.generatedAt, riverNameMap, selectedRiverRelation]);
  const filtered = useMemo(() => list.filter((item) => {
    const queryMatch = `${item.name} ${item.subtitle ?? ''}`.toLocaleLowerCase('tr-TR').includes(searchQuery.toLocaleLowerCase('tr-TR'));
    const normalizedStatus = (item.status ?? '').toLocaleLowerCase('tr-TR');
    const filterMatch = currentFilter === 'all' || normalizedStatus.includes(currentFilter === 'drought' ? 'kurak' : currentFilter === 'flood' ? 'taşkın' : 'normal');
    return queryMatch && filterMatch;
  }), [currentFilter, list, searchQuery]);

  const tabs: Array<{ id: TabType; label: string; icon: React.ReactNode; count: number }> = [
    { id: 'rivers', label: 'Akarsular', icon: <Waves className="h-4 w-4" />, count: rivers.features.length },
    { id: 'dams', label: 'Barajlar / HES', icon: <Mountain className="h-4 w-4" />, count: dams.features.length },
    { id: 'lakes', label: 'Göller', icon: <Droplets className="h-4 w-4" />, count: lakes.features.length },
    { id: 'basins', label: 'Havzalar', icon: <Gauge className="h-4 w-4" />, count: basins.features.length },
  ];
  const selectionType = currentTab === 'rivers' ? 'river' : currentTab === 'dams' ? 'dam' : currentTab === 'lakes' ? 'lake' : 'basin';
  const showFilters = currentTab === 'rivers' || (currentTab === 'dams' && Boolean(epias?.records?.length));
  const layerControls: Array<{ key: keyof typeof layers; label: string }> = [
    { key: 'basins', label: 'Havzalar' }, { key: 'rivers', label: 'Akarsular' }, { key: 'flowStations', label: 'Akım ist.' },
    { key: 'hesStations', label: 'HES ist.' }, { key: 'dams', label: 'Barajlar' }, { key: 'lakes', label: 'Göller' },
  ];
  const renderItem = (item: Item, type: string) => <button key={`${type}-${item.id}`} onClick={() => setSelectedEntity({ type, id: item.id })} className={`group mb-1.5 w-full rounded-xl border p-3 text-left transition ${isLight ? 'border-slate-200 bg-slate-50 hover:border-cyan-500/40 hover:bg-cyan-50' : 'border-transparent bg-slate-900/60 hover:border-cyan-500/30 hover:bg-slate-800/80'} ${selectedEntity?.type === type && selectedEntity.id === item.id ? 'ring-1 ring-cyan-400/70' : ''}`}>
    <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className={`flex items-center gap-1 truncate text-xs font-semibold ${isLight ? 'text-slate-700 group-hover:text-cyan-600' : 'text-slate-200 group-hover:text-cyan-300'}`}>{item.isProducer && <Zap className="h-3 w-3 shrink-0 text-amber-400" />}{item.name}</div>{item.subtitle && <div className="mt-1 truncate font-mono text-[9px] text-slate-500">{item.subtitle}</div>}</div>{item.metric && <span className="whitespace-nowrap font-mono text-[10px] text-cyan-500">{item.metric}</span>}</div>
    <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1">{item.details.slice(0, type === 'basin' ? 10 : 4).map((detail) => <div key={detail.label} className="min-w-0"><div className="font-mono text-[8px] uppercase tracking-wide text-slate-500">{detail.label}</div><div className={`truncate text-[10px] ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>{detail.value}</div></div>)}</div>
    <div className="mt-2 flex items-center justify-between gap-2 truncate font-mono text-[9px] text-slate-500"><span>{item.sourceBadge && <span className="mr-1 rounded bg-cyan-500/10 px-1 text-cyan-500">{item.sourceBadge}</span>}{item.status}</span><span>{formatDataDate(item.sourceTime)}</span></div>
  </button>;

  return (
    <aside className={`flex h-full min-h-0 w-full flex-col border-r shadow-2xl transition-colors ${isLight ? 'light-scrollbar border-slate-200 bg-white/95 text-slate-800' : 'border-slate-700/60 bg-slate-950/90 text-slate-100'}`}>
      <div className={`border-b p-4 ${isLight ? 'border-slate-200' : 'border-slate-800/80'}`}><div className="mb-3 flex items-center justify-between"><div><div className="flex items-center gap-2 text-sm font-bold"><Activity className="h-4 w-4 text-cyan-400" />Hidroloji katmanları</div><div className="mt-1 font-mono text-[9px] text-slate-500">TATUS · EPSG:4326 · {dataStatus === 'loading' ? 'yükleniyor' : dataStatus === 'failed' ? 'veri hatası' : 'kaynak veri'}</div></div><button onClick={() => useAppStore.getState().toggleSidebar()} className={`rounded-lg p-1.5 ${isLight ? 'text-slate-400 hover:bg-slate-100 hover:text-slate-700' : 'text-slate-500 hover:bg-slate-800 hover:text-white'}`} aria-label="Paneli kapat"><X className="h-4 w-4" /></button></div><div className="relative"><Search className={`absolute left-3 top-2.5 h-4 w-4 ${isLight ? 'text-slate-400' : 'text-slate-500'}`} /><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Katmanlarda ara..." className={`w-full rounded-xl border py-2 pl-9 pr-3 text-xs outline-none transition ${isLight ? 'border-slate-200 bg-slate-50 text-slate-700 placeholder:text-slate-400 focus:border-cyan-500/70' : 'border-slate-700 bg-slate-900/70 placeholder:text-slate-600 focus:border-cyan-500/70'}`} /></div></div>
      <div className={`grid grid-cols-4 gap-1 border-b p-2 ${isLight ? 'border-slate-200' : 'border-slate-800/80'}`}>{tabs.map((tab) => <button key={tab.id} onClick={() => setTab(tab.id)} className={`flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-[9px] transition ${currentTab === tab.id ? 'bg-cyan-500/15 text-cyan-500' : isLight ? 'text-slate-500 hover:bg-slate-100' : 'text-slate-500 hover:bg-slate-800/70 hover:text-slate-300'}`}>{tab.icon}<span className="text-center leading-3">{tab.label}</span><span className="font-mono text-[8px] opacity-70">{tab.count.toLocaleString('tr-TR')}</span></button>)}</div>
      <div className={`border-b px-3 py-2 ${isLight ? 'border-slate-200' : 'border-slate-800/80'}`}><div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-slate-500">Harita katmanları</div><div className="grid grid-cols-3 gap-1">{layerControls.map(({ key, label }) => <button key={key} onClick={() => toggleLayer(key)} className={`flex items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-[9px] transition ${layers[key] ? 'bg-cyan-500/15 text-cyan-500' : isLight ? 'bg-slate-100 text-slate-400' : 'bg-slate-900 text-slate-600'}`} aria-pressed={layers[key]}>{layers[key] ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}{label}</button>)}</div></div>
      {showFilters && <div className={`flex gap-1 overflow-x-auto border-b px-3 py-2 ${isLight ? 'border-slate-200' : 'border-slate-800/80'}`}>{[['all', 'Tümü'], ['drought', 'Kuraklık'], ['normal', 'Normal'], ['flood', 'Taşkın']].map(([value, label]) => <button key={value} onClick={() => setFilter(value as typeof currentFilter)} className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[9px] ${currentFilter === value ? isLight ? 'bg-slate-200 text-slate-700' : 'bg-slate-700 text-slate-100' : isLight ? 'text-slate-500 hover:text-slate-800' : 'text-slate-500 hover:text-slate-300'}`}>{label}</button>)}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto p-2"><div className="mb-2 flex items-center justify-between rounded-lg border border-cyan-500/15 bg-cyan-500/5 px-2 py-1.5 font-mono text-[9px] text-slate-500"><span>Kaynaklar: TATUS · GEOGLOWS · EPİAŞ</span><span>{filtered.length.toLocaleString('tr-TR')} kayıt</span></div>{currentTab === 'rivers' && selectedRiver && relatedDams.length > 0 && <div className="mb-3 rounded-xl border border-cyan-500/25 bg-cyan-500/5 p-2"><div className="mb-1 text-[10px] font-semibold text-cyan-500">{selectedRiverRelation?.confidence === 'name/spatial' ? 'İlgili Barajlar / HES' : 'Aynı Havzadaki Tesisler'}</div><div className="mb-2 text-[9px] text-slate-500">{selectedRiverRelation?.confidence === 'name/spatial' ? 'İsim ve/veya coğrafi yakınlıkla eşleşen tesisler · kesin kaskad ilişkisi değildir.' : 'Yalnızca basinId üzerinden eşleşen tesisler · kesin kaskad ilişkisi değildir.'}</div>{relatedDams.slice(0, 4).map((item) => renderItem(item, 'dam'))}</div>}{dataStatus === 'loading' && <div className="p-4 text-center text-xs text-slate-500">Gerçek TATUS verileri yükleniyor…</div>}{dataStatus !== 'loading' && !filtered.length && <div className="p-6 text-center text-xs leading-5 text-slate-500">Bu filtre için kayıt yok.<br />Kaynakta veri bulunmuyorsa sentetik kayıt gösterilmez.</div>}{filtered.map((item) => renderItem(item, selectionType))}</div>
      <div className={`border-t p-3 font-mono text-[9px] ${isLight ? 'border-slate-200 text-slate-500' : 'border-slate-800/80 text-slate-600'}`}>Seçim haritada otomatik yakınlaştırılır · Kaynak veride olmayan alanlar gizlenir</div>
    </aside>
  );
};

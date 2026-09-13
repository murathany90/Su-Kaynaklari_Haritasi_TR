import React, { useMemo } from 'react';
import { Activity, Droplets, Eye, EyeOff, Gauge, Mountain, Search, Waves, X } from 'lucide-react';
import { formatDataDate } from '../../data/hydrology';
import { getForecastTimestamps } from '../../services/hydroData';
import { useAppStore, type TabType } from '../../store/useAppStore';

type Item = { id: string; name: string; subtitle?: string; metric?: string; status?: string; source: string };

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(result) ? result : null;
}

function liveValue(record: unknown): number | null {
  if (!record || typeof record !== 'object') return null;
  const value = record as Record<string, unknown>;
  for (const key of ['flow_median', 'flow', 'discharge', 'streamflow', 'value']) {
    const result = numeric(value[key]);
    if (result !== null) return result;
  }
  return null;
}

function itemsFrom(
  collection: { features: Array<{ id?: string | number; properties?: Record<string, unknown> | null }> },
  kind: TabType,
  liveFlows: Map<string, { value: number; timestamp?: string }>,
  liveDams: Map<string, { value: number; timestamp?: string }>,
  generatedAt: string | undefined,
): Item[] {
  return collection.features.map((feature) => {
    const p: Record<string, unknown> = feature.properties ?? {};
    const id = String(p.id ?? p.entityId ?? feature.id ?? '');
    const name = String(p.name ?? p.damName ?? p.ISTADI ?? p.adi ?? p.riverCode ?? p.stationId ?? id);
    const area = numeric(p.areaKm2);
    const live = kind === 'rivers' ? liveFlows.get(id) : kind === 'dams' ? liveDams.get(name.toLocaleLowerCase('tr-TR')) : undefined;
    const flow = live?.value ?? numeric(p.flow);
    const occupancy = live?.value ?? numeric(p.occupancy);
    const metric = kind === 'rivers' && flow !== null ? `${flow.toLocaleString('tr-TR')} m³/s` : kind === 'dams' && occupancy !== null ? `%${Math.round(occupancy)} doluluk` : (kind === 'lakes' || kind === 'basins') && area !== null ? `${Math.round(area).toLocaleString('tr-TR')} km²` : undefined;
    const source = live?.timestamp ? `GEOGLOWS · ${formatDataDate(live.timestamp)}` : kind === 'dams' ? 'EPİAŞ · veri yok' : `TATUS GIS · ${formatDataDate(generatedAt)}`;
    const status = live ? 'Gerçek zaman serisi' : kind === 'rivers' ? 'GEOGLOWS tahmini yok' : p.status ? String(p.status) : undefined;
    return { id, name, subtitle: String(p.basinName ?? p.HavzaAdi ?? p.riverCode ?? ''), metric, status, source };
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
  const setSelectedEntity = useAppStore((s) => s.setSelectedEntity);
  const toggleLayer = useAppStore((s) => s.toggleLayer);
  const layers = useAppStore((s) => s.layers);
  const rivers = useAppStore((s) => s.rivers);
  const dams = useAppStore((s) => s.damStations);
  const lakes = useAppStore((s) => s.lakes);
  const basins = useAppStore((s) => s.basins);
  const geoglows = useAppStore((s) => s.geoglows);
  const epias = useAppStore((s) => s.epias);
  const manifest = useAppStore((s) => s.dataManifest);
  const timelineIndex = useAppStore((s) => s.timelineIndex);
  const dataStatus = useAppStore((s) => s.hydroDataStatus);
  const isLight = theme === 'light';

  const liveMaps = useMemo(() => {
    const timestamps = getForecastTimestamps(geoglows);
    const timestamp = timestamps[timelineIndex];
    const flowMap = new Map<string, { value: number; timestamp?: string }>();
    (geoglows?.records ?? []).forEach((record) => {
      const rows = Array.isArray(record.data) ? record.data : [];
      const row = rows.find((candidate) => !timestamp || (candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).datetime === timestamp));
      const value = liveValue(row);
      if (value !== null && record.localRiverId) flowMap.set(String(record.localRiverId), { value, timestamp: row && typeof row === 'object' ? String((row as Record<string, unknown>).datetime ?? '') : undefined });
    });
    const damMap = new Map<string, { value: number; timestamp?: string }>();
    (epias?.records ?? []).forEach((record) => {
      const value = numeric(record.occupancy ?? record.fullness ?? record.activeFullness ?? record.doluluk);
      const name = record.damName ?? record.name;
      if (value !== null && name) damMap.set(String(name).toLocaleLowerCase('tr-TR'), { value, timestamp: record.datetime ? String(record.datetime) : undefined });
    });
    return { flowMap, damMap };
  }, [epias?.records, geoglows, timelineIndex]);

  const source = currentTab === 'rivers' ? rivers : currentTab === 'dams' ? dams : currentTab === 'lakes' ? lakes : basins;
  const list = useMemo(() => itemsFrom(source, currentTab, liveMaps.flowMap, liveMaps.damMap, manifest?.generatedAt), [currentTab, liveMaps, manifest?.generatedAt, source]);
  const filtered = useMemo(() => list.filter((item) => {
    const queryMatch = `${item.name} ${item.subtitle ?? ''}`.toLocaleLowerCase('tr-TR').includes(searchQuery.toLocaleLowerCase('tr-TR'));
    const normalizedStatus = (item.status ?? '').toLocaleLowerCase('tr-TR');
    const filterMatch = currentFilter === 'all' || normalizedStatus.includes(currentFilter === 'drought' ? 'kurak' : currentFilter === 'flood' ? 'taşkın' : 'normal');
    return queryMatch && filterMatch;
  }), [currentFilter, list, searchQuery]);

  const tabs: Array<{ id: TabType; label: string; icon: React.ReactNode; count: number }> = [
    { id: 'rivers', label: 'Akarsular', icon: <Waves className="h-4 w-4" />, count: rivers.features.length },
    { id: 'dams', label: 'Kaskad HES', icon: <Mountain className="h-4 w-4" />, count: dams.features.length },
    { id: 'lakes', label: 'Göller', icon: <Droplets className="h-4 w-4" />, count: lakes.features.length },
    { id: 'basins', label: 'Havzalar', icon: <Gauge className="h-4 w-4" />, count: basins.features.length },
  ];
  const selectionType = currentTab === 'rivers' ? 'river' : currentTab === 'dams' ? 'dam' : currentTab === 'lakes' ? 'lake' : 'basin';
  const layerControls: Array<{ key: keyof typeof layers; label: string }> = [
    { key: 'basins', label: 'Havzalar' }, { key: 'rivers', label: 'Akarsular' }, { key: 'flowStations', label: 'Akım ist.' },
    { key: 'hesStations', label: 'HES ist.' }, { key: 'dams', label: 'Barajlar' }, { key: 'lakes', label: 'Göller' },
  ];

  return (
    <aside className={`flex h-full min-h-0 w-full flex-col border-r shadow-2xl transition-colors ${isLight ? 'light-scrollbar border-slate-200 bg-white/95 text-slate-800' : 'border-slate-700/60 bg-slate-950/90 text-slate-100'}`}>
      <div className={`border-b p-4 ${isLight ? 'border-slate-200' : 'border-slate-800/80'}`}>
        <div className="mb-3 flex items-center justify-between"><div><div className="flex items-center gap-2 text-sm font-bold"><Activity className="h-4 w-4 text-cyan-400" />Hidroloji katmanları</div><div className={`mt-1 font-mono text-[9px] ${isLight ? 'text-slate-500' : 'text-slate-500'}`}>TATUS · EPSG:4326 · {dataStatus === 'loading' ? 'yükleniyor' : dataStatus === 'failed' ? 'veri hatası' : 'kaynak veri'}</div></div><button onClick={() => useAppStore.getState().toggleSidebar()} className={`rounded-lg p-1.5 ${isLight ? 'text-slate-400 hover:bg-slate-100 hover:text-slate-700' : 'text-slate-500 hover:bg-slate-800 hover:text-white'}`} aria-label="Paneli kapat"><X className="h-4 w-4" /></button></div>
        <div className="relative"><Search className={`absolute left-3 top-2.5 h-4 w-4 ${isLight ? 'text-slate-400' : 'text-slate-500'}`} /><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Katmanlarda ara..." className={`w-full rounded-xl border py-2 pl-9 pr-3 text-xs outline-none transition ${isLight ? 'border-slate-200 bg-slate-50 text-slate-700 placeholder:text-slate-400 focus:border-cyan-500/70' : 'border-slate-700 bg-slate-900/70 placeholder:text-slate-600 focus:border-cyan-500/70'}`} /></div>
      </div>
      <div className={`grid grid-cols-4 gap-1 border-b p-2 ${isLight ? 'border-slate-200' : 'border-slate-800/80'}`}>{tabs.map((tab) => <button key={tab.id} onClick={() => setTab(tab.id)} className={`flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-[9px] transition ${currentTab === tab.id ? 'bg-cyan-500/15 text-cyan-500' : isLight ? 'text-slate-500 hover:bg-slate-100' : 'text-slate-500 hover:bg-slate-800/70 hover:text-slate-300'}`}>{tab.icon}<span>{tab.label}</span><span className="font-mono text-[8px] opacity-70">{tab.count.toLocaleString('tr-TR')}</span></button>)}</div>
      <div className={`border-b px-3 py-2 ${isLight ? 'border-slate-200' : 'border-slate-800/80'}`}><div className={`mb-1 font-mono text-[9px] uppercase tracking-wider ${isLight ? 'text-slate-400' : 'text-slate-600'}`}>Harita katmanları</div><div className="grid grid-cols-3 gap-1">{layerControls.map(({ key, label }) => <button key={key} onClick={() => toggleLayer(key)} className={`flex items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-[9px] transition ${layers[key] ? 'bg-cyan-500/15 text-cyan-500' : isLight ? 'bg-slate-100 text-slate-400' : 'bg-slate-900 text-slate-600'}`} aria-pressed={layers[key]}>{layers[key] ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}{label}</button>)}</div></div>
      <div className={`flex gap-1 overflow-x-auto border-b px-3 py-2 ${isLight ? 'border-slate-200' : 'border-slate-800/80'}`}>{[['all', 'Tümü'], ['drought', 'Kuraklık'], ['normal', 'Normal'], ['flood', 'Taşkın']].map(([value, label]) => <button key={value} onClick={() => setFilter(value as typeof currentFilter)} className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[9px] ${currentFilter === value ? isLight ? 'bg-slate-200 text-slate-700' : 'bg-slate-700 text-slate-100' : isLight ? 'text-slate-500 hover:text-slate-800' : 'text-slate-500 hover:text-slate-300'}`}>{label}</button>)}</div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">{dataStatus === 'loading' && <div className="p-4 text-center text-xs text-slate-500">Gerçek TATUS verileri yükleniyor…</div>}{dataStatus !== 'loading' && !filtered.length && <div className="p-6 text-center text-xs leading-5 text-slate-500">Bu filtre için kayıt yok.<br />Kaynakta veri bulunmuyorsa sentetik kayıt gösterilmez.</div>}{filtered.map((item) => <button key={item.id} onClick={() => setSelectedEntity({ type: selectionType, id: item.id })} className={`group mb-1.5 w-full rounded-xl border p-3 text-left transition ${isLight ? 'border-slate-200 bg-slate-50 hover:border-cyan-500/40 hover:bg-cyan-50' : 'border-transparent bg-slate-900/60 hover:border-cyan-500/30 hover:bg-slate-800/80'}`}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className={`truncate text-xs font-semibold ${isLight ? 'text-slate-700 group-hover:text-cyan-600' : 'text-slate-200 group-hover:text-cyan-300'}`}>{item.name}</div>{item.subtitle && <div className="mt-1 truncate font-mono text-[9px] text-slate-500">{item.subtitle}</div>}</div>{item.metric && <span className="whitespace-nowrap font-mono text-[10px] text-cyan-500">{item.metric}</span>}</div><div className={`mt-2 flex items-center justify-between gap-2 truncate font-mono text-[9px] ${isLight ? 'text-slate-500' : 'text-slate-500'}`}><span>{item.status ?? 'Durum yok'}</span><span>{item.source}</span></div></button>)}</div>
      <div className={`border-t p-3 font-mono text-[9px] ${isLight ? 'border-slate-200 text-slate-500' : 'border-slate-800/80 text-slate-600'}`}>Seçim haritada otomatik yakınlaştırılır · {filtered.length.toLocaleString('tr-TR')} kayıt</div>
    </aside>
  );
};

import React, { useMemo, useState } from 'react';
import { Activity, ArrowUpDown, Eye, EyeOff, Gauge, Mountain, Search, Waves, X, Zap } from 'lucide-react';
import { getHesFullnessMeta } from '../../data/hydrology';
import { useAppStore, type TabType } from '../../store/useAppStore';

type SortKey = 'type' | 'name' | 'basin' | 'river' | 'power' | 'fullness' | 'source' | 'count' | 'forecast' | 'cascade';
type FullnessSource = 'E' | 'H' | 'M' | '—';
type Row = {
  id: string;
  type: 'hes' | 'river' | 'basin';
  name: string;
  basin: string;
  river: string;
  power: number;
  fullness: number | null;
  source: FullnessSource;
  count: number;
  forecast: boolean;
  cascadeCount: number;
  riverNames: string;
  details?: Record<string, unknown>;
};

type Column = { key: SortKey; label: string; className?: string; value: (row: Row) => React.ReactNode };

function numberOf(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMw(value: number): string {
  return `${Math.round(value).toLocaleString('tr-TR')} MW`;
}

function weightedFullness(rows: Array<{ power: number; fullness: number | null }>): number | null {
  const eligible = rows.filter((row) => row.fullness !== null && row.power > 0);
  const weight = eligible.reduce((sum, row) => sum + row.power, 0);
  return weight ? eligible.reduce((sum, row) => sum + (row.fullness ?? 0) * row.power, 0) / weight : null;
}

function sourceFor(rows: Array<{ source: FullnessSource; fullness: number | null }>): FullnessSource {
  if (!rows.some((row) => row.fullness !== null)) return '—';
  if (rows.some((row) => row.source === 'E')) return 'E';
  if (rows.some((row) => row.source === 'H')) return 'H';
  return rows.some((row) => row.source === 'M') ? 'M' : '—';
}

function fullnessCell(row: Row): React.ReactNode {
  if (row.fullness === null) return '—';
  const sourceLabel = row.source === 'E' ? 'EPİAŞ doğrulanmış değer' : row.source === 'H' ? 'Aktif hacimden hesaplanan değer' : 'Kontrollü MOCK senaryosu';
  return <span title={sourceLabel}>{`%${Math.round(row.fullness)} ${row.source}`}</span>;
}

function isValidRiver(value: unknown): value is string {
  const normalized = String(value ?? '').trim().toLocaleLowerCase('tr-TR');
  return Boolean(normalized && !['—', 'bilinmiyor', 'akarsu adı doğrulanamadı'].includes(normalized));
}

export const Sidebar: React.FC = () => {
  const theme = useAppStore((s) => s.theme);
  const currentTab = useAppStore((s) => s.currentTab);
  const setTab = useAppStore((s) => s.setTab);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const selectedEntity = useAppStore((s) => s.selectedEntity);
  const setSelectedEntity = useAppStore((s) => s.setSelectedEntity);
  const toggleCatchment = useAppStore((s) => s.toggleCatchment);
  const toggleLayer = useAppStore((s) => s.toggleLayer);
  const layers = useAppStore((s) => s.layers);
  const rivers = useAppStore((s) => s.rivers);
  const hes = useAppStore((s) => s.hes177);
  const basins = useAppStore((s) => s.basins);
  const geoglows = useAppStore((s) => s.geoglows);
  const epias = useAppStore((s) => s.epias);
  const dataMode = useAppStore((s) => s.dataMode);
  const dataStatus = useAppStore((s) => s.hydroDataStatus);
  const isLight = theme === 'light';
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const epiasByHes = useMemo(() => new Map(hes.features.flatMap((feature) => {
    const properties = feature.properties ?? {};
    const id = String(properties.id ?? feature.id ?? '');
    const names = [properties.damName, properties.name].filter(Boolean).map((value) => String(value).toLocaleLowerCase('tr-TR'));
    const record = (epias?.records ?? []).find((candidate) => {
      const ids = [candidate.hesId, candidate.hesID, candidate.entityId].filter(Boolean).map(String);
      const recordNames = [candidate.damName, candidate.dam_name, candidate.name].filter(Boolean).map((value) => String(value).toLocaleLowerCase('tr-TR'));
      return ids.includes(id) || recordNames.some((name) => names.includes(name));
    });
    return record ? [[id, record] as const] : [];
  })), [epias?.records, hes.features]);

  const hesRows = useMemo<Row[]>(() => hes.features.map((feature) => {
    const properties = feature.properties ?? {};
    const id = String(properties.id ?? feature.id ?? '');
    const fullness = getHesFullnessMeta(id, dataMode, epiasByHes.get(id), properties);
    return {
      id, type: 'hes' as const, name: String(properties.name ?? 'HES'), basin: String(properties.displayBasinName ?? properties.basinName ?? '—'), river: isValidRiver(properties.riverName) ? String(properties.riverName) : '—', power: numberOf(properties.installedPowerMw) ?? 0,
      fullness: fullness.value, source: fullness.source, count: 1, forecast: false, cascadeCount: Number(Boolean(properties.cascadeToId)) + (Array.isArray(properties.cascadeFromIds) ? properties.cascadeFromIds.length : 0), riverNames: '', details: properties,
    };
  }), [dataMode, epiasByHes, hes.features]);

  const hesById = useMemo(() => new Map(hesRows.map((row) => [row.id, row])), [hesRows]);
  const basinLabels = useMemo(() => new Map(basins.features.map((feature) => [String(feature.properties?.basinId ?? feature.properties?.ID ?? feature.id ?? ''), String(feature.properties?.name ?? feature.properties?.HAVZA_ADI ?? 'Havza')])), [basins.features]);

  const riverRows = useMemo<Row[]>(() => rivers.features.map((feature) => {
    const properties = feature.properties ?? {};
    const id = String(properties.id ?? feature.id ?? '');
    const members = (Array.isArray(properties.hesIds) ? properties.hesIds : []).map(String).map((hesId) => hesById.get(hesId)).filter((row): row is Row => Boolean(row));
    const localIds = Array.isArray(properties.geoglowsLocalRiverIds) ? properties.geoglowsLocalRiverIds.map(String) : [];
    const forecast = (geoglows?.records ?? []).some((record) => localIds.includes(String(record.localRiverId ?? '')) && Array.isArray(record.data) && record.data.length > 1);
    const displayBasins = [...new Set(members.map((row) => row.basin).filter((name) => name !== '—'))];
    return {
      id, type: 'river' as const, name: String(properties.riverName ?? properties.name ?? 'Akarsu'), basin: displayBasins.join(' / ') || basinLabels.get(String(properties.basinId ?? '')) || '—', river: String(properties.riverName ?? properties.name ?? 'Akarsu'),
      power: members.reduce((sum, row) => sum + row.power, 0), fullness: weightedFullness(members), source: sourceFor(members), count: members.length, forecast, cascadeCount: 0, riverNames: '', details: properties,
    };
  }).filter((row) => row.count > 0), [basinLabels, geoglows?.records, hesById, rivers.features]);

  const basinRows = useMemo<Row[]>(() => basins.features.map((feature) => {
    const properties = feature.properties ?? {};
    const id = String(properties.basinId ?? properties.HAVZA_ID ?? properties.ID ?? feature.id ?? '');
    const members = hesRows.filter((row) => String(row.details?.basinId ?? '') === id);
    const riverNames = [...new Set(members.map((row) => row.river).filter((name) => name !== '—'))];
    return {
      id, type: 'basin' as const, name: String(properties.name ?? properties.HAVZA_ADI ?? 'Havza'), basin: String(properties.name ?? properties.HAVZA_ADI ?? 'Havza'), river: '', power: members.reduce((sum, row) => sum + row.power, 0),
      fullness: weightedFullness(members), source: sourceFor(members), count: members.length, forecast: false, cascadeCount: members.reduce((sum, row) => sum + row.cascadeCount, 0), riverNames: riverNames.slice(0, 3).join(', ') || '—', details: properties,
    };
  }).filter((row) => row.count > 0), [basins.features, hesRows]);

  const rows = currentTab === 'hes' ? hesRows : currentTab === 'rivers' ? riverRows : basinRows;
  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase('tr-TR');
    if (!query) return rows;
    return rows.filter((row) => `${row.name} ${row.basin} ${row.river} ${row.riverNames}`.toLocaleLowerCase('tr-TR').includes(query));
  }, [rows, searchQuery]);
  const sortedRows = useMemo(() => [...filteredRows].sort((left, right) => {
    const direction = sortDirection === 'asc' ? 1 : -1;
    const numericKeys: SortKey[] = ['power', 'fullness', 'count', 'cascade'];
    if (numericKeys.includes(sortKey)) {
      const numeric = (row: Row) => sortKey === 'power' ? row.power : sortKey === 'fullness' ? row.fullness ?? -1 : sortKey === 'count' ? row.count : row.cascadeCount;
      return (numeric(left) - numeric(right)) * direction;
    }
    if (sortKey === 'forecast') return (Number(left.forecast) - Number(right.forecast)) * direction;
    const leftValue = sortKey === 'type' ? left.type : sortKey === 'name' ? left.name : sortKey === 'basin' ? left.basin : sortKey === 'river' ? left.river : sortKey === 'source' ? left.source : left.name;
    const rightValue = sortKey === 'type' ? right.type : sortKey === 'name' ? right.name : sortKey === 'basin' ? right.basin : sortKey === 'river' ? right.river : sortKey === 'source' ? right.source : right.name;
    return leftValue.localeCompare(rightValue, 'tr-TR') * direction;
  }), [filteredRows, sortDirection, sortKey]);

  const columns = useMemo<Column[]>(() => currentTab === 'hes' ? [
    { key: 'name', label: 'HES adı', value: (row) => <span className="flex min-w-0 items-center gap-1"><Zap className="h-3 w-3 shrink-0 text-amber-400" />{row.name}</span> }, { key: 'basin', label: 'Havza', value: (row) => row.basin }, { key: 'river', label: 'Akarsu', value: (row) => row.river }, { key: 'power', label: 'MW', className: 'text-right', value: (row) => formatMw(row.power) }, { key: 'fullness', label: 'Doluluk', className: 'text-right', value: fullnessCell },
  ] : currentTab === 'rivers' ? [
    { key: 'type', label: 'Tip', value: () => 'Nehir' }, { key: 'name', label: 'Akarsu adı', value: (row) => row.name }, { key: 'basin', label: 'Havza', value: (row) => row.basin }, { key: 'count', label: 'HES', className: 'text-right', value: (row) => row.count.toLocaleString('tr-TR') }, { key: 'power', label: 'MW', className: 'text-right', value: (row) => formatMw(row.power) }, { key: 'forecast', label: 'Tahmin', className: 'text-right', value: (row) => row.forecast ? 'Var' : 'Yok' }, { key: 'fullness', label: 'Doluluk', className: 'text-right', value: (row) => row.fullness === null ? '—' : `%${Math.round(row.fullness)}` },
  ] : [
    { key: 'type', label: 'Tip', value: () => 'Havza' }, { key: 'name', label: 'Havza adı', value: (row) => row.name }, { key: 'count', label: 'HES', className: 'text-right', value: (row) => row.count.toLocaleString('tr-TR') }, { key: 'power', label: 'MW', className: 'text-right', value: (row) => formatMw(row.power) }, { key: 'river', label: 'Ana akarsular', value: (row) => row.riverNames }, { key: 'fullness', label: 'Doluluk', className: 'text-right', value: (row) => row.fullness === null ? '—' : `%${Math.round(row.fullness)}` }, { key: 'cascade', label: 'Kaskat', className: 'text-right', value: (row) => row.cascadeCount || '—' },
  ], [currentTab]);
  const gridTemplate = currentTab === 'hes' ? 'minmax(0,1.65fr) minmax(0,.84fr) minmax(0,.92fr) 4rem 3.9rem' : currentTab === 'rivers' ? '2.7rem minmax(0,1.5fr) minmax(0,.9fr) 2.2rem 4.15rem 2.8rem 3.55rem' : '2.7rem minmax(0,1.3fr) 2.2rem 4.15rem minmax(0,1.1fr) 3.55rem 2.8rem';
  const selectedHes = selectedEntity?.type === 'hes' ? hesRows.find((row) => row.id === selectedEntity.id) : null;
  const selectedRiver = selectedEntity?.type === 'river' ? riverRows.find((row) => row.id === selectedEntity.id) : null;
  const relatedRiverRows = selectedRiver ? hesRows.filter((row) => (selectedRiver.details?.hesIds as unknown[] ?? []).map(String).includes(row.id)) : [];
  const tabs: Array<{ id: TabType; label: string; icon: React.ReactNode; count: number }> = [{ id: 'hes', label: 'HES', icon: <Mountain className="h-4 w-4" />, count: hesRows.length }, { id: 'rivers', label: 'Akarsular', icon: <Waves className="h-4 w-4" />, count: riverRows.length }, { id: 'basins', label: 'Havzalar', icon: <Gauge className="h-4 w-4" />, count: basinRows.length }];
  const layerControls: Array<{ key: keyof typeof layers; label: string }> = [{ key: 'basins', label: 'Havzalar' }, { key: 'rivers', label: 'Akarsular' }, { key: 'dams', label: 'Barajlar' }];
  const selectRow = (row: Row) => setSelectedEntity({ type: row.type, id: row.id });
  const onSort = (key: SortKey) => { if (sortKey === key) setSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc'); else { setSortKey(key); setSortDirection('asc'); } };

  return <aside className={`flex h-full min-h-0 w-full flex-col border-r border-[var(--line)] bg-[var(--panel)] text-[var(--text)] shadow-xl shadow-slate-950/10 transition-colors ${isLight ? 'light-scrollbar' : ''}`}>
    <div className="border-b border-[var(--line)] p-3">
      <div className="mb-3 flex items-center justify-between"><div><div className="flex items-center gap-2 text-sm font-bold"><Activity className="h-4 w-4 text-cyan-400" />HESLER</div><div className="mt-1 font-mono text-[9px] text-slate-500">20 MW+ · TATUS · EPSG:4326 · {dataStatus === 'loading' ? 'yükleniyor' : 'kanonik veri'}</div></div><button onClick={() => useAppStore.getState().toggleSidebar()} className={`rounded-lg p-1.5 ${isLight ? 'text-slate-400 hover:bg-slate-100 hover:text-slate-700' : 'text-slate-500 hover:bg-slate-800 hover:text-white'}`} aria-label="Paneli kapat"><X className="h-4 w-4" /></button></div>
      <div className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--muted)]" /><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="HES, akarsu veya havza ara..." className="w-full rounded-lg border border-[var(--line)] bg-[var(--panel2)] py-2 pl-9 pr-3 text-xs text-[var(--text)] outline-none transition placeholder:text-[var(--muted)] focus:border-cyan-500/70" /></div>
    </div>
    <div className="grid grid-cols-3 gap-1 border-b border-[var(--line)] p-2">{tabs.map((tab) => <button key={tab.id} onClick={() => setTab(tab.id)} className={`flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[9px] transition ${currentTab === tab.id ? 'bg-cyan-500/12 text-[var(--primary)]' : 'text-[var(--muted)] hover:bg-[var(--panel2)]'}`}>{tab.icon}<span>{tab.label}</span><span className="font-mono text-[8px] opacity-70">{tab.count.toLocaleString('tr-TR')}</span></button>)}</div>
    <div className="border-b border-[var(--line)] px-3 py-2"><div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-[var(--muted)]">Harita katmanları</div><div className="grid grid-cols-3 gap-1">{layerControls.map(({ key, label }) => <button key={key} onClick={() => toggleLayer(key)} className={`flex items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-[9px] transition ${layers[key] ? 'bg-cyan-500/12 text-[var(--primary)]' : 'bg-[var(--panel2)] text-[var(--muted)]'}`} aria-pressed={layers[key]}>{layers[key] ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}{label}</button>)}</div></div>
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <div className="mb-1 flex items-center justify-between rounded-lg border border-cyan-500/15 bg-cyan-500/5 px-2 py-1.5 font-mono text-[9px] text-slate-500"><span>Kaynaklar: TATUS · GEOGLOWS · EPİAŞ</span><span>{sortedRows.length.toLocaleString('tr-TR')} kayıt</span></div>
      <div className={`mb-1 grid ${currentTab === 'hes' ? 'min-w-[360px]' : 'min-w-[405px]'} items-center gap-1 rounded-lg bg-[var(--panel2)] px-2 py-1 font-mono text-[8px] uppercase tracking-wide text-[var(--muted)]`} style={{ gridTemplateColumns: gridTemplate }}>{columns.map((column) => <button key={column.key} type="button" onClick={() => onSort(column.key)} className={`truncate text-left hover:text-[var(--primary)] ${column.className ?? ''}`} title={`${column.label} göre sırala`}>{column.label}{sortKey === column.key ? <ArrowUpDown className="ml-0.5 inline h-2.5 w-2.5" /> : null}</button>)}</div>
      {selectedHes && <div className={`mb-2 rounded-xl border p-2 ${isLight ? 'border-cyan-200 bg-cyan-50' : 'border-cyan-500/20 bg-cyan-500/5'}`}><div className="flex items-center justify-between gap-2"><span className="truncate text-[11px] font-semibold text-cyan-400">⚡ {selectedHes.name}</span><span className="font-mono text-[9px] text-sky-300">{selectedHes.fullness === null ? '—' : `%${Math.round(selectedHes.fullness)} ${selectedHes.source}`}</span></div><div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[9px] text-slate-500"><span>Havza: {selectedHes.basin}</span><span>Resmî havza: {String(selectedHes.details?.officialBasinName ?? '—')}</span><span>Akarsu: {selectedHes.river}</span><span>Güç: {formatMw(selectedHes.power)}</span><span>Debi: {numberOf(selectedHes.details?.unitFlowM3s)?.toLocaleString('tr-TR') ?? '—'} m³/sn</span><span>Baraj: {String(selectedHes.details?.damName ?? '—')}</span><span>Min / max kot: {numberOf(selectedHes.details?.minWaterLevelM)?.toLocaleString('tr-TR') ?? '—'} / {numberOf(selectedHes.details?.maxWaterLevelM)?.toLocaleString('tr-TR') ?? '—'} m</span><span>Min / max hacim: {numberOf(selectedHes.details?.minVolumeHm3)?.toLocaleString('tr-TR') ?? '—'} / {numberOf(selectedHes.details?.maxVolumeHm3)?.toLocaleString('tr-TR') ?? '—'} hm³</span><span>Aktif hacim: {numberOf(selectedHes.details?.activeVolumeHm3)?.toLocaleString('tr-TR') ?? '—'} hm³</span><span>Kaskat: {String(selectedHes.details?.cascadeName ?? '—')}</span></div><div className="mt-2 grid grid-cols-2 gap-1"><button onClick={() => { const id = String(selectedHes.details?.riverSystemId ?? ''); if (id) setSelectedEntity({ type: 'river', id }); }} className="rounded border border-cyan-500/25 px-1.5 py-1 text-[8px] text-cyan-400">Akarsuyu göster</button><button onClick={() => { const id = String(selectedHes.details?.basinId ?? ''); if (id) setSelectedEntity({ type: 'basin', id }); }} className="rounded border border-violet-500/25 px-1.5 py-1 text-[8px] text-violet-400">Havzayı göster</button><button onClick={() => { const id = String(selectedHes.details?.cascadeToId ?? ''); if (id) setSelectedEntity({ type: 'hes', id }); }} className="rounded border border-amber-500/25 px-1.5 py-1 text-[8px] text-amber-400">Kaskadı göster</button><button onClick={() => toggleCatchment(selectedHes.id)} className="rounded border border-cyan-500/25 px-1.5 py-1 text-[8px] text-cyan-400">Su alanını göster</button></div></div>}
      {selectedRiver && relatedRiverRows.length > 0 && <div className="mb-2 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-2"><div className="text-[10px] font-semibold text-cyan-400">İlgili HES tesisleri</div><div className="mb-1 text-[9px] text-slate-500">Kanonik logical akarsu ilişkisi · {relatedRiverRows.length} HES</div>{relatedRiverRows.slice(0, 4).map((row) => <button key={row.id} onClick={() => selectRow(row)} className="block w-full truncate py-0.5 text-left text-[9px] text-slate-300 hover:text-cyan-300">⚡ {row.name} · {formatMw(row.power)}</button>)}</div>}
      {dataStatus === 'loading' ? <div className="p-4 text-center text-xs text-[var(--muted)]">Kanonik HES verisi yükleniyor…</div> : sortedRows.map((row) => <button key={row.id} onClick={() => selectRow(row)} className={`mb-1 grid ${currentTab === 'hes' ? 'min-w-[360px]' : 'min-w-[405px]'} w-full items-center gap-1 rounded-lg border border-transparent bg-[var(--panel2)] px-2 py-1.5 text-left transition hover:border-cyan-500/30 ${selectedEntity?.type === row.type && selectedEntity.id === row.id ? 'ring-1 ring-cyan-400/55' : ''}`} style={{ gridTemplateColumns: gridTemplate }}>{columns.map((column) => { const content = column.value(row); return <span key={column.key} title={typeof content === 'string' ? content : undefined} className={`truncate text-[9px] ${column.key === 'name' ? 'font-semibold text-[var(--text)]' : column.key === 'river' ? 'text-[var(--primary)]' : column.className ?? 'text-[var(--muted)]'}`}>{content}</span>; })}</button>)}
    </div>
    <div className={`border-t p-3 font-mono text-[9px] ${isLight ? 'border-slate-200 text-slate-500' : 'border-slate-800/80 text-slate-600'}`}>20 MW+ HES envanteri · seçim haritada uygun ölçeğe yaklaşır · doluluk: E EPİAŞ, H hacim, M mock</div>
  </aside>;
};

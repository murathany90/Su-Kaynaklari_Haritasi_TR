import React, { useMemo, useState } from 'react';
import { ChevronDown, Map as MapIcon, Menu, RefreshCw, X } from 'lucide-react';
import { formatDataDate } from '../../data/hydrology';
import { fullnessRecordsByHes, preferredFullnessRecord, resolveHesFullness } from '../../data/fullnessSources';
import { useAppStore } from '../../store/useAppStore';

const basemapLabels = { dark: 'Karanlık', light: 'Açık', neutral: 'Nötr', satellite: 'Uydu', streets: 'Sokak' };

export const HesToolbar: React.FC = () => {
  const basemap = useAppStore((state) => state.basemap);
  const setBasemap = useAppStore((state) => state.setBasemap);
  const isSidebarOpen = useAppStore((state) => state.isSidebarOpen);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const rivers = useAppStore((state) => state.rivers);
  const hes177 = useAppStore((state) => state.hes177);
  const basins = useAppStore((state) => state.basins);
  const relations = useAppStore((state) => state.hes177Relations);
  const manifest = useAppStore((state) => state.hes177Manifest);
  const epias = useAppStore((state) => state.epias);
  const fullnessPayload = useAppStore((state) => state.fullness);
  const dataMode = useAppStore((state) => state.dataMode);
  const dataStatus = useAppStore((state) => state.hydroDataStatus);
  const lastRefreshAt = useAppStore((state) => state.lastRefreshAt);
  const refreshHydroData = useAppStore((state) => state.refreshHydroData);
  const [basemapMenuOpen, setBasemapMenuOpen] = useState(false);

  const kpis = useMemo(() => {
    const totalPower = hes177.features.reduce((sum, feature) => sum + (Number(feature.properties?.installedPowerMw) || 0), 0);
    const fullnessByHes = fullnessRecordsByHes(fullnessPayload);
    const sources = hes177.features.map((feature) => {
      const properties = feature.properties ?? {};
      const id = String(properties.id ?? feature.id ?? '');
      const names = [properties.damName, properties.name].filter(Boolean).map((value) => String(value).toLocaleLowerCase('tr-TR'));
      const record = dataMode === 'epias' ? (epias?.records ?? []).find((candidate) => [candidate.hesId, candidate.hesID, candidate.entityId].filter(Boolean).map(String).includes(id) || [candidate.damName, candidate.dam_name, candidate.name].filter(Boolean).map((value) => String(value).toLocaleLowerCase('tr-TR')).some((name) => names.includes(name))) : undefined;
      const result = resolveHesFullness(id, properties, preferredFullnessRecord(fullnessByHes.get(id), record), dataMode);
      return result;
    });
    return {
      hes: hes177.features.length,
      power: totalPower,
      basins: Number(manifest?.basinCount ?? basins.features.length),
      rivers: Number(manifest?.logicalRiverCount ?? rivers.features.length),
      cascades: Number(manifest?.cascadeEdgeCount ?? relations?.cascadeEdges?.length ?? 0),
      located: Number(manifest?.coordinateCount ?? hes177.features.filter((feature) => Boolean(feature.geometry)).length),
      calculated: sources.filter((source) => source.sourceClass === 'calculated_storage' && source.fullnessPercent !== null).length,
      mock: sources.filter((source) => source.sourceClass === 'mock').length,
      epias: sources.filter((source) => source.source === 'epias').length,
      satellite: sources.filter((source) => source.sourceClass === 'satellite_altimetry' || source.sourceClass === 'satellite_area').length,
      stale: sources.filter((source) => source.status === 'stale').length,
      notApplicable: sources.filter((source) => source.status === 'not_applicable').length,
      unavailable: sources.filter((source) => source.status === 'unavailable').length,
      applicable: Number(fullnessPayload?.coverage?.applicableCount ?? sources.filter((source) => source.status !== 'not_applicable').length),
      available: Number(fullnessPayload?.coverage?.availableCount ?? sources.filter((source) => source.status === 'available').length) + Number(fullnessPayload?.coverage?.staleCount ?? sources.filter((source) => source.status === 'stale').length),
      latestObservationAt: fullnessPayload?.latestObservationAt ?? sources.map((source) => source.observedAt).filter(Boolean).sort().at(-1) ?? null,
    };
  }, [basins.features.length, dataMode, epias?.records, fullnessPayload, hes177.features, manifest, relations?.cascadeEdges?.length, rivers.features.length]);

  const statusLabel = dataStatus === 'ready' ? 'Veri hazır' : dataStatus === 'loading' ? 'Yükleniyor' : dataStatus === 'partial' ? 'Kısmi veri' : 'Veri bekleniyor';
  const pipelineRunAt = fullnessPayload?.pipelineRunAt ?? lastRefreshAt;

  return (
    <section className="hes-toolbar z-20 flex min-h-12 shrink-0 items-center gap-2 border-b px-3 py-1.5 sm:px-4" aria-label="HES araç çubuğu">
      <button type="button" onClick={toggleSidebar} className="rounded-lg border border-[var(--line)] p-1.5 text-[var(--muted)] transition hover:text-[var(--primary)]" title="Paneli aç/kapa" aria-label="Paneli aç/kapa">
        {isSidebarOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
      </button>
      <div className="flex min-w-0 items-center gap-2 border-r border-[var(--line)] pr-2 sm:pr-3">
        <span className="text-xs font-semibold">HESLER</span>
        <span className="rounded-md bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-[var(--primary)]">20 MW+</span>
        <span className="hidden font-mono text-[9px] text-[var(--muted)] sm:inline" title={pipelineRunAt ? `Pipeline çalışması: ${formatDataDate(pipelineRunAt)}` : undefined}>{statusLabel}{kpis.latestObservationAt ? ` · Son gözlem ${formatDataDate(kpis.latestObservationAt)}` : ' · Gözlem yok'}</span>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap">
        <Kpi label="HES" value={kpis.hes.toLocaleString('tr-TR')} />
        <Kpi label="MW" value={Math.round(kpis.power).toLocaleString('tr-TR')} />
        <Kpi label="Havza" value={kpis.basins.toLocaleString('tr-TR')} />
        <Kpi label="Akarsu" value={kpis.rivers.toLocaleString('tr-TR')} />
        <Kpi label="Kaskat" value={kpis.cascades.toLocaleString('tr-TR')} className="hidden md:flex" />
        <Kpi label="Konumlu" value={kpis.located.toLocaleString('tr-TR')} className="hidden lg:flex" />
        <Kpi label="Doluluk" value={`${kpis.available}/${kpis.applicable}`} className="hidden xl:flex" title={`Mevcut ${kpis.available} · Uygulanabilir ${kpis.applicable} · Hesaplanan ${kpis.calculated} · EPİAŞ ${kpis.epias} · Uydu ${kpis.satellite} · Eski ${kpis.stale} · Veri yok ${kpis.unavailable} · Uygulanamaz ${kpis.notApplicable}`} />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <span className="rounded-lg border border-cyan-500/25 bg-cyan-500/8 px-2 py-1.5 font-mono text-[9px] text-[var(--primary)]" title="Doluluk, kanonik resolver ve mevcut doğrulanmış kaynaklara göre gösterilir">GERÇEK VERİ</span>
        <button type="button" onClick={() => void refreshHydroData()} disabled={dataStatus === 'loading'} className="hidden items-center gap-1.5 rounded-lg border border-cyan-500/35 px-2 py-1.5 text-[10px] font-medium text-[var(--primary)] transition hover:bg-cyan-500/8 disabled:opacity-50 sm:flex"><RefreshCw className={`h-3.5 w-3.5 ${dataStatus === 'loading' ? 'animate-spin' : ''}`} />Yenile</button>
        <div className="relative">
          <button type="button" onClick={() => setBasemapMenuOpen((open) => !open)} className="flex items-center gap-1 rounded-lg border border-[var(--line)] px-2 py-1.5 text-[10px] text-[var(--muted)]"><MapIcon className="h-3.5 w-3.5 text-[var(--primary)]" /><span className="hidden sm:inline">{basemapLabels[basemap]}</span><ChevronDown className="h-3 w-3" /></button>
          {basemapMenuOpen && <div className="absolute right-0 top-9 z-50 w-28 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-1 shadow-lg">{Object.entries(basemapLabels).map(([value, label]) => <button type="button" key={value} onClick={() => { setBasemap(value as typeof basemap); setBasemapMenuOpen(false); }} className={`block w-full rounded-md px-2 py-1.5 text-left text-[10px] ${basemap === value ? 'bg-cyan-500/10 text-[var(--primary)]' : 'text-[var(--muted)] hover:bg-[var(--panel2)]'}`}>{label}</button>)}</div>}
        </div>
      </div>
    </section>
  );
};

const Kpi: React.FC<{ label: string; value: string; className?: string; title?: string }> = ({ label, value, className = 'flex', title }) => (
  <div title={title} className={`${className} shrink-0 items-center gap-1 rounded-md px-1.5 py-1`}>
    <span className="font-mono text-[10px] font-semibold text-[var(--text)]">{value}</span>
    <span className="text-[8px] uppercase tracking-wide text-[var(--muted)]">{label}</span>
  </div>
);

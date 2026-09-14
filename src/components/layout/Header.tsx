import React, { useMemo, useState } from 'react';
import { Activity, ChevronDown, Map as MapIcon, Menu, Moon, RefreshCw, Sun, X } from 'lucide-react';
import { formatDataDate, getHesFullnessMeta } from '../../data/hydrology';
import { useAppStore } from '../../store/useAppStore';

export const Header: React.FC = () => {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const basemap = useAppStore((s) => s.basemap);
  const setBasemap = useAppStore((s) => s.setBasemap);
  const isSidebarOpen = useAppStore((s) => s.isSidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const rivers = useAppStore((s) => s.rivers);
  const hes177 = useAppStore((s) => s.hes177);
  const basins = useAppStore((s) => s.basins);
  const hes177Relations = useAppStore((s) => s.hes177Relations);
  const hes177Manifest = useAppStore((s) => s.hes177Manifest);
  const epias = useAppStore((s) => s.epias);
  const dataMode = useAppStore((s) => s.dataMode);
  const setDataMode = useAppStore((s) => s.setDataMode);
  const dataStatus = useAppStore((s) => s.hydroDataStatus);
  const lastRefreshAt = useAppStore((s) => s.lastRefreshAt);
  const refreshHydroData = useAppStore((s) => s.refreshHydroData);
  const [basemapMenuOpen, setBasemapMenuOpen] = useState(false);
  const isLight = theme === 'light';
  const toggleTheme = () => {
    const nextTheme = isLight ? 'dark' : 'light';
    setTheme(nextTheme);
    if (basemap === 'dark' || basemap === 'light') setBasemap(nextTheme);
  };
  const kpis = useMemo(() => {
    const totalPower = hes177.features.reduce((sum, feature) => { const value = Number(feature.properties?.installedPowerMw); return sum + (Number.isFinite(value) ? value : 0); }, 0);
    const fullnessSources = hes177.features.map((feature) => {
      const properties = feature.properties ?? {};
      const id = String(properties.id ?? feature.id ?? '');
      const names = [properties.damName, properties.name].filter(Boolean).map((value) => String(value).toLocaleLowerCase('tr-TR'));
      const record = dataMode === 'epias' ? (epias?.records ?? []).find((candidate) => [candidate.hesId, candidate.hesID, candidate.entityId].filter(Boolean).map(String).includes(id) || [candidate.damName, candidate.dam_name, candidate.name].filter(Boolean).map((value) => String(value).toLocaleLowerCase('tr-TR')).some((name) => names.includes(name))) : undefined;
      return getHesFullnessMeta(id, dataMode, record, properties).source;
    });
    const volumeFullnessCount = fullnessSources.filter((source) => source === 'H').length;
    const epiasFullnessCount = fullnessSources.filter((source) => source === 'E').length;
    const fallbackMockCount = fullnessSources.filter((source) => source === 'M').length;
    return {
      rivers: Number(hes177Manifest?.logicalRiverCount ?? rivers.features.length),
      dams: hes177.features.length,
      coordinates: Number(hes177Manifest?.coordinateCount ?? hes177.features.filter((feature) => Boolean(feature.geometry)).length),
      totalPower,
      basins: Number(hes177Manifest?.basinCount ?? basins.features.length),
      cascades: Number(hes177Manifest?.cascadeEdgeCount ?? hes177Relations?.cascadeEdges?.length ?? 0),
      fullness: fullnessSources.filter((source) => source !== '—').length,
      calculatedFullness: volumeFullnessCount,
      epiasFullness: epiasFullnessCount,
      fallbackMock: fallbackMockCount,
    };
  }, [basins.features.length, dataMode, epias?.records, hes177.features, hes177Manifest, hes177Relations?.cascadeEdges?.length, rivers.features.length]);
  const basemapLabels = { dark: 'Karanlık', light: 'Açık', neutral: 'Nötr / Gri', satellite: 'Uydu', streets: 'Sokak' };

  return (
    <header className={`z-20 flex h-14 shrink-0 items-center justify-between border-b px-3 transition-colors sm:px-5 ${isLight ? 'border-slate-200 bg-white/95 text-slate-800 shadow-sm' : 'glass-cockpit border-slate-800 bg-slate-950/95 text-slate-100'}`}>
      <div className="flex min-w-0 items-center gap-3">
        <button onClick={toggleSidebar} className={`rounded-lg border p-1.5 transition ${isLight ? 'border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-200' : 'border-slate-700 bg-slate-900 text-slate-300 hover:text-white'}`} title="Paneli aç/kapa" aria-label="Paneli aç/kapa">{isSidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}</button>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-400/30 bg-gradient-to-tr from-cyan-600 via-blue-600 to-indigo-600 shadow-lg shadow-cyan-500/25"><Activity className="h-5 w-5 text-white" /></div>
        <div className="min-w-0"><div className="flex items-center gap-2"><h1 className="truncate text-xs font-bold tracking-tight sm:text-sm">PDHES · HESLER</h1><span className="rounded border border-cyan-500/30 bg-cyan-500/15 px-1.5 py-0.5 font-mono text-[9px] font-bold text-cyan-400">20 MW+</span></div><div className="flex items-center gap-2 font-mono text-[9px] text-slate-500"><span className={dataStatus === 'ready' ? 'text-emerald-400' : dataStatus === 'loading' ? 'text-amber-400' : 'text-rose-400'}>{dataStatus === 'ready' ? 'VERİ HAZIR' : dataStatus === 'loading' ? 'VERİ YÜKLENİYOR' : dataStatus === 'partial' ? 'KISMİ VERİ' : 'VERİ BEKLENİYOR'}</span>{lastRefreshAt && <span>· {formatDataDate(lastRefreshAt)}</span>}</div></div>
      </div>
      <div className="hidden items-center gap-3 xl:flex">
        <div className="text-right"><div className="font-mono text-sm font-bold text-violet-400">{kpis.dams.toLocaleString('tr-TR')}</div><div className="text-[9px] uppercase tracking-wider text-slate-500">HES</div></div>
        <div className="text-right"><div className="font-mono text-sm font-bold text-cyan-400">{Math.round(kpis.totalPower).toLocaleString('tr-TR')} MW</div><div className="text-[9px] uppercase tracking-wider text-slate-500">Kurulu güç</div></div>
        <div className="text-right"><div className="font-mono text-sm font-bold text-indigo-300">{kpis.basins.toLocaleString('tr-TR')}</div><div className="text-[9px] uppercase tracking-wider text-slate-500">Havza</div></div>
        <div className="text-right"><div className="font-mono text-sm font-bold text-amber-300">{kpis.cascades.toLocaleString('tr-TR')}</div><div className="text-[9px] uppercase tracking-wider text-slate-500">Kaskat</div></div>
        <div className="text-right"><div className="font-mono text-sm font-bold text-emerald-400">{kpis.rivers.toLocaleString('tr-TR')}</div><div className="text-[9px] uppercase tracking-wider text-slate-500">Nehir sistemi</div></div>
        <div className="text-right"><div className="font-mono text-sm font-bold text-blue-400">{kpis.coordinates.toLocaleString('tr-TR')}</div><div className="text-[9px] uppercase tracking-wider text-slate-500">Konumlu HES</div></div>
        <div className="text-right"><div className="font-mono text-sm font-bold text-teal-300">{kpis.fullness.toLocaleString('tr-TR')}</div><div className="text-[9px] uppercase tracking-wider text-slate-500">Doluluk verisi</div><div className="font-mono text-[8px] text-slate-600">H {kpis.calculatedFullness} · M {kpis.fallbackMock}</div></div>
        <div className="text-right"><div className="font-mono text-sm font-bold text-amber-300">{kpis.epiasFullness.toLocaleString('tr-TR')}</div><div className="text-[9px] uppercase tracking-wider text-slate-500">EPİAŞ doluluk</div></div>
        <div className="flex items-center rounded-lg border border-slate-700 p-0.5 text-[9px]"><button onClick={() => setDataMode('mock')} className={`rounded px-2 py-1 ${dataMode === 'mock' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-500'}`}>MOCK</button><button onClick={() => setDataMode('epias')} className={`rounded px-2 py-1 ${dataMode === 'epias' ? 'bg-violet-500/20 text-violet-300' : 'text-slate-500'}`}>EPİAŞ</button></div>
        <button onClick={() => void refreshHydroData()} disabled={dataStatus === 'loading'} className="flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-[10px] font-semibold text-cyan-300 transition hover:bg-cyan-500/20 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${dataStatus === 'loading' ? 'animate-spin' : ''}`} />Yenile</button>
        <button onClick={toggleTheme} className="rounded-lg border border-slate-700 p-2 text-slate-400 transition hover:text-cyan-300" title="Temayı değiştir" aria-label="Temayı değiştir">{isLight ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}</button>
        <div className="relative"><button onClick={() => setBasemapMenuOpen((open) => !open)} className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-2 text-[10px] text-slate-300"><MapIcon className="h-3.5 w-3.5 text-cyan-400" />{basemapLabels[basemap]}<ChevronDown className="h-3 w-3" /></button>{basemapMenuOpen && <div className="absolute right-0 top-11 z-50 w-32 rounded-xl border border-slate-700 bg-slate-950/95 p-1 shadow-2xl">{Object.entries(basemapLabels).map(([value, label]) => <button key={value} onClick={() => { setBasemap(value as typeof basemap); setBasemapMenuOpen(false); }} className={`block w-full rounded-lg px-2 py-1.5 text-left text-[10px] ${basemap === value ? 'bg-cyan-500/15 text-cyan-300' : 'text-slate-400 hover:bg-slate-800'}`}>{label}</button>)}</div>}</div>
      </div>
    </header>
  );
};

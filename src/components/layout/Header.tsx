import React, { useMemo, useState } from 'react';
import { Activity, ChevronDown, Map as MapIcon, Menu, Moon, RefreshCw, Sun, X } from 'lucide-react';
import { formatDataDate } from '../../data/hydrology';
import { useAppStore } from '../../store/useAppStore';

export const Header: React.FC = () => {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const basemap = useAppStore((s) => s.basemap);
  const setBasemap = useAppStore((s) => s.setBasemap);
  const isSidebarOpen = useAppStore((s) => s.isSidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const rivers = useAppStore((s) => s.rivers);
  const dams = useAppStore((s) => s.damStations);
  const geoglows = useAppStore((s) => s.geoglows);
  const mappingManifest = useAppStore((s) => s.mappingManifest);
  const epias = useAppStore((s) => s.epias);
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
    const epiasValues = (epias?.records ?? []).map((record) => Number(record.occupancy ?? record.fullness ?? record.activeFullness)).filter(Number.isFinite);
    return {
      rivers: rivers.features.length,
      dams: dams.features.length,
      mapped: mappingManifest?.matchedCount ?? mappingManifest?.count ?? 0,
      forecasts: geoglows?.records?.length ?? 0,
      occupancy: epiasValues.length ? Math.round(epiasValues.reduce((sum, value) => sum + value, 0) / epiasValues.length) : null,
    };
  }, [dams.features.length, epias?.records, geoglows?.records?.length, mappingManifest?.count, mappingManifest?.matchedCount, rivers.features.length]);
  const basemapLabels = { dark: 'Karanlık', light: 'Açık', satellite: 'Uydu', streets: 'Sokak' };

  return (
    <header className={`z-20 flex h-14 shrink-0 items-center justify-between border-b px-3 transition-colors sm:px-5 ${isLight ? 'border-slate-200 bg-white/95 text-slate-800 shadow-sm' : 'glass-cockpit border-slate-800 bg-slate-950/95 text-slate-100'}`}>
      <div className="flex min-w-0 items-center gap-3">
        <button onClick={toggleSidebar} className={`rounded-lg border p-1.5 transition ${isLight ? 'border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-200' : 'border-slate-700 bg-slate-900 text-slate-300 hover:text-white'}`} title="Paneli aç/kapa" aria-label="Paneli aç/kapa">{isSidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}</button>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-400/30 bg-gradient-to-tr from-cyan-600 via-blue-600 to-indigo-600 shadow-lg shadow-cyan-500/25"><Activity className="h-5 w-5 text-white" /></div>
        <div className="min-w-0"><div className="flex items-center gap-2"><h1 className="truncate text-xs font-bold tracking-tight sm:text-sm">TÜRKİYE HİDROLOJİ & ENERJİ</h1><span className="rounded border border-cyan-500/30 bg-cyan-500/15 px-1.5 py-0.5 font-mono text-[9px] font-bold text-cyan-400">FAZ 2</span></div><div className="flex items-center gap-2 font-mono text-[9px] text-slate-500"><span className={dataStatus === 'ready' ? 'text-emerald-400' : dataStatus === 'loading' ? 'text-amber-400' : 'text-rose-400'}>{dataStatus === 'ready' ? 'VERİ HAZIR' : dataStatus === 'loading' ? 'VERİ YÜKLENİYOR' : dataStatus === 'partial' ? 'KISMİ VERİ' : 'VERİ BEKLENİYOR'}</span>{lastRefreshAt && <span>· {formatDataDate(lastRefreshAt)}</span>}</div></div>
      </div>
      <div className="hidden items-center gap-3 xl:flex">
        <div className="text-right"><div className="font-mono text-sm font-bold text-cyan-400">{kpis.rivers.toLocaleString('tr-TR')}</div><div className="text-[9px] uppercase tracking-wider text-slate-500">Nehir</div></div>
        <div className="text-right"><div className="font-mono text-sm font-bold text-violet-400">{kpis.dams.toLocaleString('tr-TR')}</div><div className="text-[9px] uppercase tracking-wider text-slate-500">Baraj istasyonu</div></div>
        <div className="text-right"><div className="font-mono text-sm font-bold text-emerald-400">{kpis.mapped.toLocaleString('tr-TR')}</div><div className="text-[9px] uppercase tracking-wider text-slate-500">GEOGLOWS eşleşmesi</div></div>
        <div className="text-right"><div className="font-mono text-sm font-bold text-blue-400">{kpis.forecasts.toLocaleString('tr-TR')}</div><div className="text-[9px] uppercase tracking-wider text-slate-500">Tahmin bulunan</div></div>
        <div className="text-right"><div className="font-mono text-sm font-bold text-amber-400">{kpis.occupancy === null ? '—' : `%${kpis.occupancy}`}</div><div className="text-[9px] uppercase tracking-wider text-slate-500">EPİAŞ doluluk</div></div>
        <button onClick={() => void refreshHydroData()} disabled={dataStatus === 'loading'} className="flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-[10px] font-semibold text-cyan-300 transition hover:bg-cyan-500/20 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${dataStatus === 'loading' ? 'animate-spin' : ''}`} />Yenile</button>
        <button onClick={toggleTheme} className="rounded-lg border border-slate-700 p-2 text-slate-400 transition hover:text-cyan-300" title="Temayı değiştir" aria-label="Temayı değiştir">{isLight ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}</button>
        <div className="relative"><button onClick={() => setBasemapMenuOpen((open) => !open)} className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-2 text-[10px] text-slate-300"><MapIcon className="h-3.5 w-3.5 text-cyan-400" />{basemapLabels[basemap]}<ChevronDown className="h-3 w-3" /></button>{basemapMenuOpen && <div className="absolute right-0 top-11 z-50 w-32 rounded-xl border border-slate-700 bg-slate-950/95 p-1 shadow-2xl">{Object.entries(basemapLabels).map(([value, label]) => <button key={value} onClick={() => { setBasemap(value as typeof basemap); setBasemapMenuOpen(false); }} className={`block w-full rounded-lg px-2 py-1.5 text-left text-[10px] ${basemap === value ? 'bg-cyan-500/15 text-cyan-300' : 'text-slate-400 hover:bg-slate-800'}`}>{label}</button>)}</div>}</div>
      </div>
    </header>
  );
};

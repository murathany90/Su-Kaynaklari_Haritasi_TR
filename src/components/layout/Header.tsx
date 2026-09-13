import React, { useMemo, useState, useCallback } from 'react';
import { Activity, Waves, Zap, RefreshCw, Sun, Moon, Map as MapIcon, X, Menu, ChevronDown } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { RIVERS_DATA, DAMS_DATA } from '../../data/mockData';
import { getDamMetrics, MONTH_NAMES } from '../../data/hydrology';

export const Header: React.FC = () => {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const basemap = useAppStore((s) => s.basemap);
  const setBasemap = useAppStore((s) => s.setBasemap);
  const isSidebarOpen = useAppStore((s) => s.isSidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const timelineMonthIndex = useAppStore((s) => s.timelineMonthIndex);

  const [isSyncing, setIsSyncing] = useState(false);
  const [basemapMenuOpen, setBasemapMenuOpen] = useState(false);

  const isLight = theme === 'light';

  // KPI calculations — memoized to avoid recalculating on every render
  const { totalFlow, totalEnergy } = useMemo(() => {
    let flow = 0;
    RIVERS_DATA.forEach((r) => { flow += r.seasonal_profile[timelineMonthIndex]; });

    let energy = 0;
    DAMS_DATA.forEach((dam) => {
      const metrics = getDamMetrics(dam, timelineMonthIndex);
      energy += metrics.energy;
    });

    return {
      totalFlow: flow,
      totalEnergy: energy,
    };
  }, [timelineMonthIndex]);

  const handleSyncEpias = useCallback(() => {
    setIsSyncing(true);
    setTimeout(() => {
      setIsSyncing(false);
    }, 1200);
  }, []);

  return (
    <header className={`h-14 border-b z-20 flex items-center justify-between px-3 sm:px-5 shrink-0 transition-colors ${isLight ? 'bg-white/95 border-slate-200 shadow-sm' : 'bg-slate-950/95 border-slate-800 glass-cockpit'}`}>
      <div className="flex items-center space-x-3">
        <button onClick={toggleSidebar} className={`p-1.5 rounded-lg border transition ${isLight ? 'bg-slate-100 text-slate-600 hover:bg-slate-200 border-slate-300' : 'bg-slate-900 text-slate-300 hover:text-white border-slate-700'}`} title="Paneli Aç/Kapa">
          {isSidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
        <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-600 via-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-cyan-500/25 border border-cyan-400/30">
          <Activity className="w-5 h-5 text-white" />
        </div>
        <div>
          <div className="flex items-center space-x-2">
            <h1 className={`font-bold text-xs sm:text-sm tracking-tight flex items-center gap-1.5 ${isLight ? 'text-slate-800' : 'text-slate-100'}`}>
              TÜRKİYE HİDROLOJİ & ENERJİ
              <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold border ${isLight ? 'bg-cyan-50 text-cyan-600 border-cyan-200' : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'}`}>v2.6</span>
            </h1>
            <span className={`hidden md:inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-mono border ${isLight ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> {MONTH_NAMES[timelineMonthIndex]}
            </span>
          </div>
          <p className={`text-[10px] hidden lg:block ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>Hidrodinamik Akış Modellemesi &bull; Kaskad HES</p>
        </div>
      </div>

      <div className="flex items-center space-x-2 sm:space-x-3">
        {/* KPI Bar */}
        <div className={`hidden xl:flex items-center space-x-3 text-[11px] font-mono-code px-3 py-1.5 rounded-lg border ${isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-900/90 border-slate-800 shadow-inner'}`}>
          <div className="flex items-center space-x-1.5">
            <Waves className={`w-3.5 h-3.5 ${isLight ? 'text-cyan-500' : 'text-cyan-400'}`} />
            <span className={isLight ? 'text-slate-500' : 'text-slate-400'}>Debi:</span>
            <span className={`font-bold ${isLight ? 'text-cyan-600' : 'text-cyan-300'}`}>{totalFlow.toLocaleString()} m³/s</span>
          </div>
          <div className={`h-3 w-px ${isLight ? 'bg-slate-300' : 'bg-slate-700'}`}></div>
          <div className="flex items-center space-x-1.5">
            <Zap className={`w-3.5 h-3.5 ${isLight ? 'text-amber-500' : 'text-amber-400'}`} />
            <span className={isLight ? 'text-slate-500' : 'text-slate-400'}>Enerji:</span>
            <span className={`font-bold ${isLight ? 'text-amber-500' : 'text-amber-400'}`}>{totalEnergy.toLocaleString()} GWh</span>
          </div>
        </div>

        {/* Theme Toggle */}
        <button
          onClick={() => setTheme(isLight ? 'dark' : 'light')}
          className={`p-1.5 rounded-lg border transition flex items-center justify-center ${isLight ? 'bg-amber-100 text-amber-600 border-amber-200 hover:bg-amber-200' : 'bg-slate-800 text-slate-300 border-slate-700 hover:text-white hover:bg-slate-700'}`}
          title="Temayı Değiştir"
        >
          {isLight ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>

        {/* Basemap Select (click-based, not hover) */}
        <div className="relative">
          <button
            onClick={() => setBasemapMenuOpen(!basemapMenuOpen)}
            className={`flex items-center space-x-1 p-1.5 rounded-lg border transition ${isLight ? 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50' : 'bg-slate-800 text-slate-300 border-slate-700 hover:text-white'}`}
            title="Harita Altlığı"
          >
            <MapIcon className="w-4 h-4" />
            <ChevronDown className="w-3 h-3" />
          </button>
          {basemapMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setBasemapMenuOpen(false)} />
              <div className={`absolute right-0 top-full mt-1 w-36 rounded-lg border shadow-xl overflow-hidden z-50 ${isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-700'}`}>
                {(['dark', 'light', 'satellite', 'streets'] as const).map((key) => {
                  const labels: Record<string, string> = { dark: '🌑 Karanlık', light: '☀️ Aydınlık', satellite: '🛰️ Uydu', streets: '🗺️ Sokak (OSM)' };
                  return (
                    <button
                      key={key}
                      onClick={() => { setBasemap(key); setBasemapMenuOpen(false); }}
                      className={`w-full text-left px-3 py-2.5 text-xs transition ${basemap === key ? (isLight ? 'text-cyan-600 font-bold bg-cyan-50' : 'text-cyan-400 font-bold bg-cyan-500/10') : (isLight ? 'text-slate-700 hover:bg-slate-50' : 'text-slate-300 hover:bg-slate-800')}`}
                    >
                      {labels[key]}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Sync Button */}
        <button
          onClick={handleSyncEpias}
          disabled={isSyncing}
          className={`flex items-center space-x-1.5 text-xs px-3 py-1.5 rounded-lg border transition shadow-sm ${isLight ? 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50' : 'bg-slate-900 text-slate-200 border-slate-700 hover:border-cyan-500/50'} ${isSyncing ? 'opacity-70 cursor-wait' : ''}`}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLight ? 'text-cyan-500' : 'text-cyan-400'} ${isSyncing ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline font-medium">{isSyncing ? 'Güncelleniyor…' : 'Senkronize'}</span>
        </button>
      </div>
    </header>
  );
};

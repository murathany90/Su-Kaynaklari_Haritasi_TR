import React, { useMemo } from 'react';
import { GitBranch, Layers, Droplets, MapPin, Search, Network } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { RIVERS_DATA, DAMS_DATA, LAKES_DATA, BASINS_DATA } from '../../data/mockData';
import { getDamMetrics } from '../../data/hydrology';

// Helper: determine river flow status
function getRiverStatus(flow: number, normalFlow: number): 'drought' | 'normal' | 'flood' {
  if (flow < normalFlow * 0.6) return 'drought';
  if (flow > normalFlow * 1.4) return 'flood';
  return 'normal';
}

export const Sidebar: React.FC = () => {
  const currentTab = useAppStore((s) => s.currentTab);
  const currentFilter = useAppStore((s) => s.currentFilter);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const timelineMonthIndex = useAppStore((s) => s.timelineMonthIndex);
  const setTab = useAppStore((s) => s.setTab);
  const setFilter = useAppStore((s) => s.setFilter);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const setSelectedEntity = useAppStore((s) => s.setSelectedEntity);
  const theme = useAppStore((s) => s.theme);

  const isLight = theme === 'light';
  const query = searchQuery.toLowerCase();

  // --- Filtered data (memoized) ---
  const filteredRivers = useMemo(() => {
    return RIVERS_DATA.filter((r) => {
      const matchQuery = r.name.toLowerCase().includes(query) || r.basin.toLowerCase().includes(query);
      const flow = r.seasonal_profile[timelineMonthIndex];
      const status = getRiverStatus(flow, r.normal_flow);
      const matchFilter = currentFilter === 'all' || status === currentFilter;
      return matchQuery && matchFilter;
    });
  }, [query, timelineMonthIndex, currentFilter]);

  const filteredDams = useMemo(() => {
    return DAMS_DATA.filter((d) => {
      const matchQuery = d.name.toLowerCase().includes(query) || d.cascade_group.toLowerCase().includes(query);
      const occupancy = getDamMetrics(d, timelineMonthIndex).occupancy;
      const matchFilter = currentFilter === 'all' ||
        (currentFilter === 'drought' && occupancy < 30) ||
        (currentFilter === 'normal' && occupancy >= 30 && occupancy <= 65) ||
        (currentFilter === 'flood' && occupancy > 65);
      return matchQuery && matchFilter;
    });
  }, [query, currentFilter, timelineMonthIndex]);

  const filteredLakes = useMemo(() => {
    return LAKES_DATA.filter((l) => l.name.toLowerCase().includes(query) || l.basin.toLowerCase().includes(query));
  }, [query]);

  const filteredBasins = useMemo(() => {
    return BASINS_DATA.filter((b) => b.name.toLowerCase().includes(query));
  }, [query]);

  // --- Status badge component ---
  const StatusBadge = ({ status }: { status: string }) => {
    const classes: Record<string, string> = {
      drought: isLight ? 'bg-rose-50 text-rose-600 border-rose-200' : 'bg-rose-500/15 text-rose-400 border-rose-500/30',
      normal: isLight ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
      flood: isLight ? 'bg-cyan-50 text-cyan-600 border-cyan-200' : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
    };
    const labels: Record<string, string> = { drought: 'Kuraklık', normal: 'Normal', flood: 'Yüksek Akış' };
    return <span className={`px-1.5 py-0.5 rounded text-[10px] border ${classes[status]}`}>{labels[status]}</span>;
  };

  // --- Card base class ---
  const cardClass = `p-2.5 rounded-xl cursor-pointer border transition group ${isLight ? 'bg-white hover:bg-slate-50 border-slate-200 hover:border-cyan-400 shadow-sm' : 'bg-slate-900/40 hover:bg-slate-800/80 border-slate-800/80 hover:border-cyan-500/50'}`;
  const titleClass = `text-xs font-bold transition ${isLight ? 'text-slate-800 group-hover:text-cyan-600' : 'text-slate-100 group-hover:text-cyan-400'}`;
  const subtitleClass = `text-[11px] ${isLight ? 'text-slate-500' : 'text-slate-400'}`;

  const renderRivers = () => filteredRivers.map((r) => {
    const flow = r.seasonal_profile[timelineMonthIndex];
    const velocity = (0.28 * Math.pow(flow, 0.38)).toFixed(2);
    const status = getRiverStatus(flow, r.normal_flow);

    return (
      <div key={r.id} onClick={() => setSelectedEntity({ type: 'river', id: r.id })} className={cardClass}>
        <div className="flex items-start justify-between">
          <div>
            <h4 className={titleClass}>{r.name}</h4>
            <p className={subtitleClass}>{r.basin}</p>
          </div>
          <StatusBadge status={status} />
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] font-mono-code">
          <span className={`font-bold ${isLight ? 'text-cyan-600' : 'text-cyan-300'}`}>{flow} m³/s</span>
          <span className={`text-[10px] ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>Hız: {velocity} m/s</span>
          <span className={`text-[10px] ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>SSI: {r.ssi_score}</span>
        </div>
      </div>
    );
  });

  const renderDams = () => filteredDams.map((d) => {
    const metrics = getDamMetrics(d, timelineMonthIndex);
    const pctColor = metrics.occupancy < 30 ? (isLight ? 'text-rose-600' : 'text-rose-400') : metrics.occupancy <= 65 ? (isLight ? 'text-amber-600' : 'text-amber-400') : (isLight ? 'text-cyan-600' : 'text-cyan-400');
    const barColor = metrics.occupancy < 30 ? 'bg-rose-500' : metrics.occupancy <= 65 ? 'bg-amber-400' : 'bg-cyan-500';

    return (
      <div key={d.id} onClick={() => setSelectedEntity({ type: 'dam', id: d.id })} className={cardClass}>
        <div className="flex items-start justify-between">
          <div>
            <h4 className={titleClass}>{d.name}</h4>
            <p className={subtitleClass}>{d.cascade_group} &bull; {d.installed_power_mw} MW</p>
          </div>
          <span className={`text-xs font-mono font-bold ${pctColor}`}>%{metrics.occupancy}</span>
        </div>
        <div className={`w-full h-1.5 rounded-full mt-2 overflow-hidden ${isLight ? 'bg-slate-200' : 'bg-slate-800'}`}>
          <div className={`${barColor} h-full rounded-full transition-all duration-500`} style={{ width: `${metrics.occupancy}%` }}></div>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[10px] font-mono-code">
          <span className={`font-bold ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>{metrics.energy.toLocaleString()} GWh</span>
          <span className={isLight ? 'text-slate-500' : 'text-slate-400'}>Düşü: {d.head_m} m</span>
        </div>
      </div>
    );
  });

  const renderLakes = () => filteredLakes.map((l) => (
    <div key={l.id} onClick={() => setSelectedEntity({ type: 'lake', id: l.id })} className={cardClass}>
      <div className="flex items-start justify-between">
        <div>
          <h4 className={titleClass}>{l.name}</h4>
          <p className={subtitleClass}>{l.basin}</p>
        </div>
        <span className={`text-xs font-mono font-bold ${isLight ? 'text-rose-600' : 'text-rose-400'}`}>-%{l.area_loss_pct}</span>
      </div>
      <p className={`text-[11px] mt-1 flex items-center space-x-1.5 ${isLight ? 'text-slate-600' : 'text-slate-300'}`}>
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: l.color }}></span>
        <span>{l.status}</span>
      </p>
      <div className={`mt-1.5 flex items-center justify-between text-[10px] font-mono ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
        <span>NDWI: {l.current_area_km2} km²</span>
        <span>Ref: {l.ref_area_km2} km²</span>
      </div>
    </div>
  ));

  const renderBasins = () => filteredBasins.map((b) => {
    const ssiColor = b.ssi < -1 ? (isLight ? 'text-rose-600' : 'text-rose-400') : b.ssi > 1 ? (isLight ? 'text-cyan-600' : 'text-cyan-400') : (isLight ? 'text-emerald-600' : 'text-emerald-400');
    return (
      <div key={b.id} onClick={() => setSelectedEntity({ type: 'basin', id: b.id })} className={cardClass}>
        <div className="flex items-start justify-between">
          <div>
            <h4 className={titleClass}>{b.name}</h4>
            <p className={subtitleClass}>{b.status}</p>
          </div>
          <span className={`text-xs font-mono font-bold ${ssiColor}`}>SSI: {b.ssi}</span>
        </div>
        <div className={`mt-1.5 flex items-center justify-between text-[10px] font-mono ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
          <span>Verim: <strong className={isLight ? 'text-cyan-600' : 'text-cyan-300'}>{b.yield_hm3.toLocaleString()} hm³</strong></span>
          <span>{b.area_km2.toLocaleString()} km²</span>
        </div>
      </div>
    );
  });

  const contentMap = {
    rivers: renderRivers,
    dams: renderDams,
    lakes: renderLakes,
    basins: renderBasins,
  };

  const renderContent = contentMap[currentTab]?.() || null;

  // Count for the active tab
  const counts = { rivers: filteredRivers.length, dams: filteredDams.length, lakes: filteredLakes.length, basins: filteredBasins.length };

  return (
    <aside className={`w-full sm:w-[410px] h-full flex flex-col transition-colors border-r shrink-0 ${isLight ? 'bg-slate-50 border-slate-200' : 'bg-[rgba(11,17,33,0.88)] backdrop-blur-md border-slate-800/80'}`}>
      {/* Tabs */}
      <div className={`flex p-1.5 gap-1 text-xs font-semibold border-b ${isLight ? 'bg-slate-100 border-slate-200' : 'bg-slate-950/70 border-slate-800/90'}`}>
        {[
          { key: 'rivers' as const, label: 'Akarsular', icon: <GitBranch className="w-3.5 h-3.5" /> },
          { key: 'dams' as const, label: 'Kaskad HES', icon: <Layers className="w-3.5 h-3.5" /> },
          { key: 'lakes' as const, label: 'Göller', icon: <Droplets className="w-3.5 h-3.5" /> },
          { key: 'basins' as const, label: 'Havzalar', icon: <MapPin className="w-3.5 h-3.5" /> },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setTab(tab.key)}
            className={`flex-1 py-2 rounded-lg flex items-center justify-center space-x-1.5 transition ${currentTab === tab.key ? (isLight ? 'bg-white text-cyan-600 shadow-sm border border-slate-200' : 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40') : (isLight ? 'text-slate-500 hover:text-slate-800' : 'text-slate-400 hover:text-slate-200')}`}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Search + Filters */}
      <div className={`p-3 border-b space-y-2.5 ${isLight ? 'bg-slate-100/50 border-slate-200' : 'bg-slate-950/40 border-slate-800/80'}`}>
        <div className="relative">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Nehir, baraj veya havza ara..."
            className={`w-full rounded-lg pl-9 pr-3 py-2 text-xs focus:outline-none transition border ${isLight ? 'bg-white border-slate-300 text-slate-800 placeholder-slate-400 focus:border-cyan-500' : 'bg-slate-900/90 border-slate-700/80 text-slate-200 placeholder-slate-500 focus:border-cyan-500'}`}
          />
        </div>
        {/* Filter chips (visible on rivers & dams tabs) */}
        {(currentTab === 'rivers' || currentTab === 'dams') && (
          <div className="flex items-center space-x-1.5 text-[11px]">
            {(['all', 'drought', 'normal', 'flood'] as const).map((f) => {
              const labels = { all: 'Tümü', drought: '🔴 Kurak', normal: '🟢 Normal', flood: '🔵 Taşkın' };
              const isActive = currentFilter === f;
              return (
                <button key={f} onClick={() => setFilter(f)} className={`px-2.5 py-1 rounded-md font-medium transition border ${isActive ? (isLight ? 'bg-white text-slate-800 border-slate-300 shadow-sm' : 'bg-slate-800 text-slate-100 border-slate-600') : (isLight ? 'bg-transparent text-slate-500 border-slate-200 hover:bg-slate-100' : 'bg-transparent text-slate-400 border-slate-700 hover:bg-slate-800')}`}>
                  {labels[f]}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* List */}
      <div className={`flex-1 overflow-y-auto p-2.5 space-y-2 ${isLight ? '' : ''}`}>
        {renderContent}
        {renderContent && (Array.isArray(renderContent) && renderContent.length === 0) && (
          <p className={`text-center text-xs py-8 ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>Sonuç bulunamadı.</p>
        )}
      </div>

      {/* Footer */}
      <div className={`p-2.5 border-t text-[10px] flex items-center justify-between ${isLight ? 'bg-slate-100 border-slate-200 text-slate-500' : 'bg-slate-950/80 border-slate-800/80 text-slate-400'}`}>
        <span className="flex items-center gap-1">
          <Network className={`w-3 h-3 ${isLight ? 'text-cyan-600' : 'text-cyan-400'}`} /> {counts[currentTab]} kayıt
        </span>
        <span className={`font-mono ${isLight ? 'text-cyan-600' : 'text-cyan-400'}`}>GEOGloWS &bull; EPİAŞ</span>
      </div>
    </aside>
  );
};

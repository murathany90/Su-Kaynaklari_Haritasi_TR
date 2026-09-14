import { useEffect } from 'react';
import { Header } from './components/layout/Header';
import { HesToolbar } from './components/layout/HesToolbar';
import { Sidebar } from './components/sidebar/Sidebar';
import { BaseMap } from './components/map/BaseMap';
import { Timeline } from './components/timeline/Timeline';
import { useAppStore } from './store/useAppStore';

function App() {
  const loadHydroData = useAppStore((s) => s.loadHydroData);
  const theme = useAppStore((s) => s.theme);
  const isSidebarOpen = useAppStore((s) => s.isSidebarOpen);
  const isLight = theme === 'light';

  useEffect(() => { void loadHydroData(); }, [loadHydroData]);

  return (
    <div data-theme={theme} className={`hes-app overflow-hidden select-none h-screen w-screen flex flex-col transition-colors duration-300 ${isLight ? 'text-slate-800' : 'text-slate-100'}`}>
      <Header />
      <HesToolbar />
      <div className="relative flex-1 w-full h-full overflow-hidden flex">
        
        {/* Sidebar with slide animation */}
        <div className={`absolute md:relative z-20 h-full overflow-visible transition-all duration-300 shrink-0 ${isSidebarOpen ? 'translate-x-0 md:w-[360px] lg:w-[400px]' : '-translate-x-full md:w-0 md:translate-x-0'}`}>
          <div className={`h-full w-[min(360px,calc(100vw-1.25rem))] lg:w-[400px] transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : 'md:-translate-x-full'}`}>
            <Sidebar />
          </div>
        </div>

        {/* Backdrop overlay for mobile */}
        {isSidebarOpen && (
          <div className="md:hidden absolute inset-0 z-10 bg-black/30" onClick={() => useAppStore.getState().toggleSidebar()} />
        )}

        <div className="relative flex-1 h-full w-full bg-[var(--map-bg)]">
          <BaseMap />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-end p-4 sm:p-5">
            <Timeline />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;

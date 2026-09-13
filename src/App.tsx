import { useEffect } from 'react';
import { Header } from './components/layout/Header';
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
    <div className={`overflow-hidden select-none h-screen w-screen flex flex-col transition-colors duration-300 ${isLight ? 'bg-slate-50 text-slate-800' : 'bg-slate-950 text-slate-100'}`}>
      <Header />
      <div className="relative flex-1 w-full h-full overflow-hidden flex">
        
        {/* Sidebar with slide animation */}
        <div className={`absolute lg:relative z-20 h-full overflow-visible transition-all duration-300 shrink-0 shadow-2xl ${isSidebarOpen ? 'translate-x-0 lg:w-[460px]' : '-translate-x-full lg:w-0 lg:translate-x-0'}`}>
          <div className={`h-full w-[min(460px,calc(100vw-2rem))] transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : 'lg:-translate-x-full'}`}>
            <Sidebar />
          </div>
        </div>

        {/* Backdrop overlay for mobile */}
        {isSidebarOpen && (
          <div className="lg:hidden absolute inset-0 z-10 bg-black/30" onClick={() => useAppStore.getState().toggleSidebar()} />
        )}

        <div className={`relative flex-1 h-full w-full ${isLight ? 'bg-slate-200' : 'bg-slate-900'}`}>
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

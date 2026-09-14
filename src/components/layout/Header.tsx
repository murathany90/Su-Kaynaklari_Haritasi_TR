import React from 'react';
import { Activity, Moon, Sun } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

const navItems = ['PDHES Nedir', 'PDHES Adayları', 'Dünya Örnekleri', 'Harita Gösterim', '3D Yerleşim', 'HESLER', 'Raporlar'];

/**
 * PDHES-style global shell. Navigation is deliberately visual-only in this
 * standalone project: it does not navigate to, import from, or depend on the
 * PDHES application.
 */
export const Header: React.FC = () => {
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const basemap = useAppStore((state) => state.basemap);
  const setBasemap = useAppStore((state) => state.setBasemap);
  const light = theme === 'light';
  const toggleTheme = () => {
    const nextTheme = light ? 'dark' : 'light';
    setTheme(nextTheme);
    if (basemap === 'dark' || basemap === 'light') setBasemap(nextTheme);
  };

  return (
    <header className="hes-global-shell z-30 flex h-14 shrink-0 items-center border-b px-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--primary)] text-white">
          <Activity className="h-4 w-4" />
        </div>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-xs font-semibold tracking-tight sm:text-sm">Türkiye Pompaj Depolamalı HES</div>
          <div className="hidden text-[9px] text-[var(--muted)] sm:block">PDHES Potansiyeli</div>
        </div>
      </div>

      <nav aria-label="PDHES bölümleri" className="mx-5 hidden min-w-0 flex-1 items-center justify-center gap-0.5 lg:flex">
        {navItems.map((item) => {
          const active = item === 'HESLER';
          return (
            <span
              key={item}
              aria-current={active ? 'page' : undefined}
              aria-disabled={!active}
              className={`rounded-lg px-2 py-1.5 text-[10px] font-medium transition ${active ? 'bg-cyan-500/12 text-[var(--primary)]' : 'text-[var(--muted)]'}`}
            >
              {item}
            </span>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        <span className="rounded-md bg-cyan-500/10 px-1.5 py-1 text-[9px] font-semibold text-[var(--primary)] lg:hidden">HESLER</span>
        <button
          type="button"
          onClick={toggleTheme}
          className="rounded-lg border border-[var(--line)] p-2 text-[var(--muted)] transition hover:border-cyan-500/45 hover:text-[var(--primary)]"
          title="Temayı değiştir"
          aria-label="Temayı değiştir"
        >
          {light ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </button>
      </div>
    </header>
  );
};

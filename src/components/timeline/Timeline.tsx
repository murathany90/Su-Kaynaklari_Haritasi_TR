import { useCallback, useEffect } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Pause, Play, Radio } from 'lucide-react';
import { MONTH_NAMES } from '../../data/hydrology';
import { useAppStore } from '../../store/useAppStore';

export function Timeline() {
  const monthIndex = useAppStore((state) => state.timelineMonthIndex);
  const isPlaying = useAppStore((state) => state.isPlayingTimeline);
  const playbackSpeed = useAppStore((state) => state.playbackSpeed);
  const setMonth = useAppStore((state) => state.setTimelineMonth);
  const togglePlayback = useAppStore((state) => state.toggleTimelinePlayback);
  const setSpeed = useAppStore((state) => state.setPlaybackSpeed);
  const theme = useAppStore((state) => state.theme);
  const isLight = theme === 'light';

  useEffect(() => {
    if (!isPlaying) return undefined;
    const interval = window.setInterval(() => {
      const current = useAppStore.getState().timelineMonthIndex;
      useAppStore.getState().setTimelineMonth((current + 1) % 12);
    }, 1500 / playbackSpeed);
    return () => window.clearInterval(interval);
  }, [isPlaying, playbackSpeed]);

  const shiftMonth = useCallback((amount: number) => {
    setMonth((monthIndex + amount + 12) % 12);
  }, [monthIndex, setMonth]);

  const panelClass = isLight
    ? 'border-slate-200/80 bg-white/85 text-slate-800 shadow-xl shadow-slate-400/15'
    : 'border-slate-700/70 bg-[#091426]/85 text-slate-100 shadow-2xl shadow-black/30';
  const mutedClass = isLight ? 'text-slate-500' : 'text-slate-400';
  const controlClass = isLight
    ? 'border-slate-200 bg-white text-slate-600 hover:border-cyan-400 hover:text-cyan-600'
    : 'border-slate-700 bg-slate-900/80 text-slate-300 hover:border-cyan-400 hover:text-cyan-300';

  return (
    <section className={`pointer-events-auto w-[min(440px,calc(100vw-2rem))] rounded-2xl border p-3.5 backdrop-blur-xl transition-colors ${panelClass}`} aria-label="Zaman çizelgesi">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-cyan-500/15 text-cyan-400">
            <CalendarDays className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-[11px] font-bold uppercase tracking-[0.15em]">Hidroloji zamanı</p>
              {isPlaying && <Radio className="h-3.5 w-3.5 animate-pulse text-emerald-400" />}
            </div>
            <p className={`truncate text-[10px] ${mutedClass}`}>Mevsimsel akış ve rezervuar simülasyonu</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {[0.5, 1, 2].map((speed) => (
            <button
              key={speed}
              type="button"
              onClick={() => setSpeed(speed)}
              className={`rounded-md px-1.5 py-1 font-mono text-[10px] transition ${playbackSpeed === speed ? 'bg-cyan-500/20 text-cyan-400' : `${mutedClass} hover:text-cyan-400`}`}
              aria-label={`Oynatma hızı ${speed}x`}
            >
              {speed}x
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={() => shiftMonth(-1)} className={`rounded-lg border p-2 transition ${controlClass}`} aria-label="Önceki ay">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={togglePlayback}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-500/25 transition hover:bg-cyan-300"
          aria-label={isPlaying ? 'Durdur' : 'Oynat'}
        >
          {isPlaying ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="ml-0.5 h-4 w-4" fill="currentColor" />}
        </button>
        <div className="relative flex-1">
          <input
            type="range"
            min="0"
            max="11"
            step="1"
            value={monthIndex}
            onChange={(event) => setMonth(Number(event.target.value))}
            className="timeline-range w-full"
            aria-label="Ay seçimi"
          />
          <div className="mt-1 flex justify-between px-0.5 font-mono text-[9px] text-slate-500">
            <span>Oca</span><span>Mar</span><span>May</span><span>Tem</span><span>Eyl</span><span>Ara</span>
          </div>
        </div>
        <button type="button" onClick={() => shiftMonth(1)} className={`rounded-lg border p-2 transition ${controlClass}`} aria-label="Sonraki ay">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 flex items-center justify-between font-mono text-[11px]">
        <span className="text-cyan-400">2026 / {MONTH_NAMES[monthIndex]}</span>
        <span className={mutedClass}>{isPlaying ? 'Canlı oynatım' : 'Manuel kontrol'}</span>
      </div>
    </section>
  );
}

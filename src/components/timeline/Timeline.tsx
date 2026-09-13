import React, { useEffect, useMemo } from 'react';
import { CalendarClock, ChevronLeft, ChevronRight, Pause, Play, Radio } from 'lucide-react';
import { formatDataDate } from '../../data/hydrology';
import { getForecastTimestamps } from '../../services/hydroData';
import { useAppStore } from '../../store/useAppStore';

export const Timeline: React.FC = () => {
  const theme = useAppStore((s) => s.theme);
  const status = useAppStore((s) => s.hydroDataStatus);
  const manifest = useAppStore((s) => s.dataManifest);
  const geoglows = useAppStore((s) => s.geoglows);
  const epias = useAppStore((s) => s.epias);
  const lastRefreshAt = useAppStore((s) => s.lastRefreshAt);
  const index = useAppStore((s) => s.timelineIndex);
  const isPlaying = useAppStore((s) => s.isPlayingTimeline);
  const setIndex = useAppStore((s) => s.setTimelineIndex);
  const togglePlayback = useAppStore((s) => s.toggleTimelinePlayback);
  const timestamps = useMemo(() => getForecastTimestamps(geoglows), [geoglows]);
  const activeIndex = Math.min(index, Math.max(0, timestamps.length - 1));
  const activeTimestamp = timestamps[activeIndex];

  useEffect(() => {
    if (index >= timestamps.length && timestamps.length) setIndex(0);
    if (isPlaying && timestamps.length < 2) togglePlayback();
  }, [index, isPlaying, setIndex, timestamps.length, togglePlayback]);
  useEffect(() => {
    if (!isPlaying || timestamps.length < 2) return;
    const timer = window.setInterval(() => setIndex((useAppStore.getState().timelineIndex + 1) % timestamps.length), 1200);
    return () => window.clearInterval(timer);
  }, [isPlaying, setIndex, timestamps.length]);

  const light = theme === 'light';
  const panel = light ? 'border-slate-200 bg-white/90 text-slate-800' : 'border-slate-700/70 bg-slate-950/85 text-slate-100';
  const stat = light ? 'border-slate-200 bg-slate-50' : 'border-slate-800 bg-slate-900/70';
  const shift = (delta: number) => { if (timestamps.length) setIndex((activeIndex + delta + timestamps.length) % timestamps.length); };

  return (
    <section className={`pointer-events-auto w-full max-w-xl rounded-2xl border p-3 shadow-2xl shadow-slate-950/40 backdrop-blur-xl ${panel}`}>
      <div className="flex items-center justify-between"><div className="flex items-center gap-2"><CalendarClock className="h-4 w-4 text-cyan-400" /><span className="text-xs font-semibold">GEOGLOWS zaman çizelgesi</span></div><span className={`flex items-center gap-1 font-mono text-[9px] ${status === 'ready' || status === 'partial' ? 'text-emerald-400' : 'text-amber-400'}`}><Radio className="h-3 w-3" />{timestamps.length ? `${activeIndex + 1}/${timestamps.length}` : 'VERİ YOK'}</span></div>
      {timestamps.length > 1 ? <div className="mt-3 flex items-center gap-2"><button type="button" onClick={() => shift(-1)} className="rounded-lg p-1.5 text-slate-500 transition hover:bg-cyan-500/10 hover:text-cyan-400" aria-label="Önceki tahmin zamanı"><ChevronLeft className="h-4 w-4" /></button><button type="button" onClick={togglePlayback} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-500/25 transition hover:bg-cyan-300" aria-label={isPlaying ? 'Durdur' : 'Oynat'}>{isPlaying ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="ml-0.5 h-4 w-4" fill="currentColor" />}</button><input type="range" min="0" max={timestamps.length - 1} step="1" value={activeIndex} onChange={(event) => setIndex(Number(event.target.value))} className="timeline-range w-full" aria-label="GEOGLOWS zaman seçimi" /><button type="button" onClick={() => shift(1)} className="rounded-lg p-1.5 text-slate-500 transition hover:bg-cyan-500/10 hover:text-cyan-400" aria-label="Sonraki tahmin zamanı"><ChevronRight className="h-4 w-4" /></button></div> : <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-2 text-[10px] text-amber-200">Oynatma için gerçek GEOGLOWS zaman serisi bekleniyor.</div>}
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4"><div className={`rounded-xl border p-2 ${stat}`}><div className="font-mono text-[9px] text-slate-500">AKTİF ZAMAN</div><div className="mt-1 text-[10px]">{formatDataDate(activeTimestamp)}</div></div><div className={`rounded-xl border p-2 ${stat}`}><div className="font-mono text-[9px] text-slate-500">BAŞLANGIÇ</div><div className="mt-1 text-[10px]">{formatDataDate(timestamps[0])}</div></div><div className={`rounded-xl border p-2 ${stat}`}><div className="font-mono text-[9px] text-slate-500">BİTİŞ</div><div className="mt-1 text-[10px]">{formatDataDate(timestamps[timestamps.length - 1])}</div></div><div className={`rounded-xl border p-2 ${stat}`}><div className="font-mono text-[9px] text-slate-500">EPİAŞ</div><div className="mt-1 text-[10px]">{epias?.records?.length ?? 0} kayıt</div></div></div>
      <div className="mt-2 border-t border-slate-800 pt-2 font-mono text-[9px] text-slate-500">Son statik senkron: {formatDataDate(lastRefreshAt)} · TATUS {manifest?.layers?.length ?? 0} katman · Sadece gerçek zaman serisi oynatılır</div>
    </section>
  );
};

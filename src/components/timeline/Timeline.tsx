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
  const selectedEntity = useAppStore((s) => s.selectedEntity);
  const rivers = useAppStore((s) => s.rivers);
  const relations = useAppStore((s) => s.hes177Relations);
  const index = useAppStore((s) => s.timelineIndex);
  const isPlaying = useAppStore((s) => s.isPlayingTimeline);
  const setIndex = useAppStore((s) => s.setTimelineIndex);
  const togglePlayback = useAppStore((s) => s.toggleTimelinePlayback);
  const timestamps = useMemo(() => getForecastTimestamps(geoglows), [geoglows]);
  const activeIndex = Math.min(index, Math.max(0, timestamps.length - 1));
  const activeTimestamp = timestamps[activeIndex];
  const selectedRiver = selectedEntity?.type === 'river' ? rivers.features.find((feature) => String(feature.properties?.id ?? feature.id ?? '') === selectedEntity.id) : null;
  const hasSelectedForecast = Boolean(selectedRiver && (Number(selectedRiver.properties?.hesCount ?? 0) > 0 || (relations?.byHesId && Object.values(relations.byHesId).some((relation) => relation.riverIds?.map(String).includes(selectedEntity?.id ?? '') && timestamps.length > 1))));

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
  const shift = (delta: number) => { if (timestamps.length) setIndex((activeIndex + delta + timestamps.length) % timestamps.length); };

  if (!hasSelectedForecast || timestamps.length < 2) return null;

  return (
    <section className={`pointer-events-auto w-full max-w-xs rounded-xl border p-2 shadow-xl shadow-slate-950/40 backdrop-blur-xl ${panel}`}>
      <div className="flex items-center justify-between"><div className="flex items-center gap-1.5"><CalendarClock className="h-3.5 w-3.5 text-cyan-400" /><span className="text-[11px] font-semibold">GEOGLOWS zaman çizelgesi</span></div><span className={`flex items-center gap-1 font-mono text-[8px] ${status === 'ready' || status === 'partial' ? 'text-emerald-400' : 'text-amber-400'}`}><Radio className="h-3 w-3" />{timestamps.length ? `${activeIndex + 1}/${timestamps.length}` : 'VERİ YOK'}</span></div>
      {timestamps.length > 1 ? <div className="mt-2 flex items-center gap-1.5"><button type="button" onClick={() => shift(-1)} className="rounded-md p-1 text-slate-500 transition hover:bg-cyan-500/10 hover:text-cyan-400" aria-label="Önceki tahmin zamanı"><ChevronLeft className="h-3.5 w-3.5" /></button><button type="button" onClick={togglePlayback} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/25 transition hover:bg-cyan-300" aria-label={isPlaying ? 'Durdur' : 'Oynat'}>{isPlaying ? <Pause className="h-3.5 w-3.5" fill="currentColor" /> : <Play className="ml-0.5 h-3.5 w-3.5" fill="currentColor" />}</button><input type="range" min="0" max={timestamps.length - 1} step="1" value={activeIndex} onChange={(event) => setIndex(Number(event.target.value))} className="timeline-range w-full" aria-label="GEOGLOWS zaman seçimi" /><button type="button" onClick={() => shift(1)} className="rounded-md p-1 text-slate-500 transition hover:bg-cyan-500/10 hover:text-cyan-400" aria-label="Sonraki tahmin zamanı"><ChevronRight className="h-3.5 w-3.5" /></button></div> : <div className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-1.5 text-[9px] text-amber-200">Oynatma için gerçek GEOGLOWS zaman serisi bekleniyor.</div>}
      <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-slate-800/70 pt-1.5 font-mono text-[8px] text-slate-500"><span className="truncate">{formatDataDate(activeTimestamp)}</span><span className="shrink-0">EPİAŞ {epias?.records?.length ?? 0}</span><span className="shrink-0">TATUS {manifest?.layers?.length ?? 0}</span></div>
    </section>
  );
};

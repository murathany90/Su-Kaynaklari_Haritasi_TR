import React, { useEffect, useMemo } from 'react';
import { CalendarClock, ChevronLeft, ChevronRight, Pause, Play, Radio } from 'lucide-react';
import { formatDataDate } from '../../data/hydrology';
import { getForecastTimestamps } from '../../services/hydroData';
import { useAppStore } from '../../store/useAppStore';

export const Timeline: React.FC = () => {
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
  const selectedRiverId = selectedEntity?.type === 'river' ? selectedEntity.id : selectedEntity?.type === 'hes' ? relations?.byHesId?.[selectedEntity.id]?.riverSystemId ?? relations?.byHesId?.[selectedEntity.id]?.riverIds?.[0] : null;
  const selectedRiver = selectedRiverId ? rivers.features.find((feature) => String(feature.properties?.id ?? feature.id ?? '') === String(selectedRiverId)) : null;
  const forecastLocalIds = Array.isArray(selectedRiver?.properties?.geoglowsLocalRiverIds) ? selectedRiver.properties.geoglowsLocalRiverIds.map(String) : [String(selectedRiver?.properties?.representativeLocalRiverId ?? '')].filter(Boolean);
  const selectedForecastRecords = useMemo(() => (geoglows?.records ?? []).filter((record) => forecastLocalIds.includes(String(record.localRiverId ?? '')) && Array.isArray(record.data) && record.data.length > 1), [forecastLocalIds, geoglows?.records]);
  const timestamps = useMemo(() => getForecastTimestamps(selectedForecastRecords.length ? { records: selectedForecastRecords } : null), [selectedForecastRecords]);
  const activeIndex = Math.min(index, Math.max(0, timestamps.length - 1));
  const activeTimestamp = timestamps[activeIndex];
  const hasSelectedForecast = selectedForecastRecords.length > 0;

  useEffect(() => {
    if (index >= timestamps.length && timestamps.length) setIndex(0);
    if (isPlaying && timestamps.length < 2) togglePlayback();
  }, [index, isPlaying, setIndex, timestamps.length, togglePlayback]);
  useEffect(() => {
    if (!isPlaying || timestamps.length < 2) return;
    const timer = window.setInterval(() => setIndex((useAppStore.getState().timelineIndex + 1) % timestamps.length), 1200);
    return () => window.clearInterval(timer);
  }, [isPlaying, setIndex, timestamps.length]);

  const panel = 'border-[var(--line)] bg-[var(--panel)] text-[var(--text)]';
  const shift = (delta: number) => { if (timestamps.length) setIndex((activeIndex + delta + timestamps.length) % timestamps.length); };

  if (!hasSelectedForecast || timestamps.length < 2) return null;

  return (
    <section className={`pointer-events-auto w-full max-w-[18rem] rounded-lg border p-2 shadow-lg shadow-slate-950/15 ${panel}`}>
      <div className="flex items-center justify-between"><div className="flex items-center gap-1.5"><CalendarClock className="h-3.5 w-3.5 text-cyan-400" /><span className="text-[11px] font-semibold">GEOGLOWS zaman çizelgesi</span></div><span className={`flex items-center gap-1 font-mono text-[8px] ${status === 'ready' || status === 'partial' ? 'text-emerald-400' : 'text-amber-400'}`}><Radio className="h-3 w-3" />{timestamps.length ? `${activeIndex + 1}/${timestamps.length}` : 'VERİ YOK'}</span></div>
      {timestamps.length > 1 ? <div className="mt-2 flex items-center gap-1.5"><button type="button" onClick={() => shift(-1)} className="rounded-md p-1 text-[var(--muted)] transition hover:bg-cyan-500/10 hover:text-[var(--primary)]" aria-label="Önceki tahmin zamanı"><ChevronLeft className="h-3.5 w-3.5" /></button><button type="button" onClick={togglePlayback} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--primary)] text-white transition hover:bg-[var(--cyan)]" aria-label={isPlaying ? 'Durdur' : 'Oynat'}>{isPlaying ? <Pause className="h-3.5 w-3.5" fill="currentColor" /> : <Play className="ml-0.5 h-3.5 w-3.5" fill="currentColor" />}</button><input type="range" min="0" max={timestamps.length - 1} step="1" value={activeIndex} onChange={(event) => setIndex(Number(event.target.value))} className="timeline-range w-full" aria-label="GEOGLOWS zaman seçimi" /><button type="button" onClick={() => shift(1)} className="rounded-md p-1 text-[var(--muted)] transition hover:bg-cyan-500/10 hover:text-[var(--primary)]" aria-label="Sonraki tahmin zamanı"><ChevronRight className="h-3.5 w-3.5" /></button></div> : <div className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-1.5 text-[9px] text-amber-200">Oynatma için gerçek GEOGLOWS zaman serisi bekleniyor.</div>}
      <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-[var(--line)] pt-1.5 font-mono text-[8px] text-[var(--muted)]"><span className="truncate">{formatDataDate(activeTimestamp)}</span><span className="shrink-0">EPİAŞ {epias?.records?.length ?? 0}</span><span className="shrink-0">TATUS {manifest?.layers?.length ?? 0}</span></div>
    </section>
  );
};

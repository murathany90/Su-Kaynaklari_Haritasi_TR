import React, { useEffect, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { describeFullness, fullnessSourceLabel } from '../../data/fullnessSources';
import type { FullnessHistoryPoint, FullnessResult } from '../../types/hydrology';

export type HesDetailData = {
  id: string;
  name: string;
  basin: string;
  river: string;
  power: number;
  fullness: number | null;
  source: string;
  details?: Record<string, unknown>;
  fullnessResult?: FullnessResult;
};

function formatMw(value: number): string {
  return `${Math.round(value).toLocaleString('tr-TR')} MW`;
}

function numberOf(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDate(value: unknown): string {
  if (typeof value !== 'string' || !value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('tr-TR');
}

function storageLabel(value: unknown): string {
  const map: Record<string, string> = { storage: 'Depolamalı', run_of_river: 'Nehir tipi', regulator: 'Regülatör', mixed: 'Karma', unknown: 'Bilinmiyor' };
  return map[String(value ?? 'unknown')] ?? 'Bilinmiyor';
}

/** Compact selected-HES summary: decision info only, always open. */
export function HesSummaryCard({ data, fullness, isLight, technicalOpen, onToggleTechnical, historyOpen, onToggleHistory }: {
  data: HesDetailData; fullness: FullnessResult | undefined; isLight: boolean;
  technicalOpen: boolean; onToggleTechnical: () => void; historyOpen: boolean; onToggleHistory: () => void;
}): React.ReactNode {
  const described = fullness ? describeFullness(fullness) : null;
  return (
    <div className={`rounded-xl border p-2 ${isLight ? 'border-cyan-200 bg-cyan-50' : 'border-cyan-500/20 bg-cyan-500/5'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] font-semibold text-cyan-400">⚡ {data.name}</span>
        <span className="shrink-0 font-mono text-[11px] font-bold text-sky-300" title={described?.title ?? ''}>
          {data.fullness === null ? '—' : `%${Math.round(data.fullness)}`} {data.source}
        </span>
      </div>
      <div className="mt-0.5 text-[11px] font-semibold">{formatMw(data.power)}</div>
      <div className="truncate text-[9px] text-slate-500">{data.river} · {data.basin}</div>
      <div className="mt-1 text-[9px] text-slate-500" title={described?.title ?? ''}>
        {fullness ? (
          <span>Kaynak: {String(fullness.provider ?? fullnessSourceLabel(fullness))} · </span>
        ) : null}
        <span>Gözlem: {fullness && typeof fullness.observedAt === 'string' && fullness.observedAt ? `${formatDate(fullness.observedAt)} · ${fullness.freshnessDays ?? '—'} gün` : '—'}</span>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-1">
        <button type="button" onClick={onToggleHistory} aria-expanded={historyOpen} className={`rounded-lg px-1 py-1 text-[9px] transition ${historyOpen ? 'bg-cyan-500/15 text-cyan-300' : 'bg-[var(--panel2)] text-[var(--muted)]'}`}>Geçmiş</button>
        <button type="button" onClick={onToggleTechnical} aria-expanded={technicalOpen} className={`rounded-lg px-1 py-1 text-[9px] transition ${technicalOpen ? 'bg-cyan-500/15 text-cyan-300' : 'bg-[var(--panel2)] text-[var(--muted)]'}`}>Teknik bilgiler</button>
      </div>
    </div>
  );
}

/** Engineering details, collapsed by default. */
export function HesTechnicalDetails({ data, fullness }: { data: HesDetailData; fullness: FullnessResult | undefined }): React.ReactNode {
  const details = data.details ?? {};
  const rows: Array<[string, string]> = [
    ['Baraj', String(details.damName ?? '—')],
    ['Depolama', storageLabel(fullness?.storageType ?? details.storageType)],
    ['Sağlayıcı', typeof fullness?.provider === 'string' && fullness.provider ? fullness.provider : '—'],
    ['Yöntem', fullness?.method ?? '—'],
    ['Güven', `${fullness?.confidence ?? '—'}${fullness?.isEstimated ? ' · tahmini' : ''}`],
    ['Min / max kot', `${numberOf(details.minWaterLevelM)?.toLocaleString('tr-TR') ?? '—'} / ${numberOf(details.maxWaterLevelM)?.toLocaleString('tr-TR') ?? '—'} m`],
    ['Min / max hacim', `${numberOf(details.minVolumeHm3)?.toLocaleString('tr-TR') ?? '—'} / ${numberOf(details.maxVolumeHm3)?.toLocaleString('tr-TR') ?? '—'} hm³`],
    ['Aktif hacim', numberOf(details.activeVolumeHm3) !== null ? `${Number(details.activeVolumeHm3).toLocaleString('tr-TR')} hm³` : '—'],
    ['Debi', numberOf(details.unitFlowM3s) !== null ? `${Number(details.unitFlowM3s).toLocaleString('tr-TR')} m³/sn` : '—'],
    ['Kaskat', String(details.cascadeName ?? '—')],
    ['Resmî havza', String(details.officialBasinName ?? '—')],
    ['Gösterim havzası', String(details.displayBasinName ?? details.basinName ?? '—')],
  ];
  return (
    <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg border border-[var(--line)] bg-[var(--panel2)] p-2 text-[9px] text-slate-500">
      {rows.map(([label, value]) => <span key={label}>{label}: <b className="font-semibold text-[var(--text)]">{value}</b></span>)}
    </div>
  );
}

function CompactTrend({ points, isLight }: { points: FullnessHistoryPoint[]; isLight: boolean }): React.ReactNode {
  if (points.length === 0) return <div className="mt-1 text-[9px] text-[var(--muted)]">Geçmiş gözlem yok</div>;
  if (points.length === 1) {
    const only = points[0];
    return <div className="mt-1 text-[9px] text-[var(--muted)]">1 gözlem mevcut · trend için en az 2 gözlem gerekli · %{Math.round(only.value)} ({only.date})</div>;
  }
  const width = 240;
  const height = 80;
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1e-9, max - min);
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${((index / (points.length - 1)) * width).toFixed(1)},${(height - ((point.value - min) / span) * height).toFixed(1)}`).join(' ');
  const first = values[0];
  const last = values[values.length - 1];
  const delta = last - first;
  return (
    <div className="mt-1">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[80px] w-full" role="img" aria-label="Doluluk trendi">
        <path d={path} fill="none" stroke={isLight ? '#087f9a' : '#22d3ee'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="mt-0.5 flex justify-between font-mono text-[8px] text-[var(--muted)]">
        <span>%{Math.round(first)} · {points[0].date}</span>
        <span className={delta >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{delta >= 0 ? '+' : ''}{delta.toFixed(1)}</span>
        <span>%{Math.round(last)} · {points[points.length - 1].date}</span>
      </div>
    </div>
  );
}

/** Time series accordion: lazy-loads history only when opened. */
export function HesHistoryPanel({ hesId, isLight }: { hesId: string; isLight: boolean }): React.ReactNode {
  const fullnessHistory = useAppStore((s) => s.fullnessHistory);
  const historyStatus = useAppStore((s) => s.historyStatus);
  const historicalDate = useAppStore((s) => s.historicalDate);
  const setHistoricalDate = useAppStore((s) => s.setHistoricalDate);
  const loadFullnessHistory = useAppStore((s) => s.loadFullnessHistory);
  const [range, setRange] = useState<7 | 30 | 90 | 365>(30);
  const [calendarOpen, setCalendarOpen] = useState(false);
  useEffect(() => {
    void loadFullnessHistory();
  }, [hesId, loadFullnessHistory]);
  const allPoints = fullnessHistory?.records?.find((record) => record.hesId === hesId)?.points ?? [];
  const points = allPoints.filter((point) => {
    const latest = Date.parse(allPoints.at(-1)?.date ?? '');
    const date = Date.parse(point.date);
    return Number.isFinite(latest) && Number.isFinite(date) ? latest - date <= range * 86400000 : true;
  });
  return (
    <div className="mt-1 rounded-lg border border-[var(--line)] bg-[var(--panel2)] p-2">
      <div className="flex items-center justify-between gap-1" aria-label="Trend aralığı">
        <div className="flex gap-1">
          {([7, 30, 90, 365] as const).map((days) => (
            <button key={days} type="button" onClick={() => setRange(days)} aria-pressed={range === days} className={`rounded px-1.5 py-0.5 font-mono text-[8px] ${range === days ? 'bg-cyan-500/15 text-cyan-400' : 'text-[var(--muted)]'}`}>{days === 365 ? '1Y' : `${days}G`}</button>
          ))}
        </div>
        <button type="button" onClick={() => setCalendarOpen((open) => !open)} aria-expanded={calendarOpen} aria-label="Takvim" title="Tarih seç" className="rounded px-1.5 py-0.5 text-[10px] text-[var(--muted)]">📅</button>
      </div>
      {calendarOpen && (
        <div className="mt-1 flex items-center gap-1">
          <input type="date" value={historicalDate ?? ''} onChange={(event) => setHistoricalDate(event.target.value || null)} aria-label="Tarihsel görünüm tarihi" className="min-w-0 flex-1 rounded border border-[var(--line)] bg-[var(--panel)] px-1 py-1 text-[9px] text-[var(--text)]" />
        </div>
      )}
      {historicalDate && (
        <button type="button" onClick={() => setHistoricalDate(null)} className="mt-1 text-[8px] text-amber-400 underline">Tarihsel görünümden çık / Bugün</button>
      )}
      {historyStatus === 'loading' ? <div className="mt-1 text-[9px] text-[var(--muted)]">Tarihçe yükleniyor…</div> : <CompactTrend points={points} isLight={isLight} />}
    </div>
  );
}

/** Selected-HES detail: summary always open, technical + history collapsed. */
export function HesDetailPanel({ data, fullness, isLight }: { data: HesDetailData; fullness: FullnessResult | undefined; isLight: boolean }): React.ReactNode {
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <div className="mb-2">
      <HesSummaryCard data={data} fullness={fullness} isLight={isLight} technicalOpen={technicalOpen} onToggleTechnical={() => setTechnicalOpen((open) => !open)} historyOpen={historyOpen} onToggleHistory={() => setHistoryOpen((open) => !open)} />
      {technicalOpen && <HesTechnicalDetails data={data} fullness={fullness} />}
      {historyOpen && <HesHistoryPanel key={data.id} hesId={data.id} isLight={isLight} />}
    </div>
  );
}

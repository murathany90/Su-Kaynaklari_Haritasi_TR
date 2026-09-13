export function getRiverColor(flow: number, normalFlow: number): string {
  if (flow < normalFlow * 0.6) return '#fb4f72';
  if (flow > normalFlow * 1.4) return '#47c7ff';
  return '#29d3a2';
}

/** Relative color scale for real forecast rows when no observed baseline is available. */
export function getFlowScaleColor(flow: number, maxFlow: number): string {
  const ratio = maxFlow > 0 ? Math.min(1, Math.max(0, flow / maxFlow)) : 0.5;
  if (ratio < 0.5) return ratio < 0.25 ? '#38bdf8' : '#29d3a2';
  return ratio > 0.8 ? '#f7bf4f' : '#29d3a2';
}

export function getDamColor(occupancy: number): string {
  if (occupancy < 30) return '#fb4f72';
  if (occupancy >= 60) return '#31c9e8';
  return '#f7bf4f';
}

export function formatDataDate(value?: string | null): string {
  if (!value) return 'Veri tarihi yok';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
}

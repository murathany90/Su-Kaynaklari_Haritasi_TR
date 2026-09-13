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

const BASIN_PALETTE_DARK = ['#8fb9b2', '#9ab4d0', '#c3a4b7', '#b8c79a', '#d0b18f', '#98c3c9', '#b5a8cf', '#cfb9a2', '#92bda9', '#b9b0d1', '#c4c59b', '#9bbad0', '#d1aeb2', '#a4c5ae', '#c0b29c', '#a5b9d0', '#c7a9bc', '#a9c5b8', '#d2bd96', '#9bb6c4', '#c0b2cf', '#b8c6a0', '#d0afa3', '#98c0c5', '#c6b09c'];
const BASIN_PALETTE_LIGHT = ['#4f8f88', '#6587a7', '#9b6d88', '#7f9a5c', '#a67b50', '#4f929c', '#806da4', '#9a7655', '#4e8d70', '#866fa6', '#8d925c', '#5d86a7', '#a86e76', '#5f9872', '#8b7155', '#6486a8', '#955f82', '#60917e', '#a27e4d', '#5b8594', '#866ea5', '#7d965d', '#a16d63', '#4e8e98', '#927557'];

export function getBasinColor(basinId: unknown, theme: 'dark' | 'light'): string {
  const numericId = Number(basinId);
  const index = Number.isFinite(numericId) ? Math.abs(Math.round(numericId) - 1) % 25 : 0;
  return (theme === 'light' ? BASIN_PALETTE_LIGHT : BASIN_PALETTE_DARK)[index];
}

export function isUnknownName(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const normalized = String(value).trim().toLocaleLowerCase('tr-TR');
  return !normalized || ['bilinmiyor', 'unknown', 'no_data', 'n/a', 'null'].includes(normalized);
}

export function displayName(properties: Record<string, unknown>, kind: 'river' | 'dam' | 'lake' | 'basin', id: string): string {
  const candidates = kind === 'river' ? [properties.name, properties.adi, properties.riverCode, properties.nehir_kod] : kind === 'dam' ? [properties.name, properties.damName, properties.BarajAdi] : kind === 'lake' ? [properties.name, properties.IstAdi, properties.SuAdi] : [properties.name, properties.HAVZA_ADI, properties.HavzaAdi];
  const value = candidates.find((candidate) => !isUnknownName(candidate));
  if (value !== undefined) return String(value);
  const labels = { river: 'Adsız akarsu', dam: 'Adsız baraj', lake: 'Adsız göl', basin: 'Adsız havza' };
  return `${labels[kind]} #${id}`;
}

export function isElectricProducer(properties: Record<string, unknown>): boolean {
  return [properties.isHes, properties.isHES, properties.hes, properties.energyProducer, properties.producer].some((value) => value === true || value === 'true' || value === 1);
}

export function damIconBucket(occupancy: number | null): string {
  if (occupancy === null) return 'dam-pie-neutral';
  return `dam-pie-${Math.min(100, Math.max(0, Math.round(occupancy / 10) * 10))}`;
}

export function formatDataDate(value?: string | null): string {
  if (!value) return 'Veri tarihi yok';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
}

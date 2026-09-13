import { DAMS_DATA } from './mockData';

export const MONTH_NAMES = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];

export function getSeasonalDamOccupancy(occupancy: number, monthIndex: number): number {
  const factor = monthIndex >= 3 && monthIndex <= 5
    ? 1.12
    : monthIndex >= 7 && monthIndex <= 9
      ? 0.90
      : 1;

  return Math.min(99, Math.max(4, Math.round(occupancy * factor)));
}

export function getDamMetrics(dam: (typeof DAMS_DATA)[number], monthIndex: number) {
  const occupancy = getSeasonalDamOccupancy(dam.occupancy_pct, monthIndex);
  const volume = Math.round((dam.max_storage_hm3 * occupancy) / 100);

  return {
    occupancy,
    volume,
    energy: Math.round(0.0024 * volume * dam.head_m),
  };
}

export function getRiverColor(flow: number, normalFlow: number): string {
  if (flow < normalFlow * 0.6) return '#fb4f72';
  if (flow > normalFlow * 1.4) return '#47c7ff';
  return '#29d3a2';
}

export function getDamColor(occupancy: number): string {
  if (occupancy < 30) return '#fb4f72';
  if (occupancy >= 60) return '#31c9e8';
  return '#f7bf4f';
}

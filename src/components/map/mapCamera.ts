import type { Map as MapLibreMap, LngLatLike } from 'maplibre-gl';
import { BASINS_DATA, DAMS_DATA, LAKES_DATA, RIVERS_DATA } from '../../data/mockData';

type Selection = { type: string; id: string };
type Coordinate = readonly [number, number];

const FOCUS_PADDING = { top: 72, right: 72, bottom: 184, left: 72 };

function findCoordinate(selection: Selection): Coordinate | null {
  if (selection.type === 'dam') {
    return DAMS_DATA.find((item) => item.id === selection.id)?.coords as Coordinate | undefined ?? null;
  }
  if (selection.type === 'lake') {
    return LAKES_DATA.find((item) => item.id === selection.id)?.coords as Coordinate | undefined ?? null;
  }
  if (selection.type === 'basin') {
    return BASINS_DATA.find((item) => item.id === selection.id)?.coords as Coordinate | undefined ?? null;
  }
  return null;
}

function focusPoint(map: MapLibreMap, coordinate: Coordinate, zoom: number): void {
  map.flyTo({
    center: coordinate as LngLatLike,
    zoom,
    padding: FOCUS_PADDING,
    duration: 850,
    essential: true,
  });
}

function focusRiver(map: MapLibreMap, coordinates: readonly Coordinate[]): void {
  const bounds = coordinates.reduce(
    (current, coordinate) => {
      current[0][0] = Math.min(current[0][0], coordinate[0]);
      current[0][1] = Math.min(current[0][1], coordinate[1]);
      current[1][0] = Math.max(current[1][0], coordinate[0]);
      current[1][1] = Math.max(current[1][1], coordinate[1]);
      return current;
    },
    [[Infinity, Infinity], [-Infinity, -Infinity]] as [[number, number], [number, number]],
  );

  map.fitBounds(bounds, {
    padding: FOCUS_PADDING,
    maxZoom: 8.4,
    duration: 950,
    essential: true,
  });
}

/** Moves the camera to the item selected from the sidebar or map. */
export function focusSelectedEntity(map: MapLibreMap, selection: Selection): boolean {
  if (selection.type === 'river') {
    const river = RIVERS_DATA.find((item) => item.id === selection.id);
    if (!river) return false;
    focusRiver(map, river.coords as unknown as readonly Coordinate[]);
    return true;
  }

  const coordinate = findCoordinate(selection);
  if (!coordinate) return false;
  focusPoint(map, coordinate, selection.type === 'basin' ? 7.6 : 9.6);
  return true;
}

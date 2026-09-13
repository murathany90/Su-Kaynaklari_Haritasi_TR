import { create } from 'zustand';
import { loadHydroData as fetchHydroData } from '../services/hydroData';
import { emptyFeatureCollection, type HydroDataManifest, type HydrologyFeatureCollection, type HydroLoadStatus, type GeoglowsPayload, type EpiasPayload, type RiverMappingManifest } from '../types/hydrology';

export type TabType = 'rivers' | 'dams' | 'lakes' | 'basins';
export type FilterType = 'all' | 'drought' | 'normal' | 'flood';
export type ThemeType = 'dark' | 'light';
export type BasemapType = 'dark' | 'light' | 'satellite' | 'streets';

interface AppState {
  currentTab: TabType;
  currentFilter: FilterType;
  searchQuery: string;
  selectedEntity: { type: string; id: string } | null;
  activeTraceType: 'upstream' | 'downstream' | null;
  activeTraceRiverId: string | null;
  layers: {
    rivers: boolean;
    flowStations: boolean;
    hesStations: boolean;
    dams: boolean;
    lakes: boolean;
    basins: boolean;
  };
  // New UI features
  theme: ThemeType;
  basemap: BasemapType;
  isSidebarOpen: boolean;
  timelineIndex: number;
  isPlayingTimeline: boolean;
  hydroDataStatus: HydroLoadStatus;
  hydroDataError: string | null;
  lastRefreshAt: string | null;
  basins: HydrologyFeatureCollection;
  rivers: HydrologyFeatureCollection;
  flowStations: HydrologyFeatureCollection;
  hesStations: HydrologyFeatureCollection;
  damStations: HydrologyFeatureCollection;
  lakes: HydrologyFeatureCollection;
  dataManifest: HydroDataManifest | null;
  mappingManifest: RiverMappingManifest | null;
  geoglows: GeoglowsPayload | null;
  epias: EpiasPayload | null;

  // Actions
  setTab: (tab: TabType) => void;
  setFilter: (filter: FilterType) => void;
  setSearchQuery: (query: string) => void;
  setSelectedEntity: (entity: { type: string; id: string } | null) => void;
  setTrace: (type: 'upstream' | 'downstream' | null, riverId: string | null) => void;
  toggleLayer: (layerName: keyof AppState['layers']) => void;
  
  // New Actions
  setTheme: (theme: ThemeType) => void;
  setBasemap: (basemap: BasemapType) => void;
  toggleSidebar: () => void;
  setTimelineIndex: (index: number) => void;
  toggleTimelinePlayback: () => void;
  loadHydroData: () => Promise<void>;
  refreshHydroData: () => Promise<void>;
}

export const useAppStore = create<AppState>((set) => ({
  currentTab: 'rivers',
  currentFilter: 'all',
  searchQuery: '',
  selectedEntity: null,
  activeTraceType: null,
  activeTraceRiverId: null,
  layers: {
    rivers: true,
    flowStations: false,
    hesStations: false,
    dams: true,
    lakes: true,
    basins: true,
  },
  theme: 'dark',
  basemap: 'dark',
  isSidebarOpen: true,
  timelineIndex: 0,
  isPlayingTimeline: false,
  hydroDataStatus: 'idle',
  hydroDataError: null,
  lastRefreshAt: null,
  basins: emptyFeatureCollection(),
  rivers: emptyFeatureCollection(),
  flowStations: emptyFeatureCollection(),
  hesStations: emptyFeatureCollection(),
  damStations: emptyFeatureCollection(),
  lakes: emptyFeatureCollection(),
  dataManifest: null,
  mappingManifest: null,
  geoglows: null,
  epias: null,

  setTab: (tab) => set({ currentTab: tab }),
  setFilter: (filter) => set({ currentFilter: filter }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSelectedEntity: (entity) => set({ selectedEntity: entity }),
  setTrace: (type, riverId) => set({ activeTraceType: type, activeTraceRiverId: riverId }),
  toggleLayer: (layerName) => set((state) => ({
    layers: { ...state.layers, [layerName]: !state.layers[layerName] }
  })),
  
  setTheme: (theme) => set({ theme }),
  setBasemap: (basemap) => set({ basemap }),
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  setTimelineIndex: (index) => set({ timelineIndex: Math.max(0, Math.round(index)) }),
  toggleTimelinePlayback: () => set((state) => ({ isPlayingTimeline: !state.isPlayingTimeline })),
  loadHydroData: async () => {
    if (useAppStore.getState().hydroDataStatus === 'loading') return;
    set({ hydroDataStatus: 'loading', hydroDataError: null });
    try {
      const data = await fetchHydroData();
      const staticLoaded = [data.basins, data.rivers, data.flowStations, data.hesStations, data.damStations, data.lakes]
        .every((collection) => collection.features.length > 0);
      const livePartial = Boolean(data.geoglows && !['ok', 'no_reviewed_mappings'].includes(data.geoglows.status ?? ''))
        || Boolean(data.epias && data.epias.status !== 'ok');
      set({
        hydroDataStatus: data.errors.length || livePartial ? (staticLoaded ? 'partial' : 'failed') : 'ready',
        hydroDataError: data.errors.length ? data.errors.join(' | ') : null,
        lastRefreshAt: new Date().toISOString(),
        basins: data.basins,
        rivers: data.rivers,
        flowStations: data.flowStations,
        hesStations: data.hesStations,
        damStations: data.damStations,
        lakes: data.lakes,
        dataManifest: data.manifest,
        mappingManifest: data.mappingManifest,
        geoglows: data.geoglows,
        epias: data.epias,
      });
    } catch (error) {
      set({ hydroDataStatus: 'failed', hydroDataError: error instanceof Error ? error.message : String(error) });
    }
  },
  refreshHydroData: async () => {
    set({ hydroDataStatus: 'idle' });
    await useAppStore.getState().loadHydroData();
  },
}));

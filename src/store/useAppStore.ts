import { create } from 'zustand';
import { loadFullnessHistory, loadHydroData as fetchHydroData } from '../services/hydroData';
import { emptyFeatureCollection, type FullnessHistoryPayload, type Hes177Relations, type HydroDataManifest, type HydrologyFeatureCollection, type HydroLoadStatus, type GeoglowsPayload, type EpiasPayload, type RiverMappingManifest, type FullnessPayload } from '../types/hydrology';

export type TabType = 'hes' | 'rivers' | 'basins';
export type ThemeType = 'dark' | 'light';
export type BasemapType = 'dark' | 'light' | 'neutral' | 'satellite' | 'streets';

interface AppState {
  currentTab: TabType;
  searchQuery: string;
  selectedEntity: { type: string; id: string } | null;
  activeTraceType: 'upstream' | 'downstream' | null;
  activeTraceRiverId: string | null;
  layers: {
    rivers: boolean;
    dams: boolean;
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
  damStations: HydrologyFeatureCollection;
  hes177: HydrologyFeatureCollection;
  cascades: HydrologyFeatureCollection;
  catchment: HydrologyFeatureCollection;
  reservoirs: HydrologyFeatureCollection;
  hes177Relations: Hes177Relations | null;
  dataManifest: HydroDataManifest | null;
  hes177Manifest: HydroDataManifest | null;
  mappingManifest: RiverMappingManifest | null;
  geoglows: GeoglowsPayload | null;
  epias: EpiasPayload | null;
  fullness: FullnessPayload | null;
  fullnessHistory: FullnessHistoryPayload | null;
  historyStatus: 'idle' | 'loading' | 'ready' | 'failed';
  historyError: string | null;
  historicalDate: string | null;
  dataMode: 'mock' | 'epias';
  flowVisualization: boolean;
  activeCatchmentHesId: string | null;

  // Actions
  setTab: (tab: TabType) => void;
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
  loadFullnessHistory: () => Promise<void>;
  setHistoricalDate: (date: string | null) => void;
  setDataMode: (mode: 'mock' | 'epias') => void;
  toggleFlowVisualization: () => void;
  toggleCatchment: (hesId: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentTab: 'hes',
  searchQuery: '',
  selectedEntity: null,
  activeTraceType: null,
  activeTraceRiverId: null,
  layers: {
    rivers: true,
    dams: true,
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
  damStations: emptyFeatureCollection(),
  hes177: emptyFeatureCollection(),
  cascades: emptyFeatureCollection(),
  catchment: emptyFeatureCollection(),
  reservoirs: emptyFeatureCollection(),
  hes177Relations: null,
  dataManifest: null,
  hes177Manifest: null,
  mappingManifest: null,
  geoglows: null,
  epias: null,
  fullness: null,
  fullnessHistory: null,
  historyStatus: 'idle',
  historyError: null,
  historicalDate: null,
  dataMode: 'epias',
  flowVisualization: false,
  activeCatchmentHesId: null,

  setTab: (tab) => set({ currentTab: tab }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSelectedEntity: (entity) => set((state) => ({ selectedEntity: entity, historicalDate: entity?.type === 'hes' ? state.historicalDate : null })),
  setTrace: (type, riverId) => set({ activeTraceType: type, activeTraceRiverId: riverId }),
  toggleLayer: (layerName) => set((state) => ({
    layers: { ...state.layers, [layerName]: !state.layers[layerName] }
  })),
  
  setTheme: (theme) => set({ theme }),
  setBasemap: (basemap) => set({ basemap }),
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  setTimelineIndex: (index) => set({ timelineIndex: Math.max(0, Math.round(index)) }),
  toggleTimelinePlayback: () => set((state) => ({ isPlayingTimeline: !state.isPlayingTimeline })),
  setDataMode: (dataMode) => set({ dataMode }),
  toggleFlowVisualization: () => set((state) => ({ flowVisualization: !state.flowVisualization })),
  setHistoricalDate: (historicalDate) => set({ historicalDate }),
  toggleCatchment: (hesId) => set((state) => ({ activeCatchmentHesId: state.activeCatchmentHesId === hesId ? null : hesId })),
  loadHydroData: async () => {
    if (useAppStore.getState().hydroDataStatus === 'loading') return;
    set({ hydroDataStatus: 'loading', hydroDataError: null });
    try {
      const data = await fetchHydroData();
      const staticLoaded = [data.basins, data.rivers, data.hes177].every((collection) => collection.features.length > 0);
      const livePartial = Boolean(data.geoglows && !['ok', 'no_reviewed_mappings'].includes(data.geoglows.status ?? ''))
        || Boolean(data.epias && data.epias.status !== 'ok');
      set({
        hydroDataStatus: data.errors.length || livePartial ? (staticLoaded ? 'partial' : 'failed') : 'ready',
        hydroDataError: data.errors.length ? data.errors.join(' | ') : null,
        lastRefreshAt: new Date().toISOString(),
        basins: data.basins,
        rivers: data.rivers,
        damStations: data.damStations,
        hes177: data.hes177,
        cascades: data.cascades,
        catchment: data.catchment,
        reservoirs: data.reservoirs,
        hes177Relations: data.hes177Relations,
        dataManifest: data.manifest,
        hes177Manifest: data.hes177Manifest,
        mappingManifest: data.mappingManifest,
        geoglows: data.geoglows,
        epias: data.epias,
        fullness: data.fullness,
      });
    } catch (error) {
      set({ hydroDataStatus: 'failed', hydroDataError: error instanceof Error ? error.message : String(error) });
    }
  },
  refreshHydroData: async () => {
    set({ hydroDataStatus: 'idle' });
    await useAppStore.getState().loadHydroData();
  },
  loadFullnessHistory: async () => {
    const state = useAppStore.getState();
    if (state.historyStatus === 'loading' || state.historyStatus === 'ready') return;
    set({ historyStatus: 'loading', historyError: null });
    try {
      const history = await loadFullnessHistory(state.hes177Manifest?.dataVersion ?? null);
      set({ fullnessHistory: history, historyStatus: 'ready' });
    } catch (error) {
      set({ historyStatus: 'failed', historyError: error instanceof Error ? error.message : String(error) });
    }
  },
}));

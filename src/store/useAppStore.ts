import { create } from 'zustand';

export type TabType = 'rivers' | 'dams' | 'lakes' | 'basins';
export type FilterType = 'all' | 'drought' | 'normal' | 'flood';
export type ThemeType = 'dark' | 'light';
export type BasemapType = 'dark' | 'light' | 'satellite' | 'streets';

interface AppState {
  currentTab: TabType;
  currentFilter: FilterType;
  searchQuery: string;
  timelineMonthIndex: number;
  isPlayingTimeline: boolean;
  playbackSpeed: number;
  selectedEntity: { type: string; id: string } | null;
  activeTraceType: 'upstream' | 'downstream' | null;
  activeTraceRiverId: string | null;
  layers: {
    flowParticles: boolean;
    rivers: boolean;
    dams: boolean;
    cascades: boolean;
    lakes: boolean;
    basins: boolean;
  };
  // New UI features
  theme: ThemeType;
  basemap: BasemapType;
  isSidebarOpen: boolean;

  // Actions
  setTab: (tab: TabType) => void;
  setFilter: (filter: FilterType) => void;
  setSearchQuery: (query: string) => void;
  setTimelineMonth: (index: number) => void;
  toggleTimelinePlayback: () => void;
  setPlaybackSpeed: (speed: number) => void;
  setSelectedEntity: (entity: { type: string; id: string } | null) => void;
  setTrace: (type: 'upstream' | 'downstream' | null, riverId: string | null) => void;
  toggleLayer: (layerName: keyof AppState['layers']) => void;
  
  // New Actions
  setTheme: (theme: ThemeType) => void;
  setBasemap: (basemap: BasemapType) => void;
  toggleSidebar: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentTab: 'rivers',
  currentFilter: 'all',
  searchQuery: '',
  timelineMonthIndex: 8, // September
  isPlayingTimeline: false,
  playbackSpeed: 1,
  selectedEntity: null,
  activeTraceType: null,
  activeTraceRiverId: null,
  layers: {
    flowParticles: true,
    rivers: true,
    dams: true,
    cascades: true,
    lakes: true,
    basins: true,
  },
  theme: 'dark',
  basemap: 'dark',
  isSidebarOpen: true,

  setTab: (tab) => set({ currentTab: tab }),
  setFilter: (filter) => set({ currentFilter: filter }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setTimelineMonth: (index) => set({ timelineMonthIndex: Math.max(0, Math.min(11, Math.round(index))) }),
  toggleTimelinePlayback: () => set((state) => ({ isPlayingTimeline: !state.isPlayingTimeline })),
  setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),
  setSelectedEntity: (entity) => set({ selectedEntity: entity }),
  setTrace: (type, riverId) => set({ activeTraceType: type, activeTraceRiverId: riverId }),
  toggleLayer: (layerName) => set((state) => ({
    layers: { ...state.layers, [layerName]: !state.layers[layerName] }
  })),
  
  setTheme: (theme) => set({ theme }),
  setBasemap: (basemap) => set({ basemap }),
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
}));

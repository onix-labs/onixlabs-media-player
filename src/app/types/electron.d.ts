export interface OpenDialogOptions {
  filters: { name: string; extensions: string[] }[];
  multiSelections: boolean;
}

export interface MediaInfo {
  duration: number;
  type: 'audio' | 'video';
  title: string;
  artist?: string;
  album?: string;
  filePath: string;
  width?: number;
  height?: number;
}

export interface PlaylistItem {
  id: string;
  filePath: string;
  title: string;
  artist?: string;
  album?: string;
  duration: number;
  type: 'audio' | 'video';
  width?: number;
  height?: number;
}

export interface PlaylistState {
  items: PlaylistItem[];
  currentIndex: number;
  shuffleEnabled: boolean;
  repeatEnabled: boolean;
}

export interface PlaybackState {
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error';
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  currentMedia: MediaInfo | null;
  errorMessage: string | null;
}

// Simplified preload API - only IPC-required operations
export interface MediaPlayerAPI {
  openFileDialog: (options: OpenDialogOptions) => Promise<string[]>;
  getPathForFile: (file: File) => string;
  getServerPort: () => Promise<number>;
  enterFullscreen: () => Promise<void>;
  exitFullscreen: () => Promise<void>;
  isFullscreen: () => Promise<boolean>;
  onFullscreenChange: (callback: (isFullscreen: boolean) => void) => () => void;
}

declare global {
  interface Window {
    mediaPlayer?: MediaPlayerAPI;
  }
}

export {};

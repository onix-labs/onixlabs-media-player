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

export interface AudioChunk {
  data: ArrayBuffer | number[];
  timestamp: number;
}

export interface VideoFrame {
  data: string;
  timestamp: number;
  width: number;
  height: number;
}

export interface MediaPlayerAPI {
  openFileDialog: (options: OpenDialogOptions) => Promise<string[]>;
  loadMedia: (filePath: string) => Promise<MediaInfo>;
  getMediaUrl: (filePath: string) => Promise<string>;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  seek: (timeSeconds: number) => Promise<void>;
  setVolume: (volume: number) => Promise<void>;
  stop: () => Promise<void>;
  onAudioData: (callback: (data: AudioChunk) => void) => () => void;
  onVideoFrame: (callback: (frame: VideoFrame) => void) => () => void;
  onVideoChunk: (callback: (chunk: number[]) => void) => () => void;
  onTimeUpdate: (callback: (time: number) => void) => () => void;
  onDurationChange: (callback: (duration: number) => void) => () => void;
  onMediaEnd: (callback: () => void) => () => void;
  onError: (callback: (error: string) => void) => () => void;
  onStateChange: (callback: (state: string) => void) => () => void;
}

declare global {
  interface Window {
    mediaPlayer?: MediaPlayerAPI;
  }
}

export {};

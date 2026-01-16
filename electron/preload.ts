import { contextBridge, ipcRenderer } from 'electron';

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
  getVideoUrl: (filePath: string) => Promise<string>;
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

const api: MediaPlayerAPI = {
  openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options),
  loadMedia: (filePath) => ipcRenderer.invoke('media:load', filePath),
  getMediaUrl: (filePath) => ipcRenderer.invoke('media:getUrl', filePath),
  getVideoUrl: (filePath) => ipcRenderer.invoke('media:getVideoUrl', filePath),
  play: () => ipcRenderer.invoke('media:play'),
  pause: () => ipcRenderer.invoke('media:pause'),
  resume: () => ipcRenderer.invoke('media:resume'),
  seek: (time) => ipcRenderer.invoke('media:seek', time),
  setVolume: (volume) => ipcRenderer.invoke('media:setVolume', volume),
  stop: () => ipcRenderer.invoke('media:stop'),

  onAudioData: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, data: AudioChunk) => callback(data);
    ipcRenderer.on('media:audioData', handler);
    return () => { ipcRenderer.removeListener('media:audioData', handler); };
  },

  onVideoFrame: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, frame: VideoFrame) => callback(frame);
    ipcRenderer.on('media:videoFrame', handler);
    return () => { ipcRenderer.removeListener('media:videoFrame', handler); };
  },

  onVideoChunk: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, chunk: number[]) => callback(chunk);
    ipcRenderer.on('media:videoChunk', handler);
    return () => { ipcRenderer.removeListener('media:videoChunk', handler); };
  },

  onTimeUpdate: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, time: number) => callback(time);
    ipcRenderer.on('media:timeUpdate', handler);
    return () => { ipcRenderer.removeListener('media:timeUpdate', handler); };
  },

  onDurationChange: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, duration: number) => callback(duration);
    ipcRenderer.on('media:durationChange', handler);
    return () => { ipcRenderer.removeListener('media:durationChange', handler); };
  },

  onMediaEnd: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('media:ended', handler);
    return () => { ipcRenderer.removeListener('media:ended', handler); };
  },

  onError: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, error: string) => callback(error);
    ipcRenderer.on('media:error', handler);
    return () => { ipcRenderer.removeListener('media:error', handler); };
  },

  onStateChange: (callback) => {
    const handler = (_: Electron.IpcRendererEvent, state: string) => callback(state);
    ipcRenderer.on('media:stateChange', handler);
    return () => { ipcRenderer.removeListener('media:stateChange', handler); };
  }
};

contextBridge.exposeInMainWorld('mediaPlayer', api);

import { contextBridge, ipcRenderer, webUtils } from 'electron';

export interface OpenDialogOptions {
  readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
  readonly multiSelections: boolean;
}

export interface MediaPlayerAPI {
  // File operations (IPC required)
  readonly openFileDialog: (options: Readonly<OpenDialogOptions>) => Promise<string[]>;
  readonly getPathForFile: (file: Readonly<File>) => string;

  // Server connection (IPC required for initial port)
  readonly getServerPort: () => Promise<number>;

  // Fullscreen control (IPC required)
  readonly enterFullscreen: () => Promise<void>;
  readonly exitFullscreen: () => Promise<void>;
  readonly isFullscreen: () => Promise<boolean>;
  readonly onFullscreenChange: (callback: (isFullscreen: boolean) => void) => () => void;
}

const api: MediaPlayerAPI = {
  openFileDialog: (options: Readonly<OpenDialogOptions>): Promise<string[]> => ipcRenderer.invoke('dialog:openFile', options),
  getPathForFile: (file: Readonly<File>): string => webUtils.getPathForFile(file),
  getServerPort: (): Promise<number> => ipcRenderer.invoke('app:getServerPort'),
  enterFullscreen: (): Promise<void> => ipcRenderer.invoke('window:enterFullscreen'),
  exitFullscreen: (): Promise<void> => ipcRenderer.invoke('window:exitFullscreen'),
  isFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:isFullscreen'),
  onFullscreenChange: (callback: (isFullscreen: boolean) => void): () => void => {
    const listener: (_event: Electron.IpcRendererEvent, isFullscreen: boolean) => void = (_event: Electron.IpcRendererEvent, isFullscreen: boolean): void => callback(isFullscreen);
    ipcRenderer.on('window:fullscreenChanged', listener);
    return (): void => { ipcRenderer.removeListener('window:fullscreenChanged', listener); };
  },
};

contextBridge.exposeInMainWorld('mediaPlayer', api);

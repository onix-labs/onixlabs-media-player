import { contextBridge, ipcRenderer, webUtils } from 'electron';

export interface OpenDialogOptions {
  filters: { name: string; extensions: string[] }[];
  multiSelections: boolean;
}

export interface MediaPlayerAPI {
  // File operations (IPC required)
  openFileDialog: (options: OpenDialogOptions) => Promise<string[]>;
  getPathForFile: (file: File) => string;

  // Server connection (IPC required for initial port)
  getServerPort: () => Promise<number>;
}

const api: MediaPlayerAPI = {
  openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getServerPort: () => ipcRenderer.invoke('app:getServerPort'),
};

contextBridge.exposeInMainWorld('mediaPlayer', api);

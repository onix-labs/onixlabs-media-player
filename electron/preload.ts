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
}

const api: MediaPlayerAPI = {
  openFileDialog: (options: Readonly<OpenDialogOptions>): Promise<string[]> => ipcRenderer.invoke('dialog:openFile', options),
  getPathForFile: (file: Readonly<File>): string => webUtils.getPathForFile(file),
  getServerPort: (): Promise<number> => ipcRenderer.invoke('app:getServerPort'),
};

contextBridge.exposeInMainWorld('mediaPlayer', api);

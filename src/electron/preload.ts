/**
 * @fileoverview Electron preload script that bridges main and renderer processes.
 *
 * This script runs in a privileged context with access to Node.js and Electron APIs,
 * but exposes only a controlled subset to the renderer via contextBridge. This is
 * a security best practice - the renderer gets a minimal API surface.
 *
 * The preload script provides:
 * - File dialog access for opening media files
 * - Path resolution for drag-and-drop files
 * - Server port retrieval for HTTP API connection
 * - Fullscreen control and state observation
 *
 * Note: This file must be compiled to JavaScript before use because Electron
 * cannot execute TypeScript preload scripts directly.
 *
 * @module electron/preload
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * Options for the native file open dialog.
 *
 * @property filters - File type filters shown in the dialog (e.g., "Audio Files")
 * @property multiSelections - Whether to allow selecting multiple files
 */
export interface OpenDialogOptions {
  /** File type filters with display name and allowed extensions */
  readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
  /** Whether multiple file selection is allowed */
  readonly multiSelections: boolean;
}

/**
 * API exposed to the renderer process via window.mediaPlayer.
 *
 * This interface defines the complete set of functionality available to the
 * Angular application for interacting with native Electron features.
 *
 * Design principles:
 * - Minimal surface area (only what's needed)
 * - IPC only for native operations (file dialogs, fullscreen)
 * - Media operations use HTTP API instead (not exposed here)
 *
 * @example
 * // In renderer (Angular)
 * const files = await window.mediaPlayer.openFileDialog({
 *   filters: [{ name: 'Audio', extensions: ['mp3', 'wav'] }],
 *   multiSelections: true
 * });
 */
export interface MediaPlayerAPI {
  /**
   * Opens the native file picker dialog.
   * Requires IPC because dialogs must be shown from the main process.
   *
   * @param options - Dialog configuration including file filters
   * @returns Promise resolving to array of selected file paths
   */
  readonly openFileDialog: (options: Readonly<OpenDialogOptions>) => Promise<string[]>;

  /**
   * Gets the absolute file system path for a File object.
   * Used for drag-and-drop where we receive File objects but need paths.
   *
   * @param file - The File object from a drag-and-drop event
   * @returns The absolute path to the file
   */
  readonly getPathForFile: (file: Readonly<File>) => string;

  /**
   * Gets the port number of the unified media server.
   * Called once at startup to establish HTTP API connection.
   *
   * @returns Promise resolving to the server port number
   */
  readonly getServerPort: () => Promise<number>;

  /**
   * Enters fullscreen mode.
   * Uses native Electron fullscreen (not HTML5 fullscreen API).
   *
   * @returns Promise that resolves when fullscreen is entered
   */
  readonly enterFullscreen: () => Promise<void>;

  /**
   * Exits fullscreen mode.
   *
   * @returns Promise that resolves when fullscreen is exited
   */
  readonly exitFullscreen: () => Promise<void>;

  /**
   * Queries the current fullscreen state.
   *
   * @returns Promise resolving to true if fullscreen, false otherwise
   */
  readonly isFullscreen: () => Promise<boolean>;

  /**
   * Registers a callback for fullscreen state changes.
   * Called when fullscreen changes via any method (API, green button, etc.).
   *
   * @param callback - Function called with new fullscreen state
   * @returns Cleanup function to remove the listener
   */
  readonly onFullscreenChange: (callback: (isFullscreen: boolean) => void) => () => void;

  /**
   * Registers a callback for menu events.
   * Called when user selects menu items from the application menu.
   *
   * @param event - The menu event name
   * @param callback - Function called when the menu event fires
   * @returns Cleanup function to remove the listener
   */
  readonly onMenuEvent: (event: string, callback: (...args: unknown[]) => void) => () => void;
}

/**
 * The API implementation that will be exposed to the renderer.
 *
 * Each method maps to either:
 * - An IPC invoke call (for main process operations)
 * - A direct Electron utility call (for webUtils)
 * - An IPC event listener (for state change notifications)
 */
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
  onMenuEvent: (event: string, callback: (...args: unknown[]) => void): () => void => {
    const channel: string = `menu:${event}`;
    const listener: (_event: Electron.IpcRendererEvent, ...args: unknown[]) => void = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => callback(...args);
    ipcRenderer.on(channel, listener);
    return (): void => { ipcRenderer.removeListener(channel, listener); };
  },
};

/**
 * Expose the API to the renderer process under window.mediaPlayer.
 *
 * contextBridge.exposeInMainWorld creates a secure bridge that:
 * - Prevents renderer from accessing Node.js or Electron directly
 * - Serializes data crossing the bridge (no object references leak)
 * - Provides type-safe API access from the renderer
 */
contextBridge.exposeInMainWorld('mediaPlayer', api);

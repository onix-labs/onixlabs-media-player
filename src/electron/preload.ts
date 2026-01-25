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

import { contextBridge, ipcRenderer, webUtils, shell } from 'electron';

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
   * Gets platform information including glass effect support.
   * Used by the settings UI to show/hide platform-specific options.
   *
   * @returns Promise resolving to platform info object
   */
  readonly getPlatformInfo: () => Promise<{
    /** Platform identifier: 'darwin', 'win32', or 'linux' */
    platform: string;
    /** Whether the platform supports glass effects (vibrancy/acrylic) */
    supportsGlass: boolean;
    /** System color scheme: 'dark' or 'light' */
    systemTheme: 'dark' | 'light';
  }>;

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

  /**
   * Enters miniplayer mode.
   * Resizes window to compact size, sets always-on-top, and positions in corner.
   *
   * @returns Promise that resolves when miniplayer mode is entered
   */
  readonly enterMiniplayer: () => Promise<void>;

  /**
   * Exits miniplayer mode and returns to desktop mode.
   * Restores window size, removes always-on-top, and restores previous bounds.
   *
   * @returns Promise that resolves when miniplayer mode is exited
   */
  readonly exitMiniplayer: () => Promise<void>;

  /**
   * Gets the current view mode of the window.
   *
   * @returns Promise resolving to 'desktop', 'miniplayer', or 'fullscreen'
   */
  readonly getViewMode: () => Promise<'desktop' | 'miniplayer' | 'fullscreen'>;

  /**
   * Sets the window position with magnetic edge snapping.
   * When position is near screen edges, snaps to the edge.
   *
   * @param position - The desired position {x, y}
   * @returns Promise resolving to the actual position after snapping
   */
  readonly setWindowPosition: (position: Readonly<{x: number; y: number}>) => Promise<{x: number; y: number}>;

  /**
   * Gets the current window position.
   *
   * @returns Promise resolving to the current position {x, y}
   */
  readonly getWindowPosition: () => Promise<{x: number; y: number}>;

  /**
   * Sets the visibility of the macOS traffic light buttons.
   * Only affects macOS; no-op on other platforms.
   *
   * @param visible - Whether the traffic lights should be visible
   */
  readonly setTrafficLightVisibility: (visible: boolean) => Promise<void>;

  /**
   * Saves the current miniplayer bounds to settings.
   * Called after drag ends or resize completes in miniplayer mode.
   */
  readonly saveMiniplayerBounds: () => Promise<void>;

  /**
   * Registers a callback for view mode changes.
   * Called when the window mode changes between desktop, miniplayer, and fullscreen.
   *
   * @param callback - Function called with new view mode
   * @returns Cleanup function to remove the listener
   */
  readonly onViewModeChange: (callback: (mode: 'desktop' | 'miniplayer' | 'fullscreen') => void) => () => void;

  /**
   * Opens a URL in the default system browser.
   *
   * @param url - The URL to open
   * @returns Promise that resolves when the URL is opened
   */
  readonly openExternal: (url: string) => Promise<void>;

  /**
   * Gets version information for Electron and its components.
   *
   * @returns Object containing electron, node, chrome, and v8 versions
   */
  readonly getVersionInfo: () => {electron: string; node: string; chrome: string; v8: string};

  /**
   * Registers a callback for the prepare-for-close event.
   * Called by main process when the window is about to close,
   * allowing the renderer to fade out audio before the window is destroyed.
   *
   * @param callback - Function called with fade duration in milliseconds
   * @returns Cleanup function to remove the listener
   */
  readonly onPrepareForClose: (callback: (fadeDuration: number) => void) => () => void;

  /**
   * Notifies the main process that the fade-out is complete.
   * Should be called after fading out audio in response to onPrepareForClose.
   */
  readonly notifyFadeOutComplete: () => void;

  /**
   * Sets the configuration mode state in the main process.
   * Used to track whether the renderer is showing the settings view.
   *
   * @param enabled - Whether configuration mode is active
   */
  readonly setConfigurationMode: (enabled: boolean) => Promise<void>;

  /**
   * Registers a callback for when the close button is pressed in configuration mode.
   * The main process intercepts the close and tells the renderer to exit config mode instead.
   *
   * @param callback - Function called when close is pressed in configuration mode
   * @returns Cleanup function to remove the listener
   */
  readonly onExitConfigurationMode: (callback: () => void) => () => void;
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
  getPlatformInfo: (): Promise<{platform: string; supportsGlass: boolean; systemTheme: 'dark' | 'light'}> => ipcRenderer.invoke('app:getPlatformInfo'),
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
  enterMiniplayer: (): Promise<void> => ipcRenderer.invoke('window:enterMiniplayer'),
  exitMiniplayer: (): Promise<void> => ipcRenderer.invoke('window:exitMiniplayer'),
  getViewMode: (): Promise<'desktop' | 'miniplayer' | 'fullscreen'> => ipcRenderer.invoke('window:getViewMode'),
  setWindowPosition: (position: Readonly<{x: number; y: number}>): Promise<{x: number; y: number}> => ipcRenderer.invoke('window:setWindowPosition', position),
  getWindowPosition: (): Promise<{x: number; y: number}> => ipcRenderer.invoke('window:getWindowPosition'),
  setTrafficLightVisibility: (visible: boolean): Promise<void> => ipcRenderer.invoke('window:setTrafficLightVisibility', visible),
  saveMiniplayerBounds: (): Promise<void> => ipcRenderer.invoke('window:saveMiniplayerBounds'),
  onViewModeChange: (callback: (mode: 'desktop' | 'miniplayer' | 'fullscreen') => void): () => void => {
    const listener: (_event: Electron.IpcRendererEvent, mode: 'desktop' | 'miniplayer' | 'fullscreen') => void = (_event: Electron.IpcRendererEvent, mode: 'desktop' | 'miniplayer' | 'fullscreen'): void => callback(mode);
    ipcRenderer.on('window:viewModeChanged', listener);
    return (): void => { ipcRenderer.removeListener('window:viewModeChanged', listener); };
  },
  openExternal: (url: string): Promise<void> => shell.openExternal(url),
  getVersionInfo: (): {electron: string; node: string; chrome: string; v8: string} => ({
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    v8: process.versions.v8,
  }),
  onPrepareForClose: (callback: (fadeDuration: number) => void): () => void => {
    const listener: (_event: Electron.IpcRendererEvent, fadeDuration: number) => void = (_event: Electron.IpcRendererEvent, fadeDuration: number): void => callback(fadeDuration);
    ipcRenderer.on('app:prepareForClose', listener);
    return (): void => { ipcRenderer.removeListener('app:prepareForClose', listener); };
  },
  notifyFadeOutComplete: (): void => {
    ipcRenderer.invoke('app:fadeOutComplete');
  },
  setConfigurationMode: (enabled: boolean): Promise<void> => ipcRenderer.invoke('app:setConfigurationMode', enabled),
  onExitConfigurationMode: (callback: () => void): () => void => {
    const listener: () => void = (): void => callback();
    ipcRenderer.on('app:exitConfigurationMode', listener);
    return (): void => { ipcRenderer.removeListener('app:exitConfigurationMode', listener); };
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

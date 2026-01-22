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
 * The API implementation that will be exposed to the renderer.
 *
 * Each method maps to either:
 * - An IPC invoke call (for main process operations)
 * - A direct Electron utility call (for webUtils)
 * - An IPC event listener (for state change notifications)
 */
const api = {
    openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options),
    getPathForFile: (file) => webUtils.getPathForFile(file),
    getServerPort: () => ipcRenderer.invoke('app:getServerPort'),
    enterFullscreen: () => ipcRenderer.invoke('window:enterFullscreen'),
    exitFullscreen: () => ipcRenderer.invoke('window:exitFullscreen'),
    isFullscreen: () => ipcRenderer.invoke('window:isFullscreen'),
    onFullscreenChange: (callback) => {
        const listener = (_event, isFullscreen) => callback(isFullscreen);
        ipcRenderer.on('window:fullscreenChanged', listener);
        return () => { ipcRenderer.removeListener('window:fullscreenChanged', listener); };
    },
    onMenuEvent: (event, callback) => {
        const channel = `menu:${event}`;
        const listener = (_event, ...args) => callback(...args);
        ipcRenderer.on(channel, listener);
        return () => { ipcRenderer.removeListener(channel, listener); };
    },
    enterMiniplayer: () => ipcRenderer.invoke('window:enterMiniplayer'),
    exitMiniplayer: () => ipcRenderer.invoke('window:exitMiniplayer'),
    getViewMode: () => ipcRenderer.invoke('window:getViewMode'),
    setWindowPosition: (position) => ipcRenderer.invoke('window:setWindowPosition', position),
    getWindowPosition: () => ipcRenderer.invoke('window:getWindowPosition'),
    setTrafficLightVisibility: (visible) => ipcRenderer.invoke('window:setTrafficLightVisibility', visible),
    saveMiniplayerBounds: () => ipcRenderer.invoke('window:saveMiniplayerBounds'),
    onViewModeChange: (callback) => {
        const listener = (_event, mode) => callback(mode);
        ipcRenderer.on('window:viewModeChanged', listener);
        return () => { ipcRenderer.removeListener('window:viewModeChanged', listener); };
    },
    openExternal: (url) => shell.openExternal(url),
    getVersionInfo: () => ({
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        v8: process.versions.v8,
    }),
    onPrepareForClose: (callback) => {
        const listener = (_event, fadeDuration) => callback(fadeDuration);
        ipcRenderer.on('app:prepareForClose', listener);
        return () => { ipcRenderer.removeListener('app:prepareForClose', listener); };
    },
    notifyFadeOutComplete: () => {
        ipcRenderer.invoke('app:fadeOutComplete');
    },
    setConfigurationMode: (enabled) => ipcRenderer.invoke('app:setConfigurationMode', enabled),
    onExitConfigurationMode: (callback) => {
        const listener = () => callback();
        ipcRenderer.on('app:exitConfigurationMode', listener);
        return () => { ipcRenderer.removeListener('app:exitConfigurationMode', listener); };
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

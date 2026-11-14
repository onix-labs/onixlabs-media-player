/**
 * @fileoverview Window control and native dialogs over Electron IPC.
 *
 * Everything the renderer asks of its own window goes through here: native
 * file dialogs, fullscreen and miniplayer transitions, position and size, and
 * the signals that mirror the window's state back (fullscreen, view mode,
 * whether settings are open, a pending close).
 *
 * Every method is a no-op with a harmless default when the preload bridge is
 * absent, so the renderer still runs in a plain browser.
 *
 * @module app/services/window-ipc.service
 */

import {Injectable, NgZone, OnDestroy, inject, signal} from '@angular/core';
import type {UrlMediaFormat} from '../types/electron';
import {buildFileDialogFilters} from '../constants/media.constants';

/**
 * The renderer's window: its native dialogs, its mode, and its lifecycle.
 */
@Injectable({providedIn: 'root'})
export class WindowIpc implements OnDestroy {
  /** Runs IPC callbacks inside Angular so signal writes are picked up. */
  private readonly ngZone: NgZone = inject(NgZone);

  /** Whether the application is in fullscreen mode */
  public readonly isFullscreen: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Signal that increments when fullscreen transition starts (pause rendering) */
  public readonly fullscreenTransitionStart: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal that increments when fullscreen transition ends (resume rendering) */
  public readonly fullscreenTransitionEnd: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Current view mode: desktop, miniplayer, or fullscreen */
  public readonly viewMode: ReturnType<typeof signal<'desktop' | 'miniplayer' | 'fullscreen'>> = signal<'desktop' | 'miniplayer' | 'fullscreen'>('desktop');

  /** Whether the settings (configuration) window is currently open */
  public readonly isConfigOpen: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Platform information including glass effect support */
  public readonly platformInfo: ReturnType<typeof signal<{platform: string; supportsGlass: boolean; systemTheme: 'dark' | 'light'}>> = signal<{platform: string; supportsGlass: boolean; systemTheme: 'dark' | 'light'}>({
    platform: 'unknown',
    supportsGlass: false,
    systemTheme: 'dark'
  });

  /** Signal emitted when window is about to close - value is fade duration in ms (0 = no fade requested) */
  public readonly fadeOutRequested: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal emitted when close button is pressed in configuration mode - increments to trigger effect */
  public readonly exitConfigurationModeRequested: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Functions that remove the listeners registered on the preload bridge. */
  private readonly listenerCleanups: Array<() => void> = [];

  /** Timeout ID for the post-fade close notification (for cleanup) */
  private fadeOutCompleteTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /**
   * Checks if running in Electron environment.
   * The preload API is only available when running in Electron.
   *
   * @returns true if window.mediaPlayer exists (Electron), false otherwise
   */
  public get isElectron(): boolean {
    return !!window.mediaPlayer;
  }

  /**
   * Gets the preload API for IPC calls.
   *
   * @returns The window.mediaPlayer API or undefined
   */
  private get api(): typeof window.mediaPlayer {
    return window.mediaPlayer;
  }

  // ============================================================================
  // Window State Tracking
  // ============================================================================

  /**
   * Reads the platform information from the main process.
   */
  public async loadPlatformInfo(): Promise<void> {
    if (!this.isElectron || !this.api) return;

    const platformInfo: {platform: string; supportsGlass: boolean; systemTheme: 'dark' | 'light'} = await this.api.getPlatformInfo();
    this.ngZone.run((): void => {
      this.platformInfo.set(platformInfo);
    });
    console.log(`Platform: ${platformInfo.platform}, Glass supported: ${platformInfo.supportsGlass}, Theme: ${platformInfo.systemTheme}`);
  }

  /**
   * Sets up fullscreen state tracking via IPC.
   *
   * Gets the initial state and registers a listener for changes.
   * Also sets up transition event listeners for pausing rendering.
   * All updates run through NgZone to trigger Angular change detection.
   */
  public watchFullscreen(): void {
    if (!this.isElectron || !this.api) return;

    // Get initial fullscreen state. The listener below keeps it current, so a
    // failed initial read costs a stale value until the first change event.
    this.api.isFullscreen().then((isFullscreen: boolean): void => {
      this.ngZone.run((): void => {
        this.isFullscreen.set(isFullscreen);
      });
    }).catch((error: unknown): void => {
      console.error('[WindowIpc] Failed to read initial fullscreen state:', error);
    });

    // Listen for fullscreen changes
    this.listenerCleanups.push(this.api.onFullscreenChange((isFullscreen: boolean): void => {
      this.ngZone.run((): void => {
        this.isFullscreen.set(isFullscreen);
      });
    }));

    // Listen for fullscreen transition events (for pausing rendering)
    this.listenerCleanups.push(this.api.onFullscreenTransitionStart((): void => {
      this.ngZone.run((): void => {
        this.fullscreenTransitionStart.update((v: number): number => v + 1);
      });
    }));

    this.listenerCleanups.push(this.api.onFullscreenTransitionEnd((): void => {
      this.ngZone.run((): void => {
        this.fullscreenTransitionEnd.update((v: number): number => v + 1);
      });
    }));
  }

  /**
   * Sets up view mode state tracking via IPC.
   *
   * Gets the initial view mode and registers a listener for changes.
   * All updates run through NgZone to trigger Angular change detection.
   */
  public watchViewMode(): void {
    if (!this.isElectron || !this.api) return;

    // Get initial view mode. As with fullscreen, the change listener corrects
    // a failed initial read on the next transition.
    this.api.getViewMode().then((mode: 'desktop' | 'miniplayer' | 'fullscreen'): void => {
      this.ngZone.run((): void => {
        this.viewMode.set(mode);
      });
    }).catch((error: unknown): void => {
      console.error('[WindowIpc] Failed to read initial view mode:', error);
    });

    // Listen for view mode changes
    this.listenerCleanups.push(this.api.onViewModeChange((mode: 'desktop' | 'miniplayer' | 'fullscreen'): void => {
      this.ngZone.run((): void => {
        this.viewMode.set(mode);
      });
    }));

    // Listen for settings window open/close to disable fullscreen/miniplayer controls
    this.listenerCleanups.push(this.api.onConfigOpenChange((open: boolean): void => {
      this.ngZone.run((): void => {
        this.isConfigOpen.set(open);
      });
    }));
  }

  /**
   * Sets up the listeners for the window being asked to close.
   *
   * When the window is about to close, the main process sends an event
   * with the fade duration. This sets the fadeOutRequested signal which
   * components (audio-outlet, video-outlet) watch to perform the fade.
   * After the fade duration, the main process is told to proceed with close.
   *
   * When the close button is pressed while in configuration mode, the main
   * process intercepts it and sends an event to tell the renderer to exit
   * configuration mode instead of closing the window.
   */
  public watchCloseRequests(): void {
    if (!this.isElectron || !this.api) return;

    this.listenerCleanups.push(this.api.onPrepareForClose((fadeDuration: number): void => {
      this.ngZone.run((): void => {
        // Signal components to fade out
        this.fadeOutRequested.set(fadeDuration);

        // After fade duration, notify main process that fade is complete
        if (this.fadeOutCompleteTimeoutId !== null) {
          clearTimeout(this.fadeOutCompleteTimeoutId);
        }
        this.fadeOutCompleteTimeoutId = setTimeout((): void => {
          this.fadeOutCompleteTimeoutId = null;
          this.api?.notifyFadeOutComplete();
        }, fadeDuration);
      });
    }));

    this.listenerCleanups.push(this.api.onExitConfigurationMode((): void => {
      this.ngZone.run((): void => {
        this.exitConfigurationModeRequested.update((v: number): number => v + 1);
      });
    }));
  }

  /**
   * Removes every listener registered by the watch methods and cancels a
   * pending close notification.
   */
  public stopWatching(): void {
    for (const cleanup of this.listenerCleanups.splice(0)) {
      cleanup();
    }
    if (this.fadeOutCompleteTimeoutId !== null) {
      clearTimeout(this.fadeOutCompleteTimeoutId);
      this.fadeOutCompleteTimeoutId = null;
    }
  }

  /**
   * Cleanup when the service is destroyed.
   */
  public ngOnDestroy(): void {
    this.stopWatching();
  }

  // ============================================================================
  // Native Dialogs
  // ============================================================================

  /**
   * Opens the native file picker dialog for selecting media files.
   *
   * Uses IPC because native dialogs must be shown from the main process.
   *
   * Callers that know which dependencies are installed should pass filters
   * built by buildFileDialogFilters, as both in-app open paths do. The
   * fallback comes from the same builder rather than a hand-written list:
   * the list that used to live here had drifted, silently omitting every
   * tracker-module extension.
   *
   * @param multiSelect - Whether to allow selecting multiple files (default: true)
   * @param filters - Dialog filters; defaults to every supported format
   * @returns Promise resolving to array of selected file paths, empty if cancelled
   */
  public async openFileDialog(multiSelect: boolean = true, filters?: readonly {name: string; extensions: string[]}[]): Promise<string[]> {
    if (!this.isElectron || !this.api) return [];

    return this.api.openFileDialog({
      filters: (filters ?? buildFileDialogFilters(true, true, true)) as {name: string; extensions: string[]}[],
      multiSelections: multiSelect
    });
  }

  /**
   * Opens the native file picker dialog for selecting SoundFont (.sf2) files.
   *
   * @returns Promise resolving to array of selected file paths, empty if cancelled
   */
  public async openSoundFontDialog(): Promise<string[]> {
    if (!this.isElectron || !this.api) return [];
    return this.api.openSoundFontDialog();
  }

  /**
   * Opens the native file picker dialog for selecting external subtitle files.
   *
   * Supports common subtitle formats: .srt, .vtt, .ass, .ssa
   *
   * @returns Promise resolving to selected file path, or null if cancelled
   */
  public async openSubtitleDialog(): Promise<string | null> {
    if (!this.isElectron || !this.api) return null;
    return this.api.openSubtitleDialog();
  }

  /**
   * Opens a native dialog to select a .opp playlist file.
   *
   * @returns Promise resolving to the chosen file path, or null if cancelled
   */
  public async openPlaylistDialog(): Promise<string | null> {
    if (!this.isElectron || !this.api) return null;
    return this.api.openPlaylistDialog();
  }

  /**
   * Opens a native save dialog for a .opp playlist file.
   *
   * @returns Promise resolving to the chosen file path, or null if cancelled
   */
  public async savePlaylistDialog(): Promise<string | null> {
    if (!this.isElectron || !this.api) return null;
    return this.api.savePlaylistDialog();
  }

  /**
   * Opens a native save dialog for a media file about to be downloaded from a
   * URL, letting the user choose where it is written before yt-dlp starts.
   *
   * @param title - Media title, offered as the suggested filename
   * @param format - 'video' (suggests .mp4) or 'audio' (suggests .mp3)
   * @returns Promise resolving to the chosen file path, or null if cancelled
   */
  public async saveMediaDialog(title: string, format: UrlMediaFormat): Promise<string | null> {
    if (!this.isElectron || !this.api) return null;
    return this.api.saveMediaDialog({title, format});
  }

  /**
   * Gets the absolute file system path for a File object.
   *
   * Used for drag-and-drop where browser provides File objects but
   * the server needs absolute paths to access files.
   *
   * @param file - File object from a drag-and-drop DataTransfer
   * @returns The absolute path to the file
   * @throws Error if not running in Electron
   */
  public getPathForFile(file: File): string {
    if (!this.isElectron || !this.api) {
      throw new Error('Not running in Electron');
    }
    return this.api.getPathForFile(file);
  }

  // ============================================================================
  // Fullscreen Control
  // ============================================================================

  /**
   * Enters native fullscreen mode.
   *
   * Uses Electron's BrowserWindow fullscreen (not HTML5 fullscreen API)
   * for better OS integration and keyboard shortcut handling.
   */
  public async enterFullscreen(): Promise<void> {
    if (!this.isElectron || !this.api) return;
    await this.api.enterFullscreen();
  }

  /**
   * Exits native fullscreen mode.
   */
  public async exitFullscreen(): Promise<void> {
    if (!this.isElectron || !this.api) return;
    await this.api.exitFullscreen();
  }

  /**
   * Toggles fullscreen mode based on current state.
   */
  public async toggleFullscreen(): Promise<void> {
    if (this.isFullscreen()) {
      await this.exitFullscreen();
    } else {
      await this.enterFullscreen();
    }
  }

  // ============================================================================
  // Miniplayer Control
  // ============================================================================

  /**
   * Enters miniplayer mode.
   *
   * Resizes the window to compact size (320x200), positions in bottom-right corner,
   * sets always-on-top, and applies miniplayer size constraints (max 640x400).
   */
  public async enterMiniplayer(): Promise<void> {
    if (!this.isElectron || !this.api) return;
    await this.api.enterMiniplayer();
  }

  /**
   * Exits miniplayer mode and returns to desktop mode.
   *
   * Restores the previous window size and position, removes always-on-top,
   * and restores desktop size constraints (min 800x600, no max).
   */
  public async exitMiniplayer(): Promise<void> {
    if (!this.isElectron || !this.api) return;
    await this.api.exitMiniplayer();
  }

  /**
   * Sets the window position with magnetic edge snapping.
   *
   * Used during window dragging in miniplayer mode. When the position
   * is near screen edges (~40px), the window snaps to the edge.
   *
   * @param position - The desired window position {x, y}
   * @returns Promise resolving to the actual position after snapping
   */
  public async setWindowPosition(position: {x: number; y: number}): Promise<{x: number; y: number}> {
    if (!this.isElectron || !this.api) return position;
    return this.api.setWindowPosition(position);
  }

  /**
   * Gets the current window position.
   *
   * Used to get starting position for window dragging in miniplayer mode.
   *
   * @returns Promise resolving to the current window position {x, y}
   */
  public async getWindowPosition(): Promise<{x: number; y: number}> {
    if (!this.isElectron || !this.api) return {x: 0, y: 0};
    return this.api.getWindowPosition();
  }

  /**
   * Resizes the current window's content area to the given height (keeping its
   * width). Used by the Open URL window to grow/shrink to fit its content.
   *
   * @param height - Desired content height in pixels
   */
  public async setContentHeight(height: number): Promise<void> {
    if (!this.isElectron || !this.api) return;
    await this.api.setContentHeight(height);
  }

  /**
   * Sets the visibility of macOS traffic light buttons.
   *
   * Used in miniplayer mode to hide traffic lights when controls are hidden.
   * Only affects macOS; no-op on other platforms.
   *
   * @param visible - Whether the traffic lights should be visible
   */
  public async setTrafficLightVisibility(visible: boolean): Promise<void> {
    if (!this.isElectron || !this.api) return;
    await this.api.setTrafficLightVisibility(visible);
  }

  /**
   * Saves the current miniplayer bounds to settings.
   *
   * Called after drag ends or resize completes in miniplayer mode.
   * The bounds are persisted to the settings file so the miniplayer
   * position and size are restored on next entry.
   */
  public async saveMiniplayerBounds(): Promise<void> {
    if (!this.isElectron || !this.api) return;
    await this.api.saveMiniplayerBounds();
  }

  // ============================================================================
  // Windows
  // ============================================================================

  /**
   * Sets the configuration mode state in the main process.
   *
   * Used to track whether the renderer is showing the settings view.
   * When in configuration mode, the close button returns to the media
   * player instead of closing the window.
   *
   * @param enabled - Whether configuration mode is active
   */
  public async setConfigurationMode(enabled: boolean): Promise<void> {
    if (!this.isElectron || !this.api) return;
    await this.api.setConfigurationMode(enabled);
  }

  /**
   * Opens the configuration window with an optional initial category.
   * If the window is already open, it will be focused.
   *
   * @param initialCategory - Optional category ID to select on open (e.g., 'dependencies')
   */
  public async showConfigurationWindow(initialCategory?: string): Promise<void> {
    if (!this.isElectron || !this.api) return;
    await this.api.showConfigurationWindow(initialCategory);
  }

  /**
   * Opens the standalone Open URL window for playing internet media.
   * If the window is already open, it will be focused.
   */
  public async showOpenUrlWindow(): Promise<void> {
    if (!this.isElectron || !this.api) return;
    await this.api.showOpenUrlWindow();
  }

  /**
   * Minimizes the window to the taskbar/dock.
   */
  public async minimizeWindow(): Promise<void> {
    if (!this.isElectron || !this.api) return;
    await this.api.minimizeWindow();
  }

  /**
   * Closes the main window.
   */
  public async closeWindow(): Promise<void> {
    if (!this.isElectron || !this.api) return;
    await this.api.closeWindow();
  }

  /**
   * Clears the recent files and recent playlists lists.
   */
  public async clearRecentItems(): Promise<void> {
    if (!this.isElectron || !this.api) return;
    await this.api.clearRecentItems();
  }
}

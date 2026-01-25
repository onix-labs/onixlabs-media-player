/**
 * @fileoverview Angular service providing communication with Electron and the media server.
 *
 * This service acts as the primary bridge between the Angular application and:
 * 1. Electron's main process (via IPC through the preload API)
 * 2. The unified media server (via HTTP API and Server-Sent Events)
 *
 * Architecture:
 * - SSE connection for real-time state updates (playback, playlist, volume)
 * - HTTP API for commands (play, pause, seek, add tracks)
 * - IPC for native operations (file dialogs, fullscreen)
 *
 * State management uses Angular signals, updated reactively via SSE events.
 * The server is the single source of truth; this service just reflects its state.
 *
 * @module app/services/electron.service
 */

import {Injectable, NgZone, OnDestroy, signal} from '@angular/core';
import type {MediaInfo, PlaylistItem, PlaylistState} from '../types/electron';
import type {AppSettings} from './settings.service';

/**
 * Re-export types for consumers that import from this service.
 * This allows components to import both the service and types from one location.
 */
export type {MediaInfo, PlaylistItem, PlaylistState};

/**
 * Service that manages communication with Electron and the media server.
 *
 * This service is provided at the root level (singleton) and handles:
 * - Establishing SSE connection for real-time state updates
 * - Exposing reactive signals for UI binding
 * - HTTP API calls for playback and playlist control
 * - IPC calls for native Electron features
 *
 * Lifecycle:
 * 1. On construction, initializes connection to media server
 * 2. Opens SSE connection for continuous state updates
 * 3. Updates signals as events arrive (via NgZone for change detection)
 * 4. Cleans up SSE connection on destroy
 *
 * @example
 * // Inject and use in a component
 * export class MyComponent {
 *   private electron = inject(ElectronService);
 *
 *   async play() {
 *     await this.electron.play();
 *   }
 * }
 */
@Injectable({providedIn: 'root'})
export class ElectronService implements OnDestroy {
  // ============================================================================
  // Private State
  // ============================================================================

  /** Port number of the media server (obtained via IPC at startup) */
  private serverPort: number = 0;

  /** Active SSE connection for receiving state updates */
  private eventSource: EventSource | null = null;

  /** Counter for exponential backoff on SSE reconnection */
  private reconnectAttempts: number = 0;

  /** Maximum delay between reconnection attempts (30 seconds) */
  private readonly MAX_RECONNECT_DELAY: number = 30000;

  // ============================================================================
  // Public Signals - Reactive State (updated via SSE)
  // ============================================================================

  /** Base URL of the media server (e.g., "http://127.0.0.1:54545") */
  public readonly serverUrl: ReturnType<typeof signal<string>> = signal<string>('');

  /** Current playback state: idle, loading, playing, paused, stopped, or error */
  public readonly playbackState: ReturnType<typeof signal<string>> = signal<string>('idle');

  /** Current playback position in seconds */
  public readonly currentTime: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Total duration of current media in seconds */
  public readonly duration: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Current volume level (0.0 to 1.0) */
  public readonly volume: ReturnType<typeof signal<number>> = signal<number>(1);

  /** Whether audio output is muted */
  public readonly muted: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Information about the currently loaded media file */
  public readonly currentMedia: ReturnType<typeof signal<MediaInfo | null>> = signal<MediaInfo | null>(null);

  /** Error message if playback failed, null otherwise */
  public readonly errorMessage: ReturnType<typeof signal<string | null>> = signal<string | null>(null);

  /** Current playlist state including items, index, and mode flags */
  public readonly playlist: ReturnType<typeof signal<PlaylistState>> = signal<PlaylistState>({
    items: [],
    currentIndex: -1,
    shuffleEnabled: false,
    repeatEnabled: false,
  });

  /** Brief pulse signal when media ends (true for 100ms) */
  public readonly mediaEnded: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Whether the application is in fullscreen mode */
  public readonly isFullscreen: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Current view mode: desktop, miniplayer, or fullscreen */
  public readonly viewMode: ReturnType<typeof signal<'desktop' | 'miniplayer' | 'fullscreen'>> = signal<'desktop' | 'miniplayer' | 'fullscreen'>('desktop');

  /** Platform information including glass effect support */
  public readonly platformInfo: ReturnType<typeof signal<{platform: string; supportsGlass: boolean; systemTheme: 'dark' | 'light'}>> = signal<{platform: string; supportsGlass: boolean; systemTheme: 'dark' | 'light'}>({
    platform: 'unknown',
    supportsGlass: false,
    systemTheme: 'dark'
  });

  /** Cleanup function for fullscreen change listener */
  private fullscreenCleanup: (() => void) | null = null;

  /** Cleanup function for view mode change listener */
  private viewModeCleanup: (() => void) | null = null;

  /** Previous view mode for restoring after fullscreen (miniplayer or desktop) */
  private previousViewMode: 'desktop' | 'miniplayer' = 'desktop';

  /** Timeout ID for SSE reconnection (for cleanup) */
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /** Timeout ID for mediaEnded signal reset (for cleanup) */
  private mediaEndedTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /** Cleanup functions for menu event listeners */
  private readonly menuCleanupFunctions: Array<() => void> = [];

  /** Callback for settings updates (registered by SettingsService) */
  private settingsUpdateCallback: ((settings: AppSettings) => void) | null = null;

  /** Cleanup function for prepare-for-close listener */
  private prepareForCloseCleanup: (() => void) | null = null;

  /** Cleanup function for exit-configuration-mode listener */
  private exitConfigurationModeCleanup: (() => void) | null = null;

  // ============================================================================
  // Menu Event Signals - For components to react to menu actions
  // ============================================================================

  /** Signal emitted when "Show Config" menu item is selected */
  public readonly menuShowConfig: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal emitted when "Open File" menu item is selected */
  public readonly menuOpenFile: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal emitted when "Show About" menu item is selected */
  public readonly menuShowAbout: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal emitted when a visualization is selected from the menu */
  public readonly menuSelectVisualization: ReturnType<typeof signal<string>> = signal<string>('');

  /** Signal emitted when window is about to close - value is fade duration in ms (0 = no fade requested) */
  public readonly fadeOutRequested: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal emitted when close button is pressed in configuration mode - increments to trigger effect */
  public readonly exitConfigurationModeRequested: ReturnType<typeof signal<number>> = signal<number>(0);

  /**
   * Registers a callback to receive settings updates from SSE.
   * Called by SettingsService to avoid circular dependency.
   *
   * @param callback - Function to call when settings are updated
   */
  public onSettingsUpdate(callback: (settings: AppSettings) => void): void {
    this.settingsUpdateCallback = callback;
  }

  /**
   * Creates the ElectronService and initializes connections.
   *
   * @param ngZone - Angular's NgZone for running callbacks in Angular's zone
   *                 (required because SSE callbacks run outside Angular)
   */
  public constructor(private readonly ngZone: NgZone) {
    void this.initialize();
  }

  // ============================================================================
  // Property Accessors
  // ============================================================================

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
   * Private because consumers should use the public methods instead.
   *
   * @returns The window.mediaPlayer API or undefined
   */
  private get api(): typeof window.mediaPlayer {
    return window.mediaPlayer;
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  /**
   * Initializes the service by connecting to the media server.
   *
   * Sequence:
   * 1. Check if running in Electron
   * 2. Get server port via IPC
   * 3. Construct server URL
   * 4. Open SSE connection for state updates
   * 5. Setup fullscreen state listener
   */
  private async initialize(): Promise<void> {
    if (!this.isElectron || !this.api) return;

    // Get server port via IPC
    this.serverPort = await this.api.getServerPort();
    this.serverUrl.set(`http://127.0.0.1:${this.serverPort}`);
    console.log(`Connected to media server at ${this.serverUrl()}`);

    // Get platform info via IPC
    const platformInfo: {platform: string; supportsGlass: boolean; systemTheme: 'dark' | 'light'} = await this.api.getPlatformInfo();
    this.ngZone.run((): void => {
      this.platformInfo.set(platformInfo);
    });
    console.log(`Platform: ${platformInfo.platform}, Glass supported: ${platformInfo.supportsGlass}, Theme: ${platformInfo.systemTheme}`);

    // Connect to SSE for real-time updates
    this.connectSSE();

    // Setup fullscreen listener
    this.setupFullscreenListener();

    // Setup view mode listener
    this.setupViewModeListener();

    // Setup menu event listeners
    this.setupMenuListeners();

    // Setup prepare-for-close listener (for graceful audio fade-out)
    this.setupPrepareForCloseListener();

    // Setup exit-configuration-mode listener (for close button in config mode)
    this.setupExitConfigurationModeListener();
  }

  /**
   * Sets up fullscreen state tracking via IPC.
   *
   * Gets the initial state and registers a listener for changes.
   * All updates run through NgZone to trigger Angular change detection.
   */
  private setupFullscreenListener(): void {
    if (!this.isElectron || !this.api) return;

    // Get initial fullscreen state
    this.api.isFullscreen().then((isFullscreen: boolean): void => {
      this.ngZone.run((): void => {
        this.isFullscreen.set(isFullscreen);
      });
    });

    // Listen for fullscreen changes
    this.fullscreenCleanup = this.api.onFullscreenChange((isFullscreen: boolean): void => {
      this.ngZone.run((): void => {
        this.isFullscreen.set(isFullscreen);
      });
    });
  }

  /**
   * Sets up view mode state tracking via IPC.
   *
   * Gets the initial view mode and registers a listener for changes.
   * All updates run through NgZone to trigger Angular change detection.
   */
  private setupViewModeListener(): void {
    if (!this.isElectron || !this.api) return;

    // Get initial view mode
    this.api.getViewMode().then((mode: 'desktop' | 'miniplayer' | 'fullscreen'): void => {
      this.ngZone.run((): void => {
        this.viewMode.set(mode);
        if (mode !== 'fullscreen') {
          this.previousViewMode = mode;
        }
      });
    });

    // Listen for view mode changes
    this.viewModeCleanup = this.api.onViewModeChange((mode: 'desktop' | 'miniplayer' | 'fullscreen'): void => {
      this.ngZone.run((): void => {
        this.viewMode.set(mode);
        if (mode !== 'fullscreen') {
          this.previousViewMode = mode;
        }
      });
    });
  }

  /**
   * Sets up listeners for application menu events.
   *
   * Menu events handled:
   * - showConfig: Opens the configuration/settings view
   * - openFile: Opens file dialog and adds files to playlist
   * - togglePlayPause: Toggles playback state
   * - toggleShuffle: Toggles shuffle mode
   * - toggleRepeat: Toggles repeat mode
   * - selectVisualization: Changes the active visualization
   */
  private setupMenuListeners(): void {
    if (!this.isElectron || !this.api) return;

    // Show config menu item
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('showConfig', (): void => {
        this.ngZone.run((): void => {
          this.menuShowConfig.update((v: number): number => v + 1);
        });
      })
    );

    // Open file menu item
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('openFile', (): void => {
        this.ngZone.run((): void => {
          this.menuOpenFile.update((v: number): number => v + 1);
        });
      })
    );

    // Show about menu item
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('showAbout', (): void => {
        this.ngZone.run((): void => {
          this.menuShowAbout.update((v: number): number => v + 1);
        });
      })
    );

    // Toggle play/pause
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('togglePlayPause', (): void => {
        this.ngZone.run((): void => {
          const state: string = this.playbackState();
          if (state === 'playing') {
            void this.pause();
          } else {
            void this.play();
          }
        });
      })
    );

    // Toggle shuffle
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('toggleShuffle', (): void => {
        this.ngZone.run((): void => {
          const current: boolean = this.playlist().shuffleEnabled;
          void this.setShuffle(!current);
        });
      })
    );

    // Toggle repeat
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('toggleRepeat', (): void => {
        this.ngZone.run((): void => {
          const current: boolean = this.playlist().repeatEnabled;
          void this.setRepeat(!current);
        });
      })
    );

    // Select visualization
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('selectVisualization', (id: unknown): void => {
        this.ngZone.run((): void => {
          if (typeof id === 'string') {
            this.menuSelectVisualization.set(id);
          }
        });
      })
    );

    // Close media (stop, remove current, move to next)
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('closeMedia', (): void => {
        this.ngZone.run((): void => {
          void this.closeCurrentMedia();
        });
      })
    );
  }

  /**
   * Closes the current media: stops playback, removes from playlist, moves to next.
   * Called when File > Close is selected from the menu.
   */
  private async closeCurrentMedia(): Promise<void> {
    const currentPlaylist: PlaylistState = this.playlist();
    if (currentPlaylist.currentIndex < 0 || currentPlaylist.items.length === 0) {
      return;
    }

    const currentItem: PlaylistItem = currentPlaylist.items[currentPlaylist.currentIndex];

    // Stop playback
    await this.stop();

    // Remove from playlist (server will auto-advance to next if available)
    await this.removeFromPlaylist(currentItem.id);
  }

  /**
   * Sets up the prepare-for-close listener for graceful audio fade-out.
   *
   * When the window is about to close, the main process sends an event
   * with the fade duration. This sets the fadeOutRequested signal which
   * components (audio-outlet, video-outlet) watch to perform the fade.
   * After the fade duration, we notify the main process to proceed with close.
   */
  private setupPrepareForCloseListener(): void {
    if (!this.isElectron || !this.api) return;

    this.prepareForCloseCleanup = this.api.onPrepareForClose((fadeDuration: number): void => {
      this.ngZone.run((): void => {
        // Signal components to fade out
        this.fadeOutRequested.set(fadeDuration);

        // After fade duration, notify main process that fade is complete
        setTimeout((): void => {
          this.api?.notifyFadeOutComplete();
        }, fadeDuration);
      });
    });
  }

  /**
   * Sets up the exit-configuration-mode listener.
   *
   * When the close button is pressed while in configuration mode, the main
   * process intercepts it and sends an event to tell the renderer to exit
   * configuration mode instead of closing the window.
   */
  private setupExitConfigurationModeListener(): void {
    if (!this.isElectron || !this.api) return;

    this.exitConfigurationModeCleanup = this.api.onExitConfigurationMode((): void => {
      this.ngZone.run((): void => {
        this.exitConfigurationModeRequested.update((v: number): number => v + 1);
      });
    });
  }

  // ============================================================================
  // JSON Parsing Helpers
  // ============================================================================

  /**
   * Safely parses JSON from SSE event data with validation.
   *
   * Handles malformed JSON and provides default values to prevent
   * application crashes from corrupt or unexpected server data.
   *
   * @typeParam T - Expected data type
   * @param data - Raw JSON string from SSE event
   * @param fallback - Default value if parsing fails
   * @returns Parsed data or fallback value
   */
  private safeParseJSON<T>(data: string, fallback: T): T {
    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed === null || parsed === undefined) {
        return fallback;
      }
      return parsed as T;
    } catch (e) {
      console.error('Failed to parse SSE JSON:', e, 'Data:', data.substring(0, 100));
      return fallback;
    }
  }

  // ============================================================================
  // SSE Connection Management
  // ============================================================================

  /**
   * Establishes Server-Sent Events connection for real-time state updates.
   *
   * The SSE connection receives events for:
   * - playback:state - Transport state changes (playing, paused, etc.)
   * - playback:time - Position/duration updates (every 100ms during playback)
   * - playback:loaded - New media loaded
   * - playback:volume - Volume/mute changes
   * - playback:ended - Track finished playing
   * - playlist:updated - Playlist items changed
   * - playlist:selection - Current track changed
   * - playlist:mode - Shuffle/repeat mode changed
   *
   * On connection error, uses exponential backoff for reconnection
   * (1s, 2s, 4s, 8s, ... up to 30s max).
   */
  private connectSSE(): void {
    if (!this.serverUrl()) return;

    this.eventSource = new EventSource(`${this.serverUrl()}/events`);

    this.eventSource.onopen = (): void => {
      console.log('SSE connection established');
      this.reconnectAttempts = 0;
    };

    this.eventSource.onerror = (): void => {
      console.error('SSE connection error');
      this.eventSource?.close();

      // Exponential backoff reconnection
      const delay: number = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.MAX_RECONNECT_DELAY);
      this.reconnectAttempts++;
      this.reconnectTimeoutId = setTimeout((): void => { this.connectSSE(); }, delay);
    };

    // Playback state events
    this.eventSource.addEventListener('playback:state', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: { state: string; errorMessage?: string } = this.safeParseJSON<{ state: string; errorMessage?: string }>(e.data, { state: 'idle' });
        this.playbackState.set(data.state);
        this.errorMessage.set(data.errorMessage || null);
      });
    });

    this.eventSource.addEventListener('playback:time', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: { currentTime: number; duration: number } = this.safeParseJSON<{ currentTime: number; duration: number }>(e.data, { currentTime: 0, duration: 0 });
        this.currentTime.set(data.currentTime);
        this.duration.set(data.duration);
      });
    });

    this.eventSource.addEventListener('playback:loaded', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: MediaInfo | null = this.safeParseJSON<MediaInfo | null>(e.data, null);
        if (data) {
          this.currentMedia.set(data);
          this.duration.set(data.duration);
        }
      });
    });

    this.eventSource.addEventListener('playback:volume', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: { volume: number; muted: boolean } = this.safeParseJSON<{ volume: number; muted: boolean }>(e.data, { volume: 1, muted: false });
        this.volume.set(data.volume);
        this.muted.set(data.muted);
      });
    });

    this.eventSource.addEventListener('playback:ended', (): void => {
      this.ngZone.run((): void => {
        // Trigger media ended signal briefly
        this.mediaEnded.set(true);
        if (this.mediaEndedTimeoutId) {
          clearTimeout(this.mediaEndedTimeoutId);
        }
        this.mediaEndedTimeoutId = setTimeout((): void => { this.mediaEnded.set(false); }, 100);
      });
    });

    // Playlist events
    this.eventSource.addEventListener('playlist:updated', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const defaultPlaylist: PlaylistState = { items: [], currentIndex: -1, shuffleEnabled: false, repeatEnabled: false };
        const data: PlaylistState = this.safeParseJSON<PlaylistState>(e.data, defaultPlaylist);
        this.playlist.set(data);
      });
    });

    this.eventSource.addEventListener('playlist:selection', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: { currentIndex: number; currentItem?: PlaylistItem } = this.safeParseJSON<{ currentIndex: number; currentItem?: PlaylistItem }>(e.data, { currentIndex: -1 });
        this.playlist.update((p: PlaylistState): PlaylistState => ({...p, currentIndex: data.currentIndex}));
        if (data.currentItem) {
          this.currentMedia.set(data.currentItem);
        }
      });
    });

    this.eventSource.addEventListener('playlist:mode', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: { shuffleEnabled: boolean; repeatEnabled: boolean } = this.safeParseJSON<{ shuffleEnabled: boolean; repeatEnabled: boolean }>(e.data, { shuffleEnabled: false, repeatEnabled: false });
        this.playlist.update((p: PlaylistState): PlaylistState => ({
          ...p,
          shuffleEnabled: data.shuffleEnabled,
          repeatEnabled: data.repeatEnabled,
        }));
      });
    });

    // Delta playlist events (more efficient than full playlist updates)
    this.eventSource.addEventListener('playlist:items:added', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: { items: PlaylistItem[]; startIndex: number; currentIndex: number } = this.safeParseJSON<{ items: PlaylistItem[]; startIndex: number; currentIndex: number }>(
          e.data,
          { items: [], startIndex: 0, currentIndex: -1 }
        );
        this.playlist.update((p: PlaylistState): PlaylistState => ({
          ...p,
          items: [...p.items, ...data.items],
          currentIndex: data.currentIndex,
        }));
      });
    });

    this.eventSource.addEventListener('playlist:items:removed', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: { id: string; removedIndex: number; currentIndex: number } = this.safeParseJSON<{ id: string; removedIndex: number; currentIndex: number }>(
          e.data,
          { id: '', removedIndex: -1, currentIndex: -1 }
        );
        this.playlist.update((p: PlaylistState): PlaylistState => ({
          ...p,
          items: p.items.filter((item: PlaylistItem): boolean => item.id !== data.id),
          currentIndex: data.currentIndex,
        }));
      });
    });

    this.eventSource.addEventListener('playlist:cleared', (): void => {
      this.ngZone.run((): void => {
        this.playlist.update((p: PlaylistState): PlaylistState => ({
          ...p,
          items: [],
          currentIndex: -1,
        }));
      });
    });

    // Settings events
    this.eventSource.addEventListener('settings:updated', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: AppSettings | null = this.safeParseJSON<AppSettings | null>(e.data, null);
        if (data) {
          this.settingsUpdateCallback?.(data);
        }
      });
    });
  }

  // ============================================================================
  // IPC Methods (file operations only)
  // ============================================================================

  /**
   * Opens the native file picker dialog for selecting media files.
   *
   * Uses IPC because native dialogs must be shown from the main process.
   * Includes filters for common audio and video formats including MIDI.
   *
   * @param multiSelect - Whether to allow selecting multiple files (default: true)
   * @returns Promise resolving to array of selected file paths, empty if cancelled
   *
   * @example
   * const files = await electron.openFileDialog();
   * if (files.length > 0) {
   *   await electron.addToPlaylist(files);
   * }
   */
  public async openFileDialog(multiSelect: boolean = true): Promise<string[]> {
    if (!this.isElectron || !this.api) return [];

    return this.api.openFileDialog({
      filters: [
        {name: 'Media Files', extensions: ['mp3', 'mp4', 'flac', 'mkv', 'avi', 'wav', 'ogg', 'webm', 'm4a', 'aac', 'wma', 'mov', 'mid', 'midi']},
        {name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'mid', 'midi']},
        {name: 'Video', extensions: ['mp4', 'mkv', 'avi', 'webm', 'mov']}
      ],
      multiSelections: multiSelect
    });
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
   *
   * @example
   * onDrop(event: DragEvent) {
   *   const file = event.dataTransfer.files[0];
   *   const path = this.electron.getPathForFile(file);
   *   await this.electron.addToPlaylist([path]);
   * }
   */
  public getPathForFile(file: File): string {
    if (!this.isElectron || !this.api) {
      throw new Error('Not running in Electron');
    }
    return this.api.getPathForFile(file);
  }

  // ============================================================================
  // IPC Methods - Fullscreen Control
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
   *
   * @example
   * // In a component
   * onDoubleClick() {
   *   this.electron.toggleFullscreen();
   * }
   */
  public async toggleFullscreen(): Promise<void> {
    if (this.isFullscreen()) {
      await this.exitFullscreen();
    } else {
      await this.enterFullscreen();
    }
  }

  // ============================================================================
  // IPC Methods - Miniplayer Control
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

  // ============================================================================
  // HTTP API Methods - Playback Control
  // ============================================================================

  /**
   * Starts or resumes playback.
   * If a track is selected, plays from current position.
   */
  public async play(): Promise<void> {
    await this.post('/player/play');
  }

  /**
   * Pauses playback at the current position.
   */
  public async pause(): Promise<void> {
    await this.post('/player/pause');
  }

  /**
   * Stops playback and resets position to the beginning.
   */
  public async stop(): Promise<void> {
    await this.post('/player/stop');
  }

  /**
   * Seeks to a specific position in the current track.
   *
   * @param timeSeconds - Target position in seconds
   */
  public async seek(timeSeconds: number): Promise<void> {
    await this.post('/player/seek', {time: timeSeconds});
  }

  /**
   * Sets the volume level and/or mute state.
   *
   * @param volume - Volume level from 0.0 to 1.0
   * @param muted - Optional mute state
   */
  public async setVolume(volume: number, muted?: boolean): Promise<void> {
    const body: {volume?: number; muted?: boolean} = {};
    if (typeof volume === 'number') body.volume = volume;
    if (typeof muted === 'boolean') body.muted = muted;
    await this.post('/player/volume', body);
  }

  /**
   * Gets the current player state from the server.
   * Primarily used for debugging; normal state comes via SSE.
   *
   * @returns Promise resolving to the current player state
   */
  public async getPlayerState(): Promise<unknown> {
    return this.get('/player/state');
  }

  // ============================================================================
  // HTTP API Methods - Playlist
  // ============================================================================

  /**
   * Gets the current playlist state from the server.
   * Primarily used for initial sync; updates come via SSE.
   *
   * @returns Promise resolving to the playlist state
   */
  public async getPlaylist(): Promise<PlaylistState> {
    return this.get('/playlist');
  }

  /**
   * Adds media files to the playlist.
   *
   * The server probes each file for metadata (duration, type, title, etc.)
   * and adds valid media files to the playlist.
   *
   * @param paths - Array of absolute file paths to add
   * @returns Promise resolving to object with array of added items
   *
   * @example
   * const result = await electron.addToPlaylist(['/path/to/song.mp3']);
   * console.log(`Added ${result.added.length} tracks`);
   */
  public async addToPlaylist(paths: string[]): Promise<{added: PlaylistItem[]}> {
    return this.post('/playlist/add', {paths});
  }

  /**
   * Adds media files to the playlist with smart auto-play behavior.
   *
   * This is the unified method for adding files from any source (menu, drag/drop).
   * It implements consistent auto-play rules:
   *
   * 1. Single file (any state) → append and play immediately
   * 2. Multiple files + empty playlist → append all and play from beginning
   * 3. Multiple files + existing playlist → append all but don't interrupt playback
   *
   * @param paths - Array of absolute file paths to add
   * @returns Promise resolving to object with array of added items
   *
   * @example
   * // From menu file open or drag/drop
   * const result = await electron.addFilesWithAutoPlay(filePaths);
   */
  public async addFilesWithAutoPlay(paths: string[]): Promise<{added: PlaylistItem[]}> {
    if (paths.length === 0) {
      return {added: []};
    }

    // Capture playlist state BEFORE adding
    const playlistWasEmpty: boolean = this.playlist().items.length === 0;

    // Add files to playlist
    const result: {added: PlaylistItem[]} = await this.addToPlaylist(paths);

    if (result.added.length === 0) {
      return result;
    }

    // Apply auto-play rules:
    // - Single file: always play immediately
    // - Multiple files + was empty: play first
    // - Multiple files + had items: don't interrupt
    const shouldAutoPlay: boolean = result.added.length === 1 || playlistWasEmpty;

    if (shouldAutoPlay) {
      await this.selectTrack(result.added[0].id);
    }

    return result;
  }

  /**
   * Removes a track from the playlist by its ID.
   *
   * @param id - The unique ID of the track to remove
   */
  public async removeFromPlaylist(id: string): Promise<void> {
    await this.delete(`/playlist/remove/${id}`);
  }

  /**
   * Clears all tracks from the playlist.
   * Also stops playback if anything is playing.
   */
  public async clearPlaylist(): Promise<void> {
    await this.delete('/playlist/clear');
  }

  /**
   * Selects and plays a specific track by its ID.
   *
   * @param id - The unique ID of the track to select
   */
  public async selectTrack(id: string): Promise<void> {
    await this.post(`/playlist/select/${id}`);
  }

  /**
   * Advances to the next track in the playlist.
   * Respects shuffle mode if enabled.
   */
  public async nextTrack(): Promise<void> {
    await this.post('/playlist/next');
  }

  /**
   * Returns to the previous track in the playlist.
   * Respects shuffle mode if enabled.
   */
  public async previousTrack(): Promise<void> {
    await this.post('/playlist/previous');
  }

  /**
   * Enables or disables shuffle mode.
   *
   * When shuffle is enabled, next/previous use a randomized order
   * (Fisher-Yates shuffle) instead of the display order.
   *
   * @param enabled - Whether shuffle should be enabled
   */
  public async setShuffle(enabled: boolean): Promise<void> {
    await this.post('/playlist/shuffle', {enabled});
  }

  /**
   * Enables or disables repeat mode.
   *
   * When repeat is enabled, the playlist loops; otherwise playback
   * stops after the last track.
   *
   * @param enabled - Whether repeat should be enabled
   */
  public async setRepeat(enabled: boolean): Promise<void> {
    await this.post('/playlist/repeat', {enabled});
  }

  // ============================================================================
  // HTTP API Methods - Media Info
  // ============================================================================

  /**
   * Gets metadata for a media file without adding it to the playlist.
   *
   * @param filePath - Absolute path to the media file
   * @returns Promise resolving to the media metadata
   */
  public async getMediaInfo(filePath: string): Promise<MediaInfo> {
    return this.get(`/media/info?path=${encodeURIComponent(filePath)}`);
  }

  /**
   * Constructs a streaming URL for a media file.
   *
   * The URL points to the server's /media/stream endpoint which handles
   * format transcoding (for non-native formats) and range requests.
   *
   * @param filePath - Absolute path to the media file
   * @param seekTime - Optional start time in seconds (for transcoded seek)
   * @returns The complete streaming URL
   *
   * @example
   * const url = electron.getStreamUrl('/path/to/video.mkv', 30);
   * videoElement.src = url;  // Starts 30 seconds in
   */
  public getStreamUrl(filePath: string, seekTime?: number): string {
    let url: string = `${this.serverUrl()}/media/stream?path=${encodeURIComponent(filePath)}`;
    if (seekTime !== undefined && seekTime > 0) {
      url += `&t=${seekTime}`;
    }
    return url;
  }

  // ============================================================================
  // HTTP Helpers
  // ============================================================================

  /**
   * Makes a GET request to the media server.
   *
   * @typeParam T - Expected response type
   * @param endpoint - API endpoint path (e.g., '/player/state')
   * @returns Promise resolving to the parsed JSON response
   * @throws Error if the request fails
   */
  private async get<T>(endpoint: string): Promise<T> {
    const response: Response = await fetch(`${this.serverUrl()}${endpoint}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Makes a POST request to the media server.
   *
   * @typeParam T - Expected response type
   * @param endpoint - API endpoint path
   * @param body - Optional request body (will be JSON stringified)
   * @returns Promise resolving to the parsed JSON response
   * @throws Error if the request fails
   */
  private async post<T>(endpoint: string, body?: unknown): Promise<T> {
    const response: Response = await fetch(`${this.serverUrl()}${endpoint}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Makes a DELETE request to the media server.
   *
   * @typeParam T - Expected response type
   * @param endpoint - API endpoint path
   * @returns Promise resolving to the parsed JSON response
   * @throws Error if the request fails
   */
  private async delete<T>(endpoint: string): Promise<T> {
    const response: Response = await fetch(`${this.serverUrl()}${endpoint}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Cleanup when the service is destroyed.
   *
   * Closes the SSE connection and removes the fullscreen and menu listeners
   * to prevent memory leaks.
   */
  public ngOnDestroy(): void {
    this.eventSource?.close();
    this.fullscreenCleanup?.();
    this.viewModeCleanup?.();
    this.prepareForCloseCleanup?.();
    this.exitConfigurationModeCleanup?.();
    this.menuCleanupFunctions.forEach((cleanup: () => void): void => cleanup());
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
    }
    if (this.mediaEndedTimeoutId) {
      clearTimeout(this.mediaEndedTimeoutId);
    }
  }
}

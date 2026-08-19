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
import type {MediaInfo, PlaylistItem, PlaylistState, SubtitleTrack, AudioTrack, UrlMediaInfo, UrlMediaFormat, DownloadJob} from '../types/electron';
import type {AppSettings} from './settings.service';

/**
 * Re-export types for consumers that import from this service.
 * This allows components to import both the service and types from one location.
 */
export type {MediaInfo, PlaylistItem, PlaylistState, SubtitleTrack, AudioTrack, UrlMediaInfo, UrlMediaFormat, DownloadJob};

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

  /**
   * Session token the media server requires on every API request, obtained
   * over IPC at startup.
   *
   * Always populated before {@link serverUrl}, so anything reacting to the
   * server URL becoming available already has a usable token.
   */
  private readonly serverToken: ReturnType<typeof signal<string>> = signal<string>('');

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

  /**
   * Latest seek alignment from the server: when a streamed (DASH) seek lands
   * on a keyframe before the requested position, the server reports both so
   * outlets can adopt the actual stream start as their time offset.
   */
  public readonly seekAlignment: ReturnType<typeof signal<{requested: number; actual: number} | null>> = signal<{requested: number; actual: number} | null>(null);

  /**
   * Whether streamed media is busy starting or seeking (drives the busy
   * cursor). Set by the outlets while a remote/transcoded pipeline spins up;
   * auto-clears after a safety timeout so the cursor can never get stuck.
   */
  public readonly streamingBusy: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Safety timeout (ms) after which streamingBusy auto-clears */
  private readonly streamingBusyTimeoutMs: number = 20000;

  /** Timeout handle for the streamingBusy auto-clear */
  private streamingBusyTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /**
   * Sets the streaming-busy state (busy cursor). Setting it busy arms a
   * safety timeout that clears the state even if no completion event ever
   * arrives (e.g. a stream that silently dies).
   *
   * @param busy - Whether streamed media is busy starting/seeking
   */
  public setStreamingBusy(busy: boolean): void {
    if (this.streamingBusyTimeoutId !== null) {
      clearTimeout(this.streamingBusyTimeoutId);
      this.streamingBusyTimeoutId = null;
    }
    if (busy) {
      this.streamingBusyTimeoutId = setTimeout((): void => {
        this.streamingBusyTimeoutId = null;
        this.streamingBusy.set(false);
      }, this.streamingBusyTimeoutMs);
    }
    this.streamingBusy.set(busy);
  }

  /** Counter that increments when media source should be force-reloaded (e.g., soundfont change) */
  public readonly forceReloadCounter: ReturnType<typeof signal<number>> = signal<number>(0);

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

  /** Cleanup function for fullscreen change listener */
  private fullscreenCleanup: (() => void) | null = null;

  /** Cleanup function for fullscreen transition start listener */
  private fullscreenTransitionStartCleanup: (() => void) | null = null;

  /** Cleanup function for fullscreen transition end listener */
  private fullscreenTransitionEndCleanup: (() => void) | null = null;

  /** Cleanup function for view mode change listener */
  private viewModeCleanup: (() => void) | null = null;

  /** Cleanup function for config (settings) open-change listener */
  private configOpenCleanup: (() => void) | null = null;

  /** Previous view mode for restoring after fullscreen (miniplayer or desktop) */
  private previousViewMode: 'desktop' | 'miniplayer' = 'desktop';

  /** Timeout ID for SSE reconnection (for cleanup) */
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /** Timeout ID for mediaEnded signal reset (for cleanup) */
  private mediaEndedTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /** Timeout ID for the post-fade close notification (for cleanup) */
  private fadeOutCompleteTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /** Cleanup functions for menu event listeners */
  private readonly menuCleanupFunctions: Array<() => void> = [];

  /** Callback for settings updates (registered by SettingsService) */
  private settingsUpdateCallback: ((settings: AppSettings) => void) | null = null;

  /** Callback for dependency state updates (registered by DependencyService) */
  private dependencyStateCallback: ((state: unknown) => void) | null = null;

  /** Callback for dependency install progress updates (registered by DependencyService) */
  private dependencyProgressCallback: ((progress: unknown) => void) | null = null;

  /** Cleanup function for prepare-for-close listener */
  private prepareForCloseCleanup: (() => void) | null = null;

  /** Cached subtitle track selections per file path (persists across view mode changes) */
  private readonly subtitleSelections: Map<string, number> = new Map();

  /** Cached audio track selections per file path (persists across view mode changes) */
  private readonly audioSelections: Map<string, number> = new Map();

  /** Cleanup function for exit-configuration-mode listener */
  private exitConfigurationModeCleanup: (() => void) | null = null;

  /** Cleanup function for OS file open listener */
  private osOpenFileCleanup: (() => void) | null = null;

  /** Cleanup function for OS playlist open listener */
  private osOpenPlaylistCleanup: (() => void) | null = null;

  // ============================================================================
  // Menu Event Signals - For components to react to menu actions
  // ============================================================================

  /** Signal emitted when "Show Config" menu item is selected */
  public readonly menuShowConfig: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal emitted when "Open File" menu item is selected */
  public readonly menuOpenFile: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Latest URL download job update (progress/complete/error), null when idle */
  public readonly downloadJob: ReturnType<typeof signal<DownloadJob | null>> = signal<DownloadJob | null>(null);

  /**
   * Whether this renderer is the main application window (not a secondary
   * window such as ?window=open-url or ?window=configuration). Used to ensure
   * window-wide side effects of broadcast SSE events run exactly once.
   */
  private readonly isMainWindow: boolean = !new URLSearchParams(window.location.search).has('window');

  /** Signal emitted when "Show Help" menu item is selected */
  public readonly menuShowHelp: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal emitted when "Open Playlist" menu item is selected */
  public readonly menuOpenPlaylist: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal emitted when "Save Playlist" menu item is selected */
  public readonly menuSavePlaylist: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal emitted when "Save Playlist As" menu item is selected */
  public readonly menuSavePlaylistAs: ReturnType<typeof signal<number>> = signal<number>(0);

  /** Signal emitted when a visualization is selected from the menu */
  public readonly menuSelectVisualization: ReturnType<typeof signal<string>> = signal<string>('');

  /** Signal emitted when an aspect mode is selected from the menu */
  public readonly menuSelectAspectMode: ReturnType<typeof signal<string>> = signal<string>('');

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
   * Registers a callback to receive dependency state updates from SSE.
   * Called by DependencyService to avoid circular dependency.
   */
  public onDependencyStateUpdate(callback: (state: unknown) => void): void {
    this.dependencyStateCallback = callback;
  }

  /**
   * Registers a callback to receive dependency install progress from SSE.
   * Called by DependencyService to avoid circular dependency.
   */
  public onDependencyProgressUpdate(callback: (progress: unknown) => void): void {
    this.dependencyProgressCallback = callback;
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

    // Get server port and session token via IPC. The token is published first
    // so that consumers reacting to serverUrl can immediately build authorized
    // URLs.
    const [port, token]: [number, string] = await Promise.all([
      this.api.getServerPort(),
      this.api.getServerToken(),
    ]);
    this.serverToken.set(token);
    this.serverPort = port;
    this.serverUrl.set(`http://127.0.0.1:${port}`);
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

    // Setup OS file open listeners (for double-click from file manager)
    this.setupOSFileOpenListeners();
  }

  /**
   * Sets up fullscreen state tracking via IPC.
   *
   * Gets the initial state and registers a listener for changes.
   * Also sets up transition event listeners for pausing rendering.
   * All updates run through NgZone to trigger Angular change detection.
   */
  private setupFullscreenListener(): void {
    if (!this.isElectron || !this.api) return;

    // Get initial fullscreen state. The listener below keeps it current, so a
    // failed initial read costs a stale value until the first change event.
    this.api.isFullscreen().then((isFullscreen: boolean): void => {
      this.ngZone.run((): void => {
        this.isFullscreen.set(isFullscreen);
      });
    }).catch((error: unknown): void => {
      console.error('[ElectronService] Failed to read initial fullscreen state:', error);
    });

    // Listen for fullscreen changes
    this.fullscreenCleanup = this.api.onFullscreenChange((isFullscreen: boolean): void => {
      this.ngZone.run((): void => {
        this.isFullscreen.set(isFullscreen);
      });
    });

    // Listen for fullscreen transition events (for pausing rendering)
    this.fullscreenTransitionStartCleanup = this.api.onFullscreenTransitionStart((): void => {
      this.ngZone.run((): void => {
        this.fullscreenTransitionStart.update((v: number): number => v + 1);
      });
    });

    this.fullscreenTransitionEndCleanup = this.api.onFullscreenTransitionEnd((): void => {
      this.ngZone.run((): void => {
        this.fullscreenTransitionEnd.update((v: number): number => v + 1);
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

    // Get initial view mode. As above, the change listener corrects a failed
    // initial read on the next transition.
    this.api.getViewMode().then((mode: 'desktop' | 'miniplayer' | 'fullscreen'): void => {
      this.ngZone.run((): void => {
        this.viewMode.set(mode);
        if (mode !== 'fullscreen') {
          this.previousViewMode = mode;
        }
      });
    }).catch((error: unknown): void => {
      console.error('[ElectronService] Failed to read initial view mode:', error);
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

    // Listen for settings window open/close to disable fullscreen/miniplayer controls
    this.configOpenCleanup = this.api.onConfigOpenChange((open: boolean): void => {
      this.ngZone.run((): void => {
        this.isConfigOpen.set(open);
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

    // Stop playback
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('stop', (): void => {
        this.ngZone.run((): void => {
          void this.stop();
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

    // Select aspect mode
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('selectAspectMode', (mode: unknown): void => {
        this.ngZone.run((): void => {
          if (typeof mode === 'string') {
            this.menuSelectAspectMode.set(mode);
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

    // Close all (stop playback and clear playlist)
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('closeAll', (): void => {
        this.ngZone.run((): void => {
          void this.stop()
            .then((): Promise<void> => this.clearPlaylist())
            .catch((error: unknown): void => {
              console.error('[ElectronService] Close all failed:', error);
            });
        });
      })
    );

    // Show help menu item
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('showHelp', (): void => {
        this.ngZone.run((): void => {
          this.menuShowHelp.update((v: number): number => v + 1);
        });
      })
    );

    // Open playlist menu item
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('openPlaylist', (): void => {
        this.ngZone.run((): void => {
          this.menuOpenPlaylist.update((v: number): number => v + 1);
        });
      })
    );

    // Save playlist menu item
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('savePlaylist', (): void => {
        this.ngZone.run((): void => {
          this.menuSavePlaylist.update((v: number): number => v + 1);
        });
      })
    );

    // Save playlist as menu item
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('savePlaylistAs', (): void => {
        this.ngZone.run((): void => {
          this.menuSavePlaylistAs.update((v: number): number => v + 1);
        });
      })
    );

    // Open recent file menu item
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('openRecentFile', (filePath: unknown): void => {
        this.ngZone.run((): void => {
          if (typeof filePath === 'string') {
            void this.addFilesWithAutoPlay([filePath]);
          }
        });
      })
    );

    // Open recent playlist menu item
    this.menuCleanupFunctions.push(
      this.api.onMenuEvent('openRecentPlaylist', (playlistPath: unknown): void => {
        this.ngZone.run((): void => {
          if (typeof playlistPath === 'string') {
            void this.loadPlaylistFromFile(playlistPath);
          }
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
        if (this.fadeOutCompleteTimeoutId !== null) {
          clearTimeout(this.fadeOutCompleteTimeoutId);
        }
        this.fadeOutCompleteTimeoutId = setTimeout((): void => {
          this.fadeOutCompleteTimeoutId = null;
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

  /**
   * Sets up listeners for files opened from the OS.
   *
   * Handles files opened via:
   * - Double-clicking a media file in the file manager
   * - Dropping a file onto the dock icon (macOS)
   * - Command line arguments on app launch
   * - Second instance launch with files (Windows/Linux)
   */
  private setupOSFileOpenListeners(): void {
    if (!this.isElectron || !this.api) return;

    // Handle media files opened from OS
    this.osOpenFileCleanup = this.api.onOSOpenFile((filePath: string): void => {
      this.ngZone.run((): void => {
        void this.addFilesWithAutoPlay([filePath]);
      });
    });

    // Handle playlist files opened from OS
    this.osOpenPlaylistCleanup = this.api.onOSOpenPlaylist((playlistPath: string): void => {
      this.ngZone.run((): void => {
        void this.loadPlaylistFromFile(playlistPath);
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

    // EventSource cannot send headers, so the token rides in the query string.
    this.eventSource = new EventSource(this.appendAuth(`${this.serverUrl()}/events`));

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

    this.eventSource.addEventListener('playback:seek:aligned', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: {requested: number; actual: number} | null = this.safeParseJSON<{requested: number; actual: number} | null>(e.data, null);
        if (data && typeof data.requested === 'number' && typeof data.actual === 'number') {
          this.seekAlignment.set(data);
        }
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

    this.eventSource.addEventListener('playlist:items:duration', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: {filePath: string; duration: number} = this.safeParseJSON<{filePath: string; duration: number}>(
          e.data, {filePath: '', duration: 0}
        );
        if (!data.filePath) return;
        this.playlist.update((p: PlaylistState): PlaylistState => ({
          ...p,
          items: p.items.map((item: PlaylistItem): PlaylistItem =>
            item.filePath === data.filePath ? {...item, duration: data.duration} : item
          ),
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

    // Dependency events
    this.eventSource.addEventListener('dependencies:state', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: unknown = this.safeParseJSON<unknown>(e.data, null);
        if (data) {
          this.dependencyStateCallback?.(data);
        }
      });
    });

    this.eventSource.addEventListener('dependencies:progress', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: unknown = this.safeParseJSON<unknown>(e.data, null);
        if (data) {
          this.dependencyProgressCallback?.(data);
        }
      });
    });

    // URL download progress
    this.eventSource.addEventListener('download:progress', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const job: DownloadJob | null = this.safeParseJSON<DownloadJob | null>(e.data, null);
        if (job) {
          this.downloadJob.set(job);
        }
      });
    });

    // URL download complete — add the finished file to the playlist and play it.
    // Only the main window performs the add: SSE is broadcast to every window
    // (e.g. the Open URL window), so guarding here avoids a double-add.
    this.eventSource.addEventListener('download:complete', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const job: DownloadJob | null = this.safeParseJSON<DownloadJob | null>(e.data, null);
        if (job) {
          this.downloadJob.set(job);
          if (job.filePath && this.isMainWindow) {
            void this.addFilesWithAutoPlay([job.filePath]);
          }
        }
      });
    });

    // URL download error
    this.eventSource.addEventListener('download:error', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const job: DownloadJob | null = this.safeParseJSON<DownloadJob | null>(e.data, null);
        if (job) {
          this.downloadJob.set(job);
        }
      });
    });

    // Soundfont changed event - invalidate cache and optionally restart MIDI playback
    this.eventSource.addEventListener('soundfont:changed', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: { restart: boolean; filePath?: string } = this.safeParseJSON<{ restart: boolean; filePath?: string }>(e.data, { restart: false });
        // Always increment force reload counter to invalidate browser cache for MIDI
        this.forceReloadCounter.update((n: number): number => n + 1);
        if (data.restart) {
          // Small delay to ensure cache is fully cleared, then restart playback
          setTimeout((): void => {
            void this.play();
          }, 100);
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
  public async openFileDialog(multiSelect: boolean = true, filters?: readonly {name: string; extensions: string[]}[]): Promise<string[]> {
    if (!this.isElectron || !this.api) return [];

    const defaultFilters: {name: string; extensions: string[]}[] = [
      {name: 'Media Files', extensions: ['mp3', 'mp4', 'm4v', 'flac', 'mkv', 'avi', 'wav', 'ogg', 'webm', 'm4a', 'aac', 'wma', 'mov', 'mid', 'midi']},
      {name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'mid', 'midi']},
      {name: 'Video', extensions: ['mp4', 'm4v', 'mkv', 'avi', 'webm', 'mov']},
    ];

    return this.api.openFileDialog({
      filters: (filters ?? defaultFilters) as {name: string; extensions: string[]}[],
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
   * Signals that audio playback has actually started.
   * Called by the audio outlet when the audio element fires the 'playing' event.
   * This starts time tracking on the server.
   */
  public async signalPlaybackStarted(): Promise<void> {
    await this.post('/player/started');
  }

  /** Timestamp (ms epoch) of the last user-initiated seek request */
  private lastSeekRequestAt: number = 0;

  /**
   * Gets the timestamp (ms epoch) of the last user-initiated seek request.
   * Outlets use this to suppress clock syncs right after a seek, so a stale
   * element position never overrides the seek target.
   */
  public get lastSeekAt(): number {
    return this.lastSeekRequestAt;
  }

  /**
   * Seeks to a specific position in the current track.
   *
   * @param timeSeconds - Target position in seconds
   */
  public async seek(timeSeconds: number): Promise<void> {
    this.lastSeekRequestAt = Date.now();
    await this.post('/player/seek', {time: timeSeconds});
  }

  /**
   * Reports the media element's actual playback position so the server can
   * re-anchor its wall-clock time tracking. Fire-and-forget; errors are
   * logged but never disrupt playback.
   *
   * @param timeSeconds - The element's actual position in seconds
   */
  public syncPlaybackTime(timeSeconds: number): void {
    void this.post('/player/sync', {time: timeSeconds}).catch((err: unknown): void => {
      console.warn('Failed to sync playback time:', err);
    });
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

  // ============================================================================
  // Internet URL Media (yt-dlp)
  // ============================================================================

  /**
   * Resolves metadata and available quality formats for a remote URL.
   *
   * @param url - The page URL to inspect (YouTube, Vimeo, etc.)
   * @returns Title, thumbnail, duration, uploader, and quality options
   * @throws Error with the yt-dlp failure message if the URL is unsupported
   */
  public async getUrlInfo(url: string): Promise<UrlMediaInfo> {
    return this.postExpectingMessage<UrlMediaInfo>('/media/url/info', {url});
  }

  /**
   * Starts a background download of a URL. Progress and completion arrive via
   * the {@link downloadJob} signal (SSE); on completion the file is added to the
   * playlist and played automatically.
   *
   * @param url - The page URL to download
   * @param format - 'video' (MP4) or 'audio' (MP3)
   * @param formatId - Optional yt-dlp format id for a chosen resolution
   * @param title - Optional title used to name the downloaded file
   * @returns The created job id
   */
  public async downloadUrl(url: string, format: UrlMediaFormat, formatId: string | null, title: string): Promise<{jobId: string}> {
    this.downloadJob.set(null);
    return this.postExpectingMessage<{jobId: string}>('/media/url/download', {url, format, formatId, title});
  }

  /**
   * Resolves a direct stream URL and plays it immediately without downloading.
   * The resolved URL is added to the playlist like any local file.
   *
   * @param url - The page URL to stream
   * @param format - 'video' or 'audio'
   * @param maxHeight - Optional cap on video height (e.g., 720)
   * @returns The added playlist items
   */
  public async streamUrl(url: string, format: UrlMediaFormat, maxHeight: number | null): Promise<{added: PlaylistItem[]}> {
    const resolved: {url: string} = await this.postExpectingMessage<{url: string}>('/media/url/resolve', {url, format, maxHeight});
    return this.addFilesWithAutoPlay([resolved.url]);
  }

  /**
   * Cancels an in-flight URL download.
   *
   * @param jobId - The download job id to cancel
   */
  public async cancelDownload(jobId: string): Promise<{cancelled: boolean}> {
    return this.post<{cancelled: boolean}>(`/media/url/cancel/${encodeURIComponent(jobId)}`);
  }

  /**
   * POSTs JSON and, on a non-2xx response, throws an Error carrying the server's
   * `{ error }` message (yt-dlp failures are surfaced this way). Unlike the
   * generic {@link post} helper, this preserves the human-readable reason.
   */
  private async postExpectingMessage<T>(endpoint: string, body: unknown): Promise<T> {
    const response: Response = await this.authFetch(`${this.serverUrl()}${endpoint}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    const data: unknown = await response.json().catch((): null => null);
    if (!response.ok) {
      const message: string = (data as {error?: string} | null)?.error ?? `HTTP ${response.status}`;
      throw new Error(message);
    }
    return data as T;
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
  // HTTP API Methods - Playlist File Operations
  // ============================================================================

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
   * Saves the current playlist to a .opp file at the given path.
   *
   * @param filePath - Absolute path to save the playlist
   */
  public async savePlaylistToFile(filePath: string): Promise<void> {
    await this.post('/playlist/save', {filePath});
  }

  /**
   * Loads a playlist from a .opp file, replacing the current playlist.
   *
   * @param filePath - Absolute path to the .opp file
   * @returns The number of items loaded
   */
  public async loadPlaylistFromFile(filePath: string): Promise<{count: number; filePath: string}> {
    return this.post('/playlist/load', {filePath});
  }

  /**
   * Gets the source .opp file path of the current playlist (if loaded from file).
   *
   * @returns The file path or null
   */
  public async getPlaylistSourcePath(): Promise<string | null> {
    const result: {filePath: string | null} = await this.get('/playlist/source');
    return result.filePath;
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
    return this.appendAuth(url);
  }

  /**
   * Appends the session token to a media server URL as a query parameter.
   *
   * Use this for URLs consumed by things that cannot send headers — media
   * element `src` attributes and `EventSource`. Prefer {@link authFetch} for
   * anything issued via `fetch`.
   *
   * @param url - A fully-qualified media server URL
   * @returns The URL carrying the session token
   */
  public appendAuth(url: string): string {
    const token: string = this.serverToken();
    if (!token) return url;

    const separator: string = url.includes('?') ? '&' : '?';
    return `${url}${separator}token=${encodeURIComponent(token)}`;
  }

  /**
   * Issues a fetch against the media server with the session token attached.
   *
   * A drop-in replacement for `fetch` at any call site targeting the local
   * server; the token travels in a header rather than the URL.
   *
   * @param url - A fully-qualified media server URL
   * @param init - Standard fetch options
   * @returns The fetch response
   */
  public authFetch(url: string, init?: Readonly<RequestInit>): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        'X-Onix-Token': this.serverToken(),
      },
    });
  }

  // ============================================================================
  // Subtitle Selection Cache (persists across view mode changes)
  // ============================================================================

  /**
   * Gets the cached subtitle track selection for a file path.
   *
   * @param filePath - The media file path
   * @returns The selected track index, or undefined if no cached selection
   */
  public getSubtitleSelection(filePath: string): number | undefined {
    return this.subtitleSelections.get(filePath);
  }

  /**
   * Caches the subtitle track selection for a file path.
   *
   * @param filePath - The media file path
   * @param trackIndex - The selected track index (-1 for off, -2 for external)
   */
  public setSubtitleSelection(filePath: string, trackIndex: number): void {
    this.subtitleSelections.set(filePath, trackIndex);
  }

  /**
   * Clears the subtitle selection cache for a file path.
   *
   * @param filePath - The media file path
   */
  public clearSubtitleSelection(filePath: string): void {
    this.subtitleSelections.delete(filePath);
  }

  // ============================================================================
  // Audio Selection Cache (persists across view mode changes)
  // ============================================================================

  /**
   * Gets the cached audio track selection for a file path.
   *
   * @param filePath - The media file path
   * @returns The selected track index, or undefined if no cached selection
   */
  public getAudioSelection(filePath: string): number | undefined {
    return this.audioSelections.get(filePath);
  }

  /**
   * Caches the audio track selection for a file path.
   *
   * @param filePath - The media file path
   * @param trackIndex - The selected track index (0-based)
   */
  public setAudioSelection(filePath: string, trackIndex: number): void {
    this.audioSelections.set(filePath, trackIndex);
  }

  /**
   * Clears the audio selection cache for a file path.
   *
   * @param filePath - The media file path
   */
  public clearAudioSelection(filePath: string): void {
    this.audioSelections.delete(filePath);
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
    const response: Response = await this.authFetch(`${this.serverUrl()}${endpoint}`);
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
    const response: Response = await this.authFetch(`${this.serverUrl()}${endpoint}`, {
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
    const response: Response = await this.authFetch(`${this.serverUrl()}${endpoint}`, {
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
    this.fullscreenTransitionStartCleanup?.();
    this.fullscreenTransitionEndCleanup?.();
    this.viewModeCleanup?.();
    this.configOpenCleanup?.();
    this.prepareForCloseCleanup?.();
    this.exitConfigurationModeCleanup?.();
    this.osOpenFileCleanup?.();
    this.osOpenPlaylistCleanup?.();
    this.menuCleanupFunctions.forEach((cleanup: () => void): void => cleanup());
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
    }
    if (this.mediaEndedTimeoutId) {
      clearTimeout(this.mediaEndedTimeoutId);
    }
    if (this.streamingBusyTimeoutId) {
      clearTimeout(this.streamingBusyTimeoutId);
    }
    if (this.fadeOutCompleteTimeoutId) {
      clearTimeout(this.fadeOutCompleteTimeoutId);
    }
  }
}

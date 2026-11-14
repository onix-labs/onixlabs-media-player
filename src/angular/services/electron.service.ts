/**
 * @fileoverview Angular service providing communication with Electron and the media server.
 *
 * This service acts as the primary bridge between the Angular application and:
 * 1. Electron's main process (via IPC through the preload API)
 * 2. The unified media server (via HTTP API and Server-Sent Events)
 *
 * Architecture:
 * - SSE connection for real-time state updates (playback, playlist, volume)
 * - HTTP API for commands (play, pause, seek, add tracks) — {@link PlayerApi}
 * - IPC for native operations (file dialogs, fullscreen) — {@link WindowIpc}
 * - Application menu events — {@link MenuEvents}
 *
 * State management uses Angular signals, updated reactively via SSE events.
 * The server is the single source of truth; this service just reflects its state.
 *
 * This service is the facade the rest of the app injects. It owns the player
 * state and what each server event means; the transports it is built from are
 * separate services, and their members are re-exposed here unchanged so that
 * consumers depend on one thing.
 *
 * @module app/services/electron.service
 */

import {Injectable, NgZone, OnDestroy, inject, signal} from '@angular/core';
import type {MediaInfo, PlaylistItem, PlaylistState, SubtitleTrack, AudioTrack, UrlMediaInfo, UrlMediaFormat, DownloadJob} from '../types/electron';
import type {AppSettings} from './settings.service';
import {TrackSelectionCache} from './track-selection-cache.service';
import {SseClient} from './sse-client.service';
import {MediaServerClient} from './media-server-client.service';
import {PlayerApi} from './player-api.service';
import {WindowIpc} from './window-ipc.service';
import {MenuEvents} from './menu-events.service';
import type {MenuActions} from './menu-events.service';

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
  // Collaborators
  // ============================================================================

  /** Where the media server is, and requests that carry its session token. */
  private readonly server: MediaServerClient = inject(MediaServerClient);

  /** The media server's HTTP commands. */
  private readonly playerApi: PlayerApi = inject(PlayerApi);

  /** Native dialogs, window control and window state over IPC. */
  private readonly windowIpc: WindowIpc = inject(WindowIpc);

  /** Application menu selections. */
  private readonly menuEvents: MenuEvents = inject(MenuEvents);

  /**
   * Per-file subtitle/audio track selections.
   *
   * Kept behind this service's existing accessors so the many components that
   * read them are unaffected by where the state actually lives.
   */
  private readonly trackSelections: TrackSelectionCache = inject(TrackSelectionCache);

  /** The SSE transport; this service supplies the meaning of each event. */
  private readonly sse: SseClient = inject(SseClient);

  // ============================================================================
  // Public Signals - Reactive State (updated via SSE)
  // ============================================================================

  /** Base URL of the media server (e.g., "http://127.0.0.1:54545") */
  public readonly serverUrl: ReturnType<typeof signal<string>> = this.server.serverUrl;

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
   * Latest seek alignment from the server: when a stream-copied seek (local
   * remux/hybrid or remote DASH) lands on a keyframe before the requested
   * position, the server reports both so outlets can adopt the actual stream
   * start as their time offset.
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
  public readonly isFullscreen: ReturnType<typeof signal<boolean>> = this.windowIpc.isFullscreen;

  /** Signal that increments when fullscreen transition starts (pause rendering) */
  public readonly fullscreenTransitionStart: ReturnType<typeof signal<number>> = this.windowIpc.fullscreenTransitionStart;

  /** Signal that increments when fullscreen transition ends (resume rendering) */
  public readonly fullscreenTransitionEnd: ReturnType<typeof signal<number>> = this.windowIpc.fullscreenTransitionEnd;

  /** Current view mode: desktop, miniplayer, or fullscreen */
  public readonly viewMode: ReturnType<typeof signal<'desktop' | 'miniplayer' | 'fullscreen'>> = this.windowIpc.viewMode;

  /** Whether the settings (configuration) window is currently open */
  public readonly isConfigOpen: ReturnType<typeof signal<boolean>> = this.windowIpc.isConfigOpen;

  /** Platform information including glass effect support */
  public readonly platformInfo: ReturnType<typeof signal<{platform: string; supportsGlass: boolean; systemTheme: 'dark' | 'light'}>> = this.windowIpc.platformInfo;

  /** Timeout ID for mediaEnded signal reset (for cleanup) */
  private mediaEndedTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /** Callback for settings updates (registered by SettingsService) */
  private readonly settingsUpdateCallbacks: Array<(settings: AppSettings) => void> = [];

  /**
   * Durations reported by the server but not yet applied to the playlist.
   *
   * One event arrives per probed file, so dropping a large folder produces a
   * burst of them; applying each one copies the whole item list and
   * re-renders every row. They are applied together instead.
   */
  private readonly pendingDurations: Map<string, number> = new Map<string, number>();

  /** Timer that applies pendingDurations, or null when none are queued. */
  private durationFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /** How long duration updates are gathered before being applied, in milliseconds. */
  private readonly DURATION_FLUSH_MS: number = 100;

  /** Callback for dependency state updates (registered by DependencyService) */
  private readonly dependencyStateCallbacks: Array<(state: unknown) => void> = [];

  /** Callback for dependency install progress updates (registered by DependencyService) */
  private readonly dependencyProgressCallbacks: Array<(progress: unknown) => void> = [];

  /** Cleanup function for OS file open listener */
  private osOpenFileCleanup: (() => void) | null = null;

  /** Cleanup function for OS playlist open listener */
  private osOpenPlaylistCleanup: (() => void) | null = null;

  // ============================================================================
  // Menu Event Signals - For components to react to menu actions
  // ============================================================================

  /** Signal emitted when "Show Config" menu item is selected */
  public readonly menuShowConfig: ReturnType<typeof signal<number>> = this.menuEvents.menuShowConfig;

  /** Signal emitted when "Open File" menu item is selected */
  public readonly menuOpenFile: ReturnType<typeof signal<number>> = this.menuEvents.menuOpenFile;

  /** Latest URL download job update (progress/complete/error), null when idle */
  public readonly downloadJob: ReturnType<typeof signal<DownloadJob | null>> = signal<DownloadJob | null>(null);

  /**
   * Whether this renderer is the main application window (not a secondary
   * window such as ?window=open-url or ?window=configuration). Used to ensure
   * window-wide side effects of broadcast SSE events run exactly once.
   */
  private readonly isMainWindow: boolean = !new URLSearchParams(window.location.search).has('window');

  /** Signal emitted when "Show Help" menu item is selected */
  public readonly menuShowHelp: ReturnType<typeof signal<number>> = this.menuEvents.menuShowHelp;

  /** Signal emitted when "Open Playlist" menu item is selected */
  public readonly menuOpenPlaylist: ReturnType<typeof signal<number>> = this.menuEvents.menuOpenPlaylist;

  /** Signal emitted when "Save Playlist" menu item is selected */
  public readonly menuSavePlaylist: ReturnType<typeof signal<number>> = this.menuEvents.menuSavePlaylist;

  /** Signal emitted when "Save Playlist As" menu item is selected */
  public readonly menuSavePlaylistAs: ReturnType<typeof signal<number>> = this.menuEvents.menuSavePlaylistAs;

  /** Signal emitted when a visualization is selected from the menu */
  public readonly menuSelectVisualization: ReturnType<typeof signal<string>> = this.menuEvents.menuSelectVisualization;

  /** Signal emitted when an aspect mode is selected from the menu */
  public readonly menuSelectAspectMode: ReturnType<typeof signal<string>> = this.menuEvents.menuSelectAspectMode;

  /** Signal emitted when window is about to close - value is fade duration in ms (0 = no fade requested) */
  public readonly fadeOutRequested: ReturnType<typeof signal<number>> = this.windowIpc.fadeOutRequested;

  /** Signal emitted when close button is pressed in configuration mode - increments to trigger effect */
  public readonly exitConfigurationModeRequested: ReturnType<typeof signal<number>> = this.windowIpc.exitConfigurationModeRequested;

  /**
   * Queues a playlist item's corrected duration for the next batched update.
   *
   * @param filePath - The item's file path
   * @param duration - Its duration in seconds
   */
  private queueDurationUpdate(filePath: string, duration: number): void {
    this.pendingDurations.set(filePath, duration);
    if (this.durationFlushTimer !== null) return;

    this.durationFlushTimer = setTimeout((): void => {
      this.durationFlushTimer = null;
      const durations: Map<string, number> = new Map<string, number>(this.pendingDurations);
      this.pendingDurations.clear();
      this.playlist.update((p: PlaylistState): PlaylistState => ({
        ...p,
        items: p.items.map((item: PlaylistItem): PlaylistItem => {
          const duration: number | undefined = durations.get(item.filePath);
          return duration === undefined ? item : {...item, duration};
        }),
      }));
    }, this.DURATION_FLUSH_MS);
  }

  /**
   * Registers a callback to receive settings updates from SSE.
   * Called by SettingsService to avoid circular dependency.
   *
   * Subscribers accumulate rather than replacing one another: assignment
   * meant a second subscriber silently unhooked the first, which is a
   * failure mode that only shows up once someone adds one.
   *
   * @param callback - Function to call when settings are updated
   * @returns A function that removes this subscription
   */
  public onSettingsUpdate(callback: (settings: AppSettings) => void): () => void {
    return this.addSubscriber(this.settingsUpdateCallbacks, callback);
  }

  /**
   * Registers a callback to receive dependency state updates from SSE.
   * Called by DependencyService to avoid circular dependency.
   *
   * @param callback - Function to call when the dependency state changes
   * @returns A function that removes this subscription
   */
  public onDependencyStateUpdate(callback: (state: unknown) => void): () => void {
    return this.addSubscriber(this.dependencyStateCallbacks, callback);
  }

  /**
   * Registers a callback to receive dependency install progress from SSE.
   * Called by DependencyService to avoid circular dependency.
   *
   * @param callback - Function to call when install progress arrives
   * @returns A function that removes this subscription
   */
  public onDependencyProgressUpdate(callback: (progress: unknown) => void): () => void {
    return this.addSubscriber(this.dependencyProgressCallbacks, callback);
  }

  /**
   * Adds a subscriber to a list and returns its unsubscribe function.
   *
   * @param subscribers - The list to add to
   * @param callback - The subscriber
   * @returns A function that removes the subscriber
   */
  private addSubscriber<T>(subscribers: Array<(value: T) => void>, callback: (value: T) => void): () => void {
    subscribers.push(callback);
    return (): void => {
      const index: number = subscribers.indexOf(callback);
      if (index !== -1) subscribers.splice(index, 1);
    };
  }

  /**
   * Delivers a value to every subscriber, isolating their failures.
   *
   * One subscriber throwing must not stop the others from being told, nor
   * kill the SSE handler that is dispatching.
   *
   * @param subscribers - The list to notify
   * @param value - The value to deliver
   */
  private notifySubscribers<T>(subscribers: ReadonlyArray<(value: T) => void>, value: T): void {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(value);
      } catch (error: unknown) {
        console.error('[ElectronService] SSE subscriber failed:', error);
      }
    }
  }

  /**
   * Creates the ElectronService and initializes connections.
   *
   * @param ngZone - Angular's NgZone for running callbacks in Angular's zone
   *                 (required because SSE callbacks run outside Angular)
   */
  public constructor(private readonly ngZone: NgZone) {
    // Nothing can await a constructor, so a failed IPC read during start-up
    // would otherwise leave the service half-initialised without a trace.
    void this.initialize().catch((error: unknown): void => {
      console.error('[ElectronService] Initialization failed:', error);
    });
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
   * 2. Get server port and session token via IPC
   * 3. Read the platform information
   * 4. Open SSE connection for state updates
   * 5. Start listening for window, menu and OS file-open events
   */
  private async initialize(): Promise<void> {
    if (!this.isElectron || !this.api) return;

    const [port, token]: [number, string] = await Promise.all([
      this.api.getServerPort(),
      this.api.getServerToken(),
    ]);
    this.server.configure(port, token);
    console.log(`Connected to media server at ${this.serverUrl()}`);

    await this.windowIpc.loadPlatformInfo();

    // Connect to SSE for real-time updates
    this.connectSSE();

    this.windowIpc.watchFullscreen();
    this.windowIpc.watchViewMode();
    this.menuEvents.listen(this.menuActions());

    // Prepare-for-close (graceful audio fade-out) and the close button in
    // configuration mode
    this.windowIpc.watchCloseRequests();

    // Setup OS file open listeners (for double-click from file manager)
    this.setupOSFileOpenListeners();
  }

  /**
   * Runs a server command that nothing awaits, logging it if it fails.
   *
   * Menu selections, OS file opens and SSE events have no caller to hand a
   * failure to, so a rejected request would otherwise surface only as an
   * unhandled promise rejection.
   *
   * @param description - What the command does, as it should read in the log
   * @param command - The command's promise
   */
  private runInBackground(description: string, command: Promise<unknown>): void {
    void command.catch((error: unknown): void => {
      console.error(`[ElectronService] ${description} failed:`, error);
    });
  }

  /**
   * Supplies what each command-style menu selection does to the player.
   *
   * @returns The actions the menu drives
   */
  private menuActions(): MenuActions {
    return {
      togglePlayPause: (): void => {
        const state: string = this.playbackState();
        this.runInBackground('Play/pause', state === 'playing' ? this.pause() : this.play());
      },
      stop: (): void => {
        this.runInBackground('Stop', this.stop());
      },
      toggleShuffle: (): void => {
        const current: boolean = this.playlist().shuffleEnabled;
        this.runInBackground('Toggle shuffle', this.setShuffle(!current));
      },
      toggleRepeat: (): void => {
        const current: boolean = this.playlist().repeatEnabled;
        this.runInBackground('Toggle repeat', this.setRepeat(!current));
      },
      // Close media (stop, remove current, move to next)
      closeMedia: (): void => {
        this.runInBackground('Close media', this.closeCurrentMedia());
      },
      // Close all (stop playback and clear playlist)
      closeAll: (): void => {
        this.runInBackground('Close all', this.stop().then((): Promise<void> => this.clearPlaylist()));
      },
      openRecentFile: (filePath: string): void => {
        this.runInBackground('Open recent file', this.addFilesWithAutoPlay([filePath]));
      },
      openRecentPlaylist: (playlistPath: string): void => {
        this.runInBackground('Open recent playlist', this.loadPlaylistFromFile(playlistPath));
      },
    };
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

    // The index arrives separately from the items, so it can briefly point
    // past the end of a list that has just shrunk.
    const currentItem: PlaylistItem | undefined = currentPlaylist.items[currentPlaylist.currentIndex];
    if (!currentItem) {
      return;
    }

    // Stop playback
    await this.stop();

    // Remove from playlist (server will auto-advance to next if available)
    await this.removeFromPlaylist(currentItem.id);
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
        this.runInBackground('Open file from the OS', this.addFilesWithAutoPlay([filePath]));
      });
    });

    // Handle playlist files opened from OS
    this.osOpenPlaylistCleanup = this.api.onOSOpenPlaylist((playlistPath: string): void => {
      this.ngZone.run((): void => {
        this.runInBackground('Open playlist from the OS', this.loadPlaylistFromFile(playlistPath));
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
    this.sse.connect(this.appendAuth(`${this.serverUrl()}/events`), {
    // Playback state events
    'playback:state': (payload: string): void => {
      this.ngZone.run((): void => {
        const data: { state: string; errorMessage?: string } = this.safeParseJSON<{ state: string; errorMessage?: string }>(payload, { state: 'idle' });
        this.playbackState.set(data.state);
        this.errorMessage.set(data.errorMessage || null);
      });
    },

    'playback:time': (payload: string): void => {
      this.ngZone.run((): void => {
        const data: { currentTime: number; duration: number } = this.safeParseJSON<{ currentTime: number; duration: number }>(payload, { currentTime: 0, duration: 0 });
        this.currentTime.set(data.currentTime);
        this.duration.set(data.duration);
      });
    },

    'playback:loaded': (payload: string): void => {
      this.ngZone.run((): void => {
        const data: MediaInfo | null = this.safeParseJSON<MediaInfo | null>(payload, null);
        if (data) {
          this.currentMedia.set(data);
          this.duration.set(data.duration);
        }
      });
    },

    'playback:volume': (payload: string): void => {
      this.ngZone.run((): void => {
        const data: { volume: number; muted: boolean } = this.safeParseJSON<{ volume: number; muted: boolean }>(payload, { volume: 1, muted: false });
        this.volume.set(data.volume);
        this.muted.set(data.muted);
      });
    },

    'playback:seek:aligned': (payload: string): void => {
      this.ngZone.run((): void => {
        const data: {requested: number; actual: number} | null = this.safeParseJSON<{requested: number; actual: number} | null>(payload, null);
        if (data && typeof data.requested === 'number' && typeof data.actual === 'number') {
          this.seekAlignment.set(data);
        }
      });
    },

    'playback:ended': (): void => {
      this.ngZone.run((): void => {
        // Trigger media ended signal briefly
        this.mediaEnded.set(true);
        if (this.mediaEndedTimeoutId) {
          clearTimeout(this.mediaEndedTimeoutId);
        }
        this.mediaEndedTimeoutId = setTimeout((): void => { this.mediaEnded.set(false); }, 100);
      });
    },

    // Playlist events
    'playlist:updated': (payload: string): void => {
      this.ngZone.run((): void => {
        const defaultPlaylist: PlaylistState = { items: [], currentIndex: -1, shuffleEnabled: false, repeatEnabled: false };
        const data: PlaylistState = this.safeParseJSON<PlaylistState>(payload, defaultPlaylist);
        this.playlist.set(data);
      });
    },

    'playlist:selection': (payload: string): void => {
      this.ngZone.run((): void => {
        const data: { currentIndex: number; currentItem?: PlaylistItem } = this.safeParseJSON<{ currentIndex: number; currentItem?: PlaylistItem }>(payload, { currentIndex: -1 });
        this.playlist.update((p: PlaylistState): PlaylistState => ({...p, currentIndex: data.currentIndex}));
        if (data.currentItem) {
          this.currentMedia.set(data.currentItem);
        }
      });
    },

    'playlist:mode': (payload: string): void => {
      this.ngZone.run((): void => {
        const data: { shuffleEnabled: boolean; repeatEnabled: boolean } = this.safeParseJSON<{ shuffleEnabled: boolean; repeatEnabled: boolean }>(payload, { shuffleEnabled: false, repeatEnabled: false });
        this.playlist.update((p: PlaylistState): PlaylistState => ({
          ...p,
          shuffleEnabled: data.shuffleEnabled,
          repeatEnabled: data.repeatEnabled,
        }));
      });
    },

    // Delta playlist events (more efficient than full playlist updates)
    'playlist:items:added': (payload: string): void => {
      this.ngZone.run((): void => {
        const data: { items: PlaylistItem[]; startIndex: number; currentIndex: number } = this.safeParseJSON<{ items: PlaylistItem[]; startIndex: number; currentIndex: number }>(
          payload,
          { items: [], startIndex: 0, currentIndex: -1 }
        );
        this.playlist.update((p: PlaylistState): PlaylistState => ({
          ...p,
          items: [...p.items, ...data.items],
          currentIndex: data.currentIndex,
        }));
      });
    },

    'playlist:items:removed': (payload: string): void => {
      this.ngZone.run((): void => {
        const data: { id: string; removedIndex: number; currentIndex: number } = this.safeParseJSON<{ id: string; removedIndex: number; currentIndex: number }>(
          payload,
          { id: '', removedIndex: -1, currentIndex: -1 }
        );
        this.playlist.update((p: PlaylistState): PlaylistState => ({
          ...p,
          items: p.items.filter((item: PlaylistItem): boolean => item.id !== data.id),
          currentIndex: data.currentIndex,
        }));
      });
    },

    'playlist:items:duration': (payload: string): void => {
      this.ngZone.run((): void => {
        const data: {filePath: string; duration: number} = this.safeParseJSON<{filePath: string; duration: number}>(
          payload, {filePath: '', duration: 0}
        );
        if (!data.filePath) return;
        this.queueDurationUpdate(data.filePath, data.duration);
      });
    },

    'playlist:cleared': (): void => {
      this.ngZone.run((): void => {
        this.playlist.update((p: PlaylistState): PlaylistState => ({
          ...p,
          items: [],
          currentIndex: -1,
        }));
      });
    },

    // Settings events
    'settings:updated': (payload: string): void => {
      this.ngZone.run((): void => {
        const data: AppSettings | null = this.safeParseJSON<AppSettings | null>(payload, null);
        if (data) {
          this.notifySubscribers(this.settingsUpdateCallbacks, data);
        }
      });
    },

    // Dependency events
    'dependencies:state': (payload: string): void => {
      this.ngZone.run((): void => {
        const data: unknown = this.safeParseJSON<unknown>(payload, null);
        if (data) {
          this.notifySubscribers(this.dependencyStateCallbacks, data);
        }
      });
    },

    'dependencies:progress': (payload: string): void => {
      this.ngZone.run((): void => {
        const data: unknown = this.safeParseJSON<unknown>(payload, null);
        if (data) {
          this.notifySubscribers(this.dependencyProgressCallbacks, data);
        }
      });
    },

    // URL download progress
    'download:progress': (payload: string): void => {
      this.ngZone.run((): void => {
        const job: DownloadJob | null = this.safeParseJSON<DownloadJob | null>(payload, null);
        if (job) {
          this.downloadJob.set(job);
        }
      });
    },

    // URL download complete — add the finished file to the playlist and play it.
    // Only the main window performs the add: SSE is broadcast to every window
    // (e.g. the Open URL window), so guarding here avoids a double-add.
    'download:complete': (payload: string): void => {
      this.ngZone.run((): void => {
        const job: DownloadJob | null = this.safeParseJSON<DownloadJob | null>(payload, null);
        if (job) {
          this.downloadJob.set(job);
          if (job.filePath && this.isMainWindow) {
            this.runInBackground('Add downloaded file', this.addFilesWithAutoPlay([job.filePath]));
          }
        }
      });
    },

    // URL download error
    'download:error': (payload: string): void => {
      this.ngZone.run((): void => {
        const job: DownloadJob | null = this.safeParseJSON<DownloadJob | null>(payload, null);
        if (job) {
          this.downloadJob.set(job);
        }
      });
    },

    // Soundfont changed event - invalidate cache and optionally restart MIDI playback
    'soundfont:changed': (payload: string): void => {
      this.ngZone.run((): void => {
        const data: { restart: boolean; filePath?: string } = this.safeParseJSON<{ restart: boolean; filePath?: string }>(payload, { restart: false });
        // Always increment force reload counter to invalidate browser cache for MIDI
        this.forceReloadCounter.update((n: number): number => n + 1);
        if (data.restart) {
          // The server sets the render cache aside before emitting this, so
          // the event itself is the completion signal — there is nothing left
          // to wait for. This used to be a 100ms guess that guaranteed
          // nothing: a recursive delete can outlast it.
          this.runInBackground('Restart after SoundFont change', this.play());
        }
      });
    },
    });
  }

  // ============================================================================
  // Native Dialogs and Window Control (delegated to WindowIpc)
  // ============================================================================

  /**
   * Opens the native file picker dialog for selecting media files.
   *
   * @param multiSelect - Whether to allow selecting multiple files (default: true)
   * @param filters - Dialog filters; defaults to every supported format
   * @returns Promise resolving to array of selected file paths, empty if cancelled
   *
   * @example
   * const files = await electron.openFileDialog();
   * if (files.length > 0) {
   *   await electron.addToPlaylist(files);
   * }
   */
  public openFileDialog(multiSelect: boolean = true, filters?: readonly {name: string; extensions: string[]}[]): Promise<string[]> {
    return this.windowIpc.openFileDialog(multiSelect, filters);
  }

  /** Opens the native file picker for SoundFont (.sf2) files; empty if cancelled. */
  public openSoundFontDialog(): Promise<string[]> {
    return this.windowIpc.openSoundFontDialog();
  }

  /** Opens the native file picker for external subtitle files; null if cancelled. */
  public openSubtitleDialog(): Promise<string | null> {
    return this.windowIpc.openSubtitleDialog();
  }

  /** Opens a native dialog to select a .opp playlist file; null if cancelled. */
  public openPlaylistDialog(): Promise<string | null> {
    return this.windowIpc.openPlaylistDialog();
  }

  /** Opens a native save dialog for a .opp playlist file; null if cancelled. */
  public savePlaylistDialog(): Promise<string | null> {
    return this.windowIpc.savePlaylistDialog();
  }

  /**
   * Opens a native save dialog for a media file about to be downloaded from a
   * URL, letting the user choose where it is written before yt-dlp starts.
   *
   * @param title - Media title, offered as the suggested filename
   * @param format - 'video' (suggests .mp4) or 'audio' (suggests .mp3)
   * @returns Promise resolving to the chosen file path, or null if cancelled
   */
  public saveMediaDialog(title: string, format: UrlMediaFormat): Promise<string | null> {
    return this.windowIpc.saveMediaDialog(title, format);
  }

  /**
   * Gets the absolute file system path for a File object from a drag-and-drop.
   *
   * @param file - File object from a drag-and-drop DataTransfer
   * @returns The absolute path to the file
   * @throws Error if not running in Electron
   */
  public getPathForFile(file: File): string {
    return this.windowIpc.getPathForFile(file);
  }

  /** Enters native fullscreen mode. */
  public enterFullscreen(): Promise<void> {
    return this.windowIpc.enterFullscreen();
  }

  /** Exits native fullscreen mode. */
  public exitFullscreen(): Promise<void> {
    return this.windowIpc.exitFullscreen();
  }

  /** Toggles fullscreen mode based on current state. */
  public toggleFullscreen(): Promise<void> {
    return this.windowIpc.toggleFullscreen();
  }

  /** Enters miniplayer mode. */
  public enterMiniplayer(): Promise<void> {
    return this.windowIpc.enterMiniplayer();
  }

  /** Exits miniplayer mode and returns to desktop mode. */
  public exitMiniplayer(): Promise<void> {
    return this.windowIpc.exitMiniplayer();
  }

  /**
   * Sets the window position with magnetic edge snapping.
   *
   * @param position - The desired window position {x, y}
   * @returns Promise resolving to the actual position after snapping
   */
  public setWindowPosition(position: {x: number; y: number}): Promise<{x: number; y: number}> {
    return this.windowIpc.setWindowPosition(position);
  }

  /**
   * Resizes the current window's content area to the given height.
   *
   * @param height - Desired content height in pixels
   */
  public setContentHeight(height: number): Promise<void> {
    return this.windowIpc.setContentHeight(height);
  }

  /** Gets the current window position. */
  public getWindowPosition(): Promise<{x: number; y: number}> {
    return this.windowIpc.getWindowPosition();
  }

  /**
   * Sets the visibility of macOS traffic light buttons.
   *
   * @param visible - Whether the traffic lights should be visible
   */
  public setTrafficLightVisibility(visible: boolean): Promise<void> {
    return this.windowIpc.setTrafficLightVisibility(visible);
  }

  /** Saves the current miniplayer bounds to settings. */
  public saveMiniplayerBounds(): Promise<void> {
    return this.windowIpc.saveMiniplayerBounds();
  }

  /**
   * Sets the configuration mode state in the main process.
   *
   * @param enabled - Whether configuration mode is active
   */
  public setConfigurationMode(enabled: boolean): Promise<void> {
    return this.windowIpc.setConfigurationMode(enabled);
  }

  /**
   * Opens the configuration window with an optional initial category.
   *
   * @param initialCategory - Optional category ID to select on open (e.g., 'dependencies')
   */
  public showConfigurationWindow(initialCategory?: string): Promise<void> {
    return this.windowIpc.showConfigurationWindow(initialCategory);
  }

  /** Opens the standalone Open URL window for playing internet media. */
  public showOpenUrlWindow(): Promise<void> {
    return this.windowIpc.showOpenUrlWindow();
  }

  /** Minimizes the window to the taskbar/dock. */
  public minimizeWindow(): Promise<void> {
    return this.windowIpc.minimizeWindow();
  }

  /** Closes the main window. */
  public closeWindow(): Promise<void> {
    return this.windowIpc.closeWindow();
  }

  /** Clears the recent files and recent playlists lists. */
  public clearRecentItems(): Promise<void> {
    return this.windowIpc.clearRecentItems();
  }

  // ============================================================================
  // Playback Control (delegated to PlayerApi)
  // ============================================================================

  /** Starts or resumes playback. */
  public play(): Promise<void> {
    return this.playerApi.play();
  }

  /** Pauses playback at the current position. */
  public pause(): Promise<void> {
    return this.playerApi.pause();
  }

  /** Stops playback and resets position to the beginning. */
  public stop(): Promise<void> {
    return this.playerApi.stop();
  }

  /** Signals that audio playback has actually started, starting server time tracking. */
  public signalPlaybackStarted(): Promise<void> {
    return this.playerApi.signalPlaybackStarted();
  }

  /**
   * Gets the timestamp (ms epoch) of the last user-initiated seek request.
   * Outlets use this to suppress clock syncs right after a seek, so a stale
   * element position never overrides the seek target.
   */
  public get lastSeekAt(): number {
    return this.playerApi.lastSeekAt;
  }

  /**
   * Seeks to a specific position in the current track.
   *
   * @param timeSeconds - Target position in seconds
   */
  public seek(timeSeconds: number): Promise<void> {
    return this.playerApi.seek(timeSeconds);
  }

  /**
   * Reports the media element's actual playback position to the server.
   * Fire-and-forget; errors are logged but never disrupt playback.
   *
   * @param timeSeconds - The element's actual position in seconds
   */
  public syncPlaybackTime(timeSeconds: number): void {
    this.playerApi.syncPlaybackTime(timeSeconds);
  }

  /**
   * Sets the volume level and/or mute state.
   *
   * @param volume - Volume level from 0.0 to 1.0
   * @param muted - Optional mute state
   */
  public setVolume(volume: number, muted?: boolean): Promise<void> {
    return this.playerApi.setVolume(volume, muted);
  }

  /** Gets the current player state from the server (normal state comes via SSE). */
  public getPlayerState(): Promise<unknown> {
    return this.playerApi.getPlayerState();
  }

  // ============================================================================
  // Playlist (delegated to PlayerApi)
  // ============================================================================

  /** Gets the current playlist state from the server (updates come via SSE). */
  public getPlaylist(): Promise<PlaylistState> {
    return this.playerApi.getPlaylist();
  }

  /**
   * Adds media files to the playlist.
   *
   * @param paths - Array of absolute file paths to add
   * @returns Promise resolving to object with array of added items
   */
  public addToPlaylist(paths: string[]): Promise<{added: PlaylistItem[]}> {
    return this.playerApi.addToPlaylist(paths);
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
  public removeFromPlaylist(id: string): Promise<void> {
    return this.playerApi.removeFromPlaylist(id);
  }

  /** Clears all tracks from the playlist, stopping playback if anything is playing. */
  public clearPlaylist(): Promise<void> {
    return this.playerApi.clearPlaylist();
  }

  /**
   * Selects and plays a specific track by its ID.
   *
   * @param id - The unique ID of the track to select
   */
  public selectTrack(id: string): Promise<void> {
    return this.playerApi.selectTrack(id);
  }

  /** Advances to the next track in the playlist. */
  public nextTrack(): Promise<void> {
    return this.playerApi.nextTrack();
  }

  /** Returns to the previous track in the playlist. */
  public previousTrack(): Promise<void> {
    return this.playerApi.previousTrack();
  }

  /**
   * Enables or disables shuffle mode.
   *
   * @param enabled - Whether shuffle should be enabled
   */
  public setShuffle(enabled: boolean): Promise<void> {
    return this.playerApi.setShuffle(enabled);
  }

  /**
   * Enables or disables repeat mode.
   *
   * @param enabled - Whether repeat should be enabled
   */
  public setRepeat(enabled: boolean): Promise<void> {
    return this.playerApi.setRepeat(enabled);
  }

  /**
   * Saves the current playlist to a .opp file at the given path.
   *
   * @param filePath - Absolute path to save the playlist
   */
  public savePlaylistToFile(filePath: string): Promise<void> {
    return this.playerApi.savePlaylistToFile(filePath);
  }

  /**
   * Loads a playlist from a .opp file, replacing the current playlist.
   *
   * @param filePath - Absolute path to the .opp file
   * @returns The number of items loaded
   */
  public loadPlaylistFromFile(filePath: string): Promise<{count: number; filePath: string}> {
    return this.playerApi.loadPlaylistFromFile(filePath);
  }

  /** Gets the source .opp file path of the current playlist, or null. */
  public getPlaylistSourcePath(): Promise<string | null> {
    return this.playerApi.getPlaylistSourcePath();
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
  public getUrlInfo(url: string): Promise<UrlMediaInfo> {
    return this.playerApi.getUrlInfo(url);
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
   * @param outputPath - Destination chosen in {@link saveMediaDialog}, which the
   *   finished file is moved to
   * @returns The created job id
   */
  public downloadUrl(url: string, format: UrlMediaFormat, formatId: string | null, title: string, outputPath: string): Promise<{jobId: string}> {
    this.downloadJob.set(null);
    return this.playerApi.downloadUrl(url, format, formatId, title, outputPath);
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
    const resolved: {url: string} = await this.playerApi.resolveStreamUrl(url, format, maxHeight);
    return this.addFilesWithAutoPlay([resolved.url]);
  }

  /**
   * Cancels an in-flight URL download.
   *
   * @param jobId - The download job id to cancel
   */
  public cancelDownload(jobId: string): Promise<{cancelled: boolean}> {
    return this.playerApi.cancelDownload(jobId);
  }

  // ============================================================================
  // Media Server Access (delegated)
  // ============================================================================

  /**
   * Gets metadata for a media file without adding it to the playlist.
   *
   * @param filePath - Absolute path to the media file
   * @returns Promise resolving to the media metadata
   */
  public getMediaInfo(filePath: string): Promise<MediaInfo> {
    return this.playerApi.getMediaInfo(filePath);
  }

  /**
   * Constructs a streaming URL for a media file.
   *
   * @param filePath - Absolute path to the media file
   * @param seekTime - Optional start time in seconds (for transcoded seek)
   * @returns The complete streaming URL
   */
  public getStreamUrl(filePath: string, seekTime?: number): string {
    return this.playerApi.getStreamUrl(filePath, seekTime);
  }

  /**
   * Appends the session token to a media server URL as a query parameter, for
   * URLs consumed by things that cannot send headers. Prefer {@link authFetch}
   * for anything issued via `fetch`.
   *
   * @param url - A fully-qualified media server URL
   * @returns The URL carrying the session token
   */
  public appendAuth(url: string): string {
    return this.server.appendAuth(url);
  }

  /**
   * Issues a fetch against the media server with the session token attached.
   *
   * @param url - A fully-qualified media server URL
   * @param init - Standard fetch options
   * @returns The fetch response
   */
  public authFetch(url: string, init?: Readonly<RequestInit>): Promise<Response> {
    return this.server.authFetch(url, init);
  }

  // ============================================================================
  // Track Selection Cache (delegated)
  // ============================================================================

  /**
   * Gets the cached subtitle track selection for a file path.
   *
   * @param filePath - The media file path
   * @returns The selected track index, or undefined if no cached selection
   */
  public getSubtitleSelection(filePath: string): number | undefined {
    return this.trackSelections.getSubtitleSelection(filePath);
  }

  /**
   * Caches the subtitle track selection for a file path.
   *
   * @param filePath - The media file path
   * @param trackIndex - The selected track index (-1 for off, -2 for external)
   */
  public setSubtitleSelection(filePath: string, trackIndex: number): void {
    this.trackSelections.setSubtitleSelection(filePath, trackIndex);
  }

  /**
   * Clears the subtitle selection cache for a file path.
   *
   * @param filePath - The media file path
   */
  public clearSubtitleSelection(filePath: string): void {
    this.trackSelections.clearSubtitleSelection(filePath);
  }

  /**
   * Gets the cached audio track selection for a file path.
   *
   * @param filePath - The media file path
   * @returns The selected track index, or undefined if no cached selection
   */
  public getAudioSelection(filePath: string): number | undefined {
    return this.trackSelections.getAudioSelection(filePath);
  }

  /**
   * Caches the audio track selection for a file path.
   *
   * @param filePath - The media file path
   * @param trackIndex - The selected track index (0-based)
   */
  public setAudioSelection(filePath: string, trackIndex: number): void {
    this.trackSelections.setAudioSelection(filePath, trackIndex);
  }

  /**
   * Clears the audio selection cache for a file path.
   *
   * @param filePath - The media file path
   */
  public clearAudioSelection(filePath: string): void {
    this.trackSelections.clearAudioSelection(filePath);
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Cleanup when the service is destroyed.
   *
   * Closes the SSE connection, removes the window, menu and OS file-open
   * listeners, and cancels pending timers to prevent memory leaks.
   */
  public ngOnDestroy(): void {
    this.sse.disconnect();
    this.windowIpc.stopWatching();
    this.osOpenFileCleanup?.();
    this.osOpenPlaylistCleanup?.();
    this.menuEvents.stopListening();
    if (this.mediaEndedTimeoutId) {
      clearTimeout(this.mediaEndedTimeoutId);
    }
    if (this.streamingBusyTimeoutId) {
      clearTimeout(this.streamingBusyTimeoutId);
    }
    if (this.durationFlushTimer !== null) {
      clearTimeout(this.durationFlushTimer);
      this.durationFlushTimer = null;
    }
  }
}

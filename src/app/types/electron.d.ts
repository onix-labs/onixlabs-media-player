/**
 * @fileoverview TypeScript type definitions for the Electron-Angular bridge.
 *
 * This module defines all the interfaces used for communication between the
 * Angular renderer process and the Electron main process. These types ensure
 * type safety across the IPC boundary and the HTTP API.
 *
 * Type categories:
 * - Dialog options: Configuration for native file dialogs
 * - Media types: Information about media files (from ffprobe/MIDI parser)
 * - Playlist types: Track items and playlist state
 * - Playback types: Current playback state and controls
 * - API types: The preload bridge interface
 *
 * Global augmentation: Extends the Window interface to include the
 * mediaPlayer API exposed via contextBridge.
 *
 * @module app/types/electron
 */

/**
 * Configuration options for the native file open dialog.
 *
 * These options are passed through IPC to Electron's dialog.showOpenDialog().
 * The dialog is shown from the main process because native dialogs cannot
 * be created from the renderer process for security reasons.
 *
 * @example
 * const options: OpenDialogOptions = {
 *   filters: [
 *     { name: 'Audio Files', extensions: ['mp3', 'wav', 'flac'] }
 *   ],
 *   multiSelections: true
 * };
 */
export interface OpenDialogOptions {
  /**
   * File type filters displayed in the dialog.
   * Each filter has a display name and array of allowed extensions (without dots).
   */
  filters: { name: string; extensions: string[] }[];

  /**
   * Whether to allow selecting multiple files.
   * When true, the dialog allows Ctrl/Cmd+click to select multiple files.
   */
  multiSelections: boolean;
}

/**
 * Media file metadata returned from the server's probe operation.
 *
 * This information is extracted by ffprobe (for audio/video) or the MIDI
 * parser (for .mid/.midi files). It's used to populate playlist items
 * and configure playback.
 *
 * @example
 * // Audio file metadata
 * const audioInfo: MediaInfo = {
 *   duration: 180.5,
 *   type: 'audio',
 *   title: 'Song Title',
 *   artist: 'Artist Name',
 *   album: 'Album Name',
 *   filePath: '/path/to/song.mp3'
 * };
 *
 * // Video file metadata
 * const videoInfo: MediaInfo = {
 *   duration: 3600,
 *   type: 'video',
 *   title: 'Movie Title',
 *   filePath: '/path/to/movie.mp4',
 *   width: 1920,
 *   height: 1080
 * };
 */
export interface MediaInfo {
  /** Duration in seconds (0 if unknown, e.g., for some MIDI files) */
  duration: number;

  /** Media type determined from file streams (audio-only vs has video) */
  type: 'audio' | 'video';

  /** Title from metadata, or filename without extension as fallback */
  title: string;

  /** Artist name from audio metadata (ID3 tags, Vorbis comments, etc.) */
  artist?: string;

  /** Album name from audio metadata */
  album?: string;

  /** Absolute path to the media file on disk */
  filePath: string;

  /** Video width in pixels (only for video files) */
  width?: number;

  /** Video height in pixels (only for video files) */
  height?: number;
}

/**
 * A single item in the playlist.
 *
 * Extends MediaInfo with an ID for tracking. The ID is generated server-side
 * using nanoid and is used for all playlist operations (select, remove, etc.).
 *
 * The playlist maintains an ordered array of these items. The order can
 * differ from playback order when shuffle is enabled.
 *
 * @example
 * const track: PlaylistItem = {
 *   id: 'abc123xyz',
 *   filePath: '/music/song.mp3',
 *   title: 'Great Song',
 *   artist: 'Awesome Artist',
 *   duration: 240,
 *   type: 'audio'
 * };
 */
export interface PlaylistItem {
  /** Unique identifier for this playlist entry (nanoid generated) */
  id: string;

  /** Absolute path to the media file */
  filePath: string;

  /** Display title for the track */
  title: string;

  /** Artist name (optional, for audio files) */
  artist?: string;

  /** Album name (optional, for audio files) */
  album?: string;

  /** Duration in seconds */
  duration: number;

  /** Media type: audio or video */
  type: 'audio' | 'video';

  /** Video width in pixels (optional, for video files) */
  width?: number;

  /** Video height in pixels (optional, for video files) */
  height?: number;
}

/**
 * Current state of the playlist.
 *
 * This is part of the unified state sent via SSE. It includes all tracks,
 * the current playback position, and mode flags.
 *
 * @example
 * const state: PlaylistState = {
 *   items: [track1, track2, track3],
 *   currentIndex: 1,  // track2 is playing
 *   shuffleEnabled: false,
 *   repeatEnabled: true  // will loop back to track1 after track3
 * };
 */
export interface PlaylistState {
  /** All tracks in the playlist, in display order */
  items: PlaylistItem[];

  /**
   * Index of the currently playing track (-1 if none).
   * This is the display index, not the shuffle order index.
   */
  currentIndex: number;

  /**
   * Whether shuffle mode is enabled.
   * When true, next/previous use the shuffle order array.
   */
  shuffleEnabled: boolean;

  /**
   * Whether repeat mode is enabled.
   * When true, the playlist loops; when false, playback stops after last track.
   */
  repeatEnabled: boolean;
}

/**
 * Current playback state including transport status, timing, and volume.
 *
 * This is the main state object sent via SSE updates. The Angular app
 * subscribes to these updates to keep its UI synchronized with the
 * server's playback state.
 *
 * State transitions:
 * - idle -> loading (when track selected)
 * - loading -> playing (when playback starts)
 * - playing <-> paused (toggle)
 * - any -> stopped (stop command or track end)
 * - any -> error (on failure)
 *
 * @example
 * const state: PlaybackState = {
 *   state: 'playing',
 *   currentTime: 45.5,
 *   duration: 180.0,
 *   volume: 0.75,
 *   muted: false,
 *   currentMedia: { ... },
 *   errorMessage: null
 * };
 */
export interface PlaybackState {
  /**
   * Current transport state.
   * - idle: No track loaded
   * - loading: Track is being loaded/buffered
   * - playing: Active playback
   * - paused: Paused at current position
   * - stopped: Stopped (position reset to 0)
   * - error: Playback error occurred
   */
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error';

  /** Current playback position in seconds */
  currentTime: number;

  /** Total duration of current media in seconds */
  duration: number;

  /** Volume level from 0.0 (silent) to 1.0 (full) */
  volume: number;

  /** Whether audio is muted (volume level preserved) */
  muted: boolean;

  /** Information about the currently loaded media, or null if none */
  currentMedia: MediaInfo | null;

  /** Error message if state is 'error', null otherwise */
  errorMessage: string | null;
}

/**
 * The API exposed to the renderer process via Electron's contextBridge.
 *
 * This interface defines all IPC operations available to the Angular app
 * through window.mediaPlayer. It's intentionally minimal - most media
 * operations go through the HTTP API instead.
 *
 * IPC is used only for operations that require Electron main process:
 * - Native file dialogs (security requirement)
 * - File path resolution (webUtils API)
 * - Server port discovery (app startup)
 * - Fullscreen control (BrowserWindow API)
 *
 * @example
 * // Open file dialog
 * const files = await window.mediaPlayer.openFileDialog({
 *   filters: [{ name: 'Audio', extensions: ['mp3'] }],
 *   multiSelections: true
 * });
 *
 * // Toggle fullscreen
 * const isFS = await window.mediaPlayer.isFullscreen();
 * if (isFS) {
 *   await window.mediaPlayer.exitFullscreen();
 * } else {
 *   await window.mediaPlayer.enterFullscreen();
 * }
 */
export interface MediaPlayerAPI {
  /**
   * Opens the native file picker dialog.
   * @param options - Dialog configuration
   * @returns Promise resolving to selected file paths, or empty array if cancelled
   */
  openFileDialog: (options: OpenDialogOptions) => Promise<string[]>;

  /**
   * Gets the absolute file path for a File object from drag-and-drop.
   * @param file - File object from DataTransfer
   * @returns The absolute file system path
   */
  getPathForFile: (file: File) => string;

  /**
   * Gets the port number of the unified media server.
   * Called once at startup to establish HTTP/SSE connection.
   * @returns Promise resolving to the port number
   */
  getServerPort: () => Promise<number>;

  /**
   * Enters native fullscreen mode.
   * @returns Promise that resolves when transition completes
   */
  enterFullscreen: () => Promise<void>;

  /**
   * Exits native fullscreen mode.
   * @returns Promise that resolves when transition completes
   */
  exitFullscreen: () => Promise<void>;

  /**
   * Queries the current fullscreen state.
   * @returns Promise resolving to true if fullscreen
   */
  isFullscreen: () => Promise<boolean>;

  /**
   * Registers a callback for fullscreen state changes.
   * Called when fullscreen changes via any method (API, keyboard, OS button).
   * @param callback - Function called with new state
   * @returns Cleanup function to unregister the listener
   */
  onFullscreenChange: (callback: (isFullscreen: boolean) => void) => () => void;

  /**
   * Registers a callback for application menu events.
   * Called when user selects menu items from the native application menu.
   * @param event - The menu event name (e.g., 'showConfig', 'openFile', 'togglePlayPause')
   * @param callback - Function called when the menu event fires
   * @returns Cleanup function to unregister the listener
   */
  onMenuEvent: (event: string, callback: (...args: unknown[]) => void) => () => void;
}

/**
 * Global augmentation to add mediaPlayer API to Window interface.
 *
 * This allows TypeScript to recognize window.mediaPlayer without errors.
 * The API is optional (?) because it only exists in the Electron environment,
 * not in a regular browser.
 */
declare global {
  interface Window {
    /** Electron preload API, only available when running in Electron */
    mediaPlayer?: MediaPlayerAPI;
  }
}

/**
 * Empty export to make this a module (required for global augmentation).
 * Without this, TypeScript treats the file as a script and the declare
 * global block would fail.
 */
export {};

/**
 * @fileoverview Shared type definitions for the media server subsystem.
 *
 * These types define the data contracts used across the server's components:
 * SSEManager, PlaylistManager, and UnifiedMediaServer. Extracted to a
 * dedicated module to avoid circular dependencies and improve testability.
 *
 * @module electron/media-types
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Represents a subtitle track embedded in a media file.
 *
 * Subtitle tracks are detected via FFprobe and can be extracted
 * to WebVTT format for display in the HTML5 video element.
 */
export interface SubtitleTrack {
  /** Stream index in the container (used for extraction) */
  readonly index: number;
  /** ISO 639-2/B language code (e.g., 'eng', 'spa', 'jpn') */
  readonly language: string;
  /** Human-readable title (e.g., 'English', 'English SDH', 'Commentary') */
  readonly title: string;
  /** Subtitle codec (e.g., 'subrip', 'ass', 'mov_text', 'dvd_subtitle') */
  readonly codec: string;
  /** Whether this is a forced subtitle track (for foreign language portions) */
  readonly forced: boolean;
  /** Whether this track is marked as the default */
  readonly default: boolean;
}

/**
 * Represents an audio track embedded in a media file.
 *
 * Audio tracks are detected via FFprobe and can be selected
 * for playback when multiple tracks exist (e.g., different languages).
 */
export interface AudioTrack {
  /** Audio stream index (0-based, for FFmpeg -map 0:a:{index}) */
  readonly index: number;
  /** ISO 639-2/B language code (e.g., 'eng', 'jpn', 'und') */
  readonly language: string;
  /** Human-readable title (e.g., 'English', 'Japanese', 'Commentary') */
  readonly title: string;
  /** Audio codec (e.g., 'aac', 'ac3', 'dts', 'flac') */
  readonly codec: string;
  /** Number of audio channels (2 = stereo, 6 = 5.1, 8 = 7.1) */
  readonly channels: number;
  /** Whether this track is marked as the default */
  readonly default: boolean;
}

/**
 * Represents an item in the playlist.
 *
 * Playlist items contain all metadata needed for display and playback.
 * The id is generated server-side to ensure uniqueness.
 */
export interface PlaylistItem {
  /** Unique identifier for this playlist item */
  readonly id: string;
  /** Absolute path to the media file */
  readonly filePath: string;
  /** Display title (from metadata or filename) */
  readonly title: string;
  /** Artist name from metadata (optional) */
  readonly artist?: string;
  /** Album name from metadata (optional) */
  readonly album?: string;
  /** Duration in seconds */
  readonly duration: number;
  /** Media type: audio or video */
  readonly type: 'audio' | 'video';
  /** Video width in pixels (video only) */
  readonly width?: number;
  /** Video height in pixels (video only) */
  readonly height?: number;
}

/**
 * Media information returned by ffprobe.
 *
 * Contains metadata and stream information for a media file.
 * Used when adding items to the playlist and loading tracks.
 */
export interface MediaInfo {
  /** Duration in seconds */
  readonly duration: number;
  /** Media type determined from streams */
  readonly type: 'audio' | 'video';
  /** Display title */
  readonly title: string;
  /** Artist name (optional) */
  readonly artist?: string;
  /** Album name (optional) */
  readonly album?: string;
  /** Absolute path to the file */
  readonly filePath: string;
  /** Video width in pixels (video only) */
  readonly width?: number;
  /** Video height in pixels (video only) */
  readonly height?: number;
  /** Video codec name from FFprobe (e.g., 'h264', 'hevc', 'vp9') */
  readonly videoCodec?: string;
  /** Primary audio codec name from FFprobe (e.g., 'aac', 'ac3', 'dts') */
  readonly audioCodec?: string;
  /** Whether the file can be remuxed to MP4 without re-encoding */
  readonly canRemux?: boolean;
  /** Embedded audio tracks (video only, when multiple exist) */
  readonly audioTracks?: readonly AudioTrack[];
  /** Embedded subtitle tracks (video only) */
  readonly subtitleTracks?: readonly SubtitleTrack[];
}

/**
 * Complete playlist state for synchronization.
 *
 * This is the shape of data sent to clients when the playlist changes.
 */
export interface PlaylistState {
  /** All items in the playlist */
  readonly items: readonly PlaylistItem[];
  /** Index of currently selected item (-1 if none) */
  readonly currentIndex: number;
  /** Whether shuffle mode is enabled */
  readonly shuffleEnabled: boolean;
  /** Whether repeat mode is enabled */
  readonly repeatEnabled: boolean;
}

/**
 * Current playback state managed by the server.
 *
 * This is the authoritative state for playback. The renderer
 * receives updates via SSE and should not maintain independent state.
 */
export interface PlaybackState {
  /** Current playback state */
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error';
  /** Current playback position in seconds */
  currentTime: number;
  /** Total duration of current media in seconds */
  duration: number;
  /** Volume level (0.0 to 1.0) */
  volume: number;
  /** Whether audio is muted */
  muted: boolean;
  /** Currently loaded media info, null if nothing loaded */
  currentMedia: MediaInfo | null;
  /** Error message if state is 'error', null otherwise */
  errorMessage: string | null;
}

/**
 * SSE event types for real-time communication.
 *
 * Each event type corresponds to a specific state change that
 * the renderer needs to react to.
 */
export type SSEEventType =
  | 'playback:state'      // Playback state changed (playing/paused/etc)
  | 'playback:time'       // Current time or duration changed
  | 'playback:loaded'     // New media loaded
  | 'playback:ended'      // Playback reached end of playlist
  | 'playback:volume'     // Volume or mute state changed
  | 'playlist:updated'    // Full playlist state (initial sync)
  | 'playlist:items:added'   // Delta: items added to playlist
  | 'playlist:items:removed' // Delta: items removed from playlist
  | 'playlist:items:duration' // Delta: item durations updated (MIDI render complete)
  | 'playlist:cleared'       // Delta: playlist was cleared
  | 'playlist:selection'  // Current track selection changed
  | 'playlist:mode'       // Shuffle or repeat mode changed
  | 'settings:updated'       // Application settings changed
  | 'dependencies:state'    // Dependency state changed
  | 'dependencies:progress' // Dependency install/uninstall progress
  | 'heartbeat';            // Keep-alive ping

/**
 * @fileoverview Unified HTTP media server for audio and video streaming.
 *
 * This module provides the core backend functionality for the media player:
 * - HTTP API for playback control, playlist management, and media streaming
 * - Server-Sent Events (SSE) for real-time state synchronization
 * - Media streaming with support for native formats and transcoding
 * - MIDI file playback via FluidSynth synthesis
 * - FFprobe integration for metadata extraction
 *
 * Architecture:
 * The server acts as the single source of truth for all media state.
 * The renderer (Angular) communicates exclusively via HTTP/SSE, with no
 * direct file system access. This design:
 * - Simplifies state management (server is authoritative)
 * - Enables streaming of non-native formats via transcoding
 * - Provides a clean separation between UI and media handling
 *
 * @module electron/unified-media-server
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { createReadStream, statSync, existsSync, readFileSync } from 'fs';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { SettingsManager } from './settings-manager.js';

// ============================================================================
// Binary Path Resolution
// ============================================================================

/**
 * Common installation paths for ffmpeg/ffprobe on macOS.
 * Checked in order - first existing path is used.
 */
const FFMPEG_SEARCH_PATHS: string[] = [
  '/opt/homebrew/bin/ffmpeg',      // Homebrew Apple Silicon
  '/usr/local/bin/ffmpeg',         // Homebrew Intel
  '/usr/bin/ffmpeg',               // System
];

const FFPROBE_SEARCH_PATHS: string[] = [
  '/opt/homebrew/bin/ffprobe',     // Homebrew Apple Silicon
  '/usr/local/bin/ffprobe',        // Homebrew Intel
  '/usr/bin/ffprobe',              // System
];

const FLUIDSYNTH_SEARCH_PATHS: string[] = [
  '/opt/homebrew/bin/fluidsynth',  // Homebrew Apple Silicon
  '/usr/local/bin/fluidsynth',     // Homebrew Intel
  '/usr/bin/fluidsynth',           // System
];

/**
 * Finds the first existing binary from a list of paths.
 */
function findBinary(searchPaths: string[]): string | null {
  for (const p of searchPaths) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Resolved path to ffmpeg binary */
const FFMPEG_PATH: string | null = findBinary(FFMPEG_SEARCH_PATHS);

/** Resolved path to ffprobe binary */
const FFPROBE_PATH: string | null = findBinary(FFPROBE_SEARCH_PATHS);

/** Resolved path to fluidsynth binary */
const FLUIDSYNTH_PATH: string | null = findBinary(FLUIDSYNTH_SEARCH_PATHS);
import type { AppSettings, VisualizationSettingsUpdate, ApplicationSettingsUpdate, PlaybackSettingsUpdate, TranscodingSettingsUpdate, AppearanceSettingsUpdate } from './settings-manager.js';

// ============================================================================
// Types
// ============================================================================

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
}

/**
 * Complete playlist state for synchronization.
 *
 * This is the shape of data sent to clients when the playlist changes.
 */
interface PlaylistState {
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
interface PlaybackState {
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
type SSEEventType =
  | 'playback:state'      // Playback state changed (playing/paused/etc)
  | 'playback:time'       // Current time or duration changed
  | 'playback:loaded'     // New media loaded
  | 'playback:ended'      // Playback reached end of playlist
  | 'playback:volume'     // Volume or mute state changed
  | 'playlist:updated'    // Full playlist state (initial sync)
  | 'playlist:items:added'   // Delta: items added to playlist
  | 'playlist:items:removed' // Delta: items removed from playlist
  | 'playlist:cleared'       // Delta: playlist was cleared
  | 'playlist:selection'  // Current track selection changed
  | 'playlist:mode'       // Shuffle or repeat mode changed
  | 'settings:updated'    // Application settings changed
  | 'heartbeat';          // Keep-alive ping

// ============================================================================
// Constants
// ============================================================================

/**
 * Video formats that Chromium can play natively.
 * These support HTTP range requests for seeking.
 */
const NATIVE_VIDEO_FORMATS: Set<string> = new Set(['.mp4', '.m4v', '.webm', '.ogg']);

/**
 * Audio formats that Chromium can play natively.
 * These support HTTP range requests for seeking.
 */
const NATIVE_AUDIO_FORMATS: Set<string> = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac']);

/**
 * MIDI file extensions that require FluidSynth synthesis.
 */
const MIDI_FORMATS: Set<string> = new Set(['.mid', '.midi']);

/**
 * Paths to search for SoundFont files (in order of preference).
 * The first existing file will be used for MIDI synthesis.
 */
const SOUNDFONT_SEARCH_PATHS: string[] = [
  '/usr/local/Cellar/fluid-synth/2.5.1/share/fluid-synth/sf2/VintageDreamsWaves-v2.sf2',
  '/usr/share/sounds/sf2/FluidR3_GM.sf2',
  '/usr/share/soundfonts/FluidR3_GM.sf2',
  '/usr/local/share/soundfonts/default.sf2',
];

/**
 * MIME types for supported media formats.
 * Non-native formats are transcoded to container formats that browsers support.
 */
const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mkv': 'video/mp4',   // Transcoded to MP4
  '.avi': 'video/mp4',   // Transcoded to MP4
  '.mov': 'video/mp4',   // Transcoded to MP4
};

// ============================================================================
// MIDI Duration Parser
// ============================================================================

/**
 * Parses a MIDI file to calculate its duration in seconds.
 *
 * MIDI files cannot be probed by ffprobe because they contain musical
 * instructions rather than audio data. This function parses the binary
 * MIDI format to calculate the actual duration.
 *
 * MIDI timing works as follows:
 * - Header contains "division" (ticks per quarter note)
 * - Tempo meta events specify microseconds per quarter note
 * - Duration = (total ticks / division) * (tempo / 1,000,000)
 *
 * @param filePath - Absolute path to the MIDI file
 * @returns Duration in seconds, or 0 if parsing fails
 *
 * @example
 * const duration = parseMidiDuration('/path/to/song.mid');
 * // Returns: 180.5 (3 minutes, 0.5 seconds)
 */
function parseMidiDuration(filePath: string): number {
  try {
    const buffer: Buffer = readFileSync(filePath);
    let offset: number = 0;

    // Verify MIDI header "MThd"
    if (buffer.toString('ascii', 0, 4) !== 'MThd') {
      return 0;
    }
    offset += 8; // Skip "MThd" + header length

    // Read format (2 bytes), numTracks (2 bytes), division (2 bytes)
    const division: number = buffer.readUInt16BE(offset + 4);
    offset += 6;

    // Check if division is SMPTE (negative) or ticks per beat (positive)
    const ticksPerBeat: number = division & 0x8000 ? 0 : division;
    if (ticksPerBeat === 0) {
      return 0; // SMPTE timing not supported
    }

    let maxTick: number = 0;
    const tempoChanges: Array<{ tick: number; tempo: number }> = [{ tick: 0, tempo: 500000 }]; // Default 120 BPM

    // Parse all tracks
    while (offset < buffer.length - 8) {
      // Look for track chunk "MTrk"
      if (buffer.toString('ascii', offset, offset + 4) !== 'MTrk') {
        offset++;
        continue;
      }
      offset += 4;

      const trackLength: number = buffer.readUInt32BE(offset);
      offset += 4;

      const trackEnd: number = offset + trackLength;
      let currentTick: number = 0;

      // Parse track events
      while (offset < trackEnd && offset < buffer.length) {
        // Read variable-length delta time (max 4 bytes per MIDI spec)
        let deltaTime: number = 0;
        let byte: number;
        let varLenBytes: number = 0;
        do {
          if (varLenBytes >= 4) break; // MIDI variable-length values are max 4 bytes
          byte = buffer[offset++];
          deltaTime = (deltaTime << 7) | (byte & 0x7f);
          varLenBytes++;
        } while (byte & 0x80 && offset < trackEnd);

        currentTick += deltaTime;

        if (offset >= buffer.length) break;

        const eventType: number = buffer[offset++];

        // Meta event (0xFF)
        if (eventType === 0xff) {
          if (offset >= buffer.length) break;
          const metaType: number = buffer[offset++];

          // Read variable-length length (max 4 bytes per MIDI spec)
          let length: number = 0;
          let lengthBytes: number = 0;
          do {
            if (offset >= buffer.length || lengthBytes >= 4) break;
            byte = buffer[offset++];
            length = (length << 7) | (byte & 0x7f);
            lengthBytes++;
          } while (byte & 0x80);

          // Tempo change (meta type 0x51) - 3 bytes: microseconds per quarter note
          if (metaType === 0x51 && length === 3 && offset + 3 <= buffer.length) {
            const tempo: number = (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2];
            tempoChanges.push({ tick: currentTick, tempo });
          }

          offset += length;
        }
        // SysEx event (0xF0 or 0xF7)
        else if (eventType === 0xf0 || eventType === 0xf7) {
          let length: number = 0;
          let sysexLenBytes: number = 0;
          do {
            if (offset >= buffer.length || sysexLenBytes >= 4) break;
            byte = buffer[offset++];
            length = (length << 7) | (byte & 0x7f);
            sysexLenBytes++;
          } while (byte & 0x80);
          offset += length;
        }
        // Channel event (0x80-0xEF)
        else {
          const highNibble: number = eventType & 0xf0;
          // Events with 2 data bytes: note on/off, aftertouch, control, pitch bend
          if (highNibble === 0x80 || highNibble === 0x90 || highNibble === 0xa0 ||
              highNibble === 0xb0 || highNibble === 0xe0) {
            offset += 2;
          }
          // Events with 1 data byte: program change, channel pressure
          else if (highNibble === 0xc0 || highNibble === 0xd0) {
            offset += 1;
          }
        }
      }

      maxTick = Math.max(maxTick, currentTick);
      offset = trackEnd;
    }

    // Convert ticks to seconds using tempo changes
    tempoChanges.sort((a, b): number => a.tick - b.tick);

    let totalSeconds: number = 0;
    let lastTick: number = 0;
    let currentTempo: number = 500000; // microseconds per beat (120 BPM default)

    for (const change of tempoChanges) {
      if (change.tick > lastTick) {
        const ticksDelta: number = change.tick - lastTick;
        totalSeconds += (ticksDelta / ticksPerBeat) * (currentTempo / 1000000);
      }
      currentTempo = change.tempo;
      lastTick = change.tick;
    }

    // Add remaining time after last tempo change
    if (maxTick > lastTick) {
      const ticksDelta: number = maxTick - lastTick;
      totalSeconds += (ticksDelta / ticksPerBeat) * (currentTempo / 1000000);
    }

    return totalSeconds;
  } catch (err) {
    console.error('Failed to parse MIDI duration:', err);
    return 0;
  }
}

// ============================================================================
// SSE Manager
// ============================================================================

/**
 * Manages Server-Sent Events connections for real-time state updates.
 *
 * SSE provides a unidirectional channel from server to client that's
 * perfect for broadcasting state changes. Unlike WebSockets, SSE:
 * - Works over standard HTTP (no upgrade needed)
 * - Automatically reconnects on disconnect
 * - Is simpler to implement for broadcast scenarios
 *
 * The manager maintains a set of connected clients and broadcasts
 * events to all of them simultaneously.
 */
class SSEManager {
  /** Set of active SSE client connections */
  private readonly clients: Set<ServerResponse> = new Set<ServerResponse>();

  /** Interval for sending heartbeat pings */
  private heartbeatInterval: NodeJS.Timeout | null = null;

  /**
   * Starts the SSE manager and begins heartbeat pings.
   * Heartbeats keep connections alive through proxies and firewalls.
   */
  public start(): void {
    // Send heartbeat every 30 seconds to keep connections alive
    this.heartbeatInterval = setInterval((): void => {
      this.broadcast('heartbeat', { timestamp: Date.now() });
    }, 30000);
  }

  /**
   * Stops the SSE manager and closes all client connections.
   * Called during server shutdown.
   */
  public stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }

  /**
   * Adds a new SSE client connection.
   * Automatically removes the client when the connection closes.
   *
   * @param res - The HTTP response object to use for SSE
   */
  public addClient(res: Readonly<ServerResponse>): void {
    this.clients.add(res as ServerResponse);
    res.on('close', (): void => { this.clients.delete(res as ServerResponse); });
  }

  /**
   * Broadcasts an event to all connected SSE clients.
   *
   * @param event - The event type (e.g., 'playback:state')
   * @param data - The event data (will be JSON serialized)
   */
  public broadcast(event: SSEEventType, data: Readonly<unknown>): void {
    const message: string = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      client.write(message);
    }
  }
}

// ============================================================================
// Playlist Manager
// ============================================================================

/**
 * Manages the media playlist with shuffle and repeat functionality.
 *
 * The playlist manager is the authoritative source for:
 * - The list of media items
 * - Current track selection
 * - Shuffle/repeat mode state
 * - Navigation history (for "previous" functionality)
 *
 * Shuffle uses Fisher-Yates algorithm to generate a random order.
 * The current track is always placed first in the shuffle order
 * to avoid repeating it immediately when shuffle is enabled.
 */
class PlaylistManager {
  /** The list of playlist items */
  private items: PlaylistItem[] = [];

  /** Index of the currently selected item (-1 if none) */
  private currentIndex: number = -1;

  /** Whether shuffle mode is enabled */
  private shuffleEnabled: boolean = false;

  /** Whether repeat mode is enabled */
  private repeatEnabled: boolean = false;

  /** Randomized order for shuffle mode */
  private shuffleOrder: number[] = [];

  /** Current position within the shuffle order */
  private shufflePosition: number = 0;

  /** History of played track indices for "previous" navigation */
  private playHistory: number[] = [];

  /** Reference to SSE manager for broadcasting updates */
  private readonly sse: SSEManager;

  /** Callback for mode changes */
  private readonly onModeChange: ((shuffle: boolean, repeat: boolean) => void) | null;

  /**
   * Creates a new playlist manager.
   *
   * @param sse - SSE manager for broadcasting playlist updates
   * @param onModeChange - Optional callback for mode changes
   */
  public constructor(sse: Readonly<SSEManager>, onModeChange?: (shuffle: boolean, repeat: boolean) => void) {
    this.sse = sse as SSEManager;
    this.onModeChange = onModeChange ?? null;
  }

  /**
   * Gets the complete playlist state for synchronization.
   *
   * @returns Current playlist state including items and settings
   */
  public getState(): PlaylistState {
    return {
      items: this.items,
      currentIndex: this.currentIndex,
      shuffleEnabled: this.shuffleEnabled,
      repeatEnabled: this.repeatEnabled,
    };
  }

  /**
   * Gets the currently selected playlist item.
   *
   * @returns The current item, or null if nothing is selected
   */
  public getCurrentItem(): PlaylistItem | null {
    if (this.currentIndex >= 0 && this.currentIndex < this.items.length) {
      return this.items[this.currentIndex];
    }
    return null;
  }

  /**
   * Adds new items to the playlist.
   *
   * Items are assigned unique IDs and added to the end of the playlist.
   * If the playlist was empty, the first item is automatically selected.
   * Shuffle order is regenerated if shuffle mode is enabled.
   *
   * @param newItems - Items to add (without IDs, which will be generated)
   * @returns The items that were added (with generated IDs)
   */
  public addItems(newItems: readonly Omit<PlaylistItem, 'id'>[]): PlaylistItem[] {
    const itemsWithIds: PlaylistItem[] = newItems.map((item: Readonly<Omit<PlaylistItem, 'id'>>): PlaylistItem => ({
      ...item,
      id: this.generateId(),
    }));

    const startIndex: number = this.items.length;
    this.items.push(...itemsWithIds);

    if (this.shuffleEnabled) {
      this.regenerateShuffleOrder();
    }

    let selectionChanged: boolean = false;
    if (this.currentIndex === -1 && this.items.length > 0) {
      this.currentIndex = 0;
      selectionChanged = true;
      if (this.shuffleEnabled) {
        this.shufflePosition = this.shuffleOrder.indexOf(0);
      }
    }

    // Broadcast delta update instead of full playlist
    this.sse.broadcast('playlist:items:added', {
      items: itemsWithIds,
      startIndex,
      currentIndex: this.currentIndex,
    });

    if (selectionChanged) {
      this.broadcastSelectionChange();
    }

    return itemsWithIds;
  }

  /**
   * Removes an item from the playlist by ID.
   *
   * Adjusts the current index if necessary to maintain valid selection.
   * Regenerates shuffle order if shuffle mode is enabled.
   *
   * @param id - The ID of the item to remove
   * @returns True if the item was found and removed, false otherwise
   */
  public removeItem(id: string): boolean {
    const idx: number = this.items.findIndex((item: Readonly<PlaylistItem>): boolean => item.id === id);
    if (idx === -1) return false;

    const currentIdx: number = this.currentIndex;
    this.items = this.items.filter((item: Readonly<PlaylistItem>): boolean => item.id !== id);

    let selectionChanged: boolean = false;
    if (idx < currentIdx) {
      this.currentIndex--;
      selectionChanged = true;
    } else if (idx === currentIdx) {
      selectionChanged = true;
      if (this.items.length === 0) {
        this.currentIndex = -1;
      } else if (currentIdx >= this.items.length) {
        this.currentIndex = this.items.length - 1;
      }
    }

    if (this.shuffleEnabled) {
      this.regenerateShuffleOrder();
    }

    // Broadcast delta update instead of full playlist
    this.sse.broadcast('playlist:items:removed', {
      id,
      removedIndex: idx,
      currentIndex: this.currentIndex,
    });

    if (selectionChanged) {
      this.broadcastSelectionChange();
    }

    return true;
  }

  /**
   * Clears all items from the playlist.
   * Resets all state including shuffle order and play history.
   */
  public clear(): void {
    this.items = [];
    this.currentIndex = -1;
    this.shuffleOrder = [];
    this.shufflePosition = 0;
    this.playHistory = [];
    // Broadcast cleared event instead of full playlist
    this.sse.broadcast('playlist:cleared', {});
  }

  /**
   * Selects a specific item by ID.
   *
   * @param id - The ID of the item to select
   * @returns The selected item, or null if not found
   */
  public selectItem(id: string): PlaylistItem | null {
    const idx: number = this.items.findIndex((item: Readonly<PlaylistItem>): boolean => item.id === id);
    if (idx === -1) return null;

    this.currentIndex = idx;
    this.playHistory.push(idx);

    if (this.shuffleEnabled) {
      this.shufflePosition = this.shuffleOrder.indexOf(idx);
    }

    this.broadcastSelectionChange();
    return this.getCurrentItem();
  }

  /**
   * Selects a specific item by index.
   *
   * @param index - The index of the item to select
   * @returns The selected item, or null if index is invalid
   */
  public selectIndex(index: number): PlaylistItem | null {
    if (index < 0 || index >= this.items.length) return null;

    this.currentIndex = index;
    this.playHistory.push(index);

    if (this.shuffleEnabled) {
      this.shufflePosition = this.shuffleOrder.indexOf(index);
    }

    this.broadcastSelectionChange();
    return this.getCurrentItem();
  }

  /**
   * Advances to the next track in the playlist.
   *
   * In shuffle mode, advances through the shuffle order.
   * In repeat mode, wraps to the beginning when reaching the end.
   *
   * @returns The next item, or null if at end of playlist (and not repeating)
   */
  public next(): PlaylistItem | null {
    if (this.items.length === 0) return null;

    if (this.repeatEnabled && !this.canGoNext()) {
      // Repeat playlist from beginning
      if (this.shuffleEnabled) {
        this.regenerateShuffleOrder();
        this.shufflePosition = 0;
        this.currentIndex = this.shuffleOrder[0];
      } else {
        this.currentIndex = 0;
      }
      this.playHistory.push(this.currentIndex);
      this.broadcastSelectionChange();
      return this.getCurrentItem();
    }

    if (!this.canGoNext()) return null;

    if (this.shuffleEnabled) {
      this.shufflePosition++;
      this.currentIndex = this.shuffleOrder[this.shufflePosition];
    } else {
      this.currentIndex++;
    }

    this.playHistory.push(this.currentIndex);
    this.broadcastSelectionChange();
    return this.getCurrentItem();
  }

  /**
   * Goes to the previous track in the playlist.
   *
   * First checks play history for the previously played track.
   * Falls back to sequential/shuffle navigation if no history.
   * In repeat mode, wraps to the end when at the beginning.
   *
   * @returns The previous item, or null if at beginning (and not repeating)
   */
  public previous(): PlaylistItem | null {
    if (this.items.length === 0) return null;

    // Check play history first
    if (this.playHistory.length > 1) {
      this.playHistory.pop();
      const prevIdx: number | undefined = this.playHistory[this.playHistory.length - 1];
      if (prevIdx !== undefined && prevIdx >= 0 && prevIdx < this.items.length) {
        this.currentIndex = prevIdx;
        if (this.shuffleEnabled) {
          this.shufflePosition = this.shuffleOrder.indexOf(prevIdx);
        }
        this.broadcastSelectionChange();
        return this.getCurrentItem();
      }
    }

    if (!this.canGoPrevious()) {
      if (this.repeatEnabled) {
        if (this.shuffleEnabled) {
          this.shufflePosition = this.shuffleOrder.length - 1;
          this.currentIndex = this.shuffleOrder[this.shufflePosition];
        } else {
          this.currentIndex = this.items.length - 1;
        }
        this.playHistory.push(this.currentIndex);
        this.broadcastSelectionChange();
        return this.getCurrentItem();
      }
      return null;
    }

    if (this.shuffleEnabled) {
      this.shufflePosition--;
      this.currentIndex = this.shuffleOrder[this.shufflePosition];
    } else {
      this.currentIndex--;
    }

    this.playHistory.push(this.currentIndex);
    this.broadcastSelectionChange();
    return this.getCurrentItem();
  }

  /**
   * Enables or disables shuffle mode.
   *
   * When enabling shuffle, generates a new random order with the
   * current track at the front. Resets play history.
   *
   * @param enabled - Whether to enable shuffle mode
   */
  public setShuffle(enabled: boolean): void {
    if (this.shuffleEnabled === enabled) return;

    this.shuffleEnabled = enabled;

    if (enabled) {
      this.regenerateShuffleOrder();
      this.shufflePosition = this.shuffleOrder.indexOf(this.currentIndex);
      if (this.shufflePosition === -1) this.shufflePosition = 0;
    }

    this.playHistory = [this.currentIndex];
    this.broadcastModeChange();
  }

  /**
   * Enables or disables repeat mode.
   *
   * When repeat is enabled, the playlist wraps around instead of stopping.
   *
   * @param enabled - Whether to enable repeat mode
   */
  public setRepeat(enabled: boolean): void {
    if (this.repeatEnabled === enabled) return;
    this.repeatEnabled = enabled;
    this.broadcastModeChange();
  }

  /**
   * Checks if there's a next track available (without repeat).
   */
  private canGoNext(): boolean {
    if (this.items.length === 0) return false;
    if (this.shuffleEnabled) {
      return this.shufflePosition < this.shuffleOrder.length - 1;
    }
    return this.currentIndex < this.items.length - 1;
  }

  /**
   * Checks if there's a previous track available (without repeat).
   */
  private canGoPrevious(): boolean {
    if (this.items.length === 0) return false;
    if (this.shuffleEnabled) {
      return this.shufflePosition > 0;
    }
    return this.currentIndex > 0;
  }

  /**
   * Regenerates the shuffle order using Fisher-Yates algorithm.
   *
   * The current track is moved to the front of the shuffle order
   * to avoid immediately repeating it when shuffle is enabled.
   */
  private regenerateShuffleOrder(): void {
    const length: number = this.items.length;
    if (length === 0) {
      this.shuffleOrder = [];
      return;
    }

    this.shuffleOrder = Array.from({ length }, (_: unknown, i: number): number => i);

    // Fisher-Yates shuffle
    for (let i: number = length - 1; i > 0; i--) {
      const j: number = Math.floor(Math.random() * (i + 1));
      [this.shuffleOrder[i], this.shuffleOrder[j]] = [this.shuffleOrder[j], this.shuffleOrder[i]];
    }

    // Move current track to front
    const currentIdx: number = this.currentIndex;
    if (currentIdx >= 0) {
      const posInShuffle: number = this.shuffleOrder.indexOf(currentIdx);
      if (posInShuffle > 0) {
        [this.shuffleOrder[0], this.shuffleOrder[posInShuffle]] = [this.shuffleOrder[posInShuffle], this.shuffleOrder[0]];
      }
    }

    this.shufflePosition = 0;
  }

  /**
   * Generates a unique ID for a playlist item.
   * Combines timestamp with random string for uniqueness.
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /** Broadcasts full playlist state to all clients */
  private broadcastPlaylistUpdate(): void {
    this.sse.broadcast('playlist:updated', this.getState());
  }

  /** Broadcasts current selection change to all clients */
  private broadcastSelectionChange(): void {
    this.sse.broadcast('playlist:selection', {
      currentIndex: this.currentIndex,
      currentItem: this.getCurrentItem(),
    });
  }

  /** Broadcasts shuffle/repeat mode change to all clients */
  private broadcastModeChange(): void {
    this.sse.broadcast('playlist:mode', {
      shuffleEnabled: this.shuffleEnabled,
      repeatEnabled: this.repeatEnabled,
    });
    this.onModeChange?.(this.shuffleEnabled, this.repeatEnabled);
  }
}

// ============================================================================
// Unified Media Server
// ============================================================================

/**
 * HTTP server providing the complete media player backend.
 *
 * This server provides:
 * - Media streaming (native formats with range requests, transcoded formats)
 * - MIDI playback via FluidSynth synthesis
 * - Playback control API (play, pause, seek, volume)
 * - Playlist management API (add, remove, next, previous, shuffle, repeat)
 * - Real-time state updates via Server-Sent Events
 * - Media metadata extraction via ffprobe
 *
 * The server maintains authoritative state for:
 * - Current playback position (tracked via interval timer)
 * - Volume and mute state
 * - Playlist contents and current selection
 * - Shuffle/repeat mode
 *
 * @example
 * const server = new UnifiedMediaServer();
 * const port = await server.start();
 * console.log(`Server running on http://127.0.0.1:${port}`);
 */
export class UnifiedMediaServer {
  /** The Node.js HTTP server instance */
  private server: Server | null = null;

  /** The port the server is listening on */
  private port: number = 0;

  /** SSE manager for real-time client updates */
  private readonly sse: SSEManager = new SSEManager();

  /** Settings manager for persistent user preferences */
  private readonly settings: SettingsManager = new SettingsManager();

  /** Playlist manager instance */
  private readonly playlist: PlaylistManager;

  /** Current playback state */
  private readonly playback: PlaybackState = {
    state: 'idle',
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    currentMedia: null,
    errorMessage: null,
  };

  /** Interval for updating playback time */
  private timeUpdateInterval: NodeJS.Timeout | null = null;

  /** Path to static files for serving Angular app in production */
  private staticPath: string | null = null;

  /** Timestamp when playback started (for calculating current time) */
  private startTime: number = 0;

  /** Time position when playback was paused (for resume) */
  private pausedTime: number = 0;

  /** Callback for playlist mode changes (shuffle/repeat) */
  private onModeChangeCallback: ((shuffle: boolean, repeat: boolean) => void) | null = null;

  /** Callback for playlist count changes (for menu enabled state) */
  private onPlaylistCountChangeCallback: ((count: number) => void) | null = null;

  /** Callback for playback state changes (for menu state) */
  private onPlaybackStateChangeCallback: ((isPlaying: boolean) => void) | null = null;

  /**
   * Creates a new unified media server.
   * Call start() to begin listening for connections.
   */
  public constructor(staticPath?: string) {
    this.playlist = new PlaylistManager(this.sse, this.handleModeChange.bind(this));
    this.staticPath = staticPath ?? null;
  }

  /**
   * Registers a callback for playlist mode changes.
   *
   * @param callback - Function called when shuffle/repeat mode changes
   */
  public onModeChange(callback: (shuffle: boolean, repeat: boolean) => void): void {
    this.onModeChangeCallback = callback;
  }

  /**
   * Registers a callback for playlist count changes.
   *
   * @param callback - Function called when playlist item count changes
   */
  public onPlaylistCountChange(callback: (count: number) => void): void {
    this.onPlaylistCountChangeCallback = callback;
  }

  /**
   * Registers a callback for playback state changes.
   *
   * @param callback - Function called when playback state changes
   */
  public onPlaybackStateChange(callback: (isPlaying: boolean) => void): void {
    this.onPlaybackStateChangeCallback = callback;
  }

  /**
   * Internal handler for mode changes from PlaylistManager.
   */
  private handleModeChange(shuffle: boolean, repeat: boolean): void {
    this.onModeChangeCallback?.(shuffle, repeat);
  }

  /**
   * Starts the HTTP server.
   *
   * Binds to localhost only for security (127.0.0.1).
   * Uses the port configured in settings, or auto-assigns if set to 0.
   *
   * @returns Promise resolving to the port number
   * @throws Error if server fails to start
   */
  public async start(): Promise<number> {
    return new Promise((resolve: (value: number) => void, reject: (reason: Readonly<Error>) => void): void => {
      this.server = createServer(this.handleRequest.bind(this));
      this.server.on('error', reject);

      // Use configured port, or 0 for auto-assign
      const configuredPort: number = this.settings.getSettings().application.serverPort;

      this.server.listen(configuredPort, '127.0.0.1', (): void => {
        const address: ReturnType<Server['address']> = this.server!.address();
        if (typeof address === 'object' && address) {
          this.port = address.port;
          console.log(`Unified media server started on http://127.0.0.1:${this.port}`);
          this.sse.start();
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });
    });
  }

  /**
   * Stops the HTTP server and cleans up resources.
   */
  public stop(): void {
    this.stopTimeTracking();
    this.sse.stop();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /**
   * Gets the port the server is listening on.
   *
   * @returns The port number, or 0 if not started
   */
  public getPort(): number {
    return this.port;
  }

  /**
   * Gets the settings manager instance.
   *
   * Used by main.ts to access window state settings (miniplayer bounds).
   *
   * @returns The SettingsManager instance
   */
  public getSettingsManager(): SettingsManager {
    return this.settings;
  }

  /**
   * Clears the playlist and resets playback state.
   *
   * Used by main.ts to clear playlist when window closes on macOS.
   * Also resets playback to idle state to prevent stale state on window reopen.
   */
  public clearPlaylist(): void {
    // Stop playback and reset state
    this.playback.state = 'idle';
    this.playback.currentTime = 0;
    this.playback.duration = 0;
    this.playback.currentMedia = null;
    this.playback.errorMessage = null;
    this.stopTimeTracking();

    // Clear the playlist
    this.playlist.clear();

    // Broadcast the reset state
    this.broadcastState();
    this.broadcastTime();
  }

  // ============================================================================
  // HTTP Request Router
  // ============================================================================

  /**
   * Main request handler that routes HTTP requests to appropriate handlers.
   *
   * Handles CORS preflight requests and routes based on path/method.
   * All errors are caught and returned as JSON error responses.
   *
   * @param req - Incoming HTTP request
   * @param res - HTTP response to write to
   */
  private async handleRequest(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const url: URL = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    const method: string = req.method || 'GET';
    const pathname: string = url.pathname;

    // Set CORS headers for browser access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Route matching
      if (pathname === '/events' && method === 'GET') {
        this.handleSSE(req, res);
      } else if (pathname === '/media/stream' && method === 'GET') {
        this.handleMediaStream(req, res, url);
      } else if (pathname === '/media/info' && method === 'GET') {
        await this.handleMediaInfo(res, url);
      } else if (pathname === '/player/play' && method === 'POST') {
        await this.handlePlay(res);
      } else if (pathname === '/player/pause' && method === 'POST') {
        this.handlePause(res);
      } else if (pathname === '/player/stop' && method === 'POST') {
        this.handleStop(res);
      } else if (pathname === '/player/seek' && method === 'POST') {
        await this.handleSeek(req, res);
      } else if (pathname === '/player/volume' && method === 'POST') {
        await this.handleVolume(req, res);
      } else if (pathname === '/player/state' && method === 'GET') {
        this.handlePlayerState(res);
      } else if (pathname === '/playlist' && method === 'GET') {
        this.handlePlaylistGet(res);
      } else if (pathname === '/playlist/add' && method === 'POST') {
        await this.handlePlaylistAdd(req, res);
      } else if (pathname.startsWith('/playlist/remove/') && method === 'DELETE') {
        await this.handlePlaylistRemove(res, pathname);
      } else if (pathname === '/playlist/clear' && method === 'DELETE') {
        this.handlePlaylistClear(res);
      } else if (pathname.startsWith('/playlist/select/') && method === 'POST') {
        await this.handlePlaylistSelect(res, pathname);
      } else if (pathname === '/playlist/next' && method === 'POST') {
        await this.handlePlaylistNext(res);
      } else if (pathname === '/playlist/previous' && method === 'POST') {
        await this.handlePlaylistPrevious(res);
      } else if (pathname === '/playlist/shuffle' && method === 'POST') {
        await this.handlePlaylistShuffle(req, res);
      } else if (pathname === '/playlist/repeat' && method === 'POST') {
        await this.handlePlaylistRepeat(req, res);
      } else if (pathname === '/settings' && method === 'GET') {
        this.handleSettingsGet(res);
      } else if (pathname === '/settings/visualization' && method === 'PUT') {
        await this.handleSettingsVisualization(req, res);
      } else if (pathname === '/settings/application' && method === 'PUT') {
        await this.handleSettingsApplication(req, res);
      } else if (pathname === '/settings/playback' && method === 'PUT') {
        await this.handleSettingsPlayback(req, res);
      } else if (pathname === '/settings/transcoding' && method === 'PUT') {
        await this.handleSettingsTranscoding(req, res);
      } else if (pathname === '/settings/appearance' && method === 'PUT') {
        await this.handleSettingsAppearance(req, res);
      } else if (this.staticPath) {
        // Serve static files for Angular app in production
        this.serveStaticFile(req, res, pathname);
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      console.error('Request error:', err);
      const errorMessage: string = err instanceof Error ? err.message : 'Unknown error';

      // Return 413 for body too large errors
      if (errorMessage === 'Request body too large') {
        res.writeHead(413);
        res.end(JSON.stringify({ error: 'Request body too large' }));
      } else {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  }

  // ============================================================================
  // SSE Handler
  // ============================================================================

  /**
   * Handles SSE connection requests.
   *
   * Sets up the response for SSE streaming and sends initial state.
   * The connection is kept alive and used for broadcasting updates.
   *
   * @param req - Incoming HTTP request
   * @param res - HTTP response (becomes SSE stream)
   */
  private handleSSE(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    this.sse.addClient(res);

    // Send initial state so client is immediately synchronized
    res.write(`event: playback:state\ndata: ${JSON.stringify({ state: this.playback.state, errorMessage: this.playback.errorMessage })}\n\n`);
    res.write(`event: playback:time\ndata: ${JSON.stringify({ currentTime: this.playback.currentTime, duration: this.playback.duration })}\n\n`);
    res.write(`event: playback:volume\ndata: ${JSON.stringify({ volume: this.playback.volume, muted: this.playback.muted })}\n\n`);
    res.write(`event: playlist:updated\ndata: ${JSON.stringify(this.playlist.getState())}\n\n`);
    res.write(`event: settings:updated\ndata: ${JSON.stringify(this.settings.getSettings())}\n\n`);

    if (this.playback.currentMedia) {
      res.write(`event: playback:loaded\ndata: ${JSON.stringify(this.playback.currentMedia)}\n\n`);
    }

    req.on('close', (): void => {
      // Client cleanup handled by SSEManager
    });
  }

  // ============================================================================
  // Media Streaming
  // ============================================================================

  /**
   * Validates that a file path is safe to serve.
   *
   * Security checks:
   * - Path must be absolute (starts with /)
   * - Path must not contain traversal sequences (..)
   * - File must exist
   * - Path must point to a regular file (not directory, symlink, etc.)
   *
   * @param filePath - The file path to validate
   * @returns Object with valid flag and optional error message
   */
  private validateFilePath(filePath: string): { valid: boolean; error?: string } {
    // Check for path traversal attempts
    if (filePath.includes('..')) {
      console.warn(`[Security] Path traversal attempt blocked: ${filePath}`);
      return { valid: false, error: 'Invalid path: traversal not allowed' };
    }

    // Ensure path is absolute
    if (!path.isAbsolute(filePath)) {
      return { valid: false, error: 'Invalid path: must be absolute' };
    }

    // Normalize the path and verify it matches (catches encoded traversal)
    const normalizedPath: string = path.normalize(filePath);
    if (normalizedPath !== filePath && normalizedPath !== filePath.replace(/\/+/g, '/')) {
      console.warn(`[Security] Path normalization mismatch blocked: ${filePath} -> ${normalizedPath}`);
      return { valid: false, error: 'Invalid path: suspicious path detected' };
    }

    // Check file exists
    if (!existsSync(filePath)) {
      return { valid: false, error: 'File not found' };
    }

    // Verify it's a regular file (not directory, symlink to sensitive location, etc.)
    try {
      const stats = statSync(filePath);
      if (!stats.isFile()) {
        return { valid: false, error: 'Path is not a regular file' };
      }
    } catch {
      return { valid: false, error: 'Cannot access file' };
    }

    return { valid: true };
  }

  /**
   * Routes media stream requests based on file type.
   *
   * Determines whether the file needs:
   * - Direct serving (native formats with range request support)
   * - Transcoding (non-native video/audio formats via FFmpeg)
   * - MIDI synthesis (MIDI files via FluidSynth)
   *
   * @param req - Incoming HTTP request
   * @param res - HTTP response to write to
   * @param url - Parsed URL with path parameter
   */
  private handleMediaStream(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, url: Readonly<URL>): void {
    const filePath: string | null = url.searchParams.get('path');
    if (!filePath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing path parameter' }));
      return;
    }

    // Validate file path for security
    const validation: { valid: boolean; error?: string } = this.validateFilePath(filePath);
    if (!validation.valid) {
      res.writeHead(validation.error === 'File not found' ? 404 : 400);
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }

    const ext: string = path.extname(filePath).toLowerCase();
    const isNativeVideo: boolean = NATIVE_VIDEO_FORMATS.has(ext);
    const isNativeAudio: boolean = NATIVE_AUDIO_FORMATS.has(ext);
    const isMidi: boolean = MIDI_FORMATS.has(ext);

    if (isMidi) {
      this.serveMidiFile(req, res, filePath);
    } else if (isNativeVideo || isNativeAudio) {
      this.serveDirectFile(req, res, filePath, ext);
    } else {
      this.serveTranscodedFile(req, res, filePath, url);
    }
  }

  /**
   * Serves a native format file directly with HTTP range request support.
   *
   * Range requests enable:
   * - Seeking without downloading the entire file
   * - Efficient partial content delivery
   * - Standard browser media element behavior
   *
   * @param req - Incoming HTTP request (may contain Range header)
   * @param res - HTTP response to write to
   * @param filePath - Absolute path to the file
   * @param ext - File extension (for MIME type lookup)
   */
  private serveDirectFile(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, filePath: string, ext: string): void {
    try {
      const stat: ReturnType<typeof statSync> = statSync(filePath);
      const fileSize: number = stat.size;
      const mimeType: string = MIME_TYPES[ext] || 'application/octet-stream';
      const range: string | undefined = req.headers.range;

      if (range) {
        // Partial content response (206)
        const parts: string[] = range.replace(/bytes=/, '').split('-');
        const start: number = parseInt(parts[0], 10);
        const end: number = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize: number = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mimeType,
          'Access-Control-Allow-Origin': '*',
        });

        createReadStream(filePath, { start, end, highWaterMark: 2 * 1024 * 1024 }).pipe(res); // 2MB buffer for NAS/network latency
      } else {
        // Full file response (200)
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': mimeType,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
        });

        createReadStream(filePath, { highWaterMark: 2 * 1024 * 1024 }).pipe(res); // 2MB buffer for NAS/network latency
      }
    } catch (err) {
      console.error('Error serving file:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Error reading file' }));
    }
  }

  /**
   * Serves static files for the Angular application in production.
   */
  private serveStaticFile(_req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, pathname: string): void {
    if (!this.staticPath) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Map pathname to file, default to index.html for SPA routing
    let filePath: string = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(this.staticPath, filePath);

    // Security: ensure path is within static directory
    if (!filePath.startsWith(this.staticPath)) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    if (!existsSync(filePath)) {
      // SPA fallback: serve index.html for unknown routes
      filePath = path.join(this.staticPath, 'index.html');
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
    }

    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      const ext: string = path.extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
      };
      const mimeType: string = mimeTypes[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': stat.size,
      });
      createReadStream(filePath).pipe(res);
    } catch (err) {
      console.error('Error serving static file:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Error reading file' }));
    }
  }

  /**
   * Serves a non-native format via FFmpeg transcoding.
   *
   * For video files (.mkv, .avi, .mov):
   * - Transcodes to H.264 video in fragmented MP4 container
   * - Uses fast preset with zero latency tuning for streaming
   * - Supports seeking via the 't' query parameter
   *
   * For audio files (.wma, .ape, .tak):
   * - Transcodes to AAC in ADTS container
   *
   * The transcoded stream is piped directly to the HTTP response.
   *
   * @param req - Incoming HTTP request
   * @param res - HTTP response to write to
   * @param filePath - Absolute path to the file
   * @param url - URL containing optional 't' (time) parameter for seeking
   */
  private serveTranscodedFile(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, filePath: string, url: Readonly<URL>): void {
    const seekTime: string = url.searchParams.get('t') || '0';
    const ext: string = path.extname(filePath).toLowerCase();

    // Determine if this is audio-only transcoding
    const isAudioTranscode: boolean = ['.wma', '.ape', '.tak'].includes(ext);

    // Get transcoding settings
    const transcodingSettings: {videoQuality: string; audioBitrate: number} = {
      videoQuality: this.settings.getSettings().transcoding.videoQuality,
      audioBitrate: this.settings.getSettings().transcoding.audioBitrate,
    };

    // Convert video quality to CRF value (lower = better quality)
    const crfMap: Record<string, string> = {low: '28', medium: '23', high: '18'};
    const crfValue: string = crfMap[transcodingSettings.videoQuality] || '23';

    // Convert audio bitrate to FFmpeg format
    const audioBitrateStr: string = `${transcodingSettings.audioBitrate}k`;

    console.log(`Transcoding: ${filePath} (seek: ${seekTime}s, audio-only: ${isAudioTranscode}, crf: ${crfValue}, audio: ${audioBitrateStr})`);

    let ffmpegArgs: string[];

    if (isAudioTranscode) {
      // Audio-only transcoding to AAC/ADTS
      ffmpegArgs = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-ss', seekTime,
        '-i', filePath,
        '-c:a', 'aac',
        '-b:a', audioBitrateStr,
        '-ar', '48000',
        '-f', 'adts',
        'pipe:1'
      ];
      res.writeHead(200, {
        'Content-Type': 'audio/aac',
        'Transfer-Encoding': 'chunked',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
    } else {
      // Video transcoding optimized for real-time 4K/UHD playback
      ffmpegArgs = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-threads', '0',            // Use all available CPU cores
        '-ss', seekTime,            // Seek before input (fast seek)
        '-i', filePath,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',     // Fastest encoding for real-time 4K
        '-tune', 'zerolatency',     // Minimize latency
        '-profile:v', 'high',
        '-level', '5.1',            // Level 5.1 supports 4K (level 4.1 only supports 1080p)
        '-pix_fmt', 'yuv420p',      // Maximum compatibility
        '-crf', crfValue,           // Quality level from settings
        '-maxrate', '20M',          // Max bitrate for VBV buffering
        '-bufsize', '8M',           // VBV buffer size for smooth delivery
        '-g', '30',                 // GOP size: keyframe every 30 frames (~1s at 30fps)
        '-bf', '0',                 // No B-frames for low latency
        '-sc_threshold', '0',       // Disable scene change keyframes for consistent timing
        '-c:a', 'aac',
        '-b:a', audioBitrateStr,    // Audio bitrate from settings
        '-ar', '48000',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof', // Fragmented MP4 for streaming
        '-f', 'mp4',
        'pipe:1'
      ];
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Transfer-Encoding': 'chunked',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
    }

    if (!FFMPEG_PATH) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'ffmpeg not found' }));
      return;
    }
    const ffmpeg: ChildProcess = spawn(FFMPEG_PATH, ffmpegArgs);
    ffmpeg.stdout?.pipe(res);

    ffmpeg.stderr?.on('data', (data: Readonly<Buffer>): void => {
      const msg: string = data.toString().trim();
      if (msg) console.log('FFmpeg:', msg);
    });

    ffmpeg.on('error', (err: Readonly<Error>): void => {
      console.error('FFmpeg spawn error:', err);
      if (!res.headersSent) {
        (res as ServerResponse).writeHead(500);
      }
      (res as ServerResponse).end();
    });

    ffmpeg.on('close', (code: number | null): void => {
      if (code !== 0 && code !== null) {
        console.error(`FFmpeg exited with code ${code}`);
      }
    });

    // Clean up FFmpeg process when client disconnects
    const cleanup: () => void = (): void => {
      if (ffmpeg.exitCode === null) {
        ffmpeg.kill('SIGKILL');
      }
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  /**
   * Serves a MIDI file by synthesizing it via FluidSynth.
   *
   * MIDI files contain musical instructions, not audio data.
   * FluidSynth renders them to raw audio using a SoundFont.
   * The raw audio is then encoded to MP3 via FFmpeg for streaming.
   *
   * Pipeline: MIDI → FluidSynth (raw PCM) → FFmpeg (MP3) → HTTP response
   *
   * @param req - Incoming HTTP request
   * @param res - HTTP response to write to
   * @param filePath - Absolute path to the MIDI file
   */
  private serveMidiFile(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, filePath: string): void {
    // Get audio bitrate from settings
    const audioBitrate: number = this.settings.getSettings().transcoding.audioBitrate;
    const audioBitrateStr: string = `${audioBitrate}k`;

    // Find available SoundFont
    const soundfont: string | undefined = this.findSoundFont();
    if (!soundfont) {
      console.error('No SoundFont found for MIDI playback');
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'No SoundFont available for MIDI playback' }));
      return;
    }

    console.log(`Converting MIDI: ${filePath} (using SoundFont: ${soundfont})`);

    // FluidSynth converts MIDI to raw PCM and outputs to stdout
    if (!FLUIDSYNTH_PATH || !FFMPEG_PATH) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'fluidsynth or ffmpeg not found' }));
      return;
    }

    const fluidsynth: ChildProcess = spawn(FLUIDSYNTH_PATH, [
      '-ni',           // Non-interactive mode
      '-T', 'raw',     // Output format: raw PCM
      '-F', '-',       // Output to stdout
      '-r', '44100',   // Sample rate: 44.1kHz
      soundfont,
      filePath
    ]);

    // Pipe FluidSynth output through FFmpeg to encode as MP3
    const ffmpeg: ChildProcess = spawn(FFMPEG_PATH, [
      '-hide_banner',
      '-loglevel', 'warning',
      '-f', 's16le',        // Input: signed 16-bit little-endian PCM
      '-ar', '44100',       // Input sample rate
      '-ac', '2',           // Input channels: stereo
      '-i', 'pipe:0',       // Read from stdin
      '-c:a', 'libmp3lame', // Encode as MP3
      '-b:a', audioBitrateStr, // Bitrate from settings
      '-f', 'mp3',          // Output format
      'pipe:1'              // Output to stdout
    ]);

    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });

    // Connect the pipeline: FluidSynth → FFmpeg → HTTP Response
    fluidsynth.stdout?.pipe(ffmpeg.stdin!);
    ffmpeg.stdout?.pipe(res);

    fluidsynth.stderr?.on('data', (data: Readonly<Buffer>): void => {
      const msg: string = data.toString().trim();
      if (msg && !msg.includes('FluidSynth')) {
        console.log('FluidSynth:', msg);
      }
    });

    ffmpeg.stderr?.on('data', (data: Readonly<Buffer>): void => {
      const msg: string = data.toString().trim();
      if (msg) console.log('FFmpeg (MIDI):', msg);
    });

    fluidsynth.on('error', (err: Readonly<Error>): void => {
      console.error('FluidSynth spawn error:', err);
      if (!res.headersSent) {
        (res as ServerResponse).writeHead(500);
      }
      (res as ServerResponse).end();
    });

    ffmpeg.on('error', (err: Readonly<Error>): void => {
      console.error('FFmpeg spawn error:', err);
      if (!res.headersSent) {
        (res as ServerResponse).writeHead(500);
      }
      (res as ServerResponse).end();
    });

    fluidsynth.on('close', (code: number | null): void => {
      if (code !== 0 && code !== null) {
        console.error(`FluidSynth exited with code ${code}`);
      }
      // Close FFmpeg stdin when FluidSynth is done
      ffmpeg.stdin?.end();
    });

    ffmpeg.on('close', (code: number | null): void => {
      if (code !== 0 && code !== null) {
        console.error(`FFmpeg exited with code ${code}`);
      }
    });

    // Clean up processes when client disconnects
    const cleanup: () => void = (): void => {
      if (fluidsynth.exitCode === null) {
        fluidsynth.kill('SIGKILL');
      }
      if (ffmpeg.exitCode === null) {
        ffmpeg.kill('SIGKILL');
      }
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  /**
   * Finds the first available SoundFont file from the search paths.
   *
   * @returns Path to SoundFont file, or undefined if none found
   */
  private findSoundFont(): string | undefined {
    for (const sfPath of SOUNDFONT_SEARCH_PATHS) {
      if (existsSync(sfPath)) {
        return sfPath;
      }
    }
    return undefined;
  }

  // ============================================================================
  // Media Info (ffprobe)
  // ============================================================================

  /**
   * Handles requests for media file metadata.
   *
   * @param res - HTTP response to write to
   * @param url - URL containing 'path' parameter
   */
  private async handleMediaInfo(res: Readonly<ServerResponse>, url: Readonly<URL>): Promise<void> {
    const filePath: string | null = url.searchParams.get('path');
    if (!filePath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing path parameter' }));
      return;
    }

    // Validate file path for security
    const validation: { valid: boolean; error?: string } = this.validateFilePath(filePath);
    if (!validation.valid) {
      res.writeHead(validation.error === 'File not found' ? 404 : 400);
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }

    try {
      const info: MediaInfo = await this.probeMedia(filePath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /**
   * Extracts metadata from a media file using ffprobe or MIDI parser.
   *
   * For most formats, spawns ffprobe to extract:
   * - Duration
   * - Stream types (determines audio vs video)
   * - Metadata tags (title, artist, album)
   * - Video dimensions
   *
   * For MIDI files, uses the custom parseMidiDuration function
   * since ffprobe cannot read MIDI files.
   *
   * @param filePath - Absolute path to the media file
   * @returns Promise resolving to media information
   * @throws Error if probing fails
   */
  private probeMedia(filePath: string): Promise<MediaInfo> {
    // MIDI files cannot be probed by ffprobe - parse duration from MIDI data
    const ext: string = path.extname(filePath).toLowerCase();
    if (MIDI_FORMATS.has(ext)) {
      const duration: number = parseMidiDuration(filePath);
      return Promise.resolve({
        duration,
        type: 'audio',
        title: path.basename(filePath, ext),
        filePath,
      });
    }

    return new Promise((resolve: (value: Readonly<MediaInfo>) => void, reject: (reason: Readonly<Error>) => void): void => {
      if (!FFPROBE_PATH) {
        reject(new Error('ffprobe not found'));
        return;
      }
      const ffprobe: ChildProcess = spawn(FFPROBE_PATH, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath
      ]);

      let output: string = '';
      let errorOutput: string = '';

      ffprobe.stdout?.on('data', (data: Readonly<Buffer>): void => { output += data; });
      ffprobe.stderr?.on('data', (data: Readonly<Buffer>): void => { errorOutput += data; });

      ffprobe.on('close', (code: number | null): void => {
        if (code !== 0) {
          reject(new Error(`ffprobe failed: ${errorOutput}`));
          return;
        }

        try {
          const data: { format?: Record<string, unknown>; streams?: Array<Record<string, unknown>> } = JSON.parse(output);
          const format: Record<string, unknown> = data.format || {};
          const streams: Array<Record<string, unknown>> = data.streams || [];

          // Find video stream (exclude mjpeg which is often album art)
          const videoStream: Record<string, unknown> | undefined = streams.find((s: Readonly<Record<string, unknown>>): boolean =>
            s.codec_type === 'video' && s.codec_name !== 'mjpeg'
          );
          const hasVideo: boolean = !!videoStream;

          // Extract metadata tags (handle various case conventions)
          const tags: Record<string, string> = (format.tags as Record<string, string>) || {};

          resolve({
            duration: parseFloat(format.duration as string) || 0,
            type: hasVideo ? 'video' : 'audio',
            title: tags.title || tags.TITLE || path.basename(filePath, path.extname(filePath)),
            artist: tags.artist || tags.ARTIST || tags.album_artist || tags.ALBUM_ARTIST,
            album: tags.album || tags.ALBUM,
            filePath,
            width: videoStream?.width as number | undefined,
            height: videoStream?.height as number | undefined,
          });
        } catch (e) {
          reject(new Error(`Failed to parse ffprobe output: ${e}`));
        }
      });

      ffprobe.on('error', (err: Readonly<Error>): void => {
        reject(new Error(`ffprobe error: ${err.message}`));
      });
    });
  }

  // ============================================================================
  // Playback Control Handlers
  // ============================================================================

  /**
   * Handles play requests.
   *
   * If paused: resumes from paused position
   * If idle/stopped: loads and plays the current track
   *
   * @param res - HTTP response to write to
   */
  private async handlePlay(res: Readonly<ServerResponse>): Promise<void> {
    // If paused, resume from where we left off
    if (this.playback.state === 'paused') {
      this.playback.state = 'playing';
      this.startTime = Date.now() - (this.pausedTime * 1000);
      this.startTimeTracking();
      this.broadcastState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // If no current track, cannot play
    const currentItem: PlaylistItem | null = this.playlist.getCurrentItem();
    if (!currentItem) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'No track selected' }));
      return;
    }

    // Load and play current track
    try {
      this.playback.state = 'loading';
      this.broadcastState();

      const mediaInfo: MediaInfo = await this.probeMedia(currentItem.filePath);
      this.playback.currentMedia = mediaInfo;
      this.playback.duration = mediaInfo.duration;
      this.playback.currentTime = 0;
      this.playback.state = 'playing';
      this.startTime = Date.now();

      this.sse.broadcast('playback:loaded', mediaInfo);
      this.broadcastState();
      this.broadcastTime();
      this.startTimeTracking();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, media: mediaInfo }));
    } catch (err) {
      this.playback.state = 'error';
      this.playback.errorMessage = (err as Error).message;
      this.broadcastState();
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /**
   * Handles pause requests.
   *
   * Stores the current position for resuming later.
   *
   * @param res - HTTP response to write to
   */
  private handlePause(res: Readonly<ServerResponse>): void {
    if (this.playback.state !== 'playing') {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Not playing' }));
      return;
    }

    this.playback.state = 'paused';
    this.pausedTime = this.playback.currentTime;
    this.stopTimeTracking();
    this.broadcastState();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  /**
   * Handles stop requests.
   *
   * Resets playback position to the beginning.
   *
   * @param res - HTTP response to write to
   */
  private handleStop(res: Readonly<ServerResponse>): void {
    this.playback.state = 'stopped';
    this.playback.currentTime = 0;
    this.stopTimeTracking();
    this.broadcastState();
    this.broadcastTime();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  /**
   * Handles seek requests.
   *
   * Updates the playback position. Time is clamped to valid range.
   *
   * @param req - Incoming HTTP request with { time: number } body
   * @param res - HTTP response to write to
   */
  private async handleSeek(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { time }: { time: unknown } = JSON.parse(body);

    if (typeof time !== 'number') {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid time' }));
      return;
    }

    const clampedTime: number = Math.max(0, Math.min(time, this.playback.duration));
    this.playback.currentTime = clampedTime;

    if (this.playback.state === 'playing') {
      this.startTime = Date.now() - (clampedTime * 1000);
    } else {
      this.pausedTime = clampedTime;
    }

    this.broadcastTime();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, time: clampedTime }));
  }

  /**
   * Handles volume change requests.
   *
   * @param req - Incoming HTTP request with { volume?: number, muted?: boolean } body
   * @param res - HTTP response to write to
   */
  private async handleVolume(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { volume, muted }: { volume?: number; muted?: boolean } = JSON.parse(body);

    if (typeof volume === 'number') {
      this.playback.volume = Math.max(0, Math.min(1, volume));
    }
    if (typeof muted === 'boolean') {
      this.playback.muted = muted;
    }

    this.sse.broadcast('playback:volume', {
      volume: this.playback.volume,
      muted: this.playback.muted,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, volume: this.playback.volume, muted: this.playback.muted }));
  }

  /**
   * Handles player state requests.
   *
   * Returns the complete current playback state.
   *
   * @param res - HTTP response to write to
   */
  private handlePlayerState(res: Readonly<ServerResponse>): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      state: this.playback.state,
      currentTime: this.playback.currentTime,
      duration: this.playback.duration,
      volume: this.playback.volume,
      muted: this.playback.muted,
      currentMedia: this.playback.currentMedia,
      errorMessage: this.playback.errorMessage,
    }));
  }

  // ============================================================================
  // Playlist Handlers
  // ============================================================================

  /**
   * Handles playlist state requests.
   *
   * @param res - HTTP response to write to
   */
  private handlePlaylistGet(res: Readonly<ServerResponse>): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.playlist.getState()));
  }

  /**
   * Handles add to playlist requests.
   *
   * Probes each file for metadata and adds to the playlist.
   * Files that fail probing are silently skipped.
   *
   * @param req - Incoming HTTP request with { paths: string[] } body
   * @param res - HTTP response to write to
   */
  private async handlePlaylistAdd(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { paths }: { paths: unknown } = JSON.parse(body);

    if (!Array.isArray(paths)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'paths must be an array' }));
      return;
    }

    // Probe each file for metadata
    const items: Omit<PlaylistItem, 'id'>[] = [];
    for (const filePath of paths as string[]) {
      try {
        const info: MediaInfo = await this.probeMedia(filePath);
        items.push({
          filePath: info.filePath,
          title: info.title,
          artist: info.artist,
          album: info.album,
          duration: info.duration,
          type: info.type,
          width: info.width,
          height: info.height,
        });
      } catch (err) {
        console.error(`Failed to probe ${filePath}:`, err);
      }
    }

    const added: PlaylistItem[] = this.playlist.addItems(items);

    // Notify of playlist count change for menu state
    this.onPlaylistCountChangeCallback?.(this.playlist.getState().items.length);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, added }));
  }

  /**
   * Handles remove from playlist requests.
   *
   * If removing the currently playing item:
   * - If playlist becomes empty: stop and go to idle
   * - If removing last item with repeat on: play first item
   * - Otherwise: play the next item (now at same index)
   *
   * @param res - HTTP response to write to
   * @param pathname - URL path containing item ID
   */
  private async handlePlaylistRemove(res: Readonly<ServerResponse>, pathname: string): Promise<void> {
    const id: string = pathname.replace('/playlist/remove/', '');

    // Check if we're removing the currently playing item
    const currentItem: PlaylistItem | null = this.playlist.getCurrentItem();
    const isRemovingCurrent: boolean = currentItem?.id === id;
    const wasPlaying: boolean = this.playback.state === 'playing' || this.playback.state === 'paused';
    const playlistState: PlaylistState = this.playlist.getState();
    const wasLastItem: boolean = playlistState.currentIndex === playlistState.items.length - 1;
    const hadOnlyOneItem: boolean = playlistState.items.length === 1;

    const success: boolean = this.playlist.removeItem(id);

    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false }));
      return;
    }

    // If we removed the currently playing item, handle playback transition
    if (isRemovingCurrent && wasPlaying) {
      const newState: PlaylistState = this.playlist.getState();

      if (newState.items.length === 0) {
        // Playlist is now empty - stop and go to idle
        this.playback.state = 'idle';
        this.playback.currentMedia = null;
        this.playback.currentTime = 0;
        this.playback.duration = 0;
        this.stopTimeTracking();
        this.broadcastState();
        this.broadcastTime();
      } else if (hadOnlyOneItem) {
        // This shouldn't happen (length would be 0), but handle defensively
        this.playback.state = 'idle';
        this.playback.currentMedia = null;
        this.playback.currentTime = 0;
        this.playback.duration = 0;
        this.stopTimeTracking();
        this.broadcastState();
        this.broadcastTime();
      } else {
        // There are more items - play the next one
        // If we removed the last item, currentIndex now points to the new last item
        // If repeat was on and we were at the end, we should loop to first
        let nextItem: PlaylistItem | null = null;

        if (wasLastItem && playlistState.repeatEnabled) {
          // Was last item with repeat on - select first item
          nextItem = this.playlist.selectIndex(0);
        } else {
          // The item now at currentIndex is the one that was next
          nextItem = this.playlist.getCurrentItem();
        }

        if (nextItem) {
          try {
            this.playback.state = 'loading';
            this.broadcastState();

            const mediaInfo: MediaInfo = await this.probeMedia(nextItem.filePath);
            this.playback.currentMedia = mediaInfo;
            this.playback.duration = mediaInfo.duration;
            this.playback.currentTime = 0;
            this.playback.state = 'playing';
            this.startTime = Date.now();

            this.sse.broadcast('playback:loaded', mediaInfo);
            this.broadcastState();
            this.broadcastTime();
            this.startTimeTracking();
          } catch (err) {
            this.playback.state = 'error';
            this.playback.errorMessage = (err as Error).message;
            this.broadcastState();
          }
        } else {
          // No next item available - go to idle
          this.playback.state = 'idle';
          this.playback.currentMedia = null;
          this.playback.currentTime = 0;
          this.playback.duration = 0;
          this.stopTimeTracking();
          this.broadcastState();
          this.broadcastTime();
        }
      }
    }

    // Notify of playlist count change for menu state
    this.onPlaylistCountChangeCallback?.(this.playlist.getState().items.length);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  /**
   * Handles clear playlist requests.
   *
   * @param res - HTTP response to write to
   */
  private handlePlaylistClear(res: Readonly<ServerResponse>): void {
    this.playlist.clear();
    this.playback.state = 'idle';
    this.playback.currentMedia = null;
    this.playback.currentTime = 0;
    this.playback.duration = 0;
    this.stopTimeTracking();
    this.broadcastState();

    // Notify of playlist count change for menu state
    this.onPlaylistCountChangeCallback?.(0);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  /**
   * Handles track selection requests.
   *
   * Selects the track and automatically starts playback.
   *
   * @param res - HTTP response to write to
   * @param pathname - URL path containing item ID
   */
  private async handlePlaylistSelect(res: Readonly<ServerResponse>, pathname: string): Promise<void> {
    const id: string = pathname.replace('/playlist/select/', '');
    const item: PlaylistItem | null = this.playlist.selectItem(id);

    if (!item) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Item not found' }));
      return;
    }

    // Auto-play selected item
    try {
      this.playback.state = 'loading';
      this.broadcastState();

      const mediaInfo: MediaInfo = await this.probeMedia(item.filePath);
      this.playback.currentMedia = mediaInfo;
      this.playback.duration = mediaInfo.duration;
      this.playback.currentTime = 0;
      this.playback.state = 'playing';
      this.startTime = Date.now();

      this.sse.broadcast('playback:loaded', mediaInfo);
      this.broadcastState();
      this.broadcastTime();
      this.startTimeTracking();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, item, media: mediaInfo }));
    } catch (err) {
      this.playback.state = 'error';
      this.playback.errorMessage = (err as Error).message;
      this.broadcastState();
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /**
   * Handles next track requests.
   *
   * Advances to the next track and starts playback.
   * If at the end of the playlist, returns ended: true.
   *
   * @param res - HTTP response to write to
   */
  private async handlePlaylistNext(res: Readonly<ServerResponse>): Promise<void> {
    const item: PlaylistItem | null = this.playlist.next();

    if (!item) {
      // End of playlist reached
      this.playback.state = 'idle';
      this.playback.currentTime = 0;
      this.stopTimeTracking();
      this.broadcastState();
      this.sse.broadcast('playback:ended', {});

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ended: true }));
      return;
    }

    // Play next item
    try {
      this.playback.state = 'loading';
      this.broadcastState();

      const mediaInfo: MediaInfo = await this.probeMedia(item.filePath);
      this.playback.currentMedia = mediaInfo;
      this.playback.duration = mediaInfo.duration;
      this.playback.currentTime = 0;
      this.playback.state = 'playing';
      this.startTime = Date.now();

      this.sse.broadcast('playback:loaded', mediaInfo);
      this.broadcastState();
      this.broadcastTime();
      this.startTimeTracking();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, item, media: mediaInfo }));
    } catch (err) {
      this.playback.state = 'error';
      this.playback.errorMessage = (err as Error).message;
      this.broadcastState();
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /**
   * Handles previous track requests.
   *
   * Goes to the previous track and starts playback.
   *
   * @param res - HTTP response to write to
   */
  private async handlePlaylistPrevious(res: Readonly<ServerResponse>): Promise<void> {
    const item: PlaylistItem | null = this.playlist.previous();

    if (!item) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, reason: 'No previous track' }));
      return;
    }

    // Play previous item
    try {
      this.playback.state = 'loading';
      this.broadcastState();

      const mediaInfo: MediaInfo = await this.probeMedia(item.filePath);
      this.playback.currentMedia = mediaInfo;
      this.playback.duration = mediaInfo.duration;
      this.playback.currentTime = 0;
      this.playback.state = 'playing';
      this.startTime = Date.now();

      this.sse.broadcast('playback:loaded', mediaInfo);
      this.broadcastState();
      this.broadcastTime();
      this.startTimeTracking();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, item, media: mediaInfo }));
    } catch (err) {
      this.playback.state = 'error';
      this.playback.errorMessage = (err as Error).message;
      this.broadcastState();
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /**
   * Handles shuffle mode toggle requests.
   *
   * @param req - Incoming HTTP request with { enabled: boolean } body
   * @param res - HTTP response to write to
   */
  private async handlePlaylistShuffle(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { enabled }: { enabled: unknown } = JSON.parse(body);

    this.playlist.setShuffle(!!enabled);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, shuffleEnabled: enabled }));
  }

  /**
   * Handles repeat mode toggle requests.
   *
   * @param req - Incoming HTTP request with { enabled: boolean } body
   * @param res - HTTP response to write to
   */
  private async handlePlaylistRepeat(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { enabled }: { enabled: unknown } = JSON.parse(body);

    this.playlist.setRepeat(!!enabled);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, repeatEnabled: enabled }));
  }

  // ============================================================================
  // Settings Handlers
  // ============================================================================

  /**
   * Handles settings retrieval requests.
   *
   * Returns the complete application settings.
   *
   * @param res - HTTP response to write to
   */
  private handleSettingsGet(res: Readonly<ServerResponse>): void {
    const settings: AppSettings = this.settings.getSettings();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(settings));
  }

  /**
   * Handles visualization settings update requests.
   *
   * Updates visualization preferences and broadcasts the change to all clients.
   *
   * @param req - Incoming HTTP request with VisualizationSettingsUpdate body
   * @param res - HTTP response to write to
   */
  private async handleSettingsVisualization(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const update: VisualizationSettingsUpdate = JSON.parse(body) as VisualizationSettingsUpdate;

    const updatedSettings: AppSettings = this.settings.updateVisualizationSettings(update);

    // Broadcast the updated settings to all clients
    this.sse.broadcast('settings:updated', updatedSettings);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, settings: updatedSettings }));
  }

  /**
   * Handles PUT /settings/application requests.
   *
   * Updates application settings and broadcasts the change to all clients.
   * Note: Server port changes require app restart to take effect.
   *
   * @param req - Incoming HTTP request with ApplicationSettingsUpdate body
   * @param res - HTTP response to write to
   */
  private async handleSettingsApplication(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const update: ApplicationSettingsUpdate = JSON.parse(body) as ApplicationSettingsUpdate;

    const updatedSettings: AppSettings = this.settings.updateApplicationSettings(update);

    // Broadcast the updated settings to all clients
    this.sse.broadcast('settings:updated', updatedSettings);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, settings: updatedSettings }));
  }

  /**
   * Handles PUT /settings/playback requests.
   *
   * Updates playback settings and broadcasts the change to all clients.
   *
   * @param req - Incoming HTTP request with PlaybackSettingsUpdate body
   * @param res - HTTP response to write to
   */
  private async handleSettingsPlayback(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const update: PlaybackSettingsUpdate = JSON.parse(body) as PlaybackSettingsUpdate;

    const updatedSettings: AppSettings = this.settings.updatePlaybackSettings(update);

    // Broadcast the updated settings to all clients
    this.sse.broadcast('settings:updated', updatedSettings);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, settings: updatedSettings }));
  }

  /**
   * Handles PUT /settings/transcoding requests.
   *
   * Updates transcoding settings and broadcasts the change to all clients.
   *
   * @param req - Incoming HTTP request with TranscodingSettingsUpdate body
   * @param res - HTTP response to write to
   */
  private async handleSettingsTranscoding(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const update: TranscodingSettingsUpdate = JSON.parse(body) as TranscodingSettingsUpdate;

    const updatedSettings: AppSettings = this.settings.updateTranscodingSettings(update);

    // Broadcast the updated settings to all clients
    this.sse.broadcast('settings:updated', updatedSettings);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, settings: updatedSettings }));
  }

  /**
   * Handles PUT /settings/appearance requests.
   *
   * Updates appearance settings and broadcasts the change to all clients.
   * Note: Appearance settings require an application restart to take effect.
   *
   * @param req - Incoming HTTP request with AppearanceSettingsUpdate body
   * @param res - HTTP response to write to
   */
  private async handleSettingsAppearance(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const update: AppearanceSettingsUpdate = JSON.parse(body) as AppearanceSettingsUpdate;

    const updatedSettings: AppSettings = this.settings.updateAppearanceSettings(update);

    // Broadcast the updated settings to all clients
    this.sse.broadcast('settings:updated', updatedSettings);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, settings: updatedSettings }));
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Maximum allowed request body size in bytes (1MB).
   * Prevents memory exhaustion attacks from oversized requests.
   */
  private static readonly MAX_BODY_SIZE: number = 1024 * 1024;

  /**
   * Reads the body of an HTTP request as a string.
   *
   * Security: Enforces maximum body size to prevent memory exhaustion.
   *
   * @param req - Incoming HTTP request
   * @returns Promise resolving to the body string
   * @throws Error if body exceeds MAX_BODY_SIZE
   */
  private readBody(req: Readonly<IncomingMessage>): Promise<string> {
    return new Promise((resolve: (value: string) => void, reject: (reason: Readonly<Error>) => void): void => {
      const chunks: Buffer[] = [];
      let totalSize: number = 0;

      req.on('data', (chunk: Readonly<Buffer>): void => {
        totalSize += chunk.length;
        if (totalSize > UnifiedMediaServer.MAX_BODY_SIZE) {
          req.destroy();
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk as Buffer);
      });

      req.on('end', (): void => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });

      req.on('error', reject);
    });
  }

  /**
   * Starts the playback time tracking interval.
   *
   * Updates currentTime every 100ms based on elapsed time since startTime.
   * Automatically triggers onMediaEnded when duration is reached.
   */
  private startTimeTracking(): void {
    this.stopTimeTracking();

    this.timeUpdateInterval = setInterval((): void => {
      if (this.playback.state !== 'playing') return;

      this.playback.currentTime = (Date.now() - this.startTime) / 1000;

      if (this.playback.currentTime >= this.playback.duration) {
        this.playback.currentTime = this.playback.duration;
        void this.onMediaEnded();
        return;
      }

      this.broadcastTime();
    }, 100);
  }

  /**
   * Stops the playback time tracking interval.
   */
  private stopTimeTracking(): void {
    if (this.timeUpdateInterval) {
      clearInterval(this.timeUpdateInterval);
      this.timeUpdateInterval = null;
    }
  }

  /**
   * Handles media ended event.
   *
   * Attempts to play the next track. If no next track is available,
   * transitions to idle state and broadcasts ended event.
   */
  private async onMediaEnded(): Promise<void> {
    this.stopTimeTracking();

    // Try to play next track
    const nextItem: PlaylistItem | null = this.playlist.next();

    if (!nextItem) {
      this.playback.state = 'idle';
      this.playback.currentTime = 0;
      this.broadcastState();
      this.sse.broadcast('playback:ended', {});
      return;
    }

    // Play next
    try {
      this.playback.state = 'loading';
      this.broadcastState();

      const mediaInfo: MediaInfo = await this.probeMedia(nextItem.filePath);
      this.playback.currentMedia = mediaInfo;
      this.playback.duration = mediaInfo.duration;
      this.playback.currentTime = 0;
      this.playback.state = 'playing';
      this.startTime = Date.now();

      this.sse.broadcast('playback:loaded', mediaInfo);
      this.broadcastState();
      this.broadcastTime();
      this.startTimeTracking();
    } catch (err) {
      this.playback.state = 'error';
      this.playback.errorMessage = (err as Error).message;
      this.broadcastState();
    }
  }

  /**
   * Broadcasts current playback state to all SSE clients.
   */
  private broadcastState(): void {
    this.sse.broadcast('playback:state', {
      state: this.playback.state,
      errorMessage: this.playback.errorMessage,
    });

    // Notify of playback state change for menu state
    this.onPlaybackStateChangeCallback?.(this.playback.state === 'playing');
  }

  /**
   * Broadcasts current time and duration to all SSE clients.
   */
  private broadcastTime(): void {
    this.sse.broadcast('playback:time', {
      currentTime: this.playback.currentTime,
      duration: this.playback.duration,
    });
  }
}

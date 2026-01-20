/**
 * @fileoverview High-level media player service for Angular components.
 *
 * This service provides a simplified, component-friendly interface for media
 * playback control. It wraps the ElectronService and exposes computed signals
 * that are easier to use in templates.
 *
 * Design principles:
 * - Single source of truth: All state comes from ElectronService (which mirrors server state)
 * - Computed signals: Derived state is computed from base signals
 * - Convenient methods: High-level operations like togglePlayPause(), previous() with restart logic
 * - Aliases: Multiple names for the same signal to match different component preferences
 *
 * This service doesn't hold its own state - it's a facade over ElectronService
 * that makes the API more ergonomic for UI components.
 *
 * @module app/services/media-player.service
 */

import {Injectable, computed, inject, effect, OnDestroy, EffectRef} from '@angular/core';
import {ElectronService, MediaInfo, PlaylistItem} from './electron.service';
import {SettingsService} from './settings.service';

/**
 * Possible playback states.
 *
 * - idle: No media loaded
 * - loading: Media is being loaded
 * - playing: Active playback
 * - paused: Paused at current position
 * - stopped: Stopped (position at beginning)
 * - error: An error occurred
 */
export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error';

/**
 * High-level media player service for use by Angular components.
 *
 * Provides:
 * - Reactive signals for all playback and playlist state
 * - Convenience methods for common operations
 * - Derived/computed state (isPlaying, progress percentage, etc.)
 * - Time formatting utilities
 *
 * All state is derived from ElectronService which maintains the actual
 * connection to the media server. This service acts as a facade that
 * simplifies the API for UI components.
 *
 * @example
 * // In a component
 * export class PlayerControls {
 *   private player = inject(MediaPlayerService);
 *
 *   // Use in template: {{ player.isPlaying() ? 'Pause' : 'Play' }}
 *   async togglePlay() {
 *     await this.player.togglePlayPause();
 *   }
 *
 *   // Display formatted time: {{ player.formatTime(player.currentTime()) }}
 * }
 */
@Injectable({providedIn: 'root'})
export class MediaPlayerService implements OnDestroy {
  /** Reference to the underlying Electron service */
  private readonly electron: ElectronService = inject(ElectronService);

  /** Reference to settings service for configurable behaviors */
  private readonly settings: SettingsService = inject(SettingsService);

  /** Whether the default volume has been applied on startup */
  private defaultVolumeApplied: boolean = false;

  /** Effect reference for cleanup */
  private readonly defaultVolumeEffect: EffectRef;

  /**
   * Constructor - sets up reactive effects for settings initialization.
   */
  public constructor() {
    // Apply default volume when settings load for the first time
    this.defaultVolumeEffect = effect((): void => {
      const isLoaded: boolean = this.settings.isLoaded();
      const defaultVolume: number = this.settings.defaultVolume();

      if (isLoaded && !this.defaultVolumeApplied) {
        this.defaultVolumeApplied = true;
        // Apply default volume on startup
        void this.electron.setVolume(defaultVolume);
      }
    });
  }

  /**
   * Cleans up resources when the service is destroyed.
   */
  public ngOnDestroy(): void {
    this.defaultVolumeEffect.destroy();
  }

  // ============================================================================
  // Signals - Direct Passthrough from ElectronService
  // ============================================================================

  /**
   * Current playback state (idle, loading, playing, paused, stopped, error).
   * Cast to PlaybackState type for better type safety in components.
   */
  public readonly playbackState: ReturnType<typeof computed<PlaybackState>> = computed((): PlaybackState => this.electron.playbackState() as PlaybackState);

  /** Current playback position in seconds */
  public readonly currentTime: ReturnType<typeof computed<number>> = computed((): number => this.electron.currentTime());

  /** Total duration of current track in seconds */
  public readonly duration: ReturnType<typeof computed<number>> = computed((): number => this.electron.duration());

  /** Current volume level (0.0 to 1.0) */
  public readonly volume: ReturnType<typeof computed<number>> = computed((): number => this.electron.volume());

  /** Whether audio is muted */
  public readonly muted: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.muted());

  /** Base URL of the media server */
  public readonly serverUrl: ReturnType<typeof computed<string>> = computed((): string => this.electron.serverUrl());

  /** Error message if in error state, null otherwise */
  public readonly errorMessage: ReturnType<typeof computed<string | null>> = computed((): string | null => this.electron.errorMessage());

  // ============================================================================
  // Signals - Playlist State
  // ============================================================================

  /** Complete playlist state object */
  public readonly playlist: ReturnType<typeof computed<ReturnType<typeof this.electron.playlist>>> = computed((): ReturnType<typeof this.electron.playlist> => this.electron.playlist());

  /** Array of all playlist items */
  public readonly playlistItems: ReturnType<typeof computed<PlaylistItem[]>> = computed((): PlaylistItem[] => this.electron.playlist().items);

  /** Number of items in the playlist */
  public readonly playlistCount: ReturnType<typeof computed<number>> = computed((): number => this.electron.playlist().items.length);

  /** Whether shuffle mode is enabled */
  public readonly isShuffleEnabled: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.playlist().shuffleEnabled);

  /** Whether repeat mode is enabled */
  public readonly isRepeatEnabled: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.playlist().repeatEnabled);

  // ============================================================================
  // Signals - Current Track
  // ============================================================================

  /**
   * Currently playing track, or null if none.
   * Derived from playlist state using currentIndex.
   */
  public readonly currentTrack: ReturnType<typeof computed<PlaylistItem | null>> = computed((): PlaylistItem | null => {
    const p: ReturnType<typeof this.electron.playlist> = this.electron.playlist();
    if (p.currentIndex >= 0 && p.currentIndex < p.items.length) {
      return p.items[p.currentIndex];
    }
    return null;
  });

  /** Media info for current track (may have more detail than PlaylistItem) */
  public readonly currentMedia: ReturnType<typeof computed<MediaInfo | null>> = computed((): MediaInfo | null => this.electron.currentMedia());

  /** Media type of current track: 'audio', 'video', or null if none */
  public readonly currentMediaType: ReturnType<typeof computed<'audio' | 'video' | null>> = computed((): 'audio' | 'video' | null => this.electron.currentMedia()?.type ?? null);

  // ============================================================================
  // Signals - Derived/Computed State
  // ============================================================================

  /** Whether playback is currently active */
  public readonly isPlaying: ReturnType<typeof computed<boolean>> = computed((): boolean => this.playbackState() === 'playing');

  /** Whether playback is paused */
  public readonly isPaused: ReturnType<typeof computed<boolean>> = computed((): boolean => this.playbackState() === 'paused');

  /** Whether media is being loaded */
  public readonly isLoading: ReturnType<typeof computed<boolean>> = computed((): boolean => this.playbackState() === 'loading');

  /** Whether the playlist is empty */
  public readonly isEmpty: ReturnType<typeof computed<boolean>> = computed((): boolean => this.playlistCount() === 0);

  /**
   * Playback progress as a percentage (0-100).
   * Useful for progress bars and sliders.
   */
  public readonly progress: ReturnType<typeof computed<number>> = computed((): number => {
    const dur: number = this.duration();
    return dur > 0 ? (this.currentTime() / dur) * 100 : 0;
  });

  // ============================================================================
  // Signal Aliases - For Component Compatibility
  // ============================================================================

  /** Alias for playbackState */
  public readonly state: typeof this.playbackState = this.playbackState;

  /** Alias for currentTime */
  public readonly time: typeof this.currentTime = this.currentTime;

  /** Alias for duration */
  public readonly totalDuration: typeof this.duration = this.duration;

  /** Alias for volume */
  public readonly currentVolume: typeof this.volume = this.volume;

  /** Alias for muted */
  public readonly isMuted: typeof this.muted = this.muted;

  /** Alias for errorMessage */
  public readonly error: typeof this.errorMessage = this.errorMessage;

  // ============================================================================
  // File Operations
  // ============================================================================

  /**
   * Opens file picker and adds selected files to playlist.
   *
   * If the playlist was empty before adding files, automatically
   * starts playback of the first added file.
   *
   * @example
   * // Called from an "Open" button
   * await player.eject();
   */
  public async eject(): Promise<void> {
    const files: string[] = await this.electron.openFileDialog(true);
    if (files.length === 0) return;

    const wasEmpty: boolean = this.isEmpty();

    // Server will probe files and add to playlist
    await this.electron.addToPlaylist(files);

    // If playlist was empty and we added files, auto-play first
    if (wasEmpty && files.length > 0) {
      await this.electron.play();
    }
  }

  /**
   * Adds files to the playlist without showing a dialog.
   *
   * Used for drag-and-drop where files are already selected.
   * Does not auto-play (caller should handle that if desired).
   *
   * @param files - Array of absolute file paths to add
   */
  public async addFiles(files: string[]): Promise<void> {
    if (files.length === 0) return;
    await this.electron.addToPlaylist(files);
  }

  /**
   * Gets the file system path for a drag-and-drop File object.
   *
   * @param file - File object from DataTransfer
   * @returns Absolute file path
   */
  public getPathForFile(file: File): string {
    return this.electron.getPathForFile(file);
  }

  // ============================================================================
  // Playback Control
  // ============================================================================

  /**
   * Starts or resumes playback.
   */
  public async play(): Promise<void> {
    await this.electron.play();
  }

  /**
   * Pauses playback at current position.
   */
  public async pause(): Promise<void> {
    await this.electron.pause();
  }

  /**
   * Toggles between play and pause states.
   *
   * @example
   * // Single button for play/pause
   * <button (click)="player.togglePlayPause()">
   *   {{ player.isPlaying() ? 'Pause' : 'Play' }}
   * </button>
   */
  public async togglePlayPause(): Promise<void> {
    if (this.isPlaying()) {
      await this.pause();
    } else {
      await this.play();
    }
  }

  /**
   * Stops playback and resets position to beginning.
   */
  public async stop(): Promise<void> {
    await this.electron.stop();
  }

  /**
   * Seeks to a specific time in the current track.
   *
   * The time is clamped to valid range [0, duration].
   *
   * @param timeSeconds - Target position in seconds
   */
  public async seek(timeSeconds: number): Promise<void> {
    const clampedTime: number = Math.max(0, Math.min(timeSeconds, this.duration()));
    await this.electron.seek(clampedTime);
  }

  /**
   * Seeks to a position based on percentage.
   *
   * Useful for progress bar click handling.
   *
   * @param percent - Target position as percentage (0-100)
   *
   * @example
   * // On progress bar click
   * onProgressClick(event) {
   *   const percent = (event.offsetX / event.target.clientWidth) * 100;
   *   await player.seekToProgress(percent);
   * }
   */
  public async seekToProgress(percent: number): Promise<void> {
    const time: number = (percent / 100) * this.duration();
    await this.seek(time);
  }

  /**
   * Skips forward by the configured skip duration.
   * Clamps to the track duration.
   */
  public async skipForward(): Promise<void> {
    const skipAmount: number = this.settings.skipDuration();
    const newTime: number = Math.min(this.currentTime() + skipAmount, this.duration());
    await this.seek(newTime);
  }

  /**
   * Skips backward by the configured skip duration.
   * Clamps to 0.
   */
  public async skipBackward(): Promise<void> {
    const skipAmount: number = this.settings.skipDuration();
    const newTime: number = Math.max(this.currentTime() - skipAmount, 0);
    await this.seek(newTime);
  }

  // ============================================================================
  // Volume Control (client-side for instant response)
  // ============================================================================

  /**
   * Sets the volume level.
   *
   * The value is normalized to [0, 1] range.
   *
   * @param value - Volume level (will be clamped to 0-1)
   */
  public async setVolume(value: number): Promise<void> {
    const normalized: number = Math.max(0, Math.min(1, value));
    // Volume is handled client-side in AudioOutlet/VideoOutlet
    // but we also tell the server for persistence
    await this.electron.setVolume(normalized);
  }

  /**
   * Toggles mute state while preserving volume level.
   */
  public async toggleMute(): Promise<void> {
    await this.electron.setVolume(this.volume(), !this.muted());
  }

  // ============================================================================
  // Track Navigation
  // ============================================================================

  /**
   * Advances to the next track in the playlist.
   * Respects shuffle mode if enabled.
   */
  public async next(): Promise<void> {
    await this.electron.nextTrack();
  }

  /**
   * Goes to the previous track, with restart-current behavior.
   *
   * If playback is past the configured threshold (default 3 seconds),
   * restarts the current track instead of going to previous.
   * This matches the behavior of most media players.
   * Set threshold to 0 to always go to previous track.
   */
  public async previous(): Promise<void> {
    const threshold: number = this.settings.previousTrackThreshold();
    // If past threshold, restart current track (unless threshold is 0)
    if (threshold > 0 && this.currentTime() > threshold) {
      await this.seek(0);
      return;
    }
    await this.electron.previousTrack();
  }

  /**
   * Selects and plays a specific track by its ID.
   *
   * @param id - Unique track ID
   */
  public async selectTrack(id: string): Promise<void> {
    await this.electron.selectTrack(id);
  }

  /**
   * Selects and plays a track by its index in the playlist.
   *
   * @param index - Zero-based index in the playlist
   */
  public async selectTrackByIndex(index: number): Promise<void> {
    const items: PlaylistItem[] = this.playlistItems();
    if (index >= 0 && index < items.length) {
      await this.electron.selectTrack(items[index].id);
    }
  }

  // ============================================================================
  // Playlist Management
  // ============================================================================

  /**
   * Removes a track from the playlist.
   *
   * @param id - Unique track ID to remove
   */
  public async removeTrack(id: string): Promise<void> {
    await this.electron.removeFromPlaylist(id);
  }

  /**
   * Clears all tracks from the playlist.
   * Also stops playback.
   */
  public async clearPlaylist(): Promise<void> {
    await this.electron.clearPlaylist();
  }

  /**
   * Toggles shuffle mode.
   */
  public async toggleShuffle(): Promise<void> {
    await this.electron.setShuffle(!this.isShuffleEnabled());
  }

  /**
   * Toggles repeat mode.
   */
  public async toggleRepeat(): Promise<void> {
    await this.electron.setRepeat(!this.isRepeatEnabled());
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Formats a time value in seconds to a display string.
   *
   * Returns format "M:SS" (e.g., "3:45" for 225 seconds).
   * Handles invalid values gracefully by returning "0:00".
   *
   * @param seconds - Time in seconds
   * @returns Formatted time string
   *
   * @example
   * formatTime(125);  // "2:05"
   * formatTime(3661); // "61:01"
   * formatTime(-5);   // "0:00"
   * formatTime(NaN);  // "0:00"
   */
  public formatTime(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const mins: number = Math.floor(seconds / 60);
    const secs: number = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
}

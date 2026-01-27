/**
 * @fileoverview Playback controls component for the media player.
 *
 * This component provides the main control interface for media playback,
 * including transport controls (play/pause, previous, next), a seek bar,
 * volume control, and playlist mode toggles (shuffle, repeat).
 *
 * Layout (left to right):
 * - Eject button (open files)
 * - Shuffle toggle
 * - Previous track
 * - Play/Pause
 * - Next track
 * - Repeat toggle
 * - Time display (current / total)
 * - Progress/seek bar
 * - Volume control (mute toggle + slider)
 *
 * All controls delegate to MediaPlayerService for actual operations.
 * State is read reactively via computed signals.
 *
 * @module app/components/layout/layout-controls
 */

import {Component, inject, computed, ChangeDetectionStrategy} from '@angular/core';
import {DependencyService} from '../../../services/dependency.service';
import {TransportControlsBase} from '../../shared/transport-controls-base';
import type {PlaylistItem} from '../../../types/electron';

/**
 * Safely extracts value from an input element event target.
 */
function getInputValue(event: Event): string {
  const target: EventTarget | null = event.target;
  return target instanceof HTMLInputElement ? target.value : '';
}

/**
 * Control bar component with playback controls, seek bar, and volume.
 *
 * Features:
 * - Transport controls: play/pause, previous, next
 * - Seek bar: click-to-seek and drag support
 * - Volume: mute toggle and slider
 * - Mode toggles: shuffle and repeat
 * - Time display: current position / total duration
 * - Eject: opens file picker to add media
 *
 * The component uses Angular signals for reactive state updates.
 * Button states (enabled/disabled, active) are computed from
 * the media player service state.
 *
 * Extends TransportControlsBase for shared transport logic (icons, Shift key,
 * skip/forward/backward handlers).
 *
 * @example
 * <!-- In a parent template -->
 * <app-layout-controls />
 */
@Component({
  selector: 'app-layout-controls',
  standalone: true,
  imports: [],
  templateUrl: './layout-controls.html',
  styleUrl: './layout-controls.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LayoutControls extends TransportControlsBase {
  /** Dependency service for checking installed dependencies */
  private readonly deps: DependencyService = inject(DependencyService);

  // ============================================================================
  // Reactive State Signals
  // ============================================================================

  /** Whether file opening is possible (at least one dependency installed) */
  public readonly canOpenFiles: ReturnType<typeof computed<boolean>> = computed((): boolean => !this.deps.noDependenciesInstalled());

  /** Current playback progress as percentage (0-100) for the seek bar */
  public readonly progress: ReturnType<typeof computed<number>> = computed((): number => this.mediaPlayer.progress());

  /** Current volume as percentage (0-100) for the volume slider */
  public readonly volume: ReturnType<typeof computed<number>> = computed((): number => this.mediaPlayer.currentVolume() * 100);

  /** Whether audio is muted (affects mute button icon) */
  public readonly isMuted: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.isMuted());

  /** Whether shuffle mode is enabled (affects shuffle button styling) */
  public readonly isShuffleEnabled: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.isShuffleEnabled());

  /** Whether repeat mode is enabled (affects repeat button styling) */
  public readonly isRepeatEnabled: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.isRepeatEnabled());

  /** Current playback time formatted as "M:SS" */
  public readonly currentTime: ReturnType<typeof computed<string>> = computed((): string => this.mediaPlayer.formatTime(this.mediaPlayer.time()));

  /** Total duration formatted as "M:SS" */
  public readonly totalDuration: ReturnType<typeof computed<string>> = computed((): string => this.mediaPlayer.formatTime(this.mediaPlayer.totalDuration()));

  /**
   * Formatted track title for display.
   * Returns "Artist - Title" if artist is available, otherwise just title.
   */
  public readonly trackTitle: ReturnType<typeof computed<string>> = computed((): string => {
    const track: PlaylistItem | null = this.mediaPlayer.currentTrack();
    if (!track) return '';
    return track.artist ? `${track.artist} - ${track.title}` : track.title;
  });

  /** Whether the application is currently in fullscreen mode */
  public readonly isFullscreen: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.isFullscreen());

  // ============================================================================
  // Event Handlers - File Operations
  // ============================================================================

  /**
   * Opens the file picker dialog to add media files.
   * If playlist was empty, starts playing the first added file.
   */
  public async onEject(): Promise<void> {
    await this.mediaPlayer.eject();
  }

  // ============================================================================
  // Event Handlers - Playlist Modes
  // ============================================================================

  /**
   * Toggles shuffle mode on/off.
   * When shuffle is on, next/previous use randomized order.
   */
  public async onShuffle(): Promise<void> {
    await this.mediaPlayer.toggleShuffle();
  }

  /**
   * Toggles repeat mode on/off.
   * When repeat is on, playlist loops after the last track.
   */
  public async onRepeat(): Promise<void> {
    await this.mediaPlayer.toggleRepeat();
  }

  // ============================================================================
  // Event Handlers - Volume Control
  // ============================================================================

  /**
   * Handles volume slider changes.
   *
   * @param event - Input event from the volume range slider
   */
  public async onVolumeChange(event: Event): Promise<void> {
    const value: number = parseFloat(getInputValue(event));
    if (!isNaN(value)) await this.mediaPlayer.setVolume(value / 100);
  }

  /**
   * Toggles mute state while preserving volume level.
   */
  public async onMuteToggle(): Promise<void> {
    await this.mediaPlayer.toggleMute();
  }

  // ============================================================================
  // Event Handlers - Window Control
  // ============================================================================

  /**
   * Toggles between fullscreen and windowed mode.
   */
  public async onToggleFullscreen(): Promise<void> {
    await this.electron.toggleFullscreen();
  }

  /**
   * Enters miniplayer mode.
   * Shrinks window to compact size with only visualization and minimal controls.
   */
  public async onEnterMiniplayer(): Promise<void> {
    await this.electron.enterMiniplayer();
  }

  // ============================================================================
  // Event Handlers - Seek Control
  // ============================================================================

  /**
   * Handles seek slider changes (drag seeking).
   *
   * @param event - Input event from the progress range slider
   */
  public async onSeek(event: Event): Promise<void> {
    const value: number = parseFloat(getInputValue(event));
    if (!isNaN(value)) await this.mediaPlayer.seekToProgress(value);
  }

  /**
   * Handles click-to-seek on the progress bar background.
   *
   * Calculates the target position based on click position relative
   * to the progress bar width, enabling precise seeking.
   *
   * @param event - Mouse click event on the progress bar
   */
  public async onProgressClick(event: MouseEvent): Promise<void> {
    const target: EventTarget | null = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const rect: DOMRect = target.getBoundingClientRect();
    const percent: number = ((event.clientX - rect.left) / rect.width) * 100;
    await this.mediaPlayer.seekToProgress(percent);
  }
}

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

import {Component, inject, computed, signal, HostListener, ChangeDetectionStrategy} from '@angular/core';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
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
export class LayoutControls {
  /** Media player service for all playback operations */
  private readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);

  /** Electron service for fullscreen control */
  private readonly electron: ElectronService = inject(ElectronService);

  // ============================================================================
  // Reactive State Signals
  // ============================================================================

  /** Whether playback is currently active (affects play/pause button icon) */
  public readonly isPlaying: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.isPlaying());

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

  /** Whether a track is loaded (enables/disables transport controls) */
  public readonly hasTrack: ReturnType<typeof computed<boolean>> = computed((): boolean => !!this.mediaPlayer.currentTrack());

  /**
   * Whether backward button should be enabled.
   * Enabled when: Shift pressed (can skip by time) OR 2+ tracks (can change track).
   */
  public readonly canSkipBackward: ReturnType<typeof computed<boolean>> = computed((): boolean =>
    this.isShiftPressed() || this.mediaPlayer.playlistCount() > 1
  );

  /**
   * Whether forward button should be enabled.
   * Enabled when: Shift pressed (can skip by time) OR can advance to next track.
   */
  public readonly canSkipForward: ReturnType<typeof computed<boolean>> = computed((): boolean => {
    if (this.isShiftPressed()) return true;
    const count: number = this.mediaPlayer.playlistCount();
    if (count <= 1) return false;
    if (this.mediaPlayer.isRepeatEnabled()) return true;
    const currentIndex: number = this.electron.playlist().currentIndex;
    return currentIndex < count - 1;
  });

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

  /** Whether the Shift key is currently pressed */
  private readonly isShiftPressed: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Icon class for the backward button (changes with Shift key when enabled) */
  public readonly backwardIcon: ReturnType<typeof computed<string>> = computed((): string => {
    if (this.hasTrack() && this.isShiftPressed()) {
      return 'fa-solid fa-backward';
    }
    return 'fa-solid fa-backward-step';
  });

  /** Icon class for the forward button (changes with Shift key when enabled) */
  public readonly forwardIcon: ReturnType<typeof computed<string>> = computed((): string => {
    if (this.hasTrack() && this.isShiftPressed()) {
      return 'fa-solid fa-forward';
    }
    return 'fa-solid fa-forward-step';
  });

  // ============================================================================
  // Keyboard Event Listeners
  // ============================================================================

  /**
   * Tracks Shift key press state for button icon changes.
   */
  @HostListener('document:keydown', ['$event'])
  public onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Shift') {
      this.isShiftPressed.set(true);
    }
  }

  /**
   * Tracks Shift key release state for button icon changes.
   */
  @HostListener('document:keyup', ['$event'])
  public onKeyUp(event: KeyboardEvent): void {
    if (event.key === 'Shift') {
      this.isShiftPressed.set(false);
    }
  }

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
  // Event Handlers - Transport Controls
  // ============================================================================

  /**
   * Goes to previous track, or skips backward if Shift is pressed.
   * Without Shift: previous track (or restart if past threshold)
   * With Shift: skip backward by configured duration
   *
   * @param event - Mouse event to check for Shift modifier
   */
  public async onBackward(event: MouseEvent): Promise<void> {
    if (event.shiftKey) {
      await this.mediaPlayer.skipBackward();
    } else {
      await this.mediaPlayer.previous();
    }
  }

  /**
   * Toggles between play and pause states.
   */
  public async onPlayPause(): Promise<void> {
    await this.mediaPlayer.togglePlayPause();
  }

  /**
   * Advances to next track, or skips forward if Shift is pressed.
   * Without Shift: next track
   * With Shift: skip forward by configured duration
   *
   * @param event - Mouse event to check for Shift modifier
   */
  public async onForward(event: MouseEvent): Promise<void> {
    if (event.shiftKey) {
      await this.mediaPlayer.skipForward();
    } else {
      await this.mediaPlayer.next();
    }
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

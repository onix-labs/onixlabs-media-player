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

import {Component, inject, computed, ChangeDetectionStrategy, OnDestroy} from '@angular/core';
import {DependencyService} from '../../../services/dependency.service';
import {TransportControlsBase} from '../../shared/transport-controls-base';
import type {PlaylistItem} from '../../../types/electron';

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
export class LayoutControls extends TransportControlsBase implements OnDestroy {
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
   * Toggles mute state while preserving volume level.
   */
  public async onMuteToggle(): Promise<void> {
    await this.mediaPlayer.toggleMute();
  }

  // ============================================================================
  // Volume Slider Drag State
  // ============================================================================

  /** Whether the volume slider is currently being dragged */
  private isDraggingVolume: boolean = false;

  /** Reference to the volume slider element being dragged */
  private volumeSliderElement: HTMLElement | null = null;

  /** Bound handler for mousemove during volume drag (stored for cleanup) */
  private readonly boundOnVolumeMouseMove: (e: MouseEvent) => void = this.onVolumeMouseMove.bind(this);

  /** Bound handler for mouseup during volume drag (stored for cleanup) */
  private readonly boundOnVolumeMouseUp: (e: MouseEvent) => void = this.onVolumeMouseUp.bind(this);

  /**
   * Handles mousedown on the volume slider to start drag.
   * Also handles single clicks by immediately setting volume to the clicked position.
   *
   * @param event - Mouse down event on the volume slider
   */
  public onVolumeMouseDown(event: MouseEvent): void {
    const target: EventTarget | null = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;

    event.preventDefault();
    this.isDraggingVolume = true;
    this.volumeSliderElement = target;

    // Set volume to clicked position immediately
    this.setVolumeFromPosition(event.clientX);

    // Add document-level listeners for drag tracking
    document.addEventListener('mousemove', this.boundOnVolumeMouseMove);
    document.addEventListener('mouseup', this.boundOnVolumeMouseUp);
  }

  /**
   * Handles mousemove during volume slider drag.
   * Updates the volume as the user drags.
   *
   * @param event - Mouse move event
   */
  private onVolumeMouseMove(event: MouseEvent): void {
    if (!this.isDraggingVolume || !this.volumeSliderElement) return;
    this.setVolumeFromPosition(event.clientX);
  }

  /**
   * Handles mouseup to end volume slider drag.
   * Cleans up document event listeners.
   *
   * @param event - Mouse up event
   */
  private onVolumeMouseUp(event: MouseEvent): void {
    if (!this.isDraggingVolume) return;

    // Final volume set to release position
    if (this.volumeSliderElement) {
      this.setVolumeFromPosition(event.clientX);
    }

    this.isDraggingVolume = false;
    this.volumeSliderElement = null;

    // Remove document-level listeners
    document.removeEventListener('mousemove', this.boundOnVolumeMouseMove);
    document.removeEventListener('mouseup', this.boundOnVolumeMouseUp);
  }

  /**
   * Calculates and sets volume based on mouse X coordinate.
   *
   * @param clientX - The mouse X position relative to the viewport
   */
  private setVolumeFromPosition(clientX: number): void {
    if (!this.volumeSliderElement) return;
    const rect: DOMRect = this.volumeSliderElement.getBoundingClientRect();
    const percent: number = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    void this.mediaPlayer.setVolume(percent / 100);
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
  // Seek Bar Drag State
  // ============================================================================

  /** Whether the seek bar is currently being dragged */
  private isDraggingSeek: boolean = false;

  /** Reference to the progress element being dragged */
  private seekBarElement: HTMLElement | null = null;

  /** Bound handler for mousemove during drag (stored for cleanup) */
  private readonly boundOnSeekMouseMove: (e: MouseEvent) => void = this.onSeekMouseMove.bind(this);

  /** Bound handler for mouseup during drag (stored for cleanup) */
  private readonly boundOnSeekMouseUp: (e: MouseEvent) => void = this.onSeekMouseUp.bind(this);

  // ============================================================================
  // Event Handlers - Seek Control
  // ============================================================================

  /**
   * Handles mousedown on the progress bar to start drag seeking.
   * Also handles single clicks by immediately seeking to the clicked position.
   *
   * @param event - Mouse down event on the progress bar
   */
  public onProgressMouseDown(event: MouseEvent): void {
    const target: EventTarget | null = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;

    event.preventDefault();
    this.isDraggingSeek = true;
    this.seekBarElement = target;

    // Seek to clicked position immediately
    this.seekToPosition(event.clientX);

    // Add document-level listeners for drag tracking
    document.addEventListener('mousemove', this.boundOnSeekMouseMove);
    document.addEventListener('mouseup', this.boundOnSeekMouseUp);
  }

  /**
   * Handles mousemove during seek bar drag.
   * Updates the seek position as the user drags.
   *
   * @param event - Mouse move event
   */
  private onSeekMouseMove(event: MouseEvent): void {
    if (!this.isDraggingSeek || !this.seekBarElement) return;
    this.seekToPosition(event.clientX);
  }

  /**
   * Handles mouseup to end seek bar drag.
   * Cleans up document event listeners.
   *
   * @param event - Mouse up event
   */
  private onSeekMouseUp(event: MouseEvent): void {
    if (!this.isDraggingSeek) return;

    // Final seek to release position
    if (this.seekBarElement) {
      this.seekToPosition(event.clientX);
    }

    this.isDraggingSeek = false;
    this.seekBarElement = null;

    // Remove document-level listeners
    document.removeEventListener('mousemove', this.boundOnSeekMouseMove);
    document.removeEventListener('mouseup', this.boundOnSeekMouseUp);
  }

  /**
   * Calculates and seeks to a position based on mouse X coordinate.
   *
   * @param clientX - The mouse X position relative to the viewport
   */
  private seekToPosition(clientX: number): void {
    if (!this.seekBarElement) return;
    const rect: DOMRect = this.seekBarElement.getBoundingClientRect();
    const percent: number = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    void this.mediaPlayer.seekToProgress(percent);
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Cleanup when component is destroyed.
   * Removes any active document event listeners.
   */
  public ngOnDestroy(): void {
    document.removeEventListener('mousemove', this.boundOnSeekMouseMove);
    document.removeEventListener('mouseup', this.boundOnSeekMouseUp);
    document.removeEventListener('mousemove', this.boundOnVolumeMouseMove);
    document.removeEventListener('mouseup', this.boundOnVolumeMouseUp);
  }
}

/**
 * @fileoverview Shared base directive for transport control components.
 *
 * Provides common playback transport logic shared between the main layout
 * controls and the miniplayer controls, including:
 * - Shift key state tracking (for skip/stop alternate actions)
 * - Computed signals for button icons and enabled state
 * - Transport control event handlers (backward, play/pause, forward)
 *
 * @module app/components/shared/transport-controls-base
 */

import {Directive, inject, computed, signal, HostListener} from '@angular/core';
import {MediaPlayerService} from '../../services/media-player.service';
import {ElectronService} from '../../services/electron.service';

/**
 * Abstract base directive for transport control components.
 *
 * Both `LayoutControls` and `MiniplayerControls` extend this to share
 * transport button logic without duplication. The directive manages Shift
 * key state and provides computed signals for icon classes and enabled state.
 */
@Directive()
export abstract class TransportControlsBase {
  /** Media player service for playback operations */
  protected readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);

  /** Electron service for playlist state access */
  protected readonly electron: ElectronService = inject(ElectronService);

  /** Whether the Shift key is currently pressed */
  private readonly isShiftPressed: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  // ============================================================================
  // Computed Signals
  // ============================================================================

  /** Whether playback is currently active (affects play/pause button icon) */
  public readonly isPlaying: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.isPlaying());

  /** Whether a track is loaded (enables/disables transport controls) */
  public readonly hasTrack: ReturnType<typeof computed<boolean>> = computed((): boolean => !!this.mediaPlayer.currentTrack());

  /** Whether backward button should be enabled */
  public readonly canSkipBackward: ReturnType<typeof computed<boolean>> = computed((): boolean =>
    this.mediaPlayer.playlistCount() >= 1
  );

  /** Whether forward button should be enabled */
  public readonly canSkipForward: ReturnType<typeof computed<boolean>> = computed((): boolean => {
    if (this.isShiftPressed()) return true;
    const count: number = this.mediaPlayer.playlistCount();
    if (count <= 1) return false;
    if (this.mediaPlayer.isRepeatEnabled()) return true;
    const currentIndex: number = this.electron.playlist().currentIndex;
    return currentIndex < count - 1;
  });

  /** Icon class for the backward button (changes with Shift key) */
  public readonly backwardIcon: ReturnType<typeof computed<string>> = computed((): string => {
    if (this.hasTrack() && this.isShiftPressed()) {
      return 'fa-solid fa-backward';
    }
    return 'fa-solid fa-backward-step';
  });

  /** Icon class for the forward button (changes with Shift key) */
  public readonly forwardIcon: ReturnType<typeof computed<string>> = computed((): string => {
    if (this.hasTrack() && this.isShiftPressed()) {
      return 'fa-solid fa-forward';
    }
    return 'fa-solid fa-forward-step';
  });

  /** Icon class for the play/pause button (changes to stop with Shift key) */
  public readonly playPauseIcon: ReturnType<typeof computed<string>> = computed((): string => {
    if (this.hasTrack() && this.isShiftPressed()) {
      return 'fa-solid fa-stop';
    }
    return this.isPlaying() ? 'fa-solid fa-pause' : 'fa-solid fa-play';
  });

  // ============================================================================
  // Keyboard Event Listeners
  // ============================================================================

  /** Tracks Shift key press state for button icon changes. */
  @HostListener('document:keydown', ['$event'])
  public onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Shift') {
      this.isShiftPressed.set(true);
    }
  }

  /** Tracks Shift key release state for button icon changes. */
  @HostListener('document:keyup', ['$event'])
  public onKeyUp(event: KeyboardEvent): void {
    if (event.key === 'Shift') {
      this.isShiftPressed.set(false);
    }
  }

  // ============================================================================
  // Transport Control Handlers
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
   * Toggles between play and pause states, or stops if Shift is pressed.
   *
   * @param event - Mouse event to check for Shift modifier
   */
  public async onPlayPause(event: MouseEvent): Promise<void> {
    if (event.shiftKey) {
      await this.mediaPlayer.stop();
    } else {
      await this.mediaPlayer.togglePlayPause();
    }
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
}

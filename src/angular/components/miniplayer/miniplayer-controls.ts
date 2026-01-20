/**
 * @fileoverview Miniplayer controls component with minimal playback buttons.
 *
 * This component provides a compact control overlay for the miniplayer mode.
 * It includes only essential controls: previous, play/pause, next, and exit.
 *
 * The controls appear on hover over the miniplayer window and fade out
 * when the mouse leaves.
 *
 * @module app/components/miniplayer/miniplayer-controls
 */

import {Component, computed, inject, signal, HostListener, ChangeDetectionStrategy} from '@angular/core';
import {MediaPlayerService} from '../../services/media-player.service';
import {ElectronService} from '../../services/electron.service';

/**
 * Miniplayer controls component.
 *
 * Provides a minimal set of playback controls for the compact miniplayer mode:
 * - Previous track button
 * - Play/pause toggle button
 * - Next track button
 * - Exit miniplayer button (return to desktop mode)
 *
 * The component uses the same MediaPlayerService as the main controls,
 * ensuring consistent playback behavior.
 */
@Component({
  selector: 'app-miniplayer-controls',
  standalone: true,
  imports: [],
  templateUrl: './miniplayer-controls.html',
  styleUrl: './miniplayer-controls.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MiniplayerControls {
  /** Media player service for playback control */
  private readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);

  /** Electron service for window control */
  private readonly electron: ElectronService = inject(ElectronService);

  /** Whether playback is currently active */
  public readonly isPlaying: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.isPlaying());

  /** Whether any track is loaded */
  public readonly hasTrack: ReturnType<typeof computed<boolean>> = computed((): boolean => !!this.mediaPlayer.currentTrack());

  /** Whether the Shift key is currently pressed */
  private readonly isShiftPressed: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

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
   * Handles play/pause button click.
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

  /**
   * Handles exit miniplayer button click.
   * Returns to desktop mode, restoring previous window size and position.
   */
  public async onExitMiniplayer(): Promise<void> {
    await this.electron.exitMiniplayer();
  }
}

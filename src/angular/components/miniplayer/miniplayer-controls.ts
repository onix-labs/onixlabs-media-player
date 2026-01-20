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

import {Component, computed, inject, ChangeDetectionStrategy} from '@angular/core';
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

  /** Whether skip backward button should be enabled (requires 2+ tracks) */
  public readonly canSkipBackward: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.playlistCount() > 1);

  /**
   * Whether skip forward button should be enabled.
   * Requires 2+ tracks AND either repeat is enabled OR not on the last track.
   */
  public readonly canSkipForward: ReturnType<typeof computed<boolean>> = computed((): boolean => {
    const count: number = this.mediaPlayer.playlistCount();
    if (count <= 1) return false;
    if (this.mediaPlayer.isRepeatEnabled()) return true;
    const currentIndex: number = this.electron.playlist().currentIndex;
    return currentIndex < count - 1;
  });

  /** Whether any track is loaded */
  public readonly hasTrack: ReturnType<typeof computed<boolean>> = computed((): boolean => !!this.mediaPlayer.currentTrack());

  /**
   * Handles previous track button click.
   * Uses the same logic as main controls (respects previous track threshold).
   */
  public async onBackward(): Promise<void> {
    await this.mediaPlayer.previous();
  }

  /**
   * Handles play/pause button click.
   */
  public async onPlayPause(): Promise<void> {
    await this.mediaPlayer.togglePlayPause();
  }

  /**
   * Handles next track button click.
   */
  public async onForward(): Promise<void> {
    await this.mediaPlayer.next();
  }

  /**
   * Handles exit miniplayer button click.
   * Returns to desktop mode, restoring previous window size and position.
   */
  public async onExitMiniplayer(): Promise<void> {
    await this.electron.exitMiniplayer();
  }
}

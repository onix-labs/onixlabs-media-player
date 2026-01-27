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

import {Component, ChangeDetectionStrategy} from '@angular/core';
import {TransportControlsBase} from '../shared/transport-controls-base';

/**
 * Miniplayer controls component.
 *
 * Provides a minimal set of playback controls for the compact miniplayer mode:
 * - Previous track button
 * - Play/pause toggle button
 * - Next track button
 * - Exit miniplayer button (return to desktop mode)
 *
 * Extends TransportControlsBase for shared transport logic (icons, Shift key,
 * skip/forward/backward handlers).
 */
@Component({
  selector: 'app-miniplayer-controls',
  standalone: true,
  imports: [],
  templateUrl: './miniplayer-controls.html',
  styleUrl: './miniplayer-controls.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MiniplayerControls extends TransportControlsBase {
  /**
   * Handles exit miniplayer button click.
   * Returns to desktop mode, restoring previous window size and position.
   */
  public async onExitMiniplayer(): Promise<void> {
    await this.electron.exitMiniplayer();
  }
}

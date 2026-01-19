/**
 * @fileoverview Header component for the application title bar area.
 *
 * This component renders the top header area of the media player window.
 * It provides controls that are typically found in a window title bar,
 * specifically the fullscreen toggle button.
 *
 * In fullscreen mode, this header becomes part of the auto-hiding
 * UI controlled by the Root component.
 *
 * @module app/components/layout/layout-header
 */

import {Component, inject, computed, output} from '@angular/core';
import {ElectronService} from '../../../services/electron.service';

/**
 * Header component displaying the application title bar area.
 *
 * Features:
 * - Fullscreen toggle button (expands/contracts icon based on state)
 * - Reactive state binding for fullscreen indicator
 *
 * The header is styled to blend with the Electron window chrome and
 * provides drag-to-move functionality on macOS via CSS (-webkit-app-region: drag).
 *
 * @example
 * <!-- In a parent template -->
 * <app-layout-header />
 */
@Component({
  selector: 'app-layout-header',
  imports: [],
  templateUrl: './layout-header.html',
  styleUrl: './layout-header.scss',
})
export class LayoutHeader {
  /** Service for Electron fullscreen control */
  private readonly electron: ElectronService = inject(ElectronService);

  // ============================================================================
  // Outputs
  // ============================================================================

  /** Event emitted when the settings button is clicked */
  public readonly openSettings = output<void>();

  // ============================================================================
  // Computed State
  // ============================================================================

  /**
   * Whether the application is currently in fullscreen mode.
   * Used to toggle the fullscreen button icon state.
   */
  public readonly isFullscreen: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.isFullscreen());

  // ============================================================================
  // Event Handlers
  // ============================================================================

  /**
   * Toggles between fullscreen and windowed mode.
   * Called when the fullscreen button is clicked.
   */
  public async toggleFullscreen(): Promise<void> {
    await this.electron.toggleFullscreen();
  }

  /**
   * Opens the settings/configuration view.
   * Called when the settings button is clicked.
   */
  public onOpenSettings(): void {
    this.openSettings.emit();
  }
}

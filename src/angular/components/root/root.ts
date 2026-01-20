/**
 * @fileoverview Root component that serves as the application shell.
 *
 * This is the top-level component mounted by Angular's bootstrap process.
 * It orchestrates the main layout structure and handles application-wide
 * concerns like fullscreen mode and control visibility.
 *
 * Component hierarchy:
 * ```
 * Root
 * ├── LayoutHeader    - Title bar with app controls
 * ├── LayoutOutlet    - Main content area (audio/video outlets)
 * └── LayoutControls  - Playback controls bar
 * ```
 *
 * Fullscreen behavior:
 * - In windowed mode: controls are always visible
 * - In fullscreen mode: controls auto-hide after configurable delay (default 5s)
 * - Auto-hide can be disabled in settings (delay=0)
 * - Mouse movement shows controls temporarily
 * - Escape key exits fullscreen
 *
 * @module app/components/root
 */

import {Component, inject, computed, HostBinding, OnDestroy, HostListener, signal, effect} from '@angular/core';
import {LayoutHeader} from '../layout/layout-header/layout-header';
import {LayoutOutlet} from '../layout/layout-outlet/layout-outlet';
import {LayoutControls} from '../layout/layout-controls/layout-controls';
import {ConfigurationView} from '../configuration/configuration-view/configuration-view';
import {MiniplayerControls} from '../miniplayer/miniplayer-controls';
import {ElectronService} from '../../services/electron.service';
import {MediaPlayerService} from '../../services/media-player.service';
import {SettingsService} from '../../services/settings.service';

/**
 * Root application component - the main shell of the media player.
 *
 * Responsibilities:
 * - Composes the main layout from header, outlet, and controls
 * - Manages fullscreen state and CSS class binding
 * - Handles control visibility in fullscreen (auto-hide with mouse reveal)
 * - Listens for Escape key to exit fullscreen
 *
 * The component uses Angular's signals for reactive state management.
 * CSS classes are applied via HostBinding based on fullscreen state.
 *
 * @example
 * // In index.html
 * <app-root></app-root>
 *
 * // The component renders:
 * <app-layout-header />
 * <app-layout-outlet />
 * <app-layout-controls *ngIf="showControls()" />
 */
@Component({
  selector: 'app-root',
  imports: [LayoutHeader, LayoutOutlet, LayoutControls, ConfigurationView, MiniplayerControls],
  templateUrl: './root.html',
  styleUrl: './root.scss',
})
export class Root implements OnDestroy {
  // ============================================================================
  // Dependencies
  // ============================================================================

  /** Service for Electron-specific operations (fullscreen control) */
  private readonly electron: ElectronService = inject(ElectronService);

  /** Service for media playback state */
  private readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);

  /** Service for settings (auto-hide delay) */
  private readonly settings: SettingsService = inject(SettingsService);

  // ============================================================================
  // Reactive State
  // ============================================================================

  /** Whether the application is in fullscreen mode */
  public readonly isFullscreen: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.isFullscreen());

  /** Current view mode (desktop, miniplayer, or fullscreen) */
  public readonly viewMode: ReturnType<typeof computed<'desktop' | 'miniplayer' | 'fullscreen'>> = computed((): 'desktop' | 'miniplayer' | 'fullscreen' => this.electron.viewMode());

  /** Whether the application is in miniplayer mode */
  public readonly isMiniplayer: ReturnType<typeof computed<boolean>> = computed((): boolean => this.viewMode() === 'miniplayer');

  /** Whether the current media is video (used for styling) */
  public readonly isVideo: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.currentMediaType() === 'video');

  /** Whether the configuration view is displayed (settings mode) */
  public readonly isConfigurationMode: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Internal signal tracking if controls should be visible in fullscreen */
  private readonly controlsVisible: ReturnType<typeof signal<boolean>> = signal<boolean>(true);

  /**
   * Whether to show the control bar.
   *
   * Logic:
   * - Not fullscreen: always show
   * - Fullscreen with auto-hide disabled (delay=0): always show
   * - Fullscreen with auto-hide enabled: show only if controlsVisible is true
   */
  public readonly showControls: ReturnType<typeof computed<boolean>> = computed((): boolean => {
    if (!this.isFullscreen()) return true;
    if (this.settings.controlsAutoHideDelay() === 0) return true;
    return this.controlsVisible();
  });

  // ============================================================================
  // Auto-hide Timer
  // ============================================================================

  /** Timer handle for auto-hiding controls in fullscreen */
  private mouseTimeout: ReturnType<typeof setTimeout> | null = null;

  // ============================================================================
  // Miniplayer Drag State
  // ============================================================================

  /** Whether the window is currently being dragged */
  private isDragging: boolean = false;

  /** Initial window position when drag started */
  private dragStartWindowPos: {x: number; y: number} = {x: 0, y: 0};

  /** Initial mouse position when drag started */
  private dragStartMousePos: {x: number; y: number} = {x: 0, y: 0};

  // ============================================================================
  // Constructor - Menu Event Handling
  // ============================================================================

  /**
   * Sets up reactive effects for menu events.
   *
   * Effects react to:
   * - menuShowConfig: Opens the configuration view
   * - menuOpenFile: Opens file dialog and adds files to playlist
   */
  public constructor() {
    // React to "Show Config" menu event
    effect((): void => {
      const trigger: number = this.electron.menuShowConfig();
      if (trigger > 0) {
        this.enterConfigurationMode();
      }
    });

    // React to "Open File" menu event
    effect((): void => {
      const trigger: number = this.electron.menuOpenFile();
      if (trigger > 0) {
        void this.openFilesFromMenu();
      }
    });
  }

  /**
   * Opens file dialog, adds selected files to playlist, and plays the first one.
   * Called when File > Open is selected from the menu.
   */
  private async openFilesFromMenu(): Promise<void> {
    const files: string[] = await this.electron.openFileDialog();
    if (files.length > 0) {
      const result: {added: import('../../types/electron').PlaylistItem[]} = await this.electron.addToPlaylist(files);
      // Select and play the first added track
      if (result.added.length > 0) {
        await this.electron.selectTrack(result.added[0].id);
      }
    }
  }

  // ============================================================================
  // Host Bindings
  // ============================================================================

  /**
   * Adds 'fullscreen' CSS class to the host element when in fullscreen mode.
   * This enables CSS rules that adjust layout for fullscreen display.
   */
  @HostBinding('class.fullscreen')
  public get fullscreenClass(): boolean {
    return this.isFullscreen();
  }

  /**
   * Adds 'miniplayer' CSS class to the host element when in miniplayer mode.
   * This enables CSS rules that adjust layout for compact miniplayer display.
   */
  @HostBinding('class.miniplayer')
  public get miniplayerClass(): boolean {
    return this.isMiniplayer();
  }

  // ============================================================================
  // Event Listeners
  // ============================================================================

  /**
   * Handles the Escape key press.
   *
   * Exits fullscreen mode when Escape is pressed. This is a standard
   * keyboard shortcut that users expect in media applications.
   */
  @HostListener('document:keydown.escape')
  public onEscapeKey(): void {
    if (this.isFullscreen()) {
      void this.electron.exitFullscreen();
    }
  }

  /**
   * Handles mouse down for window dragging in miniplayer mode.
   *
   * Starts drag tracking when clicking anywhere on the miniplayer window,
   * except on interactive elements like buttons.
   */
  @HostListener('mousedown', ['$event'])
  public onMouseDown(event: MouseEvent): void {
    if (!this.isMiniplayer()) return;

    // Don't start drag if clicking on a button or interactive element
    const target: HTMLElement = event.target as HTMLElement;
    if (target.closest('button')) return;

    this.isDragging = true;
    this.dragStartMousePos = {x: event.screenX, y: event.screenY};
    void this.electron.getWindowPosition().then((pos: {x: number; y: number}): void => {
      this.dragStartWindowPos = pos;
    });
  }

  /**
   * Handles mouse move for window dragging in miniplayer mode.
   *
   * Updates window position based on mouse delta from drag start.
   * The setWindowPosition API handles magnetic edge snapping.
   */
  @HostListener('document:mousemove', ['$event'])
  public onMouseMoveForDrag(event: MouseEvent): void {
    if (!this.isDragging) {
      // Existing fullscreen mouse move handling
      if (this.isFullscreen()) {
        this.showControlsTemporarily();
      }
      return;
    }

    const deltaX: number = event.screenX - this.dragStartMousePos.x;
    const deltaY: number = event.screenY - this.dragStartMousePos.y;
    const newX: number = this.dragStartWindowPos.x + deltaX;
    const newY: number = this.dragStartWindowPos.y + deltaY;

    void this.electron.setWindowPosition({x: newX, y: newY});
  }

  /**
   * Handles mouse up to end window dragging in miniplayer mode.
   */
  @HostListener('document:mouseup')
  public onMouseUp(): void {
    this.isDragging = false;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Cleanup when the component is destroyed.
   * Clears any pending timeout to prevent memory leaks.
   */
  public ngOnDestroy(): void {
    if (this.mouseTimeout) {
      clearTimeout(this.mouseTimeout);
    }
  }

  // ============================================================================
  // Public Methods - Configuration Mode
  // ============================================================================

  /**
   * Enters configuration mode, displaying the settings view.
   * Called when the settings button in the header is clicked.
   */
  public enterConfigurationMode(): void {
    this.isConfigurationMode.set(true);
  }

  /**
   * Exits configuration mode, returning to the media player view.
   * Called when the close button in the configuration view is clicked.
   */
  public exitConfigurationMode(): void {
    this.isConfigurationMode.set(false);
  }

  // ============================================================================
  // Public Methods - Miniplayer Controls Visibility
  // ============================================================================

  /**
   * Shows miniplayer controls when mouse enters the miniplayer container.
   * Uses the same temporary show logic as fullscreen mode.
   */
  public onMiniplayerMouseEnter(): void {
    this.showControlsTemporarily();
  }

  /**
   * Hides miniplayer controls immediately when mouse leaves the container.
   */
  public onMiniplayerMouseLeave(): void {
    if (this.mouseTimeout) {
      clearTimeout(this.mouseTimeout);
      this.mouseTimeout = null;
    }
    this.controlsVisible.set(false);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Shows controls and schedules them to hide after a delay.
   *
   * Called on mouse movement in fullscreen mode. Uses a debounce pattern -
   * each call resets the timer, so controls stay visible while the mouse
   * is actively moving. If auto-hide is disabled (delay=0), controls remain visible.
   */
  private showControlsTemporarily(): void {
    this.controlsVisible.set(true);

    if (this.mouseTimeout) {
      clearTimeout(this.mouseTimeout);
    }

    const delaySeconds: number = this.settings.controlsAutoHideDelay();
    if (delaySeconds > 0) {
      this.mouseTimeout = setTimeout((): void => {
        this.controlsVisible.set(false);
      }, delaySeconds * 1000);
    }
  }
}

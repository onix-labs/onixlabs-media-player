/**
 * @fileoverview Main content outlet that displays audio or video players.
 *
 * This component serves as the central content area of the media player,
 * dynamically switching between the audio outlet (with visualizations) and
 * the video outlet based on the current media type.
 *
 * Responsibilities:
 * - Conditionally renders AudioOutlet or VideoOutlet based on media type
 * - Hosts the Playlist overlay panel
 * - Handles drag-and-drop for adding media files
 * - Displays loading states and track information
 *
 * The component also manages fullscreen-related styling via HostBinding.
 *
 * @module app/components/layout/layout-outlet
 */

import {Component, computed, inject, signal, output, ViewChild, HostBinding, ChangeDetectionStrategy} from '@angular/core';
import type {OutputEmitterRef} from '@angular/core';
import {AudioOutlet} from '../../audio/audio-outlet/audio-outlet';
import {VideoOutlet} from '../../video/video-outlet/video-outlet';
import {Playlist} from '../../playlist/playlist';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import {FileDropService} from '../../../services/file-drop.service';
import {DependencyService} from '../../../services/dependency.service';
import {VIDEO_ASPECT_OPTIONS, type VideoAspectMode} from '../../../services/settings.service';
import type {DependencyStatus} from '../../../services/dependency.service';
import type {PlaylistItem, SubtitleTrack} from '../../../types/electron';

/** Special value for "Load External..." option in subtitle select */
const SUBTITLE_LOAD_EXTERNAL_VALUE: number = -3;

/**
 * Main content outlet component that displays the appropriate media player.
 *
 * This is the primary content area that shows either:
 * - AudioOutlet: For audio files, displays visualizations
 * - VideoOutlet: For video files, displays the video element
 * - Empty state: When no media is loaded
 *
 * The component also contains the Playlist panel which can be toggled
 * visible/hidden via the ViewChild reference.
 *
 * Drag-and-drop is supported: users can drop media files onto this
 * component to add them to the playlist and start playing immediately.
 *
 * @example
 * <!-- In root template -->
 * <app-layout-outlet />
 */
@Component({
  selector: 'app-layout-outlet',
  standalone: true,
  imports: [AudioOutlet, VideoOutlet, Playlist],
  templateUrl: './layout-outlet.html',
  styleUrl: './layout-outlet.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LayoutOutlet {
  /** Reference to the playlist panel for programmatic toggle */
  @ViewChild(Playlist) public playlistComponent?: Playlist;

  /** Reference to the audio outlet for visualization control */
  @ViewChild('audioOutlet') public audioOutlet?: AudioOutlet;

  /** Reference to the video outlet for aspect mode control */
  @ViewChild('videoOutlet') public videoOutlet?: VideoOutlet;

  /** Media player service for playback state */
  private readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);

  /** Electron service for file operations and fullscreen state */
  private readonly electron: ElectronService = inject(ElectronService);

  /** File drop service for drag-and-drop handling */
  private readonly fileDrop: FileDropService = inject(FileDropService);

  /** Dependency service for external binary status */
  private readonly deps: DependencyService = inject(DependencyService);

  /** Emitted when the user clicks to open dependency settings */
  public readonly openDependencySettings: OutputEmitterRef<void> = output<void>();

  /** Signal for visualization display name (updated reactively from audioOutlet) */
  public readonly visualizationDisplayName: ReturnType<typeof signal<string>> = signal<string>('');

  /** Signal for video aspect mode display name (updated reactively from videoOutlet) */
  public readonly aspectModeDisplayName: ReturnType<typeof signal<string>> = signal<string>('Default');

  /** Video aspect ratio options for the select dropdown */
  public readonly aspectOptions: typeof VIDEO_ASPECT_OPTIONS = VIDEO_ASPECT_OPTIONS;

  /** Current aspect mode value for the select dropdown */
  public readonly currentAspectMode: ReturnType<typeof computed<VideoAspectMode>> = computed(
    (): VideoAspectMode => this.videoOutlet?.aspectMode() ?? 'default'
  );

  // ============================================================================
  // Reactive State Signals
  // ============================================================================

  /** Current media type: 'audio', 'video', or null if nothing loaded */
  public readonly mediaType: ReturnType<typeof computed<'audio' | 'video' | null>> = computed((): 'audio' | 'video' | null => this.mediaPlayer.currentMediaType());

  /** Whether the playlist has any items */
  public readonly hasPlaylistItems: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.playlist().items.length > 0);

  /** Whether the current media is audio (and playlist is not empty) */
  public readonly isAudio: ReturnType<typeof computed<boolean>> = computed((): boolean => this.hasPlaylistItems() && this.mediaType() === 'audio');

  /** Whether the current media is video (and playlist is not empty) */
  public readonly isVideo: ReturnType<typeof computed<boolean>> = computed((): boolean => this.hasPlaylistItems() && this.mediaType() === 'video');

  /** Whether media is currently loading */
  public readonly isLoading: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.isLoading());

  /** Whether the application is in fullscreen mode */
  public readonly isFullscreen: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.isFullscreen());

  /** Whether the application is in miniplayer mode */
  public readonly isMiniplayer: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.viewMode() === 'miniplayer');

  /** Whether files are being dragged over this component */
  public readonly isDragOver: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Whether any required dependencies are missing */
  public readonly hasMissingDependencies: ReturnType<typeof computed<boolean>> = computed((): boolean => this.deps.hasMissingDependencies());

  /** List of missing dependencies */
  public readonly missingDependencies: ReturnType<typeof computed<DependencyStatus[]>> = computed((): DependencyStatus[] => this.deps.missingDependencies());

  // ============================================================================
  // Host Bindings
  // ============================================================================

  /**
   * Adds 'fullscreen' CSS class when in fullscreen mode.
   * Enables fullscreen-specific styling (e.g., hiding certain elements).
   */
  @HostBinding('class.fullscreen')
  public get fullscreenClass(): boolean {
    return this.isFullscreen();
  }

  /**
   * Adds 'miniplayer' CSS class when in miniplayer mode.
   * Removes padding and borders for compact display.
   */
  @HostBinding('class.miniplayer')
  public get miniplayerClass(): boolean {
    return this.isMiniplayer();
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  /**
   * Toggles the playlist panel visibility.
   * Called from external components (e.g., a playlist button).
   */
  public togglePlaylist(): void {
    this.playlistComponent?.toggle();
  }

  /**
   * Emits event to open dependency settings in configuration view.
   */
  public onOpenDependencySettings(): void {
    this.openDependencySettings.emit();
  }

  /**
   * Cycles to the next visualization.
   */
  public nextVisualization(): void {
    this.audioOutlet?.nextVisualization();
  }

  /**
   * Cycles to the previous visualization.
   */
  public previousVisualization(): void {
    this.audioOutlet?.previousVisualization();
  }

  /**
   * Handles aspect mode change from select element.
   *
   * @param event - The change event from the select
   */
  public onAspectModeChange(event: Event): void {
    const target: EventTarget | null = event.target;
    if (target instanceof HTMLSelectElement) {
      this.videoOutlet?.setAspectMode(target.value as VideoAspectMode);
    }
  }

  // ============================================================================
  // Subtitle Methods
  // ============================================================================

  /**
   * Gets the available subtitle tracks from the video outlet.
   */
  public getSubtitleTracks(): readonly SubtitleTrack[] {
    return this.videoOutlet?.subtitleTracks() ?? [];
  }

  /**
   * Gets the currently selected subtitle track index.
   * Returns -1 if subtitles are off.
   */
  public getSelectedSubtitleTrack(): number {
    return this.videoOutlet?.selectedSubtitleTrack() ?? -1;
  }

  /**
   * Gets whether an external subtitle is loaded.
   */
  public hasExternalSubtitle(): boolean {
    return this.videoOutlet?.hasExternalSubtitle() ?? false;
  }

  /**
   * Handles subtitle track change from select element.
   * Special values: -1 = Off, -2 = External, -3 = Load External...
   *
   * @param event - The change event from the select
   */
  public onSubtitleTrackChange(event: Event): void {
    const target: EventTarget | null = event.target;
    if (target instanceof HTMLSelectElement) {
      const value: number = parseInt(target.value, 10);
      if (value === SUBTITLE_LOAD_EXTERNAL_VALUE) {
        // Load External option selected
        this.videoOutlet?.loadExternalSubtitle();
        // Reset select to current track since "Load External..." is an action, not a selection
        target.value = String(this.getSelectedSubtitleTrack());
      } else {
        this.videoOutlet?.selectSubtitleTrack(value);
      }
    }
  }

  // ============================================================================
  // Drag and Drop Handlers
  // ============================================================================

  /**
   * Handles dragover event to enable drop.
   * Prevents default to indicate this is a valid drop target.
   *
   * @param event - The drag event
   */
  public onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(true);
  }

  /**
   * Handles dragleave event to reset visual feedback.
   *
   * @param event - The drag event
   */
  public onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
  }

  /**
   * Handles file drop event with smart auto-play.
   *
   * Uses unified auto-play behavior:
   * - Single file: plays immediately
   * - Multiple files + empty playlist: plays from beginning
   * - Multiple files + existing playlist: appends without interrupting
   *
   * @param event - The drop event containing transferred files
   */
  public async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);

    const filePaths: string[] = this.fileDrop.extractMediaFilePaths(event);
    if (filePaths.length === 0) return;

    await this.electron.addFilesWithAutoPlay(filePaths);
  }
}

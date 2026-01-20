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

import {Component, computed, inject, signal, ViewChild, HostBinding, ChangeDetectionStrategy} from '@angular/core';
import {AudioOutlet} from '../../audio/audio-outlet/audio-outlet';
import {VideoOutlet} from '../../video/video-outlet/video-outlet';
import {Playlist} from '../../playlist/playlist';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import {FileDropService} from '../../../services/file-drop.service';
import type {PlaylistItem} from '../../../types/electron';

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

  /** Signal for visualization display name (updated reactively from audioOutlet) */
  public readonly visualizationDisplayName: ReturnType<typeof signal<string>> = signal<string>('');

  /** Signal for video aspect mode display name (updated reactively from videoOutlet) */
  public readonly aspectModeDisplayName: ReturnType<typeof signal<string>> = signal<string>('Default');

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
   * Cycles to the next video aspect mode.
   */
  public nextAspectMode(): void {
    this.videoOutlet?.nextAspectMode();
  }

  /**
   * Cycles to the previous video aspect mode.
   */
  public previousAspectMode(): void {
    this.videoOutlet?.previousAspectMode();
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
   * Handles file drop event.
   *
   * Filters dropped files to supported media types, adds them to the
   * playlist, and immediately starts playing the first added file.
   *
   * @param event - The drop event containing transferred files
   */
  public async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);

    const filePaths: string[] = this.fileDrop.extractMediaFilePaths(event);
    if (filePaths.length === 0) return;

    // Add files to playlist and select the first one to play immediately
    const result: {added: PlaylistItem[]} = await this.electron.addToPlaylist(filePaths);
    if (result.added.length > 0) {
      await this.electron.selectTrack(result.added[0].id);
    }
  }
}

/**
 * @fileoverview Playlist panel component for managing media tracks.
 *
 * This component displays the playlist as a slide-out panel, showing all
 * tracks with their metadata (title, artist, duration). Users can:
 * - Click tracks to play them
 * - Remove tracks from the playlist
 * - Drag and drop files to add them
 *
 * The panel visibility is controlled externally (typically via a toggle
 * button in the controls bar) using the public show/hide/toggle methods.
 *
 * @module app/components/playlist
 */

import {Component, inject, signal, computed, ChangeDetectionStrategy} from '@angular/core';
import {MediaPlayerService} from '../../services/media-player.service';
import {ElectronService, PlaylistItem} from '../../services/electron.service';
import {MEDIA_EXTENSIONS} from '../../constants/media.constants';

/**
 * Playlist panel component displaying the track list.
 *
 * This is a toggleable panel that shows all tracks in the playlist.
 * Each track displays:
 * - Title
 * - Artist (if available)
 * - Duration (formatted as M:SS)
 * - Remove button
 *
 * The currently playing track is highlighted. Clicking a track
 * selects and plays it.
 *
 * Visibility is controlled via:
 * - toggle(): Toggles visibility
 * - show(): Forces panel visible
 * - hide(): Forces panel hidden
 *
 * @example
 * // In layout-outlet template
 * <app-playlist />
 *
 * // In layout-outlet component
 * @ViewChild(Playlist) playlist?: Playlist;
 *
 * togglePlaylist() {
 *   this.playlist?.toggle();
 * }
 */
@Component({
  selector: 'app-playlist',
  standalone: true,
  imports: [],
  templateUrl: './playlist.html',
  styleUrl: './playlist.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Playlist {
  // ============================================================================
  // Services
  // ============================================================================

  /** Media player service for playlist operations */
  private readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);

  /** Electron service for file path resolution */
  private readonly electron: ElectronService = inject(ElectronService);

  // ============================================================================
  // Reactive State
  // ============================================================================

  /** Whether the playlist panel is visible */
  public readonly isVisible: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Whether files are being dragged over the playlist */
  public readonly isDragOver: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** All items in the playlist */
  public readonly items: ReturnType<typeof computed<PlaylistItem[]>> = computed((): PlaylistItem[] => this.mediaPlayer.playlistItems());

  /** Currently playing track (or null if none) */
  public readonly currentTrack: ReturnType<typeof computed<PlaylistItem | null>> = computed((): PlaylistItem | null => this.mediaPlayer.currentTrack());

  /** Number of items in the playlist */
  public readonly count: ReturnType<typeof computed<number>> = computed((): number => this.mediaPlayer.playlistCount());

  /** Whether playback is active */
  public readonly isPlaying: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.isPlaying());

  // ============================================================================
  // Visibility Control
  // ============================================================================

  /**
   * Toggles the playlist panel visibility.
   */
  public toggle(): void {
    this.isVisible.update((v: boolean): boolean => !v);
  }

  /**
   * Shows the playlist panel.
   */
  public show(): void {
    this.isVisible.set(true);
  }

  /**
   * Hides the playlist panel.
   */
  public hide(): void {
    this.isVisible.set(false);
  }

  // ============================================================================
  // Track Actions
  // ============================================================================

  /**
   * Selects and plays a track from the playlist.
   *
   * @param item - The playlist item to select
   */
  public async selectItem(item: PlaylistItem): Promise<void> {
    await this.mediaPlayer.selectTrack(item.id);
  }

  /**
   * Removes a track from the playlist.
   *
   * Stops event propagation to prevent the click from also triggering
   * track selection.
   *
   * @param event - The click event (to stop propagation)
   * @param item - The playlist item to remove
   */
  public removeItem(event: Event, item: PlaylistItem): void {
    event.stopPropagation();
    void this.mediaPlayer.removeTrack(item.id);
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Formats a duration in seconds to a display string.
   *
   * @param seconds - Duration in seconds
   * @returns Formatted string as "M:SS"
   */
  public formatDuration(seconds: number): string {
    return this.mediaPlayer.formatTime(seconds);
  }

  /**
   * Checks if a track is the currently playing track.
   *
   * @param item - The playlist item to check
   * @returns true if this is the current track
   */
  public isCurrentItem(item: PlaylistItem): boolean {
    return this.currentTrack()?.id === item.id;
  }

  /**
   * Track-by function for ngFor optimization.
   *
   * Tells Angular to track items by their ID to minimize DOM updates.
   *
   * @param index - Item index (unused but required by signature)
   * @param item - The playlist item
   * @returns The unique item ID
   */
  public trackByFn(index: number, item: PlaylistItem): string {
    return item.id;
  }

  // ============================================================================
  // Drag and Drop
  // ============================================================================

  /**
   * Handles dragover to enable drop target.
   */
  public onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(true);
  }

  /**
   * Handles dragleave to reset visual feedback.
   */
  public onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
  }

  /**
   * Handles file drop to add media to playlist.
   *
   * Filters for supported media types and adds them to the playlist.
   * If the playlist was empty, automatically starts playing the first track.
   */
  public async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);

    const files: FileList | undefined = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    // Filter for supported media files and get their paths
    const filePaths: string[] = [];
    for (let i: number = 0; i < files.length; i++) {
      const file: File = files[i];
      const ext: string = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

      if (MEDIA_EXTENSIONS.has(ext)) {
        try {
          const filePath: string = this.electron.getPathForFile(file);
          if (filePath) {
            filePaths.push(filePath);
          }
        } catch (e) {
          console.error('Failed to get path for file:', file.name, e);
        }
      }
    }

    if (filePaths.length === 0) return;

    // Add files to playlist
    await this.addFilesToPlaylist(filePaths);
  }

  /**
   * Adds files to the playlist and optionally auto-plays.
   *
   * If the playlist was empty before adding, starts playing the first file.
   *
   * @param filePaths - Array of absolute file paths to add
   */
  private async addFilesToPlaylist(filePaths: string[]): Promise<void> {
    const wasEmpty: boolean = this.count() === 0;

    // Server will probe each file for metadata
    await this.mediaPlayer.addFiles(filePaths);

    // Auto-play first item if playlist was empty
    if (wasEmpty && filePaths.length > 0) {
      await this.mediaPlayer.play();
    }
  }
}

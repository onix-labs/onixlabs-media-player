import {Component, inject, signal, computed} from '@angular/core';
import {MediaPlayerService} from '../../services/media-player.service';
import {PlaylistItem} from '../../services/playlist.service';
import {ElectronService} from '../../services/electron.service';

// Supported media extensions
const MEDIA_EXTENSIONS = new Set([
  '.mp3', '.mp4', '.flac', '.mkv', '.avi', '.wav',
  '.ogg', '.webm', '.m4a', '.aac', '.wma', '.mov'
]);

@Component({
  selector: 'app-playlist',
  standalone: true,
  imports: [],
  templateUrl: './playlist.html',
  styleUrl: './playlist.scss'
})
export class Playlist {
  private readonly mediaPlayer = inject(MediaPlayerService);
  private readonly electron = inject(ElectronService);

  readonly isVisible = signal<boolean>(false);
  readonly isDragOver = signal<boolean>(false);
  readonly items = computed(() => this.mediaPlayer.playlistItems());
  readonly currentTrack = computed(() => this.mediaPlayer.currentTrack());
  readonly count = computed(() => this.mediaPlayer.playlistCount());
  readonly isPlaying = computed(() => this.mediaPlayer.isPlaying());

  toggle(): void {
    this.isVisible.update(v => !v);
  }

  show(): void {
    this.isVisible.set(true);
  }

  hide(): void {
    this.isVisible.set(false);
  }

  async selectItem(item: PlaylistItem): Promise<void> {
    await this.mediaPlayer.selectTrack(item.id);
  }

  removeItem(event: Event, item: PlaylistItem): void {
    event.stopPropagation();
    this.mediaPlayer.removeTrack(item.id);
  }

  formatDuration(seconds: number): string {
    return this.mediaPlayer.formatTime(seconds);
  }

  isCurrentItem(item: PlaylistItem): boolean {
    return this.currentTrack()?.id === item.id;
  }

  trackByFn(index: number, item: PlaylistItem): string {
    return item.id;
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
  }

  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    // Filter for supported media files and get their paths
    const filePaths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

      if (MEDIA_EXTENSIONS.has(ext)) {
        try {
          const filePath = this.electron.getPathForFile(file);
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

  private async addFilesToPlaylist(filePaths: string[]): Promise<void> {
    const items: Omit<PlaylistItem, 'id'>[] = [];

    for (const filePath of filePaths) {
      try {
        const info = await this.electron.loadMedia(filePath);
        items.push({
          filePath,
          title: info.title,
          artist: info.artist,
          album: info.album,
          duration: info.duration,
          type: info.type
        });
      } catch (e) {
        console.error(`Failed to load ${filePath}:`, e);
      }
    }

    if (items.length > 0) {
      const wasEmpty = this.count() === 0;
      this.mediaPlayer.addItems(items);

      // Auto-play first item if playlist was empty
      if (wasEmpty) {
        await this.mediaPlayer.play();
      }
    }
  }
}

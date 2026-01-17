import {Component, inject, signal, computed} from '@angular/core';
import {MediaPlayerService} from '../../services/media-player.service';
import {ElectronService, PlaylistItem} from '../../services/electron.service';

// Supported media extensions
const MEDIA_EXTENSIONS: Set<string> = new Set([
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
  private readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);
  private readonly electron: ElectronService = inject(ElectronService);

  readonly isVisible: ReturnType<typeof signal<boolean>> = signal<boolean>(false);
  readonly isDragOver: ReturnType<typeof signal<boolean>> = signal<boolean>(false);
  readonly items: ReturnType<typeof computed<PlaylistItem[]>> = computed(() => this.mediaPlayer.playlistItems());
  readonly currentTrack: ReturnType<typeof computed<PlaylistItem | null>> = computed(() => this.mediaPlayer.currentTrack());
  readonly count: ReturnType<typeof computed<number>> = computed(() => this.mediaPlayer.playlistCount());
  readonly isPlaying: ReturnType<typeof computed<boolean>> = computed(() => this.mediaPlayer.isPlaying());

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

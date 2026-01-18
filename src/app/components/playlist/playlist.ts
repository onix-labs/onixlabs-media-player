import {Component, inject, signal, computed} from '@angular/core';
import {MediaPlayerService} from '../../services/media-player.service';
import {ElectronService, PlaylistItem} from '../../services/electron.service';

// Supported media extensions
const MEDIA_EXTENSIONS: Set<string> = new Set([
  '.mp3', '.mp4', '.flac', '.mkv', '.avi', '.wav',
  '.ogg', '.webm', '.m4a', '.aac', '.wma', '.mov',
  '.mid', '.midi'
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

  public readonly isVisible: ReturnType<typeof signal<boolean>> = signal<boolean>(false);
  public readonly isDragOver: ReturnType<typeof signal<boolean>> = signal<boolean>(false);
  public readonly items: ReturnType<typeof computed<PlaylistItem[]>> = computed((): PlaylistItem[] => this.mediaPlayer.playlistItems());
  public readonly currentTrack: ReturnType<typeof computed<PlaylistItem | null>> = computed((): PlaylistItem | null => this.mediaPlayer.currentTrack());
  public readonly count: ReturnType<typeof computed<number>> = computed((): number => this.mediaPlayer.playlistCount());
  public readonly isPlaying: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.isPlaying());

  public toggle(): void {
    this.isVisible.update((v: boolean): boolean => !v);
  }

  public show(): void {
    this.isVisible.set(true);
  }

  public hide(): void {
    this.isVisible.set(false);
  }

  public async selectItem(item: PlaylistItem): Promise<void> {
    await this.mediaPlayer.selectTrack(item.id);
  }

  public removeItem(event: Event, item: PlaylistItem): void {
    event.stopPropagation();
    void this.mediaPlayer.removeTrack(item.id);
  }

  public formatDuration(seconds: number): string {
    return this.mediaPlayer.formatTime(seconds);
  }

  public isCurrentItem(item: PlaylistItem): boolean {
    return this.currentTrack()?.id === item.id;
  }

  public trackByFn(index: number, item: PlaylistItem): string {
    return item.id;
  }

  public onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(true);
  }

  public onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
  }

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

import {Component, computed, inject, signal, ViewChild, HostBinding} from '@angular/core';
import {AudioOutlet} from '../../audio/audio-outlet/audio-outlet';
import {VideoOutlet} from '../../video/video-outlet/video-outlet';
import {Playlist} from '../../playlist/playlist';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import type {PlaylistItem} from '../../../types/electron';

// Supported media extensions for drag and drop
const MEDIA_EXTENSIONS: Set<string> = new Set([
  '.mp3', '.mp4', '.flac', '.mkv', '.avi', '.wav',
  '.ogg', '.webm', '.m4a', '.aac', '.wma', '.mov',
  '.mid', '.midi'
]);

@Component({
  selector: 'app-layout-outlet',
  standalone: true,
  imports: [AudioOutlet, VideoOutlet, Playlist],
  templateUrl: './layout-outlet.html',
  styleUrl: './layout-outlet.scss',
})
export class LayoutOutlet {
  @ViewChild(Playlist) public playlistComponent?: Playlist;

  private readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);
  private readonly electron: ElectronService = inject(ElectronService);

  public readonly mediaType: ReturnType<typeof computed<'audio' | 'video' | null>> = computed((): 'audio' | 'video' | null => this.mediaPlayer.currentMediaType());
  public readonly currentTrack: ReturnType<typeof computed<PlaylistItem | null>> = computed((): PlaylistItem | null => this.mediaPlayer.currentTrack());
  public readonly isAudio: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaType() === 'audio');
  public readonly isVideo: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaType() === 'video');
  public readonly isLoading: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.isLoading());
  public readonly isFullscreen: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.isFullscreen());
  public readonly trackTitle: ReturnType<typeof computed<string>> = computed((): string => {
    const track: PlaylistItem | null = this.currentTrack();
    if (!track) return '';
    return track.artist ? `${track.artist} - ${track.title}` : track.title;
  });
  public readonly isDragOver: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  @HostBinding('class.fullscreen')
  public get fullscreenClass(): boolean {
    return this.isFullscreen();
  }

  public togglePlaylist(): void {
    this.playlistComponent?.toggle();
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

    // Add files to playlist and select the first one to play immediately
    const result: {added: PlaylistItem[]} = await this.electron.addToPlaylist(filePaths);
    if (result.added.length > 0) {
      await this.electron.selectTrack(result.added[0].id);
    }
  }
}

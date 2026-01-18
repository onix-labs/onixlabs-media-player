import {Component, ElementRef, ViewChild, OnInit, OnDestroy, inject, computed, signal, effect} from '@angular/core';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import type {PlaylistItem} from '../../../services/electron.service';

// Formats that Chromium can play natively (support HTTP range seeking)
const NATIVE_VIDEO_FORMATS: Set<string> = new Set(['.mp4', '.webm', '.ogg']);

// Supported media extensions for drag and drop
const MEDIA_EXTENSIONS: Set<string> = new Set([
  '.mp3', '.mp4', '.flac', '.mkv', '.avi', '.wav',
  '.ogg', '.webm', '.m4a', '.aac', '.wma', '.mov'
]);

@Component({
  selector: 'app-video-outlet',
  standalone: true,
  imports: [],
  templateUrl: './video-outlet.html',
  styleUrl: './video-outlet.scss'
})
export class VideoOutlet implements OnInit, OnDestroy {
  @ViewChild('videoElement', {static: true}) public videoRef!: ElementRef<HTMLVideoElement>;

  public readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);
  private readonly electron: ElectronService = inject(ElectronService);

  public readonly currentTrack: ReturnType<typeof computed<PlaylistItem | null>> = computed((): PlaylistItem | null => this.mediaPlayer.currentTrack());
  public readonly isDragOver: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  public onDoubleClick(): void {
    void this.electron.toggleFullscreen();
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

  private currentFilePath: string | null = null;
  private isTranscoded: boolean = false;
  private seekPending: boolean = false;
  private transcodeSeekOffset: number = 0;
  private lastSeekTime: number = 0;

  constructor() {
    // React to track changes - load new video source
    effect((): void => {
      const track: PlaylistItem | null = this.mediaPlayer.currentTrack();
      if (track?.type === 'video' && track.filePath !== this.currentFilePath) {
        void this.loadVideo(track.filePath);
      }
    });

    // React to playback state changes
    effect((): void => {
      const state: string = this.mediaPlayer.playbackState();
      const video: HTMLVideoElement | undefined = this.videoRef?.nativeElement;
      if (!video) return;

      if (state === 'playing') {
        if (video.src && video.readyState >= 2) {
          video.play().catch(console.error);
        }
      } else if (state === 'paused') {
        video.pause();
      } else if (state === 'stopped') {
        video.pause();
        video.currentTime = 0;
      }
    });

    // React to seek events (time updates from server)
    effect((): void => {
      const time: number = this.mediaPlayer.currentTime();
      const video: HTMLVideoElement | undefined = this.videoRef?.nativeElement;
      if (!video || !video.src) return;

      if (this.isTranscoded) {
        // For transcoded files, account for seek offset
        const expectedVideoTime: number = time - this.transcodeSeekOffset;
        const timeDiff: number = Math.abs(video.currentTime - expectedVideoTime);

        const now: number = Date.now();
        const timeSinceLastSeek: number = now - this.lastSeekTime;

        if (timeDiff > 2 && timeSinceLastSeek > 1000 && !this.seekPending && this.currentFilePath) {
          this.seekPending = true;
          this.lastSeekTime = now;
          console.log(`Seeking transcoded video to ${time}s (diff: ${timeDiff}s)`);
          void this.loadVideo(this.currentFilePath, time).then((): void => {
            this.seekPending = false;
            if (this.mediaPlayer.isPlaying()) {
              video.play().catch(console.error);
            }
          });
        }
      } else {
        // For native formats, just set the currentTime
        if (Math.abs(video.currentTime - time) > 1) {
          video.currentTime = time;
        }
      }
    });

    // React to volume changes
    effect((): void => {
      const volume: number = this.mediaPlayer.volume();
      const video: HTMLVideoElement | undefined = this.videoRef?.nativeElement;
      if (video) {
        video.volume = volume;
      }
    });

    // React to mute changes
    effect((): void => {
      const muted: boolean = this.mediaPlayer.muted();
      const video: HTMLVideoElement | undefined = this.videoRef?.nativeElement;
      if (video) {
        video.muted = muted;
      }
    });
  }

  public ngOnInit(): void {
    this.setupVideoEvents();
  }

  private async loadVideo(filePath: string, seekTime: number = 0): Promise<void> {
    const video: HTMLVideoElement = this.videoRef.nativeElement;
    const serverUrl: string = this.mediaPlayer.serverUrl();

    if (!serverUrl) return;

    this.currentFilePath = filePath;

    // Determine if this format needs transcoding
    const ext: string = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    this.isTranscoded = !NATIVE_VIDEO_FORMATS.has(ext);

    // Build the stream URL
    let url: string = `${serverUrl}/media/stream?path=${encodeURIComponent(filePath)}`;

    // For transcoded files, track the offset
    if (this.isTranscoded) {
      this.transcodeSeekOffset = seekTime;
      if (seekTime > 0) {
        url += `&t=${seekTime}`;
      }
    } else {
      this.transcodeSeekOffset = 0;
    }

    video.src = url;
    video.load();

    console.log(`Loading video: ${filePath}, transcoded: ${this.isTranscoded}, seekTime: ${seekTime}`);
  }

  private setupVideoEvents(): void {
    const video: HTMLVideoElement = this.videoRef.nativeElement;

    video.addEventListener('error', (): void => {
      const error: MediaError | null = video.error;
      console.error('Video error:', error?.code, error?.message);
    });

    video.addEventListener('canplay', (): void => {
      console.log('Video can play');
      if (this.mediaPlayer.isPlaying()) {
        video.play().catch(console.error);
      }
    });

    video.addEventListener('loadedmetadata', (): void => {
      console.log('Video metadata loaded, duration:', video.duration);
    });
  }

  public ngOnDestroy(): void {
    const video: HTMLVideoElement = this.videoRef.nativeElement;
    video.pause();
    video.src = '';
    this.currentFilePath = null;
  }
}

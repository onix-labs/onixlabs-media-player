import {Component, ElementRef, ViewChild, OnInit, OnDestroy, inject, computed, effect} from '@angular/core';
import {MediaPlayerService} from '../../../services/media-player.service';

// Formats that Chromium can play natively (support HTTP range seeking)
const NATIVE_VIDEO_FORMATS = new Set(['.mp4', '.webm', '.ogg']);

@Component({
  selector: 'app-video-outlet',
  standalone: true,
  imports: [],
  templateUrl: './video-outlet.html',
  styleUrl: './video-outlet.scss'
})
export class VideoOutlet implements OnInit, OnDestroy {
  @ViewChild('videoElement', {static: true}) videoRef!: ElementRef<HTMLVideoElement>;

  readonly mediaPlayer = inject(MediaPlayerService);

  readonly currentTrack = computed(() => this.mediaPlayer.currentTrack());

  private currentFilePath: string | null = null;
  private isTranscoded = false;
  private seekPending = false;
  private transcodeSeekOffset = 0;
  private lastSeekTime = 0;

  constructor() {
    // React to track changes - load new video source
    effect(() => {
      const track = this.mediaPlayer.currentTrack();
      if (track?.type === 'video' && track.filePath !== this.currentFilePath) {
        this.loadVideo(track.filePath);
      }
    });

    // React to playback state changes
    effect(() => {
      const state = this.mediaPlayer.playbackState();
      const video = this.videoRef?.nativeElement;
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
    effect(() => {
      const time = this.mediaPlayer.currentTime();
      const video = this.videoRef?.nativeElement;
      if (!video || !video.src) return;

      if (this.isTranscoded) {
        // For transcoded files, account for seek offset
        const expectedVideoTime = time - this.transcodeSeekOffset;
        const timeDiff = Math.abs(video.currentTime - expectedVideoTime);

        const now = Date.now();
        const timeSinceLastSeek = now - this.lastSeekTime;

        if (timeDiff > 2 && timeSinceLastSeek > 1000 && !this.seekPending && this.currentFilePath) {
          this.seekPending = true;
          this.lastSeekTime = now;
          console.log(`Seeking transcoded video to ${time}s (diff: ${timeDiff}s)`);
          this.loadVideo(this.currentFilePath, time).then(() => {
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
    effect(() => {
      const volume = this.mediaPlayer.volume();
      const video = this.videoRef?.nativeElement;
      if (video) {
        video.volume = volume;
      }
    });

    // React to mute changes
    effect(() => {
      const muted = this.mediaPlayer.muted();
      const video = this.videoRef?.nativeElement;
      if (video) {
        video.muted = muted;
      }
    });
  }

  ngOnInit(): void {
    this.setupVideoEvents();
  }

  private async loadVideo(filePath: string, seekTime: number = 0): Promise<void> {
    const video = this.videoRef.nativeElement;
    const serverUrl = this.mediaPlayer.serverUrl();

    if (!serverUrl) return;

    this.currentFilePath = filePath;

    // Determine if this format needs transcoding
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    this.isTranscoded = !NATIVE_VIDEO_FORMATS.has(ext);

    // Build the stream URL
    let url = `${serverUrl}/media/stream?path=${encodeURIComponent(filePath)}`;

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
    const video = this.videoRef.nativeElement;

    video.addEventListener('error', () => {
      const error = video.error;
      console.error('Video error:', error?.code, error?.message);
    });

    video.addEventListener('canplay', () => {
      console.log('Video can play');
      if (this.mediaPlayer.isPlaying()) {
        video.play().catch(console.error);
      }
    });

    video.addEventListener('loadedmetadata', () => {
      console.log('Video metadata loaded, duration:', video.duration);
    });
  }

  ngOnDestroy(): void {
    const video = this.videoRef.nativeElement;
    video.pause();
    video.src = '';
    this.currentFilePath = null;
  }
}

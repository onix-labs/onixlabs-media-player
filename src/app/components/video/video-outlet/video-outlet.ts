import {Component, ElementRef, ViewChild, OnInit, OnDestroy, inject, computed, DestroyRef} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {ElectronService} from '../../../services/electron.service';
import {MediaPlayerService} from '../../../services/media-player.service';
import {distinctUntilChanged} from 'rxjs';

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

  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);
  readonly mediaPlayer = inject(MediaPlayerService);

  readonly currentTrack = computed(() => this.mediaPlayer.currentTrack());

  private currentVideoUrl: string | null = null;
  private currentFilePath: string | null = null;
  private isTranscoded = false;
  private seekPending = false;
  private transcodeSeekOffset = 0;  // Offset between backend time and video element time for transcoded files
  private lastSeekTime = 0;         // Track last seek to prevent rapid re-seeks

  ngOnInit(): void {
    this.setupVideoEvents();
    this.subscribeToTrackChanges();
    this.subscribeToStateChanges();
  }

  private subscribeToTrackChanges(): void {
    // Watch for track changes via durationChange (fires when new media loads)
    this.electron.durationChange
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        const track = this.mediaPlayer.currentTrack();
        if (track?.type === 'video' && track.filePath !== this.currentFilePath) {
          this.loadVideo(track.filePath);
        }
      });
  }

  private async loadVideo(filePath: string, seekTime: number = 0): Promise<void> {
    const video = this.videoRef.nativeElement;
    this.currentFilePath = filePath;

    // Determine if this format needs transcoding
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    this.isTranscoded = !NATIVE_VIDEO_FORMATS.has(ext);

    // Get the HTTP URL from the media server
    let url = await this.electron.getVideoUrl(filePath);
    this.currentVideoUrl = url;

    // For transcoded files, track the offset between backend time and video element time
    if (this.isTranscoded) {
      this.transcodeSeekOffset = seekTime;
      if (seekTime > 0) {
        url += `&t=${seekTime}`;
      }
    } else {
      this.transcodeSeekOffset = 0;
    }

    // Set the video source directly - browser handles buffering/seeking via HTTP range requests
    video.src = url;
    video.load();

    console.log(`Loading video: ${filePath}, transcoded: ${this.isTranscoded}, seekTime: ${seekTime}, offset: ${this.transcodeSeekOffset}`);
  }

  private setupVideoEvents(): void {
    const video = this.videoRef.nativeElement;

    // Handle video errors
    video.addEventListener('error', () => {
      const error = video.error;
      console.error('Video error:', error?.code, error?.message);
    });

    // Auto-play when video is ready and we're in playing state
    video.addEventListener('canplay', () => {
      console.log('Video can play');
      if (this.mediaPlayer.isPlaying()) {
        video.play().catch(console.error);
      }
    });

    // Log loading progress
    video.addEventListener('loadedmetadata', () => {
      console.log('Video metadata loaded, duration:', video.duration);
    });
  }

  private subscribeToStateChanges(): void {
    this.electron.stateChange
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        distinctUntilChanged()
      )
      .subscribe(state => {
        const video = this.videoRef.nativeElement;
        if (state === 'playing') {
          // Only play if we have a valid source
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

    // Sync video position with seek commands
    this.electron.timeUpdate
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(time => {
        const video = this.videoRef.nativeElement;

        if (this.isTranscoded) {
          // For transcoded files, account for the seek offset
          // The video element time = backend time - offset
          const expectedVideoTime = time - this.transcodeSeekOffset;
          const timeDiff = Math.abs(video.currentTime - expectedVideoTime);

          // Detect user-initiated seek: significant time difference that isn't just playback drift
          // Also check that enough time has passed since last seek to prevent rapid re-seeks
          const now = Date.now();
          const timeSinceLastSeek = now - this.lastSeekTime;

          if (timeDiff > 2 && timeSinceLastSeek > 1000 && !this.seekPending && this.currentFilePath) {
            this.seekPending = true;
            this.lastSeekTime = now;
            console.log(`Seeking transcoded video to ${time}s (diff: ${timeDiff}s)`);
            this.loadVideo(this.currentFilePath, time).then(() => {
              this.seekPending = false;
              // Auto-play after seek if we were playing
              if (this.mediaPlayer.isPlaying()) {
                video.play().catch(console.error);
              }
            });
          }
        } else {
          // For native formats, just set the currentTime (range requests work)
          if (Math.abs(video.currentTime - time) > 1) {
            video.currentTime = time;
          }
        }
      });
  }

  ngOnDestroy(): void {
    const video = this.videoRef.nativeElement;
    video.pause();
    video.src = '';
    this.currentVideoUrl = null;
    this.currentFilePath = null;
  }
}

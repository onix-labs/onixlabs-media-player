import {Component, ElementRef, ViewChild, OnInit, OnDestroy, inject, computed, DestroyRef} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {ElectronService} from '../../../services/electron.service';
import {MediaPlayerService} from '../../../services/media-player.service';
import {distinctUntilChanged, filter} from 'rxjs';

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

  private async loadVideo(filePath: string): Promise<void> {
    const video = this.videoRef.nativeElement;
    this.currentFilePath = filePath;

    // Get the HTTP URL from the media server
    const url = await this.electron.getVideoUrl(filePath);
    this.currentVideoUrl = url;

    // Set the video source directly - browser handles buffering/seeking via HTTP range requests
    video.src = url;
    video.load();
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
        // Only sync if there's a significant difference (user seeked)
        if (Math.abs(video.currentTime - time) > 1) {
          video.currentTime = time;
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

import {Component, ElementRef, ViewChild, OnInit, OnDestroy, inject, computed, DestroyRef} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {ElectronService} from '../../../services/electron.service';
import {MediaPlayerService} from '../../../services/media-player.service';

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

  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private pendingChunks: Uint8Array[] = [];
  private isSourceOpen = false;

  ngOnInit(): void {
    this.subscribeToVideoChunks();
    this.subscribeToStateChanges();
  }

  private subscribeToVideoChunks(): void {
    this.electron.videoChunk
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(chunk => {
        this.appendChunk(new Uint8Array(chunk));
      });

    // Reset MediaSource when new media loads
    this.electron.durationChange
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        const track = this.mediaPlayer.currentTrack();
        if (track?.type === 'video') {
          this.initMediaSource();
        }
      });
  }

  private initMediaSource(): void {
    // Clean up existing
    if (this.mediaSource) {
      if (this.sourceBuffer) {
        try {
          this.mediaSource.removeSourceBuffer(this.sourceBuffer);
        } catch {}
      }
    }

    this.mediaSource = new MediaSource();
    this.sourceBuffer = null;
    this.pendingChunks = [];
    this.isSourceOpen = false;

    const video = this.videoRef.nativeElement;
    video.src = URL.createObjectURL(this.mediaSource);

    this.mediaSource.addEventListener('sourceopen', () => {
      this.isSourceOpen = true;
      try {
        // WebM with VP9 and Opus
        this.sourceBuffer = this.mediaSource!.addSourceBuffer('video/webm; codecs="vp9, opus"');
        this.sourceBuffer.mode = 'sequence';

        this.sourceBuffer.addEventListener('updateend', () => {
          this.flushPendingChunks();
        });

        // Flush any chunks that arrived before source was ready
        this.flushPendingChunks();
      } catch (e) {
        console.error('Failed to create source buffer:', e);
      }
    });
  }

  private appendChunk(chunk: Uint8Array): void {
    if (!this.sourceBuffer || !this.isSourceOpen) {
      this.pendingChunks.push(chunk);
      return;
    }

    if (this.sourceBuffer.updating) {
      this.pendingChunks.push(chunk);
      return;
    }

    try {
      this.sourceBuffer.appendBuffer(chunk.buffer as ArrayBuffer);
    } catch (e) {
      console.error('Failed to append buffer:', e);
    }
  }

  private flushPendingChunks(): void {
    if (!this.sourceBuffer || this.sourceBuffer.updating || this.pendingChunks.length === 0) {
      return;
    }

    const chunk = this.pendingChunks.shift();
    if (chunk) {
      try {
        this.sourceBuffer.appendBuffer(chunk.buffer as ArrayBuffer);
      } catch (e) {
        console.error('Failed to append pending buffer:', e);
      }
    }
  }

  private subscribeToStateChanges(): void {
    this.electron.stateChange
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(state => {
        const video = this.videoRef.nativeElement;
        if (state === 'playing') {
          video.play().catch(console.error);
        } else if (state === 'paused') {
          video.pause();
        } else if (state === 'stopped') {
          video.pause();
          video.currentTime = 0;
        }
      });
  }

  ngOnDestroy(): void {
    const video = this.videoRef.nativeElement;
    video.pause();
    if (video.src) {
      URL.revokeObjectURL(video.src);
    }
    video.src = '';
  }
}

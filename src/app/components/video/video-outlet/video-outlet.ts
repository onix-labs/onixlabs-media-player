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
  @ViewChild('videoCanvas', {static: true}) canvasRef!: ElementRef<HTMLCanvasElement>;

  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);
  readonly mediaPlayer = inject(MediaPlayerService);

  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private scheduledTime = 0;
  private scheduledSources: AudioBufferSourceNode[] = [];
  private readonly MAX_BUFFER_AHEAD = 0.15;

  readonly currentTrack = computed(() => this.mediaPlayer.currentTrack());

  ngOnInit(): void {
    this.initAudioContext();
    this.subscribeToVideoFrames();
    this.subscribeToAudioData();
    this.subscribeToStateChanges();
    this.setupUserGestureHandler();
  }

  private subscribeToStateChanges(): void {
    this.electron.stateChange
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(state => {
        if (state === 'paused' || state === 'stopped') {
          this.clearScheduledAudio();
        }
      });
  }

  private clearScheduledAudio(): void {
    for (const source of this.scheduledSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {}
    }
    this.scheduledSources = [];
    this.scheduledTime = 0;
  }

  private setupUserGestureHandler(): void {
    const resumeAudio = () => {
      if (this.audioContext && this.audioContext.state === 'suspended') {
        this.audioContext.resume().catch(console.error);
      }
      document.removeEventListener('click', resumeAudio);
      document.removeEventListener('keydown', resumeAudio);
    };
    document.addEventListener('click', resumeAudio);
    document.addEventListener('keydown', resumeAudio);
  }

  private initAudioContext(): void {
    this.audioContext = new AudioContext({sampleRate: 44100});
    this.gainNode = this.audioContext.createGain();
    this.gainNode.connect(this.audioContext.destination);
  }

  private subscribeToVideoFrames(): void {
    this.electron.videoFrame
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(frame => {
        this.renderFrame(frame.data, frame.width, frame.height);
      });
  }

  private subscribeToAudioData(): void {
    this.electron.audioData
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(chunk => {
        this.processAudioChunk(chunk.data);
      });
  }

  private renderFrame(base64Data: string, width: number, height: number): void {
    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Maintain aspect ratio
    const containerRect = canvas.parentElement?.getBoundingClientRect();
    if (containerRect) {
      const aspectRatio = width / height;
      const containerAspect = containerRect.width / containerRect.height;

      if (containerAspect > aspectRatio) {
        canvas.height = containerRect.height;
        canvas.width = containerRect.height * aspectRatio;
      } else {
        canvas.width = containerRect.width;
        canvas.height = containerRect.width / aspectRatio;
      }
    }

    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = `data:image/jpeg;base64,${base64Data}`;
  }

  private processAudioChunk(data: ArrayBuffer | number[]): void {
    if (!this.audioContext || !this.gainNode) return;

    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(console.error);
    }

    // Convert array to ArrayBuffer if needed (IPC serialization workaround)
    const buffer = Array.isArray(data) ? new Uint8Array(data).buffer : data;

    const pcmData = new Int16Array(buffer);
    const floatData = new Float32Array(pcmData.length);

    for (let i = 0; i < pcmData.length; i++) {
      floatData[i] = pcmData[i] / 32768;
    }

    const samplesPerChannel = floatData.length / 2;
    const audioBuffer = this.audioContext.createBuffer(2, samplesPerChannel, 44100);

    const leftChannel = audioBuffer.getChannelData(0);
    const rightChannel = audioBuffer.getChannelData(1);

    for (let i = 0; i < samplesPerChannel; i++) {
      leftChannel[i] = floatData[i * 2];
      rightChannel[i] = floatData[i * 2 + 1];
    }

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode);

    const currentTime = this.audioContext.currentTime;

    if (this.scheduledTime < currentTime) {
      this.scheduledTime = currentTime;
    }

    if (this.scheduledTime > currentTime + this.MAX_BUFFER_AHEAD) {
      return;
    }

    const startTime = this.scheduledTime;
    source.start(startTime);
    this.scheduledTime = startTime + audioBuffer.duration;

    this.scheduledSources.push(source);

    source.onended = () => {
      source.disconnect();
      const idx = this.scheduledSources.indexOf(source);
      if (idx > -1) this.scheduledSources.splice(idx, 1);
    };
  }

  ngOnDestroy(): void {
    if (this.audioContext) {
      this.audioContext.close();
    }
  }
}

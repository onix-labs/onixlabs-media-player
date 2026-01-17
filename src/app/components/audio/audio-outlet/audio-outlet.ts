import {Component, ElementRef, ViewChild, OnInit, OnDestroy, inject, computed, signal, effect} from '@angular/core';
import {MediaPlayerService} from '../../../services/media-player.service';
import type {PlaylistItem} from '../../../services/electron.service';
import {Visualization, createVisualization, VisualizationType, VISUALIZATION_TYPES} from './visualizations';

@Component({
  selector: 'app-audio-outlet',
  standalone: true,
  imports: [],
  templateUrl: './audio-outlet.html',
  styleUrl: './audio-outlet.scss'
})
export class AudioOutlet implements OnInit, OnDestroy {
  @ViewChild('canvas', {static: true}) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('audioElement', {static: true}) audioRef!: ElementRef<HTMLAudioElement>;

  readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private animationId: number | null = null;
  private isInitialized: boolean = false;
  private readonly SMOOTHING: number = 0.85;

  private visualization: Visualization | null = null;
  private readonly visualizationType: ReturnType<typeof signal<VisualizationType>> = signal<VisualizationType>('bars');
  private currentFilePath: string | null = null;

  private readonly VISUALIZATION_NAMES: Record<VisualizationType, string> = {
    bars: 'Frequency Bars',
    waveform: 'Waveform',
    tunnel: 'Tunnel',
    water: 'Ambience Water',
    water2: 'Ambience Water 2'
  };

  readonly currentTrack: ReturnType<typeof computed<PlaylistItem | null>> = computed(() => this.mediaPlayer.currentTrack());
  readonly visualizationName: ReturnType<typeof computed<string>> = computed(() => this.VISUALIZATION_NAMES[this.visualizationType()]);

  constructor() {
    // React to track changes - load new audio source
    effect(() => {
      const track: PlaylistItem | null = this.mediaPlayer.currentTrack();
      if (track?.type === 'audio' && track.filePath !== this.currentFilePath) {
        this.loadAudioSource(track.filePath);
      }
    });

    // React to playback state changes
    effect(() => {
      const state: string = this.mediaPlayer.playbackState();
      const audio: HTMLAudioElement | undefined = this.audioRef?.nativeElement;
      if (!audio) return;

      if (state === 'playing') {
        this.resumeAudioContext();
        if (audio.src && audio.paused) {
          audio.play().catch(console.error);
        }
      } else if (state === 'paused') {
        audio.pause();
      } else if (state === 'stopped') {
        audio.pause();
        audio.currentTime = 0;
      }
    });

    // React to seek events
    effect(() => {
      const time: number = this.mediaPlayer.currentTime();
      const audio: HTMLAudioElement | undefined = this.audioRef?.nativeElement;
      if (!audio || !audio.src) return;

      // Only sync if significantly different (avoid feedback loop)
      if (Math.abs(audio.currentTime - time) > 1) {
        audio.currentTime = time;
      }
    });

    // React to volume changes
    effect(() => {
      const volume: number = this.mediaPlayer.volume();
      const audio: HTMLAudioElement | undefined = this.audioRef?.nativeElement;
      if (audio) {
        audio.volume = volume;
      }
    });

    // React to mute changes
    effect(() => {
      const muted: boolean = this.mediaPlayer.muted();
      const audio: HTMLAudioElement | undefined = this.audioRef?.nativeElement;
      if (audio) {
        audio.muted = muted;
      }
    });
  }

  ngOnInit(): void {
    this.setupUserGestureHandler();
    this.initVisualization();
    this.startAnimationLoop();
  }

  private async loadAudioSource(filePath: string): Promise<void> {
    const audio: HTMLAudioElement = this.audioRef.nativeElement;
    const serverUrl: string = this.mediaPlayer.serverUrl();

    if (!serverUrl) return;

    this.currentFilePath = filePath;

    // Build the stream URL
    const url: string = `${serverUrl}/media/stream?path=${encodeURIComponent(filePath)}`;

    // Initialize audio context if needed (must be after user gesture)
    if (!this.isInitialized) {
      this.initAudioContext();
    }

    // Set the source and load
    audio.src = url;
    audio.load();

    console.log(`Audio source loaded: ${filePath}`);
  }

  private initAudioContext(): void {
    if (this.isInitialized) return;

    const audio: HTMLAudioElement = this.audioRef.nativeElement;

    this.audioContext = new AudioContext({sampleRate: 44100});
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = this.SMOOTHING;

    // Connect audio element to Web Audio API via MediaElementSource
    this.sourceNode = this.audioContext.createMediaElementSource(audio);
    this.sourceNode.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);

    this.isInitialized = true;

    // Re-initialize visualization with the new analyser
    if (this.visualization) {
      this.visualization.destroy();
      this.initVisualization();
    }
  }

  private resumeAudioContext(): void {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(console.error);
    }
  }

  private setupUserGestureHandler(): void {
    const initOnGesture: () => void = () => {
      if (!this.isInitialized) {
        this.initAudioContext();
      }
      this.resumeAudioContext();
      document.removeEventListener('click', initOnGesture);
      document.removeEventListener('keydown', initOnGesture);
    };
    document.addEventListener('click', initOnGesture);
    document.addEventListener('keydown', initOnGesture);
  }

  nextVisualization(): void {
    const currentIndex: number = VISUALIZATION_TYPES.indexOf(this.visualizationType());
    const nextIndex: number = (currentIndex + 1) % VISUALIZATION_TYPES.length;
    this.setVisualization(VISUALIZATION_TYPES[nextIndex]);
  }

  previousVisualization(): void {
    const currentIndex: number = VISUALIZATION_TYPES.indexOf(this.visualizationType());
    const prevIndex: number = (currentIndex - 1 + VISUALIZATION_TYPES.length) % VISUALIZATION_TYPES.length;
    this.setVisualization(VISUALIZATION_TYPES[prevIndex]);
  }

  setVisualization(type: VisualizationType): void {
    this.visualizationType.set(type);

    if (this.visualization) {
      this.visualization.destroy();
    }

    if (this.analyser) {
      this.visualization = createVisualization(type, {
        canvas: this.canvasRef.nativeElement,
        analyser: this.analyser
      });

      const rect: DOMRect = this.canvasRef.nativeElement.getBoundingClientRect();
      this.visualization.resize(Math.round(rect.width), Math.round(rect.height));
    }
  }

  private initVisualization(): void {
    if (!this.analyser) return;

    this.visualization = createVisualization(this.visualizationType(), {
      canvas: this.canvasRef.nativeElement,
      analyser: this.analyser
    });

    const rect: DOMRect = this.canvasRef.nativeElement.getBoundingClientRect();
    this.visualization.resize(Math.round(rect.width), Math.round(rect.height));
  }

  private startAnimationLoop(): void {
    const canvas: HTMLCanvasElement = this.canvasRef.nativeElement;

    const draw: () => void = () => {
      this.animationId = requestAnimationFrame(draw);

      const rect: DOMRect = canvas.getBoundingClientRect();
      const width: number = Math.round(rect.width);
      const height: number = Math.round(rect.height);

      if (canvas.width !== width || canvas.height !== height) {
        this.visualization?.resize(width, height);
      }

      this.visualization?.draw();
    };

    draw();
  }

  ngOnDestroy(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    this.visualization?.destroy();
    if (this.audioContext) {
      this.audioContext.close();
    }
  }
}

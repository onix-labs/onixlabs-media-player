import {Component, ElementRef, ViewChild, OnInit, OnDestroy, inject, computed, signal, effect} from '@angular/core';
import {MediaPlayerService} from '../../../services/media-player.service';
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

  readonly mediaPlayer = inject(MediaPlayerService);

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private animationId: number | null = null;
  private isInitialized = false;
  private readonly SMOOTHING = 0.85;

  private visualization: Visualization | null = null;
  private readonly visualizationType = signal<VisualizationType>('bars');

  private readonly VISUALIZATION_NAMES: Record<VisualizationType, string> = {
    bars: 'Frequency Bars',
    waveform: 'Waveform',
    tunnel: 'Tunnel',
    water: 'Ambience Water',
    water2: 'Ambience Water 2'
  };

  readonly currentTrack = computed(() => this.mediaPlayer.currentTrack());
  readonly visualizationName = computed(() => this.VISUALIZATION_NAMES[this.visualizationType()]);

  constructor() {
    // React to track changes - load new audio source
    effect(() => {
      const track = this.mediaPlayer.currentTrack();
      if (track?.type === 'audio') {
        this.loadAudioSource(track.filePath);
      }
    });

    // React to playback state changes
    effect(() => {
      const state = this.mediaPlayer.playbackState();
      const audio = this.audioRef?.nativeElement;
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
      const time = this.mediaPlayer.currentTime();
      const audio = this.audioRef?.nativeElement;
      if (!audio || !audio.src) return;

      // Only sync if significantly different (avoid feedback loop)
      if (Math.abs(audio.currentTime - time) > 1) {
        audio.currentTime = time;
      }
    });

    // React to volume changes
    effect(() => {
      const volume = this.mediaPlayer.volume();
      const audio = this.audioRef?.nativeElement;
      if (audio) {
        audio.volume = volume;
      }
    });

    // React to mute changes
    effect(() => {
      const muted = this.mediaPlayer.muted();
      const audio = this.audioRef?.nativeElement;
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
    const audio = this.audioRef.nativeElement;
    const serverUrl = this.mediaPlayer.serverUrl();

    if (!serverUrl) return;

    // Build the stream URL
    const url = `${serverUrl}/media/stream?path=${encodeURIComponent(filePath)}`;

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

    const audio = this.audioRef.nativeElement;

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
    const initOnGesture = () => {
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
    const currentIndex = VISUALIZATION_TYPES.indexOf(this.visualizationType());
    const nextIndex = (currentIndex + 1) % VISUALIZATION_TYPES.length;
    this.setVisualization(VISUALIZATION_TYPES[nextIndex]);
  }

  previousVisualization(): void {
    const currentIndex = VISUALIZATION_TYPES.indexOf(this.visualizationType());
    const prevIndex = (currentIndex - 1 + VISUALIZATION_TYPES.length) % VISUALIZATION_TYPES.length;
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

      const rect = this.canvasRef.nativeElement.getBoundingClientRect();
      this.visualization.resize(Math.round(rect.width), Math.round(rect.height));
    }
  }

  private initVisualization(): void {
    if (!this.analyser) return;

    this.visualization = createVisualization(this.visualizationType(), {
      canvas: this.canvasRef.nativeElement,
      analyser: this.analyser
    });

    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    this.visualization.resize(Math.round(rect.width), Math.round(rect.height));
  }

  private startAnimationLoop(): void {
    const canvas = this.canvasRef.nativeElement;

    const draw = () => {
      this.animationId = requestAnimationFrame(draw);

      const rect = canvas.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);

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

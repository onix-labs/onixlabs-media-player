import {Component, ElementRef, ViewChild, OnInit, OnDestroy, inject, computed, DestroyRef, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {ElectronService} from '../../../services/electron.service';
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

  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);
  readonly mediaPlayer = inject(MediaPlayerService);

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animationId: number | null = null;
  private gainNode: GainNode | null = null;
  private scheduledTime = 0;
  private isInitialized = false;
  private scheduledSources: AudioBufferSourceNode[] = [];
  private readonly MAX_BUFFER_AHEAD = 0.15;
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

  ngOnInit(): void {
    this.initAudioContext();
    this.subscribeToAudioData();
    this.subscribeToStateChanges();
    this.initVisualization();
    this.startAnimationLoop();
    this.setupUserGestureHandler();
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

      // Apply current size
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
  }

  private startAnimationLoop(): void {
    const canvas = this.canvasRef.nativeElement;

    const draw = () => {
      this.animationId = requestAnimationFrame(draw);

      // Handle canvas resize
      const rect = canvas.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);

      if (canvas.width !== width || canvas.height !== height) {
        this.visualization?.resize(width, height);
      }

      // Draw current visualization
      this.visualization?.draw();
    };

    draw();
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
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = this.SMOOTHING;

    this.gainNode = this.audioContext.createGain();
    this.gainNode.connect(this.audioContext.destination);

    this.analyser.connect(this.gainNode);
    this.isInitialized = true;
  }

  private subscribeToAudioData(): void {
    this.electron.audioData
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(chunk => {
        this.processAudioChunk(chunk.data);
      });
  }

  private processAudioChunk(data: ArrayBuffer | number[]): void {
    if (!this.audioContext || !this.analyser || !this.isInitialized) return;

    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(console.error);
    }

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
    source.connect(this.analyser!);

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
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    this.visualization?.destroy();
    if (this.audioContext) {
      this.audioContext.close();
    }
  }
}

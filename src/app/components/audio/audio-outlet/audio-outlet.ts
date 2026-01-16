import {Component, ElementRef, ViewChild, OnInit, OnDestroy, inject, computed, DestroyRef} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {ElectronService} from '../../../services/electron.service';
import {MediaPlayerService} from '../../../services/media-player.service';

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
  private dataArray: Uint8Array<ArrayBuffer> | null = null;
  private gainNode: GainNode | null = null;
  private scheduledTime = 0;
  private isInitialized = false;

  private readonly BAR_COUNT = 64;
  private readonly BAR_GAP = 2;
  private readonly SMOOTHING = 0.85;

  readonly currentTrack = computed(() => this.mediaPlayer.currentTrack());

  ngOnInit(): void {
    this.initAudioContext();
    this.subscribeToAudioData();
    this.startVisualization();
    this.setupUserGestureHandler();
  }

  private setupUserGestureHandler(): void {
    // Resume AudioContext on first user interaction (required by browser autoplay policy)
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

    const bufferLength = this.analyser.frequencyBinCount;
    this.dataArray = new Uint8Array(bufferLength) as Uint8Array<ArrayBuffer>;

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

    // Resume context if suspended (with user gesture already occurred from play button)
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(console.error);
    }

    // Convert array to ArrayBuffer if needed (IPC serialization workaround)
    const buffer = Array.isArray(data) ? new Uint8Array(data).buffer : data;

    // Convert PCM Int16 to Float32
    const pcmData = new Int16Array(buffer);
    const floatData = new Float32Array(pcmData.length);

    for (let i = 0; i < pcmData.length; i++) {
      floatData[i] = pcmData[i] / 32768;
    }

    // Create stereo audio buffer
    const samplesPerChannel = floatData.length / 2;
    const audioBuffer = this.audioContext.createBuffer(2, samplesPerChannel, 44100);

    const leftChannel = audioBuffer.getChannelData(0);
    const rightChannel = audioBuffer.getChannelData(1);

    // Deinterleave stereo data
    for (let i = 0; i < samplesPerChannel; i++) {
      leftChannel[i] = floatData[i * 2];
      rightChannel[i] = floatData[i * 2 + 1];
    }

    // Schedule playback
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.analyser!);

    const currentTime = this.audioContext.currentTime;
    const startTime = Math.max(currentTime, this.scheduledTime);
    source.start(startTime);
    this.scheduledTime = startTime + audioBuffer.duration;

    // Clean up old source
    source.onended = () => {
      source.disconnect();
    };
  }

  private startVisualization(): void {
    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      this.animationId = requestAnimationFrame(draw);

      // Set canvas size to match container
      const rect = canvas.getBoundingClientRect();
      if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
      }

      // Clear with fade effect
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (!this.analyser || !this.dataArray) return;

      this.analyser.getByteFrequencyData(this.dataArray);

      const barWidth = (canvas.width - (this.BAR_COUNT - 1) * this.BAR_GAP) / this.BAR_COUNT;
      const step = Math.floor(this.dataArray.length / this.BAR_COUNT);

      for (let i = 0; i < this.BAR_COUNT; i++) {
        // Average nearby frequencies for smoother visualization
        let sum = 0;
        for (let j = 0; j < step; j++) {
          sum += this.dataArray[i * step + j];
        }
        const value = sum / step;

        const barHeight = (value / 255) * canvas.height * 0.85;
        const x = i * (barWidth + this.BAR_GAP);
        const y = canvas.height - barHeight;

        // Create gradient based on frequency position
        const hue = 200 + (i / this.BAR_COUNT) * 60; // Blue to cyan
        const lightness = 45 + (value / 255) * 20;

        const gradient = ctx.createLinearGradient(x, y, x, canvas.height);
        gradient.addColorStop(0, `hsl(${hue}, 85%, ${lightness + 15}%)`);
        gradient.addColorStop(1, `hsl(${hue}, 75%, ${lightness}%)`);

        ctx.fillStyle = gradient;

        // Draw bar with rounded top
        const radius = Math.min(barWidth / 2, 4);
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + barWidth - radius, y);
        ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius);
        ctx.lineTo(x + barWidth, canvas.height);
        ctx.lineTo(x, canvas.height);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.fill();

        // Reflection effect
        const reflectionGradient = ctx.createLinearGradient(x, canvas.height, x, canvas.height + barHeight * 0.2);
        reflectionGradient.addColorStop(0, `hsla(${hue}, 75%, ${lightness}%, 0.4)`);
        reflectionGradient.addColorStop(1, `hsla(${hue}, 75%, ${lightness}%, 0)`);
        ctx.fillStyle = reflectionGradient;
        ctx.fillRect(x, canvas.height, barWidth, barHeight * 0.2);
      }
    };

    draw();
  }

  ngOnDestroy(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    if (this.audioContext) {
      this.audioContext.close();
    }
  }
}

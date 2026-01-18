import {Component, ElementRef, ViewChild, OnInit, OnDestroy, inject, computed, signal, effect, HostBinding} from '@angular/core';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import type {PlaylistItem} from '../../../services/electron.service';
import {Visualization, createVisualization, VisualizationType, VISUALIZATION_TYPES} from './visualizations';

// Supported media extensions for drag and drop
const MEDIA_EXTENSIONS: Set<string> = new Set([
  '.mp3', '.mp4', '.flac', '.mkv', '.avi', '.wav',
  '.ogg', '.webm', '.m4a', '.aac', '.wma', '.mov'
]);

@Component({
  selector: 'app-audio-outlet',
  standalone: true,
  imports: [],
  templateUrl: './audio-outlet.html',
  styleUrl: './audio-outlet.scss'
})
export class AudioOutlet implements OnInit, OnDestroy {
  @ViewChild('canvas', {static: true}) public canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('audioElement', {static: true}) public audioRef!: ElementRef<HTMLAudioElement>;

  public readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);
  private readonly electron: ElectronService = inject(ElectronService);

  public readonly isFullscreen: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.isFullscreen());
  public readonly isDragOver: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  @HostBinding('class.fullscreen')
  public get fullscreenClass(): boolean {
    return this.isFullscreen();
  }

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

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private animationId: number | null = null;
  private isInitialized: boolean = false;
  private readonly SMOOTHING: number = 0.85;

  private visualization: Visualization | null = null;
  private readonly visualizationType: ReturnType<typeof signal<VisualizationType>> = signal<VisualizationType>('bars');
  private readonly visualizationNameSignal: ReturnType<typeof signal<string>> = signal<string>('Frequency Bars');
  private currentFilePath: string | null = null;

  public readonly currentTrack: ReturnType<typeof computed<PlaylistItem | null>> = computed((): PlaylistItem | null => this.mediaPlayer.currentTrack());
  public readonly visualizationName: ReturnType<typeof computed<string>> = computed((): string => this.visualizationNameSignal());

  constructor() {
    // React to track changes - load new audio source
    effect((): void => {
      const track: PlaylistItem | null = this.mediaPlayer.currentTrack();
      if (track?.type === 'audio' && track.filePath !== this.currentFilePath) {
        void this.loadAudioSource(track.filePath);
      }
    });

    // React to playback state changes
    effect((): void => {
      const state: string = this.mediaPlayer.playbackState();
      const audio: HTMLAudioElement | undefined = this.audioRef?.nativeElement;
      if (!audio) return;

      // Update visualization fade state
      this.visualization?.setPlaying(state === 'playing');

      if (state === 'playing') {
        this.resumeAudioContext();
        // Ensure visualization is initialized when playback starts
        if (!this.visualization && this.analyser) {
          this.initVisualization();
        }
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
    effect((): void => {
      const time: number = this.mediaPlayer.currentTime();
      const audio: HTMLAudioElement | undefined = this.audioRef?.nativeElement;
      if (!audio || !audio.src) return;

      // Only sync if significantly different (avoid feedback loop)
      if (Math.abs(audio.currentTime - time) > 1) {
        audio.currentTime = time;
      }
    });

    // React to volume changes - use GainNode for volume control
    // This keeps the analyser receiving full signal for visualization
    effect((): void => {
      const volume: number = this.mediaPlayer.volume();
      if (this.gainNode) {
        this.gainNode.gain.value = volume;
      }
    });

    // React to mute changes - use GainNode for muting
    effect((): void => {
      const muted: boolean = this.mediaPlayer.muted();
      if (this.gainNode) {
        this.gainNode.gain.value = muted ? 0 : this.mediaPlayer.volume();
      }
    });
  }

  public ngOnInit(): void {
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

    // Create GainNode for volume control (keeps analyser at full signal)
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.mediaPlayer.muted() ? 0 : this.mediaPlayer.volume();

    // Connect: source → analyser → gainNode → destination
    // This ensures analyser sees full signal regardless of volume
    this.sourceNode = this.audioContext.createMediaElementSource(audio);
    this.sourceNode.connect(this.analyser);
    this.analyser.connect(this.gainNode);
    this.gainNode.connect(this.audioContext.destination);

    this.isInitialized = true;

    // Initialize visualization now that analyser is available
    if (this.visualization) {
      this.visualization.destroy();
    }
    this.initVisualization();
  }

  private resumeAudioContext(): void {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(console.error);
    }
  }

  private setupUserGestureHandler(): void {
    const initOnGesture: () => void = (): void => {
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

  public nextVisualization(): void {
    const currentIndex: number = VISUALIZATION_TYPES.indexOf(this.visualizationType());
    const nextIndex: number = (currentIndex + 1) % VISUALIZATION_TYPES.length;
    this.setVisualization(VISUALIZATION_TYPES[nextIndex]);
  }

  public previousVisualization(): void {
    const currentIndex: number = VISUALIZATION_TYPES.indexOf(this.visualizationType());
    const prevIndex: number = (currentIndex - 1 + VISUALIZATION_TYPES.length) % VISUALIZATION_TYPES.length;
    this.setVisualization(VISUALIZATION_TYPES[prevIndex]);
  }

  public setVisualization(type: VisualizationType): void {
    this.visualizationType.set(type);

    if (this.visualization) {
      this.visualization.destroy();
    }

    if (this.analyser) {
      this.visualization = createVisualization(type, {
        canvas: this.canvasRef.nativeElement,
        analyser: this.analyser
      });
      this.visualizationNameSignal.set(this.visualization.name);
      this.visualization.setPlaying(this.mediaPlayer.playbackState() === 'playing');

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
    this.visualizationNameSignal.set(this.visualization.name);
    this.visualization.setPlaying(this.mediaPlayer.playbackState() === 'playing');

    const rect: DOMRect = this.canvasRef.nativeElement.getBoundingClientRect();
    this.visualization.resize(Math.round(rect.width), Math.round(rect.height));
  }

  private startAnimationLoop(): void {
    const canvas: HTMLCanvasElement = this.canvasRef.nativeElement;

    const draw: () => void = (): void => {
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

  public ngOnDestroy(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    this.visualization?.destroy();
    if (this.audioContext) {
      this.audioContext.close();
    }
  }
}

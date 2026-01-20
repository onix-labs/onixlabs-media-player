/**
 * @fileoverview Audio outlet component with visualization support.
 *
 * This component handles audio playback and renders real-time visualizations
 * based on the audio frequency data. It uses the Web Audio API to analyze
 * the audio signal without affecting the volume heard by the user.
 *
 * Architecture:
 * ```
 * Audio Element → MediaElementSource → Analyser → GainNode → Destination
 *                                         ↓
 *                                   Visualization
 * ```
 *
 * The analyser node receives the full audio signal (unaffected by volume),
 * while the gain node controls the actual output volume. This allows
 * visualizations to remain active and responsive even at low volumes.
 *
 * Features:
 * - Real-time audio visualization with multiple modes
 * - Volume-independent analysis (visualizations work at any volume)
 * - Drag-and-drop file support
 * - Double-click for fullscreen toggle
 * - Smooth fade effects when pausing/playing
 *
 * @module app/components/audio/audio-outlet
 */

import {Component, ElementRef, ViewChild, OnInit, OnDestroy, inject, computed, signal, effect, HostBinding} from '@angular/core';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import {SettingsService} from '../../../services/settings.service';
import type {PlaylistItem} from '../../../types/electron';
import {Visualization, createVisualization, VisualizationType, VISUALIZATION_TYPES} from './visualizations';

/**
 * Supported media file extensions for drag-and-drop filtering.
 * Files with other extensions are ignored when dropped.
 */
const MEDIA_EXTENSIONS: Set<string> = new Set([
  '.mp3', '.mp4', '.flac', '.mkv', '.avi', '.wav',
  '.ogg', '.webm', '.m4a', '.aac', '.wma', '.mov',
  '.mid', '.midi'
]);

/**
 * Audio outlet component that plays audio and renders visualizations.
 *
 * This component is displayed when the current media is audio (not video).
 * It manages:
 * - HTML5 audio element for playback
 * - Web Audio API for frequency analysis
 * - Canvas-based visualizations
 * - Playback state synchronization with the server
 *
 * The component uses Angular effects to react to state changes from the
 * MediaPlayerService, keeping the audio element synchronized with the
 * server's playback state.
 *
 * @example
 * <!-- In layout-outlet template -->
 * @if (isAudio()) {
 *   <app-audio-outlet />
 * }
 */
@Component({
  selector: 'app-audio-outlet',
  standalone: true,
  imports: [],
  templateUrl: './audio-outlet.html',
  styleUrl: './audio-outlet.scss'
})
export class AudioOutlet implements OnInit, OnDestroy {
  // ============================================================================
  // View References
  // ============================================================================

  /** Reference to the canvas element for visualizations */
  @ViewChild('canvas', {static: true}) public canvasRef!: ElementRef<HTMLCanvasElement>;

  /** Reference to the hidden audio element for playback */
  @ViewChild('audioElement', {static: true}) public audioRef!: ElementRef<HTMLAudioElement>;

  // ============================================================================
  // Services
  // ============================================================================

  /** Media player service for playback state and control */
  public readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);

  /** Electron service for file operations and fullscreen */
  private readonly electron: ElectronService = inject(ElectronService);

  /** Settings service for user preferences */
  private readonly settings: SettingsService = inject(SettingsService);

  // ============================================================================
  // Reactive State
  // ============================================================================

  /** Whether the application is in fullscreen mode */
  public readonly isFullscreen: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.isFullscreen());

  /** Whether files are being dragged over this component */
  public readonly isDragOver: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Currently playing track (for display purposes) */
  public readonly currentTrack: ReturnType<typeof computed<PlaylistItem | null>> = computed((): PlaylistItem | null => this.mediaPlayer.currentTrack());

  /** Display name of the current visualization mode */
  public readonly visualizationName: ReturnType<typeof computed<string>> = computed((): string => this.visualizationNameSignal());

  /** Category of the current visualization mode */
  public readonly visualizationCategory: ReturnType<typeof computed<string>> = computed((): string => this.visualizationCategorySignal());

  // ============================================================================
  // Host Bindings
  // ============================================================================

  /**
   * Adds 'fullscreen' CSS class when in fullscreen mode.
   */
  @HostBinding('class.fullscreen')
  public get fullscreenClass(): boolean {
    return this.isFullscreen();
  }

  // ============================================================================
  // Web Audio API State
  // ============================================================================

  /** The Web Audio context for audio processing */
  private audioContext: AudioContext | null = null;

  /** Analyser node for frequency data extraction */
  private analyser: AnalyserNode | null = null;

  /** Source node connected to the audio element */
  private sourceNode: MediaElementAudioSourceNode | null = null;

  /** Gain node for volume control (separate from analyser) */
  private gainNode: GainNode | null = null;

  /** Animation frame ID for the visualization loop */
  private animationId: number | null = null;

  /** Timestamp of last frame render (for frame rate limiting) */
  private lastFrameTime: number = 0;

  /** Whether the audio context has been initialized */
  private isInitialized: boolean = false;

  /** Smoothing factor for frequency data (0-1, higher = smoother) */
  private readonly SMOOTHING: number = 0.85;

  // ============================================================================
  // Visualization State
  // ============================================================================

  /** Current visualization instance */
  private visualization: Visualization | null = null;

  /** Signal for the current visualization type */
  private readonly visualizationType: ReturnType<typeof signal<VisualizationType>> = signal<VisualizationType>('bars');

  /** Signal for the visualization display name */
  private readonly visualizationNameSignal: ReturnType<typeof signal<string>> = signal<string>('Frequency Bars');

  /** Signal for the visualization category */
  private readonly visualizationCategorySignal: ReturnType<typeof signal<string>> = signal<string>('Bars');

  /** File path of currently loaded audio (for change detection) */
  private currentFilePath: string | null = null;

  /** Whether the default visualization from settings has been applied */
  private defaultVisualizationApplied: boolean = false;

  // ============================================================================
  // Constructor - Reactive Effects
  // ============================================================================

  /**
   * Sets up reactive effects for playback synchronization.
   *
   * Effects react to:
   * - Track changes: loads new audio source
   * - Playback state: plays/pauses/stops the audio element
   * - Seek events: synchronizes audio element position
   * - Volume changes: adjusts gain node
   * - Mute changes: sets gain to 0 or restores volume
   */
  public constructor() {
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
          // Fade in when starting playback
          this.fadeToVolume(this.mediaPlayer.muted() ? 0 : this.mediaPlayer.volume());
          audio.play().catch(console.error);
        }
      } else if (state === 'paused') {
        // Fade out when pausing
        this.fadeToVolume(0, (): void => {
          audio.pause();
        });
      } else if (state === 'stopped') {
        // Fade out when stopping
        this.fadeToVolume(0, (): void => {
          audio.pause();
          audio.currentTime = 0;
        });
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
      if (this.gainNode && this.audioContext && !this.mediaPlayer.muted()) {
        // Use Web Audio API scheduling for smooth volume changes
        const currentTime: number = this.audioContext.currentTime;
        this.gainNode.gain.cancelScheduledValues(currentTime);
        this.gainNode.gain.setValueAtTime(volume, currentTime);
      }
    });

    // React to mute changes - use GainNode for muting
    effect((): void => {
      const muted: boolean = this.mediaPlayer.muted();
      if (this.gainNode && this.audioContext) {
        const currentTime: number = this.audioContext.currentTime;
        const targetVolume: number = muted ? 0 : this.mediaPlayer.volume();
        this.gainNode.gain.cancelScheduledValues(currentTime);
        this.gainNode.gain.setValueAtTime(targetVolume, currentTime);
      }
    });

    // React to settings loading - apply default visualization once
    effect((): void => {
      const isLoaded: boolean = this.settings.isLoaded();
      const defaultType: VisualizationType = this.settings.defaultVisualization() as VisualizationType;

      if (isLoaded && !this.defaultVisualizationApplied) {
        this.defaultVisualizationApplied = true;
        this.setVisualization(defaultType);
      }
    });

    // React to menu visualization selection
    effect((): void => {
      const vizId: string = this.electron.menuSelectVisualization();
      if (vizId && VISUALIZATION_TYPES.includes(vizId as VisualizationType)) {
        this.setVisualization(vizId as VisualizationType);
      }
    });

    // React to sensitivity setting changes (global or per-visualization)
    effect((): void => {
      // Watch both global and per-viz sensitivity signals
      const _global: number = this.settings.sensitivity();
      const _perViz = this.settings.perVisualizationSensitivity();
      const vizType: VisualizationType = this.visualizationType();

      if (this.visualization) {
        const effectiveSensitivity: number = this.settings.getEffectiveSensitivity(vizType);
        this.visualization.setSensitivity(effectiveSensitivity);
      }
    });

    // React to trail intensity setting changes
    effect((): void => {
      const trailIntensity: number = this.settings.trailIntensity();

      if (this.visualization) {
        this.visualization.setTrailIntensity(trailIntensity);
      }
    });

    // React to hue shift setting changes
    effect((): void => {
      const hueShift: number = this.settings.hueShift();

      if (this.visualization) {
        this.visualization.setHueShift(hueShift);
      }
    });

    // React to FFT size setting changes
    effect((): void => {
      const fftSize: number = this.settings.fftSize();

      if (this.visualization) {
        this.visualization.setFftSize(fftSize);
      }
    });

    // React to bar density setting changes
    effect((): void => {
      const barDensity: 'low' | 'medium' | 'high' = this.settings.barDensity();

      if (this.visualization) {
        this.visualization.setBarDensity(barDensity);
      }
    });

    // React to line width setting changes
    effect((): void => {
      const lineWidth: number = this.settings.lineWidth();

      if (this.visualization) {
        this.visualization.setLineWidth(lineWidth);
      }
    });

    // React to glow intensity setting changes
    effect((): void => {
      const glowIntensity: number = this.settings.glowIntensity();

      if (this.visualization) {
        this.visualization.setGlowIntensity(glowIntensity);
      }
    });
  }

  // ============================================================================
  // Lifecycle Hooks
  // ============================================================================

  /**
   * Initializes the component after view is ready.
   *
   * Sets up:
   * - User gesture handler (required to start AudioContext)
   * - Initial visualization
   * - Animation loop for continuous rendering
   */
  public ngOnInit(): void {
    this.setupUserGestureHandler();
    this.initVisualization();
    this.startAnimationLoop();
  }

  /**
   * Cleanup when component is destroyed.
   *
   * Stops animation loop, destroys visualization, and closes audio context.
   */
  public ngOnDestroy(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    this.visualization?.destroy();
    if (this.audioContext) {
      this.audioContext.close();
    }
  }

  // ============================================================================
  // Event Handlers
  // ============================================================================

  /**
   * Toggles fullscreen mode on double-click.
   */
  public onDoubleClick(): void {
    void this.electron.toggleFullscreen();
  }

  /**
   * Handles dragover to enable drop target.
   */
  public onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(true);
  }

  /**
   * Handles dragleave to reset visual feedback.
   */
  public onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
  }

  /**
   * Handles file drop to add media to playlist.
   *
   * Filters for supported extensions, adds to playlist, and
   * immediately starts playing the first added file.
   */
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

  // ============================================================================
  // Audio Loading
  // ============================================================================

  /**
   * Loads a new audio source from the media server.
   *
   * Initializes the audio context if needed (after user gesture),
   * sets the audio element source, and triggers loading.
   *
   * @param filePath - Absolute path to the audio file
   */
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

  // ============================================================================
  // Web Audio API Initialization
  // ============================================================================

  /**
   * Initializes the Web Audio API graph.
   *
   * Creates the audio processing chain:
   * Source → Analyser → GainNode → Destination
   *
   * The analyser receives full signal for visualization, while
   * the gain node controls the actual output volume.
   */
  private initAudioContext(): void {
    if (this.isInitialized) return;

    const audio: HTMLAudioElement = this.audioRef.nativeElement;

    this.audioContext = new AudioContext({sampleRate: 44100});
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = this.SMOOTHING;

    // Create GainNode for volume control (keeps analyser at full signal)
    // Start at 0 for fade-in when playback begins
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = 0;

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

  /**
   * Resumes the audio context if it was suspended.
   *
   * AudioContext starts suspended and requires a user gesture to resume.
   * This is called when playback starts.
   */
  private resumeAudioContext(): void {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(console.error);
    }
  }

  /**
   * Fades the gain to a target volume over the crossfade duration.
   *
   * Uses the Web Audio API's linearRampToValueAtTime for smooth volume
   * transitions, preventing audio pops when starting/stopping playback.
   *
   * @param targetVolume - The target volume (0-1)
   * @param callback - Optional callback to execute after fade completes
   */
  private fadeToVolume(targetVolume: number, callback?: () => void): void {
    if (!this.gainNode || !this.audioContext) {
      // No audio context, just execute callback immediately
      callback?.();
      return;
    }

    const crossfadeDuration: number = this.settings.crossfadeDuration();
    const currentTime: number = this.audioContext.currentTime;

    // If crossfade is disabled (0ms), set volume immediately
    if (crossfadeDuration <= 0) {
      this.gainNode.gain.setValueAtTime(targetVolume, currentTime);
      callback?.();
      return;
    }

    // Convert ms to seconds for Web Audio API
    const fadeTime: number = crossfadeDuration / 1000;

    // Cancel any scheduled changes and ramp to target
    this.gainNode.gain.cancelScheduledValues(currentTime);
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, currentTime);
    this.gainNode.gain.linearRampToValueAtTime(targetVolume, currentTime + fadeTime);

    // Execute callback after fade completes
    if (callback) {
      setTimeout(callback, crossfadeDuration);
    }
  }

  /**
   * Sets up listeners to initialize audio context on first user interaction.
   *
   * Web browsers require a user gesture before starting an AudioContext.
   * This method adds click and keydown listeners that initialize the
   * context on first interaction, then remove themselves.
   */
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

  // ============================================================================
  // Visualization Control
  // ============================================================================

  /**
   * Cycles to the next visualization type.
   */
  public nextVisualization(): void {
    const currentIndex: number = VISUALIZATION_TYPES.indexOf(this.visualizationType());
    const nextIndex: number = (currentIndex + 1) % VISUALIZATION_TYPES.length;
    this.setVisualization(VISUALIZATION_TYPES[nextIndex]);
  }

  /**
   * Cycles to the previous visualization type.
   */
  public previousVisualization(): void {
    const currentIndex: number = VISUALIZATION_TYPES.indexOf(this.visualizationType());
    const prevIndex: number = (currentIndex - 1 + VISUALIZATION_TYPES.length) % VISUALIZATION_TYPES.length;
    this.setVisualization(VISUALIZATION_TYPES[prevIndex]);
  }

  /**
   * Sets the visualization to a specific type.
   *
   * Destroys the current visualization and creates a new one of the
   * specified type. Updates the display name signal.
   *
   * @param type - The visualization type to activate
   */
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
      this.visualizationCategorySignal.set(this.visualization.category);
      this.visualization.setPlaying(this.mediaPlayer.playbackState() === 'playing');
      this.visualization.setSensitivity(this.settings.getEffectiveSensitivity(type));
      this.visualization.setTrailIntensity(this.settings.trailIntensity());
      this.visualization.setHueShift(this.settings.hueShift());
      this.visualization.setFftSize(this.settings.fftSize());
      this.visualization.setBarDensity(this.settings.barDensity());
      this.visualization.setLineWidth(this.settings.lineWidth());
      this.visualization.setGlowIntensity(this.settings.glowIntensity());

      const rect: DOMRect = this.canvasRef.nativeElement.getBoundingClientRect();
      this.visualization.resize(Math.round(rect.width), Math.round(rect.height));
    }
  }

  /**
   * Initializes the current visualization.
   *
   * Called during component initialization and when the analyser
   * becomes available. Creates the visualization and sets initial size.
   */
  private initVisualization(): void {
    if (!this.analyser) return;

    this.visualization = createVisualization(this.visualizationType(), {
      canvas: this.canvasRef.nativeElement,
      analyser: this.analyser
    });
    this.visualizationNameSignal.set(this.visualization.name);
    this.visualizationCategorySignal.set(this.visualization.category);
    this.visualization.setPlaying(this.mediaPlayer.playbackState() === 'playing');
    this.visualization.setSensitivity(this.settings.getEffectiveSensitivity(this.visualizationType()));
    this.visualization.setTrailIntensity(this.settings.trailIntensity());
    this.visualization.setHueShift(this.settings.hueShift());
    this.visualization.setFftSize(this.settings.fftSize());
    this.visualization.setBarDensity(this.settings.barDensity());
    this.visualization.setLineWidth(this.settings.lineWidth());
    this.visualization.setGlowIntensity(this.settings.glowIntensity());

    const rect: DOMRect = this.canvasRef.nativeElement.getBoundingClientRect();
    this.visualization.resize(Math.round(rect.width), Math.round(rect.height));
  }

  /**
   * Starts the animation loop for continuous visualization rendering.
   *
   * Uses requestAnimationFrame for smooth rendering. The loop handles
   * canvas resizing and delegates drawing to the visualization.
   * Frame rate can be limited via settings (0 = uncapped, or 15/30/60 FPS).
   */
  private startAnimationLoop(): void {
    const canvas: HTMLCanvasElement = this.canvasRef.nativeElement;

    const draw: (timestamp: number) => void = (timestamp: number): void => {
      this.animationId = requestAnimationFrame(draw);

      // Frame rate limiting
      const maxFps: number = this.settings.maxFrameRate();
      if (maxFps > 0) {
        const frameInterval: number = 1000 / maxFps;
        const elapsed: number = timestamp - this.lastFrameTime;
        if (elapsed < frameInterval) {
          return; // Skip this frame
        }
        this.lastFrameTime = timestamp - (elapsed % frameInterval);
      }

      const rect: DOMRect = canvas.getBoundingClientRect();
      const width: number = Math.round(rect.width);
      const height: number = Math.round(rect.height);

      if (canvas.width !== width || canvas.height !== height) {
        this.visualization?.resize(width, height);
      }

      this.visualization?.draw();
    };

    requestAnimationFrame(draw);
  }
}

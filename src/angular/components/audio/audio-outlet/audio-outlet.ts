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

import {Component, ElementRef, ViewChild, OnInit, OnDestroy, inject, computed, signal, effect, HostBinding, ChangeDetectionStrategy, Output, EventEmitter} from '@angular/core';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import {SettingsService, PerVisualizationSettings} from '../../../services/settings.service';
import {FileDropService} from '../../../services/file-drop.service';
import type {PlaylistItem} from '../../../types/electron';
import {Visualization, createVisualization, VISUALIZATION_TYPES, VISUALIZATION_METADATA} from './visualizations';

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
  styleUrl: './audio-outlet.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
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
  // Output Events
  // ============================================================================

  /** Emits the visualization display name when it changes (format: "Category : Name") */
  @Output() public readonly visualizationChange: EventEmitter<string> = new EventEmitter<string>();

  // ============================================================================
  // Services
  // ============================================================================

  /** Media player service for playback state and control */
  public readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);

  /** Electron service for file operations and fullscreen */
  private readonly electron: ElectronService = inject(ElectronService);

  /** Settings service for user preferences */
  private readonly settings: SettingsService = inject(SettingsService);

  /** File drop service for drag-and-drop handling */
  private readonly fileDrop: FileDropService = inject(FileDropService);

  // ============================================================================
  // Reactive State
  // ============================================================================

  /** Whether the application is in fullscreen mode */
  public readonly isFullscreen: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.isFullscreen());

  /** Whether files are being dragged over this component */
  public readonly isDragOver: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Whether dragged files are invalid (no valid media extensions) */
  public readonly isDragInvalid: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

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
  private readonly visualizationType: ReturnType<typeof signal<string>> = signal<string>('bars');

  /** Signal for the visualization display name */
  private readonly visualizationNameSignal: ReturnType<typeof signal<string>> = signal<string>('Frequency Bars');

  /** Signal for the visualization category */
  private readonly visualizationCategorySignal: ReturnType<typeof signal<string>> = signal<string>('Bars');

  /** File path of currently loaded audio (for change detection) */
  private currentFilePath: string | null = null;

  /** Whether the default visualization from settings has been applied */
  private defaultVisualizationApplied: boolean = false;

  /** Bound gesture handler for cleanup (stored so it can be removed if component destroys before gesture) */
  private gestureHandler: (() => void) | null = null;

  /** Timeout ID for pending crossfade callback (used to cancel stale pause/stop actions) */
  private fadeTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /** Whether rendering is paused during fullscreen transition */
  private renderingPaused: boolean = false;

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
    // React to track changes - load new audio source.
    // Also depends on playbackState to detect same-track re-selection:
    // when the server enters 'loading', currentFilePath is always cleared
    // so the same file gets reloaded on re-selection.
    // Also watches forceReloadCounter for soundfont changes that require re-render.
    effect((): void => {
      const track: PlaylistItem | null = this.mediaPlayer.currentTrack();
      const state: string = this.mediaPlayer.playbackState();
      const forceReload: number = this.electron.forceReloadCounter();

      // Clear cached path on loading or force reload (soundfont change)
      if (state === 'loading' || forceReload > 0) {
        this.currentFilePath = null;
      }

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
        if (audio.src) {
          // Fade in when starting playback
          // Always call play() regardless of audio.paused — a pending crossfade
          // callback may be about to pause the element, so we must cancel it
          // (fadeToVolume handles cancellation) and ensure playback continues.
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

    // React to seek events - synchronize audio element position with server time.
    // All formats (including pre-rendered MIDI) support range requests, so
    // native audio.currentTime seeking works universally.
    // The `audio.seeking` guard prevents re-triggering seeks while a seek is
    // in progress (audio.currentTime hasn't updated yet, causing drift detection
    // to fire repeatedly and create a seek loop).
    effect((): void => {
      const time: number = this.mediaPlayer.currentTime();
      const audio: HTMLAudioElement | undefined = this.audioRef?.nativeElement;
      if (!audio || !audio.src || audio.seeking) return;

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

    // React to window close - fade out audio to prevent speaker pop
    effect((): void => {
      const fadeDuration: number = this.electron.fadeOutRequested();
      if (fadeDuration > 0 && this.gainNode && this.audioContext) {
        const currentTime: number = this.audioContext.currentTime;
        const fadeTime: number = fadeDuration / 1000; // Convert to seconds
        this.gainNode.gain.cancelScheduledValues(currentTime);
        this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, currentTime);
        this.gainNode.gain.linearRampToValueAtTime(0, currentTime + fadeTime);
      }
    });

    // React to settings loading - apply default visualization once
    effect((): void => {
      const isLoaded: boolean = this.settings.isLoaded();
      const defaultType: string = this.settings.defaultVisualization();

      if (isLoaded && !this.defaultVisualizationApplied) {
        this.defaultVisualizationApplied = true;
        this.setVisualization(defaultType, false); // Don't persist on initial load
      }
    });

    // React to menu visualization selection
    effect((): void => {
      const vizId: string = this.electron.menuSelectVisualization();
      if (vizId && VISUALIZATION_TYPES.includes(vizId)) {
        // Clear the signal first to prevent re-triggering
        this.electron.menuSelectVisualization.set('');
        this.setVisualization(vizId);
      }
    });

    // React to per-visualization settings changes
    effect((): void => {
      // Watch the per-visualization settings and current visualization type
      const _perViz: PerVisualizationSettings = this.settings.perVisualizationSettings();
      const vizType: string = this.visualizationType();

      if (this.visualization) {
        this.applyVisualizationSettings(vizType);
      }
    });

    // React to FFT size setting changes (global setting)
    effect((): void => {
      const fftSize: number = this.settings.fftSize();

      if (this.visualization) {
        this.visualization.setFftSize(fftSize);
      }
    });

    // React to fullscreen transition start - pause rendering to reduce GPU spike
    effect((): void => {
      const _transitionCount: number = this.electron.fullscreenTransitionStart();
      // Only pause if we've received at least one transition event (count > 0)
      if (_transitionCount > 0) {
        this.renderingPaused = true;
      }
    });

    // React to fullscreen transition end - resume rendering
    effect((): void => {
      const _transitionCount: number = this.electron.fullscreenTransitionEnd();
      // Only resume if we've received at least one transition event (count > 0)
      if (_transitionCount > 0) {
        this.renderingPaused = false;
      }
    });
  }

  /**
   * Applies all per-visualization settings to the current visualization.
   *
   * @param vizId - The visualization type ID
   */
  private applyVisualizationSettings(vizId: string): void {
    if (!this.visualization) return;

    // Get effective settings for this visualization (custom or defaults)
    const sensitivity: number = this.settings.getEffectiveSetting(vizId, 'sensitivity') ?? 0.5;
    const barDensity: 'low' | 'medium' | 'high' = this.settings.getEffectiveSetting(vizId, 'barDensity') ?? 'medium';
    const trailIntensity: number = this.settings.getEffectiveSetting(vizId, 'trailIntensity') ?? 0.5;
    const lineWidth: number = this.settings.getEffectiveSetting(vizId, 'lineWidth') ?? 2.0;
    const glowIntensity: number = this.settings.getEffectiveSetting(vizId, 'glowIntensity') ?? 0.5;
    const waveformSmoothing: number = this.settings.getEffectiveSetting(vizId, 'waveformSmoothing') ?? 0.5;
    const barColorBottom: string = this.settings.getEffectiveSetting(vizId, 'barColorBottom') as string ?? '#00cc00';
    const barColorMiddle: string = this.settings.getEffectiveSetting(vizId, 'barColorMiddle') as string ?? '#cccc00';
    const barColorTop: string = this.settings.getEffectiveSetting(vizId, 'barColorTop') as string ?? '#cc0000';
    const strobeFrequency: number = this.settings.getEffectiveSetting(vizId, 'strobeFrequency') ?? 5;

    // Apply settings
    this.visualization.setSensitivity(sensitivity);
    this.visualization.setBarDensity(barDensity);
    this.visualization.setTrailIntensity(trailIntensity);
    this.visualization.setLineWidth(lineWidth);
    this.visualization.setGlowIntensity(glowIntensity);
    this.visualization.setWaveformSmoothing(waveformSmoothing);
    this.visualization.setBarColorBottom(barColorBottom);
    this.visualization.setBarColorMiddle(barColorMiddle);
    this.visualization.setBarColorTop(barColorTop);
    this.visualization.setStrobeFrequency(strobeFrequency);
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

    // Listen for when audio actually starts playing and notify server
    // This allows the server to start time tracking at the right moment
    const audio: HTMLAudioElement | undefined = this.audioRef?.nativeElement;
    if (audio) {
      this.onAudioPlaying = (): void => {
        void this.electron.signalPlaybackStarted();
      };
      audio.addEventListener('playing', this.onAudioPlaying);
    }
  }

  /** Handler for audio 'playing' event - stored for cleanup */
  private onAudioPlaying: (() => void) | null = null;

  /**
   * Cleanup when component is destroyed.
   *
   * Stops animation loop, destroys visualization, and closes audio context.
   */
  public ngOnDestroy(): void {
    if (this.fadeTimeoutId !== null) {
      clearTimeout(this.fadeTimeoutId);
      this.fadeTimeoutId = null;
    }
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    this.visualization?.destroy();
    if (this.audioContext) {
      this.audioContext.close();
    }
    if (this.gestureHandler) {
      document.removeEventListener('click', this.gestureHandler);
      document.removeEventListener('keydown', this.gestureHandler);
      this.gestureHandler = null;
    }
    // Clean up audio playing event listener
    if (this.onAudioPlaying) {
      const audio: HTMLAudioElement | undefined = this.audioRef?.nativeElement;
      audio?.removeEventListener('playing', this.onAudioPlaying);
      this.onAudioPlaying = null;
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
   * Validates dragged files and shows appropriate visual feedback.
   */
  public onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const hasValid: boolean = this.fileDrop.hasValidFiles(event);
    this.isDragOver.set(hasValid);
    this.isDragInvalid.set(!hasValid);

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = hasValid ? 'copy' : 'none';
    }
  }

  /**
   * Handles dragleave to reset visual feedback.
   */
  public onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
    this.isDragInvalid.set(false);
  }

  /**
   * Handles file drop to add media to playlist with smart auto-play.
   *
   * Uses unified auto-play behavior:
   * - Single file: plays immediately
   * - Multiple files + empty playlist: plays from beginning
   * - Multiple files + existing playlist: appends without interrupting
   */
  public async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
    this.isDragInvalid.set(false);

    const filePaths: string[] = this.fileDrop.extractMediaFilePaths(event);
    if (filePaths.length === 0) return;

    await this.electron.addFilesWithAutoPlay(filePaths);
  }

  // ============================================================================
  // Audio Loading
  // ============================================================================

  /**
   * Loads a new audio source from the media server.
   *
   * Initializes the audio context if needed (after user gesture),
   * sets the audio element source, and triggers loading.
   * All formats (including MIDI, which is pre-rendered server-side)
   * are served with HTTP range request support for native seeking.
   *
   * @param filePath - Absolute path to the audio file
   */
  private async loadAudioSource(filePath: string): Promise<void> {
    const audio: HTMLAudioElement = this.audioRef.nativeElement;
    const serverUrl: string = this.mediaPlayer.serverUrl();

    if (!serverUrl) return;

    this.currentFilePath = filePath;

    // Build the stream URL with cache-buster to force fresh fetch after soundfont change
    const cacheBuster: number = this.electron.forceReloadCounter();
    const url: string = `${serverUrl}/media/stream?path=${encodeURIComponent(filePath)}&r=${cacheBuster}`;

    // Initialize audio context if needed (must be after user gesture)
    if (!this.isInitialized) {
      this.initAudioContext();
    }

    // Set the source and load
    audio.src = url;
    audio.load();

    console.log(`Audio source loaded: ${filePath}`);

    // For audio files, the server stays in 'loading' state until we signal playback started.
    // Start playback immediately so the 'playing' event fires and triggers the state transition.
    // Also handle 'playing' state for cases like cached MIDI or video files.
    const state: string = this.mediaPlayer.playbackState();
    if (state === 'loading' || state === 'playing') {
      this.resumeAudioContext();
      this.fadeToVolume(this.mediaPlayer.muted() ? 0 : this.mediaPlayer.volume());
      audio.play().catch(console.error);
    }
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

    // Execute callback after fade completes.
    // Cancel any previously pending callback first — this prevents a stale
    // pause/stop from firing after a rapid state transition (e.g. paused→playing
    // within the crossfade window).
    if (this.fadeTimeoutId !== null) {
      clearTimeout(this.fadeTimeoutId);
      this.fadeTimeoutId = null;
    }

    if (callback) {
      this.fadeTimeoutId = setTimeout((): void => {
        this.fadeTimeoutId = null;
        callback();
      }, crossfadeDuration);
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
      this.gestureHandler = null;
    };
    this.gestureHandler = initOnGesture;
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
  /**
   * Sets the visualization type and optionally persists to config.
   *
   * @param type - The visualization type to activate
   * @param persist - Whether to persist the change to config (default: true)
   */
  public setVisualization(type: string, persist: boolean = true): void {
    this.visualizationType.set(type);

    // Persist to config so it survives component recreation (e.g., miniplayer toggle)
    if (persist) {
      void this.settings.setDefaultVisualization(type);
    }

    // Always update name signals from metadata (even before analyser is ready)
    const metadata: {name: string; category: string} = VISUALIZATION_METADATA[type];
    this.visualizationNameSignal.set(metadata.name);
    this.visualizationCategorySignal.set(metadata.category);
    this.visualizationChange.emit(`${metadata.category} : ${metadata.name}`);

    if (this.visualization) {
      this.visualization.destroy();
    }

    if (this.analyser) {
      this.visualization = createVisualization(type, {
        canvas: this.canvasRef.nativeElement,
        analyser: this.analyser
      });
      this.visualization.setPlaying(this.mediaPlayer.playbackState() === 'playing');
      this.visualization.setFftSize(this.settings.fftSize());
      this.applyVisualizationSettings(type);

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

    const vizType: string = this.visualizationType();
    this.visualization = createVisualization(vizType, {
      canvas: this.canvasRef.nativeElement,
      analyser: this.analyser
    });
    this.visualizationNameSignal.set(this.visualization.name);
    this.visualizationCategorySignal.set(this.visualization.category);
    this.visualizationChange.emit(`${this.visualization.category} : ${this.visualization.name}`);
    this.visualization.setPlaying(this.mediaPlayer.playbackState() === 'playing');
    this.visualization.setFftSize(this.settings.fftSize());
    this.applyVisualizationSettings(vizType);

    const rect: DOMRect = this.canvasRef.nativeElement.getBoundingClientRect();
    this.visualization.resize(Math.round(rect.width), Math.round(rect.height));
  }

  /**
   * Starts the animation loop for continuous visualization rendering.
   *
   * Uses requestAnimationFrame for smooth rendering. The loop handles
   * canvas resizing and delegates drawing to the visualization.
   * Frame rate can be limited via settings (0 = uncapped, or 15/30/60 FPS).
   * Rendering is paused during fullscreen transitions to reduce GPU spike.
   */
  private startAnimationLoop(): void {
    const canvas: HTMLCanvasElement = this.canvasRef.nativeElement;

    const draw: (timestamp: number) => void = (timestamp: number): void => {
      this.animationId = requestAnimationFrame(draw);

      // Skip rendering during fullscreen transition to reduce GPU spike
      if (this.renderingPaused) {
        return;
      }

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

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

import {Component, ElementRef, ViewChild, OnInit, OnDestroy, inject, computed, signal, effect, untracked, HostBinding, ChangeDetectionStrategy, Output, EventEmitter} from '@angular/core';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import {SettingsService, PerVisualizationSettings, RenderResolution, CrossfadeStyle, CROSSFADE_STYLES} from '../../../services/settings.service';
import {FileDropService} from '../../../services/file-drop.service';
import type {PlaylistItem} from '../../../types/electron';
import {Visualization, createVisualization, VISUALIZATION_TYPES, VISUALIZATION_METADATA} from './visualizations';
import {createEqualizerFilters, applyEqualizerGains} from '../../../services/equalizer';

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

  /** Emits the current visualization type when it changes */
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

  /** Equalizer band filters inserted between the source and the analyser */
  private equalizerFilters: BiquadFilterNode[] | null = null;

  /** Animation frame ID for the visualization loop */
  private animationId: number | null = null;

  /** Observer that keeps the cached canvas display size current. */
  private canvasResizeObserver: ResizeObserver | null = null;

  /**
   * Canvas display size in CSS pixels, refreshed by canvasResizeObserver.
   *
   * Cached so the draw loop never has to force a layout read; see observeCanvasSize.
   */
  private displayWidth: number = 0;
  private displayHeight: number = 0;

  /** Whether the loop has parked because the visualization has nothing to render. */
  private renderIdle: boolean = false;

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

  /** Offscreen buffer the active visualization renders into (composited to the visible canvas) */
  private vizCanvas: HTMLCanvasElement | null = null;

  /** 2D context of the visible canvas, used to composite visualization buffers */
  private compositeCtx: CanvasRenderingContext2D | null = null;

  /** Outgoing visualization kept alive during a crossfade (null when not crossfading) */
  private outgoingVisualization: Visualization | null = null;

  /** Offscreen buffer the outgoing visualization renders into during a crossfade */
  private outgoingVizCanvas: HTMLCanvasElement | null = null;

  /** Whether a visualization crossfade is currently in progress */
  private isCrossfading: boolean = false;

  /** Wall-clock timestamp (performance.now) at which the current crossfade began */
  private crossfadeStartTime: number = 0;

  /** Duration (ms) of the in-progress crossfade, captured from settings when it begins */
  private crossfadeDurationMs: number = 1000;

  /**
   * Concrete style of the in-progress crossfade, captured when it begins.
   * A configured style of 'random' is resolved to a concrete style here so it
   * stays fixed for the duration of the transition.
   */
  private activeCrossfadeStyle: CrossfadeStyle = 'fade';

  /** Scale the outgoing visualization expands to during a 'zoom' transition. */
  private readonly ZOOM_EXPAND_SCALE: number = 3;

  /** Scale the incoming visualization starts at during a 'shrink' transition. */
  private readonly SHRINK_START_SCALE: number = 3;

  /** Maximum blur radius (px) applied at the peak of a 'blur' transition. */
  private readonly BLUR_MAX_PX: number = 24;

  /** Signal for the current visualization type */
  private readonly visualizationType: ReturnType<typeof signal<string>> = signal<string>('bars');

  /** Signal for the visualization display name */
  private readonly visualizationNameSignal: ReturnType<typeof signal<string>> = signal<string>('Frequency Bars');

  /** Signal for the visualization category */
  private readonly visualizationCategorySignal: ReturnType<typeof signal<string>> = signal<string>('Bars');

  /** File path of currently loaded audio (for change detection) */
  private currentFilePath: string | null = null;

  /** Path of the last successfully loaded audio (state reached 'playing') */
  private lastSuccessfullyLoadedPath: string | null = null;

  /** Playback state that preceded the current 'loading' transition */
  private stateBeforeLoading: string = 'idle';

  /** Whether the current source is a remote URL streamed through FFmpeg */
  private isRemoteStream: boolean = false;

  /** Media time at which the current remote stream starts (seek offset) */
  private streamSeekOffset: number = 0;

  /** Whether a remote stream reload (seek) is in flight */
  private streamSeekPending: boolean = false;

  /** Timestamp of the last remote stream seek (for debouncing) */
  private lastStreamSeekAt: number = 0;

  /** Timestamp when the current audio source was loaded */
  private mediaLoadedAt: number = 0;

  /** Timestamp of the last clock sync sent to the server (for throttling) */
  private lastSyncSentAt: number = 0;

  /** Minimum drift (seconds) between element and server clock before syncing */
  private readonly syncDriftThreshold: number = 0.75;

  /** Minimum interval (ms) between clock syncs */
  private readonly syncThrottleMs: number = 1000;

  /** Settle time (ms) after a load or seek before clock syncs resume */
  private readonly syncSettleMs: number = 2000;

  /** Grace period (ms) after a user seek during which stall holds are skipped */
  private readonly stallSeekGraceMs: number = 500;

  /**
   * Window (ms) after a source (re)load during which server-time corrections
   * are ignored — the time signal may still hold the previous track's
   * position until the server broadcasts the new track's reset.
   */
  private readonly postLoadGuardMs: number = 500;

  /** Interval holding the server clock at the element position while stalled */
  private stallSyncInterval: ReturnType<typeof setInterval> | null = null;

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
    // Keep the equalizer chain in sync with settings (audio + MIDI sources)
    effect((): void => {
      const enabled: boolean = this.settings.equalizerEnabled();
      const bands: readonly number[] = this.settings.equalizerBands();
      if (this.equalizerFilters) {
        applyEqualizerGains(this.equalizerFilters, bands, enabled);
      }
    });

    // React to track changes - load new audio source.
    // Also depends on playbackState to detect same-track re-selection:
    // when the server enters 'loading', currentFilePath is always cleared
    // so the same file gets reloaded on re-selection.
    // Also watches forceReloadCounter for soundfont changes that require re-render.
    effect((): void => {
      const track: PlaylistItem | null = this.mediaPlayer.currentTrack();
      const state: string = this.mediaPlayer.playbackState();
      const forceReload: number = this.electron.forceReloadCounter();

      // Track when we successfully loaded this file (state reached 'playing')
      // so re-loading the same file can resume at the server position
      if (state === 'playing' && this.currentFilePath) {
        this.lastSuccessfullyLoadedPath = this.currentFilePath;
      }

      // Remember the state that preceded a 'loading' transition. This
      // distinguishes resuming after a stop (stopped → loading) from a
      // restart or re-selection (playing → loading), which must start at 0.
      if (state !== 'loading') {
        this.stateBeforeLoading = state;
      }

      // Clear cached path on loading or force reload (soundfont change)
      if (state === 'loading' || forceReload > 0) {
        this.currentFilePath = null;
      }

      if (track?.type === 'audio' && track.filePath !== this.currentFilePath) {
        // Resume after stop: replaying the same track when the state before
        // 'loading' was 'stopped' resumes at the server position — the user
        // may have dragged the seek bar while stopped before pressing play
        // (the server keeps that position on play). All other loads start
        // from 0 (the server resets its clock for those flows).
        const isStopResume: boolean = state === 'loading'
          && this.stateBeforeLoading === 'stopped'
          && track.filePath === this.lastSuccessfullyLoadedPath;
        const resumeTime: number = isStopResume
          ? untracked((): number => this.mediaPlayer.currentTime())
          : 0;
        void this.loadAudioSource(track.filePath, resumeTime);
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
    // Local formats (including pre-rendered MIDI) support range requests, so
    // native audio.currentTime seeking works. Remote streams are chunked and
    // non-seekable — those are reloaded at the target position instead.
    // The `audio.seeking` guard prevents re-triggering seeks while a seek is
    // in progress (audio.currentTime hasn't updated yet, causing drift detection
    // to fire repeatedly and create a seek loop).
    effect((): void => {
      const time: number = this.mediaPlayer.currentTime();
      const audio: HTMLAudioElement | undefined = this.audioRef?.nativeElement;
      if (!audio || !audio.src || audio.seeking) return;

      // Don't reposition the element while a stop/pause crossfade is still
      // playing it out (state already left 'playing' but the element hasn't
      // been paused yet). Seeking it now — e.g. to 0 on stop — audibly
      // replays the start of the track for the remainder of the fade. Once
      // the fade pauses the element, corrections apply again (silently).
      if (!this.mediaPlayer.isPlaying() && !audio.paused) return;

      // Ignore corrections just after a (re)load: the time signal may still
      // hold the PREVIOUS track's position until the server broadcasts the
      // new track's reset (e.g. switching from a video at 15s to an audio
      // file must not seek the fresh audio element to 15s).
      if (Date.now() - this.mediaLoadedAt < this.postLoadGuardMs) return;

      if (this.isRemoteStream) {
        const actualTime: number = this.streamSeekOffset + audio.currentTime;
        const now: number = Date.now();
        if (Math.abs(actualTime - time) > 2 && !this.streamSeekPending && now - this.lastStreamSeekAt > 1000 && this.currentFilePath) {
          this.streamSeekPending = true;
          this.lastStreamSeekAt = now;
          this.reloadRemoteStream(this.currentFilePath, time);
        }
      } else if (Math.abs(audio.currentTime - time) > 1) {
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
    // Must precede initVisualization: that sizes the visualization from the
    // cached display size, so the cache has to be seeded first.
    this.observeCanvasSize(this.canvasRef.nativeElement);
    this.initVisualization();
    this.startAnimationLoop();

    // Listen for when audio actually starts playing and notify server
    // This allows the server to start time tracking at the right moment
    const audio: HTMLAudioElement | undefined = this.audioRef?.nativeElement;
    if (audio) {
      this.onAudioPlaying = (): void => {
        this.stopStallClockHold();
        // Playback has (re)started — drop the waiting cursor
        this.electron.setStreamingBusy(false);
        // Remote stream seek completed — anchor the server clock to the
        // actual stream position (FFmpeg startup time passed while loading)
        if (this.streamSeekPending) {
          this.streamSeekPending = false;
          this.lastStreamSeekAt = Date.now();
          this.electron.syncPlaybackTime(this.streamSeekOffset + audio.currentTime);
        }
        void this.electron.signalPlaybackStarted();
      };
      audio.addEventListener('playing', this.onAudioPlaying);

      // Keep the server clock anchored to the element's real position
      this.onAudioTimeUpdate = (): void => {
        this.maybeSyncServerClock(audio);
      };
      audio.addEventListener('timeupdate', this.onAudioTimeUpdate);

      // While the element stalls to buffer (mainly remote streams), hold the
      // server clock at the element's position until playback resumes
      this.onAudioWaiting = (): void => {
        this.startStallClockHold();
      };
      audio.addEventListener('waiting', this.onAudioWaiting);
    }
  }

  /** Handler for audio 'playing' event - stored for cleanup */
  private onAudioPlaying: (() => void) | null = null;

  /** Handler for audio 'timeupdate' event - stored for cleanup */
  private onAudioTimeUpdate: (() => void) | null = null;

  /** Handler for audio 'waiting' event - stored for cleanup */
  private onAudioWaiting: (() => void) | null = null;

  /**
   * One-shot 'canplay' handler that positions a newly loaded track, tracked so
   * a load can retire the previous track's pending resume. See armPendingSeek.
   */
  private pendingSeekHandler: (() => void) | null = null;

  /**
   * Positions the element at `seekTime` as soon as the new source can play.
   *
   * Tracked in a field rather than left as an anonymous listener: a listener
   * that only unregisters when it fires outlives a track replaced before it
   * ever reaches 'canplay' — skipping quickly through a playlist — and then
   * applies the dead track's resume position to whatever loads next. Callers
   * must clearPendingSeek before every load, including loads that need no
   * seek of their own.
   *
   * @param audio - The audio element being loaded
   * @param seekTime - Absolute media time to position at
   */
  private armPendingSeek(audio: HTMLAudioElement, seekTime: number): void {
    this.clearPendingSeek(audio);

    this.pendingSeekHandler = (): void => {
      this.pendingSeekHandler = null;
      audio.currentTime = seekTime;
    };

    audio.addEventListener('canplay', this.pendingSeekHandler, {once: true});
  }

  /**
   * Retires a resume still waiting on a previous track's 'canplay'.
   *
   * @param audio - The audio element to detach from
   */
  private clearPendingSeek(audio: HTMLAudioElement): void {
    if (!this.pendingSeekHandler) return;
    audio.removeEventListener('canplay', this.pendingSeekHandler);
    this.pendingSeekHandler = null;
  }

  /**
   * Starts periodically anchoring the server clock to the element's current
   * position while the element is stalled buffering. Skips ticks in a short
   * grace window after a user seek so a stale element position can never
   * cancel the seek target.
   */
  private startStallClockHold(): void {
    if (this.stallSyncInterval !== null) return;

    const audio: HTMLAudioElement = this.audioRef.nativeElement;
    const holdClock: () => void = (): void => {
      if (!this.mediaPlayer.isPlaying()) return;
      if (Date.now() - this.electron.lastSeekAt < this.stallSeekGraceMs) return;
      // Never report a freshly (re)loaded element — its position may not
      // reflect the new track yet (the server ignores such syncs too)
      if (Date.now() - this.mediaLoadedAt < this.syncSettleMs) return;
      const actualTime: number = (this.isRemoteStream ? this.streamSeekOffset : 0) + audio.currentTime;
      this.electron.syncPlaybackTime(actualTime);
    };

    holdClock();
    this.stallSyncInterval = setInterval(holdClock, this.syncThrottleMs);
  }

  /**
   * Stops the stall clock hold once the element is playing again.
   */
  private stopStallClockHold(): void {
    if (this.stallSyncInterval !== null) {
      clearInterval(this.stallSyncInterval);
      this.stallSyncInterval = null;
    }
  }

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
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.canvasResizeObserver) {
      this.canvasResizeObserver.disconnect();
      this.canvasResizeObserver = null;
    }
    this.outgoingVisualization?.destroy();
    this.visualization?.destroy();
    if (this.audioContext) {
      // Rejects if the context is already closed, which teardown ordering can
      // easily produce; nothing here can act on it, so it is swallowed rather
      // than left to surface as an unhandled rejection. Matches VideoOutlet.
      void this.audioContext.close().catch((): void => {});
    }
    if (this.gestureHandler) {
      document.removeEventListener('click', this.gestureHandler);
      document.removeEventListener('keydown', this.gestureHandler);
      this.gestureHandler = null;
    }
    // Clean up any resume still waiting on 'canplay'
    if (this.pendingSeekHandler) {
      const audio: HTMLAudioElement | undefined = this.audioRef?.nativeElement;
      audio?.removeEventListener('canplay', this.pendingSeekHandler);
      this.pendingSeekHandler = null;
    }

    // Clean up audio playing event listener
    if (this.onAudioPlaying) {
      const audio: HTMLAudioElement | undefined = this.audioRef?.nativeElement;
      audio?.removeEventListener('playing', this.onAudioPlaying);
      this.onAudioPlaying = null;
    }
    // Clean up audio timeupdate event listener
    if (this.onAudioTimeUpdate) {
      const audio: HTMLAudioElement | undefined = this.audioRef?.nativeElement;
      audio?.removeEventListener('timeupdate', this.onAudioTimeUpdate);
      this.onAudioTimeUpdate = null;
    }
    // Clean up audio waiting event listener and any active stall hold
    if (this.onAudioWaiting) {
      const audio: HTMLAudioElement | undefined = this.audioRef?.nativeElement;
      audio?.removeEventListener('waiting', this.onAudioWaiting);
      this.onAudioWaiting = null;
    }
    this.stopStallClockHold();
    this.electron.setStreamingBusy(false);
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
   * @param resumeTime - Position (seconds) to start playback from; non-zero
   *   when resuming the same track after a stop-seek (see track effect)
   */
  private async loadAudioSource(filePath: string, resumeTime: number = 0): Promise<void> {
    const audio: HTMLAudioElement = this.audioRef.nativeElement;
    const serverUrl: string = this.mediaPlayer.serverUrl();

    if (!serverUrl) return;

    this.currentFilePath = filePath;
    this.isRemoteStream = /^https?:\/\//i.test(filePath);
    this.streamSeekOffset = 0;
    this.streamSeekPending = false;
    this.mediaLoadedAt = Date.now();

    // Remote streams take a while to spin up (yt-dlp URL fetch + FFmpeg) —
    // show the waiting cursor until the element starts playing
    if (this.isRemoteStream) {
      this.electron.setStreamingBusy(true);
    }

    // Build the stream URL with cache-buster to force fresh fetch after soundfont change
    const cacheBuster: number = this.electron.forceReloadCounter();
    let url: string = `${serverUrl}/media/stream?path=${encodeURIComponent(filePath)}&r=${cacheBuster}`;

    // Remote streams are non-seekable — bake the resume position into the
    // stream request instead of seeking the element
    if (this.isRemoteStream && resumeTime > 0) {
      this.streamSeekOffset = resumeTime;
      url += `&t=${resumeTime}`;
    }

    // Initialize audio context if needed (must be after user gesture)
    if (!this.isInitialized) {
      this.initAudioContext();
    }

    // Set the source and load
    audio.src = this.electron.appendAuth(url);
    audio.load();

    // For local formats, position the element once it can play (HTTP range
    // requests make this instant). Cleared unconditionally first so a resume
    // armed for the track this one replaces cannot fire against it.
    this.clearPendingSeek(audio);
    if (!this.isRemoteStream && resumeTime > 0) {
      this.armPendingSeek(audio, resumeTime);
    }

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

  /**
   * Reloads a remote (streamed) audio source at a new position.
   *
   * Remote streams are transcoded on-the-fly into a chunked, non-seekable
   * response, so seeking is done by requesting a new stream with a 't'
   * offset — the same approach the video outlet uses for transcoded video.
   *
   * @param filePath - The remote media URL
   * @param seekTime - Target position in seconds
   */
  private reloadRemoteStream(filePath: string, seekTime: number): void {
    const audio: HTMLAudioElement = this.audioRef.nativeElement;
    // Use untracked() so URL inputs aren't tracked by the calling seek effect
    const serverUrl: string = untracked((): string => this.mediaPlayer.serverUrl());
    const cacheBuster: number = untracked((): number => this.electron.forceReloadCounter());

    if (!serverUrl) {
      this.streamSeekPending = false;
      return;
    }

    this.streamSeekOffset = seekTime;
    this.mediaLoadedAt = Date.now();
    // Waiting cursor while the stream pipeline restarts for the seek
    this.electron.setStreamingBusy(true);
    audio.src = this.electron.appendAuth(`${serverUrl}/media/stream?path=${encodeURIComponent(filePath)}&r=${cacheBuster}&t=${seekTime}`);
    audio.load();

    console.log(`Seeking remote audio stream to ${seekTime}s`);

    if (untracked((): boolean => this.mediaPlayer.isPlaying())) {
      audio.play().catch(console.error);
    }
  }

  /**
   * Reports the audio element's actual playback position to the server when
   * it has drifted from the server's wall-clock time.
   *
   * Drift happens when the element stalls to buffer (mainly remote streams)
   * while the server clock keeps running, pushing the seek bar ahead of the
   * audible content. Anchoring the clock to the element keeps them in sync.
   *
   * Syncs are suppressed while the element is settling after a load or a
   * seek, so a stale element position never cancels a user's seek.
   *
   * @param audio - The audio element to read the position from
   */
  private maybeSyncServerClock(audio: Readonly<HTMLAudioElement>): void {
    if (!this.mediaPlayer.isPlaying()) return;
    if (audio.paused || audio.seeking || this.streamSeekPending) return;
    if (audio.readyState < 3) return;

    const now: number = Date.now();
    if (now - this.lastSyncSentAt < this.syncThrottleMs) return;
    if (now - this.mediaLoadedAt < this.syncSettleMs) return;
    if (now - this.lastStreamSeekAt < this.syncSettleMs) return;
    if (now - this.electron.lastSeekAt < this.syncSettleMs) return;

    const actualTime: number = (this.isRemoteStream ? this.streamSeekOffset : 0) + audio.currentTime;
    const drift: number = actualTime - this.mediaPlayer.currentTime();

    if (Math.abs(drift) > this.syncDriftThreshold) {
      this.lastSyncSentAt = now;
      this.electron.syncPlaybackTime(actualTime);
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

    // Build the equalizer chain (applied to all audio sources)
    this.equalizerFilters = createEqualizerFilters(this.audioContext);
    applyEqualizerGains(this.equalizerFilters, this.settings.equalizerBands(), this.settings.equalizerEnabled());

    // Connect: source → equalizer → analyser → gainNode → destination
    // The analyser (and thus the visualizer) reflects the equalized signal;
    // the gain node still sees full signal regardless of volume.
    this.sourceNode = this.audioContext.createMediaElementSource(audio);
    this.sourceNode.connect(this.equalizerFilters[0]);
    this.equalizerFilters[this.equalizerFilters.length - 1].connect(this.analyser);
    this.analyser.connect(this.gainNode);
    this.gainNode.connect(this.audioContext.destination);

    this.isInitialized = true;

    // Initialize visualization now that analyser is available.
    // initVisualization() tears down any existing visualization and crossfade.
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
    this.visualizationChange.emit(type);

    // Without an analyser there is nothing rendering yet; the visualization
    // will be built by initVisualization() once the analyser is available.
    if (!this.analyser) {
      return;
    }

    // Capture the currently-rendering visualization so it can fade out while
    // the new one fades in. Each visualization owns its own offscreen buffer,
    // which the animation loop composites onto the visible canvas.
    const outgoing: Visualization | null = this.visualization;
    const outgoingCanvas: HTMLCanvasElement | null = this.vizCanvas;

    const canvas: HTMLCanvasElement = this.createVizCanvas();
    this.visualization = createVisualization(type, {canvas, analyser: this.analyser});
    this.vizCanvas = canvas;
    this.visualization.setPlaying(this.mediaPlayer.playbackState() === 'playing');
    this.visualization.setFftSize(this.settings.fftSize());
    this.applyVisualizationSettings(type);
    this.applyRenderSize();

    if (outgoing && outgoingCanvas) {
      // A switch mid-crossfade: drop the older outgoing visualization and
      // crossfade from the one that was most recently on screen.
      this.outgoingVisualization?.destroy();
      this.outgoingVisualization = outgoing;
      this.outgoingVizCanvas = outgoingCanvas;
      this.isCrossfading = true;
      this.crossfadeStartTime = performance.now();
      this.crossfadeDurationMs = this.settings.visualizationCrossfadeDuration();
      this.activeCrossfadeStyle = this.resolveCrossfadeStyle(this.settings.visualizationCrossfadeStyle());
    } else {
      // Nothing was on screen (e.g. first activation): show the new one instantly.
      outgoing?.destroy();
    }
  }

  /**
   * Creates an offscreen canvas for a visualization to render into.
   *
   * Each visualization renders to its own buffer so that two visualizations
   * can be composited together during a crossfade. The buffer is sized to the
   * current visible-canvas backing store; the animation loop keeps it in sync.
   *
   * @returns A fresh offscreen canvas element
   */
  private createVizCanvas(): HTMLCanvasElement {
    const canvas: HTMLCanvasElement = document.createElement('canvas');
    const visible: HTMLCanvasElement = this.canvasRef.nativeElement;
    canvas.width = Math.max(1, visible.width);
    canvas.height = Math.max(1, visible.height);
    return canvas;
  }

  /**
   * Cancels any in-progress crossfade, destroying the outgoing visualization.
   *
   * Called before an instant (non-crossfaded) visualization swap so a stale
   * outgoing visualization is not left rendering.
   */
  private cancelCrossfade(): void {
    this.outgoingVisualization?.destroy();
    this.outgoingVisualization = null;
    this.outgoingVizCanvas = null;
    this.isCrossfading = false;
  }

  /**
   * Initializes the current visualization.
   *
   * Called during component initialization and when the analyser
   * becomes available. Creates the visualization and sets initial size.
   */
  private initVisualization(): void {
    if (!this.analyser) return;

    // Instant (non-crossfaded) activation: tear down any active crossfade and
    // the previous visualization, then build the new one on a fresh buffer.
    this.cancelCrossfade();
    this.visualization?.destroy();

    const vizType: string = this.visualizationType();
    const canvas: HTMLCanvasElement = this.createVizCanvas();
    this.visualization = createVisualization(vizType, {canvas, analyser: this.analyser});
    this.vizCanvas = canvas;
    this.visualizationNameSignal.set(this.visualization.name);
    this.visualizationCategorySignal.set(this.visualization.category);
    this.visualizationChange.emit(`${this.visualization.category} : ${this.visualization.name}`);
    this.visualization.setPlaying(this.mediaPlayer.playbackState() === 'playing');
    this.visualization.setFftSize(this.settings.fftSize());
    this.applyVisualizationSettings(vizType);
    this.applyRenderSize();
  }

  /**
   * Computes the visualization's target backing-store size for the current
   * render-resolution setting.
   *
   * 'native' tracks the canvas's displayed pixel size, read from the cache that
   * observeCanvasSize maintains. A fixed resolution returns that exact size, so
   * the smaller backing store is stretched by CSS to fill the screen with
   * nearest-neighbour scaling (pixelated, no blending).
   *
   * @returns The target width/height and whether pixelated scaling applies
   */
  private getRenderSize(): {width: number; height: number; pixelated: boolean} {
    const resolution: RenderResolution = this.settings.renderResolution();
    if (resolution !== 'native' && !this.visualization?.rendersAtNativeResolution) {
      const separator: number = resolution.indexOf('x');
      const width: number = parseInt(resolution.slice(0, separator), 10);
      const height: number = parseInt(resolution.slice(separator + 1), 10);
      if (width > 0 && height > 0) {
        return {width, height, pixelated: true};
      }
    }
    return {width: this.displayWidth, height: this.displayHeight, pixelated: false};
  }

  /**
   * Tracks the canvas's display size, caching it for the draw loop.
   *
   * The loop needs the canvas's laid-out size every frame to keep the
   * backing store in sync, but reading it there means a synchronous layout
   * measurement per frame — and a forced reflow whenever something else has
   * dirtied layout, such as the controls fading in and out over the
   * visualization. A ResizeObserver moves that read onto the rare occasions
   * the size actually changes.
   *
   * The measurement is still getBoundingClientRect so the cached values match
   * what the loop used to compute; the observer only controls when it runs.
   *
   * @param canvas - The visualization canvas to observe
   */
  private observeCanvasSize(canvas: HTMLCanvasElement): void {
    const measure: () => void = (): void => {
      const rect: DOMRect = canvas.getBoundingClientRect();
      this.displayWidth = Math.round(rect.width);
      this.displayHeight = Math.round(rect.height);
    };

    // Seed synchronously: the observer's first callback does not arrive until
    // after this frame, and the loop may render before then.
    measure();

    this.canvasResizeObserver = new ResizeObserver(measure);
    this.canvasResizeObserver.observe(canvas);
  }

  /**
   * Resizes the current visualization to the configured render size and toggles
   * nearest-neighbour (pixelated) CSS scaling when a fixed resolution is active.
   */
  private applyRenderSize(): void {
    if (!this.visualization) return;
    const canvas: HTMLCanvasElement = this.canvasRef.nativeElement;
    const size: {width: number; height: number; pixelated: boolean} = this.getRenderSize();
    canvas.style.imageRendering = size.pixelated ? 'pixelated' : 'auto';
    this.visualization.resize(size.width, size.height);
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
    this.compositeCtx = canvas.getContext('2d');

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

      // Target backing-store size: the display size ('native') or the fixed
      // render resolution (stretched to fill via CSS with nearest-neighbour).
      const size: {width: number; height: number; pixelated: boolean} = this.getRenderSize();

      // Keep the visible (compositor) canvas sized to the render target.
      if (canvas.width !== size.width || canvas.height !== size.height) {
        canvas.width = size.width;
        canvas.height = size.height;
        canvas.style.imageRendering = size.pixelated ? 'pixelated' : 'auto';
      }

      // Keep the active visualization's offscreen buffer in sync with the size.
      if (this.vizCanvas && (this.vizCanvas.width !== size.width || this.vizCanvas.height !== size.height)) {
        this.visualization?.resize(size.width, size.height);
      }

      // Playback has stopped and the fade has run to completion, so draw() would
      // spend a full frame's work compositing an entirely transparent result.
      // Blank the visible canvas once, then keep ticking without rendering until
      // playback resumes. A crossfade still needs both buffers drawn, so it is
      // never treated as idle.
      if (!this.isCrossfading && this.visualization?.isIdle()) {
        if (!this.renderIdle) {
          this.compositeCtx?.clearRect(0, 0, size.width, size.height);
          this.renderIdle = true;
        }
        return;
      }
      this.renderIdle = false;

      // Render the active visualization into its own offscreen buffer.
      this.visualization?.draw();

      // Composite the offscreen buffer(s) onto the visible canvas, blending the
      // outgoing and incoming visualizations together during a crossfade.
      this.renderComposite(size.width, size.height);
    };

    this.animationId = requestAnimationFrame(draw);
  }

  /**
   * Composites the active visualization's buffer onto the visible canvas.
   *
   * During a crossfade the outgoing visualization keeps animating in its own
   * buffer and the two are combined using the configured transition style.
   * Progress is measured against the wall clock so dropped or rate-limited
   * frames do not distort the transition. Buffers are drawn scaled to fill so a
   * size mismatch (e.g. a native-resolution visualization transitioning with a
   * pixelated one) is handled gracefully.
   *
   * @param width - Visible canvas backing-store width
   * @param height - Visible canvas backing-store height
   */
  private renderComposite(width: number, height: number): void {
    const ctx: CanvasRenderingContext2D | null = this.compositeCtx;
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    if (this.isCrossfading && this.outgoingVizCanvas && this.vizCanvas) {
      const elapsed: number = performance.now() - this.crossfadeStartTime;
      const t: number = Math.min(1, elapsed / this.crossfadeDurationMs);
      const eased: number = t * t * (3 - 2 * t);

      // Keep the outgoing visualization live as it transitions out.
      this.outgoingVisualization?.draw();

      this.drawTransitionFrame(ctx, this.outgoingVizCanvas, this.vizCanvas, width, height, eased);

      if (t >= 1) {
        this.outgoingVisualization?.destroy();
        this.outgoingVisualization = null;
        this.outgoingVizCanvas = null;
        this.isCrossfading = false;
      }
    } else if (this.vizCanvas) {
      ctx.drawImage(this.vizCanvas, 0, 0, width, height);
    }
  }

  /**
   * Draws a single frame of the active transition, combining the outgoing and
   * incoming visualization buffers according to the resolved crossfade style.
   *
   * @param ctx - The visible canvas 2D context to draw onto
   * @param prev - The outgoing visualization's buffer
   * @param cur - The incoming visualization's buffer
   * @param width - Target width
   * @param height - Target height
   * @param progress - Eased transition progress (0 = outgoing, 1 = incoming)
   */
  private drawTransitionFrame(
    ctx: CanvasRenderingContext2D,
    prev: HTMLCanvasElement,
    cur: HTMLCanvasElement,
    width: number,
    height: number,
    progress: number
  ): void {
    switch (this.activeCrossfadeStyle) {
      case 'zoom': {
        // Incoming fades in at full size behind; outgoing expands outwards
        // (scaling about the centre) and fades out on top.
        ctx.save();
        ctx.globalAlpha = progress;
        ctx.drawImage(cur, 0, 0, width, height);
        ctx.restore();

        ctx.save();
        ctx.globalAlpha = 1 - progress;
        const zoomScale: number = 1 + progress * (this.ZOOM_EXPAND_SCALE - 1);
        ctx.translate(width / 2, height / 2);
        ctx.scale(zoomScale, zoomScale);
        ctx.translate(-width / 2, -height / 2);
        ctx.drawImage(prev, 0, 0, width, height);
        ctx.restore();
        break;
      }
      case 'shrink': {
        // Outgoing fades out at full size behind; incoming starts oversized and
        // transparent, shrinking into view (scaling about the centre) while
        // becoming opaque on top.
        ctx.save();
        ctx.globalAlpha = 1 - progress;
        ctx.drawImage(prev, 0, 0, width, height);
        ctx.restore();

        ctx.save();
        ctx.globalAlpha = progress;
        const shrinkScale: number = this.SHRINK_START_SCALE - progress * (this.SHRINK_START_SCALE - 1);
        ctx.translate(width / 2, height / 2);
        ctx.scale(shrinkScale, shrinkScale);
        ctx.translate(-width / 2, -height / 2);
        ctx.drawImage(cur, 0, 0, width, height);
        ctx.restore();
        break;
      }
      case 'blur': {
        // Outgoing progressively blurs and fades out; incoming starts blurred
        // and transparent, sharpening and fading in.
        ctx.save();
        ctx.globalAlpha = 1 - progress;
        ctx.filter = `blur(${(progress * this.BLUR_MAX_PX).toFixed(2)}px)`;
        ctx.drawImage(prev, 0, 0, width, height);
        ctx.restore();

        ctx.save();
        ctx.globalAlpha = progress;
        ctx.filter = `blur(${((1 - progress) * this.BLUR_MAX_PX).toFixed(2)}px)`;
        ctx.drawImage(cur, 0, 0, width, height);
        ctx.restore();
        break;
      }
      case 'fade':
      default: {
        // Classic opacity crossfade: outgoing fades out, incoming fades in.
        ctx.globalAlpha = 1 - progress;
        ctx.drawImage(prev, 0, 0, width, height);
        ctx.globalAlpha = progress;
        ctx.drawImage(cur, 0, 0, width, height);
        ctx.globalAlpha = 1;
        break;
      }
    }
  }

  /**
   * Resolves a configured crossfade style to a concrete one, picking a random
   * concrete style when 'random' is configured.
   *
   * @param style - The configured crossfade style
   * @returns A concrete (non-'random') crossfade style
   */
  private resolveCrossfadeStyle(style: CrossfadeStyle): CrossfadeStyle {
    if (style !== 'random') {
      return style;
    }
    const concrete: CrossfadeStyle[] = CROSSFADE_STYLES.filter(
      (s: CrossfadeStyle): boolean => s !== 'random'
    );
    return concrete[Math.floor(Math.random() * concrete.length)];
  }
}

/**
 * @fileoverview Video outlet component for video playback.
 *
 * This component handles video playback for video media files. It manages
 * the HTML5 video element and synchronizes with the server's playback state.
 *
 * Key features:
 * - Native format support (MP4, WebM, OGG) with direct playback
 * - Transcoded format support (MKV, AVI, MOV) via FFmpeg streaming
 * - HTTP range request support for native formats (efficient seeking)
 * - Re-stream on seek for transcoded formats (required by FFmpeg)
 * - Double-click for fullscreen toggle
 * - Drag-and-drop file support
 *
 * Seeking behavior:
 * - Native formats: Uses HTTP range requests, instant seeking
 * - Transcoded formats: Re-requests stream with seek offset parameter
 *
 * @module app/components/video/video-outlet
 */

import {Component, ElementRef, ViewChild, OnInit, OnDestroy, inject, computed, signal, effect, untracked, output, ChangeDetectionStrategy, OutputEmitterRef, Renderer2} from '@angular/core';
import {DOCUMENT} from '@angular/common';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import {FileDropService} from '../../../services/file-drop.service';
import {SettingsService, VideoAspectMode, VIDEO_ASPECT_OPTIONS, SubtitleFontFamily, PreferredAudioLanguage, PreferredSubtitleLanguage} from '../../../services/settings.service';
import {createEqualizerFilters, applyEqualizerGains} from '../../../services/equalizer';
import {buildVideoFilter} from '../../../services/video-adjustments';
import {SeekSpinner} from './seek-spinner';
import type {PlaylistItem, SubtitleTrack, AudioTrack} from '../../../services/electron.service';

/**
 * Video formats that Chromium can play natively.
 * These formats support HTTP range requests for efficient seeking.
 * Note: Even native containers may need transcoding if audio codec is incompatible.
 */
const NATIVE_VIDEO_FORMATS: Set<string> = new Set(['.mp4', '.m4v', '.webm', '.ogg']);

/**
 * Audio codecs that browsers can decode natively.
 * Files with other audio codecs must be transcoded even if the container is "native".
 * Must match BROWSER_COMPATIBLE_AUDIO_CODECS in unified-media-server.ts.
 */
const BROWSER_COMPATIBLE_AUDIO_CODECS: Set<string> = new Set([
  'aac',       // Advanced Audio Coding - most common
  'mp3',       // MPEG Audio Layer III
  'opus',      // Opus - modern, efficient
  'flac',      // Free Lossless Audio Codec
  'vorbis',    // Ogg Vorbis
  'pcm_s16le', // PCM signed 16-bit little-endian (WAV)
  'pcm_s24le', // PCM signed 24-bit little-endian (WAV)
  'pcm_s32le', // PCM signed 32-bit little-endian (WAV)
  'pcm_f32le', // PCM 32-bit floating-point little-endian
  'alac',      // Apple Lossless - Safari/Chrome support
]);

/**
 * Track index indicating an external subtitle file is selected.
 * Used to distinguish from embedded subtitle tracks (0+) and off (-1).
 */
const EXTERNAL_SUBTITLE_TRACK_INDEX: number = -2;

/**
 * Video flip mode — mirrors the video around the vertical axis (horizontal),
 * the horizontal axis (vertical), both, or neither.
 */
export type VideoFlipMode = 'none' | 'horizontal' | 'vertical' | 'both';

/**
 * A selectable video flip option for the media bar dropdown.
 */
export interface VideoFlipOption {
  /** The flip mode value */
  readonly value: VideoFlipMode;
  /** Human-readable display label */
  readonly label: string;
}

/**
 * Available video flip options for the media bar dropdown.
 */
export const VIDEO_FLIP_OPTIONS: readonly VideoFlipOption[] = [
  {value: 'none', label: 'No Flip'},
  {value: 'horizontal', label: 'Flip Horizontal'},
  {value: 'vertical', label: 'Flip Vertical'},
  {value: 'both', label: 'Flip Both'},
];

/**
 * Represents a parsed WebVTT cue with timing and text content.
 * Used for custom subtitle rendering that bypasses the browser's TextTrack API.
 */
interface ParsedSubtitleCue {
  /** Start time in seconds */
  readonly startTime: number;
  /** End time in seconds */
  readonly endTime: number;
  /** Text content (may contain HTML formatting) */
  readonly text: string;
}

/**
 * Represents a loaded subtitle track with all its parsed cues.
 */
interface LoadedSubtitleTrack {
  /** Track index (matches SubtitleTrack.index) */
  readonly index: number;
  /** All parsed cues for this track */
  readonly cues: readonly ParsedSubtitleCue[];
}

/**
 * Video outlet component for video media playback.
 *
 * This component is displayed when the current media is video (not audio).
 * It manages the HTML5 video element and handles the complexity of
 * playing both native and transcoded video formats.
 *
 * Native formats (MP4, WebM, OGG):
 * - Played directly by the browser
 * - Seeking uses HTTP range requests (instant)
 *
 * Transcoded formats (MKV, AVI, MOV):
 * - Transcoded to MP4 by FFmpeg on the server
 * - Seeking requires re-requesting the stream with a time offset
 * - Slight delay on seek due to transcoding startup
 *
 * @example
 * <!-- In layout-outlet template -->
 * @if (isVideo()) {
 *   <app-video-outlet />
 * }
 */
@Component({
  selector: 'app-video-outlet',
  standalone: true,
  imports: [],
  templateUrl: './video-outlet.html',
  styleUrl: './video-outlet.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VideoOutlet implements OnInit, OnDestroy {
  // ============================================================================
  // View References
  // ============================================================================

  /** Reference to the video element */
  @ViewChild('videoElement', {static: true}) public videoRef!: ElementRef<HTMLVideoElement>;

  /** Canvas that freezes the last frame while a seek reloads the stream */
  @ViewChild('freezeFrame', {static: true}) public freezeFrameRef!: ElementRef<HTMLCanvasElement>;

  /** Canvas hosting the segmented seek-loading spinner animation */
  @ViewChild('seekSpinner', {static: true}) public seekSpinnerRef!: ElementRef<HTMLCanvasElement>;

  // ============================================================================
  // Services
  // ============================================================================

  /** Media player service for playback state */
  public readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);

  /** Electron service for file operations and fullscreen */
  private readonly electron: ElectronService = inject(ElectronService);

  /** File drop service for drag-and-drop handling */
  private readonly fileDrop: FileDropService = inject(FileDropService);

  /** Settings service for video aspect mode and subtitle appearance */
  private readonly settings: SettingsService = inject(SettingsService);

  /** Renderer for DOM manipulation */
  private readonly renderer: Renderer2 = inject(Renderer2);

  /** Document reference for style injection */
  private readonly document: Document = inject(DOCUMENT);

  // ============================================================================
  // Outputs
  // ============================================================================

  /** Emits the current aspect mode display name when it changes */
  public readonly aspectModeChange: OutputEmitterRef<string> = output<string>();

  /** Emits the current flip mode when it changes */
  public readonly flipChange: OutputEmitterRef<VideoFlipMode> = output<VideoFlipMode>();

  // ============================================================================
  // Reactive State
  // ============================================================================

  /** Currently playing track */
  public readonly currentTrack: ReturnType<typeof computed<PlaylistItem | null>> = computed((): PlaylistItem | null => this.mediaPlayer.currentTrack());

  /** Whether files are being dragged over this component (valid files) */
  public readonly isDragOver: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Whether invalid files are being dragged over this component */
  public readonly isDragInvalid: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Current video aspect mode */
  public readonly aspectMode: ReturnType<typeof computed<VideoAspectMode>> = computed(
    (): VideoAspectMode => this.settings.videoAspectMode()
  );

  /**
   * Current video flip mode (none, horizontal, vertical, or both). Session
   * state — resets when a different video is loaded; subtitles are unaffected.
   */
  public readonly flipMode: ReturnType<typeof signal<VideoFlipMode>> = signal<VideoFlipMode>('none');

  /**
   * CSS filter string for real-time video adjustments (brightness, contrast,
   * saturation, hue, etc.), applied to the video element. 'none' when disabled.
   */
  public readonly videoFilter: ReturnType<typeof computed<string>> = computed(
    (): string => buildVideoFilter(this.settings.videoAdjustments(), this.settings.videoAdjustmentsEnabled())
  );

  /** Display name for the current aspect mode */
  public readonly aspectModeName: ReturnType<typeof computed<string>> = computed((): string => {
    const mode: VideoAspectMode = this.aspectMode();
    const option: {value: VideoAspectMode; label: string} | undefined = VIDEO_ASPECT_OPTIONS.find((opt: {value: VideoAspectMode; label: string}): boolean => opt.value === mode);
    return option?.label ?? 'Default';
  });

  /** Subtitle tracks available for the current video */
  public readonly subtitleTracks: ReturnType<typeof computed<readonly SubtitleTrack[]>> = computed(
    (): readonly SubtitleTrack[] => this.electron.currentMedia()?.subtitleTracks ?? []
  );

  /** Currently selected subtitle track index (-1 for off, -2 for external) */
  public readonly selectedSubtitleTrack: ReturnType<typeof signal<number>> = signal<number>(-1);

  /** External subtitle file path (loaded via dialog) */
  public readonly externalSubtitlePath: ReturnType<typeof signal<string | null>> = signal<string | null>(null);

  /** Whether an external subtitle is loaded */
  public readonly hasExternalSubtitle: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.externalSubtitlePath() !== null
  );

  /** Current subtitle text to display (empty string when no subtitle is active) */
  public readonly subtitleText: ReturnType<typeof signal<string>> = signal<string>('');

  /** Sanitized subtitle HTML (allows only safe formatting tags) */
  public readonly sanitizedSubtitleHtml: ReturnType<typeof computed<string>> = computed(
    (): string => this.sanitizeSubtitleHtml(this.subtitleText())
  );

  /** Audio tracks available for the current video (only when multiple exist) */
  public readonly audioTracks: ReturnType<typeof computed<readonly AudioTrack[]>> = computed(
    (): readonly AudioTrack[] => this.electron.currentMedia()?.audioTracks ?? []
  );

  /** Currently selected audio track index (0-based) */
  public readonly selectedAudioTrack: ReturnType<typeof signal<number>> = signal<number>(0);

  /**
   * Whether a seek is reloading the stream. While true, the last frame is
   * shown frozen and dulled with a spinner instead of a black video element.
   */
  public readonly isSeekLoading: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /**
   * CSS filter for the frozen seek-loading frame: the user's video
   * adjustments (the captured frame is raw, without CSS filters) plus a
   * dulling brightness drop.
   */
  public readonly freezeFrameFilter: ReturnType<typeof computed<string>> = computed((): string => {
    const base: string = this.videoFilter();
    return base === 'none' ? 'brightness(0.6)' : `${base} brightness(0.6)`;
  });

  // ============================================================================
  // Internal State
  // ============================================================================

  /** Path of the currently loaded video file */
  private currentFilePath: string | null = null;

  /** Path of the last successfully loaded video (state reached 'playing') */
  private lastSuccessfullyLoadedPath: string | null = null;

  /** Playback state that preceded the current 'loading' transition */
  private stateBeforeLoading: string = 'idle';

  /**
   * Web Audio graph for routing video audio through the equalizer.
   * Created lazily on first playback (requires a user gesture).
   */
  private audioContext: AudioContext | null = null;
  private audioSourceNode: MediaElementAudioSourceNode | null = null;
  private equalizerFilters: BiquadFilterNode[] | null = null;
  private audioGraphInitialized: boolean = false;

  /** Whether the current video requires transcoding */
  private isTranscoded: boolean = false;

  /** Flag to prevent duplicate seek operations */
  private seekPending: boolean = false;

  /** The seek offset used when loading a transcoded video (for time calculation) */
  private transcodeSeekOffset: number = 0;

  /** Timestamp of the last seek operation (for debouncing) */
  private lastSeekTime: number = 0;

  /** Timestamp when the current video source was loaded */
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

  /** Max difference (s) for a seek alignment to match this outlet's pending seek */
  private readonly seekAlignMatchEpsilon: number = 0.01;

  /** Safety timeout (ms) after which a stuck seek-loading overlay is hidden */
  private readonly seekLoadingTimeoutMs: number = 15000;

  /** Timeout handle for the seek-loading overlay safety hide */
  private seekLoadingTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /** Segmented spinner animation for the seek-loading overlay (lazy) */
  private seekSpinner: SeekSpinner | null = null;

  /** Video 'waiting' handler (stored for cleanup) */
  private videoWaitingHandler: (() => void) | null = null;

  /** Video 'playing' handler (stored for cleanup) */
  private videoPlayingHandler: (() => void) | null = null;

  /** Video event handlers (stored for cleanup) */
  private videoErrorHandler: (() => void) | null = null;
  private videoCanPlayHandler: (() => void) | null = null;
  private videoSeekedHandler: (() => void) | null = null;
  private videoLoadedMetadataHandler: (() => void) | null = null;

  /** Fade-out interval handle (stored for cleanup) */
  private fadeInterval: ReturnType<typeof setInterval> | null = null;

  /** Style element for subtitle appearance customization */
  private subtitleStyleElement: HTMLStyleElement | null = null;

  /** Loaded subtitle tracks with parsed cues (for custom rendering) */
  private loadedSubtitleTracks: LoadedSubtitleTrack[] = [];

  /** Video timeupdate handler (stored for cleanup) */
  private videoTimeUpdateHandler: (() => void) | null = null;

  // ============================================================================
  // Constructor - Reactive Effects
  // ============================================================================

  /**
   * Sets up reactive effects for video playback synchronization.
   *
   * Effects react to:
   * - Track changes: loads new video source
   * - Playback state: plays/pauses/stops the video element
   * - Seek events: handles seeking differently for native vs transcoded
   * - Volume changes: adjusts video element volume
   * - Mute changes: toggles video element muted state
   */
  public constructor() {
    // Keep the equalizer chain in sync with settings (video audio)
    effect((): void => {
      const enabled: boolean = this.settings.equalizerEnabled();
      const bands: readonly number[] = this.settings.equalizerBands();
      if (this.equalizerFilters) {
        applyEqualizerGains(this.equalizerFilters, bands, enabled);
      }
    });

    // React to track changes - load new video source.
    // Also handles same-track re-selection: when the user clicks on a track
    // that was already playing, we detect this by checking if the 'loading'
    // state is for a track that was previously successfully loaded.
    effect((): void => {
      const track: PlaylistItem | null = this.mediaPlayer.currentTrack();
      const state: string = this.mediaPlayer.playbackState();

      // Track when we successfully loaded a video (state reached 'playing')
      if (state === 'playing' && this.currentFilePath) {
        this.lastSuccessfullyLoadedPath = this.currentFilePath;
      }

      // Remember the state that preceded a 'loading' transition. This
      // distinguishes resuming after a stop (stopped → loading) from a
      // restart or re-selection (playing → loading), which must start at 0.
      if (state !== 'loading') {
        this.stateBeforeLoading = state;
      }

      // For re-selection: only clear currentFilePath if we're loading a track
      // that was already successfully played. This prevents double-loading when
      // selectTrack is called right after addToPlaylist (the track hasn't been
      // successfully loaded yet, so we shouldn't clear and reload).
      if (state === 'loading' && track?.filePath === this.lastSuccessfullyLoadedPath) {
        this.currentFilePath = null;
      }

      if (track?.type === 'video' && track.filePath !== this.currentFilePath) {
        const isViewModeChange: boolean = this.currentFilePath === null;
        // Determine the start position:
        // - Resume after stop: replaying the same track when the state before
        //   'loading' was 'stopped' resumes at the server position — the user
        //   may have dragged the seek bar while stopped before pressing play
        //   (the server keeps that position on play).
        // - Everything else (track switch, restart, re-selection, or a fresh
        //   mount after an audio → video switch): start from 0. The time
        //   signal can still hold the PREVIOUS track's position at mount, so
        //   it must never be used as a start position here; if the server is
        //   genuinely mid-track, its broadcasts re-position the element via
        //   the seek effect.
        const isStopResume: boolean = state === 'loading'
          && this.stateBeforeLoading === 'stopped'
          && track.filePath === this.lastSuccessfullyLoadedPath;
        const startTime: number = isStopResume
          ? untracked((): number => this.mediaPlayer.currentTime())
          : 0;
        // Reset flip on a genuine track switch, but preserve it across
        // view-mode changes (e.g. entering fullscreen) which reload the
        // same file.
        if (!isViewModeChange) {
          this.flipMode.set('none');
        }
        void this.loadVideo(track.filePath, startTime);
      }
    });

    // React to seek alignments from the server: when a streamed (DASH) seek
    // lands on a keyframe before the requested position, adopt the actual
    // stream start as the transcode offset so the seek bar, drift sync, and
    // subtitles line up with the content instead of sitting a keyframe ahead.
    effect((): void => {
      const alignment: {requested: number; actual: number} | null = this.electron.seekAlignment();
      if (!alignment || !this.isTranscoded) return;

      // Only adopt if it corresponds to the seek this outlet just issued
      if (Math.abs(this.transcodeSeekOffset - alignment.requested) < this.seekAlignMatchEpsilon) {
        this.transcodeSeekOffset = alignment.actual;
      }
    });

    // React to playback state changes
    effect((): void => {
      const state: string = this.mediaPlayer.playbackState();
      const video: HTMLVideoElement | undefined = this.videoRef?.nativeElement;
      if (!video) return;

      if (state === 'playing') {
        // Route video audio through the equalizer (lazy, needs a user gesture)
        this.initVideoAudioGraph();
        this.resumeAudioContext();
        if (video.src && video.readyState >= 2) {
          video.play().catch(console.error);
        }
      } else if (state === 'paused') {
        video.pause();
      } else if (state === 'stopped') {
        video.pause();
        video.currentTime = 0;
      }
    });

    // React to seek events (time updates from server)
    // The `video.seeking` guard prevents re-triggering seeks while a seek is
    // in progress, which would create a seek loop and stall playback.
    effect((): void => {
      const time: number = this.mediaPlayer.currentTime();
      const video: HTMLVideoElement | undefined = this.videoRef?.nativeElement;
      if (!video || !video.src || video.seeking) return;

      // Ignore corrections just after a (re)load: the time signal may still
      // hold the PREVIOUS track's position until the server broadcasts the
      // new track's reset (e.g. switching from an audio file at 15s to a
      // video must not seek the fresh video element to 15s).
      if (Date.now() - this.mediaLoadedAt < this.postLoadGuardMs) return;

      if (this.isTranscoded) {
        // Don't trigger seeks while video is still loading from a previous seek
        // readyState < 3 means the video doesn't have enough data to play smoothly
        // HAVE_FUTURE_DATA (3) or HAVE_ENOUGH_DATA (4) indicates the video is ready
        if (video.readyState < 3) return;

        // For transcoded files, account for seek offset
        const expectedVideoTime: number = time - this.transcodeSeekOffset;
        const timeDiff: number = Math.abs(video.currentTime - expectedVideoTime);

        const now: number = Date.now();
        const timeSinceLastSeek: number = now - this.lastSeekTime;

        if (timeDiff > 2 && timeSinceLastSeek > 1000 && !this.seekPending && this.currentFilePath) {
          this.seekPending = true;
          this.lastSeekTime = now;
          const seekFilePath: string = this.currentFilePath;
          console.log(`Seeking transcoded video to ${time}s (diff: ${timeDiff}s)`);
          // Freeze the current frame with a spinner while the stream reloads
          this.showSeekLoadingOverlay();
          void this.loadVideo(seekFilePath, time);
          // Note: seekPending is cleared when video fires 'canplay' in setupVideoEvents
        }
      } else {
        // For native formats, just set the currentTime
        if (Math.abs(video.currentTime - time) > 1) {
          video.currentTime = time;
        }
      }
    });

    // React to volume changes
    effect((): void => {
      const volume: number = this.mediaPlayer.volume();
      const video: HTMLVideoElement | undefined = this.videoRef?.nativeElement;
      if (video) {
        video.volume = volume;
      }
    });

    // React to mute changes
    effect((): void => {
      const muted: boolean = this.mediaPlayer.muted();
      const video: HTMLVideoElement | undefined = this.videoRef?.nativeElement;
      if (video) {
        video.muted = muted;
      }
    });

    // React to window close - fade out video audio to prevent speaker pop
    effect((): void => {
      const fadeDuration: number = this.electron.fadeOutRequested();
      const video: HTMLVideoElement | undefined = this.videoRef?.nativeElement;
      if (fadeDuration > 0 && video && video.volume > 0) {
        // Clear any existing fade interval to prevent leaks
        if (this.fadeInterval !== null) {
          clearInterval(this.fadeInterval);
        }

        // Perform gradual volume fade using interval
        const steps: number = 10;
        const stepDuration: number = fadeDuration / steps;
        const volumeStep: number = video.volume / steps;
        let currentStep: number = 0;

        this.fadeInterval = setInterval((): void => {
          currentStep++;
          video.volume = Math.max(0, video.volume - volumeStep);
          if (currentStep >= steps) {
            if (this.fadeInterval !== null) {
              clearInterval(this.fadeInterval);
              this.fadeInterval = null;
            }
            video.volume = 0;
          }
        }, stepDuration);
      }
    });

    // React to aspect mode changes and emit display name
    effect((): void => {
      const name: string = this.aspectModeName();
      this.aspectModeChange.emit(name);
    });

    // React to flip mode changes and emit state
    effect((): void => {
      this.flipChange.emit(this.flipMode());
    });

    // Load subtitle tracks when they change (custom rendering approach)
    effect((): void => {
      const tracks: readonly SubtitleTrack[] = this.subtitleTracks();
      const filePath: string | null = this.currentFilePath;
      const serverUrl: string = this.mediaPlayer.serverUrl();

      // Clean up existing tracks
      this.cleanupSubtitleTracks();

      if (!filePath || !serverUrl || tracks.length === 0) {
        this.selectedSubtitleTrack.set(-1);
        this.subtitleText.set('');
        return;
      }

      // Load and parse each track asynchronously
      void this.loadSubtitleTracks(tracks, serverUrl, filePath);
    });

    // React to subtitle appearance settings changes
    effect((): void => {
      const fontSize: number = this.settings.subtitleFontSize();
      const fontColor: string = this.settings.subtitleFontColor();
      const bgColor: string = this.settings.subtitleBackgroundColor();
      const bgOpacity: number = this.settings.subtitleBackgroundOpacity();
      const fontFamily: SubtitleFontFamily = this.settings.subtitleFontFamily();
      const textShadow: boolean = this.settings.subtitleTextShadow();
      const shadowSpread: number = this.settings.subtitleShadowSpread();
      const shadowBlur: number = this.settings.subtitleShadowBlur();
      const shadowColor: string = this.settings.subtitleShadowColor();

      this.updateSubtitleStyles(fontSize, fontColor, bgColor, bgOpacity, fontFamily, textShadow, shadowSpread, shadowBlur, shadowColor);
    });

    // React to audioTracks becoming available (SSE arrives after initial load).
    //
    // RACE CONDITION FIX:
    // When a video is loaded, loadVideo() runs immediately and tries to select
    // the correct audio track based on the user's preferred language setting.
    // However, at this point, the MediaInfo (containing audioTracks) hasn't
    // arrived yet via SSE - the server probes the file asynchronously and sends
    // the info later. This means loadVideo() falls back to track index 0.
    //
    // This effect watches for audioTracks to become available (via SSE) and
    // re-applies the preferred language setting, reloading the video stream
    // with the correct audio track if needed. Guards prevent unnecessary reloads:
    // - User has a cached selection (manual override takes precedence)
    // - Already selected something other than index 0
    // - Preferred track IS index 0 (no change needed)
    effect((): void => {
      const audioTracks: readonly AudioTrack[] = this.audioTracks();
      const filePath: string | null = this.currentFilePath;

      // Only proceed if we have tracks and a current file
      if (!filePath || audioTracks.length === 0) return;

      // Guard: User has a cached selection for this file (manual override takes precedence)
      const cachedSelection: number | undefined = this.electron.getAudioSelection(filePath);
      if (cachedSelection !== undefined) return;

      // Guard: Check if we're still on index 0 (the fallback from initial load)
      const currentSelection: number = untracked((): number => this.selectedAudioTrack());
      if (currentSelection !== 0) return;

      // Apply the preferred language setting now that we have track metadata
      const preferredLang: PreferredAudioLanguage = this.settings.preferredAudioLanguage();

      let selectedTrack: AudioTrack | undefined;
      if (preferredLang === 'default') {
        selectedTrack = audioTracks.find((t: AudioTrack): boolean => t.default) ?? audioTracks[0];
      } else {
        const preferredTrack: AudioTrack | undefined = audioTracks.find((t: AudioTrack): boolean => t.language === preferredLang);
        const defaultTrack: AudioTrack | undefined = audioTracks.find((t: AudioTrack): boolean => t.default);
        selectedTrack = preferredTrack ?? defaultTrack ?? audioTracks[0];
      }

      const newIndex: number = selectedTrack?.index ?? 0;

      // Guard: Only reload if we need to switch to a different track
      if (newIndex !== 0) {
        console.log(`[Audio] Applying preferred language '${preferredLang}': switching from track 0 to ${newIndex}`);
        const video: HTMLVideoElement | undefined = this.videoRef?.nativeElement;
        if (video) {
          const currentTime: number = this.isTranscoded
            ? this.transcodeSeekOffset + video.currentTime
            : video.currentTime;
          const wasPlaying: boolean = !video.paused;

          untracked((): void => this.selectedAudioTrack.set(newIndex));
          this.reloadVideoWithAudioTrack(currentTime, wasPlaying);
        }
      }
    });
  }

  // ============================================================================
  // Web Audio (equalizer)
  // ============================================================================

  /**
   * Lazily builds the Web Audio graph that routes the video element's audio
   * through the equalizer: source → equalizer → destination.
   *
   * Created on first playback so it happens within a user gesture (required
   * to start an AudioContext). The element's own volume/muted still apply
   * (they affect the signal entering the graph), so existing volume, mute,
   * and fade behaviour is unchanged.
   */
  private initVideoAudioGraph(): void {
    if (this.audioGraphInitialized) return;
    const video: HTMLVideoElement | undefined = this.videoRef?.nativeElement;
    if (!video) return;

    try {
      this.audioContext = new AudioContext();
      this.audioSourceNode = this.audioContext.createMediaElementSource(video);
      this.equalizerFilters = createEqualizerFilters(this.audioContext);
      applyEqualizerGains(this.equalizerFilters, this.settings.equalizerBands(), this.settings.equalizerEnabled());

      this.audioSourceNode.connect(this.equalizerFilters[0]);
      this.equalizerFilters[this.equalizerFilters.length - 1].connect(this.audioContext.destination);

      this.audioGraphInitialized = true;
    } catch (error: unknown) {
      console.error('Failed to initialize video audio graph', error);
    }
  }

  /**
   * Resumes the AudioContext if suspended (it starts suspended until a
   * user gesture). Without this, routed video audio would be silent.
   */
  private resumeAudioContext(): void {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(console.error);
    }
  }

  // ============================================================================
  // Lifecycle Hooks
  // ============================================================================

  /**
   * Initializes the component and sets up video element event listeners.
   */
  public ngOnInit(): void {
    this.setupVideoEvents();
  }

  /**
   * Cleanup when component is destroyed.
   * Stops playback and clears the video source.
   */
  public ngOnDestroy(): void {
    // Clear any in-progress fade interval
    if (this.fadeInterval !== null) {
      clearInterval(this.fadeInterval);
      this.fadeInterval = null;
    }

    // Clear any pending seek-loading overlay timeout and stop the spinner
    if (this.seekLoadingTimeoutId !== null) {
      clearTimeout(this.seekLoadingTimeoutId);
      this.seekLoadingTimeoutId = null;
    }
    this.seekSpinner?.stop();
    this.electron.setStreamingBusy(false);

    const video: HTMLVideoElement = this.videoRef.nativeElement;
    video.pause();
    video.src = '';
    this.currentFilePath = null;
    this.lastSuccessfullyLoadedPath = null;

    // Tear down the equalizer audio graph
    if (this.audioContext) {
      void this.audioContext.close().catch((): void => {});
      this.audioContext = null;
      this.audioSourceNode = null;
      this.equalizerFilters = null;
      this.audioGraphInitialized = false;
    }

    // Remove event listeners
    if (this.videoErrorHandler) {
      video.removeEventListener('error', this.videoErrorHandler);
    }
    if (this.videoCanPlayHandler) {
      video.removeEventListener('canplay', this.videoCanPlayHandler);
    }
    if (this.videoLoadedMetadataHandler) {
      video.removeEventListener('loadedmetadata', this.videoLoadedMetadataHandler);
    }
    if (this.videoSeekedHandler) {
      video.removeEventListener('seeked', this.videoSeekedHandler);
    }
    if (this.videoTimeUpdateHandler) {
      video.removeEventListener('timeupdate', this.videoTimeUpdateHandler);
    }
    if (this.videoWaitingHandler) {
      video.removeEventListener('waiting', this.videoWaitingHandler);
    }
    if (this.videoPlayingHandler) {
      video.removeEventListener('playing', this.videoPlayingHandler);
    }
    this.stopStallClockHold();

    // Remove subtitle style element
    if (this.subtitleStyleElement) {
      this.renderer.removeChild(this.document.head, this.subtitleStyleElement);
      this.subtitleStyleElement = null;
    }

    // Clean up subtitle tracks and blob URLs
    this.cleanupSubtitleTracks();
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
   * Opens a file dialog to load an external subtitle file.
   * Clears any previously loaded external subtitle if cancelled.
   */
  public async loadExternalSubtitle(): Promise<void> {
    const filePath: string | null = await this.electron.openSubtitleDialog();
    if (filePath) {
      this.externalSubtitlePath.set(filePath);
      // Load the external subtitle track
      await this.loadExternalSubtitleTrack(filePath);
    }
  }

  /**
   * Selects a subtitle track by index.
   * Pass -1 to disable subtitles.
   * Pass EXTERNAL_SUBTITLE_TRACK_INDEX (-2) to select the external subtitle track.
   *
   * Debug logging shows which track was selected and lists all loaded tracks
   * with their cue counts. This helps diagnose issues like "Forced" subtitles
   * appearing empty (forced tracks have very few cues by design - only foreign
   * language dialogue moments are subtitled).
   *
   * @param trackIndex - The track index to select, or -1 to disable, or -2 for external
   */
  public selectSubtitleTrack(trackIndex: number): void {
    console.log(`[Subtitles] Selecting track ${trackIndex}, loaded tracks: [${this.loadedSubtitleTracks.map((t: LoadedSubtitleTrack): string => `${t.index}(${t.cues.length} cues)`).join(', ')}]`);
    this.selectedSubtitleTrack.set(trackIndex);

    // Cache the selection so it persists across view mode changes
    if (this.currentFilePath) {
      this.electron.setSubtitleSelection(this.currentFilePath, trackIndex);
    }

    // Update display immediately with current time
    const video: HTMLVideoElement = this.videoRef.nativeElement;
    if (trackIndex === -1) {
      // Subtitles off
      this.subtitleText.set('');
    } else {
      // Trigger immediate update
      this.updateSubtitleDisplay(video.currentTime);
    }
  }

  /**
   * Selects an audio track by index.
   * This reloads the video stream with the new audio track and seeks back to the current position.
   *
   * @param trackIndex - The audio track index (0-based)
   */
  public selectAudioTrack(trackIndex: number): void {
    // Don't reload if same track
    if (trackIndex === this.selectedAudioTrack()) {
      return;
    }

    const video: HTMLVideoElement = this.videoRef.nativeElement;
    // For transcoded videos, video.currentTime is relative to the transcode stream
    // We need to add transcodeSeekOffset to get the actual media time
    const currentTime: number = this.isTranscoded
      ? this.transcodeSeekOffset + video.currentTime
      : video.currentTime;
    const wasPlaying: boolean = !video.paused;

    this.selectedAudioTrack.set(trackIndex);

    // Cache the selection so it persists across view mode changes
    if (this.currentFilePath) {
      this.electron.setAudioSelection(this.currentFilePath, trackIndex);
    }

    // Reload video with new audio track
    this.reloadVideoWithAudioTrack(currentTime, wasPlaying);
  }

  /**
   * Reloads the video with the selected audio track and seeks to the specified time.
   *
   * @param seekTime - Time to seek to after reload (absolute media time)
   * @param autoPlay - Whether to auto-play after seeking
   */
  private reloadVideoWithAudioTrack(seekTime: number, autoPlay: boolean): void {
    if (!this.currentFilePath) {
      return;
    }

    const video: HTMLVideoElement = this.videoRef.nativeElement;
    const audioTrack: number = this.selectedAudioTrack();

    // Freeze the current frame with a spinner while the stream reloads
    this.showSeekLoadingOverlay();

    // Build stream URL with audio track parameter
    // Note: canRemux is now determined server-side based on the selected track's codec
    const streamUrl: string = this.electron.appendAuth(
      this.isTranscoded
        ? `${this.electron.serverUrl()}/media/stream?path=${encodeURIComponent(this.currentFilePath)}&t=${seekTime}&audioTrack=${audioTrack}`
        : `${this.electron.serverUrl()}/media/stream?path=${encodeURIComponent(this.currentFilePath)}&audioTrack=${audioTrack}`
    );

    // Update transcodeSeekOffset for the new stream position
    if (this.isTranscoded) {
      this.transcodeSeekOffset = seekTime;
    }

    this.mediaLoadedAt = Date.now();
    video.src = streamUrl;
    video.load();

    // For native formats, seek after load; for transcoded, time is in URL
    if (!this.isTranscoded && seekTime > 0) {
      const onCanPlay: () => void = (): void => {
        video.currentTime = seekTime;
        video.removeEventListener('canplay', onCanPlay);
      };
      video.addEventListener('canplay', onCanPlay);
    }

    if (autoPlay) {
      void video.play();
    }
  }

  /**
   * Cycles to the next aspect mode.
   * Order: default -> 4:3 -> 16:9 -> fit -> default
   */
  public nextAspectMode(): void {
    const modes: readonly VideoAspectMode[] = VIDEO_ASPECT_OPTIONS.map((o: {value: VideoAspectMode; label: string}): VideoAspectMode => o.value);
    const currentIndex: number = modes.indexOf(this.aspectMode());
    const nextIndex: number = (currentIndex + 1) % modes.length;
    void this.settings.setVideoAspectMode(modes[nextIndex]);
  }

  /**
   * Cycles to the previous aspect mode.
   * Order: default -> fit -> 16:9 -> 4:3 -> default
   */
  public previousAspectMode(): void {
    const modes: readonly VideoAspectMode[] = VIDEO_ASPECT_OPTIONS.map((o: {value: VideoAspectMode; label: string}): VideoAspectMode => o.value);
    const currentIndex: number = modes.indexOf(this.aspectMode());
    const previousIndex: number = (currentIndex - 1 + modes.length) % modes.length;
    void this.settings.setVideoAspectMode(modes[previousIndex]);
  }

  /**
   * Sets a specific aspect mode.
   *
   * @param mode - The aspect mode to set
   */
  public setAspectMode(mode: VideoAspectMode): void {
    void this.settings.setVideoAspectMode(mode);
  }

  /**
   * Sets the video flip mode (none, horizontal, vertical, or both).
   *
   * @param mode - The flip mode to apply
   */
  public setFlipMode(mode: VideoFlipMode): void {
    this.flipMode.set(mode);
  }

  /**
   * Handles dragover to enable drop target with visual validation feedback.
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
  // Subtitle Styling
  // ============================================================================

  /**
   * Updates the subtitle appearance by injecting a style element targeting the overlay.
   *
   * Since we use a custom subtitle overlay instead of the browser's TextTrack API,
   * we inject CSS rules targeting the .subtitle-overlay class.
   *
   * @param fontSize - Font size as percentage (100 = default)
   * @param fontColor - Font color in hex format
   * @param bgColor - Background color in hex format
   * @param bgOpacity - Background opacity (0-1)
   * @param fontFamily - Font family name
   * @param textShadow - Whether to show text shadow
   * @param shadowSpread - Shadow spread/offset in pixels
   * @param shadowBlur - Shadow blur radius in pixels
   * @param shadowColor - Shadow color in hex format
   */
  private updateSubtitleStyles(
    fontSize: number,
    fontColor: string,
    bgColor: string,
    bgOpacity: number,
    fontFamily: SubtitleFontFamily,
    textShadow: boolean,
    shadowSpread: number,
    shadowBlur: number,
    shadowColor: string
  ): void {
    // Create style element if it doesn't exist
    if (!this.subtitleStyleElement) {
      const styleEl: HTMLStyleElement = this.renderer.createElement('style') as HTMLStyleElement;
      styleEl.id = 'onix-subtitle-styles';
      this.renderer.appendChild(this.document.head, styleEl);
      this.subtitleStyleElement = styleEl;
    }

    // Convert hex background color to rgba
    const bgRgba: string = this.hexToRgba(bgColor, bgOpacity);

    // Build shadow CSS - uses 8 directions for a complete outline effect
    // Directions: N, NE, E, SE, S, SW, W, NW
    let shadowCss: string = 'none';
    if (textShadow) {
      const s: number = shadowSpread;
      const b: number = shadowBlur;
      const c: string = shadowColor;
      shadowCss = [
        `0 -${s}px ${b}px ${c}`,      // N
        `${s}px -${s}px ${b}px ${c}`, // NE
        `${s}px 0 ${b}px ${c}`,       // E
        `${s}px ${s}px ${b}px ${c}`,  // SE
        `0 ${s}px ${b}px ${c}`,       // S
        `-${s}px ${s}px ${b}px ${c}`, // SW
        `-${s}px 0 ${b}px ${c}`,      // W
        `-${s}px -${s}px ${b}px ${c}` // NW
      ].join(', ');
    }

    // Build the CSS rules for the custom overlay
    const css: string = `
      .subtitle-overlay {
        font-size: ${fontSize}% !important;
        color: ${fontColor} !important;
        background-color: ${bgRgba} !important;
        font-family: ${fontFamily}, sans-serif !important;
        text-shadow: ${shadowCss} !important;
      }
    `;

    // Update the style element content
    this.subtitleStyleElement.textContent = css;
  }

  /**
   * Converts a hex color to rgba format.
   *
   * @param hex - Hex color string (e.g., '#ffffff')
   * @param alpha - Alpha value (0-1)
   * @returns RGBA color string
   */
  private hexToRgba(hex: string, alpha: number): string {
    const r: number = parseInt(hex.slice(1, 3), 16);
    const g: number = parseInt(hex.slice(3, 5), 16);
    const b: number = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * Sanitizes subtitle text to allow only safe HTML formatting tags.
   *
   * Subtitles may contain HTML formatting tags like <i>, <b>, <u>, etc.
   * This method strips all unsafe tags while preserving safe formatting.
   * Newlines are converted to <br> tags for proper multi-line display.
   *
   * @param text - Raw subtitle text that may contain HTML
   * @returns Sanitized HTML string safe for innerHTML binding
   */
  private sanitizeSubtitleHtml(text: string): string {
    if (!text) return '';

    // First, escape any content that's not inside our allowed tags
    // to prevent XSS. Then selectively allow safe formatting tags.

    // Convert newlines to placeholders first
    let sanitized: string = text.replace(/\n/g, '{{NEWLINE}}');

    // List of allowed formatting tags (WebVTT and common subtitle formats)
    const allowedTags: string[] = ['i', 'b', 'u', 'em', 'strong'];

    // Create a regex to match allowed tags (both opening and closing)
    const tagPattern: string = allowedTags.map((tag: string): string => `<\\/?${tag}\\s*>`).join('|');
    const allowedTagsRegex: RegExp = new RegExp(`(${tagPattern})`, 'gi');

    // Extract allowed tags and their positions
    const tagMatches: RegExpMatchArray | null = sanitized.match(allowedTagsRegex);
    const tagPositions: Array<{index: number; tag: string}> = [];

    if (tagMatches) {
      let searchPos: number = 0;
      for (const tag of tagMatches) {
        const idx: number = sanitized.indexOf(tag, searchPos);
        if (idx !== -1) {
          tagPositions.push({index: idx, tag});
          searchPos = idx + tag.length;
        }
      }
    }

    // Escape all HTML entities
    sanitized = sanitized
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    // Restore allowed tags (they were escaped, so we need to un-escape them)
    for (const tagName of allowedTags) {
      // Restore opening tags: &lt;tagname&gt; -> <tagname>
      sanitized = sanitized.replace(
        new RegExp(`&lt;(${tagName})\\s*&gt;`, 'gi'),
        `<$1>`
      );
      // Restore closing tags: &lt;/tagname&gt; -> </tagname>
      sanitized = sanitized.replace(
        new RegExp(`&lt;/(${tagName})\\s*&gt;`, 'gi'),
        `</$1>`
      );
    }

    // Convert newline placeholders to <br> tags
    sanitized = sanitized.replace(/\{\{NEWLINE\}\}/g, '<br>');

    return sanitized;
  }

  // ============================================================================
  // Video Loading
  // ============================================================================

  /**
   * Loads a video source from the media server.
   *
   * Determines if the format needs transcoding and constructs the
   * appropriate streaming URL. For transcoded formats, includes
   * a seek time parameter if seeking to a non-zero position.
   *
   * @param filePath - Absolute path to the video file
   * @param seekTime - Optional start time in seconds (for transcoded seek)
   */
  private async loadVideo(filePath: string, seekTime: number = 0): Promise<void> {
    const video: HTMLVideoElement = this.videoRef.nativeElement;
    // Use untracked() to prevent signal reads from being tracked by the calling effect
    const serverUrl: string = untracked((): string => this.mediaPlayer.serverUrl());

    if (!serverUrl) return;

    // A frozen seek-loading frame belongs to the current file — drop it when
    // a different track loads (its frame would be stale)
    if (this.currentFilePath !== null && this.currentFilePath !== filePath) {
      this.hideSeekLoadingOverlay();
    }

    this.currentFilePath = filePath;
    this.mediaLoadedAt = Date.now();

    // Remote streams take a while to spin up (yt-dlp URL fetch + FFmpeg) —
    // show the waiting cursor until the element can play (cleared alongside
    // the seek-loading overlay on canplay/playing/error)
    if (/^https?:\/\//i.test(filePath)) {
      this.electron.setStreamingBusy(true);
    }

    // Determine if this format needs transcoding based on container AND canRemux flag
    const ext: string = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    const isNativeContainer: boolean = NATIVE_VIDEO_FORMATS.has(ext);

    // Check canRemux flag from server - if false, transcoding will occur (hybrid or full)
    // The server sets canRemux=false when either video OR audio codec is incompatible
    // This is more reliable than checking audioCodec directly due to race conditions
    const canRemux: boolean | undefined = untracked((): boolean | undefined => this.electron.currentMedia()?.canRemux);

    // Transcoding is required if:
    // 1. Container is non-native (MKV, AVI, MOV) - always needs transcoding
    // 2. Container is native BUT canRemux is explicitly false (e.g., MP4 with AC3/DTS audio)
    // Note: If canRemux is undefined (race condition), assume native seeking will work
    this.isTranscoded = !isNativeContainer || canRemux === false;

    if (isNativeContainer && canRemux === false) {
      const audioCodec: string | undefined = untracked((): string | undefined => this.electron.currentMedia()?.audioCodec);
      console.log(`Native container ${ext} has canRemux=false (audio: ${audioCodec}) - using transcoded seek`);
    }

    // Initialize audio track selection from cache or default.
    // Uses untracked() to prevent signal reads from being tracked by the calling effect,
    // which would cause double-loading when currentMedia() updates.
    //
    // IMPORTANT: audioTracks may be empty here due to race condition - MediaInfo arrives
    // via SSE after this method runs. The effect watching audioTracks() (see constructor)
    // handles applying the preferred language once tracks are available. Here we just set
    // index 0 as fallback if tracks aren't available yet.
    const cachedAudioSelection: number | undefined = this.electron.getAudioSelection(filePath);
    if (cachedAudioSelection !== undefined) {
      // User manually selected a track for this file - honor that choice
      untracked((): void => this.selectedAudioTrack.set(cachedAudioSelection));
    } else {
      // No cached selection - apply preferred language setting.
      // Track selection priority:
      // 1. Track matching the user's preferred audio language setting
      // 2. Track explicitly marked as default in the container
      // 3. First track (index 0)
      const audioTracks: readonly AudioTrack[] = untracked((): readonly AudioTrack[] => this.electron.currentMedia()?.audioTracks ?? []);
      const preferredLang: PreferredAudioLanguage = untracked((): PreferredAudioLanguage => this.settings.preferredAudioLanguage());

      let selectedTrack: AudioTrack | undefined;
      if (preferredLang === 'default') {
        // Use the file's default track
        selectedTrack = audioTracks.find((t: AudioTrack): boolean => t.default) ?? audioTracks[0];
      } else {
        // Look for a track matching the preferred language
        const preferredTrack: AudioTrack | undefined = audioTracks.find((t: AudioTrack): boolean => t.language === preferredLang);
        const defaultTrack: AudioTrack | undefined = audioTracks.find((t: AudioTrack): boolean => t.default);
        selectedTrack = preferredTrack ?? defaultTrack ?? audioTracks[0];
      }
      // Falls back to 0 if tracks aren't available yet (race condition handled by effect)
      const defaultIndex: number = selectedTrack?.index ?? 0;
      untracked((): void => this.selectedAudioTrack.set(defaultIndex));
    }

    const audioTrack: number = untracked((): number => this.selectedAudioTrack());

    // Build the stream URL
    let url: string = `${serverUrl}/media/stream?path=${encodeURIComponent(filePath)}`;

    // For transcoded files, track the offset and include audio track and remux flag
    if (this.isTranscoded) {
      this.transcodeSeekOffset = seekTime;
      if (seekTime > 0) {
        url += `&t=${seekTime}`;
      }
      url += `&audioTrack=${audioTrack}`;
      if (canRemux) {
        url += '&canRemux=true';
      }
    } else {
      this.transcodeSeekOffset = 0;
      // For native formats, audio track is not used (browser plays all tracks)
    }

    video.src = this.electron.appendAuth(url);
    video.load();

    // For native formats, position the element once it can play (HTTP range
    // requests make this instant). Handles resuming at a position seeked
    // while stopped as well as view-mode remounts. Transcoded formats
    // already start at the right position via the 't' URL parameter.
    if (!this.isTranscoded && seekTime > 0) {
      const onCanPlay: () => void = (): void => {
        video.currentTime = seekTime;
        video.removeEventListener('canplay', onCanPlay);
      };
      video.addEventListener('canplay', onCanPlay);
    }

    console.log(`Loading video: ${filePath}, transcoded: ${this.isTranscoded}, seekTime: ${seekTime}, audioTrack: ${audioTrack}`);
  }

  /**
   * Sets up event listeners on the video element.
   *
   * Monitors:
   * - error: Logs playback errors
   * - canplay: Starts playback when ready
   * - loadedmetadata: Logs video duration
   */
  private setupVideoEvents(): void {
    const video: HTMLVideoElement = this.videoRef.nativeElement;

    this.videoErrorHandler = (): void => {
      const error: MediaError | null = video.error;
      console.error('Video error:', error?.code, error?.message);
      this.hideSeekLoadingOverlay();
    };
    video.addEventListener('error', this.videoErrorHandler);

    this.videoCanPlayHandler = (): void => {
      console.log('Video can play');
      // Clear seekPending now that the video has loaded and is ready to play
      // This allows the seek effect to trigger new seeks if needed
      this.seekPending = false;

      // The reloaded stream has a displayable frame — drop the frozen frame
      this.hideSeekLoadingOverlay();

      // For transcoded/streamed videos, the content starts at the requested
      // seek offset — but the server's wall clock kept running while FFmpeg
      // started up (for remote streams this can be several seconds). Rather
      // than folding that startup delay into transcodeSeekOffset (which would
      // desync the seek bar and subtitles from the actual content), re-anchor
      // the server clock to the real content position.
      if (this.isTranscoded) {
        // Give the sync a moment to round-trip before the transcoded seek
        // effect can interpret the remaining diff as a new seek
        this.lastSeekTime = Date.now();
        if (this.mediaPlayer.isPlaying()) {
          this.electron.syncPlaybackTime(this.transcodeSeekOffset + video.currentTime);
        }
      }

      if (this.mediaPlayer.isPlaying()) {
        video.play().catch(console.error);
      }
    };
    video.addEventListener('canplay', this.videoCanPlayHandler);

    this.videoLoadedMetadataHandler = (): void => {
      console.log('Video metadata loaded, duration:', video.duration);
    };
    video.addEventListener('loadedmetadata', this.videoLoadedMetadataHandler);

    // Force subtitle track refresh after seeking to fix sync issues
    this.videoSeekedHandler = (): void => {
      this.updateSubtitleDisplay(video.currentTime);
    };
    video.addEventListener('seeked', this.videoSeekedHandler);

    // Custom subtitle rendering: update display on each time update.
    // Also keeps the server clock anchored to the element's real position.
    this.videoTimeUpdateHandler = (): void => {
      this.updateSubtitleDisplay(video.currentTime);
      this.maybeSyncServerClock(video);
    };
    video.addEventListener('timeupdate', this.videoTimeUpdateHandler);

    // While the element stalls to buffer (or FFmpeg starts up), timeupdate
    // stops firing but the server's wall clock keeps running. Hold the clock
    // at the element's position until playback resumes, so the recovery
    // never looks like a seek and the seek bar never runs ahead of content.
    this.videoWaitingHandler = (): void => {
      this.startStallClockHold();
    };
    video.addEventListener('waiting', this.videoWaitingHandler);

    this.videoPlayingHandler = (): void => {
      this.stopStallClockHold();
      // Backup for the canplay hide — playback has definitely resumed
      this.hideSeekLoadingOverlay();
    };
    video.addEventListener('playing', this.videoPlayingHandler);
  }

  /**
   * Starts periodically anchoring the server clock to the element's current
   * position while the element is stalled (buffering / pipeline startup).
   *
   * Skips ticks in a short grace window after a user seek so a stale element
   * position can never cancel the seek target.
   */
  private startStallClockHold(): void {
    if (this.stallSyncInterval !== null) return;

    const video: HTMLVideoElement = this.videoRef.nativeElement;
    const holdClock: () => void = (): void => {
      if (!this.mediaPlayer.isPlaying()) return;
      if (Date.now() - this.electron.lastSeekAt < this.stallSeekGraceMs) return;
      // Never report a freshly (re)loaded element — its position may not
      // reflect the new track yet (the server ignores such syncs too)
      if (Date.now() - this.mediaLoadedAt < this.syncSettleMs) return;
      const actualTime: number = this.isTranscoded
        ? this.transcodeSeekOffset + video.currentTime
        : video.currentTime;
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
   * Shows the seek-loading overlay: captures the video's current frame onto
   * the freeze canvas (at its exact on-screen geometry, honouring the aspect
   * mode and flip), which is then displayed dulled with a spinner while the
   * stream reloads. Without this, swapping the source blacks the element out
   * for the duration of the pipeline restart.
   *
   * If no frame is decodable (e.g. a second seek while one is already
   * loading), the previously captured frame is kept.
   */
  private showSeekLoadingOverlay(): void {
    const video: HTMLVideoElement = this.videoRef.nativeElement;
    const canvas: HTMLCanvasElement | undefined = this.freezeFrameRef?.nativeElement;
    const container: HTMLElement | null = canvas?.parentElement ?? null;

    if (canvas && container) {
      const hasFrame: boolean = video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
      const alreadyShowing: boolean = untracked((): boolean => this.isSeekLoading());

      if (hasFrame) {
        const ctx: CanvasRenderingContext2D | null = canvas.getContext('2d');
        if (ctx) {
          const dpr: number = window.devicePixelRatio || 1;
          const containerRect: DOMRect = container.getBoundingClientRect();
          const videoRect: DOMRect = video.getBoundingClientRect();
          canvas.width = Math.round(containerRect.width * dpr);
          canvas.height = Math.round(containerRect.height * dpr);
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, containerRect.width, containerRect.height);

          // Element rect relative to the container
          const dx: number = videoRect.left - containerRect.left;
          const dy: number = videoRect.top - containerRect.top;
          let cw: number = videoRect.width;
          let ch: number = videoRect.height;
          let cx: number = dx;
          let cy: number = dy;

          // In the default aspect mode the element uses object-fit: contain,
          // so the visible content is letterboxed inside the element rect;
          // all other modes fill the element rect (object-fit: fill)
          if (untracked((): VideoAspectMode => this.aspectMode()) === 'default') {
            const scale: number = Math.min(videoRect.width / video.videoWidth, videoRect.height / video.videoHeight);
            cw = video.videoWidth * scale;
            ch = video.videoHeight * scale;
            cx = dx + (videoRect.width - cw) / 2;
            cy = dy + (videoRect.height - ch) / 2;
          }

          // Reproduce the CSS flip (applied to the video element only) by
          // mirroring the draw around the content rect's centre
          const flip: VideoFlipMode = untracked((): VideoFlipMode => this.flipMode());
          const flipX: number = flip === 'horizontal' || flip === 'both' ? -1 : 1;
          const flipY: number = flip === 'vertical' || flip === 'both' ? -1 : 1;
          ctx.save();
          ctx.translate(cx + cw / 2, cy + ch / 2);
          ctx.scale(flipX, flipY);
          ctx.drawImage(video, -cw / 2, -ch / 2, cw, ch);
          ctx.restore();
        }
      } else if (!alreadyShowing) {
        // No frame available and nothing previously captured — clear so the
        // spinner shows over the plain black container
        const ctx: CanvasRenderingContext2D | null = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
    }

    this.isSeekLoading.set(true);
    // Waiting cursor while the stream pipeline restarts
    this.electron.setStreamingBusy(true);

    // Start the segmented spinner animation (idempotent while running)
    if (!this.seekSpinner && this.seekSpinnerRef) {
      this.seekSpinner = new SeekSpinner(this.seekSpinnerRef.nativeElement);
    }
    this.seekSpinner?.start();

    // Safety net: never leave a stale overlay if the stream fails silently
    if (this.seekLoadingTimeoutId !== null) {
      clearTimeout(this.seekLoadingTimeoutId);
    }
    this.seekLoadingTimeoutId = setTimeout((): void => {
      this.hideSeekLoadingOverlay();
    }, this.seekLoadingTimeoutMs);
  }

  /**
   * Hides the seek-loading overlay once the reloaded stream can play (or on
   * error/track change/timeout).
   */
  private hideSeekLoadingOverlay(): void {
    if (this.seekLoadingTimeoutId !== null) {
      clearTimeout(this.seekLoadingTimeoutId);
      this.seekLoadingTimeoutId = null;
    }
    this.seekSpinner?.stop();
    this.isSeekLoading.set(false);
    this.electron.setStreamingBusy(false);
  }

  /**
   * Reports the video element's actual playback position to the server when
   * it has drifted from the server's wall-clock time.
   *
   * Drift happens when the element stalls to buffer (network hiccups, NAS
   * latency, remote streams) while the server clock keeps running. Left
   * uncorrected, the seek bar runs ahead of the content and the seek effect
   * eventually "corrects" the element by skipping it forward — the classic
   * streaming desync. Anchoring the clock to the element fixes both.
   *
   * Syncs are suppressed while the element is settling after a load or a
   * seek, so a stale element position never cancels a user's seek.
   *
   * @param video - The video element to read the position from
   */
  private maybeSyncServerClock(video: Readonly<HTMLVideoElement>): void {
    if (!this.mediaPlayer.isPlaying()) return;
    if (video.paused || video.seeking || this.seekPending) return;
    if (video.readyState < 3) return;

    const now: number = Date.now();
    if (now - this.lastSyncSentAt < this.syncThrottleMs) return;
    if (now - this.mediaLoadedAt < this.syncSettleMs) return;
    if (now - this.lastSeekTime < this.syncSettleMs) return;
    if (now - this.electron.lastSeekAt < this.syncSettleMs) return;

    const actualTime: number = this.isTranscoded
      ? this.transcodeSeekOffset + video.currentTime
      : video.currentTime;
    const drift: number = actualTime - this.mediaPlayer.currentTime();

    if (Math.abs(drift) > this.syncDriftThreshold) {
      this.lastSyncSentAt = now;
      this.electron.syncPlaybackTime(actualTime);
    }
  }

  /**
   * Loads subtitle tracks by fetching and parsing WebVTT content.
   *
   * This custom approach parses all cues into memory and renders them
   * manually via the subtitleText signal. This completely bypasses
   * the browser's TextTrack API which has sync issues after seeking.
   *
   * @param tracks - The subtitle tracks to load
   * @param serverUrl - The server URL for fetching
   * @param filePath - The video file path
   */
  private async loadSubtitleTracks(
    tracks: readonly SubtitleTrack[],
    serverUrl: string,
    filePath: string
  ): Promise<void> {
    console.log(`[Subtitles] Loading ${tracks.length} tracks: ${tracks.map((t: SubtitleTrack): string => `${t.index}="${t.title}" (${t.codec})`).join(', ')}`);
    for (const track of tracks) {
      try {
        const url: string = `${serverUrl}/media/subtitles?path=${encodeURIComponent(filePath)}&track=${track.index}`;
        const response: Response = await this.electron.authFetch(url);

        if (!response.ok) {
          console.error(`Failed to load subtitle track ${track.index}: ${response.status}`);
          continue;
        }

        const webvttContent: string = await response.text();
        const cues: ParsedSubtitleCue[] = this.parseWebVTT(webvttContent);

        this.loadedSubtitleTracks.push({
          index: track.index,
          cues,
        });

        console.log(`Loaded subtitle track ${track.index} with ${cues.length} cues`);
      } catch (error: unknown) {
        console.error(`Error loading subtitle track ${track.index}:`, error);
      }
    }

    // Check for a cached selection (persists across view mode changes - user's manual choice takes precedence)
    const cachedSelection: number | undefined = this.electron.getSubtitleSelection(filePath);
    const video: HTMLVideoElement = this.videoRef.nativeElement;

    if (cachedSelection !== undefined) {
      // Restore the user's previous selection
      this.selectedSubtitleTrack.set(cachedSelection);
      if (cachedSelection !== -1) {
        this.updateSubtitleDisplay(video.currentTime);
      }
    } else {
      // No cached selection - apply preferred subtitle language setting
      //
      // Selection priority:
      // 1. If 'off' → subtitles disabled
      // 2. Track matching the user's preferred language
      // 3. Track marked as default in the container
      // 4. Fall back to subtitles off
      const preferredLang: PreferredSubtitleLanguage = this.settings.preferredSubtitleLanguage();
      let selectedIndex: number = -1; // Default to off

      if (preferredLang === 'off') {
        // User prefers no subtitles - already set to -1
      } else if (preferredLang === 'default') {
        // Use the file's default track if one exists
        const defaultTrack: SubtitleTrack | undefined = tracks.find((t: SubtitleTrack): boolean => t.default);
        selectedIndex = defaultTrack?.index ?? -1;
      } else {
        // Look for a track matching the preferred language
        const preferredTrack: SubtitleTrack | undefined = tracks.find((t: SubtitleTrack): boolean => t.language === preferredLang);
        const defaultTrack: SubtitleTrack | undefined = tracks.find((t: SubtitleTrack): boolean => t.default);
        selectedIndex = preferredTrack?.index ?? defaultTrack?.index ?? -1;
      }

      this.selectedSubtitleTrack.set(selectedIndex);
      this.electron.setSubtitleSelection(filePath, selectedIndex);

      if (selectedIndex !== -1) {
        console.log(`[Subtitles] Auto-selected track ${selectedIndex} based on preferred language '${preferredLang}'`);
        this.updateSubtitleDisplay(video.currentTime);
      }
    }
  }

  /**
   * Loads an external subtitle file by fetching and parsing it.
   *
   * @param subtitlePath - The path to the external subtitle file
   */
  private async loadExternalSubtitleTrack(subtitlePath: string): Promise<void> {
    const serverUrl: string = this.mediaPlayer.serverUrl();

    if (!serverUrl) return;

    try {
      const url: string = `${serverUrl}/media/subtitles/external?path=${encodeURIComponent(subtitlePath)}`;
      const response: Response = await this.electron.authFetch(url);

      if (!response.ok) {
        console.error(`Failed to load external subtitle: ${response.status}`);
        return;
      }

      const webvttContent: string = await response.text();
      const cues: ParsedSubtitleCue[] = this.parseWebVTT(webvttContent);

      this.loadedSubtitleTracks.push({
        index: EXTERNAL_SUBTITLE_TRACK_INDEX,
        cues,
      });

      console.log(`Loaded external subtitle with ${cues.length} cues`);

      // Select the external track
      this.selectedSubtitleTrack.set(EXTERNAL_SUBTITLE_TRACK_INDEX);
      const video: HTMLVideoElement = this.videoRef.nativeElement;
      this.updateSubtitleDisplay(video.currentTime);
    } catch (error: unknown) {
      console.error('Error loading external subtitle:', error);
    }
  }

  /**
   * Parses WebVTT content into an array of cues.
   *
   * @param content - Raw WebVTT file content
   * @returns Array of parsed cues with timing and text
   */
  private parseWebVTT(content: string): ParsedSubtitleCue[] {
    const cues: ParsedSubtitleCue[] = [];
    const lines: string[] = content.split('\n');

    let i: number = 0;

    // Skip WEBVTT header and any metadata
    while (i < lines.length && !lines[i].includes('-->')) {
      i++;
    }

    // Parse cues
    while (i < lines.length) {
      const line: string = lines[i].trim();

      // Look for timing line (contains "-->")
      if (line.includes('-->')) {
        const timing: { start: number; end: number } | null = this.parseTimingLine(line);
        if (timing) {
          // Collect text lines until we hit an empty line or EOF
          const textLines: string[] = [];
          i++;
          while (i < lines.length && lines[i].trim() !== '') {
            textLines.push(lines[i].trim());
            i++;
          }

          if (textLines.length > 0) {
            cues.push({
              startTime: timing.start,
              endTime: timing.end,
              text: textLines.join('\n'),
            });
          }
        }
      }
      i++;
    }

    return cues;
  }

  /**
   * Parses a WebVTT timing line to extract start and end times.
   *
   * @param line - Timing line (e.g., "00:01:23.456 --> 00:01:27.890")
   * @returns Object with start and end times in seconds, or null if invalid
   */
  private parseTimingLine(line: string): { start: number; end: number } | null {
    // Match pattern: HH:MM:SS.mmm --> HH:MM:SS.mmm (hours optional)
    const match: RegExpMatchArray | null = line.match(
      /(\d{1,2}:)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})\.(\d{3})/
    );

    if (!match) return null;

    const startHours: number = match[1] ? parseInt(match[1].replace(':', ''), 10) : 0;
    const startMinutes: number = parseInt(match[2], 10);
    const startSeconds: number = parseInt(match[3], 10);
    const startMs: number = parseInt(match[4], 10);

    const endHours: number = match[5] ? parseInt(match[5].replace(':', ''), 10) : 0;
    const endMinutes: number = parseInt(match[6], 10);
    const endSeconds: number = parseInt(match[7], 10);
    const endMs: number = parseInt(match[8], 10);

    const secondsPerMinute: number = 60;
    const secondsPerHour: number = 3600;
    const msPerSecond: number = 1000;

    const start: number = startHours * secondsPerHour + startMinutes * secondsPerMinute + startSeconds + startMs / msPerSecond;
    const end: number = endHours * secondsPerHour + endMinutes * secondsPerMinute + endSeconds + endMs / msPerSecond;

    return { start, end };
  }

  /**
   * Updates the subtitle display based on the current video time.
   *
   * Finds the active cue(s) for the selected track at the given time
   * and updates the subtitleText signal.
   *
   * @param currentTime - Current video playback time in seconds
   */
  private updateSubtitleDisplay(currentTime: number): void {
    const selectedIndex: number = this.selectedSubtitleTrack();

    // If subtitles are off, clear the display
    if (selectedIndex === -1) {
      this.subtitleText.set('');
      return;
    }

    // For transcoded videos, account for the seek offset
    const adjustedTime: number = this.isTranscoded
      ? currentTime + this.transcodeSeekOffset
      : currentTime;

    // Find the track
    const track: LoadedSubtitleTrack | undefined = this.loadedSubtitleTracks.find(
      (t: LoadedSubtitleTrack): boolean => t.index === selectedIndex
    );

    if (!track) {
      console.warn(`[Subtitles] Track ${selectedIndex} not found in loaded tracks (available: [${this.loadedSubtitleTracks.map((t: LoadedSubtitleTrack): number => t.index).join(', ')}])`);
      this.subtitleText.set('');
      return;
    }

    // Find active cues at this time
    const activeCues: ParsedSubtitleCue[] = track.cues.filter(
      (cue: ParsedSubtitleCue): boolean =>
        adjustedTime >= cue.startTime && adjustedTime <= cue.endTime
    );

    if (activeCues.length > 0) {
      // Join multiple cues with newline
      const text: string = activeCues.map((c: ParsedSubtitleCue): string => c.text).join('\n');
      this.subtitleText.set(text);
    } else {
      this.subtitleText.set('');
    }
  }

  /**
   * Cleans up loaded subtitle tracks.
   */
  private cleanupSubtitleTracks(): void {
    this.loadedSubtitleTracks = [];
    this.subtitleText.set('');
  }
}

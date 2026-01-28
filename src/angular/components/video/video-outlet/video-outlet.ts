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

import {Component, ElementRef, ViewChild, OnInit, OnDestroy, inject, computed, signal, effect, output, ChangeDetectionStrategy, OutputEmitterRef, Renderer2} from '@angular/core';
import {DOCUMENT} from '@angular/common';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import {FileDropService} from '../../../services/file-drop.service';
import {SettingsService, VideoAspectMode, VIDEO_ASPECT_OPTIONS, SubtitleFontFamily} from '../../../services/settings.service';
import type {PlaylistItem, SubtitleTrack, AudioTrack} from '../../../services/electron.service';

/**
 * Video formats that Chromium can play natively.
 * These formats support HTTP range requests for efficient seeking.
 */
const NATIVE_VIDEO_FORMATS: Set<string> = new Set(['.mp4', '.m4v', '.webm', '.ogg']);

/**
 * Track index indicating an external subtitle file is selected.
 * Used to distinguish from embedded subtitle tracks (0+) and off (-1).
 */
const EXTERNAL_SUBTITLE_TRACK_INDEX: number = -2;

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

  // ============================================================================
  // Reactive State
  // ============================================================================

  /** Currently playing track */
  public readonly currentTrack: ReturnType<typeof computed<PlaylistItem | null>> = computed((): PlaylistItem | null => this.mediaPlayer.currentTrack());

  /** Whether files are being dragged over this component */
  public readonly isDragOver: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Current video aspect mode */
  public readonly aspectMode: ReturnType<typeof computed<VideoAspectMode>> = computed(
    (): VideoAspectMode => this.settings.videoAspectMode()
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

  // ============================================================================
  // Internal State
  // ============================================================================

  /** Path of the currently loaded video file */
  private currentFilePath: string | null = null;

  /** Whether the current video requires transcoding */
  private isTranscoded: boolean = false;

  /** Flag to prevent duplicate seek operations */
  private seekPending: boolean = false;

  /** The seek offset used when loading a transcoded video (for time calculation) */
  private transcodeSeekOffset: number = 0;

  /** Timestamp of the last seek operation (for debouncing) */
  private lastSeekTime: number = 0;

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
    // React to track changes - load new video source.
    // Also depends on playbackState to detect same-track re-selection:
    // when the server enters 'loading', currentFilePath is always cleared
    // so the same file gets reloaded on re-selection.
    effect((): void => {
      const track: PlaylistItem | null = this.mediaPlayer.currentTrack();
      const state: string = this.mediaPlayer.playbackState();

      if (state === 'loading') {
        this.currentFilePath = null;
      }

      if (track?.type === 'video' && track.filePath !== this.currentFilePath) {
        void this.loadVideo(track.filePath);
      }
    });

    // React to playback state changes
    effect((): void => {
      const state: string = this.mediaPlayer.playbackState();
      const video: HTMLVideoElement | undefined = this.videoRef?.nativeElement;
      if (!video) return;

      if (state === 'playing') {
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

      if (this.isTranscoded) {
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
          void this.loadVideo(seekFilePath, time).then((): void => {
            this.seekPending = false;
            // Verify we're still on the same file after async operation
            if (this.currentFilePath === seekFilePath && this.mediaPlayer.isPlaying()) {
              const currentVideo: HTMLVideoElement | undefined = this.videoRef?.nativeElement;
              currentVideo?.play().catch(console.error);
            }
          });
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

    const video: HTMLVideoElement = this.videoRef.nativeElement;
    video.pause();
    video.src = '';
    this.currentFilePath = null;

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
   * @param trackIndex - The track index to select, or -1 to disable, or -2 for external
   */
  public selectSubtitleTrack(trackIndex: number): void {
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
    const currentTime: number = video.currentTime;
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
   * @param seekTime - Time to seek to after reload
   * @param autoPlay - Whether to auto-play after seeking
   */
  private reloadVideoWithAudioTrack(seekTime: number, autoPlay: boolean): void {
    if (!this.currentFilePath) {
      return;
    }

    const video: HTMLVideoElement = this.videoRef.nativeElement;
    const audioTrack: number = this.selectedAudioTrack();

    // Build stream URL with audio track parameter
    const streamUrl: string = this.isTranscoded
      ? `${this.electron.serverUrl()}/media/stream?path=${encodeURIComponent(this.currentFilePath)}&t=${seekTime}&audioTrack=${audioTrack}`
      : `${this.electron.serverUrl()}/media/stream?path=${encodeURIComponent(this.currentFilePath)}&audioTrack=${audioTrack}`;

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
    const serverUrl: string = this.mediaPlayer.serverUrl();

    if (!serverUrl) return;

    this.currentFilePath = filePath;

    // Determine if this format needs transcoding
    const ext: string = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    this.isTranscoded = !NATIVE_VIDEO_FORMATS.has(ext);

    // Initialize audio track selection from cache or default
    const cachedAudioSelection: number | undefined = this.electron.getAudioSelection(filePath);
    if (cachedAudioSelection !== undefined) {
      this.selectedAudioTrack.set(cachedAudioSelection);
    } else {
      // Default to first audio track (or track marked as default)
      const audioTracks: readonly AudioTrack[] = this.electron.currentMedia()?.audioTracks ?? [];
      const defaultTrack: AudioTrack | undefined = audioTracks.find((t: AudioTrack): boolean => t.default);
      const defaultIndex: number = defaultTrack?.index ?? 0;
      this.selectedAudioTrack.set(defaultIndex);
    }

    const audioTrack: number = this.selectedAudioTrack();

    // Build the stream URL
    let url: string = `${serverUrl}/media/stream?path=${encodeURIComponent(filePath)}`;

    // For transcoded files, track the offset and include audio track
    if (this.isTranscoded) {
      this.transcodeSeekOffset = seekTime;
      if (seekTime > 0) {
        url += `&t=${seekTime}`;
      }
      url += `&audioTrack=${audioTrack}`;
    } else {
      this.transcodeSeekOffset = 0;
      // For native formats, audio track is not used (browser plays all tracks)
    }

    video.src = url;
    video.load();

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
    };
    video.addEventListener('error', this.videoErrorHandler);

    this.videoCanPlayHandler = (): void => {
      console.log('Video can play');
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

    // Custom subtitle rendering: update display on each time update
    this.videoTimeUpdateHandler = (): void => {
      this.updateSubtitleDisplay(video.currentTime);
    };
    video.addEventListener('timeupdate', this.videoTimeUpdateHandler);
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
    for (const track of tracks) {
      try {
        const url: string = `${serverUrl}/media/subtitles?path=${encodeURIComponent(filePath)}&track=${track.index}`;
        const response: Response = await fetch(url);

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

    // Check for a cached selection (persists across view mode changes)
    const cachedSelection: number | undefined = this.electron.getSubtitleSelection(filePath);
    const video: HTMLVideoElement = this.videoRef.nativeElement;

    if (cachedSelection !== undefined) {
      // Restore the user's previous selection
      this.selectedSubtitleTrack.set(cachedSelection);
      if (cachedSelection !== -1) {
        this.updateSubtitleDisplay(video.currentTime);
      }
    } else {
      // No cached selection - default to subtitles off
      this.selectedSubtitleTrack.set(-1);
      this.electron.setSubtitleSelection(filePath, -1);
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
      const response: Response = await fetch(url);

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

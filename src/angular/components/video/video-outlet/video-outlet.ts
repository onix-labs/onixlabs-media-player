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

import {Component, ElementRef, ViewChild, OnInit, OnDestroy, inject, computed, signal, effect, ChangeDetectionStrategy} from '@angular/core';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import type {PlaylistItem} from '../../../services/electron.service';
import {MEDIA_EXTENSIONS} from '../../../constants/media.constants';

/**
 * Video formats that Chromium can play natively.
 * These formats support HTTP range requests for efficient seeking.
 */
const NATIVE_VIDEO_FORMATS: Set<string> = new Set(['.mp4', '.webm', '.ogg']);

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

  // ============================================================================
  // Reactive State
  // ============================================================================

  /** Currently playing track */
  public readonly currentTrack: ReturnType<typeof computed<PlaylistItem | null>> = computed((): PlaylistItem | null => this.mediaPlayer.currentTrack());

  /** Whether files are being dragged over this component */
  public readonly isDragOver: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

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
  private videoLoadedMetadataHandler: (() => void) | null = null;

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
    // React to track changes - load new video source
    effect((): void => {
      const track: PlaylistItem | null = this.mediaPlayer.currentTrack();
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
    effect((): void => {
      const time: number = this.mediaPlayer.currentTime();
      const video: HTMLVideoElement | undefined = this.videoRef?.nativeElement;
      if (!video || !video.src) return;

      if (this.isTranscoded) {
        // For transcoded files, account for seek offset
        const expectedVideoTime: number = time - this.transcodeSeekOffset;
        const timeDiff: number = Math.abs(video.currentTime - expectedVideoTime);

        const now: number = Date.now();
        const timeSinceLastSeek: number = now - this.lastSeekTime;

        if (timeDiff > 2 && timeSinceLastSeek > 1000 && !this.seekPending && this.currentFilePath) {
          this.seekPending = true;
          this.lastSeekTime = now;
          console.log(`Seeking transcoded video to ${time}s (diff: ${timeDiff}s)`);
          void this.loadVideo(this.currentFilePath, time).then((): void => {
            this.seekPending = false;
            if (this.mediaPlayer.isPlaying()) {
              video.play().catch(console.error);
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

    // Build the stream URL
    let url: string = `${serverUrl}/media/stream?path=${encodeURIComponent(filePath)}`;

    // For transcoded files, track the offset
    if (this.isTranscoded) {
      this.transcodeSeekOffset = seekTime;
      if (seekTime > 0) {
        url += `&t=${seekTime}`;
      }
    } else {
      this.transcodeSeekOffset = 0;
    }

    video.src = url;
    video.load();

    console.log(`Loading video: ${filePath}, transcoded: ${this.isTranscoded}, seekTime: ${seekTime}`);
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
  }
}

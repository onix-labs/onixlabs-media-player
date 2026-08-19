/**
 * @fileoverview Unified HTTP media server for audio and video streaming.
 *
 * This module provides the core backend functionality for the media player:
 * - HTTP API for playback control, playlist management, and media streaming
 * - Server-Sent Events (SSE) for real-time state synchronization
 * - Media streaming with support for native formats and transcoding
 * - MIDI file playback via FluidSynth synthesis
 * - FFprobe integration for metadata extraction
 *
 * Architecture:
 * The server acts as the single source of truth for all media state.
 * The renderer (Angular) communicates exclusively via HTTP/SSE, with no
 * direct file system access. This design:
 * - Simplifies state management (server is authoritative)
 * - Enables streaming of non-native formats via transcoding
 * - Provides a clean separation between UI and media handling
 *
 * @module electron/unified-media-server
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { createReadStream, statSync, existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, rmdirSync, Stats } from 'fs';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { SettingsManager } from './settings-manager.js';
import { serverLogger, playlistLogger, playbackLogger, ffmpegLogger, midiLogger, logHttpRequest, logProcessSpawn, logProcessOutput, logProcessExit } from './logger.js';
import { app } from 'electron';
import { DependencyManager } from './dependency-manager.js';
import type { DependencyId, DependencyState, InstallProgress, SoundFontInfo, HardwareEncoderInfo } from './dependency-manager.js';
import type { AppSettings, VisualizationSettingsUpdate, ApplicationSettingsUpdate, PlaybackSettingsUpdate, TranscodingSettingsUpdate, AppearanceSettingsUpdate, SubtitleSettingsUpdate, EqualizerSettingsUpdate, VideoAdjustmentsSettingsUpdate, RecentItemsSettings, HardwareAcceleration } from './settings-manager.js';
import { parseMidiDuration, MIDI_FORMATS } from './midi-parser.js';
import { TRACKER_FORMATS } from './tracker-parser.js';
import { SSEManager } from './sse-manager.js';
import { PlaylistManager } from './playlist-manager.js';
import { MediaDownloadManager } from './media-download-manager.js';
import type { StreamSources } from './media-download-manager.js';
import type { PlaylistItem, PlaylistState, MediaInfo, PlaybackState, SubtitleTrack, AudioTrack, DownloadJob, UrlMediaInfo, UrlMediaFormat } from './media-types.js';

// Re-export types that were previously exported from this module
export type { PlaylistItem, MediaInfo, SubtitleTrack, AudioTrack } from './media-types.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Video formats that Chromium can play natively.
 * These support HTTP range requests for seeking.
 */
const NATIVE_VIDEO_FORMATS: Set<string> = new Set(['.mp4', '.m4v', '.webm', '.ogg']);

/**
 * ISO 639-2/B language codes to display names.
 * Common languages used in media files for subtitle tracks.
 */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  eng: 'English',
  spa: 'Spanish',
  fre: 'French',
  fra: 'French',
  ger: 'German',
  deu: 'German',
  ita: 'Italian',
  por: 'Portuguese',
  rus: 'Russian',
  jpn: 'Japanese',
  kor: 'Korean',
  chi: 'Chinese',
  zho: 'Chinese',
  ara: 'Arabic',
  hin: 'Hindi',
  tha: 'Thai',
  vie: 'Vietnamese',
  pol: 'Polish',
  dut: 'Dutch',
  nld: 'Dutch',
  swe: 'Swedish',
  nor: 'Norwegian',
  dan: 'Danish',
  fin: 'Finnish',
  tur: 'Turkish',
  heb: 'Hebrew',
  gre: 'Greek',
  ell: 'Greek',
  cze: 'Czech',
  ces: 'Czech',
  hun: 'Hungarian',
  rum: 'Romanian',
  ron: 'Romanian',
  und: 'Unknown',
};

/**
 * Audio formats that Chromium can play natively.
 * These support HTTP range requests for seeking.
 */
const NATIVE_AUDIO_FORMATS: Set<string> = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac']);

/**
 * MIME types for supported media formats.
 * Non-native formats are transcoded to container formats that browsers support.
 */
const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mkv': 'video/mp4',   // Transcoded to MP4
  '.avi': 'video/mp4',   // Transcoded to MP4
  '.mov': 'video/mp4',   // Transcoded to MP4
};

// ============================================================================
// Unified Media Server
// ============================================================================

/**
 * HTTP server providing the complete media player backend.
 *
 * This server provides:
 * - Media streaming (native formats with range requests, transcoded formats)
 * - MIDI playback via FluidSynth synthesis
 * - Playback control API (play, pause, seek, volume)
 * - Playlist management API (add, remove, next, previous, shuffle, repeat)
 * - Real-time state updates via Server-Sent Events
 * - Media metadata extraction via ffprobe
 *
 * The server maintains authoritative state for:
 * - Current playback position (tracked via interval timer)
 * - Volume and mute state
 * - Playlist contents and current selection
 * - Shuffle/repeat mode
 *
 * @example
 * const server = new UnifiedMediaServer();
 * const port = await server.start();
 * console.log(`Server running on http://127.0.0.1:${port}`);
 */
export class UnifiedMediaServer {
  /** The Node.js HTTP server instance */
  private server: Server | null = null;

  /** The port the server is listening on */
  private port: number = 0;

  /**
   * Per-session bearer token minted at construction. Every request to an API
   * route must present it, via the `X-Onix-Token` header or a `token` query
   * parameter. The query form exists because media elements (`<video src>`,
   * `<audio src>`) and `EventSource` cannot send custom headers.
   *
   * The renderer receives this over IPC; nothing else on the machine can read
   * it, which is what stops other local processes and web pages the user
   * happens to be visiting from driving the server.
   */
  private readonly authToken: string = randomBytes(32).toString('hex');

  /**
   * Path prefixes that identify API routes. GET requests outside these
   * prefixes fall through to static asset serving and are left unauthenticated
   * (the Angular bundle is not sensitive); everything else requires the token.
   *
   * IMPORTANT: adding a new API route under a new prefix requires adding the
   * prefix here, otherwise it will be served without authentication.
   */
  private static readonly API_ROUTE_PREFIXES: readonly string[] = [
    '/events',
    '/media',
    '/player',
    '/playlist',
    '/settings',
    '/dependencies',
  ];

  /** SSE manager for real-time client updates */
  private readonly sse: SSEManager = new SSEManager();

  /** Settings manager for persistent user preferences */
  private readonly settings: SettingsManager = new SettingsManager();

  /** Dependency manager for external binary detection and installation */
  private readonly deps: DependencyManager = new DependencyManager(process.platform, app.getPath('userData'));

  /** Playlist manager instance */
  private readonly playlist: PlaylistManager;

  /** Manager for downloading/streaming media from internet URLs via yt-dlp */
  private readonly download: MediaDownloadManager;

  /**
   * Maps a resolved DASH video-stream URL to its separate audio-stream URL.
   * Populated when a URL is resolved for streaming; the media stream handler
   * looks the video URL up to mux the paired audio in via ffmpeg.
   */
  private readonly dashAudioPairs: Map<string, string> = new Map();

  /** Maximum number of DASH audio pairs retained (FIFO eviction). */
  private static readonly MAX_DASH_PAIRS: number = 50;

  /** Current playback state */
  private readonly playback: PlaybackState = {
    state: 'idle',
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    currentMedia: null,
    errorMessage: null,
  };

  /** Interval for updating playback time */
  private timeUpdateInterval: NodeJS.Timeout | null = null;

  /** Path to static files for serving Angular app in production */
  private staticPath: string | null = null;

  /** Timestamp when playback started (for calculating current time) */
  private startTime: number = 0;

  /** Time position when playback was paused (for resume) */
  private pausedTime: number = 0;

  /** Timestamp when the current track started playing from a fresh position */
  private lastTrackStartAt: number = 0;

  /** Window (ms) after a track start during which clock syncs are ignored */
  private readonly TRACK_START_SYNC_GUARD_MS: number = 1500;

  /** Timeout (ms) for the DASH seek keyframe probe */
  private readonly KEYFRAME_PROBE_TIMEOUT_MS: number = 5000;

  /** Max clock-vs-request gap (s) for a stream request to count as the active seek */
  private readonly SEEK_ALIGN_WINDOW_S: number = 3;

  /** Callback for playlist mode changes (shuffle/repeat) */
  private onModeChangeCallback: ((shuffle: boolean, repeat: boolean) => void) | null = null;

  /** Callback for playlist count changes (for menu enabled state) */
  private onPlaylistCountChangeCallback: ((count: number) => void) | null = null;

  /** Callback for playback state changes (for menu state) */
  private onPlaybackStateChangeCallback: ((isPlaying: boolean) => void) | null = null;

  /** Callback for dependency state changes (for menu open enabled state) */
  private onDependencyStateChangeCallback: ((ffmpegInstalled: boolean, fluidsynthInstalled: boolean, openmpt123Installed: boolean) => void) | null = null;

  /** Callback for media type changes (for menu aspect ratio enabled state) */
  private onMediaTypeChangeCallback: ((isVideo: boolean) => void) | null = null;

  /** Callback for recent items changes (for menu recent items submenu) */
  private onRecentItemsChangeCallback: ((recentFiles: readonly import('./settings-manager.js').RecentItem[], recentPlaylists: readonly import('./settings-manager.js').RecentItem[]) => void) | null = null;

  /** Maximum number of entries in the MIDI render cache (FIFO eviction when exceeded) */
  private static readonly MAX_MIDI_CACHE_SIZE: number = 50;

  /** Cache of pre-rendered MIDI files (original path → temp MP3 path + accurate duration) */
  private readonly midiRenderCache: Map<string, {readonly tempFile: string; readonly duration: number}> = new Map();

  /** In-progress MIDI renders for deduplication (original path → completion promise) */
  private readonly midiRenderInProgress: Map<string, Promise<string>> = new Map<string, Promise<string>>();

  /** Maximum number of entries in the tracker render cache (FIFO eviction when exceeded) */
  private static readonly MAX_TRACKER_CACHE_SIZE: number = 50;

  /** Cache of pre-rendered tracker modules (original path → temp MP3 path + accurate duration) */
  private readonly trackerRenderCache: Map<string, {readonly tempFile: string; readonly duration: number}> = new Map();

  /** In-progress tracker renders for deduplication (original path → completion promise) */
  private readonly trackerRenderInProgress: Map<string, Promise<string>> = new Map<string, Promise<string>>();

  /** Cache of MediaInfo by file path for stream handler codec lookup */
  private readonly mediaInfoCache: Map<string, MediaInfo> = new Map();

  /** Audio codecs compatible with fragmented MP4 remuxing (can be stream-copied) */
  private static readonly REMUXABLE_AUDIO_CODECS: Set<string> = new Set(['aac', 'mp3', 'opus', 'flac']);

  /**
   * Audio codecs that browsers can decode natively.
   * Files with other audio codecs must be transcoded even if the container is "native".
   * Note: vorbis is browser-compatible but typically in WebM/Ogg containers which are already handled.
   */
  private static readonly BROWSER_COMPATIBLE_AUDIO_CODECS: Set<string> = new Set([
    'aac',      // Advanced Audio Coding - most common
    'mp3',      // MPEG Audio Layer III
    'opus',     // Opus - modern, efficient
    'flac',     // Free Lossless Audio Codec
    'vorbis',   // Ogg Vorbis
    'pcm_s16le', // PCM signed 16-bit little-endian (WAV)
    'pcm_s24le', // PCM signed 24-bit little-endian (WAV)
    'pcm_s32le', // PCM signed 32-bit little-endian (WAV)
    'pcm_f32le', // PCM 32-bit floating-point little-endian
    'alac',     // Apple Lossless - Safari/Chrome support
  ]);

  // ==========================================================================
  // Hardware Encoder Selection
  // ==========================================================================

  /**
   * Selects the video encoder based on user settings and available hardware.
   *
   * @returns Object containing encoder name and encoder-specific extra args
   */
  private selectVideoEncoder(): {encoder: string; extraArgs: string[]} {
    const setting: HardwareAcceleration = this.settings.getSettings().transcoding.hardwareAcceleration;
    const available: readonly string[] = this.deps.getHardwareEncoders().encoders;

    // Disabled: always use software encoding
    if (setting === 'disabled') {
      return {encoder: 'libx264', extraArgs: ['-preset', 'ultrafast', '-tune', 'zerolatency']};
    }

    // User explicitly selected a specific encoder
    if (setting !== 'auto') {
      if (available.includes(setting)) {
        return this.getEncoderConfig(setting);
      }
      // Requested encoder not available - fall back to software
      serverLogger.warn(`Requested encoder ${setting} not available, falling back to libx264`);
      return {encoder: 'libx264', extraArgs: ['-preset', 'ultrafast', '-tune', 'zerolatency']};
    }

    // Auto mode: prefer platform-native encoder
    const preferenceOrder: string[] = this.getEncoderPreference();
    for (const encoder of preferenceOrder) {
      if (available.includes(encoder)) {
        return this.getEncoderConfig(encoder);
      }
    }

    // No hardware encoder available - use software
    return {encoder: 'libx264', extraArgs: ['-preset', 'ultrafast', '-tune', 'zerolatency']};
  }

  /**
   * Gets the platform-specific encoder preference order.
   *
   * @returns Array of encoder names in preference order
   */
  private getEncoderPreference(): string[] {
    if (process.platform === 'darwin') {
      return ['h264_videotoolbox'];
    }
    // Windows/Linux: NVENC > Quick Sync > AMF > VAAPI > software
    return ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi'];
  }

  /**
   * Gets encoder-specific configuration arguments.
   *
   * @param encoder - The encoder name
   * @returns Object containing encoder name and encoder-specific extra args
   */
  private getEncoderConfig(encoder: string): {encoder: string; extraArgs: string[]} {
    switch (encoder) {
      case 'h264_videotoolbox':
        // VideoToolbox: Apple's hardware encoder for macOS
        // -allow_sw 1: Allow fallback to software if hardware is busy
        // -realtime 1: Optimize for real-time encoding
        return {encoder, extraArgs: ['-allow_sw', '1', '-realtime', '1']};
      case 'h264_nvenc':
        // NVENC: NVIDIA's hardware encoder
        // -preset p4: Balanced preset (p1=fastest, p7=slowest/best)
        // -tune ll: Low-latency tuning
        return {encoder, extraArgs: ['-preset', 'p4', '-tune', 'll']};
      case 'h264_qsv':
        // Quick Sync: Intel's hardware encoder
        // -preset veryfast: Fast encoding preset
        return {encoder, extraArgs: ['-preset', 'veryfast']};
      case 'h264_amf':
        // AMF: AMD's hardware encoder (Windows only)
        // -quality speed: Optimize for encoding speed
        return {encoder, extraArgs: ['-quality', 'speed']};
      case 'h264_vaapi':
        // VA-API: Linux generic hardware acceleration
        // Note: May need -vaapi_device /dev/dri/renderD128 for full support
        return {encoder, extraArgs: []};
      default:
        // Software encoding fallback: libx264 with low-latency settings
        // -preset ultrafast: Fastest encoding (lowest quality per bitrate)
        // -tune zerolatency: Optimize for streaming (no B-frames, faster start)
        return {encoder: 'libx264', extraArgs: ['-preset', 'ultrafast', '-tune', 'zerolatency']};
    }
  }

  /**
   * Creates a new unified media server.
   * Call start() to begin listening for connections.
   */
  public constructor(staticPath?: string) {
    this.playlist = new PlaylistManager(this.sse, this.handleModeChange.bind(this));
    this.download = new MediaDownloadManager(
      (): string | null => this.deps.getYtDlpPath(),
      (): string | null => this.deps.getFfmpegPath(),
      path.join(app.getPath('userData'), 'downloads')
    );
    this.staticPath = staticPath ?? null;
  }

  /**
   * Registers a callback for playlist mode changes.
   *
   * @param callback - Function called when shuffle/repeat mode changes
   */
  public onModeChange(callback: (shuffle: boolean, repeat: boolean) => void): void {
    this.onModeChangeCallback = callback;
  }

  /**
   * Registers a callback for playlist count changes.
   *
   * @param callback - Function called when playlist item count changes
   */
  public onPlaylistCountChange(callback: (count: number) => void): void {
    this.onPlaylistCountChangeCallback = callback;
  }

  /**
   * Registers a callback for playback state changes.
   *
   * @param callback - Function called when playback state changes
   */
  public onPlaybackStateChange(callback: (isPlaying: boolean) => void): void {
    this.onPlaybackStateChangeCallback = callback;
  }

  /**
   * Registers a callback for dependency state changes.
   *
   * @param callback - Function called when dependency install state changes
   */
  public onDependencyStateChange(callback: (ffmpegInstalled: boolean, fluidsynthInstalled: boolean, openmpt123Installed: boolean) => void): void {
    this.onDependencyStateChangeCallback = callback;
  }

  /**
   * Registers a callback for media type changes.
   *
   * @param callback - Function called when the current media type changes (video or not)
   */
  public onMediaTypeChange(callback: (isVideo: boolean) => void): void {
    this.onMediaTypeChangeCallback = callback;
  }

  /**
   * Registers a callback for recent items changes.
   *
   * @param callback - Function called when recent files or playlists change
   */
  public onRecentItemsChange(callback: (recentFiles: readonly import('./settings-manager.js').RecentItem[], recentPlaylists: readonly import('./settings-manager.js').RecentItem[]) => void): void {
    this.onRecentItemsChangeCallback = callback;
  }

  /**
   * Broadcasts dependency state via SSE and notifies the callback.
   */
  public broadcastDependencyState(): void {
    const preferredSoundFont: string | null = this.settings.getActiveSoundFontFileName();
    const state: DependencyState = this.deps.getState(preferredSoundFont);
    this.sse.broadcast('dependencies:state', state);
    this.onDependencyStateChangeCallback?.(state.ffmpeg.installed, state.fluidsynth.installed, state.openmpt123.installed);
  }

  /**
   * Internal handler for mode changes from PlaylistManager.
   */
  private handleModeChange(shuffle: boolean, repeat: boolean): void {
    this.onModeChangeCallback?.(shuffle, repeat);
  }

  /**
   * Starts the HTTP server.
   *
   * Binds to localhost only for security (127.0.0.1).
   * Uses the port configured in settings, or auto-assigns if set to 0.
   *
   * @returns Promise resolving to the port number
   * @throws Error if server fails to start
   */
  public async start(): Promise<number> {
    return new Promise((resolve: (value: number) => void, reject: (reason: Readonly<Error>) => void): void => {
      this.server = createServer(this.handleRequest.bind(this));
      this.server.on('error', reject);

      // Use configured port, or 0 for auto-assign
      const configuredPort: number = this.settings.getSettings().application.serverPort;

      serverLogger.debug(`Attempting to listen on port ${configuredPort}`);
      this.server.listen(configuredPort, '127.0.0.1', (): void => {
        const address: ReturnType<Server['address']> = this.server!.address();
        if (typeof address === 'object' && address) {
          this.port = address.port;
          serverLogger.info(`Unified media server started on http://127.0.0.1:${this.port}`);
          this.sse.start();
          resolve(this.port);
        } else {
          serverLogger.error('Failed to get server address');
          reject(new Error('Failed to get server address'));
        }
      });
    });
  }

  /**
   * Stops the HTTP server and cleans up resources.
   */
  public stop(): void {
    this.stopTimeTracking();
    this.sse.stop();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /**
   * Gets the per-session token that API requests must present.
   *
   * Handed to the renderer over IPC at startup; never logged.
   *
   * @returns The session bearer token
   */
  public getAuthToken(): string {
    return this.authToken;
  }

  /**
   * Determines whether a request must present the session token.
   *
   * Fail-closed: anything that is not a plain GET is protected, so no mutation
   * is ever reachable anonymously. GETs are protected when they target an API
   * prefix; the remainder are static-asset reads for the Angular bundle.
   */
  private isProtectedRequest(method: string, pathname: string): boolean {
    if (method !== 'GET') {
      return true;
    }

    // In development the Angular app is served by the dev server, so there are
    // no static assets here and every route is an API route.
    if (!this.staticPath) {
      return true;
    }

    return UnifiedMediaServer.API_ROUTE_PREFIXES.some(
      (prefix: string): boolean => pathname === prefix || pathname.startsWith(`${prefix}/`)
    );
  }

  /**
   * Checks the session token supplied by a request, in constant time.
   */
  private isAuthorized(req: Readonly<IncomingMessage>, url: Readonly<URL>): boolean {
    const header: string | string[] | undefined = req.headers['x-onix-token'];
    const headerToken: string | undefined = Array.isArray(header) ? header[0] : header;
    const provided: string = headerToken ?? url.searchParams.get('token') ?? '';

    const providedBuffer: Buffer = Buffer.from(provided, 'utf-8');
    const expectedBuffer: Buffer = Buffer.from(this.authToken, 'utf-8');

    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(providedBuffer, expectedBuffer);
  }

  /**
   * Validates the Host header against the address we actually listen on.
   *
   * Without this a DNS-rebinding attack can point an attacker-controlled
   * hostname at 127.0.0.1 and reach the server from a remote page.
   */
  private isValidHost(req: Readonly<IncomingMessage>): boolean {
    const host: string | undefined = req.headers.host;
    if (!host) {
      return false;
    }

    return (
      host === `127.0.0.1:${this.port}` ||
      host === `localhost:${this.port}` ||
      host === `[::1]:${this.port}`
    );
  }

  /**
   * Returns the origin permitted to make cross-origin requests, or null when
   * none is (the production renderer is same-origin and needs no CORS).
   *
   * In development the Angular dev server is a genuinely different origin, so
   * it is echoed back explicitly rather than using a wildcard.
   */
  private getAllowedOrigin(): string | null {
    return process.env['DEV_SERVER_URL'] ?? null;
  }

  /**
   * Gets the port the server is listening on.
   *
   * @returns The port number, or 0 if not started
   */
  public getPort(): number {
    return this.port;
  }

  /**
   * Gets the settings manager instance.
   *
   * Used by main.ts to access window state settings (miniplayer bounds).
   *
   * @returns The SettingsManager instance
   */
  public getSettingsManager(): SettingsManager {
    return this.settings;
  }

  /**
   * Clears the playlist and resets playback state.
   *
   * Used by main.ts to clear playlist when window closes on macOS.
   * Also resets playback to idle state to prevent stale state on window reopen.
   */
  public clearPlaylist(): void {
    // Stop playback and reset state
    this.playback.state = 'idle';
    this.playback.currentTime = 0;
    this.playback.duration = 0;
    this.playback.currentMedia = null;
    this.playback.errorMessage = null;
    this.stopTimeTracking();

    // Clear the playlist
    this.playlist.clear();

    // Broadcast the reset state
    this.broadcastState();
    this.broadcastTime();
  }

  // ============================================================================
  // HTTP Request Router
  // ============================================================================

  /**
   * Main request handler that routes HTTP requests to appropriate handlers.
   *
   * Handles CORS preflight requests and routes based on path/method.
   * All errors are caught and returned as JSON error responses.
   *
   * @param req - Incoming HTTP request
   * @param res - HTTP response to write to
   */
  private async handleRequest(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const startTime: number = Date.now();
    const url: URL = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    const method: string = req.method || 'GET';
    const pathname: string = url.pathname;

    // Only the development origin is granted CORS; production is same-origin
    // and gets no Access-Control headers at all.
    const allowedOrigin: string | null = this.getAllowedOrigin();
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Onix-Token');
      res.setHeader('Vary', 'Origin');
    }

    // Handle CORS preflight (browsers never attach credentials to a preflight,
    // so this is answered before the auth gate).
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Log request completion
    res.on('finish', (): void => {
      const duration: number = Date.now() - startTime;
      // Skip logging for /events (SSE) and /media/stream (noisy)
      if (pathname !== '/events' && pathname !== '/media/stream') {
        logHttpRequest(method, pathname, res.statusCode ?? 200, duration);
      }
    });

    // Authentication gate. Rejecting here keeps every handler below reachable
    // only by the renderer that was handed the session token over IPC.
    if (this.isProtectedRequest(method, pathname)) {
      if (!this.isValidHost(req)) {
        serverLogger.warn(`[Security] Rejected request with invalid Host header: ${req.headers.host}`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }

      if (!this.isAuthorized(req, url)) {
        serverLogger.warn(`[Security] Rejected unauthenticated request: ${method} ${pathname}`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    try {
      // Route matching
      if (pathname === '/events' && method === 'GET') {
        this.handleSSE(req, res);
      } else if (pathname === '/media/stream' && method === 'GET') {
        this.handleMediaStream(req, res, url);
      } else if (pathname === '/media/info' && method === 'GET') {
        await this.handleMediaInfo(res, url);
      } else if (pathname === '/media/url/info' && method === 'POST') {
        await this.handleUrlInfo(req, res);
      } else if (pathname === '/media/url/download' && method === 'POST') {
        await this.handleUrlDownload(req, res);
      } else if (pathname === '/media/url/resolve' && method === 'POST') {
        await this.handleUrlResolve(req, res);
      } else if (pathname.startsWith('/media/url/status/') && method === 'GET') {
        this.handleUrlStatus(res, pathname);
      } else if (pathname.startsWith('/media/url/cancel/') && method === 'POST') {
        this.handleUrlCancel(res, pathname);
      } else if (pathname === '/media/subtitles' && method === 'GET') {
        this.handleSubtitles(req, res, url);
      } else if (pathname === '/media/subtitles/external' && method === 'GET') {
        this.handleExternalSubtitles(req, res, url);
      } else if (pathname === '/player/play' && method === 'POST') {
        await this.handlePlay(res);
      } else if (pathname === '/player/pause' && method === 'POST') {
        this.handlePause(res);
      } else if (pathname === '/player/stop' && method === 'POST') {
        this.handleStop(res);
      } else if (pathname === '/player/started' && method === 'POST') {
        this.handlePlaybackStarted(res);
      } else if (pathname === '/player/seek' && method === 'POST') {
        await this.handleSeek(req, res);
      } else if (pathname === '/player/sync' && method === 'POST') {
        await this.handleTimeSync(req, res);
      } else if (pathname === '/player/volume' && method === 'POST') {
        await this.handleVolume(req, res);
      } else if (pathname === '/player/state' && method === 'GET') {
        this.handlePlayerState(res);
      } else if (pathname === '/playlist' && method === 'GET') {
        this.handlePlaylistGet(res);
      } else if (pathname === '/playlist/add' && method === 'POST') {
        await this.handlePlaylistAdd(req, res);
      } else if (pathname.startsWith('/playlist/remove/') && method === 'DELETE') {
        await this.handlePlaylistRemove(res, pathname);
      } else if (pathname === '/playlist/clear' && method === 'DELETE') {
        this.handlePlaylistClear(res);
      } else if (pathname.startsWith('/playlist/select/') && method === 'POST') {
        await this.handlePlaylistSelect(res, pathname);
      } else if (pathname === '/playlist/next' && method === 'POST') {
        await this.handlePlaylistNext(res);
      } else if (pathname === '/playlist/previous' && method === 'POST') {
        await this.handlePlaylistPrevious(res);
      } else if (pathname === '/playlist/shuffle' && method === 'POST') {
        await this.handlePlaylistShuffle(req, res);
      } else if (pathname === '/playlist/repeat' && method === 'POST') {
        await this.handlePlaylistRepeat(req, res);
      } else if (pathname === '/playlist/save' && method === 'POST') {
        await this.handlePlaylistSave(req, res);
      } else if (pathname === '/playlist/load' && method === 'POST') {
        await this.handlePlaylistLoad(req, res);
      } else if (pathname === '/playlist/source' && method === 'GET') {
        this.handlePlaylistSource(res);
      } else if (pathname === '/settings' && method === 'GET') {
        this.handleSettingsGet(res);
      } else if (pathname === '/settings/visualization' && method === 'PUT') {
        await this.handleSettingsVisualization(req, res);
      } else if (pathname === '/settings/application' && method === 'PUT') {
        await this.handleSettingsApplication(req, res);
      } else if (pathname === '/settings/playback' && method === 'PUT') {
        await this.handleSettingsPlayback(req, res);
      } else if (pathname === '/settings/transcoding' && method === 'PUT') {
        await this.handleSettingsTranscoding(req, res);
      } else if (pathname === '/settings/appearance' && method === 'PUT') {
        await this.handleSettingsAppearance(req, res);
      } else if (pathname === '/settings/subtitles' && method === 'PUT') {
        await this.handleSettingsSubtitles(req, res);
      } else if (pathname === '/settings/equalizer' && method === 'PUT') {
        await this.handleSettingsEqualizer(req, res);
      } else if (pathname === '/settings/videoAdjustments' && method === 'PUT') {
        await this.handleSettingsVideoAdjustments(req, res);
      } else if (pathname === '/dependencies' && method === 'GET') {
        this.handleDependenciesGet(res);
      } else if (pathname === '/dependencies/install' && method === 'POST') {
        await this.handleDependenciesInstall(req, res);
      } else if (pathname === '/dependencies/uninstall' && method === 'POST') {
        await this.handleDependenciesUninstall(req, res);
      } else if (pathname === '/dependencies/update' && method === 'POST') {
        await this.handleDependenciesUpdate(req, res);
      } else if (pathname === '/dependencies/soundfont/install' && method === 'POST') {
        await this.handleSoundFontInstall(req, res);
      } else if (pathname === '/dependencies/soundfont/remove' && method === 'POST') {
        await this.handleSoundFontRemove(req, res);
      } else if (pathname === '/dependencies/soundfont/select' && method === 'POST') {
        await this.handleSoundFontSelect(req, res);
      } else if (pathname === '/dependencies/refresh' && method === 'POST') {
        this.handleDependenciesRefresh(res);
      } else if (this.staticPath) {
        // Serve static files for Angular app in production
        this.serveStaticFile(req, res, pathname);
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      serverLogger.error(`Request error ${method} ${pathname}: ${err}`);
      const errorMessage: string = err instanceof Error ? err.message : 'Unknown error';

      // Return 413 for body too large errors
      if (errorMessage === 'Request body too large') {
        res.writeHead(413);
        res.end(JSON.stringify({ error: 'Request body too large' }));
      } else {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  }

  // ============================================================================
  // SSE Handler
  // ============================================================================

  /**
   * Handles SSE connection requests.
   *
   * Sets up the response for SSE streaming and sends initial state.
   * The connection is kept alive and used for broadcasting updates.
   *
   * @param req - Incoming HTTP request
   * @param res - HTTP response (becomes SSE stream)
   */
  private handleSSE(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',    });

    this.sse.addClient(res);

    // Send initial state so client is immediately synchronized
    res.write(`event: playback:state\ndata: ${JSON.stringify({ state: this.playback.state, errorMessage: this.playback.errorMessage })}\n\n`);
    res.write(`event: playback:time\ndata: ${JSON.stringify({ currentTime: this.playback.currentTime, duration: this.playback.duration })}\n\n`);
    res.write(`event: playback:volume\ndata: ${JSON.stringify({ volume: this.playback.volume, muted: this.playback.muted })}\n\n`);
    res.write(`event: playlist:updated\ndata: ${JSON.stringify(this.playlist.getState())}\n\n`);
    res.write(`event: settings:updated\ndata: ${JSON.stringify(this.settings.getSettings())}\n\n`);
    const preferredSoundFont: string | null = this.settings.getActiveSoundFontFileName();
    res.write(`event: dependencies:state\ndata: ${JSON.stringify(this.deps.getState(preferredSoundFont))}\n\n`);

    if (this.playback.currentMedia) {
      res.write(`event: playback:loaded\ndata: ${JSON.stringify(this.playback.currentMedia)}\n\n`);
    }

    req.on('close', (): void => {
      // Client cleanup handled by SSEManager
    });
  }

  // ============================================================================
  // Media Streaming
  // ============================================================================

  /**
   * Validates that a file path is safe to serve.
   *
   * Security checks:
   * - Path must be absolute (starts with /)
   * - Path must not contain traversal sequences (..)
   * - File must exist
   * - Path must point to a regular file (not directory, symlink, etc.)
   *
   * @param filePath - The file path to validate
   * @returns Object with valid flag and optional error message
   */
  /**
   * Converts an ISO 639-2/B language code to a human-readable display name.
   *
   * @param code - ISO 639-2/B language code (e.g., 'eng', 'spa')
   * @returns Human-readable language name (e.g., 'English', 'Spanish')
   */
  private getLanguageDisplayName(code: string): string {
    return LANGUAGE_NAMES[code.toLowerCase()] || code.toUpperCase();
  }

  /**
   * Determines whether a media source is a remote http(s) URL rather than a
   * local file path. Used to bypass filesystem checks and force transcoding.
   */
  private static isRemoteUrl(source: string): boolean {
    return /^https?:\/\//i.test(source);
  }

  /**
   * Validates a destination path for playlist writes.
   *
   * Playlists are the only user-named files this server creates, so the path
   * is restricted to an absolute, traversal-free `.opp` location. This bounds
   * the damage of a forged save request to a file the app would legitimately
   * have written anyway.
   *
   * An extension-less path is normalized to `.opp` rather than rejected: the
   * GTK save dialog does not always append the filter's extension, so a user
   * typing a bare filename on Linux must still be able to save.
   *
   * @param filePath - Proposed destination path
   * @returns Validation result carrying the path to actually write to
   */
  private static validatePlaylistSavePath(filePath: string): { valid: boolean; error?: string; normalizedPath?: string } {
    if (filePath.includes('..')) {
      return { valid: false, error: 'Invalid path: traversal not allowed' };
    }

    if (!path.isAbsolute(filePath)) {
      return { valid: false, error: 'Invalid path: must be absolute' };
    }

    if (path.normalize(filePath) !== filePath) {
      return { valid: false, error: 'Invalid path: suspicious path detected' };
    }

    const extension: string = path.extname(filePath).toLowerCase();

    if (extension === '') {
      return { valid: true, normalizedPath: `${filePath}.opp` };
    }

    if (extension !== '.opp') {
      return { valid: false, error: 'Invalid path: playlists must be saved as .opp' };
    }

    return { valid: true, normalizedPath: filePath };
  }

  private validateFilePath(filePath: string): { valid: boolean; error?: string } {
    // Remote http(s) sources (resolved via yt-dlp) are valid as-is — they are
    // consumed by ffprobe/ffmpeg, not the local filesystem. Skip path checks.
    if (UnifiedMediaServer.isRemoteUrl(filePath)) {
      return { valid: true };
    }

    // Check for path traversal attempts
    if (filePath.includes('..')) {
      console.warn(`[Security] Path traversal attempt blocked: ${filePath}`);
      return { valid: false, error: 'Invalid path: traversal not allowed' };
    }

    // Ensure path is absolute
    if (!path.isAbsolute(filePath)) {
      return { valid: false, error: 'Invalid path: must be absolute' };
    }

    // Normalize the path and verify it matches (catches encoded traversal)
    const normalizedPath: string = path.normalize(filePath);
    if (normalizedPath !== filePath && normalizedPath !== filePath.replace(/\/+/g, '/')) {
      console.warn(`[Security] Path normalization mismatch blocked: ${filePath} -> ${normalizedPath}`);
      return { valid: false, error: 'Invalid path: suspicious path detected' };
    }

    // Check file exists
    if (!existsSync(filePath)) {
      return { valid: false, error: 'File not found' };
    }

    // Verify it's a regular file (not directory, symlink to sensitive location, etc.)
    try {
      const stats: Stats = statSync(filePath);
      if (!stats.isFile()) {
        return { valid: false, error: 'Path is not a regular file' };
      }
    } catch {
      return { valid: false, error: 'Cannot access file' };
    }

    return { valid: true };
  }

  /**
   * Routes media stream requests based on file type and codec compatibility.
   *
   * Determines whether the file needs:
   * - Direct serving (native formats with browser-compatible audio)
   * - Transcoding (non-native formats OR native containers with incompatible audio)
   * - MIDI synthesis (MIDI files via FluidSynth)
   *
   * IMPORTANT: Even "native" containers like MP4 may contain audio codecs that
   * browsers cannot decode (e.g., AC3, DTS, TrueHD). These must be transcoded.
   *
   * @param req - Incoming HTTP request
   * @param res - HTTP response to write to
   * @param url - Parsed URL with path parameter
   */
  private handleMediaStream(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, url: Readonly<URL>): void {
    const filePath: string | null = url.searchParams.get('path');
    if (!filePath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing path parameter' }));
      return;
    }

    // Validate file path for security
    const validation: { valid: boolean; error?: string } = this.validateFilePath(filePath);
    if (!validation.valid) {
      res.writeHead(validation.error === 'File not found' ? 404 : 400);
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }

    // Remote URLs cannot use range-based direct serving — ffmpeg reads the URL
    // and remuxes/transcodes it to a fragmented MP4 stream (seekable via -ss).
    if (UnifiedMediaServer.isRemoteUrl(filePath)) {
      const audioUrl: string | undefined = this.dashAudioPairs.get(filePath);
      const cachedInfo: MediaInfo | undefined = this.mediaInfoCache.get(filePath);
      if (audioUrl) {
        // DASH: mux the separate video and audio streams together.
        // Async because it may probe the video's seek keyframe first.
        this.serveDashStream(req, res, filePath, audioUrl, url).catch((err: unknown): void => {
          ffmpegLogger.error(`DASH stream failed: ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) {
            (res as ServerResponse).writeHead(500);
          }
          (res as ServerResponse).end();
        });
      } else if (cachedInfo?.type === 'audio') {
        // Audio-only remote stream (no separate video to map).
        this.serveRemoteAudioStream(req, res, filePath, url);
      } else {
        // Progressive single-file stream: remux/transcode as one input.
        this.serveTranscodedFile(req, res, filePath, url);
      }
      return;
    }

    const ext: string = path.extname(filePath).toLowerCase();
    const isNativeVideo: boolean = NATIVE_VIDEO_FORMATS.has(ext);
    const isNativeAudio: boolean = NATIVE_AUDIO_FORMATS.has(ext);
    const isMidi: boolean = MIDI_FORMATS.has(ext);
    const isTracker: boolean = TRACKER_FORMATS.has(ext);

    if (isMidi) {
      this.serveMidiFile(req, res, filePath);
      return;
    }

    if (isTracker) {
      this.serveTrackerFile(req, res, filePath);
      return;
    }

    // Check if audio codec is browser-compatible (from cached probe data)
    const cachedInfo: MediaInfo | undefined = this.mediaInfoCache.get(filePath);
    const audioCodec: string | undefined = cachedInfo?.audioCodec;

    // For video files, check if audio codec requires transcoding
    if (isNativeVideo && audioCodec) {
      const needsAudioTranscode: boolean = !UnifiedMediaServer.BROWSER_COMPATIBLE_AUDIO_CODECS.has(audioCodec);
      if (needsAudioTranscode) {
        serverLogger.info(`Native container ${ext} has incompatible audio codec "${audioCodec}" - routing to transcoder`);
        this.serveTranscodedFile(req, res, filePath, url);
        return;
      }
    }

    if (isNativeVideo || isNativeAudio) {
      this.serveDirectFile(req, res, filePath, ext);
    } else {
      this.serveTranscodedFile(req, res, filePath, url);
    }
  }

  /**
   * Serves a native format file directly with HTTP range request support.
   *
   * Range requests enable:
   * - Seeking without downloading the entire file
   * - Efficient partial content delivery
   * - Standard browser media element behavior
   *
   * @param req - Incoming HTTP request (may contain Range header)
   * @param res - HTTP response to write to
   * @param filePath - Absolute path to the file
   * @param ext - File extension (for MIME type lookup)
   * @param options - Optional settings (noCache: disable browser caching)
   */
  private serveDirectFile(
    req: Readonly<IncomingMessage>,
    res: Readonly<ServerResponse>,
    filePath: string,
    ext: string,
    options?: {noCache?: boolean}
  ): void {
    try {
      const stat: ReturnType<typeof statSync> = statSync(filePath);
      const fileSize: number = stat.size;
      const mimeType: string = MIME_TYPES[ext] || 'application/octet-stream';
      const range: string | undefined = req.headers.range;

      if (range) {
        // Partial content response (206)
        const parts: string[] = range.replace(/bytes=/, '').split('-');
        const start: number = parseInt(parts[0], 10);
        const end: number = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize: number = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mimeType,          ...(options?.noCache && {'Cache-Control': 'no-store, no-cache, must-revalidate'}),
        });

        createReadStream(filePath, { start, end, highWaterMark: 2 * 1024 * 1024 }).pipe(res); // 2MB buffer for NAS/network latency
      } else {
        // Full file response (200)
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': mimeType,
          'Accept-Ranges': 'bytes',          ...(options?.noCache && {'Cache-Control': 'no-store, no-cache, must-revalidate'}),
        });

        createReadStream(filePath, { highWaterMark: 2 * 1024 * 1024 }).pipe(res); // 2MB buffer for NAS/network latency
      }
    } catch (err) {
      serverLogger.error(`Error serving file: ${err}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Error reading file' }));
    }
  }

  /**
   * Serves static files for the Angular application in production.
   */
  private serveStaticFile(_req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, pathname: string): void {
    if (!this.staticPath) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Map pathname to file, default to index.html for SPA routing
    let filePath: string = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(this.staticPath, filePath);

    // Security: ensure path is within the static directory. The separator
    // matters — a bare prefix check also accepts sibling directories whose
    // name merely starts with the static path.
    const staticRoot: string = this.staticPath.endsWith(path.sep) ? this.staticPath : `${this.staticPath}${path.sep}`;
    if (filePath !== this.staticPath && !filePath.startsWith(staticRoot)) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    if (!existsSync(filePath)) {
      // SPA fallback: serve index.html for unknown routes
      filePath = path.join(this.staticPath, 'index.html');
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
    }

    try {
      const stat: Stats = statSync(filePath);
      if (!stat.isFile()) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      const ext: string = path.extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
      };
      const mimeType: string = mimeTypes[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': stat.size,
      });
      createReadStream(filePath).pipe(res);
    } catch (err) {
      serverLogger.error(`Error serving static file: ${err}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Error reading file' }));
    }
  }

  /**
   * Serves a non-native format via FFmpeg transcoding.
   *
   * Transcoding modes (in order of preference):
   *
   * 1. **Remux mode** (fastest, I/O-bound): When both video and audio codecs are
   *    compatible, stream-copies without re-encoding. Used for MKV with H.264+AAC.
   *
   * 2. **Hybrid mode** (fast): When video is compatible but audio isn't (e.g.,
   *    MP4 with H.264+AC3), copies video and transcodes only audio to AAC.
   *
   * 3. **Full transcode** (slowest, CPU-bound): When video codec is incompatible,
   *    re-encodes both video (H.264) and audio (AAC).
   *
   * 4. **Audio-only transcode**: For audio files (.wma, .ape, .tak) that need
   *    conversion to AAC.
   *
   * @param req - Incoming HTTP request
   * @param res - HTTP response to write to
   * @param filePath - Absolute path to the file
   * @param url - URL containing optional 't' (time) parameter for seeking
   */
  private serveTranscodedFile(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, filePath: string, url: Readonly<URL>): void {
    const seekTime: string = url.searchParams.get('t') || '0';
    const audioTrackParam: string | null = url.searchParams.get('audioTrack');
    const audioTrackIndex: number = audioTrackParam !== null ? parseInt(audioTrackParam, 10) : 0;
    const ext: string = path.extname(filePath).toLowerCase();

    // Determine codec compatibility based on the SELECTED audio track
    // Use cached MediaInfo (populated by probeMedia during playlist add/select)
    const cachedInfo: MediaInfo | undefined = this.mediaInfoCache.get(filePath);
    const videoCodec: string | undefined = cachedInfo?.videoCodec;
    const selectedAudioTrack: AudioTrack | undefined = cachedInfo?.audioTracks?.[audioTrackIndex];
    const audioCodec: string | undefined = selectedAudioTrack?.codec ?? cachedInfo?.audioCodec;

    // Video codecs compatible with MP4 container and browser playback
    const remuxableVideoCodecs: Set<string> = new Set(['h264', 'hevc', 'vp9', 'av1']);
    const canRemuxVideo: boolean = videoCodec !== undefined && remuxableVideoCodecs.has(videoCodec);
    const canRemuxAudio: boolean = audioCodec !== undefined && UnifiedMediaServer.REMUXABLE_AUDIO_CODECS.has(audioCodec);
    const canRemux: boolean = canRemuxVideo && canRemuxAudio;

    // Hybrid mode: video can be copied but audio needs transcoding
    const needsHybridTranscode: boolean = canRemuxVideo && !canRemuxAudio && audioCodec !== undefined;

    ffmpegLogger.debug(`Codec check: video=${videoCodec} (remuxable=${canRemuxVideo}), audio[${audioTrackIndex}]=${audioCodec} (remuxable=${canRemuxAudio}), canRemux=${canRemux}, hybrid=${needsHybridTranscode}`);

    // Determine if this is audio-only transcoding
    const isAudioTranscode: boolean = ['.wma', '.ape', '.tak'].includes(ext);

    // Get transcoding settings
    const transcodingSettings: {videoQuality: string; audioBitrate: number} = {
      videoQuality: this.settings.getSettings().transcoding.videoQuality,
      audioBitrate: this.settings.getSettings().transcoding.audioBitrate,
    };

    // Convert video quality to CRF value (lower = better quality)
    const crfMap: Record<string, string> = {low: '28', medium: '23', high: '18'};
    const crfValue: string = crfMap[transcodingSettings.videoQuality] || '23';

    // Convert audio bitrate to FFmpeg format
    const audioBitrateStr: string = `${transcodingSettings.audioBitrate}k`;

    // Determine transcoding mode for logging
    const mode: string = isAudioTranscode ? 'audio-only' : canRemux ? 'remux' : needsHybridTranscode ? 'hybrid' : 'full';
    ffmpegLogger.info(`Transcoding: ${path.basename(filePath)} (mode: ${mode}, seek: ${seekTime}s, audioTrack: ${audioTrackIndex}/${audioCodec}, crf: ${crfValue}, audio: ${audioBitrateStr})`);

    let ffmpegArgs: string[];

    if (isAudioTranscode) {
      // Audio-only transcoding to AAC/ADTS
      ffmpegArgs = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-ss', seekTime,
        '-i', filePath,
        '-c:a', 'aac',
        '-b:a', audioBitrateStr,
        '-ar', '48000',
        '-f', 'adts',
        'pipe:1'
      ];
      res.writeHead(200, {
        'Content-Type': 'audio/aac',
        'Transfer-Encoding': 'chunked',        'Cache-Control': 'no-cache',
      });
    } else if (canRemux) {
      // Remux mode: stream copy (no re-encoding) for compatible codecs
      // This is I/O-bound, not CPU-bound, so playback starts instantly
      // IMPORTANT: Always use explicit stream mapping to select specific tracks
      // Note: Stream copy preserves original A/V sync, but -avoid_negative_ts helps
      // with timestamp normalization for fragmented MP4 output
      ffmpegArgs = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-ss', seekTime,            // Seek before input (fast seek to nearest keyframe)
        '-i', filePath,
        '-map', '0:v:0',            // Map first video stream
        '-map', `0:a:${audioTrackIndex}`, // Map selected audio stream only
        '-c:v', 'copy',             // Copy video stream without re-encoding
        '-c:a', 'copy',             // Copy audio stream without re-encoding
        '-avoid_negative_ts', 'make_zero', // Normalize timestamps to start at zero
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof', // Fragmented MP4 for streaming
        '-f', 'mp4',
        'pipe:1'
      ];
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Transfer-Encoding': 'chunked',        'Cache-Control': 'no-cache',
      });
    } else if (needsHybridTranscode) {
      // Hybrid mode: copy video, transcode audio only
      // Much faster than full transcode when video is already H.264/HEVC
      // Common case: MP4/MKV with H.264 video + AC3/DTS/TrueHD audio
      //
      // A/V sync strategy for hybrid mode (video copy + audio transcode):
      // - Input seeking for fast keyframe-based positioning
      // - Video is copied as-is (timestamps preserved in stream)
      // - Audio is transcoded and synced to video using aresample filter
      // - The async parameter stretches/compresses audio to match video timing
      ffmpegArgs = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-ss', seekTime,            // Input seeking (fast seek to nearest keyframe)
        '-i', filePath,
        '-map', '0:v:0',            // Map first video stream
        '-map', `0:a:${audioTrackIndex}`, // Map selected audio stream
        '-c:v', 'copy',             // Copy video without re-encoding
        '-c:a', 'aac',              // Transcode audio to AAC
        '-b:a', audioBitrateStr,    // Audio bitrate from settings
        '-ar', '48000',             // Sample rate
        '-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0', // Sync audio to video
        '-avoid_negative_ts', 'make_zero', // Normalize negative timestamps
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof', // Fragmented MP4 for streaming
        '-f', 'mp4',
        'pipe:1'
      ];
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Transfer-Encoding': 'chunked',        'Cache-Control': 'no-cache',
      });
    } else {
      // Full transcode mode: re-encode video and audio for incompatible codecs
      // IMPORTANT: Always use explicit stream mapping for predictable results
      //
      // Hardware acceleration significantly reduces CPU usage:
      // - VideoToolbox (macOS): Uses Apple's hardware encoder
      // - NVENC (NVIDIA): Uses GPU encoder on NVIDIA cards
      // - Quick Sync (Intel): Uses Intel iGPU encoder
      // - AMF (AMD): Uses AMD GPU encoder (Windows only)
      // - VAAPI (Linux): Generic Linux hardware acceleration
      // Falls back to libx264 software encoding if no hardware encoder available

      // Select video encoder based on settings and available hardware
      const encoderConfig: {encoder: string; extraArgs: string[]} = this.selectVideoEncoder();
      ffmpegLogger.info(`Using encoder: ${encoderConfig.encoder}`);

      // A/V sync strategy for full transcode mode:
      // - Input seeking (-ss before -i) for fast approximate positioning
      // - Both streams re-encoded with setpts/asetpts to reset PTS to 0
      // - This ensures perfect A/V sync since both streams start fresh
      ffmpegArgs = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-threads', '0',            // Use all available CPU cores
        '-probesize', '10M',        // Analyze 10MB for stream detection
        '-analyzeduration', '5000000', // Analyze 5 seconds for timestamps
        '-ss', seekTime,            // Input seeking (fast seek)
        '-i', filePath,
        '-map', '0:v:0',            // Map first video stream explicitly
        '-map', `0:a:${audioTrackIndex}`, // Map selected audio stream explicitly
        '-c:v', encoderConfig.encoder,
        ...encoderConfig.extraArgs, // Encoder-specific arguments
        '-profile:v', 'high',
        '-level', '5.1',            // Level 5.1 supports 4K (level 4.1 only supports 1080p)
        '-pix_fmt', 'yuv420p',      // Maximum compatibility
        '-crf', crfValue,           // Quality level from settings (may be ignored by some hw encoders)
        '-maxrate', '20M',          // Max bitrate for VBV buffering
        '-bufsize', '8M',           // VBV buffer size for smooth delivery
        '-g', '30',                 // GOP size: keyframe every 30 frames (~1s at 30fps)
        '-bf', '0',                 // No B-frames for low latency
        '-sc_threshold', '0',       // Disable scene change keyframes for consistent timing
        '-vf', 'setpts=PTS-STARTPTS', // Reset video timestamps to start at 0
        '-c:a', 'aac',
        '-b:a', audioBitrateStr,    // Audio bitrate from settings
        '-ar', '48000',
        '-af', 'asetpts=PTS-STARTPTS', // Reset audio timestamps to start at 0
        '-avoid_negative_ts', 'make_zero', // Normalize negative timestamps
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof', // Fragmented MP4 for streaming
        '-f', 'mp4',
        'pipe:1'
      ];
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Transfer-Encoding': 'chunked',        'Cache-Control': 'no-cache',
      });
    }

    const ffmpegBin: string | null = this.deps.getFfmpegPath();
    if (!ffmpegBin) {
      ffmpegLogger.error('ffmpeg binary not found');
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'ffmpeg not found' }));
      return;
    }
    logProcessSpawn(ffmpegLogger, 'ffmpeg', ffmpegArgs);
    const ffmpeg: ChildProcess = spawn(ffmpegBin, ffmpegArgs);
    ffmpeg.stdout?.pipe(res);

    ffmpeg.stderr?.on('data', (data: Readonly<Buffer>): void => {
      logProcessOutput(ffmpegLogger, 'stderr', data.toString());
    });

    ffmpeg.on('error', (err: Readonly<Error>): void => {
      ffmpegLogger.error(`FFmpeg spawn error: ${err.message}`);
      if (!res.headersSent) {
        (res as ServerResponse).writeHead(500);
      }
      (res as ServerResponse).end();
    });

    ffmpeg.on('close', (code: number | null): void => {
      logProcessExit(ffmpegLogger, 'ffmpeg', code, null);
    });

    // Clean up FFmpeg process when client disconnects
    const cleanup: () => void = (): void => {
      if (ffmpeg.exitCode === null) {
        ffmpeg.kill('SIGKILL');
      }
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  /**
   * Streams a remote DASH source by muxing its separate video and audio streams
   * into a fragmented MP4 with ffmpeg (stream copy — no re-encoding).
   *
   * This is what enables resolutions above 360p for sites like YouTube, which
   * only offer combined audio+video up to 360p; higher resolutions arrive as
   * separate adaptive streams that must be muxed.
   *
   * @param req - Incoming HTTP request
   * @param res - HTTP response to write to
   * @param videoUrl - Direct URL of the video-only stream
   * @param audioUrl - Direct URL of the audio-only stream
   * @param url - URL with optional 't' (seek time) parameter
   */
  private async serveDashStream(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, videoUrl: string, audioUrl: string, url: Readonly<URL>): Promise<void> {
    const requestedSeek: number = parseFloat(url.searchParams.get('t') || '0') || 0;
    const audioBitrate: number = this.settings.getSettings().transcoding.audioBitrate;

    // A/V SYNC ON SEEK: the two inputs seek independently — the video input's
    // -ss snaps to the nearest keyframe BEFORE the target (up to a full GOP
    // early) while the audio input lands almost exactly on it. FFmpeg resets
    // each input's timestamps to zero at its own landing point and the
    // browser plays both tracks from their first samples together, so audio
    // ends up ahead of video by the keyframe gap on every seek. (Encoding
    // the gap as a timestamp offset via -copyts doesn't help — Chromium's
    // progressive fMP4 playback aligns the track starts regardless.)
    //
    // Fix: probe where the video seek will actually land (its keyframe) and
    // seek BOTH inputs to that exact time, so the streams genuinely start at
    // the same instant. Falls back to the requested time if the probe fails.
    let seekTime: number = requestedSeek;
    if (requestedSeek > 0) {
      const keyframeTime: number | null = await this.probeSeekKeyframe(videoUrl, requestedSeek);
      if (keyframeTime !== null) {
        seekTime = keyframeTime;
        // Snap the playback clock (and the client's stream offset, via the
        // aligned broadcast) to where the content actually starts, so the
        // seek bar matches the content instead of sitting a keyframe ahead
        this.alignPlaybackToKeyframe(requestedSeek, keyframeTime);
      }
    }

    ffmpegLogger.info(`DASH mux stream (seek: ${requestedSeek}s → keyframe: ${seekTime}s)`);

    // Video is stream-copied (keeps the original HD/4K quality, no CPU cost).
    // Audio is transcoded to AAC because the adaptive audio is often Opus, which
    // cannot be stream-copied into an MP4 container. Audio is cheap to encode.
    const ffmpegArgs: string[] = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-ss', String(seekTime),    // Seek each input before reading (fast keyframe seek)
      '-i', videoUrl,
      '-ss', String(seekTime),
      '-i', audioUrl,
      '-map', '0:v:0',            // Video from the first input
      '-map', '1:a:0',            // Audio from the second input
      '-c:v', 'copy',             // Copy video as-is
      '-c:a', 'aac',              // Transcode audio (handles Opus → AAC for MP4)
      '-b:a', `${audioBitrate}k`,
      '-avoid_negative_ts', 'make_zero',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', // Fragmented MP4 for streaming
      '-f', 'mp4',
      'pipe:1'
    ];
    this.streamFfmpeg(req, res, ffmpegArgs, 'video/mp4');
  }

  /**
   * Snaps the playback clock to the keyframe a DASH seek actually landed on,
   * and broadcasts the alignment so the client can adopt the keyframe time
   * as its stream offset. Without this the seek bar (anchored to the
   * requested time) would sit up to a full GOP ahead of the content for the
   * rest of playback.
   *
   * Only rebases when this stream request is serving the player's current
   * seek — a stale or retried stream request must not move the clock.
   *
   * @param requestedTime - The seek position the client asked for
   * @param keyframeTime - The keyframe position the stream actually starts at
   */
  private alignPlaybackToKeyframe(requestedTime: number, keyframeTime: number): void {
    if (this.playback.state === 'playing') {
      // The clock has kept running since the seek (probe + request latency)
      if (Math.abs(this.playback.currentTime - requestedTime) < this.SEEK_ALIGN_WINDOW_S) {
        this.playback.currentTime = keyframeTime;
        this.startTime = Date.now() - (keyframeTime * 1000);
        this.broadcastTime();
      }
    } else if (this.playback.state === 'paused' || this.playback.state === 'stopped') {
      if (Math.abs(this.playback.currentTime - requestedTime) < this.SEEK_ALIGN_WINDOW_S) {
        this.playback.currentTime = keyframeTime;
        this.pausedTime = keyframeTime;
        this.broadcastTime();
      }
    }

    // Tell the client where the stream really starts so its offset-based
    // time math (seek bar, drift sync) matches the content
    this.sse.broadcast('playback:seek:aligned', {requested: requestedTime, actual: keyframeTime});
  }

  /**
   * Probes where an input-side -ss seek will actually land in a video stream:
   * ffprobe seeks the same way ffmpeg does (nearest keyframe before the
   * target) and reports the first packet's timestamp.
   *
   * Used by the DASH muxer to seek the separate video and audio inputs to the
   * SAME instant, keeping them in sync after a seek.
   *
   * @param videoUrl - The video stream URL to probe
   * @param seekTime - The requested seek position in seconds
   * @returns The keyframe timestamp the seek lands on, or null if the probe
   *   fails or times out (caller falls back to the requested time)
   */
  private probeSeekKeyframe(videoUrl: string, seekTime: number): Promise<number | null> {
    const ffprobeBin: string | null = this.deps.getFfprobePath();
    if (!ffprobeBin) {
      return Promise.resolve(null);
    }

    return new Promise<number | null>((resolve: (value: number | null) => void): void => {
      const args: string[] = [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-read_intervals', `${seekTime}%+#1`,   // Seek to the target, read one packet
        '-show_entries', 'packet=pts_time',
        '-of', 'csv=p=0',
        videoUrl,
      ];

      logProcessSpawn(ffmpegLogger, 'ffprobe', args);
      const probe: ChildProcess = spawn(ffprobeBin, args);

      let output: string = '';
      let settled: boolean = false;

      const finish: (value: number | null) => void = (value: number | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const timeout: ReturnType<typeof setTimeout> = setTimeout((): void => {
        ffmpegLogger.warn(`Keyframe probe timed out after ${this.KEYFRAME_PROBE_TIMEOUT_MS}ms`);
        probe.kill('SIGKILL');
        finish(null);
      }, this.KEYFRAME_PROBE_TIMEOUT_MS);

      probe.stdout?.on('data', (data: Readonly<Buffer>): void => {
        output += data.toString();
      });

      probe.on('close', (): void => {
        clearTimeout(timeout);
        const value: number = parseFloat(output.trim().split('\n')[0]);
        if (Number.isFinite(value) && value >= 0) {
          finish(value);
        } else {
          ffmpegLogger.warn(`Keyframe probe returned no usable timestamp (output: "${output.trim()}")`);
          finish(null);
        }
      });

      probe.on('error', (err: Readonly<Error>): void => {
        clearTimeout(timeout);
        ffmpegLogger.warn(`Keyframe probe failed: ${err.message}`);
        finish(null);
      });
    });
  }

  /**
   * Streams a remote audio-only source (single stream, no video to map) as a
   * raw ADTS AAC stream. The audio is transcoded to AAC since the source is
   * commonly Opus; ADTS (rather than fragmented MP4) is used because it plays
   * progressively in an <audio> element over a chunked, non-seekable response —
   * this mirrors the local audio-transcode path used for .wma/.ape/.tak files.
   *
   * @param req - Incoming HTTP request
   * @param res - HTTP response to write to
   * @param audioUrl - Direct URL of the audio stream
   * @param url - URL with optional 't' (seek time) parameter
   */
  private serveRemoteAudioStream(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, audioUrl: string, url: Readonly<URL>): void {
    const seekTime: string = url.searchParams.get('t') || '0';
    const audioBitrate: number = this.settings.getSettings().transcoding.audioBitrate;
    ffmpegLogger.info(`Remote audio stream (seek: ${seekTime}s)`);

    const ffmpegArgs: string[] = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-ss', seekTime,
      '-i', audioUrl,
      '-c:a', 'aac',              // Transcode to AAC (Opus, Vorbis, etc.)
      '-b:a', `${audioBitrate}k`,
      '-ar', '48000',
      '-f', 'adts',               // Raw AAC stream — plays progressively in <audio>
      'pipe:1'
    ];
    this.streamFfmpeg(req, res, ffmpegArgs, 'audio/aac');
  }

  /**
   * Spawns ffmpeg with the given arguments and pipes its stdout to the response
   * as a chunked stream. Handles process errors and kills ffmpeg when the client
   * disconnects. Shared by the remote DASH and audio stream handlers.
   *
   * @param req - Incoming HTTP request (used to detect client disconnect)
   * @param res - HTTP response to stream to
   * @param ffmpegArgs - Arguments for ffmpeg (must end with 'pipe:1')
   * @param contentType - MIME type for the response
   */
  private streamFfmpeg(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, ffmpegArgs: string[], contentType: string): void {
    const ffmpegBin: string | null = this.deps.getFfmpegPath();
    if (!ffmpegBin) {
      ffmpegLogger.error('ffmpeg binary not found');
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'ffmpeg not found' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Transfer-Encoding': 'chunked',      'Cache-Control': 'no-cache',
    });

    logProcessSpawn(ffmpegLogger, 'ffmpeg', ffmpegArgs);
    const ffmpeg: ChildProcess = spawn(ffmpegBin, ffmpegArgs);
    ffmpeg.stdout?.pipe(res);

    ffmpeg.stderr?.on('data', (data: Readonly<Buffer>): void => {
      logProcessOutput(ffmpegLogger, 'stderr', data.toString());
    });

    ffmpeg.on('error', (err: Readonly<Error>): void => {
      ffmpegLogger.error(`FFmpeg spawn error: ${err.message}`);
      if (!res.headersSent) {
        (res as ServerResponse).writeHead(500);
      }
      (res as ServerResponse).end();
    });

    ffmpeg.on('close', (code: number | null): void => {
      logProcessExit(ffmpegLogger, 'ffmpeg', code, null);
    });

    const cleanup: () => void = (): void => {
      if (ffmpeg.exitCode === null) {
        ffmpeg.kill('SIGKILL');
      }
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  /**
   * Computes a content-hash filename for a MIDI file.
   * Includes the soundfont path in the hash for cache invalidation when
   * the soundfont changes.
   *
   * @param filePath - Absolute path to the MIDI file
   * @returns 16-character hex hash string
   */
  private hashMidiFile(filePath: string): string {
    const content: Buffer = readFileSync(filePath);
    const soundfont: string = this.findSoundFont() ?? '';
    const hash: string = createHash('sha256').update(soundfont).update(content).digest('hex').slice(0, 16);
    midiLogger.info(`hashMidiFile: soundfont="${soundfont}", hash="${hash}"`);
    return hash;
  }

  /**
   * Pre-renders a MIDI file to a temporary MP3 file for seekable playback.
   *
   * MIDI files are synthesized via FluidSynth, which always renders from the
   * beginning. Pre-rendering to a temp file allows the audio element to seek
   * natively using HTTP range requests, eliminating the need for re-streaming
   * on every seek operation.
   *
   * Results are cached so repeated plays of the same MIDI file are instant.
   * Uses content-hash filenames so renders persist across app restarts.
   * Concurrent renders of the same file are deduplicated.
   *
   * Pipeline: MIDI → FluidSynth (raw PCM) → FFmpeg (MP3) → temp file
   *
   * @param filePath - Absolute path to the MIDI file
   * @returns Promise resolving to the temp MP3 file path
   */
  /**
   * Adds an entry to the MIDI render cache, evicting the oldest entry
   * (FIFO) if the cache exceeds the maximum size.
   */
  private setMidiRenderCache(filePath: string, entry: {readonly tempFile: string; readonly duration: number}): void {
    if (this.midiRenderCache.size >= UnifiedMediaServer.MAX_MIDI_CACHE_SIZE) {
      const oldest: string = this.midiRenderCache.keys().next().value!;
      this.midiRenderCache.delete(oldest);
      midiLogger.info(`MIDI cache evicted oldest entry: ${path.basename(oldest)}`);
    }
    this.midiRenderCache.set(filePath, entry);
  }

  private renderMidiToFile(filePath: string): Promise<string> {
    // 1. In-memory cache hit
    const cached: {readonly tempFile: string; readonly duration: number} | undefined = this.midiRenderCache.get(filePath);
    if (cached && existsSync(cached.tempFile)) {
      midiLogger.info(`Using cached render: ${path.basename(cached.tempFile)}`);
      return Promise.resolve(cached.tempFile);
    }

    // 2. Deduplicate concurrent renders of the same file
    const inProgress: Promise<string> | undefined = this.midiRenderInProgress.get(filePath);
    if (inProgress) {
      midiLogger.info('Waiting for in-progress render...');
      return inProgress;
    }

    // 3. Compute content-hash filename (deterministic across restarts)
    const hash: string = this.hashMidiFile(filePath);
    const tempDir: string = path.join(app.getPath('temp'), 'onixplayer-midi');
    mkdirSync(tempDir, {recursive: true});
    const tempFile: string = path.join(tempDir, `midi-${hash}.mp3`);

    // 4. Disk cache hit — probe for duration, populate in-memory cache.
    //    If the file is corrupt (probe fails or size is 0), delete and re-render.
    if (existsSync(tempFile)) {
      const fileSize: number = statSync(tempFile).size;
      if (fileSize === 0) {
        midiLogger.info(`Disk cache corrupt (empty file), deleting: ${path.basename(tempFile)}`);
        try { unlinkSync(tempFile); } catch { /* ignore cleanup errors */ }
      } else {
        midiLogger.info(`Disk cache hit: ${path.basename(tempFile)} (${fileSize} bytes)`);
        const diskPromise: Promise<string> = this.probeMedia(tempFile).then((info: MediaInfo): string => {
          this.setMidiRenderCache(filePath, {tempFile, duration: info.duration});
          this.playlist.updateItemDurations(filePath, info.duration);
          this.midiRenderInProgress.delete(filePath);
          midiLogger.info(`Disk cache loaded: ${path.basename(tempFile)} (${info.duration.toFixed(1)}s)`);
          return tempFile;
        }).catch((): Promise<string> => {
          // Probe failed — file is likely corrupt. Delete and trigger a full re-render.
          midiLogger.warn(`Disk cache corrupt (probe failed), deleting: ${path.basename(tempFile)}`);
          try { unlinkSync(tempFile); } catch { /* ignore cleanup errors */ }
          this.midiRenderInProgress.delete(filePath);
          return this.renderMidiToFile(filePath);
        });
        this.midiRenderInProgress.set(filePath, diskPromise);
        return diskPromise;
      }
    }

    // 5. Full render: FluidSynth → FFmpeg → tempFile
    const promise: Promise<string> = new Promise<string>((resolve: (value: string) => void, reject: (reason: Error) => void): void => {
      // Validate dependencies
      const soundfont: string | undefined = this.findSoundFont();
      const fluidsynthBin: string | null = this.deps.getFluidsynthPath();
      const ffmpegBin: string | null = this.deps.getFfmpegPath();

      if (!soundfont || !fluidsynthBin || !ffmpegBin) {
        reject(new Error('Missing dependencies for MIDI rendering'));
        return;
      }

      const audioBitrate: number = this.settings.getSettings().transcoding.audioBitrate;

      midiLogger.info(`Pre-rendering MIDI: ${path.basename(filePath)} → ${path.basename(tempFile)}`);
      midiLogger.info(`Using SoundFont: ${soundfont}`);

      // Spawn FluidSynth: MIDI → raw PCM
      const fluidsynthArgs: string[] = [
        '-ni',           // Non-interactive mode
        '-g', '1.0',     // Gain: 5x default (0.2) for louder MIDI output
        '-T', 'raw',     // Output format: raw PCM
        '-F', '-',       // Output to stdout
        '-r', '44100',   // Sample rate: 44.1kHz
        soundfont,
        filePath
      ];

      midiLogger.info(`FluidSynth command: ${fluidsynthBin} ${fluidsynthArgs.join(' ')}`);
      logProcessSpawn(midiLogger, 'fluidsynth (pre-render)', fluidsynthArgs);
      const fluidsynth: ChildProcess = spawn(fluidsynthBin, fluidsynthArgs);

      // Spawn FFmpeg: raw PCM → MP3 file
      const ffmpegArgs: string[] = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-f', 's16le',        // Input: signed 16-bit little-endian PCM
        '-ar', '44100',       // Input sample rate
        '-ac', '2',           // Input channels: stereo
        '-i', 'pipe:0',       // Read from stdin
        '-c:a', 'libmp3lame', // Encode as MP3
        '-b:a', `${audioBitrate}k`,
        '-f', 'mp3',          // Output format
        tempFile               // Write to temp file
      ];

      logProcessSpawn(ffmpegLogger, 'ffmpeg (pre-render)', ffmpegArgs);
      const ffmpeg: ChildProcess = spawn(ffmpegBin, ffmpegArgs);

      // Connect pipeline: FluidSynth stdout → FFmpeg stdin
      fluidsynth.stdout?.pipe(ffmpeg.stdin!);

      // Log stderr output (only suppress the version banner line, keep warnings/errors)
      fluidsynth.stderr?.on('data', (data: Readonly<Buffer>): void => {
        const msg: string = data.toString().trim();
        if (msg && !msg.includes('FluidSynth runtime version')) {
          logProcessOutput(midiLogger, 'stderr', msg);
        }
      });

      ffmpeg.stderr?.on('data', (data: Readonly<Buffer>): void => {
        logProcessOutput(ffmpegLogger, 'stderr', data.toString());
      });

      // Close FFmpeg stdin when FluidSynth finishes
      fluidsynth.on('close', (code: number | null): void => {
        logProcessExit(midiLogger, 'fluidsynth (pre-render)', code, null);
        ffmpeg.stdin?.end();
      });

      // Resolve when FFmpeg finishes writing the file.
      // Probe the rendered MP3 for accurate duration.
      ffmpeg.on('close', (code: number | null): void => {
        logProcessExit(ffmpegLogger, 'ffmpeg (pre-render)', code, null);
        this.midiRenderInProgress.delete(filePath);

        if (code === 0 && existsSync(tempFile)) {
          this.probeMedia(tempFile).then((info: MediaInfo): void => {
            this.setMidiRenderCache(filePath, {tempFile, duration: info.duration});
            this.playlist.updateItemDurations(filePath, info.duration);
            midiLogger.info(`Pre-render complete: ${path.basename(tempFile)} (${info.duration.toFixed(1)}s)`);
            resolve(tempFile);
          }).catch((): void => {
            this.setMidiRenderCache(filePath, {tempFile, duration: 0});
            midiLogger.info(`Pre-render complete: ${path.basename(tempFile)} (duration unknown)`);
            resolve(tempFile);
          });
        } else {
          // Delete partial temp file to prevent corrupt disk cache hits
          if (existsSync(tempFile)) {
            try { unlinkSync(tempFile); } catch { /* ignore cleanup errors */ }
          }
          reject(new Error(`MIDI pre-render failed with exit code ${code}`));
        }
      });

      // Handle spawn errors
      fluidsynth.on('error', (err: Readonly<Error>): void => {
        midiLogger.error(`FluidSynth pre-render error: ${err.message}`);
        this.midiRenderInProgress.delete(filePath);
        ffmpeg.kill();
        if (existsSync(tempFile)) {
          try { unlinkSync(tempFile); } catch { /* ignore cleanup errors */ }
        }
        reject(err);
      });

      ffmpeg.on('error', (err: Readonly<Error>): void => {
        ffmpegLogger.error(`FFmpeg pre-render error: ${err.message}`);
        this.midiRenderInProgress.delete(filePath);
        if (existsSync(tempFile)) {
          try { unlinkSync(tempFile); } catch { /* ignore cleanup errors */ }
        }
        reject(err);
      });
    });

    this.midiRenderInProgress.set(filePath, promise);
    return promise;
  }

  /**
   * Serves a MIDI file, using the pre-rendered cache when available.
   *
   * If the MIDI file has been pre-rendered to a temp MP3 file (via
   * renderMidiToFile), serves that file with HTTP range request support
   * for native seeking. Falls back to live streaming pipeline otherwise.
   *
   * @param req - Incoming HTTP request
   * @param res - HTTP response to write to
   * @param filePath - Absolute path to the MIDI file
   */
  private serveMidiFile(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, filePath: string): void {
    // Serve pre-rendered file if available (supports range requests for seeking)
    const cached: {readonly tempFile: string; readonly duration: number} | undefined = this.midiRenderCache.get(filePath);
    if (cached && existsSync(cached.tempFile)) {
      // Inline duration correction (safety net for edge case: render finished
      // after probeMedia returned but before playback started)
      if (cached.duration > 0 && Math.abs(cached.duration - this.playback.duration) > 1) {
        this.playback.duration = cached.duration;
        this.broadcastTime();
      }
      midiLogger.info(`Serving pre-rendered MIDI: ${path.basename(cached.tempFile)}`);
      this.serveDirectFile(req, res, cached.tempFile, '.mp3', {noCache: true});
      return;
    }

    // Render to temp file on demand, then serve with range request support.
    // The HTTP response is held open until the render completes.
    midiLogger.info(`Rendering MIDI on demand: ${path.basename(filePath)}`);
    this.renderMidiToFile(filePath).then((tempFile: string): void => {
      const entry: {readonly tempFile: string; readonly duration: number} | undefined = this.midiRenderCache.get(filePath);
      if (entry && entry.duration > 0 && Math.abs(entry.duration - this.playback.duration) > 1) {
        this.playback.duration = entry.duration;
        this.broadcastTime();
      }
      this.serveDirectFile(req, res, tempFile, '.mp3', {noCache: true});
    }).catch((err: Error): void => {
      midiLogger.error(`MIDI render failed: ${err.message}`);
      if (!res.headersSent) {
        (res as ServerResponse).writeHead(500);
      }
      (res as ServerResponse).end(JSON.stringify({error: `MIDI render failed: ${err.message}`}));
    });
  }

  /**
   * Finds the first available SoundFont file.
   * Delegates to DependencyManager which checks user-installed and system paths.
   * Uses the user's preferred soundfont if set in settings.
   *
   * @returns Path to SoundFont file, or undefined if none found
   */
  private findSoundFont(): string | undefined {
    const preferredSoundFont: string | null = this.settings.getActiveSoundFontFileName();
    const result: string | undefined = this.deps.findSoundFont(preferredSoundFont);
    midiLogger.info(`findSoundFont: preferred="${preferredSoundFont}", resolved="${result}"`);
    return result;
  }

  // ============================================================================
  // Tracker Modules (openmpt123)
  // ============================================================================

  /**
   * Computes a content-hash filename for a tracker module file.
   *
   * @param filePath - Absolute path to the tracker module
   * @returns 16-character hex hash string
   */
  private hashTrackerFile(filePath: string): string {
    const content: Buffer = readFileSync(filePath);
    // The version tag ('v2') is part of the cache key so that changes to the
    // render pipeline invalidate stale on-disk renders (e.g. the empty files
    // produced before the openmpt123 --batch fix) without manual cleanup.
    return createHash('sha256').update('tracker-v2').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Adds an entry to the tracker render cache, evicting the oldest entry
   * (FIFO) if the cache exceeds the maximum size.
   */
  private setTrackerRenderCache(filePath: string, entry: {readonly tempFile: string; readonly duration: number}): void {
    if (this.trackerRenderCache.size >= UnifiedMediaServer.MAX_TRACKER_CACHE_SIZE) {
      const oldest: string = this.trackerRenderCache.keys().next().value!;
      this.trackerRenderCache.delete(oldest);
      midiLogger.info(`Tracker cache evicted oldest entry: ${path.basename(oldest)}`);
    }
    this.trackerRenderCache.set(filePath, entry);
  }

  /**
   * Pre-renders a tracker module to a temporary MP3 file for seekable playback.
   *
   * Tracker modules (Oktalyzer, MOD, XM, IT, ...) are decoded to PCM by
   * openmpt123 (libopenmpt) and encoded to MP3 by FFmpeg. Pre-rendering to a
   * temp file lets the audio element seek natively via HTTP range requests,
   * exactly like the MIDI pipeline.
   *
   * Results are cached (in-memory + content-hashed on disk) and concurrent
   * renders of the same file are deduplicated.
   *
   * Pipeline: module → openmpt123 (raw PCM via stdout) → FFmpeg (MP3) → temp file
   *
   * @param filePath - Absolute path to the tracker module
   * @returns Promise resolving to the temp MP3 file path
   */
  private renderTrackerToFile(filePath: string): Promise<string> {
    // 1. In-memory cache hit
    const cached: {readonly tempFile: string; readonly duration: number} | undefined = this.trackerRenderCache.get(filePath);
    if (cached && existsSync(cached.tempFile)) {
      midiLogger.info(`Using cached tracker render: ${path.basename(cached.tempFile)}`);
      return Promise.resolve(cached.tempFile);
    }

    // 2. Deduplicate concurrent renders of the same file
    const inProgress: Promise<string> | undefined = this.trackerRenderInProgress.get(filePath);
    if (inProgress) {
      midiLogger.info('Waiting for in-progress tracker render...');
      return inProgress;
    }

    // 3. Compute content-hash filename (deterministic across restarts)
    const hash: string = this.hashTrackerFile(filePath);
    const tempDir: string = path.join(app.getPath('temp'), 'onixplayer-tracker');
    mkdirSync(tempDir, {recursive: true});
    const tempFile: string = path.join(tempDir, `tracker-${hash}.mp3`);

    // 4. Disk cache hit — probe for duration, populate in-memory cache.
    //    If the file is corrupt (probe fails or size is 0), delete and re-render.
    if (existsSync(tempFile)) {
      const fileSize: number = statSync(tempFile).size;
      if (fileSize === 0) {
        midiLogger.info(`Tracker disk cache corrupt (empty file), deleting: ${path.basename(tempFile)}`);
        try { unlinkSync(tempFile); } catch { /* ignore cleanup errors */ }
      } else {
        midiLogger.info(`Tracker disk cache hit: ${path.basename(tempFile)} (${fileSize} bytes)`);
        const diskPromise: Promise<string> = this.probeMedia(tempFile).then((info: MediaInfo): string | Promise<string> => {
          // A 0-length duration means an earlier render produced an empty file
          // (e.g. a failed decode encoded to a tiny MP3). Treat it as corrupt,
          // delete it, and render again so a fixed pipeline self-heals the cache.
          if (info.duration <= 0) {
            midiLogger.warn(`Tracker disk cache corrupt (0-length render), deleting: ${path.basename(tempFile)}`);
            try { unlinkSync(tempFile); } catch { /* ignore cleanup errors */ }
            this.trackerRenderInProgress.delete(filePath);
            return this.renderTrackerToFile(filePath);
          }
          this.setTrackerRenderCache(filePath, {tempFile, duration: info.duration});
          this.playlist.updateItemDurations(filePath, info.duration);
          this.trackerRenderInProgress.delete(filePath);
          return tempFile;
        }).catch((): Promise<string> => {
          midiLogger.warn(`Tracker disk cache corrupt (probe failed), deleting: ${path.basename(tempFile)}`);
          try { unlinkSync(tempFile); } catch { /* ignore cleanup errors */ }
          this.trackerRenderInProgress.delete(filePath);
          return this.renderTrackerToFile(filePath);
        });
        this.trackerRenderInProgress.set(filePath, diskPromise);
        return diskPromise;
      }
    }

    // 5. Full render: openmpt123 (raw PCM via stdout) → FFmpeg (MP3) → tempFile
    const promise: Promise<string> = new Promise<string>((resolve: (value: string) => void, reject: (reason: Error) => void): void => {
      const openmptBin: string | null = this.deps.getOpenmpt123Path();
      const ffmpegBin: string | null = this.deps.getFfmpegPath();

      if (!openmptBin || !ffmpegBin) {
        reject(new Error('Missing dependencies for tracker rendering'));
        return;
      }

      const audioBitrate: number = this.settings.getSettings().transcoding.audioBitrate;

      midiLogger.info(`Pre-rendering tracker: ${path.basename(filePath)} → ${path.basename(tempFile)}`);

      // openmpt123: module → raw PCM on stdout, piped to FFmpeg (same shape as
      // the FluidSynth MIDI pipeline). Notes on the flags:
      // - --batch is required: the default mode is the interactive --ui, which
      //   needs a terminal and exits non-zero when stdout is a pipe. --batch
      //   decodes non-interactively.
      // - --stdout streams raw PCM to stdout (openmpt123's -o/--output and
      //   --output-type only apply to --ui/--batch-to-file and --render).
      // - --no-float forces 16-bit signed PCM (openmpt123 defaults to 32-bit float).
      // - '--' terminates option parsing so paths starting with '-' are safe.
      const openmptArgs: string[] = [
        '--batch',
        '--stdout',
        '--quiet',
        '--no-float',
        '--samplerate', '44100',
        '--channels', '2',
        '--',
        filePath,
      ];
      midiLogger.info(`openmpt123 command: ${openmptBin} ${openmptArgs.join(' ')}`);
      logProcessSpawn(midiLogger, 'openmpt123 (pre-render)', openmptArgs);
      const openmpt: ChildProcess = spawn(openmptBin, openmptArgs);

      // FFmpeg: raw PCM (s16le, 44.1kHz, stereo) → MP3 file.
      const ffmpegArgs: string[] = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-f', 's16le',
        '-ar', '44100',
        '-ac', '2',
        '-i', 'pipe:0',
        '-c:a', 'libmp3lame',
        '-b:a', `${audioBitrate}k`,
        '-f', 'mp3',
        tempFile,
      ];
      logProcessSpawn(ffmpegLogger, 'ffmpeg (tracker pre-render)', ffmpegArgs);
      const ffmpeg: ChildProcess = spawn(ffmpegBin, ffmpegArgs);

      // Connect pipeline: openmpt123 stdout → FFmpeg stdin
      openmpt.stdout?.pipe(ffmpeg.stdin!);

      // openmpt123's exit code is the source of truth: FFmpeg will happily
      // encode a truncated/empty PCM stream and exit 0, so we must not treat
      // that as success.
      let openmptExitCode: number | null = null;

      openmpt.stderr?.on('data', (data: Readonly<Buffer>): void => {
        const msg: string = data.toString().trim();
        if (msg) {
          logProcessOutput(midiLogger, 'stderr', msg);
        }
      });

      ffmpeg.stderr?.on('data', (data: Readonly<Buffer>): void => {
        logProcessOutput(ffmpegLogger, 'stderr', data.toString());
      });

      // Close FFmpeg stdin when openmpt123 finishes producing PCM.
      openmpt.on('close', (code: number | null): void => {
        openmptExitCode = code;
        logProcessExit(midiLogger, 'openmpt123 (pre-render)', code, null);
        ffmpeg.stdin?.end();
      });

      // Resolve when FFmpeg finishes writing the MP3, probing for duration.
      // Require BOTH processes to have succeeded and a non-empty output file.
      ffmpeg.on('close', (code: number | null): void => {
        logProcessExit(ffmpegLogger, 'ffmpeg (tracker pre-render)', code, null);
        this.trackerRenderInProgress.delete(filePath);

        const outputValid: boolean = existsSync(tempFile) && statSync(tempFile).size > 0;

        if (openmptExitCode === 0 && code === 0 && outputValid) {
          this.probeMedia(tempFile).then((info: MediaInfo): void => {
            this.setTrackerRenderCache(filePath, {tempFile, duration: info.duration});
            this.playlist.updateItemDurations(filePath, info.duration);
            midiLogger.info(`Tracker pre-render complete: ${path.basename(tempFile)} (${info.duration.toFixed(1)}s)`);
            resolve(tempFile);
          }).catch((): void => {
            this.setTrackerRenderCache(filePath, {tempFile, duration: 0});
            midiLogger.info(`Tracker pre-render complete: ${path.basename(tempFile)} (duration unknown)`);
            resolve(tempFile);
          });
        } else {
          if (existsSync(tempFile)) {
            try { unlinkSync(tempFile); } catch { /* ignore cleanup errors */ }
          }
          reject(new Error(`Tracker pre-render failed (openmpt123 exit ${openmptExitCode}, ffmpeg exit ${code})`));
        }
      });

      openmpt.on('error', (err: Readonly<Error>): void => {
        midiLogger.error(`openmpt123 pre-render error: ${err.message}`);
        this.trackerRenderInProgress.delete(filePath);
        ffmpeg.kill();
        if (existsSync(tempFile)) {
          try { unlinkSync(tempFile); } catch { /* ignore cleanup errors */ }
        }
        reject(err);
      });

      ffmpeg.on('error', (err: Readonly<Error>): void => {
        ffmpegLogger.error(`FFmpeg tracker pre-render error: ${err.message}`);
        this.trackerRenderInProgress.delete(filePath);
        if (existsSync(tempFile)) {
          try { unlinkSync(tempFile); } catch { /* ignore cleanup errors */ }
        }
        reject(err);
      });
    });

    this.trackerRenderInProgress.set(filePath, promise);
    return promise;
  }

  /**
   * Serves a tracker module, using the pre-rendered cache when available.
   *
   * If the module has been pre-rendered to a temp MP3 file, serves it with
   * HTTP range request support for native seeking. Otherwise renders on demand
   * and holds the response open until the render completes.
   *
   * @param req - Incoming HTTP request
   * @param res - HTTP response to write to
   * @param filePath - Absolute path to the tracker module
   */
  private serveTrackerFile(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, filePath: string): void {
    const cached: {readonly tempFile: string; readonly duration: number} | undefined = this.trackerRenderCache.get(filePath);
    if (cached && existsSync(cached.tempFile)) {
      if (cached.duration > 0 && Math.abs(cached.duration - this.playback.duration) > 1) {
        this.playback.duration = cached.duration;
        this.broadcastTime();
      }
      midiLogger.info(`Serving pre-rendered tracker: ${path.basename(cached.tempFile)}`);
      this.serveDirectFile(req, res, cached.tempFile, '.mp3', {noCache: true});
      return;
    }

    midiLogger.info(`Rendering tracker on demand: ${path.basename(filePath)}`);
    this.renderTrackerToFile(filePath).then((tempFile: string): void => {
      const entry: {readonly tempFile: string; readonly duration: number} | undefined = this.trackerRenderCache.get(filePath);
      if (entry && entry.duration > 0 && Math.abs(entry.duration - this.playback.duration) > 1) {
        this.playback.duration = entry.duration;
        this.broadcastTime();
      }
      this.serveDirectFile(req, res, tempFile, '.mp3', {noCache: true});
    }).catch((err: Error): void => {
      midiLogger.error(`Tracker render failed: ${err.message}`);
      if (!res.headersSent) {
        (res as ServerResponse).writeHead(500);
      }
      (res as ServerResponse).end(JSON.stringify({error: `Tracker render failed: ${err.message}`}));
    });
  }

  // ============================================================================
  // Media Info (ffprobe)
  // ============================================================================

  /**
   * Handles requests for media file metadata.
   *
   * @param res - HTTP response to write to
   * @param url - URL containing 'path' parameter
   */
  private async handleMediaInfo(res: Readonly<ServerResponse>, url: Readonly<URL>): Promise<void> {
    const filePath: string | null = url.searchParams.get('path');
    if (!filePath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing path parameter' }));
      return;
    }

    // Validate file path for security
    const validation: { valid: boolean; error?: string } = this.validateFilePath(filePath);
    if (!validation.valid) {
      res.writeHead(validation.error === 'File not found' ? 404 : 400);
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }

    try {
      const info: MediaInfo = await this.probeMedia(filePath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  // ============================================================================
  // Internet URL Media (yt-dlp)
  // ============================================================================

  /**
   * Handles POST /media/url/info — resolves metadata/quality formats for a URL.
   *
   * Body: { url: string }
   */
  private async handleUrlInfo(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { url }: { url?: unknown } = JSON.parse(body);
    if (typeof url !== 'string' || !url.trim()) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'No URL provided' }));
      return;
    }

    try {
      const info: UrlMediaInfo = await this.download.getInfo(url.trim());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /**
   * Handles POST /media/url/download — starts a background download of a URL.
   *
   * Body: { url: string, format?: 'video'|'audio', formatId?: string, title?: string }
   * Returns the job id immediately; progress, completion, and errors are
   * broadcast over SSE (download:progress / download:complete / download:error).
   */
  private async handleUrlDownload(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { url, format, formatId, title }: { url?: unknown; format?: unknown; formatId?: unknown; title?: unknown } = JSON.parse(body);
    if (typeof url !== 'string' || !url.trim()) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'No URL provided' }));
      return;
    }

    const mediaFormat: UrlMediaFormat = format === 'audio' ? 'audio' : 'video';
    const jobId: string = this.download.startDownload(
      url.trim(),
      mediaFormat,
      typeof formatId === 'string' ? formatId : null,
      typeof title === 'string' ? title : '',
      (job: Readonly<DownloadJob>): void => this.broadcastDownloadUpdate(job)
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jobId }));
  }

  /**
   * Handles POST /media/url/resolve — resolves a direct (progressive) stream URL.
   *
   * Body: { url: string, format?: 'video'|'audio', maxHeight?: number }
   * Returns { url } pointing at a single media stream that ffprobe/ffmpeg can
   * consume directly, so the renderer adds it like any other playlist item.
   */
  private async handleUrlResolve(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { url, format, maxHeight }: { url?: unknown; format?: unknown; maxHeight?: unknown } = JSON.parse(body);
    if (typeof url !== 'string' || !url.trim()) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'No URL provided' }));
      return;
    }

    const mediaFormat: UrlMediaFormat = format === 'audio' ? 'audio' : 'video';
    try {
      const sources: StreamSources = await this.download.resolveStreamSources(
        url.trim(),
        mediaFormat,
        typeof maxHeight === 'number' ? maxHeight : null
      );
      // Pair the separate DASH audio stream with the video URL so the stream
      // handler muxes them together. The renderer only ever sees the video URL.
      if (sources.audio) {
        this.setDashAudioPair(sources.video, sources.audio);
      } else {
        this.dashAudioPairs.delete(sources.video);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: sources.video }));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /**
   * Records a DASH video→audio URL pairing, evicting the oldest entry when the
   * cache is full (FIFO).
   */
  private setDashAudioPair(videoUrl: string, audioUrl: string): void {
    if (this.dashAudioPairs.size >= UnifiedMediaServer.MAX_DASH_PAIRS) {
      const oldest: string | undefined = this.dashAudioPairs.keys().next().value;
      if (oldest !== undefined) {
        this.dashAudioPairs.delete(oldest);
      }
    }
    this.dashAudioPairs.set(videoUrl, audioUrl);
  }

  /**
   * Handles GET /media/url/status/:jobId — returns the current download job state.
   */
  private handleUrlStatus(res: Readonly<ServerResponse>, pathname: string): void {
    const jobId: string = decodeURIComponent(pathname.substring('/media/url/status/'.length));
    const job: DownloadJob | undefined = this.download.getJob(jobId);
    if (!job) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Job not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(job));
  }

  /**
   * Handles POST /media/url/cancel/:jobId — cancels an in-flight download.
   */
  private handleUrlCancel(res: Readonly<ServerResponse>, pathname: string): void {
    const jobId: string = decodeURIComponent(pathname.substring('/media/url/cancel/'.length));
    const cancelled: boolean = this.download.cancelDownload(jobId);
    res.writeHead(cancelled ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cancelled }));
  }

  /**
   * Broadcasts a download job update over SSE, mapping job status to the
   * appropriate event. The renderer adds completed files to the playlist.
   */
  private broadcastDownloadUpdate(job: Readonly<DownloadJob>): void {
    if (job.status === 'done') {
      this.sse.broadcast('download:complete', job);
    } else if (job.status === 'error') {
      this.sse.broadcast('download:error', job);
    } else {
      this.sse.broadcast('download:progress', job);
    }
  }

  /**
   * Handles GET /media/subtitles requests.
   * Extracts a subtitle track from a video file and converts it to WebVTT format.
   *
   * Query parameters:
   * - path: Absolute path to the video file (required)
   * - track: Stream index of the subtitle track (required)
   *
   * @param req - HTTP request
   * @param res - HTTP response
   * @param url - Parsed URL with query parameters
   */
  private handleSubtitles(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, url: Readonly<URL>): void {
    const filePath: string | null = url.searchParams.get('path');
    const trackIndex: string | null = url.searchParams.get('track');

    if (!filePath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing path parameter' }));
      return;
    }

    if (trackIndex === null) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing track parameter' }));
      return;
    }

    const trackNum: number = parseInt(trackIndex, 10);
    if (isNaN(trackNum) || trackNum < 0) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid track parameter' }));
      return;
    }

    // Validate file path for security
    const validation: { valid: boolean; error?: string } = this.validateFilePath(filePath);
    if (!validation.valid) {
      res.writeHead(validation.error === 'File not found' ? 404 : 400);
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }

    const ffmpegBin: string | null = this.deps.getFfmpegPath();
    if (!ffmpegBin) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'FFmpeg not found' }));
      return;
    }

    // Extract subtitle track and convert to WebVTT
    // -copyts preserves original timestamps from the container
    // -map 0:{trackNum} selects the specific stream index
    // -f webvtt outputs WebVTT format
    ffmpegLogger.debug(`Extracting subtitle: stream ${trackNum} from ${path.basename(filePath)}`);
    const ffmpeg: ChildProcess = spawn(ffmpegBin, [
      '-copyts',
      '-i', filePath,
      '-map', `0:${trackNum}`,
      '-f', 'webvtt',
      'pipe:1'
    ]);

    // Set response headers for WebVTT
    res.writeHead(200, {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });

    // Pipe FFmpeg output directly to response
    ffmpeg.stdout?.pipe(res);

    // Handle errors
    ffmpeg.stderr?.on('data', (data: Readonly<Buffer>): void => {
      const msg: string = data.toString().trim();
      // Only log actual errors, not progress info
      if (msg.includes('Error') || msg.includes('Invalid')) {
        ffmpegLogger.error(`Subtitle extraction error: ${msg}`);
      }
    });

    ffmpeg.on('error', (err: Readonly<Error>): void => {
      ffmpegLogger.error(`Subtitle extraction failed: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    ffmpeg.on('close', (code: number | null): void => {
      if (code !== 0 && code !== null) {
        ffmpegLogger.warn(`Subtitle extraction exited with code ${code}`);
      }
    });

    // Handle client disconnect
    req.on('close', (): void => {
      ffmpeg.kill('SIGTERM');
    });
  }

  /**
   * Handles GET /media/subtitles/external requests.
   * Converts an external subtitle file (.srt, .ass, .ssa, .vtt) to WebVTT format.
   *
   * Query parameters:
   * - path: Absolute path to the subtitle file (required)
   *
   * @param req - HTTP request
   * @param res - HTTP response
   * @param url - Parsed URL with query parameters
   */
  private handleExternalSubtitles(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, url: Readonly<URL>): void {
    const filePath: string | null = url.searchParams.get('path');

    if (!filePath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing path parameter' }));
      return;
    }

    // Validate file path for security
    const validation: { valid: boolean; error?: string } = this.validateFilePath(filePath);
    if (!validation.valid) {
      res.writeHead(validation.error === 'File not found' ? 404 : 400);
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }

    // Validate subtitle extension
    const ext: string = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    const validExtensions: Set<string> = new Set(['.srt', '.vtt', '.ass', '.ssa']);
    if (!validExtensions.has(ext)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid subtitle format. Supported: .srt, .vtt, .ass, .ssa' }));
      return;
    }

    const ffmpegBin: string | null = this.deps.getFfmpegPath();
    if (!ffmpegBin) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'FFmpeg not found' }));
      return;
    }

    // Convert subtitle file to WebVTT using FFmpeg
    // -copyts preserves original timestamps
    // FFmpeg can read most subtitle formats and convert to WebVTT
    const ffmpeg: ChildProcess = spawn(ffmpegBin, [
      '-copyts',
      '-i', filePath,
      '-f', 'webvtt',
      'pipe:1'
    ]);

    // Set response headers for WebVTT
    res.writeHead(200, {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });

    // Pipe FFmpeg output directly to response
    ffmpeg.stdout?.pipe(res);

    // Handle errors
    ffmpeg.stderr?.on('data', (data: Readonly<Buffer>): void => {
      const msg: string = data.toString().trim();
      // Only log actual errors, not progress info
      if (msg.includes('Error') || msg.includes('Invalid')) {
        ffmpegLogger.error(`External subtitle conversion error: ${msg}`);
      }
    });

    ffmpeg.on('error', (err: Readonly<Error>): void => {
      ffmpegLogger.error(`External subtitle conversion failed: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    ffmpeg.on('close', (code: number | null): void => {
      if (code !== 0 && code !== null) {
        ffmpegLogger.warn(`External subtitle conversion exited with code ${code}`);
      }
    });

    // Handle client disconnect
    req.on('close', (): void => {
      ffmpeg.kill('SIGTERM');
    });
  }

  /**
   * Extracts metadata from a media file using ffprobe or MIDI parser.
   *
   * For most formats, spawns ffprobe to extract:
   * - Duration
   * - Stream types (determines audio vs video)
   * - Metadata tags (title, artist, album)
   * - Video dimensions
   *
   * For MIDI files, uses the custom parseMidiDuration function
   * since ffprobe cannot read MIDI files.
   *
   * @param filePath - Absolute path to the media file
   * @returns Promise resolving to media information
   * @throws Error if probing fails
   */
  private probeMedia(filePath: string): Promise<MediaInfo> {
    // MIDI files cannot be probed by ffprobe - use cached render duration
    // if available, otherwise fall back to parseMidiDuration and start
    // a background render.
    const ext: string = path.extname(filePath).toLowerCase();
    if (MIDI_FORMATS.has(ext)) {
      // Use cached render duration if available (accurate, avoids parseMidiDuration)
      const cached: {readonly tempFile: string; readonly duration: number} | undefined =
        this.midiRenderCache.get(filePath);
      if (cached) {
        return Promise.resolve({
          duration: cached.duration,
          type: 'audio' as const,
          title: path.basename(filePath, ext),
          filePath,
        });
      }

      // Not cached yet — start background render and return approximate duration
      this.renderMidiToFile(filePath).catch((err: Error): void => {
        midiLogger.error(`Background MIDI render failed for ${path.basename(filePath)}: ${err.message}`);
      });
      const duration: number = parseMidiDuration(filePath);
      return Promise.resolve({
        duration,
        type: 'audio' as const,
        title: path.basename(filePath, ext),
        filePath,
      });
    }

    // Tracker modules cannot be probed by ffprobe either — their accurate
    // duration comes from the rendered output. Use the cached render duration
    // if available, otherwise start a background render and report 0 until it
    // completes (the render updates the playlist duration when finished).
    if (TRACKER_FORMATS.has(ext)) {
      const cached: {readonly tempFile: string; readonly duration: number} | undefined =
        this.trackerRenderCache.get(filePath);
      if (cached) {
        return Promise.resolve({
          duration: cached.duration,
          type: 'audio' as const,
          title: path.basename(filePath, ext),
          filePath,
        });
      }

      this.renderTrackerToFile(filePath).catch((err: Error): void => {
        midiLogger.error(`Background tracker render failed for ${path.basename(filePath)}: ${err.message}`);
      });
      return Promise.resolve({
        duration: 0,
        type: 'audio' as const,
        title: path.basename(filePath, ext),
        filePath,
      });
    }

    return new Promise((resolve: (value: Readonly<MediaInfo>) => void, reject: (reason: Readonly<Error>) => void): void => {
      const ffprobeBin: string | null = this.deps.getFfprobePath();
      if (!ffprobeBin) {
        ffmpegLogger.error('ffprobe binary not found');
        reject(new Error('ffprobe not found'));
        return;
      }
      ffmpegLogger.debug(`Probing: ${path.basename(filePath)}`);
      const ffprobe: ChildProcess = spawn(ffprobeBin, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath
      ]);

      let output: string = '';
      let errorOutput: string = '';

      ffprobe.stdout?.on('data', (data: Readonly<Buffer>): void => { output += data; });
      ffprobe.stderr?.on('data', (data: Readonly<Buffer>): void => { errorOutput += data; });

      ffprobe.on('close', (code: number | null): void => {
        if (code !== 0) {
          reject(new Error(`ffprobe failed: ${errorOutput}`));
          return;
        }

        try {
          const data: { format?: Record<string, unknown>; streams?: Array<Record<string, unknown>> } = JSON.parse(output);
          const format: Record<string, unknown> = data.format || {};
          const streams: Array<Record<string, unknown>> = data.streams || [];

          // Find video stream (exclude mjpeg which is often album art)
          const videoStream: Record<string, unknown> | undefined = streams.find((s: Readonly<Record<string, unknown>>): boolean =>
            s.codec_type === 'video' && s.codec_name !== 'mjpeg'
          );
          const hasVideo: boolean = !!videoStream;

          // Extract subtitle tracks (only for video files)
          // Filter out bitmap-based subtitles (PGS, VOBSUB, DVB) as they can't be converted to WebVTT
          const textSubtitleCodecs: Set<string> = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'srt']);
          const allSubtitleStreams: Array<Record<string, unknown>> = streams
            .filter((s: Readonly<Record<string, unknown>>): boolean => s.codec_type === 'subtitle');

          // Log all subtitle streams for debugging
          if (allSubtitleStreams.length > 0) {
            const codecList: string = allSubtitleStreams
              .map((s: Readonly<Record<string, unknown>>): string => `${s.index}:${s.codec_name}`)
              .join(', ');
            ffmpegLogger.debug(`Subtitle streams: ${codecList}`);
          }

          const subtitleTracks: SubtitleTrack[] | undefined = hasVideo ? allSubtitleStreams
            .filter((s: Readonly<Record<string, unknown>>): boolean =>
              textSubtitleCodecs.has(s.codec_name as string)
            )
            .map((s: Readonly<Record<string, unknown>>): SubtitleTrack => {
              const streamTags: Record<string, string> = (s.tags as Record<string, string>) || {};
              const disposition: Record<string, number> = (s.disposition as Record<string, number>) || {};
              ffmpegLogger.debug(`Text subtitle found: index=${s.index}, codec=${s.codec_name}, lang=${streamTags.language || 'und'}, forced=${disposition.forced === 1}`);
              return {
                index: s.index as number,
                language: streamTags.language || 'und',
                title: streamTags.title || this.getLanguageDisplayName(streamTags.language || 'und'),
                codec: s.codec_name as string,
                forced: disposition.forced === 1,
                default: disposition.default === 1,
              };
            }) : undefined;

          // Extract audio tracks (only for video files with multiple audio streams)
          const audioStreams: Array<Record<string, unknown>> = streams
            .filter((s: Readonly<Record<string, unknown>>): boolean => s.codec_type === 'audio');
          const audioTracks: AudioTrack[] | undefined = hasVideo && audioStreams.length > 1 ? audioStreams
            .map((s: Readonly<Record<string, unknown>>, mapIndex: number): AudioTrack => {
              const streamTags: Record<string, string> = (s.tags as Record<string, string>) || {};
              const disposition: Record<string, number> = (s.disposition as Record<string, number>) || {};
              return {
                index: mapIndex,  // Use map index for FFmpeg -map 0:a:{index}
                language: streamTags.language || 'und',
                title: streamTags.title || this.getLanguageDisplayName(streamTags.language || 'und'),
                codec: s.codec_name as string,
                channels: (s.channels as number) || 2,
                default: disposition.default === 1,
              };
            }) : undefined;

          // Extract codec names for remux detection
          const videoCodec: string | undefined = videoStream?.codec_name as string | undefined;
          const primaryAudioStream: Record<string, unknown> | undefined = audioStreams[0];
          const audioCodec: string | undefined = primaryAudioStream?.codec_name as string | undefined;

          // Determine if file can be remuxed (stream-copied) to fragmented MP4
          // Video codecs compatible with MP4 container and browser playback
          const remuxableVideoCodecs: Set<string> = new Set(['h264', 'hevc', 'vp9', 'av1']);
          // Audio codecs compatible with MP4 container and browser playback
          const remuxableAudioCodecs: Set<string> = new Set(['aac', 'mp3', 'opus', 'flac']);

          const canRemux: boolean = hasVideo &&
            videoCodec !== undefined && remuxableVideoCodecs.has(videoCodec) &&
            audioCodec !== undefined && remuxableAudioCodecs.has(audioCodec);

          // Log codec info for debugging
          ffmpegLogger.debug(`Codecs: video=${videoCodec ?? 'none'}, audio=${audioCodec ?? 'none'}, canRemux=${canRemux}`);

          // Extract metadata tags (handle various case conventions)
          const tags: Record<string, string> = (format.tags as Record<string, string>) || {};

          const mediaInfo: MediaInfo = {
            duration: parseFloat(format.duration as string) || 0,
            type: hasVideo ? 'video' : 'audio',
            title: tags.title || tags.TITLE || path.basename(filePath, path.extname(filePath)),
            artist: tags.artist || tags.ARTIST || tags.album_artist || tags.ALBUM_ARTIST,
            album: tags.album || tags.ALBUM,
            filePath,
            width: videoStream?.width as number | undefined,
            height: videoStream?.height as number | undefined,
            videoCodec: hasVideo ? videoCodec : undefined,
            // Always store audio codec - needed for browser compatibility check
            audioCodec,
            canRemux: hasVideo ? canRemux : undefined,
            audioTracks: audioTracks && audioTracks.length > 0 ? audioTracks : undefined,
            subtitleTracks: subtitleTracks && subtitleTracks.length > 0 ? subtitleTracks : undefined,
          };

          // Cache MediaInfo for stream handler codec lookup
          this.mediaInfoCache.set(filePath, mediaInfo);

          resolve(mediaInfo);
        } catch (e) {
          reject(new Error(`Failed to parse ffprobe output: ${e}`));
        }
      });

      ffprobe.on('error', (err: Readonly<Error>): void => {
        reject(new Error(`ffprobe error: ${err.message}`));
      });
    });
  }

  // ============================================================================
  // Playback Control Handlers
  // ============================================================================

  /**
   * Handles play requests.
   *
   * If paused: resumes from paused position
   * If idle/stopped: loads and plays the current track
   *
   * @param res - HTTP response to write to
   */
  private async handlePlay(res: Readonly<ServerResponse>): Promise<void> {
    // If paused, resume from where we left off
    if (this.playback.state === 'paused') {
      playbackLogger.info(`Resuming playback at ${this.pausedTime.toFixed(1)}s`);
      this.playback.state = 'playing';
      this.startTime = Date.now() - (this.pausedTime * 1000);
      this.startTimeTracking();
      this.broadcastState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // If no current track, cannot play
    const currentItem: PlaylistItem | null = this.playlist.getCurrentItem();
    if (!currentItem) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'No track selected' }));
      return;
    }

    // Load and play current track
    try {
      playbackLogger.info(`Loading: ${currentItem.title}`);
      this.playback.state = 'loading';
      this.broadcastState();

      let mediaInfo: MediaInfo = await this.probeMedia(currentItem.filePath);
      this.playback.currentMedia = mediaInfo;
      this.playback.duration = mediaInfo.duration;

      // Resume from a position seeked while stopped/idle (the user dragged
      // the seek bar before pressing play). Consumed here so later plays
      // start from the beginning again.
      const resumeTime: number = Math.max(0, Math.min(this.pausedTime, mediaInfo.duration));
      this.pausedTime = 0;
      this.playback.currentTime = resumeTime;
      this.lastTrackStartAt = Date.now();

      // Pre-render MIDI files before transitioning to 'playing' to avoid
      // race condition where UI shows playing but audio hasn't loaded yet
      const ext: string = path.extname(currentItem.filePath).toLowerCase();
      if (MIDI_FORMATS.has(ext)) {
        playbackLogger.info('Pre-rendering MIDI before playback...');
        await this.renderMidiToFile(currentItem.filePath);
        // Update duration from the rendered file (more accurate than MIDI parser)
        const cacheEntry: {readonly tempFile: string; readonly duration: number} | undefined =
          this.midiRenderCache.get(currentItem.filePath);
        if (cacheEntry && cacheEntry.duration > 0) {
          this.playback.duration = cacheEntry.duration;
        }
      } else if (TRACKER_FORMATS.has(ext)) {
        playbackLogger.info('Pre-rendering tracker module before playback...');
        await this.renderTrackerToFile(currentItem.filePath);
        // Trackers have no probe duration (probeMedia returned 0 above), so the
        // real duration is only known after rendering. Feed it back into
        // mediaInfo/currentMedia so the 'playback:loaded' broadcast carries a
        // valid length — a zero-length loaded track makes the player stop
        // instead of playing (MIDI avoids this via parseMidiDuration).
        const cacheEntry: {readonly tempFile: string; readonly duration: number} | undefined =
          this.trackerRenderCache.get(currentItem.filePath);
        if (cacheEntry && cacheEntry.duration > 0) {
          this.playback.duration = cacheEntry.duration;
          mediaInfo = {...mediaInfo, duration: cacheEntry.duration};
          this.playback.currentMedia = mediaInfo;
        }
      }

      // For audio files, keep state as 'loading' until frontend signals playback started.
      // This prevents the UI from showing 'playing' before audio actually begins.
      // For video files, transition to 'playing' immediately since video outlet handles timing.
      if (mediaInfo.type === 'video') {
        this.playback.state = 'playing';
        this.startTime = Date.now() - (resumeTime * 1000);
        this.startTimeTracking();
      }
      // Audio files stay in 'loading' - /player/started will transition to 'playing'

      this.sse.broadcast('playback:loaded', mediaInfo);
      this.broadcastState();
      this.broadcastTime();

      playbackLogger.info(`${mediaInfo.type === 'video' ? 'Playing' : 'Loaded (awaiting playback)'}: ${mediaInfo.title} (${mediaInfo.type}, ${mediaInfo.duration.toFixed(1)}s)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, media: mediaInfo }));
    } catch (err) {
      playbackLogger.error(`Failed to load media: ${(err as Error).message}`);
      this.playback.state = 'error';
      this.playback.errorMessage = (err as Error).message;
      this.broadcastState();
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /**
   * Handles pause requests.
   *
   * Stores the current position for resuming later.
   *
   * @param res - HTTP response to write to
   */
  private handlePause(res: Readonly<ServerResponse>): void {
    if (this.playback.state !== 'playing') {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Not playing' }));
      return;
    }

    playbackLogger.info(`Paused at ${this.playback.currentTime.toFixed(1)}s`);
    this.playback.state = 'paused';
    this.pausedTime = this.playback.currentTime;
    this.stopTimeTracking();
    this.broadcastState();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  /**
   * Handles stop requests.
   *
   * Resets playback position to the beginning and selects the first
   * playlist item (if any items exist).
   *
   * @param res - HTTP response to write to
   */
  private handleStop(res: Readonly<ServerResponse>): void {
    playbackLogger.info('Stopped');
    this.playback.state = 'stopped';
    this.playback.currentTime = 0;
    this.pausedTime = 0;
    this.stopTimeTracking();

    // Nuke MIDI cache on stop to ensure fresh renders next time
    this.nukeMidiCache();

    this.broadcastState();
    this.broadcastTime();

    // Select the first item AFTER broadcasting the stopped state. The
    // selection broadcast makes clients (re)load the newly selected item,
    // and if it arrived first they would still see the stale 'playing'
    // state and briefly auto-play it.
    if (this.playlist.getState().items.length > 0) {
      this.playlist.selectIndex(0);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  /**
   * Handles playback started signal from frontend.
   *
   * Called when the audio/video element actually starts playing.
   * This starts time tracking on the server to sync the seek bar.
   * For audio files, this prevents the UI from showing playback
   * before the audio has actually loaded and started.
   *
   * @param res - HTTP response to write to
   */
  private handlePlaybackStarted(res: Readonly<ServerResponse>): void {
    // Accept either 'loading' (normal audio start) or 'playing' (video or already started)
    if (this.playback.state !== 'loading' && this.playback.state !== 'playing') {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Not in loading or playing state' }));
      return;
    }

    // Transition from 'loading' to 'playing' now that audio has actually started
    if (this.playback.state === 'loading') {
      playbackLogger.info('Audio playback started - transitioning to playing state');
      this.playback.state = 'playing';
      this.broadcastState();
    }

    // Only start time tracking if not already running. Anchor the clock to
    // the current position (non-zero when resuming from a seek made while
    // stopped) rather than restarting it from zero.
    if (!this.timeUpdateInterval) {
      playbackLogger.info(`Beginning time tracking at ${this.playback.currentTime.toFixed(1)}s (duration ${this.playback.duration.toFixed(1)}s)`);
      this.startTime = Date.now() - (this.playback.currentTime * 1000);
      this.startTimeTracking();
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  /**
   * Handles seek requests.
   *
   * Updates the playback position. Time is clamped to valid range.
   *
   * @param req - Incoming HTTP request with { time: number } body
   * @param res - HTTP response to write to
   */
  private async handleSeek(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { time }: { time: unknown } = JSON.parse(body);

    if (typeof time !== 'number') {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid time' }));
      return;
    }

    const clampedTime: number = Math.max(0, Math.min(time, this.playback.duration));
    this.playback.currentTime = clampedTime;

    if (this.playback.state === 'playing') {
      this.startTime = Date.now() - (clampedTime * 1000);
    } else {
      this.pausedTime = clampedTime;
    }

    this.broadcastTime();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, time: clampedTime }));
  }

  /**
   * Handles playback clock sync requests from the renderer.
   *
   * The server tracks playback time with a wall-clock interval, but the media
   * element is the true source of playback position — buffering stalls and
   * FFmpeg startup delays (especially for remote/streamed media) make the
   * wall clock drift ahead of the actual content. The active outlet reports
   * the element's real position periodically and the server re-anchors its
   * clock to it, keeping the seek bar and subtitles in sync.
   *
   * Unlike a seek, a sync never changes what is playing — it only corrects
   * the clock, so it is ignored unless playback is active.
   *
   * @param req - Incoming HTTP request with { time: number } body
   * @param res - HTTP response to write to
   */
  private async handleTimeSync(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { time }: { time: unknown } = JSON.parse(body);

    if (typeof time !== 'number' || !isFinite(time)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid time' }));
      return;
    }

    // Only meaningful while the clock is running. Also ignore syncs that
    // race a track start: an outlet may still report the PREVIOUS track's
    // position for a moment after a switch (its state signals lag the
    // server), and anchoring the fresh track's clock to that stale position
    // would make the new track appear to start mid-way through.
    const sinceTrackStart: number = Date.now() - this.lastTrackStartAt;
    if (this.playback.state === 'playing' && sinceTrackStart > this.TRACK_START_SYNC_GUARD_MS) {
      const clampedTime: number = Math.max(0, Math.min(time, this.playback.duration));
      this.playback.currentTime = clampedTime;
      this.startTime = Date.now() - (clampedTime * 1000);
      this.broadcastTime();
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, time: this.playback.currentTime }));
  }

  /**
   * Handles volume change requests.
   *
   * @param req - Incoming HTTP request with { volume?: number, muted?: boolean } body
   * @param res - HTTP response to write to
   */
  private async handleVolume(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { volume, muted }: { volume?: number; muted?: boolean } = JSON.parse(body);

    if (typeof volume === 'number') {
      this.playback.volume = Math.max(0, Math.min(1, volume));
    }
    if (typeof muted === 'boolean') {
      this.playback.muted = muted;
    }

    this.sse.broadcast('playback:volume', {
      volume: this.playback.volume,
      muted: this.playback.muted,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, volume: this.playback.volume, muted: this.playback.muted }));
  }

  /**
   * Handles player state requests.
   *
   * Returns the complete current playback state.
   *
   * @param res - HTTP response to write to
   */
  private handlePlayerState(res: Readonly<ServerResponse>): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      state: this.playback.state,
      currentTime: this.playback.currentTime,
      duration: this.playback.duration,
      volume: this.playback.volume,
      muted: this.playback.muted,
      currentMedia: this.playback.currentMedia,
      errorMessage: this.playback.errorMessage,
    }));
  }

  // ============================================================================
  // Playlist Handlers
  // ============================================================================

  /**
   * Handles playlist state requests.
   *
   * @param res - HTTP response to write to
   */
  private handlePlaylistGet(res: Readonly<ServerResponse>): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.playlist.getState()));
  }

  /**
   * Handles add to playlist requests.
   *
   * Probes each file for metadata and adds to the playlist.
   * Files that fail probing are silently skipped.
   *
   * @param req - Incoming HTTP request with { paths: string[] } body
   * @param res - HTTP response to write to
   */
  private async handlePlaylistAdd(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { paths }: { paths: unknown } = JSON.parse(body);

    if (!Array.isArray(paths)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'paths must be an array' }));
      return;
    }

    // Probe all files in parallel for metadata
    const results: PromiseSettledResult<MediaInfo>[] = await Promise.allSettled(
      (paths as string[]).map((filePath: string): Promise<MediaInfo> => this.probeMedia(filePath))
    );

    const items: Omit<PlaylistItem, 'id'>[] = [];
    for (let i: number = 0; i < results.length; i++) {
      const result: PromiseSettledResult<MediaInfo> = results[i];
      if (result.status === 'fulfilled') {
        const info: MediaInfo = result.value;
        items.push({
          filePath: info.filePath,
          title: info.title,
          artist: info.artist,
          album: info.album,
          duration: info.duration,
          type: info.type,
          width: info.width,
          height: info.height,
          // Include codec info for client-side transcoding detection
          audioCodec: info.audioCodec,
          canRemux: info.canRemux,
        });
      } else {
        playlistLogger.error(`Failed to probe ${(paths as string[])[i]}: ${result.reason}`);
      }
    }

    playlistLogger.info(`Adding ${items.length} item(s) to playlist`);
    const added: PlaylistItem[] = this.playlist.addItems(items);

    // Add each file to recent items and notify menu
    for (const item of added) {
      this.settings.addRecentFile(item.filePath);
    }
    if (added.length > 0) {
      const recentItems: RecentItemsSettings = this.settings.getRecentItems();
      this.onRecentItemsChangeCallback?.(recentItems.recentFiles, recentItems.recentPlaylists);
    }

    // Notify of playlist count change for menu state
    this.onPlaylistCountChangeCallback?.(this.playlist.getState().items.length);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, added }));
  }

  /**
   * Handles remove from playlist requests.
   *
   * If removing the currently playing item:
   * - If playlist becomes empty: stop and go to idle
   * - If removing last item with repeat on: play first item
   * - Otherwise: play the next item (now at same index)
   *
   * @param res - HTTP response to write to
   * @param pathname - URL path containing item ID
   */
  private async handlePlaylistRemove(res: Readonly<ServerResponse>, pathname: string): Promise<void> {
    const id: string = pathname.replace('/playlist/remove/', '');

    // Check if we're removing the currently playing item
    const currentItem: PlaylistItem | null = this.playlist.getCurrentItem();
    const isRemovingCurrent: boolean = currentItem?.id === id;
    const wasPlaying: boolean = this.playback.state === 'playing' || this.playback.state === 'paused';
    const playlistState: PlaylistState = this.playlist.getState();
    const wasLastItem: boolean = playlistState.currentIndex === playlistState.items.length - 1;
    const hadOnlyOneItem: boolean = playlistState.items.length === 1;

    const success: boolean = this.playlist.removeItem(id);

    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false }));
      return;
    }

    // If we removed the currently playing item, handle playback transition
    if (isRemovingCurrent && wasPlaying) {
      const newState: PlaylistState = this.playlist.getState();

      if (newState.items.length === 0) {
        // Playlist is now empty - stop and go to idle
        this.playback.state = 'idle';
        this.playback.currentMedia = null;
        this.playback.currentTime = 0;
        this.playback.duration = 0;
        this.stopTimeTracking();
        this.broadcastState();
        this.broadcastTime();
      } else if (hadOnlyOneItem) {
        // This shouldn't happen (length would be 0), but handle defensively
        this.playback.state = 'idle';
        this.playback.currentMedia = null;
        this.playback.currentTime = 0;
        this.playback.duration = 0;
        this.stopTimeTracking();
        this.broadcastState();
        this.broadcastTime();
      } else {
        // There are more items - play the next one
        // If we removed the last item, currentIndex now points to the new last item
        // If repeat was on and we were at the end, we should loop to first
        let nextItem: PlaylistItem | null = null;

        if (wasLastItem && playlistState.repeatEnabled) {
          // Was last item with repeat on - select first item
          nextItem = this.playlist.selectIndex(0);
        } else {
          // The item now at currentIndex is the one that was next
          nextItem = this.playlist.getCurrentItem();
        }

        if (nextItem) {
          try {
            this.playback.state = 'loading';
            this.broadcastState();

            const mediaInfo: MediaInfo = await this.probeMedia(nextItem.filePath);
            this.playback.currentMedia = mediaInfo;
            this.playback.duration = mediaInfo.duration;
            this.playback.currentTime = 0;
            this.pausedTime = 0;
            this.lastTrackStartAt = Date.now();
            this.playback.state = 'playing';
            this.startTime = Date.now();

            this.sse.broadcast('playback:loaded', mediaInfo);
            this.broadcastState();
            this.broadcastTime();
            this.startTimeTracking();
          } catch (err) {
            this.playback.state = 'error';
            this.playback.errorMessage = (err as Error).message;
            this.broadcastState();
          }
        } else {
          // No next item available - go to idle
          this.playback.state = 'idle';
          this.playback.currentMedia = null;
          this.playback.currentTime = 0;
          this.playback.duration = 0;
          this.stopTimeTracking();
          this.broadcastState();
          this.broadcastTime();
        }
      }
    }

    // Notify of playlist count change for menu state
    this.onPlaylistCountChangeCallback?.(this.playlist.getState().items.length);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  /**
   * Handles clear playlist requests.
   *
   * @param res - HTTP response to write to
   */
  private handlePlaylistClear(res: Readonly<ServerResponse>): void {
    this.playlist.clear();
    this.playback.state = 'idle';
    this.playback.currentMedia = null;
    this.playback.currentTime = 0;
    this.pausedTime = 0;
    this.playback.duration = 0;
    this.stopTimeTracking();
    this.broadcastState();

    // Notify of playlist count change for menu state
    this.onPlaylistCountChangeCallback?.(0);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  /**
   * Handles track selection requests.
   *
   * Selects the track and automatically starts playback.
   *
   * @param res - HTTP response to write to
   * @param pathname - URL path containing item ID
   */
  private async handlePlaylistSelect(res: Readonly<ServerResponse>, pathname: string): Promise<void> {
    const id: string = pathname.replace('/playlist/select/', '');
    const item: PlaylistItem | null = this.playlist.selectItem(id);

    if (!item) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Item not found' }));
      return;
    }

    // Auto-play selected item
    try {
      this.playback.state = 'loading';
      this.broadcastState();

      const mediaInfo: MediaInfo = await this.probeMedia(item.filePath);
      this.playback.currentMedia = mediaInfo;
      this.playback.duration = mediaInfo.duration;
      this.playback.currentTime = 0;
      this.pausedTime = 0;
      this.lastTrackStartAt = Date.now();
      this.playback.state = 'playing';
      this.startTime = Date.now();

      this.sse.broadcast('playback:loaded', mediaInfo);
      this.broadcastState();
      this.broadcastTime();
      this.startTimeTracking();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, item, media: mediaInfo }));
    } catch (err) {
      this.playback.state = 'error';
      this.playback.errorMessage = (err as Error).message;
      this.broadcastState();
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /**
   * Handles next track requests.
   *
   * Advances to the next track and starts playback.
   * If at the end of the playlist, returns ended: true.
   *
   * @param res - HTTP response to write to
   */
  private async handlePlaylistNext(res: Readonly<ServerResponse>): Promise<void> {
    const item: PlaylistItem | null = this.playlist.next();

    if (!item) {
      // End of playlist reached
      this.playback.state = 'idle';
      this.playback.currentTime = 0;
      this.pausedTime = 0;
      this.lastTrackStartAt = Date.now();
      this.stopTimeTracking();
      this.broadcastState();
      this.sse.broadcast('playback:ended', {});

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ended: true }));
      return;
    }

    // Play next item
    try {
      this.playback.state = 'loading';
      this.broadcastState();

      const mediaInfo: MediaInfo = await this.probeMedia(item.filePath);
      this.playback.currentMedia = mediaInfo;
      this.playback.duration = mediaInfo.duration;
      this.playback.currentTime = 0;
      this.pausedTime = 0;
      this.lastTrackStartAt = Date.now();
      this.playback.state = 'playing';
      this.startTime = Date.now();

      this.sse.broadcast('playback:loaded', mediaInfo);
      this.broadcastState();
      this.broadcastTime();
      this.startTimeTracking();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, item, media: mediaInfo }));
    } catch (err) {
      this.playback.state = 'error';
      this.playback.errorMessage = (err as Error).message;
      this.broadcastState();
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /**
   * Handles previous track requests.
   *
   * Goes to the previous track and starts playback.
   *
   * @param res - HTTP response to write to
   */
  private async handlePlaylistPrevious(res: Readonly<ServerResponse>): Promise<void> {
    const item: PlaylistItem | null = this.playlist.previous();

    if (!item) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, reason: 'No previous track' }));
      return;
    }

    // Play previous item
    try {
      this.playback.state = 'loading';
      this.broadcastState();

      const mediaInfo: MediaInfo = await this.probeMedia(item.filePath);
      this.playback.currentMedia = mediaInfo;
      this.playback.duration = mediaInfo.duration;
      this.playback.currentTime = 0;
      this.pausedTime = 0;
      this.lastTrackStartAt = Date.now();
      this.playback.state = 'playing';
      this.startTime = Date.now();

      this.sse.broadcast('playback:loaded', mediaInfo);
      this.broadcastState();
      this.broadcastTime();
      this.startTimeTracking();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, item, media: mediaInfo }));
    } catch (err) {
      this.playback.state = 'error';
      this.playback.errorMessage = (err as Error).message;
      this.broadcastState();
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /**
   * Handles shuffle mode toggle requests.
   *
   * @param req - Incoming HTTP request with { enabled: boolean } body
   * @param res - HTTP response to write to
   */
  private async handlePlaylistShuffle(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { enabled }: { enabled: unknown } = JSON.parse(body);

    this.playlist.setShuffle(!!enabled);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, shuffleEnabled: enabled }));
  }

  /**
   * Handles repeat mode toggle requests.
   *
   * @param req - Incoming HTTP request with { enabled: boolean } body
   * @param res - HTTP response to write to
   */
  private async handlePlaylistRepeat(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { enabled }: { enabled: unknown } = JSON.parse(body);

    this.playlist.setRepeat(!!enabled);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, repeatEnabled: enabled }));
  }

  /**
   * Handles POST /playlist/save requests.
   * Saves the current playlist to a .opp (ONIXPlayer Playlist) file.
   *
   * @param req - Request with { filePath: string } body
   * @param res - HTTP response
   */
  private async handlePlaylistSave(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { filePath }: { filePath: string } = JSON.parse(body);

    if (!filePath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing filePath' }));
      return;
    }

    // The target is attacker-controlled input as far as this handler knows, so
    // constrain it to an absolute, traversal-free .opp path. Without this the
    // endpoint is an arbitrary-file-overwrite primitive.
    const validation: { valid: boolean; error?: string; normalizedPath?: string } =
      UnifiedMediaServer.validatePlaylistSavePath(filePath);
    if (!validation.valid || !validation.normalizedPath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }

    const targetPath: string = validation.normalizedPath;

    const state: PlaylistState = this.playlist.getState();

    if (state.items.length === 0) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Playlist is empty' }));
      return;
    }

    const oppData: object = {
      format: 'onixplayer-playlist',
      version: 1,
      savedAt: new Date().toISOString(),
      items: state.items.map((item: PlaylistItem): object => ({
        filePath: item.filePath,
        title: item.title,
        artist: item.artist,
        album: item.album,
        duration: item.duration,
        type: item.type,
        width: item.width,
        height: item.height,
      })),
    };

    try {
      writeFileSync(targetPath, JSON.stringify(oppData, null, 2), 'utf-8');
      this.playlist.setSourceFilePath(targetPath);
      playlistLogger.info(`Playlist saved to: ${targetPath}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, filePath: targetPath }));
    } catch (err) {
      playlistLogger.error(`Failed to save playlist: ${(err as Error).message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /**
   * Handles POST /playlist/load requests.
   * Loads a playlist from a .opp (ONIXPlayer Playlist) file, replacing the current playlist.
   *
   * @param req - Request with { filePath: string } body
   * @param res - HTTP response
   */
  private async handlePlaylistLoad(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { filePath }: { filePath: string } = JSON.parse(body);

    if (!filePath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing filePath' }));
      return;
    }

    // Validate file exists
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'File not found' }));
      return;
    }

    try {
      const content: string = readFileSync(filePath, 'utf-8');
      const data: unknown = JSON.parse(content);

      // Validate format
      if (
        typeof data !== 'object' || data === null ||
        (data as Record<string, unknown>).format !== 'onixplayer-playlist' ||
        !Array.isArray((data as Record<string, unknown>).items)
      ) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid playlist file format' }));
        return;
      }

      const oppData: { items: Array<Omit<PlaylistItem, 'id'>> } = data as { items: Array<Omit<PlaylistItem, 'id'>> };

      // Stop current playback
      this.playback.state = 'idle';
      this.playback.currentMedia = null;
      this.playback.currentTime = 0;
      this.playback.duration = 0;
      this.stopTimeTracking();

      // Clear and replace playlist
      this.playlist.clear();
      const added: PlaylistItem[] = this.playlist.addItems(oppData.items);

      // Track the source file
      this.playlist.setSourceFilePath(filePath);

      // Add playlist to recent items and notify menu
      this.settings.addRecentPlaylist(filePath);
      const recentItems: RecentItemsSettings = this.settings.getRecentItems();
      this.onRecentItemsChangeCallback?.(recentItems.recentFiles, recentItems.recentPlaylists);

      // Broadcast state updates
      this.broadcastState();
      this.broadcastTime();
      this.onPlaylistCountChangeCallback?.(added.length);

      playlistLogger.info(`Playlist loaded from: ${filePath} (${added.length} items)`);

      // Auto-play first item if playlist has items
      if (added.length > 0) {
        const firstItem: PlaylistItem = added[0];
        this.playlist.selectItem(firstItem.id);

        this.playback.state = 'loading';
        this.broadcastState();

        const mediaInfo: MediaInfo = await this.probeMedia(firstItem.filePath);
        this.playback.currentMedia = mediaInfo;
        this.playback.duration = mediaInfo.duration;
        this.playback.currentTime = 0;
        this.playback.state = 'playing';
        this.startTime = Date.now();

        this.sse.broadcast('playback:loaded', mediaInfo);
        this.broadcastState();
        this.broadcastTime();
        this.startTimeTracking();
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count: added.length, filePath }));
    } catch (err) {
      playlistLogger.error(`Failed to load playlist: ${(err as Error).message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /**
   * Handles GET /playlist/source requests.
   * Returns the source .opp file path of the current playlist (if loaded from file).
   *
   * @param res - HTTP response
   */
  private handlePlaylistSource(res: Readonly<ServerResponse>): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ filePath: this.playlist.getSourceFilePath() }));
  }

  // ============================================================================
  // Settings Handlers
  // ============================================================================

  /**
   * Handles settings retrieval requests.
   *
   * Returns the complete application settings.
   *
   * @param res - HTTP response to write to
   */
  private handleSettingsGet(res: Readonly<ServerResponse>): void {
    const settings: AppSettings = this.settings.getSettings();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(settings));
  }

  /**
   * Handles visualization settings update requests.
   *
   * Updates visualization preferences and broadcasts the change to all clients.
   *
   * @param req - Incoming HTTP request with VisualizationSettingsUpdate body
   * @param res - HTTP response to write to
   */
  private async handleSettingsVisualization(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const update: VisualizationSettingsUpdate = JSON.parse(body) as VisualizationSettingsUpdate;

    const updatedSettings: AppSettings = this.settings.updateVisualizationSettings(update);

    // Broadcast the updated settings to all clients
    this.sse.broadcast('settings:updated', updatedSettings);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, settings: updatedSettings }));
  }

  /**
   * Handles PUT /settings/application requests.
   *
   * Updates application settings and broadcasts the change to all clients.
   * Note: Server port changes require app restart to take effect.
   *
   * @param req - Incoming HTTP request with ApplicationSettingsUpdate body
   * @param res - HTTP response to write to
   */
  private async handleSettingsApplication(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const update: ApplicationSettingsUpdate = JSON.parse(body) as ApplicationSettingsUpdate;

    const updatedSettings: AppSettings = this.settings.updateApplicationSettings(update);

    // Broadcast the updated settings to all clients
    this.sse.broadcast('settings:updated', updatedSettings);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, settings: updatedSettings }));
  }

  /**
   * Handles PUT /settings/playback requests.
   *
   * Updates playback settings and broadcasts the change to all clients.
   *
   * @param req - Incoming HTTP request with PlaybackSettingsUpdate body
   * @param res - HTTP response to write to
   */
  private async handleSettingsPlayback(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const update: PlaybackSettingsUpdate = JSON.parse(body) as PlaybackSettingsUpdate;

    const updatedSettings: AppSettings = this.settings.updatePlaybackSettings(update);

    // Broadcast the updated settings to all clients
    this.sse.broadcast('settings:updated', updatedSettings);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, settings: updatedSettings }));
  }

  /**
   * Handles PUT /settings/transcoding requests.
   *
   * Updates transcoding settings and broadcasts the change to all clients.
   *
   * @param req - Incoming HTTP request with TranscodingSettingsUpdate body
   * @param res - HTTP response to write to
   */
  private async handleSettingsTranscoding(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const update: TranscodingSettingsUpdate = JSON.parse(body) as TranscodingSettingsUpdate;

    const updatedSettings: AppSettings = this.settings.updateTranscodingSettings(update);

    // Broadcast the updated settings to all clients
    this.sse.broadcast('settings:updated', updatedSettings);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, settings: updatedSettings }));
  }

  /**
   * Handles PUT /settings/appearance requests.
   *
   * Updates appearance settings and broadcasts the change to all clients.
   * Note: Appearance settings require an application restart to take effect.
   *
   * @param req - Incoming HTTP request with AppearanceSettingsUpdate body
   * @param res - HTTP response to write to
   */
  private async handleSettingsAppearance(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const update: AppearanceSettingsUpdate = JSON.parse(body) as AppearanceSettingsUpdate;

    const updatedSettings: AppSettings = this.settings.updateAppearanceSettings(update);

    // Broadcast the updated settings to all clients
    this.sse.broadcast('settings:updated', updatedSettings);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, settings: updatedSettings }));
  }

  /**
   * Handles PUT /settings/subtitles requests.
   *
   * Updates subtitle appearance settings and broadcasts the change to all clients.
   *
   * @param req - Incoming HTTP request with SubtitleSettingsUpdate body
   * @param res - HTTP response to write to
   */
  private async handleSettingsSubtitles(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const update: SubtitleSettingsUpdate = JSON.parse(body) as SubtitleSettingsUpdate;

    const updatedSettings: AppSettings = this.settings.updateSubtitleSettings(update);

    // Broadcast the updated settings to all clients
    this.sse.broadcast('settings:updated', updatedSettings);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, settings: updatedSettings }));
  }

  /**
   * Handles PUT /settings/equalizer requests.
   *
   * Updates equalizer settings and broadcasts the change to all clients.
   *
   * @param req - Incoming HTTP request with EqualizerSettingsUpdate body
   * @param res - HTTP response to write to
   */
  private async handleSettingsEqualizer(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const update: EqualizerSettingsUpdate = JSON.parse(body) as EqualizerSettingsUpdate;

    const updatedSettings: AppSettings = this.settings.updateEqualizerSettings(update);

    // Broadcast the updated settings to all clients
    this.sse.broadcast('settings:updated', updatedSettings);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, settings: updatedSettings }));
  }

  /**
   * Handles PUT /settings/videoAdjustments requests.
   *
   * Updates video adjustment settings and broadcasts the change to all clients.
   *
   * @param req - Incoming HTTP request with VideoAdjustmentsSettingsUpdate body
   * @param res - HTTP response to write to
   */
  private async handleSettingsVideoAdjustments(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const update: VideoAdjustmentsSettingsUpdate = JSON.parse(body) as VideoAdjustmentsSettingsUpdate;

    const updatedSettings: AppSettings = this.settings.updateVideoAdjustmentsSettings(update);

    // Broadcast the updated settings to all clients
    this.sse.broadcast('settings:updated', updatedSettings);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, settings: updatedSettings }));
  }

  // ============================================================================
  // Dependencies
  // ============================================================================

  /**
   * Returns the DependencyManager instance.
   * Used by main.ts for IPC handler access.
   */
  public getDependencyManager(): DependencyManager {
    return this.deps;
  }

  /**
   * Returns the current dependency state.
   */
  private handleDependenciesGet(res: Readonly<ServerResponse>): void {
    const preferredSoundFont: string | null = this.settings.getActiveSoundFontFileName();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.deps.getState(preferredSoundFont)));
  }

  /**
   * Installs a dependency asynchronously, streaming progress via SSE.
   * Returns 202 Accepted immediately, then broadcasts progress events.
   */
  private async handleDependenciesInstall(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { id }: { id: DependencyId } = JSON.parse(body) as { id: DependencyId };

    if (id !== 'ffmpeg' && id !== 'fluidsynth' && id !== 'openmpt123' && id !== 'yt-dlp') {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid dependency id' }));
      return;
    }

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));

    await this.deps.installDependency(id, (progress: InstallProgress): void => {
      this.sse.broadcast('dependencies:progress', progress);
    });

    this.broadcastDependencyState();
  }

  /**
   * Uninstalls a dependency asynchronously, streaming progress via SSE.
   * Returns 202 Accepted immediately, then broadcasts progress events.
   */
  private async handleDependenciesUninstall(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { id }: { id: DependencyId } = JSON.parse(body) as { id: DependencyId };

    if (id !== 'ffmpeg' && id !== 'fluidsynth' && id !== 'openmpt123' && id !== 'yt-dlp') {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid dependency id' }));
      return;
    }

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));

    await this.deps.uninstallDependency(id, (progress: InstallProgress): void => {
      this.sse.broadcast('dependencies:progress', progress);
    });

    this.broadcastDependencyState();
  }

  /**
   * Updates a dependency to the latest version asynchronously, streaming
   * progress via SSE. Returns 202 Accepted immediately. Primarily for yt-dlp.
   */
  private async handleDependenciesUpdate(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { id }: { id: DependencyId } = JSON.parse(body) as { id: DependencyId };

    if (id !== 'ffmpeg' && id !== 'fluidsynth' && id !== 'openmpt123' && id !== 'yt-dlp') {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid dependency id' }));
      return;
    }

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));

    await this.deps.updateDependency(id, (progress: InstallProgress): void => {
      this.sse.broadcast('dependencies:progress', progress);
    });

    this.broadcastDependencyState();
  }

  /**
   * Installs a SoundFont file by copying it to the app data directory.
   */
  private async handleSoundFontInstall(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { sourcePath }: { sourcePath: string } = JSON.parse(body) as { sourcePath: string };

    if (!sourcePath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing sourcePath' }));
      return;
    }

    try {
      const info: SoundFontInfo = this.deps.installSoundFont(sourcePath);
      this.broadcastDependencyState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, soundfont: info }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /**
   * Removes a SoundFont file from the app data directory.
   * If the removed file was the active selection, clears the setting.
   */
  private async handleSoundFontRemove(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { fileName }: { fileName: string } = JSON.parse(body) as { fileName: string };

    if (!fileName) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing fileName' }));
      return;
    }

    const removed: boolean = this.deps.removeSoundFont(fileName);
    if (removed) {
      // Clear the active selection if we just removed the active soundfont
      const activeSoundFont: string | null = this.settings.getActiveSoundFontFileName();
      if (activeSoundFont === fileName) {
        this.settings.setActiveSoundFontFileName(null);
        this.nukeMidiCache();
      }
      this.broadcastDependencyState();
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: removed }));
  }

  /**
   * Selects a SoundFont as the active one for MIDI playback.
   * Validates that the file exists before setting.
   * If MIDI is currently playing, stops playback to force re-render with new soundfont.
   */
  private async handleSoundFontSelect(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { fileName }: { fileName: string | null } = JSON.parse(body) as { fileName: string | null };

    // Validate that the soundfont exists (if not null)
    if (fileName !== null) {
      const soundfonts: SoundFontInfo[] = this.deps.getSoundFonts();
      const exists: boolean = soundfonts.some((sf: SoundFontInfo): boolean => sf.fileName === fileName);
      if (!exists) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: `SoundFont "${fileName}" not found` }));
        return;
      }
    }

    // Check if MIDI is currently playing - if so, we need to stop and signal restart
    const currentFile: string | undefined = this.playback.currentMedia?.filePath;
    const isMidiPlaying: boolean = currentFile !== undefined &&
      MIDI_FORMATS.has(path.extname(currentFile).toLowerCase()) &&
      (this.playback.state === 'playing' || this.playback.state === 'paused');

    // Update the setting
    midiLogger.info(`Setting active SoundFont to: "${fileName}"`);
    this.settings.setActiveSoundFontFileName(fileName);

    // Nuke the entire MIDI cache (in-memory and disk)
    this.nukeMidiCache();

    // If MIDI was playing, stop it and signal restart
    if (isMidiPlaying) {
      midiLogger.info('SoundFont changed during MIDI playback - signaling restart');
      this.playback.state = 'stopped';
      this.playback.currentTime = 0;
      this.broadcastState();
      this.broadcastTime();
      // Broadcast a special event for the frontend to restart playback
      this.sse.broadcast('soundfont:changed', {restart: true, filePath: currentFile});
    } else {
      // Always broadcast soundfont change so frontend can invalidate its cache
      this.sse.broadcast('soundfont:changed', {restart: false});
    }

    // Broadcast the updated state
    this.broadcastDependencyState();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, activeSoundFont: fileName }));
  }

  /**
   * Completely nukes all MIDI render caches (in-memory and disk).
   * Deletes the entire MIDI temp directory and clears all in-memory state.
   * Call this on: app startup, app shutdown, playback stop, soundfont change.
   */
  public nukeMidiCache(): void {
    // Clear in-memory caches
    const cacheSize: number = this.midiRenderCache.size;
    const inProgressSize: number = this.midiRenderInProgress.size;
    this.midiRenderCache.clear();
    this.midiRenderInProgress.clear();

    // Delete the entire disk cache directory
    const tempDir: string = path.join(app.getPath('temp'), 'onixplayer-midi');
    let filesDeleted: number = 0;
    try {
      if (existsSync(tempDir)) {
        const files: string[] = readdirSync(tempDir);
        for (const file of files) {
          try {
            unlinkSync(path.join(tempDir, file));
            filesDeleted++;
          } catch {
            // Ignore individual file deletion errors (may be in use)
          }
        }
        // Try to remove the directory itself
        try {
          rmdirSync(tempDir);
        } catch {
          // Directory may not be empty if some files couldn't be deleted
        }
      }
    } catch (err) {
      midiLogger.warn(`Failed to clean MIDI cache directory: ${err}`);
    }

    midiLogger.info(`Nuked MIDI cache: ${cacheSize} in-memory, ${inProgressSize} in-progress, ${filesDeleted} disk files`);
  }

  /**
   * Completely nukes all tracker render caches (in-memory and disk).
   * Deletes the entire tracker temp directory and clears all in-memory state.
   * Called on app startup so tracker renders never persist across sessions.
   */
  public nukeTrackerCache(): void {
    // Clear in-memory caches
    const cacheSize: number = this.trackerRenderCache.size;
    const inProgressSize: number = this.trackerRenderInProgress.size;
    this.trackerRenderCache.clear();
    this.trackerRenderInProgress.clear();

    // Delete the entire disk cache directory
    const tempDir: string = path.join(app.getPath('temp'), 'onixplayer-tracker');
    let filesDeleted: number = 0;
    try {
      if (existsSync(tempDir)) {
        const files: string[] = readdirSync(tempDir);
        for (const file of files) {
          try {
            unlinkSync(path.join(tempDir, file));
            filesDeleted++;
          } catch {
            // Ignore individual file deletion errors (may be in use)
          }
        }
        try {
          rmdirSync(tempDir);
        } catch {
          // Directory may not be empty if some files couldn't be deleted
        }
      }
    } catch (err) {
      midiLogger.warn(`Failed to clean tracker cache directory: ${err}`);
    }

    midiLogger.info(`Nuked tracker cache: ${cacheSize} in-memory, ${inProgressSize} in-progress, ${filesDeleted} disk files`);
  }

  /**
   * Re-detects all binaries and broadcasts the updated state.
   */
  private handleDependenciesRefresh(res: Readonly<ServerResponse>): void {
    this.deps.detectBinaries();
    this.broadcastDependencyState();

    const preferredSoundFont: string | null = this.settings.getActiveSoundFontFileName();
    const state: DependencyState = this.deps.getState(preferredSoundFont);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Maximum allowed request body size in bytes (1MB).
   * Prevents memory exhaustion attacks from oversized requests.
   */
  private static readonly MAX_BODY_SIZE: number = 1024 * 1024;

  /**
   * Reads the body of an HTTP request as a string.
   *
   * Security: Enforces maximum body size to prevent memory exhaustion.
   *
   * @param req - Incoming HTTP request
   * @returns Promise resolving to the body string
   * @throws Error if body exceeds MAX_BODY_SIZE
   */
  private readBody(req: Readonly<IncomingMessage>): Promise<string> {
    return new Promise((resolve: (value: string) => void, reject: (reason: Readonly<Error>) => void): void => {
      const chunks: Buffer[] = [];
      let totalSize: number = 0;

      req.on('data', (chunk: Readonly<Buffer>): void => {
        totalSize += chunk.length;
        if (totalSize > UnifiedMediaServer.MAX_BODY_SIZE) {
          req.destroy();
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk as Buffer);
      });

      req.on('end', (): void => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });

      req.on('error', reject);
    });
  }

  /**
   * Starts the playback time tracking interval.
   *
   * Updates currentTime every 100ms based on elapsed time since startTime.
   * Automatically triggers onMediaEnded when duration is reached.
   */
  private startTimeTracking(): void {
    this.stopTimeTracking();

    this.timeUpdateInterval = setInterval((): void => {
      if (this.playback.state !== 'playing') return;

      this.playback.currentTime = (Date.now() - this.startTime) / 1000;

      // Never auto-end a track whose duration isn't known yet (0). For formats
      // rendered on demand (trackers/MIDI), playback can start in the brief
      // window before the rendered duration is known; ending here would treat
      // currentTime >= 0 as "finished" and immediately stop the track.
      if (this.playback.duration > 0 && this.playback.currentTime >= this.playback.duration) {
        this.playback.currentTime = this.playback.duration;
        // Broadcast the final position so the seek bar visually reaches the
        // end of its track before the ended transition resets it.
        this.broadcastTime();
        void this.onMediaEnded();
        return;
      }

      this.broadcastTime();
    }, 100);
  }

  /**
   * Stops the playback time tracking interval.
   */
  private stopTimeTracking(): void {
    if (this.timeUpdateInterval) {
      clearInterval(this.timeUpdateInterval);
      this.timeUpdateInterval = null;
    }
  }

  /**
   * Handles media ended event.
   *
   * Attempts to play the next track. If no next track is available,
   * transitions to stopped state, selects the first item, and broadcasts
   * the ended event.
   */
  private async onMediaEnded(): Promise<void> {
    this.stopTimeTracking();

    // Try to play next track
    const nextItem: PlaylistItem | null = this.playlist.next();

    if (!nextItem) {
      this.playback.state = 'stopped';
      this.playback.currentTime = 0;
      this.pausedTime = 0;
      this.lastTrackStartAt = Date.now();

      this.broadcastState();
      this.broadcastTime();

      // Select the first item AFTER broadcasting the stopped state, so
      // clients process the selection change with the correct state and
      // don't briefly auto-play the newly selected item (see handleStop).
      if (this.playlist.getState().items.length > 0) {
        this.playlist.selectIndex(0);
      }

      this.sse.broadcast('playback:ended', {});
      return;
    }

    // Play next
    try {
      this.playback.state = 'loading';
      this.broadcastState();

      const mediaInfo: MediaInfo = await this.probeMedia(nextItem.filePath);
      this.playback.currentMedia = mediaInfo;
      this.playback.duration = mediaInfo.duration;
      this.playback.currentTime = 0;
      this.pausedTime = 0;
      this.lastTrackStartAt = Date.now();
      this.playback.state = 'playing';
      this.startTime = Date.now();

      this.sse.broadcast('playback:loaded', mediaInfo);
      this.broadcastState();
      this.broadcastTime();
      this.startTimeTracking();
    } catch (err) {
      this.playback.state = 'error';
      this.playback.errorMessage = (err as Error).message;
      this.broadcastState();
    }
  }

  /**
   * Broadcasts current playback state to all SSE clients.
   */
  private broadcastState(): void {
    this.sse.broadcast('playback:state', {
      state: this.playback.state,
      errorMessage: this.playback.errorMessage,
    });

    // Notify of playback state change for menu state
    this.onPlaybackStateChangeCallback?.(this.playback.state === 'playing');

    // Notify of media type change for menu aspect ratio state
    this.onMediaTypeChangeCallback?.(this.playback.currentMedia?.type === 'video');
  }

  /**
   * Broadcasts current time and duration to all SSE clients.
   */
  private broadcastTime(): void {
    this.sse.broadcast('playback:time', {
      currentTime: this.playback.currentTime,
      duration: this.playback.duration,
    });
  }
}

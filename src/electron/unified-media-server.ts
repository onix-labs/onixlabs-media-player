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
import { createHash } from 'crypto';
import { createReadStream, statSync, existsSync, readFileSync, mkdirSync, unlinkSync, Stats } from 'fs';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { SettingsManager } from './settings-manager.js';
import { serverLogger, playlistLogger, playbackLogger, ffmpegLogger, midiLogger, logHttpRequest, logProcessSpawn, logProcessOutput, logProcessExit } from './logger.js';
import { app } from 'electron';
import { DependencyManager } from './dependency-manager.js';
import type { DependencyId, DependencyState, InstallProgress, SoundFontInfo } from './dependency-manager.js';
import type { AppSettings, VisualizationSettingsUpdate, ApplicationSettingsUpdate, PlaybackSettingsUpdate, TranscodingSettingsUpdate, AppearanceSettingsUpdate } from './settings-manager.js';
import { parseMidiDuration, MIDI_FORMATS } from './midi-parser.js';
import { SSEManager } from './sse-manager.js';
import { PlaylistManager } from './playlist-manager.js';
import type { PlaylistItem, MediaInfo, PlaybackState } from './media-types.js';

// Re-export types that were previously exported from this module
export type { PlaylistItem, MediaInfo } from './media-types.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Video formats that Chromium can play natively.
 * These support HTTP range requests for seeking.
 */
const NATIVE_VIDEO_FORMATS: Set<string> = new Set(['.mp4', '.m4v', '.webm', '.ogg']);

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

  /** SSE manager for real-time client updates */
  private readonly sse: SSEManager = new SSEManager();

  /** Settings manager for persistent user preferences */
  private readonly settings: SettingsManager = new SettingsManager();

  /** Dependency manager for external binary detection and installation */
  private readonly deps: DependencyManager = new DependencyManager(process.platform, app.getPath('userData'));

  /** Playlist manager instance */
  private readonly playlist: PlaylistManager;

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

  /** Callback for playlist mode changes (shuffle/repeat) */
  private onModeChangeCallback: ((shuffle: boolean, repeat: boolean) => void) | null = null;

  /** Callback for playlist count changes (for menu enabled state) */
  private onPlaylistCountChangeCallback: ((count: number) => void) | null = null;

  /** Callback for playback state changes (for menu state) */
  private onPlaybackStateChangeCallback: ((isPlaying: boolean) => void) | null = null;

  /** Callback for dependency state changes (for menu open enabled state) */
  private onDependencyStateChangeCallback: ((ffmpegInstalled: boolean, fluidsynthInstalled: boolean) => void) | null = null;

  /** Callback for media type changes (for menu aspect ratio enabled state) */
  private onMediaTypeChangeCallback: ((isVideo: boolean) => void) | null = null;

  /** Maximum number of entries in the MIDI render cache (FIFO eviction when exceeded) */
  private static readonly MAX_MIDI_CACHE_SIZE: number = 50;

  /** Cache of pre-rendered MIDI files (original path → temp MP3 path + accurate duration) */
  private readonly midiRenderCache: Map<string, {readonly tempFile: string; readonly duration: number}> = new Map();

  /** In-progress MIDI renders for deduplication (original path → completion promise) */
  private readonly midiRenderInProgress: Map<string, Promise<string>> = new Map<string, Promise<string>>();

  /**
   * Creates a new unified media server.
   * Call start() to begin listening for connections.
   */
  public constructor(staticPath?: string) {
    this.playlist = new PlaylistManager(this.sse, this.handleModeChange.bind(this));
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
  public onDependencyStateChange(callback: (ffmpegInstalled: boolean, fluidsynthInstalled: boolean) => void): void {
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
   * Broadcasts dependency state via SSE and notifies the callback.
   */
  private broadcastDependencyState(): void {
    const state: DependencyState = this.deps.getState();
    this.sse.broadcast('dependencies:state', state);
    this.onDependencyStateChangeCallback?.(state.ffmpeg.installed, state.fluidsynth.installed);
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

    // Set CORS headers for browser access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle CORS preflight
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

    try {
      // Route matching
      if (pathname === '/events' && method === 'GET') {
        this.handleSSE(req, res);
      } else if (pathname === '/media/stream' && method === 'GET') {
        this.handleMediaStream(req, res, url);
      } else if (pathname === '/media/info' && method === 'GET') {
        await this.handleMediaInfo(res, url);
      } else if (pathname === '/player/play' && method === 'POST') {
        await this.handlePlay(res);
      } else if (pathname === '/player/pause' && method === 'POST') {
        this.handlePause(res);
      } else if (pathname === '/player/stop' && method === 'POST') {
        this.handleStop(res);
      } else if (pathname === '/player/seek' && method === 'POST') {
        await this.handleSeek(req, res);
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
      } else if (pathname === '/dependencies' && method === 'GET') {
        this.handleDependenciesGet(res);
      } else if (pathname === '/dependencies/install' && method === 'POST') {
        await this.handleDependenciesInstall(req, res);
      } else if (pathname === '/dependencies/uninstall' && method === 'POST') {
        await this.handleDependenciesUninstall(req, res);
      } else if (pathname === '/dependencies/soundfont/install' && method === 'POST') {
        await this.handleSoundFontInstall(req, res);
      } else if (pathname === '/dependencies/soundfont/remove' && method === 'POST') {
        await this.handleSoundFontRemove(req, res);
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
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    this.sse.addClient(res);

    // Send initial state so client is immediately synchronized
    res.write(`event: playback:state\ndata: ${JSON.stringify({ state: this.playback.state, errorMessage: this.playback.errorMessage })}\n\n`);
    res.write(`event: playback:time\ndata: ${JSON.stringify({ currentTime: this.playback.currentTime, duration: this.playback.duration })}\n\n`);
    res.write(`event: playback:volume\ndata: ${JSON.stringify({ volume: this.playback.volume, muted: this.playback.muted })}\n\n`);
    res.write(`event: playlist:updated\ndata: ${JSON.stringify(this.playlist.getState())}\n\n`);
    res.write(`event: settings:updated\ndata: ${JSON.stringify(this.settings.getSettings())}\n\n`);
    res.write(`event: dependencies:state\ndata: ${JSON.stringify(this.deps.getState())}\n\n`);

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
  private validateFilePath(filePath: string): { valid: boolean; error?: string } {
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
   * Routes media stream requests based on file type.
   *
   * Determines whether the file needs:
   * - Direct serving (native formats with range request support)
   * - Transcoding (non-native video/audio formats via FFmpeg)
   * - MIDI synthesis (MIDI files via FluidSynth)
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

    const ext: string = path.extname(filePath).toLowerCase();
    const isNativeVideo: boolean = NATIVE_VIDEO_FORMATS.has(ext);
    const isNativeAudio: boolean = NATIVE_AUDIO_FORMATS.has(ext);
    const isMidi: boolean = MIDI_FORMATS.has(ext);

    if (isMidi) {
      this.serveMidiFile(req, res, filePath);
    } else if (isNativeVideo || isNativeAudio) {
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
   */
  private serveDirectFile(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, filePath: string, ext: string): void {
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
          'Content-Type': mimeType,
          'Access-Control-Allow-Origin': '*',
        });

        createReadStream(filePath, { start, end, highWaterMark: 2 * 1024 * 1024 }).pipe(res); // 2MB buffer for NAS/network latency
      } else {
        // Full file response (200)
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': mimeType,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
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

    // Security: ensure path is within static directory
    if (!filePath.startsWith(this.staticPath)) {
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
   * For video files (.mkv, .avi, .mov):
   * - Transcodes to H.264 video in fragmented MP4 container
   * - Uses fast preset with zero latency tuning for streaming
   * - Supports seeking via the 't' query parameter
   *
   * For audio files (.wma, .ape, .tak):
   * - Transcodes to AAC in ADTS container
   *
   * The transcoded stream is piped directly to the HTTP response.
   *
   * @param req - Incoming HTTP request
   * @param res - HTTP response to write to
   * @param filePath - Absolute path to the file
   * @param url - URL containing optional 't' (time) parameter for seeking
   */
  private serveTranscodedFile(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>, filePath: string, url: Readonly<URL>): void {
    const seekTime: string = url.searchParams.get('t') || '0';
    const ext: string = path.extname(filePath).toLowerCase();

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

    ffmpegLogger.info(`Transcoding: ${path.basename(filePath)} (seek: ${seekTime}s, audio-only: ${isAudioTranscode}, crf: ${crfValue}, audio: ${audioBitrateStr})`);

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
        'Transfer-Encoding': 'chunked',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
    } else {
      // Video transcoding optimized for real-time 4K/UHD playback
      ffmpegArgs = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-threads', '0',            // Use all available CPU cores
        '-ss', seekTime,            // Seek before input (fast seek)
        '-i', filePath,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',     // Fastest encoding for real-time 4K
        '-tune', 'zerolatency',     // Minimize latency
        '-profile:v', 'high',
        '-level', '5.1',            // Level 5.1 supports 4K (level 4.1 only supports 1080p)
        '-pix_fmt', 'yuv420p',      // Maximum compatibility
        '-crf', crfValue,           // Quality level from settings
        '-maxrate', '20M',          // Max bitrate for VBV buffering
        '-bufsize', '8M',           // VBV buffer size for smooth delivery
        '-g', '30',                 // GOP size: keyframe every 30 frames (~1s at 30fps)
        '-bf', '0',                 // No B-frames for low latency
        '-sc_threshold', '0',       // Disable scene change keyframes for consistent timing
        '-c:a', 'aac',
        '-b:a', audioBitrateStr,    // Audio bitrate from settings
        '-ar', '48000',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof', // Fragmented MP4 for streaming
        '-f', 'mp4',
        'pipe:1'
      ];
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Transfer-Encoding': 'chunked',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
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
    return createHash('sha256').update(soundfont).update(content).digest('hex').slice(0, 16);
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
      this.serveDirectFile(req, res, cached.tempFile, '.mp3');
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
      this.serveDirectFile(req, res, tempFile, '.mp3');
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
   *
   * @returns Path to SoundFont file, or undefined if none found
   */
  private findSoundFont(): string | undefined {
    return this.deps.findSoundFont();
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

          // Extract metadata tags (handle various case conventions)
          const tags: Record<string, string> = (format.tags as Record<string, string>) || {};

          resolve({
            duration: parseFloat(format.duration as string) || 0,
            type: hasVideo ? 'video' : 'audio',
            title: tags.title || tags.TITLE || path.basename(filePath, path.extname(filePath)),
            artist: tags.artist || tags.ARTIST || tags.album_artist || tags.ALBUM_ARTIST,
            album: tags.album || tags.ALBUM,
            filePath,
            width: videoStream?.width as number | undefined,
            height: videoStream?.height as number | undefined,
          });
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

      const mediaInfo: MediaInfo = await this.probeMedia(currentItem.filePath);
      this.playback.currentMedia = mediaInfo;
      this.playback.duration = mediaInfo.duration;
      this.playback.currentTime = 0;
      this.playback.state = 'playing';
      this.startTime = Date.now();

      this.sse.broadcast('playback:loaded', mediaInfo);
      this.broadcastState();
      this.broadcastTime();
      this.startTimeTracking();

      playbackLogger.info(`Playing: ${mediaInfo.title} (${mediaInfo.type}, ${mediaInfo.duration.toFixed(1)}s)`);
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
    this.stopTimeTracking();

    // Select first item if playlist has items
    if (this.playlist.getState().items.length > 0) {
      this.playlist.selectIndex(0);
    }

    this.broadcastState();
    this.broadcastTime();

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
        });
      } else {
        playlistLogger.error(`Failed to probe ${(paths as string[])[i]}: ${result.reason}`);
      }
    }

    playlistLogger.info(`Adding ${items.length} item(s) to playlist`);
    const added: PlaylistItem[] = this.playlist.addItems(items);

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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.deps.getState()));
  }

  /**
   * Installs a dependency asynchronously, streaming progress via SSE.
   * Returns 202 Accepted immediately, then broadcasts progress events.
   */
  private async handleDependenciesInstall(req: Readonly<IncomingMessage>, res: Readonly<ServerResponse>): Promise<void> {
    const body: string = await this.readBody(req);
    const { id }: { id: DependencyId } = JSON.parse(body) as { id: DependencyId };

    if (id !== 'ffmpeg' && id !== 'fluidsynth') {
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

    if (id !== 'ffmpeg' && id !== 'fluidsynth') {
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
      this.broadcastDependencyState();
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: removed }));
  }

  /**
   * Re-detects all binaries and broadcasts the updated state.
   */
  private handleDependenciesRefresh(res: Readonly<ServerResponse>): void {
    this.deps.detectBinaries();
    this.broadcastDependencyState();

    const state: DependencyState = this.deps.getState();
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

      if (this.playback.currentTime >= this.playback.duration) {
        this.playback.currentTime = this.playback.duration;
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

      // Select first item if playlist has items
      if (this.playlist.getState().items.length > 0) {
        this.playlist.selectIndex(0);
      }

      this.broadcastState();
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

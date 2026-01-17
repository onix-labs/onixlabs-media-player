import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { createReadStream, statSync } from 'fs';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export interface PlaylistItem {
  id: string;
  filePath: string;
  title: string;
  artist?: string;
  album?: string;
  duration: number;
  type: 'audio' | 'video';
  width?: number;
  height?: number;
}

export interface MediaInfo {
  duration: number;
  type: 'audio' | 'video';
  title: string;
  artist?: string;
  album?: string;
  filePath: string;
  width?: number;
  height?: number;
}

interface PlaylistState {
  items: PlaylistItem[];
  currentIndex: number;
  shuffleEnabled: boolean;
  repeatEnabled: boolean;
}

interface PlaybackState {
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error';
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  currentMedia: MediaInfo | null;
  errorMessage: string | null;
}

type SSEEventType =
  | 'playback:state'
  | 'playback:time'
  | 'playback:loaded'
  | 'playback:ended'
  | 'playback:volume'
  | 'playlist:updated'
  | 'playlist:selection'
  | 'playlist:mode'
  | 'heartbeat';

// ============================================================================
// Constants
// ============================================================================

const NATIVE_VIDEO_FORMATS = new Set(['.mp4', '.webm', '.ogg']);
const NATIVE_AUDIO_FORMATS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac']);

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mkv': 'video/mp4',
  '.avi': 'video/mp4',
  '.mov': 'video/mp4',
};

// ============================================================================
// SSE Manager
// ============================================================================

class SSEManager {
  private clients = new Set<ServerResponse>();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  start(): void {
    // Send heartbeat every 30 seconds to keep connections alive
    this.heartbeatInterval = setInterval(() => {
      this.broadcast('heartbeat', { timestamp: Date.now() });
    }, 30000);
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }

  addClient(res: ServerResponse): void {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  broadcast(event: SSEEventType, data: unknown): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      client.write(message);
    }
  }
}

// ============================================================================
// Playlist Manager
// ============================================================================

class PlaylistManager {
  private items: PlaylistItem[] = [];
  private currentIndex = -1;
  private shuffleEnabled = false;
  private repeatEnabled = false;
  private shuffleOrder: number[] = [];
  private shufflePosition = 0;
  private playHistory: number[] = [];
  private sse: SSEManager;

  constructor(sse: SSEManager) {
    this.sse = sse;
  }

  getState(): PlaylistState {
    return {
      items: this.items,
      currentIndex: this.currentIndex,
      shuffleEnabled: this.shuffleEnabled,
      repeatEnabled: this.repeatEnabled,
    };
  }

  getCurrentItem(): PlaylistItem | null {
    if (this.currentIndex >= 0 && this.currentIndex < this.items.length) {
      return this.items[this.currentIndex];
    }
    return null;
  }

  addItems(newItems: Omit<PlaylistItem, 'id'>[]): PlaylistItem[] {
    const itemsWithIds = newItems.map(item => ({
      ...item,
      id: this.generateId(),
    }));

    this.items.push(...itemsWithIds);

    if (this.shuffleEnabled) {
      this.regenerateShuffleOrder();
    }

    if (this.currentIndex === -1 && this.items.length > 0) {
      this.currentIndex = 0;
      if (this.shuffleEnabled) {
        this.shufflePosition = this.shuffleOrder.indexOf(0);
      }
    }

    this.broadcastPlaylistUpdate();
    return itemsWithIds;
  }

  removeItem(id: string): boolean {
    const idx = this.items.findIndex(item => item.id === id);
    if (idx === -1) return false;

    const currentIdx = this.currentIndex;
    this.items = this.items.filter(item => item.id !== id);

    if (idx < currentIdx) {
      this.currentIndex--;
    } else if (idx === currentIdx) {
      if (this.items.length === 0) {
        this.currentIndex = -1;
      } else if (currentIdx >= this.items.length) {
        this.currentIndex = this.items.length - 1;
      }
    }

    if (this.shuffleEnabled) {
      this.regenerateShuffleOrder();
    }

    this.broadcastPlaylistUpdate();
    return true;
  }

  clear(): void {
    this.items = [];
    this.currentIndex = -1;
    this.shuffleOrder = [];
    this.shufflePosition = 0;
    this.playHistory = [];
    this.broadcastPlaylistUpdate();
  }

  selectItem(id: string): PlaylistItem | null {
    const idx = this.items.findIndex(item => item.id === id);
    if (idx === -1) return null;

    this.currentIndex = idx;
    this.playHistory.push(idx);

    if (this.shuffleEnabled) {
      this.shufflePosition = this.shuffleOrder.indexOf(idx);
    }

    this.broadcastSelectionChange();
    return this.getCurrentItem();
  }

  selectIndex(index: number): PlaylistItem | null {
    if (index < 0 || index >= this.items.length) return null;

    this.currentIndex = index;
    this.playHistory.push(index);

    if (this.shuffleEnabled) {
      this.shufflePosition = this.shuffleOrder.indexOf(index);
    }

    this.broadcastSelectionChange();
    return this.getCurrentItem();
  }

  next(): PlaylistItem | null {
    if (this.items.length === 0) return null;

    if (this.repeatEnabled && !this.canGoNext()) {
      // Repeat playlist from beginning
      if (this.shuffleEnabled) {
        this.regenerateShuffleOrder();
        this.shufflePosition = 0;
        this.currentIndex = this.shuffleOrder[0];
      } else {
        this.currentIndex = 0;
      }
      this.playHistory.push(this.currentIndex);
      this.broadcastSelectionChange();
      return this.getCurrentItem();
    }

    if (!this.canGoNext()) return null;

    if (this.shuffleEnabled) {
      this.shufflePosition++;
      this.currentIndex = this.shuffleOrder[this.shufflePosition];
    } else {
      this.currentIndex++;
    }

    this.playHistory.push(this.currentIndex);
    this.broadcastSelectionChange();
    return this.getCurrentItem();
  }

  previous(): PlaylistItem | null {
    if (this.items.length === 0) return null;

    // Check play history first
    if (this.playHistory.length > 1) {
      this.playHistory.pop();
      const prevIdx = this.playHistory[this.playHistory.length - 1];
      if (prevIdx !== undefined && prevIdx >= 0 && prevIdx < this.items.length) {
        this.currentIndex = prevIdx;
        if (this.shuffleEnabled) {
          this.shufflePosition = this.shuffleOrder.indexOf(prevIdx);
        }
        this.broadcastSelectionChange();
        return this.getCurrentItem();
      }
    }

    if (!this.canGoPrevious()) {
      if (this.repeatEnabled) {
        if (this.shuffleEnabled) {
          this.shufflePosition = this.shuffleOrder.length - 1;
          this.currentIndex = this.shuffleOrder[this.shufflePosition];
        } else {
          this.currentIndex = this.items.length - 1;
        }
        this.playHistory.push(this.currentIndex);
        this.broadcastSelectionChange();
        return this.getCurrentItem();
      }
      return null;
    }

    if (this.shuffleEnabled) {
      this.shufflePosition--;
      this.currentIndex = this.shuffleOrder[this.shufflePosition];
    } else {
      this.currentIndex--;
    }

    this.playHistory.push(this.currentIndex);
    this.broadcastSelectionChange();
    return this.getCurrentItem();
  }

  setShuffle(enabled: boolean): void {
    if (this.shuffleEnabled === enabled) return;

    this.shuffleEnabled = enabled;

    if (enabled) {
      this.regenerateShuffleOrder();
      this.shufflePosition = this.shuffleOrder.indexOf(this.currentIndex);
      if (this.shufflePosition === -1) this.shufflePosition = 0;
    }

    this.playHistory = [this.currentIndex];
    this.broadcastModeChange();
  }

  setRepeat(enabled: boolean): void {
    if (this.repeatEnabled === enabled) return;
    this.repeatEnabled = enabled;
    this.broadcastModeChange();
  }

  private canGoNext(): boolean {
    if (this.items.length === 0) return false;
    if (this.shuffleEnabled) {
      return this.shufflePosition < this.shuffleOrder.length - 1;
    }
    return this.currentIndex < this.items.length - 1;
  }

  private canGoPrevious(): boolean {
    if (this.items.length === 0) return false;
    if (this.shuffleEnabled) {
      return this.shufflePosition > 0;
    }
    return this.currentIndex > 0;
  }

  private regenerateShuffleOrder(): void {
    const length = this.items.length;
    if (length === 0) {
      this.shuffleOrder = [];
      return;
    }

    this.shuffleOrder = Array.from({ length }, (_, i) => i);

    // Fisher-Yates shuffle
    for (let i = length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.shuffleOrder[i], this.shuffleOrder[j]] = [this.shuffleOrder[j], this.shuffleOrder[i]];
    }

    // Move current track to front
    const currentIdx = this.currentIndex;
    if (currentIdx >= 0) {
      const posInShuffle = this.shuffleOrder.indexOf(currentIdx);
      if (posInShuffle > 0) {
        [this.shuffleOrder[0], this.shuffleOrder[posInShuffle]] = [this.shuffleOrder[posInShuffle], this.shuffleOrder[0]];
      }
    }

    this.shufflePosition = 0;
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  private broadcastPlaylistUpdate(): void {
    this.sse.broadcast('playlist:updated', this.getState());
  }

  private broadcastSelectionChange(): void {
    this.sse.broadcast('playlist:selection', {
      currentIndex: this.currentIndex,
      currentItem: this.getCurrentItem(),
    });
  }

  private broadcastModeChange(): void {
    this.sse.broadcast('playlist:mode', {
      shuffleEnabled: this.shuffleEnabled,
      repeatEnabled: this.repeatEnabled,
    });
  }
}

// ============================================================================
// Unified Media Server
// ============================================================================

export class UnifiedMediaServer {
  private server: Server | null = null;
  private port = 0;

  private sse = new SSEManager();
  private playlist: PlaylistManager;

  private playback: PlaybackState = {
    state: 'idle',
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    currentMedia: null,
    errorMessage: null,
  };

  private timeUpdateInterval: NodeJS.Timeout | null = null;
  private startTime = 0;
  private pausedTime = 0;

  constructor() {
    this.playlist = new PlaylistManager(this.sse);
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer(this.handleRequest.bind(this));
      this.server.on('error', reject);

      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        if (typeof address === 'object' && address) {
          this.port = address.port;
          console.log(`Unified media server started on http://127.0.0.1:${this.port}`);
          this.sse.start();
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });
    });
  }

  stop(): void {
    this.stopTimeTracking();
    this.sse.stop();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  getPort(): number {
    return this.port;
  }

  // ============================================================================
  // HTTP Request Router
  // ============================================================================

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    const method = req.method || 'GET';
    const pathname = url.pathname;

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

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
        this.handlePlaylistRemove(res, pathname);
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
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      console.error('Request error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  // ============================================================================
  // SSE Handler
  // ============================================================================

  private handleSSE(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    this.sse.addClient(res);

    // Send initial state
    res.write(`event: playback:state\ndata: ${JSON.stringify({ state: this.playback.state, errorMessage: this.playback.errorMessage })}\n\n`);
    res.write(`event: playback:time\ndata: ${JSON.stringify({ currentTime: this.playback.currentTime, duration: this.playback.duration })}\n\n`);
    res.write(`event: playback:volume\ndata: ${JSON.stringify({ volume: this.playback.volume, muted: this.playback.muted })}\n\n`);
    res.write(`event: playlist:updated\ndata: ${JSON.stringify(this.playlist.getState())}\n\n`);

    if (this.playback.currentMedia) {
      res.write(`event: playback:loaded\ndata: ${JSON.stringify(this.playback.currentMedia)}\n\n`);
    }

    req.on('close', () => {
      // Client handled by SSEManager
    });
  }

  // ============================================================================
  // Media Streaming
  // ============================================================================

  private handleMediaStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const filePath = url.searchParams.get('path');
    if (!filePath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing path parameter' }));
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const isNativeVideo = NATIVE_VIDEO_FORMATS.has(ext);
    const isNativeAudio = NATIVE_AUDIO_FORMATS.has(ext);

    if (isNativeVideo || isNativeAudio) {
      this.serveDirectFile(req, res, filePath, ext);
    } else {
      this.serveTranscodedFile(req, res, filePath, url);
    }
  }

  private serveDirectFile(req: IncomingMessage, res: ServerResponse, filePath: string, ext: string): void {
    try {
      const stat = statSync(filePath);
      const fileSize = stat.size;
      const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mimeType,
          'Access-Control-Allow-Origin': '*',
        });

        createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': mimeType,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
        });

        createReadStream(filePath).pipe(res);
      }
    } catch (err) {
      console.error('Error serving file:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Error reading file' }));
    }
  }

  private serveTranscodedFile(req: IncomingMessage, res: ServerResponse, filePath: string, url: URL): void {
    const seekTime = url.searchParams.get('t') || '0';
    const ext = path.extname(filePath).toLowerCase();

    // Determine if this is audio-only transcoding
    const isAudioTranscode = ['.wma', '.ape', '.tak'].includes(ext);

    console.log(`Transcoding: ${filePath} (seek: ${seekTime}s, audio-only: ${isAudioTranscode})`);

    let ffmpegArgs: string[];

    if (isAudioTranscode) {
      // Audio-only transcoding to AAC
      ffmpegArgs = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-ss', seekTime,
        '-i', filePath,
        '-c:a', 'aac',
        '-b:a', '192k',
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
      // Video transcoding to fragmented MP4
      ffmpegArgs = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-ss', seekTime,
        '-i', filePath,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-profile:v', 'high',
        '-level', '4.1',
        '-pix_fmt', 'yuv420p',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '48000',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
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

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.log('FFmpeg:', msg);
    });

    ffmpeg.on('error', (err) => {
      console.error('FFmpeg spawn error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`FFmpeg exited with code ${code}`);
      }
    });

    const cleanup = () => {
      if (ffmpeg.exitCode === null) {
        ffmpeg.kill('SIGKILL');
      }
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  // ============================================================================
  // Media Info (ffprobe)
  // ============================================================================

  private async handleMediaInfo(res: ServerResponse, url: URL): Promise<void> {
    const filePath = url.searchParams.get('path');
    if (!filePath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing path parameter' }));
      return;
    }

    try {
      const info = await this.probeMedia(filePath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private probeMedia(filePath: string): Promise<MediaInfo> {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath
      ]);

      let output = '';
      let errorOutput = '';

      ffprobe.stdout.on('data', (data) => { output += data; });
      ffprobe.stderr.on('data', (data) => { errorOutput += data; });

      ffprobe.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffprobe failed: ${errorOutput}`));
          return;
        }

        try {
          const data = JSON.parse(output);
          const format = data.format || {};
          const streams = data.streams || [];

          const videoStream = streams.find((s: { codec_type: string; codec_name: string }) =>
            s.codec_type === 'video' && s.codec_name !== 'mjpeg'
          );
          const hasVideo = !!videoStream;

          const tags = format.tags || {};

          resolve({
            duration: parseFloat(format.duration) || 0,
            type: hasVideo ? 'video' : 'audio',
            title: tags.title || tags.TITLE || path.basename(filePath, path.extname(filePath)),
            artist: tags.artist || tags.ARTIST || tags.album_artist || tags.ALBUM_ARTIST,
            album: tags.album || tags.ALBUM,
            filePath,
            width: videoStream?.width,
            height: videoStream?.height,
          });
        } catch (e) {
          reject(new Error(`Failed to parse ffprobe output: ${e}`));
        }
      });

      ffprobe.on('error', (err) => {
        reject(new Error(`ffprobe error: ${err.message}`));
      });
    });
  }

  // ============================================================================
  // Playback Control Handlers
  // ============================================================================

  private async handlePlay(res: ServerResponse): Promise<void> {
    // If paused, resume
    if (this.playback.state === 'paused') {
      this.playback.state = 'playing';
      this.startTime = Date.now() - (this.pausedTime * 1000);
      this.startTimeTracking();
      this.broadcastState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // If no current track, try to select first
    const currentItem = this.playlist.getCurrentItem();
    if (!currentItem) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'No track selected' }));
      return;
    }

    // Load and play current track
    try {
      this.playback.state = 'loading';
      this.broadcastState();

      const mediaInfo = await this.probeMedia(currentItem.filePath);
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
      res.end(JSON.stringify({ success: true, media: mediaInfo }));
    } catch (err) {
      this.playback.state = 'error';
      this.playback.errorMessage = (err as Error).message;
      this.broadcastState();
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private handlePause(res: ServerResponse): void {
    if (this.playback.state !== 'playing') {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Not playing' }));
      return;
    }

    this.playback.state = 'paused';
    this.pausedTime = this.playback.currentTime;
    this.stopTimeTracking();
    this.broadcastState();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  private handleStop(res: ServerResponse): void {
    this.playback.state = 'stopped';
    this.playback.currentTime = 0;
    this.stopTimeTracking();
    this.broadcastState();
    this.broadcastTime();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  private async handleSeek(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { time } = JSON.parse(body);

    if (typeof time !== 'number') {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid time' }));
      return;
    }

    const clampedTime = Math.max(0, Math.min(time, this.playback.duration));
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

  private async handleVolume(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { volume, muted } = JSON.parse(body);

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

  private handlePlayerState(res: ServerResponse): void {
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

  private handlePlaylistGet(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.playlist.getState()));
  }

  private async handlePlaylistAdd(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { paths } = JSON.parse(body);

    if (!Array.isArray(paths)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'paths must be an array' }));
      return;
    }

    // Probe each file for metadata
    const items: Omit<PlaylistItem, 'id'>[] = [];
    for (const filePath of paths) {
      try {
        const info = await this.probeMedia(filePath);
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
      } catch (err) {
        console.error(`Failed to probe ${filePath}:`, err);
      }
    }

    const added = this.playlist.addItems(items);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, added }));
  }

  private handlePlaylistRemove(res: ServerResponse, pathname: string): void {
    const id = pathname.replace('/playlist/remove/', '');
    const success = this.playlist.removeItem(id);

    res.writeHead(success ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success }));
  }

  private handlePlaylistClear(res: ServerResponse): void {
    this.playlist.clear();
    this.playback.state = 'idle';
    this.playback.currentMedia = null;
    this.playback.currentTime = 0;
    this.playback.duration = 0;
    this.stopTimeTracking();
    this.broadcastState();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  private async handlePlaylistSelect(res: ServerResponse, pathname: string): Promise<void> {
    const id = pathname.replace('/playlist/select/', '');
    const item = this.playlist.selectItem(id);

    if (!item) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Item not found' }));
      return;
    }

    // Auto-play selected item
    try {
      this.playback.state = 'loading';
      this.broadcastState();

      const mediaInfo = await this.probeMedia(item.filePath);
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

  private async handlePlaylistNext(res: ServerResponse): Promise<void> {
    const item = this.playlist.next();

    if (!item) {
      // End of playlist
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

      const mediaInfo = await this.probeMedia(item.filePath);
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

  private async handlePlaylistPrevious(res: ServerResponse): Promise<void> {
    const item = this.playlist.previous();

    if (!item) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, reason: 'No previous track' }));
      return;
    }

    // Play previous item
    try {
      this.playback.state = 'loading';
      this.broadcastState();

      const mediaInfo = await this.probeMedia(item.filePath);
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

  private async handlePlaylistShuffle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { enabled } = JSON.parse(body);

    this.playlist.setShuffle(!!enabled);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, shuffleEnabled: enabled }));
  }

  private async handlePlaylistRepeat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const { enabled } = JSON.parse(body);

    this.playlist.setRepeat(!!enabled);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, repeatEnabled: enabled }));
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  private startTimeTracking(): void {
    this.stopTimeTracking();

    this.timeUpdateInterval = setInterval(() => {
      if (this.playback.state !== 'playing') return;

      this.playback.currentTime = (Date.now() - this.startTime) / 1000;

      if (this.playback.currentTime >= this.playback.duration) {
        this.playback.currentTime = this.playback.duration;
        this.onMediaEnded();
        return;
      }

      this.broadcastTime();
    }, 100);
  }

  private stopTimeTracking(): void {
    if (this.timeUpdateInterval) {
      clearInterval(this.timeUpdateInterval);
      this.timeUpdateInterval = null;
    }
  }

  private async onMediaEnded(): Promise<void> {
    this.stopTimeTracking();

    // Try to play next track
    const nextItem = this.playlist.next();

    if (!nextItem) {
      this.playback.state = 'idle';
      this.playback.currentTime = 0;
      this.broadcastState();
      this.sse.broadcast('playback:ended', {});
      return;
    }

    // Play next
    try {
      this.playback.state = 'loading';
      this.broadcastState();

      const mediaInfo = await this.probeMedia(nextItem.filePath);
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

  private broadcastState(): void {
    this.sse.broadcast('playback:state', {
      state: this.playback.state,
      errorMessage: this.playback.errorMessage,
    });
  }

  private broadcastTime(): void {
    this.sse.broadcast('playback:time', {
      currentTime: this.playback.currentTime,
      duration: this.playback.duration,
    });
  }
}

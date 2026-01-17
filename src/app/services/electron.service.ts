import {Injectable, NgZone, OnDestroy, signal} from '@angular/core';
import type {MediaInfo, PlaylistItem, PlaylistState} from '../types/electron';

export type {MediaInfo, PlaylistItem, PlaylistState};

@Injectable({providedIn: 'root'})
export class ElectronService implements OnDestroy {
  // Server connection
  private serverPort: number = 0;
  private eventSource: EventSource | null = null;
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_DELAY: number = 30000;

  // Signals for state (updated via SSE)
  readonly serverUrl: ReturnType<typeof signal<string>> = signal<string>('');
  readonly playbackState: ReturnType<typeof signal<string>> = signal<string>('idle');
  readonly currentTime: ReturnType<typeof signal<number>> = signal<number>(0);
  readonly duration: ReturnType<typeof signal<number>> = signal<number>(0);
  readonly volume: ReturnType<typeof signal<number>> = signal<number>(1);
  readonly muted: ReturnType<typeof signal<boolean>> = signal<boolean>(false);
  readonly currentMedia: ReturnType<typeof signal<MediaInfo | null>> = signal<MediaInfo | null>(null);
  readonly errorMessage: ReturnType<typeof signal<string | null>> = signal<string | null>(null);
  readonly playlist: ReturnType<typeof signal<PlaylistState>> = signal<PlaylistState>({
    items: [],
    currentIndex: -1,
    shuffleEnabled: false,
    repeatEnabled: false,
  });
  readonly mediaEnded: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  constructor(private ngZone: NgZone) {
    this.initialize();
  }

  get isElectron(): boolean {
    return !!window.mediaPlayer;
  }

  private get api() {
    return window.mediaPlayer;
  }

  private async initialize(): Promise<void> {
    if (!this.isElectron || !this.api) return;

    // Get server port via IPC
    this.serverPort = await this.api.getServerPort();
    this.serverUrl.set(`http://127.0.0.1:${this.serverPort}`);
    console.log(`Connected to media server at ${this.serverUrl()}`);

    // Connect to SSE for real-time updates
    this.connectSSE();
  }

  private connectSSE(): void {
    if (!this.serverUrl()) return;

    this.eventSource = new EventSource(`${this.serverUrl()}/events`);

    this.eventSource.onopen = () => {
      console.log('SSE connection established');
      this.reconnectAttempts = 0;
    };

    this.eventSource.onerror = () => {
      console.error('SSE connection error');
      this.eventSource?.close();

      // Exponential backoff reconnection
      const delay: number = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.MAX_RECONNECT_DELAY);
      this.reconnectAttempts++;
      setTimeout(() => this.connectSSE(), delay);
    };

    // Playback state events
    this.eventSource.addEventListener('playback:state', (e: MessageEvent) => {
      this.ngZone.run(() => {
        const data: { state: string; errorMessage?: string } = JSON.parse(e.data);
        this.playbackState.set(data.state);
        this.errorMessage.set(data.errorMessage || null);
      });
    });

    this.eventSource.addEventListener('playback:time', (e: MessageEvent) => {
      this.ngZone.run(() => {
        const data: { currentTime: number; duration: number } = JSON.parse(e.data);
        this.currentTime.set(data.currentTime);
        this.duration.set(data.duration);
      });
    });

    this.eventSource.addEventListener('playback:loaded', (e: MessageEvent) => {
      this.ngZone.run(() => {
        const data: MediaInfo = JSON.parse(e.data);
        this.currentMedia.set(data);
        this.duration.set(data.duration);
      });
    });

    this.eventSource.addEventListener('playback:volume', (e: MessageEvent) => {
      this.ngZone.run(() => {
        const data: { volume: number; muted: boolean } = JSON.parse(e.data);
        this.volume.set(data.volume);
        this.muted.set(data.muted);
      });
    });

    this.eventSource.addEventListener('playback:ended', () => {
      this.ngZone.run(() => {
        // Trigger media ended signal briefly
        this.mediaEnded.set(true);
        setTimeout(() => this.mediaEnded.set(false), 100);
      });
    });

    // Playlist events
    this.eventSource.addEventListener('playlist:updated', (e: MessageEvent) => {
      this.ngZone.run(() => {
        const data: PlaylistState = JSON.parse(e.data);
        this.playlist.set(data);
      });
    });

    this.eventSource.addEventListener('playlist:selection', (e: MessageEvent) => {
      this.ngZone.run(() => {
        const data: { currentIndex: number; currentItem?: PlaylistItem } = JSON.parse(e.data);
        this.playlist.update((p: PlaylistState) => ({...p, currentIndex: data.currentIndex}));
        if (data.currentItem) {
          this.currentMedia.set(data.currentItem);
        }
      });
    });

    this.eventSource.addEventListener('playlist:mode', (e: MessageEvent) => {
      this.ngZone.run(() => {
        const data: { shuffleEnabled: boolean; repeatEnabled: boolean } = JSON.parse(e.data);
        this.playlist.update((p: PlaylistState) => ({
          ...p,
          shuffleEnabled: data.shuffleEnabled,
          repeatEnabled: data.repeatEnabled,
        }));
      });
    });
  }

  // ============================================================================
  // IPC Methods (file operations only)
  // ============================================================================

  async openFileDialog(multiSelect: boolean = true): Promise<string[]> {
    if (!this.isElectron || !this.api) return [];

    return this.api.openFileDialog({
      filters: [
        {name: 'Media Files', extensions: ['mp3', 'mp4', 'flac', 'mkv', 'avi', 'wav', 'ogg', 'webm', 'm4a', 'aac', 'wma', 'mov']},
        {name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma']},
        {name: 'Video', extensions: ['mp4', 'mkv', 'avi', 'webm', 'mov']}
      ],
      multiSelections: multiSelect
    });
  }

  getPathForFile(file: File): string {
    if (!this.isElectron || !this.api) {
      throw new Error('Not running in Electron');
    }
    return this.api.getPathForFile(file);
  }

  // ============================================================================
  // HTTP API Methods - Playback Control
  // ============================================================================

  async play(): Promise<void> {
    await this.post('/player/play');
  }

  async pause(): Promise<void> {
    await this.post('/player/pause');
  }

  async stop(): Promise<void> {
    await this.post('/player/stop');
  }

  async seek(timeSeconds: number): Promise<void> {
    await this.post('/player/seek', {time: timeSeconds});
  }

  async setVolume(volume: number, muted?: boolean): Promise<void> {
    const body: {volume?: number; muted?: boolean} = {};
    if (typeof volume === 'number') body.volume = volume;
    if (typeof muted === 'boolean') body.muted = muted;
    await this.post('/player/volume', body);
  }

  async getPlayerState(): Promise<unknown> {
    return this.get('/player/state');
  }

  // ============================================================================
  // HTTP API Methods - Playlist
  // ============================================================================

  async getPlaylist(): Promise<PlaylistState> {
    return this.get('/playlist');
  }

  async addToPlaylist(paths: string[]): Promise<{added: PlaylistItem[]}> {
    return this.post('/playlist/add', {paths});
  }

  async removeFromPlaylist(id: string): Promise<void> {
    await this.delete(`/playlist/remove/${id}`);
  }

  async clearPlaylist(): Promise<void> {
    await this.delete('/playlist/clear');
  }

  async selectTrack(id: string): Promise<void> {
    await this.post(`/playlist/select/${id}`);
  }

  async nextTrack(): Promise<void> {
    await this.post('/playlist/next');
  }

  async previousTrack(): Promise<void> {
    await this.post('/playlist/previous');
  }

  async setShuffle(enabled: boolean): Promise<void> {
    await this.post('/playlist/shuffle', {enabled});
  }

  async setRepeat(enabled: boolean): Promise<void> {
    await this.post('/playlist/repeat', {enabled});
  }

  // ============================================================================
  // HTTP API Methods - Media Info
  // ============================================================================

  async getMediaInfo(filePath: string): Promise<MediaInfo> {
    return this.get(`/media/info?path=${encodeURIComponent(filePath)}`);
  }

  getStreamUrl(filePath: string, seekTime?: number): string {
    let url: string = `${this.serverUrl()}/media/stream?path=${encodeURIComponent(filePath)}`;
    if (seekTime !== undefined && seekTime > 0) {
      url += `&t=${seekTime}`;
    }
    return url;
  }

  // ============================================================================
  // HTTP Helpers
  // ============================================================================

  private async get<T>(endpoint: string): Promise<T> {
    const response: Response = await fetch(`${this.serverUrl()}${endpoint}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  private async post<T>(endpoint: string, body?: unknown): Promise<T> {
    const response: Response = await fetch(`${this.serverUrl()}${endpoint}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  private async delete<T>(endpoint: string): Promise<T> {
    const response: Response = await fetch(`${this.serverUrl()}${endpoint}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  ngOnDestroy(): void {
    this.eventSource?.close();
  }
}

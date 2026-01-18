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
  public readonly serverUrl: ReturnType<typeof signal<string>> = signal<string>('');
  public readonly playbackState: ReturnType<typeof signal<string>> = signal<string>('idle');
  public readonly currentTime: ReturnType<typeof signal<number>> = signal<number>(0);
  public readonly duration: ReturnType<typeof signal<number>> = signal<number>(0);
  public readonly volume: ReturnType<typeof signal<number>> = signal<number>(1);
  public readonly muted: ReturnType<typeof signal<boolean>> = signal<boolean>(false);
  public readonly currentMedia: ReturnType<typeof signal<MediaInfo | null>> = signal<MediaInfo | null>(null);
  public readonly errorMessage: ReturnType<typeof signal<string | null>> = signal<string | null>(null);
  public readonly playlist: ReturnType<typeof signal<PlaylistState>> = signal<PlaylistState>({
    items: [],
    currentIndex: -1,
    shuffleEnabled: false,
    repeatEnabled: false,
  });
  public readonly mediaEnded: ReturnType<typeof signal<boolean>> = signal<boolean>(false);
  public readonly isFullscreen: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  private fullscreenCleanup: (() => void) | null = null;

  constructor(private readonly ngZone: NgZone) {
    this.initialize();
  }

  public get isElectron(): boolean {
    return !!window.mediaPlayer;
  }

  private get api(): typeof window.mediaPlayer {
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

    // Setup fullscreen listener
    this.setupFullscreenListener();
  }

  private setupFullscreenListener(): void {
    if (!this.isElectron || !this.api) return;

    // Get initial fullscreen state
    this.api.isFullscreen().then((isFullscreen: boolean): void => {
      this.ngZone.run((): void => {
        this.isFullscreen.set(isFullscreen);
      });
    });

    // Listen for fullscreen changes
    this.fullscreenCleanup = this.api.onFullscreenChange((isFullscreen: boolean): void => {
      this.ngZone.run((): void => {
        this.isFullscreen.set(isFullscreen);
      });
    });
  }

  private connectSSE(): void {
    if (!this.serverUrl()) return;

    this.eventSource = new EventSource(`${this.serverUrl()}/events`);

    this.eventSource.onopen = (): void => {
      console.log('SSE connection established');
      this.reconnectAttempts = 0;
    };

    this.eventSource.onerror = (): void => {
      console.error('SSE connection error');
      this.eventSource?.close();

      // Exponential backoff reconnection
      const delay: number = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.MAX_RECONNECT_DELAY);
      this.reconnectAttempts++;
      setTimeout((): void => { this.connectSSE(); }, delay);
    };

    // Playback state events
    this.eventSource.addEventListener('playback:state', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: { state: string; errorMessage?: string } = JSON.parse(e.data);
        this.playbackState.set(data.state);
        this.errorMessage.set(data.errorMessage || null);
      });
    });

    this.eventSource.addEventListener('playback:time', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: { currentTime: number; duration: number } = JSON.parse(e.data);
        this.currentTime.set(data.currentTime);
        this.duration.set(data.duration);
      });
    });

    this.eventSource.addEventListener('playback:loaded', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: MediaInfo = JSON.parse(e.data);
        this.currentMedia.set(data);
        this.duration.set(data.duration);
      });
    });

    this.eventSource.addEventListener('playback:volume', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: { volume: number; muted: boolean } = JSON.parse(e.data);
        this.volume.set(data.volume);
        this.muted.set(data.muted);
      });
    });

    this.eventSource.addEventListener('playback:ended', (): void => {
      this.ngZone.run((): void => {
        // Trigger media ended signal briefly
        this.mediaEnded.set(true);
        setTimeout((): void => { this.mediaEnded.set(false); }, 100);
      });
    });

    // Playlist events
    this.eventSource.addEventListener('playlist:updated', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: PlaylistState = JSON.parse(e.data);
        this.playlist.set(data);
      });
    });

    this.eventSource.addEventListener('playlist:selection', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: { currentIndex: number; currentItem?: PlaylistItem } = JSON.parse(e.data);
        this.playlist.update((p: PlaylistState): PlaylistState => ({...p, currentIndex: data.currentIndex}));
        if (data.currentItem) {
          this.currentMedia.set(data.currentItem);
        }
      });
    });

    this.eventSource.addEventListener('playlist:mode', (e: MessageEvent): void => {
      this.ngZone.run((): void => {
        const data: { shuffleEnabled: boolean; repeatEnabled: boolean } = JSON.parse(e.data);
        this.playlist.update((p: PlaylistState): PlaylistState => ({
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

  public async openFileDialog(multiSelect: boolean = true): Promise<string[]> {
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

  public getPathForFile(file: File): string {
    if (!this.isElectron || !this.api) {
      throw new Error('Not running in Electron');
    }
    return this.api.getPathForFile(file);
  }

  // ============================================================================
  // IPC Methods - Fullscreen Control
  // ============================================================================

  public async enterFullscreen(): Promise<void> {
    if (!this.isElectron || !this.api) return;
    await this.api.enterFullscreen();
  }

  public async exitFullscreen(): Promise<void> {
    if (!this.isElectron || !this.api) return;
    await this.api.exitFullscreen();
  }

  public async toggleFullscreen(): Promise<void> {
    if (this.isFullscreen()) {
      await this.exitFullscreen();
    } else {
      await this.enterFullscreen();
    }
  }

  // ============================================================================
  // HTTP API Methods - Playback Control
  // ============================================================================

  public async play(): Promise<void> {
    await this.post('/player/play');
  }

  public async pause(): Promise<void> {
    await this.post('/player/pause');
  }

  public async stop(): Promise<void> {
    await this.post('/player/stop');
  }

  public async seek(timeSeconds: number): Promise<void> {
    await this.post('/player/seek', {time: timeSeconds});
  }

  public async setVolume(volume: number, muted?: boolean): Promise<void> {
    const body: {volume?: number; muted?: boolean} = {};
    if (typeof volume === 'number') body.volume = volume;
    if (typeof muted === 'boolean') body.muted = muted;
    await this.post('/player/volume', body);
  }

  public async getPlayerState(): Promise<unknown> {
    return this.get('/player/state');
  }

  // ============================================================================
  // HTTP API Methods - Playlist
  // ============================================================================

  public async getPlaylist(): Promise<PlaylistState> {
    return this.get('/playlist');
  }

  public async addToPlaylist(paths: string[]): Promise<{added: PlaylistItem[]}> {
    return this.post('/playlist/add', {paths});
  }

  public async removeFromPlaylist(id: string): Promise<void> {
    await this.delete(`/playlist/remove/${id}`);
  }

  public async clearPlaylist(): Promise<void> {
    await this.delete('/playlist/clear');
  }

  public async selectTrack(id: string): Promise<void> {
    await this.post(`/playlist/select/${id}`);
  }

  public async nextTrack(): Promise<void> {
    await this.post('/playlist/next');
  }

  public async previousTrack(): Promise<void> {
    await this.post('/playlist/previous');
  }

  public async setShuffle(enabled: boolean): Promise<void> {
    await this.post('/playlist/shuffle', {enabled});
  }

  public async setRepeat(enabled: boolean): Promise<void> {
    await this.post('/playlist/repeat', {enabled});
  }

  // ============================================================================
  // HTTP API Methods - Media Info
  // ============================================================================

  public async getMediaInfo(filePath: string): Promise<MediaInfo> {
    return this.get(`/media/info?path=${encodeURIComponent(filePath)}`);
  }

  public getStreamUrl(filePath: string, seekTime?: number): string {
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

  public ngOnDestroy(): void {
    this.eventSource?.close();
    this.fullscreenCleanup?.();
  }
}

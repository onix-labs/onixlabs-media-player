import {Injectable, computed, inject, effect} from '@angular/core';
import {ElectronService, MediaInfo, PlaylistItem} from './electron.service';

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error';

@Injectable({providedIn: 'root'})
export class MediaPlayerService {
  private readonly electron: ElectronService = inject(ElectronService);

  // Expose signals from ElectronService (server is source of truth)
  public readonly playbackState: ReturnType<typeof computed<PlaybackState>> = computed((): PlaybackState => this.electron.playbackState() as PlaybackState);
  public readonly currentTime: ReturnType<typeof computed<number>> = computed((): number => this.electron.currentTime());
  public readonly duration: ReturnType<typeof computed<number>> = computed((): number => this.electron.duration());
  public readonly volume: ReturnType<typeof computed<number>> = computed((): number => this.electron.volume());
  public readonly muted: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.muted());
  public readonly serverUrl: ReturnType<typeof computed<string>> = computed((): string => this.electron.serverUrl());
  public readonly errorMessage: ReturnType<typeof computed<string | null>> = computed((): string | null => this.electron.errorMessage());

  // Playlist state from server
  public readonly playlist: ReturnType<typeof computed<ReturnType<typeof this.electron.playlist>>> = computed((): ReturnType<typeof this.electron.playlist> => this.electron.playlist());
  public readonly playlistItems: ReturnType<typeof computed<PlaylistItem[]>> = computed((): PlaylistItem[] => this.electron.playlist().items);
  public readonly playlistCount: ReturnType<typeof computed<number>> = computed((): number => this.electron.playlist().items.length);
  public readonly isShuffleEnabled: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.playlist().shuffleEnabled);
  public readonly isRepeatEnabled: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.playlist().repeatEnabled);

  // Current track from server
  public readonly currentTrack: ReturnType<typeof computed<PlaylistItem | null>> = computed((): PlaylistItem | null => {
    const p: ReturnType<typeof this.electron.playlist> = this.electron.playlist();
    if (p.currentIndex >= 0 && p.currentIndex < p.items.length) {
      return p.items[p.currentIndex];
    }
    return null;
  });

  public readonly currentMedia: ReturnType<typeof computed<MediaInfo | null>> = computed((): MediaInfo | null => this.electron.currentMedia());
  public readonly currentMediaType: ReturnType<typeof computed<'audio' | 'video' | null>> = computed((): 'audio' | 'video' | null => this.electron.currentMedia()?.type ?? null);

  // Derived state
  public readonly isPlaying: ReturnType<typeof computed<boolean>> = computed((): boolean => this.playbackState() === 'playing');
  public readonly isPaused: ReturnType<typeof computed<boolean>> = computed((): boolean => this.playbackState() === 'paused');
  public readonly isLoading: ReturnType<typeof computed<boolean>> = computed((): boolean => this.playbackState() === 'loading');
  public readonly isEmpty: ReturnType<typeof computed<boolean>> = computed((): boolean => this.playlistCount() === 0);

  public readonly progress: ReturnType<typeof computed<number>> = computed((): number => {
    const dur: number = this.duration();
    return dur > 0 ? (this.currentTime() / dur) * 100 : 0;
  });

  // Aliases for compatibility
  public readonly state: typeof this.playbackState = this.playbackState;
  public readonly time: typeof this.currentTime = this.currentTime;
  public readonly totalDuration: typeof this.duration = this.duration;
  public readonly currentVolume: typeof this.volume = this.volume;
  public readonly isMuted: typeof this.muted = this.muted;
  public readonly error: typeof this.errorMessage = this.errorMessage;

  // ============================================================================
  // File Operations
  // ============================================================================

  public async eject(): Promise<void> {
    const files: string[] = await this.electron.openFileDialog(true);
    if (files.length === 0) return;

    const wasEmpty: boolean = this.isEmpty();

    // Server will probe files and add to playlist
    await this.electron.addToPlaylist(files);

    // If playlist was empty and we added files, auto-play first
    if (wasEmpty && files.length > 0) {
      await this.electron.play();
    }
  }

  public async addFiles(files: string[]): Promise<void> {
    if (files.length === 0) return;
    await this.electron.addToPlaylist(files);
  }

  public getPathForFile(file: File): string {
    return this.electron.getPathForFile(file);
  }

  // ============================================================================
  // Playback Control
  // ============================================================================

  public async play(): Promise<void> {
    await this.electron.play();
  }

  public async pause(): Promise<void> {
    await this.electron.pause();
  }

  public async togglePlayPause(): Promise<void> {
    if (this.isPlaying()) {
      await this.pause();
    } else {
      await this.play();
    }
  }

  public async stop(): Promise<void> {
    await this.electron.stop();
  }

  public async seek(timeSeconds: number): Promise<void> {
    const clampedTime: number = Math.max(0, Math.min(timeSeconds, this.duration()));
    await this.electron.seek(clampedTime);
  }

  public async seekToProgress(percent: number): Promise<void> {
    const time: number = (percent / 100) * this.duration();
    await this.seek(time);
  }

  // ============================================================================
  // Volume Control (client-side for instant response)
  // ============================================================================

  public async setVolume(value: number): Promise<void> {
    const normalized: number = Math.max(0, Math.min(1, value));
    // Volume is handled client-side in AudioOutlet/VideoOutlet
    // but we also tell the server for persistence
    await this.electron.setVolume(normalized);
  }

  public async toggleMute(): Promise<void> {
    await this.electron.setVolume(this.volume(), !this.muted());
  }

  // ============================================================================
  // Track Navigation
  // ============================================================================

  public async next(): Promise<void> {
    await this.electron.nextTrack();
  }

  public async previous(): Promise<void> {
    // If more than 3 seconds into track, restart current track
    if (this.currentTime() > 3) {
      await this.seek(0);
      return;
    }
    await this.electron.previousTrack();
  }

  public async selectTrack(id: string): Promise<void> {
    await this.electron.selectTrack(id);
  }

  public async selectTrackByIndex(index: number): Promise<void> {
    const items: PlaylistItem[] = this.playlistItems();
    if (index >= 0 && index < items.length) {
      await this.electron.selectTrack(items[index].id);
    }
  }

  // ============================================================================
  // Playlist Management
  // ============================================================================

  public async removeTrack(id: string): Promise<void> {
    await this.electron.removeFromPlaylist(id);
  }

  public async clearPlaylist(): Promise<void> {
    await this.electron.clearPlaylist();
  }

  public async toggleShuffle(): Promise<void> {
    await this.electron.setShuffle(!this.isShuffleEnabled());
  }

  public async toggleRepeat(): Promise<void> {
    await this.electron.setRepeat(!this.isRepeatEnabled());
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  public formatTime(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const mins: number = Math.floor(seconds / 60);
    const secs: number = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
}

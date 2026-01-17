import {Injectable, computed, inject, effect} from '@angular/core';
import {ElectronService, MediaInfo, PlaylistItem} from './electron.service';

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error';

@Injectable({providedIn: 'root'})
export class MediaPlayerService {
  private readonly electron: ElectronService = inject(ElectronService);

  // Expose signals from ElectronService (server is source of truth)
  readonly playbackState: ReturnType<typeof computed<PlaybackState>> = computed(() => this.electron.playbackState() as PlaybackState);
  readonly currentTime: ReturnType<typeof computed<number>> = computed(() => this.electron.currentTime());
  readonly duration: ReturnType<typeof computed<number>> = computed(() => this.electron.duration());
  readonly volume: ReturnType<typeof computed<number>> = computed(() => this.electron.volume());
  readonly muted: ReturnType<typeof computed<boolean>> = computed(() => this.electron.muted());
  readonly serverUrl: ReturnType<typeof computed<string>> = computed(() => this.electron.serverUrl());
  readonly errorMessage: ReturnType<typeof computed<string | null>> = computed(() => this.electron.errorMessage());

  // Playlist state from server
  readonly playlist: ReturnType<typeof computed<ReturnType<typeof this.electron.playlist>>> = computed(() => this.electron.playlist());
  readonly playlistItems: ReturnType<typeof computed<PlaylistItem[]>> = computed(() => this.electron.playlist().items);
  readonly playlistCount: ReturnType<typeof computed<number>> = computed(() => this.electron.playlist().items.length);
  readonly isShuffleEnabled: ReturnType<typeof computed<boolean>> = computed(() => this.electron.playlist().shuffleEnabled);
  readonly isRepeatEnabled: ReturnType<typeof computed<boolean>> = computed(() => this.electron.playlist().repeatEnabled);

  // Current track from server
  readonly currentTrack: ReturnType<typeof computed<PlaylistItem | null>> = computed(() => {
    const p: ReturnType<typeof this.electron.playlist> = this.electron.playlist();
    if (p.currentIndex >= 0 && p.currentIndex < p.items.length) {
      return p.items[p.currentIndex];
    }
    return null;
  });

  readonly currentMedia: ReturnType<typeof computed<MediaInfo | null>> = computed(() => this.electron.currentMedia());
  readonly currentMediaType: ReturnType<typeof computed<'audio' | 'video' | null>> = computed(() => this.electron.currentMedia()?.type ?? null);

  // Derived state
  readonly isPlaying: ReturnType<typeof computed<boolean>> = computed(() => this.playbackState() === 'playing');
  readonly isPaused: ReturnType<typeof computed<boolean>> = computed(() => this.playbackState() === 'paused');
  readonly isLoading: ReturnType<typeof computed<boolean>> = computed(() => this.playbackState() === 'loading');
  readonly isEmpty: ReturnType<typeof computed<boolean>> = computed(() => this.playlistCount() === 0);

  readonly progress: ReturnType<typeof computed<number>> = computed(() => {
    const dur: number = this.duration();
    return dur > 0 ? (this.currentTime() / dur) * 100 : 0;
  });

  // Aliases for compatibility
  readonly state: typeof this.playbackState = this.playbackState;
  readonly time: typeof this.currentTime = this.currentTime;
  readonly totalDuration: typeof this.duration = this.duration;
  readonly currentVolume: typeof this.volume = this.volume;
  readonly isMuted: typeof this.muted = this.muted;
  readonly error: typeof this.errorMessage = this.errorMessage;

  // ============================================================================
  // File Operations
  // ============================================================================

  async eject(): Promise<void> {
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

  async addFiles(files: string[]): Promise<void> {
    if (files.length === 0) return;
    await this.electron.addToPlaylist(files);
  }

  getPathForFile(file: File): string {
    return this.electron.getPathForFile(file);
  }

  // ============================================================================
  // Playback Control
  // ============================================================================

  async play(): Promise<void> {
    await this.electron.play();
  }

  async pause(): Promise<void> {
    await this.electron.pause();
  }

  async togglePlayPause(): Promise<void> {
    if (this.isPlaying()) {
      await this.pause();
    } else {
      await this.play();
    }
  }

  async stop(): Promise<void> {
    await this.electron.stop();
  }

  async seek(timeSeconds: number): Promise<void> {
    const clampedTime: number = Math.max(0, Math.min(timeSeconds, this.duration()));
    await this.electron.seek(clampedTime);
  }

  async seekToProgress(percent: number): Promise<void> {
    const time: number = (percent / 100) * this.duration();
    await this.seek(time);
  }

  // ============================================================================
  // Volume Control (client-side for instant response)
  // ============================================================================

  async setVolume(value: number): Promise<void> {
    const normalized: number = Math.max(0, Math.min(1, value));
    // Volume is handled client-side in AudioOutlet/VideoOutlet
    // but we also tell the server for persistence
    await this.electron.setVolume(normalized);
  }

  async toggleMute(): Promise<void> {
    await this.electron.setVolume(this.volume(), !this.muted());
  }

  // ============================================================================
  // Track Navigation
  // ============================================================================

  async next(): Promise<void> {
    await this.electron.nextTrack();
  }

  async previous(): Promise<void> {
    // If more than 3 seconds into track, restart current track
    if (this.currentTime() > 3) {
      await this.seek(0);
      return;
    }
    await this.electron.previousTrack();
  }

  async selectTrack(id: string): Promise<void> {
    await this.electron.selectTrack(id);
  }

  async selectTrackByIndex(index: number): Promise<void> {
    const items: PlaylistItem[] = this.playlistItems();
    if (index >= 0 && index < items.length) {
      await this.electron.selectTrack(items[index].id);
    }
  }

  // ============================================================================
  // Playlist Management
  // ============================================================================

  async removeTrack(id: string): Promise<void> {
    await this.electron.removeFromPlaylist(id);
  }

  async clearPlaylist(): Promise<void> {
    await this.electron.clearPlaylist();
  }

  async toggleShuffle(): Promise<void> {
    await this.electron.setShuffle(!this.isShuffleEnabled());
  }

  async toggleRepeat(): Promise<void> {
    await this.electron.setRepeat(!this.isRepeatEnabled());
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  formatTime(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const mins: number = Math.floor(seconds / 60);
    const secs: number = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
}

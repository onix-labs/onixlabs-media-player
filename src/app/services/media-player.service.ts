import {Injectable, computed, signal, inject, DestroyRef} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {ElectronService, MediaInfo} from './electron.service';
import {PlaylistService, PlaylistItem} from './playlist.service';

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error';

@Injectable({providedIn: 'root'})
export class MediaPlayerService {
  private readonly electron = inject(ElectronService);
  private readonly playlist = inject(PlaylistService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly playbackState = signal<PlaybackState>('idle');
  private readonly currentTime = signal<number>(0);
  private readonly duration = signal<number>(0);
  private readonly volume = signal<number>(0.5);
  private readonly muted = signal<boolean>(false);
  private readonly mediaType = signal<'audio' | 'video' | null>(null);
  private readonly errorMessage = signal<string | null>(null);

  readonly state = computed(() => this.playbackState());
  readonly isPlaying = computed(() => this.playbackState() === 'playing');
  readonly isPaused = computed(() => this.playbackState() === 'paused');
  readonly isLoading = computed(() => this.playbackState() === 'loading');
  readonly time = computed(() => this.currentTime());
  readonly totalDuration = computed(() => this.duration());
  readonly progress = computed(() => {
    const dur = this.duration();
    return dur > 0 ? (this.currentTime() / dur) * 100 : 0;
  });
  readonly currentVolume = computed(() => this.volume());
  readonly isMuted = computed(() => this.muted());
  readonly currentMediaType = computed(() => this.mediaType());
  readonly error = computed(() => this.errorMessage());
  readonly currentTrack = computed(() => this.playlist.currentItem());
  readonly playlistItems = computed(() => this.playlist.playlist());
  readonly isShuffleEnabled = computed(() => this.playlist.isShuffleEnabled());
  readonly isRepeatEnabled = computed(() => this.playlist.isRepeatEnabled());
  readonly playlistCount = computed(() => this.playlist.count());

  constructor() {
    this.setupSubscriptions();
  }

  private setupSubscriptions(): void {
    this.electron.timeUpdate
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(time => this.currentTime.set(time));

    this.electron.durationChange
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(dur => this.duration.set(dur));

    this.electron.mediaEnded
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.onMediaEnded());

    this.electron.error
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(error => {
        this.errorMessage.set(error);
        this.playbackState.set('error');
      });

    this.electron.stateChange
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(state => {
        if (state === 'playing') this.playbackState.set('playing');
        else if (state === 'paused') this.playbackState.set('paused');
        else if (state === 'stopped') this.playbackState.set('stopped');
      });
  }

  async eject(): Promise<void> {
    const files = await this.electron.openFileDialog(true);
    if (files.length === 0) return;

    const items: Omit<PlaylistItem, 'id'>[] = [];

    for (const filePath of files) {
      try {
        const info = await this.electron.loadMedia(filePath);
        items.push({
          filePath,
          title: info.title,
          artist: info.artist,
          album: info.album,
          duration: info.duration,
          type: info.type
        });
      } catch (e) {
        console.error(`Failed to load ${filePath}:`, e);
      }
    }

    if (items.length > 0) {
      const wasEmpty = this.playlist.isEmpty();
      this.playlist.addItems(items);

      if (wasEmpty) {
        await this.playCurrentItem();
      }
    }
  }

  async play(): Promise<void> {
    const state = this.playbackState();

    if (state === 'paused') {
      await this.electron.resume();
      this.playbackState.set('playing');
    } else if (state === 'idle' || state === 'stopped') {
      if (this.playlist.currentItem()) {
        await this.playCurrentItem();
      }
    }
  }

  async pause(): Promise<void> {
    if (this.playbackState() === 'playing') {
      await this.electron.pause();
      this.playbackState.set('paused');
    }
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
    this.playbackState.set('stopped');
    this.currentTime.set(0);
  }

  async next(): Promise<void> {
    const nextItem = this.playlist.next();
    if (nextItem) {
      await this.playCurrentItem();
    } else {
      await this.stop();
    }
  }

  async previous(): Promise<void> {
    // If more than 3 seconds into track, restart current track
    if (this.currentTime() > 3) {
      await this.seek(0);
      return;
    }

    const prevItem = this.playlist.previous();
    if (prevItem) {
      await this.playCurrentItem();
    }
  }

  async seek(timeSeconds: number): Promise<void> {
    const clampedTime = Math.max(0, Math.min(timeSeconds, this.duration()));
    await this.electron.seek(clampedTime);
    this.currentTime.set(clampedTime);
  }

  async seekToProgress(percent: number): Promise<void> {
    const time = (percent / 100) * this.duration();
    await this.seek(time);
  }

  async setVolume(value: number): Promise<void> {
    const normalized = Math.max(0, Math.min(1, value));
    this.volume.set(normalized);

    if (!this.muted()) {
      await this.electron.setVolume(normalized);
    }
  }

  async toggleMute(): Promise<void> {
    this.muted.update(m => !m);
    await this.electron.setVolume(this.muted() ? 0 : this.volume());
  }

  toggleShuffle(): void {
    this.playlist.toggleShuffle();
  }

  toggleRepeat(): void {
    this.playlist.toggleRepeat();
  }

  async selectTrack(id: string): Promise<void> {
    if (this.playlist.selectItem(id)) {
      await this.playCurrentItem();
    }
  }

  async selectTrackByIndex(index: number): Promise<void> {
    if (this.playlist.selectIndex(index)) {
      await this.playCurrentItem();
    }
  }

  removeTrack(id: string): void {
    this.playlist.removeItem(id);
  }

  clearPlaylist(): void {
    this.stop();
    this.playlist.clear();
    this.mediaType.set(null);
  }

  private async playCurrentItem(): Promise<void> {
    const item = this.playlist.currentItem();
    if (!item) return;

    this.playbackState.set('loading');
    this.errorMessage.set(null);

    try {
      const info = await this.electron.loadMedia(item.filePath);
      this.duration.set(info.duration);
      this.mediaType.set(info.type);

      await this.electron.play();
      this.playbackState.set('playing');
    } catch (e) {
      this.errorMessage.set(e instanceof Error ? e.message : 'Playback failed');
      this.playbackState.set('error');
    }
  }

  private async onMediaEnded(): Promise<void> {
    if (this.playlist.isRepeatEnabled() && this.playlist.count() === 1) {
      // Single track repeat
      await this.seek(0);
      await this.play();
      return;
    }

    const nextItem = this.playlist.next();
    if (nextItem) {
      await this.playCurrentItem();
    } else {
      this.playbackState.set('idle');
      this.currentTime.set(0);
    }
  }

  formatTime(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
}

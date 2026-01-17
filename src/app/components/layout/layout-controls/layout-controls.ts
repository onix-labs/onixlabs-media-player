import {Component, inject, computed} from '@angular/core';
import {MediaPlayerService} from '../../../services/media-player.service';

@Component({
  selector: 'app-layout-controls',
  standalone: true,
  imports: [],
  templateUrl: './layout-controls.html',
  styleUrl: './layout-controls.scss',
})
export class LayoutControls {
  private readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);

  readonly isPlaying: ReturnType<typeof computed<boolean>> = computed(() => this.mediaPlayer.isPlaying());
  readonly progress: ReturnType<typeof computed<number>> = computed(() => this.mediaPlayer.progress());
  readonly volume: ReturnType<typeof computed<number>> = computed(() => this.mediaPlayer.currentVolume() * 100);
  readonly isMuted: ReturnType<typeof computed<boolean>> = computed(() => this.mediaPlayer.isMuted());
  readonly isShuffleEnabled: ReturnType<typeof computed<boolean>> = computed(() => this.mediaPlayer.isShuffleEnabled());
  readonly isRepeatEnabled: ReturnType<typeof computed<boolean>> = computed(() => this.mediaPlayer.isRepeatEnabled());
  readonly currentTime: ReturnType<typeof computed<string>> = computed(() => this.mediaPlayer.formatTime(this.mediaPlayer.time()));
  readonly totalDuration: ReturnType<typeof computed<string>> = computed(() => this.mediaPlayer.formatTime(this.mediaPlayer.totalDuration()));
  readonly hasTrack: ReturnType<typeof computed<boolean>> = computed(() => !!this.mediaPlayer.currentTrack());
  readonly canSkip: ReturnType<typeof computed<boolean>> = computed(() => this.mediaPlayer.playlistCount() > 1);

  async onEject(): Promise<void> {
    await this.mediaPlayer.eject();
  }

  async onShuffle(): Promise<void> {
    await this.mediaPlayer.toggleShuffle();
  }

  async onRepeat(): Promise<void> {
    await this.mediaPlayer.toggleRepeat();
  }

  async onBackward(): Promise<void> {
    await this.mediaPlayer.previous();
  }

  async onPlayPause(): Promise<void> {
    await this.mediaPlayer.togglePlayPause();
  }

  async onForward(): Promise<void> {
    await this.mediaPlayer.next();
  }

  async onVolumeChange(event: Event): Promise<void> {
    const input: HTMLInputElement = event.target as HTMLInputElement;
    await this.mediaPlayer.setVolume(parseFloat(input.value) / 100);
  }

  async onMuteToggle(): Promise<void> {
    await this.mediaPlayer.toggleMute();
  }

  async onSeek(event: Event): Promise<void> {
    const input: HTMLInputElement = event.target as HTMLInputElement;
    await this.mediaPlayer.seekToProgress(parseFloat(input.value));
  }

  async onProgressClick(event: MouseEvent): Promise<void> {
    const target: HTMLElement = event.currentTarget as HTMLElement;
    const rect: DOMRect = target.getBoundingClientRect();
    const percent: number = ((event.clientX - rect.left) / rect.width) * 100;
    await this.mediaPlayer.seekToProgress(percent);
  }
}

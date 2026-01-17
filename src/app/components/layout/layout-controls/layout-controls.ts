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

  public readonly isPlaying: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.isPlaying());
  public readonly progress: ReturnType<typeof computed<number>> = computed((): number => this.mediaPlayer.progress());
  public readonly volume: ReturnType<typeof computed<number>> = computed((): number => this.mediaPlayer.currentVolume() * 100);
  public readonly isMuted: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.isMuted());
  public readonly isShuffleEnabled: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.isShuffleEnabled());
  public readonly isRepeatEnabled: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.isRepeatEnabled());
  public readonly currentTime: ReturnType<typeof computed<string>> = computed((): string => this.mediaPlayer.formatTime(this.mediaPlayer.time()));
  public readonly totalDuration: ReturnType<typeof computed<string>> = computed((): string => this.mediaPlayer.formatTime(this.mediaPlayer.totalDuration()));
  public readonly hasTrack: ReturnType<typeof computed<boolean>> = computed((): boolean => !!this.mediaPlayer.currentTrack());
  public readonly canSkip: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.playlistCount() > 1);

  public async onEject(): Promise<void> {
    await this.mediaPlayer.eject();
  }

  public async onShuffle(): Promise<void> {
    await this.mediaPlayer.toggleShuffle();
  }

  public async onRepeat(): Promise<void> {
    await this.mediaPlayer.toggleRepeat();
  }

  public async onBackward(): Promise<void> {
    await this.mediaPlayer.previous();
  }

  public async onPlayPause(): Promise<void> {
    await this.mediaPlayer.togglePlayPause();
  }

  public async onForward(): Promise<void> {
    await this.mediaPlayer.next();
  }

  public async onVolumeChange(event: Event): Promise<void> {
    const input: HTMLInputElement = event.target as HTMLInputElement;
    await this.mediaPlayer.setVolume(parseFloat(input.value) / 100);
  }

  public async onMuteToggle(): Promise<void> {
    await this.mediaPlayer.toggleMute();
  }

  public async onSeek(event: Event): Promise<void> {
    const input: HTMLInputElement = event.target as HTMLInputElement;
    await this.mediaPlayer.seekToProgress(parseFloat(input.value));
  }

  public async onProgressClick(event: MouseEvent): Promise<void> {
    const target: HTMLElement = event.currentTarget as HTMLElement;
    const rect: DOMRect = target.getBoundingClientRect();
    const percent: number = ((event.clientX - rect.left) / rect.width) * 100;
    await this.mediaPlayer.seekToProgress(percent);
  }
}

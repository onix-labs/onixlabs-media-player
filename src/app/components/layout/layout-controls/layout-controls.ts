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
  private readonly mediaPlayer = inject(MediaPlayerService);

  readonly isPlaying = computed(() => this.mediaPlayer.isPlaying());
  readonly progress = computed(() => this.mediaPlayer.progress());
  readonly volume = computed(() => this.mediaPlayer.currentVolume() * 100);
  readonly isMuted = computed(() => this.mediaPlayer.isMuted());
  readonly isShuffleEnabled = computed(() => this.mediaPlayer.isShuffleEnabled());
  readonly isRepeatEnabled = computed(() => this.mediaPlayer.isRepeatEnabled());
  readonly currentTime = computed(() => this.mediaPlayer.formatTime(this.mediaPlayer.time()));
  readonly totalDuration = computed(() => this.mediaPlayer.formatTime(this.mediaPlayer.totalDuration()));
  readonly hasTrack = computed(() => !!this.mediaPlayer.currentTrack());

  async onEject(): Promise<void> {
    await this.mediaPlayer.eject();
  }

  onShuffle(): void {
    this.mediaPlayer.toggleShuffle();
  }

  onRepeat(): void {
    this.mediaPlayer.toggleRepeat();
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
    const input = event.target as HTMLInputElement;
    await this.mediaPlayer.setVolume(parseFloat(input.value) / 100);
  }

  async onMuteToggle(): Promise<void> {
    await this.mediaPlayer.toggleMute();
  }

  async onSeek(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    await this.mediaPlayer.seekToProgress(parseFloat(input.value));
  }

  async onProgressClick(event: MouseEvent): Promise<void> {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const percent = ((event.clientX - rect.left) / rect.width) * 100;
    await this.mediaPlayer.seekToProgress(percent);
  }
}

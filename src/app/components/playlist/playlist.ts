import {Component, inject, signal, computed} from '@angular/core';
import {MediaPlayerService} from '../../services/media-player.service';
import {PlaylistItem} from '../../services/playlist.service';

@Component({
  selector: 'app-playlist',
  standalone: true,
  imports: [],
  templateUrl: './playlist.html',
  styleUrl: './playlist.scss'
})
export class Playlist {
  private readonly mediaPlayer = inject(MediaPlayerService);

  readonly isVisible = signal<boolean>(true);
  readonly items = computed(() => this.mediaPlayer.playlistItems());
  readonly currentTrack = computed(() => this.mediaPlayer.currentTrack());
  readonly count = computed(() => this.mediaPlayer.playlistCount());

  toggle(): void {
    this.isVisible.update(v => !v);
  }

  show(): void {
    this.isVisible.set(true);
  }

  hide(): void {
    this.isVisible.set(false);
  }

  async selectItem(item: PlaylistItem): Promise<void> {
    await this.mediaPlayer.selectTrack(item.id);
  }

  removeItem(event: Event, item: PlaylistItem): void {
    event.stopPropagation();
    this.mediaPlayer.removeTrack(item.id);
  }

  formatDuration(seconds: number): string {
    return this.mediaPlayer.formatTime(seconds);
  }

  isCurrentItem(item: PlaylistItem): boolean {
    return this.currentTrack()?.id === item.id;
  }

  trackByFn(index: number, item: PlaylistItem): string {
    return item.id;
  }
}

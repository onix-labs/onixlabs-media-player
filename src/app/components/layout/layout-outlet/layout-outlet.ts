import {Component, computed, inject, ViewChild} from '@angular/core';
import {AudioOutlet} from '../../audio/audio-outlet/audio-outlet';
import {VideoOutlet} from '../../video/video-outlet/video-outlet';
import {Playlist} from '../../playlist/playlist';
import {MediaPlayerService} from '../../../services/media-player.service';
import type {PlaylistItem} from '../../../types/electron';

@Component({
  selector: 'app-layout-outlet',
  standalone: true,
  imports: [AudioOutlet, VideoOutlet, Playlist],
  templateUrl: './layout-outlet.html',
  styleUrl: './layout-outlet.scss',
})
export class LayoutOutlet {
  @ViewChild(Playlist) playlistComponent?: Playlist;

  private readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);

  readonly mediaType: ReturnType<typeof computed<'audio' | 'video' | null>> = computed(() => this.mediaPlayer.currentMediaType());
  readonly currentTrack: ReturnType<typeof computed<PlaylistItem | null>> = computed(() => this.mediaPlayer.currentTrack());
  readonly isAudio: ReturnType<typeof computed<boolean>> = computed(() => this.mediaType() === 'audio');
  readonly isVideo: ReturnType<typeof computed<boolean>> = computed(() => this.mediaType() === 'video');
  readonly isLoading: ReturnType<typeof computed<boolean>> = computed(() => this.mediaPlayer.isLoading());
  readonly trackTitle: ReturnType<typeof computed<string>> = computed(() => {
    const track: PlaylistItem | null = this.currentTrack();
    if (!track) return '';
    return track.artist ? `${track.artist} - ${track.title}` : track.title;
  });

  togglePlaylist(): void {
    this.playlistComponent?.toggle();
  }
}

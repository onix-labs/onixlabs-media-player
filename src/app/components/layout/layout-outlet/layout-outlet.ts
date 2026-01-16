import {Component, inject, computed, ViewChild} from '@angular/core';
import {AudioOutlet} from '../../audio/audio-outlet/audio-outlet';
import {VideoOutlet} from '../../video/video-outlet/video-outlet';
import {Playlist} from '../../playlist/playlist';
import {MediaPlayerService} from '../../../services/media-player.service';
import {NgOptimizedImage} from '@angular/common';

@Component({
  selector: 'app-layout-outlet',
  standalone: true,
  imports: [AudioOutlet, VideoOutlet, Playlist, NgOptimizedImage],
  templateUrl: './layout-outlet.html',
  styleUrl: './layout-outlet.scss',
})
export class LayoutOutlet {
  @ViewChild(Playlist) playlistComponent?: Playlist;

  private readonly mediaPlayer = inject(MediaPlayerService);

  readonly mediaType = computed(() => this.mediaPlayer.currentMediaType());
  readonly currentTrack = computed(() => this.mediaPlayer.currentTrack());
  readonly isAudio = computed(() => this.mediaType() === 'audio');
  readonly isVideo = computed(() => this.mediaType() === 'video');
  readonly isLoading = computed(() => this.mediaPlayer.isLoading());
  readonly trackTitle = computed(() => {
    const track = this.currentTrack();
    if (!track) return '';
    return track.artist ? `${track.artist} - ${track.title}` : track.title;
  });

  togglePlaylist(): void {
    this.playlistComponent?.toggle();
  }
}

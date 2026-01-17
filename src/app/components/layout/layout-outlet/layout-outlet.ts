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
  @ViewChild(Playlist) public playlistComponent?: Playlist;

  private readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);

  public readonly mediaType: ReturnType<typeof computed<'audio' | 'video' | null>> = computed((): 'audio' | 'video' | null => this.mediaPlayer.currentMediaType());
  public readonly currentTrack: ReturnType<typeof computed<PlaylistItem | null>> = computed((): PlaylistItem | null => this.mediaPlayer.currentTrack());
  public readonly isAudio: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaType() === 'audio');
  public readonly isVideo: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaType() === 'video');
  public readonly isLoading: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.isLoading());
  public readonly trackTitle: ReturnType<typeof computed<string>> = computed((): string => {
    const track: PlaylistItem | null = this.currentTrack();
    if (!track) return '';
    return track.artist ? `${track.artist} - ${track.title}` : track.title;
  });

  public togglePlaylist(): void {
    this.playlistComponent?.toggle();
  }
}

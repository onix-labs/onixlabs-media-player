/**
 * @fileoverview The media server's HTTP API, one method per endpoint.
 *
 * Commands only: each method says which endpoint it calls and with what, and
 * holds no playback or playlist state of its own. The server is the single
 * source of truth and reports what a command changed over Server-Sent Events,
 * which {@link ElectronService} turns into signals.
 *
 * @module app/services/player-api.service
 */

import {Injectable, inject} from '@angular/core';
import type {MediaInfo, PlaylistItem, PlaylistState, UrlMediaInfo, UrlMediaFormat} from '../types/electron';
import {MediaServerClient} from './media-server-client.service';

/**
 * Playback, playlist and URL-media commands against the media server.
 */
@Injectable({providedIn: 'root'})
export class PlayerApi {
  /** Transport that knows the server's address and attaches the session token. */
  private readonly server: MediaServerClient = inject(MediaServerClient);

  /** Timestamp (ms epoch) of the last user-initiated seek request */
  private lastSeekRequestAt: number = 0;

  /**
   * Gets the timestamp (ms epoch) of the last user-initiated seek request.
   * Outlets use this to suppress clock syncs right after a seek, so a stale
   * element position never overrides the seek target.
   */
  public get lastSeekAt(): number {
    return this.lastSeekRequestAt;
  }

  // ============================================================================
  // Playback Control
  // ============================================================================

  /**
   * Starts or resumes playback.
   * If a track is selected, plays from current position.
   */
  public async play(): Promise<void> {
    await this.server.post('/player/play');
  }

  /**
   * Pauses playback at the current position.
   */
  public async pause(): Promise<void> {
    await this.server.post('/player/pause');
  }

  /**
   * Stops playback and resets position to the beginning.
   */
  public async stop(): Promise<void> {
    await this.server.post('/player/stop');
  }

  /**
   * Signals that audio playback has actually started.
   * Called by the audio outlet when the audio element fires the 'playing' event.
   * This starts time tracking on the server.
   */
  public async signalPlaybackStarted(): Promise<void> {
    await this.server.post('/player/started');
  }

  /**
   * Seeks to a specific position in the current track.
   *
   * @param timeSeconds - Target position in seconds
   */
  public async seek(timeSeconds: number): Promise<void> {
    this.lastSeekRequestAt = Date.now();
    await this.server.post('/player/seek', {time: timeSeconds});
  }

  /**
   * Reports the media element's actual playback position so the server can
   * re-anchor its wall-clock time tracking. Fire-and-forget; errors are
   * logged but never disrupt playback.
   *
   * @param timeSeconds - The element's actual position in seconds
   */
  public syncPlaybackTime(timeSeconds: number): void {
    void this.server.post('/player/sync', {time: timeSeconds}).catch((err: unknown): void => {
      console.warn('Failed to sync playback time:', err);
    });
  }

  /**
   * Sets the volume level and/or mute state.
   *
   * @param volume - Volume level from 0.0 to 1.0
   * @param muted - Optional mute state
   */
  public async setVolume(volume: number, muted?: boolean): Promise<void> {
    const body: {volume?: number; muted?: boolean} = {};
    if (typeof volume === 'number') body.volume = volume;
    if (typeof muted === 'boolean') body.muted = muted;
    await this.server.post('/player/volume', body);
  }

  /**
   * Gets the current player state from the server.
   * Primarily used for debugging; normal state comes via SSE.
   *
   * @returns Promise resolving to the current player state
   */
  public async getPlayerState(): Promise<unknown> {
    return this.server.get('/player/state');
  }

  // ============================================================================
  // Playlist
  // ============================================================================

  /**
   * Gets the current playlist state from the server.
   * Primarily used for initial sync; updates come via SSE.
   *
   * @returns Promise resolving to the playlist state
   */
  public async getPlaylist(): Promise<PlaylistState> {
    return this.server.get('/playlist');
  }

  /**
   * Adds media files to the playlist.
   *
   * The server probes each file for metadata (duration, type, title, etc.)
   * and adds valid media files to the playlist.
   *
   * @param paths - Array of absolute file paths to add
   * @returns Promise resolving to object with array of added items
   */
  public async addToPlaylist(paths: string[]): Promise<{added: PlaylistItem[]}> {
    return this.server.post('/playlist/add', {paths});
  }

  /**
   * Removes a track from the playlist by its ID.
   *
   * @param id - The unique ID of the track to remove
   */
  public async removeFromPlaylist(id: string): Promise<void> {
    await this.server.delete(`/playlist/remove/${id}`);
  }

  /**
   * Clears all tracks from the playlist.
   * Also stops playback if anything is playing.
   */
  public async clearPlaylist(): Promise<void> {
    await this.server.delete('/playlist/clear');
  }

  /**
   * Selects and plays a specific track by its ID.
   *
   * @param id - The unique ID of the track to select
   */
  public async selectTrack(id: string): Promise<void> {
    await this.server.post(`/playlist/select/${id}`);
  }

  /**
   * Advances to the next track in the playlist.
   * Respects shuffle mode if enabled.
   */
  public async nextTrack(): Promise<void> {
    await this.server.post('/playlist/next');
  }

  /**
   * Returns to the previous track in the playlist.
   * Respects shuffle mode if enabled.
   */
  public async previousTrack(): Promise<void> {
    await this.server.post('/playlist/previous');
  }

  /**
   * Enables or disables shuffle mode.
   *
   * When shuffle is enabled, next/previous use a randomized order
   * (Fisher-Yates shuffle) instead of the display order.
   *
   * @param enabled - Whether shuffle should be enabled
   */
  public async setShuffle(enabled: boolean): Promise<void> {
    await this.server.post('/playlist/shuffle', {enabled});
  }

  /**
   * Enables or disables repeat mode.
   *
   * When repeat is enabled, the playlist loops; otherwise playback
   * stops after the last track.
   *
   * @param enabled - Whether repeat should be enabled
   */
  public async setRepeat(enabled: boolean): Promise<void> {
    await this.server.post('/playlist/repeat', {enabled});
  }

  /**
   * Saves the current playlist to a .opp file at the given path.
   *
   * @param filePath - Absolute path to save the playlist
   */
  public async savePlaylistToFile(filePath: string): Promise<void> {
    await this.server.post('/playlist/save', {filePath});
  }

  /**
   * Loads a playlist from a .opp file, replacing the current playlist.
   *
   * @param filePath - Absolute path to the .opp file
   * @returns The number of items loaded
   */
  public async loadPlaylistFromFile(filePath: string): Promise<{count: number; filePath: string}> {
    return this.server.post('/playlist/load', {filePath});
  }

  /**
   * Gets the source .opp file path of the current playlist (if loaded from file).
   *
   * @returns The file path or null
   */
  public async getPlaylistSourcePath(): Promise<string | null> {
    const result: {filePath: string | null} = await this.server.get('/playlist/source');
    return result.filePath;
  }

  // ============================================================================
  // Media Info
  // ============================================================================

  /**
   * Gets metadata for a media file without adding it to the playlist.
   *
   * @param filePath - Absolute path to the media file
   * @returns Promise resolving to the media metadata
   */
  public async getMediaInfo(filePath: string): Promise<MediaInfo> {
    return this.server.get(`/media/info?path=${encodeURIComponent(filePath)}`);
  }

  /**
   * Constructs a streaming URL for a media file.
   *
   * The URL points to the server's /media/stream endpoint which handles
   * format transcoding (for non-native formats) and range requests.
   *
   * @param filePath - Absolute path to the media file
   * @param seekTime - Optional start time in seconds (for transcoded seek)
   * @returns The complete streaming URL
   *
   * @example
   * const url = playerApi.getStreamUrl('/path/to/video.mkv', 30);
   * videoElement.src = url;  // Starts 30 seconds in
   */
  public getStreamUrl(filePath: string, seekTime?: number): string {
    let url: string = `${this.server.serverUrl()}/media/stream?path=${encodeURIComponent(filePath)}`;
    if (seekTime !== undefined && seekTime > 0) {
      url += `&t=${seekTime}`;
    }
    return this.server.appendAuth(url);
  }

  // ============================================================================
  // Internet URL Media (yt-dlp)
  // ============================================================================

  /**
   * Resolves metadata and available quality formats for a remote URL.
   *
   * @param url - The page URL to inspect (YouTube, Vimeo, etc.)
   * @returns Title, thumbnail, duration, uploader, and quality options
   * @throws Error with the yt-dlp failure message if the URL is unsupported
   */
  public async getUrlInfo(url: string): Promise<UrlMediaInfo> {
    return this.server.postExpectingMessage<UrlMediaInfo>('/media/url/info', {url});
  }

  /**
   * Starts a background download of a URL.
   *
   * @param url - The page URL to download
   * @param format - 'video' (MP4) or 'audio' (MP3)
   * @param formatId - Optional yt-dlp format id for a chosen resolution
   * @param title - Optional title used to name the downloaded file
   * @param outputPath - Destination the finished file is moved to
   * @returns The created job id
   */
  public async downloadUrl(url: string, format: UrlMediaFormat, formatId: string | null, title: string, outputPath: string): Promise<{jobId: string}> {
    return this.server.postExpectingMessage<{jobId: string}>('/media/url/download', {url, format, formatId, title, outputPath});
  }

  /**
   * Resolves a page URL to a direct stream URL the server can play.
   *
   * @param url - The page URL to stream
   * @param format - 'video' or 'audio'
   * @param maxHeight - Optional cap on video height (e.g., 720)
   * @returns The resolved stream URL
   */
  public async resolveStreamUrl(url: string, format: UrlMediaFormat, maxHeight: number | null): Promise<{url: string}> {
    return this.server.postExpectingMessage<{url: string}>('/media/url/resolve', {url, format, maxHeight});
  }

  /**
   * Cancels an in-flight URL download.
   *
   * @param jobId - The download job id to cancel
   */
  public async cancelDownload(jobId: string): Promise<{cancelled: boolean}> {
    return this.server.post<{cancelled: boolean}>(`/media/url/cancel/${encodeURIComponent(jobId)}`);
  }
}

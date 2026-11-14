/**
 * @fileoverview Tests for PlayerApi.
 *
 * Each method is a promise about which endpoint it calls and with what. The
 * transport is replaced by a recording fake, so these say nothing about
 * authentication or error mapping — MediaServerClient's tests cover those.
 *
 * @module app/services/player-api.service.spec
 */

import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {MediaServerClient} from './media-server-client.service';
import {PlayerApi} from './player-api.service';

// ============================================================================
// Helpers
// ============================================================================

/** One request the fake transport received. */
interface RecordedCall {
  readonly verb: 'GET' | 'POST' | 'DELETE' | 'POST-MESSAGE';
  readonly endpoint: string;
  readonly body?: unknown;
}

/** A MediaServerClient that records requests and answers with a canned value. */
class RecordingServer {
  public readonly serverUrl: ReturnType<typeof signal<string>> = signal<string>('http://127.0.0.1:4321');
  public readonly calls: RecordedCall[] = [];
  public reply: unknown = {};
  public failure: Error | null = null;

  public appendAuth(url: string): string {
    return `${url}&token=T`;
  }

  public get<T>(endpoint: string): Promise<T> {
    return this.record<T>({verb: 'GET', endpoint});
  }

  public post<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.record<T>({verb: 'POST', endpoint, body});
  }

  public delete<T>(endpoint: string): Promise<T> {
    return this.record<T>({verb: 'DELETE', endpoint});
  }

  public postExpectingMessage<T>(endpoint: string, body: unknown): Promise<T> {
    return this.record<T>({verb: 'POST-MESSAGE', endpoint, body});
  }

  private record<T>(call: RecordedCall): Promise<T> {
    this.calls.push(call);
    return this.failure ? Promise.reject(this.failure) : Promise.resolve(this.reply as T);
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('PlayerApi', (): void => {
  let server: RecordingServer;
  let api: PlayerApi;

  beforeEach((): void => {
    server = new RecordingServer();
    TestBed.configureTestingModule({providers: [{provide: MediaServerClient, useValue: server}]});
    api = TestBed.inject(PlayerApi);
  });

  afterEach((): void => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('commands without arguments', (): void => {
    it.each([
      ['play', 'POST', '/player/play'],
      ['pause', 'POST', '/player/pause'],
      ['stop', 'POST', '/player/stop'],
      ['signalPlaybackStarted', 'POST', '/player/started'],
      ['nextTrack', 'POST', '/playlist/next'],
      ['previousTrack', 'POST', '/playlist/previous'],
      ['clearPlaylist', 'DELETE', '/playlist/clear'],
    ] as const)('%s issues %s %s', async (method: 'play' | 'pause' | 'stop' | 'signalPlaybackStarted' | 'nextTrack' | 'previousTrack' | 'clearPlaylist', verb: 'POST' | 'DELETE', endpoint: string): Promise<void> => {
      await api[method]();

      expect(server.calls).toEqual([{verb, endpoint}]);
    });

    it('lets a refused command reject', async (): Promise<void> => {
      server.failure = new Error('HTTP 500: Internal Server Error');

      await expect(api.play()).rejects.toThrow('HTTP 500: Internal Server Error');
    });
  });

  describe('seek', (): void => {
    it('posts the target position', async (): Promise<void> => {
      await api.seek(42.5);

      expect(server.calls).toEqual([{verb: 'POST', endpoint: '/player/seek', body: {time: 42.5}}]);
    });

    it('reports no seek before the first one', (): void => {
      expect(api.lastSeekAt).toBe(0);
    });

    it('records when the seek was requested, even if the server then refuses it', async (): Promise<void> => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-02T03:04:05Z'));
      server.failure = new Error('HTTP 500: Internal Server Error');

      await expect(api.seek(10)).rejects.toThrow();

      expect(api.lastSeekAt).toBe(new Date('2026-01-02T03:04:05Z').getTime());
    });
  });

  describe('syncPlaybackTime', (): void => {
    it('posts the element position', (): void => {
      api.syncPlaybackTime(7);

      expect(server.calls).toEqual([{verb: 'POST', endpoint: '/player/sync', body: {time: 7}}]);
    });

    it('logs a failure instead of surfacing it, so playback is never disturbed', async (): Promise<void> => {
      const warn: ReturnType<typeof vi.spyOn> = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
      const failure: Error = new Error('offline');
      server.failure = failure;

      api.syncPlaybackTime(7);
      await Promise.resolve();
      await Promise.resolve();

      expect(warn).toHaveBeenCalledWith('Failed to sync playback time:', failure);
    });
  });

  describe('setVolume', (): void => {
    it('sends only the volume when mute is not given', async (): Promise<void> => {
      await api.setVolume(0.4);

      expect(server.calls[0].body).toEqual({volume: 0.4});
    });

    it('sends the mute state alongside the volume', async (): Promise<void> => {
      await api.setVolume(0, true);

      expect(server.calls).toEqual([{verb: 'POST', endpoint: '/player/volume', body: {volume: 0, muted: true}}]);
    });
  });

  describe('queries', (): void => {
    it('reads the player state', async (): Promise<void> => {
      server.reply = {state: 'playing'};

      await expect(api.getPlayerState()).resolves.toEqual({state: 'playing'});
      expect(server.calls).toEqual([{verb: 'GET', endpoint: '/player/state'}]);
    });

    it('reads the playlist', async (): Promise<void> => {
      server.reply = {items: [], currentIndex: -1, shuffleEnabled: false, repeatEnabled: false};

      await expect(api.getPlaylist()).resolves.toEqual(server.reply);
      expect(server.calls).toEqual([{verb: 'GET', endpoint: '/playlist'}]);
    });

    it('unwraps the playlist source path', async (): Promise<void> => {
      server.reply = {filePath: '/lists/mix.opp'};

      await expect(api.getPlaylistSourcePath()).resolves.toBe('/lists/mix.opp');
      expect(server.calls).toEqual([{verb: 'GET', endpoint: '/playlist/source'}]);
    });

    it('reports no source path for a playlist that was never loaded from a file', async (): Promise<void> => {
      server.reply = {filePath: null};

      await expect(api.getPlaylistSourcePath()).resolves.toBeNull();
    });

    it('encodes the path when asking for media info', async (): Promise<void> => {
      await api.getMediaInfo('/music/a b&c.mp3');

      expect(server.calls).toEqual([{verb: 'GET', endpoint: '/media/info?path=%2Fmusic%2Fa%20b%26c.mp3'}]);
    });
  });

  describe('playlist changes', (): void => {
    it('adds paths and returns what the server added', async (): Promise<void> => {
      server.reply = {added: [{id: '1'}]};

      await expect(api.addToPlaylist(['/a.mp3', '/b.mp3'])).resolves.toEqual({added: [{id: '1'}]});
      expect(server.calls).toEqual([{verb: 'POST', endpoint: '/playlist/add', body: {paths: ['/a.mp3', '/b.mp3']}}]);
    });

    it('removes a track by id', async (): Promise<void> => {
      await api.removeFromPlaylist('abc');

      expect(server.calls).toEqual([{verb: 'DELETE', endpoint: '/playlist/remove/abc'}]);
    });

    it('selects a track by id', async (): Promise<void> => {
      await api.selectTrack('abc');

      expect(server.calls).toEqual([{verb: 'POST', endpoint: '/playlist/select/abc', body: undefined}]);
    });

    it.each([[true], [false]])('sets shuffle to %s', async (enabled: boolean): Promise<void> => {
      await api.setShuffle(enabled);

      expect(server.calls).toEqual([{verb: 'POST', endpoint: '/playlist/shuffle', body: {enabled}}]);
    });

    it.each([[true], [false]])('sets repeat to %s', async (enabled: boolean): Promise<void> => {
      await api.setRepeat(enabled);

      expect(server.calls).toEqual([{verb: 'POST', endpoint: '/playlist/repeat', body: {enabled}}]);
    });

    it('saves the playlist to a file', async (): Promise<void> => {
      await api.savePlaylistToFile('/lists/mix.opp');

      expect(server.calls).toEqual([{verb: 'POST', endpoint: '/playlist/save', body: {filePath: '/lists/mix.opp'}}]);
    });

    it('loads a playlist from a file and returns the count', async (): Promise<void> => {
      server.reply = {count: 3, filePath: '/lists/mix.opp'};

      await expect(api.loadPlaylistFromFile('/lists/mix.opp')).resolves.toEqual({count: 3, filePath: '/lists/mix.opp'});
      expect(server.calls).toEqual([{verb: 'POST', endpoint: '/playlist/load', body: {filePath: '/lists/mix.opp'}}]);
    });
  });

  describe('getStreamUrl', (): void => {
    it('builds an authorized stream URL with the path encoded', (): void => {
      expect(api.getStreamUrl('/music/a b.mp3')).toBe('http://127.0.0.1:4321/media/stream?path=%2Fmusic%2Fa%20b.mp3&token=T');
    });

    it('adds the start time for a seek into a transcoded stream', (): void => {
      expect(api.getStreamUrl('/v.mkv', 30)).toBe('http://127.0.0.1:4321/media/stream?path=%2Fv.mkv&t=30&token=T');
    });

    it.each([[0], [-5]])('omits a start time of %s', (seekTime: number): void => {
      expect(api.getStreamUrl('/v.mkv', seekTime)).toBe('http://127.0.0.1:4321/media/stream?path=%2Fv.mkv&token=T');
    });
  });

  describe('internet media', (): void => {
    it('asks for URL info, keeping the server\'s failure message', async (): Promise<void> => {
      server.reply = {title: 'Clip'};

      await expect(api.getUrlInfo('https://example.com/v')).resolves.toEqual({title: 'Clip'});
      expect(server.calls).toEqual([{verb: 'POST-MESSAGE', endpoint: '/media/url/info', body: {url: 'https://example.com/v'}}]);
    });

    it('starts a download with every option the server needs', async (): Promise<void> => {
      server.reply = {jobId: 'j1'};

      await expect(api.downloadUrl('https://example.com/v', 'video', '137', 'Clip', '/out/clip.mp4')).resolves.toEqual({jobId: 'j1'});
      expect(server.calls).toEqual([{
        verb: 'POST-MESSAGE',
        endpoint: '/media/url/download',
        body: {url: 'https://example.com/v', format: 'video', formatId: '137', title: 'Clip', outputPath: '/out/clip.mp4'},
      }]);
    });

    it('resolves a page URL to a stream URL', async (): Promise<void> => {
      server.reply = {url: 'https://cdn.example.com/stream'};

      await expect(api.resolveStreamUrl('https://example.com/v', 'audio', null)).resolves.toEqual({url: 'https://cdn.example.com/stream'});
      expect(server.calls).toEqual([{
        verb: 'POST-MESSAGE',
        endpoint: '/media/url/resolve',
        body: {url: 'https://example.com/v', format: 'audio', maxHeight: null},
      }]);
    });

    it('encodes the job id when cancelling a download', async (): Promise<void> => {
      server.reply = {cancelled: true};

      await expect(api.cancelDownload('job/1')).resolves.toEqual({cancelled: true});
      expect(server.calls).toEqual([{verb: 'POST', endpoint: '/media/url/cancel/job%2F1', body: undefined}]);
    });
  });
});

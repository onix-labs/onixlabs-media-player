/**
 * @fileoverview Unit tests for ElectronService.
 *
 * Tests cover:
 * - Initial signal default values
 * - Callback registration (onSettingsUpdate, onDependencyStateUpdate, onDependencyProgressUpdate)
 * - getStreamUrl (synchronous URL construction)
 * - HTTP methods via mocked global fetch (play, pause, stop, seek, setVolume, etc.)
 * - addFilesWithAutoPlay auto-play logic
 * - IPC methods (openFileDialog, getPathForFile, toggleFullscreen) with mocked window.mediaPlayer
 * - ngOnDestroy cleanup
 *
 * Since ElectronService calls this.initialize() in its constructor and initialize()
 * checks window.mediaPlayer, SSE/IPC setup is skipped when running outside Electron.
 * HTTP methods are tested by setting the serverUrl signal directly and mocking fetch.
 *
 * @module app/services/electron.service.spec
 */

import {TestBed} from '@angular/core/testing';
import {WritableSignal} from '@angular/core';
import {ElectronService} from './electron.service';
import type {PlaylistItem, PlaylistState} from './electron.service';
import type {AppSettings} from './settings.service';

// =============================================================================
// EventSource Mock (not available in Node/vitest environment)
// =============================================================================

class MockEventSource {
  public url: string;
  public readyState: number = 0;
  public onopen: ((event: Event) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  private readonly listeners: Map<string, Array<(event: MessageEvent) => void>> = new Map();

  public static readonly CONNECTING: number = 0;
  public static readonly OPEN: number = 1;
  public static readonly CLOSED: number = 2;

  public constructor(url: string) {
    this.url = url;
    this.readyState = MockEventSource.OPEN;
    // Simulate async open
    queueMicrotask((): void => {
      if (this.onopen) this.onopen(new Event('open'));
    });
  }

  public addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const existing: Array<(event: MessageEvent) => void> = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  public removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const existing: Array<(event: MessageEvent) => void> = this.listeners.get(type) ?? [];
    this.listeners.set(type, existing.filter((l: (event: MessageEvent) => void): boolean => l !== listener));
  }

  public close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  public dispatchEvent(_event: Event): boolean {
    return true;
  }
}

// Assign to globalThis so the compiled source code can find it
globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

// =============================================================================
// Mock Setup
// =============================================================================

/**
 * Mock window.mediaPlayer API that simulates the Electron preload bridge.
 * All methods are vi.fn() stubs with sensible default return values.
 */
const mockApi: {
  getServerPort: ReturnType<typeof vi.fn>;
  getPlatformInfo: ReturnType<typeof vi.fn>;
  openFileDialog: ReturnType<typeof vi.fn>;
  openSoundFontDialog: ReturnType<typeof vi.fn>;
  getPathForFile: ReturnType<typeof vi.fn>;
  enterFullscreen: ReturnType<typeof vi.fn>;
  exitFullscreen: ReturnType<typeof vi.fn>;
  isFullscreen: ReturnType<typeof vi.fn>;
  onFullscreenChange: ReturnType<typeof vi.fn>;
  onMenuEvent: ReturnType<typeof vi.fn>;
  enterMiniplayer: ReturnType<typeof vi.fn>;
  exitMiniplayer: ReturnType<typeof vi.fn>;
  getViewMode: ReturnType<typeof vi.fn>;
  onViewModeChange: ReturnType<typeof vi.fn>;
  setWindowPosition: ReturnType<typeof vi.fn>;
  getWindowPosition: ReturnType<typeof vi.fn>;
  setTrafficLightVisibility: ReturnType<typeof vi.fn>;
  saveMiniplayerBounds: ReturnType<typeof vi.fn>;
  onPrepareForClose: ReturnType<typeof vi.fn>;
  notifyFadeOutComplete: ReturnType<typeof vi.fn>;
  setConfigurationMode: ReturnType<typeof vi.fn>;
  onExitConfigurationMode: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
  getVersionInfo: ReturnType<typeof vi.fn>;
  getLogFilePath: ReturnType<typeof vi.fn>;
} = {
  getServerPort: vi.fn().mockResolvedValue(12345),
  getPlatformInfo: vi.fn().mockResolvedValue({platform: 'darwin', supportsGlass: true, systemTheme: 'dark'}),
  openFileDialog: vi.fn().mockResolvedValue([]),
  openSoundFontDialog: vi.fn().mockResolvedValue([]),
  getPathForFile: vi.fn().mockReturnValue('/mock/path'),
  enterFullscreen: vi.fn().mockResolvedValue(undefined),
  exitFullscreen: vi.fn().mockResolvedValue(undefined),
  isFullscreen: vi.fn().mockResolvedValue(false),
  onFullscreenChange: vi.fn().mockReturnValue((): void => {}),
  onMenuEvent: vi.fn().mockReturnValue((): void => {}),
  enterMiniplayer: vi.fn().mockResolvedValue(undefined),
  exitMiniplayer: vi.fn().mockResolvedValue(undefined),
  getViewMode: vi.fn().mockResolvedValue('desktop'),
  onViewModeChange: vi.fn().mockReturnValue((): void => {}),
  setWindowPosition: vi.fn().mockResolvedValue({x: 0, y: 0}),
  getWindowPosition: vi.fn().mockResolvedValue({x: 0, y: 0}),
  setTrafficLightVisibility: vi.fn().mockResolvedValue(undefined),
  saveMiniplayerBounds: vi.fn().mockResolvedValue(undefined),
  onPrepareForClose: vi.fn().mockReturnValue((): void => {}),
  notifyFadeOutComplete: vi.fn(),
  setConfigurationMode: vi.fn().mockResolvedValue(undefined),
  onExitConfigurationMode: vi.fn().mockReturnValue((): void => {}),
  openExternal: vi.fn().mockResolvedValue(undefined),
  getVersionInfo: vi.fn().mockReturnValue({electron: '1', node: '1', chrome: '1', v8: '1'}),
  getLogFilePath: vi.fn().mockResolvedValue('/tmp/test.log'),
};

/**
 * Resets all mock function call history and restores default implementations.
 */
function resetMockApi(): void {
  for (const fn of Object.values(mockApi)) {
    (fn as ReturnType<typeof vi.fn>).mockClear();
  }
}

/**
 * Creates a mock PlaylistItem with required fields populated.
 *
 * @param overrides - Partial fields to override defaults
 * @returns A complete PlaylistItem for testing
 */
function createMockPlaylistItem(overrides: Partial<PlaylistItem> = {}): PlaylistItem {
  return {
    id: overrides.id ?? 'test-id-1',
    filePath: overrides.filePath ?? '/test/audio.mp3',
    title: overrides.title ?? 'Test Track',
    duration: overrides.duration ?? 180,
    type: overrides.type ?? 'audio',
    ...overrides,
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('ElectronService', (): void => {
  let service: ElectronService;

  // ---------------------------------------------------------------------------
  // Tests WITHOUT window.mediaPlayer (non-Electron environment)
  // ---------------------------------------------------------------------------

  describe('without window.mediaPlayer', (): void => {
    beforeEach((): void => {
      // Ensure window.mediaPlayer is not defined
      delete (window as unknown as Record<string, unknown>)['mediaPlayer'];

      TestBed.configureTestingModule({});
      service = TestBed.inject(ElectronService);
    });

    // =========================================================================
    // Initial Signal Values
    // =========================================================================

    describe('initial signal values', (): void => {
      it('should have serverUrl start as empty string', (): void => {
        const value: string = service.serverUrl();
        expect(value).toBe('');
      });

      it('should have playbackState start as idle', (): void => {
        const value: string = service.playbackState();
        expect(value).toBe('idle');
      });

      it('should have currentTime start at 0', (): void => {
        const value: number = service.currentTime();
        expect(value).toBe(0);
      });

      it('should have duration start at 0', (): void => {
        const value: number = service.duration();
        expect(value).toBe(0);
      });

      it('should have volume start at 1', (): void => {
        const value: number = service.volume();
        expect(value).toBe(1);
      });

      it('should have muted start as false', (): void => {
        const value: boolean = service.muted();
        expect(value).toBe(false);
      });

      it('should have currentMedia start as null', (): void => {
        const value: unknown = service.currentMedia();
        expect(value).toBeNull();
      });

      it('should have errorMessage start as null', (): void => {
        const value: string | null = service.errorMessage();
        expect(value).toBeNull();
      });

      it('should have playlist start with empty state', (): void => {
        const value: PlaylistState = service.playlist();
        expect(value.items).toEqual([]);
        expect(value.currentIndex).toBe(-1);
        expect(value.shuffleEnabled).toBe(false);
        expect(value.repeatEnabled).toBe(false);
      });

      it('should have mediaEnded start as false', (): void => {
        const value: boolean = service.mediaEnded();
        expect(value).toBe(false);
      });

      it('should have isFullscreen start as false', (): void => {
        const value: boolean = service.isFullscreen();
        expect(value).toBe(false);
      });

      it('should have viewMode start as desktop', (): void => {
        const value: string = service.viewMode();
        expect(value).toBe('desktop');
      });

      it('should have platformInfo start with unknown platform', (): void => {
        const value: {platform: string; supportsGlass: boolean; systemTheme: 'dark' | 'light'} = service.platformInfo();
        expect(value.platform).toBe('unknown');
        expect(value.supportsGlass).toBe(false);
        expect(value.systemTheme).toBe('dark');
      });

      it('should have menuShowConfig start at 0', (): void => {
        const value: number = service.menuShowConfig();
        expect(value).toBe(0);
      });

      it('should have menuOpenFile start at 0', (): void => {
        const value: number = service.menuOpenFile();
        expect(value).toBe(0);
      });

      it('should have menuShowAbout start at 0', (): void => {
        const value: number = service.menuShowAbout();
        expect(value).toBe(0);
      });

      it('should have menuSelectVisualization start as empty string', (): void => {
        const value: string = service.menuSelectVisualization();
        expect(value).toBe('');
      });

      it('should have menuSelectAspectMode start as empty string', (): void => {
        const value: string = service.menuSelectAspectMode();
        expect(value).toBe('');
      });

      it('should have fadeOutRequested start at 0', (): void => {
        const value: number = service.fadeOutRequested();
        expect(value).toBe(0);
      });

      it('should have exitConfigurationModeRequested start at 0', (): void => {
        const value: number = service.exitConfigurationModeRequested();
        expect(value).toBe(0);
      });
    });

    // =========================================================================
    // isElectron Property
    // =========================================================================

    describe('isElectron', (): void => {
      it('should return false when window.mediaPlayer is not defined', (): void => {
        const value: boolean = service.isElectron;
        expect(value).toBe(false);
      });
    });

    // =========================================================================
    // Callback Registration
    // =========================================================================

    describe('callback registration', (): void => {
      it('should accept a settings update callback via onSettingsUpdate', (): void => {
        const callback: (settings: AppSettings) => void = vi.fn();
        service.onSettingsUpdate(callback);
        // No error thrown; callback is stored internally
        expect(callback).not.toHaveBeenCalled();
      });

      it('should accept a dependency state callback via onDependencyStateUpdate', (): void => {
        const callback: (state: unknown) => void = vi.fn();
        service.onDependencyStateUpdate(callback);
        expect(callback).not.toHaveBeenCalled();
      });

      it('should accept a dependency progress callback via onDependencyProgressUpdate', (): void => {
        const callback: (progress: unknown) => void = vi.fn();
        service.onDependencyProgressUpdate(callback);
        expect(callback).not.toHaveBeenCalled();
      });

      it('should allow overwriting a previously registered settings callback', (): void => {
        const callback1: (settings: AppSettings) => void = vi.fn();
        const callback2: (settings: AppSettings) => void = vi.fn();
        service.onSettingsUpdate(callback1);
        service.onSettingsUpdate(callback2);
        // No error; second callback replaces first
        expect(callback1).not.toHaveBeenCalled();
        expect(callback2).not.toHaveBeenCalled();
      });
    });

    // =========================================================================
    // getStreamUrl
    // =========================================================================

    describe('getStreamUrl', (): void => {
      it('should build correct URL without seek time', (): void => {
        (service.serverUrl as WritableSignal<string>).set('http://127.0.0.1:12345');

        const url: string = service.getStreamUrl('/path/to/file.mp3');
        expect(url).toBe('http://127.0.0.1:12345/media/stream?path=%2Fpath%2Fto%2Ffile.mp3');
      });

      it('should build correct URL with seek time greater than zero', (): void => {
        (service.serverUrl as WritableSignal<string>).set('http://127.0.0.1:12345');

        const url: string = service.getStreamUrl('/path/to/video.mkv', 30);
        expect(url).toBe('http://127.0.0.1:12345/media/stream?path=%2Fpath%2Fto%2Fvideo.mkv&t=30');
      });

      it('should not add seek time parameter when seek time is 0', (): void => {
        (service.serverUrl as WritableSignal<string>).set('http://127.0.0.1:12345');

        const url: string = service.getStreamUrl('/path/to/file.mp3', 0);
        expect(url).not.toContain('&t=');
      });

      it('should not add seek time parameter when seek time is undefined', (): void => {
        (service.serverUrl as WritableSignal<string>).set('http://127.0.0.1:12345');

        const url: string = service.getStreamUrl('/path/to/file.mp3', undefined);
        expect(url).not.toContain('&t=');
      });

      it('should encode special characters in file path', (): void => {
        (service.serverUrl as WritableSignal<string>).set('http://127.0.0.1:12345');

        const url: string = service.getStreamUrl('/music/My Songs/track #1.mp3');
        expect(url).toContain('path=%2Fmusic%2FMy%20Songs%2Ftrack%20%231.mp3');
      });

      it('should work with empty serverUrl', (): void => {
        const url: string = service.getStreamUrl('/file.mp3');
        expect(url).toBe('/media/stream?path=%2Ffile.mp3');
      });

      it('should include fractional seek times', (): void => {
        (service.serverUrl as WritableSignal<string>).set('http://127.0.0.1:12345');

        const url: string = service.getStreamUrl('/file.mp3', 45.5);
        expect(url).toBe('http://127.0.0.1:12345/media/stream?path=%2Ffile.mp3&t=45.5');
      });
    });

    // =========================================================================
    // HTTP Methods (with mocked fetch)
    // =========================================================================

    describe('HTTP methods', (): void => {
      let mockFetch: ReturnType<typeof vi.fn>;

      beforeEach((): void => {
        (service.serverUrl as WritableSignal<string>).set('http://127.0.0.1:12345');

        mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({}),
          status: 200,
          statusText: 'OK',
        });
        vi.stubGlobal('fetch', mockFetch);
      });

      afterEach((): void => {
        vi.unstubAllGlobals();
      });

      it('should send POST to /player/play when play() is called', async (): Promise<void> => {
        await service.play();

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/player/play',
          expect.objectContaining({method: 'POST'}),
        );
      });

      it('should send POST to /player/pause when pause() is called', async (): Promise<void> => {
        await service.pause();

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/player/pause',
          expect.objectContaining({method: 'POST'}),
        );
      });

      it('should send POST to /player/stop when stop() is called', async (): Promise<void> => {
        await service.stop();

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/player/stop',
          expect.objectContaining({method: 'POST'}),
        );
      });

      it('should send POST with time body when seek() is called', async (): Promise<void> => {
        await service.seek(42.5);

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/player/seek',
          expect.objectContaining({
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({time: 42.5}),
          }),
        );
      });

      it('should send POST with volume body when setVolume() is called', async (): Promise<void> => {
        await service.setVolume(0.75);

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/player/volume',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({volume: 0.75}),
          }),
        );
      });

      it('should send POST with volume and muted flags when setVolume() includes muted', async (): Promise<void> => {
        await service.setVolume(0.5, true);

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/player/volume',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({volume: 0.5, muted: true}),
          }),
        );
      });

      it('should send POST with paths when addToPlaylist() is called', async (): Promise<void> => {
        const paths: string[] = ['/music/song1.mp3', '/music/song2.mp3'];
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({added: []}),
          status: 200,
          statusText: 'OK',
        });

        await service.addToPlaylist(paths);

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/playlist/add',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({paths}),
          }),
        );
      });

      it('should send DELETE to /playlist/remove/:id when removeFromPlaylist() is called', async (): Promise<void> => {
        await service.removeFromPlaylist('track-abc');

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/playlist/remove/track-abc',
          expect.objectContaining({method: 'DELETE'}),
        );
      });

      it('should send DELETE to /playlist/clear when clearPlaylist() is called', async (): Promise<void> => {
        await service.clearPlaylist();

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/playlist/clear',
          expect.objectContaining({method: 'DELETE'}),
        );
      });

      it('should send POST to /playlist/select/:id when selectTrack() is called', async (): Promise<void> => {
        await service.selectTrack('track-xyz');

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/playlist/select/track-xyz',
          expect.objectContaining({method: 'POST'}),
        );
      });

      it('should send POST to /playlist/next when nextTrack() is called', async (): Promise<void> => {
        await service.nextTrack();

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/playlist/next',
          expect.objectContaining({method: 'POST'}),
        );
      });

      it('should send POST to /playlist/previous when previousTrack() is called', async (): Promise<void> => {
        await service.previousTrack();

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/playlist/previous',
          expect.objectContaining({method: 'POST'}),
        );
      });

      it('should send POST with enabled flag when setShuffle() is called', async (): Promise<void> => {
        await service.setShuffle(true);

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/playlist/shuffle',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({enabled: true}),
          }),
        );
      });

      it('should send POST with enabled false when setShuffle(false) is called', async (): Promise<void> => {
        await service.setShuffle(false);

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/playlist/shuffle',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({enabled: false}),
          }),
        );
      });

      it('should send POST with enabled flag when setRepeat() is called', async (): Promise<void> => {
        await service.setRepeat(true);

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/playlist/repeat',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({enabled: true}),
          }),
        );
      });

      it('should send POST with enabled false when setRepeat(false) is called', async (): Promise<void> => {
        await service.setRepeat(false);

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/playlist/repeat',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({enabled: false}),
          }),
        );
      });

      it('should send GET to /player/state when getPlayerState() is called', async (): Promise<void> => {
        const mockState: {state: string} = {state: 'playing'};
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue(mockState),
          status: 200,
          statusText: 'OK',
        });

        const result: unknown = await service.getPlayerState();

        expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:12345/player/state');
        expect(result).toEqual(mockState);
      });

      it('should send GET to /playlist when getPlaylist() is called', async (): Promise<void> => {
        const mockPlaylist: PlaylistState = {
          items: [],
          currentIndex: -1,
          shuffleEnabled: false,
          repeatEnabled: false,
        };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue(mockPlaylist),
          status: 200,
          statusText: 'OK',
        });

        const result: PlaylistState = await service.getPlaylist();

        expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:12345/playlist');
        expect(result).toEqual(mockPlaylist);
      });

      it('should send GET to /media/info with encoded path when getMediaInfo() is called', async (): Promise<void> => {
        const mockInfo: {duration: number; type: string; title: string; filePath: string} = {
          duration: 120,
          type: 'audio',
          title: 'Test',
          filePath: '/test/file.mp3',
        };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue(mockInfo),
          status: 200,
          statusText: 'OK',
        });

        await service.getMediaInfo('/test/file.mp3');

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/media/info?path=%2Ftest%2Ffile.mp3',
        );
      });

      it('should throw an error when fetch returns a non-ok response', async (): Promise<void> => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          json: vi.fn().mockResolvedValue({}),
          status: 500,
          statusText: 'Internal Server Error',
        });

        await expect(service.play()).rejects.toThrow('HTTP 500: Internal Server Error');
      });

      it('should throw an error for 404 responses', async (): Promise<void> => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          json: vi.fn().mockResolvedValue({}),
          status: 404,
          statusText: 'Not Found',
        });

        await expect(service.stop()).rejects.toThrow('HTTP 404: Not Found');
      });
    });

    // =========================================================================
    // addFilesWithAutoPlay
    // =========================================================================

    describe('addFilesWithAutoPlay', (): void => {
      let mockFetch: ReturnType<typeof vi.fn>;

      beforeEach((): void => {
        (service.serverUrl as WritableSignal<string>).set('http://127.0.0.1:12345');

        mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({added: []}),
          status: 200,
          statusText: 'OK',
        });
        vi.stubGlobal('fetch', mockFetch);
      });

      afterEach((): void => {
        vi.unstubAllGlobals();
      });

      it('should return empty added array when no paths are provided', async (): Promise<void> => {
        const result: {added: PlaylistItem[]} = await service.addFilesWithAutoPlay([]);

        expect(result.added).toEqual([]);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('should auto-play a single file', async (): Promise<void> => {
        const addedItem: PlaylistItem = createMockPlaylistItem({id: 'single-1'});
        // First call: addToPlaylist POST
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({added: [addedItem]}),
          status: 200,
          statusText: 'OK',
        });
        // Second call: selectTrack POST
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({}),
          status: 200,
          statusText: 'OK',
        });

        const result: {added: PlaylistItem[]} = await service.addFilesWithAutoPlay(['/music/song.mp3']);

        expect(result.added).toHaveLength(1);
        // Verify selectTrack was called with the first added item's ID
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch).toHaveBeenLastCalledWith(
          'http://127.0.0.1:12345/playlist/select/single-1',
          expect.objectContaining({method: 'POST'}),
        );
      });

      it('should auto-play first file when playlist was empty and multiple files added', async (): Promise<void> => {
        // Playlist starts empty (default)
        const item1: PlaylistItem = createMockPlaylistItem({id: 'multi-1'});
        const item2: PlaylistItem = createMockPlaylistItem({id: 'multi-2'});

        // First call: addToPlaylist POST
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({added: [item1, item2]}),
          status: 200,
          statusText: 'OK',
        });
        // Second call: selectTrack POST
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({}),
          status: 200,
          statusText: 'OK',
        });

        const result: {added: PlaylistItem[]} = await service.addFilesWithAutoPlay(['/a.mp3', '/b.mp3']);

        expect(result.added).toHaveLength(2);
        // Should auto-play first item because playlist was empty
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch).toHaveBeenLastCalledWith(
          'http://127.0.0.1:12345/playlist/select/multi-1',
          expect.objectContaining({method: 'POST'}),
        );
      });

      it('should not auto-play when playlist already has items and multiple files are added', async (): Promise<void> => {
        // Pre-populate playlist with existing items
        const existingItem: PlaylistItem = createMockPlaylistItem({id: 'existing-1'});
        (service.playlist as WritableSignal<PlaylistState>).set({
          items: [existingItem],
          currentIndex: 0,
          shuffleEnabled: false,
          repeatEnabled: false,
        });

        const newItem1: PlaylistItem = createMockPlaylistItem({id: 'new-1'});
        const newItem2: PlaylistItem = createMockPlaylistItem({id: 'new-2'});

        // Only one call: addToPlaylist POST (no selectTrack)
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({added: [newItem1, newItem2]}),
          status: 200,
          statusText: 'OK',
        });

        const result: {added: PlaylistItem[]} = await service.addFilesWithAutoPlay(['/c.mp3', '/d.mp3']);

        expect(result.added).toHaveLength(2);
        // Should NOT call selectTrack (only addToPlaylist)
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it('should auto-play single file even when playlist already has items', async (): Promise<void> => {
        // Pre-populate playlist
        const existingItem: PlaylistItem = createMockPlaylistItem({id: 'existing-1'});
        (service.playlist as WritableSignal<PlaylistState>).set({
          items: [existingItem],
          currentIndex: 0,
          shuffleEnabled: false,
          repeatEnabled: false,
        });

        const newItem: PlaylistItem = createMockPlaylistItem({id: 'single-new'});

        // First call: addToPlaylist
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({added: [newItem]}),
          status: 200,
          statusText: 'OK',
        });
        // Second call: selectTrack
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({}),
          status: 200,
          statusText: 'OK',
        });

        await service.addFilesWithAutoPlay(['/e.mp3']);

        // Single file always auto-plays
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch).toHaveBeenLastCalledWith(
          'http://127.0.0.1:12345/playlist/select/single-new',
          expect.objectContaining({method: 'POST'}),
        );
      });

      it('should return result without auto-play when addToPlaylist returns empty added', async (): Promise<void> => {
        // Server rejects all files (e.g., invalid format)
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({added: []}),
          status: 200,
          statusText: 'OK',
        });

        const result: {added: PlaylistItem[]} = await service.addFilesWithAutoPlay(['/invalid.xyz']);

        expect(result.added).toHaveLength(0);
        // Only addToPlaylist call, no selectTrack
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
    });

    // =========================================================================
    // IPC Methods (without Electron)
    // =========================================================================

    describe('IPC methods without Electron', (): void => {
      it('should return empty array from openFileDialog when not in Electron', async (): Promise<void> => {
        const result: string[] = await service.openFileDialog();
        expect(result).toEqual([]);
      });

      it('should return empty array from openFileDialog with multiSelect false', async (): Promise<void> => {
        const result: string[] = await service.openFileDialog(false);
        expect(result).toEqual([]);
      });

      it('should return empty array from openSoundFontDialog when not in Electron', async (): Promise<void> => {
        const result: string[] = await service.openSoundFontDialog();
        expect(result).toEqual([]);
      });

      it('should throw from getPathForFile when not in Electron', (): void => {
        const mockFile: File = new File(['content'], 'test.mp3');
        expect((): string => service.getPathForFile(mockFile)).toThrow('Not running in Electron');
      });

      it('should return without error from enterFullscreen when not in Electron', async (): Promise<void> => {
        await expect(service.enterFullscreen()).resolves.toBeUndefined();
      });

      it('should return without error from exitFullscreen when not in Electron', async (): Promise<void> => {
        await expect(service.exitFullscreen()).resolves.toBeUndefined();
      });

      it('should return input position from setWindowPosition when not in Electron', async (): Promise<void> => {
        const position: {x: number; y: number} = {x: 100, y: 200};
        const result: {x: number; y: number} = await service.setWindowPosition(position);
        expect(result).toEqual(position);
      });

      it('should return origin from getWindowPosition when not in Electron', async (): Promise<void> => {
        const result: {x: number; y: number} = await service.getWindowPosition();
        expect(result).toEqual({x: 0, y: 0});
      });

      it('should return without error from enterMiniplayer when not in Electron', async (): Promise<void> => {
        await expect(service.enterMiniplayer()).resolves.toBeUndefined();
      });

      it('should return without error from exitMiniplayer when not in Electron', async (): Promise<void> => {
        await expect(service.exitMiniplayer()).resolves.toBeUndefined();
      });

      it('should return without error from setTrafficLightVisibility when not in Electron', async (): Promise<void> => {
        await expect(service.setTrafficLightVisibility(true)).resolves.toBeUndefined();
      });

      it('should return without error from saveMiniplayerBounds when not in Electron', async (): Promise<void> => {
        await expect(service.saveMiniplayerBounds()).resolves.toBeUndefined();
      });

      it('should return without error from setConfigurationMode when not in Electron', async (): Promise<void> => {
        await expect(service.setConfigurationMode(true)).resolves.toBeUndefined();
      });
    });

    // =========================================================================
    // toggleFullscreen
    // =========================================================================

    describe('toggleFullscreen', (): void => {
      it('should not throw when called without Electron', async (): Promise<void> => {
        await expect(service.toggleFullscreen()).resolves.toBeUndefined();
      });
    });

    // =========================================================================
    // ngOnDestroy
    // =========================================================================

    describe('ngOnDestroy', (): void => {
      it('should not throw when called without active connections', (): void => {
        expect((): void => service.ngOnDestroy()).not.toThrow();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Tests WITH window.mediaPlayer (Electron environment)
  // ---------------------------------------------------------------------------

  describe('with window.mediaPlayer', (): void => {
    beforeEach((): void => {
      resetMockApi();
      (window as unknown as Record<string, unknown>)['mediaPlayer'] = mockApi;

      TestBed.configureTestingModule({});
      service = TestBed.inject(ElectronService);
    });

    afterEach((): void => {
      service.ngOnDestroy();
      delete (window as unknown as Record<string, unknown>)['mediaPlayer'];
    });

    // =========================================================================
    // isElectron Property
    // =========================================================================

    describe('isElectron', (): void => {
      it('should return true when window.mediaPlayer is defined', (): void => {
        const value: boolean = service.isElectron;
        expect(value).toBe(true);
      });
    });

    // =========================================================================
    // IPC Methods (with Electron)
    // =========================================================================

    describe('IPC methods with Electron', (): void => {
      it('should delegate openFileDialog to the preload API', async (): Promise<void> => {
        const expectedPaths: string[] = ['/music/song.mp3'];
        mockApi.openFileDialog.mockResolvedValueOnce(expectedPaths);

        const result: string[] = await service.openFileDialog();

        expect(mockApi.openFileDialog).toHaveBeenCalledWith(
          expect.objectContaining({
            filters: expect.arrayContaining([
              expect.objectContaining({name: 'Media Files'}),
            ]),
            multiSelections: true,
          }),
        );
        expect(result).toEqual(expectedPaths);
      });

      it('should pass multiSelect false to the preload API', async (): Promise<void> => {
        mockApi.openFileDialog.mockResolvedValueOnce(['/file.mp3']);

        await service.openFileDialog(false);

        expect(mockApi.openFileDialog).toHaveBeenCalledWith(
          expect.objectContaining({multiSelections: false}),
        );
      });

      it('should pass custom filters to the preload API', async (): Promise<void> => {
        const customFilters: {name: string; extensions: string[]}[] = [
          {name: 'Audio Only', extensions: ['mp3', 'wav']},
        ];
        mockApi.openFileDialog.mockResolvedValueOnce([]);

        await service.openFileDialog(true, customFilters);

        expect(mockApi.openFileDialog).toHaveBeenCalledWith(
          expect.objectContaining({
            filters: customFilters,
            multiSelections: true,
          }),
        );
      });

      it('should delegate openSoundFontDialog to the preload API', async (): Promise<void> => {
        const expectedPaths: string[] = ['/soundfonts/piano.sf2'];
        mockApi.openSoundFontDialog.mockResolvedValueOnce(expectedPaths);

        const result: string[] = await service.openSoundFontDialog();

        expect(mockApi.openSoundFontDialog).toHaveBeenCalled();
        expect(result).toEqual(expectedPaths);
      });

      it('should delegate getPathForFile to the preload API', (): void => {
        const mockFile: File = new File(['content'], 'song.mp3');
        mockApi.getPathForFile.mockReturnValueOnce('/absolute/path/song.mp3');

        const result: string = service.getPathForFile(mockFile);

        expect(mockApi.getPathForFile).toHaveBeenCalledWith(mockFile);
        expect(result).toBe('/absolute/path/song.mp3');
      });

      it('should delegate enterFullscreen to the preload API', async (): Promise<void> => {
        await service.enterFullscreen();
        expect(mockApi.enterFullscreen).toHaveBeenCalled();
      });

      it('should delegate exitFullscreen to the preload API', async (): Promise<void> => {
        await service.exitFullscreen();
        expect(mockApi.exitFullscreen).toHaveBeenCalled();
      });

      it('should delegate enterMiniplayer to the preload API', async (): Promise<void> => {
        await service.enterMiniplayer();
        expect(mockApi.enterMiniplayer).toHaveBeenCalled();
      });

      it('should delegate exitMiniplayer to the preload API', async (): Promise<void> => {
        await service.exitMiniplayer();
        expect(mockApi.exitMiniplayer).toHaveBeenCalled();
      });

      it('should delegate setWindowPosition to the preload API', async (): Promise<void> => {
        const position: {x: number; y: number} = {x: 200, y: 300};
        mockApi.setWindowPosition.mockResolvedValueOnce({x: 200, y: 300});

        const result: {x: number; y: number} = await service.setWindowPosition(position);

        expect(mockApi.setWindowPosition).toHaveBeenCalledWith(position);
        expect(result).toEqual({x: 200, y: 300});
      });

      it('should delegate getWindowPosition to the preload API', async (): Promise<void> => {
        mockApi.getWindowPosition.mockResolvedValueOnce({x: 150, y: 250});

        const result: {x: number; y: number} = await service.getWindowPosition();

        expect(mockApi.getWindowPosition).toHaveBeenCalled();
        expect(result).toEqual({x: 150, y: 250});
      });

      it('should delegate setTrafficLightVisibility to the preload API', async (): Promise<void> => {
        await service.setTrafficLightVisibility(false);
        expect(mockApi.setTrafficLightVisibility).toHaveBeenCalledWith(false);
      });

      it('should delegate saveMiniplayerBounds to the preload API', async (): Promise<void> => {
        await service.saveMiniplayerBounds();
        expect(mockApi.saveMiniplayerBounds).toHaveBeenCalled();
      });

      it('should delegate setConfigurationMode to the preload API', async (): Promise<void> => {
        await service.setConfigurationMode(true);
        expect(mockApi.setConfigurationMode).toHaveBeenCalledWith(true);
      });
    });

    // =========================================================================
    // toggleFullscreen with Electron
    // =========================================================================

    describe('toggleFullscreen with Electron', (): void => {
      it('should call enterFullscreen when currently not fullscreen', async (): Promise<void> => {
        (service.isFullscreen as WritableSignal<boolean>).set(false);

        await service.toggleFullscreen();

        expect(mockApi.enterFullscreen).toHaveBeenCalled();
        expect(mockApi.exitFullscreen).not.toHaveBeenCalled();
      });

      it('should call exitFullscreen when currently fullscreen', async (): Promise<void> => {
        (service.isFullscreen as WritableSignal<boolean>).set(true);

        await service.toggleFullscreen();

        expect(mockApi.exitFullscreen).toHaveBeenCalled();
        expect(mockApi.enterFullscreen).not.toHaveBeenCalled();
      });
    });

    // =========================================================================
    // ngOnDestroy with Electron
    // =========================================================================

    describe('ngOnDestroy with Electron', (): void => {
      it('should not throw when called with active Electron connections', (): void => {
        expect((): void => service.ngOnDestroy()).not.toThrow();
      });
    });
  });
});

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
import type {DownloadJob, MediaInfo, PlaylistItem, PlaylistState, UrlMediaInfo} from './electron.service';
import type {AppSettings} from './settings.service';
import {SseClient} from './sse-client.service';
import {buildFileDialogFilters} from '../constants/media.constants';

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
  getServerToken: ReturnType<typeof vi.fn>;
  getPlatformInfo: ReturnType<typeof vi.fn>;
  openFileDialog: ReturnType<typeof vi.fn>;
  openSoundFontDialog: ReturnType<typeof vi.fn>;
  getPathForFile: ReturnType<typeof vi.fn>;
  enterFullscreen: ReturnType<typeof vi.fn>;
  exitFullscreen: ReturnType<typeof vi.fn>;
  isFullscreen: ReturnType<typeof vi.fn>;
  onFullscreenChange: ReturnType<typeof vi.fn>;
  onFullscreenTransitionStart: ReturnType<typeof vi.fn>;
  onFullscreenTransitionEnd: ReturnType<typeof vi.fn>;
  onMenuEvent: ReturnType<typeof vi.fn>;
  enterMiniplayer: ReturnType<typeof vi.fn>;
  exitMiniplayer: ReturnType<typeof vi.fn>;
  getViewMode: ReturnType<typeof vi.fn>;
  onViewModeChange: ReturnType<typeof vi.fn>;
  onConfigOpenChange: ReturnType<typeof vi.fn>;
  setWindowPosition: ReturnType<typeof vi.fn>;
  getWindowPosition: ReturnType<typeof vi.fn>;
  setTrafficLightVisibility: ReturnType<typeof vi.fn>;
  saveMiniplayerBounds: ReturnType<typeof vi.fn>;
  onPrepareForClose: ReturnType<typeof vi.fn>;
  notifyFadeOutComplete: ReturnType<typeof vi.fn>;
  setConfigurationMode: ReturnType<typeof vi.fn>;
  showConfigurationWindow: ReturnType<typeof vi.fn>;
  onExitConfigurationMode: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
  getVersionInfo: ReturnType<typeof vi.fn>;
  getLogFilePath: ReturnType<typeof vi.fn>;
  onOSOpenFile: ReturnType<typeof vi.fn>;
  onOSOpenPlaylist: ReturnType<typeof vi.fn>;
  minimizeWindow: ReturnType<typeof vi.fn>;
  closeWindow: ReturnType<typeof vi.fn>;
  clearRecentItems: ReturnType<typeof vi.fn>;
  openPlaylistDialog: ReturnType<typeof vi.fn>;
  savePlaylistDialog: ReturnType<typeof vi.fn>;
  saveMediaDialog: ReturnType<typeof vi.fn>;
  openSubtitleDialog: ReturnType<typeof vi.fn>;
  setupGetPort: ReturnType<typeof vi.fn>;
  setupSetPort: ReturnType<typeof vi.fn>;
  setupValidatePort: ReturnType<typeof vi.fn>;
  setupGetPlatform: ReturnType<typeof vi.fn>;
  setupComplete: ReturnType<typeof vi.fn>;
  setupSkip: ReturnType<typeof vi.fn>;
} = {
  getServerPort: vi.fn().mockResolvedValue(12345),
  getServerToken: vi.fn().mockResolvedValue('test-session-token'),
  getPlatformInfo: vi.fn().mockResolvedValue({platform: 'darwin', supportsGlass: true, systemTheme: 'dark'}),
  openFileDialog: vi.fn().mockResolvedValue([]),
  openSoundFontDialog: vi.fn().mockResolvedValue([]),
  getPathForFile: vi.fn().mockReturnValue('/mock/path'),
  enterFullscreen: vi.fn().mockResolvedValue(undefined),
  exitFullscreen: vi.fn().mockResolvedValue(undefined),
  isFullscreen: vi.fn().mockResolvedValue(false),
  onFullscreenChange: vi.fn().mockReturnValue((): void => {}),
  onFullscreenTransitionStart: vi.fn().mockReturnValue((): void => {}),
  onFullscreenTransitionEnd: vi.fn().mockReturnValue((): void => {}),
  onMenuEvent: vi.fn().mockReturnValue((): void => {}),
  enterMiniplayer: vi.fn().mockResolvedValue(undefined),
  exitMiniplayer: vi.fn().mockResolvedValue(undefined),
  getViewMode: vi.fn().mockResolvedValue('desktop'),
  onViewModeChange: vi.fn().mockReturnValue((): void => {}),
  onConfigOpenChange: vi.fn().mockReturnValue((): void => {}),
  setWindowPosition: vi.fn().mockResolvedValue({x: 0, y: 0}),
  getWindowPosition: vi.fn().mockResolvedValue({x: 0, y: 0}),
  setTrafficLightVisibility: vi.fn().mockResolvedValue(undefined),
  saveMiniplayerBounds: vi.fn().mockResolvedValue(undefined),
  onPrepareForClose: vi.fn().mockReturnValue((): void => {}),
  notifyFadeOutComplete: vi.fn(),
  setConfigurationMode: vi.fn().mockResolvedValue(undefined),
  showConfigurationWindow: vi.fn().mockResolvedValue(undefined),
  onExitConfigurationMode: vi.fn().mockReturnValue((): void => {}),
  openExternal: vi.fn().mockResolvedValue(undefined),
  getVersionInfo: vi.fn().mockReturnValue({electron: '1', node: '1', chrome: '1', v8: '1'}),
  getLogFilePath: vi.fn().mockResolvedValue('/tmp/test.log'),
  onOSOpenFile: vi.fn().mockReturnValue((): void => {}),
  onOSOpenPlaylist: vi.fn().mockReturnValue((): void => {}),
  minimizeWindow: vi.fn().mockResolvedValue(undefined),
  closeWindow: vi.fn().mockResolvedValue(undefined),
  clearRecentItems: vi.fn().mockResolvedValue(undefined),
  openPlaylistDialog: vi.fn().mockResolvedValue(null),
  savePlaylistDialog: vi.fn().mockResolvedValue(null),
  saveMediaDialog: vi.fn().mockResolvedValue(null),
  openSubtitleDialog: vi.fn().mockResolvedValue(null),
  setupGetPort: vi.fn().mockResolvedValue(0),
  setupSetPort: vi.fn().mockResolvedValue(undefined),
  setupValidatePort: vi.fn().mockResolvedValue(true),
  setupGetPlatform: vi.fn().mockResolvedValue('darwin'),
  setupComplete: vi.fn().mockResolvedValue(undefined),
  setupSkip: vi.fn().mockResolvedValue(undefined),
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

      it('should keep both subscribers rather than replacing the first', (): void => {
        // Registration used to be assignment, so a second subscriber silently
        // unhooked the first. Each registration now returns its own remover.
        const callback1: (settings: AppSettings) => void = vi.fn();
        const callback2: (settings: AppSettings) => void = vi.fn();

        const unsubscribe1: () => void = service.onSettingsUpdate(callback1);
        const unsubscribe2: () => void = service.onSettingsUpdate(callback2);

        expect(typeof unsubscribe1).toBe('function');
        expect(typeof unsubscribe2).toBe('function');
        expect(unsubscribe1).not.toBe(unsubscribe2);
      });

      it('should return an unsubscribe function from every registration', (): void => {
        expect(typeof service.onSettingsUpdate(vi.fn())).toBe('function');
        expect(typeof service.onDependencyStateUpdate(vi.fn())).toBe('function');
        expect(typeof service.onDependencyProgressUpdate(vi.fn())).toBe('function');
      });

      it('should tolerate unsubscribing twice', (): void => {
        const unsubscribe: () => void = service.onSettingsUpdate(vi.fn());

        unsubscribe();

        expect((): void => unsubscribe()).not.toThrow();
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
            headers: expect.objectContaining({'Content-Type': 'application/json'}),
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

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/player/state',
          expect.objectContaining({
            headers: expect.objectContaining({'X-Onix-Token': expect.any(String)}),
          }),
        );
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

        expect(mockFetch).toHaveBeenCalledWith(
          'http://127.0.0.1:12345/playlist',
          expect.objectContaining({
            headers: expect.objectContaining({'X-Onix-Token': expect.any(String)}),
          }),
        );
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
          expect.objectContaining({
            headers: expect.objectContaining({'X-Onix-Token': expect.any(String)}),
          }),
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

      it('should delegate showConfigurationWindow to the preload API', async (): Promise<void> => {
        await service.showConfigurationWindow('dependencies');
        expect(mockApi.showConfigurationWindow).toHaveBeenCalledWith('dependencies');
      });

      it('should delegate showConfigurationWindow without category to the preload API', async (): Promise<void> => {
        await service.showConfigurationWindow();
        expect(mockApi.showConfigurationWindow).toHaveBeenCalledWith(undefined);
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

// =============================================================================
// Public-surface characterization
//
// Everything below drives ElectronService only through what its consumers can
// reach: public methods and signals, the window.mediaPlayer preload bridge, the
// global fetch, and the injected SseClient. Nothing here reads or writes a
// private member, so these tests are indifferent to how the internals are
// arranged.
// =============================================================================

type Stub = ReturnType<typeof vi.fn>;
type Listener = (...args: unknown[]) => void;
type Subscriber = ReturnType<typeof vi.fn<(value: unknown) => void>>;
type SseHandlerMap = Record<string, (data: string) => void>;

const TOKEN: string = 'test-session-token';
const SERVER: string = 'http://127.0.0.1:12345';

/** Bridge functions that register a single listener and return its remover. */
const BRIDGE_LISTENER_NAMES: readonly string[] = [
  'onFullscreenChange',
  'onFullscreenTransitionStart',
  'onFullscreenTransitionEnd',
  'onViewModeChange',
  'onConfigOpenChange',
  'onPrepareForClose',
  'onExitConfigurationMode',
  'onOSOpenFile',
  'onOSOpenPlaylist',
];

/** Every menu event the service is expected to subscribe to. */
const MENU_EVENT_NAMES: readonly string[] = [
  'showConfig',
  'openFile',
  'togglePlayPause',
  'stop',
  'toggleShuffle',
  'toggleRepeat',
  'selectVisualization',
  'selectAspectMode',
  'closeMedia',
  'closeAll',
  'showHelp',
  'openPlaylist',
  'savePlaylist',
  'savePlaylistAs',
  'openRecentFile',
  'openRecentPlaylist',
];

/** Bridge functions that resolve to nothing. */
const VOID_BRIDGE_NAMES: readonly string[] = [
  'enterFullscreen',
  'exitFullscreen',
  'enterMiniplayer',
  'exitMiniplayer',
  'setContentHeight',
  'setTrafficLightVisibility',
  'saveMiniplayerBounds',
  'setConfigurationMode',
  'showConfigurationWindow',
  'showOpenUrlWindow',
  'minimizeWindow',
  'closeWindow',
  'clearRecentItems',
];

/** A fake preload bridge that records the listeners the service registers. */
interface BridgeHarness {
  readonly api: Record<string, Stub>;
  readonly listeners: Map<string, Listener>;
  readonly cleanups: Map<string, Stub>;
  readonly menuListeners: Map<string, Listener>;
  readonly menuCleanups: Map<string, Stub>;
}

/** A fake SseClient that records the handlers and lets a test emit events. */
interface SseHarness {
  readonly client: {connect: Stub; disconnect: Stub; isConnected: Stub};
  url(): string;
  emit(event: string, payload?: string): void;
  emitJson(event: string, value: unknown): void;
}

/** One recorded call to the fetch fake. */
interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/**
 * Builds a fresh preload-bridge fake.
 *
 * @returns The fake bridge plus the listeners and removers it has handed out
 */
function createBridge(): BridgeHarness {
  const listeners: Map<string, Listener> = new Map<string, Listener>();
  const cleanups: Map<string, Stub> = new Map<string, Stub>();
  const menuListeners: Map<string, Listener> = new Map<string, Listener>();
  const menuCleanups: Map<string, Stub> = new Map<string, Stub>();

  const api: Record<string, Stub> = {
    getServerPort: vi.fn().mockResolvedValue(12345),
    getServerToken: vi.fn().mockResolvedValue(TOKEN),
    getPlatformInfo: vi.fn().mockResolvedValue({platform: 'win32', supportsGlass: true, systemTheme: 'light'}),
    isFullscreen: vi.fn().mockResolvedValue(false),
    getViewMode: vi.fn().mockResolvedValue('desktop'),
    notifyFadeOutComplete: vi.fn(),
    openFileDialog: vi.fn().mockResolvedValue([]),
    openSoundFontDialog: vi.fn().mockResolvedValue([]),
    openSubtitleDialog: vi.fn().mockResolvedValue(null),
    openPlaylistDialog: vi.fn().mockResolvedValue(null),
    savePlaylistDialog: vi.fn().mockResolvedValue(null),
    saveMediaDialog: vi.fn().mockResolvedValue(null),
    getPathForFile: vi.fn().mockReturnValue('/mock/path'),
    setWindowPosition: vi.fn().mockResolvedValue({x: 0, y: 0}),
    getWindowPosition: vi.fn().mockResolvedValue({x: 0, y: 0}),
    onMenuEvent: vi.fn().mockImplementation((name: string, callback: Listener): Stub => {
      const cleanup: Stub = vi.fn();
      menuListeners.set(name, callback);
      menuCleanups.set(name, cleanup);
      return cleanup;
    }),
  };

  for (const name of VOID_BRIDGE_NAMES) {
    api[name] = vi.fn().mockResolvedValue(undefined);
  }

  for (const name of BRIDGE_LISTENER_NAMES) {
    api[name] = vi.fn().mockImplementation((callback: Listener): Stub => {
      const cleanup: Stub = vi.fn();
      listeners.set(name, callback);
      cleanups.set(name, cleanup);
      return cleanup;
    });
  }

  return {api, listeners, cleanups, menuListeners, menuCleanups};
}

/**
 * Builds a fresh SseClient fake.
 *
 * @returns The fake client plus helpers to inspect and drive it
 */
function createSse(): SseHarness {
  let connectedUrl: string = '';
  let handlers: SseHandlerMap = {};

  const emit: (event: string, payload?: string) => void = (event: string, payload: string = ''): void => {
    const handler: ((data: string) => void) | undefined = handlers[event];
    if (!handler) throw new Error(`No SSE handler registered for "${event}"`);
    handler(payload);
  };

  return {
    client: {
      connect: vi.fn().mockImplementation((url: string, registered: SseHandlerMap): void => {
        connectedUrl = url;
        handlers = registered;
      }),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
    },
    url: (): string => connectedUrl,
    emit,
    emitJson: (event: string, value: unknown): void => emit(event, JSON.stringify(value)),
  };
}

/**
 * Builds a JSON response as the media server would send it.
 *
 * @param body - The value to serialise as the response body
 * @param status - HTTP status code
 * @param statusText - HTTP status text
 * @returns A real Response carrying the JSON body
 */
function jsonResponse(body: unknown, status: number = 200, statusText: string = 'OK'): Response {
  return new Response(JSON.stringify(body), {status, statusText, headers: {'Content-Type': 'application/json'}});
}

/**
 * Replaces the global fetch with a fake that answers every request.
 *
 * @param route - Chooses the response for a request; defaults to `{}` with 200
 * @returns The fetch fake, for inspecting the requests it received
 */
function stubFetch(route?: (url: string, init?: RequestInit) => Response): Stub {
  const fetchMock: Stub = vi.fn().mockImplementation(async (url: string, init?: RequestInit): Promise<Response> => {
    return route ? route(url, init) : jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * Reads one request the fetch fake received.
 *
 * @param fetchMock - The fetch fake
 * @param index - Zero-based position of the request
 * @returns The request's URL and options
 */
function requestAt(fetchMock: Stub, index: number): RecordedRequest {
  const call: unknown[] | undefined = fetchMock.mock.calls[index];
  if (!call) throw new Error(`fetch was not called ${index + 1} time(s)`);
  return {url: call[0] as string, init: call[1] as RequestInit | undefined};
}

/**
 * Lists the method and URL of every request the fetch fake received.
 *
 * @param fetchMock - The fetch fake
 * @returns One "VERB url" entry per request, in order
 */
function requestLog(fetchMock: Stub): string[] {
  return fetchMock.mock.calls.map((call: unknown[]): string => {
    const init: RequestInit | undefined = call[1] as RequestInit | undefined;
    return `${init?.method ?? 'GET'} ${call[0] as string}`;
  });
}

/**
 * Waits until an assertion holds, polling quickly (real timers only).
 *
 * @param assertion - Throws until the awaited state is reached
 */
async function settle(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, {interval: 1, timeout: 1000});
}

/** The promise rejections nothing handled while a test ran. */
interface UnhandledRejections {
  readonly reasons: unknown[];
  stop(): void;
}

/** The part of Node's `process` that reports unhandled rejections. */
interface RejectionReporter {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

/**
 * Starts recording promise rejections that nothing handles.
 *
 * jsdom never dispatches `unhandledrejection` for promises settled by test
 * code, so this listens where the runtime actually reports them: the Node
 * process the tests run in, which the spec's type configuration does not
 * declare.
 *
 * @returns The recorded reasons and a way to stop recording
 */
function trackUnhandledRejections(): UnhandledRejections {
  const reasons: unknown[] = [];
  const listener: (reason: unknown) => void = (reason: unknown): void => {
    reasons.push(reason);
  };
  const reporter: RejectionReporter = (globalThis as unknown as {process: RejectionReporter}).process;
  reporter.on('unhandledRejection', listener);
  return {reasons, stop: (): void => void reporter.off('unhandledRejection', listener)};
}

/**
 * Lets every queued promise reaction run, along with the runtime's check for
 * unhandled rejections that follows them.
 */
function flushPromises(): Promise<void> {
  return new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, 0);
  });
}

/**
 * Invokes a listener the service registered on the bridge.
 *
 * @param bridge - The bridge fake
 * @param name - The bridge registration function (e.g. `onFullscreenChange`)
 * @param args - Arguments the main process would deliver
 */
function fireBridge(bridge: BridgeHarness, name: string, ...args: unknown[]): void {
  const listener: Listener | undefined = bridge.listeners.get(name);
  if (!listener) throw new Error(`No listener registered through ${name}`);
  listener(...args);
}

/**
 * Invokes a menu-event listener the service registered on the bridge.
 *
 * @param bridge - The bridge fake
 * @param name - The menu event name
 * @param args - Arguments the main process would deliver
 */
function fireMenu(bridge: BridgeHarness, name: string, ...args: unknown[]): void {
  const listener: Listener | undefined = bridge.menuListeners.get(name);
  if (!listener) throw new Error(`No menu listener registered for "${name}"`);
  listener(...args);
}

/**
 * Builds a playlist state.
 *
 * @param items - The playlist items
 * @param overrides - Any other fields to override
 * @returns A complete playlist state
 */
function playlistOf(items: PlaylistItem[], overrides: Partial<PlaylistState> = {}): PlaylistState {
  return {items, currentIndex: -1, shuffleEnabled: false, repeatEnabled: false, ...overrides};
}

/**
 * Builds a download job.
 *
 * @param overrides - Fields to override
 * @returns A complete download job
 */
function createJob(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: 'job-1',
    url: 'https://example.com/watch',
    format: 'video',
    status: 'downloading',
    progress: 0.5,
    title: 'Clip',
    filePath: null,
    errorMessage: null,
    ...overrides,
  };
}

/** A request the service is expected to issue for one public method. */
interface RequestCase {
  readonly name: string;
  readonly call: (target: ElectronService) => Promise<unknown>;
  readonly verb: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
}

/** Every public HTTP method, with the exact request it sends. */
const REQUEST_CASES: readonly RequestCase[] = [
  {name: 'play', call: (target: ElectronService): Promise<unknown> => target.play(), verb: 'POST', path: '/player/play'},
  {name: 'pause', call: (target: ElectronService): Promise<unknown> => target.pause(), verb: 'POST', path: '/player/pause'},
  {name: 'stop', call: (target: ElectronService): Promise<unknown> => target.stop(), verb: 'POST', path: '/player/stop'},
  {name: 'signalPlaybackStarted', call: (target: ElectronService): Promise<unknown> => target.signalPlaybackStarted(), verb: 'POST', path: '/player/started'},
  {name: 'seek', call: (target: ElectronService): Promise<unknown> => target.seek(42.5), verb: 'POST', path: '/player/seek', body: {time: 42.5}},
  {name: 'setVolume', call: (target: ElectronService): Promise<unknown> => target.setVolume(0.75), verb: 'POST', path: '/player/volume', body: {volume: 0.75}},
  {name: 'setVolume with a mute flag', call: (target: ElectronService): Promise<unknown> => target.setVolume(0.5, false), verb: 'POST', path: '/player/volume', body: {volume: 0.5, muted: false}},
  {name: 'getPlayerState', call: (target: ElectronService): Promise<unknown> => target.getPlayerState(), verb: 'GET', path: '/player/state'},
  {name: 'getPlaylist', call: (target: ElectronService): Promise<unknown> => target.getPlaylist(), verb: 'GET', path: '/playlist'},
  {name: 'addToPlaylist', call: (target: ElectronService): Promise<unknown> => target.addToPlaylist(['/a.mp3', '/b.mp3']), verb: 'POST', path: '/playlist/add', body: {paths: ['/a.mp3', '/b.mp3']}},
  {name: 'getUrlInfo', call: (target: ElectronService): Promise<unknown> => target.getUrlInfo('https://example.com/v'), verb: 'POST', path: '/media/url/info', body: {url: 'https://example.com/v'}},
  {
    name: 'downloadUrl',
    call: (target: ElectronService): Promise<unknown> => target.downloadUrl('https://example.com/v', 'audio', '137', 'Clip', '/out/clip.mp3'),
    verb: 'POST',
    path: '/media/url/download',
    body: {url: 'https://example.com/v', format: 'audio', formatId: '137', title: 'Clip', outputPath: '/out/clip.mp3'},
  },
  {
    name: 'downloadUrl without a format id',
    call: (target: ElectronService): Promise<unknown> => target.downloadUrl('https://example.com/v', 'video', null, 'Clip', '/out/clip.mp4'),
    verb: 'POST',
    path: '/media/url/download',
    body: {url: 'https://example.com/v', format: 'video', formatId: null, title: 'Clip', outputPath: '/out/clip.mp4'},
  },
  {name: 'cancelDownload', call: (target: ElectronService): Promise<unknown> => target.cancelDownload('job/1 a'), verb: 'POST', path: '/media/url/cancel/job%2F1%20a'},
  {name: 'removeFromPlaylist', call: (target: ElectronService): Promise<unknown> => target.removeFromPlaylist('track-abc'), verb: 'DELETE', path: '/playlist/remove/track-abc'},
  {name: 'clearPlaylist', call: (target: ElectronService): Promise<unknown> => target.clearPlaylist(), verb: 'DELETE', path: '/playlist/clear'},
  {name: 'selectTrack', call: (target: ElectronService): Promise<unknown> => target.selectTrack('track-xyz'), verb: 'POST', path: '/playlist/select/track-xyz'},
  {name: 'nextTrack', call: (target: ElectronService): Promise<unknown> => target.nextTrack(), verb: 'POST', path: '/playlist/next'},
  {name: 'previousTrack', call: (target: ElectronService): Promise<unknown> => target.previousTrack(), verb: 'POST', path: '/playlist/previous'},
  {name: 'setShuffle', call: (target: ElectronService): Promise<unknown> => target.setShuffle(true), verb: 'POST', path: '/playlist/shuffle', body: {enabled: true}},
  {name: 'setRepeat', call: (target: ElectronService): Promise<unknown> => target.setRepeat(false), verb: 'POST', path: '/playlist/repeat', body: {enabled: false}},
  {name: 'savePlaylistToFile', call: (target: ElectronService): Promise<unknown> => target.savePlaylistToFile('/lists/mine.opp'), verb: 'POST', path: '/playlist/save', body: {filePath: '/lists/mine.opp'}},
  {name: 'loadPlaylistFromFile', call: (target: ElectronService): Promise<unknown> => target.loadPlaylistFromFile('/lists/mine.opp'), verb: 'POST', path: '/playlist/load', body: {filePath: '/lists/mine.opp'}},
  {name: 'getPlaylistSourcePath', call: (target: ElectronService): Promise<unknown> => target.getPlaylistSourcePath(), verb: 'GET', path: '/playlist/source'},
  {name: 'getMediaInfo', call: (target: ElectronService): Promise<unknown> => target.getMediaInfo('/music/My Songs/track #1.mp3'), verb: 'GET', path: '/media/info?path=%2Fmusic%2FMy%20Songs%2Ftrack%20%231.mp3'},
];

/** The methods that surface a server failure as "HTTP <status>: <statusText>". */
const STATUS_TEXT_CASES: readonly RequestCase[] = REQUEST_CASES.filter(
  (requestCase: RequestCase): boolean => !requestCase.name.startsWith('getUrlInfo') && !requestCase.name.startsWith('downloadUrl'),
);

/** The methods that resolve to nothing whatever the server answers. */
const VOID_METHOD_NAMES: readonly string[] = [
  'play', 'pause', 'stop', 'signalPlaybackStarted', 'seek', 'setVolume', 'removeFromPlaylist', 'clearPlaylist',
  'selectTrack', 'nextTrack', 'previousTrack', 'setShuffle', 'setRepeat', 'savePlaylistToFile',
];

/** The methods that hand back the server's JSON body untouched. */
const PASS_THROUGH_METHOD_NAMES: readonly string[] = [
  'getPlayerState', 'getPlaylist', 'addToPlaylist', 'getUrlInfo', 'downloadUrl', 'cancelDownload', 'loadPlaylistFromFile', 'getMediaInfo',
];

/**
 * Finds the request case for a public method.
 *
 * @param name - The case name
 * @returns The matching case
 */
function requestCase(name: string): RequestCase {
  const found: RequestCase | undefined = REQUEST_CASES.find((candidate: RequestCase): boolean => candidate.name === name);
  if (!found) throw new Error(`No request case named "${name}"`);
  return found;
}

/** A window/IPC method that forwards to one bridge function and resolves to nothing. */
interface VoidIpcCase {
  readonly name: string;
  readonly call: (target: ElectronService) => Promise<void>;
  readonly bridgeName: string;
  readonly args: readonly unknown[];
}

const VOID_IPC_CASES: readonly VoidIpcCase[] = [
  {name: 'enterFullscreen', call: (target: ElectronService): Promise<void> => target.enterFullscreen(), bridgeName: 'enterFullscreen', args: []},
  {name: 'exitFullscreen', call: (target: ElectronService): Promise<void> => target.exitFullscreen(), bridgeName: 'exitFullscreen', args: []},
  {name: 'enterMiniplayer', call: (target: ElectronService): Promise<void> => target.enterMiniplayer(), bridgeName: 'enterMiniplayer', args: []},
  {name: 'exitMiniplayer', call: (target: ElectronService): Promise<void> => target.exitMiniplayer(), bridgeName: 'exitMiniplayer', args: []},
  {name: 'setContentHeight', call: (target: ElectronService): Promise<void> => target.setContentHeight(420), bridgeName: 'setContentHeight', args: [420]},
  {name: 'setTrafficLightVisibility', call: (target: ElectronService): Promise<void> => target.setTrafficLightVisibility(false), bridgeName: 'setTrafficLightVisibility', args: [false]},
  {name: 'saveMiniplayerBounds', call: (target: ElectronService): Promise<void> => target.saveMiniplayerBounds(), bridgeName: 'saveMiniplayerBounds', args: []},
  {name: 'setConfigurationMode', call: (target: ElectronService): Promise<void> => target.setConfigurationMode(true), bridgeName: 'setConfigurationMode', args: [true]},
  {name: 'showConfigurationWindow', call: (target: ElectronService): Promise<void> => target.showConfigurationWindow('dependencies'), bridgeName: 'showConfigurationWindow', args: ['dependencies']},
  {name: 'showOpenUrlWindow', call: (target: ElectronService): Promise<void> => target.showOpenUrlWindow(), bridgeName: 'showOpenUrlWindow', args: []},
  {name: 'minimizeWindow', call: (target: ElectronService): Promise<void> => target.minimizeWindow(), bridgeName: 'minimizeWindow', args: []},
  {name: 'closeWindow', call: (target: ElectronService): Promise<void> => target.closeWindow(), bridgeName: 'closeWindow', args: []},
  {name: 'clearRecentItems', call: (target: ElectronService): Promise<void> => target.clearRecentItems(), bridgeName: 'clearRecentItems', args: []},
];

/** A menu event whose only effect is to bump a public counter signal. */
interface MenuCounterCase {
  readonly event: string;
  readonly signalName: string;
  readonly read: (target: ElectronService) => number;
}

const MENU_COUNTER_CASES: readonly MenuCounterCase[] = [
  {event: 'showConfig', signalName: 'menuShowConfig', read: (target: ElectronService): number => target.menuShowConfig()},
  {event: 'openFile', signalName: 'menuOpenFile', read: (target: ElectronService): number => target.menuOpenFile()},
  {event: 'showHelp', signalName: 'menuShowHelp', read: (target: ElectronService): number => target.menuShowHelp()},
  {event: 'openPlaylist', signalName: 'menuOpenPlaylist', read: (target: ElectronService): number => target.menuOpenPlaylist()},
  {event: 'savePlaylist', signalName: 'menuSavePlaylist', read: (target: ElectronService): number => target.menuSavePlaylist()},
  {event: 'savePlaylistAs', signalName: 'menuSavePlaylistAs', read: (target: ElectronService): number => target.menuSavePlaylistAs()},
];

/** Something that starts a server command nobody awaits. */
interface BackgroundCommandCase {
  readonly name: string;
  /** What the failure is logged as, after the service's prefix */
  readonly logged: string;
  readonly trigger: (bridge: BridgeHarness, sse: SseHarness) => void;
}

const BACKGROUND_COMMAND_CASES: readonly BackgroundCommandCase[] = [
  {name: 'the play/pause menu item', logged: 'Play/pause failed:', trigger: (bridge: BridgeHarness): void => fireMenu(bridge, 'togglePlayPause')},
  {name: 'the stop menu item', logged: 'Stop failed:', trigger: (bridge: BridgeHarness): void => fireMenu(bridge, 'stop')},
  {name: 'the shuffle menu item', logged: 'Toggle shuffle failed:', trigger: (bridge: BridgeHarness): void => fireMenu(bridge, 'toggleShuffle')},
  {name: 'the repeat menu item', logged: 'Toggle repeat failed:', trigger: (bridge: BridgeHarness): void => fireMenu(bridge, 'toggleRepeat')},
  {
    name: 'the Close menu item',
    logged: 'Close media failed:',
    trigger: (bridge: BridgeHarness, sse: SseHarness): void => {
      sse.emitJson('playlist:updated', playlistOf([createMockPlaylistItem({id: 'a'})], {currentIndex: 0}));
      fireMenu(bridge, 'closeMedia');
    },
  },
  {name: 'the Close All menu item', logged: 'Close all failed:', trigger: (bridge: BridgeHarness): void => fireMenu(bridge, 'closeAll')},
  {name: 'a recent file chosen in the menu', logged: 'Open recent file failed:', trigger: (bridge: BridgeHarness): void => fireMenu(bridge, 'openRecentFile', '/recent/song.mp3')},
  {name: 'a recent playlist chosen in the menu', logged: 'Open recent playlist failed:', trigger: (bridge: BridgeHarness): void => fireMenu(bridge, 'openRecentPlaylist', '/recent/list.opp')},
  {name: 'a media file opened from the OS', logged: 'Open file from the OS failed:', trigger: (bridge: BridgeHarness): void => fireBridge(bridge, 'onOSOpenFile', '/from/finder.mp3')},
  {name: 'a playlist file opened from the OS', logged: 'Open playlist from the OS failed:', trigger: (bridge: BridgeHarness): void => fireBridge(bridge, 'onOSOpenPlaylist', '/from/finder.opp')},
  {
    name: 'a completed download',
    logged: 'Add downloaded file failed:',
    trigger: (_bridge: BridgeHarness, sse: SseHarness): void => sse.emitJson('download:complete', createJob({status: 'done', progress: 1, filePath: '/downloads/Clip.mp4'})),
  },
  {
    name: 'a SoundFont change that asks for a restart',
    logged: 'Restart after SoundFont change failed:',
    trigger: (_bridge: BridgeHarness, sse: SseHarness): void => sse.emitJson('soundfont:changed', {restart: true, filePath: '/song.mid'}),
  },
];

describe('ElectronService public surface', (): void => {
  let service: ElectronService;
  let bridge: BridgeHarness;
  let sse: SseHarness;
  let fetchMock: Stub;
  let errorSpy: Stub;
  let warnSpy: Stub;
  let unhandled: UnhandledRejections;

  /**
   * Installs the bridge fake and creates the service, without waiting for its
   * start-up sequence.
   *
   * @returns The service, still starting up
   */
  function createInElectron(): ElectronService {
    (window as unknown as Record<string, unknown>)['mediaPlayer'] = bridge.api;
    TestBed.configureTestingModule({providers: [{provide: SseClient, useValue: sse.client}]});
    return TestBed.inject(ElectronService);
  }

  /**
   * Installs the bridge fake, creates the service and waits for its start-up
   * sequence (port, token, platform, SSE, listeners) to finish.
   *
   * @returns The initialised service
   */
  async function startInElectron(): Promise<ElectronService> {
    const started: ElectronService = createInElectron();
    await settle((): void => {
      expect(bridge.api['onOSOpenPlaylist']).toHaveBeenCalled();
    });
    return started;
  }

  /**
   * Creates the service with no preload bridge, as when served in a browser.
   *
   * @returns The service, which skips its start-up sequence
   */
  function startOutsideElectron(): ElectronService {
    delete (window as unknown as Record<string, unknown>)['mediaPlayer'];
    TestBed.configureTestingModule({providers: [{provide: SseClient, useValue: sse.client}]});
    return TestBed.inject(ElectronService);
  }

  beforeEach((): void => {
    bridge = createBridge();
    sse = createSse();
    fetchMock = stubFetch();
    vi.spyOn(console, 'log').mockImplementation((): void => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => {}) as unknown as Stub;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((): void => {}) as unknown as Stub;
    unhandled = trackUnhandledRejections();
  });

  afterEach((): void => {
    unhandled.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>)['mediaPlayer'];
  });

  // ===========================================================================
  // Start-up
  // ===========================================================================

  describe('start-up inside Electron', (): void => {
    it('should publish the server URL built from the port the bridge reports', async (): Promise<void> => {
      bridge.api['getServerPort'].mockResolvedValue(54545);

      service = await startInElectron();

      expect(service.serverUrl()).toBe('http://127.0.0.1:54545');
    });

    it('should publish the platform information the bridge reports', async (): Promise<void> => {
      service = await startInElectron();

      expect(service.platformInfo()).toEqual({platform: 'win32', supportsGlass: true, systemTheme: 'light'});
    });

    it('should open one SSE connection to /events carrying the session token', async (): Promise<void> => {
      service = await startInElectron();

      expect(sse.client.connect).toHaveBeenCalledTimes(1);
      expect(sse.url()).toBe(`${SERVER}/events?token=${TOKEN}`);
    });

    it('should adopt the initial fullscreen state the bridge reports', async (): Promise<void> => {
      bridge.api['isFullscreen'].mockResolvedValue(true);

      service = await startInElectron();

      await settle((): void => {
        expect(service.isFullscreen()).toBe(true);
      });
    });

    it('should keep the default fullscreen state and log when the initial read fails', async (): Promise<void> => {
      const failure: Error = new Error('ipc down');
      bridge.api['isFullscreen'].mockRejectedValue(failure);

      service = await startInElectron();

      await settle((): void => {
        expect(errorSpy).toHaveBeenCalledWith('[WindowIpc] Failed to read initial fullscreen state:', failure);
      });
      expect(service.isFullscreen()).toBe(false);
    });

    it('should adopt the initial view mode the bridge reports', async (): Promise<void> => {
      bridge.api['getViewMode'].mockResolvedValue('miniplayer');

      service = await startInElectron();

      await settle((): void => {
        expect(service.viewMode()).toBe('miniplayer');
      });
    });

    it('should adopt an initial fullscreen view mode', async (): Promise<void> => {
      bridge.api['getViewMode'].mockResolvedValue('fullscreen');

      service = await startInElectron();

      await settle((): void => {
        expect(service.viewMode()).toBe('fullscreen');
      });
    });

    it('should keep the default view mode and log when the initial read fails', async (): Promise<void> => {
      const failure: Error = new Error('ipc down');
      bridge.api['getViewMode'].mockRejectedValue(failure);

      service = await startInElectron();

      await settle((): void => {
        expect(errorSpy).toHaveBeenCalledWith('[WindowIpc] Failed to read initial view mode:', failure);
      });
      expect(service.viewMode()).toBe('desktop');
    });

    it('should subscribe to exactly the supported menu events', async (): Promise<void> => {
      service = await startInElectron();

      expect([...bridge.menuListeners.keys()].sort()).toEqual([...MENU_EVENT_NAMES].sort());
      expect(bridge.api['onMenuEvent']).toHaveBeenCalledTimes(MENU_EVENT_NAMES.length);
    });

    it('should register one listener for every window and OS event', async (): Promise<void> => {
      service = await startInElectron();

      for (const name of BRIDGE_LISTENER_NAMES) {
        expect(bridge.api[name], name).toHaveBeenCalledTimes(1);
      }
    });

    it.each([
      ['the server port', 'getServerPort'],
      ['the session token', 'getServerToken'],
      ['the platform information', 'getPlatformInfo'],
    ])('should log when %s cannot be read at start-up', async (_what: string, bridgeName: string): Promise<void> => {
      const failure: Error = new Error('ipc down');
      bridge.api[bridgeName].mockRejectedValue(failure);

      service = createInElectron();

      await settle((): void => {
        expect(errorSpy).toHaveBeenCalledWith('[ElectronService] Initialization failed:', failure);
      });
    });

    it('should leave no unhandled rejection when start-up fails', async (): Promise<void> => {
      bridge.api['getServerPort'].mockRejectedValue(new Error('ipc down'));

      service = createInElectron();
      await flushPromises();

      expect(unhandled.reasons).toEqual([]);
    });
  });

  describe('start-up outside Electron', (): void => {
    it('should not open an SSE connection', async (): Promise<void> => {
      service = startOutsideElectron();
      await Promise.resolve();

      expect(sse.client.connect).not.toHaveBeenCalled();
      expect(service.serverUrl()).toBe('');
    });
  });

  // ===========================================================================
  // Session token: appendAuth, getStreamUrl, authFetch
  // ===========================================================================

  describe('session token', (): void => {
    it('should append the token as the first query parameter when the URL has none', async (): Promise<void> => {
      service = await startInElectron();

      expect(service.appendAuth(`${SERVER}/events`)).toBe(`${SERVER}/events?token=${TOKEN}`);
    });

    it('should append the token as a further query parameter when the URL already has one', async (): Promise<void> => {
      service = await startInElectron();

      expect(service.appendAuth(`${SERVER}/media/art?path=x`)).toBe(`${SERVER}/media/art?path=x&token=${TOKEN}`);
    });

    it('should percent-encode the token in a URL', async (): Promise<void> => {
      bridge.api['getServerToken'].mockResolvedValue('a b&c=d');
      service = await startInElectron();

      expect(service.appendAuth(`${SERVER}/events`)).toBe(`${SERVER}/events?token=a%20b%26c%3Dd`);
    });

    it('should leave a URL untouched when no token is known', (): void => {
      service = startOutsideElectron();

      expect(service.appendAuth('http://host/events')).toBe('http://host/events');
    });

    it('should put the token last in a stream URL', async (): Promise<void> => {
      service = await startInElectron();

      expect(service.getStreamUrl('/music/a b.mp3')).toBe(`${SERVER}/media/stream?path=%2Fmusic%2Fa%20b.mp3&token=${TOKEN}`);
    });

    it('should put the seek time before the token in a stream URL', async (): Promise<void> => {
      service = await startInElectron();

      expect(service.getStreamUrl('/v.mkv', 30)).toBe(`${SERVER}/media/stream?path=%2Fv.mkv&t=30&token=${TOKEN}`);
    });

    it('should omit a negative seek time from a stream URL', async (): Promise<void> => {
      service = await startInElectron();

      expect(service.getStreamUrl('/v.mkv', -5)).toBe(`${SERVER}/media/stream?path=%2Fv.mkv&token=${TOKEN}`);
    });

    it('should send the token in the X-Onix-Token header from authFetch', async (): Promise<void> => {
      service = await startInElectron();

      await service.authFetch(`${SERVER}/anything`);

      expect(requestAt(fetchMock, 0)).toEqual({url: `${SERVER}/anything`, init: {headers: {'X-Onix-Token': TOKEN}}});
    });

    it('should keep the caller\'s fetch options and headers in authFetch', async (): Promise<void> => {
      service = await startInElectron();

      await service.authFetch(`${SERVER}/anything`, {method: 'PUT', body: 'payload', headers: {Accept: 'text/plain'}});

      expect(requestAt(fetchMock, 0).init).toEqual({
        method: 'PUT',
        body: 'payload',
        headers: {Accept: 'text/plain', 'X-Onix-Token': TOKEN},
      });
    });

    it('should override a caller-supplied X-Onix-Token header in authFetch', async (): Promise<void> => {
      service = await startInElectron();

      await service.authFetch(`${SERVER}/anything`, {headers: {'X-Onix-Token': 'forged'}});

      expect(requestAt(fetchMock, 0).init).toEqual({headers: {'X-Onix-Token': TOKEN}});
    });

    it('should resolve authFetch with the response fetch produced', async (): Promise<void> => {
      const response: Response = jsonResponse({ok: true});
      fetchMock.mockResolvedValueOnce(response);
      service = await startInElectron();

      const result: Response = await service.authFetch(`${SERVER}/anything`);

      expect(result).toBe(response);
    });

    it('should send an empty X-Onix-Token header when no token is known', async (): Promise<void> => {
      service = startOutsideElectron();

      await service.authFetch('http://host/anything');

      expect(requestAt(fetchMock, 0).init).toEqual({headers: {'X-Onix-Token': ''}});
    });
  });

  // ===========================================================================
  // HTTP player API
  // ===========================================================================

  describe('HTTP player API', (): void => {
    beforeEach(async (): Promise<void> => {
      service = await startInElectron();
    });

    it.each(REQUEST_CASES)('should send $verb $path with the session token when $name is called', async ({call, verb, path, body}: RequestCase): Promise<void> => {
      await call(service);

      const expectedInit: Record<string, unknown> = {
        GET: {headers: {'X-Onix-Token': TOKEN}},
        DELETE: {method: 'DELETE', headers: {'X-Onix-Token': TOKEN}},
        POST: {
          method: 'POST',
          headers: {'Content-Type': 'application/json', 'X-Onix-Token': TOKEN},
          ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        },
      }[verb];
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(requestAt(fetchMock, 0).url).toBe(`${SERVER}${path}`);
      expect(requestAt(fetchMock, 0).init).toStrictEqual(verb === 'POST' && body === undefined ? {...expectedInit, body: undefined} : expectedInit);
    });

    it.each(STATUS_TEXT_CASES)('should reject $name with the HTTP status and status text when the server answers with an error', async ({call}: RequestCase): Promise<void> => {
      fetchMock.mockResolvedValueOnce(jsonResponse({error: 'ignored'}, 503, 'Service Unavailable'));

      await expect(call(service)).rejects.toThrow(new Error('HTTP 503: Service Unavailable'));
    });

    it.each(REQUEST_CASES)('should reject $name with the underlying error when the request cannot be sent', async ({call}: RequestCase): Promise<void> => {
      const failure: TypeError = new TypeError('Failed to fetch');
      fetchMock.mockRejectedValueOnce(failure);

      await expect(call(service)).rejects.toBe(failure);
    });

    it.each(VOID_METHOD_NAMES)('should resolve %s to nothing even though the server answers with JSON', async (name: string): Promise<void> => {
      fetchMock.mockResolvedValueOnce(jsonResponse({status: 'ok'}));

      await expect(requestCase(name).call(service)).resolves.toBeUndefined();
    });

    it.each(PASS_THROUGH_METHOD_NAMES)('should resolve %s to the JSON body the server sent', async (name: string): Promise<void> => {
      const payload: {marker: string; nested: {value: number}} = {marker: name, nested: {value: 7}};
      fetchMock.mockResolvedValueOnce(jsonResponse(payload));

      await expect(requestCase(name).call(service)).resolves.toEqual(payload);
    });

    it('should resolve getPlaylistSourcePath to the file path the server reports', async (): Promise<void> => {
      fetchMock.mockResolvedValueOnce(jsonResponse({filePath: '/lists/mine.opp'}));

      await expect(service.getPlaylistSourcePath()).resolves.toBe('/lists/mine.opp');
    });

    it('should resolve getPlaylistSourcePath to null when the playlist has no source file', async (): Promise<void> => {
      fetchMock.mockResolvedValueOnce(jsonResponse({filePath: null}));

      await expect(service.getPlaylistSourcePath()).resolves.toBeNull();
    });

    it('should reject a command when a successful response carries no JSON body', async (): Promise<void> => {
      fetchMock.mockResolvedValueOnce(new Response('', {status: 200}));

      await expect(service.play()).rejects.toBeInstanceOf(SyntaxError);
    });

    it('should send a zero volume rather than dropping it', async (): Promise<void> => {
      await service.setVolume(0, true);

      expect(requestAt(fetchMock, 0).init?.body).toBe(JSON.stringify({volume: 0, muted: true}));
    });

    it('should send a zero seek position rather than dropping it', async (): Promise<void> => {
      await service.seek(0);

      expect(requestAt(fetchMock, 0).init?.body).toBe(JSON.stringify({time: 0}));
    });

    it('should percent-encode the id when selecting or removing a track', async (): Promise<void> => {
      await service.selectTrack('a/b c');
      await service.removeFromPlaylist('a/b c');

      expect(requestLog(fetchMock)).toEqual([
        `POST ${SERVER}/playlist/select/a%2Fb%20c`,
        `DELETE ${SERVER}/playlist/remove/a%2Fb%20c`,
      ]);
    });

    // -------------------------------------------------------------------------
    // seek timestamp
    // -------------------------------------------------------------------------

    it('should report no seek before the first one', (): void => {
      expect(service.lastSeekAt).toBe(0);
    });

    it('should record when the last seek was requested', async (): Promise<void> => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-04T05:06:07.000Z'));

      await service.seek(12);

      expect(service.lastSeekAt).toBe(Date.parse('2026-03-04T05:06:07.000Z'));
    });

    it('should record the seek time even when the seek request fails', async (): Promise<void> => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-04T05:06:07.000Z'));
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await expect(service.seek(12)).rejects.toThrow('Failed to fetch');

      expect(service.lastSeekAt).toBe(Date.parse('2026-03-04T05:06:07.000Z'));
    });

    // -------------------------------------------------------------------------
    // syncPlaybackTime (fire-and-forget)
    // -------------------------------------------------------------------------

    it('should post the element position to /player/sync', (): void => {
      service.syncPlaybackTime(33.25);

      expect(requestAt(fetchMock, 0)).toEqual({
        url: `${SERVER}/player/sync`,
        init: {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Onix-Token': TOKEN}, body: JSON.stringify({time: 33.25})},
      });
    });

    it('should warn instead of throwing when the sync is rejected by the server', async (): Promise<void> => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 500, 'Internal Server Error'));

      service.syncPlaybackTime(1);

      await settle((): void => {
        expect(warnSpy).toHaveBeenCalledWith('Failed to sync playback time:', new Error('HTTP 500: Internal Server Error'));
      });
    });

    it('should warn instead of throwing when the sync cannot be sent', async (): Promise<void> => {
      const failure: TypeError = new TypeError('Failed to fetch');
      fetchMock.mockRejectedValueOnce(failure);

      service.syncPlaybackTime(1);

      await settle((): void => {
        expect(warnSpy).toHaveBeenCalledWith('Failed to sync playback time:', failure);
      });
    });

    // -------------------------------------------------------------------------
    // URL media: getUrlInfo / downloadUrl / streamUrl
    // -------------------------------------------------------------------------

    it('should reject getUrlInfo with the server\'s own error message', async (): Promise<void> => {
      fetchMock.mockResolvedValueOnce(jsonResponse({error: 'Unsupported URL'}, 400, 'Bad Request'));

      await expect(service.getUrlInfo('https://example.com/v')).rejects.toThrow(new Error('Unsupported URL'));
    });

    it('should reject getUrlInfo with the bare status when the error body has no message', async (): Promise<void> => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 404, 'Not Found'));

      await expect(service.getUrlInfo('https://example.com/v')).rejects.toThrow(new Error('HTTP 404'));
    });

    it('should reject getUrlInfo with the bare status when the error body is not JSON', async (): Promise<void> => {
      fetchMock.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', {status: 502, statusText: 'Bad Gateway'}));

      await expect(service.getUrlInfo('https://example.com/v')).rejects.toThrow(new Error('HTTP 502'));
    });

    it('should resolve getUrlInfo to null when a successful response is not JSON', async (): Promise<void> => {
      fetchMock.mockResolvedValueOnce(new Response('not json', {status: 200}));

      const info: UrlMediaInfo = await service.getUrlInfo('https://example.com/v');

      expect(info).toBeNull();
    });

    it('should reject downloadUrl with the server\'s own error message', async (): Promise<void> => {
      fetchMock.mockResolvedValueOnce(jsonResponse({error: 'yt-dlp is not installed'}, 500, 'Internal Server Error'));

      await expect(service.downloadUrl('https://example.com/v', 'video', null, 'Clip', '/out/clip.mp4')).rejects.toThrow(new Error('yt-dlp is not installed'));
    });

    it('should clear the previous download job when a new download starts', async (): Promise<void> => {
      sse.emitJson('download:progress', createJob());

      await service.downloadUrl('https://example.com/v', 'video', null, 'Clip', '/out/clip.mp4');

      expect(service.downloadJob()).toBeNull();
    });

    it('should leave the download job cleared when starting the download fails', async (): Promise<void> => {
      sse.emitJson('download:progress', createJob());
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await expect(service.downloadUrl('https://example.com/v', 'video', null, 'Clip', '/out/clip.mp4')).rejects.toThrow('Failed to fetch');

      expect(service.downloadJob()).toBeNull();
    });

    it('should resolve a stream URL, add it to the playlist and select it', async (): Promise<void> => {
      const added: PlaylistItem = createMockPlaylistItem({id: 'stream-1', filePath: 'https://cdn.example.com/s.m3u8'});
      fetchMock.mockImplementation(async (url: string): Promise<Response> => {
        if (url.endsWith('/media/url/resolve')) return jsonResponse({url: 'https://cdn.example.com/s.m3u8'});
        if (url.endsWith('/playlist/add')) return jsonResponse({added: [added]});
        return jsonResponse({});
      });

      const result: {added: PlaylistItem[]} = await service.streamUrl('https://example.com/v', 'video', 720);

      expect(result).toEqual({added: [added]});
      expect(requestLog(fetchMock)).toEqual([
        `POST ${SERVER}/media/url/resolve`,
        `POST ${SERVER}/playlist/add`,
        `POST ${SERVER}/playlist/select/stream-1`,
      ]);
      expect(requestAt(fetchMock, 0).init?.body).toBe(JSON.stringify({url: 'https://example.com/v', format: 'video', maxHeight: 720}));
      expect(requestAt(fetchMock, 1).init?.body).toBe(JSON.stringify({paths: ['https://cdn.example.com/s.m3u8']}));
    });

    it('should send a null height cap when streaming without one', async (): Promise<void> => {
      fetchMock.mockImplementation(async (url: string): Promise<Response> => {
        return url.endsWith('/media/url/resolve') ? jsonResponse({url: 'https://cdn.example.com/a.mp3'}) : jsonResponse({added: []});
      });

      await service.streamUrl('https://example.com/v', 'audio', null);

      expect(requestAt(fetchMock, 0).init?.body).toBe(JSON.stringify({url: 'https://example.com/v', format: 'audio', maxHeight: null}));
    });

    it('should reject streamUrl with the server\'s message and add nothing when the URL cannot be resolved', async (): Promise<void> => {
      fetchMock.mockResolvedValueOnce(jsonResponse({error: 'Video unavailable'}, 500, 'Internal Server Error'));

      await expect(service.streamUrl('https://example.com/v', 'video', null)).rejects.toThrow(new Error('Video unavailable'));

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // -------------------------------------------------------------------------
    // addFilesWithAutoPlay failure paths
    // -------------------------------------------------------------------------

    it('should reject addFilesWithAutoPlay and select nothing when the add fails', async (): Promise<void> => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 500, 'Internal Server Error'));

      await expect(service.addFilesWithAutoPlay(['/a.mp3'])).rejects.toThrow(new Error('HTTP 500: Internal Server Error'));

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should reject addFilesWithAutoPlay when the added track cannot be selected', async (): Promise<void> => {
      fetchMock.mockImplementation(async (url: string): Promise<Response> => {
        return url.endsWith('/playlist/add')
          ? jsonResponse({added: [createMockPlaylistItem({id: 'new-1'})]})
          : jsonResponse({}, 404, 'Not Found');
      });

      await expect(service.addFilesWithAutoPlay(['/a.mp3'])).rejects.toThrow(new Error('HTTP 404: Not Found'));
    });

    it('should decide auto-play from the playlist as it was before the add', async (): Promise<void> => {
      const first: PlaylistItem = createMockPlaylistItem({id: 'new-1', filePath: '/a.mp3'});
      const second: PlaylistItem = createMockPlaylistItem({id: 'new-2', filePath: '/b.mp3'});
      fetchMock.mockImplementation(async (url: string): Promise<Response> => {
        if (url.endsWith('/playlist/add')) {
          // The server announces the new items over SSE before the POST returns.
          sse.emitJson('playlist:items:added', {items: [first, second], startIndex: 0, currentIndex: -1});
          return jsonResponse({added: [first, second]});
        }
        return jsonResponse({});
      });

      await service.addFilesWithAutoPlay(['/a.mp3', '/b.mp3']);

      expect(requestLog(fetchMock)).toEqual([`POST ${SERVER}/playlist/add`, `POST ${SERVER}/playlist/select/new-1`]);
    });
  });

  // ===========================================================================
  // Window / IPC methods
  // ===========================================================================

  describe('window and IPC methods inside Electron', (): void => {
    beforeEach(async (): Promise<void> => {
      service = await startInElectron();
    });

    it.each(VOID_IPC_CASES)('should forward $name to the bridge and resolve to nothing', async ({call, bridgeName, args}: VoidIpcCase): Promise<void> => {
      const result: void = await call(service);

      expect(bridge.api[bridgeName]).toHaveBeenCalledTimes(1);
      expect(bridge.api[bridgeName]).toHaveBeenCalledWith(...args);
      expect(result).toBeUndefined();
    });

    it.each(VOID_IPC_CASES)('should reject $name when the bridge call fails', async ({call, bridgeName}: VoidIpcCase): Promise<void> => {
      const failure: Error = new Error('ipc failed');
      bridge.api[bridgeName].mockRejectedValueOnce(failure);

      await expect(call(service)).rejects.toBe(failure);
    });

    it('should open the file dialog with every supported format when no filters are given', async (): Promise<void> => {
      await service.openFileDialog();

      expect(bridge.api['openFileDialog']).toHaveBeenCalledWith({
        filters: buildFileDialogFilters(true, true, true),
        multiSelections: true,
      });
    });

    it('should open the file dialog with the caller\'s filters and selection mode', async (): Promise<void> => {
      const filters: {name: string; extensions: string[]}[] = [{name: 'Audio Only', extensions: ['mp3']}];

      await service.openFileDialog(false, filters);

      expect(bridge.api['openFileDialog']).toHaveBeenCalledWith({filters, multiSelections: false});
    });

    it('should return the paths chosen in the file dialog', async (): Promise<void> => {
      bridge.api['openFileDialog'].mockResolvedValueOnce(['/a.mp3', '/b.mp3']);

      await expect(service.openFileDialog()).resolves.toEqual(['/a.mp3', '/b.mp3']);
    });

    it('should return the paths chosen in the SoundFont dialog', async (): Promise<void> => {
      bridge.api['openSoundFontDialog'].mockResolvedValueOnce(['/fonts/piano.sf2']);

      await expect(service.openSoundFontDialog()).resolves.toEqual(['/fonts/piano.sf2']);
      expect(bridge.api['openSoundFontDialog']).toHaveBeenCalledWith();
    });

    it('should return the path chosen in the subtitle dialog', async (): Promise<void> => {
      bridge.api['openSubtitleDialog'].mockResolvedValueOnce('/subs/film.srt');

      await expect(service.openSubtitleDialog()).resolves.toBe('/subs/film.srt');
      expect(bridge.api['openSubtitleDialog']).toHaveBeenCalledWith();
    });

    it('should return null when the subtitle dialog is cancelled', async (): Promise<void> => {
      await expect(service.openSubtitleDialog()).resolves.toBeNull();
    });

    it('should return the path chosen in the open-playlist dialog', async (): Promise<void> => {
      bridge.api['openPlaylistDialog'].mockResolvedValueOnce('/lists/mine.opp');

      await expect(service.openPlaylistDialog()).resolves.toBe('/lists/mine.opp');
      expect(bridge.api['openPlaylistDialog']).toHaveBeenCalledWith();
    });

    it('should return the path chosen in the save-playlist dialog', async (): Promise<void> => {
      bridge.api['savePlaylistDialog'].mockResolvedValueOnce('/lists/new.opp');

      await expect(service.savePlaylistDialog()).resolves.toBe('/lists/new.opp');
      expect(bridge.api['savePlaylistDialog']).toHaveBeenCalledWith();
    });

    it('should pass the title and format to the save-media dialog and return the chosen path', async (): Promise<void> => {
      bridge.api['saveMediaDialog'].mockResolvedValueOnce('/downloads/Clip.mp3');

      await expect(service.saveMediaDialog('Clip', 'audio')).resolves.toBe('/downloads/Clip.mp3');
      expect(bridge.api['saveMediaDialog']).toHaveBeenCalledWith({title: 'Clip', format: 'audio'});
    });

    it('should resolve a dropped file to the path the bridge reports', (): void => {
      const file: File = new File(['content'], 'song.mp3');
      bridge.api['getPathForFile'].mockReturnValueOnce('/abs/song.mp3');

      expect(service.getPathForFile(file)).toBe('/abs/song.mp3');
      expect(bridge.api['getPathForFile']).toHaveBeenCalledWith(file);
    });

    it('should return the snapped position the bridge reports from setWindowPosition', async (): Promise<void> => {
      bridge.api['setWindowPosition'].mockResolvedValueOnce({x: 0, y: 40});

      await expect(service.setWindowPosition({x: 12, y: 40})).resolves.toEqual({x: 0, y: 40});
      expect(bridge.api['setWindowPosition']).toHaveBeenCalledWith({x: 12, y: 40});
    });

    it('should return the position the bridge reports from getWindowPosition', async (): Promise<void> => {
      bridge.api['getWindowPosition'].mockResolvedValueOnce({x: 150, y: 250});

      await expect(service.getWindowPosition()).resolves.toEqual({x: 150, y: 250});
    });

    it('should open the configuration window with no category when none is given', async (): Promise<void> => {
      await service.showConfigurationWindow();

      expect(bridge.api['showConfigurationWindow']).toHaveBeenCalledWith(undefined);
    });

    it('should enter fullscreen from toggleFullscreen while windowed', async (): Promise<void> => {
      await service.toggleFullscreen();

      expect(bridge.api['enterFullscreen']).toHaveBeenCalledTimes(1);
      expect(bridge.api['exitFullscreen']).not.toHaveBeenCalled();
    });

    it('should exit fullscreen from toggleFullscreen once the bridge has reported fullscreen', async (): Promise<void> => {
      fireBridge(bridge, 'onFullscreenChange', true);

      await service.toggleFullscreen();

      expect(bridge.api['exitFullscreen']).toHaveBeenCalledTimes(1);
      expect(bridge.api['enterFullscreen']).not.toHaveBeenCalled();
    });
  });

  describe('window and IPC methods outside Electron', (): void => {
    beforeEach((): void => {
      service = startOutsideElectron();
    });

    it.each(VOID_IPC_CASES)('should resolve $name to nothing without a bridge', async ({call}: VoidIpcCase): Promise<void> => {
      await expect(call(service)).resolves.toBeUndefined();
    });

    it('should resolve toggleFullscreen to nothing without a bridge', async (): Promise<void> => {
      await expect(service.toggleFullscreen()).resolves.toBeUndefined();
    });

    it('should return null from openSubtitleDialog without a bridge', async (): Promise<void> => {
      await expect(service.openSubtitleDialog()).resolves.toBeNull();
    });

    it('should return null from openPlaylistDialog without a bridge', async (): Promise<void> => {
      await expect(service.openPlaylistDialog()).resolves.toBeNull();
    });

    it('should return null from savePlaylistDialog without a bridge', async (): Promise<void> => {
      await expect(service.savePlaylistDialog()).resolves.toBeNull();
    });

    it('should return null from saveMediaDialog without a bridge', async (): Promise<void> => {
      await expect(service.saveMediaDialog('Clip', 'video')).resolves.toBeNull();
    });

    it('should hand back the same position object from setWindowPosition without a bridge', async (): Promise<void> => {
      const position: {x: number; y: number} = {x: 5, y: 6};

      await expect(service.setWindowPosition(position)).resolves.toBe(position);
    });
  });

  // ===========================================================================
  // Window state listeners
  // ===========================================================================

  describe('window state listeners', (): void => {
    beforeEach(async (): Promise<void> => {
      service = await startInElectron();
    });

    it('should mirror fullscreen changes into isFullscreen', (): void => {
      fireBridge(bridge, 'onFullscreenChange', true);
      const afterEnter: boolean = service.isFullscreen();
      fireBridge(bridge, 'onFullscreenChange', false);

      expect(afterEnter).toBe(true);
      expect(service.isFullscreen()).toBe(false);
    });

    it('should count each fullscreen transition start', (): void => {
      fireBridge(bridge, 'onFullscreenTransitionStart');
      fireBridge(bridge, 'onFullscreenTransitionStart');

      expect(service.fullscreenTransitionStart()).toBe(2);
      expect(service.fullscreenTransitionEnd()).toBe(0);
    });

    it('should count each fullscreen transition end', (): void => {
      fireBridge(bridge, 'onFullscreenTransitionEnd');

      expect(service.fullscreenTransitionEnd()).toBe(1);
      expect(service.fullscreenTransitionStart()).toBe(0);
    });

    it.each(['miniplayer', 'fullscreen', 'desktop'])('should mirror a change to %s into viewMode', (mode: string): void => {
      fireBridge(bridge, 'onViewModeChange', mode === 'desktop' ? 'miniplayer' : 'desktop');

      fireBridge(bridge, 'onViewModeChange', mode);

      expect(service.viewMode()).toBe(mode);
    });

    it('should report the settings window as closed until told otherwise', (): void => {
      expect(service.isConfigOpen()).toBe(false);
    });

    it('should mirror the settings window opening and closing into isConfigOpen', (): void => {
      fireBridge(bridge, 'onConfigOpenChange', true);
      const afterOpen: boolean = service.isConfigOpen();
      fireBridge(bridge, 'onConfigOpenChange', false);

      expect(afterOpen).toBe(true);
      expect(service.isConfigOpen()).toBe(false);
    });

    it('should count each request to leave configuration mode', (): void => {
      fireBridge(bridge, 'onExitConfigurationMode');
      fireBridge(bridge, 'onExitConfigurationMode');

      expect(service.exitConfigurationModeRequested()).toBe(2);
    });
  });

  // ===========================================================================
  // Prepare-for-close (audio fade-out)
  // ===========================================================================

  describe('prepare-for-close', (): void => {
    beforeEach(async (): Promise<void> => {
      service = await startInElectron();
      vi.useFakeTimers();
    });

    it('should publish the requested fade duration', (): void => {
      fireBridge(bridge, 'onPrepareForClose', 300);

      expect(service.fadeOutRequested()).toBe(300);
    });

    it('should not tell the main process the fade is complete before the duration has passed', (): void => {
      fireBridge(bridge, 'onPrepareForClose', 300);

      vi.advanceTimersByTime(299);

      expect(bridge.api['notifyFadeOutComplete']).not.toHaveBeenCalled();
    });

    it('should tell the main process the fade is complete once the duration has passed', (): void => {
      fireBridge(bridge, 'onPrepareForClose', 300);

      vi.advanceTimersByTime(300);

      expect(bridge.api['notifyFadeOutComplete']).toHaveBeenCalledTimes(1);
    });

    it('should restart the fade timer when a second close request arrives', (): void => {
      fireBridge(bridge, 'onPrepareForClose', 300);
      vi.advanceTimersByTime(200);

      fireBridge(bridge, 'onPrepareForClose', 300);
      vi.advanceTimersByTime(299);
      const notifiedEarly: number = bridge.api['notifyFadeOutComplete'].mock.calls.length;
      vi.advanceTimersByTime(1);

      expect(notifiedEarly).toBe(0);
      expect(bridge.api['notifyFadeOutComplete']).toHaveBeenCalledTimes(1);
    });

    it('should not notify the main process if the service is destroyed mid-fade', (): void => {
      fireBridge(bridge, 'onPrepareForClose', 300);

      service.ngOnDestroy();
      vi.advanceTimersByTime(1000);

      expect(bridge.api['notifyFadeOutComplete']).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Files opened from the OS
  // ===========================================================================

  describe('files opened from the OS', (): void => {
    beforeEach(async (): Promise<void> => {
      service = await startInElectron();
    });

    it('should add a media file opened from the OS and start playing it', async (): Promise<void> => {
      fetchMock.mockImplementation(async (url: string): Promise<Response> => {
        return url.endsWith('/playlist/add') ? jsonResponse({added: [createMockPlaylistItem({id: 'os-1'})]}) : jsonResponse({});
      });

      fireBridge(bridge, 'onOSOpenFile', '/from/finder.mp3');

      await settle((): void => {
        expect(requestLog(fetchMock)).toEqual([`POST ${SERVER}/playlist/add`, `POST ${SERVER}/playlist/select/os-1`]);
      });
      expect(requestAt(fetchMock, 0).init?.body).toBe(JSON.stringify({paths: ['/from/finder.mp3']}));
    });

    it('should load a playlist file opened from the OS', (): void => {
      fireBridge(bridge, 'onOSOpenPlaylist', '/from/finder.opp');

      expect(requestLog(fetchMock)).toEqual([`POST ${SERVER}/playlist/load`]);
      expect(requestAt(fetchMock, 0).init?.body).toBe(JSON.stringify({filePath: '/from/finder.opp'}));
    });
  });

  // ===========================================================================
  // Menu events
  // ===========================================================================

  describe('menu events', (): void => {
    beforeEach(async (): Promise<void> => {
      service = await startInElectron();
    });

    it.each(MENU_COUNTER_CASES)('should bump $signalName each time the $event menu event fires', ({event, read}: MenuCounterCase): void => {
      fireMenu(bridge, event);
      fireMenu(bridge, event);

      expect(read(service)).toBe(2);
    });

    it.each(MENU_COUNTER_CASES)('should send no request for the $event menu event', ({event}: MenuCounterCase): void => {
      fireMenu(bridge, event);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should start the remaining menu counters at zero', (): void => {
      expect(service.menuShowHelp()).toBe(0);
      expect(service.menuOpenPlaylist()).toBe(0);
      expect(service.menuSavePlaylist()).toBe(0);
      expect(service.menuSavePlaylistAs()).toBe(0);
    });

    it('should pause from the play/pause menu item while playing', (): void => {
      sse.emitJson('playback:state', {state: 'playing'});

      fireMenu(bridge, 'togglePlayPause');

      expect(requestLog(fetchMock)).toEqual([`POST ${SERVER}/player/pause`]);
    });

    it.each(['idle', 'paused', 'stopped', 'loading', 'error'])('should play from the play/pause menu item while %s', (state: string): void => {
      sse.emitJson('playback:state', {state});

      fireMenu(bridge, 'togglePlayPause');

      expect(requestLog(fetchMock)).toEqual([`POST ${SERVER}/player/play`]);
    });

    it('should stop playback from the stop menu item', (): void => {
      fireMenu(bridge, 'stop');

      expect(requestLog(fetchMock)).toEqual([`POST ${SERVER}/player/stop`]);
    });

    it('should enable shuffle from the menu when it is off', (): void => {
      fireMenu(bridge, 'toggleShuffle');

      expect(requestAt(fetchMock, 0).url).toBe(`${SERVER}/playlist/shuffle`);
      expect(requestAt(fetchMock, 0).init?.body).toBe(JSON.stringify({enabled: true}));
    });

    it('should disable shuffle from the menu when it is on', (): void => {
      sse.emitJson('playlist:mode', {shuffleEnabled: true, repeatEnabled: false});

      fireMenu(bridge, 'toggleShuffle');

      expect(requestAt(fetchMock, 0).url).toBe(`${SERVER}/playlist/shuffle`);
      expect(requestAt(fetchMock, 0).init?.body).toBe(JSON.stringify({enabled: false}));
    });

    it('should enable repeat from the menu when it is off', (): void => {
      fireMenu(bridge, 'toggleRepeat');

      expect(requestAt(fetchMock, 0).url).toBe(`${SERVER}/playlist/repeat`);
      expect(requestAt(fetchMock, 0).init?.body).toBe(JSON.stringify({enabled: true}));
    });

    it('should disable repeat from the menu when it is on', (): void => {
      sse.emitJson('playlist:mode', {shuffleEnabled: false, repeatEnabled: true});

      fireMenu(bridge, 'toggleRepeat');

      expect(requestAt(fetchMock, 0).url).toBe(`${SERVER}/playlist/repeat`);
      expect(requestAt(fetchMock, 0).init?.body).toBe(JSON.stringify({enabled: false}));
    });

    it('should publish the visualization chosen in the menu', (): void => {
      fireMenu(bridge, 'selectVisualization', 'spectrum');

      expect(service.menuSelectVisualization()).toBe('spectrum');
    });

    it('should ignore a visualization menu event without a string id', (): void => {
      fireMenu(bridge, 'selectVisualization', 'spectrum');

      fireMenu(bridge, 'selectVisualization', 42);
      fireMenu(bridge, 'selectVisualization');

      expect(service.menuSelectVisualization()).toBe('spectrum');
    });

    it('should publish the aspect mode chosen in the menu', (): void => {
      fireMenu(bridge, 'selectAspectMode', 'fill');

      expect(service.menuSelectAspectMode()).toBe('fill');
    });

    it('should ignore an aspect mode menu event without a string mode', (): void => {
      fireMenu(bridge, 'selectAspectMode', 'fill');

      fireMenu(bridge, 'selectAspectMode', {mode: 'fit'});

      expect(service.menuSelectAspectMode()).toBe('fill');
    });

    it('should do nothing for Close when no track is selected', (): void => {
      sse.emitJson('playlist:updated', playlistOf([createMockPlaylistItem({id: 'a'})], {currentIndex: -1}));

      fireMenu(bridge, 'closeMedia');

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should do nothing for Close when the playlist is empty', (): void => {
      sse.emitJson('playlist:updated', playlistOf([], {currentIndex: 0}));

      fireMenu(bridge, 'closeMedia');

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should do nothing for Close when the selected index is past the end of the playlist', async (): Promise<void> => {
      sse.emitJson('playlist:updated', playlistOf([createMockPlaylistItem({id: 'a'})], {currentIndex: 3}));

      fireMenu(bridge, 'closeMedia');
      await flushPromises();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(unhandled.reasons).toEqual([]);
    });

    it('should stop and then remove the current track for Close', async (): Promise<void> => {
      sse.emitJson('playlist:updated', playlistOf(
        [createMockPlaylistItem({id: 'a'}), createMockPlaylistItem({id: 'b'})],
        {currentIndex: 1},
      ));

      fireMenu(bridge, 'closeMedia');

      await settle((): void => {
        expect(requestLog(fetchMock)).toEqual([`POST ${SERVER}/player/stop`, `DELETE ${SERVER}/playlist/remove/b`]);
      });
    });

    it('should stop and then clear the playlist for Close All', async (): Promise<void> => {
      fireMenu(bridge, 'closeAll');

      await settle((): void => {
        expect(requestLog(fetchMock)).toEqual([`POST ${SERVER}/player/stop`, `DELETE ${SERVER}/playlist/clear`]);
      });
    });

    it('should log and leave the playlist alone when Close All cannot stop playback', async (): Promise<void> => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 500, 'Internal Server Error'));

      fireMenu(bridge, 'closeAll');

      await settle((): void => {
        expect(errorSpy).toHaveBeenCalledWith('[ElectronService] Close all failed:', new Error('HTTP 500: Internal Server Error'));
      });
      expect(requestLog(fetchMock)).toEqual([`POST ${SERVER}/player/stop`]);
    });

    it('should log when Close All cannot clear the playlist', async (): Promise<void> => {
      const failure: TypeError = new TypeError('Failed to fetch');
      fetchMock.mockImplementation(async (url: string): Promise<Response> => {
        if (url.endsWith('/playlist/clear')) throw failure;
        return jsonResponse({});
      });

      fireMenu(bridge, 'closeAll');

      await settle((): void => {
        expect(errorSpy).toHaveBeenCalledWith('[ElectronService] Close all failed:', failure);
      });
    });

    it('should add a recent file chosen in the menu and start playing it', async (): Promise<void> => {
      fetchMock.mockImplementation(async (url: string): Promise<Response> => {
        return url.endsWith('/playlist/add') ? jsonResponse({added: [createMockPlaylistItem({id: 'recent-1'})]}) : jsonResponse({});
      });

      fireMenu(bridge, 'openRecentFile', '/recent/song.mp3');

      await settle((): void => {
        expect(requestLog(fetchMock)).toEqual([`POST ${SERVER}/playlist/add`, `POST ${SERVER}/playlist/select/recent-1`]);
      });
      expect(requestAt(fetchMock, 0).init?.body).toBe(JSON.stringify({paths: ['/recent/song.mp3']}));
    });

    it('should ignore a recent-file menu event without a string path', (): void => {
      fireMenu(bridge, 'openRecentFile', undefined);
      fireMenu(bridge, 'openRecentFile', ['/recent/song.mp3']);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should load a recent playlist chosen in the menu', (): void => {
      fireMenu(bridge, 'openRecentPlaylist', '/recent/list.opp');

      expect(requestLog(fetchMock)).toEqual([`POST ${SERVER}/playlist/load`]);
      expect(requestAt(fetchMock, 0).init?.body).toBe(JSON.stringify({filePath: '/recent/list.opp'}));
    });

    it('should ignore a recent-playlist menu event without a string path', (): void => {
      fireMenu(bridge, 'openRecentPlaylist', null);

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Commands nobody awaits
  // ===========================================================================

  describe('background commands', (): void => {
    const failure: TypeError = new TypeError('Failed to fetch');

    beforeEach(async (): Promise<void> => {
      service = await startInElectron();
      fetchMock.mockRejectedValue(failure);
    });

    it.each(BACKGROUND_COMMAND_CASES)('should log when the request for $name fails', async ({logged, trigger}: BackgroundCommandCase): Promise<void> => {
      trigger(bridge, sse);

      await settle((): void => {
        expect(errorSpy).toHaveBeenCalledWith(`[ElectronService] ${logged}`, failure);
      });
    });

    it.each(BACKGROUND_COMMAND_CASES)('should leave no unhandled rejection when the request for $name fails', async ({trigger}: BackgroundCommandCase): Promise<void> => {
      trigger(bridge, sse);
      await flushPromises();

      expect(unhandled.reasons).toEqual([]);
    });
  });

  // ===========================================================================
  // Server-sent events
  // ===========================================================================

  describe('server-sent events', (): void => {
    const trackA: PlaylistItem = createMockPlaylistItem({id: 'a', filePath: '/a.mp3', title: 'A', duration: 10});
    const trackB: PlaylistItem = createMockPlaylistItem({id: 'b', filePath: '/b.mp3', title: 'B', duration: 20});
    const trackC: PlaylistItem = createMockPlaylistItem({id: 'c', filePath: '/c.mp3', title: 'C', duration: 30});

    beforeEach(async (): Promise<void> => {
      service = await startInElectron();
    });

    // -------------------------------------------------------------------------
    // Playback
    // -------------------------------------------------------------------------

    it('should publish the playback state', (): void => {
      sse.emitJson('playback:state', {state: 'playing'});

      expect(service.playbackState()).toBe('playing');
      expect(service.errorMessage()).toBeNull();
    });

    it('should publish the error message that accompanies a playback state', (): void => {
      sse.emitJson('playback:state', {state: 'error', errorMessage: 'Decoder failed'});

      expect(service.playbackState()).toBe('error');
      expect(service.errorMessage()).toBe('Decoder failed');
    });

    it('should clear the error message on the next playback state without one', (): void => {
      sse.emitJson('playback:state', {state: 'error', errorMessage: 'Decoder failed'});

      sse.emitJson('playback:state', {state: 'playing'});

      expect(service.errorMessage()).toBeNull();
    });

    it('should treat an empty error message as no error', (): void => {
      sse.emitJson('playback:state', {state: 'error', errorMessage: ''});

      expect(service.errorMessage()).toBeNull();
    });

    it('should fall back to idle and log when a playback state payload is malformed', (): void => {
      sse.emitJson('playback:state', {state: 'error', errorMessage: 'Decoder failed'});

      sse.emit('playback:state', '{not json');

      expect(service.playbackState()).toBe('idle');
      expect(service.errorMessage()).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith('Failed to parse SSE JSON:', expect.any(SyntaxError), 'Data:', '{not json');
    });

    it('should log only the first 100 characters of a malformed payload', (): void => {
      const payload: string = `{${'x'.repeat(300)}`;

      sse.emit('playback:state', payload);

      expect(errorSpy).toHaveBeenCalledWith('Failed to parse SSE JSON:', expect.any(SyntaxError), 'Data:', payload.substring(0, 100));
    });

    it('should fall back to idle without logging when a playback state payload is JSON null', (): void => {
      sse.emitJson('playback:state', {state: 'playing'});

      sse.emit('playback:state', 'null');

      expect(service.playbackState()).toBe('idle');
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('should publish the playback position and duration', (): void => {
      sse.emitJson('playback:time', {currentTime: 12.5, duration: 240});

      expect(service.currentTime()).toBe(12.5);
      expect(service.duration()).toBe(240);
    });

    it('should reset the position and duration to zero when a time payload is malformed', (): void => {
      sse.emitJson('playback:time', {currentTime: 12.5, duration: 240});

      sse.emit('playback:time', 'garbage');

      expect(service.currentTime()).toBe(0);
      expect(service.duration()).toBe(0);
    });

    it('should publish newly loaded media and its duration', (): void => {
      const media: MediaInfo = {duration: 95, type: 'video', title: 'Film', filePath: '/film.mkv'};

      sse.emitJson('playback:loaded', media);

      expect(service.currentMedia()).toEqual(media);
      expect(service.duration()).toBe(95);
    });

    it('should keep the current media when a loaded payload is malformed', (): void => {
      const media: MediaInfo = {duration: 95, type: 'video', title: 'Film', filePath: '/film.mkv'};
      sse.emitJson('playback:loaded', media);

      sse.emit('playback:loaded', '<<<');

      expect(service.currentMedia()).toEqual(media);
      expect(service.duration()).toBe(95);
    });

    it('should keep the current media when a loaded payload is JSON null', (): void => {
      const media: MediaInfo = {duration: 95, type: 'video', title: 'Film', filePath: '/film.mkv'};
      sse.emitJson('playback:loaded', media);

      sse.emit('playback:loaded', 'null');

      expect(service.currentMedia()).toEqual(media);
    });

    it('should publish the volume and mute state', (): void => {
      sse.emitJson('playback:volume', {volume: 0.35, muted: true});

      expect(service.volume()).toBe(0.35);
      expect(service.muted()).toBe(true);
    });

    it('should reset to full unmuted volume when a volume payload is malformed', (): void => {
      sse.emitJson('playback:volume', {volume: 0.35, muted: true});

      sse.emit('playback:volume', '');

      expect(service.volume()).toBe(1);
      expect(service.muted()).toBe(false);
    });

    it('should start with no seek alignment', (): void => {
      expect(service.seekAlignment()).toBeNull();
    });

    it('should publish a seek alignment', (): void => {
      sse.emitJson('playback:seek:aligned', {requested: 61.5, actual: 60});

      expect(service.seekAlignment()).toEqual({requested: 61.5, actual: 60});
    });

    it.each([
      ['a non-numeric requested position', '{"requested":"61.5","actual":60}'],
      ['a missing actual position', '{"requested":61.5}'],
      ['JSON null', 'null'],
      ['malformed JSON', '{requested'],
    ])('should keep the previous seek alignment when the payload has %s', (_description: string, payload: string): void => {
      sse.emitJson('playback:seek:aligned', {requested: 61.5, actual: 60});

      sse.emit('playback:seek:aligned', payload);

      expect(service.seekAlignment()).toEqual({requested: 61.5, actual: 60});
    });

    it('should raise mediaEnded when playback ends', (): void => {
      vi.useFakeTimers();

      sse.emit('playback:ended');

      expect(service.mediaEnded()).toBe(true);
    });

    it('should keep mediaEnded raised for just under 100ms', (): void => {
      vi.useFakeTimers();
      sse.emit('playback:ended');

      vi.advanceTimersByTime(99);

      expect(service.mediaEnded()).toBe(true);
    });

    it('should lower mediaEnded 100ms after playback ends', (): void => {
      vi.useFakeTimers();
      sse.emit('playback:ended');

      vi.advanceTimersByTime(100);

      expect(service.mediaEnded()).toBe(false);
    });

    it('should hold mediaEnded for a further 100ms when a second track ends during the pulse', (): void => {
      vi.useFakeTimers();
      sse.emit('playback:ended');
      vi.advanceTimersByTime(60);

      sse.emit('playback:ended');
      vi.advanceTimersByTime(99);
      const stillRaised: boolean = service.mediaEnded();
      vi.advanceTimersByTime(1);

      expect(stillRaised).toBe(true);
      expect(service.mediaEnded()).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Playlist
    // -------------------------------------------------------------------------

    it('should replace the playlist with a full update', (): void => {
      const state: PlaylistState = playlistOf([trackA, trackB], {currentIndex: 1, shuffleEnabled: true, repeatEnabled: true});

      sse.emitJson('playlist:updated', state);

      expect(service.playlist()).toEqual(state);
    });

    it('should empty the playlist when a full update payload is malformed', (): void => {
      sse.emitJson('playlist:updated', playlistOf([trackA], {currentIndex: 0, shuffleEnabled: true, repeatEnabled: true}));

      sse.emit('playlist:updated', '[oops');

      expect(service.playlist()).toEqual({items: [], currentIndex: -1, shuffleEnabled: false, repeatEnabled: false});
    });

    it('should move the current index on a selection event', (): void => {
      sse.emitJson('playlist:updated', playlistOf([trackA, trackB], {currentIndex: 0}));

      sse.emitJson('playlist:selection', {currentIndex: 1});

      expect(service.playlist()).toEqual(playlistOf([trackA, trackB], {currentIndex: 1}));
    });

    it('should publish the selected item as the current media', (): void => {
      sse.emitJson('playlist:selection', {currentIndex: 1, currentItem: trackB});

      expect(service.currentMedia()).toEqual(trackB);
    });

    it('should keep the current media when a selection event names no item', (): void => {
      sse.emitJson('playlist:selection', {currentIndex: 1, currentItem: trackB});

      sse.emitJson('playlist:selection', {currentIndex: -1});

      expect(service.currentMedia()).toEqual(trackB);
      expect(service.playlist().currentIndex).toBe(-1);
    });

    it('should deselect the current track but keep the items when a selection payload is malformed', (): void => {
      sse.emitJson('playlist:updated', playlistOf([trackA, trackB], {currentIndex: 1}));

      sse.emit('playlist:selection', '}{');

      expect(service.playlist()).toEqual(playlistOf([trackA, trackB], {currentIndex: -1}));
    });

    it('should publish shuffle and repeat modes without touching the items', (): void => {
      sse.emitJson('playlist:updated', playlistOf([trackA], {currentIndex: 0}));

      sse.emitJson('playlist:mode', {shuffleEnabled: true, repeatEnabled: true});

      expect(service.playlist()).toEqual(playlistOf([trackA], {currentIndex: 0, shuffleEnabled: true, repeatEnabled: true}));
    });

    it('should switch shuffle and repeat off when a mode payload is malformed', (): void => {
      sse.emitJson('playlist:mode', {shuffleEnabled: true, repeatEnabled: true});

      sse.emit('playlist:mode', 'nope');

      expect(service.playlist().shuffleEnabled).toBe(false);
      expect(service.playlist().repeatEnabled).toBe(false);
    });

    it('should append added items and adopt the reported current index', (): void => {
      sse.emitJson('playlist:updated', playlistOf([trackA], {currentIndex: 0, repeatEnabled: true}));

      sse.emitJson('playlist:items:added', {items: [trackB, trackC], startIndex: 1, currentIndex: 2});

      expect(service.playlist()).toEqual(playlistOf([trackA, trackB, trackC], {currentIndex: 2, repeatEnabled: true}));
    });

    it('should append added items at the end whatever start index is reported', (): void => {
      sse.emitJson('playlist:updated', playlistOf([trackA, trackB], {currentIndex: 0}));

      sse.emitJson('playlist:items:added', {items: [trackC], startIndex: 0, currentIndex: 0});

      expect(service.playlist().items).toEqual([trackA, trackB, trackC]);
    });

    it('should keep the items but deselect when an items-added payload is malformed', (): void => {
      sse.emitJson('playlist:updated', playlistOf([trackA], {currentIndex: 0}));

      sse.emit('playlist:items:added', 'x');

      expect(service.playlist()).toEqual(playlistOf([trackA], {currentIndex: -1}));
    });

    it('should drop a removed item and adopt the reported current index', (): void => {
      sse.emitJson('playlist:updated', playlistOf([trackA, trackB, trackC], {currentIndex: 2}));

      sse.emitJson('playlist:items:removed', {id: 'b', removedIndex: 1, currentIndex: 1});

      expect(service.playlist()).toEqual(playlistOf([trackA, trackC], {currentIndex: 1}));
    });

    it('should keep every item when the removed id is unknown', (): void => {
      sse.emitJson('playlist:updated', playlistOf([trackA, trackB], {currentIndex: 0}));

      sse.emitJson('playlist:items:removed', {id: 'zzz', removedIndex: 5, currentIndex: 0});

      expect(service.playlist().items).toEqual([trackA, trackB]);
    });

    it('should keep the items but deselect when an items-removed payload is malformed', (): void => {
      sse.emitJson('playlist:updated', playlistOf([trackA, trackB], {currentIndex: 1}));

      sse.emit('playlist:items:removed', 'x');

      expect(service.playlist()).toEqual(playlistOf([trackA, trackB], {currentIndex: -1}));
    });

    it('should empty the items and deselect on a cleared event while keeping the modes', (): void => {
      sse.emitJson('playlist:updated', playlistOf([trackA, trackB], {currentIndex: 1, shuffleEnabled: true, repeatEnabled: true}));

      sse.emit('playlist:cleared');

      expect(service.playlist()).toEqual(playlistOf([], {currentIndex: -1, shuffleEnabled: true, repeatEnabled: true}));
    });

    // -------------------------------------------------------------------------
    // Batched duration updates
    // -------------------------------------------------------------------------

    describe('playlist item durations', (): void => {
      beforeEach((): void => {
        sse.emitJson('playlist:updated', playlistOf([trackA, trackB, trackC], {currentIndex: 0}));
        vi.useFakeTimers();
      });

      it('should not apply a reported duration straight away', (): void => {
        const before: PlaylistState = service.playlist();

        sse.emitJson('playlist:items:duration', {filePath: '/a.mp3', duration: 111});
        vi.advanceTimersByTime(99);

        expect(service.playlist()).toBe(before);
      });

      it('should apply a reported duration 100ms after it arrives', (): void => {
        sse.emitJson('playlist:items:duration', {filePath: '/a.mp3', duration: 111});

        vi.advanceTimersByTime(100);

        expect(service.playlist().items.map((item: PlaylistItem): number => item.duration)).toEqual([111, 20, 30]);
      });

      it('should apply every duration gathered in the window together, 100ms after the first', (): void => {
        sse.emitJson('playlist:items:duration', {filePath: '/a.mp3', duration: 111});
        vi.advanceTimersByTime(60);
        sse.emitJson('playlist:items:duration', {filePath: '/c.mp3', duration: 333});
        const beforeFlush: number[] = service.playlist().items.map((item: PlaylistItem): number => item.duration);

        vi.advanceTimersByTime(40);

        expect(beforeFlush).toEqual([10, 20, 30]);
        expect(service.playlist().items.map((item: PlaylistItem): number => item.duration)).toEqual([111, 20, 333]);
      });

      it('should change the playlist only once for a burst of durations', (): void => {
        sse.emitJson('playlist:items:duration', {filePath: '/a.mp3', duration: 111});
        sse.emitJson('playlist:items:duration', {filePath: '/b.mp3', duration: 222});
        vi.advanceTimersByTime(100);
        const afterFlush: PlaylistState = service.playlist();

        vi.advanceTimersByTime(1000);

        expect(service.playlist()).toBe(afterFlush);
      });

      it('should keep the last duration reported for a file within one window', (): void => {
        sse.emitJson('playlist:items:duration', {filePath: '/b.mp3', duration: 1});
        sse.emitJson('playlist:items:duration', {filePath: '/b.mp3', duration: 2});

        vi.advanceTimersByTime(100);

        expect(service.playlist().items[1].duration).toBe(2);
      });

      it('should change only the duration of a matching item', (): void => {
        sse.emitJson('playlist:items:duration', {filePath: '/b.mp3', duration: 222});

        vi.advanceTimersByTime(100);

        expect(service.playlist().items[1]).toEqual({...trackB, duration: 222});
      });

      it('should leave items untouched when the reported file is not in the playlist', (): void => {
        const untouched: PlaylistItem = service.playlist().items[0];

        sse.emitJson('playlist:items:duration', {filePath: '/elsewhere.mp3', duration: 999});
        vi.advanceTimersByTime(100);

        expect(service.playlist().items[0]).toBe(untouched);
        expect(service.playlist().items.map((item: PlaylistItem): number => item.duration)).toEqual([10, 20, 30]);
      });

      it('should apply a duration to every item that shares the file path', (): void => {
        const duplicate: PlaylistItem = {...trackA, id: 'a-again'};
        vi.useRealTimers();
        sse.emitJson('playlist:updated', playlistOf([trackA, duplicate]));
        vi.useFakeTimers();

        sse.emitJson('playlist:items:duration', {filePath: '/a.mp3', duration: 77});
        vi.advanceTimersByTime(100);

        expect(service.playlist().items.map((item: PlaylistItem): number => item.duration)).toEqual([77, 77]);
      });

      it('should apply durations to items added while the window is open', (): void => {
        const late: PlaylistItem = createMockPlaylistItem({id: 'd', filePath: '/d.mp3', duration: 0});
        sse.emitJson('playlist:items:duration', {filePath: '/d.mp3', duration: 444});

        sse.emitJson('playlist:items:added', {items: [late], startIndex: 3, currentIndex: 0});
        vi.advanceTimersByTime(100);

        expect(service.playlist().items[3]).toEqual({...late, duration: 444});
      });

      it('should not apply durations still waiting when the service is destroyed', (): void => {
        const before: PlaylistState = service.playlist();
        sse.emitJson('playlist:items:duration', {filePath: '/a.mp3', duration: 111});

        service.ngOnDestroy();
        vi.advanceTimersByTime(1000);

        expect(service.playlist()).toBe(before);
      });

      it('should start a fresh window for durations that arrive after a flush', (): void => {
        sse.emitJson('playlist:items:duration', {filePath: '/a.mp3', duration: 111});
        vi.advanceTimersByTime(100);

        sse.emitJson('playlist:items:duration', {filePath: '/b.mp3', duration: 222});
        vi.advanceTimersByTime(100);

        expect(service.playlist().items.map((item: PlaylistItem): number => item.duration)).toEqual([111, 222, 30]);
      });

      it.each([
        ['an empty file path', '{"filePath":"","duration":5}'],
        ['no file path', '{"duration":5}'],
        ['JSON null', 'null'],
        ['malformed JSON', '{filePath'],
      ])('should ignore a duration event with %s', (_description: string, payload: string): void => {
        const before: PlaylistState = service.playlist();

        sse.emit('playlist:items:duration', payload);
        vi.advanceTimersByTime(1000);

        expect(service.playlist()).toBe(before);
      });
    });

    // -------------------------------------------------------------------------
    // Settings and dependency subscriptions
    // -------------------------------------------------------------------------

    it('should deliver a settings update to every subscriber', (): void => {
      const settings: AppSettings = {marker: 'settings-1'} as unknown as AppSettings;
      const first: Subscriber = vi.fn<(value: unknown) => void>();
      const second: Subscriber = vi.fn<(value: unknown) => void>();
      service.onSettingsUpdate(first);
      service.onSettingsUpdate(second);

      sse.emitJson('settings:updated', settings);

      expect(first).toHaveBeenCalledTimes(1);
      expect(first).toHaveBeenCalledWith(settings);
      expect(second).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledWith(settings);
    });

    it('should stop delivering settings updates after unsubscribing', (): void => {
      const removed: Subscriber = vi.fn<(value: unknown) => void>();
      const kept: Subscriber = vi.fn<(value: unknown) => void>();
      const unsubscribe: () => void = service.onSettingsUpdate(removed);
      service.onSettingsUpdate(kept);

      unsubscribe();
      sse.emitJson('settings:updated', {marker: 'settings-1'});

      expect(removed).not.toHaveBeenCalled();
      expect(kept).toHaveBeenCalledTimes(1);
    });

    it('should keep delivering to the other subscribers when one throws, and log the failure', (): void => {
      const failure: Error = new Error('subscriber blew up');
      const second: Subscriber = vi.fn<(value: unknown) => void>();
      service.onSettingsUpdate((): void => {
        throw failure;
      });
      service.onSettingsUpdate(second);

      expect((): void => sse.emitJson('settings:updated', {marker: 'settings-1'})).not.toThrow();

      expect(second).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith('[ElectronService] SSE subscriber failed:', failure);
    });

    it('should still deliver the current event to a subscriber that another one removes mid-dispatch', (): void => {
      const second: Subscriber = vi.fn<(value: unknown) => void>();
      let unsubscribeSecond: () => void = (): void => {};
      service.onSettingsUpdate((): void => unsubscribeSecond());
      unsubscribeSecond = service.onSettingsUpdate(second);

      sse.emitJson('settings:updated', {marker: 'settings-1'});
      sse.emitJson('settings:updated', {marker: 'settings-2'});

      expect(second).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledWith({marker: 'settings-1'});
    });

    it('should deliver to a callback once per registration when it is registered twice', (): void => {
      const callback: Subscriber = vi.fn<(value: unknown) => void>();
      const unsubscribeFirst: () => void = service.onSettingsUpdate(callback);
      service.onSettingsUpdate(callback);

      sse.emitJson('settings:updated', {marker: 'settings-1'});
      unsubscribeFirst();
      sse.emitJson('settings:updated', {marker: 'settings-2'});

      expect(callback).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['malformed JSON', '{settings'],
      ['JSON null', 'null'],
    ])('should not notify settings subscribers when the payload is %s', (_description: string, payload: string): void => {
      const callback: Subscriber = vi.fn<(value: unknown) => void>();
      service.onSettingsUpdate(callback);

      sse.emit('settings:updated', payload);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should deliver a dependency state update to its subscribers only', (): void => {
      const stateCallback: Subscriber = vi.fn<(value: unknown) => void>();
      const progressCallback: Subscriber = vi.fn<(value: unknown) => void>();
      const settingsCallback: Subscriber = vi.fn<(value: unknown) => void>();
      service.onDependencyStateUpdate(stateCallback);
      service.onDependencyProgressUpdate(progressCallback);
      service.onSettingsUpdate(settingsCallback);

      sse.emitJson('dependencies:state', {ffmpeg: {installed: true}});

      expect(stateCallback).toHaveBeenCalledTimes(1);
      expect(stateCallback).toHaveBeenCalledWith({ffmpeg: {installed: true}});
      expect(progressCallback).not.toHaveBeenCalled();
      expect(settingsCallback).not.toHaveBeenCalled();
    });

    it('should stop delivering dependency state updates after unsubscribing', (): void => {
      const callback: Subscriber = vi.fn<(value: unknown) => void>();
      const unsubscribe: () => void = service.onDependencyStateUpdate(callback);

      unsubscribe();
      sse.emitJson('dependencies:state', {ffmpeg: {installed: true}});

      expect(callback).not.toHaveBeenCalled();
    });

    it('should deliver dependency install progress to its subscribers only', (): void => {
      const stateCallback: Subscriber = vi.fn<(value: unknown) => void>();
      const progressCallback: Subscriber = vi.fn<(value: unknown) => void>();
      service.onDependencyStateUpdate(stateCallback);
      service.onDependencyProgressUpdate(progressCallback);

      sse.emitJson('dependencies:progress', {id: 'ffmpeg', percent: 40});

      expect(progressCallback).toHaveBeenCalledTimes(1);
      expect(progressCallback).toHaveBeenCalledWith({id: 'ffmpeg', percent: 40});
      expect(stateCallback).not.toHaveBeenCalled();
    });

    it('should stop delivering dependency progress after unsubscribing', (): void => {
      const callback: Subscriber = vi.fn<(value: unknown) => void>();
      const unsubscribe: () => void = service.onDependencyProgressUpdate(callback);

      unsubscribe();
      sse.emitJson('dependencies:progress', {id: 'ffmpeg', percent: 40});

      expect(callback).not.toHaveBeenCalled();
    });

    it.each([
      ['dependencies:state', 'malformed JSON', '{deps'],
      ['dependencies:state', 'JSON null', 'null'],
      ['dependencies:state', 'a falsy JSON value', '0'],
      ['dependencies:progress', 'malformed JSON', '{deps'],
      ['dependencies:progress', 'JSON null', 'null'],
      ['dependencies:progress', 'a falsy JSON value', 'false'],
    ])('should not notify %s subscribers when the payload is %s', (event: string, _description: string, payload: string): void => {
      const stateCallback: Subscriber = vi.fn<(value: unknown) => void>();
      const progressCallback: Subscriber = vi.fn<(value: unknown) => void>();
      service.onDependencyStateUpdate(stateCallback);
      service.onDependencyProgressUpdate(progressCallback);

      sse.emit(event, payload);

      expect(stateCallback).not.toHaveBeenCalled();
      expect(progressCallback).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // URL downloads
    // -------------------------------------------------------------------------

    it('should start with no download job', (): void => {
      expect(service.downloadJob()).toBeNull();
    });

    it('should publish download progress without touching the playlist', (): void => {
      const job: DownloadJob = createJob({progress: 0.25});

      sse.emitJson('download:progress', job);

      expect(service.downloadJob()).toEqual(job);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should publish a failed download without touching the playlist', (): void => {
      const job: DownloadJob = createJob({status: 'error', errorMessage: 'Network unreachable'});

      sse.emitJson('download:error', job);

      expect(service.downloadJob()).toEqual(job);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should publish a completed download', (): void => {
      const job: DownloadJob = createJob({status: 'done', progress: 1, filePath: '/downloads/Clip.mp4'});
      fetchMock.mockImplementation(async (): Promise<Response> => jsonResponse({added: []}));

      sse.emitJson('download:complete', job);

      expect(service.downloadJob()).toEqual(job);
    });

    it('should add a completed download to the playlist and start playing it', async (): Promise<void> => {
      fetchMock.mockImplementation(async (url: string): Promise<Response> => {
        return url.endsWith('/playlist/add') ? jsonResponse({added: [createMockPlaylistItem({id: 'dl-1'})]}) : jsonResponse({});
      });

      sse.emitJson('download:complete', createJob({status: 'done', progress: 1, filePath: '/downloads/Clip.mp4'}));

      await settle((): void => {
        expect(requestLog(fetchMock)).toEqual([`POST ${SERVER}/playlist/add`, `POST ${SERVER}/playlist/select/dl-1`]);
      });
      expect(requestAt(fetchMock, 0).init?.body).toBe(JSON.stringify({paths: ['/downloads/Clip.mp4']}));
    });

    it('should add nothing when a completed download reports no file', (): void => {
      sse.emitJson('download:complete', createJob({status: 'done', progress: 1, filePath: null}));

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['download:progress', '{job'],
      ['download:progress', 'null'],
      ['download:complete', '{job'],
      ['download:complete', 'null'],
      ['download:error', '{job'],
      ['download:error', 'null'],
    ])('should keep the previous download job when a %s payload is %s', (event: string, payload: string): void => {
      const job: DownloadJob = createJob({progress: 0.25});
      sse.emitJson('download:progress', job);

      sse.emit(event, payload);

      expect(service.downloadJob()).toEqual(job);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // SoundFont changes
    // -------------------------------------------------------------------------

    it('should start the force-reload counter at zero', (): void => {
      expect(service.forceReloadCounter()).toBe(0);
    });

    it('should bump the force-reload counter and restart playback when a SoundFont change asks for a restart', (): void => {
      sse.emitJson('soundfont:changed', {restart: true, filePath: '/song.mid'});

      expect(service.forceReloadCounter()).toBe(1);
      expect(requestLog(fetchMock)).toEqual([`POST ${SERVER}/player/play`]);
    });

    it('should bump the force-reload counter without restarting when no restart is asked for', (): void => {
      sse.emitJson('soundfont:changed', {restart: false});

      expect(service.forceReloadCounter()).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should bump the force-reload counter without restarting when a SoundFont payload is malformed', (): void => {
      sse.emit('soundfont:changed', '{restart');

      expect(service.forceReloadCounter()).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Secondary windows (?window=...)
  // ===========================================================================

  describe('in a secondary window', (): void => {
    let originalUrl: string;

    beforeEach(async (): Promise<void> => {
      originalUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.history.replaceState(null, '', `${window.location.pathname}?window=open-url`);
      service = await startInElectron();
    });

    afterEach((): void => {
      window.history.replaceState(null, '', originalUrl);
    });

    it('should publish a completed download', (): void => {
      const job: DownloadJob = createJob({status: 'done', progress: 1, filePath: '/downloads/Clip.mp4'});

      sse.emitJson('download:complete', job);

      expect(service.downloadJob()).toEqual(job);
    });

    it('should leave adding a completed download to the main window', (): void => {
      sse.emitJson('download:complete', createJob({status: 'done', progress: 1, filePath: '/downloads/Clip.mp4'}));

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Streaming-busy state
  // ===========================================================================

  describe('setStreamingBusy', (): void => {
    beforeEach((): void => {
      service = startOutsideElectron();
      vi.useFakeTimers();
    });

    it('should start not busy', (): void => {
      expect(service.streamingBusy()).toBe(false);
    });

    it('should publish the busy state', (): void => {
      service.setStreamingBusy(true);

      expect(service.streamingBusy()).toBe(true);
    });

    it('should stay busy for just under 20 seconds', (): void => {
      service.setStreamingBusy(true);

      vi.advanceTimersByTime(19999);

      expect(service.streamingBusy()).toBe(true);
    });

    it('should clear the busy state by itself after 20 seconds', (): void => {
      service.setStreamingBusy(true);

      vi.advanceTimersByTime(20000);

      expect(service.streamingBusy()).toBe(false);
    });

    it('should clear the busy state immediately when told it is no longer busy', (): void => {
      service.setStreamingBusy(true);

      service.setStreamingBusy(false);

      expect(service.streamingBusy()).toBe(false);
    });

    it('should restart the 20 second safety timeout each time it is set busy', (): void => {
      service.setStreamingBusy(true);
      vi.advanceTimersByTime(15000);

      service.setStreamingBusy(true);
      vi.advanceTimersByTime(19999);
      const stillBusy: boolean = service.streamingBusy();
      vi.advanceTimersByTime(1);

      expect(stillBusy).toBe(true);
      expect(service.streamingBusy()).toBe(false);
    });

    it('should not let a cancelled safety timeout clear a later busy state', (): void => {
      service.setStreamingBusy(true);
      vi.advanceTimersByTime(15000);
      service.setStreamingBusy(false);

      service.setStreamingBusy(true);
      vi.advanceTimersByTime(6000);

      expect(service.streamingBusy()).toBe(true);
    });

    it('should cancel the safety timeout when the service is destroyed', (): void => {
      service.setStreamingBusy(true);

      service.ngOnDestroy();
      vi.advanceTimersByTime(60000);

      expect(service.streamingBusy()).toBe(true);
    });
  });

  // ===========================================================================
  // Track selection cache
  // ===========================================================================

  describe('track selection cache', (): void => {
    beforeEach((): void => {
      service = startOutsideElectron();
    });

    it('should report no subtitle selection for a file that has none', (): void => {
      expect(service.getSubtitleSelection('/film.mkv')).toBeUndefined();
    });

    it('should remember a subtitle selection per file', (): void => {
      service.setSubtitleSelection('/film.mkv', 2);
      service.setSubtitleSelection('/other.mkv', -1);

      expect(service.getSubtitleSelection('/film.mkv')).toBe(2);
      expect(service.getSubtitleSelection('/other.mkv')).toBe(-1);
    });

    it('should forget a cleared subtitle selection', (): void => {
      service.setSubtitleSelection('/film.mkv', 2);

      service.clearSubtitleSelection('/film.mkv');

      expect(service.getSubtitleSelection('/film.mkv')).toBeUndefined();
    });

    it('should report no audio selection for a file that has none', (): void => {
      expect(service.getAudioSelection('/film.mkv')).toBeUndefined();
    });

    it('should remember an audio selection per file', (): void => {
      service.setAudioSelection('/film.mkv', 1);
      service.setAudioSelection('/other.mkv', 0);

      expect(service.getAudioSelection('/film.mkv')).toBe(1);
      expect(service.getAudioSelection('/other.mkv')).toBe(0);
    });

    it('should forget a cleared audio selection', (): void => {
      service.setAudioSelection('/film.mkv', 1);

      service.clearAudioSelection('/film.mkv');

      expect(service.getAudioSelection('/film.mkv')).toBeUndefined();
    });

    it('should keep subtitle and audio selections for the same file apart', (): void => {
      service.setSubtitleSelection('/film.mkv', 3);
      service.setAudioSelection('/film.mkv', 1);

      service.clearSubtitleSelection('/film.mkv');

      expect(service.getSubtitleSelection('/film.mkv')).toBeUndefined();
      expect(service.getAudioSelection('/film.mkv')).toBe(1);
    });
  });

  // ===========================================================================
  // Teardown
  // ===========================================================================

  describe('ngOnDestroy', (): void => {
    beforeEach(async (): Promise<void> => {
      service = await startInElectron();
    });

    it('should disconnect the SSE client', (): void => {
      service.ngOnDestroy();

      expect(sse.client.disconnect).toHaveBeenCalledTimes(1);
    });

    it.each(BRIDGE_LISTENER_NAMES)('should remove the listener registered through %s', (name: string): void => {
      service.ngOnDestroy();

      expect(bridge.cleanups.get(name)).toHaveBeenCalledTimes(1);
    });

    it.each(MENU_EVENT_NAMES)('should remove the %s menu listener', (name: string): void => {
      service.ngOnDestroy();

      expect(bridge.menuCleanups.get(name)).toHaveBeenCalledTimes(1);
    });

    it('should not remove any listener before it is destroyed', (): void => {
      const removed: number = [...bridge.cleanups.values(), ...bridge.menuCleanups.values()]
        .filter((cleanup: Stub): boolean => cleanup.mock.calls.length > 0).length;

      expect(removed).toBe(0);
      expect(sse.client.disconnect).not.toHaveBeenCalled();
    });

    it('should cancel a pending mediaEnded reset', (): void => {
      vi.useFakeTimers();
      sse.emit('playback:ended');

      service.ngOnDestroy();
      vi.advanceTimersByTime(1000);

      expect(service.mediaEnded()).toBe(true);
    });
  });

  describe('ngOnDestroy outside Electron', (): void => {
    it('should still disconnect the SSE client', (): void => {
      service = startOutsideElectron();

      service.ngOnDestroy();

      expect(sse.client.disconnect).toHaveBeenCalledTimes(1);
    });
  });
});

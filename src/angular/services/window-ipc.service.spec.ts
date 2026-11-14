/**
 * @fileoverview Tests for WindowIpc.
 *
 * Two things are worth pinning here. Outside Electron every call must be a
 * harmless no-op, because the renderer is also run in a plain browser. Inside
 * Electron, what the main process reports about the window has to reach the
 * signals, and every listener registered has to be removed again.
 *
 * @module app/services/window-ipc.service.spec
 */

import {TestBed} from '@angular/core/testing';
import {WindowIpc} from './window-ipc.service';

// ============================================================================
// Helpers
// ============================================================================

type Stub = ReturnType<typeof vi.fn>;
type Listener = (...args: unknown[]) => void;

/** Bridge functions that register one listener and return its remover. */
const LISTENER_NAMES: readonly string[] = [
  'onFullscreenChange',
  'onFullscreenTransitionStart',
  'onFullscreenTransitionEnd',
  'onViewModeChange',
  'onConfigOpenChange',
  'onPrepareForClose',
  'onExitConfigurationMode',
];

/** Bridge functions that take arguments and resolve to nothing. */
const VOID_NAMES: readonly string[] = [
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

/** A fake preload bridge that records the listeners registered on it. */
interface BridgeHarness {
  readonly api: Record<string, Stub>;
  readonly listeners: Map<string, Listener>;
  readonly cleanups: Map<string, Stub>;
}

function createBridge(): BridgeHarness {
  const listeners: Map<string, Listener> = new Map<string, Listener>();
  const cleanups: Map<string, Stub> = new Map<string, Stub>();
  const api: Record<string, Stub> = {
    getPlatformInfo: vi.fn().mockResolvedValue({platform: 'darwin', supportsGlass: true, systemTheme: 'light'}),
    isFullscreen: vi.fn().mockResolvedValue(false),
    getViewMode: vi.fn().mockResolvedValue('desktop'),
    notifyFadeOutComplete: vi.fn(),
    openFileDialog: vi.fn().mockResolvedValue(['/a.mp3']),
    openSoundFontDialog: vi.fn().mockResolvedValue(['/font.sf2']),
    openSubtitleDialog: vi.fn().mockResolvedValue('/subs.srt'),
    openPlaylistDialog: vi.fn().mockResolvedValue('/list.opp'),
    savePlaylistDialog: vi.fn().mockResolvedValue('/saved.opp'),
    saveMediaDialog: vi.fn().mockResolvedValue('/clip.mp4'),
    getPathForFile: vi.fn().mockReturnValue('/dropped/file.mp3'),
    setWindowPosition: vi.fn().mockResolvedValue({x: 5, y: 6}),
    getWindowPosition: vi.fn().mockResolvedValue({x: 7, y: 8}),
  };
  for (const name of VOID_NAMES) {
    api[name] = vi.fn().mockResolvedValue(undefined);
  }
  for (const name of LISTENER_NAMES) {
    api[name] = vi.fn().mockImplementation((callback: Listener): Stub => {
      const cleanup: Stub = vi.fn();
      listeners.set(name, callback);
      cleanups.set(name, cleanup);
      return cleanup;
    });
  }
  return {api, listeners, cleanups};
}

/** Installs (or, given undefined, removes) the preload bridge on the window. */
function setBridge(api: Record<string, Stub> | undefined): void {
  Object.defineProperty(window, 'mediaPlayer', {value: api, configurable: true, writable: true});
}

/** Fires a listener the service registered on the bridge. */
function fire(bridge: BridgeHarness, name: string, ...args: unknown[]): void {
  const listener: Listener | undefined = bridge.listeners.get(name);
  if (!listener) throw new Error(`No listener registered for ${name}`);
  listener(...args);
}

// ============================================================================
// Tests
// ============================================================================

describe('WindowIpc', (): void => {
  let ipc: WindowIpc;

  beforeEach((): void => {
    TestBed.configureTestingModule({});
    ipc = TestBed.inject(WindowIpc);
  });

  afterEach((): void => {
    ipc.stopWatching();
    setBridge(undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Outside Electron
  // ==========================================================================

  describe('outside Electron', (): void => {
    beforeEach((): void => {
      setBridge(undefined);
    });

    it('reports that it is not running in Electron', (): void => {
      expect(ipc.isElectron).toBe(false);
    });

    it('answers every dialog as if it had been cancelled', async (): Promise<void> => {
      expect(await ipc.openFileDialog()).toEqual([]);
      expect(await ipc.openSoundFontDialog()).toEqual([]);
      expect(await ipc.openSubtitleDialog()).toBeNull();
      expect(await ipc.openPlaylistDialog()).toBeNull();
      expect(await ipc.savePlaylistDialog()).toBeNull();
      expect(await ipc.saveMediaDialog('Clip', 'video')).toBeNull();
    });

    it('cannot turn a dropped file into a path', (): void => {
      expect((): string => ipc.getPathForFile(new File([], 'a.mp3'))).toThrow('Not running in Electron');
    });

    it('leaves a requested window position as it was asked for', async (): Promise<void> => {
      expect(await ipc.setWindowPosition({x: 3, y: 4})).toEqual({x: 3, y: 4});
    });

    it('reports the origin as the window position', async (): Promise<void> => {
      expect(await ipc.getWindowPosition()).toEqual({x: 0, y: 0});
    });

    it('resolves window commands without doing anything', async (): Promise<void> => {
      await expect(Promise.all([
        ipc.enterFullscreen(), ipc.exitFullscreen(), ipc.toggleFullscreen(), ipc.enterMiniplayer(), ipc.exitMiniplayer(),
        ipc.setContentHeight(100), ipc.setTrafficLightVisibility(true), ipc.saveMiniplayerBounds(),
        ipc.setConfigurationMode(true), ipc.showConfigurationWindow(), ipc.showOpenUrlWindow(),
        ipc.minimizeWindow(), ipc.closeWindow(), ipc.clearRecentItems(), ipc.loadPlatformInfo(),
      ])).resolves.toHaveLength(15);
    });

    it('keeps the default window state when asked to watch', (): void => {
      ipc.watchFullscreen();
      ipc.watchViewMode();
      ipc.watchCloseRequests();

      expect(ipc.isFullscreen()).toBe(false);
      expect(ipc.viewMode()).toBe('desktop');
      expect(ipc.platformInfo()).toEqual({platform: 'unknown', supportsGlass: false, systemTheme: 'dark'});
    });
  });

  // ==========================================================================
  // Inside Electron
  // ==========================================================================

  describe('inside Electron', (): void => {
    let bridge: BridgeHarness;

    beforeEach((): void => {
      bridge = createBridge();
      setBridge(bridge.api);
      vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    });

    it('reports that it is running in Electron', (): void => {
      expect(ipc.isElectron).toBe(true);
    });

    describe('platform information', (): void => {
      it('publishes what the main process reports', async (): Promise<void> => {
        await ipc.loadPlatformInfo();

        expect(ipc.platformInfo()).toEqual({platform: 'darwin', supportsGlass: true, systemTheme: 'light'});
      });
    });

    describe('fullscreen tracking', (): void => {
      it('adopts the initial fullscreen state', async (): Promise<void> => {
        bridge.api['isFullscreen'].mockResolvedValue(true);

        ipc.watchFullscreen();
        await Promise.resolve();

        expect(ipc.isFullscreen()).toBe(true);
      });

      it('keeps the default and logs when the initial read fails', async (): Promise<void> => {
        const errorSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
        const failure: Error = new Error('ipc down');
        bridge.api['isFullscreen'].mockRejectedValue(failure);

        ipc.watchFullscreen();
        await Promise.resolve();
        await Promise.resolve();

        expect(ipc.isFullscreen()).toBe(false);
        expect(errorSpy).toHaveBeenCalledWith('[WindowIpc] Failed to read initial fullscreen state:', failure);
      });

      it('follows fullscreen changes', (): void => {
        ipc.watchFullscreen();

        fire(bridge, 'onFullscreenChange', true);
        expect(ipc.isFullscreen()).toBe(true);

        fire(bridge, 'onFullscreenChange', false);
        expect(ipc.isFullscreen()).toBe(false);
      });

      it('counts each transition start and end', (): void => {
        ipc.watchFullscreen();

        fire(bridge, 'onFullscreenTransitionStart');
        fire(bridge, 'onFullscreenTransitionStart');
        fire(bridge, 'onFullscreenTransitionEnd');

        expect(ipc.fullscreenTransitionStart()).toBe(2);
        expect(ipc.fullscreenTransitionEnd()).toBe(1);
      });
    });

    describe('view mode tracking', (): void => {
      it('adopts the initial view mode', async (): Promise<void> => {
        bridge.api['getViewMode'].mockResolvedValue('miniplayer');

        ipc.watchViewMode();
        await Promise.resolve();

        expect(ipc.viewMode()).toBe('miniplayer');
      });

      it('keeps the default and logs when the initial read fails', async (): Promise<void> => {
        const errorSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
        const failure: Error = new Error('ipc down');
        bridge.api['getViewMode'].mockRejectedValue(failure);

        ipc.watchViewMode();
        await Promise.resolve();
        await Promise.resolve();

        expect(ipc.viewMode()).toBe('desktop');
        expect(errorSpy).toHaveBeenCalledWith('[WindowIpc] Failed to read initial view mode:', failure);
      });

      it('follows view mode changes', (): void => {
        ipc.watchViewMode();

        fire(bridge, 'onViewModeChange', 'fullscreen');

        expect(ipc.viewMode()).toBe('fullscreen');
      });

      it('follows the settings window opening and closing', (): void => {
        ipc.watchViewMode();

        fire(bridge, 'onConfigOpenChange', true);
        expect(ipc.isConfigOpen()).toBe(true);

        fire(bridge, 'onConfigOpenChange', false);
        expect(ipc.isConfigOpen()).toBe(false);
      });
    });

    describe('close requests', (): void => {
      beforeEach((): void => {
        vi.useFakeTimers();
        ipc.watchCloseRequests();
      });

      it('asks for a fade of the requested length', (): void => {
        fire(bridge, 'onPrepareForClose', 300);

        expect(ipc.fadeOutRequested()).toBe(300);
      });

      it('tells the main process to proceed only once the fade has had its time', (): void => {
        fire(bridge, 'onPrepareForClose', 300);

        vi.advanceTimersByTime(299);
        expect(bridge.api['notifyFadeOutComplete']).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(bridge.api['notifyFadeOutComplete']).toHaveBeenCalledTimes(1);
      });

      it('restarts the wait when a second close request arrives mid-fade', (): void => {
        fire(bridge, 'onPrepareForClose', 300);
        vi.advanceTimersByTime(200);
        fire(bridge, 'onPrepareForClose', 300);

        vi.advanceTimersByTime(299);
        expect(bridge.api['notifyFadeOutComplete']).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(bridge.api['notifyFadeOutComplete']).toHaveBeenCalledTimes(1);
      });

      it('never notifies the main process after it has stopped watching', (): void => {
        fire(bridge, 'onPrepareForClose', 300);

        ipc.stopWatching();
        vi.advanceTimersByTime(1000);

        expect(bridge.api['notifyFadeOutComplete']).not.toHaveBeenCalled();
      });

      it('counts each request to leave configuration mode', (): void => {
        fire(bridge, 'onExitConfigurationMode');
        fire(bridge, 'onExitConfigurationMode');

        expect(ipc.exitConfigurationModeRequested()).toBe(2);
      });
    });

    describe('stopWatching', (): void => {
      it('removes every listener it registered, once', (): void => {
        ipc.watchFullscreen();
        ipc.watchViewMode();
        ipc.watchCloseRequests();

        ipc.stopWatching();
        ipc.stopWatching();

        expect([...bridge.cleanups.keys()].sort()).toEqual([...LISTENER_NAMES].sort());
        for (const cleanup of bridge.cleanups.values()) {
          expect(cleanup).toHaveBeenCalledTimes(1);
        }
      });

      it('removes its listeners when the service is destroyed', (): void => {
        ipc.watchFullscreen();

        ipc.ngOnDestroy();

        expect(bridge.cleanups.get('onFullscreenChange')).toHaveBeenCalledTimes(1);
      });
    });

    describe('dialogs', (): void => {
      it('offers every supported format and multiple selection by default', async (): Promise<void> => {
        const result: string[] = await ipc.openFileDialog();

        expect(result).toEqual(['/a.mp3']);
        const options: {filters: {name: string; extensions: string[]}[]; multiSelections: boolean} = bridge.api['openFileDialog'].mock.calls[0][0];
        expect(options.multiSelections).toBe(true);
        expect(options.filters.length).toBeGreaterThan(0);
        expect(options.filters.flatMap((filter: {extensions: string[]}): string[] => filter.extensions)).toContain('mp3');
      });

      it('uses the caller\'s filters and selection mode when given', async (): Promise<void> => {
        const filters: {name: string; extensions: string[]}[] = [{name: 'Only FLAC', extensions: ['flac']}];

        await ipc.openFileDialog(false, filters);

        expect(bridge.api['openFileDialog']).toHaveBeenCalledWith({filters, multiSelections: false});
      });

      it('returns what each native dialog chose', async (): Promise<void> => {
        expect(await ipc.openSoundFontDialog()).toEqual(['/font.sf2']);
        expect(await ipc.openSubtitleDialog()).toBe('/subs.srt');
        expect(await ipc.openPlaylistDialog()).toBe('/list.opp');
        expect(await ipc.savePlaylistDialog()).toBe('/saved.opp');
      });

      it('suggests the media title and format when saving a download', async (): Promise<void> => {
        expect(await ipc.saveMediaDialog('Clip', 'audio')).toBe('/clip.mp4');
        expect(bridge.api['saveMediaDialog']).toHaveBeenCalledWith({title: 'Clip', format: 'audio'});
      });

      it('resolves a dropped file to its path', (): void => {
        const file: File = new File([], 'file.mp3');

        expect(ipc.getPathForFile(file)).toBe('/dropped/file.mp3');
        expect(bridge.api['getPathForFile']).toHaveBeenCalledWith(file);
      });
    });

    describe('window commands', (): void => {
      it.each([
        ['enterFullscreen', []],
        ['exitFullscreen', []],
        ['enterMiniplayer', []],
        ['exitMiniplayer', []],
        ['setContentHeight', [420]],
        ['setTrafficLightVisibility', [false]],
        ['saveMiniplayerBounds', []],
        ['setConfigurationMode', [true]],
        ['showConfigurationWindow', ['dependencies']],
        ['showOpenUrlWindow', []],
        ['minimizeWindow', []],
        ['closeWindow', []],
        ['clearRecentItems', []],
      ] as const)('%s is forwarded to the main process', async (name: string, args: readonly unknown[]): Promise<void> => {
        const method: (...params: unknown[]) => Promise<void> = (ipc as unknown as Record<string, (...params: unknown[]) => Promise<void>>)[name].bind(ipc);

        await method(...args);

        expect(bridge.api[name]).toHaveBeenCalledTimes(1);
        expect(bridge.api[name].mock.calls[0].slice(0, args.length)).toEqual([...args]);
      });

      it('returns the position the window actually snapped to', async (): Promise<void> => {
        expect(await ipc.setWindowPosition({x: 1, y: 2})).toEqual({x: 5, y: 6});
        expect(bridge.api['setWindowPosition']).toHaveBeenCalledWith({x: 1, y: 2});
      });

      it('reads the current window position', async (): Promise<void> => {
        expect(await ipc.getWindowPosition()).toEqual({x: 7, y: 8});
      });

      it('toggles into fullscreen when windowed', async (): Promise<void> => {
        await ipc.toggleFullscreen();

        expect(bridge.api['enterFullscreen']).toHaveBeenCalledTimes(1);
        expect(bridge.api['exitFullscreen']).not.toHaveBeenCalled();
      });

      it('toggles out of fullscreen when already fullscreen', async (): Promise<void> => {
        ipc.watchFullscreen();
        fire(bridge, 'onFullscreenChange', true);

        await ipc.toggleFullscreen();

        expect(bridge.api['exitFullscreen']).toHaveBeenCalledTimes(1);
        expect(bridge.api['enterFullscreen']).not.toHaveBeenCalled();
      });
    });
  });
});

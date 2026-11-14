/**
 * @fileoverview Tests for the preload script's bridge between renderer and main.
 *
 * The preload script runs on import and hands its API to
 * contextBridge.exposeInMainWorld. Electron is replaced by a fake whose
 * contextBridge captures that API and whose ipcRenderer keeps a real listener
 * registry, so the tests can fire a channel the way the main process would and
 * see what reaches the renderer's callback.
 *
 * Tests cover:
 * - What is exposed, and under which name
 * - The channel and arguments of every request, and that its answer is returned
 * - Event subscriptions: the payload delivered, the IPC event withheld, and
 *   the unsubscribe function removing only its own listener
 * - openExternal's protocol allow-list
 * - The values read directly in the preload context (file paths, versions)
 *
 * @module electron/preload.spec
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** A listener as ipcRenderer.on receives it: the IPC event first, then the payload. */
type IpcListener = (event: unknown, ...args: unknown[]) => void;

/** The fake Electron runtime shared between the mock factory and the tests. */
interface FakeElectron {
  /** Everything passed to contextBridge.exposeInMainWorld, by key */
  readonly exposed: Map<string, unknown>;
  /** Listeners currently registered with ipcRenderer.on, by channel */
  readonly listeners: Map<string, Set<IpcListener>>;
  readonly invoke: ReturnType<typeof vi.fn>;
  readonly openExternal: ReturnType<typeof vi.fn>;
  readonly getPathForFile: ReturnType<typeof vi.fn>;
}

const fake: FakeElectron = vi.hoisted((): FakeElectron => ({
  exposed: new Map<string, unknown>(),
  listeners: new Map<string, Set<IpcListener>>(),
  invoke: vi.fn(),
  openExternal: vi.fn(),
  getPathForFile: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown): void => {
      fake.exposed.set(key, api);
    },
  },
  ipcRenderer: {
    invoke: fake.invoke,
    on: (channel: string, listener: IpcListener): void => {
      const registered: Set<IpcListener> = fake.listeners.get(channel) ?? new Set<IpcListener>();
      registered.add(listener);
      fake.listeners.set(channel, registered);
    },
    removeListener: (channel: string, listener: IpcListener): void => {
      fake.listeners.get(channel)?.delete(listener);
    },
  },
  webUtils: { getPathForFile: fake.getPathForFile },
  shell: { openExternal: fake.openExternal },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are set up)
// ---------------------------------------------------------------------------

import type { Mock } from 'vitest';
import './preload.js';
import type { MediaPlayerAPI } from './preload.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A callback the renderer subscribes with, recording what it is called with. */
type RendererCallback = Mock<(...args: unknown[]) => void>;

/** Creates a recording renderer callback. */
function rendererCallback(): RendererCallback {
  return vi.fn<(...args: unknown[]) => void>();
}

/** Stands in for the Electron.IpcRendererEvent, which must never reach the renderer. */
const IPC_EVENT: { readonly sender: string } = { sender: 'the-raw-ipc-event' };

/** The API the preload script exposed to the renderer. */
function exposedApi(): MediaPlayerAPI {
  return fake.exposed.get('mediaPlayer') as MediaPlayerAPI;
}

/**
 * Calls an API method by name.
 *
 * @param method - The method's name
 * @param args - The arguments to call it with
 * @returns Whatever the method returned
 */
function call(method: keyof MediaPlayerAPI, ...args: readonly unknown[]): unknown {
  return (exposedApi()[method] as (...values: readonly unknown[]) => unknown)(...args);
}

/**
 * Sends on a channel as the main process would: every listener registered for
 * it receives the IPC event followed by the payload.
 *
 * @param channel - The IPC channel
 * @param args - The payload
 */
function sendFromMain(channel: string, ...args: readonly unknown[]): void {
  for (const listener of [...(fake.listeners.get(channel) ?? [])]) {
    listener(IPC_EVENT, ...args);
  }
}

/** How many listeners are registered across all channels. */
function listenerCount(): number {
  return [...fake.listeners.values()].reduce((total: number, registered: Set<IpcListener>): number => total + registered.size, 0);
}

/** A request the renderer makes of the main process. */
interface RequestCase {
  readonly method: keyof MediaPlayerAPI;
  readonly args: readonly unknown[];
  readonly channel: string;
}

/** A notification the main process sends to the renderer. */
interface EventCase {
  readonly method: keyof MediaPlayerAPI;
  readonly channel: string;
  /** What main sends after the IPC event */
  readonly sent: readonly unknown[];
  /** What the renderer's callback should receive */
  readonly received: readonly unknown[];
}

const REQUESTS: readonly RequestCase[] = [
  { method: 'openFileDialog', args: [{ filters: [{ name: 'Audio', extensions: ['mp3'] }], multiSelections: true }], channel: 'dialog:openFile' },
  { method: 'openPlaylistDialog', args: [], channel: 'dialog:openPlaylist' },
  { method: 'savePlaylistDialog', args: [], channel: 'dialog:savePlaylist' },
  { method: 'saveMediaDialog', args: [{ title: 'A Video', format: 'video' }], channel: 'dialog:saveMedia' },
  { method: 'openSubtitleDialog', args: [], channel: 'dialog:openSubtitle' },
  { method: 'openSoundFontDialog', args: [], channel: 'dialog:openSoundFont' },
  { method: 'getServerPort', args: [], channel: 'app:getServerPort' },
  { method: 'getServerToken', args: [], channel: 'app:getServerToken' },
  { method: 'getPlatformInfo', args: [], channel: 'app:getPlatformInfo' },
  { method: 'enterFullscreen', args: [], channel: 'window:enterFullscreen' },
  { method: 'exitFullscreen', args: [], channel: 'window:exitFullscreen' },
  { method: 'isFullscreen', args: [], channel: 'window:isFullscreen' },
  { method: 'enterMiniplayer', args: [], channel: 'window:enterMiniplayer' },
  { method: 'exitMiniplayer', args: [], channel: 'window:exitMiniplayer' },
  { method: 'getViewMode', args: [], channel: 'window:getViewMode' },
  { method: 'setWindowPosition', args: [{ x: 10, y: 20 }], channel: 'window:setWindowPosition' },
  { method: 'getWindowPosition', args: [], channel: 'window:getWindowPosition' },
  { method: 'setContentHeight', args: [480], channel: 'window:setContentHeight' },
  { method: 'setTrafficLightVisibility', args: [false], channel: 'window:setTrafficLightVisibility' },
  { method: 'saveMiniplayerBounds', args: [], channel: 'window:saveMiniplayerBounds' },
  { method: 'setConfigurationMode', args: [true], channel: 'app:setConfigurationMode' },
  { method: 'showConfigurationWindow', args: ['audio'], channel: 'window:showConfigurationWindow' },
  { method: 'showOpenUrlWindow', args: [], channel: 'window:showOpenUrlWindow' },
  { method: 'getLogFilePath', args: [], channel: 'app:getLogFilePath' },
  { method: 'getAboutInfo', args: [], channel: 'app:getAboutInfo' },
  { method: 'openLicense', args: ['ffmpeg'], channel: 'app:openLicense' },
  { method: 'minimizeWindow', args: [], channel: 'window:minimize' },
  { method: 'closeWindow', args: [], channel: 'window:close' },
  { method: 'clearRecentItems', args: [], channel: 'app:clearRecentItems' },
  { method: 'setupGetPort', args: [], channel: 'setup:getPort' },
  { method: 'setupSetPort', args: [8080], channel: 'setup:setPort' },
  { method: 'setupValidatePort', args: [8080], channel: 'setup:validatePort' },
  { method: 'setupGetPlatform', args: [], channel: 'setup:getPlatform' },
  { method: 'setupComplete', args: [], channel: 'setup:complete' },
  { method: 'setupSkip', args: [], channel: 'setup:skip' },
];

const EVENTS: readonly EventCase[] = [
  { method: 'onFullscreenChange', channel: 'window:fullscreenChanged', sent: [true], received: [true] },
  { method: 'onFullscreenTransitionStart', channel: 'window:fullscreenTransitionStart', sent: [], received: [] },
  { method: 'onFullscreenTransitionEnd', channel: 'window:fullscreenTransitionEnd', sent: [], received: [] },
  { method: 'onViewModeChange', channel: 'window:viewModeChanged', sent: ['miniplayer'], received: ['miniplayer'] },
  { method: 'onConfigOpenChange', channel: 'config:openChanged', sent: [true], received: [true] },
  { method: 'onPrepareForClose', channel: 'app:prepareForClose', sent: [250], received: [250] },
  { method: 'onExitConfigurationMode', channel: 'app:exitConfigurationMode', sent: [], received: [] },
  { method: 'onOSOpenFile', channel: 'os:openFile', sent: ['/music/song.mp3'], received: ['/music/song.mp3'] },
  { method: 'onOSOpenPlaylist', channel: 'os:openPlaylist', sent: ['/lists/mix.opp'], received: ['/lists/mix.opp'] },
];

/** Methods with behaviour of their own, tested individually below. */
const OTHER_METHODS: readonly (keyof MediaPlayerAPI)[] = [
  'getPathForFile',
  'getVersionInfo',
  'notifyFadeOutComplete',
  'onMenuEvent',
  'openExternal',
];

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('preload', (): void => {
  beforeEach((): void => {
    fake.invoke.mockReset();
    fake.openExternal.mockReset();
    fake.getPathForFile.mockReset();
    fake.listeners.clear();
  });

  // ========================================================================
  // 1. Exposure
  // ========================================================================

  describe('exposure', (): void => {
    it('exposes a single object to the renderer, as mediaPlayer', (): void => {
      expect([...fake.exposed.keys()]).toEqual(['mediaPlayer']);
    });

    it('exposes only functions', (): void => {
      const nonFunctions: string[] = Object.entries(exposedApi())
        .filter(([, value]: [string, unknown]): boolean => typeof value !== 'function')
        .map(([name]: [string, unknown]): string => name);

      expect(nonFunctions).toEqual([]);
    });

    it('exposes no method that this suite does not account for', (): void => {
      const accountedFor: string[] = [
        ...REQUESTS.map((request: RequestCase): string => request.method),
        ...EVENTS.map((event: EventCase): string => event.method),
        ...OTHER_METHODS,
      ];

      expect(Object.keys(exposedApi()).sort()).toEqual([...new Set(accountedFor)].sort());
    });

    it('registers no IPC listeners until the renderer subscribes', (): void => {
      expect(listenerCount()).toBe(0);
    });
  });

  // ========================================================================
  // 2. Requests to the main process
  // ========================================================================

  describe('requests', (): void => {
    it.each(REQUESTS)('$method asks on $channel, passing its arguments through', ({ method, args, channel }: RequestCase): void => {
      call(method, ...args);

      expect(fake.invoke.mock.calls).toEqual([[channel, ...args]]);
    });

    it.each(REQUESTS)('$method resolves with the main process\'s answer', async ({ method, args }: RequestCase): Promise<void> => {
      const answer: { readonly from: string } = { from: 'main' };
      fake.invoke.mockResolvedValue(answer);

      const result: unknown = await call(method, ...args);

      expect(result).toBe(answer);
    });

    it.each(REQUESTS)('$method rejects when the main process fails the request', async ({ method, args }: RequestCase): Promise<void> => {
      fake.invoke.mockRejectedValue(new Error('handler failed'));

      await expect(call(method, ...args)).rejects.toThrow('handler failed');
    });

    it('showConfigurationWindow may be called without a category', (): void => {
      void exposedApi().showConfigurationWindow();

      expect(fake.invoke.mock.calls).toEqual([['window:showConfigurationWindow', undefined]]);
    });

    it('notifyFadeOutComplete tells the main process and returns nothing', (): void => {
      fake.invoke.mockResolvedValue('ignored');

      const result: unknown = call('notifyFadeOutComplete');

      expect(fake.invoke.mock.calls).toEqual([['app:fadeOutComplete']]);
      expect(result).toBeUndefined();
    });

    it('notifyFadeOutComplete logs a failed notification instead of leaving the rejection unhandled', async (): Promise<void> => {
      const failure: Error = new Error('no handler registered');
      const logged: Mock<(...args: unknown[]) => void> = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
      fake.invoke.mockRejectedValue(failure);

      call('notifyFadeOutComplete');
      await Promise.resolve();

      expect(logged.mock.calls).toEqual([['Failed to notify fade-out completion:', failure]]);
      logged.mockRestore();
    });
  });

  // ========================================================================
  // 3. Events from the main process
  // ========================================================================

  describe('events', (): void => {
    it.each(EVENTS)('$method listens on $channel only', ({ method, channel }: EventCase): void => {
      call(method, rendererCallback());

      expect([...fake.listeners.keys()]).toEqual([channel]);
      expect(fake.listeners.get(channel)?.size).toBe(1);
    });

    it.each(EVENTS)('$method delivers the payload without the IPC event', ({ method, channel, sent, received }: EventCase): void => {
      const callback: RendererCallback = rendererCallback();
      call(method, callback);

      sendFromMain(channel, ...sent);

      expect(callback.mock.calls).toEqual([received]);
    });

    it.each(EVENTS)('$method delivers every occurrence, not just the first', ({ method, channel, sent, received }: EventCase): void => {
      const callback: RendererCallback = rendererCallback();
      call(method, callback);

      sendFromMain(channel, ...sent);
      sendFromMain(channel, ...sent);

      expect(callback.mock.calls).toEqual([received, received]);
    });

    it.each(EVENTS)('$method does not hear other channels', ({ method }: EventCase): void => {
      const callback: RendererCallback = rendererCallback();
      call(method, callback);

      sendFromMain('some:otherChannel', 'payload');

      expect(callback).not.toHaveBeenCalled();
    });

    it.each(EVENTS)('$method stops delivering once unsubscribed', ({ method, channel, sent }: EventCase): void => {
      const callback: RendererCallback = rendererCallback();
      const unsubscribe: () => void = call(method, callback) as () => void;

      unsubscribe();
      sendFromMain(channel, ...sent);

      expect(callback).not.toHaveBeenCalled();
      expect(listenerCount()).toBe(0);
    });

    it.each(EVENTS)('$method unsubscribes only the subscription it was returned for', ({ method, channel, sent, received }: EventCase): void => {
      const first: RendererCallback = rendererCallback();
      const second: RendererCallback = rendererCallback();
      const unsubscribeFirst: () => void = call(method, first) as () => void;
      call(method, second);

      unsubscribeFirst();
      sendFromMain(channel, ...sent);

      expect(first).not.toHaveBeenCalled();
      expect(second.mock.calls).toEqual([received]);
    });

    it.each(EVENTS)('$method unsubscribe returns nothing and can safely be called twice', ({ method, channel, sent, received }: EventCase): void => {
      const stale: () => void = call(method, vi.fn()) as () => void;
      const current: RendererCallback = rendererCallback();
      call(method, current);

      const result: unknown = stale();
      stale();
      sendFromMain(channel, ...sent);

      expect(result).toBeUndefined();
      expect(current.mock.calls).toEqual([received]);
    });

    it.each<EventCase>(
      EVENTS.filter((event: EventCase): boolean => event.received.length === 0)
    )('$method passes nothing to its callback even when the main process sends a payload', ({ method, channel }: EventCase): void => {
      const callback: RendererCallback = rendererCallback();
      call(method, callback);

      sendFromMain(channel, 'unexpected');

      expect(callback.mock.calls).toEqual([[]]);
    });
  });

  // ========================================================================
  // 4. Menu events
  // ========================================================================

  describe('onMenuEvent', (): void => {
    it('listens on the menu: channel named after the event', (): void => {
      exposedApi().onMenuEvent('openFile', rendererCallback());

      expect([...fake.listeners.keys()]).toEqual(['menu:openFile']);
    });

    it('delivers every argument the menu sent, without the IPC event', (): void => {
      const callback: RendererCallback = rendererCallback();
      exposedApi().onMenuEvent('selectVisualization', callback);

      sendFromMain('menu:selectVisualization', 'bars', { animated: true });

      expect(callback.mock.calls).toEqual([['bars', { animated: true }]]);
    });

    it('delivers an event that carries no arguments', (): void => {
      const callback: RendererCallback = rendererCallback();
      exposedApi().onMenuEvent('stop', callback);

      sendFromMain('menu:stop');

      expect(callback.mock.calls).toEqual([[]]);
    });

    it('does not deliver a different menu event', (): void => {
      const callback: RendererCallback = rendererCallback();
      exposedApi().onMenuEvent('openFile', callback);

      sendFromMain('menu:openPlaylist');

      expect(callback).not.toHaveBeenCalled();
    });

    it('unsubscribes only the subscription it was returned for', (): void => {
      const first: RendererCallback = rendererCallback();
      const second: RendererCallback = rendererCallback();
      const other: RendererCallback = rendererCallback();
      const unsubscribeFirst: () => void = exposedApi().onMenuEvent('stop', first);
      exposedApi().onMenuEvent('stop', second);
      exposedApi().onMenuEvent('openFile', other);

      unsubscribeFirst();
      sendFromMain('menu:stop');
      sendFromMain('menu:openFile');

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
      expect(other).toHaveBeenCalledTimes(1);
    });
  });

  // ========================================================================
  // 5. openExternal
  // ========================================================================

  describe('openExternal', (): void => {
    it.each(['https://onixlabs.io/docs?q=1#top', 'http://localhost:8080/'])('hands %s to the system browser unchanged', async (url: string): Promise<void> => {
      fake.openExternal.mockResolvedValue(undefined);

      await exposedApi().openExternal(url);

      expect(fake.openExternal.mock.calls).toEqual([[url]]);
    });

    it('rejects when the system cannot open the URL', async (): Promise<void> => {
      fake.openExternal.mockRejectedValue(new Error('no handler'));

      await expect(exposedApi().openExternal('https://onixlabs.io')).rejects.toThrow('no handler');
    });

    it.each([
      { url: 'file:///etc/passwd', protocol: 'file:' },
      { url: 'javascript:alert(1)', protocol: 'javascript:' },
      { url: 'smb://server/share', protocol: 'smb:' },
      { url: 'mailto:someone@example.com', protocol: 'mailto:' },
      { url: 'HTTPS-EVIL://onixlabs.io', protocol: 'https-evil:' },
    ])('refuses $url, naming the $protocol protocol', async ({ url, protocol }: { url: string; protocol: string }): Promise<void> => {
      await expect(exposedApi().openExternal(url)).rejects.toThrow(`Blocked openExternal with disallowed protocol: ${protocol}`);
      expect(fake.openExternal).not.toHaveBeenCalled();
    });

    it('accepts an allowed scheme whatever its letter case', async (): Promise<void> => {
      fake.openExternal.mockResolvedValue(undefined);

      await exposedApi().openExternal('HTTPS://onixlabs.io');

      expect(fake.openExternal.mock.calls).toEqual([['HTTPS://onixlabs.io']]);
    });

    it.each(['', 'not a url', '/etc/passwd', 'onixlabs.io'])('never opens %j, which is not an absolute URL', async (text: string): Promise<void> => {
      await expect(exposedApi().openExternal(text)).rejects.toThrow();
      expect(fake.openExternal).not.toHaveBeenCalled();
    });

    it('reports text that is not a URL as a rejection, not a synchronous throw', async (): Promise<void> => {
      let attempt: Promise<void> | undefined;

      expect((): void => {
        attempt = exposedApi().openExternal('not a url');
      }).not.toThrow();
      await expect(attempt).rejects.toThrow('Blocked openExternal with invalid URL');
    });
  });

  // ========================================================================
  // 6. Values read in the preload context
  // ========================================================================

  describe('getPathForFile', (): void => {
    it('returns the path Electron resolves for the dropped file', (): void => {
      const file: File = { name: 'song.mp3' } as File;
      fake.getPathForFile.mockReturnValue('/music/song.mp3');

      const result: string = exposedApi().getPathForFile(file);

      expect(result).toBe('/music/song.mp3');
      expect(fake.getPathForFile.mock.calls).toEqual([[file]]);
      expect(fake.invoke).not.toHaveBeenCalled();
    });
  });

  describe('getVersionInfo', (): void => {
    const ORIGINAL_VERSIONS_DESCRIPTOR: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(process, 'versions');

    afterEach((): void => {
      if (ORIGINAL_VERSIONS_DESCRIPTOR) {
        Object.defineProperty(process, 'versions', ORIGINAL_VERSIONS_DESCRIPTOR);
      }
    });

    it('reports the Electron, Node, Chrome and V8 versions of the running process, and nothing else', (): void => {
      Object.defineProperty(process, 'versions', {
        ...ORIGINAL_VERSIONS_DESCRIPTOR,
        value: { ...process.versions, electron: '45.0.0', node: '24.1.0', chrome: '150.0.7000.1', v8: '15.0.1', openssl: '3.5.0' },
      });

      const versions: { electron: string; node: string; chrome: string; v8: string } = exposedApi().getVersionInfo();

      expect(versions).toEqual({ electron: '45.0.0', node: '24.1.0', chrome: '150.0.7000.1', v8: '15.0.1' });
      expect(fake.invoke).not.toHaveBeenCalled();
    });
  });
});

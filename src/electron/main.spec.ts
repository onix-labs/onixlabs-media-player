/**
 * @fileoverview Tests for the Electron main process entry point.
 *
 * Tests cover:
 * - Startup: single-instance lock, privileged scheme, media server, setup wizard
 * - Window creation and the security-relevant webPreferences of every window
 * - Navigation lockdown (will-navigate, window.open) and the Content-Security-Policy
 * - The media:// protocol handler (traversal, non-files, missing files)
 * - Every IPC handler (dialogs, fullscreen, miniplayer, window geometry, setup)
 * - Menu callbacks and media-server callbacks that keep the menu in sync
 * - Files handed over by the OS (second instance, open-file, launch arguments)
 * - Window close (audio fade), focus-loss miniplayer, and app lifecycle events
 *
 * main.ts runs on import, so its whole world is faked first: `electron`, `fs`
 * and the sibling modules it constructs. The fakes capture every registered
 * handler and listener so a test can invoke it the way Electron would. Each
 * test boots a fresh module instance through `boot()`.
 *
 * @module electron/main.spec
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import type {Mock} from 'vitest';
import * as nodeNet from 'net';
import type {AddressInfo} from 'net';
import * as path from 'path';
import type {BrowserWindowConstructorOptions} from 'electron';

// ============================================================================
// Fakes — hoisted so the vi.mock factories below can reach them
// ============================================================================

const h = vi.hoisted(() => {
  type Listener = (...args: never[]) => unknown;
  type LooseListener = (...args: unknown[]) => unknown;

  interface Registration {
    listener: LooseListener;
    once: boolean;
  }

  interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface FakeEvent {
    preventDefault: Mock<() => void>;
  }

  interface IpcEvent {
    sender: FakeWebContents | null;
  }

  type IpcHandler = (event: IpcEvent, ...args: unknown[]) => unknown;
  type ProtocolHandler = (request: {url: string}) => Response | Promise<Response>;
  type HeadersListener = (
    details: {responseHeaders?: Record<string, string[]>},
    callback: (response: {responseHeaders?: Record<string, string[]>}) => void
  ) => void;

  interface Appearance {
    glassEnabled?: boolean;
    macOSVisualEffectState?: string;
    backgroundColor?: string;
  }

  interface RecentEntry {
    path: string;
    name: string;
  }

  interface WorldConfig {
    gotLock: boolean;
    packaged: boolean;
    appPath: string;
    version: string;
    port: number;
    configuredPort: number;
    setupComplete: boolean;
    appearance: Appearance | undefined;
    miniplayerOnFocusLoss: boolean;
    miniplayerBounds: Rectangle | null;
    recent: {recentFiles: RecentEntry[]; recentPlaylists: RecentEntry[]};
    ffmpegInstalled: boolean;
    fluidsynthInstalled: boolean;
    dark: boolean;
    themeThrows: boolean;
    workArea: Rectangle;
    caBundle: string | null;
    openDialogResult: {canceled: boolean; filePaths: string[]};
    saveDialogResult: {canceled: boolean; filePath: string};
    openPathError: string;
    notices: {id: string; name: string}[];
    licenseFiles: Map<unknown, string>;
  }

  /** Minimal event emitter standing in for Electron's EventEmitter-based objects. */
  class FakeEmitter {
    private readonly registrations: Map<string, Registration[]> = new Map<string, Registration[]>();

    public on(event: string, listener: Listener): this {
      return this.add(event, listener, false);
    }

    public once(event: string, listener: Listener): this {
      return this.add(event, listener, true);
    }

    public emit(event: string, ...args: unknown[]): void {
      const live: Registration[] = this.registrations.get(event) ?? [];
      const snapshot: Registration[] = [...live];
      this.registrations.set(event, live.filter((registration: Registration): boolean => !registration.once));
      snapshot.forEach((registration: Registration): unknown => registration.listener(...args));
    }

    private add(event: string, listener: Listener, once: boolean): this {
      const live: Registration[] = this.registrations.get(event) ?? [];
      live.push({listener: listener as LooseListener, once});
      this.registrations.set(event, live);
      return this;
    }
  }

  class FakeWebContents extends FakeEmitter {
    public readonly send: Mock<(channel: string, ...args: unknown[]) => void> = vi.fn();
    public readonly setVisualZoomLevelLimits: Mock<(minimum: number, maximum: number) => void> = vi.fn();
    public windowOpenHandler: ((details: {url: string}) => {action: string}) | null = null;

    public setWindowOpenHandler(handler: (details: {url: string}) => {action: string}): void {
      this.windowOpenHandler = handler;
    }
  }

  class FakeBrowserWindow extends FakeEmitter {
    public readonly options: BrowserWindowConstructorOptions;
    public readonly webContents: FakeWebContents = new FakeWebContents();
    public bounds: Rectangle = {x: 100, y: 100, width: 960, height: 720};
    public contentSize: [number, number] = [460, 200];
    public destroyed: boolean = false;
    public fullScreen: boolean = false;
    public simpleFullScreen: boolean = false;
    public minimized: boolean = false;

    public readonly loadURL: Mock<(url: string) => Promise<void>> = vi.fn(async (): Promise<void> => undefined);
    public readonly show: Mock<() => void> = vi.fn();
    public readonly focus: Mock<() => void> = vi.fn();
    public readonly restore: Mock<() => void> = vi.fn();
    public readonly minimize: Mock<() => void> = vi.fn();
    public readonly setMenuBarVisibility: Mock<(visible: boolean) => void> = vi.fn();
    public readonly setFullScreenable: Mock<(fullscreenable: boolean) => void> = vi.fn();
    public readonly setMinimumSize: Mock<(width: number, height: number) => void> = vi.fn();
    public readonly setMaximumSize: Mock<(width: number, height: number) => void> = vi.fn();
    public readonly setAlwaysOnTop: Mock<(flag: boolean, level?: string) => void> = vi.fn();
    public readonly setResizable: Mock<(resizable: boolean) => void> = vi.fn();
    public readonly setWindowButtonVisibility: Mock<(visible: boolean) => void> = vi.fn();
    public readonly setContentSize: Mock<(width: number, height: number) => void> = vi.fn();

    public readonly setBounds: Mock<(bounds: Rectangle) => void> = vi.fn((bounds: Rectangle): void => {
      this.bounds = {...bounds};
    });

    public readonly setSize: Mock<(width: number, height: number) => void> = vi.fn((width: number, height: number): void => {
      this.bounds = {...this.bounds, width, height};
    });

    public readonly setPosition: Mock<(x: number, y: number) => void> = vi.fn((x: number, y: number): void => {
      this.bounds = {...this.bounds, x, y};
    });

    /** Like Electron, a native fullscreen change is announced through an event. */
    public readonly setFullScreen: Mock<(flag: boolean) => void> = vi.fn((flag: boolean): void => {
      if (flag === this.fullScreen) return;
      this.fullScreen = flag;
      this.emit(flag ? 'enter-full-screen' : 'leave-full-screen');
    });

    public readonly setSimpleFullScreen: Mock<(flag: boolean) => void> = vi.fn((flag: boolean): void => {
      this.simpleFullScreen = flag;
    });

    /** Like Electron, close is cancellable; an uncancelled close destroys the window. */
    public readonly close: Mock<() => void> = vi.fn((): void => {
      const event: FakeEvent = {preventDefault: vi.fn()};
      this.emit('close', event);
      if (event.preventDefault.mock.calls.length === 0) this.destroy();
    });

    public readonly destroy: Mock<() => void> = vi.fn((): void => {
      if (this.destroyed) return;
      this.destroyed = true;
      world.windows = world.windows.filter((candidate: FakeBrowserWindow): boolean => candidate !== this);
      this.emit('closed');
    });

    public constructor(options: BrowserWindowConstructorOptions) {
      super();
      this.options = options;
      world.created.push(this);
      world.windows.push(this);
    }

    public static getAllWindows(): FakeBrowserWindow[] {
      return [...world.windows];
    }

    public static getFocusedWindow(): FakeBrowserWindow | null {
      return world.focusedWindow;
    }

    public static fromWebContents(contents: FakeWebContents | null): FakeBrowserWindow | null {
      return world.windows.find((candidate: FakeBrowserWindow): boolean => candidate.webContents === contents) ?? null;
    }

    public getBounds(): Rectangle {
      return {...this.bounds};
    }

    public getSize(): number[] {
      return [this.bounds.width, this.bounds.height];
    }

    public getPosition(): number[] {
      return [this.bounds.x, this.bounds.y];
    }

    public getContentSize(): number[] {
      return [...this.contentSize];
    }

    public isDestroyed(): boolean {
      return this.destroyed;
    }

    public isFullScreen(): boolean {
      return this.fullScreen;
    }

    public isSimpleFullScreen(): boolean {
      return this.simpleFullScreen;
    }

    public isMinimized(): boolean {
      return this.minimized;
    }
  }

  const settings = {
    getSettings: (): {appearance: Appearance | undefined; application: {serverPort: number; miniplayerOnFocusLoss: boolean}} => ({
      appearance: world.config.appearance,
      application: {
        serverPort: world.config.configuredPort,
        miniplayerOnFocusLoss: world.config.miniplayerOnFocusLoss,
      },
    }),
    isSetupCompleteForVersion: vi.fn((_version: string): boolean => world.config.setupComplete),
    getSetupCompletedVersion: (): string => '',
    markSetupComplete: vi.fn((_version: string): void => undefined),
    updateApplicationSettings: vi.fn((_update: {serverPort: number}): void => undefined),
    getMiniplayerBounds: (): Rectangle | null => world.config.miniplayerBounds,
    setMiniplayerBounds: vi.fn((_bounds: Rectangle): void => undefined),
    clearRecentItems: vi.fn((): void => {
      world.config.recent = {recentFiles: [], recentPlaylists: []};
    }),
    getRecentItems: (): {recentFiles: RecentEntry[]; recentPlaylists: RecentEntry[]} => world.config.recent,
    flush: vi.fn((): void => undefined),
  };

  class FakeMediaServer {
    public readonly staticPath: string | undefined;
    public readonly callbacks: Map<string, LooseListener> = new Map<string, LooseListener>();
    public readonly start: Mock<() => Promise<number>> = vi.fn(async (): Promise<number> => world.config.port);
    public readonly nukeMidiCache: Mock<() => void> = vi.fn();
    public readonly nukeTrackerCache: Mock<() => void> = vi.fn();

    public constructor(staticPath: string | undefined) {
      this.staticPath = staticPath;
      world.server = this;
    }

    public onModeChange(callback: Listener): void {
      this.callbacks.set('modeChange', callback as LooseListener);
    }

    public onPlaylistCountChange(callback: Listener): void {
      this.callbacks.set('playlistCountChange', callback as LooseListener);
    }

    public onPlaybackStateChange(callback: Listener): void {
      this.callbacks.set('playbackStateChange', callback as LooseListener);
    }

    public onMediaTypeChange(callback: Listener): void {
      this.callbacks.set('mediaTypeChange', callback as LooseListener);
    }

    public onDependencyStateChange(callback: Listener): void {
      this.callbacks.set('dependencyStateChange', callback as LooseListener);
    }

    public onRecentItemsChange(callback: Listener): void {
      this.callbacks.set('recentItemsChange', callback as LooseListener);
    }

    public getDependencyManager(): {getState: () => {ffmpeg: {installed: boolean}; fluidsynth: {installed: boolean}}} {
      return {
        getState: (): {ffmpeg: {installed: boolean}; fluidsynth: {installed: boolean}} => ({
          ffmpeg: {installed: world.config.ffmpegInstalled},
          fluidsynth: {installed: world.config.fluidsynthInstalled},
        }),
      };
    }

    public getSettingsManager(): typeof settings {
      return settings;
    }

    public getPort(): number {
      return world.config.port;
    }

    public getAuthToken(): string {
      return 'session-token';
    }
  }

  class FakeLicenseCatalog {
    public readonly locations: unknown;
    public readonly versions: unknown;

    public constructor(locations: unknown, versions: unknown) {
      this.locations = locations;
      this.versions = versions;
      world.catalogs.push(this);
    }

    public getNotices(): {id: string; name: string}[] {
      return world.config.notices;
    }

    public getFile(id: unknown): string | null {
      return world.config.licenseFiles.get(id) ?? null;
    }
  }

  interface World {
    config: WorldConfig;
    created: FakeBrowserWindow[];
    windows: FakeBrowserWindow[];
    focusedWindow: FakeBrowserWindow | null;
    server: FakeMediaServer | null;
    ready: (() => Promise<void>) | null;
    appEvents: FakeEmitter;
    ipcHandlers: Map<string, IpcHandler>;
    protocolHandlers: Map<string, ProtocolHandler>;
    headersListener: HeadersListener | null;
    files: Map<string, 'file' | 'directory'>;
    catalogs: FakeLicenseCatalog[];
  }

  function createConfig(): WorldConfig {
    return {
      gotLock: true,
      packaged: false,
      appPath: '/opt/onixplayer/app',
      version: '2026.11.0',
      port: 51234,
      configuredPort: 0,
      setupComplete: true,
      appearance: undefined,
      miniplayerOnFocusLoss: false,
      miniplayerBounds: null,
      recent: {recentFiles: [], recentPlaylists: []},
      ffmpegInstalled: true,
      fluidsynthInstalled: false,
      dark: true,
      themeThrows: false,
      workArea: {x: 0, y: 0, width: 1920, height: 1080},
      caBundle: null,
      openDialogResult: {canceled: false, filePaths: []},
      saveDialogResult: {canceled: false, filePath: ''},
      openPathError: '',
      notices: [],
      licenseFiles: new Map<unknown, string>(),
    };
  }

  const world: World = {
    config: createConfig(),
    created: [],
    windows: [],
    focusedWindow: null,
    server: null,
    ready: null,
    appEvents: new FakeEmitter(),
    ipcHandlers: new Map<string, IpcHandler>(),
    protocolHandlers: new Map<string, ProtocolHandler>(),
    headersListener: null,
    files: new Map<string, 'file' | 'directory'>(),
    catalogs: [],
  };

  /** Returns the fake world to its defaults; called before every boot. */
  function reset(): void {
    world.config = createConfig();
    world.created = [];
    world.windows = [];
    world.focusedWindow = null;
    world.server = null;
    world.ready = null;
    world.appEvents = new FakeEmitter();
    world.ipcHandlers = new Map<string, IpcHandler>();
    world.protocolHandlers = new Map<string, ProtocolHandler>();
    world.headersListener = null;
    world.files = new Map<string, 'file' | 'directory'>();
    world.catalogs = [];
  }

  const app = {
    setName: vi.fn((_name: string): void => undefined),
    commandLine: {appendSwitch: vi.fn((_name: string, _value: string): void => undefined)},
    requestSingleInstanceLock: vi.fn((): boolean => world.config.gotLock),
    quit: vi.fn((): void => undefined),
    on: (event: string, listener: Listener): void => {
      world.appEvents.on(event, listener);
    },
    // main.ts chains its initializer off whenReady(); capturing it lets a test
    // decide when "ready" happens and await the initialization it triggers.
    whenReady: vi.fn((): {then: (callback: () => Promise<void>) => void} => ({
      then: (callback: () => Promise<void>): void => {
        world.ready = callback;
      },
    })),
    get isPackaged(): boolean {
      return world.config.packaged;
    },
    getAppPath: (): string => world.config.appPath,
    getVersion: (): string => world.config.version,
    dock: {setIcon: vi.fn((_icon: string): void => undefined)},
  };

  const ipcMain = {
    // Electron throws when a channel is registered twice; so does the fake.
    handle: (channel: string, handler: IpcHandler): void => {
      if (world.ipcHandlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      world.ipcHandlers.set(channel, handler);
    },
    handleOnce: (channel: string, handler: IpcHandler): void => {
      ipcMain.handle(channel, (event: IpcEvent, ...args: unknown[]): unknown => {
        world.ipcHandlers.delete(channel);
        return handler(event, ...args);
      });
    },
    removeHandler: (channel: string): void => {
      world.ipcHandlers.delete(channel);
    },
  };

  const electron = {
    app,
    BrowserWindow: FakeBrowserWindow,
    ipcMain,
    dialog: {
      showOpenDialog: vi.fn(async (_window: FakeBrowserWindow, _options: Record<string, unknown>): Promise<{canceled: boolean; filePaths: string[]}> =>
        world.config.openDialogResult),
      showSaveDialog: vi.fn(async (_window: FakeBrowserWindow, _options: Record<string, unknown>): Promise<{canceled: boolean; filePath: string}> =>
        world.config.saveDialogResult),
    },
    nativeTheme: {
      get shouldUseDarkColors(): boolean {
        if (world.config.themeThrows) throw new Error('theme unavailable');
        return world.config.dark;
      },
    },
    net: {
      fetch: vi.fn(async (_url: string): Promise<Response> => new Response('file-bytes')),
    },
    protocol: {
      registerSchemesAsPrivileged: vi.fn((_schemes: {scheme: string; privileges: Record<string, boolean>}[]): void => undefined),
      handle: (scheme: string, handler: ProtocolHandler): void => {
        world.protocolHandlers.set(scheme, handler);
      },
    },
    screen: {
      getDisplayNearestPoint: vi.fn((_point: {x: number; y: number}): {workArea: Rectangle} => ({workArea: world.config.workArea})),
      getPrimaryDisplay: (): {workArea: Rectangle} => ({workArea: world.config.workArea}),
      getDisplayMatching: (_bounds: Rectangle): {workAreaSize: {width: number; height: number}} => ({
        workAreaSize: {width: world.config.workArea.width, height: world.config.workArea.height},
      }),
    },
    session: {
      defaultSession: {
        webRequest: {
          onHeadersReceived: (listener: HeadersListener): void => {
            world.headersListener = listener;
          },
        },
      },
    },
    shell: {
      openExternal: vi.fn(async (_url: string): Promise<void> => undefined),
      openPath: vi.fn(async (_file: string): Promise<string> => world.config.openPathError),
    },
  };

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const menu = {
    createApplicationMenu: vi.fn((_callbacks: Record<string, LooseListener>, _state: Record<string, unknown>): void => undefined),
    updateMenuState: vi.fn((_state: Record<string, unknown>): void => undefined),
  };

  const resources = {
    getLicenseLocations: vi.fn((): {root: string} => ({root: '/licenses'})),
    useSystemCertificates: vi.fn((): string | null => world.config.caBundle),
  };

  const loggerModule = {
    initializeLogger: vi.fn((_options: {spyRendererConsole?: boolean}): void => undefined),
    mainLogger: logger,
    ipcLogger: logger,
    windowLogger: logger,
    getLogFilePath: (): string => '/logs/onixplayer.log',
  };

  return {world, reset, electron, settings, menu, resources, loggerModule, FakeBrowserWindow, FakeMediaServer, FakeLicenseCatalog};
});

vi.mock('electron', () => h.electron);

vi.mock('fs', () => ({
  existsSync: (file: string): boolean => h.world.files.has(file),
  statSync: (file: string): {isFile: () => boolean} => {
    const kind: 'file' | 'directory' | undefined = h.world.files.get(file);
    if (!kind) throw new Error(`ENOENT: no such file or directory, stat '${file}'`);
    return {isFile: (): boolean => kind === 'file'};
  },
}));

vi.mock('./unified-media-server.js', () => ({UnifiedMediaServer: h.FakeMediaServer}));
vi.mock('./application-menu.js', () => h.menu);
vi.mock('./logger.js', () => h.loggerModule);
vi.mock('./bundled-resources.js', () => h.resources);
vi.mock('./license-catalog.js', () => ({LicenseCatalog: h.FakeLicenseCatalog}));

// ============================================================================
// Helpers
// ============================================================================

type FakeWindow = InstanceType<typeof h.FakeBrowserWindow>;
type FakeServer = InstanceType<typeof h.FakeMediaServer>;
type WorldConfig = typeof h.world.config;
type MenuCallback = (...args: unknown[]) => unknown;

interface BootOptions {
  /** Platform reported by process.platform (default: linux) */
  platform?: NodeJS.Platform;
  /** Command line of the launched process (default: no file arguments) */
  argv?: string[];
  /** Run with NODE_ENV=development */
  development?: boolean;
  /** Value for the DEV_SERVER_URL environment variable */
  devServerUrl?: string;
  /** Overrides for the fake world (settings, dialogs, display, …) */
  config?: Partial<WorldConfig>;
  /** Files that exist on the fake filesystem */
  files?: Record<string, 'file' | 'directory'>;
  /** Leave the app in the pre-ready state; the test calls `ready()` itself */
  deferReady?: boolean;
}

const ORIGINAL_PLATFORM: NodeJS.Platform = process.platform;
const ORIGINAL_ARGV: string[] = process.argv;
const PORT: number = 51234;
const APP_ORIGIN: string = `http://127.0.0.1:${PORT}`;
const DEV_ORIGIN: string = 'http://localhost:4300';
const WIZARD_TITLE: string = 'ONIXPlayer Setup';
const CONFIG_TITLE: string = 'ONIXPlayer Configuration';
const ABOUT_TITLE: string = 'About ONIXPlayer';
const OPEN_URL_TITLE: string = 'Open URL';

/** The promise returned by main.ts's initializer once `ready()` has run. */
let initialized: Promise<void> = Promise.resolve();

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {value: platform, configurable: true});
}

/** Lets every already-resolved promise chain run to its next real wait. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve: () => void): void => {
    setImmediate(resolve);
  });
}

/** Fires Electron's "ready"; returns the initializer's promise without awaiting it. */
function ready(): Promise<void> {
  const callback: (() => Promise<void>) | null = h.world.ready;
  if (!callback) throw new Error('main.ts never waited for app ready');
  initialized = callback();
  return initialized;
}

/**
 * Imports a fresh copy of main.ts into a freshly reset fake world and, unless
 * told otherwise, runs initialization to completion.
 */
async function boot(options: BootOptions = {}): Promise<void> {
  h.reset();
  vi.clearAllMocks();
  Object.assign(h.world.config, options.config ?? {});
  Object.entries(options.files ?? {}).forEach(([file, kind]: [string, 'file' | 'directory']): void => {
    h.world.files.set(file, kind);
  });
  setPlatform(options.platform ?? 'linux');
  process.argv = options.argv ?? ['electron', '.'];
  vi.stubEnv('NODE_ENV', options.development ? 'development' : 'production');
  if (options.devServerUrl !== undefined) vi.stubEnv('DEV_SERVER_URL', options.devServerUrl);

  vi.resetModules();
  await import('./main.js');

  if (options.deferReady || !h.world.ready) return;
  void ready();
  // With the wizard showing, initialization stays parked until it closes.
  if (h.world.config.setupComplete && !process.argv.includes('--first-run')) {
    await initialized;
  } else {
    await settle();
  }
}

/** Boots into the first-run setup wizard, which blocks the main window. */
async function bootIntoWizard(options: BootOptions = {}): Promise<FakeWindow> {
  await boot({...options, config: {...options.config, setupComplete: false}});
  return windowTitled(WIZARD_TITLE);
}

/** The most recently created window with the given title. */
function windowTitled(title: string | undefined): FakeWindow {
  const match: FakeWindow | undefined = [...h.world.created]
    .reverse()
    .find((candidate: FakeWindow): boolean => candidate.options.title === title);
  if (!match) throw new Error(`No window titled ${String(title)} was created`);
  return match;
}

/** The main player window (the only one created without a title). */
function mainWindow(): FakeWindow {
  return windowTitled(undefined);
}

function windowsTitled(title: string | undefined): FakeWindow[] {
  return h.world.created.filter((candidate: FakeWindow): boolean => candidate.options.title === title);
}

function server(): FakeServer {
  if (!h.world.server) throw new Error('The media server was never constructed');
  return h.world.server;
}

/** Invokes an IPC handler the way ipcRenderer.invoke would, from `sender`. */
async function invokeFrom(sender: FakeWindow | null, channel: string, ...args: unknown[]): Promise<unknown> {
  const handler: ((event: {sender: FakeWindow['webContents'] | null}, ...rest: unknown[]) => unknown) | undefined =
    h.world.ipcHandlers.get(channel);
  if (!handler) throw new Error(`No IPC handler registered for ${channel}`);
  return handler({sender: sender?.webContents ?? null}, ...args);
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return invokeFrom(null, channel, ...args);
}

function menuCallbacks(): Record<string, MenuCallback> {
  const calls: unknown[][] = h.menu.createApplicationMenu.mock.calls;
  return calls[calls.length - 1][0] as Record<string, MenuCallback>;
}

function serverCallback(name: string): MenuCallback {
  const callback: MenuCallback | undefined = server().callbacks.get(name);
  if (!callback) throw new Error(`The media server callback ${name} was never registered`);
  return callback;
}

/** The value most recently pushed to the application menu for `key`. */
function lastMenuState(key: string): unknown {
  const states: Record<string, unknown>[] = h.menu.updateMenuState.mock.calls
    .map((call: [Record<string, unknown>]): Record<string, unknown> => call[0])
    .filter((state: Record<string, unknown>): boolean => key in state);
  if (states.length === 0) throw new Error(`The menu state ${key} was never updated`);
  return states[states.length - 1][key];
}

/** Arguments of every message sent to a window's renderer on `channel`. */
function sent(window: FakeWindow, channel: string): unknown[][] {
  return window.webContents.send.mock.calls
    .filter((call: unknown[]): boolean => call[0] === channel)
    .map((call: unknown[]): unknown[] => call.slice(1));
}

function sentChannels(window: FakeWindow): string[] {
  return window.webContents.send.mock.calls.map((call: unknown[]): string => String(call[0]));
}

function createEvent(): {preventDefault: Mock<() => void>} {
  return {preventDefault: vi.fn()};
}

/** Simulates the renderer attempting to navigate `window` to `url`. */
function navigate(window: FakeWindow, url: string): boolean {
  const event: {preventDefault: Mock<() => void>} = createEvent();
  window.webContents.emit('will-navigate', event, url);
  return event.preventDefault.mock.calls.length === 0;
}

/** Simulates the renderer calling window.open(url) inside `window`. */
function openFromRenderer(window: FakeWindow, url: string): {action: string} {
  const handler: ((details: {url: string}) => {action: string}) | null = window.webContents.windowOpenHandler;
  if (!handler) throw new Error('The window has no window.open handler');
  return handler({url});
}

async function requestMedia(url: string): Promise<Response> {
  const handler: ((request: {url: string}) => Response | Promise<Response>) | undefined = h.world.protocolHandlers.get('media');
  if (!handler) throw new Error('The media:// protocol handler was never registered');
  return handler({url});
}

function mediaUrl(file: string): string {
  return `media://${encodeURIComponent(file)}`;
}

function lastOpenDialogOptions(): Record<string, unknown> {
  const calls: unknown[][] = h.electron.dialog.showOpenDialog.mock.calls;
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

function lastSaveDialogOptions(): Record<string, unknown> {
  const calls: unknown[][] = h.electron.dialog.showSaveDialog.mock.calls;
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

type WindowKind = 'main' | 'configuration' | 'about' | 'open-url' | 'setup-wizard';

const WINDOW_KINDS: readonly WindowKind[] = ['main', 'configuration', 'about', 'open-url', 'setup-wizard'];
const SECONDARY_WINDOW_KINDS: readonly WindowKind[] = ['configuration', 'about', 'open-url', 'setup-wizard'];

/** Boots the app and opens the requested kind of window. */
async function bootWithWindow(kind: WindowKind, options: BootOptions = {}): Promise<FakeWindow> {
  if (kind === 'setup-wizard') return bootIntoWizard(options);
  await boot(options);
  if (kind === 'configuration') {
    await invoke('window:showConfigurationWindow');
    return windowTitled(CONFIG_TITLE);
  }
  if (kind === 'about') {
    menuCallbacks()['onShowAbout']();
    return windowTitled(ABOUT_TITLE);
  }
  if (kind === 'open-url') {
    await invoke('window:showOpenUrlWindow');
    return windowTitled(OPEN_URL_TITLE);
  }
  return mainWindow();
}

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setPlatform(ORIGINAL_PLATFORM);
  process.argv = ORIGINAL_ARGV;
});

// ============================================================================
// Test suites
// ============================================================================

describe('main', (): void => {
  describe('before the app is ready', (): void => {
    it('should name the application ONIXPlayer', async (): Promise<void> => {
      await boot({deferReady: true});

      expect(h.electron.app.setName).toHaveBeenCalledWith('ONIXPlayer');
    });

    it('should allow playback to start without a user gesture', async (): Promise<void> => {
      await boot({deferReady: true});

      expect(h.electron.app.commandLine.appendSwitch).toHaveBeenCalledWith('autoplay-policy', 'no-user-gesture-required');
    });

    it('should register media as a secure, streaming, fetchable scheme', async (): Promise<void> => {
      await boot({deferReady: true});

      expect(h.electron.protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
        {scheme: 'media', privileges: {secure: true, supportFetchAPI: true, stream: true, bypassCSP: true}},
      ]);
    });

    it('should not create any window until Electron is ready', async (): Promise<void> => {
      await boot({deferReady: true});

      expect(h.world.created).toHaveLength(0);
    });
  });

  describe('single-instance lock', (): void => {
    it('should quit when another instance already holds the lock', async (): Promise<void> => {
      await boot({config: {gotLock: false}});

      expect(h.electron.app.quit).toHaveBeenCalledTimes(1);
    });

    it('should not wait for ready when another instance already holds the lock', async (): Promise<void> => {
      await boot({config: {gotLock: false}});

      expect(h.electron.app.whenReady).not.toHaveBeenCalled();
      expect(h.world.server).toBeNull();
    });

    it('should not quit when it obtains the lock', async (): Promise<void> => {
      await boot();

      expect(h.electron.app.quit).not.toHaveBeenCalled();
    });
  });

  describe('initialization', (): void => {
    it('should capture the renderer console in the log', async (): Promise<void> => {
      await boot();

      expect(h.loggerModule.initializeLogger).toHaveBeenCalledWith({spyRendererConsole: true});
    });

    it('should serve the built Angular app from the packaged app path in production', async (): Promise<void> => {
      await boot({config: {packaged: true, appPath: '/opt/onixplayer/app'}});

      expect(server().staticPath).toBe(path.join('/opt/onixplayer/app', 'dist', 'onixlabs-media-player', 'browser'));
    });

    it('should serve the built Angular app from the project root when run unpackaged', async (): Promise<void> => {
      await boot();

      expect(server().staticPath).toBe(path.join(process.cwd(), 'dist', 'onixlabs-media-player', 'browser'));
    });

    it('should not serve static files in development', async (): Promise<void> => {
      await boot({development: true});

      expect(server().staticPath).toBeUndefined();
    });

    it('should point FFmpeg at the system certificates before the media server starts', async (): Promise<void> => {
      await boot({config: {caBundle: '/etc/ssl/certs/ca-certificates.crt'}});

      const certificatesOrder: number = h.resources.useSystemCertificates.mock.invocationCallOrder[0];
      const startOrder: number = server().start.mock.invocationCallOrder[0];
      expect(certificatesOrder).toBeLessThan(startOrder);
    });

    it('should discard MIDI and tracker caches left by a previous session', async (): Promise<void> => {
      await boot();

      expect(server().nukeMidiCache).toHaveBeenCalledTimes(1);
      expect(server().nukeTrackerCache).toHaveBeenCalledTimes(1);
    });

    it('should load the main window from the media server in production', async (): Promise<void> => {
      await boot();

      expect(mainWindow().loadURL).toHaveBeenCalledWith(`${APP_ORIGIN}/`);
    });

    it('should load the main window from the development server in development', async (): Promise<void> => {
      await boot({development: true});

      expect(mainWindow().loadURL).toHaveBeenCalledWith(DEV_ORIGIN);
    });

    it('should honour DEV_SERVER_URL in development', async (): Promise<void> => {
      await boot({development: true, devServerUrl: 'http://localhost:9999'});

      expect(mainWindow().loadURL).toHaveBeenCalledWith('http://localhost:9999');
    });

    it('should enable Open in the menu when FFmpeg is installed', async (): Promise<void> => {
      await boot({config: {ffmpegInstalled: true, fluidsynthInstalled: false}});

      expect(lastMenuState('openEnabled')).toBe(true);
    });

    it('should enable Open in the menu when only FluidSynth is installed', async (): Promise<void> => {
      await boot({config: {ffmpegInstalled: false, fluidsynthInstalled: true}});

      expect(lastMenuState('openEnabled')).toBe(true);
    });

    it('should disable Open in the menu when no playback dependency is installed', async (): Promise<void> => {
      await boot({config: {ffmpegInstalled: false, fluidsynthInstalled: false}});

      expect(lastMenuState('openEnabled')).toBe(false);
    });

    it('should create exactly one window when setup is already complete', async (): Promise<void> => {
      await boot();

      expect(h.world.created).toHaveLength(1);
    });

    it('should not register the setup wizard handlers when setup is already complete', async (): Promise<void> => {
      await boot();

      expect(h.world.ipcHandlers.has('setup:complete')).toBe(false);
    });

    it('should seed the menu with the recent items from settings', async (): Promise<void> => {
      const recentFiles: {path: string; name: string}[] = [{path: '/music/a.mp3', name: 'a.mp3'}];
      const recentPlaylists: {path: string; name: string}[] = [{path: '/music/mix.opp', name: 'mix.opp'}];

      await boot({config: {recent: {recentFiles, recentPlaylists}}});

      expect(h.menu.createApplicationMenu.mock.calls[0][1]).toMatchObject({recentFiles, recentPlaylists});
    });

    it('should hide the developer tools menu in production', async (): Promise<void> => {
      await boot();

      expect(h.menu.createApplicationMenu.mock.calls[0][1]).toMatchObject({developerToolsEnabled: false});
    });

    it('should show the developer tools menu in development', async (): Promise<void> => {
      await boot({development: true});

      expect(h.menu.createApplicationMenu.mock.calls[0][1]).toMatchObject({developerToolsEnabled: true});
    });
  });

  describe('setup wizard', (): void => {
    it('should show the wizard when setup has not been completed for this version', async (): Promise<void> => {
      const wizard: FakeWindow = await bootIntoWizard();

      expect(wizard.loadURL).toHaveBeenCalledWith(`${DEV_ORIGIN}?window=setup-wizard`);
      expect(wizard.show).toHaveBeenCalledTimes(1);
    });

    it('should ask the settings whether setup was completed for the running version', async (): Promise<void> => {
      await boot({config: {version: '2026.12.0'}});

      expect(h.settings.isSetupCompleteForVersion).toHaveBeenCalledWith('2026.12.0');
    });

    it('should show the wizard when launched with --first-run even if setup is complete', async (): Promise<void> => {
      await boot({argv: ['electron', '.', '--first-run']});

      expect(windowsTitled(WIZARD_TITLE)).toHaveLength(1);
    });

    it('should load the wizard from the media server when packaged', async (): Promise<void> => {
      const wizard: FakeWindow = await bootIntoWizard({config: {packaged: true}});

      expect(wizard.loadURL).toHaveBeenCalledWith(`${APP_ORIGIN}/?window=setup-wizard`);
    });

    it('should hold back the main window while the wizard is open', async (): Promise<void> => {
      await bootIntoWizard();

      expect(windowsTitled(undefined)).toHaveLength(0);
    });

    it('should record the completed version when the wizard is completed', async (): Promise<void> => {
      await bootIntoWizard({config: {version: '2026.11.0'}});

      await invoke('setup:complete');

      expect(h.settings.markSetupComplete).toHaveBeenCalledWith('2026.11.0');
    });

    it('should open the main window once the wizard is completed', async (): Promise<void> => {
      await bootIntoWizard();

      await invoke('setup:complete');
      await initialized;

      expect(mainWindow().loadURL).toHaveBeenCalledWith(`${APP_ORIGIN}/`);
      expect(h.electron.app.quit).not.toHaveBeenCalled();
    });

    it('should open the main window without recording completion when the wizard is skipped', async (): Promise<void> => {
      await bootIntoWizard();

      await invoke('setup:skip');
      await initialized;

      expect(windowsTitled(undefined)).toHaveLength(1);
      expect(h.settings.markSetupComplete).not.toHaveBeenCalled();
    });

    it('should quit instead of opening the player when the wizard is closed directly', async (): Promise<void> => {
      const wizard: FakeWindow = await bootIntoWizard();

      wizard.close();
      await settle();

      expect(h.electron.app.quit).toHaveBeenCalledTimes(1);
      expect(windowsTitled(undefined)).toHaveLength(0);
    });

    it('should report the configured server port', async (): Promise<void> => {
      await bootIntoWizard({config: {configuredPort: 8080}});

      expect(await invoke('setup:getPort')).toBe(8080);
    });

    it('should store the chosen server port', async (): Promise<void> => {
      await bootIntoWizard();

      await invoke('setup:setPort', 8123);

      expect(h.settings.updateApplicationSettings).toHaveBeenCalledWith({serverPort: 8123});
    });

    it('should accept port 0 as automatic assignment', async (): Promise<void> => {
      await bootIntoWizard();

      expect(await invoke('setup:validatePort', 0)).toBe(true);
    });

    it.each([1, 80, 1023])('should reject privileged port %i', async (port: number): Promise<void> => {
      await bootIntoWizard();

      expect(await invoke('setup:validatePort', port)).toBe(false);
    });

    it.each([65536, 70000])('should reject out-of-range port %i', async (port: number): Promise<void> => {
      await bootIntoWizard();

      expect(await invoke('setup:validatePort', port)).toBe(false);
    });

    it('should reject a port that another listener already holds', async (): Promise<void> => {
      await bootIntoWizard();
      const occupant: nodeNet.Server = nodeNet.createServer();
      await new Promise<void>((resolve: () => void): void => {
        occupant.listen(0, '127.0.0.1', resolve);
      });
      const port: number = (occupant.address() as AddressInfo).port;

      try {
        expect(await invoke('setup:validatePort', port)).toBe(false);
      } finally {
        await new Promise<void>((resolve: () => void): void => {
          occupant.close((): void => resolve());
        });
      }
    });

    it('should accept a port nothing is listening on', async (): Promise<void> => {
      await bootIntoWizard();
      const probe: nodeNet.Server = nodeNet.createServer();
      await new Promise<void>((resolve: () => void): void => {
        probe.listen(0, '127.0.0.1', resolve);
      });
      const port: number = (probe.address() as AddressInfo).port;
      await new Promise<void>((resolve: () => void): void => {
        probe.close((): void => resolve());
      });

      expect(await invoke('setup:validatePort', port)).toBe(true);
    });

    it('should report the platform to the wizard', async (): Promise<void> => {
      await bootIntoWizard({platform: 'win32'});

      expect(await invoke('setup:getPlatform')).toBe('win32');
    });
  });

  describe('window security', (): void => {
    it.each(WINDOW_KINDS)('should isolate the %s window renderer from Node', async (kind: WindowKind): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind);

      expect(window.options.webPreferences).toMatchObject({
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      });
    });

    it.each(WINDOW_KINDS)('should give the %s window the compiled preload bridge', async (kind: WindowKind): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind);

      expect(window.options.webPreferences?.preload).toBe(path.join(process.cwd(), 'src', 'electron', 'dist', 'preload.js'));
    });

    it.each(WINDOW_KINDS)('should disable developer tools in the %s window in production', async (kind: WindowKind): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind);

      expect(window.options.webPreferences?.devTools).toBe(false);
    });

    it.each(WINDOW_KINDS)('should enable developer tools in the %s window in development', async (kind: WindowKind): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind, {development: true});

      expect(window.options.webPreferences?.devTools).toBe(true);
    });

    it('should resolve the preload bridge inside the app bundle when packaged', async (): Promise<void> => {
      await boot({config: {packaged: true, appPath: '/opt/onixplayer/app'}});

      expect(mainWindow().options.webPreferences?.preload).toBe(path.join('/opt/onixplayer/app', 'src', 'electron', 'dist', 'preload.js'));
    });

    it.each(['main', 'configuration', 'about', 'open-url'] as WindowKind[])('should lock pinch-zoom in the %s window', async (kind: WindowKind): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind);

      expect(window.webContents.setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 1);
    });

    it.each([
      {kind: 'main' as WindowKind, input: {control: true, meta: false, key: '+'}},
      {kind: 'main' as WindowKind, input: {control: false, meta: true, key: '-'}},
      {kind: 'main' as WindowKind, input: {control: true, meta: false, key: '='}},
      {kind: 'main' as WindowKind, input: {control: false, meta: true, key: '0'}},
      {kind: 'configuration' as WindowKind, input: {control: true, meta: false, key: '+'}},
      {kind: 'about' as WindowKind, input: {control: false, meta: true, key: '0'}},
      {kind: 'open-url' as WindowKind, input: {control: true, meta: false, key: '-'}},
    ])('should swallow the zoom shortcut $input in the $kind window', async ({kind, input}): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind);
      const event: {preventDefault: Mock<() => void>} = createEvent();

      window.webContents.emit('before-input-event', event, input);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it.each([
      {kind: 'main' as WindowKind, input: {control: false, meta: false, key: '+'}},
      {kind: 'main' as WindowKind, input: {control: true, meta: false, key: 'o'}},
      {kind: 'configuration' as WindowKind, input: {control: false, meta: false, key: '0'}},
      {kind: 'about' as WindowKind, input: {control: true, meta: false, key: 'a'}},
      {kind: 'open-url' as WindowKind, input: {control: false, meta: true, key: 'v'}},
    ])('should let the ordinary key press $input through in the $kind window', async ({kind, input}): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind);
      const event: {preventDefault: Mock<() => void>} = createEvent();

      window.webContents.emit('before-input-event', event, input);

      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('navigation lockdown', (): void => {
    it.each(WINDOW_KINDS)('should let the %s window navigate within the app origin', async (kind: WindowKind): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind, {config: {packaged: true}});

      expect(navigate(window, `${APP_ORIGIN}/?window=about`)).toBe(true);
    });

    it.each(WINDOW_KINDS)('should stop the %s window navigating to a remote site', async (kind: WindowKind): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind, {config: {packaged: true}});

      expect(navigate(window, 'https://evil.example/phish')).toBe(false);
    });

    it.each([
      ['another local port', 'http://127.0.0.1:1/'],
      ['the app port over https', `https://127.0.0.1:${PORT}/`],
      ['localhost instead of the loopback address', `http://localhost:${PORT}/`],
      ['a look-alike host', `http://127.0.0.1:${PORT}.evil.example/`],
      ['a file URL', 'file:///etc/passwd'],
      ['a javascript URL', 'javascript:alert(1)'],
      ['a data URL', 'data:text/html,<script>alert(1)</script>'],
      ['a malformed URL', 'not a url'],
    ])('should block navigation to %s', async (_label: string, url: string): Promise<void> => {
      await boot({config: {packaged: true}});

      expect(navigate(mainWindow(), url)).toBe(false);
    });

    it('should allow navigation to the development server when unpackaged', async (): Promise<void> => {
      await boot({development: true});

      expect(navigate(mainWindow(), `${DEV_ORIGIN}/settings`)).toBe(true);
    });

    it('should block navigation to the development server origin when packaged', async (): Promise<void> => {
      await boot({config: {packaged: true}});

      expect(navigate(mainWindow(), `${DEV_ORIGIN}/settings`)).toBe(false);
    });

    it.each(WINDOW_KINDS)('should deny window.open in the %s window', async (kind: WindowKind): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind);

      expect(openFromRenderer(window, 'https://example.com/')).toEqual({action: 'deny'});
    });

    it.each(['http://example.com/page', 'https://example.com/page'])('should hand %s to the system browser', async (url: string): Promise<void> => {
      await boot();

      openFromRenderer(mainWindow(), url);

      expect(h.electron.shell.openExternal).toHaveBeenCalledWith(url);
    });

    it.each([
      'file:///etc/passwd',
      'javascript:alert(1)',
      'smb://attacker.example/share',
      'ms-msdt:/id PCWDiagnostic',
      'about:blank',
      '',
    ])('should deny window.open for %j without launching anything', async (url: string): Promise<void> => {
      await boot();

      const result: {action: string} = openFromRenderer(mainWindow(), url);

      expect(result).toEqual({action: 'deny'});
      expect(h.electron.shell.openExternal).not.toHaveBeenCalled();
    });
  });

  describe('Content-Security-Policy', (): void => {
    function receivedHeaders(responseHeaders: Record<string, string[]> | undefined): Record<string, string[]> {
      const listener: typeof h.world.headersListener = h.world.headersListener;
      if (!listener) throw new Error('No onHeadersReceived listener was registered');
      const callback: Mock<(response: {responseHeaders?: Record<string, string[]>}) => void> = vi.fn();
      listener({responseHeaders}, callback);
      return callback.mock.calls[0][0].responseHeaders ?? {};
    }

    it('should not install a policy when unpackaged, where the dev server needs inline scripts', async (): Promise<void> => {
      await boot();

      expect(h.world.headersListener).toBeNull();
    });

    it('should add a policy to every response when packaged', async (): Promise<void> => {
      await boot({config: {packaged: true}});

      expect(receivedHeaders({})['Content-Security-Policy']).toHaveLength(1);
    });

    it('should keep the headers the server already sent', async (): Promise<void> => {
      await boot({config: {packaged: true}});

      const headers: Record<string, string[]> = receivedHeaders({'Content-Type': ['text/html']});

      expect(headers['Content-Type']).toEqual(['text/html']);
    });

    it.each([
      "default-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'none'",
    ])('should include the directive %s', async (directive: string): Promise<void> => {
      await boot({config: {packaged: true}});

      const directives: string[] = receivedHeaders(undefined)['Content-Security-Policy'][0].split('; ');

      expect(directives).toContain(directive);
    });

    it('should not permit inline or evaluated scripts', async (): Promise<void> => {
      await boot({config: {packaged: true}});

      const directives: string[] = receivedHeaders({})['Content-Security-Policy'][0].split('; ');
      const scriptSource: string | undefined = directives.find((directive: string): boolean => directive.startsWith('script-src'));

      expect(scriptSource).not.toContain('unsafe-inline');
      expect(scriptSource).not.toContain('unsafe-eval');
    });
  });

  describe('media:// protocol', (): void => {
    const song: string = path.resolve('/media/library/song one.mp3');
    const folder: string = path.resolve('/media/library');

    it('should serve a regular file through a file:// fetch', async (): Promise<void> => {
      await boot({files: {[song]: 'file'}});

      const response: Response = await requestMedia(mediaUrl(song));

      expect(h.electron.net.fetch).toHaveBeenCalledWith(`file://${song}`);
      expect(await response.text()).toBe('file-bytes');
    });

    it('should refuse a path that climbs out with ..', async (): Promise<void> => {
      const target: string = `${folder}${path.sep}..${path.sep}secret.txt`;
      await boot({files: {[target]: 'file'}});

      const response: Response = await requestMedia(`media://${target}`);

      expect(response.status).toBe(403);
      expect(h.electron.net.fetch).not.toHaveBeenCalled();
    });

    it('should refuse a traversal hidden behind percent-encoding', async (): Promise<void> => {
      await boot({files: {[song]: 'file'}});

      const response: Response = await requestMedia(`media://${encodeURIComponent(folder)}%2F%2e%2e%2Fsecret.txt`);

      expect(response.status).toBe(403);
      expect(h.electron.net.fetch).not.toHaveBeenCalled();
    });

    it('should refuse a relative path', async (): Promise<void> => {
      await boot({files: {'library/song.mp3': 'file'}});

      const response: Response = await requestMedia('media://library/song.mp3');

      expect(response.status).toBe(403);
      expect(h.electron.net.fetch).not.toHaveBeenCalled();
    });

    it('should refuse a path that is not in normalized form', async (): Promise<void> => {
      const sloppy: string = `${folder}${path.sep}${path.sep}song.mp3`;
      await boot({files: {[sloppy]: 'file'}});

      const response: Response = await requestMedia(mediaUrl(sloppy));

      expect(response.status).toBe(403);
      expect(h.electron.net.fetch).not.toHaveBeenCalled();
    });

    it('should refuse a directory', async (): Promise<void> => {
      await boot({files: {[folder]: 'directory'}});

      const response: Response = await requestMedia(mediaUrl(folder));

      expect(response.status).toBe(403);
      expect(h.electron.net.fetch).not.toHaveBeenCalled();
    });

    it('should answer 404 for a file that does not exist', async (): Promise<void> => {
      await boot();

      const response: Response = await requestMedia(mediaUrl(song));

      expect(response.status).toBe(404);
      expect(h.electron.net.fetch).not.toHaveBeenCalled();
    });
  });

  describe('main window appearance', (): void => {
    it('should open at the default size with a sensible minimum', async (): Promise<void> => {
      await boot();

      expect(mainWindow().options).toMatchObject({width: 960, height: 720, minWidth: 640, minHeight: 480});
    });

    it('should use a hidden inset title bar with vibrancy on macOS', async (): Promise<void> => {
      await boot({platform: 'darwin'});

      expect(mainWindow().options).toMatchObject({
        titleBarStyle: 'hiddenInset',
        vibrancy: 'fullscreen-ui',
        visualEffectState: 'active',
      });
    });

    it('should keep the macOS window out of fullscreen until media is loaded', async (): Promise<void> => {
      await boot({platform: 'darwin'});

      expect(mainWindow().options.fullscreenable).toBe(false);
    });

    it('should apply the configured macOS visual effect state', async (): Promise<void> => {
      await boot({platform: 'darwin', config: {appearance: {glassEnabled: true, macOSVisualEffectState: 'followWindow'}}});

      expect(mainWindow().options.visualEffectState).toBe('followWindow');
    });

    it('should replace vibrancy with the configured colour on macOS when glass is off', async (): Promise<void> => {
      await boot({platform: 'darwin', config: {appearance: {glassEnabled: false, backgroundColor: '#123456'}}});

      expect(mainWindow().options.backgroundColor).toBe('#123456');
      expect(mainWindow().options.vibrancy).toBeUndefined();
    });

    it('should set the dock icon on macOS when unpackaged', async (): Promise<void> => {
      await boot({platform: 'darwin'});

      expect(h.electron.app.dock.setIcon).toHaveBeenCalledWith(path.join(process.cwd(), 'public', 'icon-windows-linux.png'));
    });

    it('should leave the dock icon to the bundle on packaged macOS builds', async (): Promise<void> => {
      await boot({platform: 'darwin', config: {packaged: true}});

      expect(h.electron.app.dock.setIcon).not.toHaveBeenCalled();
    });

    it('should not touch the dock on other platforms', async (): Promise<void> => {
      await boot({platform: 'linux'});

      expect(h.electron.app.dock.setIcon).not.toHaveBeenCalled();
    });

    it('should default to an opaque window on Windows', async (): Promise<void> => {
      await boot({platform: 'win32'});

      expect(mainWindow().options.backgroundMaterial).toBeUndefined();
      expect(mainWindow().options.backgroundColor).toBe('#1e1e1e');
    });

    it('should use acrylic on Windows when glass is enabled', async (): Promise<void> => {
      await boot({platform: 'win32', config: {appearance: {glassEnabled: true}}});

      expect(mainWindow().options).toMatchObject({backgroundMaterial: 'acrylic', autoHideMenuBar: true});
      expect(mainWindow().options.backgroundColor).toBeUndefined();
    });

    it('should never request a blur effect on Linux', async (): Promise<void> => {
      await boot({platform: 'linux', config: {appearance: {glassEnabled: true, backgroundColor: '#abcdef'}}});

      expect(mainWindow().options).toMatchObject({backgroundColor: '#abcdef', autoHideMenuBar: true});
      expect(mainWindow().options.vibrancy).toBeUndefined();
      expect(mainWindow().options.backgroundMaterial).toBeUndefined();
    });

    it('should fall back to a dark background when the system theme is dark', async (): Promise<void> => {
      await boot({platform: 'linux', config: {dark: true}});

      expect(mainWindow().options.backgroundColor).toBe('#1e1e1e');
    });

    it('should fall back to a light background when the system theme is light', async (): Promise<void> => {
      await boot({platform: 'linux', config: {dark: false}});

      expect(mainWindow().options.backgroundColor).toBe('#e0e0e0');
    });

    it('should fall back to a dark background when the system theme cannot be read', async (): Promise<void> => {
      await boot({platform: 'linux', config: {themeThrows: true}});

      expect(mainWindow().options.backgroundColor).toBe('#1e1e1e');
    });
  });

  describe('secondary window appearance', (): void => {
    it.each(SECONDARY_WINDOW_KINDS)('should give the %s window vibrancy and inset traffic lights on macOS', async (kind: WindowKind): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind, {platform: 'darwin'});

      expect(window.options).toMatchObject({titleBarStyle: 'hiddenInset', vibrancy: 'fullscreen-ui', visualEffectState: 'active'});
    });

    it.each(SECONDARY_WINDOW_KINDS)('should give the %s window the configured colour on macOS when glass is off', async (kind: WindowKind): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind, {
        platform: 'darwin',
        config: {appearance: {glassEnabled: false, backgroundColor: '#123456'}},
      });

      expect(window.options.backgroundColor).toBe('#123456');
      expect(window.options.vibrancy).toBeUndefined();
    });

    it.each(SECONDARY_WINDOW_KINDS)('should give the %s window acrylic on Windows when glass is enabled', async (kind: WindowKind): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind, {platform: 'win32', config: {appearance: {glassEnabled: true}}});

      expect(window.options.backgroundMaterial).toBe('acrylic');
    });

    it.each(SECONDARY_WINDOW_KINDS)('should give the %s window an opaque background on Windows by default', async (kind: WindowKind): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind, {platform: 'win32', config: {dark: false}});

      expect(window.options.backgroundColor).toBe('#e0e0e0');
      expect(window.options.backgroundMaterial).toBeUndefined();
    });

    it.each(SECONDARY_WINDOW_KINDS)('should give the %s window an opaque background on Linux', async (kind: WindowKind): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind, {platform: 'linux'});

      expect(window.options.backgroundColor).toBe('#1e1e1e');
    });

    it.each(SECONDARY_WINDOW_KINDS)('should make the %s window a fixed-size dialog', async (kind: WindowKind): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind);

      expect(window.options).toMatchObject({resizable: false, minimizable: false, maximizable: false, fullscreenable: false, modal: false});
    });

    it.each(SECONDARY_WINDOW_KINDS)('should hide the menu bar of the %s window', async (kind: WindowKind): Promise<void> => {
      const window: FakeWindow = await bootWithWindow(kind);

      expect(window.setMenuBarVisibility).toHaveBeenCalledWith(false);
    });
  });

  describe('configuration window', (): void => {
    it('should load the configuration view from the development server when unpackaged', async (): Promise<void> => {
      await boot();

      await invoke('window:showConfigurationWindow');

      expect(windowTitled(CONFIG_TITLE).loadURL).toHaveBeenCalledWith(`${DEV_ORIGIN}?window=configuration`);
    });

    it('should load the configuration view from the media server when packaged', async (): Promise<void> => {
      await boot({config: {packaged: true}});

      await invoke('window:showConfigurationWindow');

      expect(windowTitled(CONFIG_TITLE).loadURL).toHaveBeenCalledWith(`${APP_ORIGIN}/?window=configuration`);
    });

    it('should open on the requested category', async (): Promise<void> => {
      await boot({config: {packaged: true}});

      await invoke('window:showConfigurationWindow', 'dependencies');

      expect(windowTitled(CONFIG_TITLE).loadURL).toHaveBeenCalledWith(`${APP_ORIGIN}/?window=configuration&category=dependencies`);
    });

    it('should open from the Settings menu item', async (): Promise<void> => {
      await boot();

      menuCallbacks()['onShowConfig']();

      expect(windowsTitled(CONFIG_TITLE)).toHaveLength(1);
    });

    it('should be a child of the main window', async (): Promise<void> => {
      await boot();

      await invoke('window:showConfigurationWindow');

      expect(windowTitled(CONFIG_TITLE).options.parent).toBe(mainWindow());
    });

    it('should stay hidden until its content is ready', async (): Promise<void> => {
      await boot();
      await invoke('window:showConfigurationWindow');
      const config: FakeWindow = windowTitled(CONFIG_TITLE);
      const shownBeforeReady: number = config.show.mock.calls.length;

      config.emit('ready-to-show');

      expect(config.options.show).toBe(false);
      expect(shownBeforeReady).toBe(0);
      expect(config.show).toHaveBeenCalledTimes(1);
    });

    it('should place itself on the left of the display, vertically centred', async (): Promise<void> => {
      await boot();

      await invoke('window:showConfigurationWindow');

      expect(windowTitled(CONFIG_TITLE).options).toMatchObject({x: 32, y: 240, center: false});
    });

    it('should move the main window to the right of the display, vertically centred', async (): Promise<void> => {
      await boot();

      await invoke('window:showConfigurationWindow');

      expect(mainWindow().getBounds()).toEqual({x: 928, y: 180, width: 960, height: 720});
    });

    it('should position relative to the work area of a secondary display', async (): Promise<void> => {
      await boot({config: {workArea: {x: 1920, y: 40, width: 2560, height: 1400}}});

      await invoke('window:showConfigurationWindow');

      expect(windowTitled(CONFIG_TITLE).options).toMatchObject({x: 1952, y: 440});
      expect(mainWindow().getBounds()).toEqual({x: 3488, y: 380, width: 960, height: 720});
    });

    it('should let the windows overlap on a display too narrow for both', async (): Promise<void> => {
      await boot({config: {workArea: {x: 0, y: 0, width: 1280, height: 800}}});

      await invoke('window:showConfigurationWindow');

      expect(windowTitled(CONFIG_TITLE).options).toMatchObject({x: 32, y: 100});
      expect(mainWindow().getBounds()).toEqual({x: 288, y: 40, width: 960, height: 720});
    });

    it('should put the main window back where it was when settings closes', async (): Promise<void> => {
      await boot();
      const original: {x: number; y: number; width: number; height: number} = mainWindow().getBounds();
      await invoke('window:showConfigurationWindow');

      windowTitled(CONFIG_TITLE).close();

      expect(mainWindow().getBounds()).toEqual(original);
    });

    it('should tell the renderer and the menu that settings opened', async (): Promise<void> => {
      await boot();

      await invoke('window:showConfigurationWindow');

      expect(sent(mainWindow(), 'config:openChanged')).toEqual([[true]]);
      expect(lastMenuState('configOpen')).toBe(true);
    });

    it('should tell the renderer and the menu that settings closed', async (): Promise<void> => {
      await boot();
      await invoke('window:showConfigurationWindow');

      windowTitled(CONFIG_TITLE).close();

      expect(sent(mainWindow(), 'config:openChanged')).toEqual([[true], [false]]);
      expect(lastMenuState('configOpen')).toBe(false);
    });

    it('should focus the existing window instead of opening a second one', async (): Promise<void> => {
      await boot();
      await invoke('window:showConfigurationWindow');

      await invoke('window:showConfigurationWindow');

      expect(windowsTitled(CONFIG_TITLE)).toHaveLength(1);
      expect(windowTitled(CONFIG_TITLE).focus).toHaveBeenCalledTimes(1);
    });

    it('should open a new window after the previous one was closed', async (): Promise<void> => {
      await boot();
      await invoke('window:showConfigurationWindow');
      windowTitled(CONFIG_TITLE).close();

      await invoke('window:showConfigurationWindow');

      expect(windowsTitled(CONFIG_TITLE)).toHaveLength(2);
    });

    it('should not open while the main window is fullscreen', async (): Promise<void> => {
      await boot();
      mainWindow().fullScreen = true;

      await invoke('window:showConfigurationWindow');

      expect(windowsTitled(CONFIG_TITLE)).toHaveLength(0);
    });

    it('should not open while the main window is in Windows simple fullscreen', async (): Promise<void> => {
      await boot({platform: 'win32'});
      mainWindow().simpleFullScreen = true;

      await invoke('window:showConfigurationWindow');

      expect(windowsTitled(CONFIG_TITLE)).toHaveLength(0);
    });

    it('should not open while in miniplayer mode', async (): Promise<void> => {
      await boot();
      await invoke('window:enterMiniplayer');

      await invoke('window:showConfigurationWindow');

      expect(windowsTitled(CONFIG_TITLE)).toHaveLength(0);
    });
  });

  describe('about window', (): void => {
    it('should load the about view', async (): Promise<void> => {
      await boot({config: {packaged: true}});

      menuCallbacks()['onShowAbout']();

      expect(windowTitled(ABOUT_TITLE).loadURL).toHaveBeenCalledWith(`${APP_ORIGIN}/?window=about`);
    });

    it('should load the about view from the development server when unpackaged', async (): Promise<void> => {
      await boot();

      menuCallbacks()['onShowAbout']();

      expect(windowTitled(ABOUT_TITLE).loadURL).toHaveBeenCalledWith(`${DEV_ORIGIN}?window=about`);
    });

    it('should be shown once its content is ready', async (): Promise<void> => {
      await boot();
      menuCallbacks()['onShowAbout']();
      const about: FakeWindow = windowTitled(ABOUT_TITLE);

      about.emit('ready-to-show');

      expect(about.options.show).toBe(false);
      expect(about.show).toHaveBeenCalledTimes(1);
    });

    it('should focus the existing window instead of opening a second one', async (): Promise<void> => {
      await boot();
      menuCallbacks()['onShowAbout']();

      menuCallbacks()['onShowAbout']();

      expect(windowsTitled(ABOUT_TITLE)).toHaveLength(1);
      expect(windowTitled(ABOUT_TITLE).focus).toHaveBeenCalledTimes(1);
    });

    it('should open a new window after the previous one was closed', async (): Promise<void> => {
      await boot();
      menuCallbacks()['onShowAbout']();
      windowTitled(ABOUT_TITLE).close();

      menuCallbacks()['onShowAbout']();

      expect(windowsTitled(ABOUT_TITLE)).toHaveLength(2);
    });
  });

  describe('Open URL window', (): void => {
    it('should load the open-url view', async (): Promise<void> => {
      await boot({config: {packaged: true}});

      await invoke('window:showOpenUrlWindow');

      expect(windowTitled(OPEN_URL_TITLE).loadURL).toHaveBeenCalledWith(`${APP_ORIGIN}/?window=open-url`);
    });

    it('should load the open-url view from the development server when unpackaged', async (): Promise<void> => {
      await boot();

      await invoke('window:showOpenUrlWindow');

      expect(windowTitled(OPEN_URL_TITLE).loadURL).toHaveBeenCalledWith(`${DEV_ORIGIN}?window=open-url`);
    });

    it('should open from the Open URL menu item', async (): Promise<void> => {
      await boot();

      menuCallbacks()['onOpenUrl']();

      expect(windowsTitled(OPEN_URL_TITLE)).toHaveLength(1);
    });

    it('should size itself by content so the renderer can fit it', async (): Promise<void> => {
      await boot();

      await invoke('window:showOpenUrlWindow');

      expect(windowTitled(OPEN_URL_TITLE).options).toMatchObject({useContentSize: true, width: 460});
    });

    it('should be shown once its content is ready', async (): Promise<void> => {
      await boot();
      await invoke('window:showOpenUrlWindow');
      const openUrl: FakeWindow = windowTitled(OPEN_URL_TITLE);

      openUrl.emit('ready-to-show');

      expect(openUrl.options.show).toBe(false);
      expect(openUrl.show).toHaveBeenCalledTimes(1);
    });

    it('should focus the existing window instead of opening a second one', async (): Promise<void> => {
      await boot();
      await invoke('window:showOpenUrlWindow');

      await invoke('window:showOpenUrlWindow');

      expect(windowsTitled(OPEN_URL_TITLE)).toHaveLength(1);
      expect(windowTitled(OPEN_URL_TITLE).focus).toHaveBeenCalledTimes(1);
    });

    it('should open a new window after the previous one was closed', async (): Promise<void> => {
      await boot();
      await invoke('window:showOpenUrlWindow');
      windowTitled(OPEN_URL_TITLE).close();

      await invoke('window:showOpenUrlWindow');

      expect(windowsTitled(OPEN_URL_TITLE)).toHaveLength(2);
    });
  });

  describe('core IPC handlers', (): void => {
    it('should report the media server port', async (): Promise<void> => {
      await boot();

      expect(await invoke('app:getServerPort')).toBe(PORT);
    });

    it('should hand out the session token for the HTTP API', async (): Promise<void> => {
      await boot();

      expect(await invoke('app:getServerToken')).toBe('session-token');
    });

    it('should be available to the setup wizard before the main window exists', async (): Promise<void> => {
      await bootIntoWizard();

      expect(await invoke('app:getServerPort')).toBe(PORT);
      expect(await invoke('app:getServerToken')).toBe('session-token');
    });

    it.each([
      {platform: 'darwin' as NodeJS.Platform, supportsGlass: true},
      {platform: 'win32' as NodeJS.Platform, supportsGlass: true},
      {platform: 'linux' as NodeJS.Platform, supportsGlass: false},
    ])('should report glass support as $supportsGlass on $platform', async ({platform, supportsGlass}): Promise<void> => {
      await boot({platform});

      expect(await invoke('app:getPlatformInfo')).toMatchObject({platform, supportsGlass});
    });

    it.each([
      {dark: true, systemTheme: 'dark'},
      {dark: false, systemTheme: 'light'},
    ])('should report the $systemTheme system theme', async ({dark, systemTheme}): Promise<void> => {
      await boot({config: {dark}});

      expect(await invoke('app:getPlatformInfo')).toMatchObject({systemTheme});
    });
  });

  describe('file dialogs', (): void => {
    const filters: {name: string; extensions: string[]}[] = [{name: 'Audio', extensions: ['mp3']}];

    it('should return the files picked in the open dialog', async (): Promise<void> => {
      await boot({config: {openDialogResult: {canceled: false, filePaths: ['/music/a.mp3', '/music/b.mp3']}}});

      const result: unknown = await invoke('dialog:openFile', {filters, multiSelections: true});

      expect(result).toEqual(['/music/a.mp3', '/music/b.mp3']);
    });

    it('should allow multiple selections only when asked', async (): Promise<void> => {
      await boot();

      await invoke('dialog:openFile', {filters, multiSelections: true});

      expect(lastOpenDialogOptions()).toEqual({properties: ['openFile', 'multiSelections'], filters});
    });

    it('should restrict the open dialog to a single file by default', async (): Promise<void> => {
      await boot();

      await invoke('dialog:openFile', {filters, multiSelections: false});

      expect(lastOpenDialogOptions()).toEqual({properties: ['openFile'], filters});
    });

    it('should attach the open dialog to the main window', async (): Promise<void> => {
      await boot();

      await invoke('dialog:openFile', {filters, multiSelections: false});

      expect(h.electron.dialog.showOpenDialog.mock.calls[0][0]).toBe(mainWindow());
    });

    it('should limit the SoundFont dialog to .sf2 files', async (): Promise<void> => {
      await boot();

      await invoke('dialog:openSoundFont');

      expect(lastOpenDialogOptions()).toMatchObject({
        properties: ['openFile'],
        filters: [{name: 'SoundFont Files', extensions: ['sf2']}],
      });
    });

    it('should return the chosen SoundFont', async (): Promise<void> => {
      await boot({config: {openDialogResult: {canceled: false, filePaths: ['/sf/piano.sf2']}}});

      expect(await invoke('dialog:openSoundFont')).toEqual(['/sf/piano.sf2']);
    });

    it('should return nothing when the SoundFont dialog is cancelled', async (): Promise<void> => {
      await boot({config: {openDialogResult: {canceled: true, filePaths: ['/sf/stale.sf2']}}});

      expect(await invoke('dialog:openSoundFont')).toEqual([]);
    });

    it('should limit the playlist dialog to .opp files', async (): Promise<void> => {
      await boot();

      await invoke('dialog:openPlaylist');

      expect(lastOpenDialogOptions()).toMatchObject({
        properties: ['openFile'],
        filters: [{name: 'ONIXPlayer Playlist', extensions: ['opp']}],
      });
    });

    it('should return the chosen playlist', async (): Promise<void> => {
      await boot({config: {openDialogResult: {canceled: false, filePaths: ['/music/mix.opp']}}});

      expect(await invoke('dialog:openPlaylist')).toBe('/music/mix.opp');
    });

    it('should return null when the playlist dialog is cancelled', async (): Promise<void> => {
      await boot({config: {openDialogResult: {canceled: true, filePaths: []}}});

      expect(await invoke('dialog:openPlaylist')).toBeNull();
    });

    it('should return null when the playlist dialog yields no file', async (): Promise<void> => {
      await boot({config: {openDialogResult: {canceled: false, filePaths: []}}});

      expect(await invoke('dialog:openPlaylist')).toBeNull();
    });

    it('should suggest playlist.opp when saving a playlist', async (): Promise<void> => {
      await boot();

      await invoke('dialog:savePlaylist');

      expect(lastSaveDialogOptions()).toMatchObject({
        defaultPath: 'playlist.opp',
        filters: [{name: 'ONIXPlayer Playlist', extensions: ['opp']}],
      });
    });

    it('should return the chosen playlist save path', async (): Promise<void> => {
      await boot({config: {saveDialogResult: {canceled: false, filePath: '/music/new.opp'}}});

      expect(await invoke('dialog:savePlaylist')).toBe('/music/new.opp');
    });

    it('should return null when saving a playlist is cancelled', async (): Promise<void> => {
      await boot({config: {saveDialogResult: {canceled: true, filePath: '/music/stale.opp'}}});

      expect(await invoke('dialog:savePlaylist')).toBeNull();
    });

    it('should return null when the playlist save dialog yields no path', async (): Promise<void> => {
      await boot({config: {saveDialogResult: {canceled: false, filePath: ''}}});

      expect(await invoke('dialog:savePlaylist')).toBeNull();
    });

    it('should limit the subtitle dialog to subtitle formats', async (): Promise<void> => {
      await boot();

      await invoke('dialog:openSubtitle');

      expect(lastOpenDialogOptions()).toMatchObject({
        properties: ['openFile'],
        filters: [{name: 'Subtitle Files', extensions: ['srt', 'vtt', 'ass', 'ssa']}],
      });
    });

    it('should return the chosen subtitle file', async (): Promise<void> => {
      await boot({config: {openDialogResult: {canceled: false, filePaths: ['/video/film.srt']}}});

      expect(await invoke('dialog:openSubtitle')).toBe('/video/film.srt');
    });

    it('should return null when the subtitle dialog is cancelled', async (): Promise<void> => {
      await boot({config: {openDialogResult: {canceled: true, filePaths: []}}});

      expect(await invoke('dialog:openSubtitle')).toBeNull();
    });

    it.each([
      {channel: 'dialog:openFile', args: [{filters, multiSelections: false}], expected: []},
      {channel: 'dialog:openSoundFont', args: [], expected: []},
      {channel: 'dialog:openPlaylist', args: [], expected: null},
      {channel: 'dialog:savePlaylist', args: [], expected: null},
      {channel: 'dialog:openSubtitle', args: [], expected: null},
      {channel: 'dialog:saveMedia', args: [{title: 'Clip', format: 'video'}], expected: null},
    ])('should answer $channel with an empty result and no dialog once the main window is gone', async ({channel, args, expected}): Promise<void> => {
      await boot({config: {openDialogResult: {canceled: false, filePaths: ['/x']}, saveDialogResult: {canceled: false, filePath: '/x'}}});
      mainWindow().destroy();

      const result: unknown = await invoke(channel, ...args);

      expect(result).toEqual(expected);
      expect(h.electron.dialog.showOpenDialog).not.toHaveBeenCalled();
      expect(h.electron.dialog.showSaveDialog).not.toHaveBeenCalled();
    });
  });

  describe('save media dialog', (): void => {
    it('should attach to the window that asked', async (): Promise<void> => {
      await boot();
      await invoke('window:showOpenUrlWindow');
      const openUrl: FakeWindow = windowTitled(OPEN_URL_TITLE);

      await invokeFrom(openUrl, 'dialog:saveMedia', {title: 'Clip', format: 'video'});

      expect(h.electron.dialog.showSaveDialog.mock.calls[0][0]).toBe(openUrl);
    });

    it('should fall back to the main window when the sender has no window', async (): Promise<void> => {
      await boot();

      await invoke('dialog:saveMedia', {title: 'Clip', format: 'video'});

      expect(h.electron.dialog.showSaveDialog.mock.calls[0][0]).toBe(mainWindow());
    });

    it('should offer an .mp4 name for video', async (): Promise<void> => {
      await boot();

      await invoke('dialog:saveMedia', {title: 'Holiday', format: 'video'});

      expect(lastSaveDialogOptions()).toMatchObject({
        defaultPath: 'Holiday.mp4',
        filters: [{name: 'MP4 Video', extensions: ['mp4']}],
      });
    });

    it('should offer an .mp3 name for audio', async (): Promise<void> => {
      await boot();

      await invoke('dialog:saveMedia', {title: 'Podcast', format: 'audio'});

      expect(lastSaveDialogOptions()).toMatchObject({
        defaultPath: 'Podcast.mp3',
        filters: [{name: 'MP3 Audio', extensions: ['mp3']}],
      });
    });

    it('should strip characters that are illegal in filenames', async (): Promise<void> => {
      await boot();

      await invoke('dialog:saveMedia', {title: ' AC/DC: "Back\\In|Black" <live>*? ', format: 'audio'});

      expect(lastSaveDialogOptions()['defaultPath']).toBe('ACDC BackInBlack live.mp3');
    });

    it('should not let a title smuggle a directory into the suggested name', async (): Promise<void> => {
      await boot();

      await invoke('dialog:saveMedia', {title: '../../etc/cron.d/job', format: 'video'});

      expect(lastSaveDialogOptions()['defaultPath']).not.toMatch(/[\\/]/);
    });

    it('should cap the suggested name at 80 characters', async (): Promise<void> => {
      await boot();

      await invoke('dialog:saveMedia', {title: 'a'.repeat(200), format: 'video'});

      expect(lastSaveDialogOptions()['defaultPath']).toBe(`${'a'.repeat(80)}.mp4`);
    });

    it('should not leave a trailing space when the cap lands on one', async (): Promise<void> => {
      await boot();

      await invoke('dialog:saveMedia', {title: `${'a'.repeat(79)} tail`, format: 'video'});

      expect(lastSaveDialogOptions()['defaultPath']).toBe(`${'a'.repeat(79)}.mp4`);
    });

    it.each(['', '   ', '???', '<>:"|'])('should offer "download" when the title %j sanitizes to nothing', async (title: string): Promise<void> => {
      await boot();

      await invoke('dialog:saveMedia', {title, format: 'video'});

      expect(lastSaveDialogOptions()['defaultPath']).toBe('download.mp4');
    });

    it('should return the chosen path', async (): Promise<void> => {
      await boot({config: {saveDialogResult: {canceled: false, filePath: '/downloads/clip.mp4'}}});

      expect(await invoke('dialog:saveMedia', {title: 'Clip', format: 'video'})).toBe('/downloads/clip.mp4');
    });

    it('should return null when cancelled', async (): Promise<void> => {
      await boot({config: {saveDialogResult: {canceled: true, filePath: '/downloads/stale.mp4'}}});

      expect(await invoke('dialog:saveMedia', {title: 'Clip', format: 'video'})).toBeNull();
    });

    it('should return null when the dialog yields no path', async (): Promise<void> => {
      await boot({config: {saveDialogResult: {canceled: false, filePath: ''}}});

      expect(await invoke('dialog:saveMedia', {title: 'Clip', format: 'video'})).toBeNull();
    });
  });

  describe('about information and licences', (): void => {
    it('should report the log file path', async (): Promise<void> => {
      await boot();

      expect(await invoke('app:getLogFilePath')).toBe('/logs/onixplayer.log');
    });

    it('should report the version, the shipped licences and the matching release URL', async (): Promise<void> => {
      const notices: {id: string; name: string}[] = [{id: 'ffmpeg', name: 'FFmpeg'}];
      await boot({config: {version: '2026.11.0', notices}});

      expect(await invoke('app:getAboutInfo')).toEqual({
        version: '2026.11.0',
        licenses: notices,
        sourceUrl: 'https://github.com/onix-labs/onixlabs-media-player/releases/tag/2026.11.0',
      });
    });

    it('should build the licence catalogue from the shipped licence locations and the app version', async (): Promise<void> => {
      await boot({config: {version: '2026.11.0'}});

      await invoke('app:getAboutInfo');

      expect(h.world.catalogs[0].locations).toEqual({root: '/licenses'});
      expect(h.world.catalogs[0].versions).toMatchObject({application: '2026.11.0'});
    });

    it('should read the licence catalogue only once', async (): Promise<void> => {
      await boot();

      await invoke('app:getAboutInfo');
      await invoke('app:getAboutInfo');
      await invoke('app:openLicense', 'ffmpeg');

      expect(h.world.catalogs).toHaveLength(1);
    });

    it('should open a known licence file', async (): Promise<void> => {
      await boot({config: {licenseFiles: new Map<unknown, string>([['ffmpeg', '/licenses/FFMPEG.txt']])}});

      const opened: unknown = await invoke('app:openLicense', 'ffmpeg');

      expect(opened).toBe(true);
      expect(h.electron.shell.openPath).toHaveBeenCalledWith('/licenses/FFMPEG.txt');
    });

    it.each(['unknown', '../../etc/passwd', '/etc/passwd', 42, null, undefined, {id: 'ffmpeg'}])(
      'should refuse to open anything for the unrecognized licence id %j',
      async (id: unknown): Promise<void> => {
        await boot({config: {licenseFiles: new Map<unknown, string>([['ffmpeg', '/licenses/FFMPEG.txt']])}});

        const opened: unknown = await invoke('app:openLicense', id);

        expect(opened).toBe(false);
        expect(h.electron.shell.openPath).not.toHaveBeenCalled();
      }
    );

    it('should report failure when the OS cannot open the licence file', async (): Promise<void> => {
      await boot({
        config: {
          licenseFiles: new Map<unknown, string>([['ffmpeg', '/licenses/FFMPEG.txt']]),
          openPathError: 'No application is associated with this file',
        },
      });

      expect(await invoke('app:openLicense', 'ffmpeg')).toBe(false);
    });
  });

  describe('fullscreen', (): void => {
    it('should enter native fullscreen on Linux and macOS', async (): Promise<void> => {
      await boot({platform: 'linux'});

      await invoke('window:enterFullscreen');

      expect(mainWindow().isFullScreen()).toBe(true);
      expect(mainWindow().setSimpleFullScreen).not.toHaveBeenCalled();
    });

    it('should warn the renderer before the transition starts', async (): Promise<void> => {
      await boot({platform: 'linux'});

      await invoke('window:enterFullscreen');

      expect(sentChannels(mainWindow())[0]).toBe('window:fullscreenTransitionStart');
    });

    it('should enter simple fullscreen on Windows', async (): Promise<void> => {
      await boot({platform: 'win32'});

      await invoke('window:enterFullscreen');

      expect(mainWindow().isSimpleFullScreen()).toBe(true);
      expect(mainWindow().setFullScreen).not.toHaveBeenCalled();
    });

    it('should bracket the synchronous Windows transition with start and end notices', async (): Promise<void> => {
      await boot({platform: 'win32'});

      await invoke('window:enterFullscreen');

      expect(sentChannels(mainWindow())).toEqual(['window:fullscreenTransitionStart', 'window:fullscreenTransitionEnd']);
    });

    it('should disable mode-gated menu items after entering fullscreen on Windows', async (): Promise<void> => {
      await boot({platform: 'win32'});

      await invoke('window:enterFullscreen');

      expect(lastMenuState('windowModeDefault')).toBe(false);
    });

    it('should refuse to enter fullscreen while settings is open', async (): Promise<void> => {
      await boot({platform: 'linux'});
      await invoke('window:showConfigurationWindow');

      await invoke('window:enterFullscreen');

      expect(mainWindow().isFullScreen()).toBe(false);
      expect(sent(mainWindow(), 'window:fullscreenTransitionStart')).toHaveLength(0);
    });

    it('should allow fullscreen again after settings closes', async (): Promise<void> => {
      await boot({platform: 'linux'});
      await invoke('window:showConfigurationWindow');
      windowTitled(CONFIG_TITLE).close();

      await invoke('window:enterFullscreen');

      expect(mainWindow().isFullScreen()).toBe(true);
    });

    it('should leave native fullscreen on Linux and macOS', async (): Promise<void> => {
      await boot({platform: 'linux'});
      await invoke('window:enterFullscreen');

      await invoke('window:exitFullscreen');

      expect(mainWindow().isFullScreen()).toBe(false);
    });

    it('should leave simple fullscreen on Windows and re-enable mode-gated menu items', async (): Promise<void> => {
      await boot({platform: 'win32'});
      await invoke('window:enterFullscreen');

      await invoke('window:exitFullscreen');

      expect(mainWindow().isSimpleFullScreen()).toBe(false);
      expect(lastMenuState('windowModeDefault')).toBe(true);
      expect(sent(mainWindow(), 'window:fullscreenTransitionEnd')).toHaveLength(2);
    });

    it('should report native fullscreen state on Linux and macOS', async (): Promise<void> => {
      await boot({platform: 'darwin'});
      const before: unknown = await invoke('window:isFullscreen');

      await invoke('window:enterFullscreen');

      expect(before).toBe(false);
      expect(await invoke('window:isFullscreen')).toBe(true);
    });

    it('should report simple fullscreen state on Windows', async (): Promise<void> => {
      await boot({platform: 'win32'});
      const before: unknown = await invoke('window:isFullscreen');

      await invoke('window:enterFullscreen');

      expect(before).toBe(false);
      expect(await invoke('window:isFullscreen')).toBe(true);
    });

    it.each(['linux', 'win32'] as NodeJS.Platform[])('should report not fullscreen on %s once the main window is gone', async (platform: NodeJS.Platform): Promise<void> => {
      await boot({platform});
      mainWindow().destroy();

      expect(await invoke('window:isFullscreen')).toBe(false);
    });

    it('should tell the renderer when native fullscreen has been entered', async (): Promise<void> => {
      await boot({platform: 'darwin'});

      mainWindow().setFullScreen(true);

      expect(sent(mainWindow(), 'window:fullscreenTransitionEnd')).toHaveLength(1);
      expect(sent(mainWindow(), 'window:fullscreenChanged')).toEqual([[true]]);
      expect(sent(mainWindow(), 'window:viewModeChanged')).toEqual([['fullscreen']]);
    });

    it('should disable mode-gated menu items while in native fullscreen', async (): Promise<void> => {
      await boot({platform: 'darwin'});

      mainWindow().setFullScreen(true);

      expect(lastMenuState('windowModeDefault')).toBe(false);
    });

    it('should tell the renderer it is back in desktop mode when native fullscreen ends', async (): Promise<void> => {
      await boot({platform: 'darwin'});
      mainWindow().setFullScreen(true);

      mainWindow().setFullScreen(false);

      expect(sent(mainWindow(), 'window:fullscreenChanged')).toEqual([[true], [false]]);
      expect(sent(mainWindow(), 'window:viewModeChanged')).toEqual([['fullscreen'], ['desktop']]);
      expect(lastMenuState('windowModeDefault')).toBe(true);
    });

    it('should report miniplayer as the mode returned to when fullscreen ends in miniplayer mode', async (): Promise<void> => {
      await boot({platform: 'darwin'});
      await invoke('window:enterMiniplayer');

      mainWindow().emit('leave-full-screen');

      expect(sent(mainWindow(), 'window:viewModeChanged')).toEqual([['miniplayer'], ['miniplayer']]);
    });

    it('should toggle native fullscreen from the menu', async (): Promise<void> => {
      await boot({platform: 'linux'});

      menuCallbacks()['onToggleFullscreen']();
      const afterFirstToggle: boolean = mainWindow().isFullScreen();
      menuCallbacks()['onToggleFullscreen']();

      expect(afterFirstToggle).toBe(true);
      expect(mainWindow().isFullScreen()).toBe(false);
    });

    it('should toggle simple fullscreen from the menu on Windows and tell the renderer', async (): Promise<void> => {
      await boot({platform: 'win32'});

      menuCallbacks()['onToggleFullscreen']();
      const afterFirstToggle: boolean = mainWindow().isSimpleFullScreen();
      menuCallbacks()['onToggleFullscreen']();

      expect(afterFirstToggle).toBe(true);
      expect(mainWindow().isSimpleFullScreen()).toBe(false);
      expect(sent(mainWindow(), 'window:fullscreenChanged')).toEqual([[true], [false]]);
    });

    it('should ignore the fullscreen menu item once the main window is gone', async (): Promise<void> => {
      await boot({platform: 'linux'});
      const window: FakeWindow = mainWindow();
      window.destroy();

      menuCallbacks()['onToggleFullscreen']();

      expect(window.setFullScreen).not.toHaveBeenCalled();
    });
  });

  describe('miniplayer', (): void => {
    it('should shrink the window into the bottom-right corner by default', async (): Promise<void> => {
      await boot();

      await invoke('window:enterMiniplayer');

      expect(mainWindow().getBounds()).toEqual({x: 1590, y: 870, width: 320, height: 200});
    });

    it('should float above other windows within miniplayer size limits', async (): Promise<void> => {
      await boot();

      await invoke('window:enterMiniplayer');

      expect(mainWindow().setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
      expect(mainWindow().setMinimumSize).toHaveBeenCalledWith(320, 200);
      expect(mainWindow().setMaximumSize).toHaveBeenCalledWith(640, 400);
    });

    it('should tell the renderer and the menu about the new mode', async (): Promise<void> => {
      await boot();

      await invoke('window:enterMiniplayer');

      expect(sent(mainWindow(), 'window:viewModeChanged')).toEqual([['miniplayer']]);
      expect(lastMenuState('windowModeDefault')).toBe(false);
    });

    it('should restore the saved miniplayer position and size', async (): Promise<void> => {
      await boot({config: {miniplayerBounds: {x: 500, y: 400, width: 400, height: 250}}});

      await invoke('window:enterMiniplayer');

      expect(mainWindow().getBounds()).toEqual({x: 500, y: 400, width: 400, height: 250});
      expect(h.settings.setMiniplayerBounds).not.toHaveBeenCalled();
    });

    it.each([
      {saved: {width: 2000, height: 50}, expected: {width: 640, height: 200}},
      {saved: {width: 10, height: 5000}, expected: {width: 320, height: 400}},
    ])('should clamp a saved size of $saved to $expected', async ({saved, expected}): Promise<void> => {
      await boot({config: {miniplayerBounds: {x: 500, y: 400, ...saved}}});

      await invoke('window:enterMiniplayer');

      expect(mainWindow().getBounds()).toMatchObject(expected);
    });

    it.each([
      {label: 'left of and below', saved: {x: -500, y: 5000}, expected: {x: 10, y: 820}},
      {label: 'right of and above', saved: {x: 5000, y: -50}, expected: {x: 1510, y: 10}},
    ])('should pull a saved position $label the display back on screen and remember it', async ({saved, expected}): Promise<void> => {
      await boot({config: {miniplayerBounds: {...saved, width: 400, height: 250}}});

      await invoke('window:enterMiniplayer');

      expect(mainWindow().getBounds()).toEqual({...expected, width: 400, height: 250});
      expect(h.settings.setMiniplayerBounds).toHaveBeenCalledWith({...expected, width: 400, height: 250});
    });

    it('should refuse to enter miniplayer while settings is open', async (): Promise<void> => {
      await boot();
      await invoke('window:showConfigurationWindow');

      await invoke('window:enterMiniplayer');

      expect(mainWindow().setAlwaysOnTop).not.toHaveBeenCalled();
      expect(await invoke('window:getViewMode')).toBe('desktop');
    });

    it('should do nothing once the main window is gone', async (): Promise<void> => {
      await boot();
      const window: FakeWindow = mainWindow();
      window.destroy();

      await invoke('window:enterMiniplayer');

      expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
    });

    it('should leave native fullscreen before shrinking', async (): Promise<void> => {
      await boot({platform: 'darwin'});
      mainWindow().setFullScreen(true);

      await invoke('window:enterMiniplayer');

      expect(mainWindow().isFullScreen()).toBe(false);
      expect(mainWindow().getBounds()).toMatchObject({width: 320, height: 200});
    });

    it('should leave simple fullscreen before shrinking on Windows', async (): Promise<void> => {
      await boot({platform: 'win32'});
      mainWindow().setSimpleFullScreen(true);

      await invoke('window:enterMiniplayer');

      expect(mainWindow().isSimpleFullScreen()).toBe(false);
      expect(mainWindow().getBounds()).toMatchObject({width: 320, height: 200});
    });

    it('should restore the desktop bounds when leaving miniplayer', async (): Promise<void> => {
      await boot();
      const desktop: {x: number; y: number; width: number; height: number} = mainWindow().getBounds();
      await invoke('window:enterMiniplayer');

      await invoke('window:exitMiniplayer');

      expect(mainWindow().getBounds()).toEqual(desktop);
    });

    it('should make the window an ordinary resizable window again when leaving miniplayer', async (): Promise<void> => {
      await boot();
      await invoke('window:enterMiniplayer');

      await invoke('window:exitMiniplayer');

      expect(mainWindow().setAlwaysOnTop).toHaveBeenLastCalledWith(false);
      expect(mainWindow().setResizable).toHaveBeenLastCalledWith(true);
      expect(mainWindow().setMinimumSize).toHaveBeenLastCalledWith(800, 600);
    });

    it('should remember where the miniplayer was when leaving it', async (): Promise<void> => {
      await boot();
      await invoke('window:enterMiniplayer');
      mainWindow().bounds = {x: 700, y: 300, width: 480, height: 300};

      await invoke('window:exitMiniplayer');

      expect(h.settings.setMiniplayerBounds).toHaveBeenCalledWith({x: 700, y: 300, width: 480, height: 300});
    });

    it('should tell the renderer and the menu when desktop mode is restored', async (): Promise<void> => {
      await boot();
      await invoke('window:enterMiniplayer');

      await invoke('window:exitMiniplayer');

      expect(sent(mainWindow(), 'window:viewModeChanged')).toEqual([['miniplayer'], ['desktop']]);
      expect(lastMenuState('windowModeDefault')).toBe(true);
    });

    it('should keep the current bounds when leaving a miniplayer that was never entered', async (): Promise<void> => {
      await boot();
      const before: {x: number; y: number; width: number; height: number} = mainWindow().getBounds();

      await invoke('window:exitMiniplayer');

      expect(mainWindow().getBounds()).toEqual(before);
    });

    it('should ignore leaving miniplayer once the main window is gone', async (): Promise<void> => {
      await boot();
      mainWindow().destroy();

      await invoke('window:exitMiniplayer');

      expect(h.settings.setMiniplayerBounds).not.toHaveBeenCalled();
    });

    it('should report desktop as the initial view mode', async (): Promise<void> => {
      await boot();

      expect(await invoke('window:getViewMode')).toBe('desktop');
    });

    it('should report miniplayer as the view mode after entering it', async (): Promise<void> => {
      await boot();

      await invoke('window:enterMiniplayer');

      expect(await invoke('window:getViewMode')).toBe('miniplayer');
    });

    it('should report fullscreen as the view mode while fullscreen', async (): Promise<void> => {
      await boot();

      await invoke('window:enterFullscreen');

      expect(await invoke('window:getViewMode')).toBe('fullscreen');
    });

    it('should save the miniplayer bounds on request while in miniplayer mode', async (): Promise<void> => {
      await boot();
      await invoke('window:enterMiniplayer');
      mainWindow().bounds = {x: 42, y: 24, width: 400, height: 240};

      await invoke('window:saveMiniplayerBounds');

      expect(h.settings.setMiniplayerBounds).toHaveBeenCalledWith({x: 42, y: 24, width: 400, height: 240});
    });

    it('should not save desktop bounds as miniplayer bounds', async (): Promise<void> => {
      await boot();

      await invoke('window:saveMiniplayerBounds');

      expect(h.settings.setMiniplayerBounds).not.toHaveBeenCalled();
    });

    it('should save the miniplayer bounds once after a burst of resizes settles', async (): Promise<void> => {
      await boot();
      await invoke('window:enterMiniplayer');
      vi.useFakeTimers();

      mainWindow().emit('resized');
      vi.advanceTimersByTime(200);
      mainWindow().bounds = {x: 1500, y: 800, width: 500, height: 320};
      mainWindow().emit('resized');
      vi.advanceTimersByTime(300);

      expect(h.settings.setMiniplayerBounds).toHaveBeenCalledTimes(1);
      expect(h.settings.setMiniplayerBounds).toHaveBeenCalledWith({x: 1500, y: 800, width: 500, height: 320});
    });

    it('should wait for resizing to settle before saving', async (): Promise<void> => {
      await boot();
      await invoke('window:enterMiniplayer');
      vi.useFakeTimers();

      mainWindow().emit('resized');
      vi.advanceTimersByTime(299);

      expect(h.settings.setMiniplayerBounds).not.toHaveBeenCalled();
    });

    it('should not save bounds when the desktop window is resized', async (): Promise<void> => {
      await boot();
      vi.useFakeTimers();

      mainWindow().emit('resized');
      vi.advanceTimersByTime(1000);

      expect(h.settings.setMiniplayerBounds).not.toHaveBeenCalled();
    });
  });

  describe('miniplayer on focus loss', (): void => {
    const SETTLE_DELAY: number = 150;

    async function bootPlaying(options: BootOptions = {}): Promise<void> {
      await boot({...options, config: {miniplayerOnFocusLoss: true, ...options.config}});
      serverCallback('playbackStateChange')(true);
      vi.useFakeTimers();
    }

    it('should switch to the miniplayer when the app loses focus during playback', async (): Promise<void> => {
      await bootPlaying();

      mainWindow().emit('blur');
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY);

      expect(await invoke('window:getViewMode')).toBe('miniplayer');
    });

    it('should wait for focus to settle before switching', async (): Promise<void> => {
      await bootPlaying();

      mainWindow().emit('blur');
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY - 1);

      expect(await invoke('window:getViewMode')).toBe('desktop');
    });

    it('should stay in desktop mode when focus moved to another of the app windows', async (): Promise<void> => {
      await bootPlaying();
      menuCallbacks()['onShowAbout']();
      h.world.focusedWindow = windowTitled(ABOUT_TITLE);

      mainWindow().emit('blur');
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY);

      expect(await invoke('window:getViewMode')).toBe('desktop');
    });

    it('should stay in desktop mode when the setting is off', async (): Promise<void> => {
      await bootPlaying({config: {miniplayerOnFocusLoss: false}});

      mainWindow().emit('blur');
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY);

      expect(await invoke('window:getViewMode')).toBe('desktop');
    });

    it('should stay in desktop mode when nothing is playing', async (): Promise<void> => {
      await bootPlaying();
      serverCallback('playbackStateChange')(false);

      mainWindow().emit('blur');
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY);

      expect(await invoke('window:getViewMode')).toBe('desktop');
    });

    it('should stay fullscreen when a fullscreen window loses focus', async (): Promise<void> => {
      await bootPlaying();
      mainWindow().setFullScreen(true);

      mainWindow().emit('blur');
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY);

      expect(mainWindow().isFullScreen()).toBe(true);
      expect(mainWindow().setAlwaysOnTop).not.toHaveBeenCalled();
    });

    it('should stay in simple fullscreen when a Windows fullscreen window loses focus', async (): Promise<void> => {
      await bootPlaying({platform: 'win32'});
      mainWindow().setSimpleFullScreen(true);

      mainWindow().emit('blur');
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY);

      expect(mainWindow().isSimpleFullScreen()).toBe(true);
      expect(mainWindow().setAlwaysOnTop).not.toHaveBeenCalled();
    });

    it('should not re-enter the miniplayer when it is already active', async (): Promise<void> => {
      await bootPlaying();
      await invoke('window:enterMiniplayer');

      mainWindow().emit('blur');
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY);

      expect(mainWindow().setAlwaysOnTop).toHaveBeenCalledTimes(1);
    });

    it('should not switch when the miniplayer was entered while focus was settling', async (): Promise<void> => {
      await bootPlaying();

      mainWindow().emit('blur');
      await invoke('window:enterMiniplayer');
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY);

      expect(mainWindow().setAlwaysOnTop).toHaveBeenCalledTimes(1);
    });

    it('should not switch while the window is closing', async (): Promise<void> => {
      await bootPlaying();
      mainWindow().close();

      mainWindow().emit('blur');
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY);

      expect(mainWindow().setAlwaysOnTop).not.toHaveBeenCalled();
    });
  });

  describe('window geometry IPC', (): void => {
    it('should report the main window position', async (): Promise<void> => {
      await boot();
      mainWindow().bounds = {x: 321, y: 123, width: 960, height: 720};

      expect(await invoke('window:getWindowPosition')).toEqual({x: 321, y: 123});
    });

    it('should report the origin once the main window is gone', async (): Promise<void> => {
      await boot();
      mainWindow().destroy();

      expect(await invoke('window:getWindowPosition')).toEqual({x: 0, y: 0});
    });

    it('should move the window to a position away from every edge unchanged', async (): Promise<void> => {
      await boot();

      const result: unknown = await invoke('window:setWindowPosition', {x: 400, y: 150});

      expect(result).toEqual({x: 400, y: 150});
      expect(mainWindow().getPosition()).toEqual([400, 150]);
    });

    it('should snap to the top-left corner with a gap when dropped near it', async (): Promise<void> => {
      await boot();

      const result: unknown = await invoke('window:setWindowPosition', {x: 30, y: 25});

      expect(result).toEqual({x: 10, y: 10});
      expect(mainWindow().getPosition()).toEqual([10, 10]);
    });

    it('should snap to the bottom-right corner with a gap when dropped near it', async (): Promise<void> => {
      await boot();

      const result: unknown = await invoke('window:setWindowPosition', {x: 930, y: 340});

      expect(result).toEqual({x: 950, y: 350});
      expect(mainWindow().getPosition()).toEqual([950, 350]);
    });

    it('should snap relative to the work area of the display under the window', async (): Promise<void> => {
      await boot({config: {workArea: {x: 1920, y: 40, width: 1920, height: 1040}}});

      const result: unknown = await invoke('window:setWindowPosition', {x: 1925, y: 45});

      expect(result).toEqual({x: 1930, y: 50});
    });

    it('should echo the requested position once the main window is gone', async (): Promise<void> => {
      await boot();
      mainWindow().destroy();

      expect(await invoke('window:setWindowPosition', {x: 30, y: 25})).toEqual({x: 30, y: 25});
    });

    it.each([true, false])('should set macOS traffic light visibility to %s', async (visible: boolean): Promise<void> => {
      await boot({platform: 'darwin'});

      await invoke('window:setTrafficLightVisibility', visible);

      expect(mainWindow().setWindowButtonVisibility).toHaveBeenCalledWith(visible);
    });

    it.each(['win32', 'linux'] as NodeJS.Platform[])('should ignore traffic light requests on %s', async (platform: NodeJS.Platform): Promise<void> => {
      await boot({platform});

      await invoke('window:setTrafficLightVisibility', false);

      expect(mainWindow().setWindowButtonVisibility).not.toHaveBeenCalled();
    });

    it('should resize the calling window, not the main window, to its content height', async (): Promise<void> => {
      await boot();
      await invoke('window:showOpenUrlWindow');
      const openUrl: FakeWindow = windowTitled(OPEN_URL_TITLE);

      await invokeFrom(openUrl, 'window:setContentHeight', 340);

      expect(openUrl.setContentSize).toHaveBeenCalledWith(460, 340);
      expect(mainWindow().setContentSize).not.toHaveBeenCalled();
    });

    it('should round a fractional content height up so nothing is clipped', async (): Promise<void> => {
      await boot();
      await invoke('window:showOpenUrlWindow');
      const openUrl: FakeWindow = windowTitled(OPEN_URL_TITLE);

      await invokeFrom(openUrl, 'window:setContentHeight', 340.2);

      expect(openUrl.setContentSize).toHaveBeenCalledWith(460, 341);
    });

    it('should cap the content height at the height of the display work area', async (): Promise<void> => {
      await boot();
      await invoke('window:showOpenUrlWindow');
      const openUrl: FakeWindow = windowTitled(OPEN_URL_TITLE);

      await invokeFrom(openUrl, 'window:setContentHeight', 99999);

      expect(openUrl.setContentSize).toHaveBeenCalledWith(460, 1080);
    });

    it.each([0, -50])('should never collapse the window for a content height of %i', async (height: number): Promise<void> => {
      await boot();
      await invoke('window:showOpenUrlWindow');
      const openUrl: FakeWindow = windowTitled(OPEN_URL_TITLE);

      await invokeFrom(openUrl, 'window:setContentHeight', height);

      expect(openUrl.setContentSize).toHaveBeenCalledWith(460, 1);
    });

    it('should ignore a content height request from a sender with no window', async (): Promise<void> => {
      await boot();

      await invoke('window:setContentHeight', 340);

      expect(mainWindow().setContentSize).not.toHaveBeenCalled();
    });

    it('should minimize the main window', async (): Promise<void> => {
      await boot();

      await invoke('window:minimize');

      expect(mainWindow().minimize).toHaveBeenCalledTimes(1);
    });

    it('should start closing the main window on request from the renderer', async (): Promise<void> => {
      await boot();
      vi.useFakeTimers();

      await invoke('window:close');

      expect(sent(mainWindow(), 'app:prepareForClose')).toHaveLength(1);
    });
  });

  describe('recent items', (): void => {
    const recent: {recentFiles: {path: string; name: string}[]; recentPlaylists: {path: string; name: string}[]} = {
      recentFiles: [{path: '/music/a.mp3', name: 'a.mp3'}],
      recentPlaylists: [{path: '/music/mix.opp', name: 'mix.opp'}],
    };

    it('should clear the stored recent items on request from the renderer', async (): Promise<void> => {
      await boot({config: {recent}});

      await invoke('app:clearRecentItems');

      expect(h.settings.clearRecentItems).toHaveBeenCalledTimes(1);
    });

    it('should empty the Recent menu after clearing from the renderer', async (): Promise<void> => {
      await boot({config: {recent}});

      await invoke('app:clearRecentItems');

      expect(lastMenuState('recentFiles')).toEqual([]);
      expect(lastMenuState('recentPlaylists')).toEqual([]);
    });

    it('should clear the recent items from the Clear Recent menu item', async (): Promise<void> => {
      await boot({config: {recent}});

      menuCallbacks()['onClearRecent']();

      expect(h.settings.clearRecentItems).toHaveBeenCalledTimes(1);
      expect(lastMenuState('recentFiles')).toEqual([]);
    });

    it('should refresh the Recent menu when the media server reports new recent items', async (): Promise<void> => {
      await boot();

      serverCallback('recentItemsChange')(recent.recentFiles, recent.recentPlaylists);

      expect(lastMenuState('recentFiles')).toEqual(recent.recentFiles);
      expect(lastMenuState('recentPlaylists')).toEqual(recent.recentPlaylists);
    });
  });

  describe('menu callbacks', (): void => {
    it.each([
      {callback: 'onShowHelp', channel: 'menu:showHelp'},
      {callback: 'onOpenFile', channel: 'menu:openFile'},
      {callback: 'onOpenPlaylist', channel: 'menu:openPlaylist'},
      {callback: 'onSavePlaylist', channel: 'menu:savePlaylist'},
      {callback: 'onSavePlaylistAs', channel: 'menu:savePlaylistAs'},
      {callback: 'onCloseMedia', channel: 'menu:closeMedia'},
      {callback: 'onClosePlaylist', channel: 'menu:closeAll'},
      {callback: 'onTogglePlayPause', channel: 'menu:togglePlayPause'},
      {callback: 'onStop', channel: 'menu:stop'},
      {callback: 'onToggleShuffle', channel: 'menu:toggleShuffle'},
      {callback: 'onToggleRepeat', channel: 'menu:toggleRepeat'},
    ])('should send $channel to the renderer for $callback', async ({callback, channel}): Promise<void> => {
      await boot();

      menuCallbacks()[callback]();

      expect(sent(mainWindow(), channel)).toEqual([[]]);
    });

    it.each([
      {callback: 'onOpenRecentFile', channel: 'menu:openRecentFile', argument: '/music/a.mp3'},
      {callback: 'onOpenRecentPlaylist', channel: 'menu:openRecentPlaylist', argument: '/music/mix.opp'},
      {callback: 'onSelectVisualization', channel: 'menu:selectVisualization', argument: 'spectrum'},
      {callback: 'onSelectAspectMode', channel: 'menu:selectAspectMode', argument: '16:9'},
    ])('should send $channel with its argument for $callback', async ({callback, channel, argument}): Promise<void> => {
      await boot();

      menuCallbacks()[callback](argument);

      expect(sent(mainWindow(), channel)).toEqual([[argument]]);
    });

    it('should not throw when a menu item is used after the main window is gone', async (): Promise<void> => {
      await boot();
      const window: FakeWindow = mainWindow();
      window.destroy();
      const sentBefore: number = window.webContents.send.mock.calls.length;

      menuCallbacks()['onTogglePlayPause']();

      expect(window.webContents.send).toHaveBeenCalledTimes(sentBefore);
    });
  });

  describe('media server callbacks', (): void => {
    it('should reflect shuffle and repeat changes in the menu', async (): Promise<void> => {
      await boot();

      serverCallback('modeChange')(true, false);

      expect(lastMenuState('shuffleEnabled')).toBe(true);
      expect(lastMenuState('repeatEnabled')).toBe(false);
    });

    it.each([
      {count: 3, hasMedia: true},
      {count: 0, hasMedia: false},
    ])('should set hasMedia to $hasMedia in the menu for a playlist of $count', async ({count, hasMedia}): Promise<void> => {
      await boot();

      serverCallback('playlistCountChange')(count);

      expect(lastMenuState('hasMedia')).toBe(hasMedia);
    });

    it.each([
      {count: 1, fullscreenable: true},
      {count: 0, fullscreenable: false},
    ])('should set the macOS fullscreen button to $fullscreenable for a playlist of $count', async ({count, fullscreenable}): Promise<void> => {
      await boot({platform: 'darwin'});

      serverCallback('playlistCountChange')(count);

      expect(mainWindow().setFullScreenable).toHaveBeenLastCalledWith(fullscreenable);
    });

    it('should leave the fullscreen capability alone on other platforms', async (): Promise<void> => {
      await boot({platform: 'linux'});

      serverCallback('playlistCountChange')(1);

      expect(mainWindow().setFullScreenable).not.toHaveBeenCalled();
    });

    it('should reflect the playback state in the menu', async (): Promise<void> => {
      await boot();

      serverCallback('playbackStateChange')(true);

      expect(lastMenuState('isPlaying')).toBe(true);
    });

    it('should reflect the media type in the menu', async (): Promise<void> => {
      await boot();

      serverCallback('mediaTypeChange')(true);

      expect(lastMenuState('isVideo')).toBe(true);
    });

    it.each([
      {ffmpeg: true, fluidsynth: false, openEnabled: true},
      {ffmpeg: false, fluidsynth: true, openEnabled: true},
      {ffmpeg: false, fluidsynth: false, openEnabled: false},
    ])('should set Open to $openEnabled when ffmpeg=$ffmpeg and fluidsynth=$fluidsynth', async ({ffmpeg, fluidsynth, openEnabled}): Promise<void> => {
      await boot();

      serverCallback('dependencyStateChange')(ffmpeg, fluidsynth, true);

      expect(lastMenuState('openEnabled')).toBe(openEnabled);
    });
  });

  describe('files from the OS', (): void => {
    const song: string = '/music/song.mp3';
    const video: string = '/video/film.mkv';
    const playlist: string = '/music/mix.opp';
    const document: string = '/docs/notes.txt';

    it('should forward a media file from a second instance to the renderer', async (): Promise<void> => {
      await boot({files: {[song]: 'file'}});

      h.world.appEvents.emit('second-instance', createEvent(), ['onixplayer.exe', song]);

      expect(sent(mainWindow(), 'os:openFile')).toEqual([[song]]);
    });

    it('should forward a playlist from a second instance as a playlist', async (): Promise<void> => {
      await boot({files: {[playlist]: 'file'}});

      h.world.appEvents.emit('second-instance', createEvent(), ['onixplayer.exe', playlist]);

      expect(sent(mainWindow(), 'os:openPlaylist')).toEqual([[playlist]]);
      expect(sent(mainWindow(), 'os:openFile')).toHaveLength(0);
    });

    it('should forward every file a second instance was given, in order', async (): Promise<void> => {
      await boot({files: {[song]: 'file', [video]: 'file'}});

      h.world.appEvents.emit('second-instance', createEvent(), ['onixplayer.exe', song, video]);

      expect(sent(mainWindow(), 'os:openFile')).toEqual([[song], [video]]);
    });

    it('should recognize a file extension regardless of case', async (): Promise<void> => {
      const shouting: string = '/music/SONG.MP3';
      await boot({files: {[shouting]: 'file'}});

      h.world.appEvents.emit('second-instance', createEvent(), ['onixplayer.exe', shouting]);

      expect(sent(mainWindow(), 'os:openFile')).toEqual([[shouting]]);
    });

    it('should ignore command-line switches and the executable itself from a second instance', async (): Promise<void> => {
      await boot({files: {'onixplayer.exe': 'file', '--flag.mp3': 'file', '-x.mp3': 'file'}});

      h.world.appEvents.emit('second-instance', createEvent(), ['onixplayer.exe', '--flag.mp3', '-x.mp3', '--allow-file-access']);

      expect(mainWindow().webContents.send).not.toHaveBeenCalled();
    });

    it('should ignore second-instance arguments that are not existing files', async (): Promise<void> => {
      await boot();

      h.world.appEvents.emit('second-instance', createEvent(), ['onixplayer.exe', song]);

      expect(mainWindow().webContents.send).not.toHaveBeenCalled();
    });

    it('should not forward a file with an unsupported extension', async (): Promise<void> => {
      await boot({files: {[document]: 'file'}});

      h.world.appEvents.emit('second-instance', createEvent(), ['onixplayer.exe', document]);

      expect(mainWindow().webContents.send).not.toHaveBeenCalled();
    });

    it('should focus the existing window when a second instance starts', async (): Promise<void> => {
      await boot();

      h.world.appEvents.emit('second-instance', createEvent(), ['onixplayer.exe']);

      expect(mainWindow().focus).toHaveBeenCalledTimes(1);
      expect(mainWindow().restore).not.toHaveBeenCalled();
    });

    it('should restore a minimized window when a second instance starts', async (): Promise<void> => {
      await boot();
      mainWindow().minimized = true;

      h.world.appEvents.emit('second-instance', createEvent(), ['onixplayer.exe']);

      expect(mainWindow().restore).toHaveBeenCalledTimes(1);
      expect(mainWindow().focus).toHaveBeenCalledTimes(1);
    });

    it('should tolerate a second instance after the main window is gone', async (): Promise<void> => {
      await boot({files: {[song]: 'file'}});
      const window: FakeWindow = mainWindow();
      window.destroy();

      h.world.appEvents.emit('second-instance', createEvent(), ['onixplayer.exe', song]);

      expect(window.focus).not.toHaveBeenCalled();
      expect(window.webContents.send).not.toHaveBeenCalled();
    });

    it('should claim macOS open-file events so the OS does not fall back to its default', async (): Promise<void> => {
      await boot({files: {[song]: 'file'}});
      const event: {preventDefault: Mock<() => void>} = createEvent();

      h.world.appEvents.emit('open-file', event, song);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('should forward a file opened from Finder while running', async (): Promise<void> => {
      await boot({files: {[song]: 'file'}});

      h.world.appEvents.emit('open-file', createEvent(), song);

      expect(sent(mainWindow(), 'os:openFile')).toEqual([[song]]);
    });

    it('should not forward a Finder file that no longer exists', async (): Promise<void> => {
      await boot();

      h.world.appEvents.emit('open-file', createEvent(), song);

      expect(mainWindow().webContents.send).not.toHaveBeenCalled();
    });

    it('should hold a file opened before the app is ready until the renderer has loaded', async (): Promise<void> => {
      await boot({files: {[song]: 'file'}, deferReady: true});
      h.world.appEvents.emit('open-file', createEvent(), song);
      await ready();
      const sentBeforeLoad: number = mainWindow().webContents.send.mock.calls.length;

      mainWindow().webContents.emit('did-finish-load');

      expect(sentBeforeLoad).toBe(0);
      expect(sent(mainWindow(), 'os:openFile')).toEqual([[song]]);
    });

    it('should open files named on the launch command line once the renderer has loaded', async (): Promise<void> => {
      await boot({files: {[playlist]: 'file', [video]: 'file'}, argv: ['onixplayer', '--inspect', playlist, video, '/missing.mp3']});

      mainWindow().webContents.emit('did-finish-load');

      expect(sent(mainWindow(), 'os:openPlaylist')).toEqual([[playlist]]);
      expect(sent(mainWindow(), 'os:openFile')).toEqual([[video]]);
    });

    it('should send nothing after load when no file was passed', async (): Promise<void> => {
      await boot();

      mainWindow().webContents.emit('did-finish-load');

      expect(mainWindow().webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('closing the main window', (): void => {
    const FADE_DURATION: number = 150;
    const FADE_TIMEOUT: number = 250;

    it('should hold the window open and ask the renderer to fade out audio', async (): Promise<void> => {
      await boot();
      vi.useFakeTimers();

      mainWindow().close();

      expect(mainWindow().isDestroyed()).toBe(false);
      expect(sent(mainWindow(), 'app:prepareForClose')).toEqual([[FADE_DURATION]]);
    });

    it('should destroy the window as soon as the renderer reports the fade is complete', async (): Promise<void> => {
      await boot();
      vi.useFakeTimers();
      mainWindow().close();

      await invoke('app:fadeOutComplete');
      await vi.advanceTimersByTimeAsync(0);

      expect(mainWindow().isDestroyed()).toBe(true);
    });

    it('should destroy the window anyway when the renderer never answers', async (): Promise<void> => {
      await boot();
      vi.useFakeTimers();
      mainWindow().close();

      await vi.advanceTimersByTimeAsync(FADE_TIMEOUT - 1);
      const destroyedEarly: boolean = mainWindow().isDestroyed();
      await vi.advanceTimersByTimeAsync(1);

      expect(destroyedEarly).toBe(false);
      expect(mainWindow().isDestroyed()).toBe(true);
    });

    it('should ask for only one fade when close is requested again mid-fade', async (): Promise<void> => {
      await boot();
      vi.useFakeTimers();
      const window: FakeWindow = mainWindow();
      const firstEvent: {preventDefault: Mock<() => void>} = createEvent();
      const secondEvent: {preventDefault: Mock<() => void>} = createEvent();

      window.emit('close', firstEvent);
      window.emit('close', secondEvent);

      expect(sent(window, 'app:prepareForClose')).toHaveLength(1);
      expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(secondEvent.preventDefault).not.toHaveBeenCalled();
    });

    it('should take the settings and about windows down with the main window', async (): Promise<void> => {
      await boot();
      await invoke('window:showConfigurationWindow');
      menuCallbacks()['onShowAbout']();
      vi.useFakeTimers();

      mainWindow().close();
      await vi.advanceTimersByTimeAsync(FADE_TIMEOUT);

      expect(windowTitled(CONFIG_TITLE).isDestroyed()).toBe(true);
      expect(windowTitled(ABOUT_TITLE).isDestroyed()).toBe(true);
    });

    it('should discard the MIDI cache when the window closes', async (): Promise<void> => {
      await boot();
      vi.useFakeTimers();
      const nukedAtStartup: number = server().nukeMidiCache.mock.calls.length;

      mainWindow().close();
      await vi.advanceTimersByTimeAsync(FADE_TIMEOUT);

      expect(server().nukeMidiCache).toHaveBeenCalledTimes(nukedAtStartup + 1);
    });

    it('should return to the player instead of closing while in configuration mode', async (): Promise<void> => {
      await boot();
      vi.useFakeTimers();
      await invoke('app:setConfigurationMode', true);

      mainWindow().close();
      await vi.advanceTimersByTimeAsync(FADE_TIMEOUT);

      expect(mainWindow().isDestroyed()).toBe(false);
      expect(sent(mainWindow(), 'app:exitConfigurationMode')).toEqual([[]]);
      expect(sent(mainWindow(), 'app:prepareForClose')).toHaveLength(0);
    });

    it('should close normally once configuration mode has been left', async (): Promise<void> => {
      await boot();
      vi.useFakeTimers();
      await invoke('app:setConfigurationMode', true);
      await invoke('app:setConfigurationMode', false);

      mainWindow().close();
      await vi.advanceTimersByTimeAsync(FADE_TIMEOUT);

      expect(mainWindow().isDestroyed()).toBe(true);
    });
  });

  describe('app lifecycle', (): void => {
    it('should quit when every window has been closed', async (): Promise<void> => {
      await boot();

      h.world.appEvents.emit('window-all-closed');

      expect(h.electron.app.quit).toHaveBeenCalledTimes(1);
    });

    it('should flush debounced settings to disk before quitting', async (): Promise<void> => {
      await boot();

      h.world.appEvents.emit('will-quit');

      expect(h.settings.flush).toHaveBeenCalledTimes(1);
    });

    it('should not open another window on dock activation while one exists', async (): Promise<void> => {
      await boot({platform: 'darwin'});

      h.world.appEvents.emit('activate');

      expect(h.world.created).toHaveLength(1);
    });

    it('should open a fresh main window on dock activation when none exist', async (): Promise<void> => {
      await boot({platform: 'darwin'});
      const original: FakeWindow = mainWindow();
      original.destroy();

      h.world.appEvents.emit('activate');

      expect(mainWindow()).not.toBe(original);
      expect(mainWindow().loadURL).toHaveBeenCalledWith(`${APP_ORIGIN}/`);
    });

    it('should load the development server into a window reopened in development', async (): Promise<void> => {
      await boot({platform: 'darwin', development: true});
      mainWindow().destroy();

      h.world.appEvents.emit('activate');

      expect(mainWindow().loadURL).toHaveBeenCalledWith(DEV_ORIGIN);
    });

    it('should lock down navigation in a reopened window', async (): Promise<void> => {
      await boot({platform: 'darwin', config: {packaged: true}});
      mainWindow().destroy();

      h.world.appEvents.emit('activate');

      expect(navigate(mainWindow(), 'https://evil.example/')).toBe(false);
      expect(openFromRenderer(mainWindow(), 'https://example.com/')).toEqual({action: 'deny'});
    });

    it('should route IPC to the reopened window', async (): Promise<void> => {
      await boot({platform: 'darwin'});
      mainWindow().destroy();
      h.world.appEvents.emit('activate');

      await invoke('window:minimize');

      expect(mainWindow().minimize).toHaveBeenCalledTimes(1);
    });

    it('should route menu actions to the reopened window', async (): Promise<void> => {
      await boot({platform: 'darwin'});
      mainWindow().destroy();
      h.world.appEvents.emit('activate');

      menuCallbacks()['onStop']();

      expect(sent(mainWindow(), 'menu:stop')).toEqual([[]]);
    });

    it('should let a reopened window be closed with the audio fade', async (): Promise<void> => {
      await boot({platform: 'darwin'});
      vi.useFakeTimers();
      mainWindow().close();
      await invoke('app:fadeOutComplete');
      await vi.advanceTimersByTimeAsync(250);
      h.world.appEvents.emit('activate');

      mainWindow().close();

      expect(sent(mainWindow(), 'app:prepareForClose')).toEqual([[150]]);
    });
  });
});

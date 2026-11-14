/**
 * @fileoverview Handler tests for UnifiedMediaServer: everything except
 * streaming, playback and playlists.
 *
 * Tests cover:
 * - The security gate (Host validation, session token, CORS, body limits)
 * - Server lifecycle (configured port, port conflicts, stop)
 * - The SSE handshake (GET /events)
 * - Settings endpoints not covered elsewhere (subtitles, equalizer,
 *   videoAdjustments), their validation, persistence and SSE broadcast
 * - Dependency endpoints (install / uninstall / update / refresh, SoundFonts)
 * - URL endpoints (info / download / resolve / status / cancel) and the DASH
 *   audio pairing they maintain
 * - Render cache clears (MIDI and tracker)
 *
 * The two managers that would otherwise spawn external processes or touch the
 * network — MediaDownloadManager (yt-dlp) and DependencyManager (binary
 * detection, downloads) — are replaced with in-memory fakes, each of which has
 * its own dedicated suite. Everything else is real: a server is started on a
 * random port and driven over HTTP.
 *
 * @module electron/unified-media-server.handlers.spec
 */

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import type { AddressInfo } from 'net';
import type { IncomingHttpHeaders, IncomingMessage, Server } from 'http';
import http from 'http';
import type { DependencyId, DependencyState, DependencyStatus, InstallProgress, SoundFontInfo } from './dependency-manager.js';
import type { StreamSources } from './media-download-manager.js';
import type { DownloadJob, MediaInfo, PlaybackState, UrlMediaFormat, UrlMediaInfo } from './media-types.js';

// ============================================================================
// Mocks — must be defined before importing the module under test
// ============================================================================

type ProgressListener = (progress: InstallProgress) => void;
type DependencyOperation = (id: DependencyId, onProgress: ProgressListener) => Promise<boolean>;
type DownloadListener = (job: Readonly<DownloadJob>) => void;

/** Options the server hands to DependencyManager. */
interface DependencyOptionsProbe {
  readonly arch: string;
  readonly jsRuntimePath: string;
  readonly fetch: (input: string, init?: { readonly headers?: Record<string, string> }) => Promise<Response>;
}

/** The getters the server hands to MediaDownloadManager, as the fake records them. */
interface DownloadConstruction {
  readonly getYtDlpPath: () => string | null;
  readonly getFfmpegPath: () => string | null;
  readonly downloadsDir: string;
  readonly getJsRuntimePath: () => string | null;
}

/** Everything the mock factories share with the tests. */
interface Harness {
  /** Directories Electron's `app.getPath` reports; reassigned per suite/test. */
  paths: { userData: string; temp: string };
  netFetch: Mock<(input: string, init?: { readonly headers?: Record<string, string> }) => Promise<Response>>;
  download: {
    constructions: DownloadConstruction[];
    getInfo: Mock<(url: string) => Promise<UrlMediaInfo>>;
    startDownload: Mock<(url: string, format: UrlMediaFormat, formatId: string | null, title: string, outputPath: string | null, onUpdate: DownloadListener) => string>;
    cancelDownload: Mock<(id: string) => boolean>;
    getJob: Mock<(id: string) => DownloadJob | undefined>;
    resolveStreamSources: Mock<(url: string, format: UrlMediaFormat, maxHeight: number | null) => Promise<StreamSources>>;
  };
  deps: {
    constructions: Array<{ platform: string; userDataPath: string; options: DependencyOptionsProbe }>;
    /** What `getState` reports; tests mutate it to simulate installs. */
    state: { ffmpegInstalled: boolean; fluidsynthInstalled: boolean; ytdlpInstalled: boolean; trackerSupport: boolean };
    soundfonts: SoundFontInfo[];
    paths: { ytdlp: string | null; ffmpeg: string | null; jsRuntime: string | null };
    detectBinaries: Mock<() => void>;
    installDependency: Mock<DependencyOperation>;
    uninstallDependency: Mock<DependencyOperation>;
    updateDependency: Mock<DependencyOperation>;
    installSoundFont: Mock<(sourcePath: string) => SoundFontInfo>;
    removeSoundFont: Mock<(fileName: string) => boolean>;
  };
}

const harness: Harness = vi.hoisted((): Harness => ({
  paths: { userData: '', temp: '' },
  netFetch: vi.fn(),
  download: {
    constructions: [],
    getInfo: vi.fn(),
    startDownload: vi.fn(),
    cancelDownload: vi.fn(),
    getJob: vi.fn(),
    resolveStreamSources: vi.fn(),
  },
  deps: {
    constructions: [],
    state: { ffmpegInstalled: true, fluidsynthInstalled: true, ytdlpInstalled: false, trackerSupport: true },
    soundfonts: [],
    paths: { ytdlp: null, ffmpeg: null, jsRuntime: null },
    detectBinaries: vi.fn(),
    installDependency: vi.fn(),
    uninstallDependency: vi.fn(),
    updateDependency: vi.fn(),
    installSoundFont: vi.fn(),
    removeSoundFont: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => (name === 'userData' ? harness.paths.userData : harness.paths.temp),
  },
  net: {
    fetch: harness.netFetch,
  },
}));

vi.mock('module', () => ({
  createRequire: (): (() => Record<string, unknown>) => (): Record<string, unknown> => ({
    transports: {
      file: { resolvePathFn: null, maxSize: 0, format: '', level: '' },
      console: { format: '', level: '' },
    },
    scope: (name: string): Record<string, unknown> => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      _scope: name,
    }),
    initialize: vi.fn(),
    errorHandler: { startCatching: vi.fn() },
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('./media-download-manager.js', () => ({
  MediaDownloadManager: class FakeMediaDownloadManager {
    public readonly getInfo: Harness['download']['getInfo'] = harness.download.getInfo;
    public readonly startDownload: Harness['download']['startDownload'] = harness.download.startDownload;
    public readonly cancelDownload: Harness['download']['cancelDownload'] = harness.download.cancelDownload;
    public readonly getJob: Harness['download']['getJob'] = harness.download.getJob;
    public readonly resolveStreamSources: Harness['download']['resolveStreamSources'] = harness.download.resolveStreamSources;

    public constructor(
      getYtDlpPath: () => string | null,
      getFfmpegPath: () => string | null,
      downloadsDir: string,
      getJsRuntimePath: () => string | null,
    ) {
      harness.download.constructions.push({ getYtDlpPath, getFfmpegPath, downloadsDir, getJsRuntimePath });
    }
  },
}));

vi.mock('./dependency-manager.js', () => {
  const status: (id: DependencyId, installed: boolean) => DependencyStatus = (id: DependencyId, installed: boolean): DependencyStatus => ({
    id,
    name: id,
    installed,
    path: installed ? `/fake/bin/${id}` : null,
    source: installed ? 'bundled' : null,
    version: installed ? '1.0.0' : null,
    managed: id === 'yt-dlp',
    description: '',
    websiteUrl: '',
  });

  return {
    DependencyManager: class FakeDependencyManager {
      public readonly detectBinaries: Harness['deps']['detectBinaries'] = harness.deps.detectBinaries;
      public readonly installDependency: Harness['deps']['installDependency'] = harness.deps.installDependency;
      public readonly uninstallDependency: Harness['deps']['uninstallDependency'] = harness.deps.uninstallDependency;
      public readonly updateDependency: Harness['deps']['updateDependency'] = harness.deps.updateDependency;
      public readonly installSoundFont: Harness['deps']['installSoundFont'] = harness.deps.installSoundFont;
      public readonly removeSoundFont: Harness['deps']['removeSoundFont'] = harness.deps.removeSoundFont;

      public constructor(platform: string, userDataPath: string, options: DependencyOptionsProbe) {
        harness.deps.constructions.push({ platform, userDataPath, options });
      }

      public getState(preferredSoundFont?: string | null): DependencyState {
        return {
          ffmpeg: status('ffmpeg', harness.deps.state.ffmpegInstalled),
          fluidsynth: status('fluidsynth', harness.deps.state.fluidsynthInstalled),
          ytdlp: status('yt-dlp', harness.deps.state.ytdlpInstalled),
          trackerSupport: harness.deps.state.trackerSupport,
          midiSupport: harness.deps.state.fluidsynthInstalled && harness.deps.soundfonts.length > 0,
          soundfonts: [...harness.deps.soundfonts],
          activeSoundFont: preferredSoundFont ?? null,
          hardwareEncoders: { available: false, encoders: [] },
        };
      }

      public getSoundFonts(): SoundFontInfo[] {
        return [...harness.deps.soundfonts];
      }

      public getYtDlpPath(): string | null {
        return harness.deps.paths.ytdlp;
      }

      public getFfmpegPath(): string | null {
        return harness.deps.paths.ffmpeg;
      }

      public getJsRuntimePath(): string | null {
        return harness.deps.paths.jsRuntime;
      }

      public getFfprobePath(): string | null {
        return null;
      }

      public getFluidsynthPath(): string | null {
        return null;
      }

      public hasTrackerSupport(): boolean {
        return harness.deps.state.trackerSupport;
      }

      public hasMidiSupport(): boolean {
        return false;
      }

      public getHardwareEncoders(): { available: boolean; encoders: readonly string[] } {
        return { available: false, encoders: [] };
      }

      public findSoundFont(): string | undefined {
        return undefined;
      }
    },
  };
});

// ============================================================================
// Import under test
// ============================================================================

import { UnifiedMediaServer } from './unified-media-server.js';

// ============================================================================
// Helpers
// ============================================================================

/** Root of every file this suite writes; removed when the suite finishes. */
const suiteRoot: string = fs.mkdtempSync(path.join(os.tmpdir(), 'onixplayer-ums-handlers-'));
const suiteUserData: string = path.join(suiteRoot, 'user-data');
const suiteTemp: string = path.join(suiteRoot, 'temp');

let baseUrl: string = '';

/** Session token minted by the server under test; required on every API request. */
let authToken: string = '';

/** Creates a fresh, empty directory under the suite root. */
function makeDir(prefix: string): string {
  return fs.mkdtempSync(path.join(suiteRoot, `${prefix}-`));
}

/** Restores every fake manager to a known, inert state. */
function resetFakes(): void {
  harness.netFetch.mockReset();

  harness.download.getInfo.mockReset();
  harness.download.startDownload.mockReset();
  harness.download.cancelDownload.mockReset();
  harness.download.getJob.mockReset();
  harness.download.resolveStreamSources.mockReset();

  harness.deps.state = { ffmpegInstalled: true, fluidsynthInstalled: true, ytdlpInstalled: false, trackerSupport: true };
  harness.deps.soundfonts = [];
  harness.deps.paths = { ytdlp: null, ffmpeg: null, jsRuntime: null };
  harness.deps.detectBinaries.mockReset();
  harness.deps.installDependency.mockReset().mockResolvedValue(true);
  harness.deps.uninstallDependency.mockReset().mockResolvedValue(true);
  harness.deps.updateDependency.mockReset().mockResolvedValue(true);
  harness.deps.installSoundFont.mockReset();
  harness.deps.removeSoundFont.mockReset().mockReturnValue(false);
}

/** Sends an authenticated HTTP request and returns { status, body } */
async function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res: Response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'X-Onix-Token': authToken,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text: string = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { _raw: text };
  }
  return { status: res.status, body: parsed };
}

/** Reads one section of the settings through the public endpoint. */
async function settingsSection(section: string): Promise<Record<string, unknown>> {
  const { body } = await request('GET', '/settings');
  return body[section] as Record<string, unknown>;
}

interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/**
 * Sends a request through `http.request`, for the cases `fetch` cannot
 * express: overriding the Host header.
 */
function rawRequest(
  urlPath: string,
  options: { readonly method?: string; readonly headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve: (value: RawResponse) => void, reject: (reason: Error) => void): void => {
    const req: http.ClientRequest = http.request(
      `${baseUrl}${urlPath}`,
      { method: options.method ?? 'GET', headers: options.headers ?? {}, agent: false },
      (res: IncomingMessage): void => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer): void => { chunks.push(chunk); });
        res.on('end', (): void => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

interface SseEvent {
  readonly event: string;
  readonly data: unknown;
}

/** A live connection to GET /events. */
interface EventStream {
  /** Response headers of the SSE handshake. */
  readonly headers: IncomingHttpHeaders;
  /** The state burst the server writes on connection. */
  readonly initial: readonly SseEvent[];
  /** Resolves with the next not-yet-consumed event of the given type sent after the initial burst. */
  next(event: string): Promise<SseEvent>;
  /** Resolves once the server ends the stream. */
  readonly ended: Promise<void>;
  close(): void;
}

/** How long `EventStream.next` waits before failing the test. */
const SSE_TIMEOUT_MS: number = 3000;

/**
 * Opens an SSE connection and resolves once the initial state burst has
 * arrived, so anything broadcast afterwards is attributable to the test.
 */
function openEventStream(url: string = baseUrl, token: string = authToken): Promise<EventStream> {
  return new Promise<EventStream>((resolve: (value: EventStream) => void, reject: (reason: Error) => void): void => {
    const initial: SseEvent[] = [];
    const later: SseEvent[] = [];
    const waiters: Array<{ readonly event: string; readonly deliver: (found: SseEvent) => void }> = [];
    let handshakeDone: boolean = false;

    const dispatch: (received: SseEvent) => void = (received: SseEvent): void => {
      const index: number = waiters.findIndex((waiter: { readonly event: string }): boolean => waiter.event === received.event);
      if (index >= 0) {
        waiters.splice(index, 1)[0].deliver(received);
      } else {
        later.push(received);
      }
    };

    const req: http.ClientRequest = http.get(`${url}/events`, { headers: { 'X-Onix-Token': token }, agent: false }, (res: IncomingMessage): void => {
      let buffer: string = '';
      const ended: Promise<void> = new Promise<void>((resolveEnded: () => void): void => {
        res.on('end', resolveEnded);
        res.on('close', resolveEnded);
      });

      const stream: EventStream = {
        headers: res.headers,
        initial,
        ended,
        next: (event: string): Promise<SseEvent> => {
          const index: number = later.findIndex((candidate: SseEvent): boolean => candidate.event === event);
          if (index >= 0) {
            return Promise.resolve(later.splice(index, 1)[0]);
          }
          return new Promise<SseEvent>((deliver: (found: SseEvent) => void, fail: (reason: Error) => void): void => {
            const timer: NodeJS.Timeout = setTimeout((): void => fail(new Error(`No "${event}" event within ${SSE_TIMEOUT_MS}ms`)), SSE_TIMEOUT_MS);
            waiters.push({ event, deliver: (found: SseEvent): void => { clearTimeout(timer); deliver(found); } });
          });
        },
        close: (): void => { req.destroy(); },
      };

      res.on('data', (chunk: Buffer): void => {
        buffer += chunk.toString();
        const parts: string[] = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          let event: string = '';
          let data: string = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (!event) continue;

          const received: SseEvent = { event, data: JSON.parse(data) as unknown };
          if (handshakeDone) {
            dispatch(received);
            continue;
          }

          // dependencies:state is the last event of the unconditional burst.
          initial.push(received);
          if (event === 'dependencies:state') {
            handshakeDone = true;
            resolve(stream);
          }
        }
      });
    });

    req.on('error', (err: Error): void => {
      // Destroying the request on close() surfaces here; only a failure before
      // the handshake is a real error.
      if (!handshakeDone) reject(err);
    });
  });
}

/** Finds an event of the initial burst by type. */
function initialEvent(stream: EventStream, event: string): unknown {
  return stream.initial.find((candidate: SseEvent): boolean => candidate.event === event)?.data;
}

/** Private state these tests need to arrange or observe; there is no public route to it. */
interface ServerInternals {
  readonly playback: PlaybackState;
  readonly dashAudioPairs: Map<string, string>;
  readonly midiRenderCache: Map<string, { readonly tempFile: string; readonly duration: number }>;
  readonly midiRenderInProgress: Map<string, Promise<string>>;
  readonly trackerRenderCache: Map<string, { readonly tempFile: string; readonly duration: number }>;
  readonly trackerRenderInProgress: Map<string, Promise<string>>;
}

function internals(target: UnifiedMediaServer): ServerInternals {
  return target as unknown as ServerInternals;
}

/** A promise that the test settles by hand. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function defer<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = (): void => undefined;
  const promise: Promise<T> = new Promise<T>((resolve: (value: T) => void): void => { resolveFn = resolve; });
  return { promise, resolve: resolveFn };
}

function makeSoundFont(fileName: string): SoundFontInfo {
  return { fileName, filePath: path.join(suiteUserData, 'soundfonts', fileName), sizeBytes: 1024 };
}

function makeJob(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: 'job-1',
    url: 'https://example.com/watch?v=1',
    format: 'video',
    status: 'downloading',
    progress: 42,
    title: 'A video',
    filePath: null,
    errorMessage: null,
    ...overrides,
  };
}

function makeMedia(filePath: string, type: 'audio' | 'video' = 'audio'): MediaInfo {
  return { duration: 120, type, title: path.basename(filePath), filePath };
}

/** Finds a port nothing is listening on by binding to port 0 and releasing it. */
function findFreePort(): Promise<number> {
  return new Promise<number>((resolve: (value: number) => void, reject: (reason: Error) => void): void => {
    const probe: Server = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', (): void => {
      const port: number = (probe.address() as AddressInfo).port;
      probe.close((): void => resolve(port));
    });
  });
}

/** Lists the entries of a directory whose name starts with the given prefix. */
function entriesStartingWith(directory: string, prefix: string): string[] {
  return fs.readdirSync(directory).filter((name: string): boolean => name.startsWith(prefix));
}

// ============================================================================
// Test suite
// ============================================================================

describe('UnifiedMediaServer handlers', () => {
  let server: UnifiedMediaServer;

  /** Streams opened by the current test, closed afterwards whatever happens. */
  const openStreams: EventStream[] = [];

  /** Servers started by the current test, stopped afterwards whatever happens. */
  const extraServers: UnifiedMediaServer[] = [];

  async function connect(url?: string, token?: string): Promise<EventStream> {
    const stream: EventStream = await openEventStream(url, token);
    openStreams.push(stream);
    return stream;
  }

  /** Constructs and starts another server, returning it with its base URL. */
  async function startExtraServer(staticPath?: string): Promise<{ instance: UnifiedMediaServer; url: string }> {
    const instance: UnifiedMediaServer = new UnifiedMediaServer(staticPath);
    extraServers.push(instance);
    const port: number = await instance.start();
    return { instance, url: `http://127.0.0.1:${port}` };
  }

  beforeAll(async () => {
    fs.mkdirSync(suiteUserData, { recursive: true });
    fs.mkdirSync(suiteTemp, { recursive: true });
    harness.paths.userData = suiteUserData;
    harness.paths.temp = suiteTemp;
    resetFakes();

    server = new UnifiedMediaServer();
    const port: number = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
    authToken = server.getAuthToken();
  });

  afterAll(() => {
    server.stop();
    fs.rmSync(suiteRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    harness.paths.userData = suiteUserData;
    harness.paths.temp = suiteTemp;
    resetFakes();
    server.onDependencyStateChange((): void => undefined);
  });

  afterEach(() => {
    for (const stream of openStreams.splice(0)) {
      stream.close();
    }
    for (const instance of extraServers.splice(0)) {
      instance.stop();
    }
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Construction
  // ==========================================================================

  describe('construction', () => {
    it('keeps downloads in a "downloads" directory under the user data path', () => {
      const userData: string = makeDir('construct');
      harness.paths.userData = userData;

      new UnifiedMediaServer();

      const construction: DownloadConstruction = harness.download.constructions[harness.download.constructions.length - 1];
      expect(construction.downloadsDir).toBe(path.join(userData, 'downloads'));
    });

    it('lets the download manager locate yt-dlp, ffmpeg and the JS runtime through the dependency manager', () => {
      new UnifiedMediaServer();
      const construction: DownloadConstruction = harness.download.constructions[harness.download.constructions.length - 1];

      // The paths are assigned after construction: the download manager must
      // see what the dependency manager reports now, not a snapshot.
      harness.deps.paths = { ytdlp: '/bin/yt-dlp', ffmpeg: '/bin/ffmpeg', jsRuntime: '/bin/runtime' };

      expect(construction.getYtDlpPath()).toBe('/bin/yt-dlp');
      expect(construction.getFfmpegPath()).toBe('/bin/ffmpeg');
      expect(construction.getJsRuntimePath()).toBe('/bin/runtime');
    });

    it('creates the dependency manager for the current platform and user data path', () => {
      const userData: string = makeDir('construct');
      harness.paths.userData = userData;

      new UnifiedMediaServer();

      const construction: Harness['deps']['constructions'][number] = harness.deps.constructions[harness.deps.constructions.length - 1];
      expect(construction.platform).toBe(process.platform);
      expect(construction.userDataPath).toBe(userData);
      expect(construction.options.arch).toBe(process.arch);
      expect(construction.options.jsRuntimePath).toBe(process.execPath);
    });

    it('routes dependency downloads through the Electron network stack', async () => {
      new UnifiedMediaServer();
      const construction: Harness['deps']['constructions'][number] = harness.deps.constructions[harness.deps.constructions.length - 1];
      const response: Response = new Response('ok');
      harness.netFetch.mockResolvedValue(response);

      const result: Response = await construction.options.fetch('https://example.com/yt-dlp', { headers: { Accept: 'application/json' } });

      expect(result).toBe(response);
      expect(harness.netFetch).toHaveBeenCalledWith('https://example.com/yt-dlp', { headers: { Accept: 'application/json' } });
    });

    it('reports port 0 until the server has been started', () => {
      const unstarted: UnifiedMediaServer = new UnifiedMediaServer();

      expect(unstarted.getPort()).toBe(0);
    });
  });

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  describe('start', () => {
    it('listens on the port configured in the application settings', async () => {
      harness.paths.userData = makeDir('port');
      const configuredPort: number = await findFreePort();
      const instance: UnifiedMediaServer = new UnifiedMediaServer();
      extraServers.push(instance);
      instance.getSettingsManager().updateApplicationSettings({ serverPort: configuredPort });

      const port: number = await instance.start();

      expect(port).toBe(configuredPort);
      expect(instance.getPort()).toBe(configuredPort);
    });

    it('rejects when the configured port is already in use', async () => {
      harness.paths.userData = makeDir('port');
      const blocker: Server = http.createServer();
      await new Promise<void>((resolve: () => void): void => { blocker.listen(0, '127.0.0.1', resolve); });
      const takenPort: number = (blocker.address() as AddressInfo).port;
      const instance: UnifiedMediaServer = new UnifiedMediaServer();
      extraServers.push(instance);
      instance.getSettingsManager().updateApplicationSettings({ serverPort: takenPort });

      try {
        await expect(instance.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      } finally {
        await new Promise<void>((resolve: () => void): void => { blocker.close((): void => resolve()); });
      }
    });

    it('reads settings persisted by an earlier instance', async () => {
      harness.paths.userData = makeDir('persist');
      const first: { instance: UnifiedMediaServer; url: string } = await startExtraServer();
      await fetch(`${first.url}/settings/equalizer`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Onix-Token': first.instance.getAuthToken() },
        body: JSON.stringify({ preset: 'jazz' }),
      });
      first.instance.getSettingsManager().flush();

      const second: { instance: UnifiedMediaServer; url: string } = await startExtraServer();
      const res: Response = await fetch(`${second.url}/settings`, { headers: { 'X-Onix-Token': second.instance.getAuthToken() } });
      const settings: { equalizer: { preset: string } } = await res.json() as { equalizer: { preset: string } };

      expect(settings.equalizer.preset).toBe('jazz');
    });
  });

  describe('stop', () => {
    it('ends open event streams', async () => {
      const extra: { instance: UnifiedMediaServer; url: string } = await startExtraServer();
      const stream: EventStream = await connect(extra.url, extra.instance.getAuthToken());

      extra.instance.stop();

      await expect(stream.ended).resolves.toBeUndefined();
    });

    it('refuses new connections afterwards', async () => {
      const extra: { instance: UnifiedMediaServer; url: string } = await startExtraServer();

      extra.instance.stop();

      await expect(fetch(`${extra.url}/settings`, { headers: { 'X-Onix-Token': extra.instance.getAuthToken() } })).rejects.toThrow();
    });

    it('can be called on a server that was never started', () => {
      const unstarted: UnifiedMediaServer = new UnifiedMediaServer();

      expect((): void => unstarted.stop()).not.toThrow();
    });
  });

  // ==========================================================================
  // Security gate
  // ==========================================================================

  describe('Host header validation', () => {
    it('rejects a request with no Host header', async () => {
      // Node answers an HTTP/1.1 request without Host itself, so the only way
      // to reach the server's own check is HTTP/1.0, where Host is optional.
      const response: string = await new Promise<string>((resolve: (value: string) => void, reject: (reason: Error) => void): void => {
        const socket: net.Socket = net.connect(server.getPort(), '127.0.0.1', (): void => {
          socket.write(`GET /settings HTTP/1.0\r\nX-Onix-Token: ${authToken}\r\n\r\n`);
        });
        let received: string = '';
        socket.on('data', (chunk: Buffer): void => { received += chunk.toString(); });
        socket.on('end', (): void => resolve(received));
        socket.on('error', reject);
      });

      expect(response.split('\r\n')[0]).toContain('403');
      expect(response).toContain(JSON.stringify({ error: 'Forbidden' }));
    });

    it('rejects the right hostname on the wrong port', async () => {
      const port: number = server.getPort();
      const res: RawResponse = await rawRequest('/settings', { headers: { 'X-Onix-Token': authToken, Host: `127.0.0.1:${port + 1}` } });

      expect(res.status).toBe(403);
    });

    it('rejects a hostname that merely starts with the loopback address', async () => {
      const port: number = server.getPort();
      const res: RawResponse = await rawRequest('/settings', { headers: { 'X-Onix-Token': authToken, Host: `127.0.0.1.evil.example:${port}` } });

      expect(res.status).toBe(403);
    });

    it.each(['localhost', '[::1]'])('accepts %s as an alias of the loopback address', async (hostname: string) => {
      const res: RawResponse = await rawRequest('/settings', { headers: { 'X-Onix-Token': authToken, Host: `${hostname}:${server.getPort()}` } });

      expect(res.status).toBe(200);
    });

    it('rejects a foreign Host before looking at the token', async () => {
      const res: RawResponse = await rawRequest('/settings', { headers: { Host: 'evil.example.com' } });

      expect(res.status).toBe(403);
    });
  });

  describe('session token', () => {
    it('answers an unauthenticated request with a JSON 401', async () => {
      const res: Response = await fetch(`${baseUrl}/settings`);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('prefers the header over the query parameter, so a wrong header is not rescued by a valid query token', async () => {
      const res: Response = await fetch(`${baseUrl}/settings?token=${authToken}`, { headers: { 'X-Onix-Token': 'wrong' } });

      expect(res.status).toBe(401);
    });

    it('rejects a token that only has the right prefix', async () => {
      const res: Response = await fetch(`${baseUrl}/settings`, { headers: { 'X-Onix-Token': authToken.slice(0, -1) } });

      expect(res.status).toBe(401);
    });

    it.each([
      ['PUT', '/settings/subtitles'],
      ['PUT', '/settings/equalizer'],
      ['PUT', '/settings/videoAdjustments'],
      ['GET', '/dependencies'],
      ['POST', '/dependencies/install'],
      ['POST', '/dependencies/update'],
      ['POST', '/dependencies/soundfont/select'],
      ['POST', '/dependencies/refresh'],
      ['POST', '/media/url/info'],
      ['POST', '/media/url/download'],
      ['POST', '/media/url/resolve'],
      ['GET', '/media/url/status/job-1'],
      ['POST', '/media/url/cancel/job-1'],
      ['GET', '/events'],
    ])('requires the token for %s %s', async (method: string, urlPath: string) => {
      const res: Response = await fetch(`${baseUrl}${urlPath}`, { method });

      expect(res.status).toBe(401);
    });

    it('does not run the handler of a rejected request', async () => {
      await fetch(`${baseUrl}/media/url/cancel/job-1`, { method: 'POST' });

      expect(harness.download.cancelDownload).not.toHaveBeenCalled();
    });
  });

  describe('when serving the Angular bundle', () => {
    let staticDir: string = '';

    beforeAll(() => {
      staticDir = makeDir('static');
      fs.writeFileSync(path.join(staticDir, 'index.html'), '<html>app</html>', 'utf-8');
    });

    it('still requires the token for a GET under an API prefix', async () => {
      const extra: { instance: UnifiedMediaServer; url: string } = await startExtraServer(staticDir);

      const res: Response = await fetch(`${extra.url}/settings`);

      expect(res.status).toBe(401);
    });

    it('requires the token for an API prefix requested with a deeper path', async () => {
      const extra: { instance: UnifiedMediaServer; url: string } = await startExtraServer(staticDir);

      const res: Response = await fetch(`${extra.url}/dependencies/anything`);

      expect(res.status).toBe(401);
    });

    it('treats a path that only shares leading characters with an API prefix as a static route', async () => {
      const extra: { instance: UnifiedMediaServer; url: string } = await startExtraServer(staticDir);

      const res: Response = await fetch(`${extra.url}/settings-page`);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<html>app</html>');
    });

    it('requires the token for any non-GET request, even outside the API prefixes', async () => {
      const extra: { instance: UnifiedMediaServer; url: string } = await startExtraServer(staticDir);

      const res: Response = await fetch(`${extra.url}/index.html`, { method: 'POST' });

      expect(res.status).toBe(401);
    });

    it('serves API routes to an authenticated client', async () => {
      const extra: { instance: UnifiedMediaServer; url: string } = await startExtraServer(staticDir);

      const res: Response = await fetch(`${extra.url}/dependencies`, { headers: { 'X-Onix-Token': extra.instance.getAuthToken() } });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
    });
  });

  describe('CORS', () => {
    const devOrigin: string = 'http://localhost:4200';
    let previousDevServerUrl: string | undefined;

    beforeEach(() => {
      previousDevServerUrl = process.env['DEV_SERVER_URL'];
    });

    afterEach(() => {
      if (previousDevServerUrl === undefined) {
        delete process.env['DEV_SERVER_URL'];
      } else {
        process.env['DEV_SERVER_URL'] = previousDevServerUrl;
      }
    });

    it('sends no Access-Control headers when there is no development origin', async () => {
      delete process.env['DEV_SERVER_URL'];

      const res: Response = await fetch(`${baseUrl}/settings`, { headers: { 'X-Onix-Token': authToken } });

      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-headers')).toBeNull();
    });

    it('grants exactly the development origin when one is configured', async () => {
      process.env['DEV_SERVER_URL'] = devOrigin;

      const res: Response = await fetch(`${baseUrl}/settings`, { headers: { 'X-Onix-Token': authToken } });

      expect(res.headers.get('access-control-allow-origin')).toBe(devOrigin);
      expect(res.headers.get('vary')).toBe('Origin');
    });

    it('answers a development preflight without a token, allowing the token header and the mutating methods', async () => {
      process.env['DEV_SERVER_URL'] = devOrigin;

      const res: Response = await fetch(`${baseUrl}/settings/equalizer`, { method: 'OPTIONS' });

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(devOrigin);
      expect(res.headers.get('access-control-allow-headers')).toContain('X-Onix-Token');
      expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
    });

    it('still rejects an unauthenticated request from the development origin', async () => {
      process.env['DEV_SERVER_URL'] = devOrigin;

      const res: Response = await fetch(`${baseUrl}/settings`, { headers: { Origin: devOrigin } });

      expect(res.status).toBe(401);
      expect(res.headers.get('access-control-allow-origin')).toBe(devOrigin);
    });
  });

  describe('request bodies', () => {
    it('accepts a body just under the 1MB limit', async () => {
      const padding: string = 'x'.repeat(1024 * 1024 - 200);

      const { status } = await request('PUT', '/settings/equalizer', { preset: 'rock', padding });

      expect(status).toBe(200);
      expect((await settingsSection('equalizer'))['preset']).toBe('rock');
    });

    it('does not apply a body over the 1MB limit', async () => {
      await request('PUT', '/settings/equalizer', { preset: 'flat' });
      const padding: string = 'x'.repeat(2 * 1024 * 1024);

      // The server destroys the socket as soon as the limit is crossed, so the
      // client sees either the 413 or a dropped connection depending on timing.
      const outcome: number | 'dropped' = await fetch(`${baseUrl}/settings/equalizer`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Onix-Token': authToken },
        body: JSON.stringify({ preset: 'rock', padding }),
      }).then((res: Response): number => res.status, (): 'dropped' => 'dropped');

      expect(['dropped', 413]).toContain(outcome);
      expect((await settingsSection('equalizer'))['preset']).toBe('flat');
    });

    it('rejects a body that is not JSON as a bad request', async () => {
      const res: Response = await fetch(`${baseUrl}/settings/equalizer`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Onix-Token': authToken },
        body: '{not json',
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid JSON body' });
    });

    it('rejects an empty body where JSON is required as a bad request', async () => {
      const res: Response = await fetch(`${baseUrl}/media/url/info`, {
        method: 'POST',
        headers: { 'X-Onix-Token': authToken },
        body: '',
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid JSON body' });
    });

    it('keeps serving requests after a handler has thrown', async () => {
      await fetch(`${baseUrl}/media/url/info`, {
        method: 'POST',
        headers: { 'X-Onix-Token': authToken },
        body: '',
      });

      const { status } = await request('GET', '/settings');

      expect(status).toBe(200);
    });
  });

  describe('routing', () => {
    it.each([
      ['GET', '/settings/equalizer'],
      ['POST', '/settings'],
      ['GET', '/dependencies/refresh'],
      ['GET', '/media/url/info'],
      ['GET', '/media/url/cancel/job-1'],
      ['POST', '/media/url/status/job-1'],
      ['POST', '/events'],
    ])('answers 404 for %s %s, a known path with the wrong method', async (method: string, urlPath: string) => {
      const { status, body } = await request(method, urlPath);

      expect(status).toBe(404);
      expect(body).toEqual({ error: 'Not found' });
    });
  });

  // ==========================================================================
  // SSE handshake
  // ==========================================================================

  describe('GET /events', () => {
    it('opens an uncached event stream', async () => {
      const stream: EventStream = await connect();

      expect(stream.headers['content-type']).toBe('text/event-stream');
      expect(stream.headers['cache-control']).toBe('no-cache');
    });

    it('sends the state burst in a fixed order', async () => {
      const stream: EventStream = await connect();

      expect(stream.initial.map((received: SseEvent): string => received.event)).toEqual([
        'playback:state',
        'playback:time',
        'playback:volume',
        'playlist:updated',
        'settings:updated',
        'dependencies:state',
      ]);
    });

    it('sends the same settings GET /settings returns', async () => {
      const { body } = await request('GET', '/settings');

      const stream: EventStream = await connect();

      expect(initialEvent(stream, 'settings:updated')).toEqual(body);
    });

    it('sends the dependency state with the active SoundFont from the settings', async () => {
      harness.deps.soundfonts = [makeSoundFont('handshake.sf2')];
      await request('POST', '/dependencies/soundfont/select', { fileName: 'handshake.sf2' });

      const stream: EventStream = await connect();

      expect(initialEvent(stream, 'dependencies:state')).toMatchObject({
        activeSoundFont: 'handshake.sf2',
        soundfonts: [{ fileName: 'handshake.sf2' }],
      });
    });

    it('sends the loaded media to a client that connects mid-playback', async () => {
      const media: MediaInfo = makeMedia(path.join(suiteRoot, 'song.mp3'));
      internals(server).playback.currentMedia = media;

      try {
        const stream: EventStream = await connect();
        const loaded: SseEvent = await stream.next('playback:loaded');

        expect(loaded.data).toEqual(media);
      } finally {
        server.clearPlaylist();
      }
    });

    it('delivers later broadcasts to every connected client', async () => {
      const first: EventStream = await connect();
      const second: EventStream = await connect();

      server.broadcastDependencyState();

      expect((await first.next('dependencies:state')).event).toBe('dependencies:state');
      expect((await second.next('dependencies:state')).event).toBe('dependencies:state');
    });
  });

  // ==========================================================================
  // Settings
  // ==========================================================================

  describe('settings broadcasts', () => {
    it.each([
      ['visualization', { defaultType: 'bars' }],
      ['application', { serverPort: 0 }],
      ['playback', { crossfadeDuration: 2 }],
      ['transcoding', { videoQuality: 'medium' }],
      ['appearance', { backgroundColor: '#101010' }],
      ['subtitles', { fontSize: 120 }],
      ['equalizer', { preset: 'pop' }],
      ['videoAdjustments', { preset: 'warm' }],
    ])('broadcasts the updated settings after PUT /settings/%s', async (section: string, update: Record<string, unknown>) => {
      const stream: EventStream = await connect();

      await request('PUT', `/settings/${section}`, update);
      const broadcast: SseEvent = await stream.next('settings:updated');

      const { body } = await request('GET', '/settings');
      expect(broadcast.data).toEqual(body);
      expect((broadcast.data as Record<string, Record<string, unknown>>)[section]).toMatchObject(update);
    });
  });

  describe('PUT /settings/subtitles', () => {
    it('stores every subtitle appearance field', async () => {
      const update: Record<string, unknown> = {
        fontSize: 150,
        fontColor: '#ffcc00',
        backgroundColor: '#112233',
        backgroundOpacity: 0.5,
        fontFamily: 'serif',
        textShadow: true,
        shadowSpread: 3,
        shadowBlur: 2,
        shadowColor: '#000000',
      };

      const { status, body } = await request('PUT', '/settings/subtitles', update);

      expect(status).toBe(200);
      expect(body).toEqual({ success: true });
      expect(await settingsSection('subtitles')).toEqual(update);
    });

    it('changes only the fields that were sent', async () => {
      await request('PUT', '/settings/subtitles', { fontSize: 100, fontFamily: 'monospace' });

      await request('PUT', '/settings/subtitles', { fontSize: 200 });

      expect(await settingsSection('subtitles')).toMatchObject({ fontSize: 200, fontFamily: 'monospace' });
    });

    it.each([
      ['a font size below the minimum', { fontSize: 10 }],
      ['a fractional font size', { fontSize: 100.5 }],
      ['a colour that is not hex', { fontColor: 'red' }],
      ['an unknown font family', { fontFamily: 'comic-sans' }],
      ['a non-boolean text shadow', { textShadow: 'yes' }],
    ])('ignores an update with %s, including its valid fields', async (_label: string, invalid: Record<string, unknown>) => {
      vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
      await request('PUT', '/settings/subtitles', { fontSize: 100, fontColor: '#ffffff', fontFamily: 'sans-serif', textShadow: false, shadowBlur: 1 });
      const before: Record<string, unknown> = await settingsSection('subtitles');

      await request('PUT', '/settings/subtitles', { shadowBlur: 3, ...invalid });

      expect(await settingsSection('subtitles')).toEqual(before);
    });
  });

  describe('PUT /settings/equalizer', () => {
    it('stores the enabled flag, preset and band gains', async () => {
      const bands: number[] = [1, 2, 3, 4, 5, -1, -2, -3, -4, -5];

      const { status, body } = await request('PUT', '/settings/equalizer', { enabled: true, preset: 'custom', bands });

      expect(status).toBe(200);
      expect(body).toEqual({ success: true });
      expect(await settingsSection('equalizer')).toEqual({ enabled: true, preset: 'custom', bands });
    });

    it('clamps band gains to the supported range and zeroes non-numeric ones', async () => {
      await request('PUT', '/settings/equalizer', { bands: [100, -100, 'loud', null, 0, 0, 0, 0, 0, 6] });

      expect((await settingsSection('equalizer'))['bands']).toEqual([12, -12, 0, 0, 0, 0, 0, 0, 0, 6]);
    });

    it.each([
      ['an unknown preset', { preset: 'dubstep' }],
      ['the wrong number of bands', { bands: [1, 2, 3] }],
      ['bands that are not an array', { bands: 'flat' }],
      ['a non-boolean enabled flag', { enabled: 'on' }],
    ])('ignores an update with %s', async (_label: string, invalid: Record<string, unknown>) => {
      vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
      await request('PUT', '/settings/equalizer', { enabled: false, preset: 'flat', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
      const before: Record<string, unknown> = await settingsSection('equalizer');

      await request('PUT', '/settings/equalizer', invalid);

      expect(await settingsSection('equalizer')).toEqual(before);
    });
  });

  describe('PUT /settings/videoAdjustments', () => {
    it('stores every video adjustment', async () => {
      const update: Record<string, unknown> = {
        enabled: true,
        preset: 'custom',
        brightness: 10,
        contrast: -20,
        saturation: 30,
        hue: 90,
        blur: 5,
        grayscale: 40,
        sepia: 50,
        invert: true,
      };

      const { status, body } = await request('PUT', '/settings/videoAdjustments', update);

      expect(status).toBe(200);
      expect(body).toEqual({ success: true });
      expect(await settingsSection('videoAdjustments')).toEqual(update);
    });

    it('clamps each level to its own range', async () => {
      await request('PUT', '/settings/videoAdjustments', { brightness: 500, contrast: -500, hue: 720, blur: -10, sepia: 250 });

      expect(await settingsSection('videoAdjustments')).toMatchObject({ brightness: 100, contrast: -100, hue: 180, blur: 0, sepia: 100 });
    });

    it.each([
      ['an unknown preset', { preset: 'psychedelic' }],
      ['a non-boolean enabled flag', { enabled: 1 }],
      ['a non-boolean invert flag', { invert: 'yes' }],
    ])('ignores an update with %s, including its valid fields', async (_label: string, invalid: Record<string, unknown>) => {
      vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
      await request('PUT', '/settings/videoAdjustments', { enabled: false, preset: 'default', brightness: 0, invert: false });
      const before: Record<string, unknown> = await settingsSection('videoAdjustments');

      await request('PUT', '/settings/videoAdjustments', { brightness: 50, ...invalid });

      expect(await settingsSection('videoAdjustments')).toEqual(before);
    });
  });

  describe('getSettingsManager', () => {
    it('returns the manager whose changes GET /settings reports', async () => {
      server.getSettingsManager().updateEqualizerSettings({ preset: 'vocal' });

      expect((await settingsSection('equalizer'))['preset']).toBe('vocal');
    });
  });

  // ==========================================================================
  // Dependencies
  // ==========================================================================

  describe('GET /dependencies', () => {
    it('reports what the dependency manager detected', async () => {
      harness.deps.state.ffmpegInstalled = true;
      harness.deps.state.ytdlpInstalled = false;

      const { status, body } = await request('GET', '/dependencies');

      expect(status).toBe(200);
      expect(body['ffmpeg']).toMatchObject({ id: 'ffmpeg', installed: true });
      expect(body['ytdlp']).toMatchObject({ id: 'yt-dlp', installed: false });
    });

    it('reports the SoundFont selected in the settings as the active one', async () => {
      harness.deps.soundfonts = [makeSoundFont('piano.sf2')];
      await request('POST', '/dependencies/soundfont/select', { fileName: 'piano.sf2' });

      const { body } = await request('GET', '/dependencies');

      expect(body['activeSoundFont']).toBe('piano.sf2');
    });
  });

  describe('getDependencyManager', () => {
    it('returns the manager whose state GET /dependencies reports', async () => {
      harness.deps.soundfonts = [makeSoundFont('shared.sf2')];

      const direct: SoundFontInfo[] = server.getDependencyManager().getSoundFonts();

      const { body } = await request('GET', '/dependencies');
      expect(body['soundfonts']).toEqual(direct);
    });
  });

  describe('broadcastDependencyState', () => {
    it('broadcasts the dependency state to event stream clients', async () => {
      harness.deps.state.ytdlpInstalled = true;
      const stream: EventStream = await connect();

      server.broadcastDependencyState();

      expect((await stream.next('dependencies:state')).data).toMatchObject({ ytdlp: { installed: true } });
    });

    it('tells the registered listener which capabilities are available', () => {
      harness.deps.state = { ffmpegInstalled: true, fluidsynthInstalled: false, ytdlpInstalled: false, trackerSupport: true };
      const listener: Mock<(ffmpeg: boolean, fluidsynth: boolean, tracker: boolean) => void> = vi.fn();
      server.onDependencyStateChange(listener);

      server.broadcastDependencyState();

      expect(listener).toHaveBeenCalledExactlyOnceWith(true, false, true);
    });

    it('notifies only the most recently registered listener', () => {
      const replaced: Mock<(ffmpeg: boolean, fluidsynth: boolean, tracker: boolean) => void> = vi.fn();
      const current: Mock<(ffmpeg: boolean, fluidsynth: boolean, tracker: boolean) => void> = vi.fn();
      server.onDependencyStateChange(replaced);
      server.onDependencyStateChange(current);

      server.broadcastDependencyState();

      expect(replaced).not.toHaveBeenCalled();
      expect(current).toHaveBeenCalledTimes(1);
    });
  });

  describe.each([
    ['install', 'installing'],
    ['uninstall', 'uninstalling'],
    ['update', 'updating'],
  ] as const)('POST /dependencies/%s', (action: 'install' | 'uninstall' | 'update', progressStatus: InstallProgress['status']) => {
    const operation: () => Mock<DependencyOperation> = (): Mock<DependencyOperation> => harness.deps[`${action}Dependency`];

    it('accepts the request before the operation has finished', async () => {
      const pending: Deferred<boolean> = defer<boolean>();
      operation().mockReturnValue(pending.promise);

      const { status, body } = await request('POST', `/dependencies/${action}`, { id: 'yt-dlp' });
      pending.resolve(true);

      expect(status).toBe(202);
      expect(body).toEqual({ accepted: true });
    });

    it('runs the operation for the requested dependency', async () => {
      await request('POST', `/dependencies/${action}`, { id: 'yt-dlp' });

      expect(operation()).toHaveBeenCalledExactlyOnceWith('yt-dlp', expect.any(Function));
    });

    it('streams the progress of the operation over SSE', async () => {
      const progress: InstallProgress = { dependencyId: 'yt-dlp', status: progressStatus, message: 'Working...', percent: 40 };
      operation().mockImplementation((_id: DependencyId, onProgress: ProgressListener): Promise<boolean> => {
        onProgress(progress);
        return Promise.resolve(true);
      });
      const stream: EventStream = await connect();

      await request('POST', `/dependencies/${action}`, { id: 'yt-dlp' });

      expect((await stream.next('dependencies:progress')).data).toEqual(progress);
    });

    it('broadcasts the new dependency state once the operation completes', async () => {
      const pending: Deferred<boolean> = defer<boolean>();
      operation().mockReturnValue(pending.promise);
      const stream: EventStream = await connect();
      await request('POST', `/dependencies/${action}`, { id: 'yt-dlp' });

      harness.deps.state.ytdlpInstalled = true;
      pending.resolve(true);

      expect((await stream.next('dependencies:state')).data).toMatchObject({ ytdlp: { installed: true } });
    });

    it('does not notify the dependency listener while the operation is still running', async () => {
      const pending: Deferred<boolean> = defer<boolean>();
      operation().mockReturnValue(pending.promise);
      const listener: Mock<(ffmpeg: boolean, fluidsynth: boolean, tracker: boolean) => void> = vi.fn();
      server.onDependencyStateChange(listener);

      await request('POST', `/dependencies/${action}`, { id: 'yt-dlp' });
      const callsWhileRunning: number = listener.mock.calls.length;
      pending.resolve(true);
      await vi.waitFor((): void => { expect(listener).toHaveBeenCalledTimes(1); });

      expect(callsWhileRunning).toBe(0);
    });

    it.each(['ffmpeg', 'fluidsynth', 'yt-dlp'])('accepts %s as a dependency id', async (id: string) => {
      const { status } = await request('POST', `/dependencies/${action}`, { id });

      expect(status).toBe(202);
      expect(operation()).toHaveBeenCalledWith(id, expect.any(Function));
    });

    it.each([
      ['an unknown id', { id: 'rm -rf' }],
      ['a missing id', {}],
      ['a non-string id', { id: 7 }],
    ])('rejects %s without starting anything', async (_label: string, body: Record<string, unknown>) => {
      const response: { status: number; body: Record<string, unknown> } = await request('POST', `/dependencies/${action}`, body);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid dependency id' });
      expect(operation()).not.toHaveBeenCalled();
    });
  });

  describe('POST /dependencies/refresh', () => {
    it('returns the state found by re-detecting the binaries', async () => {
      harness.deps.state.ytdlpInstalled = false;
      harness.deps.detectBinaries.mockImplementation((): void => { harness.deps.state.ytdlpInstalled = true; });

      const { status, body } = await request('POST', '/dependencies/refresh');

      expect(status).toBe(200);
      expect(body['ytdlp']).toMatchObject({ installed: true });
    });

    it('broadcasts the re-detected state', async () => {
      harness.deps.detectBinaries.mockImplementation((): void => { harness.deps.state.trackerSupport = false; });
      const stream: EventStream = await connect();

      await request('POST', '/dependencies/refresh');

      expect((await stream.next('dependencies:state')).data).toMatchObject({ trackerSupport: false });
    });

    it('notifies the dependency listener with the re-detected capabilities', async () => {
      harness.deps.detectBinaries.mockImplementation((): void => { harness.deps.state.fluidsynthInstalled = false; });
      const listener: Mock<(ffmpeg: boolean, fluidsynth: boolean, tracker: boolean) => void> = vi.fn();
      server.onDependencyStateChange(listener);

      await request('POST', '/dependencies/refresh');

      expect(listener).toHaveBeenCalledExactlyOnceWith(true, false, true);
    });
  });

  describe('POST /dependencies/soundfont/install', () => {
    it('installs the file and returns its details', async () => {
      const installed: SoundFontInfo = makeSoundFont('strings.sf2');
      harness.deps.installSoundFont.mockReturnValue(installed);
      const sourcePath: string = path.join(suiteRoot, 'strings.sf2');

      const { status, body } = await request('POST', '/dependencies/soundfont/install', { sourcePath });

      expect(status).toBe(200);
      expect(body).toEqual({ success: true, soundfont: installed });
      expect(harness.deps.installSoundFont).toHaveBeenCalledExactlyOnceWith(sourcePath);
    });

    it('broadcasts the dependency state including the new SoundFont', async () => {
      const installed: SoundFontInfo = makeSoundFont('strings.sf2');
      harness.deps.installSoundFont.mockImplementation((): SoundFontInfo => {
        harness.deps.soundfonts = [installed];
        return installed;
      });
      const stream: EventStream = await connect();

      await request('POST', '/dependencies/soundfont/install', { sourcePath: path.join(suiteRoot, 'strings.sf2') });

      expect((await stream.next('dependencies:state')).data).toMatchObject({ soundfonts: [installed] });
    });

    it('reports why an installation failed', async () => {
      harness.deps.installSoundFont.mockImplementation((): SoundFontInfo => {
        throw new Error('Not a SoundFont file');
      });
      const listener: Mock<(ffmpeg: boolean, fluidsynth: boolean, tracker: boolean) => void> = vi.fn();
      server.onDependencyStateChange(listener);

      const { status, body } = await request('POST', '/dependencies/soundfont/install', { sourcePath: path.join(suiteRoot, 'notes.txt') });

      expect(status).toBe(500);
      expect(body).toEqual({ error: 'Not a SoundFont file' });
      expect(listener).not.toHaveBeenCalled();
    });

    it('rejects an empty sourcePath without touching the dependency manager', async () => {
      const { status, body } = await request('POST', '/dependencies/soundfont/install', { sourcePath: '' });

      expect(status).toBe(400);
      expect(body).toEqual({ error: 'Missing sourcePath' });
      expect(harness.deps.installSoundFont).not.toHaveBeenCalled();
    });
  });

  describe('POST /dependencies/soundfont/remove', () => {
    /** Makes the given SoundFonts installed, with one of them selected. */
    async function arrangeSoundFonts(fileNames: readonly string[], active: string): Promise<void> {
      harness.deps.soundfonts = fileNames.map(makeSoundFont);
      await request('POST', '/dependencies/soundfont/select', { fileName: active });
    }

    it('reports success when the file was removed', async () => {
      harness.deps.removeSoundFont.mockReturnValue(true);

      const { status, body } = await request('POST', '/dependencies/soundfont/remove', { fileName: 'old.sf2' });

      expect(status).toBe(200);
      expect(body).toEqual({ success: true });
      expect(harness.deps.removeSoundFont).toHaveBeenCalledExactlyOnceWith('old.sf2');
    });

    it('reports failure, and broadcasts nothing, when there was nothing to remove', async () => {
      harness.deps.removeSoundFont.mockReturnValue(false);
      const listener: Mock<(ffmpeg: boolean, fluidsynth: boolean, tracker: boolean) => void> = vi.fn();
      server.onDependencyStateChange(listener);

      const { status, body } = await request('POST', '/dependencies/soundfont/remove', { fileName: 'ghost.sf2' });

      expect(status).toBe(200);
      expect(body).toEqual({ success: false });
      expect(listener).not.toHaveBeenCalled();
    });

    it('clears the active selection when the active SoundFont is removed', async () => {
      await arrangeSoundFonts(['active.sf2', 'other.sf2'], 'active.sf2');
      harness.deps.removeSoundFont.mockReturnValue(true);

      await request('POST', '/dependencies/soundfont/remove', { fileName: 'active.sf2' });

      expect((await settingsSection('application'))['activeSoundFontFileName']).toBeNull();
    });

    it('discards rendered MIDI when the active SoundFont is removed', async () => {
      await arrangeSoundFonts(['active.sf2'], 'active.sf2');
      harness.deps.removeSoundFont.mockReturnValue(true);
      internals(server).midiRenderCache.set('song.mid', { tempFile: path.join(suiteTemp, 'song.m4a'), duration: 10 });

      await request('POST', '/dependencies/soundfont/remove', { fileName: 'active.sf2' });

      expect(internals(server).midiRenderCache.size).toBe(0);
    });

    it('keeps the active selection and rendered MIDI when a different SoundFont is removed', async () => {
      await arrangeSoundFonts(['active.sf2', 'other.sf2'], 'active.sf2');
      harness.deps.removeSoundFont.mockReturnValue(true);
      internals(server).midiRenderCache.set('song.mid', { tempFile: path.join(suiteTemp, 'song.m4a'), duration: 10 });

      try {
        await request('POST', '/dependencies/soundfont/remove', { fileName: 'other.sf2' });

        expect((await settingsSection('application'))['activeSoundFontFileName']).toBe('active.sf2');
        expect(internals(server).midiRenderCache.size).toBe(1);
      } finally {
        server.nukeMidiCache();
      }
    });

    it('broadcasts the dependency state without the removed SoundFont', async () => {
      await arrangeSoundFonts(['keep.sf2', 'drop.sf2'], 'keep.sf2');
      harness.deps.removeSoundFont.mockImplementation((fileName: string): boolean => {
        harness.deps.soundfonts = harness.deps.soundfonts.filter((sf: SoundFontInfo): boolean => sf.fileName !== fileName);
        return true;
      });
      const stream: EventStream = await connect();

      await request('POST', '/dependencies/soundfont/remove', { fileName: 'drop.sf2' });

      const state: DependencyState = (await stream.next('dependencies:state')).data as DependencyState;
      expect(state.soundfonts.map((sf: SoundFontInfo): string => sf.fileName)).toEqual(['keep.sf2']);
      expect(state.activeSoundFont).toBe('keep.sf2');
    });
  });

  describe('POST /dependencies/soundfont/select', () => {
    const midiPath: string = path.join(suiteRoot, 'tune.mid');

    /** Puts the server into the given playback state for one file, as playback would. */
    function arrangePlayback(filePath: string, state: PlaybackState['state']): void {
      const playback: PlaybackState = internals(server).playback;
      playback.currentMedia = makeMedia(filePath);
      playback.state = state;
      playback.currentTime = 30;
    }

    beforeEach(() => {
      harness.deps.soundfonts = [makeSoundFont('grand.sf2'), makeSoundFont('organ.sf2')];
    });

    afterEach(() => {
      server.clearPlaylist();
    });

    it('stores an installed SoundFont as the active one', async () => {
      const { status, body } = await request('POST', '/dependencies/soundfont/select', { fileName: 'organ.sf2' });

      expect(status).toBe(200);
      expect(body).toEqual({ success: true, activeSoundFont: 'organ.sf2' });
      expect((await settingsSection('application'))['activeSoundFontFileName']).toBe('organ.sf2');
    });

    it('clears the selection when given null', async () => {
      await request('POST', '/dependencies/soundfont/select', { fileName: 'organ.sf2' });

      const { status, body } = await request('POST', '/dependencies/soundfont/select', { fileName: null });

      expect(status).toBe(200);
      expect(body).toEqual({ success: true, activeSoundFont: null });
      expect((await settingsSection('application'))['activeSoundFontFileName']).toBeNull();
    });

    it('rejects a SoundFont that is not installed and keeps the current selection', async () => {
      await request('POST', '/dependencies/soundfont/select', { fileName: 'grand.sf2' });

      const { status, body } = await request('POST', '/dependencies/soundfont/select', { fileName: 'missing.sf2' });

      expect(status).toBe(400);
      expect(body).toEqual({ error: 'SoundFont "missing.sf2" not found' });
      expect((await settingsSection('application'))['activeSoundFontFileName']).toBe('grand.sf2');
    });

    it('discards rendered MIDI, which was rendered with the previous SoundFont', async () => {
      internals(server).midiRenderCache.set(midiPath, { tempFile: path.join(suiteTemp, 'tune.m4a'), duration: 10 });

      await request('POST', '/dependencies/soundfont/select', { fileName: 'grand.sf2' });

      expect(internals(server).midiRenderCache.size).toBe(0);
    });

    it('broadcasts the dependency state with the new active SoundFont', async () => {
      const stream: EventStream = await connect();

      await request('POST', '/dependencies/soundfont/select', { fileName: 'organ.sf2' });

      expect((await stream.next('dependencies:state')).data).toMatchObject({ activeSoundFont: 'organ.sf2' });
    });

    it('announces the change without a restart when no MIDI is playing', async () => {
      const stream: EventStream = await connect();

      await request('POST', '/dependencies/soundfont/select', { fileName: 'organ.sf2' });

      expect((await stream.next('soundfont:changed')).data).toEqual({ restart: false });
    });

    it('announces the change without a restart when the playing file is not MIDI', async () => {
      arrangePlayback(path.join(suiteRoot, 'song.mp3'), 'playing');
      const stream: EventStream = await connect();

      await request('POST', '/dependencies/soundfont/select', { fileName: 'organ.sf2' });

      expect((await stream.next('soundfont:changed')).data).toEqual({ restart: false });
      expect(internals(server).playback.state).toBe('playing');
    });

    it('does not ask for a restart of a MIDI file that has already stopped', async () => {
      arrangePlayback(midiPath, 'stopped');
      const stream: EventStream = await connect();

      await request('POST', '/dependencies/soundfont/select', { fileName: 'organ.sf2' });

      expect((await stream.next('soundfont:changed')).data).toEqual({ restart: false });
    });

    it.each(['playing', 'paused'] as const)('asks the client to restart a MIDI file that is %s', async (state: 'playing' | 'paused') => {
      arrangePlayback(midiPath, state);
      const stream: EventStream = await connect();

      await request('POST', '/dependencies/soundfont/select', { fileName: 'organ.sf2' });

      expect((await stream.next('soundfont:changed')).data).toEqual({ restart: true, filePath: midiPath });
    });

    it('stops a playing MIDI file and rewinds it', async () => {
      arrangePlayback(midiPath, 'playing');
      const stream: EventStream = await connect();

      await request('POST', '/dependencies/soundfont/select', { fileName: 'organ.sf2' });

      expect((await stream.next('playback:state')).data).toMatchObject({ state: 'stopped' });
      expect((await stream.next('playback:time')).data).toMatchObject({ currentTime: 0 });
    });

    it('recognizes a MIDI file by extension regardless of case', async () => {
      const upperCasePath: string = path.join(suiteRoot, 'TUNE.MID');
      arrangePlayback(upperCasePath, 'playing');
      const stream: EventStream = await connect();

      await request('POST', '/dependencies/soundfont/select', { fileName: 'organ.sf2' });

      expect((await stream.next('soundfont:changed')).data).toEqual({ restart: true, filePath: upperCasePath });
    });
  });

  // ==========================================================================
  // Render cache clears
  // ==========================================================================

  describe.each([
    ['nukeMidiCache', 'onixplayer-midi', 'onixplayer-tracker'],
    ['nukeTrackerCache', 'onixplayer-tracker', 'onixplayer-midi'],
  ] as const)('%s', (method: 'nukeMidiCache' | 'nukeTrackerCache', directoryName: string, otherDirectoryName: string) => {
    let tempRoot: string = '';
    let cacheDir: string = '';

    function renderCache(): Map<string, { readonly tempFile: string; readonly duration: number }> {
      return method === 'nukeMidiCache' ? internals(server).midiRenderCache : internals(server).trackerRenderCache;
    }

    function rendersInProgress(): Map<string, Promise<string>> {
      return method === 'nukeMidiCache' ? internals(server).midiRenderInProgress : internals(server).trackerRenderInProgress;
    }

    beforeEach(() => {
      tempRoot = makeDir('cache');
      harness.paths.temp = tempRoot;
      cacheDir = path.join(tempRoot, directoryName);
    });

    it('makes the cache directory unreachable by the time it returns', () => {
      fs.mkdirSync(cacheDir);
      fs.writeFileSync(path.join(cacheDir, 'render.m4a'), 'audio');

      server[method]();

      expect(fs.existsSync(cacheDir)).toBe(false);
    });

    it('deletes the rendered files from disk', async () => {
      fs.mkdirSync(path.join(cacheDir, 'nested'), { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'render.m4a'), 'audio');
      fs.writeFileSync(path.join(cacheDir, 'nested', 'render.wav'), 'audio');

      server[method]();

      await vi.waitFor((): void => { expect(fs.readdirSync(tempRoot)).toEqual([]); });
    });

    it('lets a new cache directory be created straight away', async () => {
      fs.mkdirSync(cacheDir);
      fs.writeFileSync(path.join(cacheDir, 'old.m4a'), 'old');

      server[method]();
      fs.mkdirSync(cacheDir);
      fs.writeFileSync(path.join(cacheDir, 'new.m4a'), 'new');

      await vi.waitFor((): void => { expect(entriesStartingWith(tempRoot, `${directoryName}-discarded-`)).toEqual([]); });
      expect(fs.readFileSync(path.join(cacheDir, 'new.m4a'), 'utf-8')).toBe('new');
    });

    it('forgets every cached and in-flight render', () => {
      renderCache().set('a', { tempFile: path.join(cacheDir, 'a.m4a'), duration: 1 });
      rendersInProgress().set('b', Promise.resolve(path.join(cacheDir, 'b.m4a')));

      server[method]();

      expect(renderCache().size).toBe(0);
      expect(rendersInProgress().size).toBe(0);
    });

    it('leaves the other render cache alone', () => {
      const otherDir: string = path.join(tempRoot, otherDirectoryName);
      fs.mkdirSync(cacheDir);
      fs.mkdirSync(otherDir);
      fs.writeFileSync(path.join(otherDir, 'render.m4a'), 'audio');

      server[method]();

      expect(fs.existsSync(path.join(otherDir, 'render.m4a'))).toBe(true);
    });

    it('creates nothing when there is no cache directory', () => {
      server[method]();

      expect(fs.readdirSync(tempRoot)).toEqual([]);
    });
  });

  // ==========================================================================
  // URL media
  // ==========================================================================

  describe('POST /media/url/info', () => {
    const info: UrlMediaInfo = {
      title: 'A video',
      thumbnail: 'https://example.com/thumb.jpg',
      duration: 212,
      uploader: 'Someone',
      formats: [{ id: '137', label: '1080p', height: 1080 }],
    };

    it('returns the metadata resolved for the URL', async () => {
      harness.download.getInfo.mockResolvedValue(info);

      const { status, body } = await request('POST', '/media/url/info', { url: 'https://example.com/watch?v=1' });

      expect(status).toBe(200);
      expect(body).toEqual(info);
    });

    it('trims whitespace around the URL before resolving it', async () => {
      harness.download.getInfo.mockResolvedValue(info);

      await request('POST', '/media/url/info', { url: '  https://example.com/watch?v=1\n' });

      expect(harness.download.getInfo).toHaveBeenCalledExactlyOnceWith('https://example.com/watch?v=1');
    });

    it('reports why the URL could not be resolved', async () => {
      harness.download.getInfo.mockRejectedValue(new Error('yt-dlp is not installed'));

      const { status, body } = await request('POST', '/media/url/info', { url: 'https://example.com/watch?v=1' });

      expect(status).toBe(400);
      expect(body).toEqual({ error: 'yt-dlp is not installed' });
    });

    it.each([
      ['a missing URL', {}],
      ['a blank URL', { url: '   ' }],
      ['a non-string URL', { url: 42 }],
    ])('rejects %s without invoking yt-dlp', async (_label: string, body: Record<string, unknown>) => {
      const response: { status: number; body: Record<string, unknown> } = await request('POST', '/media/url/info', body);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'No URL provided' });
      expect(harness.download.getInfo).not.toHaveBeenCalled();
    });
  });

  describe('POST /media/url/download', () => {
    /** Starts a download through the endpoint and returns the listener the server registered for it. */
    async function startDownload(body: Record<string, unknown> = { url: 'https://example.com/watch?v=1' }): Promise<DownloadListener> {
      harness.download.startDownload.mockReturnValue('job-1');
      await request('POST', '/media/url/download', body);
      return harness.download.startDownload.mock.calls[0][5];
    }

    it('returns the id of the started job', async () => {
      harness.download.startDownload.mockReturnValue('job-42');

      const { status, body } = await request('POST', '/media/url/download', { url: 'https://example.com/watch?v=1' });

      expect(status).toBe(200);
      expect(body).toEqual({ jobId: 'job-42' });
    });

    it('downloads video, in the best format, to the downloads directory by default', async () => {
      harness.download.startDownload.mockReturnValue('job-1');

      await request('POST', '/media/url/download', { url: ' https://example.com/watch?v=1 ' });

      expect(harness.download.startDownload).toHaveBeenCalledExactlyOnceWith('https://example.com/watch?v=1', 'video', null, '', null, expect.any(Function));
    });

    it('passes on the requested format, quality, title and destination', async () => {
      harness.download.startDownload.mockReturnValue('job-1');
      const outputPath: string = path.join(suiteRoot, 'saved.m4a');

      await request('POST', '/media/url/download', { url: 'https://example.com/watch?v=1', format: 'audio', formatId: '140', title: 'A song', outputPath });

      expect(harness.download.startDownload).toHaveBeenCalledExactlyOnceWith('https://example.com/watch?v=1', 'audio', '140', 'A song', outputPath, expect.any(Function));
    });

    it('falls back to the defaults for fields of the wrong type', async () => {
      harness.download.startDownload.mockReturnValue('job-1');

      await request('POST', '/media/url/download', { url: 'https://example.com/watch?v=1', format: 'flac', formatId: 140, title: null, outputPath: '   ' });

      expect(harness.download.startDownload).toHaveBeenCalledExactlyOnceWith('https://example.com/watch?v=1', 'video', null, '', null, expect.any(Function));
    });

    it.each([
      ['a missing URL', {}],
      ['a blank URL', { url: '' }],
      ['a non-string URL', { url: ['https://example.com'] }],
    ])('rejects %s without starting a download', async (_label: string, body: Record<string, unknown>) => {
      const response: { status: number; body: Record<string, unknown> } = await request('POST', '/media/url/download', body);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'No URL provided' });
      expect(harness.download.startDownload).not.toHaveBeenCalled();
    });

    it('broadcasts progress while the job is downloading', async () => {
      const stream: EventStream = await connect();
      const notify: DownloadListener = await startDownload();
      const job: DownloadJob = makeJob({ status: 'downloading', progress: 55 });

      notify(job);

      expect((await stream.next('download:progress')).data).toEqual(job);
    });

    it('broadcasts completion with the downloaded file', async () => {
      const stream: EventStream = await connect();
      const notify: DownloadListener = await startDownload();
      const job: DownloadJob = makeJob({ status: 'done', progress: 100, filePath: path.join(suiteRoot, 'video.mp4') });

      notify(job);

      expect((await stream.next('download:complete')).data).toEqual(job);
    });

    it('broadcasts a failure with its message', async () => {
      const stream: EventStream = await connect();
      const notify: DownloadListener = await startDownload();
      const job: DownloadJob = makeJob({ status: 'error', progress: null, errorMessage: 'HTTP Error 403' });

      notify(job);

      expect((await stream.next('download:error')).data).toEqual(job);
    });

    it('reports a cancelled job as a progress update, not as a completion or failure', async () => {
      const stream: EventStream = await connect();
      const notify: DownloadListener = await startDownload();
      const job: DownloadJob = makeJob({ status: 'cancelled', progress: null });

      notify(job);

      expect((await stream.next('download:progress')).data).toEqual(job);
    });
  });

  describe('POST /media/url/resolve', () => {
    afterEach(() => {
      internals(server).dashAudioPairs.clear();
    });

    it('returns only the video stream URL to the client', async () => {
      harness.download.resolveStreamSources.mockResolvedValue({ video: 'https://cdn.example.com/v.mp4', audio: 'https://cdn.example.com/a.m4a' });

      const { status, body } = await request('POST', '/media/url/resolve', { url: 'https://example.com/watch?v=1' });

      expect(status).toBe(200);
      expect(body).toEqual({ url: 'https://cdn.example.com/v.mp4' });
    });

    it('resolves video at any height by default', async () => {
      harness.download.resolveStreamSources.mockResolvedValue({ video: 'https://cdn.example.com/v.mp4', audio: null });

      await request('POST', '/media/url/resolve', { url: ' https://example.com/watch?v=1 ' });

      expect(harness.download.resolveStreamSources).toHaveBeenCalledExactlyOnceWith('https://example.com/watch?v=1', 'video', null);
    });

    it('passes on the requested format and height cap', async () => {
      harness.download.resolveStreamSources.mockResolvedValue({ video: 'https://cdn.example.com/a.m4a', audio: null });

      await request('POST', '/media/url/resolve', { url: 'https://example.com/watch?v=1', format: 'audio', maxHeight: 720 });

      expect(harness.download.resolveStreamSources).toHaveBeenCalledExactlyOnceWith('https://example.com/watch?v=1', 'audio', 720);
    });

    it('ignores a height cap that is not a number', async () => {
      harness.download.resolveStreamSources.mockResolvedValue({ video: 'https://cdn.example.com/v.mp4', audio: null });

      await request('POST', '/media/url/resolve', { url: 'https://example.com/watch?v=1', maxHeight: '720' });

      expect(harness.download.resolveStreamSources).toHaveBeenCalledExactlyOnceWith('https://example.com/watch?v=1', 'video', null);
    });

    it('reports why the URL could not be resolved', async () => {
      harness.download.resolveStreamSources.mockRejectedValue(new Error('Unsupported URL'));

      const { status, body } = await request('POST', '/media/url/resolve', { url: 'https://example.com/nothing' });

      expect(status).toBe(400);
      expect(body).toEqual({ error: 'Unsupported URL' });
    });

    it.each([
      ['a missing URL', {}],
      ['a blank URL', { url: ' ' }],
      ['a non-string URL', { url: false }],
    ])('rejects %s without invoking yt-dlp', async (_label: string, body: Record<string, unknown>) => {
      const response: { status: number; body: Record<string, unknown> } = await request('POST', '/media/url/resolve', body);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'No URL provided' });
      expect(harness.download.resolveStreamSources).not.toHaveBeenCalled();
    });

    it('remembers the separate audio stream of a DASH video', async () => {
      harness.download.resolveStreamSources.mockResolvedValue({ video: 'https://cdn.example.com/v.mp4', audio: 'https://cdn.example.com/a.m4a' });

      await request('POST', '/media/url/resolve', { url: 'https://example.com/watch?v=1' });

      expect(internals(server).dashAudioPairs.get('https://cdn.example.com/v.mp4')).toBe('https://cdn.example.com/a.m4a');
    });

    it('replaces the audio stream when the same video URL is resolved again', async () => {
      harness.download.resolveStreamSources.mockResolvedValueOnce({ video: 'https://cdn.example.com/v.mp4', audio: 'https://cdn.example.com/old.m4a' });
      harness.download.resolveStreamSources.mockResolvedValueOnce({ video: 'https://cdn.example.com/v.mp4', audio: 'https://cdn.example.com/new.m4a' });

      await request('POST', '/media/url/resolve', { url: 'https://example.com/watch?v=1' });
      await request('POST', '/media/url/resolve', { url: 'https://example.com/watch?v=1' });

      expect([...internals(server).dashAudioPairs]).toEqual([['https://cdn.example.com/v.mp4', 'https://cdn.example.com/new.m4a']]);
    });

    it('forgets a stale audio pairing when the URL now resolves to a single progressive stream', async () => {
      harness.download.resolveStreamSources.mockResolvedValueOnce({ video: 'https://cdn.example.com/v.mp4', audio: 'https://cdn.example.com/a.m4a' });
      harness.download.resolveStreamSources.mockResolvedValueOnce({ video: 'https://cdn.example.com/v.mp4', audio: null });

      await request('POST', '/media/url/resolve', { url: 'https://example.com/watch?v=1' });
      await request('POST', '/media/url/resolve', { url: 'https://example.com/watch?v=1' });

      expect(internals(server).dashAudioPairs.has('https://cdn.example.com/v.mp4')).toBe(false);
    });

    it('records no pairing when resolution fails', async () => {
      harness.download.resolveStreamSources.mockRejectedValue(new Error('Unsupported URL'));

      await request('POST', '/media/url/resolve', { url: 'https://example.com/nothing' });

      expect(internals(server).dashAudioPairs.size).toBe(0);
    });

    it('keeps at most 50 pairings, evicting the oldest first', async () => {
      harness.download.resolveStreamSources.mockImplementation((url: string): Promise<StreamSources> =>
        Promise.resolve({ video: `${url}/video`, audio: `${url}/audio` }));

      for (let index: number = 0; index < 52; index++) {
        await request('POST', '/media/url/resolve', { url: `https://example.com/${index}` });
      }

      const pairs: Map<string, string> = internals(server).dashAudioPairs;
      expect(pairs.size).toBe(50);
      expect(pairs.has('https://example.com/0/video')).toBe(false);
      expect(pairs.has('https://example.com/1/video')).toBe(false);
      expect(pairs.get('https://example.com/2/video')).toBe('https://example.com/2/audio');
      expect(pairs.get('https://example.com/51/video')).toBe('https://example.com/51/audio');
    });
  });

  describe('GET /media/url/status/:jobId', () => {
    it('returns the job', async () => {
      const job: DownloadJob = makeJob({ id: 'job-7', progress: 80 });
      harness.download.getJob.mockImplementation((id: string): DownloadJob | undefined => (id === 'job-7' ? job : undefined));

      const { status, body } = await request('GET', '/media/url/status/job-7');

      expect(status).toBe(200);
      expect(body).toEqual(job);
    });

    it('answers 404 for a job that does not exist', async () => {
      harness.download.getJob.mockReturnValue(undefined);

      const { status, body } = await request('GET', '/media/url/status/nope');

      expect(status).toBe(404);
      expect(body).toEqual({ error: 'Job not found' });
    });

    it('decodes a percent-encoded job id', async () => {
      harness.download.getJob.mockReturnValue(undefined);

      await request('GET', `/media/url/status/${encodeURIComponent('job a/b')}`);

      expect(harness.download.getJob).toHaveBeenCalledExactlyOnceWith('job a/b');
    });
  });

  describe('POST /media/url/cancel/:jobId', () => {
    it('confirms the cancellation of a running job', async () => {
      harness.download.cancelDownload.mockReturnValue(true);

      const { status, body } = await request('POST', '/media/url/cancel/job-7');

      expect(status).toBe(200);
      expect(body).toEqual({ cancelled: true });
      expect(harness.download.cancelDownload).toHaveBeenCalledExactlyOnceWith('job-7');
    });

    it('answers 404 when there is no such running job', async () => {
      harness.download.cancelDownload.mockReturnValue(false);

      const { status, body } = await request('POST', '/media/url/cancel/finished');

      expect(status).toBe(404);
      expect(body).toEqual({ cancelled: false });
    });

    it('decodes a percent-encoded job id', async () => {
      harness.download.cancelDownload.mockReturnValue(false);

      await request('POST', `/media/url/cancel/${encodeURIComponent('job a/b')}`);

      expect(harness.download.cancelDownload).toHaveBeenCalledExactlyOnceWith('job a/b');
    });
  });

  // ==========================================================================
  // Listeners main.ts registers
  // ==========================================================================

  describe('onMediaTypeChange', () => {
    afterEach(() => {
      server.onMediaTypeChange((): void => undefined);
      server.clearPlaylist();
    });

    it('reports that no video is showing once the playlist is cleared', () => {
      internals(server).playback.currentMedia = makeMedia(path.join(suiteRoot, 'film.mp4'), 'video');
      const listener: Mock<(isVideo: boolean) => void> = vi.fn();
      server.onMediaTypeChange(listener);

      server.clearPlaylist();

      expect(listener).toHaveBeenCalledExactlyOnceWith(false);
    });

    it('reports a video when playback state is broadcast for a video file', async () => {
      const playback: PlaybackState = internals(server).playback;
      playback.currentMedia = makeMedia(path.join(suiteRoot, 'film.mp4'), 'video');
      playback.state = 'playing';
      const listener: Mock<(isVideo: boolean) => void> = vi.fn();
      server.onMediaTypeChange(listener);

      await request('POST', '/player/stop');

      expect(listener).toHaveBeenCalledWith(true);
    });
  });
});

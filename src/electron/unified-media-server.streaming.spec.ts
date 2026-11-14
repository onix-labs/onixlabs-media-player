/**
 * @fileoverview Integration tests for the streaming side of UnifiedMediaServer.
 *
 * Tests cover:
 * - Stream routing (GET /media/stream): direct, transcoded, remote, DASH, MIDI, tracker
 * - The ffmpeg command chosen for each transcoding mode (remux, hybrid, full,
 *   audio-only), seek alignment to the probed keyframe and encoder selection
 * - MIDI and tracker pre-rendering: caching in memory and on disk, content
 *   hashing, deduplication of concurrent renders, the background render queue
 * - Artwork extraction (GET /media/artwork) and its cache
 * - Subtitle extraction and conversion (GET /media/subtitles[/external])
 * - Failure paths: missing binaries, non-zero exits, spawn errors and client
 *   disconnects
 *
 * A real server is started on a random port for every test. No real ffmpeg,
 * ffprobe or fluidsynth is ever run: `child_process.spawn` is replaced with a
 * fake whose processes the tests drive by hand, and the DependencyManager's
 * binary lookups are pointed at fake paths.
 *
 * @module electron/unified-media-server.streaming.spec
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { IncomingMessage, ClientRequest } from 'http';
import http from 'http';

// ============================================================================
// Mocks — must be defined before importing the module under test
// ============================================================================

/** State the module mocks read lazily; hoisted so the factories can see it. */
const shared: {
  userDataPath: string;
  tempPath: string;
  logLines: string[];
  logWaiters: Array<{ text: string; resolve: () => void }>;
} = vi.hoisted(() => ({
  userDataPath: '',
  tempPath: '',
  logLines: [],
  logWaiters: [],
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => (name === 'userData' ? shared.userDataPath : shared.tempPath),
  },
  net: {
    fetch: vi.fn(),
  },
}));

vi.mock('module', () => {
  /** Records a log line and releases any test waiting for it. */
  const record: (...params: unknown[]) => void = (...params: unknown[]): void => {
    const line: string = params.map(String).join(' ');
    shared.logLines.push(line);
    for (const waiter of shared.logWaiters.filter((w: { text: string }): boolean => line.includes(w.text))) {
      shared.logWaiters.splice(shared.logWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };

  return {
    createRequire: (): (() => Record<string, unknown>) => (): Record<string, unknown> => ({
      transports: {
        file: { resolvePathFn: null, maxSize: 0, format: '', level: '' },
        console: { format: '', level: '' },
      },
      scope: (name: string): Record<string, unknown> => ({
        error: record,
        warn: record,
        info: record,
        debug: record,
        _scope: name,
      }),
      initialize: vi.fn(),
      errorHandler: { startCatching: vi.fn() },
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock('child_process', async (importOriginal: () => Promise<typeof import('child_process')>) => {
  const actual: typeof import('child_process') = await importOriginal();
  return {
    ...actual,
    spawn: (command: string, args?: readonly string[]): FakeProcess => fakeSpawn(command, args ?? []),
    execFile: (...params: unknown[]): EventEmitter => fakeExecFile(params),
    // Binary detection must not find (or wait on) anything installed locally.
    execFileSync: (): never => {
      throw new Error('execFileSync is disabled in this suite');
    },
  };
});

// ============================================================================
// Import under test
// ============================================================================

import { UnifiedMediaServer } from './unified-media-server.js';
import type { DependencyManager } from './dependency-manager.js';

// ============================================================================
// Fake child processes
// ============================================================================

/**
 * Stand-in for a spawned ChildProcess. It does nothing until a test tells it
 * to produce output, exit, or fail.
 */
class FakeProcess extends EventEmitter {
  public readonly stdout: PassThrough = new PassThrough();
  public readonly stderr: PassThrough = new PassThrough();
  public readonly stdin: PassThrough = new PassThrough();

  /** Mirrors ChildProcess.exitCode: null while running or when killed. */
  public exitCode: number | null = null;

  /** Signals this process was killed with, in order. */
  public readonly signals: string[] = [];

  /** Resolves with the signal the first time the process is killed. */
  public readonly killed: Promise<string>;

  /** Resolves with everything written to stdin once stdin is closed. */
  public readonly stdinClosed: Promise<string>;

  private finished: boolean = false;
  private resolveKilled: (signal: string) => void = (): void => undefined;

  constructor(public readonly command: string, public readonly args: readonly string[]) {
    super();
    this.killed = new Promise<string>((resolve: (signal: string) => void): void => {
      this.resolveKilled = resolve;
    });
    this.stdinClosed = new Promise<string>((resolve: (data: string) => void): void => {
      const chunks: Buffer[] = [];
      this.stdin.on('data', (chunk: Buffer): void => {
        chunks.push(chunk);
      });
      this.stdin.on('end', (): void => resolve(Buffer.concat(chunks).toString()));
    });
    this.stderr.resume();
  }

  /** The final argument: the input for a probe, the output file for a render. */
  public get lastArg(): string {
    return this.args[this.args.length - 1];
  }

  /** Writes optional stdout and exits with the given code. */
  public exit(code: number, output?: string | Buffer): void {
    if (output !== undefined) {
      this.stdout.write(output);
    }
    this.finish(code, null);
  }

  /** Emits a spawn-level error, as Node does when the binary cannot be run. */
  public fail(error: Error): void {
    this.emit('error', error);
  }

  /**
   * Fails the way Node does for a binary that is not there: an 'error', then
   * the never-connected output pipes end and 'close' reports a negative code.
   */
  public failToStart(error: Error): void {
    this.emit('error', error);
    this.finish(-2, null);
  }

  public kill(signal: string = 'SIGTERM'): boolean {
    if (this.finished) {
      return false;
    }
    this.signals.push(signal);
    this.resolveKilled(signal);
    this.finish(null, signal);
    return true;
  }

  /** Ends the output streams, then reports 'close' once stdout has drained. */
  private finish(code: number | null, signal: string | null): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.exitCode = code;
    this.stderr.end();
    this.stdout.once('end', (): void => {
      this.emit('close', code, signal);
    });
    this.stdout.end();
    this.stdout.resume();
  }
}

const fakeBinDir: string = path.join(os.tmpdir(), 'onix-streaming-fake-bin');
const FFMPEG: string = path.join(fakeBinDir, 'ffmpeg');
const FFPROBE: string = path.join(fakeBinDir, 'ffprobe');
const FLUIDSYNTH: string = path.join(fakeBinDir, 'fluidsynth');
const YTDLP: string = path.join(fakeBinDir, 'yt-dlp');
const SOUNDFONT: string = path.join(fakeBinDir, 'general.sf2');
const KNOWN_BINARIES: ReadonlySet<string> = new Set([FFMPEG, FFPROBE, FLUIDSYNTH]);

/** Every fake process spawned through a known binary during the current test. */
let spawnedProcesses: FakeProcess[] = [];

/** Spawned processes no test has asked for yet. */
let unclaimedProcesses: FakeProcess[] = [];

/** Tests waiting for a process that has not been spawned yet. */
let spawnWaiters: Array<{ matches: (proc: FakeProcess) => boolean; resolve: (proc: FakeProcess) => void }> = [];

/** When set, the next spawn throws this synchronously. */
let nextSpawnError: Error | null = null;

/** What the fake yt-dlp prints for a stream resolution. */
let ytDlpOutput: string = '';

function fakeSpawn(command: string, args: readonly string[]): FakeProcess {
  if (nextSpawnError) {
    const error: Error = nextSpawnError;
    nextSpawnError = null;
    throw error;
  }

  const proc: FakeProcess = new FakeProcess(command, args);

  // Anything else is the DependencyManager probing a binary that happens to be
  // installed on this machine; report failure so nothing is detected.
  if (!KNOWN_BINARIES.has(command)) {
    proc.on('error', (): void => undefined);
    setImmediate((): void => proc.exit(1));
    return proc;
  }

  spawnedProcesses.push(proc);
  const waiterIndex: number = spawnWaiters.findIndex(
    (waiter: { matches: (p: FakeProcess) => boolean }): boolean => waiter.matches(proc),
  );
  if (waiterIndex >= 0) {
    const [waiter] = spawnWaiters.splice(waiterIndex, 1);
    waiter.resolve(proc);
  } else {
    unclaimedProcesses.push(proc);
  }
  return proc;
}

function fakeExecFile(params: readonly unknown[]): EventEmitter {
  const callback: unknown = params[params.length - 1];
  if (typeof callback === 'function') {
    setImmediate((): void => {
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(null, ytDlpOutput, '');
    });
  }
  return new EventEmitter();
}

/**
 * Resolves with the next process spawned from the given binary that no other
 * call has claimed, waiting for it if it has not been spawned yet.
 */
function nextSpawn(command: string, predicate: (proc: FakeProcess) => boolean = (): boolean => true): Promise<FakeProcess> {
  const matches: (proc: FakeProcess) => boolean = (proc: FakeProcess): boolean =>
    proc.command === command && predicate(proc);
  const index: number = unclaimedProcesses.findIndex(matches);
  if (index >= 0) {
    return Promise.resolve(unclaimedProcesses.splice(index, 1)[0]);
  }
  return new Promise<FakeProcess>((resolve: (proc: FakeProcess) => void): void => {
    spawnWaiters.push({ matches, resolve });
  });
}

/** Number of processes spawned from the given binary so far in this test. */
function spawnCount(command: string): number {
  return spawnedProcesses.filter((proc: FakeProcess): boolean => proc.command === command).length;
}

/** Resolves once a log line containing the text has been written. */
function logged(text: string): Promise<void> {
  if (shared.logLines.some((line: string): boolean => line.includes(text))) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve: () => void): void => {
    shared.logWaiters.push({ text, resolve });
  });
}

// ============================================================================
// Dependency configuration
// ============================================================================

/** What the server's DependencyManager reports; reset before every test. */
interface FakeDependencies {
  ffmpeg: string | null;
  ffprobe: string | null;
  fluidsynth: string | null;
  soundfont: string | undefined;
  trackerSupport: boolean;
  hardwareEncoders: string[];
  /** Number of SoundFont lookups made; a MIDI render makes one as it starts. */
  soundfontLookups: number;
}

const dependencies: FakeDependencies = {
  ffmpeg: FFMPEG,
  ffprobe: FFPROBE,
  fluidsynth: FLUIDSYNTH,
  soundfont: SOUNDFONT,
  trackerSupport: true,
  hardwareEncoders: [],
  soundfontLookups: 0,
};

// ============================================================================
// Server harness
// ============================================================================

interface TestServer {
  readonly instance: UnifiedMediaServer;
  readonly baseUrl: string;
  readonly token: string;
}

/** Root of everything the current test writes to disk. */
let testRoot: string = '';

/** Directory for the media files a test creates. */
let mediaDir: string = '';

/** The server most tests talk to. */
let primary: TestServer;

/** Every server started by the current test, so all of them get stopped. */
let startedServers: TestServer[] = [];

/** Open SSE connections to close after the test. */
let openRequests: ClientRequest[] = [];

/**
 * Starts a server whose binaries are the fakes above. A second server shares
 * the first one's disk caches but none of its in-memory state, which is how
 * the tests model an app restart.
 */
async function startServer(): Promise<TestServer> {
  const instance: UnifiedMediaServer = new UnifiedMediaServer();
  const deps: DependencyManager = instance.getDependencyManager();
  vi.spyOn(deps, 'getFfmpegPath').mockImplementation((): string | null => dependencies.ffmpeg);
  vi.spyOn(deps, 'getFfprobePath').mockImplementation((): string | null => dependencies.ffprobe);
  vi.spyOn(deps, 'getFluidsynthPath').mockImplementation((): string | null => dependencies.fluidsynth);
  vi.spyOn(deps, 'getYtDlpPath').mockImplementation((): string | null => YTDLP);
  vi.spyOn(deps, 'hasTrackerSupport').mockImplementation((): boolean => dependencies.trackerSupport);
  vi.spyOn(deps, 'findSoundFont').mockImplementation((): string | undefined => {
    dependencies.soundfontLookups++;
    return dependencies.soundfont;
  });
  vi.spyOn(deps, 'getHardwareEncoders').mockImplementation(() => ({
    available: dependencies.hardwareEncoders.length > 0,
    encoders: dependencies.hardwareEncoders,
  }));

  const port: number = await instance.start();
  const started: TestServer = { instance, baseUrl: `http://127.0.0.1:${port}`, token: instance.getAuthToken() };
  startedServers.push(started);
  return started;
}

/** Sends an authenticated request to a server (the primary one by default). */
function api(urlPath: string, init: RequestInit = {}, target: TestServer = primary): Promise<Response> {
  return fetch(`${target.baseUrl}${urlPath}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), 'X-Onix-Token': target.token },
  });
}

/** Builds a URL path with the given query parameters. */
function withQuery(route: string, query: Record<string, string>): string {
  return `${route}?${new URLSearchParams(query).toString()}`;
}

/** Path of a stream request for a file or URL. */
function streamPath(source: string, query: Record<string, string> = {}): string {
  return withQuery('/media/stream', { path: source, ...query });
}

/** Reads the `error` field of a JSON error response. */
async function errorOf(res: Response): Promise<string> {
  const body: { error?: unknown } = await res.json() as { error?: unknown };
  return String(body.error);
}

/** Creates a file in the test's media directory and returns its path. */
function mediaFile(name: string, content: string | Buffer = 'source-media'): string {
  const filePath: string = path.join(mediaDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** All values that follow an occurrence of the flag, in order. */
function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  args.forEach((arg: string, index: number): void => {
    if (arg === flag) {
      values.push(args[index + 1]);
    }
  });
  return values;
}

/** The value following the first occurrence of the flag. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  return flagValues(args, flag)[0];
}

interface ProbeStream {
  readonly codec_type: string;
  readonly codec_name: string;
}

/** ffprobe JSON for a video with the given codecs, one audio stream per codec. */
function videoProbe(videoCodec: string, audioCodecs: readonly string[]): string {
  const streams: ProbeStream[] = [
    { codec_type: 'video', codec_name: videoCodec },
    ...audioCodecs.map((codec: string): ProbeStream => ({ codec_type: 'audio', codec_name: codec })),
  ];
  return JSON.stringify({ format: { duration: '600' }, streams });
}

/** ffprobe JSON for an audio-only source of the given duration. */
function audioProbe(duration: number, codec: string = 'mp3'): string {
  return JSON.stringify({ format: { duration: String(duration) }, streams: [{ codec_type: 'audio', codec_name: codec }] });
}

/**
 * Has the server probe a source so its codecs are known to the stream
 * handler, answering the ffprobe run with the given JSON.
 */
async function primeMediaInfo(source: string, probeJson: string, target: TestServer = primary): Promise<void> {
  const pending: Promise<Response> = api(withQuery('/media/info', { path: source }), {}, target);
  const ffprobe: FakeProcess = await nextSpawn(FFPROBE, (proc: FakeProcess): boolean => proc.lastArg === source);
  ffprobe.exit(0, probeJson);
  const res: Response = await pending;
  if (res.status !== 200) {
    throw new Error(`Priming media info failed with status ${res.status}`);
  }
}

/** Answers the keyframe probe a stream-copied seek makes. */
async function answerKeyframeProbe(output: string): Promise<FakeProcess> {
  const probe: FakeProcess = await nextSpawn(FFPROBE, (proc: FakeProcess): boolean => proc.args.includes('-read_intervals'));
  probe.exit(0, output);
  return probe;
}

interface StreamResult {
  readonly ffmpeg: FakeProcess;
  readonly response: Response;
  readonly body: string;
}

/**
 * Requests a stream, lets the ffmpeg it spawns emit the given bytes and exit
 * cleanly, and returns the process with the completed response.
 */
async function completeStream(pending: Promise<Response>, output: string = 'transcoded-bytes'): Promise<StreamResult> {
  const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);
  ffmpeg.exit(0, output);
  const response: Response = await pending;
  return { ffmpeg, response, body: await response.text() };
}

/** Starts a stream, reads its first chunk, then drops the connection. */
async function disconnectMidStream(urlPath: string): Promise<FakeProcess> {
  const controller: AbortController = new AbortController();
  const pending: Promise<Response> = api(urlPath, { signal: controller.signal });
  const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);
  ffmpeg.stdout.write('first-chunk');
  const response: Response = await pending;
  await response.body?.getReader().read();
  controller.abort();
  return ffmpeg;
}

interface EventStream {
  /** Resolves with the data of the first event of that name. */
  next(event: string): Promise<Record<string, unknown>>;
}

/** Opens an SSE connection; resolves once the server has registered it. */
function openEvents(target: TestServer = primary): Promise<EventStream> {
  return new Promise<EventStream>((resolve: (stream: EventStream) => void, reject: (err: Error) => void): void => {
    const received: Array<{ event: string; data: Record<string, unknown> }> = [];
    const waiters: Array<{ event: string; resolve: (data: Record<string, unknown>) => void }> = [];

    const req: ClientRequest = http.get(`${target.baseUrl}/events`, { headers: { 'X-Onix-Token': target.token } }, (res: IncomingMessage): void => {
      let buffer: string = '';
      res.on('data', (chunk: Buffer): void => {
        buffer += chunk.toString();
        const parts: string[] = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const event: string | undefined = part.split('\n').find((l: string): boolean => l.startsWith('event: '))?.slice(7);
          const data: string | undefined = part.split('\n').find((l: string): boolean => l.startsWith('data: '))?.slice(6);
          if (!event || !data) continue;
          const parsed: Record<string, unknown> = JSON.parse(data) as Record<string, unknown>;
          const waiterIndex: number = waiters.findIndex((w: { event: string }): boolean => w.event === event);
          if (waiterIndex >= 0) {
            waiters.splice(waiterIndex, 1)[0].resolve(parsed);
          } else {
            received.push({ event, data: parsed });
          }
        }
      });
      res.on('error', (): void => undefined);

      resolve({
        next: (event: string): Promise<Record<string, unknown>> => {
          const index: number = received.findIndex((r: { event: string }): boolean => r.event === event);
          if (index >= 0) {
            return Promise.resolve(received.splice(index, 1)[0].data);
          }
          return new Promise<Record<string, unknown>>((resolveNext: (data: Record<string, unknown>) => void): void => {
            waiters.push({ event, resolve: resolveNext });
          });
        },
      });
    });
    req.on('error', (err: Error): void => reject(err));
    openRequests.push(req);
  });
}

/** Reads the playback state the server reports. */
async function playerState(target: TestServer = primary): Promise<Record<string, unknown>> {
  const res: Response = await api('/player/state', {}, target);
  return await res.json() as Record<string, unknown>;
}

// ============================================================================
// Test suite
// ============================================================================

describe('UnifiedMediaServer streaming', () => {
  beforeEach(async () => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onix-ums-streaming-'));
    shared.userDataPath = path.join(testRoot, 'userData');
    shared.tempPath = path.join(testRoot, 'temp');
    mediaDir = path.join(testRoot, 'media');
    fs.mkdirSync(shared.userDataPath, { recursive: true });
    fs.mkdirSync(shared.tempPath, { recursive: true });
    fs.mkdirSync(mediaDir, { recursive: true });

    shared.logLines.length = 0;
    shared.logWaiters.length = 0;
    spawnedProcesses = [];
    unclaimedProcesses = [];
    spawnWaiters = [];
    nextSpawnError = null;
    ytDlpOutput = '';
    startedServers = [];
    openRequests = [];

    dependencies.ffmpeg = FFMPEG;
    dependencies.ffprobe = FFPROBE;
    dependencies.fluidsynth = FLUIDSYNTH;
    dependencies.soundfont = SOUNDFONT;
    dependencies.trackerSupport = true;
    dependencies.hardwareEncoders = [];
    dependencies.soundfontLookups = 0;

    primary = await startServer();
  }, 30000);

  afterEach(() => {
    vi.useRealTimers();
    for (const req of openRequests) {
      req.destroy();
    }
    for (const started of startedServers) {
      started.instance.stop();
    }
    fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 3 });
  });

  // ==========================================================================
  // GET /media/stream — routing
  // ==========================================================================

  describe('GET /media/stream routing', () => {
    it('serves a native video directly when its audio codec plays in the browser', async () => {
      const file: string = mediaFile('clip.mp4', 'native-mp4-bytes');
      await primeMediaInfo(file, videoProbe('h264', ['aac']));

      const res: Response = await api(streamPath(file));
      const body: string = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      expect(body).toBe('native-mp4-bytes');
      expect(spawnCount(FFMPEG)).toBe(0);
    });

    it('transcodes a native video whose audio codec the browser cannot decode', async () => {
      const file: string = mediaFile('surround.mp4');
      await primeMediaInfo(file, videoProbe('h264', ['ac3']));

      const { ffmpeg, response, body } = await completeStream(api(streamPath(file)));

      expect(response.status).toBe(200);
      expect(body).toBe('transcoded-bytes');
      expect(flagValue(ffmpeg.args, '-c:a')).toBe('aac');
    });

    it('transcodes a container the browser cannot play', async () => {
      const file: string = mediaFile('movie.mkv');

      const { ffmpeg, response } = await completeStream(api(streamPath(file)));

      expect(response.headers.get('content-type')).toBe('video/mp4');
      expect(flagValues(ffmpeg.args, '-i')).toEqual([file]);
    });

    it('transcodes a remote URL with ffmpeg reading the URL itself', async () => {
      const source: string = 'https://media.example.com/progressive.mp4';

      const { ffmpeg, response, body } = await completeStream(api(streamPath(source)));

      expect(response.status).toBe(200);
      expect(body).toBe('transcoded-bytes');
      expect(flagValues(ffmpeg.args, '-i')).toEqual([source]);
    });

    it('streams a remote audio-only source as ADTS AAC from the requested position', async () => {
      const source: string = 'https://media.example.com/podcast.webm';
      await primeMediaInfo(source, audioProbe(1800, 'opus'));

      const { ffmpeg, response } = await completeStream(api(streamPath(source, { t: '42' })));

      expect(response.headers.get('content-type')).toBe('audio/aac');
      expect(flagValue(ffmpeg.args, '-ss')).toBe('42');
      expect(flagValues(ffmpeg.args, '-i')).toEqual([source]);
      expect(flagValue(ffmpeg.args, '-c:a')).toBe('aac');
      expect(flagValue(ffmpeg.args, '-f')).toBe('adts');
      expect(ffmpeg.args).not.toContain('-map');
    });

    it('starts a remote audio-only source from the beginning when no position is given', async () => {
      const source: string = 'https://media.example.com/episode.webm';
      await primeMediaInfo(source, audioProbe(1800, 'opus'));

      const { ffmpeg } = await completeStream(api(streamPath(source)));

      expect(flagValue(ffmpeg.args, '-ss')).toBe('0');
    });

    it('answers 500 when the transcoder fails before any header is sent', async () => {
      const file: string = mediaFile('broken.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['aac']));
      // Thrown from inside the keyframe probe, which runs before the response starts.
      dependencies.ffprobe = null;
      vi.spyOn(primary.instance.getDependencyManager(), 'getFfprobePath').mockImplementation((): never => {
        throw new Error('dependency lookup failed');
      });

      const res: Response = await api(streamPath(file, { t: '30' }));

      expect(res.status).toBe(500);
      expect(await res.text()).toBe('');
      expect(spawnCount(FFMPEG)).toBe(0);
    });

    it('ends the response when the transcoder fails after the headers were sent', async () => {
      const file: string = mediaFile('unspawnable.mkv');
      nextSpawnError = new Error('spawn EINVAL');

      const res: Response = await api(streamPath(file));

      // The 200 is already committed; what matters is the client is not left hanging.
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
    });
  });

  // ==========================================================================
  // GET /media/stream — transcoding modes
  // ==========================================================================

  describe('GET /media/stream transcoding', () => {
    it('streams what ffmpeg writes to stdout as a chunked, uncached response', async () => {
      const file: string = mediaFile('movie.avi');
      const pending: Promise<Response> = api(streamPath(file));
      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);
      ffmpeg.stderr.write('deprecated pixel format used');
      ffmpeg.stdout.write('part-one;');

      ffmpeg.exit(0, 'part-two');
      const res: Response = await pending;

      expect(await res.text()).toBe('part-one;part-two');
      expect(res.headers.get('transfer-encoding')).toBe('chunked');
      expect(res.headers.get('cache-control')).toBe('no-cache');
    });

    it('re-encodes both streams when the codecs are unknown', async () => {
      const file: string = mediaFile('unknown.mkv');

      const { ffmpeg } = await completeStream(api(streamPath(file)));

      expect(flagValues(ffmpeg.args, '-i')).toEqual([file]);
      expect(flagValues(ffmpeg.args, '-map')).toEqual(['0:v:0', '0:a:0']);
      expect(flagValue(ffmpeg.args, '-c:v')).toBe('libx264');
      expect(flagValue(ffmpeg.args, '-c:a')).toBe('aac');
      expect(flagValue(ffmpeg.args, '-vf')).toBe('setpts=PTS-STARTPTS');
      expect(flagValue(ffmpeg.args, '-af')).toBe('asetpts=PTS-STARTPTS');
      expect(flagValue(ffmpeg.args, '-f')).toBe('mp4');
      expect(ffmpeg.lastArg).toBe('pipe:1');
    });

    it('re-encodes when the video codec cannot be carried in MP4', async () => {
      const file: string = mediaFile('old.avi');
      await primeMediaInfo(file, videoProbe('mpeg4', ['mp3']));

      const { ffmpeg } = await completeStream(api(streamPath(file)));

      expect(flagValue(ffmpeg.args, '-c:v')).toBe('libx264');
      expect(flagValue(ffmpeg.args, '-c:a')).toBe('aac');
    });

    it('seeks a full transcode on the input without probing for a keyframe', async () => {
      const file: string = mediaFile('seekable.avi');
      await primeMediaInfo(file, videoProbe('mpeg4', ['mp3']));
      const probesBefore: number = spawnCount(FFPROBE);

      const { ffmpeg } = await completeStream(api(streamPath(file, { t: '90.5' })));

      expect(flagValues(ffmpeg.args, '-ss')).toEqual(['90.5']);
      expect(ffmpeg.args.indexOf('-ss')).toBeLessThan(ffmpeg.args.indexOf('-i'));
      expect(spawnCount(FFPROBE)).toBe(probesBefore);
    });

    it('treats an unparseable seek position as the start', async () => {
      const file: string = mediaFile('badseek.avi');

      const { ffmpeg } = await completeStream(api(streamPath(file, { t: 'soon' })));

      expect(flagValues(ffmpeg.args, '-ss')).toEqual(['0']);
    });

    it('copies both streams when video and audio are already MP4-compatible', async () => {
      const file: string = mediaFile('remux.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['aac']));

      const { ffmpeg, response } = await completeStream(api(streamPath(file)));

      expect(response.headers.get('content-type')).toBe('video/mp4');
      expect(flagValues(ffmpeg.args, '-i')).toEqual([file, file]);
      expect(flagValues(ffmpeg.args, '-map')).toEqual(['0:v:0', '1:a:0']);
      expect(flagValue(ffmpeg.args, '-c:v')).toBe('copy');
      expect(flagValue(ffmpeg.args, '-c:a')).toBe('copy');
      expect(ffmpeg.args).not.toContain('-ss');
      expect(ffmpeg.lastArg).toBe('pipe:1');
    });

    it('delays the MP4 header for copied video so each track records its real start', async () => {
      const file: string = mediaFile('bframes.mkv');
      await primeMediaInfo(file, videoProbe('hevc', ['aac']));

      const { ffmpeg } = await completeStream(api(streamPath(file)));

      expect(flagValue(ffmpeg.args, '-movflags')?.split('+')).toContain('delay_moov');
      expect(flagValue(ffmpeg.args, '-frag_duration')).toBe('1000000');
      expect(flagValue(ffmpeg.args, '-avoid_negative_ts')).toBe('make_zero');
    });

    it('copies the video and transcodes only the audio when just the audio is incompatible', async () => {
      const file: string = mediaFile('hybrid.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['ac3']));

      const { ffmpeg } = await completeStream(api(streamPath(file)));

      expect(flagValues(ffmpeg.args, '-i')).toEqual([file, file]);
      expect(flagValue(ffmpeg.args, '-c:v')).toBe('copy');
      expect(flagValue(ffmpeg.args, '-c:a')).toBe('aac');
      expect(flagValue(ffmpeg.args, '-af')).toContain('aresample=async=1');
    });

    it('decides the mode from the selected audio track rather than the first', async () => {
      const file: string = mediaFile('dual-audio.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['aac', 'dts']));

      const { ffmpeg } = await completeStream(api(streamPath(file, { audioTrack: '1' })));

      expect(flagValues(ffmpeg.args, '-map')).toEqual(['0:v:0', '1:a:1']);
      expect(flagValue(ffmpeg.args, '-c:v')).toBe('copy');
      expect(flagValue(ffmpeg.args, '-c:a')).toBe('aac');
    });

    it('maps the selected audio track in a full transcode', async () => {
      const file: string = mediaFile('dual-audio.avi');
      await primeMediaInfo(file, videoProbe('mpeg4', ['mp3', 'ac3']));

      const { ffmpeg } = await completeStream(api(streamPath(file, { audioTrack: '1' })));

      expect(flagValues(ffmpeg.args, '-map')).toEqual(['0:v:0', '0:a:1']);
    });

    it.each(['.wma', '.ape', '.tak'])('transcodes a %s file to audio only', async (extension: string) => {
      const file: string = mediaFile(`track${extension}`);

      const { ffmpeg, response } = await completeStream(api(streamPath(file, { t: '12.5' })));

      expect(response.headers.get('content-type')).toBe('audio/aac');
      expect(flagValues(ffmpeg.args, '-ss')).toEqual(['12.5']);
      expect(flagValues(ffmpeg.args, '-i')).toEqual([file]);
      expect(flagValue(ffmpeg.args, '-f')).toBe('adts');
      expect(ffmpeg.args).not.toContain('-c:v');
    });

    it('answers 500 without committing a stream when ffmpeg is missing', async () => {
      const file: string = mediaFile('no-ffmpeg.mkv');
      dependencies.ffmpeg = null;

      const res: Response = await api(streamPath(file));

      expect(res.status).toBe(500);
      expect(await errorOf(res)).toBe('ffmpeg not found');
    });

    it('ends the response when ffmpeg cannot be started', async () => {
      const file: string = mediaFile('spawn-error.mkv');
      const pending: Promise<Response> = api(streamPath(file));
      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);

      ffmpeg.fail(new Error('spawn EACCES'));
      const res: Response = await pending;

      expect(await res.text()).toBe('');
    });

    it('ends the response with what was produced when ffmpeg exits with an error', async () => {
      const file: string = mediaFile('truncated.mkv');
      const pending: Promise<Response> = api(streamPath(file));
      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);

      ffmpeg.exit(1, 'partial');
      const res: Response = await pending;

      expect(await res.text()).toBe('partial');
    });

    it('kills ffmpeg when the client disconnects mid-stream', async () => {
      const file: string = mediaFile('abandoned.mkv');

      const ffmpeg: FakeProcess = await disconnectMidStream(streamPath(file));

      expect(await ffmpeg.killed).toBe('SIGKILL');
    });

    it('does not signal an ffmpeg that already exited when the connection closes', async () => {
      const file: string = mediaFile('finished.mkv');

      const { ffmpeg } = await completeStream(api(streamPath(file)));

      expect(ffmpeg.signals).toEqual([]);
    });
  });

  // ==========================================================================
  // GET /media/stream — transcoding settings
  // ==========================================================================

  describe('GET /media/stream transcoding settings', () => {
    it.each([
      ['low', '28'],
      ['medium', '23'],
      ['high', '18'],
    ] as const)('encodes %s video quality at CRF %s', async (videoQuality: 'low' | 'medium' | 'high', crf: string) => {
      const file: string = mediaFile('quality.avi');
      primary.instance.getSettingsManager().updateTranscodingSettings({ videoQuality });

      const { ffmpeg } = await completeStream(api(streamPath(file)));

      expect(flagValue(ffmpeg.args, '-crf')).toBe(crf);
    });

    it('encodes transcoded audio at the configured bitrate', async () => {
      const file: string = mediaFile('bitrate.avi');
      primary.instance.getSettingsManager().updateTranscodingSettings({ audioBitrate: 320 });

      const { ffmpeg } = await completeStream(api(streamPath(file)));

      expect(flagValue(ffmpeg.args, '-b:a')).toBe('320k');
    });

    /** The arguments between the encoder name and the first common option. */
    function encoderArgs(args: readonly string[]): string[] {
      return args.slice(args.indexOf('-c:v') + 1, args.indexOf('-profile:v'));
    }

    it('uses software encoding when hardware acceleration is disabled', async () => {
      const file: string = mediaFile('software.avi');
      dependencies.hardwareEncoders = ['h264_videotoolbox', 'h264_nvenc'];
      primary.instance.getSettingsManager().updateTranscodingSettings({ hardwareAcceleration: 'disabled' });

      const { ffmpeg } = await completeStream(api(streamPath(file)));

      expect(encoderArgs(ffmpeg.args)).toEqual(['libx264', '-preset', 'ultrafast', '-tune', 'zerolatency']);
    });

    it('falls back to software encoding in auto mode when no hardware encoder exists', async () => {
      const file: string = mediaFile('auto-none.avi');
      dependencies.hardwareEncoders = [];
      primary.instance.getSettingsManager().updateTranscodingSettings({ hardwareAcceleration: 'auto' });

      const { ffmpeg } = await completeStream(api(streamPath(file)));

      expect(encoderArgs(ffmpeg.args)).toEqual(['libx264', '-preset', 'ultrafast', '-tune', 'zerolatency']);
    });

    it('prefers the platform-native hardware encoder in auto mode', async () => {
      const file: string = mediaFile('auto-native.avi');
      dependencies.hardwareEncoders = ['h264_vaapi', 'h264_qsv', 'h264_nvenc', 'h264_videotoolbox'];
      primary.instance.getSettingsManager().updateTranscodingSettings({ hardwareAcceleration: 'auto' });
      const expected: string[] = process.platform === 'darwin'
        ? ['h264_videotoolbox', '-allow_sw', '1', '-realtime', '1']
        : ['h264_nvenc', '-preset', 'p4', '-tune', 'll'];

      const { ffmpeg } = await completeStream(api(streamPath(file)));

      expect(encoderArgs(ffmpeg.args)).toEqual(expected);
    });

    it('ignores hardware encoders that are not native to the platform in auto mode', async () => {
      const file: string = mediaFile('auto-foreign.avi');
      // Each platform is offered only the other platforms' encoder.
      dependencies.hardwareEncoders = process.platform === 'darwin' ? ['h264_nvenc'] : ['h264_videotoolbox'];
      primary.instance.getSettingsManager().updateTranscodingSettings({ hardwareAcceleration: 'auto' });

      const { ffmpeg } = await completeStream(api(streamPath(file)));

      expect(flagValue(ffmpeg.args, '-c:v')).toBe('libx264');
    });

    it.each([
      ['h264_videotoolbox', ['-allow_sw', '1', '-realtime', '1']],
      ['h264_nvenc', ['-preset', 'p4', '-tune', 'll']],
      ['h264_qsv', ['-preset', 'veryfast']],
      ['h264_amf', ['-quality', 'speed']],
      ['h264_vaapi', []],
    ] as const)('uses the explicitly selected %s encoder when it is available', async (
      encoder: 'h264_videotoolbox' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'h264_vaapi',
      extraArgs: readonly string[],
    ) => {
      const file: string = mediaFile('explicit.avi');
      dependencies.hardwareEncoders = [encoder];
      primary.instance.getSettingsManager().updateTranscodingSettings({ hardwareAcceleration: encoder });

      const { ffmpeg } = await completeStream(api(streamPath(file)));

      expect(encoderArgs(ffmpeg.args)).toEqual([encoder, ...extraArgs]);
    });

    it('falls back to software encoding when the selected encoder is unavailable', async () => {
      const file: string = mediaFile('unavailable.avi');
      dependencies.hardwareEncoders = ['h264_qsv'];
      primary.instance.getSettingsManager().updateTranscodingSettings({ hardwareAcceleration: 'h264_nvenc' });

      const { ffmpeg } = await completeStream(api(streamPath(file)));

      expect(encoderArgs(ffmpeg.args)).toEqual(['libx264', '-preset', 'ultrafast', '-tune', 'zerolatency']);
    });
  });

  // ==========================================================================
  // GET /media/stream — seeking stream-copied video
  // ==========================================================================

  describe('GET /media/stream seeking copied video', () => {
    /** ffmpeg moves an input seek back by this much when the video has B-frames. */
    const SEEK_NUDGE: number = 0.130435 + 0.001;

    it('asks ffprobe which keyframe the seek will land on', async () => {
      const file: string = mediaFile('probe-args.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['aac']));
      const pending: Promise<Response> = api(streamPath(file, { t: '30' }));

      const probe: FakeProcess = await answerKeyframeProbe('28.5\n');
      await completeStream(pending);

      expect(flagValue(probe.args, '-read_intervals')).toBe('30%+#1');
      expect(flagValue(probe.args, '-select_streams')).toBe('v:0');
      expect(probe.lastArg).toBe(file);
    });

    it('starts copied video and copied audio on the probed keyframe', async () => {
      const file: string = mediaFile('remux-seek.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['aac']));
      const pending: Promise<Response> = api(streamPath(file, { t: '30' }));
      await answerKeyframeProbe('28.5\n');

      const { ffmpeg } = await completeStream(pending);

      // Both inputs carry the video stream, so both get the nudged seek.
      const seeks: number[] = flagValues(ffmpeg.args, '-ss').map(Number);
      const offsets: number[] = flagValues(ffmpeg.args, '-itsoffset').map(Number);
      expect(seeks).toHaveLength(2);
      expect(seeks[0]).toBeCloseTo(28.5 + SEEK_NUDGE, 6);
      expect(seeks[1]).toBeCloseTo(28.5 + SEEK_NUDGE, 6);
      expect(offsets).toHaveLength(2);
      expect(offsets[0]).toBeCloseTo(SEEK_NUDGE, 6);
      expect(offsets[1]).toBeCloseTo(SEEK_NUDGE, 6);
    });

    it('trims transcoded audio to the exact keyframe time the copied video starts at', async () => {
      const file: string = mediaFile('hybrid-seek.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['ac3']));
      const pending: Promise<Response> = api(streamPath(file, { t: '30' }));
      await answerKeyframeProbe('28.5\n');

      const { ffmpeg } = await completeStream(pending);

      const seeks: number[] = flagValues(ffmpeg.args, '-ss').map(Number);
      expect(seeks[0]).toBeCloseTo(28.5 + SEEK_NUDGE, 6);
      expect(seeks[1]).toBe(28.5);
      expect(flagValues(ffmpeg.args, '-itsoffset')).toHaveLength(1);
    });

    it('places each seek before the input it applies to', async () => {
      const file: string = mediaFile('seek-order.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['ac3']));
      const pending: Promise<Response> = api(streamPath(file, { t: '30' }));
      await answerKeyframeProbe('28.5\n');

      const { ffmpeg } = await completeStream(pending);

      const options: string[] = ffmpeg.args.filter((arg: string): boolean => ['-itsoffset', '-ss', '-i'].includes(arg));
      expect(options).toEqual(['-itsoffset', '-ss', '-i', '-ss', '-i']);
    });

    it.each([
      ['exits with an error', (probe: FakeProcess): void => probe.exit(1)],
      ['prints nothing', (probe: FakeProcess): void => probe.exit(0, '')],
      ['prints something that is not a timestamp', (probe: FakeProcess): void => probe.exit(0, 'N/A\n')],
      ['prints a negative timestamp', (probe: FakeProcess): void => probe.exit(0, '-1.5\n')],
      ['cannot be started', (probe: FakeProcess): void => probe.fail(new Error('spawn ENOENT'))],
    ])('seeks to the requested time when the keyframe probe %s', async (_outcome: string, settle: (probe: FakeProcess) => void) => {
      const file: string = mediaFile('probe-failure.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['ac3']));
      const pending: Promise<Response> = api(streamPath(file, { t: '30' }));
      const probe: FakeProcess = await nextSpawn(FFPROBE);

      settle(probe);
      const { ffmpeg } = await completeStream(pending);

      expect(Number(flagValues(ffmpeg.args, '-ss')[1])).toBe(30);
    });

    it('seeks to the requested time when ffprobe is missing', async () => {
      const file: string = mediaFile('no-ffprobe.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['ac3']));
      dependencies.ffprobe = null;

      const { ffmpeg } = await completeStream(api(streamPath(file, { t: '30' })));

      expect(Number(flagValues(ffmpeg.args, '-ss')[1])).toBe(30);
    });

    it('kills a keyframe probe that takes too long and seeks to the requested time', async () => {
      const file: string = mediaFile('slow-probe.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['ac3']));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending: Promise<Response> = api(streamPath(file, { t: '30' }));
      const probe: FakeProcess = await nextSpawn(FFPROBE);

      vi.advanceTimersByTime(5000);
      const { ffmpeg } = await completeStream(pending);

      expect(probe.signals).toEqual(['SIGKILL']);
      expect(Number(flagValues(ffmpeg.args, '-ss')[1])).toBe(30);
    });

    it('tells clients where the stream really starts', async () => {
      const file: string = mediaFile('aligned.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['aac']));
      const events: EventStream = await openEvents();
      const pending: Promise<Response> = api(streamPath(file, { t: '30' }));

      await answerKeyframeProbe('28.5\n');
      const aligned: Record<string, unknown> = await events.next('playback:seek:aligned');
      await completeStream(pending);

      expect(aligned).toEqual({ requested: 30, actual: 28.5 });
    });

    it('moves a stopped playback clock onto the keyframe when the seek is the current position', async () => {
      const file: string = mediaFile('rebase.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['aac']));
      await api('/player/stop', { method: 'POST' });
      const pending: Promise<Response> = api(streamPath(file, { t: '2' }));

      await answerKeyframeProbe('1.25\n');
      await completeStream(pending);

      expect((await playerState()).currentTime).toBe(1.25);
    });

    it('leaves the playback clock alone for a stream request far from the current position', async () => {
      const file: string = mediaFile('stale.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['aac']));
      await api('/player/stop', { method: 'POST' });
      const pending: Promise<Response> = api(streamPath(file, { t: '100' }));

      await answerKeyframeProbe('98\n');
      await completeStream(pending);

      expect((await playerState()).currentTime).toBe(0);
    });

    /** Adds a file to the playlist and selects it, which starts playback from zero. */
    async function startPlaying(file: string): Promise<void> {
      const added: Response = await api('/playlist/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [file] }),
      });
      const body: { added: Array<{ id: string }> } = await added.json() as { added: Array<{ id: string }> };
      await (await api(`/playlist/select/${body.added[0].id}`, { method: 'POST' })).text();
    }

    it('moves a running playback clock onto the keyframe when the seek is the current position', async () => {
      const file: string = mediaFile('playing.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['aac']));
      await startPlaying(file);
      const pending: Promise<Response> = api(streamPath(file, { t: '2.5' }));

      await answerKeyframeProbe('2\n');
      await completeStream(pending);

      // The clock keeps running from the keyframe; without the rebase it would
      // still be within a moment of zero.
      const currentTime: number = (await playerState()).currentTime as number;
      expect(currentTime).toBeGreaterThanOrEqual(2);
      expect(currentTime).toBeLessThan(2.5);
    });

    it('leaves a running playback clock alone for a stream request far from the current position', async () => {
      const file: string = mediaFile('playing-stale.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['aac']));
      await startPlaying(file);
      const pending: Promise<Response> = api(streamPath(file, { t: '100' }));

      await answerKeyframeProbe('98\n');
      await completeStream(pending);

      expect((await playerState()).currentTime as number).toBeLessThan(3);
    });

    it('leaves an idle playback clock alone', async () => {
      const file: string = mediaFile('idle.mkv');
      await primeMediaInfo(file, videoProbe('h264', ['aac']));
      const pending: Promise<Response> = api(streamPath(file, { t: '2' }));

      await answerKeyframeProbe('1.25\n');
      await completeStream(pending);

      expect((await playerState()).currentTime).toBe(0);
    });
  });

  // ==========================================================================
  // GET /media/stream — DASH (separate video and audio URLs)
  // ==========================================================================

  describe('GET /media/stream DASH muxing', () => {
    const videoUrl: string = 'https://cdn.example.com/video-1080p.mp4';
    const audioUrl: string = 'https://cdn.example.com/audio.webm';

    /** Resolves a page URL to a separate video and audio stream, as yt-dlp does for HD. */
    async function resolveDashPair(): Promise<void> {
      ytDlpOutput = `${videoUrl}\n${audioUrl}\n`;
      const res: Response = await api('/media/url/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://video.example.com/watch?v=abc' }),
      });
      if (res.status !== 200) {
        throw new Error(`Resolving the DASH pair failed with status ${res.status}`);
      }
    }

    it('muxes the paired audio stream into the video stream', async () => {
      await resolveDashPair();

      const { ffmpeg, response, body } = await completeStream(api(streamPath(videoUrl)));

      expect(response.headers.get('content-type')).toBe('video/mp4');
      expect(body).toBe('transcoded-bytes');
      expect(flagValues(ffmpeg.args, '-i')).toEqual([videoUrl, audioUrl]);
      expect(flagValues(ffmpeg.args, '-map')).toEqual(['0:v:0', '1:a:0']);
    });

    it('copies the video and transcodes the audio to AAC at the configured bitrate', async () => {
      await resolveDashPair();
      primary.instance.getSettingsManager().updateTranscodingSettings({ audioBitrate: 256 });

      const { ffmpeg } = await completeStream(api(streamPath(videoUrl)));

      expect(flagValue(ffmpeg.args, '-c:v')).toBe('copy');
      expect(flagValue(ffmpeg.args, '-c:a')).toBe('aac');
      expect(flagValue(ffmpeg.args, '-b:a')).toBe('256k');
      expect(ffmpeg.args).not.toContain('-ss');
    });

    it('seeks both streams to the keyframe the video seek lands on', async () => {
      await resolveDashPair();
      const pending: Promise<Response> = api(streamPath(videoUrl, { t: '75' }));

      const probe: FakeProcess = await answerKeyframeProbe('72.4\n');
      const { ffmpeg } = await completeStream(pending);

      const seeks: number[] = flagValues(ffmpeg.args, '-ss').map(Number);
      expect(probe.lastArg).toBe(videoUrl);
      expect(seeks[0]).toBeCloseTo(72.4 + 0.130435 + 0.001, 6);
      expect(seeks[1]).toBe(72.4);
    });

    it('seeks both streams to the requested time when the keyframe probe fails', async () => {
      await resolveDashPair();
      const pending: Promise<Response> = api(streamPath(videoUrl, { t: '75' }));
      const probe: FakeProcess = await nextSpawn(FFPROBE);

      probe.exit(1);
      const { ffmpeg } = await completeStream(pending);

      expect(Number(flagValues(ffmpeg.args, '-ss')[1])).toBe(75);
    });

    it('tells clients the keyframe a DASH seek landed on', async () => {
      await resolveDashPair();
      const events: EventStream = await openEvents();
      const pending: Promise<Response> = api(streamPath(videoUrl, { t: '75' }));

      await answerKeyframeProbe('72.4\n');
      const aligned: Record<string, unknown> = await events.next('playback:seek:aligned');
      await completeStream(pending);

      expect(aligned).toEqual({ requested: 75, actual: 72.4 });
    });

    it('answers 500 when the DASH stream fails before any header is sent', async () => {
      await resolveDashPair();
      vi.spyOn(primary.instance.getDependencyManager(), 'getFfprobePath').mockImplementation((): never => {
        throw new Error('dependency lookup failed');
      });

      const res: Response = await api(streamPath(videoUrl, { t: '75' }));

      expect(res.status).toBe(500);
      expect(spawnCount(FFMPEG)).toBe(0);
    });

    it('kills the muxer when the client disconnects', async () => {
      await resolveDashPair();

      const ffmpeg: FakeProcess = await disconnectMidStream(streamPath(videoUrl));

      expect(await ffmpeg.killed).toBe('SIGKILL');
    });
  });

  // ==========================================================================
  // GET /media/stream — MIDI
  // ==========================================================================

  describe('GET /media/stream MIDI rendering', () => {
    const rendered: Buffer = Buffer.from('rendered-midi-mp3-0123456789');

    interface MidiRender {
      readonly fluidsynth: FakeProcess;
      readonly ffmpeg: FakeProcess;
      readonly outputFile: string;
    }

    /** Claims the FluidSynth and ffmpeg processes of the next MIDI render. */
    async function nextMidiRender(): Promise<MidiRender> {
      const fluidsynth: FakeProcess = await nextSpawn(FLUIDSYNTH);
      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);
      return { fluidsynth, ffmpeg, outputFile: ffmpeg.lastArg };
    }

    /** Lets a MIDI render succeed, writing the MP3 and answering the duration probe. */
    async function finishMidiRender(render: MidiRender, duration: number = 12.5, output: Buffer = rendered): Promise<void> {
      fs.writeFileSync(render.outputFile, output);
      render.fluidsynth.exit(0, 'pcm');
      render.ffmpeg.exit(0);
      const probe: FakeProcess = await nextSpawn(FFPROBE, (proc: FakeProcess): boolean => proc.lastArg === render.outputFile);
      probe.exit(0, audioProbe(duration));
    }

    /** Requests a MIDI file and completes the render it triggers. */
    async function renderMidi(file: string, target: TestServer = primary, duration: number = 12.5): Promise<{ render: MidiRender; response: Response }> {
      const pending: Promise<Response> = api(streamPath(file), {}, target);
      const render: MidiRender = await nextMidiRender();
      await finishMidiRender(render, duration);
      return { render, response: await pending };
    }

    it('serves the rendered MP3 once FluidSynth and ffmpeg finish', async () => {
      const file: string = mediaFile('song.mid', 'MThd-song');

      const { response } = await renderMidi(file);
      const served: Buffer = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('audio/mpeg');
      expect(served.equals(rendered)).toBe(true);
    });

    it('forbids the browser from caching a render', async () => {
      const file: string = mediaFile('nocache.mid', 'MThd-nocache');

      const { response } = await renderMidi(file);
      await response.arrayBuffer();

      expect(response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate');
    });

    it('synthesises the file with the active SoundFont as raw PCM on stdout', async () => {
      const file: string = mediaFile('synth.midi', 'MThd-synth');

      const { render, response } = await renderMidi(file);
      await response.arrayBuffer();

      expect(render.fluidsynth.args.slice(-2)).toEqual([SOUNDFONT, file]);
      expect(flagValue(render.fluidsynth.args, '-T')).toBe('raw');
      expect(flagValue(render.fluidsynth.args, '-F')).toBe('-');
      expect(flagValue(render.fluidsynth.args, '-r')).toBe('44100');
    });

    it('encodes the PCM from stdin to MP3 at the configured bitrate', async () => {
      const file: string = mediaFile('encode.mid', 'MThd-encode');
      primary.instance.getSettingsManager().updateTranscodingSettings({ audioBitrate: 128 });

      const { render, response } = await renderMidi(file);
      await response.arrayBuffer();

      expect(flagValue(render.ffmpeg.args, '-i')).toBe('pipe:0');
      expect(flagValues(render.ffmpeg.args, '-f')).toEqual(['s16le', 'mp3']);
      expect(flagValue(render.ffmpeg.args, '-c:a')).toBe('libmp3lame');
      expect(flagValue(render.ffmpeg.args, '-b:a')).toBe('128k');
      expect(path.dirname(render.outputFile)).toBe(path.join(shared.tempPath, 'onixplayer-midi'));
    });

    it('pipes FluidSynth output into ffmpeg and closes its input when synthesis ends', async () => {
      const file: string = mediaFile('pipeline.mid', 'MThd-pipeline');
      const pending: Promise<Response> = api(streamPath(file));
      const render: MidiRender = await nextMidiRender();
      render.fluidsynth.stderr.write('FluidSynth runtime version 2.4.0');
      render.fluidsynth.stderr.write('fluidsynth: warning: no preset found');
      render.ffmpeg.stderr.write('Guessed Channel Layout: stereo');

      render.fluidsynth.exit(0, 'raw-pcm-samples');
      const received: string = await render.ffmpeg.stdinClosed;
      await finishMidiRender(render);
      await (await pending).arrayBuffer();

      expect(received).toBe('raw-pcm-samples');
    });

    it('serves a second request from the cache without rendering again', async () => {
      const file: string = mediaFile('cached.mid', 'MThd-cached');
      await (await renderMidi(file)).response.arrayBuffer();

      const res: Response = await api(streamPath(file));
      const served: Buffer = Buffer.from(await res.arrayBuffer());

      expect(served.equals(rendered)).toBe(true);
      expect(spawnCount(FLUIDSYNTH)).toBe(1);
    });

    it('serves byte ranges of a cached render so the player can seek', async () => {
      const file: string = mediaFile('ranged.mid', 'MThd-ranged');
      await (await renderMidi(file)).response.arrayBuffer();

      const res: Response = await api(streamPath(file), { headers: { Range: 'bytes=9-12' } });

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes 9-12/${rendered.length}`);
      expect(await res.text()).toBe('midi');
    });

    it('renders once for requests that arrive while a render is in progress', async () => {
      const file: string = mediaFile('concurrent.mid', 'MThd-concurrent');
      const first: Promise<Response> = api(streamPath(file));
      const render: MidiRender = await nextMidiRender();
      const second: Promise<Response> = api(streamPath(file));
      await logged('Waiting for in-progress render');

      await finishMidiRender(render);
      const bodies: Buffer[] = await Promise.all([first, second].map(
        async (pending: Promise<Response>): Promise<Buffer> => Buffer.from(await (await pending).arrayBuffer()),
      ));

      expect(spawnCount(FLUIDSYNTH)).toBe(1);
      expect(bodies[0].equals(rendered)).toBe(true);
      expect(bodies[1].equals(rendered)).toBe(true);
    });

    it('renders again when the cached output has been deleted', async () => {
      const file: string = mediaFile('deleted.mid', 'MThd-deleted');
      const { render, response } = await renderMidi(file);
      await response.arrayBuffer();
      fs.rmSync(render.outputFile);

      const { response: second } = await renderMidi(file);
      const served: Buffer = Buffer.from(await second.arrayBuffer());

      expect(spawnCount(FLUIDSYNTH)).toBe(2);
      expect(served.equals(rendered)).toBe(true);
    });

    it('reuses a render left on disk by an earlier session', async () => {
      const file: string = mediaFile('persisted.mid', 'MThd-persisted');
      const { render, response } = await renderMidi(file);
      await response.arrayBuffer();
      const restarted: TestServer = await startServer();

      const pending: Promise<Response> = api(streamPath(file), {}, restarted);
      const probe: FakeProcess = await nextSpawn(FFPROBE, (proc: FakeProcess): boolean => proc.lastArg === render.outputFile);
      probe.exit(0, audioProbe(12.5));
      const served: Buffer = Buffer.from(await (await pending).arrayBuffer());

      expect(served.equals(rendered)).toBe(true);
      expect(spawnCount(FLUIDSYNTH)).toBe(1);
    });

    it('shares one render between identical files at different paths', async () => {
      const original: string = mediaFile('original.mid', 'MThd-identical');
      const copy: string = mediaFile('copy.mid', 'MThd-identical');
      const { render, response } = await renderMidi(original);
      await response.arrayBuffer();

      const res: Response = await api(streamPath(copy));
      const served: Buffer = Buffer.from(await res.arrayBuffer());

      expect(served.equals(rendered)).toBe(true);
      expect(spawnCount(FLUIDSYNTH)).toBe(1);
      expect(fs.readdirSync(path.dirname(render.outputFile))).toHaveLength(1);
    });

    it('renders files with different contents to different outputs', async () => {
      const one: string = mediaFile('one.mid', 'MThd-one');
      const two: string = mediaFile('two.mid', 'MThd-two');

      const first: { render: MidiRender; response: Response } = await renderMidi(one);
      await first.response.arrayBuffer();
      const second: { render: MidiRender; response: Response } = await renderMidi(two);
      await second.response.arrayBuffer();

      expect(second.render.outputFile).not.toBe(first.render.outputFile);
    });

    it('does not reuse a render made with a different SoundFont', async () => {
      const file: string = mediaFile('soundfont.mid', 'MThd-soundfont');
      const first: { render: MidiRender; response: Response } = await renderMidi(file);
      await first.response.arrayBuffer();
      const otherSoundFont: string = path.join(fakeBinDir, 'orchestra.sf2');
      dependencies.soundfont = otherSoundFont;
      const restarted: TestServer = await startServer();

      const second: { render: MidiRender; response: Response } = await renderMidi(file, restarted);
      await second.response.arrayBuffer();

      expect(second.render.outputFile).not.toBe(first.render.outputFile);
      expect(second.render.fluidsynth.args).toContain(otherSoundFont);
    });

    it('discards an empty render left on disk and renders again', async () => {
      const file: string = mediaFile('empty-cache.mid', 'MThd-empty-cache');
      const first: { render: MidiRender; response: Response } = await renderMidi(file);
      await first.response.arrayBuffer();
      fs.writeFileSync(first.render.outputFile, '');
      const restarted: TestServer = await startServer();

      const second: { render: MidiRender; response: Response } = await renderMidi(file, restarted);
      const served: Buffer = Buffer.from(await second.response.arrayBuffer());

      expect(spawnCount(FLUIDSYNTH)).toBe(2);
      expect(served.equals(rendered)).toBe(true);
    });

    it('discards a render left on disk that cannot be probed and renders again', async () => {
      const file: string = mediaFile('corrupt-cache.mid', 'MThd-corrupt-cache');
      const first: { render: MidiRender; response: Response } = await renderMidi(file);
      await first.response.arrayBuffer();
      const restarted: TestServer = await startServer();
      const pending: Promise<Response> = api(streamPath(file), {}, restarted);
      const probe: FakeProcess = await nextSpawn(FFPROBE, (proc: FakeProcess): boolean => proc.lastArg === first.render.outputFile);

      probe.exit(1);
      const rerender: MidiRender = await nextMidiRender();
      const deletedBeforeRerender: boolean = !fs.existsSync(first.render.outputFile);
      await finishMidiRender(rerender);
      const served: Buffer = Buffer.from(await (await pending).arrayBuffer());

      expect(deletedBeforeRerender).toBe(true);
      expect(served.equals(rendered)).toBe(true);
    });

    it('still serves the render when its duration cannot be probed', async () => {
      const file: string = mediaFile('unprobed.mid', 'MThd-unprobed');
      const pending: Promise<Response> = api(streamPath(file));
      const render: MidiRender = await nextMidiRender();
      fs.writeFileSync(render.outputFile, rendered);
      render.fluidsynth.exit(0);
      render.ffmpeg.exit(0);
      const probe: FakeProcess = await nextSpawn(FFPROBE);

      probe.exit(1);
      const res: Response = await pending;
      const served: Buffer = Buffer.from(await res.arrayBuffer());

      expect(res.status).toBe(200);
      expect(served.equals(rendered)).toBe(true);
    });

    it('corrects the playback duration to the rendered length', async () => {
      const file: string = mediaFile('duration.mid', 'MThd-duration');

      const { response } = await renderMidi(file, primary, 187.4);
      await response.arrayBuffer();

      expect((await playerState()).duration).toBe(187.4);
    });

    it('corrects the playback duration when serving from the cache', async () => {
      const file: string = mediaFile('duration-cached.mid', 'MThd-duration-cached');
      await (await renderMidi(file, primary, 187.4)).response.arrayBuffer();
      primary.instance.clearPlaylist();

      await (await api(streamPath(file))).arrayBuffer();

      expect((await playerState()).duration).toBe(187.4);
    });

    it('answers 500 naming the missing SoundFont without starting a render', async () => {
      const file: string = mediaFile('no-soundfont.mid', 'MThd-no-soundfont');
      dependencies.soundfont = undefined;

      const res: Response = await api(streamPath(file));

      expect(res.status).toBe(500);
      expect(await errorOf(res)).toContain('No SoundFont is installed');
      expect(spawnCount(FLUIDSYNTH)).toBe(0);
    });

    it.each([
      ['FluidSynth', (): void => { dependencies.fluidsynth = null; }],
      ['ffmpeg', (): void => { dependencies.ffmpeg = null; }],
    ])('answers 500 when %s is missing', async (_binary: string, remove: () => void) => {
      const file: string = mediaFile('no-binary.mid', 'MThd-no-binary');
      remove();

      const res: Response = await api(streamPath(file));

      expect(res.status).toBe(500);
      expect(await errorOf(res)).toContain('Missing dependencies for MIDI rendering');
    });

    it('answers 500 and deletes the partial output when ffmpeg exits with an error', async () => {
      const file: string = mediaFile('failed.mid', 'MThd-failed');
      const pending: Promise<Response> = api(streamPath(file));
      const render: MidiRender = await nextMidiRender();
      fs.writeFileSync(render.outputFile, 'partial');

      render.fluidsynth.exit(0);
      render.ffmpeg.exit(1);
      const res: Response = await pending;

      expect(res.status).toBe(500);
      expect(await errorOf(res)).toContain('MIDI pre-render failed with exit code 1');
      expect(fs.existsSync(render.outputFile)).toBe(false);
    });

    it('answers 500 when ffmpeg reports success but wrote no file', async () => {
      const file: string = mediaFile('no-output.mid', 'MThd-no-output');
      const pending: Promise<Response> = api(streamPath(file));
      const render: MidiRender = await nextMidiRender();

      render.fluidsynth.exit(0);
      render.ffmpeg.exit(0);
      const res: Response = await pending;

      expect(res.status).toBe(500);
    });

    it('renders again on the next request after a failed render', async () => {
      const file: string = mediaFile('retry.mid', 'MThd-retry');
      const failing: Promise<Response> = api(streamPath(file));
      const failed: MidiRender = await nextMidiRender();
      failed.fluidsynth.exit(1);
      failed.ffmpeg.exit(1);
      await (await failing).text();

      const { response } = await renderMidi(file);
      const served: Buffer = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(200);
      expect(served.equals(rendered)).toBe(true);
    });

    it('stops ffmpeg and answers 500 when FluidSynth cannot be started', async () => {
      const file: string = mediaFile('fluidsynth-error.mid', 'MThd-fluidsynth-error');
      const pending: Promise<Response> = api(streamPath(file));
      const render: MidiRender = await nextMidiRender();
      fs.writeFileSync(render.outputFile, 'partial');

      render.fluidsynth.fail(new Error('spawn fluidsynth EACCES'));
      const res: Response = await pending;

      expect(res.status).toBe(500);
      expect(await errorOf(res)).toContain('spawn fluidsynth EACCES');
      expect(render.ffmpeg.signals).toEqual(['SIGTERM']);
      expect(fs.existsSync(render.outputFile)).toBe(false);
    });

    it('answers 500 and deletes the partial output when ffmpeg cannot be started', async () => {
      const file: string = mediaFile('ffmpeg-error.mid', 'MThd-ffmpeg-error');
      const pending: Promise<Response> = api(streamPath(file));
      const render: MidiRender = await nextMidiRender();
      fs.writeFileSync(render.outputFile, 'partial');

      render.ffmpeg.fail(new Error('spawn ffmpeg EACCES'));
      const res: Response = await pending;

      expect(res.status).toBe(500);
      expect(await errorOf(res)).toContain('spawn ffmpeg EACCES');
      expect(fs.existsSync(render.outputFile)).toBe(false);
    });

    // ------------------------------------------------------------------------
    // Background render queue (renders started by probing a file)
    // ------------------------------------------------------------------------

    /** Probes a MIDI file, which queues a background render of it. */
    async function probeMidi(file: string): Promise<void> {
      await (await api(withQuery('/media/info', { path: file }))).text();
    }

    it('holds a third background render back while two are running', async () => {
      const files: string[] = ['a', 'b', 'c'].map((name: string): string => mediaFile(`queued-${name}.mid`, `MThd-queued-${name}`));
      await probeMidi(files[0]);
      await probeMidi(files[1]);
      await nextMidiRender();
      await nextMidiRender();
      const lookupsWithTwoRunning: number = dependencies.soundfontLookups;

      await probeMidi(files[2]);

      // A render looks the SoundFont up as it starts; none means it has not started.
      expect(dependencies.soundfontLookups).toBe(lookupsWithTwoRunning);
      expect(spawnCount(FLUIDSYNTH)).toBe(2);
    });

    it('starts the next queued render when a running one finishes', async () => {
      const files: string[] = ['a', 'b', 'c'].map((name: string): string => mediaFile(`drain-${name}.mid`, `MThd-drain-${name}`));
      await probeMidi(files[0]);
      await probeMidi(files[1]);
      const first: MidiRender = await nextMidiRender();
      await nextMidiRender();
      await probeMidi(files[2]);

      await finishMidiRender(first);
      const third: MidiRender = await nextMidiRender();

      expect(third.fluidsynth.lastArg).toBe(files[2]);
    });

    it('keeps draining the queue after a background render fails', async () => {
      const files: string[] = ['a', 'b', 'c'].map((name: string): string => mediaFile(`fail-${name}.mid`, `MThd-fail-${name}`));
      await probeMidi(files[0]);
      await probeMidi(files[1]);
      const first: MidiRender = await nextMidiRender();
      await nextMidiRender();
      await probeMidi(files[2]);

      first.fluidsynth.exit(1);
      first.ffmpeg.exit(1);
      const third: MidiRender = await nextMidiRender();

      expect(third.fluidsynth.lastArg).toBe(files[2]);
    });

    it('does not render a queued file again when it was rendered on demand in the meantime', async () => {
      const files: string[] = ['a', 'b', 'c'].map((name: string): string => mediaFile(`overtaken-${name}.mid`, `MThd-overtaken-${name}`));
      await probeMidi(files[0]);
      await probeMidi(files[1]);
      const first: MidiRender = await nextMidiRender();
      await nextMidiRender();
      await probeMidi(files[2]);
      await (await renderMidi(files[2])).response.arrayBuffer();

      await finishMidiRender(first);
      await logged('Using cached render');

      expect(spawnCount(FLUIDSYNTH)).toBe(3);
    });

    it('serves a file whose background render already finished without rendering again', async () => {
      const file: string = mediaFile('prerendered.mid', 'MThd-prerendered');
      await probeMidi(file);
      const render: MidiRender = await nextMidiRender();
      await finishMidiRender(render);
      await logged('Pre-render complete');

      const res: Response = await api(streamPath(file));
      const served: Buffer = Buffer.from(await res.arrayBuffer());

      expect(served.equals(rendered)).toBe(true);
      expect(spawnCount(FLUIDSYNTH)).toBe(1);
    });
  });

  // ==========================================================================
  // GET /media/stream — tracker modules
  // ==========================================================================

  describe('GET /media/stream tracker rendering', () => {
    const rendered: Buffer = Buffer.from('rendered-tracker-mp3-0123456789');

    interface TrackerRender {
      readonly ffmpeg: FakeProcess;
      readonly outputFile: string;
    }

    /** Claims the ffmpeg process of the next tracker render. */
    async function nextTrackerRender(): Promise<TrackerRender> {
      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);
      return { ffmpeg, outputFile: ffmpeg.lastArg };
    }

    /** Lets a tracker render succeed, writing the MP3 and answering the duration probe. */
    async function finishTrackerRender(render: TrackerRender, duration: number = 95.2): Promise<void> {
      fs.writeFileSync(render.outputFile, rendered);
      render.ffmpeg.exit(0);
      const probe: FakeProcess = await nextSpawn(FFPROBE, (proc: FakeProcess): boolean => proc.lastArg === render.outputFile);
      probe.exit(0, audioProbe(duration));
    }

    /** Requests a module and completes the render it triggers. */
    async function renderTracker(file: string, target: TestServer = primary, duration: number = 95.2): Promise<{ render: TrackerRender; response: Response }> {
      const pending: Promise<Response> = api(streamPath(file), {}, target);
      const render: TrackerRender = await nextTrackerRender();
      await finishTrackerRender(render, duration);
      return { render, response: await pending };
    }

    it('serves the rendered MP3 once ffmpeg finishes', async () => {
      const file: string = mediaFile('tune.mod', 'M.K.-tune');

      const { response } = await renderTracker(file);
      const served: Buffer = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('audio/mpeg');
      expect(response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate');
      expect(served.equals(rendered)).toBe(true);
    });

    it('decodes every subsong through libopenmpt and encodes to MP3', async () => {
      const file: string = mediaFile('subsongs.xm', 'XM-subsongs');
      primary.instance.getSettingsManager().updateTranscodingSettings({ audioBitrate: 256 });

      const { render, response } = await renderTracker(file);
      await response.arrayBuffer();

      expect(flagValues(render.ffmpeg.args, '-f')).toEqual(['libopenmpt', 'mp3']);
      expect(flagValue(render.ffmpeg.args, '-subsong')).toBe('all');
      expect(flagValue(render.ffmpeg.args, '-i')).toBe(file);
      expect(flagValue(render.ffmpeg.args, '-c:a')).toBe('libmp3lame');
      expect(flagValue(render.ffmpeg.args, '-b:a')).toBe('256k');
      expect(path.dirname(render.outputFile)).toBe(path.join(shared.tempPath, 'onixplayer-tracker'));
    });

    it('serves a second request from the cache without rendering again', async () => {
      const file: string = mediaFile('cached.it', 'IMPM-cached');
      await (await renderTracker(file)).response.arrayBuffer();

      const res: Response = await api(streamPath(file));
      const served: Buffer = Buffer.from(await res.arrayBuffer());

      expect(served.equals(rendered)).toBe(true);
      expect(spawnCount(FFMPEG)).toBe(1);
    });

    it('renders once for requests that arrive while a render is in progress', async () => {
      const file: string = mediaFile('concurrent.s3m', 'SCRM-concurrent');
      const first: Promise<Response> = api(streamPath(file));
      const render: TrackerRender = await nextTrackerRender();
      const second: Promise<Response> = api(streamPath(file));
      await logged('Waiting for in-progress tracker render');

      await finishTrackerRender(render);
      const bodies: Buffer[] = await Promise.all([first, second].map(
        async (pending: Promise<Response>): Promise<Buffer> => Buffer.from(await (await pending).arrayBuffer()),
      ));

      expect(spawnCount(FFMPEG)).toBe(1);
      expect(bodies[0].equals(rendered)).toBe(true);
      expect(bodies[1].equals(rendered)).toBe(true);
    });

    it('renders again when the cached output has been deleted', async () => {
      const file: string = mediaFile('deleted.mod', 'M.K.-deleted');
      const { render, response } = await renderTracker(file);
      await response.arrayBuffer();
      fs.rmSync(render.outputFile);

      const { response: second } = await renderTracker(file);
      await second.arrayBuffer();

      expect(spawnCount(FFMPEG)).toBe(2);
    });

    it('reuses a render left on disk by an earlier session', async () => {
      const file: string = mediaFile('persisted.mod', 'M.K.-persisted');
      const { render, response } = await renderTracker(file);
      await response.arrayBuffer();
      const restarted: TestServer = await startServer();

      const pending: Promise<Response> = api(streamPath(file), {}, restarted);
      const probe: FakeProcess = await nextSpawn(FFPROBE, (proc: FakeProcess): boolean => proc.lastArg === render.outputFile);
      probe.exit(0, audioProbe(95.2));
      const served: Buffer = Buffer.from(await (await pending).arrayBuffer());

      expect(served.equals(rendered)).toBe(true);
      expect(spawnCount(FFMPEG)).toBe(1);
    });

    it('renders files with different contents to different outputs', async () => {
      const one: string = mediaFile('one.mod', 'M.K.-one');
      const two: string = mediaFile('two.mod', 'M.K.-two');

      const first: { render: TrackerRender; response: Response } = await renderTracker(one);
      await first.response.arrayBuffer();
      const second: { render: TrackerRender; response: Response } = await renderTracker(two);
      await second.response.arrayBuffer();

      expect(second.render.outputFile).not.toBe(first.render.outputFile);
    });

    it.each([
      ['is empty', (outputFile: string): void => fs.writeFileSync(outputFile, ''), null],
      ['cannot be probed', (): void => undefined, (probe: FakeProcess): void => probe.exit(1)],
      ['has no duration', (): void => undefined, (probe: FakeProcess): void => probe.exit(0, audioProbe(0))],
    ])('discards a render left on disk that %s and renders again', async (
      _defect: string,
      corrupt: (outputFile: string) => void,
      answerProbe: ((probe: FakeProcess) => void) | null,
    ) => {
      const file: string = mediaFile('corrupt-cache.mod', 'M.K.-corrupt-cache');
      const first: { render: TrackerRender; response: Response } = await renderTracker(file);
      await first.response.arrayBuffer();
      corrupt(first.render.outputFile);
      const restarted: TestServer = await startServer();
      const pending: Promise<Response> = api(streamPath(file), {}, restarted);
      if (answerProbe) {
        answerProbe(await nextSpawn(FFPROBE, (proc: FakeProcess): boolean => proc.lastArg === first.render.outputFile));
      }

      const rerender: TrackerRender = await nextTrackerRender();
      await finishTrackerRender(rerender);
      const served: Buffer = Buffer.from(await (await pending).arrayBuffer());

      expect(spawnCount(FFMPEG)).toBe(2);
      expect(served.equals(rendered)).toBe(true);
    });

    it('still serves the render when its duration cannot be probed', async () => {
      const file: string = mediaFile('unprobed.mod', 'M.K.-unprobed');
      const pending: Promise<Response> = api(streamPath(file));
      const render: TrackerRender = await nextTrackerRender();
      fs.writeFileSync(render.outputFile, rendered);
      render.ffmpeg.stderr.write('libopenmpt: pattern 3 truncated');
      render.ffmpeg.exit(0);
      const probe: FakeProcess = await nextSpawn(FFPROBE);

      probe.exit(1);
      const res: Response = await pending;
      const served: Buffer = Buffer.from(await res.arrayBuffer());

      expect(res.status).toBe(200);
      expect(served.equals(rendered)).toBe(true);
    });

    it('corrects the playback duration to the rendered length', async () => {
      const file: string = mediaFile('duration.mod', 'M.K.-duration');

      const { response } = await renderTracker(file, primary, 241.8);
      await response.arrayBuffer();

      expect((await playerState()).duration).toBe(241.8);
    });

    it('corrects the playback duration when serving from the cache', async () => {
      const file: string = mediaFile('duration-cached.mod', 'M.K.-duration-cached');
      await (await renderTracker(file, primary, 241.8)).response.arrayBuffer();
      primary.instance.clearPlaylist();

      await (await api(streamPath(file))).arrayBuffer();

      expect((await playerState()).duration).toBe(241.8);
    });

    it.each([
      ['ffmpeg is missing', (): void => { dependencies.ffmpeg = null; }],
      ['ffmpeg was built without libopenmpt', (): void => { dependencies.trackerSupport = false; }],
    ])('answers 500 without starting a render when %s', async (_reason: string, remove: () => void) => {
      const file: string = mediaFile('unsupported.mod', 'M.K.-unsupported');
      remove();

      const res: Response = await api(streamPath(file));

      expect(res.status).toBe(500);
      expect(await errorOf(res)).toContain('Tracker rendering needs an FFmpeg built with libopenmpt');
      expect(spawnCount(FFMPEG)).toBe(0);
    });

    it('answers 500 and deletes the partial output when ffmpeg exits with an error', async () => {
      const file: string = mediaFile('undecodable.mod', 'M.K.-undecodable');
      const pending: Promise<Response> = api(streamPath(file));
      const render: TrackerRender = await nextTrackerRender();
      fs.writeFileSync(render.outputFile, 'partial');

      render.ffmpeg.exit(1);
      const res: Response = await pending;

      expect(res.status).toBe(500);
      expect(await errorOf(res)).toContain('Tracker pre-render failed (ffmpeg exit 1)');
      expect(fs.existsSync(render.outputFile)).toBe(false);
    });

    it('treats an empty output file as a failed render even when ffmpeg exits cleanly', async () => {
      const file: string = mediaFile('silent.mod', 'M.K.-silent');
      const pending: Promise<Response> = api(streamPath(file));
      const render: TrackerRender = await nextTrackerRender();
      fs.writeFileSync(render.outputFile, '');

      render.ffmpeg.exit(0);
      const res: Response = await pending;

      expect(res.status).toBe(500);
      expect(fs.existsSync(render.outputFile)).toBe(false);
    });

    it('renders again on the next request after a failed render', async () => {
      const file: string = mediaFile('retry.mod', 'M.K.-retry');
      const failing: Promise<Response> = api(streamPath(file));
      (await nextTrackerRender()).ffmpeg.exit(1);
      await (await failing).text();

      const { response } = await renderTracker(file);
      const served: Buffer = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(200);
      expect(served.equals(rendered)).toBe(true);
    });

    it('answers 500 and deletes the partial output when ffmpeg cannot be started', async () => {
      const file: string = mediaFile('spawn-error.mod', 'M.K.-spawn-error');
      const pending: Promise<Response> = api(streamPath(file));
      const render: TrackerRender = await nextTrackerRender();
      fs.writeFileSync(render.outputFile, 'partial');

      render.ffmpeg.fail(new Error('spawn ffmpeg EACCES'));
      const res: Response = await pending;

      expect(res.status).toBe(500);
      expect(await errorOf(res)).toContain('spawn ffmpeg EACCES');
      expect(fs.existsSync(render.outputFile)).toBe(false);
    });

    it('does not render a queued module again when it was rendered on demand in the meantime', async () => {
      const files: string[] = ['a', 'b', 'c'].map((name: string): string => mediaFile(`overtaken-${name}.mod`, `M.K.-overtaken-${name}`));
      await (await api(withQuery('/media/info', { path: files[0] }))).text();
      await (await api(withQuery('/media/info', { path: files[1] }))).text();
      const first: TrackerRender = await nextTrackerRender();
      await nextTrackerRender();
      await (await api(withQuery('/media/info', { path: files[2] }))).text();
      await (await renderTracker(files[2])).response.arrayBuffer();

      await finishTrackerRender(first);
      await logged('Using cached tracker render');

      expect(spawnCount(FFMPEG)).toBe(3);
    });

    it('queues a background render when a module is probed', async () => {
      const file: string = mediaFile('background.mod', 'M.K.-background');

      await (await api(withQuery('/media/info', { path: file }))).text();
      const render: TrackerRender = await nextTrackerRender();

      expect(flagValue(render.ffmpeg.args, '-i')).toBe(file);
    });
  });

  // ==========================================================================
  // GET /media/artwork
  // ==========================================================================

  describe('GET /media/artwork', () => {
    const png: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);

    function artworkPath(source: string): string {
      return withQuery('/media/artwork', { path: source });
    }

    /** Requests artwork and lets the extraction exit with the given result. */
    async function extractArtwork(file: string, code: number, output?: Buffer): Promise<{ ffmpeg: FakeProcess; response: Response }> {
      const pending: Promise<Response> = api(artworkPath(file));
      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);
      ffmpeg.exit(code, output);
      return { ffmpeg, response: await pending };
    }

    it('returns 400 when the path parameter is missing', async () => {
      const res: Response = await api('/media/artwork');

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe('Missing path parameter');
    });

    it('returns 404 for a remote source without fetching it', async () => {
      const res: Response = await api(artworkPath('https://media.example.com/song.mp3'));

      expect(res.status).toBe(404);
      expect(await errorOf(res)).toBe('No artwork');
      expect(spawnCount(FFMPEG)).toBe(0);
    });

    it('returns 404 for a file that does not exist', async () => {
      const res: Response = await api(artworkPath(path.join(mediaDir, 'missing.mp3')));

      expect(res.status).toBe(404);
      expect(await errorOf(res)).toBe('File not found');
    });

    it('returns 400 for a relative path', async () => {
      const res: Response = await api(artworkPath('relative/song.mp3'));

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain('absolute');
    });

    it('returns 500 when ffmpeg is missing', async () => {
      const file: string = mediaFile('no-ffmpeg.mp3');
      dependencies.ffmpeg = null;

      const res: Response = await api(artworkPath(file));

      expect(res.status).toBe(500);
      expect(await errorOf(res)).toBe('FFmpeg not found');
    });

    it('serves the embedded picture as a PNG', async () => {
      const file: string = mediaFile('album.mp3');

      const { response } = await extractArtwork(file, 0, png);
      const served: Buffer = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('content-length')).toBe(String(png.length));
      expect(served.equals(png)).toBe(true);
    });

    it('extracts one frame of the first video stream as PNG', async () => {
      const file: string = mediaFile('cover.flac');

      const { ffmpeg, response } = await extractArtwork(file, 0, png);
      await response.arrayBuffer();

      expect(flagValue(ffmpeg.args, '-i')).toBe(file);
      expect(flagValue(ffmpeg.args, '-map')).toBe('0:v:0');
      expect(flagValue(ffmpeg.args, '-frames:v')).toBe('1');
      expect(flagValue(ffmpeg.args, '-c:v')).toBe('png');
      expect(ffmpeg.lastArg).toBe('pipe:1');
    });

    it('assembles a picture that arrives in several chunks', async () => {
      const file: string = mediaFile('chunked.mp3');
      const pending: Promise<Response> = api(artworkPath(file));
      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);
      ffmpeg.stdout.write(png.subarray(0, 4));

      ffmpeg.exit(0, png.subarray(4));
      const served: Buffer = Buffer.from(await (await pending).arrayBuffer());

      expect(served.equals(png)).toBe(true);
    });

    it('returns 404 when ffmpeg finds no picture', async () => {
      const file: string = mediaFile('plain.mp3');

      const { response } = await extractArtwork(file, 1);

      expect(response.status).toBe(404);
      expect(await errorOf(response)).toBe('No artwork');
    });

    it('returns 404 when ffmpeg exits cleanly without output', async () => {
      const file: string = mediaFile('empty.mp3');

      const { response } = await extractArtwork(file, 0);

      expect(response.status).toBe(404);
    });

    it('discards partial output from a failed extraction', async () => {
      const file: string = mediaFile('partial.mp3');

      const { response } = await extractArtwork(file, 1, png.subarray(0, 4));

      expect(response.status).toBe(404);
    });

    it('serves repeat requests from the cache without running ffmpeg again', async () => {
      const file: string = mediaFile('repeat.mp3');
      await (await extractArtwork(file, 0, png)).response.arrayBuffer();

      const res: Response = await api(artworkPath(file));
      const served: Buffer = Buffer.from(await res.arrayBuffer());

      expect(served.equals(png)).toBe(true);
      expect(spawnCount(FFMPEG)).toBe(1);
    });

    it('remembers that a file has no artwork', async () => {
      const file: string = mediaFile('artless.mp3');
      await (await extractArtwork(file, 1)).response.text();

      const res: Response = await api(artworkPath(file));

      expect(res.status).toBe(404);
      expect(spawnCount(FFMPEG)).toBe(1);
    });

    it('forgets the least recently extracted file once the cache is full', async () => {
      const cacheLimit: number = 32;
      const files: string[] = Array.from({ length: cacheLimit + 1 }, (_: unknown, index: number): string => mediaFile(`track-${index}.mp3`));
      for (const file of files) {
        await (await extractArtwork(file, 1)).response.text();
      }

      const newest: Response = await api(artworkPath(files[cacheLimit]));
      await newest.text();
      const spawnsAfterNewest: number = spawnCount(FFMPEG);
      const { response: oldest } = await extractArtwork(files[0], 1);
      await oldest.text();

      expect(spawnsAfterNewest).toBe(cacheLimit + 1);
      expect(spawnCount(FFMPEG)).toBe(cacheLimit + 2);
    });

    it('returns 500 with the reason when ffmpeg cannot be started', async () => {
      const file: string = mediaFile('unrunnable.mp3');
      const pending: Promise<Response> = api(artworkPath(file));
      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);

      ffmpeg.fail(new Error('spawn EACCES'));
      const res: Response = await pending;

      expect(res.status).toBe(500);
      expect(await errorOf(res)).toBe('spawn EACCES');
    });

    it('stops the extraction when the client disconnects', async () => {
      const file: string = mediaFile('abandoned.mp3');
      const controller: AbortController = new AbortController();
      const pending: Promise<Response> = api(artworkPath(file), { signal: controller.signal });
      pending.catch((): void => undefined);
      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);

      controller.abort();

      expect(await ffmpeg.killed).toBe('SIGTERM');
    });

    it('does not cache the result of an extraction cut short by a disconnect', async () => {
      const file: string = mediaFile('interrupted.mp3');
      const controller: AbortController = new AbortController();
      const pending: Promise<Response> = api(artworkPath(file), { signal: controller.signal });
      pending.catch((): void => undefined);
      const interrupted: FakeProcess = await nextSpawn(FFMPEG);
      controller.abort();
      await interrupted.killed;

      const { response } = await extractArtwork(file, 0, png);
      const served: Buffer = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(200);
      expect(served.equals(png)).toBe(true);
    });
  });

  // ==========================================================================
  // GET /media/subtitles
  // ==========================================================================

  describe('GET /media/subtitles', () => {
    const vtt: string = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n';

    function subtitlesPath(query: Record<string, string>): string {
      return withQuery('/media/subtitles', query);
    }

    it('returns 400 when the path parameter is missing', async () => {
      const res: Response = await api(subtitlesPath({ track: '2' }));

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe('Missing path parameter');
    });

    it('returns 400 when the track parameter is missing', async () => {
      const file: string = mediaFile('no-track.mkv');

      const res: Response = await api(subtitlesPath({ path: file }));

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe('Missing track parameter');
    });

    it.each(['abc', '-1', ''])('returns 400 for the invalid track "%s"', async (track: string) => {
      const file: string = mediaFile('bad-track.mkv');

      const res: Response = await api(subtitlesPath({ path: file, track }));

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe('Invalid track parameter');
    });

    it('returns 404 for a file that does not exist', async () => {
      const res: Response = await api(subtitlesPath({ path: path.join(mediaDir, 'missing.mkv'), track: '2' }));

      expect(res.status).toBe(404);
      expect(await errorOf(res)).toBe('File not found');
    });

    it('returns 400 for a path with traversal segments', async () => {
      const res: Response = await api(subtitlesPath({ path: `${mediaDir}${path.sep}..${path.sep}escape.mkv`, track: '2' }));

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain('traversal');
    });

    it('returns 500 when ffmpeg is missing', async () => {
      const file: string = mediaFile('no-ffmpeg.mkv');
      dependencies.ffmpeg = null;

      const res: Response = await api(subtitlesPath({ path: file, track: '2' }));

      expect(res.status).toBe(500);
      expect(await errorOf(res)).toBe('FFmpeg not found');
    });

    it('serves the extracted track as WebVTT', async () => {
      const file: string = mediaFile('subbed.mkv');
      const pending: Promise<Response> = api(subtitlesPath({ path: file, track: '3' }));
      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);
      ffmpeg.stderr.write('Error while decoding stream #0:3: Invalid data');

      ffmpeg.exit(0, vtt);
      const res: Response = await pending;

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/vtt; charset=utf-8');
      expect(await res.text()).toBe(vtt);
    });

    it('extracts the requested stream index with its original timestamps', async () => {
      const file: string = mediaFile('timestamps.mkv');
      const pending: Promise<Response> = api(subtitlesPath({ path: file, track: '3' }));

      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);
      ffmpeg.exit(0, vtt);
      await (await pending).text();

      expect(ffmpeg.args).toEqual(['-copyts', '-i', file, '-map', '0:3', '-f', 'webvtt', 'pipe:1']);
    });

    it('ends the response with what was extracted when ffmpeg exits with an error', async () => {
      const file: string = mediaFile('bitmap-subs.mkv');
      const pending: Promise<Response> = api(subtitlesPath({ path: file, track: '4' }));
      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);

      ffmpeg.exit(1, 'WEBVTT\n');
      const res: Response = await pending;

      expect(await res.text()).toBe('WEBVTT\n');
    });

    it('ends the response empty when ffmpeg cannot be started', async () => {
      const file: string = mediaFile('unrunnable.mkv');
      const pending: Promise<Response> = api(subtitlesPath({ path: file, track: '2' }));
      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);

      ffmpeg.failToStart(new Error('spawn ENOENT'));
      const res: Response = await pending;

      expect(await res.text()).toBe('');
    });

    it('stops the extraction when the client disconnects', async () => {
      const file: string = mediaFile('abandoned-subs.mkv');

      const ffmpeg: FakeProcess = await disconnectMidStream(subtitlesPath({ path: file, track: '2' }));

      expect(await ffmpeg.killed).toBe('SIGTERM');
    });
  });

  // ==========================================================================
  // GET /media/subtitles/external
  // ==========================================================================

  describe('GET /media/subtitles/external', () => {
    const vtt: string = 'WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nExternal\n';

    function externalPath(source: string): string {
      return withQuery('/media/subtitles/external', { path: source });
    }

    it('returns 400 when the path parameter is missing', async () => {
      const res: Response = await api('/media/subtitles/external');

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe('Missing path parameter');
    });

    it('returns 404 for a file that does not exist', async () => {
      const res: Response = await api(externalPath(path.join(mediaDir, 'missing.srt')));

      expect(res.status).toBe(404);
      expect(await errorOf(res)).toBe('File not found');
    });

    it('returns 400 for a relative path', async () => {
      const res: Response = await api(externalPath('subs/movie.srt'));

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain('absolute');
    });

    it('refuses a file that is not a subtitle format', async () => {
      const file: string = mediaFile('notes.txt');

      const res: Response = await api(externalPath(file));

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain('Invalid subtitle format');
      expect(spawnCount(FFMPEG)).toBe(0);
    });

    it('returns 500 when ffmpeg is missing', async () => {
      const file: string = mediaFile('no-ffmpeg.srt');
      dependencies.ffmpeg = null;

      const res: Response = await api(externalPath(file));

      expect(res.status).toBe(500);
      expect(await errorOf(res)).toBe('FFmpeg not found');
    });

    it.each(['.srt', '.vtt', '.ass', '.ssa', '.SRT'])('converts a %s file to WebVTT', async (extension: string) => {
      const file: string = mediaFile(`movie${extension}`);
      const pending: Promise<Response> = api(externalPath(file));
      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);
      ffmpeg.stderr.write('Invalid UTF-8 in decoded subtitles text');

      ffmpeg.exit(0, vtt);
      const res: Response = await pending;

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/vtt; charset=utf-8');
      expect(await res.text()).toBe(vtt);
    });

    it('converts the whole file with its original timestamps', async () => {
      const file: string = mediaFile('timing.srt');
      const pending: Promise<Response> = api(externalPath(file));

      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);
      ffmpeg.exit(0, vtt);
      await (await pending).text();

      expect(ffmpeg.args).toEqual(['-copyts', '-i', file, '-f', 'webvtt', 'pipe:1']);
    });

    it('ends the response with what was converted when ffmpeg exits with an error', async () => {
      const file: string = mediaFile('malformed.ass');
      const pending: Promise<Response> = api(externalPath(file));
      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);

      ffmpeg.exit(1, 'WEBVTT\n');
      const res: Response = await pending;

      expect(await res.text()).toBe('WEBVTT\n');
    });

    it('ends the response empty when ffmpeg cannot be started', async () => {
      const file: string = mediaFile('unrunnable.srt');
      const pending: Promise<Response> = api(externalPath(file));
      const ffmpeg: FakeProcess = await nextSpawn(FFMPEG);

      ffmpeg.failToStart(new Error('spawn ENOENT'));
      const res: Response = await pending;

      expect(await res.text()).toBe('');
    });

    it('stops the conversion when the client disconnects', async () => {
      const file: string = mediaFile('abandoned.srt');

      const ffmpeg: FakeProcess = await disconnectMidStream(externalPath(file));

      expect(await ffmpeg.killed).toBe('SIGTERM');
    });
  });
});

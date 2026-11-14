/**
 * @fileoverview Integration tests for UnifiedMediaServer probing, playback and
 * playlist behaviour.
 *
 * Tests cover:
 * - Media probing (GET /media/info): ffprobe JSON → MediaInfo, codec and remux
 *   detection, audio/subtitle tracks, artwork streams, the mtime-validated
 *   probe cache, MIDI and tracker branches, and every ffprobe failure mode
 * - Playback control (POST play/pause/stop/started/seek/sync/volume)
 * - Server-side time tracking, track-end advance, repeat and shuffle
 * - Playlist handlers (add, remove, clear, select, next, previous, save, load)
 * - The SSE events and main-process callbacks those emit
 *
 * A real server is started on a random port. ffprobe is never run: the server
 * is pointed at a fake binary name, and `child_process.spawn` is intercepted
 * for that name only, returning a scripted fake process per probed file.
 *
 * @module electron/unified-media-server.playback.spec
 */

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { IncomingMessage, ClientRequest } from 'http';
import http from 'http';
import type { MediaInfo, PlaylistItem } from './media-types.js';
import type { DependencyManager } from './dependency-manager.js';
import type { RecentItem } from './settings-manager.js';

// ============================================================================
// Mocks — must be defined before importing the module under test
// ============================================================================

const mockUserDataPath: string = path.join(os.tmpdir(), `onixplayer-ums-playback-test-${process.pid}-${Date.now()}`);

/** Shared between the hoisted child_process mock and the tests. */
const fakeProbe: {
  readonly binary: string;
  spawn: ((args: readonly string[]) => unknown) | null;
} = vi.hoisted(() => ({
  binary: 'onix-fake-ffprobe',
  spawn: null,
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name === 'userData') return mockUserDataPath;
      return os.tmpdir();
    },
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

// Only spawns of the fake ffprobe binary are intercepted; everything else
// (dependency detection and so on) reaches the real child_process.
vi.mock('child_process', async (importOriginal: () => Promise<typeof import('child_process')>) => {
  const actual: typeof import('child_process') = await importOriginal();
  return {
    ...actual,
    spawn: (command: string, ...rest: unknown[]): unknown => {
      if (command === fakeProbe.binary && fakeProbe.spawn) {
        return fakeProbe.spawn(rest[0] as readonly string[]);
      }
      return (actual.spawn as (...args: unknown[]) => unknown)(command, ...rest);
    },
  };
});

// ============================================================================
// Import under test
// ============================================================================

import { UnifiedMediaServer } from './unified-media-server.js';

// ============================================================================
// Fake ffprobe
// ============================================================================

/** The subset of ffprobe's JSON output the server reads. */
interface ProbeOutput {
  readonly format?: {
    readonly duration?: string;
    readonly tags?: Record<string, string>;
  };
  readonly streams?: ReadonlyArray<Record<string, unknown>>;
}

/** How the fake ffprobe behaves for one file. */
type ProbeScript =
  | { readonly kind: 'json'; readonly output: ProbeOutput; readonly delayTicks?: number }
  | { readonly kind: 'raw'; readonly stdout: string }
  | { readonly kind: 'exit'; readonly code: number; readonly stderr: string }
  | { readonly kind: 'spawn-error'; readonly message: string };

/** Minimal stand-in for the ChildProcess surface probeMedia uses. */
class FakeProbeProcess extends EventEmitter {
  public readonly stdout: PassThrough = new PassThrough();
  public readonly stderr: PassThrough = new PassThrough();
}

/** Scripts keyed by probed file path. Unscripted files fail like a bad input. */
const probeScripts: Map<string, ProbeScript> = new Map<string, ProbeScript>();

/** Every file path the fake ffprobe was spawned for, in order. */
const probedPaths: string[] = [];

/** Fake ffprobe processes currently running, and the most seen at once. */
let probesInFlight: number = 0;
let maxProbesInFlight: number = 0;

/** Runs `callback` after the given number of event-loop turns. */
function afterTicks(ticks: number, callback: () => void): void {
  if (ticks <= 0) {
    setImmediate(callback);
  } else {
    setImmediate((): void => afterTicks(ticks - 1, callback));
  }
}

fakeProbe.spawn = (args: readonly string[]): unknown => {
  const filePath: string = args[args.length - 1];
  const script: ProbeScript = probeScripts.get(filePath)
    ?? { kind: 'exit', code: 1, stderr: `${filePath}: No such file or directory` };
  const child: FakeProbeProcess = new FakeProbeProcess();

  probedPaths.push(filePath);
  probesInFlight++;
  maxProbesInFlight = Math.max(maxProbesInFlight, probesInFlight);

  if (script.kind === 'spawn-error') {
    setImmediate((): void => {
      probesInFlight--;
      child.emit('error', new Error(script.message));
    });
    return child;
  }

  const stdout: string = script.kind === 'json' ? JSON.stringify(script.output) : script.kind === 'raw' ? script.stdout : '';
  const stderr: string = script.kind === 'exit' ? script.stderr : '';
  const code: number = script.kind === 'exit' ? script.code : 0;

  // Close only once both pipes have been fully read, as a real process does.
  let openPipes: number = 2;
  const onPipeEnd = (): void => {
    openPipes--;
    if (openPipes === 0) {
      probesInFlight--;
      child.emit('close', code);
    }
  };
  child.stdout.on('end', onPipeEnd);
  child.stderr.on('end', onPipeEnd);

  afterTicks(script.kind === 'json' ? script.delayTicks ?? 0 : 0, (): void => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
  });

  return child;
};

/** Number of times the fake ffprobe was spawned for a file. */
function probeCount(filePath: string): number {
  return probedPaths.filter((probed: string): boolean => probed === filePath).length;
}

/** ffprobe output for a plain audio file. */
function audioProbe(duration: number, tags: Record<string, string> = {}): ProbeOutput {
  return {
    format: { duration: String(duration), tags },
    streams: [{ index: 0, codec_type: 'audio', codec_name: 'mp3', channels: 2 }],
  };
}

/** ffprobe output for a video file with one video and one audio stream. */
function videoProbe(duration: number, videoCodec: string = 'h264', audioCodec: string = 'aac'): ProbeOutput {
  return {
    format: { duration: String(duration) },
    streams: [
      { index: 0, codec_type: 'video', codec_name: videoCodec, width: 1920, height: 1080 },
      { index: 1, codec_type: 'audio', codec_name: audioCodec, channels: 6 },
    ],
  };
}

// ============================================================================
// HTTP helpers
// ============================================================================

let baseUrl: string = '';

/** Session token minted by the server under test; required on every API request. */
let authToken: string = '';

interface JsonResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface PlayerStateBody {
  readonly state: string;
  readonly currentTime: number;
  readonly duration: number;
  readonly volume: number;
  readonly muted: boolean;
  readonly currentMedia: MediaInfo | null;
  readonly errorMessage: string | null;
}

interface PlaylistBody {
  readonly items: readonly PlaylistItem[];
  readonly currentIndex: number;
  readonly shuffleEnabled: boolean;
  readonly repeatEnabled: boolean;
}

/** Sends an authenticated HTTP request and returns { status, body }. */
async function request(method: string, urlPath: string, body?: unknown): Promise<JsonResponse> {
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

/** Fetches the media info for a file. */
function mediaInfo(filePath: string): Promise<JsonResponse> {
  return request('GET', `/media/info?path=${encodeURIComponent(filePath)}`);
}

async function playerState(): Promise<PlayerStateBody> {
  return (await request('GET', '/player/state')).body as unknown as PlayerStateBody;
}

async function playlistState(): Promise<PlaylistBody> {
  return (await request('GET', '/playlist')).body as unknown as PlaylistBody;
}

/** Adds files to the playlist and returns the items the server created. */
async function addFiles(paths: readonly string[]): Promise<PlaylistItem[]> {
  const { body }: JsonResponse = await request('POST', '/playlist/add', { paths });
  return body.added as PlaylistItem[];
}

/**
 * Polls the player state until it satisfies the predicate.
 *
 * Each poll is a real round trip to the server, so this yields to whatever
 * asynchronous work the server is finishing without sleeping.
 */
async function waitForPlayerState(predicate: (state: PlayerStateBody) => boolean): Promise<PlayerStateBody> {
  let last: PlayerStateBody = await playerState();
  for (let attempt: number = 0; attempt < 500 && !predicate(last); attempt++) {
    await new Promise<void>((resolve: () => void): void => { setImmediate(resolve); });
    last = await playerState();
  }
  if (!predicate(last)) {
    throw new Error(`Player never reached the expected state; last was ${JSON.stringify(last)}`);
  }
  return last;
}

// ============================================================================
// SSE helper
// ============================================================================

interface SseEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

interface SseWaiter {
  readonly event: string;
  readonly predicate: (data: Record<string, unknown>) => boolean;
  readonly resolve: (event: SseEvent) => void;
}

/** A live SSE connection that records events and lets tests await them. */
class SseClient {
  public readonly events: SseEvent[] = [];
  private readonly waiters: Set<SseWaiter> = new Set<SseWaiter>();
  private readonly req: ClientRequest;

  private constructor(req: ClientRequest) {
    this.req = req;
  }

  /** Connects and resolves once the server's initial state burst has arrived. */
  public static connect(): Promise<SseClient> {
    return new Promise<SseClient>((resolve: (client: SseClient) => void, reject: (err: Error) => void): void => {
      const req: ClientRequest = http.get(`${baseUrl}/events`, { headers: { 'X-Onix-Token': authToken } }, (res: IncomingMessage): void => {
        let buffer: string = '';
        res.on('data', (chunk: Buffer): void => {
          buffer += chunk.toString();
          const parts: string[] = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            client.receive(part);
          }
        });
        res.on('error', (): void => { /* destroyed on close() */ });
      });
      const client: SseClient = new SseClient(req);
      req.on('error', (err: Error): void => {
        // Destroying the socket on close() is expected.
        if (!req.destroyed) reject(err);
      });
      // dependencies:state is the last event of the initial burst.
      void client.waitFor('dependencies:state').then((): void => resolve(client), reject);
    });
  }

  /** Resolves with the first recorded or future event that matches. */
  public waitFor(
    event: string,
    predicate: (data: Record<string, unknown>) => boolean = (): boolean => true,
    timeoutMs: number = 5000,
  ): Promise<SseEvent> {
    const existing: SseEvent | undefined = this.events.find((e: SseEvent): boolean => e.event === event && predicate(e.data));
    if (existing) return Promise.resolve(existing);

    return new Promise<SseEvent>((resolve: (event: SseEvent) => void, reject: (err: Error) => void): void => {
      const timer: NodeJS.Timeout = setTimeout((): void => {
        this.waiters.delete(waiter);
        reject(new Error(`Timed out waiting for SSE event "${event}"; received: ${this.names().join(', ')}`));
      }, timeoutMs);
      const waiter: SseWaiter = {
        event,
        predicate,
        resolve: (received: SseEvent): void => {
          clearTimeout(timer);
          resolve(received);
        },
      };
      this.waiters.add(waiter);
    });
  }

  /** Names of the recorded events, in arrival order. */
  public names(): string[] {
    return this.events.map((e: SseEvent): string => e.event);
  }

  /**
   * Forgets everything broadcast so far, so later waits see only new events.
   *
   * Events travel on their own socket and can trail the HTTP response of the
   * request that caused them. A harmless volume broadcast is used as a marker:
   * once it arrives, everything broadcast before it has arrived too.
   */
  public async drain(): Promise<void> {
    const marker: Promise<SseEvent> = new Promise<SseEvent>((resolve: (event: SseEvent) => void): void => {
      this.waiters.add({ event: 'playback:volume', predicate: (): boolean => true, resolve });
    });
    await request('POST', '/player/volume', {});
    await marker;
    this.events.length = 0;
  }

  public close(): void {
    this.req.destroy();
  }

  private receive(part: string): void {
    let event: string = '';
    let data: string = '';
    for (const line of part.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (!event) return;

    const received: SseEvent = { event, data: JSON.parse(data) as Record<string, unknown> };
    this.events.push(received);
    for (const waiter of [...this.waiters]) {
      if (waiter.event === received.event && waiter.predicate(received.data)) {
        this.waiters.delete(waiter);
        waiter.resolve(received);
      }
    }
  }
}

// ============================================================================
// Test suite
// ============================================================================

describe('UnifiedMediaServer probing, playback and playlist', () => {
  let server: UnifiedMediaServer;
  let deps: DependencyManager;
  let mediaDir: string = '';
  let fileCounter: number = 0;
  let sse: SseClient | null = null;

  /** Render caches are private; tests seed them to stand in for a finished render. */
  type RenderCache = Map<string, { readonly tempFile: string; readonly duration: number }>;

  function renderCaches(): { readonly midiRenderCache: RenderCache; readonly trackerRenderCache: RenderCache } {
    return server as unknown as { readonly midiRenderCache: RenderCache; readonly trackerRenderCache: RenderCache };
  }

  /**
   * Creates a real file (so path validation and mtime checks see it) in its
   * own directory, so the base name stays exactly as given.
   */
  function createFile(name: string, content: Buffer | string = 'media'): string {
    const dir: string = path.join(mediaDir, String(++fileCounter));
    fs.mkdirSync(dir, { recursive: true });
    const filePath: string = path.join(dir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  /** Creates a media file and scripts what ffprobe reports for it. */
  function createMedia(name: string, output: ProbeOutput): string {
    const filePath: string = createFile(name);
    probeScripts.set(filePath, { kind: 'json', output });
    return filePath;
  }

  /** Creates an audio file whose title tag and duration are known. */
  function createAudio(title: string, duration: number): string {
    return createMedia(`${title}.mp3`, audioProbe(duration, { title }));
  }

  /** Moves a file's mtime forward, as replacing it on disk would. */
  function touch(filePath: string): void {
    const future: Date = new Date(fs.statSync(filePath).mtimeMs + 60_000);
    fs.utimesSync(filePath, future, future);
  }

  /** A one-track MIDI file: 960 ticks at 480 ticks/beat and 120 BPM is 1 second. */
  function midiBytes(): Buffer {
    const note: number = 0x30 + (fileCounter % 40);
    const track: number[] = [
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
      0x83, 0x60, 0x90, note, 0x40,
      0x83, 0x60, 0x80, note, 0x00,
      0x00, 0xff, 0x2f, 0x00,
    ];
    const header: Buffer = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0]);
    const trackHeader: Buffer = Buffer.from([0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length]);
    return Buffer.concat([header, trackHeader, Buffer.from(track)]);
  }

  /** Opens the SSE connection for a test; closed automatically afterwards. */
  async function connectSse(): Promise<SseClient> {
    sse = await SseClient.connect();
    return sse;
  }

  beforeAll(async () => {
    fs.mkdirSync(mockUserDataPath, { recursive: true });
    mediaDir = path.join(mockUserDataPath, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    server = new UnifiedMediaServer();
    deps = server.getDependencyManager();
    const port: number = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
    authToken = server.getAuthToken();
    // Dependency detection can be slow on a busy Windows runner.
  }, 30000);

  afterAll(() => {
    server.stop();
    vi.restoreAllMocks();
    fs.rmSync(mockUserDataPath, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    // Point the server at the fake ffprobe, and make sure no test can start a
    // real render: background MIDI/tracker renders fail fast without binaries.
    vi.spyOn(deps, 'getFfprobePath').mockReturnValue(fakeProbe.binary);
    vi.spyOn(deps, 'getFfmpegPath').mockReturnValue(null);
    vi.spyOn(deps, 'getFluidsynthPath').mockReturnValue(null);

    server.onModeChange((): void => undefined);
    server.onPlaylistCountChange((): void => undefined);
    server.onPlaybackStateChange((): void => undefined);
    server.onMediaTypeChange((): void => undefined);
    server.onRecentItemsChange((): void => undefined);

    await request('DELETE', '/playlist/clear');
    await request('POST', '/playlist/shuffle', { enabled: false });
    await request('POST', '/playlist/repeat', { enabled: false });
    await request('POST', '/player/volume', { volume: 1, muted: false });

    probeScripts.clear();
    probedPaths.length = 0;
    probesInFlight = 0;
    maxProbesInFlight = 0;
  });

  afterEach(() => {
    sse?.close();
    sse = null;
  });

  // ==========================================================================
  // GET /media/info — ffprobe output parsing
  // ==========================================================================

  describe('GET /media/info (probe parsing)', () => {
    it('reports an audio file with its tags, duration and audio codec', async () => {
      const filePath: string = createMedia('song.mp3', audioProbe(183.5, { title: 'Blue', artist: 'Joni', album: 'Blue LP' }));

      const { status, body } = await mediaInfo(filePath);

      expect(status).toBe(200);
      expect(body).toEqual({
        duration: 183.5,
        type: 'audio',
        title: 'Blue',
        artist: 'Joni',
        album: 'Blue LP',
        filePath,
        audioCodec: 'mp3',
      });
    });

    it('reads upper-case tag names as written by some containers', async () => {
      const filePath: string = createMedia('upper.flac', audioProbe(10, { TITLE: 'Loud', ARTIST: 'Shouty', ALBUM: 'Caps' }));

      const { body } = await mediaInfo(filePath);

      expect(body.title).toBe('Loud');
      expect(body.artist).toBe('Shouty');
      expect(body.album).toBe('Caps');
    });

    it('falls back to the album artist when there is no artist tag', async () => {
      const filePath: string = createMedia('compilation.mp3', audioProbe(10, { album_artist: 'Various' }));

      const { body } = await mediaInfo(filePath);

      expect(body.artist).toBe('Various');
    });

    it('uses the file name without extension as the title when untagged', async () => {
      const filePath: string = createMedia('My Recording.mp3', audioProbe(10));

      const { body } = await mediaInfo(filePath);

      expect(body.title).toBe('My Recording');
    });

    it('reports a zero duration when ffprobe gives none', async () => {
      const filePath: string = createMedia('live.mp3', {
        format: {},
        streams: [{ index: 0, codec_type: 'audio', codec_name: 'mp3' }],
      });

      const { body } = await mediaInfo(filePath);

      expect(body.duration).toBe(0);
    });

    it('treats output with no format or streams as an untagged audio file', async () => {
      const filePath: string = createMedia('empty.mp3', {});

      const { status, body } = await mediaInfo(filePath);

      expect(status).toBe(200);
      expect(body).toEqual({ duration: 0, type: 'audio', title: 'empty', filePath });
    });

    it('does not mistake embedded cover art for a video stream', async () => {
      const filePath: string = createMedia('with-cover.mp3', {
        format: { duration: '200' },
        streams: [
          { index: 0, codec_type: 'audio', codec_name: 'mp3' },
          { index: 1, codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600 },
        ],
      });

      const { body } = await mediaInfo(filePath);

      expect(body.type).toBe('audio');
      expect(body).not.toHaveProperty('width');
      expect(body).not.toHaveProperty('videoCodec');
      expect(body).not.toHaveProperty('canRemux');
    });

    it('reports a video file with its dimensions and codecs', async () => {
      const filePath: string = createMedia('film.mkv', videoProbe(5400));

      const { body } = await mediaInfo(filePath);

      expect(body).toEqual({
        duration: 5400,
        type: 'video',
        title: 'film',
        filePath,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        audioCodec: 'aac',
        canRemux: true,
      });
    });

    it.each([
      ['h264', 'aac'],
      ['hevc', 'mp3'],
      ['vp9', 'opus'],
      ['av1', 'flac'],
    ])('marks %s video with %s audio as remuxable', async (videoCodec: string, audioCodec: string) => {
      const filePath: string = createMedia('remux.mkv', videoProbe(60, videoCodec, audioCodec));

      const { body } = await mediaInfo(filePath);

      expect(body.canRemux).toBe(true);
    });

    it('marks video whose audio codec cannot go into MP4 as not remuxable', async () => {
      const filePath: string = createMedia('surround.mkv', videoProbe(60, 'h264', 'ac3'));

      const { body } = await mediaInfo(filePath);

      expect(body.canRemux).toBe(false);
      expect(body.audioCodec).toBe('ac3');
    });

    it('marks video whose video codec browsers cannot play as not remuxable', async () => {
      const filePath: string = createMedia('old.avi', videoProbe(60, 'mpeg4', 'aac'));

      const { body } = await mediaInfo(filePath);

      expect(body.canRemux).toBe(false);
    });

    it('marks silent video as not remuxable', async () => {
      const filePath: string = createMedia('silent.mkv', {
        format: { duration: '60' },
        streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 640, height: 480 }],
      });

      const { body } = await mediaInfo(filePath);

      expect(body.canRemux).toBe(false);
      expect(body).not.toHaveProperty('audioCodec');
    });

    it('lists the audio tracks of a multi-audio video by audio-relative index', async () => {
      const filePath: string = createMedia('dual-audio.mkv', {
        format: { duration: '60' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
          { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 6, tags: { language: 'eng', title: 'Main' }, disposition: { default: 1 } },
          { index: 2, codec_type: 'audio', codec_name: 'ac3', tags: { language: 'jpn' }, disposition: { default: 0 } },
          { index: 3, codec_type: 'audio', codec_name: 'dts' },
        ],
      });

      const { body } = await mediaInfo(filePath);

      expect(body.audioTracks).toEqual([
        { index: 0, language: 'eng', title: 'Main', codec: 'aac', channels: 6, default: true },
        { index: 1, language: 'jpn', title: 'Japanese', codec: 'ac3', channels: 2, default: false },
        { index: 2, language: 'und', title: 'Unknown', codec: 'dts', channels: 2, default: false },
      ]);
    });

    it('bases the remux decision on the first audio stream', async () => {
      const filePath: string = createMedia('first-audio.mkv', {
        format: { duration: '60' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'dts' },
          { index: 2, codec_type: 'audio', codec_name: 'aac' },
        ],
      });

      const { body } = await mediaInfo(filePath);

      expect(body.audioCodec).toBe('dts');
      expect(body.canRemux).toBe(false);
    });

    it('omits the audio track list when a video has a single audio stream', async () => {
      const filePath: string = createMedia('single-audio.mkv', videoProbe(60));

      const { body } = await mediaInfo(filePath);

      expect(body).not.toHaveProperty('audioTracks');
    });

    it('lists text subtitle tracks with their container stream index and flags', async () => {
      const filePath: string = createMedia('subbed.mkv', {
        format: { duration: '60' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac' },
          { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng', title: 'English (SDH)' }, disposition: { default: 1, forced: 0 } },
          { index: 3, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'spa' }, disposition: { default: 0, forced: 1 } },
          { index: 4, codec_type: 'subtitle', codec_name: 'mov_text', tags: { language: 'xyz' } },
          { index: 5, codec_type: 'subtitle', codec_name: 'webvtt' },
        ],
      });

      const { body } = await mediaInfo(filePath);

      expect(body.subtitleTracks).toEqual([
        { index: 2, language: 'eng', title: 'English (SDH)', codec: 'subrip', forced: false, default: true },
        { index: 3, language: 'spa', title: 'Spanish', codec: 'ass', forced: true, default: false },
        { index: 4, language: 'xyz', title: 'XYZ', codec: 'mov_text', forced: false, default: false },
        { index: 5, language: 'und', title: 'Unknown', codec: 'webvtt', forced: false, default: false },
      ]);
    });

    it('drops bitmap subtitle tracks, which cannot be converted to text', async () => {
      const filePath: string = createMedia('bluray.mkv', {
        format: { duration: '60' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac' },
          { index: 2, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } },
          { index: 3, codec_type: 'subtitle', codec_name: 'dvd_subtitle', tags: { language: 'eng' } },
          { index: 4, codec_type: 'subtitle', codec_name: 'srt', tags: { language: 'fre' } },
        ],
      });

      const { body } = await mediaInfo(filePath);

      expect(body.subtitleTracks).toEqual([
        { index: 4, language: 'fre', title: 'French', codec: 'srt', forced: false, default: false },
      ]);
    });

    it('omits subtitle tracks when a video has only bitmap subtitles', async () => {
      const filePath: string = createMedia('pgs-only.mkv', {
        format: { duration: '60' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' },
        ],
      });

      const { body } = await mediaInfo(filePath);

      expect(body).not.toHaveProperty('subtitleTracks');
    });

    it('does not report subtitle or audio tracks for an audio file', async () => {
      const filePath: string = createMedia('lyrics.mka', {
        format: { duration: '60' },
        streams: [
          { index: 0, codec_type: 'audio', codec_name: 'flac' },
          { index: 1, codec_type: 'audio', codec_name: 'aac' },
          { index: 2, codec_type: 'subtitle', codec_name: 'subrip' },
        ],
      });

      const { body } = await mediaInfo(filePath);

      expect(body.type).toBe('audio');
      expect(body).not.toHaveProperty('subtitleTracks');
      expect(body).not.toHaveProperty('audioTracks');
    });
  });

  // ==========================================================================
  // GET /media/info — ffprobe failures
  // ==========================================================================

  describe('GET /media/info (probe failures)', () => {
    it('reports that ffprobe is missing without spawning anything', async () => {
      const filePath: string = createMedia('song.mp3', audioProbe(10));
      vi.spyOn(deps, 'getFfprobePath').mockReturnValue(null);

      const { status, body } = await mediaInfo(filePath);

      expect(status).toBe(500);
      expect(body.error).toBe('ffprobe not found');
      expect(probedPaths).toEqual([]);
    });

    it('reports ffprobe stderr when it exits with a non-zero code', async () => {
      const filePath: string = createFile('corrupt.mp3');
      probeScripts.set(filePath, { kind: 'exit', code: 1, stderr: 'Invalid data found when processing input' });

      const { status, body } = await mediaInfo(filePath);

      expect(status).toBe(500);
      expect(body.error).toBe('ffprobe failed: Invalid data found when processing input');
    });

    it('reports a parse failure when ffprobe prints something other than JSON', async () => {
      const filePath: string = createFile('garbled.mp3');
      probeScripts.set(filePath, { kind: 'raw', stdout: '{ "format": ' });

      const { status, body } = await mediaInfo(filePath);

      expect(status).toBe(500);
      expect(String(body.error)).toContain('Failed to parse ffprobe output');
    });

    it('reports a spawn error when ffprobe cannot be started', async () => {
      const filePath: string = createFile('unlaunchable.mp3');
      probeScripts.set(filePath, { kind: 'spawn-error', message: 'spawn ENOENT' });

      const { status, body } = await mediaInfo(filePath);

      expect(status).toBe(500);
      expect(body.error).toBe('ffprobe error: spawn ENOENT');
    });

    it('rejects a directory before probing it', async () => {
      const directory: string = path.dirname(createFile('inside.mp3'));

      const { status, body } = await mediaInfo(directory);

      expect(status).toBe(400);
      expect(body.error).toBe('Path is not a regular file');
      expect(probedPaths).toEqual([]);
    });
  });

  // ==========================================================================
  // Probe cache
  // ==========================================================================

  describe('probe cache', () => {
    it('does not probe an unchanged file a second time', async () => {
      const filePath: string = createMedia('song.mp3', audioProbe(10, { title: 'Once' }));
      await mediaInfo(filePath);

      const { status, body } = await mediaInfo(filePath);

      expect(status).toBe(200);
      expect(body.title).toBe('Once');
      expect(probeCount(filePath)).toBe(1);
    });

    it('probes again when the file has been modified since it was cached', async () => {
      const filePath: string = createMedia('song.mp3', audioProbe(10, { title: 'Before' }));
      await mediaInfo(filePath);
      probeScripts.set(filePath, { kind: 'json', output: audioProbe(25, { title: 'After' }) });
      touch(filePath);

      const { body } = await mediaInfo(filePath);

      expect(body.title).toBe('After');
      expect(body.duration).toBe(25);
      expect(probeCount(filePath)).toBe(2);
    });

    it('caches the re-probed result against the new modification time', async () => {
      const filePath: string = createMedia('song.mp3', audioProbe(10));
      await mediaInfo(filePath);
      touch(filePath);
      await mediaInfo(filePath);

      await mediaInfo(filePath);

      expect(probeCount(filePath)).toBe(2);
    });

    it('does not cache a failed probe', async () => {
      const filePath: string = createFile('flaky.mp3');
      probeScripts.set(filePath, { kind: 'exit', code: 1, stderr: 'temporarily unreadable' });
      await mediaInfo(filePath);
      probeScripts.set(filePath, { kind: 'json', output: audioProbe(10, { title: 'Recovered' }) });

      const { status, body } = await mediaInfo(filePath);

      expect(status).toBe(200);
      expect(body.title).toBe('Recovered');
      expect(probeCount(filePath)).toBe(2);
    });

    it('reuses the probe made when a file was added once it is played', async () => {
      const filePath: string = createAudio('Cached', 10);
      await addFiles([filePath]);

      const { status } = await request('POST', '/player/play');

      expect(status).toBe(200);
      expect(probeCount(filePath)).toBe(1);
    });

    it('probes a remote source every time, as it has no modification time to check', async () => {
      const remote: string = `https://media.invalid/stream-${++fileCounter}.mp4`;
      probeScripts.set(remote, { kind: 'json', output: videoProbe(90) });
      await mediaInfo(remote);

      const { status, body } = await mediaInfo(remote);

      expect(status).toBe(200);
      expect(body).toMatchObject({ type: 'video', duration: 90, filePath: remote });
      expect(probeCount(remote)).toBe(2);
    });

    it('keeps separate entries for different files', async () => {
      const first: string = createAudio('First', 10);
      const second: string = createAudio('Second', 20);
      await mediaInfo(first);
      await mediaInfo(second);

      const { body } = await mediaInfo(first);

      expect(body.title).toBe('First');
      expect(probedPaths).toEqual([first, second]);
    });
  });

  // ==========================================================================
  // MIDI and tracker probing
  // ==========================================================================

  describe('GET /media/info (MIDI and tracker files)', () => {
    it('reports the parsed duration of a MIDI file without running ffprobe', async () => {
      const filePath: string = createFile('fanfare.mid', midiBytes());

      const { status, body } = await mediaInfo(filePath);

      expect(status).toBe(200);
      expect(body.type).toBe('audio');
      expect(body.title).toBe('fanfare');
      expect(body.filePath).toBe(filePath);
      expect(body.duration as number).toBeCloseTo(1, 3);
      expect(probedPaths).toEqual([]);
    });

    it('prefers the rendered duration of a MIDI file once a render is cached', async () => {
      const filePath: string = createFile('rendered.midi', midiBytes());
      renderCaches().midiRenderCache.set(filePath, { tempFile: createFile('render.mp3'), duration: 42.5 });

      const { body } = await mediaInfo(filePath);

      expect(body).toEqual({ duration: 42.5, type: 'audio', title: 'rendered', filePath });
    });

    it('reports a tracker module with an unknown duration until it is rendered', async () => {
      const filePath: string = createFile('chiptune.mod', 'not a real module');

      const { status, body } = await mediaInfo(filePath);

      expect(status).toBe(200);
      expect(body).toEqual({ duration: 0, type: 'audio', title: 'chiptune', filePath });
      expect(probedPaths).toEqual([]);
    });

    it('reports the rendered duration of a tracker module once a render is cached', async () => {
      const filePath: string = createFile('demo.xm', 'not a real module');
      renderCaches().trackerRenderCache.set(filePath, { tempFile: createFile('render.mp3'), duration: 95 });

      const { body } = await mediaInfo(filePath);

      expect(body).toEqual({ duration: 95, type: 'audio', title: 'demo', filePath });
    });
  });

  // ==========================================================================
  // POST /playlist/add
  // ==========================================================================

  describe('POST /playlist/add', () => {
    it('adds probed files with their metadata and codec details', async () => {
      const audio: string = createMedia('song.mp3', audioProbe(180, { title: 'Song', artist: 'Band', album: 'Record' }));
      const video: string = createMedia('clip.mkv', videoProbe(60, 'h264', 'ac3'));

      const { status, body } = await request('POST', '/playlist/add', { paths: [audio, video] });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      const added: PlaylistItem[] = body.added as PlaylistItem[];
      expect(added).toEqual([
        { id: expect.any(String), filePath: audio, title: 'Song', artist: 'Band', album: 'Record', duration: 180, type: 'audio', audioCodec: 'mp3' },
        { id: expect.any(String), filePath: video, title: 'clip', duration: 60, type: 'video', width: 1920, height: 1080, audioCodec: 'ac3', canRemux: false },
      ]);
      expect(added[0].id).not.toBe(added[1].id);
    });

    it('selects the first added item without starting playback', async () => {
      const first: string = createAudio('First', 10);
      const second: string = createAudio('Second', 10);

      await addFiles([first, second]);

      const playlist: PlaylistBody = await playlistState();
      const state: PlayerStateBody = await playerState();
      expect(playlist.items.map((item: PlaylistItem): string => item.title)).toEqual(['First', 'Second']);
      expect(playlist.currentIndex).toBe(0);
      expect(state.state).toBe('idle');
      expect(state.currentMedia).toBeNull();
    });

    it('appends to an existing playlist without changing the selection', async () => {
      const [, second]: PlaylistItem[] = await addFiles([createAudio('First', 10), createAudio('Second', 10)]);
      await request('POST', `/playlist/select/${second.id}`);

      await addFiles([createAudio('Third', 10)]);

      const playlist: PlaylistBody = await playlistState();
      expect(playlist.items.map((item: PlaylistItem): string => item.title)).toEqual(['First', 'Second', 'Third']);
      expect(playlist.currentIndex).toBe(1);
    });

    it('skips files that fail to probe and keeps the rest in order', async () => {
      const first: string = createAudio('First', 10);
      const broken: string = createFile('broken.mp3');
      const last: string = createAudio('Last', 10);
      probeScripts.set(broken, { kind: 'exit', code: 1, stderr: 'Invalid data' });

      const added: PlaylistItem[] = await addFiles([first, broken, last]);

      expect(added.map((item: PlaylistItem): string => item.title)).toEqual(['First', 'Last']);
    });

    it('keeps the requested order even when later files finish probing first', async () => {
      const slow: string = createFile('slow.mp3');
      const medium: string = createFile('medium.mp3');
      const fast: string = createFile('fast.mp3');
      probeScripts.set(slow, { kind: 'json', output: audioProbe(1, { title: 'Slow' }), delayTicks: 20 });
      probeScripts.set(medium, { kind: 'json', output: audioProbe(1, { title: 'Medium' }), delayTicks: 10 });
      probeScripts.set(fast, { kind: 'json', output: audioProbe(1, { title: 'Fast' }) });

      const added: PlaylistItem[] = await addFiles([slow, medium, fast]);

      expect(added.map((item: PlaylistItem): string => item.title)).toEqual(['Slow', 'Medium', 'Fast']);
    });

    it('never runs more than six probes at once when many files are added', async () => {
      const paths: string[] = [];
      for (let i: number = 0; i < 20; i++) {
        const filePath: string = createFile(`track-${i}.mp3`);
        probeScripts.set(filePath, { kind: 'json', output: audioProbe(1, { title: `Track ${i}` }), delayTicks: 3 });
        paths.push(filePath);
      }

      const added: PlaylistItem[] = await addFiles(paths);

      expect(added).toHaveLength(20);
      expect(maxProbesInFlight).toBe(6);
    });

    it('announces the added items and the new selection over SSE', async () => {
      const client: SseClient = await connectSse();
      const filePath: string = createAudio('Announced', 10);

      const [item]: PlaylistItem[] = await addFiles([filePath]);

      const added: SseEvent = await client.waitFor('playlist:items:added');
      const selection: SseEvent = await client.waitFor('playlist:selection');
      expect(added.data).toEqual({ items: [item], startIndex: 0, currentIndex: 0 });
      expect(selection.data).toEqual({ currentIndex: 0, currentItem: item });
    });

    it('reports the new item count to the main process', async () => {
      const onCount = vi.fn();
      server.onPlaylistCountChange(onCount);

      await addFiles([createAudio('One', 10), createAudio('Two', 10)]);

      expect(onCount).toHaveBeenLastCalledWith(2);
    });

    it('records added files as recent items, newest first', async () => {
      const onRecent = vi.fn();
      server.onRecentItemsChange(onRecent);
      const first: string = createAudio('First', 10);
      const second: string = createAudio('Second', 10);

      await addFiles([first, second]);

      expect(onRecent).toHaveBeenCalledTimes(1);
      const recentFiles: readonly RecentItem[] = onRecent.mock.calls[0][0] as readonly RecentItem[];
      expect(recentFiles.slice(0, 2).map((item: RecentItem): string => item.path)).toEqual([second, first]);
    });

    it('does not touch recent items when nothing could be added', async () => {
      const onRecent = vi.fn();
      server.onRecentItemsChange(onRecent);

      const added: PlaylistItem[] = await addFiles([createFile('unprobeable.mp3')]);

      expect(added).toEqual([]);
      expect(onRecent).not.toHaveBeenCalled();
    });

    it('drops MIDI files while MIDI playback is unavailable', async () => {
      vi.spyOn(deps, 'hasMidiSupport').mockReturnValue(false);
      const midi: string = createFile('tune.mid', midiBytes());
      const audio: string = createAudio('Kept', 10);

      const added: PlaylistItem[] = await addFiles([midi, audio]);

      expect(added.map((item: PlaylistItem): string => item.title)).toEqual(['Kept']);
    });

    it('accepts MIDI files when MIDI playback is available', async () => {
      vi.spyOn(deps, 'hasMidiSupport').mockReturnValue(true);
      const midi: string = createFile('tune.mid', midiBytes());

      const added: PlaylistItem[] = await addFiles([midi]);

      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ title: 'tune', type: 'audio', filePath: midi });
      expect(added[0].duration).toBeCloseTo(1, 3);
    });

    it('drops tracker modules when FFmpeg cannot decode them', async () => {
      vi.spyOn(deps, 'hasTrackerSupport').mockReturnValue(false);
      const tracker: string = createFile('module.mod', 'module');
      const audio: string = createAudio('Kept', 10);

      const added: PlaylistItem[] = await addFiles([tracker, audio]);

      expect(added.map((item: PlaylistItem): string => item.title)).toEqual(['Kept']);
    });

    it('accepts tracker modules when FFmpeg can decode them', async () => {
      vi.spyOn(deps, 'hasTrackerSupport').mockReturnValue(true);
      const tracker: string = createFile('module.s3m', 'module');

      const added: PlaylistItem[] = await addFiles([tracker]);

      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ title: 'module', type: 'audio', duration: 0 });
    });

    it('rejects a malformed JSON body as a bad request', async () => {
      const res: Response = await fetch(`${baseUrl}/playlist/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Onix-Token': authToken },
        body: '{ not json',
      });

      expect(res.status).toBe(400);
      expect((await playerState()).state).toBe('idle');
    });
  });

  // ==========================================================================
  // POST /player/play
  // ==========================================================================

  describe('POST /player/play', () => {
    it('loads an audio track and waits for the renderer before playing', async () => {
      const filePath: string = createAudio('Waiting', 120);
      await addFiles([filePath]);

      const { status, body } = await request('POST', '/player/play');

      const state: PlayerStateBody = await playerState();
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.media).toMatchObject({ title: 'Waiting', duration: 120, type: 'audio', filePath });
      expect(state.state).toBe('loading');
      expect(state.duration).toBe(120);
      expect(state.currentTime).toBe(0);
      expect(state.currentMedia).toEqual(body.media);
    });

    it('starts a video track playing immediately', async () => {
      await addFiles([createMedia('film.mkv', videoProbe(600))]);

      await request('POST', '/player/play');

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('playing');
      expect(state.currentMedia?.type).toBe('video');
    });

    it('broadcasts loading, the loaded media, then the resulting state and time', async () => {
      const client: SseClient = await connectSse();
      await addFiles([createMedia('film.mkv', videoProbe(600))]);
      await client.drain();

      await request('POST', '/player/play');

      await client.waitFor('playback:time');
      const relevant: SseEvent[] = client.events.filter((e: SseEvent): boolean => e.event.startsWith('playback:'));
      expect(relevant.map((e: SseEvent): string => e.event)).toEqual([
        'playback:state', 'playback:loaded', 'playback:state', 'playback:time',
      ]);
      expect(relevant[0].data.state).toBe('loading');
      expect(relevant[1].data).toMatchObject({ title: 'film', type: 'video', canRemux: true });
      expect(relevant[2].data.state).toBe('playing');
      expect(relevant[3].data).toEqual({ currentTime: 0, duration: 600 });
    });

    it('tells the main process when a video starts and when playback begins', async () => {
      const onMediaType = vi.fn();
      const onPlaying = vi.fn();
      server.onMediaTypeChange(onMediaType);
      server.onPlaybackStateChange(onPlaying);
      await addFiles([createMedia('film.mkv', videoProbe(600))]);

      await request('POST', '/player/play');

      expect(onMediaType).toHaveBeenLastCalledWith(true);
      expect(onPlaying).toHaveBeenLastCalledWith(true);
    });

    it('reports audio media as not being video', async () => {
      const onMediaType = vi.fn();
      server.onMediaTypeChange(onMediaType);
      await addFiles([createAudio('Song', 10)]);

      await request('POST', '/player/play');

      expect(onMediaType).toHaveBeenLastCalledWith(false);
    });

    it('enters the error state with the probe message when the track cannot be loaded', async () => {
      const filePath: string = createAudio('Vanishing', 10);
      await addFiles([filePath]);
      probeScripts.set(filePath, { kind: 'exit', code: 1, stderr: 'file is gone' });
      touch(filePath);

      const { status, body } = await request('POST', '/player/play');

      const state: PlayerStateBody = await playerState();
      expect(status).toBe(500);
      expect(body.error).toBe('ffprobe failed: file is gone');
      expect(state.state).toBe('error');
      expect(state.errorMessage).toBe('ffprobe failed: file is gone');
    });

    it('broadcasts the error state with its message', async () => {
      const client: SseClient = await connectSse();
      const filePath: string = createAudio('Vanishing', 10);
      await addFiles([filePath]);
      probeScripts.set(filePath, { kind: 'spawn-error', message: 'spawn EACCES' });
      touch(filePath);

      await request('POST', '/player/play');

      const event: SseEvent = await client.waitFor('playback:state', (data: Record<string, unknown>): boolean => data.state === 'error');
      expect(event.data.errorMessage).toBe('ffprobe error: spawn EACCES');
    });

    it('drops the message of an earlier error once the track loads on a retry', async () => {
      const filePath: string = createAudio('Flaky', 10);
      await addFiles([filePath]);
      probeScripts.set(filePath, { kind: 'exit', code: 1, stderr: 'busy' });
      touch(filePath);
      await request('POST', '/player/play');
      probeScripts.set(filePath, { kind: 'json', output: audioProbe(10, { title: 'Flaky' }) });
      touch(filePath);

      await request('POST', '/player/play');

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('loading');
      expect(state.errorMessage).toBeNull();
    });

    it('loads a MIDI track with the duration of its finished render', async () => {
      vi.spyOn(deps, 'hasMidiSupport').mockReturnValue(true);
      const midi: string = createFile('tune.mid', midiBytes());
      renderCaches().midiRenderCache.set(midi, { tempFile: createFile('tune-render.mp3'), duration: 64 });
      await addFiles([midi]);

      const { status, body } = await request('POST', '/player/play');

      const state: PlayerStateBody = await playerState();
      expect(status).toBe(200);
      expect(body.media).toMatchObject({ title: 'tune', type: 'audio', duration: 64 });
      expect(state.state).toBe('loading');
      expect(state.duration).toBe(64);
    });

    it('fails to play a MIDI track that cannot be rendered', async () => {
      vi.spyOn(deps, 'hasMidiSupport').mockReturnValue(true);
      await addFiles([createFile('unrenderable.mid', midiBytes())]);

      const { status, body } = await request('POST', '/player/play');

      const state: PlayerStateBody = await playerState();
      expect(status).toBe(500);
      expect(typeof body.error).toBe('string');
      expect(state.state).toBe('error');
      expect(state.errorMessage).toBe(body.error);
    });

    it('loads a tracker module with the duration of its finished render', async () => {
      vi.spyOn(deps, 'hasTrackerSupport').mockReturnValue(true);
      const tracker: string = createFile('module.it', 'module');
      await addFiles([tracker]);
      renderCaches().trackerRenderCache.set(tracker, { tempFile: createFile('module-render.mp3'), duration: 201 });

      const { status, body } = await request('POST', '/player/play');

      const state: PlayerStateBody = await playerState();
      expect(status).toBe(200);
      expect(body.media).toMatchObject({ title: 'module', duration: 201 });
      expect(state.duration).toBe(201);
      expect(state.currentMedia?.duration).toBe(201);
    });

    it('fails to play a tracker module that cannot be rendered', async () => {
      const hasTrackerSupport = vi.spyOn(deps, 'hasTrackerSupport').mockReturnValue(true);
      await addFiles([createFile('unrenderable.mod', 'module')]);
      hasTrackerSupport.mockReturnValue(false);

      const { status, body } = await request('POST', '/player/play');

      expect(status).toBe(500);
      expect(body.error).toBe('Tracker rendering needs an FFmpeg built with libopenmpt');
      expect((await playerState()).state).toBe('error');
    });
  });

  // ==========================================================================
  // POST /player/started
  // ==========================================================================

  describe('POST /player/started', () => {
    it('is rejected when nothing is loading or playing', async () => {
      const { status, body } = await request('POST', '/player/started');

      expect(status).toBe(400);
      expect(body.error).toBe('Not in loading or playing state');
    });

    it('moves a loaded audio track into the playing state', async () => {
      await addFiles([createAudio('Song', 10)]);
      await request('POST', '/player/play');

      const { status, body } = await request('POST', '/player/started');

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect((await playerState()).state).toBe('playing');
    });

    it('broadcasts the playing state when audio actually starts', async () => {
      const client: SseClient = await connectSse();
      const onPlaying = vi.fn();
      server.onPlaybackStateChange(onPlaying);
      await addFiles([createAudio('Song', 10)]);
      await request('POST', '/player/play');
      await client.drain();

      await request('POST', '/player/started');

      const event: SseEvent = await client.waitFor('playback:state');
      expect(event.data).toEqual({ state: 'playing', errorMessage: null });
      expect(onPlaying).toHaveBeenLastCalledWith(true);
    });

    it('is rejected once playback has been paused', async () => {
      await addFiles([createMedia('film.mkv', videoProbe(600))]);
      await request('POST', '/player/play');
      await request('POST', '/player/pause');

      const { status } = await request('POST', '/player/started');

      expect(status).toBe(400);
      expect((await playerState()).state).toBe('paused');
    });
  });

  // ==========================================================================
  // POST /player/pause and resume
  // ==========================================================================

  describe('POST /player/pause', () => {
    it('pauses a playing track', async () => {
      await addFiles([createMedia('film.mkv', videoProbe(600))]);
      await request('POST', '/player/play');

      const { status, body } = await request('POST', '/player/pause');

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect((await playerState()).state).toBe('paused');
    });

    it('is rejected while an audio track is still loading', async () => {
      await addFiles([createAudio('Song', 10)]);
      await request('POST', '/player/play');

      const { status, body } = await request('POST', '/player/pause');

      expect(status).toBe(400);
      expect(body.error).toBe('Not playing');
    });

    it('resumes a paused track without reloading it', async () => {
      const filePath: string = createMedia('film.mkv', videoProbe(600));
      await addFiles([filePath]);
      await request('POST', '/player/play');
      await request('POST', '/player/pause');
      const client: SseClient = await connectSse();
      await client.drain();

      const { status, body } = await request('POST', '/player/play');

      const event: SseEvent = await client.waitFor('playback:state');
      expect(status).toBe(200);
      expect(body).toEqual({ success: true });
      expect(event.data.state).toBe('playing');
      expect((await playerState()).state).toBe('playing');
      expect(client.names()).not.toContain('playback:loaded');
    });
  });

  // ==========================================================================
  // POST /player/stop
  // ==========================================================================

  describe('POST /player/stop', () => {
    it('stops playback, rewinds and reselects the first item', async () => {
      const [, second]: PlaylistItem[] = await addFiles([createAudio('First', 10), createAudio('Second', 10)]);
      await request('POST', `/playlist/select/${second.id}`);

      const { status } = await request('POST', '/player/stop');

      const state: PlayerStateBody = await playerState();
      expect(status).toBe(200);
      expect(state.state).toBe('stopped');
      expect(state.currentTime).toBe(0);
      expect((await playlistState()).currentIndex).toBe(0);
    });

    it('broadcasts the stopped state before the new selection', async () => {
      // A client that saw the selection first would still believe playback was
      // active and briefly auto-play the reselected item.
      const [, second]: PlaylistItem[] = await addFiles([createAudio('First', 10), createAudio('Second', 10)]);
      await request('POST', `/playlist/select/${second.id}`);
      const client: SseClient = await connectSse();
      await client.drain();

      await request('POST', '/player/stop');

      await client.waitFor('playlist:selection');
      const names: string[] = client.names();
      expect(names.indexOf('playback:state')).toBeGreaterThanOrEqual(0);
      expect(names.indexOf('playback:state')).toBeLessThan(names.indexOf('playlist:selection'));
      expect(client.events[names.indexOf('playback:state')].data.state).toBe('stopped');
    });

    it('keeps the loaded media so the track can be played again', async () => {
      await addFiles([createAudio('Again', 10)]);
      await request('POST', '/player/play');
      await request('POST', '/player/stop');

      const { status, body } = await request('POST', '/player/play');

      expect(status).toBe(200);
      expect(body.media).toMatchObject({ title: 'Again' });
    });
  });

  // ==========================================================================
  // POST /player/seek, /player/sync and time tracking
  // ==========================================================================

  describe('time tracking', () => {
    /** Adds audio tracks and returns their playlist items. */
    function addTracks(...tracks: ReadonlyArray<readonly [title: string, duration: number]>): Promise<PlaylistItem[]> {
      return addFiles(tracks.map(([title, duration]: readonly [string, number]): string => createAudio(title, duration)));
    }

    beforeEach(() => {
      // Only the playback clock is faked; the HTTP stack keeps real timers.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    });

    afterEach(async () => {
      // Stop the tracking interval before the fake clock is torn down.
      await request('DELETE', '/playlist/clear');
      vi.useRealTimers();
    });

    it('advances the reported position while playing', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Song', 60]);
      await request('POST', `/playlist/select/${item.id}`);

      vi.advanceTimersByTime(2500);

      expect((await playerState()).currentTime).toBe(2.5);
    });

    it('broadcasts the position as it advances', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Song', 60]);
      await request('POST', `/playlist/select/${item.id}`);
      const client: SseClient = await connectSse();
      await client.drain();

      vi.advanceTimersByTime(300);

      const event: SseEvent = await client.waitFor('playback:time', (data: Record<string, unknown>): boolean => data.currentTime === 0.3);
      expect(event.data).toEqual({ currentTime: 0.3, duration: 60 });
    });

    it('does not advance an audio track until the renderer reports it started', async () => {
      await addTracks(['Song', 60]);
      await request('POST', '/player/play');

      vi.advanceTimersByTime(3000);

      expect((await playerState()).currentTime).toBe(0);
    });

    it('starts the clock from zero when the renderer reports audio started', async () => {
      await addTracks(['Song', 60]);
      await request('POST', '/player/play');
      vi.advanceTimersByTime(3000);
      await request('POST', '/player/started');

      vi.advanceTimersByTime(1000);

      expect((await playerState()).currentTime).toBe(1);
    });

    it('does not restart the clock when a start is reported for a track already playing', async () => {
      await addFiles([createMedia('film.mkv', videoProbe(600))]);
      await request('POST', '/player/play');
      vi.advanceTimersByTime(3000);

      await request('POST', '/player/started');
      vi.advanceTimersByTime(1000);

      expect((await playerState()).currentTime).toBe(4);
    });

    it('freezes the position while paused', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Song', 60]);
      await request('POST', `/playlist/select/${item.id}`);
      vi.advanceTimersByTime(2000);
      await request('POST', '/player/pause');

      vi.advanceTimersByTime(5000);

      expect((await playerState()).currentTime).toBe(2);
    });

    it('resumes from the paused position rather than from wall-clock time', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Song', 60]);
      await request('POST', `/playlist/select/${item.id}`);
      vi.advanceTimersByTime(2000);
      await request('POST', '/player/pause');
      vi.advanceTimersByTime(5000);

      await request('POST', '/player/play');
      vi.advanceTimersByTime(1000);

      expect((await playerState()).currentTime).toBe(3);
    });

    it('continues from the seeked position while playing', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Song', 60]);
      await request('POST', `/playlist/select/${item.id}`);

      const { body } = await request('POST', '/player/seek', { time: 30 });
      vi.advanceTimersByTime(1000);

      expect(body).toEqual({ success: true, time: 30 });
      expect((await playerState()).currentTime).toBe(31);
    });

    it('clamps a seek to the track duration', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Song', 60]);
      await request('POST', `/playlist/select/${item.id}`);
      await request('POST', '/player/pause');

      const { body } = await request('POST', '/player/seek', { time: 999 });

      expect(body.time).toBe(60);
      expect((await playerState()).currentTime).toBe(60);
    });

    it('clamps a negative seek to the start', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Song', 60]);
      await request('POST', `/playlist/select/${item.id}`);
      vi.advanceTimersByTime(5000);

      const { body } = await request('POST', '/player/seek', { time: -10 });

      expect(body.time).toBe(0);
    });

    it('broadcasts the new position after a seek', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Song', 60]);
      await request('POST', `/playlist/select/${item.id}`);
      const client: SseClient = await connectSse();
      await client.drain();

      await request('POST', '/player/seek', { time: 42 });

      const event: SseEvent = await client.waitFor('playback:time');
      expect(event.data).toEqual({ currentTime: 42, duration: 60 });
    });

    it('resumes from a position seeked while paused', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Song', 60]);
      await request('POST', `/playlist/select/${item.id}`);
      await request('POST', '/player/pause');
      await request('POST', '/player/seek', { time: 20 });

      await request('POST', '/player/play');
      vi.advanceTimersByTime(1000);

      expect((await playerState()).currentTime).toBe(21);
    });

    it('starts from a position seeked while stopped, once only', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Song', 60]);
      await request('POST', `/playlist/select/${item.id}`);
      await request('POST', '/player/stop');
      await request('POST', '/player/seek', { time: 15 });

      await request('POST', '/player/play');
      const afterSeekedPlay: PlayerStateBody = await playerState();
      await request('POST', '/player/started');
      vi.advanceTimersByTime(1000);
      const afterStart: PlayerStateBody = await playerState();
      await request('POST', '/player/stop');
      await request('POST', '/player/play');

      expect(afterSeekedPlay.currentTime).toBe(15);
      expect(afterStart.currentTime).toBe(16);
      expect((await playerState()).currentTime).toBe(0);
    });

    it('ignores a clock sync that arrives just after a track starts', async () => {
      // The outlet may still be reporting the previous track's position.
      const [item]: PlaylistItem[] = await addTracks(['Song', 60]);
      await request('POST', `/playlist/select/${item.id}`);
      vi.advanceTimersByTime(1000);

      const { status, body } = await request('POST', '/player/sync', { time: 45 });

      expect(status).toBe(200);
      expect(body.time).toBe(1);
      expect((await playerState()).currentTime).toBe(1);
    });

    it('re-anchors the clock to a sync once the track has settled', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Song', 60]);
      await request('POST', `/playlist/select/${item.id}`);
      vi.advanceTimersByTime(5000);

      const { body } = await request('POST', '/player/sync', { time: 3.5 });
      vi.advanceTimersByTime(1000);

      expect(body).toEqual({ success: true, time: 3.5 });
      expect((await playerState()).currentTime).toBe(4.5);
    });

    it('clamps a sync beyond the end of the track to its duration', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Song', 60]);
      await request('POST', `/playlist/select/${item.id}`);
      vi.advanceTimersByTime(5000);

      const { body } = await request('POST', '/player/sync', { time: 500 });

      expect(body.time).toBe(60);
    });

    it('ignores a clock sync while paused', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Song', 60]);
      await request('POST', `/playlist/select/${item.id}`);
      vi.advanceTimersByTime(5000);
      await request('POST', '/player/pause');

      const { body } = await request('POST', '/player/sync', { time: 30 });

      expect(body.time).toBe(5);
    });

    it('advances to the next track when the current one ends', async () => {
      const [first]: PlaylistItem[] = await addTracks(['First', 10], ['Second', 20]);
      await request('POST', `/playlist/select/${first.id}`);

      vi.advanceTimersByTime(10_000);

      const state: PlayerStateBody = await waitForPlayerState((s: PlayerStateBody): boolean => s.currentMedia?.title === 'Second' && s.state === 'playing');
      expect(state.duration).toBe(20);
      expect(state.currentTime).toBe(0);
      expect((await playlistState()).currentIndex).toBe(1);
    });

    it('keeps time for the track it advanced to', async () => {
      const [first]: PlaylistItem[] = await addTracks(['First', 10], ['Second', 20]);
      await request('POST', `/playlist/select/${first.id}`);
      vi.advanceTimersByTime(10_000);
      await waitForPlayerState((s: PlayerStateBody): boolean => s.currentMedia?.title === 'Second' && s.state === 'playing');

      vi.advanceTimersByTime(4000);

      expect((await playerState()).currentTime).toBe(4);
    });

    it('announces the track it advanced to over SSE', async () => {
      const [first]: PlaylistItem[] = await addTracks(['First', 10], ['Second', 20]);
      await request('POST', `/playlist/select/${first.id}`);
      const client: SseClient = await connectSse();
      await client.drain();

      vi.advanceTimersByTime(10_000);

      const loaded: SseEvent = await client.waitFor('playback:loaded');
      const selection: SseEvent = await client.waitFor('playlist:selection');
      expect(loaded.data).toMatchObject({ title: 'Second', duration: 20 });
      expect(selection.data.currentIndex).toBe(1);
    });

    it('shows the seek bar reaching the end before the track changes', async () => {
      const [first]: PlaylistItem[] = await addTracks(['First', 10], ['Second', 20]);
      await request('POST', `/playlist/select/${first.id}`);
      const client: SseClient = await connectSse();
      await client.drain();

      vi.advanceTimersByTime(10_000);

      await client.waitFor('playback:loaded');
      const names: string[] = client.names();
      const finalPosition: number = client.events.findIndex((e: SseEvent): boolean => e.event === 'playback:time' && e.data.currentTime === 10);
      expect(finalPosition).toBeGreaterThanOrEqual(0);
      expect(finalPosition).toBeLessThan(names.indexOf('playback:loaded'));
    });

    it('stops and reselects the first track when the last one ends', async () => {
      const [, second]: PlaylistItem[] = await addTracks(['First', 10], ['Second', 20]);
      await request('POST', `/playlist/select/${second.id}`);

      vi.advanceTimersByTime(20_000);

      const state: PlayerStateBody = await waitForPlayerState((s: PlayerStateBody): boolean => s.state === 'stopped');
      expect(state.currentTime).toBe(0);
      expect((await playlistState()).currentIndex).toBe(0);
    });

    it('announces the end of the playlist after the stopped state', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Only', 10]);
      await request('POST', `/playlist/select/${item.id}`);
      const client: SseClient = await connectSse();
      await client.drain();

      vi.advanceTimersByTime(10_000);

      await client.waitFor('playback:ended');
      const names: string[] = client.names();
      const stopped: number = client.events.findIndex((e: SseEvent): boolean => e.event === 'playback:state' && e.data.state === 'stopped');
      expect(stopped).toBeGreaterThanOrEqual(0);
      expect(stopped).toBeLessThan(names.indexOf('playlist:selection'));
      expect(names.indexOf('playlist:selection')).toBeLessThan(names.indexOf('playback:ended'));
    });

    it('does not keep counting after the playlist has ended', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Only', 10]);
      await request('POST', `/playlist/select/${item.id}`);
      vi.advanceTimersByTime(10_000);
      await waitForPlayerState((s: PlayerStateBody): boolean => s.state === 'stopped');

      vi.advanceTimersByTime(5000);

      expect((await playerState()).currentTime).toBe(0);
    });

    it('wraps to the first track when the last one ends with repeat on', async () => {
      const [, second]: PlaylistItem[] = await addTracks(['First', 10], ['Second', 20]);
      await request('POST', '/playlist/repeat', { enabled: true });
      await request('POST', `/playlist/select/${second.id}`);

      vi.advanceTimersByTime(20_000);

      const state: PlayerStateBody = await waitForPlayerState((s: PlayerStateBody): boolean => s.currentMedia?.title === 'First' && s.state === 'playing');
      expect(state.duration).toBe(10);
      expect((await playlistState()).currentIndex).toBe(0);
    });

    it('replays a single track when it ends with repeat on', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Only', 10]);
      await request('POST', '/playlist/repeat', { enabled: true });
      await request('POST', `/playlist/select/${item.id}`);
      vi.advanceTimersByTime(4000);
      const client: SseClient = await connectSse();
      await client.drain();

      vi.advanceTimersByTime(6000);

      await client.waitFor('playback:loaded');
      const state: PlayerStateBody = await waitForPlayerState((s: PlayerStateBody): boolean => s.state === 'playing');
      expect(state.currentTime).toBe(0);
      expect(state.currentMedia?.title).toBe('Only');
    });

    it('plays every track exactly once before stopping with shuffle on', async () => {
      const client: SseClient = await connectSse();
      const [first]: PlaylistItem[] = await addTracks(['A', 10], ['B', 10], ['C', 10], ['D', 10]);
      await request('POST', '/playlist/shuffle', { enabled: true });
      await request('POST', `/playlist/select/${first.id}`);
      const played: string[] = ['A'];

      for (let i: number = 0; i < 3; i++) {
        await client.drain();
        vi.advanceTimersByTime(10_000);
        const loaded: SseEvent = await client.waitFor('playback:loaded');
        await waitForPlayerState((s: PlayerStateBody): boolean => s.state === 'playing' && s.currentMedia?.title === loaded.data.title);
        played.push(loaded.data.title as string);
      }
      vi.advanceTimersByTime(10_000);
      const state: PlayerStateBody = await waitForPlayerState((s: PlayerStateBody): boolean => s.state === 'stopped');

      expect([...played].sort()).toEqual(['A', 'B', 'C', 'D']);
      expect(state.state).toBe('stopped');
    });

    it('never ends a track whose duration is unknown', async () => {
      const [item]: PlaylistItem[] = await addFiles([
        createMedia('stream.mp3', { format: {}, streams: [{ index: 0, codec_type: 'audio', codec_name: 'mp3' }] }),
        createAudio('Next', 10),
      ]);
      await request('POST', `/playlist/select/${item.id}`);

      vi.advanceTimersByTime(30_000);

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('playing');
      expect(state.currentTime).toBe(30);
      expect(state.currentMedia?.title).toBe('stream');
    });

    it('enters the error state when the next track cannot be loaded at track end', async () => {
      const second: string = createAudio('Second', 20);
      const [first]: PlaylistItem[] = await addFiles([createAudio('First', 10), second]);
      await request('POST', `/playlist/select/${first.id}`);
      probeScripts.set(second, { kind: 'exit', code: 1, stderr: 'disk removed' });
      touch(second);

      vi.advanceTimersByTime(10_000);

      const state: PlayerStateBody = await waitForPlayerState((s: PlayerStateBody): boolean => s.state === 'error');
      expect(state.errorMessage).toBe('ffprobe failed: disk removed');
    });

    it('holds the position once a manual skip has failed to load the next track', async () => {
      const second: string = createAudio('Second', 20);
      const [first]: PlaylistItem[] = await addFiles([createAudio('First', 10), second]);
      await request('POST', `/playlist/select/${first.id}`);
      vi.advanceTimersByTime(2000);
      probeScripts.set(second, { kind: 'exit', code: 1, stderr: 'disk removed' });
      touch(second);
      await request('POST', '/playlist/next');

      vi.advanceTimersByTime(30_000);

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('error');
      expect(state.currentTime).toBe(2);
    });

    it('stops the clock when a track selected mid-playback cannot be loaded', async () => {
      const second: string = createAudio('Second', 20);
      const [first, broken]: PlaylistItem[] = await addFiles([createAudio('First', 10), second]);
      await request('POST', `/playlist/select/${first.id}`);
      probeScripts.set(second, { kind: 'exit', code: 1, stderr: 'disk removed' });
      touch(second);

      await request('POST', `/playlist/select/${broken.id}`);

      expect(vi.getTimerCount()).toBe(0);
    });

    it('stops the clock when a manual skip cannot load the next track', async () => {
      const second: string = createAudio('Second', 20);
      const [first]: PlaylistItem[] = await addFiles([createAudio('First', 10), second]);
      await request('POST', `/playlist/select/${first.id}`);
      probeScripts.set(second, { kind: 'exit', code: 1, stderr: 'disk removed' });
      touch(second);

      await request('POST', '/playlist/next');

      expect(vi.getTimerCount()).toBe(0);
    });

    it('stops the clock when stepping back cannot load the previous track', async () => {
      const firstPath: string = createAudio('First', 10);
      const [, second]: PlaylistItem[] = await addFiles([firstPath, createAudio('Second', 20)]);
      await request('POST', `/playlist/select/${second.id}`);
      probeScripts.set(firstPath, { kind: 'exit', code: 1, stderr: 'disk removed' });
      touch(firstPath);

      await request('POST', '/playlist/previous');

      expect(vi.getTimerCount()).toBe(0);
    });

    it('stops the clock when the track taking over from a removed one cannot be loaded', async () => {
      const second: string = createAudio('Second', 20);
      const [first]: PlaylistItem[] = await addFiles([createAudio('First', 10), second]);
      await request('POST', `/playlist/select/${first.id}`);
      probeScripts.set(second, { kind: 'exit', code: 1, stderr: 'disk removed' });
      touch(second);

      await request('DELETE', `/playlist/remove/${first.id}`);

      expect(vi.getTimerCount()).toBe(0);
    });

    it('ignores a clock sync that arrives just after a loaded playlist starts playing', async () => {
      // The outlet may still be reporting the position of what played before.
      const [old]: PlaylistItem[] = await addTracks(['Old', 60]);
      await request('POST', `/playlist/select/${old.id}`);
      vi.advanceTimersByTime(5000);
      const replacement: string = createAudio('New', 60);
      const playlistFile: string = createFile('list.opp', JSON.stringify({
        format: 'onixplayer-playlist',
        version: 1,
        items: [{ filePath: replacement, title: 'New', duration: 60, type: 'audio' }],
      }));
      await request('POST', '/playlist/load', { filePath: playlistFile });
      vi.advanceTimersByTime(1000);

      const { body } = await request('POST', '/player/sync', { time: 45 });

      expect(body.time).toBe(1);
    });

    it('does not carry a position seeked while stopped into a loaded playlist', async () => {
      const [old]: PlaylistItem[] = await addTracks(['Old', 60]);
      await request('POST', `/playlist/select/${old.id}`);
      await request('POST', '/player/stop');
      await request('POST', '/player/seek', { time: 15 });
      const replacement: string = createAudio('New', 60);
      const playlistFile: string = createFile('list.opp', JSON.stringify({
        format: 'onixplayer-playlist',
        version: 1,
        items: [{ filePath: replacement, title: 'New', duration: 60, type: 'audio' }],
      }));
      await request('POST', '/playlist/load', { filePath: playlistFile });

      // Playing again while already playing reloads the track from the stored position.
      await request('POST', '/player/play');

      expect((await playerState()).currentTime).toBe(0);
    });

    it('forgets a position seeked while stopped when the main process clears the playlist', async () => {
      const [old]: PlaylistItem[] = await addTracks(['Old', 60]);
      await request('POST', `/playlist/select/${old.id}`);
      await request('POST', '/player/stop');
      await request('POST', '/player/seek', { time: 15 });
      server.clearPlaylist();
      await addTracks(['New', 60]);

      await request('POST', '/player/play');

      expect((await playerState()).currentTime).toBe(0);
    });

    it('stops the clock when the playlist is cleared mid-playback', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Song', 60]);
      await request('POST', `/playlist/select/${item.id}`);
      vi.advanceTimersByTime(2000);
      await request('DELETE', '/playlist/clear');

      vi.advanceTimersByTime(5000);

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('idle');
      expect(state.currentTime).toBe(0);
      expect(state.duration).toBe(0);
      expect(state.currentMedia).toBeNull();
    });

    it('stops the clock when the main process clears the playlist', async () => {
      const [item]: PlaylistItem[] = await addTracks(['Song', 60]);
      await request('POST', `/playlist/select/${item.id}`);
      vi.advanceTimersByTime(2000);
      server.clearPlaylist();

      vi.advanceTimersByTime(5000);

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('idle');
      expect(state.currentTime).toBe(0);
      expect((await playlistState()).items).toEqual([]);
    });

    it('stops the clock when the server is stopped', async () => {
      const other: UnifiedMediaServer = new UnifiedMediaServer();
      vi.spyOn(other.getDependencyManager(), 'getFfprobePath').mockReturnValue(fakeProbe.binary);
      const port: number = await other.start();
      const headers: Record<string, string> = { 'X-Onix-Token': other.getAuthToken(), 'Content-Type': 'application/json' };
      const filePath: string = createMedia('film.mkv', videoProbe(600));
      await fetch(`http://127.0.0.1:${port}/playlist/add`, { method: 'POST', headers, body: JSON.stringify({ paths: [filePath] }) });
      await fetch(`http://127.0.0.1:${port}/player/play`, { method: 'POST', headers });
      const onPlaying = vi.fn();
      other.onPlaybackStateChange(onPlaying);

      other.stop();
      vi.advanceTimersByTime(700_000);

      // Still running, the clock would have reached the end and changed state.
      expect(onPlaying).not.toHaveBeenCalled();
    }, 30000);
  });

  // ==========================================================================
  // POST /player/seek and /player/volume (no clock needed)
  // ==========================================================================

  describe('POST /player/seek (validation)', () => {
    it('rejects a missing time', async () => {
      const { status, body } = await request('POST', '/player/seek', {});

      expect(status).toBe(400);
      expect(body.error).toBe('Invalid time');
    });
  });

  describe('POST /player/volume', () => {
    it('broadcasts the clamped volume and mute state', async () => {
      const client: SseClient = await connectSse();
      await client.drain();

      const { body } = await request('POST', '/player/volume', { volume: 7, muted: true });

      const event: SseEvent = await client.waitFor('playback:volume');
      expect(body).toEqual({ success: true, volume: 1, muted: true });
      expect(event.data).toEqual({ volume: 1, muted: true });
    });

    it('leaves the volume alone when given values of the wrong type', async () => {
      await request('POST', '/player/volume', { volume: 0.4, muted: true });

      const { body } = await request('POST', '/player/volume', { volume: 'loud', muted: 'yes' });

      expect(body).toEqual({ success: true, volume: 0.4, muted: true });
    });

    it('reports the volume in the player state', async () => {
      await request('POST', '/player/volume', { volume: 0.25, muted: true });

      const state: PlayerStateBody = await playerState();

      expect(state.volume).toBe(0.25);
      expect(state.muted).toBe(true);
    });
  });

  // ==========================================================================
  // POST /playlist/select/:id
  // ==========================================================================

  describe('POST /playlist/select/:id', () => {
    it('selects the item and starts playing it', async () => {
      const [, second]: PlaylistItem[] = await addFiles([createAudio('First', 10), createAudio('Second', 20)]);

      const { status, body } = await request('POST', `/playlist/select/${second.id}`);

      const state: PlayerStateBody = await playerState();
      expect(status).toBe(200);
      expect(body.item).toEqual(second);
      expect(body.media).toMatchObject({ title: 'Second', duration: 20 });
      expect(state.state).toBe('playing');
      expect(state.currentMedia?.title).toBe('Second');
      expect(state.duration).toBe(20);
      expect((await playlistState()).currentIndex).toBe(1);
    });

    it('announces the selection and the loaded media over SSE', async () => {
      const client: SseClient = await connectSse();
      const [, second]: PlaylistItem[] = await addFiles([createAudio('First', 10), createAudio('Second', 20)]);
      await client.drain();

      await request('POST', `/playlist/select/${second.id}`);

      const selection: SseEvent = await client.waitFor('playlist:selection');
      const loaded: SseEvent = await client.waitFor('playback:loaded');
      const playing: SseEvent = await client.waitFor('playback:state', (data: Record<string, unknown>): boolean => data.state === 'playing');
      expect(selection.data).toEqual({ currentIndex: 1, currentItem: second });
      expect(loaded.data).toMatchObject({ title: 'Second' });
      expect(playing.data.errorMessage).toBeNull();
    });

    it('enters the error state when the selected item cannot be loaded', async () => {
      const filePath: string = createAudio('Broken', 10);
      const [item]: PlaylistItem[] = await addFiles([filePath]);
      probeScripts.set(filePath, { kind: 'raw', stdout: 'not json' });
      touch(filePath);

      const { status, body } = await request('POST', `/playlist/select/${item.id}`);

      const state: PlayerStateBody = await playerState();
      expect(status).toBe(500);
      expect(String(body.error)).toContain('Failed to parse ffprobe output');
      expect(state.state).toBe('error');
      expect(state.errorMessage).toBe(body.error);
    });

    it('drops the message of an earlier error once another item plays', async () => {
      const brokenPath: string = createAudio('Broken', 10);
      const [broken, good]: PlaylistItem[] = await addFiles([brokenPath, createAudio('Good', 20)]);
      probeScripts.set(brokenPath, { kind: 'exit', code: 1, stderr: 'bad' });
      touch(brokenPath);
      await request('POST', `/playlist/select/${broken.id}`);

      await request('POST', `/playlist/select/${good.id}`);

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('playing');
      expect(state.errorMessage).toBeNull();
    });

    it('announces playback after an earlier error without the old message', async () => {
      const client: SseClient = await connectSse();
      const brokenPath: string = createAudio('Broken', 10);
      const [broken, good]: PlaylistItem[] = await addFiles([brokenPath, createAudio('Good', 20)]);
      probeScripts.set(brokenPath, { kind: 'exit', code: 1, stderr: 'bad' });
      touch(brokenPath);
      await request('POST', `/playlist/select/${broken.id}`);
      await client.drain();

      await request('POST', `/playlist/select/${good.id}`);

      const playing: SseEvent = await client.waitFor('playback:state', (data: Record<string, unknown>): boolean => data.state === 'playing');
      expect(playing.data.errorMessage).toBeNull();
    });

    it('leaves playback untouched when the item does not exist', async () => {
      const [first]: PlaylistItem[] = await addFiles([createAudio('First', 10)]);
      await request('POST', `/playlist/select/${first.id}`);

      const { status } = await request('POST', '/playlist/select/no-such-id');

      const state: PlayerStateBody = await playerState();
      expect(status).toBe(404);
      expect(state.state).toBe('playing');
      expect(state.currentMedia?.title).toBe('First');
    });
  });

  // ==========================================================================
  // POST /playlist/next and /playlist/previous
  // ==========================================================================

  describe('POST /playlist/next', () => {
    it('advances to and plays the next item', async () => {
      const [, second]: PlaylistItem[] = await addFiles([createAudio('First', 10), createAudio('Second', 20)]);

      const { status, body } = await request('POST', '/playlist/next');

      const state: PlayerStateBody = await playerState();
      expect(status).toBe(200);
      expect(body.item).toEqual(second);
      expect(body.media).toMatchObject({ title: 'Second' });
      expect(state.state).toBe('playing');
      expect(state.currentMedia?.title).toBe('Second');
      expect((await playlistState()).currentIndex).toBe(1);
    });

    it('goes idle and announces the end when there is no next item', async () => {
      const client: SseClient = await connectSse();
      const [item]: PlaylistItem[] = await addFiles([createAudio('Only', 10)]);
      await request('POST', `/playlist/select/${item.id}`);
      await client.drain();

      const { status, body } = await request('POST', '/playlist/next');

      const ended: SseEvent = await client.waitFor('playback:ended');
      const state: PlayerStateBody = await playerState();
      expect(status).toBe(200);
      expect(body).toEqual({ success: true, ended: true });
      expect(ended.data).toEqual({});
      expect(state.state).toBe('idle');
      expect(state.currentTime).toBe(0);
    });

    it('wraps to the first item from the last when repeat is on', async () => {
      const [, second]: PlaylistItem[] = await addFiles([createAudio('First', 10), createAudio('Second', 20)]);
      await request('POST', `/playlist/select/${second.id}`);
      await request('POST', '/playlist/repeat', { enabled: true });

      const { body } = await request('POST', '/playlist/next');

      expect(body.media).toMatchObject({ title: 'First' });
      expect((await playlistState()).currentIndex).toBe(0);
    });

    it('enters the error state when the next item cannot be loaded', async () => {
      const second: string = createAudio('Second', 20);
      await addFiles([createAudio('First', 10), second]);
      probeScripts.set(second, { kind: 'exit', code: 2, stderr: 'unreadable' });
      touch(second);

      const { status, body } = await request('POST', '/playlist/next');

      const state: PlayerStateBody = await playerState();
      expect(status).toBe(500);
      expect(body.error).toBe('ffprobe failed: unreadable');
      expect(state.state).toBe('error');
      expect(state.errorMessage).toBe('ffprobe failed: unreadable');
    });

    it('drops the message of an earlier error once the next item plays', async () => {
      const brokenPath: string = createAudio('Broken', 10);
      const [broken]: PlaylistItem[] = await addFiles([brokenPath, createAudio('Good', 20)]);
      probeScripts.set(brokenPath, { kind: 'exit', code: 1, stderr: 'bad' });
      touch(brokenPath);
      await request('POST', `/playlist/select/${broken.id}`);

      await request('POST', '/playlist/next');

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('playing');
      expect(state.errorMessage).toBeNull();
    });
  });

  describe('POST /playlist/previous', () => {
    it('returns to and plays the item played before', async () => {
      const [first, second]: PlaylistItem[] = await addFiles([createAudio('First', 10), createAudio('Second', 20)]);
      await request('POST', `/playlist/select/${first.id}`);
      await request('POST', `/playlist/select/${second.id}`);

      const { status, body } = await request('POST', '/playlist/previous');

      const state: PlayerStateBody = await playerState();
      expect(status).toBe(200);
      expect(body.item).toEqual(first);
      expect(body.media).toMatchObject({ title: 'First' });
      expect(state.state).toBe('playing');
      expect(state.currentMedia?.title).toBe('First');
      expect((await playlistState()).currentIndex).toBe(0);
    });

    it('reports no previous track at the start of the playlist', async () => {
      await addFiles([createAudio('First', 10), createAudio('Second', 20)]);

      const { status, body } = await request('POST', '/playlist/previous');

      expect(status).toBe(200);
      expect(body).toEqual({ success: false, reason: 'No previous track' });
      expect((await playerState()).state).toBe('idle');
    });

    it('wraps to the last item from the first when repeat is on', async () => {
      await addFiles([createAudio('First', 10), createAudio('Second', 20)]);
      await request('POST', '/playlist/repeat', { enabled: true });

      const { body } = await request('POST', '/playlist/previous');

      expect(body.media).toMatchObject({ title: 'Second' });
      expect((await playlistState()).currentIndex).toBe(1);
    });

    it('enters the error state when the previous item cannot be loaded', async () => {
      const firstPath: string = createAudio('First', 10);
      const [first, second]: PlaylistItem[] = await addFiles([firstPath, createAudio('Second', 20)]);
      await request('POST', `/playlist/select/${first.id}`);
      await request('POST', `/playlist/select/${second.id}`);
      probeScripts.set(firstPath, { kind: 'exit', code: 1, stderr: 'gone' });
      touch(firstPath);

      const { status, body } = await request('POST', '/playlist/previous');

      const state: PlayerStateBody = await playerState();
      expect(status).toBe(500);
      expect(body.error).toBe('ffprobe failed: gone');
      expect(state.state).toBe('error');
    });

    it('drops the message of an earlier error once the previous item plays', async () => {
      const brokenPath: string = createAudio('Broken', 10);
      const [, broken]: PlaylistItem[] = await addFiles([createAudio('Good', 20), brokenPath]);
      probeScripts.set(brokenPath, { kind: 'exit', code: 1, stderr: 'bad' });
      touch(brokenPath);
      await request('POST', `/playlist/select/${broken.id}`);

      await request('POST', '/playlist/previous');

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('playing');
      expect(state.errorMessage).toBeNull();
    });
  });

  // ==========================================================================
  // POST /playlist/shuffle and /playlist/repeat
  // ==========================================================================

  describe('playlist modes', () => {
    it('announces a shuffle change over SSE', async () => {
      const client: SseClient = await connectSse();
      await client.drain();

      const { body } = await request('POST', '/playlist/shuffle', { enabled: true });

      const event: SseEvent = await client.waitFor('playlist:mode');
      expect(body).toEqual({ success: true, shuffleEnabled: true });
      expect(event.data).toEqual({ shuffleEnabled: true, repeatEnabled: false });
    });

    it('announces a repeat change over SSE', async () => {
      const client: SseClient = await connectSse();
      await client.drain();

      const { body } = await request('POST', '/playlist/repeat', { enabled: true });

      const event: SseEvent = await client.waitFor('playlist:mode');
      expect(body).toEqual({ success: true, repeatEnabled: true });
      expect(event.data).toEqual({ shuffleEnabled: false, repeatEnabled: true });
    });

    it('treats a missing enabled flag as turning shuffle off', async () => {
      await request('POST', '/playlist/shuffle', { enabled: true });

      await request('POST', '/playlist/shuffle', {});

      expect((await playlistState()).shuffleEnabled).toBe(false);
    });

    it('keeps the current track selected when shuffle is turned on', async () => {
      const [, , third]: PlaylistItem[] = await addFiles([createAudio('A', 10), createAudio('B', 10), createAudio('C', 10)]);
      await request('POST', `/playlist/select/${third.id}`);

      await request('POST', '/playlist/shuffle', { enabled: true });

      const state: PlayerStateBody = await playerState();
      expect((await playlistState()).currentIndex).toBe(2);
      expect(state.currentMedia?.title).toBe('C');
      expect(state.state).toBe('playing');
    });

    it('visits every other track once when stepping forward with shuffle on', async () => {
      const [first]: PlaylistItem[] = await addFiles([createAudio('A', 10), createAudio('B', 10), createAudio('C', 10)]);
      await request('POST', `/playlist/select/${first.id}`);
      await request('POST', '/playlist/shuffle', { enabled: true });

      const second: JsonResponse = await request('POST', '/playlist/next');
      const third: JsonResponse = await request('POST', '/playlist/next');
      const end: JsonResponse = await request('POST', '/playlist/next');

      const titles: string[] = [second, third].map((res: JsonResponse): string => (res.body.media as MediaInfo).title);
      expect(titles.sort()).toEqual(['B', 'C']);
      expect(end.body.ended).toBe(true);
    });
  });

  // ==========================================================================
  // DELETE /playlist/remove/:id
  // ==========================================================================

  describe('DELETE /playlist/remove/:id', () => {
    it('removes an item that is not playing without disturbing playback', async () => {
      const [first, second]: PlaylistItem[] = await addFiles([createAudio('First', 10), createAudio('Second', 20)]);
      await request('POST', `/playlist/select/${first.id}`);

      const { status, body } = await request('DELETE', `/playlist/remove/${second.id}`);

      const state: PlayerStateBody = await playerState();
      const playlist: PlaylistBody = await playlistState();
      expect(status).toBe(200);
      expect(body).toEqual({ success: true });
      expect(playlist.items).toEqual([first]);
      expect(state.state).toBe('playing');
      expect(state.currentMedia?.title).toBe('First');
    });

    it('keeps the playing item selected when an earlier item is removed', async () => {
      const [first, second]: PlaylistItem[] = await addFiles([createAudio('First', 10), createAudio('Second', 20)]);
      await request('POST', `/playlist/select/${second.id}`);

      await request('DELETE', `/playlist/remove/${first.id}`);

      const playlist: PlaylistBody = await playlistState();
      expect(playlist.currentIndex).toBe(0);
      expect(playlist.items[0].title).toBe('Second');
      expect((await playerState()).currentMedia?.title).toBe('Second');
    });

    it('plays the following item when the playing item is removed', async () => {
      const [first]: PlaylistItem[] = await addFiles([createAudio('First', 10), createAudio('Second', 20), createAudio('Third', 30)]);
      await request('POST', `/playlist/select/${first.id}`);

      await request('DELETE', `/playlist/remove/${first.id}`);

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('playing');
      expect(state.currentMedia?.title).toBe('Second');
      expect(state.duration).toBe(20);
      expect(state.currentTime).toBe(0);
      expect((await playlistState()).currentIndex).toBe(0);
    });

    it('plays the following item when the paused item is removed', async () => {
      const [first]: PlaylistItem[] = await addFiles([createMedia('film.mkv', videoProbe(600)), createAudio('Second', 20)]);
      await request('POST', `/playlist/select/${first.id}`);
      await request('POST', '/player/pause');

      await request('DELETE', `/playlist/remove/${first.id}`);

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('playing');
      expect(state.currentMedia?.title).toBe('Second');
    });

    it('plays the new last item when the playing last item is removed', async () => {
      const [, , third]: PlaylistItem[] = await addFiles([createAudio('First', 10), createAudio('Second', 20), createAudio('Third', 30)]);
      await request('POST', `/playlist/select/${third.id}`);

      await request('DELETE', `/playlist/remove/${third.id}`);

      expect((await playerState()).currentMedia?.title).toBe('Second');
      expect((await playlistState()).currentIndex).toBe(1);
    });

    it('wraps to the first item when the playing last item is removed with repeat on', async () => {
      const [, , third]: PlaylistItem[] = await addFiles([createAudio('First', 10), createAudio('Second', 20), createAudio('Third', 30)]);
      await request('POST', '/playlist/repeat', { enabled: true });
      await request('POST', `/playlist/select/${third.id}`);

      await request('DELETE', `/playlist/remove/${third.id}`);

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('playing');
      expect(state.currentMedia?.title).toBe('First');
      expect((await playlistState()).currentIndex).toBe(0);
    });

    it('goes idle when the only item is removed while playing', async () => {
      const [only]: PlaylistItem[] = await addFiles([createAudio('Only', 10)]);
      await request('POST', `/playlist/select/${only.id}`);

      await request('DELETE', `/playlist/remove/${only.id}`);

      const state: PlayerStateBody = await playerState();
      const playlist: PlaylistBody = await playlistState();
      expect(state.state).toBe('idle');
      expect(state.currentMedia).toBeNull();
      expect(state.duration).toBe(0);
      expect(playlist.items).toEqual([]);
      expect(playlist.currentIndex).toBe(-1);
    });

    it('does not start playback when the selected item is removed while stopped', async () => {
      const [first]: PlaylistItem[] = await addFiles([createAudio('First', 10), createAudio('Second', 20)]);

      await request('DELETE', `/playlist/remove/${first.id}`);

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('idle');
      expect(state.currentMedia).toBeNull();
      expect((await playlistState()).items.map((item: PlaylistItem): string => item.title)).toEqual(['Second']);
    });

    it('enters the error state when the item that takes over cannot be loaded', async () => {
      const secondPath: string = createAudio('Second', 20);
      const [first]: PlaylistItem[] = await addFiles([createAudio('First', 10), secondPath]);
      await request('POST', `/playlist/select/${first.id}`);
      probeScripts.set(secondPath, { kind: 'exit', code: 1, stderr: 'missing' });
      touch(secondPath);

      const { status } = await request('DELETE', `/playlist/remove/${first.id}`);

      const state: PlayerStateBody = await playerState();
      expect(status).toBe(200);
      expect(state.state).toBe('error');
      expect(state.errorMessage).toBe('ffprobe failed: missing');
    });

    it('announces the removal over SSE and reports the new count', async () => {
      const client: SseClient = await connectSse();
      const onCount = vi.fn();
      const [first, second]: PlaylistItem[] = await addFiles([createAudio('First', 10), createAudio('Second', 20)]);
      server.onPlaylistCountChange(onCount);
      await client.drain();

      await request('DELETE', `/playlist/remove/${second.id}`);

      const removed: SseEvent = await client.waitFor('playlist:items:removed');
      expect(removed.data).toEqual({ id: second.id, removedIndex: 1, currentIndex: 0 });
      expect(onCount).toHaveBeenCalledWith(1);
      expect((await playlistState()).items).toEqual([first]);
    });

    it('does not report a count change when the item does not exist', async () => {
      const onCount = vi.fn();
      await addFiles([createAudio('First', 10)]);
      server.onPlaylistCountChange(onCount);

      const { status, body } = await request('DELETE', '/playlist/remove/no-such-id');

      expect(status).toBe(404);
      expect(body).toEqual({ success: false });
      expect(onCount).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // DELETE /playlist/clear
  // ==========================================================================

  describe('DELETE /playlist/clear', () => {
    it('empties the playlist and unloads the playing media', async () => {
      const [item]: PlaylistItem[] = await addFiles([createAudio('Song', 10)]);
      await request('POST', `/playlist/select/${item.id}`);

      const { status } = await request('DELETE', '/playlist/clear');

      const state: PlayerStateBody = await playerState();
      expect(status).toBe(200);
      expect(state.state).toBe('idle');
      expect(state.currentMedia).toBeNull();
      expect(state.duration).toBe(0);
      expect((await playlistState()).items).toEqual([]);
    });

    it('announces the cleared playlist and the idle state over SSE', async () => {
      const client: SseClient = await connectSse();
      const [item]: PlaylistItem[] = await addFiles([createAudio('Song', 10)]);
      await request('POST', `/playlist/select/${item.id}`);
      await client.drain();

      await request('DELETE', '/playlist/clear');

      const cleared: SseEvent = await client.waitFor('playlist:cleared');
      const idle: SseEvent = await client.waitFor('playback:state');
      expect(cleared.data).toEqual({});
      expect(idle.data.state).toBe('idle');
    });

    it('drops the message of an earlier error', async () => {
      const filePath: string = createAudio('Broken', 10);
      const [item]: PlaylistItem[] = await addFiles([filePath]);
      probeScripts.set(filePath, { kind: 'exit', code: 1, stderr: 'bad' });
      touch(filePath);
      await request('POST', `/playlist/select/${item.id}`);

      await request('DELETE', '/playlist/clear');

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('idle');
      expect(state.errorMessage).toBeNull();
    });

    it('cannot be played afterwards because nothing is selected', async () => {
      await addFiles([createAudio('Song', 10)]);
      await request('DELETE', '/playlist/clear');

      const { status, body } = await request('POST', '/player/play');

      expect(status).toBe(400);
      expect(body.error).toBe('No track selected');
    });
  });

  // ==========================================================================
  // clearPlaylist (public method used by main.ts)
  // ==========================================================================

  describe('clearPlaylist', () => {
    it('unloads playing media and clears a previous error', async () => {
      const filePath: string = createAudio('Broken', 10);
      const [item]: PlaylistItem[] = await addFiles([filePath]);
      probeScripts.set(filePath, { kind: 'exit', code: 1, stderr: 'bad' });
      touch(filePath);
      await request('POST', `/playlist/select/${item.id}`);

      server.clearPlaylist();

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('idle');
      expect(state.errorMessage).toBeNull();
      expect((await playlistState()).currentIndex).toBe(-1);
    });

    it('broadcasts the idle state and a zeroed position', async () => {
      const [item]: PlaylistItem[] = await addFiles([createAudio('Song', 10)]);
      await request('POST', `/playlist/select/${item.id}`);
      const client: SseClient = await connectSse();
      const onPlaying = vi.fn();
      server.onPlaybackStateChange(onPlaying);
      await client.drain();

      server.clearPlaylist();

      const state: SseEvent = await client.waitFor('playback:state');
      const time: SseEvent = await client.waitFor('playback:time');
      expect(state.data).toEqual({ state: 'idle', errorMessage: null });
      expect(time.data).toEqual({ currentTime: 0, duration: 0 });
      expect(onPlaying).toHaveBeenLastCalledWith(false);
    });
  });

  // ==========================================================================
  // POST /playlist/save
  // ==========================================================================

  describe('POST /playlist/save', () => {
    interface SavedPlaylist {
      readonly format: string;
      readonly version: number;
      readonly savedAt: string;
      readonly items: ReadonlyArray<Record<string, unknown>>;
    }

    it('writes the playlist items to the .opp file', async () => {
      const audio: string = createMedia('song.mp3', audioProbe(180, { title: 'Song', artist: 'Band', album: 'Record' }));
      const video: string = createMedia('clip.mkv', videoProbe(60));
      await addFiles([audio, video]);
      const target: string = path.join(path.dirname(createFile('placeholder.txt')), 'saved.opp');

      const { status, body } = await request('POST', '/playlist/save', { filePath: target });

      const saved: SavedPlaylist = JSON.parse(fs.readFileSync(target, 'utf-8')) as SavedPlaylist;
      expect(status).toBe(200);
      expect(body).toEqual({ success: true, filePath: target });
      expect(saved.format).toBe('onixplayer-playlist');
      expect(saved.version).toBe(1);
      expect(Number.isNaN(Date.parse(saved.savedAt))).toBe(false);
      expect(saved.items).toEqual([
        { filePath: audio, title: 'Song', artist: 'Band', album: 'Record', duration: 180, type: 'audio' },
        { filePath: video, title: 'clip', duration: 60, type: 'video', width: 1920, height: 1080 },
      ]);
    });

    it('appends .opp when the chosen name has no extension', async () => {
      await addFiles([createAudio('Song', 10)]);
      const bare: string = path.join(path.dirname(createFile('placeholder.txt')), 'my-playlist');

      const { status, body } = await request('POST', '/playlist/save', { filePath: bare });

      expect(status).toBe(200);
      expect(body.filePath).toBe(`${bare}.opp`);
      expect(fs.existsSync(`${bare}.opp`)).toBe(true);
      expect(fs.existsSync(bare)).toBe(false);
    });

    it('remembers the saved file as the playlist source', async () => {
      await addFiles([createAudio('Song', 10)]);
      const target: string = path.join(path.dirname(createFile('placeholder.txt')), 'source.opp');

      await request('POST', '/playlist/save', { filePath: target });

      expect((await request('GET', '/playlist/source')).body.filePath).toBe(target);
    });

    it('reports a write failure without recording a source file', async () => {
      await addFiles([createAudio('Song', 10)]);
      const target: string = path.join(mediaDir, 'no-such-directory', 'saved.opp');

      const { status, body } = await request('POST', '/playlist/save', { filePath: target });

      expect(status).toBe(500);
      expect(String(body.error)).toContain('ENOENT');
      expect((await request('GET', '/playlist/source')).body.filePath).toBeNull();
    });

    it('rejects a save with no file path', async () => {
      await addFiles([createAudio('Song', 10)]);

      const { status, body } = await request('POST', '/playlist/save', {});

      expect(status).toBe(400);
      expect(body.error).toBe('Missing filePath');
    });
  });

  // ==========================================================================
  // POST /playlist/load
  // ==========================================================================

  describe('POST /playlist/load', () => {
    /** Writes a .opp playlist referencing the given entries. */
    function writePlaylist(items: ReadonlyArray<Record<string, unknown>>): string {
      return createFile('list.opp', JSON.stringify({ format: 'onixplayer-playlist', version: 1, items }));
    }

    it('selects and plays the first item of the loaded playlist', async () => {
      const first: string = createAudio('Opening', 30);
      const second: string = createAudio('Closing', 40);
      const playlistFile: string = writePlaylist([
        { filePath: first, title: 'Opening', duration: 30, type: 'audio' },
        { filePath: second, title: 'Closing', duration: 40, type: 'audio' },
      ]);

      const { status, body } = await request('POST', '/playlist/load', { filePath: playlistFile });

      const state: PlayerStateBody = await playerState();
      const playlist: PlaylistBody = await playlistState();
      expect(status).toBe(200);
      expect(body).toEqual({ success: true, count: 2, filePath: playlistFile });
      expect(playlist.items.map((item: PlaylistItem): string => item.title)).toEqual(['Opening', 'Closing']);
      expect(playlist.currentIndex).toBe(0);
      expect(state.state).toBe('playing');
      expect(state.currentMedia).toMatchObject({ title: 'Opening', filePath: first });
      expect(state.duration).toBe(30);
    });

    it('probes only the item it starts playing', async () => {
      const first: string = createAudio('Opening', 30);
      const second: string = createAudio('Closing', 40);
      const playlistFile: string = writePlaylist([
        { filePath: first, title: 'Opening', duration: 30, type: 'audio' },
        { filePath: second, title: 'Closing', duration: 40, type: 'audio' },
      ]);

      await request('POST', '/playlist/load', { filePath: playlistFile });

      expect(probedPaths).toEqual([first]);
    });

    it('replaces whatever was playing before', async () => {
      const [old]: PlaylistItem[] = await addFiles([createAudio('Old', 10)]);
      await request('POST', `/playlist/select/${old.id}`);
      const replacement: string = createAudio('New', 30);
      const playlistFile: string = writePlaylist([{ filePath: replacement, title: 'New', duration: 30, type: 'audio' }]);

      await request('POST', '/playlist/load', { filePath: playlistFile });

      const playlist: PlaylistBody = await playlistState();
      expect(playlist.items.map((item: PlaylistItem): string => item.title)).toEqual(['New']);
      expect((await playerState()).currentMedia?.title).toBe('New');
    });

    it('stops playback when an empty playlist is loaded', async () => {
      const [old]: PlaylistItem[] = await addFiles([createAudio('Old', 10)]);
      await request('POST', `/playlist/select/${old.id}`);

      await request('POST', '/playlist/load', { filePath: writePlaylist([]) });

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('idle');
      expect(state.currentMedia).toBeNull();
      expect(state.duration).toBe(0);
    });

    it('announces the cleared list, the new items and the loaded media over SSE', async () => {
      const client: SseClient = await connectSse();
      const first: string = createAudio('Opening', 30);
      const playlistFile: string = writePlaylist([{ filePath: first, title: 'Opening', duration: 30, type: 'audio' }]);
      await client.drain();

      await request('POST', '/playlist/load', { filePath: playlistFile });

      const loaded: SseEvent = await client.waitFor('playback:loaded');
      await client.waitFor('playback:state', (data: Record<string, unknown>): boolean => data.state === 'playing');
      const names: string[] = client.names();
      expect(loaded.data).toMatchObject({ title: 'Opening', duration: 30 });
      expect(names.indexOf('playlist:cleared')).toBeGreaterThanOrEqual(0);
      expect(names.indexOf('playlist:cleared')).toBeLessThan(names.indexOf('playlist:items:added'));
      expect(names.indexOf('playlist:items:added')).toBeLessThan(names.indexOf('playback:loaded'));
    });

    it('reports the loaded count and the recent playlist to the main process', async () => {
      const onCount = vi.fn();
      const onRecent = vi.fn();
      server.onPlaylistCountChange(onCount);
      server.onRecentItemsChange(onRecent);
      const first: string = createAudio('Opening', 30);
      const playlistFile: string = writePlaylist([{ filePath: first, title: 'Opening', duration: 30, type: 'audio' }]);

      await request('POST', '/playlist/load', { filePath: playlistFile });

      const recentPlaylists: readonly RecentItem[] = onRecent.mock.calls[0][1] as readonly RecentItem[];
      expect(onCount).toHaveBeenCalledWith(1);
      expect(recentPlaylists[0].path).toBe(playlistFile);
    });

    it('reports a failure when the first item can no longer be probed', async () => {
      const missing: string = path.join(mediaDir, 'never-existed.mp3');
      const playlistFile: string = writePlaylist([{ filePath: missing, title: 'Missing', duration: 30, type: 'audio' }]);

      const { status, body } = await request('POST', '/playlist/load', { filePath: playlistFile });

      expect(status).toBe(500);
      expect(String(body.error)).toContain('ffprobe failed');
      expect((await playerState()).state).not.toBe('playing');
    });

    it('enters the error state with the probe message when the first item cannot be loaded', async () => {
      const missing: string = path.join(mediaDir, 'never-existed.mp3');
      const playlistFile: string = writePlaylist([{ filePath: missing, title: 'Missing', duration: 30, type: 'audio' }]);

      const { body } = await request('POST', '/playlist/load', { filePath: playlistFile });

      const state: PlayerStateBody = await playerState();
      expect(state.state).toBe('error');
      expect(state.errorMessage).toBe(body.error);
    });

    it('leaves playback alone when the playlist file itself cannot be parsed', async () => {
      const [item]: PlaylistItem[] = await addFiles([createAudio('Song', 10)]);
      await request('POST', `/playlist/select/${item.id}`);
      const playlistFile: string = createFile('broken.opp', '{ not json');

      const { status } = await request('POST', '/playlist/load', { filePath: playlistFile });

      const state: PlayerStateBody = await playerState();
      expect(status).toBe(500);
      expect(state.state).toBe('playing');
      expect(state.errorMessage).toBeNull();
    });

    it('restores a playlist that was saved from the server', async () => {
      const audio: string = createMedia('song.mp3', audioProbe(180, { title: 'Song', artist: 'Band' }));
      const video: string = createMedia('clip.mkv', videoProbe(60));
      await addFiles([audio, video]);
      const target: string = path.join(path.dirname(createFile('placeholder.txt')), 'roundtrip.opp');
      await request('POST', '/playlist/save', { filePath: target });
      await request('DELETE', '/playlist/clear');

      const { body } = await request('POST', '/playlist/load', { filePath: target });

      const playlist: PlaylistBody = await playlistState();
      expect(body.count).toBe(2);
      expect(playlist.items).toEqual([
        { id: expect.any(String), filePath: audio, title: 'Song', artist: 'Band', duration: 180, type: 'audio' },
        { id: expect.any(String), filePath: video, title: 'clip', duration: 60, type: 'video', width: 1920, height: 1080 },
      ]);
    });
  });

  // ==========================================================================
  // GET /events — initial synchronisation
  // ==========================================================================

  describe('GET /events (initial state)', () => {
    it('sends the loaded media to a client that connects mid-playback', async () => {
      const [item]: PlaylistItem[] = await addFiles([createAudio('Already Playing', 50)]);
      await request('POST', `/playlist/select/${item.id}`);

      const client: SseClient = await connectSse();

      const loaded: SseEvent = await client.waitFor('playback:loaded');
      const state: SseEvent = await client.waitFor('playback:state');
      const playlist: SseEvent = await client.waitFor('playlist:updated');
      expect(loaded.data).toMatchObject({ title: 'Already Playing', duration: 50 });
      expect(state.data.state).toBe('playing');
      expect(playlist.data).toMatchObject({ currentIndex: 0, items: [item] });
    });

    it('does not send loaded media to a client that connects while idle', async () => {
      const client: SseClient = await connectSse();
      const filePath: string = createAudio('Later', 10);

      // The add is announced after the initial burst, so by the time it
      // arrives any initial playback:loaded would already have been received.
      await addFiles([filePath]);
      await client.waitFor('playlist:items:added');

      expect(client.names()).not.toContain('playback:loaded');
    });
  });
});

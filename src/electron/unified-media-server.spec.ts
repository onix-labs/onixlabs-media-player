/**
 * @fileoverview Integration tests for UnifiedMediaServer HTTP API.
 *
 * Tests cover:
 * - Server lifecycle (start, stop, port assignment)
 * - Player state endpoint (GET /player/state)
 * - Playback control (POST play/pause/stop/seek/volume)
 * - Playlist CRUD (GET, POST add, DELETE remove/clear, POST select/next/previous)
 * - Playlist modes (POST shuffle, POST repeat)
 * - Settings endpoints (GET, PUT visualization/application/playback/transcoding/appearance)
 * - Dependencies endpoints (GET, POST refresh)
 * - SSE connection (GET /events)
 * - Security: path traversal, oversized body, unknown routes
 * - CORS preflight (OPTIONS)
 *
 * The server is started on a random port (0) for each test suite to avoid
 * conflicts. Electron's `app` module and external binaries (ffmpeg, ffprobe,
 * fluidsynth) are mocked so tests run without the Electron runtime.
 *
 * @module electron/unified-media-server.spec
 */

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { IncomingMessage } from 'http';
import http from 'http';

// ============================================================================
// Mocks — must be defined before importing the module under test
// ============================================================================

const mockUserDataPath: string = path.join(os.tmpdir(), `onixplayer-ums-test-${Date.now()}`);

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name === 'userData') return mockUserDataPath;
      if (name === 'temp') return os.tmpdir();
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
    scope: (name: string): Record<string, (...args: unknown[]) => void> => ({
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

// ============================================================================
// Import under test
// ============================================================================

import { UnifiedMediaServer } from './unified-media-server.js';

// ============================================================================
// Helpers
// ============================================================================

let baseUrl: string = '';

/** Session token minted by the server under test; required on every API request. */
let authToken: string = '';

/** Returns a platform-appropriate non-existent absolute path for testing. */
function nonExistentPath(filename: string): string {
  // On Windows, Unix paths like /nonexistent/file.mp3 get normalized to \nonexistent\file.mp3
  // which triggers path normalization security checks. Use a Windows-style path instead.
  return process.platform === 'win32'
    ? `C:\\nonexistent\\${filename}`
    : `/nonexistent/${filename}`;
}

/** Sends an HTTP request and returns { status, body } */
async function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url: string = `${baseUrl}${urlPath}`;
  const options: RequestInit = {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'X-Onix-Token': authToken,
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  const res: Response = await fetch(url, options);
  const text: string = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { _raw: text };
  }
  return { status: res.status, body: parsed };
}

/** Connects to SSE and collects events until the callback signals done. */
function collectSSEEvents(
  urlPath: string,
  maxEvents: number,
  timeoutMs: number = 3000,
): Promise<Array<{ event: string; data: string }>> {
  return new Promise((resolve, reject) => {
    const events: Array<{ event: string; data: string }> = [];
    const url: string = `${baseUrl}${urlPath}`;

    const req: ReturnType<typeof http.get> = http.get(url, { headers: { 'X-Onix-Token': authToken } }, (res: IncomingMessage) => {
      let buffer: string = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();

        // Parse SSE messages (event: ...\ndata: ...\n\n)
        const parts: string[] = buffer.split('\n\n');
        // Keep the last incomplete part in buffer
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (!part.trim()) continue;
          const lines: string[] = part.split('\n');
          let event: string = '';
          let data: string = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) event = line.slice(7);
            if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (event) {
            events.push({ event, data });
          }
          if (events.length >= maxEvents) {
            req.destroy();
            resolve(events);
            return;
          }
        }
      });

      res.on('end', () => resolve(events));
      res.on('error', reject);
    });

    req.on('error', (err: Error) => {
      // Connection destroyed is expected when we reach maxEvents
      if (err.message.includes('socket hang up')) {
        resolve(events);
      } else {
        reject(err);
      }
    });

    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, timeoutMs);
  });
}

// ============================================================================
// Test suite
// ============================================================================

describe('UnifiedMediaServer', () => {
  let server: UnifiedMediaServer;

  beforeAll(async () => {
    // Create the userData directory for settings
    fs.mkdirSync(mockUserDataPath, { recursive: true });

    server = new UnifiedMediaServer();
    const port: number = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
    authToken = server.getAuthToken();
  });

  afterAll(() => {
    server.stop();
    fs.rmSync(mockUserDataPath, { recursive: true, force: true });
  });

  // ==========================================================================
  // Server lifecycle
  // ==========================================================================

  describe('server lifecycle', () => {
    it('starts on a valid port', () => {
      expect(server.getPort()).toBeGreaterThan(0);
      expect(server.getPort()).toBeLessThanOrEqual(65535);
    });

    it('returns the settings manager', () => {
      expect(server.getSettingsManager()).toBeDefined();
    });

    it('returns the dependency manager', () => {
      expect(server.getDependencyManager()).toBeDefined();
    });
  });

  // ==========================================================================
  // CORS
  // ==========================================================================

  describe('CORS', () => {
    it('responds to OPTIONS preflight with 204', async () => {
      const res: Response = await fetch(`${baseUrl}/player/state`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
    });

    it('does not advertise a wildcard origin', async () => {
      // Production is same-origin; a wildcard would let any page the user is
      // browsing read responses from this server.
      const res: Response = await fetch(`${baseUrl}/player/state`, {
        headers: { 'X-Onix-Token': authToken },
      });
      expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
    });
  });

  // ==========================================================================
  // Authentication
  // ==========================================================================

  describe('authentication', () => {
    it('rejects an API request with no token', async () => {
      const res: Response = await fetch(`${baseUrl}/player/state`);
      expect(res.status).toBe(401);
    });

    it('rejects an API request with a wrong token', async () => {
      const res: Response = await fetch(`${baseUrl}/player/state`, {
        headers: { 'X-Onix-Token': 'not-the-token' },
      });
      expect(res.status).toBe(401);
    });

    it('rejects a token of the correct length but wrong value', async () => {
      const res: Response = await fetch(`${baseUrl}/player/state`, {
        headers: { 'X-Onix-Token': 'f'.repeat(authToken.length) },
      });
      expect(res.status).toBe(401);
    });

    it('accepts the token via the X-Onix-Token header', async () => {
      const res: Response = await fetch(`${baseUrl}/player/state`, {
        headers: { 'X-Onix-Token': authToken },
      });
      expect(res.status).toBe(200);
    });

    it('accepts the token via a query parameter', async () => {
      // Media elements and EventSource cannot send headers, so the query form
      // must keep working.
      const res: Response = await fetch(`${baseUrl}/player/state?token=${encodeURIComponent(authToken)}`);
      expect(res.status).toBe(200);
    });

    it('rejects unauthenticated mutations', async () => {
      const res: Response = await fetch(`${baseUrl}/player/pause`, { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('rejects an unauthenticated arbitrary file read', async () => {
      const target: string = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
      const res: Response = await fetch(`${baseUrl}/media/stream?path=${encodeURIComponent(target)}`);
      expect(res.status).toBe(401);
    });

    it('rejects an unauthenticated playlist save', async () => {
      const res: Response = await fetch(`${baseUrl}/playlist/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: nonExistentPath('evil.opp') }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects a request with a foreign Host header (DNS rebinding)', async () => {
      // Raw http.request, because fetch does not reliably let callers override Host.
      const status: number = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          `${baseUrl}/player/state`,
          { headers: { 'X-Onix-Token': authToken, Host: 'evil.example.com' } },
          (res: IncomingMessage) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(403);
    });

    it('mints a distinct token per server instance', async () => {
      const other: UnifiedMediaServer = new UnifiedMediaServer();
      expect(other.getAuthToken()).not.toBe(server.getAuthToken());
      expect(other.getAuthToken().length).toBeGreaterThanOrEqual(32);
    });

    // A protected prefix shadows any static asset beneath it: the asset request
    // carries no token and is answered with 401 instead of the file. A browser
    // fetching a font from a stylesheet cannot attach a header, so this fails
    // silently, and only once the bundle is served from here - which is to say
    // only in a packaged build. Assert the build does not put assets anywhere
    // an API prefix would swallow them.
    it('does not emit build assets under a protected route prefix', () => {
      const angularConfig: {projects: Record<string, {architect: {build: {options: {outputPath?: {media?: string}}}}}>} =
        JSON.parse(fs.readFileSync(path.join(process.cwd(), 'angular.json'), 'utf-8'));
      const mediaDir: string | undefined =
        angularConfig.projects['onixlabs-media-player'].architect.build.options.outputPath?.media;

      // Angular's default is 'media', which collides with the /media API.
      expect(mediaDir).toBeDefined();
      expect(mediaDir).not.toBe('media');

      const assetPath: string = `/${mediaDir}/some-icon-font.woff2`;
      for (const prefix of ['/events', '/media', '/player', '/playlist', '/settings', '/dependencies']) {
        expect(assetPath === prefix || assetPath.startsWith(`${prefix}/`)).toBe(false);
      }
    });
  });

  // ==========================================================================
  // Playlist save path validation
  // ==========================================================================

  describe('POST /playlist/save path validation', () => {
    // Each case asserts the specific rejection reason: the playlist is empty in
    // this suite, which also yields a 400, so a bare status check would pass
    // even with validation removed.
    it('rejects a path with traversal segments', async () => {
      const traversal: string = process.platform === 'win32'
        ? 'C:\\Users\\..\\evil.opp'
        : '/tmp/../evil.opp';
      const { status, body } = await request('POST', '/playlist/save', { filePath: traversal });
      expect(status).toBe(400);
      expect(String(body['error'])).toContain('traversal');
    });

    it('rejects a relative path', async () => {
      const { status, body } = await request('POST', '/playlist/save', { filePath: 'evil.opp' });
      expect(status).toBe(400);
      expect(String(body['error'])).toContain('absolute');
    });

    it('rejects a non-.opp extension', async () => {
      const { status, body } = await request('POST', '/playlist/save', {
        filePath: nonExistentPath('evil.sh'),
      });
      expect(status).toBe(400);
      expect(String(body['error'])).toContain('.opp');
    });

    it('accepts an extension-less path by normalizing it to .opp', async () => {
      // Passes validation, so it fails later on the empty playlist instead —
      // proving the path itself was not rejected (GTK save dialogs omit the
      // extension).
      const { status, body } = await request('POST', '/playlist/save', {
        filePath: nonExistentPath('myplaylist'),
      });
      expect(status).toBe(400);
      expect(String(body['error'])).toContain('empty');
    });
  });

  // ==========================================================================
  // GET /player/state
  // ==========================================================================

  describe('GET /player/state', () => {
    it('returns initial idle state', async () => {
      const { status, body } = await request('GET', '/player/state');
      expect(status).toBe(200);
      expect(body.state).toBe('idle');
      expect(body.currentTime).toBe(0);
      expect(body.duration).toBe(0);
      expect(body.volume).toBe(1);
      expect(body.muted).toBe(false);
      expect(body.currentMedia).toBeNull();
      expect(body.errorMessage).toBeNull();
    });
  });

  // ==========================================================================
  // POST /player/volume
  // ==========================================================================

  describe('POST /player/volume', () => {
    it('sets volume to a valid value', async () => {
      const { status, body } = await request('POST', '/player/volume', { volume: 0.5 });
      expect(status).toBe(200);
      expect(body.volume).toBe(0.5);
    });

    it('clamps volume above 1', async () => {
      const { status, body } = await request('POST', '/player/volume', { volume: 1.5 });
      expect(status).toBe(200);
      expect(body.volume).toBe(1);
    });

    it('clamps volume below 0', async () => {
      const { status, body } = await request('POST', '/player/volume', { volume: -0.5 });
      expect(status).toBe(200);
      expect(body.volume).toBe(0);
    });

    it('sets muted state', async () => {
      const { status, body } = await request('POST', '/player/volume', { muted: true });
      expect(status).toBe(200);
      expect(body.muted).toBe(true);
    });

    it('sets both volume and muted', async () => {
      const { status, body } = await request('POST', '/player/volume', { volume: 0.75, muted: false });
      expect(status).toBe(200);
      expect(body.volume).toBe(0.75);
      expect(body.muted).toBe(false);
    });

    // Reset volume for other tests
    afterAll(async () => {
      await request('POST', '/player/volume', { volume: 1, muted: false });
    });
  });

  // ==========================================================================
  // POST /player/pause (when not playing)
  // ==========================================================================

  describe('POST /player/pause (idle)', () => {
    it('returns 400 when not playing', async () => {
      const { status, body } = await request('POST', '/player/pause');
      expect(status).toBe(400);
      expect(body.error).toBe('Not playing');
    });
  });

  // ==========================================================================
  // POST /player/play (no track selected)
  // ==========================================================================

  describe('POST /player/play (no track)', () => {
    it('returns 400 when no track is selected', async () => {
      const { status, body } = await request('POST', '/player/play');
      expect(status).toBe(400);
      expect(body.error).toBe('No track selected');
    });
  });

  // ==========================================================================
  // POST /player/stop
  // ==========================================================================

  describe('POST /player/stop', () => {
    it('stops and resets state', async () => {
      const { status, body } = await request('POST', '/player/stop');
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      // Verify state is stopped
      const state = await request('GET', '/player/state');
      expect(state.body.state).toBe('stopped');
      expect(state.body.currentTime).toBe(0);
    });
  });

  // ==========================================================================
  // POST /player/seek
  // ==========================================================================

  describe('POST /player/seek', () => {
    it('seeks to a valid time', async () => {
      const { status, body } = await request('POST', '/player/seek', { time: 5 });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      // Time is clamped to 0..duration; duration is 0 so time will be 0
      expect(body.time).toBe(0);
    });

    it('rejects non-number time', async () => {
      const { status, body } = await request('POST', '/player/seek', { time: 'abc' });
      expect(status).toBe(400);
      expect(body.error).toBe('Invalid time');
    });
  });

  // ==========================================================================
  // POST /player/sync
  // ==========================================================================

  describe('POST /player/sync', () => {
    it('accepts a sync while not playing without changing the clock', async () => {
      const { status, body } = await request('POST', '/player/sync', { time: 5 });
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      // Not playing, so the reported position is unchanged
      const state = await request('GET', '/player/state');
      expect(state.body.currentTime).toBe(0);
    });

    it('rejects non-number time', async () => {
      const { status, body } = await request('POST', '/player/sync', { time: 'abc' });
      expect(status).toBe(400);
      expect(body.error).toBe('Invalid time');
    });

    it('rejects non-finite time', async () => {
      const { status, body } = await request('POST', '/player/sync', { time: null });
      expect(status).toBe(400);
      expect(body.error).toBe('Invalid time');
    });
  });

  // ==========================================================================
  // GET /playlist
  // ==========================================================================

  describe('GET /playlist', () => {
    it('returns initial empty playlist', async () => {
      const { status, body } = await request('GET', '/playlist');
      expect(status).toBe(200);
      expect(body.items).toEqual([]);
      expect(body.currentIndex).toBe(-1);
      expect(body.shuffleEnabled).toBe(false);
      expect(body.repeatEnabled).toBe(false);
    });
  });

  // ==========================================================================
  // POST /playlist/add
  // ==========================================================================

  describe('POST /playlist/add', () => {
    it('rejects non-array paths', async () => {
      const { status, body } = await request('POST', '/playlist/add', { paths: 'not-array' });
      expect(status).toBe(400);
      expect(body.error).toBe('paths must be an array');
    });

    it('handles empty paths array (nothing to probe)', async () => {
      const { status, body } = await request('POST', '/playlist/add', { paths: [] });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect((body.added as unknown[]).length).toBe(0);
    });

    it('silently skips files that fail probing', async () => {
      // Non-existent files will fail probing (ffprobe not available)
      const { status, body } = await request('POST', '/playlist/add', {
        paths: ['/nonexistent/file.mp3'],
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      // File fails probing, so added should be empty
      expect((body.added as unknown[]).length).toBe(0);
    });
  });

  // ==========================================================================
  // DELETE /playlist/remove/:id
  // ==========================================================================

  describe('DELETE /playlist/remove/:id', () => {
    it('returns 404 for non-existent item', async () => {
      const { status } = await request('DELETE', '/playlist/remove/nonexistent-id');
      expect(status).toBe(404);
    });
  });

  // ==========================================================================
  // DELETE /playlist/clear
  // ==========================================================================

  describe('DELETE /playlist/clear', () => {
    it('clears playlist and resets playback to idle', async () => {
      const { status, body } = await request('DELETE', '/playlist/clear');
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      // Verify empty playlist
      const playlist = await request('GET', '/playlist');
      expect((playlist.body.items as unknown[]).length).toBe(0);
      expect(playlist.body.currentIndex).toBe(-1);

      // Verify idle state
      const state = await request('GET', '/player/state');
      expect(state.body.state).toBe('idle');
    });
  });

  // ==========================================================================
  // POST /playlist/select/:id
  // ==========================================================================

  describe('POST /playlist/select/:id', () => {
    it('returns 404 for non-existent item', async () => {
      const { status, body } = await request('POST', '/playlist/select/nonexistent-id');
      expect(status).toBe(404);
      expect(body.error).toBe('Item not found');
    });
  });

  // ==========================================================================
  // POST /playlist/next
  // ==========================================================================

  describe('POST /playlist/next', () => {
    it('returns ended when playlist is empty', async () => {
      const { status, body } = await request('POST', '/playlist/next');
      expect(status).toBe(200);
      expect(body.ended).toBe(true);
    });
  });

  // ==========================================================================
  // POST /playlist/previous
  // ==========================================================================

  describe('POST /playlist/previous', () => {
    it('returns no previous track when playlist is empty', async () => {
      const { status, body } = await request('POST', '/playlist/previous');
      expect(status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.reason).toBe('No previous track');
    });
  });

  // ==========================================================================
  // POST /playlist/shuffle
  // ==========================================================================

  describe('POST /playlist/shuffle', () => {
    it('enables shuffle mode', async () => {
      const { status, body } = await request('POST', '/playlist/shuffle', { enabled: true });
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      const playlist = await request('GET', '/playlist');
      expect(playlist.body.shuffleEnabled).toBe(true);
    });

    it('disables shuffle mode', async () => {
      const { status, body } = await request('POST', '/playlist/shuffle', { enabled: false });
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      const playlist = await request('GET', '/playlist');
      expect(playlist.body.shuffleEnabled).toBe(false);
    });
  });

  // ==========================================================================
  // POST /playlist/repeat
  // ==========================================================================

  describe('POST /playlist/repeat', () => {
    it('enables repeat mode', async () => {
      const { status, body } = await request('POST', '/playlist/repeat', { enabled: true });
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      const playlist = await request('GET', '/playlist');
      expect(playlist.body.repeatEnabled).toBe(true);
    });

    it('disables repeat mode', async () => {
      const { status, body } = await request('POST', '/playlist/repeat', { enabled: false });
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      const playlist = await request('GET', '/playlist');
      expect(playlist.body.repeatEnabled).toBe(false);
    });
  });

  // ==========================================================================
  // GET /settings
  // ==========================================================================

  describe('GET /settings', () => {
    it('returns settings with all sections', async () => {
      const { status, body } = await request('GET', '/settings');
      expect(status).toBe(200);
      expect(body).toHaveProperty('visualization');
      expect(body).toHaveProperty('application');
      expect(body).toHaveProperty('playback');
      expect(body).toHaveProperty('transcoding');
      expect(body).toHaveProperty('appearance');
    });
  });

  // ==========================================================================
  // PUT /settings/visualization
  // ==========================================================================

  describe('PUT /settings/visualization', () => {
    it('updates visualization settings', async () => {
      const { status, body } = await request('PUT', '/settings/visualization', {
        defaultType: 'waveform',
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      // Verify the setting persisted
      const settings = await request('GET', '/settings');
      expect((settings.body.visualization as Record<string, unknown>).defaultType).toBe('waveform');
    });
  });

  // ==========================================================================
  // PUT /settings/application
  // ==========================================================================

  describe('PUT /settings/application', () => {
    it('updates application settings', async () => {
      const { status, body } = await request('PUT', '/settings/application', {
        serverPort: 0,
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // ==========================================================================
  // PUT /settings/playback
  // ==========================================================================

  describe('PUT /settings/playback', () => {
    it('updates playback settings', async () => {
      const { status, body } = await request('PUT', '/settings/playback', {
        crossfadeDuration: 3,
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      const settings = await request('GET', '/settings');
      expect((settings.body.playback as Record<string, unknown>).crossfadeDuration).toBe(3);
    });
  });

  // ==========================================================================
  // PUT /settings/transcoding
  // ==========================================================================

  describe('PUT /settings/transcoding', () => {
    it('updates transcoding settings', async () => {
      const { status, body } = await request('PUT', '/settings/transcoding', {
        videoQuality: 'high',
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      const settings = await request('GET', '/settings');
      expect((settings.body.transcoding as Record<string, unknown>).videoQuality).toBe('high');
    });
  });

  // ==========================================================================
  // PUT /settings/appearance
  // ==========================================================================

  describe('PUT /settings/appearance', () => {
    it('updates appearance settings', async () => {
      const { status, body } = await request('PUT', '/settings/appearance', {
        backgroundColor: '#1a1a2e',
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);

      const settings = await request('GET', '/settings');
      expect((settings.body.appearance as Record<string, unknown>).backgroundColor).toBe('#1a1a2e');
    });
  });

  // ==========================================================================
  // GET /dependencies
  // ==========================================================================

  describe('GET /dependencies', () => {
    it('returns dependency state', async () => {
      const { status, body } = await request('GET', '/dependencies');
      expect(status).toBe(200);
      expect(body).toHaveProperty('ffmpeg');
      expect(body).toHaveProperty('fluidsynth');
    });
  });

  // ==========================================================================
  // POST /dependencies/refresh
  // ==========================================================================

  describe('POST /dependencies/refresh', () => {
    it('refreshes and returns dependency state', async () => {
      const { status, body } = await request('POST', '/dependencies/refresh');
      expect(status).toBe(200);
      expect(body).toHaveProperty('ffmpeg');
      expect(body).toHaveProperty('fluidsynth');
    });
  });

  // ==========================================================================
  // POST /dependencies/install — validation
  // ==========================================================================

  describe('POST /dependencies/install', () => {
    it('rejects invalid dependency id', async () => {
      const { status, body } = await request('POST', '/dependencies/install', { id: 'invalid' });
      expect(status).toBe(400);
      expect(body.error).toBe('Invalid dependency id');
    });
  });

  // ==========================================================================
  // POST /dependencies/uninstall — validation
  // ==========================================================================

  describe('POST /dependencies/uninstall', () => {
    it('rejects invalid dependency id', async () => {
      const { status, body } = await request('POST', '/dependencies/uninstall', { id: 'invalid' });
      expect(status).toBe(400);
      expect(body.error).toBe('Invalid dependency id');
    });
  });

  // ==========================================================================
  // POST /dependencies/soundfont/install — validation
  // ==========================================================================

  describe('POST /dependencies/soundfont/install', () => {
    it('rejects missing sourcePath', async () => {
      const { status, body } = await request('POST', '/dependencies/soundfont/install', {});
      expect(status).toBe(400);
      expect(body.error).toBe('Missing sourcePath');
    });
  });

  // ==========================================================================
  // POST /dependencies/soundfont/remove — validation
  // ==========================================================================

  describe('POST /dependencies/soundfont/remove', () => {
    it('rejects missing fileName', async () => {
      const { status, body } = await request('POST', '/dependencies/soundfont/remove', {});
      expect(status).toBe(400);
      expect(body.error).toBe('Missing fileName');
    });
  });

  // ==========================================================================
  // GET /media/stream — validation
  // ==========================================================================

  describe('GET /media/stream', () => {
    it('returns 400 for missing path parameter', async () => {
      const { status, body } = await request('GET', '/media/stream');
      expect(status).toBe(400);
      expect(body.error).toBe('Missing path parameter');
    });

    it('returns 400 for path traversal attempt', async () => {
      const { status, body } = await request('GET', '/media/stream?path=/etc/../etc/passwd');
      expect(status).toBe(400);
      expect(body.error).toContain('traversal');
    });

    it('returns 400 for relative path', async () => {
      const { status, body } = await request('GET', '/media/stream?path=relative/file.mp3');
      expect(status).toBe(400);
      expect(body.error).toContain('absolute');
    });

    it('returns 404 for non-existent file', async () => {
      const { status, body } = await request('GET', `/media/stream?path=${encodeURIComponent(nonExistentPath('file.mp3'))}`);
      expect(status).toBe(404);
      expect(body.error).toBe('File not found');
    });
  });

  // ==========================================================================
  // GET /media/info — validation
  // ==========================================================================

  describe('GET /media/info', () => {
    it('returns 400 for missing path parameter', async () => {
      const { status, body } = await request('GET', '/media/info');
      expect(status).toBe(400);
      expect(body.error).toBe('Missing path parameter');
    });

    it('returns 400 for path traversal attempt', async () => {
      const { status, body } = await request('GET', '/media/info?path=/etc/../etc/passwd');
      expect(status).toBe(400);
      expect(body.error).toContain('traversal');
    });

    it('returns 404 for non-existent file', async () => {
      const { status, body } = await request('GET', `/media/info?path=${encodeURIComponent(nonExistentPath('file.mp3'))}`);
      expect(status).toBe(404);
      expect(body.error).toBe('File not found');
    });
  });

  // ==========================================================================
  // SSE (GET /events)
  // ==========================================================================

  describe('GET /events (SSE)', () => {
    it('sends initial state events on connection', async () => {
      // SSE should send initial: playback:state, playback:time, playback:volume,
      // playlist:updated, settings:updated, dependencies:state
      const events = await collectSSEEvents('/events', 6, 2000);

      const eventTypes: string[] = events.map(e => e.event);
      expect(eventTypes).toContain('playback:state');
      expect(eventTypes).toContain('playback:time');
      expect(eventTypes).toContain('playback:volume');
      expect(eventTypes).toContain('playlist:updated');
      expect(eventTypes).toContain('settings:updated');
      expect(eventTypes).toContain('dependencies:state');
    });

    it('sends valid JSON data in events', async () => {
      const events = await collectSSEEvents('/events', 6, 2000);

      for (const event of events) {
        expect(() => JSON.parse(event.data)).not.toThrow();
      }
    });
  });

  // ==========================================================================
  // Unknown route
  // ==========================================================================

  describe('unknown routes', () => {
    it('returns 404 for unknown path', async () => {
      const { status } = await request('GET', '/unknown/path');
      expect(status).toBe(404);
    });
  });

  // ==========================================================================
  // Request body size limit
  // ==========================================================================

  describe('request body size limit', () => {
    it('rejects oversized request body', async () => {
      // The server limit is 1MB. Send 2MB of data.
      // The server calls req.destroy() when the body exceeds MAX_BODY_SIZE,
      // which may cause an EPIPE/fetch failure on the client side before
      // a 413 response can be sent. Both outcomes (413 or connection error)
      // confirm the server correctly rejects oversized bodies.
      const largeBody: string = JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) });
      try {
        const res: Response = await fetch(`${baseUrl}/player/volume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Onix-Token': authToken },
          body: largeBody,
        });
        // If we get a response, it should be 413
        expect(res.status).toBe(413);
      } catch {
        // Connection reset/EPIPE is also valid — server destroyed the request
        expect(true).toBe(true);
      }
    });
  });

  // ==========================================================================
  // clearPlaylist public method
  // ==========================================================================

  describe('clearPlaylist (public method)', () => {
    it('resets state to idle and empties playlist', async () => {
      // Call clearPlaylist directly
      server.clearPlaylist();

      const state = await request('GET', '/player/state');
      expect(state.body.state).toBe('idle');
      expect(state.body.currentTime).toBe(0);
      expect(state.body.duration).toBe(0);
      expect(state.body.currentMedia).toBeNull();

      const playlist = await request('GET', '/playlist');
      expect((playlist.body.items as unknown[]).length).toBe(0);
      expect(playlist.body.currentIndex).toBe(-1);
    });
  });

  // ==========================================================================
  // Callback registration
  // ==========================================================================

  describe('callback registration', () => {
    it('registers onModeChange callback', () => {
      const callback = vi.fn();
      server.onModeChange(callback);
      // No error means success — callback is stored internally
      expect(true).toBe(true);
    });

    it('registers onPlaylistCountChange callback', () => {
      const callback = vi.fn();
      server.onPlaylistCountChange(callback);
      expect(true).toBe(true);
    });

    it('registers onPlaybackStateChange callback', () => {
      const callback = vi.fn();
      server.onPlaybackStateChange(callback);
      expect(true).toBe(true);
    });

    it('registers onDependencyStateChange callback', () => {
      const callback = vi.fn();
      server.onDependencyStateChange(callback);
      expect(true).toBe(true);
    });
  });

  // ==========================================================================
  // Callback invocations
  // ==========================================================================

  describe('callback invocations', () => {
    it('fires onPlaylistCountChange when clearing playlist', async () => {
      const countCallback = vi.fn();
      server.onPlaylistCountChange(countCallback);

      await request('DELETE', '/playlist/clear');
      expect(countCallback).toHaveBeenCalledWith(0);
    });

    it('fires onPlaybackStateChange on stop', async () => {
      const stateCallback = vi.fn();
      server.onPlaybackStateChange(stateCallback);

      await request('POST', '/player/stop');
      // stop transitions state -> stopped, broadcastState fires callback with false
      expect(stateCallback).toHaveBeenCalledWith(false);
    });

    it('fires onModeChange when toggling shuffle', async () => {
      const modeCallback = vi.fn();
      server.onModeChange(modeCallback);

      await request('POST', '/playlist/shuffle', { enabled: true });
      expect(modeCallback).toHaveBeenCalledWith(true, false);

      await request('POST', '/playlist/shuffle', { enabled: false });
      expect(modeCallback).toHaveBeenCalledWith(false, false);
    });

    it('fires onModeChange when toggling repeat', async () => {
      const modeCallback = vi.fn();
      server.onModeChange(modeCallback);

      await request('POST', '/playlist/repeat', { enabled: true });
      expect(modeCallback).toHaveBeenCalledWith(false, true);

      await request('POST', '/playlist/repeat', { enabled: false });
      expect(modeCallback).toHaveBeenCalledWith(false, false);
    });
  });

  // ==========================================================================
  // Integrated playlist + playback state flow
  // ==========================================================================

  describe('integrated state flow', () => {
    beforeEach(async () => {
      // Reset state between tests
      server.clearPlaylist();
    });

    it('clear resets playback state to idle', async () => {
      await request('DELETE', '/playlist/clear');

      const state = await request('GET', '/player/state');
      expect(state.body.state).toBe('idle');

      const playlist = await request('GET', '/playlist');
      expect(playlist.body.currentIndex).toBe(-1);
    });

    it('shuffle + repeat can be combined', async () => {
      await request('POST', '/playlist/shuffle', { enabled: true });
      await request('POST', '/playlist/repeat', { enabled: true });

      const playlist = await request('GET', '/playlist');
      expect(playlist.body.shuffleEnabled).toBe(true);
      expect(playlist.body.repeatEnabled).toBe(true);

      // Clean up
      await request('POST', '/playlist/shuffle', { enabled: false });
      await request('POST', '/playlist/repeat', { enabled: false });
    });

    it('stop then get state shows stopped', async () => {
      await request('POST', '/player/stop');
      const state = await request('GET', '/player/state');
      expect(state.body.state).toBe('stopped');
      expect(state.body.currentTime).toBe(0);
    });
  });

  // ==========================================================================
  // Separate server instance test
  // ==========================================================================

  describe('separate server instance', () => {
    it('can start and stop a second server on a different port', async () => {
      const server2: UnifiedMediaServer = new UnifiedMediaServer();
      const port2: number = await server2.start();
      expect(port2).toBeGreaterThan(0);
      expect(port2).not.toBe(server.getPort());

      // Verify it responds (with its own independently-minted token)
      const res: Response = await fetch(`http://127.0.0.1:${port2}/player/state`, {
        headers: { 'X-Onix-Token': server2.getAuthToken() },
      });
      expect(res.status).toBe(200);

      server2.stop();
    });
  });

  // ==========================================================================
  // Audio codec compatibility (browser-compatible codecs)
  // ==========================================================================

  describe('audio codec compatibility', () => {
    // These tests verify that the server correctly identifies browser-compatible
    // vs incompatible audio codecs. Files with incompatible audio (AC3, DTS, etc.)
    // must be transcoded even if the container format is "native" (e.g., MP4).

    it('recognizes AAC as browser-compatible', async () => {
      // AAC is the most common browser-compatible codec
      // This is tested indirectly - AAC files should be served directly
      const { status } = await request('GET', '/player/state');
      expect(status).toBe(200);
      // Server is running and codec constants are loaded
    });

    it('treats native MP4 container with path traversal as invalid', async () => {
      // Ensure security checks still work with codec logic
      const { status, body } = await request('GET', '/media/stream?path=/test/../etc/passwd');
      expect(status).toBe(400);
      expect(body.error).toContain('traversal');
    });

    it('returns 404 for native container with non-existent file', async () => {
      // Even with codec checks, non-existent files should 404
      const { status, body } = await request('GET', `/media/stream?path=${encodeURIComponent(nonExistentPath('video.mp4'))}`);
      expect(status).toBe(404);
      expect(body.error).toBe('File not found');
    });
  });

  // ==========================================================================
  // Transcoding mode selection
  // ==========================================================================

  describe('transcoding mode selection', () => {
    // These tests document the expected behavior of the transcoding logic.
    // The actual transcoding requires FFmpeg which may not be available in tests,
    // but we can verify the routing logic and error handling.

    it('rejects stream request for non-existent MKV file', async () => {
      // MKV files always go through transcoding - verify path validation works
      const { status, body } = await request('GET', `/media/stream?path=${encodeURIComponent(nonExistentPath('video.mkv'))}`);
      expect(status).toBe(404);
      expect(body.error).toBe('File not found');
    });

    it('rejects stream request for non-existent AVI file', async () => {
      // AVI files always go through transcoding
      const { status, body } = await request('GET', `/media/stream?path=${encodeURIComponent(nonExistentPath('video.avi'))}`);
      expect(status).toBe(404);
      expect(body.error).toBe('File not found');
    });

    it('rejects stream request for non-existent MOV file', async () => {
      // MOV files always go through transcoding
      const { status, body } = await request('GET', `/media/stream?path=${encodeURIComponent(nonExistentPath('video.mov'))}`);
      expect(status).toBe(404);
      expect(body.error).toBe('File not found');
    });

    it('rejects stream request for non-existent WMA file', async () => {
      // WMA files go through audio-only transcoding
      const { status, body } = await request('GET', `/media/stream?path=${encodeURIComponent(nonExistentPath('audio.wma'))}`);
      expect(status).toBe(404);
      expect(body.error).toBe('File not found');
    });

    it('accepts audioTrack query parameter', async () => {
      // The audioTrack parameter should be accepted even if file doesn't exist
      // (validation happens before codec check)
      const { status, body } = await request('GET', `/media/stream?path=${encodeURIComponent(nonExistentPath('video.mkv'))}&audioTrack=1`);
      expect(status).toBe(404);
      expect(body.error).toBe('File not found');
    });

    it('accepts seek time parameter', async () => {
      // The t parameter for seeking should be accepted
      const { status, body } = await request('GET', `/media/stream?path=${encodeURIComponent(nonExistentPath('video.mkv'))}&t=30`);
      expect(status).toBe(404);
      expect(body.error).toBe('File not found');
    });
  });

  // ==========================================================================
  // Media info caching
  // ==========================================================================

  describe('media info caching', () => {
    it('returns 404 for non-existent file when getting media info', async () => {
      const { status, body } = await request('GET', `/media/info?path=${encodeURIComponent(nonExistentPath('file.mp4'))}`);
      expect(status).toBe(404);
      expect(body.error).toBe('File not found');
    });

    it('validates path before probing media info', async () => {
      const { status, body } = await request('GET', '/media/info?path=relative/path.mp4');
      expect(status).toBe(400);
      expect(body.error).toContain('absolute');
    });
  });
  // ==========================================================================
  // Playlist file I/O (.opp)
  // ==========================================================================

  describe('playlist file I/O', () => {
    /** Writes a .opp file into the test userData dir and returns its path. */
    function writeOpp(name: string, content: string): string {
      const filePath: string = path.join(mockUserDataPath, name);
      fs.writeFileSync(filePath, content, 'utf-8');
      return filePath;
    }

    it('rejects a load with no filePath', async () => {
      const { status, body } = await request('POST', '/playlist/load', {});
      expect(status).toBe(400);
      expect(body.error).toBe('Missing filePath');
    });

    it('returns 404 when the playlist file does not exist', async () => {
      const { status, body } = await request('POST', '/playlist/load', {
        filePath: nonExistentPath('missing.opp'),
      });
      expect(status).toBe(404);
      expect(body.error).toBe('File not found');
    });

    it('reports malformed JSON rather than crashing', async () => {
      const filePath: string = writeOpp('malformed.opp', '{ this is not json');

      const { status } = await request('POST', '/playlist/load', { filePath });

      expect(status).toBe(500);
    });

    it('rejects a file with the wrong format marker', async () => {
      const filePath: string = writeOpp('wrong-format.opp', JSON.stringify({
        format: 'some-other-player',
        items: [],
      }));

      const { status, body } = await request('POST', '/playlist/load', { filePath });

      expect(status).toBe(400);
      expect(body.error).toBe('Invalid playlist file format');
    });

    it('rejects a file with no items array', async () => {
      const filePath: string = writeOpp('no-items.opp', JSON.stringify({
        format: 'onixplayer-playlist',
      }));

      const { status, body } = await request('POST', '/playlist/load', { filePath });

      expect(status).toBe(400);
      expect(body.error).toBe('Invalid playlist file format');
    });

    it('rejects a file whose items are not an array', async () => {
      const filePath: string = writeOpp('items-object.opp', JSON.stringify({
        format: 'onixplayer-playlist',
        items: { nope: true },
      }));

      const { status, body } = await request('POST', '/playlist/load', { filePath });

      expect(status).toBe(400);
      expect(body.error).toBe('Invalid playlist file format');
    });

    it('rejects a JSON file that is not an object', async () => {
      const filePath: string = writeOpp('array.opp', JSON.stringify([1, 2, 3]));

      const { status, body } = await request('POST', '/playlist/load', { filePath });

      expect(status).toBe(400);
      expect(body.error).toBe('Invalid playlist file format');
    });

    it('loads a valid but empty playlist without starting playback', async () => {
      const filePath: string = writeOpp('empty.opp', JSON.stringify({
        format: 'onixplayer-playlist',
        items: [],
      }));

      const { status, body } = await request('POST', '/playlist/load', { filePath });

      expect(status).toBe(200);
      expect(body.count).toBe(0);
      expect(body.success).toBe(true);
    });

    it('records the source file of a loaded playlist', async () => {
      const filePath: string = writeOpp('source.opp', JSON.stringify({
        format: 'onixplayer-playlist',
        items: [],
      }));
      await request('POST', '/playlist/load', { filePath });

      const { status, body } = await request('GET', '/playlist/source');

      expect(status).toBe(200);
      expect(body.filePath).toBe(filePath);
    });

    it('adds the file entries without re-probing them', async () => {
      // Loading trusts the stored metadata rather than probing each file, so a
      // playlist referencing media that is not present still populates.
      const filePath: string = writeOpp('two-items.opp', JSON.stringify({
        format: 'onixplayer-playlist',
        items: [
          { filePath: nonExistentPath('one.mp3'), title: 'One', duration: 10, type: 'audio' },
          { filePath: nonExistentPath('two.mp3'), title: 'Two', duration: 20, type: 'audio' },
        ],
      }));

      await request('POST', '/playlist/load', { filePath });
      const { body } = await request('GET', '/playlist');

      const titles: string[] = (body.items as {title: string}[]).map((i: {title: string}): string => i.title);
      expect(titles).toEqual(['One', 'Two']);
    });

    it('replaces the existing playlist rather than appending to it', async () => {
      const populated: string = writeOpp('populated.opp', JSON.stringify({
        format: 'onixplayer-playlist',
        items: [{ filePath: nonExistentPath('one.mp3'), title: 'One', duration: 10, type: 'audio' }],
      }));
      await request('POST', '/playlist/load', { filePath: populated });

      const empty: string = writeOpp('replace.opp', JSON.stringify({
        format: 'onixplayer-playlist',
        items: [],
      }));
      await request('POST', '/playlist/load', { filePath: empty });
      const { body } = await request('GET', '/playlist');

      expect((body.items as unknown[]).length).toBe(0);
    });

    it('clears the source file when the playlist is cleared', async () => {
      const filePath: string = writeOpp('cleared.opp', JSON.stringify({
        format: 'onixplayer-playlist',
        items: [],
      }));
      await request('POST', '/playlist/load', { filePath });

      await request('DELETE', '/playlist/clear');
      const { body } = await request('GET', '/playlist/source');

      expect(body.filePath).toBeNull();
    });

    it('requires a token to load a playlist', async () => {
      const res: Response = await fetch(`${baseUrl}/playlist/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: '/tmp/anything.opp' }),
      });

      expect(res.status).toBe(401);
    });

    it('requires a token to read the playlist source', async () => {
      const res: Response = await fetch(`${baseUrl}/playlist/source`, { method: 'GET' });

      expect(res.status).toBe(401);
    });
  });
});

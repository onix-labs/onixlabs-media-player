/**
 * @fileoverview Security-focused tests for MediaDownloadManager.
 *
 * Covers the hardening applied to yt-dlp invocation:
 * - Only http(s) URLs reach the yt-dlp process
 * - Every argument list terminates options with `--` before the URL, so a
 *   URL beginning with `-` cannot be parsed as a flag
 *
 * Broader coverage of this module (format selection, progress parsing,
 * finalization, cancellation) is tracked separately.
 *
 * @module electron/media-download-manager.spec
 */

// ============================================================================
// Mocks
// ============================================================================

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  renameSync: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  createScopedLogger: (): Record<string, (...args: unknown[]) => void> => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
  logProcessSpawn: vi.fn(),
  logProcessExit: vi.fn(),
}));

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { execFile } from 'child_process';
import { MediaDownloadManager } from './media-download-manager.js';
import type { DownloadJob } from './media-types.js';

// ============================================================================
// Helpers
// ============================================================================

const YTDLP_PATH: string = '/usr/local/bin/yt-dlp';

function createManager(): MediaDownloadManager {
  return new MediaDownloadManager(
    (): string | null => YTDLP_PATH,
    (): string | null => null,
    '/tmp/onixplayer-downloads',
  );
}

/** Extracts the argv array passed to the most recent execFile call. */
function lastExecFileArgs(): string[] {
  const calls = vi.mocked(execFile).mock.calls;
  return calls[calls.length - 1]?.[1] as string[];
}

// ============================================================================
// Tests
// ============================================================================

describe('MediaDownloadManager URL hardening', () => {
  let manager: MediaDownloadManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createManager();
  });

  describe('getInfo', () => {
    it('rejects a file:// URL without spawning yt-dlp', async () => {
      await expect(manager.getInfo('file:///etc/passwd')).rejects.toThrow(/only http and https/i);
      expect(execFile).not.toHaveBeenCalled();
    });

    it('rejects a malformed URL without spawning yt-dlp', async () => {
      await expect(manager.getInfo('not a url')).rejects.toThrow(/invalid url/i);
      expect(execFile).not.toHaveBeenCalled();
    });

    it('places -- immediately before the URL for a valid https URL', () => {
      void manager.getInfo('https://example.com/watch?v=abc');

      const args: string[] = lastExecFileArgs();
      const urlIndex: number = args.indexOf('https://example.com/watch?v=abc');

      expect(urlIndex).toBeGreaterThan(0);
      expect(args[urlIndex - 1]).toBe('--');
    });

    it('treats a leading-dash URL as a positional argument, not a flag', () => {
      // A bare '-...' value would otherwise be parsed by yt-dlp as an option.
      const hostile: string = 'https://example.com/-nasty';
      void manager.getInfo(hostile);

      const args: string[] = lastExecFileArgs();
      expect(args[args.indexOf(hostile) - 1]).toBe('--');
    });
  });

  describe('resolveStreamSources', () => {
    it('rejects a non-http(s) scheme', async () => {
      await expect(
        manager.resolveStreamSources('file:///etc/passwd', 'video', null),
      ).rejects.toThrow(/only http and https/i);
      expect(execFile).not.toHaveBeenCalled();
    });

    it('places -- immediately before the URL', () => {
      void manager.resolveStreamSources('https://example.com/v', 'video', 720);

      const args: string[] = lastExecFileArgs();
      expect(args[args.indexOf('https://example.com/v') - 1]).toBe('--');
    });
  });

  describe('startDownload', () => {
    it('fails the job for a non-http(s) scheme', () => {
      const updates: DownloadJob[] = [];
      const id: string = manager.startDownload(
        'file:///etc/passwd',
        'video',
        null,
        'evil',
        (job: DownloadJob): void => {
          updates.push({ ...job });
        },
      );

      const job: DownloadJob | undefined = manager.getJob(id);
      expect(job?.status).toBe('error');
      expect(job?.errorMessage).toMatch(/only http and https/i);
    });
  });
});

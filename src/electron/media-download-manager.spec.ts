/**
 * @fileoverview Tests for MediaDownloadManager.
 *
 * Tests cover:
 * - URL scheme validation (only http/https reaches yt-dlp)
 * - buildFormats de-duplication, filtering and ordering
 * - startDownload argument construction, including the `--` terminator
 * - Progress parsing, failure paths and the stderr tail used as the message
 * - finalizeDownload file selection, title renaming, and the move to a
 *   caller-supplied output path (the Save As destination)
 * - cancelDownload status guards
 * - resolveStreamSources selector construction and DASH-pair splitting
 *
 * @module electron/media-download-manager.spec
 */

// ============================================================================
// Mocks
// ============================================================================

vi.mock('fs', () => ({
  copyFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('crypto', () => ({
  randomUUID: vi.fn((): string => 'abcdef0123456789'),
}));

vi.mock('./logger.js', () => ({
  createScopedLogger: (): Record<string, (...args: unknown[]) => void> => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
  logProcessSpawn: vi.fn(),
  logProcessOutput: vi.fn(),
  logProcessExit: vi.fn(),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { copyFileSync, existsSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { spawn, execFile } from 'child_process';
import type { ChildProcess } from 'child_process';
import * as path from 'path';
import { MediaDownloadManager, type StreamSources } from './media-download-manager.js';
import type { DownloadJob, UrlMediaInfo } from './media-types.js';

// ============================================================================
// Helpers
// ============================================================================

const DOWNLOADS_DIR: string = '/tmp/downloads';

/** A spawned-process stub whose streams and lifecycle can be driven by tests. */
interface FakeChild extends ChildProcess {
  /** Pushes a chunk to the stdout listener */
  emitStdout(text: string): void;
  /** Pushes a chunk to the stderr listener */
  emitStderr(text: string): void;
  /** Fires the 'close' listener */
  emitClose(code: number | null): void;
  /** Fires the 'error' listener */
  emitError(error: Error): void;
}

/**
 * Creates a ChildProcess stub for spawn().
 *
 * @returns A fake child process
 */
function createFakeChild(): FakeChild {
  const handlers: Record<string, (arg: unknown) => void> = {};
  const stdoutHandlers: Record<string, (arg: unknown) => void> = {};
  const stderrHandlers: Record<string, (arg: unknown) => void> = {};

  const child = {
    stdout: {
      on: vi.fn((event: string, handler: (arg: unknown) => void): void => { stdoutHandlers[event] = handler; }),
    },
    stderr: {
      on: vi.fn((event: string, handler: (arg: unknown) => void): void => { stderrHandlers[event] = handler; }),
    },
    on: vi.fn((event: string, handler: (arg: unknown) => void): unknown => { handlers[event] = handler; return child; }),
    kill: vi.fn(),
    emitStdout: (text: string): void => stdoutHandlers['data']?.(Buffer.from(text)),
    emitStderr: (text: string): void => stderrHandlers['data']?.(Buffer.from(text)),
    emitClose: (code: number | null): void => handlers['close']?.(code),
    emitError: (error: Error): void => handlers['error']?.(error),
  };

  return child as unknown as FakeChild;
}

/**
 * Makes execFile invoke its callback with the given result.
 *
 * @param error - Error to report, or null
 * @param stdout - Standard output text
 * @param stderr - Standard error text
 */
function stubExecFile(error: Error | null, stdout: string, stderr: string = ''): void {
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback: (e: Error | null, out: string, err: string) => void
  ): unknown => {
    callback(error, stdout, stderr);
    return {} as ChildProcess;
  }) as unknown as typeof execFile);
}

/** Returns the argument array passed to the most recent spawn call. */
function lastSpawnArgs(): string[] {
  const calls = vi.mocked(spawn).mock.calls;
  return calls[calls.length - 1][1] as string[];
}

/** Returns the argument array passed to the most recent execFile call. */
function lastExecFileArgs(): string[] {
  const calls = vi.mocked(execFile).mock.calls;
  return calls[calls.length - 1][1] as string[];
}

// ============================================================================
// Tests
// ============================================================================

describe('MediaDownloadManager', (): void => {
  let manager: MediaDownloadManager;
  let ytdlpPath: string | null;
  let ffmpegPath: string | null;

  beforeEach((): void => {
    vi.clearAllMocks();
    ytdlpPath = '/usr/bin/yt-dlp';
    ffmpegPath = '/usr/bin/ffmpeg';
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([] as unknown as ReturnType<typeof readdirSync>);

    manager = new MediaDownloadManager(
      (): string | null => ytdlpPath,
      (): string | null => ffmpegPath,
      DOWNLOADS_DIR
    );
  });

  // ==========================================================================
  // URL Validation
  // ==========================================================================

  describe('URL validation', (): void => {
    it('rejects a file:// URL without spawning yt-dlp', async (): Promise<void> => {
      await expect(manager.getInfo('file:///etc/passwd')).rejects.toThrow(/only http and https/i);
      expect(execFile).not.toHaveBeenCalled();
    });

    it('rejects a malformed URL without spawning yt-dlp', async (): Promise<void> => {
      await expect(manager.getInfo('not a url')).rejects.toThrow(/invalid url/i);
      expect(execFile).not.toHaveBeenCalled();
    });

    it('rejects a non-http scheme on resolveStreamSources without spawning', async (): Promise<void> => {
      await expect(manager.resolveStreamSources('ftp://host/f', 'video', null)).rejects.toThrow(/only http and https/i);
      expect(execFile).not.toHaveBeenCalled();
    });

    it('fails a download job for a file:// URL rather than spawning', (): void => {
      const id: string = manager.startDownload('file:///etc/passwd', 'video', null, 'x', null, vi.fn());

      expect(spawn).not.toHaveBeenCalled();
      expect(manager.getJob(id)?.errorMessage).toMatch(/only http and https/i);
    });

    it('accepts https', async (): Promise<void> => {
      stubExecFile(null, JSON.stringify({title: 'T', formats: []}), '');

      await expect(manager.getInfo('https://example.com/v')).resolves.toBeDefined();
    });

    it('treats a leading-dash URL as positional on getInfo, not a flag', async (): Promise<void> => {
      // Without the `--` terminator yt-dlp would parse this path as an option.
      const hostile: string = 'https://example.com/-nasty';
      stubExecFile(null, JSON.stringify({formats: []}), '');

      await manager.getInfo(hostile);

      const args: string[] = lastExecFileArgs();
      expect(args[args.indexOf(hostile) - 1]).toBe('--');
    });

    it('treats a leading-dash URL as positional on resolveStreamSources', async (): Promise<void> => {
      const hostile: string = 'https://example.com/-nasty';
      stubExecFile(null, 'https://cdn/v\n');

      await manager.resolveStreamSources(hostile, 'video', 720);

      const args: string[] = lastExecFileArgs();
      expect(args[args.indexOf(hostile) - 1]).toBe('--');
    });

    it('treats a leading-dash URL as positional on startDownload', (): void => {
      const hostile: string = 'https://example.com/-nasty';
      vi.mocked(spawn).mockReturnValue(createFakeChild());

      manager.startDownload(hostile, 'video', null, 'T', null, vi.fn());

      const args: string[] = lastSpawnArgs();
      expect(args[args.indexOf(hostile) - 1]).toBe('--');
    });
  });

  // ==========================================================================
  // getInfo
  // ==========================================================================

  describe('getInfo', (): void => {
    it('rejects when yt-dlp is not installed', async (): Promise<void> => {
      ytdlpPath = null;

      await expect(manager.getInfo('https://example.com/v')).rejects.toThrow('yt-dlp is not installed');
    });

    it('terminates option parsing before the URL', async (): Promise<void> => {
      stubExecFile(null, JSON.stringify({formats: []}), '');

      await manager.getInfo('https://example.com/v');

      const args: string[] = lastExecFileArgs();
      expect(args[args.length - 2]).toBe('--');
      expect(args[args.length - 1]).toBe('https://example.com/v');
    });

    it('maps the metadata fields', async (): Promise<void> => {
      stubExecFile(null, JSON.stringify({
        title: 'A Video', thumbnail: 'http://img', duration: 42, uploader: 'Someone', formats: [],
      }), '');

      const info: UrlMediaInfo = await manager.getInfo('https://example.com/v');

      expect(info).toMatchObject({title: 'A Video', thumbnail: 'http://img', duration: 42, uploader: 'Someone'});
    });

    it('defaults missing metadata fields', async (): Promise<void> => {
      stubExecFile(null, JSON.stringify({formats: []}), '');

      const info: UrlMediaInfo = await manager.getInfo('https://example.com/v');

      expect(info).toMatchObject({title: '', thumbnail: '', duration: null, uploader: ''});
    });

    it('reports the last stderr line as the error', async (): Promise<void> => {
      stubExecFile(new Error('exit 1'), '', 'WARNING: something\nERROR: Video unavailable\n');

      await expect(manager.getInfo('https://example.com/v')).rejects.toThrow('ERROR: Video unavailable');
    });

    it('falls back to the error message when stderr is empty', async (): Promise<void> => {
      stubExecFile(new Error('spawn failed'), '', '');

      await expect(manager.getInfo('https://example.com/v')).rejects.toThrow('spawn failed');
    });

    it('rejects on unparseable output', async (): Promise<void> => {
      stubExecFile(null, 'not json', '');

      await expect(manager.getInfo('https://example.com/v')).rejects.toThrow();
    });
  });

  // ==========================================================================
  // buildFormats (via getInfo)
  // ==========================================================================

  describe('format list', (): void => {
    /**
     * Runs getInfo with the given raw formats and returns the built list.
     *
     * @param formats - Raw yt-dlp format entries
     * @returns The de-duplicated quality options
     */
    async function formatsFor(formats: unknown[]): Promise<UrlMediaInfo['formats']> {
      stubExecFile(null, JSON.stringify({formats}), '');
      return (await manager.getInfo('https://example.com/v')).formats;
    }

    it('keeps the highest-bitrate format at each height', async (): Promise<void> => {
      const formats = await formatsFor([
        {format_id: 'low', height: 720, tbr: 100, vcodec: 'avc1'},
        {format_id: 'high', height: 720, tbr: 900, vcodec: 'avc1'},
      ]);

      expect(formats).toEqual([{id: 'high', label: '720p', height: 720}]);
    });

    it('sorts by height descending', async (): Promise<void> => {
      const formats = await formatsFor([
        {format_id: 'a', height: 480, tbr: 1, vcodec: 'avc1'},
        {format_id: 'b', height: 1080, tbr: 1, vcodec: 'avc1'},
        {format_id: 'c', height: 720, tbr: 1, vcodec: 'avc1'},
      ]);

      expect(formats.map((f): number => f.height)).toEqual([1080, 720, 480]);
    });

    it('drops audio-only formats', async (): Promise<void> => {
      const formats = await formatsFor([
        {format_id: 'audio', height: 720, tbr: 5, vcodec: 'none'},
      ]);

      expect(formats).toEqual([]);
    });

    it('drops formats with no height', async (): Promise<void> => {
      const formats = await formatsFor([
        {format_id: 'x', tbr: 5, vcodec: 'avc1'},
        {format_id: 'y', height: 0, tbr: 5, vcodec: 'avc1'},
      ]);

      expect(formats).toEqual([]);
    });

    it('drops formats with no vcodec at all', async (): Promise<void> => {
      const formats = await formatsFor([{format_id: 'x', height: 720, tbr: 5}]);

      expect(formats).toEqual([]);
    });

    it('treats a missing bitrate as zero', async (): Promise<void> => {
      const formats = await formatsFor([
        {format_id: 'nobitrate', height: 720, vcodec: 'avc1'},
        {format_id: 'rated', height: 720, tbr: 1, vcodec: 'avc1'},
      ]);

      expect(formats).toEqual([{id: 'rated', label: '720p', height: 720}]);
    });

    it('handles missing formats entirely', async (): Promise<void> => {
      stubExecFile(null, JSON.stringify({title: 'T'}), '');

      const info: UrlMediaInfo = await manager.getInfo('https://example.com/v');

      expect(info.formats).toEqual([]);
    });
  });

  // ==========================================================================
  // startDownload
  // ==========================================================================

  describe('startDownload', (): void => {
    beforeEach((): void => {
      vi.mocked(spawn).mockReturnValue(createFakeChild());
    });

    it('fails the job immediately when yt-dlp is missing', (): void => {
      ytdlpPath = null;
      const onUpdate = vi.fn();

      const id: string = manager.startDownload('https://example.com/v', 'video', null, 'T', null, onUpdate);

      expect(manager.getJob(id)).toMatchObject({status: 'error', errorMessage: 'yt-dlp is not installed'});
      expect(spawn).not.toHaveBeenCalled();
    });

    it('terminates option parsing before the URL', (): void => {
      manager.startDownload('https://example.com/v', 'video', null, 'T', null, vi.fn());

      const args: string[] = lastSpawnArgs();
      expect(args[args.length - 2]).toBe('--');
      expect(args[args.length - 1]).toBe('https://example.com/v');
    });

    it('extracts audio as mp3 in audio mode', (): void => {
      manager.startDownload('https://example.com/v', 'audio', null, 'T', null, vi.fn());

      const args: string[] = lastSpawnArgs();
      expect(args).toContain('-x');
      expect(args.join(' ')).toContain('--audio-format mp3');
    });

    it('requests a specific format id when given one', (): void => {
      manager.startDownload('https://example.com/v', 'video', '137', 'T', null, vi.fn());

      expect(lastSpawnArgs().join(' ')).toContain('-f 137+bestaudio/best');
    });

    it('falls back to the best pair when no format id is given', (): void => {
      manager.startDownload('https://example.com/v', 'video', null, 'T', null, vi.fn());

      expect(lastSpawnArgs().join(' ')).toContain('-f bestvideo+bestaudio/best');
    });

    it('passes the ffmpeg location when ffmpeg is installed', (): void => {
      manager.startDownload('https://example.com/v', 'video', null, 'T', null, vi.fn());

      expect(lastSpawnArgs().join(' ')).toContain('--ffmpeg-location /usr/bin/ffmpeg');
    });

    it('omits the ffmpeg location when ffmpeg is missing', (): void => {
      ffmpegPath = null;

      manager.startDownload('https://example.com/v', 'video', null, 'T', null, vi.fn());

      expect(lastSpawnArgs()).not.toContain('--ffmpeg-location');
    });

    it('writes into the downloads directory using the job id', (): void => {
      const id: string = manager.startDownload('https://example.com/v', 'video', null, 'T', null, vi.fn());

      expect(lastSpawnArgs().join(' ')).toContain(path.join(DOWNLOADS_DIR, `${id}.%(ext)s`));
    });

    it('reports the job as downloading straight away', (): void => {
      const onUpdate = vi.fn();

      const id: string = manager.startDownload('https://example.com/v', 'video', null, 'T', null, onUpdate);

      expect(onUpdate).toHaveBeenCalled();
      expect(manager.getJob(id)?.status).toBe('downloading');
    });

    it('trims the supplied title', (): void => {
      const id: string = manager.startDownload('https://example.com/v', 'video', null, '  Spaced  ', null, vi.fn());

      expect(manager.getJob(id)?.title).toBe('Spaced');
    });
  });

  // ==========================================================================
  // Progress and Failure
  // ==========================================================================

  describe('progress and failure', (): void => {
    let child: FakeChild;
    let onUpdate: ReturnType<typeof vi.fn>;
    let id: string;

    beforeEach((): void => {
      child = createFakeChild();
      vi.mocked(spawn).mockReturnValue(child);
      onUpdate = vi.fn();
      id = manager.startDownload('https://example.com/v', 'video', null, 'T', null, onUpdate);
    });

    it('parses a percentage into a 0..1 fraction', (): void => {
      child.emitStdout('[download]  42.5% of 10MiB');

      expect(manager.getJob(id)?.progress).toBeCloseTo(0.425);
    });

    it('ignores stdout without a percentage', (): void => {
      child.emitStdout('[info] Writing video subtitles');

      expect(manager.getJob(id)?.progress).toBeNull();
    });

    it('tracks the most recent percentage', (): void => {
      child.emitStdout('[download]  10.0%');
      child.emitStdout('[download]  90.0%');

      expect(manager.getJob(id)?.progress).toBeCloseTo(0.9);
    });

    it('fails with the last stderr line on a non-zero exit', (): void => {
      child.emitStderr('WARNING: noise\nERROR: HTTP 403\n');

      child.emitClose(1);

      expect(manager.getJob(id)).toMatchObject({status: 'error', errorMessage: 'ERROR: HTTP 403'});
    });

    it('falls back to the exit code when stderr is empty', (): void => {
      child.emitClose(2);

      expect(manager.getJob(id)?.errorMessage).toBe('yt-dlp exited with code 2');
    });

    it('fails the job when the process errors', (): void => {
      child.emitError(new Error('ENOENT'));

      expect(manager.getJob(id)).toMatchObject({status: 'error', errorMessage: 'ENOENT'});
    });

    it('leaves a cancelled job cancelled when the process closes', (): void => {
      manager.cancelDownload(id);

      child.emitClose(1);

      expect(manager.getJob(id)?.status).toBe('cancelled');
    });
  });

  // ==========================================================================
  // finalizeDownload
  // ==========================================================================

  describe('finalize', (): void => {
    let child: FakeChild;
    let id: string;

    /**
     * Starts a download and returns its job id.
     *
     * @param format - Download format
     * @param title - Job title
     * @returns The job id
     */
    function start(format: 'audio' | 'video', title: string): string {
      child = createFakeChild();
      vi.mocked(spawn).mockReturnValue(child);
      return manager.startDownload('https://example.com/v', format, null, title, null, vi.fn());
    }

    it('fails when no file was produced', (): void => {
      id = start('video', 'T');
      vi.mocked(readdirSync).mockReturnValue([] as unknown as ReturnType<typeof readdirSync>);

      child.emitClose(0);

      expect(manager.getJob(id)).toMatchObject({
        status: 'error',
        errorMessage: 'Download completed but no file was found',
      });
    });

    it('prefers the mp4 for a video download', (): void => {
      id = start('video', '');
      vi.mocked(readdirSync).mockReturnValue([`${id}.webm`, `${id}.mp4`] as unknown as ReturnType<typeof readdirSync>);

      child.emitClose(0);

      expect(manager.getJob(id)?.filePath).toBe(path.join(DOWNLOADS_DIR, `${id}.mp4`));
    });

    it('prefers the mp3 for an audio download', (): void => {
      id = start('audio', '');
      vi.mocked(readdirSync).mockReturnValue([`${id}.webm`, `${id}.mp3`] as unknown as ReturnType<typeof readdirSync>);

      child.emitClose(0);

      expect(manager.getJob(id)?.filePath).toBe(path.join(DOWNLOADS_DIR, `${id}.mp3`));
    });

    it('falls back to whatever was produced', (): void => {
      id = start('video', '');
      vi.mocked(readdirSync).mockReturnValue([`${id}.mkv`] as unknown as ReturnType<typeof readdirSync>);

      child.emitClose(0);

      expect(manager.getJob(id)?.filePath).toBe(path.join(DOWNLOADS_DIR, `${id}.mkv`));
    });

    it('ignores files belonging to other jobs', (): void => {
      id = start('video', '');
      vi.mocked(readdirSync).mockReturnValue(['other-job.mp4'] as unknown as ReturnType<typeof readdirSync>);

      child.emitClose(0);

      expect(manager.getJob(id)?.status).toBe('error');
    });

    it('marks a finished job done at full progress', (): void => {
      id = start('video', '');
      vi.mocked(readdirSync).mockReturnValue([`${id}.mp4`] as unknown as ReturnType<typeof readdirSync>);

      child.emitClose(0);

      expect(manager.getJob(id)).toMatchObject({status: 'done', progress: 1});
    });
  });

  // ==========================================================================
  // renameToTitle (via finalize)
  // ==========================================================================

  describe('renaming to the title', (): void => {
    let child: FakeChild;

    /**
     * Runs a completed download with the given title and returns the job.
     *
     * @param title - The job title
     * @param targetExists - Whether the renamed target already exists
     * @returns The finished job
     */
    function finishWithTitle(title: string, targetExists: boolean = false): DownloadJob | undefined {
      child = createFakeChild();
      vi.mocked(spawn).mockReturnValue(child);
      const id: string = manager.startDownload('https://example.com/v', 'video', null, title, null, vi.fn());
      vi.mocked(readdirSync).mockReturnValue([`${id}.mp4`] as unknown as ReturnType<typeof readdirSync>);
      // The constructor's directory check already ran; only the rename target matters now.
      vi.mocked(existsSync).mockReturnValue(targetExists);
      child.emitClose(0);
      return manager.getJob(id);
    }

    it('renames to the sanitized title', (): void => {
      const job: DownloadJob | undefined = finishWithTitle('My Video');

      expect(renameSync).toHaveBeenCalled();
      expect(job?.filePath).toBe(path.join(DOWNLOADS_DIR, 'My Video.mp4'));
    });

    it('strips characters that are illegal in filenames', (): void => {
      const job: DownloadJob | undefined = finishWithTitle('a/b\\c:d*e?f"g<h>i|j');

      expect(job?.filePath).toBe(path.join(DOWNLOADS_DIR, 'abcdefghij.mp4'));
    });

    it('truncates a long title to 80 characters', (): void => {
      const job: DownloadJob | undefined = finishWithTitle('x'.repeat(200));

      expect(path.basename(job?.filePath ?? '', '.mp4')).toHaveLength(80);
    });

    it('keeps the original name when the title sanitizes to nothing', (): void => {
      const job: DownloadJob | undefined = finishWithTitle('///');

      expect(renameSync).not.toHaveBeenCalled();
      expect(job?.filePath).toContain('.mp4');
    });

    it('refuses to overwrite an existing file', (): void => {
      const job: DownloadJob | undefined = finishWithTitle('Taken', true);

      expect(renameSync).not.toHaveBeenCalled();
      expect(job?.status).toBe('done');
    });

    it('keeps the original path when the rename throws', (): void => {
      vi.mocked(renameSync).mockImplementationOnce((): never => {
        throw new Error('EPERM');
      });

      const job: DownloadJob | undefined = finishWithTitle('My Video');

      expect(job?.status).toBe('done');
      expect(job?.filePath).toContain('.mp4');
    });
  });

  // ==========================================================================
  // moveToChosenPath (via finalize)
  // ==========================================================================

  describe('moving to a chosen output path', (): void => {
    const OUTPUT_PATH: string = '/Users/someone/Movies/Chosen.mp4';
    let child: FakeChild;

    /**
     * Runs a completed download that was given an output path.
     *
     * @returns The finished job
     */
    function finishWithOutputPath(): DownloadJob | undefined {
      child = createFakeChild();
      vi.mocked(spawn).mockReturnValue(child);
      const id: string = manager.startDownload('https://example.com/v', 'video', null, 'My Video', OUTPUT_PATH, vi.fn());
      vi.mocked(readdirSync).mockReturnValue([`${id}.mp4`] as unknown as ReturnType<typeof readdirSync>);
      child.emitClose(0);
      return manager.getJob(id);
    }

    it('still stages the download in the downloads directory', (): void => {
      finishWithOutputPath();

      expect(lastSpawnArgs().join(' ')).toContain(DOWNLOADS_DIR);
      expect(lastSpawnArgs()).not.toContain(OUTPUT_PATH);
    });

    it('moves the finished file to the chosen path', (): void => {
      const job: DownloadJob | undefined = finishWithOutputPath();

      expect(renameSync).toHaveBeenCalledWith(expect.stringContaining(DOWNLOADS_DIR), OUTPUT_PATH);
      expect(job?.filePath).toBe(OUTPUT_PATH);
    });

    it('does not rename to the title when a path was chosen', (): void => {
      const job: DownloadJob | undefined = finishWithOutputPath();

      expect(job?.filePath).not.toContain('My Video');
    });

    it('falls back to copy-and-delete across volumes', (): void => {
      vi.mocked(renameSync).mockImplementationOnce((): never => {
        throw new Error('EXDEV: cross-device link not permitted');
      });

      const job: DownloadJob | undefined = finishWithOutputPath();

      expect(copyFileSync).toHaveBeenCalledWith(expect.stringContaining(DOWNLOADS_DIR), OUTPUT_PATH);
      expect(unlinkSync).toHaveBeenCalled();
      expect(job?.filePath).toBe(OUTPUT_PATH);
    });

    it('keeps the staged file when the move cannot be completed', (): void => {
      vi.mocked(renameSync).mockImplementationOnce((): never => {
        throw new Error('EXDEV');
      });
      vi.mocked(copyFileSync).mockImplementationOnce((): never => {
        throw new Error('ENOSPC');
      });

      const job: DownloadJob | undefined = finishWithOutputPath();

      expect(job?.status).toBe('done');
      expect(job?.filePath).toContain(DOWNLOADS_DIR);
    });
  });

  // ==========================================================================
  // cancelDownload
  // ==========================================================================

  describe('cancelDownload', (): void => {
    it('kills the process and marks the job cancelled', (): void => {
      const child: FakeChild = createFakeChild();
      vi.mocked(spawn).mockReturnValue(child);
      const id: string = manager.startDownload('https://example.com/v', 'video', null, 'T', null, vi.fn());

      expect(manager.cancelDownload(id)).toBe(true);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(manager.getJob(id)).toMatchObject({status: 'cancelled', errorMessage: 'Cancelled'});
    });

    it('returns false for an unknown job', (): void => {
      expect(manager.cancelDownload('nope')).toBe(false);
    });

    it('returns false for a job that is already finished', (): void => {
      const child: FakeChild = createFakeChild();
      vi.mocked(spawn).mockReturnValue(child);
      const id: string = manager.startDownload('https://example.com/v', 'video', null, '', null, vi.fn());
      vi.mocked(readdirSync).mockReturnValue([`${id}.mp4`] as unknown as ReturnType<typeof readdirSync>);
      child.emitClose(0);

      expect(manager.cancelDownload(id)).toBe(false);
    });

    it('returns false when cancelled twice', (): void => {
      vi.mocked(spawn).mockReturnValue(createFakeChild());
      const id: string = manager.startDownload('https://example.com/v', 'video', null, 'T', null, vi.fn());
      manager.cancelDownload(id);

      expect(manager.cancelDownload(id)).toBe(false);
    });
  });

  // ==========================================================================
  // resolveStreamSources
  // ==========================================================================

  describe('resolveStreamSources', (): void => {
    it('rejects when yt-dlp is missing', async (): Promise<void> => {
      ytdlpPath = null;

      await expect(manager.resolveStreamSources('https://example.com/v', 'video', null))
        .rejects.toThrow('yt-dlp is not installed');
    });

    it('requests bestaudio for audio', async (): Promise<void> => {
      stubExecFile(null, 'https://cdn/audio\n');

      await manager.resolveStreamSources('https://example.com/v', 'audio', null);

      expect(lastExecFileArgs()).toContain('bestaudio');
    });

    it('builds the full fallback chain for video', async (): Promise<void> => {
      stubExecFile(null, 'https://cdn/video\n');

      await manager.resolveStreamSources('https://example.com/v', 'video', null);

      const selector: string = lastExecFileArgs()[2];
      expect(selector.split('/')).toEqual([
        'bestvideo[ext=mp4]+bestaudio[ext=m4a]',
        'bestvideo+bestaudio',
        'best[ext=mp4]',
        'best',
      ]);
    });

    it('applies a height cap to every video selector', async (): Promise<void> => {
      stubExecFile(null, 'https://cdn/video\n');

      await manager.resolveStreamSources('https://example.com/v', 'video', 720);

      const selector: string = lastExecFileArgs()[2];
      expect(selector).toContain('bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]');
      expect(selector).toContain('best[height<=720]');
    });

    it('splits a DASH pair into video and audio', async (): Promise<void> => {
      stubExecFile(null, 'https://cdn/video\nhttps://cdn/audio\n');

      const sources: StreamSources = await manager.resolveStreamSources('https://example.com/v', 'video', null);

      expect(sources).toEqual({video: 'https://cdn/video', audio: 'https://cdn/audio'});
    });

    it('reports no separate audio for a progressive stream', async (): Promise<void> => {
      stubExecFile(null, 'https://cdn/progressive\n');

      const sources: StreamSources = await manager.resolveStreamSources('https://example.com/v', 'video', null);

      expect(sources).toEqual({video: 'https://cdn/progressive', audio: null});
    });

    it('never reports separate audio in audio mode', async (): Promise<void> => {
      stubExecFile(null, 'https://cdn/a\nhttps://cdn/b\n');

      const sources: StreamSources = await manager.resolveStreamSources('https://example.com/v', 'audio', null);

      expect(sources).toEqual({video: 'https://cdn/a', audio: null});
    });

    it('rejects when yt-dlp returns nothing', async (): Promise<void> => {
      stubExecFile(null, '\n  \n');

      await expect(manager.resolveStreamSources('https://example.com/v', 'video', null))
        .rejects.toThrow('No streamable URL found');
    });

    it('reports the last stderr line on failure', async (): Promise<void> => {
      stubExecFile(new Error('exit 1'), '', 'ERROR: Sign in to confirm your age\n');

      await expect(manager.resolveStreamSources('https://example.com/v', 'video', null))
        .rejects.toThrow('ERROR: Sign in to confirm your age');
    });

    it('terminates option parsing before the URL', async (): Promise<void> => {
      stubExecFile(null, 'https://cdn/v\n');

      await manager.resolveStreamSources('https://example.com/v', 'video', null);

      const args: string[] = lastExecFileArgs();
      expect(args[args.length - 2]).toBe('--');
    });
  });

  // ==========================================================================
  // getJob
  // ==========================================================================

  describe('getJob', (): void => {
    it('returns undefined for an unknown id', (): void => {
      expect(manager.getJob('nope')).toBeUndefined();
    });
  });
});

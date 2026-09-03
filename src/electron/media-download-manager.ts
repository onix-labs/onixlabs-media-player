/**
 * @fileoverview yt-dlp wrapper for playing media from internet URLs.
 *
 * This module is the TypeScript/Electron equivalent of ReClip's Python backend
 * (docs/reclip-main/app.py). It drives the `yt-dlp` binary to:
 * - Resolve metadata and available quality formats for a URL (`getInfo`)
 * - Download a URL to a local file for robust, seekable playback (`startDownload`)
 * - Resolve direct video/audio stream URL(s) for streaming (`resolveStreamSources`)
 *
 * Downloaded files and resolved URLs are both consumed by the existing media
 * pipeline: ffprobe and ffmpeg accept local paths and http(s) URLs alike, so a
 * playlist item's `filePath` may be either. This keeps the download and stream
 * paths converging on the same playback code.
 *
 * @module electron/media-download-manager
 */

import {spawn, ChildProcess, execFile} from 'child_process';
import {randomUUID} from 'crypto';
import {copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync} from 'fs';
import * as path from 'path';
import {createScopedLogger, logProcessSpawn, logProcessExit} from './logger.js';
import type {UrlMediaInfo, UrlFormat, UrlMediaFormat, DownloadJob} from './media-types.js';

/** Scoped logger for URL download operations */
const downloadLogger: ReturnType<typeof createScopedLogger> = createScopedLogger('Download');

/** Timeout (ms) for resolving URL metadata via `yt-dlp -j` */
const INFO_TIMEOUT_MS: number = 60 * 1000;

/** Timeout (ms) for resolving a direct stream URL via `yt-dlp -g` */
const RESOLVE_TIMEOUT_MS: number = 60 * 1000;

/** Maximum stdout/stderr buffer (bytes) for the JSON metadata of one URL */
const INFO_MAX_BUFFER: number = 64 * 1024 * 1024;

/** Maximum length of a sanitized title used as a download filename */
const MAX_TITLE_LENGTH: number = 80;

/** Number of trailing stderr bytes retained for diagnosing a failed download */
const STDERR_TAIL_BYTES: number = 2048;

/** Characters not allowed in filenames across platforms */
const ILLEGAL_FILENAME_CHARS: RegExp = /[\\/:*?"<>|]/g;

/** Matches yt-dlp's per-line download progress percentage */
const PROGRESS_PERCENT: RegExp = /\[download\]\s+([\d.]+)%/;

/**
 * The resolved direct URL(s) for a streamed source.
 *
 * For adaptive (DASH) video the video and audio arrive as separate streams that
 * must be muxed; for progressive video or audio-only, `audio` is null and
 * `video` holds the single stream.
 */
export interface StreamSources {
  /** Direct URL of the video stream (or the only stream for audio-only). */
  readonly video: string;
  /** Direct URL of the separate audio stream to mux in, or null when none. */
  readonly audio: string | null;
}

/**
 * Subset of the yt-dlp `-j` JSON output that this module consumes.
 */
interface YtDlpInfoJson {
  readonly title?: string;
  readonly thumbnail?: string;
  readonly duration?: number;
  readonly uploader?: string;
  readonly formats?: ReadonlyArray<{
    readonly format_id: string;
    readonly height?: number | null;
    readonly vcodec?: string;
    readonly tbr?: number | null;
  }>;
}

/**
 * Drives the yt-dlp binary to fetch, download, and resolve internet media.
 *
 * The manager is stateless except for an in-memory map of download jobs,
 * mirroring the `jobs` dictionary in ReClip's app.py.
 */
export class MediaDownloadManager {
  /**
   * Rejects anything that is not a plain http(s) URL before it reaches yt-dlp.
   *
   * yt-dlp accepts a wide range of inputs, including local file paths, so
   * without this a caller could point it at the filesystem or at schemes the
   * player has no business fetching.
   *
   * @param url - Candidate URL
   * @throws Error if the URL is malformed or not http(s)
   */
  private static assertSupportedUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid URL');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Unsupported URL: only http and https are allowed');
    }
  }

  /** Resolves the current yt-dlp binary path (null when not installed) */
  private readonly getYtDlpPath: () => string | null;

  /** Resolves the current ffmpeg binary path, passed to yt-dlp for merging */
  private readonly getFfmpegPath: () => string | null;

  /** Directory where downloaded files are written */
  private readonly downloadsDir: string;

  /** In-flight and completed download jobs, keyed by job id */
  private readonly jobs: Map<string, DownloadJob> = new Map();

  /** Running yt-dlp processes, keyed by job id (for cancellation) */
  private readonly processes: Map<string, ChildProcess> = new Map();

  /**
   * Creates a new download manager.
   *
   * @param getYtDlpPath - Accessor for the yt-dlp binary path (re-read each call
   *   so install/uninstall is picked up without reconstructing the manager)
   * @param getFfmpegPath - Accessor for the ffmpeg binary path
   * @param downloadsDir - Absolute path to the downloads directory (created if absent)
   */
  public constructor(
    getYtDlpPath: () => string | null,
    getFfmpegPath: () => string | null,
    downloadsDir: string
  ) {
    this.getYtDlpPath = getYtDlpPath;
    this.getFfmpegPath = getFfmpegPath;
    this.downloadsDir = downloadsDir;

    if (!existsSync(this.downloadsDir)) {
      mkdirSync(this.downloadsDir, {recursive: true});
      downloadLogger.info(`Created downloads directory: ${this.downloadsDir}`);
    }
  }

  // ==========================================================================
  // Metadata
  // ==========================================================================

  /**
   * Resolves metadata and quality formats for a URL via `yt-dlp -j`.
   *
   * Collapses the raw format list to one entry per video resolution (keeping the
   * highest-bitrate format at each height), mirroring ReClip's /api/info logic.
   *
   * @param url - The page URL to inspect
   * @returns Metadata including title, thumbnail, duration, and quality options
   * @throws Error if yt-dlp is missing, times out, or the URL is unsupported
   */
  public getInfo(url: string): Promise<UrlMediaInfo> {
    return new Promise((resolve: (value: UrlMediaInfo) => void, reject: (reason: Error) => void): void => {
      const ytdlp: string | null = this.getYtDlpPath();
      if (!ytdlp) {
        reject(new Error('yt-dlp is not installed'));
        return;
      }

      try {
        MediaDownloadManager.assertSupportedUrl(url);
      } catch (err) {
        reject(err as Error);
        return;
      }

      // '--' terminates option parsing: without it a URL beginning with '-'
      // is interpreted by yt-dlp as a flag.
      const args: string[] = ['--no-playlist', '-j', '--', url];
      logProcessSpawn(downloadLogger, 'yt-dlp', args);

      execFile(
        ytdlp,
        args,
        {timeout: INFO_TIMEOUT_MS, maxBuffer: INFO_MAX_BUFFER},
        (error: Error | null, stdout: string, stderr: string): void => {
          if (error) {
            const message: string = this.lastErrorLine(stderr) || error.message;
            downloadLogger.error(`getInfo failed: ${message}`);
            reject(new Error(message));
            return;
          }

          try {
            const info: YtDlpInfoJson = JSON.parse(stdout) as YtDlpInfoJson;
            resolve({
              title: info.title ?? '',
              thumbnail: info.thumbnail ?? '',
              duration: info.duration ?? null,
              uploader: info.uploader ?? '',
              formats: this.buildFormats(info),
            });
          } catch (parseError: unknown) {
            const message: string = parseError instanceof Error ? parseError.message : 'Failed to parse yt-dlp output';
            reject(new Error(message));
          }
        }
      );
    });
  }

  /**
   * Builds the de-duplicated quality list from raw yt-dlp formats.
   * Keeps the highest-bitrate video format at each distinct height.
   */
  private buildFormats(info: YtDlpInfoJson): UrlFormat[] {
    const bestByHeight: Map<number, {id: string; tbr: number}> = new Map();

    for (const format of info.formats ?? []) {
      const height: number | null | undefined = format.height;
      const hasVideo: boolean = format.vcodec !== undefined && format.vcodec !== 'none';
      if (!height || !hasVideo) {
        continue;
      }
      const tbr: number = format.tbr ?? 0;
      const existing: {id: string; tbr: number} | undefined = bestByHeight.get(height);
      if (!existing || tbr > existing.tbr) {
        bestByHeight.set(height, {id: format.format_id, tbr});
      }
    }

    return Array.from(bestByHeight.entries())
      .map(([height, best]: [number, {id: string; tbr: number}]): UrlFormat => ({
        id: best.id,
        label: `${height}p`,
        height,
      }))
      .sort((a: UrlFormat, b: UrlFormat): number => b.height - a.height);
  }

  // ==========================================================================
  // Download
  // ==========================================================================

  /**
   * Starts an asynchronous download of a URL to a local file.
   *
   * The returned job is tracked in memory; callers poll {@link getJob} or react
   * to the supplied progress callback. yt-dlp always writes into the downloads
   * directory first, because the final extension is only known once the merge
   * or audio extraction has run. On success the finished file is moved to
   * `outputPath` when the caller chose one (the Save As dialog), and otherwise
   * renamed to a sanitized title in place; either way the job's `filePath`
   * points at the file that playback should use.
   *
   * @param url - The page URL to download
   * @param format - 'video' (MP4) or 'audio' (MP3 extraction)
   * @param formatId - Optional yt-dlp format id for a specific video resolution
   * @param title - Optional title used to name the resulting file
   * @param outputPath - Absolute path the finished file is moved to, or null to
   *   leave it in the downloads directory under its sanitized title
   * @param onUpdate - Called whenever the job's status or progress changes
   * @returns The newly created job's id
   */
  public startDownload(
    url: string,
    format: UrlMediaFormat,
    formatId: string | null,
    title: string,
    outputPath: string | null,
    onUpdate: (job: Readonly<DownloadJob>) => void
  ): string {
    const id: string = randomUUID().slice(0, 12);
    const job: DownloadJob = {
      id,
      url,
      format,
      status: 'downloading',
      progress: null,
      title: title.trim(),
      filePath: null,
      errorMessage: null,
    };
    this.jobs.set(id, job);

    const ytdlp: string | null = this.getYtDlpPath();
    if (!ytdlp) {
      this.failJob(job, 'yt-dlp is not installed', onUpdate);
      return id;
    }

    try {
      MediaDownloadManager.assertSupportedUrl(url);
    } catch (err) {
      this.failJob(job, (err as Error).message, onUpdate);
      return id;
    }

    const outputTemplate: string = path.join(this.downloadsDir, `${id}.%(ext)s`);
    const args: string[] = ['--no-playlist', '--newline', '-o', outputTemplate];

    const ffmpeg: string | null = this.getFfmpegPath();
    if (ffmpeg) {
      args.push('--ffmpeg-location', ffmpeg);
    }

    if (format === 'audio') {
      args.push('-x', '--audio-format', 'mp3');
    } else if (formatId) {
      args.push('-f', `${formatId}+bestaudio/best`, '--merge-output-format', 'mp4');
    } else {
      args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4');
    }
    // '--' terminates option parsing (see assertSupportedUrl / getInfo).
    args.push('--', url);

    logProcessSpawn(downloadLogger, 'yt-dlp', args);
    const child: ChildProcess = spawn(ytdlp, args);
    this.processes.set(id, child);

    let stderrTail: string = '';

    child.stdout?.on('data', (data: Readonly<Buffer>): void => {
      const match: RegExpMatchArray | null = data.toString().match(PROGRESS_PERCENT);
      if (match) {
        const percent: number = parseFloat(match[1]);
        if (!Number.isNaN(percent)) {
          job.progress = percent / 100;
          onUpdate(job);
        }
      }
    });

    child.stderr?.on('data', (data: Readonly<Buffer>): void => {
      stderrTail = (stderrTail + data.toString()).slice(-STDERR_TAIL_BYTES);
    });

    child.on('close', (code: number | null): void => {
      logProcessExit(downloadLogger, 'yt-dlp', code, null);
      this.processes.delete(id);

      if (job.status === 'cancelled') {
        onUpdate(job);
        return;
      }
      if (code !== 0) {
        this.failJob(job, this.lastErrorLine(stderrTail) || `yt-dlp exited with code ${code}`, onUpdate);
        return;
      }
      this.finalizeDownload(job, outputPath, onUpdate);
    });

    child.on('error', (error: Readonly<Error>): void => {
      this.processes.delete(id);
      this.failJob(job, error.message, onUpdate);
    });

    onUpdate(job);
    return id;
  }

  /**
   * Locates the finished file, moves it to its final home, and marks the job
   * done. Called once yt-dlp exits successfully.
   *
   * @param job - The job being finalized
   * @param outputPath - Destination chosen by the user, or null to keep the
   *   file in the downloads directory under a sanitized title
   * @param onUpdate - Called with the finished (or failed) job
   */
  private finalizeDownload(job: DownloadJob, outputPath: string | null, onUpdate: (job: Readonly<DownloadJob>) => void): void {
    const produced: string[] = readdirSync(this.downloadsDir)
      .filter((name: string): boolean => name.startsWith(`${job.id}.`))
      .map((name: string): string => path.join(this.downloadsDir, name));

    if (produced.length === 0) {
      this.failJob(job, 'Download completed but no file was found', onUpdate);
      return;
    }

    // Prefer the expected container; fall back to whatever yt-dlp produced.
    const preferredExt: string = job.format === 'audio' ? '.mp3' : '.mp4';
    const chosen: string = produced.find((f: string): boolean => f.toLowerCase().endsWith(preferredExt)) ?? produced[0];

    job.filePath = outputPath ? this.moveToChosenPath(chosen, outputPath) : this.renameToTitle(chosen, job.title);
    job.progress = 1;
    job.status = 'done';
    downloadLogger.info(`Download complete: ${path.basename(job.filePath)}`);
    onUpdate(job);
  }

  /**
   * Renames a downloaded file to "<sanitized title><ext>" when the target name
   * is free. Returns the new path, or the original on any collision or error.
   */
  private renameToTitle(filePath: string, title: string): string {
    const safeTitle: string = title.replace(ILLEGAL_FILENAME_CHARS, '').trim().slice(0, MAX_TITLE_LENGTH).trim();
    if (!safeTitle) {
      return filePath;
    }
    const ext: string = path.extname(filePath);
    const target: string = path.join(this.downloadsDir, `${safeTitle}${ext}`);
    if (existsSync(target)) {
      return filePath;
    }
    try {
      renameSync(filePath, target);
      return target;
    } catch (error: unknown) {
      downloadLogger.warn(`Could not rename download to title: ${error instanceof Error ? error.message : error}`);
      return filePath;
    }
  }

  /**
   * Moves a finished download to the path the user picked in the Save As
   * dialog. Overwriting is intentional: the dialog already asked.
   *
   * A plain rename fails across devices, and the downloads directory often sits
   * on a different volume from the user's chosen destination (an external disk,
   * a network share), so fall back to copy-then-delete. If even that fails the
   * staged path is returned so playback still gets a usable file.
   *
   * @param filePath - The staged file in the downloads directory
   * @param outputPath - Absolute destination path chosen by the user
   * @returns The destination path, or the staged path if the move failed
   */
  private moveToChosenPath(filePath: string, outputPath: string): string {
    try {
      renameSync(filePath, outputPath);
      return outputPath;
    } catch {
      try {
        copyFileSync(filePath, outputPath);
        unlinkSync(filePath);
        return outputPath;
      } catch (error: unknown) {
        downloadLogger.warn(`Could not move download to ${outputPath}: ${error instanceof Error ? error.message : error}`);
        return filePath;
      }
    }
  }

  /**
   * Cancels an in-flight download, killing its yt-dlp process.
   *
   * @param id - The job id to cancel
   * @returns True if a running job was cancelled
   */
  public cancelDownload(id: string): boolean {
    const job: DownloadJob | undefined = this.jobs.get(id);
    const child: ChildProcess | undefined = this.processes.get(id);
    if (!job || job.status !== 'downloading') {
      return false;
    }
    job.status = 'cancelled';
    job.errorMessage = 'Cancelled';
    child?.kill('SIGKILL');
    this.processes.delete(id);
    downloadLogger.info(`Download cancelled: ${id}`);
    return true;
  }

  /**
   * Gets the current state of a download job.
   *
   * @param id - The job id
   * @returns The job, or undefined if unknown
   */
  public getJob(id: string): DownloadJob | undefined {
    return this.jobs.get(id);
  }

  // ==========================================================================
  // Stream resolution
  // ==========================================================================

  /**
   * Resolves the direct stream URL(s) for a source via `yt-dlp -g`.
   *
   * For video, an adaptive (DASH) MP4 video stream and a separate M4A audio
   * stream are requested so resolutions above 360p are available — YouTube only
   * serves combined audio+video (progressive) up to 360p; everything higher is
   * DASH. The two URLs are muxed together by the media server with ffmpeg. MP4
   * video (H.264/AV1) and M4A audio (AAC) are preferred so the muxed output
   * remuxes cleanly into a fragmented MP4 the browser can play. The selector
   * falls back to a single progressive file when no adaptive pair exists.
   *
   * Note: heights only available as VP9/WebM (e.g. some 1440p/2160p) fall back
   * to the best MP4 (typically 1080p), since those don't remux into MP4.
   *
   * @param url - The page URL to resolve
   * @param format - 'video' or 'audio'
   * @param maxHeight - Optional cap on video height (e.g., 720 for 720p)
   * @returns The resolved video and (optional) separate audio stream URLs
   * @throws Error if yt-dlp is missing, times out, or no stream is available
   */
  public resolveStreamSources(url: string, format: UrlMediaFormat, maxHeight: number | null): Promise<StreamSources> {
    return new Promise((resolve: (value: StreamSources) => void, reject: (reason: Error) => void): void => {
      const ytdlp: string | null = this.getYtDlpPath();
      if (!ytdlp) {
        reject(new Error('yt-dlp is not installed'));
        return;
      }

      const heightFilter: string = maxHeight ? `[height<=${maxHeight}]` : '';
      // Prefer an MP4(H.264)+M4A(AAC) adaptive pair (cleanest remux), then ANY
      // adaptive video+audio pair at the target height, and only as a last
      // resort a progressive single file (YouTube caps those at 360p). Listing
      // the generic pair before the progressive fallback prevents silently
      // dropping to 360p when the mp4/m4a-specific pair isn't available.
      const selector: string = format === 'audio'
        ? 'bestaudio'
        : [
            `bestvideo[ext=mp4]${heightFilter}+bestaudio[ext=m4a]`,
            `bestvideo${heightFilter}+bestaudio`,
            `best[ext=mp4]${heightFilter}`,
            `best${heightFilter}`,
          ].join('/');

      try {
        MediaDownloadManager.assertSupportedUrl(url);
      } catch (err) {
        reject(err as Error);
        return;
      }

      // '--' terminates option parsing (see assertSupportedUrl / getInfo).
      const args: string[] = ['--no-playlist', '-f', selector, '-g', '--', url];
      logProcessSpawn(downloadLogger, 'yt-dlp', args);

      execFile(
        ytdlp,
        args,
        {timeout: RESOLVE_TIMEOUT_MS},
        (error: Error | null, stdout: string, stderr: string): void => {
          if (error) {
            const message: string = this.lastErrorLine(stderr) || error.message;
            downloadLogger.error(`resolveStreamSources failed: ${message}`);
            reject(new Error(message));
            return;
          }
          // `-g` prints one URL per line. A "video+audio" selector prints the
          // video URL first then the audio URL; a single (progressive/audio)
          // format prints just one.
          const urls: string[] = stdout.split('\n').map((line: string): string => line.trim()).filter(Boolean);
          if (urls.length === 0) {
            reject(new Error('No streamable URL found'));
            return;
          }
          downloadLogger.info(`resolveStreamSources: format=${format}, maxHeight=${maxHeight ?? 'any'}, resolved ${urls.length} URL(s) (${urls.length > 1 ? 'DASH pair → muxing' : 'single/progressive stream'})`);
          if (format === 'audio') {
            resolve({video: urls[0], audio: null});
            return;
          }
          resolve({video: urls[0], audio: urls.length > 1 ? urls[1] : null});
        }
      );
    });
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /** Marks a job as failed and notifies the caller. */
  private failJob(job: DownloadJob, message: string, onUpdate: (job: Readonly<DownloadJob>) => void): void {
    job.status = 'error';
    job.errorMessage = message;
    downloadLogger.error(`Download failed (${job.id}): ${message}`);
    onUpdate(job);
  }

  /** Returns the last non-empty line of yt-dlp stderr, used as a concise error. */
  private lastErrorLine(stderr: string): string {
    const lines: string[] = stderr.split('\n').map((line: string): string => line.trim()).filter(Boolean);
    return lines.length > 0 ? lines[lines.length - 1] : '';
  }
}

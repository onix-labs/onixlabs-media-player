/**
 * @fileoverview Dependency management for the external programs ONIXPlayer runs.
 *
 * ONIXPlayer never asks a package manager for anything. Its dependencies reach
 * the user in one of two ways:
 * - Bundled: FFmpeg, ffprobe and FluidSynth ship inside the app (built by
 *   scripts/build-binaries.sh). FFmpeg is built with libopenmpt, which is what
 *   plays tracker modules.
 * - Downloaded: yt-dlp changes more often than ONIXPlayer is released, so it is
 *   downloaded on request from its official GitHub releases into the app's
 *   user data folder, verified against the release's SHA-256 sums.
 *
 * A copy found on the system is used as a fallback, which keeps development
 * runs working before scripts/build-binaries.sh has been run.
 *
 * This module also manages the SoundFont files the user installs for MIDI
 * playback (none ship with the app), and detects the hardware video encoders
 * FFmpeg offers.
 *
 * @module electron/dependency-manager
 */

import {existsSync, mkdirSync, copyFileSync, unlinkSync, readdirSync, statSync, readFileSync, writeFileSync, chmodSync, createWriteStream, WriteStream} from 'fs';
import {rm, rename} from 'fs/promises';
import {spawn, ChildProcess, execFileSync, execFile} from 'child_process';
import {createHash, Hash} from 'crypto';
import * as path from 'path';
import {createScopedLogger, logProcessSpawn} from './logger.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Identifier for a managed dependency.
 */
export type DependencyId = 'ffmpeg' | 'fluidsynth' | 'yt-dlp';

/**
 * Where a dependency's binary was found.
 * - bundled: shipped inside ONIXPlayer
 * - downloaded: fetched by ONIXPlayer into its user data folder
 * - system: installed on the machine by some other means
 */
export type DependencySource = 'bundled' | 'downloaded' | 'system';

/**
 * Status of a single dependency.
 */
export interface DependencyStatus {
  /** Unique identifier */
  readonly id: DependencyId;
  /** Human-readable name */
  readonly name: string;
  /** Whether the binary was found */
  readonly installed: boolean;
  /** Absolute path to the binary, or null if not found */
  readonly path: string | null;
  /** Where the binary came from, or null if not found */
  readonly source: DependencySource | null;
  /** Version, when known (bundled and downloaded binaries record theirs) */
  readonly version: string | null;
  /** Whether ONIXPlayer can download, update and remove this dependency itself */
  readonly managed: boolean;
  /** Description of what this dependency enables */
  readonly description: string;
  /** Project website */
  readonly websiteUrl: string;
}

/**
 * Overall dependency state broadcast to the renderer.
 */
export interface DependencyState {
  /** FFmpeg status (required for audio/video playback) */
  readonly ffmpeg: DependencyStatus;
  /** FluidSynth status (required for MIDI playback) */
  readonly fluidsynth: DependencyStatus;
  /** yt-dlp status (required for playing media from internet URLs) */
  readonly ytdlp: DependencyStatus;
  /** Whether the FFmpeg in use can decode tracker modules (built with libopenmpt) */
  readonly trackerSupport: boolean;
  /** Whether MIDI can be played: FluidSynth is present and a SoundFont is installed */
  readonly midiSupport: boolean;
  /** Installed SoundFont files in the app data directory */
  readonly soundfonts: SoundFontInfo[];
  /** Path to the active SoundFont */
  readonly activeSoundFont: string | null;
  /** Available hardware video encoders */
  readonly hardwareEncoders: HardwareEncoderInfo;
}

/**
 * Information about an installed SoundFont file.
 */
export interface SoundFontInfo {
  /** File name (e.g., "FluidR3_GM.sf2") */
  readonly fileName: string;
  /** Absolute path to the file */
  readonly filePath: string;
  /** File size in bytes */
  readonly sizeBytes: number;
}

/**
 * Information about available hardware video encoders.
 */
export interface HardwareEncoderInfo {
  /** Whether any hardware encoders are available */
  readonly available: boolean;
  /** List of available encoder names (e.g., ['h264_videotoolbox', 'h264_nvenc']) */
  readonly encoders: readonly string[];
}

/**
 * Progress update while a dependency is downloaded, updated or removed.
 */
export interface InstallProgress {
  /** Which dependency is being operated on */
  readonly dependencyId: DependencyId;
  /** Current operation status */
  readonly status: 'installing' | 'uninstalling' | 'updating' | 'success' | 'error';
  /** Human-readable status message */
  readonly message: string;
  /** Detail output (errors, checksums) */
  readonly output?: string;
  /** Download progress from 0 to 100, when known */
  readonly percent?: number;
}

/**
 * The subset of the Fetch API the downloader needs. Injected so the app can
 * route requests through Electron's network stack (which honours the system
 * proxy) and so tests can stub the network.
 */
export type FetchFunction = (input: string, init?: {readonly headers?: Record<string, string>}) => Promise<Response>;

/**
 * Optional collaborators and locations for a DependencyManager.
 */
export interface DependencyManagerOptions {
  /** CPU architecture (process.arch); selects the yt-dlp build */
  readonly arch?: string;
  /** Directory holding the bundled ffmpeg, ffprobe and fluidsynth, or null */
  readonly bundledBinDir?: string | null;
  /** Fetch implementation for downloads (defaults to the global fetch) */
  readonly fetch?: FetchFunction;
  /** Node-compatible executable yt-dlp may use as its JavaScript runtime */
  readonly jsRuntimePath?: string | null;
}

/**
 * A yt-dlp release asset for one platform.
 */
interface YtDlpAsset {
  /** Asset file name on the GitHub release */
  readonly asset: string;
  /** Whether the asset is a zip to extract rather than the executable itself */
  readonly archive: boolean;
  /** Executable name inside the install directory */
  readonly executable: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Scoped logger for dependency operations */
const depsLogger: ReturnType<typeof createScopedLogger> = createScopedLogger('Deps');

/** Descriptions for each dependency */
const DEPENDENCY_DESCRIPTIONS: Readonly<Record<DependencyId, string>> = {
  ffmpeg: 'Audio, video and tracker module playback',
  fluidsynth: 'MIDI playback',
  'yt-dlp': 'Playing video and audio from internet URLs',
};

/** Project websites */
const WEBSITE_URLS: Readonly<Record<DependencyId, string>> = {
  ffmpeg: 'https://ffmpeg.org/',
  fluidsynth: 'https://www.fluidsynth.org/',
  'yt-dlp': 'https://github.com/yt-dlp/yt-dlp',
};

/** Display names */
const DEPENDENCY_NAMES: Readonly<Record<DependencyId, string>> = {
  ffmpeg: 'FFmpeg',
  fluidsynth: 'FluidSynth',
  'yt-dlp': 'yt-dlp',
};

/** GitHub API endpoint for yt-dlp's latest release */
const YTDLP_LATEST_RELEASE_URL: string = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';

/** Base URL for a yt-dlp release's assets; the tag is appended */
const YTDLP_DOWNLOAD_BASE_URL: string = 'https://github.com/yt-dlp/yt-dlp/releases/download';

/** Checksum file published with every yt-dlp release */
const YTDLP_CHECKSUMS_ASSET: string = 'SHA2-256SUMS';

/** File in an install directory recording the version it holds */
const VERSION_FILE: string = 'version.txt';

/** File the build script writes beside the bundled binaries, naming their versions */
const BUNDLED_VERSIONS_FILE: string = 'versions.json';

/** Permissions for a downloaded executable: rwxr-xr-x */
const EXECUTABLE_MODE: number = 0o755;

// ============================================================================
// DependencyManager Class
// ============================================================================

/**
 * Locates ONIXPlayer's external programs, downloads yt-dlp, and manages
 * SoundFont files.
 */
export class DependencyManager {
  /** Current platform */
  private readonly platform: NodeJS.Platform;

  /** Current CPU architecture */
  private readonly arch: string;

  /** Path to the soundfonts directory in user data */
  private readonly soundFontDir: string;

  /** Directory yt-dlp is downloaded into */
  private readonly ytdlpDir: string;

  /** Directory holding the bundled binaries, or null if there is none */
  private readonly bundledBinDir: string | null;

  /** Fetch implementation for downloads */
  private readonly fetchFn: FetchFunction;

  /** Executable yt-dlp may run JavaScript with, or null */
  private readonly jsRuntimePath: string | null;

  /** Versions of the bundled binaries, read from versions.json */
  private readonly bundledVersions: Readonly<Record<string, string>>;

  /** Resolved paths (mutable, refreshed after a download or removal) */
  private ffmpegPath: string | null = null;
  private ffprobePath: string | null = null;
  private fluidsynthPath: string | null = null;
  private ytdlpPath: string | null = null;

  /** Whether the FFmpeg in use has the libopenmpt demuxer */
  private trackerSupport: boolean = false;

  /** Detected hardware video encoders (populated asynchronously after detectBinaries) */
  private hardwareEncoders: HardwareEncoderInfo = {available: false, encoders: []};

  /** Whether a yt-dlp download or removal is running */
  private operationInProgress: boolean = false;

  /** How long to let the `ffmpeg -encoders` probe run before giving up on it. */
  private static readonly HW_ENCODER_TIMEOUT_MS: number = 10000;

  /**
   * Creates a new DependencyManager instance.
   *
   * @param platform - The current platform (process.platform)
   * @param userDataPath - Path to the app's userData directory (app.getPath('userData'))
   * @param options - Bundled resource locations and collaborators
   */
  public constructor(platform: NodeJS.Platform, userDataPath: string, options: DependencyManagerOptions = {}) {
    this.platform = platform;
    this.arch = options.arch ?? process.arch;
    this.soundFontDir = path.join(userDataPath, 'soundfonts');
    this.ytdlpDir = path.join(userDataPath, 'yt-dlp');
    this.bundledBinDir = options.bundledBinDir ?? null;
    this.fetchFn = options.fetch ?? ((input: string, init?: {readonly headers?: Record<string, string>}): Promise<Response> => fetch(input, init));
    this.jsRuntimePath = options.jsRuntimePath ?? null;
    this.bundledVersions = this.readBundledVersions();

    // Ensure soundfonts directory exists
    if (!existsSync(this.soundFontDir)) {
      mkdirSync(this.soundFontDir, {recursive: true});
      depsLogger.info(`Created soundfonts directory: ${this.soundFontDir}`);
    }

    // detectBinaries ends in detectHardwareEncoders, so it is not called again here.
    this.detectBinaries();
  }

  // ============================================================================
  // Binary Detection
  // ============================================================================

  /**
   * Re-scans for all binaries.
   * Called at startup and after yt-dlp is downloaded or removed.
   */
  public detectBinaries(): void {
    this.ffmpegPath = this.findBinary('ffmpeg');
    this.ffprobePath = this.findBinary('ffprobe');
    this.fluidsynthPath = this.findBinary('fluidsynth');
    this.ytdlpPath = this.findYtDlp();
    this.trackerSupport = this.detectTrackerSupport();

    depsLogger.info(`FFmpeg: ${this.ffmpegPath ?? 'not found'}`);
    depsLogger.info(`FFprobe: ${this.ffprobePath ?? 'not found'}`);
    depsLogger.info(`FluidSynth: ${this.fluidsynthPath ?? 'not found'}`);
    depsLogger.info(`yt-dlp: ${this.ytdlpPath ?? 'not found'}`);
    depsLogger.info(`Tracker modules: ${this.trackerSupport ? 'supported' : 'unsupported (FFmpeg lacks libopenmpt)'}`);

    // Re-detect hardware encoders when binaries are re-scanned
    this.detectHardwareEncoders();
  }

  /**
   * Determines whether the FFmpeg in use can decode tracker modules.
   *
   * The bundled FFmpeg is always built with libopenmpt, so it is not probed;
   * that keeps startup free of a synchronous spawn in the packaged app. A
   * system FFmpeg (development runs) may or may not have it, so it is asked.
   */
  private detectTrackerSupport(): boolean {
    if (!this.ffmpegPath) return false;
    if (this.getSource(this.ffmpegPath) === 'bundled') return true;

    try {
      const output: string = execFileSync(this.ffmpegPath, ['-hide_banner', '-demuxers'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /\blibopenmpt\b/.test(output);
    } catch {
      return false;
    }
  }

  /**
   * Detects available hardware video encoders by querying FFmpeg.
   * Called after detectBinaries() to ensure ffmpegPath is set.
   *
   * Returns as soon as the probe is spawned rather than waiting for it. This
   * runs during startup, ahead of the first window, and `ffmpeg -encoders`
   * typically costs 100-500ms — considerably more on a cold disk or with AV
   * scanning on Windows — so waiting for it delayed first paint by its full
   * duration. Nothing needs the answer that early: it is read only when a
   * transcode picks an encoder, and a transcode starting before detection
   * lands just falls back to software encoding.
   */
  private detectHardwareEncoders(): void {
    if (!this.ffmpegPath) {
      this.hardwareEncoders = {available: false, encoders: []};
      return;
    }

    // Known hardware encoders to look for
    const knownHwEncoders: readonly string[] = [
      'h264_videotoolbox',  // macOS (Apple Silicon & Intel)
      'h264_nvenc',         // NVIDIA GPUs
      'h264_qsv',           // Intel Quick Sync
      'h264_amf',           // AMD GPUs (Windows)
      'h264_vaapi',         // Linux VA-API
    ];

    let output: string = '';
    let settled: boolean = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle: (detected: string[] | null) => void = (detected: string[] | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);

      if (!detected) {
        this.hardwareEncoders = {available: false, encoders: []};
        depsLogger.info('Hardware encoders: detection failed');
        return;
      }

      this.hardwareEncoders = {available: detected.length > 0, encoders: detected};
      depsLogger.info(
        detected.length > 0 ? `Hardware encoders: ${detected.join(', ')}` : 'Hardware encoders: none detected'
      );
    };

    try {
      const ffmpegPath: string = this.ffmpegPath;
      const args: string[] = ['-encoders'];
      logProcessSpawn(depsLogger, ffmpegPath, args);

      // No shell: the binary path may contain spaces. Ignoring stderr drops the
      // banner on every platform.
      const child: ChildProcess = spawn(ffmpegPath, args, {stdio: ['ignore', 'pipe', 'ignore']});

      timer = setTimeout((): void => {
        child.kill();
        settle(null);
      }, DependencyManager.HW_ENCODER_TIMEOUT_MS);

      child.stdout?.on('data', (data: Buffer): void => {
        output += data.toString();
      });

      child.on('error', (): void => settle(null));

      child.on('close', (code: number | null): void => {
        if (code !== 0) {
          settle(null);
          return;
        }
        // Encoders are listed with format: " V..... h264_videotoolbox" (video encoders start with V)
        settle(knownHwEncoders.filter((encoder: string): boolean => output.includes(encoder)));
      });
    } catch {
      settle(null);
    }
  }

  /**
   * Gets the resolved path to the ffmpeg binary.
   * @returns Absolute path or null if not found
   */
  public getFfmpegPath(): string | null {
    return this.ffmpegPath;
  }

  /**
   * Gets the resolved path to the ffprobe binary.
   * @returns Absolute path or null if not found
   */
  public getFfprobePath(): string | null {
    return this.ffprobePath;
  }

  /**
   * Gets the resolved path to the fluidsynth binary.
   * @returns Absolute path or null if not found
   */
  public getFluidsynthPath(): string | null {
    return this.fluidsynthPath;
  }

  /**
   * Gets the resolved path to the yt-dlp binary.
   * @returns Absolute path or null if not found
   */
  public getYtDlpPath(): string | null {
    return this.ytdlpPath;
  }

  /**
   * Gets the executable yt-dlp should use as its JavaScript runtime.
   *
   * YouTube extraction needs a JavaScript runtime. Electron is one: started
   * with ELECTRON_RUN_AS_NODE=1 it behaves as Node, so yt-dlp needs nothing
   * else installed.
   *
   * @returns Absolute path, or null if none was configured
   */
  public getJsRuntimePath(): string | null {
    return this.jsRuntimePath;
  }

  /**
   * Whether the FFmpeg in use can decode tracker modules.
   */
  public hasTrackerSupport(): boolean {
    return this.trackerSupport;
  }

  /**
   * Whether MIDI can be played. No SoundFont ships with the app, so MIDI stays
   * off until the user installs one, even though FluidSynth is always present.
   *
   * @param preferredSoundFont - Optional preferred SoundFont file name from settings
   */
  public hasMidiSupport(preferredSoundFont?: string | null): boolean {
    return this.fluidsynthPath !== null && this.findSoundFont(preferredSoundFont) !== undefined;
  }

  /**
   * Gets the full dependency state for broadcasting to the renderer.
   * @param preferredSoundFont - Optional preferred SoundFont file name from settings
   * @returns Complete dependency state including SoundFont info
   */
  public getState(preferredSoundFont?: string | null): DependencyState {
    // Scanned once and shared, rather than once here and again in findSoundFont.
    const soundfonts: SoundFontInfo[] = this.getSoundFonts();
    const activeSoundFont: string | null = this.selectSoundFont(soundfonts, preferredSoundFont) ?? null;
    return {
      ffmpeg: this.getDependencyStatus('ffmpeg'),
      fluidsynth: this.getDependencyStatus('fluidsynth'),
      ytdlp: this.getDependencyStatus('yt-dlp'),
      trackerSupport: this.trackerSupport,
      midiSupport: this.fluidsynthPath !== null && activeSoundFont !== null,
      soundfonts,
      activeSoundFont,
      hardwareEncoders: this.hardwareEncoders,
    };
  }

  /**
   * Gets information about available hardware encoders.
   * @returns Hardware encoder info including list of available encoders
   */
  public getHardwareEncoders(): HardwareEncoderInfo {
    return this.hardwareEncoders;
  }

  // ============================================================================
  // Download / Update / Remove (yt-dlp only)
  // ============================================================================

  /**
   * Downloads a dependency. Only yt-dlp can be downloaded: FFmpeg and
   * FluidSynth are part of ONIXPlayer.
   *
   * @param id - The dependency to download
   * @param onProgress - Callback for progress updates (streamed to SSE)
   * @returns True if the download succeeded
   */
  public async installDependency(id: DependencyId, onProgress: (progress: InstallProgress) => void): Promise<boolean> {
    if (id !== 'yt-dlp') {
      return this.rejectBundled(id, 'installed', onProgress);
    }
    return this.downloadYtDlp('installing', onProgress);
  }

  /**
   * Updates a dependency to its latest release. Only yt-dlp can be updated.
   *
   * yt-dlp must be updated frequently to keep working against sites like
   * YouTube as their extraction changes.
   *
   * @param id - The dependency to update
   * @param onProgress - Callback for progress updates (streamed to SSE)
   * @returns True if the update succeeded, or yt-dlp was already current
   */
  public async updateDependency(id: DependencyId, onProgress: (progress: InstallProgress) => void): Promise<boolean> {
    if (id !== 'yt-dlp') {
      return this.rejectBundled(id, 'updated', onProgress);
    }
    return this.downloadYtDlp('updating', onProgress);
  }

  /**
   * Removes a downloaded dependency. Only a yt-dlp that ONIXPlayer downloaded
   * can be removed; a system copy belongs to whatever installed it.
   *
   * @param id - The dependency to remove
   * @param onProgress - Callback for progress updates (streamed to SSE)
   * @returns True if the dependency was removed
   */
  public async uninstallDependency(id: DependencyId, onProgress: (progress: InstallProgress) => void): Promise<boolean> {
    if (id !== 'yt-dlp') {
      return this.rejectBundled(id, 'removed', onProgress);
    }

    if (!existsSync(this.ytdlpDir)) {
      return this.fail(id, 'yt-dlp was not downloaded by ONIXPlayer, so there is nothing to remove.', onProgress);
    }

    if (this.operationInProgress) {
      return this.fail(id, 'Another yt-dlp operation is already running.', onProgress);
    }

    this.operationInProgress = true;
    try {
      onProgress({dependencyId: id, status: 'uninstalling', message: 'Removing yt-dlp...'});
      await rm(this.ytdlpDir, {recursive: true, force: true});
      this.detectBinaries();
      depsLogger.info('yt-dlp removed');
      onProgress({dependencyId: id, status: 'success', message: 'yt-dlp removed.'});
      return true;
    } catch (error: unknown) {
      return this.fail(id, `Could not remove yt-dlp: ${DependencyManager.describeError(error)}`, onProgress);
    } finally {
      this.operationInProgress = false;
    }
  }

  /**
   * Downloads the latest yt-dlp release for this platform into the user data
   * folder, replacing any earlier download only once the new one is verified.
   *
   * @param operation - Whether this is a first install or an update
   * @param onProgress - Progress callback
   * @returns True on success
   */
  private async downloadYtDlp(
    operation: 'installing' | 'updating',
    onProgress: (progress: InstallProgress) => void
  ): Promise<boolean> {
    const id: DependencyId = 'yt-dlp';
    const asset: YtDlpAsset | null = this.getYtDlpAsset();
    if (!asset) {
      return this.fail(id, `yt-dlp does not publish a build for ${this.platform} (${this.arch}).`, onProgress);
    }

    if (this.operationInProgress) {
      return this.fail(id, 'Another yt-dlp operation is already running.', onProgress);
    }

    this.operationInProgress = true;
    const staging: string = `${this.ytdlpDir}.download`;

    try {
      onProgress({dependencyId: id, status: operation, message: 'Finding the latest yt-dlp release...'});
      const tag: string = await this.fetchLatestYtDlpTag();

      const installedVersion: string | null = this.readVersionFile(this.ytdlpDir);
      if (operation === 'updating' && installedVersion === tag && this.ytdlpPath !== null) {
        depsLogger.info(`yt-dlp ${tag} is already the latest release`);
        onProgress({dependencyId: id, status: 'success', message: `yt-dlp ${tag} is already the latest version.`});
        return true;
      }

      const expectedSha256: string = await this.fetchYtDlpChecksum(tag, asset.asset);

      await rm(staging, {recursive: true, force: true});
      mkdirSync(staging, {recursive: true});

      const downloadPath: string = path.join(staging, asset.asset);
      const actualSha256: string = await this.downloadFile(
        `${YTDLP_DOWNLOAD_BASE_URL}/${tag}/${asset.asset}`,
        downloadPath,
        (percent: number | undefined): void => {
          onProgress({
            dependencyId: id,
            status: operation,
            message: percent === undefined ? `Downloading yt-dlp ${tag}...` : `Downloading yt-dlp ${tag}... ${percent}%`,
            percent,
          });
        }
      );

      if (actualSha256 !== expectedSha256) {
        throw new Error(`checksum mismatch for ${asset.asset} (expected ${expectedSha256}, got ${actualSha256})`);
      }

      const installRoot: string = path.join(staging, 'yt-dlp');
      mkdirSync(installRoot, {recursive: true});

      if (asset.archive) {
        onProgress({dependencyId: id, status: operation, message: `Unpacking yt-dlp ${tag}...`});
        await this.extractZip(downloadPath, installRoot);
        unlinkSync(downloadPath);
      } else {
        await rename(downloadPath, path.join(installRoot, asset.executable));
      }

      const executable: string = path.join(installRoot, asset.executable);
      if (!existsSync(executable)) {
        throw new Error(`the download did not contain ${asset.executable}`);
      }
      if (this.platform !== 'win32') {
        chmodSync(executable, EXECUTABLE_MODE);
      }
      writeFileSync(path.join(installRoot, VERSION_FILE), `${tag}\n`);

      // Swap in the verified download.
      await rm(this.ytdlpDir, {recursive: true, force: true});
      await rename(installRoot, this.ytdlpDir);

      this.detectBinaries();
      const verb: string = operation === 'updating' ? 'updated to' : 'installed:';
      depsLogger.info(`yt-dlp ${verb} ${tag}`);
      onProgress({dependencyId: id, status: 'success', message: `yt-dlp ${verb} ${tag}.`});
      return true;
    } catch (error: unknown) {
      return this.fail(id, `Could not download yt-dlp: ${DependencyManager.describeError(error)}`, onProgress);
    } finally {
      await rm(staging, {recursive: true, force: true}).catch((): void => undefined);
      this.operationInProgress = false;
    }
  }

  /**
   * Asks GitHub for yt-dlp's latest release tag.
   */
  private async fetchLatestYtDlpTag(): Promise<string> {
    const response: Response = await this.fetchFn(YTDLP_LATEST_RELEASE_URL, {
      headers: {Accept: 'application/vnd.github+json'},
    });
    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status} for the latest release`);
    }
    const release: {readonly tag_name?: unknown} = await response.json() as {readonly tag_name?: unknown};
    if (typeof release.tag_name !== 'string' || !/^[\w.-]+$/.test(release.tag_name)) {
      throw new Error('GitHub did not report a release tag');
    }
    return release.tag_name;
  }

  /**
   * Reads one asset's SHA-256 from a release's SHA2-256SUMS file.
   */
  private async fetchYtDlpChecksum(tag: string, asset: string): Promise<string> {
    const response: Response = await this.fetchFn(`${YTDLP_DOWNLOAD_BASE_URL}/${tag}/${YTDLP_CHECKSUMS_ASSET}`);
    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status} for ${YTDLP_CHECKSUMS_ASSET}`);
    }
    const sums: string = await response.text();
    for (const line of sums.split('\n')) {
      const [sha, name]: string[] = line.trim().split(/\s+/);
      if (name === asset && /^[0-9a-f]{64}$/.test(sha)) {
        return sha;
      }
    }
    throw new Error(`${YTDLP_CHECKSUMS_ASSET} has no entry for ${asset}`);
  }

  /**
   * Streams a URL to a file, reporting progress and hashing as it goes.
   *
   * @param url - What to download
   * @param destination - File to write
   * @param onPercent - Called as data arrives (undefined when the size is unknown)
   * @returns Hex SHA-256 of what was written
   */
  private async downloadFile(url: string, destination: string, onPercent: (percent: number | undefined) => void): Promise<string> {
    const response: Response = await this.fetchFn(url);
    if (!response.ok || !response.body) {
      throw new Error(`the download returned ${response.status}`);
    }

    const total: number = Number(response.headers.get('content-length') ?? 0);
    const hash: Hash = createHash('sha256');
    const file: WriteStream = createWriteStream(destination);
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();

    let received: number = 0;
    let lastPercent: number = -1;

    try {
      for (;;) {
        const {done, value}: ReadableStreamReadResult<Uint8Array> = await reader.read();
        if (done) break;

        hash.update(value);
        received += value.length;
        if (!file.write(value)) {
          await new Promise<void>((resolve: () => void): void => {
            file.once('drain', resolve);
          });
        }

        const percent: number | undefined = total > 0 ? Math.floor((received / total) * 100) : undefined;
        if (percent === undefined || percent !== lastPercent) {
          lastPercent = percent ?? lastPercent;
          onPercent(percent);
        }
      }
    } finally {
      await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
        file.end((error?: Error | null): void => (error ? reject(error) : resolve()));
      });
    }

    return hash.digest('hex');
  }

  /**
   * Extracts a zip with the OS's own tools: ditto on macOS (which keeps the
   * executable bits and symlinks the yt-dlp bundle relies on), tar elsewhere
   * (bsdtar, which reads zips, ships with Windows 10 and later).
   */
  private extractZip(zipPath: string, destination: string): Promise<void> {
    const [command, args]: [string, string[]] = this.platform === 'darwin'
      ? ['/usr/bin/ditto', ['-x', '-k', zipPath, destination]]
      : ['tar', ['-xf', zipPath, '-C', destination]];

    return new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
      logProcessSpawn(depsLogger, command, args);
      execFile(command, args, (error: Error | null, _stdout: string, stderr: string): void => {
        if (error) {
          reject(new Error(`could not unpack the download: ${stderr.trim() || error.message}`));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Picks the yt-dlp release asset for this platform.
   *
   * On macOS the zip ("onedir") build is used rather than the single-file one:
   * the single file unpacks itself to a fresh temporary folder on every run,
   * which macOS then scans, and that cost 17-21 seconds per invocation on an
   * Intel Mac. The unpacked build starts in about a second.
   */
  private getYtDlpAsset(): YtDlpAsset | null {
    switch (this.platform) {
      case 'darwin':
        return {asset: 'yt-dlp_macos.zip', archive: true, executable: 'yt-dlp_macos'};
      case 'win32': {
        const assets: Readonly<Record<string, string>> = {x64: 'yt-dlp.exe', arm64: 'yt-dlp_arm64.exe', ia32: 'yt-dlp_x86.exe'};
        const asset: string | undefined = assets[this.arch];
        return asset ? {asset, archive: false, executable: 'yt-dlp.exe'} : null;
      }
      case 'linux': {
        const assets: Readonly<Record<string, string>> = {x64: 'yt-dlp_linux', arm64: 'yt-dlp_linux_aarch64'};
        const asset: string | undefined = assets[this.arch];
        return asset ? {asset, archive: false, executable: 'yt-dlp'} : null;
      }
      default:
        return null;
    }
  }

  /**
   * Reports that a bundled dependency cannot be managed.
   */
  private rejectBundled(id: DependencyId, verb: string, onProgress: (progress: InstallProgress) => void): boolean {
    return this.fail(id, `${DEPENDENCY_NAMES[id]} is built into ONIXPlayer and is not ${verb} separately.`, onProgress);
  }

  /**
   * Logs and reports a failed operation.
   */
  private fail(id: DependencyId, message: string, onProgress: (progress: InstallProgress) => void): boolean {
    depsLogger.error(message);
    onProgress({dependencyId: id, status: 'error', message});
    return false;
  }

  /**
   * Turns a caught value into a message.
   */
  private static describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // ============================================================================
  // SoundFont Management
  // ============================================================================

  /**
   * Lists all SoundFont files installed in the app data directory.
   * @returns Array of SoundFont file info
   */
  public getSoundFonts(): SoundFontInfo[] {
    try {
      const entries: string[] = readdirSync(this.soundFontDir);
      const soundfonts: SoundFontInfo[] = [];

      for (const entry of entries) {
        if (entry.toLowerCase().endsWith('.sf2')) {
          const filePath: string = path.join(this.soundFontDir, entry);
          try {
            const stats: ReturnType<typeof statSync> = statSync(filePath);
            if (stats.isFile()) {
              soundfonts.push({
                fileName: entry,
                filePath,
                sizeBytes: stats.size,
              });
            }
          } catch {
            // Skip files that can't be stat'd
          }
        }
      }

      return soundfonts;
    } catch {
      return [];
    }
  }

  /**
   * Finds the active SoundFont file.
   * If a preferred file name is provided and exists, uses that.
   * Otherwise, uses the first installed SoundFont.
   *
   * @param preferredFileName - Optional preferred SoundFont file name
   * @returns Path to a SoundFont file, or undefined if none found
   */
  public findSoundFont(preferredFileName?: string | null): string | undefined {
    return this.selectSoundFont(this.getSoundFonts(), preferredFileName);
  }

  /**
   * Picks the active SoundFont from an already-scanned list.
   *
   * @param userSoundFonts - The installed SoundFonts, as getSoundFonts returns them
   * @param preferredFileName - Optional preferred SoundFont file name
   * @returns Path to a SoundFont file, or undefined if none found
   */
  private selectSoundFont(userSoundFonts: readonly SoundFontInfo[], preferredFileName?: string | null): string | undefined {

    // If a preferred file name is specified, try to use it
    if (preferredFileName) {
      const preferred: SoundFontInfo | undefined = userSoundFonts.find(
        (sf: SoundFontInfo): boolean => sf.fileName === preferredFileName
      );
      if (preferred) {
        return preferred.filePath;
      }
      // Preferred file not found, fall through to auto-selection
      depsLogger.info(`Preferred SoundFont "${preferredFileName}" not found, auto-selecting`);
    }

    // Auto-select: use first user-installed SoundFont
    if (userSoundFonts.length > 0) {
      return userSoundFonts[0].filePath;
    }

    return undefined;
  }

  /**
   * Copies a SoundFont file to the app data directory.
   *
   * @param sourcePath - Absolute path to the source .sf2 file
   * @returns Info about the installed SoundFont
   * @throws Error if the file doesn't exist or copy fails
   */
  public installSoundFont(sourcePath: string): SoundFontInfo {
    const fileName: string = path.basename(sourcePath);
    const destPath: string = path.join(this.soundFontDir, fileName);

    depsLogger.info(`Installing SoundFont: ${fileName}`);

    if (!existsSync(sourcePath)) {
      throw new Error(`Source file not found: ${sourcePath}`);
    }

    copyFileSync(sourcePath, destPath);

    const stats: ReturnType<typeof statSync> = statSync(destPath);
    depsLogger.info(`SoundFont installed: ${fileName} (${stats.size} bytes)`);

    return {
      fileName,
      filePath: destPath,
      sizeBytes: stats.size,
    };
  }

  /**
   * Removes a SoundFont file from the app data directory.
   *
   * @param fileName - Name of the file to remove (e.g., "FluidR3_GM.sf2")
   * @returns True if the file was removed
   */
  public removeSoundFont(fileName: string): boolean {
    // Prevent path traversal — validate before constructing file path
    if (fileName.includes('..') || fileName.includes(path.sep)) {
      depsLogger.warn(`Rejected SoundFont removal (path traversal): ${fileName}`);
      return false;
    }

    const filePath: string = path.join(this.soundFontDir, fileName);

    if (!existsSync(filePath)) {
      depsLogger.warn(`SoundFont not found: ${fileName}`);
      return false;
    }

    try {
      unlinkSync(filePath);
      depsLogger.info(`SoundFont removed: ${fileName}`);
      return true;
    } catch (error: unknown) {
      depsLogger.error(`Failed to remove SoundFont: ${fileName}`, error);
      return false;
    }
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Gets the status of a single dependency.
   */
  private getDependencyStatus(id: DependencyId): DependencyStatus {
    const binaryPath: string | null = id === 'ffmpeg'
      ? this.ffmpegPath
      : id === 'fluidsynth' ? this.fluidsynthPath : this.ytdlpPath;
    const source: DependencySource | null = binaryPath ? this.getSource(binaryPath) : null;

    let version: string | null = null;
    if (source === 'bundled') {
      version = this.bundledVersions[id] ?? null;
    } else if (source === 'downloaded') {
      version = this.readVersionFile(this.ytdlpDir);
    }

    return {
      id,
      name: DEPENDENCY_NAMES[id],
      installed: binaryPath !== null,
      path: binaryPath,
      source,
      version,
      managed: id === 'yt-dlp',
      description: DEPENDENCY_DESCRIPTIONS[id],
      websiteUrl: WEBSITE_URLS[id],
    };
  }

  /**
   * Classifies a resolved binary path by where it lives.
   */
  private getSource(binaryPath: string): DependencySource {
    if (this.bundledBinDir && DependencyManager.isInside(binaryPath, this.bundledBinDir)) return 'bundled';
    if (DependencyManager.isInside(binaryPath, this.ytdlpDir)) return 'downloaded';
    return 'system';
  }

  /**
   * Whether a path lies inside a directory.
   */
  private static isInside(filePath: string, dir: string): boolean {
    const relative: string = path.relative(dir, filePath);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  /**
   * Reads versions.json from the bundled binary directory, if present.
   */
  private readBundledVersions(): Readonly<Record<string, string>> {
    if (!this.bundledBinDir) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(this.bundledBinDir, BUNDLED_VERSIONS_FILE), 'utf-8'));
      return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
    } catch {
      return {};
    }
  }

  /**
   * Reads the version recorded in an install directory.
   */
  private readVersionFile(dir: string): string | null {
    try {
      return readFileSync(path.join(dir, VERSION_FILE), 'utf-8').trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Finds yt-dlp: ONIXPlayer's own download first, then a system copy.
   */
  private findYtDlp(): string | null {
    const asset: YtDlpAsset | null = this.getYtDlpAsset();
    if (asset) {
      const downloaded: string = path.join(this.ytdlpDir, asset.executable);
      if (existsSync(downloaded)) {
        return downloaded;
      }
    }
    return this.findSystemBinary('yt-dlp');
  }

  /**
   * Finds a binary: the bundled copy first, then a system copy.
   *
   * @param binary - The binary name (e.g., 'ffmpeg', 'ffprobe', 'fluidsynth')
   * @returns Absolute path to the binary, or null if not found
   */
  private findBinary(binary: string): string | null {
    if (this.bundledBinDir) {
      const bundled: string = path.join(this.bundledBinDir, this.platform === 'win32' ? `${binary}.exe` : binary);
      if (existsSync(bundled)) {
        return bundled;
      }
    }
    return this.findSystemBinary(binary);
  }

  /**
   * Finds a binary somewhere on the system.
   *
   * @param binary - Binary name to search for
   * @returns Absolute path to the binary, or null if not found
   */
  private findSystemBinary(binary: string): string | null {
    for (const p of this.getSearchPaths(binary)) {
      if (existsSync(p)) {
        return p;
      }
    }

    // On Windows, also try 'where' command as a fallback
    if (this.platform === 'win32') {
      return this.findBinaryViaWhere(binary);
    }

    return null;
  }

  /**
   * Gets platform-specific system search paths for a binary.
   *
   * These are absolute because a macOS app launched from Finder inherits
   * launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), which contains none of them.
   */
  private getSearchPaths(binary: string): string[] {
    switch (this.platform) {
      case 'darwin':
        return [
          `/opt/homebrew/bin/${binary}`,    // Homebrew Apple Silicon
          `/usr/local/bin/${binary}`,       // Homebrew Intel, manual installs
          `/usr/bin/${binary}`,             // System
        ];

      case 'linux':
        return [
          `/usr/bin/${binary}`,             // System (most common)
          `/usr/local/bin/${binary}`,       // Local installs
          `/snap/bin/${binary}`,            // Snap packages
        ];

      case 'win32': {
        const localAppData: string = process.env['LOCALAPPDATA'] ?? '';
        const programFiles: string = process.env['ProgramFiles'] ?? 'C:\\Program Files';
        const exe: string = `${binary}.exe`;

        return [
          path.join(programFiles, 'FFmpeg', 'bin', exe),
          path.join(localAppData, 'Microsoft', 'WinGet', 'Links', exe),
          path.join(programFiles, 'FluidSynth', 'bin', exe),
        ];
      }

      default:
        return [];
    }
  }

  /**
   * Attempts to find a binary using the Windows 'where' command.
   *
   * @param binary - Binary name to search for
   * @returns Path to binary or null
   */
  private findBinaryViaWhere(binary: string): string | null {
    try {
      const result: string = execFileSync('where', [binary], {encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']}).trim();
      const firstLine: string = result.split('\n')[0].trim();
      if (firstLine && existsSync(firstLine)) {
        return firstLine;
      }
    } catch {
      // 'where' returns exit code 1 if not found
    }
    return null;
  }
}

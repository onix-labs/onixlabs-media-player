/**
 * @fileoverview Dependency management module for external binary detection and installation.
 *
 * This module manages the lifecycle of external dependencies (FFmpeg, FluidSynth)
 * required for media playback. It provides:
 * - Cross-platform binary detection (macOS, Windows, Linux)
 * - Platform-specific installation and uninstallation via package managers
 * - SoundFont file management for MIDI playback
 * - Dynamic binary path resolution (re-scans after install/uninstall)
 *
 * @module electron/dependency-manager
 */

import {existsSync, mkdirSync, copyFileSync, unlinkSync, readdirSync, statSync} from 'fs';
import {spawn, ChildProcess, execSync} from 'child_process';
import * as path from 'path';
import {createScopedLogger, logProcessSpawn, logProcessOutput, logProcessExit} from './logger.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Identifier for a managed dependency.
 */
export type DependencyId = 'ffmpeg' | 'fluidsynth';

/**
 * Status of a single dependency.
 */
export interface DependencyStatus {
  /** Unique identifier */
  readonly id: DependencyId;
  /** Human-readable name */
  readonly name: string;
  /** Whether the binary was found on the system */
  readonly installed: boolean;
  /** Absolute path to the binary, or null if not found */
  readonly path: string | null;
  /** Description of what this dependency enables */
  readonly description: string;
  /** URL for manual download and installation */
  readonly manualInstallUrl: string;
}

/**
 * Overall dependency state broadcast to the renderer.
 */
export interface DependencyState {
  /** FFmpeg status (required for audio/video playback) */
  readonly ffmpeg: DependencyStatus;
  /** FluidSynth status (required for MIDI playback) */
  readonly fluidsynth: DependencyStatus;
  /** Installed SoundFont files in the app data directory */
  readonly soundfonts: SoundFontInfo[];
  /** Path to the active SoundFont (first available) */
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
 * Progress update during dependency installation or uninstallation.
 */
export interface InstallProgress {
  /** Which dependency is being installed/uninstalled */
  readonly dependencyId: DependencyId;
  /** Current operation status */
  readonly status: 'installing' | 'uninstalling' | 'success' | 'error';
  /** Human-readable status message */
  readonly message: string;
  /** Terminal output (stdout/stderr) */
  readonly output?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Scoped logger for dependency operations */
const depsLogger: ReturnType<typeof createScopedLogger> = createScopedLogger('Deps');

/** Descriptions for each dependency */
const DEPENDENCY_DESCRIPTIONS: Readonly<Record<DependencyId, string>> = {
  ffmpeg: 'Required for audio and video playback',
  fluidsynth: 'Required for MIDI playback',
};

/** Manual download URLs */
const MANUAL_INSTALL_URLS: Readonly<Record<DependencyId, string>> = {
  ffmpeg: 'https://ffmpeg.org/download.html',
  fluidsynth: 'https://www.fluidsynth.org/download/',
};

/** Display names */
const DEPENDENCY_NAMES: Readonly<Record<DependencyId, string>> = {
  ffmpeg: 'FFmpeg',
  fluidsynth: 'FluidSynth',
};

/**
 * System paths where SoundFont files may be installed by package managers.
 * Checked as fallback when no user-installed SoundFonts are found.
 */
const SYSTEM_SOUNDFONT_PATHS: readonly string[] = [
  '/usr/local/Cellar/fluid-synth/2.5.1/share/fluid-synth/sf2/VintageDreamsWaves-v2.sf2',
  '/usr/share/sounds/sf2/FluidR3_GM.sf2',
  '/usr/share/soundfonts/FluidR3_GM.sf2',
  '/usr/local/share/soundfonts/default.sf2',
];

/**
 * Windows-specific constants for Chocolatey package manager.
 */
const CHOCOLATEY_WINGET_ID: string = 'Chocolatey.Chocolatey';
const CHOCOLATEY_EXE_PATH: string = 'C:\\ProgramData\\chocolatey\\bin\\choco.exe';

// ============================================================================
// DependencyManager Class
// ============================================================================

/**
 * Manages external dependency detection, installation, and SoundFont files.
 *
 * This class provides:
 * - Cross-platform binary path resolution (macOS, Windows, Linux)
 * - Platform-specific install/uninstall via package managers
 * - SoundFont file management (copy to app data, list, remove)
 * - Dynamic re-detection after install/uninstall (no app restart needed)
 */
export class DependencyManager {
  /** Current platform */
  private readonly platform: NodeJS.Platform;

  /** Path to the soundfonts directory in user data */
  private readonly soundFontDir: string;

  /** Resolved path to ffmpeg binary (mutable, refreshed after install) */
  private ffmpegPath: string | null = null;

  /** Resolved path to ffprobe binary (mutable, refreshed after install) */
  private ffprobePath: string | null = null;

  /** Resolved path to fluidsynth binary (mutable, refreshed after install) */
  private fluidsynthPath: string | null = null;

  /** Detected hardware video encoders (populated after detectBinaries) */
  private hardwareEncoders: HardwareEncoderInfo = {available: false, encoders: []};

  /**
   * Creates a new DependencyManager instance.
   *
   * @param platform - The current platform (process.platform)
   * @param userDataPath - Path to the app's userData directory (app.getPath('userData'))
   */
  public constructor(platform: NodeJS.Platform, userDataPath: string) {
    this.platform = platform;
    this.soundFontDir = path.join(userDataPath, 'soundfonts');

    // Ensure soundfonts directory exists
    if (!existsSync(this.soundFontDir)) {
      mkdirSync(this.soundFontDir, {recursive: true});
      depsLogger.info(`Created soundfonts directory: ${this.soundFontDir}`);
    }

    this.detectBinaries();
    this.detectHardwareEncoders();
  }

  // ============================================================================
  // Binary Detection
  // ============================================================================

  /**
   * Re-scans the system for all managed binaries.
   * Called at startup and after install/uninstall operations.
   */
  public detectBinaries(): void {
    this.ffmpegPath = this.findBinary('ffmpeg');
    this.ffprobePath = this.findBinary('ffprobe');
    this.fluidsynthPath = this.findBinary('fluidsynth');

    depsLogger.info(`FFmpeg: ${this.ffmpegPath ?? 'not found'}`);
    depsLogger.info(`FFprobe: ${this.ffprobePath ?? 'not found'}`);
    depsLogger.info(`FluidSynth: ${this.fluidsynthPath ?? 'not found'}`);

    // Re-detect hardware encoders when binaries are re-scanned
    this.detectHardwareEncoders();
  }

  /**
   * Detects available hardware video encoders by querying FFmpeg.
   * Called after detectBinaries() to ensure ffmpegPath is set.
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

    try {
      // Run ffmpeg -encoders and parse output
      const result: string = execSync(`"${this.ffmpegPath}" -encoders 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 10000,
      });

      const detectedEncoders: string[] = [];
      for (const encoder of knownHwEncoders) {
        // Encoders are listed with format: " V..... h264_videotoolbox" (video encoders start with V)
        if (result.includes(encoder)) {
          detectedEncoders.push(encoder);
        }
      }

      this.hardwareEncoders = {
        available: detectedEncoders.length > 0,
        encoders: detectedEncoders,
      };

      if (detectedEncoders.length > 0) {
        depsLogger.info(`Hardware encoders: ${detectedEncoders.join(', ')}`);
      } else {
        depsLogger.info('Hardware encoders: none detected');
      }
    } catch {
      // FFmpeg command failed - no hardware encoders available
      this.hardwareEncoders = {available: false, encoders: []};
      depsLogger.info('Hardware encoders: detection failed');
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
   * Gets the full dependency state for broadcasting to the renderer.
   * @returns Complete dependency state including SoundFont info
   */
  public getState(): DependencyState {
    return {
      ffmpeg: this.getDependencyStatus('ffmpeg'),
      fluidsynth: this.getDependencyStatus('fluidsynth'),
      soundfonts: this.getSoundFonts(),
      activeSoundFont: this.findSoundFont() ?? null,
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
  // Install / Uninstall
  // ============================================================================

  /**
   * Installs a dependency using the platform-specific package manager.
   *
   * On Windows, FluidSynth requires Chocolatey. If Chocolatey is not installed
   * but winget is available, this method will automatically install Chocolatey
   * first via winget, then install FluidSynth.
   *
   * @param id - The dependency to install
   * @param onProgress - Callback for progress updates (streamed to SSE)
   * @returns True if installation succeeded
   */
  public async installDependency(
    id: DependencyId,
    onProgress: (progress: InstallProgress) => void
  ): Promise<boolean> {
    const name: string = DEPENDENCY_NAMES[id];
    depsLogger.info(`Installing ${name}...`);

    // Windows FluidSynth: chain install Chocolatey via winget if needed
    if (this.platform === 'win32' && id === 'fluidsynth' && !this.isChocoAvailable()) {
      return this.installFluidSynthWithChocolateyChain(onProgress);
    }

    const cmd: {command: string; args: string[]} | null = this.getInstallCommand(id);
    if (!cmd) {
      const errorMsg: string = this.getPackageManagerErrorMessage(id, 'install');
      depsLogger.error(errorMsg);
      onProgress({dependencyId: id, status: 'error', message: errorMsg});
      return false;
    }

    onProgress({
      dependencyId: id,
      status: 'installing',
      message: `Installing ${name}...`,
    });

    return this.runCommand(cmd.command, cmd.args, id, 'installing', onProgress);
  }

  /**
   * Installs FluidSynth on Windows by first installing Chocolatey via winget,
   * then installing FluidSynth via Chocolatey.
   *
   * This handles the case where Chocolatey is not yet installed. After winget
   * installs Chocolatey, we use the full path to choco.exe since it won't be
   * in the current session's PATH yet.
   *
   * @param onProgress - Callback for progress updates
   * @returns True if both installations succeeded
   */
  private async installFluidSynthWithChocolateyChain(
    onProgress: (progress: InstallProgress) => void
  ): Promise<boolean> {
    // Check if winget is available for installing Chocolatey
    if (!this.isWingetAvailable()) {
      const errorMsg: string = 'Cannot install FluidSynth: Neither Chocolatey nor winget is available. ' +
        'Please install "App Installer" from the Microsoft Store, or install Chocolatey manually.';
      depsLogger.error(errorMsg);
      onProgress({dependencyId: 'fluidsynth', status: 'error', message: errorMsg});
      return false;
    }

    depsLogger.info('Chocolatey not found. Installing via winget first...');

    // Step 1: Install Chocolatey via winget
    onProgress({
      dependencyId: 'fluidsynth',
      status: 'installing',
      message: 'Installing Chocolatey (required for FluidSynth)...',
    });

    const chocoInstallSuccess: boolean = await this.runCommand(
      'winget',
      ['install', CHOCOLATEY_WINGET_ID, '--accept-source-agreements', '--accept-package-agreements'],
      'fluidsynth',
      'installing',
      (progress: InstallProgress): void => {
        // Override the message to indicate we're installing Chocolatey
        onProgress({
          ...progress,
          message: progress.status === 'success'
            ? 'Chocolatey installed successfully. Now installing FluidSynth...'
            : 'Installing Chocolatey (required for FluidSynth)...',
        });
      }
    );

    if (!chocoInstallSuccess) {
      const errorMsg: string = 'Failed to install Chocolatey via winget. Please install Chocolatey manually.';
      depsLogger.error(errorMsg);
      onProgress({dependencyId: 'fluidsynth', status: 'error', message: errorMsg});
      return false;
    }

    depsLogger.info('Chocolatey installed. Now installing FluidSynth...');

    // Step 2: Install FluidSynth using the full path to choco.exe
    // (PATH won't be updated in the current session)
    onProgress({
      dependencyId: 'fluidsynth',
      status: 'installing',
      message: 'Installing FluidSynth...',
    });

    return this.runCommand(
      CHOCOLATEY_EXE_PATH,
      ['install', 'fluidsynth', '-y'],
      'fluidsynth',
      'installing',
      onProgress
    );
  }

  /**
   * Uninstalls a dependency using the platform-specific package manager.
   *
   * @param id - The dependency to uninstall
   * @param onProgress - Callback for progress updates (streamed to SSE)
   * @returns True if uninstallation succeeded
   */
  public async uninstallDependency(
    id: DependencyId,
    onProgress: (progress: InstallProgress) => void
  ): Promise<boolean> {
    const name: string = DEPENDENCY_NAMES[id];
    depsLogger.info(`Uninstalling ${name}...`);

    const cmd: {command: string; args: string[]} | null = this.getUninstallCommand(id);
    if (!cmd) {
      const errorMsg: string = this.getPackageManagerErrorMessage(id, 'uninstall');
      depsLogger.error(errorMsg);
      onProgress({dependencyId: id, status: 'error', message: errorMsg});
      return false;
    }

    onProgress({
      dependencyId: id,
      status: 'uninstalling',
      message: `Uninstalling ${name}...`,
    });

    return this.runCommand(cmd.command, cmd.args, id, 'uninstalling', onProgress);
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
   * Finds the first available SoundFont file.
   * Checks user-installed SoundFonts first, then system paths.
   *
   * @returns Path to a SoundFont file, or undefined if none found
   */
  public findSoundFont(): string | undefined {
    // Check user-installed SoundFonts first
    const userSoundFonts: SoundFontInfo[] = this.getSoundFonts();
    if (userSoundFonts.length > 0) {
      return userSoundFonts[0].filePath;
    }

    // Fall back to system paths
    for (const sfPath of SYSTEM_SOUNDFONT_PATHS) {
      if (existsSync(sfPath)) {
        return sfPath;
      }
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
    let binaryPath: string | null = null;

    if (id === 'ffmpeg') {
      binaryPath = this.ffmpegPath;
    } else if (id === 'fluidsynth') {
      binaryPath = this.fluidsynthPath;
    }

    return {
      id,
      name: DEPENDENCY_NAMES[id],
      installed: binaryPath !== null,
      path: binaryPath,
      description: DEPENDENCY_DESCRIPTIONS[id],
      manualInstallUrl: MANUAL_INSTALL_URLS[id],
    };
  }

  /**
   * Finds a binary by checking platform-specific search paths.
   *
   * @param binary - The binary name (e.g., 'ffmpeg', 'ffprobe', 'fluidsynth')
   * @returns Absolute path to the binary, or null if not found
   */
  private findBinary(binary: string): string | null {
    const searchPaths: string[] = this.getSearchPaths(binary);

    for (const p of searchPaths) {
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
   * Gets platform-specific search paths for a binary.
   */
  private getSearchPaths(binary: string): string[] {
    switch (this.platform) {
      case 'darwin':
        return [
          `/opt/homebrew/bin/${binary}`,    // Homebrew Apple Silicon
          `/usr/local/bin/${binary}`,       // Homebrew Intel
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
        const programFilesX86: string = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
        const chocoToolsDir: string = process.env['ChocolateyToolsLocation'] ?? path.join(programFiles, 'Tools');
        const exe: string = `${binary}.exe`;

        return [
          // FFmpeg paths (winget and manual installs)
          path.join(programFiles, 'FFmpeg', 'bin', exe),
          path.join(programFilesX86, 'FFmpeg', 'bin', exe),
          path.join(localAppData, 'Microsoft', 'WinGet', 'Links', exe),
          // FluidSynth paths (Chocolatey installs to tools directory)
          path.join(chocoToolsDir, 'fluidsynth', 'bin', exe),
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
      const result: string = execSync(`where ${binary}`, {encoding: 'utf-8', timeout: 5000}).trim();
      const firstLine: string = result.split('\n')[0].trim();
      if (firstLine && existsSync(firstLine)) {
        return firstLine;
      }
    } catch {
      // 'where' returns exit code 1 if not found
    }
    return null;
  }

  /**
   * Gets the install command for a dependency on the current platform.
   *
   * @returns Command and args, or null if no package manager is available
   */
  private getInstallCommand(id: DependencyId): {command: string; args: string[]} | null {
    const packageName: string = this.getPackageName(id);

    switch (this.platform) {
      case 'darwin':
        return {command: 'brew', args: ['install', packageName]};

      case 'linux':
        return this.getLinuxInstallCommand(packageName);

      case 'win32':
        return this.getWindowsInstallCommand(id);

      default:
        return null;
    }
  }

  /**
   * Gets the uninstall command for a dependency on the current platform.
   *
   * @returns Command and args, or null if no package manager is available
   */
  private getUninstallCommand(id: DependencyId): {command: string; args: string[]} | null {
    const packageName: string = this.getPackageName(id);

    switch (this.platform) {
      case 'darwin':
        return {command: 'brew', args: ['uninstall', packageName]};

      case 'linux':
        return this.getLinuxUninstallCommand(packageName);

      case 'win32':
        return this.getWindowsUninstallCommand(id);

      default:
        return null;
    }
  }

  /**
   * Gets the package name for a dependency (used by brew/apt/dnf/pacman).
   */
  private getPackageName(id: DependencyId): string {
    switch (id) {
      case 'ffmpeg': return 'ffmpeg';
      case 'fluidsynth': return this.platform === 'darwin' ? 'fluid-synth' : 'fluidsynth';
    }
  }

  /**
   * Gets the winget package ID for Windows installation.
   */
  private getWingetId(id: DependencyId): string {
    switch (id) {
      case 'ffmpeg': return 'Gyan.FFmpeg';
      case 'fluidsynth': return 'FluidSynth.FluidSynth';
    }
  }

  /**
   * Gets the Windows install command for a dependency.
   * FFmpeg uses winget, FluidSynth uses Chocolatey (not available on winget).
   */
  private getWindowsInstallCommand(id: DependencyId): {command: string; args: string[]} | null {
    if (id === 'fluidsynth') {
      // FluidSynth is not available on winget, use Chocolatey
      if (!this.isChocoAvailable()) {
        return null; // Will trigger error with helpful message
      }
      return {command: 'choco', args: ['install', 'fluidsynth', '-y']};
    }
    // FFmpeg uses winget
    if (!this.isWingetAvailable()) {
      return null; // Will trigger error with helpful message
    }
    return {
      command: 'winget',
      args: ['install', this.getWingetId(id), '--accept-source-agreements', '--accept-package-agreements'],
    };
  }

  /**
   * Checks if Chocolatey is available on the system.
   */
  private isChocoAvailable(): boolean {
    try {
      execSync('where choco', {encoding: 'utf-8', timeout: 5000});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Checks if winget (Windows Package Manager) is available on the system.
   * winget is built into Windows 11 and Windows 10 (1809+) via App Installer.
   */
  private isWingetAvailable(): boolean {
    try {
      execSync('where winget', {encoding: 'utf-8', timeout: 5000});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Gets a helpful error message when no package manager is available.
   */
  private getPackageManagerErrorMessage(id: DependencyId, operation: 'install' | 'uninstall'): string {
    // Windows: FFmpeg requires winget
    if (this.platform === 'win32' && id === 'ffmpeg' && !this.isWingetAvailable()) {
      return `Cannot ${operation} FFmpeg: winget (Windows Package Manager) is required but not installed. ` +
        'Please install "App Installer" from the Microsoft Store or use the Manual Download link.';
    }

    // Windows: FluidSynth requires Chocolatey (for uninstall only - install can chain via winget)
    if (this.platform === 'win32' && id === 'fluidsynth' && !this.isChocoAvailable() && operation === 'uninstall') {
      return `Cannot ${operation} FluidSynth: Chocolatey is required but not installed. ` +
        'FluidSynth may have been installed manually. Please uninstall via Control Panel or use the Manual Download link.';
    }

    // Linux: requires pkexec for GUI privilege elevation
    if (this.platform === 'linux') {
      const pkgMgr: 'apt' | 'dnf' | 'pacman' | null = this.detectLinuxPackageManager();
      if (pkgMgr && !this.isPkexecAvailable()) {
        return `Cannot ${operation} ${DEPENDENCY_NAMES[id]}: pkexec is required for graphical authentication. ` +
          `Please install via terminal: sudo ${pkgMgr} ${operation === 'install' ? 'install' : 'remove'} -y ${this.getPackageName(id)}`;
      }
    }

    return `No package manager found for ${this.platform}`;
  }

  /**
   * Gets the Windows uninstall command for a dependency.
   * FFmpeg uses winget, FluidSynth uses Chocolatey.
   */
  private getWindowsUninstallCommand(id: DependencyId): {command: string; args: string[]} | null {
    if (id === 'fluidsynth') {
      // FluidSynth installed via Chocolatey
      if (!this.isChocoAvailable()) {
        return null;
      }
      return {command: 'choco', args: ['uninstall', 'fluidsynth', '-y']};
    }
    // FFmpeg uses winget
    if (!this.isWingetAvailable()) {
      return null;
    }
    return {
      command: 'winget',
      args: ['uninstall', this.getWingetId(id)],
    };
  }

  /**
   * Gets the Linux install command using the detected package manager.
   * Uses pkexec for graphical privilege elevation (shows native password dialog).
   */
  private getLinuxInstallCommand(packageName: string): {command: string; args: string[]} | null {
    const pkgMgr: 'apt' | 'dnf' | 'pacman' | null = this.detectLinuxPackageManager();
    if (!pkgMgr) return null;

    // Require pkexec for GUI privilege elevation
    if (!this.isPkexecAvailable()) return null;

    switch (pkgMgr) {
      case 'apt':
        return {command: 'pkexec', args: ['apt', 'install', '-y', packageName]};
      case 'dnf':
        return {command: 'pkexec', args: ['dnf', 'install', '-y', packageName]};
      case 'pacman':
        return {command: 'pkexec', args: ['pacman', '-S', '--noconfirm', packageName]};
      default:
        return null;
    }
  }

  /**
   * Gets the Linux uninstall command using the detected package manager.
   * Uses pkexec for graphical privilege elevation (shows native password dialog).
   */
  private getLinuxUninstallCommand(packageName: string): {command: string; args: string[]} | null {
    const pkgMgr: 'apt' | 'dnf' | 'pacman' | null = this.detectLinuxPackageManager();
    if (!pkgMgr) return null;

    // Require pkexec for GUI privilege elevation
    if (!this.isPkexecAvailable()) return null;

    switch (pkgMgr) {
      case 'apt':
        return {command: 'pkexec', args: ['apt', 'remove', '-y', packageName]};
      case 'dnf':
        return {command: 'pkexec', args: ['dnf', 'remove', '-y', packageName]};
      case 'pacman':
        return {command: 'pkexec', args: ['pacman', '-R', '--noconfirm', packageName]};
      default:
        return null;
    }
  }

  /**
   * Detects which Linux package manager is available.
   * Checks for apt, dnf, and pacman in order.
   */
  private detectLinuxPackageManager(): 'apt' | 'dnf' | 'pacman' | null {
    if (existsSync('/usr/bin/apt')) return 'apt';
    if (existsSync('/usr/bin/dnf')) return 'dnf';
    if (existsSync('/usr/bin/pacman')) return 'pacman';
    return null;
  }

  /**
   * Checks if pkexec is available for graphical privilege elevation on Linux.
   * pkexec is part of PolicyKit and provides a native password dialog.
   *
   * @returns True if pkexec is available
   */
  private isPkexecAvailable(): boolean {
    return existsSync('/usr/bin/pkexec');
  }

  /**
   * Runs a command and streams output via the progress callback.
   * Re-detects binaries after completion.
   *
   * @param command - The command to run
   * @param args - Command arguments
   * @param id - The dependency being operated on
   * @param operation - 'installing' or 'uninstalling'
   * @param onProgress - Progress callback
   * @returns True if the command succeeded (exit code 0)
   */
  private runCommand(
    command: string,
    args: string[],
    id: DependencyId,
    operation: 'installing' | 'uninstalling',
    onProgress: (progress: InstallProgress) => void
  ): Promise<boolean> {
    return new Promise<boolean>((resolve: (value: boolean) => void): void => {
      logProcessSpawn(depsLogger, command, args);

      const child: ChildProcess = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let outputBuffer: string = '';

      const appendOutput: (data: Buffer) => void = (data: Buffer): void => {
        const text: string = data.toString();
        outputBuffer += text;
        logProcessOutput(depsLogger, 'stdout', text);
        onProgress({
          dependencyId: id,
          status: operation,
          message: `${operation === 'installing' ? 'Installing' : 'Uninstalling'} ${DEPENDENCY_NAMES[id]}...`,
          output: outputBuffer,
        });
      };

      child.stdout?.on('data', appendOutput);
      child.stderr?.on('data', appendOutput);

      child.on('close', (code: number | null, signal: string | null): void => {
        logProcessExit(depsLogger, command, code, signal);

        // Re-detect binaries after install/uninstall
        this.detectBinaries();

        if (code === 0) {
          depsLogger.info(`${DEPENDENCY_NAMES[id]} ${operation === 'installing' ? 'installed' : 'uninstalled'} successfully`);
          onProgress({
            dependencyId: id,
            status: 'success',
            message: `${DEPENDENCY_NAMES[id]} ${operation === 'installing' ? 'installed' : 'uninstalled'} successfully.`,
            output: outputBuffer,
          });
          resolve(true);
        } else {
          const errorMsg: string = `${DEPENDENCY_NAMES[id]} ${operation} failed (exit code ${code})`;
          depsLogger.error(errorMsg);
          onProgress({
            dependencyId: id,
            status: 'error',
            message: errorMsg,
            output: outputBuffer,
          });
          resolve(false);
        }
      });

      child.on('error', (error: Error): void => {
        const errorMsg: string = `Failed to run ${command}: ${error.message}`;
        depsLogger.error(errorMsg);
        onProgress({
          dependencyId: id,
          status: 'error',
          message: errorMsg,
          output: outputBuffer,
        });
        resolve(false);
      });
    });
  }
}

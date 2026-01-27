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
    };
  }

  // ============================================================================
  // Install / Uninstall
  // ============================================================================

  /**
   * Installs a dependency using the platform-specific package manager.
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

    const cmd: {command: string; args: string[]} | null = this.getInstallCommand(id);
    if (!cmd) {
      const errorMsg: string = `No package manager found for ${this.platform}`;
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
      const errorMsg: string = `No package manager found for ${this.platform}`;
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
    const filePath: string = path.join(this.soundFontDir, fileName);

    // Prevent path traversal
    if (fileName.includes('..') || fileName.includes(path.sep)) {
      depsLogger.warn(`Rejected SoundFont removal (path traversal): ${fileName}`);
      return false;
    }

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
        const exe: string = `${binary}.exe`;

        return [
          path.join(programFiles, 'FFmpeg', 'bin', exe),
          path.join(programFilesX86, 'FFmpeg', 'bin', exe),
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
        return {
          command: 'winget',
          args: ['install', this.getWingetId(id), '--accept-source-agreements', '--accept-package-agreements'],
        };

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
        return {
          command: 'winget',
          args: ['uninstall', this.getWingetId(id)],
        };

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
   * Gets the Linux install command using the detected package manager.
   */
  private getLinuxInstallCommand(packageName: string): {command: string; args: string[]} | null {
    const pkgMgr: 'apt' | 'dnf' | 'pacman' | null = this.detectLinuxPackageManager();

    switch (pkgMgr) {
      case 'apt':
        return {command: 'sudo', args: ['apt', 'install', '-y', packageName]};
      case 'dnf':
        return {command: 'sudo', args: ['dnf', 'install', '-y', packageName]};
      case 'pacman':
        return {command: 'sudo', args: ['pacman', '-S', '--noconfirm', packageName]};
      default:
        return null;
    }
  }

  /**
   * Gets the Linux uninstall command using the detected package manager.
   */
  private getLinuxUninstallCommand(packageName: string): {command: string; args: string[]} | null {
    const pkgMgr: 'apt' | 'dnf' | 'pacman' | null = this.detectLinuxPackageManager();

    switch (pkgMgr) {
      case 'apt':
        return {command: 'sudo', args: ['apt', 'remove', '-y', packageName]};
      case 'dnf':
        return {command: 'sudo', args: ['dnf', 'remove', '-y', packageName]};
      case 'pacman':
        return {command: 'sudo', args: ['pacman', '-R', '--noconfirm', packageName]};
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

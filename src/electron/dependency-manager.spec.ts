/**
 * @fileoverview Comprehensive tests for DependencyManager.
 *
 * Tests cover:
 * - Constructor behavior (soundfont directory creation, binary detection)
 * - Binary detection across macOS and Linux platforms
 * - Public getter methods (getFfmpegPath, getFfprobePath, getFluidsynthPath)
 * - SoundFont management (list, find, install, remove)
 * - Path traversal rejection for SoundFont removal
 * - getState aggregation of dependency and soundfont info
 *
 * @module electron/dependency-manager.spec
 */

// ============================================================================
// Mocks
// ============================================================================

vi.mock('electron', () => ({
  app: {
    getPath: (): string => '/tmp/onixplayer-test',
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

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
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

import { existsSync, mkdirSync, copyFileSync, unlinkSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import * as path from 'path';
import { DependencyManager } from './dependency-manager.js';
import type { DependencyState, SoundFontInfo } from './dependency-manager.js';

// ============================================================================
// Type-safe mock accessors
// ============================================================================

const mockedExistsSync: ReturnType<typeof vi.fn> = vi.mocked(existsSync);
const mockedMkdirSync: ReturnType<typeof vi.fn> = vi.mocked(mkdirSync);
const mockedCopyFileSync: ReturnType<typeof vi.fn> = vi.mocked(copyFileSync);
const mockedUnlinkSync: ReturnType<typeof vi.fn> = vi.mocked(unlinkSync);
const mockedReaddirSync: ReturnType<typeof vi.fn> = vi.mocked(readdirSync);
const mockedStatSync: ReturnType<typeof vi.fn> = vi.mocked(statSync);
const mockedExecSync: ReturnType<typeof vi.fn> = vi.mocked(execSync);

// ============================================================================
// Helpers
// ============================================================================

const TEST_USER_DATA_PATH: string = '/tmp/test-user-data';
const TEST_SOUNDFONT_DIR: string = path.join(TEST_USER_DATA_PATH, 'soundfonts');

/**
 * Creates a DependencyManager with all existsSync calls returning false by default.
 * This ensures no binaries are found and the soundfont directory is "created".
 */
function createManager(platform: NodeJS.Platform = 'darwin'): DependencyManager {
  return new DependencyManager(platform, TEST_USER_DATA_PATH);
}

/**
 * Configures existsSync to return true only for the specified paths.
 * All other paths return false.
 */
function setExistingPaths(paths: string[]): void {
  mockedExistsSync.mockImplementation((p: string): boolean => paths.includes(p));
}

// ============================================================================
// Tests
// ============================================================================

describe('DependencyManager', (): void => {
  beforeEach((): void => {
    vi.clearAllMocks();
    // Default: nothing exists on the file system
    mockedExistsSync.mockReturnValue(false);
    mockedReaddirSync.mockReturnValue([]);
  });

  // ==========================================================================
  // Constructor / soundfont directory
  // ==========================================================================

  describe('constructor', (): void => {
    it('creates soundfont directory if it does not exist', (): void => {
      mockedExistsSync.mockReturnValue(false);

      createManager('darwin');

      expect(mockedMkdirSync).toHaveBeenCalledWith(TEST_SOUNDFONT_DIR, { recursive: true });
    });

    it('skips directory creation if it exists', (): void => {
      mockedExistsSync.mockImplementation((p: string): boolean => {
        if (p === TEST_SOUNDFONT_DIR) return true;
        return false;
      });

      createManager('darwin');

      expect(mockedMkdirSync).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Binary Detection
  // ==========================================================================

  describe('detectBinaries', (): void => {
    it('finds ffmpeg on macOS paths', (): void => {
      const ffmpegPath: string = '/opt/homebrew/bin/ffmpeg';
      setExistingPaths([ffmpegPath]);

      const manager: DependencyManager = createManager('darwin');

      expect(manager.getFfmpegPath()).toBe(ffmpegPath);
    });

    it('finds ffmpeg on macOS Intel path', (): void => {
      const ffmpegPath: string = '/usr/local/bin/ffmpeg';
      setExistingPaths([ffmpegPath]);

      const manager: DependencyManager = createManager('darwin');

      expect(manager.getFfmpegPath()).toBe(ffmpegPath);
    });

    it('finds ffmpeg on macOS system path', (): void => {
      const ffmpegPath: string = '/usr/bin/ffmpeg';
      setExistingPaths([ffmpegPath]);

      const manager: DependencyManager = createManager('darwin');

      expect(manager.getFfmpegPath()).toBe(ffmpegPath);
    });

    it('finds ffmpeg on Linux paths', (): void => {
      const ffmpegPath: string = '/usr/bin/ffmpeg';
      setExistingPaths([ffmpegPath]);

      const manager: DependencyManager = createManager('linux');

      expect(manager.getFfmpegPath()).toBe(ffmpegPath);
    });

    it('finds ffmpeg on Linux local path', (): void => {
      const ffmpegPath: string = '/usr/local/bin/ffmpeg';
      setExistingPaths([ffmpegPath]);

      const manager: DependencyManager = createManager('linux');

      expect(manager.getFfmpegPath()).toBe(ffmpegPath);
    });

    it('finds ffmpeg on Linux snap path', (): void => {
      const ffmpegPath: string = '/snap/bin/ffmpeg';
      setExistingPaths([ffmpegPath]);

      const manager: DependencyManager = createManager('linux');

      expect(manager.getFfmpegPath()).toBe(ffmpegPath);
    });

    it('returns null when binary not found', (): void => {
      mockedExistsSync.mockReturnValue(false);

      const manager: DependencyManager = createManager('darwin');

      expect(manager.getFfmpegPath()).toBeNull();
      expect(manager.getFfprobePath()).toBeNull();
      expect(manager.getFluidsynthPath()).toBeNull();
    });

    it('returns null for unknown platform', (): void => {
      mockedExistsSync.mockReturnValue(false);

      const manager: DependencyManager = createManager('freebsd' as NodeJS.Platform);

      expect(manager.getFfmpegPath()).toBeNull();
      expect(manager.getFfprobePath()).toBeNull();
      expect(manager.getFluidsynthPath()).toBeNull();
    });

    it('prefers first matching path (Homebrew Apple Silicon over Intel on macOS)', (): void => {
      const homebrewArm: string = '/opt/homebrew/bin/ffmpeg';
      const homebrewIntel: string = '/usr/local/bin/ffmpeg';
      setExistingPaths([homebrewArm, homebrewIntel]);

      const manager: DependencyManager = createManager('darwin');

      expect(manager.getFfmpegPath()).toBe(homebrewArm);
    });
  });

  // ==========================================================================
  // Public Getters
  // ==========================================================================

  describe('getFfmpegPath', (): void => {
    it('returns detected path', (): void => {
      const expectedPath: string = '/opt/homebrew/bin/ffmpeg';
      setExistingPaths([expectedPath]);

      const manager: DependencyManager = createManager('darwin');

      expect(manager.getFfmpegPath()).toBe(expectedPath);
    });
  });

  describe('getFfprobePath', (): void => {
    it('returns detected path', (): void => {
      const expectedPath: string = '/opt/homebrew/bin/ffprobe';
      setExistingPaths([expectedPath]);

      const manager: DependencyManager = createManager('darwin');

      expect(manager.getFfprobePath()).toBe(expectedPath);
    });
  });

  describe('getFluidsynthPath', (): void => {
    it('returns detected path', (): void => {
      const expectedPath: string = '/opt/homebrew/bin/fluidsynth';
      setExistingPaths([expectedPath]);

      const manager: DependencyManager = createManager('darwin');

      expect(manager.getFluidsynthPath()).toBe(expectedPath);
    });
  });

  // ==========================================================================
  // SoundFont Management
  // ==========================================================================

  describe('getSoundFonts', (): void => {
    it('returns installed .sf2 files with sizes', (): void => {
      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockReturnValue(['FluidR3_GM.sf2', 'GeneralUser.sf2']);
      mockedStatSync.mockImplementation((filePath: string): { isFile: () => boolean; size: number } => {
        if (filePath === path.join(TEST_SOUNDFONT_DIR, 'FluidR3_GM.sf2')) {
          return { isFile: (): boolean => true, size: 141000000 };
        }
        if (filePath === path.join(TEST_SOUNDFONT_DIR, 'GeneralUser.sf2')) {
          return { isFile: (): boolean => true, size: 29000000 };
        }
        return { isFile: (): boolean => false, size: 0 };
      });

      const manager: DependencyManager = createManager('darwin');
      const fonts: SoundFontInfo[] = manager.getSoundFonts();

      expect(fonts).toHaveLength(2);
      expect(fonts[0].fileName).toBe('FluidR3_GM.sf2');
      expect(fonts[0].filePath).toBe(path.join(TEST_SOUNDFONT_DIR, 'FluidR3_GM.sf2'));
      expect(fonts[0].sizeBytes).toBe(141000000);
      expect(fonts[1].fileName).toBe('GeneralUser.sf2');
      expect(fonts[1].sizeBytes).toBe(29000000);
    });

    it('filters out non-.sf2 files', (): void => {
      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockReturnValue(['readme.txt', 'FluidR3_GM.sf2', 'config.json', 'Backup.SF2']);
      mockedStatSync.mockReturnValue({ isFile: (): boolean => true, size: 1000 });

      const manager: DependencyManager = createManager('darwin');
      const fonts: SoundFontInfo[] = manager.getSoundFonts();

      // .sf2 and .SF2 should both match (case-insensitive via toLowerCase)
      expect(fonts).toHaveLength(2);
      expect(fonts[0].fileName).toBe('FluidR3_GM.sf2');
      expect(fonts[1].fileName).toBe('Backup.SF2');
    });

    it('returns empty array when directory read fails', (): void => {
      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockImplementation((): never => {
        throw new Error('ENOENT: no such file or directory');
      });

      const manager: DependencyManager = createManager('darwin');
      const fonts: SoundFontInfo[] = manager.getSoundFonts();

      expect(fonts).toEqual([]);
    });

    it('skips files that cannot be stat\'d', (): void => {
      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockReturnValue(['Good.sf2', 'Broken.sf2']);
      let callCount: number = 0;
      mockedStatSync.mockImplementation((): { isFile: () => boolean; size: number } => {
        callCount++;
        if (callCount === 1) {
          return { isFile: (): boolean => true, size: 5000 };
        }
        throw new Error('Permission denied');
      });

      const manager: DependencyManager = createManager('darwin');
      const fonts: SoundFontInfo[] = manager.getSoundFonts();

      expect(fonts).toHaveLength(1);
      expect(fonts[0].fileName).toBe('Good.sf2');
    });
  });

  // ==========================================================================
  // findSoundFont
  // ==========================================================================

  describe('findSoundFont', (): void => {
    it('returns user-installed SoundFont first', (): void => {
      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockReturnValue(['UserFont.sf2']);
      mockedStatSync.mockReturnValue({ isFile: (): boolean => true, size: 10000 });

      const manager: DependencyManager = createManager('darwin');
      const result: string | undefined = manager.findSoundFont();

      expect(result).toBe(path.join(TEST_SOUNDFONT_DIR, 'UserFont.sf2'));
    });

    it('falls back to system paths', (): void => {
      const systemSfPath: string = '/usr/share/sounds/sf2/FluidR3_GM.sf2';
      mockedReaddirSync.mockReturnValue([]);
      mockedExistsSync.mockImplementation((p: string): boolean => {
        if (p === systemSfPath) return true;
        return false;
      });

      const manager: DependencyManager = createManager('darwin');
      const result: string | undefined = manager.findSoundFont();

      expect(result).toBe(systemSfPath);
    });

    it('returns undefined when nothing found', (): void => {
      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockReturnValue([]);

      const manager: DependencyManager = createManager('darwin');
      const result: string | undefined = manager.findSoundFont();

      expect(result).toBeUndefined();
    });
  });

  // ==========================================================================
  // installSoundFont
  // ==========================================================================

  describe('installSoundFont', (): void => {
    it('copies file and returns info', (): void => {
      const sourcePath: string = '/home/user/Downloads/FluidR3_GM.sf2';
      const destPath: string = path.join(TEST_SOUNDFONT_DIR, 'FluidR3_GM.sf2');

      mockedExistsSync.mockImplementation((p: string): boolean => {
        if (p === sourcePath) return true;
        return false;
      });
      mockedStatSync.mockReturnValue({ isFile: (): boolean => true, size: 141000000 });

      const manager: DependencyManager = createManager('darwin');
      const result: SoundFontInfo = manager.installSoundFont(sourcePath);

      expect(mockedCopyFileSync).toHaveBeenCalledWith(sourcePath, destPath);
      expect(result.fileName).toBe('FluidR3_GM.sf2');
      expect(result.filePath).toBe(destPath);
      expect(result.sizeBytes).toBe(141000000);
    });

    it('throws when source not found', (): void => {
      mockedExistsSync.mockReturnValue(false);

      const manager: DependencyManager = createManager('darwin');

      expect((): void => {
        manager.installSoundFont('/nonexistent/path/font.sf2');
      }).toThrow('Source file not found: /nonexistent/path/font.sf2');
    });
  });

  // ==========================================================================
  // removeSoundFont
  // ==========================================================================

  describe('removeSoundFont', (): void => {
    it('removes existing file', (): void => {
      const filePath: string = path.join(TEST_SOUNDFONT_DIR, 'FluidR3_GM.sf2');
      mockedExistsSync.mockImplementation((p: string): boolean => {
        if (p === filePath) return true;
        return false;
      });

      const manager: DependencyManager = createManager('darwin');
      const result: boolean = manager.removeSoundFont('FluidR3_GM.sf2');

      expect(result).toBe(true);
      expect(mockedUnlinkSync).toHaveBeenCalledWith(filePath);
    });

    it('rejects path traversal with ..', (): void => {
      mockedExistsSync.mockReturnValue(false);

      const manager: DependencyManager = createManager('darwin');
      const result: boolean = manager.removeSoundFont('../../../etc/passwd');

      expect(result).toBe(false);
      expect(mockedUnlinkSync).not.toHaveBeenCalled();
    });

    it('rejects path traversal with path separator', (): void => {
      mockedExistsSync.mockReturnValue(false);

      const manager: DependencyManager = createManager('darwin');
      const result: boolean = manager.removeSoundFont(`subdir${path.sep}file.sf2`);

      expect(result).toBe(false);
      expect(mockedUnlinkSync).not.toHaveBeenCalled();
    });

    it('returns false for non-existent file', (): void => {
      mockedExistsSync.mockReturnValue(false);

      const manager: DependencyManager = createManager('darwin');
      const result: boolean = manager.removeSoundFont('nonexistent.sf2');

      expect(result).toBe(false);
      expect(mockedUnlinkSync).not.toHaveBeenCalled();
    });

    it('returns false when unlinkSync throws', (): void => {
      const filePath: string = path.join(TEST_SOUNDFONT_DIR, 'Locked.sf2');
      mockedExistsSync.mockImplementation((p: string): boolean => {
        if (p === filePath) return true;
        return false;
      });
      mockedUnlinkSync.mockImplementation((): never => {
        throw new Error('EACCES: permission denied');
      });

      const manager: DependencyManager = createManager('darwin');
      const result: boolean = manager.removeSoundFont('Locked.sf2');

      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // getState
  // ==========================================================================

  describe('getState', (): void => {
    it('returns complete dependency state', (): void => {
      const ffmpegPath: string = '/opt/homebrew/bin/ffmpeg';
      const fluidsynthPath: string = '/opt/homebrew/bin/fluidsynth';

      mockedExistsSync.mockImplementation((p: string): boolean => {
        if (p === ffmpegPath) return true;
        if (p === fluidsynthPath) return true;
        return false;
      });
      mockedReaddirSync.mockReturnValue([]);

      const manager: DependencyManager = createManager('darwin');
      const state: DependencyState = manager.getState();

      // FFmpeg status
      expect(state.ffmpeg.id).toBe('ffmpeg');
      expect(state.ffmpeg.name).toBe('FFmpeg');
      expect(state.ffmpeg.installed).toBe(true);
      expect(state.ffmpeg.path).toBe(ffmpegPath);
      expect(state.ffmpeg.description).toBe('Required for audio and video playback');
      expect(state.ffmpeg.manualInstallUrl).toBe('https://ffmpeg.org/download.html');

      // FluidSynth status
      expect(state.fluidsynth.id).toBe('fluidsynth');
      expect(state.fluidsynth.name).toBe('FluidSynth');
      expect(state.fluidsynth.installed).toBe(true);
      expect(state.fluidsynth.path).toBe(fluidsynthPath);
      expect(state.fluidsynth.description).toBe('Required for MIDI playback');
      expect(state.fluidsynth.manualInstallUrl).toBe('https://www.fluidsynth.org/download/');

      // No soundfonts, no active soundfont
      expect(state.soundfonts).toEqual([]);
      expect(state.activeSoundFont).toBeNull();
    });

    it('returns not-installed status when binaries are missing', (): void => {
      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockReturnValue([]);

      const manager: DependencyManager = createManager('darwin');
      const state: DependencyState = manager.getState();

      expect(state.ffmpeg.installed).toBe(false);
      expect(state.ffmpeg.path).toBeNull();
      expect(state.fluidsynth.installed).toBe(false);
      expect(state.fluidsynth.path).toBeNull();
    });

    it('includes soundfont info', (): void => {
      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockReturnValue(['MyFont.sf2']);
      mockedStatSync.mockReturnValue({ isFile: (): boolean => true, size: 50000 });

      const manager: DependencyManager = createManager('darwin');
      const state: DependencyState = manager.getState();

      expect(state.soundfonts).toHaveLength(1);
      expect(state.soundfonts[0].fileName).toBe('MyFont.sf2');
      expect(state.soundfonts[0].sizeBytes).toBe(50000);
      expect(state.activeSoundFont).toBe(path.join(TEST_SOUNDFONT_DIR, 'MyFont.sf2'));
    });

    it('returns null activeSoundFont when nothing available', (): void => {
      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockReturnValue([]);

      const manager: DependencyManager = createManager('darwin');
      const state: DependencyState = manager.getState();

      expect(state.activeSoundFont).toBeNull();
    });
  });

  // ==========================================================================
  // Windows binary detection (via 'where' fallback)
  // ==========================================================================

  describe('Windows binary detection', (): void => {
    it('finds binary via where command on win32', (): void => {
      const winFfmpegPath: string = 'C:\\Program Files\\FFmpeg\\bin\\ffmpeg.exe';
      mockedExistsSync.mockImplementation((p: string): boolean => {
        if (p === winFfmpegPath) return true;
        return false;
      });
      mockedExecSync.mockReturnValue(winFfmpegPath + '\n');

      const manager: DependencyManager = createManager('win32');

      // The 'where' fallback should be attempted for binaries not found via search paths.
      // If all search paths miss and where returns a valid path, it should be used.
      // Since existsSync returns true for the winFfmpegPath, where result is valid.
      expect(manager.getFfmpegPath()).toBe(winFfmpegPath);
    });

    it('returns null on win32 when where command fails', (): void => {
      mockedExistsSync.mockReturnValue(false);
      mockedExecSync.mockImplementation((): never => {
        throw new Error('Command failed: where ffmpeg');
      });

      const manager: DependencyManager = createManager('win32');

      expect(manager.getFfmpegPath()).toBeNull();
    });

    it('returns null on win32 when where returns non-existent path', (): void => {
      mockedExistsSync.mockReturnValue(false);
      mockedExecSync.mockReturnValue('C:\\Nonexistent\\ffmpeg.exe\n');

      const manager: DependencyManager = createManager('win32');

      expect(manager.getFfmpegPath()).toBeNull();
    });
  });

  // ==========================================================================
  // Windows package manager checks
  // ==========================================================================

  describe('Windows package manager availability', (): void => {
    it('returns error when winget is not available for FFmpeg install', async (): Promise<void> => {
      // Setup: Windows without winget
      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockReturnValue([]);
      mockedExecSync.mockImplementation((cmd: string): never => {
        throw new Error(`Command failed: ${cmd}`);
      });

      const manager: DependencyManager = createManager('win32');
      const progressCalls: Array<{status: string; message: string}> = [];

      const result: boolean = await manager.installDependency('ffmpeg', (progress): void => {
        progressCalls.push({status: progress.status, message: progress.message});
      });

      expect(result).toBe(false);
      expect(progressCalls).toHaveLength(1);
      expect(progressCalls[0].status).toBe('error');
      expect(progressCalls[0].message).toContain('winget');
      expect(progressCalls[0].message).toContain('Microsoft Store');
    });

    it('returns error when neither Chocolatey nor winget is available for FluidSynth install', async (): Promise<void> => {
      // Setup: Windows without Chocolatey AND without winget
      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockReturnValue([]);
      mockedExecSync.mockImplementation((cmd: string): never => {
        throw new Error(`Command failed: ${cmd}`);
      });

      const manager: DependencyManager = createManager('win32');
      const progressCalls: Array<{status: string; message: string}> = [];

      const result: boolean = await manager.installDependency('fluidsynth', (progress): void => {
        progressCalls.push({status: progress.status, message: progress.message});
      });

      expect(result).toBe(false);
      expect(progressCalls).toHaveLength(1);
      expect(progressCalls[0].status).toBe('error');
      expect(progressCalls[0].message).toContain('Neither Chocolatey nor winget');
    });

    it('chains Chocolatey install via winget when Chocolatey is missing but winget is available', async (): Promise<void> => {
      // Setup: Windows with winget but without Chocolatey initially
      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockReturnValue([]);
      mockedExecSync.mockImplementation((cmd: string): string => {
        if (cmd === 'where winget') return 'C:\\Windows\\winget.exe\n';
        if (cmd === 'where choco') throw new Error('Command failed: where choco');
        throw new Error(`Command failed: ${cmd}`);
      });

      const manager: DependencyManager = createManager('win32');
      const progressCalls: Array<{status: string; message: string}> = [];

      const { spawn } = await import('child_process');
      const mockedSpawn: ReturnType<typeof vi.fn> = vi.mocked(spawn);
      let spawnCallCount: number = 0;
      const mockProcess: {
        stdout: { on: ReturnType<typeof vi.fn> };
        stderr: { on: ReturnType<typeof vi.fn> };
        on: ReturnType<typeof vi.fn>;
      } = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, callback: (code: number) => void): void => {
          if (event === 'close') {
            setTimeout((): void => callback(0), 0);
          }
        }),
      };
      mockedSpawn.mockImplementation((): ReturnType<typeof spawn> => {
        spawnCallCount++;
        return mockProcess as ReturnType<typeof spawn>;
      });

      await manager.installDependency('fluidsynth', (progress): void => {
        progressCalls.push({status: progress.status, message: progress.message});
      });

      // Should have called spawn twice: once for winget (Chocolatey), once for choco (FluidSynth)
      expect(spawnCallCount).toBe(2);

      // First call: install Chocolatey via winget
      expect(mockedSpawn).toHaveBeenNthCalledWith(
        1,
        'winget',
        ['install', 'Chocolatey.Chocolatey', '--accept-source-agreements', '--accept-package-agreements'],
        expect.any(Object)
      );

      // Second call: install FluidSynth via choco (using full path)
      expect(mockedSpawn).toHaveBeenNthCalledWith(
        2,
        'C:\\ProgramData\\chocolatey\\bin\\choco.exe',
        ['install', 'fluidsynth', '-y'],
        expect.any(Object)
      );
    });

    it('uses winget when available for FFmpeg', async (): Promise<void> => {
      // Setup: Windows with winget available
      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockReturnValue([]);
      mockedExecSync.mockImplementation((cmd: string): string => {
        if (cmd === 'where winget') return 'C:\\Windows\\winget.exe\n';
        throw new Error(`Command failed: ${cmd}`);
      });

      const manager: DependencyManager = createManager('win32');

      const { spawn } = await import('child_process');
      const mockedSpawn: ReturnType<typeof vi.fn> = vi.mocked(spawn);
      const mockProcess: {
        stdout: { on: ReturnType<typeof vi.fn> };
        stderr: { on: ReturnType<typeof vi.fn> };
        on: ReturnType<typeof vi.fn>;
      } = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, callback: (code: number) => void): void => {
          if (event === 'close') {
            setTimeout((): void => callback(0), 0);
          }
        }),
      };
      mockedSpawn.mockReturnValue(mockProcess as ReturnType<typeof spawn>);

      await manager.installDependency('ffmpeg', vi.fn());

      expect(mockedSpawn).toHaveBeenCalledWith(
        'winget',
        ['install', 'Gyan.FFmpeg', '--accept-source-agreements', '--accept-package-agreements'],
        expect.any(Object)
      );
    });

    it('uses Chocolatey when available for FluidSynth', async (): Promise<void> => {
      // Setup: Windows with Chocolatey available
      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockReturnValue([]);
      mockedExecSync.mockImplementation((cmd: string): string => {
        if (cmd === 'where choco') return 'C:\\ProgramData\\chocolatey\\bin\\choco.exe\n';
        throw new Error(`Command failed: ${cmd}`);
      });

      const manager: DependencyManager = createManager('win32');

      const { spawn } = await import('child_process');
      const mockedSpawn: ReturnType<typeof vi.fn> = vi.mocked(spawn);
      const mockProcess: {
        stdout: { on: ReturnType<typeof vi.fn> };
        stderr: { on: ReturnType<typeof vi.fn> };
        on: ReturnType<typeof vi.fn>;
      } = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, callback: (code: number) => void): void => {
          if (event === 'close') {
            setTimeout((): void => callback(0), 0);
          }
        }),
      };
      mockedSpawn.mockReturnValue(mockProcess as ReturnType<typeof spawn>);

      await manager.installDependency('fluidsynth', vi.fn());

      expect(mockedSpawn).toHaveBeenCalledWith(
        'choco',
        ['install', 'fluidsynth', '-y'],
        expect.any(Object)
      );
    });
  });

  // ==========================================================================
  // Linux pkexec privilege elevation
  // ==========================================================================

  describe('Linux pkexec privilege elevation', (): void => {
    it('uses pkexec for apt install when available', async (): Promise<void> => {
      // Setup: Linux with apt and pkexec available
      mockedExistsSync.mockImplementation((p: string): boolean => {
        if (p === '/usr/bin/apt') return true;
        if (p === '/usr/bin/pkexec') return true;
        return false;
      });
      mockedReaddirSync.mockReturnValue([]);

      const manager: DependencyManager = createManager('linux');
      const progressCalls: Array<{status: string; message: string}> = [];

      // Mock spawn to capture the command
      const { spawn } = await import('child_process');
      const mockedSpawn: ReturnType<typeof vi.fn> = vi.mocked(spawn);
      const mockProcess: {
        stdout: { on: ReturnType<typeof vi.fn> };
        stderr: { on: ReturnType<typeof vi.fn> };
        on: ReturnType<typeof vi.fn>;
      } = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, callback: (code: number) => void): void => {
          if (event === 'close') {
            // Simulate successful completion
            setTimeout((): void => callback(0), 0);
          }
        }),
      };
      mockedSpawn.mockReturnValue(mockProcess as ReturnType<typeof spawn>);

      await manager.installDependency('ffmpeg', (progress): void => {
        progressCalls.push({status: progress.status, message: progress.message});
      });

      // Verify pkexec was used, not sudo
      expect(mockedSpawn).toHaveBeenCalledWith(
        'pkexec',
        ['apt', 'install', '-y', 'ffmpeg'],
        expect.any(Object)
      );
    });

    it('uses pkexec for apt uninstall when available', async (): Promise<void> => {
      // Setup: Linux with apt and pkexec available
      mockedExistsSync.mockImplementation((p: string): boolean => {
        if (p === '/usr/bin/apt') return true;
        if (p === '/usr/bin/pkexec') return true;
        return false;
      });
      mockedReaddirSync.mockReturnValue([]);

      const manager: DependencyManager = createManager('linux');

      const { spawn } = await import('child_process');
      const mockedSpawn: ReturnType<typeof vi.fn> = vi.mocked(spawn);
      const mockProcess: {
        stdout: { on: ReturnType<typeof vi.fn> };
        stderr: { on: ReturnType<typeof vi.fn> };
        on: ReturnType<typeof vi.fn>;
      } = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, callback: (code: number) => void): void => {
          if (event === 'close') {
            setTimeout((): void => callback(0), 0);
          }
        }),
      };
      mockedSpawn.mockReturnValue(mockProcess as ReturnType<typeof spawn>);

      await manager.uninstallDependency('ffmpeg', vi.fn());

      expect(mockedSpawn).toHaveBeenCalledWith(
        'pkexec',
        ['apt', 'remove', '-y', 'ffmpeg'],
        expect.any(Object)
      );
    });

    it('returns error when pkexec is not available on Linux', async (): Promise<void> => {
      // Setup: Linux with apt but NO pkexec
      mockedExistsSync.mockImplementation((p: string): boolean => {
        if (p === '/usr/bin/apt') return true;
        if (p === '/usr/bin/pkexec') return false;
        return false;
      });
      mockedReaddirSync.mockReturnValue([]);

      const manager: DependencyManager = createManager('linux');
      const progressCalls: Array<{status: string; message: string}> = [];

      const result: boolean = await manager.installDependency('ffmpeg', (progress): void => {
        progressCalls.push({status: progress.status, message: progress.message});
      });

      expect(result).toBe(false);
      expect(progressCalls).toHaveLength(1);
      expect(progressCalls[0].status).toBe('error');
      expect(progressCalls[0].message).toContain('pkexec is required');
      expect(progressCalls[0].message).toContain('sudo apt install -y ffmpeg');
    });

    it('uses pkexec for dnf on Fedora', async (): Promise<void> => {
      // Setup: Linux with dnf (no apt) and pkexec available
      mockedExistsSync.mockImplementation((p: string): boolean => {
        if (p === '/usr/bin/dnf') return true;
        if (p === '/usr/bin/pkexec') return true;
        return false;
      });
      mockedReaddirSync.mockReturnValue([]);

      const manager: DependencyManager = createManager('linux');

      const { spawn } = await import('child_process');
      const mockedSpawn: ReturnType<typeof vi.fn> = vi.mocked(spawn);
      const mockProcess: {
        stdout: { on: ReturnType<typeof vi.fn> };
        stderr: { on: ReturnType<typeof vi.fn> };
        on: ReturnType<typeof vi.fn>;
      } = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, callback: (code: number) => void): void => {
          if (event === 'close') {
            setTimeout((): void => callback(0), 0);
          }
        }),
      };
      mockedSpawn.mockReturnValue(mockProcess as ReturnType<typeof spawn>);

      await manager.installDependency('fluidsynth', vi.fn());

      expect(mockedSpawn).toHaveBeenCalledWith(
        'pkexec',
        ['dnf', 'install', '-y', 'fluidsynth'],
        expect.any(Object)
      );
    });

    it('uses pkexec for pacman on Arch', async (): Promise<void> => {
      // Setup: Linux with pacman (no apt, no dnf) and pkexec available
      mockedExistsSync.mockImplementation((p: string): boolean => {
        if (p === '/usr/bin/pacman') return true;
        if (p === '/usr/bin/pkexec') return true;
        return false;
      });
      mockedReaddirSync.mockReturnValue([]);

      const manager: DependencyManager = createManager('linux');

      const { spawn } = await import('child_process');
      const mockedSpawn: ReturnType<typeof vi.fn> = vi.mocked(spawn);
      const mockProcess: {
        stdout: { on: ReturnType<typeof vi.fn> };
        stderr: { on: ReturnType<typeof vi.fn> };
        on: ReturnType<typeof vi.fn>;
      } = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, callback: (code: number) => void): void => {
          if (event === 'close') {
            setTimeout((): void => callback(0), 0);
          }
        }),
      };
      mockedSpawn.mockReturnValue(mockProcess as ReturnType<typeof spawn>);

      await manager.uninstallDependency('ffmpeg', vi.fn());

      expect(mockedSpawn).toHaveBeenCalledWith(
        'pkexec',
        ['pacman', '-R', '--noconfirm', 'ffmpeg'],
        expect.any(Object)
      );
    });
  });

  // ==========================================================================
  // detectBinaries re-scan
  // ==========================================================================

  describe('detectBinaries re-scan', (): void => {
    it('updates paths after re-detection', (): void => {
      mockedExistsSync.mockReturnValue(false);
      mockedReaddirSync.mockReturnValue([]);

      const manager: DependencyManager = createManager('darwin');

      // Initially no binaries found
      expect(manager.getFfmpegPath()).toBeNull();

      // Simulate binary appearing after installation
      const ffmpegPath: string = '/opt/homebrew/bin/ffmpeg';
      mockedExistsSync.mockImplementation((p: string): boolean => {
        if (p === ffmpegPath) return true;
        return false;
      });

      manager.detectBinaries();

      expect(manager.getFfmpegPath()).toBe(ffmpegPath);
    });
  });
});

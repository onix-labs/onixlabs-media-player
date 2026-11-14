/**
 * @fileoverview Comprehensive tests for DependencyManager.
 *
 * Tests cover:
 * - Constructor behavior (soundfont directory creation, binary detection)
 * - Bundled binaries taking precedence over system ones, and tracker support
 * - System binary detection across macOS, Linux and Windows
 * - Downloading, updating and removing yt-dlp (network stubbed)
 * - SoundFont management (list, find, install, remove)
 * - Path traversal rejection for SoundFont removal
 * - getState aggregation of dependency and soundfont info
 * - Hardware encoder detection (probe output, failures, timeout)
 * - Binary discovery order (bundled, downloaded, system, Windows `where`)
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

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  createWriteStream: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  rm: vi.fn(),
  rename: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
  execFile: vi.fn(),
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

import { existsSync, mkdirSync, copyFileSync, unlinkSync, readdirSync, statSync, readFileSync, writeFileSync, chmodSync, createWriteStream } from 'fs';
import { rm, rename } from 'fs/promises';
import { spawn, execFileSync, execFile } from 'child_process';
import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import * as path from 'path';
import { DependencyManager } from './dependency-manager.js';
import type { DependencyManagerOptions, DependencyState, FetchFunction, InstallProgress, SoundFontInfo } from './dependency-manager.js';

// ============================================================================
// Type-safe mock accessors
// ============================================================================

const mockedExistsSync: ReturnType<typeof vi.fn> = vi.mocked(existsSync);
const mockedMkdirSync: ReturnType<typeof vi.fn> = vi.mocked(mkdirSync);
const mockedCopyFileSync: ReturnType<typeof vi.fn> = vi.mocked(copyFileSync);
const mockedUnlinkSync: ReturnType<typeof vi.fn> = vi.mocked(unlinkSync);
const mockedReaddirSync: ReturnType<typeof vi.fn> = vi.mocked(readdirSync);
const mockedStatSync: ReturnType<typeof vi.fn> = vi.mocked(statSync);
const mockedReadFileSync: ReturnType<typeof vi.fn> = vi.mocked(readFileSync);
const mockedWriteFileSync: ReturnType<typeof vi.fn> = vi.mocked(writeFileSync);
const mockedChmodSync: ReturnType<typeof vi.fn> = vi.mocked(chmodSync);
const mockedCreateWriteStream: ReturnType<typeof vi.fn> = vi.mocked(createWriteStream);
const mockedRm: ReturnType<typeof vi.fn> = vi.mocked(rm);
const mockedRename: ReturnType<typeof vi.fn> = vi.mocked(rename);
const mockedExecFileSync: ReturnType<typeof vi.fn> = vi.mocked(execFileSync);
const mockedExecFile: ReturnType<typeof vi.fn> = vi.mocked(execFile);
const mockedSpawn: ReturnType<typeof vi.fn> = vi.mocked(spawn);

// ============================================================================
// Helpers
// ============================================================================

const TEST_USER_DATA_PATH: string = '/tmp/test-user-data';
const TEST_SOUNDFONT_DIR: string = path.join(TEST_USER_DATA_PATH, 'soundfonts');
const TEST_YTDLP_DIR: string = path.join(TEST_USER_DATA_PATH, 'yt-dlp');
const TEST_BUNDLED_BIN_DIR: string = '/Applications/ONIXPlayer.app/Contents/Resources/bin';

/**
 * Creates a DependencyManager with all existsSync calls returning false by default.
 * This ensures no binaries are found and the soundfont directory is "created".
 */
function createManager(platform: NodeJS.Platform = 'darwin', options: DependencyManagerOptions = {}): DependencyManager {
  return new DependencyManager(platform, TEST_USER_DATA_PATH, options);
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
    // Reset, not just clear: several tests give a mock a throwing
    // implementation, which would otherwise leak into later tests.
    vi.resetAllMocks();
    // Default: nothing exists on the file system
    mockedExistsSync.mockReturnValue(false);
    mockedReaddirSync.mockReturnValue([]);
    mockedReadFileSync.mockImplementation((): never => {
      throw new Error('ENOENT: no such file or directory');
    });
    mockedRm.mockResolvedValue(undefined);
    mockedRename.mockResolvedValue(undefined);
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
      expect(state.ffmpeg.source).toBe('system');
      expect(state.ffmpeg.managed).toBe(false);
      expect(state.ffmpeg.description).toBe('Audio, video and tracker module playback');
      expect(state.ffmpeg.websiteUrl).toBe('https://ffmpeg.org/');

      // FluidSynth status
      expect(state.fluidsynth.id).toBe('fluidsynth');
      expect(state.fluidsynth.name).toBe('FluidSynth');
      expect(state.fluidsynth.installed).toBe(true);
      expect(state.fluidsynth.path).toBe(fluidsynthPath);
      expect(state.fluidsynth.source).toBe('system');
      expect(state.fluidsynth.description).toBe('MIDI playback');
      expect(state.fluidsynth.websiteUrl).toBe('https://www.fluidsynth.org/');

      // yt-dlp is the one dependency the app manages itself
      expect(state.ytdlp.installed).toBe(false);
      expect(state.ytdlp.source).toBeNull();
      expect(state.ytdlp.managed).toBe(true);

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

    it('reports MIDI as unavailable until a SoundFont is installed', (): void => {
      setExistingPaths(['/usr/local/bin/fluidsynth']);
      mockedReaddirSync.mockReturnValue([]);

      const manager: DependencyManager = createManager('darwin');

      expect(manager.getState().midiSupport).toBe(false);
      expect(manager.hasMidiSupport()).toBe(false);
    });

    it('reports MIDI as available with FluidSynth and a SoundFont', (): void => {
      setExistingPaths(['/usr/local/bin/fluidsynth']);
      mockedReaddirSync.mockReturnValue(['GeneralUser.sf2']);
      mockedStatSync.mockReturnValue({ isFile: (): boolean => true, size: 30000000 });

      const manager: DependencyManager = createManager('darwin');

      expect(manager.getState().midiSupport).toBe(true);
      expect(manager.hasMidiSupport()).toBe(true);
    });

    it('reports MIDI as unavailable with a SoundFont but no FluidSynth', (): void => {
      mockedReaddirSync.mockReturnValue(['GeneralUser.sf2']);
      mockedStatSync.mockReturnValue({ isFile: (): boolean => true, size: 30000000 });

      const manager: DependencyManager = createManager('darwin');

      expect(manager.getState().midiSupport).toBe(false);
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
  // Bundled binaries
  // ==========================================================================

  describe('bundled binaries', (): void => {
    const bundledFfmpeg: string = path.join(TEST_BUNDLED_BIN_DIR, 'ffmpeg');

    it('prefers the bundled binary over a system one', (): void => {
      setExistingPaths([bundledFfmpeg, '/usr/local/bin/ffmpeg']);

      const manager: DependencyManager = createManager('darwin', {bundledBinDir: TEST_BUNDLED_BIN_DIR});

      expect(manager.getFfmpegPath()).toBe(bundledFfmpeg);
      expect(manager.getState().ffmpeg.source).toBe('bundled');
    });

    it('falls back to a system binary when the bundle lacks one', (): void => {
      setExistingPaths(['/usr/local/bin/fluidsynth']);

      const manager: DependencyManager = createManager('darwin', {bundledBinDir: TEST_BUNDLED_BIN_DIR});

      expect(manager.getFluidsynthPath()).toBe('/usr/local/bin/fluidsynth');
      expect(manager.getState().fluidsynth.source).toBe('system');
    });

    it('looks for .exe binaries in the bundle on Windows', (): void => {
      const bundledExe: string = path.join(TEST_BUNDLED_BIN_DIR, 'ffmpeg.exe');
      setExistingPaths([bundledExe]);

      const manager: DependencyManager = createManager('win32', {bundledBinDir: TEST_BUNDLED_BIN_DIR});

      expect(manager.getFfmpegPath()).toBe(bundledExe);
    });

    it('reports the versions recorded beside the bundled binaries', (): void => {
      setExistingPaths([bundledFfmpeg]);
      mockedReadFileSync.mockImplementation((p: string): string => {
        if (p === path.join(TEST_BUNDLED_BIN_DIR, 'versions.json')) {
          return JSON.stringify({ffmpeg: '9.0.2', fluidsynth: '2.6.2'});
        }
        throw new Error('ENOENT');
      });

      const manager: DependencyManager = createManager('darwin', {bundledBinDir: TEST_BUNDLED_BIN_DIR});

      expect(manager.getState().ffmpeg.version).toBe('9.0.2');
    });

    it('assumes tracker support for the bundled FFmpeg without probing it', (): void => {
      setExistingPaths([bundledFfmpeg]);

      const manager: DependencyManager = createManager('darwin', {bundledBinDir: TEST_BUNDLED_BIN_DIR});

      expect(manager.hasTrackerSupport()).toBe(true);
      expect(manager.getState().trackerSupport).toBe(true);
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it('probes a system FFmpeg for the libopenmpt demuxer', (): void => {
      setExistingPaths(['/usr/local/bin/ffmpeg']);
      mockedExecFileSync.mockReturnValue(' D  libopenmpt      Tracker formats (libopenmpt)\n');

      const manager: DependencyManager = createManager('darwin');

      expect(mockedExecFileSync).toHaveBeenCalledWith('/usr/local/bin/ffmpeg', ['-hide_banner', '-demuxers'], expect.any(Object));
      expect(manager.hasTrackerSupport()).toBe(true);
    });

    it('reports no tracker support for a system FFmpeg without libopenmpt', (): void => {
      setExistingPaths(['/usr/local/bin/ffmpeg']);
      mockedExecFileSync.mockReturnValue(' D  mov,mp4,m4a      QuickTime / MOV\n');

      const manager: DependencyManager = createManager('darwin');

      expect(manager.hasTrackerSupport()).toBe(false);
    });

    it('reports no tracker support without FFmpeg', (): void => {
      const manager: DependencyManager = createManager('darwin');

      expect(manager.hasTrackerSupport()).toBe(false);
    });

    it('exposes the configured JavaScript runtime for yt-dlp', (): void => {
      const manager: DependencyManager = createManager('darwin', {jsRuntimePath: '/Applications/ONIXPlayer.app/Contents/MacOS/ONIXPlayer'});

      expect(manager.getJsRuntimePath()).toBe('/Applications/ONIXPlayer.app/Contents/MacOS/ONIXPlayer');
    });
  });

  // ==========================================================================
  // Windows binary detection (via 'where' fallback)
  // ==========================================================================

  describe('Windows binary detection', (): void => {
    it('finds binary via where command on win32', (): void => {
      const winFfmpegPath: string = 'C:\\Program Files\\FFmpeg\\bin\\ffmpeg.exe';
      mockedExistsSync.mockImplementation((p: string): boolean => p === winFfmpegPath);
      mockedExecFileSync.mockReturnValue(winFfmpegPath + '\n');

      const manager: DependencyManager = createManager('win32');

      expect(manager.getFfmpegPath()).toBe(winFfmpegPath);
    });

    it('returns null on win32 when where command fails', (): void => {
      mockedExistsSync.mockReturnValue(false);
      mockedExecFileSync.mockImplementation((): never => {
        throw new Error('Command failed: where ffmpeg');
      });

      const manager: DependencyManager = createManager('win32');

      expect(manager.getFfmpegPath()).toBeNull();
    });

    it('returns null on win32 when where returns non-existent path', (): void => {
      mockedExistsSync.mockReturnValue(false);
      mockedExecFileSync.mockReturnValue('C:\\Nonexistent\\ffmpeg.exe\n');

      const manager: DependencyManager = createManager('win32');

      expect(manager.getFfmpegPath()).toBeNull();
    });
  });

  // ==========================================================================
  // yt-dlp download
  // ==========================================================================

  describe('yt-dlp download', (): void => {
    const TAG: string = '2026.10.26';
    const ASSET_BYTES: Uint8Array<ArrayBuffer> = new TextEncoder().encode('pretend this is yt-dlp');
    const ASSET_SHA256: string = createHash('sha256').update(ASSET_BYTES).digest('hex');
    const STAGING: string = `${TEST_YTDLP_DIR}.download`;

    /** Writes made to the download file */
    let written: Uint8Array[];

    /**
     * A fetch that serves a fake yt-dlp release.
     *
     * @param sums - Contents of SHA2-256SUMS
     */
    function createReleaseFetch(sums: string): ReturnType<typeof vi.fn> & FetchFunction {
      return vi.fn(async (url: string): Promise<Response> => {
        if (url === 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest') {
          return new Response(JSON.stringify({tag_name: TAG}));
        }
        if (url === `https://github.com/yt-dlp/yt-dlp/releases/download/${TAG}/SHA2-256SUMS`) {
          return new Response(sums);
        }
        if (url.startsWith(`https://github.com/yt-dlp/yt-dlp/releases/download/${TAG}/`)) {
          return new Response(ASSET_BYTES, {headers: {'content-length': String(ASSET_BYTES.length)}});
        }
        return new Response('not found', {status: 404});
      }) as ReturnType<typeof vi.fn> & FetchFunction;
    }

    /** Runs an operation and collects its progress reports. */
    async function collect(run: (onProgress: (progress: InstallProgress) => void) => Promise<boolean>): Promise<{result: boolean; progress: InstallProgress[]}> {
      const progress: InstallProgress[] = [];
      const result: boolean = await run((p: InstallProgress): void => {
        progress.push(p);
      });
      return {result, progress};
    }

    beforeEach((): void => {
      written = [];
      mockedCreateWriteStream.mockReturnValue({
        write: vi.fn((chunk: Uint8Array): boolean => {
          written.push(chunk);
          return true;
        }),
        once: vi.fn(),
        end: vi.fn((callback: () => void): void => callback()),
      });
      // ditto succeeds
      mockedExecFile.mockImplementation((_command: string, _args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void): void => {
        callback(null, '', '');
      });
      // The unpacked executable is present once the download lands
      mockedExistsSync.mockImplementation((p: string): boolean => p.endsWith('yt-dlp_macos') || p.endsWith(`${path.sep}yt-dlp`));
    });

    it('downloads, verifies and unpacks the macOS build', async (): Promise<void> => {
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createReleaseFetch(`${ASSET_SHA256}  yt-dlp_macos.zip\n`);
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});

      const {result, progress} = await collect((onProgress: (progress: InstallProgress) => void): Promise<boolean> => manager.installDependency('yt-dlp', onProgress));

      expect(result).toBe(true);
      expect(fetchFn).toHaveBeenCalledWith(`https://github.com/yt-dlp/yt-dlp/releases/download/${TAG}/yt-dlp_macos.zip`);
      expect(Buffer.concat(written)).toEqual(Buffer.from(ASSET_BYTES));
      expect(mockedExecFile).toHaveBeenCalledWith(
        '/usr/bin/ditto',
        ['-x', '-k', path.join(STAGING, 'yt-dlp_macos.zip'), path.join(STAGING, 'yt-dlp')],
        expect.any(Function)
      );
      expect(mockedChmodSync).toHaveBeenCalledWith(path.join(STAGING, 'yt-dlp', 'yt-dlp_macos'), 0o755);
      expect(mockedWriteFileSync).toHaveBeenCalledWith(path.join(STAGING, 'yt-dlp', 'version.txt'), `${TAG}\n`);
      expect(mockedRename).toHaveBeenCalledWith(path.join(STAGING, 'yt-dlp'), TEST_YTDLP_DIR);
      expect(progress.some((p: InstallProgress): boolean => p.percent === 100)).toBe(true);
      expect(progress[progress.length - 1]).toMatchObject({status: 'success', message: `yt-dlp installed: ${TAG}.`});
    });

    it('installs the single-file Linux build without unpacking', async (): Promise<void> => {
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createReleaseFetch(`${ASSET_SHA256}  yt-dlp_linux\n`);
      const manager: DependencyManager = createManager('linux', {arch: 'x64', fetch: fetchFn});

      const {result} = await collect((onProgress: (progress: InstallProgress) => void): Promise<boolean> => manager.installDependency('yt-dlp', onProgress));

      expect(result).toBe(true);
      expect(mockedExecFile).not.toHaveBeenCalled();
      expect(mockedRename).toHaveBeenCalledWith(path.join(STAGING, 'yt-dlp_linux'), path.join(STAGING, 'yt-dlp', 'yt-dlp'));
      expect(mockedChmodSync).toHaveBeenCalledWith(path.join(STAGING, 'yt-dlp', 'yt-dlp'), 0o755);
    });

    it('rejects a download whose checksum does not match, keeping the old copy', async (): Promise<void> => {
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createReleaseFetch(`${'0'.repeat(64)}  yt-dlp_macos.zip\n`);
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});

      const {result, progress} = await collect((onProgress: (progress: InstallProgress) => void): Promise<boolean> => manager.installDependency('yt-dlp', onProgress));

      expect(result).toBe(false);
      expect(progress[progress.length - 1].status).toBe('error');
      expect(progress[progress.length - 1].message).toContain('checksum mismatch');
      expect(mockedRename).not.toHaveBeenCalledWith(expect.anything(), TEST_YTDLP_DIR);
      expect(mockedRm).not.toHaveBeenCalledWith(TEST_YTDLP_DIR, expect.anything());
    });

    it('fails when the release has no checksum for the asset', async (): Promise<void> => {
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createReleaseFetch(`${ASSET_SHA256}  yt-dlp.exe\n`);
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});

      const {result, progress} = await collect((onProgress: (progress: InstallProgress) => void): Promise<boolean> => manager.installDependency('yt-dlp', onProgress));

      expect(result).toBe(false);
      expect(progress[progress.length - 1].message).toContain('SHA2-256SUMS has no entry for yt-dlp_macos.zip');
    });

    it('reports a GitHub error when the latest release cannot be read', async (): Promise<void> => {
      const fetchFn: FetchFunction = vi.fn(async (): Promise<Response> => new Response('rate limited', {status: 403}));
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});

      const {result, progress} = await collect((onProgress: (progress: InstallProgress) => void): Promise<boolean> => manager.installDependency('yt-dlp', onProgress));

      expect(result).toBe(false);
      expect(progress[progress.length - 1].message).toContain('GitHub returned 403');
    });

    it('skips the download when an update finds the installed version is current', async (): Promise<void> => {
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createReleaseFetch(`${ASSET_SHA256}  yt-dlp_macos.zip\n`);
      mockedReadFileSync.mockImplementation((p: string): string => {
        if (p === path.join(TEST_YTDLP_DIR, 'version.txt')) return `${TAG}\n`;
        throw new Error('ENOENT');
      });
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});

      const {result, progress} = await collect((onProgress: (progress: InstallProgress) => void): Promise<boolean> => manager.updateDependency('yt-dlp', onProgress));

      expect(result).toBe(true);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(progress[progress.length - 1].message).toBe(`yt-dlp ${TAG} is already the latest version.`);
    });

    it('fails on a platform yt-dlp publishes no build for', async (): Promise<void> => {
      const manager: DependencyManager = createManager('win32', {arch: 'ppc64'});

      const {result, progress} = await collect((onProgress: (progress: InstallProgress) => void): Promise<boolean> => manager.installDependency('yt-dlp', onProgress));

      expect(result).toBe(false);
      expect(progress[0].message).toContain('does not publish a build for win32 (ppc64)');
    });

    it('marks the downloaded copy as downloaded, with its version', (): void => {
      mockedReadFileSync.mockImplementation((p: string): string => {
        if (p === path.join(TEST_YTDLP_DIR, 'version.txt')) return `${TAG}\n`;
        throw new Error('ENOENT');
      });

      const manager: DependencyManager = createManager('darwin');
      const state: DependencyState = manager.getState();

      expect(state.ytdlp.path).toBe(path.join(TEST_YTDLP_DIR, 'yt-dlp_macos'));
      expect(state.ytdlp.source).toBe('downloaded');
      expect(state.ytdlp.version).toBe(TAG);
    });

    // ------------------------------------------------------------------------
    // Additional download behaviour
    // ------------------------------------------------------------------------

    const LATEST_RELEASE_URL: string = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
    const CHECKSUMS_URL: string = `https://github.com/yt-dlp/yt-dlp/releases/download/${TAG}/SHA2-256SUMS`;
    const MACOS_SUMS: string = `${ASSET_SHA256}  yt-dlp_macos.zip\n`;

    /** Runs a yt-dlp install and collects its progress reports. */
    function install(manager: DependencyManager): Promise<{result: boolean; progress: InstallProgress[]}> {
      return collect((onProgress: (progress: InstallProgress) => void): Promise<boolean> => manager.installDependency('yt-dlp', onProgress));
    }

    /** Runs a yt-dlp update and collects its progress reports. */
    function update(manager: DependencyManager): Promise<{result: boolean; progress: InstallProgress[]}> {
      return collect((onProgress: (progress: InstallProgress) => void): Promise<boolean> => manager.updateDependency('yt-dlp', onProgress));
    }

    /**
     * A release fetch in which chosen URLs are answered differently.
     *
     * @param sums - Contents of SHA2-256SUMS
     * @param override - Returns the response for a URL, or undefined to serve the normal release
     */
    function createOverriddenFetch(
      sums: string,
      override: (url: string) => Response | Promise<Response> | undefined
    ): ReturnType<typeof vi.fn> & FetchFunction {
      const releaseFetch: FetchFunction = createReleaseFetch(sums);
      return vi.fn(async (url: string, init?: {readonly headers?: Record<string, string>}): Promise<Response> => {
        const overridden: Response | Promise<Response> | undefined = override(url);
        return overridden ?? releaseFetch(url, init);
      }) as ReturnType<typeof vi.fn> & FetchFunction;
    }

    /** A response whose body arrives in the given chunks, with no content-length unless one is given. */
    function createChunkedResponse(chunks: readonly Uint8Array[], contentLength?: number): Response {
      const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
        start(controller: ReadableStreamDefaultController<Uint8Array>): void {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
      return new Response(body, contentLength === undefined ? {} : {headers: {'content-length': String(contentLength)}});
    }

    /** The last progress report of an operation. */
    function lastOf(progress: readonly InstallProgress[]): InstallProgress {
      return progress[progress.length - 1];
    }

    afterEach((): void => {
      vi.unstubAllGlobals();
    });

    it('asks GitHub for the latest release with the GitHub JSON media type', async (): Promise<void> => {
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createReleaseFetch(MACOS_SUMS);
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});

      await install(manager);

      expect(fetchFn).toHaveBeenCalledWith(LATEST_RELEASE_URL, {headers: {Accept: 'application/vnd.github+json'}});
    });

    it('uses the global fetch when none is injected', async (): Promise<void> => {
      const globalFetch: ReturnType<typeof vi.fn> = vi.fn(async (): Promise<Response> => new Response('down', {status: 503}));
      vi.stubGlobal('fetch', globalFetch);
      const manager: DependencyManager = createManager('darwin');

      const {result, progress} = await install(manager);

      expect(globalFetch).toHaveBeenCalledWith(LATEST_RELEASE_URL, {headers: {Accept: 'application/vnd.github+json'}});
      expect(result).toBe(false);
      expect(lastOf(progress).message).toContain('GitHub returned 503');
    });

    it('reports each stage of an install in order', async (): Promise<void> => {
      const manager: DependencyManager = createManager('darwin', {fetch: createReleaseFetch(MACOS_SUMS)});

      const {progress} = await install(manager);

      expect(progress).toEqual([
        {dependencyId: 'yt-dlp', status: 'installing', message: 'Finding the latest yt-dlp release...'},
        {dependencyId: 'yt-dlp', status: 'installing', message: `Downloading yt-dlp ${TAG}... 100%`, percent: 100},
        {dependencyId: 'yt-dlp', status: 'installing', message: `Unpacking yt-dlp ${TAG}...`},
        {dependencyId: 'yt-dlp', status: 'success', message: `yt-dlp installed: ${TAG}.`},
      ]);
    });

    it('replaces an older download when updating', async (): Promise<void> => {
      mockedReadFileSync.mockImplementation((p: string): string => {
        if (p === path.join(TEST_YTDLP_DIR, 'version.txt')) return '2025.01.01\n';
        throw new Error('ENOENT');
      });
      const manager: DependencyManager = createManager('darwin', {fetch: createReleaseFetch(MACOS_SUMS)});

      const {result, progress} = await update(manager);

      expect(result).toBe(true);
      expect(mockedRename).toHaveBeenCalledWith(path.join(STAGING, 'yt-dlp'), TEST_YTDLP_DIR);
      expect(progress[0].status).toBe('updating');
      expect(lastOf(progress)).toEqual({dependencyId: 'yt-dlp', status: 'success', message: `yt-dlp updated to ${TAG}.`});
    });

    it('downloads again when the recorded version is current but the executable is missing', async (): Promise<void> => {
      let installed: boolean = false;
      mockedReadFileSync.mockImplementation((p: string): string => {
        if (p === path.join(TEST_YTDLP_DIR, 'version.txt')) return `${TAG}\n`;
        throw new Error('ENOENT');
      });
      mockedExistsSync.mockImplementation((p: string): boolean =>
        p.startsWith(STAGING) ? p.endsWith('yt-dlp_macos') : installed && p === path.join(TEST_YTDLP_DIR, 'yt-dlp_macos'));
      mockedRename.mockImplementation(async (_from: string, to: string): Promise<void> => {
        installed = installed || to === TEST_YTDLP_DIR;
      });
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createReleaseFetch(MACOS_SUMS);
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});

      const {result} = await update(manager);

      expect(result).toBe(true);
      expect(fetchFn).toHaveBeenCalledWith(`https://github.com/yt-dlp/yt-dlp/releases/download/${TAG}/yt-dlp_macos.zip`);
    });

    it('finds the new download once an install completes', async (): Promise<void> => {
      let installed: boolean = false;
      mockedExistsSync.mockImplementation((p: string): boolean =>
        p.startsWith(STAGING) ? p.endsWith('yt-dlp_macos') : installed && p === path.join(TEST_YTDLP_DIR, 'yt-dlp_macos'));
      mockedRename.mockImplementation(async (_from: string, to: string): Promise<void> => {
        installed = installed || to === TEST_YTDLP_DIR;
      });
      const manager: DependencyManager = createManager('darwin', {fetch: createReleaseFetch(MACOS_SUMS)});
      const before: string | null = manager.getYtDlpPath();

      await install(manager);

      expect(before).toBeNull();
      expect(manager.getYtDlpPath()).toBe(path.join(TEST_YTDLP_DIR, 'yt-dlp_macos'));
    });

    it.each([
      ['win32', 'x64', 'yt-dlp.exe', 'yt-dlp.exe'],
      ['win32', 'arm64', 'yt-dlp_arm64.exe', 'yt-dlp.exe'],
      ['win32', 'ia32', 'yt-dlp_x86.exe', 'yt-dlp.exe'],
      ['linux', 'x64', 'yt-dlp_linux', 'yt-dlp'],
      ['linux', 'arm64', 'yt-dlp_linux_aarch64', 'yt-dlp'],
    ] as const)('downloads the %s %s build as %s and installs it as %s', async (platform: NodeJS.Platform, arch: string, asset: string, executable: string): Promise<void> => {
      mockedExistsSync.mockImplementation((p: string): boolean => p.endsWith(`${path.sep}${executable}`));
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createReleaseFetch(`${ASSET_SHA256}  ${asset}\n`);
      const manager: DependencyManager = createManager(platform, {arch, fetch: fetchFn});

      const {result} = await install(manager);

      expect(result).toBe(true);
      expect(fetchFn).toHaveBeenCalledWith(`https://github.com/yt-dlp/yt-dlp/releases/download/${TAG}/${asset}`);
      expect(mockedRename).toHaveBeenCalledWith(path.join(STAGING, asset), path.join(STAGING, 'yt-dlp', executable));
    });

    it('does not change file permissions on Windows', async (): Promise<void> => {
      mockedExistsSync.mockImplementation((p: string): boolean => p.endsWith(`${path.sep}yt-dlp.exe`));
      const manager: DependencyManager = createManager('win32', {arch: 'x64', fetch: createReleaseFetch(`${ASSET_SHA256}  yt-dlp.exe\n`)});

      const {result} = await install(manager);

      expect(result).toBe(true);
      expect(mockedChmodSync).not.toHaveBeenCalled();
    });

    it.each([
      ['linux', 'ia32'],
      ['linux', 'riscv64'],
      ['freebsd', 'x64'],
    ] as const)('fails on %s %s, which yt-dlp publishes no build for', async (platform: string, arch: string): Promise<void> => {
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createReleaseFetch(MACOS_SUMS);
      const manager: DependencyManager = createManager(platform as NodeJS.Platform, {arch, fetch: fetchFn});

      const {result, progress} = await install(manager);

      expect(result).toBe(false);
      expect(progress).toEqual([
        {dependencyId: 'yt-dlp', status: 'error', message: `yt-dlp does not publish a build for ${platform} (${arch}).`},
      ]);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it.each([
      ['a tag that is not a plain version', {tag_name: '../../etc/passwd'}],
      ['a tag containing spaces', {tag_name: '2026.10.26 beta'}],
      ['a non-string tag', {tag_name: 20261026}],
      ['no tag at all', {name: 'yt-dlp 2026.10.26'}],
    ])('refuses a release that reports %s', async (_description: string, release: Record<string, unknown>): Promise<void> => {
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createOverriddenFetch(MACOS_SUMS, (url: string): Response | undefined =>
        url === LATEST_RELEASE_URL ? new Response(JSON.stringify(release)) : undefined);
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});

      const {result, progress} = await install(manager);

      expect(result).toBe(false);
      expect(lastOf(progress).message).toBe('Could not download yt-dlp: GitHub did not report a release tag');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('fails when the checksum file cannot be fetched', async (): Promise<void> => {
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createOverriddenFetch(MACOS_SUMS, (url: string): Response | undefined =>
        url === CHECKSUMS_URL ? new Response('not found', {status: 404}) : undefined);
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});

      const {result, progress} = await install(manager);

      expect(result).toBe(false);
      expect(lastOf(progress).message).toBe('Could not download yt-dlp: GitHub returned 404 for SHA2-256SUMS');
      expect(mockedCreateWriteStream).not.toHaveBeenCalled();
    });

    it('ignores a checksum entry that is not a SHA-256 digest', async (): Promise<void> => {
      const manager: DependencyManager = createManager('darwin', {fetch: createReleaseFetch('deadbeef  yt-dlp_macos.zip\n')});

      const {result, progress} = await install(manager);

      expect(result).toBe(false);
      expect(lastOf(progress).message).toContain('SHA2-256SUMS has no entry for yt-dlp_macos.zip');
    });

    it('finds the checksum among other entries and blank lines', async (): Promise<void> => {
      const sums: string = `${'1'.repeat(64)}  yt-dlp\r\n\r\n${ASSET_SHA256}  yt-dlp_macos.zip\r\n${'2'.repeat(64)}  yt-dlp.exe\r\n`;
      const manager: DependencyManager = createManager('darwin', {fetch: createReleaseFetch(sums)});

      const {result} = await install(manager);

      expect(result).toBe(true);
    });

    it('fails when the asset download is refused', async (): Promise<void> => {
      const assetUrl: string = `https://github.com/yt-dlp/yt-dlp/releases/download/${TAG}/yt-dlp_macos.zip`;
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createOverriddenFetch(MACOS_SUMS, (url: string): Response | undefined =>
        url === assetUrl ? new Response('gone', {status: 404}) : undefined);
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});

      const {result, progress} = await install(manager);

      expect(result).toBe(false);
      expect(lastOf(progress).message).toBe('Could not download yt-dlp: the download returned 404');
      expect(mockedRm).not.toHaveBeenCalledWith(TEST_YTDLP_DIR, expect.anything());
    });

    it('reports progress without a percentage when the download size is unknown', async (): Promise<void> => {
      const assetUrl: string = `https://github.com/yt-dlp/yt-dlp/releases/download/${TAG}/yt-dlp_macos.zip`;
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createOverriddenFetch(MACOS_SUMS, (url: string): Response | undefined =>
        url === assetUrl ? createChunkedResponse([ASSET_BYTES.slice(0, 5), ASSET_BYTES.slice(5)]) : undefined);
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});

      const {result, progress} = await install(manager);

      const downloading: InstallProgress[] = progress.filter((p: InstallProgress): boolean => p.message.startsWith('Downloading'));
      expect(result).toBe(true);
      expect(downloading).toEqual([
        {dependencyId: 'yt-dlp', status: 'installing', message: `Downloading yt-dlp ${TAG}...`, percent: undefined},
        {dependencyId: 'yt-dlp', status: 'installing', message: `Downloading yt-dlp ${TAG}...`, percent: undefined},
      ]);
    });

    it('reports each whole percentage once however many chunks arrive', async (): Promise<void> => {
      const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(200).fill(7);
      const chunks: Uint8Array[] = Array.from({length: bytes.length}, (_: unknown, index: number): Uint8Array => bytes.slice(index, index + 1));
      const sums: string = `${createHash('sha256').update(bytes).digest('hex')}  yt-dlp_macos.zip\n`;
      const assetUrl: string = `https://github.com/yt-dlp/yt-dlp/releases/download/${TAG}/yt-dlp_macos.zip`;
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createOverriddenFetch(sums, (url: string): Response | undefined =>
        url === assetUrl ? createChunkedResponse(chunks, bytes.length) : undefined);
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});

      const {result, progress} = await install(manager);

      const percents: (number | undefined)[] = progress
        .filter((p: InstallProgress): boolean => p.message.startsWith('Downloading'))
        .map((p: InstallProgress): number | undefined => p.percent);
      expect(result).toBe(true);
      expect(percents).toEqual(Array.from({length: 101}, (_: unknown, index: number): number => index));
    });

    it('waits for the file to drain before writing the next chunk', async (): Promise<void> => {
      let drain: (() => void) | undefined;
      mockedCreateWriteStream.mockReturnValue({
        write: vi.fn((chunk: Uint8Array): boolean => {
          written.push(chunk);
          return written.length > 1;
        }),
        once: vi.fn((event: string, listener: () => void): void => {
          if (event === 'drain') drain = listener;
        }),
        end: vi.fn((callback: () => void): void => callback()),
      });
      const assetUrl: string = `https://github.com/yt-dlp/yt-dlp/releases/download/${TAG}/yt-dlp_macos.zip`;
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createOverriddenFetch(MACOS_SUMS, (url: string): Response | undefined =>
        url === assetUrl ? createChunkedResponse([ASSET_BYTES.slice(0, 5), ASSET_BYTES.slice(5)], ASSET_BYTES.length) : undefined);
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});

      const pending: Promise<{result: boolean; progress: InstallProgress[]}> = install(manager);
      await vi.waitFor((): void => {
        expect(drain).toBeDefined();
      });
      await new Promise<void>((resolve: () => void): void => {
        setImmediate(resolve);
      });
      const writtenWhileBlocked: number = written.length;
      drain?.();
      const {result} = await pending;

      expect(writtenWhileBlocked).toBe(1);
      expect(result).toBe(true);
      expect(Buffer.concat(written)).toEqual(Buffer.from(ASSET_BYTES));
    });

    it('fails when the downloaded file cannot be closed', async (): Promise<void> => {
      mockedCreateWriteStream.mockReturnValue({
        write: vi.fn((): boolean => true),
        once: vi.fn(),
        end: vi.fn((callback: (error?: Error | null) => void): void => callback(new Error('ENOSPC: no space left on device'))),
      });
      const manager: DependencyManager = createManager('darwin', {fetch: createReleaseFetch(MACOS_SUMS)});

      const {result, progress} = await install(manager);

      expect(result).toBe(false);
      expect(lastOf(progress).message).toBe('Could not download yt-dlp: ENOSPC: no space left on device');
    });

    it('reports what the unpacker printed when the archive cannot be unpacked', async (): Promise<void> => {
      mockedExecFile.mockImplementation((_command: string, _args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void): void => {
        callback(new Error('Command failed'), '', '  ditto: not a zip archive\n');
      });
      const manager: DependencyManager = createManager('darwin', {fetch: createReleaseFetch(MACOS_SUMS)});

      const {result, progress} = await install(manager);

      expect(result).toBe(false);
      expect(lastOf(progress).message).toBe('Could not download yt-dlp: could not unpack the download: ditto: not a zip archive');
    });

    it('reports the unpacker error itself when it printed nothing', async (): Promise<void> => {
      mockedExecFile.mockImplementation((_command: string, _args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void): void => {
        callback(new Error('spawn /usr/bin/ditto ENOENT'), '', '');
      });
      const manager: DependencyManager = createManager('darwin', {fetch: createReleaseFetch(MACOS_SUMS)});

      const {result, progress} = await install(manager);

      expect(result).toBe(false);
      expect(lastOf(progress).message).toBe('Could not download yt-dlp: could not unpack the download: spawn /usr/bin/ditto ENOENT');
    });

    it('keeps the existing copy when the archive cannot be unpacked', async (): Promise<void> => {
      mockedExecFile.mockImplementation((_command: string, _args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void): void => {
        callback(new Error('Command failed'), '', 'ditto: not a zip archive');
      });
      const manager: DependencyManager = createManager('darwin', {fetch: createReleaseFetch(MACOS_SUMS)});

      await install(manager);

      expect(mockedRm).not.toHaveBeenCalledWith(TEST_YTDLP_DIR, expect.anything());
      expect(mockedRename).not.toHaveBeenCalledWith(expect.anything(), TEST_YTDLP_DIR);
    });

    it('fails when the unpacked download does not contain the executable', async (): Promise<void> => {
      mockedExistsSync.mockReturnValue(false);
      const manager: DependencyManager = createManager('darwin', {fetch: createReleaseFetch(MACOS_SUMS)});

      const {result, progress} = await install(manager);

      expect(result).toBe(false);
      expect(lastOf(progress).message).toBe('Could not download yt-dlp: the download did not contain yt-dlp_macos');
      expect(mockedRm).not.toHaveBeenCalledWith(TEST_YTDLP_DIR, expect.anything());
    });

    it('reports a failure that is not an Error object', async (): Promise<void> => {
      const fetchFn: FetchFunction = vi.fn((): Promise<Response> => Promise.reject('offline'));
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});

      const {result, progress} = await install(manager);

      expect(result).toBe(false);
      expect(lastOf(progress)).toEqual({dependencyId: 'yt-dlp', status: 'error', message: 'Could not download yt-dlp: offline'});
    });

    it('removes the staging folder after a successful install', async (): Promise<void> => {
      const manager: DependencyManager = createManager('darwin', {fetch: createReleaseFetch(MACOS_SUMS)});

      await install(manager);

      expect(mockedRm).toHaveBeenLastCalledWith(STAGING, {recursive: true, force: true});
    });

    it('removes the staging folder after a failed install', async (): Promise<void> => {
      const manager: DependencyManager = createManager('darwin', {fetch: createReleaseFetch(`${'0'.repeat(64)}  yt-dlp_macos.zip\n`)});

      await install(manager);

      expect(mockedRm).toHaveBeenLastCalledWith(STAGING, {recursive: true, force: true});
    });

    it('still succeeds when the staging folder cannot be cleaned up', async (): Promise<void> => {
      mockedReadFileSync.mockImplementation((p: string): string => {
        if (p === path.join(TEST_YTDLP_DIR, 'version.txt')) return `${TAG}\n`;
        throw new Error('ENOENT');
      });
      mockedRm.mockRejectedValue(new Error('EBUSY: resource busy or locked'));
      const manager: DependencyManager = createManager('darwin', {fetch: createReleaseFetch(MACOS_SUMS)});

      const {result} = await update(manager);

      expect(result).toBe(true);
    });

    it('refuses a second download while one is running', async (): Promise<void> => {
      let release: (response: Response) => void = (): void => undefined;
      const gate: Promise<Response> = new Promise<Response>((resolve: (response: Response) => void): void => {
        release = resolve;
      });
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createOverriddenFetch(MACOS_SUMS, (url: string): Promise<Response> | undefined =>
        url === LATEST_RELEASE_URL ? gate : undefined);
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});

      const first: Promise<{result: boolean; progress: InstallProgress[]}> = install(manager);
      const second: {result: boolean; progress: InstallProgress[]} = await update(manager);
      release(new Response(JSON.stringify({tag_name: TAG})));
      const firstOutcome: {result: boolean; progress: InstallProgress[]} = await first;

      expect(second.result).toBe(false);
      expect(second.progress).toEqual([
        {dependencyId: 'yt-dlp', status: 'error', message: 'Another yt-dlp operation is already running.'},
      ]);
      expect(firstOutcome.result).toBe(true);
    });

    it('refuses to remove yt-dlp while a download is running', async (): Promise<void> => {
      let release: (response: Response) => void = (): void => undefined;
      const gate: Promise<Response> = new Promise<Response>((resolve: (response: Response) => void): void => {
        release = resolve;
      });
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createOverriddenFetch(MACOS_SUMS, (url: string): Promise<Response> | undefined =>
        url === LATEST_RELEASE_URL ? gate : undefined);
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});

      const download: Promise<{result: boolean; progress: InstallProgress[]}> = install(manager);
      const removal: {result: boolean; progress: InstallProgress[]} = await collect(
        (onProgress: (progress: InstallProgress) => void): Promise<boolean> => manager.uninstallDependency('yt-dlp', onProgress));
      const removedWhileDownloading: boolean = mockedRm.mock.calls.some((call: unknown[]): boolean => call[0] === TEST_YTDLP_DIR);
      release(new Response(JSON.stringify({tag_name: TAG})));
      await download;

      expect(removal.result).toBe(false);
      expect(lastOf(removal.progress).message).toBe('Another yt-dlp operation is already running.');
      expect(removedWhileDownloading).toBe(false);
    });

    it('allows another download after one has failed', async (): Promise<void> => {
      let attempts: number = 0;
      const fetchFn: ReturnType<typeof vi.fn> & FetchFunction = createOverriddenFetch(MACOS_SUMS, (url: string): Response | undefined => {
        if (url !== LATEST_RELEASE_URL) return undefined;
        attempts++;
        return attempts === 1 ? new Response('rate limited', {status: 403}) : undefined;
      });
      const manager: DependencyManager = createManager('darwin', {fetch: fetchFn});
      const failed: {result: boolean; progress: InstallProgress[]} = await install(manager);

      const retried: {result: boolean; progress: InstallProgress[]} = await install(manager);

      expect(failed.result).toBe(false);
      expect(retried.result).toBe(true);
    });
  });

  // ==========================================================================
  // Bundled dependencies cannot be managed
  // ==========================================================================

  describe('bundled dependencies', (): void => {
    it.each([
      ['installDependency', 'installed'],
      ['updateDependency', 'updated'],
      ['uninstallDependency', 'removed'],
    ] as const)('refuses %s for FFmpeg', async (method: 'installDependency' | 'updateDependency' | 'uninstallDependency', verb: string): Promise<void> => {
      const manager: DependencyManager = createManager('darwin');
      const progress: InstallProgress[] = [];

      const result: boolean = await manager[method]('ffmpeg', (p: InstallProgress): void => {
        progress.push(p);
      });

      expect(result).toBe(false);
      expect(progress).toEqual([{dependencyId: 'ffmpeg', status: 'error', message: `FFmpeg is built into ONIXPlayer and is not ${verb} separately.`}]);
    });
  });

  // ==========================================================================
  // yt-dlp removal
  // ==========================================================================

  describe('yt-dlp removal', (): void => {
    it('removes the downloaded copy', async (): Promise<void> => {
      mockedExistsSync.mockImplementation((p: string): boolean => p === TEST_YTDLP_DIR);
      const manager: DependencyManager = createManager('darwin');
      const progress: InstallProgress[] = [];

      const result: boolean = await manager.uninstallDependency('yt-dlp', (p: InstallProgress): void => {
        progress.push(p);
      });

      expect(result).toBe(true);
      expect(mockedRm).toHaveBeenCalledWith(TEST_YTDLP_DIR, {recursive: true, force: true});
      expect(progress[progress.length - 1]).toMatchObject({status: 'success', message: 'yt-dlp removed.'});
    });

    it('leaves a system copy alone', async (): Promise<void> => {
      setExistingPaths(['/usr/local/bin/yt-dlp']);
      const manager: DependencyManager = createManager('darwin');
      const progress: InstallProgress[] = [];

      const result: boolean = await manager.uninstallDependency('yt-dlp', (p: InstallProgress): void => {
        progress.push(p);
      });

      expect(result).toBe(false);
      expect(mockedRm).not.toHaveBeenCalled();
      expect(progress[0].message).toContain('not downloaded by ONIXPlayer');
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

      // Simulate the binary appearing
      const ffmpegPath: string = '/opt/homebrew/bin/ffmpeg';
      mockedExistsSync.mockImplementation((p: string): boolean => p === ffmpegPath);

      manager.detectBinaries();

      expect(manager.getFfmpegPath()).toBe(ffmpegPath);
    });
  });
  // ==========================================================================
  // yt-dlp removal: progress and failures
  // ==========================================================================

  describe('yt-dlp removal progress and failures', (): void => {
    /** Runs a removal and collects its progress reports. */
    async function remove(manager: DependencyManager, id: 'yt-dlp' | 'ffmpeg' | 'fluidsynth' = 'yt-dlp'): Promise<{result: boolean; progress: InstallProgress[]}> {
      const progress: InstallProgress[] = [];
      const result: boolean = await manager.uninstallDependency(id, (p: InstallProgress): void => {
        progress.push(p);
      });
      return {result, progress};
    }

    it('reports that it is removing, then that it has removed', async (): Promise<void> => {
      mockedExistsSync.mockImplementation((p: string): boolean => p === TEST_YTDLP_DIR);
      const manager: DependencyManager = createManager('darwin');

      const {progress} = await remove(manager);

      expect(progress).toEqual([
        {dependencyId: 'yt-dlp', status: 'uninstalling', message: 'Removing yt-dlp...'},
        {dependencyId: 'yt-dlp', status: 'success', message: 'yt-dlp removed.'},
      ]);
    });

    it('no longer reports yt-dlp as installed once it is removed', async (): Promise<void> => {
      const downloaded: string = path.join(TEST_YTDLP_DIR, 'yt-dlp_macos');
      let present: boolean = true;
      mockedExistsSync.mockImplementation((p: string): boolean => present && (p === TEST_YTDLP_DIR || p === downloaded));
      mockedRm.mockImplementation(async (): Promise<void> => {
        present = false;
      });
      const manager: DependencyManager = createManager('darwin');
      const before: string | null = manager.getYtDlpPath();

      await remove(manager);

      expect(before).toBe(downloaded);
      expect(manager.getYtDlpPath()).toBeNull();
      expect(manager.getState().ytdlp.installed).toBe(false);
    });

    it('reports why the downloaded copy could not be removed', async (): Promise<void> => {
      mockedExistsSync.mockImplementation((p: string): boolean => p === TEST_YTDLP_DIR);
      mockedRm.mockRejectedValue(new Error('EBUSY: resource busy or locked'));
      const manager: DependencyManager = createManager('win32', {arch: 'x64'});

      const {result, progress} = await remove(manager);

      expect(result).toBe(false);
      expect(progress[progress.length - 1]).toEqual({
        dependencyId: 'yt-dlp',
        status: 'error',
        message: 'Could not remove yt-dlp: EBUSY: resource busy or locked',
      });
    });

    it('reports a removal failure that is not an Error object', async (): Promise<void> => {
      mockedExistsSync.mockImplementation((p: string): boolean => p === TEST_YTDLP_DIR);
      mockedRm.mockRejectedValue('locked');
      const manager: DependencyManager = createManager('darwin');

      const {progress} = await remove(manager);

      expect(progress[progress.length - 1].message).toBe('Could not remove yt-dlp: locked');
    });

    it('allows removal to be retried after it has failed', async (): Promise<void> => {
      mockedExistsSync.mockImplementation((p: string): boolean => p === TEST_YTDLP_DIR);
      mockedRm.mockRejectedValueOnce(new Error('EBUSY'));
      const manager: DependencyManager = createManager('darwin');
      const failed: {result: boolean; progress: InstallProgress[]} = await remove(manager);

      const retried: {result: boolean; progress: InstallProgress[]} = await remove(manager);

      expect(failed.result).toBe(false);
      expect(retried.result).toBe(true);
    });

    it('refuses to remove FluidSynth, which is built in', async (): Promise<void> => {
      const manager: DependencyManager = createManager('darwin');

      const {result, progress} = await remove(manager, 'fluidsynth');

      expect(result).toBe(false);
      expect(progress).toEqual([
        {dependencyId: 'fluidsynth', status: 'error', message: 'FluidSynth is built into ONIXPlayer and is not removed separately.'},
      ]);
      expect(mockedRm).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Hardware encoder detection
  // ==========================================================================

  describe('hardware encoder detection', (): void => {
    /** The parts of a child process the detection uses. */
    interface FakeChild extends EventEmitter {
      stdout: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    }

    const SYSTEM_FFMPEG: string = '/usr/local/bin/ffmpeg';
    const PROBE_TIMEOUT_MS: number = 10000;
    const ENCODER_LIST_HEADER: string = 'Encoders:\n V..... = Video\n A..... = Audio\n ------\n';

    let child: FakeChild;

    /** Creates a child process whose output and exit the test controls. */
    function createFakeChild(): FakeChild {
      const fake: FakeChild = new EventEmitter() as FakeChild;
      fake.stdout = new EventEmitter();
      fake.kill = vi.fn();
      return fake;
    }

    /** Formats one line of `ffmpeg -encoders` output. */
    function encoderLine(name: string): string {
      return ` V....D ${name.padEnd(20)} ${name} encoder (codec h264)\n`;
    }

    /** Makes the probe print the given text and exit with the given code. */
    function finishProbe(output: string, code: number | null = 0): void {
      child.stdout.emit('data', Buffer.from(output));
      child.emit('close', code);
    }

    beforeEach((): void => {
      child = createFakeChild();
      mockedSpawn.mockReturnValue(child);
      setExistingPaths([SYSTEM_FFMPEG]);
    });

    afterEach((): void => {
      vi.useRealTimers();
    });

    it('asks FFmpeg for its encoders without a shell', (): void => {
      createManager('darwin');

      expect(mockedSpawn).toHaveBeenCalledTimes(1);
      expect(mockedSpawn).toHaveBeenCalledWith(SYSTEM_FFMPEG, ['-encoders'], {stdio: ['ignore', 'pipe', 'ignore']});
    });

    it('reports no hardware encoders until the probe has finished', (): void => {
      const manager: DependencyManager = createManager('darwin');

      expect(manager.getHardwareEncoders()).toEqual({available: false, encoders: []});
    });

    it('reports the hardware encoders FFmpeg lists', (): void => {
      const manager: DependencyManager = createManager('darwin');

      finishProbe(ENCODER_LIST_HEADER + encoderLine('libx264') + encoderLine('h264_videotoolbox'));

      expect(manager.getHardwareEncoders()).toEqual({available: true, encoders: ['h264_videotoolbox']});
    });

    it('lists several hardware encoders in preference order whatever order FFmpeg prints them in', (): void => {
      const manager: DependencyManager = createManager('linux');

      finishProbe(ENCODER_LIST_HEADER + encoderLine('h264_vaapi') + encoderLine('h264_amf') + encoderLine('h264_qsv') + encoderLine('h264_nvenc'));

      expect(manager.getHardwareEncoders().encoders).toEqual(['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi']);
    });

    it('recognises an encoder whose name is split across output chunks', (): void => {
      const manager: DependencyManager = createManager('linux');

      child.stdout.emit('data', Buffer.from(`${ENCODER_LIST_HEADER} V....D h264_nv`));
      child.stdout.emit('data', Buffer.from('enc           NVIDIA NVENC H.264 encoder\n'));
      child.emit('close', 0);

      expect(manager.getHardwareEncoders()).toEqual({available: true, encoders: ['h264_nvenc']});
    });

    it('reports none when FFmpeg has only software and non-H.264 hardware encoders', (): void => {
      const manager: DependencyManager = createManager('darwin');

      finishProbe(ENCODER_LIST_HEADER + encoderLine('libx264') + encoderLine('hevc_videotoolbox') + encoderLine('hevc_nvenc'));

      expect(manager.getHardwareEncoders()).toEqual({available: false, encoders: []});
    });

    it('reports none when FFmpeg exits with an error, even if it printed encoders', (): void => {
      const manager: DependencyManager = createManager('darwin');

      finishProbe(encoderLine('h264_videotoolbox'), 1);

      expect(manager.getHardwareEncoders()).toEqual({available: false, encoders: []});
    });

    it('reports none when FFmpeg is killed by a signal', (): void => {
      const manager: DependencyManager = createManager('darwin');

      finishProbe(encoderLine('h264_videotoolbox'), null);

      expect(manager.getHardwareEncoders()).toEqual({available: false, encoders: []});
    });

    it('reports none when FFmpeg cannot be started', (): void => {
      const manager: DependencyManager = createManager('darwin');

      child.emit('error', new Error('spawn EACCES'));

      expect(manager.getHardwareEncoders()).toEqual({available: false, encoders: []});
    });

    it('keeps the first outcome when the process reports an error and then closes', (): void => {
      const manager: DependencyManager = createManager('darwin');

      child.emit('error', new Error('spawn EACCES'));
      finishProbe(encoderLine('h264_videotoolbox'));

      expect(manager.getHardwareEncoders()).toEqual({available: false, encoders: []});
    });

    it('does not throw when the probe cannot be spawned at all', (): void => {
      mockedSpawn.mockImplementation((): never => {
        throw new Error('spawn EMFILE');
      });

      const manager: DependencyManager = createManager('darwin');

      expect(manager.getFfmpegPath()).toBe(SYSTEM_FFMPEG);
      expect(manager.getHardwareEncoders()).toEqual({available: false, encoders: []});
    });

    it('kills a probe that has not finished within ten seconds', (): void => {
      vi.useFakeTimers();
      createManager('darwin');

      vi.advanceTimersByTime(PROBE_TIMEOUT_MS - 1);
      const killedEarly: number = child.kill.mock.calls.length;
      vi.advanceTimersByTime(1);

      expect(killedEarly).toBe(0);
      expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it('ignores output from a probe that finishes after it timed out', (): void => {
      vi.useFakeTimers();
      const manager: DependencyManager = createManager('darwin');
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);

      finishProbe(encoderLine('h264_videotoolbox'));

      expect(manager.getHardwareEncoders()).toEqual({available: false, encoders: []});
    });

    it('does not kill a probe that finished in time', (): void => {
      vi.useFakeTimers();
      createManager('darwin');
      finishProbe(encoderLine('h264_videotoolbox'));

      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);

      expect(child.kill).not.toHaveBeenCalled();
    });

    it('does not probe when there is no FFmpeg', (): void => {
      setExistingPaths([]);

      const manager: DependencyManager = createManager('darwin');

      expect(mockedSpawn).not.toHaveBeenCalled();
      expect(manager.getHardwareEncoders()).toEqual({available: false, encoders: []});
    });

    it('probes the bundled FFmpeg when there is one', (): void => {
      const bundledFfmpeg: string = path.join(TEST_BUNDLED_BIN_DIR, 'ffmpeg');
      setExistingPaths([bundledFfmpeg, SYSTEM_FFMPEG]);

      createManager('darwin', {bundledBinDir: TEST_BUNDLED_BIN_DIR});

      expect(mockedSpawn).toHaveBeenCalledWith(bundledFfmpeg, ['-encoders'], expect.any(Object));
    });

    it('includes the detected encoders in the dependency state', (): void => {
      const manager: DependencyManager = createManager('darwin');

      finishProbe(encoderLine('h264_videotoolbox'));

      expect(manager.getState().hardwareEncoders).toEqual({available: true, encoders: ['h264_videotoolbox']});
    });

    it('probes again when binaries are re-scanned', (): void => {
      const manager: DependencyManager = createManager('darwin');
      finishProbe(encoderLine('h264_videotoolbox'));
      child = createFakeChild();
      mockedSpawn.mockReturnValue(child);

      manager.detectBinaries();
      finishProbe(encoderLine('h264_nvenc'));

      expect(manager.getHardwareEncoders()).toEqual({available: true, encoders: ['h264_nvenc']});
    });

    it('forgets the detected encoders when FFmpeg disappears', (): void => {
      const manager: DependencyManager = createManager('darwin');
      finishProbe(encoderLine('h264_videotoolbox'));
      setExistingPaths([]);

      manager.detectBinaries();

      expect(manager.getHardwareEncoders()).toEqual({available: false, encoders: []});
    });
  });

  // ==========================================================================
  // Binary discovery order
  // ==========================================================================

  describe('binary discovery order', (): void => {
    const PROGRAM_FILES: string = 'D:\\Apps';
    const LOCAL_APP_DATA: string = 'D:\\Users\\me\\AppData\\Local';

    afterEach((): void => {
      vi.unstubAllEnvs();
    });

    it('prefers /usr/bin over /usr/local/bin and snap on Linux', (): void => {
      setExistingPaths(['/snap/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']);

      const manager: DependencyManager = createManager('linux');

      expect(manager.getFfmpegPath()).toBe('/usr/bin/ffmpeg');
    });

    it('prefers /usr/local/bin over snap on Linux', (): void => {
      setExistingPaths(['/snap/bin/ffprobe', '/usr/local/bin/ffprobe']);

      const manager: DependencyManager = createManager('linux');

      expect(manager.getFfprobePath()).toBe('/usr/local/bin/ffprobe');
    });

    it('resolves each binary independently, mixing bundled and system copies', (): void => {
      const bundledFfmpeg: string = path.join(TEST_BUNDLED_BIN_DIR, 'ffmpeg');
      const bundledFluidsynth: string = path.join(TEST_BUNDLED_BIN_DIR, 'fluidsynth');
      setExistingPaths([bundledFfmpeg, bundledFluidsynth, '/opt/homebrew/bin/ffprobe', '/opt/homebrew/bin/fluidsynth']);

      const manager: DependencyManager = createManager('darwin', {bundledBinDir: TEST_BUNDLED_BIN_DIR});

      expect(manager.getFfmpegPath()).toBe(bundledFfmpeg);
      expect(manager.getFfprobePath()).toBe('/opt/homebrew/bin/ffprobe');
      expect(manager.getFluidsynthPath()).toBe(bundledFluidsynth);
    });

    it('does not look for a Windows .exe in the bundle on macOS', (): void => {
      setExistingPaths([path.join(TEST_BUNDLED_BIN_DIR, 'ffmpeg.exe')]);

      const manager: DependencyManager = createManager('darwin', {bundledBinDir: TEST_BUNDLED_BIN_DIR});

      expect(manager.getFfmpegPath()).toBeNull();
    });

    it('never treats yt-dlp as bundled, even if the bundle folder has one', (): void => {
      setExistingPaths([path.join(TEST_BUNDLED_BIN_DIR, 'yt-dlp')]);

      const manager: DependencyManager = createManager('darwin', {bundledBinDir: TEST_BUNDLED_BIN_DIR});

      expect(manager.getYtDlpPath()).toBeNull();
    });

    it('prefers the yt-dlp it downloaded over a system copy', (): void => {
      const downloaded: string = path.join(TEST_YTDLP_DIR, 'yt-dlp_macos');
      setExistingPaths([downloaded, '/opt/homebrew/bin/yt-dlp']);

      const manager: DependencyManager = createManager('darwin');

      expect(manager.getYtDlpPath()).toBe(downloaded);
    });

    it('falls back to a system yt-dlp and reports it as such, without a version', (): void => {
      setExistingPaths(['/opt/homebrew/bin/yt-dlp']);
      mockedReadFileSync.mockImplementation((p: string): string => {
        if (p === path.join(TEST_YTDLP_DIR, 'version.txt')) return '2020.01.01\n';
        throw new Error('ENOENT');
      });

      const manager: DependencyManager = createManager('darwin');

      expect(manager.getYtDlpPath()).toBe('/opt/homebrew/bin/yt-dlp');
      expect(manager.getState().ytdlp).toMatchObject({installed: true, source: 'system', version: null, managed: true});
    });

    it.each([
      ['win32', 'x64', 'yt-dlp.exe'],
      ['linux', 'x64', 'yt-dlp'],
      ['darwin', 'arm64', 'yt-dlp_macos'],
    ] as const)('looks for its own download on %s (%s) as %s', (platform: NodeJS.Platform, arch: string, executable: string): void => {
      const downloaded: string = path.join(TEST_YTDLP_DIR, executable);
      setExistingPaths([downloaded]);

      const manager: DependencyManager = createManager(platform, {arch});

      expect(manager.getYtDlpPath()).toBe(downloaded);
    });

    it('reports no yt-dlp when neither a download nor a system copy exists', (): void => {
      const manager: DependencyManager = createManager('linux', {arch: 'x64'});

      expect(manager.getYtDlpPath()).toBeNull();
      expect(manager.getState().ytdlp).toMatchObject({installed: false, path: null, source: null, version: null});
    });

    it('reports no version for a download whose version file is empty', (): void => {
      setExistingPaths([path.join(TEST_YTDLP_DIR, 'yt-dlp_macos')]);
      mockedReadFileSync.mockImplementation((p: string): string => {
        if (p === path.join(TEST_YTDLP_DIR, 'version.txt')) return '  \n';
        throw new Error('ENOENT');
      });

      const manager: DependencyManager = createManager('darwin');

      expect(manager.getState().ytdlp).toMatchObject({source: 'downloaded', version: null});
    });

    it('reports no version for a bundled binary that versions.json does not mention', (): void => {
      setExistingPaths([path.join(TEST_BUNDLED_BIN_DIR, 'ffmpeg'), path.join(TEST_BUNDLED_BIN_DIR, 'fluidsynth')]);
      mockedReadFileSync.mockImplementation((p: string): string => {
        if (p === path.join(TEST_BUNDLED_BIN_DIR, 'versions.json')) return JSON.stringify({ffmpeg: '9.0.2'});
        throw new Error('ENOENT');
      });

      const manager: DependencyManager = createManager('darwin', {bundledBinDir: TEST_BUNDLED_BIN_DIR});

      expect(manager.getState().fluidsynth).toMatchObject({source: 'bundled', version: null});
    });

    it.each([
      ['null', 'null'],
      ['a number', '9'],
      ['not JSON', '<html>'],
    ])('reports no bundled versions when versions.json holds %s', (_description: string, contents: string): void => {
      setExistingPaths([path.join(TEST_BUNDLED_BIN_DIR, 'ffmpeg')]);
      mockedReadFileSync.mockImplementation((p: string): string => {
        if (p === path.join(TEST_BUNDLED_BIN_DIR, 'versions.json')) return contents;
        throw new Error('ENOENT');
      });

      const manager: DependencyManager = createManager('darwin', {bundledBinDir: TEST_BUNDLED_BIN_DIR});

      expect(manager.getState().ffmpeg).toMatchObject({source: 'bundled', version: null});
    });

    it('does not report a version for a system binary even when versions.json names one', (): void => {
      setExistingPaths(['/usr/local/bin/ffmpeg']);
      mockedReadFileSync.mockImplementation((p: string): string => {
        if (p === path.join(TEST_BUNDLED_BIN_DIR, 'versions.json')) return JSON.stringify({ffmpeg: '9.0.2'});
        throw new Error('ENOENT');
      });

      const manager: DependencyManager = createManager('darwin', {bundledBinDir: TEST_BUNDLED_BIN_DIR});

      expect(manager.getState().ffmpeg).toMatchObject({source: 'system', version: null});
    });

    it('searches the FFmpeg folder under %ProgramFiles% on Windows', (): void => {
      vi.stubEnv('ProgramFiles', PROGRAM_FILES);
      vi.stubEnv('LOCALAPPDATA', LOCAL_APP_DATA);
      const installed: string = path.join(PROGRAM_FILES, 'FFmpeg', 'bin', 'ffprobe.exe');
      setExistingPaths([installed]);

      const manager: DependencyManager = createManager('win32');

      expect(manager.getFfprobePath()).toBe(installed);
    });

    it('searches the WinGet links folder under %LOCALAPPDATA% on Windows', (): void => {
      vi.stubEnv('ProgramFiles', PROGRAM_FILES);
      vi.stubEnv('LOCALAPPDATA', LOCAL_APP_DATA);
      const linked: string = path.join(LOCAL_APP_DATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
      setExistingPaths([linked]);

      const manager: DependencyManager = createManager('win32');

      expect(manager.getFfmpegPath()).toBe(linked);
    });

    it('searches the FluidSynth folder under %ProgramFiles% on Windows', (): void => {
      vi.stubEnv('ProgramFiles', PROGRAM_FILES);
      vi.stubEnv('LOCALAPPDATA', LOCAL_APP_DATA);
      const installed: string = path.join(PROGRAM_FILES, 'FluidSynth', 'bin', 'fluidsynth.exe');
      setExistingPaths([installed]);

      const manager: DependencyManager = createManager('win32');

      expect(manager.getFluidsynthPath()).toBe(installed);
    });

    it('prefers the Program Files copy over the WinGet link on Windows', (): void => {
      vi.stubEnv('ProgramFiles', PROGRAM_FILES);
      vi.stubEnv('LOCALAPPDATA', LOCAL_APP_DATA);
      const installed: string = path.join(PROGRAM_FILES, 'FFmpeg', 'bin', 'ffmpeg.exe');
      const linked: string = path.join(LOCAL_APP_DATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
      setExistingPaths([linked, installed]);

      const manager: DependencyManager = createManager('win32');

      expect(manager.getFfmpegPath()).toBe(installed);
    });

    it('assumes C:\\Program Files when %ProgramFiles% is not set', (): void => {
      vi.stubEnv('ProgramFiles', undefined);
      vi.stubEnv('LOCALAPPDATA', undefined);
      const installed: string = path.join('C:\\Program Files', 'FFmpeg', 'bin', 'ffmpeg.exe');
      setExistingPaths([installed]);

      const manager: DependencyManager = createManager('win32');

      expect(manager.getFfmpegPath()).toBe(installed);
    });

    it('asks `where` on Windows only for binaries missing from the known folders', (): void => {
      vi.stubEnv('ProgramFiles', PROGRAM_FILES);
      vi.stubEnv('LOCALAPPDATA', LOCAL_APP_DATA);
      setExistingPaths([path.join(PROGRAM_FILES, 'FFmpeg', 'bin', 'ffmpeg.exe')]);

      createManager('win32');

      const asked: unknown[] = mockedExecFileSync.mock.calls
        .filter((call: unknown[]): boolean => call[0] === 'where')
        .map((call: unknown[]): unknown => (call[1] as string[])[0]);
      expect(asked).toEqual(['ffprobe', 'fluidsynth', 'yt-dlp']);
    });

    it('uses the first existing path `where` prints on Windows', (): void => {
      const onPath: string = 'E:\\Tools\\ffmpeg\\ffmpeg.exe';
      setExistingPaths([onPath, 'F:\\Other\\ffmpeg.exe']);
      mockedExecFileSync.mockImplementation((command: string, args: string[]): string => {
        if (command === 'where' && args[0] === 'ffmpeg') return `${onPath}\r\nF:\\Other\\ffmpeg.exe\r\n`;
        throw new Error('not found');
      });

      const manager: DependencyManager = createManager('win32');

      expect(manager.getFfmpegPath()).toBe(onPath);
      expect(manager.getState().ffmpeg.source).toBe('system');
    });

    it('finds nothing when `where` prints nothing on Windows', (): void => {
      mockedExecFileSync.mockReturnValue('\r\n');

      const manager: DependencyManager = createManager('win32');

      expect(manager.getFfmpegPath()).toBeNull();
    });

    it('does not run `where` on macOS or Linux', (): void => {
      createManager('darwin');
      createManager('linux');

      expect(mockedExecFileSync).not.toHaveBeenCalledWith('where', expect.anything(), expect.anything());
    });

    it('reports no tracker support when the system FFmpeg cannot be run', (): void => {
      setExistingPaths(['/usr/bin/ffmpeg']);
      mockedExecFileSync.mockImplementation((): never => {
        throw new Error('spawnSync /usr/bin/ffmpeg ETIMEDOUT');
      });

      const manager: DependencyManager = createManager('linux');

      expect(manager.getFfmpegPath()).toBe('/usr/bin/ffmpeg');
      expect(manager.hasTrackerSupport()).toBe(false);
    });

    it('re-checks tracker support when binaries are re-scanned', (): void => {
      setExistingPaths(['/usr/bin/ffmpeg']);
      mockedExecFileSync.mockReturnValue(' D  mov,mp4,m4a      QuickTime / MOV\n');
      const manager: DependencyManager = createManager('linux');
      const before: boolean = manager.hasTrackerSupport();
      mockedExecFileSync.mockReturnValue(' D  libopenmpt      Tracker formats (libopenmpt)\n');

      manager.detectBinaries();

      expect(before).toBe(false);
      expect(manager.hasTrackerSupport()).toBe(true);
    });
  });

  // ==========================================================================
  // SoundFont selection and error paths
  // ==========================================================================

  describe('SoundFont selection', (): void => {
    beforeEach((): void => {
      mockedReaddirSync.mockReturnValue(['Alpha.sf2', 'Beta.sf2', 'Gamma.sf2']);
      mockedStatSync.mockReturnValue({ isFile: (): boolean => true, size: 1000 });
    });

    it('uses the preferred SoundFont when it is installed', (): void => {
      const manager: DependencyManager = createManager('darwin');

      expect(manager.findSoundFont('Beta.sf2')).toBe(path.join(TEST_SOUNDFONT_DIR, 'Beta.sf2'));
    });

    it('falls back to the first installed SoundFont when the preferred one is missing', (): void => {
      const manager: DependencyManager = createManager('darwin');

      expect(manager.findSoundFont('Deleted.sf2')).toBe(path.join(TEST_SOUNDFONT_DIR, 'Alpha.sf2'));
    });

    it('matches the preferred SoundFont by exact file name', (): void => {
      const manager: DependencyManager = createManager('darwin');

      expect(manager.findSoundFont('beta.sf2')).toBe(path.join(TEST_SOUNDFONT_DIR, 'Alpha.sf2'));
    });

    it.each([[null], [undefined], ['']])('uses the first installed SoundFont when the preference is %s', (preferred: string | null | undefined): void => {
      const manager: DependencyManager = createManager('darwin');

      expect(manager.findSoundFont(preferred)).toBe(path.join(TEST_SOUNDFONT_DIR, 'Alpha.sf2'));
    });

    it('finds nothing when the preferred SoundFont is missing and none are installed', (): void => {
      mockedReaddirSync.mockReturnValue([]);
      const manager: DependencyManager = createManager('darwin');

      expect(manager.findSoundFont('Beta.sf2')).toBeUndefined();
    });

    it('reports the preferred SoundFont as active in the dependency state', (): void => {
      const manager: DependencyManager = createManager('darwin');

      const state: DependencyState = manager.getState('Gamma.sf2');

      expect(state.activeSoundFont).toBe(path.join(TEST_SOUNDFONT_DIR, 'Gamma.sf2'));
      expect(state.soundfonts.map((sf: SoundFontInfo): string => sf.fileName)).toEqual(['Alpha.sf2', 'Beta.sf2', 'Gamma.sf2']);
    });

    it('reports the fallback SoundFont as active when the preferred one is missing', (): void => {
      const manager: DependencyManager = createManager('darwin');

      expect(manager.getState('Deleted.sf2').activeSoundFont).toBe(path.join(TEST_SOUNDFONT_DIR, 'Alpha.sf2'));
    });

    it('still supports MIDI when the preferred SoundFont is missing but another is installed', (): void => {
      setExistingPaths(['/usr/local/bin/fluidsynth']);
      const manager: DependencyManager = createManager('darwin');

      expect(manager.hasMidiSupport('Deleted.sf2')).toBe(true);
      expect(manager.getState('Deleted.sf2').midiSupport).toBe(true);
    });

    it('does not list a directory whose name ends in .sf2', (): void => {
      mockedStatSync.mockImplementation((filePath: string): { isFile: () => boolean; size: number } => ({
        isFile: (): boolean => filePath !== path.join(TEST_SOUNDFONT_DIR, 'Beta.sf2'),
        size: 1000,
      }));
      const manager: DependencyManager = createManager('darwin');

      const names: string[] = manager.getSoundFonts().map((sf: SoundFontInfo): string => sf.fileName);

      expect(names).toEqual(['Alpha.sf2', 'Gamma.sf2']);
    });

    it('does not select a directory as the preferred SoundFont', (): void => {
      mockedStatSync.mockImplementation((filePath: string): { isFile: () => boolean; size: number } => ({
        isFile: (): boolean => filePath !== path.join(TEST_SOUNDFONT_DIR, 'Beta.sf2'),
        size: 1000,
      }));
      const manager: DependencyManager = createManager('darwin');

      expect(manager.findSoundFont('Beta.sf2')).toBe(path.join(TEST_SOUNDFONT_DIR, 'Alpha.sf2'));
    });
  });

  describe('SoundFont install and removal errors', (): void => {
    it('installs under the source file name, whatever folder it came from', (): void => {
      const sourcePath: string = path.join(path.sep, 'Volumes', 'USB', 'Sound Fonts', 'My Piano.sf2');
      setExistingPaths([sourcePath]);
      mockedStatSync.mockReturnValue({ isFile: (): boolean => true, size: 42 });
      const manager: DependencyManager = createManager('darwin');

      const result: SoundFontInfo = manager.installSoundFont(sourcePath);

      expect(result).toEqual({fileName: 'My Piano.sf2', filePath: path.join(TEST_SOUNDFONT_DIR, 'My Piano.sf2'), sizeBytes: 42});
    });

    it('does not copy anything when the source is missing', (): void => {
      const manager: DependencyManager = createManager('darwin');

      expect((): SoundFontInfo => manager.installSoundFont(path.join(path.sep, 'missing', 'font.sf2'))).toThrow('Source file not found');
      expect(mockedCopyFileSync).not.toHaveBeenCalled();
    });

    it('throws when the copy fails', (): void => {
      const sourcePath: string = path.join(path.sep, 'Downloads', 'Big.sf2');
      setExistingPaths([sourcePath]);
      mockedCopyFileSync.mockImplementation((): never => {
        throw new Error('ENOSPC: no space left on device');
      });
      const manager: DependencyManager = createManager('darwin');

      expect((): SoundFontInfo => manager.installSoundFont(sourcePath)).toThrow('ENOSPC: no space left on device');
    });

    it('rejects a removal name containing ".." even without a separator', (): void => {
      setExistingPaths([path.join(TEST_SOUNDFONT_DIR, 'a..sf2')]);
      const manager: DependencyManager = createManager('darwin');

      const result: boolean = manager.removeSoundFont('a..sf2');

      expect(result).toBe(false);
      expect(mockedUnlinkSync).not.toHaveBeenCalled();
    });

    it('only removes files inside the soundfonts folder', (): void => {
      const target: string = path.join(TEST_SOUNDFONT_DIR, 'Old.sf2');
      setExistingPaths([target]);
      const manager: DependencyManager = createManager('darwin');

      manager.removeSoundFont('Old.sf2');

      expect(mockedUnlinkSync).toHaveBeenCalledTimes(1);
      expect(mockedUnlinkSync).toHaveBeenCalledWith(target);
    });
  });
});

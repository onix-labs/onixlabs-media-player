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
import { execFileSync, execFile } from 'child_process';
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
    const ASSET_BYTES: Uint8Array = new TextEncoder().encode('pretend this is yt-dlp');
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
});

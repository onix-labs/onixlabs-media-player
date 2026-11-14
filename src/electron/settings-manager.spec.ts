/**
 * @fileoverview Comprehensive tests for SettingsManager.
 *
 * Tests cover:
 * - Constructor / load behavior (missing file, corrupt file, valid file)
 * - All public update methods and their validators
 * - Save/load persistence cycle
 * - validateAndMerge partial settings merge with defaults
 * - v1 to v2 migration (perVisualizationSensitivity -> perVisualizationSettings)
 * - Subtitle, equalizer and video adjustment settings (update and load)
 * - Recent files and playlists (ordering, de-duplication, caps, removal)
 * - Debounced saving, flush, and failed or interrupted writes
 * - Platform-specific defaults
 *
 * @module electron/settings-manager.spec
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockUserDataPath: string = path.join(os.tmpdir(), `onixplayer-test-${Date.now()}`);

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name === 'userData') return mockUserDataPath;
      return os.tmpdir();
    },
  },
}));

vi.mock('./logger.js', () => ({
  settingsLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { SettingsManager } from './settings-manager.js';
import { settingsLogger } from './logger.js';
import type {
  AppSettings,
  WindowBounds,
  VisualizationSettingsUpdate,
  ApplicationSettingsUpdate,
  PlaybackSettingsUpdate,
  TranscodingSettingsUpdate,
  AppearanceSettingsUpdate,
  SubtitleSettingsUpdate,
  EqualizerSettingsUpdate,
  VideoAdjustmentsSettingsUpdate,
  PerVisualizationSettings,
  RecentItem,
  RecentItemsSettings,
  RenderResolution,
  CrossfadeDuration,
  CrossfadeStyle,
  HardwareAcceleration,
  PreferredAudioLanguage,
  PreferredSubtitleLanguage,
  ColorScheme,
  SeekMode,
  SubtitleFontFamily,
} from './settings-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates the temp userData directory for a test run. */
function createTempDir(): void {
  fs.mkdirSync(mockUserDataPath, { recursive: true });
}

/** Removes the temp userData directory after a test run. */
function removeTempDir(): void {
  fs.rmSync(mockUserDataPath, { recursive: true, force: true });
}

/** Returns the settings file path inside the current temp dir. */
function settingsFilePath(): string {
  return path.join(mockUserDataPath, 'settings.json');
}

/** Writes arbitrary JSON to the settings file. */
function writeSettingsFile(data: unknown): void {
  fs.writeFileSync(settingsFilePath(), JSON.stringify(data, null, 2), 'utf-8');
}

/** Reads and parses the settings file from disk. */
function readSettingsFile(): AppSettings {
  const raw: string = fs.readFileSync(settingsFilePath(), 'utf-8');
  return JSON.parse(raw) as AppSettings;
}

/** Returns the path of the temporary file a save writes before renaming it. */
function tempSettingsFilePath(): string {
  return `${settingsFilePath()}.tmp`;
}

/** The descriptor of process.platform before any test replaced it. */
const ORIGINAL_PLATFORM_DESCRIPTOR: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(process, 'platform');

/** Makes process.platform report the given platform until restorePlatform is called. */
function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: platform });
}

/** Puts the real process.platform back. */
function restorePlatform(): void {
  if (ORIGINAL_PLATFORM_DESCRIPTOR) {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
  }
}

/** Builds a stored recent item the way a settings file holds it. */
function storedRecentItem(itemPath: string, type: 'file' | 'playlist' = 'file'): RecentItem {
  return { path: itemPath, displayName: path.basename(itemPath), timestamp: '2026-01-01T00:00:00.000Z', type };
}

/** Lists the paths of recent items, in order. */
function pathsOf(items: readonly RecentItem[]): string[] {
  return items.map((item: RecentItem): string => item.path);
}

const mockedLoggerError: ReturnType<typeof vi.fn> = vi.mocked(settingsLogger.error);

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('SettingsManager', () => {
  beforeEach(() => {
    // Each test gets its own unique temp directory so tests never collide.
    mockUserDataPath = path.join(os.tmpdir(), `onixplayer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    createTempDir();
  });

  afterEach(() => {
    removeTempDir();
  });

  // ========================================================================
  // 1. Constructor / load behavior
  // ========================================================================

  describe('constructor / load', () => {
    it('should return default settings when no settings file exists', () => {
      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.version).toBe(2);
      expect(settings.visualization.defaultType).toBe('water');
      expect(settings.visualization.maxFrameRate).toBe(60);
      expect(settings.visualization.fftSize).toBe(2048);
      expect(settings.application.serverPort).toBe(0);
      expect(settings.application.controlsAutoHideDelay).toBe(5);
      expect(settings.playback.defaultVolume).toBe(0.5);
      expect(settings.playback.crossfadeDuration).toBe(100);
      expect(settings.playback.previousTrackThreshold).toBe(3);
      expect(settings.playback.skipDuration).toBe(10);
      expect(settings.playback.videoAspectMode).toBe('default');
      expect(settings.transcoding.videoQuality).toBe('medium');
      expect(settings.transcoding.audioBitrate).toBe(192);
      expect(settings.appearance.glassEnabled).toBe(process.platform !== 'win32');
      expect(settings.appearance.macOSVisualEffectState).toBe('active');
      expect(settings.appearance.backgroundColor).toBe('#1e1e1e');
      expect(settings.windowState.miniplayerBounds).toBeNull();
    });

    it('should return default settings when the file contains corrupt JSON', () => {
      fs.writeFileSync(settingsFilePath(), '{{{not valid json!!!', 'utf-8');

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.visualization.defaultType).toBe('water');
      expect(settings.playback.defaultVolume).toBe(0.5);
    });

    it('should return default settings when the file contains a non-object value', () => {
      fs.writeFileSync(settingsFilePath(), '"just a string"', 'utf-8');

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.visualization.defaultType).toBe('water');
    });

    it('should load valid settings from an existing file', () => {
      const customSettings: Record<string, unknown> = {
        version: 2,
        visualization: {
          defaultType: 'waveform',
          maxFrameRate: 60,
          fftSize: 1024,
          perVisualizationSettings: {},
        },
        application: { serverPort: 3000, controlsAutoHideDelay: 10 },
        playback: {
          defaultVolume: 0.8,
          crossfadeDuration: 200,
          previousTrackThreshold: 5,
          skipDuration: 30,
          videoAspectMode: '16:9',
        },
        transcoding: { videoQuality: 'high', audioBitrate: 320 },
        appearance: {
          glassEnabled: false,
          macOSVisualEffectState: 'inactive',
          backgroundColor: '#222222',
        },
        windowState: { miniplayerBounds: null },
      };
      writeSettingsFile(customSettings);

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.visualization.defaultType).toBe('waveform');
      expect(settings.visualization.maxFrameRate).toBe(60);
      expect(settings.visualization.fftSize).toBe(1024);
      expect(settings.application.serverPort).toBe(3000);
      expect(settings.application.controlsAutoHideDelay).toBe(10);
      expect(settings.playback.defaultVolume).toBe(0.8);
      expect(settings.playback.crossfadeDuration).toBe(200);
      expect(settings.playback.previousTrackThreshold).toBe(5);
      expect(settings.playback.skipDuration).toBe(30);
      expect(settings.playback.videoAspectMode).toBe('16:9');
      expect(settings.transcoding.videoQuality).toBe('high');
      expect(settings.transcoding.audioBitrate).toBe(320);
      expect(settings.appearance.glassEnabled).toBe(false);
      expect(settings.appearance.macOSVisualEffectState).toBe('inactive');
      expect(settings.appearance.backgroundColor).toBe('#222222');
    });

    it('should use defaults for missing top-level sections', () => {
      writeSettingsFile({ version: 2 });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.visualization.defaultType).toBe('water');
      expect(settings.application.serverPort).toBe(0);
      expect(settings.playback.defaultVolume).toBe(0.5);
      expect(settings.transcoding.videoQuality).toBe('medium');
      expect(settings.appearance.glassEnabled).toBe(process.platform !== 'win32');
      expect(settings.windowState.miniplayerBounds).toBeNull();
    });

    it('should use defaults for invalid field values inside sections', () => {
      writeSettingsFile({
        version: 2,
        visualization: { defaultType: 'nonexistent', maxFrameRate: 999, fftSize: 300 },
        application: { serverPort: -5, controlsAutoHideDelay: 100 },
        playback: { defaultVolume: 5.0, crossfadeDuration: 9999, previousTrackThreshold: 99, skipDuration: 0, videoAspectMode: 'stretch' },
        transcoding: { videoQuality: 'ultra', audioBitrate: 64 },
        appearance: { glassEnabled: 'yes', macOSVisualEffectState: 'turbo', backgroundColor: 'red' },
      });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.visualization.defaultType).toBe('water');
      expect(settings.visualization.maxFrameRate).toBe(60);
      expect(settings.visualization.fftSize).toBe(2048);
      expect(settings.application.serverPort).toBe(0);
      expect(settings.application.controlsAutoHideDelay).toBe(5);
      expect(settings.playback.defaultVolume).toBe(0.5);
      expect(settings.playback.crossfadeDuration).toBe(100);
      expect(settings.playback.previousTrackThreshold).toBe(3);
      expect(settings.playback.skipDuration).toBe(10);
      expect(settings.playback.videoAspectMode).toBe('default');
      expect(settings.transcoding.videoQuality).toBe('medium');
      expect(settings.transcoding.audioBitrate).toBe(192);
      // glassEnabled is not boolean -> falls through to default
      expect(settings.appearance.glassEnabled).toBe(process.platform !== 'win32');
      expect(settings.appearance.macOSVisualEffectState).toBe('active');
      expect(settings.appearance.backgroundColor).toBe('#1e1e1e');
    });
  });

  // ========================================================================
  // 2. updateVisualizationSettings
  // ========================================================================

  describe('updateVisualizationSettings', () => {
    it('should update defaultType with a valid visualization type', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateVisualizationSettings({ defaultType: 'tunnel' });

      expect(result.visualization.defaultType).toBe('tunnel');
    });

    it('should reject an invalid defaultType and leave settings unchanged', () => {
      const manager: SettingsManager = new SettingsManager();
      const before: AppSettings = manager.getSettings();
      const result: AppSettings = manager.updateVisualizationSettings({ defaultType: 'invalid' });

      expect(result.visualization.defaultType).toBe(before.visualization.defaultType);
    });

    it('should accept all valid visualization types', () => {
      const validTypes: readonly string[] = [
        'bars', 'waveform', 'tunnel', 'neon', 'pulsar', 'water', 'infinity', 'onix', 'modern', 'spotlight', 'hallucia', 'hawking',
        'ambience-zoom', 'ambience-stretch', 'ambience-ripple',
        'blank', 'logo', 'album-art',
      ];

      for (const vizType of validTypes) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateVisualizationSettings({ defaultType: vizType });
        expect(result.visualization.defaultType).toBe(vizType);
      }
    });

    it('should update maxFrameRate with valid values (0, 15, 30, 60)', () => {
      const validRates: readonly number[] = [0, 15, 30, 60];

      for (const rate of validRates) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateVisualizationSettings({ maxFrameRate: rate });
        expect(result.visualization.maxFrameRate).toBe(rate);
      }
    });

    it('should reject invalid maxFrameRate values', () => {
      const invalidRates: readonly number[] = [1, 10, 24, 45, 90, 120, -1];

      for (const rate of invalidRates) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateVisualizationSettings({ maxFrameRate: rate });
        expect(result.visualization.maxFrameRate).toBe(60);
      }
    });

    it('should update fftSize with valid powers of 2', () => {
      const validSizes: readonly number[] = [256, 512, 1024, 2048, 4096];

      for (const size of validSizes) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateVisualizationSettings({
          fftSize: size as 256 | 512 | 1024 | 2048 | 4096,
        });
        expect(result.visualization.fftSize).toBe(size);
      }
    });

    it('should reject invalid fftSize values (non-power-of-2, out of range)', () => {
      const manager: SettingsManager = new SettingsManager();

      // 257 is not a valid FFT size
      const r1: AppSettings = manager.updateVisualizationSettings({ fftSize: 257 as 256 });
      expect(r1.visualization.fftSize).toBe(2048);

      // 128 is too small
      const r2: AppSettings = manager.updateVisualizationSettings({ fftSize: 128 as 256 });
      expect(r2.visualization.fftSize).toBe(2048);

      // 8192 is too large
      const r3: AppSettings = manager.updateVisualizationSettings({ fftSize: 8192 as 4096 });
      expect(r3.visualization.fftSize).toBe(2048);
    });

    it('should deep-merge perVisualizationSettings with existing settings', () => {
      const manager: SettingsManager = new SettingsManager();

      // First update: set bars sensitivity
      manager.updateVisualizationSettings({
        perVisualizationSettings: { bars: { sensitivity: 0.7 } },
      });

      // Second update: set bars barDensity (should merge, not replace)
      const result: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: { bars: { barDensity: 'high' } },
      });

      expect(result.visualization.perVisualizationSettings['bars']?.sensitivity).toBe(0.7);
      expect(result.visualization.perVisualizationSettings['bars']?.barDensity).toBe('high');
    });

    it('should strip invalid per-visualization settings keys', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: {
          'unknownViz': { sensitivity: 0.5 },
          'bars': { sensitivity: 0.9 },
        },
      });

      expect(result.visualization.perVisualizationSettings['unknownViz']).toBeUndefined();
      expect(result.visualization.perVisualizationSettings['bars']?.sensitivity).toBe(0.9);
    });

    it('should validate per-visualization local setting values', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: {
          bars: {
            sensitivity: 2.0,    // invalid: > 1
            barDensity: 'ultra' as 'low',  // invalid
            barColorBottom: '#00cc00',     // valid
          },
        },
      });

      const barsSettings = result.visualization.perVisualizationSettings['bars'];
      expect(barsSettings?.sensitivity).toBeUndefined();
      expect(barsSettings?.barDensity).toBeUndefined();
      expect(barsSettings?.barColorBottom).toBe('#00cc00');
    });
  });

  // ========================================================================
  // 3. updateApplicationSettings
  // ========================================================================

  describe('updateApplicationSettings', () => {
    it('should accept valid port numbers', () => {
      const validPorts: readonly number[] = [0, 1024, 3000, 8080, 65535];

      for (const port of validPorts) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateApplicationSettings({ serverPort: port });
        expect(result.application.serverPort).toBe(port);
      }
    });

    it('should reject invalid port numbers', () => {
      const invalidPorts: readonly number[] = [1023, 65536, -1];

      for (const port of invalidPorts) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateApplicationSettings({ serverPort: port });
        expect(result.application.serverPort).toBe(0);
      }
    });

    it('should reject non-integer port values', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateApplicationSettings({ serverPort: 3000.5 });
      expect(result.application.serverPort).toBe(0);
    });

    it('should reject non-number port values via type coercion', () => {
      const manager: SettingsManager = new SettingsManager();
      // Force a string through as unknown to simulate bad runtime input
      const result: AppSettings = manager.updateApplicationSettings({
        serverPort: 'abc' as unknown as number,
      });
      expect(result.application.serverPort).toBe(0);
    });

    it('should accept valid controlsAutoHideDelay values (0-30)', () => {
      const validDelays: readonly number[] = [0, 1, 15, 30];

      for (const delay of validDelays) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateApplicationSettings({ controlsAutoHideDelay: delay });
        expect(result.application.controlsAutoHideDelay).toBe(delay);
      }
    });

    it('should reject invalid controlsAutoHideDelay values', () => {
      const invalidDelays: readonly number[] = [-1, 31, 100];

      for (const delay of invalidDelays) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateApplicationSettings({ controlsAutoHideDelay: delay });
        expect(result.application.controlsAutoHideDelay).toBe(5);
      }
    });

    it('should reject non-integer controlsAutoHideDelay', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateApplicationSettings({ controlsAutoHideDelay: 5.5 });
      expect(result.application.controlsAutoHideDelay).toBe(5);
    });
  });

  // ========================================================================
  // 4. updatePlaybackSettings
  // ========================================================================

  describe('updatePlaybackSettings', () => {
    it('should accept valid volume values (0.0 - 1.0)', () => {
      const validVolumes: readonly number[] = [0, 0.25, 0.5, 0.75, 1];

      for (const vol of validVolumes) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updatePlaybackSettings({ defaultVolume: vol });
        expect(result.playback.defaultVolume).toBe(vol);
      }
    });

    it('should reject invalid volume values', () => {
      const invalidVolumes: readonly number[] = [-0.1, 1.1, 2, -1];

      for (const vol of invalidVolumes) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updatePlaybackSettings({ defaultVolume: vol });
        expect(result.playback.defaultVolume).toBe(0.5);
      }
    });

    it('should accept valid crossfadeDuration values (0-500 integers)', () => {
      const validDurations: readonly number[] = [0, 1, 100, 250, 500];

      for (const duration of validDurations) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updatePlaybackSettings({ crossfadeDuration: duration });
        expect(result.playback.crossfadeDuration).toBe(duration);
      }
    });

    it('should reject invalid crossfadeDuration values', () => {
      const invalidDurations: readonly number[] = [-1, 501, 1000];

      for (const duration of invalidDurations) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updatePlaybackSettings({ crossfadeDuration: duration });
        expect(result.playback.crossfadeDuration).toBe(100);
      }
    });

    it('should reject non-integer crossfadeDuration', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updatePlaybackSettings({ crossfadeDuration: 99.5 });
      expect(result.playback.crossfadeDuration).toBe(100);
    });

    it('should accept valid previousTrackThreshold values (0-10 integers)', () => {
      const validThresholds: readonly number[] = [0, 1, 5, 10];

      for (const threshold of validThresholds) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updatePlaybackSettings({ previousTrackThreshold: threshold });
        expect(result.playback.previousTrackThreshold).toBe(threshold);
      }
    });

    it('should reject invalid previousTrackThreshold values', () => {
      const invalidThresholds: readonly number[] = [-1, 11, 100];

      for (const threshold of invalidThresholds) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updatePlaybackSettings({ previousTrackThreshold: threshold });
        expect(result.playback.previousTrackThreshold).toBe(3);
      }
    });

    it('should reject non-integer previousTrackThreshold', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updatePlaybackSettings({ previousTrackThreshold: 3.5 });
      expect(result.playback.previousTrackThreshold).toBe(3);
    });

    it('should accept valid skipDuration values (1-60 integers)', () => {
      const validSkips: readonly number[] = [1, 5, 10, 30, 60];

      for (const skip of validSkips) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updatePlaybackSettings({ skipDuration: skip });
        expect(result.playback.skipDuration).toBe(skip);
      }
    });

    it('should reject invalid skipDuration values', () => {
      const invalidSkips: readonly number[] = [0, 61, -1, 100];

      for (const skip of invalidSkips) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updatePlaybackSettings({ skipDuration: skip });
        expect(result.playback.skipDuration).toBe(10);
      }
    });

    it('should reject non-integer skipDuration', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updatePlaybackSettings({ skipDuration: 10.5 });
      expect(result.playback.skipDuration).toBe(10);
    });

    it('should accept valid videoAspectMode values', () => {
      const validModes: readonly string[] = ['default', '4:3', '16:9', 'fit'];

      for (const mode of validModes) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updatePlaybackSettings({
          videoAspectMode: mode as 'default' | '4:3' | '16:9' | 'fit',
        });
        expect(result.playback.videoAspectMode).toBe(mode);
      }
    });

    it('should reject invalid videoAspectMode values', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updatePlaybackSettings({
        videoAspectMode: 'stretch' as 'default',
      });
      expect(result.playback.videoAspectMode).toBe('default');
    });

    it('should update multiple playback fields in one call', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updatePlaybackSettings({
        defaultVolume: 0.8,
        crossfadeDuration: 200,
        skipDuration: 30,
      });

      expect(result.playback.defaultVolume).toBe(0.8);
      expect(result.playback.crossfadeDuration).toBe(200);
      expect(result.playback.skipDuration).toBe(30);
      // Unchanged fields keep defaults
      expect(result.playback.previousTrackThreshold).toBe(3);
      expect(result.playback.videoAspectMode).toBe('default');
    });
  });

  // ========================================================================
  // 5. updateTranscodingSettings
  // ========================================================================

  describe('updateTranscodingSettings', () => {
    it('should accept valid videoQuality values', () => {
      const validQualities: readonly string[] = ['low', 'medium', 'high'];

      for (const quality of validQualities) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateTranscodingSettings({
          videoQuality: quality as 'low' | 'medium' | 'high',
        });
        expect(result.transcoding.videoQuality).toBe(quality);
      }
    });

    it('should reject invalid videoQuality values', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateTranscodingSettings({
        videoQuality: 'ultra' as 'low',
      });
      expect(result.transcoding.videoQuality).toBe('medium');
    });

    it('should accept valid audioBitrate values', () => {
      const validBitrates: readonly number[] = [128, 192, 256, 320];

      for (const bitrate of validBitrates) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateTranscodingSettings({
          audioBitrate: bitrate as 128 | 192 | 256 | 320,
        });
        expect(result.transcoding.audioBitrate).toBe(bitrate);
      }
    });

    it('should reject invalid audioBitrate values', () => {
      const invalidBitrates: readonly number[] = [64, 96, 160, 384, 512];

      for (const bitrate of invalidBitrates) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateTranscodingSettings({
          audioBitrate: bitrate as 128,
        });
        expect(result.transcoding.audioBitrate).toBe(192);
      }
    });
  });

  // ========================================================================
  // 6. updateAppearanceSettings
  // ========================================================================

  describe('updateAppearanceSettings', () => {
    it('should accept valid glassEnabled boolean values', () => {
      const manager: SettingsManager = new SettingsManager();

      const r1: AppSettings = manager.updateAppearanceSettings({ glassEnabled: false });
      expect(r1.appearance.glassEnabled).toBe(false);

      const r2: AppSettings = manager.updateAppearanceSettings({ glassEnabled: true });
      expect(r2.appearance.glassEnabled).toBe(true);
    });

    it('should reject non-boolean glassEnabled values', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateAppearanceSettings({
        glassEnabled: 'true' as unknown as boolean,
      });
      // Should remain at default (true)
      expect(result.appearance.glassEnabled).toBe(process.platform !== 'win32');
    });

    it('should accept valid macOSVisualEffectState values', () => {
      const validStates: readonly string[] = ['followWindow', 'active', 'inactive'];

      for (const state of validStates) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateAppearanceSettings({
          macOSVisualEffectState: state as 'followWindow' | 'active' | 'inactive',
        });
        expect(result.appearance.macOSVisualEffectState).toBe(state);
      }
    });

    it('should reject invalid macOSVisualEffectState values', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateAppearanceSettings({
        macOSVisualEffectState: 'turbo' as 'followWindow',
      });
      expect(result.appearance.macOSVisualEffectState).toBe('active');
    });

    it('should accept valid hex color for backgroundColor (#RRGGBB)', () => {
      const validColors: readonly string[] = ['#000000', '#FFFFFF', '#1e1e1e', '#aAbBcC', '#123456'];

      for (const color of validColors) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateAppearanceSettings({ backgroundColor: color });
        expect(result.appearance.backgroundColor).toBe(color);
      }
    });

    it('should reject invalid hex color formats', () => {
      const invalidColors: readonly string[] = [
        '#FFF',        // too short (#RGB)
        'FF0000',      // missing hash
        '#GGHHII',     // invalid hex chars
        '#12345',      // 5 digits
        '#1234567',    // 7 digits
        'red',         // named color
        '',            // empty
      ];

      for (const color of invalidColors) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateAppearanceSettings({ backgroundColor: color });
        expect(result.appearance.backgroundColor).toBe('#1e1e1e');
      }
    });
  });

  // ========================================================================
  // 7. setMiniplayerBounds
  // ========================================================================

  describe('setMiniplayerBounds', () => {
    it('should accept valid window bounds with positive dimensions', () => {
      const manager: SettingsManager = new SettingsManager();
      const bounds: WindowBounds = { x: 100, y: 200, width: 400, height: 300 };
      const result: AppSettings = manager.setMiniplayerBounds(bounds);

      expect(result.windowState.miniplayerBounds).toEqual(bounds);
    });

    it('should accept bounds with negative x/y positions', () => {
      const manager: SettingsManager = new SettingsManager();
      const bounds: WindowBounds = { x: -100, y: -50, width: 400, height: 300 };
      const result: AppSettings = manager.setMiniplayerBounds(bounds);

      expect(result.windowState.miniplayerBounds).toEqual(bounds);
    });

    it('should accept null to clear bounds', () => {
      const manager: SettingsManager = new SettingsManager();

      // First set some bounds
      manager.setMiniplayerBounds({ x: 100, y: 200, width: 400, height: 300 });

      // Then clear them
      const result: AppSettings = manager.setMiniplayerBounds(null);
      expect(result.windowState.miniplayerBounds).toBeNull();
    });

    it('should reject bounds with zero width', () => {
      const manager: SettingsManager = new SettingsManager();
      const bounds: WindowBounds = { x: 100, y: 200, width: 0, height: 300 };
      const result: AppSettings = manager.setMiniplayerBounds(bounds);

      expect(result.windowState.miniplayerBounds).toBeNull();
    });

    it('should reject bounds with zero height', () => {
      const manager: SettingsManager = new SettingsManager();
      const bounds: WindowBounds = { x: 100, y: 200, width: 400, height: 0 };
      const result: AppSettings = manager.setMiniplayerBounds(bounds);

      expect(result.windowState.miniplayerBounds).toBeNull();
    });

    it('should reject bounds with negative width or height', () => {
      const manager: SettingsManager = new SettingsManager();

      const r1: AppSettings = manager.setMiniplayerBounds({ x: 0, y: 0, width: -100, height: 300 });
      expect(r1.windowState.miniplayerBounds).toBeNull();

      const r2: AppSettings = manager.setMiniplayerBounds({ x: 0, y: 0, width: 100, height: -300 });
      expect(r2.windowState.miniplayerBounds).toBeNull();
    });

    it('should reject bounds with missing properties', () => {
      const manager: SettingsManager = new SettingsManager();
      const incompleteBounds: unknown = { x: 100, y: 200 };
      const result: AppSettings = manager.setMiniplayerBounds(incompleteBounds as WindowBounds);

      expect(result.windowState.miniplayerBounds).toBeNull();
    });

    it('should be retrievable via getMiniplayerBounds', () => {
      const manager: SettingsManager = new SettingsManager();
      const bounds: WindowBounds = { x: 50, y: 75, width: 320, height: 240 };
      manager.setMiniplayerBounds(bounds);

      expect(manager.getMiniplayerBounds()).toEqual(bounds);
    });
  });

  // ========================================================================
  // 8. Save / load persistence cycle
  // ========================================================================

  describe('save/load persistence', () => {
    it('should persist settings to disk after an update', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updateVisualizationSettings({ defaultType: 'neon' });
      manager.flush();

      // Read the file directly and verify
      const onDisk: AppSettings = readSettingsFile();
      expect(onDisk.visualization.defaultType).toBe('neon');
    });

    it('should survive a full save/load round trip', () => {
      // Create manager, make changes, and save
      const manager1: SettingsManager = new SettingsManager();
      manager1.updateVisualizationSettings({ defaultType: 'pulsar', fftSize: 512, maxFrameRate: 30 });
      manager1.updateApplicationSettings({ serverPort: 4000, controlsAutoHideDelay: 10 });
      manager1.updatePlaybackSettings({ defaultVolume: 0.75, crossfadeDuration: 250, skipDuration: 15, videoAspectMode: 'fit' });
      manager1.updateTranscodingSettings({ videoQuality: 'high', audioBitrate: 320 });
      manager1.updateAppearanceSettings({ glassEnabled: false, backgroundColor: '#333333' });
      manager1.setMiniplayerBounds({ x: 10, y: 20, width: 300, height: 200 });

      manager1.flush();
      // Create a new manager instance (should load from disk)
      const manager2: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager2.getSettings();

      expect(settings.visualization.defaultType).toBe('pulsar');
      expect(settings.visualization.fftSize).toBe(512);
      expect(settings.visualization.maxFrameRate).toBe(30);
      expect(settings.application.serverPort).toBe(4000);
      expect(settings.application.controlsAutoHideDelay).toBe(10);
      expect(settings.playback.defaultVolume).toBe(0.75);
      expect(settings.playback.crossfadeDuration).toBe(250);
      expect(settings.playback.skipDuration).toBe(15);
      expect(settings.playback.videoAspectMode).toBe('fit');
      expect(settings.transcoding.videoQuality).toBe('high');
      expect(settings.transcoding.audioBitrate).toBe(320);
      expect(settings.appearance.glassEnabled).toBe(false);
      expect(settings.appearance.backgroundColor).toBe('#333333');
      expect(settings.windowState.miniplayerBounds).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    });

    it('should persist perVisualizationSettings through a round trip', () => {
      const manager1: SettingsManager = new SettingsManager();
      manager1.updateVisualizationSettings({
        perVisualizationSettings: {
          bars: { sensitivity: 0.8, barDensity: 'high', barColorBottom: '#112233' },
          waveform: { lineWidth: 3.0, glowIntensity: 0.7 },
        },
      });

      manager1.flush();
      const manager2: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager2.getSettings();

      expect(settings.visualization.perVisualizationSettings['bars']?.sensitivity).toBe(0.8);
      expect(settings.visualization.perVisualizationSettings['bars']?.barDensity).toBe('high');
      expect(settings.visualization.perVisualizationSettings['bars']?.barColorBottom).toBe('#112233');
      expect(settings.visualization.perVisualizationSettings['waveform']?.lineWidth).toBe(3.0);
      expect(settings.visualization.perVisualizationSettings['waveform']?.glowIntensity).toBe(0.7);
    });
  });

  // ========================================================================
  // 9. validateAndMerge - partial settings merged with defaults
  // ========================================================================

  describe('validateAndMerge (via load)', () => {
    it('should merge partial visualization settings with defaults', () => {
      writeSettingsFile({
        version: 2,
        visualization: { defaultType: 'tunnel' },
        // Other sections missing
      });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.visualization.defaultType).toBe('tunnel');
      expect(settings.visualization.maxFrameRate).toBe(60);
      expect(settings.visualization.fftSize).toBe(2048);
    });

    it('should merge partial application settings with defaults', () => {
      writeSettingsFile({
        version: 2,
        application: { serverPort: 9090 },
      });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.application.serverPort).toBe(9090);
      expect(settings.application.controlsAutoHideDelay).toBe(5);
    });

    it('should merge partial playback settings with defaults', () => {
      writeSettingsFile({
        version: 2,
        playback: { defaultVolume: 0.9, skipDuration: 20 },
      });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.playback.defaultVolume).toBe(0.9);
      expect(settings.playback.skipDuration).toBe(20);
      expect(settings.playback.crossfadeDuration).toBe(100);
      expect(settings.playback.previousTrackThreshold).toBe(3);
      expect(settings.playback.videoAspectMode).toBe('default');
    });

    it('should handle null parsed value by returning defaults', () => {
      fs.writeFileSync(settingsFilePath(), 'null', 'utf-8');

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.visualization.defaultType).toBe('water');
    });

    it('should preserve the version number from the file', () => {
      writeSettingsFile({ version: 1 });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.version).toBe(1);
    });

    it('should use default version when version is not a number', () => {
      writeSettingsFile({ version: 'invalid' });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.version).toBe(2);
    });

    it('should load saved miniplayerBounds from windowState', () => {
      writeSettingsFile({
        version: 2,
        windowState: {
          miniplayerBounds: { x: 50, y: 100, width: 320, height: 240 },
        },
      });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.windowState.miniplayerBounds).toEqual({ x: 50, y: 100, width: 320, height: 240 });
    });

    it('should discard invalid miniplayerBounds from windowState', () => {
      writeSettingsFile({
        version: 2,
        windowState: {
          miniplayerBounds: { x: 50, y: 100 }, // missing width, height
        },
      });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.windowState.miniplayerBounds).toBeNull();
    });
  });

  // ========================================================================
  // 10. v1 -> v2 migration
  // ========================================================================

  describe('v1 to v2 migration', () => {
    it('should migrate perVisualizationSensitivity to perVisualizationSettings', () => {
      writeSettingsFile({
        version: 1,
        visualization: {
          defaultType: 'bars',
          maxFrameRate: 0,
          fftSize: 2048,
          perVisualizationSensitivity: {
            bars: 0.7,
            waveform: 0.3,
            tunnel: 0.9,
          },
        },
      });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.visualization.perVisualizationSettings['bars']?.sensitivity).toBe(0.7);
      expect(settings.visualization.perVisualizationSettings['waveform']?.sensitivity).toBe(0.3);
      expect(settings.visualization.perVisualizationSettings['tunnel']?.sensitivity).toBe(0.9);
    });

    it('should skip invalid visualization types during migration', () => {
      writeSettingsFile({
        version: 1,
        visualization: {
          defaultType: 'bars',
          maxFrameRate: 0,
          fftSize: 2048,
          perVisualizationSensitivity: {
            bars: 0.5,
            nonexistent: 0.8,
          },
        },
      });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.visualization.perVisualizationSettings['bars']?.sensitivity).toBe(0.5);
      expect(settings.visualization.perVisualizationSettings['nonexistent']).toBeUndefined();
    });

    it('should skip invalid sensitivity values during migration', () => {
      writeSettingsFile({
        version: 1,
        visualization: {
          defaultType: 'bars',
          maxFrameRate: 0,
          fftSize: 2048,
          perVisualizationSensitivity: {
            bars: 1.5,       // out of range
            waveform: -0.1,  // out of range
            tunnel: 'high',  // wrong type
          },
        },
      });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.visualization.perVisualizationSettings['bars']?.sensitivity).toBeUndefined();
      expect(settings.visualization.perVisualizationSettings['waveform']?.sensitivity).toBeUndefined();
      expect(settings.visualization.perVisualizationSettings['tunnel']?.sensitivity).toBeUndefined();
    });

    it('should not overwrite existing v2 perVisualizationSettings with migrated data', () => {
      writeSettingsFile({
        version: 1,
        visualization: {
          defaultType: 'bars',
          maxFrameRate: 0,
          fftSize: 2048,
          perVisualizationSettings: {
            bars: { sensitivity: 0.6, barDensity: 'high' },
          },
          perVisualizationSensitivity: {
            bars: 0.9,
          },
        },
      });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      // The v2 data is loaded first, then the v1 migration merges over it.
      // Since the migration simply sets sensitivity, the barDensity from v2 should remain
      // but sensitivity gets overwritten by the migration value.
      expect(settings.visualization.perVisualizationSettings['bars']?.barDensity).toBe('high');
      // The v1 migration overwrites sensitivity
      expect(settings.visualization.perVisualizationSettings['bars']?.sensitivity).toBe(0.9);
    });
  });

  // ========================================================================
  // 11. macOSVibrancy migration (appearance)
  // ========================================================================

  describe('appearance macOSVibrancy migration', () => {
    it('should migrate macOSVibrancy "none" to glassEnabled false', () => {
      writeSettingsFile({
        version: 1,
        appearance: {
          macOSVibrancy: 'none',
        },
      });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.appearance.glassEnabled).toBe(false);
    });

    it('should migrate macOSVibrancy non-"none" to glassEnabled true', () => {
      writeSettingsFile({
        version: 1,
        appearance: {
          macOSVibrancy: 'under-window',
        },
      });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.appearance.glassEnabled).toBe(true);
    });

    it('should prefer glassEnabled boolean over macOSVibrancy if both present', () => {
      writeSettingsFile({
        version: 2,
        appearance: {
          glassEnabled: false,
          macOSVibrancy: 'under-window',  // would normally mean enabled
        },
      });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.appearance.glassEnabled).toBe(false);
    });
  });

  // ========================================================================
  // 12. Per-visualization local settings validators (via update)
  // ========================================================================

  describe('per-visualization local setting validators', () => {
    it('should accept valid barDensity values (low, medium, high)', () => {
      const validDensities: readonly string[] = ['low', 'medium', 'high'];

      for (const density of validDensities) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateVisualizationSettings({
          perVisualizationSettings: {
            bars: { barDensity: density as 'low' | 'medium' | 'high' },
          },
        });
        expect(result.visualization.perVisualizationSettings['bars']?.barDensity).toBe(density);
      }
    });

    it('should reject invalid barDensity values', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: {
          bars: { barDensity: 'extreme' as 'low' },
        },
      });
      expect(result.visualization.perVisualizationSettings['bars']?.barDensity).toBeUndefined();
    });

    it('should accept valid trailIntensity (0.0 - 1.0)', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: {
          tunnel: { trailIntensity: 0.75 },
        },
      });
      expect(result.visualization.perVisualizationSettings['tunnel']?.trailIntensity).toBe(0.75);
    });

    it('should reject invalid trailIntensity', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: {
          tunnel: { trailIntensity: 1.5 },
        },
      });
      expect(result.visualization.perVisualizationSettings['tunnel']?.trailIntensity).toBeUndefined();
    });

    it('should accept valid lineWidth (1.0 - 5.0)', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: {
          waveform: { lineWidth: 3.5 },
        },
      });
      expect(result.visualization.perVisualizationSettings['waveform']?.lineWidth).toBe(3.5);
    });

    it('should reject invalid lineWidth', () => {
      const manager: SettingsManager = new SettingsManager();
      const r1: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: { waveform: { lineWidth: 0.5 } },
      });
      expect(r1.visualization.perVisualizationSettings['waveform']?.lineWidth).toBeUndefined();

      const manager2: SettingsManager = new SettingsManager();
      const r2: AppSettings = manager2.updateVisualizationSettings({
        perVisualizationSettings: { waveform: { lineWidth: 6.0 } },
      });
      expect(r2.visualization.perVisualizationSettings['waveform']?.lineWidth).toBeUndefined();
    });

    it('should accept valid glowIntensity (0.0 - 1.0)', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: {
          neon: { glowIntensity: 0.9 },
        },
      });
      expect(result.visualization.perVisualizationSettings['neon']?.glowIntensity).toBe(0.9);
    });

    it('should reject invalid glowIntensity', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: {
          neon: { glowIntensity: -0.1 },
        },
      });
      expect(result.visualization.perVisualizationSettings['neon']?.glowIntensity).toBeUndefined();
    });

    it('should accept valid waveformSmoothing (0.0 - 1.0)', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: {
          onix: { waveformSmoothing: 0.8 },
        },
      });
      expect(result.visualization.perVisualizationSettings['onix']?.waveformSmoothing).toBe(0.8);
    });

    it('should reject invalid waveformSmoothing', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: {
          onix: { waveformSmoothing: 1.5 },
        },
      });
      expect(result.visualization.perVisualizationSettings['onix']?.waveformSmoothing).toBeUndefined();
    });

    it('should accept valid hex color for bar colors', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: {
          bars: {
            barColorBottom: '#00ff00',
            barColorMiddle: '#ffff00',
            barColorTop: '#ff0000',
          },
        },
      });

      const barsSettings = result.visualization.perVisualizationSettings['bars'];
      expect(barsSettings?.barColorBottom).toBe('#00ff00');
      expect(barsSettings?.barColorMiddle).toBe('#ffff00');
      expect(barsSettings?.barColorTop).toBe('#ff0000');
    });

    it('should reject invalid hex color for bar colors', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: {
          bars: {
            barColorBottom: '#FFF',       // too short
            barColorMiddle: 'FFFF00',     // missing hash
            barColorTop: '#ZZZZZZ',       // invalid hex
          },
        },
      });

      const barsSettings = result.visualization.perVisualizationSettings['bars'];
      // All invalid -> no entry should exist at all (empty object filtered out)
      expect(barsSettings).toBeUndefined();
    });
  });

  // ========================================================================
  // 13. Edge cases / additional coverage
  // ========================================================================

  describe('edge cases', () => {
    it('should not modify settings when update has no fields', () => {
      const manager: SettingsManager = new SettingsManager();
      const before: AppSettings = manager.getSettings();

      const afterViz: AppSettings = manager.updateVisualizationSettings({});
      expect(afterViz.visualization.defaultType).toBe(before.visualization.defaultType);

      const afterApp: AppSettings = manager.updateApplicationSettings({});
      expect(afterApp.application.serverPort).toBe(before.application.serverPort);

      const afterPlay: AppSettings = manager.updatePlaybackSettings({});
      expect(afterPlay.playback.defaultVolume).toBe(before.playback.defaultVolume);

      const afterTrans: AppSettings = manager.updateTranscodingSettings({});
      expect(afterTrans.transcoding.videoQuality).toBe(before.transcoding.videoQuality);

      const afterAppear: AppSettings = manager.updateAppearanceSettings({});
      expect(afterAppear.appearance.glassEnabled).toBe(before.appearance.glassEnabled);
    });

    it('should handle rapid sequential updates correctly', () => {
      const manager: SettingsManager = new SettingsManager();

      manager.updateVisualizationSettings({ defaultType: 'waveform' });
      manager.updateVisualizationSettings({ defaultType: 'tunnel' });
      manager.updateVisualizationSettings({ defaultType: 'neon' });

      const settings: AppSettings = manager.getSettings();
      expect(settings.visualization.defaultType).toBe('neon');
    });

    it('should handle an empty perVisualizationSettings object in file', () => {
      writeSettingsFile({
        version: 2,
        visualization: {
          defaultType: 'bars',
          maxFrameRate: 0,
          fftSize: 2048,
          perVisualizationSettings: {},
        },
      });

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.visualization.perVisualizationSettings).toEqual({});
    });

    it('should not include per-visualization entries with all invalid fields', () => {
      const manager: SettingsManager = new SettingsManager();
      const result: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: {
          bars: {
            sensitivity: 5.0,       // invalid
            barDensity: 'x' as 'low', // invalid
          },
        },
      });

      // The bars entry should not exist because all its fields were invalid
      expect(result.visualization.perVisualizationSettings['bars']).toBeUndefined();
    });

    it('should use atomic write (temp file strategy)', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updateVisualizationSettings({ defaultType: 'water' });
      // Saves are debounced; write the pending change now.
      manager.flush();

      // The temp file should not linger after a successful save
      const tempPath: string = settingsFilePath() + '.tmp';
      expect(fs.existsSync(tempPath)).toBe(false);

      // But the actual settings file should exist
      expect(fs.existsSync(settingsFilePath())).toBe(true);
    });
  });

  // ===========================================================================
  // Setup Wizard Tests
  // ===========================================================================

  describe('Setup Wizard', () => {
    beforeEach(() => {
      mockUserDataPath = path.join(os.tmpdir(), `onixplayer-test-${Date.now()}`);
      createTempDir();
    });

    afterEach(() => {
      removeTempDir();
    });

    describe('isSetupComplete', () => {
      it('should return false by default (fresh install)', () => {
        const manager: SettingsManager = new SettingsManager();
        expect(manager.isSetupComplete()).toBe(false);
      });

      it('should return true if setupCompleted is true in settings file', () => {
        writeSettingsFile({
          version: 2,
          application: { setupCompleted: true },
        });
        const manager: SettingsManager = new SettingsManager();
        expect(manager.isSetupComplete()).toBe(true);
      });

      it('should return false if setupCompleted is false in settings file', () => {
        writeSettingsFile({
          version: 2,
          application: { setupCompleted: false },
        });
        const manager: SettingsManager = new SettingsManager();
        expect(manager.isSetupComplete()).toBe(false);
      });

      it('should return false if setupCompleted is missing from settings file', () => {
        writeSettingsFile({
          version: 2,
          application: { serverPort: 0 },
        });
        const manager: SettingsManager = new SettingsManager();
        expect(manager.isSetupComplete()).toBe(false);
      });
    });

    describe('markSetupComplete', () => {
      it('should set setupCompleted to true', () => {
        const manager: SettingsManager = new SettingsManager();
        expect(manager.isSetupComplete()).toBe(false);

        manager.markSetupComplete();
        expect(manager.isSetupComplete()).toBe(true);
      });

      it('should persist setupCompleted to disk', () => {
        const manager1: SettingsManager = new SettingsManager();
        manager1.markSetupComplete();

        manager1.flush();
        // Create a new manager to reload from disk
        const manager2: SettingsManager = new SettingsManager();
        expect(manager2.isSetupComplete()).toBe(true);
      });

      it('should return updated settings', () => {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.markSetupComplete();
        expect(result.application.setupCompleted).toBe(true);
      });

      it('should not affect other application settings', () => {
        const manager: SettingsManager = new SettingsManager();
        manager.updateApplicationSettings({ serverPort: 8080 });

        const result: AppSettings = manager.markSetupComplete();
        expect(result.application.serverPort).toBe(8080);
        expect(result.application.setupCompleted).toBe(true);
      });

      it('should record the supplied app version', () => {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.markSetupComplete('2026.1.0');
        expect(result.application.setupCompletedVersion).toBe('2026.1.0');
        expect(manager.getSetupCompletedVersion()).toBe('2026.1.0');
      });

      it('should persist the completed version to disk', () => {
        const manager1: SettingsManager = new SettingsManager();
        manager1.markSetupComplete('2026.1.0');

        manager1.flush();
        const manager2: SettingsManager = new SettingsManager();
        expect(manager2.getSetupCompletedVersion()).toBe('2026.1.0');
      });
    });

    describe('isSetupCompleteForVersion', () => {
      it('should return false on a fresh install', () => {
        const manager: SettingsManager = new SettingsManager();
        expect(manager.isSetupCompleteForVersion('2026.1.0')).toBe(false);
      });

      it('should return true when the completed version matches', () => {
        const manager: SettingsManager = new SettingsManager();
        manager.markSetupComplete('2026.1.0');
        expect(manager.isSetupCompleteForVersion('2026.1.0')).toBe(true);
      });

      it('should return false after an upgrade to a newer version', () => {
        const manager: SettingsManager = new SettingsManager();
        manager.markSetupComplete('2026.1.0');
        // Simulates upgrading the app: setup must run again for the new version.
        expect(manager.isSetupCompleteForVersion('2026.2.0')).toBe(false);
      });

      it('should return false when setup completed without a recorded version', () => {
        writeSettingsFile({
          version: 2,
          application: { setupCompleted: true },
        });
        const manager: SettingsManager = new SettingsManager();
        expect(manager.isSetupCompleteForVersion('2026.1.0')).toBe(false);
      });
    });

    describe('setupCompleted default value', () => {
      it('should default to false in DEFAULT_SETTINGS', () => {
        const manager: SettingsManager = new SettingsManager();
        const settings: AppSettings = manager.getSettings();
        expect(settings.application.setupCompleted).toBe(false);
      });
    });

    describe('serverPort for setup wizard', () => {
      it('should allow setting serverPort via updateApplicationSettings', () => {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateApplicationSettings({ serverPort: 8080 });
        expect(result.application.serverPort).toBe(8080);
      });

      it('should persist serverPort across reload', () => {
        const manager1: SettingsManager = new SettingsManager();
        manager1.updateApplicationSettings({ serverPort: 9999 });

        manager1.flush();
        const manager2: SettingsManager = new SettingsManager();
        expect(manager2.getSettings().application.serverPort).toBe(9999);
      });

      it('should default serverPort to 0 (auto-assign)', () => {
        const manager: SettingsManager = new SettingsManager();
        expect(manager.getSettings().application.serverPort).toBe(0);
      });

      it('should accept port 0 (auto-assign)', () => {
        const manager: SettingsManager = new SettingsManager();
        manager.updateApplicationSettings({ serverPort: 8080 });
        const result: AppSettings = manager.updateApplicationSettings({ serverPort: 0 });
        expect(result.application.serverPort).toBe(0);
      });

      it('should accept valid port numbers (1024-65535)', () => {
        const validPorts: readonly number[] = [1024, 3000, 8080, 49152, 65535];
        for (const port of validPorts) {
          const manager: SettingsManager = new SettingsManager();
          const result: AppSettings = manager.updateApplicationSettings({ serverPort: port });
          expect(result.application.serverPort).toBe(port);
        }
      });
    });
  });

  // ===========================================================================
  // Visualization rendering options
  // ===========================================================================

  describe('visualization rendering options', () => {
    it('should accept every supported render resolution', () => {
      const resolutions: readonly RenderResolution[] = [
        'native', '320x180', '320x200', '640x360', '640x400', '640x480', '800x450', '800x500',
        '800x600', '1024x576', '1024x640', '1024x768', '1280x720', '1280x800', '1280x1024',
      ];

      for (const resolution of resolutions) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateVisualizationSettings({ renderResolution: resolution });
        expect(result.visualization.renderResolution).toBe(resolution);
      }
    });

    it('should reject an unsupported render resolution', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateVisualizationSettings({
        renderResolution: '1920x1080' as RenderResolution,
      });

      expect(result.visualization.renderResolution).toBe('native');
    });

    it('should accept every supported visualization crossfade duration', () => {
      const durations: readonly CrossfadeDuration[] = [500, 750, 1000, 1500, 2000];

      for (const duration of durations) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateVisualizationSettings({ crossfadeDuration: duration });
        expect(result.visualization.crossfadeDuration).toBe(duration);
      }
    });

    it('should reject a visualization crossfade duration that is not one of the presets', () => {
      const invalidDurations: readonly number[] = [0, 499, 600, 2001, -1000];

      for (const duration of invalidDurations) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateVisualizationSettings({
          crossfadeDuration: duration as CrossfadeDuration,
        });
        expect(result.visualization.crossfadeDuration).toBe(1000);
      }
    });

    it('should accept every supported crossfade style', () => {
      const styles: readonly CrossfadeStyle[] = ['fade', 'zoom', 'shrink', 'blur', 'random'];

      for (const style of styles) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateVisualizationSettings({ crossfadeStyle: style });
        expect(result.visualization.crossfadeStyle).toBe(style);
      }
    });

    it('should reject an unknown crossfade style', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateVisualizationSettings({
        crossfadeStyle: 'wipe' as CrossfadeStyle,
      });

      expect(result.visualization.crossfadeStyle).toBe('fade');
    });

    it('should apply none of an update when one of its fields is invalid', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateVisualizationSettings({
        defaultType: 'tunnel',
        maxFrameRate: 30,
        crossfadeStyle: 'wipe' as CrossfadeStyle,
      });

      expect(result.visualization.defaultType).toBe('water');
      expect(result.visualization.maxFrameRate).toBe(60);
    });

    it('should keep the other visualization fields when one is updated', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updateVisualizationSettings({ renderResolution: '640x480', crossfadeStyle: 'zoom' });

      const result: AppSettings = manager.updateVisualizationSettings({ crossfadeDuration: 2000 });

      expect(result.visualization.renderResolution).toBe('640x480');
      expect(result.visualization.crossfadeStyle).toBe('zoom');
      expect(result.visualization.crossfadeDuration).toBe(2000);
    });

    it('should load valid rendering options from the settings file', () => {
      writeSettingsFile({
        version: 2,
        visualization: { renderResolution: '1280x720', crossfadeDuration: 750, crossfadeStyle: 'blur' },
      });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.visualization.renderResolution).toBe('1280x720');
      expect(settings.visualization.crossfadeDuration).toBe(750);
      expect(settings.visualization.crossfadeStyle).toBe('blur');
    });

    it('should replace invalid rendering options in the settings file with defaults', () => {
      writeSettingsFile({
        version: 2,
        visualization: { renderResolution: 720, crossfadeDuration: '1000', crossfadeStyle: 'wipe' },
      });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.visualization.renderResolution).toBe('native');
      expect(settings.visualization.crossfadeDuration).toBe(1000);
      expect(settings.visualization.crossfadeStyle).toBe('fade');
    });

    it('should accept a whole-number strobe frequency between 1 and 20 Hz', () => {
      const validFrequencies: readonly number[] = [1, 10, 20];

      for (const frequency of validFrequencies) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateVisualizationSettings({
          perVisualizationSettings: { spotlight: { strobeFrequency: frequency } },
        });
        expect(result.visualization.perVisualizationSettings['spotlight']?.strobeFrequency).toBe(frequency);
      }
    });

    it('should drop a strobe frequency that is fractional or out of range', () => {
      const invalidFrequencies: readonly unknown[] = [0, 21, 2.5, -1, '5'];

      for (const frequency of invalidFrequencies) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateVisualizationSettings({
          perVisualizationSettings: { spotlight: { strobeFrequency: frequency as number, sensitivity: 0.5 } },
        });
        expect(result.visualization.perVisualizationSettings['spotlight']).toEqual({ sensitivity: 0.5 });
      }
    });

    it('should skip a per-visualization entry that is not an object', () => {
      const manager: SettingsManager = new SettingsManager();
      const update: unknown = { bars: 'loud', waveform: null, tunnel: { sensitivity: 0.2 } };

      const result: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: update as PerVisualizationSettings,
      });

      expect(result.visualization.perVisualizationSettings).toEqual({ tunnel: { sensitivity: 0.2 } });
    });

    it('should leave per-visualization settings alone when the update is not an object', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updateVisualizationSettings({ perVisualizationSettings: { bars: { sensitivity: 0.3 } } });

      const result: AppSettings = manager.updateVisualizationSettings({
        perVisualizationSettings: null as unknown as PerVisualizationSettings,
      });

      expect(result.visualization.perVisualizationSettings).toEqual({ bars: { sensitivity: 0.3 } });
    });

    it('should ignore perVisualizationSettings in the file when it is not an object', () => {
      writeSettingsFile({
        version: 2,
        visualization: { defaultType: 'bars', perVisualizationSettings: 'everything' },
      });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.visualization.defaultType).toBe('bars');
      expect(settings.visualization.perVisualizationSettings).toEqual({});
    });
  });

  // ===========================================================================
  // Application: wizard flags, focus-loss miniplayer, active SoundFont
  // ===========================================================================

  describe('application flags and active SoundFont', () => {
    it('should reject a non-boolean setupCompleted', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateApplicationSettings({
        setupCompleted: 'true' as unknown as boolean,
      });

      expect(result.application.setupCompleted).toBe(false);
    });

    it('should reject a non-string setupCompletedVersion', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateApplicationSettings({
        setupCompletedVersion: 2026 as unknown as string,
      });

      expect(result.application.setupCompletedVersion).toBe('');
    });

    it('should not mark setup complete when the supplied version is not a string', () => {
      const manager: SettingsManager = new SettingsManager();

      manager.markSetupComplete(2026 as unknown as string);

      expect(manager.isSetupComplete()).toBe(false);
    });

    it('should update miniplayerOnFocusLoss with a boolean', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateApplicationSettings({ miniplayerOnFocusLoss: true });

      expect(result.application.miniplayerOnFocusLoss).toBe(true);
    });

    it('should reject a non-boolean miniplayerOnFocusLoss', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateApplicationSettings({
        miniplayerOnFocusLoss: 1 as unknown as boolean,
      });

      expect(result.application.miniplayerOnFocusLoss).toBe(false);
    });

    it('should have no active SoundFont by default', () => {
      const manager: SettingsManager = new SettingsManager();

      expect(manager.getActiveSoundFontFileName()).toBeNull();
    });

    it('should remember the active SoundFont file name', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.setActiveSoundFontFileName('FluidR3_GM.sf2');

      expect(result.application.activeSoundFontFileName).toBe('FluidR3_GM.sf2');
      expect(manager.getActiveSoundFontFileName()).toBe('FluidR3_GM.sf2');
    });

    it('should clear the active SoundFont when set to null', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.setActiveSoundFontFileName('FluidR3_GM.sf2');

      manager.setActiveSoundFontFileName(null);

      expect(manager.getActiveSoundFontFileName()).toBeNull();
    });

    it('should keep the active SoundFont when an unrelated application setting changes', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.setActiveSoundFontFileName('FluidR3_GM.sf2');

      manager.updateApplicationSettings({ controlsAutoHideDelay: 12 });

      expect(manager.getActiveSoundFontFileName()).toBe('FluidR3_GM.sf2');
    });

    it('should keep other application settings when the active SoundFont changes', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updateApplicationSettings({ serverPort: 8080, miniplayerOnFocusLoss: true });

      const result: AppSettings = manager.setActiveSoundFontFileName('GeneralUser.sf2');

      expect(result.application.serverPort).toBe(8080);
      expect(result.application.miniplayerOnFocusLoss).toBe(true);
    });

    it('should persist the active SoundFont across a reload', () => {
      const first: SettingsManager = new SettingsManager();
      first.setActiveSoundFontFileName('GeneralUser.sf2');
      first.flush();

      const second: SettingsManager = new SettingsManager();

      expect(second.getActiveSoundFontFileName()).toBe('GeneralUser.sf2');
    });

    it('should load application flags from the settings file', () => {
      writeSettingsFile({
        version: 2,
        application: { miniplayerOnFocusLoss: true, activeSoundFontFileName: 'Custom.sf2', setupCompletedVersion: '2026.9.0' },
      });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.application.miniplayerOnFocusLoss).toBe(true);
      expect(settings.application.activeSoundFontFileName).toBe('Custom.sf2');
      expect(settings.application.setupCompletedVersion).toBe('2026.9.0');
    });

    it('should replace wrongly typed application flags in the settings file with defaults', () => {
      writeSettingsFile({
        version: 2,
        application: {
          setupCompleted: 'yes',
          setupCompletedVersion: 2026,
          miniplayerOnFocusLoss: 'no',
          activeSoundFontFileName: 42,
        },
      });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.application.setupCompleted).toBe(false);
      expect(settings.application.setupCompletedVersion).toBe('');
      expect(settings.application.miniplayerOnFocusLoss).toBe(false);
      expect(settings.application.activeSoundFontFileName).toBeNull();
    });
  });

  // ===========================================================================
  // Playback: languages and seek mode
  // ===========================================================================

  describe('playback languages and seek mode', () => {
    it('should accept supported preferred audio languages', () => {
      const languages: readonly PreferredAudioLanguage[] = ['default', 'eng', 'jpn', 'hun'];

      for (const language of languages) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updatePlaybackSettings({ preferredAudioLanguage: language });
        expect(result.playback.preferredAudioLanguage).toBe(language);
      }
    });

    it('should reject "off" as a preferred audio language', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updatePlaybackSettings({
        preferredAudioLanguage: 'off' as PreferredAudioLanguage,
      });

      expect(result.playback.preferredAudioLanguage).toBe('eng');
    });

    it('should reject an unknown preferred audio language', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updatePlaybackSettings({
        preferredAudioLanguage: 'xx' as PreferredAudioLanguage,
      });

      expect(result.playback.preferredAudioLanguage).toBe('eng');
    });

    it('should accept supported preferred subtitle languages, including "off"', () => {
      const languages: readonly PreferredSubtitleLanguage[] = ['default', 'eng', 'kor', 'off'];

      for (const language of languages) {
        const manager: SettingsManager = new SettingsManager();
        manager.updatePlaybackSettings({ preferredSubtitleLanguage: 'spa' });
        const result: AppSettings = manager.updatePlaybackSettings({ preferredSubtitleLanguage: language });
        expect(result.playback.preferredSubtitleLanguage).toBe(language);
      }
    });

    it('should reject an unknown preferred subtitle language', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updatePlaybackSettings({
        preferredSubtitleLanguage: 'klingon' as PreferredSubtitleLanguage,
      });

      expect(result.playback.preferredSubtitleLanguage).toBe('off');
    });

    it('should accept both seek modes', () => {
      const manager: SettingsManager = new SettingsManager();

      const dragging: AppSettings = manager.updatePlaybackSettings({ seekMode: 'drag' });
      const dropping: AppSettings = manager.updatePlaybackSettings({ seekMode: 'drop' });

      expect(dragging.playback.seekMode).toBe('drag');
      expect(dropping.playback.seekMode).toBe('drop');
    });

    it('should reject an unknown seek mode', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updatePlaybackSettings({ seekMode: 'scrub' as SeekMode });

      expect(result.playback.seekMode).toBe('drop');
    });

    it('should apply none of a playback update when one of its fields is invalid', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updatePlaybackSettings({
        defaultVolume: 0.9,
        seekMode: 'scrub' as SeekMode,
      });

      expect(result.playback.defaultVolume).toBe(0.5);
    });

    it('should load languages and seek mode from the settings file', () => {
      writeSettingsFile({
        version: 2,
        playback: { preferredAudioLanguage: 'ger', preferredSubtitleLanguage: 'fre', seekMode: 'drag' },
      });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.playback.preferredAudioLanguage).toBe('ger');
      expect(settings.playback.preferredSubtitleLanguage).toBe('fre');
      expect(settings.playback.seekMode).toBe('drag');
    });

    it('should replace invalid languages and seek mode in the settings file with defaults', () => {
      writeSettingsFile({
        version: 2,
        playback: { preferredAudioLanguage: 'off', preferredSubtitleLanguage: 7, seekMode: 'scrub' },
      });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.playback.preferredAudioLanguage).toBe('eng');
      expect(settings.playback.preferredSubtitleLanguage).toBe('off');
      expect(settings.playback.seekMode).toBe('drop');
    });
  });

  // ===========================================================================
  // Transcoding: hardware acceleration
  // ===========================================================================

  describe('transcoding hardware acceleration', () => {
    it('should accept every supported hardware acceleration value', () => {
      const values: readonly HardwareAcceleration[] = [
        'auto', 'disabled', 'h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi',
      ];

      for (const value of values) {
        const manager: SettingsManager = new SettingsManager();
        const result: AppSettings = manager.updateTranscodingSettings({ hardwareAcceleration: value });
        expect(result.transcoding.hardwareAcceleration).toBe(value);
      }
    });

    it('should reject an unknown hardware encoder', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateTranscodingSettings({
        hardwareAcceleration: 'hevc_nvenc' as HardwareAcceleration,
      });

      expect(result.transcoding.hardwareAcceleration).toBe('auto');
    });

    it('should keep quality and bitrate when only hardware acceleration changes', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updateTranscodingSettings({ videoQuality: 'high', audioBitrate: 320 });

      const result: AppSettings = manager.updateTranscodingSettings({ hardwareAcceleration: 'disabled' });

      expect(result.transcoding.videoQuality).toBe('high');
      expect(result.transcoding.audioBitrate).toBe(320);
    });

    it('should load hardware acceleration from the settings file', () => {
      writeSettingsFile({ version: 2, transcoding: { hardwareAcceleration: 'h264_qsv' } });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.transcoding.hardwareAcceleration).toBe('h264_qsv');
    });

    it('should replace an unknown hardware encoder in the settings file with "auto"', () => {
      writeSettingsFile({ version: 2, transcoding: { videoQuality: 'low', hardwareAcceleration: 'h265_magic' } });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.transcoding.hardwareAcceleration).toBe('auto');
      expect(settings.transcoding.videoQuality).toBe('low');
    });
  });

  // ===========================================================================
  // Appearance: colour scheme, background HSL, window tint
  // ===========================================================================

  describe('appearance colour scheme, background and tint', () => {
    type AppearanceNumberField =
      | 'backgroundHue' | 'backgroundSaturation' | 'backgroundLightness'
      | 'windowTintHue' | 'windowTintSaturation' | 'windowTintLightness' | 'windowTintAlpha';

    it('should accept every colour scheme', () => {
      const schemes: readonly ColorScheme[] = ['dark', 'light', 'system'];

      for (const scheme of schemes) {
        const manager: SettingsManager = new SettingsManager();
        manager.updateAppearanceSettings({ colorScheme: scheme === 'system' ? 'dark' : 'system' });
        const result: AppSettings = manager.updateAppearanceSettings({ colorScheme: scheme });
        expect(result.appearance.colorScheme).toBe(scheme);
      }
    });

    it('should reject an unknown colour scheme', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateAppearanceSettings({ colorScheme: 'sepia' as ColorScheme });

      expect(result.appearance.colorScheme).toBe('system');
    });

    it.each([
      ['backgroundHue', 0], ['backgroundHue', 360],
      ['backgroundSaturation', 0], ['backgroundSaturation', 100],
      ['backgroundLightness', 0], ['backgroundLightness', 100],
      ['windowTintHue', 360], ['windowTintSaturation', 100], ['windowTintLightness', 100],
      ['windowTintAlpha', 1], ['windowTintAlpha', 0.35],
    ] as const)('should accept %s at %d', (field: AppearanceNumberField, value: number) => {
      const manager: SettingsManager = new SettingsManager();
      const update: AppearanceSettingsUpdate = { [field]: value };

      const result: AppSettings = manager.updateAppearanceSettings(update);

      expect(result.appearance[field]).toBe(value);
    });

    it.each([
      ['backgroundHue', -1], ['backgroundHue', 361], ['backgroundHue', 'red'],
      ['backgroundSaturation', -1], ['backgroundSaturation', 101],
      ['backgroundLightness', -0.5], ['backgroundLightness', 100.5],
      ['windowTintHue', -1], ['windowTintHue', 400],
      ['windowTintSaturation', 101], ['windowTintLightness', -10],
      ['windowTintAlpha', -0.1], ['windowTintAlpha', 1.5], ['windowTintAlpha', Number.NaN],
    ] as const)('should reject %s at %s', (field: AppearanceNumberField, value: number | string) => {
      const manager: SettingsManager = new SettingsManager();
      const before: AppSettings = manager.getSettings();
      const update: unknown = { [field]: value, colorScheme: 'light' };

      const result: AppSettings = manager.updateAppearanceSettings(update as AppearanceSettingsUpdate);

      expect(result.appearance).toEqual(before.appearance);
    });

    it.each([
      [0, 100, 50, '#ff0000'],
      [120, 100, 50, '#00ff00'],
      [240, 100, 50, '#0000ff'],
      [360, 100, 50, '#ff0000'],
      [60, 100, 50, '#ffff00'],
      [200, 0, 100, '#ffffff'],
      [200, 100, 0, '#000000'],
      [0, 0, 20, '#333333'],
    ] as const)('should derive the background colour for hsl(%d, %d%%, %d%%) as %s', (hue: number, saturation: number, lightness: number, expected: string) => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateAppearanceSettings({
        backgroundHue: hue,
        backgroundSaturation: saturation,
        backgroundLightness: lightness,
      });

      expect(result.appearance.backgroundColor).toBe(expected);
    });

    it('should derive the background colour from stored HSL values when only one changes', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updateAppearanceSettings({ backgroundHue: 240, backgroundSaturation: 100, backgroundLightness: 50 });

      const result: AppSettings = manager.updateAppearanceSettings({ backgroundHue: 120 });

      expect(result.appearance.backgroundColor).toBe('#00ff00');
      expect(result.appearance.backgroundSaturation).toBe(100);
      expect(result.appearance.backgroundLightness).toBe(50);
    });

    it('should prefer the HSL-derived colour over an explicit backgroundColor in the same update', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateAppearanceSettings({
        backgroundColor: '#123456',
        backgroundHue: 0,
        backgroundSaturation: 100,
        backgroundLightness: 50,
      });

      expect(result.appearance.backgroundColor).toBe('#ff0000');
    });

    it('should leave the background colour alone when only the window tint changes', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updateAppearanceSettings({ backgroundColor: '#123456' });

      const result: AppSettings = manager.updateAppearanceSettings({
        windowTintHue: 210,
        windowTintSaturation: 80,
        windowTintLightness: 40,
        windowTintAlpha: 0.25,
      });

      expect(result.appearance.backgroundColor).toBe('#123456');
      expect(result.appearance.windowTintHue).toBe(210);
      expect(result.appearance.windowTintSaturation).toBe(80);
      expect(result.appearance.windowTintLightness).toBe(40);
      expect(result.appearance.windowTintAlpha).toBe(0.25);
    });

    it('should load colour scheme, background HSL and tint from the settings file', () => {
      writeSettingsFile({
        version: 2,
        appearance: {
          colorScheme: 'light',
          backgroundHue: 200,
          backgroundSaturation: 30,
          backgroundLightness: 15,
          windowTintHue: 300,
          windowTintSaturation: 60,
          windowTintLightness: 45,
          windowTintAlpha: 0.4,
        },
      });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.appearance).toMatchObject({
        colorScheme: 'light',
        backgroundHue: 200,
        backgroundSaturation: 30,
        backgroundLightness: 15,
        windowTintHue: 300,
        windowTintSaturation: 60,
        windowTintLightness: 45,
        windowTintAlpha: 0.4,
      });
    });

    it('should replace out-of-range appearance values in the settings file with defaults', () => {
      writeSettingsFile({
        version: 2,
        appearance: {
          colorScheme: 'neon',
          backgroundHue: 720,
          backgroundSaturation: -5,
          backgroundLightness: '12',
          windowTintHue: -90,
          windowTintSaturation: 250,
          windowTintLightness: null,
          windowTintAlpha: 2,
        },
      });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.appearance).toMatchObject({
        colorScheme: 'system',
        backgroundHue: 0,
        backgroundSaturation: 0,
        backgroundLightness: 12,
        windowTintHue: 0,
        windowTintSaturation: 0,
        windowTintLightness: 0,
        windowTintAlpha: 0,
      });
    });
  });

  // ===========================================================================
  // Subtitles
  // ===========================================================================

  describe('updateSubtitleSettings', () => {
    type SubtitleField = keyof SubtitleSettingsUpdate;

    it('should use the documented subtitle defaults', () => {
      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.subtitles).toEqual({
        fontSize: 100,
        fontColor: '#ffffff',
        backgroundColor: '#000000',
        backgroundOpacity: 0.75,
        fontFamily: 'sans-serif',
        textShadow: true,
        shadowSpread: 2,
        shadowBlur: 2,
        shadowColor: '#000000',
      });
    });

    it.each([
      ['fontSize', 50], ['fontSize', 300],
      ['fontColor', '#ff00ff'],
      ['backgroundColor', '#101010'],
      ['backgroundOpacity', 0], ['backgroundOpacity', 1],
      ['fontFamily', 'serif'], ['fontFamily', 'monospace'], ['fontFamily', 'Arial'],
      ['textShadow', false],
      ['shadowSpread', 1], ['shadowSpread', 5],
      ['shadowBlur', 0], ['shadowBlur', 10],
      ['shadowColor', '#abcdef'],
    ] as const)('should accept %s set to %s', (field: SubtitleField, value: number | string | boolean) => {
      const manager: SettingsManager = new SettingsManager();
      const update: unknown = { [field]: value };

      const result: AppSettings = manager.updateSubtitleSettings(update as SubtitleSettingsUpdate);

      expect(result.subtitles[field]).toBe(value);
    });

    it.each([
      ['fontSize', 49], ['fontSize', 301], ['fontSize', 100.5], ['fontSize', '100'],
      ['fontColor', 'white'], ['fontColor', '#fff'],
      ['backgroundColor', '#00000'], ['backgroundColor', 0],
      ['backgroundOpacity', -0.1], ['backgroundOpacity', 1.1],
      ['fontFamily', 'Comic Sans'], ['fontFamily', 'arial'],
      ['textShadow', 'yes'], ['textShadow', 0],
      ['shadowSpread', 0.5], ['shadowSpread', 6],
      ['shadowBlur', -1], ['shadowBlur', 11],
      ['shadowColor', 'black'],
    ] as const)('should reject %s set to %s', (field: SubtitleField, value: number | string) => {
      const manager: SettingsManager = new SettingsManager();
      const before: AppSettings = manager.getSettings();
      const update: unknown = { [field]: value };

      const result: AppSettings = manager.updateSubtitleSettings(update as SubtitleSettingsUpdate);

      expect(result.subtitles).toEqual(before.subtitles);
    });

    it('should apply none of a subtitle update when one of its fields is invalid', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateSubtitleSettings({ fontSize: 150, shadowColor: 'black' });

      expect(result.subtitles.fontSize).toBe(100);
    });

    it('should update several subtitle fields at once and keep the rest', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateSubtitleSettings({
        fontSize: 180,
        fontFamily: 'monospace' as SubtitleFontFamily,
        textShadow: false,
      });

      expect(result.subtitles).toEqual({
        fontSize: 180,
        fontColor: '#ffffff',
        backgroundColor: '#000000',
        backgroundOpacity: 0.75,
        fontFamily: 'monospace',
        textShadow: false,
        shadowSpread: 2,
        shadowBlur: 2,
        shadowColor: '#000000',
      });
    });

    it('should leave other settings categories untouched', () => {
      const manager: SettingsManager = new SettingsManager();
      const before: AppSettings = manager.getSettings();

      const result: AppSettings = manager.updateSubtitleSettings({ fontSize: 120 });

      expect(result.playback).toEqual(before.playback);
      expect(result.appearance).toEqual(before.appearance);
    });

    it('should persist subtitle settings across a reload', () => {
      const first: SettingsManager = new SettingsManager();
      first.updateSubtitleSettings({ fontSize: 250, fontColor: '#ffff00', backgroundOpacity: 0.25 });
      first.flush();

      const reloaded: AppSettings = new SettingsManager().getSettings();

      expect(reloaded.subtitles.fontSize).toBe(250);
      expect(reloaded.subtitles.fontColor).toBe('#ffff00');
      expect(reloaded.subtitles.backgroundOpacity).toBe(0.25);
    });

    it('should merge a partial subtitles section in the file with defaults', () => {
      writeSettingsFile({ version: 2, subtitles: { fontSize: 200, fontFamily: 'serif' } });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.subtitles.fontSize).toBe(200);
      expect(settings.subtitles.fontFamily).toBe('serif');
      expect(settings.subtitles.fontColor).toBe('#ffffff');
      expect(settings.subtitles.textShadow).toBe(true);
    });

    it('should replace invalid subtitle values in the settings file with defaults', () => {
      writeSettingsFile({
        version: 2,
        subtitles: {
          fontSize: 1000,
          fontColor: 'white',
          backgroundColor: 12,
          backgroundOpacity: 7,
          fontFamily: 'Papyrus',
          textShadow: 'true',
          shadowSpread: 0,
          shadowBlur: 99,
          shadowColor: '#12',
        },
      });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.subtitles).toEqual({
        fontSize: 100,
        fontColor: '#ffffff',
        backgroundColor: '#000000',
        backgroundOpacity: 0.75,
        fontFamily: 'sans-serif',
        textShadow: true,
        shadowSpread: 2,
        shadowBlur: 2,
        shadowColor: '#000000',
      });
    });

    it('should load every valid subtitle value from the settings file', () => {
      const stored: SubtitleSettingsUpdate = {
        fontSize: 75,
        fontColor: '#00ff00',
        backgroundColor: '#222222',
        backgroundOpacity: 0.5,
        fontFamily: 'Arial',
        textShadow: false,
        shadowSpread: 4,
        shadowBlur: 8,
        shadowColor: '#333333',
      };
      writeSettingsFile({ version: 2, subtitles: stored });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.subtitles).toEqual(stored);
    });
  });

  // ===========================================================================
  // Equalizer
  // ===========================================================================

  describe('updateEqualizerSettings', () => {
    const FLAT_BANDS: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    it('should default to a disabled, flat equalizer with ten bands', () => {
      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.equalizer).toEqual({ enabled: false, preset: 'flat', bands: FLAT_BANDS });
    });

    it('should enable and disable the equalizer', () => {
      const manager: SettingsManager = new SettingsManager();

      const enabled: AppSettings = manager.updateEqualizerSettings({ enabled: true });
      const disabled: AppSettings = manager.updateEqualizerSettings({ enabled: false });

      expect(enabled.equalizer.enabled).toBe(true);
      expect(disabled.equalizer.enabled).toBe(false);
    });

    it('should reject a non-boolean enabled flag', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateEqualizerSettings({ enabled: 'on' as unknown as boolean });

      expect(result.equalizer.enabled).toBe(false);
    });

    it('should accept every known preset', () => {
      const presets: readonly string[] = ['rock', 'pop', 'jazz', 'bass', 'vocal', 'treble', 'custom', 'flat'];

      for (const preset of presets) {
        const manager: SettingsManager = new SettingsManager();
        manager.updateEqualizerSettings({ preset: preset === 'flat' ? 'rock' : 'flat' });
        const result: AppSettings = manager.updateEqualizerSettings({ preset });
        expect(result.equalizer.preset).toBe(preset);
      }
    });

    it('should reject an unknown preset', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateEqualizerSettings({ preset: 'dubstep' });

      expect(result.equalizer.preset).toBe('flat');
    });

    it('should store ten in-range band gains unchanged', () => {
      const manager: SettingsManager = new SettingsManager();
      const bands: readonly number[] = [-12, -6, -3, 0, 1.5, 3, 6, 9, 11.5, 12];

      const result: AppSettings = manager.updateEqualizerSettings({ bands });

      expect(result.equalizer.bands).toEqual(bands);
    });

    it('should clamp band gains to the -12..12 dB range', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateEqualizerSettings({
        bands: [-40, -12.1, 12.1, 99, 0, 0, 0, 0, 0, 0],
      });

      expect(result.equalizer.bands).toEqual([-12, -12, 12, 12, 0, 0, 0, 0, 0, 0]);
    });

    it('should reset a non-numeric or non-finite band gain to 0 dB', () => {
      const manager: SettingsManager = new SettingsManager();
      const bands: unknown = [3, 'loud', Number.NaN, Number.POSITIVE_INFINITY, null, 3, 3, 3, 3, 3];

      const result: AppSettings = manager.updateEqualizerSettings({ bands: bands as number[] });

      expect(result.equalizer.bands).toEqual([3, 0, 0, 0, 0, 3, 3, 3, 3, 3]);
    });

    it('should reject a band list that does not have exactly ten entries', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updateEqualizerSettings({ bands: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] });

      const tooFew: AppSettings = manager.updateEqualizerSettings({ bands: [2, 2, 2] });
      const tooMany: AppSettings = manager.updateEqualizerSettings({ bands: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2] });

      expect(tooFew.equalizer.bands).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
      expect(tooMany.equalizer.bands).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    });

    it('should reject bands that are not an array', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateEqualizerSettings({ bands: 'flat' as unknown as number[] });

      expect(result.equalizer.bands).toEqual(FLAT_BANDS);
    });

    it('should apply none of an equalizer update when the bands are invalid', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateEqualizerSettings({ enabled: true, preset: 'rock', bands: [1] });

      expect(result.equalizer).toEqual({ enabled: false, preset: 'flat', bands: FLAT_BANDS });
    });

    it('should keep the bands when only the preset changes', () => {
      const manager: SettingsManager = new SettingsManager();
      const bands: readonly number[] = [5, 4, 3, 2, 1, 0, -1, -2, -3, -4];
      manager.updateEqualizerSettings({ bands });

      const result: AppSettings = manager.updateEqualizerSettings({ preset: 'custom' });

      expect(result.equalizer.bands).toEqual(bands);
      expect(result.equalizer.preset).toBe('custom');
    });

    it('should persist equalizer settings across a reload', () => {
      const bands: readonly number[] = [6, 5, 4, 3, 2, 1, 0, -1, -2, -3];
      const first: SettingsManager = new SettingsManager();
      first.updateEqualizerSettings({ enabled: true, preset: 'custom', bands });
      first.flush();

      const reloaded: AppSettings = new SettingsManager().getSettings();

      expect(reloaded.equalizer).toEqual({ enabled: true, preset: 'custom', bands });
    });

    it('should clamp band gains loaded from the settings file', () => {
      writeSettingsFile({
        version: 2,
        equalizer: { enabled: true, preset: 'bass', bands: [50, -50, 'x', null, 1, 2, 3, 4, 5, 6] },
      });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.equalizer).toEqual({ enabled: true, preset: 'bass', bands: [12, -12, 0, 0, 1, 2, 3, 4, 5, 6] });
    });

    it('should reset malformed bands in the settings file to flat', () => {
      writeSettingsFile({ version: 2, equalizer: { enabled: true, preset: 'rock', bands: [1, 2, 3] } });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.equalizer.bands).toEqual(FLAT_BANDS);
      expect(settings.equalizer.preset).toBe('rock');
    });

    it('should replace an invalid enabled flag and preset in the settings file with defaults', () => {
      writeSettingsFile({ version: 2, equalizer: { enabled: 1, preset: 'dubstep', bands: 'none' } });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.equalizer).toEqual({ enabled: false, preset: 'flat', bands: FLAT_BANDS });
    });

    it('should use default equalizer settings when the section is not an object', () => {
      writeSettingsFile({ version: 2, equalizer: 'rock' });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.equalizer).toEqual({ enabled: false, preset: 'flat', bands: FLAT_BANDS });
    });
  });

  // ===========================================================================
  // Video adjustments
  // ===========================================================================

  describe('updateVideoAdjustmentsSettings', () => {
    type LevelField = 'brightness' | 'contrast' | 'saturation' | 'hue' | 'blur' | 'grayscale' | 'sepia';

    const NEUTRAL: VideoAdjustmentsSettingsUpdate = {
      enabled: false,
      preset: 'default',
      brightness: 0,
      contrast: 0,
      saturation: 0,
      hue: 0,
      blur: 0,
      grayscale: 0,
      sepia: 0,
      invert: false,
    };

    it('should default to disabled, neutral video adjustments', () => {
      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.videoAdjustments).toEqual(NEUTRAL);
    });

    it('should update enabled, preset and invert', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateVideoAdjustmentsSettings({ enabled: true, preset: 'noir', invert: true });

      expect(result.videoAdjustments.enabled).toBe(true);
      expect(result.videoAdjustments.preset).toBe('noir');
      expect(result.videoAdjustments.invert).toBe(true);
    });

    it('should accept every known preset', () => {
      const presets: readonly string[] = ['vivid', 'warm', 'cool', 'soft', 'noir', 'night', 'custom', 'default'];

      for (const preset of presets) {
        const manager: SettingsManager = new SettingsManager();
        manager.updateVideoAdjustmentsSettings({ preset: preset === 'default' ? 'vivid' : 'default' });
        const result: AppSettings = manager.updateVideoAdjustmentsSettings({ preset });
        expect(result.videoAdjustments.preset).toBe(preset);
      }
    });

    it('should reject an unknown preset', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateVideoAdjustmentsSettings({ preset: 'psychedelic', brightness: 20 });

      expect(result.videoAdjustments).toEqual(NEUTRAL);
    });

    it('should reject a non-boolean enabled flag', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateVideoAdjustmentsSettings({
        enabled: 'yes' as unknown as boolean,
        contrast: 20,
      });

      expect(result.videoAdjustments).toEqual(NEUTRAL);
    });

    it('should reject a non-boolean invert flag', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.updateVideoAdjustmentsSettings({
        invert: 1 as unknown as boolean,
        contrast: 20,
      });

      expect(result.videoAdjustments).toEqual(NEUTRAL);
    });

    it.each([
      ['brightness', 55, 55], ['brightness', 250, 100], ['brightness', -250, -100],
      ['contrast', -40, -40], ['contrast', 101, 100], ['contrast', -101, -100],
      ['saturation', 100, 100], ['saturation', 1000, 100], ['saturation', -1000, -100],
      ['hue', 180, 180], ['hue', 181, 180], ['hue', -360, -180],
      ['blur', 30, 30], ['blur', 101, 100], ['blur', -5, 0],
      ['grayscale', 100, 100], ['grayscale', 400, 100], ['grayscale', -1, 0],
      ['sepia', 0, 0], ['sepia', 150, 100], ['sepia', -150, 0],
    ] as const)('should store %s %d as %d', (field: LevelField, value: number, expected: number) => {
      const manager: SettingsManager = new SettingsManager();
      const update: VideoAdjustmentsSettingsUpdate = { [field]: value };

      const result: AppSettings = manager.updateVideoAdjustmentsSettings(update);

      expect(result.videoAdjustments[field]).toBe(expected);
    });

    it('should reset a non-finite level to 0', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updateVideoAdjustmentsSettings({ brightness: 40, hue: 90 });

      const result: AppSettings = manager.updateVideoAdjustmentsSettings({
        brightness: Number.NaN,
        hue: 'sideways' as unknown as number,
      });

      expect(result.videoAdjustments.brightness).toBe(0);
      expect(result.videoAdjustments.hue).toBe(0);
    });

    it('should keep the levels that an update does not mention', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updateVideoAdjustmentsSettings({
        enabled: true, preset: 'custom', brightness: 10, contrast: 20, saturation: 30, hue: 40, blur: 5, grayscale: 6, sepia: 7, invert: true,
      });

      const result: AppSettings = manager.updateVideoAdjustmentsSettings({ contrast: -20 });

      expect(result.videoAdjustments).toEqual({
        enabled: true, preset: 'custom', brightness: 10, contrast: -20, saturation: 30, hue: 40, blur: 5, grayscale: 6, sepia: 7, invert: true,
      });
    });

    it('should persist video adjustments across a reload', () => {
      const first: SettingsManager = new SettingsManager();
      first.updateVideoAdjustmentsSettings({ enabled: true, preset: 'warm', brightness: 15, sepia: 35 });
      first.flush();

      const reloaded: AppSettings = new SettingsManager().getSettings();

      expect(reloaded.videoAdjustments).toEqual({ ...NEUTRAL, enabled: true, preset: 'warm', brightness: 15, sepia: 35 });
    });

    it('should clamp levels loaded from the settings file', () => {
      writeSettingsFile({
        version: 2,
        videoAdjustments: {
          enabled: true, preset: 'vivid', brightness: 500, contrast: -500, saturation: 50, hue: 720, blur: -3, grayscale: 101, sepia: 40, invert: true,
        },
      });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.videoAdjustments).toEqual({
        enabled: true, preset: 'vivid', brightness: 100, contrast: -100, saturation: 50, hue: 180, blur: 0, grayscale: 100, sepia: 40, invert: true,
      });
    });

    it('should replace wrongly typed video adjustments in the settings file with defaults', () => {
      writeSettingsFile({
        version: 2,
        videoAdjustments: {
          enabled: 'true', preset: 'psychedelic', brightness: '50', contrast: null, saturation: {}, hue: [], blur: true, grayscale: 'x', sepia: 25, invert: 0,
        },
      });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.videoAdjustments).toEqual({ ...NEUTRAL, sepia: 25 });
    });

    it('should use default video adjustments when the section is not an object', () => {
      writeSettingsFile({ version: 2, videoAdjustments: 5 });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.videoAdjustments).toEqual(NEUTRAL);
    });
  });

  // ===========================================================================
  // Recent files and playlists
  // ===========================================================================

  describe('recent items', () => {
    const NOW_ISO: string = '2026-03-04T05:06:07.000Z';
    const songA: string = path.join(os.tmpdir(), 'Music', 'a.mp3');
    const songB: string = path.join(os.tmpdir(), 'Music', 'b.flac');
    const songC: string = path.join(os.tmpdir(), 'Music', 'c.ogg');
    const listA: string = path.join(os.tmpdir(), 'Playlists', 'a.opp');
    const listB: string = path.join(os.tmpdir(), 'Playlists', 'b.opp');

    /** Builds n distinct file paths: track-0.mp3, track-1.mp3, ... */
    function numberedPaths(count: number, extension: string = 'mp3'): string[] {
      return Array.from({ length: count }, (_: unknown, index: number): string =>
        path.join(os.tmpdir(), 'Music', `track-${index}.${extension}`));
    }

    afterEach(() => {
      restorePlatform();
      vi.useRealTimers();
    });

    it('should start with no recent items and the default caps', () => {
      const recent: RecentItemsSettings = new SettingsManager().getRecentItems();

      expect(recent).toEqual({ recentFiles: [], recentPlaylists: [], maxFiles: 10, maxPlaylists: 5 });
    });

    it('should record a recent file with its base name, type and the time it was added', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW_ISO));
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.addRecentFile(songA);

      expect(result.recentItems.recentFiles).toEqual([
        { path: songA, displayName: 'a.mp3', timestamp: NOW_ISO, type: 'file' },
      ]);
    });

    it('should put the most recently added file first', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentFile(songA);
      manager.addRecentFile(songB);

      const result: AppSettings = manager.addRecentFile(songC);

      expect(pathsOf(result.recentItems.recentFiles)).toEqual([songC, songB, songA]);
    });

    it('should move a file that is added again to the front without duplicating it', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentFile(songA);
      manager.addRecentFile(songB);
      manager.addRecentFile(songC);

      const result: AppSettings = manager.addRecentFile(songA);

      expect(pathsOf(result.recentItems.recentFiles)).toEqual([songA, songC, songB]);
    });

    it('should refresh the timestamp of a file that is added again', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentFile(songA);
      vi.setSystemTime(new Date(NOW_ISO));

      const result: AppSettings = manager.addRecentFile(songA);

      expect(result.recentItems.recentFiles[0].timestamp).toBe(NOW_ISO);
    });

    it('should keep only the ten most recent files', () => {
      const manager: SettingsManager = new SettingsManager();
      const paths: string[] = numberedPaths(12);

      for (const filePath of paths) {
        manager.addRecentFile(filePath);
      }

      const expected: string[] = paths.slice(2).reverse();
      expect(pathsOf(manager.getRecentItems().recentFiles)).toEqual(expected);
    });

    it('should honour a smaller maxFiles cap stored in the settings file', () => {
      writeSettingsFile({ version: 2, recentItems: { recentFiles: [], recentPlaylists: [], maxFiles: 2, maxPlaylists: 1 } });
      const manager: SettingsManager = new SettingsManager();

      manager.addRecentFiles([songA, songB, songC]);

      expect(pathsOf(manager.getRecentItems().recentFiles)).toEqual([songC, songB]);
    });

    it('should add a batch of files so the last one given ends up first', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentFile(songA);

      const result: AppSettings = manager.addRecentFiles([songB, songC]);

      expect(pathsOf(result.recentItems.recentFiles)).toEqual([songC, songB, songA]);
    });

    it('should keep one entry, at its latest position, for a path repeated within a batch', () => {
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.addRecentFiles([songA, songB, songA]);

      expect(pathsOf(result.recentItems.recentFiles)).toEqual([songA, songB]);
    });

    it('should replace existing entries for paths that a batch adds again', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentFiles([songA, songB, songC]);

      const result: AppSettings = manager.addRecentFiles([songA, songB]);

      expect(pathsOf(result.recentItems.recentFiles)).toEqual([songB, songA, songC]);
    });

    it('should give every file in a batch the same timestamp', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW_ISO));
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.addRecentFiles([songA, songB]);

      expect(result.recentItems.recentFiles.map((item: RecentItem): string => item.timestamp)).toEqual([NOW_ISO, NOW_ISO]);
    });

    it('should change nothing and schedule no save for an empty batch', () => {
      const manager: SettingsManager = new SettingsManager();
      const before: AppSettings = manager.getSettings();

      const result: AppSettings = manager.addRecentFiles([]);
      manager.flush();

      expect(result).toBe(before);
      expect(fs.existsSync(settingsFilePath())).toBe(false);
    });

    it('should treat paths that differ only by case as the same file on Windows', () => {
      stubPlatform('win32');
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentFile(songA);
      manager.addRecentFile(songB);

      const result: AppSettings = manager.addRecentFile(songA.toUpperCase());

      expect(pathsOf(result.recentItems.recentFiles)).toEqual([songA.toUpperCase(), songB]);
    });

    it('should treat paths that differ only by case as different files off Windows', () => {
      stubPlatform('linux');
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentFile(songA);

      const result: AppSettings = manager.addRecentFile(songA.toUpperCase());

      expect(pathsOf(result.recentItems.recentFiles)).toEqual([songA.toUpperCase(), songA]);
    });

    it('should remove a recent file by path', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentFiles([songA, songB, songC]);

      const result: AppSettings = manager.removeRecentFile(songB);

      expect(pathsOf(result.recentItems.recentFiles)).toEqual([songC, songA]);
    });

    it('should leave the list unchanged when removing a file that is not in it', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentFiles([songA, songB]);

      const result: AppSettings = manager.removeRecentFile(songC);

      expect(pathsOf(result.recentItems.recentFiles)).toEqual([songB, songA]);
    });

    it('should remove a recent file regardless of case on Windows', () => {
      stubPlatform('win32');
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentFiles([songA, songB]);

      const result: AppSettings = manager.removeRecentFile(songA.toUpperCase());

      expect(pathsOf(result.recentItems.recentFiles)).toEqual([songB]);
    });

    it('should not remove a recent file whose case differs off Windows', () => {
      stubPlatform('darwin');
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentFiles([songA, songB]);

      const result: AppSettings = manager.removeRecentFile(songA.toUpperCase());

      expect(pathsOf(result.recentItems.recentFiles)).toEqual([songB, songA]);
    });

    it('should record a recent playlist with its base name, type and the time it was added', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW_ISO));
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.addRecentPlaylist(listA);

      expect(result.recentItems.recentPlaylists).toEqual([
        { path: listA, displayName: 'a.opp', timestamp: NOW_ISO, type: 'playlist' },
      ]);
    });

    it('should move a playlist that is added again to the front without duplicating it', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentPlaylist(listA);
      manager.addRecentPlaylist(listB);

      const result: AppSettings = manager.addRecentPlaylist(listA);

      expect(pathsOf(result.recentItems.recentPlaylists)).toEqual([listA, listB]);
    });

    it('should keep only the five most recent playlists', () => {
      const manager: SettingsManager = new SettingsManager();
      const paths: string[] = numberedPaths(7, 'opp');

      for (const playlistPath of paths) {
        manager.addRecentPlaylist(playlistPath);
      }

      const expected: string[] = paths.slice(2).reverse();
      expect(pathsOf(manager.getRecentItems().recentPlaylists)).toEqual(expected);
    });

    it('should treat playlist paths that differ only by case as the same playlist on Windows', () => {
      stubPlatform('win32');
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentPlaylist(listA);

      const result: AppSettings = manager.addRecentPlaylist(listA.toUpperCase());

      expect(pathsOf(result.recentItems.recentPlaylists)).toEqual([listA.toUpperCase()]);
    });

    it('should treat playlist paths that differ only by case as different playlists off Windows', () => {
      stubPlatform('linux');
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentPlaylist(listA);

      const result: AppSettings = manager.addRecentPlaylist(listA.toUpperCase());

      expect(pathsOf(result.recentItems.recentPlaylists)).toEqual([listA.toUpperCase(), listA]);
    });

    it('should remove a recent playlist by path', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentPlaylist(listA);
      manager.addRecentPlaylist(listB);

      const result: AppSettings = manager.removeRecentPlaylist(listA);

      expect(pathsOf(result.recentItems.recentPlaylists)).toEqual([listB]);
    });

    it('should remove a recent playlist regardless of case on Windows', () => {
      stubPlatform('win32');
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentPlaylist(listA);

      const result: AppSettings = manager.removeRecentPlaylist(listA.toUpperCase());

      expect(result.recentItems.recentPlaylists).toEqual([]);
    });

    it('should not remove a recent playlist whose case differs off Windows', () => {
      stubPlatform('linux');
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentPlaylist(listA);

      const result: AppSettings = manager.removeRecentPlaylist(listA.toUpperCase());

      expect(pathsOf(result.recentItems.recentPlaylists)).toEqual([listA]);
    });

    it('should keep files and playlists in separate lists', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.addRecentFile(songA);
      manager.addRecentPlaylist(listA);

      manager.removeRecentFile(listA);
      manager.removeRecentPlaylist(songA);

      expect(pathsOf(manager.getRecentItems().recentFiles)).toEqual([songA]);
      expect(pathsOf(manager.getRecentItems().recentPlaylists)).toEqual([listA]);
    });

    it('should clear both lists but keep the caps', () => {
      writeSettingsFile({
        version: 2,
        recentItems: {
          recentFiles: [storedRecentItem(songA)],
          recentPlaylists: [storedRecentItem(listA, 'playlist')],
          maxFiles: 20,
          maxPlaylists: 8,
        },
      });
      const manager: SettingsManager = new SettingsManager();

      const result: AppSettings = manager.clearRecentItems();

      expect(result.recentItems).toEqual({ recentFiles: [], recentPlaylists: [], maxFiles: 20, maxPlaylists: 8 });
    });

    it('should persist recent items across a reload', () => {
      const first: SettingsManager = new SettingsManager();
      first.addRecentFiles([songA, songB]);
      first.addRecentPlaylist(listA);
      first.flush();

      const reloaded: RecentItemsSettings = new SettingsManager().getRecentItems();

      expect(pathsOf(reloaded.recentFiles)).toEqual([songB, songA]);
      expect(pathsOf(reloaded.recentPlaylists)).toEqual([listA]);
    });

    it('should persist a cleared list across a reload', () => {
      const first: SettingsManager = new SettingsManager();
      first.addRecentFile(songA);
      first.flush();
      first.clearRecentItems();
      first.flush();

      const reloaded: RecentItemsSettings = new SettingsManager().getRecentItems();

      expect(reloaded.recentFiles).toEqual([]);
    });

    it('should load stored recent items in their stored order', () => {
      const files: RecentItem[] = [storedRecentItem(songB), storedRecentItem(songA)];
      const playlists: RecentItem[] = [storedRecentItem(listB, 'playlist')];
      writeSettingsFile({ version: 2, recentItems: { recentFiles: files, recentPlaylists: playlists, maxFiles: 10, maxPlaylists: 5 } });

      const recent: RecentItemsSettings = new SettingsManager().getRecentItems();

      expect(recent.recentFiles).toEqual(files);
      expect(recent.recentPlaylists).toEqual(playlists);
    });

    it.each([
      ['a missing displayName', { path: '/a.mp3', timestamp: 't', type: 'file' }],
      ['a non-string path', { path: 5, displayName: 'a.mp3', timestamp: 't', type: 'file' }],
      ['a non-string timestamp', { path: '/a.mp3', displayName: 'a.mp3', timestamp: 1700000000, type: 'file' }],
      ['an unknown type', { path: '/a.mp3', displayName: 'a.mp3', timestamp: 't', type: 'folder' }],
      ['a null entry', null],
      ['a bare string entry', '/a.mp3'],
    ])('should discard a stored recent files list containing %s', (_description: string, badEntry: unknown) => {
      writeSettingsFile({
        version: 2,
        recentItems: {
          recentFiles: [storedRecentItem(songA), badEntry],
          recentPlaylists: [storedRecentItem(listA, 'playlist')],
        },
      });

      const recent: RecentItemsSettings = new SettingsManager().getRecentItems();

      expect(recent.recentFiles).toEqual([]);
      expect(pathsOf(recent.recentPlaylists)).toEqual([listA]);
    });

    it('should discard stored recent lists that are not arrays', () => {
      writeSettingsFile({ version: 2, recentItems: { recentFiles: { 0: storedRecentItem(songA) }, recentPlaylists: 'none' } });

      const recent: RecentItemsSettings = new SettingsManager().getRecentItems();

      expect(recent.recentFiles).toEqual([]);
      expect(recent.recentPlaylists).toEqual([]);
    });

    it('should accept stored caps between 1 and 50', () => {
      writeSettingsFile({ version: 2, recentItems: { maxFiles: 50, maxPlaylists: 1 } });

      const recent: RecentItemsSettings = new SettingsManager().getRecentItems();

      expect(recent.maxFiles).toBe(50);
      expect(recent.maxPlaylists).toBe(1);
    });

    it.each([[0], [51], [-3], [2.5], ['10'], [null]])('should replace a stored cap of %s with the defaults', (cap: unknown) => {
      writeSettingsFile({ version: 2, recentItems: { maxFiles: cap, maxPlaylists: cap } });

      const recent: RecentItemsSettings = new SettingsManager().getRecentItems();

      expect(recent.maxFiles).toBe(10);
      expect(recent.maxPlaylists).toBe(5);
    });

    it('should use default recent items when the section is not an object', () => {
      writeSettingsFile({ version: 2, recentItems: 'none' });

      const recent: RecentItemsSettings = new SettingsManager().getRecentItems();

      expect(recent).toEqual({ recentFiles: [], recentPlaylists: [], maxFiles: 10, maxPlaylists: 5 });
    });

    it('should not carry recent items from one profile into another', () => {
      const first: SettingsManager = new SettingsManager();
      first.addRecentFile(songA);
      mockUserDataPath = path.join(mockUserDataPath, 'second-profile');
      createTempDir();

      const second: SettingsManager = new SettingsManager();

      expect(second.getRecentItems().recentFiles).toEqual([]);
    });
  });

  // ===========================================================================
  // Loading damaged or unexpected settings files
  // ===========================================================================

  describe('loading damaged settings files', () => {
    /** The settings a fresh install starts with. */
    function defaultSettings(): AppSettings {
      const directory: string = path.join(mockUserDataPath, 'pristine');
      const original: string = mockUserDataPath;
      fs.mkdirSync(directory, { recursive: true });
      mockUserDataPath = directory;
      try {
        return new SettingsManager().getSettings();
      } finally {
        mockUserDataPath = original;
      }
    }

    it.each([
      ['an empty file', ''],
      ['a file truncated mid-write', '{\n  "version": 2,\n  "playback": {\n    "defaultVolume": 0.'],
      ['a bare number', '42'],
      ['a boolean', 'false'],
      ['binary rubbish', '\u0000\u0001\u0002'],
    ])('should fall back to defaults for %s', (_description: string, contents: string) => {
      fs.writeFileSync(settingsFilePath(), contents, 'utf-8');

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings).toEqual(defaultSettings());
    });

    it('should fall back to defaults when the file holds a JSON array', () => {
      fs.writeFileSync(settingsFilePath(), '[1, 2, 3]', 'utf-8');

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings).toEqual(defaultSettings());
    });

    it('should log the failure when the file cannot be parsed', () => {
      fs.writeFileSync(settingsFilePath(), '{"version": 2,', 'utf-8');
      mockedLoggerError.mockClear();

      new SettingsManager();

      expect(mockedLoggerError).toHaveBeenCalledWith(expect.stringContaining('Failed to load settings'));
    });

    it('should fall back to defaults when the settings path cannot be read as a file', () => {
      fs.mkdirSync(settingsFilePath());
      mockedLoggerError.mockClear();

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.playback.defaultVolume).toBe(0.5);
      expect(mockedLoggerError).toHaveBeenCalledWith(expect.stringContaining('Failed to load settings'));
    });

    it('should use defaults for each section that has the wrong type and keep the valid ones', () => {
      writeSettingsFile({
        version: 2,
        visualization: 'water',
        application: 8080,
        playback: { defaultVolume: 0.9 },
        transcoding: true,
        appearance: 'dark',
        subtitles: 12,
        windowState: 'left',
      });
      const defaults: AppSettings = defaultSettings();

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings).toEqual({ ...defaults, playback: { ...defaults.playback, defaultVolume: 0.9 } });
    });

    it('should treat a section stored as null like a missing section', () => {
      writeSettingsFile({ version: 2, visualization: null, playback: null, recentItems: null });

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings).toEqual(defaultSettings());
    });

    it('should ignore a stale temporary file left by an interrupted save', () => {
      writeSettingsFile({ version: 2, playback: { defaultVolume: 0.2 } });
      fs.writeFileSync(tempSettingsFilePath(), '{"version": 2, "playback": {"defaultVol', 'utf-8');

      const settings: AppSettings = new SettingsManager().getSettings();

      expect(settings.playback.defaultVolume).toBe(0.2);
    });

    it('should replace a stale temporary file on the next save', () => {
      fs.writeFileSync(tempSettingsFilePath(), 'half-written', 'utf-8');
      const manager: SettingsManager = new SettingsManager();

      manager.updatePlaybackSettings({ defaultVolume: 0.3 });
      manager.flush();

      expect(fs.existsSync(tempSettingsFilePath())).toBe(false);
      expect(readSettingsFile().playback.defaultVolume).toBe(0.3);
    });

    it('should overwrite a corrupt file with valid settings on the next save', () => {
      fs.writeFileSync(settingsFilePath(), '{{{not valid json!!!', 'utf-8');
      const manager: SettingsManager = new SettingsManager();

      manager.updateTranscodingSettings({ audioBitrate: 256 });
      manager.flush();

      expect(readSettingsFile().transcoding.audioBitrate).toBe(256);
    });

    it('should write every settings category to disk', () => {
      const manager: SettingsManager = new SettingsManager();

      manager.updatePlaybackSettings({ defaultVolume: 0.6 });
      manager.flush();

      expect(Object.keys(readSettingsFile()).sort()).toEqual([
        'appearance', 'application', 'equalizer', 'playback', 'recentItems', 'subtitles',
        'transcoding', 'version', 'videoAdjustments', 'visualization', 'windowState',
      ]);
    });

    it('should not let changes in one manager leak into the defaults another one starts with', () => {
      const first: SettingsManager = new SettingsManager();
      first.updatePlaybackSettings({ defaultVolume: 0.9 });
      first.updateEqualizerSettings({ enabled: true, bands: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });

      const fresh: AppSettings = defaultSettings();

      expect(fresh.playback.defaultVolume).toBe(0.5);
      expect(fresh.equalizer).toEqual({ enabled: false, preset: 'flat', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    });
  });

  // ===========================================================================
  // Miniplayer bounds from disk
  // ===========================================================================

  describe('miniplayer bounds persistence', () => {
    it('should persist miniplayer bounds across a reload', () => {
      const bounds: WindowBounds = { x: -1200, y: 40, width: 360, height: 220 };
      const first: SettingsManager = new SettingsManager();
      first.setMiniplayerBounds(bounds);
      first.flush();

      const second: SettingsManager = new SettingsManager();

      expect(second.getMiniplayerBounds()).toEqual(bounds);
    });

    it('should persist cleared miniplayer bounds across a reload', () => {
      const first: SettingsManager = new SettingsManager();
      first.setMiniplayerBounds({ x: 10, y: 10, width: 320, height: 200 });
      first.flush();
      first.setMiniplayerBounds(null);
      first.flush();

      const second: SettingsManager = new SettingsManager();

      expect(second.getMiniplayerBounds()).toBeNull();
    });

    it('should keep the previous bounds when invalid bounds are supplied', () => {
      const bounds: WindowBounds = { x: 10, y: 20, width: 320, height: 200 };
      const manager: SettingsManager = new SettingsManager();
      manager.setMiniplayerBounds(bounds);

      manager.setMiniplayerBounds({ x: 0, y: 0, width: 0, height: 0 });

      expect(manager.getMiniplayerBounds()).toEqual(bounds);
    });

    it.each([
      ['a string', '100,100,320,200'],
      ['an array', [100, 100, 320, 200]],
      ['bounds with string numbers', { x: '10', y: '10', width: '320', height: '200' }],
      ['bounds with a zero size', { x: 10, y: 10, width: 0, height: 200 }],
      ['bounds missing a position', { width: 320, height: 200 }],
    ])('should ignore stored miniplayer bounds that are %s', (_description: string, stored: unknown) => {
      writeSettingsFile({ version: 2, windowState: { miniplayerBounds: stored } });

      const manager: SettingsManager = new SettingsManager();

      expect(manager.getMiniplayerBounds()).toBeNull();
    });
  });

  // ===========================================================================
  // Debounced saving and flush
  // ===========================================================================

  describe('debounced saving', () => {
    const SAVE_DELAY_MS: number = 250;

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should not write to disk until the save delay has passed', () => {
      const manager: SettingsManager = new SettingsManager();

      manager.updatePlaybackSettings({ defaultVolume: 0.7 });
      vi.advanceTimersByTime(SAVE_DELAY_MS - 1);

      expect(fs.existsSync(settingsFilePath())).toBe(false);
    });

    it('should write to disk once the save delay has passed', () => {
      const manager: SettingsManager = new SettingsManager();

      manager.updatePlaybackSettings({ defaultVolume: 0.7 });
      vi.advanceTimersByTime(SAVE_DELAY_MS);

      expect(readSettingsFile().playback.defaultVolume).toBe(0.7);
    });

    it('should include every change made during the delay in the one write', () => {
      const manager: SettingsManager = new SettingsManager();

      manager.updatePlaybackSettings({ defaultVolume: 0.1 });
      vi.advanceTimersByTime(100);
      manager.updatePlaybackSettings({ defaultVolume: 0.2 });
      manager.updateTranscodingSettings({ audioBitrate: 320 });
      vi.advanceTimersByTime(SAVE_DELAY_MS - 100);

      const saved: AppSettings = readSettingsFile();
      expect(saved.playback.defaultVolume).toBe(0.2);
      expect(saved.transcoding.audioBitrate).toBe(320);
    });

    it('should save a change made after an earlier write completed', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updatePlaybackSettings({ defaultVolume: 0.1 });
      vi.advanceTimersByTime(SAVE_DELAY_MS);

      manager.updatePlaybackSettings({ defaultVolume: 0.8 });
      vi.advanceTimersByTime(SAVE_DELAY_MS);

      expect(readSettingsFile().playback.defaultVolume).toBe(0.8);
    });

    it('should write a pending change immediately on flush', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updateApplicationSettings({ serverPort: 5555 });

      manager.flush();

      expect(readSettingsFile().application.serverPort).toBe(5555);
    });

    it('should not write again after flush once the original delay passes', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updateApplicationSettings({ serverPort: 5555 });
      manager.flush();
      fs.rmSync(settingsFilePath());

      vi.advanceTimersByTime(SAVE_DELAY_MS * 2);

      expect(fs.existsSync(settingsFilePath())).toBe(false);
    });

    it('should write nothing on flush when no change is pending', () => {
      const manager: SettingsManager = new SettingsManager();

      manager.flush();

      expect(fs.existsSync(settingsFilePath())).toBe(false);
    });

    it('should not schedule a write for a rejected update', () => {
      const manager: SettingsManager = new SettingsManager();

      manager.updatePlaybackSettings({ defaultVolume: 7 });
      vi.advanceTimersByTime(SAVE_DELAY_MS);

      expect(fs.existsSync(settingsFilePath())).toBe(false);
    });

    it('should not create a settings file just by loading defaults', () => {
      new SettingsManager();

      vi.advanceTimersByTime(SAVE_DELAY_MS);

      expect(fs.existsSync(settingsFilePath())).toBe(false);
    });
  });

  // ===========================================================================
  // Failed saves
  // ===========================================================================

  describe('failed saves', () => {
    it('should not throw when the user data directory has disappeared', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updatePlaybackSettings({ defaultVolume: 0.9 });
      removeTempDir();

      expect((): void => manager.flush()).not.toThrow();
    });

    it('should log a failed save', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updatePlaybackSettings({ defaultVolume: 0.9 });
      removeTempDir();
      mockedLoggerError.mockClear();

      manager.flush();

      expect(mockedLoggerError).toHaveBeenCalledWith(expect.stringContaining('Failed to save settings'));
    });

    it('should keep the change in memory when the save fails', () => {
      const manager: SettingsManager = new SettingsManager();
      manager.updatePlaybackSettings({ defaultVolume: 0.9 });
      removeTempDir();

      manager.flush();

      expect(manager.getSettings().playback.defaultVolume).toBe(0.9);
    });

    it('should remove the temporary file when it cannot be moved into place', () => {
      // A directory at the destination makes the rename fail after the temp file is written.
      fs.mkdirSync(settingsFilePath());
      const manager: SettingsManager = new SettingsManager();
      manager.updatePlaybackSettings({ defaultVolume: 0.9 });
      mockedLoggerError.mockClear();

      manager.flush();

      expect(fs.existsSync(tempSettingsFilePath())).toBe(false);
      expect(mockedLoggerError).toHaveBeenCalledWith(expect.stringContaining('Failed to save settings'));
    });

    it('should not throw when the temporary file can be neither written nor cleaned up', () => {
      // A directory at the temp path fails both the write and the unlink.
      fs.mkdirSync(tempSettingsFilePath());
      const manager: SettingsManager = new SettingsManager();
      manager.updatePlaybackSettings({ defaultVolume: 0.9 });

      expect((): void => manager.flush()).not.toThrow();
      expect(fs.existsSync(settingsFilePath())).toBe(false);
    });

    it('should leave the previous settings file intact when a save fails', () => {
      writeSettingsFile({ version: 2, playback: { defaultVolume: 0.2 } });
      fs.mkdirSync(tempSettingsFilePath());
      const manager: SettingsManager = new SettingsManager();
      manager.updatePlaybackSettings({ defaultVolume: 0.9 });

      manager.flush();

      expect(readSettingsFile().playback.defaultVolume).toBe(0.2);
    });

    it('should save successfully again once the obstruction is gone', () => {
      fs.mkdirSync(tempSettingsFilePath());
      const manager: SettingsManager = new SettingsManager();
      manager.updatePlaybackSettings({ defaultVolume: 0.9 });
      manager.flush();
      fs.rmSync(tempSettingsFilePath(), { recursive: true, force: true });

      manager.updatePlaybackSettings({ skipDuration: 30 });
      manager.flush();

      const saved: AppSettings = readSettingsFile();
      expect(saved.playback.defaultVolume).toBe(0.9);
      expect(saved.playback.skipDuration).toBe(30);
    });
  });

  // ===========================================================================
  // Platform-specific defaults
  // ===========================================================================

  describe('platform-specific defaults', () => {
    /** Loads a fresh copy of the module as it would initialise on the given platform. */
    async function createManagerOn(platform: NodeJS.Platform): Promise<SettingsManager> {
      stubPlatform(platform);
      vi.resetModules();
      const freshModule: typeof import('./settings-manager.js') = await import('./settings-manager.js');
      return new freshModule.SettingsManager();
    }

    afterEach(() => {
      restorePlatform();
      vi.resetModules();
    });

    it('should disable glass by default on Windows', async () => {
      const manager: SettingsManager = await createManagerOn('win32');

      expect(manager.getSettings().appearance.glassEnabled).toBe(false);
    });

    it.each([['darwin'], ['linux']] as const)('should enable glass by default on %s', async (platform: NodeJS.Platform) => {
      const manager: SettingsManager = await createManagerOn(platform);

      expect(manager.getSettings().appearance.glassEnabled).toBe(true);
    });

    it('should use the Windows glass default when the file has an appearance section without it', async () => {
      writeSettingsFile({ version: 2, appearance: { colorScheme: 'dark' } });

      const manager: SettingsManager = await createManagerOn('win32');

      expect(manager.getSettings().appearance.glassEnabled).toBe(false);
      expect(manager.getSettings().appearance.colorScheme).toBe('dark');
    });

    it('should honour glass enabled in the file on Windows', async () => {
      writeSettingsFile({ version: 2, appearance: { glassEnabled: true } });

      const manager: SettingsManager = await createManagerOn('win32');

      expect(manager.getSettings().appearance.glassEnabled).toBe(true);
    });

    it('should use the same non-appearance defaults on every platform', async () => {
      const onWindows: AppSettings = (await createManagerOn('win32')).getSettings();
      const onLinux: AppSettings = (await createManagerOn('linux')).getSettings();

      expect({ ...onWindows, appearance: null }).toEqual({ ...onLinux, appearance: null });
    });
  });
});

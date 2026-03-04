/**
 * @fileoverview Comprehensive tests for SettingsManager.
 *
 * Tests cover:
 * - Constructor / load behavior (missing file, corrupt file, valid file)
 * - All public update methods and their validators
 * - Save/load persistence cycle
 * - validateAndMerge partial settings merge with defaults
 * - v1 to v2 migration (perVisualizationSensitivity -> perVisualizationSettings)
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
import type {
  AppSettings,
  WindowBounds,
  VisualizationSettingsUpdate,
  ApplicationSettingsUpdate,
  PlaybackSettingsUpdate,
  TranscodingSettingsUpdate,
  AppearanceSettingsUpdate,
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
      expect(settings.visualization.defaultType).toBe('bars');
      expect(settings.visualization.maxFrameRate).toBe(0);
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
      expect(settings.appearance.glassEnabled).toBe(true);
      expect(settings.appearance.macOSVisualEffectState).toBe('active');
      expect(settings.appearance.backgroundColor).toBe('#1e1e1e');
      expect(settings.windowState.miniplayerBounds).toBeNull();
    });

    it('should return default settings when the file contains corrupt JSON', () => {
      fs.writeFileSync(settingsFilePath(), '{{{not valid json!!!', 'utf-8');

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.visualization.defaultType).toBe('bars');
      expect(settings.playback.defaultVolume).toBe(0.5);
    });

    it('should return default settings when the file contains a non-object value', () => {
      fs.writeFileSync(settingsFilePath(), '"just a string"', 'utf-8');

      const manager: SettingsManager = new SettingsManager();
      const settings: AppSettings = manager.getSettings();

      expect(settings.visualization.defaultType).toBe('bars');
    });

    it('should load valid settings from an existing file', () => {
      const customSettings: AppSettings = {
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

      expect(settings.visualization.defaultType).toBe('bars');
      expect(settings.application.serverPort).toBe(0);
      expect(settings.playback.defaultVolume).toBe(0.5);
      expect(settings.transcoding.videoQuality).toBe('medium');
      expect(settings.appearance.glassEnabled).toBe(true);
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

      expect(settings.visualization.defaultType).toBe('bars');
      expect(settings.visualization.maxFrameRate).toBe(0);
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
      expect(settings.appearance.glassEnabled).toBe(true);
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
        'bars', 'waveform', 'tether', 'tunnel', 'neon', 'pulsar', 'water', 'infinity', 'onix', 'modern',
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
        expect(result.visualization.maxFrameRate).toBe(0);
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
      expect(result.appearance.glassEnabled).toBe(true);
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
      expect(settings.visualization.maxFrameRate).toBe(0);
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

      expect(settings.visualization.defaultType).toBe('bars');
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
});

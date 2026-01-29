import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {ElectronService} from './electron.service';
import {
  SettingsService,
  AppSettings,
  FftSize,
  VideoQuality,
  AudioBitrate,
  VideoAspectMode,
  MacOSVisualEffectState,
  VisualizationLocalSettings,
  VisualizationMetadata,
} from './settings.service';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock ElectronService with the minimum surface required by SettingsService.
 */
function createMockElectronService(): {
  serverUrl: ReturnType<typeof signal<string>>;
  onSettingsUpdate: ReturnType<typeof vi.fn>;
  onDependencyStateUpdate: ReturnType<typeof vi.fn>;
  onDependencyProgressUpdate: ReturnType<typeof vi.fn>;
} {
  return {
    serverUrl: signal('http://127.0.0.1:12345'),
    onSettingsUpdate: vi.fn(),
    onDependencyStateUpdate: vi.fn(),
    onDependencyProgressUpdate: vi.fn(),
  };
}

/**
 * Creates a complete AppSettings object with optional overrides.
 */
function createTestSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  const base: AppSettings = {
    version: 2,
    visualization: {
      defaultType: 'bars',
      maxFrameRate: 0,
      fftSize: 2048,
      perVisualizationSettings: {},
    },
    application: {
      serverPort: 0,
      controlsAutoHideDelay: 5,
    },
    playback: {
      defaultVolume: 0.5,
      crossfadeDuration: 100,
      previousTrackThreshold: 3,
      skipDuration: 10,
      videoAspectMode: 'default',
      preferredAudioLanguage: 'eng',
      preferredSubtitleLanguage: 'off',
    },
    transcoding: {
      videoQuality: 'medium',
      audioBitrate: 192,
    },
    appearance: {
      glassEnabled: true,
      macOSVisualEffectState: 'active',
      backgroundColor: '#1e1e1e',
      backgroundHue: 0,
      backgroundSaturation: 0,
      backgroundLightness: 12,
      windowTintHue: 0,
      windowTintSaturation: 0,
      windowTintLightness: 0,
      windowTintAlpha: 0,
      colorScheme: 'system',
    },
    subtitles: {
      fontSize: 100,
      fontColor: '#ffffff',
      backgroundColor: '#000000',
      backgroundOpacity: 0.75,
      fontFamily: 'sans-serif',
      textShadow: true,
      shadowSpread: 2,
      shadowBlur: 2,
      shadowColor: '#000000',
    },
  };

  return {...base, ...overrides};
}

/**
 * Creates a mock Response for fetch calls.
 */
function createMockResponse(ok: boolean = true, body: unknown = {}): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: (): Promise<unknown> => Promise.resolve(body),
  } as Response;
}

// ============================================================================
// Tests
// ============================================================================

describe('SettingsService', (): void => {
  let service: SettingsService;
  let mockElectron: ReturnType<typeof createMockElectronService>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach((): void => {
    mockElectron = createMockElectronService();

    // Mock global fetch to prevent real HTTP calls
    fetchSpy = vi.fn().mockResolvedValue(createMockResponse(true, createTestSettings()));
    vi.stubGlobal('fetch', fetchSpy);

    TestBed.configureTestingModule({
      providers: [
        SettingsService,
        {provide: ElectronService, useValue: mockElectron},
      ],
    });

    service = TestBed.inject(SettingsService);
  });

  afterEach((): void => {
    vi.restoreAllMocks();
  });

  // ============================================================================
  // Computed Signals
  // ============================================================================

  describe('computed signals', (): void => {
    it('defaultVisualization reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        visualization: {defaultType: 'waveform', maxFrameRate: 0, fftSize: 2048, perVisualizationSettings: {}},
      });
      service.updateFromSSE(testSettings);

      const result: string = service.defaultVisualization();
      expect(result).toBe('waveform');
    });

    it('maxFrameRate reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        visualization: {defaultType: 'bars', maxFrameRate: 60, fftSize: 2048, perVisualizationSettings: {}},
      });
      service.updateFromSSE(testSettings);

      const result: number = service.maxFrameRate();
      expect(result).toBe(60);
    });

    it('fftSize reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        visualization: {defaultType: 'bars', maxFrameRate: 0, fftSize: 4096, perVisualizationSettings: {}},
      });
      service.updateFromSSE(testSettings);

      const result: FftSize = service.fftSize();
      expect(result).toBe(4096);
    });

    it('serverPort reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        application: {serverPort: 8080, controlsAutoHideDelay: 5},
      });
      service.updateFromSSE(testSettings);

      const result: number = service.serverPort();
      expect(result).toBe(8080);
    });

    it('controlsAutoHideDelay reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        application: {serverPort: 0, controlsAutoHideDelay: 10},
      });
      service.updateFromSSE(testSettings);

      const result: number = service.controlsAutoHideDelay();
      expect(result).toBe(10);
    });

    it('defaultVolume reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        playback: {defaultVolume: 0.8, crossfadeDuration: 100, previousTrackThreshold: 3, skipDuration: 10, videoAspectMode: 'default', preferredAudioLanguage: 'eng', preferredSubtitleLanguage: 'off'},
      });
      service.updateFromSSE(testSettings);

      const result: number = service.defaultVolume();
      expect(result).toBe(0.8);
    });

    it('crossfadeDuration reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        playback: {defaultVolume: 0.5, crossfadeDuration: 250, previousTrackThreshold: 3, skipDuration: 10, videoAspectMode: 'default', preferredAudioLanguage: 'eng', preferredSubtitleLanguage: 'off'},
      });
      service.updateFromSSE(testSettings);

      const result: number = service.crossfadeDuration();
      expect(result).toBe(250);
    });

    it('videoAspectMode reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        playback: {defaultVolume: 0.5, crossfadeDuration: 100, previousTrackThreshold: 3, skipDuration: 10, videoAspectMode: '16:9', preferredAudioLanguage: 'eng', preferredSubtitleLanguage: 'off'},
      });
      service.updateFromSSE(testSettings);

      const result: VideoAspectMode = service.videoAspectMode();
      expect(result).toBe('16:9');
    });

    it('videoQuality reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        transcoding: {videoQuality: 'high', audioBitrate: 192},
      });
      service.updateFromSSE(testSettings);

      const result: VideoQuality = service.videoQuality();
      expect(result).toBe('high');
    });

    it('audioBitrate reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        transcoding: {videoQuality: 'medium', audioBitrate: 320},
      });
      service.updateFromSSE(testSettings);

      const result: AudioBitrate = service.audioBitrate();
      expect(result).toBe(320);
    });

    it('glassEnabled reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        appearance: {glassEnabled: false, macOSVisualEffectState: 'active', backgroundColor: '#1e1e1e', backgroundHue: 0, backgroundSaturation: 0, backgroundLightness: 12, windowTintHue: 0, windowTintSaturation: 0, windowTintLightness: 0, windowTintAlpha: 0, colorScheme: 'system'},
      });
      service.updateFromSSE(testSettings);

      const result: boolean = service.glassEnabled();
      expect(result).toBe(false);
    });

    it('macOSVisualEffectState reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        appearance: {glassEnabled: true, macOSVisualEffectState: 'followWindow', backgroundColor: '#1e1e1e', backgroundHue: 0, backgroundSaturation: 0, backgroundLightness: 12, windowTintHue: 0, windowTintSaturation: 0, windowTintLightness: 0, windowTintAlpha: 0, colorScheme: 'system'},
      });
      service.updateFromSSE(testSettings);

      const result: MacOSVisualEffectState = service.macOSVisualEffectState();
      expect(result).toBe('followWindow');
    });

    it('backgroundColor reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        appearance: {glassEnabled: true, macOSVisualEffectState: 'active', backgroundColor: '#ff0000', backgroundHue: 0, backgroundSaturation: 0, backgroundLightness: 12, windowTintHue: 0, windowTintSaturation: 0, windowTintLightness: 0, windowTintAlpha: 0, colorScheme: 'system'},
      });
      service.updateFromSSE(testSettings);

      const result: string = service.backgroundColor();
      expect(result).toBe('#ff0000');
    });
  });

  // ============================================================================
  // updateFromSSE
  // ============================================================================

  describe('updateFromSSE', (): void => {
    it('updates settings signal', (): void => {
      const testSettings: AppSettings = createTestSettings({
        visualization: {defaultType: 'tunnel', maxFrameRate: 30, fftSize: 1024, perVisualizationSettings: {}},
      });

      service.updateFromSSE(testSettings);

      const result: AppSettings = service.settings();
      expect(result.visualization.defaultType).toBe('tunnel');
      expect(result.visualization.maxFrameRate).toBe(30);
      expect(result.visualization.fftSize).toBe(1024);
    });

    it('sets isLoaded to true', (): void => {
      const testSettings: AppSettings = createTestSettings();

      service.updateFromSSE(testSettings);

      const result: boolean = service.isLoaded();
      expect(result).toBe(true);
    });
  });

  // ============================================================================
  // getEffectiveSetting
  // ============================================================================

  describe('getEffectiveSetting', (): void => {
    it('returns custom value when set', (): void => {
      const customSensitivity: number = 0.8;
      const testSettings: AppSettings = createTestSettings({
        visualization: {
          defaultType: 'bars',
          maxFrameRate: 0,
          fftSize: 2048,
          perVisualizationSettings: {
            bars: {sensitivity: customSensitivity},
          },
        },
      });
      service.updateFromSSE(testSettings);

      const result: number | undefined = service.getEffectiveSetting('bars', 'sensitivity');
      expect(result).toBe(customSensitivity);
    });

    it('returns default when not customized', (): void => {
      const testSettings: AppSettings = createTestSettings({
        visualization: {
          defaultType: 'bars',
          maxFrameRate: 0,
          fftSize: 2048,
          perVisualizationSettings: {},
        },
      });
      service.updateFromSSE(testSettings);

      const result: number | undefined = service.getEffectiveSetting('bars', 'sensitivity');
      expect(result).toBe(0.5); // VISUALIZATION_LOCAL_DEFAULTS.sensitivity
    });

    it('returns default for unknown visualization', (): void => {
      const testSettings: AppSettings = createTestSettings({
        visualization: {
          defaultType: 'bars',
          maxFrameRate: 0,
          fftSize: 2048,
          perVisualizationSettings: {},
        },
      });
      service.updateFromSSE(testSettings);

      const result: number | undefined = service.getEffectiveSetting('nonexistent', 'sensitivity');
      expect(result).toBe(0.5); // VISUALIZATION_LOCAL_DEFAULTS.sensitivity
    });
  });

  // ============================================================================
  // hasCustomSetting
  // ============================================================================

  describe('hasCustomSetting', (): void => {
    it('returns true when customized', (): void => {
      const testSettings: AppSettings = createTestSettings({
        visualization: {
          defaultType: 'bars',
          maxFrameRate: 0,
          fftSize: 2048,
          perVisualizationSettings: {
            bars: {sensitivity: 0.9},
          },
        },
      });
      service.updateFromSSE(testSettings);

      const result: boolean = service.hasCustomSetting('bars', 'sensitivity');
      expect(result).toBe(true);
    });

    it('returns false when not customized', (): void => {
      const testSettings: AppSettings = createTestSettings({
        visualization: {
          defaultType: 'bars',
          maxFrameRate: 0,
          fftSize: 2048,
          perVisualizationSettings: {},
        },
      });
      service.updateFromSSE(testSettings);

      const result: boolean = service.hasCustomSetting('bars', 'sensitivity');
      expect(result).toBe(false);
    });
  });

  // ============================================================================
  // hasApplicableSetting
  // ============================================================================

  describe('hasApplicableSetting', (): void => {
    it('returns true for applicable setting', (): void => {
      // 'bars' visualization has 'sensitivity' in its applicableSettings
      const result: boolean = service.hasApplicableSetting('bars', 'sensitivity');
      expect(result).toBe(true);
    });

    it('returns false for non-applicable setting', (): void => {
      // 'bars' visualization does not have 'lineWidth' in its applicableSettings
      const result: boolean = service.hasApplicableSetting('bars', 'lineWidth');
      expect(result).toBe(false);
    });

    it('returns false for unknown visualization', (): void => {
      const result: boolean = service.hasApplicableSetting('nonexistent', 'sensitivity');
      expect(result).toBe(false);
    });
  });

  // ============================================================================
  // getVisualizationMetadata
  // ============================================================================

  describe('getVisualizationMetadata', (): void => {
    it('returns metadata for known visualization', (): void => {
      const result: VisualizationMetadata | undefined = service.getVisualizationMetadata('bars');

      expect(result).toBeDefined();
      expect(result!.id).toBe('bars');
      expect(result!.name).toBe('Analyzer');
      expect(result!.category).toBe('Bars');
      expect(result!.applicableSettings).toContain('sensitivity');
      expect(result!.applicableSettings).toContain('barDensity');
    });

    it('returns undefined for unknown visualization', (): void => {
      const result: VisualizationMetadata | undefined = service.getVisualizationMetadata('nonexistent');
      expect(result).toBeUndefined();
    });
  });

  // ============================================================================
  // Setter Methods
  // ============================================================================

  describe('setter methods', (): void => {
    it('setDefaultVisualization calls fetch with correct body', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(true));

      await service.setDefaultVisualization('waveform');

      const lastCall: [string, RequestInit] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
      expect(lastCall[0]).toBe('http://127.0.0.1:12345/settings/visualization');
      expect(lastCall[1].method).toBe('PUT');

      const body: Record<string, unknown> = JSON.parse(lastCall[1].body as string) as Record<string, unknown>;
      expect(body['defaultType']).toBe('waveform');
    });

    it('setMaxFrameRate validates fps values', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(true));

      // Valid value: 60
      await service.setMaxFrameRate(60);
      const validCall: [string, RequestInit] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
      const validBody: Record<string, unknown> = JSON.parse(validCall[1].body as string) as Record<string, unknown>;
      expect(validBody['maxFrameRate']).toBe(60);

      // Invalid value: 45 (not in [0, 15, 30, 60]) should default to 0
      await service.setMaxFrameRate(45);
      const invalidCall: [string, RequestInit] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
      const invalidBody: Record<string, unknown> = JSON.parse(invalidCall[1].body as string) as Record<string, unknown>;
      expect(invalidBody['maxFrameRate']).toBe(0);
    });

    it('setFftSize rejects invalid sizes', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(true));
      const errorSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(console, 'error').mockImplementation((): void => {});
      const callCountBefore: number = fetchSpy.mock.calls.length;

      await service.setFftSize(128 as FftSize);

      // fetch should NOT have been called for the invalid size
      const callCountAfter: number = fetchSpy.mock.calls.length;
      expect(callCountAfter).toBe(callCountBefore);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid FFT size'));

      errorSpy.mockRestore();
    });

    it('setServerPort clamps to valid range', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(true));

      // Port 0 stays as 0 (auto-assign)
      await service.setServerPort(0);
      const zeroCall: [string, RequestInit] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
      const zeroBody: Record<string, unknown> = JSON.parse(zeroCall[1].body as string) as Record<string, unknown>;
      expect(zeroBody['serverPort']).toBe(0);

      // Port below 1024 clamps to 1024
      await service.setServerPort(80);
      const lowCall: [string, RequestInit] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
      const lowBody: Record<string, unknown> = JSON.parse(lowCall[1].body as string) as Record<string, unknown>;
      expect(lowBody['serverPort']).toBe(1024);

      // Port above 65535 clamps to 65535
      await service.setServerPort(70000);
      const highCall: [string, RequestInit] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
      const highBody: Record<string, unknown> = JSON.parse(highCall[1].body as string) as Record<string, unknown>;
      expect(highBody['serverPort']).toBe(65535);
    });

    it('setDefaultVolume clamps to 0-1', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(true));

      // Value below 0 clamps to 0
      await service.setDefaultVolume(-0.5);
      const lowCall: [string, RequestInit] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
      const lowBody: Record<string, unknown> = JSON.parse(lowCall[1].body as string) as Record<string, unknown>;
      expect(lowBody['defaultVolume']).toBe(0);

      // Value above 1 clamps to 1
      await service.setDefaultVolume(1.5);
      const highCall: [string, RequestInit] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
      const highBody: Record<string, unknown> = JSON.parse(highCall[1].body as string) as Record<string, unknown>;
      expect(highBody['defaultVolume']).toBe(1);
    });

    it('setVideoQuality rejects invalid quality', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(true));
      const errorSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(console, 'error').mockImplementation((): void => {});
      const callCountBefore: number = fetchSpy.mock.calls.length;

      await service.setVideoQuality('ultra' as VideoQuality);

      const callCountAfter: number = fetchSpy.mock.calls.length;
      expect(callCountAfter).toBe(callCountBefore);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid video quality'));

      errorSpy.mockRestore();
    });

    it('setAudioBitrate rejects invalid bitrate', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(true));
      const errorSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(console, 'error').mockImplementation((): void => {});
      const callCountBefore: number = fetchSpy.mock.calls.length;

      await service.setAudioBitrate(96 as AudioBitrate);

      const callCountAfter: number = fetchSpy.mock.calls.length;
      expect(callCountAfter).toBe(callCountBefore);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid audio bitrate'));

      errorSpy.mockRestore();
    });

    it('setVideoAspectMode rejects invalid mode', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(true));
      const errorSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(console, 'error').mockImplementation((): void => {});
      const callCountBefore: number = fetchSpy.mock.calls.length;

      await service.setVideoAspectMode('stretch' as VideoAspectMode);

      const callCountAfter: number = fetchSpy.mock.calls.length;
      expect(callCountAfter).toBe(callCountBefore);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid video aspect mode'));

      errorSpy.mockRestore();
    });

    it('setBackgroundColor rejects invalid hex', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(true));
      const errorSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(console, 'error').mockImplementation((): void => {});
      const callCountBefore: number = fetchSpy.mock.calls.length;

      await service.setBackgroundColor('not-a-color');

      const callCountAfter: number = fetchSpy.mock.calls.length;
      expect(callCountAfter).toBe(callCountBefore);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid hex color'));

      errorSpy.mockRestore();
    });

    it('setMacOSVisualEffectState rejects invalid state', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(true));
      const errorSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(console, 'error').mockImplementation((): void => {});
      const callCountBefore: number = fetchSpy.mock.calls.length;

      await service.setMacOSVisualEffectState('invalid' as MacOSVisualEffectState);

      const callCountAfter: number = fetchSpy.mock.calls.length;
      expect(callCountAfter).toBe(callCountBefore);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid macOS visual effect state'));

      errorSpy.mockRestore();
    });
  });

  // ============================================================================
  // setVisualizationSetting
  // ============================================================================

  describe('setVisualizationSetting', (): void => {
    it('clamps sensitivity to 0-1', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(true));

      // Value above 1 should clamp to 1
      await service.setVisualizationSetting('bars', 'sensitivity', 2.0);
      const highCall: [string, RequestInit] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
      const highBody: Record<string, unknown> = JSON.parse(highCall[1].body as string) as Record<string, unknown>;
      const highVizSettings: Record<string, VisualizationLocalSettings> = highBody['perVisualizationSettings'] as Record<string, VisualizationLocalSettings>;
      expect(highVizSettings['bars'].sensitivity).toBe(1);

      // Value below 0 should clamp to 0
      await service.setVisualizationSetting('bars', 'sensitivity', -0.5);
      const lowCall: [string, RequestInit] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
      const lowBody: Record<string, unknown> = JSON.parse(lowCall[1].body as string) as Record<string, unknown>;
      const lowVizSettings: Record<string, VisualizationLocalSettings> = lowBody['perVisualizationSettings'] as Record<string, VisualizationLocalSettings>;
      expect(lowVizSettings['bars'].sensitivity).toBe(0);
    });

    it('clamps lineWidth to 1-5', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(true));

      // Value above 5 should clamp to 5
      await service.setVisualizationSetting('waveform', 'lineWidth', 10.0);
      const highCall: [string, RequestInit] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
      const highBody: Record<string, unknown> = JSON.parse(highCall[1].body as string) as Record<string, unknown>;
      const highVizSettings: Record<string, VisualizationLocalSettings> = highBody['perVisualizationSettings'] as Record<string, VisualizationLocalSettings>;
      expect(highVizSettings['waveform'].lineWidth).toBe(5);

      // Value below 1 should clamp to 1
      await service.setVisualizationSetting('waveform', 'lineWidth', 0.1);
      const lowCall: [string, RequestInit] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
      const lowBody: Record<string, unknown> = JSON.parse(lowCall[1].body as string) as Record<string, unknown>;
      const lowVizSettings: Record<string, VisualizationLocalSettings> = lowBody['perVisualizationSettings'] as Record<string, VisualizationLocalSettings>;
      expect(lowVizSettings['waveform'].lineWidth).toBe(1);
    });

    it('rejects invalid bar density', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(true));
      const errorSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(console, 'error').mockImplementation((): void => {});
      const callCountBefore: number = fetchSpy.mock.calls.length;

      await service.setVisualizationSetting('bars', 'barDensity', 'extreme' as VisualizationLocalSettings['barDensity']);

      const callCountAfter: number = fetchSpy.mock.calls.length;
      expect(callCountAfter).toBe(callCountBefore);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid bar density'));

      errorSpy.mockRestore();
    });
  });
});

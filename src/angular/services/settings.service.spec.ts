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
  RenderResolution,
  CrossfadeDuration,
  CrossfadeStyle,
  SeekMode,
  HardwareAcceleration,
  PreferredAudioLanguage,
  PreferredSubtitleLanguage,
  ColorScheme,
  SubtitleFontFamily,
  PerVisualizationSettings,
} from './settings.service';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock ElectronService with the minimum surface required by SettingsService.
 */
function createMockElectronService(): {
  serverUrl: ReturnType<typeof signal<string>>;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onSettingsUpdate: ReturnType<typeof vi.fn>;
  onDependencyStateUpdate: ReturnType<typeof vi.fn>;
  onDependencyProgressUpdate: ReturnType<typeof vi.fn>;
} {
  return {
    serverUrl: signal('http://127.0.0.1:12345'),
    // Delegates to the stubbed global fetch so tests keep asserting on it.
    authFetch: (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
    onSettingsUpdate: vi.fn().mockReturnValue((): void => {}),
    onDependencyStateUpdate: vi.fn().mockReturnValue((): void => {}),
    onDependencyProgressUpdate: vi.fn().mockReturnValue((): void => {}),
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
      renderResolution: 'native',
      perVisualizationSettings: {}, crossfadeDuration: 1000, crossfadeStyle: 'fade',
    },
    application: {
      serverPort: 0,
      controlsAutoHideDelay: 5,
      miniplayerOnFocusLoss: false,
    },
    playback: {
      defaultVolume: 0.5,
      crossfadeDuration: 100,
      previousTrackThreshold: 3,
      skipDuration: 10,
      videoAspectMode: 'default',
      preferredAudioLanguage: 'eng',
      preferredSubtitleLanguage: 'off',
      seekMode: 'drop',
    },
    transcoding: {
      videoQuality: 'medium',
      audioBitrate: 192,
      hardwareAcceleration: 'auto',
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
    equalizer: {
      enabled: false,
      preset: 'flat',
      bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
    videoAdjustments: {
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
        visualization: {defaultType: 'waveform', maxFrameRate: 0, fftSize: 2048, renderResolution: 'native', perVisualizationSettings: {}, crossfadeDuration: 1000, crossfadeStyle: 'fade'},
      });
      service.updateFromSSE(testSettings);

      const result: string = service.defaultVisualization();
      expect(result).toBe('waveform');
    });

    it('maxFrameRate reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        visualization: {defaultType: 'bars', maxFrameRate: 60, fftSize: 2048, renderResolution: 'native', perVisualizationSettings: {}, crossfadeDuration: 1000, crossfadeStyle: 'fade'},
      });
      service.updateFromSSE(testSettings);

      const result: number = service.maxFrameRate();
      expect(result).toBe(60);
    });

    it('fftSize reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        visualization: {defaultType: 'bars', maxFrameRate: 0, fftSize: 4096, renderResolution: 'native', perVisualizationSettings: {}, crossfadeDuration: 1000, crossfadeStyle: 'fade'},
      });
      service.updateFromSSE(testSettings);

      const result: FftSize = service.fftSize();
      expect(result).toBe(4096);
    });

    it('serverPort reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        application: {serverPort: 8080, controlsAutoHideDelay: 5, miniplayerOnFocusLoss: false},
      });
      service.updateFromSSE(testSettings);

      const result: number = service.serverPort();
      expect(result).toBe(8080);
    });

    it('controlsAutoHideDelay reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        application: {serverPort: 0, controlsAutoHideDelay: 10, miniplayerOnFocusLoss: false},
      });
      service.updateFromSSE(testSettings);

      const result: number = service.controlsAutoHideDelay();
      expect(result).toBe(10);
    });

    it('defaultVolume reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        playback: {defaultVolume: 0.8, crossfadeDuration: 100, previousTrackThreshold: 3, skipDuration: 10, videoAspectMode: 'default', preferredAudioLanguage: 'eng', preferredSubtitleLanguage: 'off', seekMode: 'drop'},
      });
      service.updateFromSSE(testSettings);

      const result: number = service.defaultVolume();
      expect(result).toBe(0.8);
    });

    it('crossfadeDuration reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        playback: {defaultVolume: 0.5, crossfadeDuration: 250, previousTrackThreshold: 3, skipDuration: 10, videoAspectMode: 'default', preferredAudioLanguage: 'eng', preferredSubtitleLanguage: 'off', seekMode: 'drop'},
      });
      service.updateFromSSE(testSettings);

      const result: number = service.crossfadeDuration();
      expect(result).toBe(250);
    });

    it('videoAspectMode reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        playback: {defaultVolume: 0.5, crossfadeDuration: 100, previousTrackThreshold: 3, skipDuration: 10, videoAspectMode: '16:9', preferredAudioLanguage: 'eng', preferredSubtitleLanguage: 'off', seekMode: 'drop'},
      });
      service.updateFromSSE(testSettings);

      const result: VideoAspectMode = service.videoAspectMode();
      expect(result).toBe('16:9');
    });

    it('videoQuality reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        transcoding: {videoQuality: 'high', audioBitrate: 192, hardwareAcceleration: 'auto'},
      });
      service.updateFromSSE(testSettings);

      const result: VideoQuality = service.videoQuality();
      expect(result).toBe('high');
    });

    it('audioBitrate reflects settings value', (): void => {
      const testSettings: AppSettings = createTestSettings({
        transcoding: {videoQuality: 'medium', audioBitrate: 320, hardwareAcceleration: 'auto'},
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
        visualization: {defaultType: 'tunnel', maxFrameRate: 30, fftSize: 1024, renderResolution: 'native', perVisualizationSettings: {}, crossfadeDuration: 1000, crossfadeStyle: 'fade'},
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
          renderResolution: 'native',
          perVisualizationSettings: {
            bars: {sensitivity: customSensitivity},
          }, crossfadeDuration: 1000, crossfadeStyle: 'fade',
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
          renderResolution: 'native',
          perVisualizationSettings: {}, crossfadeDuration: 1000, crossfadeStyle: 'fade',
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
          renderResolution: 'native',
          perVisualizationSettings: {}, crossfadeDuration: 1000, crossfadeStyle: 'fade',
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
          renderResolution: 'native',
          perVisualizationSettings: {
            bars: {sensitivity: 0.9},
          }, crossfadeDuration: 1000, crossfadeStyle: 'fade',
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
          renderResolution: 'native',
          perVisualizationSettings: {}, crossfadeDuration: 1000, crossfadeStyle: 'fade',
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
      // 'bars' visualization has 'barDensity' in its applicableSettings
      const result: boolean = service.hasApplicableSetting('bars', 'barDensity');
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
      expect(result!.category).toBe('Bars & Waves');
      expect(result!.applicableSettings).toContain('barDensity');
      // Sensitivity is hard-coded for the Analyzer, so it is not a panel control.
      expect(result!.applicableSettings).not.toContain('sensitivity');
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

// ============================================================================
// Persistence, validation and synchronisation
// ============================================================================

/** Base URL the fake ElectronService reports for the media server. */
const SERVER_URL: string = 'http://127.0.0.1:12345';

/** The service's trailing-edge debounce before a category is written. */
const DEBOUNCE_MS: number = 200;

/** One recorded call to the stubbed fetch. */
type FetchCall = [string, RequestInit | undefined];

/** A settings write as it reached the server. */
interface SentWrite {
  readonly url: string;
  readonly headers: HeadersInit | undefined;
  readonly body: Record<string, unknown>;
}

/** A setter call that should be persisted, and what should reach the server. */
interface PersistCase {
  readonly name: string;
  readonly act: (target: SettingsService) => Promise<void>;
  readonly category: string;
  readonly body: Record<string, unknown>;
}

/** A setter call that should be refused, and the complaint it should log. */
interface RejectCase {
  readonly name: string;
  readonly act: (target: SettingsService) => Promise<void>;
  readonly message: string;
}

/** A derived signal and the value it should report. */
interface SignalCase {
  readonly name: string;
  readonly read: (target: SettingsService) => unknown;
  readonly expected: unknown;
}

/**
 * Extracts the settings writes (PUT requests) from the stubbed fetch.
 */
function sentWrites(spy: ReturnType<typeof vi.fn>): SentWrite[] {
  return (spy.mock.calls as FetchCall[])
    .filter((call: FetchCall): boolean => call[1]?.method === 'PUT')
    .map((call: FetchCall): SentWrite => ({
      url: call[0],
      headers: call[1]?.headers,
      body: JSON.parse(call[1]?.body as string) as Record<string, unknown>,
    }));
}

/** Settings in which every value differs from the built-in default. */
const NON_DEFAULT_SETTINGS: AppSettings = createTestSettings({
  visualization: {
    defaultType: 'neon',
    maxFrameRate: 30,
    fftSize: 512,
    renderResolution: '640x360',
    crossfadeDuration: 1500,
    crossfadeStyle: 'blur',
    perVisualizationSettings: {bars: {barDensity: 'high'}},
  },
  application: {serverPort: 8080, controlsAutoHideDelay: 9, miniplayerOnFocusLoss: true},
  playback: {
    defaultVolume: 0.8,
    crossfadeDuration: 250,
    previousTrackThreshold: 7,
    skipDuration: 30,
    videoAspectMode: '4:3',
    preferredAudioLanguage: 'jpn',
    preferredSubtitleLanguage: 'ger',
    seekMode: 'drag',
  },
  transcoding: {videoQuality: 'low', audioBitrate: 320, hardwareAcceleration: 'h264_qsv'},
  appearance: {
    glassEnabled: false,
    macOSVisualEffectState: 'inactive',
    colorScheme: 'light',
    backgroundColor: '#102030',
    backgroundHue: 210,
    backgroundSaturation: 40,
    backgroundLightness: 20,
    windowTintHue: 120,
    windowTintSaturation: 30,
    windowTintLightness: 15,
    windowTintAlpha: 0.4,
  },
  subtitles: {
    fontSize: 150,
    fontColor: '#ffcc00',
    backgroundColor: '#112233',
    backgroundOpacity: 0.25,
    fontFamily: 'serif',
    textShadow: false,
    shadowSpread: 4,
    shadowBlur: 7,
    shadowColor: '#333333',
  },
  equalizer: {enabled: true, preset: 'rock', bands: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4]},
  videoAdjustments: {
    enabled: true,
    preset: 'custom',
    brightness: 10,
    contrast: -20,
    saturation: 30,
    hue: 45,
    blur: 5,
    grayscale: 60,
    sepia: 70,
    invert: true,
  },
});

/** Every derived signal, with the value NON_DEFAULT_SETTINGS should produce. */
const PUSHED_VALUE_CASES: readonly SignalCase[] = [
  {name: 'defaultVisualization', read: (s: SettingsService): unknown => s.defaultVisualization(), expected: 'neon'},
  {name: 'maxFrameRate', read: (s: SettingsService): unknown => s.maxFrameRate(), expected: 30},
  {name: 'fftSize', read: (s: SettingsService): unknown => s.fftSize(), expected: 512},
  {name: 'renderResolution', read: (s: SettingsService): unknown => s.renderResolution(), expected: '640x360'},
  {name: 'visualizationCrossfadeDuration', read: (s: SettingsService): unknown => s.visualizationCrossfadeDuration(), expected: 1500},
  {name: 'visualizationCrossfadeStyle', read: (s: SettingsService): unknown => s.visualizationCrossfadeStyle(), expected: 'blur'},
  {name: 'perVisualizationSettings', read: (s: SettingsService): unknown => s.perVisualizationSettings(), expected: {bars: {barDensity: 'high'}}},
  {name: 'serverPort', read: (s: SettingsService): unknown => s.serverPort(), expected: 8080},
  {name: 'controlsAutoHideDelay', read: (s: SettingsService): unknown => s.controlsAutoHideDelay(), expected: 9},
  {name: 'miniplayerOnFocusLoss', read: (s: SettingsService): unknown => s.miniplayerOnFocusLoss(), expected: true},
  {name: 'previousTrackThreshold', read: (s: SettingsService): unknown => s.previousTrackThreshold(), expected: 7},
  {name: 'skipDuration', read: (s: SettingsService): unknown => s.skipDuration(), expected: 30},
  {name: 'defaultVolume', read: (s: SettingsService): unknown => s.defaultVolume(), expected: 0.8},
  {name: 'crossfadeDuration', read: (s: SettingsService): unknown => s.crossfadeDuration(), expected: 250},
  {name: 'videoQuality', read: (s: SettingsService): unknown => s.videoQuality(), expected: 'low'},
  {name: 'audioBitrate', read: (s: SettingsService): unknown => s.audioBitrate(), expected: 320},
  {name: 'hardwareAcceleration', read: (s: SettingsService): unknown => s.hardwareAcceleration(), expected: 'h264_qsv'},
  {name: 'videoAspectMode', read: (s: SettingsService): unknown => s.videoAspectMode(), expected: '4:3'},
  {name: 'seekMode', read: (s: SettingsService): unknown => s.seekMode(), expected: 'drag'},
  {name: 'preferredAudioLanguage', read: (s: SettingsService): unknown => s.preferredAudioLanguage(), expected: 'jpn'},
  {name: 'preferredSubtitleLanguage', read: (s: SettingsService): unknown => s.preferredSubtitleLanguage(), expected: 'ger'},
  {name: 'glassEnabled', read: (s: SettingsService): unknown => s.glassEnabled(), expected: false},
  {name: 'macOSVisualEffectState', read: (s: SettingsService): unknown => s.macOSVisualEffectState(), expected: 'inactive'},
  {name: 'colorScheme', read: (s: SettingsService): unknown => s.colorScheme(), expected: 'light'},
  {name: 'backgroundColor', read: (s: SettingsService): unknown => s.backgroundColor(), expected: '#102030'},
  {name: 'backgroundHue', read: (s: SettingsService): unknown => s.backgroundHue(), expected: 210},
  {name: 'backgroundSaturation', read: (s: SettingsService): unknown => s.backgroundSaturation(), expected: 40},
  {name: 'backgroundLightness', read: (s: SettingsService): unknown => s.backgroundLightness(), expected: 20},
  {name: 'windowTintHue', read: (s: SettingsService): unknown => s.windowTintHue(), expected: 120},
  {name: 'windowTintSaturation', read: (s: SettingsService): unknown => s.windowTintSaturation(), expected: 30},
  {name: 'windowTintLightness', read: (s: SettingsService): unknown => s.windowTintLightness(), expected: 15},
  {name: 'windowTintAlpha', read: (s: SettingsService): unknown => s.windowTintAlpha(), expected: 0.4},
  {name: 'subtitleFontSize', read: (s: SettingsService): unknown => s.subtitleFontSize(), expected: 150},
  {name: 'subtitleFontColor', read: (s: SettingsService): unknown => s.subtitleFontColor(), expected: '#ffcc00'},
  {name: 'subtitleBackgroundColor', read: (s: SettingsService): unknown => s.subtitleBackgroundColor(), expected: '#112233'},
  {name: 'subtitleBackgroundOpacity', read: (s: SettingsService): unknown => s.subtitleBackgroundOpacity(), expected: 0.25},
  {name: 'subtitleFontFamily', read: (s: SettingsService): unknown => s.subtitleFontFamily(), expected: 'serif'},
  {name: 'subtitleTextShadow', read: (s: SettingsService): unknown => s.subtitleTextShadow(), expected: false},
  {name: 'subtitleShadowSpread', read: (s: SettingsService): unknown => s.subtitleShadowSpread(), expected: 4},
  {name: 'subtitleShadowBlur', read: (s: SettingsService): unknown => s.subtitleShadowBlur(), expected: 7},
  {name: 'subtitleShadowColor', read: (s: SettingsService): unknown => s.subtitleShadowColor(), expected: '#333333'},
  {name: 'equalizerEnabled', read: (s: SettingsService): unknown => s.equalizerEnabled(), expected: true},
  {name: 'equalizerPreset', read: (s: SettingsService): unknown => s.equalizerPreset(), expected: 'rock'},
  {name: 'equalizerBands', read: (s: SettingsService): unknown => s.equalizerBands(), expected: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4]},
  {name: 'videoAdjustmentsEnabled', read: (s: SettingsService): unknown => s.videoAdjustmentsEnabled(), expected: true},
  {name: 'videoAdjustmentsPreset', read: (s: SettingsService): unknown => s.videoAdjustmentsPreset(), expected: 'custom'},
  {
    name: 'videoAdjustments',
    read: (s: SettingsService): unknown => s.videoAdjustments(),
    expected: {brightness: 10, contrast: -20, saturation: 30, hue: 45, blur: 5, grayscale: 60, sepia: 70, invert: true},
  },
];

/**
 * Every derived signal that tolerates its category being absent (settings
 * written by an older version), with the default it should fall back to.
 */
const FALLBACK_CASES: readonly SignalCase[] = [
  {name: 'serverPort', read: (s: SettingsService): unknown => s.serverPort(), expected: 0},
  {name: 'controlsAutoHideDelay', read: (s: SettingsService): unknown => s.controlsAutoHideDelay(), expected: 5},
  {name: 'miniplayerOnFocusLoss', read: (s: SettingsService): unknown => s.miniplayerOnFocusLoss(), expected: false},
  {name: 'previousTrackThreshold', read: (s: SettingsService): unknown => s.previousTrackThreshold(), expected: 3},
  {name: 'skipDuration', read: (s: SettingsService): unknown => s.skipDuration(), expected: 10},
  {name: 'defaultVolume', read: (s: SettingsService): unknown => s.defaultVolume(), expected: 0.5},
  {name: 'crossfadeDuration', read: (s: SettingsService): unknown => s.crossfadeDuration(), expected: 100},
  {name: 'videoQuality', read: (s: SettingsService): unknown => s.videoQuality(), expected: 'medium'},
  {name: 'audioBitrate', read: (s: SettingsService): unknown => s.audioBitrate(), expected: 192},
  {name: 'hardwareAcceleration', read: (s: SettingsService): unknown => s.hardwareAcceleration(), expected: 'auto'},
  {name: 'videoAspectMode', read: (s: SettingsService): unknown => s.videoAspectMode(), expected: 'default'},
  {name: 'seekMode', read: (s: SettingsService): unknown => s.seekMode(), expected: 'drop'},
  {name: 'preferredAudioLanguage', read: (s: SettingsService): unknown => s.preferredAudioLanguage(), expected: 'eng'},
  {name: 'preferredSubtitleLanguage', read: (s: SettingsService): unknown => s.preferredSubtitleLanguage(), expected: 'off'},
  {name: 'glassEnabled', read: (s: SettingsService): unknown => s.glassEnabled(), expected: true},
  {name: 'macOSVisualEffectState', read: (s: SettingsService): unknown => s.macOSVisualEffectState(), expected: 'active'},
  {name: 'colorScheme', read: (s: SettingsService): unknown => s.colorScheme(), expected: 'system'},
  {name: 'backgroundColor', read: (s: SettingsService): unknown => s.backgroundColor(), expected: '#1e1e1e'},
  {name: 'backgroundHue', read: (s: SettingsService): unknown => s.backgroundHue(), expected: 0},
  {name: 'backgroundSaturation', read: (s: SettingsService): unknown => s.backgroundSaturation(), expected: 0},
  {name: 'backgroundLightness', read: (s: SettingsService): unknown => s.backgroundLightness(), expected: 12},
  {name: 'windowTintHue', read: (s: SettingsService): unknown => s.windowTintHue(), expected: 0},
  {name: 'windowTintSaturation', read: (s: SettingsService): unknown => s.windowTintSaturation(), expected: 0},
  {name: 'windowTintLightness', read: (s: SettingsService): unknown => s.windowTintLightness(), expected: 0},
  {name: 'windowTintAlpha', read: (s: SettingsService): unknown => s.windowTintAlpha(), expected: 0},
  {name: 'subtitleFontSize', read: (s: SettingsService): unknown => s.subtitleFontSize(), expected: 100},
  {name: 'subtitleFontColor', read: (s: SettingsService): unknown => s.subtitleFontColor(), expected: '#ffffff'},
  {name: 'subtitleBackgroundColor', read: (s: SettingsService): unknown => s.subtitleBackgroundColor(), expected: '#000000'},
  {name: 'subtitleBackgroundOpacity', read: (s: SettingsService): unknown => s.subtitleBackgroundOpacity(), expected: 0.75},
  {name: 'subtitleFontFamily', read: (s: SettingsService): unknown => s.subtitleFontFamily(), expected: 'sans-serif'},
  {name: 'subtitleTextShadow', read: (s: SettingsService): unknown => s.subtitleTextShadow(), expected: true},
  {name: 'subtitleShadowSpread', read: (s: SettingsService): unknown => s.subtitleShadowSpread(), expected: 2},
  {name: 'subtitleShadowBlur', read: (s: SettingsService): unknown => s.subtitleShadowBlur(), expected: 2},
  {name: 'subtitleShadowColor', read: (s: SettingsService): unknown => s.subtitleShadowColor(), expected: '#000000'},
  {name: 'equalizerEnabled', read: (s: SettingsService): unknown => s.equalizerEnabled(), expected: false},
  {name: 'equalizerPreset', read: (s: SettingsService): unknown => s.equalizerPreset(), expected: 'flat'},
  {name: 'equalizerBands', read: (s: SettingsService): unknown => s.equalizerBands(), expected: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]},
  {name: 'videoAdjustmentsEnabled', read: (s: SettingsService): unknown => s.videoAdjustmentsEnabled(), expected: false},
  {name: 'videoAdjustmentsPreset', read: (s: SettingsService): unknown => s.videoAdjustmentsPreset(), expected: 'default'},
  {
    name: 'videoAdjustments',
    read: (s: SettingsService): unknown => s.videoAdjustments(),
    expected: {brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0, grayscale: 0, sepia: 0, invert: false},
  },
];

/**
 * Derived visualization signals that tolerate individual fields being absent,
 * with the default each should fall back to.
 */
const VISUALIZATION_FALLBACK_CASES: readonly SignalCase[] = [
  {name: 'maxFrameRate', read: (s: SettingsService): unknown => s.maxFrameRate(), expected: 60},
  {name: 'fftSize', read: (s: SettingsService): unknown => s.fftSize(), expected: 2048},
  {name: 'renderResolution', read: (s: SettingsService): unknown => s.renderResolution(), expected: 'native'},
  {name: 'visualizationCrossfadeDuration', read: (s: SettingsService): unknown => s.visualizationCrossfadeDuration(), expected: 1000},
  {name: 'visualizationCrossfadeStyle', read: (s: SettingsService): unknown => s.visualizationCrossfadeStyle(), expected: 'fade'},
  {name: 'perVisualizationSettings', read: (s: SettingsService): unknown => s.perVisualizationSettings(), expected: {}},
];

/** Setter calls that should be persisted, with the exact body each should send. */
const PERSIST_CASES: readonly PersistCase[] = [
  // Visualization
  {name: 'setDefaultVisualization("neon")', act: (s: SettingsService): Promise<void> => s.setDefaultVisualization('neon'), category: 'visualization', body: {defaultType: 'neon'}},
  {name: 'setMaxFrameRate(30)', act: (s: SettingsService): Promise<void> => s.setMaxFrameRate(30), category: 'visualization', body: {maxFrameRate: 30}},
  {name: 'setMaxFrameRate(45) as uncapped', act: (s: SettingsService): Promise<void> => s.setMaxFrameRate(45), category: 'visualization', body: {maxFrameRate: 0}},
  {name: 'setFftSize(512)', act: (s: SettingsService): Promise<void> => s.setFftSize(512), category: 'visualization', body: {fftSize: 512}},
  {name: 'setRenderResolution("640x360")', act: (s: SettingsService): Promise<void> => s.setRenderResolution('640x360'), category: 'visualization', body: {renderResolution: '640x360'}},
  {name: 'setVisualizationCrossfadeDuration(750)', act: (s: SettingsService): Promise<void> => s.setVisualizationCrossfadeDuration(750), category: 'visualization', body: {crossfadeDuration: 750}},
  {name: 'setVisualizationCrossfadeStyle("zoom")', act: (s: SettingsService): Promise<void> => s.setVisualizationCrossfadeStyle('zoom'), category: 'visualization', body: {crossfadeStyle: 'zoom'}},
  {name: 'setVisualizationSetting barDensity "high"', act: (s: SettingsService): Promise<void> => s.setVisualizationSetting('bars', 'barDensity', 'high'), category: 'visualization', body: {perVisualizationSettings: {bars: {barDensity: 'high'}}}},
  {name: 'setVisualizationSetting barColorTop unchanged', act: (s: SettingsService): Promise<void> => s.setVisualizationSetting('bars', 'barColorTop', '#ff0000'), category: 'visualization', body: {perVisualizationSettings: {bars: {barColorTop: '#ff0000'}}}},
  {name: 'setVisualizationSetting trailIntensity 2 clamped to 1', act: (s: SettingsService): Promise<void> => s.setVisualizationSetting('neon', 'trailIntensity', 2), category: 'visualization', body: {perVisualizationSettings: {neon: {trailIntensity: 1}}}},
  {name: 'setVisualizationSetting glowIntensity -1 clamped to 0', act: (s: SettingsService): Promise<void> => s.setVisualizationSetting('neon', 'glowIntensity', -1), category: 'visualization', body: {perVisualizationSettings: {neon: {glowIntensity: 0}}}},
  {name: 'setVisualizationSetting waveformSmoothing 0.3 unchanged', act: (s: SettingsService): Promise<void> => s.setVisualizationSetting('waveform', 'waveformSmoothing', 0.3), category: 'visualization', body: {perVisualizationSettings: {waveform: {waveformSmoothing: 0.3}}}},
  {name: 'setVisualizationSetting strobeFrequency 50 clamped to 20', act: (s: SettingsService): Promise<void> => s.setVisualizationSetting('pulsar', 'strobeFrequency', 50), category: 'visualization', body: {perVisualizationSettings: {pulsar: {strobeFrequency: 20}}}},
  {name: 'setVisualizationSetting strobeFrequency 0 clamped to 1', act: (s: SettingsService): Promise<void> => s.setVisualizationSetting('pulsar', 'strobeFrequency', 0), category: 'visualization', body: {perVisualizationSettings: {pulsar: {strobeFrequency: 1}}}},
  // Application
  {name: 'setServerPort(8080.4) rounded', act: (s: SettingsService): Promise<void> => s.setServerPort(8080.4), category: 'application', body: {serverPort: 8080}},
  {name: 'setControlsAutoHideDelay(12.4) rounded', act: (s: SettingsService): Promise<void> => s.setControlsAutoHideDelay(12.4), category: 'application', body: {controlsAutoHideDelay: 12}},
  {name: 'setControlsAutoHideDelay(99) clamped to 30', act: (s: SettingsService): Promise<void> => s.setControlsAutoHideDelay(99), category: 'application', body: {controlsAutoHideDelay: 30}},
  {name: 'setControlsAutoHideDelay(-3) clamped to 0', act: (s: SettingsService): Promise<void> => s.setControlsAutoHideDelay(-3), category: 'application', body: {controlsAutoHideDelay: 0}},
  {name: 'setMiniplayerOnFocusLoss(true)', act: (s: SettingsService): Promise<void> => s.setMiniplayerOnFocusLoss(true), category: 'application', body: {miniplayerOnFocusLoss: true}},
  // Playback
  {name: 'setSeekMode("drag")', act: (s: SettingsService): Promise<void> => s.setSeekMode('drag'), category: 'playback', body: {seekMode: 'drag'}},
  {name: 'setPreviousTrackThreshold(4.6) rounded', act: (s: SettingsService): Promise<void> => s.setPreviousTrackThreshold(4.6), category: 'playback', body: {previousTrackThreshold: 5}},
  {name: 'setPreviousTrackThreshold(42) clamped to 10', act: (s: SettingsService): Promise<void> => s.setPreviousTrackThreshold(42), category: 'playback', body: {previousTrackThreshold: 10}},
  {name: 'setSkipDuration(0) clamped to 1', act: (s: SettingsService): Promise<void> => s.setSkipDuration(0), category: 'playback', body: {skipDuration: 1}},
  {name: 'setSkipDuration(99) clamped to 60', act: (s: SettingsService): Promise<void> => s.setSkipDuration(99), category: 'playback', body: {skipDuration: 60}},
  {name: 'setDefaultVolume(0.3)', act: (s: SettingsService): Promise<void> => s.setDefaultVolume(0.3), category: 'playback', body: {defaultVolume: 0.3}},
  {name: 'setCrossfadeDuration(250.4) rounded', act: (s: SettingsService): Promise<void> => s.setCrossfadeDuration(250.4), category: 'playback', body: {crossfadeDuration: 250}},
  {name: 'setCrossfadeDuration(9999) clamped to 500', act: (s: SettingsService): Promise<void> => s.setCrossfadeDuration(9999), category: 'playback', body: {crossfadeDuration: 500}},
  {name: 'setCrossfadeDuration(-1) clamped to 0', act: (s: SettingsService): Promise<void> => s.setCrossfadeDuration(-1), category: 'playback', body: {crossfadeDuration: 0}},
  {name: 'setVideoAspectMode("fit")', act: (s: SettingsService): Promise<void> => s.setVideoAspectMode('fit'), category: 'playback', body: {videoAspectMode: 'fit'}},
  {name: 'setPreferredAudioLanguage("jpn")', act: (s: SettingsService): Promise<void> => s.setPreferredAudioLanguage('jpn'), category: 'playback', body: {preferredAudioLanguage: 'jpn'}},
  {name: 'setPreferredSubtitleLanguage("default")', act: (s: SettingsService): Promise<void> => s.setPreferredSubtitleLanguage('default'), category: 'playback', body: {preferredSubtitleLanguage: 'default'}},
  // Equalizer
  {name: 'setEqualizerEnabled(true)', act: (s: SettingsService): Promise<void> => s.setEqualizerEnabled(true), category: 'equalizer', body: {enabled: true}},
  {name: 'setEqualizerPreset("rock") with its band gains', act: (s: SettingsService): Promise<void> => s.setEqualizerPreset('rock'), category: 'equalizer', body: {preset: 'rock', bands: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4]}},
  {name: 'setEqualizerPreset("custom") without touching the bands', act: (s: SettingsService): Promise<void> => s.setEqualizerPreset('custom'), category: 'equalizer', body: {preset: 'custom'}},
  {name: 'setEqualizerBand(2, 6) as a custom preset', act: (s: SettingsService): Promise<void> => s.setEqualizerBand(2, 6), category: 'equalizer', body: {preset: 'custom', bands: [0, 0, 6, 0, 0, 0, 0, 0, 0, 0]}},
  {name: 'setEqualizerBand(9, 99) clamped to +12 dB', act: (s: SettingsService): Promise<void> => s.setEqualizerBand(9, 99), category: 'equalizer', body: {preset: 'custom', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 12]}},
  {name: 'setEqualizerBand(0, -99) clamped to -12 dB', act: (s: SettingsService): Promise<void> => s.setEqualizerBand(0, -99), category: 'equalizer', body: {preset: 'custom', bands: [-12, 0, 0, 0, 0, 0, 0, 0, 0, 0]}},
  {name: 'resetEqualizer()', act: (s: SettingsService): Promise<void> => s.resetEqualizer(), category: 'equalizer', body: {preset: 'flat', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]}},
  // Video adjustments
  {name: 'setVideoAdjustmentsEnabled(true)', act: (s: SettingsService): Promise<void> => s.setVideoAdjustmentsEnabled(true), category: 'videoAdjustments', body: {enabled: true}},
  {name: 'setVideoAdjustmentPreset("vivid") with its values', act: (s: SettingsService): Promise<void> => s.setVideoAdjustmentPreset('vivid'), category: 'videoAdjustments', body: {preset: 'vivid', brightness: 5, contrast: 15, saturation: 30, hue: 0, blur: 0, grayscale: 0, sepia: 0, invert: false}},
  {name: 'setVideoAdjustmentPreset("custom") without touching the values', act: (s: SettingsService): Promise<void> => s.setVideoAdjustmentPreset('custom'), category: 'videoAdjustments', body: {preset: 'custom'}},
  {name: 'setVideoAdjustment("brightness", 20) as a custom preset', act: (s: SettingsService): Promise<void> => s.setVideoAdjustment('brightness', 20), category: 'videoAdjustments', body: {preset: 'custom', brightness: 20}},
  {name: 'setVideoAdjustment("invert", true) as a custom preset', act: (s: SettingsService): Promise<void> => s.setVideoAdjustment('invert', true), category: 'videoAdjustments', body: {preset: 'custom', invert: true}},
  {name: 'resetVideoAdjustments()', act: (s: SettingsService): Promise<void> => s.resetVideoAdjustments(), category: 'videoAdjustments', body: {preset: 'default', brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0, grayscale: 0, sepia: 0, invert: false}},
  // Transcoding
  {name: 'setVideoQuality("high")', act: (s: SettingsService): Promise<void> => s.setVideoQuality('high'), category: 'transcoding', body: {videoQuality: 'high'}},
  {name: 'setAudioBitrate(256)', act: (s: SettingsService): Promise<void> => s.setAudioBitrate(256), category: 'transcoding', body: {audioBitrate: 256}},
  {name: 'setHardwareAcceleration("h264_nvenc")', act: (s: SettingsService): Promise<void> => s.setHardwareAcceleration('h264_nvenc'), category: 'transcoding', body: {hardwareAcceleration: 'h264_nvenc'}},
  // Appearance
  {name: 'setGlassEnabled(false)', act: (s: SettingsService): Promise<void> => s.setGlassEnabled(false), category: 'appearance', body: {glassEnabled: false}},
  {name: 'setMacOSVisualEffectState("inactive")', act: (s: SettingsService): Promise<void> => s.setMacOSVisualEffectState('inactive'), category: 'appearance', body: {macOSVisualEffectState: 'inactive'}},
  {name: 'setColorScheme("dark")', act: (s: SettingsService): Promise<void> => s.setColorScheme('dark'), category: 'appearance', body: {colorScheme: 'dark'}},
  {name: 'setBackgroundColor("#A1b2C3") in mixed case', act: (s: SettingsService): Promise<void> => s.setBackgroundColor('#A1b2C3'), category: 'appearance', body: {backgroundColor: '#A1b2C3'}},
  {name: 'setBackgroundHue(210)', act: (s: SettingsService): Promise<void> => s.setBackgroundHue(210), category: 'appearance', body: {backgroundHue: 210}},
  {name: 'setBackgroundSaturation(40)', act: (s: SettingsService): Promise<void> => s.setBackgroundSaturation(40), category: 'appearance', body: {backgroundSaturation: 40}},
  {name: 'setBackgroundLightness(20)', act: (s: SettingsService): Promise<void> => s.setBackgroundLightness(20), category: 'appearance', body: {backgroundLightness: 20}},
  {name: 'setWindowTintHue(120)', act: (s: SettingsService): Promise<void> => s.setWindowTintHue(120), category: 'appearance', body: {windowTintHue: 120}},
  {name: 'setWindowTintSaturation(30)', act: (s: SettingsService): Promise<void> => s.setWindowTintSaturation(30), category: 'appearance', body: {windowTintSaturation: 30}},
  {name: 'setWindowTintLightness(15)', act: (s: SettingsService): Promise<void> => s.setWindowTintLightness(15), category: 'appearance', body: {windowTintLightness: 15}},
  {name: 'setWindowTintAlpha(0.4)', act: (s: SettingsService): Promise<void> => s.setWindowTintAlpha(0.4), category: 'appearance', body: {windowTintAlpha: 0.4}},
  // Subtitles
  {name: 'setSubtitleFontSize(120.6) rounded', act: (s: SettingsService): Promise<void> => s.setSubtitleFontSize(120.6), category: 'subtitles', body: {fontSize: 121}},
  {name: 'setSubtitleFontSize(10) clamped to 50', act: (s: SettingsService): Promise<void> => s.setSubtitleFontSize(10), category: 'subtitles', body: {fontSize: 50}},
  {name: 'setSubtitleFontSize(999) clamped to 300', act: (s: SettingsService): Promise<void> => s.setSubtitleFontSize(999), category: 'subtitles', body: {fontSize: 300}},
  {name: 'setSubtitleFontColor("#ffcc00")', act: (s: SettingsService): Promise<void> => s.setSubtitleFontColor('#ffcc00'), category: 'subtitles', body: {fontColor: '#ffcc00'}},
  {name: 'setSubtitleBackgroundColor("#112233")', act: (s: SettingsService): Promise<void> => s.setSubtitleBackgroundColor('#112233'), category: 'subtitles', body: {backgroundColor: '#112233'}},
  {name: 'setSubtitleBackgroundOpacity(0.25)', act: (s: SettingsService): Promise<void> => s.setSubtitleBackgroundOpacity(0.25), category: 'subtitles', body: {backgroundOpacity: 0.25}},
  {name: 'setSubtitleBackgroundOpacity(1.5) clamped to 1', act: (s: SettingsService): Promise<void> => s.setSubtitleBackgroundOpacity(1.5), category: 'subtitles', body: {backgroundOpacity: 1}},
  {name: 'setSubtitleBackgroundOpacity(-1) clamped to 0', act: (s: SettingsService): Promise<void> => s.setSubtitleBackgroundOpacity(-1), category: 'subtitles', body: {backgroundOpacity: 0}},
  {name: 'setSubtitleFontFamily("Arial")', act: (s: SettingsService): Promise<void> => s.setSubtitleFontFamily('Arial'), category: 'subtitles', body: {fontFamily: 'Arial'}},
  {name: 'setSubtitleTextShadow(false)', act: (s: SettingsService): Promise<void> => s.setSubtitleTextShadow(false), category: 'subtitles', body: {textShadow: false}},
  {name: 'setSubtitleShadowSpread(4)', act: (s: SettingsService): Promise<void> => s.setSubtitleShadowSpread(4), category: 'subtitles', body: {shadowSpread: 4}},
  {name: 'setSubtitleShadowBlur(7)', act: (s: SettingsService): Promise<void> => s.setSubtitleShadowBlur(7), category: 'subtitles', body: {shadowBlur: 7}},
  {name: 'setSubtitleShadowColor("#333333")', act: (s: SettingsService): Promise<void> => s.setSubtitleShadowColor('#333333'), category: 'subtitles', body: {shadowColor: '#333333'}},
];

/** Setter calls that should be refused outright. */
const REJECT_CASES: readonly RejectCase[] = [
  {name: 'setFftSize(128)', act: (s: SettingsService): Promise<void> => s.setFftSize(128 as FftSize), message: 'Invalid FFT size: 128'},
  {name: 'setRenderResolution("999x999")', act: (s: SettingsService): Promise<void> => s.setRenderResolution('999x999' as RenderResolution), message: 'Invalid render resolution: 999x999'},
  {name: 'setVisualizationCrossfadeDuration(123)', act: (s: SettingsService): Promise<void> => s.setVisualizationCrossfadeDuration(123 as CrossfadeDuration), message: 'Invalid crossfade duration: 123'},
  {name: 'setVisualizationCrossfadeStyle("wipe")', act: (s: SettingsService): Promise<void> => s.setVisualizationCrossfadeStyle('wipe' as CrossfadeStyle), message: 'Invalid crossfade style: wipe'},
  {name: 'setSeekMode("hover")', act: (s: SettingsService): Promise<void> => s.setSeekMode('hover' as SeekMode), message: 'Invalid seek mode: hover'},
  {name: 'setEqualizerPreset("metal")', act: (s: SettingsService): Promise<void> => s.setEqualizerPreset('metal'), message: 'Invalid equalizer preset: metal'},
  {name: 'setEqualizerBand(-1, 3)', act: (s: SettingsService): Promise<void> => s.setEqualizerBand(-1, 3), message: 'Invalid equalizer band index: -1'},
  {name: 'setEqualizerBand(10, 3)', act: (s: SettingsService): Promise<void> => s.setEqualizerBand(10, 3), message: 'Invalid equalizer band index: 10'},
  {name: 'setVideoAdjustmentPreset("psychedelic")', act: (s: SettingsService): Promise<void> => s.setVideoAdjustmentPreset('psychedelic'), message: 'Invalid video adjustment preset: psychedelic'},
  {name: 'setVideoQuality("ultra")', act: (s: SettingsService): Promise<void> => s.setVideoQuality('ultra' as VideoQuality), message: 'Invalid video quality: ultra'},
  {name: 'setAudioBitrate(96)', act: (s: SettingsService): Promise<void> => s.setAudioBitrate(96 as AudioBitrate), message: 'Invalid audio bitrate: 96'},
  {name: 'setHardwareAcceleration("hevc_magic")', act: (s: SettingsService): Promise<void> => s.setHardwareAcceleration('hevc_magic' as HardwareAcceleration), message: 'Invalid hardware acceleration mode: hevc_magic'},
  {name: 'setVideoAspectMode("stretch")', act: (s: SettingsService): Promise<void> => s.setVideoAspectMode('stretch' as VideoAspectMode), message: 'Invalid video aspect mode: stretch'},
  {name: 'setPreferredAudioLanguage("off")', act: (s: SettingsService): Promise<void> => s.setPreferredAudioLanguage('off' as PreferredAudioLanguage), message: 'Invalid audio language: off'},
  {name: 'setPreferredSubtitleLanguage("xxx")', act: (s: SettingsService): Promise<void> => s.setPreferredSubtitleLanguage('xxx' as PreferredSubtitleLanguage), message: 'Invalid subtitle language: xxx'},
  {name: 'setMacOSVisualEffectState("sometimes")', act: (s: SettingsService): Promise<void> => s.setMacOSVisualEffectState('sometimes' as MacOSVisualEffectState), message: 'Invalid macOS visual effect state: sometimes'},
  {name: 'setColorScheme("sepia")', act: (s: SettingsService): Promise<void> => s.setColorScheme('sepia' as ColorScheme), message: 'Invalid color scheme: sepia'},
  {name: 'setBackgroundColor with seven hex digits', act: (s: SettingsService): Promise<void> => s.setBackgroundColor('#1234567'), message: 'Invalid hex color: #1234567'},
  {name: 'setBackgroundColor without the leading hash', act: (s: SettingsService): Promise<void> => s.setBackgroundColor('1e1e1e'), message: 'Invalid hex color: 1e1e1e'},
  {name: 'setSubtitleFontColor with a colour name', act: (s: SettingsService): Promise<void> => s.setSubtitleFontColor('red'), message: 'Invalid hex color: red'},
  {name: 'setSubtitleFontColor with shorthand hex', act: (s: SettingsService): Promise<void> => s.setSubtitleFontColor('#fff'), message: 'Invalid hex color: #fff'},
  {name: 'setSubtitleBackgroundColor with a non-hex digit', act: (s: SettingsService): Promise<void> => s.setSubtitleBackgroundColor('#12345g'), message: 'Invalid hex color: #12345g'},
  {name: 'setSubtitleShadowColor carrying injected CSS', act: (s: SettingsService): Promise<void> => s.setSubtitleShadowColor('#000000;} body {display: none'), message: 'Invalid hex color: #000000;} body {display: none'},
  {name: 'setSubtitleFontFamily("Comic Sans")', act: (s: SettingsService): Promise<void> => s.setSubtitleFontFamily('Comic Sans' as SubtitleFontFamily), message: 'Invalid font family: Comic Sans'},
  {name: 'setVisualizationSetting barDensity "extreme"', act: (s: SettingsService): Promise<void> => s.setVisualizationSetting('bars', 'barDensity', 'extreme' as VisualizationLocalSettings['barDensity']), message: 'Invalid bar density: extreme'},
];

describe('SettingsService persistence', (): void => {
  let service: SettingsService;
  let mockElectron: ReturnType<typeof createMockElectronService>;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let unsubscribeSettings: ReturnType<typeof vi.fn>;

  /**
   * Creates the service and lets its start-up effect (and any fetch it makes) settle.
   *
   * @param serverUrl - The server URL known at construction ('' = not yet known)
   */
  async function createService(serverUrl: string = SERVER_URL): Promise<void> {
    mockElectron.serverUrl.set(serverUrl);
    service = TestBed.inject(SettingsService);
    await settle();
  }

  /**
   * Runs pending effects and lets promise chains finish without moving the clock.
   */
  async function settle(): Promise<void> {
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
  }

  /**
   * Returns the callback the service registered for `settings:updated` pushes.
   */
  function settingsPushHandler(): (settings: AppSettings) => void {
    return mockElectron.onSettingsUpdate.mock.calls[0][0] as (settings: AppSettings) => void;
  }

  beforeEach((): void => {
    vi.useFakeTimers();

    mockElectron = createMockElectronService();
    unsubscribeSettings = vi.fn();
    mockElectron.onSettingsUpdate.mockReturnValue(unsubscribeSettings);

    fetchSpy = vi.fn().mockResolvedValue(createMockResponse(true, createTestSettings()));
    vi.stubGlobal('fetch', fetchSpy);
    errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => {});

    TestBed.configureTestingModule({
      providers: [
        SettingsService,
        {provide: ElectronService, useValue: mockElectron},
      ],
    });
  });

  afterEach((): void => {
    // Destroy the service while fetch is still stubbed: teardown flushes any
    // write that is still queued.
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ============================================================================
  // Defaults and initial fetch
  // ============================================================================

  describe('before the server URL is known', (): void => {
    beforeEach(async (): Promise<void> => {
      await createService('');
    });

    it('makes no request', (): void => {
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('reports that settings are not loaded', (): void => {
      expect(service.isLoaded()).toBe(false);
    });

    it('exposes the built-in defaults', (): void => {
      expect(service.defaultVisualization()).toBe('water');
      expect(service.maxFrameRate()).toBe(60);
      expect(service.preferredAudioLanguage()).toBe('eng');
      expect(service.equalizerBands()).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('returns the defaults from fetchSettings without a request', async (): Promise<void> => {
      const result: AppSettings = await service.fetchSettings();

      expect(result).toBe(service.settings());
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('updates the local value but sends nothing when a setter is called', async (): Promise<void> => {
      const pending: Promise<void> = service.setSkipDuration(30);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await pending;

      expect(service.skipDuration()).toBe(30);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetches the settings once the server URL becomes available', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(true, NON_DEFAULT_SETTINGS));

      mockElectron.serverUrl.set(SERVER_URL);
      await settle();

      expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(`${SERVER_URL}/settings`, undefined);
      expect(service.settings()).toEqual(NON_DEFAULT_SETTINGS);
      expect(service.isLoaded()).toBe(true);
    });

    it('does not fetch when a push already delivered the settings', async (): Promise<void> => {
      settingsPushHandler()(NON_DEFAULT_SETTINGS);

      mockElectron.serverUrl.set(SERVER_URL);
      await settle();

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('initial fetch', (): void => {
    it('applies the fetched settings', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(true, NON_DEFAULT_SETTINGS));

      await createService();

      expect(service.settings()).toEqual(NON_DEFAULT_SETTINGS);
      expect(service.isLoaded()).toBe(true);
    });

    it('keeps the defaults and logs when the server responds with an error', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(false));

      await createService();

      expect(service.isLoaded()).toBe(false);
      expect(service.defaultVisualization()).toBe('water');
      expect(errorSpy).toHaveBeenCalledWith(
        '[SettingsService] Initial settings fetch failed:',
        expect.objectContaining({message: 'Failed to fetch settings: Internal Server Error'}),
      );
    });

    it('keeps the defaults and logs when the request fails', async (): Promise<void> => {
      const failure: Error = new Error('connection refused');
      fetchSpy.mockRejectedValue(failure);

      await createService();

      expect(service.isLoaded()).toBe(false);
      expect(service.defaultVisualization()).toBe('water');
      expect(errorSpy).toHaveBeenCalledWith('[SettingsService] Initial settings fetch failed:', failure);
    });

    it('rejects a manual fetchSettings when the server responds with an error', async (): Promise<void> => {
      await createService();
      fetchSpy.mockResolvedValue(createMockResponse(false));

      await expect(service.fetchSettings()).rejects.toThrow('Failed to fetch settings: Internal Server Error');
    });
  });

  // ============================================================================
  // Server pushes
  // ============================================================================

  describe('settings pushed by the server', (): void => {
    beforeEach(async (): Promise<void> => {
      await createService();
    });

    it('replaces the settings when a settings:updated push arrives', (): void => {
      settingsPushHandler()(NON_DEFAULT_SETTINGS);

      expect(service.settings()).toBe(NON_DEFAULT_SETTINGS);
    });

    it.each(PUSHED_VALUE_CASES)('$name reflects the pushed value', (testCase: SignalCase): void => {
      settingsPushHandler()(NON_DEFAULT_SETTINGS);

      expect(testCase.read(service)).toEqual(testCase.expected);
    });

    it.each(FALLBACK_CASES)('$name falls back to its default when the push omits its category', (testCase: SignalCase): void => {
      const legacy: AppSettings = {version: 1, visualization: {defaultType: 'bars'}} as unknown as AppSettings;

      settingsPushHandler()(legacy);

      expect(testCase.read(service)).toEqual(testCase.expected);
    });

    it.each(VISUALIZATION_FALLBACK_CASES)('$name falls back to its default when the push omits the field', (testCase: SignalCase): void => {
      const legacy: AppSettings = {version: 1, visualization: {defaultType: 'bars'}} as unknown as AppSettings;

      settingsPushHandler()(legacy);

      expect(testCase.read(service)).toEqual(testCase.expected);
    });

    it('clamps out-of-range equalizer gains from a push', (): void => {
      settingsPushHandler()(createTestSettings({equalizer: {enabled: true, preset: 'custom', bands: [40, -40, 3]}}));

      expect(service.equalizerBands()).toEqual([12, -12, 3, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('keeps a change that is still waiting to be written when an unrelated push arrives', async (): Promise<void> => {
      const pending: Promise<void> = service.setSkipDuration(30);

      settingsPushHandler()(createTestSettings({
        application: {serverPort: 9000, controlsAutoHideDelay: 5, miniplayerOnFocusLoss: false},
      }));

      expect(service.skipDuration()).toBe(30);
      expect(service.serverPort()).toBe(9000);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await pending;
    });

    it('accepts the server value once the pending change has been written', async (): Promise<void> => {
      const pending: Promise<void> = service.setSkipDuration(30);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await pending;

      settingsPushHandler()(createTestSettings());

      expect(service.skipDuration()).toBe(10);
    });
  });

  // ============================================================================
  // Setters
  // ============================================================================

  describe('setters', (): void => {
    beforeEach(async (): Promise<void> => {
      await createService();
      fetchSpy.mockClear();
    });

    it.each(PERSIST_CASES)('$name is written to its category', async (testCase: PersistCase): Promise<void> => {
      const pending: Promise<void> = testCase.act(service);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await pending;

      expect(sentWrites(fetchSpy)).toEqual([{
        url: `${SERVER_URL}/settings/${testCase.category}`,
        headers: {'Content-Type': 'application/json'},
        body: testCase.body,
      }]);
    });

    it.each(PERSIST_CASES)('$name shows in the local settings before the write is sent', async (testCase: PersistCase): Promise<void> => {
      const pending: Promise<void> = testCase.act(service);

      const group: unknown = (service.settings() as unknown as Record<string, unknown>)[testCase.category];
      expect(group).toEqual(expect.objectContaining(testCase.body));
      expect(fetchSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await pending;
    });

    it.each(REJECT_CASES)('$name is refused', async (testCase: RejectCase): Promise<void> => {
      const before: AppSettings = service.settings();

      await testCase.act(service);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(errorSpy).toHaveBeenCalledWith(`[SettingsService] ${testCase.message}`);
      expect(service.settings()).toBe(before);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('keeps the current bands when the custom equalizer preset is selected', async (): Promise<void> => {
      settingsPushHandler()(NON_DEFAULT_SETTINGS);

      const pending: Promise<void> = service.setEqualizerPreset('custom');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await pending;

      expect(service.equalizerPreset()).toBe('custom');
      expect(service.equalizerBands()).toEqual([4, 3, 2, 0, -1, -1, 1, 3, 4, 4]);
    });

    it('keeps earlier band changes when several bands are set in one burst', async (): Promise<void> => {
      void service.setEqualizerBand(0, 3);
      const pending: Promise<void> = service.setEqualizerBand(1, -4);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await pending;

      expect(sentWrites(fetchSpy)).toEqual([expect.objectContaining({
        body: {preset: 'custom', bands: [3, -4, 0, 0, 0, 0, 0, 0, 0, 0]},
      })]);
    });

    it('still writes a category the local settings do not contain', async (): Promise<void> => {
      const legacy: AppSettings = {version: 1, visualization: {defaultType: 'bars'}} as unknown as AppSettings;
      settingsPushHandler()(legacy);

      const pending: Promise<void> = service.setEqualizerEnabled(true);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await pending;

      expect(service.settings()).toBe(legacy);
      expect(sentWrites(fetchSpy)).toEqual([expect.objectContaining({
        url: `${SERVER_URL}/settings/equalizer`,
        body: {enabled: true},
      })]);
    });
  });

  // ============================================================================
  // Per-visualization settings
  // ============================================================================

  describe('per-visualization settings', (): void => {
    const customised: PerVisualizationSettings = {
      bars: {barDensity: 'high', barColorTop: '#ff0000'},
      neon: {glowIntensity: 0.9},
    };

    beforeEach(async (): Promise<void> => {
      await createService();
      settingsPushHandler()(createTestSettings({
        visualization: {
          defaultType: 'bars',
          maxFrameRate: 0,
          fftSize: 2048,
          renderResolution: 'native',
          crossfadeDuration: 1000,
          crossfadeStyle: 'fade',
          perVisualizationSettings: customised,
        },
      }));
      fetchSpy.mockClear();
    });

    it('sends every visualization\'s settings when one setting changes', async (): Promise<void> => {
      const pending: Promise<void> = service.setVisualizationSetting('bars', 'barDensity', 'low');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await pending;

      expect(sentWrites(fetchSpy)[0].body).toEqual({
        perVisualizationSettings: {
          bars: {barDensity: 'low', barColorTop: '#ff0000'},
          neon: {glowIntensity: 0.9},
        },
      });
    });

    it('keeps both changes when two visualizations change in one burst', async (): Promise<void> => {
      void service.setVisualizationSetting('bars', 'barDensity', 'low');
      const pending: Promise<void> = service.setVisualizationSetting('neon', 'glowIntensity', 0.1);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await pending;

      expect(sentWrites(fetchSpy)).toEqual([expect.objectContaining({
        body: {
          perVisualizationSettings: {
            bars: {barDensity: 'low', barColorTop: '#ff0000'},
            neon: {glowIntensity: 0.1},
          },
        },
      })]);
    });

    it('reports the changed value as the effective setting straight away', async (): Promise<void> => {
      const pending: Promise<void> = service.setVisualizationSetting('waveform', 'lineWidth', 4);

      expect(service.getEffectiveSetting('waveform', 'lineWidth')).toBe(4);
      expect(service.hasCustomSetting('waveform', 'lineWidth')).toBe(true);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await pending;
    });

    it('resetting one setting sends the map without that setting', async (): Promise<void> => {
      await service.resetVisualizationSetting('bars', 'barDensity');

      expect(sentWrites(fetchSpy)).toEqual([{
        url: `${SERVER_URL}/settings/visualization`,
        headers: {'Content-Type': 'application/json'},
        body: {perVisualizationSettings: {bars: {barColorTop: '#ff0000'}, neon: {glowIntensity: 0.9}}},
      }]);
    });

    it('resetting a visualization\'s last setting removes its entry', async (): Promise<void> => {
      await service.resetVisualizationSetting('neon', 'glowIntensity');

      expect(sentWrites(fetchSpy)[0].body).toEqual({
        perVisualizationSettings: {bars: {barDensity: 'high', barColorTop: '#ff0000'}},
      });
    });

    it('resetting a setting that was never customised sends nothing', async (): Promise<void> => {
      await service.resetVisualizationSetting('bars', 'sensitivity');

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('resetting a setting of an uncustomised visualization sends nothing', async (): Promise<void> => {
      await service.resetVisualizationSetting('tunnel', 'sensitivity');

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('resetting a setting sends nothing while the server URL is unknown', async (): Promise<void> => {
      mockElectron.serverUrl.set('');

      await service.resetVisualizationSetting('bars', 'barDensity');

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('logs when the server refuses to reset a setting', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(false));

      await service.resetVisualizationSetting('bars', 'barDensity');

      expect(errorSpy).toHaveBeenCalledWith('[SettingsService] Failed to save visualization: 500');
    });

    it('resetting all settings sends the map without that visualization', async (): Promise<void> => {
      await service.resetAllVisualizationSettings('bars');

      expect(sentWrites(fetchSpy)).toEqual([{
        url: `${SERVER_URL}/settings/visualization`,
        headers: {'Content-Type': 'application/json'},
        body: {perVisualizationSettings: {neon: {glowIntensity: 0.9}}},
      }]);
    });

    it('resetting all settings sends nothing while the server URL is unknown', async (): Promise<void> => {
      mockElectron.serverUrl.set('');

      await service.resetAllVisualizationSettings('bars');

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('logs when the server refuses to reset all settings', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(false));

      await service.resetAllVisualizationSettings('bars');

      expect(errorSpy).toHaveBeenCalledWith('[SettingsService] Failed to save visualization: 500');
    });

    it('resetting one setting drops the custom value straight away', async (): Promise<void> => {
      const pending: Promise<void> = service.resetVisualizationSetting('bars', 'barDensity');

      expect(service.perVisualizationSettings()).toEqual({bars: {barColorTop: '#ff0000'}, neon: {glowIntensity: 0.9}});
      await pending;
    });

    it('resetting all settings drops the visualization\'s custom values straight away', async (): Promise<void> => {
      const pending: Promise<void> = service.resetAllVisualizationSettings('bars');

      expect(service.perVisualizationSettings()).toEqual({neon: {glowIntensity: 0.9}});
      await pending;
    });

    it('a change still waiting on its debounce cannot undo a later reset of that setting', async (): Promise<void> => {
      void service.setVisualizationSetting('bars', 'barDensity', 'low');

      await service.resetVisualizationSetting('bars', 'barDensity');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(sentWrites(fetchSpy).at(-1)?.body).toEqual({
        perVisualizationSettings: {bars: {barColorTop: '#ff0000'}, neon: {glowIntensity: 0.9}},
      });
    });

    it('a change still waiting on its debounce cannot undo a later reset of the whole visualization', async (): Promise<void> => {
      void service.setVisualizationSetting('bars', 'barDensity', 'low');

      await service.resetAllVisualizationSettings('bars');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(sentWrites(fetchSpy).at(-1)?.body).toEqual({perVisualizationSettings: {neon: {glowIntensity: 0.9}}});
    });

    it('a reset sends an unrelated visualization change that was still waiting on its debounce', async (): Promise<void> => {
      void service.setMaxFrameRate(30);

      await service.resetVisualizationSetting('bars', 'barDensity');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(sentWrites(fetchSpy)).toEqual([expect.objectContaining({
        body: {
          maxFrameRate: 30,
          perVisualizationSettings: {bars: {barColorTop: '#ff0000'}, neon: {glowIntensity: 0.9}},
        },
      })]);
    });

    it('a reset settles a change that was still waiting on its debounce', async (): Promise<void> => {
      const change: Promise<void> = service.setVisualizationSetting('neon', 'glowIntensity', 0.1);

      await service.resetVisualizationSetting('bars', 'barDensity');

      await expect(change).resolves.toBeUndefined();
    });
  });

  // ============================================================================
  // Debounced writes
  // ============================================================================

  describe('debounced writes', (): void => {
    beforeEach(async (): Promise<void> => {
      await createService();
      fetchSpy.mockClear();
    });

    it('sends nothing until the debounce interval has passed', async (): Promise<void> => {
      const pending: Promise<void> = service.setDefaultVolume(0.9);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);

      expect(fetchSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
    });

    it('sends the write once the debounce interval has passed', async (): Promise<void> => {
      const pending: Promise<void> = service.setDefaultVolume(0.9);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await pending;

      expect(sentWrites(fetchSpy)).toHaveLength(1);
    });

    it('restarts the interval on each change to the same category', async (): Promise<void> => {
      void service.setDefaultVolume(0.6);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
      const pending: Promise<void> = service.setDefaultVolume(0.7);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);

      expect(fetchSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
    });

    it('sends only the last value when one field changes repeatedly', async (): Promise<void> => {
      void service.setDefaultVolume(0.6);
      void service.setDefaultVolume(0.7);
      const pending: Promise<void> = service.setDefaultVolume(0.8);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await pending;

      expect(sentWrites(fetchSpy)).toEqual([expect.objectContaining({body: {defaultVolume: 0.8}})]);
    });

    it('merges different fields of one category into a single write', async (): Promise<void> => {
      void service.setDefaultVolume(0.6);
      const pending: Promise<void> = service.setSkipDuration(20);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await pending;

      expect(sentWrites(fetchSpy)).toEqual([expect.objectContaining({
        url: `${SERVER_URL}/settings/playback`,
        body: {defaultVolume: 0.6, skipDuration: 20},
      })]);
    });

    it('writes each category separately', async (): Promise<void> => {
      void service.setDefaultVolume(0.6);
      const pending: Promise<void> = service.setGlassEnabled(false);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await pending;

      const urls: string[] = sentWrites(fetchSpy).map((write: SentWrite): string => write.url);
      expect(urls).toEqual([`${SERVER_URL}/settings/playback`, `${SERVER_URL}/settings/appearance`]);
    });

    it('does not delay one category because another keeps changing', async (): Promise<void> => {
      void service.setGlassEnabled(false);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
      void service.setDefaultVolume(0.6);

      await vi.advanceTimersByTimeAsync(1);

      const urls: string[] = sentWrites(fetchSpy).map((write: SentWrite): string => write.url);
      expect(urls).toEqual([`${SERVER_URL}/settings/appearance`]);
    });

    it('leaves a setter pending until its write has been sent', async (): Promise<void> => {
      let settled: boolean = false;
      const pending: Promise<void> = service.setDefaultVolume(0.9).then((): void => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);

      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
    });

    it('settles every setter of a burst on the one write', async (): Promise<void> => {
      const first: Promise<void> = service.setDefaultVolume(0.6);
      const second: Promise<void> = service.setSkipDuration(20);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
      expect(sentWrites(fetchSpy)).toHaveLength(1);
    });

    it('sends a later change as a new write after the first has gone', async (): Promise<void> => {
      const first: Promise<void> = service.setDefaultVolume(0.6);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await first;

      const second: Promise<void> = service.setSkipDuration(20);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await second;

      const bodies: Record<string, unknown>[] = sentWrites(fetchSpy).map((write: SentWrite): Record<string, unknown> => write.body);
      expect(bodies).toEqual([{defaultVolume: 0.6}, {skipDuration: 20}]);
    });

    it('logs and still resolves when the server refuses the write', async (): Promise<void> => {
      fetchSpy.mockResolvedValue(createMockResponse(false));

      const pending: Promise<void> = service.setDefaultVolume(0.9);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      await expect(pending).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith('[SettingsService] Failed to save playback: 500');
    });

    it('rejects every setter of a burst when the request fails', async (): Promise<void> => {
      fetchSpy.mockRejectedValue(new Error('network down'));

      const first: Promise<void> = service.setDefaultVolume(0.6);
      const second: Promise<void> = service.setSkipDuration(20);
      const firstOutcome: Promise<void> = expect(first).rejects.toThrow('network down');
      const secondOutcome: Promise<void> = expect(second).rejects.toThrow('network down');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      await firstOutcome;
      await secondOutcome;
    });

    it('writes pending changes immediately when the page is hidden', async (): Promise<void> => {
      const volume: Promise<void> = service.setDefaultVolume(0.6);
      const glass: Promise<void> = service.setGlassEnabled(false);

      window.dispatchEvent(new Event('pagehide'));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([volume, glass]);

      const bodies: Record<string, unknown>[] = sentWrites(fetchSpy).map((write: SentWrite): Record<string, unknown> => write.body);
      expect(bodies).toEqual([{defaultVolume: 0.6}, {glassEnabled: false}]);
    });

    it('does not write a second time when the debounce elapses after a page-hide flush', async (): Promise<void> => {
      const pending: Promise<void> = service.setDefaultVolume(0.6);
      window.dispatchEvent(new Event('pagehide'));
      await vi.advanceTimersByTimeAsync(0);
      await pending;

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(sentWrites(fetchSpy)).toHaveLength(1);
    });
  });

  // ============================================================================
  // Teardown
  // ============================================================================

  describe('teardown', (): void => {
    beforeEach(async (): Promise<void> => {
      await createService();
      fetchSpy.mockClear();
    });

    it('writes pending changes when the service is destroyed', async (): Promise<void> => {
      const pending: Promise<void> = service.setDefaultVolume(0.6);

      TestBed.resetTestingModule();
      await vi.advanceTimersByTimeAsync(0);
      await pending;

      expect(sentWrites(fetchSpy)).toEqual([expect.objectContaining({body: {defaultVolume: 0.6}})]);
    });

    it('stops listening for server pushes when the service is destroyed', (): void => {
      TestBed.resetTestingModule();

      expect(unsubscribeSettings).toHaveBeenCalledTimes(1);
    });

    it('stops flushing on page hide once the service is destroyed', async (): Promise<void> => {
      TestBed.resetTestingModule();
      const pending: Promise<void> = service.setDefaultVolume(0.6);

      window.dispatchEvent(new Event('pagehide'));
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await pending;
    });
  });
});

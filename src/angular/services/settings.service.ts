/**
 * @fileoverview Angular service for managing application settings.
 *
 * This service handles persistent user preferences stored on the server.
 * Settings are synchronized via SSE events and persisted to disk.
 *
 * Current settings:
 * - Visualization: default visualization type for audio playback
 *
 * @module app/services/settings.service
 */

import {Injectable, signal, computed, inject, effect, OnDestroy, EffectRef} from '@angular/core';
import {ElectronService} from './electron.service';

// ============================================================================
// Types
// ============================================================================

/**
 * Visualization type identifiers.
 *
 * These correspond to the visualization classes:
 * - bars: Frequency Bars (default)
 * - waveform: Oscilloscope-style waveform
 * - tether: Symmetrical waveform bars with smoke effect
 * - tunnel: Dual red/blue waveforms with zoom
 * - neon: Rotating cyan/magenta waveforms
 * - pulsar: Pulsing concentric rings with curved waveforms (space category)
 * - water: Water ripple effect with rotating waveforms (ambience category)
 * - flux: Dual orbiting circles with spectrum cycling
 */
export type VisualizationType = 'bars' | 'waveform' | 'tether' | 'tunnel' | 'neon' | 'pulsar' | 'water' | 'flux';

/**
 * Per-visualization sensitivity overrides.
 * If a visualization type has a value here, it overrides the global sensitivity.
 */
export type PerVisualizationSensitivity = Partial<Record<VisualizationType, number>>;

/**
 * Valid FFT size values (must be powers of 2).
 */
export type FftSize = 256 | 512 | 1024 | 2048 | 4096;

/**
 * Bar density levels for bar-based visualizations.
 */
export type BarDensity = 'low' | 'medium' | 'high';

/**
 * Video quality preset levels for transcoding.
 */
export type VideoQuality = 'low' | 'medium' | 'high';

/**
 * Audio bitrate options for transcoding (kbps).
 */
export type AudioBitrate = 128 | 192 | 256 | 320;

/**
 * Visualization settings structure.
 */
export interface VisualizationSettings {
  /** The default visualization to display on startup */
  readonly defaultType: VisualizationType;
  /** Global sensitivity for all visualizations (0.0 - 1.0, default 0.5) */
  readonly sensitivity: number;
  /** Per-visualization sensitivity overrides (0.0 - 1.0, optional per type) */
  readonly perVisualizationSensitivity: PerVisualizationSensitivity;
  /** Maximum frame rate for visualizations (0 = uncapped, or 15/30/60) */
  readonly maxFrameRate: number;
  /** Trail intensity for visualizations with trail effects (0.0 - 1.0, default 0.5) */
  readonly trailIntensity: number;
  /** Hue shift for visualization colors (0-360 degrees, default 0) */
  readonly hueShift: number;
  /** FFT size for audio analysis (256, 512, 1024, 2048, or 4096, default 2048) */
  readonly fftSize: FftSize;
  /** Bar density for bar-based visualizations (low, medium, high, default medium) */
  readonly barDensity: BarDensity;
  /** Line width for waveform visualizations (1.0 - 5.0, default 2.0) */
  readonly lineWidth: number;
  /** Glow intensity for visualizations with glow effects (0.0 - 1.0, default 0.5) */
  readonly glowIntensity: number;
}

/**
 * Application-level settings.
 */
export interface ApplicationSettings {
  /** Server port (0 = auto-assign, or specific port 1024-65535) */
  readonly serverPort: number;
  /** Controls auto-hide delay in seconds (0 = disabled, 1-30 seconds, default 5) */
  readonly controlsAutoHideDelay: number;
}

/**
 * Playback settings.
 */
export interface PlaybackSettings {
  /** Default volume on startup (0.0 - 1.0, default 0.5) */
  readonly defaultVolume: number;
  /** Crossfade duration between tracks in milliseconds (0-500, default 100) */
  readonly crossfadeDuration: number;
  /** Previous track threshold in seconds (0-10, default 3) */
  readonly previousTrackThreshold: number;
}

/**
 * Transcoding settings.
 */
export interface TranscodingSettings {
  /** Video quality preset for transcoding (low, medium, high, default medium) */
  readonly videoQuality: VideoQuality;
  /** Audio bitrate in kbps (128, 192, 256, 320, default 192) */
  readonly audioBitrate: AudioBitrate;
}

/**
 * Complete application settings structure.
 */
export interface AppSettings {
  /** Settings schema version */
  readonly version: number;
  /** Visualization preferences */
  readonly visualization: VisualizationSettings;
  /** Application-level settings */
  readonly application: ApplicationSettings;
  /** Playback settings */
  readonly playback: PlaybackSettings;
  /** Transcoding settings */
  readonly transcoding: TranscodingSettings;
}

/**
 * Display information for a visualization option.
 */
export interface VisualizationOption {
  /** The visualization type value */
  readonly value: VisualizationType;
  /** Human-readable display label */
  readonly label: string;
  /** Optional description */
  readonly description?: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default settings used before server data is received.
 */
const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  visualization: {
    defaultType: 'bars',
    sensitivity: 0.5,
    perVisualizationSensitivity: {},
    maxFrameRate: 0,
    trailIntensity: 0.5,
    hueShift: 0,
    fftSize: 2048,
    barDensity: 'medium',
    lineWidth: 2.0,
    glowIntensity: 0.5,
  },
  application: {
    serverPort: 0,
    controlsAutoHideDelay: 5,
  },
  playback: {
    defaultVolume: 0.5,
    crossfadeDuration: 100,
    previousTrackThreshold: 3,
  },
  transcoding: {
    videoQuality: 'medium',
    audioBitrate: 192,
  },
};

/**
 * Available visualization options for the settings UI.
 */
export const VISUALIZATION_OPTIONS: readonly VisualizationOption[] = [
  // Bars category
  {value: 'bars', label: 'Bars : Analyzer', description: 'Configurable frequency bars with gradient'},
  {value: 'tether', label: 'Bars : Spectre', description: 'Mirrored frequency bars with smoke effect'},
  // Science category
  {value: 'pulsar', label: 'Science : Pulsar', description: 'Pulsing concentric rings with curved waveforms'},
  {value: 'water', label: 'Science : Record', description: 'Spinning vinyl record effect'},
  // Waves category
  {value: 'tunnel', label: 'Waves : Flare', description: 'Dual blue/red waveforms with tunnel zoom'},
  {value: 'flux', label: 'Waves : Flux', description: 'Dual orbiting circles with spectrum cycling'},
  {value: 'neon', label: 'Waves : Neon', description: 'Rotating cyan/magenta waveforms'},
  {value: 'waveform', label: 'Waves : Classic', description: 'Oscilloscope-style waveform with glow'},
];

// ============================================================================
// SettingsService
// ============================================================================

/**
 * Service for managing persistent application settings.
 *
 * This service provides:
 * - Reactive signals for current settings
 * - HTTP API calls to update settings
 * - SSE event handling for real-time updates
 *
 * Settings are persisted server-side to a JSON file.
 *
 * @example
 * // In a component
 * export class MyComponent {
 *   private settings = inject(SettingsService);
 *
 *   // Read the default visualization
 *   defaultViz = this.settings.defaultVisualization;
 *
 *   // Update the default visualization
 *   async onVisualizationChange(type: VisualizationType) {
 *     await this.settings.setDefaultVisualization(type);
 *   }
 * }
 */
@Injectable({providedIn: 'root'})
export class SettingsService implements OnDestroy {
  // ============================================================================
  // Dependencies
  // ============================================================================

  /** Electron service for server URL access */
  private readonly electron: ElectronService = inject(ElectronService);

  // ============================================================================
  // Public Signals
  // ============================================================================

  /** Complete settings object (updated via SSE) */
  public readonly settings: ReturnType<typeof signal<AppSettings>> = signal<AppSettings>(DEFAULT_SETTINGS);

  /** Whether settings have been loaded from the server */
  public readonly isLoaded: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Effect reference for cleanup */
  private readonly serverUrlEffect: EffectRef;

  // ============================================================================
  // Constructor
  // ============================================================================

  /**
   * Registers the SSE callback with ElectronService and fetches initial settings.
   */
  public constructor() {
    // Register callback to receive settings updates from SSE
    this.electron.onSettingsUpdate((settings: AppSettings): void => {
      this.updateFromSSE(settings);
    });

    // Fetch settings once serverUrl is available (SSE initial event may have been missed)
    this.serverUrlEffect = effect((): void => {
      const serverUrl: string = this.electron.serverUrl();
      if (serverUrl && !this.isLoaded()) {
        void this.fetchSettings();
      }
    });
  }

  /**
   * Cleans up resources when the service is destroyed.
   */
  public ngOnDestroy(): void {
    this.serverUrlEffect.destroy();
  }

  // ============================================================================
  // Computed Signals
  // ============================================================================

  /** The default visualization type */
  public readonly defaultVisualization: ReturnType<typeof computed<VisualizationType>> = computed(
    (): VisualizationType => this.settings().visualization.defaultType
  );

  /** Global sensitivity for visualizations (0.0 - 1.0) */
  public readonly sensitivity: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().visualization.sensitivity ?? 0.5
  );

  /** Per-visualization sensitivity overrides */
  public readonly perVisualizationSensitivity: ReturnType<typeof computed<PerVisualizationSensitivity>> = computed(
    (): PerVisualizationSensitivity => this.settings().visualization.perVisualizationSensitivity ?? {}
  );

  /** Maximum frame rate for visualizations (0 = uncapped) */
  public readonly maxFrameRate: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().visualization?.maxFrameRate ?? 0
  );

  /** Trail intensity for visualizations with trail effects (0.0 - 1.0) */
  public readonly trailIntensity: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().visualization?.trailIntensity ?? 0.5
  );

  /** Hue shift for visualization colors (0-360 degrees) */
  public readonly hueShift: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().visualization?.hueShift ?? 0
  );

  /** FFT size for audio analysis (256, 512, 1024, 2048, or 4096) */
  public readonly fftSize: ReturnType<typeof computed<FftSize>> = computed(
    (): FftSize => this.settings().visualization?.fftSize ?? 2048
  );

  /** Bar density for bar-based visualizations */
  public readonly barDensity: ReturnType<typeof computed<BarDensity>> = computed(
    (): BarDensity => this.settings().visualization?.barDensity ?? 'medium'
  );

  /** Configured server port (0 = auto-assign) */
  public readonly serverPort: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().application?.serverPort ?? 0
  );

  /** Controls auto-hide delay in seconds (0 = disabled) */
  public readonly controlsAutoHideDelay: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().application?.controlsAutoHideDelay ?? 5
  );

  /** Previous track threshold in seconds */
  public readonly previousTrackThreshold: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().playback?.previousTrackThreshold ?? 3
  );

  /** Line width for waveform visualizations (1.0 - 5.0) */
  public readonly lineWidth: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().visualization?.lineWidth ?? 2.0
  );

  /** Glow intensity for visualizations with glow effects (0.0 - 1.0) */
  public readonly glowIntensity: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().visualization?.glowIntensity ?? 0.5
  );

  /** Default volume on startup (0.0 - 1.0) */
  public readonly defaultVolume: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().playback?.defaultVolume ?? 0.5
  );

  /** Crossfade duration between tracks in milliseconds */
  public readonly crossfadeDuration: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().playback?.crossfadeDuration ?? 100
  );

  /** Video quality preset for transcoding */
  public readonly videoQuality: ReturnType<typeof computed<VideoQuality>> = computed(
    (): VideoQuality => this.settings().transcoding?.videoQuality ?? 'medium'
  );

  /** Audio bitrate for transcoding in kbps */
  public readonly audioBitrate: ReturnType<typeof computed<AudioBitrate>> = computed(
    (): AudioBitrate => this.settings().transcoding?.audioBitrate ?? 192
  );

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Generic helper for updating a setting via HTTP PUT.
   *
   * Reduces duplication across all setter methods by handling:
   * - Server URL check
   * - HTTP request construction
   * - Error logging
   *
   * @param category - Settings category ('visualization', 'application', 'playback', 'transcoding')
   * @param field - The field name to update
   * @param value - The value to set
   */
  private async updateSetting<T>(category: string, field: string, value: T): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    const response: Response = await fetch(`${serverUrl}/settings/${category}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({[field]: value}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save ${field}: ${response.status}`);
    }
  }

  /**
   * Clamps a number to a range.
   */
  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  /**
   * Updates the settings from an SSE event.
   *
   * Called by ElectronService when a settings:updated event is received.
   *
   * @param newSettings - The updated settings from the server
   */
  public updateFromSSE(newSettings: AppSettings): void {
    this.settings.set(newSettings);
    this.isLoaded.set(true);
  }

  /**
   * Sets the default visualization type.
   *
   * @param type - The visualization type to set as default
   */
  public async setDefaultVisualization(type: VisualizationType): Promise<void> {
    await this.updateSetting('visualization', 'defaultType', type);
  }

  /**
   * Sets the global visualization sensitivity.
   *
   * @param value - Sensitivity value between 0.0 and 1.0
   */
  public async setSensitivity(value: number): Promise<void> {
    await this.updateSetting('visualization', 'sensitivity', this.clamp(value, 0, 1));
  }

  /**
   * Sets the maximum frame rate for visualizations.
   *
   * @param fps - Frame rate (0 = uncapped, or 15/30/60)
   */
  public async setMaxFrameRate(fps: number): Promise<void> {
    const validFps: number = [0, 15, 30, 60].includes(fps) ? fps : 0;
    await this.updateSetting('visualization', 'maxFrameRate', validFps);
  }

  /**
   * Sets the trail intensity for visualizations.
   *
   * @param value - Trail intensity value between 0.0 and 1.0
   */
  public async setTrailIntensity(value: number): Promise<void> {
    await this.updateSetting('visualization', 'trailIntensity', this.clamp(value, 0, 1));
  }

  /**
   * Sets the hue shift for visualization colors.
   *
   * @param value - Hue shift value in degrees (0-360)
   */
  public async setHueShift(value: number): Promise<void> {
    const normalizedValue: number = ((value % 360) + 360) % 360;
    await this.updateSetting('visualization', 'hueShift', normalizedValue);
  }

  /**
   * Sets the FFT size for audio analysis.
   *
   * @param size - FFT size (256, 512, 1024, 2048, or 4096)
   */
  public async setFftSize(size: FftSize): Promise<void> {
    const validSizes: readonly FftSize[] = [256, 512, 1024, 2048, 4096];
    if (!validSizes.includes(size)) {
      console.error(`[SettingsService] Invalid FFT size: ${size}`);
      return;
    }
    await this.updateSetting('visualization', 'fftSize', size);
  }

  /**
   * Sets the bar density for bar-based visualizations.
   *
   * @param density - Bar density level ('low', 'medium', or 'high')
   */
  public async setBarDensity(density: BarDensity): Promise<void> {
    const validDensities: readonly BarDensity[] = ['low', 'medium', 'high'];
    if (!validDensities.includes(density)) {
      console.error(`[SettingsService] Invalid bar density: ${density}`);
      return;
    }
    await this.updateSetting('visualization', 'barDensity', density);
  }

  /**
   * Gets the effective sensitivity for a specific visualization type.
   *
   * Returns the per-visualization sensitivity if set, otherwise the global sensitivity.
   *
   * @param type - The visualization type to get sensitivity for
   * @returns The effective sensitivity value (0.0 - 1.0)
   */
  public getEffectiveSensitivity(type: VisualizationType): number {
    const perViz: PerVisualizationSensitivity = this.perVisualizationSensitivity();
    return perViz[type] ?? this.sensitivity();
  }

  /**
   * Sets the sensitivity for a specific visualization type.
   *
   * @param type - The visualization type to set sensitivity for
   * @param value - Sensitivity value between 0.0 and 1.0
   */
  public async setVisualizationSensitivity(type: VisualizationType, value: number): Promise<void> {
    const clampedValue: number = this.clamp(value, 0, 1);
    await this.updateSetting('visualization', 'perVisualizationSensitivity', {[type]: clampedValue});
  }

  /**
   * Resets a visualization's sensitivity to use the global setting.
   *
   * @param type - The visualization type to reset
   */
  public async resetVisualizationSensitivity(type: VisualizationType): Promise<void> {
    const current: PerVisualizationSensitivity = {...this.perVisualizationSensitivity()};
    delete current[type];
    await this.updateSetting('visualization', 'perVisualizationSensitivity', current);
  }

  /**
   * Sets the server port for the media server.
   *
   * Note: Port changes require app restart to take effect.
   *
   * @param port - Port number (0 = auto-assign, or 1024-65535)
   */
  public async setServerPort(port: number): Promise<void> {
    const validPort: number = port === 0 ? 0 : this.clamp(Math.round(port), 1024, 65535);
    await this.updateSetting('application', 'serverPort', validPort);
  }

  /**
   * Sets the controls auto-hide delay.
   *
   * @param delay - Delay in seconds (0 = disabled, 1-30 valid range)
   */
  public async setControlsAutoHideDelay(delay: number): Promise<void> {
    await this.updateSetting('application', 'controlsAutoHideDelay', this.clamp(Math.round(delay), 0, 30));
  }

  /**
   * Sets the previous track threshold.
   *
   * @param threshold - Threshold in seconds (0-10 valid range)
   */
  public async setPreviousTrackThreshold(threshold: number): Promise<void> {
    await this.updateSetting('playback', 'previousTrackThreshold', this.clamp(Math.round(threshold), 0, 10));
  }

  /**
   * Sets the line width for waveform visualizations.
   *
   * @param width - Line width value between 1.0 and 5.0
   */
  public async setLineWidth(width: number): Promise<void> {
    await this.updateSetting('visualization', 'lineWidth', this.clamp(width, 1, 5));
  }

  /**
   * Sets the glow intensity for visualizations.
   *
   * @param intensity - Glow intensity value between 0.0 and 1.0
   */
  public async setGlowIntensity(intensity: number): Promise<void> {
    await this.updateSetting('visualization', 'glowIntensity', this.clamp(intensity, 0, 1));
  }

  /**
   * Sets the default volume for playback.
   *
   * @param volume - Volume value between 0.0 and 1.0
   */
  public async setDefaultVolume(volume: number): Promise<void> {
    await this.updateSetting('playback', 'defaultVolume', this.clamp(volume, 0, 1));
  }

  /**
   * Sets the crossfade duration between tracks.
   *
   * @param duration - Crossfade duration in milliseconds (0-500)
   */
  public async setCrossfadeDuration(duration: number): Promise<void> {
    await this.updateSetting('playback', 'crossfadeDuration', this.clamp(Math.round(duration), 0, 500));
  }

  /**
   * Sets the video quality preset for transcoding.
   *
   * @param quality - Video quality preset ('low', 'medium', or 'high')
   */
  public async setVideoQuality(quality: VideoQuality): Promise<void> {
    const validQualities: readonly VideoQuality[] = ['low', 'medium', 'high'];
    if (!validQualities.includes(quality)) {
      console.error(`[SettingsService] Invalid video quality: ${quality}`);
      return;
    }
    await this.updateSetting('transcoding', 'videoQuality', quality);
  }

  /**
   * Sets the audio bitrate for transcoding.
   *
   * @param bitrate - Audio bitrate in kbps (128, 192, 256, or 320)
   */
  public async setAudioBitrate(bitrate: AudioBitrate): Promise<void> {
    const validBitrates: readonly AudioBitrate[] = [128, 192, 256, 320];
    if (!validBitrates.includes(bitrate)) {
      console.error(`[SettingsService] Invalid audio bitrate: ${bitrate}`);
      return;
    }
    await this.updateSetting('transcoding', 'audioBitrate', bitrate);
  }

  /**
   * Fetches the current settings from the server.
   *
   * This is typically not needed as settings are sent via SSE on connection.
   * Useful for manual refresh or debugging.
   *
   * @returns Promise resolving to the current settings
   */
  public async fetchSettings(): Promise<AppSettings> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return DEFAULT_SETTINGS;

    const response: Response = await fetch(`${serverUrl}/settings`);
    if (!response.ok) {
      throw new Error(`Failed to fetch settings: ${response.statusText}`);
    }

    const settings: AppSettings = await response.json();
    this.settings.set(settings);
    this.isLoaded.set(true);
    return settings;
  }
}

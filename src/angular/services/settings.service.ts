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

import {Injectable, signal, computed, inject, effect} from '@angular/core';
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
  /** Previous track threshold in seconds (0-10, default 3) */
  readonly previousTrackThreshold: number;
}

/**
 * Playback settings.
 */
export interface PlaybackSettings {
  /** Default volume on startup (0.0 - 1.0, default 0.5) */
  readonly defaultVolume: number;
  /** Crossfade duration between tracks in milliseconds (0-500, default 100) */
  readonly crossfadeDuration: number;
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
    previousTrackThreshold: 3,
  },
  playback: {
    defaultVolume: 0.5,
    crossfadeDuration: 100,
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
export class SettingsService {
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
    effect((): void => {
      const serverUrl: string = this.electron.serverUrl();
      if (serverUrl && !this.isLoaded()) {
        void this.fetchSettings();
      }
    });
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
    (): number => this.settings().application?.previousTrackThreshold ?? 3
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
   * Makes an HTTP PUT request to update the server-side settings.
   * The update is broadcast to all clients via SSE.
   *
   * @param type - The visualization type to set as default
   */
  public async setDefaultVisualization(type: VisualizationType): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    const response: Response = await fetch(`${serverUrl}/settings/visualization`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({defaultType: type}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save settings: ${response.status}`);
    }
  }

  /**
   * Sets the global visualization sensitivity.
   *
   * Makes an HTTP PUT request to update the server-side settings.
   * The update is broadcast to all clients via SSE.
   *
   * @param value - Sensitivity value between 0.0 and 1.0
   */
  public async setSensitivity(value: number): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Clamp value to valid range
    const clampedValue: number = Math.max(0, Math.min(1, value));

    const response: Response = await fetch(`${serverUrl}/settings/visualization`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sensitivity: clampedValue}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save sensitivity: ${response.status}`);
    }
  }

  /**
   * Sets the maximum frame rate for visualizations.
   *
   * Makes an HTTP PUT request to update the server-side settings.
   * The update is broadcast to all clients via SSE.
   *
   * @param fps - Frame rate (0 = uncapped, or 15/30/60)
   */
  public async setMaxFrameRate(fps: number): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Validate: must be 0, 15, 30, or 60
    const validFps: number = [0, 15, 30, 60].includes(fps) ? fps : 0;

    const response: Response = await fetch(`${serverUrl}/settings/visualization`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({maxFrameRate: validFps}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save max frame rate: ${response.status}`);
    }
  }

  /**
   * Sets the trail intensity for visualizations.
   *
   * Controls how long visual trails persist in visualizations like
   * Tunnel, Pulsar, Water, and Flux.
   *
   * @param value - Trail intensity value between 0.0 and 1.0
   */
  public async setTrailIntensity(value: number): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Clamp value to valid range
    const clampedValue: number = Math.max(0, Math.min(1, value));

    const response: Response = await fetch(`${serverUrl}/settings/visualization`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({trailIntensity: clampedValue}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save trail intensity: ${response.status}`);
    }
  }

  /**
   * Sets the hue shift for visualization colors.
   *
   * Rotates all visualization colors by the specified amount.
   *
   * @param value - Hue shift value in degrees (0-360)
   */
  public async setHueShift(value: number): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Normalize to 0-360 range
    const normalizedValue: number = ((value % 360) + 360) % 360;

    const response: Response = await fetch(`${serverUrl}/settings/visualization`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({hueShift: normalizedValue}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save hue shift: ${response.status}`);
    }
  }

  /**
   * Sets the FFT size for audio analysis.
   *
   * Higher values provide more frequency resolution but require more processing.
   *
   * @param size - FFT size (256, 512, 1024, 2048, or 4096)
   */
  public async setFftSize(size: FftSize): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Validate: must be a valid FFT size
    const validSizes: readonly FftSize[] = [256, 512, 1024, 2048, 4096];
    if (!validSizes.includes(size)) {
      console.error(`[SettingsService] Invalid FFT size: ${size}`);
      return;
    }

    const response: Response = await fetch(`${serverUrl}/settings/visualization`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({fftSize: size}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save FFT size: ${response.status}`);
    }
  }

  /**
   * Sets the bar density for bar-based visualizations.
   *
   * Affects Analyzer and Spectre visualizations:
   * - low: Fewer bars, better performance
   * - medium: Default bar count
   * - high: More bars, more detail
   *
   * @param density - Bar density level ('low', 'medium', or 'high')
   */
  public async setBarDensity(density: BarDensity): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Validate: must be a valid bar density
    const validDensities: readonly BarDensity[] = ['low', 'medium', 'high'];
    if (!validDensities.includes(density)) {
      console.error(`[SettingsService] Invalid bar density: ${density}`);
      return;
    }

    const response: Response = await fetch(`${serverUrl}/settings/visualization`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({barDensity: density}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save bar density: ${response.status}`);
    }
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
   * Makes an HTTP PUT request to update the server-side settings.
   * The update is broadcast to all clients via SSE.
   *
   * @param type - The visualization type to set sensitivity for
   * @param value - Sensitivity value between 0.0 and 1.0
   */
  public async setVisualizationSensitivity(type: VisualizationType, value: number): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Clamp value to valid range
    const clampedValue: number = Math.max(0, Math.min(1, value));

    const response: Response = await fetch(`${serverUrl}/settings/visualization`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({perVisualizationSensitivity: {[type]: clampedValue}}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save visualization sensitivity: ${response.status}`);
    }
  }

  /**
   * Resets a visualization's sensitivity to use the global setting.
   *
   * Removes the per-visualization override, causing the visualization to
   * use the global sensitivity value.
   *
   * @param type - The visualization type to reset
   */
  public async resetVisualizationSensitivity(type: VisualizationType): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Get current per-viz settings and remove this type
    const current: PerVisualizationSensitivity = {...this.perVisualizationSensitivity()};
    delete current[type];

    const response: Response = await fetch(`${serverUrl}/settings/visualization`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      // Send the full object to replace (not merge)
      body: JSON.stringify({perVisualizationSensitivity: current}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to reset visualization sensitivity: ${response.status}`);
    }
  }

  /**
   * Sets the server port for the media server.
   *
   * Note: Port changes require app restart to take effect.
   *
   * @param port - Port number (0 = auto-assign, or 1024-65535)
   */
  public async setServerPort(port: number): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Validate port: 0 (auto) or valid user port range
    const validPort: number = port === 0 ? 0 : Math.max(1024, Math.min(65535, Math.round(port)));

    const response: Response = await fetch(`${serverUrl}/settings/application`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({serverPort: validPort}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save server port: ${response.status}`);
    }
  }

  /**
   * Sets the controls auto-hide delay.
   *
   * @param delay - Delay in seconds (0 = disabled, 1-30 valid range)
   */
  public async setControlsAutoHideDelay(delay: number): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Validate delay: 0 (disabled) or 1-30 seconds
    const validDelay: number = Math.max(0, Math.min(30, Math.round(delay)));

    const response: Response = await fetch(`${serverUrl}/settings/application`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({controlsAutoHideDelay: validDelay}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save auto-hide delay: ${response.status}`);
    }
  }

  /**
   * Sets the previous track threshold.
   *
   * When playback is past this threshold, pressing "previous" restarts the current
   * track instead of going to the previous track.
   *
   * @param threshold - Threshold in seconds (0-10 valid range)
   */
  public async setPreviousTrackThreshold(threshold: number): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Validate threshold: 0-10 seconds
    const validThreshold: number = Math.max(0, Math.min(10, Math.round(threshold)));

    const response: Response = await fetch(`${serverUrl}/settings/application`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({previousTrackThreshold: validThreshold}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save previous track threshold: ${response.status}`);
    }
  }

  /**
   * Sets the line width for waveform visualizations.
   *
   * @param width - Line width value between 1.0 and 5.0
   */
  public async setLineWidth(width: number): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Clamp value to valid range
    const clampedValue: number = Math.max(1, Math.min(5, width));

    const response: Response = await fetch(`${serverUrl}/settings/visualization`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({lineWidth: clampedValue}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save line width: ${response.status}`);
    }
  }

  /**
   * Sets the glow intensity for visualizations.
   *
   * @param intensity - Glow intensity value between 0.0 and 1.0
   */
  public async setGlowIntensity(intensity: number): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Clamp value to valid range
    const clampedValue: number = Math.max(0, Math.min(1, intensity));

    const response: Response = await fetch(`${serverUrl}/settings/visualization`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({glowIntensity: clampedValue}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save glow intensity: ${response.status}`);
    }
  }

  /**
   * Sets the default volume for playback.
   *
   * @param volume - Volume value between 0.0 and 1.0
   */
  public async setDefaultVolume(volume: number): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Clamp value to valid range
    const clampedValue: number = Math.max(0, Math.min(1, volume));

    const response: Response = await fetch(`${serverUrl}/settings/playback`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({defaultVolume: clampedValue}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save default volume: ${response.status}`);
    }
  }

  /**
   * Sets the crossfade duration between tracks.
   *
   * @param duration - Crossfade duration in milliseconds (0-500)
   */
  public async setCrossfadeDuration(duration: number): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Clamp value to valid range
    const clampedValue: number = Math.max(0, Math.min(500, Math.round(duration)));

    const response: Response = await fetch(`${serverUrl}/settings/playback`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({crossfadeDuration: clampedValue}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save crossfade duration: ${response.status}`);
    }
  }

  /**
   * Sets the video quality preset for transcoding.
   *
   * @param quality - Video quality preset ('low', 'medium', or 'high')
   */
  public async setVideoQuality(quality: VideoQuality): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Validate: must be a valid video quality
    const validQualities: readonly VideoQuality[] = ['low', 'medium', 'high'];
    if (!validQualities.includes(quality)) {
      console.error(`[SettingsService] Invalid video quality: ${quality}`);
      return;
    }

    const response: Response = await fetch(`${serverUrl}/settings/transcoding`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({videoQuality: quality}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save video quality: ${response.status}`);
    }
  }

  /**
   * Sets the audio bitrate for transcoding.
   *
   * @param bitrate - Audio bitrate in kbps (128, 192, 256, or 320)
   */
  public async setAudioBitrate(bitrate: AudioBitrate): Promise<void> {
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    // Validate: must be a valid audio bitrate
    const validBitrates: readonly AudioBitrate[] = [128, 192, 256, 320];
    if (!validBitrates.includes(bitrate)) {
      console.error(`[SettingsService] Invalid audio bitrate: ${bitrate}`);
      return;
    }

    const response: Response = await fetch(`${serverUrl}/settings/transcoding`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({audioBitrate: bitrate}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save audio bitrate: ${response.status}`);
    }
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

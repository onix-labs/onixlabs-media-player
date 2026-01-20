/**
 * @fileoverview Settings persistence manager for the media player.
 *
 * This module provides persistent storage for user preferences using a JSON file
 * stored in the Electron userData directory. Settings are loaded at startup and
 * saved atomically to prevent data corruption.
 *
 * File location: `app.getPath('userData')/settings.json`
 * - macOS: ~/Library/Application Support/ONIXLabs Media Player/settings.json
 * - Windows: %APPDATA%/ONIXLabs Media Player/settings.json
 * - Linux: ~/.config/ONIXLabs Media Player/settings.json
 *
 * @module electron/settings-manager
 */

import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

/**
 * Visualization type identifiers.
 *
 * These correspond to the visualization classes in the Angular app:
 * - bars: BarsVisualization (frequency bars)
 * - waveform: WaveformVisualization (oscilloscope)
 * - tether: SpectreVisualization (symmetrical bars with smoke effect)
 * - tunnel: TunnelVisualization (dual waveforms with zoom)
 * - neon: NeonVisualization (rotating cyan/magenta waveforms)
 * - pulsar: PulsarVisualization (pulsing concentric rings, space category)
 * - water: WaterVisualization (water ripple effect, ambience category)
 * - flux: FluxVisualization (dual orbiting circles with spectrum cycling)
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
 * - low: Fewer bars, better performance
 * - medium: Default balance
 * - high: More bars, more detail
 */
export type BarDensity = 'low' | 'medium' | 'high';

/**
 * Video quality preset levels for transcoding.
 * - low: CRF 28, faster encoding, smaller files
 * - medium: CRF 23, balanced quality/size
 * - high: CRF 18, better quality, larger files
 */
export type VideoQuality = 'low' | 'medium' | 'high';

/**
 * Audio bitrate options for transcoding (kbps).
 */
export type AudioBitrate = 128 | 192 | 256 | 320;

/**
 * Visualization settings.
 */
export interface VisualizationSettings {
  /** The default visualization to display on startup */
  readonly defaultType: VisualizationType;
  /** Global sensitivity for all visualizations (0.0 - 1.0, default 0.5) */
  readonly sensitivity: number;
  /** Per-visualization sensitivity overrides (0.0 - 1.0, optional per type) */
  readonly perVisualizationSensitivity: PerVisualizationSensitivity;
  /** Maximum frame rate for visualizations (0 = uncapped, or 15/30/60, default 0) */
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
  /** Previous track threshold in seconds (0-10, default 3) - if playback is past this, restart instead of previous */
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
 * Window bounds (position and size).
 */
export interface WindowBounds {
  /** X position of the window */
  readonly x: number;
  /** Y position of the window */
  readonly y: number;
  /** Width of the window */
  readonly width: number;
  /** Height of the window */
  readonly height: number;
}

/**
 * Window state settings (not exposed in UI).
 * Used to remember window positions and sizes between sessions.
 */
export interface WindowStateSettings {
  /** Last miniplayer bounds, or null if never set */
  readonly miniplayerBounds: WindowBounds | null;
}

/**
 * Complete application settings structure.
 *
 * Version field enables future migrations when the schema changes.
 */
export interface AppSettings {
  /** Settings schema version (for future migrations) */
  readonly version: number;
  /** Visualization preferences */
  readonly visualization: VisualizationSettings;
  /** Application-level settings */
  readonly application: ApplicationSettings;
  /** Playback settings */
  readonly playback: PlaybackSettings;
  /** Transcoding settings */
  readonly transcoding: TranscodingSettings;
  /** Window state settings (not exposed in UI) */
  readonly windowState: WindowStateSettings;
}

/**
 * Partial visualization settings for updates.
 */
export interface VisualizationSettingsUpdate {
  readonly defaultType?: VisualizationType;
  readonly sensitivity?: number;
  readonly perVisualizationSensitivity?: PerVisualizationSensitivity;
  readonly maxFrameRate?: number;
  readonly trailIntensity?: number;
  readonly hueShift?: number;
  readonly fftSize?: FftSize;
  readonly barDensity?: BarDensity;
  readonly lineWidth?: number;
  readonly glowIntensity?: number;
}

/**
 * Partial application settings for updates.
 */
export interface ApplicationSettingsUpdate {
  readonly serverPort?: number;
  readonly controlsAutoHideDelay?: number;
  readonly previousTrackThreshold?: number;
}

/**
 * Partial playback settings for updates.
 */
export interface PlaybackSettingsUpdate {
  readonly defaultVolume?: number;
  readonly crossfadeDuration?: number;
}

/**
 * Partial transcoding settings for updates.
 */
export interface TranscodingSettingsUpdate {
  readonly videoQuality?: VideoQuality;
  readonly audioBitrate?: AudioBitrate;
}

// ============================================================================
// Constants
// ============================================================================

/** Current settings schema version */
const SETTINGS_VERSION: number = 1;

/** Valid FFT size values */
const VALID_FFT_SIZES: readonly FftSize[] = [256, 512, 1024, 2048, 4096];

/** Valid bar density values */
const VALID_BAR_DENSITIES: readonly BarDensity[] = ['low', 'medium', 'high'];

/** Valid video quality values */
const VALID_VIDEO_QUALITIES: readonly VideoQuality[] = ['low', 'medium', 'high'];

/** Valid audio bitrate values */
const VALID_AUDIO_BITRATES: readonly AudioBitrate[] = [128, 192, 256, 320];

/** Default settings used when no file exists or on parse error */
const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  visualization: {
    defaultType: 'bars',
    sensitivity: 0.5,
    perVisualizationSensitivity: {},
    maxFrameRate: 0,  // 0 = uncapped
    trailIntensity: 0.5,  // 0.5 = default trail persistence
    hueShift: 0,  // 0 = no color shift
    fftSize: 2048,  // 2048 = balanced resolution/performance
    barDensity: 'medium',  // medium = default bar count
    lineWidth: 2.0,  // 2.0 = default line width
    glowIntensity: 0.5,  // 0.5 = default glow intensity
  },
  application: {
    serverPort: 0,  // 0 = auto-assign
    controlsAutoHideDelay: 5,  // 5 seconds default
    previousTrackThreshold: 3,  // 3 seconds default
  },
  playback: {
    defaultVolume: 0.5,  // 50% default volume
    crossfadeDuration: 100,  // 100ms crossfade
  },
  transcoding: {
    videoQuality: 'medium',  // medium = CRF 23
    audioBitrate: 192,  // 192 kbps
  },
  windowState: {
    miniplayerBounds: null,  // no saved position initially
  },
};

/** Valid visualization type values for validation */
const VALID_VISUALIZATION_TYPES: readonly VisualizationType[] = [
  'bars',
  'waveform',
  'tether',
  'tunnel',
  'neon',
  'pulsar',
  'water',
  'flux',
];

// ============================================================================
// SettingsManager Class
// ============================================================================

/**
 * Manages persistent settings storage for the media player.
 *
 * Settings are stored in a JSON file in the Electron userData directory.
 * The manager provides:
 * - Atomic file writes (write to temp, then rename)
 * - Schema validation with defaults for missing/invalid values
 * - Type-safe getter and update methods
 *
 * @example
 * const manager = new SettingsManager();
 * const settings = manager.getSettings();
 * console.log(settings.visualization.defaultType); // 'bars'
 *
 * manager.updateVisualizationSettings({ defaultType: 'waveform' });
 */
export class SettingsManager {
  /** Path to the settings JSON file */
  private readonly settingsPath: string;

  /** Current settings in memory */
  private settings: AppSettings;

  /**
   * Creates a new SettingsManager and loads settings from disk.
   *
   * If the settings file doesn't exist or is invalid, defaults are used.
   */
  public constructor() {
    this.settingsPath = path.join(app.getPath('userData'), 'settings.json');
    this.settings = this.load();
  }

  // ==========================================================================
  // Public Methods
  // ==========================================================================

  /**
   * Gets the current settings.
   *
   * @returns The current application settings
   */
  public getSettings(): AppSettings {
    return this.settings;
  }

  /**
   * Updates visualization settings with partial values.
   *
   * Only provided fields are updated; others retain their current values.
   * Changes are immediately persisted to disk.
   *
   * @param update - Partial visualization settings to apply
   * @returns The updated complete settings object
   */
  public updateVisualizationSettings(update: VisualizationSettingsUpdate): AppSettings {
    // Validate defaultType if provided
    if (update.defaultType !== undefined) {
      if (!this.isValidVisualizationType(update.defaultType)) {
        console.warn(`[SettingsManager] Invalid visualization type: ${update.defaultType}, ignoring`);
        return this.settings;
      }
    }

    // Validate sensitivity if provided
    if (update.sensitivity !== undefined) {
      if (!this.isValidSensitivity(update.sensitivity)) {
        console.warn(`[SettingsManager] Invalid sensitivity value: ${update.sensitivity}, ignoring`);
        return this.settings;
      }
    }

    // Validate and merge per-visualization sensitivity if provided
    let mergedPerVizSensitivity: PerVisualizationSensitivity = this.settings.visualization.perVisualizationSensitivity;
    if (update.perVisualizationSensitivity !== undefined) {
      const validatedUpdate: PerVisualizationSensitivity = this.validatePerVisualizationSensitivity(update.perVisualizationSensitivity);
      mergedPerVizSensitivity = {
        ...this.settings.visualization.perVisualizationSensitivity,
        ...validatedUpdate,
      };
    }

    // Validate maxFrameRate if provided
    if (update.maxFrameRate !== undefined) {
      if (!this.isValidMaxFrameRate(update.maxFrameRate)) {
        console.warn(`[SettingsManager] Invalid max frame rate: ${update.maxFrameRate}, ignoring`);
        return this.settings;
      }
    }

    // Validate trailIntensity if provided
    if (update.trailIntensity !== undefined) {
      if (!this.isValidTrailIntensity(update.trailIntensity)) {
        console.warn(`[SettingsManager] Invalid trail intensity: ${update.trailIntensity}, ignoring`);
        return this.settings;
      }
    }

    // Validate hueShift if provided
    if (update.hueShift !== undefined) {
      if (!this.isValidHueShift(update.hueShift)) {
        console.warn(`[SettingsManager] Invalid hue shift: ${update.hueShift}, ignoring`);
        return this.settings;
      }
    }

    // Validate fftSize if provided
    if (update.fftSize !== undefined) {
      if (!this.isValidFftSize(update.fftSize)) {
        console.warn(`[SettingsManager] Invalid FFT size: ${update.fftSize}, ignoring`);
        return this.settings;
      }
    }

    // Validate barDensity if provided
    if (update.barDensity !== undefined) {
      if (!this.isValidBarDensity(update.barDensity)) {
        console.warn(`[SettingsManager] Invalid bar density: ${update.barDensity}, ignoring`);
        return this.settings;
      }
    }

    // Validate lineWidth if provided
    if (update.lineWidth !== undefined) {
      if (!this.isValidLineWidth(update.lineWidth)) {
        console.warn(`[SettingsManager] Invalid line width: ${update.lineWidth}, ignoring`);
        return this.settings;
      }
    }

    // Validate glowIntensity if provided
    if (update.glowIntensity !== undefined) {
      if (!this.isValidGlowIntensity(update.glowIntensity)) {
        console.warn(`[SettingsManager] Invalid glow intensity: ${update.glowIntensity}, ignoring`);
        return this.settings;
      }
    }

    // Merge the update
    this.settings = {
      ...this.settings,
      visualization: {
        ...this.settings.visualization,
        defaultType: update.defaultType ?? this.settings.visualization.defaultType,
        sensitivity: update.sensitivity ?? this.settings.visualization.sensitivity,
        perVisualizationSensitivity: mergedPerVizSensitivity,
        maxFrameRate: update.maxFrameRate ?? this.settings.visualization.maxFrameRate,
        trailIntensity: update.trailIntensity ?? this.settings.visualization.trailIntensity,
        hueShift: update.hueShift ?? this.settings.visualization.hueShift,
        fftSize: update.fftSize ?? this.settings.visualization.fftSize,
        barDensity: update.barDensity ?? this.settings.visualization.barDensity,
        lineWidth: update.lineWidth ?? this.settings.visualization.lineWidth,
        glowIntensity: update.glowIntensity ?? this.settings.visualization.glowIntensity,
      },
    };

    this.save();
    return this.settings;
  }

  /**
   * Updates application settings with partial values.
   *
   * Only provided fields are updated; others retain their current values.
   * Changes are immediately persisted to disk.
   *
   * @param update - Partial application settings to apply
   * @returns The updated complete settings object
   */
  public updateApplicationSettings(update: ApplicationSettingsUpdate): AppSettings {
    // Validate serverPort if provided
    if (update.serverPort !== undefined) {
      if (!this.isValidPort(update.serverPort)) {
        console.warn(`[SettingsManager] Invalid server port: ${update.serverPort}, ignoring`);
        return this.settings;
      }
    }

    // Validate controlsAutoHideDelay if provided
    if (update.controlsAutoHideDelay !== undefined) {
      if (!this.isValidAutoHideDelay(update.controlsAutoHideDelay)) {
        console.warn(`[SettingsManager] Invalid auto-hide delay: ${update.controlsAutoHideDelay}, ignoring`);
        return this.settings;
      }
    }

    // Validate previousTrackThreshold if provided
    if (update.previousTrackThreshold !== undefined) {
      if (!this.isValidPreviousTrackThreshold(update.previousTrackThreshold)) {
        console.warn(`[SettingsManager] Invalid previous track threshold: ${update.previousTrackThreshold}, ignoring`);
        return this.settings;
      }
    }

    // Merge the update
    this.settings = {
      ...this.settings,
      application: {
        ...this.settings.application,
        serverPort: update.serverPort ?? this.settings.application.serverPort,
        controlsAutoHideDelay: update.controlsAutoHideDelay ?? this.settings.application.controlsAutoHideDelay,
        previousTrackThreshold: update.previousTrackThreshold ?? this.settings.application.previousTrackThreshold,
      },
    };

    this.save();
    return this.settings;
  }

  /**
   * Updates playback settings with partial values.
   *
   * Only provided fields are updated; others retain their current values.
   * Changes are immediately persisted to disk.
   *
   * @param update - Partial playback settings to apply
   * @returns The updated complete settings object
   */
  public updatePlaybackSettings(update: PlaybackSettingsUpdate): AppSettings {
    // Validate defaultVolume if provided
    if (update.defaultVolume !== undefined) {
      if (!this.isValidVolume(update.defaultVolume)) {
        console.warn(`[SettingsManager] Invalid default volume: ${update.defaultVolume}, ignoring`);
        return this.settings;
      }
    }

    // Validate crossfadeDuration if provided
    if (update.crossfadeDuration !== undefined) {
      if (!this.isValidCrossfadeDuration(update.crossfadeDuration)) {
        console.warn(`[SettingsManager] Invalid crossfade duration: ${update.crossfadeDuration}, ignoring`);
        return this.settings;
      }
    }

    // Merge the update
    this.settings = {
      ...this.settings,
      playback: {
        ...this.settings.playback,
        defaultVolume: update.defaultVolume ?? this.settings.playback.defaultVolume,
        crossfadeDuration: update.crossfadeDuration ?? this.settings.playback.crossfadeDuration,
      },
    };

    this.save();
    return this.settings;
  }

  /**
   * Updates transcoding settings with partial values.
   *
   * Only provided fields are updated; others retain their current values.
   * Changes are immediately persisted to disk.
   *
   * @param update - Partial transcoding settings to apply
   * @returns The updated complete settings object
   */
  public updateTranscodingSettings(update: TranscodingSettingsUpdate): AppSettings {
    // Validate videoQuality if provided
    if (update.videoQuality !== undefined) {
      if (!this.isValidVideoQuality(update.videoQuality)) {
        console.warn(`[SettingsManager] Invalid video quality: ${update.videoQuality}, ignoring`);
        return this.settings;
      }
    }

    // Validate audioBitrate if provided
    if (update.audioBitrate !== undefined) {
      if (!this.isValidAudioBitrate(update.audioBitrate)) {
        console.warn(`[SettingsManager] Invalid audio bitrate: ${update.audioBitrate}, ignoring`);
        return this.settings;
      }
    }

    // Merge the update
    this.settings = {
      ...this.settings,
      transcoding: {
        ...this.settings.transcoding,
        videoQuality: update.videoQuality ?? this.settings.transcoding.videoQuality,
        audioBitrate: update.audioBitrate ?? this.settings.transcoding.audioBitrate,
      },
    };

    this.save();
    return this.settings;
  }

  /**
   * Sets the miniplayer bounds (position and size).
   *
   * This is a non-UI setting used to remember miniplayer position between sessions.
   * Changes are immediately persisted to disk.
   *
   * @param bounds - The window bounds to save, or null to clear
   * @returns The updated complete settings object
   */
  public setMiniplayerBounds(bounds: WindowBounds | null): AppSettings {
    // Validate bounds if provided
    if (bounds !== null && !this.isValidWindowBounds(bounds)) {
      console.warn('[SettingsManager] Invalid miniplayer bounds, ignoring');
      return this.settings;
    }

    this.settings = {
      ...this.settings,
      windowState: {
        ...this.settings.windowState,
        miniplayerBounds: bounds,
      },
    };

    this.save();
    return this.settings;
  }

  /**
   * Gets the saved miniplayer bounds.
   *
   * @returns The saved miniplayer bounds, or null if none saved
   */
  public getMiniplayerBounds(): WindowBounds | null {
    return this.settings.windowState.miniplayerBounds;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Loads settings from disk.
   *
   * If the file doesn't exist, returns defaults.
   * If the file is invalid JSON, logs an error and returns defaults.
   * Validates loaded settings and fills in missing values with defaults.
   *
   * @returns The loaded settings, or defaults if unavailable
   */
  private load(): AppSettings {
    if (!existsSync(this.settingsPath)) {
      console.log('[SettingsManager] No settings file found, using defaults');
      return DEFAULT_SETTINGS;
    }

    try {
      const raw: string = readFileSync(this.settingsPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      return this.validateAndMerge(parsed);
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      console.error(`[SettingsManager] Failed to load settings: ${message}`);
      return DEFAULT_SETTINGS;
    }
  }

  /**
   * Saves current settings to disk atomically.
   *
   * Uses write-to-temp-then-rename pattern to prevent corruption
   * if the process crashes mid-write.
   */
  private save(): void {
    const tempPath: string = `${this.settingsPath}.tmp`;

    try {
      // Write to temporary file
      writeFileSync(tempPath, JSON.stringify(this.settings, null, 2), 'utf-8');

      // Atomic rename (replaces existing file)
      renameSync(tempPath, this.settingsPath);

      console.log('[SettingsManager] Settings saved successfully');
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      console.error(`[SettingsManager] Failed to save settings: ${message}`);

      // Clean up temp file if it exists
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Validates loaded settings and merges with defaults for missing values.
   *
   * Ensures all required fields exist and have valid values.
   * Unknown fields are preserved for forward compatibility.
   *
   * @param parsed - The parsed JSON data (type unknown)
   * @returns Valid settings object with defaults for missing/invalid values
   */
  private validateAndMerge(parsed: unknown): AppSettings {
    if (!parsed || typeof parsed !== 'object') {
      console.warn('[SettingsManager] Invalid settings format, using defaults');
      return DEFAULT_SETTINGS;
    }

    const obj: Record<string, unknown> = parsed as Record<string, unknown>;

    // Extract and validate visualization settings
    const vizSettings: VisualizationSettings = this.validateVisualizationSettings(
      obj['visualization']
    );

    // Extract and validate application settings
    const appSettings: ApplicationSettings = this.validateApplicationSettings(
      obj['application']
    );

    // Extract and validate playback settings
    const playbackSettings: PlaybackSettings = this.validatePlaybackSettings(
      obj['playback']
    );

    // Extract and validate transcoding settings
    const transcodingSettings: TranscodingSettings = this.validateTranscodingSettings(
      obj['transcoding']
    );

    // Extract and validate window state settings
    const windowStateSettings: WindowStateSettings = this.validateWindowStateSettings(
      obj['windowState']
    );

    return {
      version: typeof obj['version'] === 'number' ? obj['version'] : SETTINGS_VERSION,
      visualization: vizSettings,
      application: appSettings,
      playback: playbackSettings,
      transcoding: transcodingSettings,
      windowState: windowStateSettings,
    };
  }

  /**
   * Validates visualization settings object.
   *
   * @param viz - The visualization settings to validate (unknown type)
   * @returns Valid visualization settings with defaults for invalid values
   */
  private validateVisualizationSettings(viz: unknown): VisualizationSettings {
    if (!viz || typeof viz !== 'object') {
      return DEFAULT_SETTINGS.visualization;
    }

    const vizObj: Record<string, unknown> = viz as Record<string, unknown>;
    const defaultType: unknown = vizObj['defaultType'];
    const sensitivity: unknown = vizObj['sensitivity'];
    const perVizSensitivity: unknown = vizObj['perVisualizationSensitivity'];
    const maxFrameRate: unknown = vizObj['maxFrameRate'];
    const trailIntensity: unknown = vizObj['trailIntensity'];
    const hueShift: unknown = vizObj['hueShift'];
    const fftSize: unknown = vizObj['fftSize'];
    const barDensity: unknown = vizObj['barDensity'];
    const lineWidth: unknown = vizObj['lineWidth'];
    const glowIntensity: unknown = vizObj['glowIntensity'];

    return {
      defaultType: this.isValidVisualizationType(defaultType)
        ? defaultType
        : DEFAULT_SETTINGS.visualization.defaultType,
      sensitivity: this.isValidSensitivity(sensitivity)
        ? sensitivity
        : DEFAULT_SETTINGS.visualization.sensitivity,
      perVisualizationSensitivity: this.validatePerVisualizationSensitivity(perVizSensitivity),
      maxFrameRate: this.isValidMaxFrameRate(maxFrameRate)
        ? maxFrameRate
        : DEFAULT_SETTINGS.visualization.maxFrameRate,
      trailIntensity: this.isValidTrailIntensity(trailIntensity)
        ? trailIntensity
        : DEFAULT_SETTINGS.visualization.trailIntensity,
      hueShift: this.isValidHueShift(hueShift)
        ? hueShift
        : DEFAULT_SETTINGS.visualization.hueShift,
      fftSize: this.isValidFftSize(fftSize)
        ? fftSize
        : DEFAULT_SETTINGS.visualization.fftSize,
      barDensity: this.isValidBarDensity(barDensity)
        ? barDensity
        : DEFAULT_SETTINGS.visualization.barDensity,
      lineWidth: this.isValidLineWidth(lineWidth)
        ? lineWidth
        : DEFAULT_SETTINGS.visualization.lineWidth,
      glowIntensity: this.isValidGlowIntensity(glowIntensity)
        ? glowIntensity
        : DEFAULT_SETTINGS.visualization.glowIntensity,
    };
  }

  /**
   * Validates per-visualization sensitivity object.
   *
   * @param perViz - The per-visualization sensitivity to validate
   * @returns Valid per-visualization sensitivity with invalid entries removed
   */
  private validatePerVisualizationSensitivity(perViz: unknown): PerVisualizationSensitivity {
    if (!perViz || typeof perViz !== 'object') {
      return {};
    }

    const result: PerVisualizationSensitivity = {};
    const perVizObj: Record<string, unknown> = perViz as Record<string, unknown>;

    for (const key of Object.keys(perVizObj)) {
      if (this.isValidVisualizationType(key) && this.isValidSensitivity(perVizObj[key])) {
        result[key] = perVizObj[key] as number;
      }
    }

    return result;
  }

  /**
   * Type guard to check if a value is a valid sensitivity value.
   *
   * @param value - The value to check
   * @returns True if the value is a valid sensitivity (number between 0 and 1)
   */
  private isValidSensitivity(value: unknown): value is number {
    return typeof value === 'number' && value >= 0 && value <= 1;
  }

  /**
   * Type guard to check if a value is a valid VisualizationType.
   *
   * @param value - The value to check
   * @returns True if the value is a valid visualization type
   */
  private isValidVisualizationType(value: unknown): value is VisualizationType {
    return typeof value === 'string' && VALID_VISUALIZATION_TYPES.includes(value as VisualizationType);
  }

  /**
   * Validates application settings object.
   *
   * @param app - The application settings to validate (unknown type)
   * @returns Valid application settings with defaults for invalid values
   */
  private validateApplicationSettings(app: unknown): ApplicationSettings {
    if (!app || typeof app !== 'object') {
      return DEFAULT_SETTINGS.application;
    }

    const appObj: Record<string, unknown> = app as Record<string, unknown>;
    const serverPort: unknown = appObj['serverPort'];
    const controlsAutoHideDelay: unknown = appObj['controlsAutoHideDelay'];
    const previousTrackThreshold: unknown = appObj['previousTrackThreshold'];

    return {
      serverPort: this.isValidPort(serverPort)
        ? serverPort
        : DEFAULT_SETTINGS.application.serverPort,
      controlsAutoHideDelay: this.isValidAutoHideDelay(controlsAutoHideDelay)
        ? controlsAutoHideDelay
        : DEFAULT_SETTINGS.application.controlsAutoHideDelay,
      previousTrackThreshold: this.isValidPreviousTrackThreshold(previousTrackThreshold)
        ? previousTrackThreshold
        : DEFAULT_SETTINGS.application.previousTrackThreshold,
    };
  }

  /**
   * Validates playback settings object.
   *
   * @param playback - The playback settings to validate (unknown type)
   * @returns Valid playback settings with defaults for invalid values
   */
  private validatePlaybackSettings(playback: unknown): PlaybackSettings {
    if (!playback || typeof playback !== 'object') {
      return DEFAULT_SETTINGS.playback;
    }

    const playbackObj: Record<string, unknown> = playback as Record<string, unknown>;
    const defaultVolume: unknown = playbackObj['defaultVolume'];
    const crossfadeDuration: unknown = playbackObj['crossfadeDuration'];

    return {
      defaultVolume: this.isValidVolume(defaultVolume)
        ? defaultVolume
        : DEFAULT_SETTINGS.playback.defaultVolume,
      crossfadeDuration: this.isValidCrossfadeDuration(crossfadeDuration)
        ? crossfadeDuration
        : DEFAULT_SETTINGS.playback.crossfadeDuration,
    };
  }

  /**
   * Validates transcoding settings object.
   *
   * @param transcoding - The transcoding settings to validate (unknown type)
   * @returns Valid transcoding settings with defaults for invalid values
   */
  private validateTranscodingSettings(transcoding: unknown): TranscodingSettings {
    if (!transcoding || typeof transcoding !== 'object') {
      return DEFAULT_SETTINGS.transcoding;
    }

    const transcodingObj: Record<string, unknown> = transcoding as Record<string, unknown>;
    const videoQuality: unknown = transcodingObj['videoQuality'];
    const audioBitrate: unknown = transcodingObj['audioBitrate'];

    return {
      videoQuality: this.isValidVideoQuality(videoQuality)
        ? videoQuality
        : DEFAULT_SETTINGS.transcoding.videoQuality,
      audioBitrate: this.isValidAudioBitrate(audioBitrate)
        ? audioBitrate
        : DEFAULT_SETTINGS.transcoding.audioBitrate,
    };
  }

  /**
   * Validates window state settings object.
   *
   * @param windowState - The window state settings to validate (unknown type)
   * @returns Valid window state settings with defaults for invalid values
   */
  private validateWindowStateSettings(windowState: unknown): WindowStateSettings {
    if (!windowState || typeof windowState !== 'object') {
      return DEFAULT_SETTINGS.windowState;
    }

    const windowStateObj: Record<string, unknown> = windowState as Record<string, unknown>;
    const miniplayerBounds: unknown = windowStateObj['miniplayerBounds'];

    return {
      miniplayerBounds: this.isValidWindowBounds(miniplayerBounds) ? miniplayerBounds : null,
    };
  }

  /**
   * Type guard to check if a value is valid window bounds.
   *
   * @param value - The value to check
   * @returns True if the value is valid window bounds
   */
  private isValidWindowBounds(value: unknown): value is WindowBounds {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const obj: Record<string, unknown> = value as Record<string, unknown>;
    return (
      typeof obj['x'] === 'number' &&
      typeof obj['y'] === 'number' &&
      typeof obj['width'] === 'number' &&
      typeof obj['height'] === 'number' &&
      obj['width'] > 0 &&
      obj['height'] > 0
    );
  }

  /**
   * Type guard to check if a value is a valid port number.
   *
   * Valid ports are 0 (auto-assign) or 1024-65535 (user ports).
   *
   * @param value - The value to check
   * @returns True if the value is a valid port number
   */
  private isValidPort(value: unknown): value is number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return false;
    }
    // 0 = auto-assign, or valid user port range
    return value === 0 || (value >= 1024 && value <= 65535);
  }

  /**
   * Type guard to check if a value is a valid auto-hide delay.
   *
   * Valid values are 0 (disabled) or 1-30 seconds.
   *
   * @param value - The value to check
   * @returns True if the value is a valid auto-hide delay
   */
  private isValidAutoHideDelay(value: unknown): value is number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return false;
    }
    // 0 = disabled, or 1-30 seconds
    return value >= 0 && value <= 30;
  }

  /**
   * Type guard to check if a value is a valid previous track threshold.
   *
   * Valid values are 0-10 seconds.
   *
   * @param value - The value to check
   * @returns True if the value is a valid threshold
   */
  private isValidPreviousTrackThreshold(value: unknown): value is number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return false;
    }
    return value >= 0 && value <= 10;
  }

  /**
   * Type guard to check if a value is a valid max frame rate.
   *
   * Valid values are 0 (uncapped), 15, 30, or 60.
   *
   * @param value - The value to check
   * @returns True if the value is a valid frame rate
   */
  private isValidMaxFrameRate(value: unknown): value is number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return false;
    }
    // 0 = uncapped, or specific FPS values
    return value === 0 || value === 15 || value === 30 || value === 60;
  }

  /**
   * Type guard to check if a value is a valid trail intensity.
   *
   * Valid values are between 0.0 and 1.0.
   *
   * @param value - The value to check
   * @returns True if the value is a valid trail intensity
   */
  private isValidTrailIntensity(value: unknown): value is number {
    return typeof value === 'number' && value >= 0 && value <= 1;
  }

  /**
   * Type guard to check if a value is a valid hue shift.
   *
   * Valid values are between 0 and 360 (degrees).
   *
   * @param value - The value to check
   * @returns True if the value is a valid hue shift
   */
  private isValidHueShift(value: unknown): value is number {
    return typeof value === 'number' && value >= 0 && value <= 360;
  }

  /**
   * Type guard to check if a value is a valid FFT size.
   *
   * Valid values are powers of 2: 256, 512, 1024, 2048, 4096.
   *
   * @param value - The value to check
   * @returns True if the value is a valid FFT size
   */
  private isValidFftSize(value: unknown): value is FftSize {
    return typeof value === 'number' && VALID_FFT_SIZES.includes(value as FftSize);
  }

  /**
   * Type guard to check if a value is a valid bar density.
   *
   * Valid values are 'low', 'medium', or 'high'.
   *
   * @param value - The value to check
   * @returns True if the value is a valid bar density
   */
  private isValidBarDensity(value: unknown): value is BarDensity {
    return typeof value === 'string' && VALID_BAR_DENSITIES.includes(value as BarDensity);
  }

  /**
   * Type guard to check if a value is a valid line width.
   *
   * Valid values are between 1.0 and 5.0.
   *
   * @param value - The value to check
   * @returns True if the value is a valid line width
   */
  private isValidLineWidth(value: unknown): value is number {
    return typeof value === 'number' && value >= 1 && value <= 5;
  }

  /**
   * Type guard to check if a value is a valid glow intensity.
   *
   * Valid values are between 0.0 and 1.0.
   *
   * @param value - The value to check
   * @returns True if the value is a valid glow intensity
   */
  private isValidGlowIntensity(value: unknown): value is number {
    return typeof value === 'number' && value >= 0 && value <= 1;
  }

  /**
   * Type guard to check if a value is a valid volume.
   *
   * Valid values are between 0.0 and 1.0.
   *
   * @param value - The value to check
   * @returns True if the value is a valid volume
   */
  private isValidVolume(value: unknown): value is number {
    return typeof value === 'number' && value >= 0 && value <= 1;
  }

  /**
   * Type guard to check if a value is a valid crossfade duration.
   *
   * Valid values are integers between 0 and 500 milliseconds.
   *
   * @param value - The value to check
   * @returns True if the value is a valid crossfade duration
   */
  private isValidCrossfadeDuration(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 500;
  }

  /**
   * Type guard to check if a value is a valid video quality.
   *
   * Valid values are 'low', 'medium', or 'high'.
   *
   * @param value - The value to check
   * @returns True if the value is a valid video quality
   */
  private isValidVideoQuality(value: unknown): value is VideoQuality {
    return typeof value === 'string' && VALID_VIDEO_QUALITIES.includes(value as VideoQuality);
  }

  /**
   * Type guard to check if a value is a valid audio bitrate.
   *
   * Valid values are 128, 192, 256, or 320 kbps.
   *
   * @param value - The value to check
   * @returns True if the value is a valid audio bitrate
   */
  private isValidAudioBitrate(value: unknown): value is AudioBitrate {
    return typeof value === 'number' && VALID_AUDIO_BITRATES.includes(value as AudioBitrate);
  }
}

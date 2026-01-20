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
}

/**
 * Partial visualization settings for updates.
 */
export interface VisualizationSettingsUpdate {
  readonly defaultType?: VisualizationType;
  readonly sensitivity?: number;
  readonly perVisualizationSensitivity?: PerVisualizationSensitivity;
  readonly maxFrameRate?: number;
}

/**
 * Partial application settings for updates.
 */
export interface ApplicationSettingsUpdate {
  readonly serverPort?: number;
  readonly controlsAutoHideDelay?: number;
  readonly previousTrackThreshold?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Current settings schema version */
const SETTINGS_VERSION: number = 1;

/** Default settings used when no file exists or on parse error */
const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  visualization: {
    defaultType: 'bars',
    sensitivity: 0.5,
    perVisualizationSensitivity: {},
    maxFrameRate: 0,  // 0 = uncapped
  },
  application: {
    serverPort: 0,  // 0 = auto-assign
    controlsAutoHideDelay: 5,  // 5 seconds default
    previousTrackThreshold: 3,  // 3 seconds default
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

    // Merge the update
    this.settings = {
      ...this.settings,
      visualization: {
        ...this.settings.visualization,
        defaultType: update.defaultType ?? this.settings.visualization.defaultType,
        sensitivity: update.sensitivity ?? this.settings.visualization.sensitivity,
        perVisualizationSensitivity: mergedPerVizSensitivity,
        maxFrameRate: update.maxFrameRate ?? this.settings.visualization.maxFrameRate,
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

    return {
      version: typeof obj['version'] === 'number' ? obj['version'] : SETTINGS_VERSION,
      visualization: vizSettings,
      application: appSettings,
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
}

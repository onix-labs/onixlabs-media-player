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
 * - tunnel: TunnelVisualization (dual waveforms with zoom)
 * - neon: NeonVisualization (rotating cyan/magenta waveforms)
 * - pulsar: PulsarVisualization (pulsing concentric rings, space category)
 * - water: WaterVisualization (water ripple effect, ambience category)
 */
export type VisualizationType = 'bars' | 'waveform' | 'tunnel' | 'neon' | 'pulsar' | 'water';

/**
 * Visualization settings.
 */
export interface VisualizationSettings {
  /** The default visualization to display on startup */
  readonly defaultType: VisualizationType;
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
}

/**
 * Partial visualization settings for updates.
 */
export interface VisualizationSettingsUpdate {
  readonly defaultType?: VisualizationType;
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
  },
};

/** Valid visualization type values for validation */
const VALID_VISUALIZATION_TYPES: readonly VisualizationType[] = [
  'bars',
  'waveform',
  'tunnel',
  'neon',
  'pulsar',
  'water',
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
    // Validate the update
    if (update.defaultType !== undefined) {
      if (!this.isValidVisualizationType(update.defaultType)) {
        console.warn(`[SettingsManager] Invalid visualization type: ${update.defaultType}, ignoring`);
        return this.settings;
      }
    }

    // Merge the update
    this.settings = {
      ...this.settings,
      visualization: {
        ...this.settings.visualization,
        ...update,
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

    return {
      version: typeof obj['version'] === 'number' ? obj['version'] : SETTINGS_VERSION,
      visualization: vizSettings,
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

    return {
      defaultType: this.isValidVisualizationType(defaultType)
        ? defaultType
        : DEFAULT_SETTINGS.visualization.defaultType,
    };
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
}

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
 * Visualization settings structure.
 */
export interface VisualizationSettings {
  /** The default visualization to display on startup */
  readonly defaultType: VisualizationType;
  /** Global sensitivity for all visualizations (0.0 - 1.0, default 0.5) */
  readonly sensitivity: number;
  /** Per-visualization sensitivity overrides (0.0 - 1.0, optional per type) */
  readonly perVisualizationSensitivity: PerVisualizationSensitivity;
}

/**
 * Complete application settings structure.
 */
export interface AppSettings {
  /** Settings schema version */
  readonly version: number;
  /** Visualization preferences */
  readonly visualization: VisualizationSettings;
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
  },
};

/**
 * Available visualization options for the settings UI.
 */
export const VISUALIZATION_OPTIONS: readonly VisualizationOption[] = [
  {value: 'bars', label: 'Frequency Bars', description: '96 bars mapped to frequency bins'},
  {value: 'waveform', label: 'Waveform Classic', description: 'Oscilloscope-style with glow effect'},
  {value: 'tether', label: 'Waveform Modern', description: 'Symmetrical waveform bars with smoke effect'},
  {value: 'tunnel', label: 'Tunnel', description: 'Dual red/blue waveforms with zoom'},
  {value: 'neon', label: 'Neon', description: 'Rotating cyan/magenta waveforms'},
  {value: 'pulsar', label: 'Pulsar', description: 'Pulsing concentric rings with curved waveforms'},
  {value: 'water', label: 'Water', description: 'Water ripple effect with rotating waveforms'},
  {value: 'flux', label: 'Flux', description: 'Dual orbiting circles with spectrum cycling'},
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

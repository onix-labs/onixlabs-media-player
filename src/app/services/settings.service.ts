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
 * - tunnel: Dual red/blue waveforms with zoom
 * - neon: Rotating cyan/magenta waveforms
 * - water: Pulsar - cycling colors with tunnel zoom
 * - water2: Ambience Water 2
 */
export type VisualizationType = 'bars' | 'waveform' | 'tunnel' | 'neon' | 'water' | 'water2';

/**
 * Visualization settings structure.
 */
export interface VisualizationSettings {
  /** The default visualization to display on startup */
  readonly defaultType: VisualizationType;
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
  },
};

/**
 * Available visualization options for the settings UI.
 */
export const VISUALIZATION_OPTIONS: readonly VisualizationOption[] = [
  {value: 'bars', label: 'Frequency Bars', description: '96 bars mapped to frequency bins'},
  {value: 'waveform', label: 'Waveform', description: 'Oscilloscope-style with glow effect'},
  {value: 'tunnel', label: 'Tunnel', description: 'Dual red/blue waveforms with zoom'},
  {value: 'neon', label: 'Neon', description: 'Rotating cyan/magenta waveforms'},
  {value: 'water', label: 'Pulsar', description: 'Tunnel zoom with cycling colors'},
  {value: 'water2', label: 'Ambience Water 2', description: 'Water ripple effect'},
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

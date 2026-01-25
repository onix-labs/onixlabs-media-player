/**
 * @fileoverview Configuration view component for the settings panel.
 *
 * This component provides the main settings/configuration interface.
 * It replaces the media player view when the user enters configuration mode.
 *
 * Layout:
 * - Header with title and close button
 * - Sidebar with search and category navigation
 * - Main panel for displaying settings based on selected category
 *
 * @module app/components/configuration/configuration-view
 */

import {Component, signal, computed, inject, ChangeDetectionStrategy} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {SettingsService, VISUALIZATION_OPTIONS, VIDEO_ASPECT_OPTIONS, VISUALIZATION_METADATA, VisualizationMetadata, LocalSettingKey, FftSize, BarDensity, VideoQuality, AudioBitrate, VideoAspectMode, MacOSVisualEffectState} from '../../../services/settings.service';
import {ElectronService} from '../../../services/electron.service';

/**
 * macOS visual effect state options for the settings UI.
 */
export const MACOS_VISUAL_EFFECT_STATE_OPTIONS: readonly {value: MacOSVisualEffectState; label: string}[] = [
  {value: 'followWindow', label: 'Follow Window'},
  {value: 'active', label: 'Always Active'},
  {value: 'inactive', label: 'Always Inactive'},
];

/**
 * Safely extracts value from an input element event target.
 *
 * @param event - The DOM event
 * @returns The input value or empty string if target is not an HTMLInputElement
 */
function getInputValue(event: Event): string {
  const target: EventTarget | null = event.target;
  if (target instanceof HTMLInputElement) {
    return target.value;
  }
  return '';
}

/**
 * Safely extracts value from a select element event target.
 *
 * @param event - The DOM event
 * @returns The select value or empty string if target is not an HTMLSelectElement
 */
function getSelectValue(event: Event): string {
  const target: EventTarget | null = event.target;
  if (target instanceof HTMLSelectElement) {
    return target.value;
  }
  return '';
}

/**
 * Settings category definition.
 */
interface SettingsCategory {
  /** Unique identifier for the category */
  readonly id: string;
  /** Display name */
  readonly name: string;
  /** Font Awesome icon class */
  readonly icon: string;
  /** Description shown in the panel */
  readonly description: string;
}

/**
 * Available settings categories.
 * Future categories (playback, audio) can be added here.
 */
const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    id: 'application',
    name: 'Application',
    icon: 'fa-solid fa-gear',
    description: 'Configure application-level settings.',
  },
  {
    id: 'appearance',
    name: 'Appearance',
    icon: 'fa-solid fa-palette',
    description: 'Configure window transparency and background.',
  },
  {
    id: 'playback',
    name: 'Playback',
    icon: 'fa-solid fa-play',
    description: 'Configure playback behavior and volume.',
  },
  {
    id: 'transcoding',
    name: 'Transcoding',
    icon: 'fa-solid fa-film',
    description: 'Configure video and audio transcoding quality.',
  },
  {
    id: 'visualisations',
    name: 'Visualisations',
    icon: 'fa-solid fa-waveform-lines',
    description: 'Configure audio visualization preferences.',
  },
];

/**
 * Configuration view component providing the settings interface.
 *
 * Features:
 * - Category-based settings navigation
 * - Search filtering (filters categories by name)
 * - Visualization default type selection
 * - Close button to return to media player
 *
 * @example
 * <!-- In a parent template -->
 * <app-configuration-view (close)="exitConfigurationMode()" />
 */
@Component({
  selector: 'app-configuration-view',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './configuration-view.html',
  styleUrl: './configuration-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfigurationView {
  // ============================================================================
  // Dependencies
  // ============================================================================

  /** Settings service for reading and updating preferences */
  private readonly settingsService: SettingsService = inject(SettingsService);

  /** Electron service for platform information */
  private readonly electronService: ElectronService = inject(ElectronService);

  // ============================================================================
  // Reactive State
  // ============================================================================

  /** Currently selected category ID */
  public readonly selectedCategory: ReturnType<typeof signal<string>> = signal<string>('application');

  /** Whether the visualisations accordion is expanded */
  public readonly isVisualisationsExpanded: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Currently selected visualization ID (null = global settings) */
  public readonly selectedVisualization: ReturnType<typeof signal<string | null>> = signal<string | null>(null);

  // ============================================================================
  // Computed Values
  // ============================================================================

  /** All settings categories */
  public readonly categories: readonly SettingsCategory[] = SETTINGS_CATEGORIES;

  /** Current category details */
  public readonly currentCategory: ReturnType<typeof computed<SettingsCategory | undefined>> = computed(
    (): SettingsCategory | undefined => SETTINGS_CATEGORIES.find(
      (cat: SettingsCategory): boolean => cat.id === this.selectedCategory()
    )
  );

  /** Current default visualization type */
  public readonly currentDefaultVisualization: ReturnType<typeof computed<string>> = computed(
    (): string => this.settingsService.defaultVisualization()
  );

  /** Current max frame rate (0 = uncapped) */
  public readonly currentMaxFrameRate: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.maxFrameRate()
  );

  /** Current FFT size for audio analysis */
  public readonly currentFftSize: ReturnType<typeof computed<FftSize>> = computed(
    (): FftSize => this.settingsService.fftSize()
  );

  /** Visualization metadata for accordion items */
  public readonly visualizationMetadata: readonly VisualizationMetadata[] = VISUALIZATION_METADATA;

  /** Current default volume (0.0 - 1.0) */
  public readonly currentDefaultVolume: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.defaultVolume()
  );

  /** Current crossfade duration in milliseconds */
  public readonly currentCrossfadeDuration: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.crossfadeDuration()
  );

  /** Current video quality preset */
  public readonly currentVideoQuality: ReturnType<typeof computed<VideoQuality>> = computed(
    (): VideoQuality => this.settingsService.videoQuality()
  );

  /** Current audio bitrate */
  public readonly currentAudioBitrate: ReturnType<typeof computed<AudioBitrate>> = computed(
    (): AudioBitrate => this.settingsService.audioBitrate()
  );

  /** Current server port (0 = auto-assign) */
  public readonly currentServerPort: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.serverPort()
  );

  /** Current auto-hide delay in seconds (0 = disabled) */
  public readonly currentAutoHideDelay: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.controlsAutoHideDelay()
  );

  /** Current previous track threshold in seconds */
  public readonly currentPreviousTrackThreshold: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.previousTrackThreshold()
  );

  /** Current skip duration in seconds */
  public readonly currentSkipDuration: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.skipDuration()
  );

  // ============================================================================
  // Template Data
  // ============================================================================

  /** Available visualization options for the dropdown */
  public readonly visualizationOptions = VISUALIZATION_OPTIONS;

  /** Available frame rate options for the dropdown */
  public readonly frameRateOptions: readonly {value: number; label: string}[] = [
    {value: 0, label: 'Uncapped'},
    {value: 60, label: '60 FPS'},
    {value: 30, label: '30 FPS'},
    {value: 15, label: '15 FPS'},
  ];

  /** Available FFT size options for the dropdown */
  public readonly fftSizeOptions: readonly {value: FftSize; label: string}[] = [
    {value: 256, label: '256 (Fast)'},
    {value: 512, label: '512'},
    {value: 1024, label: '1024'},
    {value: 2048, label: '2048 (Default)'},
    {value: 4096, label: '4096 (High Quality)'},
  ];

  /** Available bar density options for the dropdown */
  public readonly barDensityOptions: readonly {value: BarDensity; label: string}[] = [
    {value: 'low', label: 'Low'},
    {value: 'medium', label: 'Medium (Default)'},
    {value: 'high', label: 'High'},
  ];

  /** Available video quality options for the dropdown */
  public readonly videoQualityOptions: readonly {value: VideoQuality; label: string}[] = [
    {value: 'low', label: 'Low (Faster, smaller files)'},
    {value: 'medium', label: 'Medium (Default)'},
    {value: 'high', label: 'High (Better quality)'},
  ];

  /** Available audio bitrate options for the dropdown */
  public readonly audioBitrateOptions: readonly {value: AudioBitrate; label: string}[] = [
    {value: 128, label: '128 kbps'},
    {value: 192, label: '192 kbps (Default)'},
    {value: 256, label: '256 kbps'},
    {value: 320, label: '320 kbps'},
  ];

  /** Available video aspect mode options for the dropdown */
  public readonly videoAspectOptions = VIDEO_ASPECT_OPTIONS;

  /** Current video aspect mode */
  public readonly currentVideoAspectMode: ReturnType<typeof computed<VideoAspectMode>> = computed(
    (): VideoAspectMode => this.settingsService.videoAspectMode()
  );

  // ============================================================================
  // Appearance Settings
  // ============================================================================

  /** Available macOS visual effect state options for the dropdown */
  public readonly macOSVisualEffectStateOptions = MACOS_VISUAL_EFFECT_STATE_OPTIONS;

  /** Whether glass effects are supported on current platform */
  public readonly supportsGlass: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.electronService.platformInfo().supportsGlass
  );

  /** Current platform identifier */
  public readonly platform: ReturnType<typeof computed<string>> = computed(
    (): string => this.electronService.platformInfo().platform
  );

  /** Whether current platform is macOS */
  public readonly isMacOS: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.platform() === 'darwin'
  );

  /** Current glass enabled setting */
  public readonly currentGlassEnabled: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.settingsService.glassEnabled()
  );

  /** Current background color setting */
  public readonly currentBackgroundColor: ReturnType<typeof computed<string>> = computed(
    (): string => this.settingsService.backgroundColor()
  );

  /** Current macOS visual effect state setting */
  public readonly currentMacOSVisualEffectState: ReturnType<typeof computed<MacOSVisualEffectState>> = computed(
    (): MacOSVisualEffectState => this.settingsService.macOSVisualEffectState()
  );

  // ============================================================================
  // Event Handlers
  // ============================================================================

  /**
   * Handles category selection.
   * For visualisations, clicking the category name shows global settings.
   *
   * @param categoryId - The ID of the category to select
   */
  public onSelectCategory(categoryId: string): void {
    this.selectedCategory.set(categoryId);
    if (categoryId === 'visualisations') {
      this.selectedVisualization.set(null);
    }
  }

  /**
   * Toggles the visualisations accordion expansion.
   *
   * @param event - The mouse event (to prevent propagation)
   */
  public toggleVisualisationsAccordion(event: MouseEvent): void {
    event.stopPropagation();
    this.isVisualisationsExpanded.set(!this.isVisualisationsExpanded());
  }

  /**
   * Selects a specific visualization for per-viz settings.
   *
   * @param vizId - The visualization ID to select
   */
  public onSelectVisualization(vizId: string): void {
    this.selectedCategory.set('visualisations');
    this.selectedVisualization.set(vizId);
  }

  /**
   * Handles default visualization selection change.
   *
   * @param event - The change event from the select element
   */
  public async onDefaultVisualizationChange(event: Event): Promise<void> {
    const type: string = getSelectValue(event);
    await this.settingsService.setDefaultVisualization(type);
  }

  /**
   * Handles max frame rate selection change.
   *
   * @param event - The change event from the select element
   */
  public async onMaxFrameRateChange(event: Event): Promise<void> {
    const fps: number = parseInt(getSelectValue(event), 10);
    if (!isNaN(fps)) await this.settingsService.setMaxFrameRate(fps);
  }

  /**
   * Handles FFT size selection change.
   *
   * @param event - The change event from the select element
   */
  public async onFftSizeChange(event: Event): Promise<void> {
    const size: number = parseInt(getSelectValue(event), 10);
    if (!isNaN(size)) await this.settingsService.setFftSize(size as FftSize);
  }

  /**
   * Handles default volume slider change.
   *
   * @param event - The input event from the slider
   */
  public async onDefaultVolumeChange(event: Event): Promise<void> {
    const volume: number = parseFloat(getInputValue(event));
    if (!isNaN(volume)) await this.settingsService.setDefaultVolume(volume);
  }

  /**
   * Handles crossfade duration slider change.
   *
   * @param event - The input event from the slider
   */
  public async onCrossfadeDurationChange(event: Event): Promise<void> {
    const duration: number = parseInt(getInputValue(event), 10);
    if (!isNaN(duration)) await this.settingsService.setCrossfadeDuration(duration);
  }

  /**
   * Handles video quality selection change.
   *
   * @param event - The change event from the select element
   */
  public async onVideoQualityChange(event: Event): Promise<void> {
    const quality: VideoQuality = getSelectValue(event) as VideoQuality;
    await this.settingsService.setVideoQuality(quality);
  }

  /**
   * Handles audio bitrate selection change.
   *
   * @param event - The change event from the select element
   */
  public async onAudioBitrateChange(event: Event): Promise<void> {
    const bitrate: number = parseInt(getSelectValue(event), 10);
    if (!isNaN(bitrate)) await this.settingsService.setAudioBitrate(bitrate as AudioBitrate);
  }

  /**
   * Handles video aspect mode selection change.
   *
   * @param event - The change event from the select element
   */
  public async onVideoAspectModeChange(event: Event): Promise<void> {
    const mode: string = getSelectValue(event);
    await this.settingsService.setVideoAspectMode(mode as VideoAspectMode);
  }

  // ============================================================================
  // Appearance Settings Event Handlers (macOS)
  // ============================================================================

  /**
   * Handles glass enabled toggle change.
   * Note: Requires application restart to take effect.
   *
   * @param event - The change event from the checkbox
   */
  public async onGlassEnabledChange(event: Event): Promise<void> {
    const target: EventTarget | null = event.target;
    if (target instanceof HTMLInputElement) {
      await this.settingsService.setGlassEnabled(target.checked);
    }
  }

  /**
   * Handles background color change.
   * Note: Requires application restart to take effect.
   *
   * @param event - The change event from the color picker
   */
  public async onBackgroundColorChange(event: Event): Promise<void> {
    const color: string = getInputValue(event);
    if (color) {
      await this.settingsService.setBackgroundColor(color);
    }
  }

  /**
   * Handles macOS visual effect state selection change.
   * Note: Requires application restart to take effect.
   *
   * @param event - The change event from the select element
   */
  public async onMacOSVisualEffectStateChange(event: Event): Promise<void> {
    const state: string = getSelectValue(event);
    await this.settingsService.setMacOSVisualEffectState(state as MacOSVisualEffectState);
  }


  /**
   * Formats the current default volume value as a percentage string.
   *
   * @returns The volume as a percentage (e.g., "50%")
   */
  public formatDefaultVolume(): string {
    return `${Math.round(this.currentDefaultVolume() * 100)}%`;
  }

  /**
   * Formats the current crossfade duration value.
   *
   * @returns The duration in milliseconds
   */
  public formatCrossfadeDuration(): string {
    const duration: number = this.currentCrossfadeDuration();
    return duration === 0 ? 'Off' : `${duration}ms`;
  }

  // ============================================================================
  // Per-Visualization Settings
  // ============================================================================

  /**
   * Checks if a setting is applicable to the given visualization.
   *
   * @param vizId - The visualization ID
   * @param setting - The setting key
   * @returns True if the setting applies to this visualization
   */
  public hasApplicableSetting(vizId: string, setting: LocalSettingKey): boolean {
    return this.settingsService.hasApplicableSetting(vizId, setting);
  }

  /**
   * Checks if a visualization has a custom value for a setting.
   *
   * @param vizId - The visualization ID
   * @param setting - The setting key
   * @returns True if the setting has a custom value
   */
  public hasCustomSetting(vizId: string, setting: LocalSettingKey): boolean {
    return this.settingsService.hasCustomSetting(vizId, setting);
  }

  /**
   * Gets the effective value for a per-visualization setting.
   *
   * @param vizId - The visualization ID
   * @param setting - The setting key
   * @returns The effective value (custom or default)
   */
  public getEffectiveSetting<K extends LocalSettingKey>(vizId: string, setting: K): number | BarDensity {
    return this.settingsService.getEffectiveSetting(vizId, setting) as number | BarDensity;
  }

  /**
   * Formats a numeric setting value as a percentage string.
   *
   * @param vizId - The visualization ID
   * @param setting - The setting key
   * @returns The value as a percentage (e.g., "50%")
   */
  public formatPercentSetting(vizId: string, setting: LocalSettingKey): string {
    const value = this.settingsService.getEffectiveSetting(vizId, setting) as number;
    return `${Math.round(value * 100)}%`;
  }

  /**
   * Formats the line width setting with units.
   *
   * @param vizId - The visualization ID
   * @returns The line width with px units (e.g., "2.0px")
   */
  public formatLineWidth(vizId: string): string {
    const value = this.settingsService.getEffectiveSetting(vizId, 'lineWidth') as number;
    return `${value.toFixed(1)}px`;
  }

  /**
   * Handles per-visualization setting change.
   *
   * @param vizId - The visualization ID
   * @param setting - The setting key
   * @param event - The input event
   */
  public async onPerVizSettingChange(vizId: string, setting: LocalSettingKey, event: Event): Promise<void> {
    const value: number = parseFloat(getInputValue(event));
    if (!isNaN(value)) {
      await this.settingsService.setVisualizationSetting(vizId, setting, value);
    }
  }

  /**
   * Handles per-visualization bar density change.
   *
   * @param vizId - The visualization ID
   * @param event - The change event from the select element
   */
  public async onPerVizBarDensityChange(vizId: string, event: Event): Promise<void> {
    const density: BarDensity = getSelectValue(event) as BarDensity;
    await this.settingsService.setVisualizationSetting(vizId, 'barDensity', density);
  }

  /**
   * Resets a per-visualization setting to its default.
   *
   * @param vizId - The visualization ID
   * @param setting - The setting key
   */
  public async onResetPerVizSetting(vizId: string, setting: LocalSettingKey): Promise<void> {
    await this.settingsService.resetVisualizationSetting(vizId, setting);
  }

  /**
   * Resets all settings for a visualization to defaults.
   *
   * @param vizId - The visualization ID
   */
  public async onResetAllVisualizationSettings(vizId: string): Promise<void> {
    await this.settingsService.resetAllVisualizationSettings(vizId);
  }

  /**
   * Gets the display name for a visualization by its ID.
   *
   * @param vizId - The visualization ID
   * @returns The display name or the ID if not found
   */
  public getVisualizationName(vizId: string): string {
    const meta = this.settingsService.getVisualizationMetadata(vizId);
    return meta?.name ?? vizId;
  }

  // ============================================================================
  // Application Settings
  // ============================================================================

  /**
   * Checks if the server port is set to auto-assign.
   *
   * @returns True if port is 0 (auto-assign)
   */
  public isPortAuto(): boolean {
    return this.currentServerPort() === 0;
  }

  /**
   * Gets the display value for the server port.
   * Returns empty string for auto-assign to allow placeholder to show.
   *
   * @returns Port number as string, or empty for auto
   */
  public getPortDisplayValue(): string {
    const port: number = this.currentServerPort();
    return port === 0 ? '' : port.toString();
  }

  /**
   * Handles server port input changes.
   * Empty input or 0 sets auto-assign mode.
   *
   * @param event - The input event from the number field
   */
  public async onServerPortChange(event: Event): Promise<void> {
    const value: string = getInputValue(event).trim();

    // Empty or 0 means auto-assign
    const port: number = value === '' ? 0 : parseInt(value, 10);
    const validPort: number = isNaN(port) ? 0 : port;

    await this.settingsService.setServerPort(validPort);
  }

  /**
   * Resets the server port to auto-assign.
   */
  public async onResetServerPort(): Promise<void> {
    await this.settingsService.setServerPort(0);
  }

  /**
   * Handles auto-hide delay slider change.
   *
   * @param event - The input event from the range element
   */
  public async onAutoHideDelayChange(event: Event): Promise<void> {
    const value: number = parseInt(getInputValue(event), 10);
    if (!isNaN(value)) await this.settingsService.setControlsAutoHideDelay(value);
  }

  /**
   * Formats the auto-hide delay value for display.
   *
   * @returns The delay as a human-readable string (e.g., "5s" or "Off")
   */
  public formatAutoHideDelay(): string {
    const delay: number = this.currentAutoHideDelay();
    return delay === 0 ? 'Off' : `${delay}s`;
  }

  /**
   * Handles previous track threshold slider change.
   *
   * @param event - The input event from the range element
   */
  public async onPreviousTrackThresholdChange(event: Event): Promise<void> {
    const value: number = parseInt(getInputValue(event), 10);
    if (!isNaN(value)) await this.settingsService.setPreviousTrackThreshold(value);
  }

  /**
   * Formats the previous track threshold value for display.
   *
   * @returns The threshold as a human-readable string (e.g., "3s" or "Off")
   */
  public formatPreviousTrackThreshold(): string {
    const threshold: number = this.currentPreviousTrackThreshold();
    return threshold === 0 ? 'Off' : `${threshold}s`;
  }

  /**
   * Handles skip duration slider change.
   *
   * @param event - The input event from the range element
   */
  public async onSkipDurationChange(event: Event): Promise<void> {
    const value: number = parseInt(getInputValue(event), 10);
    if (!isNaN(value)) await this.settingsService.setSkipDuration(value);
  }

  /**
   * Formats the skip duration value for display.
   *
   * @returns The duration as a human-readable string (e.g., "10s")
   */
  public formatSkipDuration(): string {
    return `${this.currentSkipDuration()}s`;
  }
}

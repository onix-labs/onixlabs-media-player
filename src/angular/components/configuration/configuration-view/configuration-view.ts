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

import {Component, output, signal, computed, inject} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {SettingsService, VISUALIZATION_OPTIONS, VisualizationType, FftSize, BarDensity, VideoQuality, AudioBitrate} from '../../../services/settings.service';

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
    id: 'visualization',
    name: 'Visualization',
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
})
export class ConfigurationView {
  // ============================================================================
  // Dependencies
  // ============================================================================

  /** Settings service for reading and updating preferences */
  private readonly settingsService: SettingsService = inject(SettingsService);

  // ============================================================================
  // Outputs
  // ============================================================================

  /** Event emitted when the close button is clicked */
  public readonly close = output<void>();

  // ============================================================================
  // Reactive State
  // ============================================================================

  /** Search query for filtering categories */
  public readonly searchQuery: ReturnType<typeof signal<string>> = signal<string>('');

  /** Currently selected category ID */
  public readonly selectedCategory: ReturnType<typeof signal<string>> = signal<string>('application');

  /** Whether the per-visualization sensitivity section is expanded */
  public readonly isPerVizExpanded: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  // ============================================================================
  // Computed Values
  // ============================================================================

  /** Filtered categories based on search query */
  public readonly filteredCategories: ReturnType<typeof computed<readonly SettingsCategory[]>> = computed(
    (): readonly SettingsCategory[] => {
      const query: string = this.searchQuery().toLowerCase().trim();
      if (!query) return SETTINGS_CATEGORIES;
      return SETTINGS_CATEGORIES.filter(
        (cat: SettingsCategory): boolean => cat.name.toLowerCase().includes(query)
      );
    }
  );

  /** Current category details */
  public readonly currentCategory: ReturnType<typeof computed<SettingsCategory | undefined>> = computed(
    (): SettingsCategory | undefined => SETTINGS_CATEGORIES.find(
      (cat: SettingsCategory): boolean => cat.id === this.selectedCategory()
    )
  );

  /** Current default visualization type */
  public readonly currentDefaultVisualization: ReturnType<typeof computed<VisualizationType>> = computed(
    (): VisualizationType => this.settingsService.defaultVisualization()
  );

  /** Current sensitivity value (0.0 - 1.0) */
  public readonly currentSensitivity: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.sensitivity()
  );

  /** Current max frame rate (0 = uncapped) */
  public readonly currentMaxFrameRate: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.maxFrameRate()
  );

  /** Current trail intensity (0.0 - 1.0) */
  public readonly currentTrailIntensity: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.trailIntensity()
  );

  /** Current hue shift (0-360 degrees) */
  public readonly currentHueShift: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.hueShift()
  );

  /** Current FFT size for audio analysis */
  public readonly currentFftSize: ReturnType<typeof computed<FftSize>> = computed(
    (): FftSize => this.settingsService.fftSize()
  );

  /** Current bar density for bar-based visualizations */
  public readonly currentBarDensity: ReturnType<typeof computed<BarDensity>> = computed(
    (): BarDensity => this.settingsService.barDensity()
  );

  /** Current line width for waveform visualizations */
  public readonly currentLineWidth: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.lineWidth()
  );

  /** Current glow intensity for visualizations */
  public readonly currentGlowIntensity: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.glowIntensity()
  );

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

  // ============================================================================
  // Event Handlers
  // ============================================================================

  /**
   * Handles close button click.
   * Emits the close event to return to the media player view.
   */
  public onClose(): void {
    this.close.emit();
  }

  /**
   * Handles category selection.
   *
   * @param categoryId - The ID of the category to select
   */
  public onSelectCategory(categoryId: string): void {
    this.selectedCategory.set(categoryId);
  }

  /**
   * Handles search input changes.
   *
   * @param event - The input event
   */
  public onSearchChange(event: Event): void {
    const input: HTMLInputElement = event.target as HTMLInputElement;
    this.searchQuery.set(input.value);
  }

  /**
   * Handles default visualization selection change.
   *
   * @param event - The change event from the select element
   */
  public async onDefaultVisualizationChange(event: Event): Promise<void> {
    const select: HTMLSelectElement = event.target as HTMLSelectElement;
    const type: VisualizationType = select.value as VisualizationType;
    await this.settingsService.setDefaultVisualization(type);
  }

  /**
   * Handles sensitivity slider change.
   *
   * @param event - The input event from the range element
   */
  public async onSensitivityChange(event: Event): Promise<void> {
    const input: HTMLInputElement = event.target as HTMLInputElement;
    const value: number = parseFloat(input.value);
    await this.settingsService.setSensitivity(value);
  }

  /**
   * Handles max frame rate selection change.
   *
   * @param event - The change event from the select element
   */
  public async onMaxFrameRateChange(event: Event): Promise<void> {
    const select: HTMLSelectElement = event.target as HTMLSelectElement;
    const fps: number = parseInt(select.value, 10);
    await this.settingsService.setMaxFrameRate(fps);
  }

  /**
   * Handles trail intensity slider change.
   *
   * @param event - The input event from the range element
   */
  public async onTrailIntensityChange(event: Event): Promise<void> {
    const input: HTMLInputElement = event.target as HTMLInputElement;
    const value: number = parseFloat(input.value);
    await this.settingsService.setTrailIntensity(value);
  }

  /**
   * Handles hue shift slider change.
   *
   * @param event - The input event from the range element
   */
  public async onHueShiftChange(event: Event): Promise<void> {
    const input: HTMLInputElement = event.target as HTMLInputElement;
    const value: number = parseFloat(input.value);
    await this.settingsService.setHueShift(value);
  }

  /**
   * Handles FFT size selection change.
   *
   * @param event - The change event from the select element
   */
  public async onFftSizeChange(event: Event): Promise<void> {
    const select: HTMLSelectElement = event.target as HTMLSelectElement;
    const size: FftSize = parseInt(select.value, 10) as FftSize;
    await this.settingsService.setFftSize(size);
  }

  /**
   * Handles bar density selection change.
   *
   * @param event - The change event from the select element
   */
  public async onBarDensityChange(event: Event): Promise<void> {
    const select: HTMLSelectElement = event.target as HTMLSelectElement;
    const density: BarDensity = select.value as BarDensity;
    await this.settingsService.setBarDensity(density);
  }

  /**
   * Handles line width slider change.
   *
   * @param event - The input event from the slider
   */
  public async onLineWidthChange(event: Event): Promise<void> {
    const input: HTMLInputElement = event.target as HTMLInputElement;
    const width: number = parseFloat(input.value);
    await this.settingsService.setLineWidth(width);
  }

  /**
   * Handles glow intensity slider change.
   *
   * @param event - The input event from the slider
   */
  public async onGlowIntensityChange(event: Event): Promise<void> {
    const input: HTMLInputElement = event.target as HTMLInputElement;
    const intensity: number = parseFloat(input.value);
    await this.settingsService.setGlowIntensity(intensity);
  }

  /**
   * Handles default volume slider change.
   *
   * @param event - The input event from the slider
   */
  public async onDefaultVolumeChange(event: Event): Promise<void> {
    const input: HTMLInputElement = event.target as HTMLInputElement;
    const volume: number = parseFloat(input.value);
    await this.settingsService.setDefaultVolume(volume);
  }

  /**
   * Handles crossfade duration slider change.
   *
   * @param event - The input event from the slider
   */
  public async onCrossfadeDurationChange(event: Event): Promise<void> {
    const input: HTMLInputElement = event.target as HTMLInputElement;
    const duration: number = parseInt(input.value, 10);
    await this.settingsService.setCrossfadeDuration(duration);
  }

  /**
   * Handles video quality selection change.
   *
   * @param event - The change event from the select element
   */
  public async onVideoQualityChange(event: Event): Promise<void> {
    const select: HTMLSelectElement = event.target as HTMLSelectElement;
    const quality: VideoQuality = select.value as VideoQuality;
    await this.settingsService.setVideoQuality(quality);
  }

  /**
   * Handles audio bitrate selection change.
   *
   * @param event - The change event from the select element
   */
  public async onAudioBitrateChange(event: Event): Promise<void> {
    const select: HTMLSelectElement = event.target as HTMLSelectElement;
    const bitrate: AudioBitrate = parseInt(select.value, 10) as AudioBitrate;
    await this.settingsService.setAudioBitrate(bitrate);
  }

  /**
   * Formats the current sensitivity value as a percentage string.
   *
   * @returns The sensitivity as a percentage (e.g., "50%")
   */
  public formatSensitivity(): string {
    return `${Math.round(this.currentSensitivity() * 100)}%`;
  }

  /**
   * Formats the current trail intensity value as a percentage string.
   *
   * @returns The trail intensity as a percentage (e.g., "50%")
   */
  public formatTrailIntensity(): string {
    return `${Math.round(this.currentTrailIntensity() * 100)}%`;
  }

  /**
   * Formats the current hue shift value in degrees.
   *
   * @returns The hue shift in degrees (e.g., "180°")
   */
  public formatHueShift(): string {
    return `${Math.round(this.currentHueShift())}°`;
  }

  /**
   * Formats the current line width value.
   *
   * @returns The line width as a number with one decimal place
   */
  public formatLineWidth(): string {
    return `${this.currentLineWidth().toFixed(1)}px`;
  }

  /**
   * Formats the current glow intensity value as a percentage string.
   *
   * @returns The glow intensity as a percentage (e.g., "50%")
   */
  public formatGlowIntensity(): string {
    return `${Math.round(this.currentGlowIntensity() * 100)}%`;
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
  // Per-Visualization Sensitivity
  // ============================================================================

  /**
   * Toggles the per-visualization sensitivity section expansion.
   */
  public togglePerVizSection(): void {
    this.isPerVizExpanded.set(!this.isPerVizExpanded());
  }

  /**
   * Checks if a visualization has a custom sensitivity override.
   *
   * @param type - The visualization type to check
   * @returns True if the visualization has a custom sensitivity
   */
  public hasPerVizSensitivity(type: VisualizationType): boolean {
    const perViz = this.settingsService.perVisualizationSensitivity();
    return perViz[type] !== undefined;
  }

  /**
   * Gets the effective sensitivity for a visualization.
   * Returns the custom value if set, otherwise the global value.
   *
   * @param type - The visualization type
   * @returns The sensitivity value (0.0 - 1.0)
   */
  public getVisualizationSensitivity(type: VisualizationType): number {
    return this.settingsService.getEffectiveSensitivity(type);
  }

  /**
   * Formats the sensitivity for a specific visualization as a percentage.
   *
   * @param type - The visualization type
   * @returns The sensitivity as a percentage (e.g., "50%")
   */
  public formatVisualizationSensitivity(type: VisualizationType): string {
    return `${Math.round(this.getVisualizationSensitivity(type) * 100)}%`;
  }

  /**
   * Handles per-visualization sensitivity slider change.
   *
   * @param type - The visualization type being adjusted
   * @param event - The input event from the range element
   */
  public async onVisualizationSensitivityChange(type: VisualizationType, event: Event): Promise<void> {
    const input: HTMLInputElement = event.target as HTMLInputElement;
    const value: number = parseFloat(input.value);
    await this.settingsService.setVisualizationSensitivity(type, value);
  }

  /**
   * Resets a visualization's sensitivity to use the global setting.
   *
   * @param type - The visualization type to reset
   */
  public async onResetVisualizationSensitivity(type: VisualizationType): Promise<void> {
    await this.settingsService.resetVisualizationSensitivity(type);
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
    const input: HTMLInputElement = event.target as HTMLInputElement;
    const value: string = input.value.trim();

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
    const input: HTMLInputElement = event.target as HTMLInputElement;
    const value: number = parseInt(input.value, 10);
    await this.settingsService.setControlsAutoHideDelay(value);
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
    const input: HTMLInputElement = event.target as HTMLInputElement;
    const value: number = parseInt(input.value, 10);
    await this.settingsService.setPreviousTrackThreshold(value);
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
}

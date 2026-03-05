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

import {Component, signal, computed, inject, input, effect, ChangeDetectionStrategy} from '@angular/core';
import type {InputSignal, EffectRef} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {SettingsService, VISUALIZATION_OPTIONS, VIDEO_ASPECT_OPTIONS, AUDIO_LANGUAGE_OPTIONS, SUBTITLE_LANGUAGE_OPTIONS, VISUALIZATION_METADATA, VisualizationMetadata, LocalSettingKey, FftSize, BarDensity, VideoQuality, AudioBitrate, VideoAspectMode, PreferredAudioLanguage, PreferredSubtitleLanguage, MacOSVisualEffectState, ColorScheme, PerVisualizationSettings, VisualizationLocalSettings, VISUALIZATION_LOCAL_DEFAULTS, SubtitleFontFamily, HardwareAcceleration} from '../../../services/settings.service';
import {ElectronService} from '../../../services/electron.service';
import {DependencyService} from '../../../services/dependency.service';
import type {DependencyId, DependencyState, DependencyStatus, SoundFontInfo, InstallProgress, HardwareEncoderInfo} from '../../../services/dependency.service';

/**
 * macOS visual effect state options for the settings UI.
 */
export const MACOS_VISUAL_EFFECT_STATE_OPTIONS: readonly {value: MacOSVisualEffectState; label: string}[] = [
  {value: 'followWindow', label: 'Follow Window'},
  {value: 'active', label: 'Always Active'},
  {value: 'inactive', label: 'Always Inactive'},
];

/**
 * Color scheme options for the settings UI.
 */
export const COLOR_SCHEME_OPTIONS: readonly {value: ColorScheme; label: string}[] = [
  {value: 'system', label: 'System'},
  {value: 'dark', label: 'Dark'},
  {value: 'light', label: 'Light'},
];

/**
 * Subtitle font family options for the settings UI.
 */
export const SUBTITLE_FONT_FAMILY_OPTIONS: readonly {value: SubtitleFontFamily; label: string}[] = [
  {value: 'sans-serif', label: 'Sans Serif'},
  {value: 'serif', label: 'Serif'},
  {value: 'monospace', label: 'Monospace'},
  {value: 'Arial', label: 'Arial'},
];

/**
 * Supported audio file extensions for file association display.
 */
export const SUPPORTED_AUDIO_EXTENSIONS: readonly string[] = [
  'mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'mid', 'midi'
];

/**
 * Supported video file extensions for file association display.
 */
export const SUPPORTED_VIDEO_EXTENSIONS: readonly string[] = [
  'mp4', 'm4v', 'mkv', 'avi', 'webm', 'mov'
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
 * Safely extracts checked state from a checkbox element event target.
 *
 * @param event - The DOM event
 * @returns The checked state or false if target is not an HTMLInputElement
 */
function getCheckboxValue(event: Event): boolean {
  const target: EventTarget | null = event.target;
  if (target instanceof HTMLInputElement && target.type === 'checkbox') {
    return target.checked;
  }
  return false;
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
    id: 'dependencies',
    name: 'Dependencies',
    icon: 'fa-solid fa-puzzle-piece',
    description: 'Manage required external dependencies for media playback.',
  },
  {
    id: 'playback',
    name: 'Playback',
    icon: 'fa-solid fa-play',
    description: 'Configure playback behavior and volume.',
  },
  {
    id: 'subtitles',
    name: 'Subtitles',
    icon: 'fa-solid fa-closed-captioning',
    description: 'Configure subtitle appearance for video playback.',
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

  /** Dependency service for external binary management */
  private readonly dependencyService: DependencyService = inject(DependencyService);

  // ============================================================================
  // Inputs
  // ============================================================================

  /** Initial category to select when the view opens */
  public readonly initialCategory: InputSignal<string> = input<string>('');

  /** Whether this is a standalone configuration window (not embedded in main window) */
  public readonly isStandaloneWindow: InputSignal<boolean> = input<boolean>(false);

  // ============================================================================
  // Reactive State
  // ============================================================================

  /** Currently selected category ID */
  public readonly selectedCategory: ReturnType<typeof signal<string>> = signal<string>('application');

  /** Whether the visualisations accordion is expanded */
  public readonly isVisualisationsExpanded: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Effect to apply initialCategory input or URL param for standalone windows */
  private readonly initialCategoryEffect: EffectRef = effect((): void => {
    // First priority: input binding
    const category: string = this.initialCategory();
    if (category) {
      this.selectedCategory.set(category);
      return;
    }
    // Second priority: URL param for standalone windows
    if (this.isStandaloneWindow()) {
      const urlCategory: string | null = new URLSearchParams(window.location.search).get('category');
      if (urlCategory) {
        this.selectedCategory.set(urlCategory);
      }
    }
  });

  /** Currently selected visualization ID (null = global settings) */
  public readonly selectedVisualization: ReturnType<typeof signal<string | null>> = signal<string | null>(null);

  /**
   * Per-visualization settings for the currently selected visualization.
   * This computed signal ensures Angular tracks changes from SSE updates.
   */
  public readonly currentVizSettings: ReturnType<typeof computed<Record<string, number | string | undefined>>> = computed(
    (): Record<string, number | string | undefined> => {
      const vizId: string | null = this.selectedVisualization();
      if (!vizId) return {};
      // Reading from perVisualizationSettings() creates a reactive dependency
      const allSettings: PerVisualizationSettings = this.settingsService.perVisualizationSettings();
      return (allSettings[vizId] ?? {}) as Record<string, number | string | undefined>;
    }
  );

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

  /** Initial server port (captured at component creation for change detection) */
  private readonly initialServerPort: number = this.settingsService.serverPort();

  /** Whether the server port has been changed from its initial value */
  public readonly serverPortChanged: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.currentServerPort() !== this.initialServerPort
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
  public readonly visualizationOptions: typeof VISUALIZATION_OPTIONS = VISUALIZATION_OPTIONS;

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

  /** Hardware encoder display names */
  private readonly hardwareEncoderLabels: Record<string, string> = {
    'h264_videotoolbox': 'VideoToolbox (macOS)',
    'h264_nvenc': 'NVENC (NVIDIA)',
    'h264_qsv': 'Quick Sync (Intel)',
    'h264_amf': 'AMF (AMD)',
    'h264_vaapi': 'VAAPI (Linux)',
  };

  /** Available hardware encoders from system */
  public readonly availableHardwareEncoders: ReturnType<typeof computed<HardwareEncoderInfo>> = computed(
    (): HardwareEncoderInfo => this.dependencyService.hardwareEncoders()
  );

  /** Hardware acceleration options computed from available encoders */
  public readonly hardwareAccelerationOptions: ReturnType<typeof computed<readonly {value: HardwareAcceleration; label: string}[]>> = computed(
    (): readonly {value: HardwareAcceleration; label: string}[] => {
      const encoders: HardwareEncoderInfo = this.availableHardwareEncoders();
      const options: {value: HardwareAcceleration; label: string}[] = [
        {value: 'auto', label: 'Auto (Recommended)'},
        {value: 'disabled', label: 'Disabled (Software Only)'},
      ];

      // Add detected hardware encoders
      for (const encoder of encoders.encoders) {
        const label: string = this.hardwareEncoderLabels[encoder] ?? encoder;
        options.push({value: encoder as HardwareAcceleration, label});
      }

      return options;
    }
  );

  /** Current hardware acceleration setting */
  public readonly currentHardwareAcceleration: ReturnType<typeof computed<HardwareAcceleration>> = computed(
    (): HardwareAcceleration => this.settingsService.hardwareAcceleration()
  );

  /** Available video aspect mode options for the dropdown */
  public readonly videoAspectOptions: typeof VIDEO_ASPECT_OPTIONS = VIDEO_ASPECT_OPTIONS;

  /** Current video aspect mode */
  public readonly currentVideoAspectMode: ReturnType<typeof computed<VideoAspectMode>> = computed(
    (): VideoAspectMode => this.settingsService.videoAspectMode()
  );

  /**
   * Available audio language options for the dropdown.
   *
   * Provides ISO 639-2/B language codes for common languages used in media.
   * 'File Default' defers to the container's default track setting.
   */
  public readonly audioLanguageOptions: typeof AUDIO_LANGUAGE_OPTIONS = AUDIO_LANGUAGE_OPTIONS;

  /**
   * Current preferred audio language setting.
   *
   * This setting determines which audio track is auto-selected when loading
   * videos with multiple audio streams (e.g., anime with JP/EN audio).
   * Manual track selection via the media bar overrides this preference.
   */
  public readonly currentPreferredAudioLanguage: ReturnType<typeof computed<PreferredAudioLanguage>> = computed(
    (): PreferredAudioLanguage => this.settingsService.preferredAudioLanguage()
  );

  /**
   * Available subtitle language options for the dropdown.
   *
   * Includes 'Subtitles Off' to disable subtitles by default, plus language options.
   */
  public readonly subtitleLanguageOptions: typeof SUBTITLE_LANGUAGE_OPTIONS = SUBTITLE_LANGUAGE_OPTIONS;

  /**
   * Current preferred subtitle language setting.
   *
   * This setting determines which subtitle track is auto-selected when loading
   * videos with embedded subtitles. 'off' disables subtitles by default.
   * Manual track selection via the media bar overrides this preference.
   */
  public readonly currentPreferredSubtitleLanguage: ReturnType<typeof computed<PreferredSubtitleLanguage>> = computed(
    (): PreferredSubtitleLanguage => this.settingsService.preferredSubtitleLanguage()
  );

  // ============================================================================
  // Appearance Settings
  // ============================================================================

  /** Available macOS visual effect state options for the dropdown */
  public readonly macOSVisualEffectStateOptions: typeof MACOS_VISUAL_EFFECT_STATE_OPTIONS = MACOS_VISUAL_EFFECT_STATE_OPTIONS;

  /** Available color scheme options for the dropdown */
  public readonly colorSchemeOptions: typeof COLOR_SCHEME_OPTIONS = COLOR_SCHEME_OPTIONS;

  /** Current color scheme setting */
  public readonly currentColorScheme: ReturnType<typeof computed<ColorScheme>> = computed(
    (): ColorScheme => this.settingsService.colorScheme()
  );

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

  /** Current background color setting (hex, derived from HSL) */
  public readonly currentBackgroundColor: ReturnType<typeof computed<string>> = computed(
    (): string => this.settingsService.backgroundColor()
  );

  /** Current macOS visual effect state setting */
  public readonly currentMacOSVisualEffectState: ReturnType<typeof computed<MacOSVisualEffectState>> = computed(
    (): MacOSVisualEffectState => this.settingsService.macOSVisualEffectState()
  );

  /** Initial macOS visual effect state (captured at component creation for change detection) */
  private readonly initialMacOSVisualEffectState: MacOSVisualEffectState = this.settingsService.macOSVisualEffectState();

  /** Whether the macOS visual effect state has been changed from its initial value */
  public readonly visualEffectStateChanged: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.currentMacOSVisualEffectState() !== this.initialMacOSVisualEffectState
  );

  /** Current background hue (0-360) */
  public readonly currentBackgroundHue: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.backgroundHue()
  );

  /** Current background saturation (0-100) */
  public readonly currentBackgroundSaturation: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.backgroundSaturation()
  );

  /** Current background lightness (0-100) */
  public readonly currentBackgroundLightness: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.backgroundLightness()
  );

  /** Current window tint hue (0-360) */
  public readonly currentWindowTintHue: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.windowTintHue()
  );

  /** Current window tint saturation (0-100) */
  public readonly currentWindowTintSaturation: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.windowTintSaturation()
  );

  /** Current window tint lightness (0-100) */
  public readonly currentWindowTintLightness: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.windowTintLightness()
  );

  /** Current window tint alpha (0-1) */
  public readonly currentWindowTintAlpha: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.windowTintAlpha()
  );

  /** Preview color for background HSL sliders */
  public readonly backgroundPreviewColor: ReturnType<typeof computed<string>> = computed(
    (): string => `hsl(${this.currentBackgroundHue()}, ${this.currentBackgroundSaturation()}%, ${this.currentBackgroundLightness()}%)`
  );

  /** Preview color for window tint HSLA sliders */
  public readonly windowTintPreviewColor: ReturnType<typeof computed<string>> = computed(
    (): string => `hsla(${this.currentWindowTintHue()}, ${this.currentWindowTintSaturation()}%, ${this.currentWindowTintLightness()}%, ${this.currentWindowTintAlpha()})`
  );

  // ============================================================================
  // Unified Window Color (uses background when glass off, tint when glass on)
  // ============================================================================

  /** Unified window color hue - uses background or tint based on glass state */
  public readonly windowColorHue: ReturnType<typeof computed<number>> = computed(
    (): number => this.currentGlassEnabled() && this.supportsGlass()
      ? this.currentWindowTintHue()
      : this.currentBackgroundHue()
  );

  /** Unified window color saturation - uses background or tint based on glass state */
  public readonly windowColorSaturation: ReturnType<typeof computed<number>> = computed(
    (): number => this.currentGlassEnabled() && this.supportsGlass()
      ? this.currentWindowTintSaturation()
      : this.currentBackgroundSaturation()
  );

  /** Unified window color lightness - uses background or tint based on glass state */
  public readonly windowColorLightness: ReturnType<typeof computed<number>> = computed(
    (): number => this.currentGlassEnabled() && this.supportsGlass()
      ? this.currentWindowTintLightness()
      : this.currentBackgroundLightness()
  );

  /** Unified window color preview - uses background or tint based on glass state */
  public readonly windowColorPreview: ReturnType<typeof computed<string>> = computed(
    (): string => this.currentGlassEnabled() && this.supportsGlass()
      ? this.windowTintPreviewColor()
      : this.backgroundPreviewColor()
  );

  // ============================================================================
  // Subtitle Computed Signals
  // ============================================================================

  /** Subtitle font family options for select dropdown */
  public readonly subtitleFontFamilyOptions: typeof SUBTITLE_FONT_FAMILY_OPTIONS = SUBTITLE_FONT_FAMILY_OPTIONS;

  /** Supported audio extensions for file associations display */
  public readonly supportedAudioExtensions: typeof SUPPORTED_AUDIO_EXTENSIONS = SUPPORTED_AUDIO_EXTENSIONS;

  /** Supported video extensions for file associations display */
  public readonly supportedVideoExtensions: typeof SUPPORTED_VIDEO_EXTENSIONS = SUPPORTED_VIDEO_EXTENSIONS;

  /** Current subtitle font size (50-200) */
  public readonly currentSubtitleFontSize: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.subtitleFontSize()
  );

  /** Current subtitle font color */
  public readonly currentSubtitleFontColor: ReturnType<typeof computed<string>> = computed(
    (): string => this.settingsService.subtitleFontColor()
  );

  /** Current subtitle background color */
  public readonly currentSubtitleBackgroundColor: ReturnType<typeof computed<string>> = computed(
    (): string => this.settingsService.subtitleBackgroundColor()
  );

  /** Current subtitle background opacity (0-1) */
  public readonly currentSubtitleBackgroundOpacity: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.subtitleBackgroundOpacity()
  );

  /** Current subtitle font family */
  public readonly currentSubtitleFontFamily: ReturnType<typeof computed<SubtitleFontFamily>> = computed(
    (): SubtitleFontFamily => this.settingsService.subtitleFontFamily()
  );

  /** Current subtitle text shadow enabled state */
  public readonly currentSubtitleTextShadow: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.settingsService.subtitleTextShadow()
  );

  /** Current subtitle shadow spread in pixels */
  public readonly currentSubtitleShadowSpread: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.subtitleShadowSpread()
  );

  /** Current subtitle shadow blur in pixels */
  public readonly currentSubtitleShadowBlur: ReturnType<typeof computed<number>> = computed(
    (): number => this.settingsService.subtitleShadowBlur()
  );

  /** Current subtitle shadow color */
  public readonly currentSubtitleShadowColor: ReturnType<typeof computed<string>> = computed(
    (): string => this.settingsService.subtitleShadowColor()
  );

  /** Preview color for subtitle background with opacity */
  public readonly subtitleBackgroundPreviewColor: ReturnType<typeof computed<string>> = computed(
    (): string => {
      const hex: string = this.currentSubtitleBackgroundColor();
      const opacity: number = this.currentSubtitleBackgroundOpacity();
      const r: number = parseInt(hex.slice(1, 3), 16);
      const g: number = parseInt(hex.slice(3, 5), 16);
      const b: number = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }
  );

  /** Preview style for subtitle shadow (returns CSS value for text-shadow) */
  public readonly subtitleShadowPreviewStyle: ReturnType<typeof computed<string>> = computed(
    (): string => {
      if (!this.currentSubtitleTextShadow()) return 'none';
      const s: number = this.currentSubtitleShadowSpread();
      const b: number = this.currentSubtitleShadowBlur();
      const c: string = this.currentSubtitleShadowColor();
      return [
        `0 -${s}px ${b}px ${c}`,
        `${s}px -${s}px ${b}px ${c}`,
        `${s}px 0 ${b}px ${c}`,
        `${s}px ${s}px ${b}px ${c}`,
        `0 ${s}px ${b}px ${c}`,
        `-${s}px ${s}px ${b}px ${c}`,
        `-${s}px 0 ${b}px ${c}`,
        `-${s}px -${s}px ${b}px ${c}`
      ].join(', ');
    }
  );

  // ============================================================================
  // Dependency Computed Signals
  // ============================================================================

  /** Full dependency state */
  public readonly depState: ReturnType<typeof computed<DependencyState | null>> = computed(
    (): DependencyState | null => this.dependencyService.dependencyState()
  );

  /** FFmpeg dependency status */
  public readonly ffmpegStatus: ReturnType<typeof computed<DependencyStatus | null>> = computed(
    (): DependencyStatus | null => this.depState()?.ffmpeg ?? null
  );

  /** FluidSynth dependency status */
  public readonly fluidsynthStatus: ReturnType<typeof computed<DependencyStatus | null>> = computed(
    (): DependencyStatus | null => this.depState()?.fluidsynth ?? null
  );

  /** Installed SoundFont files */
  public readonly soundFonts: ReturnType<typeof computed<SoundFontInfo[]>> = computed(
    (): SoundFontInfo[] => this.dependencyService.soundFonts()
  );

  /** Active SoundFont path (full path to currently selected soundfont) */
  public readonly activeSoundFontPath: ReturnType<typeof computed<string | null>> = computed(
    (): string | null => this.dependencyService.activeSoundFont()
  );

  /** Whether FluidSynth is installed (for showing SoundFont section) */
  public readonly fluidsynthInstalled: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.dependencyService.fluidsynthInstalled()
  );

  /** Current install/uninstall progress */
  public readonly depProgress: ReturnType<typeof computed<InstallProgress | null>> = computed(
    (): InstallProgress | null => this.dependencyService.installProgress()
  );

  /** Whether an install/uninstall operation is in progress */
  public readonly isDepOperationInProgress: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.dependencyService.isOperationInProgress()
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
   * Handles hardware acceleration selection change.
   *
   * @param event - The change event from the select element
   */
  public async onHardwareAccelerationChange(event: Event): Promise<void> {
    const mode: HardwareAcceleration = getSelectValue(event) as HardwareAcceleration;
    await this.settingsService.setHardwareAcceleration(mode);
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

  /**
   * Handles preferred audio language selection change.
   *
   * The new language preference is persisted and will be applied on the
   * next video load. Currently playing videos are not affected.
   *
   * @param event - The change event from the select element
   */
  public async onPreferredAudioLanguageChange(event: Event): Promise<void> {
    const language: string = getSelectValue(event);
    await this.settingsService.setPreferredAudioLanguage(language as PreferredAudioLanguage);
  }

  /**
   * Handles preferred subtitle language selection change.
   *
   * The new language preference is persisted and will be applied on the
   * next video load. Currently playing videos are not affected.
   *
   * @param event - The change event from the select element
   */
  public async onPreferredSubtitleLanguageChange(event: Event): Promise<void> {
    const language: string = getSelectValue(event);
    await this.settingsService.setPreferredSubtitleLanguage(language as PreferredSubtitleLanguage);
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
   * Handles color scheme selection change.
   *
   * @param event - The change event from the select element
   */
  public async onColorSchemeChange(event: Event): Promise<void> {
    const scheme: string = getSelectValue(event);
    await this.settingsService.setColorScheme(scheme as ColorScheme);
  }

  // ============================================================================
  // Background HSL Event Handlers
  // ============================================================================

  /**
   * Handles background hue slider change.
   *
   * @param event - The input event from the slider
   */
  public async onBackgroundHueChange(event: Event): Promise<void> {
    const hue: number = parseFloat(getInputValue(event));
    if (!isNaN(hue)) await this.settingsService.setBackgroundHue(hue);
  }

  /**
   * Handles background saturation slider change.
   *
   * @param event - The input event from the slider
   */
  public async onBackgroundSaturationChange(event: Event): Promise<void> {
    const saturation: number = parseFloat(getInputValue(event));
    if (!isNaN(saturation)) await this.settingsService.setBackgroundSaturation(saturation);
  }

  /**
   * Handles background lightness slider change.
   *
   * @param event - The input event from the slider
   */
  public async onBackgroundLightnessChange(event: Event): Promise<void> {
    const lightness: number = parseFloat(getInputValue(event));
    if (!isNaN(lightness)) await this.settingsService.setBackgroundLightness(lightness);
  }

  // ============================================================================
  // Window Tint HSLA Event Handlers
  // ============================================================================

  /**
   * Handles window tint hue slider change.
   *
   * @param event - The input event from the slider
   */
  public async onWindowTintHueChange(event: Event): Promise<void> {
    const hue: number = parseFloat(getInputValue(event));
    if (!isNaN(hue)) await this.settingsService.setWindowTintHue(hue);
  }

  /**
   * Handles window tint saturation slider change.
   *
   * @param event - The input event from the slider
   */
  public async onWindowTintSaturationChange(event: Event): Promise<void> {
    const saturation: number = parseFloat(getInputValue(event));
    if (!isNaN(saturation)) await this.settingsService.setWindowTintSaturation(saturation);
  }

  /**
   * Handles window tint lightness slider change.
   *
   * @param event - The input event from the slider
   */
  public async onWindowTintLightnessChange(event: Event): Promise<void> {
    const lightness: number = parseFloat(getInputValue(event));
    if (!isNaN(lightness)) await this.settingsService.setWindowTintLightness(lightness);
  }

  /**
   * Handles window tint alpha slider change.
   *
   * @param event - The input event from the slider
   */
  public async onWindowTintAlphaChange(event: Event): Promise<void> {
    const alpha: number = parseFloat(getInputValue(event));
    if (!isNaN(alpha)) await this.settingsService.setWindowTintAlpha(alpha);
  }

  // ============================================================================
  // Unified Window Color Event Handlers (routes to background or tint based on glass state)
  // ============================================================================

  /**
   * Handles unified window color hue slider change.
   * Routes to background or tint based on glass state.
   *
   * @param event - The input event from the slider
   */
  public async onWindowColorHueChange(event: Event): Promise<void> {
    const hue: number = parseFloat(getInputValue(event));
    if (isNaN(hue)) return;

    if (this.currentGlassEnabled() && this.supportsGlass()) {
      await this.settingsService.setWindowTintHue(hue);
    } else {
      await this.settingsService.setBackgroundHue(hue);
    }
  }

  /**
   * Handles unified window color saturation slider change.
   * Routes to background or tint based on glass state.
   *
   * @param event - The input event from the slider
   */
  public async onWindowColorSaturationChange(event: Event): Promise<void> {
    const saturation: number = parseFloat(getInputValue(event));
    if (isNaN(saturation)) return;

    if (this.currentGlassEnabled() && this.supportsGlass()) {
      await this.settingsService.setWindowTintSaturation(saturation);
    } else {
      await this.settingsService.setBackgroundSaturation(saturation);
    }
  }

  /**
   * Handles unified window color lightness slider change.
   * Routes to background or tint based on glass state.
   *
   * @param event - The input event from the slider
   */
  public async onWindowColorLightnessChange(event: Event): Promise<void> {
    const lightness: number = parseFloat(getInputValue(event));
    if (isNaN(lightness)) return;

    if (this.currentGlassEnabled() && this.supportsGlass()) {
      await this.settingsService.setWindowTintLightness(lightness);
    } else {
      await this.settingsService.setBackgroundLightness(lightness);
    }
  }

  // ============================================================================
  // Subtitle Event Handlers
  // ============================================================================

  /**
   * Handles subtitle font size slider change.
   *
   * @param event - The input event from the slider
   */
  public async onSubtitleFontSizeChange(event: Event): Promise<void> {
    const size: number = parseInt(getInputValue(event), 10);
    if (!isNaN(size)) await this.settingsService.setSubtitleFontSize(size);
  }

  /**
   * Handles subtitle font color change.
   *
   * @param event - The input event from the color picker
   */
  public async onSubtitleFontColorChange(event: Event): Promise<void> {
    const color: string = getInputValue(event);
    if (color) await this.settingsService.setSubtitleFontColor(color);
  }

  /**
   * Handles subtitle background color change.
   *
   * @param event - The input event from the color picker
   */
  public async onSubtitleBackgroundColorChange(event: Event): Promise<void> {
    const color: string = getInputValue(event);
    if (color) await this.settingsService.setSubtitleBackgroundColor(color);
  }

  /**
   * Handles subtitle background opacity slider change.
   *
   * @param event - The input event from the slider
   */
  public async onSubtitleBackgroundOpacityChange(event: Event): Promise<void> {
    const opacity: number = parseFloat(getInputValue(event));
    if (!isNaN(opacity)) await this.settingsService.setSubtitleBackgroundOpacity(opacity);
  }

  /**
   * Handles subtitle font family select change.
   *
   * @param event - The change event from the select
   */
  public async onSubtitleFontFamilyChange(event: Event): Promise<void> {
    const family: string = getSelectValue(event);
    if (family) await this.settingsService.setSubtitleFontFamily(family as SubtitleFontFamily);
  }

  /**
   * Handles subtitle text shadow toggle change.
   *
   * @param event - The change event from the checkbox
   */
  public async onSubtitleTextShadowChange(event: Event): Promise<void> {
    const checked: boolean = getCheckboxValue(event);
    await this.settingsService.setSubtitleTextShadow(checked);
  }

  /**
   * Handles subtitle shadow spread slider change.
   *
   * @param event - The input event from the slider
   */
  public async onSubtitleShadowSpreadChange(event: Event): Promise<void> {
    const value: string = getInputValue(event);
    const spread: number = parseFloat(value);
    if (!isNaN(spread)) await this.settingsService.setSubtitleShadowSpread(spread);
  }

  /**
   * Handles subtitle shadow blur slider change.
   *
   * @param event - The input event from the slider
   */
  public async onSubtitleShadowBlurChange(event: Event): Promise<void> {
    const value: string = getInputValue(event);
    const blur: number = parseFloat(value);
    if (!isNaN(blur)) await this.settingsService.setSubtitleShadowBlur(blur);
  }

  /**
   * Handles subtitle shadow color picker change.
   *
   * @param event - The input event from the color picker
   */
  public async onSubtitleShadowColorChange(event: Event): Promise<void> {
    const color: string = getInputValue(event);
    await this.settingsService.setSubtitleShadowColor(color);
  }

  /**
   * Formats the subtitle font size for display.
   *
   * @returns The font size formatted as a percentage string
   */
  public formatSubtitleFontSize(): string {
    return `${this.currentSubtitleFontSize()}%`;
  }

  /**
   * Formats the subtitle background opacity for display.
   *
   * @returns The opacity formatted as a percentage string
   */
  public formatSubtitleBackgroundOpacity(): string {
    return `${Math.round(this.currentSubtitleBackgroundOpacity() * 100)}%`;
  }

  /**
   * Formats the subtitle shadow spread for display.
   *
   * @returns The shadow spread formatted as a pixel string
   */
  public formatSubtitleShadowSpread(): string {
    return `${this.currentSubtitleShadowSpread()}px`;
  }

  /**
   * Formats the subtitle shadow blur for display.
   *
   * @returns The shadow blur formatted as a pixel string
   */
  public formatSubtitleShadowBlur(): string {
    return `${this.currentSubtitleShadowBlur()}px`;
  }

  // ============================================================================
  // Dependency Event Handlers
  // ============================================================================

  /**
   * Installs a dependency using the platform package manager.
   */
  public async onInstallDependency(id: DependencyId): Promise<void> {
    await this.dependencyService.installDependency(id);
  }

  /**
   * Uninstalls a dependency using the platform package manager.
   */
  public async onUninstallDependency(id: DependencyId): Promise<void> {
    await this.dependencyService.uninstallDependency(id);
  }

  /**
   * Opens the file dialog and installs a SoundFont file.
   */
  public async onInstallSoundFont(): Promise<void> {
    await this.dependencyService.installSoundFont();
  }

  /**
   * Removes a SoundFont file from the app data directory.
   */
  public async onRemoveSoundFont(fileName: string): Promise<void> {
    await this.dependencyService.removeSoundFont(fileName);
  }

  /**
   * Selects a SoundFont as the active one for MIDI playback.
   */
  public async onSelectSoundFont(fileName: string): Promise<void> {
    await this.dependencyService.setActiveSoundFont(fileName);
  }

  /**
   * Checks if a SoundFont is the currently active one.
   * Compares by file path since that's what activeSoundFont contains.
   */
  public isActiveSoundFont(sf: SoundFontInfo): boolean {
    return sf.filePath === this.activeSoundFontPath();
  }

  /**
   * Opens the manual download URL in the default browser.
   */
  public onOpenManualDownload(url: string): void {
    window.open(url, '_blank');
  }

  /**
   * Formats a file size in bytes to a human-readable string.
   */
  public formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
   * Uses currentVizSettings to ensure reactive updates.
   *
   * @param vizId - The visualization ID
   * @param setting - The setting key
   * @returns True if the setting has a custom value
   */
  public hasCustomSetting(vizId: string, setting: LocalSettingKey): boolean {
    // Read from currentVizSettings() to establish reactive dependency
    const vizSettings: Record<string, number | string | undefined> = this.currentVizSettings();
    return vizSettings[setting] !== undefined;
  }

  /**
   * Gets the effective value for a per-visualization setting.
   * Uses currentVizSettings computed to ensure reactive updates.
   *
   * @param vizId - The visualization ID
   * @param setting - The setting key
   * @returns The effective value (custom or default)
   */
  public getEffectiveSetting<K extends LocalSettingKey>(vizId: string, setting: K): number | BarDensity {
    // Read from currentVizSettings() to establish reactive dependency
    const vizSettings: Record<string, number | string | undefined> = this.currentVizSettings();
    const customValue: number | string | undefined = vizSettings[setting];
    if (customValue !== undefined) {
      return customValue as number | BarDensity;
    }
    // Fall back to default value
    return VISUALIZATION_LOCAL_DEFAULTS[setting] as number | BarDensity;
  }

  /**
   * Formats a numeric setting value as a percentage string.
   * Uses getEffectiveSetting to ensure reactive updates.
   *
   * @param vizId - The visualization ID
   * @param setting - The setting key
   * @returns The value as a percentage (e.g., "50%")
   */
  public formatPercentSetting(vizId: string, setting: LocalSettingKey): string {
    const value: number = this.getEffectiveSetting(vizId, setting) as number;
    return `${Math.round(value * 100)}%`;
  }

  /**
   * Formats the line width setting with units.
   * Uses getEffectiveSetting to ensure reactive updates.
   *
   * @param vizId - The visualization ID
   * @returns The line width with px units (e.g., "2.0px")
   */
  public formatLineWidth(vizId: string): string {
    const value: number = this.getEffectiveSetting(vizId, 'lineWidth') as number;
    return `${value.toFixed(1)}px`;
  }

  /**
   * Formats the strobe frequency setting with units.
   * Uses getEffectiveSetting to ensure reactive updates.
   *
   * @param vizId - The visualization ID
   * @returns The strobe frequency with Hz units (e.g., "5 Hz")
   */
  public formatStrobeFrequency(vizId: string): string {
    const value: number = this.getEffectiveSetting(vizId, 'strobeFrequency') as number;
    return `${Math.round(value)} Hz`;
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
   * Handles per-visualization color setting change.
   *
   * @param vizId - The visualization ID
   * @param setting - The color setting key
   * @param event - The input event from the color picker
   */
  public async onPerVizColorChange(vizId: string, setting: LocalSettingKey, event: Event): Promise<void> {
    const color: string = getInputValue(event);
    await this.settingsService.setVisualizationSetting(vizId, setting, color);
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
    const meta: VisualizationMetadata | undefined = this.settingsService.getVisualizationMetadata(vizId);
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

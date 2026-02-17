/**
 * @fileoverview Angular service for managing application settings.
 *
 * This service handles persistent user preferences stored on the server.
 * Settings are synchronized via SSE events and persisted to disk.
 *
 * Current settings:
 * - Application: server port, controls auto-hide delay
 * - Appearance: glass effects, background/tint colors
 * - Playback: volume, crossfade, skip duration, aspect mode, preferred audio language
 * - Subtitles: font size, colors, shadow effects
 * - Transcoding: video quality, audio bitrate
 * - Visualization: default type, frame rate, FFT size, per-visualization settings
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
 * - pulsar: Pulsing concentric rings with curved waveforms (waves category)
 * - water: Water ripple effect with rotating waveforms (waves category)
 * - infinity: Dual orbiting circles with spectrum cycling
 */

/**
 * Valid FFT size values (must be powers of 2).
 */
export type FftSize = 256 | 512 | 1024 | 2048 | 4096;

/**
 * Bar density levels for bar-based visualizations.
 */
export type BarDensity = 'low' | 'medium' | 'high';

/**
 * Per-visualization local settings.
 * All values are optional - if not set, defaults are used.
 */
export interface VisualizationLocalSettings {
  readonly sensitivity?: number;
  readonly barDensity?: BarDensity;
  readonly trailIntensity?: number;
  readonly lineWidth?: number;
  readonly glowIntensity?: number;
  readonly waveformSmoothing?: number;
  readonly barColorBottom?: string;
  readonly barColorMiddle?: string;
  readonly barColorTop?: string;
}

/**
 * Map of visualization type to its local settings.
 */
export type PerVisualizationSettings = Partial<Record<string, VisualizationLocalSettings>>;

/**
 * Keys for local settings that can be customized per visualization.
 */
export type LocalSettingKey = keyof VisualizationLocalSettings;

/**
 * Metadata for a visualization including applicable settings.
 */
export interface VisualizationMetadata {
  readonly id: string;
  readonly name: string;
  readonly category: 'Bars' | 'Waves';
  readonly applicableSettings: readonly LocalSettingKey[];
}

/**
 * Video quality preset levels for transcoding.
 */
export type VideoQuality = 'low' | 'medium' | 'high';

/**
 * Audio bitrate options for transcoding (kbps).
 */
export type AudioBitrate = 128 | 192 | 256 | 320;

/**
 * Hardware acceleration options for video transcoding.
 * - auto: Automatically select the best available hardware encoder
 * - disabled: Always use software encoding (libx264)
 * - h264_videotoolbox: macOS VideoToolbox (Apple Silicon & Intel)
 * - h264_nvenc: NVIDIA NVENC
 * - h264_qsv: Intel Quick Sync Video
 * - h264_amf: AMD AMF (Windows)
 * - h264_vaapi: Linux VA-API
 */
export type HardwareAcceleration = 'auto' | 'disabled' | 'h264_videotoolbox' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'h264_vaapi';

/**
 * Video aspect mode options.
 * - default: Use the video's native aspect ratio
 * - 4:3: Force 4:3 aspect ratio
 * - 16:9: Force 16:9 aspect ratio
 * - fit: Fit to screen (stretch to fill canvas)
 */
export type VideoAspectMode = 'default' | '4:3' | '16:9' | 'fit';

/**
 * Preferred audio language codes (ISO 639-2/B).
 *
 * Used by the video-outlet to auto-select an audio track when loading
 * videos with multiple audio streams (e.g., anime with Japanese/English).
 *
 * Selection priority:
 * 1. Track matching the user's preferred language
 * 2. Track marked as default in the container
 * 3. First track (index 0)
 *
 * 'default' means use the file's default track (skip step 1).
 */
export type PreferredAudioLanguage =
  | 'default' | 'eng' | 'spa' | 'fre' | 'ger' | 'ita' | 'por' | 'rus'
  | 'jpn' | 'kor' | 'chi' | 'ara' | 'hin' | 'tha' | 'vie' | 'pol'
  | 'dut' | 'swe' | 'nor' | 'dan' | 'fin' | 'tur' | 'heb' | 'cze' | 'hun';

/**
 * Preferred subtitle language codes (ISO 639-2/B).
 *
 * Used by the video-outlet to auto-select a subtitle track when loading
 * videos with embedded subtitles.
 *
 * Selection priority:
 * 1. If 'off' → disable subtitles
 * 2. Track matching the user's preferred language
 * 3. Track marked as default in the container
 * 4. Fall back to subtitles off
 *
 * 'off' disables subtitles by default.
 * 'default' uses the file's default track if one exists.
 */
export type PreferredSubtitleLanguage =
  | 'off' | 'default' | 'eng' | 'spa' | 'fre' | 'ger' | 'ita' | 'por' | 'rus'
  | 'jpn' | 'kor' | 'chi' | 'ara' | 'hin' | 'tha' | 'vie' | 'pol'
  | 'dut' | 'swe' | 'nor' | 'dan' | 'fin' | 'tur' | 'heb' | 'cze' | 'hun';

/**
 * Subtitle font family options.
 */
export type SubtitleFontFamily = 'sans-serif' | 'serif' | 'monospace' | 'Arial';

/**
 * Subtitle appearance settings.
 */
export interface SubtitleSettings {
  /** Font size as percentage (50-300, default 100) */
  readonly fontSize: number;
  /** Font color in hex format (default '#ffffff') */
  readonly fontColor: string;
  /** Background color in hex format (default '#000000') */
  readonly backgroundColor: string;
  /** Background opacity (0-1, default 0.75) */
  readonly backgroundOpacity: number;
  /** Font family (sans-serif, serif, monospace, default 'sans-serif') */
  readonly fontFamily: SubtitleFontFamily;
  /** Whether to show text shadow for better visibility (default true) */
  readonly textShadow: boolean;
  /** Shadow spread/offset in pixels (1-5, default 2) - controls outline thickness */
  readonly shadowSpread: number;
  /** Shadow blur radius in pixels (0-10, default 2) - 0 for crisp outline */
  readonly shadowBlur: number;
  /** Shadow color in hex format (default '#000000') */
  readonly shadowColor: string;
}

/**
 * Visualization settings structure.
 * Global settings apply to all visualizations.
 * Per-visualization settings are stored in perVisualizationSettings.
 */
export interface VisualizationSettings {
  /** The default visualization to display on startup */
  readonly defaultType: string;
  /** Maximum frame rate for visualizations (0 = uncapped, or 15/30/60) */
  readonly maxFrameRate: number;
  /** FFT size for audio analysis (256, 512, 1024, 2048, or 4096, default 2048) */
  readonly fftSize: FftSize;
  /** Per-visualization local settings (sensitivity, barDensity, trailIntensity, etc.) */
  readonly perVisualizationSettings: PerVisualizationSettings;
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
  /** Skip duration in seconds (1-60, default 10) */
  readonly skipDuration: number;
  /** Video aspect mode (default, 4:3, 16:9, fit) */
  readonly videoAspectMode: VideoAspectMode;
  /** Preferred audio language (ISO 639-2/B code, or 'default' for file default) */
  readonly preferredAudioLanguage: PreferredAudioLanguage;
  /** Preferred subtitle language (ISO 639-2/B code, 'default' for file default, or 'off' to disable) */
  readonly preferredSubtitleLanguage: PreferredSubtitleLanguage;
}

/**
 * Transcoding settings.
 */
export interface TranscodingSettings {
  /** Video quality preset for transcoding (low, medium, high, default medium) */
  readonly videoQuality: VideoQuality;
  /** Audio bitrate in kbps (128, 192, 256, 320, default 192) */
  readonly audioBitrate: AudioBitrate;
  /** Hardware acceleration mode for video encoding (default 'auto') */
  readonly hardwareAcceleration: HardwareAcceleration;
}

/**
 * macOS visual effect state.
 */
export type MacOSVisualEffectState = 'followWindow' | 'active' | 'inactive';

/**
 * Color scheme preference.
 * - system: Follow system preference
 * - dark: Force dark mode
 * - light: Force light mode
 */
export type ColorScheme = 'system' | 'dark' | 'light';

/**
 * Appearance settings (cross-platform).
 * Supports glass effects (vibrancy on macOS, acrylic on Windows) and background color.
 */
export interface AppearanceSettings {
  /** Whether glass effect (transparency/blur) is enabled */
  readonly glassEnabled: boolean;
  /** macOS visual effect state - only used on macOS when glassEnabled */
  readonly macOSVisualEffectState: MacOSVisualEffectState;
  /** Color scheme preference (system, dark, light) */
  readonly colorScheme: ColorScheme;
  /** Background color when glass is disabled or unsupported (hex format, derived from HSL) */
  readonly backgroundColor: string;
  /** Background hue (0-360) when glass is disabled */
  readonly backgroundHue: number;
  /** Background saturation (0-100) when glass is disabled */
  readonly backgroundSaturation: number;
  /** Background lightness (0-100) when glass is disabled */
  readonly backgroundLightness: number;
  /** Window tint hue (0-360) when glass is enabled */
  readonly windowTintHue: number;
  /** Window tint saturation (0-100) when glass is enabled */
  readonly windowTintSaturation: number;
  /** Window tint lightness (0-100) when glass is enabled */
  readonly windowTintLightness: number;
  /** Window tint alpha (0-1) when glass is enabled */
  readonly windowTintAlpha: number;
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
  /** Appearance settings (platform-specific) */
  readonly appearance: AppearanceSettings;
  /** Subtitle appearance settings */
  readonly subtitles: SubtitleSettings;
}

/**
 * Display information for a visualization option.
 */
export interface VisualizationOption {
  /** The visualization type value */
  readonly value: string;
  /** Human-readable display label */
  readonly label: string;
  /** Optional description */
  readonly description?: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default values for per-visualization local settings.
 * Used when a setting is not customized for a visualization.
 */
export const VISUALIZATION_LOCAL_DEFAULTS: Required<VisualizationLocalSettings> = {
  sensitivity: 0.5,
  barDensity: 'medium',
  trailIntensity: 0.5,
  lineWidth: 2.0,
  glowIntensity: 0.5,
  waveformSmoothing: 0.5,
  barColorBottom: '#00cc00',
  barColorMiddle: '#cccc00',
  barColorTop: '#cc0000',
};

/**
 * Metadata for all visualizations including which settings apply to each.
 */
export const VISUALIZATION_METADATA: readonly VisualizationMetadata[] = [
  // Bars category
  {id: 'bars', name: 'Analyzer', category: 'Bars', applicableSettings: ['sensitivity', 'barDensity', 'barColorBottom', 'barColorMiddle', 'barColorTop']},
  {id: 'tether', name: 'Spectre', category: 'Bars', applicableSettings: ['sensitivity', 'barDensity']},
  // Waves category
  {id: 'waveform', name: 'Classic', category: 'Waves', applicableSettings: ['sensitivity', 'trailIntensity', 'lineWidth', 'glowIntensity', 'waveformSmoothing']},
  {id: 'modern', name: 'Modern', category: 'Waves', applicableSettings: ['sensitivity', 'trailIntensity', 'lineWidth', 'glowIntensity', 'waveformSmoothing']},
  {id: 'tunnel', name: 'Plasma', category: 'Waves', applicableSettings: ['sensitivity', 'trailIntensity', 'lineWidth', 'glowIntensity', 'waveformSmoothing']},
  {id: 'neon', name: 'Neon', category: 'Waves', applicableSettings: ['sensitivity', 'trailIntensity', 'lineWidth', 'glowIntensity', 'waveformSmoothing']},
  {id: 'pulsar', name: 'Pulsar', category: 'Waves', applicableSettings: ['sensitivity', 'trailIntensity', 'lineWidth', 'glowIntensity', 'waveformSmoothing']},
  {id: 'water', name: 'Water', category: 'Waves', applicableSettings: ['sensitivity', 'trailIntensity', 'lineWidth', 'glowIntensity', 'waveformSmoothing']},
  {id: 'infinity', name: 'Infinity', category: 'Waves', applicableSettings: ['sensitivity', 'trailIntensity', 'lineWidth', 'glowIntensity', 'waveformSmoothing']},
  {id: 'onix', name: 'Onix', category: 'Waves', applicableSettings: ['sensitivity', 'trailIntensity', 'lineWidth', 'glowIntensity', 'waveformSmoothing']},
];

/**
 * Default settings used before server data is received.
 */
const DEFAULT_SETTINGS: AppSettings = {
  version: 2,
  visualization: {
    defaultType: 'bars',
    maxFrameRate: 0,
    fftSize: 2048,
    perVisualizationSettings: {},
  },
  application: {
    serverPort: 0,
    controlsAutoHideDelay: 5,
  },
  playback: {
    defaultVolume: 0.5,
    crossfadeDuration: 100,
    previousTrackThreshold: 3,
    skipDuration: 10,
    videoAspectMode: 'default',
    preferredAudioLanguage: 'eng',
    preferredSubtitleLanguage: 'off',
  },
  transcoding: {
    videoQuality: 'medium',
    audioBitrate: 192,
    hardwareAcceleration: 'auto',
  },
  appearance: {
    glassEnabled: true,
    macOSVisualEffectState: 'active',
    colorScheme: 'system',
    backgroundColor: '#1e1e1e',
    backgroundHue: 0,
    backgroundSaturation: 0,
    backgroundLightness: 12,
    windowTintHue: 0,
    windowTintSaturation: 0,
    windowTintLightness: 0,
    windowTintAlpha: 0,
  },
  subtitles: {
    fontSize: 100,
    fontColor: '#ffffff',
    backgroundColor: '#000000',
    backgroundOpacity: 0.75,
    fontFamily: 'sans-serif',
    textShadow: true,
    shadowSpread: 2,
    shadowBlur: 2,
    shadowColor: '#000000',
  },
};

/**
 * Available visualization options for the settings UI.
 */
export const VISUALIZATION_OPTIONS: readonly VisualizationOption[] = [
  // Bars category
  {value: 'bars', label: 'Bars : Analyzer', description: 'Configurable frequency bars with gradient'},
  {value: 'tether', label: 'Bars : Spectre', description: 'Mirrored frequency bars with smoke effect'},
  // Waves category
  {value: 'waveform', label: 'Waves : Classic', description: 'Oscilloscope-style waveform with glow'},
  {value: 'modern', label: 'Waves : Modern', description: 'Frequency spectrum with gradient glow'},
  {value: 'tunnel', label: 'Waves : Plasma', description: 'Dual waveforms with plasma zoom effect'},
  {value: 'infinity', label: 'Waves : Infinity', description: 'Dual orbiting circles with spectrum cycling'},
  {value: 'neon', label: 'Waves : Neon', description: 'Rotating cyan/magenta waveforms'},
  {value: 'onix', label: 'Waves : Onix', description: 'ONIXLabs logo with pulsating rings'},
  {value: 'pulsar', label: 'Waves : Pulsar', description: 'Pulsing concentric rings with curved waveforms'},
  {value: 'water', label: 'Waves : Water', description: 'Water ripple effect with rotating waveforms'},
];

/**
 * Display information for a video aspect option.
 */
export interface VideoAspectOption {
  /** The aspect mode value */
  readonly value: VideoAspectMode;
  /** Human-readable display label */
  readonly label: string;
}

/**
 * Available video aspect mode options for the settings UI.
 */
export const VIDEO_ASPECT_OPTIONS: readonly VideoAspectOption[] = [
  {value: 'default', label: 'Default'},
  {value: '4:3', label: 'Forced (4:3)'},
  {value: '16:9', label: 'Forced (16:9)'},
  {value: 'fit', label: 'Fit to Screen'},
];

/**
 * Display information for an audio language option.
 */
export interface AudioLanguageOption {
  /** The ISO 639-2/B language code */
  readonly value: PreferredAudioLanguage;
  /** Human-readable display label */
  readonly label: string;
}

/**
 * Available audio language options for the settings UI.
 *
 * Languages use ISO 639-2/B codes which FFprobe returns in stream metadata.
 * The list prioritizes commonly used languages in media distribution.
 * 'File Default' (value: 'default') defers to the container's default track.
 */
export const AUDIO_LANGUAGE_OPTIONS: readonly AudioLanguageOption[] = [
  {value: 'default', label: 'File Default'},
  {value: 'eng', label: 'English'},
  {value: 'spa', label: 'Spanish'},
  {value: 'fre', label: 'French'},
  {value: 'ger', label: 'German'},
  {value: 'ita', label: 'Italian'},
  {value: 'por', label: 'Portuguese'},
  {value: 'rus', label: 'Russian'},
  {value: 'jpn', label: 'Japanese'},
  {value: 'kor', label: 'Korean'},
  {value: 'chi', label: 'Chinese'},
  {value: 'ara', label: 'Arabic'},
  {value: 'hin', label: 'Hindi'},
  {value: 'tha', label: 'Thai'},
  {value: 'vie', label: 'Vietnamese'},
  {value: 'pol', label: 'Polish'},
  {value: 'dut', label: 'Dutch'},
  {value: 'swe', label: 'Swedish'},
  {value: 'nor', label: 'Norwegian'},
  {value: 'dan', label: 'Danish'},
  {value: 'fin', label: 'Finnish'},
  {value: 'tur', label: 'Turkish'},
  {value: 'heb', label: 'Hebrew'},
  {value: 'cze', label: 'Czech'},
  {value: 'hun', label: 'Hungarian'},
];

/**
 * Display information for a subtitle language option.
 */
export interface SubtitleLanguageOption {
  /** The ISO 639-2/B language code, or 'off'/'default' */
  readonly value: PreferredSubtitleLanguage;
  /** Human-readable display label */
  readonly label: string;
}

/**
 * Available subtitle language options for the settings UI.
 *
 * Includes 'Subtitles Off' as a selectable preference to disable subtitles by default.
 * Languages use ISO 639-2/B codes which FFprobe returns in stream metadata.
 */
export const SUBTITLE_LANGUAGE_OPTIONS: readonly SubtitleLanguageOption[] = [
  {value: 'off', label: 'Subtitles Off'},
  {value: 'default', label: 'File Default'},
  {value: 'eng', label: 'English'},
  {value: 'spa', label: 'Spanish'},
  {value: 'fre', label: 'French'},
  {value: 'ger', label: 'German'},
  {value: 'ita', label: 'Italian'},
  {value: 'por', label: 'Portuguese'},
  {value: 'rus', label: 'Russian'},
  {value: 'jpn', label: 'Japanese'},
  {value: 'kor', label: 'Korean'},
  {value: 'chi', label: 'Chinese'},
  {value: 'ara', label: 'Arabic'},
  {value: 'hin', label: 'Hindi'},
  {value: 'tha', label: 'Thai'},
  {value: 'vie', label: 'Vietnamese'},
  {value: 'pol', label: 'Polish'},
  {value: 'dut', label: 'Dutch'},
  {value: 'swe', label: 'Swedish'},
  {value: 'nor', label: 'Norwegian'},
  {value: 'dan', label: 'Danish'},
  {value: 'fin', label: 'Finnish'},
  {value: 'tur', label: 'Turkish'},
  {value: 'heb', label: 'Hebrew'},
  {value: 'cze', label: 'Czech'},
  {value: 'hun', label: 'Hungarian'},
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
 *   async onVisualizationChange(type: string) {
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

  /** The default visualization type (persisted setting) */
  public readonly defaultVisualization: ReturnType<typeof computed<string>> = computed(
    (): string => this.settings().visualization.defaultType
  );

  /** Maximum frame rate for visualizations (0 = uncapped) */
  public readonly maxFrameRate: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().visualization?.maxFrameRate ?? 0
  );

  /** FFT size for audio analysis (256, 512, 1024, 2048, or 4096) */
  public readonly fftSize: ReturnType<typeof computed<FftSize>> = computed(
    (): FftSize => this.settings().visualization?.fftSize ?? 2048
  );

  /** Per-visualization settings map */
  public readonly perVisualizationSettings: ReturnType<typeof computed<PerVisualizationSettings>> = computed(
    (): PerVisualizationSettings => this.settings().visualization?.perVisualizationSettings ?? {}
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

  /** Skip duration in seconds (how far to skip forward/backward) */
  public readonly skipDuration: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().playback?.skipDuration ?? 10
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

  /** Hardware acceleration mode for video transcoding */
  public readonly hardwareAcceleration: ReturnType<typeof computed<HardwareAcceleration>> = computed(
    (): HardwareAcceleration => this.settings().transcoding?.hardwareAcceleration ?? 'auto'
  );

  /** Video aspect mode for video playback */
  public readonly videoAspectMode: ReturnType<typeof computed<VideoAspectMode>> = computed(
    (): VideoAspectMode => this.settings().playback?.videoAspectMode ?? 'default'
  );

  /**
   * Preferred audio language for video playback.
   *
   * Used by video-outlet to auto-select audio tracks in multi-track videos.
   * Defaults to 'eng' (English) for new installations to provide sensible
   * behavior for the majority of users. Users can change to 'default' to
   * always use the container's default track, or select another language.
   */
  public readonly preferredAudioLanguage: ReturnType<typeof computed<PreferredAudioLanguage>> = computed(
    (): PreferredAudioLanguage => this.settings().playback?.preferredAudioLanguage ?? 'eng'
  );

  /**
   * Preferred subtitle language for video playback.
   *
   * Used by video-outlet to auto-select subtitle tracks in videos with embedded subtitles.
   * Defaults to 'off' to disable subtitles by default. Users can set a language preference
   * or use 'default' to always use the container's default subtitle track if one exists.
   */
  public readonly preferredSubtitleLanguage: ReturnType<typeof computed<PreferredSubtitleLanguage>> = computed(
    (): PreferredSubtitleLanguage => this.settings().playback?.preferredSubtitleLanguage ?? 'off'
  );

  /** Whether glass effect is enabled (requires restart to apply) */
  public readonly glassEnabled: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.settings().appearance?.glassEnabled ?? true
  );

  /** macOS visual effect state (requires restart to apply) */
  public readonly macOSVisualEffectState: ReturnType<typeof computed<MacOSVisualEffectState>> = computed(
    (): MacOSVisualEffectState => this.settings().appearance?.macOSVisualEffectState ?? 'active'
  );

  /** Color scheme preference (system, dark, light) */
  public readonly colorScheme: ReturnType<typeof computed<ColorScheme>> = computed(
    (): ColorScheme => this.settings().appearance?.colorScheme ?? 'system'
  );

  /** Background color when glass is disabled (hex, derived from HSL) */
  public readonly backgroundColor: ReturnType<typeof computed<string>> = computed(
    (): string => this.settings().appearance?.backgroundColor ?? '#1e1e1e'
  );

  /** Background hue (0-360) when glass is disabled */
  public readonly backgroundHue: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().appearance?.backgroundHue ?? 0
  );

  /** Background saturation (0-100) when glass is disabled */
  public readonly backgroundSaturation: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().appearance?.backgroundSaturation ?? 0
  );

  /** Background lightness (0-100) when glass is disabled */
  public readonly backgroundLightness: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().appearance?.backgroundLightness ?? 12
  );

  /** Window tint hue (0-360) when glass is enabled */
  public readonly windowTintHue: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().appearance?.windowTintHue ?? 0
  );

  /** Window tint saturation (0-100) when glass is enabled */
  public readonly windowTintSaturation: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().appearance?.windowTintSaturation ?? 0
  );

  /** Window tint lightness (0-100) when glass is enabled */
  public readonly windowTintLightness: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().appearance?.windowTintLightness ?? 0
  );

  /** Window tint alpha (0-1) when glass is enabled */
  public readonly windowTintAlpha: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().appearance?.windowTintAlpha ?? 0
  );

  // ============================================================================
  // Subtitle Settings Computed Signals
  // ============================================================================

  /** Subtitle font size as percentage (50-200) */
  public readonly subtitleFontSize: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().subtitles?.fontSize ?? 100
  );

  /** Subtitle font color in hex format */
  public readonly subtitleFontColor: ReturnType<typeof computed<string>> = computed(
    (): string => this.settings().subtitles?.fontColor ?? '#ffffff'
  );

  /** Subtitle background color in hex format */
  public readonly subtitleBackgroundColor: ReturnType<typeof computed<string>> = computed(
    (): string => this.settings().subtitles?.backgroundColor ?? '#000000'
  );

  /** Subtitle background opacity (0-1) */
  public readonly subtitleBackgroundOpacity: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().subtitles?.backgroundOpacity ?? 0.75
  );

  /** Subtitle font family */
  public readonly subtitleFontFamily: ReturnType<typeof computed<SubtitleFontFamily>> = computed(
    (): SubtitleFontFamily => this.settings().subtitles?.fontFamily ?? 'sans-serif'
  );

  /** Whether subtitle text shadow is enabled */
  public readonly subtitleTextShadow: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.settings().subtitles?.textShadow ?? true
  );

  /** Subtitle shadow spread/offset in pixels (1-5) */
  public readonly subtitleShadowSpread: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().subtitles?.shadowSpread ?? 2
  );

  /** Subtitle shadow blur radius in pixels (0-10) */
  public readonly subtitleShadowBlur: ReturnType<typeof computed<number>> = computed(
    (): number => this.settings().subtitles?.shadowBlur ?? 2
  );

  /** Subtitle shadow color in hex format */
  public readonly subtitleShadowColor: ReturnType<typeof computed<string>> = computed(
    (): string => this.settings().subtitles?.shadowColor ?? '#000000'
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
   * @param category - Settings category ('visualization', 'application', 'playback', 'transcoding', 'appearance')
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
  public async setDefaultVisualization(type: string): Promise<void> {
    await this.updateSetting('visualization', 'defaultType', type);
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

  // ============================================================================
  // Per-Visualization Settings Methods
  // ============================================================================

  /**
   * Gets the effective value for a local setting on a specific visualization.
   * Returns the customized value if set, otherwise the default.
   *
   * @param vizId - The visualization type ID
   * @param setting - The setting key to get
   * @returns The effective setting value
   */
  public getEffectiveSetting<K extends LocalSettingKey>(vizId: string, setting: K): VisualizationLocalSettings[K] {
    const perViz: PerVisualizationSettings = this.perVisualizationSettings();
    const vizSettings: VisualizationLocalSettings | undefined = perViz[vizId];
    const customValue: VisualizationLocalSettings[K] | undefined = vizSettings?.[setting];
    return customValue !== undefined ? customValue : VISUALIZATION_LOCAL_DEFAULTS[setting];
  }

  /**
   * Checks if a setting has been customized for a visualization.
   *
   * @param vizId - The visualization type ID
   * @param setting - The setting key to check
   * @returns True if the setting has been customized
   */
  public hasCustomSetting(vizId: string, setting: LocalSettingKey): boolean {
    const perViz: PerVisualizationSettings = this.perVisualizationSettings();
    return perViz[vizId]?.[setting] !== undefined;
  }

  /**
   * Checks if a setting is applicable to a visualization.
   *
   * @param vizId - The visualization type ID
   * @param setting - The setting key to check
   * @returns True if the setting applies to this visualization
   */
  public hasApplicableSetting(vizId: string, setting: LocalSettingKey): boolean {
    const meta: VisualizationMetadata | undefined = VISUALIZATION_METADATA.find(
      (v: VisualizationMetadata): boolean => v.id === vizId
    );
    return meta?.applicableSettings.includes(setting) ?? false;
  }

  /**
   * Gets visualization metadata by ID.
   *
   * @param vizId - The visualization type ID
   * @returns The visualization metadata, or undefined if not found
   */
  public getVisualizationMetadata(vizId: string): VisualizationMetadata | undefined {
    return VISUALIZATION_METADATA.find((v: VisualizationMetadata): boolean => v.id === vizId);
  }

  /**
   * Sets a local setting for a specific visualization.
   *
   * @param vizId - The visualization type ID
   * @param setting - The setting key to set
   * @param value - The value to set
   */
  public async setVisualizationSetting<K extends LocalSettingKey>(
    vizId: string,
    setting: K,
    value: VisualizationLocalSettings[K]
  ): Promise<void> {
    // Validate and clamp numeric values
    let validValue: VisualizationLocalSettings[K] = value;
    if (setting === 'sensitivity' || setting === 'trailIntensity' || setting === 'glowIntensity' || setting === 'waveformSmoothing') {
      validValue = this.clamp(value as number, 0, 1) as VisualizationLocalSettings[K];
    } else if (setting === 'lineWidth') {
      validValue = this.clamp(value as number, 1, 5) as VisualizationLocalSettings[K];
    } else if (setting === 'barDensity') {
      const validDensities: readonly BarDensity[] = ['low', 'medium', 'high'];
      if (!validDensities.includes(value as BarDensity)) {
        console.error(`[SettingsService] Invalid bar density: ${value}`);
        return;
      }
    }

    // Build the update with just this visualization's setting
    const vizUpdate: VisualizationLocalSettings = {[setting]: validValue};
    await this.updateSetting('visualization', 'perVisualizationSettings', {[vizId]: vizUpdate});
  }

  /**
   * Resets a single setting for a visualization to its default.
   *
   * @param vizId - The visualization type ID
   * @param setting - The setting key to reset
   */
  public async resetVisualizationSetting(vizId: string, setting: LocalSettingKey): Promise<void> {
    const current: PerVisualizationSettings = {...this.perVisualizationSettings()};
    const vizSettings: VisualizationLocalSettings | undefined = current[vizId];

    if (!vizSettings || vizSettings[setting] === undefined) {
      return; // Nothing to reset
    }

    // Create new settings object without the specified setting
    const {[setting]: _removed, ...remaining}: Partial<VisualizationLocalSettings> = vizSettings;

    // If no settings left, remove the visualization entry entirely
    if (Object.keys(remaining).length === 0) {
      delete current[vizId];
    } else {
      current[vizId] = remaining;
    }

    // Send the full updated perVisualizationSettings
    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    const response: Response = await fetch(`${serverUrl}/settings/visualization`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({perVisualizationSettings: current}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to reset setting: ${response.status}`);
    }
  }

  /**
   * Resets all settings for a visualization to defaults.
   *
   * @param vizId - The visualization type ID
   */
  public async resetAllVisualizationSettings(vizId: string): Promise<void> {
    const current: PerVisualizationSettings = {...this.perVisualizationSettings()};
    delete current[vizId];

    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    const response: Response = await fetch(`${serverUrl}/settings/visualization`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({perVisualizationSettings: current}),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to reset all settings: ${response.status}`);
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
   * Sets the skip duration for forward/backward skip buttons.
   *
   * @param duration - Skip duration in seconds (1-60 valid range)
   */
  public async setSkipDuration(duration: number): Promise<void> {
    await this.updateSetting('playback', 'skipDuration', this.clamp(Math.round(duration), 1, 60));
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
   * Sets the hardware acceleration mode for video transcoding.
   *
   * @param mode - Hardware acceleration mode ('auto', 'disabled', or specific encoder)
   */
  public async setHardwareAcceleration(mode: HardwareAcceleration): Promise<void> {
    const validModes: readonly HardwareAcceleration[] = [
      'auto', 'disabled', 'h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi'
    ];
    if (!validModes.includes(mode)) {
      console.error(`[SettingsService] Invalid hardware acceleration mode: ${mode}`);
      return;
    }
    await this.updateSetting('transcoding', 'hardwareAcceleration', mode);
  }

  /**
   * Sets the video aspect mode for video playback.
   *
   * @param mode - Video aspect mode ('default', '4:3', '16:9', or 'fit')
   */
  public async setVideoAspectMode(mode: VideoAspectMode): Promise<void> {
    const validModes: readonly VideoAspectMode[] = ['default', '4:3', '16:9', 'fit'];
    if (!validModes.includes(mode)) {
      console.error(`[SettingsService] Invalid video aspect mode: ${mode}`);
      return;
    }
    await this.updateSetting('playback', 'videoAspectMode', mode);
  }

  /**
   * Sets the preferred audio language for video playback.
   *
   * The setting takes effect on the next video load - it does not affect
   * currently playing videos. Users can still manually switch audio tracks
   * via the media bar dropdown, which overrides the preference for that file.
   *
   * @param language - ISO 639-2/B language code or 'default' for file default
   */
  public async setPreferredAudioLanguage(language: PreferredAudioLanguage): Promise<void> {
    const validLanguages: readonly PreferredAudioLanguage[] = AUDIO_LANGUAGE_OPTIONS.map(
      (opt: AudioLanguageOption): PreferredAudioLanguage => opt.value
    );
    if (!validLanguages.includes(language)) {
      console.error(`[SettingsService] Invalid audio language: ${language}`);
      return;
    }
    await this.updateSetting('playback', 'preferredAudioLanguage', language);
  }

  /**
   * Sets the preferred subtitle language for video playback.
   *
   * The setting takes effect on the next video load - it does not affect
   * currently playing videos. Users can still manually switch subtitle tracks
   * via the media bar dropdown, which overrides the preference for that file.
   *
   * @param language - ISO 639-2/B language code, 'default' for file default, or 'off' to disable
   */
  public async setPreferredSubtitleLanguage(language: PreferredSubtitleLanguage): Promise<void> {
    const validLanguages: readonly PreferredSubtitleLanguage[] = SUBTITLE_LANGUAGE_OPTIONS.map(
      (opt: SubtitleLanguageOption): PreferredSubtitleLanguage => opt.value
    );
    if (!validLanguages.includes(language)) {
      console.error(`[SettingsService] Invalid subtitle language: ${language}`);
      return;
    }
    await this.updateSetting('playback', 'preferredSubtitleLanguage', language);
  }

  // ============================================================================
  // Appearance Settings
  // ============================================================================

  /**
   * Sets whether glass effect is enabled.
   * Requires application restart to take effect.
   *
   * @param enabled - Whether glass should be enabled
   */
  public async setGlassEnabled(enabled: boolean): Promise<void> {
    await this.updateSetting('appearance', 'glassEnabled', enabled);
  }

  /**
   * Sets the macOS visual effect state.
   * Requires application restart to take effect.
   *
   * @param state - Visual effect state
   */
  public async setMacOSVisualEffectState(state: MacOSVisualEffectState): Promise<void> {
    const validStates: readonly MacOSVisualEffectState[] = ['followWindow', 'active', 'inactive'];
    if (!validStates.includes(state)) {
      console.error(`[SettingsService] Invalid macOS visual effect state: ${state}`);
      return;
    }
    await this.updateSetting('appearance', 'macOSVisualEffectState', state);
  }

  /**
   * Sets the color scheme preference.
   *
   * @param scheme - Color scheme ('system', 'dark', 'light')
   */
  public async setColorScheme(scheme: ColorScheme): Promise<void> {
    const validSchemes: readonly ColorScheme[] = ['system', 'dark', 'light'];
    if (!validSchemes.includes(scheme)) {
      console.error(`[SettingsService] Invalid color scheme: ${scheme}`);
      return;
    }
    await this.updateSetting('appearance', 'colorScheme', scheme);
  }

  /**
   * Sets the background color when glass is disabled.
   *
   * @param color - Hex color string (e.g., '#1e1e1e')
   */
  public async setBackgroundColor(color: string): Promise<void> {
    // Validate hex color format
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
      console.error(`[SettingsService] Invalid hex color: ${color}`);
      return;
    }
    await this.updateSetting('appearance', 'backgroundColor', color);
  }

  /**
   * Sets the background hue (0-360) when glass is disabled.
   *
   * @param hue - Hue value (0-360)
   */
  public async setBackgroundHue(hue: number): Promise<void> {
    await this.updateSetting('appearance', 'backgroundHue', hue);
  }

  /**
   * Sets the background saturation (0-100) when glass is disabled.
   *
   * @param saturation - Saturation value (0-100)
   */
  public async setBackgroundSaturation(saturation: number): Promise<void> {
    await this.updateSetting('appearance', 'backgroundSaturation', saturation);
  }

  /**
   * Sets the background lightness (0-100) when glass is disabled.
   *
   * @param lightness - Lightness value (0-100)
   */
  public async setBackgroundLightness(lightness: number): Promise<void> {
    await this.updateSetting('appearance', 'backgroundLightness', lightness);
  }

  /**
   * Sets the window tint hue (0-360) when glass is enabled.
   *
   * @param hue - Hue value (0-360)
   */
  public async setWindowTintHue(hue: number): Promise<void> {
    await this.updateSetting('appearance', 'windowTintHue', hue);
  }

  /**
   * Sets the window tint saturation (0-100) when glass is enabled.
   *
   * @param saturation - Saturation value (0-100)
   */
  public async setWindowTintSaturation(saturation: number): Promise<void> {
    await this.updateSetting('appearance', 'windowTintSaturation', saturation);
  }

  /**
   * Sets the window tint lightness (0-100) when glass is enabled.
   *
   * @param lightness - Lightness value (0-100)
   */
  public async setWindowTintLightness(lightness: number): Promise<void> {
    await this.updateSetting('appearance', 'windowTintLightness', lightness);
  }

  /**
   * Sets the window tint alpha (0-1) when glass is enabled.
   *
   * @param alpha - Alpha value (0-1)
   */
  public async setWindowTintAlpha(alpha: number): Promise<void> {
    await this.updateSetting('appearance', 'windowTintAlpha', alpha);
  }

  // ============================================================================
  // Subtitle Settings
  // ============================================================================

  /**
   * Sets the subtitle font size.
   *
   * @param size - Font size as percentage (50-300)
   */
  public async setSubtitleFontSize(size: number): Promise<void> {
    await this.updateSetting('subtitles', 'fontSize', this.clamp(Math.round(size), 50, 300));
  }

  /**
   * Sets the subtitle font color.
   *
   * @param color - Hex color string (e.g., '#ffffff')
   */
  public async setSubtitleFontColor(color: string): Promise<void> {
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
      console.error(`[SettingsService] Invalid hex color: ${color}`);
      return;
    }
    await this.updateSetting('subtitles', 'fontColor', color);
  }

  /**
   * Sets the subtitle background color.
   *
   * @param color - Hex color string (e.g., '#000000')
   */
  public async setSubtitleBackgroundColor(color: string): Promise<void> {
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
      console.error(`[SettingsService] Invalid hex color: ${color}`);
      return;
    }
    await this.updateSetting('subtitles', 'backgroundColor', color);
  }

  /**
   * Sets the subtitle background opacity.
   *
   * @param opacity - Opacity value (0-1)
   */
  public async setSubtitleBackgroundOpacity(opacity: number): Promise<void> {
    await this.updateSetting('subtitles', 'backgroundOpacity', this.clamp(opacity, 0, 1));
  }

  /**
   * Sets the subtitle font family.
   *
   * @param family - Font family ('sans-serif', 'serif', or 'monospace')
   */
  public async setSubtitleFontFamily(family: SubtitleFontFamily): Promise<void> {
    const validFamilies: readonly SubtitleFontFamily[] = ['sans-serif', 'serif', 'monospace', 'Arial'];
    if (!validFamilies.includes(family)) {
      console.error(`[SettingsService] Invalid font family: ${family}`);
      return;
    }
    await this.updateSetting('subtitles', 'fontFamily', family);
  }

  /**
   * Sets whether subtitle text shadow is enabled.
   *
   * @param enabled - Whether text shadow should be shown
   */
  public async setSubtitleTextShadow(enabled: boolean): Promise<void> {
    await this.updateSetting('subtitles', 'textShadow', enabled);
  }

  /**
   * Sets the subtitle shadow spread (offset distance).
   *
   * @param spread - Spread in pixels (1-5)
   */
  public async setSubtitleShadowSpread(spread: number): Promise<void> {
    await this.updateSetting('subtitles', 'shadowSpread', spread);
  }

  /**
   * Sets the subtitle shadow blur radius.
   *
   * @param blur - Blur radius in pixels (0-10)
   */
  public async setSubtitleShadowBlur(blur: number): Promise<void> {
    await this.updateSetting('subtitles', 'shadowBlur', blur);
  }

  /**
   * Sets the subtitle shadow color.
   *
   * @param color - Hex color string (e.g., '#000000')
   */
  public async setSubtitleShadowColor(color: string): Promise<void> {
    await this.updateSetting('subtitles', 'shadowColor', color);
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

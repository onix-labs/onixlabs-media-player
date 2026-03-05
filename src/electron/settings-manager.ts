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
import { settingsLogger } from './logger.js';

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
 * - pulsar: PulsarVisualization (pulsing concentric rings, waves category)
 * - water: WaterVisualization (water ripple effect, waves category)
 * - infinity: InfinityVisualization (dual orbiting circles with spectrum cycling)
 */

/**
 * Per-visualization local settings.
 * All values are optional - if not set, defaults are used.
 */
export interface VisualizationLocalSettings {
  /** Sensitivity for this visualization (0.0 - 1.0, default 0.5) */
  readonly sensitivity?: number;
  /** Bar density for bar-based visualizations (low, medium, high) - only for bars, tether */
  readonly barDensity?: BarDensity;
  /** Trail intensity for trail effects (0.0 - 1.0) - only for tunnel, infinity, neon, onix, pulsar, water */
  readonly trailIntensity?: number;
  /** Line width for waveform lines (1.0 - 5.0) - only for waveform, tunnel, infinity, neon, onix, pulsar, water */
  readonly lineWidth?: number;
  /** Glow intensity for glow effects (0.0 - 1.0) - only for waveform, tunnel, infinity, neon, onix, pulsar, water */
  readonly glowIntensity?: number;
  /** Waveform smoothing for curves (0.0 - 1.0) - only for waveform, tunnel, infinity, neon, onix, pulsar, water */
  readonly waveformSmoothing?: number;
  /** Bar gradient bottom color (hex format, e.g., '#00cc00') - only for bars */
  readonly barColorBottom?: string;
  /** Bar gradient middle color (hex format, e.g., '#cccc00') - only for bars */
  readonly barColorMiddle?: string;
  /** Bar gradient top color (hex format, e.g., '#cc0000') - only for bars */
  readonly barColorTop?: string;
  /** Strobe frequency in Hz (1-20) - only for modern visualization */
  readonly strobeFrequency?: number;
}

/**
 * Map of visualization type to its local settings.
 */
export type PerVisualizationSettings = Partial<Record<string, VisualizationLocalSettings>>;

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
 * Subtitle font family options.
 */
export type SubtitleFontFamily = 'sans-serif' | 'serif' | 'monospace' | 'Arial';

/**
 * macOS visual effect state.
 * - followWindow: Effect follows window active state
 * - active: Always active (even when window is inactive)
 * - inactive: Always inactive
 */
export type MacOSVisualEffectState = 'followWindow' | 'active' | 'inactive';

/**
 * Color scheme preference.
 * - system: Follow system preference (default)
 * - dark: Force dark mode
 * - light: Force light mode
 */
export type ColorScheme = 'system' | 'dark' | 'light';

/**
 * Preferred audio language codes (ISO 639-2/B).
 * 'default' means use the file's default track.
 */
export type PreferredAudioLanguage =
  | 'default' | 'eng' | 'spa' | 'fre' | 'ger' | 'ita' | 'por' | 'rus'
  | 'jpn' | 'kor' | 'chi' | 'ara' | 'hin' | 'tha' | 'vie' | 'pol'
  | 'dut' | 'swe' | 'nor' | 'dan' | 'fin' | 'tur' | 'heb' | 'cze' | 'hun';

/**
 * Preferred subtitle language codes (ISO 639-2/B).
 * 'off' means disable subtitles by default.
 * 'default' means use the file's default track if one exists.
 */
export type PreferredSubtitleLanguage =
  | 'off' | 'default' | 'eng' | 'spa' | 'fre' | 'ger' | 'ita' | 'por' | 'rus'
  | 'jpn' | 'kor' | 'chi' | 'ara' | 'hin' | 'tha' | 'vie' | 'pol'
  | 'dut' | 'swe' | 'nor' | 'dan' | 'fin' | 'tur' | 'heb' | 'cze' | 'hun';

/**
 * Display names for preferred audio languages.
 */
export const AUDIO_LANGUAGE_OPTIONS: readonly { value: PreferredAudioLanguage; label: string }[] = [
  { value: 'default', label: 'File Default' },
  { value: 'eng', label: 'English' },
  { value: 'spa', label: 'Spanish' },
  { value: 'fre', label: 'French' },
  { value: 'ger', label: 'German' },
  { value: 'ita', label: 'Italian' },
  { value: 'por', label: 'Portuguese' },
  { value: 'rus', label: 'Russian' },
  { value: 'jpn', label: 'Japanese' },
  { value: 'kor', label: 'Korean' },
  { value: 'chi', label: 'Chinese' },
  { value: 'ara', label: 'Arabic' },
  { value: 'hin', label: 'Hindi' },
  { value: 'tha', label: 'Thai' },
  { value: 'vie', label: 'Vietnamese' },
  { value: 'pol', label: 'Polish' },
  { value: 'dut', label: 'Dutch' },
  { value: 'swe', label: 'Swedish' },
  { value: 'nor', label: 'Norwegian' },
  { value: 'dan', label: 'Danish' },
  { value: 'fin', label: 'Finnish' },
  { value: 'tur', label: 'Turkish' },
  { value: 'heb', label: 'Hebrew' },
  { value: 'cze', label: 'Czech' },
  { value: 'hun', label: 'Hungarian' },
];

/**
 * Display names for preferred subtitle languages.
 * Includes 'Subtitles Off' as a selectable preference.
 */
export const SUBTITLE_LANGUAGE_OPTIONS: readonly { value: PreferredSubtitleLanguage; label: string }[] = [
  { value: 'off', label: 'Subtitles Off' },
  { value: 'default', label: 'File Default' },
  { value: 'eng', label: 'English' },
  { value: 'spa', label: 'Spanish' },
  { value: 'fre', label: 'French' },
  { value: 'ger', label: 'German' },
  { value: 'ita', label: 'Italian' },
  { value: 'por', label: 'Portuguese' },
  { value: 'rus', label: 'Russian' },
  { value: 'jpn', label: 'Japanese' },
  { value: 'kor', label: 'Korean' },
  { value: 'chi', label: 'Chinese' },
  { value: 'ara', label: 'Arabic' },
  { value: 'hin', label: 'Hindi' },
  { value: 'tha', label: 'Thai' },
  { value: 'vie', label: 'Vietnamese' },
  { value: 'pol', label: 'Polish' },
  { value: 'dut', label: 'Dutch' },
  { value: 'swe', label: 'Swedish' },
  { value: 'nor', label: 'Norwegian' },
  { value: 'dan', label: 'Danish' },
  { value: 'fin', label: 'Finnish' },
  { value: 'tur', label: 'Turkish' },
  { value: 'heb', label: 'Hebrew' },
  { value: 'cze', label: 'Czech' },
  { value: 'hun', label: 'Hungarian' },
];

/**
 * Visualization settings.
 *
 * Global settings apply to all visualizations.
 * Per-visualization settings are stored in perVisualizationSettings.
 */
export interface VisualizationSettings {
  /** The default visualization to display on startup */
  readonly defaultType: string;
  /** Maximum frame rate for visualizations (0 = uncapped, or 15/30/60, default 0) */
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
  /** Whether the setup wizard has been completed (default false) */
  readonly setupCompleted: boolean;
  /** Active SoundFont file name (null = auto-select first available) */
  readonly activeSoundFontFileName: string | null;
}

/**
 * Playback settings.
 */
export interface PlaybackSettings {
  /** Default volume on startup (0.0 - 1.0, default 0.5) */
  readonly defaultVolume: number;
  /** Crossfade duration between tracks in milliseconds (0-500, default 100) */
  readonly crossfadeDuration: number;
  /** Previous track threshold in seconds (0-10, default 3) - if playback is past this, restart instead of previous */
  readonly previousTrackThreshold: number;
  /** Skip duration in seconds (1-60, default 10) - how many seconds to skip forward/backward */
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
 * Appearance settings (cross-platform).
 * Supports glass effects (vibrancy on macOS, acrylic on Windows), background color via HSL, and window tint via HSLA.
 */
export interface AppearanceSettings {
  /** Whether glass effect (transparency/blur) is enabled (default true on supported platforms) */
  readonly glassEnabled: boolean;
  /** macOS visual effect state (followWindow, active, inactive, default active) - only used on macOS when glassEnabled */
  readonly macOSVisualEffectState: MacOSVisualEffectState;
  /** Color scheme preference (system, dark, light) - default system */
  readonly colorScheme: ColorScheme;
  /** Background color when glass is disabled or unsupported (hex format, e.g., '#1e1e1e') — derived from HSL values */
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
  /** Window tint alpha (0-1) when glass is enabled — controls how much tint is applied */
  readonly windowTintAlpha: number;
}

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
 * A recently opened file or playlist.
 */
export interface RecentItem {
  /** Absolute file path */
  readonly path: string;
  /** Display name (filename without path, with extension) */
  readonly displayName: string;
  /** When this item was last opened (ISO timestamp) */
  readonly timestamp: string;
  /** Type: 'file' for media files, 'playlist' for .opp files */
  readonly type: 'file' | 'playlist';
}

/**
 * Recent items settings category.
 * Tracks recently opened files and playlists for the File menu.
 */
export interface RecentItemsSettings {
  /** Recently opened files (media) - most recent first */
  readonly recentFiles: readonly RecentItem[];
  /** Recently opened playlists (.opp) - most recent first */
  readonly recentPlaylists: readonly RecentItem[];
  /** Maximum number of files to track (default 10) */
  readonly maxFiles: number;
  /** Maximum number of playlists to track (default 5) */
  readonly maxPlaylists: number;
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
  /** Appearance settings (platform-specific) */
  readonly appearance: AppearanceSettings;
  /** Subtitle appearance settings */
  readonly subtitles: SubtitleSettings;
  /** Window state settings (not exposed in UI) */
  readonly windowState: WindowStateSettings;
  /** Recent items (files and playlists) */
  readonly recentItems: RecentItemsSettings;
}

/**
 * Partial visualization settings for updates.
 */
export interface VisualizationSettingsUpdate {
  readonly defaultType?: string;
  readonly maxFrameRate?: number;
  readonly fftSize?: FftSize;
  readonly perVisualizationSettings?: PerVisualizationSettings;
}

/**
 * Partial application settings for updates.
 */
export interface ApplicationSettingsUpdate {
  readonly serverPort?: number;
  readonly controlsAutoHideDelay?: number;
  readonly setupCompleted?: boolean;
  readonly activeSoundFontFileName?: string | null;
}

/**
 * Partial playback settings for updates.
 */
export interface PlaybackSettingsUpdate {
  readonly defaultVolume?: number;
  readonly crossfadeDuration?: number;
  readonly previousTrackThreshold?: number;
  readonly skipDuration?: number;
  readonly videoAspectMode?: VideoAspectMode;
  readonly preferredAudioLanguage?: PreferredAudioLanguage;
  readonly preferredSubtitleLanguage?: PreferredSubtitleLanguage;
}

/**
 * Partial transcoding settings for updates.
 */
export interface TranscodingSettingsUpdate {
  readonly videoQuality?: VideoQuality;
  readonly audioBitrate?: AudioBitrate;
  readonly hardwareAcceleration?: HardwareAcceleration;
}

/**
 * Partial appearance settings for updates.
 */
export interface AppearanceSettingsUpdate {
  readonly glassEnabled?: boolean;
  readonly macOSVisualEffectState?: MacOSVisualEffectState;
  readonly colorScheme?: ColorScheme;
  readonly backgroundColor?: string;
  readonly backgroundHue?: number;
  readonly backgroundSaturation?: number;
  readonly backgroundLightness?: number;
  readonly windowTintHue?: number;
  readonly windowTintSaturation?: number;
  readonly windowTintLightness?: number;
  readonly windowTintAlpha?: number;
}

/**
 * Partial subtitle settings for updates.
 */
export interface SubtitleSettingsUpdate {
  readonly fontSize?: number;
  readonly fontColor?: string;
  readonly backgroundColor?: string;
  readonly backgroundOpacity?: number;
  readonly fontFamily?: SubtitleFontFamily;
  readonly textShadow?: boolean;
  readonly shadowSpread?: number;
  readonly shadowBlur?: number;
  readonly shadowColor?: string;
}

/**
 * Partial recent items settings for updates.
 */
export interface RecentItemsSettingsUpdate {
  readonly recentFiles?: readonly RecentItem[];
  readonly recentPlaylists?: readonly RecentItem[];
  readonly maxFiles?: number;
  readonly maxPlaylists?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Current settings schema version */
const SETTINGS_VERSION: number = 2;

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
  strobeFrequency: 5,
};

/** Valid FFT size values */
const VALID_FFT_SIZES: readonly FftSize[] = [256, 512, 1024, 2048, 4096];

/** Valid bar density values */
const VALID_BAR_DENSITIES: readonly BarDensity[] = ['low', 'medium', 'high'];

/** Valid video quality values */
const VALID_VIDEO_QUALITIES: readonly VideoQuality[] = ['low', 'medium', 'high'];

/** Valid audio bitrate values */
const VALID_AUDIO_BITRATES: readonly AudioBitrate[] = [128, 192, 256, 320];

/** Valid hardware acceleration values */
const VALID_HARDWARE_ACCELERATION: readonly HardwareAcceleration[] = [
  'auto', 'disabled', 'h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi'
];

/** Valid video aspect mode values */
const VALID_VIDEO_ASPECT_MODES: readonly VideoAspectMode[] = ['default', '4:3', '16:9', 'fit'];

/** Valid macOS visual effect state values */
const VALID_MACOS_VISUAL_EFFECT_STATE: readonly MacOSVisualEffectState[] = ['followWindow', 'active', 'inactive'];

/** Valid color scheme values */
const VALID_COLOR_SCHEME: readonly ColorScheme[] = ['system', 'dark', 'light'];

/** Valid subtitle font family values */
const VALID_SUBTITLE_FONT_FAMILIES: readonly SubtitleFontFamily[] = ['sans-serif', 'serif', 'monospace', 'Arial'];

/** Valid preferred audio language values (derived from AUDIO_LANGUAGE_OPTIONS) */
const VALID_PREFERRED_AUDIO_LANGUAGES: readonly PreferredAudioLanguage[] = AUDIO_LANGUAGE_OPTIONS.map((opt: { value: PreferredAudioLanguage; label: string }): PreferredAudioLanguage => opt.value);

/** Valid preferred subtitle language values (derived from SUBTITLE_LANGUAGE_OPTIONS) */
const VALID_PREFERRED_SUBTITLE_LANGUAGES: readonly PreferredSubtitleLanguage[] = SUBTITLE_LANGUAGE_OPTIONS.map((opt: { value: PreferredSubtitleLanguage; label: string }): PreferredSubtitleLanguage => opt.value);

/** Default settings used when no file exists or on parse error */
const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  visualization: {
    defaultType: 'bars',
    maxFrameRate: 0,  // 0 = uncapped
    fftSize: 2048,  // 2048 = balanced resolution/performance
    perVisualizationSettings: {},  // Empty = use VISUALIZATION_LOCAL_DEFAULTS
  },
  application: {
    serverPort: 0,  // 0 = auto-assign
    controlsAutoHideDelay: 5,  // 5 seconds default
    setupCompleted: false,  // false = show setup wizard on first run
    activeSoundFontFileName: null,  // null = auto-select first available
  },
  playback: {
    defaultVolume: 0.5,  // 50% default volume
    crossfadeDuration: 100,  // 100ms crossfade
    previousTrackThreshold: 3,  // 3 seconds default
    skipDuration: 10,  // 10 seconds default skip
    videoAspectMode: 'default',  // use video's native aspect ratio
    preferredAudioLanguage: 'eng',  // prefer English audio if available
    preferredSubtitleLanguage: 'off',  // subtitles off by default
  },
  transcoding: {
    videoQuality: 'medium',  // medium = CRF 23
    audioBitrate: 192,  // 192 kbps
    hardwareAcceleration: 'auto',  // auto-detect best encoder
  },
  appearance: {
    glassEnabled: true,  // glass effect enabled by default (vibrancy on macOS, acrylic on Windows)
    macOSVisualEffectState: 'active',  // always active (even when window inactive)
    colorScheme: 'system',  // follow system preference by default
    backgroundColor: '#1e1e1e',  // derived from HSL values for BrowserWindow creation
    backgroundHue: 0,  // HSL hue (0-360) — #1e1e1e is achromatic
    backgroundSaturation: 0,  // HSL saturation (0-100) — #1e1e1e has no saturation
    backgroundLightness: 12,  // HSL lightness (0-100) — #1e1e1e ≈ 12% lightness
    windowTintHue: 0,  // HSLA hue (0-360) for glass tint
    windowTintSaturation: 0,  // HSLA saturation (0-100) for glass tint
    windowTintLightness: 0,  // HSLA lightness (0-100) for glass tint
    windowTintAlpha: 0,  // HSLA alpha (0-1) — 0 = no tint by default
  },
  subtitles: {
    fontSize: 100,  // 100% = default size
    fontColor: '#ffffff',  // white text
    backgroundColor: '#000000',  // black background
    backgroundOpacity: 0.75,  // 75% opacity
    fontFamily: 'sans-serif',  // clean sans-serif font
    textShadow: true,  // shadow for better visibility
    shadowSpread: 2,  // 2px offset for outline effect
    shadowBlur: 2,  // 2px blur for soft edges
    shadowColor: '#000000',  // black shadow/outline
  },
  windowState: {
    miniplayerBounds: null,  // no saved position initially
  },
  recentItems: {
    recentFiles: [],      // no recent files initially
    recentPlaylists: [],  // no recent playlists initially
    maxFiles: 10,         // max 10 recent files
    maxPlaylists: 5,      // max 5 recent playlists
  },
};

/** Valid visualization type values for validation */
const VALID_VISUALIZATION_TYPES: readonly string[] = [
  'bars',
  'waveform',
  'tether',
  'tunnel',
  'neon',
  'pulsar',
  'water',
  'infinity',
  'onix',
  'modern',
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

    // Validate maxFrameRate if provided
    if (update.maxFrameRate !== undefined) {
      if (!this.isValidMaxFrameRate(update.maxFrameRate)) {
        console.warn(`[SettingsManager] Invalid max frame rate: ${update.maxFrameRate}, ignoring`);
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

    // Validate and merge per-visualization settings if provided
    let mergedPerVizSettings: PerVisualizationSettings = this.settings.visualization.perVisualizationSettings;
    if (update.perVisualizationSettings !== undefined) {
      const validatedUpdate: PerVisualizationSettings = this.validatePerVisualizationSettings(update.perVisualizationSettings);
      // Deep merge: for each visualization, merge its settings
      mergedPerVizSettings = {...this.settings.visualization.perVisualizationSettings};
      for (const vizId of Object.keys(validatedUpdate)) {
        const existingVizSettings: VisualizationLocalSettings = mergedPerVizSettings[vizId] ?? {};
        const newVizSettings: VisualizationLocalSettings = validatedUpdate[vizId] ?? {};
        mergedPerVizSettings[vizId] = {...existingVizSettings, ...newVizSettings};
      }
    }

    // Merge the update
    this.settings = {
      ...this.settings,
      visualization: {
        defaultType: update.defaultType ?? this.settings.visualization.defaultType,
        maxFrameRate: update.maxFrameRate ?? this.settings.visualization.maxFrameRate,
        fftSize: update.fftSize ?? this.settings.visualization.fftSize,
        perVisualizationSettings: mergedPerVizSettings,
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

    // Validate setupCompleted if provided
    if (update.setupCompleted !== undefined) {
      if (typeof update.setupCompleted !== 'boolean') {
        console.warn(`[SettingsManager] Invalid setupCompleted: ${update.setupCompleted}, ignoring`);
        return this.settings;
      }
    }

    // Merge the update (use hasOwnProperty to distinguish undefined from explicit null)
    this.settings = {
      ...this.settings,
      application: {
        ...this.settings.application,
        serverPort: update.serverPort ?? this.settings.application.serverPort,
        controlsAutoHideDelay: update.controlsAutoHideDelay ?? this.settings.application.controlsAutoHideDelay,
        setupCompleted: update.setupCompleted ?? this.settings.application.setupCompleted,
        activeSoundFontFileName: Object.prototype.hasOwnProperty.call(update, 'activeSoundFontFileName')
          ? update.activeSoundFontFileName ?? null
          : this.settings.application.activeSoundFontFileName,
      },
    };

    this.save();
    return this.settings;
  }

  /**
   * Gets the active SoundFont file name.
   *
   * @returns The active SoundFont file name, or null if auto-selecting
   */
  public getActiveSoundFontFileName(): string | null {
    return this.settings.application.activeSoundFontFileName;
  }

  /**
   * Sets the active SoundFont file name.
   *
   * @param fileName - The file name to set as active, or null for auto-selection
   * @returns The updated complete settings object
   */
  public setActiveSoundFontFileName(fileName: string | null): AppSettings {
    return this.updateApplicationSettings({activeSoundFontFileName: fileName});
  }

  /**
   * Marks the setup wizard as completed.
   * Sets the setupCompleted flag to true and persists to disk.
   *
   * @returns The updated complete settings object
   */
  public markSetupComplete(): AppSettings {
    return this.updateApplicationSettings({setupCompleted: true});
  }

  /**
   * Checks if the setup wizard has been completed.
   *
   * @returns True if setup has been completed, false otherwise
   */
  public isSetupComplete(): boolean {
    return this.settings.application.setupCompleted;
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

    // Validate previousTrackThreshold if provided
    if (update.previousTrackThreshold !== undefined) {
      if (!this.isValidPreviousTrackThreshold(update.previousTrackThreshold)) {
        console.warn(`[SettingsManager] Invalid previous track threshold: ${update.previousTrackThreshold}, ignoring`);
        return this.settings;
      }
    }

    // Validate skipDuration if provided
    if (update.skipDuration !== undefined) {
      if (!this.isValidSkipDuration(update.skipDuration)) {
        console.warn(`[SettingsManager] Invalid skip duration: ${update.skipDuration}, ignoring`);
        return this.settings;
      }
    }

    // Validate videoAspectMode if provided
    if (update.videoAspectMode !== undefined) {
      if (!this.isValidVideoAspectMode(update.videoAspectMode)) {
        console.warn(`[SettingsManager] Invalid video aspect mode: ${update.videoAspectMode}, ignoring`);
        return this.settings;
      }
    }

    // Validate preferredAudioLanguage if provided
    if (update.preferredAudioLanguage !== undefined) {
      if (!this.isValidPreferredAudioLanguage(update.preferredAudioLanguage)) {
        console.warn(`[SettingsManager] Invalid preferred audio language: ${update.preferredAudioLanguage}, ignoring`);
        return this.settings;
      }
    }

    // Validate preferredSubtitleLanguage if provided
    if (update.preferredSubtitleLanguage !== undefined) {
      if (!this.isValidPreferredSubtitleLanguage(update.preferredSubtitleLanguage)) {
        console.warn(`[SettingsManager] Invalid preferred subtitle language: ${update.preferredSubtitleLanguage}, ignoring`);
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
        previousTrackThreshold: update.previousTrackThreshold ?? this.settings.playback.previousTrackThreshold,
        skipDuration: update.skipDuration ?? this.settings.playback.skipDuration,
        videoAspectMode: update.videoAspectMode ?? this.settings.playback.videoAspectMode,
        preferredAudioLanguage: update.preferredAudioLanguage ?? this.settings.playback.preferredAudioLanguage,
        preferredSubtitleLanguage: update.preferredSubtitleLanguage ?? this.settings.playback.preferredSubtitleLanguage,
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

    // Validate hardwareAcceleration if provided
    if (update.hardwareAcceleration !== undefined) {
      if (!this.isValidHardwareAcceleration(update.hardwareAcceleration)) {
        console.warn(`[SettingsManager] Invalid hardware acceleration: ${update.hardwareAcceleration}, ignoring`);
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
        hardwareAcceleration: update.hardwareAcceleration ?? this.settings.transcoding.hardwareAcceleration,
      },
    };

    this.save();
    return this.settings;
  }

  /**
   * Updates appearance settings with partial values.
   *
   * Only provided fields are updated; others retain their current values.
   * Changes are immediately persisted to disk.
   *
   * Note: These settings require an application restart to take effect
   * as they are applied during window creation.
   *
   * @param update - Partial appearance settings to apply
   * @returns The updated complete settings object
   */
  public updateAppearanceSettings(update: AppearanceSettingsUpdate): AppSettings {
    // Validate glassEnabled if provided
    if (update.glassEnabled !== undefined) {
      if (typeof update.glassEnabled !== 'boolean') {
        console.warn(`[SettingsManager] Invalid glassEnabled: ${update.glassEnabled}, ignoring`);
        return this.settings;
      }
    }

    // Validate macOSVisualEffectState if provided
    if (update.macOSVisualEffectState !== undefined) {
      if (!this.isValidMacOSVisualEffectState(update.macOSVisualEffectState)) {
        console.warn(`[SettingsManager] Invalid macOS visual effect state: ${update.macOSVisualEffectState}, ignoring`);
        return this.settings;
      }
    }

    // Validate colorScheme if provided
    if (update.colorScheme !== undefined) {
      if (!this.isValidColorScheme(update.colorScheme)) {
        console.warn(`[SettingsManager] Invalid color scheme: ${update.colorScheme}, ignoring`);
        return this.settings;
      }
    }

    // Validate backgroundColor if provided
    if (update.backgroundColor !== undefined) {
      if (!this.isValidHexColor(update.backgroundColor)) {
        console.warn(`[SettingsManager] Invalid background color: ${update.backgroundColor}, ignoring`);
        return this.settings;
      }
    }

    // Validate background HSL fields if provided
    if (update.backgroundHue !== undefined && !this.isValidHue(update.backgroundHue)) {
      console.warn(`[SettingsManager] Invalid backgroundHue: ${update.backgroundHue}, ignoring`);
      return this.settings;
    }
    if (update.backgroundSaturation !== undefined && !this.isValidPercentage(update.backgroundSaturation)) {
      console.warn(`[SettingsManager] Invalid backgroundSaturation: ${update.backgroundSaturation}, ignoring`);
      return this.settings;
    }
    if (update.backgroundLightness !== undefined && !this.isValidPercentage(update.backgroundLightness)) {
      console.warn(`[SettingsManager] Invalid backgroundLightness: ${update.backgroundLightness}, ignoring`);
      return this.settings;
    }

    // Validate window tint HSLA fields if provided
    if (update.windowTintHue !== undefined && !this.isValidHue(update.windowTintHue)) {
      console.warn(`[SettingsManager] Invalid windowTintHue: ${update.windowTintHue}, ignoring`);
      return this.settings;
    }
    if (update.windowTintSaturation !== undefined && !this.isValidPercentage(update.windowTintSaturation)) {
      console.warn(`[SettingsManager] Invalid windowTintSaturation: ${update.windowTintSaturation}, ignoring`);
      return this.settings;
    }
    if (update.windowTintLightness !== undefined && !this.isValidPercentage(update.windowTintLightness)) {
      console.warn(`[SettingsManager] Invalid windowTintLightness: ${update.windowTintLightness}, ignoring`);
      return this.settings;
    }
    if (update.windowTintAlpha !== undefined && !this.isValidAlpha(update.windowTintAlpha)) {
      console.warn(`[SettingsManager] Invalid windowTintAlpha: ${update.windowTintAlpha}, ignoring`);
      return this.settings;
    }

    // Resolve HSL values (use updated or current)
    const bgHue: number = update.backgroundHue ?? this.settings.appearance.backgroundHue;
    const bgSat: number = update.backgroundSaturation ?? this.settings.appearance.backgroundSaturation;
    const bgLit: number = update.backgroundLightness ?? this.settings.appearance.backgroundLightness;

    // Derive hex backgroundColor from HSL values when any HSL field changes
    const derivedBgColor: string = (update.backgroundHue !== undefined || update.backgroundSaturation !== undefined || update.backgroundLightness !== undefined)
      ? this.hslToHex(bgHue, bgSat, bgLit)
      : (update.backgroundColor ?? this.settings.appearance.backgroundColor);

    // Merge the update
    this.settings = {
      ...this.settings,
      appearance: {
        ...this.settings.appearance,
        glassEnabled: update.glassEnabled ?? this.settings.appearance.glassEnabled,
        macOSVisualEffectState: update.macOSVisualEffectState ?? this.settings.appearance.macOSVisualEffectState,
        colorScheme: update.colorScheme ?? this.settings.appearance.colorScheme,
        backgroundColor: derivedBgColor,
        backgroundHue: bgHue,
        backgroundSaturation: bgSat,
        backgroundLightness: bgLit,
        windowTintHue: update.windowTintHue ?? this.settings.appearance.windowTintHue,
        windowTintSaturation: update.windowTintSaturation ?? this.settings.appearance.windowTintSaturation,
        windowTintLightness: update.windowTintLightness ?? this.settings.appearance.windowTintLightness,
        windowTintAlpha: update.windowTintAlpha ?? this.settings.appearance.windowTintAlpha,
      },
    };

    this.save();
    return this.settings;
  }

  /**
   * Updates subtitle settings with partial values.
   *
   * Only provided fields are updated; others retain their current values.
   * Changes are immediately persisted to disk.
   *
   * @param update - Partial subtitle settings to apply
   * @returns The updated complete settings object
   */
  public updateSubtitleSettings(update: SubtitleSettingsUpdate): AppSettings {
    // Validate fontSize if provided
    if (update.fontSize !== undefined) {
      if (!this.isValidSubtitleFontSize(update.fontSize)) {
        console.warn(`[SettingsManager] Invalid subtitle font size: ${update.fontSize}, ignoring`);
        return this.settings;
      }
    }

    // Validate fontColor if provided
    if (update.fontColor !== undefined) {
      if (!this.isValidHexColor(update.fontColor)) {
        console.warn(`[SettingsManager] Invalid subtitle font color: ${update.fontColor}, ignoring`);
        return this.settings;
      }
    }

    // Validate backgroundColor if provided
    if (update.backgroundColor !== undefined) {
      if (!this.isValidHexColor(update.backgroundColor)) {
        console.warn(`[SettingsManager] Invalid subtitle background color: ${update.backgroundColor}, ignoring`);
        return this.settings;
      }
    }

    // Validate backgroundOpacity if provided
    if (update.backgroundOpacity !== undefined) {
      if (!this.isValidAlpha(update.backgroundOpacity)) {
        console.warn(`[SettingsManager] Invalid subtitle background opacity: ${update.backgroundOpacity}, ignoring`);
        return this.settings;
      }
    }

    // Validate fontFamily if provided
    if (update.fontFamily !== undefined) {
      if (!this.isValidSubtitleFontFamily(update.fontFamily)) {
        console.warn(`[SettingsManager] Invalid subtitle font family: ${update.fontFamily}, ignoring`);
        return this.settings;
      }
    }

    // Validate textShadow if provided
    if (update.textShadow !== undefined) {
      if (typeof update.textShadow !== 'boolean') {
        console.warn(`[SettingsManager] Invalid subtitle text shadow: ${update.textShadow}, ignoring`);
        return this.settings;
      }
    }

    // Validate shadowSpread if provided
    if (update.shadowSpread !== undefined) {
      if (!this.isValidSubtitleShadowSpread(update.shadowSpread)) {
        console.warn(`[SettingsManager] Invalid subtitle shadow spread: ${update.shadowSpread}, ignoring`);
        return this.settings;
      }
    }

    // Validate shadowBlur if provided
    if (update.shadowBlur !== undefined) {
      if (!this.isValidSubtitleShadowBlur(update.shadowBlur)) {
        console.warn(`[SettingsManager] Invalid subtitle shadow blur: ${update.shadowBlur}, ignoring`);
        return this.settings;
      }
    }

    // Validate shadowColor if provided
    if (update.shadowColor !== undefined) {
      if (!this.isValidHexColor(update.shadowColor)) {
        console.warn(`[SettingsManager] Invalid subtitle shadow color: ${update.shadowColor}, ignoring`);
        return this.settings;
      }
    }

    // Merge the update
    this.settings = {
      ...this.settings,
      subtitles: {
        ...this.settings.subtitles,
        fontSize: update.fontSize ?? this.settings.subtitles.fontSize,
        fontColor: update.fontColor ?? this.settings.subtitles.fontColor,
        backgroundColor: update.backgroundColor ?? this.settings.subtitles.backgroundColor,
        backgroundOpacity: update.backgroundOpacity ?? this.settings.subtitles.backgroundOpacity,
        fontFamily: update.fontFamily ?? this.settings.subtitles.fontFamily,
        textShadow: update.textShadow ?? this.settings.subtitles.textShadow,
        shadowSpread: update.shadowSpread ?? this.settings.subtitles.shadowSpread,
        shadowBlur: update.shadowBlur ?? this.settings.subtitles.shadowBlur,
        shadowColor: update.shadowColor ?? this.settings.subtitles.shadowColor,
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
  // Recent Items Methods
  // ==========================================================================

  /**
   * Adds a file to the recent files list.
   * If the file already exists in the list, it is moved to the front.
   * The list is trimmed to maxFiles items (FIFO eviction).
   *
   * @param filePath - Absolute path to the file
   * @returns The updated complete settings object
   */
  public addRecentFile(filePath: string): AppSettings {
    const displayName: string = path.basename(filePath);
    const item: RecentItem = {
      path: filePath,
      displayName,
      timestamp: new Date().toISOString(),
      type: 'file',
    };

    // Remove existing entry with same path (case-insensitive on Windows)
    const filtered: RecentItem[] = this.settings.recentItems.recentFiles.filter(
      (f: RecentItem): boolean =>
        process.platform === 'win32'
          ? f.path.toLowerCase() !== filePath.toLowerCase()
          : f.path !== filePath
    );

    // Add to front, trim to max
    const updated: readonly RecentItem[] = [item, ...filtered].slice(
      0,
      this.settings.recentItems.maxFiles
    );

    this.settings = {
      ...this.settings,
      recentItems: {
        ...this.settings.recentItems,
        recentFiles: updated,
      },
    };

    this.save();
    return this.settings;
  }

  /**
   * Adds a playlist to the recent playlists list.
   * If the playlist already exists in the list, it is moved to the front.
   * The list is trimmed to maxPlaylists items (FIFO eviction).
   *
   * @param playlistPath - Absolute path to the playlist file
   * @returns The updated complete settings object
   */
  public addRecentPlaylist(playlistPath: string): AppSettings {
    const displayName: string = path.basename(playlistPath);
    const item: RecentItem = {
      path: playlistPath,
      displayName,
      timestamp: new Date().toISOString(),
      type: 'playlist',
    };

    // Remove existing entry with same path (case-insensitive on Windows)
    const filtered: RecentItem[] = this.settings.recentItems.recentPlaylists.filter(
      (f: RecentItem): boolean =>
        process.platform === 'win32'
          ? f.path.toLowerCase() !== playlistPath.toLowerCase()
          : f.path !== playlistPath
    );

    // Add to front, trim to max
    const updated: readonly RecentItem[] = [item, ...filtered].slice(
      0,
      this.settings.recentItems.maxPlaylists
    );

    this.settings = {
      ...this.settings,
      recentItems: {
        ...this.settings.recentItems,
        recentPlaylists: updated,
      },
    };

    this.save();
    return this.settings;
  }

  /**
   * Removes a file from the recent files list.
   *
   * @param filePath - Absolute path to the file to remove
   * @returns The updated complete settings object
   */
  public removeRecentFile(filePath: string): AppSettings {
    const filtered: RecentItem[] = this.settings.recentItems.recentFiles.filter(
      (f: RecentItem): boolean =>
        process.platform === 'win32'
          ? f.path.toLowerCase() !== filePath.toLowerCase()
          : f.path !== filePath
    );

    this.settings = {
      ...this.settings,
      recentItems: {
        ...this.settings.recentItems,
        recentFiles: filtered,
      },
    };

    this.save();
    return this.settings;
  }

  /**
   * Removes a playlist from the recent playlists list.
   *
   * @param playlistPath - Absolute path to the playlist to remove
   * @returns The updated complete settings object
   */
  public removeRecentPlaylist(playlistPath: string): AppSettings {
    const filtered: RecentItem[] = this.settings.recentItems.recentPlaylists.filter(
      (f: RecentItem): boolean =>
        process.platform === 'win32'
          ? f.path.toLowerCase() !== playlistPath.toLowerCase()
          : f.path !== playlistPath
    );

    this.settings = {
      ...this.settings,
      recentItems: {
        ...this.settings.recentItems,
        recentPlaylists: filtered,
      },
    };

    this.save();
    return this.settings;
  }

  /**
   * Clears all recent items (both files and playlists).
   *
   * @returns The updated complete settings object
   */
  public clearRecentItems(): AppSettings {
    this.settings = {
      ...this.settings,
      recentItems: {
        ...this.settings.recentItems,
        recentFiles: [],
        recentPlaylists: [],
      },
    };

    this.save();
    return this.settings;
  }

  /**
   * Gets the current recent items settings.
   *
   * @returns The recent items settings
   */
  public getRecentItems(): RecentItemsSettings {
    return this.settings.recentItems;
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
      settingsLogger.info('No settings file found, using defaults');
      return DEFAULT_SETTINGS;
    }

    try {
      settingsLogger.debug(`Loading settings from ${this.settingsPath}`);
      const raw: string = readFileSync(this.settingsPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      settingsLogger.info('Settings loaded successfully');
      return this.validateAndMerge(parsed);
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      settingsLogger.error(`Failed to load settings: ${message}`);
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

      settingsLogger.debug('Settings saved successfully');
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      settingsLogger.error(`Failed to save settings: ${message}`);

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

    // Extract and validate appearance settings
    const appearanceSettings: AppearanceSettings = this.validateAppearanceSettings(
      obj['appearance']
    );

    // Extract and validate subtitle settings
    const subtitleSettings: SubtitleSettings = this.validateSubtitleSettings(
      obj['subtitles']
    );

    // Extract and validate window state settings
    const windowStateSettings: WindowStateSettings = this.validateWindowStateSettings(
      obj['windowState']
    );

    // Extract and validate recent items settings
    const recentItemsSettings: RecentItemsSettings = this.validateRecentItemsSettings(
      obj['recentItems']
    );

    return {
      version: typeof obj['version'] === 'number' ? obj['version'] : SETTINGS_VERSION,
      visualization: vizSettings,
      application: appSettings,
      playback: playbackSettings,
      transcoding: transcodingSettings,
      appearance: appearanceSettings,
      subtitles: subtitleSettings,
      windowState: windowStateSettings,
      recentItems: recentItemsSettings,
    };
  }

  /**
   * Validates visualization settings object.
   * Handles migration from v1 (global settings) to v2 (per-visualization settings).
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
    const maxFrameRate: unknown = vizObj['maxFrameRate'];
    const fftSize: unknown = vizObj['fftSize'];

    // Handle migration from v1 to v2
    let perVisualizationSettings: PerVisualizationSettings = {};

    // Check if we have v2 format (perVisualizationSettings)
    if (vizObj['perVisualizationSettings'] && typeof vizObj['perVisualizationSettings'] === 'object') {
      perVisualizationSettings = this.validatePerVisualizationSettings(vizObj['perVisualizationSettings']);
    }

    // Migrate v1 settings if present (perVisualizationSensitivity and global values)
    const oldPerVizSensitivity: unknown = vizObj['perVisualizationSensitivity'];
    if (oldPerVizSensitivity && typeof oldPerVizSensitivity === 'object') {
      // Migrate old per-visualization sensitivity to new format
      const oldPerVizObj: Record<string, unknown> = oldPerVizSensitivity as Record<string, unknown>;
      for (const vizId of Object.keys(oldPerVizObj)) {
        if (this.isValidVisualizationType(vizId) && this.isValidSensitivity(oldPerVizObj[vizId])) {
          if (!perVisualizationSettings[vizId]) {
            perVisualizationSettings[vizId] = {};
          }
          perVisualizationSettings[vizId] = {
            ...perVisualizationSettings[vizId],
            sensitivity: oldPerVizObj[vizId] as number,
          };
        }
      }
    }

    return {
      defaultType: this.isValidVisualizationType(defaultType)
        ? defaultType
        : DEFAULT_SETTINGS.visualization.defaultType,
      maxFrameRate: this.isValidMaxFrameRate(maxFrameRate)
        ? maxFrameRate
        : DEFAULT_SETTINGS.visualization.maxFrameRate,
      fftSize: this.isValidFftSize(fftSize)
        ? fftSize
        : DEFAULT_SETTINGS.visualization.fftSize,
      perVisualizationSettings,
    };
  }

  /**
   * Validates per-visualization settings object.
   *
   * @param perViz - The per-visualization settings to validate
   * @returns Valid per-visualization settings with invalid entries removed
   */
  private validatePerVisualizationSettings(perViz: unknown): PerVisualizationSettings {
    if (!perViz || typeof perViz !== 'object') {
      return {};
    }

    const result: PerVisualizationSettings = {};
    const perVizObj: Record<string, unknown> = perViz as Record<string, unknown>;

    for (const vizId of Object.keys(perVizObj)) {
      if (!this.isValidVisualizationType(vizId)) {
        continue;
      }

      const vizSettings: unknown = perVizObj[vizId];
      if (!vizSettings || typeof vizSettings !== 'object') {
        continue;
      }

      const vizSettingsObj: Record<string, unknown> = vizSettings as Record<string, unknown>;

      // Build validated object with only valid settings
      const validated: VisualizationLocalSettings = {
        ...(this.isValidSensitivity(vizSettingsObj['sensitivity'])
          ? {sensitivity: vizSettingsObj['sensitivity'] as number}
          : {}),
        ...(this.isValidBarDensity(vizSettingsObj['barDensity'])
          ? {barDensity: vizSettingsObj['barDensity'] as BarDensity}
          : {}),
        ...(this.isValidTrailIntensity(vizSettingsObj['trailIntensity'])
          ? {trailIntensity: vizSettingsObj['trailIntensity'] as number}
          : {}),
        ...(this.isValidLineWidth(vizSettingsObj['lineWidth'])
          ? {lineWidth: vizSettingsObj['lineWidth'] as number}
          : {}),
        ...(this.isValidGlowIntensity(vizSettingsObj['glowIntensity'])
          ? {glowIntensity: vizSettingsObj['glowIntensity'] as number}
          : {}),
        ...(this.isValidWaveformSmoothing(vizSettingsObj['waveformSmoothing'])
          ? {waveformSmoothing: vizSettingsObj['waveformSmoothing'] as number}
          : {}),
        ...(this.isValidHexColor(vizSettingsObj['barColorBottom'])
          ? {barColorBottom: vizSettingsObj['barColorBottom'] as string}
          : {}),
        ...(this.isValidHexColor(vizSettingsObj['barColorMiddle'])
          ? {barColorMiddle: vizSettingsObj['barColorMiddle'] as string}
          : {}),
        ...(this.isValidHexColor(vizSettingsObj['barColorTop'])
          ? {barColorTop: vizSettingsObj['barColorTop'] as string}
          : {}),
        ...(this.isValidStrobeFrequency(vizSettingsObj['strobeFrequency'])
          ? {strobeFrequency: vizSettingsObj['strobeFrequency'] as number}
          : {}),
      };

      // Only add if there are any valid settings
      if (Object.keys(validated).length > 0) {
        result[vizId] = validated;
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
   * Type guard to check if a value is a valid visualization type.
   *
   * @param value - The value to check
   * @returns True if the value is a valid visualization type
   */
  private isValidVisualizationType(value: unknown): value is string {
    return typeof value === 'string' && VALID_VISUALIZATION_TYPES.includes(value);
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
    const setupCompleted: unknown = appObj['setupCompleted'];
    const activeSoundFontFileName: unknown = appObj['activeSoundFontFileName'];

    return {
      serverPort: this.isValidPort(serverPort)
        ? serverPort
        : DEFAULT_SETTINGS.application.serverPort,
      controlsAutoHideDelay: this.isValidAutoHideDelay(controlsAutoHideDelay)
        ? controlsAutoHideDelay
        : DEFAULT_SETTINGS.application.controlsAutoHideDelay,
      setupCompleted: typeof setupCompleted === 'boolean'
        ? setupCompleted
        : DEFAULT_SETTINGS.application.setupCompleted,
      activeSoundFontFileName: activeSoundFontFileName === null || typeof activeSoundFontFileName === 'string'
        ? activeSoundFontFileName
        : DEFAULT_SETTINGS.application.activeSoundFontFileName,
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
    const previousTrackThreshold: unknown = playbackObj['previousTrackThreshold'];
    const skipDuration: unknown = playbackObj['skipDuration'];
    const videoAspectMode: unknown = playbackObj['videoAspectMode'];
    const preferredAudioLanguage: unknown = playbackObj['preferredAudioLanguage'];
    const preferredSubtitleLanguage: unknown = playbackObj['preferredSubtitleLanguage'];

    return {
      defaultVolume: this.isValidVolume(defaultVolume)
        ? defaultVolume
        : DEFAULT_SETTINGS.playback.defaultVolume,
      crossfadeDuration: this.isValidCrossfadeDuration(crossfadeDuration)
        ? crossfadeDuration
        : DEFAULT_SETTINGS.playback.crossfadeDuration,
      previousTrackThreshold: this.isValidPreviousTrackThreshold(previousTrackThreshold)
        ? previousTrackThreshold
        : DEFAULT_SETTINGS.playback.previousTrackThreshold,
      skipDuration: this.isValidSkipDuration(skipDuration)
        ? skipDuration
        : DEFAULT_SETTINGS.playback.skipDuration,
      videoAspectMode: this.isValidVideoAspectMode(videoAspectMode)
        ? videoAspectMode
        : DEFAULT_SETTINGS.playback.videoAspectMode,
      preferredAudioLanguage: this.isValidPreferredAudioLanguage(preferredAudioLanguage)
        ? preferredAudioLanguage
        : DEFAULT_SETTINGS.playback.preferredAudioLanguage,
      preferredSubtitleLanguage: this.isValidPreferredSubtitleLanguage(preferredSubtitleLanguage)
        ? preferredSubtitleLanguage
        : DEFAULT_SETTINGS.playback.preferredSubtitleLanguage,
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
    const hardwareAcceleration: unknown = transcodingObj['hardwareAcceleration'];

    return {
      videoQuality: this.isValidVideoQuality(videoQuality)
        ? videoQuality
        : DEFAULT_SETTINGS.transcoding.videoQuality,
      audioBitrate: this.isValidAudioBitrate(audioBitrate)
        ? audioBitrate
        : DEFAULT_SETTINGS.transcoding.audioBitrate,
      hardwareAcceleration: this.isValidHardwareAcceleration(hardwareAcceleration)
        ? hardwareAcceleration
        : DEFAULT_SETTINGS.transcoding.hardwareAcceleration,
    };
  }

  /**
   * Validates appearance settings object.
   * Includes migration from old macOSVibrancy format to new glassEnabled format.
   *
   * @param appearance - The appearance settings to validate (unknown type)
   * @returns Valid appearance settings with defaults for invalid values
   */
  private validateAppearanceSettings(appearance: unknown): AppearanceSettings {
    if (!appearance || typeof appearance !== 'object') {
      return DEFAULT_SETTINGS.appearance;
    }

    const appearanceObj: Record<string, unknown> = appearance as Record<string, unknown>;

    // Migration: Convert old macOSVibrancy to new glassEnabled format
    let glassEnabled: boolean = DEFAULT_SETTINGS.appearance.glassEnabled;
    if (typeof appearanceObj['glassEnabled'] === 'boolean') {
      // New format - use directly
      glassEnabled = appearanceObj['glassEnabled'];
    } else if (typeof appearanceObj['macOSVibrancy'] === 'string') {
      // Old format - migrate: 'none' means glass disabled, anything else means enabled
      glassEnabled = appearanceObj['macOSVibrancy'] !== 'none';
    }

    const macOSVisualEffectState: unknown = appearanceObj['macOSVisualEffectState'];
    const colorScheme: unknown = appearanceObj['colorScheme'];
    const backgroundColor: unknown = appearanceObj['backgroundColor'];

    // Validate HSL fields (use defaults if missing — backward compat with old settings)
    const backgroundHue: number = this.isValidHue(appearanceObj['backgroundHue'])
      ? appearanceObj['backgroundHue'] : DEFAULT_SETTINGS.appearance.backgroundHue;
    const backgroundSaturation: number = this.isValidPercentage(appearanceObj['backgroundSaturation'])
      ? appearanceObj['backgroundSaturation'] : DEFAULT_SETTINGS.appearance.backgroundSaturation;
    const backgroundLightness: number = this.isValidPercentage(appearanceObj['backgroundLightness'])
      ? appearanceObj['backgroundLightness'] : DEFAULT_SETTINGS.appearance.backgroundLightness;

    // Validate window tint HSLA fields
    const windowTintHue: number = this.isValidHue(appearanceObj['windowTintHue'])
      ? appearanceObj['windowTintHue'] : DEFAULT_SETTINGS.appearance.windowTintHue;
    const windowTintSaturation: number = this.isValidPercentage(appearanceObj['windowTintSaturation'])
      ? appearanceObj['windowTintSaturation'] : DEFAULT_SETTINGS.appearance.windowTintSaturation;
    const windowTintLightness: number = this.isValidPercentage(appearanceObj['windowTintLightness'])
      ? appearanceObj['windowTintLightness'] : DEFAULT_SETTINGS.appearance.windowTintLightness;
    const windowTintAlpha: number = this.isValidAlpha(appearanceObj['windowTintAlpha'])
      ? appearanceObj['windowTintAlpha'] : DEFAULT_SETTINGS.appearance.windowTintAlpha;

    return {
      glassEnabled,
      macOSVisualEffectState: this.isValidMacOSVisualEffectState(macOSVisualEffectState)
        ? macOSVisualEffectState
        : DEFAULT_SETTINGS.appearance.macOSVisualEffectState,
      colorScheme: this.isValidColorScheme(colorScheme)
        ? colorScheme
        : DEFAULT_SETTINGS.appearance.colorScheme,
      backgroundColor: this.isValidHexColor(backgroundColor)
        ? backgroundColor
        : DEFAULT_SETTINGS.appearance.backgroundColor,
      backgroundHue,
      backgroundSaturation,
      backgroundLightness,
      windowTintHue,
      windowTintSaturation,
      windowTintLightness,
      windowTintAlpha,
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
   * Validates recent items settings object.
   *
   * @param recentItems - The recent items settings to validate (unknown type)
   * @returns Valid recent items settings with defaults for invalid values
   */
  private validateRecentItemsSettings(recentItems: unknown): RecentItemsSettings {
    if (!recentItems || typeof recentItems !== 'object') {
      return DEFAULT_SETTINGS.recentItems;
    }

    const obj: Record<string, unknown> = recentItems as Record<string, unknown>;
    const recentFiles: unknown = obj['recentFiles'];
    const recentPlaylists: unknown = obj['recentPlaylists'];
    const maxFiles: unknown = obj['maxFiles'];
    const maxPlaylists: unknown = obj['maxPlaylists'];

    return {
      recentFiles: this.isValidRecentItemArray(recentFiles)
        ? recentFiles
        : DEFAULT_SETTINGS.recentItems.recentFiles,
      recentPlaylists: this.isValidRecentItemArray(recentPlaylists)
        ? recentPlaylists
        : DEFAULT_SETTINGS.recentItems.recentPlaylists,
      maxFiles: this.isValidMaxRecentItems(maxFiles)
        ? maxFiles
        : DEFAULT_SETTINGS.recentItems.maxFiles,
      maxPlaylists: this.isValidMaxRecentItems(maxPlaylists)
        ? maxPlaylists
        : DEFAULT_SETTINGS.recentItems.maxPlaylists,
    };
  }

  /**
   * Validates an array of recent items.
   *
   * @param arr - The array to validate
   * @returns True if valid array of recent items
   */
  private isValidRecentItemArray(arr: unknown): arr is readonly RecentItem[] {
    if (!Array.isArray(arr)) return false;
    return arr.every(
      (item: unknown): boolean =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>)['path'] === 'string' &&
        typeof (item as Record<string, unknown>)['displayName'] === 'string' &&
        typeof (item as Record<string, unknown>)['timestamp'] === 'string' &&
        ((item as Record<string, unknown>)['type'] === 'file' ||
          (item as Record<string, unknown>)['type'] === 'playlist')
    );
  }

  /**
   * Validates max recent items count.
   *
   * @param value - The value to validate
   * @returns True if valid positive integer
   */
  private isValidMaxRecentItems(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 50;
  }

  /**
   * Validates subtitle settings object.
   *
   * @param subtitles - The subtitle settings to validate (unknown type)
   * @returns Valid subtitle settings with defaults for invalid values
   */
  private validateSubtitleSettings(subtitles: unknown): SubtitleSettings {
    if (!subtitles || typeof subtitles !== 'object') {
      return DEFAULT_SETTINGS.subtitles;
    }

    const subtitlesObj: Record<string, unknown> = subtitles as Record<string, unknown>;
    const fontSize: unknown = subtitlesObj['fontSize'];
    const fontColor: unknown = subtitlesObj['fontColor'];
    const backgroundColor: unknown = subtitlesObj['backgroundColor'];
    const backgroundOpacity: unknown = subtitlesObj['backgroundOpacity'];
    const fontFamily: unknown = subtitlesObj['fontFamily'];
    const textShadow: unknown = subtitlesObj['textShadow'];
    const shadowSpread: unknown = subtitlesObj['shadowSpread'];
    const shadowBlur: unknown = subtitlesObj['shadowBlur'];
    const shadowColor: unknown = subtitlesObj['shadowColor'];

    return {
      fontSize: this.isValidSubtitleFontSize(fontSize)
        ? fontSize
        : DEFAULT_SETTINGS.subtitles.fontSize,
      fontColor: this.isValidHexColor(fontColor)
        ? fontColor
        : DEFAULT_SETTINGS.subtitles.fontColor,
      backgroundColor: this.isValidHexColor(backgroundColor)
        ? backgroundColor
        : DEFAULT_SETTINGS.subtitles.backgroundColor,
      backgroundOpacity: this.isValidAlpha(backgroundOpacity)
        ? backgroundOpacity
        : DEFAULT_SETTINGS.subtitles.backgroundOpacity,
      fontFamily: this.isValidSubtitleFontFamily(fontFamily)
        ? fontFamily
        : DEFAULT_SETTINGS.subtitles.fontFamily,
      textShadow: typeof textShadow === 'boolean'
        ? textShadow
        : DEFAULT_SETTINGS.subtitles.textShadow,
      shadowSpread: this.isValidSubtitleShadowSpread(shadowSpread)
        ? shadowSpread
        : DEFAULT_SETTINGS.subtitles.shadowSpread,
      shadowBlur: this.isValidSubtitleShadowBlur(shadowBlur)
        ? shadowBlur
        : DEFAULT_SETTINGS.subtitles.shadowBlur,
      shadowColor: this.isValidHexColor(shadowColor)
        ? shadowColor
        : DEFAULT_SETTINGS.subtitles.shadowColor,
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
   * Type guard to check if a value is a valid skip duration.
   *
   * Valid values are 1-60 seconds.
   *
   * @param value - The value to check
   * @returns True if the value is a valid skip duration
   */
  private isValidSkipDuration(value: unknown): value is number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return false;
    }
    return value >= 1 && value <= 60;
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
   * Type guard to check if a value is a valid waveform smoothing.
   *
   * Valid values are between 0.0 and 1.0.
   *
   * @param value - The value to check
   * @returns True if the value is a valid waveform smoothing
   */
  private isValidWaveformSmoothing(value: unknown): value is number {
    return typeof value === 'number' && value >= 0 && value <= 1;
  }

  /**
   * Type guard to check if a value is a valid hex color.
   *
   * Valid values are strings matching #RRGGBB format.
   *
   * @param value - The value to check
   * @returns True if the value is a valid hex color
   */
  private isValidHexColor(value: unknown): value is string {
    return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
  }

  /**
   * Type guard to check if a value is a valid strobe frequency.
   *
   * Valid values are integers between 1 and 20 Hz.
   *
   * @param value - The value to check
   * @returns True if the value is a valid strobe frequency
   */
  private isValidStrobeFrequency(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 20;
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

  /**
   * Type guard to check if a value is a valid hardware acceleration setting.
   *
   * Valid values are 'auto', 'disabled', or specific encoder names.
   *
   * @param value - The value to check
   * @returns True if the value is a valid hardware acceleration setting
   */
  private isValidHardwareAcceleration(value: unknown): value is HardwareAcceleration {
    return typeof value === 'string' && VALID_HARDWARE_ACCELERATION.includes(value as HardwareAcceleration);
  }

  /**
   * Type guard to check if a value is a valid video aspect mode.
   *
   * Valid values are 'default', '4:3', '16:9', or 'fit'.
   *
   * @param value - The value to check
   * @returns True if the value is a valid video aspect mode
   */
  private isValidVideoAspectMode(value: unknown): value is VideoAspectMode {
    return typeof value === 'string' && VALID_VIDEO_ASPECT_MODES.includes(value as VideoAspectMode);
  }

  /**
   * Type guard to check if a value is a valid preferred audio language.
   *
   * Valid values include 'default' and ISO 639-2/B language codes.
   *
   * @param value - The value to check
   * @returns True if the value is a valid preferred audio language
   */
  private isValidPreferredAudioLanguage(value: unknown): value is PreferredAudioLanguage {
    return typeof value === 'string' && VALID_PREFERRED_AUDIO_LANGUAGES.includes(value as PreferredAudioLanguage);
  }

  /**
   * Type guard to check if a value is a valid preferred subtitle language.
   *
   * Valid values include 'off', 'default', and ISO 639-2/B language codes.
   *
   * @param value - The value to check
   * @returns True if the value is a valid preferred subtitle language
   */
  private isValidPreferredSubtitleLanguage(value: unknown): value is PreferredSubtitleLanguage {
    return typeof value === 'string' && VALID_PREFERRED_SUBTITLE_LANGUAGES.includes(value as PreferredSubtitleLanguage);
  }

  /**
   * Type guard to check if a value is a valid macOS visual effect state.
   *
   * Valid values are 'followWindow', 'active', 'inactive'.
   *
   * @param value - The value to check
   * @returns True if the value is a valid macOS visual effect state
   */
  private isValidMacOSVisualEffectState(value: unknown): value is MacOSVisualEffectState {
    return typeof value === 'string' && VALID_MACOS_VISUAL_EFFECT_STATE.includes(value as MacOSVisualEffectState);
  }

  /**
   * Type guard to check if a value is a valid color scheme.
   *
   * @param value - The value to check
   * @returns True if the value is a valid color scheme
   */
  private isValidColorScheme(value: unknown): value is ColorScheme {
    return typeof value === 'string' && VALID_COLOR_SCHEME.includes(value as ColorScheme);
  }

  /**
   * Type guard to check if a value is a valid hue (0-360).
   *
   * @param value - The value to check
   * @returns True if the value is a valid hue
   */
  private isValidHue(value: unknown): value is number {
    return typeof value === 'number' && value >= 0 && value <= 360;
  }

  /**
   * Type guard to check if a value is a valid saturation or lightness (0-100).
   *
   * @param value - The value to check
   * @returns True if the value is a valid percentage
   */
  private isValidPercentage(value: unknown): value is number {
    return typeof value === 'number' && value >= 0 && value <= 100;
  }

  /**
   * Type guard to check if a value is a valid alpha (0-1).
   *
   * @param value - The value to check
   * @returns True if the value is a valid alpha
   */
  private isValidAlpha(value: unknown): value is number {
    return typeof value === 'number' && value >= 0 && value <= 1;
  }

  /**
   * Type guard to check if a value is a valid subtitle font size.
   *
   * Valid values are integers between 50 and 300 (percentage).
   *
   * @param value - The value to check
   * @returns True if the value is a valid subtitle font size
   */
  private isValidSubtitleFontSize(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 50 && value <= 300;
  }

  /**
   * Type guard to check if a value is a valid subtitle font family.
   *
   * Valid values are 'sans-serif', 'serif', or 'monospace'.
   *
   * @param value - The value to check
   * @returns True if the value is a valid subtitle font family
   */
  private isValidSubtitleFontFamily(value: unknown): value is SubtitleFontFamily {
    return typeof value === 'string' && VALID_SUBTITLE_FONT_FAMILIES.includes(value as SubtitleFontFamily);
  }

  /**
   * Type guard to check if a value is a valid subtitle shadow spread.
   *
   * Valid values are numbers from 1 to 5 (inclusive).
   *
   * @param value - The value to check
   * @returns True if the value is a valid subtitle shadow spread
   */
  private isValidSubtitleShadowSpread(value: unknown): value is number {
    return typeof value === 'number' && value >= 1 && value <= 5;
  }

  /**
   * Type guard to check if a value is a valid subtitle shadow blur.
   *
   * Valid values are numbers from 0 to 10 (inclusive).
   *
   * @param value - The value to check
   * @returns True if the value is a valid subtitle shadow blur
   */
  private isValidSubtitleShadowBlur(value: unknown): value is number {
    return typeof value === 'number' && value >= 0 && value <= 10;
  }

  /**
   * Converts HSL values to a hex color string.
   *
   * @param h - Hue (0-360)
   * @param s - Saturation (0-100)
   * @param l - Lightness (0-100)
   * @returns Hex color string (e.g., '#1e1e1e')
   */
  private hslToHex(h: number, s: number, l: number): string {
    const sNorm: number = s / 100;
    const lNorm: number = l / 100;
    const a: number = sNorm * Math.min(lNorm, 1 - lNorm);
    const f: (n: number) => number = (n: number): number => {
      const k: number = (n + h / 30) % 12;
      const color: number = lNorm - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * color);
    };
    const toHex: (x: number) => string = (x: number): string => x.toString(16).padStart(2, '0');
    return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
  }
}

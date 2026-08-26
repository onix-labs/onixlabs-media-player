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
import {EQ_PRESETS, EQ_CUSTOM_PRESET, EQ_GAIN_MIN, EQ_GAIN_MAX, normalizeBands, flatBands, type EqualizerPreset} from './equalizer';
import {VIDEO_ADJUSTMENT_PRESETS, VIDEO_ADJ_CUSTOM_PRESET, NEUTRAL_VIDEO_ADJUSTMENTS, normalizeAdjustments, type VideoAdjustmentValues, type VideoAdjustmentPreset} from './video-adjustments';

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
 * - pulsar: Pulsing concentric rings with curved waveforms (waves category)
 * - water: Reactor - concentric tower wrapped in frequency rings (signature category)
 * - spotlight: Concentric tower wrapped in counter-spinning rings (signature category)
 * - infinity: Dual orbiting circles with spectrum cycling
 */

/**
 * Valid FFT size values (must be powers of 2).
 */
export type FftSize = 256 | 512 | 1024 | 2048 | 4096;

/**
 * Effective fullscreen rendering resolution for visualizations.
 *
 * 'native' renders at the display's pixel size. Any fixed value renders to an
 * offscreen-sized canvas of that resolution which is then stretched (with
 * nearest-neighbour scaling, no blending) to fill the screen for a pixelated look.
 */
export type RenderResolution =
  | 'native'
  | '320x180' | '320x200'
  | '640x360' | '640x400' | '640x480'
  | '800x450' | '800x500' | '800x600'
  | '1024x576' | '1024x640' | '1024x768'
  | '1280x720' | '1280x800' | '1280x1024';

/** All valid render resolution values, in display order. */
export const RENDER_RESOLUTIONS: readonly RenderResolution[] = [
  'native',
  '320x180', '320x200',
  '640x360', '640x400', '640x480',
  '800x450', '800x500', '800x600',
  '1024x576', '1024x640', '1024x768',
  '1280x720', '1280x800', '1280x1024',
];

/**
 * Duration in milliseconds of the crossfade played when switching between
 * visualizations. The outgoing visualization fades out while the incoming
 * one fades in over this period.
 */
export type CrossfadeDuration = 500 | 750 | 1000 | 1500 | 2000;

/** All valid crossfade duration values, in display order. */
export const CROSSFADE_DURATIONS: readonly CrossfadeDuration[] = [500, 750, 1000, 1500, 2000];

/**
 * Visual style of the transition played when switching between visualizations.
 * - fade: Classic crossfade (opacity blend)
 * - zoom: Outgoing expands outwards and fades out while the incoming fades in behind it
 * - shrink: Incoming starts oversized and transparent, shrinking into view while the outgoing fades out
 * - blur: Outgoing blurs and fades out while the incoming sharpens and fades in
 * - random: A randomly chosen style is used for each switch
 */
export type CrossfadeStyle =
  | 'fade' | 'zoom' | 'shrink' | 'blur' | 'random';

/** All valid crossfade style values, in display order. */
export const CROSSFADE_STYLES: readonly CrossfadeStyle[] = [
  'fade', 'zoom', 'shrink', 'blur', 'random',
];

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
  readonly strobeFrequency?: number;
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
  readonly category: 'Bars' | 'Waves' | 'Signature' | 'Retro' | 'Simple';
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
 * Seek bar behaviour options.
 * - drop: Seek once when the drag is released
 * - drag: Seek continuously while dragging, and on release
 */
export type SeekMode = 'drop' | 'drag';

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
  /** Effective fullscreen rendering resolution ('native' or a fixed WxH, default 'native') */
  readonly renderResolution: RenderResolution;
  /** Crossfade duration in ms when switching visualizations (default 1000) */
  readonly crossfadeDuration: CrossfadeDuration;
  /** Visual style of the visualization switch transition (default 'fade') */
  readonly crossfadeStyle: CrossfadeStyle;
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
  /** Whether to switch to the mini-player when the main window loses focus (default false) */
  readonly miniplayerOnFocusLoss: boolean;
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
  /** Seek bar behaviour: seek on release only, or continuously while dragging (default 'drop') */
  readonly seekMode: SeekMode;
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
/**
 * Equalizer settings — a 10-band graphic equalizer applied to all audio.
 */
export interface EqualizerSettings {
  /** Whether the equalizer is active */
  readonly enabled: boolean;
  /** Selected preset identifier ('flat', 'rock', …, or 'custom') */
  readonly preset: string;
  /** Per-band gains in dB (length 10, order matches EQ_FREQUENCIES) */
  readonly bands: readonly number[];
}

/**
 * Video adjustment settings — real-time CSS colour/tone filters for video.
 */
export interface VideoAdjustmentsSettings extends VideoAdjustmentValues {
  /** Whether video adjustments are active */
  readonly enabled: boolean;
  /** Selected preset identifier ('default', 'vivid', …, or 'custom') */
  readonly preset: string;
}

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
  /** Equalizer settings */
  readonly equalizer: EqualizerSettings;
  /** Video adjustment settings */
  readonly videoAdjustments: VideoAdjustmentsSettings;
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
  strobeFrequency: 5,
};

/**
 * Metadata for all visualizations including which settings apply to each.
 */
export const VISUALIZATION_METADATA: readonly VisualizationMetadata[] = [
  // Bars category
  {id: 'bars', name: 'Analyzer', category: 'Bars', applicableSettings: ['barDensity', 'barColorBottom', 'barColorMiddle', 'barColorTop']},
  // Waves category
  {id: 'waveform', name: 'Classic', category: 'Waves', applicableSettings: []},
  {id: 'modern', name: 'Modern', category: 'Waves', applicableSettings: []},
  {id: 'tunnel', name: 'Plasma', category: 'Waves', applicableSettings: []},
  {id: 'neon', name: 'Neon', category: 'Waves', applicableSettings: []},
  {id: 'pulsar', name: 'Pulsar', category: 'Waves', applicableSettings: []},
  {id: 'blackhole', name: 'Black Hole', category: 'Waves', applicableSettings: []},
  {id: 'particles', name: 'Particles', category: 'Waves', applicableSettings: []},
  // Signature category
  {id: 'spotlight', name: 'Spotlight', category: 'Signature', applicableSettings: []},
  {id: 'water', name: 'Reactor', category: 'Signature', applicableSettings: []},
  {id: 'infinity', name: 'Infinity', category: 'Waves', applicableSettings: []},
  {id: 'onix', name: 'Onix', category: 'Waves', applicableSettings: []},
  // Retro category
  {id: 'alchemy', name: 'Alchemy', category: 'Retro', applicableSettings: []},
  // Simple category
  {id: 'blank', name: 'Blank', category: 'Simple', applicableSettings: []},
  {id: 'logo', name: 'Logo', category: 'Simple', applicableSettings: []},
];

/**
 * Default settings used before server data is received.
 */
const DEFAULT_SETTINGS: AppSettings = {
  version: 2,
  visualization: {
    defaultType: 'water',
    maxFrameRate: 0,
    fftSize: 2048,
    renderResolution: 'native',
    crossfadeDuration: 1000,
    crossfadeStyle: 'fade',
    perVisualizationSettings: {},
  },
  application: {
    serverPort: 0,
    controlsAutoHideDelay: 5,
    miniplayerOnFocusLoss: false,
  },
  playback: {
    defaultVolume: 0.5,
    crossfadeDuration: 100,
    previousTrackThreshold: 3,
    skipDuration: 10,
    videoAspectMode: 'default',
    preferredAudioLanguage: 'eng',
    preferredSubtitleLanguage: 'off',
    seekMode: 'drop',
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
  equalizer: {
    enabled: false,
    preset: 'flat',
    bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  videoAdjustments: {
    enabled: false,
    preset: 'default',
    ...NEUTRAL_VIDEO_ADJUSTMENTS,
  },
};

/**
 * Available visualization options for the settings UI.
 */
export const VISUALIZATION_OPTIONS: readonly VisualizationOption[] = [
  // Bars category
  {value: 'bars', label: 'Bars : Analyzer', description: 'Configurable frequency bars with gradient'},
  // Waves category
  {value: 'waveform', label: 'Waves : Classic', description: 'Oscilloscope-style waveform with glow'},
  {value: 'modern', label: 'Waves : Modern', description: 'Frequency spectrum with gradient glow'},
  {value: 'tunnel', label: 'Waves : Plasma', description: 'Dual waveforms with plasma zoom effect'},
  {value: 'infinity', label: 'Waves : Infinity', description: 'Dual orbiting circles with spectrum cycling'},
  {value: 'neon', label: 'Waves : Neon', description: 'Rotating cyan/magenta waveforms'},
  {value: 'onix', label: 'Waves : Onix', description: 'ONIXLabs logo with pulsating rings'},
  {value: 'pulsar', label: 'Waves : Pulsar', description: 'Pulsing concentric rings with curved waveforms'},
  {value: 'blackhole', label: 'Waves : Black Hole', description: 'Glowing accretion-disk waveform around a black core'},
  // Signature category
  {value: 'spotlight', label: 'Signature : Spotlight', description: 'Concentric tower wrapped in counter-spinning frequency rings'},
  {value: 'water', label: 'Signature : Reactor', description: 'Concentric glowing tower wrapped in spiralling frequency rings'},
  // Retro category
  {value: 'alchemy', label: 'Retro : Alchemy', description: 'Frame-feedback smear engine cycling through warp presets'},
  // Simple category
  {value: 'blank', label: 'Simple : Blank', description: 'Renders nothing'},
  {value: 'logo', label: 'Simple : Logo', description: 'The ONIXPlayer logo, centred'},
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
 * Display information for a seek mode option.
 */
export interface SeekModeOption {
  /** The seek mode value */
  readonly value: SeekMode;
  /** Human-readable display label */
  readonly label: string;
}

/**
 * Available seek mode options for the settings UI.
 */
export const SEEK_MODE_OPTIONS: readonly SeekModeOption[] = [
  {value: 'drop', label: 'Seek on drop'},
  {value: 'drag', label: 'Seek on drag and drop'},
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
 * A promise plus the handles to settle it, used to hand every caller queued
 * into one debounced write a promise that resolves when that write completes.
 */
interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason?: unknown) => void;
}

/**
 * Creates a {@link Deferred}.
 *
 * @returns A pending promise and its resolve/reject handles
 */
function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;

  const promise: Promise<void> = new Promise<void>(
    (res: () => void, rej: (reason?: unknown) => void): void => {
      resolve = res;
      reject = rej;
    }
  );

  return {promise, resolve, reject};
}

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

  /**
   * Field updates awaiting their debounced PUT, keyed by settings category.
   *
   * Merged field-wise, so a burst touching different fields of one category
   * still persists all of them and the last write to any given field wins.
   */
  private readonly pendingUpdates: Map<string, Record<string, unknown>> = new Map();

  /** Trailing-edge debounce timers, keyed by settings category. */
  private readonly updateTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /**
   * Promises handed to callers awaiting a category's queued write, so that
   * awaiting a setter still means "sent" rather than "queued".
   */
  private readonly pendingDeferrals: Map<string, Deferred> = new Map();

  /**
   * Debounce delay (ms) before a category's pending changes are sent.
   *
   * Long enough to collapse a slider drag into a couple of writes, short
   * enough that a change feels immediately persisted. Comparable to the
   * volume persist debounce in MediaPlayerService.
   */
  private readonly persistDebounceMs: number = 200;

  /** Flushes pending writes when the window goes away, so a drag-then-quit persists. */
  private readonly onPageHide: () => void;

  /** Removes the SSE settings subscription on teardown. */
  private readonly unsubscribeSettings: () => void;

  // ============================================================================
  // Constructor
  // ============================================================================

  /**
   * Registers the SSE callback with ElectronService and fetches initial settings.
   */
  public constructor() {
    // Register callback to receive settings updates from SSE
    this.unsubscribeSettings = this.electron.onSettingsUpdate((settings: AppSettings): void => {
      this.updateFromSSE(settings);
    });

    // Fetch settings once serverUrl is available (SSE initial event may have been missed)
    this.serverUrlEffect = effect((): void => {
      const serverUrl: string = this.electron.serverUrl();
      if (serverUrl && !this.isLoaded()) {
        // fetchSettings throws on a non-2xx or a network failure, and this is
        // a startup race against the server coming up — an unhandled rejection
        // here is routine rather than exceptional. SSE delivers the settings
        // anyway once the connection is live, so log and move on.
        void this.fetchSettings().catch((error: unknown): void => {
          console.error('[SettingsService] Initial settings fetch failed:', error);
        });
      }
    });

    this.onPageHide = (): void => this.flushPendingUpdates();
    window.addEventListener('pagehide', this.onPageHide);
  }

  /**
   * Cleans up resources when the service is destroyed.
   */
  public ngOnDestroy(): void {
    this.serverUrlEffect.destroy();
    this.unsubscribeSettings();
    window.removeEventListener('pagehide', this.onPageHide);
    this.flushPendingUpdates();
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

  /** Effective fullscreen rendering resolution ('native' or a fixed WxH) */
  public readonly renderResolution: ReturnType<typeof computed<RenderResolution>> = computed(
    (): RenderResolution => this.settings().visualization?.renderResolution ?? 'native'
  );

  /** Crossfade duration in ms when switching visualizations */
  public readonly visualizationCrossfadeDuration: ReturnType<typeof computed<CrossfadeDuration>> = computed(
    (): CrossfadeDuration => this.settings().visualization?.crossfadeDuration ?? 1000
  );

  /** Visual style of the visualization switch transition */
  public readonly visualizationCrossfadeStyle: ReturnType<typeof computed<CrossfadeStyle>> = computed(
    (): CrossfadeStyle => this.settings().visualization?.crossfadeStyle ?? 'fade'
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

  /** Whether to switch to the mini-player when the main window loses focus */
  public readonly miniplayerOnFocusLoss: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.settings().application?.miniplayerOnFocusLoss ?? false
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

  /** Seek bar behaviour: seek on release only, or continuously while dragging */
  public readonly seekMode: ReturnType<typeof computed<SeekMode>> = computed(
    (): SeekMode => this.settings().playback?.seekMode ?? 'drop'
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

  /** Whether the equalizer is enabled */
  public readonly equalizerEnabled: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.settings().equalizer?.enabled ?? false
  );

  /** Selected equalizer preset identifier */
  public readonly equalizerPreset: ReturnType<typeof computed<string>> = computed(
    (): string => this.settings().equalizer?.preset ?? 'flat'
  );

  /** Equalizer per-band gains in dB (always length 10) */
  public readonly equalizerBands: ReturnType<typeof computed<readonly number[]>> = computed(
    (): readonly number[] => normalizeBands(this.settings().equalizer?.bands)
  );

  /** Whether video adjustments are enabled */
  public readonly videoAdjustmentsEnabled: ReturnType<typeof computed<boolean>> = computed(
    (): boolean => this.settings().videoAdjustments?.enabled ?? false
  );

  /** Selected video-adjustment preset identifier */
  public readonly videoAdjustmentsPreset: ReturnType<typeof computed<string>> = computed(
    (): string => this.settings().videoAdjustments?.preset ?? 'default'
  );

  /** Normalised video adjustment values */
  public readonly videoAdjustments: ReturnType<typeof computed<VideoAdjustmentValues>> = computed(
    (): VideoAdjustmentValues => normalizeAdjustments(this.settings().videoAdjustments)
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
    await this.updateSettingGroup(category, {[field]: value});
  }

  /**
   * Queues an update to several fields of a settings category (e.g. an
   * equalizer preset and its band gains together), coalescing rapid changes.
   *
   * Every write ends in a synchronous writeFileSync + renameSync on the main
   * process and a broadcast of the whole settings object back over SSE. The
   * main process also runs the media server, so a slider bound to (input) —
   * which fires continuously through a drag — could stutter playback by
   * driving dozens of those per second. Changes to a category are therefore
   * merged and sent once the user pauses.
   *
   * The local signal is updated immediately so the debounce is invisible: the
   * equalizer chain, the video filter and the controls' own displayed values
   * all read from it, and waiting for the server to echo the change back
   * would make every slider lag behind the drag by the debounce interval.
   * The eventual SSE event confirms the same value, or corrects it if the
   * server normalised it.
   *
   * The returned promise still resolves only once the write has been sent, so
   * awaiting a setter means what it always did. Every caller queued into the
   * same burst settles together on that one write.
   *
   * @param category - Settings category
   * @param update - Partial object of fields to update
   * @returns A promise that resolves once the coalesced write completes
   */
  private updateSettingGroup(category: string, update: Record<string, unknown>): Promise<void> {
    this.applyLocalUpdate(category, update);

    const pending: Record<string, unknown> = this.pendingUpdates.get(category) ?? {};
    this.pendingUpdates.set(category, Object.assign(pending, update));

    const timer: ReturnType<typeof setTimeout> | undefined = this.updateTimers.get(category);
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    let deferred: Deferred | undefined = this.pendingDeferrals.get(category);
    if (!deferred) {
      deferred = createDeferred();
      this.pendingDeferrals.set(category, deferred);
    }

    this.updateTimers.set(
      category,
      setTimeout((): void => this.flushCategory(category), this.persistDebounceMs)
    );

    return deferred.promise;
  }

  /**
   * Sends one category's queued fields now, cancelling any pending timer and
   * settling everyone awaiting the write.
   *
   * @param category - Settings category to flush
   */
  private flushCategory(category: string): void {
    const timer: ReturnType<typeof setTimeout> | undefined = this.updateTimers.get(category);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.updateTimers.delete(category);
    }

    const deferred: Deferred | undefined = this.pendingDeferrals.get(category);
    this.pendingDeferrals.delete(category);

    void this.sendSettingGroup(category).then(
      (): void => deferred?.resolve(),
      (error: unknown): void => deferred?.reject(error)
    );
  }

  /**
   * Merges an update into the settings signal without waiting for the server.
   *
   * Keeps the debounced write invisible to everything that reads settings,
   * and keeps read-modify-write setters correct: setEqualizerBand rebuilds
   * the whole band array from the signal, so a stale signal would silently
   * drop the previous band's change.
   *
   * @param category - Settings category
   * @param update - Partial object of fields to merge into it
   */
  private applyLocalUpdate(category: string, update: Record<string, unknown>): void {
    this.settings.update((current: AppSettings): AppSettings => this.mergeCategory(current, category, update));
  }

  /**
   * Returns a copy of `settings` with `update` merged into one category.
   *
   * @param settings - The settings to merge into
   * @param category - Settings category
   * @param update - Partial object of fields to merge
   * @returns The merged settings, or the original if the category is absent
   */
  private mergeCategory(settings: AppSettings, category: string, update: Record<string, unknown>): AppSettings {
    const record: Record<string, unknown> = settings as unknown as Record<string, unknown>;
    const group: unknown = record[category];
    if (typeof group !== 'object' || group === null) return settings;

    return {
      ...record,
      [category]: {...(group as Record<string, unknown>), ...update},
    } as unknown as AppSettings;
  }

  /**
   * Sends a category's queued fields to the server.
   *
   * @param category - Settings category to send
   */
  private async sendSettingGroup(category: string): Promise<void> {
    const update: Record<string, unknown> | undefined = this.pendingUpdates.get(category);
    if (!update) return;
    this.pendingUpdates.delete(category);

    const serverUrl: string = this.electron.serverUrl();
    if (!serverUrl) return;

    const response: Response = await this.electron.authFetch(`${serverUrl}/settings/${category}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(update),
    });

    if (!response.ok) {
      console.error(`[SettingsService] Failed to save ${category}: ${response.status}`);
    }
  }

  /**
   * Sends every queued category immediately.
   *
   * Used on teardown so a change made moments before the window closes is not
   * lost along with its pending timer.
   */
  private flushPendingUpdates(): void {
    for (const category of [...this.pendingUpdates.keys()]) {
      this.flushCategory(category);
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
   * The server broadcasts the whole settings object on every write, including
   * writes from other categories. Any change still waiting on its debounce is
   * re-applied on top, so an unrelated broadcast mid-drag cannot momentarily
   * snap a slider back to the last value the server happens to know about.
   *
   * @param newSettings - The updated settings from the server
   */
  public updateFromSSE(newSettings: AppSettings): void {
    let merged: AppSettings = newSettings;
    for (const [category, update] of this.pendingUpdates) {
      merged = this.mergeCategory(merged, category, update);
    }

    this.settings.set(merged);
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

  /**
   * Sets the effective fullscreen rendering resolution.
   *
   * @param value - 'native' or a fixed resolution (e.g. '640x360')
   */
  public async setRenderResolution(value: RenderResolution): Promise<void> {
    if (!RENDER_RESOLUTIONS.includes(value)) {
      console.error(`[SettingsService] Invalid render resolution: ${value}`);
      return;
    }
    await this.updateSetting('visualization', 'renderResolution', value);
  }

  /**
   * Sets the crossfade duration used when switching visualizations.
   *
   * @param value - Duration in milliseconds (500, 750, 1000, 1500, or 2000)
   */
  public async setVisualizationCrossfadeDuration(value: CrossfadeDuration): Promise<void> {
    if (!CROSSFADE_DURATIONS.includes(value)) {
      console.error(`[SettingsService] Invalid crossfade duration: ${value}`);
      return;
    }
    await this.updateSetting('visualization', 'crossfadeDuration', value);
  }

  /**
   * Sets the visual style used when switching visualizations.
   *
   * @param value - The crossfade style (fade, slide, push, wipe, radial, zoom, bars, random)
   */
  public async setVisualizationCrossfadeStyle(value: CrossfadeStyle): Promise<void> {
    if (!CROSSFADE_STYLES.includes(value)) {
      console.error(`[SettingsService] Invalid crossfade style: ${value}`);
      return;
    }
    await this.updateSetting('visualization', 'crossfadeStyle', value);
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
    } else if (setting === 'strobeFrequency') {
      validValue = this.clamp(value as number, 1, 20) as VisualizationLocalSettings[K];
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

    const response: Response = await this.electron.authFetch(`${serverUrl}/settings/visualization`, {
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

    const response: Response = await this.electron.authFetch(`${serverUrl}/settings/visualization`, {
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
   * Sets whether to switch to the mini-player when the main window loses focus.
   *
   * @param enabled - True to enter the mini-player on focus loss
   */
  public async setMiniplayerOnFocusLoss(enabled: boolean): Promise<void> {
    await this.updateSetting('application', 'miniplayerOnFocusLoss', enabled);
  }

  /**
   * Sets the seek bar behaviour.
   *
   * @param mode - 'drop' to seek on release only, 'drag' to seek while dragging
   */
  public async setSeekMode(mode: SeekMode): Promise<void> {
    const validModes: readonly SeekMode[] = ['drop', 'drag'];
    if (!validModes.includes(mode)) {
      console.error(`[SettingsService] Invalid seek mode: ${mode}`);
      return;
    }
    await this.updateSetting('playback', 'seekMode', mode);
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
   * Enables or disables the equalizer.
   *
   * @param enabled - Whether the equalizer should be active
   */
  public async setEqualizerEnabled(enabled: boolean): Promise<void> {
    await this.updateSetting('equalizer', 'enabled', enabled);
  }

  /**
   * Applies a named equalizer preset. Selecting a built-in preset also sets
   * its band gains; 'custom' leaves the current bands untouched.
   *
   * @param preset - The preset identifier
   */
  public async setEqualizerPreset(preset: string): Promise<void> {
    const match: EqualizerPreset | undefined = EQ_PRESETS.find(
      (p: EqualizerPreset): boolean => p.value === preset
    );
    if (!match) {
      console.error(`[SettingsService] Invalid equalizer preset: ${preset}`);
      return;
    }
    const update: {preset: string; bands?: number[]} = {preset: match.value};
    if (match.bands) {
      update.bands = normalizeBands(match.bands);
    }
    await this.updateSettingGroup('equalizer', update);
  }

  /**
   * Sets a single equalizer band gain. Hand-tuning a band switches the
   * preset to 'custom'.
   *
   * @param index - Band index (0-9)
   * @param gain - Gain in dB (clamped to -12..12)
   */
  public async setEqualizerBand(index: number, gain: number): Promise<void> {
    const bands: number[] = normalizeBands(this.equalizerBands());
    if (index < 0 || index >= bands.length) {
      console.error(`[SettingsService] Invalid equalizer band index: ${index}`);
      return;
    }
    bands[index] = this.clamp(gain, EQ_GAIN_MIN, EQ_GAIN_MAX);
    await this.updateSettingGroup('equalizer', {preset: EQ_CUSTOM_PRESET, bands});
  }

  /**
   * Resets the equalizer to flat (all bands 0 dB, 'flat' preset).
   */
  public async resetEqualizer(): Promise<void> {
    await this.updateSettingGroup('equalizer', {preset: 'flat', bands: flatBands()});
  }

  /**
   * Enables or disables video adjustments.
   *
   * @param enabled - Whether video adjustments should be active
   */
  public async setVideoAdjustmentsEnabled(enabled: boolean): Promise<void> {
    await this.updateSetting('videoAdjustments', 'enabled', enabled);
  }

  /**
   * Applies a named video-adjustment preset. Built-in presets also set their
   * values; 'custom' leaves the current values untouched.
   *
   * @param preset - The preset identifier
   */
  public async setVideoAdjustmentPreset(preset: string): Promise<void> {
    const match: VideoAdjustmentPreset | undefined = VIDEO_ADJUSTMENT_PRESETS.find(
      (p: VideoAdjustmentPreset): boolean => p.value === preset
    );
    if (!match) {
      console.error(`[SettingsService] Invalid video adjustment preset: ${preset}`);
      return;
    }
    const update: Record<string, unknown> = {preset: match.value};
    if (match.values) {
      Object.assign(update, normalizeAdjustments(match.values));
    }
    await this.updateSettingGroup('videoAdjustments', update);
  }

  /**
   * Sets a single video adjustment value. Hand-tuning switches the preset
   * to 'custom'.
   *
   * @param key - The adjustment field (e.g. 'brightness', 'invert')
   * @param value - The new value (number for levels, boolean for invert)
   */
  public async setVideoAdjustment(key: keyof VideoAdjustmentValues, value: number | boolean): Promise<void> {
    await this.updateSettingGroup('videoAdjustments', {preset: VIDEO_ADJ_CUSTOM_PRESET, [key]: value});
  }

  /**
   * Resets all video adjustments to neutral ('default' preset).
   */
  public async resetVideoAdjustments(): Promise<void> {
    await this.updateSettingGroup('videoAdjustments', {preset: 'default', ...NEUTRAL_VIDEO_ADJUSTMENTS});
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
    // Validated like the other subtitle colors: this value is interpolated
    // into an injected <style> element, so an unvalidated string is a CSS
    // injection vector.
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
      console.error(`[SettingsService] Invalid hex color: ${color}`);
      return;
    }
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

    const response: Response = await this.electron.authFetch(`${serverUrl}/settings`);
    if (!response.ok) {
      throw new Error(`Failed to fetch settings: ${response.statusText}`);
    }

    const settings: AppSettings = await response.json();
    this.settings.set(settings);
    this.isLoaded.set(true);
    return settings;
  }
}

/**
 * @fileoverview Video adjustments domain model and CSS-filter engine.
 *
 * Provides the value ranges, presets, and a pure helper to build a CSS
 * `filter` string for real-time video colour/tone adjustments (brightness,
 * contrast, saturation, hue, soften, grayscale, sepia, invert).
 *
 * Applied client-side as a CSS filter on the `<video>` element, so it works
 * in real time for every video (native and transcoded) without re-encoding.
 * State lives in {@link SettingsService}; {@link VideoOutlet} binds the
 * generated filter string to the element.
 *
 * @module app/services/video-adjustments
 */

/** Min/max for level adjustments (brightness, contrast, saturation). */
export const VIDEO_ADJ_LEVEL_MIN: number = -100;
export const VIDEO_ADJ_LEVEL_MAX: number = 100;

/** Min/max for the hue rotation (degrees). */
export const VIDEO_ADJ_HUE_MIN: number = -180;
export const VIDEO_ADJ_HUE_MAX: number = 180;

/** Min/max for effect amounts (soften, grayscale, sepia). */
export const VIDEO_ADJ_EFFECT_MIN: number = 0;
export const VIDEO_ADJ_EFFECT_MAX: number = 100;

/** Special preset value indicating hand-tuned adjustments. */
export const VIDEO_ADJ_CUSTOM_PRESET: string = 'custom';

/**
 * The adjustable video values. Levels are -100..100 (0 = neutral), hue is
 * -180..180 degrees, effects are 0..100, and invert is a toggle.
 */
export interface VideoAdjustmentValues {
  readonly brightness: number;
  readonly contrast: number;
  readonly saturation: number;
  readonly hue: number;
  readonly blur: number;
  readonly grayscale: number;
  readonly sepia: number;
  readonly invert: boolean;
}

/** Neutral (no-op) adjustment values. */
export const NEUTRAL_VIDEO_ADJUSTMENTS: VideoAdjustmentValues = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  blur: 0,
  grayscale: 0,
  sepia: 0,
  invert: false,
};

/**
 * A named video-adjustment preset.
 */
export interface VideoAdjustmentPreset {
  readonly value: string;
  readonly label: string;
  /** Full value set, or null for Custom. */
  readonly values: VideoAdjustmentValues | null;
}

/**
 * Built-in video-adjustment presets. 'custom' carries no values — it is
 * selected automatically when the user hand-tunes a control.
 */
export const VIDEO_ADJUSTMENT_PRESETS: readonly VideoAdjustmentPreset[] = [
  {value: 'default', label: 'Default', values: NEUTRAL_VIDEO_ADJUSTMENTS},
  {value: 'vivid', label: 'Vivid', values: {brightness: 5, contrast: 15, saturation: 30, hue: 0, blur: 0, grayscale: 0, sepia: 0, invert: false}},
  {value: 'warm', label: 'Warm', values: {brightness: 5, contrast: 0, saturation: 10, hue: 0, blur: 0, grayscale: 0, sepia: 30, invert: false}},
  {value: 'cool', label: 'Cool', values: {brightness: 0, contrast: 5, saturation: 10, hue: -15, blur: 0, grayscale: 0, sepia: 0, invert: false}},
  {value: 'soft', label: 'Soft', values: {brightness: 5, contrast: -10, saturation: 0, hue: 0, blur: 15, grayscale: 0, sepia: 0, invert: false}},
  {value: 'noir', label: 'Noir (B&W)', values: {brightness: 0, contrast: 20, saturation: 0, hue: 0, blur: 0, grayscale: 100, sepia: 0, invert: false}},
  {value: 'night', label: 'Night', values: {brightness: -30, contrast: -10, saturation: 0, hue: 0, blur: 0, grayscale: 0, sepia: 0, invert: false}},
  {value: VIDEO_ADJ_CUSTOM_PRESET, label: 'Custom', values: null},
];

/**
 * A single adjustable control's UI metadata (used to render the sliders).
 */
export interface VideoAdjustmentControl {
  readonly key: 'brightness' | 'contrast' | 'saturation' | 'hue' | 'blur' | 'grayscale' | 'sepia';
  readonly label: string;
  readonly min: number;
  readonly max: number;
  /** Suffix shown after the value (e.g. '°'). */
  readonly unit: string;
}

/** Slider controls in display order (invert is a separate toggle). */
export const VIDEO_ADJUSTMENT_CONTROLS: readonly VideoAdjustmentControl[] = [
  {key: 'brightness', label: 'Brightness', min: VIDEO_ADJ_LEVEL_MIN, max: VIDEO_ADJ_LEVEL_MAX, unit: ''},
  {key: 'contrast', label: 'Contrast', min: VIDEO_ADJ_LEVEL_MIN, max: VIDEO_ADJ_LEVEL_MAX, unit: ''},
  {key: 'saturation', label: 'Saturation', min: VIDEO_ADJ_LEVEL_MIN, max: VIDEO_ADJ_LEVEL_MAX, unit: ''},
  {key: 'hue', label: 'Hue', min: VIDEO_ADJ_HUE_MIN, max: VIDEO_ADJ_HUE_MAX, unit: '°'},
  {key: 'blur', label: 'Soften', min: VIDEO_ADJ_EFFECT_MIN, max: VIDEO_ADJ_EFFECT_MAX, unit: ''},
  {key: 'grayscale', label: 'Grayscale', min: VIDEO_ADJ_EFFECT_MIN, max: VIDEO_ADJ_EFFECT_MAX, unit: ''},
  {key: 'sepia', label: 'Sepia', min: VIDEO_ADJ_EFFECT_MIN, max: VIDEO_ADJ_EFFECT_MAX, unit: ''},
];

/** Clamps a value to a range. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Normalises raw adjustment values (defensive against malformed persisted
 * data): clamps each field to its valid range and coerces invert to boolean.
 */
export function normalizeAdjustments(values: Partial<VideoAdjustmentValues> | undefined | null): VideoAdjustmentValues {
  if (!values) return NEUTRAL_VIDEO_ADJUSTMENTS;
  const level: (v: unknown) => number = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    brightness: clamp(level(values.brightness), VIDEO_ADJ_LEVEL_MIN, VIDEO_ADJ_LEVEL_MAX),
    contrast: clamp(level(values.contrast), VIDEO_ADJ_LEVEL_MIN, VIDEO_ADJ_LEVEL_MAX),
    saturation: clamp(level(values.saturation), VIDEO_ADJ_LEVEL_MIN, VIDEO_ADJ_LEVEL_MAX),
    hue: clamp(level(values.hue), VIDEO_ADJ_HUE_MIN, VIDEO_ADJ_HUE_MAX),
    blur: clamp(level(values.blur), VIDEO_ADJ_EFFECT_MIN, VIDEO_ADJ_EFFECT_MAX),
    grayscale: clamp(level(values.grayscale), VIDEO_ADJ_EFFECT_MIN, VIDEO_ADJ_EFFECT_MAX),
    sepia: clamp(level(values.sepia), VIDEO_ADJ_EFFECT_MIN, VIDEO_ADJ_EFFECT_MAX),
    invert: values.invert === true,
  };
}

/**
 * Builds a CSS `filter` string from adjustment values.
 *
 * Levels map symmetrically around neutral: a -100..100 value becomes a
 * 0..2 CSS multiplier (0 → 1×). Soften maps to a 0..10px blur radius.
 *
 * @param values - The adjustment values
 * @param enabled - Whether adjustments are active
 * @returns A CSS filter string, or 'none' when disabled
 */
export function buildVideoFilter(values: VideoAdjustmentValues, enabled: boolean): string {
  if (!enabled) return 'none';
  return [
    `brightness(${1 + values.brightness / 100})`,
    `contrast(${1 + values.contrast / 100})`,
    `saturate(${1 + values.saturation / 100})`,
    `hue-rotate(${values.hue}deg)`,
    `blur(${values.blur / 10}px)`,
    `grayscale(${values.grayscale / 100})`,
    `sepia(${values.sepia / 100})`,
    `invert(${values.invert ? 1 : 0})`,
  ].join(' ');
}

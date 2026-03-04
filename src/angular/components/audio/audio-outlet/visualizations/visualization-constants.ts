/**
 * @fileoverview Shared constants for audio visualizations.
 *
 * Contains all numeric constants used across visualizations to comply with
 * no-magic-numbers ESLint rule. Constants are organized by category for
 * easy discovery and maintenance.
 *
 * @module app/components/audio/audio-outlet/visualizations/visualization-constants
 */

// ============================================================================
// Mathematical constants
// ============================================================================

/** Two pi (full circle in radians) */
export const TWO_PI: number = Math.PI * 2;

/** Half - commonly used for centering */
export const HALF: number = 0.5;

/** Degrees in a full circle */
export const DEGREES_FULL_CIRCLE: number = 360;

/** Degrees in half a circle */
export const DEGREES_HALF_CIRCLE: number = 180;

/** Degrees in a sixth of a circle (60°) */
export const DEGREES_SEXTANT: number = 60;

/** Degrees in two sextants (120°) */
export const DEGREES_TWO_SEXTANTS: number = 120;

/** Degrees in three sextants (180°) - same as half circle */
export const DEGREES_THREE_SEXTANTS: number = 180;

/** Degrees in four sextants (240°) */
export const DEGREES_FOUR_SEXTANTS: number = 240;

/** Degrees in five sextants (300°) */
export const DEGREES_FIVE_SEXTANTS: number = 300;

// ============================================================================
// Color and RGB constants
// ============================================================================

/** Maximum RGB component value (8-bit) */
export const RGB_MAX: number = 255;

/** Half of RGB range (128) - center point for waveform data */
export const RGB_MID: number = 128;

/** Percentage to decimal: 100% */
export const PERCENT_100: number = 100;

/** Percentage to decimal: 50% */
export const PERCENT_50: number = 50;

// ============================================================================
// Audio analysis constants
// ============================================================================

/** Default FFT size for audio analysis */
export const DEFAULT_FFT_SIZE: number = 2048;

/** Milliseconds in one second */
export const MS_PER_SECOND: number = 1000;

/** Kilobytes multiplier */
export const BYTES_PER_KB: number = 1024;

/** Quick fade in duration in milliseconds */
export const FADE_IN_DURATION_MS: number = 500;

// ============================================================================
// Visualization drawing constants
// ============================================================================

/** Default sensitivity for visualizations */
export const DEFAULT_SENSITIVITY: number = 0.25;

/** Higher sensitivity for certain visualizations */
export const HIGH_SENSITIVITY: number = 0.35;

/** Medium sensitivity for bar-based visualizations */
export const MEDIUM_SENSITIVITY: number = 0.5;

/** Default trail intensity */
export const DEFAULT_TRAIL_INTENSITY: number = 0.5;

/** Default line width */
export const DEFAULT_LINE_WIDTH: number = 2.0;

/** Default glow intensity */
export const DEFAULT_GLOW_INTENSITY: number = 0.5;

/** Default waveform smoothing */
export const DEFAULT_WAVEFORM_SMOOTHING: number = 0.5;

/** Default strobe frequency in Hz */
export const DEFAULT_STROBE_FREQUENCY: number = 5;

/** Standard glow blur radius */
export const GLOW_BLUR_RADIUS: number = 12;

/** Reduced glow opacity multiplier for stroke */
export const GLOW_OPACITY_MULTIPLIER: number = 0.375;

/** Glow line width offset */
export const GLOW_LINE_WIDTH_OFFSET: number = 4;

/** Highlight line width */
export const HIGHLIGHT_LINE_WIDTH: number = 1;

/** Divisor for calculating radius from dimension */
export const RADIUS_DIVISOR: number = 3;

/** Divisor for creating larger sections */
export const SECTION_DIVISOR: number = 4;

/** Line width for rendering strokes */
export const STROKE_LINE_WIDTH: number = 5;

// ============================================================================
// Fade and alpha constants
// ============================================================================

/** Alpha value for subtle transparency */
export const ALPHA_SUBTLE: number = 0.3;

/** Alpha value for glow effects */
export const ALPHA_GLOW: number = 0.6;

/** Alpha value for reduced glow */
export const ALPHA_REDUCED_GLOW: number = 0.3;

/** Alpha value for half opacity */
export const ALPHA_HALF: number = 0.5;

/** Alpha for very light elements */
export const ALPHA_VERY_LIGHT: number = 0.08;

/** Alpha for light elements */
export const ALPHA_LIGHT: number = 0.15;

/** Alpha for medium-light elements */
export const ALPHA_MEDIUM_LIGHT: number = 0.25;

/** Alpha for medium elements */
export const ALPHA_MEDIUM: number = 0.35;

/** Alpha for medium-high elements */
export const ALPHA_MEDIUM_HIGH: number = 0.45;

/** Alpha for medium-bright elements */
export const ALPHA_MEDIUM_BRIGHT: number = 0.55;

/** Alpha for high opacity */
export const ALPHA_HIGH: number = 0.7;

/** Alpha for higher opacity */
export const ALPHA_HIGHER: number = 0.75;

/** Alpha for bright elements */
export const ALPHA_BRIGHT: number = 0.85;

// ============================================================================
// Amplitude and size scaling constants
// ============================================================================

/** Very small amplitude scale factor */
export const SCALE_VERY_SMALL: number = 0.08;

/** Small amplitude scale factor */
export const SCALE_SMALL: number = 0.18;

/** Moderately small amplitude scale */
export const SCALE_MODERATELY_SMALL: number = 0.25;

/** Base amplitude scale factor */
export const SCALE_BASE: number = 0.30;

/** Medium amplitude scale factor */
export const SCALE_MEDIUM: number = 0.40;

/** Medium-high amplitude scale factor */
export const SCALE_MEDIUM_HIGH: number = 0.45;

// ============================================================================
// Animation and timing constants
// ============================================================================

/** Small rotation step */
export const ROTATION_SMALL: number = 8;

/** Medium rotation step */
export const ROTATION_MEDIUM: number = 9;

// ============================================================================
// Geometry constants
// ============================================================================

/** Bar count for low density */
export const BAR_COUNT_LOW: number = 48;

/** Bar count for medium density */
export const BAR_COUNT_MEDIUM: number = 96;

/** Bar count for high density */
export const BAR_COUNT_HIGH: number = 144;

/** Small gap size in pixels */
export const GAP_SMALL: number = 2;

/** Corner radius divisor */
export const CORNER_RADIUS_MAX: number = 3;

/** Number of ONIXLabs brand colors */
export const ONIX_COLOR_COUNT: number = 8;

// ============================================================================
// HSL Color range constants
// ============================================================================

/** Starting hue for gradient visualizations */
export const HUE_START: number = 240;

/** Ending hue for gradient visualizations */
export const HUE_END: number = 120;

/** Hue range for pulsar visualization */
export const HUE_PULSAR: number = 210;

// ============================================================================
// Ring and wave counts
// ============================================================================

/** Number of rings in ring-based visualizations */
export const RING_COUNT: number = 60;

/** Number of points per ring */
export const POINTS_PER_RING: number = 75;

/** Minimum visible pixel threshold */
export const MIN_VISIBLE_PIXELS: number = 20;

/** Medium visible threshold */
export const MEDIUM_VISIBLE_THRESHOLD: number = 40;

/** Large visible threshold */
export const LARGE_VISIBLE_THRESHOLD: number = 60;

// ============================================================================
// Specific visualization values
// ============================================================================

/** Frequency range multiplier */
export const FREQUENCY_RANGE: number = 0.75;

/** Smoke fade rate */
export const SMOKE_FADE_RATE: number = 0.04;

/** Maximum bar height percentage */
export const MAX_BAR_HEIGHT_PERCENT: number = 0.45;

// ============================================================================
// ONIXLabs brand colors (flat array format for performance)
// These are RGB triplets that define the brand color spectrum
// ============================================================================

/** ONIXLabs brand color: Orange RGB */
export const ONIX_ORANGE_R: number = 247;
export const ONIX_ORANGE_G: number = 149;
export const ONIX_ORANGE_B: number = 51;

/** ONIXLabs brand color: Coral RGB */
export const ONIX_CORAL_R: number = 243;
export const ONIX_CORAL_G: number = 112;
export const ONIX_CORAL_B: number = 85;

/** ONIXLabs brand color: Pink RGB */
export const ONIX_PINK_R: number = 239;
export const ONIX_PINK_G: number = 78;
export const ONIX_PINK_B: number = 123;

/** ONIXLabs brand color: Purple RGB */
export const ONIX_PURPLE_R: number = 161;
export const ONIX_PURPLE_G: number = 102;
export const ONIX_PURPLE_B: number = 171;

/** ONIXLabs brand color: Blue RGB */
export const ONIX_BLUE_R: number = 80;
export const ONIX_BLUE_G: number = 115;
export const ONIX_BLUE_B: number = 184;

/** ONIXLabs brand color: Teal RGB */
export const ONIX_TEAL_R: number = 16;
export const ONIX_TEAL_G: number = 152;
export const ONIX_TEAL_B: number = 173;

/** ONIXLabs brand color: Cyan RGB */
export const ONIX_CYAN_R: number = 7;
export const ONIX_CYAN_G: number = 179;
export const ONIX_CYAN_B: number = 155;

/** ONIXLabs brand color: Green RGB */
export const ONIX_GREEN_R: number = 111;
export const ONIX_GREEN_G: number = 186;
export const ONIX_GREEN_B: number = 130;

/**
 * Pre-parsed ONIXLabs brand colors as flat Uint8Array for cache efficiency.
 * Format: [r0, g0, b0, r1, g1, b1, ...]
 * Order: Orange, Coral, Pink, Purple, Blue, Teal, Cyan, Green
 */
export const ONIX_COLORS_FLAT: Uint8Array = new Uint8Array([
  ONIX_ORANGE_R, ONIX_ORANGE_G, ONIX_ORANGE_B,
  ONIX_CORAL_R, ONIX_CORAL_G, ONIX_CORAL_B,
  ONIX_PINK_R, ONIX_PINK_G, ONIX_PINK_B,
  ONIX_PURPLE_R, ONIX_PURPLE_G, ONIX_PURPLE_B,
  ONIX_BLUE_R, ONIX_BLUE_G, ONIX_BLUE_B,
  ONIX_TEAL_R, ONIX_TEAL_G, ONIX_TEAL_B,
  ONIX_CYAN_R, ONIX_CYAN_G, ONIX_CYAN_B,
  ONIX_GREEN_R, ONIX_GREEN_G, ONIX_GREEN_B,
]);

// ============================================================================
// HTTP response codes
// ============================================================================

/** HTTP 200 OK */
export const HTTP_OK: number = 200;

/** HTTP 500 Internal Server Error */
export const HTTP_SERVER_ERROR: number = 500;

// ============================================================================
// Multiplier constants
// ============================================================================

/** Double multiplier */
export const MULTIPLIER_DOUBLE: number = 2;

/** Triple multiplier */
export const MULTIPLIER_TRIPLE: number = 3;

/** Quadruple multiplier */
export const MULTIPLIER_QUADRUPLE: number = 4;

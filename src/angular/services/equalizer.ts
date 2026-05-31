/**
 * @fileoverview Equalizer domain model and Web Audio engine helpers.
 *
 * Provides the band frequencies, presets, and value ranges for a 10-band
 * graphic equalizer, plus pure helpers to build and tune a chain of
 * `BiquadFilterNode` peaking filters within any `AudioContext`.
 *
 * The equalizer is applied to every audio source (audio files, MIDI, and
 * video audio) by inserting the same filter chain into each outlet's Web
 * Audio graph. State lives in {@link SettingsService}; each graph builds its
 * own filter nodes (nodes are bound to a single AudioContext) and tunes them
 * from the shared settings.
 *
 * @module app/services/equalizer
 */

/** Number of equalizer bands. */
export const EQ_BAND_COUNT: number = 10;

/* eslint-disable @typescript-eslint/no-magic-numbers -- frequency/preset data tables */
/**
 * Centre frequencies (Hz) for the 10 graphic-EQ bands (ISO octave bands).
 * Index order matches the gain array stored in settings.
 */
export const EQ_FREQUENCIES: readonly number[] = [
  31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
];
/* eslint-enable @typescript-eslint/no-magic-numbers */

/** Minimum band gain in dB. */
export const EQ_GAIN_MIN: number = -12;

/** Maximum band gain in dB. */
export const EQ_GAIN_MAX: number = 12;

/** Q factor for the peaking filters (standard graphic-EQ feel). */
export const EQ_Q: number = 1.0;

/** Special preset value indicating the user has hand-tuned the bands. */
export const EQ_CUSTOM_PRESET: string = 'custom';

/** A flat (all-zero) band array. */
export function flatBands(): number[] {
  return new Array<number>(EQ_BAND_COUNT).fill(0);
}

/**
 * An equalizer preset: a named set of per-band gains.
 */
export interface EqualizerPreset {
  /** Stored preset identifier */
  readonly value: string;
  /** Human-readable label */
  readonly label: string;
  /** Per-band gains in dB (length {@link EQ_BAND_COUNT}), or null for Custom */
  readonly bands: readonly number[] | null;
}

/**
 * Built-in equalizer presets. Band order matches {@link EQ_FREQUENCIES}.
 * 'custom' carries no bands — it is selected automatically when the user
 * hand-tunes a band.
 */
/* eslint-disable @typescript-eslint/no-magic-numbers -- preset gain tables (dB) */
export const EQ_PRESETS: readonly EqualizerPreset[] = [
  {value: 'flat', label: 'Flat', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]},
  {value: 'rock', label: 'Rock', bands: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4]},
  {value: 'pop', label: 'Pop', bands: [-1, 0, 1, 2, 3, 2, 1, 0, -1, -1]},
  {value: 'jazz', label: 'Jazz', bands: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3]},
  {value: 'bass', label: 'Bass Boost', bands: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0]},
  {value: 'vocal', label: 'Vocal', bands: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1]},
  {value: 'treble', label: 'Treble Boost', bands: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6]},
  {value: EQ_CUSTOM_PRESET, label: 'Custom', bands: null},
];
/* eslint-enable @typescript-eslint/no-magic-numbers */

/**
 * Clamps a gain value to the valid equalizer range.
 */
export function clampGain(gain: number): number {
  return Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, gain));
}

/**
 * Normalises a stored band array to exactly {@link EQ_BAND_COUNT} clamped
 * numbers (defensive against malformed persisted data).
 */
export function normalizeBands(bands: readonly number[] | undefined | null): number[] {
  const result: number[] = flatBands();
  if (!bands) return result;
  for (let i: number = 0; i < EQ_BAND_COUNT; i++) {
    const value: number = bands[i];
    result[i] = typeof value === 'number' && Number.isFinite(value) ? clampGain(value) : 0;
  }
  return result;
}

/**
 * Creates a chain of peaking BiquadFilter nodes (one per band) in the given
 * context. The filters are connected in series; the caller connects the
 * source to `filters[0]` and `filters[last]` to the next node.
 *
 * @param context - The AudioContext to create the nodes in
 * @returns The ordered array of band filters (already chained together)
 */
export function createEqualizerFilters(context: AudioContext): BiquadFilterNode[] {
  const filters: BiquadFilterNode[] = EQ_FREQUENCIES.map((frequency: number): BiquadFilterNode => {
    const filter: BiquadFilterNode = context.createBiquadFilter();
    filter.type = 'peaking';
    filter.frequency.value = frequency;
    filter.Q.value = EQ_Q;
    filter.gain.value = 0;
    return filter;
  });

  for (let i: number = 0; i < filters.length - 1; i++) {
    filters[i].connect(filters[i + 1]);
  }

  return filters;
}

/**
 * Applies band gains to an existing filter chain. When disabled, every band
 * is set flat (0 dB) so the chain is transparent without reconnecting it.
 *
 * @param filters - The band filters from {@link createEqualizerFilters}
 * @param bands - Per-band gains in dB
 * @param enabled - Whether the equalizer is active
 */
export function applyEqualizerGains(
  filters: readonly BiquadFilterNode[],
  bands: readonly number[],
  enabled: boolean
): void {
  filters.forEach((filter: BiquadFilterNode, index: number): void => {
    filter.gain.value = enabled ? clampGain(bands[index] ?? 0) : 0;
  });
}

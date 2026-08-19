/**
 * @fileoverview Tests for the equalizer domain model and Web Audio helpers.
 *
 * normalizeBands and clampGain exist specifically to defend the audio graph
 * against malformed persisted settings, so most of this file is about what
 * happens when the stored data is wrong rather than when it is right.
 *
 * @module app/services/equalizer.spec
 */

import {
  EQ_BAND_COUNT,
  EQ_FREQUENCIES,
  EQ_GAIN_MIN,
  EQ_GAIN_MAX,
  EQ_Q,
  EQ_PRESETS,
  EQ_CUSTOM_PRESET,
  flatBands,
  clampGain,
  normalizeBands,
  createEqualizerFilters,
  applyEqualizerGains,
} from './equalizer';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a BiquadFilterNode-shaped stub that records what is set on it.
 *
 * @returns A fake filter node
 */
function createFakeFilter(): BiquadFilterNode {
  return {
    type: '',
    frequency: {value: 0},
    Q: {value: 0},
    gain: {value: 0},
    connect: vi.fn(),
  } as unknown as BiquadFilterNode;
}

/**
 * Creates an AudioContext-shaped stub that hands out fake filters.
 *
 * @returns A fake AudioContext
 */
function createFakeContext(): AudioContext {
  return {
    createBiquadFilter: vi.fn().mockImplementation(createFakeFilter),
  } as unknown as AudioContext;
}

// ============================================================================
// Tests
// ============================================================================

describe('flatBands', (): void => {
  it('returns one zero per band', (): void => {
    const bands: number[] = flatBands();

    expect(bands).toHaveLength(EQ_BAND_COUNT);
    expect(bands.every((b: number): boolean => b === 0)).toBe(true);
  });

  it('returns a fresh array each call', (): void => {
    const first: number[] = flatBands();
    first[0] = 5;

    expect(flatBands()[0]).toBe(0);
  });
});

describe('clampGain', (): void => {
  it('leaves in-range gains alone', (): void => {
    expect(clampGain(0)).toBe(0);
    expect(clampGain(6)).toBe(6);
    expect(clampGain(-6)).toBe(-6);
  });

  it('clamps to the maximum', (): void => {
    expect(clampGain(100)).toBe(EQ_GAIN_MAX);
  });

  it('clamps to the minimum', (): void => {
    expect(clampGain(-100)).toBe(EQ_GAIN_MIN);
  });

  it('accepts the exact bounds', (): void => {
    expect(clampGain(EQ_GAIN_MAX)).toBe(EQ_GAIN_MAX);
    expect(clampGain(EQ_GAIN_MIN)).toBe(EQ_GAIN_MIN);
  });
});

describe('normalizeBands', (): void => {
  it('returns flat for null', (): void => {
    expect(normalizeBands(null)).toEqual(flatBands());
  });

  it('returns flat for undefined', (): void => {
    expect(normalizeBands(undefined)).toEqual(flatBands());
  });

  it('returns flat for an empty array', (): void => {
    expect(normalizeBands([])).toEqual(flatBands());
  });

  it('preserves valid in-range values', (): void => {
    const bands: number[] = [1, -2, 3, -4, 5, -6, 7, -8, 9, -10];

    expect(normalizeBands(bands)).toEqual(bands);
  });

  it('pads a short array with zeros', (): void => {
    const result: number[] = normalizeBands([3, 3]);

    expect(result).toHaveLength(EQ_BAND_COUNT);
    expect(result[0]).toBe(3);
    expect(result[1]).toBe(3);
    expect(result.slice(2).every((b: number): boolean => b === 0)).toBe(true);
  });

  it('truncates a long array to the band count', (): void => {
    const result: number[] = normalizeBands(new Array<number>(20).fill(2));

    expect(result).toHaveLength(EQ_BAND_COUNT);
  });

  it('clamps out-of-range values', (): void => {
    const result: number[] = normalizeBands([99, -99, 0, 0, 0, 0, 0, 0, 0, 0]);

    expect(result[0]).toBe(EQ_GAIN_MAX);
    expect(result[1]).toBe(EQ_GAIN_MIN);
  });

  it('replaces NaN with zero', (): void => {
    expect(normalizeBands([NaN, 0, 0, 0, 0, 0, 0, 0, 0, 0])[0]).toBe(0);
  });

  it('replaces Infinity with zero', (): void => {
    expect(normalizeBands([Infinity, 0, 0, 0, 0, 0, 0, 0, 0, 0])[0]).toBe(0);
    expect(normalizeBands([-Infinity, 0, 0, 0, 0, 0, 0, 0, 0, 0])[0]).toBe(0);
  });

  it('replaces non-numeric entries with zero', (): void => {
    const malformed: readonly number[] = ['6', null, undefined, {}] as unknown as readonly number[];
    const result: number[] = normalizeBands(malformed);

    expect(result.every((b: number): boolean => b === 0)).toBe(true);
  });

  it('does not mutate its input', (): void => {
    const bands: number[] = [99, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    normalizeBands(bands);

    expect(bands[0]).toBe(99);
  });
});

describe('EQ_PRESETS', (): void => {
  it('gives every non-custom preset a full band array', (): void => {
    for (const preset of EQ_PRESETS) {
      if (preset.value === EQ_CUSTOM_PRESET) continue;
      expect(preset.bands, preset.value).toHaveLength(EQ_BAND_COUNT);
    }
  });

  it('keeps every preset gain within range', (): void => {
    for (const preset of EQ_PRESETS) {
      for (const gain of preset.bands ?? []) {
        expect(gain, preset.value).toBeGreaterThanOrEqual(EQ_GAIN_MIN);
        expect(gain, preset.value).toBeLessThanOrEqual(EQ_GAIN_MAX);
      }
    }
  });

  it('carries no bands for the custom preset', (): void => {
    const custom: {bands: readonly number[] | null} | undefined = EQ_PRESETS.find(
      (p: {value: string}): boolean => p.value === EQ_CUSTOM_PRESET
    );

    expect(custom?.bands).toBeNull();
  });

  it('has unique preset identifiers', (): void => {
    const values: string[] = EQ_PRESETS.map((p: {value: string}): string => p.value);

    expect(new Set(values).size).toBe(values.length);
  });
});

describe('createEqualizerFilters', (): void => {
  it('creates one peaking filter per band frequency', (): void => {
    const filters: BiquadFilterNode[] = createEqualizerFilters(createFakeContext());

    expect(filters).toHaveLength(EQ_BAND_COUNT);
    filters.forEach((filter: BiquadFilterNode, i: number): void => {
      expect(filter.type).toBe('peaking');
      expect(filter.frequency.value).toBe(EQ_FREQUENCIES[i]);
      expect(filter.Q.value).toBe(EQ_Q);
      expect(filter.gain.value).toBe(0);
    });
  });

  it('chains each filter into the next, leaving the last unconnected', (): void => {
    const filters: BiquadFilterNode[] = createEqualizerFilters(createFakeContext());

    for (let i: number = 0; i < filters.length - 1; i++) {
      expect(filters[i].connect).toHaveBeenCalledWith(filters[i + 1]);
    }
    // The caller owns the tail connection.
    expect(filters[filters.length - 1].connect).not.toHaveBeenCalled();
  });
});

describe('applyEqualizerGains', (): void => {
  it('applies each band gain when enabled', (): void => {
    const filters: BiquadFilterNode[] = createEqualizerFilters(createFakeContext());
    const bands: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    applyEqualizerGains(filters, bands, true);

    filters.forEach((filter: BiquadFilterNode, i: number): void => {
      expect(filter.gain.value).toBe(bands[i]);
    });
  });

  it('flattens every band when disabled', (): void => {
    const filters: BiquadFilterNode[] = createEqualizerFilters(createFakeContext());

    applyEqualizerGains(filters, [6, 6, 6, 6, 6, 6, 6, 6, 6, 6], false);

    expect(filters.every((f: BiquadFilterNode): boolean => f.gain.value === 0)).toBe(true);
  });

  it('clamps out-of-range gains rather than passing them through', (): void => {
    const filters: BiquadFilterNode[] = createEqualizerFilters(createFakeContext());

    applyEqualizerGains(filters, [99, -99, 0, 0, 0, 0, 0, 0, 0, 0], true);

    expect(filters[0].gain.value).toBe(EQ_GAIN_MAX);
    expect(filters[1].gain.value).toBe(EQ_GAIN_MIN);
  });

  it('treats missing bands as flat', (): void => {
    const filters: BiquadFilterNode[] = createEqualizerFilters(createFakeContext());

    applyEqualizerGains(filters, [4], true);

    expect(filters[0].gain.value).toBe(4);
    expect(filters.slice(1).every((f: BiquadFilterNode): boolean => f.gain.value === 0)).toBe(true);
  });
});

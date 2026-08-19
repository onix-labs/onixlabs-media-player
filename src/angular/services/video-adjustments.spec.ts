/**
 * @fileoverview Tests for the video-adjustments normalizer and CSS filter builder.
 *
 * normalizeAdjustments is the defence against malformed persisted settings;
 * buildVideoFilter's exact output string is what the video element gets, so
 * the mapping from -100..100 to CSS multipliers is pinned here.
 *
 * @module app/services/video-adjustments.spec
 */

import {
  VIDEO_ADJ_LEVEL_MIN,
  VIDEO_ADJ_LEVEL_MAX,
  VIDEO_ADJ_HUE_MIN,
  VIDEO_ADJ_HUE_MAX,
  VIDEO_ADJ_EFFECT_MIN,
  VIDEO_ADJ_EFFECT_MAX,
  VIDEO_ADJ_CUSTOM_PRESET,
  VIDEO_ADJUSTMENT_PRESETS,
  VIDEO_ADJUSTMENT_CONTROLS,
  NEUTRAL_VIDEO_ADJUSTMENTS,
  normalizeAdjustments,
  buildVideoFilter,
  type VideoAdjustmentValues,
} from './video-adjustments';

describe('normalizeAdjustments', (): void => {
  it('returns neutral values for null', (): void => {
    expect(normalizeAdjustments(null)).toEqual(NEUTRAL_VIDEO_ADJUSTMENTS);
  });

  it('returns neutral values for undefined', (): void => {
    expect(normalizeAdjustments(undefined)).toEqual(NEUTRAL_VIDEO_ADJUSTMENTS);
  });

  it('fills missing fields with neutral values', (): void => {
    expect(normalizeAdjustments({brightness: 10})).toEqual({
      ...NEUTRAL_VIDEO_ADJUSTMENTS,
      brightness: 10,
    });
  });

  it('preserves valid in-range values', (): void => {
    const values: VideoAdjustmentValues = {
      brightness: 10, contrast: -20, saturation: 30, hue: -90,
      blur: 40, grayscale: 50, sepia: 60, invert: true,
    };

    expect(normalizeAdjustments(values)).toEqual(values);
  });

  it('clamps levels to their range', (): void => {
    const result: VideoAdjustmentValues = normalizeAdjustments({
      brightness: 999, contrast: -999, saturation: 999,
    });

    expect(result.brightness).toBe(VIDEO_ADJ_LEVEL_MAX);
    expect(result.contrast).toBe(VIDEO_ADJ_LEVEL_MIN);
    expect(result.saturation).toBe(VIDEO_ADJ_LEVEL_MAX);
  });

  it('clamps hue to its wider range', (): void => {
    expect(normalizeAdjustments({hue: 999}).hue).toBe(VIDEO_ADJ_HUE_MAX);
    expect(normalizeAdjustments({hue: -999}).hue).toBe(VIDEO_ADJ_HUE_MIN);
  });

  it('clamps effects to 0..100', (): void => {
    const result: VideoAdjustmentValues = normalizeAdjustments({
      blur: 999, grayscale: -50, sepia: 999,
    });

    expect(result.blur).toBe(VIDEO_ADJ_EFFECT_MAX);
    expect(result.grayscale).toBe(VIDEO_ADJ_EFFECT_MIN);
    expect(result.sepia).toBe(VIDEO_ADJ_EFFECT_MAX);
  });

  it('replaces NaN and Infinity with zero', (): void => {
    const result: VideoAdjustmentValues = normalizeAdjustments({
      brightness: NaN, contrast: Infinity, saturation: -Infinity,
    });

    expect(result.brightness).toBe(0);
    // Infinity is not finite, so it becomes 0 rather than clamping to the max.
    expect(result.contrast).toBe(0);
    expect(result.saturation).toBe(0);
  });

  it('replaces non-numeric values with zero', (): void => {
    const malformed: Partial<VideoAdjustmentValues> = {
      brightness: '50', contrast: null, saturation: {},
    } as unknown as Partial<VideoAdjustmentValues>;

    const result: VideoAdjustmentValues = normalizeAdjustments(malformed);

    expect(result.brightness).toBe(0);
    expect(result.contrast).toBe(0);
    expect(result.saturation).toBe(0);
  });

  it('coerces invert strictly, accepting only true', (): void => {
    expect(normalizeAdjustments({invert: true}).invert).toBe(true);
    expect(normalizeAdjustments({invert: false}).invert).toBe(false);
    expect(normalizeAdjustments({invert: 1 as unknown as boolean}).invert).toBe(false);
    expect(normalizeAdjustments({invert: 'true' as unknown as boolean}).invert).toBe(false);
  });
});

describe('buildVideoFilter', (): void => {
  it('returns none when disabled', (): void => {
    expect(buildVideoFilter(NEUTRAL_VIDEO_ADJUSTMENTS, false)).toBe('none');
  });

  it('returns none when disabled even with non-neutral values', (): void => {
    const values: VideoAdjustmentValues = {...NEUTRAL_VIDEO_ADJUSTMENTS, brightness: 50};

    expect(buildVideoFilter(values, false)).toBe('none');
  });

  it('maps neutral values to an identity filter', (): void => {
    expect(buildVideoFilter(NEUTRAL_VIDEO_ADJUSTMENTS, true)).toBe(
      'brightness(1) contrast(1) saturate(1) hue-rotate(0deg) blur(0px) grayscale(0) sepia(0) invert(0)'
    );
  });

  it('maps levels symmetrically around 1', (): void => {
    const boosted: VideoAdjustmentValues = {...NEUTRAL_VIDEO_ADJUSTMENTS, brightness: 100};
    const cut: VideoAdjustmentValues = {...NEUTRAL_VIDEO_ADJUSTMENTS, brightness: -100};

    expect(buildVideoFilter(boosted, true)).toContain('brightness(2)');
    expect(buildVideoFilter(cut, true)).toContain('brightness(0)');
  });

  it('maps soften 0..100 onto a 0..10px blur', (): void => {
    const values: VideoAdjustmentValues = {...NEUTRAL_VIDEO_ADJUSTMENTS, blur: 100};

    expect(buildVideoFilter(values, true)).toContain('blur(10px)');
  });

  it('maps effects onto 0..1 fractions', (): void => {
    const values: VideoAdjustmentValues = {...NEUTRAL_VIDEO_ADJUSTMENTS, grayscale: 100, sepia: 50};

    const filter: string = buildVideoFilter(values, true);

    expect(filter).toContain('grayscale(1)');
    expect(filter).toContain('sepia(0.5)');
  });

  it('passes hue through in degrees', (): void => {
    const values: VideoAdjustmentValues = {...NEUTRAL_VIDEO_ADJUSTMENTS, hue: -180};

    expect(buildVideoFilter(values, true)).toContain('hue-rotate(-180deg)');
  });

  it('renders invert as a 0/1 toggle', (): void => {
    expect(buildVideoFilter({...NEUTRAL_VIDEO_ADJUSTMENTS, invert: true}, true)).toContain('invert(1)');
    expect(buildVideoFilter(NEUTRAL_VIDEO_ADJUSTMENTS, true)).toContain('invert(0)');
  });

  it('emits the filter functions in a fixed order', (): void => {
    const values: VideoAdjustmentValues = {
      brightness: 10, contrast: 20, saturation: 30, hue: 40,
      blur: 50, grayscale: 60, sepia: 70, invert: true,
    };

    expect(buildVideoFilter(values, true)).toBe(
      'brightness(1.1) contrast(1.2) saturate(1.3) hue-rotate(40deg) blur(5px) grayscale(0.6) sepia(0.7) invert(1)'
    );
  });
});

describe('VIDEO_ADJUSTMENT_PRESETS', (): void => {
  it('gives every non-custom preset a full value set', (): void => {
    for (const preset of VIDEO_ADJUSTMENT_PRESETS) {
      if (preset.value === VIDEO_ADJ_CUSTOM_PRESET) continue;
      expect(preset.values, preset.value).not.toBeNull();
    }
  });

  it('carries no values for the custom preset', (): void => {
    const custom: {values: VideoAdjustmentValues | null} | undefined = VIDEO_ADJUSTMENT_PRESETS.find(
      (p: {value: string}): boolean => p.value === VIDEO_ADJ_CUSTOM_PRESET
    );

    expect(custom?.values).toBeNull();
  });

  it('survives normalization unchanged, so no preset is out of range', (): void => {
    for (const preset of VIDEO_ADJUSTMENT_PRESETS) {
      if (!preset.values) continue;
      expect(normalizeAdjustments(preset.values), preset.value).toEqual(preset.values);
    }
  });

  it('has unique preset identifiers', (): void => {
    const values: string[] = VIDEO_ADJUSTMENT_PRESETS.map((p: {value: string}): string => p.value);

    expect(new Set(values).size).toBe(values.length);
  });
});

describe('VIDEO_ADJUSTMENT_CONTROLS', (): void => {
  it('declares a range matching each control kind', (): void => {
    for (const control of VIDEO_ADJUSTMENT_CONTROLS) {
      if (control.key === 'hue') {
        expect(control.min).toBe(VIDEO_ADJ_HUE_MIN);
        expect(control.max).toBe(VIDEO_ADJ_HUE_MAX);
      } else if (control.key === 'blur' || control.key === 'grayscale' || control.key === 'sepia') {
        expect(control.min, control.key).toBe(VIDEO_ADJ_EFFECT_MIN);
        expect(control.max, control.key).toBe(VIDEO_ADJ_EFFECT_MAX);
      } else {
        expect(control.min, control.key).toBe(VIDEO_ADJ_LEVEL_MIN);
        expect(control.max, control.key).toBe(VIDEO_ADJ_LEVEL_MAX);
      }
    }
  });

  it('covers every adjustable field except the invert toggle', (): void => {
    const keys: string[] = VIDEO_ADJUSTMENT_CONTROLS.map((c: {key: string}): string => c.key);
    const fields: string[] = Object.keys(NEUTRAL_VIDEO_ADJUSTMENTS).filter((k: string): boolean => k !== 'invert');

    expect(new Set(keys)).toEqual(new Set(fields));
  });
});

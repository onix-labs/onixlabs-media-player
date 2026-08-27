/**
 * @fileoverview The Windows Media Player "Ambience" visualization bank.
 *
 * Ambience is registered in `wmp.dll` under CLSID `{9CA6AD35-A548-4c7b-8E0A-
 * EF29748FAA16}` and carries the internal codename "Assault". Its
 * `IWMPEffects::GetPresetCount` returns fourteen; preset zero is the shuffler,
 * which reseeds the C runtime and picks another preset, so the thirteen that
 * actually draw something are the thirteen visualizations below.
 *
 * Where Battery warps analytically every frame, Ambience precomputes a
 * displacement table - for each destination pixel, the index of the pixel it
 * pulls its colour from - and reuses it. Each preset installs one or two of
 * these fields. The nine builder routines are all the same shape of maths as
 * the Battery shifts, so they live in {@link WARP_BODIES} alongside them and
 * this bank is the same engine with different data.
 *
 * The angles and radial rates below are the float constants each preset's setup
 * routine loads, read out of the DLL. Every preset has two orientations,
 * selected by a flag the engine sets when the effect starts; the unflipped
 * branch is the one taken here so that a given entry always turns the same way.
 *
 * Two things could not be recovered. The display names live in `wmploc.dll`,
 * which is not part of this repository, so the names here describe what each
 * preset does rather than reproducing Microsoft's wording. The palette builder
 * takes a style id per index range - those ids are the DLL's, the colours they
 * expand to are chosen here.
 *
 * @module app/components/audio/audio-outlet/visualizations/ambience-bank-visualization
 */

import {Visualization, VisualizationConfig} from './visualization';
import {
  FeedbackSpec,
  GeneratorStage,
  feedbackVisualization,
  parseGeneratorStage,
  parsePalette,
  rampPalette,
} from './wmp-feedback-engine';

/** The category all Ambience presets are filed under. */
const AMBIENCE_CATEGORY: string = 'Ambience';

// ============================================================================
// Palettes
// ============================================================================

/**
 * Colour stops per palette style id.
 *
 * Each preset's setup calls the engine's gradient builder with one or two
 * `(firstIndex, lastIndex, styleId)` triples. The style ids are recorded in
 * {@link AmbiencePreset.styles}; the colours each expands to are chosen here,
 * since the builder itself was not reversed. Presets that share a style share a
 * family, which is the grouping the DLL implies.
 */
const STYLE_STOPS: Readonly<Record<number, readonly string[]>> = {
  0: ['000000', '4A4A4A', 'B4B4B4', 'FFFFFF'],
  1: ['041028', '0E5A9E', '3FB8E8', 'BFF0FF', 'FFFFFF'],
  2: ['12042A', '5A1A96', 'C25FE8', 'F0D0FF', 'FFFFFF'],
  3: ['04180E', '1C7A4A', '6FE0A0', 'D8FFE8', 'FFFFFF'],
  4: ['02141E', '0A5E70', '2FC0CE', 'CFF8FF', 'FFFFFF'],
  5: ['1E0800', '8E3808', 'E89428', 'FFDC9A', 'FFFFFF'],
  8: ['1A1200', '8E6C08', 'E8C038', 'FFEEB0', 'FFFFFF'],
};

/** Stops used when a preset names a style with no entry above. */
const FALLBACK_STOPS: readonly string[] = STYLE_STOPS[0];

// ============================================================================
// Presets
// ============================================================================

/** One displacement field installed by a preset. */
interface AmbienceField {
  /** Key into {@link WARP_BODIES}, always one of the `Ambience*` entries. */
  readonly warp: string;

  /** Angular rate, in radians per frame. */
  readonly angle: number;

  /** Radial rate, in surface pixels per frame. Zero where unused. */
  readonly radial: number;

  /**
   * Third parameter. The sectored field reads it as a sector count, the ripple
   * as how much its bands widen with radius; every other field ignores it.
   */
  readonly extra: number;
}

/** One Ambience preset. */
interface AmbiencePreset {
  /** Visualization type id. */
  readonly id: string;

  /** Display name; descriptive, see the file header. */
  readonly name: string;

  /** The preset's index in the DLL, for anyone comparing against it. */
  readonly index: number;

  /** The field or fields the preset installs. */
  readonly fields: readonly AmbienceField[];

  /** Palette style ids the setup routine passes to the gradient builder. */
  readonly styles: readonly number[];

  /**
   * The argument the setup routine passes to the engine's content selector.
   * One draws a ring, zero draws along the edge.
   */
  readonly mode: number;

  /** Generators drawn after the warp, overriding the mode's default. */
  readonly post?: readonly string[];
}

/** Angular rate shared by the spiral and the flow presets. */
const RATE_SEVEN: number = 0.07;

/** Angular rate of the counter-rotating pair. */
const RATE_FOUR: number = 0.04;

/** Angular rate of the slipstream and weave presets. */
const RATE_THREE: number = 0.03;

/** Angular rate of the shear and breath presets. */
const RATE_FIVE: number = 0.05;

/** Angular rate of the petal pair. */
const RATE_EIGHT: number = 0.08;

/** Angular rate of the outward bloom. */
const RATE_TWO: number = 0.02;

/** Angular rate of the ripple, the slowest in the bank. */
const RATE_RIPPLE: number = -0.005;

/** Angular rate of the quarter-width twist. */
const RATE_TWIST: number = 0.2;

/** Radial rate expressed as a fraction of the surface width. */
const RADIAL_WIDTH_LARGE: number = 0.05;

/** A smaller fraction of the surface width. */
const RADIAL_WIDTH_MID: number = 0.04;

/** The smallest radial fraction of the surface width. */
const RADIAL_WIDTH_SMALL: number = 0.01;

/** Band width of the ripple, as a fraction of the surface height. */
const RADIAL_HEIGHT_BAND: number = 0.1;

/**
 * How much the ripple's bands widen with radius.
 *
 * Zero leaves them evenly spaced, which is how the displacement builder has
 * them. At this value the outermost band is a quarter wider than the innermost:
 * enough that each ring reads as slightly fatter than the one inside it,
 * without the outer ones swallowing the frame.
 */
const RIPPLE_FLARE: number = 0.25;

/** How much each pixel takes from its neighbours per step: the smoke. */
const AMBIENCE_DIFFUSE: number = 0.35;

/**
 * Angle the smoke's tangential taps sit away, in radians.
 *
 * A mark survives a few dozen steps against the decay, and the spread compounds
 * as a walk over those, so this lands the fan around 40 degrees either side of
 * where it was drawn.
 */
const AMBIENCE_SMOKE_ARC: number = 0.08;

/** Ambience takes a bass hit as a cue to pulse. */
const AMBIENCE_PULSES: boolean = true;

/** Sector count of the petal pair, as a fraction of the surface height. */
const PETAL_SECTOR_SCALE: number = 0.1;

/** Cubic zoom coefficients of the rush preset, as fractions of the height. */
const RUSH_INNER: number = 0.025;
const RUSH_OUTER: number = 0.06;

/** One pixel per frame, the spiral's radial rate. */
const ONE_PIXEL: number = 1;

/** Nominal surface width the fractional rates above are resolved against. */
const NOMINAL_WIDTH: number = 512;

/** Nominal surface height, matching the engine's own internal surface. */
const NOMINAL_HEIGHT: number = 384;

/** Content selector value that draws a ring. */
const MODE_RING: number = 1;

/** Content selector value that draws along the edge. */
const MODE_EDGE: number = 0;

/**
 * The thirteen drawing presets, in the order `SetCurrentPreset` dispatches
 * them. Index zero, the shuffler, is deliberately absent.
 */
const AMBIENCE_PRESETS: readonly AmbiencePreset[] = [
  {
    id: 'ambience-vortex',
    name: 'Vortex',
    index: 1,
    fields: [{warp: 'AmbienceSpiral', angle: RATE_SEVEN, radial: ONE_PIXEL, extra: 0}],
    styles: [4, 2],
    mode: MODE_RING,
  },
  {
    id: 'ambience-undertow',
    name: 'Undertow',
    index: 2,
    fields: [{
      warp: 'AmbienceFlow',
      angle: -RATE_SEVEN,
      radial: NOMINAL_WIDTH * RADIAL_WIDTH_LARGE,
      extra: 0,
    }],
    styles: [1],
    mode: MODE_EDGE,
  },
  {
    id: 'ambience-counterspin',
    name: 'Counterspin',
    index: 3,
    fields: [
      {warp: 'AmbienceFlow', angle: RATE_FOUR, radial: NOMINAL_WIDTH * RADIAL_WIDTH_LARGE, extra: 0},
      {warp: 'AmbienceFlow', angle: -RATE_FOUR, radial: NOMINAL_WIDTH * RADIAL_WIDTH_LARGE, extra: 0},
    ],
    styles: [2],
    mode: MODE_RING,
  },
  {
    id: 'ambience-shear',
    name: 'Shear',
    index: 4,
    fields: [{
      warp: 'AmbienceShear',
      angle: -RATE_FIVE,
      radial: -NOMINAL_WIDTH * RADIAL_WIDTH_SMALL,
      extra: 0,
    }],
    styles: [2],
    mode: MODE_RING,
  },
  {
    id: 'ambience-ripple',
    name: 'Ripple',
    index: 5,
    fields: [{
      warp: 'AmbienceRipple',
      angle: RATE_RIPPLE,
      radial: NOMINAL_HEIGHT * RADIAL_HEIGHT_BAND,
      extra: RIPPLE_FLARE,
    }],
    styles: [1],
    mode: MODE_RING,
    // The horizontal trace, drawn the way Warp draws its own: a soft glowing
    // band about the waveform rather than a stroke along it.
    post: ['Trace 1 0 0 0'],
  },
  {
    id: 'ambience-plunge',
    name: 'Plunge',
    index: 6,
    fields: [{warp: 'AmbiencePinch', angle: 0, radial: 0, extra: 0}],
    styles: [2],
    mode: MODE_RING,
  },
  {
    id: 'ambience-breath',
    name: 'Breath',
    index: 7,
    fields: [
      {warp: 'AmbienceSuck', angle: -RATE_FIVE, radial: 0, extra: 0},
      {warp: 'AmbienceSuck', angle: RATE_FIVE, radial: 0, extra: 0},
    ],
    styles: [8, 1],
    mode: MODE_RING,
  },
  {
    id: 'ambience-slipstream',
    name: 'Slipstream',
    index: 8,
    fields: [{
      warp: 'AmbienceFlow',
      angle: -RATE_THREE,
      radial: NOMINAL_WIDTH * RADIAL_WIDTH_MID,
      extra: 0,
    }],
    styles: [3],
    mode: MODE_RING,
  },
  {
    id: 'ambience-rush',
    name: 'Rush',
    index: 9,
    fields: [{
      warp: 'AmbienceZoomCubic',
      angle: NOMINAL_HEIGHT * RUSH_INNER,
      radial: NOMINAL_HEIGHT * RUSH_OUTER,
      extra: 0,
    }],
    styles: [5],
    mode: MODE_EDGE,
  },
  {
    id: 'ambience-petals',
    name: 'Petals',
    index: 10,
    fields: [
      {
        warp: 'AmbiencePetal',
        angle: -RATE_EIGHT,
        radial: ONE_PIXEL,
        extra: NOMINAL_HEIGHT * PETAL_SECTOR_SCALE,
      },
      {
        warp: 'AmbiencePetal',
        angle: RATE_EIGHT,
        radial: ONE_PIXEL,
        extra: NOMINAL_HEIGHT * PETAL_SECTOR_SCALE,
      },
    ],
    styles: [2],
    mode: MODE_RING,
  },
  {
    id: 'ambience-weave',
    name: 'Weave',
    index: 11,
    fields: [
      {warp: 'AmbienceFlow', angle: RATE_THREE, radial: NOMINAL_WIDTH * RADIAL_WIDTH_SMALL, extra: 0},
      {warp: 'AmbienceFlow', angle: -RATE_THREE, radial: NOMINAL_WIDTH * RADIAL_WIDTH_SMALL, extra: 0},
    ],
    styles: [2],
    mode: MODE_RING,
  },
  {
    id: 'ambience-bloom',
    name: 'Bloom',
    index: 12,
    fields: [{
      warp: 'AmbienceFlow',
      angle: RATE_TWO,
      radial: -NOMINAL_WIDTH * RADIAL_WIDTH_SMALL,
      extra: 0,
    }],
    styles: [0],
    mode: MODE_EDGE,
  },
  {
    id: 'ambience-whirl',
    name: 'Whirl',
    index: 13,
    fields: [{
      warp: 'AmbienceTwist',
      angle: RATE_TWIST,
      radial: NOMINAL_WIDTH / 8,
      extra: 0,
    }],
    styles: [1],
    mode: MODE_RING,
  },
];

// ============================================================================
// Assembly
// ============================================================================

/** Generators used when a preset's content selector asks for a ring. */
const RING_GENERATORS: readonly string[] = ['CircleWaveform 1 1 0.5 0'];

/** Generators used when a preset's content selector asks for edge content. */
const EDGE_GENERATORS: readonly string[] = ['SpectrumEdge 40 0 0 0'];

/** Drawn after the warp in every preset, so the trace stays legible. */
const OVERLAY_GENERATORS: readonly string[] = ['EdgeTrace 55 0 0 0'];

/**
 * Expands a preset's palette style ids into a 256-entry ramp.
 *
 * A preset naming two styles gets both, in order, which mirrors the two index
 * ranges its setup routine fills.
 *
 * @param styles - The style ids the preset passes to the gradient builder
 * @returns 1536 hex characters
 */
function paletteFor(styles: readonly number[]): string {
  const stops: string[] = [];
  for (const style of styles) {
    stops.push(...(STYLE_STOPS[style] ?? FALLBACK_STOPS));
  }
  return rampPalette(stops.length >= 2 ? stops : FALLBACK_STOPS);
}

/**
 * Turns a preset into a spec the engine can run.
 *
 * A preset installing two fields is run as its first field; the engine here
 * warps analytically rather than through a precomputed table, and compositing
 * two analytic warps per frame is not what the original did either - it
 * alternated between the two tables. The second field's parameters stay in the
 * table above so the difference is visible to anyone reading it.
 *
 * @param preset - One entry of {@link AMBIENCE_PRESETS}
 * @returns The engine spec for that preset
 */
function toSpec(preset: AmbiencePreset): FeedbackSpec {
  const field: AmbienceField = preset.fields[0];
  const sources: readonly string[] =
    preset.mode === MODE_RING ? RING_GENERATORS : EDGE_GENERATORS;

  return {
    name: preset.name,
    category: AMBIENCE_CATEGORY,
    warp: field.warp,
    warpArgs: [field.angle, field.radial, field.extra, 0],
    pre: sources.map((entry: string): GeneratorStage => parseGeneratorStage(entry)),
    post: (preset.post ?? OVERLAY_GENERATORS).map(
      (entry: string): GeneratorStage => parseGeneratorStage(entry)
    ),
    palette: parsePalette(paletteFor(preset.styles)),
    diffuse: AMBIENCE_DIFFUSE,
    smokeArc: AMBIENCE_SMOKE_ARC,
    pulses: AMBIENCE_PULSES,
  };
}

/** Type id to constructor, for the visualization factory. */
export const AMBIENCE_BANK_CONSTRUCTORS: Readonly<
  Record<string, new (config: VisualizationConfig) => Visualization>
> = Object.fromEntries(
  AMBIENCE_PRESETS.map(
    (preset: AmbiencePreset): [string, new (config: VisualizationConfig) => Visualization] =>
      [preset.id, feedbackVisualization(toSpec(preset))]
  )
);

/** Type ids in preset order. */
export const AMBIENCE_BANK_TYPES: readonly string[] =
  AMBIENCE_PRESETS.map((preset: AmbiencePreset): string => preset.id);

/** Display metadata for the menus and the settings list. */
export const AMBIENCE_BANK_METADATA: readonly {
  readonly id: string;
  readonly name: string;
  readonly category: string;
}[] = AMBIENCE_PRESETS.map(
  (preset: AmbiencePreset): {id: string; name: string; category: string} =>
    ({id: preset.id, name: preset.name, category: AMBIENCE_CATEGORY})
);

/** One-line descriptions for the settings dropdown. */
export const AMBIENCE_BANK_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'ambience-vortex': 'Steady rotation drawing the surface into the centre',
  'ambience-undertow': 'Counter-rotation with the pull strongest at the rim',
  'ambience-counterspin': 'Rotating inflow, wound the opposite way at each radius',
  'ambience-shear': 'Rotation that grows with the radius, spreading outward',
  'ambience-ripple': 'Radius folded into bands, standing as concentric rings',
  'ambience-plunge': 'Cubic zoom into the centre with no rotation at all',
  'ambience-slipstream': 'A slower rotating inflow, graded across the surface',
  'ambience-breath': 'Sixth-order falloff, so only the middle of the frame moves',
  'ambience-rush': 'Cubic zoom driven hard, with the spectrum along the edge',
  'ambience-petals': 'Inflow with the angle stepped into sectors',
  'ambience-weave': 'The gentlest of the rotating inflows',
  'ambience-bloom': 'Rotating outflow, opening from the centre',
  'ambience-whirl': 'Quarter-width falloff twisting radius and angle together',
};

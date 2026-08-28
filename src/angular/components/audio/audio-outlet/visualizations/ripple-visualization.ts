/**
 * @fileoverview Ripple - concentric standing rings in a feedback surface.
 *
 * The surface is warped into itself every frame. Ripple's warp quantises the
 * radius into bands and pulls each pixel back toward the band it sits in,
 * which is what stacks the frame into rings: the rings themselves hold still
 * while everything drawn into the surface drifts out through them.
 *
 * A circular waveform is drawn before the warp, so the audio is carried
 * outward by the fold rather than sitting on top of it, and a soft glowing
 * band about the waveform is drawn after it, the way Warp draws its own trace.
 *
 * The warp, the generators and the palette ramp all belong to the feedback
 * engine; what this file holds is the handful of numbers that make Ripple the
 * shape it is.
 *
 * @module app/components/audio/audio-outlet/visualizations/ripple-visualization
 */

import {Visualization, VisualizationConfig} from './visualization';
import {
  FeedbackSpec,
  GeneratorStage,
  feedbackVisualization,
  parseGeneratorStage,
  parsePalette,
  rampPalette,
} from './feedback-engine';

/**
 * Type id.
 *
 * Kept as it was when Ripple was one of a bank of thirteen, so that a saved
 * setting naming it still resolves.
 */
export const RIPPLE_TYPE: string = 'ambience-ripple';

/** Filed with Twirl, Warp, Pulsar and Hallucia. */
const RIPPLE_CATEGORY: string = 'Nostalgia';

/** Colour stops the palette ramp is built from: deep blue up through white. */
const RIPPLE_STOPS: readonly string[] = ['041028', '0E5A9E', '3FB8E8', 'BFF0FF', 'FFFFFF'];

/** Angular rate, in radians per frame. The slowest turn in the suite. */
const RATE_RIPPLE: number = -0.015;

/** Nominal surface height, matching the engine's own internal surface. */
const NOMINAL_HEIGHT: number = 256;

/** Band width, as a fraction of the surface height. */
const RADIAL_HEIGHT_BAND: number = 0.1;

/**
 * How much the bands widen with radius.
 *
 * Zero leaves them evenly spaced, which is how the warp has them. At this
 * value the outermost band is a quarter wider than the innermost: enough that
 * each ring reads as slightly fatter than the one inside it, without the outer
 * ones swallowing the frame.
 */
const RIPPLE_FLARE: number = 0.25;

/** How much each pixel takes from its neighbours per step: the smoke. */
const RIPPLE_DIFFUSE: number = 0.5;

/**
 * How far those neighbours sit, in pixels.
 *
 * At one pixel the smoke could only creep, however much of the neighbour was
 * taken. Reaching further is what gives it depth, and it compounds: three
 * pixels a step over the few dozen steps a mark survives is a wide haze.
 */
const RIPPLE_DIFFUSE_REACH: number = 1;

/** Ripple takes a bass hit as a cue to pulse. */
const RIPPLE_PULSES: boolean = false;

/** Drawn before the warp, so the trace is folded outward with the surface. */
const RIPPLE_PRE: readonly string[] = ['CircleWaveform 0 0 0.5 0'];

/** Drawn after the warp: a soft glowing band about the waveform, not a stroke. */
const RIPPLE_POST: readonly string[] = ['Trace 0.3 0 0 0'];

/** The spec the engine runs. */
const RIPPLE_SPEC: FeedbackSpec = {
  name: 'Ripple',
  category: RIPPLE_CATEGORY,
  warp: 'RippleWarp',
  warpArgs: [RATE_RIPPLE, NOMINAL_HEIGHT * RADIAL_HEIGHT_BAND, RIPPLE_FLARE, 0],
  pre: RIPPLE_PRE.map((entry: string): GeneratorStage => parseGeneratorStage(entry)),
  post: RIPPLE_POST.map((entry: string): GeneratorStage => parseGeneratorStage(entry)),
  palette: parsePalette(rampPalette(RIPPLE_STOPS)),
  diffuse: RIPPLE_DIFFUSE,
  diffuseReach: RIPPLE_DIFFUSE_REACH,
  pulses: RIPPLE_PULSES,
};

/** Display metadata for the menus and the settings list. */
export const RIPPLE_METADATA: {readonly id: string; readonly name: string; readonly category: string} =
  {id: RIPPLE_TYPE, name: 'Ripple', category: RIPPLE_CATEGORY};

/** One-line description for the settings dropdown. */
export const RIPPLE_DESCRIPTION: string = 'Radius folded into bands, standing as concentric rings';

/** Ripple, built on the feedback engine. */
export const RippleVisualization: new (config: VisualizationConfig) => Visualization =
  feedbackVisualization(RIPPLE_SPEC);

/**
 * @fileoverview Battery visualization - randomised generator and displacement.
 *
 * A re-implementation, from behavioural analysis, of the Windows Media Player
 * "Battery" visualization. Nothing here is derived from Microsoft source or
 * object code.
 *
 * Battery is unusual among the shipping collections. Where Ambience carries
 * fourteen named presets and Alchemy eleven, Battery has exactly one, and its
 * own description says what it does:
 *
 *   #1563  Battery
 *   #1564  "This collection includes a random setting that always shows a
 *           unique visualization."
 *   #1565  Randomization
 *
 * So Battery is not a preset at all - it is a dice roll. The binary carries
 * two independent banks of classes: the displacements that Ambience draws on
 * (fourteen of them), and a second bank of source generators - CWaveEdge,
 * CSpectrumEdge, CCircleWaveform, CEdgeGradiant, CCosEdgeGradiant, CEdgeTrace,
 * CDotPlane, CGalaxy, CJDar, CJiggyScribble - each an independently creatable
 * COM object with its own creator thunk. Pairing one generator with one
 * displacement is what makes every viewing "unique".
 *
 * This therefore shares Ambience's engine wholesale and differs only in that
 * it re-rolls both halves of the pair, rather than holding one displacement
 * and re-drawing only its parameters.
 *
 * A note on fidelity: the generator class *names* are recovered from the
 * binary, but their internals were not decoded. What each one draws is an
 * original reading of its name. The displacement half is the faithful part.
 *
 * @module app/components/audio/audio-outlet/visualizations/battery-visualization
 */

import {AmbienceVisualization, ShiftMode, GeneratorMode} from './ambience-visualization';
import {VisualizationConfig} from './visualization';

/** Per-frame multiplier applied to the previous frame. */
const BATTERY_DECAY: number = 0.978;

/** Starting hue for the injected trace, in degrees. */
const BATTERY_START_HUE: number = 220;

/** Hue rotation per frame, in degrees. */
const BATTERY_HUE_DRIFT: number = 0.45;

/**
 * Battery - Randomization.
 *
 * Re-rolls the displacement, the source generator and every parameter on each
 * randomise tick, so no two stretches look alike.
 */
export class BatteryRandomizationVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Randomization',
      // Seed values only; randomiseAll replaces both on the first tick.
      shift: ShiftMode.Swirl,
      generator: GeneratorMode.WaveEdge,
      decay: BATTERY_DECAY,
      startHue: BATTERY_START_HUE,
      hueDrift: BATTERY_HUE_DRIFT,
      randomiseAll: true,
      category: 'Battery',
    });
  }
}

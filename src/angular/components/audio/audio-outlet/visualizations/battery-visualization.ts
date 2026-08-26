/**
 * @fileoverview Battery visualizations - one per source generator.
 *
 * A re-implementation, from behavioural analysis, of the Windows Media Player
 * "Battery" visualization. Nothing here is derived from Microsoft source or
 * object code.
 *
 * Battery is unusual among the shipping collections. Where Ambience carries
 * fourteen named presets and Alchemy eleven, Battery registers exactly one,
 * and its own description says what it does:
 *
 *   #1563  Battery
 *   #1564  "This collection includes a random setting that always shows a
 *           unique visualization."
 *   #1565  Randomization
 *
 * So Battery is not a preset list - it is a dice roll. What it rolls is the
 * pairing of a *source generator* with a *displacement*. The binary carries
 * those as two independent banks: the displacements Ambience draws on, and a
 * second bank of generators, each with its own ATL creator thunk and a
 * six-slot vtable whose unique slots are randomise and render:
 *
 *   CWaveEdge  CSpectrumEdge  CCircleWaveform  CEdgeGradiant
 *   CCosEdgeGradiant  CEdgeTrace  CDotPlane  CJDar  CGalaxy
 *   CJiggyScribble
 *
 * Each generator is one visualization here, paired with a fixed displacement
 * chosen so the ten entries stay visually distinct from one another - and so
 * that every displacement in the bank is exercised somewhere across Ambience
 * and Battery together, rather than left as dead code in the shader.
 *
 * The engine rolls this pairing at random on every viewing, which is what
 * "Randomization" named. Fixing it is a deliberate departure: a chosen entry
 * that changes character on a timer is hard to sit with.
 *
 * The render methods take (BYTE* pLevels, surface), where pLevels is the
 * engine's level block: spectrum for both channels first, then waveform at
 * +0x800. CWaveEdge adds that offset conditionally, which is how one class
 * serves both a spectrum and a waveform edge.
 *
 * A note on fidelity. The class names, the vtable shape and the render
 * signature are recovered from the binary. The pixel-level internals of each
 * generator were not decoded, so what each one draws below is an original
 * reading of its name, informed by what its render method reaches for -
 * CJDar accumulating an angle from summed low bins, CJiggyScribble sampling
 * scattered bins to jitter a path. The displacement half of every pairing is
 * the faithful part.
 *
 * @module app/components/audio/audio-outlet/visualizations/battery-visualization
 */

import {
  AmbienceVisualization,
  ShiftMode,
  GeneratorMode,
  ZOOM_ANGLE_DELTA,
  ZOOM_RADIAL,
} from './ambience-visualization';
import {VisualizationConfig} from './visualization';

/** Per-frame multiplier applied to the previous frame. */
const BATTERY_DECAY: number = 0.978;

/** Hue rotation per frame, in degrees. */
const BATTERY_HUE_DRIFT: number = 0.45;

/** Battery - Wave Edge. Waveform trace, drawn through a rotating zoom. */
export class BatteryWaveEdgeVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Wave Edge',
      category: 'Battery',
      shift: ShiftMode.Zoom,
      generator: GeneratorMode.WaveEdge,
      decay: BATTERY_DECAY,
      startHue: 200,
      hueDrift: BATTERY_HUE_DRIFT,
      params: {angleDelta: ZOOM_ANGLE_DELTA, amplitude: ZOOM_RADIAL},
    });
  }
}










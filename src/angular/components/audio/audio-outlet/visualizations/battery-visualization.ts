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
  RINGSPIN_ANGLE_DELTA,
  RINGSPIN_RING_WIDTH,
  SWIRL_AMPLITUDE,
  SWIRL_FREQUENCY,
  EDGEFALLOFF_STRENGTH,
  EDGEFALLOFF_EDGE,
  TRIG_ANGLE_DELTA,
  TRIG_AMPLITUDE,
  TRIG_SUB_MODE,
  LINEAR_DRIFT_X,
  LINEAR_DRIFT_Y,
  TILE_SIZE,
  STARBURST_ANGLE_DELTA,
  STARBURST_AMPLITUDE,
  STARBURST_ARMS,
  THINGUS_ANGLE,
  THINGUS_RADIAL,
  SHIMMER_AMPLITUDE,
  SHIMMER_FREQUENCY,
  SHIMMER_SUB_MODE,
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

/** Battery - Spectrum Edge. Spectrum rising from the bottom edge, through concentric spinning rings. */
export class BatterySpectrumEdgeVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Spectrum Edge',
      category: 'Battery',
      shift: ShiftMode.RingSpin,
      generator: GeneratorMode.SpectrumEdge,
      decay: BATTERY_DECAY,
      startHue: 20,
      hueDrift: BATTERY_HUE_DRIFT,
      params: {angleDelta: RINGSPIN_ANGLE_DELTA, frequency: RINGSPIN_RING_WIDTH},
    });
  }
}

/** Battery - Circle Waveform. Waveform wrapped around a circle, through a sine ripple. */
export class BatteryCircleWaveformVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Circle Waveform',
      category: 'Battery',
      shift: ShiftMode.Swirl,
      generator: GeneratorMode.CircleWaveform,
      decay: BATTERY_DECAY,
      startHue: 280,
      hueDrift: BATTERY_HUE_DRIFT,
      params: {amplitude: SWIRL_AMPLITUDE, frequency: SWIRL_FREQUENCY},
    });
  }
}

/** Battery - Edge Gradiant. Gradient banked against an edge, sheared away from that edge. */
export class BatteryEdgeGradiantVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Edge Gradiant',
      category: 'Battery',
      shift: ShiftMode.EdgeFalloff,
      generator: GeneratorMode.EdgeGradiant,
      decay: BATTERY_DECAY,
      startHue: 340,
      hueDrift: BATTERY_HUE_DRIFT,
      params: {amplitude: EDGEFALLOFF_STRENGTH, subMode: EDGEFALLOFF_EDGE},
    });
  }
}

/** Battery - Cos Edge Gradiant. Rippled edge gradient, through a trigonometric perturbation. */
export class BatteryCosEdgeGradiantVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Cos Edge Gradiant',
      category: 'Battery',
      shift: ShiftMode.Trig,
      generator: GeneratorMode.CosEdgeGradiant,
      decay: BATTERY_DECAY,
      startHue: 300,
      hueDrift: BATTERY_HUE_DRIFT,
      params: {angleDelta: TRIG_ANGLE_DELTA, amplitude: TRIG_AMPLITUDE, subMode: TRIG_SUB_MODE},
    });
  }
}

/** Battery - Edge Trace. Rectified trace hugging the bottom edge, drifting diagonally. */
export class BatteryEdgeTraceVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Edge Trace',
      category: 'Battery',
      shift: ShiftMode.Linear,
      generator: GeneratorMode.EdgeTrace,
      decay: BATTERY_DECAY,
      startHue: 150,
      hueDrift: BATTERY_HUE_DRIFT,
      params: {driftX: LINEAR_DRIFT_X, driftY: LINEAR_DRIFT_Y},
    });
  }
}

/** Battery - Dot Plane. Grid of dots sized by the spectrum, wrapped into repeating tiles. */
export class BatteryDotPlaneVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Dot Plane',
      category: 'Battery',
      shift: ShiftMode.Tile,
      generator: GeneratorMode.DotPlane,
      decay: BATTERY_DECAY,
      startHue: 90,
      hueDrift: BATTERY_HUE_DRIFT,
      params: {amplitude: TILE_SIZE},
    });
  }
}

/** Battery - JDar. Radar sweep driven by the low bins, through radial arms. */
export class BatteryJDarVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'JDar',
      category: 'Battery',
      shift: ShiftMode.Starburst,
      generator: GeneratorMode.JDar,
      decay: BATTERY_DECAY,
      startHue: 120,
      hueDrift: BATTERY_HUE_DRIFT,
      params: {angleDelta: STARBURST_ANGLE_DELTA, amplitude: STARBURST_AMPLITUDE,
        frequency: STARBURST_ARMS},
    });
  }
}

/** Battery - Galaxy. Spiral arms brightened by the spectrum, offset in angle and radius. */
export class BatteryGalaxyVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Galaxy',
      category: 'Battery',
      shift: ShiftMode.Thingus,
      generator: GeneratorMode.Galaxy,
      decay: BATTERY_DECAY,
      startHue: 240,
      hueDrift: BATTERY_HUE_DRIFT,
      params: {amplitude: THINGUS_ANGLE, frequency: THINGUS_RADIAL},
    });
  }
}

/** Battery - Jiggy Scribble. Wandering scribble jittered by the waveform, through a sine shimmer. */
export class BatteryJiggyScribbleVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Jiggy Scribble',
      category: 'Battery',
      shift: ShiftMode.SinShimmer,
      generator: GeneratorMode.JiggyScribble,
      decay: BATTERY_DECAY,
      startHue: 40,
      hueDrift: BATTERY_HUE_DRIFT,
      params: {amplitude: SHIMMER_AMPLITUDE, frequency: SHIMMER_FREQUENCY, subMode: SHIMMER_SUB_MODE},
    });
  }
}

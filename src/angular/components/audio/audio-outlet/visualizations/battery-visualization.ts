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
 * Each generator is one visualization here, holding its generator fixed and
 * rolling only the displacement - so a given entry keeps its character while
 * never settling into one fixed field.
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

import {AmbienceVisualization, ShiftMode, GeneratorMode} from './ambience-visualization';
import {VisualizationConfig} from './visualization';

/** Per-frame multiplier applied to the previous frame. */
const BATTERY_DECAY: number = 0.978;

/** Hue rotation per frame, in degrees. */
const BATTERY_HUE_DRIFT: number = 0.45;

/** Battery - Wave Edge. Waveform trace drawn across the surface. */
export class BatteryWaveEdgeVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Wave Edge',
      category: 'Battery',
      // Seed only; the displacement is re-rolled on every randomise tick.
      shift: ShiftMode.Swirl,
      generator: GeneratorMode.WaveEdge,
      decay: BATTERY_DECAY,
      startHue: 200,
      hueDrift: BATTERY_HUE_DRIFT,
      randomiseDisplacement: true,
    });
  }
}

/** Battery - Spectrum Edge. Frequency spectrum rising from the bottom edge. */
export class BatterySpectrumEdgeVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Spectrum Edge',
      category: 'Battery',
      // Seed only; the displacement is re-rolled on every randomise tick.
      shift: ShiftMode.Swirl,
      generator: GeneratorMode.SpectrumEdge,
      decay: BATTERY_DECAY,
      startHue: 20,
      hueDrift: BATTERY_HUE_DRIFT,
      randomiseDisplacement: true,
    });
  }
}

/** Battery - Circle Waveform. Waveform wrapped around a circle. */
export class BatteryCircleWaveformVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Circle Waveform',
      category: 'Battery',
      // Seed only; the displacement is re-rolled on every randomise tick.
      shift: ShiftMode.Swirl,
      generator: GeneratorMode.CircleWaveform,
      decay: BATTERY_DECAY,
      startHue: 280,
      hueDrift: BATTERY_HUE_DRIFT,
      randomiseDisplacement: true,
    });
  }
}

/** Battery - Edge Gradiant. Amplitude-modulated gradient banked against an edge. */
export class BatteryEdgeGradiantVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Edge Gradiant',
      category: 'Battery',
      // Seed only; the displacement is re-rolled on every randomise tick.
      shift: ShiftMode.Swirl,
      generator: GeneratorMode.EdgeGradiant,
      decay: BATTERY_DECAY,
      startHue: 340,
      hueDrift: BATTERY_HUE_DRIFT,
      randomiseDisplacement: true,
    });
  }
}

/** Battery - Cos Edge Gradiant. Edge gradient with a cosine ripple along it. */
export class BatteryCosEdgeGradiantVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Cos Edge Gradiant',
      category: 'Battery',
      // Seed only; the displacement is re-rolled on every randomise tick.
      shift: ShiftMode.Swirl,
      generator: GeneratorMode.CosEdgeGradiant,
      decay: BATTERY_DECAY,
      startHue: 300,
      hueDrift: BATTERY_HUE_DRIFT,
      randomiseDisplacement: true,
    });
  }
}

/** Battery - Edge Trace. Thin rectified trace hugging the bottom edge. */
export class BatteryEdgeTraceVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Edge Trace',
      category: 'Battery',
      // Seed only; the displacement is re-rolled on every randomise tick.
      shift: ShiftMode.Swirl,
      generator: GeneratorMode.EdgeTrace,
      decay: BATTERY_DECAY,
      startHue: 150,
      hueDrift: BATTERY_HUE_DRIFT,
      randomiseDisplacement: true,
    });
  }
}

/** Battery - Dot Plane. Grid of dots sized by spectral magnitude. */
export class BatteryDotPlaneVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Dot Plane',
      category: 'Battery',
      // Seed only; the displacement is re-rolled on every randomise tick.
      shift: ShiftMode.Swirl,
      generator: GeneratorMode.DotPlane,
      decay: BATTERY_DECAY,
      startHue: 90,
      hueDrift: BATTERY_HUE_DRIFT,
      randomiseDisplacement: true,
    });
  }
}

/** Battery - JDar. Radar sweep whose angle accumulates with the low bins. */
export class BatteryJDarVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'JDar',
      category: 'Battery',
      // Seed only; the displacement is re-rolled on every randomise tick.
      shift: ShiftMode.Swirl,
      generator: GeneratorMode.JDar,
      decay: BATTERY_DECAY,
      startHue: 120,
      hueDrift: BATTERY_HUE_DRIFT,
      randomiseDisplacement: true,
    });
  }
}

/** Battery - Galaxy. Spiral arms about the centre, brightened by the spectrum. */
export class BatteryGalaxyVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Galaxy',
      category: 'Battery',
      // Seed only; the displacement is re-rolled on every randomise tick.
      shift: ShiftMode.Swirl,
      generator: GeneratorMode.Galaxy,
      decay: BATTERY_DECAY,
      startHue: 240,
      hueDrift: BATTERY_HUE_DRIFT,
      randomiseDisplacement: true,
    });
  }
}

/** Battery - Jiggy Scribble. Wandering scribble whose path jitters with the waveform. */
export class BatteryJiggyScribbleVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Jiggy Scribble',
      category: 'Battery',
      // Seed only; the displacement is re-rolled on every randomise tick.
      shift: ShiftMode.Swirl,
      generator: GeneratorMode.JiggyScribble,
      decay: BATTERY_DECAY,
      startHue: 40,
      hueDrift: BATTERY_HUE_DRIFT,
      randomiseDisplacement: true,
    });
  }
}

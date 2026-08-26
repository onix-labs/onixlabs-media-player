/**
 * @fileoverview Ambience visualization - a per-pixel coordinate warp engine.
 *
 * A re-implementation, from behavioural analysis, of the effect engine behind
 * the Windows Media Player "Ambience" visualization. Nothing here is derived
 * from Microsoft source or object code; only the observable structure of the
 * engine informed the design, and every line below is original.
 *
 * Ambience is not a drawing effect - it is a *coordinate* effect. The engine
 * carries a bank of displacement classes, each of which answers one question:
 * given a destination pixel, where in the previous frame should it be sampled
 * from? Each class overrides exactly two methods - one to randomise its
 * parameters, one to displace a coordinate - and the renderer walks the
 * destination image asking that question per pixel, then feeds the result
 * back as the next frame's input.
 *
 * Several of the displacements work in polar space. The engine provides a
 * matched pair of helpers for this, which convert about a configurable centre:
 *
 *   toPolar(x, y):    angle  = atan2(centreY - y, centreX - x)
 *                     radius = sqrt(dx*dx + dy*dy)
 *   fromPolar(a, r):  x = width  - centreX - cos(a) * r
 *                     y = height - centreY - sin(a) * r
 *
 * A displacement is therefore either a direct nudge of (x, y) or a
 * perturbation of (angle, radius) - which is exactly the shape of a fragment
 * shader, and why this visualization is built on WebGL rather than the 2D
 * canvas the rest of the suite uses. A per-pixel inverse warp is a couple of
 * lines of GLSL and effectively free on the GPU; in 2D canvas it would mean
 * either a per-pixel ImageData loop every frame or a strip decomposition that
 * cannot express arbitrary fields.
 *
 * All twelve displacements from the original bank are implemented here, named
 * for the classes they model:
 *
 * - Linear       constant random drift, a few pixels per frame on each axis
 * - Swirl        sine ripple: x displaced by sin of y, y by cos of x
 * - Zoom         angle advanced and radius scaled about the centre
 * - Starburst    radius modulated by sin(arms * angle), scaled by radius
 * - RingSpin     radius split into rings, each rotated by its ring index
 * - Stretch      cubic radial distortion in normalised radius
 * - Tile         coordinate wrapped, repeating the surface as tiles
 * - Trig         three sub-modes perturbing angle or radius trigonometrically
 * - TrigStretch  Trig composed with the cubic radial distortion
 * - SinShimmer   axis-aligned sine displacement, two sub-modes
 * - EdgeFalloff  shear growing with distance from one of the four edges
 * - Thingus      angle and radius offset, radius scaled by a quarter width
 *
 * Note the shader works in *pixel* space rather than normalised space. That is
 * deliberate: the parameter ranges below are the literal constants recovered
 * from each class's randomise method, and they are expressed in pixels and in
 * fractions of the surface dimensions. Working in pixels lets them transfer
 * without rescaling, at the cost of two extra multiplies per fragment.
 *
 * The original ships fourteen named presets over these twelve classes, and
 * several classes carry sub-modes of their own, so presets parameterise
 * displacements rather than mapping one-to-one. Only three shipping names tie
 * to a class with certainty (Swirl, Falloff, Thingus), so presets here are
 * named for the displacement they exercise rather than guessing.
 *
 * Technical details:
 * - Ping-pong framebuffer pair at a fixed internal resolution, upscaled to the
 *   canvas, mirroring the original's small-surface-then-stretch approach
 * - Waveform uploaded as a 1D texture and evaluated analytically in the shader
 * - Bounds-checked sampling, so content does not smear in from outside
 *
 * @module app/components/audio/audio-outlet/visualizations/ambience-visualization
 */

import {WebGLVisualization, VisualizationConfig} from './visualization';
import {DEGREES_FULL_CIRCLE, MS_PER_SECOND, RGB_MAX} from './visualization-constants';

// ============================================================================
// Surface
// ============================================================================

/**
 * Height, in pixels, of the internal feedback surface.
 *
 * As with the original, the effect is computed small and upscaled. This keeps
 * the per-frame cost independent of display size and preserves the soft,
 * flowing quality that a native-resolution warp loses.
 */
const SURFACE_HEIGHT: number = 512;

/** Widest the internal surface may get, for very wide aspect ratios. */
const SURFACE_MAX_WIDTH: number = 1024;

/** Width of the 1D waveform texture uploaded each frame. */
const WAVE_TEXTURE_WIDTH: number = 512;

/** Bytes per RGBA texel, used when packing the waveform texture. */
const RGBA_STRIDE: number = 4;

// ============================================================================
// Feedback decay
// ============================================================================

/** Slow decay - long, heavy trails. */
const DECAY_SLOW: number = 0.985;

/** Moderate decay. */
const DECAY_MID: number = 0.97;

/** Fast decay - the trace stays legible against the warp. */
const DECAY_FAST: number = 0.95;

// ============================================================================
// Displacement parameters
//
// Every range below is taken from the corresponding class's randomise method.
// The engine seeds `u = rand() / 32767` and scales it, so the spans and biases
// are the literal constants those methods multiply and subtract.
// ============================================================================

/** Modulus of the linear drift draw, per axis: rand() % 6 - 3. */
const LINEAR_DRIFT_MODULUS: number = 6;

/** Bias subtracted from the linear drift draw, giving [-3, +2] pixels. */
const LINEAR_DRIFT_BIAS: number = 3;

/** Span of the shared angular delta draw: u * 0.1 - 0.05. */
const ANGLE_SPAN: number = 0.1;

/** Bias of the shared angular delta draw, giving [-0.05, +0.05] radians. */
const ANGLE_BIAS: number = 0.05;

/** Modulus of the swirl amplitude draw: rand() % 20 - 10 pixels. */
const SWIRL_AMPLITUDE_MODULUS: number = 20;

/** Bias of the swirl amplitude draw. */
const SWIRL_AMPLITUDE_BIAS: number = 10;

/** Modulus of the swirl frequency draw: rand() % 24 - 12 cycles. */
const SWIRL_FREQUENCY_MODULUS: number = 24;

/** Bias of the swirl frequency draw. */
const SWIRL_FREQUENCY_BIAS: number = 12;

/** Span of the zoom radial draw: u * 0.2 - 0.1. */
const ZOOM_SPAN: number = 0.2;

/** Bias of the zoom radial draw. */
const ZOOM_BIAS: number = 0.1;

/** Span shared by the starburst, stretch and trig-stretch amplitude draws. */
const AMPLITUDE_SPAN: number = 0.3;

/** Modulus of the starburst arm-count draw: rand() % 40. */
const STARBURST_ARM_MODULUS: number = 40;

/** Span of the ring-width draw, as a fraction of half the surface height. */
const RING_SPAN: number = 0.8;

/** Span of the tile-size draw, as a fraction of the surface. */
const TILE_SPAN: number = 0.2;

/** Span of the trig amplitude draw: u * 0.1 - 0.05. */
const TRIG_SPAN: number = 0.1;

/** Bias of the trig amplitude draw. */
const TRIG_BIAS: number = 0.05;

/** Number of trig sub-modes: rand() % 3. */
const TRIG_MODES: number = 3;

/** Span of the shimmer amplitude draw: u * 10 - 5 pixels. */
const SHIMMER_SPAN: number = 10;

/** Bias of the shimmer amplitude draw. */
const SHIMMER_BIAS: number = 5;

/** Span of the shimmer frequency draw: u * 2. */
const SHIMMER_FREQUENCY_SPAN: number = 2;

/** Number of shimmer sub-modes: rand() % 2. */
const SHIMMER_MODES: number = 2;

/** Span of the edge-falloff strength draw: u * 0.1. */
const EDGE_SPAN: number = 0.1;

/** Number of edge-falloff sub-modes, one per edge: rand() % 4. */
const EDGE_MODES: number = 4;

/** Span of the Thingus angular draw: u * 0.8 - 0.4. */
const THINGUS_SPAN: number = 0.8;

/** Bias of the Thingus angular draw. */
const THINGUS_BIAS: number = 0.4;

/** Span of the Thingus radial draw: u * 0.2. */
const THINGUS_RADIAL_SPAN: number = 0.2;

// ============================================================================
// Waveform injection
// ============================================================================

/** Trace deflection as a fraction of surface height, at unit amplitude. */
const WAVE_AMPLITUDE: number = 0.34;

/** Gaussian falloff width of the trace glow. Smaller is tighter. */
const WAVE_SIGMA: number = 0.00025;

/** Brightness of the injected trace. */
const WAVE_GAIN: number = 0.85;

/** Number of low-frequency bins averaged to derive the bass level. */
const BASS_BIN_COUNT: number = 24;

/** Smoothing applied to the bass envelope, per frame. */
const BASS_SMOOTHING: number = 0.18;

/** Extra trace amplitude contributed by the bass envelope. */
const BASS_FLEX: number = 0.6;

// ============================================================================
// Colour
// ============================================================================

/** Saturation of the injected trace, as a percentage. */
const TRACE_SATURATION: number = 90;

/** Lightness of the injected trace, as a percentage. */
const TRACE_LIGHTNESS: number = 55;

/** Slow hue rotation, in degrees per frame. */
const HUE_DRIFT_SLOW: number = 0.2;

/** Moderate hue rotation, in degrees per frame. */
const HUE_DRIFT_MED: number = 0.55;

// ============================================================================
// Preset cycling
// ============================================================================

/** How long each preset is held before advancing, in seconds. */
const PRESET_HOLD_SECONDS: number = 16;

/** How long each preset is held before advancing, in milliseconds. */
const PRESET_HOLD_MS: number = PRESET_HOLD_SECONDS * MS_PER_SECOND;

/** Longest frame delta the preset clock will honour, in milliseconds. */
const PRESET_MAX_DELTA_MS: number = MS_PER_SECOND;

/**
 * The displacement classes implemented in this pass.
 *
 * Values are consumed directly by the shader's branch on `uShift`, so they
 * must stay in step with the GLSL below.
 */
export enum ShiftMode {
  /** Constant random drift on both axes. */
  Linear = 0,
  /** Sine ripple: x displaced by sin of y, y by cos of x. */
  Swirl = 1,
  /** Angle advanced, radius scaled about the centre. */
  Zoom = 2,
  /** Radius modulated by sin(arms * angle). */
  Starburst = 3,
  /** Concentric rings, each rotated by its ring index. */
  RingSpin = 4,
  /** Cubic radial distortion. */
  Stretch = 5,
  /** Coordinate wrapped into repeating tiles. */
  Tile = 6,
  /** Trigonometric perturbation of angle or radius, three sub-modes. */
  Trig = 7,
  /** Trig composed with the cubic radial distortion. */
  TrigStretch = 8,
  /** Axis-aligned sine displacement, two sub-modes. */
  SinShimmer = 9,
  /** Shear growing with distance from one of the four edges. */
  EdgeFalloff = 10,
  /** Angle and radius offset, radius scaled by a quarter width. */
  Thingus = 11,
}

/**
 * The source generators - what gets drawn into the surface before the warp.
 *
 * The original carries a second bank of classes alongside the displacements
 * (CWaveEdge, CSpectrumEdge, CCircleWaveform, CEdgeGradiant, CCosEdgeGradiant,
 * CEdgeTrace, CDotPlane, CGalaxy, CJDar, CJiggyScribble), each an independently
 * creatable COM object. Pairing one generator with one displacement is what
 * lets Battery "always show a unique visualization".
 *
 * The class names are recovered; their internals are not. What each generator
 * draws below is an original reading of its name, not a decode of its code.
 */
export enum GeneratorMode {
  /** Waveform trace across the surface. */
  WaveEdge = 0,
  /** Frequency spectrum rising from the bottom edge. */
  SpectrumEdge = 1,
  /** Waveform wrapped around a circle. */
  CircleWaveform = 2,
  /** Amplitude-modulated gradient banked against an edge. */
  EdgeGradiant = 3,
  /** As EdgeGradiant, with a cosine ripple along the edge. */
  CosEdgeGradiant = 4,
  /** Thin rectified trace hugging the bottom edge. */
  EdgeTrace = 5,
  /** Grid of dots sized by spectral magnitude. */
  DotPlane = 6,
}

/** Number of generators, used when drawing a random one. */
const GENERATOR_COUNT: number = 7;

/** Number of displacements, used when drawing a random one. */
const SHIFT_COUNT: number = 12;

/**
 * The per-displacement configuration a concrete subclass supplies.
 *
 * Passed through the constructor rather than declared as abstract members:
 * abstract property initialisers in a subclass run *after* the base
 * constructor body, so the base could not read them while seeding its first
 * randomise.
 */
interface AmbienceSpec {
  /** Display name, describing the displacement it exercises. */
  readonly name: string;

  /** Which displacement class to run. */
  readonly shift: ShiftMode;

  /** Per-frame multiplier applied to the previous frame. */
  readonly decay: number;

  /** Starting hue for the injected trace, in degrees. */
  readonly startHue: number;

  /** Hue rotation per frame, in degrees. */
  readonly hueDrift: number;

  /** Which source generator draws into the surface. */
  readonly generator: GeneratorMode;

  /** Category this visualization is grouped under. Defaults to Ambience. */
  readonly category?: string;

  /**
   * When true, the displacement and generator are re-drawn at random on every
   * randomise tick, not just their parameters. This is what Battery does.
   */
  readonly randomiseAll?: boolean;
}


/** Vertex shader shared by both passes: a full-screen triangle pair. */
const VERTEX_SHADER: string = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/**
 * Warp pass: samples the previous frame through the active displacement,
 * attenuates it, and adds the waveform trace.
 *
 * `applyShift` is the direct analogue of the original's per-class displace
 * method - it answers "where should this destination pixel read from?" - and
 * the polar branches use the same convert/perturb/convert-back shape as the
 * engine's shared helpers.
 */
const WARP_FRAGMENT_SHADER: string = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 vUv;

uniform sampler2D uPrevious;
uniform sampler2D uWaveform;
uniform vec2  uSize;
uniform float uDecay;
uniform int   uShift;
uniform int   uSubMode;
uniform int   uGenerator;
uniform vec2  uDrift;
uniform float uAmplitude;
uniform float uFrequency;
uniform float uAngleDelta;
uniform vec3  uTraceColor;
uniform float uWaveAmplitude;

/* The original multiplies by a literal 6.28 rather than a precise tau. Keeping
   the same approximation keeps the recovered frequency ranges honest. */
const float TAU_APPROX = 6.28;

vec2 surfaceCentre() {
  return uSize * 0.5;
}

/* Matches the engine's shared helper: the delta is centre-minus-point. */
void toPolar(vec2 p, out float angle, out float radius) {
  vec2 delta = surfaceCentre() - p;
  angle = atan(delta.y, delta.x);
  radius = length(delta);
}

vec2 fromPolar(float angle, float radius) {
  return surfaceCentre() - vec2(cos(angle), sin(angle)) * radius;
}

vec2 applyShift(vec2 p) {
  vec2 origin = p;

  if (uShift == 0) {
    return p + uDrift;
  }

  if (uShift == 1) {
    /* Sine ripple. Both axes read the *original* coordinate, as the engine
       saves x and y before displacing either. */
    p.x += sin(uFrequency * TAU_APPROX / uSize.y * origin.y) * uAmplitude;
    p.y += cos(uFrequency * TAU_APPROX / uSize.x * origin.x) * uAmplitude;
    return p;
  }

  if (uShift == 6) {
    float tile = max(uAmplitude * uSize.y, 2.0);
    return mod(p, tile);
  }

  if (uShift == 9) {
    float phase = TAU_APPROX * uFrequency;
    if (uSubMode == 0) {
      p.x += sin(origin.y / uSize.y * phase) * uAmplitude;
    } else {
      p.y += sin(origin.x / uSize.x * phase) * uAmplitude;
    }
    return p;
  }

  if (uShift == 10) {
    /* (k + 1) * d - d collapses to k * d; d is the distance to the chosen
       edge, so the shear grows away from it. */
    float distance;
    if (uSubMode == 0) {
      distance = p.x;
    } else if (uSubMode == 1) {
      distance = p.y;
    } else if (uSubMode == 2) {
      distance = uSize.x - p.x - 1.0;
    } else {
      distance = uSize.y - p.y - 1.0;
    }
    float shear = uAmplitude * distance;
    if (uSubMode == 0 || uSubMode == 2) {
      p.x -= shear;
    } else {
      p.y -= shear;
    }
    return p;
  }

  /* Everything below is a polar perturbation. */
  float angle;
  float radius;
  toPolar(p, angle, radius);

  float halfWidth = max(uSize.x * 0.5, 1.0);
  float maxRadius = max(length(uSize) * 0.5, 1.0);
  float normalised = radius / halfWidth;

  if (uShift == 2) {
    angle += uAngleDelta;
    radius *= 1.0 + uAmplitude;
  } else if (uShift == 3) {
    radius += sin(uFrequency * angle) * normalised * (uSize.y * uAmplitude);
    angle += uAngleDelta;
  } else if (uShift == 4) {
    float ring = max(uSize.y * 0.5 * uFrequency, 1.0);
    angle += uAngleDelta * floor(radius / ring);
  } else if (uShift == 5) {
    radius -= (uSize.y * uAmplitude) * normalised * normalised * normalised;
    angle += uAngleDelta;
  } else if (uShift == 7 || uShift == 8) {
    if (uSubMode == 0) {
      radius += sin(angle) * uAmplitude * maxRadius;
    } else if (uSubMode == 1) {
      angle += sin(radius / maxRadius * TAU_APPROX) * uAmplitude * TAU_APPROX;
    } else {
      radius += cos(radius / maxRadius * TAU_APPROX) * uAmplitude * maxRadius;
    }
    if (uShift == 8) {
      radius -= (uSize.y * uFrequency) * normalised * normalised * normalised;
    }
    angle += uAngleDelta;
  } else {
    /* Thingus */
    angle += uAmplitude;
    radius += uFrequency * uSize.x * 0.25;
  }

  return fromPolar(angle, radius);
}

/* Gaussian falloff about a target coordinate. "sample" is avoided as an
   identifier: it is a reserved word in later GLSL versions and some drivers
   reject it here too. */
float glow(float delta) {
  return exp(-(delta * delta) / ${WAVE_SIGMA});
}

float waveformAt(float x) {
  return texture2D(uWaveform, vec2(x, 0.5)).r;
}

float spectrumAt(float x) {
  return texture2D(uWaveform, vec2(x, 0.5)).g;
}

/* The source generators. Each returns an intensity in roughly [0, 1] for the
   destination pixel; the warp pass adds that to the decayed previous frame. */
float generate(vec2 uv) {
  if (uGenerator == 0) {
    float traceY = 0.5 + (waveformAt(uv.x) - 0.5) * uWaveAmplitude;
    return glow(uv.y - traceY);
  }

  if (uGenerator == 1) {
    float top = spectrumAt(uv.x) * uWaveAmplitude;
    if (uv.y > top) {
      return 0.0;
    }
    return 1.0 - uv.y / max(top, 0.001);
  }

  if (uGenerator == 2) {
    vec2 centred = (uv - 0.5) * vec2(uSize.x / uSize.y, 1.0);
    float angle = atan(centred.y, centred.x);
    float level = waveformAt(angle / TAU_APPROX + 0.5);
    float target = 0.25 + (level - 0.5) * uWaveAmplitude * 0.5;
    return glow(length(centred) - target);
  }

  if (uGenerator == 3) {
    float band = max(0.0, 1.0 - uv.y * 8.0);
    return band * abs(waveformAt(uv.x) - 0.5) * 2.0;
  }

  if (uGenerator == 4) {
    float band = max(0.0, 1.0 - uv.y * 8.0);
    float ripple = 0.5 + 0.5 * cos(uv.x * TAU_APPROX * 4.0);
    return band * ripple * abs(waveformAt(uv.x) - 0.5) * 2.0;
  }

  if (uGenerator == 5) {
    float height = abs(waveformAt(uv.x) - 0.5) * 2.0 * uWaveAmplitude;
    return glow(uv.y - height);
  }

  /* DotPlane */
  vec2 cell = fract(uv * 12.0) - 0.5;
  float magnitude = spectrumAt(uv.x);
  return smoothstep(0.35 * magnitude + 0.02, 0.0, length(cell));
}

void main() {
  vec2 source = applyShift(vUv * uSize) / uSize;

  /* Bounds-checked, matching the original's guarded table lookup: nothing
     bleeds in from outside the surface. */
  vec3 previous = vec3(0.0);
  if (source.x >= 0.0 && source.x <= 1.0 && source.y >= 0.0 && source.y <= 1.0) {
    previous = texture2D(uPrevious, source).rgb * uDecay;
  }

  gl_FragColor = vec4(previous + uTraceColor * generate(vUv) * ${WAVE_GAIN}, 1.0);
}
`;

/** Present pass: stretches the internal surface up to the canvas. */
const BLIT_FRAGMENT_SHADER: string = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSource;
uniform float uAlpha;
void main() {
  gl_FragColor = vec4(texture2D(uSource, vUv).rgb, 1.0) * uAlpha;
}
`;

/**
 * Ambience - a per-pixel coordinate warp fed back on itself.
 *
 * Each frame the previous frame is resampled through the active displacement
 * and attenuated, the waveform trace is injected, and the result becomes the
 * next frame's input. Because the output of one frame is the input of the
 * next, a small per-pixel displacement compounds into large-scale flow.
 */
export abstract class AmbienceVisualization extends WebGLVisualization {
  public readonly name: string;
  public readonly category: string;

  /** Which displacement this visualization runs. */
  private shift: ShiftMode;

  /** Which source generator draws into the surface. */
  private generator: GeneratorMode;

  /** Whether displacement and generator are re-drawn at random each tick. */
  private readonly randomiseAll: boolean;

  /** Per-frame multiplier applied to the previous frame. */
  private readonly decay: number;

  /** Hue rotation per frame, in degrees. */
  private readonly hueDrift: number;

  /** Time-domain samples for the trace. */
  private dataArray: Uint8Array<ArrayBuffer>;

  /** Frequency bins, used only for the bass envelope. */
  private freqArray: Uint8Array<ArrayBuffer>;

  /** RGBA staging buffer for the waveform texture. */
  private readonly waveTexels: Uint8Array<ArrayBuffer>;

  /** Compiled programs for the two passes. */
  private warpProgram: WebGLProgram | null = null;
  private blitProgram: WebGLProgram | null = null;

  /** Full-screen quad. */
  private quadBuffer: WebGLBuffer | null = null;

  /** Ping-pong colour attachments. */
  private surfaceTextures: (WebGLTexture | null)[] = [null, null];
  private surfaceBuffers: (WebGLFramebuffer | null)[] = [null, null];

  /** Index of the texture holding the current frame. */
  private front: number = 0;

  /** Waveform texture. */
  private waveTexture: WebGLTexture | null = null;

  /** Cached uniform locations for the warp pass. */
  private warpUniforms: Record<string, WebGLUniformLocation | null> = {};

  /** Cached uniform locations for the present pass. */
  private blitUniforms: Record<string, WebGLUniformLocation | null> = {};

  /** Dimensions of the internal surface. */
  private surfaceWidth: number = 0;
  private surfaceHeight: number = 0;

  /** Milliseconds elapsed since the parameters were last redrawn. */
  private sinceRandomiseMs: number = 0;

  /** Timestamp of the previous randomise tick, in milliseconds. */
  private lastRandomiseTickMs: number = performance.now();

  /** Current hue of the trace, in degrees. */
  private hue: number;

  /** Smoothed bass level in the range 0 to 1. */
  private bass: number = 0;

  /**
   * Randomised displacement parameters for the running preset.
   *
   * One generic set covers all twelve displacements; each reads only the
   * fields it needs, which is why the shader takes five parameter uniforms
   * rather than a union per class.
   */
  private driftX: number = 0;
  private driftY: number = 0;
  private amplitude: number = 0;
  private frequency: number = 0;
  private angleDelta: number = 0;
  private subMode: number = 0;

  protected constructor(config: VisualizationConfig, spec: AmbienceSpec) {
    super(config);
    this.name = spec.name;
    this.category = spec.category ?? 'Ambience';
    this.shift = spec.shift;
    this.generator = spec.generator;
    this.randomiseAll = spec.randomiseAll === true;
    this.decay = spec.decay;
    this.hueDrift = spec.hueDrift;
    this.hue = spec.startHue;
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.freqArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this.waveTexels = new Uint8Array(WAVE_TEXTURE_WIDTH * RGBA_STRIDE) as Uint8Array<ArrayBuffer>;
    this.randomiseShift();
    this.initGL();
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.freqArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  // ==========================================================================
  // GL setup
  // ==========================================================================

  /** Compiles both programs and creates the quad and waveform texture. */
  private initGL(): void {
    const gl: WebGLRenderingContext = this.gl;

    this.warpProgram = this.createProgram(VERTEX_SHADER, WARP_FRAGMENT_SHADER);
    this.blitProgram = this.createProgram(VERTEX_SHADER, BLIT_FRAGMENT_SHADER);

    for (const key of [
      'uPrevious', 'uWaveform', 'uSize', 'uDecay', 'uShift', 'uSubMode',
      'uGenerator', 'uDrift', 'uAmplitude', 'uFrequency', 'uAngleDelta',
      'uTraceColor', 'uWaveAmplitude',
    ]) {
      this.warpUniforms[key] = gl.getUniformLocation(this.warpProgram!, key);
    }
    for (const key of ['uSource', 'uAlpha']) {
      this.blitUniforms[key] = gl.getUniformLocation(this.blitProgram!, key);
    }

    // Two triangles covering clip space.
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    this.waveTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.waveTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, WAVE_TEXTURE_WIDTH, 1, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, this.waveTexels
    );
  }

  /**
   * Compiles and links a shader program.
   *
   * @param vertexSource - Vertex shader source
   * @param fragmentSource - Fragment shader source
   * @returns The linked program
   * @throws Error if compilation or linking fails
   */
  private createProgram(vertexSource: string, fragmentSource: string): WebGLProgram {
    const gl: WebGLRenderingContext = this.gl;
    const program: WebGLProgram | null = gl.createProgram();
    if (!program) throw new Error('Failed to create WebGL program');

    const vertex: WebGLShader = this.compileShader(gl.VERTEX_SHADER, vertexSource);
    const fragment: WebGLShader = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);

    // The shaders are owned by the program once linked; drop our references so
    // they are freed when the program is deleted.
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log: string | null = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Failed to link WebGL program: ${log ?? 'unknown error'}`);
    }
    return program;
  }

  /**
   * Compiles a single shader stage.
   *
   * @param type - gl.VERTEX_SHADER or gl.FRAGMENT_SHADER
   * @param source - Shader source
   * @returns The compiled shader
   * @throws Error if compilation fails
   */
  private compileShader(type: number, source: string): WebGLShader {
    const gl: WebGLRenderingContext = this.gl;
    const shader: WebGLShader | null = gl.createShader(type);
    if (!shader) throw new Error('Failed to create WebGL shader');

    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log: string | null = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Failed to compile shader: ${log ?? 'unknown error'}`);
    }
    return shader;
  }

  protected override onResize(): void {
    if (this.width <= 0 || this.height <= 0) return;

    const aspect: number = this.width / this.height;
    const height: number = SURFACE_HEIGHT;
    const width: number = Math.max(1, Math.min(SURFACE_MAX_WIDTH, Math.round(height * aspect)));

    if (width === this.surfaceWidth && height === this.surfaceHeight && this.surfaceTextures[0]) {
      return;
    }

    this.surfaceWidth = width;
    this.surfaceHeight = height;
    this.createSurfaces();
  }

  /** (Re)creates the ping-pong colour attachments at the current surface size. */
  private createSurfaces(): void {
    const gl: WebGLRenderingContext = this.gl;
    this.deleteSurfaces();

    for (let i: number = 0; i < this.surfaceTextures.length; i++) {
      const texture: WebGLTexture | null = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, this.surfaceWidth, this.surfaceHeight, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null
      );
      // Linear sampling is what makes the warp smooth rather than blocky, and
      // clamping keeps the bounds check in the shader the only edge rule.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const buffer: WebGLFramebuffer | null = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      this.surfaceTextures[i] = texture;
      this.surfaceBuffers[i] = buffer;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Releases the ping-pong attachments. */
  private deleteSurfaces(): void {
    const gl: WebGLRenderingContext = this.gl;
    for (let i: number = 0; i < this.surfaceTextures.length; i++) {
      if (this.surfaceTextures[i]) gl.deleteTexture(this.surfaceTextures[i]);
      if (this.surfaceBuffers[i]) gl.deleteFramebuffer(this.surfaceBuffers[i]);
      this.surfaceTextures[i] = null;
      this.surfaceBuffers[i] = null;
    }
  }

  // ==========================================================================
  // Frame
  // ==========================================================================

  public draw(): void {
    this.updateFade();

    if (this.width <= 0 || this.height <= 0) return;
    if (!this.surfaceTextures[0]) {
      this.onResize();
      if (!this.surfaceTextures[0]) return;
    }
    if (!this.warpProgram || !this.blitProgram) return;

    this.analyser.getByteTimeDomainData(this.dataArray);
    this.analyser.getByteFrequencyData(this.freqArray);

    this.updateBass();
    this.maybeRandomise();
    this.uploadWaveform();

    this.renderWarpPass();
    this.renderPresentPass();
  }

  /** Updates the smoothed bass envelope from the low frequency bins. */
  private updateBass(): void {
    const bins: number = Math.min(BASS_BIN_COUNT, this.freqArray.length);
    if (bins <= 0) return;

    let total: number = 0;
    for (let i: number = 0; i < bins; i++) {
      total += this.freqArray[i];
    }

    const level: number = (total / bins / RGB_MAX) * this.sensitivityFactor;
    this.bass += (level - this.bass) * BASS_SMOOTHING;
  }

  /**
   * Redraws the displacement's parameters on an interval.
   *
   * The original randomises a displacement's parameters when it is selected
   * rather than holding fixed values. Each displacement is its own
   * visualization here, so there is no selection event to hang that off;
   * instead the parameters are redrawn periodically, which keeps a single
   * displacement from settling into one fixed, static field.
   */
  private maybeRandomise(): void {
    const now: number = performance.now();
    // Clamped so a long stall cannot skip an entire interval in one frame.
    const deltaMs: number = Math.min(now - this.lastRandomiseTickMs, PRESET_MAX_DELTA_MS);
    this.lastRandomiseTickMs = now;
    this.sinceRandomiseMs += deltaMs;

    if (this.sinceRandomiseMs < PRESET_HOLD_MS) return;

    this.sinceRandomiseMs = 0;
    this.randomiseShift();
  }

  /**
   * Draws fresh random parameters for the active displacement.
   *
   * Mirrors the randomise method each displacement class implements. The
   * linear drift in particular follows the original's shape: a small integer
   * number of pixels per frame on each axis, in an arbitrary direction.
   */
  private randomiseShift(): void {
    const unit: () => number = (): number => Math.random();
    const pick: (modulus: number) => number =
      (modulus: number): number => Math.floor(Math.random() * modulus);


    if (this.randomiseAll) {
      this.shift = pick(SHIFT_COUNT) as ShiftMode;
      this.generator = pick(GENERATOR_COUNT) as GeneratorMode;
    }

    // Shared across every polar displacement: u * 0.1 - 0.05 radians.
    this.angleDelta = unit() * ANGLE_SPAN - ANGLE_BIAS;
    this.driftX = 0;
    this.driftY = 0;
    this.amplitude = 0;
    this.frequency = 0;
    this.subMode = 0;

    switch (this.shift) {
      case ShiftMode.Linear:
        this.driftX = pick(LINEAR_DRIFT_MODULUS) - LINEAR_DRIFT_BIAS;
        this.driftY = pick(LINEAR_DRIFT_MODULUS) - LINEAR_DRIFT_BIAS;
        break;
      case ShiftMode.Swirl:
        this.amplitude = pick(SWIRL_AMPLITUDE_MODULUS) - SWIRL_AMPLITUDE_BIAS;
        this.frequency = pick(SWIRL_FREQUENCY_MODULUS) - SWIRL_FREQUENCY_BIAS;
        break;
      case ShiftMode.Zoom:
        this.amplitude = unit() * ZOOM_SPAN - ZOOM_BIAS;
        break;
      case ShiftMode.Starburst:
        this.amplitude = unit() * AMPLITUDE_SPAN;
        this.frequency = pick(STARBURST_ARM_MODULUS);
        break;
      case ShiftMode.RingSpin:
        this.frequency = unit() * RING_SPAN;
        break;
      case ShiftMode.Stretch:
        this.amplitude = unit() * AMPLITUDE_SPAN;
        break;
      case ShiftMode.Tile:
        this.amplitude = unit() * TILE_SPAN;
        break;
      case ShiftMode.Trig:
        this.amplitude = unit() * TRIG_SPAN - TRIG_BIAS;
        this.subMode = pick(TRIG_MODES);
        break;
      case ShiftMode.TrigStretch:
        this.amplitude = unit() * TRIG_SPAN - TRIG_BIAS;
        this.subMode = pick(TRIG_MODES);
        this.frequency = unit() * AMPLITUDE_SPAN;
        break;
      case ShiftMode.SinShimmer:
        this.amplitude = unit() * SHIMMER_SPAN - SHIMMER_BIAS;
        this.frequency = unit() * SHIMMER_FREQUENCY_SPAN;
        this.subMode = pick(SHIMMER_MODES);
        break;
      case ShiftMode.EdgeFalloff:
        this.amplitude = unit() * EDGE_SPAN;
        this.subMode = pick(EDGE_MODES);
        break;
      default:
        // Thingus
        this.amplitude = unit() * THINGUS_SPAN - THINGUS_BIAS;
        this.frequency = unit() * THINGUS_RADIAL_SPAN;
        break;
    }
  }


  /** Packs the time-domain samples and spectrum into the source texture. */
  private uploadWaveform(): void {
    const gl: WebGLRenderingContext = this.gl;
    const samples: number = this.dataArray.length;

    const bins: number = this.freqArray.length;
    for (let i: number = 0; i < WAVE_TEXTURE_WIDTH; i++) {
      const fraction: number = i / WAVE_TEXTURE_WIDTH;
      const index: number = Math.min(samples - 1, Math.floor(fraction * samples));
      // Red carries the time-domain trace, green the spectrum, so generators
      // that need either read one texture rather than two.
      this.waveTexels[i * RGBA_STRIDE] = this.dataArray[index];
      this.waveTexels[i * RGBA_STRIDE + 1] =
        bins > 0 ? this.freqArray[Math.min(bins - 1, Math.floor(fraction * bins))] : 0;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.waveTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, WAVE_TEXTURE_WIDTH, 1,
      gl.RGBA, gl.UNSIGNED_BYTE, this.waveTexels
    );
  }

  /** Runs the warp pass into the back surface, then swaps. */
  private renderWarpPass(): void {
    const gl: WebGLRenderingContext = this.gl;
    const back: number = 1 - this.front;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.surfaceBuffers[back]);
    gl.viewport(0, 0, this.surfaceWidth, this.surfaceHeight);
    gl.useProgram(this.warpProgram);
    this.bindQuad(this.warpProgram!);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.surfaceTextures[this.front]);
    gl.uniform1i(this.warpUniforms['uPrevious'], 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.waveTexture);
    gl.uniform1i(this.warpUniforms['uWaveform'], 1);

    this.hue = (this.hue + this.hueDrift) % DEGREES_FULL_CIRCLE;
    const rgb: {r: number; g: number; b: number} =
      this.hslToRgb(this.hue, TRACE_SATURATION, TRACE_LIGHTNESS);

    gl.uniform2f(this.warpUniforms['uSize'], this.surfaceWidth, this.surfaceHeight);
    gl.uniform1f(this.warpUniforms['uDecay'], this.decay);
    gl.uniform1i(this.warpUniforms['uShift'], this.shift);
    gl.uniform1i(this.warpUniforms['uSubMode'], this.subMode);
    gl.uniform1i(this.warpUniforms['uGenerator'], this.generator);
    gl.uniform2f(this.warpUniforms['uDrift'], this.driftX, this.driftY);
    gl.uniform1f(this.warpUniforms['uAmplitude'], this.amplitude);
    gl.uniform1f(this.warpUniforms['uFrequency'], this.frequency);
    gl.uniform1f(this.warpUniforms['uAngleDelta'], this.angleDelta);
    gl.uniform3f(this.warpUniforms['uTraceColor'], rgb.r / RGB_MAX, rgb.g / RGB_MAX, rgb.b / RGB_MAX);
    gl.uniform1f(
      this.warpUniforms['uWaveAmplitude'],
      WAVE_AMPLITUDE * this.sensitivityFactor * (1 + this.bass * BASS_FLEX)
    );

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this.front = back;
  }

  /** Stretches the internal surface to the canvas, applying the fade. */
  private renderPresentPass(): void {
    const gl: WebGLRenderingContext = this.gl;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.blitProgram);
    this.bindQuad(this.blitProgram!);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.surfaceTextures[this.front]);
    gl.uniform1i(this.blitUniforms['uSource'], 0);
    gl.uniform1f(this.blitUniforms['uAlpha'], 1 - this.fadeAlpha);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * Binds the full-screen quad to a program's position attribute.
   *
   * @param program - The program whose attribute should be bound
   */
  private bindQuad(program: WebGLProgram): void {
    const gl: WebGLRenderingContext = this.gl;
    const location: number = gl.getAttribLocation(program, 'aPosition');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  }

  public override destroy(): void {
    const gl: WebGLRenderingContext = this.gl;
    this.deleteSurfaces();
    if (this.waveTexture) gl.deleteTexture(this.waveTexture);
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
    if (this.warpProgram) gl.deleteProgram(this.warpProgram);
    if (this.blitProgram) gl.deleteProgram(this.blitProgram);
    this.waveTexture = null;
    this.quadBuffer = null;
    this.warpProgram = null;
    this.blitProgram = null;
    // Base class drops the context itself; do that only once our own objects
    // have been released.
    super.destroy();
  }
}

// ============================================================================
// Concrete displacements
//
// One visualization per displacement class in the original bank. They share
// the engine above and differ only in which displacement they run and the
// decay and hue treatment wrapped around it: aggressive warps take a faster
// decay so the trace stays legible, gentle ones take long trails so structure
// can build up.
// ============================================================================

/** Ambience - Swirl. Sine ripple: x displaced by a sine of y, y by a cosine of x. */
export class AmbienceSwirlVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Swirl',
      shift: ShiftMode.Swirl,
      decay: DECAY_SLOW,
      startHue: 200,
      hueDrift: HUE_DRIFT_SLOW,
      generator: GeneratorMode.WaveEdge,
    });
  }
}

/** Ambience - Zoom. Angle advanced and radius scaled about the centre each frame. */
export class AmbienceZoomVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Zoom',
      shift: ShiftMode.Zoom,
      decay: DECAY_MID,
      startHue: 300,
      hueDrift: HUE_DRIFT_MED,
      generator: GeneratorMode.WaveEdge,
    });
  }
}

/** Ambience - Starburst. Radius modulated by sin(arms * angle), scaled by normalised radius. */
export class AmbienceStarburstVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Starburst',
      shift: ShiftMode.Starburst,
      decay: DECAY_SLOW,
      startHue: 30,
      hueDrift: HUE_DRIFT_MED,
      generator: GeneratorMode.WaveEdge,
    });
  }
}

/** Ambience - Ring Spin. Radius split into concentric rings, each rotated by its ring index. */
export class AmbienceRingSpinVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Ring Spin',
      shift: ShiftMode.RingSpin,
      decay: DECAY_SLOW,
      startHue: 160,
      hueDrift: HUE_DRIFT_SLOW,
      generator: GeneratorMode.WaveEdge,
    });
  }
}

/** Ambience - Stretch. Cubic radial distortion in normalised radius. */
export class AmbienceStretchVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Stretch',
      shift: ShiftMode.Stretch,
      decay: DECAY_MID,
      startHue: 260,
      hueDrift: HUE_DRIFT_MED,
      generator: GeneratorMode.WaveEdge,
    });
  }
}

/** Ambience - Trig. Trigonometric perturbation of angle or radius, over three sub-modes. */
export class AmbienceTrigVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Trig',
      shift: ShiftMode.Trig,
      decay: DECAY_SLOW,
      startHue: 90,
      hueDrift: HUE_DRIFT_MED,
      generator: GeneratorMode.WaveEdge,
    });
  }
}

/** Ambience - Trig Stretch. Trig composed with the cubic radial distortion. */
export class AmbienceTrigStretchVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Trig Stretch',
      shift: ShiftMode.TrigStretch,
      decay: DECAY_MID,
      startHue: 340,
      hueDrift: HUE_DRIFT_MED,
      generator: GeneratorMode.WaveEdge,
    });
  }
}

/** Ambience - Shimmer. Axis-aligned sine displacement, over two sub-modes. */
export class AmbienceShimmerVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Shimmer',
      shift: ShiftMode.SinShimmer,
      decay: DECAY_SLOW,
      startHue: 180,
      hueDrift: HUE_DRIFT_SLOW,
      generator: GeneratorMode.WaveEdge,
    });
  }
}

/** Ambience - Edge Falloff. Shear growing with distance from one of the four edges. */
export class AmbienceEdgeFalloffVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Edge Falloff',
      shift: ShiftMode.EdgeFalloff,
      decay: DECAY_MID,
      startHue: 45,
      hueDrift: HUE_DRIFT_SLOW,
      generator: GeneratorMode.WaveEdge,
    });
  }
}

/** Ambience - Thingus. Angle and radius offset, radius scaled by a quarter of the width. */
export class AmbienceThingusVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Thingus',
      shift: ShiftMode.Thingus,
      decay: DECAY_SLOW,
      startHue: 280,
      hueDrift: HUE_DRIFT_MED,
      generator: GeneratorMode.WaveEdge,
    });
  }
}

/** Ambience - Tile. Coordinate wrapped, repeating the surface as tiles. */
export class AmbienceTileVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Tile',
      shift: ShiftMode.Tile,
      decay: DECAY_FAST,
      startHue: 120,
      hueDrift: HUE_DRIFT_MED,
      generator: GeneratorMode.WaveEdge,
    });
  }
}

/** Ambience - Linear. Constant random drift of a few pixels per frame on each axis. */
export class AmbienceLinearVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Linear',
      shift: ShiftMode.Linear,
      decay: DECAY_FAST,
      startHue: 210,
      hueDrift: HUE_DRIFT_SLOW,
      generator: GeneratorMode.WaveEdge,
    });
  }
}

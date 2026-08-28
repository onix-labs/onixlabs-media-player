/**
 * @fileoverview Warp-and-decay feedback engine.
 *
 * An 8-bit indexed surface warped into itself every frame, decayed a little
 * each step, and drawn into by audio-driven generators. A visualization built
 * on it is three choices and nothing else - the warp, the generators, and the
 * palette - which is what makes it worth having as an engine rather than as a
 * visualization.
 *
 * The frame order matters: `pre` generators draw first and are warped in the
 * same frame, the warp runs, then `post` generators draw on top and stay crisp
 * until the next frame.
 *
 * Nothing here changes what it is at random; a given visualization behaves the
 * same way every time it is selected. The one exception is the pulse, which
 * fires off a loud bass hit and then only some of the time - a response to the
 * audio rather than a choice about what the visualization is, and it is how
 * Reactor gates its own flash.
 *
 * @module app/components/audio/audio-outlet/visualizations/feedback-engine
 */

import {Visualization, VisualizationConfig, WebGLVisualization} from './visualization';

// ============================================================================
// Surface
// ============================================================================

/**
 * Height of the internal surface, in pixels.
 *
 * The warps scale off the surface dimensions, so this doubles as the scale a
 * spec's parameters are tuned against.
 */
const SURFACE_HEIGHT: number = 384;

/** Widest the internal surface may get, for very wide aspect ratios. */
const SURFACE_MAX_WIDTH: number = 1024;

/** Entries in a palette. */
const PALETTE_SIZE: number = 256;

/** Bytes per RGBA texel. */
const RGBA_STRIDE: number = 4;

/** Bytes per packed RGB palette entry. */
const RGB_STRIDE: number = 3;

/** Hex characters per `RRGGBB` palette entry. */
const PALETTE_HEX_STRIDE: number = 6;

/** Radix used to read the palette hex strings. */
const HEX_RADIX: number = 16;

/** Largest value of a colour channel. */
const CHANNEL_MAX: number = 255;

/**
 * Multiplier applied to the surface each step.
 *
 * Subtracting a fixed amount - one palette index, as the engine's own frame
 * counter suggests - cannot hold a surface that the generators keep adding to:
 * every pixel a generator touches climbs to full and stays there, and the frame
 * washes out. Decaying by proportion instead means the bright areas shed the
 * most, which is what keeps the trace legible against its own trail.
 *
 * Warp handles a trace of the same energy this way, and this sits between its
 * middle and fast rates.
 */
const SURFACE_DECAY: number = 0.94;

// ============================================================================
// Geometry budget
// ============================================================================

/** Floats per generator vertex: x, y, intensity. */
const VERTEX_STRIDE: number = 3;

/** Vertices a single generator may emit in one frame. */
const MAX_VERTICES: number = 4096;

/**
 * Gaussian falloff width of the radial waveform, across the surface height.
 *
 * Tighter than the horizontal trace. The ring is a closed curve read radially,
 * so the falloff piles up all the way round rather than spreading along a line,
 * and matching the trace's width left it soft.
 */
const RING_SIGMA: number = 0.00003;

/** Brightness of the radial waveform where it is thickest. */
const RING_GAIN: number = 0.85;

/** Points along a scribble curve. */
const SCRIBBLE_POINTS: number = 512;

/** Columns of dots in the dot plane. */
const DOT_COLUMNS: number = 40;

/** Rows of dots in the dot plane. */
const DOT_ROWS: number = 28;

/** Bars drawn by the spectrum edge generator. */
const SPECTRUM_BARS: number = 128;

/** Samples drawn by the wave edge generator. */
const WAVE_EDGE_SAMPLES: number = 256;

/**
 * Width of the 1D waveform texture the trace generator reads.
 *
 * Coarse on purpose. The texture samples linearly, so the trace is an
 * interpolated curve through this many points rather than a faithful rendering
 * of the buffer, and the shape stays legible instead of dissolving into detail.
 */
const WAVE_TEXTURE_WIDTH: number = 128;

/**
 * Trace deflection at unit amplitude, as a fraction of the surface height.
 *
 * These four are Warp's, so the two read as the same kind of trace.
 */
const TRACE_AMPLITUDE: number = 0.34;

/**
 * Gaussian falloff width of the trace. Smaller is tighter.
 *
 * Warp draws at 0.00025, but it is not the same picture: here the trace is
 * added to the surface every step and the warp carries each copy off before the
 * next lands, so the band thickens against its own trail in a way Warp's does
 * not. Roughly a third of Warp's width lands the drawn trace about where its
 * accumulated one sits.
 */
const TRACE_SIGMA: number = 0.00008;

/** Brightness of the trace where it is thickest. */
const TRACE_GAIN: number = 0.85;

/** Extra trace amplitude contributed by the bass envelope. */
const TRACE_BASS_FLEX: number = 0.6;

// ============================================================================
// Audio
// ============================================================================

/** Number of low bins averaged into the bass envelope. */
const BASS_BIN_COUNT: number = 24;

/** Per-frame smoothing of the bass envelope. */
const BASS_SMOOTHING: number = 0.18;

/** Phase advance per frame, in radians, before the bass contribution. */
const PHASE_BASE_RATE: number = 0.011;

/** Extra phase advance per frame contributed by the bass envelope. */
const PHASE_BASS_RATE: number = 0.05;

/** Two pi. */
const TWO_PI: number = Math.PI * 2;

/** Bass level a hit has to clear before it can fire a pulse. */
const PULSE_BASS_THRESHOLD: number = 0.5;

/** Shortest gap between pulses, in milliseconds. */
const PULSE_COOLDOWN_MS: number = 10000;

/** Chance that a qualifying hit actually fires one. */
const PULSE_PROBABILITY: number = 0.5;

/**
 * Steps a pulse takes to travel from the centre out past the rim.
 *
 * At three frames a step this is about twelve seconds, which is long enough for
 * the dark band to read as something crossing the scene rather than a blink.
 */
const PULSE_STEPS: number = 240;

/** Palette entries above the background that the white flash reaches into. */
const PULSE_BACKGROUND_SPAN: number = 32;

/**
 * Frames between warp steps.
 *
 * Ambience::Render at 0x174A07 decrements a counter at [this+0x158] and only
 * advances the surface when it reaches zero, so the effect runs well below the
 * display's frame rate. The divisor the DLL uses has not been read; this is
 * chosen. The canvas is still drawn every frame, so the motion stays smooth.
 */
const FRAMES_PER_STEP: number = 3;

// ============================================================================
// Generator tuning
// ============================================================================

/** Intensity a generator writes at its brightest. */
const GENERATOR_GAIN: number = 0.45;

/** Intensity floor so a silent passage still leaves a trace to warp. */
const GENERATOR_FLOOR: number = 0.12;

/** Size, in pixels, of a dot-plane point. */
const DOT_POINT_SIZE: number = 2;

/** Focal length the dot plane projects through, matching the presets' dbl4. */
const DOT_FOCAL_DEFAULT: number = 384;

/** Depth the dot plane spans, as a multiple of the focal length. */
const DOT_DEPTH_SPAN: number = 2.5;

/** Speed the dot plane travels toward the viewer, in focal lengths per frame. */
const DOT_SPEED: number = 0.004;

/** Divisor turning a JiggyScribble parameter into a lobe count. */
const SCRIBBLE_LOBE_DIVISOR: number = 10;

/** Divisor turning the third JiggyScribble parameter into a radial frequency. */
const SCRIBBLE_RADIAL_DIVISOR: number = 100;

/** Radius of a scribble at rest, as a fraction of the shorter half-axis. */
const SCRIBBLE_BASE_RADIUS: number = 0.34;

/** How far the audio pushes a scribble's radius, as the same fraction. */
const SCRIBBLE_SWING: number = 0.3;

/** Radius of a JDar figure, as a fraction of the shorter half-axis. */
const JDAR_RADIUS: number = 0.62;

/** Fewest arms a JDar figure may have when its parameter is degenerate. */
const JDAR_MIN_ARMS: number = 3;

/** Depth of the notch between JDar arms. */
const JDAR_NOTCH: number = 0.45;

/** Height of a spectrum edge bar at full scale, as a fraction of the surface. */
const SPECTRUM_HEIGHT: number = 0.42;

/** Depth of a wave edge deflection, as a fraction of the surface. */
const WAVE_EDGE_DEPTH: number = 0.3;

/** Width of an edge gradient band, as a fraction of the surface. */
const EDGE_BAND: number = 0.08;

/** Rows drawn across an edge gradient band. */
const EDGE_BAND_ROWS: number = 24;

/** Length of the bright head of an edge trace, as a fraction of the perimeter. */
const EDGE_TRACE_HEAD: number = 0.12;

/** Points drawn along an edge trace head. */
const EDGE_TRACE_POINTS: number = 96;

/** Divisor turning an EdgeTrace parameter into a lap rate. */
const EDGE_TRACE_RATE_DIVISOR: number = 400;

/** Radius of a circle waveform at rest when its parameter is degenerate. */
const CIRCLE_FALLBACK_RADIUS: number = 0.45;

/** How far the audio pushes a circle waveform, as a fraction of the surface. */
const CIRCLE_SWING: number = 0.22;

/** Midpoint of the byte range that time-domain samples centre on. */
const SAMPLE_CENTRE: number = 128;

// ============================================================================
// Shaders
// ============================================================================

/** Full-screen triangle pair, shared by the warp and present passes. */
const QUAD_VERTEX_SHADER: string = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/**
 * The warp pass.
 *
 * `/*BODY*\/` is replaced with one of {@link WARP_BODIES}. A body reads `pos`
 * (the destination pixel), `size`, `centre` and `p1`..`p4`, and writes either
 * `src` directly or `th2` and `r2` for the polar epilogue to resolve. This
 * matches the engine, whose shifts overwhelmingly work by perturbing a polar
 * coordinate taken about the centre of the surface.
 */
const WARP_FRAGMENT_SHADER: string = `
precision highp float;

uniform sampler2D uSurface;
uniform vec2 uSize;
uniform vec4 uParams;
uniform float uDecay;
uniform float uPhase;
uniform float uDiffuse;
uniform float uDiffuseReach;

varying vec2 vUv;

/* Zero outside the surface, so the bounds rule is the same for every tap. */
float tap(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return texture2D(uSurface, uv).r;
}

/* An approximation of a turn, not 2*pi; the warps are written against it. */
const float TURN = 6.28;

/* Guard the engine applies before dividing by a band width. */
const float EPSILON = 1e-4;

void main() {
  vec2 size = uSize;
  vec2 centre = size * 0.5;
  vec2 pos = vUv * size;

  float p1 = uParams.x;
  float p2 = uParams.y;
  float p3 = uParams.z;
  float p4 = uParams.w;

  /* toPolar: the engine measures from the centre outward toward the pixel. */
  vec2 delta = centre - pos;
  float r = length(delta);
  float th = atan(delta.y, delta.x);

  float r2 = r;
  float th2 = th;
  vec2 src = pos;
  bool polar = true;

  /*BODY*/

  /* fromPolar, matching the engine's centre-minus-offset form. */
  if (polar) src = centre - vec2(cos(th2), sin(th2)) * r2;

  vec2 uv = src / size;
  float value = tap(uv);

  /*
   * Smoke. Blending in the four neighbours spreads every mark a little further
   * each step, and because the surface feeds itself the spreading compounds -
   * what is drawn crisp one step is a haze several steps later. Applied here
   * rather than on a layer of its own so the trace still drives the rings on
   * its way out.
   */
  if (uDiffuse > 0.0) {
    /*
     * Eight taps rather than four, and reaching further than a pixel.
     *
     * How much of a neighbour is taken sets how quickly a mark loses its edge;
     * how far away that neighbour is sets how far the mark travels while doing
     * it. Four taps at one pixel could only ever creep, and the cross shape
     * showed once the reach grew, so the diagonals are in at the radius that
     * puts them the same distance out.
     */
    vec2 reach = uDiffuseReach / size;
    vec2 corner = reach * 0.70710678;
    float neighbours = (
      tap(uv + vec2(reach.x, 0.0)) + tap(uv - vec2(reach.x, 0.0)) +
      tap(uv + vec2(0.0, reach.y)) + tap(uv - vec2(0.0, reach.y)) +
      tap(uv + corner) + tap(uv - corner) +
      tap(uv + vec2(corner.x, -corner.y)) + tap(uv - vec2(corner.x, -corner.y))
    ) * 0.125;
    value = mix(value, neighbours, uDiffuse);
  }

  gl_FragColor = vec4(value * uDecay, 0.0, 0.0, 1.0);
}
`;

/** Present pass: maps the surface's index channel through the palette. */
const PRESENT_FRAGMENT_SHADER: string = `
precision mediump float;

const float BACKGROUND_SPAN = 32.0;

uniform sampler2D uSurface;
uniform sampler2D uPalette;
uniform float uAlpha;
uniform float uPaletteShift;
uniform float uBackground;

varying vec2 vUv;

void main() {
  float index = texture2D(uSurface, vUv).r;
  /*
   * Rotate entries 1..255 and leave 0 pinned as the background.
   *
   * The ramps run dark to light without wrapping round, so rotating them drags
   * a seam through the index range. The surface is brightest where a generator
   * last drew and falls off from there, so the pixels holding the highest
   * indices reach the seam first: it surfaces in the middle and travels
   * outward. The ramps are all one hue, so what travels is darkness, not
   * colour.
   */
  float slot = index * 255.0;
  if (slot >= 1.0) slot = 1.0 + mod(slot - 1.0 + uPaletteShift, 255.0);
  /* Sample the texel centre of a 256-wide palette rather than its edge. */
  float lookup = (slot + 0.5) / 256.0;
  vec3 colour = texture2D(uPalette, vec2(lookup, 0.5)).rgb;

  /*
   * The flash takes the background white, easing out over the entries just
   * above it so the ramp does not step against it.
   */
  float low = 1.0 - clamp(slot / BACKGROUND_SPAN, 0.0, 1.0);
  colour = mix(colour, vec3(1.0), uBackground * low);

  gl_FragColor = vec4(colour * uAlpha, 1.0);
}
`;

/**
 * The horizontal trace.
 *
 * A soft band about the waveform rather than a stroke along it - the intensity
 * at a pixel is a Gaussian of its distance from the curve, so the trace is
 * thick and glowing at the centre and tails off. This is how Warp draws its
 * trace, down to the falloff width, and drawing it as a polyline instead is
 * what made the earlier attempt look faceted.
 */
const TRACE_FRAGMENT_SHADER: string = `
precision highp float;

uniform sampler2D uWaveform;
uniform float uAmplitude;
uniform float uCentre;
uniform float uGain;

varying vec2 vUv;

void main() {
  /*
   * Rotationally symmetric about the centre of the frame. The left half holds
   * the whole of the sample data, compressed into it; the right half is that
   * same curve turned through 180 degrees, so a point one side has its opposite
   * number reflected through the middle rather than mirrored across it.
   */
  float x = vUv.x;
  float turn = 1.0;
  if (x > 0.5) {
    x = 1.0 - x;
    turn = -1.0;
  }
  float level = texture2D(uWaveform, vec2(x * 2.0, 0.5)).r;
  float traceY = uCentre + turn * (level - 0.5) * uAmplitude;
  float delta = vUv.y - traceY;
  float intensity = exp(-(delta * delta) / ${TRACE_SIGMA}) * uGain;
  gl_FragColor = vec4(intensity, 0.0, 0.0, 1.0);
}
`;

/**
 * The radial waveform.
 *
 * The polar counterpart of the trace: intensity at a pixel is a Gaussian of how
 * far its radius sits from the ring, with the ring's radius at that pixel's
 * angle read from the waveform. Drawing it as a line loop meant hard, unsmoothed
 * segments - GL lines carry no coverage - and at any useful point count the
 * facets showed. This has no edges to alias.
 *
 * Warp draws its own radial waveform the same way.
 */
const RADIAL_FRAGMENT_SHADER: string = `
precision highp float;

uniform sampler2D uWaveform;
uniform vec2 uSize;
uniform float uBase;
uniform float uSwing;
uniform float uGain;

varying vec2 vUv;

const float TAU = 6.28318530718;

void main() {
  vec2 offset = vUv * uSize - uSize * 0.5;
  float radius = length(offset);
  float angle = atan(offset.y, offset.x);

  /*
   * Rectified, so the ring only ever pushes outward from its resting radius.
   * Taking the sample signed sent half of every cycle inward, which read as a
   * waveform facing into the centre with only the loudest peaks big enough to
   * clear the ring and show on the outside.
   */
  float level = texture2D(uWaveform, vec2(angle / TAU + 0.5, 0.5)).r;
  float target = uBase + abs(level - 0.5) * 2.0 * uSwing;

  /* Normalised against the height so the falloff means the same as the trace's. */
  float delta = (radius - target) / uSize.y;
  float intensity = exp(-(delta * delta) / ${RING_SIGMA}) * uGain;
  gl_FragColor = vec4(intensity, 0.0, 0.0, 1.0);
}
`;

/** Generator pass: draws lines and points straight into the index channel. */
const GENERATOR_VERTEX_SHADER: string = `
attribute vec2 aPosition;
attribute float aValue;
uniform vec2 uSize;
uniform float uPointSize;
varying float vValue;
void main() {
  vec2 clip = (aPosition / uSize) * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = uPointSize;
  vValue = aValue;
}
`;

/** Generator pass fragment stage. Blending is additive, as the engine's was. */
const GENERATOR_FRAGMENT_SHADER: string = `
precision mediump float;
varying float vValue;
void main() {
  gl_FragColor = vec4(vValue, 0.0, 0.0, 1.0);
}
`;

// ============================================================================
// Warps
// ============================================================================

/**
 * The body of each warp, keyed by the name a {@link FeedbackSpec} asks for.
 *
 * Parameters `p1`..`p4` are the spec's `warpArgs` for that stage, unchanged.
 */
export const WARP_BODIES: Readonly<Record<string, string>> = {
  /**
   * Fold the radius into bands of width dbl2 and ripple within each band, which
   * is what gives this one its standing concentric rings.
   */
  RippleWarp: `
    float maxR = max(length(size) * 0.5, EPSILON);
    /*
     * p3 flares the band width with the radius. At zero the bands are uniform,
     * as the builder has them; above zero each ring is a fatter tube than the
     * one inside it, so the set extrudes outward toward the corners instead of
     * staying an evenly spaced stack.
     */
    float band = max(abs(p2), EPSILON) * (1.0 + p3 * r / maxR);
    float k = floor(r / band);
    float frac = r - k * band;
    r2 = r - (band - frac) * frac / band;
    th2 = th + p1;
    if (r2 <= 0.0) { polar = false; src = pos; }
  `,
};

// ============================================================================
// Preset shape
// ============================================================================

/** A generator stage: its class name and the parameters the preset gave it. */
export interface GeneratorStage {
  /** Generator name, without the leading `C`. */
  readonly kind: string;

  /** The stage's `dbl1`..`dbl8`. */
  readonly args: readonly number[];
}

/** Everything one visualization in either bank needs in order to run. */
export interface FeedbackSpec {
  /** Display name. */
  readonly name: string;

  /** Category the visualization is filed under. */
  readonly category: string;

  /** Key into {@link WARP_BODIES}. */
  readonly warp: string;

  /** The warp's four parameters. */
  readonly warpArgs: readonly number[];

  /** Generators drawn before the warp. */
  readonly pre: readonly GeneratorStage[];

  /** Generators drawn after the warp. */
  readonly post: readonly GeneratorStage[];

  /** 256 packed RGB triples, one byte per channel. */
  readonly palette: Uint8Array;

  /**
   * How much of each pixel is taken from its neighbours per step, 0 to 1.
   *
   * The smoke. Because the surface feeds itself, a little spreading per step
   * compounds into a haze over several.
   */
  readonly diffuse: number;

  /**
   * How far the smoke's taps reach, in pixels.
   *
   * The other half of the smoke. The mix sets how fast a mark softens, this sets
   * how far it gets while softening, and because the surface feeds itself both
   * compound over the steps a mark survives.
   */
  readonly diffuseReach: number;

  /**
   * Whether a loud bass hit can fire a pulse.
   *
   * A pulse sweeps the palette through one full rotation, which sends a dark
   * band out from the centre, and takes the background white while it runs.
   */
  readonly pulses: boolean;
}

/**
 * Splits a `Name a b c d` generator string into its parts.
 *
 * @param source - One entry of a preset's `pre` or `post` list
 * @returns The generator name and its numeric parameters
 */
export function parseGeneratorStage(source: string): GeneratorStage {
  const parts: string[] = source.trim().split(/\s+/);
  return {
    kind: parts[0],
    args: parts.slice(1).map((value: string): number => Number(value)),
  };
}

/**
 * Splits a whitespace-separated parameter string into numbers.
 *
 * @param source - A preset's `shiftArgs`
 * @returns The parsed parameters
 */
export function parseArgs(source: string): number[] {
  if (!source) return [];
  return source.trim().split(/\s+/).map((value: string): number => Number(value));
}

/**
 * Expands a 1536-character `RRGGBB` palette string into packed RGB bytes.
 *
 * @param hex - 256 entries of six hex characters
 * @returns 768 bytes, three per palette entry
 */
export function parsePalette(hex: string): Uint8Array {
  const bytes: Uint8Array = new Uint8Array(PALETTE_SIZE * RGB_STRIDE);
  for (let i: number = 0; i < PALETTE_SIZE; i++) {
    const at: number = i * PALETTE_HEX_STRIDE;
    bytes[i * RGB_STRIDE] = parseInt(hex.substring(at, at + 2), HEX_RADIX);
    bytes[i * RGB_STRIDE + 1] = parseInt(hex.substring(at + 2, at + 4), HEX_RADIX);
    bytes[i * RGB_STRIDE + 2] = parseInt(hex.substring(at + 4, at + 6), HEX_RADIX);
  }
  return bytes;
}

/**
 * Builds a 256-entry palette by interpolating between `RRGGBB` stops.
 *
 * The way a visualization names a handful of colours and gets a full ramp
 * without carrying 256 entries of its own.
 *
 * @param stops - Two or more hex colours
 * @returns 1536 hex characters, ready for {@link parsePalette}
 */
export function rampPalette(stops: readonly string[]): string {
  const segments: number = stops.length - 1;
  let out: string = '';
  for (let i: number = 0; i < PALETTE_SIZE; i++) {
    const t: number = (i / (PALETTE_SIZE - 1)) * segments;
    const index: number = Math.min(Math.floor(t), segments - 1);
    const f: number = t - index;
    let entry: string = '';
    for (let c: number = 0; c < RGB_STRIDE; c++) {
      const at: number = c * 2;
      const a: number = parseInt(stops[index].substring(at, at + 2), HEX_RADIX);
      const b: number = parseInt(stops[index + 1].substring(at, at + 2), HEX_RADIX);
      entry += Math.round(a + (b - a) * f).toString(HEX_RADIX).padStart(2, '0');
    }
    out += entry.toUpperCase();
  }
  return out;
}

// ============================================================================
// Engine
// ============================================================================

/**
 * The shared warp-and-decay engine.
 *
 * A subclass supplies a {@link FeedbackSpec} and nothing else; a visualization
 * built on this is one instance of this class with different data.
 */
export abstract class FeedbackVisualization extends WebGLVisualization {
  public readonly name: string;
  public readonly category: string;

  /** The preset this instance runs. */
  private readonly spec: FeedbackSpec;

  /** Compiled programs, one per pass. */
  private warpProgram: WebGLProgram | null = null;
  private presentProgram: WebGLProgram | null = null;
  private generatorProgram: WebGLProgram | null = null;

  /** Full-screen quad shared by the warp and present passes. */
  private quadBuffer: WebGLBuffer | null = null;

  /** Vertex buffer the generators stream into. */
  private generatorBuffer: WebGLBuffer | null = null;

  /** The trace pass, and the 1D waveform texture it reads. */
  private traceProgram: WebGLProgram | null = null;
  private readonly traceUniforms: Record<string, WebGLUniformLocation | null> = {};

  /** The radial waveform pass. */
  private radialProgram: WebGLProgram | null = null;
  private readonly radialUniforms: Record<string, WebGLUniformLocation | null> = {};
  private waveTexture: WebGLTexture | null = null;
  private readonly waveTexels: Uint8Array<ArrayBuffer> =
    new Uint8Array(WAVE_TEXTURE_WIDTH * RGBA_STRIDE) as Uint8Array<ArrayBuffer>;

  /** Ping-pong colour attachments holding the indexed surface. */
  private readonly surfaceTextures: (WebGLTexture | null)[] = [null, null];
  private readonly surfaceBuffers: (WebGLFramebuffer | null)[] = [null, null];

  /** Index of the attachment holding the current frame. */
  private front: number = 0;

  /** The preset's palette, as a 256 by 1 texture. */
  private paletteTexture: WebGLTexture | null = null;

  /** Cached uniform locations. */
  private readonly warpUniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly presentUniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly generatorUniforms: Record<string, WebGLUniformLocation | null> = {};

  /** Dimensions of the internal surface. */
  private surfaceWidth: number = 0;
  private surfaceHeight: number = 0;

  /** Time-domain samples. */
  private samples: Uint8Array<ArrayBuffer>;

  /** Frequency bins. */
  private bins: Uint8Array<ArrayBuffer>;

  /** Staging array the generators write vertices into. */
  private readonly vertices: Float32Array<ArrayBuffer> =
    new Float32Array(MAX_VERTICES * VERTEX_STRIDE) as Float32Array<ArrayBuffer>;


  /** Smoothed bass level, 0 to 1. */
  private bass: number = 0;

  /** Frames since the last warp step, against {@link FRAMES_PER_STEP}. */
  private sinceStep: number = 0;

  /** Progress through a pulse, 0 to 1. Negative when none is running. */
  private pulse: number = -1;

  /** When the last bass hit was considered, for the cooldown. */
  private lastPulseAttempt: number = Number.NEGATIVE_INFINITY;

  /**
   * Accumulated phase, in radians.
   *
   * Generators move off this rather than off wall-clock time, so their motion
   * stays tied to the audio. It is wrapped to keep its precision over a long
   * session.
   */
  private phase: number = 0;

  protected constructor(config: VisualizationConfig, spec: FeedbackSpec) {
    super(config);
    this.spec = spec;
    this.name = spec.name;
    this.category = spec.category;
    this.samples = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.bins = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this.initGL();
  }

  protected override onFftSizeChanged(): void {
    this.samples = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.bins = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  // ==========================================================================
  // Setup
  // ==========================================================================

  /** Compiles the three programs and uploads the palette. */
  private initGL(): void {
    const gl: WebGLRenderingContext = this.gl;

    const body: string = WARP_BODIES[this.spec.warp];
    if (!body) throw new Error(`Unknown warp: ${this.spec.warp}`);

    this.warpProgram = this.createProgram(
      QUAD_VERTEX_SHADER,
      WARP_FRAGMENT_SHADER.replace('/*BODY*/', body)
    );
    this.presentProgram = this.createProgram(QUAD_VERTEX_SHADER, PRESENT_FRAGMENT_SHADER);
    this.generatorProgram = this.createProgram(
      GENERATOR_VERTEX_SHADER,
      GENERATOR_FRAGMENT_SHADER
    );
    this.traceProgram = this.createProgram(QUAD_VERTEX_SHADER, TRACE_FRAGMENT_SHADER);
    for (const key of ['uWaveform', 'uAmplitude', 'uCentre', 'uGain']) {
      this.traceUniforms[key] = gl.getUniformLocation(this.traceProgram, key);
    }

    this.radialProgram = this.createProgram(QUAD_VERTEX_SHADER, RADIAL_FRAGMENT_SHADER);
    for (const key of ['uWaveform', 'uSize', 'uBase', 'uSwing', 'uGain']) {
      this.radialUniforms[key] = gl.getUniformLocation(this.radialProgram, key);
    }

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

    for (const key of [
      'uSurface', 'uSize', 'uParams', 'uDecay', 'uPhase', 'uDiffuse', 'uDiffuseReach',
    ]) {
      this.warpUniforms[key] = gl.getUniformLocation(this.warpProgram, key);
    }
    for (const key of ['uSurface', 'uPalette', 'uAlpha', 'uPaletteShift', 'uBackground']) {
      this.presentUniforms[key] = gl.getUniformLocation(this.presentProgram, key);
    }
    for (const key of ['uSize', 'uPointSize']) {
      this.generatorUniforms[key] = gl.getUniformLocation(this.generatorProgram, key);
    }

    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    this.generatorBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.generatorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);

    this.uploadPalette();
  }

  /** Uploads the preset's palette as a 256 by 1 RGBA texture. */
  private uploadPalette(): void {
    const gl: WebGLRenderingContext = this.gl;
    const texels: Uint8Array = new Uint8Array(PALETTE_SIZE * RGBA_STRIDE);
    for (let i: number = 0; i < PALETTE_SIZE; i++) {
      texels[i * RGBA_STRIDE] = this.spec.palette[i * RGB_STRIDE];
      texels[i * RGBA_STRIDE + 1] = this.spec.palette[i * RGB_STRIDE + 1];
      texels[i * RGBA_STRIDE + 2] = this.spec.palette[i * RGB_STRIDE + 2];
      texels[i * RGBA_STRIDE + 3] = CHANNEL_MAX;
    }

    this.paletteTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, PALETTE_SIZE, 1, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, texels
    );
  }

  /**
   * Compiles and links a program.
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

  /** (Re)creates the ping-pong attachments at the current surface size. */
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
      // Linear sampling is what keeps the warp smooth instead of blocky; the
      // bounds test in the shader is then the only edge rule that applies.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const buffer: WebGLFramebuffer | null = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.clearColor(0, 0, 0, 1);
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
    if (!this.warpProgram || !this.presentProgram || !this.generatorProgram) return;

    this.analyser.getByteTimeDomainData(this.samples);
    this.analyser.getByteFrequencyData(this.bins);
    this.updateEnvelope();

    // The surface advances on a divider, but the canvas is drawn every frame.
    this.sinceStep++;
    if (this.sinceStep >= FRAMES_PER_STEP) {
      this.sinceStep = 0;
      // The engine's frame order: pre-shift generators are laid down, warped in
      // the same frame, then post-shift generators go on top untouched.
      this.uploadWaveform();
      this.runGenerators(this.spec.pre);
      this.runWarp();
      this.runGenerators(this.spec.post);
      this.updatePulse();
    }
    this.present();
  }

  /** Packs the time-domain samples into the texture the trace pass reads. */
  private uploadWaveform(): void {
    const gl: WebGLRenderingContext = this.gl;
    const length: number = this.samples.length;
    for (let i: number = 0; i < WAVE_TEXTURE_WIDTH; i++) {
      const fraction: number = i / WAVE_TEXTURE_WIDTH;
      const index: number = Math.min(length - 1, Math.floor(fraction * length));
      this.waveTexels[i * RGBA_STRIDE] = length > 0 ? this.samples[index] : SAMPLE_CENTRE;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.waveTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, WAVE_TEXTURE_WIDTH, 1,
      gl.RGBA, gl.UNSIGNED_BYTE, this.waveTexels
    );
  }

  /**
   * Draws the horizontal trace across the surface.
   *
   * dbl1 scales the deflection, dbl2 offsets the trace vertically as a fraction
   * of the surface.
   *
   * @param args - The stage's dbl1..dbl4
   */
  private runTrace(args: readonly number[]): void {
    const gl: WebGLRenderingContext = this.gl;
    if (!this.traceProgram) return;

    gl.useProgram(this.traceProgram);
    this.bindQuad(this.traceProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.waveTexture);
    gl.uniform1i(this.traceUniforms['uWaveform'], 0);
    gl.uniform1f(
      this.traceUniforms['uAmplitude'],
      TRACE_AMPLITUDE * (args[0] ?? 1) * this.sensitivityFactor
        * (1 + this.bass * TRACE_BASS_FLEX)
    );
    gl.uniform1f(this.traceUniforms['uCentre'], 0.5 + (args[1] ?? 0));
    gl.uniform1f(this.traceUniforms['uGain'], TRACE_GAIN);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // The geometry generators that may follow expect their own program bound.
    gl.useProgram(this.generatorProgram);
  }

  /**
   * Draws the radial waveform as a ring about the centre.
   *
   * dbl3 is the resting radius as a fraction of the shorter half-axis, matching
   * what the presets pass.
   *
   * @param args - The stage's dbl1..dbl4
   */
  private runRadial(args: readonly number[]): void {
    const gl: WebGLRenderingContext = this.gl;
    if (!this.radialProgram) return;

    const unit: number = Math.min(this.surfaceWidth, this.surfaceHeight) * 0.5;
    const fraction: number = args[2] && args[2] > 0 ? args[2] : CIRCLE_FALLBACK_RADIUS;

    gl.useProgram(this.radialProgram);
    this.bindQuad(this.radialProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.waveTexture);
    gl.uniform1i(this.radialUniforms['uWaveform'], 0);
    gl.uniform2f(this.radialUniforms['uSize'], this.surfaceWidth, this.surfaceHeight);
    gl.uniform1f(this.radialUniforms['uBase'], unit * fraction);
    gl.uniform1f(
      this.radialUniforms['uSwing'],
      unit * CIRCLE_SWING * this.sensitivityFactor
    );
    gl.uniform1f(this.radialUniforms['uGain'], RING_GAIN);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.useProgram(this.generatorProgram);
  }

  /**
   * Advances a running pulse, or considers starting one.
   *
   * A hit has to clear the threshold, the cooldown has to have expired, and
   * then it only fires half the time - so the flash stays an event rather than
   * a rhythm. The cooldown restarts whether or not the roll succeeds, which is
   * how Reactor spaces its own.
   */
  private updatePulse(): void {
    if (!this.spec.pulses) return;

    if (this.pulse >= 0) {
      this.pulse += 1 / PULSE_STEPS;
      if (this.pulse >= 1) this.pulse = -1;
      return;
    }

    const now: number = performance.now();
    if (this.bass < PULSE_BASS_THRESHOLD) return;
    if (now - this.lastPulseAttempt < PULSE_COOLDOWN_MS) return;

    this.lastPulseAttempt = now;
    if (Math.random() < PULSE_PROBABILITY) this.pulse = 0;
  }

  /** Advances the bass envelope and the phase it drives. */
  private updateEnvelope(): void {
    const count: number = Math.min(BASS_BIN_COUNT, this.bins.length);
    if (count > 0) {
      let total: number = 0;
      for (let i: number = 0; i < count; i++) total += this.bins[i];
      const level: number = (total / count / CHANNEL_MAX) * this.sensitivityFactor;
      this.bass += (level - this.bass) * BASS_SMOOTHING;
    }
    this.phase = (this.phase + PHASE_BASE_RATE + this.bass * PHASE_BASS_RATE) % TWO_PI;
  }

  /** Runs the warp into the back attachment, then swaps. */
  private runWarp(): void {
    const gl: WebGLRenderingContext = this.gl;
    const back: number = 1 - this.front;
    const args: readonly number[] = this.spec.warpArgs;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.surfaceBuffers[back]);
    gl.viewport(0, 0, this.surfaceWidth, this.surfaceHeight);
    gl.disable(gl.BLEND);
    gl.useProgram(this.warpProgram);
    this.bindQuad(this.warpProgram!);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.surfaceTextures[this.front]);
    gl.uniform1i(this.warpUniforms['uSurface'], 0);
    gl.uniform2f(this.warpUniforms['uSize'], this.surfaceWidth, this.surfaceHeight);
    gl.uniform4f(
      this.warpUniforms['uParams'],
      args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0
    );
    gl.uniform1f(this.warpUniforms['uDecay'], SURFACE_DECAY);
    gl.uniform1f(this.warpUniforms['uDiffuse'], this.spec.diffuse);
    gl.uniform1f(this.warpUniforms['uDiffuseReach'], this.spec.diffuseReach);
    gl.uniform1f(this.warpUniforms['uPhase'], this.phase);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.front = back;
  }

  /** Draws the canvas from the current attachment through the palette. */
  private present(): void {
    const gl: WebGLRenderingContext = this.gl;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.presentProgram);
    this.bindQuad(this.presentProgram!);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.surfaceTextures[this.front]);
    gl.uniform1i(this.presentUniforms['uSurface'], 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.uniform1i(this.presentUniforms['uPalette'], 1);
    gl.uniform1f(this.presentUniforms['uAlpha'], this.getFadeMultiplier());
    // Idle sits at zero shift and no flash, so the palette is simply itself.
    gl.uniform1f(
      this.presentUniforms['uPaletteShift'],
      this.pulse >= 0 ? this.pulse * CHANNEL_MAX : 0
    );
    gl.uniform1f(
      this.presentUniforms['uBackground'],
      this.pulse >= 0 ? 1 - this.pulse : 0
    );

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Points a program's `aPosition` attribute at the full-screen quad.
   *
   * @param program - The program about to draw
   */
  private bindQuad(program: WebGLProgram): void {
    const gl: WebGLRenderingContext = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const location: number = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  }

  // ==========================================================================
  // Generators
  // ==========================================================================

  /**
   * Draws every generator in a stage list into the current attachment.
   *
   * @param stages - The preset's pre- or post-shift generators
   */
  private runGenerators(stages: readonly GeneratorStage[]): void {
    if (stages.length === 0) return;

    const gl: WebGLRenderingContext = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.surfaceBuffers[this.front]);
    gl.viewport(0, 0, this.surfaceWidth, this.surfaceHeight);
    gl.enable(gl.BLEND);
    // The engine wrote generator output straight over the surface additively,
    // letting indices pile up where strokes cross.
    gl.blendFunc(gl.ONE, gl.ONE);

    // Both generators are full-screen passes rather than geometry, so neither
    // stages vertices; an unknown name simply draws nothing.
    for (const stage of stages) {
      if (stage.kind === 'Trace') this.runTrace(stage.args);
      else if (stage.kind === 'CircleWaveform') this.runRadial(stage.args);
    }

    gl.disable(gl.BLEND);
  }

  /**
   * Reads a time-domain sample as a signed deflection.
   *
   * @param fraction - Position along the buffer, 0 to 1
   * @returns Deflection scaled by sensitivity, roughly -1 to 1
   */
  private sampleAt(fraction: number): number {
    const length: number = this.samples.length;
    if (length === 0) return 0;
    const index: number = Math.min(length - 1, Math.floor(fraction * length));
    return ((this.samples[index] - SAMPLE_CENTRE) / SAMPLE_CENTRE) * this.sensitivityFactor;
  }

  /**
   * Reads a frequency bin.
   *
   * @param fraction - Position across the spectrum, 0 to 1
   * @returns Magnitude scaled by sensitivity, 0 upward
   */
  private binAt(fraction: number): number {
    const length: number = this.bins.length;
    if (length === 0) return 0;
    const index: number = Math.min(length - 1, Math.floor(fraction * length));
    return (this.bins[index] / CHANNEL_MAX) * this.sensitivityFactor;
  }

  public override destroy(): void {
    const gl: WebGLRenderingContext = this.gl;
    this.deleteSurfaces();
    if (this.paletteTexture) gl.deleteTexture(this.paletteTexture);
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
    if (this.generatorBuffer) gl.deleteBuffer(this.generatorBuffer);
    if (this.warpProgram) gl.deleteProgram(this.warpProgram);
    if (this.presentProgram) gl.deleteProgram(this.presentProgram);
    if (this.generatorProgram) gl.deleteProgram(this.generatorProgram);
    if (this.traceProgram) gl.deleteProgram(this.traceProgram);
    if (this.radialProgram) gl.deleteProgram(this.radialProgram);
    if (this.waveTexture) gl.deleteTexture(this.waveTexture);
    super.destroy();
  }
}

/**
 * Wraps a spec in a concrete class the visualization factory can instantiate.
 *
 * @param spec - The preset to run
 * @returns A constructor for that preset
 */
export function feedbackVisualization(
  spec: FeedbackSpec
): new (config: VisualizationConfig) => Visualization {
  return class extends FeedbackVisualization {
    public constructor(config: VisualizationConfig) {
      super(config, spec);
    }
  };
}

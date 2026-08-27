/**
 * @fileoverview Shared engine for the two Windows Media Player effect banks.
 *
 * Both "Battery" and "Ambience" in `wmp.dll` are the same machine: an 8-bit
 * indexed surface that is warped into itself every frame, decayed by one
 * palette index, and drawn into by a handful of audio-driven generators. Only
 * three things vary between them - the warp, the generators, and the palette.
 *
 * The frame order below is the engine's own: generators registered as
 * `PreShift` draw first and are warped in the same frame, the warp runs, then
 * `PostShift` generators draw on top and stay crisp until the next frame.
 *
 * ## What is recovered and what is interpreted
 *
 * The warp bodies in {@link WARP_BODIES} are transcriptions of the `Apply`
 * method of each shift class in `wmp.dll`, down to the constants the engine
 * uses (its own 6.28 for a turn, its half-width and half-height terms, the
 * order the radius and angle are perturbed in). The preset parameters and
 * palettes are the DLL's own data.
 *
 * The generators are not transcriptions. The engine rasterises them with
 * private drawing helpers that would have to be reproduced pixel by pixel to
 * port exactly; what is here reproduces their shape and their relationship to
 * the audio, driven by the same parameter values.
 *
 * No visualization here changes what it is at random. Where the original
 * re-rolled a value that decides character - the per-pixel jitter in Swirl, the
 * palettes of the eight unlocked Battery presets - a fixed substitute is used,
 * so a given entry always behaves the same way.
 *
 * The one exception is the pulse, which fires off a loud bass hit and then only
 * some of the time. That is a response to the audio rather than a choice about
 * what the visualization is, and it is how Reactor gates its own flash.
 *
 * @module app/components/audio/audio-outlet/visualizations/wmp-feedback-engine
 */

import {Visualization, VisualizationConfig, WebGLVisualization} from './visualization';

// ============================================================================
// Surface
// ============================================================================

/**
 * Height of the internal surface, in pixels.
 *
 * The warps scale off the surface dimensions, so this doubles as the scale the
 * preset parameters were tuned against. WMP ran Battery in a window of roughly
 * this height.
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

/** Points around a closed waveform ring. */
const RING_POINTS: number = 256;

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

/** Width of the 1D waveform texture the trace generator reads. */
const WAVE_TEXTURE_WIDTH: number = 512;

/**
 * Trace deflection at unit amplitude, as a fraction of the surface height.
 *
 * These four are Warp's, so the two read as the same kind of trace.
 */
const TRACE_AMPLITUDE: number = 0.34;

/** Gaussian falloff width of the trace. Smaller is tighter. */
const TRACE_SIGMA: number = 0.00025;

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

varying vec2 vUv;

/*
 * The engine's own approximation of a turn. It is not 2*pi, and Starburst and
 * Swirl visibly depend on the difference, so it is kept as written.
 */
const float WMP_TURN = 6.28;

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
  float value = 0.0;
  if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
    value = texture2D(uSurface, uv).r;
  }

  gl_FragColor = vec4(value * uDecay, 0.0, 0.0, 1.0);
}
`;

/** Present pass: maps the surface's index channel through the palette. */
const PRESENT_FRAGMENT_SHADER: string = `
precision mediump float;

const float BACKGROUND_SPAN = 32.0;

uniform sampler2D uSurface;
uniform sampler2D uSmoke;
uniform sampler2D uPalette;
uniform float uAlpha;
uniform float uPaletteShift;
uniform float uBackground;

varying vec2 vUv;

void main() {
  /*
   * The warped surface carries the rings; the smoke layer is only ever aged, so
   * what is drawn on it holds its shape instead of being dragged through the
   * displacement. Added and clamped, matching the 'lighter' composite Reactor
   * lays its trails down with.
   */
  float index = min(texture2D(uSurface, vUv).r + texture2D(uSmoke, vUv).r, 1.0);
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
 * Ages the unwarped layer.
 *
 * Not a fade in place: the layer is resampled a fraction of a degree round the
 * centre and drawn back a touch larger every step, then multiplied down.
 * Bilinear filtering smears it a little further on each pass, and that repeated
 * resampling is what turns a drawn trace into smoke rather than a line getting
 * dimmer. Reactor reaches the same result by redrawing its trail canvas under a
 * small rotation with image smoothing left on.
 */
const SMOKE_FRAGMENT_SHADER: string = `
precision highp float;

uniform sampler2D uLayer;
uniform vec2 uSize;
uniform float uAngle;
uniform float uFade;
uniform float uSpread;

varying vec2 vUv;

void main() {
  vec2 centre = uSize * 0.5;
  vec2 delta = (vUv * uSize - centre) * (1.0 - uSpread);
  float s = sin(uAngle);
  float c = cos(uAngle);
  vec2 uv = (vec2(delta.x * c - delta.y * s, delta.x * s + delta.y * c) + centre) / uSize;

  float value = 0.0;
  if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
    value = texture2D(uLayer, uv).r;
  }
  gl_FragColor = vec4(value * uFade, 0.0, 0.0, 1.0);
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
 * The warp of each shift class in `wmp.dll`, transcribed from its `Apply`.
 *
 * Keys are the class names with the leading `C` removed, as they appear in
 * {@link import('./battery-presets').BatteryPreset.shift}. Parameters `p1`..`p4`
 * are the registry's `dbl1`..`dbl4` for that stage, unchanged.
 */
export const WARP_BODIES: Readonly<Record<string, string>> = {
  /** x and y each advance by a constant. The only shift with no polar step. */
  LinearShift: `
    polar = false;
    src = pos + vec2(p1, p2);
  `,

  /**
   * Rotate, then pull the radius in proportionally to how far out it already
   * is. `size.x` rather than a half-width is what the engine multiplies by.
   */
  ZoomShift: `
    float maxR = max(length(size) * 0.5, EPSILON);
    r2 = r - size.x * p2 * (r / maxR);
    th2 = th + p1;
  `,

  /**
   * Cubic radial pull with a rotation that grows with the radius, so the
   * middle holds still and the rim shears away.
   */
  StretchShift: `
    float amp = size.y * p2;
    float u = size.x >= 2.0 ? r / (size.x * 0.5) : 0.0;
    r2 = r - amp * u * u * u;
    th2 = th + p1 * u;
  `,

  /**
   * Quantise the radius into rings and pull each pixel back toward the ring it
   * sits in, which is what stacks the surface into concentric bands.
   */
  RingSpinShift: `
    float ring = (size.y * 0.5) * p2;
    if (abs(ring) < EPSILON) ring = EPSILON;
    float frac = r - floor(r / ring + 0.5) * ring;
    r2 = r - frac * frac / ring;
    th2 = th + p1;
  `,

  /** The same quantise-and-pull, applied to x and y independently. */
  TileShift: `
    polar = false;
    float tile = size.y * p1;
    if (abs(tile) < EPSILON) tile = EPSILON;
    float fx = pos.x - floor(pos.x / tile + 0.5) * tile;
    float fy = pos.y - floor(pos.y / tile + 0.5) * tile;
    float kx = fx / tile;
    float ky = fy / tile;
    src = pos - vec2(fx * kx * kx * kx, fy * ky * ky * ky);
  `,

  /**
   * Two forms, chosen by dbl4. Non-zero runs a smooth sine star of dbl3 arms;
   * zero runs hard wedges that alternately push out and pull in.
   */
  StarburstShift: `
    float amp = size.y * p2;
    float u = r / (size.x * 0.5);
    if (p4 != 0.0) {
      float lobes = floor(p3 + 0.5);
      float us = u * sin(lobes * th);
      r2 = r + amp * us * us * us;
      th2 = th + p1 * us;
    } else {
      float arms = p3 == 0.0 ? 1.0 : p3;
      float wedge = floor(th / (WMP_TURN / arms) + 0.5);
      float flip = mod(abs(wedge), 2.0) >= 1.0 ? 1.0 : -1.0;
      r2 = r + flip * amp * u * u * u;
      th2 = th + p1 * u;
    }
  `,

  /**
   * A sinusoidal shear of the pixel itself, then a rotation and a radial
   * ripple keyed to the new angle. The engine also added a two-pixel random
   * jitter here; a fixed checker offset stands in for it so the smoke it
   * produced survives without the frame-to-frame randomness.
   */
  SwirlShift: `
    vec2 q = pos;
    q.x += p2 * sin(p3 * WMP_TURN * q.y / size.y);
    q.y += p2 * cos(p3 * WMP_TURN * q.x / size.x);
    vec2 d2 = centre - q;
    th2 = atan(d2.y, d2.x) + p1;
    r2 = length(d2) - p2 * sin(p3 * th2);
    src = centre - vec2(cos(th2), sin(th2)) * r2;
    src += vec2(mod(floor(pos.x), 2.0), mod(floor(pos.y), 2.0)) * 2.0 - 1.0;
    polar = false;
  `,

  /**
   * Radius held, angle rippled by a cosine of the reciprocal radius, so the
   * twist tightens sharply toward the centre.
   */
  Twirlocity: `
    float cy = size.y * 0.5;
    float v = p3 != 0.0
      ? (r > 0.0 ? cy / r : 0.0)
      : (cy > 0.0 ? r / cy : 0.0);
    th2 = th + p2 * cos(3.14159274 * p1 * v);
    r2 = r;
  `,

  /**
   * The workhorse: creep outward by dbl1, then twist by an amount that grows
   * linearly with the radius and is rippled by a cosine of it. Eight of the
   * twenty-five Battery presets are built on this one.
   */
  Shiitake: `
    float cy = size.y * 0.5;
    r2 = r + p1;
    float w = cy != 0.0 ? (6.2831855 * r2 / cy) : r2;
    th2 = th + p2 * cos(p4 * w) + p3 * w;
  `,

  /** Radius and angle both displaced by a quarter-width falloff. */
  ThingusShift: `
    float q = floor(size.x / 4.0);
    float denom = floor(size.x / 2.0) + q;
    float t = (q - r) / denom;
    r2 = r + size.x * p2 * t;
    th2 = th + p1 * t;
  `,

  // --------------------------------------------------------------------------
  // Ambience displacements
  //
  // The Ambience effect precomputes a per-pixel source index rather than
  // warping analytically, but the builder for each of its fields is the same
  // shape of maths, so they live here alongside the Battery shifts.
  // --------------------------------------------------------------------------

  /** Rotate by a constant and draw the radius in by a constant. */
  AmbienceSpiral: `
    r2 = r - p2;
    th2 = th + p1;
    if (r2 <= 0.0) { polar = false; src = pos; }
  `,

  /**
   * Rotate by a constant, with a radial flow whose speed is graded by the
   * radius. A negative dbl2 grades it the other way, fastest at the centre.
   */
  AmbienceFlow: `
    float maxR = max(length(size) * 0.5, EPSILON);
    float u = p2 > 0.0 ? (r / maxR) : ((maxR - r) / maxR);
    r2 = r - p2 * u;
    th2 = th + p1;
    if (r2 <= 0.0) { polar = false; src = pos; }
  `,

  /** As the flow, but the rotation itself is graded by the radius: a shear. */
  AmbienceShear: `
    float maxR = max(length(size) * 0.5, EPSILON);
    float g = r / maxR;
    float u = p2 > 0.0 ? g : (1.0 - g);
    r2 = r - p2 * u;
    th2 = th - p1 * g;
    if (r2 <= 0.0) { polar = false; src = pos; }
  `,

  /**
   * Fold the radius into bands of width dbl2 and ripple within each band, which
   * is what gives this one its standing concentric rings.
   */
  AmbienceRipple: `
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

  /**
   * Cubic radial pinch, clamped so the centre never inverts.
   *
   * The builder takes only an angle; its cubic coefficient comes from the
   * surface geometry rather than from the preset, and the preset that uses this
   * passes an angle of zero. PINCH_RATE below stands in for that internal
   * coefficient, which is why this is the one warp with a tuned constant.
   */
  AmbiencePinch: `
    const float PINCH_RATE = 0.06;
    float maxR = max(length(size) * 0.5, EPSILON);
    float u = r / maxR;
    float t = clamp(PINCH_RATE * u * u * u, 0.0, 1.0);
    r2 = r * (1.0 - t);
    th2 = th + p1;
    if (r2 <= 0.0) { polar = false; src = pos; }
  `,

  /**
   * A sixth-order falloff from the rim inward, so almost all of the movement
   * happens in the middle of the surface and the edges sit still.
   */
  AmbienceSuck: `
    float maxR = max(length(size) * 0.5, EPSILON);
    float v = 1.0 - r / maxR;
    float v2 = v * v;
    float poly = v + v2 + v2 * v + v2 * v2 + v2 * v2 * v + v2 * v2 * v2;
    r2 = r - poly;
    th2 = th + p1 * 0.05;
    if (r2 <= 0.0) { polar = false; src = pos; }
  `,

  /**
   * Cubic zoom about the centre with no rotation. Both of the builder's
   * integer arguments feed the profile: p1 sets the pull near the centre and
   * p2 the pull at the rim, so the surface accelerates as it flies out.
   */
  AmbienceZoomCubic: `
    float maxR = max(length(size) * 0.5, EPSILON);
    float u = r / maxR;
    r2 = r - u * (p1 + (p2 - p1) * u * u);
    th2 = th;
    if (r2 <= 0.0) { polar = false; src = pos; }
  `,

  /**
   * Radial draw-in with the angle stepped in sectors, which breaks the flow
   * into petals rather than a smooth spiral.
   */
  AmbiencePetal: `
    float sectors = max(floor(abs(p3)), 1.0);
    float step = 6.2831855 / sectors;
    float sector = floor(th / step + 0.5) * step;
    r2 = r - p2;
    th2 = th + p1 * (th - sector);
    if (r2 <= 0.0) { polar = false; src = pos; }
  `,

  /**
   * Quarter-width falloff applied to both radius and angle, the same shape the
   * Battery engine used for Thingus.
   */
  AmbienceTwist: `
    float q = size.x * 0.25;
    float t = (q - r) / max(q, EPSILON);
    r2 = r + p2 * t;
    th2 = th + p1 * t;
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
   * Generators drawn onto the unwarped smoke layer.
   *
   * Content here holds its shape and only ages, so it overlaps the warped
   * surface without being pulled through the displacement.
   */
  readonly smoke: readonly GeneratorStage[];

  /** Multiplier applied to the smoke layer each step. */
  readonly smokeFade: number;

  /** Radians the smoke layer turns per step. */
  readonly smokeAngle: number;

  /** Fraction the smoke layer creeps outward per step. */
  readonly smokeSpread: number;

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
 * Used for the Battery presets WMP shipped unlocked, which generated a fresh
 * random palette every run.
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
 * The shared warp-and-decay engine behind both WMP effect banks.
 *
 * A subclass supplies a {@link FeedbackSpec} and nothing else; every preset in
 * either bank is one instance of this class with different data.
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

  /** The unwarped smoke layer, ping-ponged because it resamples itself. */
  private readonly smokeTextures: (WebGLTexture | null)[] = [null, null];
  private readonly smokeBuffers: (WebGLFramebuffer | null)[] = [null, null];
  private smokeFront: number = 0;
  private smokeProgram: WebGLProgram | null = null;
  private readonly smokeUniforms: Record<string, WebGLUniformLocation | null> = {};

  /** The trace pass, and the 1D waveform texture it reads. */
  private traceProgram: WebGLProgram | null = null;
  private readonly traceUniforms: Record<string, WebGLUniformLocation | null> = {};
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

  /** Vertices written so far this generator. */
  private vertexCount: number = 0;

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
    this.smokeProgram = this.createProgram(QUAD_VERTEX_SHADER, SMOKE_FRAGMENT_SHADER);
    for (const key of ['uLayer', 'uSize', 'uAngle', 'uFade', 'uSpread']) {
      this.smokeUniforms[key] = gl.getUniformLocation(this.smokeProgram, key);
    }

    this.traceProgram = this.createProgram(QUAD_VERTEX_SHADER, TRACE_FRAGMENT_SHADER);
    for (const key of ['uWaveform', 'uAmplitude', 'uCentre', 'uGain']) {
      this.traceUniforms[key] = gl.getUniformLocation(this.traceProgram, key);
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

    for (const key of ['uSurface', 'uSize', 'uParams', 'uDecay', 'uPhase']) {
      this.warpUniforms[key] = gl.getUniformLocation(this.warpProgram, key);
    }
    for (const key of [
      'uSurface', 'uSmoke', 'uPalette', 'uAlpha', 'uPaletteShift', 'uBackground',
    ]) {
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
      const texture: WebGLTexture | null = this.createSurfaceTexture();
      const buffer: WebGLFramebuffer | null = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      this.surfaceTextures[i] = texture;
      this.surfaceBuffers[i] = buffer;
    }

    for (let i: number = 0; i < this.smokeTextures.length; i++) {
      const texture: WebGLTexture | null = this.createSurfaceTexture();
      const buffer: WebGLFramebuffer | null = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.smokeTextures[i] = texture;
      this.smokeBuffers[i] = buffer;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Allocates one surface-sized texture with the engine's sampling rules.
   *
   * Linear sampling is what keeps the warp smooth instead of blocky, and is
   * also what smears the smoke layer as it resamples itself; the bounds test in
   * each shader is then the only edge rule that applies.
   *
   * @returns The new texture
   */
  private createSurfaceTexture(): WebGLTexture | null {
    const gl: WebGLRenderingContext = this.gl;
    const texture: WebGLTexture | null = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, this.surfaceWidth, this.surfaceHeight, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
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
    for (let i: number = 0; i < this.smokeTextures.length; i++) {
      if (this.smokeTextures[i]) gl.deleteTexture(this.smokeTextures[i]);
      if (this.smokeBuffers[i]) gl.deleteFramebuffer(this.smokeBuffers[i]);
      this.smokeTextures[i] = null;
      this.smokeBuffers[i] = null;
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
      this.stepSmoke();
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
    gl.uniform1f(this.warpUniforms['uPhase'], this.phase);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.front = back;
  }

  /**
   * Ages the smoke layer, then redraws its generators onto it.
   *
   * Nothing here passes through the displacement, so a trace drawn on it keeps
   * its shape and simply thins out.
   */
  private stepSmoke(): void {
    const gl: WebGLRenderingContext = this.gl;
    if (!this.smokeTextures[0] || !this.smokeProgram) return;

    const back: number = 1 - this.smokeFront;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.smokeBuffers[back]);
    gl.viewport(0, 0, this.surfaceWidth, this.surfaceHeight);
    gl.disable(gl.BLEND);
    gl.useProgram(this.smokeProgram);
    this.bindQuad(this.smokeProgram);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.smokeTextures[this.smokeFront]);
    gl.uniform1i(this.smokeUniforms['uLayer'], 0);
    gl.uniform2f(this.smokeUniforms['uSize'], this.surfaceWidth, this.surfaceHeight);
    gl.uniform1f(this.smokeUniforms['uAngle'], this.spec.smokeAngle);
    gl.uniform1f(this.smokeUniforms['uFade'], this.spec.smokeFade);
    gl.uniform1f(this.smokeUniforms['uSpread'], this.spec.smokeSpread);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this.smokeFront = back;
    this.drawGeneratorsInto(this.spec.smoke);
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
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.smokeTextures[this.smokeFront]);
    gl.uniform1i(this.presentUniforms['uSmoke'], 2);
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
    this.drawGeneratorsInto(stages);
  }

  /**
   * Draws a stage list into whichever framebuffer is currently bound.
   *
   * @param stages - The generators to draw
   */
  private drawGeneratorsInto(stages: readonly GeneratorStage[]): void {
    if (stages.length === 0) return;

    const gl: WebGLRenderingContext = this.gl;
    gl.enable(gl.BLEND);
    // The engine wrote generator output straight over the surface additively,
    // letting indices pile up where strokes cross.
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.generatorProgram);
    gl.uniform2f(this.generatorUniforms['uSize'], this.surfaceWidth, this.surfaceHeight);
    gl.uniform1f(this.generatorUniforms['uPointSize'], DOT_POINT_SIZE);

    for (const stage of stages) {
      // The trace is a full-screen pass rather than geometry, so it does not go
      // through the vertex staging path at all.
      if (stage.kind === 'Trace') {
        this.runTrace(stage.args);
        continue;
      }
      const mode: number | null = this.buildGenerator(stage);
      if (mode === null || this.vertexCount === 0) continue;
      this.flushGenerator(mode);
    }

    gl.disable(gl.BLEND);
  }

  /**
   * Uploads and draws whatever the current generator emitted.
   *
   * @param mode - The primitive mode to draw with
   */
  private flushGenerator(mode: number): void {
    const gl: WebGLRenderingContext = this.gl;
    const program: WebGLProgram = this.generatorProgram!;
    const used: Float32Array = this.vertices.subarray(0, this.vertexCount * VERTEX_STRIDE);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.generatorBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, used);

    const stride: number = VERTEX_STRIDE * Float32Array.BYTES_PER_ELEMENT;
    const position: number = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, stride, 0);
    const value: number = gl.getAttribLocation(program, 'aValue');
    gl.enableVertexAttribArray(value);
    gl.vertexAttribPointer(
      value, 1, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT
    );

    gl.drawArrays(mode, 0, this.vertexCount);
    gl.disableVertexAttribArray(value);
  }

  /**
   * Appends one vertex to the staging array.
   *
   * @param x - Surface x, in pixels
   * @param y - Surface y, in pixels
   * @param value - Intensity to add at this vertex
   */
  private vertex(x: number, y: number, value: number): void {
    if (this.vertexCount >= MAX_VERTICES) return;
    const at: number = this.vertexCount * VERTEX_STRIDE;
    this.vertices[at] = x;
    this.vertices[at + 1] = y;
    this.vertices[at + 2] = value;
    this.vertexCount++;
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

  /**
   * Builds the vertices for one generator.
   *
   * @param stage - The generator and its parameters
   * @returns The primitive mode to draw with, or null if the name is unknown
   */
  private buildGenerator(stage: GeneratorStage): number | null {
    const gl: WebGLRenderingContext = this.gl;
    this.vertexCount = 0;

    switch (stage.kind) {
      case 'JiggyScribble':
        this.buildScribble(stage.args);
        return gl.LINE_STRIP;
      case 'JDar':
        this.buildJDar(stage.args);
        return gl.LINE_LOOP;
      case 'DotPlane':
        this.buildDotPlane(stage.args);
        return gl.POINTS;
      case 'CircleWaveform':
        this.buildCircleWaveform(stage.args);
        return gl.LINE_LOOP;
      case 'SpectrumEdge':
        this.buildSpectrumEdge(stage.args);
        return gl.LINES;
      case 'WaveEdge':
        this.buildWaveEdge(stage.args);
        return gl.LINE_STRIP;
      case 'EdgeGradiant':
        this.buildEdgeGradient(stage.args, false);
        return gl.LINES;
      case 'CosEdgeGradiant':
        this.buildEdgeGradient(stage.args, true);
        return gl.LINES;
      case 'EdgeTrace':
        this.buildEdgeTrace(stage.args);
        return gl.POINTS;
      default:
        return null;
    }
  }

  /**
   * A wandering closed curve, the bank's most-used pre-shift generator.
   *
   * The three large parameters become two angular lobe counts and a radial
   * frequency, which is what makes each preset's scribble its own shape.
   *
   * @param args - The stage's dbl1..dbl4
   */
  private buildScribble(args: readonly number[]): void {
    const cx: number = this.surfaceWidth * 0.5;
    const cy: number = this.surfaceHeight * 0.5;
    const unit: number = Math.min(cx, cy);

    const lobesA: number = Math.max(1, Math.round((args[0] ?? 1) / SCRIBBLE_LOBE_DIVISOR));
    const lobesB: number = Math.max(1, Math.round((args[1] ?? 1) / SCRIBBLE_LOBE_DIVISOR));
    const radial: number = Math.max(1, Math.round((args[2] ?? 1) / SCRIBBLE_RADIAL_DIVISOR));
    const level: number = GENERATOR_FLOOR + this.bass * GENERATOR_GAIN;

    this.gl.lineWidth(1);
    for (let i: number = 0; i <= SCRIBBLE_POINTS; i++) {
      const u: number = i / SCRIBBLE_POINTS;
      const wave: number = this.sampleAt(u);
      const radius: number =
        unit * (SCRIBBLE_BASE_RADIUS + SCRIBBLE_SWING * Math.sin(TWO_PI * radial * u + this.phase))
        + unit * SCRIBBLE_SWING * wave * this.bass;
      const a: number = TWO_PI * lobesA * u + this.phase;
      const b: number = TWO_PI * lobesB * u + this.phase * JDAR_NOTCH;
      this.vertex(cx + radius * Math.cos(a), cy + radius * Math.sin(b), level);
    }
  }

  /**
   * A rotating many-armed star. Its dbl4 is the arm count in every preset that
   * uses it, and its dbl5 the rate it turns at.
   *
   * @param args - The stage's dbl1..dbl8
   */
  private buildJDar(args: readonly number[]): void {
    const cx: number = this.surfaceWidth * 0.5;
    const cy: number = this.surfaceHeight * 0.5;
    const unit: number = Math.min(cx, cy) * JDAR_RADIUS;

    const arms: number = Math.max(JDAR_MIN_ARMS, Math.round(args[3] ?? JDAR_MIN_ARMS));
    const rate: number = args[4] ?? 1;
    const spin: number = this.phase * rate;
    const level: number = GENERATOR_FLOOR + this.bass * GENERATOR_GAIN;
    const points: number = arms * 2;

    this.gl.lineWidth(1);
    for (let i: number = 0; i < points; i++) {
      const angle: number = (i / points) * TWO_PI + spin;
      const inner: boolean = i % 2 === 1;
      const wave: number = this.sampleAt(i / points);
      const radius: number = unit * (inner ? JDAR_NOTCH : 1 + wave * JDAR_NOTCH);
      this.vertex(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), level);
    }
  }

  /**
   * A receding plane of dots. Every preset that uses it passes a focal length
   * of 384 in dbl4, which is projected through here unchanged.
   *
   * @param args - The stage's dbl1..dbl4
   */
  private buildDotPlane(args: readonly number[]): void {
    const cx: number = this.surfaceWidth * 0.5;
    const cy: number = this.surfaceHeight * 0.5;
    const focal: number = args[3] && args[3] > 1 ? args[3] : DOT_FOCAL_DEFAULT;
    const spread: number = Math.max(1, args[0] ?? 1);
    const level: number = GENERATOR_FLOOR + this.bass * GENERATOR_GAIN;
    const travel: number = (this.phase / TWO_PI) * DOT_SPEED * focal * DOT_ROWS;

    for (let row: number = 0; row < DOT_ROWS; row++) {
      // Rows march toward the viewer and wrap, so the field never runs out.
      const depth: number =
        focal * 0.25 + ((row * (focal * DOT_DEPTH_SPAN) / DOT_ROWS) - travel)
        % (focal * DOT_DEPTH_SPAN);
      const z: number = depth <= 0 ? depth + focal * DOT_DEPTH_SPAN : depth;
      const scale: number = focal / z;
      const lift: number = this.binAt(row / DOT_ROWS) * spread;

      for (let column: number = 0; column < DOT_COLUMNS; column++) {
        const x: number = (column / (DOT_COLUMNS - 1) - 0.5) * spread * DOT_COLUMNS;
        this.vertex(cx + x * scale, cy + (spread - lift * spread) * scale, level * scale);
      }
    }
  }

  /**
   * The waveform wrapped around a circle. dbl3 is the radius as a fraction of
   * the surface in every preset that uses it.
   *
   * @param args - The stage's dbl1..dbl4
   */
  private buildCircleWaveform(args: readonly number[]): void {
    const cx: number = this.surfaceWidth * 0.5;
    const cy: number = this.surfaceHeight * 0.5;
    const unit: number = Math.min(cx, cy);
    const base: number = unit * (args[2] && args[2] > 0 ? args[2] : CIRCLE_FALLBACK_RADIUS);
    const level: number = GENERATOR_FLOOR + GENERATOR_GAIN;

    this.gl.lineWidth(1);
    for (let i: number = 0; i < RING_POINTS; i++) {
      const u: number = i / RING_POINTS;
      const angle: number = u * TWO_PI;
      const radius: number = base + unit * CIRCLE_SWING * this.sampleAt(u);
      this.vertex(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), level);
    }
  }

  /**
   * The spectrum standing along the bottom edge.
   *
   * @param args - The stage's dbl1..dbl4
   */
  private buildSpectrumEdge(args: readonly number[]): void {
    const width: number = this.surfaceWidth;
    const height: number = this.surfaceHeight;
    const level: number = GENERATOR_FLOOR + GENERATOR_GAIN;
    // dbl1 spans two orders of magnitude across the presets that use it, so it
    // reads as a gain on the bar height rather than a count.
    const gain: number = Math.max(1, (args[0] ?? 1)) / SCRIBBLE_RADIAL_DIVISOR;

    for (let i: number = 0; i < SPECTRUM_BARS; i++) {
      const u: number = i / SPECTRUM_BARS;
      const x: number = u * width;
      const bar: number = this.binAt(u) * height * SPECTRUM_HEIGHT * (1 + gain);
      this.vertex(x, height, level);
      this.vertex(x, height - bar, level);
    }
  }

  /**
   * The waveform running along the bottom edge.
   *
   * @param args - The stage's dbl1..dbl4
   */
  private buildWaveEdge(args: readonly number[]): void {
    const width: number = this.surfaceWidth;
    const height: number = this.surfaceHeight;
    const level: number = GENERATOR_FLOOR + GENERATOR_GAIN;
    const depth: number = height * WAVE_EDGE_DEPTH * Math.max(1, args[0] ?? 1);

    this.gl.lineWidth(1);
    for (let i: number = 0; i < WAVE_EDGE_SAMPLES; i++) {
      const u: number = i / (WAVE_EDGE_SAMPLES - 1);
      this.vertex(u * width, height - depth * 0.5 - depth * 0.5 * this.sampleAt(u), level);
    }
  }

  /**
   * A band of brightness along the bottom edge, either flat or cosine-shaped.
   *
   * @param args - The stage's dbl1..dbl4
   * @param cosine - True for the cosine variant
   */
  private buildEdgeGradient(args: readonly number[], cosine: boolean): void {
    const width: number = this.surfaceWidth;
    const height: number = this.surfaceHeight;
    const band: number = height * EDGE_BAND;
    const frequency: number = (args[0] ?? 0) * SCRIBBLE_RADIAL_DIVISOR;

    for (let i: number = 0; i < EDGE_BAND_ROWS; i++) {
      const u: number = i / (EDGE_BAND_ROWS - 1);
      const y: number = height - band * u;
      const falloff: number = 1 - u;
      const shape: number = cosine
        ? 0.5 + 0.5 * Math.cos(frequency * u + this.phase)
        : 1;
      const level: number =
        (GENERATOR_FLOOR + this.bass * GENERATOR_GAIN) * falloff * shape;
      this.vertex(0, y, level);
      this.vertex(width, y, level);
    }
  }

  /**
   * A bright head running the perimeter of the surface.
   *
   * @param args - The stage's dbl1..dbl4
   */
  private buildEdgeTrace(args: readonly number[]): void {
    const width: number = this.surfaceWidth;
    const height: number = this.surfaceHeight;
    const perimeter: number = (width + height) * 2;
    const rate: number = Math.max(1, args[0] ?? 1) / EDGE_TRACE_RATE_DIVISOR;
    const head: number = (this.phase / TWO_PI) * rate * perimeter;

    for (let i: number = 0; i < EDGE_TRACE_POINTS; i++) {
      const along: number = i / EDGE_TRACE_POINTS;
      const at: number = (head + along * EDGE_TRACE_HEAD * perimeter) % perimeter;
      const level: number = (GENERATOR_FLOOR + GENERATOR_GAIN) * along;

      if (at < width) this.vertex(at, 0, level);
      else if (at < width + height) this.vertex(width, at - width, level);
      else if (at < width * 2 + height) this.vertex(width * 2 + height - at, height, level);
      else this.vertex(0, perimeter - at, level);
    }
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
    if (this.smokeProgram) gl.deleteProgram(this.smokeProgram);
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

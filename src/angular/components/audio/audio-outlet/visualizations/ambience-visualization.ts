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
 * This pass implements the engine plus four displacements, each modelled on
 * one of the classes in the original bank:
 *
 * - Linear    a constant random drift, a few pixels per frame on each axis
 * - Swirl     angle rotated in proportion to radius
 * - Zoom      radius scaled, drawing content toward or away from the centre
 * - Starburst radius modulated sinusoidally by angle, producing arms
 *
 * The original ships fourteen named presets over twelve displacement classes,
 * so presets evidently compose or parameterise displacements rather than
 * mapping one-to-one. Only three names tie to a class with certainty (Swirl,
 * Falloff, Thingus), so the presets below are named for the displacement they
 * exercise rather than guessing at the shipping names.
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
import {DEGREES_FULL_CIRCLE, MS_PER_SECOND, HALF, RGB_MAX} from './visualization-constants';

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
// ============================================================================

/**
 * Bound on the per-frame linear drift, in surface pixels.
 *
 * The original draws this from a small integer range on each axis, giving a
 * drift of a few pixels per frame in an arbitrary direction.
 */
const LINEAR_DRIFT_RANGE: number = 3;

/** Minimum swirl strength, in radians of rotation per unit radius. */
const SWIRL_MIN: number = 0.35;

/** Maximum swirl strength, in radians of rotation per unit radius. */
const SWIRL_MAX: number = 1.6;

/** Strongest inward zoom per frame (radius sampled from further out). */
const ZOOM_IN_MAX: number = 1.035;

/** Strongest outward zoom per frame. */
const ZOOM_OUT_MAX: number = 0.975;

/** Fewest arms on the starburst displacement. */
const ARMS_MIN: number = 3;

/** Most arms on the starburst displacement. */
const ARMS_MAX: number = 9;

/** Minimum radial amplitude of the starburst arms, in normalised units. */
const ARM_AMPLITUDE_MIN: number = 0.004;

/** Maximum radial amplitude of the starburst arms, in normalised units. */
const ARM_AMPLITUDE_MAX: number = 0.018;

/** Minimum constant angular drift, in radians per frame. */
const SPIN_MIN: number = -0.012;

/** Maximum constant angular drift, in radians per frame. */
const SPIN_MAX: number = 0.012;

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
enum ShiftMode {
  /** Constant random drift on both axes. */
  Linear = 0,
  /** Angle rotated in proportion to radius. */
  Swirl = 1,
  /** Radius scaled about the centre. */
  Zoom = 2,
  /** Radius modulated sinusoidally by angle. */
  Starburst = 3,
}

/** A preset: which displacement to run, and the look wrapped around it. */
interface AmbiencePreset {
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
}

/** The preset table. */
const PRESETS: readonly AmbiencePreset[] = [
  {name: 'Swirl', shift: ShiftMode.Swirl, decay: DECAY_SLOW, startHue: 200, hueDrift: HUE_DRIFT_SLOW},
  {name: 'Zoom', shift: ShiftMode.Zoom, decay: DECAY_MID, startHue: 300, hueDrift: HUE_DRIFT_MED},
  {name: 'Starburst', shift: ShiftMode.Starburst, decay: DECAY_SLOW, startHue: 30, hueDrift: HUE_DRIFT_MED},
  {name: 'Linear', shift: ShiftMode.Linear, decay: DECAY_FAST, startHue: 120, hueDrift: HUE_DRIFT_SLOW},
];

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
uniform float uAspect;
uniform float uDecay;
uniform int   uShift;
uniform vec2  uLinear;
uniform float uSwirl;
uniform float uZoom;
uniform float uArms;
uniform float uArmAmplitude;
uniform float uSpin;
uniform vec3  uTraceColor;
uniform float uWaveAmplitude;

/* Centre the coordinate and correct for aspect, so circles stay circular. */
vec2 toCentred(vec2 uv) {
  return vec2((uv.x - 0.5) * uAspect, uv.y - 0.5);
}

vec2 fromCentred(vec2 c) {
  return vec2(c.x / uAspect + 0.5, c.y + 0.5);
}

vec2 applyShift(vec2 uv) {
  if (uShift == 0) {
    return uv + uLinear;
  }

  vec2 centred = toCentred(uv);
  float radius = length(centred);
  float angle = atan(centred.y, centred.x);

  if (uShift == 1) {
    angle += uSwirl * radius;
  } else if (uShift == 2) {
    radius *= uZoom;
  } else {
    radius += uArmAmplitude * sin(uArms * angle);
    angle += uSpin;
  }

  return fromCentred(vec2(cos(angle), sin(angle)) * radius);
}

/* Distance-based glow around the waveform trace. "sample" is avoided as an
   identifier: it is a reserved word in later GLSL versions and some drivers
   reject it here too. */
float waveGlow(vec2 uv) {
  float level = texture2D(uWaveform, vec2(uv.x, 0.5)).r;
  float traceY = 0.5 + (level - 0.5) * uWaveAmplitude;
  float delta = uv.y - traceY;
  return exp(-(delta * delta) / ${WAVE_SIGMA});
}

void main() {
  vec2 source = applyShift(vUv);

  /* Bounds-checked, matching the original's guarded table lookup: nothing
     bleeds in from outside the surface. */
  vec3 previous = vec3(0.0);
  if (source.x >= 0.0 && source.x <= 1.0 && source.y >= 0.0 && source.y <= 1.0) {
    previous = texture2D(uPrevious, source).rgb * uDecay;
  }

  gl_FragColor = vec4(previous + uTraceColor * waveGlow(vUv) * ${WAVE_GAIN}, 1.0);
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
export class AmbienceVisualization extends WebGLVisualization {
  public readonly name: string = 'Ambience';
  public readonly category: string = 'Retro';

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

  /** Index of the preset currently running. */
  private presetIndex: number = 0;

  /** Milliseconds elapsed on the current preset. */
  private presetElapsedMs: number = 0;

  /** Timestamp of the previous preset tick, in milliseconds. */
  private lastPresetTickMs: number = performance.now();

  /** Current hue of the trace, in degrees. */
  private hue: number = PRESETS[0].startHue;

  /** Smoothed bass level in the range 0 to 1. */
  private bass: number = 0;

  /** Randomised displacement parameters for the running preset. */
  private linearX: number = 0;
  private linearY: number = 0;
  private swirl: number = 0;
  private zoom: number = 1;
  private arms: number = 0;
  private armAmplitude: number = 0;
  private spin: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
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
      'uPrevious', 'uWaveform', 'uAspect', 'uDecay', 'uShift', 'uLinear',
      'uSwirl', 'uZoom', 'uArms', 'uArmAmplitude', 'uSpin', 'uTraceColor', 'uWaveAmplitude',
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
    this.advancePresets();
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
   * Advances the preset clock, re-randomising the displacement on each change.
   *
   * The original randomises a displacement's parameters when it is selected
   * rather than holding fixed values, so the same preset looks different each
   * time it comes around.
   */
  private advancePresets(): void {
    const now: number = performance.now();
    const deltaMs: number = Math.min(now - this.lastPresetTickMs, PRESET_MAX_DELTA_MS);
    this.lastPresetTickMs = now;
    this.presetElapsedMs += deltaMs;

    if (this.presetElapsedMs < PRESET_HOLD_MS) return;

    this.presetElapsedMs = 0;
    this.presetIndex = (this.presetIndex + 1) % PRESETS.length;
    this.hue = PRESETS[this.presetIndex].startHue;
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
    const drift: () => number = (): number =>
      Math.floor(Math.random() * (LINEAR_DRIFT_RANGE * 2)) - LINEAR_DRIFT_RANGE;
    const between: (min: number, max: number) => number =
      (min: number, max: number): number => min + Math.random() * (max - min);

    this.linearX = drift();
    this.linearY = drift();
    this.swirl = between(SWIRL_MIN, SWIRL_MAX) * (Math.random() < HALF ? -1 : 1);
    this.zoom = Math.random() < HALF ? between(1, ZOOM_IN_MAX) : between(ZOOM_OUT_MAX, 1);
    this.arms = Math.round(between(ARMS_MIN, ARMS_MAX));
    this.armAmplitude = between(ARM_AMPLITUDE_MIN, ARM_AMPLITUDE_MAX);
    this.spin = between(SPIN_MIN, SPIN_MAX);
  }

  /** Packs the time-domain samples into the waveform texture. */
  private uploadWaveform(): void {
    const gl: WebGLRenderingContext = this.gl;
    const samples: number = this.dataArray.length;

    for (let i: number = 0; i < WAVE_TEXTURE_WIDTH; i++) {
      const index: number = Math.min(samples - 1, Math.floor((i / WAVE_TEXTURE_WIDTH) * samples));
      this.waveTexels[i * RGBA_STRIDE] = this.dataArray[index];
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
    const preset: AmbiencePreset = PRESETS[this.presetIndex];
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

    this.hue = (this.hue + preset.hueDrift) % DEGREES_FULL_CIRCLE;
    const rgb: {r: number; g: number; b: number} =
      this.hslToRgb(this.hue, TRACE_SATURATION, TRACE_LIGHTNESS);

    gl.uniform1f(this.warpUniforms['uAspect'], this.surfaceWidth / this.surfaceHeight);
    gl.uniform1f(this.warpUniforms['uDecay'], preset.decay);
    gl.uniform1i(this.warpUniforms['uShift'], preset.shift);
    gl.uniform2f(
      this.warpUniforms['uLinear'],
      this.linearX / this.surfaceWidth,
      this.linearY / this.surfaceHeight
    );
    gl.uniform1f(this.warpUniforms['uSwirl'], this.swirl);
    gl.uniform1f(this.warpUniforms['uZoom'], this.zoom);
    gl.uniform1f(this.warpUniforms['uArms'], this.arms);
    gl.uniform1f(this.warpUniforms['uArmAmplitude'], this.armAmplitude);
    gl.uniform1f(this.warpUniforms['uSpin'], this.spin);
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

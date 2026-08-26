/**
 * @fileoverview Strata visualization - a spectral differential rotation field.
 *
 * An original visualization, not a port of anything, though it grew out of the
 * feedback engine written for the Windows Media Player reimplementations and
 * is best understood against them.
 *
 * Every displacement in that engine is *globally uniform*: one rotation, one
 * zoom, one shear, applied identically to every pixel on the surface. The
 * parameters change over time but never across space. Strata takes the one
 * step that engine never took - it makes the warp a function of position, and
 * drives that function with the spectrum.
 *
 * Concretely: each radius rotates at its own rate, and that rate is set by the
 * audio energy at the frequency mapped to it. Bass sits at the centre, treble
 * at the rim. A bass-heavy passage churns the core while the rim barely moves;
 * a bright passage shears the outside past a still centre.
 *
 * The reason this is worth doing in a *feedback* renderer rather than drawing
 * it directly is that differential rotation is self-structuring. Neighbouring
 * radii moving at different speeds shear whatever is between them, and because
 * each frame is the next frame's input, that shear compounds. Concentric bands
 * wind into spiral filaments over a few seconds - the same mechanism that puts
 * arms on a galaxy. The spirals are not drawn anywhere; they are what the
 * spectral balance looks like after it has been integrated over time.
 *
 * Injection is deliberately simple, because the warp is doing the work: a disc
 * whose brightness at each radius is the energy of that radius's frequency
 * band, broken up in angle by the waveform so the shear has an edge to bite
 * on. Hue is mapped to radius, so frequency reads as colour and a filament's
 * colour records which band it was spun from.
 *
 * Technical details:
 * - Ping-pong framebuffer pair at a fixed internal resolution, upscaled
 * - Spectrum and waveform packed into one 1D texture, sampled per fragment
 * - Radius-to-frequency mapping is deliberately non-linear, so the bass end
 *   is not crushed into the innermost few pixels
 *
 * @module app/components/audio/audio-outlet/visualizations/strata-visualization
 */

import {WebGLVisualization, VisualizationConfig} from './visualization';
import {RGB_MAX, TWO_PI} from './visualization-constants';

// ============================================================================
// Surface
// ============================================================================

/** Height, in pixels, of the internal feedback surface. */
const SURFACE_HEIGHT: number = 512;

/** Widest the internal surface may get, for very wide aspect ratios. */
const SURFACE_MAX_WIDTH: number = 1024;

/** Width of the 1D source texture uploaded each frame. */
const SOURCE_TEXTURE_WIDTH: number = 512;

/** Bytes per RGBA texel, used when packing the source texture. */
const RGBA_STRIDE: number = 4;

// ============================================================================
// Field
// ============================================================================

/**
 * Per-frame multiplier applied to the previous frame.
 *
 * High, because the whole point is that structure accumulates over many
 * frames. Too fast a decay and filaments are erased before the shear has
 * finished winding them.
 */
const DECAY: number = 0.982;

/**
 * Rotation applied at every radius regardless of audio, in radians per frame.
 *
 * Without this the field stalls completely in silence. Kept small enough that
 * it reads as a drift rather than a spin.
 */
const BASE_SPIN: number = 0.006;

/**
 * Additional rotation per unit of band energy, in radians per frame.
 *
 * This is the parameter that matters: it sets how much *difference* there is
 * between the fastest and slowest radius, and therefore how tightly the
 * filaments wind. Raise it and the field shreds; lower it and the bands stay
 * concentric.
 */
const SHEAR_GAIN: number = 0.09;

/**
 * Outward push per unit of band energy, as a fraction of radius per frame.
 *
 * Loud bands breathe outward slightly, which stops the spirals from sitting on
 * fixed radii and gives the field a slow radial churn.
 */
const BREATHE_GAIN: number = 0.012;

/** Constant inward drift per frame, so structure migrates rather than stalling. */
const RADIAL_DRIFT: number = 0.0016;

/**
 * Exponent mapping normalised radius to spectrum position.
 *
 * The analyser's bins are linear in frequency, so a direct mapping crushes the
 * bass into the innermost pixels where there is almost no area to show it.
 * Raising radius to this power gives the low end most of the disc.
 */
const FREQUENCY_CURVE: number = 1.8;

// ============================================================================
// Injection
// ============================================================================

/**
 * Brightness of the injected band energy.
 *
 * This is coupled to DECAY and cannot be tuned independently of it. A point
 * that keeps receiving the same injection settles at roughly
 * inject / (1 - decay), so at a decay of 0.982 the accumulated brightness is
 * on the order of fifty times what is injected per frame. The shear carries
 * content away before it reaches that ceiling, but not by enough to ignore:
 * raise this much and the field blows out to flat white within a second.
 */
const INJECT_GAIN: number = 0.3;

/**
 * Number of injection arms.
 *
 * Injection has to be sparse in angle, and persistently so. An earlier version
 * injected a full disc modulated by the waveform, which looked reasonable
 * frame by frame but was fatal: the waveform redraws completely every frame,
 * so averaged over the decay window the field came out rotationally symmetric.
 * Rotating a rotationally symmetric image produces no visible change, and the
 * whole effect sat still despite the shear running correctly.
 *
 * Arms fix that. Each frame stamps a few radial spokes at a known angle; the
 * differential rotation then drags their outer ends around faster or slower
 * than their inner ends, which is what makes them spirals.
 */
const ARM_COUNT: number = 3;

/** Angular width of an arm, as a Gaussian variance in radians squared. */
const ARM_WIDTH: number = 0.015;

/** Base advance of the injection angle per frame, in radians. */
const SWEEP_BASE: number = 0.008;

/** Additional sweep advance per unit of bass, in radians per frame. */
const SWEEP_BASS: number = 0.035;

/** Dim disc injected alongside the arms, as a fraction of arm brightness. */
const DISC_FLOOR: number = 0.1;

/** Radius, as a fraction of half-height, beyond which injection fades out. */
const INJECT_EDGE: number = 0.98;

/** Softness of that outer fade. */
const INJECT_FEATHER: number = 0.35;

// ============================================================================
// Colour
// ============================================================================

/** Hue rotation per frame, in turns. Slow, so colour identity persists. */
const HUE_DRIFT: number = 0.00035;

/** Hue span from centre to rim, in turns. */
const HUE_SPAN: number = 0.62;

/** Saturation of the injected colour. */
const SATURATION: number = 0.85;

// ============================================================================
// Audio
// ============================================================================

/** Number of low-frequency bins averaged to derive the bass level. */
const BASS_BIN_COUNT: number = 24;

/** Smoothing applied to the bass envelope, per frame. */
const BASS_SMOOTHING: number = 0.2;

/** Extra brightness contributed by the bass envelope. */
const BASS_LIFT: number = 0.7;

/** Vertex shader: a full-screen triangle pair. */
const VERTEX_SHADER: string = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/**
 * Field pass.
 *
 * `applyField` is the departure from a uniform warp: it samples the spectrum
 * at the frequency mapped to this fragment's radius and rotates by an amount
 * derived from it, so the rotation rate is a function of where the fragment
 * is rather than a single value for the whole surface.
 */
const FIELD_FRAGMENT_SHADER: string = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 vUv;

uniform sampler2D uPrevious;
uniform sampler2D uSource;
uniform float uAspect;
uniform float uHue;
uniform float uBass;
uniform float uGain;
uniform float uSweep;

const float TAU = 6.28318531;

float waveformAt(float x) {
  return texture2D(uSource, vec2(clamp(x, 0.0, 1.0), 0.5)).r;
}

float spectrumAt(float x) {
  return texture2D(uSource, vec2(clamp(x, 0.0, 1.0), 0.5)).g;
}

vec2 toCentred(vec2 uv) {
  return vec2((uv.x - 0.5) * uAspect, uv.y - 0.5);
}

vec2 fromCentred(vec2 c) {
  return vec2(c.x / uAspect + 0.5, c.y + 0.5);
}

/* Radius normalised so 1.0 sits at the top and bottom edges, then curved so
   the low end of the spectrum gets a usable share of the disc. */
float bandAt(float radius) {
  float normalised = clamp(radius * 2.0, 0.0, 1.0);
  return spectrumAt(pow(normalised, ${FREQUENCY_CURVE}));
}

/* The field. Rotation rate and radial push both vary with the local band. */
vec2 applyField(vec2 uv) {
  vec2 centred = toCentred(uv);
  float radius = length(centred);
  float angle = atan(centred.y, centred.x);

  float energy = bandAt(radius);

  /* Sampling from behind in angle makes content appear to rotate forward. */
  angle -= ${BASE_SPIN} + energy * ${SHEAR_GAIN};

  /* Reading from a smaller radius pushes content outward. */
  radius *= 1.0 - energy * ${BREATHE_GAIN} + ${RADIAL_DRIFT};

  return fromCentred(vec2(cos(angle), sin(angle)) * radius);
}

vec3 hueToRgb(float hue, float saturation, float value) {
  vec3 wrapped = abs(fract(vec3(hue) + vec3(0.0, 0.66666667, 0.33333333)) * 6.0 - 3.0);
  return value * mix(vec3(1.0), clamp(wrapped - 1.0, 0.0, 1.0), saturation);
}

/* Injection: rotating radial arms, weighted by the band energy at each radius.
   The arms are the persistent angular structure the shear needs; the disc
   floor underneath them only supplies colour body. */
vec3 inject(vec2 uv) {
  vec2 centred = toCentred(uv);
  float radius = length(centred);
  float angle = atan(centred.y, centred.x);

  float energy = bandAt(radius);

  /* Distance in angle to the nearest arm, wrapped into one arm's sector. */
  float sector = TAU / float(${ARM_COUNT});
  float phase = mod(angle - uSweep, sector);
  float offset = min(phase, sector - phase);
  float arm = exp(-(offset * offset) / ${ARM_WIDTH});

  /* The waveform rides along each arm, so they are ragged rather than straight
     and the shear has fine detail to pull on as well as the arm itself. */
  float ripple = 0.6 + 0.8 * abs(waveformAt(clamp(radius * 2.0, 0.0, 1.0)) - 0.5) * 2.0;

  float edge = 1.0 - smoothstep(${INJECT_EDGE} * 0.5,
                                (${INJECT_EDGE} + ${INJECT_FEATHER}) * 0.5, radius);

  float amount = energy * (arm * ripple + ${DISC_FLOOR}) * edge * uGain
               * (1.0 + uBass * ${BASS_LIFT}) * ${INJECT_GAIN};

  float hue = fract(uHue + clamp(radius * 2.0, 0.0, 1.0) * ${HUE_SPAN});
  return hueToRgb(hue, ${SATURATION}, amount);
}

void main() {
  vec2 source = applyField(vUv);

  vec3 previous = vec3(0.0);
  if (source.x >= 0.0 && source.x <= 1.0 && source.y >= 0.0 && source.y <= 1.0) {
    previous = texture2D(uPrevious, source).rgb * ${DECAY};
  }

  gl_FragColor = vec4(previous + inject(vUv), 1.0);
}
`;

/** Present pass: stretches the internal surface up to the canvas. */
const PRESENT_FRAGMENT_SHADER: string = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSurface;
uniform float uAlpha;
void main() {
  gl_FragColor = vec4(texture2D(uSurface, vUv).rgb, 1.0) * uAlpha;
}
`;

/**
 * Strata - a spectral differential rotation field.
 *
 * Each radius rotates at a rate set by the audio energy of the frequency band
 * mapped to it. Fed back on itself, that difference in rate shears concentric
 * bands into spiral filaments whose tightness tracks the spectral balance.
 */
export class StrataVisualization extends WebGLVisualization {
  public readonly name: string = 'Strata';
  public readonly category: string = 'Signature';

  /** Time-domain samples, used for the angular envelope. */
  private dataArray: Uint8Array<ArrayBuffer>;

  /** Frequency bins, used for the field and the injection. */
  private freqArray: Uint8Array<ArrayBuffer>;

  /** RGBA staging buffer for the source texture. */
  private readonly sourceTexels: Uint8Array<ArrayBuffer>;

  private fieldProgram: WebGLProgram | null = null;
  private presentProgram: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private sourceTexture: WebGLTexture | null = null;

  private surfaceTextures: (WebGLTexture | null)[] = [null, null];
  private surfaceBuffers: (WebGLFramebuffer | null)[] = [null, null];

  private fieldUniforms: Record<string, WebGLUniformLocation | null> = {};
  private presentUniforms: Record<string, WebGLUniformLocation | null> = {};

  private surfaceWidth: number = 0;
  private surfaceHeight: number = 0;

  /** Index of the texture holding the current frame. */
  private front: number = 0;

  /** Current hue offset, in turns. */
  private hue: number = 0;

  /** Smoothed bass level in the range 0 to 1. */
  private bass: number = 0;

  /**
   * Angle at which the arms are injected, in radians.
   *
   * Wrapped each frame: it feeds a shader mod and would lose angular precision
   * if left to grow across a long session.
   */
  private sweep: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.freqArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this.sourceTexels = new Uint8Array(SOURCE_TEXTURE_WIDTH * RGBA_STRIDE) as Uint8Array<ArrayBuffer>;
    this.initGL();
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.freqArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  // ==========================================================================
  // GL setup
  // ==========================================================================

  private initGL(): void {
    const gl: WebGLRenderingContext = this.gl;

    this.fieldProgram = this.createProgram(VERTEX_SHADER, FIELD_FRAGMENT_SHADER);
    this.presentProgram = this.createProgram(VERTEX_SHADER, PRESENT_FRAGMENT_SHADER);

    for (const key of ['uPrevious', 'uSource', 'uAspect', 'uHue', 'uBass', 'uGain', 'uSweep']) {
      this.fieldUniforms[key] = gl.getUniformLocation(this.fieldProgram!, key);
    }
    for (const key of ['uSurface', 'uAlpha']) {
      this.presentUniforms[key] = gl.getUniformLocation(this.presentProgram!, key);
    }

    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    this.sourceTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, SOURCE_TEXTURE_WIDTH, 1, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, this.sourceTexels
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
    if (!this.fieldProgram || !this.presentProgram) return;

    this.analyser.getByteTimeDomainData(this.dataArray);
    this.analyser.getByteFrequencyData(this.freqArray);

    this.updateBass();
    this.uploadSource();
    this.renderFieldPass();
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
    this.sweep = (this.sweep + SWEEP_BASE + this.bass * SWEEP_BASS) % TWO_PI;
  }

  /** Packs the waveform into red and the spectrum into green. */
  private uploadSource(): void {
    const gl: WebGLRenderingContext = this.gl;
    const samples: number = this.dataArray.length;
    const bins: number = this.freqArray.length;

    for (let i: number = 0; i < SOURCE_TEXTURE_WIDTH; i++) {
      const fraction: number = i / SOURCE_TEXTURE_WIDTH;
      this.sourceTexels[i * RGBA_STRIDE] =
        this.dataArray[Math.min(samples - 1, Math.floor(fraction * samples))];
      this.sourceTexels[i * RGBA_STRIDE + 1] =
        bins > 0 ? this.freqArray[Math.min(bins - 1, Math.floor(fraction * bins))] : 0;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, SOURCE_TEXTURE_WIDTH, 1,
      gl.RGBA, gl.UNSIGNED_BYTE, this.sourceTexels
    );
  }

  /** Runs the field pass into the back surface, then swaps. */
  private renderFieldPass(): void {
    const gl: WebGLRenderingContext = this.gl;
    const back: number = 1 - this.front;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.surfaceBuffers[back]);
    gl.viewport(0, 0, this.surfaceWidth, this.surfaceHeight);
    gl.useProgram(this.fieldProgram);
    this.bindQuad(this.fieldProgram!);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.surfaceTextures[this.front]);
    gl.uniform1i(this.fieldUniforms['uPrevious'], 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.uniform1i(this.fieldUniforms['uSource'], 1);

    this.hue = (this.hue + HUE_DRIFT) % 1;

    gl.uniform1f(this.fieldUniforms['uAspect'], this.surfaceWidth / this.surfaceHeight);
    gl.uniform1f(this.fieldUniforms['uHue'], this.hue);
    gl.uniform1f(this.fieldUniforms['uBass'], this.bass);
    gl.uniform1f(this.fieldUniforms['uGain'], this.sensitivityFactor);
    gl.uniform1f(this.fieldUniforms['uSweep'], this.sweep);

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

    gl.useProgram(this.presentProgram);
    this.bindQuad(this.presentProgram!);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.surfaceTextures[this.front]);
    gl.uniform1i(this.presentUniforms['uSurface'], 0);
    gl.uniform1f(this.presentUniforms['uAlpha'], 1 - this.fadeAlpha);

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
    if (this.sourceTexture) gl.deleteTexture(this.sourceTexture);
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
    if (this.fieldProgram) gl.deleteProgram(this.fieldProgram);
    if (this.presentProgram) gl.deleteProgram(this.presentProgram);
    this.sourceTexture = null;
    this.quadBuffer = null;
    this.fieldProgram = null;
    this.presentProgram = null;
    super.destroy();
  }
}

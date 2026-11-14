/**
 * @fileoverview Unit tests for the Ambience warp engine and its Twirl and
 * Warp visualizations.
 *
 * Tests cover:
 * - The displacement each visualization selects and its fixed parameters
 * - GL setup: programs, shader source, failure handling
 * - Internal surface: sizing, reuse, recreation, ping-pong between frames
 * - Audio: bass envelope, sweep, trace amplitude, waveform texture packing
 * - Trace colour cycling, sensitivity, fade-out, idling, FFT size, destroy
 * - Edge inputs: zero-sized canvas, extreme spectra, an analyser with no bins
 *
 * WebGL, the analyser and the clock are faked; see
 * visualization-test-fakes.group2. The shaders themselves never run, so what
 * is asserted is what the engine hands to the GPU each frame.
 *
 * @module app/components/audio/audio-outlet/visualizations/ambience-visualization.spec
 */

import {
  AmbienceTwirlVisualization,
  AmbienceVisualization,
  AmbienceWarpVisualization,
  GeneratorMode,
  ShiftMode,
} from './ambience-visualization';
import type {VisualizationConfig} from './visualization';
import {
  BASS_HEAVY_SPECTRUM,
  FULL_SPECTRUM,
  FakeAnalyser,
  FakeWebGL,
  LOUD_WAVEFORM,
  SILENT_SPECTRUM,
  SILENT_WAVEFORM,
  flat,
  installCanvasFakes,
  installFakeClock,
  spike,
} from './visualization-test-fakes.group2';
import type {AnalyserFill, CanvasFakes, FakeClock, RecordedCall} from './visualization-test-fakes.group2';

// ============================================================================
// Helpers
// ============================================================================

const WIDTH: number = 800;
const HEIGHT: number = 600;

/** Internal surface for an 800x600 view: 512 high, width following the aspect ratio. */
const SURFACE_WIDTH: number = 683;
const SURFACE_HEIGHT: number = 512;

/** Sweep advance per frame in silence, in radians. */
const SWEEP_BASE_RATE: number = 0.012;

/** Trace deflection at the default sensitivity with no bass. */
const RESTING_WAVE_AMPLITUDE: number = 0.34 * 0.5;

/** An engine configured with nothing but the required fields. */
class BareAmbienceVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Bare',
      shift: ShiftMode.Linear,
      decay: 0.95,
      startHue: 0,
      hueDrift: 0,
      generator: GeneratorMode.Galaxy,
      params: {},
    });
  }
}

/** An engine configured with every optional field. */
class FullAmbienceVisualization extends AmbienceVisualization {
  public constructor(config: VisualizationConfig) {
    super(config, {
      name: 'Full',
      category: 'Experiments',
      shift: ShiftMode.SinShimmer,
      decay: 0.985,
      startHue: 120,
      hueDrift: 0,
      generator: GeneratorMode.JDar,
      params: {driftX: 1, driftY: -1, amplitude: 2.5, frequency: 1.2, angleDelta: 0.03, subMode: 1},
    });
  }
}

/** Sizes of the ping-pong surfaces allocated so far, as [width, height]. */
function surfaceSizes(gl: FakeWebGL): unknown[][] {
  return gl.callsTo('texImage2D')
    .filter((call: RecordedCall): boolean => call.args[8] === null)
    .map((call: RecordedCall): unknown[] => [call.args[3], call.args[4]]);
}

/** The ping-pong textures, in the order they were attached to framebuffers. */
function surfaceTextures(gl: FakeWebGL): unknown[] {
  return gl.callsTo('framebufferTexture2D').map((call: RecordedCall): unknown => call.args[3]);
}

/** The framebuffers bound so far, skipping unbinds. */
function boundFramebuffers(gl: FakeWebGL): unknown[] {
  return gl.callsTo('bindFramebuffer')
    .map((call: RecordedCall): unknown => call.args[1])
    .filter((buffer: unknown): boolean => buffer !== null);
}

/** The RGBA texels most recently uploaded to the waveform texture. */
function uploadedTexels(gl: FakeWebGL): Uint8Array {
  const uploads: RecordedCall[] = gl.callsTo('texSubImage2D');
  return uploads[uploads.length - 1].args[8] as Uint8Array;
}

/** The trace colour most recently uploaded, as [r, g, b] in 0..1. */
function traceColour(gl: FakeWebGL): number[] {
  const history: unknown[][] = gl.uniformHistory('uTraceColor');
  return history[history.length - 1] as number[];
}

// ============================================================================
// Tests
// ============================================================================

describe('AmbienceVisualization', (): void => {
  let fakes: CanvasFakes;
  let clock: FakeClock;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let gl: FakeWebGL;

  function config(): VisualizationConfig {
    return {canvas, analyser: analyser.node};
  }

  /** Sizes a visualization to the view and starts playback. */
  function playing<T extends AmbienceVisualization>(viz: T): T {
    viz.resize(WIDTH, HEIGHT);
    viz.setPlaying(true);
    return viz;
  }

  function drawFrames(viz: AmbienceVisualization, count: number): void {
    for (let i: number = 0; i < count; i++) {
      clock.advance(16);
      viz.draw();
    }
  }

  beforeEach((): void => {
    clock = installFakeClock();
    fakes = installCanvasFakes();
    analyser = new FakeAnalyser();
    canvas = document.createElement('canvas');
    // Ask for the context up front so a test can configure the fake before construction.
    canvas.getContext('webgl');
    gl = fakes.glFor(canvas);
  });

  afterEach((): void => {
    fakes.restore();
    clock.restore();
    vi.restoreAllMocks();
  });

  describe('Twirl', (): void => {
    it('identifies itself as Twirl in the Nostalgia category', (): void => {
      const viz: AmbienceTwirlVisualization = new AmbienceTwirlVisualization(config());

      expect(viz.name).toBe('Twirl');
      expect(viz.category).toBe('Nostalgia');
    });

    it('runs the zoom displacement outward, fed by the waveform trace', (): void => {
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));

      viz.draw();

      expect(gl.uniformValue('uShift')).toBe(ShiftMode.Zoom);
      expect(gl.uniformValue('uGenerator')).toBe(GeneratorMode.WaveEdge);
      expect(gl.uniformValue('uAngleDelta')).toBe(0.02);
      expect(gl.uniformValue('uAmplitude')).toBe(-0.025);
      expect(gl.uniformValue('uDecay')).toBe(0.97);
    });

    it('starts its trace magenta', (): void => {
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));

      viz.draw();

      const [red, green, blue]: number[] = traceColour(gl);
      expect(red).toBeGreaterThan(0.9);
      expect(blue).toBeGreaterThan(0.9);
      expect(green).toBeLessThan(0.2);
    });
  });

  describe('Warp', (): void => {
    it('identifies itself as Warp in the Nostalgia category', (): void => {
      const viz: AmbienceWarpVisualization = new AmbienceWarpVisualization(config());

      expect(viz.name).toBe('Warp');
      expect(viz.category).toBe('Nostalgia');
    });

    it('runs the cubic stretch displacement, fed by the waveform trace', (): void => {
      const viz: AmbienceWarpVisualization = playing(new AmbienceWarpVisualization(config()));

      viz.draw();

      expect(gl.uniformValue('uShift')).toBe(ShiftMode.Stretch);
      expect(gl.uniformValue('uGenerator')).toBe(GeneratorMode.WaveEdge);
      expect(gl.uniformValue('uAngleDelta')).toBe(0.012);
      expect(gl.uniformValue('uAmplitude')).toBe(0.16);
      expect(gl.uniformValue('uDecay')).toBe(0.97);
    });

    it('starts its trace violet', (): void => {
      const viz: AmbienceWarpVisualization = playing(new AmbienceWarpVisualization(config()));

      viz.draw();

      const [red, green, blue]: number[] = traceColour(gl);
      expect(blue).toBeGreaterThan(red);
      expect(red).toBeGreaterThan(green);
    });
  });

  describe('displacement configuration', (): void => {
    it('defaults the category to Ambience', (): void => {
      const viz: BareAmbienceVisualization = new BareAmbienceVisualization(config());

      expect(viz.name).toBe('Bare');
      expect(viz.category).toBe('Ambience');
    });

    it('treats omitted parameters as zero, meaning no contribution', (): void => {
      const viz: BareAmbienceVisualization = playing(new BareAmbienceVisualization(config()));

      viz.draw();

      expect(gl.uniformHistory('uDrift')[0]).toEqual([0, 0]);
      expect(gl.uniformValue('uAmplitude')).toBe(0);
      expect(gl.uniformValue('uFrequency')).toBe(0);
      expect(gl.uniformValue('uAngleDelta')).toBe(0);
      expect(gl.uniformValue('uSubMode')).toBe(0);
    });

    it('passes every supplied parameter through to the shader', (): void => {
      const viz: FullAmbienceVisualization = playing(new FullAmbienceVisualization(config()));

      viz.draw();

      expect(viz.category).toBe('Experiments');
      expect(gl.uniformValue('uShift')).toBe(ShiftMode.SinShimmer);
      expect(gl.uniformValue('uGenerator')).toBe(GeneratorMode.JDar);
      expect(gl.uniformValue('uDecay')).toBe(0.985);
      expect(gl.uniformHistory('uDrift')[0]).toEqual([1, -1]);
      expect(gl.uniformValue('uAmplitude')).toBe(2.5);
      expect(gl.uniformValue('uFrequency')).toBe(1.2);
      expect(gl.uniformValue('uAngleDelta')).toBe(0.03);
      expect(gl.uniformValue('uSubMode')).toBe(1);
    });

    it('holds its parameters still from frame to frame', (): void => {
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));
      analyser.spectrum = FULL_SPECTRUM;

      drawFrames(viz, 50);

      const amplitudes: Set<unknown> = new Set(gl.uniformHistory('uAmplitude').map((values: unknown[]): unknown => values[0]));
      const angles: Set<unknown> = new Set(gl.uniformHistory('uAngleDelta').map((values: unknown[]): unknown => values[0]));
      expect(amplitudes).toEqual(new Set([-0.025]));
      expect(angles).toEqual(new Set([0.02]));
    });
  });

  describe('construction', (): void => {
    it('links a warp program and a present program', (): void => {
      new AmbienceTwirlVisualization(config());

      expect(gl.callsTo('createProgram')).toHaveLength(2);
      expect(gl.callsTo('compileShader')).toHaveLength(4);
      expect(gl.callsTo('linkProgram')).toHaveLength(2);
    });

    it('drops its shader references once each program has linked', (): void => {
      new AmbienceTwirlVisualization(config());

      expect(gl.callsTo('deleteShader')).toHaveLength(4);
    });

    it('writes its constants into the shader as float literals', (): void => {
      new AmbienceTwirlVisualization(config());

      const warpSource: string = gl.callsTo('shaderSource')[1].args[1] as string;
      expect(warpSource).toContain('return exp(-(delta * delta) / 0.00025);');
      expect(warpSource).toContain('generate(vUv) * 0.85, 1.0);');
    });

    it('uploads a full-screen quad of two triangles', (): void => {
      new AmbienceTwirlVisualization(config());

      const quad: Float32Array = gl.callsTo('bufferData')[0].args[1] as Float32Array;
      expect(Array.from(quad)).toEqual([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    });

    it('allocates a 512x1 texture for the audio data', (): void => {
      new AmbienceTwirlVisualization(config());

      expect(gl.callsTo('texImage2D')[0].args.slice(3, 5)).toEqual([512, 1]);
    });

    it('throws when no WebGL context is available', (): void => {
      fakes.refuseContexts = true;

      expect((): AmbienceVisualization => new AmbienceTwirlVisualization(config())).toThrow('Failed to get WebGL context');
    });

    it('throws with the compiler log when a shader fails to compile', (): void => {
      gl.failCompile = true;
      gl.infoLog = 'ERROR: 0:7: undeclared identifier';

      expect((): AmbienceVisualization => new AmbienceTwirlVisualization(config()))
        .toThrow('Failed to compile shader: ERROR: 0:7: undeclared identifier');
      expect(gl.callsTo('deleteShader')).toHaveLength(1);
    });

    it('throws a generic compile error when the driver gives no log', (): void => {
      gl.failCompile = true;
      gl.infoLog = null;

      expect((): AmbienceVisualization => new AmbienceTwirlVisualization(config()))
        .toThrow('Failed to compile shader: unknown error');
    });

    it('throws with the linker log and deletes the program when linking fails', (): void => {
      gl.failLink = true;
      gl.infoLog = 'varying mismatch';

      expect((): AmbienceVisualization => new AmbienceTwirlVisualization(config()))
        .toThrow('Failed to link WebGL program: varying mismatch');
      expect(gl.callsTo('deleteProgram')).toHaveLength(1);
    });

    it('throws a generic link error when the driver gives no log', (): void => {
      gl.failLink = true;
      gl.infoLog = null;

      expect((): AmbienceVisualization => new AmbienceTwirlVisualization(config()))
        .toThrow('Failed to link WebGL program: unknown error');
    });

    it('throws when the context cannot create a program', (): void => {
      gl.refuseProgram = true;

      expect((): AmbienceVisualization => new AmbienceTwirlVisualization(config()))
        .toThrow('Failed to create WebGL program');
    });

    it('throws when the context cannot create a shader', (): void => {
      gl.refuseShader = true;

      expect((): AmbienceVisualization => new AmbienceTwirlVisualization(config()))
        .toThrow('Failed to create WebGL shader');
    });
  });

  describe('internal surface', (): void => {
    let viz: AmbienceTwirlVisualization;

    beforeEach((): void => {
      viz = new AmbienceTwirlVisualization(config());
    });

    it('allocates two surfaces 512 high at the aspect ratio of the view', (): void => {
      viz.resize(WIDTH, HEIGHT);

      expect(surfaceSizes(gl)).toEqual([[SURFACE_WIDTH, SURFACE_HEIGHT], [SURFACE_WIDTH, SURFACE_HEIGHT]]);
      expect(gl.callsTo('createFramebuffer')).toHaveLength(2);
    });

    it('clears each new surface so the feedback starts from black', (): void => {
      viz.resize(WIDTH, HEIGHT);

      expect(gl.callsTo('clear')).toHaveLength(2);
    });

    it('caps the surface width on a very wide view', (): void => {
      viz.resize(4000, 500);

      expect(surfaceSizes(gl)[0]).toEqual([1024, 512]);
    });

    it('narrows the surface on a tall view', (): void => {
      viz.resize(100, 1000);

      expect(surfaceSizes(gl)[0]).toEqual([51, 512]);
    });

    it('keeps the surfaces when the view is resized without changing aspect ratio', (): void => {
      viz.resize(WIDTH, HEIGHT);

      viz.resize(1600, 1200);

      expect(surfaceSizes(gl)).toHaveLength(2);
      expect(gl.callsTo('deleteFramebuffer')).toEqual([]);
    });

    it('releases and reallocates the surfaces when the aspect ratio changes', (): void => {
      viz.resize(WIDTH, HEIGHT);
      const old: unknown[] = surfaceTextures(gl);

      viz.resize(1600, 800);

      expect(gl.callsTo('deleteTexture').map((call: RecordedCall): unknown => call.args[0])).toEqual(old);
      expect(gl.callsTo('deleteFramebuffer')).toHaveLength(2);
      expect(surfaceSizes(gl).slice(2)).toEqual([[1024, 512], [1024, 512]]);
    });

    it('allocates nothing when resized to zero', (): void => {
      viz.resize(0, 0);

      expect(surfaceSizes(gl)).toEqual([]);
    });
  });

  describe('frame', (): void => {
    it('draws nothing and reads no audio on an unsized canvas', (): void => {
      const viz: AmbienceTwirlVisualization = new AmbienceTwirlVisualization(config());
      gl.clear();

      viz.draw();

      expect(gl.calls).toEqual([]);
      expect(analyser.spectrumReads).toEqual([]);
    });

    it('runs a warp pass at surface size, then a present pass at view size', (): void => {
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));
      gl.clear();

      viz.draw();

      expect(gl.callsTo('drawArrays')).toHaveLength(2);
      expect(gl.callsTo('viewport').map((call: RecordedCall): readonly unknown[] => call.args)).toEqual([
        [0, 0, SURFACE_WIDTH, SURFACE_HEIGHT],
        [0, 0, WIDTH, HEIGHT],
      ]);
      expect(gl.uniformHistory('uSize')[0]).toEqual([SURFACE_WIDTH, SURFACE_HEIGHT]);
    });

    it('presents to the canvas rather than to a surface', (): void => {
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));
      gl.clear();

      viz.draw();

      const binds: RecordedCall[] = gl.callsTo('bindFramebuffer');
      expect(binds[binds.length - 1].args[1]).toBeNull();
    });

    it('feeds each frame the previous frame as input and swaps the surfaces', (): void => {
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));
      const [textureA, textureB]: unknown[] = surfaceTextures(gl);
      const [bufferA, bufferB]: unknown[] = boundFramebuffers(gl);

      gl.clear();
      viz.draw();
      const firstTarget: unknown = boundFramebuffers(gl)[0];
      // Texture binds in a frame: waveform upload, previous frame, waveform, presented frame.
      const firstTextures: unknown[] = gl.callsTo('bindTexture').map((call: RecordedCall): unknown => call.args[1]);
      gl.clear();
      viz.draw();
      const secondTarget: unknown = boundFramebuffers(gl)[0];
      const secondTextures: unknown[] = gl.callsTo('bindTexture').map((call: RecordedCall): unknown => call.args[1]);

      expect(firstTarget).toBe(bufferB);
      expect([firstTextures[1], firstTextures[3]]).toEqual([textureA, textureB]);
      expect(secondTarget).toBe(bufferA);
      expect([secondTextures[1], secondTextures[3]]).toEqual([textureB, textureA]);
    });
  });

  describe('audio reactivity', (): void => {
    let viz: AmbienceTwirlVisualization;

    beforeEach((): void => {
      viz = playing(new AmbienceTwirlVisualization(config()));
    });

    it('advances the sweep at its base rate in silence', (): void => {
      drawFrames(viz, 10);

      expect(gl.uniformValue('uSweep')).toBeCloseTo(10 * SWEEP_BASE_RATE, 10);
    });

    it('advances the sweep faster when the bass is loud', (): void => {
      analyser.spectrum = BASS_HEAVY_SPECTRUM;

      viz.draw();

      // One frame of smoothing takes the bass envelope to 0.5 x 0.18.
      expect(gl.uniformValue('uSweep')).toBeCloseTo(SWEEP_BASE_RATE + 0.09 * 0.06, 10);
    });

    it('wraps the sweep so it never exceeds a full turn', (): void => {
      analyser.spectrum = FULL_SPECTRUM;

      drawFrames(viz, 600);

      const sweeps: number[] = gl.uniformHistory('uSweep').map((values: unknown[]): number => values[0] as number);
      expect(Math.max(...sweeps)).toBeLessThan(Math.PI * 2);
      expect(Math.min(...sweeps)).toBeGreaterThanOrEqual(0);
    });

    it('draws the trace at its resting amplitude in silence', (): void => {
      viz.draw();

      expect(gl.uniformValue('uWaveAmplitude')).toBeCloseTo(RESTING_WAVE_AMPLITUDE, 10);
    });

    it('flexes the trace amplitude with the bass', (): void => {
      analyser.spectrum = BASS_HEAVY_SPECTRUM;

      drawFrames(viz, 200);

      // The envelope settles at 0.5, adding 0.5 x 0.6 to the amplitude.
      expect(gl.uniformValue('uWaveAmplitude')).toBeCloseTo(RESTING_WAVE_AMPLITUDE * 1.3, 6);
    });

    it('ignores energy above the lowest 24 bins', (): void => {
      analyser.spectrum = (index: number): number => index >= 24 ? 255 : 0;

      drawFrames(viz, 20);

      expect(gl.uniformValue('uWaveAmplitude')).toBeCloseTo(RESTING_WAVE_AMPLITUDE, 10);
    });

    it('scales the trace amplitude with sensitivity', (): void => {
      viz.setSensitivity(1);

      viz.draw();

      expect(gl.uniformValue('uWaveAmplitude')).toBeCloseTo(0.34 * 2, 10);
    });

    it('lets the bass envelope fall back once the bass stops', (): void => {
      analyser.spectrum = BASS_HEAVY_SPECTRUM;
      drawFrames(viz, 200);
      analyser.spectrum = SILENT_SPECTRUM;

      drawFrames(viz, 200);

      expect(gl.uniformValue('uWaveAmplitude')).toBeCloseTo(RESTING_WAVE_AMPLITUDE, 6);
    });
  });

  describe('waveform texture', (): void => {
    it('packs the waveform into red and the spectrum into green', (): void => {
      // 2048 samples and 1024 bins onto 512 texels: texel i reads sample 4i and bin 2i.
      analyser.waveform = spike(40, 200, 128);
      analyser.spectrum = spike(10);
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));

      viz.draw();

      const texels: Uint8Array = uploadedTexels(gl);
      expect(texels).toHaveLength(512 * 4);
      expect([texels[10 * 4], texels[11 * 4]]).toEqual([200, 128]);
      expect([texels[5 * 4 + 1], texels[6 * 4 + 1]]).toEqual([255, 0]);
    });

    it('resamples to the texture width after the FFT size changes', (): void => {
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));
      viz.setFftSize(256);
      // 256 samples onto 512 texels: each sample covers two texels.
      analyser.waveform = spike(3, 200, 128);

      viz.draw();

      const texels: Uint8Array = uploadedTexels(gl);
      expect(analyser.waveformReads).toEqual([256]);
      expect(analyser.spectrumReads).toEqual([128]);
      expect([texels[5 * 4], texels[6 * 4], texels[7 * 4], texels[8 * 4]]).toEqual([128, 200, 200, 128]);
    });

    it('uploads an empty spectrum when the analyser reports no bins', (): void => {
      analyser.fftSize = 0;
      analyser.spectrum = FULL_SPECTRUM;
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));

      viz.draw();

      const texels: Uint8Array = uploadedTexels(gl);
      expect(texels.every((value: number): boolean => value === 0)).toBe(true);
      expect(gl.uniformValue('uSweep')).toBe(0);
      expect(gl.invalidCalls()).toEqual([]);
    });
  });

  describe('trace colour', (): void => {
    it('keeps every channel within the unit range', (): void => {
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));

      drawFrames(viz, 700);

      for (const colour of gl.uniformHistory('uTraceColor')) {
        for (const channel of colour as number[]) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    });

    it('drifts round the colour wheel, from magenta through red', (): void => {
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));

      // 0.55° per frame from 300°: 110 frames wraps past 360° to 0.5°.
      drawFrames(viz, 110);

      const [red, green, blue]: number[] = traceColour(gl);
      expect(red).toBeGreaterThan(0.9);
      expect(green).toBeLessThan(0.2);
      expect(blue).toBeLessThan(0.2);
    });

    it('holds its colour when the hue drift is zero', (): void => {
      const viz: FullAmbienceVisualization = playing(new FullAmbienceVisualization(config()));

      drawFrames(viz, 20);

      const colours: Set<string> = new Set(gl.uniformHistory('uTraceColor').map((colour: unknown[]): string => colour.join(',')));
      expect(colours.size).toBe(1);
    });
  });

  describe('fade', (): void => {
    it('presents fully transparent before playback has ever started', (): void => {
      const viz: AmbienceTwirlVisualization = new AmbienceTwirlVisualization(config());
      viz.resize(WIDTH, HEIGHT);

      viz.draw();

      expect(gl.uniformValue('uAlpha')).toBe(0);
      expect(viz.isIdle()).toBe(true);
    });

    it('presents fully opaque while playing', (): void => {
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));

      viz.draw();

      expect(gl.uniformValue('uAlpha')).toBe(1);
      expect(viz.isIdle()).toBe(false);
    });

    it('fades out in proportion to the time since playback stopped', (): void => {
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));
      viz.draw();
      viz.setPlaying(false);
      clock.advance(1000);

      viz.draw();

      expect(gl.uniformValue('uAlpha')).toBeCloseTo(0.8, 10);
    });

    it('becomes idle once the fade-out has completed', (): void => {
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));
      viz.draw();
      viz.setPlaying(false);
      clock.advance(4999);
      viz.draw();
      const idleJustBefore: boolean = viz.isIdle();
      clock.advance(1);

      viz.draw();

      expect(idleJustBefore).toBe(false);
      expect(viz.isIdle()).toBe(true);
      expect(gl.uniformValue('uAlpha')).toBe(0);
    });
  });

  describe('destroy', (): void => {
    it('deletes every GL object it created and releases the context', (): void => {
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));
      viz.draw();
      gl.clear();

      viz.destroy();

      expect(gl.callsTo('deleteTexture')).toHaveLength(3);
      expect(gl.callsTo('deleteFramebuffer')).toHaveLength(2);
      expect(gl.callsTo('deleteBuffer')).toHaveLength(1);
      expect(gl.callsTo('deleteProgram')).toHaveLength(2);
      expect(gl.callsTo('loseContext')).toHaveLength(1);
    });

    it('releases its own objects before giving up the context', (): void => {
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));
      gl.clear();

      viz.destroy();

      const names: string[] = gl.calls.map((call: RecordedCall): string => call.name);
      expect(names.indexOf('loseContext')).toBeGreaterThan(names.lastIndexOf('deleteProgram'));
    });

    it('deletes only what exists when destroyed before the first resize', (): void => {
      const viz: AmbienceTwirlVisualization = new AmbienceTwirlVisualization(config());
      gl.clear();

      viz.destroy();

      expect(gl.callsTo('deleteTexture')).toHaveLength(1);
      expect(gl.callsTo('deleteFramebuffer')).toEqual([]);
    });

    it('renders nothing if drawn after being destroyed', (): void => {
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));
      viz.destroy();
      gl.clear();

      viz.draw();

      expect(gl.callsTo('drawArrays')).toEqual([]);
    });

    it('does not delete anything twice when destroyed twice', (): void => {
      const viz: AmbienceTwirlVisualization = playing(new AmbienceTwirlVisualization(config()));
      viz.destroy();
      gl.clear();

      viz.destroy();

      expect(gl.callsTo('deleteTexture')).toEqual([]);
      expect(gl.callsTo('deleteProgram')).toEqual([]);
    });
  });

  describe('numeric safety', (): void => {
    const inputs: Array<[string, AnalyserFill, AnalyserFill]> = [
      ['silence', SILENT_SPECTRUM, SILENT_WAVEFORM],
      ['an all-255 spectrum and waveform', FULL_SPECTRUM, LOUD_WAVEFORM],
      ['an all-zero spectrum and waveform', SILENT_SPECTRUM, flat(0)],
      ['a single spectral spike', spike(3), SILENT_WAVEFORM],
    ];

    it.each(inputs)('passes only finite numbers to WebGL for %s', (_label: string, spectrum: AnalyserFill, waveform: AnalyserFill): void => {
      analyser.spectrum = spectrum;
      analyser.waveform = waveform;
      const viz: AmbienceWarpVisualization = playing(new AmbienceWarpVisualization(config()));
      viz.setSensitivity(1);

      drawFrames(viz, 120);

      expect(gl.invalidCalls()).toEqual([]);
    });

    it('passes only finite numbers to WebGL on a one-pixel canvas', (): void => {
      analyser.spectrum = FULL_SPECTRUM;
      const viz: AmbienceWarpVisualization = new AmbienceWarpVisualization(config());
      viz.resize(1, 1);

      viz.draw();

      expect(gl.callsTo('drawArrays')).toHaveLength(2);
      expect(gl.invalidCalls()).toEqual([]);
    });
  });
});

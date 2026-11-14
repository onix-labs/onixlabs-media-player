/**
 * @fileoverview Unit tests for the warp-and-decay feedback engine.
 *
 * Tests cover:
 * - Preset parsing: generator stages, argument lists, palettes and ramps
 * - Construction: program compilation, its failure modes, the palette upload
 * - Resize: surface sizing, reuse and replacement
 * - Frame: the step divider, the pre / warp / post order, the ping-pong
 *   surfaces, blending, and what each pass is given
 * - Audio: the waveform texture, the bass envelope, phase and sensitivity
 * - Pulse: threshold, roll, cooldown and how it runs out
 * - Idling, FFT size changes, a context that cannot create textures, destroy
 *
 * WebGL and Web Audio are faked; see visualization-test-fakes.group1.
 *
 * @module app/components/audio/audio-outlet/visualizations/feedback-engine.spec
 */

import {
  FeedbackSpec,
  FeedbackVisualization,
  feedbackVisualization,
  parseArgs,
  parseGeneratorStage,
  parsePalette,
  rampPalette,
  WARP_BODIES,
} from './feedback-engine';
import {Visualization, VisualizationConfig} from './visualization';
import {
  bassHeavy,
  CanvasFakes,
  FakeAnalyser,
  FakeGlObject,
  FakeShader,
  flat,
  installCanvasFakes,
  RecordedGlCall,
  RecordingWebGL,
} from './visualization-test-fakes.group1';

// ============================================================================
// Fixtures
// ============================================================================

/** Canvas size most tests run at; 4:3, so the internal surface is 512x384. */
const WIDTH: number = 800;
const HEIGHT: number = 600;
const SURFACE_WIDTH: number = 512;
const SURFACE_HEIGHT: number = 384;

/** Frames between warp steps. */
const FRAMES_PER_STEP: number = 3;

/** Steps a pulse takes to run out. */
const PULSE_STEPS: number = 240;

/** Where the simulated clock starts, in milliseconds. */
const START_MS: number = 100_000;

/** Text found only in the fragment shader of each pass, used to tell them apart. */
const PASS_MARKERS: Readonly<Record<string, string>> = {
  warp: 'uDecay',
  present: 'uPalette',
  trace: 'uCentre',
  radial: 'uSwing',
  generator: 'vValue',
};

/** A grey ramp: palette entry `i` is (i, i, i). */
const GREY_RAMP: Uint8Array = parsePalette(rampPalette(['000000', 'FFFFFF']));

/** A preset exercising both generators, overridable per test. */
function presetWith(overrides: Partial<FeedbackSpec> = {}): FeedbackSpec {
  return {
    name: 'Test Feedback',
    category: 'Ambience',
    warp: 'RippleWarp',
    warpArgs: [0.02, 24, 0.5],
    pre: [{kind: 'Trace', args: [1, 0.1]}],
    post: [{kind: 'CircleWaveform', args: [0, 0, 0.3]}],
    palette: GREY_RAMP,
    diffuse: 0.2,
    diffuseReach: 3,
    pulses: true,
    ...overrides,
  };
}

/** The name of the pass a recorded call was made under. */
function passOf(call: RecordedGlCall): string {
  const sources: string = (call.program?.shaders ?? []).map((shader: FakeShader): string => shader.source).join('\n');
  return Object.keys(PASS_MARKERS).find((pass: string): boolean => sources.includes(PASS_MARKERS[pass])) ?? 'none';
}

describe('feedback engine', (): void => {
  let fakes: CanvasFakes;
  let gl: RecordingWebGL;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let now: number;

  /** Builds a visualization for a preset on the shared canvas and analyser. */
  function create(preset: FeedbackSpec = presetWith()): Visualization {
    const config: VisualizationConfig = {canvas, analyser: analyser.asNode()};
    return new (feedbackVisualization(preset))(config);
  }

  /** Builds a visualization and gives it the standard canvas size. */
  function createSized(preset: FeedbackSpec = presetWith()): Visualization {
    const viz: Visualization = create(preset);
    viz.resize(WIDTH, HEIGHT);
    return viz;
  }

  /** Draws `count` frames, `elapsedMs` apart. */
  function frames(viz: Visualization, count: number, elapsedMs: number = 16): void {
    for (let i: number = 0; i < count; i++) {
      now += elapsedMs;
      viz.draw();
    }
  }

  /** Draws exactly enough frames for `count` warp steps. */
  function steps(viz: Visualization, count: number, elapsedMs: number = 16): void {
    frames(viz, count * FRAMES_PER_STEP, elapsedMs);
  }

  /** The single value written to a one-float uniform, each time it was written. */
  function floats(name: string, pass: string): number[] {
    return gl.uniformWrites(name, PASS_MARKERS[pass]).map((values: unknown[]): number => values[0] as number);
  }

  /** The draw calls made so far, as the pass each belonged to. */
  function passesDrawn(): string[] {
    return gl.callsTo('drawArrays').map(passOf);
  }

  /** The fake context typed as the real one, for reading its enum constants. */
  function constants(): WebGLRenderingContext {
    return gl as unknown as WebGLRenderingContext;
  }

  beforeEach((): void => {
    fakes = installCanvasFakes();
    gl = fakes.webgl;
    now = START_MS;
    vi.spyOn(performance, 'now').mockImplementation((): number => now);
    vi.spyOn(Math, 'random').mockReturnValue(0.9);

    analyser = new FakeAnalyser();
    canvas = document.createElement('canvas');
  });

  afterEach((): void => {
    fakes.restore();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Preset parsing
  // ==========================================================================

  describe('parseGeneratorStage', (): void => {
    it('splits a generator string into its name and numeric parameters', (): void => {
      expect(parseGeneratorStage('Trace 1 0.5 -2')).toEqual({kind: 'Trace', args: [1, 0.5, -2]});
    });

    it('tolerates padding and runs of whitespace', (): void => {
      expect(parseGeneratorStage('  CircleWaveform   0\t0  0.3 ')).toEqual({kind: 'CircleWaveform', args: [0, 0, 0.3]});
    });

    it('gives a bare name no parameters', (): void => {
      expect(parseGeneratorStage('Trace')).toEqual({kind: 'Trace', args: []});
    });
  });

  describe('parseArgs', (): void => {
    it('splits a parameter string into numbers', (): void => {
      expect(parseArgs('0.02 24 -0.5')).toEqual([0.02, 24, -0.5]);
    });

    it('tolerates padding and runs of whitespace', (): void => {
      expect(parseArgs('  1   2\t3 ')).toEqual([1, 2, 3]);
    });

    it('gives an empty string no parameters', (): void => {
      expect(parseArgs('')).toEqual([]);
    });
  });

  describe('parsePalette', (): void => {
    it('expands 256 hex entries into 768 packed bytes', (): void => {
      expect(parsePalette('000000'.repeat(256))).toHaveLength(768);
    });

    it('reads each entry as red, green then blue', (): void => {
      const bytes: Uint8Array = parsePalette('0A141E' + '000000'.repeat(254) + 'FF8001');

      expect(Array.from(bytes.slice(0, 3))).toEqual([10, 20, 30]);
      expect(Array.from(bytes.slice(765))).toEqual([255, 128, 1]);
    });
  });

  describe('rampPalette', (): void => {
    it('produces 256 six-character entries', (): void => {
      expect(rampPalette(['000000', 'FFFFFF'])).toHaveLength(1536);
    });

    it('starts on the first stop and ends on the last', (): void => {
      const ramp: string = rampPalette(['102030', 'A0B0C0']);

      expect(ramp.substring(0, 6)).toBe('102030');
      expect(ramp.substring(1530)).toBe('A0B0C0');
    });

    it('interpolates each channel linearly between two stops', (): void => {
      const bytes: Uint8Array = parsePalette(rampPalette(['000000', 'FF0080']));

      // Entry 51 is a fifth of the way along.
      expect(Array.from(bytes.slice(51 * 3, 51 * 3 + 3))).toEqual([51, 0, 26]);
    });

    it('passes through every intermediate stop', (): void => {
      const bytes: Uint8Array = parsePalette(rampPalette(['000000', 'FF0000', '0000FF', '00FF00']));

      // Four stops make three segments of 85 entries each.
      expect(Array.from(bytes.slice(85 * 3, 85 * 3 + 3))).toEqual([255, 0, 0]);
      expect(Array.from(bytes.slice(170 * 3, 170 * 3 + 3))).toEqual([0, 0, 255]);
      expect(Array.from(bytes.slice(255 * 3))).toEqual([0, 255, 0]);
    });

    it('writes upper-case hex whatever case the stops are in', (): void => {
      expect(rampPalette(['abcdef', 'abcdef']).substring(0, 6)).toBe('ABCDEF');
    });

    it('pads single-digit channels to two characters', (): void => {
      expect(rampPalette(['010203', '010203']).substring(0, 6)).toBe('010203');
    });
  });

  // ==========================================================================
  // Construction
  // ==========================================================================

  describe('construction', (): void => {
    it('takes its name and category from the preset', (): void => {
      const viz: Visualization = create(presetWith({name: 'Halo', category: 'Signature'}));

      expect(viz.name).toBe('Halo');
      expect(viz.category).toBe('Signature');
    });

    it('builds an instance of the shared engine', (): void => {
      expect(create()).toBeInstanceOf(FeedbackVisualization);
    });

    it('gives each preset its own class', (): void => {
      expect(feedbackVisualization(presetWith())).not.toBe(feedbackVisualization(presetWith()));
    });

    it('refuses a preset that names an unknown warp', (): void => {
      expect((): Visualization => create(presetWith({warp: 'Nope'}))).toThrow('Unknown warp: Nope');
    });

    it('refuses to start without a WebGL context', (): void => {
      fakes.webglAvailable = false;

      expect((): Visualization => create()).toThrow('Failed to get WebGL context');
    });

    it('links one program per pass', (): void => {
      create();

      expect(gl.callsTo('linkProgram')).toHaveLength(5);
    });

    it('splices the preset warp into the warp shader', (): void => {
      create();

      const warpFragment: string | undefined = gl.callsTo('shaderSource')
        .map((call: RecordedGlCall): string => call.args[1] as string)
        .find((source: string): boolean => source.includes(PASS_MARKERS['warp']));
      expect(warpFragment).toContain(WARP_BODIES['RippleWarp']);
      expect(warpFragment).not.toContain('/*BODY*/');
    });

    it('releases every shader once its program is linked', (): void => {
      create();

      expect(gl.callsTo('deleteShader')).toHaveLength(10);
    });

    it('reports a shader that fails to compile, with the driver log', (): void => {
      gl.failCompile = true;

      expect((): Visualization => create()).toThrow('Failed to compile shader: fake failure');
    });

    it('releases a shader that fails to compile', (): void => {
      gl.failCompile = true;

      expect((): Visualization => create()).toThrow();
      expect(gl.callsTo('deleteShader')).toHaveLength(1);
    });

    it('reports a shader failure even when the driver gives no log', (): void => {
      gl.failCompile = true;
      gl.infoLog = null;

      expect((): Visualization => create()).toThrow('Failed to compile shader: unknown error');
    });

    it('reports a program that fails to link, with the driver log', (): void => {
      gl.failLink = true;

      expect((): Visualization => create()).toThrow('Failed to link WebGL program: fake failure');
    });

    it('releases a program that fails to link', (): void => {
      gl.failLink = true;

      expect((): Visualization => create()).toThrow();
      expect(gl.callsTo('deleteProgram')).toHaveLength(1);
    });

    it('reports a link failure even when the driver gives no log', (): void => {
      gl.failLink = true;
      gl.infoLog = null;

      expect((): Visualization => create()).toThrow('Failed to link WebGL program: unknown error');
    });

    it('reports a context that will not create a program', (): void => {
      gl.refuseProgram = true;

      expect((): Visualization => create()).toThrow('Failed to create WebGL program');
    });

    it('reports a context that will not create a shader', (): void => {
      gl.refuseShader = true;

      expect((): Visualization => create()).toThrow('Failed to create WebGL shader');
    });

    it('uploads the palette as an opaque 256 by 1 texture', (): void => {
      create();

      const upload: RecordedGlCall | undefined = gl.callsTo('texImage2D')
        .find((call: RecordedGlCall): boolean => call.args[3] === 256);
      const texels: Uint8Array = upload?.args[8] as Uint8Array;
      expect(upload?.args[4]).toBe(1);
      expect(texels).toHaveLength(1024);
      expect(Array.from(texels.slice(0, 4))).toEqual([0, 0, 0, 255]);
      expect(Array.from(texels.slice(200 * 4, 200 * 4 + 4))).toEqual([200, 200, 200, 255]);
    });

    it('uploads a full-screen quad of two triangles', (): void => {
      create();

      const quad: Float32Array = gl.callsTo('bufferData')[0].args[1] as Float32Array;
      expect(Array.from(quad)).toEqual([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    });
  });

  // ==========================================================================
  // Resize
  // ==========================================================================

  describe('resize', (): void => {
    /** The sizes of the surface textures allocated so far. */
    function surfaceSizes(): unknown[][] {
      return gl.callsTo('texImage2D')
        .filter((call: RecordedGlCall): boolean => call.args[8] === null)
        .map((call: RecordedGlCall): unknown[] => [call.args[3], call.args[4]]);
    }

    it('allocates two surfaces 384 pixels high at the canvas aspect ratio', (): void => {
      createSized();

      expect(surfaceSizes()).toEqual([[SURFACE_WIDTH, SURFACE_HEIGHT], [SURFACE_WIDTH, SURFACE_HEIGHT]]);
    });

    it('gives each surface its own framebuffer and clears it', (): void => {
      createSized();

      expect(gl.callsTo('createFramebuffer')).toHaveLength(2);
      expect(gl.callsTo('clear')).toHaveLength(2);
      expect(gl.callsTo('clear')[0].framebuffer).not.toBe(gl.callsTo('clear')[1].framebuffer);
    });

    it('caps the surface width on a very wide canvas', (): void => {
      create().resize(4000, 1000);

      expect(surfaceSizes()[0]).toEqual([1024, SURFACE_HEIGHT]);
    });

    it('keeps the surface at least one pixel wide on a very tall canvas', (): void => {
      create().resize(1, 10_000);

      expect(surfaceSizes()[0]).toEqual([1, SURFACE_HEIGHT]);
    });

    it('keeps its surfaces when the canvas changes size but not shape', (): void => {
      const viz: Visualization = createSized();

      viz.resize(1600, 1200);

      expect(surfaceSizes()).toHaveLength(2);
      expect(gl.callsTo('deleteTexture')).toEqual([]);
    });

    it('replaces its surfaces when the canvas changes shape', (): void => {
      const viz: Visualization = createSized();

      viz.resize(600, 600);

      expect(surfaceSizes().slice(2)).toEqual([[SURFACE_HEIGHT, SURFACE_HEIGHT], [SURFACE_HEIGHT, SURFACE_HEIGHT]]);
      expect(gl.callsTo('deleteTexture')).toHaveLength(2);
      expect(gl.callsTo('deleteFramebuffer')).toHaveLength(2);
    });

    it.each([
      {width: 0, height: HEIGHT},
      {width: WIDTH, height: 0},
    ])('allocates nothing for a $width by $height canvas', ({width, height}): void => {
      create().resize(width, height);

      expect(surfaceSizes()).toEqual([]);
    });
  });

  // ==========================================================================
  // Frame
  // ==========================================================================

  describe('frame', (): void => {
    it('draws nothing and reads no audio before it has a size', (): void => {
      const viz: Visualization = create();
      gl.forget();

      frames(viz, 3);

      expect(gl.calls).toEqual([]);
      expect(analyser.spectrumReads).toEqual([]);
    });

    it('reads the waveform and the spectrum once a frame', (): void => {
      const viz: Visualization = createSized();

      frames(viz, 2);

      expect(analyser.waveformReads).toEqual([2048, 2048]);
      expect(analyser.spectrumReads).toEqual([1024, 1024]);
    });

    it('presents to the canvas every frame', (): void => {
      const viz: Visualization = createSized();

      frames(viz, 5);

      const presents: RecordedGlCall[] = gl.callsTo('drawArrays')
        .filter((call: RecordedGlCall): boolean => passOf(call) === 'present');
      expect(presents).toHaveLength(5);
      for (const present of presents) {
        expect(present.framebuffer).toBeNull();
      }
    });

    it('presents at the size of the canvas rather than of the surface', (): void => {
      const viz: Visualization = createSized();

      frames(viz, 1);

      expect(gl.callsTo('viewport').at(-1)?.args).toEqual([0, 0, WIDTH, HEIGHT]);
    });

    it('only presents on the frames between warp steps', (): void => {
      const viz: Visualization = createSized();

      frames(viz, 2);

      expect(passesDrawn()).toEqual(['present', 'present']);
    });

    it('advances the surface on every third frame', (): void => {
      const viz: Visualization = createSized();

      frames(viz, 7);

      expect(passesDrawn().filter((pass: string): boolean => pass === 'warp')).toHaveLength(2);
    });

    it('runs the pre generators, then the warp, then the post generators, then presents', (): void => {
      const viz: Visualization = createSized();
      frames(viz, 2);
      gl.forget();

      frames(viz, 1);

      expect(passesDrawn()).toEqual(['trace', 'warp', 'radial', 'present']);
    });

    it('warps from the surface the pre generators drew on into the other one', (): void => {
      const viz: Visualization = createSized();

      steps(viz, 1);

      const [trace, warp, radial]: RecordedGlCall[] = gl.callsTo('drawArrays')
        .filter((call: RecordedGlCall): boolean => passOf(call) !== 'present');
      expect(trace.framebuffer).not.toBeNull();
      expect(warp.framebuffer).not.toBeNull();
      expect(warp.framebuffer).not.toBe(trace.framebuffer);
      expect(radial.framebuffer).toBe(warp.framebuffer);
    });

    it('swaps the two surfaces on every step', (): void => {
      const viz: Visualization = createSized();

      steps(viz, 3);

      const targets: (FakeGlObject | null)[] = gl.callsTo('drawArrays')
        .filter((call: RecordedGlCall): boolean => passOf(call) === 'warp')
        .map((call: RecordedGlCall): FakeGlObject | null => call.framebuffer);
      expect(targets[1]).not.toBe(targets[0]);
      expect(targets[2]).toBe(targets[0]);
    });

    it('draws the generators and the warp at the size of the surface', (): void => {
      const viz: Visualization = createSized();

      steps(viz, 1);

      const surfaceViewports: unknown[][] = gl.callsTo('viewport')
        .filter((call: RecordedGlCall): boolean => call.framebuffer !== null)
        .map((call: RecordedGlCall): unknown[] => [...call.args]);
      expect(surfaceViewports).toEqual(new Array<number[]>(3).fill([0, 0, SURFACE_WIDTH, SURFACE_HEIGHT]));
    });

    it('adds generator output to the surface rather than replacing it', (): void => {
      const viz: Visualization = createSized();

      steps(viz, 1);

      for (const blend of gl.callsTo('blendFunc')) {
        expect(blend.args).toEqual([constants().ONE, constants().ONE]);
      }
      expect(gl.callsTo('blendFunc')).toHaveLength(2);
    });

    it('turns blending off again for the warp and the present', (): void => {
      const viz: Visualization = createSized();

      steps(viz, 1);

      // Each generator stage switches it on then off; the warp and present
      // passes each switch it off for themselves.
      const methods: string[] = gl.calls
        .filter((call: RecordedGlCall): boolean => call.method === 'enable' || call.method === 'disable'
          || call.method === 'drawArrays')
        .filter((call: RecordedGlCall): boolean => call.method === 'drawArrays' || call.args[0] === constants().BLEND)
        .map((call: RecordedGlCall): string => (call.method === 'drawArrays' ? passOf(call) : call.method));
      expect(methods.slice(-10)).toEqual([
        'enable', 'trace', 'disable',
        'disable', 'warp',
        'enable', 'radial', 'disable',
        'disable', 'present',
      ]);
    });

    it('skips the generator pass altogether for a preset with no generators', (): void => {
      const viz: Visualization = createSized(presetWith({pre: [], post: []}));

      steps(viz, 1);

      expect(passesDrawn().slice(-2)).toEqual(['warp', 'present']);
      expect(gl.callsTo('blendFunc')).toEqual([]);
    });

    it('draws nothing for a generator it does not know', (): void => {
      const viz: Visualization = createSized(presetWith({pre: [{kind: 'Mystery', args: [1, 2]}], post: []}));

      steps(viz, 1);

      expect(passesDrawn().slice(-2)).toEqual(['warp', 'present']);
    });

    it('draws several generators in one stage in the order the preset lists them', (): void => {
      const viz: Visualization = createSized(presetWith({
        pre: [{kind: 'CircleWaveform', args: []}, {kind: 'Trace', args: []}],
        post: [],
      }));
      frames(viz, 2);
      gl.forget();

      frames(viz, 1);

      expect(passesDrawn()).toEqual(['radial', 'trace', 'warp', 'present']);
    });

    it('hands the warp the preset parameters, padded with zeros', (): void => {
      const viz: Visualization = createSized();

      steps(viz, 1);

      expect(gl.uniformWrites('uParams')).toEqual([[0.02, 24, 0.5, 0]]);
    });

    it('hands the warp zeros for a preset with no warp parameters', (): void => {
      const viz: Visualization = createSized(presetWith({warpArgs: []}));

      steps(viz, 1);

      expect(gl.uniformWrites('uParams')).toEqual([[0, 0, 0, 0]]);
    });

    it('hands the warp the surface size, the decay and the preset smoke settings', (): void => {
      const viz: Visualization = createSized();

      steps(viz, 1);

      expect(gl.uniformWrites('uSize', PASS_MARKERS['warp'])).toEqual([[SURFACE_WIDTH, SURFACE_HEIGHT]]);
      expect(floats('uDecay', 'warp')).toEqual([0.94]);
      expect(floats('uDiffuse', 'warp')).toEqual([0.2]);
      expect(floats('uDiffuseReach', 'warp')).toEqual([3]);
    });

    it('presents the surface through the palette on separate texture units', (): void => {
      const viz: Visualization = createSized();

      frames(viz, 1);

      expect(gl.uniformWrites('uSurface', PASS_MARKERS['present'])).toEqual([[0]]);
      expect(gl.uniformWrites('uPalette')).toEqual([[1]]);
    });
  });

  // ==========================================================================
  // Audio
  // ==========================================================================

  describe('audio', (): void => {
    it('packs the waveform into a 128-texel texture on each step', (): void => {
      // Every sixteenth sample holds its own texel index.
      analyser.waveform = (index: number): number => index / 16;
      const viz: Visualization = createSized();

      steps(viz, 1);

      const upload: RecordedGlCall = gl.callsTo('texSubImage2D')[0];
      const texels: Uint8Array = upload.args[8] as Uint8Array;
      expect(upload.args.slice(4, 6)).toEqual([128, 1]);
      expect([texels[0], texels[4], texels[100 * 4], texels[127 * 4]]).toEqual([0, 1, 100, 127]);
    });

    it('does not upload the waveform on the frames between steps', (): void => {
      const viz: Visualization = createSized();

      frames(viz, 2);

      expect(gl.callsTo('texSubImage2D')).toEqual([]);
    });

    it('draws the trace at its resting amplitude in silence', (): void => {
      const viz: Visualization = createSized();

      steps(viz, 1);

      // 0.34 of the surface, at the default 25% sensitivity.
      expect(floats('uAmplitude', 'trace')[0]).toBeCloseTo(0.17, 12);
    });

    it('flexes the trace further once there is bass', (): void => {
      analyser.spectrum = bassHeavy(24);
      const viz: Visualization = createSized();

      steps(viz, 1);

      // Three frames of smoothing toward a bass level of 0.5, at 60% flex.
      const bass: number = 0.5 * (1 - 0.82 ** 3);
      expect(floats('uAmplitude', 'trace')[0]).toBeCloseTo(0.17 * (1 + 0.6 * bass), 10);
    });

    it('builds the bass response up over several steps rather than at once', (): void => {
      analyser.spectrum = bassHeavy(24);
      const viz: Visualization = createSized();

      steps(viz, 4);

      const amplitudes: number[] = floats('uAmplitude', 'trace');
      for (let i: number = 1; i < amplitudes.length; i++) {
        expect(amplitudes[i]).toBeGreaterThan(amplitudes[i - 1]);
      }
      // Never beyond the fully flexed amplitude: 0.17 with half the 0.6 flex.
      expect(amplitudes[3]).toBeLessThan(0.17 * 1.3);
    });

    it('lets the bass response die away once the bass stops', (): void => {
      analyser.spectrum = bassHeavy(24);
      const viz: Visualization = createSized();
      steps(viz, 4);

      analyser.spectrum = flat(0);
      steps(viz, 20);

      expect(floats('uAmplitude', 'trace').at(-1)).toBeCloseTo(0.17, 5);
    });

    it('averages only the twenty-four lowest bins into the bass response', (): void => {
      analyser.spectrum = (index: number): number => (index < 24 ? 0 : 255);
      const viz: Visualization = createSized();

      steps(viz, 2);

      expect(floats('uAmplitude', 'trace').at(-1)).toBeCloseTo(0.17, 12);
    });

    it('scales the trace with the sensitivity control', (): void => {
      const viz: Visualization = createSized();
      viz.setSensitivity(1);

      steps(viz, 1);

      expect(floats('uAmplitude', 'trace')[0]).toBeCloseTo(0.68, 12);
    });

    it('flattens the trace entirely at zero sensitivity', (): void => {
      analyser.spectrum = flat(255);
      const viz: Visualization = createSized();
      viz.setSensitivity(0);

      steps(viz, 1);

      expect(floats('uAmplitude', 'trace')[0]).toBe(0);
    });

    it('scales the trace by its first parameter and offsets it by its second', (): void => {
      const viz: Visualization = createSized(presetWith({pre: [{kind: 'Trace', args: [2, -0.2]}]}));

      steps(viz, 1);

      expect(floats('uAmplitude', 'trace')[0]).toBeCloseTo(0.34, 12);
      expect(floats('uCentre', 'trace')[0]).toBeCloseTo(0.3, 12);
    });

    it('draws a trace with no parameters at unit scale through the middle', (): void => {
      const viz: Visualization = createSized(presetWith({pre: [{kind: 'Trace', args: []}]}));

      steps(viz, 1);

      expect(floats('uAmplitude', 'trace')[0]).toBeCloseTo(0.17, 12);
      expect(floats('uCentre', 'trace')[0]).toBe(0.5);
    });

    it('rests the ring at the preset fraction of the shorter half-axis', (): void => {
      const viz: Visualization = createSized();

      steps(viz, 1);

      // Half of 384, times 0.3.
      expect(floats('uBase', 'radial')[0]).toBeCloseTo(57.6, 10);
      expect(gl.uniformWrites('uSize', PASS_MARKERS['radial'])).toEqual([[SURFACE_WIDTH, SURFACE_HEIGHT]]);
    });

    it.each([
      {case: 'missing', args: []},
      {case: 'zero', args: [0, 0, 0]},
      {case: 'negative', args: [0, 0, -0.3]},
    ])('falls back to a 0.45 ring when the radius parameter is $case', ({args}): void => {
      const viz: Visualization = createSized(presetWith({post: [{kind: 'CircleWaveform', args}]}));

      steps(viz, 1);

      expect(floats('uBase', 'radial')[0]).toBeCloseTo(86.4, 10);
    });

    it('scales how far the ring swings with the sensitivity control', (): void => {
      const viz: Visualization = createSized();
      steps(viz, 1);

      viz.setSensitivity(1);
      steps(viz, 1);

      // Half of 384, times 0.22, times twice the sensitivity.
      const swings: number[] = floats('uSwing', 'radial');
      expect(swings[0]).toBeCloseTo(21.12, 10);
      expect(swings[1]).toBeCloseTo(84.48, 10);
    });

    it('advances the phase on every frame, not only on steps', (): void => {
      const viz: Visualization = createSized();

      steps(viz, 2);

      // 0.011 radians a frame in silence, sampled at frames three and six.
      const phases: number[] = floats('uPhase', 'warp');
      expect(phases[0]).toBeCloseTo(0.033, 12);
      expect(phases[1]).toBeCloseTo(0.066, 12);
    });

    it('advances the phase faster while there is bass', (): void => {
      analyser.spectrum = bassHeavy(24);
      const viz: Visualization = createSized();

      steps(viz, 1);

      expect(floats('uPhase', 'warp')[0]).toBeGreaterThan(0.04);
    });

    it('keeps the phase wrapped inside one turn over a long session', (): void => {
      analyser.spectrum = bassHeavy(24);
      const viz: Visualization = createSized();

      steps(viz, 400);

      const phases: number[] = floats('uPhase', 'warp');
      expect(Math.max(...phases)).toBeLessThan(Math.PI * 2);
      expect(Math.min(...phases)).toBeGreaterThanOrEqual(0);
      // It did wrap: the phase is not simply still climbing.
      expect(phases.some((phase: number, index: number): boolean => index > 0 && phase < phases[index - 1])).toBe(true);
    });

    it('reads into buffers of the new size after the FFT size changes', (): void => {
      const viz: Visualization = createSized();

      viz.setFftSize(512);
      frames(viz, 1);

      expect(analyser.waveformReads).toEqual([512]);
      expect(analyser.spectrumReads).toEqual([256]);
    });

    it('samples the whole of a smaller waveform buffer into the texture', (): void => {
      analyser.waveform = (index: number): number => index / 4;
      const viz: Visualization = createSized();
      viz.setFftSize(512);

      steps(viz, 1);

      const texels: Uint8Array = gl.callsTo('texSubImage2D')[0].args[8] as Uint8Array;
      expect([texels[0], texels[4], texels[127 * 4]]).toEqual([0, 1, 127]);
    });

    it.each([0, 255])('gives every pass finite numbers for an all-%i spectrum and waveform', (level: number): void => {
      analyser.spectrum = flat(level);
      analyser.waveform = flat(level);
      const viz: Visualization = createSized();
      viz.setSensitivity(1);

      steps(viz, 5);

      const values: unknown[] = gl.calls
        .filter((call: RecordedGlCall): boolean => call.method.startsWith('uniform'))
        .flatMap((call: RecordedGlCall): unknown[] => call.args.slice(1));
      expect(values.length).toBeGreaterThan(0);
      expect(values.filter((value: unknown): boolean => !Number.isFinite(value))).toEqual([]);
    });
  });

  // ==========================================================================
  // Pulse
  // ==========================================================================

  describe('pulse', (): void => {
    /** A visualization turned up far enough for full-scale bass to clear the pulse threshold. */
    function createLoud(preset: FeedbackSpec = presetWith()): Visualization {
      const viz: Visualization = createSized(preset);
      viz.setSensitivity(1);
      analyser.spectrum = bassHeavy(24);
      return viz;
    }

    it('presents the plain palette while no pulse is running', (): void => {
      const viz: Visualization = createSized();

      steps(viz, 2);

      expect(new Set<number>(floats('uPaletteShift', 'present'))).toEqual(new Set<number>([0]));
      expect(new Set<number>(floats('uBackground', 'present'))).toEqual(new Set<number>([0]));
    });

    it('takes the background white when a loud bass hit wins the roll', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      const viz: Visualization = createLoud();

      steps(viz, 1);

      expect(floats('uBackground', 'present').at(-1)).toBe(1);
    });

    it('sweeps the palette and eases the background back as the pulse runs', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      const viz: Visualization = createLoud();

      steps(viz, 3);

      // Two steps on from the one that started it.
      expect(floats('uPaletteShift', 'present').at(-1)).toBeCloseTo(255 * 2 / PULSE_STEPS, 10);
      expect(floats('uBackground', 'present').at(-1)).toBeCloseTo(1 - 2 / PULSE_STEPS, 10);
    });

    it('holds the pulse still on the frames between steps', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      const viz: Visualization = createLoud();
      steps(viz, 2);

      frames(viz, 2);

      const shifts: number[] = floats('uPaletteShift', 'present');
      expect(shifts.slice(-3)).toEqual(new Array<number>(3).fill(shifts.at(-1) as number));
    });

    it('returns to the plain palette once the pulse has crossed the scene', (): void => {
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.1);
      const viz: Visualization = createLoud();

      steps(viz, PULSE_STEPS + 2);

      expect(floats('uPaletteShift', 'present').at(-1)).toBe(0);
      expect(floats('uBackground', 'present').at(-1)).toBe(0);
    });

    it('never shifts the palette past one full rotation', (): void => {
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.1);
      const viz: Visualization = createLoud();

      steps(viz, PULSE_STEPS + 2);

      expect(Math.max(...floats('uPaletteShift', 'present'))).toBeLessThan(255);
      expect(Math.min(...floats('uBackground', 'present'))).toBeGreaterThanOrEqual(0);
    });

    it('does not fire when the roll is lost', (): void => {
      const viz: Visualization = createLoud();

      steps(viz, 3);

      expect(new Set<number>(floats('uBackground', 'present'))).toEqual(new Set<number>([0]));
    });

    it('makes a lost roll wait out the ten-second cooldown before rolling again', (): void => {
      const viz: Visualization = createLoud();
      steps(viz, 1);
      vi.spyOn(Math, 'random').mockReturnValue(0.1);

      steps(viz, 3, 1000);

      expect(new Set<number>(floats('uBackground', 'present'))).toEqual(new Set<number>([0]));
    });

    it('rolls again once the cooldown has passed', (): void => {
      const viz: Visualization = createLoud();
      steps(viz, 1);
      vi.spyOn(Math, 'random').mockReturnValue(0.1);

      steps(viz, 4, 1000);

      expect(floats('uBackground', 'present').at(-1)).toBe(1);
    });

    it('does not fire for bass below the threshold', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      const viz: Visualization = createSized();
      viz.setSensitivity(1);
      // 60/255 at full sensitivity settles at 0.47, under the 0.5 threshold.
      analyser.spectrum = flat(60);

      steps(viz, 40);

      expect(new Set<number>(floats('uBackground', 'present'))).toEqual(new Set<number>([0]));
    });

    it('does not consult the roll for bass below the threshold', (): void => {
      const roll: ReturnType<typeof vi.spyOn> = vi.spyOn(Math, 'random').mockReturnValue(0.1);
      const viz: Visualization = createSized();

      steps(viz, 5);

      expect(roll).not.toHaveBeenCalled();
    });

    it('never fires for a preset that does not pulse', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      const viz: Visualization = createLoud(presetWith({pulses: false}));

      steps(viz, 5);

      expect(new Set<number>(floats('uBackground', 'present'))).toEqual(new Set<number>([0]));
    });
  });

  // ==========================================================================
  // Idling
  // ==========================================================================

  describe('idling', (): void => {
    it('is idle before playback has ever started', (): void => {
      expect(createSized().isIdle()).toBe(true);
    });

    it('is not idle while playing', (): void => {
      const viz: Visualization = createSized();

      viz.setPlaying(true);

      expect(viz.isIdle()).toBe(false);
    });

    it('stays active part-way through the fade-out', (): void => {
      const viz: Visualization = createSized();
      viz.setPlaying(true);
      viz.setPlaying(false);

      frames(viz, 1, 4999);

      expect(viz.isIdle()).toBe(false);
    });

    it('goes idle five seconds after playback stops, however few frames were drawn', (): void => {
      const viz: Visualization = createSized();
      viz.setPlaying(true);
      viz.setPlaying(false);

      frames(viz, 1, 5000);

      expect(viz.isIdle()).toBe(true);
    });

    it('keeps the fade clock running on a canvas with no size', (): void => {
      const viz: Visualization = create();
      viz.setPlaying(true);
      viz.setPlaying(false);

      frames(viz, 5, 1000);

      expect(viz.isIdle()).toBe(true);
    });
  });

  // ==========================================================================
  // A context that cannot create textures
  // ==========================================================================

  describe('when the context cannot create surfaces', (): void => {
    it('draws nothing', (): void => {
      const viz: Visualization = create();
      gl.refuseTexture = true;
      viz.resize(WIDTH, HEIGHT);

      frames(viz, 3);

      expect(gl.callsTo('drawArrays')).toEqual([]);
    });

    it('tries again on the next frame and carries on once it can', (): void => {
      const viz: Visualization = create();
      gl.refuseTexture = true;
      viz.resize(WIDTH, HEIGHT);
      frames(viz, 1);

      gl.refuseTexture = false;
      frames(viz, 1);

      expect(passesDrawn()).toEqual(['present']);
    });
  });

  // ==========================================================================
  // Destroy
  // ==========================================================================

  describe('destroy', (): void => {
    it('releases both surfaces, the palette and the waveform texture', (): void => {
      const viz: Visualization = createSized();

      viz.destroy();

      expect(gl.callsTo('deleteTexture')).toHaveLength(4);
      expect(gl.callsTo('deleteFramebuffer')).toHaveLength(2);
    });

    it('releases only what exists when it never had a size', (): void => {
      const viz: Visualization = create();

      viz.destroy();

      expect(gl.callsTo('deleteTexture')).toHaveLength(2);
      expect(gl.callsTo('deleteFramebuffer')).toEqual([]);
    });

    it('releases its vertex buffers', (): void => {
      const viz: Visualization = createSized();

      viz.destroy();

      expect(gl.callsTo('deleteBuffer')).toHaveLength(2);
    });

    it('releases all five programs', (): void => {
      const viz: Visualization = createSized();

      viz.destroy();

      const released: Set<unknown> = new Set<unknown>(
        gl.callsTo('deleteProgram').map((call: RecordedGlCall): unknown => call.args[0])
      );
      expect(released.size).toBe(5);
    });

    it('gives the WebGL context back', (): void => {
      const viz: Visualization = createSized();

      viz.destroy();

      expect(gl.contextLosses).toBe(1);
    });
  });
});

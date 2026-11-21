/**
 * @fileoverview Unit tests for the Mosaic visualization.
 *
 * Tests cover:
 * - Layout: surface creation, the scene pixel budget, the dot grid and its
 *   physical-pixel sizing
 * - Dots: the scene shrunk to one pixel of light per dot and handed to the
 *   graphics card, which draws every dot on black in a single call
 * - The graphics card: setup, and refusing to run without WebGL or instancing
 * - Waveform: only the left half drawn; rest position and amplitude
 * - Trail: per-frame fade, blur, the outward bleed and the rise
 * - Mirroring: the right half is the left flipped through the centre
 * - Afterglow: the colour ramp handed to the graphics card, from unlit, through
 *   the deep shade and main colour, to near-white
 * - Bass glow, and the overlapping waves that give every dot its size, each
 *   sized by the kick as it left the centre
 * - Hue jumps: grace period, cooldown, snapping and sweeping
 * - Fade-out, FFT size changes, destroy
 * - Edge inputs never hand the canvas a NaN or an infinity
 *
 * Canvas 2D, WebGL and Web Audio are faked; see visualization-test-fakes.group1.
 * Dot sizes are read from the sizes handed to the graphics card each frame.
 *
 * @module app/components/audio/audio-outlet/visualizations/mosaic-visualization.spec
 */

import {MosaicVisualization} from './mosaic-visualization';
import {
  bassHeavy,
  CanvasFakes,
  FakeAnalyser,
  flat,
  installCanvasFakes,
  RecordedCall,
  RecordedGlCall,
  RecordingContext2D,
} from './visualization-test-fakes.group1';

// ============================================================================
// Fixture geometry
// ============================================================================

/** Canvas size most tests run at: exactly the scene's pixel budget. */
const WIDTH: number = 640;
const HEIGHT: number = 360;

/** Dot pitch at a device pixel ratio of 1. */
const PITCH: number = 18;

/** Dots across and down a 640x360 canvas at that pitch. */
const COLUMNS: number = 36;
const ROWS: number = 20;

/** Strips the trail is redrawn in each frame. */
const BLEED_COLUMNS: number = 32;

/** Where the simulated clock starts, in milliseconds. */
const START_MS: number = 100_000;

/** Gap the bass trigger enforces between hits, in milliseconds. */
const COOLDOWN_MS: number = 8000;

/** The surfaces Mosaic creates, in the order it creates them. */
interface Surfaces {
  readonly main: RecordingContext2D;
  readonly scene: RecordingContext2D;
  readonly scratch: RecordingContext2D;
  readonly dots: RecordingContext2D;
}

describe('MosaicVisualization', (): void => {
  let fakes: CanvasFakes;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let viz: MosaicVisualization;
  let now: number;

  /** The recording contexts, named for the surface each belongs to. */
  function surfaces(): Surfaces {
    const [main, scene, scratch, dots]: RecordingContext2D[] = fakes.contexts;
    return {main, scene, scratch, dots};
  }

  /** Draws one frame after letting `elapsedMs` pass. */
  function frame(elapsedMs: number = 16): void {
    now += elapsedMs;
    viz.draw();
  }

  /** Draws `count` frames, `elapsedMs` apart. */
  function frames(count: number, elapsedMs: number = 16): void {
    for (let i: number = 0; i < count; i++) frame(elapsedMs);
  }

  /** Draws the frame that seeds the trigger's grace period, then waits it out. */
  function passGracePeriod(): void {
    frame();
    now += COOLDOWN_MS;
  }

  /** Side of a dot of size 1: the pitch less a tenth of it for the gap. */
  const UNIT_SIDE: number = PITCH * 0.9;

  /** Side of a dot at rest, between the waves: 1.2 times size 1, a little over its cell. */
  const REST_SIDE: number = UNIT_SIDE * 1.2;

  /** How far the waves have swollen a dot above its rest size. */
  function swellOf(side: number): number {
    return side - REST_SIDE;
  }

  /** Furthest any dot sits from the centre at the fixture size, in dots. */
  const MAX_DISTANCE: number = Math.hypot(17.5, 9.5);

  /** A dot as the graphics card was last asked to draw it. */
  interface DrawnDot {
    readonly index: number;
    readonly x: number;
    readonly distance: number;
    readonly side: number;

    /** How far the dot's light was pulled outward from the centre by the lenses, in dots. */
    readonly pull: number;

    /** How far the dot's light was pulled across that, which a lens never does, in dots. */
    readonly sideways: number;
  }

  /** The WebGL fake, typed as the context it stands in for, for its constants. */
  function gl(): WebGLRenderingContext {
    return fakes.webgl as unknown as WebGLRenderingContext;
  }

  /**
   * The dots as last drawn: each dot's size is read from the sizes last handed
   * to the graphics card, and its place from its index in the grid, which
   * overhangs the canvas by 4px on the left and fits it exactly top to bottom.
   */
  function drawnDots(): DrawnDot[] {
    const uploads: Float32Array[] = fakes.webgl.callsTo('bufferSubData')
      .map((call: RecordedGlCall): Float32Array => call.args[2] as Float32Array);
    const scales: Float32Array | undefined = uploads.filter((data: Float32Array): boolean => data.length === COLUMNS * ROWS).at(-1);
    const warps: Float32Array | undefined = uploads.filter((data: Float32Array): boolean => data.length === COLUMNS * ROWS * 2).at(-1);
    if (!scales || !warps) return [];
    const dots: DrawnDot[] = [];
    for (let i: number = 0; i < scales.length; i++) {
      const x: number = -4 + ((i % COLUMNS) + 0.5) * PITCH;
      const y: number = (Math.floor(i / COLUMNS) + 0.5) * PITCH;
      const distance: number = Math.hypot(x - WIDTH / 2, y - HEIGHT / 2) / PITCH;
      const outX: number = distance > 0 ? (x - WIDTH / 2) / PITCH / distance : 0;
      const outY: number = distance > 0 ? (y - HEIGHT / 2) / PITCH / distance : 0;
      const warpX: number = warps[i * 2];
      const warpY: number = warps[i * 2 + 1];
      dots.push({
        index: i,
        x,
        distance,
        side: UNIT_SIDE * scales[i],
        pull: warpX * outX + warpY * outY,
        sideways: warpX * outY - warpY * outX,
      });
    }
    return dots;
  }

  /** Forgets everything recorded so far, on every canvas. */
  function forgetAll(): void {
    fakes.forget();
    fakes.webgl.forget();
  }

  /** Draws `count` frames, then one more with only its own calls recorded. */
  function framesThenRecord(count: number): void {
    frames(count - 1);
    forgetAll();
    frame();
  }

  /** The biggest dot drawn. */
  function crest(): DrawnDot {
    return drawnDots().reduce((best: DrawnDot, dot: DrawnDot): DrawnDot => (dot.side > best.side ? dot : best));
  }

  /** The afterglow ramp handed to the graphics card: RGB for each step of light. */
  function ramp(): Uint8Array {
    const upload: RecordedGlCall = fakes.webgl.callsTo('texImage2D')
      .filter((call: RecordedGlCall): boolean => call.args.length === 9).at(-1)!;
    return upload.args[8] as Uint8Array;
  }

  /** One step of the ramp, unlit (0) to fully lit (255). */
  function rampColour(step: number): number[] {
    const bytes: Uint8Array = ramp();
    return [bytes[step * 3], bytes[step * 3 + 1], bytes[step * 3 + 2]];
  }

  /** The colour of a fully lit dot: the ramp's near-white end, which follows the hue. */
  function hotColour(): number[] {
    return rampColour(255);
  }

  /** The bass glow last handed to the graphics card. */
  function glow(): number {
    return fakes.webgl.uniformWrites('uGlow').at(-1)![0] as number;
  }

  /** Sum of the channels of a colour. */
  function brightnessOf(colour: readonly number[]): number {
    return colour[0] + colour[1] + colour[2];
  }

  /** How far apart two colours are, channel by channel. */
  function difference(a: readonly number[], b: readonly number[]): number {
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  }

  /** Draws `count` frames, collecting a fully lit dot's colour after each. */
  function coloursOver(count: number): number[][] {
    const colours: number[][] = [];
    for (let i: number = 0; i < count; i++) {
      frame();
      colours.push(hotColour());
    }
    return colours;
  }

  /** Frame-to-frame colour changes too large to be the drift or a sweep: snaps. */
  function snaps(colours: readonly number[][]): number {
    let count: number = 0;
    for (let i: number = 1; i < colours.length; i++) {
      if (difference(colours[i], colours[i - 1]) > 40) count++;
    }
    return count;
  }

  /** Sets the device pixel ratio the visualization sees. */
  function setDevicePixelRatio(ratio: number): void {
    Object.defineProperty(window, 'devicePixelRatio', {value: ratio, configurable: true});
  }

  beforeEach((): void => {
    fakes = installCanvasFakes();
    now = START_MS;
    vi.spyOn(performance, 'now').mockImplementation((): number => now);
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    setDevicePixelRatio(1);

    analyser = new FakeAnalyser();
    canvas = document.createElement('canvas');
    viz = new MosaicVisualization({canvas, analyser: analyser.asNode()});
  });

  afterEach((): void => {
    fakes.restore();
    vi.restoreAllMocks();
    setDevicePixelRatio(1);
  });

  // ==========================================================================
  // Identity
  // ==========================================================================

  describe('identity', (): void => {
    it('is listed as Mosaic under Signature', (): void => {
      expect(viz.name).toBe('Mosaic');
      expect(viz.category).toBe('Signature');
    });

    it('always renders at the native resolution, so the dots stay crisp', (): void => {
      expect(viz.rendersAtNativeResolution).toBe(true);
    });
  });

  // ==========================================================================
  // Before it has a size
  // ==========================================================================

  describe('before it has been given a size', (): void => {
    it('draws nothing and reads nothing', (): void => {
      frame();

      expect(surfaces().main.calls).toEqual([]);
      expect(analyser.spectrumReads).toEqual([]);
      expect(analyser.waveformReads).toEqual([]);
      expect(fakes.contexts).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Layout
  // ==========================================================================

  describe('resize', (): void => {
    it('creates its three off-screen surfaces', (): void => {
      viz.resize(WIDTH, HEIGHT);

      expect(fakes.contexts).toHaveLength(4);
    });

    it('holds only the left half in the scene, at full size while it fits the pixel budget', (): void => {
      viz.resize(WIDTH, HEIGHT);

      const {scene, scratch}: Surfaces = surfaces();
      expect([scene.canvas.width, scene.canvas.height]).toEqual([WIDTH / 2, HEIGHT]);
      expect([scratch.canvas.width, scratch.canvas.height]).toEqual([WIDTH / 2, HEIGHT]);
    });

    it('shrinks the scene to the budget on a larger canvas', (): void => {
      viz.resize(1920, 1080);

      const {scene}: Surfaces = surfaces();
      expect([scene.canvas.width, scene.canvas.height]).toEqual([320, 360]);
    });

    it('maps canvas coordinates onto the reduced scene', (): void => {
      viz.resize(1920, 1080);

      expect(surfaces().scene.callsTo('setTransform').at(-1)?.args).toEqual([1 / 3, 0, 0, 1 / 3, 0, 0]);
    });

    it('does not resize the surfaces again when the size is unchanged', (): void => {
      viz.resize(WIDTH, HEIGHT);
      const scene: HTMLCanvasElement = surfaces().scene.canvas;
      const spy: ReturnType<typeof vi.spyOn> = vi.spyOn(scene, 'width', 'set');

      viz.resize(WIDTH, HEIGHT);

      expect(spy).not.toHaveBeenCalled();
    });

    it('clears the main canvas', (): void => {
      viz.resize(WIDTH, HEIGHT);

      expect(surfaces().main.callsTo('clearRect').at(-1)?.args).toEqual([0, 0, WIDTH, HEIGHT]);
    });
  });

  // ==========================================================================
  // Dots
  // ==========================================================================

  describe('dots', (): void => {
    it('holds one pixel per dot, 18-pixel dots at a device pixel ratio of 1', (): void => {
      viz.resize(WIDTH, HEIGHT);

      const dots: HTMLCanvasElement = surfaces().dots.canvas;
      expect([dots.width, dots.height]).toEqual([COLUMNS, ROWS]);
    });

    it('halves the dot in canvas pixels on a 2x display, keeping it 18 physical pixels', (): void => {
      setDevicePixelRatio(2);
      viz.resize(WIDTH, HEIGHT);

      const dots: HTMLCanvasElement = surfaces().dots.canvas;
      expect([dots.width, dots.height]).toEqual([Math.ceil(WIDTH / 9), Math.ceil(HEIGHT / 9)]);
    });

    it('accounts for a canvas that is stretched to a larger display', (): void => {
      vi.spyOn(canvas, 'clientWidth', 'get').mockReturnValue(WIDTH * 2);
      viz.resize(WIDTH, HEIGHT);

      expect(surfaces().dots.canvas.width).toBe(Math.ceil(WIDTH / 9));
    });

    it('never makes a dot smaller than six canvas pixels', (): void => {
      setDevicePixelRatio(16);
      viz.resize(WIDTH, HEIGHT);

      expect(surfaces().dots.canvas.width).toBe(Math.ceil(WIDTH / 6));
    });

    it('adds the scene\'s light over black, boosted', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      const dots: RecordingContext2D = surfaces().dots;
      const fill: RecordedCall = dots.callsTo('fillRect')[0];
      expect(fill.args).toEqual([0, 0, COLUMNS, ROWS]);
      expect(fill.state.fillStyle).toBe('rgb(0, 0, 0)');
      const excite: RecordedCall = dots.callsTo('drawImage')[0];
      expect(excite.args[0]).toBe(surfaces().scene.canvas);
      expect(excite.state.globalCompositeOperation).toBe('lighter');
      expect(excite.state.filter).toBe('brightness(2.2)');
      expect(excite.state.imageSmoothingQuality).toBe('high');
    });

    it('hands the light to the graphics card each frame, never reading it back', (): void => {
      viz.resize(WIDTH, HEIGHT);
      framesThenRecord(2);

      const light: RecordedGlCall[] = fakes.webgl.callsTo('texImage2D')
        .filter((call: RecordedGlCall): boolean => call.args.length === 6);
      expect(light).toHaveLength(1);
      expect(light[0].args[5]).toBe(surfaces().dots.canvas);
      expect(surfaces().dots.callsTo('getImageData')).toEqual([]);
    });

    it('lines the left half up with the grid, which overhangs the canvas evenly', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      // 36 dots of 18 overhang 640 by 8, so 4 each side; 20 of 18 fit 360 exactly.
      const excite: RecordedCall = surfaces().dots.callsTo('drawImage')[0];
      const expected: readonly number[] = [4 / PITCH, 0, WIDTH / 2 / PITCH, HEIGHT / PITCH];
      excite.args.slice(1).forEach((value: unknown, index: number): void => {
        expect(value as number).toBeCloseTo(expected[index]);
      });
    });

    it('draws the same half again, flipped both ways through the centre, for the right half', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      const dots: RecordingContext2D = surfaces().dots;
      const [left, right]: RecordedCall[] = dots.callsTo('drawImage');
      expect(right.args).toEqual(left.args);
      expect(right.state.globalCompositeOperation).toBe('lighter');

      // A point reflection through the canvas centre, in dot coordinates.
      const centreX: number = (WIDTH / 2 + 4) / PITCH;
      const centreY: number = HEIGHT / 2 / PITCH;
      const [x, y]: readonly unknown[] = dots.callsTo('translate')[0].args;
      expect(x as number).toBeCloseTo(centreX * 2);
      expect(y as number).toBeCloseTo(centreY * 2);
      expect(dots.callsTo('scale')[0].args).toEqual([-1, -1]);

      // The flip comes between the two draws.
      const order: string[] = dots.calls.map((call: RecordedCall): string => call.method)
        .filter((method: string): boolean => ['drawImage', 'translate', 'scale'].includes(method));
      expect(order).toEqual(['drawImage', 'translate', 'scale', 'drawImage']);
    });

    it('draws every dot on black in a single call, then lays it onto the canvas', (): void => {
      viz.resize(WIDTH, HEIGHT);
      framesThenRecord(200);

      expect(fakes.webgl.callsTo('clearColor').at(-1)?.args).toEqual([0, 0, 0, 1]);
      const draws: RecordedGlCall[] = fakes.webgl.callsTo('drawArraysInstancedANGLE');
      expect(draws).toHaveLength(1);
      expect(draws[0].args).toEqual([gl().TRIANGLE_STRIP, 0, 4, COLUMNS * ROWS]);
      expect(drawnDots()).toHaveLength(COLUMNS * ROWS);

      const laid: RecordedCall = surfaces().main.callsTo('drawImage').at(-1)!;
      expect(laid.args.slice(1)).toEqual([0, 0]);
      expect([(laid.args[0] as HTMLCanvasElement).width, (laid.args[0] as HTMLCanvasElement).height])
        .toEqual([WIDTH, HEIGHT]);
    });

    it('hands the graphics card every dot\'s cell once, on resize', (): void => {
      viz.resize(WIDTH, HEIGHT);

      const cells: Float32Array = fakes.webgl.callsTo('bufferData')
        .map((call: RecordedGlCall): unknown => call.args[1])
        .find((data: unknown): boolean => data instanceof Float32Array && data.length === COLUMNS * ROWS * 2) as Float32Array;
      expect(Array.from(cells.slice(0, 4))).toEqual([0, 0, 1, 0]);
      expect(Array.from(cells.slice(COLUMNS * 2, COLUMNS * 2 + 2))).toEqual([0, 1]);

      forgetAll();
      frame();
      expect(fakes.webgl.callsTo('bufferData')).toEqual([]);
      expect(fakes.webgl.uniformWrites('uGrid').at(-1)).toEqual([COLUMNS, ROWS]);
    });

    it('rounds the dots, colours them from the light and ramp, and stacks the biggest on top', (): void => {
      viz.resize(WIDTH, HEIGHT);
      analyser.spectrum = bassHeavy(64);
      // Not forgetting anything: the shaders were handed over when Mosaic was built.
      frames(60);

      const sources: string = fakes.webgl.callsTo('shaderSource')
        .map((call: RecordedGlCall): string => call.args[1] as string).join('');
      expect(sources).toContain('discard');
      expect(sources).toContain('texture2D(uLight, vLightUv).r + uGlow');
      expect(sources).toContain('aScale / uMaxScale');

      const sides: number[] = drawnDots().map((dot: DrawnDot): number => dot.side / UNIT_SIDE);
      expect(fakes.webgl.uniformWrites('uMaxScale').at(-1)![0]).toBeCloseTo(Math.max(...sides));
      expect(fakes.webgl.uniformWrites('uCorner').at(-1)).toEqual([0.22]);
    });

    it('turns on the depth test, so bigger dots cover smaller ones whatever the order', (): void => {
      expect(fakes.webgl.callsTo('enable').map((call: RecordedGlCall): unknown => call.args[0]))
        .toContain(gl().DEPTH_TEST);
    });

    it('grows the dots on an enormous screen rather than draw more than forty thousand', (): void => {
      viz.resize(7680, 4320);

      const dots: HTMLCanvasElement = surfaces().dots.canvas;
      expect(dots.width * dots.height).toBeLessThanOrEqual(40_600);
      expect(dots.width).toBeLessThan(Math.ceil(7680 / PITCH));
    });

    it('never draws the scene onto the screen directly', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      const scene: HTMLCanvasElement = surfaces().scene.canvas;
      const direct: RecordedCall[] = surfaces().main.callsTo('drawImage')
        .filter((call: RecordedCall): boolean => call.args[0] === scene);
      expect(direct).toEqual([]);
    });
  });

  // ==========================================================================
  // The graphics card
  // ==========================================================================

  describe('the graphics card', (): void => {
    /** Builds another Mosaic on a fresh canvas. */
    function build(): MosaicVisualization {
      return new MosaicVisualization({canvas: document.createElement('canvas'), analyser: analyser.asNode()});
    }

    it('will not start without WebGL', (): void => {
      fakes.webglAvailable = false;

      expect(build).toThrow('Failed to get WebGL context');
    });

    it('will not start without instanced drawing', (): void => {
      fakes.webgl.instancingAvailable = false;

      expect(build).toThrow('WebGL instanced drawing is not available');
    });

    it('reports a shader that will not compile, or a program that will not link', (): void => {
      fakes.webgl.failCompile = true;
      expect(build).toThrow('Failed to compile shader: fake failure');

      fakes.webgl.failCompile = false;
      fakes.webgl.failLink = true;
      expect(build).toThrow('Failed to link WebGL program: fake failure');
    });

    it('reports a context that will not make a program, a shader, a buffer or a texture', (): void => {
      fakes.webgl.refuseProgram = true;
      expect(build).toThrow('Failed to create WebGL program');
      fakes.webgl.refuseProgram = false;

      fakes.webgl.refuseShader = true;
      expect(build).toThrow('Failed to create WebGL shader');
      fakes.webgl.refuseShader = false;

      fakes.webgl.refuseTexture = true;
      expect(build).toThrow('Failed to create WebGL texture');
    });

    it('hands over the ramp only when it changes', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();
      forgetAll();

      frames(3);

      const rampUploads: RecordedGlCall[] = fakes.webgl.callsTo('texImage2D')
        .filter((call: RecordedGlCall): boolean => call.args.length === 9);
      expect(rampUploads.length).toBeLessThan(3);
    });

    it('lets go of the context when destroyed', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.destroy();

      expect(fakes.webgl.contextLosses).toBe(1);
    });
  });

  // ==========================================================================
  // Waveform
  // ==========================================================================

  describe('waveform', (): void => {
    it('draws only the left half, from the left edge to the centre', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      const scene: RecordingContext2D = surfaces().scene;
      for (const start of scene.callsTo('moveTo')) expect(start.args[0]).toBe(0);
      for (const end of scene.callsTo('lineTo')) expect(end.args[0]).toBe(WIDTH / 2);
    });

    it('rests flat along the middle in silence', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      const scene: RecordingContext2D = surfaces().scene;
      for (const call of [...scene.callsTo('moveTo'), ...scene.callsTo('lineTo')]) {
        expect(call.args[1]).toBe(HEIGHT / 2);
      }
    });

    it('swings by the waveform\'s amplitude', (): void => {
      analyser.waveform = flat(255);
      viz.resize(WIDTH, HEIGHT);
      frame();

      const lift: number = (127 / 128) * HEIGHT * 0.45;
      expect(surfaces().scene.callsTo('moveTo')[0].args[1]).toBeCloseTo(HEIGHT / 2 + lift);
    });

    it('strokes a glow, a body and a white core, widest first', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      const strokes: RecordedCall[] = surfaces().scene.callsTo('stroke');
      const widths: number[] = strokes.map((call: RecordedCall): number => call.state.lineWidth);
      expect(widths).toHaveLength(3);
      expect(widths[0]).toBeGreaterThan(widths[1]);
      expect(widths[1]).toBeGreaterThan(widths[2]);
      // The scene only carries light; the dots give it its colour.
      expect(strokes.map((call: RecordedCall): unknown => call.state.strokeStyle))
        .toEqual(['rgba(255, 255, 255, 0.35)', 'rgba(255, 255, 255, 0.75)', 'rgb(255, 255, 255)']);
    });
  });

  // ==========================================================================
  // Trail
  // ==========================================================================

  describe('trail', (): void => {
    /** Width of the half-width trail at the fixture size. */
    const HALF: number = WIDTH / 2;

    /** The strips the scene was redrawn from its scratch copy in. */
    function strips(): RecordedCall[] {
      const scratch: HTMLCanvasElement = surfaces().scratch.canvas;
      return surfaces().scene.callsTo('drawImage')
        .filter((call: RecordedCall): boolean => call.args[0] === scratch);
    }

    /**
     * How far a strip was lifted in a frame: its vertical move, less its even
     * spread and the ripple, which follows a known phase (0.06 per frame, 0.55
     * between strips, 0.4% of the height at the outer edge). Negative is up.
     */
    function lift(strip: RecordedCall, index: number, frameNumber: number): number {
      const columnWidth: number = HALF / BLEED_COLUMNS;
      const reach: number = (HALF - (index + 0.5) * columnWidth) / HALF;
      const ripple: number = Math.sin(0.06 * frameNumber + index * 0.55) * HEIGHT * 0.004 * reach;
      return (strip.args[6] as number) + ((strip.args[8] as number) - HEIGHT) / 2 - ripple;
    }

    it('redraws the scene from a copy, faded and blurred, in strips', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      expect(strips()).toHaveLength(BLEED_COLUMNS);
      for (const strip of strips()) {
        expect(strip.state.globalAlpha).toBeCloseTo(0.965);
        expect(strip.state.filter).toBe('blur(1px)');
      }
    });

    it('pushes the trail out toward the edge, keeping it against the centre', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      const first: RecordedCall = strips()[0];
      const last: RecordedCall = strips().at(-1)!;
      expect(first.args[5] as number).toBeLessThan(first.args[1] as number);
      expect((last.args[5] as number) + (last.args[7] as number)).toBeCloseTo(HALF);
    });

    it('lifts the whole trail straight up, by the same amount along its length', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      const lifts: number[] = strips().map((strip: RecordedCall, index: number): number => lift(strip, index, 1));
      for (const value of lifts) expect(value).toBeCloseTo(-HEIGHT * 0.004);
    });

    it('sinks it instead after a bass hit, so the sides swap', (): void => {
      viz.resize(WIDTH, HEIGHT);
      passGracePeriod();
      analyser.spectrum = bassHeavy(64);
      fakes.forget();

      frame();

      expect(lift(strips()[0], 0, 2)).toBeCloseTo(HEIGHT * 0.004);
    });

    it('spreads the outer edge more than the centre', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      const edge: number = strips()[0].args[8] as number;
      const centre: number = strips().at(-1)!.args[8] as number;
      expect(edge).toBeGreaterThan(centre);
      expect(centre).toBeGreaterThanOrEqual(HEIGHT);
    });
  });

  // ==========================================================================
  // Afterglow
  // ==========================================================================

  describe('afterglow', (): void => {
    it('leaves unlit dots dark in silence', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      expect(brightnessOf(rampColour(0))).toBeLessThan(40);
      expect(glow()).toBe(0);
    });

    it('shows a fully lit dot as near-white', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      for (const channel of hotColour()) expect(channel).toBeGreaterThan(200);
    });

    it('cools steadily from near-white to dark as the light fades', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      for (let step: number = 1; step < 256; step++) {
        expect(brightnessOf(rampColour(step))).toBeGreaterThanOrEqual(brightnessOf(rampColour(step - 1)));
      }
    });

    it('passes through a deeper, shifted shade before going out', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      // 0.3 is the deep shade, 0.65 the main colour.
      const deep: number[] = rampColour(Math.round(0.3 * 255));
      const main: number[] = rampColour(Math.round(0.65 * 255));
      expect(brightnessOf(deep)).toBeLessThan(brightnessOf(main));
      // At the starting blue, the deep shade leans toward violet: more red, relative to its brightness.
      expect(deep[0] / brightnessOf(deep)).toBeGreaterThan(main[0] / brightnessOf(main));
    });
  });

  // ==========================================================================
  // Bass glow
  // ==========================================================================

  describe('bass glow', (): void => {
    it('lifts every dot while the bass is heavy', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();
      expect(glow()).toBe(0);

      analyser.spectrum = bassHeavy(64);
      frames(70);

      expect(glow()).toBeCloseTo(0.3, 2);
    });

    it('rises quickly and dies away slowly', (): void => {
      viz.resize(WIDTH, HEIGHT);
      analyser.spectrum = bassHeavy(64);
      frames(70);
      const full: number = glow();

      analyser.spectrum = flat(0);
      frames(10);

      expect(glow()).toBeLessThan(full);
      expect(glow()).toBeGreaterThan(0.05);
    });
  });

  // ==========================================================================
  // Bass ripples
  // ==========================================================================

  describe('waves', (): void => {
    /**
     * How far a wave travels each frame, in dots, with Math.random held at 0.9:
     * the usual speed reaches the corners in 240 frames, and 0.9 picks 1.4 times it.
     */
    const SPEED: number = (MAX_DISTANCE / 240) * 1.4;

    /** Hands Math.random the queued values in turn, then 0.5 once they run out. */
    function queueRandom(): number[] {
      const queue: number[] = [];
      vi.spyOn(Math, 'random').mockImplementation((): number => queue.shift() ?? 0.5);
      return queue;
    }

    /** The size of each drawn dot, smallest to biggest. */
    function sides(): number[] {
      return drawnDots().map((dot: DrawnDot): number => dot.side).sort((a: number, b: number): number => a - b);
    }

    /** The side of the dot nearest the centre this frame, or 0 when it is too small to draw. */
    function centreSide(): number {
      const near: DrawnDot | undefined = drawnDots().find((dot: DrawnDot): boolean => dot.distance < 1);
      return near ? near.side : 0;
    }

    it('roll across the whole grid in silence, so it is never left flat', (): void => {
      viz.resize(WIDTH, HEIGHT);

      for (let i: number = 0; i < 300; i++) {
        forgetAll();
        frame();
        const all: number[] = sides();
        // Gentle in silence, but never uniform.
        expect(all.at(-1)! - all[0]).toBeGreaterThan(UNIT_SIDE * 0.1);
      }
    });

    it('start out already filling the screen', (): void => {
      viz.resize(WIDTH, HEIGHT);
      fakes.forget();

      frame();

      // All but the middle, where the first wave is only just easing in.
      expect(drawnDots().length).toBeGreaterThan(COLUMNS * ROWS * 0.6);
      expect(Math.max(...drawnDots().map((dot: DrawnDot): number => dot.distance))).toBeGreaterThan(MAX_DISTANCE - 1);
    });

    it('keep every dot overlapping its neighbours in silence, swelling only gently', (): void => {
      viz.resize(WIDTH, HEIGHT);

      framesThenRecord(200);

      expect(drawnDots()).toHaveLength(COLUMNS * ROWS);
      for (const side of sides()) {
        expect(side).toBeGreaterThan(PITCH);
        expect(side).toBeLessThan(REST_SIDE + UNIT_SIDE);
      }
    });

    it('never shrink a dot below its rest size, so no black shows, whatever the waves do', (): void => {
      viz.resize(WIDTH, HEIGHT);
      for (let i: number = 0; i < 40; i++) {
        analyser.spectrum = i % 4 === 0 ? bassHeavy(64) : flat(0);
        frames(10);
      }
      fakes.forget();
      frame();

      for (const side of sides()) expect(side).toBeGreaterThanOrEqual(REST_SIDE - 1e-9);
    });

    /** Plays a kick for two frames out of every `period`, for `count` frames. */
    function kicks(count: number, period: number): void {
      for (let i: number = 0; i < count; i++) {
        analyser.spectrum = i % period < 2 ? bassHeavy(64) : flat(0);
        frame();
      }
    }

    it('swell the dots past their cells, over their neighbours, with heavy kicks', (): void => {
      viz.resize(WIDTH, HEIGHT);
      kicks(199, 40);
      fakes.forget();
      frame();

      expect(crest().side).toBeGreaterThan(PITCH * 1.5);
      // Most dots overlap their cells; only each new wave, still easing in at the centre, starts small.
      const all: number[] = sides();
      expect(all[Math.floor(all.length / 2)]).toBeGreaterThan(UNIT_SIDE);
    });

    it('start a wave at once on a kick, sized by it, and keep that size as it travels', (): void => {
      viz.resize(WIDTH, HEIGHT);
      framesThenRecord(200);
      const silent: number = crest().side;

      // Long enough after the last quiet wave (one every 117 frames) for a kick to start one.
      frames(93);
      analyser.spectrum = bassHeavy(64);
      frames(3);
      analyser.spectrum = flat(0);

      framesThenRecord(30);
      const early: DrawnDot = crest();
      framesThenRecord(20);
      const later: DrawnDot = crest();

      expect(swellOf(early.side)).toBeGreaterThan(swellOf(silent) * 2);
      expect(swellOf(later.side)).toBeGreaterThan(swellOf(silent) * 2);
      // It left with the kick and rolls outward.
      // Within a dot: the biggest dot is the one sitting nearest the crest.
      expect(Math.abs(early.distance - 33 * SPEED)).toBeLessThan(1);
      expect(later.distance).toBeGreaterThan(early.distance);
    });

    it('hear a kick that climbs only a little each frame, as smoothed music does', (): void => {
      const random: ReturnType<typeof vi.spyOn> = vi.spyOn(Math, 'random').mockReturnValue(0.9);
      viz.resize(WIDTH, HEIGHT);
      // A steady 0.4 bed long enough for its average to settle and the last quiet wave (at 59
      // frames) to clear six dots, but not so long that the next one is due.
      analyser.spectrum = (index: number): number => (index < 64 ? 102 : 0);
      frames(95);
      const before: number = random.mock.calls.length;

      // Then a kick that climbs 0.02 a frame for five frames.
      for (let step: number = 1; step <= 5; step++) {
        const level: number = 102 + step * 5;
        analyser.spectrum = (index: number): number => (index < 64 ? level : 0);
        frame();
      }

      expect(random.mock.calls.length - before).toBe(2);
    });

    it('ignore a steady or falling kick, however loud', (): void => {
      const random: ReturnType<typeof vi.spyOn> = vi.spyOn(Math, 'random').mockReturnValue(0.9);

      /** Waves started over 80 frames, after a loud start, while `spectrum` plays. */
      function wavesWhile(spectrum: (frameIndex: number) => (index: number) => number): number {
        viz.resize(WIDTH, HEIGHT);
        analyser.spectrum = bassHeavy(64);
        frame();
        const before: number = random.mock.calls.length;
        for (let i: number = 0; i < 80; i++) {
          analyser.spectrum = spectrum(i);
          frame();
        }
        return (random.mock.calls.length - before) / 2;
      }

      const steady: number = wavesWhile((): ((index: number) => number) => bassHeavy(64));
      const falling: number = wavesWhile((i: number): ((index: number) => number) =>
        (index: number): number => (index < 64 ? 255 - i : 0));
      const silent: number = wavesWhile((): ((index: number) => number) => flat(0));

      // Only the quiet waves that follow anyway.
      expect(steady).toBe(silent);
      expect(falling).toBe(silent);
    });

    it('ignore a climb in a quiet passage', (): void => {
      const random: ReturnType<typeof vi.spyOn> = vi.spyOn(Math, 'random').mockReturnValue(0.9);
      viz.resize(WIDTH, HEIGHT);
      frames(40);
      const before: number = random.mock.calls.length;

      // Up to 0.2: a clear climb, but under the loudness floor.
      analyser.spectrum = (index: number): number => (index < 64 ? 51 : 0);
      frames(3);

      expect(random.mock.calls.length - before).toBe(0);
    });

    it('bunch up with fast kicks, but never closer than three dots apart', (): void => {
      // Kicks every 10 frames come about every 2.3 dots; only one in three may start a wave.
      const random: ReturnType<typeof vi.spyOn> = vi.spyOn(Math, 'random').mockReturnValue(0.9);
      viz.resize(WIDTH, HEIGHT);
      const seeded: number = random.mock.calls.length;

      kicks(400, 10);

      // Each wave picks a speed and the gap the next quiet one waits for: two picks. At most one
      // wave every six dots of travel, and more than the one every 13.6 dots silence would bring.
      const started: number = (random.mock.calls.length - seeded) / 2;
      expect(started).toBeLessThanOrEqual(Math.ceil((400 * SPEED) / 6));
      expect(started).toBeGreaterThan(Math.floor((400 * SPEED) / 13.6));
    });

    it('follow each other at uneven gaps in silence', (): void => {
      // Picks alternate: a speed (held at the usual one), then a gap.
      let gap: number = 0;
      let picks: number = 0;
      vi.spyOn(Math, 'random').mockImplementation((): number => (picks++ % 2 === 0 ? 0.5 : gap));
      /** Draws `count` frames, discarding the recording as it goes; only the picks are counted. */
      function quietFrames(count: number): void {
        for (let i: number = 0; i < count; i++) {
          frame();
          forgetAll();
        }
      }

      viz.resize(WIDTH, HEIGHT);
      let seeded: number = picks;
      quietFrames(300);
      const shortGaps: number = picks - seeded;

      gap = 1;
      picks = 0;
      viz.resize(WIDTH + 36, HEIGHT);
      seeded = picks;
      quietFrames(300);
      const longGaps: number = picks - seeded;

      // Six dots apart at one end of the range, nine at the other.
      expect(shortGaps).toBeGreaterThan(longGaps);
    });

    it('swell the dots hugely down the middle, tapering away toward the left and right', (): void => {
      viz.resize(WIDTH, HEIGHT);
      kicks(199, 40);
      fakes.forget();
      frame();

      /** The biggest swell among the dots whose middles fall within a band of x. */
      function biggestSwell(inBand: (x: number) => boolean): number {
        return Math.max(...drawnDots().filter((dot: DrawnDot): boolean => inBand(dot.x))
          .map((dot: DrawnDot): number => swellOf(dot.side)));
      }

      const middle: number = biggestSwell((x: number): boolean => Math.abs(x - WIDTH / 2) < PITCH);
      const halfway: number = biggestSwell((x: number): boolean => Math.abs(Math.abs(x - WIDTH / 2) - WIDTH / 4) < PITCH);
      const edges: number = biggestSwell((x: number): boolean => Math.abs(x - WIDTH / 2) > WIDTH / 2 - PITCH);

      expect(middle).toBeGreaterThan(halfway * 1.5);
      expect(halfway).toBeGreaterThan(edges * 1.5);
      expect(edges).toBeGreaterThan(0);
    });

    it('travel at speeds of their own, so a fast one catches and passes a slow one', (): void => {
      const queue: number[] = queueRandom();
      viz.resize(WIDTH, HEIGHT);
      // Long enough for the first quiet wave to clear six dots, so a kick may start one.
      frames(79);

      // A slow kick wave: half the usual speed, and the longest quiet gap after it.
      queue.push(0, 1);
      analyser.spectrum = bassHeavy(64);
      frames(2);
      analyser.spectrum = flat(0);
      frames(148);

      // A fast one, 150 frames later: one and a half times the usual speed.
      queue.push(1, 0.5);
      analyser.spectrum = bassHeavy(64);
      frames(2);
      analyser.spectrum = flat(0);
      framesThenRecord(3);
      const apart: number = crest().side;

      // The slow one left 6.2 dots ahead and the fast one gains 0.083 dots a frame on it: they
      // meet after 75, about nine dots out.
      framesThenRecord(70);
      const crossing: DrawnDot = crest();

      expect(swellOf(crossing.side)).toBeGreaterThan(swellOf(apart) * 1.5);
      expect(Math.abs(crossing.distance - 9.3)).toBeLessThan(1);
    });

    it('bend the picture like lenses, pulling each dot\'s light toward the nearest crest', (): void => {
      viz.resize(WIDTH, HEIGHT);
      framesThenRecord(200);
      const silentPull: number = Math.max(...drawnDots().map((dot: DrawnDot): number => Math.abs(dot.pull)));

      // A single strong wave, well clear of the quiet ones.
      frames(93);
      analyser.spectrum = bassHeavy(64);
      frames(3);
      analyser.spectrum = flat(0);
      // About five dots out: the middle column only runs ten dots from the centre.
      framesThenRecord(43);

      const dots: DrawnDot[] = drawnDots();
      const crestDistance: number = crest().distance;
      // Down the middle column, where the lenses are strongest.
      const middle: DrawnDot[] = dots.filter((dot: DrawnDot): boolean => Math.abs(dot.x - WIDTH / 2) < PITCH);
      const inside: DrawnDot[] = middle.filter((dot: DrawnDot): boolean =>
        dot.distance > crestDistance - 4 && dot.distance < crestDistance - 1);
      const outside: DrawnDot[] = middle.filter((dot: DrawnDot): boolean =>
        dot.distance > crestDistance + 1 && dot.distance < crestDistance + 4);

      expect(inside.length).toBeGreaterThan(0);
      expect(outside.length).toBeGreaterThan(0);
      for (const dot of inside) expect(dot.pull).toBeGreaterThan(0);
      for (const dot of outside) expect(dot.pull).toBeLessThan(0);
      // A strong kick's lens moves the light several dots, far more than a quiet wave's.
      const strongest: number = Math.max(...dots.map((dot: DrawnDot): number => Math.abs(dot.pull)));
      expect(strongest).toBeGreaterThan(2);
      expect(strongest).toBeGreaterThan(silentPull * 2);
      for (const dot of dots) expect(Math.abs(dot.sideways)).toBeLessThan(1e-4);
    });

    it('bend the picture most down the middle, least at the left and right', (): void => {
      viz.resize(WIDTH, HEIGHT);
      kicks(199, 40);
      forgetAll();
      frame();

      /** The strongest pull among the dots whose middles fall within a band of x. */
      function strongestPull(inBand: (x: number) => boolean): number {
        return Math.max(...drawnDots().filter((dot: DrawnDot): boolean => inBand(dot.x))
          .map((dot: DrawnDot): number => Math.abs(dot.pull)));
      }

      const middle: number = strongestPull((x: number): boolean => Math.abs(x - WIDTH / 2) < PITCH);
      const edges: number = strongestPull((x: number): boolean => Math.abs(x - WIDTH / 2) > WIDTH / 2 - PITCH);
      expect(middle).toBeGreaterThan(edges * 3);
    });

    it('read the light smoothly, so a lens can pull it from between two dots', (): void => {
      const filters: unknown[] = fakes.webgl.callsTo('texParameteri')
        .filter((call: RecordedGlCall): boolean => call.args[1] === gl().TEXTURE_MAG_FILTER)
        .map((call: RecordedGlCall): unknown => call.args[2]);
      // The light texture is made first, then the ramp, which is read step by step.
      expect(filters).toEqual([gl().LINEAR, gl().NEAREST]);
    });

    it('ease in as they leave the centre, so nothing pops', (): void => {
      viz.resize(WIDTH, HEIGHT);
      analyser.spectrum = bassHeavy(64);
      fakes.forget();
      frame();
      let last: number = centreSide();

      for (let i: number = 0; i < 200; i++) {
        forgetAll();
        frame();
        const side: number = centreSide();
        expect(Math.abs(side - last)).toBeLessThan(PITCH * 0.15);
        last = side;
      }
    });

    it('keep drawing sensibly however long they run, and whatever the bass does', (): void => {
      viz.resize(WIDTH, HEIGHT);
      for (let i: number = 0; i < 60; i++) {
        analyser.spectrum = i % 2 === 0 ? bassHeavy(64) : flat(0);
        frames(10);
        expect(fakes.unusableCalls()).toEqual([]);
        for (const dot of drawnDots()) expect(Number.isFinite(dot.side)).toBe(true);
        forgetAll();
      }
      frame();

      expect(drawnDots().length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Hue jumps
  // ==========================================================================

  describe('hue jumps', (): void => {
    it('do not happen during the grace period', (): void => {
      viz.resize(WIDTH, HEIGHT);
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      analyser.spectrum = bassHeavy(64);

      expect(snaps(coloursOver(10))).toBe(0);
    });

    it('snap the whole screen to the new colour on some hits', (): void => {
      viz.resize(WIDTH, HEIGHT);
      passGracePeriod();
      const before: number[] = hotColour();
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      analyser.spectrum = bassHeavy(64);

      const colours: number[][] = coloursOver(10);

      expect(difference(colours[0], before)).toBeGreaterThan(40);
      expect(snaps(colours)).toBe(0);
    });

    it('sweep the new colour in quickly on the others', (): void => {
      viz.resize(WIDTH, HEIGHT);
      passGracePeriod();
      const before: number[] = hotColour();
      analyser.spectrum = bassHeavy(64);

      const colours: number[][] = coloursOver(25);

      // No single big step, but a big change overall, settled by the end.
      expect(difference(colours[0], before)).toBeLessThan(40);
      expect(snaps(colours)).toBe(0);
      expect(difference(colours.at(-1)!, before)).toBeGreaterThan(40);
      expect(difference(colours.at(-1)!, colours.at(-2)!)).toBeLessThanOrEqual(2);
    });

    it('wait out the cooldown between hits', (): void => {
      viz.resize(WIDTH, HEIGHT);
      passGracePeriod();
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      analyser.spectrum = bassHeavy(64);

      frame();
      const first: number[] = hotColour();
      frames(10, 100);
      expect(difference(hotColour(), first)).toBeLessThan(40);

      now += COOLDOWN_MS;
      frame();
      expect(difference(hotColour(), first)).toBeGreaterThan(40);
    });

    it('ignore a quiet bass', (): void => {
      viz.resize(WIDTH, HEIGHT);
      passGracePeriod();
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      analyser.spectrum = flat(100);

      expect(snaps(coloursOver(5))).toBe(0);
    });
  });

  // ==========================================================================
  // Colour drift
  // ==========================================================================

  describe('colour drift', (): void => {
    it('drifts the hue slowly without a trigger', (): void => {
      viz.resize(WIDTH, HEIGHT);

      const colours: number[][] = coloursOver(600);

      expect(snaps(colours)).toBe(0);
      expect(difference(colours[0], colours.at(-1)!)).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Fade, FFT size and teardown
  // ==========================================================================

  describe('fade-out', (): void => {
    it('fades the frame out once playback stops', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.setPlaying(false);
      frame(1000);

      const fade: RecordedCall | undefined = surfaces().main.callsTo('fillRect')
        .find((call: RecordedCall): boolean => call.state.globalCompositeOperation === 'destination-out');
      expect(fade).toBeDefined();
    });

    it('adds no fade while playing', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.setPlaying(true);
      frame(1000);

      const fades: RecordedCall[] = surfaces().main.callsTo('fillRect')
        .filter((call: RecordedCall): boolean => call.state.globalCompositeOperation === 'destination-out');
      expect(fades).toEqual([]);
    });
  });

  describe('FFT size', (): void => {
    it('reads into buffers of the new size', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.setFftSize(512);
      frame();

      expect(analyser.waveformReads.at(-1)).toBe(512);
      expect(analyser.spectrumReads.at(-1)).toBe(256);
    });
  });

  describe('destroy', (): void => {
    it('draws nothing afterwards', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.destroy();
      fakes.forget();

      frame();

      expect(surfaces().main.calls).toEqual([]);
    });
  });

  // ==========================================================================
  // Edge inputs
  // ==========================================================================

  describe('edge inputs', (): void => {
    it.each([
      [1, 1],
      [7, 3],
      [WIDTH, HEIGHT],
      [3840, 2160],
    ])('hands the canvas only finite numbers at %ix%i', (width: number, height: number): void => {
      analyser.waveform = flat(0);
      analyser.spectrum = bassHeavy(64);
      viz.resize(width, height);
      passGracePeriod();
      frames(3);

      expect(fakes.unusableCalls()).toEqual([]);
      expect(fakes.unusableSets()).toEqual([]);
      const glNumbers: unknown[] = fakes.webgl.calls.flatMap((call: RecordedGlCall): unknown[] => [...call.args]);
      for (const value of glNumbers) {
        if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
        if (value instanceof Float32Array) expect(value.every(Number.isFinite)).toBe(true);
      }
    });

    it('draws nothing at a zero size', (): void => {
      viz.resize(0, 0);
      fakes.forget();

      frame();

      expect(surfaces().main.calls).toEqual([]);
    });
  });
});

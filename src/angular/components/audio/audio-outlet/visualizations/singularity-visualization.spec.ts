/**
 * @fileoverview Unit tests for the Singularity visualization.
 *
 * Tests cover:
 * - Layout: surface creation, the scene pixel budget, and the cell the waves
 *   are measured in
 * - The screen: the half-width scene handed to the graphics card, which turns,
 *   bends and colours every pixel in a single pass, with only what changes
 *   refreshed each frame
 * - The graphics card: setup, and refusing to run without WebGL
 * - Waveform: only the left half drawn; rest position and amplitude
 * - Trail: per-frame blur, the outward bleed, and no rise or sink
 * - Mirroring: the right half is the left flipped through the centre, blended
 *   with its mirror image at the centre line
 * - Afterglow: the colour ramp handed to the graphics card, from unlit, through
 *   the deep shade and main colour, to near-white
 * - Bass glow, and the overlapping waves that bend the picture, each sized by
 *   the kick as it left the centre
 * - Hue jumps: grace period, cooldown, snapping and sweeping
 * - Fade-out, FFT size changes, destroy
 * - Edge inputs never hand the canvas a NaN or an infinity
 *
 * Canvas 2D, WebGL and Web Audio are faked; see visualization-test-fakes.group1.
 * The waves are read from the crest radii and strengths handed to the graphics
 * card each frame, summed as the screen program sums them.
 *
 * @module app/components/audio/audio-outlet/visualizations/singularity-visualization.spec
 */

import {SingularityVisualization} from './singularity-visualization';
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

/** Size of the cell the waves are measured in, in canvas pixels. */
const CELL: number = 8;

/** Half-width of a wave, in cells. */
const RING_WIDTH: number = 6;

/** Cells a lens moves the light per unit of the swell's slope, and its strength down the middle. */
const LENS_STRENGTH: number = 60;
const CENTRE_MAGNIFY: number = 0.8;

/** Distance between the points the swell is sampled at, in cells. */
const SAMPLE_STEP: number = 0.01;

/** Distance from the centre to a corner at the fixture size, in cells. */
const MAX_DISTANCE: number = Math.hypot(WIDTH / 2, HEIGHT / 2) / CELL;

/** Strips the trail is redrawn in each frame. */
const BLEED_COLUMNS: number = 32;

/** Where the simulated clock starts, in milliseconds. */
const START_MS: number = 100_000;

/** Gap the bass trigger enforces between hits, in milliseconds. */
const COOLDOWN_MS: number = 8000;

/** The surfaces Singularity creates, in the order it creates them. */
interface Surfaces {
  readonly main: RecordingContext2D;
  readonly scene: RecordingContext2D;
  readonly scratch: RecordingContext2D;
}

describe('SingularityVisualization', (): void => {
  let fakes: CanvasFakes;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let viz: SingularityVisualization;
  let now: number;

  /** The recording contexts, named for the surface each belongs to. */
  function surfaces(): Surfaces {
    const [main, scene, scratch]: RecordingContext2D[] = fakes.contexts;
    return {main, scene, scratch};
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

  /** The WebGL fake, typed as the context it stands in for, for its constants. */
  function gl(): WebGLRenderingContext {
    return fakes.webgl as unknown as WebGLRenderingContext;
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

  /** The last value a uniform was set to. */
  function uniform(name: string): number {
    return fakes.webgl.uniformWrites(name).at(-1)![0] as number;
  }

  /** Each wave's crest radius (cells) and strength, in pairs, as last handed to the graphics card. */
  function rings(): Float32Array {
    return fakes.webgl.uniformWrites('uRings').at(-1)![0] as Float32Array;
  }

  /** The waves' combined swell at a distance from the centre, in cells: a bell curve round each crest. */
  function swellAt(distance: number): number {
    const waves: Float32Array = rings();
    let swell: number = 0;
    for (let r: number = 0; r < waves.length; r += 2) {
      const along: number = (distance - waves[r]) / RING_WIDTH;
      swell += waves[r + 1] * Math.exp(-along * along);
    }
    return swell;
  }

  /** The swell at every distance on screen, centre to corner. */
  function onScreen(): number[] {
    const count: number = Math.floor(MAX_DISTANCE / SAMPLE_STEP) + 1;
    return Array.from({length: count}, (_: unknown, index: number): number => swellAt(index * SAMPLE_STEP));
  }

  /** The biggest swell on screen, and its distance from the centre in cells. */
  function crest(): {swell: number; distance: number} {
    const swells: number[] = onScreen();
    let best: number = 0;
    for (let i: number = 1; i < swells.length; i++) {
      if (swells[i] > swells[best]) best = i;
    }
    return {swell: swells[best], distance: best * SAMPLE_STEP};
  }

  /**
   * How far the lenses pull the light outward at a distance, in cells, down
   * the middle of the screen: the swell's slope times the lens strength and
   * the middle's magnification, as the screen program works it out.
   */
  function pullAt(distance: number): number {
    const slope: number = (swellAt(distance + SAMPLE_STEP) - swellAt(distance - SAMPLE_STEP)) / (2 * SAMPLE_STEP);
    return slope * LENS_STRENGTH * CENTRE_MAGNIFY;
  }

  /** The source of every shader handed to the graphics card. */
  function shaderSources(): string {
    return fakes.webgl.callsTo('shaderSource').map((call: RecordedGlCall): string => call.args[1] as string).join('');
  }

  /** The afterglow ramp handed to the graphics card: RGB for each step of light. */
  function ramp(): Uint8Array {
    const upload: RecordedGlCall = fakes.webgl.callsTo('texImage2D')
      .filter((call: RecordedGlCall): boolean => call.args[8] instanceof Uint8Array).at(-1)!;
    return upload.args[8] as Uint8Array;
  }

  /** One step of the ramp, unlit (0) to fully lit (255). */
  function rampColour(step: number): number[] {
    const bytes: Uint8Array = ramp();
    return [bytes[step * 3], bytes[step * 3 + 1], bytes[step * 3 + 2]];
  }

  /** The colour of a fully lit pixel: the ramp's near-white end, which follows the hue. */
  function hotColour(): number[] {
    return rampColour(255);
  }

  /** The bass glow last handed to the graphics card. */
  function glow(): number {
    return uniform('uGlow');
  }

  /** Sum of the channels of a colour. */
  function brightnessOf(colour: readonly number[]): number {
    return colour[0] + colour[1] + colour[2];
  }

  /** How far apart two colours are, channel by channel. */
  function difference(a: readonly number[], b: readonly number[]): number {
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  }

  /** Draws `count` frames, collecting a fully lit pixel's colour after each. */
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
    viz = new SingularityVisualization({canvas, analyser: analyser.asNode()});
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
    it('is listed as Singularity under Signature', (): void => {
      expect(viz.name).toBe('Singularity');
      expect(viz.category).toBe('Signature');
    });

    it('always renders at the native resolution, so the lenses stay smooth', (): void => {
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
    it('creates its two off-screen surfaces', (): void => {
      viz.resize(WIDTH, HEIGHT);

      expect(fakes.contexts).toHaveLength(3);
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
      const sceneSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(scene, 'width', 'set');

      viz.resize(WIDTH, HEIGHT);

      expect(sceneSpy).not.toHaveBeenCalled();
    });

    it('hands the graphics card the new size and seam width', (): void => {
      viz.resize(WIDTH, HEIGHT);

      expect(fakes.webgl.callsTo('viewport').at(-1)?.args).toEqual([0, 0, WIDTH, HEIGHT]);
      expect(fakes.webgl.uniformWrites('uCanvas').at(-1)).toEqual([WIDTH, HEIGHT]);
      expect(uniform('uSeam')).toBeCloseTo(WIDTH * 0.05);
    });

    it('clears the main canvas', (): void => {
      viz.resize(WIDTH, HEIGHT);

      expect(surfaces().main.callsTo('clearRect').at(-1)?.args).toEqual([0, 0, WIDTH, HEIGHT]);
    });
  });

  // ==========================================================================
  // Cells
  // ==========================================================================

  describe('cells', (): void => {
    it.each([1, 2, 3])('measures the waves in 8-pixel cells at a device pixel ratio of %i', (ratio: number): void => {
      setDevicePixelRatio(ratio);
      viz = new SingularityVisualization({canvas, analyser: analyser.asNode()});

      expect(uniform('uCell')).toBe(CELL);
    });
  });

  // ==========================================================================
  // The screen
  // ==========================================================================

  describe('the screen', (): void => {
    it('reads the left half of the scene as it is, and turns it through the centre for the right', (): void => {
      const sources: string = shaderSources();

      expect(sources).toContain('vec2 left = pixel.x < halfSize.x ? pixel : uCanvas - pixel;');
      expect(sources).toContain('texture2D(uLight, left / halfSize)');
    });

    it('takes the scene\'s light from its opacity, since faint white arrives as full white', (): void => {
      expect(shaderSources()).toContain('texture2D(uLight, left / halfSize).a;');
    });

    it('lights the screen at 0.8 of the scene\'s own light', (): void => {
      expect(uniform('uGain')).toBe(0.8);
      expect(shaderSources()).toContain('light * uGain + uGlow');
    });

    it('hands the half-width scene to the graphics card each frame, never reading it back', (): void => {
      viz.resize(WIDTH, HEIGHT);
      framesThenRecord(2);

      const light: RecordedGlCall[] = fakes.webgl.callsTo('texImage2D')
        .filter((call: RecordedGlCall): boolean => call.args.length === 6);
      expect(light).toHaveLength(1);
      expect(light[0].args[5]).toBe(surfaces().scene.canvas);
      expect(surfaces().scene.callsTo('getImageData')).toEqual([]);
    });

    it('sets up the program, square and textures once, and only refreshes what changes each frame', (): void => {
      viz.resize(WIDTH, HEIGHT);
      framesThenRecord(200);

      for (const method of ['useProgram', 'bufferData', 'vertexAttribPointer', 'bindTexture', 'viewport']) {
        expect(fakes.webgl.callsTo(method)).toEqual([]);
      }
      const names: string[] = fakes.webgl.calls
        .filter((call: RecordedGlCall): boolean => call.method.startsWith('uniform'))
        .map((call: RecordedGlCall): string => (call.args[0] as {name: string}).name);
      expect(names).toEqual(['uRings', 'uGlow']);
    });

    it('draws the whole screen in a single pass, then lays it onto the canvas', (): void => {
      viz.resize(WIDTH, HEIGHT);
      framesThenRecord(200);

      const draws: RecordedGlCall[] = fakes.webgl.callsTo('drawArrays');
      expect(draws).toHaveLength(1);
      expect(draws[0].args).toEqual([gl().TRIANGLE_STRIP, 0, 4]);

      const laid: RecordedCall = surfaces().main.callsTo('drawImage').at(-1)!;
      expect(laid.args.slice(1)).toEqual([0, 0]);
      expect([(laid.args[0] as HTMLCanvasElement).width, (laid.args[0] as HTMLCanvasElement).height])
        .toEqual([WIDTH, HEIGHT]);
    });

    it('covers the screen with one square', (): void => {
      const square: Float32Array = fakes.webgl.callsTo('bufferData')
        .map((call: RecordedGlCall): unknown => call.args[1])
        .find((data: unknown): boolean => data instanceof Float32Array) as Float32Array;

      expect(Array.from(square)).toEqual([-1, -1, 1, -1, -1, 1, 1, 1]);
    });

    it('bends each pixel\'s light along the swell, adds the glow and colours it from the ramp', (): void => {
      const sources: string = shaderSources();

      expect(sources).toContain('outward * slope * uLens * magnify * uCell');
      expect(sources).toContain('light * uGain + uGlow');
      expect(sources).toContain('texture2D(uRamp');
    });

    it('blends each half with its mirror image across the centre line, so no seam shows', (): void => {
      const sources: string = shaderSources();

      expect(sources).toContain('mix(lightAt(source), lightAt(vec2(uCanvas.x - source.x, source.y)), seam)');
      expect(sources).toContain('0.5 * (1.0 - smoothstep(0.0, uSeam, abs(source.x - centre.x)))');
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
    /** Builds another Singularity on a fresh canvas. */
    function build(): SingularityVisualization {
      return new SingularityVisualization({canvas: document.createElement('canvas'), analyser: analyser.asNode()});
    }

    /** The filter each texture is read with, in the order the textures were made. */
    function filters(): unknown[] {
      return fakes.webgl.callsTo('texParameteri')
        .filter((call: RecordedGlCall): boolean => call.args[1] === gl().TEXTURE_MAG_FILTER)
        .map((call: RecordedGlCall): unknown => call.args[2]);
    }

    it('will not start without WebGL', (): void => {
      fakes.webglAvailable = false;

      expect(build).toThrow('Failed to get WebGL context');
    });

    it('reads the ramp step by step and the light smoothly', (): void => {
      // The ramp texture is made first, then the light.
      expect(filters()).toEqual([gl().NEAREST, gl().LINEAR]);
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
        .filter((call: RecordedGlCall): boolean => call.args[8] instanceof Uint8Array);
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

      const lift: number = (127 / 128) * HEIGHT * 0.3;
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
      // The scene only carries light; the ramp gives it its colour.
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

    it('copies the scene out unblurred', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      const copies: RecordedCall[] = surfaces().scratch.callsTo('drawImage');
      expect(copies).toHaveLength(1);
      expect(copies[0].args).toEqual([surfaces().scene.canvas, 0, 0]);
      expect(copies[0].state.filter).toBe('none');
    });

    it('redraws the scene from the copy in strips, each blurred on its own, without fading them', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      expect(strips()).toHaveLength(BLEED_COLUMNS);
      for (const strip of strips()) {
        expect(strip.state.globalAlpha).toBe(1);
        expect(strip.state.filter).toBe('blur(0.95px)');
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

    it('neither lifts nor sinks the trail, so it spreads evenly up and down', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      const lifts: number[] = strips().map((strip: RecordedCall, index: number): number => lift(strip, index, 1));
      for (const value of lifts) expect(value).toBeCloseTo(0);
    });

    it('keeps it level after a bass hit too', (): void => {
      viz.resize(WIDTH, HEIGHT);
      passGracePeriod();
      analyser.spectrum = bassHeavy(64);
      fakes.forget();

      frame();

      expect(lift(strips()[0], 0, 2)).toBeCloseTo(0);
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
    it('leaves unlit pixels black in silence', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      expect(rampColour(0)).toEqual([0, 0, 0]);
      expect(glow()).toBe(0);
    });

    it('shows a fully lit pixel as near-white', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      for (const channel of hotColour()) expect(channel).toBeGreaterThan(200);
    });

    it('cools steadily from near-white to black as the light fades', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      for (let step: number = 1; step < 256; step++) {
        expect(brightnessOf(rampColour(step))).toBeGreaterThanOrEqual(brightnessOf(rampColour(step - 1)));
      }
    });

    it('passes through a deeper, shifted shade before going out', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      // 0.5 is the deep shade, 0.8 the main colour.
      const deep: number[] = rampColour(Math.round(0.5 * 255));
      const main: number[] = rampColour(Math.round(0.8 * 255));
      expect(brightnessOf(deep)).toBeLessThan(brightnessOf(main));
      // At the starting blue, the deep shade leans toward magenta: more red, relative to its brightness.
      expect(deep[0] / brightnessOf(deep)).toBeGreaterThan(main[0] / brightnessOf(main));
    });
  });

  // ==========================================================================
  // Bass glow
  // ==========================================================================

  describe('bass glow', (): void => {
    it('lifts every pixel while the bass is heavy', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();
      expect(glow()).toBe(0);

      analyser.spectrum = bassHeavy(64);
      frames(70);

      expect(glow()).toBeCloseTo(0.5, 2);
    });

    it('rises quickly and dies away slowly', (): void => {
      viz.resize(WIDTH, HEIGHT);
      analyser.spectrum = bassHeavy(64);
      frames(70);
      const full: number = glow();

      analyser.spectrum = flat(0);
      frames(10);

      expect(glow()).toBeLessThan(full);
      expect(glow()).toBeGreaterThan(0.1);
    });
  });

  // ==========================================================================
  // Waves
  // ==========================================================================

  describe('waves', (): void => {
    /**
     * How far a wave travels each frame, in cells, with Math.random held at
     * 0.9: the usual speed reaches the corners in 256 frames, and 0.9 picks
     * 1.4 times it.
     */
    const SPEED: number = (MAX_DISTANCE / 256) * 1.4;

    /**
     * Quiet frames after which a kick may start a wave: with Math.random held
     * at 0.9 a quiet wave follows every 15.4 cells, and by this frame the newest
     * has travelled just past the eight cells a kick waits for.
     */
    const QUIET_FRAMES: number = 225;

    /** Hands Math.random the queued values in turn, then 0.5 once they run out. */
    function queueRandom(): number[] {
      const queue: number[] = [];
      vi.spyOn(Math, 'random').mockImplementation((): number => queue.shift() ?? 0.5);
      return queue;
    }

    /** Plays a kick for two frames out of every `period`, for `count` frames. */
    function kicks(count: number, period: number): void {
      for (let i: number = 0; i < count; i++) {
        analyser.spectrum = i % period < 2 ? bassHeavy(64) : flat(0);
        frame();
      }
    }

    it('roll across the whole screen in silence, so it is never left still', (): void => {
      viz.resize(WIDTH, HEIGHT);

      for (let i: number = 0; i < 300; i++) {
        forgetAll();
        frame();
        const swells: number[] = onScreen();
        // Gentle in silence, but never even.
        expect(Math.max(...swells) - Math.min(...swells)).toBeGreaterThan(0.05);
      }
    });

    it('start out already filling the screen', (): void => {
      viz.resize(WIDTH, HEIGHT);
      fakes.webgl.forget();

      frame();

      const corner: number[] = onScreen().slice(Math.floor((MAX_DISTANCE - 3) / SAMPLE_STEP));
      expect(Math.max(...corner)).toBeGreaterThan(0.05);
    });

    it('stay gentle in silence', (): void => {
      viz.resize(WIDTH, HEIGHT);

      framesThenRecord(200);

      expect(crest().swell).toBeGreaterThan(0.1);
      expect(crest().swell).toBeLessThan(0.5);
    });

    it('start a wave at once on a kick, sized by it, and keep that size as it travels', (): void => {
      viz.resize(WIDTH, HEIGHT);
      // Long enough for the newest quiet wave to have cleared eight cells, so the kick may start one.
      framesThenRecord(QUIET_FRAMES);
      const silent: number = crest().swell;

      analyser.spectrum = bassHeavy(64);
      frames(3);
      analyser.spectrum = flat(0);

      framesThenRecord(50);
      const early: {swell: number; distance: number} = crest();
      framesThenRecord(20);
      const later: {swell: number; distance: number} = crest();

      expect(early.swell).toBeGreaterThan(silent * 2);
      expect(later.swell).toBeGreaterThan(silent * 2);
      // It left with the kick and rolls outward.
      expect(Math.abs(early.distance - 53 * SPEED)).toBeLessThan(1);
      expect(later.distance).toBeGreaterThan(early.distance);
    });

    it('hear a kick that climbs only a little each frame, as smoothed music does', (): void => {
      const random: ReturnType<typeof vi.spyOn> = vi.spyOn(Math, 'random').mockReturnValue(0.9);
      viz.resize(WIDTH, HEIGHT);
      // A steady 0.4 bed long enough for its average to settle and the first wave to clear
      // eight cells, but not so long that the next quiet one is due.
      analyser.spectrum = (index: number): number => (index < 64 ? 102 : 0);
      frames(95);
      const before: number = random.mock.calls.length;

      // Then a kick that climbs 0.02 a frame for five frames.
      for (let step: number = 1; step <= 5; step++) {
        const level: number = 102 + step * 5;
        analyser.spectrum = (index: number): number => (index < 64 ? level : 0);
        frame();
      }

      // One wave: a speed and the gap the next quiet one waits for.
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
      // Long enough for the first wave to clear eight cells, so a kick could start one.
      frames(70);
      const before: number = random.mock.calls.length;

      // Up to 0.2: a clear climb, but under the loudness floor.
      analyser.spectrum = (index: number): number => (index < 64 ? 51 : 0);
      frames(3);

      expect(random.mock.calls.length - before).toBe(0);
    });

    it('bunch up with fast kicks, but never closer than eight cells apart', (): void => {
      // Kicks every 10 frames come about every 1.3 cells; only one in six may start a wave.
      const random: ReturnType<typeof vi.spyOn> = vi.spyOn(Math, 'random').mockReturnValue(0.9);
      viz.resize(WIDTH, HEIGHT);
      const seeded: number = random.mock.calls.length;

      kicks(400, 10);

      // Each wave picks a speed and the gap the next quiet one waits for: two picks. At most one
      // wave every eight cells of travel, and more than the one every 15.4 cells silence would bring.
      const started: number = (random.mock.calls.length - seeded) / 2;
      expect(started).toBeLessThanOrEqual(Math.ceil((400 * SPEED) / 8));
      expect(started).toBeGreaterThan(Math.floor((400 * SPEED) / 15.4));
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
      viz.resize(WIDTH + 32, HEIGHT);
      seeded = picks;
      quietFrames(300);
      const longGaps: number = picks - seeded;

      // Ten cells apart at one end of the range, sixteen at the other.
      expect(shortGaps).toBeGreaterThan(longGaps);
    });

    it('travel at speeds of their own, so a fast one catches and passes a slow one', (): void => {
      const queue: number[] = queueRandom();
      viz.resize(WIDTH, HEIGHT);
      /** The usual speed, in cells a frame. */
      const usual: number = MAX_DISTANCE / 256;
      // Long enough for the first quiet wave to clear eight cells, so a kick may start one.
      frames(Math.ceil(8 / usual) + 1);

      // A slow kick wave: half the usual speed, and the longest quiet gap after it.
      queue.push(0, 1);
      analyser.spectrum = bassHeavy(64);
      frames(2);
      analyser.spectrum = flat(0);
      // Until it too has cleared eight cells.
      frames(Math.ceil(8 / (usual * 0.5)) + 5);

      // A fast one: one and a half times the usual speed.
      queue.push(1, 0.5);
      analyser.spectrum = bassHeavy(64);
      frames(2);
      analyser.spectrum = flat(0);
      const ahead: number = crest().distance;
      framesThenRecord(3);
      const apart: number = crest().swell;

      // The fast one gains the usual speed on the slow one each frame, so they meet when it has
      // closed the gap, half again further out.
      const meet: number = Math.round(ahead / usual);
      framesThenRecord(meet - 5);
      const crossing: {swell: number; distance: number} = crest();

      expect(crossing.swell).toBeGreaterThan(apart * 1.5);
      expect(Math.abs(crossing.distance - ahead * 1.5)).toBeLessThan(1);
    });

    it('bend the picture like lenses, pulling the light toward the nearest crest', (): void => {
      viz.resize(WIDTH, HEIGHT);
      framesThenRecord(QUIET_FRAMES);
      const silentPull: number = Math.max(...onScreen().map((_: number, index: number): number =>
        Math.abs(pullAt(index * SAMPLE_STEP))));

      // A single strong wave, about seven cells out: the middle column runs eleven from the centre.
      analyser.spectrum = bassHeavy(64);
      frames(3);
      analyser.spectrum = flat(0);
      framesThenRecord(50);

      const crestDistance: number = crest().distance;
      for (const distance of [crestDistance - 3, crestDistance - 2, crestDistance - 1]) {
        expect(pullAt(distance)).toBeGreaterThan(0);
      }
      for (const distance of [crestDistance + 1, crestDistance + 2, crestDistance + 3]) {
        expect(pullAt(distance)).toBeLessThan(0);
      }
      // A strong kick's lens moves the light several cells, far more than a quiet wave's.
      const strongest: number = Math.max(...onScreen().map((_: number, index: number): number =>
        Math.abs(pullAt(index * SAMPLE_STEP))));
      expect(strongest).toBeGreaterThan(2);
      expect(strongest).toBeGreaterThan(silentPull * 2);
    });

    it('bend the picture most down the middle, least at the left and right', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      expect(uniform('uCentreMagnify')).toBe(0.8);
      expect(uniform('uEdgeMagnify')).toBe(0.2);
      expect(shaderSources()).toContain('(uCentreMagnify - uEdgeMagnify) * across * across');
    });

    it('ease in as they leave the centre, so nothing pops', (): void => {
      viz.resize(WIDTH, HEIGHT);
      analyser.spectrum = bassHeavy(64);
      frame();
      let last: number = swellAt(0.5);

      for (let i: number = 0; i < 200; i++) {
        forgetAll();
        frame();
        const swell: number = swellAt(0.5);
        expect(Math.abs(swell - last)).toBeLessThan(0.05);
        last = swell;
      }
    });

    it('hand the graphics card every slot, a free one with no strength', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      const waves: Float32Array = rings();
      expect(waves).toHaveLength(16);
      for (let r: number = 0; r < waves.length; r += 2) {
        if (waves[r] < 0) expect(waves[r + 1]).toBe(0);
      }
      expect(uniform('uRingWidth')).toBe(RING_WIDTH);
      expect(uniform('uLens')).toBe(60);
    });

    it('keep drawing sensibly however long they run, and whatever the bass does', (): void => {
      viz.resize(WIDTH, HEIGHT);
      for (let i: number = 0; i < 60; i++) {
        analyser.spectrum = i % 2 === 0 ? bassHeavy(64) : flat(0);
        frames(10);
        expect(fakes.unusableCalls()).toEqual([]);
        expect(rings().every(Number.isFinite)).toBe(true);
        forgetAll();
      }
      frame();

      expect(crest().swell).toBeGreaterThan(0);
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
      expect(difference(colours.at(-1)!, colours.at(-2)!)).toBeLessThanOrEqual(4);
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

/**
 * @fileoverview Unit tests for the Neon visualization.
 *
 * Tests cover:
 * - Layout: waveform length, overhang past the corners, amplitude
 * - Audio reactivity: a silent waveform draws straight lines, a loud one bends
 * - Colour swapping at the 45° intersections, and only there
 * - Trail canvases: creation, zoom and fade, compositing, resize, destroy
 * - Fade-out when playback stops, and idling once fully faded
 * - Edge inputs: zero-sized canvas, extreme waveforms
 *
 * Canvas 2D, the analyser and the clock are faked; see
 * visualization-test-fakes.group2.
 *
 * @module app/components/audio/audio-outlet/visualizations/neon-visualization.spec
 */

import {NeonVisualization} from './neon-visualization';
import type {Visualization} from './visualization';
import {
  FakeAnalyser,
  FakeContext2D,
  LOUD_WAVEFORM,
  flat,
  installCanvasFakes,
  installFakeClock,
} from './visualization-test-fakes.group2';
import type {CanvasFakes, FakeClock, RecordedCall} from './visualization-test-fakes.group2';

// ============================================================================
// Helpers
// ============================================================================

const WIDTH: number = 800;
const HEIGHT: number = 600;
const CENTRE_X: number = WIDTH / 2;
const CENTRE_Y: number = HEIGHT / 2;

/** Radians each cross turns per frame. */
const ROTATION_PER_FRAME: number = 0.005;

/** Frames until the crosses first reach a 45° intersection. */
const FRAMES_TO_FIRST_INTERSECTION: number = Math.ceil((Math.PI / 4) / ROTATION_PER_FRAME);

/** Paths stroked per trail per frame: two waveforms, three layers each. */
const PATHS_PER_TRAIL: number = 6;

const CYAN: string = 'rgb(0, 255, 255)';
const MAGENTA: string = 'rgb(255, 0, 255)';

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Recovers the waveform points of every path built on a context.
 *
 * With smoothing at 100% the control point of each curve segment is the
 * waveform point itself, and the closing lineTo is the last point.
 */
function pathPoints(ctx: FakeContext2D): Point[][] {
  const paths: Point[][] = [];
  for (const call of ctx.calls) {
    if (call.name === 'beginPath') paths.push([]);
    if (call.name === 'quadraticCurveTo' || call.name === 'lineTo') {
      paths[paths.length - 1].push({x: call.args[0] as number, y: call.args[1] as number});
    }
  }
  return paths;
}

/** Turns a point back by `angle` about the screen centre. */
function unrotate(point: Point, angle: number): Point {
  const dx: number = point.x - CENTRE_X;
  const dy: number = point.y - CENTRE_Y;
  return {
    x: dx * Math.cos(-angle) - dy * Math.sin(-angle),
    y: dx * Math.sin(-angle) + dy * Math.cos(-angle),
  };
}

/** The solid (non-glow, non-highlight) stroke colours used on a context. */
function mainStrokeColours(ctx: FakeContext2D): string[] {
  return ctx.valuesSet('strokeStyle')
    .filter((style: unknown): style is string => typeof style === 'string' && style.startsWith('rgb('));
}

// ============================================================================
// Tests
// ============================================================================

describe('NeonVisualization', (): void => {
  let fakes: CanvasFakes;
  let clock: FakeClock;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let viz: NeonVisualization;
  let main: FakeContext2D;

  /** The trail contexts, in the order onResize creates them. */
  const cyanTrail = (): FakeContext2D => fakes.contexts[1];
  const magentaTrail = (): FakeContext2D => fakes.contexts[2];
  const temp = (): FakeContext2D => fakes.contexts[3];

  function drawFrames(count: number): void {
    for (let i: number = 0; i < count; i++) viz.draw();
  }

  function clearRecordings(): void {
    for (const ctx of fakes.contexts) ctx.clear();
  }

  beforeEach((): void => {
    clock = installFakeClock();
    fakes = installCanvasFakes();
    analyser = new FakeAnalyser();
    canvas = document.createElement('canvas');
    viz = new NeonVisualization({canvas, analyser: analyser.node});
    main = fakes.contextFor(canvas);
  });

  afterEach((): void => {
    fakes.restore();
    clock.restore();
    vi.restoreAllMocks();
  });

  describe('construction', (): void => {
    it('identifies itself as Neon in the Bars & Waves category', (): void => {
      expect(viz.name).toBe('Neon');
      expect(viz.category).toBe('Bars & Waves');
    });

    it('ignores the global look controls because its look is fixed', (): void => {
      const base: Visualization = viz;

      base.setSensitivity(1);
      base.setTrailIntensity(1);
      base.setLineWidth(5);
      base.setGlowIntensity(1);
      base.setWaveformSmoothing(0);

      expect(viz.getSensitivity()).toBe(0.3);
      expect(viz.getTrailIntensity()).toBe(0.5);
      expect(viz.getLineWidth()).toBe(1);
      expect(viz.getGlowIntensity()).toBe(0.5);
      expect(viz.getWaveformSmoothing()).toBe(1);
    });
  });

  describe('zero-sized canvas', (): void => {
    it('draws nothing and reads no audio before the first resize', (): void => {
      viz.draw();

      expect(main.calls).toEqual([]);
      expect(analyser.waveformReads).toEqual([]);
    });

    it('draws nothing after being resized to zero', (): void => {
      viz.resize(0, 0);
      clearRecordings();

      viz.draw();

      expect(main.calls).toEqual([]);
    });
  });

  describe('resize', (): void => {
    it('creates two trail canvases and a working canvas at the view size', (): void => {
      viz.resize(WIDTH, HEIGHT);

      expect(fakes.contexts).toHaveLength(4);
      for (const ctx of [cyanTrail(), magentaTrail(), temp()]) {
        expect(ctx.canvas.width).toBe(WIDTH);
        expect(ctx.canvas.height).toBe(HEIGHT);
      }
    });

    it('clears the main canvas', (): void => {
      viz.resize(WIDTH, HEIGHT);

      expect(main.callsTo('clearRect')[0].args).toEqual([0, 0, WIDTH, HEIGHT]);
    });

    it('keeps the same trail canvases and rescales their content to the new size', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.draw();
      const cyanCanvas: HTMLCanvasElement = cyanTrail().canvas;
      clearRecordings();

      viz.resize(400, 300);

      expect(cyanTrail().canvas).toBe(cyanCanvas);
      expect(cyanCanvas.width).toBe(400);
      expect(cyanCanvas.height).toBe(300);
      const preserved: RecordedCall = cyanTrail().callsTo('drawImage')[0];
      expect(preserved.args.slice(1)).toEqual([0, 0, WIDTH, HEIGHT, 0, 0, 400, 300]);
    });

    it('recomputes the waveform length for the new size', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.resize(400, 300);
      clearRecordings();

      viz.draw();

      const first: Point = pathPoints(cyanTrail())[0][0];
      expect(Math.hypot(first.x - 200, first.y - 150)).toBeCloseTo(Math.hypot(400, 300) * 1.05 / 2, 6);
    });

    it('creates the trail canvases on the first draw when the size was set without them', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.destroy();
      const before: number = fakes.contexts.length;

      viz.draw();

      expect(fakes.contexts.length).toBe(before + 3);
    });
  });

  describe('waveform geometry', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
      clearRecordings();
    });

    it('strokes each waveform in glow, main and highlight layers on its own trail', (): void => {
      viz.draw();

      expect(cyanTrail().callsTo('stroke')).toHaveLength(PATHS_PER_TRAIL);
      expect(magentaTrail().callsTo('stroke')).toHaveLength(PATHS_PER_TRAIL);
    });

    it('glows only the first layer of each waveform', (): void => {
      viz.draw();

      const blurs: unknown[] = cyanTrail().callsTo('stroke').map((call: RecordedCall): unknown => call.state['shadowBlur']);
      expect(blurs).toEqual([7.5, 0, 0, 7.5, 0, 0]);
    });

    it('draws a silent waveform as a straight line through the centre', (): void => {
      viz.draw();

      const horizontal: Point[] = pathPoints(cyanTrail())[0].map((p: Point): Point => unrotate(p, ROTATION_PER_FRAME));
      for (const point of horizontal) {
        expect(point.y).toBeCloseTo(0, 6);
      }
    });

    it('bends a loud waveform away from the centre line by the fixed amplitude', (): void => {
      analyser.waveform = LOUD_WAVEFORM;

      viz.draw();

      // sample (127/128) x sensitivity factor (0.6) x amplitude (600 x 8/9 x 0.15)
      const expected: number = (127 / 128) * 0.6 * 80;
      const horizontal: Point[] = pathPoints(cyanTrail())[0].map((p: Point): Point => unrotate(p, ROTATION_PER_FRAME));
      for (const point of horizontal) {
        expect(point.y).toBeCloseTo(expected, 6);
      }
    });

    it('bends the vertical waveform sideways rather than up and down', (): void => {
      analyser.waveform = LOUD_WAVEFORM;

      viz.draw();

      const vertical: Point[] = pathPoints(cyanTrail())[3].map((p: Point): Point => unrotate(p, ROTATION_PER_FRAME));
      for (const point of vertical) {
        expect(point.x).toBeCloseTo((127 / 128) * 0.6 * 80, 6);
      }
    });

    it('extends each waveform past the corners of the view', (): void => {
      viz.draw();

      const points: Point[] = pathPoints(cyanTrail())[0];
      const halfDiagonal: number = Math.hypot(WIDTH, HEIGHT) / 2;
      const startReach: number = Math.hypot(points[0].x - CENTRE_X, points[0].y - CENTRE_Y);
      const endReach: number = Math.hypot(points[points.length - 1].x - CENTRE_X, points[points.length - 1].y - CENTRE_Y);
      expect(startReach).toBeGreaterThan(halfDiagonal);
      expect(endReach).toBeGreaterThan(halfDiagonal);
    });

    it('turns the two crosses in opposite directions', (): void => {
      drawFrames(10);
      clearRecordings();

      viz.draw();

      const cyanEnd: Point = pathPoints(cyanTrail())[0][72];
      const magentaEnd: Point = pathPoints(magentaTrail())[0][72];
      expect(Math.atan2(cyanEnd.y - CENTRE_Y, cyanEnd.x - CENTRE_X)).toBeCloseTo(11 * ROTATION_PER_FRAME, 6);
      expect(Math.atan2(magentaEnd.y - CENTRE_Y, magentaEnd.x - CENTRE_X)).toBeCloseTo(-11 * ROTATION_PER_FRAME, 6);
    });

    it('samples the second cross half a waveform out of step with the first', (): void => {
      // Positive full scale in the first half of the buffer, negative in the second.
      analyser.waveform = (index: number, length: number): number => index < length / 2 ? 255 : 0;

      viz.draw();

      const cyanStart: Point = unrotate(pathPoints(cyanTrail())[0][0], ROTATION_PER_FRAME);
      const magentaStart: Point = unrotate(pathPoints(magentaTrail())[0][0], -ROTATION_PER_FRAME);
      expect(cyanStart.y).toBeGreaterThan(0);
      expect(magentaStart.y).toBeLessThan(0);
    });
  });

  describe('colours', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
      clearRecordings();
    });

    it('starts with the first cross cyan and the second magenta', (): void => {
      viz.draw();

      expect(new Set(mainStrokeColours(cyanTrail()))).toEqual(new Set([CYAN]));
      expect(new Set(mainStrokeColours(magentaTrail()))).toEqual(new Set([MAGENTA]));
    });

    it('does not roll for a swap between intersections', (): void => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0);

      drawFrames(FRAMES_TO_FIRST_INTERSECTION - 1);

      expect(random).not.toHaveBeenCalled();
      expect(new Set(mainStrokeColours(cyanTrail()))).toEqual(new Set([CYAN]));
    });

    it('swaps the colours at an intersection when the roll succeeds', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      drawFrames(FRAMES_TO_FIRST_INTERSECTION - 1);
      clearRecordings();

      viz.draw();

      expect(new Set(mainStrokeColours(cyanTrail()))).toEqual(new Set([MAGENTA]));
      expect(new Set(mainStrokeColours(magentaTrail()))).toEqual(new Set([CYAN]));
    });

    it('keeps the colours at an intersection when the roll fails', (): void => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      drawFrames(FRAMES_TO_FIRST_INTERSECTION - 1);
      clearRecordings();

      viz.draw();

      expect(random).toHaveBeenCalledTimes(1);
      expect(new Set(mainStrokeColours(cyanTrail()))).toEqual(new Set([CYAN]));
    });

    it('swaps back at the next intersection when that roll succeeds too', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      drawFrames(2 * FRAMES_TO_FIRST_INTERSECTION);
      clearRecordings();

      viz.draw();

      expect(new Set(mainStrokeColours(cyanTrail()))).toEqual(new Set([CYAN]));
    });
  });

  describe('trails and compositing', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
      clearRecordings();
    });

    it('redraws each trail from its previous frame, zoomed outward and faded', (): void => {
      viz.draw();

      for (const trail of [cyanTrail(), magentaTrail()]) {
        const redraw: RecordedCall = trail.callsTo('drawImage')[0];
        expect(redraw.args[0]).toBe(temp().canvas);
        expect(redraw.state['globalAlpha']).toBeCloseTo(0.975, 10);
        expect(trail.callsTo('scale')[0].args).toEqual([1.03, 1.03]);
        expect(trail.callsTo('translate')[0].args).toEqual([CENTRE_X, CENTRE_Y]);
      }
    });

    it('composites the second trail additively over the first', (): void => {
      viz.draw();

      const draws: RecordedCall[] = main.callsTo('drawImage');
      expect(draws).toHaveLength(2);
      expect(draws[0].args[0]).toBe(cyanTrail().canvas);
      expect(draws[0].state['globalCompositeOperation']).toBe('source-over');
      expect(draws[1].args[0]).toBe(magentaTrail().canvas);
      expect(draws[1].state['globalCompositeOperation']).toBe('lighter');
    });

    it('clears the main canvas before compositing', (): void => {
      viz.draw();

      const names: string[] = main.calls.map((call: RecordedCall): string => call.name);
      expect(names.indexOf('clearRect')).toBeLessThan(names.indexOf('drawImage'));
    });

    it('leaves the main canvas in normal compositing for the next frame', (): void => {
      viz.setPlaying(true);

      viz.draw();

      expect(main.context.globalCompositeOperation).toBe('source-over');
    });
  });

  describe('fade', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
      clearRecordings();
    });

    it('is idle before playback has ever started', (): void => {
      expect(viz.isIdle()).toBe(true);
    });

    it('draws without a fade overlay while playing', (): void => {
      viz.setPlaying(true);

      viz.draw();

      expect(viz.isIdle()).toBe(false);
      expect(main.callsTo('fillRect')).toEqual([]);
    });

    it('fades out in proportion to the time since playback stopped', (): void => {
      viz.setPlaying(true);
      viz.draw();
      viz.setPlaying(false);
      clock.advance(2500);

      viz.draw();

      const overlay: RecordedCall = main.callsTo('fillRect')[0];
      expect(overlay.state['fillStyle']).toBe('rgba(0, 0, 0, 0.5)');
      expect(overlay.state['globalCompositeOperation']).toBe('destination-out');
      expect(overlay.args).toEqual([0, 0, WIDTH, HEIGHT]);
    });

    it('reaches the same fade whether the time passes in one frame or many', (): void => {
      viz.setPlaying(true);
      viz.draw();
      viz.setPlaying(false);

      for (let i: number = 0; i < 100; i++) {
        clock.advance(25);
        viz.draw();
      }

      const overlays: RecordedCall[] = main.callsTo('fillRect');
      const alpha: number = Number(/([\d.]+)\)$/.exec(String(overlays[overlays.length - 1].state['fillStyle']))?.[1]);
      expect(alpha).toBeCloseTo(0.5, 6);
    });

    it('becomes idle once the fade-out has completed', (): void => {
      viz.setPlaying(true);
      viz.draw();
      viz.setPlaying(false);
      clock.advance(4999);
      viz.draw();
      const idleJustBefore: boolean = viz.isIdle();
      clock.advance(1);

      viz.draw();

      expect(idleJustBefore).toBe(false);
      expect(viz.isIdle()).toBe(true);
    });

    it('is visible again immediately when playback resumes', (): void => {
      viz.setPlaying(true);
      viz.draw();
      viz.setPlaying(false);
      clock.advance(5000);
      viz.draw();
      main.clear();

      viz.setPlaying(true);
      viz.draw();

      expect(viz.isIdle()).toBe(false);
      expect(main.callsTo('fillRect')).toEqual([]);
    });
  });

  describe('FFT size', (): void => {
    it('reads the waveform at the new FFT size after it changes', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.draw();

      viz.setFftSize(512);
      viz.draw();

      expect(analyser.waveformReads).toEqual([2048, 512]);
    });
  });

  describe('destroy', (): void => {
    it('releases its trail canvases, so a later draw builds fresh ones', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.draw();
      const oldCyan: HTMLCanvasElement = cyanTrail().canvas;
      const oldMagenta: HTMLCanvasElement = magentaTrail().canvas;
      main.clear();

      viz.destroy();
      viz.draw();

      const sources: unknown[] = main.callsTo('drawImage').map((call: RecordedCall): unknown => call.args[0]);
      expect(sources).toHaveLength(2);
      expect(sources).not.toContain(oldCyan);
      expect(sources).not.toContain(oldMagenta);
    });
  });

  describe('numeric safety', (): void => {
    it.each([
      ['a silent waveform', flat(128)],
      ['a waveform pinned at positive full scale', flat(255)],
      ['a waveform pinned at negative full scale', flat(0)],
    ])('passes only finite numbers to the canvas for %s', (_label: string, waveform): void => {
      analyser.waveform = waveform;
      viz.resize(WIDTH, HEIGHT);
      viz.setPlaying(true);

      for (let i: number = 0; i < 30; i++) {
        clock.advance(16);
        viz.draw();
      }

      for (const ctx of fakes.contexts) {
        expect(ctx.invalidCalls()).toEqual([]);
      }
    });

    it('passes only finite numbers to the canvas on a one-pixel canvas', (): void => {
      viz.resize(1, 1);

      drawFrames(5);

      for (const ctx of fakes.contexts) {
        expect(ctx.invalidCalls()).toEqual([]);
      }
    });
  });
});

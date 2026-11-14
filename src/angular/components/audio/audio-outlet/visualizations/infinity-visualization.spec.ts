/**
 * @fileoverview Unit tests for the Infinity (dual orbiting circular waveform) visualization.
 *
 * Tests cover:
 * - Both circles tracking the time-domain data (silence, full scale, a single spike)
 * - The circles' placement on opposite sides of the orbit, and the orbit itself
 * - The trail canvases: the outward zoom, the additive composite, and their
 *   creation, resize and release
 * - Hue cycling and the fixed look
 * - FFT size changes, the fade overlay and edge inputs
 *
 * Canvas 2D and Web Audio are faked; see visualization-test-fakes.group3.
 *
 * @module app/components/audio/audio-outlet/visualizations/infinity-visualization.spec
 */

import {InfinityVisualization} from './infinity-visualization';
import {Visualization} from './visualization';
import {
  BYTE_MAX,
  CanvasFakes,
  CanvasRecording,
  FakeAnalyser,
  RecordedCall,
  RecordedOperation,
  RecordedPoint,
  TIME_DOMAIN_SILENCE,
  constantSamples,
  createFakeAnalyser,
  installCanvasFakes,
  spikeSamples,
} from './visualization-test-fakes.group3';

const WIDTH: number = 800;
const HEIGHT: number = 600;
const CENTER: RecordedPoint = {x: 400, y: 300};

/** Number of segments each circle is divided into; it has one more point than this. */
const SEGMENTS: number = 96;

/** Resting radius of each circle: 18% of the smaller canvas dimension. */
const BASE_RADIUS: number = 108;

/** Distance of each circle's centre from the canvas centre: the radius plus the 1px line. */
const ORBIT_RADIUS: number = 109;

/** Radial displacement of a full-scale sample: 40% of the radius x the fixed sensitivity factor of 0.5. */
const FULL_SCALE_DISPLACEMENT: number = 21.6;

function distance(a: RecordedPoint, b: RecordedPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Centre of a circle from its points.
 *
 * The points are evenly spaced in angle, so for a uniform radius their mean is
 * the centre. The last point repeats the first and is left out.
 */
function centreOf(points: RecordedPoint[]): RecordedPoint {
  const ring: RecordedPoint[] = points.slice(0, SEGMENTS);
  return {
    x: ring.reduce((sum: number, point: RecordedPoint): number => sum + point.x, 0) / ring.length,
    y: ring.reduce((sum: number, point: RecordedPoint): number => sum + point.y, 0) / ring.length,
  };
}

describe('InfinityVisualization', (): void => {
  let fakes: CanvasFakes;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let main: CanvasRecording;
  let left: CanvasRecording;
  let right: CanvasRecording;
  let temp: CanvasRecording;
  let viz: InfinityVisualization;
  let now: number;

  function clearRecordings(): void {
    for (const recording of fakes.recordings) {
      recording.clear();
    }
  }

  /**
   * The points of the circle stroked on a trail canvas this frame.
   *
   * Each circle is stroked three times over the same points; the first path is
   * returned. With smoothing fixed at 100% each curve's control point is the
   * circle point itself, so after the opening moveTo the path lists the circle
   * points in order.
   */
  function circleOn(recording: CanvasRecording): RecordedPoint[] {
    return recording.paths()[0].slice(1);
  }

  function drawFrame(): void {
    clearRecordings();
    viz.draw();
  }

  /** Indexes of the points lying well outside the resting radius about the circle's centre. */
  function bulgingIndexes(points: RecordedPoint[]): number[] {
    const centre: RecordedPoint = centreOf(points);
    const margin: number = FULL_SCALE_DISPLACEMENT / 2;
    return points.flatMap((point: RecordedPoint, index: number): number[] =>
      distance(point, centre) > BASE_RADIUS + margin ? [index] : []
    );
  }

  function allNonFiniteOperations(): RecordedOperation[] {
    return fakes.recordings.flatMap((recording: CanvasRecording): RecordedOperation[] => recording.nonFiniteOperations());
  }

  beforeEach((): void => {
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation((): number => now);
    fakes = installCanvasFakes();
    analyser = createFakeAnalyser();
    canvas = document.createElement('canvas');
    viz = new InfinityVisualization({canvas, analyser: analyser.node});
    main = fakes.recordingFor(canvas);
    viz.resize(WIDTH, HEIGHT);
    [, left, right, temp] = fakes.recordings;
    viz.setPlaying(true);
  });

  afterEach((): void => {
    fakes.restore();
    vi.restoreAllMocks();
  });

  describe('metadata', (): void => {
    it('identifies itself as Infinity in the Bars & Waves category', (): void => {
      expect(viz.name).toBe('Infinity');
      expect(viz.category).toBe('Bars & Waves');
    });
  });

  describe('trail canvases', (): void => {
    it('creates two trails and a working canvas at the canvas size on resize', (): void => {
      expect(fakes.recordings).toHaveLength(4);
      for (const offscreen of [left, right, temp]) {
        expect([offscreen.canvas.width, offscreen.canvas.height]).toEqual([WIDTH, HEIGHT]);
      }
    });

    it('creates no offscreen canvases before it has a size', (): void => {
      const unsizedCanvas: HTMLCanvasElement = document.createElement('canvas');
      const before: number = fakes.recordings.length;

      const unsized: InfinityVisualization = new InfinityVisualization({canvas: unsizedCanvas, analyser: analyser.node});
      unsized.draw();

      // Only the main canvas's own context was requested.
      expect(fakes.recordings).toHaveLength(before + 1);
    });
  });

  describe('circles', (): void => {
    it('draws both circles at their resting radius for silence', (): void => {
      analyser.timeDomainData = constantSamples(TIME_DOMAIN_SILENCE);

      drawFrame();

      for (const trail of [left, right]) {
        const points: RecordedPoint[] = circleOn(trail);
        const centre: RecordedPoint = centreOf(points);
        expect(points).toHaveLength(SEGMENTS + 1);
        for (const point of points) {
          expect(distance(point, centre)).toBeCloseTo(BASE_RADIUS, 6);
        }
      }
    });

    it('swells both circles by the full amplitude for maximum samples', (): void => {
      analyser.timeDomainData = constantSamples(BYTE_MAX);

      drawFrame();

      // 255 is 127/128 of full scale above the midpoint.
      const expected: number = BASE_RADIUS + FULL_SCALE_DISPLACEMENT * (127 / 128);
      for (const trail of [left, right]) {
        const points: RecordedPoint[] = circleOn(trail);
        const centre: RecordedPoint = centreOf(points);
        for (const point of points) {
          expect(distance(point, centre)).toBeCloseTo(expected, 6);
        }
      }
    });

    it('shrinks both circles by the full amplitude for minimum samples', (): void => {
      analyser.timeDomainData = constantSamples(0);

      drawFrame();

      for (const trail of [left, right]) {
        const points: RecordedPoint[] = circleOn(trail);
        const centre: RecordedPoint = centreOf(points);
        for (const point of points) {
          expect(distance(point, centre)).toBeCloseTo(BASE_RADIUS - FULL_SCALE_DISPLACEMENT, 6);
        }
      }
    });

    it('starts each circle at the top and ends where it started', (): void => {
      drawFrame();

      const points: RecordedPoint[] = circleOn(left);
      const centre: RecordedPoint = centreOf(points);
      expect(points[0].x).toBeCloseTo(centre.x, 6);
      expect(points[0].y).toBeCloseTo(centre.y - BASE_RADIUS, 6);
      expect(points[SEGMENTS].x).toBeCloseTo(points[0].x, 6);
      expect(points[SEGMENTS].y).toBeCloseTo(points[0].y, 6);
    });

    it('bulges the first circle only where it samples a single spike', (): void => {
      // Point 24 of 96 reads the sample a quarter of the way through the 2048-sample buffer.
      analyser.timeDomainData = spikeSamples(512, 513, BYTE_MAX, TIME_DOMAIN_SILENCE);

      drawFrame();

      expect(bulgingIndexes(circleOn(left))).toEqual([24]);
    });

    it('reads the second circle half a buffer out of step with the first', (): void => {
      analyser.timeDomainData = spikeSamples(512, 513, BYTE_MAX, TIME_DOMAIN_SILENCE);

      drawFrame();

      // The same sample lands 48 points later on the second circle.
      expect(bulgingIndexes(circleOn(right))).toEqual([72]);
    });

    it('closes each circle path', (): void => {
      drawFrame();

      // One closePath per stroke layer.
      expect(left.callsTo('closePath')).toHaveLength(3);
      expect(right.callsTo('closePath')).toHaveLength(3);
    });

    it('strokes each circle as a glow, a main line and a white highlight', (): void => {
      drawFrame();

      const strokes: readonly RecordedCall[] = left.calls('stroke');
      expect(strokes.map((stroke: RecordedCall): unknown => stroke.state['strokeStyle'])).toEqual([
        'rgba(2, 0, 255, 0.30)',
        'rgb(2, 0, 255)',
        'rgba(255, 255, 255, 0.5)',
      ]);
      expect(strokes.map((stroke: RecordedCall): unknown => stroke.state['lineWidth'])).toEqual([5, 1, 1]);
      expect(strokes.map((stroke: RecordedCall): unknown => stroke.state['shadowBlur'])).toEqual([15, 0, 0]);
    });
  });

  describe('orbit', (): void => {
    it('places the two circles on opposite sides of the canvas centre', (): void => {
      drawFrame();

      const first: RecordedPoint = centreOf(circleOn(left));
      const second: RecordedPoint = centreOf(circleOn(right));
      expect((first.x + second.x) / 2).toBeCloseTo(CENTER.x, 6);
      expect((first.y + second.y) / 2).toBeCloseTo(CENTER.y, 6);
    });

    it('keeps each circle one line width clear of the centre', (): void => {
      drawFrame();

      expect(distance(centreOf(circleOn(left)), CENTER)).toBeCloseTo(ORBIT_RADIUS, 6);
      expect(distance(centreOf(circleOn(right)), CENTER)).toBeCloseTo(ORBIT_RADIUS, 6);
    });

    it('moves the circles around the centre from frame to frame without changing their distance from it', (): void => {
      drawFrame();
      const before: RecordedPoint = centreOf(circleOn(left));

      drawFrame();
      const after: RecordedPoint = centreOf(circleOn(left));

      expect(distance(before, after)).toBeGreaterThan(1);
      expect(distance(after, CENTER)).toBeCloseTo(ORBIT_RADIUS, 6);
    });
  });

  describe('colour cycling', (): void => {
    it('starts the first circle blue and the second green', (): void => {
      drawFrame();

      expect(left.calls('stroke')[1].state['strokeStyle']).toBe('rgb(2, 0, 255)');
      expect(right.calls('stroke')[1].state['strokeStyle']).toBe('rgb(0, 255, 2)');
    });

    it('has cycled the first circle round to red after 240 frames', (): void => {
      for (let i: number = 0; i < 239; i++) {
        viz.draw();
      }

      drawFrame();

      // Half a degree per frame: 120 degrees on from blue.
      expect(left.calls('stroke')[1].state['strokeStyle']).toBe('rgb(255, 0, 0)');
    });
  });

  describe('trail zoom', (): void => {
    it('copies each trail to the working canvas before redrawing it', (): void => {
      drawFrame();

      expect(temp.callsTo('drawImage')).toEqual([
        [left.canvas, 0, 0],
        [right.canvas, 0, 0],
      ]);
    });

    it('redraws each trail enlarged by 3% about the centre of the canvas', (): void => {
      drawFrame();

      for (const trail of [left, right]) {
        expect(trail.callsTo('translate')).toEqual([
          [CENTER.x, CENTER.y],
          [-CENTER.x, -CENTER.y],
        ]);
        expect(trail.callsTo('scale')).toEqual([[1.03, 1.03]]);
        expect(trail.callsTo('drawImage')).toEqual([[temp.canvas, 0, 0]]);
      }
    });

    it('dims the redrawn trail by the fade rate', (): void => {
      drawFrame();

      expect(left.calls('drawImage')[0].state['globalAlpha']).toBeCloseTo(0.975, 10);
    });
  });

  describe('composite', (): void => {
    it('clears the main canvas and draws the first trail then the second', (): void => {
      drawFrame();

      expect(main.callsTo('clearRect')).toEqual([[0, 0, WIDTH, HEIGHT]]);
      expect(main.callsTo('drawImage')).toEqual([
        [left.canvas, 0, 0],
        [right.canvas, 0, 0],
      ]);
    });

    it('adds the second trail to the first so that overlaps brighten', (): void => {
      drawFrame();

      const draws: readonly RecordedCall[] = main.calls('drawImage');
      expect(draws[0].state['globalCompositeOperation']).toBe('source-over');
      expect(draws[1].state['globalCompositeOperation']).toBe('lighter');
    });

    it('leaves the main canvas in normal compositing afterwards', (): void => {
      drawFrame();

      expect(main.context.globalCompositeOperation).toBe('source-over');
    });
  });

  describe('resize', (): void => {
    it('resizes all three offscreen canvases', (): void => {
      viz.resize(400, 300);

      for (const offscreen of [left, right, temp]) {
        expect([offscreen.canvas.width, offscreen.canvas.height]).toEqual([400, 300]);
      }
    });

    it('carries each trail over to the new size', (): void => {
      viz.draw();
      clearRecordings();

      viz.resize(400, 300);

      for (const trail of [left, right]) {
        const scaledCopy: readonly unknown[] = trail.callsTo('drawImage')[0];
        expect(scaledCopy.slice(1)).toEqual([0, 0, WIDTH, HEIGHT, 0, 0, 400, 300]);
      }
    });

    it('clears the main canvas at the new size', (): void => {
      clearRecordings();

      viz.resize(400, 300);

      expect(main.callsTo('clearRect')).toEqual([[0, 0, 400, 300]]);
    });

    it('sizes the circles from the smaller dimension of the new canvas', (): void => {
      viz.resize(1000, 400);

      drawFrame();

      const points: RecordedPoint[] = circleOn(left);
      expect(distance(points[0], centreOf(points))).toBeCloseTo(72, 6);
    });

    it('orbits the centre of the new canvas', (): void => {
      viz.resize(1000, 400);

      drawFrame();

      const first: RecordedPoint = centreOf(circleOn(left));
      const second: RecordedPoint = centreOf(circleOn(right));
      expect((first.x + second.x) / 2).toBeCloseTo(500, 6);
      expect((first.y + second.y) / 2).toBeCloseTo(200, 6);
      expect(distance(first, {x: 500, y: 200})).toBeCloseTo(73, 6);
    });
  });

  describe('fixed look', (): void => {
    it('ignores the global sensitivity, trail, line width, glow and smoothing controls', (): void => {
      // Through the base type, as the outlet calls them: the overrides take no argument.
      const controlled: Visualization = viz;

      controlled.setSensitivity(1);
      controlled.setTrailIntensity(1);
      controlled.setLineWidth(5);
      controlled.setGlowIntensity(0);
      controlled.setWaveformSmoothing(0);

      expect(viz.getSensitivity()).toBe(0.25);
      expect(viz.getTrailIntensity()).toBe(0.5);
      expect(viz.getLineWidth()).toBe(1);
      expect(viz.getGlowIntensity()).toBe(1);
      expect(viz.getWaveformSmoothing()).toBe(1);
    });
  });

  describe('FFT size', (): void => {
    it('reads one byte per FFT sample', (): void => {
      viz.draw();

      expect(analyser.timeDomainReads).toEqual([2048]);
    });

    it('resizes its buffer when the FFT size changes', (): void => {
      viz.setFftSize(1024);

      viz.draw();

      expect(analyser.timeDomainReads).toEqual([1024]);
    });
  });

  describe('fade', (): void => {
    it('draws no fade overlay while playing', (): void => {
      drawFrame();

      expect(main.callsTo('fillRect')).toHaveLength(0);
    });

    it('fades the composited frame out in proportion to the time since playback stopped', (): void => {
      viz.setPlaying(false);
      now += 2500; // half of the five second fade-out

      drawFrame();

      const overlay: RecordedCall = main.calls('fillRect')[0];
      expect(overlay.args).toEqual([0, 0, WIDTH, HEIGHT]);
      expect(overlay.state['globalCompositeOperation']).toBe('destination-out');
      expect(overlay.state['fillStyle']).toBe('rgba(0, 0, 0, 0.5)');
    });

    it('becomes idle once the fade-out has completed', (): void => {
      viz.setPlaying(false);
      now += 5000;

      viz.draw();

      expect(viz.isIdle()).toBe(true);
    });
  });

  describe('destroy', (): void => {
    it('stops using the trail canvases it had', (): void => {
      viz.draw();

      viz.destroy();
      drawFrame();

      const drawn: unknown[] = main.callsTo('drawImage').map((args: readonly unknown[]): unknown => args[0]);
      expect(drawn).toHaveLength(2);
      expect(drawn).not.toContain(left.canvas);
      expect(drawn).not.toContain(right.canvas);
      expect(left.operations).toHaveLength(0);
      expect(right.operations).toHaveLength(0);
      expect(temp.operations).toHaveLength(0);
    });

    it('builds fresh trail canvases if it is drawn again', (): void => {
      viz.destroy();

      viz.draw();

      const [newLeft, newRight]: CanvasRecording[] = fakes.recordings.slice(4);
      expect(fakes.recordings).toHaveLength(7);
      expect(main.callsTo('drawImage')).toEqual([
        [newLeft.canvas, 0, 0],
        [newRight.canvas, 0, 0],
      ]);
    });
  });

  describe('edge cases', (): void => {
    it('draws nothing and reads no audio while the canvas has no size', (): void => {
      viz.resize(0, 0);
      clearRecordings();

      viz.draw();

      expect(fakes.recordings.flatMap((recording: CanvasRecording): RecordedOperation[] => recording.operations)).toEqual([]);
      expect(analyser.timeDomainReads).toHaveLength(0);
    });

    it.each([
      ['silence', TIME_DOMAIN_SILENCE, WIDTH, HEIGHT],
      ['all-zero samples', 0, WIDTH, HEIGHT],
      ['all-255 samples', BYTE_MAX, WIDTH, HEIGHT],
      ['a one-pixel canvas', BYTE_MAX, 1, 1],
    ])('passes only finite numbers to any canvas for %s', (_label: string, level: number, width: number, height: number): void => {
      analyser.timeDomainData = constantSamples(level);
      viz.resize(width, height);
      clearRecordings();

      for (let i: number = 0; i < 5; i++) {
        viz.draw();
      }

      expect(left.callsTo('stroke')).toHaveLength(15);
      expect(allNonFiniteOperations()).toEqual([]);
    });
  });
});

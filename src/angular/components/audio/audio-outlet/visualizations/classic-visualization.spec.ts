/**
 * @fileoverview Unit tests for the Classic (oscilloscope) visualization.
 *
 * Tests cover:
 * - The waveform trace tracking the time-domain data (silence, full scale, a single spike)
 * - The three stroke layers and their fixed look
 * - The persistence fade and the periodic ghost-pixel clear, including how its
 *   cadence stretches with canvas size
 * - Content-preserving resize, FFT size changes, the fade overlay and edge inputs
 *
 * Canvas 2D and Web Audio are faked; see visualization-test-fakes.group3.
 *
 * @module app/components/audio/audio-outlet/visualizations/classic-visualization.spec
 */

import {ClassicVisualization} from './classic-visualization';
import {Visualization} from './visualization';
import {
  BYTE_MAX,
  CanvasFakes,
  CanvasRecording,
  FakeAnalyser,
  RecordedCall,
  RecordedPoint,
  TIME_DOMAIN_SILENCE,
  constantSamples,
  createFakeAnalyser,
  installCanvasFakes,
  spikeSamples,
} from './visualization-test-fakes.group3';

const WIDTH: number = 800;
const HEIGHT: number = 400;
const CENTER_Y: number = 200;

/** Number of segments the trace is divided into; it has one more point than this. */
const SEGMENTS: number = 32;

/** Displacement of a full-scale sample: 40% of the height x the fixed sensitivity factor of 0.4. */
const FULL_SCALE_DISPLACEMENT: number = 64;

/** A one-pixel image, so the large-canvas cadence tests do not allocate canvas-sized buffers. */
function onePixel(alpha: number): ImageData {
  return {data: new Uint8ClampedArray([255, 255, 255, alpha]), width: 1, height: 1, colorSpace: 'srgb'} as ImageData;
}

describe('ClassicVisualization', (): void => {
  let fakes: CanvasFakes;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let recording: CanvasRecording;
  let viz: ClassicVisualization;
  let now: number;

  /**
   * Draws one frame from a clean recording and returns the points of the trace.
   *
   * The trace is stroked three times over the same points; the first path is
   * returned. With smoothing fixed at 100% each curve's control point is the
   * waveform point itself, so after the opening moveTo the path lists the
   * waveform points in order.
   */
  function drawTrace(): RecordedPoint[] {
    recording.clear();
    viz.draw();
    return recording.paths()[0].slice(1);
  }

  function drawFrames(count: number): void {
    for (let i: number = 0; i < count; i++) {
      viz.draw();
    }
  }

  beforeEach((): void => {
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation((): number => now);
    fakes = installCanvasFakes();
    analyser = createFakeAnalyser();
    canvas = document.createElement('canvas');
    viz = new ClassicVisualization({canvas, analyser: analyser.node});
    recording = fakes.recordingFor(canvas);
    viz.resize(WIDTH, HEIGHT);
    viz.setPlaying(true);
  });

  afterEach((): void => {
    fakes.restore();
    vi.restoreAllMocks();
  });

  describe('metadata', (): void => {
    it('identifies itself as Classic in the Bars & Waves category', (): void => {
      expect(viz.name).toBe('Classic');
      expect(viz.category).toBe('Bars & Waves');
    });
  });

  describe('waveform trace', (): void => {
    it('draws a flat line through the vertical centre for silence', (): void => {
      analyser.timeDomainData = constantSamples(TIME_DOMAIN_SILENCE);

      const trace: RecordedPoint[] = drawTrace();

      expect(trace).toHaveLength(SEGMENTS + 1);
      expect(trace.every((point: RecordedPoint): boolean => point.y === CENTER_Y)).toBe(true);
    });

    it('spans the full width of the canvas', (): void => {
      const trace: RecordedPoint[] = drawTrace();

      expect(trace[0].x).toBe(0);
      expect(trace[SEGMENTS / 2].x).toBe(WIDTH / 2);
      expect(trace[SEGMENTS].x).toBe(WIDTH);
    });

    it('displaces the trace downward by the full amplitude for maximum samples', (): void => {
      analyser.timeDomainData = constantSamples(BYTE_MAX);

      const trace: RecordedPoint[] = drawTrace();

      // 255 is 127/128 of full scale above the midpoint.
      const expected: number = CENTER_Y + FULL_SCALE_DISPLACEMENT * (127 / 128);
      for (const point of trace) {
        expect(point.y).toBeCloseTo(expected, 6);
      }
    });

    it('displaces the trace upward by the full amplitude for minimum samples', (): void => {
      analyser.timeDomainData = constantSamples(0);

      const trace: RecordedPoint[] = drawTrace();

      for (const point of trace) {
        expect(point.y).toBeCloseTo(CENTER_Y - FULL_SCALE_DISPLACEMENT, 6);
      }
    });

    it('moves only the point that samples a single spike', (): void => {
      // Point 16 of 32 reads the sample halfway through the 2048-sample buffer.
      analyser.timeDomainData = spikeSamples(1024, 1025, BYTE_MAX, TIME_DOMAIN_SILENCE);

      const trace: RecordedPoint[] = drawTrace();

      const displaced: number[] = trace.flatMap((point: RecordedPoint, index: number): number[] =>
        point.y === CENTER_Y ? [] : [index]
      );
      expect(displaced).toEqual([16]);
    });

    it('reads the final sample for the last point rather than running off the buffer', (): void => {
      analyser.timeDomainData = spikeSamples(2047, 2048, BYTE_MAX, TIME_DOMAIN_SILENCE);

      const trace: RecordedPoint[] = drawTrace();

      expect(trace[SEGMENTS].y).toBeGreaterThan(CENTER_Y);
      expect(trace[SEGMENTS - 1].y).toBe(CENTER_Y);
    });

    it('scales the displacement with the canvas height', (): void => {
      analyser.timeDomainData = constantSamples(0);
      viz.resize(WIDTH, HEIGHT * 2);

      const trace: RecordedPoint[] = drawTrace();

      expect(trace[0].y).toBeCloseTo(CENTER_Y * 2 - FULL_SCALE_DISPLACEMENT * 2, 6);
    });
  });

  describe('stroke layers', (): void => {
    it('strokes the trace as a glow, a green main line and a pale highlight', (): void => {
      recording.clear();

      viz.draw();

      const strokes: readonly RecordedCall[] = recording.calls('stroke');
      expect(strokes.map((stroke: RecordedCall): unknown => stroke.state['strokeStyle'])).toEqual([
        'rgba(0, 255, 100, 0.30)',
        'rgb(0, 255, 100)',
        'rgba(150, 255, 180, 0.6)',
      ]);
    });

    it('draws the main line one pixel wide over a wider glow', (): void => {
      recording.clear();

      viz.draw();

      const strokes: readonly RecordedCall[] = recording.calls('stroke');
      expect(strokes.map((stroke: RecordedCall): unknown => stroke.state['lineWidth'])).toEqual([5, 1, 1]);
    });

    it('applies no shadow blur, because its glow is fixed off', (): void => {
      recording.clear();

      viz.draw();

      expect(recording.valuesSetFor('shadowBlur')).toEqual([0]);
    });

    it('strokes the same points in all three layers', (): void => {
      analyser.timeDomainData = spikeSamples(1024, 1025, BYTE_MAX, TIME_DOMAIN_SILENCE);
      recording.clear();

      viz.draw();

      const paths: RecordedPoint[][] = recording.paths();
      expect(paths).toHaveLength(3);
      expect(paths[1]).toEqual(paths[0]);
      expect(paths[2]).toEqual(paths[0]);
    });
  });

  describe('fixed look', (): void => {
    it('ignores the global sensitivity, trail, line width, glow and smoothing controls', (): void => {
      // Through the base type, as the outlet calls them: the overrides take no argument.
      const controlled: Visualization = viz;

      controlled.setSensitivity(1);
      controlled.setTrailIntensity(1);
      controlled.setLineWidth(5);
      controlled.setGlowIntensity(1);
      controlled.setWaveformSmoothing(0);

      expect(viz.getSensitivity()).toBe(0.2);
      expect(viz.getTrailIntensity()).toBe(0);
      expect(viz.getLineWidth()).toBe(1);
      expect(viz.getGlowIntensity()).toBe(0);
      expect(viz.getWaveformSmoothing()).toBe(1);
    });

    it('draws the same trace after the sensitivity control is moved', (): void => {
      analyser.timeDomainData = constantSamples(0);
      const before: RecordedPoint[] = drawTrace();
      const controlled: Visualization = viz;

      controlled.setSensitivity(1);

      expect(drawTrace()).toEqual(before);
    });
  });

  describe('persistence', (): void => {
    it('fades the previous frame instead of clearing it', (): void => {
      recording.clear();

      viz.draw();

      const fade: RecordedCall = recording.calls('fillRect')[0];
      expect(recording.callsTo('clearRect')).toHaveLength(0);
      expect(fade.args).toEqual([0, 0, WIDTH, HEIGHT]);
      expect(fade.state['globalCompositeOperation']).toBe('destination-out');
      // Base rate 0.03, doubled because the trail intensity is fixed at its minimum.
      expect(fade.state['fillStyle']).toBe('rgba(0, 0, 0, 0.06)');
    });

    it('restores normal compositing before stroking the trace', (): void => {
      recording.clear();

      viz.draw();

      for (const stroke of recording.calls('stroke')) {
        expect(stroke.state['globalCompositeOperation']).toBe('source-over');
      }
    });
  });

  describe('ghost-pixel clear', (): void => {
    it('does not read the canvas back before the tenth frame', (): void => {
      drawFrames(9);

      expect(recording.callsTo('getImageData')).toHaveLength(0);
    });

    it('reads the whole canvas back on every tenth frame', (): void => {
      drawFrames(20);

      expect(recording.callsTo('getImageData')).toEqual([
        [0, 0, WIDTH, HEIGHT],
        [0, 0, WIDTH, HEIGHT],
      ]);
    });

    it('zeroes faint pixels and writes the result back', (): void => {
      const image: ImageData = {
        data: new Uint8ClampedArray([
          255, 255, 255, 10,  // faint: cleared
          255, 255, 255, 29,  // just under the threshold: cleared
          255, 255, 255, 30,  // at the threshold: kept
          255, 255, 255, 200, // solid: kept
        ]),
        width: 4,
        height: 1,
        colorSpace: 'srgb',
      } as ImageData;
      recording.imageDataSource = (): ImageData => image;

      drawFrames(10);

      expect(recording.callsTo('putImageData')).toEqual([[image, 0, 0]]);
      expect([image.data[3], image.data[7], image.data[11], image.data[15]]).toEqual([0, 0, 30, 200]);
    });

    it('keeps the ten frame cadence on a 1080p canvas', (): void => {
      recording.imageDataSource = (): ImageData => onePixel(0);
      viz.resize(1920, 1080);

      drawFrames(10);

      expect(recording.callsTo('getImageData')).toHaveLength(1);
    });

    it('waits twice as long on a 1440p canvas', (): void => {
      recording.imageDataSource = (): ImageData => onePixel(0);
      viz.resize(2560, 1440);

      drawFrames(19);
      const readsBefore: number = recording.callsTo('getImageData').length;
      viz.draw();

      expect(readsBefore).toBe(0);
      expect(recording.callsTo('getImageData')).toHaveLength(1);
    });

    it('waits four times as long on a 4K canvas', (): void => {
      recording.imageDataSource = (): ImageData => onePixel(0);
      viz.resize(3840, 2160);

      drawFrames(39);
      const readsBefore: number = recording.callsTo('getImageData').length;
      viz.draw();

      expect(readsBefore).toBe(0);
      expect(recording.callsTo('getImageData')).toHaveLength(1);
    });
  });

  describe('resize', (): void => {
    it('carries the existing trails over to the new size once a frame has been drawn', (): void => {
      viz.draw();
      recording.clear();

      viz.resize(400, 200);

      const snapshot: CanvasRecording = fakes.recordings[1];
      expect(snapshot.callsTo('drawImage')).toEqual([[canvas, 0, 0]]);
      expect(recording.callsTo('drawImage')).toEqual([[snapshot.canvas, 0, 0, WIDTH, HEIGHT, 0, 0, 400, 200]]);
      expect([canvas.width, canvas.height]).toEqual([400, 200]);
    });

    it('takes the snapshot at the old size', (): void => {
      viz.draw();

      viz.resize(400, 200);

      const snapshot: CanvasRecording = fakes.recordings[1];
      expect([snapshot.canvas.width, snapshot.canvas.height]).toEqual([WIDTH, HEIGHT]);
    });

    it('resizes without copying anything before the first frame', (): void => {
      viz.resize(400, 200);

      expect(fakes.recordings).toHaveLength(1);
      expect(recording.callsTo('drawImage')).toHaveLength(0);
      expect([canvas.width, canvas.height]).toEqual([400, 200]);
    });

    it('leaves the canvas untouched when resized to the size it already has after drawing', (): void => {
      viz.draw();
      recording.clear();

      viz.resize(WIDTH, HEIGHT);

      expect(recording.operations).toHaveLength(0);
    });

    it('clears whatever the previous visualization left when resized to the same size before drawing', (): void => {
      recording.clear();

      viz.resize(WIDTH, HEIGHT);

      expect(recording.callsTo('clearRect')).toEqual([[0, 0, WIDTH, HEIGHT]]);
    });

    it('draws the trace across the new width after a resize', (): void => {
      viz.resize(400, 200);

      const trace: RecordedPoint[] = drawTrace();

      expect(trace[SEGMENTS].x).toBe(400);
      expect(trace[0].y).toBe(100);
    });
  });

  describe('FFT size', (): void => {
    it('reads one byte per FFT sample', (): void => {
      viz.draw();

      expect(analyser.timeDomainReads).toEqual([2048]);
    });

    it('resizes its buffer when the FFT size changes', (): void => {
      viz.setFftSize(512);

      viz.draw();

      expect(analyser.timeDomainReads).toEqual([512]);
    });
  });

  describe('fade', (): void => {
    it('draws no fade overlay while playing', (): void => {
      recording.clear();

      viz.draw();

      // The only fill is the persistence fade.
      expect(recording.callsTo('fillRect')).toHaveLength(1);
    });

    it('fades the frame out in proportion to the time since playback stopped', (): void => {
      viz.setPlaying(false);
      now += 1250; // a quarter of the five second fade-out
      recording.clear();

      viz.draw();

      const overlay: RecordedCall = recording.calls('fillRect')[1];
      expect(overlay.args).toEqual([0, 0, WIDTH, HEIGHT]);
      expect(overlay.state['globalCompositeOperation']).toBe('destination-out');
      expect(overlay.state['fillStyle']).toBe('rgba(0, 0, 0, 0.25)');
    });

    it('is not idle while playing, however long it has been', (): void => {
      now += 60_000;

      viz.draw();

      expect(viz.isIdle()).toBe(false);
    });

    it('becomes idle once the fade-out has completed', (): void => {
      viz.setPlaying(false);
      now += 5000;

      viz.draw();

      expect(viz.isIdle()).toBe(true);
    });
  });

  describe('edge cases', (): void => {
    it.each([
      ['silence', TIME_DOMAIN_SILENCE, WIDTH, HEIGHT],
      ['all-zero samples', 0, WIDTH, HEIGHT],
      ['all-255 samples', BYTE_MAX, WIDTH, HEIGHT],
      ['a zero-sized canvas', BYTE_MAX, 0, 0],
    ])('passes only finite numbers to the canvas for %s', (_label: string, level: number, width: number, height: number): void => {
      analyser.timeDomainData = constantSamples(level);
      viz.resize(width, height);
      recording.clear();

      drawFrames(10);

      expect(recording.callsTo('stroke')).toHaveLength(30);
      expect(recording.nonFiniteOperations()).toEqual([]);
    });

    it('does not read back a zero-sized canvas', (): void => {
      viz.resize(0, 0);

      drawFrames(10);

      expect(recording.callsTo('getImageData')).toHaveLength(0);
    });
  });
});

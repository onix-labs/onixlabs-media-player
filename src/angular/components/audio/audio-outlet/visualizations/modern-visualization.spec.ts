/**
 * @fileoverview Unit tests for the Modern (brand-gradient waveform) visualization.
 *
 * Tests cover:
 * - The waveform trace tracking the time-domain data (silence, full scale, a single spike)
 * - The brand-colour gradients, their caching and their rebuild on resize
 * - The layered glow, main line and highlight
 * - The persistence fade and the periodic ghost-pixel clear
 * - Content-preserving resize, FFT size changes, the fade overlay and edge inputs
 *
 * Canvas 2D and Web Audio are faked; see visualization-test-fakes.group3.
 *
 * @module app/components/audio/audio-outlet/visualizations/modern-visualization.spec
 */

import {ModernVisualization} from './modern-visualization';
import {Visualization} from './visualization';
import {
  BYTE_MAX,
  CanvasFakes,
  CanvasRecording,
  FakeAnalyser,
  FakeGradient,
  RecordedCall,
  RecordedColorStop,
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

/** The ONIXLabs brand colours, orange through green, in gradient order. */
const BRAND_RGB: readonly string[] = [
  '247, 149, 51',
  '243, 112, 85',
  '239, 78, 123',
  '161, 102, 171',
  '80, 115, 184',
  '16, 152, 173',
  '7, 179, 155',
  '111, 186, 130',
];

/** A one-pixel image, so the large-canvas cadence test does not allocate a canvas-sized buffer. */
function onePixel(alpha: number): ImageData {
  return {data: new Uint8ClampedArray([255, 255, 255, alpha]), width: 1, height: 1, colorSpace: 'srgb'} as ImageData;
}

describe('ModernVisualization', (): void => {
  let fakes: CanvasFakes;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let recording: CanvasRecording;
  let viz: ModernVisualization;
  let now: number;

  /**
   * Draws one frame from a clean recording and returns the points of the trace.
   *
   * The trace is stroked five times over the same points; the first path is
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
    viz = new ModernVisualization({canvas, analyser: analyser.node});
    recording = fakes.recordingFor(canvas);
    viz.resize(WIDTH, HEIGHT);
    viz.setPlaying(true);
  });

  afterEach((): void => {
    fakes.restore();
    vi.restoreAllMocks();
  });

  describe('metadata', (): void => {
    it('identifies itself as Modern in the Bars & Waves category', (): void => {
      expect(viz.name).toBe('Modern');
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
      // Point 8 of 32 reads the sample a quarter of the way through the 2048-sample buffer.
      analyser.timeDomainData = spikeSamples(512, 513, BYTE_MAX, TIME_DOMAIN_SILENCE);

      const trace: RecordedPoint[] = drawTrace();

      const displaced: number[] = trace.flatMap((point: RecordedPoint, index: number): number[] =>
        point.y === CENTER_Y ? [] : [index]
      );
      expect(displaced).toEqual([8]);
    });

    it('reads the final sample for the last point rather than running off the buffer', (): void => {
      analyser.timeDomainData = spikeSamples(2047, 2048, BYTE_MAX, TIME_DOMAIN_SILENCE);

      const trace: RecordedPoint[] = drawTrace();

      expect(trace[SEGMENTS].y).toBeGreaterThan(CENTER_Y);
      expect(trace[SEGMENTS - 1].y).toBe(CENTER_Y);
    });

    it('strokes the same points in every layer', (): void => {
      analyser.timeDomainData = spikeSamples(512, 513, BYTE_MAX, TIME_DOMAIN_SILENCE);
      recording.clear();

      viz.draw();

      const paths: RecordedPoint[][] = recording.paths();
      expect(paths).toHaveLength(5);
      for (const path of paths) {
        expect(path).toEqual(paths[0]);
      }
    });
  });

  describe('brand gradients', (): void => {
    it('builds an opaque left-to-right gradient of the eight brand colours for the main line', (): void => {
      recording.clear();

      viz.draw();

      const main: FakeGradient = recording.gradients[0];
      expect(main.args).toEqual([0, 0, WIDTH, 0]);
      expect(main.stops.map((stop: RecordedColorStop): string => stop.color)).toEqual(
        BRAND_RGB.map((rgb: string): string => `rgba(${rgb}, 1)`)
      );
    });

    it('builds the same gradient at 80% opacity for the glow', (): void => {
      recording.clear();

      viz.draw();

      const glow: FakeGradient = recording.gradients[1];
      expect(glow.args).toEqual([0, 0, WIDTH, 0]);
      expect(glow.stops.map((stop: RecordedColorStop): string => stop.color)).toEqual(
        BRAND_RGB.map((rgb: string): string => `rgba(${rgb}, 0.8)`)
      );
    });

    it('spaces the colour stops evenly from 0 to 1', (): void => {
      recording.clear();

      viz.draw();

      const offsets: number[] = recording.gradients[0].stops.map((stop: RecordedColorStop): number => stop.offset);
      expect(offsets).toHaveLength(8);
      offsets.forEach((offset: number, index: number): void => {
        expect(offset).toBeCloseTo(index / 7, 10);
      });
    });

    it('reuses the gradients from frame to frame', (): void => {
      viz.draw();
      recording.clear();

      viz.draw();

      expect(recording.gradients).toHaveLength(0);
    });

    it('rebuilds the gradients to span the new width after a resize', (): void => {
      viz.draw();
      viz.resize(400, HEIGHT);
      recording.clear();

      viz.draw();

      expect(recording.gradients.map((gradient: FakeGradient): readonly unknown[] => gradient.args)).toEqual([
        [0, 0, 400, 0],
        [0, 0, 400, 0],
      ]);
    });
  });

  describe('stroke layers', (): void => {
    it('strokes three glow passes, the main line and a highlight', (): void => {
      recording.clear();

      viz.draw();

      const [main, glow]: FakeGradient[] = recording.gradients;
      const styles: unknown[] = recording.calls('stroke').map((stroke: RecordedCall): unknown => stroke.state['strokeStyle']);
      expect(styles).toEqual([glow, glow, glow, main, 'rgba(255, 255, 255, 0.3)']);
    });

    it('narrows and strengthens the glow with each pass', (): void => {
      recording.clear();

      viz.draw();

      const glowPasses: readonly RecordedCall[] = recording.calls('stroke').slice(0, 3);
      const widths: unknown[] = glowPasses.map((stroke: RecordedCall): unknown => stroke.state['lineWidth']);
      const alphas: number[] = glowPasses.map((stroke: RecordedCall): number => stroke.state['globalAlpha'] as number);
      expect(widths).toEqual([16, 11, 6]);
      expect(alphas[0]).toBeCloseTo(0.1, 10);
      expect(alphas[1]).toBeCloseTo(0.15, 10);
      expect(alphas[2]).toBeCloseTo(0.3, 10);
    });

    it('draws the main line and highlight one pixel wide at full opacity', (): void => {
      recording.clear();

      viz.draw();

      const solid: readonly RecordedCall[] = recording.calls('stroke').slice(3);
      expect(solid.map((stroke: RecordedCall): unknown => stroke.state['lineWidth'])).toEqual([1, 1]);
      expect(solid.map((stroke: RecordedCall): unknown => stroke.state['globalAlpha'])).toEqual([1, 1]);
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

      expect(viz.getSensitivity()).toBe(0.2);
      expect(viz.getTrailIntensity()).toBe(0);
      expect(viz.getLineWidth()).toBe(1);
      expect(viz.getGlowIntensity()).toBe(1);
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

    it('reads the whole canvas back on every tenth frame to clear ghost pixels', (): void => {
      drawFrames(9);
      const readsBefore: number = recording.callsTo('getImageData').length;

      viz.draw();

      expect(readsBefore).toBe(0);
      expect(recording.callsTo('getImageData')).toEqual([[0, 0, WIDTH, HEIGHT]]);
    });

    it('zeroes faint pixels and writes the result back', (): void => {
      const image: ImageData = {
        data: new Uint8ClampedArray([255, 255, 255, 12, 255, 255, 255, 180]),
        width: 2,
        height: 1,
        colorSpace: 'srgb',
      } as ImageData;
      recording.imageDataSource = (): ImageData => image;

      drawFrames(10);

      expect(recording.callsTo('putImageData')).toEqual([[image, 0, 0]]);
      expect([image.data[3], image.data[7]]).toEqual([0, 180]);
    });

    it('waits four times as long between clears on a 4K canvas', (): void => {
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
  });

  describe('FFT size', (): void => {
    it('reads one byte per FFT sample', (): void => {
      viz.draw();

      expect(analyser.timeDomainReads).toEqual([2048]);
    });

    it('resizes its buffer when the FFT size changes', (): void => {
      viz.setFftSize(4096);

      viz.draw();

      expect(analyser.timeDomainReads).toEqual([4096]);
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
      now += 3750; // three quarters of the five second fade-out
      recording.clear();

      viz.draw();

      const overlay: RecordedCall = recording.calls('fillRect')[1];
      expect(overlay.args).toEqual([0, 0, WIDTH, HEIGHT]);
      expect(overlay.state['globalCompositeOperation']).toBe('destination-out');
      expect(overlay.state['fillStyle']).toBe('rgba(0, 0, 0, 0.75)');
    });

    it('becomes idle once the fade-out has completed', (): void => {
      viz.setPlaying(false);
      now += 5000;

      viz.draw();

      expect(viz.isIdle()).toBe(true);
    });
  });

  describe('edge cases', (): void => {
    it('draws nothing and reads no audio while the canvas has no size', (): void => {
      viz.resize(0, 0);
      recording.clear();

      viz.draw();

      expect(recording.operations).toHaveLength(0);
      expect(analyser.timeDomainReads).toHaveLength(0);
    });

    it('still advances the fade-out while the canvas has no size', (): void => {
      viz.resize(0, 0);
      viz.setPlaying(false);
      now += 5000;

      viz.draw();

      expect(viz.isIdle()).toBe(true);
    });

    it.each([
      ['silence', TIME_DOMAIN_SILENCE, WIDTH, HEIGHT],
      ['all-zero samples', 0, WIDTH, HEIGHT],
      ['all-255 samples', BYTE_MAX, WIDTH, HEIGHT],
      ['a one-pixel canvas', BYTE_MAX, 1, 1],
    ])('passes only finite numbers to the canvas for %s', (_label: string, level: number, width: number, height: number): void => {
      analyser.timeDomainData = constantSamples(level);
      viz.resize(width, height);
      recording.clear();

      drawFrames(10);

      expect(recording.callsTo('stroke')).toHaveLength(50);
      expect(recording.nonFiniteOperations()).toEqual([]);
    });
  });
});

/**
 * @fileoverview Unit tests for the Plasma (dual horizontal waveform) visualization.
 *
 * Tests cover:
 * - Both waveforms tracking the time-domain data (silence, full scale, a single spike)
 * - The trail canvases: the outward zoom, the additive composite, and their
 *   creation, resize and release
 * - Hue cycling and the fixed look
 * - FFT size changes, the fade overlay and edge inputs
 *
 * Canvas 2D and Web Audio are faked; see visualization-test-fakes.group3.
 *
 * @module app/components/audio/audio-outlet/visualizations/plasma-visualization.spec
 */

import {PlasmaVisualization} from './plasma-visualization';
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

/** Resting height of the top waveform: 45% of the way down. */
const TOP_Y: number = 270;

/** Resting height of the bottom waveform: 55% of the way down. */
const BOTTOM_Y: number = 330;

/** Number of segments each waveform is divided into; it has one more point than this. */
const SEGMENTS: number = 128;

/** Displacement of a full-scale sample: 15% of the height x the fixed sensitivity factor of 0.6. */
const FULL_SCALE_DISPLACEMENT: number = 54;

describe('PlasmaVisualization', (): void => {
  let fakes: CanvasFakes;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let main: CanvasRecording;
  let top: CanvasRecording;
  let bottom: CanvasRecording;
  let temp: CanvasRecording;
  let viz: PlasmaVisualization;
  let now: number;

  function clearRecordings(): void {
    for (const recording of fakes.recordings) {
      recording.clear();
    }
  }

  /**
   * The points of the waveform stroked on a trail canvas this frame.
   *
   * Each waveform is stroked three times over the same points; the first path
   * is returned. With smoothing fixed at 100% each curve's control point is
   * the waveform point itself, so after the opening moveTo the path lists the
   * waveform points in order.
   */
  function waveformOn(recording: CanvasRecording): RecordedPoint[] {
    return recording.paths()[0].slice(1);
  }

  function drawFrame(): void {
    clearRecordings();
    viz.draw();
  }

  function indexesAwayFrom(points: RecordedPoint[], restY: number): number[] {
    return points.flatMap((point: RecordedPoint, index: number): number[] => (point.y === restY ? [] : [index]));
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
    viz = new PlasmaVisualization({canvas, analyser: analyser.node});
    main = fakes.recordingFor(canvas);
    viz.resize(WIDTH, HEIGHT);
    [, top, bottom, temp] = fakes.recordings;
    viz.setPlaying(true);
  });

  afterEach((): void => {
    fakes.restore();
    vi.restoreAllMocks();
  });

  describe('metadata', (): void => {
    it('identifies itself as Plasma in the Bars & Waves category', (): void => {
      expect(viz.name).toBe('Plasma');
      expect(viz.category).toBe('Bars & Waves');
    });
  });

  describe('trail canvases', (): void => {
    it('creates a top trail, a bottom trail and a working canvas at the canvas size on resize', (): void => {
      expect(fakes.recordings).toHaveLength(4);
      for (const offscreen of [top, bottom, temp]) {
        expect([offscreen.canvas.width, offscreen.canvas.height]).toEqual([WIDTH, HEIGHT]);
      }
    });

    it('creates no offscreen canvases before it has a size', (): void => {
      const unsizedCanvas: HTMLCanvasElement = document.createElement('canvas');
      const before: number = fakes.recordings.length;

      const unsized: PlasmaVisualization = new PlasmaVisualization({canvas: unsizedCanvas, analyser: analyser.node});
      unsized.draw();

      // Only the main canvas's own context was requested.
      expect(fakes.recordings).toHaveLength(before + 1);
    });
  });

  describe('waveforms', (): void => {
    it('draws both waveforms as flat lines at their resting heights for silence', (): void => {
      analyser.timeDomainData = constantSamples(TIME_DOMAIN_SILENCE);

      drawFrame();

      expect(waveformOn(top)).toHaveLength(SEGMENTS + 1);
      expect(waveformOn(bottom)).toHaveLength(SEGMENTS + 1);
      expect(indexesAwayFrom(waveformOn(top), TOP_Y)).toEqual([]);
      expect(indexesAwayFrom(waveformOn(bottom), BOTTOM_Y)).toEqual([]);
    });

    it('spans the full width of the canvas', (): void => {
      drawFrame();

      const points: RecordedPoint[] = waveformOn(top);
      expect(points[0].x).toBe(0);
      expect(points[SEGMENTS / 2].x).toBe(WIDTH / 2);
      expect(points[SEGMENTS].x).toBe(WIDTH);
    });

    it('displaces both waveforms downward by the full amplitude for maximum samples', (): void => {
      analyser.timeDomainData = constantSamples(BYTE_MAX);

      drawFrame();

      // 255 is 127/128 of full scale above the midpoint.
      const displacement: number = FULL_SCALE_DISPLACEMENT * (127 / 128);
      for (const point of waveformOn(top)) {
        expect(point.y).toBeCloseTo(TOP_Y + displacement, 6);
      }
      for (const point of waveformOn(bottom)) {
        expect(point.y).toBeCloseTo(BOTTOM_Y + displacement, 6);
      }
    });

    it('displaces both waveforms upward by the full amplitude for minimum samples', (): void => {
      analyser.timeDomainData = constantSamples(0);

      drawFrame();

      for (const point of waveformOn(top)) {
        expect(point.y).toBeCloseTo(TOP_Y - FULL_SCALE_DISPLACEMENT, 6);
      }
      for (const point of waveformOn(bottom)) {
        expect(point.y).toBeCloseTo(BOTTOM_Y - FULL_SCALE_DISPLACEMENT, 6);
      }
    });

    it('moves only the top-waveform points that sample a single spike', (): void => {
      // Point 32 of 128 reads the sample a quarter of the way through the 2048-sample buffer.
      analyser.timeDomainData = spikeSamples(512, 513, BYTE_MAX, TIME_DOMAIN_SILENCE);

      drawFrame();

      expect(indexesAwayFrom(waveformOn(top), TOP_Y)).toEqual([32]);
    });

    it('reads the bottom waveform half a buffer out of step with the top', (): void => {
      analyser.timeDomainData = spikeSamples(512, 513, BYTE_MAX, TIME_DOMAIN_SILENCE);

      drawFrame();

      // The same sample lands 64 points later on the bottom waveform.
      expect(indexesAwayFrom(waveformOn(bottom), BOTTOM_Y)).toEqual([96]);
    });

    it('closes the loop by reading the first sample again for the last point', (): void => {
      analyser.timeDomainData = spikeSamples(0, 1, BYTE_MAX, TIME_DOMAIN_SILENCE);

      drawFrame();

      expect(indexesAwayFrom(waveformOn(top), TOP_Y)).toEqual([0, SEGMENTS]);
    });

    it('strokes each waveform as a glow, a main line and a white highlight', (): void => {
      drawFrame();

      const strokes: readonly RecordedCall[] = top.calls('stroke');
      expect(strokes.map((stroke: RecordedCall): unknown => stroke.state['strokeStyle'])).toEqual([
        'rgba(2, 0, 255, 0.30)',
        'rgb(2, 0, 255)',
        'rgba(255, 255, 255, 0.5)',
      ]);
      expect(strokes.map((stroke: RecordedCall): unknown => stroke.state['lineWidth'])).toEqual([5, 1, 1]);
    });

    it('blurs only the glow layer', (): void => {
      drawFrame();

      const strokes: readonly RecordedCall[] = top.calls('stroke');
      expect(strokes.map((stroke: RecordedCall): unknown => stroke.state['shadowBlur'])).toEqual([15, 0, 0]);
    });
  });

  describe('colour cycling', (): void => {
    it('starts the top waveform blue and the bottom waveform green', (): void => {
      drawFrame();

      expect(top.calls('stroke')[1].state['strokeStyle']).toBe('rgb(2, 0, 255)');
      expect(bottom.calls('stroke')[1].state['strokeStyle']).toBe('rgb(0, 255, 2)');
    });

    it('has cycled the top waveform round to red after 240 frames', (): void => {
      for (let i: number = 0; i < 239; i++) {
        viz.draw();
      }

      drawFrame();

      // Half a degree per frame: 120 degrees on from blue.
      expect(top.calls('stroke')[1].state['strokeStyle']).toBe('rgb(255, 0, 0)');
    });
  });

  describe('trail zoom', (): void => {
    it('copies each trail to the working canvas before redrawing it', (): void => {
      drawFrame();

      expect(temp.callsTo('drawImage')).toEqual([
        [top.canvas, 0, 0],
        [bottom.canvas, 0, 0],
      ]);
      expect(temp.callsTo('clearRect')).toEqual([
        [0, 0, WIDTH, HEIGHT],
        [0, 0, WIDTH, HEIGHT],
      ]);
    });

    it('redraws each trail enlarged by 2% about the centre of the canvas', (): void => {
      drawFrame();

      for (const trail of [top, bottom]) {
        expect(trail.callsTo('translate')).toEqual([
          [WIDTH / 2, HEIGHT / 2],
          [-WIDTH / 2, -HEIGHT / 2],
        ]);
        expect(trail.callsTo('scale')).toEqual([[1.02, 1.02]]);
        expect(trail.callsTo('drawImage')).toEqual([[temp.canvas, 0, 0]]);
      }
    });

    it('dims the redrawn trail by the fade rate', (): void => {
      drawFrame();

      expect(top.calls('drawImage')[0].state['globalAlpha']).toBeCloseTo(0.975, 10);
    });

    it('strokes the new waveform at full opacity over the dimmed trail', (): void => {
      drawFrame();

      for (const stroke of top.calls('stroke')) {
        expect(stroke.state['globalAlpha']).toBe(1);
      }
    });
  });

  describe('composite', (): void => {
    it('clears the main canvas and draws the top trail then the bottom trail', (): void => {
      drawFrame();

      expect(main.callsTo('clearRect')).toEqual([[0, 0, WIDTH, HEIGHT]]);
      expect(main.callsTo('drawImage')).toEqual([
        [top.canvas, 0, 0],
        [bottom.canvas, 0, 0],
      ]);
    });

    it('adds the bottom trail to the top one so that overlaps brighten', (): void => {
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

      for (const offscreen of [top, bottom, temp]) {
        expect([offscreen.canvas.width, offscreen.canvas.height]).toEqual([400, 300]);
      }
    });

    it('carries each trail over to the new size', (): void => {
      viz.draw();
      clearRecordings();

      viz.resize(400, 300);

      for (const trail of [top, bottom]) {
        const scaledCopy: readonly unknown[] = trail.callsTo('drawImage')[0];
        expect(scaledCopy.slice(1)).toEqual([0, 0, WIDTH, HEIGHT, 0, 0, 400, 300]);
      }
    });

    it('clears the main canvas at the new size', (): void => {
      clearRecordings();

      viz.resize(400, 300);

      expect(main.callsTo('clearRect')).toEqual([[0, 0, 400, 300]]);
    });

    it('lays the waveforms out for the new size', (): void => {
      viz.resize(400, 300);

      drawFrame();

      const points: RecordedPoint[] = waveformOn(top);
      expect(points[SEGMENTS].x).toBe(400);
      expect(points[0].y).toBe(135);
      expect(waveformOn(bottom)[0].y).toBeCloseTo(165, 6);
    });

    it('zooms about the new centre', (): void => {
      viz.resize(400, 300);

      drawFrame();

      expect(top.callsTo('translate')[0]).toEqual([200, 150]);
    });

    it('scales the waveform amplitude with the new height', (): void => {
      analyser.timeDomainData = constantSamples(0);
      viz.resize(WIDTH, HEIGHT * 2);

      drawFrame();

      expect(waveformOn(top)[0].y).toBeCloseTo(TOP_Y * 2 - FULL_SCALE_DISPLACEMENT * 2, 6);
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

      expect(viz.getSensitivity()).toBe(0.3);
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
      viz.setFftSize(256);

      viz.draw();

      expect(analyser.timeDomainReads).toEqual([256]);
    });

    it('still maps a spike to the same point after the FFT size changes', (): void => {
      viz.setFftSize(256);
      // A quarter of the way through the smaller buffer.
      analyser.timeDomainData = spikeSamples(64, 65, BYTE_MAX, TIME_DOMAIN_SILENCE);

      drawFrame();

      expect(indexesAwayFrom(waveformOn(top), TOP_Y)).toEqual([32]);
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
      expect(drawn).not.toContain(top.canvas);
      expect(drawn).not.toContain(bottom.canvas);
      expect(top.operations).toHaveLength(0);
      expect(bottom.operations).toHaveLength(0);
      expect(temp.operations).toHaveLength(0);
    });

    it('builds fresh trail canvases if it is drawn again', (): void => {
      viz.destroy();

      viz.draw();

      const [newTop, newBottom]: CanvasRecording[] = fakes.recordings.slice(4);
      expect(fakes.recordings).toHaveLength(7);
      expect(main.callsTo('drawImage')).toEqual([
        [newTop.canvas, 0, 0],
        [newBottom.canvas, 0, 0],
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

      expect(top.callsTo('stroke')).toHaveLength(15);
      expect(allNonFiniteOperations()).toEqual([]);
    });

    it('passes only finite numbers to any canvas when resized down to nothing and back', (): void => {
      viz.draw();
      clearRecordings();

      viz.resize(0, 0);
      viz.resize(WIDTH, HEIGHT);
      viz.draw();

      expect(top.callsTo('stroke')).toHaveLength(3);
      expect(allNonFiniteOperations()).toEqual([]);
    });
  });
});

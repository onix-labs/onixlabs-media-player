/**
 * @fileoverview Unit tests for the Analyzer (frequency bars) visualization.
 *
 * Tests cover:
 * - Bar heights tracking the frequency data (silence, full scale, bass-heavy, a single spike)
 * - Bar layout across the canvas and the three bar densities
 * - The fixed sensitivity
 * - The bar gradient and its rebuild on colour change and resize
 * - FFT size changes, the fade overlay, and degenerate canvas sizes
 *
 * Canvas 2D and Web Audio are faked; see visualization-test-fakes.group3.
 *
 * @module app/components/audio/audio-outlet/visualizations/analyzer-visualization.spec
 */

import {AnalyzerVisualization} from './analyzer-visualization';
import {Visualization} from './visualization';
import {
  BYTE_MAX,
  CanvasFakes,
  CanvasRecording,
  FakeAnalyser,
  FakeGradient,
  RecordedCall,
  RecordedPoint,
  bassHeavySpectrum,
  constantSamples,
  createFakeAnalyser,
  installCanvasFakes,
  spikeSamples,
} from './visualization-test-fakes.group3';

const WIDTH: number = 960;
const HEIGHT: number = 400;

/** Bar height at full scale: canvas height x 0.85 x the fixed sensitivity factor of 1. */
const FULL_SCALE_BAR_HEIGHT: number = 340;

describe('AnalyzerVisualization', (): void => {
  let fakes: CanvasFakes;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let recording: CanvasRecording;
  let viz: AnalyzerVisualization;
  let now: number;

  /** Draws one frame from a clean recording and returns the top edge (y) of each bar. */
  function drawBarTops(): number[] {
    recording.clear();
    viz.draw();
    return recording.paths().map((path: RecordedPoint[]): number => path[0].y);
  }

  beforeEach((): void => {
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation((): number => now);
    fakes = installCanvasFakes();
    analyser = createFakeAnalyser();
    canvas = document.createElement('canvas');
    viz = new AnalyzerVisualization({canvas, analyser: analyser.node});
    recording = fakes.recordingFor(canvas);
    viz.resize(WIDTH, HEIGHT);
    viz.setPlaying(true);
  });

  afterEach((): void => {
    fakes.restore();
    vi.restoreAllMocks();
  });

  describe('metadata', (): void => {
    it('identifies itself as Analyzer in the Bars & Waves category', (): void => {
      expect(viz.name).toBe('Analyzer');
      expect(viz.category).toBe('Bars & Waves');
    });
  });

  describe('bar heights', (): void => {
    it('draws every bar flat on the baseline for a silent spectrum', (): void => {
      analyser.frequencyData = constantSamples(0);

      const tops: number[] = drawBarTops();

      expect(tops).toHaveLength(96);
      expect(tops.every((y: number): boolean => y === HEIGHT)).toBe(true);
    });

    it('draws every bar at 85% of the canvas height for a full-scale spectrum', (): void => {
      analyser.frequencyData = constantSamples(BYTE_MAX);

      const tops: number[] = drawBarTops();

      expect(tops).toHaveLength(96);
      for (const y of tops) {
        expect(y).toBeCloseTo(HEIGHT - FULL_SCALE_BAR_HEIGHT, 6);
      }
    });

    it('scales bar height linearly with the bin level', (): void => {
      analyser.frequencyData = constantSamples(51); // 20% of full scale

      const tops: number[] = drawBarTops();

      expect(tops[0]).toBeCloseTo(HEIGHT - FULL_SCALE_BAR_HEIGHT * 0.2, 6);
    });

    it('draws taller bars on the left than on the right for a bass-heavy spectrum', (): void => {
      analyser.frequencyData = bassHeavySpectrum();

      const tops: number[] = drawBarTops();

      for (let i: number = 1; i < tops.length; i++) {
        expect(tops[i]).toBeGreaterThan(tops[i - 1]);
      }
    });

    it('raises only the bar whose bins contain a single spike', (): void => {
      // 1024 bins, the lower 768 shown across 96 bars: 8 bins per bar, so bin 80 belongs to bar 10.
      analyser.frequencyData = spikeSamples(80, 81, BYTE_MAX, 0);

      const tops: number[] = drawBarTops();

      const raised: number[] = tops.flatMap((y: number, index: number): number[] => (y < HEIGHT ? [index] : []));
      expect(raised).toEqual([10]);
    });

    it('averages the bins that share a bar', (): void => {
      // One full-scale bin out of the eight in the bar: an eighth of the full height.
      analyser.frequencyData = spikeSamples(80, 81, BYTE_MAX, 0);

      const tops: number[] = drawBarTops();

      expect(tops[10]).toBeCloseTo(HEIGHT - FULL_SCALE_BAR_HEIGHT / 8, 6);
    });

    it('ignores the top quarter of the spectrum', (): void => {
      // Bins 768 and above are outside the displayed range.
      analyser.frequencyData = spikeSamples(768, 1024, BYTE_MAX, 0);

      const tops: number[] = drawBarTops();

      expect(tops.every((y: number): boolean => y === HEIGHT)).toBe(true);
    });
  });

  describe('bar layout', (): void => {
    it('starts the first bar at the left edge and ends the last bar at the right edge', (): void => {
      analyser.frequencyData = constantSamples(BYTE_MAX);
      recording.clear();

      viz.draw();

      // Each bar's path: top-left (inset by the corner radius), top-right, down the right side, ...
      const paths: RecordedPoint[][] = recording.paths();
      const cornerRadius: number = 4;
      const lastBarRightEdge: number = Math.max(...paths[paths.length - 1].map((point: RecordedPoint): number => point.x));
      expect(paths[0][0].x).toBeCloseTo(cornerRadius, 6);
      expect(lastBarRightEdge).toBeCloseTo(WIDTH, 6);
    });

    it('separates neighbouring bars by a two pixel gap', (): void => {
      recording.clear();

      viz.draw();

      const paths: RecordedPoint[][] = recording.paths();
      const firstBarRightEdge: number = Math.max(...paths[0].map((point: RecordedPoint): number => point.x));
      const secondBarLeftEdge: number = Math.min(...paths[1].map((point: RecordedPoint): number => point.x));
      expect(secondBarLeftEdge - firstBarRightEdge).toBeCloseTo(2, 6);
    });

    it('extends every bar down to the bottom of the canvas', (): void => {
      analyser.frequencyData = constantSamples(BYTE_MAX);
      recording.clear();

      viz.draw();

      for (const path of recording.paths()) {
        expect(Math.max(...path.map((point: RecordedPoint): number => point.y))).toBe(HEIGHT);
      }
    });

    it('clears the whole canvas before drawing the bars', (): void => {
      recording.clear();

      viz.draw();

      const firstCall: RecordedCall | undefined = recording.operations.find(
        (operation): operation is RecordedCall => operation.kind === 'call'
      );
      expect(firstCall?.method).toBe('clearRect');
      expect(firstCall?.args).toEqual([0, 0, WIDTH, HEIGHT]);
    });
  });

  describe('bar density', (): void => {
    it('draws 96 bars at the default medium density', (): void => {
      expect(drawBarTops()).toHaveLength(96);
    });

    it('draws 48 bars at low density', (): void => {
      viz.setBarDensity('low');

      expect(drawBarTops()).toHaveLength(48);
    });

    it('draws 144 bars at high density', (): void => {
      viz.setBarDensity('high');

      expect(drawBarTops()).toHaveLength(144);
    });

    it('fills the full width at every density', (): void => {
      for (const density of ['low', 'medium', 'high'] as const) {
        viz.setBarDensity(density);
        recording.clear();

        viz.draw();

        const paths: RecordedPoint[][] = recording.paths();
        const rightEdge: number = Math.max(...paths[paths.length - 1].map((point: RecordedPoint): number => point.x));
        expect(rightEdge).toBeCloseTo(WIDTH, 6);
      }
    });
  });

  describe('sensitivity', (): void => {
    it('is fixed at 50%', (): void => {
      expect(viz.getSensitivity()).toBe(0.5);
    });

    it('ignores the global sensitivity control', (): void => {
      analyser.frequencyData = constantSamples(BYTE_MAX);
      const before: number[] = drawBarTops();

      // Through the base type, as the outlet calls it: the override takes no argument.
      const controlled: Visualization = viz;
      controlled.setSensitivity(1);

      expect(viz.getSensitivity()).toBe(0.5);
      expect(drawBarTops()).toEqual(before);
    });
  });

  describe('gradient', (): void => {
    it('fills the bars with a bottom-to-top gradient of the three bar colours', (): void => {
      recording.clear();

      viz.draw();

      const fillStyle: unknown = recording.calls('fill')[0].state['fillStyle'];
      expect(fillStyle).toBeInstanceOf(FakeGradient);
      const gradient: FakeGradient = fillStyle as FakeGradient;
      expect(gradient.args).toEqual([0, HEIGHT, 0, 0]);
      expect(gradient.stops).toEqual([
        {offset: 0, color: '#00cc00'},
        {offset: 0.5, color: '#cccc00'},
        {offset: 1, color: '#cc0000'},
      ]);
    });

    it('reuses the same gradient from frame to frame', (): void => {
      viz.draw();
      recording.clear();

      viz.draw();

      expect(recording.gradients).toHaveLength(0);
    });

    it('rebuilds the gradient when a bar colour changes', (): void => {
      viz.setBarColorBottom('#000011');
      viz.setBarColorMiddle('#000022');
      viz.setBarColorTop('#000033');
      recording.clear();

      viz.draw();

      const gradient: FakeGradient = recording.calls('fill')[0].state['fillStyle'] as FakeGradient;
      expect(gradient.stops.map((stop): string => stop.color)).toEqual(['#000011', '#000022', '#000033']);
    });

    it('rebuilds the gradient to span the new height after a resize', (): void => {
      viz.resize(WIDTH, 800);
      recording.clear();

      viz.draw();

      const gradient: FakeGradient = recording.calls('fill')[0].state['fillStyle'] as FakeGradient;
      expect(gradient.args).toEqual([0, 800, 0, 0]);
    });

    it('does not create a gradient while the canvas has no height', (): void => {
      viz.resize(WIDTH, 0);
      recording.clear();

      viz.setBarColorTop('#123456');

      expect(recording.gradients).toHaveLength(0);
    });
  });

  describe('FFT size', (): void => {
    it('reads one byte per frequency bin', (): void => {
      viz.draw();

      expect(analyser.frequencyReads).toEqual([1024]);
    });

    it('resizes its buffer to the new bin count when the FFT size changes', (): void => {
      viz.setFftSize(512);

      viz.draw();

      expect(analyser.frequencyReads).toEqual([256]);
    });

    it('still spreads the displayed range across every bar after the FFT size changes', (): void => {
      viz.setFftSize(512);
      analyser.frequencyData = constantSamples(BYTE_MAX);

      const tops: number[] = drawBarTops();

      expect(tops).toHaveLength(96);
      for (const y of tops) {
        expect(y).toBeCloseTo(HEIGHT - FULL_SCALE_BAR_HEIGHT, 6);
      }
    });
  });

  describe('fade', (): void => {
    it('draws no fade overlay while playing', (): void => {
      recording.clear();

      viz.draw();

      expect(recording.callsTo('fillRect')).toHaveLength(0);
    });

    it('fades the frame out in proportion to the time since playback stopped', (): void => {
      viz.setPlaying(false);
      now += 2500; // half of the five second fade-out
      recording.clear();

      viz.draw();

      const overlay: RecordedCall = recording.calls('fillRect')[0];
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

  describe('edge cases', (): void => {
    it('draws nothing while the canvas has no size', (): void => {
      viz.resize(0, 0);
      recording.clear();

      viz.draw();

      expect(recording.operations).toHaveLength(0);
      expect(analyser.frequencyReads).toHaveLength(0);
    });

    it.each([
      ['a silent spectrum', 0, WIDTH, HEIGHT],
      ['a full-scale spectrum', BYTE_MAX, WIDTH, HEIGHT],
      ['a canvas narrower than its bar gaps', BYTE_MAX, 1, 1],
    ])('passes only finite numbers to the canvas for %s', (_label: string, level: number, width: number, height: number): void => {
      analyser.frequencyData = constantSamples(level);
      viz.resize(width, height);
      recording.clear();

      viz.draw();

      expect(recording.callsTo('fill').length).toBeGreaterThan(0);
      expect(recording.nonFiniteOperations()).toEqual([]);
    });
  });
});

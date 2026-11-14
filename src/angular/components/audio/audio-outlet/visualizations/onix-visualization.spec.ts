/**
 * @fileoverview Unit tests for the Onix visualization.
 *
 * Tests cover:
 * - Waveform circle: radius, amplitude response, seam cross-fade, layers
 * - Bass circle: which bins drive it, attack and release, size cap, fade-in
 * - Trail feedback: ring decomposition, fade, zoom, shear
 * - Trail pixel budget: reduced trail surface and the sharp redraw above it
 * - Bloom, compositing, resize, destroy
 * - Fade-out when playback stops, and idling once fully faded
 * - Edge inputs: extreme spectra and waveforms, a one-pixel canvas
 *
 * Canvas 2D, the analyser and the clock are faked; see
 * visualization-test-fakes.group2.
 *
 * @module app/components/audio/audio-outlet/visualizations/onix-visualization.spec
 */

import {OnixVisualization} from './onix-visualization';
import type {Visualization} from './visualization';
import {
  BASS_HEAVY_SPECTRUM,
  FULL_SPECTRUM,
  FakeAnalyser,
  FakeContext2D,
  LOUD_WAVEFORM,
  SILENT_SPECTRUM,
  SILENT_WAVEFORM,
  flat,
  installCanvasFakes,
  installFakeClock,
  spike,
} from './visualization-test-fakes.group2';
import type {AnalyserFill, CanvasFakes, FakeClock, FakeGradient, RecordedCall} from './visualization-test-fakes.group2';

// ============================================================================
// Helpers
// ============================================================================

const WIDTH: number = 800;
const HEIGHT: number = 600;
const CENTRE_X: number = WIDTH / 2;
const CENTRE_Y: number = HEIGHT / 2;

/** Waveform circle radius at 800x600: 30% of the shorter side. */
const BASE_RADIUS: number = 180;

/** Waveform deflection at 800x600 for a full-scale sample: 8% of the height x sensitivity factor 0.8. */
const FULL_DEFLECTION: number = 600 * 0.08 * 0.8;

/** Largest the bass circle can get at 800x600: a third of the base radius x sensitivity 0.4 x 3. */
const MAX_BASS_RADIUS: number = (BASE_RADIUS / 3) * 1.2;

/** Points sampled around the waveform circle. */
const CIRCLE_POINTS: number = 128;

/** Concentric rings the trail is redrawn in, plus the partial one at the edge. */
const TRAIL_RINGS: number = 33;

const TWO_PI: number = Math.PI * 2;

/**
 * Distances from the screen centre of the waveform circle's points, for the
 * first circle path built on a context. With smoothing at 100% the control
 * point of each curve segment is the waveform point itself.
 */
function circleRadii(ctx: FakeContext2D, centreX: number = CENTRE_X, centreY: number = CENTRE_Y): number[] {
  return ctx.callsTo('quadraticCurveTo')
    .slice(0, CIRCLE_POINTS)
    .map((call: RecordedCall): number =>
      Math.hypot((call.args[0] as number) - centreX, (call.args[1] as number) - centreY));
}

// ============================================================================
// Tests
// ============================================================================

describe('OnixVisualization', (): void => {
  let fakes: CanvasFakes;
  let clock: FakeClock;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let viz: OnixVisualization;
  let main: FakeContext2D;

  /** The off-screen contexts, in the order onResize creates them. */
  const trail = (): FakeContext2D => fakes.contexts[1];
  const temp = (): FakeContext2D => fakes.contexts[2];
  const bloom = (): FakeContext2D => fakes.contexts[3];

  function drawFrames(count: number): void {
    for (let i: number = 0; i < count; i++) viz.draw();
  }

  function clearRecordings(): void {
    for (const ctx of fakes.contexts) ctx.clear();
  }

  /** Draws one frame and returns the bass circle's radius, or null if none was drawn. */
  function bassRadiusInNextFrame(): number | null {
    main.clear();
    viz.draw();
    const arcs: RecordedCall[] = main.callsTo('arc');
    return arcs.length === 0 ? null : arcs[0].args[2] as number;
  }

  beforeEach((): void => {
    clock = installFakeClock();
    fakes = installCanvasFakes();
    analyser = new FakeAnalyser();
    canvas = document.createElement('canvas');
    viz = new OnixVisualization({canvas, analyser: analyser.node});
    main = fakes.contextFor(canvas);
  });

  afterEach((): void => {
    fakes.restore();
    clock.restore();
    vi.restoreAllMocks();
  });

  describe('construction', (): void => {
    it('identifies itself as Onix in the Bars & Waves category', (): void => {
      expect(viz.name).toBe('Onix');
      expect(viz.category).toBe('Bars & Waves');
    });

    it('ignores the global look controls because its look is fixed', (): void => {
      const base: Visualization = viz;

      base.setSensitivity(1);
      base.setTrailIntensity(1);
      base.setLineWidth(5);
      base.setGlowIntensity(1);
      base.setWaveformSmoothing(0);

      expect(viz.getSensitivity()).toBe(0.4);
      expect(viz.getTrailIntensity()).toBe(0.1);
      expect(viz.getLineWidth()).toBe(1);
      expect(viz.getGlowIntensity()).toBe(0);
      expect(viz.getWaveformSmoothing()).toBe(1);
    });
  });

  describe('resize', (): void => {
    it('creates a trail, a working copy and a bloom surface', (): void => {
      viz.resize(WIDTH, HEIGHT);

      expect(fakes.contexts).toHaveLength(4);
    });

    it('sizes the trail and its working copy to the view when within the pixel budget', (): void => {
      viz.resize(WIDTH, HEIGHT);

      for (const ctx of [trail(), temp()]) {
        expect(ctx.canvas.width).toBe(WIDTH);
        expect(ctx.canvas.height).toBe(HEIGHT);
      }
      expect(trail().callsTo('setTransform')[0].args).toEqual([1, 0, 0, 1, 0, 0]);
    });

    it('holds the trail to the pixel budget on a larger view', (): void => {
      viz.resize(3840, 2160);

      for (const ctx of [trail(), temp()]) {
        expect(ctx.canvas.width).toBe(1280);
        expect(ctx.canvas.height).toBe(720);
      }
    });

    it('maps view coordinates onto the reduced trail', (): void => {
      viz.resize(3840, 2160);

      const transform: readonly unknown[] = trail().callsTo('setTransform')[0].args;
      expect(transform[0]).toBeCloseTo(1 / 3, 10);
      expect(transform[3]).toBeCloseTo(1 / 3, 10);
    });

    it('clears the main canvas', (): void => {
      viz.resize(WIDTH, HEIGHT);

      expect(main.callsTo('clearRect')[0].args).toEqual([0, 0, WIDTH, HEIGHT]);
    });

    it('keeps the same trail canvas and rescales its content to the new size', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.draw();
      const trailCanvas: HTMLCanvasElement = trail().canvas;
      clearRecordings();

      viz.resize(400, 300);

      expect(trail().canvas).toBe(trailCanvas);
      expect(trailCanvas.width).toBe(400);
      expect(trailCanvas.height).toBe(300);
      expect(trail().callsTo('drawImage')[0].args.slice(1)).toEqual([0, 0, WIDTH, HEIGHT, 0, 0, 400, 300]);
    });

    it('reapplies the trail transform after resizing, since resizing resets it', (): void => {
      viz.resize(WIDTH, HEIGHT);
      clearRecordings();

      viz.resize(3840, 2160);

      const names: string[] = trail().calls.map((call: RecordedCall): string => call.name);
      expect(names).toContain('setTransform');
    });

    it('re-centres and rescales the waveform circle for the new size', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.resize(400, 300);
      clearRecordings();

      viz.draw();

      for (const radius of circleRadii(trail(), 200, 150)) {
        expect(radius).toBeCloseTo(90, 4);
      }
    });
  });

  describe('waveform circle', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
      clearRecordings();
    });

    it('draws a silent waveform as a circle at the base radius', (): void => {
      viz.draw();

      const radii: number[] = circleRadii(trail());
      expect(radii).toHaveLength(CIRCLE_POINTS);
      for (const radius of radii) {
        expect(radius).toBeCloseTo(BASE_RADIUS, 4);
      }
    });

    it('pushes the circle outward for positive samples', (): void => {
      analyser.waveform = LOUD_WAVEFORM;

      viz.draw();

      for (const radius of circleRadii(trail())) {
        expect(radius).toBeCloseTo(BASE_RADIUS + (127 / 128) * FULL_DEFLECTION, 4);
      }
    });

    it('pulls the circle inward for negative samples', (): void => {
      analyser.waveform = flat(0);

      viz.draw();

      for (const radius of circleRadii(trail())) {
        expect(radius).toBeCloseTo(BASE_RADIUS - FULL_DEFLECTION, 4);
      }
    });

    it('blends the end of the circle toward its first sample so the seam closes', (): void => {
      // Only the very first sample is deflected; every other point reads silence.
      analyser.waveform = spike(0, 255, 128);

      viz.draw();

      const radii: number[] = circleRadii(trail());
      const first: number = (127 / 128) * FULL_DEFLECTION;
      expect(radii[0]).toBeCloseTo(BASE_RADIUS + first, 4);
      expect(radii[108]).toBeCloseTo(BASE_RADIUS, 4);
      expect(radii[118]).toBeCloseTo(BASE_RADIUS + first * 0.5, 4);
      expect(radii[127]).toBeCloseTo(BASE_RADIUS + first * 0.95, 4);
    });

    it('strokes the circle as a wide glow, a brand-gradient core and a white filament', (): void => {
      viz.draw();

      const strokes: RecordedCall[] = trail().callsTo('stroke');
      expect(strokes.map((call: RecordedCall): unknown => call.state['lineWidth'])).toEqual([4, 1, 1]);
      expect((strokes[1].state['strokeStyle'] as FakeGradient).kind).toBe('createConicGradient');
      expect(strokes[2].state['strokeStyle']).toBe('rgba(255, 255, 255, 0.5)');
    });

    it('closes the brand gradient on the colour it starts with', (): void => {
      viz.draw();

      const gradient: FakeGradient = trail().callsTo('stroke')[1].state['strokeStyle'] as FakeGradient;
      expect(gradient.args).toEqual([0, CENTRE_X, CENTRE_Y]);
      expect(gradient.stops).toHaveLength(9);
      expect(gradient.stops[0]).toEqual({offset: 0, color: 'rgb(247, 149, 51)'});
      expect(gradient.stops[8]).toEqual({offset: 1, color: 'rgb(247, 149, 51)'});
    });

    it('turns the circle a little further each frame', (): void => {
      drawFrames(9);
      clearRecordings();

      viz.draw();

      // The last rotation on the trail is the circle's own; the rest are the rings'.
      const rotations: RecordedCall[] = trail().callsTo('rotate');
      expect(rotations[rotations.length - 1].args[0]).toBeCloseTo(-10 * 0.0125, 10);
    });
  });

  describe('bass circle', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.setPlaying(true);
      clearRecordings();
    });

    it('is absent in silence', (): void => {
      drawFrames(10);

      expect(main.callsTo('arc')).toEqual([]);
      expect(main.callsTo('createRadialGradient')).toEqual([]);
    });

    it('appears at the centre when the bass bins carry energy', (): void => {
      analyser.spectrum = BASS_HEAVY_SPECTRUM;

      viz.draw();

      // One frame of attack takes the envelope to 0.55 of full.
      const arc: RecordedCall = main.callsTo('arc')[0];
      expect(arc.args.slice(0, 2)).toEqual([CENTRE_X, CENTRE_Y]);
      expect(arc.args[2]).toBeCloseTo(0.55 * MAX_BASS_RADIUS, 6);
    });

    it('ignores energy above the kick-drum bins', (): void => {
      analyser.spectrum = (index: number): number => index >= 8 ? 255 : 0;

      drawFrames(10);

      expect(main.callsTo('arc')).toEqual([]);
    });

    it('ignores the DC bin', (): void => {
      analyser.spectrum = spike(0);

      drawFrames(10);

      expect(main.callsTo('arc')).toEqual([]);
    });

    it('rises quickly toward the level of a sustained kick', (): void => {
      analyser.spectrum = BASS_HEAVY_SPECTRUM;

      const first: number | null = bassRadiusInNextFrame();
      const second: number | null = bassRadiusInNextFrame();

      expect(first).toBeCloseTo(0.55 * MAX_BASS_RADIUS, 6);
      expect(second).toBeCloseTo((0.55 + 0.45 * 0.55) * MAX_BASS_RADIUS, 6);
    });

    it('never grows beyond a third of the waveform circle scaled by sensitivity', (): void => {
      analyser.spectrum = FULL_SPECTRUM;
      const radii: number[] = [];

      for (let i: number = 0; i < 60; i++) {
        radii.push(bassRadiusInNextFrame() ?? 0);
      }

      expect(Math.max(...radii)).toBeLessThan(MAX_BASS_RADIUS + 1e-9);
      expect(radii[radii.length - 1]).toBeCloseTo(MAX_BASS_RADIUS, 6);
    });

    it('decays slowly after the kick has gone rather than vanishing', (): void => {
      analyser.spectrum = BASS_HEAVY_SPECTRUM;
      const peak: number | null = bassRadiusInNextFrame();
      analyser.spectrum = SILENT_SPECTRUM;

      const after: number | null = bassRadiusInNextFrame();

      expect(after).toBeCloseTo((peak ?? 0) * 0.93, 6);
    });

    it('is not drawn while smaller than half a pixel', (): void => {
      // A faint single bin: 20/255 across seven bins, one frame of attack.
      analyser.spectrum = spike(4, 20);

      viz.draw();

      expect(main.callsTo('arc')).toEqual([]);
    });

    it('fades in while still small instead of popping on at full strength', (): void => {
      // One full bin of seven: radius about 5.7px, inside the 6px fade-in.
      analyser.spectrum = spike(4);

      viz.draw();

      const radius: number = main.callsTo('arc')[0].args[2] as number;
      const gradient: FakeGradient = main.gradients('createRadialGradient')[0];
      expect(radius).toBeLessThan(6);
      expect(gradient.stops[0].color).toBe(`rgba(255, 255, 255, ${radius / 6})`);
    });

    it('fills with a white core that falls off toward the edge', (): void => {
      analyser.spectrum = BASS_HEAVY_SPECTRUM;

      viz.draw();

      const gradient: FakeGradient = main.gradients('createRadialGradient')[0];
      expect(gradient.args).toEqual([CENTRE_X, CENTRE_Y, 0, CENTRE_X, CENTRE_Y, main.callsTo('arc')[0].args[2]]);
      expect(gradient.stops).toEqual([
        {offset: 0, color: 'rgba(255, 255, 255, 1)'},
        {offset: 0.55, color: 'rgba(255, 255, 255, 1)'},
        {offset: 1, color: 'rgba(255, 255, 255, 0.3)'},
      ]);
      expect(main.callsTo('fill')[0].state['fillStyle']).toBe(gradient);
    });

    it('is drawn over the trails rather than into them', (): void => {
      analyser.spectrum = BASS_HEAVY_SPECTRUM;

      viz.draw();

      const names: string[] = main.calls.map((call: RecordedCall): string => call.name);
      expect(names.indexOf('arc')).toBeGreaterThan(names.lastIndexOf('drawImage'));
      expect(trail().callsTo('createRadialGradient')).toEqual([]);
    });
  });

  describe('trail feedback', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
      clearRecordings();
    });

    it('copies the previous trail aside before redrawing it', (): void => {
      viz.draw();

      const copy: RecordedCall = temp().callsTo('drawImage')[0];
      expect(copy.args).toEqual([trail().canvas, 0, 0]);
      expect(copy.state['globalCompositeOperation']).toBe('copy');
    });

    it('redraws the previous trail once per ring, faded', (): void => {
      viz.draw();

      const redraws: RecordedCall[] = trail().callsTo('drawImage');
      const expectedAlpha: number = 1 - 0.025 * Math.pow(Math.pow(2, 0.8), 0.005);
      expect(redraws).toHaveLength(TRAIL_RINGS);
      for (const redraw of redraws) {
        expect(redraw.args).toEqual([temp().canvas, 0, 0, WIDTH, HEIGHT]);
        expect(redraw.state['globalAlpha']).toBeCloseTo(expectedAlpha, 10);
      }
    });

    it('clips each ring so the rings tile out to the corners', (): void => {
      viz.draw();

      // Each ring is clipped by an outer arc, followed by an inner one for all but the first.
      const outers: number[] = trail().callsTo('arc')
        .filter((arc: RecordedCall): boolean => arc.args.length === 5)
        .map((arc: RecordedCall): number => arc.args[2] as number);
      expect(trail().callsTo('clip')).toHaveLength(TRAIL_RINGS);
      expect(outers[outers.length - 1]).toBeCloseTo(Math.hypot(CENTRE_X, CENTRE_Y), 6);
      expect([...outers].sort((a: number, b: number): number => a - b)).toEqual(outers);
    });

    it('zooms every ring outward', (): void => {
      viz.draw();

      for (const scale of trail().callsTo('scale')) {
        expect(scale.args[0]).toBeGreaterThan(1);
        expect(scale.args[1]).toBe(scale.args[0]);
      }
    });

    it('turns outer rings faster than inner ones, so the trail shears', (): void => {
      viz.draw();

      const spins: number[] = trail().callsTo('rotate')
        .slice(0, TRAIL_RINGS)
        .map((call: RecordedCall): number => call.args[0] as number);
      expect(spins[0]).toBeGreaterThanOrEqual(0.005);
      expect(spins[TRAIL_RINGS - 1]).toBeLessThanOrEqual(0.005 + 0.0125);
      for (let i: number = 1; i < spins.length; i++) {
        expect(spins[i]).toBeGreaterThan(spins[i - 1]);
      }
    });

    it('slides the ring boundaries between frames so seams do not bake in', (): void => {
      viz.draw();
      const firstFrame: unknown = trail().callsTo('arc')[0].args[2];
      clearRecordings();

      viz.draw();

      expect(trail().callsTo('arc')[0].args[2]).not.toBe(firstFrame);
    });
  });

  describe('compositing and bloom', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
      clearRecordings();
    });

    it('draws the trail onto a cleared main canvas at the view size', (): void => {
      viz.draw();

      expect(main.calls[0].name).toBe('clearRect');
      expect(main.callsTo('drawImage')[0].args).toEqual([trail().canvas, 0, 0, WIDTH, HEIGHT]);
    });

    it('blurs a quarter-resolution copy of the trail for the bloom', (): void => {
      viz.draw();

      const blurred: RecordedCall = bloom().callsTo('drawImage')[0];
      expect(bloom().canvas.width).toBe(200);
      expect(bloom().canvas.height).toBe(150);
      expect(blurred.args).toEqual([trail().canvas, 0, 0, 200, 150]);
      expect(blurred.state['filter']).toBe('blur(16px)');
    });

    it('adds the bloom over the trail additively at the view size', (): void => {
      viz.draw();

      const added: RecordedCall = main.callsTo('drawImage')[1];
      expect(added.args).toEqual([bloom().canvas, 0, 0, WIDTH, HEIGHT]);
      expect(added.state['globalCompositeOperation']).toBe('lighter');
      expect(added.state['globalAlpha']).toBe(1);
    });

    it('does not redraw the circle on the main canvas when the trail is full size', (): void => {
      viz.draw();

      expect(main.callsTo('createConicGradient')).toEqual([]);
    });

    it('redraws the circle sharp on the main canvas when the trail is reduced', (): void => {
      viz.resize(3840, 2160);
      viz.setPlaying(true);
      clearRecordings();

      viz.draw();

      // Core and filament only: the glow stays in the trail.
      const strokes: RecordedCall[] = main.callsTo('stroke');
      expect(strokes).toHaveLength(2);
      expect((strokes[0].state['strokeStyle'] as FakeGradient).kind).toBe('createConicGradient');
      expect(strokes[1].state['strokeStyle']).toBe('rgba(255, 255, 255, 0.5)');
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
      clock.advance(3750);

      viz.draw();

      const overlay: RecordedCall = main.callsTo('fillRect')[0];
      expect(overlay.state['fillStyle']).toBe('rgba(0, 0, 0, 0.75)');
      expect(overlay.state['globalCompositeOperation']).toBe('destination-out');
      expect(overlay.args).toEqual([0, 0, WIDTH, HEIGHT]);
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
  });

  describe('FFT size', (): void => {
    it('reads the waveform and spectrum at the new FFT size after it changes', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.draw();

      viz.setFftSize(512);
      viz.draw();

      expect(analyser.waveformReads).toEqual([2048, 512]);
      expect(analyser.spectrumReads).toEqual([1024, 256]);
    });
  });

  describe('destroy', (): void => {
    it('releases its off-screen canvases, so a later draw builds fresh ones', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.draw();
      const oldTrail: HTMLCanvasElement = trail().canvas;
      const oldBloom: HTMLCanvasElement = bloom().canvas;
      main.clear();

      viz.destroy();
      viz.draw();

      const sources: unknown[] = main.callsTo('drawImage').map((call: RecordedCall): unknown => call.args[0]);
      expect(sources).toHaveLength(2);
      expect(sources).not.toContain(oldTrail);
      expect(sources).not.toContain(oldBloom);
    });
  });

  describe('numeric safety', (): void => {
    const inputs: Array<[string, AnalyserFill, AnalyserFill]> = [
      ['silence', SILENT_SPECTRUM, SILENT_WAVEFORM],
      ['an all-255 spectrum and waveform', FULL_SPECTRUM, LOUD_WAVEFORM],
      ['an all-zero spectrum and waveform', SILENT_SPECTRUM, flat(0)],
      ['a single spectral spike', spike(3), SILENT_WAVEFORM],
    ];

    it.each(inputs)('passes only finite numbers to the canvas for %s', (_label: string, spectrum: AnalyserFill, waveform: AnalyserFill): void => {
      analyser.spectrum = spectrum;
      analyser.waveform = waveform;
      viz.resize(WIDTH, HEIGHT);
      viz.setPlaying(true);

      for (let i: number = 0; i < 60; i++) {
        clock.advance(16);
        viz.draw();
      }

      for (const ctx of fakes.contexts) {
        expect(ctx.invalidCalls()).toEqual([]);
      }
    });

    it('passes only finite numbers to the canvas on a one-pixel canvas', (): void => {
      analyser.spectrum = FULL_SPECTRUM;
      analyser.waveform = LOUD_WAVEFORM;
      viz.resize(1, 1);

      drawFrames(5);

      for (const ctx of fakes.contexts) {
        expect(ctx.invalidCalls()).toEqual([]);
      }
    });
  });
});

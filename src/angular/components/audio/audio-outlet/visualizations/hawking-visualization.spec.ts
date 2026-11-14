/**
 * @fileoverview Unit tests for the Hawking visualization.
 *
 * Tests cover:
 * - Spike rings: geometry, amplitude response, two-fold data symmetry
 * - Colour: hue cycling, glow colour, turning stroke gradients
 * - Particles: spawning against amplitude, shape, pool cap, decay
 * - Trail canvases: creation, zoom/rotation/fade, compositing, resize, destroy
 * - Fade-out when playback stops, and idling once fully faded
 * - Edge inputs: zero-sized canvas, extreme waveforms
 *
 * Canvas 2D, the analyser and the clock are faked; see
 * visualization-test-fakes.group2.
 *
 * @module app/components/audio/audio-outlet/visualizations/hawking-visualization.spec
 */

import {HawkingVisualization} from './hawking-visualization';
import type {Visualization} from './visualization';
import {
  FakeAnalyser,
  FakeContext2D,
  LOUD_WAVEFORM,
  flat,
  installCanvasFakes,
  installFakeClock,
  spike,
} from './visualization-test-fakes.group2';
import type {CanvasFakes, FakeClock, FakeGradient, RecordedCall} from './visualization-test-fakes.group2';

// ============================================================================
// Helpers
// ============================================================================

const WIDTH: number = 800;
const HEIGHT: number = 600;
const CENTRE_X: number = WIDTH / 2;
const CENTRE_Y: number = HEIGHT / 2;

/** Ring radius at 800x600: 28% of the shorter side. */
const BASE_RADIUS: number = 168;

/** Longest spike at 800x600: 75% of the ring radius. */
const SPIKE_SCALE: number = 126;

const SPIKE_COUNT: number = 128;
const MAX_PARTICLES: number = 320;

/** Particles attempted per frame: five per circle. */
const SPAWN_ATTEMPTS_PER_FRAME: number = 10;

interface Spike {
  /** Index around the circle, in drawing order. */
  readonly index: number;
  /** Distance of the root from the screen centre. */
  readonly root: number;
  /** Length from root to tip. */
  readonly length: number;
  /** Angle of the root about the screen centre. */
  readonly angle: number;
}

/** Recovers the spikes drawn on a trail context from its moveTo/lineTo pairs. */
function spikesOn(ctx: FakeContext2D): Spike[] {
  const moves: RecordedCall[] = ctx.callsTo('moveTo');
  const lines: RecordedCall[] = ctx.callsTo('lineTo');
  return moves.map((move: RecordedCall, index: number): Spike => {
    const fromX: number = (move.args[0] as number) - CENTRE_X;
    const fromY: number = (move.args[1] as number) - CENTRE_Y;
    const toX: number = (lines[index].args[0] as number) - CENTRE_X;
    const toY: number = (lines[index].args[1] as number) - CENTRE_Y;
    return {
      index,
      root: Math.hypot(fromX, fromY),
      length: Math.hypot(toX - fromX, toY - fromY),
      angle: Math.atan2(fromY, fromX),
    };
  });
}

/** Indices of the spikes that have any length. */
function raisedSpikes(ctx: FakeContext2D): number[] {
  return spikesOn(ctx)
    .filter((s: Spike): boolean => s.length > 1e-9)
    .map((s: Spike): number => s.index);
}

// ============================================================================
// Tests
// ============================================================================

describe('HawkingVisualization', (): void => {
  let fakes: CanvasFakes;
  let clock: FakeClock;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let viz: HawkingVisualization;
  let main: FakeContext2D;

  /** The trail contexts, in the order onResize creates them. */
  const redTrail = (): FakeContext2D => fakes.contexts[1];
  const blueTrail = (): FakeContext2D => fakes.contexts[2];
  const temp = (): FakeContext2D => fakes.contexts[3];

  function drawFrames(count: number): void {
    for (let i: number = 0; i < count; i++) viz.draw();
  }

  function clearRecordings(): void {
    for (const ctx of fakes.contexts) ctx.clear();
  }

  /** Draws one frame and returns how many particles it rendered. */
  function particlesDrawnInNextFrame(): number {
    main.clear();
    viz.draw();
    return main.callsTo('arc').length;
  }

  beforeEach((): void => {
    clock = installFakeClock();
    fakes = installCanvasFakes();
    analyser = new FakeAnalyser();
    canvas = document.createElement('canvas');
    viz = new HawkingVisualization({canvas, analyser: analyser.node});
    main = fakes.contextFor(canvas);
  });

  afterEach((): void => {
    fakes.restore();
    clock.restore();
    vi.restoreAllMocks();
  });

  describe('construction', (): void => {
    it('identifies itself as Hawking in the Bars & Waves category', (): void => {
      expect(viz.name).toBe('Hawking');
      expect(viz.category).toBe('Bars & Waves');
    });

    it('ignores the global look controls because its look is fixed', (): void => {
      const base: Visualization = viz;

      base.setSensitivity(1);
      base.setTrailIntensity(1);
      base.setLineWidth(5);
      base.setGlowIntensity(1);
      base.setWaveformSmoothing(1);

      expect(viz.getSensitivity()).toBe(0.5);
      expect(viz.getTrailIntensity()).toBe(0.5);
      expect(viz.getLineWidth()).toBe(2);
      expect(viz.getGlowIntensity()).toBe(0.5);
      expect(viz.getWaveformSmoothing()).toBe(0);
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
      for (const ctx of [redTrail(), blueTrail(), temp()]) {
        expect(ctx.canvas.width).toBe(WIDTH);
        expect(ctx.canvas.height).toBe(HEIGHT);
      }
    });

    it('keeps the same trail canvases and rescales their content to the new size', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.draw();
      const redCanvas: HTMLCanvasElement = redTrail().canvas;
      clearRecordings();

      viz.resize(400, 300);

      expect(redTrail().canvas).toBe(redCanvas);
      expect(redCanvas.width).toBe(400);
      expect(redTrail().callsTo('drawImage')[0].args.slice(1)).toEqual([0, 0, WIDTH, HEIGHT, 0, 0, 400, 300]);
    });

    it('re-centres and rescales the ring for the new size', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.resize(400, 300);
      clearRecordings();

      viz.draw();

      const ring: readonly unknown[] = redTrail().callsTo('arc')[0].args;
      expect(ring.slice(0, 2)).toEqual([200, 150]);
      expect(ring[2]).toBeCloseTo(84, 6);
    });

    it('rebuilds the stroke gradient about the new centre', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.draw();
      viz.resize(400, 300);
      clearRecordings();

      viz.draw();

      const gradient: FakeGradient = redTrail().valuesSet('strokeStyle')[0] as FakeGradient;
      const [x0, y0, x1, y1]: readonly number[] = gradient.args;
      expect((x0 + x1) / 2).toBeCloseTo(200, 6);
      expect((y0 + y1) / 2).toBeCloseTo(150, 6);
      expect(Math.hypot(x1 - x0, y1 - y0)).toBeCloseTo(Math.hypot(400, 300), 6);
    });
  });

  describe('spike rings', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
      clearRecordings();
    });

    it('roots every spike on the base ring', (): void => {
      analyser.waveform = LOUD_WAVEFORM;

      viz.draw();

      const spikes: Spike[] = spikesOn(redTrail());
      expect(spikes).toHaveLength(SPIKE_COUNT);
      for (const s of spikes) {
        expect(s.root).toBeCloseTo(BASE_RADIUS, 6);
      }
    });

    it('draws no spike length for a silent waveform', (): void => {
      viz.draw();

      expect(raisedSpikes(redTrail())).toEqual([]);
      expect(raisedSpikes(blueTrail())).toEqual([]);
    });

    it('extends spikes in proportion to the waveform amplitude', (): void => {
      analyser.waveform = LOUD_WAVEFORM;

      viz.draw();

      // amplitude (127/128) x sensitivity factor (1.0) x spike scale
      for (const s of spikesOn(redTrail())) {
        expect(s.length).toBeCloseTo((127 / 128) * SPIKE_SCALE, 6);
      }
    });

    it('treats negative excursions the same as positive ones', (): void => {
      analyser.waveform = flat(0);

      viz.draw();

      for (const s of spikesOn(redTrail())) {
        expect(s.length).toBeCloseTo(SPIKE_SCALE, 6);
      }
    });

    it('repeats the waveform twice around the circle', (): void => {
      analyser.waveform = spike(0, 255, 128);

      viz.draw();

      expect(raisedSpikes(redTrail())).toEqual([0, 64]);
    });

    it('samples the second circle a quarter of the way round from the first', (): void => {
      analyser.waveform = spike(0, 255, 128);

      viz.draw();

      expect(raisedSpikes(blueTrail())).toEqual([32, 96]);
    });

    it('rotates the two circles in opposite directions', (): void => {
      drawFrames(9);
      clearRecordings();

      viz.draw();

      // Spike 0 starts at the top (-90°) and turns 0.012 rad per frame.
      expect(spikesOn(redTrail())[0].angle).toBeCloseTo(-Math.PI / 2 + 10 * 0.012, 6);
      expect(spikesOn(blueTrail())[0].angle).toBeCloseTo(-Math.PI / 2 - 10 * 0.012, 6);
    });

    it('anchors the spikes with a thin ring at the base radius', (): void => {
      viz.draw();

      const ring: RecordedCall = redTrail().callsTo('arc')[0];
      const strokes: RecordedCall[] = redTrail().callsTo('stroke');
      expect(ring.args.slice(0, 2)).toEqual([CENTRE_X, CENTRE_Y]);
      expect(ring.args[2]).toBeCloseTo(BASE_RADIUS, 6);
      expect(ring.args.slice(3)).toEqual([0, Math.PI * 2]);
      expect(strokes.map((call: RecordedCall): unknown => call.state['lineWidth'])).toEqual([2, 1.5]);
    });

    it('strokes the spikes with a glow at half the base blur', (): void => {
      viz.draw();

      expect(redTrail().callsTo('stroke')[0].state['shadowBlur']).toBe(6);
    });
  });

  describe('colour', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
      clearRecordings();
    });

    it('builds only the gradients the spikes are stroked with', (): void => {
      drawFrames(3);

      for (const ctx of fakes.contexts) {
        expect(ctx.callsTo('createRadialGradient')).toEqual([]);
      }
      expect(redTrail().callsTo('createLinearGradient')).toHaveLength(6);
    });

    it('starts the circles at red and blue', (): void => {
      viz.draw();

      expect(redTrail().callsTo('stroke')[0].state['shadowColor']).toBe('hsla(1, 100%, 55%, 1)');
      expect(blueTrail().callsTo('stroke')[0].state['shadowColor']).toBe('hsla(221, 100%, 55%, 1)');
    });

    it('cycles both hues half a degree per frame, keeping them 220° apart', (): void => {
      drawFrames(199);
      clearRecordings();

      viz.draw();

      expect(redTrail().callsTo('stroke')[0].state['shadowColor']).toBe('hsla(100, 100%, 55%, 1)');
      expect(blueTrail().callsTo('stroke')[0].state['shadowColor']).toBe('hsla(320, 100%, 55%, 1)');
    });

    it('wraps the hues after a full turn of the palette', (): void => {
      drawFrames(719);
      clearRecordings();

      viz.draw();

      expect(redTrail().callsTo('stroke')[0].state['shadowColor']).toBe('hsla(0, 100%, 55%, 1)');
      expect(blueTrail().callsTo('stroke')[0].state['shadowColor']).toBe('hsla(220, 100%, 55%, 1)');
    });

    it('strokes each circle with a gradient that is vivid at one end and faded at the other', (): void => {
      viz.draw();

      const gradient: FakeGradient = redTrail().valuesSet('strokeStyle')[0] as FakeGradient;
      expect(gradient.kind).toBe('createLinearGradient');
      expect(gradient.stops).toEqual([
        {offset: 0, color: 'hsla(1, 100%, 50%, 1)'},
        {offset: 1, color: 'hsla(1, 100%, 52%, 0.45)'},
      ]);
    });

    it('spans the gradient across the screen diagonal through the centre', (): void => {
      viz.draw();

      const [x0, y0, x1, y1]: readonly number[] = (redTrail().valuesSet('strokeStyle')[0] as FakeGradient).args;
      expect((x0 + x1) / 2).toBeCloseTo(CENTRE_X, 6);
      expect((y0 + y1) / 2).toBeCloseTo(CENTRE_Y, 6);
      expect(Math.hypot(x1 - x0, y1 - y0)).toBeCloseTo(Math.hypot(WIDTH, HEIGHT), 6);
    });

    it('starts the gradient with its vivid end at the bottom of the screen', (): void => {
      viz.draw();

      const [, y0, , y1]: readonly number[] = (redTrail().valuesSet('strokeStyle')[0] as FakeGradient).args;
      expect(y0).toBeGreaterThan(CENTRE_Y);
      expect(y1).toBeLessThan(CENTRE_Y);
    });

    it('turns the two gradients in opposite directions', (): void => {
      drawFrames(99);
      clearRecordings();

      viz.draw();

      const red: readonly number[] = (redTrail().valuesSet('strokeStyle')[0] as FakeGradient).args;
      const blue: readonly number[] = (blueTrail().valuesSet('strokeStyle')[0] as FakeGradient).args;
      const reach: number = Math.hypot(WIDTH, HEIGHT) / 2;
      expect(red[0]).toBeCloseTo(CENTRE_X - Math.sin(100 * 0.003) * reach, 6);
      expect(blue[0]).toBeCloseTo(CENTRE_X + Math.sin(100 * 0.003) * reach, 6);
    });
  });

  describe('particles', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
      // Playing, so the only fills on the main canvas are particles.
      viz.setPlaying(true);
      clearRecordings();
    });

    it('sheds no particles in silence, whatever the rolls', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0);

      drawFrames(20);

      expect(main.callsTo('arc')).toEqual([]);
    });

    it('sheds a particle for every attempt whose roll the amplitude beats', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.3);
      analyser.waveform = LOUD_WAVEFORM;

      viz.draw();

      expect(main.callsTo('arc')).toHaveLength(SPAWN_ATTEMPTS_PER_FRAME);
    });

    it('sheds nothing when the amplitude is too low for the roll', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.3);
      // A quarter of full scale: spawn chance 0.25 x 0.85, below the roll.
      analyser.waveform = flat(160);

      drawFrames(20);

      expect(main.callsTo('arc')).toEqual([]);
    });

    it('launches particles from the ring, already moving outward', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.3);
      analyser.waveform = LOUD_WAVEFORM;

      viz.draw();

      for (const arc of main.callsTo('arc')) {
        const distance: number = Math.hypot((arc.args[0] as number) - CENTRE_X, (arc.args[1] as number) - CENTRE_Y);
        expect(distance).toBeGreaterThan(BASE_RADIUS);
        expect(distance).toBeLessThan(BASE_RADIUS + 5);
      }
    });

    it('carries particles further from the centre each frame', (): void => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.3);
      analyser.waveform = LOUD_WAVEFORM;
      viz.draw();
      const firstX: number = main.callsTo('arc')[0].args[0] as number;
      const firstY: number = main.callsTo('arc')[0].args[1] as number;
      random.mockReturnValue(0.99);
      main.clear();

      viz.draw();

      const next: RecordedCall = main.callsTo('arc')[0];
      expect(Math.hypot((next.args[0] as number) - CENTRE_X, (next.args[1] as number) - CENTRE_Y))
        .toBeGreaterThan(Math.hypot(firstX - CENTRE_X, firstY - CENTRE_Y));
    });

    it('colours particles with the hue of the circle that shed them', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.3);
      analyser.waveform = LOUD_WAVEFORM;

      viz.draw();

      const hues: Set<string> = new Set(
        main.valuesSet('fillStyle').map((style: unknown): string => String(style).split(',')[0])
      );
      expect(hues).toEqual(new Set(['hsla(1', 'hsla(221']));
    });

    it('fills particles whose shape roll is low', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.3);
      analyser.waveform = LOUD_WAVEFORM;

      viz.draw();

      expect(main.callsTo('fill')).toHaveLength(SPAWN_ATTEMPTS_PER_FRAME);
      expect(main.callsTo('stroke')).toEqual([]);
    });

    it('outlines particles whose shape roll is high', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.6);
      analyser.waveform = LOUD_WAVEFORM;

      viz.draw();

      expect(main.callsTo('stroke')).toHaveLength(SPAWN_ATTEMPTS_PER_FRAME);
      expect(main.callsTo('fill')).toEqual([]);
    });

    it('draws particles additively over the trails', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.3);
      analyser.waveform = LOUD_WAVEFORM;

      viz.draw();

      expect(main.callsTo('fill')[0].state['globalCompositeOperation']).toBe('lighter');
    });

    it('dims a particle as its life runs out', (): void => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.3);
      analyser.waveform = LOUD_WAVEFORM;
      viz.draw();
      const alphaOf = (style: unknown): number => Number(/([\d.e-]+)\)$/.exec(String(style))?.[1]);
      const born: number = alphaOf(main.valuesSet('fillStyle')[0]);
      random.mockReturnValue(0.99);
      main.clear();

      drawFrames(20);

      const styles: unknown[] = main.valuesSet('fillStyle');
      const aged: number = alphaOf(styles[styles.length - 1]);
      expect(born).toBeLessThanOrEqual(1);
      expect(aged).toBeGreaterThan(0);
      expect(aged).toBeLessThan(born);
    });

    it('never renders more particles than the pool holds', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.01);
      analyser.waveform = LOUD_WAVEFORM;
      const perFrame: number[] = [];

      for (let i: number = 0; i < 200; i++) {
        perFrame.push(particlesDrawnInNextFrame());
      }

      expect(Math.max(...perFrame)).toBe(MAX_PARTICLES);
    });

    it('lets every particle die out once the audio falls silent', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.01);
      analyser.waveform = LOUD_WAVEFORM;
      drawFrames(50);
      analyser.waveform = flat(128);

      // Slowest decay is 0.012 per frame, so nothing outlives 84 frames.
      drawFrames(84);

      expect(particlesDrawnInNextFrame()).toBe(0);
    });
  });

  describe('trails and compositing', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
      clearRecordings();
    });

    it('redraws each trail from its previous frame, zoomed outward and faded', (): void => {
      viz.draw();

      for (const trail of [redTrail(), blueTrail()]) {
        const redraw: RecordedCall = trail.callsTo('drawImage')[0];
        expect(redraw.args[0]).toBe(temp().canvas);
        expect(redraw.state['globalAlpha']).toBeCloseTo(0.965, 10);
        expect(trail.callsTo('scale')[0].args).toEqual([1.008, 1.008]);
      }
    });

    it('turns the two trails in opposite directions as they fade', (): void => {
      viz.draw();

      expect(redTrail().callsTo('rotate')[0].args).toEqual([0.002]);
      expect(blueTrail().callsTo('rotate')[0].args).toEqual([-0.002]);
    });

    it('composites the second trail additively over the first', (): void => {
      viz.draw();

      const draws: RecordedCall[] = main.callsTo('drawImage');
      expect(draws).toHaveLength(2);
      expect(draws[0].args[0]).toBe(redTrail().canvas);
      expect(draws[0].state['globalCompositeOperation']).toBe('source-over');
      expect(draws[1].args[0]).toBe(blueTrail().canvas);
      expect(draws[1].state['globalCompositeOperation']).toBe('lighter');
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
      clock.advance(1250);

      viz.draw();

      const overlay: RecordedCall = main.callsTo('fillRect')[0];
      expect(overlay.state['fillStyle']).toBe('rgba(0, 0, 0, 0.25)');
      expect(overlay.state['globalCompositeOperation']).toBe('destination-out');
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
    it('reads the waveform at the new FFT size after it changes', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.draw();

      viz.setFftSize(4096);
      viz.draw();

      expect(analyser.waveformReads).toEqual([2048, 4096]);
    });

    it('keeps the two-fold symmetry at the new FFT size', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.setFftSize(256);
      analyser.waveform = spike(0, 255, 128);
      clearRecordings();

      viz.draw();

      expect(raisedSpikes(redTrail())).toEqual([0, 64]);
    });
  });

  describe('destroy', (): void => {
    it('releases its trail canvases, so a later draw builds fresh ones', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.draw();
      const oldRed: HTMLCanvasElement = redTrail().canvas;
      const oldBlue: HTMLCanvasElement = blueTrail().canvas;
      main.clear();

      viz.destroy();
      viz.draw();

      const sources: unknown[] = main.callsTo('drawImage').map((call: RecordedCall): unknown => call.args[0]);
      expect(sources).toHaveLength(2);
      expect(sources).not.toContain(oldRed);
      expect(sources).not.toContain(oldBlue);
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

      for (let i: number = 0; i < 60; i++) {
        clock.advance(16);
        viz.draw();
      }

      for (const ctx of fakes.contexts) {
        expect(ctx.invalidCalls()).toEqual([]);
      }
    });

    it('passes only finite numbers to the canvas on a one-pixel canvas', (): void => {
      analyser.waveform = LOUD_WAVEFORM;
      viz.resize(1, 1);

      drawFrames(5);

      for (const ctx of fakes.contexts) {
        expect(ctx.invalidCalls()).toEqual([]);
      }
    });
  });
});

/**
 * @fileoverview Unit tests for the Pulsar visualization.
 *
 * Tests cover:
 * - Layout: surface creation, the trail pixel budget, content kept across resize
 * - Sheared trail: ring count, per-ring spin and zoom
 * - Mirrored arms and centre circle: rest position, deflection, mirroring,
 *   the neon stroke layers and the full-resolution overlay on a reduced trail
 * - Compositing: trail, bloom and background
 * - Transients: rise and level thresholds, the refractory period, the spin
 *   reversal and the palette jump
 * - Hue cycling and the gradient colour cache
 * - Fade-out and idling, fixed-look setters, FFT size changes, destroy
 * - Edge inputs never hand the canvas a NaN or an infinity
 *
 * Canvas 2D and Web Audio are faked; see visualization-test-fakes.group1.
 *
 * @module app/components/audio/audio-outlet/visualizations/pulsar-visualization.spec
 */

import {PulsarVisualization} from './pulsar-visualization';
import {Visualization} from './visualization';
import {
  bassHeavy,
  CanvasFakes,
  FakeAnalyser,
  flat,
  installCanvasFakes,
  RecordedCall,
  RecordingContext2D,
  SILENT_SPECTRUM,
} from './visualization-test-fakes.group1';

// ============================================================================
// Fixture geometry
// ============================================================================

/** Canvas size most tests run at. */
const WIDTH: number = 800;
const HEIGHT: number = 600;
const CENTRE_X: number = 400;
const CENTRE_Y: number = 300;

/** Radius of the centre circle at rest: 18% of the half-width, zoomed by 0.75. */
const CIRCLE_RADIUS: number = 54;

/** Paths stroked per frame: left arm, right arm, centre circle. */
const PATHS: number = 3;

/** Strokes laid down per path: halo, core, hot centre. */
const LAYERS: number = 3;

/** Rings the trail is redrawn in, at most: sixty, plus the partial one. */
const MAX_RINGS: number = 61;

/** Where the simulated clock starts, in milliseconds. */
const START_MS: number = 100_000;

/** Gap a transient enforces before the next may act, in milliseconds. */
const REFRACTORY_MS: number = 10_000;

/** The surfaces Pulsar creates, in the order it creates them. */
interface Surfaces {
  readonly main: RecordingContext2D;
  readonly trail: RecordingContext2D;
  readonly scratch: RecordingContext2D;
  readonly bloom: RecordingContext2D;
}

/** Distance of a recorded point from the canvas centre. */
function radiusOf(call: RecordedCall): number {
  return Math.hypot((call.args[0] as number) - CENTRE_X, (call.args[1] as number) - CENTRE_Y);
}

describe('PulsarVisualization', (): void => {
  let fakes: CanvasFakes;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let viz: PulsarVisualization;
  let now: number;

  /** The recording contexts, named for the surface each belongs to. */
  function surfaces(): Surfaces {
    const [main, trail, scratch, bloom]: RecordingContext2D[] = fakes.contexts;
    return {main, trail, scratch, bloom};
  }

  /** The visualization as the settings panel sees it: through the base type. */
  function controls(): Visualization {
    return viz;
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

  /** Draws a silent frame, then a frame with a full-scale bass hit `afterMs` later. */
  function hit(afterMs: number = 16): void {
    analyser.spectrum = SILENT_SPECTRUM;
    frame();
    analyser.spectrum = bassHeavy(16);
    frame(afterMs);
  }

  /** The direction the trail rings were turned in on the most recent frame: 1 or -1. */
  function ringSpin(): number {
    const calls: RecordedCall[] = surfaces().trail.calls;
    const frameStart: number = calls.map((call: RecordedCall): string => call.method).lastIndexOf('clearRect');
    // The rings are redrawn straight after the clear; the arms are placed later.
    const firstRing: RecordedCall | undefined = calls.slice(frameStart)
      .find((call: RecordedCall): boolean => call.method === 'rotate');
    return Math.sign(firstRing?.args[0] as number);
  }

  /** The angle the arms were drawn at on each recorded frame. */
  function armAngles(): number[] {
    const strokes: RecordedCall[] = surfaces().trail.calls;
    const angles: number[] = [];
    let last: number | null = null;
    for (const call of strokes) {
      if (call.method === 'rotate') last = call.args[0] as number;
      // The first stroke of a frame follows the rotation that placed the arms.
      if (call.method === 'stroke' && last !== null) {
        angles.push(last);
        last = null;
      }
    }
    return angles;
  }

  /** The colour the background was filled with on the most recent frame. */
  function background(): unknown {
    return surfaces().main.callsTo('fillRect')
      .filter((call: RecordedCall): boolean => call.state.globalCompositeOperation === 'destination-over')
      .at(-1)?.state.fillStyle;
  }

  /** The core stroke colour of the centre circle on each recorded frame. */
  function circleColours(): unknown[] {
    return surfaces().trail.callsTo('stroke')
      .filter((_call: RecordedCall, index: number): boolean => index % (PATHS * LAYERS) === 7)
      .map((call: RecordedCall): unknown => call.state.strokeStyle);
  }

  beforeEach((): void => {
    fakes = installCanvasFakes();
    now = START_MS;
    vi.spyOn(performance, 'now').mockImplementation((): number => now);
    vi.spyOn(Math, 'random').mockReturnValue(0.9);

    analyser = new FakeAnalyser();
    canvas = document.createElement('canvas');
    viz = new PulsarVisualization({canvas, analyser: analyser.asNode()});
  });

  afterEach((): void => {
    fakes.restore();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Identity
  // ==========================================================================

  describe('identity', (): void => {
    it('is listed as Pulsar under Nostalgia', (): void => {
      expect(viz.name).toBe('Pulsar');
      expect(viz.category).toBe('Nostalgia');
    });
  });

  // ==========================================================================
  // Layout
  // ==========================================================================

  describe('resize', (): void => {
    it('creates its trail, scratch and bloom surfaces', (): void => {
      viz.resize(WIDTH, HEIGHT);

      expect(fakes.contexts).toHaveLength(4);
    });

    it('keeps the trail at canvas size while it fits the pixel budget', (): void => {
      viz.resize(WIDTH, HEIGHT);

      const {trail, scratch}: Surfaces = surfaces();
      expect([trail.canvas.width, trail.canvas.height]).toEqual([WIDTH, HEIGHT]);
      expect([scratch.canvas.width, scratch.canvas.height]).toEqual([WIDTH, HEIGHT]);
    });

    it('shrinks the trail and its scratch to the pixel budget on a 4K canvas', (): void => {
      viz.resize(3840, 2160);

      const {trail, scratch}: Surfaces = surfaces();
      expect([trail.canvas.width, trail.canvas.height]).toEqual([1280, 720]);
      expect([scratch.canvas.width, scratch.canvas.height]).toEqual([1280, 720]);
    });

    it('maps canvas coordinates onto the shrunken trail', (): void => {
      viz.resize(3840, 2160);

      const args: number[] = surfaces().trail.callsTo('setTransform').at(-1)?.args as number[];
      expect(args[0]).toBeCloseTo(1 / 3, 12);
      expect(args[3]).toBeCloseTo(1 / 3, 12);
      expect([args[1], args[2], args[4], args[5]]).toEqual([0, 0, 0, 0]);
    });

    it('clears the main canvas', (): void => {
      viz.resize(WIDTH, HEIGHT);

      expect(surfaces().main.callsTo('clearRect').at(-1)?.args).toEqual([0, 0, WIDTH, HEIGHT]);
    });

    it('keeps the same trail surface when resized again', (): void => {
      viz.resize(WIDTH, HEIGHT);
      const trail: RecordingContext2D = surfaces().trail;

      viz.resize(400, 300);
      frame();

      expect(surfaces().trail).toBe(trail);
      expect(trail.callsTo('stroke')).toHaveLength(PATHS * LAYERS);
    });

    it('scales what the trail already holds to the new size', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();

      viz.resize(400, 300);

      const {trail}: Surfaces = surfaces();
      const carried: RecordedCall | undefined = trail.callsTo('drawImage').at(-1);
      expect([trail.canvas.width, trail.canvas.height]).toEqual([400, 300]);
      expect(carried?.args.slice(1)).toEqual([0, 0, WIDTH, HEIGHT, 0, 0, 400, 300]);
    });

    it('resizes the scratch surface with the trail', (): void => {
      viz.resize(WIDTH, HEIGHT);

      viz.resize(400, 300);

      const {scratch}: Surfaces = surfaces();
      expect([scratch.canvas.width, scratch.canvas.height]).toEqual([400, 300]);
    });

    it('re-centres what it draws after a resize', (): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.resize(400, 300);
      fakes.forget();

      frame();

      // Left arm, at rest: starts 300px left of the new centre, on its centre line.
      const start: RecordedCall = surfaces().trail.callsTo('moveTo')[0];
      expect(start.args[0]).toBeCloseTo(200 - 300, 9);
      expect(start.args[1]).toBeCloseTo(150, 9);
    });
  });

  // ==========================================================================
  // Sheared trail
  // ==========================================================================

  describe('sheared trail', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
    });

    it('copies the trail to its scratch surface pixel for pixel before ageing it', (): void => {
      frame();

      const {scratch, trail}: Surfaces = surfaces();
      const copy: RecordedCall = scratch.callsTo('drawImage')[0];
      expect(copy.args).toEqual([trail.canvas, 0, 0]);
      expect(copy.state.globalCompositeOperation).toBe('copy');
    });

    it('clears the trail before redrawing it', (): void => {
      frame();

      const methods: string[] = surfaces().trail.calls.map((call: RecordedCall): string => call.method);
      expect(surfaces().trail.callsTo('clearRect')[0].args).toEqual([0, 0, WIDTH, HEIGHT]);
      expect(methods.indexOf('clearRect')).toBeLessThan(methods.indexOf('drawImage'));
    });

    it('redraws the trail from the scratch copy once per ring', (): void => {
      frame();

      const {trail, scratch}: Surfaces = surfaces();
      const redraws: RecordedCall[] = trail.callsTo('drawImage');
      expect(redraws).toHaveLength(MAX_RINGS);
      for (const redraw of redraws) {
        expect(redraw.args).toEqual([scratch.canvas, 0, 0, WIDTH, HEIGHT]);
      }
    });

    it('never redraws more rings than its cap, however long it runs', (): void => {
      frames(200);

      const rings: number = surfaces().trail.callsTo('clip').length;
      expect(rings).toBeLessThanOrEqual(MAX_RINGS * 200);
      expect(rings).toBeGreaterThanOrEqual((MAX_RINGS - 1) * 200);
    });

    it('tiles the rings from the centre out to the corners without gaps', (): void => {
      frame();

      // Every ring but the innermost is an outer arc followed by an inner one;
      // each inner edge sits exactly on the previous ring's outer edge.
      const arcs: RecordedCall[] = surfaces().trail.callsTo('arc').slice(0, MAX_RINGS * 2 - 1);
      const outer: number[] = [arcs[0].args[2] as number];
      for (let i: number = 1; i < arcs.length; i += 2) {
        outer.push(arcs[i].args[2] as number);
        expect(arcs[i + 1].args[2]).toBe(outer[outer.length - 2]);
        expect(arcs[i + 1].args[5]).toBe(true);
      }
      // The corner of an 800x600 canvas is 500px from its centre.
      expect(outer.at(-1)).toBe(500);
    });

    it('turns the outer rings faster than the inner ones', (): void => {
      frame();

      const spins: number[] = surfaces().trail.callsTo('rotate')
        .slice(0, MAX_RINGS)
        .map((call: RecordedCall): number => call.args[0] as number);
      for (let i: number = 1; i < spins.length; i++) {
        expect(spins[i]).toBeGreaterThan(spins[i - 1]);
      }
      expect(spins[0]).toBeGreaterThan(0.005);
      expect(spins[MAX_RINGS - 1]).toBeLessThan(0.015);
    });

    it('zooms every ring outward or holds it, never inward', (): void => {
      frames(40);

      const zooms: number[] = surfaces().trail.callsTo('scale')
        .map((call: RecordedCall): number => call.args[0] as number);
      expect(Math.min(...zooms)).toBeGreaterThanOrEqual(0.9999);
      expect(Math.max(...zooms)).toBeLessThanOrEqual(1.05);
    });

    it('ripples the zoom so that neighbouring bands expand at different rates', (): void => {
      frame();

      const zooms: number[] = surfaces().trail.callsTo('scale')
        .map((call: RecordedCall): number => call.args[0] as number);
      expect(Math.max(...zooms) - Math.min(...zooms)).toBeGreaterThan(0.03);
    });

    it('drifts the ripple so a given ring does not keep the same zoom', (): void => {
      frame();
      const first: unknown = surfaces().trail.callsTo('scale')[30].args[0];
      fakes.forget();

      frame();

      expect(surfaces().trail.callsTo('scale')[30].args[0]).not.toBe(first);
    });
  });

  // ==========================================================================
  // Arms and centre circle
  // ==========================================================================

  describe('arms and centre circle', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
    });

    it('strokes two arms and the centre circle in three layers each', (): void => {
      frame();

      expect(surfaces().trail.callsTo('stroke')).toHaveLength(PATHS * LAYERS);
    });

    it('lays the left arm flat along the centre line when the waveform is at rest', (): void => {
      frame();

      const {trail}: Surfaces = surfaces();
      const start: RecordedCall = trail.callsTo('moveTo')[0];
      const end: RecordedCall = trail.callsTo('lineTo')[0];
      // From twice the half-width out (zoomed by 0.75) in to the centre circle.
      expect(start.args[0]).toBeCloseTo(CENTRE_X - 600, 9);
      expect(start.args[1]).toBeCloseTo(CENTRE_Y, 9);
      expect(end.args[0]).toBeCloseTo(CENTRE_X - CIRCLE_RADIUS, 9);
      expect(end.args[1]).toBeCloseTo(CENTRE_Y, 9);
    });

    it('lays the right arm flat from the centre circle outward when the waveform is at rest', (): void => {
      frame();

      const {trail}: Surfaces = surfaces();
      const start: RecordedCall = trail.callsTo('moveTo')[LAYERS];
      const end: RecordedCall = trail.callsTo('lineTo')[LAYERS];
      expect(start.args).toEqual([CENTRE_X + CIRCLE_RADIUS, CENTRE_Y]);
      expect(end.args).toEqual([CENTRE_X + 600, CENTRE_Y]);
    });

    it('bends the arms off the centre line when the waveform is deflected', (): void => {
      analyser.waveform = flat(255);

      frame();

      const innerEnd: RecordedCall = surfaces().trail.callsTo('lineTo')[0];
      expect(Math.abs((innerEnd.args[1] as number) - CENTRE_Y)).toBeGreaterThan(20);
      expect(radiusOf(innerEnd)).toBeCloseTo(CIRCLE_RADIUS, 9);
    });

    it('mirrors the right arm across the vertical centre line', (): void => {
      analyser.waveform = (index: number): number => 128 + ((index * 7) % 100);

      frame();

      // The left arm runs outside-in and the right inside-out, so the left's
      // first point pairs with the right's last.
      const {trail}: Surfaces = surfaces();
      const leftOuter: RecordedCall = trail.callsTo('moveTo')[0];
      const rightOuter: RecordedCall = trail.callsTo('lineTo')[LAYERS];
      expect((leftOuter.args[0] as number) + (rightOuter.args[0] as number)).toBeCloseTo(WIDTH, 9);
      expect(rightOuter.args[1]).toBeCloseTo(leftOuter.args[1] as number, 9);
    });

    it('draws the centre circle at its resting radius when the waveform is at rest', (): void => {
      frame();

      // The circle is the third path; each path is built once per layer.
      const circleStart: RecordedCall = surfaces().trail.callsTo('moveTo')[LAYERS * 2];
      expect(circleStart.args).toEqual([CENTRE_X + CIRCLE_RADIUS, CENTRE_Y]);
    });

    it('swells the centre circle with a deflected waveform', (): void => {
      analyser.waveform = flat(255);

      frame();

      // Full deflection at the fixed 20% sensitivity adds 127/128 of 14.4px.
      const circleStart: RecordedCall = surfaces().trail.callsTo('moveTo')[LAYERS * 2];
      expect(radiusOf(circleStart)).toBeCloseTo(CIRCLE_RADIUS + 14.4 * 127 / 128, 9);
    });

    it('shrinks the centre circle when the waveform deflects the other way', (): void => {
      analyser.waveform = flat(0);

      frame();

      const circleStart: RecordedCall = surfaces().trail.callsTo('moveTo')[LAYERS * 2];
      expect(radiusOf(circleStart)).toBeCloseTo(CIRCLE_RADIUS - 14.4, 9);
    });

    it('closes the centre circle path', (): void => {
      frame();

      expect(surfaces().trail.callsTo('closePath')).toHaveLength(LAYERS);
    });

    it('strokes an arm as a wide soft halo, a core and a hot centre line', (): void => {
      frame();

      const [halo, core, hot]: RecordedCall[] = surfaces().trail.callsTo('stroke');
      expect(halo.state.strokeStyle).toBe('rgba(255, 255, 255, 0.22)');
      expect(halo.state.lineWidth).toBe(6);
      expect(halo.state.shadowBlur).toBe(18);
      expect(core.state.strokeStyle).toBe('rgba(255, 255, 255, 1)');
      expect(core.state.lineWidth).toBe(1);
      expect(core.state.shadowBlur).toBeCloseTo(8.1, 10);
      expect(hot.state.strokeStyle).toBe('rgba(255, 255, 255, 0.55)');
      expect(hot.state.shadowBlur).toBe(0);
    });

    it('does not stroke additively, so the trail cannot saturate', (): void => {
      frame();

      for (const stroke of surfaces().trail.callsTo('stroke')) {
        expect(stroke.state.globalCompositeOperation).toBe('source-over');
      }
    });

    it('turns the arms a little further every frame', (): void => {
      frames(3);

      const angles: number[] = armAngles();
      expect(angles[0]).toBeCloseTo(-0.005, 12);
      expect(angles[1]).toBeCloseTo(-0.01, 12);
      expect(angles[2]).toBeCloseTo(-0.015, 12);
    });

    it('does not redraw the arms on the main canvas while the trail is full size', (): void => {
      frame();

      expect(surfaces().main.callsTo('stroke')).toEqual([]);
    });
  });

  // ==========================================================================
  // Reduced trail
  // ==========================================================================

  describe('with the trail reduced to its pixel budget', (): void => {
    beforeEach((): void => {
      viz.resize(3840, 2160);
    });

    it('scales the halo blur down to match the trail', (): void => {
      frame();

      const halo: RecordedCall = surfaces().trail.callsTo('stroke')[0];
      expect(halo.state.shadowBlur).toBeCloseTo(6, 10);
    });

    it('lays the core and hot centre of every path over the main canvas at full size', (): void => {
      frame();

      const strokes: RecordedCall[] = surfaces().main.callsTo('stroke');
      expect(strokes).toHaveLength(PATHS * 2);
      expect(strokes[0].state.strokeStyle).toBe('rgba(255, 255, 255, 1)');
      expect(strokes[1].state.strokeStyle).toBe('rgba(255, 255, 255, 0.55)');
    });

    it('leaves the halo to the trail when overlaying', (): void => {
      frame();

      for (const stroke of surfaces().main.callsTo('stroke')) {
        expect(stroke.state.shadowBlur).toBe(0);
      }
    });

    it('overlays the arms at the same angle as on the trail', (): void => {
      frames(2);

      expect(surfaces().main.callsTo('rotate').at(-1)?.args[0]).toBeCloseTo(-0.01, 12);
    });

    it('stretches the reduced trail back over the whole canvas', (): void => {
      frame();

      const {main, trail}: Surfaces = surfaces();
      expect(main.callsTo('drawImage')[0].args).toEqual([trail.canvas, 0, 0, 3840, 2160]);
    });
  });

  // ==========================================================================
  // Compositing
  // ==========================================================================

  describe('compositing', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
    });

    it('clears the main canvas before drawing the trail onto it', (): void => {
      frame();

      const {main, trail}: Surfaces = surfaces();
      const methods: string[] = main.calls.map((call: RecordedCall): string => call.method);
      expect(methods.indexOf('clearRect')).toBeLessThan(methods.indexOf('drawImage'));
      expect(main.callsTo('drawImage')[0].args).toEqual([trail.canvas, 0, 0, WIDTH, HEIGHT]);
    });

    it('blurs the trail into a half-size bloom surface', (): void => {
      frame();

      const {bloom, trail}: Surfaces = surfaces();
      const blurred: RecordedCall = bloom.callsTo('drawImage')[0];
      expect([bloom.canvas.width, bloom.canvas.height]).toEqual([400, 300]);
      expect(blurred.args).toEqual([trail.canvas, 0, 0, 400, 300]);
      expect(blurred.state.filter).toBe('blur(8px)');
    });

    it('adds the bloom over the trail at half strength', (): void => {
      frame();

      const {main, bloom}: Surfaces = surfaces();
      const added: RecordedCall = main.callsTo('drawImage')[1];
      expect(added.args).toEqual([bloom.canvas, 0, 0, WIDTH, HEIGHT]);
      expect(added.state.globalCompositeOperation).toBe('lighter');
      expect(added.state.globalAlpha).toBe(0.5);
    });

    it('slides a white background underneath everything else', (): void => {
      viz.setPlaying(true);

      frame();

      const fill: RecordedCall | undefined = surfaces().main.callsTo('fillRect').at(-1);
      expect(fill?.args).toEqual([0, 0, WIDTH, HEIGHT]);
      expect(fill?.state.globalCompositeOperation).toBe('destination-over');
      expect(fill?.state.fillStyle).toBe('rgb(255, 255, 255)');
    });
  });

  // ==========================================================================
  // Transients
  // ==========================================================================

  describe('transients', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
    });

    it('spins the trail forward until a transient acts', (): void => {
      frames(3);

      expect(ringSpin()).toBe(1);
    });

    it('reverses the trail on a sudden bass hit', (): void => {
      hit();

      expect(ringSpin()).toBe(-1);
    });

    it('reverses the turn of the arms along with the trail', (): void => {
      hit();
      frame();

      // Two frames forward (-0.005 each), then back the other way.
      const angles: number[] = armAngles();
      expect(angles[1]).toBeCloseTo(0, 12);
      expect(angles[2]).toBeCloseTo(0.005, 12);
    });

    it('does not treat steady loud bass as a hit', (): void => {
      analyser.spectrum = bassHeavy(16);
      frame();

      frames(3, REFRACTORY_MS);

      // Only the initial rise from nothing acted; a second hit would have
      // turned the spin forward again.
      expect(ringSpin()).toBe(-1);
    });

    it('ignores a rise of exactly the threshold', (): void => {
      analyser.spectrum = flat(100);
      frame(REFRACTORY_MS);
      const before: number = ringSpin();

      analyser.spectrum = flat(115);
      frame(REFRACTORY_MS);

      expect(ringSpin()).toBe(before);
    });

    it('acts on a rise just over the threshold', (): void => {
      analyser.spectrum = flat(100);
      frame(REFRACTORY_MS);
      const before: number = ringSpin();

      analyser.spectrum = flat(116);
      frame(REFRACTORY_MS);

      expect(ringSpin()).toBe(-before);
    });

    it('ignores a rise that stays at or below the level floor', (): void => {
      frame();

      analyser.spectrum = flat(50);
      frame();

      expect(ringSpin()).toBe(1);
    });

    it('acts on a rise that just clears the level floor', (): void => {
      frame();

      analyser.spectrum = flat(51);
      frame();

      expect(ringSpin()).toBe(-1);
    });

    it('listens only to the sixteen lowest bins', (): void => {
      frame();

      analyser.spectrum = (index: number): number => (index < 16 ? 0 : 255);
      frame();

      expect(ringSpin()).toBe(1);
    });

    it('ignores a second hit inside the ten-second refractory period', (): void => {
      hit();

      hit(REFRACTORY_MS - 100);

      expect(ringSpin()).toBe(-1);
    });

    it('acts on a second hit once the refractory period has passed', (): void => {
      hit();

      hit(REFRACTORY_MS);

      expect(ringSpin()).toBe(1);
    });

    it('measures the refractory period in elapsed time rather than in frames', (): void => {
      hit();
      analyser.spectrum = SILENT_SPECTRUM;

      // Many frames, little time: still refractory.
      frames(50, 1);
      analyser.spectrum = bassHeavy(16);
      frame(1);
      const afterManyFrames: number = ringSpin();
      // Two frames, much time: the second hit acts.
      hit(REFRACTORY_MS);

      expect(afterManyFrames).toBe(-1);
      expect(ringSpin()).toBe(1);
    });

    it('accents the hue when it reverses the spin', (): void => {
      hit();

      const [before, after]: unknown[] = circleColours();
      expect(after).not.toBe(before);
    });

    it('keeps the arms lit when it reverses the spin', (): void => {
      hit();

      expect(background()).toBe('rgb(255, 255, 255)');
    });

    describe('when the palette roll comes up', (): void => {
      beforeEach((): void => {
        vi.spyOn(Math, 'random').mockReturnValue(0.1);
      });

      it('leaves the spin alone', (): void => {
        hit();

        expect(ringSpin()).toBe(1);
      });

      it('darkens the arms', (): void => {
        hit();

        const armCore: RecordedCall = surfaces().trail.callsTo('stroke').at(-(PATHS * LAYERS) + 1) as RecordedCall;
        expect(armCore.state.strokeStyle).toBe('rgba(0, 0, 0, 1)');
      });

      it('turns the background black to match the arms', (): void => {
        hit();

        expect(background()).toBe('rgb(0, 0, 0)');
      });

      it('throws the centre circle to a different colour', (): void => {
        hit();

        const [before, after]: unknown[] = circleColours();
        expect(after).not.toBe(before);
      });

      it('keeps the arms dark until the next palette jump', (): void => {
        hit();

        frames(5, 1000);

        expect(background()).toBe('rgb(0, 0, 0)');
      });

      it('lights the arms again on the next palette jump', (): void => {
        hit();

        hit(REFRACTORY_MS);

        expect(background()).toBe('rgb(255, 255, 255)');
      });
    });
  });

  // ==========================================================================
  // Hue cycling
  // ==========================================================================

  describe('hue cycling', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
    });

    it('starts the centre circle blue', (): void => {
      frame();

      // hsl(210.15, 75%, 50%).
      expect(circleColours()).toEqual(['rgba(32, 127, 223, 1)']);
    });

    it('holds the centre circle colour while the hue stays within a degree', (): void => {
      // The hue drifts 0.15 degrees a frame from 210: six frames stay under 211.
      frames(6);

      expect(new Set<unknown>(circleColours()).size).toBe(1);
    });

    it('moves the centre circle colour on once the hue reaches the next degree', (): void => {
      frames(7);

      const colours: unknown[] = circleColours();
      expect(colours[6]).not.toBe(colours[5]);
    });

    it('never tints the arms with the cycling hue', (): void => {
      frames(20);

      const armCores: unknown[] = surfaces().trail.callsTo('stroke')
        .filter((_call: RecordedCall, index: number): boolean => index % (PATHS * LAYERS) === 1)
        .map((call: RecordedCall): unknown => call.state.strokeStyle);
      expect(new Set<unknown>(armCores)).toEqual(new Set<unknown>(['rgba(255, 255, 255, 1)']));
    });
  });

  // ==========================================================================
  // Fade
  // ==========================================================================

  describe('fade', (): void => {
    /** The fade-out fills punched through the main canvas. */
    function fadeOverlays(): RecordedCall[] {
      return surfaces().main.callsTo('fillRect')
        .filter((call: RecordedCall): boolean => call.state.globalCompositeOperation === 'destination-out');
    }

    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
    });

    it('is fully faded out and idle before playback has ever started', (): void => {
      expect(viz.isIdle()).toBe(true);
    });

    it('is not idle while playing', (): void => {
      viz.setPlaying(true);

      expect(viz.isIdle()).toBe(false);
    });

    it('draws without any fade overlay while playing', (): void => {
      viz.setPlaying(true);

      frame(500);

      expect(fadeOverlays()).toEqual([]);
    });

    it('fades out in proportion to the time since playback stopped', (): void => {
      viz.setPlaying(true);
      viz.setPlaying(false);

      frame(1000);
      frame(1500);

      const strengths: unknown[] = fadeOverlays().map((call: RecordedCall): unknown => call.state.fillStyle);
      expect(strengths).toEqual(['rgba(0, 0, 0, 0.2)', 'rgba(0, 0, 0, 0.5)']);
    });

    it('fades out by elapsed time however many frames are drawn', (): void => {
      viz.setPlaying(true);
      viz.setPlaying(false);

      frames(4, 250);

      expect(fadeOverlays().at(-1)?.state.fillStyle).toBe('rgba(0, 0, 0, 0.2)');
    });

    it('punches the fade through the background as well as the trail', (): void => {
      viz.setPlaying(true);
      viz.setPlaying(false);

      frame(1000);

      // The overlay has to be the last thing drawn, after the background fill.
      const last: RecordedCall | undefined = surfaces().main.callsTo('fillRect').at(-1);
      expect(last?.state.globalCompositeOperation).toBe('destination-out');
      expect(last?.args).toEqual([0, 0, WIDTH, HEIGHT]);
    });

    it('stays active part-way through the fade-out', (): void => {
      viz.setPlaying(true);
      viz.setPlaying(false);

      frame(4999);

      expect(viz.isIdle()).toBe(false);
    });

    it('goes idle once the five-second fade-out has finished', (): void => {
      viz.setPlaying(true);
      viz.setPlaying(false);

      frame(5000);

      expect(viz.isIdle()).toBe(true);
    });
  });

  // ==========================================================================
  // Fixed look
  // ==========================================================================

  describe('fixed look', (): void => {
    it('ignores the sensitivity control', (): void => {
      controls().setSensitivity(1);

      expect(viz.getSensitivity()).toBe(0.2);
    });

    it('ignores the trail intensity control', (): void => {
      controls().setTrailIntensity(1);

      expect(viz.getTrailIntensity()).toBe(0);
    });

    it('ignores the line width control', (): void => {
      controls().setLineWidth(5);

      expect(viz.getLineWidth()).toBe(1);
    });

    it('ignores the glow control', (): void => {
      controls().setGlowIntensity(0);

      expect(viz.getGlowIntensity()).toBe(1);
    });

    it('ignores the waveform smoothing control', (): void => {
      controls().setWaveformSmoothing(0);

      expect(viz.getWaveformSmoothing()).toBe(1);
    });

    it('keeps the centre circle the same size after the sensitivity control is moved', (): void => {
      viz.resize(WIDTH, HEIGHT);
      controls().setSensitivity(1);
      analyser.waveform = flat(0);

      frame();

      const circleStart: RecordedCall = surfaces().trail.callsTo('moveTo')[LAYERS * 2];
      expect(radiusOf(circleStart)).toBeCloseTo(CIRCLE_RADIUS - 14.4, 9);
    });

    it('keeps drawing smooth curves after the smoothing control is moved', (): void => {
      viz.resize(WIDTH, HEIGHT);
      controls().setWaveformSmoothing(0);

      frame();

      expect(surfaces().trail.callsTo('quadraticCurveTo').length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // FFT size
  // ==========================================================================

  describe('FFT size', (): void => {
    it('reads the spectrum and the waveform once a frame', (): void => {
      viz.resize(WIDTH, HEIGHT);

      frame();

      expect(analyser.spectrumReads).toEqual([1024]);
      expect(analyser.waveformReads).toEqual([2048]);
    });

    it('reads into buffers of the new size after a change', (): void => {
      viz.resize(WIDTH, HEIGHT);

      viz.setFftSize(512);
      frame();

      expect(analyser.spectrumReads).toEqual([256]);
      expect(analyser.waveformReads).toEqual([512]);
    });
  });

  // ==========================================================================
  // Destroy
  // ==========================================================================

  describe('destroy', (): void => {
    it('stops drawing to the surfaces it has released', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();
      const {trail, scratch, bloom}: Surfaces = surfaces();
      fakes.forget();

      viz.destroy();
      frame();

      expect(trail.calls).toEqual([]);
      expect(scratch.calls).toEqual([]);
      expect(bloom.calls).toEqual([]);
    });

    it('stops a trailing frame from drawing anything', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();
      fakes.forget();

      viz.destroy();
      frame();

      for (const context of fakes.contexts) {
        expect(context.calls).toEqual([]);
      }
    });

    it('stops a trailing frame from rebuilding the surfaces', (): void => {
      viz.resize(WIDTH, HEIGHT);
      frame();
      const surfaceCount: number = fakes.contexts.length;

      viz.destroy();
      frame();

      expect(fakes.contexts).toHaveLength(surfaceCount);
    });

    it('stops a trailing frame from reading the analyser', (): void => {
      viz.resize(WIDTH, HEIGHT);

      viz.destroy();
      frame();

      expect(analyser.spectrumReads).toEqual([]);
      expect(analyser.waveformReads).toEqual([]);
    });
  });

  // ==========================================================================
  // Edge inputs
  // ==========================================================================

  describe('edge inputs', (): void => {
    it.each([
      {spectrum: 0, waveform: 0},
      {spectrum: 0, waveform: 255},
      {spectrum: 255, waveform: 0},
      {spectrum: 255, waveform: 255},
    ])('hands the canvas only finite numbers for an all-$spectrum spectrum and all-$waveform waveform', ({spectrum, waveform}): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.setPlaying(true);
      analyser.spectrum = flat(spectrum);
      analyser.waveform = flat(waveform);

      frames(3, REFRACTORY_MS);

      expect(fakes.unusableCalls()).toEqual([]);
      expect(fakes.unusableSets()).toEqual([]);
    });

    it('hands the canvas only finite numbers on a one-pixel canvas', (): void => {
      viz.resize(1, 1);
      analyser.spectrum = flat(255);
      analyser.waveform = flat(255);

      frames(3);

      expect(fakes.unusableCalls()).toEqual([]);
      expect(fakes.unusableSets()).toEqual([]);
    });

    it('hands the canvas only finite numbers on a 4K canvas with the trail reduced', (): void => {
      viz.resize(3840, 2160);
      analyser.waveform = flat(255);

      frames(3);

      expect(fakes.unusableCalls()).toEqual([]);
      expect(fakes.unusableSets()).toEqual([]);
    });

    it('hands the canvas nothing unusable when drawn before the first resize', (): void => {
      analyser.waveform = flat(255);

      frames(3);

      expect(fakes.unusableCalls()).toEqual([]);
      expect(fakes.unusableSets()).toEqual([]);
    });

    it.each([
      {width: 0, height: 0},
      {width: 0, height: HEIGHT},
      {width: WIDTH, height: 0},
    ])('draws nothing on a $width by $height canvas', ({width, height}): void => {
      viz.resize(width, height);
      fakes.forget();

      frame();

      for (const context of fakes.contexts) {
        expect(context.calls).toEqual([]);
      }
    });

    it('does not read the analyser on a zero-sized canvas', (): void => {
      viz.resize(0, 0);

      frame();

      expect(analyser.spectrumReads).toEqual([]);
      expect(analyser.waveformReads).toEqual([]);
    });
  });
});

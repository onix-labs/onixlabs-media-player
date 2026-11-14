/**
 * @fileoverview Unit tests for the Reactor visualization.
 *
 * Tests cover:
 * - Layout: surface creation and sizing, the rings-trail pixel budget
 * - Tower: draw order, caching between hue steps, invalidation on resize
 * - Frequency rings: silence, the peak threshold, full rings and single teeth
 * - Horizontal waveforms: rest position, bending, mirroring and the bend clamp
 * - Trails: per-frame spin, fade and compositing
 * - Bass trigger: grace period, cooldown, spin reversal, hue cross-fade, flash
 * - Fade-out and idling, fixed-look setters, FFT size changes, destroy
 * - Edge inputs never hand the canvas a NaN or an infinity
 *
 * Canvas 2D and Web Audio are faked; see visualization-test-fakes.group1.
 *
 * @module app/components/audio/audio-outlet/visualizations/reactor-visualization.spec
 */

import {ReactorVisualization} from './reactor-visualization';
import {Visualization} from './visualization';
import {
  bassHeavy,
  CanvasFakes,
  FakeAnalyser,
  flat,
  installCanvasFakes,
  RecordedCall,
  RecordingContext2D,
  spike,
} from './visualization-test-fakes.group1';

// ============================================================================
// Fixture geometry
// ============================================================================

/** Canvas size most tests run at. */
const WIDTH: number = 800;
const HEIGHT: number = 600;

/** Radius of the outermost of the eight circles: half the width, times 1.05. */
const OUTER_RADIUS: number = 420;

/** Radius of the innermost circle, an eighth of the outer one. */
const CORE_RADIUS: number = 52.5;

/** Half the trail square: the outer radius plus a 16px margin. */
const TRAIL_CENTRE: number = 436;
const TRAIL_SIZE: number = 872;

/** Where the simulated clock starts, in milliseconds. */
const START_MS: number = 100_000;

/** Gap the bass trigger enforces between hits, in milliseconds. */
const COOLDOWN_MS: number = 10_000;

/** The surfaces Reactor creates, in the order it creates them. */
interface Surfaces {
  readonly main: RecordingContext2D;
  readonly rings: RecordingContext2D;
  readonly horizontal: RecordingContext2D;
  readonly scratch: RecordingContext2D;
  readonly ringsScratch: RecordingContext2D;
  readonly tower: RecordingContext2D;
  readonly freeze: RecordingContext2D;
}

/** Distance of a recorded point from the trail centre. */
function radiusOf(x: number, y: number): number {
  return Math.hypot(x - TRAIL_CENTRE, y - TRAIL_CENTRE);
}

/** Sum of the channels of an `rgb(r, g, b)` string, as a measure of brightness. */
function brightnessOf(colour: unknown): number {
  const channels: RegExpMatchArray | null = String(colour).match(/\d+/g);
  return (channels ?? []).reduce((total: number, channel: string): number => total + Number(channel), 0);
}

describe('ReactorVisualization', (): void => {
  let fakes: CanvasFakes;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let viz: ReactorVisualization;
  let now: number;

  /** The recording contexts, named for the surface each belongs to. */
  function surfaces(): Surfaces {
    const [main, rings, horizontal, scratch, ringsScratch, tower, freeze]: RecordingContext2D[] = fakes.contexts;
    return {main, rings, horizontal, scratch, ringsScratch, tower, freeze};
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

  /** Draws the frame that seeds the trigger's grace period, then waits it out. */
  function passGracePeriod(): void {
    frame();
    now += COOLDOWN_MS;
  }

  /** The angle the horizontal trail was last rotated by. */
  function lastTrailRotation(): number {
    return surfaces().horizontal.callsTo('rotate').at(-1)?.args[0] as number;
  }

  /** The white washes laid over the main canvas by a flash. */
  function flashWashes(): RecordedCall[] {
    return surfaces().main.callsTo('fillRect')
      .filter((call: RecordedCall): boolean => call.state.fillStyle === 'rgb(255, 255, 255)');
  }

  /** The times the frozen old-hue tower was laid over the main canvas. */
  function crossFades(): RecordedCall[] {
    const frozen: HTMLCanvasElement = surfaces().freeze.canvas;
    return surfaces().main.callsTo('drawImage')
      .filter((call: RecordedCall): boolean => call.args[0] === frozen);
  }

  beforeEach((): void => {
    fakes = installCanvasFakes();
    now = START_MS;
    vi.spyOn(performance, 'now').mockImplementation((): number => now);
    vi.spyOn(Math, 'random').mockReturnValue(0.9);

    analyser = new FakeAnalyser();
    canvas = document.createElement('canvas');
    viz = new ReactorVisualization({canvas, analyser: analyser.asNode()});
  });

  afterEach((): void => {
    fakes.restore();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Identity
  // ==========================================================================

  describe('identity', (): void => {
    it('is listed as Reactor under Signature', (): void => {
      expect(viz.name).toBe('Reactor');
      expect(viz.category).toBe('Signature');
    });
  });

  // ==========================================================================
  // Before it has a size
  // ==========================================================================

  describe('before it has been given a size', (): void => {
    it('draws nothing', (): void => {
      frame();

      expect(surfaces().main.calls).toEqual([]);
    });

    it('does not read the analyser', (): void => {
      frame();

      expect(analyser.spectrumReads).toEqual([]);
      expect(analyser.waveformReads).toEqual([]);
    });

    it('creates no off-screen surfaces', (): void => {
      frame();

      expect(fakes.contexts).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Layout
  // ==========================================================================

  describe('resize', (): void => {
    it('creates its six off-screen surfaces', (): void => {
      viz.resize(WIDTH, HEIGHT);

      expect(fakes.contexts).toHaveLength(7);
    });

    it('makes the horizontal trail and its scratch a square that holds the outer circle', (): void => {
      viz.resize(WIDTH, HEIGHT);

      const {horizontal, scratch}: Surfaces = surfaces();
      expect([horizontal.canvas.width, horizontal.canvas.height]).toEqual([TRAIL_SIZE, TRAIL_SIZE]);
      expect([scratch.canvas.width, scratch.canvas.height]).toEqual([TRAIL_SIZE, TRAIL_SIZE]);
    });

    it('keeps the rings trail at full size while it fits the pixel budget', (): void => {
      viz.resize(WIDTH, HEIGHT);

      const {rings, ringsScratch}: Surfaces = surfaces();
      expect([rings.canvas.width, rings.canvas.height]).toEqual([TRAIL_SIZE, TRAIL_SIZE]);
      expect([ringsScratch.canvas.width, ringsScratch.canvas.height]).toEqual([TRAIL_SIZE, TRAIL_SIZE]);
    });

    it('shrinks the rings trail to the pixel budget on a 4K canvas', (): void => {
      viz.resize(3840, 2160);

      // Trail square is 4064px; 1280x720 worth of pixels is a 960px square.
      const {rings, ringsScratch, horizontal}: Surfaces = surfaces();
      expect([rings.canvas.width, rings.canvas.height]).toEqual([960, 960]);
      expect([ringsScratch.canvas.width, ringsScratch.canvas.height]).toEqual([960, 960]);
      expect(horizontal.canvas.width).toBe(4064);
    });

    it('maps trail coordinates onto the shrunken rings trail', (): void => {
      viz.resize(3840, 2160);

      const scale: number = 960 / 4064;
      expect(surfaces().rings.callsTo('setTransform').at(-1)?.args).toEqual([scale, 0, 0, scale, 0, 0]);
    });

    it('sizes the tower layers to the visible canvas', (): void => {
      viz.resize(WIDTH, HEIGHT);

      const {tower, freeze}: Surfaces = surfaces();
      expect([tower.canvas.width, tower.canvas.height]).toEqual([WIDTH, HEIGHT]);
      expect([freeze.canvas.width, freeze.canvas.height]).toEqual([WIDTH, HEIGHT]);
    });

    it('clears the main canvas', (): void => {
      viz.resize(WIDTH, HEIGHT);

      expect(surfaces().main.callsTo('clearRect').at(-1)?.args).toEqual([0, 0, WIDTH, HEIGHT]);
    });

    it('reuses the existing surfaces when resized again', (): void => {
      viz.resize(WIDTH, HEIGHT);
      const before: RecordingContext2D[] = [...fakes.contexts];

      viz.resize(400, 300);

      expect(fakes.contexts).toEqual(before);
    });

    it('leaves the surfaces unsized, and so uncleared, when resized to the same size', (): void => {
      viz.resize(WIDTH, HEIGHT);
      const {horizontal, rings, tower}: Surfaces = surfaces();
      const sized: ReturnType<typeof vi.spyOn>[] = [horizontal, rings, tower]
        .map((surface: RecordingContext2D): ReturnType<typeof vi.spyOn> => vi.spyOn(surface.canvas, 'width', 'set'));

      viz.resize(WIDTH, HEIGHT);

      for (const widthSetter of sized) {
        expect(widthSetter).not.toHaveBeenCalled();
      }
    });

    it('rebuilds the surface sizes when resized again', (): void => {
      viz.resize(WIDTH, HEIGHT);

      viz.resize(400, 300);

      // Outer radius 210, plus the margin: a 452px trail square.
      const {horizontal, rings, tower}: Surfaces = surfaces();
      expect(horizontal.canvas.width).toBe(452);
      expect(rings.canvas.width).toBe(452);
      expect([tower.canvas.width, tower.canvas.height]).toEqual([400, 300]);
    });
  });

  // ==========================================================================
  // Tower
  // ==========================================================================

  describe('tower', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
    });

    it('fills the background before any circle', (): void => {
      frame();

      const methods: string[] = surfaces().tower.calls.map((call: RecordedCall): string => call.method);
      expect(methods.indexOf('fillRect')).toBeLessThan(methods.indexOf('arc'));
      expect(surfaces().tower.callsTo('fillRect')[0].args).toEqual([0, 0, WIDTH, HEIGHT]);
    });

    it('draws eight equally spaced circles about the centre, largest first', (): void => {
      frame();

      const arcs: RecordedCall[] = surfaces().tower.callsTo('arc');
      const radii: unknown[] = arcs.map((call: RecordedCall): unknown => call.args[2]);
      expect(radii).toEqual([420, 367.5, 315, 262.5, 210, 157.5, 105, 52.5]);
      for (const arc of arcs) {
        expect(arc.args.slice(0, 2)).toEqual([WIDTH / 2, HEIGHT / 2]);
      }
    });

    it('makes every circle brighter than the one outside it', (): void => {
      frame();

      const levels: number[] = surfaces().tower.callsTo('fill')
        .map((call: RecordedCall): number => brightnessOf(call.state.fillStyle));
      expect(levels).toHaveLength(8);
      for (let i: number = 1; i < levels.length; i++) {
        expect(levels[i]).toBeGreaterThan(levels[i - 1]);
      }
    });

    it('uses a background darker than the darkest circle', (): void => {
      frame();

      const {tower}: Surfaces = surfaces();
      const background: number = brightnessOf(tower.callsTo('fillRect')[0].state.fillStyle);
      const darkest: number = brightnessOf(tower.callsTo('fill')[0].state.fillStyle);
      expect(background).toBeLessThan(darkest);
    });

    it('is composited from its cached layer while the hue stays within a degree', (): void => {
      frame();
      fakes.forget();

      frames(5);

      expect(surfaces().tower.calls).toEqual([]);
      expect(surfaces().main.callsTo('drawImage')
        .filter((call: RecordedCall): boolean => call.args[0] === surfaces().tower.canvas)).toHaveLength(5);
    });

    it('is repainted in new colours once the hue reaches the next degree', (): void => {
      frame();

      // The hue drifts 0.05 degrees a frame, so 25 frames cross exactly one degree.
      frames(25);

      const {tower}: Surfaces = surfaces();
      const fills: RecordedCall[] = tower.callsTo('fill');
      expect(tower.callsTo('fillRect')).toHaveLength(2);
      expect(fills).toHaveLength(16);
      expect(fills[15].state.fillStyle).not.toBe(fills[7].state.fillStyle);
    });

    it('is repainted at the new size after a resize', (): void => {
      frame();
      fakes.forget();

      viz.resize(400, 300);
      frame();

      expect(surfaces().tower.callsTo('fillRect')[0].args).toEqual([0, 0, 400, 300]);
      expect(surfaces().tower.callsTo('arc')[0].args.slice(0, 3)).toEqual([200, 150, 210]);
    });
  });

  // ==========================================================================
  // Frequency rings
  // ==========================================================================

  describe('frequency rings', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
    });

    it('draws no peaks in silence', (): void => {
      frame();

      const {rings}: Surfaces = surfaces();
      expect(rings.callsTo('moveTo')).toEqual([]);
      expect(rings.callsTo('quadraticCurveTo')).toEqual([]);
    });

    it('draws no peaks for a spectrum just under the peak threshold', (): void => {
      // 146/255 at the fixed 10% sensitivity is 0.1145, under the 0.115 threshold.
      analyser.spectrum = flat(146);

      frame();

      expect(surfaces().rings.callsTo('moveTo')).toEqual([]);
    });

    it('raises every ring to its ceiling for a spectrum just over the peak threshold', (): void => {
      // 147/255 at the fixed 10% sensitivity is 0.1153.
      analyser.spectrum = flat(147);

      frame();

      // A ring with every sample raised is a whole annulus: the inner edge
      // starts with a moveTo onto the ring's own circle.
      const innerEdges: number[] = surfaces().rings.callsTo('moveTo')
        .map((call: RecordedCall): number => radiusOf(call.args[0] as number, call.args[1] as number));
      expect(innerEdges).toEqual([52.5, 105, 157.5, 210, 262.5, 315, 367.5]);
    });

    it('draws a full ring without any tooth corners', (): void => {
      analyser.spectrum = flat(255);

      frame();

      expect(surfaces().rings.callsTo('quadraticCurveTo')).toEqual([]);
    });

    it('draws a single loud bin as one tooth mirrored across the ring', (): void => {
      // Bin 100 of 1024 falls in the second ring's logarithmic bucket.
      analyser.spectrum = spike(100);

      frame();

      const {rings}: Surfaces = surfaces();
      const starts: RecordedCall[] = rings.callsTo('moveTo');
      expect(rings.callsTo('closePath')).toHaveLength(2);
      expect(starts).toHaveLength(2);
      expect((starts[0].args[0] as number) + (starts[1].args[0] as number)).toBeCloseTo(TRAIL_CENTRE * 2, 6);
      expect((starts[0].args[1] as number) + (starts[1].args[1] as number)).toBeCloseTo(TRAIL_CENTRE * 2, 6);
    });

    it('stands a tooth between its own circle and the next one out', (): void => {
      analyser.spectrum = spike(100);

      frame();

      // Second ring: baseline on the 105px circle, ceiling on the 157.5px one.
      const reach: number[] = surfaces().rings.callsTo('lineTo')
        .map((call: RecordedCall): number => radiusOf(call.args[0] as number, call.args[1] as number));
      expect(Math.min(...reach)).toBeGreaterThan(105);
      expect(Math.max(...reach)).toBeLessThan(157.5);
      const ceilings: RecordedCall[] = surfaces().rings.callsTo('arc')
        .filter((call: RecordedCall): boolean => call.args[3] !== 0 && call.args[5] === false);
      expect(ceilings.map((call: RecordedCall): unknown => call.args[2])).toEqual([157.5, 157.5]);
    });

    it('rounds the corners of a wide tooth by sixteen pixels', (): void => {
      // Half of the second ring's bucket: one long run per repeat.
      analyser.spectrum = (index: number): number => (index >= 78 && index <= 98 ? 255 : 0);

      frame();

      const {rings}: Surfaces = surfaces();
      const footOfWall: RecordedCall = rings.callsTo('moveTo')[0];
      const topOfWall: RecordedCall = rings.callsTo('lineTo')[0];
      expect(radiusOf(footOfWall.args[0] as number, footOfWall.args[1] as number)).toBeCloseTo(105 + 16, 9);
      expect(radiusOf(topOfWall.args[0] as number, topOfWall.args[1] as number)).toBeCloseTo(157.5 - 16, 9);
    });

    it('rounds the corners of a narrow tooth by no more than half its width', (): void => {
      // A single bin is two samples wide: about 10px of arc on the 105px circle.
      analyser.spectrum = spike(100);

      frame();

      const footOfWall: RecordedCall = surfaces().rings.callsTo('moveTo')[0];
      const cornerRadius: number = radiusOf(footOfWall.args[0] as number, footOfWall.args[1] as number) - 105;
      expect(cornerRadius).toBeCloseTo(2 * (Math.PI * 2 / 128) * 105 / 2, 9);
    });

    it('rounds the corners of a tooth by no more than half the height of a shallow band', (): void => {
      // On an 80px canvas the second ring's band runs from 10.5px to 15.75px.
      viz.resize(80, 60);
      analyser.spectrum = (index: number): number => (index >= 78 && index <= 98 ? 255 : 0);

      frame();

      // With corners half the band high, the wall has no straight part left.
      const {rings}: Surfaces = surfaces();
      const footOfWall: RecordedCall = rings.callsTo('moveTo')[0];
      const topOfWall: RecordedCall = rings.callsTo('lineTo')[0];
      const smallTrailCentre: number = 58;
      const midBand: number = (10.5 + 15.75) / 2;
      expect(Math.hypot((footOfWall.args[0] as number) - smallTrailCentre, (footOfWall.args[1] as number) - smallTrailCentre))
        .toBeCloseTo(midBand, 9);
      expect(Math.hypot((topOfWall.args[0] as number) - smallTrailCentre, (topOfWall.args[1] as number) - smallTrailCentre))
        .toBeCloseTo(midBand, 9);
    });

    it('fills each ring faintly in the colour of the circle it sits on', (): void => {
      analyser.spectrum = flat(255);

      frame();

      const {rings, tower}: Surfaces = surfaces();
      const circleColours: unknown[] = tower.callsTo('fill')
        .map((call: RecordedCall): unknown => call.state.fillStyle)
        .reverse();
      const ringFills: RecordedCall[] = rings.callsTo('fill');
      expect(ringFills).toHaveLength(7);
      expect(ringFills.map((call: RecordedCall): unknown => call.state.fillStyle)).toEqual(circleColours.slice(0, 7));
      for (const fill of ringFills) {
        expect(fill.state.globalAlpha).toBe(0.15);
      }
    });
  });

  // ==========================================================================
  // Horizontal waveforms
  // ==========================================================================

  describe('horizontal waveforms', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
    });

    it('lie flat along the centre line when the waveform is at rest', (): void => {
      frame();

      for (const start of surfaces().horizontal.callsTo('moveTo')) {
        expect(start.args[1]).toBeCloseTo(TRAIL_CENTRE, 6);
      }
      for (const end of surfaces().horizontal.callsTo('lineTo')) {
        expect(end.args[1]).toBeCloseTo(TRAIL_CENTRE, 6);
      }
    });

    it('run from the outer circle in to the core', (): void => {
      frame();

      const {horizontal}: Surfaces = surfaces();
      expect(horizontal.callsTo('moveTo')[0].args[0]).toBeCloseTo(TRAIL_CENTRE - OUTER_RADIUS, 6);
      expect(horizontal.callsTo('lineTo')[0].args[0]).toBeCloseTo(TRAIL_CENTRE - CORE_RADIUS, 6);
    });

    it('bend off the centre line when the waveform is deflected', (): void => {
      analyser.waveform = flat(255);

      frame();

      const start: RecordedCall = surfaces().horizontal.callsTo('moveTo')[0];
      expect(Math.abs((start.args[1] as number) - TRAIL_CENTRE)).toBeGreaterThan(50);
      expect(radiusOf(start.args[0] as number, start.args[1] as number)).toBeCloseTo(OUTER_RADIUS, 6);
    });

    it('draw the right waveform as the left turned half a turn about the centre', (): void => {
      analyser.waveform = (index: number): number => 128 + ((index * 7) % 100);

      frame();

      // Each waveform is stroked three times (glow, body, highlight): the left
      // one first, then the right.
      const starts: RecordedCall[] = surfaces().horizontal.callsTo('moveTo');
      const left: RecordedCall = starts[0];
      const right: RecordedCall = starts[3];
      expect(starts).toHaveLength(6);
      expect((left.args[0] as number) + (right.args[0] as number)).toBeCloseTo(TRAIL_CENTRE * 2, 6);
      expect((left.args[1] as number) + (right.args[1] as number)).toBeCloseTo(TRAIL_CENTRE * 2, 6);
    });

    it.each([
      {deflection: 'upward', sample: 255, angle: Math.PI - 1.5},
      {deflection: 'downward', sample: 0, angle: Math.PI + 1.5},
    ])('never bend further than 1.5 radians round the core for a full $deflection deflection', ({sample, angle}): void => {
      analyser.waveform = flat(sample);

      frame();

      const innerEnd: RecordedCall = surfaces().horizontal.callsTo('lineTo')[0];
      expect(innerEnd.args[0]).toBeCloseTo(TRAIL_CENTRE + CORE_RADIUS * Math.cos(angle), 6);
      expect(innerEnd.args[1]).toBeCloseTo(TRAIL_CENTRE + CORE_RADIUS * Math.sin(angle), 6);
    });

    it('take the colour of the brightest circle', (): void => {
      frame();

      const {horizontal, tower}: Surfaces = surfaces();
      const brightest: unknown = tower.callsTo('fill').at(-1)?.state.fillStyle;
      const bodyStroke: RecordedCall = horizontal.callsTo('stroke')[1];
      expect(bodyStroke.state.strokeStyle).toBe(brightest);
    });
  });

  // ==========================================================================
  // Trails
  // ==========================================================================

  describe('trails', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
    });

    it('turns the horizontal trail by the same small angle every frame', (): void => {
      frames(3);

      const angles: unknown[] = surfaces().horizontal.callsTo('rotate')
        .map((call: RecordedCall): unknown => call.args[0]);
      expect(angles).toEqual([0.005, 0.005, 0.005]);
    });

    it('fades the horizontal trail by one percent a frame', (): void => {
      frame();

      const redraw: RecordedCall = surfaces().horizontal.callsTo('drawImage')[0];
      expect(redraw.args[0]).toBe(surfaces().scratch.canvas);
      expect(redraw.state.globalAlpha).toBeCloseTo(0.99, 10);
    });

    it('redraws the rings trail in the same number of slices every frame', (): void => {
      frame();
      const perFrame: number = surfaces().rings.callsTo('drawImage').length;
      fakes.forget();

      frames(20);

      // Seven bands of thirty-two slices each.
      expect(perFrame).toBe(224);
      expect(surfaces().rings.callsTo('drawImage')).toHaveLength(perFrame * 20);
    });

    it('fades the rings trail by one and a half percent a frame', (): void => {
      frame();

      for (const redraw of surfaces().rings.callsTo('drawImage')) {
        expect(redraw.state.globalAlpha).toBeCloseTo(0.985, 10);
      }
    });

    it('squashes each ring slice outward toward the next circle', (): void => {
      frame();

      const scales: number[] = surfaces().rings.callsTo('scale')
        .map((call: RecordedCall): number => call.args[0] as number);
      expect(Math.min(...scales)).toBeGreaterThan(1);
      expect(Math.max(...scales)).toBeLessThan(1.01);
    });

    it('adds the rings trail, then the horizontal trail, over the tower', (): void => {
      frame();

      const {main, tower, rings, horizontal}: Surfaces = surfaces();
      const layers: RecordedCall[] = main.callsTo('drawImage');
      expect(layers.map((call: RecordedCall): unknown => call.args[0]))
        .toEqual([tower.canvas, rings.canvas, horizontal.canvas]);
      expect(layers[0].state.globalCompositeOperation).toBe('source-over');
      expect(layers[1].state.globalCompositeOperation).toBe('lighter');
      expect(layers[2].state.globalCompositeOperation).toBe('lighter');
    });

    it('centres the oversized trails on the canvas', (): void => {
      frame();

      const layers: RecordedCall[] = surfaces().main.callsTo('drawImage');
      const offset: number[] = [WIDTH / 2 - TRAIL_CENTRE, HEIGHT / 2 - TRAIL_CENTRE];
      expect(layers[1].args.slice(1)).toEqual([...offset, TRAIL_SIZE, TRAIL_SIZE]);
      expect(layers[2].args.slice(1)).toEqual(offset);
    });
  });

  // ==========================================================================
  // Bass trigger
  // ==========================================================================

  describe('bass trigger', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
    });

    it('holds off for ten seconds after the first frame, however loud the bass', (): void => {
      analyser.spectrum = bassHeavy(64);

      frame();
      frames(9, 1000);

      expect(lastTrailRotation()).toBe(0.005);
      expect(crossFades()).toEqual([]);
    });

    it('reverses the spin on a bass hit once the ten seconds are up', (): void => {
      passGracePeriod();
      analyser.spectrum = bassHeavy(64);

      frame();

      expect(lastTrailRotation()).toBe(-0.005);
    });

    it('reverses the spin of the rings trail too', (): void => {
      passGracePeriod();
      analyser.spectrum = bassHeavy(64);

      frame();

      expect(surfaces().rings.callsTo('rotate').at(-1)?.args[0]).toBe(-0.005);
    });

    it('ignores bass below the threshold', (): void => {
      passGracePeriod();
      // 127/255 is just under the 0.5 threshold.
      analyser.spectrum = flat(127);

      frames(5, 4000);

      expect(lastTrailRotation()).toBe(0.005);
    });

    it('ignores loud treble with no bass under it', (): void => {
      passGracePeriod();
      analyser.spectrum = (index: number): number => (index < 30 ? 0 : 255);

      frame();

      expect(lastTrailRotation()).toBe(0.005);
    });

    it('does not act again until another ten seconds have passed', (): void => {
      passGracePeriod();
      analyser.spectrum = bassHeavy(64);
      frame();

      frames(9, 1000);

      expect(lastTrailRotation()).toBe(-0.005);
    });

    it('acts again once another ten seconds have passed', (): void => {
      passGracePeriod();
      analyser.spectrum = bassHeavy(64);
      frame();

      frames(10, 1000);

      expect(lastTrailRotation()).toBe(0.005);
    });

    it('measures the cooldown in elapsed time rather than in frames', (): void => {
      passGracePeriod();
      analyser.spectrum = bassHeavy(64);
      frame();

      // Many frames, little time.
      frames(50, 1);
      const afterManyFrames: number = lastTrailRotation();
      // One frame, much time.
      frame(COOLDOWN_MS);

      expect(afterManyFrames).toBe(-0.005);
      expect(lastTrailRotation()).toBe(0.005);
    });

    it('snapshots the old tower before the hue jumps', (): void => {
      passGracePeriod();
      analyser.spectrum = bassHeavy(64);

      frame();

      const {freeze, tower}: Surfaces = surfaces();
      expect(freeze.callsTo('drawImage')).toHaveLength(1);
      expect(freeze.callsTo('drawImage')[0].args).toEqual([tower.canvas, 0, 0]);
    });

    it('repaints the tower in the jumped hue on the same frame', (): void => {
      passGracePeriod();
      const before: unknown = surfaces().tower.callsTo('fill').at(-1)?.state.fillStyle;
      analyser.spectrum = bassHeavy(64);

      frame();

      expect(surfaces().tower.callsTo('fillRect')).toHaveLength(2);
      expect(surfaces().tower.callsTo('fill').at(-1)?.state.fillStyle).not.toBe(before);
    });

    it('lays the old tower over the new one and fades it out frame by frame', (): void => {
      passGracePeriod();
      analyser.spectrum = bassHeavy(64);

      frames(3);

      const strengths: number[] = crossFades().map((call: RecordedCall): number => call.state.globalAlpha);
      expect(strengths[0]).toBe(1);
      expect(strengths[1]).toBeCloseTo(0.995, 10);
      expect(strengths[2]).toBeCloseTo(0.99, 10);
    });

    it('finishes the cross-fade and stops drawing the old tower', (): void => {
      passGracePeriod();
      analyser.spectrum = bassHeavy(64);
      frames(205);
      fakes.forget();

      frames(5);

      expect(crossFades()).toEqual([]);
    });

    it('flashes the frame white when the roll comes up', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      passGracePeriod();
      analyser.spectrum = bassHeavy(64);

      frames(2);

      const washes: RecordedCall[] = flashWashes();
      expect(washes[0].args).toEqual([0, 0, WIDTH, HEIGHT]);
      expect(washes[0].state.globalAlpha).toBe(1);
      expect(washes[1].state.globalAlpha).toBeCloseTo(0.99, 10);
    });

    it('lays the horizontal waveform back over the flash in a dark shade', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      passGracePeriod();
      analyser.spectrum = bassHeavy(64);

      frame();

      const {main, scratch, tower}: Surfaces = surfaces();
      const recolour: RecordedCall | undefined = scratch.callsTo('fillRect').at(-1);
      expect(recolour?.state.globalCompositeOperation).toBe('source-in');
      expect(brightnessOf(recolour?.state.fillStyle))
        .toBeLessThan(brightnessOf(tower.callsTo('fill').at(-1)?.state.fillStyle));
      expect(main.callsTo('drawImage').at(-1)?.args[0]).toBe(scratch.canvas);
    });

    it('does not flash when the roll does not come up', (): void => {
      passGracePeriod();
      analyser.spectrum = bassHeavy(64);

      frames(3);

      expect(flashWashes()).toEqual([]);
    });

    it('lets a flash die away completely', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      passGracePeriod();
      analyser.spectrum = bassHeavy(64);
      frames(105);
      fakes.forget();

      frames(5);

      expect(flashWashes()).toEqual([]);
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

    it('draws without any fade overlay once playback has faded in', (): void => {
      viz.setPlaying(true);
      frame(500);

      expect(fadeOverlays()).toEqual([]);
    });

    it('drops the fade overlay as soon as playback restarts mid fade-out', (): void => {
      viz.setPlaying(true);
      viz.setPlaying(false);
      frame(2500);
      fakes.forget();

      viz.setPlaying(true);
      frame();

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

      expect(viz.getSensitivity()).toBe(0.1);
    });

    it('ignores the trail intensity control', (): void => {
      controls().setTrailIntensity(0);

      expect(viz.getTrailIntensity()).toBe(1);
    });

    it('ignores the line width control', (): void => {
      controls().setLineWidth(5);

      expect(viz.getLineWidth()).toBe(1);
    });

    it('ignores the glow control', (): void => {
      controls().setGlowIntensity(1);

      expect(viz.getGlowIntensity()).toBe(0);
    });

    it('ignores the waveform smoothing control', (): void => {
      controls().setWaveformSmoothing(0);

      expect(viz.getWaveformSmoothing()).toBe(1);
    });

    it('keeps drawing peaks at the fixed sensitivity after the control is moved', (): void => {
      viz.resize(WIDTH, HEIGHT);
      controls().setSensitivity(1);
      // Would clear the threshold at full sensitivity, but not at the fixed 10%.
      analyser.spectrum = flat(100);

      frame();

      expect(surfaces().rings.callsTo('moveTo')).toEqual([]);
    });
  });

  // ==========================================================================
  // FFT size
  // ==========================================================================

  describe('FFT size', (): void => {
    it('reads buffers sized for the analyser it was built with', (): void => {
      viz.resize(WIDTH, HEIGHT);

      frame();

      expect(analyser.spectrumReads).toEqual([1024]);
      expect(analyser.waveformReads).toEqual([2048]);
    });

    it('reads once per frame into buffers of the new size after a change', (): void => {
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

      viz.destroy();
      frame();

      expect(fakes.contexts).toHaveLength(7);
      expect(analyser.spectrumReads).toEqual([]);
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
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      viz.resize(WIDTH, HEIGHT);
      viz.setPlaying(true);
      analyser.spectrum = flat(spectrum);
      analyser.waveform = flat(waveform);

      frame();
      frames(3, COOLDOWN_MS);

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
  });
});

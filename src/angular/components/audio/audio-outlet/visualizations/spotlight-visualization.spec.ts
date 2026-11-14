/**
 * @fileoverview Unit tests for the Spotlight visualization.
 *
 * Tests cover:
 * - Layout: surface creation and sizing, the trail pixel budget
 * - Tower: draw order, rim borders, caching between hue steps, invalidation
 * - Frequency rings: silence, the peak threshold, full rings and single teeth
 * - Trail: per-band counter-rotation, fade and compositing
 * - Bass trigger: cooldown, hue cross-fade and the spin re-roll
 * - Fade-out and idling, fixed-look setters, FFT size changes, destroy
 * - Edge inputs
 *
 * Canvas 2D and Web Audio are faked; see visualization-test-fakes.group1.
 *
 * @module app/components/audio/audio-outlet/visualizations/spotlight-visualization.spec
 */

import {SpotlightVisualization} from './spotlight-visualization';
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

/** Number of circles in the tower. */
const CIRCLES: number = 14;

/** Radius of the outermost circle: half the width, times 1.25. */
const OUTER_RADIUS: number = 500;

/** Half the trail square: the outer radius plus a 15px margin. */
const TRAIL_CENTRE: number = 515;
const TRAIL_SIZE: number = 1030;

/** Side of the trail surface once the 1030px square is held to its budget. */
const BUDGETED_TRAIL_SIZE: number = 960;

/** Rings that have a circle on both sides, and so a band of the trail to spin. */
const BANDS: number = 13;

/** Where the simulated clock starts, in milliseconds. */
const START_MS: number = 100_000;

/** The surfaces Spotlight creates, in the order it creates them. */
interface Surfaces {
  readonly main: RecordingContext2D;
  readonly rings: RecordingContext2D;
  readonly scratch: RecordingContext2D;
  readonly tower: RecordingContext2D;
  readonly freeze: RecordingContext2D;
}

/** Radius of the tower circle at `index`, counting out from the centre. */
function circleRadius(index: number): number {
  return OUTER_RADIUS * (index + 1) / CIRCLES;
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

describe('SpotlightVisualization', (): void => {
  let fakes: CanvasFakes;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let viz: SpotlightVisualization;
  let now: number;

  /** The recording contexts, named for the surface each belongs to. */
  function surfaces(): Surfaces {
    const [main, rings, scratch, tower, freeze]: RecordingContext2D[] = fakes.contexts;
    return {main, rings, scratch, tower, freeze};
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

  /** The angles each band of the trail was turned by, innermost first. */
  function bandRotations(): unknown[] {
    return surfaces().rings.callsTo('rotate').map((call: RecordedCall): unknown => call.args[0]);
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
    viz = new SpotlightVisualization({canvas, analyser: analyser.asNode()});
  });

  afterEach((): void => {
    fakes.restore();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Identity
  // ==========================================================================

  describe('identity', (): void => {
    it('is listed as Spotlight under Signature', (): void => {
      expect(viz.name).toBe('Spotlight');
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
    it('creates its four off-screen surfaces', (): void => {
      viz.resize(WIDTH, HEIGHT);

      expect(fakes.contexts).toHaveLength(5);
    });

    it('keeps the trail a full-size square while it fits the pixel budget', (): void => {
      viz.resize(400, 300);

      // Outer radius 250, plus the margin: a 530px trail square.
      const {rings, scratch}: Surfaces = surfaces();
      expect([rings.canvas.width, rings.canvas.height]).toEqual([530, 530]);
      expect([scratch.canvas.width, scratch.canvas.height]).toEqual([530, 530]);
    });

    it('shrinks the trail and its scratch to the pixel budget once it would exceed it', (): void => {
      viz.resize(WIDTH, HEIGHT);

      // The 1030px square exceeds 1280x720 worth of pixels, which is a 960px square.
      const {rings, scratch}: Surfaces = surfaces();
      expect([rings.canvas.width, rings.canvas.height]).toEqual([BUDGETED_TRAIL_SIZE, BUDGETED_TRAIL_SIZE]);
      expect([scratch.canvas.width, scratch.canvas.height]).toEqual([BUDGETED_TRAIL_SIZE, BUDGETED_TRAIL_SIZE]);
    });

    it('maps trail coordinates onto the shrunken trail', (): void => {
      viz.resize(WIDTH, HEIGHT);

      const scale: number = BUDGETED_TRAIL_SIZE / TRAIL_SIZE;
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
      const {rings, tower}: Surfaces = surfaces();
      const sized: ReturnType<typeof vi.spyOn>[] = [rings, tower]
        .map((surface: RecordingContext2D): ReturnType<typeof vi.spyOn> => vi.spyOn(surface.canvas, 'width', 'set'));

      viz.resize(WIDTH, HEIGHT);

      for (const widthSetter of sized) {
        expect(widthSetter).not.toHaveBeenCalled();
      }
    });

    it('rebuilds the surface sizes when resized again', (): void => {
      viz.resize(WIDTH, HEIGHT);

      viz.resize(400, 300);

      const {rings, tower}: Surfaces = surfaces();
      expect(rings.canvas.width).toBe(530);
      expect([tower.canvas.width, tower.canvas.height]).toEqual([400, 300]);
      expect(rings.callsTo('setTransform').at(-1)?.args).toEqual([1, 0, 0, 1, 0, 0]);
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

    it('draws fourteen equally spaced circles about the centre, largest first', (): void => {
      frame();

      const arcs: RecordedCall[] = surfaces().tower.callsTo('arc');
      expect(arcs).toHaveLength(CIRCLES);
      arcs.forEach((arc: RecordedCall, drawn: number): void => {
        expect(arc.args.slice(0, 2)).toEqual([WIDTH / 2, HEIGHT / 2]);
        expect(arc.args[2]).toBeCloseTo(circleRadius(CIRCLES - 1 - drawn), 9);
      });
    });

    it('makes every circle brighter than the one outside it', (): void => {
      frame();

      const levels: number[] = surfaces().tower.callsTo('fill')
        .map((call: RecordedCall): number => brightnessOf(call.state.fillStyle));
      expect(levels).toHaveLength(CIRCLES);
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

    it('rims every circle with a thin, soft, translucent dark border', (): void => {
      frame();

      const rims: RecordedCall[] = surfaces().tower.callsTo('stroke');
      expect(rims).toHaveLength(CIRCLES);
      for (const rim of rims) {
        expect(rim.state.strokeStyle).toBe('rgba(0, 0, 0, 0.25)');
        expect(rim.state.shadowColor).toBe('rgba(0, 0, 0, 0.25)');
        expect(rim.state.lineWidth).toBe(1);
        expect(rim.state.shadowBlur).toBe(1);
      }
    });

    it('is composited from its cached layer while the hue stays within a degree', (): void => {
      frame();
      fakes.forget();

      frames(5);

      const {main, tower}: Surfaces = surfaces();
      expect(tower.calls).toEqual([]);
      expect(main.callsTo('drawImage')
        .filter((call: RecordedCall): boolean => call.args[0] === tower.canvas)).toHaveLength(5);
    });

    it('is repainted in new colours once the hue reaches the next degree', (): void => {
      frame();

      // The hue drifts 0.08 degrees a frame, so 15 frames cross exactly one degree.
      frames(15);

      const {tower}: Surfaces = surfaces();
      const fills: RecordedCall[] = tower.callsTo('fill');
      expect(tower.callsTo('fillRect')).toHaveLength(2);
      expect(fills).toHaveLength(CIRCLES * 2);
      expect(fills[CIRCLES * 2 - 1].state.fillStyle).not.toBe(fills[CIRCLES - 1].state.fillStyle);
    });

    it('is repainted at the new size after a resize', (): void => {
      frame();
      fakes.forget();

      viz.resize(400, 300);
      frame();

      expect(surfaces().tower.callsTo('fillRect')[0].args).toEqual([0, 0, 400, 300]);
      expect(surfaces().tower.callsTo('arc')[0].args.slice(0, 3)).toEqual([200, 150, 250]);
    });
  });

  // ==========================================================================
  // Frequency rings
  // ==========================================================================

  describe('frequency rings', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
    });

    it('draws no teeth in silence', (): void => {
      frame();

      const {rings}: Surfaces = surfaces();
      expect(rings.callsTo('lineTo')).toEqual([]);
      expect(rings.callsTo('quadraticCurveTo')).toEqual([]);
      expect(rings.callsTo('closePath')).toEqual([]);
    });

    it('leaves a ring on its own circle for a spectrum just under the peak threshold', (): void => {
      // 127/255 at the fixed 10% sensitivity is 0.0996, under the 0.1 threshold.
      analyser.spectrum = flat(127);

      frame();

      // A raised ring is outlined along the next circle out; none is.
      const raised: RecordedCall[] = surfaces().rings.callsTo('arc')
        .filter((call: RecordedCall): boolean => call.state.globalAlpha === 0.1 && call.args.length === 5);
      expect(raised.filter((call: RecordedCall): boolean => typeof call.args[2] === 'number')).toEqual([]);
    });

    it('raises a ring to the next circle out for a spectrum just over the peak threshold', (): void => {
      // 128/255 at the fixed 10% sensitivity is 0.1004.
      analyser.spectrum = flat(128);

      frame();

      // A ring with every sample raised is a whole annulus: its outer edge is
      // an arc along the next circle, drawn at the peak fill opacity.
      const outerEdges: unknown[] = surfaces().rings.callsTo('arc')
        .filter((call: RecordedCall): boolean => call.state.globalAlpha === 0.1 && call.args.length === 5)
        .map((call: RecordedCall): unknown => call.args[2])
        .slice(0, BANDS);
      outerEdges.forEach((radius: unknown, ring: number): void => {
        expect(radius).toBeCloseTo(circleRadius(ring + 1), 9);
      });
      expect(outerEdges).toHaveLength(BANDS);
    });

    it('draws a full ring without any tooth corners', (): void => {
      analyser.spectrum = flat(255);

      frame();

      expect(surfaces().rings.callsTo('quadraticCurveTo')).toEqual([]);
    });

    it('draws a single loud bin as one tooth mirrored across the ring', (): void => {
      // Bin 150 of 1024 falls in the third ring's logarithmic bucket.
      analyser.spectrum = spike(150);

      frame();

      const {rings}: Surfaces = surfaces();
      const walls: RecordedCall[] = rings.callsTo('lineTo');
      expect(rings.callsTo('closePath')).toHaveLength(2);
      // Two walls per tooth; the first wall of each tooth is half a turn apart.
      expect(walls).toHaveLength(4);
      expect((walls[0].args[0] as number) + (walls[2].args[0] as number)).toBeCloseTo(TRAIL_CENTRE * 2, 6);
      expect((walls[0].args[1] as number) + (walls[2].args[1] as number)).toBeCloseTo(TRAIL_CENTRE * 2, 6);
    });

    it('stands a tooth between its own circle and the next one out', (): void => {
      analyser.spectrum = spike(150);

      frame();

      const reach: number[] = surfaces().rings.callsTo('lineTo')
        .map((call: RecordedCall): number => radiusOf(call.args[0] as number, call.args[1] as number));
      expect(Math.min(...reach)).toBeGreaterThan(circleRadius(2));
      expect(Math.max(...reach)).toBeLessThan(circleRadius(3));
    });

    it('rounds the corners of a wide tooth by twelve pixels', (): void => {
      // Half of the third ring's bucket: one long run per repeat.
      analyser.spectrum = (index: number): number => (index >= 135 && index <= 144 ? 255 : 0);

      frame();

      const {rings}: Surfaces = surfaces();
      const footOfWall: RecordedCall = rings.callsTo('moveTo')[0];
      const topOfWall: RecordedCall = rings.callsTo('lineTo')[0];
      expect(radiusOf(footOfWall.args[0] as number, footOfWall.args[1] as number)).toBeCloseTo(circleRadius(2) + 12, 9);
      expect(radiusOf(topOfWall.args[0] as number, topOfWall.args[1] as number)).toBeCloseTo(circleRadius(3) - 12, 9);
    });

    it('rounds the corners of a narrow tooth by no more than half its width', (): void => {
      // A single bin is thirteen samples wide: about 17px of arc on the third circle.
      analyser.spectrum = spike(150);

      frame();

      const footOfWall: RecordedCall = surfaces().rings.callsTo('moveTo')[0];
      const cornerRadius: number =
        radiusOf(footOfWall.args[0] as number, footOfWall.args[1] as number) - circleRadius(2);
      expect(cornerRadius).toBeCloseTo(13 * (Math.PI * 2 / 512) * circleRadius(2) / 2, 9);
    });

    it('rounds the corners of a tooth by no more than half the height of a shallow band', (): void => {
      // On a 200px canvas the circles are under 9px apart.
      viz.resize(200, 150);
      analyser.spectrum = (index: number): number => (index >= 135 && index <= 144 ? 255 : 0);

      frame();

      // With corners half the band high, the wall has no straight part left.
      const {rings}: Surfaces = surfaces();
      const footOfWall: RecordedCall = rings.callsTo('moveTo')[0];
      const topOfWall: RecordedCall = rings.callsTo('lineTo')[0];
      const smallTrailCentre: number = 140;
      const midBand: number = 125 * 3.5 / CIRCLES;
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
      const ringFills: RecordedCall[] = rings.callsTo('fill').slice(0, BANDS);
      expect(ringFills.map((call: RecordedCall): unknown => call.state.fillStyle))
        .toEqual(circleColours.slice(0, BANDS));
      for (const fill of ringFills) {
        expect(fill.state.globalAlpha).toBe(0.1);
      }
    });
  });

  // ==========================================================================
  // Trail
  // ==========================================================================

  describe('trail', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
    });

    it('copies the trail to its scratch surface pixel for pixel before ageing it', (): void => {
      frame();

      const {scratch, rings}: Surfaces = surfaces();
      const copy: RecordedCall = scratch.callsTo('drawImage')[0];
      expect(copy.args).toEqual([rings.canvas, 0, 0]);
      expect(copy.state.globalCompositeOperation).toBe('copy');
    });

    it('turns neighbouring bands in opposite directions', (): void => {
      frame();

      const rotations: unknown[] = bandRotations();
      expect(rotations).toHaveLength(BANDS);
      rotations.forEach((angle: unknown, band: number): void => {
        expect(angle).toBe(band % 2 === 0 ? 0.006 : -0.006);
      });
    });

    it('clips each band to the annulus between its two circles', (): void => {
      frame();

      // Before any ring is drawn the only arcs are the clip paths: outer, then inner.
      const clips: RecordedCall[] = surfaces().rings.callsTo('arc').slice(0, BANDS * 2);
      for (let band: number = 0; band < BANDS; band++) {
        expect(clips[band * 2].args[2]).toBeCloseTo(circleRadius(band + 1), 9);
        expect(clips[band * 2 + 1].args[2]).toBeCloseTo(circleRadius(band), 9);
        expect(clips[band * 2 + 1].args[5]).toBe(true);
      }
      expect(surfaces().rings.callsTo('clip')).toHaveLength(BANDS);
    });

    it('fades the trail by six percent a frame', (): void => {
      frame();

      const redraws: RecordedCall[] = surfaces().rings.callsTo('drawImage');
      expect(redraws).toHaveLength(BANDS);
      for (const redraw of redraws) {
        expect(redraw.state.globalAlpha).toBeCloseTo(0.94, 10);
        expect(redraw.args).toEqual([surfaces().scratch.canvas, 0, 0, TRAIL_SIZE, TRAIL_SIZE]);
      }
    });

    it('redraws the same number of bands every frame', (): void => {
      frames(30);

      expect(surfaces().rings.callsTo('drawImage')).toHaveLength(BANDS * 30);
    });

    it('adds the trail over the tower, centred on the canvas', (): void => {
      frame();

      const {main, tower, rings}: Surfaces = surfaces();
      const layers: RecordedCall[] = main.callsTo('drawImage');
      expect(layers.map((call: RecordedCall): unknown => call.args[0])).toEqual([tower.canvas, rings.canvas]);
      expect(layers[1].state.globalCompositeOperation).toBe('lighter');
      expect(layers[1].args.slice(1))
        .toEqual([WIDTH / 2 - TRAIL_CENTRE, HEIGHT / 2 - TRAIL_CENTRE, TRAIL_SIZE, TRAIL_SIZE]);
    });
  });

  // ==========================================================================
  // Bass trigger
  // ==========================================================================

  describe('bass trigger', (): void => {
    beforeEach((): void => {
      viz.resize(WIDTH, HEIGHT);
    });

    it('does nothing in silence', (): void => {
      frames(5, 4000);

      expect(surfaces().freeze.calls).toEqual([]);
      expect(crossFades()).toEqual([]);
    });

    it('ignores bass below the threshold', (): void => {
      // 127/255 is just under the 0.5 threshold.
      analyser.spectrum = flat(127);

      frames(5, 4000);

      expect(surfaces().freeze.calls).toEqual([]);
    });

    it('ignores loud treble with no bass under it', (): void => {
      analyser.spectrum = (index: number): number => (index < 30 ? 0 : 255);

      frame();

      expect(surfaces().freeze.calls).toEqual([]);
    });

    it('snapshots the tower on a bass hit', (): void => {
      frame();
      analyser.spectrum = bassHeavy(64);

      frame();

      const {freeze, tower}: Surfaces = surfaces();
      expect(freeze.callsTo('clearRect')[0].args).toEqual([0, 0, WIDTH, HEIGHT]);
      expect(freeze.callsTo('drawImage').map((call: RecordedCall): readonly unknown[] => call.args))
        .toEqual([[tower.canvas, 0, 0]]);
    });

    it('repaints the tower in the jumped hue on the same frame', (): void => {
      frame();
      const before: unknown = surfaces().tower.callsTo('fill').at(-1)?.state.fillStyle;
      analyser.spectrum = bassHeavy(64);

      frame();

      expect(surfaces().tower.callsTo('fillRect')).toHaveLength(2);
      expect(surfaces().tower.callsTo('fill').at(-1)?.state.fillStyle).not.toBe(before);
    });

    it('lays the old tower over the new one and fades it out frame by frame', (): void => {
      frame();
      analyser.spectrum = bassHeavy(64);

      frames(3);

      const strengths: number[] = crossFades().map((call: RecordedCall): number => call.state.globalAlpha);
      expect(strengths[0]).toBe(1);
      expect(strengths[1]).toBeCloseTo(0.995, 10);
      expect(strengths[2]).toBeCloseTo(0.99, 10);
    });

    it('finishes the cross-fade and stops drawing the old tower', (): void => {
      analyser.spectrum = bassHeavy(64);
      frames(205);
      fakes.forget();

      frames(5);

      expect(crossFades()).toEqual([]);
    });

    it('does not act again until ten seconds have passed', (): void => {
      analyser.spectrum = bassHeavy(64);
      frame();

      frames(9, 1000);

      expect(surfaces().freeze.callsTo('drawImage')).toHaveLength(1);
    });

    it('acts again once ten seconds have passed', (): void => {
      analyser.spectrum = bassHeavy(64);
      frame();

      frames(10, 1000);

      expect(surfaces().freeze.callsTo('drawImage')).toHaveLength(2);
    });

    it('measures the cooldown in elapsed time rather than in frames', (): void => {
      analyser.spectrum = bassHeavy(64);
      frame();

      // Many frames, little time.
      frames(50, 1);
      const afterManyFrames: number = surfaces().freeze.callsTo('drawImage').length;
      // One frame, much time.
      frame(10_000);

      expect(afterManyFrames).toBe(1);
      expect(surfaces().freeze.callsTo('drawImage')).toHaveLength(2);
    });

    it('reverses the counter-rotating bands when only the direction roll misses', (): void => {
      // Both rolls miss: the bands stay opposed and the overall direction flips.
      analyser.spectrum = bassHeavy(64);
      frame();
      fakes.forget();

      frame();

      bandRotations().forEach((angle: unknown, band: number): void => {
        expect(angle).toBe(band % 2 === 0 ? -0.006 : 0.006);
      });
    });

    it('turns every band the same way when the alignment roll comes up', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      analyser.spectrum = bassHeavy(64);
      frame();
      fakes.forget();

      frame();

      expect(bandRotations()).toEqual(new Array<number>(BANDS).fill(0.006));
    });

    it('rolls the alignment and the direction independently', (): void => {
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValueOnce(0.9);
      analyser.spectrum = bassHeavy(64);
      frame();
      fakes.forget();

      frame();

      expect(bandRotations()).toEqual(new Array<number>(BANDS).fill(-0.006));
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

    it('covers the whole canvas with the fade overlay', (): void => {
      viz.setPlaying(true);
      viz.setPlaying(false);

      frame(1000);

      expect(fadeOverlays()[0].args).toEqual([0, 0, WIDTH, HEIGHT]);
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
      controls().setTrailIntensity(1);

      expect(viz.getTrailIntensity()).toBe(0);
    });

    it('ignores the line width control', (): void => {
      controls().setLineWidth(5);

      expect(viz.getLineWidth()).toBe(1);
    });

    it('ignores the glow control', (): void => {
      controls().setGlowIntensity(1);

      expect(viz.getGlowIntensity()).toBe(0);
    });

    it('keeps drawing at the fixed sensitivity after the control is moved', (): void => {
      viz.resize(WIDTH, HEIGHT);
      controls().setSensitivity(1);
      // A lone bin that would clear the threshold at full sensitivity, but not at the fixed 10%.
      analyser.spectrum = spike(150, 100);

      frame();

      expect(surfaces().rings.callsTo('closePath')).toEqual([]);
    });

    it('keeps the tower unfeathered after the glow control is moved', (): void => {
      viz.resize(WIDTH, HEIGHT);
      controls().setGlowIntensity(1);

      frame();

      for (const fill of surfaces().tower.callsTo('fill')) {
        expect(fill.state.shadowBlur).toBe(0);
      }
    });
  });

  // ==========================================================================
  // FFT size
  // ==========================================================================

  describe('FFT size', (): void => {
    it('reads the spectrum once a frame into a buffer sized for the analyser', (): void => {
      viz.resize(WIDTH, HEIGHT);

      frames(2);

      expect(analyser.spectrumReads).toEqual([1024, 1024]);
    });

    it('reads into a buffer of the new size after a change', (): void => {
      viz.resize(WIDTH, HEIGHT);

      viz.setFftSize(512);
      frame();

      expect(analyser.spectrumReads).toEqual([256]);
    });

    it('never reads the waveform', (): void => {
      viz.resize(WIDTH, HEIGHT);

      frame();

      expect(analyser.waveformReads).toEqual([]);
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

      expect(fakes.contexts).toHaveLength(5);
      expect(analyser.spectrumReads).toEqual([]);
    });
  });

  // ==========================================================================
  // Edge inputs
  // ==========================================================================

  describe('edge inputs', (): void => {
    // The rings trail is left out of these: the three outermost rings have no
    // bounding circle to stand on, so what they draw there is not meaningful.
    it.each([
      {spectrum: 0},
      {spectrum: 255},
    ])('hands the visible layers only finite numbers for an all-$spectrum spectrum', ({spectrum}): void => {
      viz.resize(WIDTH, HEIGHT);
      viz.setPlaying(true);
      analyser.spectrum = flat(spectrum);

      frame();
      frames(3, 10_000);

      const {main, tower, freeze, scratch}: Surfaces = surfaces();
      for (const context of [main, tower, freeze, scratch]) {
        expect(context.unusableCalls()).toEqual([]);
        expect(context.unusableSets()).toEqual([]);
      }
    });

    it('hands the visible layers only finite numbers on a one-pixel canvas', (): void => {
      viz.resize(1, 1);
      analyser.spectrum = flat(255);

      frames(3);

      const {main, tower, freeze, scratch}: Surfaces = surfaces();
      for (const context of [main, tower, freeze, scratch]) {
        expect(context.unusableCalls()).toEqual([]);
        expect(context.unusableSets()).toEqual([]);
      }
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

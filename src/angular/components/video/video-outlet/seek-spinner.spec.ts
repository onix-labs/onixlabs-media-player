/**
 * @fileoverview Tests for the segmented seek-loading spinner.
 *
 * jsdom has no canvas 2D context and no frame clock, so both are replaced:
 * every canvas hands out a recording context that notes each wedge stamped
 * onto it (position, angle, opacity), and requestAnimationFrame becomes a
 * queue the test drains one frame at a time with a timestamp of its choosing.
 * Math.random is pinned, which makes the shed order, drift velocity and drift
 * duration exact.
 *
 * With Math.random pinned at 0.5 a shed wedge drifts straight outwards at
 * 50 px/s for 750 ms and the next shed follows 240 ms later.
 *
 * @module app/components/video/video-outlet/seek-spinner.spec
 */

import {SeekSpinner} from './seek-spinner';

// ============================================================================
// Fakes
// ============================================================================

/** One wedge stamped onto the spinner canvas. */
interface WedgeDraw {
  /** The image that was stamped */
  readonly image: unknown;
  /** Canvas-space X the wedge was translated to */
  readonly x: number;
  /** Canvas-space Y the wedge was translated to */
  readonly y: number;
  /** Rotation (rad) the wedge was drawn at */
  readonly angle: number;
  /** Opacity the wedge was drawn with */
  readonly alpha: number;
  /** Destination rectangle of the stamp, relative to the translated origin */
  readonly rect: readonly number[];
}

/** A 2D context that records what the spinner asks of it. */
class RecordingContext {
  public globalAlpha: number = 1;
  public fillStyle: string = '';
  public strokeStyle: string = '';
  public lineJoin: string = '';
  public lineWidth: number = 0;

  public readonly transforms: number[][] = [];
  public readonly clears: number[][] = [];
  public readonly arcs: number[][] = [];
  public readonly draws: WedgeDraw[] = [];
  public fills: number = 0;
  public strokes: number = 0;

  private x: number = 0;
  private y: number = 0;
  private angle: number = 0;

  public setTransform(...matrix: number[]): void {
    this.transforms.push(matrix);
  }

  public clearRect(...rect: number[]): void {
    this.clears.push(rect);
  }

  public save(): void {
    this.x = 0;
    this.y = 0;
    this.angle = 0;
  }

  public restore(): void {
    this.globalAlpha = 1;
  }

  public translate(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  public rotate(angle: number): void {
    this.angle = angle;
  }

  public drawImage(image: unknown, ...rect: number[]): void {
    this.draws.push({image, x: this.x, y: this.y, angle: this.angle, alpha: this.globalAlpha, rect});
  }

  public beginPath(): void {}

  public closePath(): void {}

  public arc(...args: number[]): void {
    this.arcs.push(args);
  }

  public fill(): void {
    this.fills++;
  }

  public stroke(): void {
    this.strokes++;
  }
}

// ============================================================================
// Constants mirrored from the spinner's documented geometry
// ============================================================================

/** Centre of the 256px canvas. */
const CENTER: number = SeekSpinner.CANVAS_SIZE / 2;

/** Number of wedges in the ring. */
const WEDGES: number = 16;

/** Angle between neighbouring wedge slots. */
const SLOT_STEP: number = (2 * Math.PI) / WEDGES;

// ============================================================================
// Tests
// ============================================================================

describe('SeekSpinner', (): void => {
  /** Recording contexts by the canvas that owns them. */
  let contexts: Map<HTMLCanvasElement, RecordingContext>;

  /** Canvases that should report no 2D context at all. */
  let contextless: (canvas: HTMLCanvasElement) => boolean;

  /** Pending animation-frame callbacks by handle. */
  let frames: Map<number, FrameRequestCallback>;

  /** Handles passed to cancelAnimationFrame. */
  let cancelled: number[];

  let nextHandle: number;
  let canvas: HTMLCanvasElement;
  let originalDpr: PropertyDescriptor | undefined;

  /** The recording context of the spinner's own canvas. */
  function ctx(): RecordingContext {
    const context: RecordingContext | undefined = contexts.get(canvas);
    if (!context) throw new Error('the spinner never asked its canvas for a context');
    return context;
  }

  /** Runs the single pending animation frame at the given timestamp. */
  function runFrame(time: number): void {
    const pending: [number, FrameRequestCallback][] = [...frames.entries()];
    expect(pending.length).toBe(1);
    const [handle, callback]: [number, FrameRequestCallback] = pending[0];
    frames.delete(handle);
    callback(time);
  }

  /** Runs one frame and returns only the wedges drawn during it. */
  function drawnAt(time: number): WedgeDraw[] {
    const before: number = ctx().draws.length;
    runFrame(time);
    return ctx().draws.slice(before);
  }

  /** How far from the ring centre a wedge was stamped. */
  function displacement(draw: WedgeDraw): number {
    return Math.hypot(draw.x - CENTER, draw.y - CENTER);
  }

  /** Sets the device pixel ratio the spinner will see. */
  function setDevicePixelRatio(value: number): void {
    Object.defineProperty(window, 'devicePixelRatio', {configurable: true, value});
  }

  beforeEach((): void => {
    contexts = new Map<HTMLCanvasElement, RecordingContext>();
    contextless = (): boolean => false;
    frames = new Map<number, FrameRequestCallback>();
    cancelled = [];
    nextHandle = 1;

    originalDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    setDevicePixelRatio(1);

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function (this: HTMLCanvasElement): CanvasRenderingContext2D | null {
        if (contextless(this)) return null;
        let context: RecordingContext | undefined = contexts.get(this);
        if (!context) {
          context = new RecordingContext();
          contexts.set(this, context);
        }
        return context as unknown as CanvasRenderingContext2D;
      } as unknown as HTMLCanvasElement['getContext']
    );

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
      const handle: number = nextHandle++;
      frames.set(handle, callback);
      return handle;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number): void => {
      cancelled.push(handle);
      frames.delete(handle);
    });

    // The spinner starts its clock at 0; frame timestamps are ms since start
    vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    canvas = document.createElement('canvas');
  });

  afterEach((): void => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalDpr) {
      Object.defineProperty(window, 'devicePixelRatio', originalDpr);
    } else {
      Reflect.deleteProperty(window, 'devicePixelRatio');
    }
  });

  // ==========================================================================
  // Starting
  // ==========================================================================

  describe('starting', (): void => {
    it('sizes the canvas backing store to 256 CSS pixels', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);

      spinner.start();

      expect([canvas.width, canvas.height]).toEqual([256, 256]);
    });

    it('scales the backing store and the context by the device pixel ratio', (): void => {
      setDevicePixelRatio(2);
      const spinner: SeekSpinner = new SeekSpinner(canvas);

      spinner.start();

      expect([canvas.width, canvas.height]).toEqual([512, 512]);
      expect(ctx().transforms).toEqual([[2, 0, 0, 2, 0, 0]]);
    });

    it('treats a missing device pixel ratio as 1', (): void => {
      setDevicePixelRatio(0);
      const spinner: SeekSpinner = new SeekSpinner(canvas);

      spinner.start();

      expect(canvas.width).toBe(256);
    });

    it('schedules exactly one animation frame', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);

      spinner.start();

      expect(frames.size).toBe(1);
    });

    it('does not schedule a second loop when started while already running', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();

      spinner.start();

      expect(frames.size).toBe(1);
    });

    it('does not animate when the canvas has no 2D context', (): void => {
      contextless = (): boolean => true;
      const spinner: SeekSpinner = new SeekSpinner(canvas);

      spinner.start();

      expect(frames.size).toBe(0);
    });

    it('pre-renders the wedge as an opaque white shape with rounded joins', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);

      spinner.start();

      const sprite: RecordingContext = [...contexts.values()].find((c: RecordingContext): boolean => c !== ctx())!;
      expect(sprite.fillStyle).toBe('#ffffff');
      expect(sprite.strokeStyle).toBe('#ffffff');
      expect(sprite.lineJoin).toBe('round');
      expect(sprite.lineWidth).toBe(8);
      expect([sprite.arcs.length, sprite.fills, sprite.strokes]).toEqual([2, 1, 1]);
    });
  });

  // ==========================================================================
  // The ring
  // ==========================================================================

  describe('drawing the ring', (): void => {
    it('stamps all sixteen wedges around the canvas centre', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();

      const drawn: WedgeDraw[] = drawnAt(400);

      expect(drawn.length).toBe(WEDGES);
      expect(drawn.every((d: WedgeDraw): boolean => d.x === CENTER && d.y === CENTER)).toBe(true);
    });

    it('spaces the wedges evenly around the ring', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();

      const drawn: WedgeDraw[] = drawnAt(400);

      const gaps: number[] = drawn.slice(1).map((d: WedgeDraw, i: number): number => d.angle - drawn[i].angle);
      gaps.forEach((gap: number): void => expect(gap).toBeCloseTo(SLOT_STEP, 10));
    });

    it('stamps the pre-rendered sprite between the inner and outer radius', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();

      const [first]: WedgeDraw[] = drawnAt(400);

      const [x, y, width, height]: readonly number[] = first.rect;
      expect(first.image).toBeInstanceOf(HTMLCanvasElement);
      expect(first.image).not.toBe(canvas);
      // 52px inner radius less the 6px sprite padding; 16px ring depth plus padding both sides
      expect(x).toBe(46);
      expect(width).toBe(28);
      expect(y).toBeCloseTo(-height / 2, 10);
    });

    it('clears the previous frame before drawing', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();

      runFrame(400);

      expect(ctx().clears).toEqual([[0, 0, 256, 256]]);
    });

    it('schedules the next frame after each one', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();

      runFrame(16);

      expect(frames.size).toBe(1);
    });

    it('rotates at 3.5 radians per second', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();

      const [first]: WedgeDraw[] = drawnAt(50);

      expect(first.angle).toBeCloseTo(0.175, 10);
    });

    it('accumulates rotation from frame to frame', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      runFrame(50);

      const [first]: WedgeDraw[] = drawnAt(90);

      expect(first.angle).toBeCloseTo(3.5 * 0.09, 10);
    });

    it('advances by at most a tenth of a second after a long gap between frames', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      runFrame(50);

      const [first]: WedgeDraw[] = drawnAt(400);

      expect(first.angle).toBeCloseTo(0.175 + 0.35, 10);
    });

    it('draws nothing at the instant it starts, before the fade-in has begun', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();

      const drawn: WedgeDraw[] = drawnAt(0);

      expect(drawn).toEqual([]);
    });

    it('fades every wedge in together over 300 ms', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();

      const drawn: WedgeDraw[] = drawnAt(150);

      expect(drawn.length).toBe(WEDGES);
      drawn.forEach((d: WedgeDraw): void => expect(d.alpha).toBeCloseTo(0.45, 10));
    });

    it('holds the wedges at 0.9 opacity once faded in', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();

      const drawn: WedgeDraw[] = drawnAt(450);

      drawn.forEach((d: WedgeDraw): void => expect(d.alpha).toBeCloseTo(0.9, 10));
    });

    it('keeps the loop alive but draws nothing when the wedge sprite cannot be rendered', (): void => {
      contextless = (target: HTMLCanvasElement): boolean => target !== canvas;
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();

      const drawn: WedgeDraw[] = drawnAt(400);

      expect(drawn).toEqual([]);
      expect(frames.size).toBe(1);
    });
  });

  // ==========================================================================
  // Shedding
  // ==========================================================================

  describe('shedding wedges', (): void => {
    it('keeps the ring intact for the first half second', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      runFrame(499);

      const drawn: WedgeDraw[] = drawnAt(599);

      expect(drawn.filter((d: WedgeDraw): boolean => displacement(d) > 0)).toEqual([]);
    });

    it('sheds a single wedge once the initial delay has passed', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      runFrame(500);

      const drawn: WedgeDraw[] = drawnAt(600);

      expect(drawn.filter((d: WedgeDraw): boolean => displacement(d) > 0).length).toBe(1);
    });

    it('drifts a shed wedge outwards along the angle it left the ring at', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      runFrame(500);

      const drawn: WedgeDraw[] = drawnAt(600);

      // 50 px/s outward with no sideways component, 100 ms after the shed
      const shed: WedgeDraw = drawn.find((d: WedgeDraw): boolean => displacement(d) > 0)!;
      expect(shed.x - CENTER).toBeCloseTo(5 * Math.cos(shed.angle), 10);
      expect(shed.y - CENTER).toBeCloseTo(5 * Math.sin(shed.angle), 10);
    });

    it('freezes a shed wedge at its angle while the ring carries on rotating', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      runFrame(500);
      const atFirst: WedgeDraw = drawnAt(600).find((d: WedgeDraw): boolean => displacement(d) > 0)!;

      const atSecond: WedgeDraw = drawnAt(700).find((d: WedgeDraw): boolean => displacement(d) > 0)!;

      expect(atSecond.angle).toBe(atFirst.angle);
      expect(displacement(atSecond)).toBeCloseTo(10, 10);
    });

    it('fades a shed wedge out as its drift progresses', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      runFrame(500);

      const drawn: WedgeDraw[] = drawnAt(600);

      // 100 ms into a 750 ms drift
      const shed: WedgeDraw = drawn.find((d: WedgeDraw): boolean => displacement(d) > 0)!;
      expect(shed.alpha).toBeCloseTo((1 - 100 / 750) * 0.9, 10);
    });

    it('leaves a gap in the ring on the frame a drift completes', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      runFrame(500);

      const drawn: WedgeDraw[] = drawnAt(1250);

      expect(drawn.length).toBe(WEDGES - 1);
    });

    it('fades the wedge back in at its slot once its drift completes', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      runFrame(500);
      runFrame(1250);

      const drawn: WedgeDraw[] = drawnAt(1400);

      const respawned: WedgeDraw[] = drawn.filter((d: WedgeDraw): boolean => Math.abs(d.alpha - 0.45) < 1e-9);
      expect(drawn.length).toBe(WEDGES);
      expect(respawned.length).toBe(1);
      expect(displacement(respawned[0])).toBe(0);
    });

    it('waits for the shed interval before shedding another wedge', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      runFrame(500);
      // 239 ms after the first shed — one ms short of the 240 ms interval
      runFrame(739);

      const drawn: WedgeDraw[] = drawnAt(800);

      expect(drawn.filter((d: WedgeDraw): boolean => displacement(d) > 0).length).toBe(1);
    });

    it('sheds the next wedge once the shed interval has elapsed', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      runFrame(500);
      runFrame(740);

      const drawn: WedgeDraw[] = drawnAt(800);

      expect(drawn.filter((d: WedgeDraw): boolean => displacement(d) > 0).length).toBe(2);
    });

    it('sheds every wedge exactly once per cycle', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      // One frame every 250 ms: each sheds one wedge, and each frame's rotation
      // step is clamped to 0.35 rad, so the ring angle at frame n is 0.35 * n
      const frameGap: number = 250;
      const rotationPerFrame: number = 0.35;
      const shedSlots: number[] = [];
      runFrame(500);

      for (let n: number = 2; n <= WEDGES + 1; n++) {
        const drawn: WedgeDraw[] = drawnAt(500 + (n - 1) * frameGap);
        // The wedge shed on the previous frame has drifted 12.5px by now
        const justShed: WedgeDraw = drawn.find((d: WedgeDraw): boolean => Math.abs(displacement(d) - 12.5) < 1e-6)!;
        const slot: number = Math.round((justShed.angle - rotationPerFrame * (n - 1)) / SLOT_STEP);
        shedSlots.push(slot);
      }

      expect([...shedSlots].sort((a: number, b: number): number => a - b))
        .toEqual(Array.from({length: WEDGES}, (_: unknown, i: number): number => i));
    });

    it('pauses for half a second before the next cycle starts shedding', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      // Sixteen sheds, one per frame, the last at 4250 ms
      for (let n: number = 0; n < WEDGES; n++) {
        runFrame(500 + n * 250);
      }
      // 250 ms into the new cycle's delay: nothing sheds on this frame
      runFrame(4500);

      const drawn: WedgeDraw[] = drawnAt(4750);

      // Only the wedge shed at 4250 is still adrift; a shed at 4500 would add a second
      expect(drawn.filter((d: WedgeDraw): boolean => displacement(d) > 0).length).toBe(1);
    });

    it('resumes shedding in the next cycle after the pause', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      for (let n: number = 0; n < WEDGES; n++) {
        runFrame(500 + n * 250);
      }
      runFrame(4500);
      runFrame(4750);

      const drawn: WedgeDraw[] = drawnAt(5000);

      // The last wedge of the old cycle completes here; the one adrift was shed at 4750
      const adrift: WedgeDraw[] = drawn.filter((d: WedgeDraw): boolean => displacement(d) > 0);
      expect(adrift.length).toBe(1);
      expect(displacement(adrift[0])).toBeCloseTo(12.5, 6);
    });

    describe('when a wedge is first in line again straight after being shed last', (): void => {
      /** When the first cycle's final wedge (slot 0) was shed. */
      const lastShedAt: number = 500 + (WEDGES - 1) * 330;

      /**
       * Runs a full first cycle that ends by shedding slot 0, with a second
       * cycle that begins with slot 0.
       *
       * A shuffle drawn entirely from 0 ends on slot 0; one drawn entirely
       * from just under 1 starts on slot 0. With Math.random just under 1 a
       * drift lasts ~1000 ms at ~74 px/s and sheds are ~320 ms apart, so one
       * frame every 330 ms sheds one wedge each.
       */
      function runFirstCycle(): void {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const spinner: SeekSpinner = new SeekSpinner(canvas);
        spinner.start();
        vi.spyOn(Math, 'random').mockReturnValue(0.999999);
        for (let n: number = 0; n < WEDGES; n++) {
          runFrame(500 + n * 330);
        }
      }

      it('lets the wedge finish its drift instead of shedding it a second time', (): void => {
        runFirstCycle();
        // Slot 0's turn comes 500 ms into its ~1000 ms drift
        runFrame(lastShedAt + 500);

        const drawn: WedgeDraw[] = drawnAt(lastShedAt + 600);

        // Shed again at +500 it would be 100 ms (~7px) out; undisturbed it is 600 ms (~45px) out
        const distances: number[] = drawn.map(displacement).filter((d: number): boolean => d > 0);
        expect(distances.some((d: number): boolean => d < 30)).toBe(false);
        expect(distances.some((d: number): boolean => d > 40 && d < 50)).toBe(true);
      });

      it('starts the retried drift from the opacity the respawned wedge had reached', (): void => {
        runFirstCycle();
        runFrame(lastShedAt + 500);
        // Lets the wedge shed before it finish and fade back in, out of the way
        runFrame(lastShedAt + 700);
        // Drift completes: the wedge respawns here and its retry is put back 160 ms
        runFrame(lastShedAt + 1000);

        // 160 ms into the 300 ms fade-in the wedge is shed again
        const drawn: WedgeDraw[] = drawnAt(lastShedAt + 1160);

        const partial: WedgeDraw[] = drawn.filter((d: WedgeDraw): boolean => d.alpha < 0.89);
        expect(partial.length).toBe(1);
        expect(partial[0].alpha).toBeCloseTo((160 / 300) * 0.9, 6);
      });

      it('fades the retried drift out from that reduced opacity rather than popping to full', (): void => {
        runFirstCycle();
        runFrame(lastShedAt + 500);
        runFrame(lastShedAt + 700);
        runFrame(lastShedAt + 1000);
        runFrame(lastShedAt + 1160);

        const drawn: WedgeDraw[] = drawnAt(lastShedAt + 1260);

        // A tenth of the way through a ~1000 ms drift that began at 160/300 opacity
        const adrift: WedgeDraw[] = drawn.filter((d: WedgeDraw): boolean => displacement(d) > 0);
        expect(adrift.length).toBe(1);
        expect(adrift[0].alpha).toBeCloseTo(0.9 * (160 / 300) * 0.9, 4);
      });
    });
  });

  // ==========================================================================
  // Stopping
  // ==========================================================================

  describe('stopping', (): void => {
    it('cancels the pending animation frame', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      const [pending]: number[] = [...frames.keys()];

      spinner.stop();

      expect(cancelled).toEqual([pending]);
    });

    it('clears the whole backing store', (): void => {
      setDevicePixelRatio(2);
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();

      spinner.stop();

      expect(ctx().clears).toEqual([[0, 0, 512, 512]]);
    });

    it('draws nothing if a frame that was already dispatched arrives after stopping', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      const [late]: FrameRequestCallback[] = [...frames.values()];
      spinner.stop();

      late(400);

      expect(ctx().draws).toEqual([]);
      expect(frames.size).toBe(0);
    });

    it('is harmless when the spinner was never started', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);

      spinner.stop();

      expect(cancelled).toEqual([]);
    });

    it('starts afresh, fading in from nothing, when restarted', (): void => {
      const spinner: SeekSpinner = new SeekSpinner(canvas);
      spinner.start();
      runFrame(450);
      spinner.stop();
      vi.spyOn(performance, 'now').mockReturnValue(10000);
      spinner.start();

      const drawn: WedgeDraw[] = drawnAt(10150);

      expect(drawn.length).toBe(WEDGES);
      drawn.forEach((d: WedgeDraw): void => expect(d.alpha).toBeCloseTo(0.45, 10));
      expect(drawn[0].angle).toBeCloseTo(0.35, 10);
    });
  });
});

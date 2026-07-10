/**
 * @fileoverview Segmented canvas spinner for the seek-loading overlay.
 *
 * Renders a steadily rotating ring of equally spaced wedge-shaped segments
 * (annular sectors with rounded corners). The ring sheds its wedges one at a
 * time in a random order — each shed wedge drifts away from the ring and
 * fades out, and fades back in at its slot as soon as the drift completes,
 * so the ring is continuously replenished. Once every wedge has been shed
 * the sequence reshuffles and begins again.
 *
 * Self-contained: the {@link VideoOutlet} owns a canvas element and calls
 * {@link SeekSpinner.start} / {@link SeekSpinner.stop} around the
 * seek-loading overlay's lifetime. The animation runs on its own
 * requestAnimationFrame loop and draws nothing while stopped.
 *
 * @module app/components/video/video-outlet/seek-spinner
 */

/** Animation phase of a single spinner wedge. */
type WedgePhase = 'attached' | 'drifting';

/**
 * Per-wedge animation state.
 *
 * Attached wedges rotate with the ring, fading in after a respawn. Drifting
 * wedges are frozen at the angle they were shed at and float away from the
 * ring with a fixed velocity while fading out.
 */
interface SpinnerWedge {
  /** Current phase */
  phase: WedgePhase;
  /** Timestamp (ms) when the wedge (re)spawned at its slot (drives fade-in) */
  respawnedAt: number;
  /** Fade-in fraction (0-1) the wedge had when it was shed (drift start alpha) */
  shedAlpha: number;
  /** Timestamp (ms) when the current drift began */
  driftStartedAt: number;
  /** Duration (ms) of the current drift */
  driftDuration: number;
  /** Ring angle (rad) the wedge had when it was shed */
  driftAngle: number;
  /** Drift velocity X (px/s) */
  driftVx: number;
  /** Drift velocity Y (px/s) */
  driftVy: number;
}

/**
 * Segmented seek-loading spinner.
 *
 * A ring of {@link segmentCount} rounded wedge-shaped segments rotating at a
 * steady {@link rotationSpeed}. Shedding covers every wedge exactly once per
 * cycle in a random (shuffled) order, and each wedge fades back in as soon
 * as its drift completes so the animation never pauses.
 */
export class SeekSpinner {
  /** Canvas CSS size (px); the ring plus room for drifting wedges to fade */
  public static readonly CANVAS_SIZE: number = 256;

  /** Number of equally spaced wedges in the ring */
  private readonly segmentCount: number = 16;

  /** Fraction of each slot's angle occupied by the wedge (rest is gap) */
  private readonly wedgeSpanFraction: number = 0.7;

  /** Inner radius of the ring (px) */
  private readonly innerRadius: number = 52;

  /** Outer radius of the ring (px) */
  private readonly outerRadius: number = 68;

  /** Corner radius (px) for the rounded wedge corners */
  private readonly cornerRadius: number = 4;

  /** Ring rotation speed (rad/s) — a steady medium pace */
  private readonly rotationSpeed: number = 3.5;

  /** Pause (ms) at the start of each cycle before shedding begins */
  private readonly initialShedDelayMs: number = 500;

  /** Minimum interval (ms) between sheds */
  private readonly shedIntervalMinMs: number = 160;

  /** Maximum interval (ms) between sheds */
  private readonly shedIntervalMaxMs: number = 320;

  /** Minimum drift duration (ms) */
  private readonly driftMinMs: number = 500;

  /** Maximum drift duration (ms) */
  private readonly driftMaxMs: number = 1000;

  /** Minimum outward drift speed (px/s) */
  private readonly driftSpeedMin: number = 30;

  /** Maximum outward drift speed (px/s) */
  private readonly driftSpeedMax: number = 70;

  /** Maximum sideways (tangential) drift speed (px/s) */
  private readonly driftSidewaysMax: number = 25;

  /** Fade-in duration (ms) when a wedge respawns at its slot */
  private readonly respawnFadeMs: number = 300;

  /** Base wedge opacity */
  private readonly segmentAlpha: number = 0.9;

  /** Maximum frame delta (s) — clamps time jumps after tab suspension */
  private readonly maxFrameDeltaS: number = 0.1;

  /** Padding (px) around the pre-rendered wedge sprite */
  private readonly spritePadding: number = 2;

  /** The canvas to render into */
  private readonly canvas: HTMLCanvasElement;

  /** 2D rendering context */
  private readonly ctx: CanvasRenderingContext2D | null;

  /** Pre-rendered opaque wedge (drawn per-wedge with rotation and alpha) */
  private wedgeSprite: HTMLCanvasElement | null = null;

  /** Wedge sprite width (CSS px) */
  private spriteWidth: number = 0;

  /** Wedge sprite height (CSS px) */
  private spriteHeight: number = 0;

  /** Per-wedge animation state */
  private wedges: SpinnerWedge[] = [];

  /** Order in which the wedges shed this cycle (shuffled slot indices) */
  private shedOrder: number[] = [];

  /** How many wedges of the current cycle have been shed so far */
  private shedIndex: number = 0;

  /** Timestamp (ms) when the next wedge sheds */
  private nextShedAt: number = 0;

  /** Accumulated ring rotation (rad) — integrated because the speed ramps */
  private rotation: number = 0;

  /** Timestamp (ms) of the previous frame (for the rotation integral) */
  private lastFrameAt: number = 0;

  /** Whether the animation loop is running */
  private running: boolean = false;

  /** Handle of the active animation frame (for cancellation) */
  private animationId: number | null = null;

  /**
   * Creates a spinner bound to the given canvas.
   *
   * @param canvas - The canvas element to render into
   */
  public constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /**
   * Starts the animation. No-op if already running.
   */
  public start(): void {
    if (this.running || !this.ctx) return;

    const dpr: number = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(SeekSpinner.CANVAS_SIZE * dpr);
    this.canvas.height = Math.round(SeekSpinner.CANVAS_SIZE * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.buildWedgeSprite(dpr);

    const now: number = performance.now();
    this.rotation = 0;
    this.lastFrameAt = now;

    // All wedges fade in together at start, then the first cycle begins
    this.wedges = Array.from({length: this.segmentCount}, (): SpinnerWedge => ({
      phase: 'attached',
      respawnedAt: now,
      shedAlpha: 1,
      driftStartedAt: 0,
      driftDuration: 0,
      driftAngle: 0,
      driftVx: 0,
      driftVy: 0,
    }));
    this.beginCycle(now);

    this.running = true;
    this.animationId = requestAnimationFrame((time: number): void => this.frame(time));
  }

  /**
   * Stops the animation and clears the canvas.
   */
  public stop(): void {
    this.running = false;
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Begins a shed cycle: a fresh random order is drawn so every wedge sheds
   * exactly once before the next reshuffle.
   *
   * @param now - Current timestamp (ms)
   */
  private beginCycle(now: number): void {
    this.shedOrder = this.shuffledIndices();
    this.shedIndex = 0;
    this.nextShedAt = now + this.initialShedDelayMs;
  }

  /**
   * Produces the slot indices 0..segmentCount-1 in random order
   * (Fisher-Yates shuffle) — the order the wedges shed this cycle.
   */
  private shuffledIndices(): number[] {
    const indices: number[] = Array.from({length: this.segmentCount}, (_: unknown, i: number): number => i);
    for (let i: number = indices.length - 1; i > 0; i--) {
      const j: number = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return indices;
  }

  /**
   * Pre-renders one opaque wedge onto an offscreen sprite canvas.
   *
   * The rounded corners come from stroking the wedge path (inset by the
   * corner radius) with a round-joined stroke of twice the corner radius —
   * fill plus stroke union produces the full-size wedge with rounded
   * corners. Rendering the sprite opaque and drawing it with globalAlpha
   * avoids the double-blend seams that stroking translucent fills causes.
   *
   * The sprite is drawn with the wedge centred on angle 0 (pointing +x);
   * per-wedge rotation is applied when the sprite is drawn.
   *
   * @param dpr - Device pixel ratio for a crisp sprite
   */
  private buildWedgeSprite(dpr: number): void {
    const halfSpan: number = ((2 * Math.PI) / this.segmentCount) * this.wedgeSpanFraction / 2;
    const pad: number = this.cornerRadius + this.spritePadding;

    this.spriteWidth = (this.outerRadius - this.innerRadius) + pad * 2;
    this.spriteHeight = 2 * this.outerRadius * Math.sin(halfSpan) + pad * 2;

    const sprite: HTMLCanvasElement = document.createElement('canvas');
    sprite.width = Math.ceil(this.spriteWidth * dpr);
    sprite.height = Math.ceil(this.spriteHeight * dpr);
    const ctx: CanvasRenderingContext2D | null = sprite.getContext('2d');
    if (!ctx) {
      this.wedgeSprite = null;
      return;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Place the ring centre left of the sprite so the wedge (radii
    // innerRadius..outerRadius along +x) lands inside it, vertically centred
    ctx.translate(pad - this.innerRadius, this.spriteHeight / 2);

    // Wedge path inset by the corner radius on all sides; the round-joined
    // stroke below expands it back to full size with rounded corners
    const rOut: number = this.outerRadius - this.cornerRadius;
    const rIn: number = this.innerRadius + this.cornerRadius;
    const angInsetOut: number = this.cornerRadius / rOut;
    const angInsetIn: number = this.cornerRadius / rIn;

    ctx.beginPath();
    ctx.arc(0, 0, rOut, -(halfSpan - angInsetOut), halfSpan - angInsetOut);
    ctx.arc(0, 0, rIn, halfSpan - angInsetIn, -(halfSpan - angInsetIn), true);
    ctx.closePath();

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineJoin = 'round';
    ctx.lineWidth = this.cornerRadius * 2;
    ctx.fill();
    ctx.stroke();

    this.wedgeSprite = sprite;
  }

  /**
   * Renders one animation frame and schedules the next.
   *
   * @param now - High-resolution timestamp from requestAnimationFrame
   */
  private frame(now: number): void {
    if (!this.running || !this.ctx) return;

    const ctx: CanvasRenderingContext2D = this.ctx;
    const center: number = SeekSpinner.CANVAS_SIZE / 2;
    const slotAngleStep: number = (2 * Math.PI) / this.segmentCount;

    // Advance the ring rotation at a steady pace
    const deltaSeconds: number = Math.min((now - this.lastFrameAt) / 1000, this.maxFrameDeltaS);
    this.lastFrameAt = now;
    this.rotation += this.rotationSpeed * deltaSeconds;

    // Shed the next wedge (in the shuffled order) when its time comes. If
    // that wedge is still drifting from the previous cycle, retry shortly.
    if (this.shedIndex < this.shedOrder.length && now >= this.nextShedAt) {
      const slot: number = this.shedOrder[this.shedIndex];
      const wedge: SpinnerWedge = this.wedges[slot];
      if (wedge.phase === 'attached') {
        this.shedWedge(wedge, this.rotation + slot * slotAngleStep, now);
        this.shedIndex++;
        this.nextShedAt = now + this.shedIntervalMinMs + Math.random() * (this.shedIntervalMaxMs - this.shedIntervalMinMs);
      } else {
        this.nextShedAt = now + this.shedIntervalMinMs;
      }
    }

    // Every wedge shed — reshuffle and start the next cycle (slow again)
    if (this.shedIndex >= this.segmentCount) {
      this.beginCycle(now);
    }

    ctx.clearRect(0, 0, SeekSpinner.CANVAS_SIZE, SeekSpinner.CANVAS_SIZE);

    for (let i: number = 0; i < this.wedges.length; i++) {
      const wedge: SpinnerWedge = this.wedges[i];

      if (wedge.phase === 'attached') {
        // Fade in after a respawn, then ride the ring at full opacity
        const fadeIn: number = Math.min(1, (now - wedge.respawnedAt) / this.respawnFadeMs);
        this.drawWedge(ctx, center, this.rotation + i * slotAngleStep, 0, 0, fadeIn * this.segmentAlpha);
      } else {
        const progress: number = (now - wedge.driftStartedAt) / wedge.driftDuration;
        if (progress >= 1) {
          // Drift complete — fade straight back in at the slot so the ring
          // is continuously replenished
          wedge.phase = 'attached';
          wedge.respawnedAt = now;
          continue;
        }
        // Drift away from the shed position, fading out
        const elapsedSeconds: number = (now - wedge.driftStartedAt) / 1000;
        const offsetX: number = wedge.driftVx * elapsedSeconds;
        const offsetY: number = wedge.driftVy * elapsedSeconds;
        this.drawWedge(ctx, center, wedge.driftAngle, offsetX, offsetY, (1 - progress) * wedge.shedAlpha * this.segmentAlpha);
      }
    }

    this.animationId = requestAnimationFrame((time: number): void => this.frame(time));
  }

  /**
   * Sheds a wedge from the ring: freezes it at its current angle and gives
   * it an outward velocity with a random sideways component. The wedge's
   * current fade-in level is captured so a freshly respawned wedge doesn't
   * pop to full opacity when it drifts.
   *
   * @param wedge - The wedge to shed
   * @param slotAngle - The wedge's current angle on the ring
   * @param now - Current timestamp (ms)
   */
  private shedWedge(wedge: SpinnerWedge, slotAngle: number, now: number): void {
    const outwardSpeed: number = this.driftSpeedMin + Math.random() * (this.driftSpeedMax - this.driftSpeedMin);
    const sidewaysSpeed: number = (Math.random() * 2 - 1) * this.driftSidewaysMax;
    const cos: number = Math.cos(slotAngle);
    const sin: number = Math.sin(slotAngle);

    wedge.phase = 'drifting';
    wedge.shedAlpha = Math.min(1, (now - wedge.respawnedAt) / this.respawnFadeMs);
    wedge.driftStartedAt = now;
    wedge.driftDuration = this.driftMinMs + Math.random() * (this.driftMaxMs - this.driftMinMs);
    wedge.driftAngle = slotAngle;
    // Outward (radial) velocity plus a sideways (tangential) component
    wedge.driftVx = cos * outwardSpeed - sin * sidewaysSpeed;
    wedge.driftVy = sin * outwardSpeed + cos * sidewaysSpeed;
  }

  /**
   * Draws one wedge by stamping the pre-rendered sprite at the given angle,
   * offset, and opacity.
   *
   * @param ctx - The rendering context
   * @param center - The ring centre (canvas is square)
   * @param angle - Radial angle of the wedge's centre (rad)
   * @param offsetX - Additional X offset (drift)
   * @param offsetY - Additional Y offset (drift)
   * @param alpha - Wedge opacity (0-1)
   */
  private drawWedge(
    ctx: CanvasRenderingContext2D,
    center: number,
    angle: number,
    offsetX: number,
    offsetY: number,
    alpha: number
  ): void {
    if (alpha <= 0 || !this.wedgeSprite) return;

    const pad: number = this.cornerRadius + this.spritePadding;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(center + offsetX, center + offsetY);
    ctx.rotate(angle);
    ctx.drawImage(this.wedgeSprite, this.innerRadius - pad, -this.spriteHeight / 2, this.spriteWidth, this.spriteHeight);
    ctx.restore();
  }
}

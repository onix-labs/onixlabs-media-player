/**
 * @fileoverview Water visualization (Ambience / Water).
 *
 * Built from three layers over a slowly hue-cycling palette:
 *
 *   1. Concentric tower - six filled, centred circles, brightest at the centre
 *      to darkest at the edge, equally spaced with the outermost spilling just
 *      past the left/right edges, feathered into one another and sitting on a
 *      background a shade darker than the darkest circle.
 *
 *   2. Frequency rings - five circular waveforms, one on each inner circle. The
 *      middle 80% of the spectrum is split into five equal buckets (one per
 *      ring). Each ring is a peaks-only two-level square wave: an angular sample
 *      sits on its own circle (baseline) or jumps to the next circle out
 *      (ceiling) when its bucket bin is loud enough. Peak interiors are filled
 *      and each ring is drawn in the colour of the circle it sits on. Rings are
 *      revealed one at a time, advancing from the centre outward and looping.
 *
 *   3. Horizontal waveforms - a left and a right waveform running from the screen
 *      edges and bending around the smallest circle (the right is a 180-degree
 *      rotation of the left). They match the brightest (top) circle's colour.
 *
 * The rings and the horizontal waveforms are each rendered onto their own trail
 * surface that is rotated, faded and blurred every frame (a spiral), then
 * composited over the tower - rings underneath, horizontal waveforms on top.
 *
 * A bass hit (gated to once every ten seconds) reverses the spiral's direction
 * and jumps the hue, so the whole scene flips and recolours on a heavy beat; some
 * hits also flash the frame white with the horizontal waveform painted a dark
 * shade of the new hue, lightening back to normal.
 *
 * @module app/components/audio/audio-outlet/visualizations/water-visualization
 */

import {Canvas2DVisualization, OffscreenCanvasPair, VisualizationConfig} from './visualization';
import {TWO_PI} from './visualization-constants';

/** A single mutable 2D point. */
interface Point {
  x: number;
  y: number;
}

/** An RGB colour triplet (0-255 per channel). */
interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Water visualization: a concentric glowing tower wrapped in frequency rings and
 * mirrored horizontal waveforms, all spiralling about the centre.
 */
export class WaterVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Water';
  public readonly category: string = 'Waves';

  // --- Concentric tower -----------------------------------------------------

  /** Number of stacked concentric circles. */
  private readonly CIRCLE_COUNT: number = 6;

  /**
   * The largest (outermost) circle's radius as a multiple of half the screen
   * width, so its circumference overlaps the left and right edges slightly.
   * The six circles are then equally spaced from the centre out to it.
   */
  private readonly EDGE_OVERLAP_FACTOR: number = 1.05;

  /** Saturation used for every circle (percent). */
  private readonly CIRCLE_SATURATION: number = 85;

  /** Lightness of the innermost (brightest) circle (percent). */
  private readonly INNER_LIGHTNESS: number = 64;

  /** Lightness of the outermost (darkest) circle (percent). */
  private readonly OUTER_LIGHTNESS: number = 16;

  /** Lightness of the background fill - a shade darker than the darkest circle. */
  private readonly BACKGROUND_LIGHTNESS: number = 2;

  /** Base blur radius used to feather one circle into the next (pixels). */
  private readonly CIRCLE_BASE_BLUR: number = 0;

  /**
   * Minimum feather between circles, applied even when the user glow control is
   * zero, so the "mild blur from one circle to the next" is intrinsic.
   */
  private readonly CIRCLE_MIN_BLUR: number = 10;

  // --- Waveforms ------------------------------------------------------------

  /** Glow blur radius for the waveforms and rings (pixels). */
  private readonly WAVE_GLOW_BLUR: number = 16;

  /** Samples per horizontal waveform (edge to centre). */
  private readonly HORIZONTAL_SAMPLES: number = 32;

  /** Horizontal amplitude as a fraction of screen height. */
  private readonly HORIZONTAL_AMP_FRACTION: number = 0.25;

  /** How hard the horizontal waveform bends around the core. */
  private readonly BEND_STRENGTH: number = 1.0;

  /** Maximum bend angle so the waveform never wraps over the core (radians). */
  private readonly MAX_BEND_ANGLE: number = 1.4;

  // --- Frequency rings ------------------------------------------------------

  /** Angular samples around each ring. */
  private readonly CIRCULAR_SAMPLES: number = 128;

  /** Number of frequency-bucket rings (one per inner circle). */
  private readonly RING_COUNT: number = 5;

  /** Times each ring's waveform repeats around the circle (rotational symmetry). */
  private readonly RING_REPEAT: number = 2;

  /** Fraction of FFT bins trimmed from each end before bucketing (low & high). */
  private readonly FREQ_TRIM_FRACTION: number = 0.25;

  /** Magnitude (after sensitivity) at/above which a sample jumps to the ceiling. */
  private readonly PEAK_THRESHOLD: number = 0.1;

  /** Opacity of the filled interior of each peak (1 = solid). */
  private readonly PEAK_FILL_ALPHA: number = 1;

  /** Corner radius for each peak's rounded edges (pixels, border-radius style). */
  private readonly PEAK_CORNER_RADIUS: number = 8;

  // --- Trails (spiral / blur / fade) ----------------------------------------

  /** Per-frame rotation of the trail surfaces (radians). */
  private readonly TRAIL_ROTATION: number = 0.004;

  /** Per-frame fade of the horizontal-waveform trail (low = long-lived trails). */
  private readonly HORIZONTAL_FADE: number = 0.002;

  /** Per-frame fade of the rings trail (high, so layered peaks clear, not pile up). */
  private readonly RING_FADE: number = 0.05;

  /** Extra trail-canvas margin beyond the outer circle, for glow (pixels). */
  private readonly TRAIL_MARGIN: number = 20;

  // --- Colour cycling -------------------------------------------------------

  /** Per-frame hue drift (degrees). */
  private readonly HUE_CYCLE_SPEED: number = 0.08;

  /** Starting hue (degrees) - blue, matching the reference. */
  private readonly START_HUE: number = 220;

  // --- Bass trigger ---------------------------------------------------------

  /** Fraction of the lowest FFT bins treated as the "bass" band. */
  private readonly BASS_BIN_FRACTION: number = 0.03;

  /** Average bass magnitude (0-1) at/above which the trigger fires. */
  private readonly BASS_THRESHOLD: number = 0.5;

  /** Minimum time between bass triggers (milliseconds). */
  private readonly BASS_COOLDOWN_MS: number = 10000;

  /** Hue jump applied on each bass trigger (degrees; golden angle for variety). */
  private readonly HUE_JUMP_DEGREES: number = 137.5;

  /** Chance (0-1) that a bass trigger also starts a white/black flash. */
  private readonly FLASH_PROBABILITY: number = 0.5;

  /** Per-frame decay of the flash (lower = slower fade back to normal). */
  private readonly FLASH_FADE: number = 0.01;

  /** Lightness (%) of the flash waveform at full intensity; it lightens as the flash fades. */
  private readonly FLASH_WAVE_DARK_LIGHTNESS: number = 10;

  /** Per-frame decay of the hue-jump cross-fade (lower = slower colour change). */
  private readonly HUE_TRANSITION_FADE: number = 0.005;

  // --- State ----------------------------------------------------------------

  /** Time-domain audio buffer (for the horizontal waveforms). */
  private dataArray: Uint8Array<ArrayBuffer>;

  /** Frequency-domain audio buffer (for the rings). */
  private freqArray: Uint8Array<ArrayBuffer>;

  /** Current global hue (degrees). */
  private hue: number;

  /** Integer hue the cached colours were computed for (-1 = uncached). */
  private cachedHue: number = -1;

  /** Pre-computed centre and per-circle radii (recomputed on resize). */
  private centerX: number = 0;
  private centerY: number = 0;
  private readonly radii: number[];

  /**
   * Trail surfaces are larger than the visible canvas so a waveform is preserved
   * while it rotates out of bounds at the sides and back into the corners.
   * trailCx/trailCy is the trail centre, aligned to the screen centre when
   * composited.
   */
  private trailSize: number = 0;
  private trailCx: number = 0;
  private trailCy: number = 0;

  /** Cached per-circle colours, their `rgb(...)` strings, and the wave colour. */
  private readonly circleColors: Rgb[];
  private readonly circleColorStrings: string[];
  private waveColorMain: string = 'rgb(255, 255, 255)';
  private waveColorGlow: string = 'rgba(255, 255, 255, 0.8)';

  /** Cached background fill colour (a shade darker than the darkest circle). */
  private backgroundColorString: string = 'rgb(0, 0, 0)';

  /** Set once destroy() runs so a trailing frame cannot resurrect the surfaces. */
  private destroyed: boolean = false;

  /** Swirl rotation sign (+1 / -1); flipped by each bass trigger. */
  private trailDirection: number = 1;

  /** performance.now() of the last bass trigger, gating the cooldown. */
  private lastBassTriggerTime: number = Number.NEGATIVE_INFINITY;

  /** Flash intensity: 1 on a flashing trigger, decaying to 0 (off). */
  private flashAmount: number = 0;

  /** Old-tower cross-fade strength after a hue jump: 1 (old) decaying to 0 (new). */
  private hueTransition: number = 0;

  /** Pre-allocated point buffers (avoids per-frame allocation). */
  private readonly leftPoints: Point[];
  private readonly rightPoints: Point[];
  private readonly ringRadii: number[];

  /** Trail surface for the frequency rings. */
  private ringsCanvas: HTMLCanvasElement | null = null;
  private ringsCtx: CanvasRenderingContext2D | null = null;

  /** Trail surface for the horizontal waveforms. */
  private horizontalCanvas: HTMLCanvasElement | null = null;
  private horizontalCtx: CanvasRenderingContext2D | null = null;

  /** Scratch surface used while spinning the trails. */
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  /** Tower layer (background + circles) rendered each frame, then composited. */
  private towerCanvas: HTMLCanvasElement | null = null;
  private towerCtx: CanvasRenderingContext2D | null = null;

  /** Snapshot of the old-hue tower, faded out over the new one after a hue jump. */
  private freezeCanvas: HTMLCanvasElement | null = null;
  private freezeCtx: CanvasRenderingContext2D | null = null;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.freqArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this.hue = this.START_HUE;
    this.sensitivity = 0.4;

    this.radii = new Array<number>(this.CIRCLE_COUNT).fill(0);
    this.circleColors = [];
    this.circleColorStrings = new Array<string>(this.CIRCLE_COUNT).fill('rgb(0, 0, 0)');
    for (let i: number = 0; i < this.CIRCLE_COUNT; i++) {
      this.circleColors.push({r: 0, g: 0, b: 0});
    }

    this.leftPoints = WaterVisualization.allocatePoints(this.HORIZONTAL_SAMPLES);
    this.rightPoints = WaterVisualization.allocatePoints(this.HORIZONTAL_SAMPLES);
    this.ringRadii = new Array<number>(this.CIRCULAR_SAMPLES).fill(0);
  }

  /** Allocates a fresh array of zeroed points. */
  private static allocatePoints(count: number): Point[] {
    const points: Point[] = new Array<Point>(count);
    for (let i: number = 0; i < count; i++) {
      points[i] = {x: 0, y: 0};
    }
    return points;
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.freqArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    const width: number = this.width;
    const height: number = this.height;

    this.centerX = width / 2;
    this.centerY = height / 2;

    // The outermost circle slightly overlaps the left/right edges; the six
    // circles are then equally spaced from the centre out to it.
    const outerRadius: number = (width / 2) * this.EDGE_OVERLAP_FACTOR;
    for (let i: number = 0; i < this.CIRCLE_COUNT; i++) {
      this.radii[i] = outerRadius * (i + 1) / this.CIRCLE_COUNT;
    }

    // Trail surface is a square big enough to hold the whole outer circle (and
    // cover the visible canvas), so a waveform survives going out of bounds and
    // re-emerges on the outer circle in the corners.
    const trailHalf: number = Math.ceil(Math.max(outerRadius, this.centerX, this.centerY) + this.TRAIL_MARGIN);
    this.trailSize = trailHalf * 2;
    this.trailCx = trailHalf;
    this.trailCy = trailHalf;

    if (!this.ringsCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.ringsCanvas = offscreen.canvas;
      this.ringsCtx = offscreen.ctx;
    }
    if (!this.horizontalCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.horizontalCanvas = offscreen.canvas;
      this.horizontalCtx = offscreen.ctx;
    }
    if (!this.tempCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.tempCanvas = offscreen.canvas;
      this.tempCtx = offscreen.ctx;
    }
    if (!this.towerCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.towerCanvas = offscreen.canvas;
      this.towerCtx = offscreen.ctx;
    }
    if (!this.freezeCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.freezeCanvas = offscreen.canvas;
      this.freezeCtx = offscreen.ctx;
    }

    // Size the trail surfaces to the trail square (clears them; resize is rare).
    if (this.ringsCanvas.width !== this.trailSize) {
      this.ringsCanvas.width = this.trailSize;
      this.ringsCanvas.height = this.trailSize;
      this.horizontalCanvas.width = this.trailSize;
      this.horizontalCanvas.height = this.trailSize;
      this.tempCanvas.width = this.trailSize;
      this.tempCanvas.height = this.trailSize;
    }

    // The tower layers match the visible canvas, not the larger trail square.
    if (this.towerCanvas.width !== width || this.towerCanvas.height !== height) {
      this.towerCanvas.width = width;
      this.towerCanvas.height = height;
      this.freezeCanvas.width = width;
      this.freezeCanvas.height = height;
    }

    this.ctx.clearRect(0, 0, width, height);
  }

  public override draw(): void {
    if (this.destroyed) return;
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;
    if (width <= 0 || height <= 0) return;

    if (!this.ringsCanvas || !this.horizontalCanvas || !this.tempCanvas
      || !this.towerCanvas || !this.freezeCanvas) {
      this.onResize();
    }
    if (!this.ringsCtx || !this.horizontalCtx || !this.towerCtx || !this.freezeCtx) return;
    const ringsCtx: CanvasRenderingContext2D = this.ringsCtx;
    const horizontalCtx: CanvasRenderingContext2D = this.horizontalCtx;

    // Advance time-based state. A bass hit may flip the swirl and jump the hue.
    this.updateBassTrigger();
    this.hue = (this.hue + this.HUE_CYCLE_SPEED) % 360;
    this.updateColors();

    this.analyser.getByteTimeDomainData(this.dataArray);

    // Age both trails with the same rotate/fade/blur spiral. They are kept on
    // independent layers so neither overdraws the other.
    this.spinTrail(this.ringsCanvas!, ringsCtx, this.RING_FADE);
    this.spinTrail(this.horizontalCanvas!, horizontalCtx, this.HORIZONTAL_FADE);

    // Fresh data: every ring onto its trail, the horizontal onto its trail.
    for (let ring: number = 0; ring < this.RING_COUNT; ring++) {
      this.drawFrequencyRing(ringsCtx, ring);
    }
    this.drawHorizontalWaveforms(horizontalCtx);

    // Tower (background + circles) on its own layer so a hue jump can cross-fade
    // the old colours out beneath the new ones, rather than snapping the whole
    // scene to the new hue in a single frame.
    const towerCtx: CanvasRenderingContext2D = this.towerCtx!;
    towerCtx.fillStyle = this.backgroundColorString;
    towerCtx.fillRect(0, 0, width, height);
    this.drawConcentricCircles(towerCtx);

    ctx.drawImage(this.towerCanvas!, 0, 0);
    if (this.hueTransition > 0) {
      // Lay the snapshot of the old-hue tower over the new one and fade it out, so
      // the new colour is drawn over the old instead of replacing it outright.
      ctx.save();
      ctx.globalAlpha = this.hueTransition;
      ctx.drawImage(this.freezeCanvas!, 0, 0);
      ctx.restore();
      this.hueTransition -= this.HUE_TRANSITION_FADE;
      if (this.hueTransition < 0) this.hueTransition = 0;
    }

    const trailOffsetX: number = this.centerX - this.trailCx;
    const trailOffsetY: number = this.centerY - this.trailCy;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.ringsCanvas!, trailOffsetX, trailOffsetY);
    ctx.drawImage(this.horizontalCanvas!, trailOffsetX, trailOffsetY);
    ctx.restore();

    this.applyFlash(ctx, width, height, trailOffsetX, trailOffsetY);
    this.applyFadeOverlay();
  }

  // === Concentric tower =====================================================

  /**
   * Draws the six filled circles largest (darkest) first so the smaller,
   * brighter circles stack on top, each feathered into the next with a blur.
   */
  private drawConcentricCircles(ctx: CanvasRenderingContext2D): void {
    for (let i: number = this.CIRCLE_COUNT - 1; i >= 0; i--) {
      const colorString: string = this.circleColorStrings[i];
      ctx.save();
      // Keep an intrinsic feather even when the user glow control is at zero.
      ctx.shadowBlur = Math.max(this.CIRCLE_MIN_BLUR, this.getScaledGlowBlur(this.CIRCLE_BASE_BLUR));
      ctx.shadowColor = colorString;
      ctx.fillStyle = colorString;
      ctx.beginPath();
      ctx.arc(this.centerX, this.centerY, this.radii[i], 0, TWO_PI);
      ctx.fill();
      ctx.restore();
    }
  }

  // === Horizontal waveforms =================================================

  /**
   * Draws the left and right horizontal waveforms onto the given (trail) context.
   * The waveforms bend around the smallest circle and the right is a 180-degree
   * rotation of the left.
   */
  private drawHorizontalWaveforms(ctx: CanvasRenderingContext2D): void {
    this.calculateHorizontalPoints();

    const highlight: string = 'rgba(255, 255, 255, 0.5)';
    this.drawPathWithLayers(
      (): void => { this.buildSmoothPath(ctx, this.leftPoints, this.leftPoints.length - 1); },
      this.waveColorMain, this.waveColorGlow, highlight,
      {ctx, baseGlowBlur: this.WAVE_GLOW_BLUR}
    );
    this.drawPathWithLayers(
      (): void => { this.buildSmoothPath(ctx, this.rightPoints, this.rightPoints.length - 1); },
      this.waveColorMain, this.waveColorGlow, highlight,
      {ctx, baseGlowBlur: this.WAVE_GLOW_BLUR}
    );
  }

  /**
   * Fills leftPoints by bending the waveform around the core (in trail space),
   * then derives rightPoints as a point reflection through the centre.
   */
  private calculateHorizontalPoints(): void {
    const data: Uint8Array<ArrayBuffer> = this.dataArray;
    const dataLength: number = data.length;
    const numSamples: number = this.HORIZONTAL_SAMPLES;
    const centerX: number = this.trailCx;
    const centerY: number = this.trailCy;
    const coreRadius: number = this.radii[0];
    const outerRadius: number = this.radii[this.CIRCLE_COUNT - 1];
    const amplitudeScale: number = this.height * this.HORIZONTAL_AMP_FRACTION;
    const sensitivityFactor: number = this.sensitivityFactor;
    // Sample the first half of the buffer across the edge-to-centre span.
    const sampleStep: number = (dataLength / 2) / numSamples;

    for (let i: number = 0; i < numSamples; i++) {
      const dataIndex: number = (i * sampleStep) | 0;
      const sample: number = ((data[dataIndex] - 128) / 128) * sensitivityFactor;
      const amplitude: number = sample * amplitudeScale;

      const t: number = i / (numSamples - 1);
      // Radius sweeps from the outer circle (edge, slightly overlapping) inward
      // to the core, so the waveform's outer end lands on the outer circle and
      // spills past the left/right screen edges.
      const arcRadius: number = outerRadius - t * (outerRadius - coreRadius);

      let arcAngle: number = (amplitude * this.BEND_STRENGTH) / arcRadius;
      if (arcAngle > this.MAX_BEND_ANGLE) arcAngle = this.MAX_BEND_ANGLE;
      else if (arcAngle < -this.MAX_BEND_ANGLE) arcAngle = -this.MAX_BEND_ANGLE;

      // Left waveform sweeps in along the left, bending around the core.
      const angle: number = Math.PI - arcAngle;
      const lx: number = centerX + arcRadius * Math.cos(angle);
      const ly: number = centerY + arcRadius * Math.sin(angle);
      this.leftPoints[i].x = lx;
      this.leftPoints[i].y = ly;

      // Right waveform: 180-degree rotation about the centre (mirror + flip).
      this.rightPoints[i].x = centerX * 2 - lx;
      this.rightPoints[i].y = centerY * 2 - ly;
    }
  }

  // === Frequency rings ======================================================

  /**
   * Draws one frequency ring (the currently revealed one) onto its trail. The
   * middle of the spectrum is split into RING_COUNT buckets; this ring uses its
   * bucket as a peaks-only two-level square wave - each angular sample sits on
   * its own circle (baseline) or jumps to the next circle out (ceiling) once the
   * bin clears PEAK_THRESHOLD. Peak interiors are filled and only the peaks are
   * outlined (no baseline). Coloured to match the circle it sits on.
   */
  private drawFrequencyRing(ctx: CanvasRenderingContext2D, ring: number): void {
    this.analyser.getByteFrequencyData(this.freqArray);

    const binCount: number = this.freqArray.length;
    const numSamples: number = this.CIRCULAR_SAMPLES;
    const sensitivityFactor: number = this.sensitivityFactor;

    // Logarithmic (octave-like) bucket for this ring so each ring spans a similar
    // perceptual range, with a per-ring gain compensating the high-frequency
    // rolloff - both spread activity more evenly than equal linear buckets.
    const lo: number = Math.max(1, binCount * this.FREQ_TRIM_FRACTION);
    const hi: number = binCount * (1 - this.FREQ_TRIM_FRACTION);
    const ratio: number = hi / lo;
    const binLo: number = lo * Math.pow(ratio, ring / this.RING_COUNT);
    const binHi: number = lo * Math.pow(ratio, (ring + 1) / this.RING_COUNT);
    const bucketSpan: number = binHi - binLo;

    const baseRadius: number = this.radii[ring];
    const ceilRadius: number = this.radii[ring + 1];
    // Line and fill match the colour of the circle this ring is attached to.
    const color: Rgb = this.circleColors[ring];
    const mainColor: string = this.circleColorStrings[ring];
    const glowColor: string = `rgba(${color.r}, ${color.g}, ${color.b}, 0.8)`;

    // Map the bucket across one segment, then repeat it around the circle so the
    // ring is rotationally symmetric (RING_REPEAT copies).
    const segLen: number = (numSamples / this.RING_REPEAT) | 0;
    for (let i: number = 0; i < segLen; i++) {
      // Map this segment sample to a frequency bin inside the ring's bucket.
      const bin: number = Math.min(binCount - 1, (binLo + (i / segLen) * bucketSpan) | 0);
      const magnitude: number = this.freqArray[bin] / 255;
      // Two positions only: ceiling (next circle) when the bin is loud enough,
      // otherwise baseline (this ring's own circle).
      const radius: number = magnitude * sensitivityFactor >= this.PEAK_THRESHOLD ? ceilRadius : baseRadius;
      for (let rep: number = 0; rep < this.RING_REPEAT; rep++) {
        this.ringRadii[i + rep * segLen] = radius;
      }
    }

    // Fill each peak as a rounded sector (solid interior).
    ctx.save();
    ctx.globalAlpha = this.PEAK_FILL_ALPHA;
    ctx.fillStyle = mainColor;
    this.appendRoundedPeaks(ctx, baseRadius, ceilRadius, true);
    ctx.fill();
    ctx.restore();

    // Glowing rounded outline of the peaks (walls + rounded tops, no baseline).
    this.drawPathWithLayers(
      (): void => { this.appendRoundedPeaks(ctx, baseRadius, ceilRadius, false); },
      mainColor, glowColor, undefined,
      {ctx, baseGlowBlur: this.WAVE_GLOW_BLUR}
    );
  }

  /**
   * Appends each peak run to the current path as a rounded annular sector
   * (border-radius-style corners). When withBottom is true the sector is closed
   * across the baseline (for filling); otherwise only the walls + rounded tops +
   * ceiling are traced (an open cap, so the baseline is never drawn). Scanning
   * starts from a baseline gap so a run never wraps the angle-0 seam.
   */
  private appendRoundedPeaks(
    ctx: CanvasRenderingContext2D,
    baseRadius: number,
    ceilRadius: number,
    withBottom: boolean
  ): void {
    const numSamples: number = this.CIRCULAR_SAMPLES;
    const radii: number[] = this.ringRadii;

    ctx.beginPath();

    let gap: number = -1;
    for (let i: number = 0; i < numSamples; i++) {
      if (radii[i] <= baseRadius) { gap = i; break; }
    }

    if (gap < 0) {
      // Every sample is a peak: a full ring (no walls or corners).
      ctx.arc(this.trailCx, this.trailCy, ceilRadius, 0, TWO_PI);
      if (withBottom) {
        ctx.moveTo(this.trailCx + baseRadius, this.trailCy);
        ctx.arc(this.trailCx, this.trailCy, baseRadius, 0, TWO_PI, true);
      }
      return;
    }

    let i: number = (gap + 1) % numSamples;
    let scanned: number = 0;
    let runStart: number = -1;
    while (scanned < numSamples) {
      if (radii[i] > baseRadius) {
        if (runStart < 0) runStart = i;
      } else if (runStart >= 0) {
        this.appendTooth(ctx, runStart, (i - 1 + numSamples) % numSamples, baseRadius, ceilRadius, withBottom);
        runStart = -1;
      }
      i = (i + 1) % numSamples;
      scanned++;
    }
  }

  /**
   * Appends one peak (sample run startIdx..endIdx) as a rounded sector: radial
   * walls, an arc'd ceiling and quadratic-rounded corners. The corner radius is
   * clamped to fit both the wall height and the run's arc length.
   */
  private appendTooth(
    ctx: CanvasRenderingContext2D,
    startIdx: number,
    endIdx: number,
    baseRadius: number,
    ceilRadius: number,
    withBottom: boolean
  ): void {
    const angleStep: number = TWO_PI / this.CIRCULAR_SAMPLES;
    const cx: number = this.trailCx;
    const cy: number = this.trailCy;

    const a0: number = startIdx * angleStep;
    let a1: number = (endIdx + 1) * angleStep;
    if (a1 <= a0) a1 += TWO_PI; // run wrapped the seam

    let cr: number = this.PEAK_CORNER_RADIUS;
    const maxByWall: number = (ceilRadius - baseRadius) * 0.5;
    const maxByArc: number = (a1 - a0) * baseRadius * 0.5;
    if (cr > maxByWall) cr = maxByWall;
    if (cr > maxByArc) cr = maxByArc;

    const dCeil: number = cr / ceilRadius;
    const dBase: number = cr / baseRadius;
    const wallBase: number = withBottom ? baseRadius + cr : baseRadius;

    // Left wall up, rounded top-left, ceiling, rounded top-right, right wall down.
    ctx.moveTo(cx + wallBase * Math.cos(a0), cy + wallBase * Math.sin(a0));
    ctx.lineTo(cx + (ceilRadius - cr) * Math.cos(a0), cy + (ceilRadius - cr) * Math.sin(a0));
    ctx.quadraticCurveTo(
      cx + ceilRadius * Math.cos(a0), cy + ceilRadius * Math.sin(a0),
      cx + ceilRadius * Math.cos(a0 + dCeil), cy + ceilRadius * Math.sin(a0 + dCeil)
    );
    ctx.arc(cx, cy, ceilRadius, a0 + dCeil, a1 - dCeil, false);
    ctx.quadraticCurveTo(
      cx + ceilRadius * Math.cos(a1), cy + ceilRadius * Math.sin(a1),
      cx + (ceilRadius - cr) * Math.cos(a1), cy + (ceilRadius - cr) * Math.sin(a1)
    );
    ctx.lineTo(cx + wallBase * Math.cos(a1), cy + wallBase * Math.sin(a1));

    if (!withBottom) return;

    // Rounded bottom-right, base arc back, rounded bottom-left, then close.
    ctx.quadraticCurveTo(
      cx + baseRadius * Math.cos(a1), cy + baseRadius * Math.sin(a1),
      cx + baseRadius * Math.cos(a1 - dBase), cy + baseRadius * Math.sin(a1 - dBase)
    );
    ctx.arc(cx, cy, baseRadius, a1 - dBase, a0 + dBase, true);
    ctx.quadraticCurveTo(
      cx + baseRadius * Math.cos(a0), cy + baseRadius * Math.sin(a0),
      cx + (baseRadius + cr) * Math.cos(a0), cy + (baseRadius + cr) * Math.sin(a0)
    );
    ctx.closePath();
  }

  // === Trails & colour ======================================================

  /**
   * Reads the spectrum and fires a bass trigger when the low-frequency energy
   * crosses BASS_THRESHOLD, at most once every BASS_COOLDOWN_MS. Each trigger
   * reverses the trail swirl direction and jumps the hue, so a heavy bass hit
   * visibly flips the spiral and recolours the scene.
   */
  private updateBassTrigger(): void {
    this.analyser.getByteFrequencyData(this.freqArray);

    const binCount: number = this.freqArray.length;
    const bassBins: number = Math.max(1, (binCount * this.BASS_BIN_FRACTION) | 0);
    let sum: number = 0;
    for (let b: number = 0; b < bassBins; b++) sum += this.freqArray[b];
    const bassLevel: number = sum / bassBins / 255;

    if (bassLevel < this.BASS_THRESHOLD) return;

    const now: number = performance.now();
    if (now - this.lastBassTriggerTime < this.BASS_COOLDOWN_MS) return;

    this.lastBassTriggerTime = now;
    this.trailDirection = -this.trailDirection;

    // Snapshot the current (old-hue) tower, then jump the hue; the snapshot is
    // faded out over the new-hue tower so the colour layers in instead of flipping.
    if (this.towerCanvas && this.freezeCanvas && this.freezeCtx) {
      this.freezeCtx.clearRect(0, 0, this.freezeCanvas.width, this.freezeCanvas.height);
      this.freezeCtx.drawImage(this.towerCanvas, 0, 0);
      this.hueTransition = 1;
    }
    this.hue = (this.hue + this.HUE_JUMP_DEGREES) % 360;

    // Only some hits flash the scene white/black.
    if (Math.random() < this.FLASH_PROBABILITY) {
      this.flashAmount = 1;
    }
  }

  /**
   * Paints the flash over the finished frame while a flash is active: the whole
   * canvas washes to white and the horizontal waveform is laid back over it as a
   * dark shade of the current hue that lightens as the flash decays, so the scene
   * fades back to its normal colours. Additive compositing would hide the dark
   * waveform, so it is recoloured via source-in on the scratch surface.
   */
  private applyFlash(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    offsetX: number,
    offsetY: number
  ): void {
    if (this.flashAmount <= 0) return;
    const f: number = this.flashAmount;
    const size: number = this.trailSize;

    // Wash the whole frame toward white.
    ctx.save();
    ctx.globalAlpha = f;
    ctx.fillStyle = 'rgb(255, 255, 255)';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    // Recolour the horizontal trail to a dark shade of the current hue on the
    // scratch surface; the shade lightens toward the normal wave colour as it fades.
    const lightness: number =
      this.INNER_LIGHTNESS - (this.INNER_LIGHTNESS - this.FLASH_WAVE_DARK_LIGHTNESS) * f;
    const waveColor: Rgb = this.hslToRgb(this.hue, this.CIRCLE_SATURATION, lightness);
    const tempCanvas: HTMLCanvasElement = this.tempCanvas!;
    const tempCtx: CanvasRenderingContext2D = this.tempCtx!;
    tempCtx.save();
    tempCtx.globalCompositeOperation = 'source-over';
    tempCtx.clearRect(0, 0, size, size);
    tempCtx.drawImage(this.horizontalCanvas!, 0, 0);
    tempCtx.globalCompositeOperation = 'source-in';
    tempCtx.fillStyle = `rgb(${waveColor.r}, ${waveColor.g}, ${waveColor.b})`;
    tempCtx.fillRect(0, 0, size, size);
    tempCtx.restore();

    // Lay the dark-hue waveform over the white wash.
    ctx.save();
    ctx.globalAlpha = f;
    ctx.drawImage(tempCanvas, offsetX, offsetY);
    ctx.restore();

    this.flashAmount -= this.FLASH_FADE;
    if (this.flashAmount < 0) this.flashAmount = 0;
  }

  /**
   * Ages a trail surface by one frame: copies it out, clears it, then draws it
   * back rotated and faded about the trail centre. The repeated resample is what
   * produces the spiral blur, and the alpha is the fade.
   */
  private spinTrail(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, fadeRate: number): void {
    const size: number = this.trailSize;
    const tempCanvas: HTMLCanvasElement = this.tempCanvas!;
    const tempCtx: CanvasRenderingContext2D = this.tempCtx!;

    tempCtx.clearRect(0, 0, size, size);
    tempCtx.drawImage(canvas, 0, 0);

    ctx.clearRect(0, 0, size, size);

    const effectiveFade: number = fadeRate * this.getFadeMultiplier();
    const pivotX: number = Math.floor(this.trailCx);
    const pivotY: number = Math.floor(this.trailCy);

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = 1 - effectiveFade;
    ctx.translate(pivotX, pivotY);
    ctx.rotate(this.TRAIL_ROTATION * this.trailDirection);
    ctx.translate(-pivotX, -pivotY);
    ctx.drawImage(tempCanvas, 0, 0);
    ctx.restore();
  }

  /** Recomputes the cached circle, waveform and background colours on hue change. */
  private updateColors(): void {
    const hueInt: number = Math.floor(this.hue);
    if (hueInt === this.cachedHue) return;
    this.cachedHue = hueInt;

    const span: number = this.CIRCLE_COUNT - 1;
    for (let i: number = 0; i < this.CIRCLE_COUNT; i++) {
      // Brightness fraction: 1 at the innermost circle, 0 at the outermost.
      const brightness: number = (span - i) / span;
      const lightness: number = this.OUTER_LIGHTNESS + (this.INNER_LIGHTNESS - this.OUTER_LIGHTNESS) * brightness;
      const rgb: Rgb = this.hslToRgb(this.hue, this.CIRCLE_SATURATION, lightness);
      this.circleColors[i].r = rgb.r;
      this.circleColors[i].g = rgb.g;
      this.circleColors[i].b = rgb.b;
      this.circleColorStrings[i] = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    }

    // The horizontal waveforms share the brightest (top) circle's colour.
    const wave: Rgb = this.circleColors[0];
    this.waveColorMain = `rgb(${wave.r}, ${wave.g}, ${wave.b})`;
    this.waveColorGlow = `rgba(${wave.r}, ${wave.g}, ${wave.b}, 0.8)`;

    // Background: same hue, a shade darker than the darkest circle.
    const background: Rgb = this.hslToRgb(this.hue, this.CIRCLE_SATURATION, this.BACKGROUND_LIGHTNESS);
    this.backgroundColorString = `rgb(${background.r}, ${background.g}, ${background.b})`;
  }

  public override destroy(): void {
    this.destroyed = true;
    this.ringsCanvas = null;
    this.ringsCtx = null;
    this.horizontalCanvas = null;
    this.horizontalCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
    this.towerCanvas = null;
    this.towerCtx = null;
    this.freezeCanvas = null;
    this.freezeCtx = null;
  }
}

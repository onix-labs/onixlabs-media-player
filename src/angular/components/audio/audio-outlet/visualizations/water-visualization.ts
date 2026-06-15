/**
 * @fileoverview Water visualization (Ambience / Water).
 *
 * A reimagining of the classic "Ambience / Water" media-player visual.
 *
 * The frame is built from four surgical layers, drawn back-to-front:
 *
 *   1. Concentric tower - six filled, centered circles stacked brightest
 *      (smallest, on top) to darkest (largest, underneath), feathered into
 *      one another with a mild blur. Looks like a Tower of Hanoi from above.
 *
 *   2. Horizontal waveforms - a left and a right waveform that start at the
 *      screen edges, run inward and bend around the smallest circle like light
 *      bending around a black hole (they can never cross the core). The right
 *      waveform is a 180-degree rotation of the left, so the pair is
 *      rotationally symmetrical. Their history is pulled toward the centre in a
 *      whirlpool: spiralling, blurring and fading.
 *
 *   3. Circular square-wave - a castellated square wave whose rest line sits on
 *      the second circle. Peaks ceiling outward to the third circle and are
 *      pushed toward the edge; troughs floor inward to the first circle and are
 *      sucked toward the centre as though falling into a black hole. Both
 *      bleed across circle boundaries as they spiral, blur and fade.
 *
 *   4. Effects - per-element glow, a slow hue drift (the whole scene breathes
 *      from blue through to red and back), and the trail blur/fade that powers
 *      every spiral.
 *
 * Colour comes from a single slowly-cycling hue so the entire visual drifts
 * through the spectrum; the waveforms always match the brightest (top) circle.
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
 * Water visualization: a concentric glowing tower wrapped in mirrored
 * horizontal waveforms and a circular square wave, all spiralling into and out
 * of the centre.
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
  private readonly EDGE_OVERLAP_FACTOR: number = 1.06;

  /** Saturation used for every circle (percent). */
  private readonly CIRCLE_SATURATION: number = 85;

  /** Lightness of the innermost (brightest) circle (percent). */
  private readonly INNER_LIGHTNESS: number = 64;

  /** Lightness of the outermost (darkest) circle (percent). */
  private readonly OUTER_LIGHTNESS: number = 16;

  /** Lightness of the background fill - a shade darker than the darkest circle. */
  private readonly BACKGROUND_LIGHTNESS: number = 4;

  /** Base blur radius used to feather one circle into the next (pixels). */
  private readonly CIRCLE_BASE_BLUR: number = 4;

  /**
   * Minimum feather between circles, applied even when the user glow control is
   * zero. The "mild blur from one circle to the next" is intrinsic to the tower,
   * so it must not be multiplied away by glowIntensity.
   */
  private readonly CIRCLE_MIN_BLUR: number = 80;

  /** Ambient radial-wash opacity behind the tower. */
  private readonly AMBIENT_OPACITY: number = 0.12;

  // --- Waveform colour ------------------------------------------------------

  /**
   * Glow blur radius for the waveforms (pixels). The waveform colour itself is
   * not configured here: it is taken from the brightest (top) circle so the two
   * always match, per the spec.
   */
  private readonly WAVE_GLOW_BLUR: number = 14;

  /** Opacity of the static rest line drawn on the second circle. */
  private readonly BASELINE_OPACITY: number = 0.22;

  // --- Horizontal waveforms -------------------------------------------------

  /** Samples per horizontal waveform (edge to centre). */
  private readonly HORIZONTAL_SAMPLES: number = 32;

  /** Horizontal amplitude as a fraction of screen height. */
  private readonly HORIZONTAL_AMP_FRACTION: number = 0.22;

  /** How hard the horizontal waveform bends around the core. */
  private readonly BEND_STRENGTH: number = 1.0;

  /** Maximum bend angle so the waveform never wraps over the core (radians). */
  private readonly MAX_BEND_ANGLE: number = 1.4;

  // --- Circular square wave -------------------------------------------------

  /** Angular samples around the circular waveform. */
  private readonly CIRCULAR_SAMPLES: number = 96;

  /** Per-frame rotation of the freshly drawn circular wave (radians). */
  private readonly WAVE_ROTATION_SPEED: number = 0.003;

  // --- Trails (spiral / blur / fade) ---------------------------------------

  /** Per-frame scale of the inward (black-hole) trail. Below 1 = pulled in. */
  private readonly INWARD_SCALE: number = 0.975;

  /** Per-frame scale of the outward (push) trail. Above 1 = pushed out. */
  private readonly OUTWARD_SCALE: number = 1.022;

  /** Per-frame rotation of the inward trail (radians). */
  private readonly INWARD_ROTATION: number = 0.006;

  /** Per-frame rotation of the outward trail (radians). */
  private readonly OUTWARD_ROTATION: number = 0.004;

  /** Per-frame fade of the inward trail. */
  private readonly INWARD_FADE: number = 0.04;

  /** Per-frame fade of the outward trail. */
  private readonly OUTWARD_FADE: number = 0.03;

  /** Extra trail-canvas margin beyond the outer circle, for glow (pixels). */
  private readonly TRAIL_MARGIN: number = 24;

  // --- Colour cycling -------------------------------------------------------

  /** Per-frame hue drift (degrees). */
  private readonly HUE_CYCLE_SPEED: number = 0.08;

  /** Starting hue (degrees) - blue, matching the reference. */
  private readonly START_HUE: number = 220;

  // --- State ----------------------------------------------------------------

  /** Time-domain audio buffer. */
  private dataArray: Uint8Array<ArrayBuffer>;

  /** Current global hue (degrees). */
  private hue: number;

  /** Integer hue the cached colours were computed for (-1 = uncached). */
  private cachedHue: number = -1;

  /** Rotation applied to the freshly drawn circular wave (radians). */
  // Reassigned by the circular-wave layer, which is currently disabled in draw().
  // eslint-disable-next-line @typescript-eslint/prefer-readonly
  private waveAngle: number = 0;

  /** Pre-computed centre and per-circle radii (recomputed on resize). */
  private centerX: number = 0;
  private centerY: number = 0;
  private readonly radii: number[];

  /**
   * Trail surfaces are larger than the visible canvas so the swirling waveform
   * is preserved while it rotates out of bounds at the sides and back into the
   * corners - landing exactly on the outer circle. trailCx/trailCy is the trail
   * centre, aligned to the screen centre when composited.
   */
  private trailSize: number = 0;
  private trailCx: number = 0;
  private trailCy: number = 0;

  /** Cached per-circle colours, their `rgb(...)` strings, and the wave colours. */
  private readonly circleColors: Rgb[];
  private readonly circleColorStrings: string[];
  private waveColorMain: string = 'rgb(255, 255, 255)';
  private waveColorGlow: string = 'rgba(255, 255, 255, 0.8)';

  /** Cached background fill colour (a shade darker than the darkest circle). */
  private backgroundColorString: string = 'rgb(0, 0, 0)';

  /** Cached ambient radial gradient (rebuilt only on resize or hue change). */
  private ambientGradient: CanvasGradient | null = null;
  private ambientDirty: boolean = true;

  /** Set once destroy() runs so a trailing frame cannot resurrect the surfaces. */
  private destroyed: boolean = false;

  /** Pre-allocated point buffers (avoids per-frame allocation). */
  private readonly leftPoints: Point[];
  private readonly rightPoints: Point[];
  private readonly outwardPoints: Point[];
  private readonly inwardPoints: Point[];
  private readonly outwardRadii: number[];
  private readonly inwardRadii: number[];

  /** Inward (whirlpool / black-hole) trail surface. */
  private inwardCanvas: HTMLCanvasElement | null = null;
  private inwardCtx: CanvasRenderingContext2D | null = null;

  /** Outward (pushed-to-edge) trail surface. */
  private outwardCanvas: HTMLCanvasElement | null = null;
  private outwardCtx: CanvasRenderingContext2D | null = null;

  /** Scratch surface used while spinning the trails. */
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
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
    // Two vertices per angular sample (a flat top then a radial jump).
    this.outwardPoints = WaterVisualization.allocatePoints(this.CIRCULAR_SAMPLES * 2);
    this.inwardPoints = WaterVisualization.allocatePoints(this.CIRCULAR_SAMPLES * 2);
    this.outwardRadii = new Array<number>(this.CIRCULAR_SAMPLES).fill(0);
    this.inwardRadii = new Array<number>(this.CIRCULAR_SAMPLES).fill(0);
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
    // Geometry changed: the cached ambient gradient must be rebuilt.
    this.ambientDirty = true;

    // Trail surface is a square big enough to hold the whole outer circle (and
    // cover the visible canvas), so the swirling waveform survives going out of
    // bounds and re-emerges on the outer circle in the corners.
    const trailHalf: number = Math.ceil(Math.max(outerRadius, this.centerX, this.centerY) + this.TRAIL_MARGIN);
    this.trailSize = trailHalf * 2;
    this.trailCx = trailHalf;
    this.trailCy = trailHalf;

    if (!this.inwardCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.inwardCanvas = offscreen.canvas;
      this.inwardCtx = offscreen.ctx;
    }
    if (!this.outwardCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.outwardCanvas = offscreen.canvas;
      this.outwardCtx = offscreen.ctx;
    }
    if (!this.tempCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.tempCanvas = offscreen.canvas;
      this.tempCtx = offscreen.ctx;
    }

    // Size the trail surfaces to the trail square (clears them; resize is rare).
    if (this.inwardCanvas.width !== this.trailSize) {
      this.inwardCanvas.width = this.trailSize;
      this.inwardCanvas.height = this.trailSize;
      this.outwardCanvas.width = this.trailSize;
      this.outwardCanvas.height = this.trailSize;
      this.tempCanvas.width = this.trailSize;
      this.tempCanvas.height = this.trailSize;
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

    if (!this.inwardCanvas || !this.outwardCanvas || !this.tempCanvas) {
      this.onResize();
    }

    // Horizontal waveforms are enabled; the circular wave / outward trail stay off.
    if (!this.inwardCtx) return;
    const inwardCtx: CanvasRenderingContext2D = this.inwardCtx;
    // const outwardCtx: CanvasRenderingContext2D = this.outwardCtx;

    // Advance time-based state.
    this.hue = (this.hue + this.HUE_CYCLE_SPEED) % 360;
    // this.waveAngle += this.WAVE_ROTATION_SPEED;
    this.updateColors();

    this.analyser.getByteTimeDomainData(this.dataArray);

    // Step 4 (per frame): rotate + fade the waveform trail so it follows the
    // circle contours. Scale 1 means no radial pull (it is not sucked inward);
    // the rotation makes every point orbit the centre along its own circle.
    this.spinTrail(this.inwardCanvas!, inwardCtx, 1, this.INWARD_ROTATION, this.INWARD_FADE);
    // this.spinTrail(this.outwardCanvas!, outwardCtx, this.OUTWARD_SCALE, -this.OUTWARD_ROTATION, this.OUTWARD_FADE);

    // Step 2: draw fresh horizontal-waveform data onto the inward trail surface.
    // this.drawCircularWave(inwardCtx, outwardCtx);
    this.drawHorizontalWaveforms(inwardCtx);

    // Compose the frame: background, tower, then the spiralling waveforms on top.
    ctx.fillStyle = this.backgroundColorString;
    ctx.fillRect(0, 0, width, height);
    // this.drawAmbientWash(ctx);
    this.drawConcentricCircles(ctx);
    // this.drawBaselineRing(ctx);

    // Composite the trail centred on the screen: the trail centre maps to the
    // screen centre, so the waveform's outer boundary lands on the outer circle.
    const trailOffsetX: number = this.centerX - this.trailCx;
    const trailOffsetY: number = this.centerY - this.trailCy;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // ctx.drawImage(this.outwardCanvas!, trailOffsetX, trailOffsetY);
    ctx.drawImage(this.inwardCanvas!, trailOffsetX, trailOffsetY);
    ctx.restore();

    this.applyFadeOverlay();
  }

  // ==========================================================================
  // Step 1 - Concentric tower
  // ==========================================================================

  /**
   * Faint radial wash so the tower bleeds into the surrounding darkness. The
   * gradient is cached and only rebuilt on resize or when the hue ticks, since
   * rebuilding it every frame is the single largest avoidable allocation.
   */
  private drawAmbientWash(ctx: CanvasRenderingContext2D): void {
    if (this.ambientDirty || !this.ambientGradient) {
      const inner: Rgb = this.circleColors[0];
      const gradient: CanvasGradient = ctx.createRadialGradient(
        this.centerX, this.centerY, 0,
        this.centerX, this.centerY, this.radii[this.CIRCLE_COUNT - 1]
      );
      gradient.addColorStop(0, `rgba(${inner.r}, ${inner.g}, ${inner.b}, ${this.AMBIENT_OPACITY})`);
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      this.ambientGradient = gradient;
      this.ambientDirty = false;
    }

    ctx.save();
    ctx.fillStyle = this.ambientGradient;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }

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

  /** Crisp, stable rest line on the second circle (circular-wave baseline). */
  private drawBaselineRing(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.globalAlpha = this.BASELINE_OPACITY;
    ctx.strokeStyle = this.waveColorMain;
    ctx.lineWidth = this.lineWidth;
    ctx.shadowBlur = this.getScaledGlowBlur(this.WAVE_GLOW_BLUR);
    ctx.shadowColor = this.waveColorGlow;
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, this.radii[1], 0, TWO_PI);
    ctx.stroke();
    ctx.restore();
  }

  // ==========================================================================
  // Step 2 - Horizontal mirrored waveforms
  // ==========================================================================

  /**
   * Draws the left and right horizontal waveforms onto the inward trail so
   * they spiral toward the centre (whirlpool). The waveforms bend around the
   * smallest circle and the right is a 180-degree rotation of the left.
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
   * Fills leftPoints by bending the waveform around the core, then derives
   * rightPoints as a point reflection through the centre (rotational symmetry).
   */
  private calculateHorizontalPoints(): void {
    const data: Uint8Array<ArrayBuffer> = this.dataArray;
    const dataLength: number = data.length;
    const numSamples: number = this.HORIZONTAL_SAMPLES;
    // Waveform is drawn into the (larger) trail surface, so use the trail centre.
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
      // to the core, so the waveform's outer end lands on the outer circle's
      // circumference and spills past the left/right screen edges.
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

  // ==========================================================================
  // Step 3 - Circular square wave
  // ==========================================================================

  /**
   * Draws the castellated square wave. Outward (peak) castellation is rendered
   * on the outward trail so peaks are pushed toward the edge; inward (trough)
   * castellation is rendered on the inward trail so troughs are sucked toward
   * the centre. Together they reconstruct the full square wave each frame.
   */
  private drawCircularWave(inwardCtx: CanvasRenderingContext2D, outwardCtx: CanvasRenderingContext2D): void {
    this.calculateCircularRadii();
    this.buildCastellation(this.outwardPoints, this.outwardRadii);
    this.buildCastellation(this.inwardPoints, this.inwardRadii);

    this.drawPathWithLayers(
      (): void => { this.buildPolyline(outwardCtx, this.outwardPoints); },
      this.waveColorMain, this.waveColorGlow, undefined,
      {ctx: outwardCtx, baseGlowBlur: this.WAVE_GLOW_BLUR, closePath: true}
    );
    this.drawPathWithLayers(
      (): void => { this.buildPolyline(inwardCtx, this.inwardPoints); },
      this.waveColorMain, this.waveColorGlow, undefined,
      {ctx: inwardCtx, baseGlowBlur: this.WAVE_GLOW_BLUR, closePath: true}
    );
  }

  /**
   * Computes per-sample radii. Peaks ceiling at the third circle, troughs floor
   * at the first circle, both measured from the second-circle rest line. The
   * outward radii hold the baseline on troughs; the inward radii hold the
   * baseline on peaks - so each trail only ever moves in one direction.
   */
  private calculateCircularRadii(): void {
    const data: Uint8Array<ArrayBuffer> = this.dataArray;
    const dataLength: number = data.length;
    const numSamples: number = this.CIRCULAR_SAMPLES;
    const sensitivityFactor: number = this.sensitivityFactor;
    const sampleStep: number = (dataLength / 2) / numSamples;

    const innerRadius: number = this.radii[0];
    const baseRadius: number = this.radii[1];
    const outerRadius: number = this.radii[2];
    const outwardSpan: number = outerRadius - baseRadius;
    const inwardSpan: number = baseRadius - innerRadius;

    for (let i: number = 0; i < numSamples; i++) {
      const dataIndex: number = (i * sampleStep) | 0;
      const sample: number = ((data[dataIndex] - 128) / 128) * sensitivityFactor;

      let radius: number;
      if (sample >= 0) {
        radius = baseRadius + sample * outwardSpan;
        if (radius > outerRadius) radius = outerRadius;
      } else {
        radius = baseRadius + sample * inwardSpan;
        if (radius < innerRadius) radius = innerRadius;
      }

      this.outwardRadii[i] = radius > baseRadius ? radius : baseRadius;
      this.inwardRadii[i] = radius < baseRadius ? radius : baseRadius;
    }
  }

  /**
   * Builds a castellated (square-wave) ring into the given point buffer: each
   * sample holds its radius across its angular slice, then jumps radially to
   * the next sample's radius.
   */
  private buildCastellation(points: Point[], radii: number[]): void {
    const numSamples: number = this.CIRCULAR_SAMPLES;
    const centerX: number = this.centerX;
    const centerY: number = this.centerY;
    const angleStep: number = TWO_PI / numSamples;
    const baseAngle: number = this.waveAngle;

    let k: number = 0;
    for (let i: number = 0; i < numSamples; i++) {
      const radius: number = radii[i];
      const a0: number = baseAngle + i * angleStep;
      const a1: number = baseAngle + (i + 1) * angleStep;

      points[k].x = centerX + radius * Math.cos(a0);
      points[k].y = centerY + radius * Math.sin(a0);
      k++;
      points[k].x = centerX + radius * Math.cos(a1);
      points[k].y = centerY + radius * Math.sin(a1);
      k++;
    }
  }

  /** Strokes a straight-segment polyline through every point (square edges). */
  private buildPolyline(ctx: CanvasRenderingContext2D, points: Point[]): void {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i: number = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
  }

  // ==========================================================================
  // Step 4 - Effects (trail spiral + colour)
  // ==========================================================================

  /**
   * Ages a trail surface by one frame: copies it out, clears it, then draws it
   * back rotated, scaled and faded about the centre. Scale below 1 pulls the
   * history toward the centre; above 1 pushes it toward the edge. The repeated
   * resample is what produces the spiral blur, and the alpha is the fade.
   */
  private spinTrail(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    scale: number,
    rotation: number,
    fadeRate: number
  ): void {
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
    ctx.rotate(rotation);
    ctx.scale(scale, scale);
    ctx.translate(-pivotX, -pivotY);
    ctx.drawImage(tempCanvas, 0, 0);
    ctx.restore();
  }

  /** Recomputes cached circle and waveform colours when the hue moves. */
  private updateColors(): void {
    const hueInt: number = Math.floor(this.hue);
    if (hueInt === this.cachedHue) return;
    this.cachedHue = hueInt;
    this.ambientDirty = true;

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

    // The waveforms share the brightest (top) circle's colour, per the spec.
    const wave: Rgb = this.circleColors[0];
    this.waveColorMain = `rgb(${wave.r}, ${wave.g}, ${wave.b})`;
    this.waveColorGlow = `rgba(${wave.r}, ${wave.g}, ${wave.b}, 0.8)`;

    // Background: same hue as the tower, a shade darker than the darkest circle.
    const background: Rgb = this.hslToRgb(this.hue, this.CIRCLE_SATURATION, this.BACKGROUND_LIGHTNESS);
    this.backgroundColorString = `rgb(${background.r}, ${background.g}, ${background.b})`;
  }

  public override destroy(): void {
    this.destroyed = true;
    this.ambientGradient = null;
    this.inwardCanvas = null;
    this.inwardCtx = null;
    this.outwardCanvas = null;
    this.outwardCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}

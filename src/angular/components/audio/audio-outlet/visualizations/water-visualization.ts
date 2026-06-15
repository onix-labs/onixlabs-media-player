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
  private readonly RING_COUNT: number = 6;

  /** Delay between revealing each ring, from the centre outward (ms). */
  private readonly REVEAL_INTERVAL_MS: number = 250;

  /** Fraction of FFT bins trimmed from each end before bucketing (low & high). */
  private readonly FREQ_TRIM_FRACTION: number = 0.2;

  /** Magnitude (after sensitivity) at/above which a sample jumps to the ceiling. */
  private readonly PEAK_THRESHOLD: number = 0.1125;

  /** Opacity of the filled interior of each peak (1 = solid). */
  private readonly PEAK_FILL_ALPHA: number = 1;

  // --- Trails (spiral / blur / fade) ----------------------------------------

  /** Per-frame rotation of the trail surfaces (radians). */
  private readonly TRAIL_ROTATION: number = 0.006;

  /** Per-frame fade of the trail surfaces. */
  private readonly TRAIL_FADE: number = 0.008;

  /** Extra trail-canvas margin beyond the outer circle, for glow (pixels). */
  private readonly TRAIL_MARGIN: number = 20;

  // --- Colour cycling -------------------------------------------------------

  /** Per-frame hue drift (degrees). */
  private readonly HUE_CYCLE_SPEED: number = 0.08;

  /** Starting hue (degrees) - blue, matching the reference. */
  private readonly START_HUE: number = 220;

  // --- State ----------------------------------------------------------------

  /** Time-domain audio buffer (for the horizontal waveforms). */
  private dataArray: Uint8Array<ArrayBuffer>;

  /** Frequency-domain audio buffer (for the rings). */
  private freqArray: Uint8Array<ArrayBuffer>;

  /** Current global hue (degrees). */
  private hue: number;

  /** Integer hue the cached colours were computed for (-1 = uncached). */
  private cachedHue: number = -1;

  /** Timestamp (ms) the ring reveal started; -1 until the first frame / replay. */
  private revealStartTime: number = -1;

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

  /** Pre-allocated point buffers (avoids per-frame allocation). */
  private readonly leftPoints: Point[];
  private readonly rightPoints: Point[];
  private readonly ringPoints: Point[];
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
    // Two vertices per angular sample (a flat top then a radial jump).
    this.ringPoints = WaterVisualization.allocatePoints(this.CIRCULAR_SAMPLES * 2);
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

    // Size the trail surfaces to the trail square (clears them; resize is rare).
    if (this.ringsCanvas.width !== this.trailSize) {
      this.ringsCanvas.width = this.trailSize;
      this.ringsCanvas.height = this.trailSize;
      this.horizontalCanvas.width = this.trailSize;
      this.horizontalCanvas.height = this.trailSize;
      this.tempCanvas.width = this.trailSize;
      this.tempCanvas.height = this.trailSize;
    }

    this.ctx.clearRect(0, 0, width, height);
  }

  public override setPlaying(playing: boolean): void {
    super.setPlaying(playing);
    // Restart the staggered ring reveal each time playback (re)starts.
    if (playing) this.revealStartTime = -1;
  }

  public override draw(): void {
    if (this.destroyed) return;
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;
    if (width <= 0 || height <= 0) return;

    if (!this.ringsCanvas || !this.horizontalCanvas || !this.tempCanvas) {
      this.onResize();
    }
    if (!this.ringsCtx || !this.horizontalCtx) return;
    const ringsCtx: CanvasRenderingContext2D = this.ringsCtx;
    const horizontalCtx: CanvasRenderingContext2D = this.horizontalCtx;

    // Advance time-based state.
    this.hue = (this.hue + this.HUE_CYCLE_SPEED) % 360;
    this.updateColors();

    this.analyser.getByteTimeDomainData(this.dataArray);

    // Age both trails with the same rotate/fade/blur spiral. They are kept on
    // independent layers so neither overdraws the other.
    this.spinTrail(this.ringsCanvas!, ringsCtx);
    this.spinTrail(this.horizontalCanvas!, horizontalCtx);

    // Only one ring renders at a time: advance outward every REVEAL_INTERVAL_MS,
    // then loop back to the centre.
    const now: number = performance.now();
    if (this.revealStartTime < 0) this.revealStartTime = now;
    const activeRing: number = Math.floor((now - this.revealStartTime) / this.REVEAL_INTERVAL_MS) % this.RING_COUNT;

    // Fresh data: the active ring onto its trail, the horizontal onto its trail.
    this.drawFrequencyRing(ringsCtx, activeRing);
    this.drawHorizontalWaveforms(horizontalCtx);

    // Compose: background, tower, rings layer, then the horizontal layer on top.
    ctx.fillStyle = this.backgroundColorString;
    ctx.fillRect(0, 0, width, height);
    this.drawConcentricCircles(ctx);

    const trailOffsetX: number = this.centerX - this.trailCx;
    const trailOffsetY: number = this.centerY - this.trailCy;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.ringsCanvas!, trailOffsetX, trailOffsetY);
    ctx.drawImage(this.horizontalCanvas!, trailOffsetX, trailOffsetY);
    ctx.restore();

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

    // Trim the extreme low/high bins, then take this ring's bucket of the rest.
    const trim: number = binCount * this.FREQ_TRIM_FRACTION;
    const bucketSize: number = (binCount - trim * 2) / this.RING_COUNT;
    const bucketStart: number = trim + ring * bucketSize;

    const baseRadius: number = this.radii[ring];
    const ceilRadius: number = this.radii[ring + 1];
    // Line and fill match the colour of the circle this ring is attached to.
    const color: Rgb = this.circleColors[ring];
    const mainColor: string = this.circleColorStrings[ring];
    const glowColor: string = `rgba(${color.r}, ${color.g}, ${color.b}, 0.8)`;

    for (let i: number = 0; i < numSamples; i++) {
      // Map this angular sample to a frequency bin inside the ring's bucket.
      const bin: number = Math.min(binCount - 1, (bucketStart + (i / numSamples) * bucketSize) | 0);
      const magnitude: number = this.freqArray[bin] / 255;
      // Two positions only: ceiling (next circle) when the bin is loud enough,
      // otherwise baseline (this ring's own circle).
      this.ringRadii[i] = magnitude * sensitivityFactor >= this.PEAK_THRESHOLD ? ceilRadius : baseRadius;
    }

    this.buildCastellation(this.ringPoints, this.ringRadii);
    // Fill the inside of each peak (the band from this circle out to the ceiling).
    this.fillPeaks(ctx, this.ringPoints, baseRadius, mainColor);
    // Glowing outline of the peaks only - walls and tops, no baseline.
    this.drawPathWithLayers(
      (): void => { this.buildPeakOutline(ctx, this.ringRadii, baseRadius); },
      mainColor, glowColor, undefined,
      {ctx, baseGlowBlur: this.WAVE_GLOW_BLUR}
    );
  }

  /**
   * Fills the band between baseRadius and the castellated outline - i.e. the
   * inside of each peak. Uses an even-odd fill of the outline minus the ring's
   * baseline circle, so flat (baseline) stretches contribute no fill.
   */
  private fillPeaks(ctx: CanvasRenderingContext2D, points: Point[], baseRadius: number, fillColor: string): void {
    ctx.save();
    ctx.globalAlpha = this.PEAK_FILL_ALPHA;
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i: number = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    // Subtract the inner baseline disc so only the peak teeth are filled.
    ctx.moveTo(this.trailCx + baseRadius, this.trailCy);
    ctx.arc(this.trailCx, this.trailCy, baseRadius, 0, TWO_PI);
    ctx.fill('evenodd');
    ctx.restore();
  }

  /**
   * Builds a castellated (square-wave) ring into the given point buffer (trail
   * space): each sample holds its radius across its angular slice, then jumps
   * radially to the next sample's radius.
   */
  private buildCastellation(points: Point[], radii: number[]): void {
    const numSamples: number = this.CIRCULAR_SAMPLES;
    const cx: number = this.trailCx;
    const cy: number = this.trailCy;
    const angleStep: number = TWO_PI / numSamples;

    let k: number = 0;
    for (let i: number = 0; i < numSamples; i++) {
      const radius: number = radii[i];
      const a0: number = i * angleStep;
      const a1: number = (i + 1) * angleStep;

      points[k].x = cx + radius * Math.cos(a0);
      points[k].y = cy + radius * Math.sin(a0);
      k++;
      points[k].x = cx + radius * Math.cos(a1);
      points[k].y = cy + radius * Math.sin(a1);
      k++;
    }
  }

  /**
   * Strokes only the peaks - each peak's ceiling top plus its radial walls at
   * the rising/falling edges - skipping the baseline stretches between peaks.
   * Wrap-around is handled via modulo so a peak crossing angle 0 is unbroken.
   */
  private buildPeakOutline(ctx: CanvasRenderingContext2D, radii: number[], baseRadius: number): void {
    const numSamples: number = this.CIRCULAR_SAMPLES;
    const cx: number = this.trailCx;
    const cy: number = this.trailCy;
    const angleStep: number = TWO_PI / numSamples;

    ctx.beginPath();
    for (let i: number = 0; i < numSamples; i++) {
      if (radii[i] <= baseRadius) continue;

      const r: number = radii[i];
      const a0: number = i * angleStep;
      const a1: number = (i + 1) * angleStep;
      const x0: number = cx + r * Math.cos(a0);
      const y0: number = cy + r * Math.sin(a0);
      const x1: number = cx + r * Math.cos(a1);
      const y1: number = cy + r * Math.sin(a1);

      // Ceiling top across this sample's slice.
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);

      // Left wall where a peak run begins.
      if (radii[(i - 1 + numSamples) % numSamples] <= baseRadius) {
        ctx.moveTo(cx + baseRadius * Math.cos(a0), cy + baseRadius * Math.sin(a0));
        ctx.lineTo(x0, y0);
      }

      // Right wall where a peak run ends.
      if (radii[(i + 1) % numSamples] <= baseRadius) {
        ctx.moveTo(x1, y1);
        ctx.lineTo(cx + baseRadius * Math.cos(a1), cy + baseRadius * Math.sin(a1));
      }
    }
  }

  // === Trails & colour ======================================================

  /**
   * Ages a trail surface by one frame: copies it out, clears it, then draws it
   * back rotated and faded about the trail centre. The repeated resample is what
   * produces the spiral blur, and the alpha is the fade.
   */
  private spinTrail(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
    const size: number = this.trailSize;
    const tempCanvas: HTMLCanvasElement = this.tempCanvas!;
    const tempCtx: CanvasRenderingContext2D = this.tempCtx!;

    tempCtx.clearRect(0, 0, size, size);
    tempCtx.drawImage(canvas, 0, 0);

    ctx.clearRect(0, 0, size, size);

    const effectiveFade: number = this.TRAIL_FADE * this.getFadeMultiplier();
    const pivotX: number = Math.floor(this.trailCx);
    const pivotY: number = Math.floor(this.trailCy);

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = 1 - effectiveFade;
    ctx.translate(pivotX, pivotY);
    ctx.rotate(this.TRAIL_ROTATION);
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
  }
}

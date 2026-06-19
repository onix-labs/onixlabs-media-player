/**
 * @fileoverview Black Hole visualization with an accretion-disk waveform.
 *
 * Renders a black event-horizon circle at the centre surrounded by a filled,
 * glowing circular waveform that forms an accretion disk. The disk's outer
 * edge is driven by the time-domain audio signal:
 *
 * - Peaks bulge outward, flare into bright glowing blobs, then blur and fade
 *   away as the persistent trail layer drifts them outward over time.
 * - Troughs are pulled inward toward the centre and trail glowing suction
 *   streaks that point at the event horizon, as if matter is being drawn in.
 *
 * The disk swirls slowly (trail rotation) for an orbiting-matter feel, and the
 * hue drifts gently through a hot palette so the disk subtly shifts colour.
 *
 * Performance optimizations (mirrors the Pulsar visualization):
 * - Reuses trail/temp canvases instead of recreating them each frame.
 * - Pre-allocates point/sample arrays to avoid GC pressure.
 * - Caches HSL->RGB conversions and only recomputes on hue change.
 *
 * @module app/components/audio/audio-outlet/visualizations/black-hole-visualization
 */

import {Canvas2DVisualization, OffscreenCanvasPair, VisualizationConfig} from './visualization';
import {DEGREES_FULL_CIRCLE, HALF, MULTIPLIER_DOUBLE, MULTIPLIER_QUADRUPLE, RGB_MID, TWO_PI} from './visualization-constants';

/**
 * Black Hole visualization.
 *
 * A black centre circle ringed by a filled glowing circular waveform whose
 * peaks radiate outward and fade, and whose troughs are sucked toward the core.
 */
export class BlackHoleVisualization extends Canvas2DVisualization {
  /** Radians the persistent trail rotates per frame (disk swirl). */
  private static readonly ROTATION_SPEED: number = 0.002;

  /** Per-frame outward zoom applied to the trail so peak glow drifts away. */
  private static readonly ZOOM_SCALE: number = 1.005;

  /** Base per-frame fade rate of the trail layer (scaled by trail intensity). */
  private static readonly FADE_RATE: number = 0.15;

  /** Degrees the hue advances per frame. */
  private static readonly HUE_CYCLE_SPEED: number = 0.06;

  /** Starting hue (warm orange) for the accretion disk. */
  private static readonly START_HUE: number = 0;

  /** Number of angular samples around the disk edge (curve resolution). */
  private static readonly NUM_SAMPLES: number = 256;

  /**
   * Low-pass passes applied around the ring of samples. A few passes polish the
   * contiguous trace into flowing waves, independent of NUM_SAMPLES.
   */
  private static readonly SMOOTHING_PASSES: number = 3;

  /**
   * Fraction of the waveform buffer wrapped around each half of the ring.
   * Smaller keeps neighbouring points more correlated (smoother).
   */
  private static readonly WAVEFORM_WINDOW_FRACTION: number = 0.2;

  /** Event-horizon (black circle) diameter as a fraction of the canvas height. */
  private static readonly EVENT_HORIZON_HEIGHT_FRACTION: number = 0.75;

  /** Gap from the horizon to the resting disk edge (fraction of half-height). */
  private static readonly DISK_GAP_FRACTION: number = 0.15;

  /** How far peaks/troughs push the edge (fraction of half-height). */
  private static readonly AMPLITUDE_HEIGHT_FRACTION: number = 0.1;

  /** Per-frame blur applied to the persistent trail so the disk blurs slowly. */
  private static readonly TRAIL_BLUR: number = 1;

  /** Glow blur for the photon ring around the event horizon (pixels). */
  private static readonly RIM_GLOW_BLUR: number = 18;

  /** Alpha of the bright inner stop of the disk fill gradient. */
  private static readonly DISK_INNER_ALPHA: number = 0.85;

  /** Alpha of the mid (body) stop of the disk fill gradient. */
  private static readonly DISK_BODY_ALPHA: number = 0.45;

  /** Alpha of the photon ring around the event horizon. */
  private static readonly RIM_ALPHA: number = 0.1;

  /** Saturation (%) used across the hot palette. */
  private static readonly SAT_FULL: number = 95;

  /** Lightness (%) of the bright inner disk. */
  private static readonly LIGHT_HOT: number = 72;

  /** Lightness (%) of the disk body. */
  private static readonly LIGHT_BODY: number = 50;

  /** Lightness (%) of the photon ring. */
  private static readonly LIGHT_RIM: number = 82;

  /** Line width of the photon ring. */
  private static readonly RIM_LINE_WIDTH: number = 2;

  public readonly name: string = 'Black Hole';
  public readonly category: string = 'Signature';

  /** Time-domain audio buffer driving the disk edge. */
  private dataArray: Uint8Array<ArrayBuffer>;

  /** Trail canvas holding persistent peak glow (reused, not recreated). */
  private trailCanvas: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;

  /** Temp canvas for the zoom/rotate effect (reused, not recreated). */
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  /** Hue cycling with caching. */
  private hueOffset: number = BlackHoleVisualization.START_HUE;
  private cachedHue: number = -1;
  private cachedInner: {r: number; g: number; b: number} = {r: 0, g: 0, b: 0};
  private cachedBody: {r: number; g: number; b: number} = {r: 0, g: 0, b: 0};
  private cachedRim: {r: number; g: number; b: number} = {r: 0, g: 0, b: 0};

  /** Pre-allocated edge points and their normalized samples. */
  private readonly edgePoints: Array<{x: number; y: number}>;
  private readonly edgeSamples: Float32Array;
  /** Scratch buffer for the circular low-pass smoothing passes. */
  private readonly edgeSmoothBuffer: Float32Array;

  /** Pre-computed layout values (updated on resize). */
  private centerX: number = 0;
  private centerY: number = 0;
  private maxRadius: number = 0;
  private eventHorizonRadius: number = 0;
  private diskBaseRadius: number = 0;
  private amplitudeScale: number = 0;
  private minEdgeRadius: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;

    const samples: number = BlackHoleVisualization.NUM_SAMPLES;
    // One extra point closes the loop for buildSmoothPath (last == first).
    this.edgePoints = new Array(samples + 1);
    this.edgeSamples = new Float32Array(samples);
    this.edgeSmoothBuffer = new Float32Array(samples);
    for (let i: number = 0; i <= samples; i++) {
      this.edgePoints[i] = {x: 0, y: 0};
    }

    // Maximum curve smoothing so the sampled edge reads as a flowing disk.
    this.waveformSmoothing = 1;
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;

    // Advance and cache the hot palette.
    this.hueOffset = (this.hueOffset + BlackHoleVisualization.HUE_CYCLE_SPEED) % DEGREES_FULL_CIRCLE;
    this.updateColors();

    // Ensure offscreen canvases exist.
    if (!this.trailCanvas || !this.trailCtx || !this.tempCanvas || !this.tempCtx) {
      this.onResize();
    }
    const trailCtx: CanvasRenderingContext2D = this.trailCtx!;
    const trailCanvas: HTMLCanvasElement = this.trailCanvas!;
    const tempCtx: CanvasRenderingContext2D = this.tempCtx!;
    const tempCanvas: HTMLCanvasElement = this.tempCanvas!;

    // Sample the waveform and compute the wavy disk edge.
    this.analyser.getByteTimeDomainData(this.dataArray);
    this.computeEdge();

    // Redraw the persistent disk: rotate it (swirl), drift it, fade it, and
    // apply a small blur each frame so the disk progressively blurs over time.
    const effectiveFadeRate: number = BlackHoleVisualization.FADE_RATE * this.getFadeMultiplier();
    tempCtx.clearRect(0, 0, width, height);
    tempCtx.drawImage(trailCanvas, 0, 0);
    trailCtx.clearRect(0, 0, width, height);
    trailCtx.save();
    trailCtx.imageSmoothingEnabled = true;
    trailCtx.imageSmoothingQuality = 'high';
    trailCtx.filter = `blur(${BlackHoleVisualization.TRAIL_BLUR}px)`;
    trailCtx.globalAlpha = 1 - effectiveFadeRate;
    const floorX: number = Math.floor(this.centerX);
    const floorY: number = Math.floor(this.centerY);
    trailCtx.translate(floorX, floorY);
    trailCtx.rotate(BlackHoleVisualization.ROTATION_SPEED);
    trailCtx.scale(BlackHoleVisualization.ZOOM_SCALE, BlackHoleVisualization.ZOOM_SCALE);
    trailCtx.translate(-floorX, -floorY);
    trailCtx.drawImage(tempCanvas, 0, 0);
    trailCtx.restore();

    // Draw the fresh, crisp filled disk onto the persistent trail so it blurs,
    // drifts and fades slowly behind each new frame.
    this.drawDisk(trailCtx);

    // Composite the blurred, persistent disk, then the crisp black core on top.
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(trailCanvas, 0, 0);
    this.drawEventHorizon(ctx);

    this.applyFadeOverlay();
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    const halfHeight: number = this.height * HALF;
    this.centerX = this.width * HALF;
    this.centerY = halfHeight;
    // Event-horizon diameter is a fraction of the full height, so its radius is
    // that fraction of the half-height (e.g. 0.8 => an 80%-of-height circle).
    this.eventHorizonRadius = halfHeight * BlackHoleVisualization.EVENT_HORIZON_HEIGHT_FRACTION;
    this.amplitudeScale = halfHeight * BlackHoleVisualization.AMPLITUDE_HEIGHT_FRACTION;
    this.diskBaseRadius = this.eventHorizonRadius + halfHeight * BlackHoleVisualization.DISK_GAP_FRACTION;
    this.maxRadius = this.diskBaseRadius + this.amplitudeScale;
    // Troughs are pulled right down to the horizon, where they vanish behind it.
    this.minEdgeRadius = this.eventHorizonRadius;

    if (!this.trailCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.trailCanvas = offscreen.canvas;
      this.trailCtx = offscreen.ctx;
    }
    if (!this.tempCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.tempCanvas = offscreen.canvas;
      this.tempCtx = offscreen.ctx;
    }

    this.resizeCanvasPreserving(this.trailCanvas, this.trailCtx!, this.width, this.height);
    this.tempCanvas.width = this.width;
    this.tempCanvas.height = this.height;

    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  /** Recomputes the cached palette when the hue changes by at least 1 degree. */
  private updateColors(): void {
    const hueInt: number = Math.floor(this.hueOffset);
    if (hueInt === this.cachedHue) return;
    this.cachedHue = hueInt;

    const sat: number = BlackHoleVisualization.SAT_FULL;
    this.cachedInner = this.hslToRgb(this.hueOffset, sat, BlackHoleVisualization.LIGHT_HOT);
    this.cachedBody = this.hslToRgb(this.hueOffset, sat, BlackHoleVisualization.LIGHT_BODY);
    this.cachedRim = this.hslToRgb(this.hueOffset, sat, BlackHoleVisualization.LIGHT_RIM);
  }

  /** Computes each angular edge point and its normalized sample. */
  private computeEdge(): void {
    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;
    const dataLength: number = dataArray.length;
    const samples: number = BlackHoleVisualization.NUM_SAMPLES;
    const half: number = samples >> 1;
    const sensitivityFactor: number = this.sensitivityFactor;
    // Walk a *contiguous* window of the waveform so neighbouring points stay
    // correlated (a continuous oscilloscope trace) rather than decorrelated
    // noise spread across the whole buffer.
    const step: number = Math.max(1, (dataLength * BlackHoleVisualization.WAVEFORM_WINDOW_FRACTION / half) | 0);

    // Mirror the trace across the ring (0..half..0) so the circumference is
    // seamless and periodic, with no discontinuity at the wrap point.
    // Signed displacement: peaks (>0) push outward, troughs (<0) pull inward.
    for (let i: number = 0; i < samples; i++) {
      const pos: number = i < half ? i : samples - i;
      const dataIndex: number = pos * step;
      this.edgeSamples[i] = ((dataArray[dataIndex] - RGB_MID) / RGB_MID) * sensitivityFactor;
    }
    this.smoothSamples();

    // Build the closed edge from the smoothed displacements. Iterate one past
    // the end so the final point closes back onto the first.
    for (let i: number = 0; i <= samples; i++) {
      const smoothed: number = this.edgeSamples[i % samples];
      const angle: number = (i / samples) * TWO_PI;
      let radius: number = this.diskBaseRadius + smoothed * this.amplitudeScale;
      if (radius < this.minEdgeRadius) radius = this.minEdgeRadius;
      if (radius > this.maxRadius) radius = this.maxRadius;

      this.edgePoints[i].x = this.centerX + radius * Math.cos(angle);
      this.edgePoints[i].y = this.centerY + radius * Math.sin(angle);
    }
  }

  /**
   * Applies repeated circular 3-tap low-pass passes to {@link edgeSamples},
   * merging the raw per-sample spikes into a few smooth, flowing waves.
   */
  private smoothSamples(): void {
    const samples: number = BlackHoleVisualization.NUM_SAMPLES;
    const src: Float32Array = this.edgeSamples;
    const tmp: Float32Array = this.edgeSmoothBuffer;
    for (let pass: number = 0; pass < BlackHoleVisualization.SMOOTHING_PASSES; pass++) {
      for (let i: number = 0; i < samples; i++) {
        const prev: number = src[(i - 1 + samples) % samples];
        const next: number = src[(i + 1) % samples];
        tmp[i] = (prev + src[i] * MULTIPLIER_DOUBLE + next) / MULTIPLIER_QUADRUPLE;
      }
      src.set(tmp);
    }
  }

  /** Builds the closed smooth disk-edge path on the given context. */
  private buildEdgePath(ctx: CanvasRenderingContext2D): void {
    this.buildSmoothPath(ctx, this.edgePoints, BlackHoleVisualization.NUM_SAMPLES);
    ctx.closePath();
  }

  /** Draws the filled, glowing accretion disk (no outline). */
  private drawDisk(ctx: CanvasRenderingContext2D): void {
    const inner: {r: number; g: number; b: number} = this.cachedInner;
    const body: {r: number; g: number; b: number} = this.cachedBody;

    // Radial gradient: brightest right at the event horizon, decreasing
    // smoothly to a dim, transparent outer circumference.
    const gradient: CanvasGradient = ctx.createRadialGradient(
      this.centerX, this.centerY, this.eventHorizonRadius,
      this.centerX, this.centerY, this.maxRadius
    );
    const span: number = this.maxRadius - this.eventHorizonRadius;
    const midOffset: number = span > 0 ? (this.diskBaseRadius - this.eventHorizonRadius) / span : HALF;
    gradient.addColorStop(0, `rgba(${inner.r}, ${inner.g}, ${inner.b}, ${BlackHoleVisualization.DISK_INNER_ALPHA})`);
    gradient.addColorStop(midOffset, `rgba(${body.r}, ${body.g}, ${body.b}, ${BlackHoleVisualization.DISK_BODY_ALPHA})`);
    gradient.addColorStop(1, `rgba(${body.r}, ${body.g}, ${body.b}, 0)`);

    // Filled glowing body. Uses normal (source-over) compositing rather than
    // additive blending: layering the disk over its own persistent, faded copy
    // additively would sum every channel up to 255 and wash the disk white,
    // hiding the cycling hue. Source-over blends instead, preserving colour.
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = gradient;
    this.buildEdgePath(ctx);
    ctx.fill();
    ctx.restore();
  }

  /** Draws the solid black event horizon and its glowing photon ring. */
  private drawEventHorizon(ctx: CanvasRenderingContext2D): void {
    // Solid black core masks any glow that bled toward the centre.
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgb(0, 0, 0)`;
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, this.eventHorizonRadius, 0, TWO_PI);
    ctx.fill();
    ctx.restore();

    // Bright photon ring around the horizon.
    const rim: {r: number; g: number; b: number} = this.cachedRim;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowBlur = this.getScaledGlowBlur(BlackHoleVisualization.RIM_GLOW_BLUR);
    ctx.shadowColor = `rgba(${rim.r}, ${rim.g}, ${rim.b}, ${BlackHoleVisualization.RIM_ALPHA})`;
    ctx.strokeStyle = `rgba(${rim.r}, ${rim.g}, ${rim.b}, ${BlackHoleVisualization.RIM_ALPHA})`;
    ctx.lineWidth = this.lineWidth + BlackHoleVisualization.RIM_LINE_WIDTH;
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, this.eventHorizonRadius, 0, TWO_PI);
    ctx.stroke();
    ctx.restore();
  }

  public override destroy(): void {
    this.trailCanvas = null;
    this.trailCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}

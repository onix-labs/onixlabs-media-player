/**
 * @fileoverview Black Hole visualization — accretion disk plus infalling matter.
 *
 * A bright, hue-cycling circular waveform sits on the event horizon and drives
 * two complementary effects from the same signal:
 *
 * - Peaks bulge *outward* into a filled, glowing accretion disk that drifts
 *   outward, blurs and fades slowly (an orbiting disk of matter).
 * - Troughs dip *inward* past the horizon and are slowly sucked toward the
 *   singularity, blurring and fading as they spiral in.
 *
 * Each effect has its own persistent trail: the disk's trail zooms outward, the
 * infall's trail zooms inward (Pulsar run in reverse). A solid black core sits
 * between them as the event horizon.
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
 * An accretion disk formed by the waveform's outward peaks, ringing a black
 * core, with the waveform's troughs falling inward and dissolving at the centre.
 */
export class BlackHoleVisualization extends Canvas2DVisualization {
  // ----- Shared waveform / layout -----

  /** Degrees the hue advances per frame. */
  private static readonly HUE_CYCLE_SPEED: number = 0.1;

  /** Starting hue for the waveform. */
  private static readonly START_HUE: number = 0;

  /** Saturation (%) of the cycling hue. */
  private static readonly SAT_FULL: number = 100;

  /** Number of angular samples around the ring (curve resolution). */
  private static readonly NUM_SAMPLES: number = 256;

  /** Low-pass passes around the ring; polishes the trace into flowing waves. */
  private static readonly SMOOTHING_PASSES: number = 3;

  /** Fraction of the waveform buffer wrapped around each half of the ring. */
  private static readonly WAVEFORM_WINDOW_FRACTION: number = 0.2;

  /** Event-horizon (black core) diameter as a fraction of the canvas height. */
  private static readonly EVENT_HORIZON_HEIGHT_FRACTION: number = 0.6;

  /** Per-frame blur applied to both trails so matter blurs slowly. */
  private static readonly TRAIL_BLUR: number = 1;

  // ----- Accretion disk (outward peaks) -----

  /** Gap from the horizon to the resting disk edge (fraction of half-height). */
  private static readonly DISK_GAP_FRACTION: number = 0.15;

  /** How far disk peaks/troughs push the edge (fraction of half-height). */
  private static readonly DISK_AMPLITUDE_FRACTION: number = 0.1;

  /** Radians the disk trail rotates per frame. */
  private static readonly DISK_ROTATION_SPEED: number = 0.002;

  /** Per-frame outward zoom of the disk trail (above 1 drifts outward). */
  private static readonly DISK_ZOOM_SCALE: number = 1.004;

  /** Base per-frame fade rate of the disk trail. */
  private static readonly DISK_FADE_RATE: number = 0.06;

  /** Alpha of the bright inner stop of the disk fill gradient. */
  private static readonly DISK_INNER_ALPHA: number = 0.85;

  /** Alpha of the mid (body) stop of the disk fill gradient. */
  private static readonly DISK_BODY_ALPHA: number = 0.45;

  /** Lightness (%) of the bright inner disk. */
  private static readonly LIGHT_HOT: number = 72;

  /** Lightness (%) of the disk body. */
  private static readonly LIGHT_BODY: number = 50;

  // ----- Infall (inward troughs) -----

  /** Deepest a trough dips inward, as a fraction of the horizon radius. */
  private static readonly WAVE_DEPTH_FRACTION: number = 0.2;

  /** Multiplier turning a trough's depth into an inward dip (0..1). */
  private static readonly WAVE_GAIN: number = 2;

  /** Radians the infall trail rotates per frame. */
  private static readonly INFALL_ROTATION_SPEED: number = 0.01;

  /** Per-frame zoom of the infall trail (below 1 sucks toward the centre). */
  private static readonly INFALL_ZOOM_SCALE: number = 0.99;

  /** Base per-frame fade rate of the infall trail. */
  private static readonly INFALL_FADE_RATE: number = 0.05;

  /** Lightness (%) of the bright infall waveform. */
  private static readonly LIGHT_WAVE: number = 32;

  /** Base glow blur radius for the infall waveform (pixels). */
  private static readonly BASE_GLOW_BLUR: number = 16;

  /** Extra line width added to the soft glow layer. */
  private static readonly GLOW_LINE_WIDTH: number = 3;

  /** Stroke alpha of the soft glow layer. */
  private static readonly GLOW_STROKE_ALPHA: number = 0.5;

  /** Shadow alpha used for the infall glow. */
  private static readonly GLOW_SHADOW_ALPHA: number = 0.85;

  public readonly name: string = 'Black Hole';
  public readonly category: string = 'Signature';

  /** Time-domain audio buffer driving the waveform. */
  private dataArray: Uint8Array<ArrayBuffer>;

  /** Persistent trail for the outward accretion disk. */
  private diskCanvas: HTMLCanvasElement | null = null;
  private diskCtx: CanvasRenderingContext2D | null = null;

  /** Persistent trail for the inward infall. */
  private infallCanvas: HTMLCanvasElement | null = null;
  private infallCtx: CanvasRenderingContext2D | null = null;

  /** Shared temp canvas for the zoom/rotate effect (reused, not recreated). */
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  /** Hue cycling with caching. */
  private hueOffset: number = BlackHoleVisualization.START_HUE;
  private cachedHue: number = -1;
  private cachedInner: {r: number; g: number; b: number} = {r: 0, g: 0, b: 0};
  private cachedBody: {r: number; g: number; b: number} = {r: 0, g: 0, b: 0};
  private cachedWave: {r: number; g: number; b: number} = {r: 0, g: 0, b: 0};

  /** Pre-allocated points and their normalized samples. */
  private readonly edgePoints: Array<{x: number; y: number}>;
  private readonly innerPoints: Array<{x: number; y: number}>;
  private readonly edgeSamples: Float32Array;
  /** Scratch buffer for the circular low-pass smoothing passes. */
  private readonly edgeSmoothBuffer: Float32Array;

  /** Pre-computed layout values (updated on resize). */
  private centerX: number = 0;
  private centerY: number = 0;
  private eventHorizonRadius: number = 0;
  private diskBaseRadius: number = 0;
  private diskAmplitude: number = 0;
  private diskMaxRadius: number = 0;
  private waveDepth: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;

    const samples: number = BlackHoleVisualization.NUM_SAMPLES;
    // One extra point closes the loop for buildSmoothPath (last == first).
    this.edgePoints = new Array(samples + 1);
    this.innerPoints = new Array(samples + 1);
    this.edgeSamples = new Float32Array(samples);
    this.edgeSmoothBuffer = new Float32Array(samples);
    for (let i: number = 0; i <= samples; i++) {
      this.edgePoints[i] = {x: 0, y: 0};
      this.innerPoints[i] = {x: 0, y: 0};
    }

    // Maximum curve smoothing so the sampled ring reads as a flowing waveform.
    this.waveformSmoothing = 1;
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;

    // Advance and cache the bright cycling hue.
    this.hueOffset = (this.hueOffset + BlackHoleVisualization.HUE_CYCLE_SPEED) % DEGREES_FULL_CIRCLE;
    this.updateColors();

    // Ensure offscreen canvases exist.
    if (!this.diskCanvas || !this.infallCanvas || !this.tempCanvas) {
      this.onResize();
    }

    // Sample the waveform and compute the disk edge (outward) and infall (inward).
    this.analyser.getByteTimeDomainData(this.dataArray);
    this.computeEdge();

    // Advance each trail, then deposit the fresh frame on top of it.
    this.advanceTrail(
      this.diskCanvas!, this.diskCtx!,
      BlackHoleVisualization.DISK_ROTATION_SPEED, BlackHoleVisualization.DISK_ZOOM_SCALE, BlackHoleVisualization.DISK_FADE_RATE
    );
    this.drawDisk(this.diskCtx!);

    this.advanceTrail(
      this.infallCanvas!, this.infallCtx!,
      BlackHoleVisualization.INFALL_ROTATION_SPEED, BlackHoleVisualization.INFALL_ZOOM_SCALE, BlackHoleVisualization.INFALL_FADE_RATE
    );
    this.drawInfallWave(this.infallCtx!);

    // Composite: accretion disk, then the black core, then the infall on top of
    // the core so the matter falling inside the horizon is visible.
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.diskCanvas!, 0, 0);
    this.drawEventHorizon(ctx);
    ctx.drawImage(this.infallCanvas!, 0, 0);

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
    // that fraction of the half-height (0.75 => a 75%-of-height circle).
    this.eventHorizonRadius = halfHeight * BlackHoleVisualization.EVENT_HORIZON_HEIGHT_FRACTION;
    this.diskAmplitude = halfHeight * BlackHoleVisualization.DISK_AMPLITUDE_FRACTION;
    this.diskBaseRadius = this.eventHorizonRadius + halfHeight * BlackHoleVisualization.DISK_GAP_FRACTION;
    this.diskMaxRadius = this.diskBaseRadius + this.diskAmplitude;
    this.waveDepth = this.eventHorizonRadius * BlackHoleVisualization.WAVE_DEPTH_FRACTION;

    this.diskCanvas = this.ensureCanvas(this.diskCanvas);
    this.diskCtx = this.diskCanvas.getContext('2d', {alpha: true});
    this.infallCanvas = this.ensureCanvas(this.infallCanvas);
    this.infallCtx = this.infallCanvas.getContext('2d', {alpha: true});

    if (!this.tempCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.tempCanvas = offscreen.canvas;
      this.tempCtx = offscreen.ctx;
    }
    this.tempCanvas.width = this.width;
    this.tempCanvas.height = this.height;

    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  /** Creates or content-preserving-resizes one trail canvas to the current size. */
  private ensureCanvas(canvas: HTMLCanvasElement | null): HTMLCanvasElement {
    if (!canvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      return offscreen.canvas;
    }
    this.resizeCanvasPreserving(canvas, canvas.getContext('2d', {alpha: true})!, this.width, this.height);
    return canvas;
  }

  /** Recomputes the cached palette when the hue changes by at least 1 degree. */
  private updateColors(): void {
    const hueInt: number = Math.floor(this.hueOffset);
    if (hueInt === this.cachedHue) return;
    this.cachedHue = hueInt;
    const sat: number = BlackHoleVisualization.SAT_FULL;
    this.cachedInner = this.hslToRgb(this.hueOffset, sat, BlackHoleVisualization.LIGHT_HOT);
    this.cachedBody = this.hslToRgb(this.hueOffset, sat, BlackHoleVisualization.LIGHT_BODY);
    this.cachedWave = this.hslToRgb(this.hueOffset, sat, BlackHoleVisualization.LIGHT_WAVE);
  }

  /**
   * Advances a persistent trail: copies it to the temp canvas, then redraws it
   * rotated, zoomed, blurred and faded. Zoom above 1 drifts outward; below 1
   * sucks inward toward the centre.
   */
  private advanceTrail(
    trailCanvas: HTMLCanvasElement,
    trailCtx: CanvasRenderingContext2D,
    rotation: number,
    zoom: number,
    fadeRate: number
  ): void {
    const width: number = this.width;
    const height: number = this.height;
    const tempCanvas: HTMLCanvasElement = this.tempCanvas!;
    const tempCtx: CanvasRenderingContext2D = this.tempCtx!;

    tempCtx.clearRect(0, 0, width, height);
    tempCtx.drawImage(trailCanvas, 0, 0);
    trailCtx.clearRect(0, 0, width, height);

    trailCtx.save();
    trailCtx.imageSmoothingEnabled = true;
    trailCtx.imageSmoothingQuality = 'high';
    trailCtx.filter = `blur(${BlackHoleVisualization.TRAIL_BLUR}px)`;
    trailCtx.globalAlpha = 1 - fadeRate * this.getFadeMultiplier();
    const floorX: number = Math.floor(this.centerX);
    const floorY: number = Math.floor(this.centerY);
    trailCtx.translate(floorX, floorY);
    trailCtx.rotate(rotation);
    trailCtx.scale(zoom, zoom);
    trailCtx.translate(-floorX, -floorY);
    trailCtx.drawImage(tempCanvas, 0, 0);
    trailCtx.restore();
  }

  /**
   * Computes the disk edge and the infall ring from the same smoothed waveform.
   * Peaks (positive displacement) push the disk edge outward; troughs (negative)
   * pull the disk edge toward the horizon and dip the infall ring inward.
   */
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

    // Mirror the trace across the ring (0..half..0) so it is seamless/periodic.
    for (let i: number = 0; i < samples; i++) {
      const pos: number = i < half ? i : samples - i;
      this.edgeSamples[i] = ((dataArray[pos * step] - RGB_MID) / RGB_MID) * sensitivityFactor;
    }
    this.smoothSamples();

    // Iterate one past the end so the final point closes back onto the first.
    for (let i: number = 0; i <= samples; i++) {
      const smoothed: number = this.edgeSamples[i % samples];
      const angle: number = (i / samples) * TWO_PI;
      const cos: number = Math.cos(angle);
      const sin: number = Math.sin(angle);

      // Accretion disk edge: outward on peaks, clamped to the horizon on troughs.
      let radius: number = this.diskBaseRadius + smoothed * this.diskAmplitude;
      if (radius < this.eventHorizonRadius) radius = this.eventHorizonRadius;
      if (radius > this.diskMaxRadius) radius = this.diskMaxRadius;
      this.edgePoints[i].x = this.centerX + radius * cos;
      this.edgePoints[i].y = this.centerY + radius * sin;

      // Infall ring: flat at the horizon on peaks, dipping inward on troughs.
      const dip: number = smoothed < 0 ? Math.min(1, -smoothed * BlackHoleVisualization.WAVE_GAIN) : 0;
      const innerRadius: number = this.eventHorizonRadius - dip * this.waveDepth;
      this.innerPoints[i].x = this.centerX + innerRadius * cos;
      this.innerPoints[i].y = this.centerY + innerRadius * sin;
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

  /** Draws the filled, glowing accretion disk (bright at horizon, dim outward). */
  private drawDisk(ctx: CanvasRenderingContext2D): void {
    const inner: {r: number; g: number; b: number} = this.cachedInner;
    const body: {r: number; g: number; b: number} = this.cachedBody;

    const gradient: CanvasGradient = ctx.createRadialGradient(
      this.centerX, this.centerY, this.eventHorizonRadius,
      this.centerX, this.centerY, this.diskMaxRadius
    );
    const span: number = this.diskMaxRadius - this.eventHorizonRadius;
    const midOffset: number = span > 0 ? (this.diskBaseRadius - this.eventHorizonRadius) / span : HALF;
    gradient.addColorStop(0, `rgba(${inner.r}, ${inner.g}, ${inner.b}, ${BlackHoleVisualization.DISK_INNER_ALPHA})`);
    gradient.addColorStop(midOffset, `rgba(${body.r}, ${body.g}, ${body.b}, ${BlackHoleVisualization.DISK_BODY_ALPHA})`);
    gradient.addColorStop(1, `rgba(${body.r}, ${body.g}, ${body.b}, 0)`);

    // Source-over (not additive) so the cycling hue is preserved across frames.
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = gradient;
    this.buildSmoothPath(ctx, this.edgePoints, BlackHoleVisualization.NUM_SAMPLES);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** Draws the bright, glowing infall waveform stroke (troughs facing inward). */
  private drawInfallWave(ctx: CanvasRenderingContext2D): void {
    const color: {r: number; g: number; b: number} = this.cachedWave;
    const glowBlur: number = this.getScaledGlowBlur(BlackHoleVisualization.BASE_GLOW_BLUR);
    const buildPath: () => void = (): void => {
      this.buildSmoothPath(ctx, this.innerPoints, BlackHoleVisualization.NUM_SAMPLES);
      ctx.closePath();
    };

    // Soft glow layer.
    ctx.save();
    ctx.shadowBlur = glowBlur;
    ctx.shadowColor = `rgba(${color.r}, ${color.g}, ${color.b}, ${BlackHoleVisualization.GLOW_SHADOW_ALPHA})`;
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${BlackHoleVisualization.GLOW_STROKE_ALPHA})`;
    ctx.lineWidth = this.lineWidth + BlackHoleVisualization.GLOW_LINE_WIDTH;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    buildPath();
    ctx.stroke();
    ctx.restore();

    // Bright main line.
    ctx.save();
    ctx.shadowBlur = glowBlur;
    ctx.shadowColor = `rgba(${color.r}, ${color.g}, ${color.b}, ${BlackHoleVisualization.GLOW_SHADOW_ALPHA})`;
    ctx.strokeStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
    ctx.lineWidth = this.lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    buildPath();
    ctx.stroke();
    ctx.restore();
  }

  /** Draws the solid black event-horizon core between the disk and the infall. */
  private drawEventHorizon(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgb(0, 0, 0)`;
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, this.eventHorizonRadius, 0, TWO_PI);
    ctx.fill();
    ctx.restore();
  }

  public override destroy(): void {
    this.diskCanvas = null;
    this.diskCtx = null;
    this.infallCanvas = null;
    this.infallCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}

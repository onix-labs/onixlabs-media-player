/**
 * @fileoverview Black Hole visualization — lensed disk, infall, and front disk.
 *
 * A bright, hue-cycling circular waveform drives the accretion disk and its
 * infalling matter, layered back-to-front to fake the gravitational lensing of
 * a real black hole. Behind it all, a lensed starfield pans right-to-left as if
 * orbiting the hole. Layers:
 *
 * 0. Starfield: background stars panning sideways, each gravitationally lensed
 *    so the field warps around the shadow.
 * 1. Back light: a circular halo — the disk's far side lensed all the way around
 *    the hole — ringing the black core.
 * 2. Infall: the waveform's troughs dipping past the horizon and spiralling into
 *    the singularity, blurring and fading as they go.
 * 3. Front light: the disk seen directly, tilted into a wider ellipse that
 *    passes in front of everything. It blends with the halo into one structure.
 *
 * Each layer has its own persistent trail (the disk trails drift outward and
 * blur; the infall trail zooms inward — Pulsar run in reverse). A solid black
 * core sits between the halo and the infall as the event horizon.
 *
 * Performance: reuses trail/temp canvases, pre-allocates point arrays, and
 * caches HSL->RGB conversions (recomputed only on hue change).
 *
 * @module app/components/audio/audio-outlet/visualizations/black-hole-visualization
 */

import {Canvas2DVisualization, OffscreenCanvasPair, VisualizationConfig} from './visualization';
import {DEGREES_FULL_CIRCLE, HALF, MULTIPLIER_DOUBLE, MULTIPLIER_QUADRUPLE, RGB_MID, TWO_PI} from './visualization-constants';

/**
 * Black Hole visualization.
 *
 * A lensed circular halo and a wider tilted front disk, ringing a black core,
 * with the waveform's troughs falling inward and dissolving at the centre.
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
  private static readonly NUM_SAMPLES: number = 384;

  /** Low-pass passes around the ring; polishes the trace into flowing waves. */
  private static readonly SMOOTHING_PASSES: number = 9;

  /** Fraction of the waveform buffer wrapped around each half of the ring. */
  private static readonly WAVEFORM_WINDOW_FRACTION: number = 0.2;

  /** Event-horizon (black core) diameter as a fraction of the canvas height. */
  private static readonly EVENT_HORIZON_HEIGHT_FRACTION: number = 0.4;

  /** Per-frame blur applied to the trails so matter blurs slowly. */
  private static readonly TRAIL_BLUR: number = 0.5;

  // ----- Accretion disk (outward peaks) -----

  /** Gap from the horizon to the resting disk edge (fraction of half-height). */
  private static readonly DISK_GAP_FRACTION: number = 0.125;

  /** How far disk peaks/troughs push the edge (fraction of half-height). */
  private static readonly DISK_AMPLITUDE_FRACTION: number = 0.1;

  /**
   * Vertical squash of the front disk plane (1 = face-on circle, smaller = more
   * edge-on). Tilting it into an ellipse lets its near edge pass in front of the
   * black core for a 3D, Interstellar-style look.
   */
  private static readonly DISK_TILT: number = 0.3;

  /** How much wider (radially) the front disk is than the back halo. */
  private static readonly FRONT_DISK_WIDTH: number = 3;

  /** Radians the halo trail rotates per frame (slow spin; it is circular). */
  private static readonly HALO_ROTATION_SPEED: number = 0.002;

  /**
   * Radians the front-disk trail rotates per frame. Zero: a tilted disk must not
   * spin in 2D (it would look like a rotating ellipse / propeller).
   */
  private static readonly FRONT_ROTATION_SPEED: number = 0;

  /** Per-frame outward zoom of the disk trails (above 1 drifts outward). */
  private static readonly DISK_ZOOM_SCALE: number = 1.004;

  /** Base per-frame fade rate of the disk trails. */
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

  /** Radians the infall trail rotates per frame (the in-spiralling swirl). */
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

  // ----- Starfield (gravitationally-lensed background) -----

  /** Number of background stars. */
  private static readonly NUM_STARS: number = 400;

  /** Half field-of-view (radians) the starfield is projected through. */
  private static readonly STAR_HALF_FOV: number = 1.1;

  /** Radians the field's azimuth pans per frame (the orbital camera move). */
  private static readonly STAR_ANGULAR_SPEED: number = 0.004;

  /** Vertical spread of the field as a fraction of the half-height. */
  private static readonly STAR_VERTICAL_SPREAD: number = 0.7;

  /** Fraction of the FOV over which stars fade in/out at the edges. */
  private static readonly STAR_EDGE_FADE: number = 0.15;

  /** Einstein (lensing) radius as a multiple of the horizon radius. */
  private static readonly EINSTEIN_RADIUS_FACTOR: number = 1.4;

  /** Base star dot radius in pixels. */
  private static readonly STAR_BASE_RADIUS: number = 0.9;

  /** Maximum lensing magnification applied to a star (clamps the ring blow-up). */
  private static readonly STAR_MAX_MAGNIFICATION: number = 6;

  /** How strongly magnification brightens/enlarges a star near the ring. */
  private static readonly STAR_MAG_BOOST: number = 0.3;

  /** Minimum per-star brightness. */
  private static readonly STAR_MIN_BRIGHTNESS: number = 0.3;

  /** Maximum per-star brightness. */
  private static readonly STAR_MAX_BRIGHTNESS: number = 1;

  /** Alpha multiplier for the dimmer secondary lensed image. */
  private static readonly SECONDARY_STAR_ALPHA: number = 0.45;

  public readonly name: string = 'Black Hole';
  public readonly category: string = 'Waves';

  /** Time-domain audio buffer driving the waveform. */
  private dataArray: Uint8Array<ArrayBuffer>;

  /** Persistent trail for the back halo (lensed far side of the disk). */
  private haloCanvas: HTMLCanvasElement | null = null;
  private haloCtx: CanvasRenderingContext2D | null = null;

  /** Persistent trail for the front disk (directly-seen near side). */
  private frontCanvas: HTMLCanvasElement | null = null;
  private frontCtx: CanvasRenderingContext2D | null = null;

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
  private readonly frontPoints: Array<{x: number; y: number}>;
  private readonly innerPoints: Array<{x: number; y: number}>;
  private readonly edgeSamples: Float32Array;
  /** Scratch buffer for the circular low-pass smoothing passes. */
  private readonly edgeSmoothBuffer: Float32Array;

  /** Background stars in viewer space: azimuth angle, elevation (-1..1), brightness. */
  private readonly starAngle: Float32Array;
  private readonly starElev: Float32Array;
  private readonly starBright: Float32Array;
  private starsSeeded: boolean = false;

  /** Pre-computed layout values (updated on resize). */
  private centerX: number = 0;
  private centerY: number = 0;
  private eventHorizonRadius: number = 0;
  private einsteinRadius: number = 0;
  private diskBaseRadius: number = 0;
  private diskAmplitude: number = 0;
  private diskMaxRadius: number = 0;
  private frontBaseRadius: number = 0;
  private frontAmplitude: number = 0;
  private frontMaxRadius: number = 0;
  private waveDepth: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;

    const samples: number = BlackHoleVisualization.NUM_SAMPLES;
    // One extra point closes the loop for buildSmoothPath (last == first).
    this.edgePoints = new Array(samples + 1);
    this.frontPoints = new Array(samples + 1);
    this.innerPoints = new Array(samples + 1);
    this.edgeSamples = new Float32Array(samples);
    this.edgeSmoothBuffer = new Float32Array(samples);
    for (let i: number = 0; i <= samples; i++) {
      this.edgePoints[i] = {x: 0, y: 0};
      this.frontPoints[i] = {x: 0, y: 0};
      this.innerPoints[i] = {x: 0, y: 0};
    }

    const stars: number = BlackHoleVisualization.NUM_STARS;
    this.starAngle = new Float32Array(stars);
    this.starElev = new Float32Array(stars);
    this.starBright = new Float32Array(stars);

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
    if (!this.haloCanvas || !this.frontCanvas || !this.infallCanvas || !this.tempCanvas) {
      this.onResize();
    }

    // Sample the waveform and compute the disk edges (outward) and infall (inward).
    this.analyser.getByteTimeDomainData(this.dataArray);
    this.computeEdge();

    // Advance each trail, then deposit the fresh frame on top of it.
    this.advanceTrail(
      this.haloCanvas!, this.haloCtx!,
      BlackHoleVisualization.HALO_ROTATION_SPEED, BlackHoleVisualization.DISK_ZOOM_SCALE, BlackHoleVisualization.DISK_FADE_RATE
    );
    this.drawDiskBand(this.haloCtx!, this.edgePoints, this.diskMaxRadius, 1);

    this.advanceTrail(
      this.infallCanvas!, this.infallCtx!,
      BlackHoleVisualization.INFALL_ROTATION_SPEED, BlackHoleVisualization.INFALL_ZOOM_SCALE, BlackHoleVisualization.INFALL_FADE_RATE
    );
    this.drawInfallWave(this.infallCtx!);

    this.advanceTrail(
      this.frontCanvas!, this.frontCtx!,
      BlackHoleVisualization.FRONT_ROTATION_SPEED, BlackHoleVisualization.DISK_ZOOM_SCALE, BlackHoleVisualization.DISK_FADE_RATE
    );
    this.drawDiskBand(this.frontCtx!, this.frontPoints, this.frontMaxRadius, BlackHoleVisualization.DISK_TILT);

    // Composite back-to-front: lensed starfield, halo, black core, infalling
    // matter, front disk.
    ctx.clearRect(0, 0, width, height);
    this.drawStarfield(ctx);
    ctx.drawImage(this.haloCanvas!, 0, 0);
    this.drawEventHorizon(ctx);
    ctx.drawImage(this.infallCanvas!, 0, 0);
    this.drawFrontDisk(ctx);

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
    // that fraction of the half-height (0.6 => a 60%-of-height circle).
    this.eventHorizonRadius = halfHeight * BlackHoleVisualization.EVENT_HORIZON_HEIGHT_FRACTION;
    this.einsteinRadius = this.eventHorizonRadius * BlackHoleVisualization.EINSTEIN_RADIUS_FACTOR;
    this.diskAmplitude = halfHeight * BlackHoleVisualization.DISK_AMPLITUDE_FRACTION;
    this.diskBaseRadius = this.eventHorizonRadius + halfHeight * BlackHoleVisualization.DISK_GAP_FRACTION;
    this.diskMaxRadius = this.diskBaseRadius + this.diskAmplitude;
    // The front disk is the same band scaled wider, anchored at the horizon.
    const width: number = BlackHoleVisualization.FRONT_DISK_WIDTH;
    this.frontBaseRadius = this.eventHorizonRadius + (this.diskBaseRadius - this.eventHorizonRadius) * width;
    this.frontAmplitude = this.diskAmplitude * width;
    this.frontMaxRadius = this.frontBaseRadius + this.frontAmplitude;
    this.waveDepth = this.eventHorizonRadius * BlackHoleVisualization.WAVE_DEPTH_FRACTION;

    this.haloCanvas = this.ensureCanvas(this.haloCanvas);
    this.haloCtx = this.haloCanvas.getContext('2d', {alpha: true});
    this.frontCanvas = this.ensureCanvas(this.frontCanvas);
    this.frontCtx = this.frontCanvas.getContext('2d', {alpha: true});
    this.infallCanvas = this.ensureCanvas(this.infallCanvas);
    this.infallCtx = this.infallCanvas.getContext('2d', {alpha: true});

    if (!this.tempCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.tempCanvas = offscreen.canvas;
      this.tempCtx = offscreen.ctx;
    }
    this.tempCanvas.width = this.width;
    this.tempCanvas.height = this.height;

    // Stars live in resolution-independent angle/elevation, so a resize needs no
    // repositioning — they re-project to the new size automatically.
    if (!this.starsSeeded) {
      this.seedStars();
      this.starsSeeded = true;
    }

    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  /** Seeds the background stars at random azimuth/elevation and brightness. */
  private seedStars(): void {
    const n: number = BlackHoleVisualization.NUM_STARS;
    const halfFov: number = BlackHoleVisualization.STAR_HALF_FOV;
    const minB: number = BlackHoleVisualization.STAR_MIN_BRIGHTNESS;
    const range: number = BlackHoleVisualization.STAR_MAX_BRIGHTNESS - minB;
    for (let i: number = 0; i < n; i++) {
      this.starAngle[i] = (Math.random() * MULTIPLIER_DOUBLE - 1) * halfFov;
      this.starElev[i] = Math.random() * MULTIPLIER_DOUBLE - 1;
      this.starBright[i] = minB + Math.random() * range;
    }
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
   * Computes the halo edge, the wider front-disk edge, and the infall ring from
   * the same smoothed waveform. Peaks push the disk edges outward; troughs pull
   * the disk edges toward the horizon and dip the infall ring inward.
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

      // Halo (back) disk edge.
      let radius: number = this.diskBaseRadius + smoothed * this.diskAmplitude;
      if (radius < this.eventHorizonRadius) radius = this.eventHorizonRadius;
      if (radius > this.diskMaxRadius) radius = this.diskMaxRadius;
      this.edgePoints[i].x = this.centerX + radius * cos;
      this.edgePoints[i].y = this.centerY + radius * sin;

      // Front disk edge: same waveform, wider band.
      let frontRadius: number = this.frontBaseRadius + smoothed * this.frontAmplitude;
      if (frontRadius < this.eventHorizonRadius) frontRadius = this.eventHorizonRadius;
      if (frontRadius > this.frontMaxRadius) frontRadius = this.frontMaxRadius;
      this.frontPoints[i].x = this.centerX + frontRadius * cos;
      this.frontPoints[i].y = this.centerY + frontRadius * sin;

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

  /**
   * Draws one accretion-disk band (annulus) under a vertical squash. A tilt of
   * 1 is the face-on circular halo; a smaller tilt is the edge-on ellipse. Built
   * from circular geometry under the transform so the gradient stays consistent;
   * the inner circle is punched out so the band rings the core, not fills it.
   */
  private drawDiskBand(
    ctx: CanvasRenderingContext2D,
    points: ReadonlyArray<{x: number; y: number}>,
    maxRadius: number,
    tilt: number
  ): void {
    const inner: {r: number; g: number; b: number} = this.cachedInner;
    const body: {r: number; g: number; b: number} = this.cachedBody;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.translate(this.centerX, this.centerY);
    ctx.scale(1, tilt);
    ctx.translate(-this.centerX, -this.centerY);

    const gradient: CanvasGradient = ctx.createRadialGradient(
      this.centerX, this.centerY, this.eventHorizonRadius,
      this.centerX, this.centerY, maxRadius
    );
    // The bright "body" stop sits at the same band fraction for either disk.
    const span: number = this.diskMaxRadius - this.eventHorizonRadius;
    const midOffset: number = span > 0 ? (this.diskBaseRadius - this.eventHorizonRadius) / span : HALF;
    gradient.addColorStop(0, `rgba(${inner.r}, ${inner.g}, ${inner.b}, ${BlackHoleVisualization.DISK_INNER_ALPHA})`);
    gradient.addColorStop(midOffset, `rgba(${body.r}, ${body.g}, ${body.b}, ${BlackHoleVisualization.DISK_BODY_ALPHA})`);
    gradient.addColorStop(1, `rgba(${body.r}, ${body.g}, ${body.b}, 0)`);

    ctx.fillStyle = gradient;
    ctx.beginPath();
    this.buildSmoothPath(ctx, points, BlackHoleVisualization.NUM_SAMPLES);
    ctx.closePath();
    // Punch out the inner circle (an ellipse under the transform) so the disk is
    // a band, leaving the core visible.
    ctx.moveTo(this.centerX + this.eventHorizonRadius, this.centerY);
    ctx.arc(this.centerX, this.centerY, this.eventHorizonRadius, 0, TWO_PI);
    ctx.fill('evenodd');
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

  /**
   * Composites the front disk, but clipped so the upper half of the core is
   * excluded: the disk's far (back) edge there disappears behind the black hole,
   * while its near (lower) edge and the side wings stay in front of it.
   */
  private drawFrontDisk(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.width, this.height);
    // Upper half of the core, as an even-odd hole, so the front disk is not
    // drawn there (the sphere occludes the disk's far side).
    ctx.moveTo(this.centerX - this.eventHorizonRadius, this.centerY);
    ctx.arc(this.centerX, this.centerY, this.eventHorizonRadius, Math.PI, TWO_PI);
    ctx.closePath();
    ctx.clip('evenodd');
    ctx.drawImage(this.frontCanvas!, 0, 0);
    ctx.restore();
  }

  /**
   * Pans the starfield's azimuth and projects each star through a field of view:
   * `tan(angle)` for the horizontal position (slow in the distant centre, fast at
   * the near edges) and a `1/cos(angle)` depth that enlarges stars and spreads
   * them vertically toward the edges, so each traces an elliptical arc — closer
   * at the sides, receding into the distance in the middle. Each projected star
   * is then gravitationally lensed by the hole (a primary and secondary image).
   */
  private drawStarfield(ctx: CanvasRenderingContext2D): void {
    const cx: number = this.centerX;
    const cy: number = this.centerY;
    const halfW: number = this.width * HALF;
    const halfH: number = this.height * HALF;
    const horizon: number = this.eventHorizonRadius;
    const rs2: number = this.einsteinRadius * this.einsteinRadius;
    const n: number = BlackHoleVisualization.NUM_STARS;
    const halfFov: number = BlackHoleVisualization.STAR_HALF_FOV;
    const focal: number = halfW / Math.tan(halfFov);
    const spread: number = halfH * BlackHoleVisualization.STAR_VERTICAL_SPREAD;
    const minB: number = BlackHoleVisualization.STAR_MIN_BRIGHTNESS;
    const range: number = BlackHoleVisualization.STAR_MAX_BRIGHTNESS - minB;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgb(255, 255, 255)`;
    for (let i: number = 0; i < n; i++) {
      // Advance the azimuth right-to-left; wrap back to the far edge.
      let angle: number = this.starAngle[i] - BlackHoleVisualization.STAR_ANGULAR_SPEED;
      if (angle < -halfFov) {
        angle += halfFov * MULTIPLIER_DOUBLE;
        this.starElev[i] = Math.random() * MULTIPLIER_DOUBLE - 1;
        this.starBright[i] = minB + Math.random() * range;
      }
      this.starAngle[i] = angle;

      // Perspective projection: depth grows toward the edges of the field.
      const depth: number = 1 / Math.cos(angle);
      const sx: number = cx + Math.tan(angle) * focal;
      const sy: number = cy + this.starElev[i] * spread * depth;

      // Fade in/out at the edges so stars don't pop in/out abruptly.
      const edge: number = 1 - Math.abs(angle) / halfFov;
      const edgeAlpha: number = Math.min(1, edge / BlackHoleVisualization.STAR_EDGE_FADE);
      const bright: number = this.starBright[i] * edgeAlpha;
      const baseRadius: number = BlackHoleVisualization.STAR_BASE_RADIUS * depth;

      // Gravitational lensing of the projected star around the hole.
      const dx: number = sx - cx;
      const dy: number = sy - cy;
      let r: number = Math.sqrt(dx * dx + dy * dy);
      if (r < 1) r = 1;
      const ux: number = dx / r;
      const uy: number = dy / r;
      const root: number = Math.sqrt(r * r + MULTIPLIER_QUADRUPLE * rs2);

      // Primary image: always outside the Einstein ring.
      const r1: number = (r + root) / MULTIPLIER_DOUBLE;
      const mag1: number = (r1 * r1) / (r1 * r1 - rs2);
      this.drawStar(ctx, cx + ux * r1, cy + uy * r1, mag1, bright, 1, baseRadius);

      // Secondary image: opposite side, inside the ring; skip if behind shadow.
      const r2: number = (root - r) / MULTIPLIER_DOUBLE;
      if (r2 > horizon) {
        const denom: number = rs2 - r2 * r2;
        const mag2: number = denom > 0 ? (r2 * r2) / denom : BlackHoleVisualization.STAR_MAX_MAGNIFICATION;
        this.drawStar(ctx, cx - ux * r2, cy - uy * r2, mag2, bright, BlackHoleVisualization.SECONDARY_STAR_ALPHA, baseRadius);
      }
    }
    ctx.restore();
  }

  /** Draws one lensed star, magnification scaling its size and brightness. */
  private drawStar(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    mag: number,
    brightness: number,
    alphaScale: number,
    baseRadius: number
  ): void {
    const m: number = Math.min(mag, BlackHoleVisualization.STAR_MAX_MAGNIFICATION);
    const radius: number = baseRadius * Math.sqrt(m);
    ctx.globalAlpha = Math.min(1, brightness * alphaScale * (1 + (m - 1) * BlackHoleVisualization.STAR_MAG_BOOST));
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TWO_PI);
    ctx.fill();
  }

  /** Draws the solid black event-horizon core between the halo and the infall. */
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
    this.haloCanvas = null;
    this.haloCtx = null;
    this.frontCanvas = null;
    this.frontCtx = null;
    this.infallCanvas = null;
    this.infallCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}

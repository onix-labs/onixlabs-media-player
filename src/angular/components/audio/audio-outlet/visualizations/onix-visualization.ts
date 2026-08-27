/**
 * @fileoverview Onix visualization with pulsating gradient circle.
 *
 * Creates an ambient visual effect with a central pulsating circle that
 * responds to audio. The circle uses ONIXLabs brand colors in a smooth
 * gradient stroke that rotates and creates mesmerizing trail effects.
 * A white inner circle pulsates to bass/kick drums for added impact.
 *
 * Technical details:
 * - Central circle uses ONIXLabs brand color gradient stroke
 * - Circle pulses with audio waveform data
 * - White inner circle responds to bass frequencies (kick drums, no trail
 *   effect), enveloped with a fast attack and slow release so kicks punch
 *   without the radius jittering between frames
 * - Rotating trails with zoom and fade effects on outer circle, the zoom
 *   accelerating with radius so data falls away toward the outer rings
 * - Optimized with canvas reuse and pre-allocated arrays
 *
 * Performance optimizations:
 * - Reuses trail/temp canvases instead of recreating
 * - Pre-allocated point arrays avoid GC pressure
 * - Pre-computed trigonometric lookup tables for center circle
 *
 * @module app/components/audio/audio-outlet/visualizations/onix-visualization
 */

import {Canvas2DVisualization, OffscreenCanvasPair, VisualizationConfig} from './visualization';
import {ONIX_COLORS_FLAT, ONIX_COLOR_COUNT, TWO_PI} from './visualization-constants';

/**
 * Onix visualization with pulsating gradient circle.
 *
 * Renders a central pulsating circle with ONIXLabs brand color
 * gradient stroke, creating mesmerizing rotating trail effects.
 */
export class OnixVisualization extends Canvas2DVisualization {
  /** Radians the trail rotates per frame. */
  private static readonly ROTATION_SPEED: number = 0.005;

  /** Radians the waveform circle rotates per frame. */
  private static readonly WAVEFORM_ROTATION_SPEED: number = 0.0125;

  /** Per-frame trail fade rate. */
  private static readonly FADE_RATE: number = 0.025;

  /** Per-frame outward zoom applied to the trail. */
  private static readonly ZOOM_SCALE: number = 1.01;

  /** Exponent applied to the fade multiplier for more aggressive low-intensity fading. */
  private static readonly FADE_POWER: number = 0.005;

  /** Number of points around the pulsating center circle. */
  private static readonly CENTER_CIRCLE_POINTS: number = 128;

  /** Base glow blur radius in pixels. */
  private static readonly BASE_GLOW_BLUR: number = 3;

  /**
   * Number of concentric rings the trail is redrawn in.
   *
   * Canvas2D transforms a whole image at once, so a single rotate and scale
   * moves every radius identically - a uniform smear that never forms
   * structure. Rings give each radius its own transform so neighbouring radii
   * shear against each other and the feedback loop winds them.
   *
   * Set to 1 to go back to a single uniform transform.
   */
  private static readonly TRAIL_RING_COUNT: number = 32;

  /** Extra rotation at the outermost ring versus the innermost, per frame. */
  private static readonly RING_SHEAR: number = 0.0125;

  /**
   * Amplitude of the cosine ripple applied to each ring's zoom.
   *
   * Bounded by banding rather than by taste, and sharing that budget with the
   * acceleration below. The step between adjacent rings is the sum of both
   * gradients - this one contributes ripple times two pi times the cycle count
   * over the ring count - and once the total grows the boundaries read as hard
   * concentric shells. At the current values the ripple contributes 0.0059 and
   * the acceleration 0.0007, for 0.0066 together.
   */
  private static readonly RING_RIPPLE: number = 0.0075;

  /** Ripple cycles spanning the radius. Several, so bands do not sweep as one. */
  private static readonly RIPPLE_CYCLES: number = 8;

  /**
   * How much faster the outermost ring zooms than the innermost.
   *
   * Waveform data is born at the source circle and carried outward by the
   * zoom. A uniform zoom carries it out at a constant rate; this makes the
   * rate grow with radius, so data lingers near the source and then falls away
   * faster the further out it gets.
   *
   * Cubic rather than linear on purpose: t cubed stays near zero across the
   * inner half and climbs steeply beyond it, which is what makes it read as
   * falling away rather than as everything simply moving quicker. Against the
   * current base zoom the innermost rings travel at 0.5% a frame and the rim
   * at 2.0%, four times faster.
   *
   * Opposite in sign to the cubic it replaces, which slowed the rim. Content
   * still reaches the corners - every ring zooms outward - but crosses the
   * outer region faster, so it thins out there. That thinning is the effect.
   */
  private static readonly RING_ACCELERATION: number = 0.015;

  /** Radians the ripple pattern drifts per frame. */
  private static readonly RIPPLE_DRIFT: number = 0.025;

  /**
   * Ring widths the boundaries slide per frame.
   *
   * Sliding them means a given radius falls in one ring on some frames and its
   * neighbour on others, so the step between them is dithered over time rather
   * than baking into the trail at a fixed radius.
   */
  private static readonly RING_BOUNDARY_DRIFT: number = 0.03;

  /**
   * Attack coefficient for the bass envelope.
   *
   * High, so a kick still arrives with its edge intact. The circle was reading
   * raw instantaneous bass, which jitters frame to frame rather than pulsing;
   * smoothing both directions equally would fix the jitter by blunting the
   * transient, which is the one thing this element exists to show.
   */
  private static readonly BASS_ATTACK: number = 0.55;

  /** Release coefficient. Low, so the circle decays rather than flickering out. */
  private static readonly BASS_RELEASE: number = 0.07;

  /** Radius, in pixels, over which the circle fades in instead of popping on. */
  private static readonly BASS_FADE_IN_RADIUS: number = 6;

  /** Glow blur at full bass, in pixels. */
  private static readonly BASS_GLOW_BLUR: number = 45;

  /** Alpha of the glow around the circle, before the fade-in. */
  private static readonly BASS_GLOW_ALPHA: number = 0.8;

  /** Fraction of the radius held at full white before the falloff starts. */
  private static readonly BASS_CORE_STOP: number = 0.55;

  /** Alpha the fill falls off to at the circle's edge. */
  private static readonly BASS_EDGE_ALPHA: number = 0.3;

  /** Alpha of the near-white filament drawn over the gradient core. */
  private static readonly FILAMENT_ALPHA: number = 0.5;

  /** Width of the filament, as a fraction of the core stroke width. */
  private static readonly FILAMENT_WIDTH_FRACTION: number = 0.5;

  /** Blur radius of the bloom pass, in pixels. */
  private static readonly BLOOM_BLUR: number = 64;

  /** Strength of the additive bloom pass. */
  private static readonly BLOOM_STRENGTH: number = 1;

  public readonly name: string = 'Onix';
  public readonly category: string = 'Signature';

  /** Audio data buffers. */
  private dataArray: Uint8Array<ArrayBuffer>;
  private frequencyData: Uint8Array<ArrayBuffer>;

  /** Trail canvas (reused, not recreated each frame) - THIS IS THE KEY OPTIMIZATION. */
  private trailCanvas: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;

  /** Temp canvas for the zoom/rotate effect (reused, not recreated each frame). */
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  /** Smoothed bass envelope driving the centre circle. */
  private bassLevel: number = 0;

  /** Phase of the ring ripple, so the bands migrate rather than sitting still. */
  private ripplePhase: number = 0;

  /** Offset of the ring boundaries, in ring widths, so seams do not bake in. */
  private ringPhase: number = 0;

  /** Current waveform rotation angle. */
  private waveformAngle: number = 0;

  /** Pre-allocated point array to avoid GC pressure. */
  private readonly centerPoints: Array<{x: number; y: number}>;

  /** Pre-computed trigonometric lookup tables for the center circle. */
  private readonly cosTable: Float32Array;
  private readonly sinTable: Float32Array;

  /** Pre-computed layout values (updated on resize). */
  private centerX: number = 0;
  private centerY: number = 0;
  private baseCircleRadius: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;

    const numPoints: number = OnixVisualization.CENTER_CIRCLE_POINTS;

    // Pre-allocate point arrays
    this.centerPoints = new Array(numPoints + 1);
    for (let i: number = 0; i <= numPoints; i++) {
      this.centerPoints[i] = {x: 0, y: 0};
    }

    // Pre-compute trigonometric lookup tables for center circle
    this.cosTable = new Float32Array(numPoints);
    this.sinTable = new Float32Array(numPoints);
    for (let i: number = 0; i < numPoints; i++) {
      const angle: number = (i / numPoints) * TWO_PI;
      this.cosTable[i] = Math.cos(angle);
      this.sinTable[i] = Math.sin(angle);
    }

    // Hard-coded look; the setters below are no-ops so the (removed) controls can't change these.
    this.sensitivity = 0.4;       // 40%
    this.trailIntensity = 0.1;    // 10%
    this.lineWidth = 1;           // 1px
    this.glowIntensity = 0;       // no glow
    this.waveformSmoothing = 1;   // 100%
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;
    const centerX: number = this.centerX;
    const centerY: number = this.centerY;

    // Ensure canvases exist
    if (!this.trailCanvas || !this.trailCtx || !this.tempCanvas || !this.tempCtx) {
      this.onResize();
    }

    const trailCtx: CanvasRenderingContext2D = this.trailCtx!;
    const trailCanvas: HTMLCanvasElement = this.trailCanvas!;
    const tempCtx: CanvasRenderingContext2D = this.tempCtx!;
    const tempCanvas: HTMLCanvasElement = this.tempCanvas!;

    // Copy current trails to temp canvas (reused, not recreated)
    tempCtx.clearRect(0, 0, width, height);
    tempCtx.drawImage(trailCanvas, 0, 0);

    // Clear trail canvas
    trailCtx.clearRect(0, 0, width, height);

    // Draw back previous trails with rotation, zoom, and fade.
    // Apply power curve to fade multiplier for more aggressive low-intensity fading.
    const baseMultiplier: number = this.getFadeMultiplier();
    const scaledMultiplier: number = Math.pow(baseMultiplier, OnixVisualization.FADE_POWER);
    const effectiveFadeRate: number = OnixVisualization.FADE_RATE * scaledMultiplier;
    this.ripplePhase = (this.ripplePhase + OnixVisualization.RIPPLE_DRIFT) % TWO_PI;
    this.ringPhase = (this.ringPhase + OnixVisualization.RING_BOUNDARY_DRIFT) % 1;
    this.drawShearedTrail(trailCtx, tempCanvas, effectiveFadeRate);

    // Get waveform data
    this.analyser.getByteTimeDomainData(this.dataArray);

    // Get frequency data for bass detection
    this.analyser.getByteFrequencyData(this.frequencyData);

    // Update waveform rotation
    this.waveformAngle -= OnixVisualization.WAVEFORM_ROTATION_SPEED;

    // Draw the center circle with rotation
    trailCtx.save();
    trailCtx.translate(centerX, centerY);
    trailCtx.rotate(this.waveformAngle);
    trailCtx.translate(-centerX, -centerY);
    this.drawCenterCircle(trailCtx);
    trailCtx.restore();

    // Clear main canvas and draw trails, then add a blurred copy on top. Once
    // content is baked into the trail buffer there is no stroke left to hang a
    // shadow on, so the glow on the trails has to come from the buffer itself.
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(trailCanvas, 0, 0);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = `blur(${OnixVisualization.BLOOM_BLUR}px)`;
    ctx.globalAlpha = OnixVisualization.BLOOM_STRENGTH;
    ctx.drawImage(trailCanvas, 0, 0);
    ctx.restore();

    // Draw the bass-reactive white circle on main canvas (no trail effect)
    this.drawBassCircle(ctx);

    this.applyFadeOverlay();
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  // Fixed visual parameters: ignore the global controls (values set in constructor).
  public override setSensitivity(): void { /* fixed */ }
  public override setTrailIntensity(): void { /* fixed */ }
  public override setLineWidth(): void { /* fixed */ }
  public override setGlowIntensity(): void { /* fixed */ }
  public override setWaveformSmoothing(): void { /* fixed */ }

  protected override onResize(): void {
    // Pre-compute center values
    this.centerX = this.width * 0.5;
    this.centerY = this.height * 0.5;
    this.baseCircleRadius = Math.min(this.width, this.height) * 0.30;

    // Create trail canvas if needed
    if (!this.trailCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.trailCanvas = offscreen.canvas;
      this.trailCtx = offscreen.ctx;
    }

    // Create temp canvas if needed
    if (!this.tempCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.tempCanvas = offscreen.canvas;
      this.tempCtx = offscreen.ctx;
    }

    // Resize trail canvas while preserving content
    this.resizeCanvasPreserving(this.trailCanvas, this.trailCtx!, this.width, this.height);
    // Temp canvas doesn't need content preserved (it's just working space)
    this.tempCanvas.width = this.width;
    this.tempCanvas.height = this.height;

    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  /**
   * Redraws the previous trail with rotation, zoom and fade, sheared by radius.
   *
   * The trail is clipped into concentric rings, each turned and scaled by a
   * slightly different amount, so the outer field moves differently from the
   * inner one. A single whole-image transform moves every radius equally,
   * which smears rather than structures.
   *
   * Every ring zooms outward, and increasingly so with radius, so waveform
   * data born at the source circle accelerates away toward the outer rings
   * rather than drifting out at a constant rate.
   *
   * @param trailCtx - Destination trail context
   * @param tempCanvas - Copy of the previous trail to read from
   * @param fadeRate - Per-frame fade already scaled by trail intensity
   */
  private drawShearedTrail(
    trailCtx: CanvasRenderingContext2D,
    tempCanvas: HTMLCanvasElement,
    fadeRate: number
  ): void {
    // Floored to avoid a sub-pixel centre, which causes quadrant artifacts.
    const centerX: number = Math.floor(this.centerX);
    const centerY: number = Math.floor(this.centerY);
    const rings: number = Math.max(1, OnixVisualization.TRAIL_RING_COUNT);

    // Far enough to cover the corners from wherever the centre sits.
    const maxRadius: number = Math.hypot(
      Math.max(centerX, this.width - centerX),
      Math.max(centerY, this.height - centerY)
    );

    // One extra band, because the sliding offset leaves a partial ring at each
    // end: the innermost shrinks to nothing as the offset advances and a new
    // one opens at the rim.
    const offset: number = this.ringPhase;
    for (let i: number = 0; i <= rings; i++) {
      const inner: number = Math.max(0, ((i - 1 + offset) / rings) * maxRadius);
      const outer: number = Math.min(maxRadius, ((i + offset) / rings) * maxRadius);
      if (outer <= inner) continue;

      const across: number = ((inner + outer) * 0.5) / maxRadius;
      const spin: number =
        OnixVisualization.ROTATION_SPEED + OnixVisualization.RING_SHEAR * across;
      const ripple: number =
        Math.cos(across * TWO_PI * OnixVisualization.RIPPLE_CYCLES - this.ripplePhase)
        * OnixVisualization.RING_RIPPLE;
      const acceleration: number =
        OnixVisualization.RING_ACCELERATION * across * across * across;
      const zoom: number = OnixVisualization.ZOOM_SCALE + ripple + acceleration;

      trailCtx.save();

      // Clipped before the transform, so the ring is a region of the
      // destination rather than of the source being read.
      trailCtx.beginPath();
      trailCtx.arc(centerX, centerY, outer, 0, TWO_PI);
      if (inner > 0) {
        trailCtx.arc(centerX, centerY, inner, 0, TWO_PI, true);
      }
      trailCtx.clip();

      trailCtx.imageSmoothingEnabled = true;
      trailCtx.imageSmoothingQuality = 'high';
      trailCtx.globalAlpha = 1 - fadeRate;
      trailCtx.translate(centerX, centerY);
      trailCtx.rotate(spin);
      trailCtx.scale(zoom, zoom);
      trailCtx.translate(-centerX, -centerY);
      trailCtx.drawImage(tempCanvas, 0, 0);

      trailCtx.restore();
    }
  }

  private drawCenterCircle(ctx: CanvasRenderingContext2D): void {
    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;
    const dataLength: number = dataArray.length;
    const height: number = this.height;
    const centerX: number = this.centerX;
    const centerY: number = this.centerY;
    const baseRadius: number = this.baseCircleRadius;
    const numPoints: number = OnixVisualization.CENTER_CIRCLE_POINTS;
    const sensitivityFactor: number = this.sensitivityFactor;
    const amplitudeScale: number = height * 0.08;
    const sampleStep: number = (dataLength * 0.25) / numPoints;
    const cosTable: Float32Array = this.cosTable;
    const sinTable: Float32Array = this.sinTable;

    // Calculate the first sample for cross-fade blending at the seam
    const firstDataIndex: number = 0;
    const firstSample: number = ((dataArray[firstDataIndex] - 128) / 128) * sensitivityFactor;

    // Cross-fade zone: last 15% of points blend toward the first sample
    const crossFadeStart: number = Math.floor(numPoints * 0.85);

    // Calculate points (reuse pre-allocated array)
    for (let i: number = 0; i < numPoints; i++) {
      const dataIndex: number = ((i * sampleStep) | 0) % dataLength;
      let sample: number = ((dataArray[dataIndex] - 128) / 128) * sensitivityFactor;

      // Cross-fade the last portion toward the first sample to eliminate seam
      if (i >= crossFadeStart) {
        const t: number = (i - crossFadeStart) / (numPoints - crossFadeStart);
        sample = sample * (1 - t) + firstSample * t;
      }

      const radius: number = baseRadius + sample * amplitudeScale;

      this.centerPoints[i].x = centerX + radius * cosTable[i];
      this.centerPoints[i].y = centerY + radius * sinTable[i];
    }
    // Close the circle
    this.centerPoints[numPoints] = this.centerPoints[0];

    const points: Array<{x: number; y: number}> = this.centerPoints;
    const colors: Uint8Array = ONIX_COLORS_FLAT;

    // Create conic gradient for the brand colors
    // Start angle is -PI/2 (top of circle) to match point calculation which starts at angle 0 (right)
    const gradient: CanvasGradient = ctx.createConicGradient(0, centerX, centerY);
    const glowGradient: CanvasGradient = ctx.createConicGradient(0, centerX, centerY);

    // Add color stops for each brand color
    for (let i: number = 0; i < ONIX_COLOR_COUNT; i++) {
      const idx: number = i * 3;
      const r: number = colors[idx];
      const g: number = colors[idx + 1];
      const b: number = colors[idx + 2];
      const stop: number = i / ONIX_COLOR_COUNT;

      gradient.addColorStop(stop, `rgb(${r}, ${g}, ${b})`);
      glowGradient.addColorStop(stop, `rgba(${r}, ${g}, ${b}, 0.6)`);
    }
    // Close the gradient loop
    const r0: number = colors[0];
    const g0: number = colors[1];
    const b0: number = colors[2];
    gradient.addColorStop(1, `rgb(${r0}, ${g0}, ${b0})`);
    glowGradient.addColorStop(1, `rgba(${r0}, ${g0}, ${b0}, 0.6)`);

    // Build smooth closed path using the base class helper
    const buildPath: () => void = (): void => {
      this.buildSmoothPath(ctx, points, numPoints);
      ctx.closePath();
    };

    const glowBlur: number = this.getScaledGlowBlur(OnixVisualization.BASE_GLOW_BLUR);

    // Draw glow layer - use white shadow so glow complements all spectrum colors
    ctx.save();
    ctx.shadowBlur = glowBlur;
    ctx.shadowColor = 'rgba(255, 255, 255, 0.6)';
    ctx.strokeStyle = glowGradient;
    ctx.lineWidth = this.lineWidth + 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    buildPath();
    ctx.stroke();
    ctx.restore();

    // Draw main stroke with gradient
    ctx.strokeStyle = gradient;
    ctx.lineWidth = this.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    buildPath();
    ctx.stroke();

    // Hot filament. White rather than a lift of the stroke colour, because the
    // core is a brand gradient rather than one hue - lifting it per channel
    // would shift the brand colours, where a thin white line over the top
    // reads as the tube being lit from inside and leaves them alone. Drawn
    // source-over: the trail buffer accumulates, so an additive pass here
    // compounds frame on frame and saturates.
    ctx.strokeStyle = `rgba(255, 255, 255, ${OnixVisualization.FILAMENT_ALPHA})`;
    ctx.lineWidth = Math.max(1, this.lineWidth * OnixVisualization.FILAMENT_WIDTH_FRACTION);
    buildPath();
    ctx.stroke();
  }

  /**
   * Draws a white circle in the center that pulsates to bass/kick drums.
   * The circle radius is 0 when there's no audio, and max 1/3 of the waveform radius.
   */
  private drawBassCircle(ctx: CanvasRenderingContext2D): void {
    const frequencyData: Uint8Array<ArrayBuffer> = this.frequencyData;
    const binCount: number = frequencyData.length;

    // Sample the low frequency bins (bass range ~20-150Hz)
    // With typical 44.1kHz sample rate and 2048 FFT, each bin is ~21.5Hz
    // So bins 1-7 cover roughly 21-150Hz (kick drum range)
    const bassEndBin: number = Math.min(8, binCount);
    let bassSum: number = 0;

    for (let i: number = 1; i < bassEndBin; i++) {
      bassSum += frequencyData[i];
    }

    // Normalize bass intensity (0-1 range)
    const bassIntensity: number = bassSum / ((bassEndBin - 1) * 255);

    // Envelope the level rather than using it raw: fast on the way up so a kick
    // keeps its edge, slow on the way down so the circle decays instead of
    // flickering with every frame's bin noise.
    const coefficient: number = bassIntensity > this.bassLevel
      ? OnixVisualization.BASS_ATTACK
      : OnixVisualization.BASS_RELEASE;
    this.bassLevel += (bassIntensity - this.bassLevel) * coefficient;

    // Apply sensitivity and calculate radius
    // Max radius is 1/3 of the colored waveform radius
    const maxBassRadius: number = this.baseCircleRadius / 3;
    const bassRadius: number = this.bassLevel * maxBassRadius * (this.sensitivity * 3);

    if (bassRadius <= 0.5) return;

    const centerX: number = this.centerX;
    const centerY: number = this.centerY;

    // Fade in over the first few pixels rather than appearing at full strength
    // the instant the radius clears the threshold.
    const alpha: number = Math.min(1, bassRadius / OnixVisualization.BASS_FADE_IN_RADIUS);

    ctx.save();

    // Glow scaled by the envelope, so hard kicks flare and quiet ones do not.
    ctx.shadowBlur = this.getScaledGlowBlur(OnixVisualization.BASS_GLOW_BLUR) * this.bassLevel;
    ctx.shadowColor = `rgba(255, 255, 255, ${OnixVisualization.BASS_GLOW_ALPHA * alpha})`;

    // Radial fill: solid to the core stop, then falling off. A flat disc reads
    // as a sticker in a scene where everything else emits; the falloff makes it
    // a light source instead. The black outline it used to carry is gone with
    // it - it was the one element in the scene absorbing light rather than
    // giving any.
    const fill: CanvasGradient = ctx.createRadialGradient(
      centerX, centerY, 0, centerX, centerY, bassRadius
    );
    fill.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    fill.addColorStop(OnixVisualization.BASS_CORE_STOP, `rgba(255, 255, 255, ${alpha})`);
    fill.addColorStop(1, `rgba(255, 255, 255, ${OnixVisualization.BASS_EDGE_ALPHA * alpha})`);

    ctx.beginPath();
    ctx.arc(centerX, centerY, bassRadius, 0, TWO_PI);
    ctx.fillStyle = fill;
    ctx.fill();

    // Crisp rim over the falloff, so it still reads as a ring rather than a
    // soft blob. No shadow on this pass: it is the edge, not the glow.
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.lineWidth = Math.max(1, this.lineWidth);
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

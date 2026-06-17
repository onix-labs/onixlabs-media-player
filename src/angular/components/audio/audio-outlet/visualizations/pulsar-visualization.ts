/**
 * @fileoverview Pulsar visualization with mirrored curved waveforms.
 *
 * Creates an ambient visual effect with mirrored waveforms that curve
 * around a central pulsating circle. The waveforms bend away from the
 * center creating a wing-like pattern. Colors cycle through the spectrum.
 *
 * Technical details:
 * - Mirrored waveforms on left and right
 * - Arc-based bending creates curved appearance
 * - Central circle pulses with audio
 * - HSL color cycling for smooth transitions
 * - Optimized with canvas reuse and pre-allocated arrays
 * - Waveform rotation independent of trail rotation
 *
 * Performance optimizations:
 * - Reuses trail/temp canvases instead of recreating
 * - Pre-allocated point arrays avoid GC pressure
 * - Gradient colors cached and only updated on hue change
 *
 * @module app/components/audio/audio-outlet/visualizations/pulsar-visualization
 */

import {Canvas2DVisualization, OffscreenCanvasPair, VisualizationConfig} from './visualization';

/**
 * Pulsar visualization with curved mirrored waveforms.
 *
 * Renders mirrored curved waveforms that wrap around a central
 * pulsating circle, with smooth color cycling.
 */
export class PulsarVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Pulsar';
  public readonly category: string = 'Waves';

  private readonly ROTATION_SPEED: number = 0.009;
  private readonly WAVEFORM_ROTATION_SPEED: number = 0.005;
  private readonly FADE_RATE: number = 0.008;
  private readonly ZOOM_SCALE: number = 1.02;
  private readonly HUE_CYCLE_SPEED: number = 0.15;

  // Bass transient detection. A strong bass hit flips the spin direction (at
  // most once per DIRECTION_COOLDOWN) and, less often, triggers a color switch.
  private readonly BASS_BINS: number = 16;
  private readonly TRANSIENT_THRESHOLD: number = 15;
  private readonly MIN_LEVEL: number = 50;
  private readonly DIRECTION_COOLDOWN: number = 5000;
  // A bass transient can also trigger a sudden color switch, gated to at most
  // once per COLOR_SHIFT_COOLDOWN: the background flashes white then eases back
  // to black/transparent and the spinning waveforms invert to black then ease
  // back to their normal light color over COLOR_SNAP_DURATION. The cycling hue
  // is not changed.
  private readonly COLOR_SHIFT_COOLDOWN: number = 10000;
  private readonly COLOR_SNAP_DURATION: number = 1500;

  private frequencyData: Uint8Array<ArrayBuffer>;
  private prevBass: number = 0;
  private rotationDirection: number = 1;
  private lastDirectionChange: number = 0;
  private lastColorShift: number = 0;
  // 1 at the instant of a color switch, easing to 0 as the snap resolves.
  private colorSnapProgress: number = 0;

  // Balanced sample count (was 1024, reduced to 256 for performance while keeping smoothness)
  private readonly WAVEFORM_SAMPLES: number = 256;
  private readonly CENTER_CIRCLE_POINTS: number = 64;

  // Saturation and lightness levels for gradient
  private readonly GRADIENT_LEVELS: ReadonlyArray<{s: number; l: number}> = [
    {s: 85, l: 12},
    {s: 80, l: 22},
    {s: 75, l: 35},
    {s: 70, l: 45},
    {s: 75, l: 50}
  ];

  // Audio data buffer
  private dataArray: Uint8Array<ArrayBuffer>;

  // Trail canvas (reused, not recreated each frame) - THIS IS THE KEY OPTIMIZATION
  private trailCanvas: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;

  // Temp canvas for zoom/rotate effect (reused, not recreated each frame)
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  // Hue cycling with caching
  private hueOffset: number = 210;
  private cachedHue: number = -1;
  private cachedGradientColors: Array<{r: number; g: number; b: number}> = [];
  private cachedLighterColor: {r: number; g: number; b: number} = {r: 0, g: 0, b: 0};

  // Waveform rotation
  private waveformAngle: number = 0;

  // Pre-allocated arrays to avoid GC pressure
  private readonly leftPoints: Array<{x: number; y: number}>;
  private readonly rightPoints: Array<{x: number; y: number}>;
  private readonly centerPoints: Array<{x: number; y: number}>;

  // Pre-computed values (updated on resize)
  private centerX: number = 0;
  private centerY: number = 0;
  private halfWidth: number = 0;
  private minArcRadius: number = 0;
  private baseCircleRadius: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;

    // Pre-allocate point arrays
    this.leftPoints = new Array(this.WAVEFORM_SAMPLES);
    this.rightPoints = new Array(this.WAVEFORM_SAMPLES);
    this.centerPoints = new Array(this.CENTER_CIRCLE_POINTS + 1);

    for (let i: number = 0; i < this.WAVEFORM_SAMPLES; i++) {
      this.leftPoints[i] = {x: 0, y: 0};
      this.rightPoints[i] = {x: 0, y: 0};
    }
    for (let i: number = 0; i <= this.CENTER_CIRCLE_POINTS; i++) {
      this.centerPoints[i] = {x: 0, y: 0};
    }

    // Hard-coded look; the setters below are no-ops so the (removed) controls can't change these.
    this.sensitivity = 0.2;       // 20%
    this.trailIntensity = 0;      // minimal trails
    this.lineWidth = 1;           // 1px
    this.glowIntensity = 1;       // 100%
    this.waveformSmoothing = 1;   // 100%
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

  // Cache gradient colors - only recalculate when hue changes by >= 1 degree
  private updateGradientColors(): void {
    const hueInt: number = Math.floor(this.hueOffset);
    if (hueInt === this.cachedHue) return;

    this.cachedHue = hueInt;
    this.cachedGradientColors = this.GRADIENT_LEVELS.map(
      (level: {s: number; l: number}): {r: number; g: number; b: number} =>
        this.hslToRgb(this.hueOffset, level.s, level.l)
    );
    this.cachedLighterColor = this.hslToRgb(this.hueOffset, 60, 75);
  }

  protected override onResize(): void {
    // Pre-compute center values
    this.centerX = this.width * 0.5;
    this.centerY = this.height * 0.5;
    this.halfWidth = this.width * 0.5;
    this.minArcRadius = this.halfWidth * 0.18;
    this.baseCircleRadius = this.halfWidth * 0.18;

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

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;
    const centerX: number = this.centerX;
    const centerY: number = this.centerY;

    // Cycle hue and update cached colors if needed
    this.hueOffset = (this.hueOffset + this.HUE_CYCLE_SPEED) % 360;
    this.updateGradientColors();

    // Ensure canvases exist
    if (!this.trailCanvas || !this.trailCtx || !this.tempCanvas || !this.tempCtx) {
      this.onResize();
    }

    const trailCtx: CanvasRenderingContext2D = this.trailCtx!;
    const trailCanvas: HTMLCanvasElement = this.trailCanvas!;
    const tempCtx: CanvasRenderingContext2D = this.tempCtx!;
    const tempCanvas: HTMLCanvasElement = this.tempCanvas!;

    // Analyze bass frequencies to detect transients. A strong bass hit flips the
    // spin direction (gated by DIRECTION_COOLDOWN) and, gated more loosely by
    // COLOR_SHIFT_COOLDOWN, also triggers a color switch.
    this.analyser.getByteFrequencyData(this.frequencyData);
    let bassSum: number = 0;
    for (let i: number = 0; i < this.BASS_BINS; i++) {
      bassSum += this.frequencyData[i];
    }
    const bassAvg: number = bassSum / this.BASS_BINS;
    const bassIncrease: number = bassAvg - this.prevBass;
    this.prevBass = bassAvg;

    const now: number = performance.now();
    const canChangeDirection: boolean = (now - this.lastDirectionChange) > this.DIRECTION_COOLDOWN;
    const canShiftColor: boolean = (now - this.lastColorShift) > this.COLOR_SHIFT_COOLDOWN;
    const isTransient: boolean = bassIncrease > this.TRANSIENT_THRESHOLD && bassAvg > this.MIN_LEVEL;

    const rotationChanged: boolean = isTransient && canChangeDirection;
    if (rotationChanged) {
      this.rotationDirection *= -1;
      this.lastDirectionChange = now;
    }

    // A color switch flashes the background white and inverts the spinning
    // waveforms (black -> white) - never without an accompanying direction
    // change, so it always coincides with a spin flip. The cycling hue is left
    // untouched; only the lightness flips.
    if (rotationChanged && canShiftColor) {
      this.lastColorShift = now;
    }

    // Invert progress for the color-switch flash: 1 at the switch, easing to 0.
    this.colorSnapProgress = this.lastColorShift > 0
      ? Math.max(0, 1 - (now - this.lastColorShift) / this.COLOR_SNAP_DURATION)
      : 0;

    // Copy current trails to temp canvas (reused, not recreated)
    tempCtx.clearRect(0, 0, width, height);
    tempCtx.drawImage(trailCanvas, 0, 0);

    // Clear trail canvas
    trailCtx.clearRect(0, 0, width, height);

    // Draw back previous trails with rotation, zoom, and fade
    // Apply trail intensity multiplier to fade rate
    const effectiveFadeRate: number = this.FADE_RATE * this.getFadeMultiplier();
    trailCtx.save();
    // Use high-quality image smoothing to reduce artifacts from repeated scaling
    trailCtx.imageSmoothingEnabled = true;
    trailCtx.imageSmoothingQuality = 'high';
    trailCtx.globalAlpha = 1 - effectiveFadeRate;
    // Use floor to avoid sub-pixel center point which causes quadrant artifacts
    const floorCenterX: number = Math.floor(centerX);
    const floorCenterY: number = Math.floor(centerY);
    trailCtx.translate(floorCenterX, floorCenterY);
    trailCtx.rotate(this.ROTATION_SPEED * this.rotationDirection);
    trailCtx.scale(this.ZOOM_SCALE, this.ZOOM_SCALE);
    trailCtx.translate(-floorCenterX, -floorCenterY);
    trailCtx.drawImage(tempCanvas, 0, 0);
    trailCtx.restore();

    // Get waveform data
    this.analyser.getByteTimeDomainData(this.dataArray);

    // Update waveform rotation (follows the bass-reactive spin direction)
    this.waveformAngle -= this.WAVEFORM_ROTATION_SPEED * this.rotationDirection;

    // Draw the mirrored waveforms with rotation
    trailCtx.save();
    trailCtx.translate(centerX, centerY);
    trailCtx.rotate(this.waveformAngle);
    trailCtx.translate(-centerX, -centerY);
    this.drawMirroredWaveform(trailCtx);
    trailCtx.restore();

    // Clear main canvas, then on a color switch paint a white background veil
    // that fades out as the snap resolves (background goes white -> black/
    // transparent). Drawn under the trail so the waveforms stay visible over it.
    ctx.clearRect(0, 0, width, height);
    if (this.colorSnapProgress > 0) {
      ctx.save();
      ctx.globalAlpha = this.colorSnapProgress;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
    ctx.drawImage(trailCanvas, 0, 0);

    this.applyFadeOverlay();
  }

  private drawMirroredWaveform(ctx: CanvasRenderingContext2D): void {
    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;
    const dataLength: number = dataArray.length;
    const height: number = this.height;
    const centerX: number = this.centerX;
    const centerY: number = this.centerY;
    const halfWidth: number = this.halfWidth;
    const minArcRadius: number = this.minArcRadius;
    const sensitivityFactor: number = this.sensitivityFactor;
    const amplitudeScale: number = height * 0.3;
    const bendStrength: number = 1.2;
    const numSamples: number = this.WAVEFORM_SAMPLES;

    // Calculate downsampling step
    const sampleStep: number = (dataLength * 0.5) / numSamples;

    // Left half points (from left edge to center) - reuse pre-allocated array
    for (let i: number = 0; i < numSamples; i++) {
      const dataIndex: number = (i * sampleStep) | 0;
      const sample: number = ((dataArray[dataIndex] - 128) / 128) * sensitivityFactor;
      const amplitude: number = sample * amplitudeScale;
      const t: number = i / (numSamples - 1);
      const baseX: number = t * halfWidth;

      const distFromCenter: number = centerX - baseX;
      const arcRadius: number = distFromCenter > minArcRadius ? distFromCenter : minArcRadius;
      const arcAngle: number = (amplitude * bendStrength) / arcRadius;
      const newAngle: number = Math.PI - arcAngle;

      this.leftPoints[i].x = centerX + arcRadius * Math.cos(newAngle);
      this.leftPoints[i].y = centerY + arcRadius * Math.sin(newAngle);
    }

    // Right half points (mirrored) - reuse pre-allocated array
    for (let i: number = 0; i < numSamples; i++) {
      const srcIdx: number = numSamples - 1 - i;
      const dataIndex: number = (srcIdx * sampleStep) | 0;
      const sample: number = ((dataArray[dataIndex] - 128) / 128) * sensitivityFactor;
      const amplitude: number = sample * amplitudeScale;
      const t: number = srcIdx / (numSamples - 1);
      const baseX: number = this.width - t * halfWidth;

      const distFromCenter: number = baseX - centerX;
      const arcRadius: number = distFromCenter > minArcRadius ? distFromCenter : minArcRadius;
      const arcAngle: number = (amplitude * bendStrength) / arcRadius;

      this.rightPoints[i].x = centerX + arcRadius * Math.cos(arcAngle);
      this.rightPoints[i].y = centerY + arcRadius * Math.sin(arcAngle);
    }

    // The spinning waveforms normally use the lighter cycling color, but during
    // a color switch they invert to black and ease back to that light color as
    // the snap resolves (black -> white), matching the white background flash.
    const baseColor: {r: number; g: number; b: number} = this.cachedLighterColor;
    const snap: number = this.colorSnapProgress;
    const color: {r: number; g: number; b: number} = {
      r: Math.round(baseColor.r * (1 - snap)),
      g: Math.round(baseColor.g * (1 - snap)),
      b: Math.round(baseColor.b * (1 - snap))
    };

    // Draw left and right waveforms with glow
    this.drawWaveformSegment(ctx, this.leftPoints, numSamples, color, 0.6);
    this.drawWaveformSegment(ctx, this.rightPoints, numSamples, color, 0.6);

    // Draw center circle
    this.drawCenterCircle(ctx);
  }

  private drawCenterCircle(ctx: CanvasRenderingContext2D): void {
    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;
    const dataLength: number = dataArray.length;
    const height: number = this.height;
    const centerX: number = this.centerX;
    const centerY: number = this.centerY;
    const baseRadius: number = this.baseCircleRadius;
    const numPoints: number = this.CENTER_CIRCLE_POINTS;
    const sensitivityFactor: number = this.sensitivityFactor;
    const amplitudeScale: number = height * 0.08;
    const sampleStep: number = (dataLength * 0.25) / numPoints;

    // Calculate points (reuse pre-allocated array)
    for (let i: number = 0; i <= numPoints; i++) {
      const angle: number = (i / numPoints) * Math.PI * 2;
      const dataIndex: number = ((i * sampleStep) | 0) % dataLength;
      const sample: number = ((dataArray[dataIndex] - 128) / 128) * sensitivityFactor;
      const radius: number = baseRadius + sample * amplitudeScale;

      this.centerPoints[i].x = centerX + radius * Math.cos(angle);
      this.centerPoints[i].y = centerY + radius * Math.sin(angle);
    }

    const color: {r: number; g: number; b: number} = this.cachedGradientColors[this.cachedGradientColors.length - 1];
    const points: Array<{x: number; y: number}> = this.centerPoints;

    // Build smooth closed path using the base class helper
    const buildPath: () => void = (): void => {
      this.buildSmoothPath(ctx, points, numPoints);
      ctx.closePath();
    };

    const glowBlur: number = this.getScaledGlowBlur(15);

    // Draw glow layer
    ctx.save();
    ctx.shadowBlur = glowBlur;
    ctx.shadowColor = `rgba(${color.r}, ${color.g}, ${color.b}, 0.6)`;
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, 0.3)`;
    ctx.lineWidth = this.lineWidth + 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    buildPath();
    ctx.stroke();
    ctx.restore();

    // Draw main circle
    ctx.strokeStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
    ctx.lineWidth = this.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    buildPath();
    ctx.stroke();

    // Draw highlight
    ctx.strokeStyle = `rgba(${Math.min(255, color.r + 60)}, ${Math.min(255, color.g + 40)}, ${Math.min(255, color.b + 20)}, 0.5)`;
    ctx.lineWidth = 1;
    buildPath();
    ctx.stroke();
  }

  private drawWaveformSegment(
    ctx: CanvasRenderingContext2D,
    points: Array<{x: number; y: number}>,
    count: number,
    color: {r: number; g: number; b: number},
    alpha: number
  ): void {
    if (count < 2) return;

    // Build path using the base class smooth path helper
    const buildPath: () => void = (): void => {
      this.buildSmoothPath(ctx, points, count - 1);
    };

    const glowBlur: number = this.getScaledGlowBlur(15);

    // Draw glow layer (restored for visual quality)
    ctx.save();
    ctx.shadowBlur = glowBlur;
    ctx.shadowColor = `rgba(${color.r}, ${color.g}, ${color.b}, ${0.6 * alpha})`;
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${0.3 * alpha})`;
    ctx.lineWidth = this.lineWidth + 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    buildPath();
    ctx.stroke();
    ctx.restore();

    // Draw main waveform
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
    ctx.lineWidth = this.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    buildPath();
    ctx.stroke();

    // Draw highlight
    ctx.strokeStyle = `rgba(${Math.min(255, color.r + 60)}, ${Math.min(255, color.g + 40)}, ${Math.min(255, color.b + 20)}, ${0.5 * alpha})`;
    ctx.lineWidth = 1;
    buildPath();
    ctx.stroke();
  }

  public override destroy(): void {
    this.trailCanvas = null;
    this.trailCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}

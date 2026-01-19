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

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/**
 * Pulsar visualization with curved mirrored waveforms.
 *
 * Renders mirrored curved waveforms that wrap around a central
 * pulsating circle, with smooth color cycling.
 */
export class PulsarVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Pulsar';
  public readonly category: string = 'space';

  private readonly ROTATION_SPEED: number = 0.009;
  private readonly WAVEFORM_ROTATION_SPEED: number = 0.005;
  private readonly FADE_RATE: number = 0.008;
  private readonly ZOOM_SCALE: number = 1.02;
  private readonly HUE_CYCLE_SPEED: number = 0.15;

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
  private readonly dataArray: Uint8Array<ArrayBuffer>;

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
    // Balanced FFT size (was 2048, using 1024 for good detail with better performance)
    this.analyser.fftSize = 1024;
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;

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

    this.sensitivity = 0.35;
  }

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

  private hslToRgb(h: number, s: number, l: number): {r: number; g: number; b: number} {
    h = h % 360;
    const sNorm: number = s * 0.01;
    const lNorm: number = l * 0.01;

    const c: number = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
    const x: number = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m: number = lNorm - c * 0.5;

    let r: number, g: number, b: number;

    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }

    return {
      r: ((r + m) * 255 + 0.5) | 0,
      g: ((g + m) * 255 + 0.5) | 0,
      b: ((b + m) * 255 + 0.5) | 0
    };
  }

  protected override onResize(): void {
    // Pre-compute center values
    this.centerX = this.width * 0.5;
    this.centerY = this.height * 0.5;
    this.halfWidth = this.width * 0.5;
    this.minArcRadius = this.halfWidth * 0.18;
    this.baseCircleRadius = this.halfWidth * 0.18;

    // Create/resize trail canvas (reused each frame - KEY OPTIMIZATION)
    if (!this.trailCanvas) {
      this.trailCanvas = document.createElement('canvas');
      this.trailCtx = this.trailCanvas.getContext('2d', {alpha: true})!;
    }
    this.trailCanvas.width = this.width;
    this.trailCanvas.height = this.height;

    // Create/resize temp canvas (reused each frame - KEY OPTIMIZATION)
    if (!this.tempCanvas) {
      this.tempCanvas = document.createElement('canvas');
      this.tempCtx = this.tempCanvas.getContext('2d', {alpha: true})!;
    }
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

    // Copy current trails to temp canvas (reused, not recreated)
    tempCtx.clearRect(0, 0, width, height);
    tempCtx.drawImage(trailCanvas, 0, 0);

    // Clear trail canvas
    trailCtx.clearRect(0, 0, width, height);

    // Draw back previous trails with rotation, zoom, and fade
    trailCtx.save();
    trailCtx.globalAlpha = 1 - this.FADE_RATE;
    trailCtx.translate(centerX, centerY);
    trailCtx.rotate(this.ROTATION_SPEED);
    trailCtx.scale(this.ZOOM_SCALE, this.ZOOM_SCALE);
    trailCtx.translate(-centerX, -centerY);
    trailCtx.drawImage(tempCanvas, 0, 0);
    trailCtx.restore();

    // Get waveform data
    this.analyser.getByteTimeDomainData(this.dataArray);

    // Update waveform rotation
    this.waveformAngle -= this.WAVEFORM_ROTATION_SPEED;

    // Draw the mirrored waveforms with rotation
    trailCtx.save();
    trailCtx.translate(centerX, centerY);
    trailCtx.rotate(this.waveformAngle);
    trailCtx.translate(-centerX, -centerY);
    this.drawMirroredWaveform(trailCtx);
    trailCtx.restore();

    // Clear main canvas and draw trails
    ctx.clearRect(0, 0, width, height);
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
    const sensitivityFactor: number = this.sensitivity * 2;
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

    const color: {r: number; g: number; b: number} = this.cachedLighterColor;

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
    const sensitivityFactor: number = this.sensitivity * 2;
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
    const len: number = numPoints + 1;

    // Draw glow layer
    ctx.save();
    ctx.shadowBlur = 12;
    ctx.shadowColor = `rgba(${color.r}, ${color.g}, ${color.b}, 0.6)`;
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, 0.3)`;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i: number = 1; i < len; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // Draw main circle
    ctx.strokeStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i: number = 1; i < len; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.stroke();

    // Draw highlight
    ctx.strokeStyle = `rgba(${Math.min(255, color.r + 60)}, ${Math.min(255, color.g + 40)}, ${Math.min(255, color.b + 20)}, 0.5)`;
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i: number = 1; i < len; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
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

    // Draw glow layer (restored for visual quality)
    ctx.save();
    ctx.shadowBlur = 12;
    ctx.shadowColor = `rgba(${color.r}, ${color.g}, ${color.b}, ${0.6 * alpha})`;
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${0.3 * alpha})`;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i: number = 1; i < count; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
    ctx.restore();

    // Draw main waveform
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i: number = 1; i < count; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();

    // Draw highlight
    ctx.strokeStyle = `rgba(${Math.min(255, color.r + 60)}, ${Math.min(255, color.g + 40)}, ${Math.min(255, color.b + 20)}, ${0.5 * alpha})`;
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i: number = 1; i < count; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }

  public override destroy(): void {
    this.trailCanvas = null;
    this.trailCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}

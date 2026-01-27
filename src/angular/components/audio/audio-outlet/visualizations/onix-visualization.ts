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
 * - White inner circle responds to bass frequencies (kick drums, no trail effect)
 * - Rotating trails with zoom and fade effects on outer circle
 * - Optimized with canvas reuse and pre-allocated arrays
 *
 * Performance optimizations:
 * - Reuses trail/temp canvases instead of recreating
 * - Pre-allocated point arrays avoid GC pressure
 * - Pre-computed trigonometric lookup tables for center circle
 *
 * @module app/components/audio/audio-outlet/visualizations/onix-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';
import {ONIX_COLORS_FLAT, ONIX_COLOR_COUNT, TWO_PI} from './visualization-constants';

/**
 * Onix visualization with pulsating gradient circle.
 *
 * Renders a central pulsating circle with ONIXLabs brand color
 * gradient stroke, creating mesmerizing rotating trail effects.
 */
export class OnixVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Onix';
  public readonly category: string = 'Waves';

  private readonly ROTATION_SPEED: number = 0.009;
  private readonly WAVEFORM_ROTATION_SPEED: number = 0.015;
  private readonly FADE_RATE: number = 0.025;
  private readonly ZOOM_SCALE: number = 1.02;
  private readonly FADE_POWER: number = 1.5;

  private readonly CENTER_CIRCLE_POINTS: number = 64;

  // Audio data buffers
  private dataArray: Uint8Array<ArrayBuffer>;
  private frequencyData: Uint8Array<ArrayBuffer>;

  // Trail canvas (reused, not recreated each frame) - THIS IS THE KEY OPTIMIZATION
  private trailCanvas: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;

  // Temp canvas for zoom/rotate effect (reused, not recreated each frame)
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  // Waveform rotation
  private waveformAngle: number = 0;

  // Pre-allocated arrays to avoid GC pressure
  private readonly centerPoints: Array<{x: number; y: number}>;

  // Pre-computed values (updated on resize)
  private centerX: number = 0;
  private centerY: number = 0;
  private baseCircleRadius: number = 0;

  // Pre-computed trigonometric lookup tables for center circle
  private readonly cosTable: Float32Array;
  private readonly sinTable: Float32Array;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;

    const numPoints: number = this.CENTER_CIRCLE_POINTS;

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

    this.sensitivity = 0.35;
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    // Pre-compute center values
    this.centerX = this.width * 0.5;
    this.centerY = this.height * 0.5;
    this.baseCircleRadius = Math.min(this.width, this.height) * 0.30;

    // Create trail canvas if needed
    if (!this.trailCanvas) {
      this.trailCanvas = document.createElement('canvas');
      this.trailCtx = this.trailCanvas.getContext('2d', {alpha: true})!;
    }

    // Create temp canvas if needed
    if (!this.tempCanvas) {
      this.tempCanvas = document.createElement('canvas');
      this.tempCtx = this.tempCanvas.getContext('2d', {alpha: true})!;
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
    // Apply power curve to fade multiplier for more aggressive low-intensity fading
    const baseMultiplier: number = this.getFadeMultiplier();
    const scaledMultiplier: number = Math.pow(baseMultiplier, this.FADE_POWER);
    const effectiveFadeRate: number = this.FADE_RATE * scaledMultiplier;
    trailCtx.save();
    // Use high-quality image smoothing to reduce artifacts from repeated scaling
    trailCtx.imageSmoothingEnabled = true;
    trailCtx.imageSmoothingQuality = 'high';
    trailCtx.globalAlpha = 1 - effectiveFadeRate;
    // Use floor to avoid sub-pixel center point which causes quadrant artifacts
    const floorCenterX: number = Math.floor(centerX);
    const floorCenterY: number = Math.floor(centerY);
    trailCtx.translate(floorCenterX, floorCenterY);
    trailCtx.rotate(this.ROTATION_SPEED);
    trailCtx.scale(this.ZOOM_SCALE, this.ZOOM_SCALE);
    trailCtx.translate(-floorCenterX, -floorCenterY);
    trailCtx.drawImage(tempCanvas, 0, 0);
    trailCtx.restore();

    // Get waveform data
    this.analyser.getByteTimeDomainData(this.dataArray);

    // Get frequency data for bass detection
    this.analyser.getByteFrequencyData(this.frequencyData);

    // Update waveform rotation
    this.waveformAngle -= this.WAVEFORM_ROTATION_SPEED;

    // Draw the center circle with rotation
    trailCtx.save();
    trailCtx.translate(centerX, centerY);
    trailCtx.rotate(this.waveformAngle);
    trailCtx.translate(-centerX, -centerY);
    this.drawCenterCircle(trailCtx);
    trailCtx.restore();

    // Clear main canvas and draw trails
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(trailCanvas, 0, 0);

    // Draw the bass-reactive white circle on main canvas (no trail effect)
    this.drawBassCircle(ctx);

    this.applyFadeOverlay();
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

    const glowBlur: number = this.getScaledGlowBlur(15);

    // Draw glow layer
    ctx.save();
    ctx.shadowBlur = glowBlur;
    ctx.shadowColor = `rgba(${r0}, ${g0}, ${b0}, 0.6)`;
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

    // Apply sensitivity and calculate radius
    // Max radius is 1/3 of the colored waveform radius
    const maxBassRadius: number = this.baseCircleRadius / 3;
    const bassRadius: number = bassIntensity * maxBassRadius * (this.sensitivity * 3);

    // Only draw if there's some bass
    if (bassRadius > 0.5) {
      const centerX: number = this.centerX;
      const centerY: number = this.centerY;

      // Draw solid white circle with black stroke
      ctx.beginPath();
      ctx.arc(centerX, centerY, bassRadius, 0, TWO_PI);
      ctx.fillStyle = 'white';
      ctx.fill();
      ctx.strokeStyle = 'black';
      ctx.lineWidth = this.lineWidth;
      ctx.stroke();
    }
  }

  public override destroy(): void {
    this.trailCanvas = null;
    this.trailCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}

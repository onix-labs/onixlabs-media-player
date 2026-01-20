/**
 * @fileoverview Onix visualization based on the ONIXLabs logo.
 *
 * Creates a visual effect with three concentric filled circles:
 * - Outer circle: Radial spectrum waveform with ONIXLabs brand colors, rotating
 *   with smoky tunnel effect (like flying through a colored smoke ring)
 * - Middle circle: White, static
 * - Inner circle: Black, pulsating with deep bass/kick frequencies
 *
 * Technical details:
 * - Radial waveform on outer ring uses gradient from brand colors
 * - Trail effect creates smoky tunnel appearance (similar to Pulsar)
 * - Sub-bass analysis (20-100Hz) for kick detection on inner circle
 * - Smooth rotation for hypnotic effect
 * - Optimized with pre-computed trig tables and typed arrays
 *
 * @module app/components/audio/audio-outlet/visualizations/onix-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/**
 * Pre-computed constants for performance.
 */
const TWO_PI: number = Math.PI * 2;
const NUM_COLORS: number = 8;

/**
 * Pre-parsed RGB values for the brand colors (flat array for cache efficiency).
 * Format: [r0, g0, b0, r1, g1, b1, ...]
 */
const ONIX_COLORS_FLAT: Uint8Array = new Uint8Array([
  247, 149, 51,   // #F79533 Orange
  243, 112, 85,   // #F37055 Coral
  239, 78, 123,   // #EF4E7B Pink
  161, 102, 171,  // #A166AB Purple
  80, 115, 184,   // #5073B8 Blue
  16, 152, 173,   // #1098AD Teal
  7, 179, 155,    // #07B39B Cyan
  111, 186, 130,  // #6FBA82 Green
]);

/**
 * Onix visualization - ONIXLabs logo inspired audio visualization.
 *
 * Three concentric circles using "bloom" sizing (1x, 2x, 3x multipliers):
 * - Outer ring: Waveform-modulated circumference with brand color gradient
 * - Middle ring: Static white circle
 * - Inner ring: Black circle pulsating with deep bass/kicks
 */
export class OnixVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Onix';
  public readonly category: string = 'Team';

  // Animation speeds
  private readonly ROTATION_SPEED: number = 0.008;
  private readonly TRAIL_ROTATION_SPEED: number = 0.006;
  private readonly FADE_RATE: number = 0.012;
  private readonly ZOOM_SCALE: number = 1.015;

  // Circle sizing using "bloom" multiplier (relative to canvas size)
  // Base unit = 0.07, each ring blooms outward by this amount:
  // - Black ring: bloom 1x = 0.07 radius
  // - White ring: bloom 2x = 0.14 outer edge
  // - Colored ring: bloom 3x = 0.21 outer edge
  private readonly OUTER_RADIUS_RATIO: number = 0.21;
  private readonly MIDDLE_RADIUS_RATIO: number = 0.14;
  private readonly INNER_RADIUS_RATIO: number = 0.07;

  // Waveform settings
  private readonly WAVEFORM_POINTS: number = 360;
  private readonly WAVEFORM_AMPLITUDE: number = 0.08;

  // Pulsation settings for kick/bass response
  private readonly BASS_PULSE_STRENGTH: number = 0.15;
  private readonly BASS_THRESHOLD: number = 0.9; // Only pulsate above this level

  // Audio data buffers
  private waveformData: Uint8Array<ArrayBuffer>;
  private frequencyData: Uint8Array<ArrayBuffer>;

  // Trail canvases (reused for performance)
  private trailCanvas: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  // Animation state
  private rotationAngle: number = 0;

  // Pre-computed values (updated on resize)
  private centerX: number = 0;
  private centerY: number = 0;
  private outerRadius: number = 0;
  private middleRadius: number = 0;
  private innerRadius: number = 0;

  // Pre-allocated point arrays for waveform (flat for cache efficiency)
  private readonly waveformPointsX: Float32Array;
  private readonly waveformPointsY: Float32Array;

  // Pre-computed trigonometric lookup tables
  private readonly cosTable: Float32Array;
  private readonly sinTable: Float32Array;

  // Pre-computed color segment boundaries
  private readonly colorSegmentStart: Uint16Array;
  private readonly colorSegmentEnd: Uint16Array;

  // Smoothed bass value for pulsation
  private smoothedBass: number = 0;
  private readonly SMOOTHING_FACTOR: number = 0.25;

  // Cached bass calculation values (updated when frequency data changes)
  private kickEndBin: number = 4;
  private bassNormalizationFactor: number = 1 / (4 * 255);

  public constructor(config: VisualizationConfig) {
    super(config);
    this.waveformData = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;

    const numPoints: number = this.WAVEFORM_POINTS;

    // Pre-allocate waveform points (flat typed arrays for cache efficiency)
    this.waveformPointsX = new Float32Array(numPoints);
    this.waveformPointsY = new Float32Array(numPoints);

    // Pre-compute trigonometric lookup tables
    this.cosTable = new Float32Array(numPoints);
    this.sinTable = new Float32Array(numPoints);
    for (let i: number = 0; i < numPoints; i++) {
      const angle: number = (i / numPoints) * TWO_PI;
      this.cosTable[i] = Math.cos(angle);
      this.sinTable[i] = Math.sin(angle);
    }

    // Pre-compute color segment boundaries
    this.colorSegmentStart = new Uint16Array(NUM_COLORS);
    this.colorSegmentEnd = new Uint16Array(NUM_COLORS);
    for (let c: number = 0; c < NUM_COLORS; c++) {
      this.colorSegmentStart[c] = (c / NUM_COLORS * numPoints) | 0;
      this.colorSegmentEnd[c] = ((c + 1) / NUM_COLORS * numPoints) | 0;
    }

    this.sensitivity = 0.4;
    this.updateBassCalculationCache();
  }

  protected override onFftSizeChanged(): void {
    this.waveformData = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this.updateBassCalculationCache();
  }

  /**
   * Updates cached values for bass level calculation.
   * Called when frequency bin count changes.
   */
  private updateBassCalculationCache(): void {
    const binCount: number = this.frequencyData.length;
    this.kickEndBin = Math.max(4, (binCount * 0.04) | 0);
    this.bassNormalizationFactor = (this.sensitivity * 2) / (this.kickEndBin * 255);
  }

  protected override onResize(): void {
    // Pre-compute center and radii
    this.centerX = this.width * 0.5;
    this.centerY = this.height * 0.5;
    const minDimension: number = Math.min(this.width, this.height);
    this.outerRadius = minDimension * this.OUTER_RADIUS_RATIO;
    this.middleRadius = minDimension * this.MIDDLE_RADIUS_RATIO;
    this.innerRadius = minDimension * this.INNER_RADIUS_RATIO;

    // Create/resize trail canvas
    if (!this.trailCanvas) {
      this.trailCanvas = document.createElement('canvas');
      this.trailCtx = this.trailCanvas.getContext('2d', {alpha: true})!;
    }
    this.trailCanvas.width = this.width;
    this.trailCanvas.height = this.height;

    // Create/resize temp canvas
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

    // Update rotation
    this.rotationAngle += this.ROTATION_SPEED;

    // Ensure canvases exist
    if (!this.trailCanvas || !this.trailCtx || !this.tempCanvas || !this.tempCtx) {
      this.onResize();
    }

    const trailCtx: CanvasRenderingContext2D = this.trailCtx!;
    const trailCanvas: HTMLCanvasElement = this.trailCanvas!;
    const tempCtx: CanvasRenderingContext2D = this.tempCtx!;
    const tempCanvas: HTMLCanvasElement = this.tempCanvas!;

    // Get audio data
    this.analyser.getByteTimeDomainData(this.waveformData);
    this.analyser.getByteFrequencyData(this.frequencyData);

    // Calculate and smooth bass level for kick detection
    const bassLevel: number = this.calculateBassLevel();
    this.smoothedBass += (bassLevel - this.smoothedBass) * this.SMOOTHING_FACTOR;

    // Copy current trails to temp canvas
    tempCtx.clearRect(0, 0, width, height);
    tempCtx.drawImage(trailCanvas, 0, 0);

    // Clear trail canvas
    trailCtx.clearRect(0, 0, width, height);

    // Apply trail effect with rotation, zoom, and fade
    const effectiveFadeRate: number = this.FADE_RATE * this.getFadeMultiplier();
    trailCtx.save();
    trailCtx.globalAlpha = 1 - effectiveFadeRate;
    trailCtx.translate(centerX, centerY);
    trailCtx.rotate(this.TRAIL_ROTATION_SPEED);
    trailCtx.scale(this.ZOOM_SCALE, this.ZOOM_SCALE);
    trailCtx.translate(-centerX, -centerY);
    trailCtx.drawImage(tempCanvas, 0, 0);
    trailCtx.restore();

    // Draw the outer waveform ring with rotation
    trailCtx.save();
    trailCtx.translate(centerX, centerY);
    trailCtx.rotate(this.rotationAngle);
    trailCtx.translate(-centerX, -centerY);
    this.drawOuterRing(trailCtx);
    trailCtx.restore();

    // Clear main canvas and draw trails
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(trailCanvas, 0, 0);

    // Draw middle (white) and inner (black) circles on top (no trails)
    this.drawMiddleCircle(ctx);
    this.drawInnerCircle(ctx);

    this.applyFadeOverlay();
  }

  /**
   * Calculates the sub-bass/kick level from frequency data.
   * Focuses on very low frequencies (roughly 20-100Hz) for kick drum detection.
   * Uses cached values for performance.
   */
  private calculateBassLevel(): number {
    const freqData: Uint8Array<ArrayBuffer> = this.frequencyData;
    const endBin: number = this.kickEndBin;
    let sum: number = 0;

    for (let i: number = 0; i < endBin; i++) {
      sum += freqData[i];
    }

    return sum * this.bassNormalizationFactor;
  }


  /**
   * Draws the outer ring with waveform-modulated circumference.
   * Uses ONIXLabs brand colors in a radial gradient.
   * Optimized with pre-computed lookup tables and typed arrays.
   */
  private drawOuterRing(ctx: CanvasRenderingContext2D): void {
    const centerX: number = this.centerX;
    const centerY: number = this.centerY;
    const baseRadius: number = this.outerRadius;
    const numPoints: number = this.WAVEFORM_POINTS;
    const waveformData: Uint8Array<ArrayBuffer> = this.waveformData;
    const dataLength: number = waveformData.length;
    const amplitudeScale: number = baseRadius * this.WAVEFORM_AMPLITUDE * this.sensitivity * 2;
    const cosTable: Float32Array = this.cosTable;
    const sinTable: Float32Array = this.sinTable;
    const pointsX: Float32Array = this.waveformPointsX;
    const pointsY: Float32Array = this.waveformPointsY;

    // Calculate waveform points using pre-computed trig tables
    const dataRatio: number = dataLength / numPoints;
    for (let i: number = 0; i < numPoints; i++) {
      const dataIndex: number = (i * dataRatio) | 0; // Fast floor
      const sample: number = (waveformData[dataIndex] - 128) * 0.0078125; // 1/128
      const radius: number = baseRadius + sample * amplitudeScale;
      pointsX[i] = centerX + radius * cosTable[i];
      pointsY[i] = centerY + radius * sinTable[i];
    }

    // Draw filled ring with gradient colors using pre-computed boundaries
    const colors: Uint8Array = ONIX_COLORS_FLAT;

    for (let colorIndex: number = 0; colorIndex < NUM_COLORS; colorIndex++) {
      const startPoint: number = this.colorSegmentStart[colorIndex];
      const endPoint: number = this.colorSegmentEnd[colorIndex];
      const nextColorIndex: number = (colorIndex + 1) % NUM_COLORS;
      const segmentLength: number = endPoint - startPoint;
      const invSegmentLength: number = 1 / segmentLength;

      // Get color components from flat array
      const c1Idx: number = colorIndex * 3;
      const c2Idx: number = nextColorIndex * 3;
      const r1: number = colors[c1Idx];
      const g1: number = colors[c1Idx + 1];
      const b1: number = colors[c1Idx + 2];
      const rDiff: number = colors[c2Idx] - r1;
      const gDiff: number = colors[c2Idx + 1] - g1;
      const bDiff: number = colors[c2Idx + 2] - b1;

      for (let i: number = startPoint; i < endPoint; i++) {
        const nextI: number = i + 1 < numPoints ? i + 1 : 0;
        const t: number = (i - startPoint) * invSegmentLength;

        // Interpolate color (use bitwise OR for fast rounding)
        const r: number = (r1 + rDiff * t) | 0;
        const g: number = (g1 + gDiff * t) | 0;
        const b: number = (b1 + bDiff * t) | 0;

        // Draw triangle from center to two adjacent points
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(pointsX[i], pointsY[i]);
        ctx.lineTo(pointsX[nextI], pointsY[nextI]);
        ctx.closePath();

        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fill();
      }
    }

    // Add white edge stroke
    ctx.beginPath();
    ctx.moveTo(pointsX[0], pointsY[0]);
    for (let i: number = 1; i < numPoints; i++) {
      ctx.lineTo(pointsX[i], pointsY[i]);
    }
    ctx.closePath();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  /**
   * Draws the middle white circle (static, no pulsation).
   */
  private drawMiddleCircle(ctx: CanvasRenderingContext2D): void {
    // Draw white filled circle with subtle glow
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, this.middleRadius, 0, TWO_PI);
    ctx.fillStyle = '#FFFFFF';
    ctx.shadowBlur = 20;
    ctx.shadowColor = 'rgba(255,255,255,0.6)';
    ctx.fill();
    ctx.restore();
  }

  /**
   * Draws the inner black circle that pulsates with deep bass (kicks).
   * Only pulsates when bass exceeds the threshold for a punchy kick response.
   */
  private drawInnerCircle(ctx: CanvasRenderingContext2D): void {
    // Only pulsate if bass exceeds threshold
    const effectiveBass: number = this.smoothedBass > this.BASS_THRESHOLD
      ? (this.smoothedBass - this.BASS_THRESHOLD) / (1 - this.BASS_THRESHOLD)
      : 0;
    const pulseAmount: number = effectiveBass * this.BASS_PULSE_STRENGTH * this.innerRadius;
    const radius: number = this.innerRadius + pulseAmount;

    // Draw black filled circle
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, radius, 0, TWO_PI);
    ctx.fillStyle = '#000000';
    ctx.fill();
  }

  public override destroy(): void {
    this.trailCanvas = null;
    this.trailCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}

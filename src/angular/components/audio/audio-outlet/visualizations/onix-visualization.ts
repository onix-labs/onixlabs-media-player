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
 * - White inner circle responds to bass frequencies (kick drums)
 * - Rotating trails with zoom and fade effects
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
 * Onix visualization with pulsating gradient circle.
 *
 * Renders a central pulsating circle with ONIXLabs brand color
 * gradient stroke, creating mesmerizing rotating trail effects.
 */
export class OnixVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Onix';
  public readonly category: string = 'Team';

  private readonly ROTATION_SPEED: number = 0.009;
  private readonly WAVEFORM_ROTATION_SPEED: number = 0.015;
  private readonly FADE_RATE: number = 0.008;
  private readonly ZOOM_SCALE: number = 1.02;

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

  // Pre-computed color segment boundaries
  private readonly colorSegmentStart: Uint16Array;
  private readonly colorSegmentEnd: Uint16Array;

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

    // Pre-compute color segment boundaries
    this.colorSegmentStart = new Uint16Array(NUM_COLORS);
    this.colorSegmentEnd = new Uint16Array(NUM_COLORS);
    for (let c: number = 0; c < NUM_COLORS; c++) {
      this.colorSegmentStart[c] = (c / NUM_COLORS * numPoints) | 0;
      this.colorSegmentEnd[c] = ((c + 1) / NUM_COLORS * numPoints) | 0;
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
    // Apply trail intensity multiplier to fade rate
    const effectiveFadeRate: number = this.FADE_RATE * this.getFadeMultiplier();
    trailCtx.save();
    trailCtx.globalAlpha = 1 - effectiveFadeRate;
    trailCtx.translate(centerX, centerY);
    trailCtx.rotate(this.ROTATION_SPEED);
    trailCtx.scale(this.ZOOM_SCALE, this.ZOOM_SCALE);
    trailCtx.translate(-centerX, -centerY);
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

    // Draw the bass-reactive white circle (no rotation - stays centered)
    this.drawBassCircle(trailCtx);

    // Clear main canvas and draw trails
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(trailCanvas, 0, 0);

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
    const sensitivityFactor: number = this.sensitivity * 2;
    const amplitudeScale: number = height * 0.08;
    const sampleStep: number = (dataLength * 0.25) / numPoints;
    const cosTable: Float32Array = this.cosTable;
    const sinTable: Float32Array = this.sinTable;

    // Calculate points (reuse pre-allocated array)
    for (let i: number = 0; i < numPoints; i++) {
      const dataIndex: number = ((i * sampleStep) | 0) % dataLength;
      const sample: number = ((dataArray[dataIndex] - 128) / 128) * sensitivityFactor;
      const radius: number = baseRadius + sample * amplitudeScale;

      this.centerPoints[i].x = centerX + radius * cosTable[i];
      this.centerPoints[i].y = centerY + radius * sinTable[i];
    }
    // Close the circle
    this.centerPoints[numPoints] = this.centerPoints[0];

    const points: Array<{x: number; y: number}> = this.centerPoints;
    const colors: Uint8Array = ONIX_COLORS_FLAT;

    // Draw the circular waveform stroke with ONIXLabs brand gradient colors
    // Each segment of the circle gets a different color from the gradient
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

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

        // Draw glow layer for this segment
        ctx.save();
        ctx.shadowBlur = 12;
        ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.6)`;
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.3)`;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(points[i].x, points[i].y);
        ctx.lineTo(points[nextI].x, points[nextI].y);
        ctx.stroke();
        ctx.restore();

        // Draw main stroke for this segment
        ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(points[i].x, points[i].y);
        ctx.lineTo(points[nextI].x, points[nextI].y);
        ctx.stroke();
      }
    }
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
      ctx.lineWidth = 2;
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

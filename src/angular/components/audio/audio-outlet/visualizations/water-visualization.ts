/**
 * @fileoverview Water visualization with reactive rotation.
 *
 * An ambient visualization featuring mirrored curved waveforms over
 * a radial gradient background. The rotation direction changes based
 * on bass transients detected in the audio, creating a reactive feel.
 *
 * Technical details:
 * - Radial gradient background with color bands
 * - Mirrored waveforms with segment coloring
 * - Central circle at the focal point
 * - Bass transient detection for rotation direction changes
 * - HSL color cycling with smooth transitions
 * - Optimized canvas reuse pattern
 *
 * Audio reactivity:
 * - Monitors bass frequencies (first 16 FFT bins)
 * - Detects sudden increases (transients)
 * - Reverses rotation direction on strong transients
 * - Cooldown prevents rapid direction changes
 *
 * @module app/components/audio/audio-outlet/visualizations/water-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/**
 * Water visualization with bass-reactive rotation.
 *
 * Renders curved waveforms over a radial gradient, with rotation
 * direction that changes based on bass transients in the audio.
 */
export class WaterVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Record';
  public readonly category: string = 'Science';

  private readonly ROTATION_SPEED: number = 0.009;
  private readonly FADE_RATE: number = 0.008;
  private readonly BACKGROUND_DARKEN: number = 0.7;
  private readonly HUE_CYCLE_SPEED: number = 0.15;

  // Balanced sample counts for performance
  private readonly WAVEFORM_SAMPLES: number = 256;
  private readonly CENTER_CIRCLE_POINTS: number = 64;

  // Saturation and lightness levels for gradient
  private readonly GRADIENT_LEVELS: ReadonlyArray<{s: number; l: number}> = [
    {s: 70, l: 15},
    {s: 65, l: 25},
    {s: 60, l: 40},
    {s: 55, l: 55},
    {s: 50, l: 70}
  ];

  private dataArray: Uint8Array<ArrayBuffer>;
  private frequencyData: Uint8Array<ArrayBuffer>;

  // Canvases - created once, reused each frame
  private circleCanvas: HTMLCanvasElement | null = null;
  private circleCtx: CanvasRenderingContext2D | null = null;
  private trailCanvas: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  // Hue cycling with caching
  private hueOffset: number = 210;
  private cachedHue: number = -1;
  private cachedGradientColors: Array<{r: number; g: number; b: number}> = [];

  // Bass/mid detection settings
  private readonly BASS_BINS: number = 16;
  private readonly TRANSIENT_THRESHOLD: number = 15;
  private readonly MIN_LEVEL: number = 50;
  private readonly DIRECTION_COOLDOWN: number = 1000;
  private smoothedBass: number = 0;
  private prevBass: number = 0;
  private rotationDirection: number = 1;
  private lastDirectionChange: number = 0;

  // Pre-allocated arrays to avoid GC pressure
  private readonly allPoints: Array<{x: number; y: number}>;
  private readonly centerPoints: Array<{x: number; y: number}>;

  // Pre-computed values (updated on resize)
  private centerX: number = 0;
  private centerY: number = 0;
  private halfWidth: number = 0;
  private minArcRadius: number = 0;
  private baseCircleRadius: number = 0;
  private maxRadius: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;

    // Pre-allocate point arrays (left half + right half = WAVEFORM_SAMPLES * 2)
    this.allPoints = new Array(this.WAVEFORM_SAMPLES * 2);
    this.centerPoints = new Array(this.CENTER_CIRCLE_POINTS + 1);

    for (let i: number = 0; i < this.WAVEFORM_SAMPLES * 2; i++) {
      this.allPoints[i] = {x: 0, y: 0};
    }
    for (let i: number = 0; i <= this.CENTER_CIRCLE_POINTS; i++) {
      this.centerPoints[i] = {x: 0, y: 0};
    }

    this.sensitivity = 0.3;
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  // Cache gradient colors - only recalculate when hue changes by >= 1 degree
  private updateGradientColors(): boolean {
    const hueInt: number = Math.floor(this.hueOffset + this.hueShift);
    if (hueInt === this.cachedHue) return false;

    this.cachedHue = hueInt;
    const shiftedHue: number = this.shiftHue(this.hueOffset);
    this.cachedGradientColors = this.GRADIENT_LEVELS.map(
      (level: {s: number; l: number}): {r: number; g: number; b: number} =>
        this.hslToRgb(shiftedHue, level.s, level.l)
    );
    return true;
  }

  protected override onResize(): void {
    // Pre-compute geometry values
    this.centerX = this.width * 0.5;
    this.centerY = this.height * 0.5;
    this.halfWidth = this.width * 0.5;
    this.minArcRadius = this.halfWidth * 0.12;
    this.baseCircleRadius = this.halfWidth * 0.12;
    this.maxRadius = this.halfWidth;

    // Create/resize circle canvas (reused, re-rendered only when hue changes)
    if (!this.circleCanvas) {
      this.circleCanvas = document.createElement('canvas');
      this.circleCtx = this.circleCanvas.getContext('2d')!;
    }
    this.circleCanvas.width = this.width;
    this.circleCanvas.height = this.height;

    // Create/resize trail canvas (reused each frame)
    if (!this.trailCanvas) {
      this.trailCanvas = document.createElement('canvas');
      this.trailCtx = this.trailCanvas.getContext('2d', {alpha: true})!;
    }
    this.trailCanvas.width = this.width;
    this.trailCanvas.height = this.height;

    // Create/resize temp canvas (reused each frame)
    if (!this.tempCanvas) {
      this.tempCanvas = document.createElement('canvas');
      this.tempCtx = this.tempCanvas.getContext('2d', {alpha: true})!;
    }
    this.tempCanvas.width = this.width;
    this.tempCanvas.height = this.height;

    // Force re-render of background on next frame
    this.cachedHue = -1;

    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  private renderCirclesToCanvas(): void {
    const ctx: CanvasRenderingContext2D = this.circleCtx!;
    const width: number = this.width;
    const height: number = this.height;
    const centerX: number = this.centerX;
    const centerY: number = this.centerY;
    const maxRadius: number = this.maxRadius;
    const gradientColors: Array<{r: number; g: number; b: number}> = this.cachedGradientColors;
    const numColors: number = gradientColors.length;

    ctx.clearRect(0, 0, width, height);

    const totalSegments: number = numColors * 2 - 1;
    const ringPositions: number[] = [1.0, 7/totalSegments, 5/totalSegments, 3/totalSegments, 1/totalSegments, 0];

    const gradient: CanvasGradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, maxRadius);
    const darken: number = this.BACKGROUND_DARKEN;
    const blendZone: number = 0.015;

    // Fill background with a darker shade than the outermost gradient color
    const outerColor: {r: number; g: number; b: number} = gradientColors[0];
    const bgDarken: number = darken * 0.5;
    const outerR: number = (outerColor.r * bgDarken + 0.5) | 0;
    const outerG: number = (outerColor.g * bgDarken + 0.5) | 0;
    const outerB: number = (outerColor.b * bgDarken + 0.5) | 0;
    ctx.fillStyle = `rgb(${outerR},${outerG},${outerB})`;
    ctx.fillRect(0, 0, width, height);

    for (let i: number = numColors - 1; i >= 0; i--) {
      const color: {r: number; g: number; b: number} = gradientColors[i];
      const r: number = (color.r * darken + 0.5) | 0;
      const g: number = (color.g * darken + 0.5) | 0;
      const b: number = (color.b * darken + 0.5) | 0;
      const colorStr: string = `rgb(${r},${g},${b})`;

      const innerPos: number = ringPositions[i + 1];
      const outerPos: number = ringPositions[i];

      gradient.addColorStop(Math.min(1, innerPos + blendZone), colorStr);
      gradient.addColorStop(Math.max(0, outerPos - blendZone), colorStr);
    }

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(centerX, centerY, maxRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;
    const centerX: number = this.centerX;
    const centerY: number = this.centerY;

    // Cycle hue and update cached colors
    this.hueOffset = (this.hueOffset + this.HUE_CYCLE_SPEED) % 360;
    const colorsChanged: boolean = this.updateGradientColors();

    // Ensure canvases exist
    if (!this.circleCanvas || !this.trailCanvas || !this.trailCtx || !this.tempCanvas || !this.tempCtx) {
      this.onResize();
    }

    // Only re-render background when hue actually changes
    if (colorsChanged) {
      this.renderCirclesToCanvas();
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

    // Analyze bass/mid frequencies to detect transients
    this.analyser.getByteFrequencyData(this.frequencyData);
    let bassSum: number = 0;
    for (let i: number = 0; i < this.BASS_BINS; i++) {
      bassSum += this.frequencyData[i];
    }
    const bassAvg: number = bassSum / this.BASS_BINS;

    const bassIncrease: number = bassAvg - this.prevBass;
    this.prevBass = bassAvg;
    this.smoothedBass = this.smoothedBass * 0.5 + bassAvg * 0.5;

    const now: number = performance.now();
    const canChangeDirection: boolean = (now - this.lastDirectionChange) > this.DIRECTION_COOLDOWN;
    const isTransient: boolean = bassIncrease > this.TRANSIENT_THRESHOLD && bassAvg > this.MIN_LEVEL;

    if (isTransient && canChangeDirection) {
      this.rotationDirection *= -1;
      this.lastDirectionChange = now;
    }

    // Draw back previous trails with rotation and fade
    // Apply trail intensity multiplier to fade rate
    const effectiveFadeRate: number = this.FADE_RATE * this.getFadeMultiplier();
    trailCtx.save();
    trailCtx.globalAlpha = 1 - effectiveFadeRate;
    trailCtx.translate(centerX, centerY);
    trailCtx.rotate(this.ROTATION_SPEED * this.rotationDirection);
    trailCtx.translate(-centerX, -centerY);
    trailCtx.drawImage(tempCanvas, 0, 0);
    trailCtx.restore();

    // Get waveform data
    this.analyser.getByteTimeDomainData(this.dataArray);

    // Draw the mirrored waveforms
    this.drawMirroredWaveform(trailCtx, centerX, centerY);

    // Composite - circles background, then trails on top
    ctx.drawImage(this.circleCanvas!, 0, 0);
    ctx.drawImage(trailCanvas, 0, 0);

    this.applyFadeOverlay();
  }

  private drawMirroredWaveform(ctx: CanvasRenderingContext2D, centerX: number, centerY: number): void {
    const width: number = this.width;
    const height: number = this.height;
    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;
    const dataLength: number = dataArray.length;
    const gradientColors: Array<{r: number; g: number; b: number}> = this.cachedGradientColors;
    const numColors: number = gradientColors.length;

    const halfWidth: number = this.halfWidth;
    const minArcRadius: number = this.minArcRadius;
    const samplesPerHalf: number = this.WAVEFORM_SAMPLES;
    const bendStrength: number = 1.2;
    const sensitivityFactor: number = this.sensitivity * 2;
    const amplitudeScale: number = height * 0.3;

    // Calculate downsampling step
    const sampleStep: number = (dataLength * 0.5) / samplesPerHalf;

    // Left half points (from left edge to center) - reuse pre-allocated array
    for (let i: number = 0; i < samplesPerHalf; i++) {
      const dataIndex: number = (i * sampleStep) | 0;
      const sample: number = ((dataArray[dataIndex] - 128) / 128) * sensitivityFactor;
      const amplitude: number = sample * amplitudeScale;
      const t: number = i / (samplesPerHalf - 1);
      const baseX: number = t * halfWidth;

      const distFromCenter: number = centerX - baseX;
      const arcRadius: number = distFromCenter > minArcRadius ? distFromCenter : minArcRadius;
      const arcAngle: number = (amplitude * bendStrength) / arcRadius;
      const newAngle: number = Math.PI - arcAngle;

      this.allPoints[i].x = centerX + arcRadius * Math.cos(newAngle);
      this.allPoints[i].y = centerY + arcRadius * Math.sin(newAngle);
    }

    // Right half points (mirrored, from center to right edge)
    for (let i: number = samplesPerHalf - 1; i >= 0; i--) {
      const dataIndex: number = (i * sampleStep) | 0;
      const sample: number = ((dataArray[dataIndex] - 128) / 128) * sensitivityFactor;
      const amplitude: number = sample * amplitudeScale;
      const t: number = i / (samplesPerHalf - 1);
      const baseX: number = width - t * halfWidth;

      const distFromCenter: number = baseX - centerX;
      const arcRadius: number = distFromCenter > minArcRadius ? distFromCenter : minArcRadius;
      const arcAngle: number = (amplitude * bendStrength) / arcRadius;

      const pointIndex: number = samplesPerHalf + (samplesPerHalf - 1 - i);
      this.allPoints[pointIndex].x = centerX + arcRadius * Math.cos(arcAngle);
      this.allPoints[pointIndex].y = centerY + arcRadius * Math.sin(arcAngle);
    }

    // Total segments: 9 (pattern: 0-1-2-3-4-3-2-1-0)
    const totalSegments: number = numColors * 2 - 1;
    const totalPoints: number = samplesPerHalf * 2;
    const pointsPerSegment: number = Math.floor(totalPoints / totalSegments);
    const centerSegmentIndex: number = numColors - 1;

    // Draw each segment with its color, but skip the center segment
    for (let seg: number = 0; seg < totalSegments; seg++) {
      if (seg === centerSegmentIndex) continue;

      // Determine color index: 0,1,2,3,4,3,2,1,0
      let colorIndex: number;
      if (seg < numColors) {
        colorIndex = seg;
      } else {
        colorIndex = totalSegments - 1 - seg;
      }

      const color: {r: number; g: number; b: number} = gradientColors[colorIndex];
      const startIdx: number = seg * pointsPerSegment;
      const endIdx: number = seg === totalSegments - 1 ? totalPoints : (seg + 1) * pointsPerSegment + 1;

      if (endIdx - startIdx >= 2) {
        this.drawWaveformSegment(ctx, startIdx, Math.min(endIdx, totalPoints), color);
      }
    }

    // Draw circular waveform at center using the brightest color
    this.drawCenterCircle(ctx, centerX, centerY, halfWidth * 0.12, gradientColors[numColors - 1]);
  }

  private drawCenterCircle(
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    baseRadius: number,
    color: {r: number; g: number; b: number}
  ): void {
    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;
    const dataLength: number = dataArray.length;
    const height: number = this.height;
    const numPoints: number = this.CENTER_CIRCLE_POINTS;
    const sensitivityFactor: number = this.sensitivity * 2;
    const amplitudeScale: number = height * 0.08;
    const sampleStep: number = (dataLength * 0.25) / numPoints;

    for (let i: number = 0; i <= numPoints; i++) {
      const angle: number = (i / numPoints) * Math.PI * 2;
      const sampleIndex: number = ((i * sampleStep) | 0) % dataLength;
      const sample: number = ((dataArray[sampleIndex] - 128) / 128) * sensitivityFactor;
      const amplitude: number = sample * amplitudeScale;
      const radius: number = baseRadius + amplitude;

      this.centerPoints[i].x = centerX + radius * Math.cos(angle);
      this.centerPoints[i].y = centerY + radius * Math.sin(angle);
    }

    const points: Array<{x: number; y: number}> = this.centerPoints;
    const len: number = numPoints + 1;
    const mainColor: string = `rgb(${color.r}, ${color.g}, ${color.b})`;
    const glowColor: string = `rgba(${color.r}, ${color.g}, ${color.b}, 0.6)`;
    const highlightColor: string = `rgba(${Math.min(255, color.r + 60)}, ${Math.min(255, color.g + 40)}, ${Math.min(255, color.b + 20)}, 0.3)`;

    const buildPath: () => void = (): void => {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i: number = 1; i < len; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
    };

    // Glow layer (filled)
    ctx.save();
    ctx.shadowBlur = 12;
    ctx.shadowColor = glowColor;
    ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, 0.3)`;
    buildPath();
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Main filled circle
    ctx.fillStyle = mainColor;
    buildPath();
    ctx.closePath();
    ctx.fill();

    // Highlight overlay
    ctx.fillStyle = highlightColor;
    buildPath();
    ctx.closePath();
    ctx.fill();
  }

  private drawWaveformSegment(
    ctx: CanvasRenderingContext2D,
    startIdx: number,
    endIdx: number,
    color: {r: number; g: number; b: number}
  ): void {
    const points: Array<{x: number; y: number}> = this.allPoints;
    const mainColor: string = `rgb(${color.r}, ${color.g}, ${color.b})`;
    const glowColor: string = `rgba(${color.r}, ${color.g}, ${color.b}, 0.6)`;
    const highlightColor: string = `rgba(${Math.min(255, color.r + 60)}, ${Math.min(255, color.g + 40)}, ${Math.min(255, color.b + 20)}, 0.5)`;

    const buildPath: () => void = (): void => {
      ctx.beginPath();
      ctx.moveTo(points[startIdx].x, points[startIdx].y);
      for (let i: number = startIdx + 1; i < endIdx; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
    };

    // Glow layer
    ctx.save();
    ctx.shadowBlur = 12;
    ctx.shadowColor = glowColor;
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, 0.3)`;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    buildPath();
    ctx.stroke();
    ctx.restore();

    // Main waveform
    ctx.strokeStyle = mainColor;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    buildPath();
    ctx.stroke();

    // Highlight
    ctx.strokeStyle = highlightColor;
    ctx.lineWidth = 1;
    buildPath();
    ctx.stroke();
  }

  public override destroy(): void {
    this.circleCanvas = null;
    this.circleCtx = null;
    this.trailCanvas = null;
    this.trailCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}

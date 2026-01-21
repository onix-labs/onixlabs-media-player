/**
 * @fileoverview Infinity visualization with dual circular waveforms.
 *
 * Creates a hypnotic effect with two circular waveforms (blue and green)
 * that orbit around each other like binary black holes. Each circle fades
 * outward from the center, creating spiral trails.
 *
 * Technical details:
 * - Two small circular waveforms orbiting the center
 * - Circles positioned 180 degrees apart on the orbit
 * - Trails fade outward from center, filling the screen
 * - Vivid blue and green color scheme
 * - Each waveform has glow, main, and highlight layers
 *
 * @module app/components/audio/audio-outlet/visualizations/infinity-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/**
 * Infinity visualization with dual circular waveforms fading in opposite directions.
 *
 * Renders two circular waveforms (blue and green) side by side, with trails
 * that extend outward from the center.
 */
export class InfinityVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Infinity';
  public readonly category: string = 'Waves';

  private readonly FADE_RATE: number = 0.025;
  private readonly ZOOM_SCALE: number = 1.03;
  private readonly BASE_GLOW_BLUR: number = 15;
  private readonly CIRCLE_POINTS: number = 96;
  private readonly ORBIT_SPEED: number = 0.012;
  private readonly HUE_CYCLE_SPEED: number = 0.5;

  /** Current hue values for each circle (0-360) */
  private hue1: number = 240;  // Start at blue
  private hue2: number = 120;  // Start at green (180 degrees apart)

  /** Cached color values to avoid recalculation every frame */
  private cachedColor1: {main: string; glow: string} | null = null;
  private cachedColor2: {main: string; glow: string} | null = null;
  private cachedHue1: number = -1;
  private cachedHue2: number = -1;
  private cachedHueShift: number = -1;

  private dataArray: Uint8Array<ArrayBuffer>;

  /** Trail canvases for each circle */
  private leftTrailCanvas: HTMLCanvasElement | null = null;
  private leftTrailCtx: CanvasRenderingContext2D | null = null;
  private rightTrailCanvas: HTMLCanvasElement | null = null;
  private rightTrailCtx: CanvasRenderingContext2D | null = null;

  /** Temp canvas for zoom effect */
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  /** Pre-allocated point arrays for circles */
  private readonly leftPoints: Array<{x: number; y: number}>;
  private readonly rightPoints: Array<{x: number; y: number}>;

  /** Screen center and radii */
  private screenCenterX: number = 0;
  private screenCenterY: number = 0;
  private orbitRadius: number = 0;
  private baseRadius: number = 0;

  /** Current orbit angle */
  private orbitAngle: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.sensitivity = 1;

    // Pre-allocate point arrays
    this.leftPoints = [];
    this.rightPoints = [];
    for (let i: number = 0; i <= this.CIRCLE_POINTS; i++) {
      this.leftPoints.push({x: 0, y: 0});
      this.rightPoints.push({x: 0, y: 0});
    }
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    const width: number = this.width;
    const height: number = this.height;

    // Screen center
    this.screenCenterX = width / 2;
    this.screenCenterY = height / 2;

    // Circle size - larger for more visual impact
    this.baseRadius = Math.min(width, height) * 0.18;

    // Orbit radius - distance from center to each circle
    // Set to base radius plus half the line width so circles are separated by the stroke width
    this.orbitRadius = this.baseRadius + this.lineWidth;

    // Create/resize trail canvases
    if (!this.leftTrailCanvas) {
      this.leftTrailCanvas = document.createElement('canvas');
      this.leftTrailCtx = this.leftTrailCanvas.getContext('2d', {alpha: true})!;
    }
    this.leftTrailCanvas.width = width;
    this.leftTrailCanvas.height = height;

    if (!this.rightTrailCanvas) {
      this.rightTrailCanvas = document.createElement('canvas');
      this.rightTrailCtx = this.rightTrailCanvas.getContext('2d', {alpha: true})!;
    }
    this.rightTrailCanvas.width = width;
    this.rightTrailCanvas.height = height;

    if (!this.tempCanvas) {
      this.tempCanvas = document.createElement('canvas');
      this.tempCtx = this.tempCanvas.getContext('2d', {alpha: true})!;
    }
    this.tempCanvas.width = width;
    this.tempCanvas.height = height;

    this.ctx.clearRect(0, 0, width, height);
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;

    if (width <= 0 || height <= 0) return;

    // Ensure canvases exist
    if (!this.leftTrailCanvas || !this.rightTrailCanvas || !this.tempCanvas) {
      this.onResize();
    }

    // Get time domain data
    this.analyser.getByteTimeDomainData(this.dataArray);

    // Update orbit angle
    this.orbitAngle += this.ORBIT_SPEED;

    // Cycle hues through the spectrum
    this.hue1 = (this.hue1 + this.HUE_CYCLE_SPEED) % 360;
    this.hue2 = (this.hue2 + this.HUE_CYCLE_SPEED) % 360;

    // Get current colors (cached with hue shift)
    const color1: {main: string; glow: string} = this.getCachedColor(1, this.hue1);
    const color2: {main: string; glow: string} = this.getCachedColor(2, this.hue2);

    // Calculate current circle positions (180 degrees apart on orbit)
    const circle1X: number = this.screenCenterX + this.orbitRadius * Math.cos(this.orbitAngle);
    const circle1Y: number = this.screenCenterY + this.orbitRadius * Math.sin(this.orbitAngle);
    const circle2X: number = this.screenCenterX + this.orbitRadius * Math.cos(this.orbitAngle + Math.PI);
    const circle2Y: number = this.screenCenterY + this.orbitRadius * Math.sin(this.orbitAngle + Math.PI);

    const amplitudeScale: number = this.baseRadius * 0.4;

    // Process first circle (trails expand outward from center)
    this.applyDirectionalZoom(
      this.leftTrailCanvas!, this.leftTrailCtx!,
      this.screenCenterX, this.screenCenterY
    );
    this.calculateCirclePoints(this.leftPoints, circle1X, circle1Y, amplitudeScale, 0);
    this.drawCircleWaveform(this.leftTrailCtx!, this.leftPoints, color1.main, color1.glow);

    // Process second circle (trails expand outward from center)
    this.applyDirectionalZoom(
      this.rightTrailCanvas!, this.rightTrailCtx!,
      this.screenCenterX, this.screenCenterY
    );
    this.calculateCirclePoints(this.rightPoints, circle2X, circle2Y, amplitudeScale, this.CIRCLE_POINTS / 2);
    this.drawCircleWaveform(this.rightTrailCtx!, this.rightPoints, color2.main, color2.glow);

    // Composite both trail canvases to main canvas with additive blending
    // This makes overlapping trails mix together rather than one covering the other
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.leftTrailCanvas!, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.rightTrailCanvas!, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    this.applyFadeOverlay();
  }

  private applyDirectionalZoom(
    trailCanvas: HTMLCanvasElement,
    trailCtx: CanvasRenderingContext2D,
    zoomCenterX: number,
    zoomCenterY: number
  ): void {
    const tempCtx: CanvasRenderingContext2D = this.tempCtx!;
    const tempCanvas: HTMLCanvasElement = this.tempCanvas!;
    const width: number = this.width;
    const height: number = this.height;

    // Copy current trails to temp canvas
    tempCtx.clearRect(0, 0, width, height);
    tempCtx.drawImage(trailCanvas, 0, 0);

    // Clear trail canvas
    trailCtx.clearRect(0, 0, width, height);

    // Draw back scaled from the specified zoom center with fade
    // Apply trail intensity multiplier to fade rate
    const effectiveFadeRate: number = this.FADE_RATE * this.getFadeMultiplier();
    trailCtx.save();
    trailCtx.globalAlpha = 1 - effectiveFadeRate;
    trailCtx.translate(zoomCenterX, zoomCenterY);
    trailCtx.scale(this.ZOOM_SCALE, this.ZOOM_SCALE);
    trailCtx.translate(-zoomCenterX, -zoomCenterY);
    trailCtx.drawImage(tempCanvas, 0, 0);
    trailCtx.restore();
  }

  private calculateCirclePoints(
    points: Array<{x: number; y: number}>,
    centerX: number,
    centerY: number,
    amplitudeScale: number,
    dataOffset: number
  ): void {
    const numPoints: number = this.CIRCLE_POINTS;
    const dataLength: number = this.dataArray.length;

    for (let i: number = 0; i <= numPoints; i++) {
      const angle: number = (i / numPoints) * Math.PI * 2 - Math.PI / 2;

      // Map point to data index with offset for variation between circles
      const dataIndex: number = Math.floor(((i + dataOffset) % numPoints) / numPoints * dataLength);
      const sample: number = ((this.dataArray[dataIndex] - 128) / 128) * (this.sensitivity * 2);

      const radius: number = this.baseRadius + sample * amplitudeScale;

      points[i].x = centerX + radius * Math.cos(angle);
      points[i].y = centerY + radius * Math.sin(angle);
    }
  }

  private drawCircleWaveform(
    ctx: CanvasRenderingContext2D,
    points: Array<{x: number; y: number}>,
    color: string,
    glowColor: string
  ): void {
    // Use the base class helper with the pre-calculated points
    // Note: We need to use the passed ctx, not this.ctx, since this draws to trail canvases
    const numPoints: number = this.CIRCLE_POINTS;

    const buildPath: () => void = (): void => {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i: number = 1; i <= numPoints; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
    };

    // Reduce glow color opacity for the stroke
    const glowStrokeColor: string = glowColor.replace(/[\d.]+\)$/, (match: string): string => {
      const opacity: number = parseFloat(match) * 0.375;
      return opacity.toFixed(2) + ')';
    });

    // Glow layer
    ctx.save();
    ctx.shadowBlur = this.getScaledGlowBlur(this.BASE_GLOW_BLUR);
    ctx.shadowColor = glowColor;
    ctx.strokeStyle = glowStrokeColor;
    ctx.lineWidth = this.lineWidth + 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    buildPath();
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // Main line
    ctx.strokeStyle = color;
    ctx.lineWidth = this.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    buildPath();
    ctx.closePath();
    ctx.stroke();

    // Highlight
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    buildPath();
    ctx.closePath();
    ctx.stroke();
  }

  /**
   * Gets color strings for a given hue, with caching.
   * Invalidates cache when hue changes by more than 1 degree or hueShift changes.
   */
  private getCachedColor(colorIndex: 1 | 2, hue: number): {main: string; glow: string} {
    const cachedHue: number = colorIndex === 1 ? this.cachedHue1 : this.cachedHue2;
    const cachedColor: {main: string; glow: string} | null = colorIndex === 1 ? this.cachedColor1 : this.cachedColor2;

    // Check if cache is valid (hue within 1 degree and hueShift unchanged)
    if (cachedColor && Math.abs(hue - cachedHue) < 1 && this.cachedHueShift === this.hueShift) {
      return cachedColor;
    }

    // Calculate new color
    const newColor: {main: string; glow: string} = this.getColorFromHue(this.shiftHue(hue));

    // Update cache
    if (colorIndex === 1) {
      this.cachedColor1 = newColor;
      this.cachedHue1 = hue;
    } else {
      this.cachedColor2 = newColor;
      this.cachedHue2 = hue;
    }
    this.cachedHueShift = this.hueShift;

    return newColor;
  }

  /**
   * Gets color strings for a given hue.
   */
  private getColorFromHue(hue: number): {main: string; glow: string} {
    const rgb: {r: number; g: number; b: number} = this.hslToRgb(hue, 100, 50);
    return {
      main: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
      glow: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.8)`
    };
  }

  public override destroy(): void {
    this.leftTrailCanvas = null;
    this.leftTrailCtx = null;
    this.rightTrailCanvas = null;
    this.rightTrailCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}

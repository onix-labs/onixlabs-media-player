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

    // Create trail canvases if needed
    if (!this.leftTrailCanvas) {
      ({canvas: this.leftTrailCanvas, ctx: this.leftTrailCtx} = this.createOffscreenCanvas());
    }

    if (!this.rightTrailCanvas) {
      ({canvas: this.rightTrailCanvas, ctx: this.rightTrailCtx} = this.createOffscreenCanvas());
    }

    if (!this.tempCanvas) {
      ({canvas: this.tempCanvas, ctx: this.tempCtx} = this.createOffscreenCanvas());
    }

    // Resize canvases while preserving trail content
    this.resizeCanvasPreserving(this.leftTrailCanvas, this.leftTrailCtx!, width, height);
    this.resizeCanvasPreserving(this.rightTrailCanvas, this.rightTrailCtx!, width, height);
    // Temp canvas doesn't need content preserved (it's just working space)
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
      this.tempCanvas!, this.tempCtx!,
      this.screenCenterX, this.screenCenterY,
      this.FADE_RATE, this.ZOOM_SCALE
    );
    this.calculateCirclePoints(this.leftPoints, circle1X, circle1Y, amplitudeScale, 0);
    this.drawPathWithLayers(
      (): void => { this.buildSmoothPath(this.leftTrailCtx!, this.leftPoints, this.CIRCLE_POINTS); },
      color1.main, color1.glow, 'rgba(255, 255, 255, 0.5)',
      {ctx: this.leftTrailCtx!, baseGlowBlur: this.BASE_GLOW_BLUR, closePath: true}
    );

    // Process second circle (trails expand outward from center)
    this.applyDirectionalZoom(
      this.rightTrailCanvas!, this.rightTrailCtx!,
      this.tempCanvas!, this.tempCtx!,
      this.screenCenterX, this.screenCenterY,
      this.FADE_RATE, this.ZOOM_SCALE
    );
    this.calculateCirclePoints(this.rightPoints, circle2X, circle2Y, amplitudeScale, this.CIRCLE_POINTS / 2);
    this.drawPathWithLayers(
      (): void => { this.buildSmoothPath(this.rightTrailCtx!, this.rightPoints, this.CIRCLE_POINTS); },
      color2.main, color2.glow, 'rgba(255, 255, 255, 0.5)',
      {ctx: this.rightTrailCtx!, baseGlowBlur: this.BASE_GLOW_BLUR, closePath: true}
    );

    // Composite both trail canvases to main canvas with additive blending
    // This makes overlapping trails mix together rather than one covering the other
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.leftTrailCanvas!, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.rightTrailCanvas!, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    this.applyFadeOverlay();
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
      const sample: number = ((this.dataArray[dataIndex] - 128) / 128) * this.sensitivityFactor;

      const radius: number = this.baseRadius + sample * amplitudeScale;

      points[i].x = centerX + radius * Math.cos(angle);
      points[i].y = centerY + radius * Math.sin(angle);
    }
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

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

import {Canvas2DVisualization, OffscreenCanvasPair, VisualizationConfig} from './visualization';

/**
 * Infinity visualization with dual circular waveforms fading in opposite directions.
 *
 * Renders two circular waveforms (blue and green) side by side, with trails
 * that extend outward from the center.
 */
export class InfinityVisualization extends Canvas2DVisualization {
  /** Per-frame trail fade rate. */
  private static readonly FADE_RATE: number = 0.025;

  /** Per-frame outward zoom applied to the trails. */
  private static readonly ZOOM_SCALE: number = 1.03;

  /** Base glow blur radius in pixels. */
  private static readonly BASE_GLOW_BLUR: number = 15;

  /** Number of points sampled around each circle. */
  private static readonly CIRCLE_POINTS: number = 96;

  /** Radians the orbit advances per frame. */
  private static readonly ORBIT_SPEED: number = 0.012;

  /** Degrees the hue advances per frame. */
  private static readonly HUE_CYCLE_SPEED: number = 0.5;

  /** Initial hue for the first circle (blue). */
  private static readonly START_HUE_1: number = 240;

  /** Initial hue for the second circle (green, 120 degrees away). */
  private static readonly START_HUE_2: number = 120;

  /** Highlight stroke color shared by both circles. */
  private static readonly COLOR_HIGHLIGHT: string = 'rgba(255, 255, 255, 0.5)';

  public readonly name: string = 'Infinity';
  public readonly category: string = 'Bars & Waves';

  /** Current hue values for each circle (0-360). */
  private hue1: number = InfinityVisualization.START_HUE_1;
  private hue2: number = InfinityVisualization.START_HUE_2;

  private dataArray: Uint8Array<ArrayBuffer>;

  /** Trail canvases for each circle. */
  private leftTrailCanvas: HTMLCanvasElement | null = null;
  private leftTrailCtx: CanvasRenderingContext2D | null = null;
  private rightTrailCanvas: HTMLCanvasElement | null = null;
  private rightTrailCtx: CanvasRenderingContext2D | null = null;

  /** Temp canvas for the zoom effect. */
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  /** Pre-allocated point arrays for the circles. */
  private readonly leftPoints: Array<{x: number; y: number}>;
  private readonly rightPoints: Array<{x: number; y: number}>;

  /** Screen center and radii (recomputed on resize). */
  private screenCenterX: number = 0;
  private screenCenterY: number = 0;
  private orbitRadius: number = 0;
  private baseRadius: number = 0;

  /** Current orbit angle. */
  private orbitAngle: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    // Hard-coded look; the setters below are no-ops so the (removed) controls can't change these.
    this.sensitivity = 0.25;      // 25%
    this.trailIntensity = 0.5;    // 50%
    this.lineWidth = 1;           // 1px
    this.glowIntensity = 1;       // 100%
    this.waveformSmoothing = 1;   // 100%

    // Pre-allocate point arrays
    this.leftPoints = [];
    this.rightPoints = [];
    for (let i: number = 0; i <= InfinityVisualization.CIRCLE_POINTS; i++) {
      this.leftPoints.push({x: 0, y: 0});
      this.rightPoints.push({x: 0, y: 0});
    }
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
    this.orbitAngle += InfinityVisualization.ORBIT_SPEED;

    // Cycle hues through the spectrum
    this.hue1 = (this.hue1 + InfinityVisualization.HUE_CYCLE_SPEED) % 360;
    this.hue2 = (this.hue2 + InfinityVisualization.HUE_CYCLE_SPEED) % 360;

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
      InfinityVisualization.FADE_RATE, InfinityVisualization.ZOOM_SCALE
    );
    this.calculateCirclePoints(this.leftPoints, circle1X, circle1Y, amplitudeScale, 0);
    this.drawPathWithLayers(
      (): void => { this.buildSmoothPath(this.leftTrailCtx!, this.leftPoints, InfinityVisualization.CIRCLE_POINTS); },
      color1.main, color1.glow, InfinityVisualization.COLOR_HIGHLIGHT,
      {ctx: this.leftTrailCtx!, baseGlowBlur: InfinityVisualization.BASE_GLOW_BLUR, closePath: true}
    );

    // Process second circle (trails expand outward from center)
    this.applyDirectionalZoom(
      this.rightTrailCanvas!, this.rightTrailCtx!,
      this.tempCanvas!, this.tempCtx!,
      this.screenCenterX, this.screenCenterY,
      InfinityVisualization.FADE_RATE, InfinityVisualization.ZOOM_SCALE
    );
    this.calculateCirclePoints(this.rightPoints, circle2X, circle2Y, amplitudeScale, InfinityVisualization.CIRCLE_POINTS / 2);
    this.drawPathWithLayers(
      (): void => { this.buildSmoothPath(this.rightTrailCtx!, this.rightPoints, InfinityVisualization.CIRCLE_POINTS); },
      color2.main, color2.glow, InfinityVisualization.COLOR_HIGHLIGHT,
      {ctx: this.rightTrailCtx!, baseGlowBlur: InfinityVisualization.BASE_GLOW_BLUR, closePath: true}
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

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  // Fixed visual parameters: ignore the global controls (values set in constructor).
  public override setSensitivity(): void { /* fixed */ }
  public override setTrailIntensity(): void { /* fixed */ }
  public override setLineWidth(): void { /* fixed */ }
  public override setGlowIntensity(): void { /* fixed */ }
  public override setWaveformSmoothing(): void { /* fixed */ }

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
      const leftTrail: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.leftTrailCanvas = leftTrail.canvas;
      this.leftTrailCtx = leftTrail.ctx;
    }

    if (!this.rightTrailCanvas) {
      const rightTrail: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.rightTrailCanvas = rightTrail.canvas;
      this.rightTrailCtx = rightTrail.ctx;
    }

    if (!this.tempCanvas) {
      const temp: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.tempCanvas = temp.canvas;
      this.tempCtx = temp.ctx;
    }

    // Resize canvases while preserving trail content
    this.resizeCanvasPreserving(this.leftTrailCanvas, this.leftTrailCtx!, width, height);
    this.resizeCanvasPreserving(this.rightTrailCanvas, this.rightTrailCtx!, width, height);
    // Temp canvas doesn't need content preserved (it's just working space)
    this.tempCanvas.width = width;
    this.tempCanvas.height = height;

    this.ctx.clearRect(0, 0, width, height);
  }

  private calculateCirclePoints(
    points: Array<{x: number; y: number}>,
    centerX: number,
    centerY: number,
    amplitudeScale: number,
    dataOffset: number
  ): void {
    const numPoints: number = InfinityVisualization.CIRCLE_POINTS;
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

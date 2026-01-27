/**
 * @fileoverview Plasma visualization with dual horizontal waveforms.
 *
 * Creates a hypnotic effect with two horizontal waveforms that fade
 * outward from the center, creating expanding trail effects.
 *
 * Technical details:
 * - Two horizontal waveforms at 45% and 55% vertical positions
 * - Trails fade outward from center with zoom effect
 * - Colors cycle through the spectrum
 * - Each waveform has glow, main, and highlight layers
 *
 * @module app/components/audio/audio-outlet/visualizations/plasma-visualization
 */

import {Canvas2DVisualization, OffscreenCanvasPair, VisualizationConfig} from './visualization';

/**
 * Plasma visualization with dual horizontal waveforms.
 *
 * Renders two horizontal waveforms with trails that expand outward
 * from the center, creating a tunnel-like effect.
 */
export class PlasmaVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Plasma';
  public readonly category: string = 'Waves';

  private readonly FADE_RATE: number = 0.025;
  private readonly ZOOM_SCALE: number = 1.02;
  private readonly BASE_GLOW_BLUR: number = 15;
  private readonly WAVEFORM_POINTS: number = 128;
  private readonly HUE_CYCLE_SPEED: number = 0.5;

  /** Current hue values for each waveform (0-360) */
  private hue1: number = 240;  // Start at blue
  private hue2: number = 120;  // Start at green (180 degrees apart)

  private dataArray: Uint8Array<ArrayBuffer>;

  /** Trail canvases for each waveform */
  private topTrailCanvas: HTMLCanvasElement | null = null;
  private topTrailCtx: CanvasRenderingContext2D | null = null;
  private bottomTrailCanvas: HTMLCanvasElement | null = null;
  private bottomTrailCtx: CanvasRenderingContext2D | null = null;

  /** Temp canvas for zoom effect */
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  /** Pre-allocated point arrays for waveforms */
  private readonly topPoints: Array<{x: number; y: number}>;
  private readonly bottomPoints: Array<{x: number; y: number}>;

  /** Layout values */
  private screenCenterX: number = 0;
  private screenCenterY: number = 0;
  private topCenterY: number = 0;
  private bottomCenterY: number = 0;
  private waveformAmplitude: number = 0;
  private sliceWidth: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.sensitivity = 1;

    // Pre-allocate point arrays
    this.topPoints = [];
    this.bottomPoints = [];
    for (let i: number = 0; i <= this.WAVEFORM_POINTS; i++) {
      this.topPoints.push({x: 0, y: 0});
      this.bottomPoints.push({x: 0, y: 0});
    }
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    const width: number = this.width;
    const height: number = this.height;

    // Screen center for zoom effect
    this.screenCenterX = width / 2;
    this.screenCenterY = height / 2;

    // Waveform vertical positions (45% and 55% down)
    this.topCenterY = height * 0.45;
    this.bottomCenterY = height * 0.55;

    // Amplitude for waveform displacement
    this.waveformAmplitude = height * 0.15;

    // Width per point
    this.sliceWidth = width / this.WAVEFORM_POINTS;

    // Create trail canvases if needed
    if (!this.topTrailCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.topTrailCanvas = offscreen.canvas;
      this.topTrailCtx = offscreen.ctx;
    }

    if (!this.bottomTrailCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.bottomTrailCanvas = offscreen.canvas;
      this.bottomTrailCtx = offscreen.ctx;
    }

    if (!this.tempCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.tempCanvas = offscreen.canvas;
      this.tempCtx = offscreen.ctx;
    }

    // Resize canvases while preserving trail content
    this.resizeCanvasPreserving(this.topTrailCanvas, this.topTrailCtx!, width, height);
    this.resizeCanvasPreserving(this.bottomTrailCanvas, this.bottomTrailCtx!, width, height);
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
    if (!this.topTrailCanvas || !this.bottomTrailCanvas || !this.tempCanvas) {
      this.onResize();
    }

    // Get time domain data
    this.analyser.getByteTimeDomainData(this.dataArray);

    // Cycle hues through the spectrum
    this.hue1 = (this.hue1 + this.HUE_CYCLE_SPEED) % 360;
    this.hue2 = (this.hue2 + this.HUE_CYCLE_SPEED) % 360;

    // Get current colors (cached with hue shift)
    const color1: {main: string; glow: string} = this.getCachedColor(1, this.hue1);
    const color2: {main: string; glow: string} = this.getCachedColor(2, this.hue2);

    // Process top waveform (trails expand outward from center)
    this.applyDirectionalZoom(
      this.topTrailCanvas!, this.topTrailCtx!,
      this.tempCanvas!, this.tempCtx!,
      this.screenCenterX, this.screenCenterY,
      this.FADE_RATE, this.ZOOM_SCALE
    );
    this.calculateWaveformPoints(this.topPoints, this.topCenterY, 0);
    this.drawPathWithLayers(
      (): void => { this.buildSmoothPath(this.topTrailCtx!, this.topPoints, this.WAVEFORM_POINTS); },
      color1.main, color1.glow, 'rgba(255, 255, 255, 0.5)',
      {ctx: this.topTrailCtx!, baseGlowBlur: this.BASE_GLOW_BLUR}
    );

    // Process bottom waveform (trails expand outward from center)
    this.applyDirectionalZoom(
      this.bottomTrailCanvas!, this.bottomTrailCtx!,
      this.tempCanvas!, this.tempCtx!,
      this.screenCenterX, this.screenCenterY,
      this.FADE_RATE, this.ZOOM_SCALE
    );
    this.calculateWaveformPoints(this.bottomPoints, this.bottomCenterY, this.WAVEFORM_POINTS / 2);
    this.drawPathWithLayers(
      (): void => { this.buildSmoothPath(this.bottomTrailCtx!, this.bottomPoints, this.WAVEFORM_POINTS); },
      color2.main, color2.glow, 'rgba(255, 255, 255, 0.5)',
      {ctx: this.bottomTrailCtx!, baseGlowBlur: this.BASE_GLOW_BLUR}
    );

    // Composite both trail canvases to main canvas with additive blending
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.topTrailCanvas!, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.bottomTrailCanvas!, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    this.applyFadeOverlay();
  }

  private calculateWaveformPoints(
    points: Array<{x: number; y: number}>,
    centerY: number,
    dataOffset: number
  ): void {
    const numPoints: number = this.WAVEFORM_POINTS;
    const dataLength: number = this.dataArray.length;
    const sliceWidth: number = this.sliceWidth;
    const amplitude: number = this.waveformAmplitude;
    const sensitivityFactor: number = this.sensitivityFactor;

    for (let i: number = 0; i <= numPoints; i++) {
      // Map point to data index with offset for variation between waveforms
      const dataIndex: number = Math.floor(((i + dataOffset) % numPoints) / numPoints * dataLength);
      const sample: number = ((this.dataArray[dataIndex] - 128) / 128) * sensitivityFactor;

      points[i].x = i * sliceWidth;
      points[i].y = centerY + sample * amplitude;
    }
  }

  public override destroy(): void {
    this.topTrailCanvas = null;
    this.topTrailCtx = null;
    this.bottomTrailCanvas = null;
    this.bottomTrailCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}

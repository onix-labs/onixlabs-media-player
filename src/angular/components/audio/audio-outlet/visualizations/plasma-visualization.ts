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

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

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

  /** Cached color values to avoid recalculation every frame */
  private cachedColor1: {main: string; glow: string} | null = null;
  private cachedColor2: {main: string; glow: string} | null = null;
  private cachedHue1: number = -1;
  private cachedHue2: number = -1;
  private cachedHueShift: number = -1;

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

    // Create/resize trail canvases
    if (!this.topTrailCanvas) {
      this.topTrailCanvas = document.createElement('canvas');
      this.topTrailCtx = this.topTrailCanvas.getContext('2d', {alpha: true})!;
    }
    this.topTrailCanvas.width = width;
    this.topTrailCanvas.height = height;

    if (!this.bottomTrailCanvas) {
      this.bottomTrailCanvas = document.createElement('canvas');
      this.bottomTrailCtx = this.bottomTrailCanvas.getContext('2d', {alpha: true})!;
    }
    this.bottomTrailCanvas.width = width;
    this.bottomTrailCanvas.height = height;

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
      this.screenCenterX, this.screenCenterY
    );
    this.calculateWaveformPoints(this.topPoints, this.topCenterY, 0);
    this.drawWaveform(this.topTrailCtx!, this.topPoints, color1.main, color1.glow);

    // Process bottom waveform (trails expand outward from center)
    this.applyDirectionalZoom(
      this.bottomTrailCanvas!, this.bottomTrailCtx!,
      this.screenCenterX, this.screenCenterY
    );
    this.calculateWaveformPoints(this.bottomPoints, this.bottomCenterY, this.WAVEFORM_POINTS / 2);
    this.drawWaveform(this.bottomTrailCtx!, this.bottomPoints, color2.main, color2.glow);

    // Composite both trail canvases to main canvas with additive blending
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.topTrailCanvas!, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.bottomTrailCanvas!, 0, 0);
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
    const effectiveFadeRate: number = this.FADE_RATE * this.getFadeMultiplier();
    trailCtx.save();
    trailCtx.globalAlpha = 1 - effectiveFadeRate;
    trailCtx.translate(zoomCenterX, zoomCenterY);
    trailCtx.scale(this.ZOOM_SCALE, this.ZOOM_SCALE);
    trailCtx.translate(-zoomCenterX, -zoomCenterY);
    trailCtx.drawImage(tempCanvas, 0, 0);
    trailCtx.restore();
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
    const sensitivityFactor: number = this.sensitivity * 2;

    for (let i: number = 0; i <= numPoints; i++) {
      // Map point to data index with offset for variation between waveforms
      const dataIndex: number = Math.floor(((i + dataOffset) % numPoints) / numPoints * dataLength);
      const sample: number = ((this.dataArray[dataIndex] - 128) / 128) * sensitivityFactor;

      points[i].x = i * sliceWidth;
      points[i].y = centerY + sample * amplitude;
    }
  }

  private drawWaveform(
    ctx: CanvasRenderingContext2D,
    points: Array<{x: number; y: number}>,
    color: string,
    glowColor: string
  ): void {
    const numPoints: number = this.WAVEFORM_POINTS;

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
    ctx.stroke();
    ctx.restore();

    // Main line
    ctx.strokeStyle = color;
    ctx.lineWidth = this.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    buildPath();
    ctx.stroke();

    // Highlight
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    buildPath();
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
    this.topTrailCanvas = null;
    this.topTrailCtx = null;
    this.bottomTrailCanvas = null;
    this.bottomTrailCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}

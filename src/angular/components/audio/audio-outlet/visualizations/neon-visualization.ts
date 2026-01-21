/**
 * @fileoverview Neon visualization with rotating crossing waveforms.
 *
 * Creates a hypnotic rotating cross effect with one horizontal and one
 * vertical waveform that intersect at the center, spinning continuously.
 *
 * Technical details:
 * - Horizontal waveform (cyan) at 50% vertical position
 * - Vertical waveform (magenta) at 50% horizontal position
 * - Cross rotates continuously around the center
 * - Trails fade outward from center with zoom effect
 * - Each waveform has glow, main, and highlight layers
 *
 * @module app/components/audio/audio-outlet/visualizations/neon-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/**
 * Neon visualization with rotating crossing waveforms.
 *
 * Renders one horizontal (cyan) and one vertical (magenta) waveform that
 * intersect at the center, rotating continuously with expanding trails.
 */
export class NeonVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Neon';
  public readonly category: string = 'Waves';

  private readonly FADE_RATE: number = 0.025;
  private readonly ZOOM_SCALE: number = 1.03;
  private readonly BASE_GLOW_BLUR: number = 15;
  private readonly WAVEFORM_POINTS: number = 128;
  private readonly ROTATION_SPEED: number = 0.005;

  /** Fixed colors for waveforms */
  private readonly CYAN_COLOR: {main: string; glow: string} = {
    main: 'rgb(0, 255, 255)',
    glow: 'rgba(0, 255, 255, 0.8)'
  };
  private readonly MAGENTA_COLOR: {main: string; glow: string} = {
    main: 'rgb(255, 0, 255)',
    glow: 'rgba(255, 0, 255, 0.8)'
  };

  /** Current rotation angle in radians */
  private rotationAngle: number = 0;

  private dataArray: Uint8Array<ArrayBuffer>;

  /** Trail canvases for each waveform */
  private horizontalTrailCanvas: HTMLCanvasElement | null = null;
  private horizontalTrailCtx: CanvasRenderingContext2D | null = null;
  private verticalTrailCanvas: HTMLCanvasElement | null = null;
  private verticalTrailCtx: CanvasRenderingContext2D | null = null;

  /** Temp canvas for zoom effect */
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  /** Pre-allocated point arrays for waveforms */
  private readonly horizontalPoints: Array<{x: number; y: number}>;
  private readonly verticalPoints: Array<{x: number; y: number}>;

  /** Layout values */
  private screenCenterX: number = 0;
  private screenCenterY: number = 0;
  private horizontalAmplitude: number = 0;
  private verticalAmplitude: number = 0;
  private sliceWidth: number = 0;
  private sliceHeight: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.sensitivity = 1;

    // Pre-allocate point arrays
    this.horizontalPoints = [];
    this.verticalPoints = [];
    for (let i: number = 0; i <= this.WAVEFORM_POINTS; i++) {
      this.horizontalPoints.push({x: 0, y: 0});
      this.verticalPoints.push({x: 0, y: 0});
    }
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    const width: number = this.width;
    const height: number = this.height;

    // Screen center (intersection point of cross)
    this.screenCenterX = width / 2;
    this.screenCenterY = height / 2;

    // Amplitude for waveform displacement
    this.horizontalAmplitude = height * 0.15;
    this.verticalAmplitude = width * 0.15;

    // Size per point for each direction
    this.sliceWidth = width / this.WAVEFORM_POINTS;
    this.sliceHeight = height / this.WAVEFORM_POINTS;

    // Create/resize trail canvases
    if (!this.horizontalTrailCanvas) {
      this.horizontalTrailCanvas = document.createElement('canvas');
      this.horizontalTrailCtx = this.horizontalTrailCanvas.getContext('2d', {alpha: true})!;
    }
    this.horizontalTrailCanvas.width = width;
    this.horizontalTrailCanvas.height = height;

    if (!this.verticalTrailCanvas) {
      this.verticalTrailCanvas = document.createElement('canvas');
      this.verticalTrailCtx = this.verticalTrailCanvas.getContext('2d', {alpha: true})!;
    }
    this.verticalTrailCanvas.width = width;
    this.verticalTrailCanvas.height = height;

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
    if (!this.horizontalTrailCanvas || !this.verticalTrailCanvas || !this.tempCanvas) {
      this.onResize();
    }

    // Get time domain data
    this.analyser.getByteTimeDomainData(this.dataArray);

    // Update rotation angle
    this.rotationAngle += this.ROTATION_SPEED;

    // Process horizontal waveform (cyan, centered vertically)
    this.applyDirectionalZoom(
      this.horizontalTrailCanvas!, this.horizontalTrailCtx!,
      this.screenCenterX, this.screenCenterY
    );
    this.calculateHorizontalWaveformPoints(this.horizontalPoints, 0);
    this.rotatePoints(this.horizontalPoints, this.rotationAngle);
    this.drawWaveform(this.horizontalTrailCtx!, this.horizontalPoints, this.CYAN_COLOR.main, this.CYAN_COLOR.glow);

    // Process vertical waveform (magenta, centered horizontally)
    this.applyDirectionalZoom(
      this.verticalTrailCanvas!, this.verticalTrailCtx!,
      this.screenCenterX, this.screenCenterY
    );
    this.calculateVerticalWaveformPoints(this.verticalPoints, this.WAVEFORM_POINTS / 2);
    this.rotatePoints(this.verticalPoints, this.rotationAngle);
    this.drawWaveform(this.verticalTrailCtx!, this.verticalPoints, this.MAGENTA_COLOR.main, this.MAGENTA_COLOR.glow);

    // Composite both trail canvases to main canvas with additive blending
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.horizontalTrailCanvas!, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.verticalTrailCanvas!, 0, 0);
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

  private calculateHorizontalWaveformPoints(
    points: Array<{x: number; y: number}>,
    dataOffset: number
  ): void {
    const numPoints: number = this.WAVEFORM_POINTS;
    const dataLength: number = this.dataArray.length;
    const sliceWidth: number = this.sliceWidth;
    const centerY: number = this.screenCenterY;
    const amplitude: number = this.horizontalAmplitude;
    const sensitivityFactor: number = this.sensitivity * 2;

    for (let i: number = 0; i <= numPoints; i++) {
      // Map point to data index with offset for variation between waveforms
      const dataIndex: number = Math.floor(((i + dataOffset) % numPoints) / numPoints * dataLength);
      const sample: number = ((this.dataArray[dataIndex] - 128) / 128) * sensitivityFactor;

      points[i].x = i * sliceWidth;
      points[i].y = centerY + sample * amplitude;
    }
  }

  private calculateVerticalWaveformPoints(
    points: Array<{x: number; y: number}>,
    dataOffset: number
  ): void {
    const numPoints: number = this.WAVEFORM_POINTS;
    const dataLength: number = this.dataArray.length;
    const sliceHeight: number = this.sliceHeight;
    const centerX: number = this.screenCenterX;
    const amplitude: number = this.verticalAmplitude;
    const sensitivityFactor: number = this.sensitivity * 2;

    for (let i: number = 0; i <= numPoints; i++) {
      // Map point to data index with offset for variation between waveforms
      const dataIndex: number = Math.floor(((i + dataOffset) % numPoints) / numPoints * dataLength);
      const sample: number = ((this.dataArray[dataIndex] - 128) / 128) * sensitivityFactor;

      points[i].x = centerX + sample * amplitude;
      points[i].y = i * sliceHeight;
    }
  }

  /**
   * Rotates all points around the screen center by the given angle.
   */
  private rotatePoints(points: Array<{x: number; y: number}>, angle: number): void {
    const cos: number = Math.cos(angle);
    const sin: number = Math.sin(angle);
    const centerX: number = this.screenCenterX;
    const centerY: number = this.screenCenterY;

    for (let i: number = 0; i < points.length; i++) {
      const dx: number = points[i].x - centerX;
      const dy: number = points[i].y - centerY;
      points[i].x = centerX + dx * cos - dy * sin;
      points[i].y = centerY + dx * sin + dy * cos;
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

  public override destroy(): void {
    this.horizontalTrailCanvas = null;
    this.horizontalTrailCtx = null;
    this.verticalTrailCanvas = null;
    this.verticalTrailCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}

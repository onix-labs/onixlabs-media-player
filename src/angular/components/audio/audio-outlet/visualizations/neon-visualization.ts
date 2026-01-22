/**
 * @fileoverview Neon visualization with two counter-rotating crosses.
 *
 * Creates a hypnotic effect with two complete crosses (each with horizontal
 * and vertical waveforms) that rotate in opposite directions.
 *
 * Technical details:
 * - Cyan cross rotates clockwise
 * - Magenta cross rotates counter-clockwise
 * - All waveforms are equal length (8/9 of shorter screen dimension)
 * - Trails fade outward from center with zoom effect
 * - Each waveform has glow, main, and highlight layers
 *
 * @module app/components/audio/audio-outlet/visualizations/neon-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/**
 * Neon visualization with two counter-rotating crosses.
 *
 * Renders two complete crosses: a cyan cross rotating clockwise and a magenta
 * cross rotating counter-clockwise. Each cross consists of horizontal and
 * vertical waveforms of equal length with expanding trails.
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

  /** Trail canvases for each cross */
  private cyanTrailCanvas: HTMLCanvasElement | null = null;
  private cyanTrailCtx: CanvasRenderingContext2D | null = null;
  private magentaTrailCanvas: HTMLCanvasElement | null = null;
  private magentaTrailCtx: CanvasRenderingContext2D | null = null;

  /** Temp canvas for zoom effect */
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  /** Pre-allocated point arrays for waveforms (2 per cross) */
  private readonly cyanHorizontalPoints: Array<{x: number; y: number}>;
  private readonly cyanVerticalPoints: Array<{x: number; y: number}>;
  private readonly magentaHorizontalPoints: Array<{x: number; y: number}>;
  private readonly magentaVerticalPoints: Array<{x: number; y: number}>;

  /** Layout values */
  private screenCenterX: number = 0;
  private screenCenterY: number = 0;
  private waveformLength: number = 0;
  private waveformAmplitude: number = 0;
  private sliceSize: number = 0;
  private horizontalStartX: number = 0;
  private verticalStartY: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.sensitivity = 1;

    // Pre-allocate point arrays for both crosses
    this.cyanHorizontalPoints = [];
    this.cyanVerticalPoints = [];
    this.magentaHorizontalPoints = [];
    this.magentaVerticalPoints = [];
    for (let i: number = 0; i <= this.WAVEFORM_POINTS; i++) {
      this.cyanHorizontalPoints.push({x: 0, y: 0});
      this.cyanVerticalPoints.push({x: 0, y: 0});
      this.magentaHorizontalPoints.push({x: 0, y: 0});
      this.magentaVerticalPoints.push({x: 0, y: 0});
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

    // Both waveforms use 8/9 of the shorter axis so they stay visible when rotating
    this.waveformLength = Math.min(width, height) * 8 / 9;
    this.waveformAmplitude = this.waveformLength * 0.15;
    this.sliceSize = this.waveformLength / this.WAVEFORM_POINTS;

    // Center the waveforms on screen
    this.horizontalStartX = (width - this.waveformLength) / 2;
    this.verticalStartY = (height - this.waveformLength) / 2;

    // Create/resize trail canvases for each cross
    if (!this.cyanTrailCanvas) {
      this.cyanTrailCanvas = document.createElement('canvas');
      this.cyanTrailCtx = this.cyanTrailCanvas.getContext('2d', {alpha: true})!;
    }
    this.cyanTrailCanvas.width = width;
    this.cyanTrailCanvas.height = height;

    if (!this.magentaTrailCanvas) {
      this.magentaTrailCanvas = document.createElement('canvas');
      this.magentaTrailCtx = this.magentaTrailCanvas.getContext('2d', {alpha: true})!;
    }
    this.magentaTrailCanvas.width = width;
    this.magentaTrailCanvas.height = height;

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
    if (!this.cyanTrailCanvas || !this.magentaTrailCanvas || !this.tempCanvas) {
      this.onResize();
    }

    // Get time domain data
    this.analyser.getByteTimeDomainData(this.dataArray);

    // Update rotation angle
    this.rotationAngle += this.ROTATION_SPEED;

    // Apply zoom effect to both trail canvases
    this.applyDirectionalZoom(
      this.cyanTrailCanvas!, this.cyanTrailCtx!,
      this.screenCenterX, this.screenCenterY
    );
    this.applyDirectionalZoom(
      this.magentaTrailCanvas!, this.magentaTrailCtx!,
      this.screenCenterX, this.screenCenterY
    );

    // Cyan cross (rotates clockwise)
    this.calculateHorizontalWaveformPoints(this.cyanHorizontalPoints, 0);
    this.calculateVerticalWaveformPoints(this.cyanVerticalPoints, 0);
    this.rotatePoints(this.cyanHorizontalPoints, this.rotationAngle);
    this.rotatePoints(this.cyanVerticalPoints, this.rotationAngle);
    this.drawWaveform(this.cyanTrailCtx!, this.cyanHorizontalPoints, this.CYAN_COLOR.main, this.CYAN_COLOR.glow);
    this.drawWaveform(this.cyanTrailCtx!, this.cyanVerticalPoints, this.CYAN_COLOR.main, this.CYAN_COLOR.glow);

    // Magenta cross (rotates counter-clockwise)
    this.calculateHorizontalWaveformPoints(this.magentaHorizontalPoints, this.WAVEFORM_POINTS / 2);
    this.calculateVerticalWaveformPoints(this.magentaVerticalPoints, this.WAVEFORM_POINTS / 2);
    this.rotatePoints(this.magentaHorizontalPoints, -this.rotationAngle);
    this.rotatePoints(this.magentaVerticalPoints, -this.rotationAngle);
    this.drawWaveform(this.magentaTrailCtx!, this.magentaHorizontalPoints, this.MAGENTA_COLOR.main, this.MAGENTA_COLOR.glow);
    this.drawWaveform(this.magentaTrailCtx!, this.magentaVerticalPoints, this.MAGENTA_COLOR.main, this.MAGENTA_COLOR.glow);

    // Composite both trail canvases to main canvas with additive blending
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.cyanTrailCanvas!, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.magentaTrailCanvas!, 0, 0);
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
    const sliceSize: number = this.sliceSize;
    const startX: number = this.horizontalStartX;
    const centerY: number = this.screenCenterY;
    const amplitude: number = this.waveformAmplitude;
    const sensitivityFactor: number = this.sensitivity * 2;

    for (let i: number = 0; i <= numPoints; i++) {
      // Map point to data index with offset for variation between waveforms
      const dataIndex: number = Math.floor(((i + dataOffset) % numPoints) / numPoints * dataLength);
      const sample: number = ((this.dataArray[dataIndex] - 128) / 128) * sensitivityFactor;

      points[i].x = startX + i * sliceSize;
      points[i].y = centerY + sample * amplitude;
    }
  }

  private calculateVerticalWaveformPoints(
    points: Array<{x: number; y: number}>,
    dataOffset: number
  ): void {
    const numPoints: number = this.WAVEFORM_POINTS;
    const dataLength: number = this.dataArray.length;
    const sliceSize: number = this.sliceSize;
    const centerX: number = this.screenCenterX;
    const startY: number = this.verticalStartY;
    const amplitude: number = this.waveformAmplitude;
    const sensitivityFactor: number = this.sensitivity * 2;

    for (let i: number = 0; i <= numPoints; i++) {
      // Map point to data index with offset for variation between waveforms
      const dataIndex: number = Math.floor(((i + dataOffset) % numPoints) / numPoints * dataLength);
      const sample: number = ((this.dataArray[dataIndex] - 128) / 128) * sensitivityFactor;

      points[i].x = centerX + sample * amplitude;
      points[i].y = startY + i * sliceSize;
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
    this.cyanTrailCanvas = null;
    this.cyanTrailCtx = null;
    this.magentaTrailCanvas = null;
    this.magentaTrailCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}

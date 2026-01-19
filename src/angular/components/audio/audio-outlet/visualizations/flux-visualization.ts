/**
 * @fileoverview Flux visualization with dual circular waveforms.
 *
 * Creates a hypnotic effect with two circular waveforms (blue and green)
 * positioned side by side. Each circle fades outward in opposite directions,
 * creating trails that meet in the middle.
 *
 * Technical details:
 * - Two small circular waveforms side by side horizontally
 * - Left circle (blue) fades to the left
 * - Right circle (green) fades to the right
 * - Vivid color scheme
 * - Each waveform has glow, main, and highlight layers
 *
 * @module app/components/audio/audio-outlet/visualizations/flux-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/**
 * Flux visualization with dual circular waveforms fading in opposite directions.
 *
 * Renders two circular waveforms (blue and green) side by side, with trails
 * that extend outward from the center.
 */
export class FluxVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Flux';
  public readonly category: string = 'Waves';

  private readonly FADE_RATE: number = 0.025;
  private readonly ZOOM_SCALE: number = 1.03;
  private readonly LINE_WIDTH: number = 2;
  private readonly GLOW_BLUR: number = 15;
  private readonly CIRCLE_POINTS: number = 96;

  /** Vivid colors: blue and green */
  private readonly BLUE: {main: string; glow: string} = {
    main: 'rgb(0, 150, 255)',
    glow: 'rgba(0, 150, 255, 0.8)',
  };
  private readonly GREEN: {main: string; glow: string} = {
    main: 'rgb(0, 255, 120)',
    glow: 'rgba(0, 255, 120, 0.8)',
  };

  private readonly dataArray: Uint8Array<ArrayBuffer>;

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

  /** Circle centers and radius */
  private leftCenterX: number = 0;
  private rightCenterX: number = 0;
  private centerY: number = 0;
  private baseRadius: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.analyser.fftSize = 512;
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

  protected override onResize(): void {
    const width: number = this.width;
    const height: number = this.height;

    // Position circles close together near center
    const spacing: number = width * 0.08;
    this.leftCenterX = width / 2 - spacing;
    this.rightCenterX = width / 2 + spacing;
    this.centerY = height / 2;

    // Small circles
    this.baseRadius = Math.min(width, height) * 0.12;

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

    const amplitudeScale: number = this.baseRadius * 0.4;

    // Process left circle (fades to the left, filling left half of screen)
    this.applyDirectionalZoom(
      this.leftTrailCanvas!, this.leftTrailCtx!,
      width / 2, this.centerY  // Zoom from center - trails expand to left
    );
    this.calculateCirclePoints(this.leftPoints, this.leftCenterX, amplitudeScale, 0);
    this.drawCircleWaveform(this.leftTrailCtx!, this.leftPoints, this.BLUE.main, this.BLUE.glow);

    // Process right circle (fades to the right, filling right half of screen)
    this.applyDirectionalZoom(
      this.rightTrailCanvas!, this.rightTrailCtx!,
      width / 2, this.centerY  // Zoom from center - trails expand to right
    );
    this.calculateCirclePoints(this.rightPoints, this.rightCenterX, amplitudeScale, this.CIRCLE_POINTS / 2);
    this.drawCircleWaveform(this.rightTrailCtx!, this.rightPoints, this.GREEN.main, this.GREEN.glow);

    // Composite both trail canvases to main canvas
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.leftTrailCanvas!, 0, 0);
    ctx.drawImage(this.rightTrailCanvas!, 0, 0);

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
    trailCtx.save();
    trailCtx.globalAlpha = 1 - this.FADE_RATE;
    trailCtx.translate(zoomCenterX, zoomCenterY);
    trailCtx.scale(this.ZOOM_SCALE, this.ZOOM_SCALE);
    trailCtx.translate(-zoomCenterX, -zoomCenterY);
    trailCtx.drawImage(tempCanvas, 0, 0);
    trailCtx.restore();
  }

  private calculateCirclePoints(
    points: Array<{x: number; y: number}>,
    centerX: number,
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
      points[i].y = this.centerY + radius * Math.sin(angle);
    }
  }

  private drawCircleWaveform(
    ctx: CanvasRenderingContext2D,
    points: Array<{x: number; y: number}>,
    color: string,
    glowColor: string
  ): void {
    const numPoints: number = this.CIRCLE_POINTS;

    // Build path helper
    const buildPath: () => void = (): void => {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i: number = 1; i <= numPoints; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.closePath();
    };

    // Glow layer
    ctx.save();
    ctx.shadowBlur = this.GLOW_BLUR;
    ctx.shadowColor = glowColor;
    ctx.strokeStyle = glowColor.replace('0.8', '0.3');
    ctx.lineWidth = this.LINE_WIDTH + 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    buildPath();
    ctx.stroke();
    ctx.restore();

    // Main line
    ctx.strokeStyle = color;
    ctx.lineWidth = this.LINE_WIDTH;
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
    this.leftTrailCanvas = null;
    this.leftTrailCtx = null;
    this.rightTrailCanvas = null;
    this.rightTrailCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}

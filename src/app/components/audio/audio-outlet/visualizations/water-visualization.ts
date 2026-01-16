import {Canvas2DVisualization, VisualizationConfig} from './visualization';

export class WaterVisualization extends Canvas2DVisualization {
  private readonly CIRCLE_COUNT = 6;
  private readonly INNER_ROTATION = 0.025; // Inner current rotates fastest
  private readonly OUTER_ROTATION = 0.004; // Outer current rotates slowest
  private readonly EXPANSION_RATE = 1.012; // Trails expand outward
  private readonly FADE_RATE = 0.035;
  private readonly INNER_RADIUS_RATIO = 0.15; // Where the fast current starts
  private readonly OUTER_RADIUS_RATIO = 0.85; // Where trails fade out

  private dataArray: Uint8Array<ArrayBuffer>;
  private circleCanvas: HTMLCanvasElement | null = null;
  private trailCanvas: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;
  private trailData: ImageData | null = null;

  constructor(config: VisualizationConfig) {
    super(config);
    this.analyser.fftSize = 2048;
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    // Pre-render circles to an offscreen canvas
    this.circleCanvas = document.createElement('canvas');
    this.circleCanvas.width = this.width;
    this.circleCanvas.height = this.height;
    this.renderCirclesToCanvas(this.circleCanvas.getContext('2d')!);

    // Create a separate transparent canvas for waveform trails
    this.trailCanvas = document.createElement('canvas');
    this.trailCanvas.width = this.width;
    this.trailCanvas.height = this.height;
    this.trailCtx = this.trailCanvas.getContext('2d')!;
    this.trailData = null;

    // Clear main canvas
    this.ctx.fillStyle = 'black';
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  private renderCirclesToCanvas(ctx: CanvasRenderingContext2D): void {
    const {width, height} = this;
    const centerX = width / 2;
    const centerY = height / 2;
    const maxRadius = Math.max(width, height) * this.OUTER_RADIUS_RATIO;
    const minRadius = Math.max(width, height) * this.INNER_RADIUS_RATIO;

    // Clear to black
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, width, height);

    // Draw circles from largest (darkest) to smallest (lightest)
    for (let i = 0; i < this.CIRCLE_COUNT; i++) {
      const t = i / (this.CIRCLE_COUNT - 1);
      const radius = maxRadius - t * (maxRadius - minRadius);

      const r = Math.floor(8 + t * 60);
      const g = Math.floor(15 + t * 120);
      const b = Math.floor(40 + t * 180);

      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  draw(): void {
    const {ctx, width, height} = this;
    const centerX = width / 2;
    const centerY = height / 2;

    // Ensure canvases exist
    if (!this.circleCanvas || !this.trailCanvas || !this.trailCtx) {
      this.onResize();
    }

    const trailCtx = this.trailCtx!;
    const trailCanvas = this.trailCanvas!;
    const maxDim = Math.max(width, height);
    const innerRadius = maxDim * this.INNER_RADIUS_RATIO;
    const outerRadius = maxDim * this.OUTER_RADIUS_RATIO;

    // Get current trail data and apply current-based transformation
    const sourceData = trailCtx.getImageData(0, 0, width, height);
    const destData = trailCtx.createImageData(width, height);

    // Process each pixel - apply rotation based on distance from center (current strength)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - centerX;
        const dy = y - centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // Calculate rotation based on which "current" this pixel is in
        // Inner = fast rotation, Outer = slow rotation
        const normalizedDist = Math.max(0, Math.min(1, (distance - innerRadius) / (outerRadius - innerRadius)));
        const rotation = this.INNER_ROTATION * (1 - normalizedDist) + this.OUTER_ROTATION * normalizedDist;

        // Calculate source position (reverse the transformation to sample)
        // We want to push outward and rotate, so source is inward and counter-rotated
        const sourceDistance = distance / this.EXPANSION_RATE;
        const angle = Math.atan2(dy, dx);
        const sourceAngle = angle - rotation;

        const srcX = centerX + Math.cos(sourceAngle) * sourceDistance;
        const srcY = centerY + Math.sin(sourceAngle) * sourceDistance;

        // Bilinear interpolation for smooth sampling
        const srcXi = Math.floor(srcX);
        const srcYi = Math.floor(srcY);
        const xFrac = srcX - srcXi;
        const yFrac = srcY - srcYi;

        if (srcXi >= 0 && srcXi < width - 1 && srcYi >= 0 && srcYi < height - 1) {
          const destIdx = (y * width + x) * 4;

          // Sample 4 neighboring pixels
          const idx00 = (srcYi * width + srcXi) * 4;
          const idx10 = (srcYi * width + srcXi + 1) * 4;
          const idx01 = ((srcYi + 1) * width + srcXi) * 4;
          const idx11 = ((srcYi + 1) * width + srcXi + 1) * 4;

          // Fade based on distance - trails fade as they approach outer edge
          const fadeFactor = distance > outerRadius ? 0 : (1 - this.FADE_RATE);

          for (let c = 0; c < 4; c++) {
            const v00 = sourceData.data[idx00 + c];
            const v10 = sourceData.data[idx10 + c];
            const v01 = sourceData.data[idx01 + c];
            const v11 = sourceData.data[idx11 + c];

            const v0 = v00 * (1 - xFrac) + v10 * xFrac;
            const v1 = v01 * (1 - xFrac) + v11 * xFrac;
            const value = v0 * (1 - yFrac) + v1 * yFrac;

            destData.data[destIdx + c] = c === 3 ? value * fadeFactor : value;
          }
        }
      }
    }

    // Put transformed data back
    trailCtx.putImageData(destData, 0, 0);

    // Draw new waveform on top of trails
    this.analyser.getByteTimeDomainData(this.dataArray);
    this.drawCurrentWaveform(trailCtx, centerX, centerY, innerRadius);

    // Composite - draw circles background, then trails on top
    ctx.drawImage(this.circleCanvas!, 0, 0);
    ctx.drawImage(trailCanvas, 0, 0);
  }

  private drawCurrentWaveform(ctx: CanvasRenderingContext2D, centerX: number, centerY: number, innerRadius: number): void {
    const {width, height, dataArray} = this;

    // Draw waveform as a ring around the inner circle, following the current
    const points: Array<{x: number; y: number}> = [];
    const waveformRadius = innerRadius * 1.3; // Just outside the fastest current

    for (let i = 0; i < dataArray.length; i++) {
      const sample = (dataArray[i] - 128) / 128;
      // Map sample position to angle around the circle
      const angle = (i / dataArray.length) * Math.PI * 2 - Math.PI / 2;
      // Modulate radius based on audio amplitude
      const r = waveformRadius + sample * innerRadius * 0.8;

      const x = centerX + Math.cos(angle) * r;
      const y = centerY + Math.sin(angle) * r;
      points.push({x, y});
    }

    // Close the loop
    points.push(points[0]);

    // Draw glow layer
    ctx.save();
    ctx.shadowBlur = 15;
    ctx.shadowColor = 'rgba(100, 180, 255, 0.8)';
    ctx.strokeStyle = 'rgba(80, 160, 255, 0.4)';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      if (i === 0) ctx.moveTo(points[i].x, points[i].y);
      else ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
    ctx.restore();

    // Draw main waveform (light blue)
    ctx.strokeStyle = 'rgb(120, 200, 255)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      if (i === 0) ctx.moveTo(points[i].x, points[i].y);
      else ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();

    // Draw highlight
    ctx.strokeStyle = 'rgba(200, 240, 255, 0.6)';
    ctx.lineWidth = 1;

    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      if (i === 0) ctx.moveTo(points[i].x, points[i].y);
      else ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }
}

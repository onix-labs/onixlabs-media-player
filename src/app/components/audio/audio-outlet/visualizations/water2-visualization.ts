import {Canvas2DVisualization, VisualizationConfig} from './visualization';

export class Water2Visualization extends Canvas2DVisualization {
  private readonly ROTATION_SPEED = 0.006;
  private readonly FADE_RATE = 0.008;
  private readonly BACKGROUND_DARKEN = 0.7; // Darken background rings

  // Color gradient: darkest at edges, lightest at center
  private readonly GRADIENT_COLORS = [
    {r: 20, g: 40, b: 100},   // Darkest
    {r: 40, g: 80, b: 140},   // Dark
    {r: 80, g: 130, b: 190},  // Mid
    {r: 120, g: 180, b: 230}, // Light
    {r: 160, g: 220, b: 255}  // Lightest
  ];

  private dataArray: Uint8Array<ArrayBuffer>;
  private circleCanvas: HTMLCanvasElement | null = null;
  private trailCanvas: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;

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

    // Create transparent canvas for waveform trails
    this.trailCanvas = document.createElement('canvas');
    this.trailCanvas.width = this.width;
    this.trailCanvas.height = this.height;
    this.trailCtx = this.trailCanvas.getContext('2d')!;

    // Clear main canvas to black
    this.ctx.fillStyle = 'black';
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  private renderCirclesToCanvas(ctx: CanvasRenderingContext2D): void {
    const {width, height} = this;
    const centerX = width / 2;
    const centerY = height / 2;
    const numColors = this.GRADIENT_COLORS.length;

    // Clear to black
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, width, height);

    // The waveform has 9 segments (numColors * 2 - 1) with pattern: 0-1-2-3-4-3-2-1-0
    // Each segment is 1/9 of the width, so boundaries from center are at:
    // Color 0 (darkest): from edge (width/2) to 7/18 * width
    // Color 1 (dark): from 7/18 to 5/18 * width
    // Color 2 (mid): from 5/18 to 3/18 * width
    // Color 3 (light): from 3/18 to 1/18 * width
    // Color 4 (lightest): from 1/18 * width to center

    const totalSegments = numColors * 2 - 1; // 9 segments

    // Circle radii at segment boundaries (from outer to inner)
    // Radius = (segments from center) / totalSegments * width
    const radii = [
      width / 2,                              // Outer edge (darkest)
      (7 / (totalSegments * 2)) * width,      // 7/18 * width
      (5 / (totalSegments * 2)) * width,      // 5/18 * width
      (3 / (totalSegments * 2)) * width,      // 3/18 * width
      (1 / (totalSegments * 2)) * width       // 1/18 * width (lightest center)
    ];

    // Draw circles from largest (darkest) to smallest (lightest)
    const darken = this.BACKGROUND_DARKEN;
    for (let i = 0; i < numColors; i++) {
      const color = this.GRADIENT_COLORS[i];
      const radius = radii[i];

      ctx.fillStyle = `rgb(${Math.round(color.r * darken)}, ${Math.round(color.g * darken)}, ${Math.round(color.b * darken)})`;
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

    // Copy current trails
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext('2d')!;
    tempCtx.drawImage(trailCanvas, 0, 0);

    // Clear trail canvas
    trailCtx.clearRect(0, 0, width, height);

    // Draw back previous trails with rotation and fade
    trailCtx.save();
    trailCtx.globalAlpha = 1 - this.FADE_RATE;
    trailCtx.translate(centerX, centerY);
    trailCtx.rotate(this.ROTATION_SPEED);
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
  }

  private drawMirroredWaveform(ctx: CanvasRenderingContext2D, centerX: number, centerY: number): void {
    const {width, height, dataArray} = this;
    const numColors = this.GRADIENT_COLORS.length;

    // Calculate all points first
    const allPoints: Array<{x: number; y: number}> = [];
    const halfWidth = width / 2;
    const samplesPerHalf = Math.floor(dataArray.length / 2);

    // Left half points (from left edge to center)
    for (let i = 0; i < samplesPerHalf; i++) {
      const sample = (dataArray[i] - 128) / 128;
      const amplitude = sample * height * 0.3;
      const t = i / (samplesPerHalf - 1);
      const x = t * halfWidth;
      const y = centerY + amplitude;
      allPoints.push({x, y});
    }

    // Right half points (mirrored, from center to right edge)
    for (let i = samplesPerHalf - 1; i >= 0; i--) {
      const sample = (dataArray[i] - 128) / 128;
      const amplitude = sample * height * 0.3;
      const t = i / (samplesPerHalf - 1);
      const x = width - t * halfWidth;
      const y = centerY + amplitude;
      allPoints.push({x, y});
    }

    // Total segments: 5 colors on left (darkest to lightest), 5 colors on right (lightest to darkest)
    // That's 10 segments total, but the center shares the lightest color
    const totalSegments = numColors * 2 - 1; // 9 segments: 0-1-2-3-4-3-2-1-0
    const pointsPerSegment = Math.floor(allPoints.length / totalSegments);

    // Draw each segment with its color
    for (let seg = 0; seg < totalSegments; seg++) {
      // Determine color index: 0,1,2,3,4,3,2,1,0
      let colorIndex: number;
      if (seg < numColors) {
        colorIndex = seg;
      } else {
        colorIndex = totalSegments - 1 - seg;
      }

      const color = this.GRADIENT_COLORS[colorIndex];
      const startIdx = seg * pointsPerSegment;
      const endIdx = seg === totalSegments - 1 ? allPoints.length : (seg + 1) * pointsPerSegment + 1;

      const segmentPoints = allPoints.slice(startIdx, endIdx);
      if (segmentPoints.length < 2) continue;

      this.drawWaveformSegment(ctx, segmentPoints, color);
    }
  }

  private drawWaveformSegment(
    ctx: CanvasRenderingContext2D,
    points: Array<{x: number; y: number}>,
    color: {r: number; g: number; b: number}
  ): void {
    if (points.length < 2) return;

    // Draw glow layer
    ctx.save();
    ctx.shadowBlur = 12;
    ctx.shadowColor = `rgba(${color.r}, ${color.g}, ${color.b}, 0.6)`;
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, 0.3)`;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
    ctx.restore();

    // Draw main waveform
    ctx.strokeStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();

    // Draw highlight
    ctx.strokeStyle = `rgba(${Math.min(255, color.r + 60)}, ${Math.min(255, color.g + 40)}, ${Math.min(255, color.b + 20)}, 0.5)`;
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }
}

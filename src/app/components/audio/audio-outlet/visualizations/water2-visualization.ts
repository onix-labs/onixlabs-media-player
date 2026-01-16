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
  private frequencyData: Uint8Array<ArrayBuffer>;
  private circleCanvas: HTMLCanvasElement | null = null;
  private trailCanvas: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;

  // Bass/mid detection settings
  private readonly BASS_BINS = 16;          // Include bass and low-mids
  private readonly TRANSIENT_THRESHOLD = 15; // Minimum jump to detect a transient
  private readonly MIN_LEVEL = 50;           // Minimum level for transient to count
  private readonly DIRECTION_COOLDOWN = 1000; // Milliseconds before direction can change again
  private smoothedBass = 0;                 // Smoothed bass value
  private prevBass = 0;                     // Previous frame's bass for transient detection
  private rotationDirection = 1;            // Current rotation direction (1 or -1)
  private lastDirectionChange = 0;          // Timestamp of last direction change

  constructor(config: VisualizationConfig) {
    super(config);
    this.analyser.fftSize = 2048;
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
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
    const maxRadius = width / 2;

    // Clear to black
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, width, height);

    // The waveform has 9 segments (numColors * 2 - 1) with pattern: 0-1-2-3-4-3-2-1-0
    const totalSegments = numColors * 2 - 1; // 9 segments

    // Calculate ring boundaries as positions (0 = center, 1 = edge)
    // Rings go from outer (darkest) to inner (lightest)
    const ringPositions = [
      1.0,                              // Outer edge (darkest)
      7 / totalSegments,                // 7/9
      5 / totalSegments,                // 5/9
      3 / totalSegments,                // 3/9
      1 / totalSegments,                // 1/9 (lightest center)
      0                                 // Center point
    ];

    // Create radial gradient with soft transitions between rings
    const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, maxRadius);
    const darken = this.BACKGROUND_DARKEN;
    const blendZone = 0.015; // Size of soft transition between rings

    // Add color stops from center outward (gradient position 0 = center, 1 = edge)
    for (let i = numColors - 1; i >= 0; i--) {
      const color = this.GRADIENT_COLORS[i];
      const r = Math.round(color.r * darken);
      const g = Math.round(color.g * darken);
      const b = Math.round(color.b * darken);
      const colorStr = `rgb(${r}, ${g}, ${b})`;

      const innerPos = ringPositions[i + 1]; // Inner edge of this ring
      const outerPos = ringPositions[i];     // Outer edge of this ring

      // Add stops: solid color with soft transition at outer edge
      gradient.addColorStop(Math.min(1, innerPos + blendZone), colorStr);
      gradient.addColorStop(Math.max(0, outerPos - blendZone), colorStr);
    }

    // Fill with gradient
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(centerX, centerY, maxRadius, 0, Math.PI * 2);
    ctx.fill();
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

    // Analyze bass/mid frequencies to detect transients
    this.analyser.getByteFrequencyData(this.frequencyData);
    let bassSum = 0;
    for (let i = 0; i < this.BASS_BINS; i++) {
      bassSum += this.frequencyData[i];
    }
    const bassAvg = bassSum / this.BASS_BINS;

    // Detect transient: sudden increase in bass/mid
    const bassIncrease = bassAvg - this.prevBass;
    this.prevBass = bassAvg;

    // Light smoothing
    this.smoothedBass = this.smoothedBass * 0.5 + bassAvg * 0.5;

    // Check if we can change direction (cooldown elapsed)
    const now = performance.now();
    const canChangeDirection = (now - this.lastDirectionChange) > this.DIRECTION_COOLDOWN;

    // Flip direction on loud transients (only if cooldown has passed)
    const isTransient = bassIncrease > this.TRANSIENT_THRESHOLD && bassAvg > this.MIN_LEVEL;
    if (isTransient && canChangeDirection) {
      this.rotationDirection *= -1;
      this.lastDirectionChange = now;
    }

    // Draw back previous trails with rotation and fade
    trailCtx.save();
    trailCtx.globalAlpha = 1 - this.FADE_RATE;
    trailCtx.translate(centerX, centerY);
    trailCtx.rotate(this.ROTATION_SPEED * this.rotationDirection);
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

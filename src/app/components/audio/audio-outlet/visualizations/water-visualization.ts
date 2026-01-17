import {Canvas2DVisualization, VisualizationConfig, VisualizationCategory} from './visualization';

export class WaterVisualization extends Canvas2DVisualization {
  readonly name: string = 'Pulsar';
  readonly category: VisualizationCategory = 'ambience';

  private readonly ROTATION_SPEED: number = 0.009;
  private readonly WAVEFORM_ROTATION_SPEED: number = 0.005;  // Slower counter-clockwise rotation
  private readonly FADE_RATE: number = 0.008;
  private readonly ZOOM_SCALE: number = 1.02;      // Scale factor per frame for tunnel effect
  private readonly HUE_CYCLE_SPEED: number = 0.15;  // Degrees per frame

  // Saturation and lightness levels for gradient (darkest to lightest)
  private readonly GRADIENT_LEVELS: Array<{s: number; l: number}> = [
    {s: 85, l: 12},  // Darkest
    {s: 80, l: 22},  // Dark
    {s: 75, l: 35},  // Mid
    {s: 70, l: 45},  // Light
    {s: 75, l: 50}   // Vibrant (used for center circle)
  ];

  private dataArray: Uint8Array<ArrayBuffer>;
  private trailCanvas: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;

  // Hue cycling
  private hueOffset: number = 210; // Start at blue (210 degrees)

  // Waveform rotation (anticlockwise)
  private waveformAngle: number = 0;

  // Get current gradient colors based on hue offset
  private getGradientColors(): Array<{r: number; g: number; b: number}> {
    return this.GRADIENT_LEVELS.map(level => {
      return this.hslToRgb(this.hueOffset, level.s, level.l);
    });
  }

  // Convert HSL to RGB
  private hslToRgb(h: number, s: number, l: number): {r: number; g: number; b: number} {
    h = h % 360;
    s = s / 100;
    l = l / 100;

    const c: number = (1 - Math.abs(2 * l - 1)) * s;
    const x: number = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m: number = l - c / 2;

    let r: number = 0, g: number = 0, b: number = 0;

    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }

    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255)
    };
  }

  constructor(config: VisualizationConfig) {
    super(config);
    this.analyser.fftSize = 2048;
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    // Create transparent canvas for waveform trails
    this.trailCanvas = document.createElement('canvas');
    this.trailCanvas.width = this.width;
    this.trailCanvas.height = this.height;
    this.trailCtx = this.trailCanvas.getContext('2d')!;

    // Clear main canvas (transparent)
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  draw(): void {
    const {ctx, width, height} = this;
    const centerX: number = width / 2;
    const centerY: number = height / 2;

    // Cycle hue through the spectrum
    this.hueOffset = (this.hueOffset + this.HUE_CYCLE_SPEED) % 360;

    // Ensure canvas exists
    if (!this.trailCanvas || !this.trailCtx) {
      this.onResize();
    }

    const trailCtx: CanvasRenderingContext2D = this.trailCtx!;
    const trailCanvas: HTMLCanvasElement = this.trailCanvas!;

    // Copy current trails
    const tempCanvas: HTMLCanvasElement = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx: CanvasRenderingContext2D = tempCanvas.getContext('2d')!;
    tempCtx.drawImage(trailCanvas, 0, 0);

    // Clear trail canvas
    trailCtx.clearRect(0, 0, width, height);

    // Draw back previous trails with clockwise rotation, zoom, and fade
    trailCtx.save();
    trailCtx.globalAlpha = 1 - this.FADE_RATE;
    trailCtx.translate(centerX, centerY);
    trailCtx.rotate(this.ROTATION_SPEED);
    trailCtx.scale(this.ZOOM_SCALE, this.ZOOM_SCALE);
    trailCtx.translate(-centerX, -centerY);
    trailCtx.drawImage(tempCanvas, 0, 0);
    trailCtx.restore();

    // Get waveform data
    this.analyser.getByteTimeDomainData(this.dataArray);

    // Update waveform rotation (anticlockwise, slower than trail rotation)
    this.waveformAngle -= this.WAVEFORM_ROTATION_SPEED;

    // Draw the mirrored waveforms with anticlockwise rotation
    trailCtx.save();
    trailCtx.translate(centerX, centerY);
    trailCtx.rotate(this.waveformAngle);
    trailCtx.translate(-centerX, -centerY);
    this.drawMirroredWaveform(trailCtx, centerX, centerY);
    trailCtx.restore();

    // Clear and draw trails (transparent background)
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(trailCanvas, 0, 0);
  }

  private drawMirroredWaveform(ctx: CanvasRenderingContext2D, centerX: number, centerY: number): void {
    const {width, height, dataArray} = this;
    const gradientColors: Array<{r: number; g: number; b: number}> = this.getGradientColors();
    const numColors: number = gradientColors.length;

    // Calculate all points first
    const allPoints: Array<{x: number; y: number}> = [];
    const halfWidth: number = width / 2;
    const samplesPerHalf: number = Math.floor(dataArray.length / 2);

    // Arc bending settings
    // Minimum radius prevents singularity at center and controls max bend tightness
    const minArcRadius: number = halfWidth * 0.18;
    const bendStrength: number = 1.2;  // Multiplier for arc effect

    // Left half points (from left edge to center)
    for (let i: number = 0; i < samplesPerHalf; i++) {
      const sample: number = ((dataArray[i] - 128) / 128) * (this.sensitivity * 2);
      const amplitude: number = sample * height * 0.3;
      const t: number = i / (samplesPerHalf - 1);
      const baseX: number = t * halfWidth;

      // Distance from center determines arc radius (larger distance = gentler curve)
      const distFromCenter: number = centerX - baseX;
      const arcRadius: number = Math.max(distFromCenter, minArcRadius);

      // Convert amplitude to arc angle: angle = arcLength / radius
      // Near center (small radius): same amplitude = larger angle = tighter curve
      // Near edge (large radius): same amplitude = smaller angle = gentler curve
      const arcAngle: number = (amplitude * bendStrength) / arcRadius;

      // Base angle from center to this point (PI = pointing left)
      const baseAngle: number = Math.PI;

      // New angle after applying amplitude as arc (subtract for upward = counter-clockwise)
      const newAngle: number = baseAngle - arcAngle;

      // Calculate position on the arc
      const x: number = centerX + arcRadius * Math.cos(newAngle);
      const y: number = centerY + arcRadius * Math.sin(newAngle);

      allPoints.push({x, y});
    }

    // Right half points (mirrored, from center to right edge)
    for (let i: number = samplesPerHalf - 1; i >= 0; i--) {
      const sample: number = ((dataArray[i] - 128) / 128) * (this.sensitivity * 2);
      const amplitude: number = sample * height * 0.3;
      const t: number = i / (samplesPerHalf - 1);
      const baseX: number = width - t * halfWidth;

      // Distance from center (positive for right side)
      const distFromCenter: number = baseX - centerX;
      const arcRadius: number = Math.max(distFromCenter, minArcRadius);

      // Convert amplitude to arc angle
      const arcAngle: number = (amplitude * bendStrength) / arcRadius;

      // Base angle from center (0 = pointing right)
      const baseAngle: number = 0;

      // New angle (add for upward on right side = counter-clockwise)
      const newAngle: number = baseAngle + arcAngle;

      // Calculate position on the arc
      const x: number = centerX + arcRadius * Math.cos(newAngle);
      const y: number = centerY + arcRadius * Math.sin(newAngle);

      allPoints.push({x, y});
    }

    // Calculate segment boundaries to skip the center
    const totalSegments: number = numColors * 2 - 1; // 9 segments
    const pointsPerSegment: number = Math.floor(allPoints.length / totalSegments);
    const centerSegmentIndex: number = numColors - 1; // Index 4 = center segment

    // Draw left portion (segments 0-3) in lighter version of center color
    const leftEndIdx: number = centerSegmentIndex * pointsPerSegment;
    const leftPoints: Array<{x: number; y: number}> = allPoints.slice(0, leftEndIdx + 1);
    const lighterColor: {r: number; g: number; b: number} = this.hslToRgb(this.hueOffset, 60, 75);
    if (leftPoints.length >= 2) {
      this.drawWaveformSegment(ctx, leftPoints, lighterColor, 0.6);
    }

    // Draw right portion (segments 5-8) in lighter version of center color
    const rightStartIdx: number = (centerSegmentIndex + 1) * pointsPerSegment;
    const rightPoints: Array<{x: number; y: number}> = allPoints.slice(rightStartIdx);
    if (rightPoints.length >= 2) {
      this.drawWaveformSegment(ctx, rightPoints, lighterColor, 0.6);
    }

    // Draw circular waveform at center using the cycling gradient color
    this.drawCenterCircle(ctx, centerX, centerY, halfWidth * 0.18, gradientColors[numColors - 1]);
  }

  private drawCenterCircle(
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    baseRadius: number,
    color: {r: number; g: number; b: number}
  ): void {
    const {dataArray, height} = this;

    // Sample audio data around the circle
    const points: Array<{x: number; y: number}> = [];
    const numPoints: number = 64; // Number of points around the circle

    for (let i: number = 0; i <= numPoints; i++) {
      const angle: number = (i / numPoints) * Math.PI * 2;

      // Sample audio data - use different parts of the array for different angles
      const sampleIndex: number = Math.floor((i / numPoints) * (dataArray.length / 4));
      const sample: number = ((dataArray[sampleIndex] - 128) / 128) * (this.sensitivity * 2);
      const amplitude: number = sample * height * 0.08;

      // Modulate radius with audio
      const radius: number = baseRadius + amplitude;

      const x: number = centerX + radius * Math.cos(angle);
      const y: number = centerY + radius * Math.sin(angle);
      points.push({x, y});
    }

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
    for (let i: number = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // Draw main circle
    ctx.strokeStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i: number = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.stroke();

    // Draw highlight
    ctx.strokeStyle = `rgba(${Math.min(255, color.r + 60)}, ${Math.min(255, color.g + 40)}, ${Math.min(255, color.b + 20)}, 0.5)`;
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i: number = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  private drawWaveformSegment(
    ctx: CanvasRenderingContext2D,
    points: Array<{x: number; y: number}>,
    color: {r: number; g: number; b: number},
    alpha: number = 1.0
  ): void {
    if (points.length < 2) return;

    // Draw glow layer
    ctx.save();
    ctx.shadowBlur = 12;
    ctx.shadowColor = `rgba(${color.r}, ${color.g}, ${color.b}, ${0.6 * alpha})`;
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${0.3 * alpha})`;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i: number = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
    ctx.restore();

    // Draw main waveform
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i: number = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();

    // Draw highlight
    ctx.strokeStyle = `rgba(${Math.min(255, color.r + 60)}, ${Math.min(255, color.g + 40)}, ${Math.min(255, color.b + 20)}, ${0.5 * alpha})`;
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i: number = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }
}

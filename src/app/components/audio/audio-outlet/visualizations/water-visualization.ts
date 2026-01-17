import {Canvas2DVisualization, VisualizationConfig} from './visualization';

export class WaterVisualization extends Canvas2DVisualization {
  private readonly ZOOM_SCALE: number = 1.015;        // Scale factor per frame for tunnel effect
  private readonly ROTATION_SPEED: number = 0.009;    // Rotation speed for waveform
  private readonly FADE_RATE: number = 0.02;
  private readonly HUE_CYCLE_SPEED: number = 0.15;    // Degrees per frame

  private dataArray: Uint8Array<ArrayBuffer>;
  private trailCanvas: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;

  // Hue cycling
  private hueOffset: number = 210; // Start at blue (210 degrees)

  // Rotation angle for waveform
  private rotationAngle: number = 0;

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

    // Update rotation angle
    this.rotationAngle += this.ROTATION_SPEED;

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

    // Draw back previous trails with zoom (tunnel effect) and fade
    // Always zoom out (flying forward into tunnel)
    trailCtx.save();
    trailCtx.globalAlpha = 1 - this.FADE_RATE;
    trailCtx.translate(centerX, centerY);
    trailCtx.scale(this.ZOOM_SCALE, this.ZOOM_SCALE);
    trailCtx.translate(-centerX, -centerY);
    trailCtx.drawImage(tempCanvas, 0, 0);
    trailCtx.restore();

    // Get waveform data
    this.analyser.getByteTimeDomainData(this.dataArray);

    // Draw the mirrored waveforms with rotation
    trailCtx.save();
    trailCtx.translate(centerX, centerY);
    trailCtx.rotate(this.rotationAngle);
    trailCtx.translate(-centerX, -centerY);
    this.drawMirroredWaveform(trailCtx, centerX, centerY);
    trailCtx.restore();

    // Composite - clear then draw trails (transparent background)
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(trailCanvas, 0, 0);
  }

  private drawMirroredWaveform(ctx: CanvasRenderingContext2D, centerX: number, centerY: number): void {
    const {width, height, dataArray} = this;
    const darkColor: {r: number; g: number; b: number} = this.hslToRgb(this.hueOffset, 70, 15);
    const lightColor: {r: number; g: number; b: number} = this.hslToRgb(this.hueOffset, 50, 70);

    // Calculate all points first
    const allPoints: Array<{x: number; y: number; t: number}> = [];
    const halfWidth: number = width / 2;
    const samplesPerHalf: number = Math.floor(dataArray.length / 2);

    // Arc bending settings
    const minArcRadius: number = halfWidth * 0.12;
    const bendStrength: number = 1.2;

    // Left half points (from left edge to center)
    for (let i: number = 0; i < samplesPerHalf; i++) {
      const sample: number = (dataArray[i] - 128) / 128;
      const amplitude: number = sample * height * 0.3;
      const t: number = i / (samplesPerHalf - 1); // 0 at edge, 1 at center
      const baseX: number = t * halfWidth;

      const distFromCenter: number = centerX - baseX;
      const arcRadius: number = Math.max(distFromCenter, minArcRadius);
      const arcAngle: number = (amplitude * bendStrength) / arcRadius;
      const baseAngle: number = Math.PI;
      const newAngle: number = baseAngle - arcAngle;

      const x: number = centerX + arcRadius * Math.cos(newAngle);
      const y: number = centerY + arcRadius * Math.sin(newAngle);

      allPoints.push({x, y, t}); // t=0 at left edge, t=1 at center
    }

    // Right half points (mirrored, from center to right edge)
    for (let i: number = samplesPerHalf - 1; i >= 0; i--) {
      const sample: number = (dataArray[i] - 128) / 128;
      const amplitude: number = sample * height * 0.3;
      const t: number = i / (samplesPerHalf - 1); // Will go from 1 back to 0
      const baseX: number = width - t * halfWidth;

      const distFromCenter: number = baseX - centerX;
      const arcRadius: number = Math.max(distFromCenter, minArcRadius);
      const arcAngle: number = (amplitude * bendStrength) / arcRadius;
      const baseAngle: number = 0;
      const newAngle: number = baseAngle + arcAngle;

      const x: number = centerX + arcRadius * Math.cos(newAngle);
      const y: number = centerY + arcRadius * Math.sin(newAngle);

      allPoints.push({x, y, t}); // t=1 at center, t=0 at right edge
    }

    // Draw waveform with smooth gradient by drawing each segment with interpolated color
    this.drawGradientWaveform(ctx, allPoints, darkColor, lightColor);

    // Draw circular waveform at center using the brightest color
    this.drawCenterCircle(ctx, centerX, centerY, halfWidth * 0.12, lightColor);
  }

  private drawGradientWaveform(
    ctx: CanvasRenderingContext2D,
    points: Array<{x: number; y: number; t: number}>,
    darkColor: {r: number; g: number; b: number},
    lightColor: {r: number; g: number; b: number}
  ): void {
    if (points.length < 2) return;

    // Draw glow layer first (single color for performance)
    const midColor: {r: number; g: number; b: number} = this.lerpColor(darkColor, lightColor, 0.5);
    ctx.save();
    ctx.shadowBlur = 12;
    ctx.shadowColor = `rgba(${midColor.r}, ${midColor.g}, ${midColor.b}, 0.4)`;
    ctx.strokeStyle = `rgba(${midColor.r}, ${midColor.g}, ${midColor.b}, 0.2)`;
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

    // Draw main waveform with gradient - draw each small segment with interpolated color
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i: number = 0; i < points.length - 1; i++) {
      const p1: {x: number; y: number; t: number} = points[i];
      const p2: {x: number; y: number; t: number} = points[i + 1];

      // Interpolate color based on t value (0 = dark at edges, 1 = light at center)
      const avgT: number = (p1.t + p2.t) / 2;
      const color: {r: number; g: number; b: number} = this.lerpColor(darkColor, lightColor, avgT);

      ctx.strokeStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  }

  private lerpColor(
    c1: {r: number; g: number; b: number},
    c2: {r: number; g: number; b: number},
    t: number
  ): {r: number; g: number; b: number} {
    return {
      r: Math.round(c1.r + (c2.r - c1.r) * t),
      g: Math.round(c1.g + (c2.g - c1.g) * t),
      b: Math.round(c1.b + (c2.b - c1.b) * t)
    };
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
      const sample: number = (dataArray[sampleIndex] - 128) / 128;
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
}

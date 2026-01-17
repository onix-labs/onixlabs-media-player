import {Canvas2DVisualization, VisualizationConfig} from './visualization';

export class Water2Visualization extends Canvas2DVisualization {
  private readonly ROTATION_SPEED: number = 0.009;
  private readonly FADE_RATE: number = 0.008;
  private readonly BACKGROUND_DARKEN: number = 0.7; // Darken background rings
  private readonly HUE_CYCLE_SPEED: number = 0.15;  // Degrees per frame

  // Saturation and lightness levels for gradient (darkest to lightest)
  private readonly GRADIENT_LEVELS: Array<{s: number; l: number}> = [
    {s: 70, l: 15},  // Darkest
    {s: 65, l: 25},  // Dark
    {s: 60, l: 40},  // Mid
    {s: 55, l: 55},  // Light
    {s: 50, l: 70}   // Lightest
  ];

  private dataArray: Uint8Array<ArrayBuffer>;
  private frequencyData: Uint8Array<ArrayBuffer>;
  private circleCanvas: HTMLCanvasElement | null = null;
  private trailCanvas: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;

  // Hue cycling
  private hueOffset: number = 210; // Start at blue (210 degrees)

  // Bass/mid detection settings
  private readonly BASS_BINS: number = 16;          // Include bass and low-mids
  private readonly TRANSIENT_THRESHOLD: number = 15; // Minimum jump to detect a transient
  private readonly MIN_LEVEL: number = 50;           // Minimum level for transient to count
  private readonly DIRECTION_COOLDOWN: number = 1000; // Milliseconds before direction can change again
  private smoothedBass: number = 0;                 // Smoothed bass value
  private prevBass: number = 0;                     // Previous frame's bass for transient detection
  private rotationDirection: number = 1;            // Current rotation direction (1 or -1)
  private lastDirectionChange: number = 0;          // Timestamp of last direction change

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
    const centerX: number = width / 2;
    const centerY: number = height / 2;
    const gradientColors: Array<{r: number; g: number; b: number}> = this.getGradientColors();
    const numColors: number = gradientColors.length;
    const maxRadius: number = width / 2;

    // Clear to black
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, width, height);

    // The waveform has 9 segments (numColors * 2 - 1) with pattern: 0-1-2-3-4-3-2-1-0
    const totalSegments: number = numColors * 2 - 1; // 9 segments

    // Calculate ring boundaries as positions (0 = center, 1 = edge)
    // Rings go from outer (darkest) to inner (lightest)
    const ringPositions: number[] = [
      1.0,                              // Outer edge (darkest)
      7 / totalSegments,                // 7/9
      5 / totalSegments,                // 5/9
      3 / totalSegments,                // 3/9
      1 / totalSegments,                // 1/9 (lightest center)
      0                                 // Center point
    ];

    // Create radial gradient with soft transitions between rings
    const gradient: CanvasGradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, maxRadius);
    const darken: number = this.BACKGROUND_DARKEN;
    const blendZone: number = 0.015; // Size of soft transition between rings

    // Add color stops from center outward (gradient position 0 = center, 1 = edge)
    for (let i: number = numColors - 1; i >= 0; i--) {
      const color: {r: number; g: number; b: number} = gradientColors[i];
      const r: number = Math.round(color.r * darken);
      const g: number = Math.round(color.g * darken);
      const b: number = Math.round(color.b * darken);
      const colorStr: string = `rgb(${r}, ${g}, ${b})`;

      const innerPos: number = ringPositions[i + 1]; // Inner edge of this ring
      const outerPos: number = ringPositions[i];     // Outer edge of this ring

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
    const centerX: number = width / 2;
    const centerY: number = height / 2;

    // Cycle hue through the spectrum
    this.hueOffset = (this.hueOffset + this.HUE_CYCLE_SPEED) % 360;

    // Ensure canvases exist
    if (!this.circleCanvas || !this.trailCanvas || !this.trailCtx) {
      this.onResize();
    }

    // Re-render background with current hue
    this.renderCirclesToCanvas(this.circleCanvas!.getContext('2d')!);

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

    // Analyze bass/mid frequencies to detect transients
    this.analyser.getByteFrequencyData(this.frequencyData);
    let bassSum: number = 0;
    for (let i: number = 0; i < this.BASS_BINS; i++) {
      bassSum += this.frequencyData[i];
    }
    const bassAvg: number = bassSum / this.BASS_BINS;

    // Detect transient: sudden increase in bass/mid
    const bassIncrease: number = bassAvg - this.prevBass;
    this.prevBass = bassAvg;

    // Light smoothing
    this.smoothedBass = this.smoothedBass * 0.5 + bassAvg * 0.5;

    // Check if we can change direction (cooldown elapsed)
    const now: number = performance.now();
    const canChangeDirection: boolean = (now - this.lastDirectionChange) > this.DIRECTION_COOLDOWN;

    // Flip direction on loud transients (only if cooldown has passed)
    const isTransient: boolean = bassIncrease > this.TRANSIENT_THRESHOLD && bassAvg > this.MIN_LEVEL;
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
    const gradientColors: Array<{r: number; g: number; b: number}> = this.getGradientColors();
    const numColors: number = gradientColors.length;

    // Calculate all points first
    const allPoints: Array<{x: number; y: number}> = [];
    const halfWidth: number = width / 2;
    const samplesPerHalf: number = Math.floor(dataArray.length / 2);

    // Arc bending settings
    // Minimum radius prevents singularity at center and controls max bend tightness
    const minArcRadius: number = halfWidth * 0.12;
    const bendStrength: number = 1.2;  // Multiplier for arc effect

    // Left half points (from left edge to center)
    for (let i: number = 0; i < samplesPerHalf; i++) {
      const sample: number = (dataArray[i] - 128) / 128;
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
      const sample: number = (dataArray[i] - 128) / 128;
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

    // Total segments: 5 colors on left (darkest to lightest), 5 colors on right (lightest to darkest)
    // That's 10 segments total, but the center shares the lightest color
    const totalSegments: number = numColors * 2 - 1; // 9 segments: 0-1-2-3-4-3-2-1-0
    const pointsPerSegment: number = Math.floor(allPoints.length / totalSegments);
    const centerSegmentIndex: number = numColors - 1; // Index 4 = center segment

    // Draw each segment with its color, but skip the center segment
    for (let seg: number = 0; seg < totalSegments; seg++) {
      // Skip the center segment - we'll draw a circle there instead
      if (seg === centerSegmentIndex) continue;

      // Determine color index: 0,1,2,3,4,3,2,1,0
      let colorIndex: number;
      if (seg < numColors) {
        colorIndex = seg;
      } else {
        colorIndex = totalSegments - 1 - seg;
      }

      const color: {r: number; g: number; b: number} = gradientColors[colorIndex];
      const startIdx: number = seg * pointsPerSegment;
      const endIdx: number = seg === totalSegments - 1 ? allPoints.length : (seg + 1) * pointsPerSegment + 1;

      const segmentPoints: Array<{x: number; y: number}> = allPoints.slice(startIdx, endIdx);
      if (segmentPoints.length < 2) continue;

      this.drawWaveformSegment(ctx, segmentPoints, color);
    }

    // Draw circular waveform at center using the brightest color
    this.drawCenterCircle(ctx, centerX, centerY, halfWidth * 0.12, gradientColors[numColors - 1]);
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
    for (let i: number = 1; i < points.length; i++) {
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
    for (let i: number = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();

    // Draw highlight
    ctx.strokeStyle = `rgba(${Math.min(255, color.r + 60)}, ${Math.min(255, color.g + 40)}, ${Math.min(255, color.b + 20)}, 0.5)`;
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i: number = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }
}

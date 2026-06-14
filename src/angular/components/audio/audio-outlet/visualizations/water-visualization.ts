/**
 * @fileoverview Water visualization.
 *
 * Baseline: draws ONLY the concentric filled rings - a Tower of Hanoi viewed
 * top-down: a stack of color bands, bright at the center and darker at each step
 * outward. All other elements (waveforms, trails, center circle, reactivity)
 * have been removed; they will be layered back on as needed.
 *
 * The ring stack is rendered once at a fixed reference hue, then the composited
 * canvas is re-tinted each frame with a hue-rotate filter so the single on-screen
 * hue slowly cycles through the spectrum.
 *
 * @module app/components/audio/audio-outlet/visualizations/water-visualization
 */

import {Canvas2DVisualization, OffscreenCanvasPair, VisualizationConfig} from './visualization';

/**
 * Water visualization - concentric ring baseline.
 */
export class WaterVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Water';
  public readonly category: string = 'Waves';

  // ===========================================================================
  // Configuration constants
  // ===========================================================================

  // --- Background concentric rings -------------------------------------------
  // Multiplier darkening the gradient when painted, the ring-edge blur (as a
  // fraction of the radius; 0 = crisp), and the per-band saturation/lightness
  // levels (outer dark -> inner bright). GRADIENT_LEVELS.length is the number
  // of concentric circles.
  private readonly BACKGROUND_DARKEN: number = 0.9;
  private readonly RING_BLUR_FRACTION: number = 0.01;
  private readonly GRADIENT_LEVELS: ReadonlyArray<{s: number; l: number}> = [
    {s: 70, l: 15},
    {s: 65, l: 26},
    {s: 60, l: 37},
    {s: 55, l: 48},
    {s: 50, l: 59},
    {s: 45, l: 70}
  ];

  // --- Hue & color cycling ---------------------------------------------------
  // The rings are rendered at a single fixed reference hue, then the whole
  // composited canvas is re-tinted each frame with a hue-rotate filter, sweeping
  // that single hue through the spectrum.
  private readonly DEFAULT_HUE: number = 210;
  private readonly HUE_CYCLE_SPEED: number = 0.15;

  // --- Horizontal waveform ---------------------------------------------------
  // A mirrored oscilloscope across the middle. Each sample bends the line around
  // the center; the arc radius is clamped to CENTER_RADIUS_FRACTION of the
  // half-width so both halves converge on the central ring's edge and stop there
  // (the waveform routes around the center "like light around a black hole"
  // rather than crossing it). Drawn in a SINGLE bright color at the current
  // display hue, with the standard glow.
  private readonly SHOW_HORIZONTAL_WAVEFORM: boolean = true;
  private readonly WAVEFORM_SAMPLES: number = 256;
  private readonly CENTER_RADIUS_FRACTION: number = 0.1;
  private readonly WAVEFORM_AMPLITUDE_FRACTION: number = 0.3;
  private readonly WAVEFORM_BEND_STRENGTH: number = 1.2;
  private readonly WAVEFORM_SATURATION: number = 60;
  private readonly WAVEFORM_LIGHTNESS: number = 60;

  // --- Swirl trail -----------------------------------------------------------
  // The waveform is stamped onto a trail canvas that is rotated a little and
  // faded each frame, so it spins and trails off. Because the waveform is point-
  // symmetric, the single rotation makes each side appear to swirl away in the
  // opposite direction. ROTATION_SPEED is radians/frame (kept slow);
  // TRAIL_FADE_STEP is a per-frame LINEAR alpha subtraction (0-255). Subtracting
  // a fixed amount drives every pixel to exactly 0, so the trail dissolves
  // gradually (blending into the rings as it goes) and then disappears
  // completely. A multiplicative fade can't do this: it stalls at a low-alpha
  // floor (8-bit rounding) and, re-stamped each frame, builds a permanent bright
  // smear. Higher = shorter trail.
  private readonly ROTATION_SPEED: number = 0.004;
  private readonly TRAIL_FADE_STEP: number = 1;

  // ===========================================================================
  // Mutable runtime state
  // ===========================================================================

  // Fixed reference hue the scene is rendered at, with gradient-color caching.
  private readonly baseHue: number = this.DEFAULT_HUE;
  private cachedHue: number = -1;
  private cachedGradientColors: Array<{r: number; g: number; b: number}> = [];
  // Single waveform color, rendered at the fixed base hue (re-tinted at composite
  // time by the hue filter, like the rings).
  private cachedWaveColor: {r: number; g: number; b: number} = {r: 255, g: 255, b: 255};

  // Display-time hue rotation (degrees), advanced each frame to cycle the
  // single on-screen hue through the spectrum.
  private hueRotation: number = 0;

  // Carried sub-integer remainder of the linear trail fade between frames, so a
  // fractional effective step (after the trail-intensity multiplier) fades
  // slower than the 1-alpha-per-frame floor of a plain integer subtraction.
  private trailFadeAccum: number = 0;

  // Ring canvas - created once, re-rendered only when the reference hue changes.
  private circleCanvas: HTMLCanvasElement | null = null;
  private circleCtx: CanvasRenderingContext2D | null = null;
  // Trail canvas (waveform spins + fades here) and a temp canvas for the copy.
  private trailCanvas: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  // Audio time-domain buffer and pre-allocated mirrored-waveform points
  // (left half + right half = WAVEFORM_SAMPLES * 2).
  private dataArray: Uint8Array<ArrayBuffer>;
  private readonly allPoints: Array<{x: number; y: number}>;

  // Pre-computed values (updated on resize)
  private centerX: number = 0;
  private centerY: number = 0;
  private maxRadius: number = 0;
  private halfWidth: number = 0;
  private minArcRadius: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.allPoints = new Array(this.WAVEFORM_SAMPLES * 2);
    for (let i: number = 0; i < this.WAVEFORM_SAMPLES * 2; i++) {
      this.allPoints[i] = {x: 0, y: 0};
    }
    this.sensitivity = 0.3;
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  // Cache gradient colors - only recalculate when the hue changes by >= 1 degree
  private updateGradientColors(): boolean {
    const hueInt: number = Math.floor(this.baseHue);
    if (hueInt === this.cachedHue) return false;

    this.cachedHue = hueInt;
    this.cachedGradientColors = this.GRADIENT_LEVELS.map(
      (level: {s: number; l: number}): {r: number; g: number; b: number} =>
        this.hslToRgb(this.baseHue, level.s, level.l)
    );
    this.cachedWaveColor = this.hslToRgb(this.baseHue, this.WAVEFORM_SATURATION, this.WAVEFORM_LIGHTNESS);
    return true;
  }

  protected override onResize(): void {
    // Pre-compute geometry values
    this.centerX = this.width * 0.5;
    this.centerY = this.height * 0.5;
    this.maxRadius = this.width * 0.5;
    this.halfWidth = this.width * 0.5;
    this.minArcRadius = this.halfWidth * this.CENTER_RADIUS_FRACTION;

    // Create ring canvas if needed (re-rendered only when hue changes).
    if (!this.circleCanvas) {
      this.circleCanvas = document.createElement('canvas');
      this.circleCtx = this.circleCanvas.getContext('2d')!;
    }
    this.circleCanvas.width = this.width;
    this.circleCanvas.height = this.height;

    // Create the trail + temp canvases if needed. The trail is read back via
    // fadeTrailLinear (getImageData) every frame, so willReadFrequently keeps it
    // CPU-side instead of stalling the GPU.
    if (!this.trailCanvas) {
      this.trailCanvas = document.createElement('canvas');
      this.trailCtx = this.trailCanvas.getContext('2d', {alpha: true, willReadFrequently: true})!;
    }
    if (!this.tempCanvas) {
      const pair: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.tempCanvas = pair.canvas;
      this.tempCtx = pair.ctx;
    }
    this.trailCanvas.width = this.width;
    this.trailCanvas.height = this.height;
    this.tempCanvas.width = this.width;
    this.tempCanvas.height = this.height;

    // Force re-render of the rings on the next frame.
    this.cachedHue = -1;

    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  private renderCirclesToCanvas(): void {
    const ctx: CanvasRenderingContext2D = this.circleCtx!;
    const width: number = this.width;
    const height: number = this.height;
    const centerX: number = this.centerX;
    const centerY: number = this.centerY;
    const maxRadius: number = this.maxRadius;
    const gradientColors: Array<{r: number; g: number; b: number}> = this.cachedGradientColors;
    const numColors: number = gradientColors.length;

    ctx.clearRect(0, 0, width, height);

    // Ring boundary positions (as a fraction of maxRadius), from the outer rim
    // (1.0) inward to the center (0). Interior rings sit at the odd multiples
    // of 1/totalSegments: (totalSegments - 2i)/totalSegments.
    const totalSegments: number = numColors * 2 - 1;
    const ringPositions: number[] = new Array(numColors + 1);
    ringPositions[0] = 1.0;
    ringPositions[numColors] = 0;
    for (let i: number = 1; i < numColors; i++) {
      ringPositions[i] = (totalSegments - 2 * i) / totalSegments;
    }

    const gradient: CanvasGradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, maxRadius);
    const darken: number = this.BACKGROUND_DARKEN;
    const blendZone: number = 0.015;

    // Fill background with a darker shade than the outermost gradient color.
    const outerColor: {r: number; g: number; b: number} = gradientColors[0];
    const bgDarken: number = darken * 0.5;
    const outerR: number = (outerColor.r * bgDarken + 0.5) | 0;
    const outerG: number = (outerColor.g * bgDarken + 0.5) | 0;
    const outerB: number = (outerColor.b * bgDarken + 0.5) | 0;
    ctx.fillStyle = `rgb(${outerR},${outerG},${outerB})`;
    ctx.fillRect(0, 0, width, height);

    for (let i: number = numColors - 1; i >= 0; i--) {
      const color: {r: number; g: number; b: number} = gradientColors[i];
      const r: number = (color.r * darken + 0.5) | 0;
      const g: number = (color.g * darken + 0.5) | 0;
      const b: number = (color.b * darken + 0.5) | 0;
      const colorStr: string = `rgb(${r},${g},${b})`;

      const innerPos: number = ringPositions[i + 1];
      const outerPos: number = ringPositions[i];

      gradient.addColorStop(Math.min(1, innerPos + blendZone), colorStr);
      gradient.addColorStop(Math.max(0, outerPos - blendZone), colorStr);
    }

    // Blur the rings to soften the boundaries between them. The arc is drawn
    // slightly oversized so the blur feather doesn't expose the background at
    // the rim.
    const blurPx: number = maxRadius * this.RING_BLUR_FRACTION;
    ctx.save();
    if (blurPx > 0) {
      ctx.filter = `blur(${blurPx}px)`;
    }
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(centerX, centerY, maxRadius + blurPx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;

    // Refresh cached colors (only recomputes when the reference hue changes).
    const colorsChanged: boolean = this.updateGradientColors();

    // Advance the display-time tint so the single on-screen hue cycles.
    this.hueRotation = (this.hueRotation + this.HUE_CYCLE_SPEED) % 360;

    // Ensure all canvases exist.
    if (!this.circleCanvas || !this.circleCtx || !this.trailCanvas || !this.trailCtx ||
        !this.tempCanvas || !this.tempCtx) {
      this.onResize();
    }

    // Only re-render the rings when the reference hue actually changes.
    if (colorsChanged) {
      this.renderCirclesToCanvas();
    }

    const hueFilter: string = `hue-rotate(${this.hueRotation}deg)`;

    // Composite the rings, re-tinted by the cycling hue filter.
    ctx.save();
    ctx.filter = hueFilter;
    ctx.drawImage(this.circleCanvas!, 0, 0);
    ctx.restore();

    // Swirl trail: spin the existing trail a little and fade it, then stamp the
    // fresh waveform on top. The trail is rendered at the fixed base hue and
    // re-tinted at composite time, so the whole trail shows one cycling hue.
    const trailCtx: CanvasRenderingContext2D = this.trailCtx!;
    const tempCtx: CanvasRenderingContext2D = this.tempCtx!;
    const width: number = this.width;
    const height: number = this.height;

    // Spin the existing trail at full strength (no fade here), then stamp the
    // fresh waveform on top.
    tempCtx.clearRect(0, 0, width, height);
    tempCtx.drawImage(this.trailCanvas!, 0, 0);

    trailCtx.clearRect(0, 0, width, height);
    trailCtx.save();
    trailCtx.translate(this.centerX, this.centerY);
    trailCtx.rotate(this.ROTATION_SPEED);
    trailCtx.translate(-this.centerX, -this.centerY);
    trailCtx.drawImage(this.tempCanvas!, 0, 0);
    trailCtx.restore();

    this.analyser.getByteTimeDomainData(this.dataArray);
    this.computeMirroredWaveform();
    this.drawHorizontalWaveform(trailCtx);

    // Linearly subtract alpha from the whole trail so it dissolves into the
    // rings and fully disappears (no permanent floor). The trail-intensity
    // multiplier may make the step fractional, so bank the remainder.
    this.trailFadeAccum += this.TRAIL_FADE_STEP * this.getFadeMultiplier();
    const fadeStep: number = Math.floor(this.trailFadeAccum);
    if (fadeStep > 0) {
      this.trailFadeAccum -= fadeStep;
      this.fadeTrailLinear(trailCtx, fadeStep);
    }

    // Composite the trail over the rings with the cycling hue filter.
    ctx.save();
    ctx.filter = hueFilter;
    ctx.drawImage(this.trailCanvas!, 0, 0);
    ctx.restore();

    this.applyFadeOverlay();
  }

  /**
   * Linearly fades a trail layer toward fully transparent.
   *
   * Subtracts a fixed `step` from every pixel's alpha each frame. Unlike a
   * multiplicative fade - which asymptotically approaches but never reaches zero
   * (8-bit rounding leaves a stuck low-alpha floor) - a constant subtraction
   * drives every pixel to exactly 0, so the trail dissolves and disappears.
   */
  private fadeTrailLinear(ctx: CanvasRenderingContext2D, step: number): void {
    const width: number = this.width;
    const height: number = this.height;
    if (width <= 0 || height <= 0) return;

    const imageData: ImageData = ctx.getImageData(0, 0, width, height);
    const data: Uint8ClampedArray = imageData.data;

    // Alpha is at index 3, 7, 11, ... (every 4th byte starting at 3).
    for (let i: number = 3; i < data.length; i += 4) {
      const a: number = data[i];
      if (a > 0) {
        data[i] = a > step ? a - step : 0;
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  /**
   * Computes the mirrored horizontal waveform points into allPoints.
   *
   * The left half runs from the left edge inward to the central ring; the right
   * half mirrors it from the central ring out to the right edge. Each sample
   * bends the line around the center by a small arc angle, and the arc radius is
   * clamped to minArcRadius so both halves converge exactly on the central ring's
   * edge (and stop there - they never cross the center).
   */
  private computeMirroredWaveform(): void {
    const width: number = this.width;
    const height: number = this.height;
    const centerX: number = this.centerX;
    const centerY: number = this.centerY;
    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;
    const dataLength: number = dataArray.length;

    const halfWidth: number = this.halfWidth;
    const minArcRadius: number = this.minArcRadius;
    const samplesPerHalf: number = this.WAVEFORM_SAMPLES;
    const bendStrength: number = this.WAVEFORM_BEND_STRENGTH;
    const sensitivityFactor: number = this.sensitivityFactor;
    const amplitudeScale: number = height * this.WAVEFORM_AMPLITUDE_FRACTION;
    const sampleStep: number = (dataLength * 0.5) / samplesPerHalf;

    // Left half (left edge -> center).
    for (let i: number = 0; i < samplesPerHalf; i++) {
      const dataIndex: number = (i * sampleStep) | 0;
      const sample: number = ((dataArray[dataIndex] - 128) / 128) * sensitivityFactor;
      const amplitude: number = sample * amplitudeScale;
      const t: number = i / (samplesPerHalf - 1);
      const baseX: number = t * halfWidth;

      const distFromCenter: number = centerX - baseX;
      const arcRadius: number = distFromCenter > minArcRadius ? distFromCenter : minArcRadius;
      const arcAngle: number = (amplitude * bendStrength) / arcRadius;
      const newAngle: number = Math.PI - arcAngle;

      this.allPoints[i].x = centerX + arcRadius * Math.cos(newAngle);
      this.allPoints[i].y = centerY + arcRadius * Math.sin(newAngle);
    }

    // Right half (center -> right edge), mirrored.
    for (let i: number = samplesPerHalf - 1; i >= 0; i--) {
      const dataIndex: number = (i * sampleStep) | 0;
      const sample: number = ((dataArray[dataIndex] - 128) / 128) * sensitivityFactor;
      const amplitude: number = sample * amplitudeScale;
      const t: number = i / (samplesPerHalf - 1);
      const baseX: number = width - t * halfWidth;

      const distFromCenter: number = baseX - centerX;
      const arcRadius: number = distFromCenter > minArcRadius ? distFromCenter : minArcRadius;
      const arcAngle: number = (amplitude * bendStrength) / arcRadius;

      const pointIndex: number = samplesPerHalf + (samplesPerHalf - 1 - i);
      // Negated y offset flips the right half vertically, making it point-
      // symmetric with the left (mirrored on both axes through the center).
      this.allPoints[pointIndex].x = centerX + arcRadius * Math.cos(arcAngle);
      this.allPoints[pointIndex].y = centerY - arcRadius * Math.sin(arcAngle);
    }
  }

  /**
   * Draws the mirrored horizontal waveform in a single color. The left and right
   * halves are stroked as separate paths so the line stops at the central ring
   * on each side instead of joining across the center.
   */
  private drawHorizontalWaveform(ctx: CanvasRenderingContext2D): void {
    if (!this.SHOW_HORIZONTAL_WAVEFORM) return;

    const samplesPerHalf: number = this.WAVEFORM_SAMPLES;
    // Fixed base-hue color; the cycling hue is applied to the whole trail at
    // composite time, keeping every trail frame a single on-screen hue.
    const color: {r: number; g: number; b: number} = this.cachedWaveColor;

    // Left half: indices [0 .. samplesPerHalf - 1].
    this.strokeWavePath(ctx, 0, samplesPerHalf - 1, color);
    // Right half: indices [samplesPerHalf .. 2 * samplesPerHalf - 1].
    this.strokeWavePath(ctx, samplesPerHalf, samplesPerHalf * 2 - 1, color);
  }

  /**
   * Strokes a smooth sub-path of allPoints (inclusive index range) with the
   * three-layer glow / main / highlight treatment in the given color.
   */
  private strokeWavePath(
    ctx: CanvasRenderingContext2D,
    startIdx: number,
    endIdx: number,
    color: {r: number; g: number; b: number}
  ): void {
    if (endIdx - startIdx < 1) return;

    const points: Array<{x: number; y: number}> = this.allPoints;
    const mainColor: string = `rgb(${color.r}, ${color.g}, ${color.b})`;
    const glowColor: string = `rgba(${color.r}, ${color.g}, ${color.b}, 0.6)`;
    const highlightColor: string = `rgba(${Math.min(255, color.r + 60)}, ${Math.min(255, color.g + 40)}, ${Math.min(255, color.b + 20)}, 0.5)`;

    const buildPath: () => void = (): void => {
      this.buildSmoothPath(ctx, points, endIdx, startIdx);
    };

    const glowBlur: number = this.getScaledGlowBlur(15);

    // Glow layer
    ctx.save();
    ctx.shadowBlur = glowBlur;
    ctx.shadowColor = glowColor;
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, 0.3)`;
    ctx.lineWidth = this.lineWidth + 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    buildPath();
    ctx.stroke();
    ctx.restore();

    // Main waveform
    ctx.strokeStyle = mainColor;
    ctx.lineWidth = this.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    buildPath();
    ctx.stroke();

    // Highlight
    ctx.strokeStyle = highlightColor;
    ctx.lineWidth = 1;
    buildPath();
    ctx.stroke();
  }

  public override destroy(): void {
    this.circleCanvas = null;
    this.circleCtx = null;
    this.trailCanvas = null;
    this.trailCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }
}

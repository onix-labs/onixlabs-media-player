/**
 * @fileoverview Water visualization with reactive rotation.
 *
 * An ambient visualization featuring mirrored curved waveforms over
 * a radial gradient background. The rotation direction changes based
 * on bass transients detected in the audio, creating a reactive feel.
 *
 * Technical details:
 * - Radial gradient background with color bands
 * - Mirrored waveforms with segment coloring
 * - Central circle at the focal point
 * - Bass transient detection for rotation direction changes
 * - HSL color cycling with smooth transitions
 * - Optimized canvas reuse pattern
 *
 * Audio reactivity:
 * - Monitors bass frequencies (first 16 FFT bins)
 * - Detects sudden increases (transients)
 * - Reverses rotation direction on strong transients
 * - Cooldown prevents rapid direction changes
 *
 * @module app/components/audio/audio-outlet/visualizations/water-visualization
 */

import {Canvas2DVisualization, OffscreenCanvasPair, VisualizationConfig} from './visualization';

/**
 * Water visualization with bass-reactive rotation.
 *
 * Renders curved waveforms over a radial gradient, with rotation
 * direction that changes based on bass transients in the audio.
 */
export class WaterVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Water';
  public readonly category: string = 'Waves';

  private readonly ROTATION_SPEED: number = 0.009;
  private readonly FADE_RATE: number = 0.008;
  private readonly BACKGROUND_DARKEN: number = 0.7;

  // Gaussian blur applied to the concentric circles, as a fraction of the
  // radius, to soften the boundaries between rings. 0 = crisp edges.
  private readonly RING_BLUR_FRACTION: number = 0.03;

  // The scene (rings, waveform, trails) is rendered at a single fixed reference
  // hue, then the entire composited canvas is re-tinted each frame with a
  // hue-rotate filter. Because the tint is applied uniformly at display time,
  // the whole canvas is always ONE hue - including the slow-fading trails,
  // which are stored at the reference hue and rotated along with everything
  // else. Cycling the rotation sweeps that single hue through the spectrum
  // (all-blue, then all-purple, ...), never mixing two hues on screen at once.
  private readonly DEFAULT_HUE: number = 210;
  private readonly HUE_CYCLE_SPEED: number = 0.15;

  // Trail "collapse": the waveform is split into segments at the concentric
  // circle boundaries. As the spinning trail fades, each radial slice is
  // nudged toward the nearest boundary, so the pieces collapse onto the rings
  // as they fade. More bands = a smoother collapse but a higher per-frame cost.
  private readonly COLLAPSE_BANDS: number = 20;
  private readonly COLLAPSE_RATE: number = 0.05;

  // Balanced sample counts for performance
  private readonly WAVEFORM_SAMPLES: number = 256;
  private readonly CENTER_CIRCLE_POINTS: number = 64;

  // Saturation and lightness levels for gradient (outer dark -> inner bright).
  // The array length is the number of concentric circles.
  private readonly GRADIENT_LEVELS: ReadonlyArray<{s: number; l: number}> = [
    {s: 70, l: 15},
    {s: 67, l: 24},
    {s: 64, l: 33},
    {s: 60, l: 42},
    {s: 57, l: 51},
    {s: 53, l: 61},
    {s: 50, l: 70}
  ];

  // The waveform sections reuse the ring hues/saturations but spread their
  // lightness across a wider range than the background rings, so each section
  // reads as a clearly distinct shade. Lightness is ramped linearly between
  // these bounds across the bands (outer dark -> inner bright).
  private readonly WAVEFORM_LIGHTNESS_MIN: number = 8;
  private readonly WAVEFORM_LIGHTNESS_MAX: number = 98;

  private dataArray: Uint8Array<ArrayBuffer>;
  private frequencyData: Uint8Array<ArrayBuffer>;

  // Canvases - created once, reused each frame
  private circleCanvas: HTMLCanvasElement | null = null;
  private circleCtx: CanvasRenderingContext2D | null = null;
  private trailCanvas: HTMLCanvasElement | null = null;
  private trailCtx: CanvasRenderingContext2D | null = null;
  private tempCanvas: HTMLCanvasElement | null = null;
  private tempCtx: CanvasRenderingContext2D | null = null;

  // Fixed reference hue the scene is rendered at, with gradient-color caching.
  private baseHue: number = this.DEFAULT_HUE;
  private cachedHue: number = -1;
  private cachedGradientColors: Array<{r: number; g: number; b: number}> = [];
  // Higher-contrast lightness ramp used for the waveform sections.
  private cachedWaveformColors: Array<{r: number; g: number; b: number}> = [];

  // Display-time hue rotation (degrees), advanced each frame to cycle the
  // single on-screen hue through the spectrum.
  private hueRotation: number = 0;

  // Bass/mid detection settings
  private readonly BASS_BINS: number = 16;
  private readonly TRANSIENT_THRESHOLD: number = 15;
  private readonly MIN_LEVEL: number = 50;
  private readonly DIRECTION_COOLDOWN: number = 5000;
  // A bass transient can also trigger a sudden complete color shift, gated to
  // at most once per cooldown. The shift jumps the display hue by a large
  // amount (e.g. blue -> red) on top of the slow cycle.
  private readonly COLOR_SHIFT_COOLDOWN: number = 10000;
  private readonly COLOR_SHIFT_DEGREES: number = 150;
  // On a color shift, the lightness of the background and center circle is
  // inverted (white background + dark center) and animates back to normal
  // (dark background + light center) over this duration.
  private readonly COLOR_SNAP_DURATION: number = 1500;
  private smoothedBass: number = 0;
  private prevBass: number = 0;
  private rotationDirection: number = 1;
  private lastDirectionChange: number = 0;
  private lastColorShift: number = 0;
  // 1 at the instant of a color shift, easing to 0 as the invert resolves.
  private colorSnapProgress: number = 0;

  // Pre-allocated arrays to avoid GC pressure
  private readonly allPoints: Array<{x: number; y: number}>;
  private readonly centerPoints: Array<{x: number; y: number}>;
  // Gradient color band each waveform point falls in (by radius from center).
  private readonly pointBands: Int8Array;

  // Pre-computed values (updated on resize)
  private centerX: number = 0;
  private centerY: number = 0;
  private halfWidth: number = 0;
  private minArcRadius: number = 0;
  private baseCircleRadius: number = 0;
  private maxRadius: number = 0;
  // Radii of the concentric circle boundaries (outer edge of each color band),
  // sorted ascending. Used to segment the waveform and as the attractors the
  // fading trail collapses onto.
  private boundaryRadii: number[] = [];

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;

    // Pre-allocate point arrays (left half + right half = WAVEFORM_SAMPLES * 2)
    this.allPoints = new Array(this.WAVEFORM_SAMPLES * 2);
    this.centerPoints = new Array(this.CENTER_CIRCLE_POINTS + 1);
    this.pointBands = new Int8Array(this.WAVEFORM_SAMPLES * 2);

    for (let i: number = 0; i < this.WAVEFORM_SAMPLES * 2; i++) {
      this.allPoints[i] = {x: 0, y: 0};
    }
    for (let i: number = 0; i <= this.CENTER_CIRCLE_POINTS; i++) {
      this.centerPoints[i] = {x: 0, y: 0};
    }

    this.sensitivity = 0.3;
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
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

    // Waveform sections: same hue/saturation per band, but lightness ramped
    // across a wider range so each section is a more distinct shade.
    const lastBand: number = this.GRADIENT_LEVELS.length - 1;
    const lMin: number = this.WAVEFORM_LIGHTNESS_MIN;
    const lRange: number = this.WAVEFORM_LIGHTNESS_MAX - lMin;
    this.cachedWaveformColors = this.GRADIENT_LEVELS.map(
      (level: {s: number; l: number}, i: number): {r: number; g: number; b: number} =>
        this.hslToRgb(this.baseHue, level.s, lMin + (lRange * i) / lastBand)
    );
    return true;
  }

  /**
   * Sets the single hue used to tint the entire visualization.
   *
   * @param hue - Hue in degrees; wrapped into the range [0, 360).
   */
  public setHue(hue: number): void {
    this.baseHue = ((hue % 360) + 360) % 360;
  }

  /** Gets the current tint hue in degrees. */
  public getHue(): number {
    return this.baseHue;
  }

  protected override onResize(): void {
    // Pre-compute geometry values
    this.centerX = this.width * 0.5;
    this.centerY = this.height * 0.5;
    this.halfWidth = this.width * 0.5;
    this.minArcRadius = this.halfWidth * 0.12;
    this.baseCircleRadius = this.halfWidth * 0.12;
    this.maxRadius = this.halfWidth;

    // Boundary radii (outer edge of each color band) match the gradient stops
    // used by renderCirclesToCanvas: n/totalSegments of maxRadius for the inner
    // rings, plus maxRadius for the outermost. Sorted ascending.
    const totalSegments: number = this.GRADIENT_LEVELS.length * 2 - 1;
    this.boundaryRadii = [];
    for (let n: number = 1; n < totalSegments; n += 2) {
      this.boundaryRadii.push((this.maxRadius * n) / totalSegments);
    }
    this.boundaryRadii.push(this.maxRadius);

    // Create circle canvas if needed (re-rendered only when hue changes)
    if (!this.circleCanvas) {
      this.circleCanvas = document.createElement('canvas');
      this.circleCtx = this.circleCanvas.getContext('2d')!;
    }
    // Circle canvas is fully re-rendered each hue change, no need to preserve
    this.circleCanvas.width = this.width;
    this.circleCanvas.height = this.height;

    // Create trail canvas if needed
    if (!this.trailCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.trailCanvas = offscreen.canvas;
      this.trailCtx = offscreen.ctx;
    }

    // Create temp canvas if needed
    if (!this.tempCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.tempCanvas = offscreen.canvas;
      this.tempCtx = offscreen.ctx;
    }

    // Resize trail canvas while preserving content
    this.resizeCanvasPreserving(this.trailCanvas, this.trailCtx!, this.width, this.height);
    // Temp canvas doesn't need content preserved (it's just working space)
    this.tempCanvas.width = this.width;
    this.tempCanvas.height = this.height;

    // Force re-render of background on next frame
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

    // Fill background with a darker shade than the outermost gradient color
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
    // the rim. Only the ring canvas is blurred; the waveform/trails are not.
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
    const width: number = this.width;
    const height: number = this.height;
    const centerX: number = this.centerX;
    const centerY: number = this.centerY;

    // Refresh cached colors (only recomputes when the reference hue changes).
    const colorsChanged: boolean = this.updateGradientColors();

    // Advance the display-time tint so the single on-screen hue cycles.
    this.hueRotation = (this.hueRotation + this.HUE_CYCLE_SPEED) % 360;

    // Ensure canvases exist
    if (!this.circleCanvas || !this.trailCanvas || !this.trailCtx || !this.tempCanvas || !this.tempCtx) {
      this.onResize();
    }

    // Only re-render background when hue actually changes
    if (colorsChanged) {
      this.renderCirclesToCanvas();
    }

    const trailCtx: CanvasRenderingContext2D = this.trailCtx!;
    const trailCanvas: HTMLCanvasElement = this.trailCanvas!;
    const tempCtx: CanvasRenderingContext2D = this.tempCtx!;
    const tempCanvas: HTMLCanvasElement = this.tempCanvas!;

    // Copy current trails to temp canvas (reused, not recreated)
    tempCtx.clearRect(0, 0, width, height);
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

    const bassIncrease: number = bassAvg - this.prevBass;
    this.prevBass = bassAvg;
    this.smoothedBass = this.smoothedBass * 0.5 + bassAvg * 0.5;

    const now: number = performance.now();
    const canChangeDirection: boolean = (now - this.lastDirectionChange) > this.DIRECTION_COOLDOWN;
    const canShiftColor: boolean = (now - this.lastColorShift) > this.COLOR_SHIFT_COOLDOWN;
    const isTransient: boolean = bassIncrease > this.TRANSIENT_THRESHOLD && bassAvg > this.MIN_LEVEL;

    // A bass transient changes rotation direction at most once every
    // DIRECTION_COOLDOWN. Rotation can change on its own.
    const rotationChanged: boolean = isTransient && canChangeDirection;
    if (rotationChanged) {
      this.rotationDirection *= -1;
      this.lastDirectionChange = now;
    }

    // A sudden complete color shift jumps the display-time tint, instantly
    // recoloring everything on screen - rings, waveform, and existing trails.
    // It happens at most once every COLOR_SHIFT_COOLDOWN and never without an
    // accompanying rotation change, so a snap always coincides with a spin flip.
    if (rotationChanged && canShiftColor) {
      this.hueRotation = (this.hueRotation + this.COLOR_SHIFT_DEGREES) % 360;
      this.lastColorShift = now;
    }

    // Invert progress for the color-snap flash: 1 at the shift, easing to 0.
    this.colorSnapProgress = this.lastColorShift > 0
      ? Math.max(0, 1 - (now - this.lastColorShift) / this.COLOR_SNAP_DURATION)
      : 0;

    // Draw back previous trails with rotation, fade, and a radial collapse
    // toward the nearest concentric circle boundary.
    // Apply trail intensity multiplier to fade rate.
    const effectiveFadeRate: number = this.FADE_RATE * this.getFadeMultiplier();
    const rotation: number = this.ROTATION_SPEED * this.rotationDirection;
    this.drawCollapseFeedback(trailCtx, tempCanvas, centerX, centerY, rotation, 1 - effectiveFadeRate);

    // Get waveform data
    this.analyser.getByteTimeDomainData(this.dataArray);

    // Draw the mirrored waveforms
    this.drawMirroredWaveform(trailCtx, centerX, centerY);

    // Composite - circles background, then trails on top. The hue-rotate
    // filter re-tints the whole composited image uniformly, so every pixel
    // (including older trail pixels) shows the same cycling hue.
    const hueFilter: string = `hue-rotate(${this.hueRotation}deg)`;

    ctx.save();
    ctx.filter = hueFilter;
    ctx.drawImage(this.circleCanvas!, 0, 0);
    ctx.restore();

    // Color-snap flash: a white veil over the background that fades out as the
    // invert resolves, so the background goes white -> dark. Drawn under the
    // waveform/center circle so the (momentarily dark) center stays visible.
    if (this.colorSnapProgress > 0) {
      ctx.save();
      ctx.globalAlpha = this.colorSnapProgress;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }

    ctx.save();
    ctx.filter = hueFilter;
    ctx.drawImage(trailCanvas, 0, 0);
    ctx.restore();

    this.applyFadeOverlay();
  }

  /**
   * Redraws the previous trail with the spin plus a radial "collapse".
   *
   * The trail is drawn in thin concentric bands. Every band shares the same
   * rotation (rigid spin), but each is also scaled about the center so its
   * content drifts toward the nearest concentric circle boundary. Because the
   * boundaries act as attractors, the fading trail breaks at the ring edges
   * and its pieces collapse onto the rings as they fade.
   *
   * Bands are clipped to the circle radius, so nothing spills into the dark
   * corners and content pushed past the rim simply disappears.
   */
  private drawCollapseFeedback(
    ctx: CanvasRenderingContext2D,
    source: HTMLCanvasElement,
    centerX: number,
    centerY: number,
    rotation: number,
    alpha: number
  ): void {
    const maxRadius: number = this.maxRadius;
    const bands: number = this.COLLAPSE_BANDS;
    const rate: number = this.COLLAPSE_RATE;
    // Small clip overlap hides the antialiased seams between adjacent bands.
    const overlap: number = 1;

    for (let i: number = 0; i < bands; i++) {
      const innerRadius: number = (maxRadius * i) / bands;
      const outerRadius: number = (maxRadius * (i + 1)) / bands;
      const midRadius: number = (innerRadius + outerRadius) * 0.5;

      // Nudge this slice toward the nearest ring boundary. Slices either side
      // of a boundary converge on it (collapse); slices either side of a
      // midpoint diverge toward their respective boundaries.
      const target: number = this.nearestBoundary(midRadius);
      const newRadius: number = midRadius + (target - midRadius) * rate;
      const scale: number = midRadius > 0 ? newRadius / midRadius : 1;

      ctx.save();

      // Clip to this annular band (outer disc minus inner disc).
      ctx.beginPath();
      ctx.arc(centerX, centerY, outerRadius + overlap, 0, Math.PI * 2);
      if (innerRadius > 0) {
        ctx.arc(centerX, centerY, innerRadius, 0, Math.PI * 2, true);
      }
      ctx.clip();

      // Spin + radial collapse about the center, then redraw the faded trail.
      ctx.globalAlpha = alpha;
      ctx.translate(centerX, centerY);
      ctx.rotate(rotation);
      ctx.scale(scale, scale);
      ctx.translate(-centerX, -centerY);
      ctx.drawImage(source, 0, 0);

      ctx.restore();
    }
  }

  /**
   * Returns the gradient color band a point at the given radius falls in,
   * matching the concentric circle bands: 0 is the outermost annulus,
   * numColors - 1 is the central disc.
   */
  private colorBandForRadius(radius: number): number {
    const boundaries: number[] = this.boundaryRadii;
    const numColors: number = boundaries.length;
    // boundaries are ascending; the annulus for color (numColors - 1 - k) is
    // [boundaries[k - 1], boundaries[k]].
    for (let k: number = numColors - 1; k >= 1; k--) {
      if (radius >= boundaries[k - 1]) {
        return numColors - 1 - k;
      }
    }
    return numColors - 1;
  }

  /** Returns the boundary radius closest to the given radius. */
  private nearestBoundary(radius: number): number {
    const boundaries: number[] = this.boundaryRadii;
    let best: number = boundaries[0];
    let bestDist: number = Math.abs(radius - best);
    for (let i: number = 1; i < boundaries.length; i++) {
      const dist: number = Math.abs(radius - boundaries[i]);
      if (dist < bestDist) {
        bestDist = dist;
        best = boundaries[i];
      }
    }
    return best;
  }

  private drawMirroredWaveform(ctx: CanvasRenderingContext2D, centerX: number, centerY: number): void {
    const width: number = this.width;
    const height: number = this.height;
    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;
    const dataLength: number = dataArray.length;
    // Waveform sections use the higher-contrast lightness ramp, not the rings.
    const waveformColors: Array<{r: number; g: number; b: number}> = this.cachedWaveformColors;
    const numColors: number = waveformColors.length;

    const halfWidth: number = this.halfWidth;
    const minArcRadius: number = this.minArcRadius;
    const samplesPerHalf: number = this.WAVEFORM_SAMPLES;
    const bendStrength: number = 1.2;
    const sensitivityFactor: number = this.sensitivityFactor;
    const amplitudeScale: number = height * 0.3;

    // Calculate downsampling step
    const sampleStep: number = (dataLength * 0.5) / samplesPerHalf;

    // Left half points (from left edge to center) - reuse pre-allocated array
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
      this.pointBands[i] = this.colorBandForRadius(arcRadius);
    }

    // Right half points (mirrored, from center to right edge)
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
      this.allPoints[pointIndex].x = centerX + arcRadius * Math.cos(arcAngle);
      this.allPoints[pointIndex].y = centerY + arcRadius * Math.sin(arcAngle);
      this.pointBands[pointIndex] = this.colorBandForRadius(arcRadius);
    }

    // Split the waveform into runs of points that share a color band, so the
    // segment boundaries land exactly where the waveform crosses a concentric
    // circle boundary. Each run is drawn with its band's color; consecutive
    // runs overlap by one point so they connect with no visible gap.
    const totalPoints: number = samplesPerHalf * 2;
    let runStart: number = 0;
    let runBand: number = this.pointBands[0];
    for (let i: number = 1; i <= totalPoints; i++) {
      if (i === totalPoints || this.pointBands[i] !== runBand) {
        const endIdx: number = i < totalPoints ? i + 1 : totalPoints;
        if (endIdx - runStart >= 2) {
          this.drawWaveformSegment(ctx, runStart, endIdx, waveformColors[runBand]);
        }
        runStart = i;
        if (i < totalPoints) {
          runBand = this.pointBands[i];
        }
      }
    }

    // Draw circular waveform at center. Normally the brightest color, but
    // during a color snap it blends toward the darkest shade (inverted against
    // the white background) and eases back to bright as the snap resolves.
    const brightColor: {r: number; g: number; b: number} = waveformColors[numColors - 1];
    const darkColor: {r: number; g: number; b: number} = waveformColors[0];
    const t: number = this.colorSnapProgress;
    const centerColor: {r: number; g: number; b: number} = {
      r: Math.round(brightColor.r + (darkColor.r - brightColor.r) * t),
      g: Math.round(brightColor.g + (darkColor.g - brightColor.g) * t),
      b: Math.round(brightColor.b + (darkColor.b - brightColor.b) * t)
    };
    this.drawCenterCircle(ctx, centerX, centerY, halfWidth * 0.12, centerColor);
  }

  private drawCenterCircle(
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    baseRadius: number,
    color: {r: number; g: number; b: number}
  ): void {
    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;
    const dataLength: number = dataArray.length;
    const height: number = this.height;
    const numPoints: number = this.CENTER_CIRCLE_POINTS;
    const sensitivityFactor: number = this.sensitivityFactor;
    const amplitudeScale: number = height * 0.08;
    const sampleStep: number = (dataLength * 0.25) / numPoints;

    for (let i: number = 0; i <= numPoints; i++) {
      const angle: number = (i / numPoints) * Math.PI * 2;
      const sampleIndex: number = ((i * sampleStep) | 0) % dataLength;
      const sample: number = ((dataArray[sampleIndex] - 128) / 128) * sensitivityFactor;
      const amplitude: number = sample * amplitudeScale;
      const radius: number = baseRadius + amplitude;

      this.centerPoints[i].x = centerX + radius * Math.cos(angle);
      this.centerPoints[i].y = centerY + radius * Math.sin(angle);
    }

    const points: Array<{x: number; y: number}> = this.centerPoints;
    const mainColor: string = `rgb(${color.r}, ${color.g}, ${color.b})`;
    const glowColor: string = `rgba(${color.r}, ${color.g}, ${color.b}, 0.6)`;
    const highlightColor: string = `rgba(${Math.min(255, color.r + 60)}, ${Math.min(255, color.g + 40)}, ${Math.min(255, color.b + 20)}, 0.3)`;

    // Build smooth closed path using the base class helper
    const buildPath: () => void = (): void => {
      this.buildSmoothPath(ctx, points, numPoints);
    };

    const glowBlur: number = this.getScaledGlowBlur(15);

    // Glow layer (filled)
    ctx.save();
    ctx.shadowBlur = glowBlur;
    ctx.shadowColor = glowColor;
    ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, 0.3)`;
    buildPath();
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Main filled circle
    ctx.fillStyle = mainColor;
    buildPath();
    ctx.closePath();
    ctx.fill();

    // Highlight overlay
    ctx.fillStyle = highlightColor;
    buildPath();
    ctx.closePath();
    ctx.fill();
  }

  private drawWaveformSegment(
    ctx: CanvasRenderingContext2D,
    startIdx: number,
    endIdx: number,
    color: {r: number; g: number; b: number}
  ): void {
    const points: Array<{x: number; y: number}> = this.allPoints;
    const mainColor: string = `rgb(${color.r}, ${color.g}, ${color.b})`;
    const glowColor: string = `rgba(${color.r}, ${color.g}, ${color.b}, 0.6)`;
    const highlightColor: string = `rgba(${Math.min(255, color.r + 60)}, ${Math.min(255, color.g + 40)}, ${Math.min(255, color.b + 20)}, 0.5)`;

    // Build smooth path for the segment using quadratic bezier curves
    const smoothing: number = this.waveformSmoothing;
    const buildPath: () => void = (): void => {
      ctx.beginPath();
      ctx.moveTo(points[startIdx].x, points[startIdx].y);

      if (smoothing === 0) {
        for (let i: number = startIdx + 1; i < endIdx; i++) {
          ctx.lineTo(points[i].x, points[i].y);
        }
      } else {
        for (let i: number = startIdx; i < endIdx - 1; i++) {
          const current: {x: number; y: number} = points[i];
          const next: {x: number; y: number} = points[i + 1];
          const midX: number = (current.x + next.x) / 2;
          const midY: number = (current.y + next.y) / 2;
          const cpX: number = midX + (current.x - midX) * smoothing;
          const cpY: number = midY + (current.y - midY) * smoothing;
          ctx.quadraticCurveTo(cpX, cpY, midX, midY);
        }
        ctx.lineTo(points[endIdx - 1].x, points[endIdx - 1].y);
      }
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

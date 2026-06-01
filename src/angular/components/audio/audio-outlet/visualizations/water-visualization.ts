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
  private readonly RING_BLUR_FRACTION: number = 0.001;

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

  // When true, the mirrored horizontal waveforms are drawn on their own
  // spinning, fading trail layer composited over everything else (see
  // drawHorizontalSegments). The rings and center circle render regardless.
  private readonly SHOW_HORIZONTAL_WAVEFORM: boolean = true;

  // When true, each horizontal waveform segment is re-rendered as a stroked
  // circular waveform sitting on the inner boundary of its concentric color
  // band. Reuses the existing per-point band assignment without altering the
  // horizontal waveform code.
  private readonly SHOW_CIRCULAR_WAVEFORM: boolean = true;

  // Spike amplitudes lock to three levels by magnitude (on a 0-100 scale):
  // below LOW -> 0, below HIGH -> 50%, otherwise 100%.
  private readonly AMPLITUDE_BUCKET_LOW: number = 34;
  private readonly AMPLITUDE_BUCKET_HIGH: number = 65;

  // Number of times each circular waveform's pattern repeats around the circle
  // per full turn. 2 wraps the segment's samples around the ring twice, giving a
  // two-fold symmetric waveform instead of a single pass.
  private readonly CIRCULAR_REPEATS: number = 2;

  // Probability (0-1) that an emission cycle fills one of its bands instead of
  // stroking them all. Most cycles render every ring as a line; occasionally a
  // single random band is filled, so the filled flourish happens at random
  // intervals rather than every pass.
  private readonly CIRCULAR_FILL_CHANCE: number = 0.15;


  // Per-frame fraction the circular-waveform trail history is pushed outward
  // toward the next concentric circle, where it squashes up as it fades. Large
  // enough that the history reaches and bleeds against the next circle before
  // it fades away, rather than fading mid-band.
  private readonly RING_PUSH_RATE: number = 0.05;

  // All concentric bands' circular waveforms are emitted together (no per-band
  // stagger) once every CIRCULAR_EMIT_MS. Between emissions nothing new is
  // stamped, so the existing rings push outward and linearly fade toward fully
  // transparent before the next fresh set lands. Emitting every frame instead
  // would re-stamp at full opacity constantly and the trail would never fade.
  private readonly CIRCULAR_EMIT_MS: number = 25;
  private lastEmitTime: number = 5;

  // Per-frame linear alpha reduction (0-255) of the circular-waveform trail.
  // Subtracting a fixed amount from every pixel's alpha each frame marches it
  // steadily to exactly 0, so rendered/pushed/blurred history literally fades
  // away to transparent. A multiplicative fade can't do this: it asymptotically
  // stalls at a low-alpha floor (8-bit rounding) and leaves a permanent smear.
  // Kept small so the history lingers and fades slowly.
  private readonly RING_TRAIL_FADE_STEP: number = 4;

  // Per-frame Gaussian blur (px) applied to the circular-waveform trail history.
  // Because the trail is re-blurred every frame, the blur compounds with age:
  // freshly stamped rings start sharp and grow progressively blurrier as they
  // push outward and bleed away. 0 disables the blur.
  private readonly RING_TRAIL_BLUR_PX: number = 2;

  // Per-frame fade of the horizontal-waveform trail (the over-the-top spin+fade
  // layer). Faster than the main trail since it has no collapse motion to
  // disperse residue, so it clears instead of leaving a smear.
  private readonly WAVE_FADE_RATE: number = 0.001;

  // Radius of the central circle as a fraction of the half-width. The waveforms
  // also bend around a minimum arc radius of this same value, so they converge
  // exactly at the circle's edge. Kept just below the innermost ring boundary
  // (1/(GRADIENT_LEVELS.length*2 - 1) of the radius) so the waveform dips into
  // the innermost color band and all gradient colors are used.
  private readonly CENTER_RADIUS_FRACTION: number = 0.1;

  // Saturation and lightness levels for gradient (outer dark -> inner bright).
  // The array length is the number of concentric circles.
  private readonly GRADIENT_LEVELS: ReadonlyArray<{s: number; l: number}> = [
    {s: 70, l: 15},
    {s: 65, l: 29},
    {s: 60, l: 43},
    {s: 55, l: 56},
    {s: 50, l: 70}
  ];

  // The waveform sections reuse the ring hues/saturations but spread their
  // lightness across a wider range than the background rings, so each section
  // reads as a clearly distinct shade. Lightness is ramped linearly between
  // these bounds across the bands (outer dark -> inner bright).
  private readonly WAVEFORM_LIGHTNESS_MIN: number = 40;
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
  // Trail canvas for the circular waveforms - its history spins and is pushed
  // outward, squashing against each band's outer circle as it fades (see
  // drawRingTrailFeedback). Separate from the main trail's collapse feedback.
  private ringTrailCanvas: HTMLCanvasElement | null = null;
  private ringTrailCtx: CanvasRenderingContext2D | null = null;
  // Trail canvas for the horizontal waveforms - simply spins and fades, then
  // composited over everything else (see drawHorizontalSegments).
  private waveTrailCanvas: HTMLCanvasElement | null = null;
  private waveTrailCtx: CanvasRenderingContext2D | null = null;

  // Fixed reference hue the scene is rendered at, with gradient-color caching.
  private readonly baseHue: number = this.DEFAULT_HUE;
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
  // Band flagged (on a gated rotation change) to render filled on the next
  // circular-waveform emission, then consumed back to -1 (none).
  private fillBand: number = -1;

  // Pre-allocated arrays to avoid GC pressure
  private readonly allPoints: Array<{x: number; y: number}>;
  private readonly centerPoints: Array<{x: number; y: number}>;
  // Scratch ring used to build each circular-waveform segment (closed loop).
  private readonly ringPoints: Array<{x: number; y: number}>;
  // Gradient color band each waveform point falls in (by radius from center).
  private readonly pointBands: Int8Array;

  // Pre-computed values (updated on resize)
  private centerX: number = 0;
  private centerY: number = 0;
  private halfWidth: number = 0;
  private minArcRadius: number = 0;
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
    // A circular segment can span every point, repeated CIRCULAR_REPEATS times
    // around the ring, plus one to close the loop.
    this.ringPoints = new Array(this.WAVEFORM_SAMPLES * 2 * this.CIRCULAR_REPEATS + 1);
    this.pointBands = new Int8Array(this.WAVEFORM_SAMPLES * 2);

    for (let i: number = 0; i < this.WAVEFORM_SAMPLES * 2; i++) {
      this.allPoints[i] = {x: 0, y: 0};
    }
    for (let i: number = 0; i < this.ringPoints.length; i++) {
      this.ringPoints[i] = {x: 0, y: 0};
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

  protected override onResize(): void {
    // Pre-compute geometry values
    this.centerX = this.width * 0.5;
    this.centerY = this.height * 0.5;
    this.halfWidth = this.width * 0.5;
    this.minArcRadius = this.halfWidth * this.CENTER_RADIUS_FRACTION;
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

    // Create the circular-waveform trail canvas if needed. It is read back via
    // clearLowAlphaPixels (getImageData), so willReadFrequently keeps that on
    // CPU-side memory instead of stalling the GPU each time.
    if (!this.ringTrailCanvas) {
      this.ringTrailCanvas = document.createElement('canvas');
      this.ringTrailCtx = this.ringTrailCanvas.getContext('2d', {alpha: true, willReadFrequently: true})!;
    }

    // Create the horizontal-waveform trail canvas if needed
    if (!this.waveTrailCanvas) {
      const offscreen: OffscreenCanvasPair = this.createOffscreenCanvas();
      this.waveTrailCanvas = offscreen.canvas;
      this.waveTrailCtx = offscreen.ctx;
    }

    // Resize trail canvas while preserving content
    this.resizeCanvasPreserving(this.trailCanvas, this.trailCtx!, this.width, this.height);
    // Ring trail canvas is a trail too - preserve its content across resizes
    this.resizeCanvasPreserving(this.ringTrailCanvas, this.ringTrailCtx!, this.width, this.height);
    // Wave trail canvas is a trail too - preserve its content across resizes
    this.resizeCanvasPreserving(this.waveTrailCanvas, this.waveTrailCtx!, this.width, this.height);
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
    if (!this.circleCanvas || !this.trailCanvas || !this.trailCtx || !this.tempCanvas || !this.tempCtx ||
        !this.ringTrailCanvas || !this.ringTrailCtx || !this.waveTrailCanvas || !this.waveTrailCtx) {
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

    // A rotation change also occasionally (CIRCULAR_FILL_CHANCE) flags one random
    // band to render filled on the next emission. Tied to the rotation-change
    // trigger but gated so it doesn't fire on every rotation.
    if (rotationChanged && Math.random() < this.CIRCULAR_FILL_CHANCE) {
      this.fillBand = Math.floor(Math.random() * this.cachedWaveformColors.length);
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

    // Draw the mirrored waveforms (also computes the per-point band assignment).
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

    // Circular waveforms keep their own trail. Each frame the trail history is
    // pushed outward from its band's inner circle and squashed against the next
    // circle as it spins and fades; then the fresh rings are stamped on top.
    // Reuses the temp canvas (the main trail is done with it by now).
    const ringTrailCtx: CanvasRenderingContext2D = this.ringTrailCtx!;
    const ringTrailCanvas: HTMLCanvasElement = this.ringTrailCanvas!;
    tempCtx.clearRect(0, 0, width, height);
    tempCtx.drawImage(ringTrailCanvas, 0, 0);
    ringTrailCtx.clearRect(0, 0, width, height);
    // Push/spin the existing history outward at full strength (no fade here),
    // then linearly subtract alpha from every pixel so all rendered and
    // pushed/blurred history marches steadily to fully transparent and vanishes.
    this.drawRingTrailFeedback(ringTrailCtx, tempCanvas, centerX, centerY, this.RING_PUSH_RATE, rotation);
    // Blur the pushed history a touch each frame. As it is re-blurred every
    // frame the bleed-out content compounds blur with age. The filter is applied
    // writing to the GPU-backed temp canvas (then copied straight back) to avoid
    // software-filter cost on the willReadFrequently ring-trail canvas.
    if (this.RING_TRAIL_BLUR_PX > 0) {
      tempCtx.clearRect(0, 0, width, height);
      tempCtx.save();
      tempCtx.filter = `blur(${this.RING_TRAIL_BLUR_PX}px)`;
      tempCtx.drawImage(ringTrailCanvas, 0, 0);
      tempCtx.restore();
      ringTrailCtx.clearRect(0, 0, width, height);
      ringTrailCtx.drawImage(tempCanvas, 0, 0);
    }
    this.fadeRingTrailStep(ringTrailCtx);

    // Every concentric band's circular waveform is stamped together (no stagger
    // between bands) once per CIRCULAR_EMIT_MS, innermost first then outward.
    // Between emissions the rings push outward, spin, and linearly fade to fully
    // transparent on the ring-trail layer before the next fresh set lands.
    if (now - this.lastEmitTime >= this.CIRCULAR_EMIT_MS) {
      this.lastEmitTime = now;
      const numBands: number = this.cachedWaveformColors.length;
      // A band is filled this emission only if a (gated) rotation change flagged
      // one; consume it so the fill lasts a single emission, not every pass.
      const filledBand: number = this.fillBand;
      this.fillBand = -1;
      for (let band: number = numBands - 1; band >= 0; band--) {
        this.emitCircularBand(ringTrailCtx, centerX, centerY, band, band === filledBand);
      }
    }

    ctx.save();
    ctx.filter = hueFilter;
    ctx.drawImage(ringTrailCanvas, 0, 0);
    ctx.restore();

    // Horizontal waveforms on their own trail, spun and faded each frame (no
    // collapse/push), drawn fresh on top, then composited over everything else.
    const waveTrailCtx: CanvasRenderingContext2D = this.waveTrailCtx!;
    const waveTrailCanvas: HTMLCanvasElement = this.waveTrailCanvas!;
    tempCtx.clearRect(0, 0, width, height);
    tempCtx.drawImage(waveTrailCanvas, 0, 0);
    waveTrailCtx.clearRect(0, 0, width, height);
    waveTrailCtx.save();
    waveTrailCtx.globalAlpha = Math.max(0, 1 - this.WAVE_FADE_RATE * this.getFadeMultiplier());
    waveTrailCtx.translate(centerX, centerY);
    waveTrailCtx.rotate(rotation);
    waveTrailCtx.translate(-centerX, -centerY);
    waveTrailCtx.drawImage(tempCanvas, 0, 0);
    waveTrailCtx.restore();

    this.drawHorizontalSegments(waveTrailCtx);

    ctx.save();
    ctx.filter = hueFilter;
    ctx.drawImage(waveTrailCanvas, 0, 0);
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
   * Redraws the previous circular-waveform trail pushed radially outward.
   *
   * Like drawCollapseFeedback, the trail is processed in thin concentric bands,
   * but each band is scaled toward the NEXT circle outward (not the nearest),
   * so a band's history drifts from its inner circle toward its outer one. As
   * the bands approach that outer boundary the scale tends to 1, so the moving
   * history bunches up - squashing against the circle - while alpha fades it.
   * Each band also spins by `rotation`, so the history spirals outward.
   */
  private drawRingTrailFeedback(
    ctx: CanvasRenderingContext2D,
    source: HTMLCanvasElement,
    centerX: number,
    centerY: number,
    pushRate: number,
    rotation: number
  ): void {
    const maxRadius: number = this.maxRadius;
    const bands: number = this.COLLAPSE_BANDS;
    // Small clip overlap hides the antialiased seams between adjacent bands.
    const overlap: number = 1;

    for (let i: number = 0; i < bands; i++) {
      const innerRadius: number = (maxRadius * i) / bands;
      const outerRadius: number = (maxRadius * (i + 1)) / bands;
      const midRadius: number = (innerRadius + outerRadius) * 0.5;

      // Push this slice toward the next circle outward; near that circle the
      // step shrinks toward zero, so successive frames pile up against it.
      const target: number = this.nextBoundaryOutward(midRadius);
      const newRadius: number = midRadius + (target - midRadius) * pushRate;
      const scale: number = midRadius > 0 ? newRadius / midRadius : 1;

      ctx.save();

      // Clip to this annular band (outer disc minus inner disc).
      ctx.beginPath();
      ctx.arc(centerX, centerY, outerRadius + overlap, 0, Math.PI * 2);
      if (innerRadius > 0) {
        ctx.arc(centerX, centerY, innerRadius, 0, Math.PI * 2, true);
      }
      ctx.clip();

      // Spin + radial push about the center, then redraw at full strength.
      // The fade is applied separately (fadeRingTrailStep), as a linear alpha
      // subtraction, so the moved history fades cleanly to transparent.
      ctx.translate(centerX, centerY);
      ctx.rotate(rotation);
      ctx.scale(scale, scale);
      ctx.translate(-centerX, -centerY);
      ctx.drawImage(source, 0, 0);

      ctx.restore();
    }
  }

  /**
   * Linearly fades the ring-trail layer toward fully transparent.
   *
   * Subtracts a fixed amount (RING_TRAIL_FADE_STEP) from every pixel's alpha
   * each frame. Unlike a multiplicative fade - which asymptotically approaches
   * but never reaches zero (8-bit rounding leaves a stuck low-alpha floor) -
   * a constant subtraction drives every pixel to exactly 0, so all rendered,
   * pushed and blurred history literally fades away and disappears.
   */
  private fadeRingTrailStep(ctx: CanvasRenderingContext2D): void {
    const width: number = this.width;
    const height: number = this.height;
    if (width <= 0 || height <= 0) return;

    const imageData: ImageData = ctx.getImageData(0, 0, width, height);
    const data: Uint8ClampedArray = imageData.data;
    const step: number = this.RING_TRAIL_FADE_STEP;

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

  /**
   * Returns the next concentric circle boundary strictly outward from the given
   * radius - i.e. the outer edge of the annulus the radius sits in. Used as the
   * attractor the ring-trail history is pushed toward and squashed against.
   */
  private nextBoundaryOutward(radius: number): number {
    const boundaries: number[] = this.boundaryRadii;
    for (let i: number = 0; i < boundaries.length; i++) {
      if (boundaries[i] > radius) {
        return boundaries[i];
      }
    }
    return this.maxRadius;
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

    // The horizontal waveform segments themselves are drawn separately by
    // drawHorizontalSegments onto their own spin+fade trail layer; here we only
    // compute the point/band data they (and the circular waveforms) consume.

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
    this.drawCenterCircle(ctx, centerX, centerY, halfWidth * this.CENTER_RADIUS_FRACTION, centerColor);
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

    // Build a smooth path over the segment's sub-range using the shared helper.
    const buildPath: () => void = (): void => {
      this.buildSmoothPath(ctx, points, endIdx - 1, startIdx);
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

  /**
   * Draws the mirrored horizontal waveform as band-colored segments onto the
   * given context (its own spin+fade trail layer). Splits the precomputed
   * points into runs that share a color band - so segment edges land on the
   * concentric circle boundaries - and strokes each via drawWaveformSegment.
   */
  private drawHorizontalSegments(ctx: CanvasRenderingContext2D): void {
    if (!this.SHOW_HORIZONTAL_WAVEFORM) return;

    const waveformColors: Array<{r: number; g: number; b: number}> = this.cachedWaveformColors;
    const totalPoints: number = this.WAVEFORM_SAMPLES * 2;

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
  }

  /**
   * Quantizes a raw time-domain deviation into three locked levels by magnitude
   * (on a 0-100 scale): 0-33 -> 0, 34-64 -> 0.5, 65+ -> 1. The level is the
   * fraction of the distance from the band's inner concentric circle out to the
   * next circle, so 0 sits on the inner circle and 1 reaches the next one.
   *
   * @param deviation - Raw sample minus the 128 midpoint (range -128..127).
   * @returns Locked level: 0, 0.5, or 1.
   */
  private quantizeAmplitude(deviation: number): number {
    const magnitude: number = (Math.abs(deviation) / 128) * 100;
    if (magnitude < this.AMPLITUDE_BUCKET_LOW) return 0;
    if (magnitude < this.AMPLITUDE_BUCKET_HIGH) return 0.5;
    return 1;
  }

  /**
   * Emits exactly one circular waveform, for the band whose turn it is.
   *
   * The mirrored horizontal waveform splits each band into a left and a right
   * run at the same radius; the first usable run for the target band is found
   * and drawn as a single closed circular waveform onto the ring-trail layer -
   * stroked as a line, or filled when `filled` is set. Called once per band per
   * emission cycle.
   */
  private emitCircularBand(
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    targetBand: number,
    filled: boolean
  ): void {
    if (!this.SHOW_CIRCULAR_WAVEFORM) return;

    const waveformColors: Array<{r: number; g: number; b: number}> = this.cachedWaveformColors;
    const totalPoints: number = this.WAVEFORM_SAMPLES * 2;

    // Find the first usable point-run that falls in the target band and draw it
    // in that band's waveform color - the same per-band coloring the horizontal
    // waveform segments use (see drawHorizontalSegments).
    let runStart: number = 0;
    let runBand: number = this.pointBands[0];
    for (let i: number = 1; i <= totalPoints; i++) {
      if (i === totalPoints || this.pointBands[i] !== runBand) {
        const endIdx: number = i < totalPoints ? i + 1 : totalPoints;
        if (runBand === targetBand && endIdx - runStart >= 2) {
          this.drawCircularSegment(ctx, centerX, centerY, runStart, endIdx, targetBand, waveformColors[targetBand], filled);
          return;
        }
        runStart = i;
        if (i < totalPoints) {
          runBand = this.pointBands[i];
        }
      }
    }
  }

  /**
   * Draws a single waveform segment as a closed circular (radial) waveform.
   *
   * The segment's audio samples are wrapped around a full circle. Each sample's
   * locked level sets the radius between this band's inner concentric circle
   * (level 0) and the next circle outward (level 1), so spikes grow outward
   * across the band's annulus. Stroked as a line, or filled when `filled` is set.
   */
  private drawCircularSegment(
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    startIdx: number,
    endIdx: number,
    band: number,
    color: {r: number; g: number; b: number},
    filled: boolean
  ): void {
    const numColors: number = this.cachedWaveformColors.length;
    // The band's annulus: inner concentric circle (0 for the innermost disc)
    // out to the next circle. The locked level spans this width.
    const innerRadius: number = band < numColors - 1 ? this.boundaryRadii[numColors - 2 - band] : 0;
    const outerRadius: number = this.boundaryRadii[numColors - 1 - band];
    const bandWidth: number = outerRadius - innerRadius;

    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;
    const dataLength: number = dataArray.length;
    const samplesPerHalf: number = this.WAVEFORM_SAMPLES;
    const sampleStep: number = (dataLength * 0.5) / samplesPerHalf;

    const segLen: number = endIdx - startIdx;
    const points: Array<{x: number; y: number}> = this.ringPoints;

    // The segment's samples are wrapped around the circle CIRCULAR_REPEATS times,
    // so the same waveform pattern renders multiple times per full turn.
    const totalSteps: number = segLen * this.CIRCULAR_REPEATS;

    // If every sample locks to level 0 the ring collapses flat onto its inner
    // circle and carries no waveform - skip it entirely rather than stamping a
    // bare circle onto the trail.
    let hasAmplitude: boolean = false;

    for (let j: number = 0; j <= totalSteps; j++) {
      // Wrap the segment's points evenly around the full circle, repeating the
      // pattern; j === totalSteps reuses the first sample so the loop closes.
      const p: number = startIdx + (j % segLen);
      // Map the concatenated left/right point index back to its source sample.
      const sampleIdx: number = p < samplesPerHalf ? p : 2 * samplesPerHalf - 1 - p;
      const dataIndex: number = Math.min(dataLength - 1, (sampleIdx * sampleStep) | 0);
      // Locked level (0, 0.5, 1) -> fraction of the band width, measured outward
      // from the inner concentric circle toward the next one.
      const level: number = this.quantizeAmplitude(dataArray[dataIndex] - 128);
      if (level > 0) hasAmplitude = true;
      const radius: number = innerRadius + level * bandWidth;
      const angle: number = (j / totalSteps) * Math.PI * 2;

      points[j].x = centerX + radius * Math.cos(angle);
      points[j].y = centerY + radius * Math.sin(angle);
    }

    if (!hasAmplitude) return;

    const mainColor: string = `rgb(${color.r}, ${color.g}, ${color.b})`;
    const glowColor: string = `rgba(${color.r}, ${color.g}, ${color.b}, 0.6)`;
    const highlightColor: string = `rgba(${Math.min(255, color.r + 60)}, ${Math.min(255, color.g + 40)}, ${Math.min(255, color.b + 20)}, 0.5)`;

    const buildPath: () => void = (): void => {
      this.buildSmoothPath(ctx, points, totalSteps);
      ctx.closePath();
    };

    const glowBlur: number = this.getScaledGlowBlur(15);

    // Filled variant: fill the region bounded by the waveform outline instead
    // of stroking it, for the one band chosen at random this cycle.
    if (filled) {
      ctx.save();
      ctx.shadowBlur = glowBlur;
      ctx.shadowColor = glowColor;
      ctx.fillStyle = mainColor;
      buildPath();
      ctx.fill();
      ctx.restore();

      // Highlight overlay
      ctx.fillStyle = highlightColor;
      buildPath();
      ctx.fill();
      return;
    }

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

    // Main ring
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
    this.ringTrailCanvas = null;
    this.ringTrailCtx = null;
    this.waveTrailCanvas = null;
    this.waveTrailCtx = null;
  }
}

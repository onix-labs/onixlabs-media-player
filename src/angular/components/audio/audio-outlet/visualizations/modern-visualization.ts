/**
 * @fileoverview Modern waveform visualization with gradient colors.
 *
 * Displays the audio waveform in the style of Classic but with
 * the ONIXLabs brand color spectrum instead of a solid green.
 * Features an LCD ghosting/persistence effect.
 *
 * Technical details:
 * - Uses getByteTimeDomainData() for waveform data
 * - Persistence effect via slow fade and transparent background
 * - Multi-layer rendering: glow, main line, highlight
 * - ONIXLabs brand color gradient from Orange to Green
 * - Sensitivity scales the waveform amplitude
 *
 * @module app/components/audio/audio-outlet/visualizations/modern-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/**
 * Number of colors in the ONIXLabs brand palette.
 */
const NUM_COLORS: number = 8;

/**
 * Pre-parsed RGB values for the ONIXLabs brand colors (flat array for cache efficiency).
 * Format: [r0, g0, b0, r1, g1, b1, ...]
 */
const ONIX_COLORS_FLAT: Uint8Array = new Uint8Array([
  247, 149, 51,   // #F79533 Orange
  243, 112, 85,   // #F37055 Coral
  239, 78, 123,   // #EF4E7B Pink
  161, 102, 171,  // #A166AB Purple
  80, 115, 184,   // #5073B8 Blue
  16, 152, 173,   // #1098AD Teal
  7, 179, 155,    // #07B39B Cyan
  111, 186, 130,  // #6FBA82 Green
]);

/**
 * Modern waveform visualization with gradient colors.
 *
 * Renders the audio waveform as a glowing gradient line with an LCD-style
 * ghosting effect that creates visual trails. Same rendering as Classic
 * but with ONIXLabs brand colors instead of solid green.
 */
export class ModernVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Modern';
  public readonly category: string = 'Waves';

  private readonly FADE_RATE: number = 0.03; // Very slow fade for LCD ghosting effect
  private readonly BASE_GLOW_BLUR: number = 15;
  private readonly WAVEFORM_POINTS: number = 128;
  private readonly THRESHOLD_CLEAR_INTERVAL: number = 10; // Clear low-alpha pixels every N frames
  private readonly ALPHA_THRESHOLD: number = 30; // Pixels with alpha below this become transparent
  private dataArray: Uint8Array<ArrayBuffer>;
  private frameCount: number = 0;

  /** Pre-allocated point array for waveform */
  private readonly points: Array<{x: number; y: number}>;

  /** Tracks whether this visualization has drawn at least once */
  private hasDrawn: boolean = false;

  /** Cached gradient for performance */
  private cachedGradient: CanvasGradient | null = null;
  private cachedGradientWidth: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.sensitivity = 0.4;

    // Pre-allocate point array
    this.points = [];
    for (let i: number = 0; i <= this.WAVEFORM_POINTS; i++) {
      this.points.push({x: 0, y: 0});
    }
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  /**
   * Override resize to preserve the main canvas content.
   *
   * This visualization draws directly to the main canvas with a fade effect
   * (LCD ghosting), so we need to preserve its content during resize rather
   * than letting it get cleared.
   */
  public override resize(width: number, height: number): void {
    const oldWidth: number = this.canvas.width;
    const oldHeight: number = this.canvas.height;
    const dimensionsChanged: boolean = oldWidth !== width || oldHeight !== height;

    // If dimensions unchanged AND we've already drawn, nothing to do
    if (!dimensionsChanged && this.hasDrawn) {
      return;
    }

    // If dimensions unchanged but we haven't drawn yet, clear the canvas
    // (removes content from previous visualization)
    if (!dimensionsChanged && !this.hasDrawn) {
      this.width = width;
      this.height = height;
      this.ctx.clearRect(0, 0, width, height);
      return;
    }

    // Dimensions changed - preserve content only if we've drawn at least once
    if (this.hasDrawn && oldWidth > 0 && oldHeight > 0) {
      // Capture existing content
      const tempCanvas: HTMLCanvasElement = document.createElement('canvas');
      tempCanvas.width = oldWidth;
      tempCanvas.height = oldHeight;
      const tempCtx: CanvasRenderingContext2D = tempCanvas.getContext('2d', {alpha: true})!;
      tempCtx.drawImage(this.canvas, 0, 0);

      // Update dimensions (clears canvas)
      this.width = width;
      this.height = height;
      this.canvas.width = width;
      this.canvas.height = height;

      // Draw preserved content scaled to new dimensions
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';
      this.ctx.drawImage(tempCanvas, 0, 0, oldWidth, oldHeight, 0, 0, width, height);
    } else {
      // First resize or no content to preserve, just set dimensions (clears canvas)
      this.width = width;
      this.height = height;
      this.canvas.width = width;
      this.canvas.height = height;
    }

    // Invalidate gradient cache on resize
    this.cachedGradient = null;
  }

  /**
   * Creates or returns cached horizontal gradient using ONIXLabs brand colors.
   */
  private getGradient(): CanvasGradient {
    if (this.cachedGradient && this.cachedGradientWidth === this.width) {
      return this.cachedGradient;
    }

    const gradient: CanvasGradient = this.ctx.createLinearGradient(0, 0, this.width, 0);

    // Add color stops for each brand color
    for (let i: number = 0; i < NUM_COLORS; i++) {
      const idx: number = i * 3;
      const r: number = ONIX_COLORS_FLAT[idx];
      const g: number = ONIX_COLORS_FLAT[idx + 1];
      const b: number = ONIX_COLORS_FLAT[idx + 2];
      const stop: number = i / (NUM_COLORS - 1);
      gradient.addColorStop(stop, `rgb(${r}, ${g}, ${b})`);
    }

    this.cachedGradient = gradient;
    this.cachedGradientWidth = this.width;
    return gradient;
  }

  /**
   * Creates a glow gradient with reduced opacity.
   */
  private getGlowGradient(): CanvasGradient {
    const gradient: CanvasGradient = this.ctx.createLinearGradient(0, 0, this.width, 0);

    // Add color stops for each brand color with reduced opacity
    for (let i: number = 0; i < NUM_COLORS; i++) {
      const idx: number = i * 3;
      const r: number = ONIX_COLORS_FLAT[idx];
      const g: number = ONIX_COLORS_FLAT[idx + 1];
      const b: number = ONIX_COLORS_FLAT[idx + 2];
      const stop: number = i / (NUM_COLORS - 1);
      gradient.addColorStop(stop, `rgba(${r}, ${g}, ${b}, 0.8)`);
    }

    return gradient;
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;

    if (width <= 0 || height <= 0) return;

    // Slow fade effect - creates the LCD ghosting/persistence (transparent background)
    // Apply trail intensity multiplier to fade rate
    const effectiveFadeRate: number = this.FADE_RATE * this.getFadeMultiplier();
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0, 0, 0, ${effectiveFadeRate})`;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    // Periodically clear low-alpha pixels to prevent ghosting artifacts
    this.frameCount++;
    if (this.frameCount >= this.THRESHOLD_CLEAR_INTERVAL) {
      this.frameCount = 0;
      this.clearLowAlphaPixels();
    }

    // Get time domain data (waveform)
    this.analyser.getByteTimeDomainData(this.dataArray);

    const centerY: number = height / 2;
    const numPoints: number = this.WAVEFORM_POINTS;
    const amplitudeScale: number = height * 0.4;
    const sensitivityFactor: number = this.sensitivity * 2;
    const dataLength: number = this.dataArray.length;

    // Calculate waveform points - use ratio to ensure full width coverage
    for (let i: number = 0; i <= numPoints; i++) {
      const t: number = i / numPoints;
      const dataIndex: number = Math.min(Math.floor(t * dataLength), dataLength - 1);
      const amplitude: number = ((this.dataArray[dataIndex] - 128) / 128) * sensitivityFactor;
      this.points[i].x = t * width;
      this.points[i].y = centerY + amplitude * amplitudeScale;
    }

    // Build path using the base class smooth path helper
    const buildPath: () => void = (): void => {
      this.buildSmoothPath(ctx, this.points, numPoints);
    };

    // Get gradients for drawing
    const mainGradient: CanvasGradient = this.getGradient();
    const glowGradient: CanvasGradient = this.getGlowGradient();

    // Draw glow layer (multiple passes for soft glow effect)
    // Canvas shadowColor only supports single colors, so we use layered strokes
    const glowBlur: number = this.getScaledGlowBlur(this.BASE_GLOW_BLUR);
    const glowPasses: number = 3;
    for (let i: number = glowPasses; i >= 1; i--) {
      ctx.save();
      ctx.globalAlpha = 0.3 / i;
      ctx.strokeStyle = glowGradient;
      ctx.lineWidth = this.lineWidth + glowBlur * (i / glowPasses);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      buildPath();
      ctx.stroke();
      ctx.restore();
    }

    // Draw main line with gradient
    ctx.strokeStyle = mainGradient;
    ctx.lineWidth = this.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    buildPath();
    ctx.stroke();

    // Draw highlight
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    buildPath();
    ctx.stroke();

    this.applyFadeOverlay();

    // Mark that we've drawn at least once (for resize preservation logic)
    this.hasDrawn = true;
  }

  /**
   * Clears pixels with alpha below threshold to fully transparent.
   * This prevents ghosting artifacts from the asymptotic fade.
   */
  private clearLowAlphaPixels(): void {
    const width: number = this.width;
    const height: number = this.height;
    if (width <= 0 || height <= 0) return;

    const imageData: ImageData = this.ctx.getImageData(0, 0, width, height);
    const data: Uint8ClampedArray = imageData.data;
    const threshold: number = this.ALPHA_THRESHOLD;

    // Alpha is at index 3, 7, 11, ... (every 4th byte starting at 3)
    for (let i: number = 3; i < data.length; i += 4) {
      if (data[i] > 0 && data[i] < threshold) {
        data[i] = 0;
      }
    }

    this.ctx.putImageData(imageData, 0, 0);
  }
}

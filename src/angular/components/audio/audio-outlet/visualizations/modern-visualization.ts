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
import {ONIX_COLORS_FLAT, ONIX_COLOR_COUNT} from './visualization-constants';

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
  private dataArray: Uint8Array<ArrayBuffer>;
  private frameCount: number = 0;

  /** Pre-allocated point array for waveform */
  private readonly points: Array<{x: number; y: number}>;

  /** Cached gradient for performance */
  private cachedGradient: CanvasGradient | null = null;
  private cachedGradientWidth: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.sensitivity = 0.4;
    this.preserveContentOnResize = true;

    // Pre-allocate point array
    this.points = [];
    for (let i: number = 0; i <= this.WAVEFORM_POINTS; i++) {
      this.points.push({x: 0, y: 0});
    }
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
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
    for (let i: number = 0; i < ONIX_COLOR_COUNT; i++) {
      const idx: number = i * 3;
      const r: number = ONIX_COLORS_FLAT[idx];
      const g: number = ONIX_COLORS_FLAT[idx + 1];
      const b: number = ONIX_COLORS_FLAT[idx + 2];
      const stop: number = i / (ONIX_COLOR_COUNT - 1);
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
    for (let i: number = 0; i < ONIX_COLOR_COUNT; i++) {
      const idx: number = i * 3;
      const r: number = ONIX_COLORS_FLAT[idx];
      const g: number = ONIX_COLORS_FLAT[idx + 1];
      const b: number = ONIX_COLORS_FLAT[idx + 2];
      const stop: number = i / (ONIX_COLOR_COUNT - 1);
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
    const sensitivityFactor: number = this.sensitivityFactor;
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

}

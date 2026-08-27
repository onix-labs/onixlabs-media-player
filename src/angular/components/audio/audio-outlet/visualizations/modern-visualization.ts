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
  /** Very slow fade for the LCD ghosting effect. */
  private static readonly FADE_RATE: number = 0.03;

  /** Base glow blur radius in pixels. */
  private static readonly BASE_GLOW_BLUR: number = 15;

  /** Number of points sampled across the waveform. */
  private static readonly WAVEFORM_POINTS: number = 32;

  /** Clear low-alpha pixels every N frames to suppress ghosting. */
  private static readonly THRESHOLD_CLEAR_INTERVAL: number = 10;

  /** Number of layered strokes used to build the soft glow. */
  private static readonly GLOW_PASSES: number = 3;

  public readonly name: string = 'Modern';
  public readonly category: string = 'Bars & Waves';

  private dataArray: Uint8Array<ArrayBuffer>;

  /** Pre-allocated point array for the waveform. */
  private readonly points: Array<{x: number; y: number}>;

  /** Cached gradients (rebuilt only when width changes). */
  private cachedGradient: CanvasGradient | null = null;
  private cachedGlowGradient: CanvasGradient | null = null;
  private cachedGradientWidth: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    // Hard-coded look; the setters below are no-ops so the (removed) controls can't change these.
    this.sensitivity = 0.2;       // 20%
    this.trailIntensity = 0;      // minimal trails
    this.lineWidth = 1;           // 1px
    this.glowIntensity = 1;       // 100%
    this.waveformSmoothing = 1;   // 100%
    this.preserveContentOnResize = true;

    // Pre-allocate point array
    this.points = [];
    for (let i: number = 0; i <= ModernVisualization.WAVEFORM_POINTS; i++) {
      this.points.push({x: 0, y: 0});
    }
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;

    if (width <= 0 || height <= 0) return;

    // Slow fade creates the LCD ghosting/persistence (transparent background).
    this.applyPersistenceFade(ModernVisualization.FADE_RATE);

    // Periodically clear low-alpha pixels to prevent ghosting artifacts.
    this.periodicClearLowAlpha(ModernVisualization.THRESHOLD_CLEAR_INTERVAL);

    // Get time domain data (waveform)
    this.analyser.getByteTimeDomainData(this.dataArray);

    const centerY: number = height / 2;
    const numPoints: number = ModernVisualization.WAVEFORM_POINTS;
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

    // Ensure gradients exist and match the current width
    this.ensureGradients();
    const mainGradient: CanvasGradient = this.cachedGradient!;
    const glowGradient: CanvasGradient = this.cachedGlowGradient!;

    // Draw glow layer (multiple passes for soft glow effect).
    // Canvas shadowColor only supports single colors, so we use layered strokes.
    const glowBlur: number = this.getScaledGlowBlur(ModernVisualization.BASE_GLOW_BLUR);
    const glowPasses: number = ModernVisualization.GLOW_PASSES;
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

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    this.cachedGradient = null;
    this.cachedGlowGradient = null;
  }

  // Fixed visual parameters: ignore the global controls (values set in constructor).
  public override setSensitivity(): void { /* fixed */ }
  public override setTrailIntensity(): void { /* fixed */ }
  public override setLineWidth(): void { /* fixed */ }
  public override setGlowIntensity(): void { /* fixed */ }
  public override setWaveformSmoothing(): void { /* fixed */ }

  /**
   * Rebuilds the cached main/glow gradients if the width has changed.
   */
  private ensureGradients(): void {
    if (this.cachedGradient && this.cachedGlowGradient && this.cachedGradientWidth === this.width) {
      return;
    }

    this.cachedGradient = this.buildBrandGradient(1);
    this.cachedGlowGradient = this.buildBrandGradient(0.8);
    this.cachedGradientWidth = this.width;
  }

  /**
   * Builds a horizontal ONIXLabs brand-color gradient at the given opacity.
   *
   * @param opacity - Stroke opacity (1 for the main line, < 1 for the glow).
   */
  private buildBrandGradient(opacity: number): CanvasGradient {
    const gradient: CanvasGradient = this.ctx.createLinearGradient(0, 0, this.width, 0);
    for (let i: number = 0; i < ONIX_COLOR_COUNT; i++) {
      const idx: number = i * 3;
      const r: number = ONIX_COLORS_FLAT[idx];
      const g: number = ONIX_COLORS_FLAT[idx + 1];
      const b: number = ONIX_COLORS_FLAT[idx + 2];
      const stop: number = i / (ONIX_COLOR_COUNT - 1);
      gradient.addColorStop(stop, `rgba(${r}, ${g}, ${b}, ${opacity})`);
    }
    return gradient;
  }
}

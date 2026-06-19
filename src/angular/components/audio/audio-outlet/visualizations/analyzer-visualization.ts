/**
 * @fileoverview Frequency bars visualization.
 *
 * Classic audio visualizer showing vertical bars that represent frequency
 * bands. Uses a green-yellow-red gradient from bottom to top, giving
 * visual feedback on frequency intensity.
 *
 * Technical details:
 * - Uses 96 bars across the canvas width
 * - Analyzes frequency data using getByteFrequencyData()
 * - Maps FFT bins to bars, averaging bins for smooth display
 * - Bar height represents frequency intensity (0-255)
 * - Gradient colors indicate intensity levels
 *
 * @module app/components/audio/audio-outlet/visualizations/bars-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/**
 * Frequency bars visualization with gradient coloring.
 *
 * Renders vertical bars that respond to audio frequency content.
 * Higher frequencies appear on the right, lower on the left.
 * Bar heights animate smoothly via the analyser's smoothing constant.
 */
export class AnalyzerVisualization extends Canvas2DVisualization {
  /** Bar count for each density level. */
  private static readonly BAR_COUNTS: Record<'low' | 'medium' | 'high', number> = {
    low: 48,
    medium: 96,
    high: 144
  };

  /** Horizontal gap between bars in pixels. */
  private static readonly BAR_GAP: number = 2;

  /** Fraction of the frequency spectrum to display (drops the quiet top end). */
  private static readonly FREQUENCY_RANGE: number = 0.75;

  /** Bar height as a fraction of canvas height at full intensity. */
  private static readonly HEIGHT_SCALE: number = 0.85;

  /** Maximum corner radius for the rounded bar tops, in pixels. */
  private static readonly MAX_CORNER_RADIUS: number = 4;

  public readonly name: string = 'Analyzer';
  public readonly category: string = 'Bars';

  private barCount: number = AnalyzerVisualization.BAR_COUNTS.medium;
  private dataArray: Uint8Array<ArrayBuffer>;
  private barGradient: CanvasGradient | null = null;
  private gradientHeight: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    // Hard-coded sensitivity (50%); setSensitivity() is overridden to a no-op so
    // the global sensitivity control cannot change it.
    this.sensitivity = 0.5;
    this.barCount = AnalyzerVisualization.BAR_COUNTS[this.barDensity];
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;

    // Skip if canvas has no valid size
    if (width <= 0 || height <= 0) return;

    // Ensure gradient exists and matches current height
    if (!this.barGradient || this.gradientHeight !== height) {
      this.createGradient();
    }

    // Clear canvas (transparent)
    ctx.clearRect(0, 0, width, height);

    this.analyser.getByteFrequencyData(this.dataArray);

    const barCount: number = this.barCount;
    const barWidth: number = (width - (barCount - 1) * AnalyzerVisualization.BAR_GAP) / barCount;
    const usableBins: number = Math.floor(this.dataArray.length * AnalyzerVisualization.FREQUENCY_RANGE);
    const heightScale: number = height * AnalyzerVisualization.HEIGHT_SCALE * this.sensitivityFactor;
    const radius: number = Math.min(barWidth / 2, AnalyzerVisualization.MAX_CORNER_RADIUS);

    // Use gradient if available, fallback to green
    ctx.fillStyle = this.barGradient || '#00cc00';

    for (let i: number = 0; i < barCount; i++) {
      // Map bar index to bin range, spreading usableBins evenly across all bars
      const startBin: number = Math.floor(i * usableBins / barCount);
      const endBin: number = Math.floor((i + 1) * usableBins / barCount);
      const count: number = Math.max(1, endBin - startBin);

      // Average the bins in this range
      let sum: number = 0;
      for (let j: number = startBin; j < startBin + count; j++) {
        sum += this.dataArray[j];
      }
      const value: number = sum / count;

      const barHeight: number = (value / 255) * heightScale;
      const x: number = i * (barWidth + AnalyzerVisualization.BAR_GAP);
      const y: number = height - barHeight;

      // Draw bar with rounded top
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + barWidth - radius, y);
      ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius);
      ctx.lineTo(x + barWidth, height);
      ctx.lineTo(x, height);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.fill();
    }

    this.applyFadeOverlay();
  }

  /**
   * Sensitivity is fixed at 50% for the Analyzer (see constructor); ignore the
   * global sensitivity control rather than letting it override the baked-in value.
   */
  public override setSensitivity(): void {
    // Intentionally no-op.
  }

  protected override onBarDensityChanged(): void {
    this.barCount = AnalyzerVisualization.BAR_COUNTS[this.barDensity];
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  protected override onBarColorsChanged(): void {
    // Regenerate gradient when colors change
    this.createGradient();
  }

  protected override onResize(): void {
    this.createGradient();
  }

  private createGradient(): void {
    if (this.height <= 0) {
      this.barGradient = null;
      this.gradientHeight = 0;
      return;
    }

    // Create gradient spanning full canvas height using configurable colors
    this.barGradient = this.ctx.createLinearGradient(0, this.height, 0, 0);
    this.barGradient.addColorStop(0, this.barColorBottom);
    this.barGradient.addColorStop(0.5, this.barColorMiddle);
    this.barGradient.addColorStop(1, this.barColorTop);
    this.gradientHeight = this.height;
  }
}

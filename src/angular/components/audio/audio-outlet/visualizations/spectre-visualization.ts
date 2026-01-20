/**
 * @fileoverview Waveform Modern visualization with symmetrical frequency bars and smoke effect.
 *
 * Displays frequency data as vertical bars mirrored vertically (above/below center).
 * Each bar extends both up and down from the horizontal center line. Bars are dark
 * at the center and bright green at the extremes, with a smoke-like trail effect.
 *
 * Technical details:
 * - Uses getByteFrequencyData() for frequency data
 * - 192 bars across the width, each mirrored above and below center
 * - Gradient coloring: dark center → bright green extremes
 * - Smoke effect via slow canvas fade (destination-out)
 *
 * @module app/components/audio/audio-outlet/visualizations/waveform-modern-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/**
 * Waveform Modern visualization with symmetrical frequency bars and smoke trail.
 *
 * Renders frequency data as bars extending both up and down from the vertical
 * center, creating a mirror effect. The smoke effect creates visual persistence.
 */
export class SpectreVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Spectre';
  public readonly category: string = 'Bars';

  /** Total number of bars across the width */
  private readonly TOTAL_BARS: number = 192;

  /** Gap between bars in pixels */
  private readonly BAR_GAP: number = 2;

  /** Fade rate for smoke effect (lower = longer trails) */
  private readonly SMOKE_FADE_RATE: number = 0.04;

  /** Frequency range to use (0-1, lower = more bass focus) */
  private readonly FREQUENCY_RANGE: number = 0.75;

  /** Array for frequency data */
  private dataArray: Uint8Array<ArrayBuffer>;

  /** Cached gradient for upward bars */
  private gradientUp: CanvasGradient | null = null;

  /** Cached gradient for downward bars */
  private gradientDown: CanvasGradient | null = null;

  /** Cached height for gradient invalidation */
  private gradientHeight: number = 0;

  /** Cached hue shift for gradient invalidation */
  private cachedHueShift: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this.sensitivity = 0.5;
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  /**
   * Creates gradients for bar coloring.
   * Upward gradient: dark at center → bright color at top
   * Downward gradient: dark at center → bright color at bottom
   */
  private createGradients(): void {
    if (this.height <= 0) {
      this.gradientUp = null;
      this.gradientDown = null;
      this.gradientHeight = 0;
      return;
    }

    const centerY: number = this.height / 2;

    // Apply hue shift to base colors
    const color1: {r: number; g: number; b: number} = this.shiftRgbColor(0, 20, 10);
    const color2: {r: number; g: number; b: number} = this.shiftRgbColor(0, 80, 30);
    const color3: {r: number; g: number; b: number} = this.shiftRgbColor(0, 180, 70);
    const color4: {r: number; g: number; b: number} = this.shiftRgbColor(0, 255, 100);

    // Gradient for upward bars (center to top): dark → bright
    this.gradientUp = this.ctx.createLinearGradient(0, centerY, 0, 0);
    this.gradientUp.addColorStop(0, `rgba(${color1.r}, ${color1.g}, ${color1.b}, 1)`);
    this.gradientUp.addColorStop(0.3, `rgba(${color2.r}, ${color2.g}, ${color2.b}, 1)`);
    this.gradientUp.addColorStop(0.7, `rgba(${color3.r}, ${color3.g}, ${color3.b}, 1)`);
    this.gradientUp.addColorStop(1, `rgba(${color4.r}, ${color4.g}, ${color4.b}, 1)`);

    // Gradient for downward bars (center to bottom): dark → bright
    this.gradientDown = this.ctx.createLinearGradient(0, centerY, 0, this.height);
    this.gradientDown.addColorStop(0, `rgba(${color1.r}, ${color1.g}, ${color1.b}, 1)`);
    this.gradientDown.addColorStop(0.3, `rgba(${color2.r}, ${color2.g}, ${color2.b}, 1)`);
    this.gradientDown.addColorStop(0.7, `rgba(${color3.r}, ${color3.g}, ${color3.b}, 1)`);
    this.gradientDown.addColorStop(1, `rgba(${color4.r}, ${color4.g}, ${color4.b}, 1)`);

    this.gradientHeight = this.height;
    this.cachedHueShift = this.hueShift;
  }

  protected override onResize(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.createGradients();
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;

    if (width <= 0 || height <= 0) return;

    // Ensure gradients exist and match current height and hue shift
    if (!this.gradientUp || !this.gradientDown || this.gradientHeight !== height || this.cachedHueShift !== this.hueShift) {
      this.createGradients();
    }

    // Apply smoke fade effect (destination-out creates transparency trails)
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0, 0, 0, ${this.SMOKE_FADE_RATE})`;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    // Get frequency data
    this.analyser.getByteFrequencyData(this.dataArray);

    const centerY: number = height / 2;
    const barWidth: number = (width - (this.TOTAL_BARS - 1) * this.BAR_GAP) / this.TOTAL_BARS;
    const usableBins: number = Math.floor(this.dataArray.length * this.FREQUENCY_RANGE);
    const maxBarHeight: number = height * 0.45; // Max height from center

    // Pre-calculate bar values for all bars
    const barValues: number[] = [];
    for (let i: number = 0; i < this.TOTAL_BARS; i++) {
      const startBin: number = Math.floor(i * usableBins / this.TOTAL_BARS);
      const endBin: number = Math.floor((i + 1) * usableBins / this.TOTAL_BARS);
      const count: number = Math.max(1, endBin - startBin);

      let sum: number = 0;
      for (let j: number = startBin; j < startBin + count; j++) {
        sum += this.dataArray[j];
      }
      barValues.push(sum / count);
    }

    // Draw all bars with vertical mirroring (up and down from center)
    for (let i: number = 0; i < this.TOTAL_BARS; i++) {
      const value: number = barValues[i];
      const barHeight: number = (value / 255) * maxBarHeight * (this.sensitivity * 2);
      const x: number = i * (barWidth + this.BAR_GAP);

      if (barHeight < 1) continue;

      // Draw bar going UP from center
      ctx.fillStyle = this.gradientUp || 'rgba(0, 255, 100, 0.8)';
      this.drawBar(ctx, x, centerY - barHeight, barWidth, barHeight);

      // Draw bar going DOWN from center (mirrored)
      ctx.fillStyle = this.gradientDown || 'rgba(0, 255, 100, 0.8)';
      this.drawBar(ctx, x, centerY, barWidth, barHeight);
    }

    // Add subtle glow effect
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = 'rgba(0, 255, 100, 0.5)';

    // Glow for all bars
    for (let i: number = 0; i < this.TOTAL_BARS; i++) {
      const value: number = barValues[i];
      const barHeight: number = (value / 255) * maxBarHeight * (this.sensitivity * 2);
      const x: number = i * (barWidth + this.BAR_GAP);

      if (barHeight < 2) continue;

      // Glow for upward bar
      this.drawBar(ctx, x - 1, centerY - barHeight - 1, barWidth + 2, barHeight + 2);
      // Glow for downward bar
      this.drawBar(ctx, x - 1, centerY - 1, barWidth + 2, barHeight + 2);
    }

    ctx.restore();

    this.applyFadeOverlay();
  }

  /**
   * Draws a single bar with rounded corners.
   */
  private drawBar(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
    const radius: number = Math.min(width / 2, 3, height / 2);

    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.fill();
  }
}

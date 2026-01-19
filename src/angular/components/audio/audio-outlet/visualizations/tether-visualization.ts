/**
 * @fileoverview Waveform Modern visualization with symmetrical frequency bars and smoke effect.
 *
 * Displays frequency data as vertical bars mirrored both horizontally (left/right)
 * and vertically (above/below center). Creates a symmetrical butterfly effect with
 * 192 total bars (96 per half). Bars are dark at the center and bright green at
 * the extremes, with a smoke-like trail effect.
 *
 * Technical details:
 * - Uses getByteFrequencyData() for frequency data
 * - 96 bars on left half, mirrored 96 bars on right half (y-axis symmetry)
 * - Each bar also mirrored above and below center (x-axis symmetry)
 * - Gradient coloring: dark center → bright green extremes
 * - Smoke effect via slow canvas fade (destination-out)
 *
 * @module app/components/audio/audio-outlet/visualizations/tether-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/**
 * Waveform Modern visualization with symmetrical frequency bars and smoke trail.
 *
 * Renders frequency data as bars extending both up and down from the vertical
 * center, creating a mirror effect. The smoke effect creates visual persistence.
 */
export class TetherVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Waveform Modern';
  public readonly category: string = 'waveform';

  /** Number of bars per half (total is double this, mirrored) */
  private readonly BARS_PER_HALF: number = 96;

  /** Gap between bars in pixels */
  private readonly BAR_GAP: number = 2;

  /** Fade rate for smoke effect (lower = longer trails) */
  private readonly SMOKE_FADE_RATE: number = 0.04;

  /** Frequency range to use (0-1, lower = more bass focus) */
  private readonly FREQUENCY_RANGE: number = 0.75;

  /** Array for frequency data */
  private readonly dataArray: Uint8Array<ArrayBuffer>;

  /** Cached gradient for upward bars (positive amplitude) */
  private gradientUp: CanvasGradient | null = null;

  /** Cached gradient for downward bars (negative amplitude) */
  private gradientDown: CanvasGradient | null = null;

  /** Cached height for gradient invalidation */
  private gradientHeight: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this.sensitivity = 0.5;
  }

  /**
   * Creates gradients for bar coloring.
   * Upward gradient: dark at bottom → bright green at top
   * Downward gradient: dark at top → bright green at bottom
   */
  private createGradients(): void {
    if (this.height <= 0) {
      this.gradientUp = null;
      this.gradientDown = null;
      this.gradientHeight = 0;
      return;
    }

    const centerY: number = this.height / 2;

    // Gradient for upward bars (center to top): dark → green
    this.gradientUp = this.ctx.createLinearGradient(0, centerY, 0, 0);
    this.gradientUp.addColorStop(0, 'rgba(0, 20, 10, 1)');
    this.gradientUp.addColorStop(0.3, 'rgba(0, 80, 30, 1)');
    this.gradientUp.addColorStop(0.7, 'rgba(0, 180, 70, 1)');
    this.gradientUp.addColorStop(1, 'rgba(0, 255, 100, 1)');

    // Gradient for downward bars (center to bottom): dark → green
    this.gradientDown = this.ctx.createLinearGradient(0, centerY, 0, this.height);
    this.gradientDown.addColorStop(0, 'rgba(0, 20, 10, 1)');
    this.gradientDown.addColorStop(0.3, 'rgba(0, 80, 30, 1)');
    this.gradientDown.addColorStop(0.7, 'rgba(0, 180, 70, 1)');
    this.gradientDown.addColorStop(1, 'rgba(0, 255, 100, 1)');

    this.gradientHeight = this.height;
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

    // Ensure gradients exist and match current height
    if (!this.gradientUp || !this.gradientDown || this.gradientHeight !== height) {
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
    const totalBars: number = this.BARS_PER_HALF * 2;
    const barWidth: number = (width - (totalBars - 1) * this.BAR_GAP) / totalBars;
    const usableBins: number = Math.floor(this.dataArray.length * this.FREQUENCY_RANGE);
    const maxBarHeight: number = height * 0.45; // Max height from center

    // Pre-calculate bar values for 96 bars
    const barValues: number[] = [];
    for (let i: number = 0; i < this.BARS_PER_HALF; i++) {
      const startBin: number = Math.floor(i * usableBins / this.BARS_PER_HALF);
      const endBin: number = Math.floor((i + 1) * usableBins / this.BARS_PER_HALF);
      const count: number = Math.max(1, endBin - startBin);

      let sum: number = 0;
      for (let j: number = startBin; j < startBin + count; j++) {
        sum += this.dataArray[j];
      }
      barValues.push(sum / count);
    }

    // Draw left half (bars 0-95, normal order)
    for (let i: number = 0; i < this.BARS_PER_HALF; i++) {
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

    // Draw right half (bars 95-0, mirrored on y-axis)
    for (let i: number = 0; i < this.BARS_PER_HALF; i++) {
      const mirroredIndex: number = this.BARS_PER_HALF - 1 - i;
      const value: number = barValues[mirroredIndex];
      const barHeight: number = (value / 255) * maxBarHeight * (this.sensitivity * 2);
      const x: number = (this.BARS_PER_HALF + i) * (barWidth + this.BAR_GAP);

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

    // Glow for left half
    for (let i: number = 0; i < this.BARS_PER_HALF; i++) {
      const value: number = barValues[i];
      const barHeight: number = (value / 255) * maxBarHeight * (this.sensitivity * 2);
      const x: number = i * (barWidth + this.BAR_GAP);

      if (barHeight < 2) continue;

      this.drawBar(ctx, x - 1, centerY - barHeight - 1, barWidth + 2, barHeight + 2);
      this.drawBar(ctx, x - 1, centerY - 1, barWidth + 2, barHeight + 2);
    }

    // Glow for right half (mirrored)
    for (let i: number = 0; i < this.BARS_PER_HALF; i++) {
      const mirroredIndex: number = this.BARS_PER_HALF - 1 - i;
      const value: number = barValues[mirroredIndex];
      const barHeight: number = (value / 255) * maxBarHeight * (this.sensitivity * 2);
      const x: number = (this.BARS_PER_HALF + i) * (barWidth + this.BAR_GAP);

      if (barHeight < 2) continue;

      this.drawBar(ctx, x - 1, centerY - barHeight - 1, barWidth + 2, barHeight + 2);
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

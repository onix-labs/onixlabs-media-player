/**
 * @fileoverview Spectre visualization with symmetrical frequency bars and smoke effect.
 *
 * Displays frequency data as vertical bars mirrored vertically (above/below center).
 * Each bar extends both up and down from the horizontal center line. Bars use the
 * ONIXLabs brand color spectrum from left to right, with a smoke-like trail effect.
 *
 * Technical details:
 * - Uses getByteFrequencyData() for frequency data
 * - Configurable bar count (48/96/144), each mirrored above and below center
 * - ONIXLabs brand color spectrum: Orange → Coral → Pink → Purple → Blue → Teal → Cyan → Green
 * - Smoke effect via slow canvas fade (destination-out)
 *
 * @module app/components/audio/audio-outlet/visualizations/spectre-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';
import {ONIX_COLORS_FLAT, ONIX_COLOR_COUNT} from './visualization-constants';

/**
 * Spectre visualization with symmetrical frequency bars and smoke trail.
 *
 * Renders frequency data as bars extending both up and down from the vertical
 * center, creating a mirror effect. The smoke effect creates visual persistence.
 */
export class SpectreVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Spectre';
  public readonly category: string = 'Bars';

  /** Bar count mapping for each density level */
  private static readonly BAR_COUNTS: Record<'low' | 'medium' | 'high', number> = {
    low: 48,
    medium: 96,
    high: 144
  };

  /** Total number of bars across the width */
  private totalBars: number = SpectreVisualization.BAR_COUNTS.medium;

  /** Gap between bars in pixels */
  private readonly BAR_GAP: number = 2;

  /** Fade rate for smoke effect (lower = longer trails) */
  private readonly SMOKE_FADE_RATE: number = 0.04;

  /** Frequency range to use (0-1, lower = more bass focus) */
  private readonly FREQUENCY_RANGE: number = 0.75;

  /** Clear low-alpha pixels every N frames */
  private readonly THRESHOLD_CLEAR_INTERVAL: number = 10;

  /** Pixels with alpha below this become transparent */
  private readonly ALPHA_THRESHOLD: number = 30;

  /** Array for frequency data */
  private dataArray: Uint8Array<ArrayBuffer>;

  /** Frame counter for periodic threshold clear */
  private frameCount: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this.sensitivity = 0.5;
    this.totalBars = SpectreVisualization.BAR_COUNTS[this.barDensity];
  }

  protected override onBarDensityChanged(): void {
    this.totalBars = SpectreVisualization.BAR_COUNTS[this.barDensity];
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  /**
   * Gets the interpolated color for a bar based on its horizontal position.
   * Returns RGB values interpolated across the ONIXLabs brand color spectrum.
   * Spectrum spans from first to last color without wrapping.
   */
  private getBarColor(barIndex: number, totalBars: number): {r: number; g: number; b: number} {
    // Map bar index to position in color spectrum (0 to ONIX_COLOR_COUNT - 1, no wrap)
    const maxIndex: number = Math.max(1, totalBars - 1);
    const colorPosition: number = (barIndex / maxIndex) * (ONIX_COLOR_COUNT - 1);
    const colorIndex: number = Math.min(Math.floor(colorPosition), ONIX_COLOR_COUNT - 2);
    const t: number = colorPosition - colorIndex;

    // Get current and next color indices (clamped, no wrap-around)
    const c1Idx: number = colorIndex * 3;
    const c2Idx: number = (colorIndex + 1) * 3;

    // Interpolate between colors
    const r: number = Math.round(ONIX_COLORS_FLAT[c1Idx] + (ONIX_COLORS_FLAT[c2Idx] - ONIX_COLORS_FLAT[c1Idx]) * t);
    const g: number = Math.round(ONIX_COLORS_FLAT[c1Idx + 1] + (ONIX_COLORS_FLAT[c2Idx + 1] - ONIX_COLORS_FLAT[c1Idx + 1]) * t);
    const b: number = Math.round(ONIX_COLORS_FLAT[c1Idx + 2] + (ONIX_COLORS_FLAT[c2Idx + 2] - ONIX_COLORS_FLAT[c1Idx + 2]) * t);

    return {r, g, b};
  }

  /**
   * Creates a vertical gradient for a bar from dark at center to the given color at extremes.
   */
  private createBarGradient(x: number, barWidth: number, centerY: number, height: number, r: number, g: number, b: number, upward: boolean): CanvasGradient {
    const gradient: CanvasGradient = upward
      ? this.ctx.createLinearGradient(x, centerY, x, 0)
      : this.ctx.createLinearGradient(x, centerY, x, height);

    // Dark at center, bright color at extremes
    gradient.addColorStop(0, `rgba(${Math.round(r * 0.08)}, ${Math.round(g * 0.08)}, ${Math.round(b * 0.08)}, 1)`);
    gradient.addColorStop(0.3, `rgba(${Math.round(r * 0.35)}, ${Math.round(g * 0.35)}, ${Math.round(b * 0.35)}, 1)`);
    gradient.addColorStop(0.7, `rgba(${Math.round(r * 0.75)}, ${Math.round(g * 0.75)}, ${Math.round(b * 0.75)}, 1)`);
    gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 1)`);

    return gradient;
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;

    if (width <= 0 || height <= 0) return;

    // Apply smoke fade effect (destination-out creates transparency trails)
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0, 0, 0, ${this.SMOKE_FADE_RATE})`;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    // Periodically clear low-alpha pixels to prevent ghosting artifacts
    this.frameCount++;
    if (this.frameCount >= this.THRESHOLD_CLEAR_INTERVAL) {
      this.frameCount = 0;
      this.clearLowAlphaPixels();
    }

    // Get frequency data
    this.analyser.getByteFrequencyData(this.dataArray);

    const centerY: number = height / 2;
    const barWidth: number = (width - (this.totalBars - 1) * this.BAR_GAP) / this.totalBars;
    const usableBins: number = Math.floor(this.dataArray.length * this.FREQUENCY_RANGE);
    const maxBarHeight: number = height * 0.45; // Max height from center

    // Pre-calculate bar values and heights for all bars
    const sensitivityFactor: number = this.sensitivityFactor;
    const barHeights: number[] = [];
    const barXPositions: number[] = [];
    const barColors: Array<{r: number; g: number; b: number}> = [];

    for (let i: number = 0; i < this.totalBars; i++) {
      const startBin: number = Math.floor(i * usableBins / this.totalBars);
      const endBin: number = Math.floor((i + 1) * usableBins / this.totalBars);
      const count: number = Math.max(1, endBin - startBin);

      let sum: number = 0;
      for (let j: number = startBin; j < startBin + count; j++) {
        sum += this.dataArray[j];
      }
      const value: number = sum / count;
      barHeights.push((value / 255) * maxBarHeight * sensitivityFactor);
      barXPositions.push(i * (barWidth + this.BAR_GAP));
      barColors.push(this.getBarColor(i, this.totalBars));
    }

    // Draw all bars with vertical mirroring (up and down from center)
    for (let i: number = 0; i < this.totalBars; i++) {
      const barHeight: number = barHeights[i];
      if (barHeight < 1) continue;

      const x: number = barXPositions[i];
      const color: {r: number; g: number; b: number} = barColors[i];

      // Draw bar going UP from center
      ctx.fillStyle = this.createBarGradient(x, barWidth, centerY, height, color.r, color.g, color.b, true);
      this.drawBar(ctx, x, centerY - barHeight, barWidth, barHeight);

      // Draw bar going DOWN from center (mirrored)
      ctx.fillStyle = this.createBarGradient(x, barWidth, centerY, height, color.r, color.g, color.b, false);
      this.drawBar(ctx, x, centerY, barWidth, barHeight);
    }

    // Add subtle glow effect (vertical only, no horizontal extension into gaps)
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.3;

    // Glow for all bars (reuse pre-calculated values)
    for (let i: number = 0; i < this.totalBars; i++) {
      const barHeight: number = barHeights[i];
      if (barHeight < 2) continue;

      const x: number = barXPositions[i];
      const color: {r: number; g: number; b: number} = barColors[i];
      ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, 0.5)`;

      // Glow for upward bar (only extends vertically)
      this.drawBar(ctx, x, centerY - barHeight - 1, barWidth, barHeight + 1);
      // Glow for downward bar (only extends vertically)
      this.drawBar(ctx, x, centerY, barWidth, barHeight + 1);
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

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

export class BarsVisualization extends Canvas2DVisualization {
  private readonly BAR_COUNT: number = 128;
  private readonly BAR_GAP: number = 2;
  private readonly FREQUENCY_RANGE: number = 0.75;
  private dataArray: Uint8Array<ArrayBuffer>;
  private barGradient: CanvasGradient | null = null;
  private gradientHeight: number = 0;

  constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  private createGradient(): void {
    if (this.height <= 0) return;

    // Create gradient spanning full canvas height: green (bottom) -> yellow (middle) -> red (top)
    this.barGradient = this.ctx.createLinearGradient(0, this.height, 0, 0);
    this.barGradient.addColorStop(0, '#00cc00');    // Green at bottom
    this.barGradient.addColorStop(0.5, '#cccc00');  // Yellow in middle
    this.barGradient.addColorStop(1, '#cc0000');    // Red at top
    this.gradientHeight = this.height;
  }

  protected override onResize(): void {
    this.createGradient();
  }

  draw(): void {
    const {ctx, width, height} = this;

    // Ensure gradient exists and matches current height
    if (!this.barGradient || this.gradientHeight !== height) {
      this.createGradient();
    }

    // Skip drawing if no valid gradient
    if (!this.barGradient) return;

    // Clear with fade effect
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, width, height);

    this.analyser.getByteFrequencyData(this.dataArray);

    const barWidth: number = (width - (this.BAR_COUNT - 1) * this.BAR_GAP) / this.BAR_COUNT;
    const usableBins: number = Math.floor(this.dataArray.length * this.FREQUENCY_RANGE);
    const step: number = Math.floor(usableBins / this.BAR_COUNT);

    ctx.fillStyle = this.barGradient!;

    for (let i: number = 0; i < this.BAR_COUNT; i++) {
      // Average nearby frequencies for smoother visualization
      let sum: number = 0;
      for (let j: number = 0; j < step; j++) {
        sum += this.dataArray[i * step + j];
      }
      const value: number = sum / step;

      const barHeight: number = (value / 255) * height * 0.85;
      const x: number = i * (barWidth + this.BAR_GAP);
      const y: number = height - barHeight;

      // Draw bar with rounded top
      const radius: number = Math.min(barWidth / 2, 4);
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
  }
}

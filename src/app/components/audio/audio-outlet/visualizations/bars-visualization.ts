import {Canvas2DVisualization, VisualizationConfig} from './visualization';

export class BarsVisualization extends Canvas2DVisualization {
  private readonly BAR_COUNT = 128;
  private readonly BAR_GAP = 2;
  private readonly FREQUENCY_RANGE = 0.75;
  private dataArray: Uint8Array<ArrayBuffer>;
  private barGradient: CanvasGradient | null = null;

  constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    // Create gradient spanning full canvas height: green (bottom) -> yellow (middle) -> red (top)
    this.barGradient = this.ctx.createLinearGradient(0, this.height, 0, 0);
    this.barGradient.addColorStop(0, '#00cc00');    // Green at bottom
    this.barGradient.addColorStop(0.5, '#cccc00');  // Yellow in middle
    this.barGradient.addColorStop(1, '#cc0000');    // Red at top
  }

  draw(): void {
    const {ctx, width, height} = this;

    // Ensure gradient exists
    if (!this.barGradient) {
      this.onResize();
    }

    // Clear with fade effect
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, width, height);

    this.analyser.getByteFrequencyData(this.dataArray);

    const barWidth = (width - (this.BAR_COUNT - 1) * this.BAR_GAP) / this.BAR_COUNT;
    const usableBins = Math.floor(this.dataArray.length * this.FREQUENCY_RANGE);
    const step = Math.floor(usableBins / this.BAR_COUNT);

    ctx.fillStyle = this.barGradient!;

    for (let i = 0; i < this.BAR_COUNT; i++) {
      // Average nearby frequencies for smoother visualization
      let sum = 0;
      for (let j = 0; j < step; j++) {
        sum += this.dataArray[i * step + j];
      }
      const value = sum / step;

      const barHeight = (value / 255) * height * 0.85;
      const x = i * (barWidth + this.BAR_GAP);
      const y = height - barHeight;

      // Draw bar with rounded top
      const radius = Math.min(barWidth / 2, 4);
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

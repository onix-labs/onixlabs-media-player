import {Canvas2DVisualization, VisualizationConfig} from './visualization';

export class BarsVisualization extends Canvas2DVisualization {
  private readonly BAR_COUNT = 64;
  private readonly BAR_GAP = 2;
  private readonly FREQUENCY_RANGE = 0.75;
  private dataArray: Uint8Array<ArrayBuffer>;

  constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  draw(): void {
    const {ctx, width, height} = this;

    // Clear with fade effect
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, width, height);

    this.analyser.getByteFrequencyData(this.dataArray);

    const barWidth = (width - (this.BAR_COUNT - 1) * this.BAR_GAP) / this.BAR_COUNT;
    const usableBins = Math.floor(this.dataArray.length * this.FREQUENCY_RANGE);
    const step = Math.floor(usableBins / this.BAR_COUNT);

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

      // Create gradient based on frequency position
      const hue = 200 + (i / this.BAR_COUNT) * 60; // Blue to cyan
      const lightness = 45 + (value / 255) * 20;

      const gradient = ctx.createLinearGradient(x, y, x, height);
      gradient.addColorStop(0, `hsl(${hue}, 85%, ${lightness + 15}%)`);
      gradient.addColorStop(1, `hsl(${hue}, 75%, ${lightness}%)`);

      ctx.fillStyle = gradient;

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

      // Reflection effect
      const reflectionGradient = ctx.createLinearGradient(x, height, x, height + barHeight * 0.2);
      reflectionGradient.addColorStop(0, `hsla(${hue}, 75%, ${lightness}%, 0.4)`);
      reflectionGradient.addColorStop(1, `hsla(${hue}, 75%, ${lightness}%, 0)`);
      ctx.fillStyle = reflectionGradient;
      ctx.fillRect(x, height, barWidth, barHeight * 0.2);
    }
  }
}

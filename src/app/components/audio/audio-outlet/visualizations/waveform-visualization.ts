import {Canvas2DVisualization, VisualizationConfig} from './visualization';

export class WaveformVisualization extends Canvas2DVisualization {
  private readonly FADE_RATE: number = 0.03; // Very slow fade for LCD ghosting effect
  private readonly LINE_WIDTH: number = 2;
  private readonly GLOW_BLUR: number = 15;
  private dataArray: Uint8Array<ArrayBuffer>;

  constructor(config: VisualizationConfig) {
    super(config);
    this.analyser.fftSize = 2048; // Higher resolution for smoother waveform
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    // Clear canvas on resize (transparent)
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  draw(): void {
    const {ctx, width, height, dataArray} = this;

    // Slow fade effect - creates the LCD ghosting/persistence (transparent background)
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0, 0, 0, ${this.FADE_RATE})`;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    // Get time domain data (waveform)
    this.analyser.getByteTimeDomainData(dataArray);

    const centerY: number = height / 2;
    const sliceWidth: number = width / dataArray.length;

    // Draw glow layer (larger, blurred line underneath)
    ctx.save();
    ctx.shadowBlur = this.GLOW_BLUR;
    ctx.shadowColor = 'rgba(0, 255, 100, 0.8)';
    ctx.strokeStyle = 'rgba(0, 255, 100, 0.3)';
    ctx.lineWidth = this.LINE_WIDTH + 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    let x: number = 0;

    for (let i: number = 0; i < dataArray.length; i++) {
      // Convert byte (0-255) to amplitude (-1 to 1)
      const amplitude: number = (dataArray[i] - 128) / 128;
      const y: number = centerY + amplitude * (height * 0.4);

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }

      x += sliceWidth;
    }

    ctx.stroke();
    ctx.restore();

    // Draw main waveform line (crisp green)
    ctx.strokeStyle = 'rgb(0, 255, 100)';
    ctx.lineWidth = this.LINE_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    x = 0;

    for (let i: number = 0; i < dataArray.length; i++) {
      const amplitude: number = (dataArray[i] - 128) / 128;
      const y: number = centerY + amplitude * (height * 0.4);

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }

      x += sliceWidth;
    }

    ctx.stroke();

    // Draw highlight line (brighter, thinner)
    ctx.strokeStyle = 'rgba(150, 255, 180, 0.6)';
    ctx.lineWidth = 1;

    ctx.beginPath();
    x = 0;

    for (let i: number = 0; i < dataArray.length; i++) {
      const amplitude: number = (dataArray[i] - 128) / 128;
      const y: number = centerY + amplitude * (height * 0.4);

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }

      x += sliceWidth;
    }

    ctx.stroke();
  }
}

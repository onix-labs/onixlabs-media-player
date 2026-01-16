import {Canvas2DVisualization, VisualizationConfig} from './visualization';

export class TunnelVisualization extends Canvas2DVisualization {
  private readonly FADE_RATE = 0.05;
  private readonly ZOOM_SCALE = 1.02; // Scale factor per frame for tunnel effect
  private readonly LINE_WIDTH = 2;
  private readonly GLOW_BLUR = 12;
  private dataArray: Uint8Array<ArrayBuffer>;

  constructor(config: VisualizationConfig) {
    super(config);
    this.analyser.fftSize = 2048;
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    this.ctx.fillStyle = 'black';
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  draw(): void {
    const {ctx, width, height, dataArray} = this;

    // Save current canvas content, scale it (zoom effect), then fade
    ctx.save();

    // Translate to center, scale, translate back - creates zoom from center
    ctx.translate(width / 2, height / 2);
    ctx.scale(this.ZOOM_SCALE, this.ZOOM_SCALE);
    ctx.translate(-width / 2, -height / 2);

    // Draw the previous frame (already on canvas) with slight zoom
    // This is implicit - we're just transforming the context

    ctx.restore();

    // Apply fade over the zoomed content
    ctx.fillStyle = `rgba(0, 0, 0, ${this.FADE_RATE})`;
    ctx.fillRect(0, 0, width, height);

    // To actually achieve the zoom effect, we need to copy, clear, and redraw scaled
    // Let's use a different approach - draw to temp canvas, scale back
    this.applyZoomEffect();

    // Get time domain data
    this.analyser.getByteTimeDomainData(dataArray);

    // Split canvas into thirds: 1/3 above top waveform, 1/3 between them, 1/3 below bottom
    const thirdHeight = height / 3;
    const topCenterY = thirdHeight;           // Top waveform at 1/3 from top
    const bottomCenterY = thirdHeight * 2;    // Bottom waveform at 2/3 from top
    const waveformAmplitude = thirdHeight * 0.4;

    // Draw top waveform (pure blue)
    this.drawWaveform(topCenterY, waveformAmplitude, 'rgb(0, 0, 255)', 'rgba(0, 0, 255, 0.8)');

    // Draw bottom waveform (pure red)
    this.drawWaveform(bottomCenterY, waveformAmplitude, 'rgb(255, 0, 0)', 'rgba(255, 0, 0, 0.8)');
  }

  private applyZoomEffect(): void {
    const {ctx, width, height} = this;

    // Create offscreen canvas to hold current content
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext('2d')!;

    // Copy current canvas to temp
    tempCtx.drawImage(ctx.canvas, 0, 0);

    // Clear main canvas
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, width, height);

    // Draw back scaled from center
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(this.ZOOM_SCALE, this.ZOOM_SCALE);
    ctx.translate(-width / 2, -height / 2);
    ctx.drawImage(tempCanvas, 0, 0);
    ctx.restore();

    // Apply fade
    ctx.fillStyle = `rgba(0, 0, 0, ${this.FADE_RATE})`;
    ctx.fillRect(0, 0, width, height);
  }

  private drawWaveform(centerY: number, amplitude: number, color: string, glowColor: string): void {
    const {ctx, width, dataArray} = this;
    const sliceWidth = width / dataArray.length;

    // Glow layer
    ctx.save();
    ctx.shadowBlur = this.GLOW_BLUR;
    ctx.shadowColor = glowColor;
    ctx.strokeStyle = glowColor.replace('0.8', '0.3');
    ctx.lineWidth = this.LINE_WIDTH + 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    let x = 0;

    for (let i = 0; i < dataArray.length; i++) {
      const sample = (dataArray[i] - 128) / 128;
      const y = centerY + sample * amplitude;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }

    ctx.stroke();
    ctx.restore();

    // Main line
    ctx.strokeStyle = color;
    ctx.lineWidth = this.LINE_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    x = 0;

    for (let i = 0; i < dataArray.length; i++) {
      const sample = (dataArray[i] - 128) / 128;
      const y = centerY + sample * amplitude;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }

    ctx.stroke();

    // Highlight
    ctx.strokeStyle = `rgba(255, 255, 255, 0.4)`;
    ctx.lineWidth = 1;

    ctx.beginPath();
    x = 0;

    for (let i = 0; i < dataArray.length; i++) {
      const sample = (dataArray[i] - 128) / 128;
      const y = centerY + sample * amplitude;

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

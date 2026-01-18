/**
 * @fileoverview Tunnel effect visualization with dual waveforms.
 *
 * Creates a hypnotic tunnel/vortex effect with two mirrored waveforms
 * (blue and red) that zoom toward the center. The persistence and zoom
 * create an infinite tunnel illusion.
 *
 * Technical details:
 * - Dual waveforms at 1/3 and 2/3 vertical positions
 * - Zoom effect scales previous frame from center
 * - Fade combined with zoom creates depth illusion
 * - Blue (top) and red (bottom) color scheme
 * - Each waveform has glow, main, and highlight layers
 *
 * @module app/components/audio/audio-outlet/visualizations/tunnel-visualization
 */

import {Canvas2DVisualization, VisualizationConfig, VisualizationCategory} from './visualization';

/**
 * Tunnel visualization with zooming dual waveforms.
 *
 * Renders two mirrored waveforms (blue and red) that appear to zoom
 * into infinity, creating a hypnotic tunnel effect.
 */
export class TunnelVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Tunnel';
  public readonly category: VisualizationCategory = 'waveform';

  private readonly FADE_RATE: number = 0.05;
  private readonly ZOOM_SCALE: number = 1.02; // Scale factor per frame for tunnel effect
  private readonly LINE_WIDTH: number = 2;
  private readonly GLOW_BLUR: number = 12;
  private readonly dataArray: Uint8Array<ArrayBuffer>;

  constructor(config: VisualizationConfig) {
    super(config);
    this.analyser.fftSize = 2048;
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;
    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;

    // Apply zoom effect with fade (handled via globalAlpha)
    this.applyZoomEffect();

    // Get time domain data
    this.analyser.getByteTimeDomainData(dataArray);

    // Split canvas into thirds: 1/3 above top waveform, 1/3 between them, 1/3 below bottom
    const thirdHeight: number = height / 3;
    const topCenterY: number = thirdHeight;           // Top waveform at 1/3 from top
    const bottomCenterY: number = thirdHeight * 2;    // Bottom waveform at 2/3 from top
    const waveformAmplitude: number = thirdHeight * 0.4;

    // Draw top waveform (pure blue)
    this.drawWaveform(topCenterY, waveformAmplitude, 'rgb(0, 0, 255)', 'rgba(0, 0, 255, 0.8)');

    // Draw bottom waveform (pure red)
    this.drawWaveform(bottomCenterY, waveformAmplitude, 'rgb(255, 0, 0)', 'rgba(255, 0, 0, 0.8)');

    this.applyFadeOverlay();
  }

  private applyZoomEffect(): void {
    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;

    // Create offscreen canvas to hold current content
    const tempCanvas: HTMLCanvasElement = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx: CanvasRenderingContext2D = tempCanvas.getContext('2d')!;

    // Copy current canvas to temp
    tempCtx.drawImage(ctx.canvas, 0, 0);

    // Clear main canvas (transparent)
    ctx.clearRect(0, 0, width, height);

    // Draw back scaled from center with reduced opacity for fade effect
    ctx.save();
    ctx.globalAlpha = 1 - this.FADE_RATE;
    ctx.translate(width / 2, height / 2);
    ctx.scale(this.ZOOM_SCALE, this.ZOOM_SCALE);
    ctx.translate(-width / 2, -height / 2);
    ctx.drawImage(tempCanvas, 0, 0);
    ctx.restore();
  }

  private drawWaveform(centerY: number, amplitude: number, color: string, glowColor: string): void {
    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;
    const sliceWidth: number = width / dataArray.length;

    // Glow layer
    ctx.save();
    ctx.shadowBlur = this.GLOW_BLUR;
    ctx.shadowColor = glowColor;
    ctx.strokeStyle = glowColor.replace('0.8', '0.3');
    ctx.lineWidth = this.LINE_WIDTH + 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    let x: number = 0;

    for (let i: number = 0; i < dataArray.length; i++) {
      const sample: number = ((dataArray[i] - 128) / 128) * (this.sensitivity * 2);
      const y: number = centerY + sample * amplitude;

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

    for (let i: number = 0; i < dataArray.length; i++) {
      const sample: number = ((dataArray[i] - 128) / 128) * (this.sensitivity * 2);
      const y: number = centerY + sample * amplitude;

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

    for (let i: number = 0; i < dataArray.length; i++) {
      const sample: number = ((dataArray[i] - 128) / 128) * (this.sensitivity * 2);
      const y: number = centerY + sample * amplitude;

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

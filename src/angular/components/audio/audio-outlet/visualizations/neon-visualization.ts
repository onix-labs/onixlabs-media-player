/**
 * @fileoverview Rotating neon waveform visualization.
 *
 * Creates a spinning neon effect with two waveforms (cyan and magenta)
 * that rotate around the center while zooming. The rotation combined
 * with persistence creates mesmerizing spiral patterns.
 *
 * Technical details:
 * - Dual waveforms offset from center
 * - Continuous rotation around canvas center
 * - Zoom effect with fade creates spiral trails
 * - Cyan and magenta color scheme (complementary)
 * - Rotation speed is constant, independent of audio
 *
 * @module app/components/audio/audio-outlet/visualizations/neon-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/**
 * Rotating neon visualization with spiral trails.
 *
 * Renders two rotating waveforms (cyan and magenta) that create
 * spiral patterns as they spin and fade.
 */
export class NeonVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Neon';
  public readonly category: string = 'Waves';

  private readonly FADE_RATE: number = 0.05;
  private readonly ZOOM_SCALE: number = 1.02;
  private readonly ROTATION_SPEED: number = 0.008;
  private readonly LINE_WIDTH: number = 2;
  private readonly GLOW_BLUR: number = 12;
  private readonly dataArray: Uint8Array<ArrayBuffer>;
  private rotationAngle: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.analyser.fftSize = 2048;
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.sensitivity = 0.5;
  }

  protected override onResize(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;

    // Apply zoom effect with fade and rotation
    this.applyZoomEffect();

    // Get time domain data
    this.analyser.getByteTimeDomainData(this.dataArray);

    // Update rotation angle
    this.rotationAngle += this.ROTATION_SPEED;

    // Calculate waveform positions (relative to center)
    const waveformOffset: number = height / 6;
    const waveformAmplitude: number = height / 8;

    // Draw rotated waveforms around center
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate(this.rotationAngle);

    // Draw cyan waveform (top, offset from center)
    this.drawWaveform(-waveformOffset, waveformAmplitude, 'rgb(0, 255, 255)', 'rgba(0, 255, 255, 0.8)');

    // Draw magenta waveform (bottom, offset from center)
    this.drawWaveform(waveformOffset, waveformAmplitude, 'rgb(255, 0, 255)', 'rgba(255, 0, 255, 0.8)');

    ctx.restore();

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
    // Apply trail intensity multiplier to fade rate
    const effectiveFadeRate: number = this.FADE_RATE * this.getFadeMultiplier();
    ctx.save();
    ctx.globalAlpha = 1 - effectiveFadeRate;
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
    let x: number = -width / 2;

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
    x = -width / 2;

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
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1;

    ctx.beginPath();
    x = -width / 2;

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

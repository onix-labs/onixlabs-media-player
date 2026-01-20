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
  private readonly BASE_GLOW_BLUR: number = 12;
  private dataArray: Uint8Array<ArrayBuffer>;
  private rotationAngle: number = 0;

  /** Cached offscreen canvas for zoom effect (avoids per-frame allocation) */
  private tempCanvas: HTMLCanvasElement;
  private tempCtx: CanvasRenderingContext2D;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.sensitivity = 0.5;
    this.tempCanvas = document.createElement('canvas');
    this.tempCtx = this.tempCanvas.getContext('2d')!;
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.tempCanvas.width = this.width;
    this.tempCanvas.height = this.height;
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

    // Apply hue shift to base colors
    const cyanColor: {r: number; g: number; b: number} = this.shiftRgbColor(0, 255, 255);
    const magentaColor: {r: number; g: number; b: number} = this.shiftRgbColor(255, 0, 255);

    // Draw rotated waveforms around center
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate(this.rotationAngle);

    // Draw cyan waveform (top, offset from center)
    this.drawWaveform(
      -waveformOffset, waveformAmplitude,
      `rgb(${cyanColor.r}, ${cyanColor.g}, ${cyanColor.b})`,
      `rgba(${cyanColor.r}, ${cyanColor.g}, ${cyanColor.b}, 0.8)`
    );

    // Draw magenta waveform (bottom, offset from center)
    this.drawWaveform(
      waveformOffset, waveformAmplitude,
      `rgb(${magentaColor.r}, ${magentaColor.g}, ${magentaColor.b})`,
      `rgba(${magentaColor.r}, ${magentaColor.g}, ${magentaColor.b}, 0.8)`
    );

    ctx.restore();

    this.applyFadeOverlay();
  }

  private applyZoomEffect(): void {
    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;

    // Copy current canvas to cached offscreen canvas
    this.tempCtx.clearRect(0, 0, width, height);
    this.tempCtx.drawImage(ctx.canvas, 0, 0);

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
    ctx.drawImage(this.tempCanvas, 0, 0);
    ctx.restore();
  }

  private drawWaveform(centerY: number, amplitude: number, color: string, glowColor: string): void {
    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;
    const sliceWidth: number = width / dataArray.length;
    const sensitivityFactor: number = this.sensitivity * 2;
    const startX: number = -width / 2;

    const buildPath: () => void = (): void => {
      ctx.beginPath();
      let x: number = startX;
      for (let i: number = 0; i < dataArray.length; i++) {
        const sample: number = ((dataArray[i] - 128) / 128) * sensitivityFactor;
        const y: number = centerY + sample * amplitude;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        x += sliceWidth;
      }
    };

    this.drawPathWithLayers(buildPath, color, glowColor, 'rgba(255, 255, 255, 0.4)', {
      baseGlowBlur: this.BASE_GLOW_BLUR
    });
  }
}

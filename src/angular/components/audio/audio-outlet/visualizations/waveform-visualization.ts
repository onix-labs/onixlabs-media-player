/**
 * @fileoverview Oscilloscope-style waveform visualization.
 *
 * Displays the audio waveform in the style of a classic oscilloscope with
 * an LCD ghosting/persistence effect. The green glow and trail effect
 * creates a retro electronic display aesthetic.
 *
 * Technical details:
 * - Uses getByteTimeDomainData() for waveform data
 * - Higher FFT size (2048) for smoother waveform
 * - Persistence effect via slow fade and transparent background
 * - Multi-layer rendering: glow, main line, highlight
 * - Sensitivity scales the waveform amplitude
 *
 * @module app/components/audio/audio-outlet/visualizations/waveform-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/**
 * Oscilloscope waveform visualization with persistence effect.
 *
 * Renders the audio waveform as a glowing green line with an LCD-style
 * ghosting effect that creates visual trails.
 */
export class WaveformVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Classic';
  public readonly category: string = 'Waves';

  private readonly FADE_RATE: number = 0.03; // Very slow fade for LCD ghosting effect
  private readonly BASE_GLOW_BLUR: number = 15;
  private dataArray: Uint8Array<ArrayBuffer>;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.sensitivity = 0.4;
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  protected override onResize(): void {
    // Clear canvas on resize (transparent)
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;
    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;

    // Slow fade effect - creates the LCD ghosting/persistence (transparent background)
    // Apply trail intensity multiplier to fade rate
    const effectiveFadeRate: number = this.FADE_RATE * this.getFadeMultiplier();
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0, 0, 0, ${effectiveFadeRate})`;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    // Get time domain data (waveform)
    this.analyser.getByteTimeDomainData(dataArray);

    const centerY: number = height / 2;
    const sliceWidth: number = width / dataArray.length;
    const amplitudeScale: number = height * 0.4;
    const sensitivityFactor: number = this.sensitivity * 2;

    // Apply hue shift to base green color (0, 255, 100)
    const baseColor: {r: number; g: number; b: number} = this.shiftRgbColor(0, 255, 100);
    const colorMain: string = `rgb(${baseColor.r}, ${baseColor.g}, ${baseColor.b})`;
    const colorGlow: string = `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.8)`;

    // Use a lighter version of the shifted color for highlight
    const highlightColor: {r: number; g: number; b: number} = this.shiftRgbColor(150, 255, 180);
    const colorHighlight: string = `rgba(${highlightColor.r}, ${highlightColor.g}, ${highlightColor.b}, 0.6)`;

    const buildPath: () => void = (): void => {
      ctx.beginPath();
      let x: number = 0;
      for (let i: number = 0; i < dataArray.length; i++) {
        const amplitude: number = ((dataArray[i] - 128) / 128) * sensitivityFactor;
        const y: number = centerY + amplitude * amplitudeScale;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        x += sliceWidth;
      }
    };

    this.drawPathWithLayers(buildPath, colorMain, colorGlow, colorHighlight, {
      baseGlowBlur: this.BASE_GLOW_BLUR
    });

    this.applyFadeOverlay();
  }
}

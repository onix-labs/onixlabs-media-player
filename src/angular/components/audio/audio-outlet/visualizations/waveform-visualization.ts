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
  private readonly WAVEFORM_POINTS: number = 128;
  private readonly THRESHOLD_CLEAR_INTERVAL: number = 10; // Clear low-alpha pixels every N frames
  private dataArray: Uint8Array<ArrayBuffer>;
  private frameCount: number = 0;

  /** Pre-allocated point array for waveform */
  private readonly points: Array<{x: number; y: number}>;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.sensitivity = 0.4;
    this.preserveContentOnResize = true;

    // Pre-allocate point array
    this.points = [];
    for (let i: number = 0; i <= this.WAVEFORM_POINTS; i++) {
      this.points.push({x: 0, y: 0});
    }
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
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

    // Periodically clear low-alpha pixels to prevent ghosting artifacts
    this.frameCount++;
    if (this.frameCount >= this.THRESHOLD_CLEAR_INTERVAL) {
      this.frameCount = 0;
      this.clearLowAlphaPixels();
    }

    // Get time domain data (waveform)
    this.analyser.getByteTimeDomainData(dataArray);

    const centerY: number = height / 2;
    const numPoints: number = this.WAVEFORM_POINTS;
    const amplitudeScale: number = height * 0.4;
    const sensitivityFactor: number = this.sensitivityFactor;
    const dataLength: number = dataArray.length;

    // Calculate waveform points - use ratio to ensure full width coverage
    for (let i: number = 0; i <= numPoints; i++) {
      const t: number = i / numPoints;
      const dataIndex: number = Math.min(Math.floor(t * dataLength), dataLength - 1);
      const amplitude: number = ((dataArray[dataIndex] - 128) / 128) * sensitivityFactor;
      this.points[i].x = t * width;
      this.points[i].y = centerY + amplitude * amplitudeScale;
    }

    // Green color theme
    const colorMain: string = 'rgb(0, 255, 100)';
    const colorGlow: string = 'rgba(0, 255, 100, 0.8)';
    const colorHighlight: string = 'rgba(150, 255, 180, 0.6)';

    // Build path using the base class smooth path helper
    const buildPath: () => void = (): void => {
      this.buildSmoothPath(ctx, this.points, numPoints);
    };

    this.drawPathWithLayers(buildPath, colorMain, colorGlow, colorHighlight, {
      baseGlowBlur: this.BASE_GLOW_BLUR
    });

    this.applyFadeOverlay();

    // Mark that we've drawn at least once (for resize preservation logic)
    this.hasDrawn = true;
  }

}

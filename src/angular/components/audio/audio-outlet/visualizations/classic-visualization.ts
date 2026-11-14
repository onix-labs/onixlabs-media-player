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
 * - A fixed gain scales the waveform amplitude
 *
 * @module app/components/audio/audio-outlet/visualizations/classic-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/**
 * Oscilloscope waveform visualization with persistence effect.
 *
 * Renders the audio waveform as a glowing green line with an LCD-style
 * ghosting effect that creates visual trails.
 */
export class ClassicVisualization extends Canvas2DVisualization {
  /** Per-frame fade for the LCD ghosting effect; fast enough to keep the trails short. */
  private static readonly FADE_RATE: number = 0.06;

  /** Gain applied to the waveform samples before they are drawn. */
  private static readonly SENSITIVITY_FACTOR: number = 0.4;

  /** Glow blur radius in pixels. None: Classic's glow is the wider translucent stroke alone. */
  private static readonly GLOW_BLUR: number = 0;

  /** Number of points sampled across the waveform. */
  private static readonly WAVEFORM_POINTS: number = 32;

  /** Clear low-alpha pixels every N frames to suppress ghosting. */
  private static readonly THRESHOLD_CLEAR_INTERVAL: number = 10;

  /** Waveform stroke color. */
  private static readonly COLOR_MAIN: string = 'rgb(0, 255, 100)';

  /** Waveform glow color. */
  private static readonly COLOR_GLOW: string = 'rgba(0, 255, 100, 0.8)';

  /** Waveform highlight color. */
  private static readonly COLOR_HIGHLIGHT: string = 'rgba(150, 255, 180, 0.6)';

  public readonly name: string = 'Classic';
  public readonly category: string = 'Bars & Waves';

  private dataArray: Uint8Array<ArrayBuffer>;

  /** Pre-allocated point array for the waveform. */
  private readonly points: Array<{x: number; y: number}>;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    this.preserveContentOnResize = true;

    // Pre-allocate point array
    this.points = [];
    for (let i: number = 0; i <= ClassicVisualization.WAVEFORM_POINTS; i++) {
      this.points.push({x: 0, y: 0});
    }
  }

  public draw(): void {
    this.updateFade();

    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;
    const dataArray: Uint8Array<ArrayBuffer> = this.dataArray;

    // Skip if canvas has no valid size
    if (width <= 0 || height <= 0) return;

    // Slow fade creates the LCD ghosting/persistence (transparent background).
    this.applyPersistenceFade(ClassicVisualization.FADE_RATE);

    // Periodically clear low-alpha pixels to prevent ghosting artifacts.
    this.periodicClearLowAlpha(ClassicVisualization.THRESHOLD_CLEAR_INTERVAL);

    // Get time domain data (waveform)
    this.analyser.getByteTimeDomainData(dataArray);

    const centerY: number = height / 2;
    const numPoints: number = ClassicVisualization.WAVEFORM_POINTS;
    const amplitudeScale: number = height * 0.4;
    const sensitivityFactor: number = ClassicVisualization.SENSITIVITY_FACTOR;
    const dataLength: number = dataArray.length;

    // Calculate waveform points - use ratio to ensure full width coverage
    for (let i: number = 0; i <= numPoints; i++) {
      const t: number = i / numPoints;
      const dataIndex: number = Math.min(Math.floor(t * dataLength), dataLength - 1);
      const amplitude: number = ((dataArray[dataIndex] - 128) / 128) * sensitivityFactor;
      this.points[i].x = t * width;
      this.points[i].y = centerY + amplitude * amplitudeScale;
    }

    // Build path using the base class smooth path helper
    const buildPath: () => void = (): void => {
      this.buildSmoothPath(ctx, this.points, numPoints);
    };

    this.drawPathWithLayers(buildPath, ClassicVisualization.COLOR_MAIN, ClassicVisualization.COLOR_GLOW, ClassicVisualization.COLOR_HIGHLIGHT, {
      glowBlur: ClassicVisualization.GLOW_BLUR
    });

    this.applyFadeOverlay();

    // Mark that we've drawn at least once (for resize preservation logic)
    this.hasDrawn = true;
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }
}

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
  /** Very slow fade for the LCD ghosting effect. */
  private static readonly FADE_RATE: number = 0.03;

  /** Base glow blur radius in pixels. */
  private static readonly BASE_GLOW_BLUR: number = 15;

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
  public readonly category: string = 'Waves';

  private dataArray: Uint8Array<ArrayBuffer>;

  /** Pre-allocated point array for the waveform. */
  private readonly points: Array<{x: number; y: number}>;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    // Hard-coded look; the matching setters are overridden to no-ops so the
    // (removed) global controls cannot change these.
    this.sensitivity = 0.2;       // 20%
    this.trailIntensity = 0;      // fastest fade / minimal trails
    this.lineWidth = 1;           // 1px
    this.glowIntensity = 0;       // no glow
    this.waveformSmoothing = 1;   // 100%
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

    // Slow fade creates the LCD ghosting/persistence (transparent background).
    this.applyPersistenceFade(ClassicVisualization.FADE_RATE);

    // Periodically clear low-alpha pixels to prevent ghosting artifacts.
    this.periodicClearLowAlpha(ClassicVisualization.THRESHOLD_CLEAR_INTERVAL);

    // Get time domain data (waveform)
    this.analyser.getByteTimeDomainData(dataArray);

    const centerY: number = height / 2;
    const numPoints: number = ClassicVisualization.WAVEFORM_POINTS;
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

    // Build path using the base class smooth path helper
    const buildPath: () => void = (): void => {
      this.buildSmoothPath(ctx, this.points, numPoints);
    };

    this.drawPathWithLayers(buildPath, ClassicVisualization.COLOR_MAIN, ClassicVisualization.COLOR_GLOW, ClassicVisualization.COLOR_HIGHLIGHT, {
      baseGlowBlur: ClassicVisualization.BASE_GLOW_BLUR
    });

    this.applyFadeOverlay();

    // Mark that we've drawn at least once (for resize preservation logic)
    this.hasDrawn = true;
  }

  protected override onFftSizeChanged(): void {
    this.dataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  // Fixed visual parameters: ignore the global controls (values set in constructor).
  public override setSensitivity(): void { /* fixed at 20% */ }
  public override setTrailIntensity(): void { /* fixed at 0 */ }
  public override setLineWidth(): void { /* fixed at 1px */ }
  public override setGlowIntensity(): void { /* fixed at 0 */ }
  public override setWaveformSmoothing(): void { /* fixed at 100% */ }
}

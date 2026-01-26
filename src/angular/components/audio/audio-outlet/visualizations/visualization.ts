/**
 * @fileoverview Base classes for audio visualizations.
 *
 * This module defines the visualization class hierarchy:
 *
 * ```
 * Visualization (abstract)
 * ├── Canvas2DVisualization (abstract) - For 2D canvas rendering
 * │   ├── BarsVisualization
 * │   ├── WaveformVisualization
 * │   ├── TunnelVisualization
 * │   └── NeonVisualization
 * └── WebGLVisualization (abstract) - For WebGL rendering
 *     ├── PulsarVisualization
 *     └── WaterVisualization
 * ```
 *
 * All visualizations share common functionality:
 * - Canvas and analyser node management
 * - Sensitivity control (amplitude scaling independent of volume)
 * - Fade in/out on play/pause transitions
 * - Resize handling
 *
 * @module app/components/audio/audio-outlet/visualizations/visualization
 */

import {
  DEFAULT_SENSITIVITY,
  DEFAULT_TRAIL_INTENSITY,
  DEFAULT_FFT_SIZE,
  DEFAULT_LINE_WIDTH,
  DEFAULT_GLOW_INTENSITY,
  DEFAULT_WAVEFORM_SMOOTHING,
  GLOW_BLUR_RADIUS,
  GLOW_OPACITY_MULTIPLIER,
  GLOW_LINE_WIDTH_OFFSET,
  HIGHLIGHT_LINE_WIDTH,
  RGB_MAX,
  PERCENT_100,
  DEGREES_FULL_CIRCLE,
  DEGREES_SEXTANT,
  DEGREES_TWO_SEXTANTS,
  DEGREES_THREE_SEXTANTS,
  DEGREES_FOUR_SEXTANTS,
  DEGREES_FIVE_SEXTANTS,
  FADE_IN_DURATION_MS,
  HALF,
  MULTIPLIER_DOUBLE,
} from './visualization-constants';

/**
 * Configuration required to create a visualization.
 */
export interface VisualizationConfig {
  /** The canvas element to render to */
  canvas: HTMLCanvasElement;

  /** The Web Audio analyser node providing frequency/waveform data */
  analyser: AnalyserNode;
}

/**
 * Abstract base class for all audio visualizations.
 *
 * Provides common functionality that all visualizations need:
 * - Canvas and analyser node references
 * - Sensitivity control for amplitude scaling
 * - Fade transition handling for pause/stop
 * - Resize handling
 *
 * Subclasses must implement:
 * - name: Display name shown in UI
 * - category: Classification for the visualization
 * - draw(): Render one frame of the visualization
 *
 * @example
 * class MyVisualization extends Visualization {
 *   public readonly name = 'My Visualization';
 *   public readonly category = 'frequency';
 *
 *   public draw(): void {
 *     this.updateFade();
 *     // Render visualization...
 *   }
 * }
 */
export abstract class Visualization {
  /** Display name shown in the UI */
  public abstract readonly name: string;

  /** Category classification for this visualization */
  public abstract readonly category: string;

  /** The canvas element to render to */
  protected canvas: HTMLCanvasElement;

  /** The Web Audio analyser node */
  protected analyser: AnalyserNode;

  /** Current canvas width in pixels */
  protected width: number = 0;

  /** Current canvas height in pixels */
  protected height: number = 0;

  /**
   * Sensitivity controls visualization amplitude (0-1, default 0.25).
   * This is independent of the master volume, allowing visualizations
   * to remain responsive even at low volume.
   */
  protected sensitivity: number = DEFAULT_SENSITIVITY;

  /**
   * Trail intensity controls how long visual trails persist (0-1, default 0.5).
   * 0 = fast fade (minimal trails), 1 = slow fade (long trails).
   * Only affects visualizations with trail effects (Tunnel, Pulsar, Water, Infinity).
   */
  protected trailIntensity: number = DEFAULT_TRAIL_INTENSITY;

  /**
   * Current FFT size for audio analysis.
   * Larger values give more frequency resolution but require more processing.
   * Valid values: 256, 512, 1024, 2048, 4096
   */
  protected fftSize: number = DEFAULT_FFT_SIZE;

  /**
   * Current bar density level for bar-based visualizations.
   * Only affects Analyzer and Spectre visualizations.
   */
  protected barDensity: 'low' | 'medium' | 'high' = 'medium';

  /**
   * Line width for waveform visualizations (1.0 - 5.0, default 2.0).
   * Affects visualizations that draw lines (Waveform, Plasma, Neon, Water, Infinity).
   */
  protected lineWidth: number = 2.0;

  /**
   * Glow intensity for visualizations with glow effects (0.0 - 1.0, default 0.5).
   * 0 = no glow, 1 = full glow intensity.
   */
  protected glowIntensity: number = DEFAULT_GLOW_INTENSITY;

  /**
   * Waveform smoothing controls curve interpolation (0.0 - 1.0, default 0.5).
   * 0 = straight lines (jagged), 1 = maximum smoothing (rounded curves).
   * Affects visualizations that draw waveforms (Waveform, Plasma, Neon, Infinity).
   */
  protected waveformSmoothing: number = DEFAULT_WAVEFORM_SMOOTHING;

  /**
   * Current fade alpha level (0 = fully visible, 1 = fully black).
   * Used for smooth fade transitions when pausing/stopping.
   */
  protected fadeAlpha: number = 1;

  /** Whether audio is currently playing */
  protected isPlaying: boolean = false;

  /** Timestamp of the last frame (for delta time calculation) */
  protected lastFrameTime: number = 0;

  /** Duration of fade-to-black transition in milliseconds */
  protected readonly FADE_DURATION_MS: number = 5000;

  /**
   * Creates a new visualization.
   *
   * @param config - Configuration with canvas and analyser
   */
  protected constructor(config: VisualizationConfig) {
    this.canvas = config.canvas;
    this.analyser = config.analyser;
    this.lastFrameTime = performance.now();
  }

  /**
   * Sets the visualization sensitivity.
   *
   * @param value - Sensitivity level (0 to 1)
   */
  public setSensitivity(value: number): void {
    this.sensitivity = Math.max(0, Math.min(1, value));
  }

  /**
   * Gets the current sensitivity level.
   *
   * @returns Current sensitivity (0 to 1)
   */
  public getSensitivity(): number {
    return this.sensitivity;
  }

  /**
   * Sets the trail intensity.
   *
   * @param value - Trail intensity level (0 to 1)
   */
  public setTrailIntensity(value: number): void {
    this.trailIntensity = Math.max(0, Math.min(1, value));
  }

  /**
   * Gets the current trail intensity level.
   *
   * @returns Current trail intensity (0 to 1)
   */
  public getTrailIntensity(): number {
    return this.trailIntensity;
  }

  /**
   * Calculates the fade rate multiplier based on trail intensity.
   *
   * Converts the user-friendly trail intensity (0=short, 1=long trails)
   * to a fade rate multiplier. Uses exponential scaling for smooth control.
   *
   * - trailIntensity 0: multiplier = 2.0 (fast fade, short trails)
   * - trailIntensity 0.5: multiplier = 1.0 (default)
   * - trailIntensity 1: multiplier = 0.5 (slow fade, long trails)
   *
   * @returns Fade rate multiplier to apply to base fade rates
   */
  protected getFadeMultiplier(): number {
    return Math.pow(MULTIPLIER_DOUBLE, (HALF - this.trailIntensity) * MULTIPLIER_DOUBLE);
  }

  /**
   * Converts HSL color values to RGB.
   *
   * Utility method for visualizations to convert colors.
   *
   * @param h - Hue (0-360 degrees)
   * @param s - Saturation (0-100 percent)
   * @param l - Lightness (0-100 percent)
   * @returns RGB object with r, g, b values (0-255)
   */
  protected hslToRgb(h: number, s: number, l: number): {r: number; g: number; b: number} {
    h = ((h % DEGREES_FULL_CIRCLE) + DEGREES_FULL_CIRCLE) % DEGREES_FULL_CIRCLE;
    const sNorm: number = s / PERCENT_100;
    const lNorm: number = l / PERCENT_100;

    const c: number = (1 - Math.abs(MULTIPLIER_DOUBLE * lNorm - 1)) * sNorm;
    const x: number = c * (1 - Math.abs((h / DEGREES_SEXTANT) % MULTIPLIER_DOUBLE - 1));
    const m: number = lNorm - c / MULTIPLIER_DOUBLE;

    let r: number, g: number, b: number;

    if (h < DEGREES_SEXTANT) { r = c; g = x; b = 0; }
    else if (h < DEGREES_TWO_SEXTANTS) { r = x; g = c; b = 0; }
    else if (h < DEGREES_THREE_SEXTANTS) { r = 0; g = c; b = x; }
    else if (h < DEGREES_FOUR_SEXTANTS) { r = 0; g = x; b = c; }
    else if (h < DEGREES_FIVE_SEXTANTS) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }

    return {
      r: Math.round((r + m) * RGB_MAX),
      g: Math.round((g + m) * RGB_MAX),
      b: Math.round((b + m) * RGB_MAX)
    };
  }

  /**
   * Sets the FFT size for audio analysis.
   *
   * Updates the analyser's FFT size and calls onFftSizeChanged()
   * to allow subclasses to recreate their data arrays.
   *
   * @param size - FFT size (256, 512, 1024, 2048, or 4096)
   */
  public setFftSize(size: number): void {
    const validSizes: readonly number[] = [256, 512, 1024, 2048, 4096];
    if (!validSizes.includes(size)) return;

    this.fftSize = size;
    this.analyser.fftSize = size;
    this.onFftSizeChanged();
  }

  /**
   * Gets the current FFT size.
   *
   * @returns Current FFT size
   */
  public getFftSize(): number {
    return this.fftSize;
  }

  /**
   * Called when FFT size changes. Override in subclass to recreate data arrays.
   *
   * Subclasses that use data arrays sized based on FFT size should override
   * this method to recreate those arrays with the new size.
   */
  protected onFftSizeChanged(): void {
    // Override in subclass to recreate data arrays
  }

  /**
   * Sets the bar density for bar-based visualizations.
   *
   * @param density - Bar density level ('low', 'medium', or 'high')
   */
  public setBarDensity(density: 'low' | 'medium' | 'high'): void {
    const validDensities: readonly string[] = ['low', 'medium', 'high'];
    if (!validDensities.includes(density)) return;

    this.barDensity = density;
    this.onBarDensityChanged();
  }

  /**
   * Gets the current bar density level.
   *
   * @returns Current bar density
   */
  public getBarDensity(): 'low' | 'medium' | 'high' {
    return this.barDensity;
  }

  /**
   * Called when bar density changes. Override in subclass to recalculate bar counts.
   *
   * Subclasses that render bars (Analyzer, Spectre) should override
   * this method to update their bar counts based on the new density.
   */
  protected onBarDensityChanged(): void {
    // Override in subclass to recalculate bar counts
  }

  /**
   * Sets the line width for waveform visualizations.
   *
   * @param width - Line width value (1.0 to 5.0)
   */
  public setLineWidth(width: number): void {
    this.lineWidth = Math.max(1, Math.min(5, width));
  }

  /**
   * Gets the current line width.
   *
   * @returns Current line width (1.0 to 5.0)
   */
  public getLineWidth(): number {
    return this.lineWidth;
  }

  /**
   * Sets the glow intensity for visualizations.
   *
   * @param intensity - Glow intensity value (0.0 to 1.0)
   */
  public setGlowIntensity(intensity: number): void {
    this.glowIntensity = Math.max(0, Math.min(1, intensity));
  }

  /**
   * Gets the current glow intensity.
   *
   * @returns Current glow intensity (0.0 to 1.0)
   */
  public getGlowIntensity(): number {
    return this.glowIntensity;
  }

  /**
   * Sets the waveform smoothing level.
   *
   * @param smoothing - Smoothing value (0.0 to 1.0)
   */
  public setWaveformSmoothing(smoothing: number): void {
    this.waveformSmoothing = Math.max(0, Math.min(1, smoothing));
  }

  /**
   * Gets the current waveform smoothing level.
   *
   * @returns Current waveform smoothing (0.0 to 1.0)
   */
  public getWaveformSmoothing(): number {
    return this.waveformSmoothing;
  }

  /**
   * Calculates the glow blur radius based on intensity and base value.
   *
   * @param baseBlur - The base blur radius (when intensity is 1.0)
   * @returns Scaled blur radius
   */
  protected getScaledGlowBlur(baseBlur: number): number {
    return baseBlur * this.glowIntensity;
  }

  /**
   * Sets the playback state for fade transitions.
   *
   * When playback starts, the visualization fades in.
   * When playback stops, the visualization fades to black.
   *
   * @param playing - Whether audio is playing
   */
  public setPlaying(playing: boolean): void {
    this.isPlaying = playing;
    if (playing) {
      // Reset fade when playback starts
      this.fadeAlpha = 0;
    }
  }

  /**
   * Handles canvas resize.
   *
   * Updates internal dimensions and the canvas element's size,
   * then calls onResize() for subclass-specific handling.
   *
   * @param width - New width in pixels
   * @param height - New height in pixels
   */
  public resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.onResize();
  }

  /**
   * Called after resize. Override in subclass for custom handling.
   */
  protected onResize(): void {
    // Override in subclass if needed
  }

  /**
   * Resizes a canvas while preserving its existing content.
   *
   * When a canvas is resized by setting width/height, its content is cleared.
   * This method captures the existing content, resizes the canvas, then
   * draws the content back scaled to fit the new dimensions.
   *
   * @param canvas - The canvas to resize
   * @param ctx - The 2D rendering context for the canvas
   * @param newWidth - The new width in pixels
   * @param newHeight - The new height in pixels
   * @param preserveContent - Whether to preserve existing content (default: true)
   */
  protected resizeCanvasPreserving(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    newWidth: number,
    newHeight: number,
    preserveContent: boolean = true
  ): void {
    const oldWidth: number = canvas.width;
    const oldHeight: number = canvas.height;

    // If dimensions unchanged, nothing to do
    if (oldWidth === newWidth && oldHeight === newHeight) {
      return;
    }

    // If no content to preserve or canvas was empty, just resize
    if (!preserveContent || oldWidth === 0 || oldHeight === 0) {
      canvas.width = newWidth;
      canvas.height = newHeight;
      return;
    }

    // Capture existing content to a temporary canvas
    const tempCanvas: HTMLCanvasElement = document.createElement('canvas');
    tempCanvas.width = oldWidth;
    tempCanvas.height = oldHeight;
    const tempCtx: CanvasRenderingContext2D = tempCanvas.getContext('2d', {alpha: true})!;
    tempCtx.drawImage(canvas, 0, 0);

    // Resize the canvas (clears content)
    canvas.width = newWidth;
    canvas.height = newHeight;

    // Draw the preserved content scaled to fit new dimensions
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tempCanvas, 0, 0, oldWidth, oldHeight, 0, 0, newWidth, newHeight);
  }

  /**
   * Updates the fade alpha based on playback state.
   *
   * Call this at the start of draw() to update fade transitions.
   * - Playing: Fades in quickly (500ms)
   * - Paused/Stopped: Fades out slowly (5000ms)
   */
  protected updateFade(): void {
    const now: number = performance.now();
    const deltaMs: number = now - this.lastFrameTime;
    this.lastFrameTime = now;

    if (this.isPlaying) {
      // Fade in quickly when playing
      this.fadeAlpha = Math.max(0, this.fadeAlpha - deltaMs / FADE_IN_DURATION_MS);
    } else {
      // Fade out slowly when paused/stopped
      this.fadeAlpha = Math.min(1, this.fadeAlpha + deltaMs / this.FADE_DURATION_MS);
    }
  }

  /**
   * Renders one frame of the visualization.
   *
   * Subclasses must implement this to perform their rendering.
   * Should call updateFade() at the start and apply fade overlay at the end.
   */
  public abstract draw(): void;

  /**
   * Cleans up resources when the visualization is destroyed.
   *
   * Override in subclass to release WebGL contexts, etc.
   */
  public destroy(): void {
    // Override in subclass to clean up resources (WebGL contexts, etc.)
  }
}

/**
 * Base class for visualizations using Canvas 2D rendering.
 *
 * Provides the 2D rendering context and a helper method for
 * applying the fade overlay after rendering.
 *
 * @example
 * class MyVisualization extends Canvas2DVisualization {
 *   public draw(): void {
 *     this.updateFade();
 *     this.ctx.clearRect(0, 0, this.width, this.height);
 *     // Draw visualization using this.ctx...
 *     this.applyFadeOverlay();
 *   }
 * }
 */
export abstract class Canvas2DVisualization extends Visualization {
  /** The 2D rendering context */
  protected ctx: CanvasRenderingContext2D;

  /**
   * Creates a new 2D canvas visualization.
   *
   * @param config - Configuration with canvas and analyser
   * @throws Error if 2D context cannot be obtained
   */
  protected constructor(config: VisualizationConfig) {
    super(config);
    const ctx: CanvasRenderingContext2D | null = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context');
    this.ctx = ctx;
  }

  /**
   * Applies a semi-transparent black overlay for fade effect.
   *
   * Call this at the end of draw() to apply the fade transition.
   * When fadeAlpha is 0, nothing is drawn. When 1, fully black.
   */
  protected applyFadeOverlay(): void {
    if (this.fadeAlpha <= 0) return;

    this.ctx.fillStyle = `rgba(0, 0, 0, ${this.fadeAlpha})`;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  /**
   * Draws a path with three layers: glow, main, and highlight.
   *
   * This helper method reduces duplication across visualizations that draw
   * waveforms with the common three-layer pattern:
   * 1. Glow layer: shadow blur, semi-transparent, thicker line
   * 2. Main layer: solid color, standard line width
   * 3. Highlight layer: lighter color, thin line
   *
   * @param buildPath - Function that builds the path (called 3 times)
   * @param mainColor - Color for the main layer (e.g., "rgb(0, 255, 100)")
   * @param glowColor - Color for the glow layer (e.g., "rgba(0, 255, 100, 0.8)")
   * @param highlightColor - Color for the highlight layer (optional)
   * @param options - Additional drawing options
   */
  protected drawPathWithLayers(
    buildPath: () => void,
    mainColor: string,
    glowColor: string,
    highlightColor?: string,
    options: {
      baseGlowBlur?: number;
      closePath?: boolean;
      fill?: boolean;
      glowLineWidthOffset?: number;
      highlightLineWidth?: number;
    } = {}
  ): void {
    const ctx: CanvasRenderingContext2D = this.ctx;
    const {
      baseGlowBlur = GLOW_BLUR_RADIUS,
      closePath = false,
      fill = false,
      glowLineWidthOffset = GLOW_LINE_WIDTH_OFFSET,
      highlightLineWidth = HIGHLIGHT_LINE_WIDTH
    }: {
      baseGlowBlur?: number;
      closePath?: boolean;
      fill?: boolean;
      glowLineWidthOffset?: number;
      highlightLineWidth?: number;
    } = options;

    // Reduce glow color opacity for the stroke
    const glowStrokeColor: string = glowColor.replace(/[\d.]+\)$/, (match: string): string => {
      const opacity: number = parseFloat(match) * GLOW_OPACITY_MULTIPLIER;
      return opacity.toFixed(MULTIPLIER_DOUBLE) + ')';
    });

    // Glow layer
    ctx.save();
    ctx.shadowBlur = this.getScaledGlowBlur(baseGlowBlur);
    ctx.shadowColor = glowColor;

    if (fill) {
      ctx.fillStyle = glowStrokeColor;
    } else {
      ctx.strokeStyle = glowStrokeColor;
      ctx.lineWidth = this.lineWidth + glowLineWidthOffset;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }

    buildPath();
    if (closePath) ctx.closePath();
    if (fill) ctx.fill(); else ctx.stroke();
    ctx.restore();

    // Main layer
    if (fill) {
      ctx.fillStyle = mainColor;
    } else {
      ctx.strokeStyle = mainColor;
      ctx.lineWidth = this.lineWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }

    buildPath();
    if (closePath) ctx.closePath();
    if (fill) ctx.fill(); else ctx.stroke();

    // Highlight layer (optional)
    if (highlightColor) {
      if (fill) {
        ctx.fillStyle = highlightColor;
      } else {
        ctx.strokeStyle = highlightColor;
        ctx.lineWidth = highlightLineWidth;
      }

      buildPath();
      if (closePath) ctx.closePath();
      if (fill) ctx.fill(); else ctx.stroke();
    }
  }

  /**
   * Draws a path from an array of points with three layers.
   *
   * Convenience wrapper around drawPathWithLayers for pre-calculated point arrays.
   *
   * @param points - Array of {x, y} points defining the path
   * @param mainColor - Color for the main layer
   * @param glowColor - Color for the glow layer
   * @param highlightColor - Color for the highlight layer (optional)
   * @param options - Additional drawing options
   */
  protected drawPointsWithLayers(
    points: ReadonlyArray<{x: number; y: number}>,
    mainColor: string,
    glowColor: string,
    highlightColor?: string,
    options: {
      baseGlowBlur?: number;
      closePath?: boolean;
      fill?: boolean;
      glowLineWidthOffset?: number;
      highlightLineWidth?: number;
      startIndex?: number;
      endIndex?: number;
    } = {}
  ): void {
    const start: number = options.startIndex ?? 0;
    const end: number = options.endIndex ?? points.length;

    if (end - start < 2) return;

    const buildPath: () => void = (): void => {
      this.ctx.beginPath();
      this.ctx.moveTo(points[start].x, points[start].y);
      for (let i: number = start + 1; i < end; i++) {
        this.ctx.lineTo(points[i].x, points[i].y);
      }
    };

    this.drawPathWithLayers(buildPath, mainColor, glowColor, highlightColor, options);
  }

  /**
   * Builds a smooth path through the given points using quadratic bezier curves.
   *
   * The smoothing is controlled by the waveformSmoothing property:
   * - 0 = straight lines between points (no smoothing)
   * - 1 = maximum smoothing using quadratic curves through midpoints
   *
   * @param ctx - The canvas rendering context to draw on
   * @param points - Array of {x, y} points defining the path
   * @param numPoints - Number of points to process (defaults to points.length - 1)
   */
  protected buildSmoothPath(
    ctx: CanvasRenderingContext2D,
    points: ReadonlyArray<{x: number; y: number}>,
    numPoints?: number
  ): void {
    const count: number = numPoints ?? points.length - 1;
    const smoothing: number = this.waveformSmoothing;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    if (smoothing === 0) {
      // Straight lines (no smoothing)
      for (let i: number = 1; i <= count; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
    } else {
      // Smooth curves using quadratic bezier
      for (let i: number = 0; i < count; i++) {
        const current: {x: number; y: number} = points[i];
        const next: {x: number; y: number} = points[i + 1];

        // Calculate midpoint between current and next
        const midX: number = (current.x + next.x) / 2;
        const midY: number = (current.y + next.y) / 2;

        // Control point interpolated between midpoint (no curve) and current point (max curve)
        const cpX: number = midX + (current.x - midX) * smoothing;
        const cpY: number = midY + (current.y - midY) * smoothing;

        ctx.quadraticCurveTo(cpX, cpY, midX, midY);
      }

      // Final segment to the last point
      const lastPoint: {x: number; y: number} = points[count];
      ctx.lineTo(lastPoint.x, lastPoint.y);
    }
  }
}

/**
 * Base class for visualizations using WebGL rendering.
 *
 * Provides the WebGL rendering context and proper cleanup on destroy.
 * WebGL is used for more complex effects like water simulations
 * that benefit from GPU acceleration.
 *
 * @example
 * class MyVisualization extends WebGLVisualization {
 *   public draw(): void {
 *     const gl = this.gl;
 *     gl.clear(gl.COLOR_BUFFER_BIT);
 *     // Draw using WebGL...
 *   }
 * }
 */
export abstract class WebGLVisualization extends Visualization {
  /** The WebGL rendering context */
  protected gl: WebGLRenderingContext;

  /**
   * Creates a new WebGL visualization.
   *
   * @param config - Configuration with canvas and analyser
   * @throws Error if WebGL context cannot be obtained
   */
  protected constructor(config: VisualizationConfig) {
    super(config);
    const gl: WebGLRenderingContext | null = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl') as WebGLRenderingContext | null;
    if (!gl) throw new Error('Failed to get WebGL context');
    this.gl = gl as WebGLRenderingContext;
  }

  /**
   * Cleans up the WebGL context.
   *
   * Uses the WEBGL_lose_context extension to properly release
   * GPU resources.
   */
  public override destroy(): void {
    const ext: WEBGL_lose_context | null = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}

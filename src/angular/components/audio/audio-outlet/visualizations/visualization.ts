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
  protected sensitivity: number = 0.25;

  /**
   * Trail intensity controls how long visual trails persist (0-1, default 0.5).
   * 0 = fast fade (minimal trails), 1 = slow fade (long trails).
   * Only affects visualizations with trail effects (Tunnel, Pulsar, Water, Flux).
   */
  protected trailIntensity: number = 0.5;

  /**
   * Hue shift rotates all visualization colors (0-360 degrees, default 0).
   * Allows users to customize the color scheme of any visualization.
   */
  protected hueShift: number = 0;

  /**
   * Current FFT size for audio analysis.
   * Larger values give more frequency resolution but require more processing.
   * Valid values: 256, 512, 1024, 2048, 4096
   */
  protected fftSize: number = 2048;

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
    return Math.pow(2, (0.5 - this.trailIntensity) * 2);
  }

  /**
   * Sets the hue shift value.
   *
   * @param value - Hue shift in degrees (0 to 360)
   */
  public setHueShift(value: number): void {
    this.hueShift = ((value % 360) + 360) % 360;
  }

  /**
   * Gets the current hue shift value.
   *
   * @returns Current hue shift in degrees (0 to 360)
   */
  public getHueShift(): number {
    return this.hueShift;
  }

  /**
   * Applies the hue shift to a given hue value.
   *
   * @param hue - The original hue value (0-360)
   * @returns The shifted hue value (0-360)
   */
  protected shiftHue(hue: number): number {
    return ((hue + this.hueShift) % 360 + 360) % 360;
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
    h = ((h % 360) + 360) % 360;
    const sNorm: number = s / 100;
    const lNorm: number = l / 100;

    const c: number = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
    const x: number = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m: number = lNorm - c / 2;

    let r: number, g: number, b: number;

    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }

    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255)
    };
  }

  /**
   * Converts RGB color to HSL.
   *
   * Utility method for applying hue shift to RGB colors.
   *
   * @param r - Red (0-255)
   * @param g - Green (0-255)
   * @param b - Blue (0-255)
   * @returns HSL object with h (0-360), s (0-100), l (0-100)
   */
  protected rgbToHsl(r: number, g: number, b: number): {h: number; s: number; l: number} {
    r /= 255;
    g /= 255;
    b /= 255;

    const max: number = Math.max(r, g, b);
    const min: number = Math.min(r, g, b);
    const l: number = (max + min) / 2;

    if (max === min) {
      return {h: 0, s: 0, l: l * 100};
    }

    const d: number = max - min;
    const s: number = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    let h: number;
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6; break;
    }

    return {h: h * 360, s: s * 100, l: l * 100};
  }

  /**
   * Shifts the hue of an RGB color and returns the new RGB values.
   *
   * Converts RGB to HSL, applies hue shift, converts back to RGB.
   *
   * @param r - Red (0-255)
   * @param g - Green (0-255)
   * @param b - Blue (0-255)
   * @returns Shifted RGB object with r, g, b values (0-255)
   */
  protected shiftRgbColor(r: number, g: number, b: number): {r: number; g: number; b: number} {
    if (this.hueShift === 0) return {r, g, b};

    const hsl: {h: number; s: number; l: number} = this.rgbToHsl(r, g, b);
    const shiftedHue: number = this.shiftHue(hsl.h);
    return this.hslToRgb(shiftedHue, hsl.s, hsl.l);
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
      this.fadeAlpha = Math.max(0, this.fadeAlpha - deltaMs / 500);
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

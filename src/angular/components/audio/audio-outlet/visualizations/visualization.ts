/**
 * @fileoverview Base classes for audio visualizations.
 *
 * This module defines the visualization class hierarchy:
 *
 * ```
 * Visualization (abstract)
 * ├── Canvas2DVisualization (abstract) - For 2D canvas rendering
 * │   ├── BarsVisualization
 * │   ├── ClassicVisualization
 * │   ├── TunnelVisualization
 * │   ├── NeonVisualization
 * │   ├── PulsarVisualization
 * │   └── ReactorVisualization
 * └── WebGLVisualization (abstract) - For WebGL rendering
 * ```
 *
 * All visualizations share common functionality:
 * - Canvas and analyser node management
 * - Fade in/out on play/pause transitions
 * - Resize handling
 *
 * @module app/components/audio/audio-outlet/visualizations/visualization
 */

import {
  DEFAULT_FFT_SIZE,
  GLOW_BLUR_RADIUS,
  GLOW_OPACITY_MULTIPLIER,
  GLOW_LINE_WIDTH_OFFSET,
  HIGHLIGHT_LINE_WIDTH,
  WAVEFORM_LINE_WIDTH,
  RGB_MAX,
  PERCENT_100,
  DEGREES_FULL_CIRCLE,
  DEGREES_SEXTANT,
  DEGREES_TWO_SEXTANTS,
  DEGREES_THREE_SEXTANTS,
  DEGREES_FOUR_SEXTANTS,
  DEGREES_FIVE_SEXTANTS,
  FADE_IN_DURATION_MS,
  MULTIPLIER_DOUBLE,
} from './visualization-constants';

/**
 * Return type for createOffscreenCanvas().
 */
export interface OffscreenCanvasPair {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
}

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

  /**
   * When true, this visualization always renders at the display's native
   * resolution, ignoring the global (possibly pixelated) render-resolution
   * setting. Override in subclasses that must stay crisp (e.g. the Logo).
   */
  public readonly rendersAtNativeResolution: boolean = false;

  /** The canvas element to render to */
  protected canvas: HTMLCanvasElement;

  /** The Web Audio analyser node */
  protected analyser: AnalyserNode;

  /** Current canvas width in pixels */
  protected width: number = 0;

  /** Current canvas height in pixels */
  protected height: number = 0;

  /**
   * Current FFT size for audio analysis.
   * Larger values give more frequency resolution but require more processing.
   * Valid values: 256, 512, 1024, 2048, 4096
   */
  protected fftSize: number = DEFAULT_FFT_SIZE;

  /**
   * Current fade alpha level (0 = fully visible, 1 = fully transparent).
   * Used for smooth fade transitions when pausing/stopping.
   */
  protected fadeAlpha: number = 1;

  /** Whether audio is currently playing */
  protected isPlaying: boolean = false;

  /** Timestamp of the last frame (for delta time calculation) */
  protected lastFrameTime: number = 0;

  /** Duration of fade-to-transparent transition in milliseconds */
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
   * Tells the visualization where the current track's embedded artwork can be
   * fetched. Override in visualizations that show it (e.g. Album Art).
   *
   * @param _url - The artwork URL, or null when the track cannot have any
   */
  public setArtworkUrl(_url: string | null): void {
    // Override in visualizations that show the track's artwork
  }

  /**
   * Sets the playback state for fade transitions.
   *
   * When playback starts, the visualization fades in.
   * When playback stops, the visualization fades to transparent.
   *
   * @param playing - Whether audio is playing
   */
  public setPlaying(playing: boolean): void {
    this.isPlaying = playing;
    if (playing) {
      // Reset fade when playback starts
      this.fadeAlpha = 0;
      // Rebase the delta clock: the render loop skips draw() (and so updateFade)
      // while idle, so lastFrameTime may be arbitrarily stale by now.
      this.lastFrameTime = performance.now();
    }
  }

  /**
   * Whether the visualization currently has nothing to render.
   *
   * True once playback has stopped and the fade-out has fully completed, at
   * which point draw() would compose an entirely transparent frame. The render
   * loop uses this to skip drawing altogether rather than burn CPU and GPU
   * producing invisible frames for as long as the view stays open.
   *
   * @returns True when stopped and fully faded out.
   */
  public isIdle(): boolean {
    return !this.isPlaying && this.fadeAlpha >= 1;
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
   * Creates an offscreen canvas at the current visualization dimensions
   * with an alpha-enabled 2D context.
   *
   * Used by trail-based visualizations to create trail and temp canvases.
   *
   * @returns A canvas/context pair sized to the current width/height
   */
  protected createOffscreenCanvas(): OffscreenCanvasPair {
    const canvas: HTMLCanvasElement = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx: CanvasRenderingContext2D = canvas.getContext('2d', {alpha: true})!;
    return {canvas, ctx};
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

  /** Pixels with alpha below this threshold are cleared to fully transparent. */
  protected readonly ALPHA_THRESHOLD: number = 30;

  /**
   * Canvas area, in pixels, that a caller's low-alpha clear interval is tuned for.
   *
   * 1920x1080. At or below this size the caller's interval is used as written;
   * above it the interval stretches proportionally. See getLowAlphaClearInterval.
   */
  private static readonly LOW_ALPHA_CLEAR_PIXEL_BUDGET: number = 2_073_600;

  /**
   * When true, resize() preserves main canvas content (for LCD ghosting/persistence
   * visualizations that draw directly to the main canvas with a fade effect).
   * Set this in the constructor of subclasses that use this behavior.
   */
  protected preserveContentOnResize: boolean = false;

  /** Whether the visualization has drawn at least one frame. Used with preserveContentOnResize. */
  protected hasDrawn: boolean = false;

  /** Frame counter backing periodicClearLowAlpha(). */
  private persistenceFrameCount: number = 0;

  /** Cached color values for dual-hue cycling visualizations. */
  private cachedColor1: {main: string; glow: string} | null = null;
  private cachedColor2: {main: string; glow: string} | null = null;
  private cachedHue1: number = -1;
  private cachedHue2: number = -1;

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
   * Handles canvas resize with optional content preservation.
   *
   * When preserveContentOnResize is true, preserves main canvas content
   * during resize to maintain LCD ghosting/persistence trails. Otherwise
   * delegates to the default resize behavior.
   */
  public override resize(width: number, height: number): void {
    if (!this.preserveContentOnResize) {
      super.resize(width, height);
      return;
    }

    const oldWidth: number = this.canvas.width;
    const oldHeight: number = this.canvas.height;
    const dimensionsChanged: boolean = oldWidth !== width || oldHeight !== height;

    // Same dimensions + already drawn: nothing to do
    if (!dimensionsChanged && this.hasDrawn) {
      return;
    }

    // Same dimensions + not drawn yet: clear canvas (removes previous visualization content)
    if (!dimensionsChanged && !this.hasDrawn) {
      this.width = width;
      this.height = height;
      this.ctx.clearRect(0, 0, width, height);
      return;
    }

    // Dimensions changed: preserve content if we've drawn at least once
    if (this.hasDrawn && oldWidth > 0 && oldHeight > 0) {
      const tempCanvas: HTMLCanvasElement = document.createElement('canvas');
      tempCanvas.width = oldWidth;
      tempCanvas.height = oldHeight;
      const tempCtx: CanvasRenderingContext2D = tempCanvas.getContext('2d', {alpha: true})!;
      tempCtx.drawImage(this.canvas, 0, 0);

      this.width = width;
      this.height = height;
      this.canvas.width = width;
      this.canvas.height = height;

      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';
      this.ctx.drawImage(tempCanvas, 0, 0, oldWidth, oldHeight, 0, 0, width, height);
    } else {
      this.width = width;
      this.height = height;
      this.canvas.width = width;
      this.canvas.height = height;
    }

    this.onResize();
  }

  /**
   * Applies a fade-to-transparent overlay effect.
   *
   * Call this at the end of draw() to apply the fade transition.
   * When fadeAlpha is 0, nothing is drawn. When 1, fully transparent.
   * Uses destination-out composite to fade existing content to transparent.
   */
  protected applyFadeOverlay(): void {
    if (this.fadeAlpha <= 0) return;

    this.ctx.save();
    this.ctx.globalCompositeOperation = 'destination-out';
    this.ctx.fillStyle = `rgba(0, 0, 0, ${this.fadeAlpha})`;
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.ctx.restore();
  }

  /**
   * Clears pixels with alpha below threshold to fully transparent.
   * This prevents ghosting artifacts from the asymptotic fade effect
   * (destination-out compositing never reaches zero alpha).
   *
   * @param ctx - The rendering context to clear low-alpha pixels on (defaults to this.ctx)
   */
  protected clearLowAlphaPixels(ctx: CanvasRenderingContext2D = this.ctx): void {
    const width: number = this.width;
    const height: number = this.height;
    if (width <= 0 || height <= 0) return;

    const imageData: ImageData = ctx.getImageData(0, 0, width, height);
    const data: Uint8ClampedArray = imageData.data;
    const threshold: number = this.ALPHA_THRESHOLD;

    // Alpha is at index 3, 7, 11, ... (every 4th byte starting at 3)
    for (let i: number = 3; i < data.length; i += 4) {
      if (data[i] > 0 && data[i] < threshold) {
        data[i] = 0;
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  /**
   * Applies an LCD-style persistence fade to the main canvas.
   *
   * Fills the canvas with a destination-out black at the given rate, fading
   * existing content toward transparent each frame to create a
   * ghosting/persistence trail.
   *
   * @param fadeRate - Per-frame fade rate.
   */
  protected applyPersistenceFade(fadeRate: number): void {
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'destination-out';
    this.ctx.fillStyle = `rgba(0, 0, 0, ${fadeRate})`;
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.ctx.restore();
  }

  /**
   * Clears low-alpha pixels once every `interval` frames.
   *
   * The persistence fade is asymptotic and never reaches zero alpha, so faint
   * ghost pixels accumulate. Calling this each frame removes them on a cadence
   * without paying the getImageData cost every frame.
   *
   * On canvases larger than the pixel budget the cadence is stretched further
   * still; see getLowAlphaClearInterval.
   *
   * @param interval - Frames between clears at or below the pixel budget.
   */
  protected periodicClearLowAlpha(interval: number): void {
    if (++this.persistenceFrameCount >= this.getLowAlphaClearInterval(interval)) {
      this.persistenceFrameCount = 0;
      this.clearLowAlphaPixels();
    }
  }

  /**
   * Scales the ghost-clearing cadence to the canvas size.
   *
   * clearLowAlphaPixels is by far the most expensive operation in the render
   * loop: it stalls the GPU pipeline for a full-canvas readback, allocates an
   * ImageData the size of the canvas, and scans it in JS. At the caller's
   * fixed cadence that cost is tolerable at 720p and severe at 4K, where the
   * buffer is ~33 MB and the clear runs several times a second.
   *
   * The interval therefore stretches in proportion to the pixel count, keeping
   * the per-second cost roughly constant regardless of display size. Small
   * canvases are unaffected.
   *
   * @param baseInterval - Frames between clears at or below the pixel budget
   * @returns The interval to actually apply
   */
  private getLowAlphaClearInterval(baseInterval: number): number {
    const pixels: number = this.width * this.height;
    if (pixels <= 0) return baseInterval;

    const scale: number = Math.ceil(pixels / Canvas2DVisualization.LOW_ALPHA_CLEAR_PIXEL_BUDGET);
    return baseInterval * Math.max(1, scale);
  }

  /**
   * Size for a working surface that holds a logical area at no more than
   * `budget` pixels.
   *
   * The feedback visualizations redraw their trail buffers from themselves
   * many times a frame, clipped into rings, so their cost is a multiple of the
   * buffer's pixel count. Holding that count to a budget makes the cost stop
   * growing with the display; the buffer is then drawn to the canvas scaled up,
   * and the trails it holds are soft enough that the upscale does not show.
   * Below the budget the surface is the logical size and nothing changes.
   *
   * @param width - Logical width the surface represents
   * @param height - Logical height the surface represents
   * @param budget - Most pixels the surface may hold
   * @returns The surface's backing-store size
   */
  protected getSurfaceSize(width: number, height: number, budget: number): {width: number; height: number} {
    const pixels: number = width * height;
    if (pixels <= budget || pixels <= 0) return {width, height};
    const scale: number = Math.sqrt(budget / pixels);
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  /**
   * Maps a logical area onto the whole of a surface's backing store.
   *
   * Lets drawing code keep working in canvas coordinates whatever size the
   * surface actually is. Resizing a canvas resets its transform, so this has
   * to be applied again after every resize.
   *
   * @param ctx - The surface's context
   * @param logicalWidth - Width the surface represents
   * @param logicalHeight - Height the surface represents
   */
  protected applySurfaceTransform(ctx: CanvasRenderingContext2D, logicalWidth: number, logicalHeight: number): void {
    if (logicalWidth <= 0 || logicalHeight <= 0) return;
    ctx.setTransform(ctx.canvas.width / logicalWidth, 0, 0, ctx.canvas.height / logicalHeight, 0, 0);
  }

  /**
   * Replaces a surface's contents with a same-sized surface, pixel for pixel.
   *
   * Ignores the destination's transform and uses 'copy', so it needs no clear
   * beforehand and never resamples.
   *
   * @param ctx - Destination context
   * @param source - Source canvas, the same size as the destination
   */
  protected copySurface(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement): void {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(source, 0, 0);
    ctx.restore();
  }

  /**
   * Draws a blurred copy of `source` additively over the canvas.
   *
   * The blur runs on a small intermediate rather than at canvas resolution:
   * a Gaussian's cost grows with both the pixels it covers and its radius, so
   * blurring at `scale` of each dimension with the radius scaled to match
   * costs roughly scale cubed of the full-size pass, and a bloom is soft
   * enough that upscaling it back loses nothing visible.
   *
   * @param bloom - Intermediate canvas and context, resized here as needed
   * @param source - What to bloom
   * @param blur - Blur radius in canvas pixels
   * @param strength - Opacity of the additive pass
   * @param scale - Resolution of the intermediate, as a fraction of the canvas
   */
  protected drawBloom(
    bloom: OffscreenCanvasPair,
    source: HTMLCanvasElement,
    blur: number,
    strength: number,
    scale: number
  ): void {
    const width: number = Math.max(1, Math.round(this.width * scale));
    const height: number = Math.max(1, Math.round(this.height * scale));
    if (bloom.canvas.width !== width || bloom.canvas.height !== height) {
      bloom.canvas.width = width;
      bloom.canvas.height = height;
    }

    const bloomCtx: CanvasRenderingContext2D = bloom.ctx;
    bloomCtx.save();
    bloomCtx.globalCompositeOperation = 'copy';
    bloomCtx.filter = `blur(${blur * scale}px)`;
    bloomCtx.drawImage(source, 0, 0, width, height);
    bloomCtx.restore();

    this.ctx.save();
    this.ctx.globalCompositeOperation = 'lighter';
    this.ctx.globalAlpha = strength;
    this.ctx.drawImage(bloom.canvas, 0, 0, this.width, this.height);
    this.ctx.restore();
  }

  /**
   * Applies a directional zoom effect to a trail canvas.
   * Copies the trail to a temp canvas, clears the trail, then draws back
   * with scaling and fade to create a zoom-from-center tunnel effect.
   *
   * @param trailCanvas - The trail canvas to zoom
   * @param trailCtx - The 2D context of the trail canvas
   * @param tempCanvas - A temporary canvas for the copy operation
   * @param tempCtx - The 2D context of the temp canvas
   * @param zoomCenterX - The X coordinate of the zoom center
   * @param zoomCenterY - The Y coordinate of the zoom center
   * @param fadeRate - The per-frame fade rate (e.g., 0.025)
   * @param zoomScale - The per-frame zoom scale (e.g., 1.03)
   */
  protected applyDirectionalZoom(
    trailCanvas: HTMLCanvasElement,
    trailCtx: CanvasRenderingContext2D,
    tempCanvas: HTMLCanvasElement,
    tempCtx: CanvasRenderingContext2D,
    zoomCenterX: number,
    zoomCenterY: number,
    fadeRate: number,
    zoomScale: number,
    rotation: number = 0
  ): void {
    const width: number = this.width;
    const height: number = this.height;

    // Copy current trails to temp canvas
    tempCtx.clearRect(0, 0, width, height);
    tempCtx.drawImage(trailCanvas, 0, 0);

    // Clear trail canvas
    trailCtx.clearRect(0, 0, width, height);

    // Draw back scaled from the specified zoom center with fade
    trailCtx.save();
    trailCtx.imageSmoothingEnabled = true;
    trailCtx.imageSmoothingQuality = 'high';
    trailCtx.globalAlpha = 1 - fadeRate;
    // Use floor to avoid sub-pixel center point which causes quadrant artifacts
    const centerX: number = Math.floor(zoomCenterX);
    const centerY: number = Math.floor(zoomCenterY);
    trailCtx.translate(centerX, centerY);
    trailCtx.scale(zoomScale, zoomScale);
    // Applied per frame rather than as an absolute angle: the trail is redrawn
    // from itself, so a small turn each time accumulates into a slow spiral and
    // the resampling smears it a little further on every pass.
    if (rotation !== 0) trailCtx.rotate(rotation);
    trailCtx.translate(-centerX, -centerY);
    trailCtx.drawImage(tempCanvas, 0, 0);
    trailCtx.restore();
  }

  /**
   * Gets color strings (main and glow) for a given hue.
   *
   * Converts a hue value to fully saturated RGB color strings suitable
   * for use with drawPathWithLayers().
   *
   * @param hue - Hue value (0-360 degrees)
   * @returns Object with main (rgb) and glow (rgba) color strings
   */
  protected getColorFromHue(hue: number): {main: string; glow: string} {
    const rgb: {r: number; g: number; b: number} = this.hslToRgb(hue, PERCENT_100, PERCENT_100 / MULTIPLIER_DOUBLE);
    return {
      main: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
      glow: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.8)`
    };
  }

  /**
   * Gets cached color strings for a given hue, avoiding recalculation every frame.
   *
   * Supports two independent color slots (1 and 2) for dual-hue cycling
   * visualizations. Cache is invalidated when hue changes by more than 1 degree.
   *
   * @param colorIndex - Which cache slot to use (1 or 2)
   * @param hue - Current hue value (0-360 degrees)
   * @returns Object with main (rgb) and glow (rgba) color strings
   */
  protected getCachedColor(colorIndex: 1 | 2, hue: number): {main: string; glow: string} {
    const cachedHue: number = colorIndex === 1 ? this.cachedHue1 : this.cachedHue2;
    const cachedColor: {main: string; glow: string} | null = colorIndex === 1 ? this.cachedColor1 : this.cachedColor2;

    // Check if cache is valid (hue within 1 degree)
    if (cachedColor && Math.abs(hue - cachedHue) < 1) {
      return cachedColor;
    }

    // Calculate new color
    const newColor: {main: string; glow: string} = this.getColorFromHue(hue);

    // Update cache
    if (colorIndex === 1) {
      this.cachedColor1 = newColor;
      this.cachedHue1 = hue;
    } else {
      this.cachedColor2 = newColor;
      this.cachedHue2 = hue;
    }

    return newColor;
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
      ctx?: CanvasRenderingContext2D;
      glowBlur?: number;
      closePath?: boolean;
      fill?: boolean;
      glowLineWidthOffset?: number;
      highlightLineWidth?: number;
    } = {}
  ): void {
    const ctx: CanvasRenderingContext2D = options.ctx ?? this.ctx;
    const {
      glowBlur = GLOW_BLUR_RADIUS,
      closePath = false,
      fill = false,
      glowLineWidthOffset = GLOW_LINE_WIDTH_OFFSET,
      highlightLineWidth = HIGHLIGHT_LINE_WIDTH
    }: {
      glowBlur?: number;
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
    ctx.shadowBlur = glowBlur;
    ctx.shadowColor = glowColor;

    if (fill) {
      ctx.fillStyle = glowStrokeColor;
    } else {
      ctx.strokeStyle = glowStrokeColor;
      ctx.lineWidth = WAVEFORM_LINE_WIDTH + glowLineWidthOffset;
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
      ctx.lineWidth = WAVEFORM_LINE_WIDTH;
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
      ctx?: CanvasRenderingContext2D;
      glowBlur?: number;
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

    const renderCtx: CanvasRenderingContext2D = options.ctx ?? this.ctx;
    const buildPath: () => void = (): void => {
      renderCtx.beginPath();
      renderCtx.moveTo(points[start].x, points[start].y);
      for (let i: number = start + 1; i < end; i++) {
        renderCtx.lineTo(points[i].x, points[i].y);
      }
    };

    this.drawPathWithLayers(buildPath, mainColor, glowColor, highlightColor, options);
  }

  /**
   * Builds a smooth path through the given points using quadratic bezier curves.
   *
   * Each point is the control point of a curve running between the midpoints
   * either side of it, which rounds every corner fully while still passing
   * through the first and last points.
   *
   * @param ctx - The canvas rendering context to draw on
   * @param points - Array of {x, y} points defining the path
   * @param numPoints - Index of the last point to process (defaults to points.length - 1)
   * @param startIndex - Index of the first point to process (defaults to 0), for
   *   building a path over a sub-range of the array
   */
  protected buildSmoothPath(
    ctx: CanvasRenderingContext2D,
    points: ReadonlyArray<{x: number; y: number}>,
    numPoints?: number,
    startIndex: number = 0
  ): void {
    const count: number = numPoints ?? points.length - 1;
    const start: number = startIndex;

    ctx.beginPath();
    ctx.moveTo(points[start].x, points[start].y);

    for (let i: number = start; i < count; i++) {
      const current: {x: number; y: number} = points[i];
      const next: {x: number; y: number} = points[i + 1];

      // Curve to the midpoint between current and next, bending through current
      const midX: number = (current.x + next.x) / 2;
      const midY: number = (current.y + next.y) / 2;

      ctx.quadraticCurveTo(current.x, current.y, midX, midY);
    }

    // Final segment to the last point
    const lastPoint: {x: number; y: number} = points[count];
    ctx.lineTo(lastPoint.x, lastPoint.y);
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

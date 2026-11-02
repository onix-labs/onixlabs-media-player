/**
 * @fileoverview Album Art visualization (Simple / Album Art).
 *
 * Draws the current track's embedded album art centred in the visualization
 * view, over a blurred, saturated, translucent copy of itself that fills the
 * whole view. Tracks without embedded art (or whose art cannot be loaded) show
 * the generic album art placeholder instead. Not audio reactive.
 *
 * @module app/components/audio/audio-outlet/visualizations/album-art-visualization
 */

import {Canvas2DVisualization, OffscreenCanvasPair, VisualizationConfig} from './visualization';

/** Album Art visualization: the track's embedded artwork, centred and scaled to fit. */
export class AlbumArtVisualization extends Canvas2DVisualization {
  /** Max artwork size as a fraction of the shorter canvas side. */
  private static readonly ARTWORK_SIZE_FRACTION: number = 0.7;

  /** Corner radius as a fraction of the artwork's shorter drawn side, so it scales with the view. */
  private static readonly CORNER_RADIUS_FRACTION: number = 0.04;

  /** Shown when the track has no embedded artwork (served from the app root). */
  private static readonly PLACEHOLDER_URL: string = 'album-art.png';

  /**
   * Long side, in pixels, of the surface the background is blurred on.
   *
   * The background is a heavy blur, so it is built small and stretched to fill
   * the view: the upscale is invisible under that much blur, and building it
   * costs next to nothing. It is only rebuilt when the artwork or the view
   * size changes, never per frame.
   */
  private static readonly BACKGROUND_RESOLUTION: number = 192;

  /**
   * Blur radius of the background, in background-surface pixels.
   *
   * At the default resolution this is roughly a sixteenth of the view's long
   * side, so the artwork dissolves into colour fields with no detail left.
   * Raise for a softer wash, lower to keep more of the image's shapes.
   */
  private static readonly BACKGROUND_BLUR: number = 12;

  /**
   * How much the background artwork is enlarged beyond covering the view.
   *
   * Enlarging pushes the image's own edges out of frame, so the blur never
   * pulls in the hard border of the artwork.
   */
  private static readonly BACKGROUND_OVERSCAN: number = 1.15;

  /** Saturation boost applied to the background, for the vivid wash (1 = unchanged). */
  private static readonly BACKGROUND_SATURATION: number = 1.8;

  /** Brightness of the background, so the sharp artwork stands out over it (1 = unchanged). */
  private static readonly BACKGROUND_BRIGHTNESS: number = 0.6;

  /**
   * Opacity of the background (1 = solid).
   *
   * Below 1 the window behind - the glass, or the background colour - shows
   * through the wash.
   */
  private static readonly BACKGROUND_OPACITY: number = 0.35;

  /**
   * Softness of the artwork's drop shadow, as a fraction of the artwork's
   * shorter side, so it keeps its proportions as the view resizes.
   */
  private static readonly SHADOW_BLUR_FRACTION: number = 0.08;

  /**
   * How far the shadow falls below the artwork, as a fraction of its shorter
   * side. A downward offset reads as light from above, which is what makes
   * the artwork look lifted off the backdrop.
   */
  private static readonly SHADOW_OFFSET_FRACTION: number = 0.03;

  /** Darkness of the shadow (0 = none, 1 = solid black at its core). */
  private static readonly SHADOW_OPACITY: number = 0.6;

  public readonly name: string = 'Album Art';
  public readonly category: string = 'Simple';

  /** Always render at the display's native resolution (never the pixelated render-resolution). */
  public override readonly rendersAtNativeResolution: boolean = true;

  /** The image currently drawn: the track's artwork, or the placeholder. */
  private artwork: HTMLImageElement | null = null;

  /** The artwork URL most recently requested, so repeated calls don't reload it. */
  private artworkUrl: string | null | undefined = undefined;

  /** Unfiltered artwork, cover-scaled onto the padded background surface. */
  private backgroundSource: OffscreenCanvasPair | null = null;

  /** The finished background: backgroundSource blurred, saturated and dimmed. */
  private background: OffscreenCanvasPair | null = null;

  /**
   * Padding, in background pixels, around the region of the background that
   * is shown. A blur darkens the edge of whatever it is drawn into, as it
   * averages in the transparency beyond it; building the background with a
   * margin and showing only its middle keeps that darkening out of view.
   */
  private backgroundMargin: number = 0;

  /** Size of the shown region of the background, in background pixels. */
  private backgroundWidth: number = 0;
  private backgroundHeight: number = 0;

  /** The artwork and view size the background was built for, to know when to rebuild. */
  private backgroundFor: HTMLImageElement | null = null;
  private backgroundViewWidth: number = 0;
  private backgroundViewHeight: number = 0;

  /**
   * The artwork's drop shadow, rendered once and composited every frame.
   *
   * A shadow blur this wide is costly to rasterise, and the shadow only
   * changes when the artwork's drawn size does, so it is cached rather than
   * redrawn with the artwork on every frame.
   */
  private shadow: OffscreenCanvasPair | null = null;

  /** Padding around the artwork on the shadow surface, in pixels. */
  private shadowPadding: number = 0;

  /** The drawn artwork size the shadow was built for, to know when to rebuild. */
  private shadowForWidth: number = 0;
  private shadowForHeight: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
  }

  /**
   * Loads the track's artwork, falling back to the placeholder when the track
   * has none (the server answers 404) or it cannot be decoded.
   *
   * @param url - The artwork URL, or null when the track cannot have any
   */
  public override setArtworkUrl(url: string | null): void {
    if (url === this.artworkUrl) return;
    this.artworkUrl = url;

    if (!url) {
      this.loadImage(AlbumArtVisualization.PLACEHOLDER_URL);
      return;
    }

    this.loadImage(url, (): void => this.loadImage(AlbumArtVisualization.PLACEHOLDER_URL));
  }

  public draw(): void {
    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;
    if (width <= 0 || height <= 0) return;

    ctx.clearRect(0, 0, width, height);
    const artwork: HTMLImageElement | null = this.artwork;
    if (!artwork || artwork.naturalWidth === 0) return;

    this.drawBackground(artwork);

    // Fit the artwork (preserving aspect ratio) inside a square box sized to
    // the shorter canvas side, so it never fills the view edge to edge.
    const maxSize: number = Math.min(width, height) * AlbumArtVisualization.ARTWORK_SIZE_FRACTION;
    const scale: number = Math.min(maxSize / artwork.naturalWidth, maxSize / artwork.naturalHeight);
    const drawWidth: number = artwork.naturalWidth * scale;
    const drawHeight: number = artwork.naturalHeight * scale;

    const x: number = (width - drawWidth) / 2;
    const y: number = (height - drawHeight) / 2;
    const radius: number = Math.min(drawWidth, drawHeight) * AlbumArtVisualization.CORNER_RADIUS_FRACTION;

    this.drawShadow(x, y, drawWidth, drawHeight, radius);

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, drawWidth, drawHeight, radius);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(artwork, x, y, drawWidth, drawHeight);
    ctx.restore();
  }

  /**
   * Draws the artwork's drop shadow, rebuilding it first if the artwork's
   * drawn size has changed.
   *
   * @param x - Left of the drawn artwork
   * @param y - Top of the drawn artwork
   * @param width - Width of the drawn artwork
   * @param height - Height of the drawn artwork
   * @param radius - Corner radius of the drawn artwork
   */
  private drawShadow(x: number, y: number, width: number, height: number, radius: number): void {
    const roundedWidth: number = Math.round(width);
    const roundedHeight: number = Math.round(height);
    if (!this.shadow || roundedWidth !== this.shadowForWidth || roundedHeight !== this.shadowForHeight) {
      this.buildShadow(roundedWidth, roundedHeight, radius);
    }
    if (!this.shadow) return;

    this.ctx.drawImage(this.shadow.canvas, x - this.shadowPadding, y - this.shadowPadding);
  }

  /**
   * Renders the drop shadow of a rounded rectangle onto its own surface.
   *
   * Only the shadow is wanted, not the shape casting it, so the shape is drawn
   * off the surface entirely and the shadow offset carries the shadow back
   * into view. The artwork then covers whatever part of the shadow lies
   * directly beneath it.
   *
   * @param width - Width of the artwork
   * @param height - Height of the artwork
   * @param radius - Corner radius of the artwork
   */
  private buildShadow(width: number, height: number, radius: number): void {
    this.shadowForWidth = width;
    this.shadowForHeight = height;

    const shorter: number = Math.min(width, height);
    const blur: number = shorter * AlbumArtVisualization.SHADOW_BLUR_FRACTION;
    const offset: number = shorter * AlbumArtVisualization.SHADOW_OFFSET_FRACTION;
    // Room for the blur to fade out completely, plus the offset.
    const padding: number = Math.ceil(blur * 2 + offset);

    this.shadow ??= this.createOffscreenCanvas();
    const surfaceWidth: number = width + padding * 2;
    this.shadow.canvas.width = surfaceWidth;
    this.shadow.canvas.height = height + padding * 2;

    const shadowCtx: CanvasRenderingContext2D = this.shadow.ctx;
    shadowCtx.shadowColor = `rgba(0, 0, 0, ${AlbumArtVisualization.SHADOW_OPACITY})`;
    shadowCtx.shadowBlur = blur;
    shadowCtx.shadowOffsetX = surfaceWidth;
    shadowCtx.shadowOffsetY = offset;
    shadowCtx.fillStyle = 'black';
    shadowCtx.beginPath();
    shadowCtx.roundRect(padding - surfaceWidth, padding, width, height, radius);
    shadowCtx.fill();

    this.shadowPadding = padding;
  }

  /**
   * Draws the translucent background over the whole view, rebuilding it first
   * if the artwork or the view size has changed.
   *
   * @param artwork - The image the background is built from
   */
  private drawBackground(artwork: HTMLImageElement): void {
    const width: number = this.width;
    const height: number = this.height;
    if (artwork !== this.backgroundFor || width !== this.backgroundViewWidth || height !== this.backgroundViewHeight) {
      this.buildBackground(artwork);
    }
    if (!this.background) return;

    const ctx: CanvasRenderingContext2D = this.ctx;
    ctx.save();
    ctx.globalAlpha = AlbumArtVisualization.BACKGROUND_OPACITY;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      this.background.canvas,
      this.backgroundMargin, this.backgroundMargin, this.backgroundWidth, this.backgroundHeight,
      0, 0, width, height
    );
    ctx.restore();
  }

  /**
   * Builds the blurred background for the given artwork at the current view size.
   *
   * The artwork is scaled to cover the view (plus overscan), drawn onto a
   * small surface with a margin on every side, then drawn again through a
   * blur, saturate and brightness filter. drawBackground() shows the middle of
   * the result stretched over the whole view.
   *
   * @param artwork - The image to build the background from
   */
  private buildBackground(artwork: HTMLImageElement): void {
    const width: number = this.width;
    const height: number = this.height;
    this.backgroundFor = artwork;
    this.backgroundViewWidth = width;
    this.backgroundViewHeight = height;

    // The shown region keeps the view's aspect ratio at the background resolution.
    const resolution: number = AlbumArtVisualization.BACKGROUND_RESOLUTION;
    const viewScale: number = resolution / Math.max(width, height);
    const shownWidth: number = Math.max(1, Math.round(width * viewScale));
    const shownHeight: number = Math.max(1, Math.round(height * viewScale));
    const blur: number = AlbumArtVisualization.BACKGROUND_BLUR;
    const margin: number = Math.ceil(blur * 2);
    const surfaceWidth: number = shownWidth + margin * 2;
    const surfaceHeight: number = shownHeight + margin * 2;

    this.backgroundSource ??= this.createOffscreenCanvas();
    this.background ??= this.createOffscreenCanvas();
    for (const surface of [this.backgroundSource, this.background]) {
      surface.canvas.width = surfaceWidth;
      surface.canvas.height = surfaceHeight;
    }

    // Cover the whole padded surface, centred, enlarged by the overscan.
    const cover: number = Math.max(
      surfaceWidth / artwork.naturalWidth,
      surfaceHeight / artwork.naturalHeight
    ) * AlbumArtVisualization.BACKGROUND_OVERSCAN;
    const coverWidth: number = artwork.naturalWidth * cover;
    const coverHeight: number = artwork.naturalHeight * cover;
    const source: CanvasRenderingContext2D = this.backgroundSource.ctx;
    source.imageSmoothingEnabled = true;
    source.imageSmoothingQuality = 'high';
    source.drawImage(
      artwork,
      (surfaceWidth - coverWidth) / 2, (surfaceHeight - coverHeight) / 2,
      coverWidth, coverHeight
    );

    const target: CanvasRenderingContext2D = this.background.ctx;
    target.filter = `blur(${blur}px) saturate(${AlbumArtVisualization.BACKGROUND_SATURATION}) `
      + `brightness(${AlbumArtVisualization.BACKGROUND_BRIGHTNESS})`;
    target.drawImage(this.backgroundSource.canvas, 0, 0);
    target.filter = 'none';

    this.backgroundMargin = margin;
    this.backgroundWidth = shownWidth;
    this.backgroundHeight = shownHeight;
  }

  /**
   * Loads an image and shows it once decoded. The previous image stays on
   * screen until then, and a load superseded by a newer track is discarded.
   *
   * @param url - The image to load
   * @param onError - Called if the image fails to load
   */
  private loadImage(url: string, onError?: () => void): void {
    const requestedUrl: string | null | undefined = this.artworkUrl;
    const image: HTMLImageElement = new Image();
    image.onload = (): void => {
      if (requestedUrl === this.artworkUrl) this.artwork = image;
    };
    image.onerror = (): void => {
      if (requestedUrl === this.artworkUrl) onError?.();
    };
    image.src = url;
  }
}

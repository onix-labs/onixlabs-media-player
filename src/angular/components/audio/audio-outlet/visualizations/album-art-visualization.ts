/**
 * @fileoverview Album Art visualization (Simple / Album Art).
 *
 * Draws the current track's embedded album art centred in the visualization
 * view. Tracks without embedded art (or whose art cannot be loaded) show the
 * generic album art placeholder instead. Not audio reactive.
 *
 * @module app/components/audio/audio-outlet/visualizations/album-art-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/** Album Art visualization: the track's embedded artwork, centred and scaled to fit. */
export class AlbumArtVisualization extends Canvas2DVisualization {
  /** Max artwork size as a fraction of the shorter canvas side. */
  private static readonly ARTWORK_SIZE_FRACTION: number = 0.7;

  /** Corner radius as a fraction of the artwork's shorter drawn side, so it scales with the view. */
  private static readonly CORNER_RADIUS_FRACTION: number = 0.04;

  /** Shown when the track has no embedded artwork (served from the app root). */
  private static readonly PLACEHOLDER_URL: string = 'album-art.png';

  public readonly name: string = 'Album Art';
  public readonly category: string = 'Simple';

  /** Always render at the display's native resolution (never the pixelated render-resolution). */
  public override readonly rendersAtNativeResolution: boolean = true;

  /** The image currently drawn: the track's artwork, or the placeholder. */
  private artwork: HTMLImageElement | null = null;

  /** The artwork URL most recently requested, so repeated calls don't reload it. */
  private artworkUrl: string | null | undefined = undefined;

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

    // Fit the artwork (preserving aspect ratio) inside a square box sized to
    // the shorter canvas side, so it never fills the view edge to edge.
    const maxSize: number = Math.min(width, height) * AlbumArtVisualization.ARTWORK_SIZE_FRACTION;
    const scale: number = Math.min(maxSize / artwork.naturalWidth, maxSize / artwork.naturalHeight);
    const drawWidth: number = artwork.naturalWidth * scale;
    const drawHeight: number = artwork.naturalHeight * scale;

    const x: number = (width - drawWidth) / 2;
    const y: number = (height - drawHeight) / 2;
    const radius: number = Math.min(drawWidth, drawHeight) * AlbumArtVisualization.CORNER_RADIUS_FRACTION;

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

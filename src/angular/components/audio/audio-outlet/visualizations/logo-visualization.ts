/**
 * @fileoverview Logo visualization (Simple / Logo).
 *
 * Draws the ONIXPlayer logo centred in the visualization view. Not audio
 * reactive - it simply shows the logo (the same image used elsewhere when no
 * media is loaded), scaled to fit and centred.
 *
 * @module app/components/audio/audio-outlet/visualizations/logo-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/** Logo visualization: the ONIXPlayer logo, centred and scaled to fit. */
export class LogoVisualization extends Canvas2DVisualization {
  /** Max logo width as a fraction of the canvas width. */
  private static readonly LOGO_WIDTH_FRACTION: number = 0.7;

  /** Max logo height as a fraction of the canvas height. */
  private static readonly LOGO_HEIGHT_FRACTION: number = 0.5;

  public readonly name: string = 'Logo';
  public readonly category: string = 'Simple';

  /** Always render at the display's native resolution (never the pixelated render-resolution). */
  public override readonly rendersAtNativeResolution: boolean = true;

  /** The logo image (served from the app root, same asset as the UI). */
  private readonly logo: HTMLImageElement;

  /** Whether the logo image has finished loading. */
  private logoLoaded: boolean = false;

  public constructor(config: VisualizationConfig) {
    super(config);
    this.logo = new Image();
    this.logo.onload = (): void => { this.logoLoaded = true; };
    this.logo.src = 'logo.png';
  }

  public draw(): void {
    const ctx: CanvasRenderingContext2D = this.ctx;
    const width: number = this.width;
    const height: number = this.height;
    if (width <= 0 || height <= 0) return;

    ctx.clearRect(0, 0, width, height);
    if (!this.logoLoaded || this.logo.naturalWidth === 0) return;

    // Fit the logo (preserving aspect ratio) inside a box that's a fraction of
    // the canvas - width-led, since the logo is wide, but capped by height.
    const maxWidth: number = width * LogoVisualization.LOGO_WIDTH_FRACTION;
    const maxHeight: number = height * LogoVisualization.LOGO_HEIGHT_FRACTION;
    const aspect: number = this.logo.naturalWidth / this.logo.naturalHeight;
    let drawWidth: number = maxWidth;
    let drawHeight: number = drawWidth / aspect;
    if (drawHeight > maxHeight) {
      drawHeight = maxHeight;
      drawWidth = maxHeight * aspect;
    }

    const x: number = (width - drawWidth) / 2;
    const y: number = (height - drawHeight) / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.logo, x, y, drawWidth, drawHeight);
  }
}

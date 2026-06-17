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
  public readonly name: string = 'Logo';
  public readonly category: string = 'Simple';

  /** Logo size as a fraction of the smaller canvas dimension. */
  private readonly LOGO_SIZE_FRACTION: number = 0.4;

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

    // Fit the logo into a square of the target size, preserving aspect ratio.
    const target: number = Math.min(width, height) * this.LOGO_SIZE_FRACTION;
    const aspect: number = this.logo.naturalWidth / this.logo.naturalHeight;
    let drawWidth: number = target;
    let drawHeight: number = target / aspect;
    if (drawHeight > target) {
      drawHeight = target;
      drawWidth = target * aspect;
    }

    const x: number = (width - drawWidth) / 2;
    const y: number = (height - drawHeight) / 2;
    ctx.drawImage(this.logo, x, y, drawWidth, drawHeight);
  }
}

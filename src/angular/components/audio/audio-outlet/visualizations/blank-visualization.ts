/**
 * @fileoverview Blank visualization (Simple / Blank).
 *
 * A deliberately empty visualization that renders nothing. Useful as a "no
 * visualization" option. The canvas is cleared when this visualization is
 * activated (via the resize that runs on switch), and draw() is a no-op so it
 * stays blank.
 *
 * @module app/components/audio/audio-outlet/visualizations/blank-visualization
 */

import {Canvas2DVisualization, VisualizationConfig} from './visualization';

/** Blank visualization: renders nothing. */
export class BlankVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Blank';
  public readonly category: string = 'Simple';

  public constructor(config: VisualizationConfig) {
    super(config);
  }

  public draw(): void {
    // Intentionally empty: this visualization renders nothing.
  }
}

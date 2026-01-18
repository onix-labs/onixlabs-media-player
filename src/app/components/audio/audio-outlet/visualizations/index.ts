/**
 * @fileoverview Visualization module exports and factory function.
 *
 * This is the main entry point for the visualization system. It exports:
 * - All visualization classes for direct use
 * - The base classes (Visualization, Canvas2DVisualization, WebGLVisualization)
 * - Type definitions (VisualizationType, VisualizationConfig, VisualizationCategory)
 * - Factory function (createVisualization) for type-safe instantiation
 * - VISUALIZATION_TYPES array for cycling through available visualizations
 *
 * Available visualizations:
 * - bars: Classic frequency spectrum bars (green-yellow-red gradient)
 * - waveform: Oscilloscope-style waveform with LCD ghosting effect
 * - tunnel: Hypnotic tunnel/vortex effect
 * - neon: Glowing neon ring visualization
 * - water: Simulated water ripple effect
 * - water2: Alternative water visualization (Pulsar)
 *
 * @module app/components/audio/audio-outlet/visualizations
 */

export {Visualization, Canvas2DVisualization, WebGLVisualization} from './visualization';
export type {VisualizationConfig, VisualizationCategory} from './visualization';
export {BarsVisualization} from './bars-visualization';
export {WaveformVisualization} from './waveform-visualization';
export {TunnelVisualization} from './tunnel-visualization';
export {NeonVisualization} from './neon-visualization';
export {WaterVisualization} from './water-visualization';
export {Water2Visualization} from './water2-visualization';

import {Visualization, VisualizationConfig} from './visualization';
import {BarsVisualization} from './bars-visualization';
import {WaveformVisualization} from './waveform-visualization';
import {TunnelVisualization} from './tunnel-visualization';
import {NeonVisualization} from './neon-visualization';
import {WaterVisualization} from './water-visualization';
import {Water2Visualization} from './water2-visualization';

/**
 * String literal type for available visualization modes.
 * Used to ensure type safety when switching visualizations.
 */
export type VisualizationType = 'bars' | 'waveform' | 'tunnel' | 'neon' | 'water' | 'water2';

/**
 * Map of visualization types to their constructor classes.
 * Used by the factory function to instantiate visualizations.
 */
const VISUALIZATION_CONSTRUCTORS: Record<VisualizationType, new (config: VisualizationConfig) => Visualization> = {
  bars: BarsVisualization,
  waveform: WaveformVisualization,
  tunnel: TunnelVisualization,
  neon: NeonVisualization,
  water: WaterVisualization,
  water2: Water2Visualization,
};

/**
 * Factory function to create a visualization instance.
 *
 * This provides a type-safe way to instantiate visualizations by type
 * string rather than importing specific classes.
 *
 * @param type - The visualization type to create
 * @param config - Configuration with canvas and analyser node
 * @returns A new visualization instance
 * @throws Error if the type is unknown
 *
 * @example
 * const viz = createVisualization('bars', {
 *   canvas: canvasElement,
 *   analyser: audioAnalyserNode
 * });
 * viz.resize(800, 600);
 * viz.draw();
 */
export function createVisualization(type: VisualizationType, config: VisualizationConfig): Visualization {
  const Constructor: new (config: VisualizationConfig) => Visualization = VISUALIZATION_CONSTRUCTORS[type];
  if (!Constructor) {
    throw new Error(`Unknown visualization type: ${type}`);
  }
  return new Constructor(config);
}

/**
 * Array of all available visualization types.
 * Used for cycling through visualizations with next/previous.
 */
export const VISUALIZATION_TYPES: VisualizationType[] = ['bars', 'waveform', 'tunnel', 'neon', 'water', 'water2'];

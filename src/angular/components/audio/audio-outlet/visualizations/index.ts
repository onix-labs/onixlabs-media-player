/**
 * @fileoverview Visualization module exports and factory function.
 *
 * This is the main entry point for the visualization system. It exports:
 * - All visualization classes for direct use
 * - The base classes (Visualization, Canvas2DVisualization, WebGLVisualization)
 * - Type definitions (VisualizationType, VisualizationConfig)
 * - Factory function (createVisualization) for type-safe instantiation
 * - VISUALIZATION_TYPES array for cycling through available visualizations
 *
 * Available visualizations:
 * - bars: Classic frequency spectrum bars (green-yellow-red gradient)
 * - waveform: Oscilloscope-style waveform with LCD ghosting effect
 * - tether: Symmetrical waveform bars with smoke trail effect
 * - tunnel: Hypnotic tunnel/vortex effect
 * - neon: Glowing neon ring visualization
 * - pulsar: Pulsing concentric rings with curved waveforms (space category)
 * - water: Ambient water ripple effect with rotating waveforms (ambience category)
 *
 * @module app/components/audio/audio-outlet/visualizations
 */

export {Visualization, Canvas2DVisualization, WebGLVisualization} from './visualization';
export type {VisualizationConfig} from './visualization';
export {BarsVisualization} from './bars-visualization';
export {WaveformVisualization} from './waveform-visualization';
export {TetherVisualization} from './tether-visualization';
export {TunnelVisualization} from './tunnel-visualization';
export {NeonVisualization} from './neon-visualization';
export {PulsarVisualization} from './pulsar-visualization';
export {WaterVisualization} from './water-visualization';

import {Visualization, VisualizationConfig} from './visualization';
import {BarsVisualization} from './bars-visualization';
import {WaveformVisualization} from './waveform-visualization';
import {TetherVisualization} from './tether-visualization';
import {TunnelVisualization} from './tunnel-visualization';
import {NeonVisualization} from './neon-visualization';
import {PulsarVisualization} from './pulsar-visualization';
import {WaterVisualization} from './water-visualization';

/**
 * String literal type for available visualization modes.
 * Used to ensure type safety when switching visualizations.
 */
export type VisualizationType = 'bars' | 'waveform' | 'tether' | 'tunnel' | 'neon' | 'pulsar' | 'water';

/**
 * Map of visualization types to their constructor classes.
 * Used by the factory function to instantiate visualizations.
 */
const VISUALIZATION_CONSTRUCTORS: Record<VisualizationType, new (config: VisualizationConfig) => Visualization> = {
  bars: BarsVisualization,
  waveform: WaveformVisualization,
  tether: TetherVisualization,
  tunnel: TunnelVisualization,
  neon: NeonVisualization,
  pulsar: PulsarVisualization,
  water: WaterVisualization,
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
export const VISUALIZATION_TYPES: VisualizationType[] = ['bars', 'waveform', 'tether', 'tunnel', 'neon', 'pulsar', 'water'];

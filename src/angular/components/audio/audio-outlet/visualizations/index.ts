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
export {AnalyzerVisualization} from './analyzer-visualization';
export {WaveformVisualization} from './waveform-visualization';
export {SpectreVisualization} from './spectre-visualization';
export {FlareVisualization} from './flare-visualization';
export {NeonVisualization} from './neon-visualization';
export {PulsarVisualization} from './pulsar-visualization';
export {WaterVisualization} from './water-visualization';
export {InfinityVisualization} from './infinity-visualization';
export {OnixVisualization} from './onix-visualization';

import {Visualization, VisualizationConfig} from './visualization';
import {AnalyzerVisualization} from './analyzer-visualization';
import {WaveformVisualization} from './waveform-visualization';
import {SpectreVisualization} from './spectre-visualization';
import {FlareVisualization} from './flare-visualization';
import {NeonVisualization} from './neon-visualization';
import {PulsarVisualization} from './pulsar-visualization';
import {WaterVisualization} from './water-visualization';
import {InfinityVisualization} from './infinity-visualization';
import {OnixVisualization} from './onix-visualization';

/**
 * Map of visualization types to their constructor classes.
 * Used by the factory function to instantiate visualizations.
 */
const VISUALIZATION_CONSTRUCTORS: Record<string, new (config: VisualizationConfig) => Visualization> = {
  bars: AnalyzerVisualization,
  waveform: WaveformVisualization,
  tether: SpectreVisualization,
  tunnel: FlareVisualization,
  neon: NeonVisualization,
  pulsar: PulsarVisualization,
  water: WaterVisualization,
  infinity: InfinityVisualization,
  onix: OnixVisualization,
};

/**
 * Metadata for each visualization type (name and category).
 * Used to display visualization info without creating an instance.
 */
export const VISUALIZATION_METADATA: Record<string, {name: string; category: string}> = {
  bars: {name: 'Analyzer', category: 'Bars'},
  waveform: {name: 'Classic', category: 'Waves'},
  tether: {name: 'Spectre', category: 'Bars'},
  tunnel: {name: 'Flare', category: 'Waves'},
  neon: {name: 'Neon', category: 'Waves'},
  pulsar: {name: 'Pulsar', category: 'Science'},
  water: {name: 'Record', category: 'Science'},
  infinity: {name: 'Infinity', category: 'Waves'},
  onix: {name: 'Onix', category: 'Team'},
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
export function createVisualization(type: string, config: VisualizationConfig): Visualization {
  const Constructor: new (config: VisualizationConfig) => Visualization = VISUALIZATION_CONSTRUCTORS[type];
  if (!Constructor) {
    throw new Error(`Unknown visualization type: ${type}`);
  }
  return new Constructor(config);
}

/**
 * Array of all available visualization types, sorted by category.
 * Used for cycling through visualizations with next/previous.
 *
 * Categories (in order):
 * - Bars: bars, tether
 * - Science: pulsar, water
 * - Team: onix
 * - Waves: flare, infinity, neon, waveform
 */
export const VISUALIZATION_TYPES: string[] = [
  // Bars
  'bars', 'tether',
  // Science
  'pulsar', 'water',
  // Team
  'onix',
  // Waves
  'tunnel', 'infinity', 'neon', 'waveform',
];

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
 * - tunnel: Hypnotic tunnel/vortex effect
 * - neon: Glowing neon ring visualization
 * - pulsar: Pulsing concentric rings with curved waveforms (waves category)
 * - water: Reactor - concentric tower wrapped in frequency rings (signature category)
 * - spotlight: Spotlight - concentric tower wrapped in counter-spinning rings (signature category)
 *
 * @module app/components/audio/audio-outlet/visualizations
 */

export {Visualization, Canvas2DVisualization, WebGLVisualization} from './visualization';
export type {VisualizationConfig} from './visualization';
export {AnalyzerVisualization} from './analyzer-visualization';
export {ClassicVisualization} from './classic-visualization';
export {PlasmaVisualization} from './plasma-visualization';
export {NeonVisualization} from './neon-visualization';
export {PulsarVisualization} from './pulsar-visualization';
export {ReactorVisualization} from './reactor-visualization';
export {InfinityVisualization} from './infinity-visualization';
export {OnixVisualization} from './onix-visualization';
export {ModernVisualization} from './modern-visualization';
export {SpotlightVisualization} from './spotlight-visualization';

import {Visualization, VisualizationConfig} from './visualization';
import {AnalyzerVisualization} from './analyzer-visualization';
import {ClassicVisualization} from './classic-visualization';
import {PlasmaVisualization} from './plasma-visualization';
import {NeonVisualization} from './neon-visualization';
import {PulsarVisualization} from './pulsar-visualization';
import {ReactorVisualization} from './reactor-visualization';
import {InfinityVisualization} from './infinity-visualization';
import {OnixVisualization} from './onix-visualization';
import {ModernVisualization} from './modern-visualization';
import {SpotlightVisualization} from './spotlight-visualization';

/**
 * Map of visualization types to their constructor classes.
 * Used by the factory function to instantiate visualizations.
 */
const VISUALIZATION_CONSTRUCTORS: Record<string, new (config: VisualizationConfig) => Visualization> = {
  bars: AnalyzerVisualization,
  waveform: ClassicVisualization,
  tunnel: PlasmaVisualization,
  neon: NeonVisualization,
  pulsar: PulsarVisualization,
  water: ReactorVisualization,
  infinity: InfinityVisualization,
  onix: OnixVisualization,
  modern: ModernVisualization,
  spotlight: SpotlightVisualization,
};

/**
 * Metadata for each visualization type (name and category).
 * Used to display visualization info without creating an instance.
 */
export const VISUALIZATION_METADATA: Record<string, {name: string; category: string}> = {
  bars: {name: 'Analyzer', category: 'Bars'},
  waveform: {name: 'Classic', category: 'Waves'},
  tunnel: {name: 'Plasma', category: 'Waves'},
  neon: {name: 'Neon', category: 'Waves'},
  pulsar: {name: 'Pulsar', category: 'Waves'},
  water: {name: 'Reactor', category: 'Signature'},
  infinity: {name: 'Infinity', category: 'Waves'},
  onix: {name: 'Onix', category: 'Waves'},
  modern: {name: 'Modern', category: 'Waves'},
  spotlight: {name: 'Spotlight', category: 'Signature'},
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
 * - Bars: bars
 * - Waves: waveform, modern, tunnel, infinity, neon, onix, pulsar
 * - Signature: spotlight, water (Reactor)
 */
export const VISUALIZATION_TYPES: string[] = [
  // Bars
  'bars',
  // Waves
  'waveform', 'modern', 'tunnel', 'infinity', 'neon', 'onix', 'pulsar',
  // Signature
  'spotlight', 'water',
];

/** A single selectable visualization option (type value + display name). */
export interface VisualizationOption {
  /** The visualization type value */
  readonly value: string;
  /** Human-readable display name */
  readonly name: string;
}

/** A group of visualization options sharing a category (e.g. Bars, Waves). */
export interface VisualizationGroup {
  /** The category label */
  readonly category: string;
  /** The options within this category */
  readonly options: readonly VisualizationOption[];
}

/**
 * Visualization options grouped by category, in {@link VISUALIZATION_TYPES}
 * order. Derived from the type list and metadata so new visualizations appear
 * automatically. Used to populate the grouped visualization select dropdown.
 */
export const VISUALIZATION_GROUPS: readonly VisualizationGroup[] = ((): readonly VisualizationGroup[] => {
  const groups: {category: string; options: VisualizationOption[]}[] = [];
  for (const value of VISUALIZATION_TYPES) {
    const metadata: {name: string; category: string} = VISUALIZATION_METADATA[value];
    let group: {category: string; options: VisualizationOption[]} | undefined =
      groups.find((g: {category: string}): boolean => g.category === metadata.category);
    if (!group) {
      group = {category: metadata.category, options: []};
      groups.push(group);
    }
    group.options.push({value, name: metadata.name});
  }
  return groups;
})();

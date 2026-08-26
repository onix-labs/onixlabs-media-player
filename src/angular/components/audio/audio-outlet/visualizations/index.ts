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
 * - hallucia: Hallucia - spectral differential rotation field winding bands into spirals (signature category)
 * - battery-*: Battery - one visualization per source generator in the Battery bank
 * - ambience-*: Ambience - one visualization per displacement in the Windows Media Player Ambience bank
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
export {HalluciaVisualization} from './hallucia-visualization';
export {BlankVisualization} from './blank-visualization';
export {LogoVisualization} from './logo-visualization';
export {ParticlesVisualization} from './particles-visualization';
export {
  BatteryWaveEdgeVisualization,
} from './battery-visualization';
export {
  AmbienceZoomVisualization,
  AmbienceStretchVisualization,
  AmbienceTrigStretchVisualization,
} from './ambience-visualization';

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
import {HalluciaVisualization} from './hallucia-visualization';
import {BlankVisualization} from './blank-visualization';
import {LogoVisualization} from './logo-visualization';
import {ParticlesVisualization} from './particles-visualization';
import {
  BatteryWaveEdgeVisualization,
} from './battery-visualization';
import {
  AmbienceZoomVisualization,
  AmbienceStretchVisualization,
  AmbienceTrigStretchVisualization,
} from './ambience-visualization';

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
  hallucia: HalluciaVisualization,
  particles: ParticlesVisualization,
  'battery-waveedge': BatteryWaveEdgeVisualization,
  'ambience-zoom': AmbienceZoomVisualization,
  'ambience-stretch': AmbienceStretchVisualization,
  'ambience-trigstretch': AmbienceTrigStretchVisualization,
  blank: BlankVisualization,
  logo: LogoVisualization,
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
  hallucia: {name: 'Hallucia', category: 'Signature'},
  particles: {name: 'Particles', category: 'Waves'},
  'battery-waveedge': {name: 'Wave Edge', category: 'Battery'},
  'ambience-zoom': {name: 'Zoom', category: 'Ambience'},
  'ambience-stretch': {name: 'Stretch', category: 'Ambience'},
  'ambience-trigstretch': {name: 'Trig Stretch', category: 'Ambience'},
  blank: {name: 'Blank', category: 'Simple'},
  logo: {name: 'Logo', category: 'Simple'},
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
 * - Waves: waveform, modern, tunnel, infinity, neon, onix, particles, pulsar
 * - Signature: spotlight, water (Reactor), hallucia
 * - Ambience: one entry per displacement in the Ambience bank
 * - Battery: one entry per source generator, each rolling its displacement
 * - Simple: blank, logo
 */
export const VISUALIZATION_TYPES: string[] = [
  // Bars
  'bars',
  // Waves
  'waveform', 'modern', 'tunnel', 'infinity', 'neon', 'onix', 'particles', 'pulsar',
  // Signature
  'spotlight', 'water', 'hallucia',
    // Ambience
  'ambience-zoom', 'ambience-stretch', 'ambience-trigstretch',
  // Battery
  'battery-waveedge',
  // Simple
  'blank', 'logo',
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

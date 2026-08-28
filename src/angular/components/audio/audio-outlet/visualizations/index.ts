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
 * - pulsar: Pulsing concentric rings with curved waveforms (nostalgia category)
 * - water: Reactor - concentric tower wrapped in frequency rings (signature category)
 * - spotlight: Spotlight - concentric tower wrapped in counter-spinning rings (signature category)
 * - hallucia: Hallucia - spectral differential rotation field winding bands into spirals (signature category)
 * - battery-*: Battery - one visualization per preset in the Windows Media Player Battery bank
 * - ambience-vortex .. ambience-whirl: Ambience - one per drawing preset in the
 *   Windows Media Player Ambience bank
 * - ambience-zoom, ambience-stretch: Twirl and Warp, the two feedback warps kept
 *   from the earlier pass over wmp.dll; unrelated to the Ambience bank above.
 *   Filed under Nostalgia with ambience-ripple, which the bank contributes
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
export {HawkingVisualization} from './hawking-visualization';
export {
  AmbienceTwirlVisualization,
  AmbienceWarpVisualization,
} from './ambience-visualization';
export {FeedbackVisualization} from './wmp-feedback-engine';
export {BATTERY_TYPES, BATTERY_METADATA} from './battery-visualization';
export {AMBIENCE_BANK_TYPES, AMBIENCE_BANK_METADATA} from './ambience-bank-visualization';

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
import {HawkingVisualization} from './hawking-visualization';
import {
  AmbienceTwirlVisualization,
  AmbienceWarpVisualization,
} from './ambience-visualization';
import {BATTERY_CONSTRUCTORS, BATTERY_METADATA, BATTERY_TYPES} from './battery-visualization';
import {
  AMBIENCE_BANK_CONSTRUCTORS,
  AMBIENCE_BANK_METADATA,
  AMBIENCE_BANK_TYPES,
} from './ambience-bank-visualization';

/**
 * Map of visualization types to their constructor classes.
 * Used by the factory function to instantiate visualizations.
 *
 * The two WMP banks contribute one entry per preset and are spread in rather
 * than listed, so their tables stay the single source of truth.
 */
const VISUALIZATION_CONSTRUCTORS: Record<string, new (config: VisualizationConfig) => Visualization> = {
  ...AMBIENCE_BANK_CONSTRUCTORS,
  ...BATTERY_CONSTRUCTORS,
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
  hawking: HawkingVisualization,
  'ambience-zoom': AmbienceTwirlVisualization,
  'ambience-stretch': AmbienceWarpVisualization,
  blank: BlankVisualization,
  logo: LogoVisualization,
};

/**
 * Metadata for each visualization type (name and category).
 * Used to display visualization info without creating an instance.
 */
export const VISUALIZATION_METADATA: Record<string, {name: string; category: string}> = {
  ...Object.fromEntries(
    [...AMBIENCE_BANK_METADATA, ...BATTERY_METADATA].map(
      (entry: {id: string; name: string; category: string}): [string, {name: string; category: string}] =>
        [entry.id, {name: entry.name, category: entry.category}]
    )
  ),
  bars: {name: 'Analyzer', category: 'Bars & Waves'},
  waveform: {name: 'Classic', category: 'Bars & Waves'},
  tunnel: {name: 'Plasma', category: 'Bars & Waves'},
  neon: {name: 'Neon', category: 'Bars & Waves'},
  pulsar: {name: 'Pulsar', category: 'Nostalgia'},
  water: {name: 'Reactor', category: 'Signature'},
  infinity: {name: 'Infinity', category: 'Bars & Waves'},
  onix: {name: 'Onix', category: 'Bars & Waves'},
  modern: {name: 'Modern', category: 'Bars & Waves'},
  spotlight: {name: 'Spotlight', category: 'Signature'},
  hallucia: {name: 'Hallucia', category: 'Signature'},
  hawking: {name: 'Hawking', category: 'Bars & Waves'},
  'ambience-zoom': {name: 'Twirl', category: 'Nostalgia'},
  'ambience-stretch': {name: 'Warp', category: 'Nostalgia'},
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
 * The entries filed under Nostalgia, in the order they are listed.
 *
 * Three of them - Twirl, Warp and Pulsar - are their own classes; Ripple is a
 * preset of the Ambience bank and so arrives inside {@link AMBIENCE_BANK_TYPES}.
 * Naming them all here keeps the group in one place and lets the Ambience
 * spread below skip the one that has moved out of it.
 */
const NOSTALGIA_TYPES: readonly string[] =
  ['ambience-zoom', 'ambience-stretch', 'ambience-ripple', 'pulsar'];

/**
 * Array of all available visualization types, sorted by category.
 * Used for cycling through visualizations with next/previous.
 *
 * Categories (in order):
 * - Bars & Waves: bars, waveform, modern, tunnel, infinity, neon, hawking, onix
 * - Signature: water (Reactor), spotlight, hallucia
 * - Nostalgia: twirl, warp, ripple, pulsar
 * - Ambience: the remaining twelve drawing presets of the WMP Ambience bank
 * - Battery: the twenty-five presets of the WMP Battery bank
 * - Simple: blank, logo
 */
export const VISUALIZATION_TYPES: string[] = [
  // Bars & Waves
  'bars', 'waveform', 'modern', 'tunnel', 'infinity', 'neon', 'hawking', 'onix',
  // Signature
  'water', 'spotlight', 'hallucia',
  // Nostalgia
  ...NOSTALGIA_TYPES,
  // Ambience, less the preset that now sits in Nostalgia
  ...AMBIENCE_BANK_TYPES.filter((type: string): boolean => !NOSTALGIA_TYPES.includes(type)),
  // Battery
  ...BATTERY_TYPES,
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

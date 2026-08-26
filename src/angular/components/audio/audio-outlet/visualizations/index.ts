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
 * - blackhole: Black Hole - filled glowing accretion-disk waveform around a black core (waves category)
 * - alchemy-*: Alchemy - one visualization per preset in the Windows Media Player Alchemy bank
 * - battery-randomization: Battery - random displacement and generator on every roll
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
export {BlackHoleVisualization} from './black-hole-visualization';
export {BlankVisualization} from './blank-visualization';
export {LogoVisualization} from './logo-visualization';
export {ParticlesVisualization} from './particles-visualization';
export {
  AlchemyStandardRenderCycleVisualization,
  AlchemyLinearShiftVisualization,
  AlchemyStretchShiftVisualization,
  AlchemySuperStarVisualization,
  AlchemyWonderWaveVisualization,
  AlchemyShiftOScopeVisualization,
  AlchemyFunktionalVisualization,
  AlchemyBlurVisualization,
  AlchemySwitchBlurVisualization,
  AlchemyShiftVisualization,
  AlchemyBassBounceVisualization,
} from './alchemy-visualization';
export {BatteryRandomizationVisualization} from './battery-visualization';
export {
  AmbienceSwirlVisualization,
  AmbienceZoomVisualization,
  AmbienceStarburstVisualization,
  AmbienceRingSpinVisualization,
  AmbienceStretchVisualization,
  AmbienceTrigVisualization,
  AmbienceTrigStretchVisualization,
  AmbienceShimmerVisualization,
  AmbienceEdgeFalloffVisualization,
  AmbienceThingusVisualization,
  AmbienceTileVisualization,
  AmbienceLinearVisualization,
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
import {BlackHoleVisualization} from './black-hole-visualization';
import {BlankVisualization} from './blank-visualization';
import {LogoVisualization} from './logo-visualization';
import {ParticlesVisualization} from './particles-visualization';
import {
  AlchemyStandardRenderCycleVisualization,
  AlchemyLinearShiftVisualization,
  AlchemyStretchShiftVisualization,
  AlchemySuperStarVisualization,
  AlchemyWonderWaveVisualization,
  AlchemyShiftOScopeVisualization,
  AlchemyFunktionalVisualization,
  AlchemyBlurVisualization,
  AlchemySwitchBlurVisualization,
  AlchemyShiftVisualization,
  AlchemyBassBounceVisualization,
} from './alchemy-visualization';
import {BatteryRandomizationVisualization} from './battery-visualization';
import {
  AmbienceSwirlVisualization,
  AmbienceZoomVisualization,
  AmbienceStarburstVisualization,
  AmbienceRingSpinVisualization,
  AmbienceStretchVisualization,
  AmbienceTrigVisualization,
  AmbienceTrigStretchVisualization,
  AmbienceShimmerVisualization,
  AmbienceEdgeFalloffVisualization,
  AmbienceThingusVisualization,
  AmbienceTileVisualization,
  AmbienceLinearVisualization,
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
  blackhole: BlackHoleVisualization,
  particles: ParticlesVisualization,
  'alchemy-standard': AlchemyStandardRenderCycleVisualization,
  'alchemy-linearshift': AlchemyLinearShiftVisualization,
  'alchemy-stretchshift': AlchemyStretchShiftVisualization,
  'alchemy-superstar': AlchemySuperStarVisualization,
  'alchemy-wonderwave': AlchemyWonderWaveVisualization,
  'alchemy-shiftoscope': AlchemyShiftOScopeVisualization,
  'alchemy-funktional': AlchemyFunktionalVisualization,
  'alchemy-blur': AlchemyBlurVisualization,
  'alchemy-switchblur': AlchemySwitchBlurVisualization,
  'alchemy-shift': AlchemyShiftVisualization,
  'alchemy-bassbounce': AlchemyBassBounceVisualization,
  'battery-randomization': BatteryRandomizationVisualization,
  'ambience-swirl': AmbienceSwirlVisualization,
  'ambience-zoom': AmbienceZoomVisualization,
  'ambience-starburst': AmbienceStarburstVisualization,
  'ambience-ringspin': AmbienceRingSpinVisualization,
  'ambience-stretch': AmbienceStretchVisualization,
  'ambience-trig': AmbienceTrigVisualization,
  'ambience-trigstretch': AmbienceTrigStretchVisualization,
  'ambience-shimmer': AmbienceShimmerVisualization,
  'ambience-edgefalloff': AmbienceEdgeFalloffVisualization,
  'ambience-thingus': AmbienceThingusVisualization,
  'ambience-tile': AmbienceTileVisualization,
  'ambience-linear': AmbienceLinearVisualization,
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
  blackhole: {name: 'Black Hole', category: 'Waves'},
  particles: {name: 'Particles', category: 'Waves'},
  'alchemy-standard': {name: "Standard Render Cycle", category: 'Alchemy'},
  'alchemy-linearshift': {name: "Linear Shift", category: 'Alchemy'},
  'alchemy-stretchshift': {name: "Stretch Shift", category: 'Alchemy'},
  'alchemy-superstar': {name: "SuperStar", category: 'Alchemy'},
  'alchemy-wonderwave': {name: "WonderWave", category: 'Alchemy'},
  'alchemy-shiftoscope': {name: "Shift O' Scope", category: 'Alchemy'},
  'alchemy-funktional': {name: "Funktional", category: 'Alchemy'},
  'alchemy-blur': {name: "Blur", category: 'Alchemy'},
  'alchemy-switchblur': {name: "SwitchBlur", category: 'Alchemy'},
  'alchemy-shift': {name: "Shift", category: 'Alchemy'},
  'alchemy-bassbounce': {name: "Bass Bounce", category: 'Alchemy'},
  'battery-randomization': {name: 'Randomization', category: 'Battery'},
  'ambience-swirl': {name: 'Swirl', category: 'Ambience'},
  'ambience-zoom': {name: 'Zoom', category: 'Ambience'},
  'ambience-starburst': {name: 'Starburst', category: 'Ambience'},
  'ambience-ringspin': {name: 'Ring Spin', category: 'Ambience'},
  'ambience-stretch': {name: 'Stretch', category: 'Ambience'},
  'ambience-trig': {name: 'Trig', category: 'Ambience'},
  'ambience-trigstretch': {name: 'Trig Stretch', category: 'Ambience'},
  'ambience-shimmer': {name: 'Shimmer', category: 'Ambience'},
  'ambience-edgefalloff': {name: 'Edge Falloff', category: 'Ambience'},
  'ambience-thingus': {name: 'Thingus', category: 'Ambience'},
  'ambience-tile': {name: 'Tile', category: 'Ambience'},
  'ambience-linear': {name: 'Linear', category: 'Ambience'},
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
 * - Waves: waveform, modern, tunnel, infinity, neon, onix, pulsar, blackhole
 * - Signature: spotlight, water (Reactor)
 * - Alchemy: one entry per preset in the Alchemy bank
 * - Ambience: one entry per displacement in the Ambience bank
 * - Battery: a single randomised entry
 * - Simple: blank, logo
 */
export const VISUALIZATION_TYPES: string[] = [
  // Bars
  'bars',
  // Waves
  'waveform', 'modern', 'tunnel', 'infinity', 'neon', 'onix', 'particles', 'pulsar', 'blackhole',
  // Signature
  'spotlight', 'water',
  // Alchemy
  'alchemy-standard', 'alchemy-linearshift', 'alchemy-stretchshift', 'alchemy-superstar', 'alchemy-wonderwave', 'alchemy-shiftoscope', 'alchemy-funktional', 'alchemy-blur', 'alchemy-switchblur', 'alchemy-shift', 'alchemy-bassbounce',
  // Ambience
  'ambience-swirl', 'ambience-zoom', 'ambience-starburst', 'ambience-ringspin', 'ambience-stretch', 'ambience-trig', 'ambience-trigstretch', 'ambience-shimmer', 'ambience-edgefalloff', 'ambience-thingus', 'ambience-tile', 'ambience-linear',
  // Battery
  'battery-randomization',
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

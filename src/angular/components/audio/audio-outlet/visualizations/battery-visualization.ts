/**
 * @fileoverview The Windows Media Player "Battery" visualization bank.
 *
 * Twenty-five visualizations, one per preset WMP shipped in `wmp.dll`. Each is
 * a fixed warp, a fixed set of generators and a fixed palette, all taken from
 * the DLL's own registrar data - see `battery-presets.ts` for the table and
 * `wmp-feedback-engine.ts` for the machine that runs it.
 *
 * WMP treated these as presets of a single "Battery" effect that could shuffle
 * between them and re-roll palettes and movement on a timer. None of that is
 * here: every preset is its own entry in the visualization list and behaves the
 * same way every time it is selected.
 *
 * @module app/components/audio/audio-outlet/visualizations/battery-visualization
 */

import {Visualization, VisualizationConfig} from './visualization';
import {BATTERY_PRESETS, BatteryPreset} from './battery-presets';
import {
  FeedbackSpec,
  GeneratorStage,
  feedbackVisualization,
  parseArgs,
  parseGeneratorStage,
  parsePalette,
} from './wmp-feedback-engine';

/** The category all Battery presets are filed under. */
const BATTERY_CATEGORY: string = 'Battery';

/**
 * Battery holds its palette still.
 *
 * The engine offered a palette cycle on a hotkey rather than running one by
 * default, and these palettes are Microsoft's own - rotating them would take
 * them somewhere they were never meant to sit.
 */
const BATTERY_PULSES: boolean = false;

/**
 * Turns one row of the preset table into a spec the engine can run.
 *
 * @param preset - A row of {@link BATTERY_PRESETS}
 * @returns The engine spec for that preset
 */
function toSpec(preset: BatteryPreset): FeedbackSpec {
  return {
    name: preset.name,
    category: BATTERY_CATEGORY,
    warp: preset.shift,
    warpArgs: parseArgs(preset.shiftArgs),
    pre: preset.pre.map((entry: string): GeneratorStage => parseGeneratorStage(entry)),
    post: preset.post.map((entry: string): GeneratorStage => parseGeneratorStage(entry)),
    palette: parsePalette(preset.palette),
    pulses: BATTERY_PULSES,
  };
}

/** Type id to constructor, for the visualization factory. */
export const BATTERY_CONSTRUCTORS: Readonly<
  Record<string, new (config: VisualizationConfig) => Visualization>
> = Object.fromEntries(
  BATTERY_PRESETS.map(
    (preset: BatteryPreset): [string, new (config: VisualizationConfig) => Visualization] =>
      [preset.id, feedbackVisualization(toSpec(preset))]
  )
);

/** Type ids in the order the DLL declares them. */
export const BATTERY_TYPES: readonly string[] =
  BATTERY_PRESETS.map((preset: BatteryPreset): string => preset.id);

/** Display metadata for the menus and the settings list. */
export const BATTERY_METADATA: readonly {
  readonly id: string;
  readonly name: string;
  readonly category: string;
}[] = BATTERY_PRESETS.map(
  (preset: BatteryPreset): {id: string; name: string; category: string} =>
    ({id: preset.id, name: preset.name, category: BATTERY_CATEGORY})
);

/**
 * One-line descriptions for the settings dropdown.
 *
 * Each names the warp the preset runs and what draws into it, which is the
 * only thing that distinguishes one entry from another.
 */
export const BATTERY_DESCRIPTIONS: Readonly<Record<string, string>> = Object.fromEntries(
  BATTERY_PRESETS.map((preset: BatteryPreset): [string, string] => {
    const sources: string[] = [...preset.pre, ...preset.post].map(
      (entry: string): string => entry.split(/\s+/)[0]
    );
    const drawn: string = sources.length > 0 ? sources.join(' and ') : 'nothing but its own trail';
    return [preset.id, `${preset.shift.replace(/Shift$/, '')} warp fed by ${drawn}`];
  })
);

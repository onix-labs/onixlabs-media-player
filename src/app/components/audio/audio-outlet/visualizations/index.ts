export {Visualization, Canvas2DVisualization, WebGLVisualization} from './visualization';
export type {VisualizationConfig, VisualizationCategory} from './visualization';
export {BarsVisualization} from './bars-visualization';
export {WaveformVisualization} from './waveform-visualization';
export {TunnelVisualization} from './tunnel-visualization';
export {WaterVisualization} from './water-visualization';
export {Water2Visualization} from './water2-visualization';

import {Visualization, VisualizationConfig} from './visualization';
import {BarsVisualization} from './bars-visualization';
import {WaveformVisualization} from './waveform-visualization';
import {TunnelVisualization} from './tunnel-visualization';
import {WaterVisualization} from './water-visualization';
import {Water2Visualization} from './water2-visualization';

export type VisualizationType = 'bars' | 'waveform' | 'tunnel' | 'water' | 'water2';

// Visualization constructors indexed by type
const VISUALIZATION_CONSTRUCTORS: Record<VisualizationType, new (config: VisualizationConfig) => Visualization> = {
  bars: BarsVisualization,
  waveform: WaveformVisualization,
  tunnel: TunnelVisualization,
  water: WaterVisualization,
  water2: Water2Visualization,
};

export function createVisualization(type: VisualizationType, config: VisualizationConfig): Visualization {
  const Constructor: new (config: VisualizationConfig) => Visualization = VISUALIZATION_CONSTRUCTORS[type];
  if (!Constructor) {
    throw new Error(`Unknown visualization type: ${type}`);
  }
  return new Constructor(config);
}

export const VISUALIZATION_TYPES: VisualizationType[] = ['bars', 'waveform', 'tunnel', 'water', 'water2'];

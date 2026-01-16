export {Visualization, Canvas2DVisualization, WebGLVisualization} from './visualization';
export type {VisualizationConfig} from './visualization';
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

export function createVisualization(type: VisualizationType, config: VisualizationConfig): Visualization {
  switch (type) {
    case 'bars':
      return new BarsVisualization(config);
    case 'waveform':
      return new WaveformVisualization(config);
    case 'tunnel':
      return new TunnelVisualization(config);
    case 'water':
      return new WaterVisualization(config);
    case 'water2':
      return new Water2Visualization(config);
    default:
      throw new Error(`Unknown visualization type: ${type}`);
  }
}

export const VISUALIZATION_TYPES: VisualizationType[] = ['bars', 'waveform', 'tunnel', 'water', 'water2'];

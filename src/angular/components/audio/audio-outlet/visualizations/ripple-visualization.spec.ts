/**
 * @fileoverview Unit tests for the Ripple visualization.
 *
 * Ripple is a preset for the feedback engine, so the rendering itself is the
 * engine's to test. These tests cover what this module adds: the type id that
 * saved settings refer to, the display metadata, and that the exported class
 * is a working feedback visualization carrying that metadata.
 *
 * WebGL and Web Audio are faked; see visualization-test-fakes.group3.
 *
 * @module app/components/audio/audio-outlet/visualizations/ripple-visualization.spec
 */

import {FeedbackVisualization} from './feedback-engine';
import {RIPPLE_DESCRIPTION, RIPPLE_METADATA, RIPPLE_TYPE, RippleVisualization} from './ripple-visualization';
import {Visualization} from './visualization';
import {CanvasFakes, FakeAnalyser, createFakeAnalyser, installCanvasFakes} from './visualization-test-fakes.group3';

describe('RippleVisualization', (): void => {
  let fakes: CanvasFakes;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;

  beforeEach((): void => {
    fakes = installCanvasFakes();
    analyser = createFakeAnalyser();
    canvas = document.createElement('canvas');
  });

  afterEach((): void => {
    fakes.restore();
  });

  describe('metadata', (): void => {
    it('keeps the type id that saved settings refer to', (): void => {
      expect(RIPPLE_TYPE).toBe('ambience-ripple');
    });

    it('is listed as Ripple in the Nostalgia category under its type id', (): void => {
      expect(RIPPLE_METADATA).toEqual({id: RIPPLE_TYPE, name: 'Ripple', category: 'Nostalgia'});
    });

    it('describes itself for the settings dropdown', (): void => {
      expect(RIPPLE_DESCRIPTION).toBe('Radius folded into bands, standing as concentric rings');
    });
  });

  describe('instance', (): void => {
    it('is a feedback visualization', (): void => {
      const viz: Visualization = new RippleVisualization({canvas, analyser: analyser.node});

      expect(viz).toBeInstanceOf(FeedbackVisualization);
    });

    it('carries the same name and category as its metadata', (): void => {
      const viz: Visualization = new RippleVisualization({canvas, analyser: analyser.node});

      expect(viz.name).toBe(RIPPLE_METADATA.name);
      expect(viz.category).toBe(RIPPLE_METADATA.category);
    });

    it('renders through WebGL on the canvas it was given', (): void => {
      new RippleVisualization({canvas, analyser: analyser.node});

      expect(fakes.webglRecordings).toHaveLength(1);
      expect(fakes.webglRecordings[0].canvas).toBe(canvas);
      expect(fakes.recordings).toHaveLength(0);
    });

    it('refuses a canvas that cannot supply a WebGL context', (): void => {
      fakes.restore();
      fakes = installCanvasFakes({webgl: false});

      expect((): Visualization => new RippleVisualization({canvas, analyser: analyser.node})).toThrow(
        'Failed to get WebGL context'
      );
    });

    it('gives up its WebGL context when destroyed', (): void => {
      const viz: Visualization = new RippleVisualization({canvas, analyser: analyser.node});

      viz.destroy();

      expect(fakes.webglRecordings[0].lostContextCount).toBe(1);
    });
  });
});

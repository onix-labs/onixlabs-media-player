/**
 * @fileoverview Unit tests for the Blank visualization.
 *
 * Tests cover:
 * - Its metadata
 * - Drawing nothing and reading no audio
 * - Still sizing the canvas it is given, so the switch to it clears the view
 * - Refusing a canvas that cannot supply a 2D context
 *
 * Canvas 2D and Web Audio are faked; see visualization-test-fakes.group3.
 *
 * @module app/components/audio/audio-outlet/visualizations/blank-visualization.spec
 */

import {BlankVisualization} from './blank-visualization';
import {
  BYTE_MAX,
  CanvasFakes,
  CanvasRecording,
  FakeAnalyser,
  constantSamples,
  createFakeAnalyser,
  installCanvasFakes,
} from './visualization-test-fakes.group3';

describe('BlankVisualization', (): void => {
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

  it('identifies itself as Blank in the Simple category', (): void => {
    const viz: BlankVisualization = new BlankVisualization({canvas, analyser: analyser.node});

    expect(viz.name).toBe('Blank');
    expect(viz.category).toBe('Simple');
  });

  it('follows the global render resolution', (): void => {
    const viz: BlankVisualization = new BlankVisualization({canvas, analyser: analyser.node});

    expect(viz.rendersAtNativeResolution).toBe(false);
  });

  it('draws nothing, even with loud audio', (): void => {
    const viz: BlankVisualization = new BlankVisualization({canvas, analyser: analyser.node});
    const recording: CanvasRecording = fakes.recordingFor(canvas);
    analyser.frequencyData = constantSamples(BYTE_MAX);
    analyser.timeDomainData = constantSamples(BYTE_MAX);
    viz.resize(800, 600);
    viz.setPlaying(true);

    viz.draw();

    expect(recording.operations).toHaveLength(0);
  });

  it('does not read the analyser', (): void => {
    const viz: BlankVisualization = new BlankVisualization({canvas, analyser: analyser.node});
    viz.resize(800, 600);

    viz.draw();

    expect(analyser.frequencyReads).toHaveLength(0);
    expect(analyser.timeDomainReads).toHaveLength(0);
  });

  it('sizes the canvas on resize, which is what clears the previous visualization', (): void => {
    const viz: BlankVisualization = new BlankVisualization({canvas, analyser: analyser.node});

    viz.resize(640, 360);

    expect([canvas.width, canvas.height]).toEqual([640, 360]);
  });

  it('refuses a canvas that cannot supply a 2D context', (): void => {
    fakes.restore();
    fakes = installCanvasFakes({canvas2d: false});

    expect((): BlankVisualization => new BlankVisualization({canvas, analyser: analyser.node})).toThrow('Failed to get 2D context');
  });
});

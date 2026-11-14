/**
 * @fileoverview Unit tests for the Logo visualization.
 *
 * Tests cover:
 * - Loading the logo asset and drawing nothing until it has loaded
 * - Fitting the logo inside the canvas (width-led, capped by height) and centring it
 * - Staying independent of the audio and of the render-resolution setting
 * - Degenerate canvas sizes and a broken image
 *
 * Canvas 2D, Web Audio and the Image element are faked; see visualization-test-fakes.group3.
 *
 * @module app/components/audio/audio-outlet/visualizations/logo-visualization.spec
 */

import {LogoVisualization} from './logo-visualization';
import {
  BYTE_MAX,
  CanvasFakes,
  CanvasRecording,
  FakeAnalyser,
  RecordedCall,
  constantSamples,
  createFakeAnalyser,
  installCanvasFakes,
} from './visualization-test-fakes.group3';

const WIDTH: number = 800;
const HEIGHT: number = 600;

/** Stand-in for the Image element: jsdom never loads images, so the test decides when it has. */
class FakeImage {
  public static instances: FakeImage[] = [];

  public src: string = '';
  public onload: (() => void) | null = null;
  public naturalWidth: number = 0;
  public naturalHeight: number = 0;

  public constructor() {
    FakeImage.instances.push(this);
  }

  /** Reports the image as loaded at the given intrinsic size. */
  public finishLoading(naturalWidth: number, naturalHeight: number): void {
    this.naturalWidth = naturalWidth;
    this.naturalHeight = naturalHeight;
    this.onload?.();
  }
}

describe('LogoVisualization', (): void => {
  let fakes: CanvasFakes;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let recording: CanvasRecording;
  let viz: LogoVisualization;
  let logo: FakeImage;

  beforeEach((): void => {
    FakeImage.instances = [];
    vi.stubGlobal('Image', FakeImage);
    fakes = installCanvasFakes();
    analyser = createFakeAnalyser();
    canvas = document.createElement('canvas');
    viz = new LogoVisualization({canvas, analyser: analyser.node});
    recording = fakes.recordingFor(canvas);
    [logo] = FakeImage.instances;
    viz.resize(WIDTH, HEIGHT);
  });

  afterEach((): void => {
    fakes.restore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('metadata', (): void => {
    it('identifies itself as Logo in the Simple category', (): void => {
      expect(viz.name).toBe('Logo');
      expect(viz.category).toBe('Simple');
    });

    it('asks to be rendered at native resolution', (): void => {
      expect(viz.rendersAtNativeResolution).toBe(true);
    });
  });

  describe('loading', (): void => {
    it('requests the logo asset once, on construction', (): void => {
      expect(FakeImage.instances).toHaveLength(1);
      expect(logo.src).toBe('logo.png');
    });

    it('clears the canvas but draws no image before the logo has loaded', (): void => {
      viz.draw();

      expect(recording.callsTo('clearRect')).toEqual([[0, 0, WIDTH, HEIGHT]]);
      expect(recording.callsTo('drawImage')).toHaveLength(0);
    });

    it('draws no image when the logo loaded without any pixels', (): void => {
      logo.finishLoading(0, 0);

      viz.draw();

      expect(recording.callsTo('clearRect')).toEqual([[0, 0, WIDTH, HEIGHT]]);
      expect(recording.callsTo('drawImage')).toHaveLength(0);
    });

    it('draws the logo once it has loaded', (): void => {
      logo.finishLoading(1000, 200);

      viz.draw();

      expect(recording.callsTo('drawImage')).toHaveLength(1);
      expect(recording.callsTo('drawImage')[0][0]).toBe(logo);
    });
  });

  describe('layout', (): void => {
    it('fits a wide logo to 70% of the canvas width and centres it', (): void => {
      logo.finishLoading(1000, 200); // 5:1

      viz.draw();

      // 560 wide, so 112 tall: inside the 300 pixel height limit.
      const [, x, y, width, height]: readonly unknown[] = recording.callsTo('drawImage')[0];
      expect(width).toBeCloseTo(560, 6);
      expect(height).toBeCloseTo(112, 6);
      expect(x).toBeCloseTo(120, 6);
      expect(y).toBeCloseTo(244, 6);
    });

    it('caps a tall logo at half the canvas height and centres it', (): void => {
      logo.finishLoading(200, 400); // 1:2

      viz.draw();

      // 560 wide would be 1120 tall, so the height limit of 300 wins: 150 wide.
      const [, x, y, width, height]: readonly unknown[] = recording.callsTo('drawImage')[0];
      expect(width).toBeCloseTo(150, 6);
      expect(height).toBeCloseTo(300, 6);
      expect(x).toBeCloseTo(325, 6);
      expect(y).toBeCloseTo(150, 6);
    });

    it('preserves the aspect ratio of the logo', (): void => {
      logo.finishLoading(640, 480);

      viz.draw();

      const [, , , width, height]: readonly unknown[] = recording.callsTo('drawImage')[0];
      expect((width as number) / (height as number)).toBeCloseTo(640 / 480, 6);
    });

    it('lays the logo out again for the new size after a resize', (): void => {
      logo.finishLoading(1000, 200);
      viz.resize(400, 300);

      viz.draw();

      const [, x, y, width, height]: readonly unknown[] = recording.callsTo('drawImage')[0];
      expect(width).toBeCloseTo(280, 6);
      expect(height).toBeCloseTo(56, 6);
      expect(x).toBeCloseTo(60, 6);
      expect(y).toBeCloseTo(122, 6);
    });

    it('clears the previous frame before drawing the logo', (): void => {
      logo.finishLoading(1000, 200);

      viz.draw();

      const methods: string[] = recording.operations
        .filter((operation): operation is RecordedCall => operation.kind === 'call')
        .map((call: RecordedCall): string => call.method);
      expect(methods).toEqual(['clearRect', 'drawImage']);
    });

    it('draws the logo with high-quality smoothing', (): void => {
      logo.finishLoading(1000, 200);

      viz.draw();

      const draw: RecordedCall = recording.calls('drawImage')[0];
      expect(draw.state['imageSmoothingEnabled']).toBe(true);
      expect(draw.state['imageSmoothingQuality']).toBe('high');
    });
  });

  describe('audio', (): void => {
    it('does not read the analyser', (): void => {
      logo.finishLoading(1000, 200);

      viz.draw();

      expect(analyser.frequencyReads).toHaveLength(0);
      expect(analyser.timeDomainReads).toHaveLength(0);
    });

    it('draws the same frame whatever the audio is doing', (): void => {
      logo.finishLoading(1000, 200);
      viz.draw();
      const quiet: readonly unknown[] = recording.callsTo('drawImage')[0];
      analyser.frequencyData = constantSamples(BYTE_MAX);
      analyser.timeDomainData = constantSamples(BYTE_MAX);
      recording.clear();

      viz.draw();

      expect(recording.callsTo('drawImage')[0]).toEqual(quiet);
    });
  });

  describe('edge cases', (): void => {
    it('draws nothing while the canvas has no size', (): void => {
      logo.finishLoading(1000, 200);
      viz.resize(0, 0);
      recording.clear();

      viz.draw();

      expect(recording.operations).toHaveLength(0);
    });

    it.each([
      ['a one-pixel canvas', 1, 1],
      ['a very wide canvas', 4000, 1],
      ['a very tall canvas', 1, 4000],
    ])('passes only finite numbers to the canvas for %s', (_label: string, width: number, height: number): void => {
      logo.finishLoading(1000, 200);
      viz.resize(width, height);
      recording.clear();

      viz.draw();

      expect(recording.callsTo('drawImage')).toHaveLength(1);
      expect(recording.nonFiniteOperations()).toEqual([]);
    });
  });
});

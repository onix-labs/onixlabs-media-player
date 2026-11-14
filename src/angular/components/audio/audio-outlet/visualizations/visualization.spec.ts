/**
 * @fileoverview Unit tests for visualization base classes.
 *
 * Tests cover:
 * - Visualization (abstract base): sensitivity, trailIntensity, fftSize,
 *   barDensity, lineWidth, glowIntensity, waveformSmoothing, bar colors,
 *   fade logic, resize, hslToRgb, sensitivityFactor, getFadeMultiplier
 * - Canvas2DVisualization: applyFadeOverlay, clearLowAlphaPixels,
 *   resize with preserveContentOnResize, getCachedColor, getColorFromHue,
 *   createOffscreenCanvas, the persistence fade and the ghost-pixel clear
 *   cadence, surface sizing, bloom, directional zoom, layered path drawing
 * - Fade timing against a controlled clock, and isIdle
 * - WebGLVisualization: context acquisition and release
 *
 * A minimal concrete subclass (TestVisualization) is used to test the
 * abstract base classes. Web Audio API and Canvas 2D are mocked.
 *
 * @module app/components/audio/audio-outlet/visualizations/visualization.spec
 */

import {Canvas2DVisualization, Visualization, WebGLVisualization} from './visualization';
import type {OffscreenCanvasPair, VisualizationConfig} from './visualization';

// ============================================================================
// Mocks
// ============================================================================

/** Minimal mock AnalyserNode */
function createMockAnalyser(): AnalyserNode {
  return {
    fftSize: 2048,
    frequencyBinCount: 1024,
    getByteFrequencyData: vi.fn(),
    getByteTimeDomainData: vi.fn(),
  } as unknown as AnalyserNode;
}

/** Minimal mock CanvasRenderingContext2D */
function createMockCtx(): CanvasRenderingContext2D {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn().mockReturnValue({
      data: new Uint8ClampedArray(16), // 4 pixels (RGBA each)
      width: 2,
      height: 2,
    }),
    putImageData: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    setTransform: vi.fn(),
    filter: 'none',
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    shadowBlur: 0,
    shadowColor: '',
    globalAlpha: 1,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
  } as unknown as CanvasRenderingContext2D;
}

/** Creates a mock HTMLCanvasElement that returns a mock 2D context */
function createMockCanvas(): HTMLCanvasElement {
  const ctx: CanvasRenderingContext2D = createMockCtx();
  return {
    width: 800,
    height: 600,
    getContext: vi.fn().mockReturnValue(ctx),
    __mockCtx: ctx,
  } as unknown as HTMLCanvasElement & {__mockCtx: CanvasRenderingContext2D};
}

// ============================================================================
// Concrete test subclasses
// ============================================================================

/** Options accepted by the layered path helpers */
interface LayerOptions {
  ctx?: CanvasRenderingContext2D;
  baseGlowBlur?: number;
  closePath?: boolean;
  fill?: boolean;
  glowLineWidthOffset?: number;
  highlightLineWidth?: number;
}

/** What a mock context was set to at the moment a path was painted */
interface PaintSnapshot {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  shadowBlur: number;
  shadowColor: string;
}

/** Records the mock context's style each time stroke() or fill() is called on it */
function recordPaints(ctx: CanvasRenderingContext2D): PaintSnapshot[] {
  const paints: PaintSnapshot[] = [];
  const snapshot = (): void => {
    paints.push({
      strokeStyle: ctx.strokeStyle,
      fillStyle: ctx.fillStyle,
      lineWidth: ctx.lineWidth,
      shadowBlur: ctx.shadowBlur,
      shadowColor: ctx.shadowColor,
    });
  };
  vi.mocked(ctx.stroke).mockImplementation(snapshot);
  vi.mocked(ctx.fill).mockImplementation(snapshot);
  return paints;
}

/** Creates a mock offscreen canvas together with its mock context */
function createMockPair(): OffscreenCanvasPair {
  const pairCanvas: HTMLCanvasElement = createMockCanvas();
  return {canvas: pairCanvas, ctx: pairCanvas.getContext('2d') as CanvasRenderingContext2D};
}

/** Concrete WebGL visualization for testing base class behavior */
class TestWebGLVisualization extends WebGLVisualization {
  public readonly name: string = 'Test GL';
  public readonly category: string = 'test';

  public constructor(config: VisualizationConfig) {
    super(config);
  }

  public draw(): void {
    // Nothing to render: only context handling is under test.
  }

  public get testGl(): WebGLRenderingContext { return this.gl; }
}

/** Creates a mock canvas that hands out the given context for each context id */
function createMockGLCanvas(contexts: Record<string, unknown>): HTMLCanvasElement {
  return {
    width: 800,
    height: 600,
    getContext: vi.fn((id: string): unknown => contexts[id] ?? null),
  } as unknown as HTMLCanvasElement;
}

/** Concrete Canvas2D visualization for testing base class behavior */
class TestCanvas2DVisualization extends Canvas2DVisualization {
  public readonly name: string = 'Test 2D';
  public readonly category: string = 'test';
  public drawCallCount: number = 0;
  public fftSizeChangedCount: number = 0;
  public barDensityChangedCount: number = 0;
  public resizeCount: number = 0;
  public barColorsChangedCount: number = 0;

  public constructor(config: VisualizationConfig) {
    super(config);
  }

  public draw(): void {
    this.drawCallCount++;
    this.updateFade();
  }

  protected override onFftSizeChanged(): void {
    this.fftSizeChangedCount++;
  }

  protected override onBarDensityChanged(): void {
    this.barDensityChangedCount++;
  }

  protected override onResize(): void {
    this.resizeCount++;
  }

  protected override onBarColorsChanged(): void {
    this.barColorsChangedCount++;
  }

  // Expose protected methods for testing
  public testUpdateFade(): void { this.updateFade(); }
  public testApplyFadeOverlay(): void { this.applyFadeOverlay(); }
  public testClearLowAlphaPixels(): void { this.clearLowAlphaPixels(); }
  public testHslToRgb(h: number, s: number, l: number): {r: number; g: number; b: number} {
    return this.hslToRgb(h, s, l);
  }
  public testGetFadeMultiplier(): number { return this.getFadeMultiplier(); }
  public testGetScaledGlowBlur(base: number): number { return this.getScaledGlowBlur(base); }
  public testGetColorFromHue(hue: number): {main: string; glow: string} { return this.getColorFromHue(hue); }
  public testGetCachedColor(index: 1 | 2, hue: number): {main: string; glow: string} { return this.getCachedColor(index, hue); }
  public testCreateOffscreenCanvas(): OffscreenCanvasPair { return this.createOffscreenCanvas(); }
  public testResizeCanvasPreserving(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, w: number, h: number, preserve?: boolean): void {
    this.resizeCanvasPreserving(canvas, ctx, w, h, preserve);
  }
  public testBuildSmoothPath(ctx: CanvasRenderingContext2D, points: Array<{x: number; y: number}>, n?: number): void {
    this.buildSmoothPath(ctx, points, n);
  }
  public testBuildSmoothPathFrom(ctx: CanvasRenderingContext2D, points: Array<{x: number; y: number}>, n: number, start: number): void {
    this.buildSmoothPath(ctx, points, n, start);
  }
  public testApplyPersistenceFade(fadeRate: number): void { this.applyPersistenceFade(fadeRate); }
  public testPeriodicClearLowAlpha(interval: number): void { this.periodicClearLowAlpha(interval); }
  public testGetSurfaceSize(w: number, h: number, budget: number): {width: number; height: number} {
    return this.getSurfaceSize(w, h, budget);
  }
  public testApplySurfaceTransform(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.applySurfaceTransform(ctx, w, h);
  }
  public testCopySurface(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement): void { this.copySurface(ctx, source); }
  public testDrawBloom(bloom: OffscreenCanvasPair, source: HTMLCanvasElement, blur: number, strength: number, scale: number): void {
    this.drawBloom(bloom, source, blur, strength, scale);
  }
  public testApplyDirectionalZoom(
    trail: OffscreenCanvasPair,
    temp: OffscreenCanvasPair,
    centerX: number,
    centerY: number,
    fadeRate: number,
    zoomScale: number,
    rotation?: number
  ): void {
    this.applyDirectionalZoom(trail.canvas, trail.ctx, temp.canvas, temp.ctx, centerX, centerY, fadeRate, zoomScale, rotation);
  }
  public testDrawPathWithLayers(
    buildPath: () => void,
    mainColor: string,
    glowColor: string,
    highlightColor?: string,
    options?: LayerOptions
  ): void {
    this.drawPathWithLayers(buildPath, mainColor, glowColor, highlightColor, options);
  }
  public testDrawPointsWithLayers(
    points: ReadonlyArray<{x: number; y: number}>,
    mainColor: string,
    glowColor: string,
    highlightColor?: string,
    options?: LayerOptions & {startIndex?: number; endIndex?: number}
  ): void {
    this.drawPointsWithLayers(points, mainColor, glowColor, highlightColor, options);
  }
  public get testFadeAlpha(): number { return this.fadeAlpha; }
  public set testFadeAlpha(v: number) { this.fadeAlpha = v; }
  public get testIsPlaying(): boolean { return this.isPlaying; }
  public get testSensitivityFactor(): number { return this.sensitivityFactor; }
  public get testCtx(): CanvasRenderingContext2D { return this.ctx; }
  public get testPreserveContentOnResize(): boolean { return this.preserveContentOnResize; }
  public set testPreserveContentOnResize(v: boolean) { this.preserveContentOnResize = v; }
  public get testHasDrawn(): boolean { return this.hasDrawn; }
  public set testHasDrawn(v: boolean) { this.hasDrawn = v; }
}

// ============================================================================
// Tests
// ============================================================================

describe('Visualization base classes', (): void => {
  let canvas: HTMLCanvasElement;
  let analyser: AnalyserNode;
  let viz: TestCanvas2DVisualization;

  beforeEach((): void => {
    // Mock document.createElement for offscreen canvas creation
    vi.spyOn(document, 'createElement').mockImplementation((tag: string): HTMLElement => {
      if (tag === 'canvas') return createMockCanvas() as unknown as HTMLElement;
      return document.createElement(tag);
    });

    canvas = createMockCanvas();
    analyser = createMockAnalyser();
    viz = new TestCanvas2DVisualization({canvas, analyser});
  });

  afterEach((): void => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Construction
  // ==========================================================================

  describe('construction', (): void => {
    it('creates with default values', (): void => {
      expect(viz.name).toBe('Test 2D');
      expect(viz.category).toBe('test');
      expect(viz.getSensitivity()).toBe(0.25);
      expect(viz.getTrailIntensity()).toBe(0.5);
      expect(viz.getFftSize()).toBe(2048);
      expect(viz.getBarDensity()).toBe('medium');
      expect(viz.getLineWidth()).toBe(2.0);
      expect(viz.getGlowIntensity()).toBe(0.5);
      expect(viz.getWaveformSmoothing()).toBe(0.5);
      expect(viz.getBarColorBottom()).toBe('#00cc00');
      expect(viz.getBarColorMiddle()).toBe('#cccc00');
      expect(viz.getBarColorTop()).toBe('#cc0000');
    });

    it('obtains 2D context from canvas', (): void => {
      expect(canvas.getContext).toHaveBeenCalledWith('2d');
    });
  });

  // ==========================================================================
  // setSensitivity / getSensitivity
  // ==========================================================================

  describe('setSensitivity', (): void => {
    it('sets sensitivity to a valid value', (): void => {
      viz.setSensitivity(0.75);
      expect(viz.getSensitivity()).toBe(0.75);
    });

    it('clamps to 0 at lower bound', (): void => {
      viz.setSensitivity(-0.5);
      expect(viz.getSensitivity()).toBe(0);
    });

    it('clamps to 1 at upper bound', (): void => {
      viz.setSensitivity(1.5);
      expect(viz.getSensitivity()).toBe(1);
    });

    it('accepts boundary values', (): void => {
      viz.setSensitivity(0);
      expect(viz.getSensitivity()).toBe(0);
      viz.setSensitivity(1);
      expect(viz.getSensitivity()).toBe(1);
    });
  });

  // ==========================================================================
  // sensitivityFactor
  // ==========================================================================

  describe('sensitivityFactor', (): void => {
    it('returns sensitivity * 2', (): void => {
      viz.setSensitivity(0.25);
      expect(viz.testSensitivityFactor).toBe(0.5);
    });

    it('returns 0 when sensitivity is 0', (): void => {
      viz.setSensitivity(0);
      expect(viz.testSensitivityFactor).toBe(0);
    });

    it('returns 2 when sensitivity is 1', (): void => {
      viz.setSensitivity(1);
      expect(viz.testSensitivityFactor).toBe(2);
    });
  });

  // ==========================================================================
  // setTrailIntensity / getTrailIntensity
  // ==========================================================================

  describe('setTrailIntensity', (): void => {
    it('sets trail intensity to a valid value', (): void => {
      viz.setTrailIntensity(0.8);
      expect(viz.getTrailIntensity()).toBe(0.8);
    });

    it('clamps to 0 at lower bound', (): void => {
      viz.setTrailIntensity(-1);
      expect(viz.getTrailIntensity()).toBe(0);
    });

    it('clamps to 1 at upper bound', (): void => {
      viz.setTrailIntensity(2);
      expect(viz.getTrailIntensity()).toBe(1);
    });
  });

  // ==========================================================================
  // getFadeMultiplier
  // ==========================================================================

  describe('getFadeMultiplier', (): void => {
    it('returns 1.0 at default trail intensity (0.5)', (): void => {
      viz.setTrailIntensity(0.5);
      expect(viz.testGetFadeMultiplier()).toBeCloseTo(1.0, 5);
    });

    it('returns 2.0 at trail intensity 0 (fast fade)', (): void => {
      viz.setTrailIntensity(0);
      expect(viz.testGetFadeMultiplier()).toBeCloseTo(2.0, 5);
    });

    it('returns 0.5 at trail intensity 1 (slow fade)', (): void => {
      viz.setTrailIntensity(1);
      expect(viz.testGetFadeMultiplier()).toBeCloseTo(0.5, 5);
    });
  });

  // ==========================================================================
  // setFftSize / getFftSize
  // ==========================================================================

  describe('setFftSize', (): void => {
    it('accepts valid FFT sizes', (): void => {
      for (const size of [256, 512, 1024, 2048, 4096]) {
        viz.setFftSize(size);
        expect(viz.getFftSize()).toBe(size);
      }
    });

    it('rejects invalid FFT sizes', (): void => {
      viz.setFftSize(2048); // set a known valid value first
      viz.setFftSize(300);  // invalid
      expect(viz.getFftSize()).toBe(2048); // unchanged
    });

    it('updates the analyser node fftSize', (): void => {
      viz.setFftSize(512);
      expect(analyser.fftSize).toBe(512);
    });

    it('calls onFftSizeChanged hook', (): void => {
      viz.setFftSize(1024);
      expect(viz.fftSizeChangedCount).toBe(1);
    });

    it('does not call onFftSizeChanged for invalid size', (): void => {
      viz.setFftSize(999);
      expect(viz.fftSizeChangedCount).toBe(0);
    });
  });

  // ==========================================================================
  // setBarDensity / getBarDensity
  // ==========================================================================

  describe('setBarDensity', (): void => {
    it('accepts valid densities', (): void => {
      for (const density of ['low', 'medium', 'high'] as const) {
        viz.setBarDensity(density);
        expect(viz.getBarDensity()).toBe(density);
      }
    });

    it('rejects invalid density', (): void => {
      viz.setBarDensity('medium');
      viz.setBarDensity('ultra' as 'low');
      expect(viz.getBarDensity()).toBe('medium');
    });

    it('calls onBarDensityChanged hook', (): void => {
      viz.setBarDensity('high');
      expect(viz.barDensityChangedCount).toBe(1);
    });
  });

  // ==========================================================================
  // setLineWidth / getLineWidth
  // ==========================================================================

  describe('setLineWidth', (): void => {
    it('sets line width to a valid value', (): void => {
      viz.setLineWidth(3.5);
      expect(viz.getLineWidth()).toBe(3.5);
    });

    it('clamps to 1 at lower bound', (): void => {
      viz.setLineWidth(0);
      expect(viz.getLineWidth()).toBe(1);
    });

    it('clamps to 5 at upper bound', (): void => {
      viz.setLineWidth(10);
      expect(viz.getLineWidth()).toBe(5);
    });
  });

  // ==========================================================================
  // setGlowIntensity / getGlowIntensity
  // ==========================================================================

  describe('setGlowIntensity', (): void => {
    it('sets glow intensity to a valid value', (): void => {
      viz.setGlowIntensity(0.8);
      expect(viz.getGlowIntensity()).toBe(0.8);
    });

    it('clamps to 0 at lower bound', (): void => {
      viz.setGlowIntensity(-1);
      expect(viz.getGlowIntensity()).toBe(0);
    });

    it('clamps to 1 at upper bound', (): void => {
      viz.setGlowIntensity(2);
      expect(viz.getGlowIntensity()).toBe(1);
    });
  });

  // ==========================================================================
  // getScaledGlowBlur
  // ==========================================================================

  describe('getScaledGlowBlur', (): void => {
    it('scales blur by glow intensity', (): void => {
      viz.setGlowIntensity(0.5);
      expect(viz.testGetScaledGlowBlur(12)).toBe(6);
    });

    it('returns 0 when glow intensity is 0', (): void => {
      viz.setGlowIntensity(0);
      expect(viz.testGetScaledGlowBlur(12)).toBe(0);
    });

    it('returns full blur when glow intensity is 1', (): void => {
      viz.setGlowIntensity(1);
      expect(viz.testGetScaledGlowBlur(12)).toBe(12);
    });
  });

  // ==========================================================================
  // setWaveformSmoothing / getWaveformSmoothing
  // ==========================================================================

  describe('setWaveformSmoothing', (): void => {
    it('sets waveform smoothing to a valid value', (): void => {
      viz.setWaveformSmoothing(0.8);
      expect(viz.getWaveformSmoothing()).toBe(0.8);
    });

    it('clamps to 0 at lower bound', (): void => {
      viz.setWaveformSmoothing(-1);
      expect(viz.getWaveformSmoothing()).toBe(0);
    });

    it('clamps to 1 at upper bound', (): void => {
      viz.setWaveformSmoothing(2);
      expect(viz.getWaveformSmoothing()).toBe(1);
    });
  });

  // ==========================================================================
  // Bar colors
  // ==========================================================================

  describe('bar colors', (): void => {
    it('setBarColorBottom updates and fires hook', (): void => {
      viz.setBarColorBottom('#ff0000');
      expect(viz.getBarColorBottom()).toBe('#ff0000');
      expect(viz.barColorsChangedCount).toBe(1);
    });

    it('setBarColorMiddle updates and fires hook', (): void => {
      viz.setBarColorMiddle('#00ff00');
      expect(viz.getBarColorMiddle()).toBe('#00ff00');
      expect(viz.barColorsChangedCount).toBe(1);
    });

    it('setBarColorTop updates and fires hook', (): void => {
      viz.setBarColorTop('#0000ff');
      expect(viz.getBarColorTop()).toBe('#0000ff');
      expect(viz.barColorsChangedCount).toBe(1);
    });
  });

  // ==========================================================================
  // setPlaying / fade logic
  // ==========================================================================

  describe('setPlaying', (): void => {
    it('sets playing to true and resets fadeAlpha to 0', (): void => {
      viz.testFadeAlpha = 1;
      viz.setPlaying(true);
      expect(viz.testIsPlaying).toBe(true);
      expect(viz.testFadeAlpha).toBe(0);
    });

    it('sets playing to false without changing fadeAlpha', (): void => {
      viz.setPlaying(true); // fadeAlpha = 0
      viz.setPlaying(false);
      expect(viz.testIsPlaying).toBe(false);
      expect(viz.testFadeAlpha).toBe(0); // unchanged
    });
  });

  describe('updateFade', (): void => {
    it('decreases fadeAlpha when playing (fade in)', (): void => {
      viz.testFadeAlpha = 0.5;
      viz.setPlaying(true);
      // Force lastFrameTime to be in the past
      viz.testFadeAlpha = 0.5;
      viz.testUpdateFade();
      // fadeAlpha should decrease (fade in) - exact value depends on deltaMs
      expect(viz.testFadeAlpha).toBeLessThanOrEqual(0.5);
    });

    it('increases fadeAlpha when not playing (fade out)', (): void => {
      viz.testFadeAlpha = 0.5;
      viz.setPlaying(false);
      viz.testUpdateFade();
      // fadeAlpha should increase (fade out) - exact value depends on deltaMs
      expect(viz.testFadeAlpha).toBeGreaterThanOrEqual(0.5);
    });

    it('clamps fadeAlpha to 0 minimum when playing', (): void => {
      viz.testFadeAlpha = 0;
      viz.setPlaying(true);
      viz.testUpdateFade();
      expect(viz.testFadeAlpha).toBe(0);
    });

    it('clamps fadeAlpha to 1 maximum when not playing', (): void => {
      viz.testFadeAlpha = 1;
      viz.setPlaying(false);
      viz.testUpdateFade();
      expect(viz.testFadeAlpha).toBe(1);
    });
  });

  // ==========================================================================
  // applyFadeOverlay
  // ==========================================================================

  describe('applyFadeOverlay', (): void => {
    it('does nothing when fadeAlpha is 0', (): void => {
      viz.testFadeAlpha = 0;
      viz.testApplyFadeOverlay();
      expect(viz.testCtx.save).not.toHaveBeenCalled();
    });

    it('applies overlay when fadeAlpha is > 0', (): void => {
      viz.testFadeAlpha = 0.5;
      viz.resize(100, 100);
      viz.testApplyFadeOverlay();
      expect(viz.testCtx.save).toHaveBeenCalled();
      expect(viz.testCtx.globalCompositeOperation).toBe('destination-out');
      expect(viz.testCtx.fillRect).toHaveBeenCalledWith(0, 0, 100, 100);
      expect(viz.testCtx.restore).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // clearLowAlphaPixels
  // ==========================================================================

  describe('clearLowAlphaPixels', (): void => {
    it('clears pixels with alpha below threshold', (): void => {
      // Set up image data: 4 pixels, alpha at indices 3, 7, 11, 15
      const imageData: ImageData = {
        data: new Uint8ClampedArray([
          255, 0, 0, 25,    // pixel 0: alpha 25 (below threshold 30) → cleared
          0, 255, 0, 35,    // pixel 1: alpha 35 (above threshold) → kept
          0, 0, 255, 0,     // pixel 2: alpha 0 → already zero, no change
          128, 128, 128, 255 // pixel 3: alpha 255 → kept
        ]),
        width: 2,
        height: 2,
      } as unknown as ImageData;

      (viz.testCtx.getImageData as ReturnType<typeof vi.fn>).mockReturnValueOnce(imageData);

      viz.resize(2, 2);
      viz.testClearLowAlphaPixels();

      expect(imageData.data[3]).toBe(0);     // was 25, cleared
      expect(imageData.data[7]).toBe(35);    // kept
      expect(imageData.data[11]).toBe(0);    // was 0, unchanged
      expect(imageData.data[15]).toBe(255);  // kept
      expect(viz.testCtx.putImageData).toHaveBeenCalledWith(imageData, 0, 0);
    });

    it('skips processing when canvas has zero dimensions', (): void => {
      viz.resize(0, 0);
      viz.testClearLowAlphaPixels();
      expect(viz.testCtx.getImageData).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // resize
  // ==========================================================================

  describe('resize', (): void => {
    it('updates internal dimensions and canvas size', (): void => {
      viz.resize(1920, 1080);
      expect(canvas.width).toBe(1920);
      expect(canvas.height).toBe(1080);
    });

    it('calls onResize hook', (): void => {
      viz.resize(640, 480);
      expect(viz.resizeCount).toBe(1);
    });

    describe('with preserveContentOnResize', (): void => {
      beforeEach((): void => {
        viz.testPreserveContentOnResize = true;
      });

      it('clears canvas on same dimensions when not yet drawn', (): void => {
        // Set canvas to match target
        canvas.width = 800;
        canvas.height = 600;
        viz.resize(800, 600); // first resize
        viz.testHasDrawn = false;
        viz.resize(800, 600); // same dimensions, not drawn
        expect(viz.testCtx.clearRect).toHaveBeenCalledWith(0, 0, 800, 600);
      });

      it('no-ops when dimensions unchanged and already drawn', (): void => {
        viz.resize(800, 600);
        viz.testHasDrawn = true;
        const prevResizeCount: number = viz.resizeCount;
        viz.resize(800, 600);
        // Should not call onResize again
        expect(viz.resizeCount).toBe(prevResizeCount);
      });
    });
  });

  // ==========================================================================
  // hslToRgb
  // ==========================================================================

  describe('hslToRgb', (): void => {
    it('converts pure red (0, 100, 50)', (): void => {
      const rgb = viz.testHslToRgb(0, 100, 50);
      expect(rgb).toEqual({r: 255, g: 0, b: 0});
    });

    it('converts pure green (120, 100, 50)', (): void => {
      const rgb = viz.testHslToRgb(120, 100, 50);
      expect(rgb).toEqual({r: 0, g: 255, b: 0});
    });

    it('converts pure blue (240, 100, 50)', (): void => {
      const rgb = viz.testHslToRgb(240, 100, 50);
      expect(rgb).toEqual({r: 0, g: 0, b: 255});
    });

    it('converts white (0, 0, 100)', (): void => {
      const rgb = viz.testHslToRgb(0, 0, 100);
      expect(rgb).toEqual({r: 255, g: 255, b: 255});
    });

    it('converts black (0, 0, 0)', (): void => {
      const rgb = viz.testHslToRgb(0, 0, 0);
      expect(rgb).toEqual({r: 0, g: 0, b: 0});
    });

    it('converts mid-gray (0, 0, 50)', (): void => {
      const rgb = viz.testHslToRgb(0, 0, 50);
      expect(rgb).toEqual({r: 128, g: 128, b: 128});
    });

    it('wraps negative hue values', (): void => {
      const negHue = viz.testHslToRgb(-120, 100, 50);
      const posHue = viz.testHslToRgb(240, 100, 50);
      expect(negHue).toEqual(posHue);
    });

    it('wraps hue values over 360', (): void => {
      const overHue = viz.testHslToRgb(480, 100, 50);
      const normHue = viz.testHslToRgb(120, 100, 50);
      expect(overHue).toEqual(normHue);
    });

    it('converts yellow (60, 100, 50)', (): void => {
      const rgb = viz.testHslToRgb(60, 100, 50);
      expect(rgb).toEqual({r: 255, g: 255, b: 0});
    });

    it('converts cyan (180, 100, 50)', (): void => {
      const rgb = viz.testHslToRgb(180, 100, 50);
      expect(rgb).toEqual({r: 0, g: 255, b: 255});
    });

    it('converts magenta (300, 100, 50)', (): void => {
      const rgb = viz.testHslToRgb(300, 100, 50);
      expect(rgb).toEqual({r: 255, g: 0, b: 255});
    });
  });

  // ==========================================================================
  // getColorFromHue
  // ==========================================================================

  describe('getColorFromHue', (): void => {
    it('returns main and glow color strings', (): void => {
      const color = viz.testGetColorFromHue(0);
      expect(color.main).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
      expect(color.glow).toMatch(/^rgba\(\d+, \d+, \d+, 0\.8\)$/);
    });

    it('returns red-ish colors for hue 0', (): void => {
      const color = viz.testGetColorFromHue(0);
      expect(color.main).toBe('rgb(255, 0, 0)');
      expect(color.glow).toBe('rgba(255, 0, 0, 0.8)');
    });
  });

  // ==========================================================================
  // getCachedColor
  // ==========================================================================

  describe('getCachedColor', (): void => {
    it('caches color for same hue', (): void => {
      const first = viz.testGetCachedColor(1, 120);
      const second = viz.testGetCachedColor(1, 120);
      expect(first).toBe(second); // same object reference
    });

    it('invalidates cache when hue changes by more than 1 degree', (): void => {
      const first = viz.testGetCachedColor(1, 120);
      const second = viz.testGetCachedColor(1, 122);
      expect(first).not.toBe(second); // different object
    });

    it('keeps cache for small hue changes (< 1 degree)', (): void => {
      const first = viz.testGetCachedColor(1, 120);
      const second = viz.testGetCachedColor(1, 120.5);
      expect(first).toBe(second); // same object (cached)
    });

    it('maintains independent caches for slot 1 and 2', (): void => {
      const slot1 = viz.testGetCachedColor(1, 120);
      const slot2 = viz.testGetCachedColor(2, 240);
      expect(slot1.main).not.toBe(slot2.main);
    });
  });

  // ==========================================================================
  // createOffscreenCanvas
  // ==========================================================================

  describe('createOffscreenCanvas', (): void => {
    it('creates a canvas at current dimensions', (): void => {
      viz.resize(400, 300);
      const result = viz.testCreateOffscreenCanvas();
      expect(result.canvas).toBeDefined();
      expect(result.ctx).toBeDefined();
      expect(result.canvas.width).toBe(400);
      expect(result.canvas.height).toBe(300);
    });
  });

  // ==========================================================================
  // resizeCanvasPreserving
  // ==========================================================================

  describe('resizeCanvasPreserving', (): void => {
    it('no-ops when dimensions are unchanged', (): void => {
      const mockCvs = createMockCanvas();
      const mockContext = createMockCtx();
      mockCvs.width = 100;
      mockCvs.height = 100;
      viz.testResizeCanvasPreserving(mockCvs, mockContext, 100, 100);
      // drawImage should NOT be called — nothing to do
      expect(mockContext.drawImage).not.toHaveBeenCalled();
    });

    it('just resizes when preserveContent is false', (): void => {
      const mockCvs = createMockCanvas();
      const mockContext = createMockCtx();
      mockCvs.width = 100;
      mockCvs.height = 100;
      viz.testResizeCanvasPreserving(mockCvs, mockContext, 200, 200, false);
      expect(mockCvs.width).toBe(200);
      expect(mockCvs.height).toBe(200);
      expect(mockContext.drawImage).not.toHaveBeenCalled();
    });

    it('just resizes when old canvas was empty (0x0)', (): void => {
      const mockCvs = createMockCanvas();
      const mockContext = createMockCtx();
      mockCvs.width = 0;
      mockCvs.height = 0;
      viz.testResizeCanvasPreserving(mockCvs, mockContext, 200, 200, true);
      expect(mockCvs.width).toBe(200);
      expect(mockCvs.height).toBe(200);
      expect(mockContext.drawImage).not.toHaveBeenCalled();
    });

    it('preserves content when dimensions change', (): void => {
      const mockCvs = createMockCanvas();
      const mockContext = createMockCtx();
      mockCvs.width = 100;
      mockCvs.height = 100;
      viz.testResizeCanvasPreserving(mockCvs, mockContext, 200, 200, true);
      expect(mockCvs.width).toBe(200);
      expect(mockCvs.height).toBe(200);
      // Should draw the preserved content
      expect(mockContext.drawImage).toHaveBeenCalled();
      expect(mockContext.imageSmoothingEnabled).toBe(true);
      expect(mockContext.imageSmoothingQuality).toBe('high');
    });
  });

  // ==========================================================================
  // buildSmoothPath
  // ==========================================================================

  describe('buildSmoothPath', (): void => {
    it('draws straight lines when smoothing is 0', (): void => {
      viz.setWaveformSmoothing(0);
      const ctx = createMockCtx();
      const points = [{x: 0, y: 0}, {x: 50, y: 100}, {x: 100, y: 0}];
      viz.testBuildSmoothPath(ctx, points);

      expect(ctx.beginPath).toHaveBeenCalled();
      expect(ctx.moveTo).toHaveBeenCalledWith(0, 0);
      expect(ctx.lineTo).toHaveBeenCalledTimes(2);
      expect(ctx.quadraticCurveTo).not.toHaveBeenCalled();
    });

    it('draws curves when smoothing is > 0', (): void => {
      viz.setWaveformSmoothing(1);
      const ctx = createMockCtx();
      const points = [{x: 0, y: 0}, {x: 50, y: 100}, {x: 100, y: 0}];
      viz.testBuildSmoothPath(ctx, points);

      expect(ctx.beginPath).toHaveBeenCalled();
      expect(ctx.moveTo).toHaveBeenCalledWith(0, 0);
      expect(ctx.quadraticCurveTo).toHaveBeenCalled();
    });

    it('respects numPoints parameter', (): void => {
      viz.setWaveformSmoothing(0);
      const ctx = createMockCtx();
      const points = [{x: 0, y: 0}, {x: 50, y: 100}, {x: 100, y: 0}, {x: 150, y: 50}];
      viz.testBuildSmoothPath(ctx, points, 2); // only 2 segments (3 points)

      expect(ctx.moveTo).toHaveBeenCalledWith(0, 0);
      expect(ctx.lineTo).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // destroy
  // ==========================================================================

  describe('destroy', (): void => {
    it('can be called without error', (): void => {
      expect((): void => viz.destroy()).not.toThrow();
    });
  });

  // ==========================================================================
  // draw (concrete subclass)
  // ==========================================================================

  describe('draw', (): void => {
    it('increments draw count and calls updateFade', (): void => {
      viz.draw();
      expect(viz.drawCallCount).toBe(1);
    });
  });

  // ==========================================================================
  // Construction failures
  // ==========================================================================

  describe('construction without a 2D context', (): void => {
    it('throws when the canvas cannot supply a 2D context', (): void => {
      const contextless: HTMLCanvasElement = {
        width: 800,
        height: 600,
        getContext: vi.fn().mockReturnValue(null),
      } as unknown as HTMLCanvasElement;

      expect((): TestCanvas2DVisualization => new TestCanvas2DVisualization({canvas: contextless, analyser})).toThrow(
        'Failed to get 2D context'
      );
    });
  });

  // ==========================================================================
  // setStrobeFrequency / getStrobeFrequency
  // ==========================================================================

  describe('setStrobeFrequency', (): void => {
    it('defaults to 5 Hz', (): void => {
      expect(viz.getStrobeFrequency()).toBe(5);
    });

    it('sets strobe frequency to a valid value', (): void => {
      viz.setStrobeFrequency(12);
      expect(viz.getStrobeFrequency()).toBe(12);
    });

    it('clamps to 1 at lower bound', (): void => {
      viz.setStrobeFrequency(0);
      expect(viz.getStrobeFrequency()).toBe(1);
    });

    it('clamps to 20 at upper bound', (): void => {
      viz.setStrobeFrequency(60);
      expect(viz.getStrobeFrequency()).toBe(20);
    });
  });

  // ==========================================================================
  // setArtworkUrl
  // ==========================================================================

  describe('setArtworkUrl', (): void => {
    it('draws nothing by default, since only artwork visualizations use it', (): void => {
      viz.setArtworkUrl('media://artwork/1');
      viz.setArtworkUrl(null);

      expect(viz.testCtx.drawImage).not.toHaveBeenCalled();
      expect(viz.testCtx.clearRect).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Fade timing and isIdle (controlled clock)
  // ==========================================================================

  describe('fade timing', (): void => {
    let now: number;
    let timed: TestCanvas2DVisualization;

    beforeEach((): void => {
      now = 10_000;
      vi.spyOn(performance, 'now').mockImplementation((): number => now);
      timed = new TestCanvas2DVisualization({canvas: createMockCanvas(), analyser});
    });

    it('starts fully faded out', (): void => {
      expect(timed.testFadeAlpha).toBe(1);
    });

    it('fades in over 500ms of playback', (): void => {
      timed.setPlaying(true);
      timed.testFadeAlpha = 1;

      now += 250;
      timed.testUpdateFade();

      expect(timed.testFadeAlpha).toBeCloseTo(0.5, 10);
    });

    it('is fully faded in after 500ms of playback', (): void => {
      timed.setPlaying(true);
      timed.testFadeAlpha = 1;

      now += 500;
      timed.testUpdateFade();

      expect(timed.testFadeAlpha).toBe(0);
    });

    it('fades out over 5000ms once playback stops', (): void => {
      timed.setPlaying(true);
      timed.setPlaying(false);

      now += 1000;
      timed.testUpdateFade();

      expect(timed.testFadeAlpha).toBeCloseTo(0.2, 10);
    });

    it('is fully faded out 5000ms after playback stops', (): void => {
      timed.setPlaying(true);
      timed.setPlaying(false);

      now += 5000;
      timed.testUpdateFade();

      expect(timed.testFadeAlpha).toBe(1);
    });

    it('fades by elapsed time, not by the number of frames drawn', (): void => {
      const manyFrames: TestCanvas2DVisualization = new TestCanvas2DVisualization({canvas: createMockCanvas(), analyser});
      timed.setPlaying(true);
      timed.setPlaying(false);
      manyFrames.setPlaying(true);
      manyFrames.setPlaying(false);

      for (let i: number = 0; i < 100; i++) {
        now += 20;
        manyFrames.testUpdateFade();
      }
      timed.testUpdateFade();

      expect(manyFrames.testFadeAlpha).toBeCloseTo(0.4, 10);
      expect(timed.testFadeAlpha).toBeCloseTo(0.4, 10);
    });

    it('measures each fade step from the previous frame', (): void => {
      timed.setPlaying(true);
      timed.setPlaying(false);
      now += 1000;
      timed.testUpdateFade();

      now += 1000;
      timed.testUpdateFade();

      expect(timed.testFadeAlpha).toBeCloseTo(0.4, 10);
    });

    it('does not count time spent idle towards the fade-in when playback starts', (): void => {
      now += 60_000; // The render loop skips draw() while idle, so the frame clock is stale.
      timed.setPlaying(true);
      timed.testFadeAlpha = 1;

      now += 100;
      timed.testUpdateFade();

      expect(timed.testFadeAlpha).toBeCloseTo(0.8, 10);
    });

    it('does not move the fade when no time has passed', (): void => {
      timed.setPlaying(true);
      timed.setPlaying(false);
      timed.testFadeAlpha = 0.3;

      timed.testUpdateFade();

      expect(timed.testFadeAlpha).toBe(0.3);
    });

    describe('isIdle', (): void => {
      it('is idle before playback has ever started', (): void => {
        expect(timed.isIdle()).toBe(true);
      });

      it('is not idle as soon as playback starts', (): void => {
        timed.setPlaying(true);

        expect(timed.isIdle()).toBe(false);
      });

      it('is never idle during playback, even if the frame is fully faded', (): void => {
        timed.setPlaying(true);
        timed.testFadeAlpha = 1;

        expect(timed.isIdle()).toBe(false);
      });

      it('is not idle the moment playback stops', (): void => {
        timed.setPlaying(true);
        timed.setPlaying(false);

        expect(timed.isIdle()).toBe(false);
      });

      it('is not idle part-way through the fade-out', (): void => {
        timed.setPlaying(true);
        timed.setPlaying(false);

        now += 4999;
        timed.testUpdateFade();

        expect(timed.isIdle()).toBe(false);
      });

      it('is idle once the fade-out has completed', (): void => {
        timed.setPlaying(true);
        timed.setPlaying(false);

        now += 5000;
        timed.testUpdateFade();

        expect(timed.isIdle()).toBe(true);
      });

      it('stops being idle when playback resumes', (): void => {
        timed.setPlaying(true);
        timed.setPlaying(false);
        now += 5000;
        timed.testUpdateFade();

        timed.setPlaying(true);

        expect(timed.isIdle()).toBe(false);
      });
    });
  });

  // ==========================================================================
  // applyFadeOverlay strength
  // ==========================================================================

  describe('applyFadeOverlay strength', (): void => {
    it('erases with an opacity equal to the fade level', (): void => {
      viz.testFadeAlpha = 0.25;

      viz.testApplyFadeOverlay();

      expect(viz.testCtx.fillStyle).toBe('rgba(0, 0, 0, 0.25)');
    });
  });

  // ==========================================================================
  // resize with preserveContentOnResize (dimensions changed)
  // ==========================================================================

  describe('resize preserving content across a change of size', (): void => {
    beforeEach((): void => {
      viz.testPreserveContentOnResize = true;
    });

    it('snapshots the canvas and redraws it scaled to the new size once a frame has been drawn', (): void => {
      viz.testHasDrawn = true;

      viz.resize(400, 300);

      const snapshot: HTMLCanvasElement = vi.mocked(document.createElement).mock.results[0].value as HTMLCanvasElement;
      const snapshotCtx: CanvasRenderingContext2D = snapshot.getContext('2d') as CanvasRenderingContext2D;
      expect([snapshot.width, snapshot.height]).toEqual([800, 600]);
      expect(snapshotCtx.drawImage).toHaveBeenCalledWith(canvas, 0, 0);
      expect(viz.testCtx.drawImage).toHaveBeenCalledWith(snapshot, 0, 0, 800, 600, 0, 0, 400, 300);
    });

    it('redraws the snapshot with high-quality smoothing', (): void => {
      viz.testHasDrawn = true;

      viz.resize(400, 300);

      expect(viz.testCtx.imageSmoothingEnabled).toBe(true);
      expect(viz.testCtx.imageSmoothingQuality).toBe('high');
    });

    it('updates the canvas size and calls onResize after preserving', (): void => {
      viz.testHasDrawn = true;

      viz.resize(400, 300);

      expect([canvas.width, canvas.height]).toEqual([400, 300]);
      expect(viz.resizeCount).toBe(1);
    });

    it('resizes without a snapshot when nothing has been drawn yet', (): void => {
      viz.resize(400, 300);

      expect(document.createElement).not.toHaveBeenCalled();
      expect(viz.testCtx.drawImage).not.toHaveBeenCalled();
      expect([canvas.width, canvas.height]).toEqual([400, 300]);
      expect(viz.resizeCount).toBe(1);
    });

    it('resizes without a snapshot when the canvas previously had no area', (): void => {
      viz.testHasDrawn = true;
      canvas.width = 0;
      canvas.height = 0;

      viz.resize(400, 300);

      expect(document.createElement).not.toHaveBeenCalled();
      expect([canvas.width, canvas.height]).toEqual([400, 300]);
      expect(viz.resizeCount).toBe(1);
    });
  });

  // ==========================================================================
  // applyPersistenceFade
  // ==========================================================================

  describe('applyPersistenceFade', (): void => {
    it('erases the whole canvas at the given rate at default trail intensity', (): void => {
      viz.resize(320, 240);

      viz.testApplyPersistenceFade(0.04);

      expect(viz.testCtx.globalCompositeOperation).toBe('destination-out');
      expect(viz.testCtx.fillStyle).toBe('rgba(0, 0, 0, 0.04)');
      expect(viz.testCtx.fillRect).toHaveBeenCalledWith(0, 0, 320, 240);
    });

    it('erases twice as fast at minimum trail intensity', (): void => {
      viz.setTrailIntensity(0);

      viz.testApplyPersistenceFade(0.04);

      expect(viz.testCtx.fillStyle).toBe('rgba(0, 0, 0, 0.08)');
    });

    it('erases half as fast at maximum trail intensity', (): void => {
      viz.setTrailIntensity(1);

      viz.testApplyPersistenceFade(0.04);

      expect(viz.testCtx.fillStyle).toBe('rgba(0, 0, 0, 0.02)');
    });

    it('wraps the erase in save and restore so the composite mode does not leak', (): void => {
      viz.testApplyPersistenceFade(0.04);

      expect(viz.testCtx.save).toHaveBeenCalledTimes(1);
      expect(viz.testCtx.restore).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // periodicClearLowAlpha cadence
  // ==========================================================================

  describe('periodicClearLowAlpha', (): void => {
    /** Calls periodicClearLowAlpha(interval) once per frame and returns how many frames triggered a readback. */
    function countClears(frames: number, interval: number): number {
      for (let i: number = 0; i < frames; i++) {
        viz.testPeriodicClearLowAlpha(interval);
      }
      return vi.mocked(viz.testCtx.getImageData).mock.calls.length;
    }

    it('does not clear before the interval has elapsed', (): void => {
      viz.resize(800, 600);

      expect(countClears(9, 10)).toBe(0);
    });

    it('clears on the frame that completes the interval', (): void => {
      viz.resize(800, 600);

      expect(countClears(10, 10)).toBe(1);
    });

    it('keeps clearing once per interval', (): void => {
      viz.resize(800, 600);

      expect(countClears(35, 10)).toBe(3);
    });

    it('reads back the whole canvas', (): void => {
      viz.resize(800, 600);

      countClears(10, 10);

      expect(viz.testCtx.getImageData).toHaveBeenCalledWith(0, 0, 800, 600);
    });

    it('uses the interval as written at exactly 1080p', (): void => {
      viz.resize(1920, 1080);

      expect(countClears(10, 10)).toBe(1);
    });

    it('doubles the interval as soon as the canvas exceeds 1080p', (): void => {
      viz.resize(1921, 1080);

      expect(countClears(19, 10)).toBe(0);
      expect(countClears(1, 10)).toBe(1);
    });

    it('quadruples the interval at 4K', (): void => {
      viz.resize(3840, 2160);

      expect(countClears(39, 10)).toBe(0);
      expect(countClears(1, 10)).toBe(1);
    });

    it('stretches the interval sixteen-fold at 8K', (): void => {
      viz.resize(7680, 4320);

      expect(countClears(159, 10)).toBe(0);
      expect(countClears(1, 10)).toBe(1);
    });

    it('never reads back a canvas with no area', (): void => {
      viz.resize(0, 0);

      expect(countClears(50, 10)).toBe(0);
    });
  });

  // ==========================================================================
  // getSurfaceSize
  // ==========================================================================

  describe('getSurfaceSize', (): void => {
    it('returns the logical size when it is within the budget', (): void => {
      expect(viz.testGetSurfaceSize(800, 600, 1_000_000)).toEqual({width: 800, height: 600});
    });

    it('returns the logical size when it is exactly on the budget', (): void => {
      expect(viz.testGetSurfaceSize(1000, 1000, 1_000_000)).toEqual({width: 1000, height: 1000});
    });

    it('scales both dimensions down to meet the budget', (): void => {
      // 4K is four times a 1080p budget, so each side halves.
      expect(viz.testGetSurfaceSize(3840, 2160, 1920 * 1080)).toEqual({width: 1920, height: 1080});
    });

    it('preserves the aspect ratio when scaling down', (): void => {
      const size: {width: number; height: number} = viz.testGetSurfaceSize(4000, 1000, 250_000);

      expect(size).toEqual({width: 1000, height: 250});
    });

    it('never returns a dimension below one pixel', (): void => {
      const size: {width: number; height: number} = viz.testGetSurfaceSize(10_000, 2, 100);

      expect(size.height).toBe(1);
      expect(size.width).toBeGreaterThanOrEqual(1);
    });

    it('returns an empty logical size unchanged', (): void => {
      expect(viz.testGetSurfaceSize(0, 0, 100)).toEqual({width: 0, height: 0});
    });
  });

  // ==========================================================================
  // applySurfaceTransform
  // ==========================================================================

  describe('applySurfaceTransform', (): void => {
    it('scales logical coordinates onto the backing store', (): void => {
      const surface: OffscreenCanvasPair = createMockPair();
      surface.canvas.width = 480;
      surface.canvas.height = 270;
      const ctx: CanvasRenderingContext2D = {...surface.ctx, canvas: surface.canvas} as CanvasRenderingContext2D;

      viz.testApplySurfaceTransform(ctx, 1920, 1080);

      expect(ctx.setTransform).toHaveBeenCalledWith(0.25, 0, 0, 0.25, 0, 0);
    });

    it('scales each axis independently', (): void => {
      const surface: OffscreenCanvasPair = createMockPair();
      surface.canvas.width = 400;
      surface.canvas.height = 100;
      const ctx: CanvasRenderingContext2D = {...surface.ctx, canvas: surface.canvas} as CanvasRenderingContext2D;

      viz.testApplySurfaceTransform(ctx, 800, 400);

      expect(ctx.setTransform).toHaveBeenCalledWith(0.5, 0, 0, 0.25, 0, 0);
    });

    it('leaves the transform alone for an empty logical area', (): void => {
      const surface: OffscreenCanvasPair = createMockPair();
      const ctx: CanvasRenderingContext2D = {...surface.ctx, canvas: surface.canvas} as CanvasRenderingContext2D;

      viz.testApplySurfaceTransform(ctx, 0, 1080);
      viz.testApplySurfaceTransform(ctx, 1920, 0);

      expect(ctx.setTransform).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // copySurface
  // ==========================================================================

  describe('copySurface', (): void => {
    it('replaces the destination with the source, pixel for pixel', (): void => {
      const destination: OffscreenCanvasPair = createMockPair();
      const source: HTMLCanvasElement = createMockCanvas();

      viz.testCopySurface(destination.ctx, source);

      expect(destination.ctx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
      expect(destination.ctx.globalCompositeOperation).toBe('copy');
      expect(destination.ctx.drawImage).toHaveBeenCalledWith(source, 0, 0);
    });

    it('restores the destination state after the copy', (): void => {
      const destination: OffscreenCanvasPair = createMockPair();
      const order: string[] = [];
      vi.mocked(destination.ctx.save).mockImplementation((): void => { order.push('save'); });
      vi.mocked(destination.ctx.drawImage).mockImplementation((): void => { order.push('drawImage'); });
      vi.mocked(destination.ctx.restore).mockImplementation((): void => { order.push('restore'); });

      viz.testCopySurface(destination.ctx, createMockCanvas());

      expect(order).toEqual(['save', 'drawImage', 'restore']);
    });
  });

  // ==========================================================================
  // drawBloom
  // ==========================================================================

  describe('drawBloom', (): void => {
    let bloom: OffscreenCanvasPair;
    let source: HTMLCanvasElement;

    beforeEach((): void => {
      bloom = createMockPair();
      source = createMockCanvas();
      viz.resize(800, 600);
    });

    it('sizes the intermediate to the given fraction of the canvas', (): void => {
      viz.testDrawBloom(bloom, source, 20, 0.6, 0.25);

      expect([bloom.canvas.width, bloom.canvas.height]).toEqual([200, 150]);
    });

    it('never sizes the intermediate below one pixel', (): void => {
      viz.testDrawBloom(bloom, source, 20, 0.6, 0.0001);

      expect([bloom.canvas.width, bloom.canvas.height]).toEqual([1, 1]);
    });

    it('does not resize an intermediate that is already the right size', (): void => {
      // Assigning a canvas dimension reallocates and clears it, even to the same value.
      const widthWrites: number[] = [];
      let width: number = 200;
      bloom.canvas.height = 150;
      Object.defineProperty(bloom.canvas, 'width', {
        get: (): number => width,
        set: (value: number): void => {
          width = value;
          widthWrites.push(value);
        },
      });

      viz.testDrawBloom(bloom, source, 20, 0.6, 0.25);

      expect(widthWrites).toEqual([]);
    });

    it('blurs the source into the intermediate with the radius scaled to match', (): void => {
      let filterAtDraw: string = '';
      vi.mocked(bloom.ctx.drawImage).mockImplementation((): void => { filterAtDraw = bloom.ctx.filter; });

      viz.testDrawBloom(bloom, source, 20, 0.6, 0.25);

      expect(filterAtDraw).toBe('blur(5px)');
      expect(bloom.ctx.globalCompositeOperation).toBe('copy');
      expect(bloom.ctx.drawImage).toHaveBeenCalledWith(source, 0, 0, 200, 150);
    });

    it('adds the blurred intermediate over the full canvas at the given strength', (): void => {
      viz.testDrawBloom(bloom, source, 20, 0.6, 0.25);

      expect(viz.testCtx.globalCompositeOperation).toBe('lighter');
      expect(viz.testCtx.globalAlpha).toBe(0.6);
      expect(viz.testCtx.drawImage).toHaveBeenCalledWith(bloom.canvas, 0, 0, 800, 600);
    });
  });

  // ==========================================================================
  // applyDirectionalZoom
  // ==========================================================================

  describe('applyDirectionalZoom', (): void => {
    let trail: OffscreenCanvasPair;
    let temp: OffscreenCanvasPair;

    beforeEach((): void => {
      trail = createMockPair();
      temp = createMockPair();
      viz.resize(800, 600);
    });

    it('copies the trail to the temp canvas before clearing it', (): void => {
      const order: string[] = [];
      vi.mocked(temp.ctx.drawImage).mockImplementation((): void => { order.push('copy to temp'); });
      vi.mocked(trail.ctx.clearRect).mockImplementation((): void => { order.push('clear trail'); });
      vi.mocked(trail.ctx.drawImage).mockImplementation((): void => { order.push('draw back'); });

      viz.testApplyDirectionalZoom(trail, temp, 400, 300, 0.025, 1.03);

      expect(order).toEqual(['copy to temp', 'clear trail', 'draw back']);
      expect(temp.ctx.clearRect).toHaveBeenCalledWith(0, 0, 800, 600);
      expect(temp.ctx.drawImage).toHaveBeenCalledWith(trail.canvas, 0, 0);
      expect(trail.ctx.clearRect).toHaveBeenCalledWith(0, 0, 800, 600);
    });

    it('draws the trail back scaled about the zoom centre', (): void => {
      viz.testApplyDirectionalZoom(trail, temp, 400, 300, 0.025, 1.03);

      expect(vi.mocked(trail.ctx.translate).mock.calls).toEqual([[400, 300], [-400, -300]]);
      expect(trail.ctx.scale).toHaveBeenCalledWith(1.03, 1.03);
      expect(trail.ctx.drawImage).toHaveBeenCalledWith(temp.canvas, 0, 0);
    });

    it('snaps a fractional zoom centre to whole pixels', (): void => {
      viz.testApplyDirectionalZoom(trail, temp, 400.7, 300.2, 0.025, 1.03);

      expect(vi.mocked(trail.ctx.translate).mock.calls).toEqual([[400, 300], [-400, -300]]);
    });

    it('dims the trail by the fade rate at default trail intensity', (): void => {
      viz.testApplyDirectionalZoom(trail, temp, 400, 300, 0.025, 1.03);

      expect(trail.ctx.globalAlpha).toBeCloseTo(0.975, 10);
    });

    it('dims the trail faster at minimum trail intensity', (): void => {
      viz.setTrailIntensity(0);

      viz.testApplyDirectionalZoom(trail, temp, 400, 300, 0.025, 1.03);

      expect(trail.ctx.globalAlpha).toBeCloseTo(0.95, 10);
    });

    it('dims the trail more slowly at maximum trail intensity', (): void => {
      viz.setTrailIntensity(1);

      viz.testApplyDirectionalZoom(trail, temp, 400, 300, 0.025, 1.03);

      expect(trail.ctx.globalAlpha).toBeCloseTo(0.9875, 10);
    });

    it('does not rotate the trail unless asked', (): void => {
      viz.testApplyDirectionalZoom(trail, temp, 400, 300, 0.025, 1.03);

      expect(trail.ctx.rotate).not.toHaveBeenCalled();
    });

    it('turns the trail by the given rotation', (): void => {
      viz.testApplyDirectionalZoom(trail, temp, 400, 300, 0.025, 1.03, 0.01);

      expect(trail.ctx.rotate).toHaveBeenCalledWith(0.01);
    });
  });

  // ==========================================================================
  // drawPathWithLayers
  // ==========================================================================

  describe('drawPathWithLayers', (): void => {
    const MAIN: string = 'rgb(0, 255, 100)';
    const GLOW: string = 'rgba(0, 255, 100, 0.8)';
    const HIGHLIGHT: string = 'rgba(150, 255, 180, 0.6)';

    it('builds and strokes the path once per layer: glow, main and highlight', (): void => {
      const buildPath = vi.fn();
      const paints: PaintSnapshot[] = recordPaints(viz.testCtx);

      viz.testDrawPathWithLayers(buildPath, MAIN, GLOW, HIGHLIGHT);

      expect(buildPath).toHaveBeenCalledTimes(3);
      // The glow stroke is the glow colour at 37.5% of its opacity.
      expect(paints.map((paint: PaintSnapshot): unknown => paint.strokeStyle)).toEqual(['rgba(0, 255, 100, 0.30)', MAIN, HIGHLIGHT]);
    });

    it('omits the highlight layer when no highlight colour is given', (): void => {
      const buildPath = vi.fn();
      const paints: PaintSnapshot[] = recordPaints(viz.testCtx);

      viz.testDrawPathWithLayers(buildPath, MAIN, GLOW);

      expect(buildPath).toHaveBeenCalledTimes(2);
      expect(paints.map((paint: PaintSnapshot): unknown => paint.strokeStyle)).toEqual(['rgba(0, 255, 100, 0.30)', MAIN]);
    });

    it('strokes a wide glow, the main line at the line width and a thin highlight', (): void => {
      const paints: PaintSnapshot[] = recordPaints(viz.testCtx);
      viz.setLineWidth(3);

      viz.testDrawPathWithLayers(vi.fn(), MAIN, GLOW, HIGHLIGHT);

      expect(paints.map((paint: PaintSnapshot): number => paint.lineWidth)).toEqual([7, 3, 1]);
    });

    it('honours custom glow and highlight widths', (): void => {
      const paints: PaintSnapshot[] = recordPaints(viz.testCtx);

      viz.testDrawPathWithLayers(vi.fn(), MAIN, GLOW, HIGHLIGHT, {glowLineWidthOffset: 10, highlightLineWidth: 0.5});

      expect(paints.map((paint: PaintSnapshot): number => paint.lineWidth)).toEqual([12, 2, 0.5]);
    });

    it('shadows the glow layer with the glow colour, blurred in proportion to glow intensity', (): void => {
      const paints: PaintSnapshot[] = recordPaints(viz.testCtx);
      viz.setGlowIntensity(0.5);

      viz.testDrawPathWithLayers(vi.fn(), MAIN, GLOW, HIGHLIGHT);

      // Default base blur of 12, halved.
      expect(paints[0].shadowBlur).toBe(6);
      expect(paints[0].shadowColor).toBe(GLOW);
    });

    it('honours a custom base glow blur', (): void => {
      const paints: PaintSnapshot[] = recordPaints(viz.testCtx);
      viz.setGlowIntensity(1);

      viz.testDrawPathWithLayers(vi.fn(), MAIN, GLOW, HIGHLIGHT, {baseGlowBlur: 20});

      expect(paints[0].shadowBlur).toBe(20);
    });

    it('confines the glow shadow to the glow layer with save and restore', (): void => {
      const order: string[] = [];
      vi.mocked(viz.testCtx.save).mockImplementation((): void => { order.push('save'); });
      vi.mocked(viz.testCtx.restore).mockImplementation((): void => { order.push('restore'); });
      vi.mocked(viz.testCtx.stroke).mockImplementation((): void => { order.push('stroke'); });

      viz.testDrawPathWithLayers(vi.fn(), MAIN, GLOW, HIGHLIGHT);

      expect(order).toEqual(['save', 'stroke', 'restore', 'stroke', 'stroke']);
    });

    it('uses a glow colour without an alpha channel as it is', (): void => {
      const paints: PaintSnapshot[] = recordPaints(viz.testCtx);

      viz.testDrawPathWithLayers(vi.fn(), MAIN, 'red');

      expect(paints[0].strokeStyle).toBe('red');
    });

    it('rounds the stroke ends and joins', (): void => {
      viz.testDrawPathWithLayers(vi.fn(), MAIN, GLOW);

      expect(viz.testCtx.lineCap).toBe('round');
      expect(viz.testCtx.lineJoin).toBe('round');
    });

    it('closes the path in every layer when asked', (): void => {
      viz.testDrawPathWithLayers(vi.fn(), MAIN, GLOW, HIGHLIGHT, {closePath: true});

      expect(viz.testCtx.closePath).toHaveBeenCalledTimes(3);
    });

    it('leaves the path open by default', (): void => {
      viz.testDrawPathWithLayers(vi.fn(), MAIN, GLOW, HIGHLIGHT);

      expect(viz.testCtx.closePath).not.toHaveBeenCalled();
    });

    it('fills instead of stroking when asked', (): void => {
      const paints: PaintSnapshot[] = recordPaints(viz.testCtx);

      viz.testDrawPathWithLayers(vi.fn(), MAIN, GLOW, HIGHLIGHT, {fill: true});

      expect(viz.testCtx.fill).toHaveBeenCalledTimes(3);
      expect(viz.testCtx.stroke).not.toHaveBeenCalled();
      expect(paints.map((paint: PaintSnapshot): unknown => paint.fillStyle)).toEqual(['rgba(0, 255, 100, 0.30)', MAIN, HIGHLIGHT]);
    });

    it('draws on the context it is given rather than its own', (): void => {
      const other: CanvasRenderingContext2D = createMockCtx();

      viz.testDrawPathWithLayers(vi.fn(), MAIN, GLOW, HIGHLIGHT, {ctx: other});

      expect(other.stroke).toHaveBeenCalledTimes(3);
      expect(viz.testCtx.stroke).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // drawPointsWithLayers
  // ==========================================================================

  describe('drawPointsWithLayers', (): void => {
    const POINTS: ReadonlyArray<{x: number; y: number}> = [{x: 0, y: 0}, {x: 10, y: 5}, {x: 20, y: 0}, {x: 30, y: 5}];

    it('draws a polyline through the points in each of the three layers', (): void => {
      viz.testDrawPointsWithLayers(POINTS, 'rgb(1, 2, 3)', 'rgba(1, 2, 3, 0.8)', 'white');

      const oneLayerMoves: number[][] = [[0, 0]];
      const oneLayerLines: number[][] = [[10, 5], [20, 0], [30, 5]];
      expect(vi.mocked(viz.testCtx.moveTo).mock.calls).toEqual([...oneLayerMoves, ...oneLayerMoves, ...oneLayerMoves]);
      expect(vi.mocked(viz.testCtx.lineTo).mock.calls).toEqual([...oneLayerLines, ...oneLayerLines, ...oneLayerLines]);
      expect(viz.testCtx.stroke).toHaveBeenCalledTimes(3);
    });

    it('draws only the requested range of points', (): void => {
      viz.testDrawPointsWithLayers(POINTS, 'rgb(1, 2, 3)', 'rgba(1, 2, 3, 0.8)', undefined, {startIndex: 1, endIndex: 3});

      expect(vi.mocked(viz.testCtx.moveTo).mock.calls).toEqual([[10, 5], [10, 5]]);
      expect(vi.mocked(viz.testCtx.lineTo).mock.calls).toEqual([[20, 0], [20, 0]]);
    });

    it('draws nothing for fewer than two points', (): void => {
      viz.testDrawPointsWithLayers([{x: 5, y: 5}], 'rgb(1, 2, 3)', 'rgba(1, 2, 3, 0.8)', 'white');

      expect(viz.testCtx.beginPath).not.toHaveBeenCalled();
      expect(viz.testCtx.stroke).not.toHaveBeenCalled();
    });

    it('draws nothing when the requested range holds fewer than two points', (): void => {
      viz.testDrawPointsWithLayers(POINTS, 'rgb(1, 2, 3)', 'rgba(1, 2, 3, 0.8)', 'white', {startIndex: 2, endIndex: 3});

      expect(viz.testCtx.stroke).not.toHaveBeenCalled();
    });

    it('draws on the context it is given rather than its own', (): void => {
      const other: CanvasRenderingContext2D = createMockCtx();

      viz.testDrawPointsWithLayers(POINTS, 'rgb(1, 2, 3)', 'rgba(1, 2, 3, 0.8)', undefined, {ctx: other});

      expect(other.moveTo).toHaveBeenCalledWith(0, 0);
      expect(viz.testCtx.moveTo).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // buildSmoothPath geometry
  // ==========================================================================

  describe('buildSmoothPath geometry', (): void => {
    const POINTS: Array<{x: number; y: number}> = [{x: 0, y: 0}, {x: 100, y: 40}, {x: 200, y: 0}];

    it('visits every point in order with straight lines when smoothing is 0', (): void => {
      viz.setWaveformSmoothing(0);
      const ctx: CanvasRenderingContext2D = createMockCtx();

      viz.testBuildSmoothPath(ctx, POINTS);

      expect(vi.mocked(ctx.lineTo).mock.calls).toEqual([[100, 40], [200, 0]]);
    });

    it('curves to each midpoint using the point itself as the control at full smoothing', (): void => {
      viz.setWaveformSmoothing(1);
      const ctx: CanvasRenderingContext2D = createMockCtx();

      viz.testBuildSmoothPath(ctx, POINTS);

      expect(vi.mocked(ctx.quadraticCurveTo).mock.calls).toEqual([
        [0, 0, 50, 20],
        [100, 40, 150, 20],
      ]);
    });

    it('pulls the control point halfway back to the midpoint at half smoothing', (): void => {
      viz.setWaveformSmoothing(0.5);
      const ctx: CanvasRenderingContext2D = createMockCtx();

      viz.testBuildSmoothPath(ctx, POINTS);

      expect(vi.mocked(ctx.quadraticCurveTo).mock.calls).toEqual([
        [25, 10, 50, 20],
        [125, 30, 150, 20],
      ]);
    });

    it('finishes a smoothed path on the last point', (): void => {
      viz.setWaveformSmoothing(1);
      const ctx: CanvasRenderingContext2D = createMockCtx();

      viz.testBuildSmoothPath(ctx, POINTS);

      expect(vi.mocked(ctx.lineTo).mock.calls).toEqual([[200, 0]]);
    });

    it('starts a straight path from the given start index', (): void => {
      viz.setWaveformSmoothing(0);
      const ctx: CanvasRenderingContext2D = createMockCtx();

      viz.testBuildSmoothPathFrom(ctx, POINTS, 2, 1);

      expect(ctx.moveTo).toHaveBeenCalledWith(100, 40);
      expect(vi.mocked(ctx.lineTo).mock.calls).toEqual([[200, 0]]);
    });

    it('starts a smoothed path from the given start index', (): void => {
      viz.setWaveformSmoothing(1);
      const ctx: CanvasRenderingContext2D = createMockCtx();

      viz.testBuildSmoothPathFrom(ctx, POINTS, 2, 1);

      expect(ctx.moveTo).toHaveBeenCalledWith(100, 40);
      expect(vi.mocked(ctx.quadraticCurveTo).mock.calls).toEqual([[100, 40, 150, 20]]);
    });
  });

  // ==========================================================================
  // WebGLVisualization
  // ==========================================================================

  describe('WebGLVisualization', (): void => {
    it('uses the webgl context when the canvas supplies one', (): void => {
      const gl: WebGLRenderingContext = {getExtension: vi.fn()} as unknown as WebGLRenderingContext;
      const glCanvas: HTMLCanvasElement = createMockGLCanvas({webgl: gl});

      const glViz: TestWebGLVisualization = new TestWebGLVisualization({canvas: glCanvas, analyser});

      expect(glViz.testGl).toBe(gl);
    });

    it('falls back to the experimental-webgl context', (): void => {
      const gl: WebGLRenderingContext = {getExtension: vi.fn()} as unknown as WebGLRenderingContext;
      const glCanvas: HTMLCanvasElement = createMockGLCanvas({'experimental-webgl': gl});

      const glViz: TestWebGLVisualization = new TestWebGLVisualization({canvas: glCanvas, analyser});

      expect(glViz.testGl).toBe(gl);
    });

    it('throws when the canvas cannot supply a WebGL context', (): void => {
      const glCanvas: HTMLCanvasElement = createMockGLCanvas({});

      expect((): TestWebGLVisualization => new TestWebGLVisualization({canvas: glCanvas, analyser})).toThrow(
        'Failed to get WebGL context'
      );
    });

    it('releases the GPU context on destroy', (): void => {
      const loseContext = vi.fn();
      const gl: WebGLRenderingContext = {
        getExtension: vi.fn().mockReturnValue({loseContext}),
      } as unknown as WebGLRenderingContext;
      const glViz: TestWebGLVisualization = new TestWebGLVisualization({canvas: createMockGLCanvas({webgl: gl}), analyser});

      glViz.destroy();

      expect(gl.getExtension).toHaveBeenCalledWith('WEBGL_lose_context');
      expect(loseContext).toHaveBeenCalledTimes(1);
    });

    it('destroys cleanly when the lose-context extension is unavailable', (): void => {
      const gl: WebGLRenderingContext = {
        getExtension: vi.fn().mockReturnValue(null),
      } as unknown as WebGLRenderingContext;
      const glViz: TestWebGLVisualization = new TestWebGLVisualization({canvas: createMockGLCanvas({webgl: gl}), analyser});

      expect((): void => glViz.destroy()).not.toThrow();
      expect(gl.getExtension).toHaveBeenCalledWith('WEBGL_lose_context');
    });

  });

  // ==========================================================================
  // Subclasses that do not override the change hooks
  // ==========================================================================

  describe('a subclass without change hooks', (): void => {
    let plain: TestWebGLVisualization;

    beforeEach((): void => {
      const gl: WebGLRenderingContext = {getExtension: vi.fn()} as unknown as WebGLRenderingContext;
      plain = new TestWebGLVisualization({canvas: createMockGLCanvas({webgl: gl}), analyser});
    });

    it('still applies an FFT size change to the analyser', (): void => {
      plain.setFftSize(512);

      expect(plain.getFftSize()).toBe(512);
      expect(analyser.fftSize).toBe(512);
    });

    it('still records a bar density change', (): void => {
      plain.setBarDensity('high');

      expect(plain.getBarDensity()).toBe('high');
    });

    it('still records bar colour changes', (): void => {
      plain.setBarColorBottom('#010101');
      plain.setBarColorMiddle('#020202');
      plain.setBarColorTop('#030303');

      expect([plain.getBarColorBottom(), plain.getBarColorMiddle(), plain.getBarColorTop()]).toEqual([
        '#010101',
        '#020202',
        '#030303',
      ]);
    });

    it('resizes the canvas without a resize hook', (): void => {
      const gl: WebGLRenderingContext = {getExtension: vi.fn()} as unknown as WebGLRenderingContext;
      const glCanvas: HTMLCanvasElement = createMockGLCanvas({webgl: gl});
      const unhooked: TestWebGLVisualization = new TestWebGLVisualization({canvas: glCanvas, analyser});

      unhooked.resize(1280, 720);

      expect([glCanvas.width, glCanvas.height]).toEqual([1280, 720]);
    });
  });
});

/**
 * @fileoverview Unit tests for visualization base classes.
 *
 * Tests cover:
 * - Visualization (abstract base): sensitivity, trailIntensity, fftSize,
 *   barDensity, lineWidth, glowIntensity, waveformSmoothing, bar colors,
 *   fade logic, resize, hslToRgb, sensitivityFactor, getFadeMultiplier
 * - Canvas2DVisualization: applyFadeOverlay, clearLowAlphaPixels,
 *   resize with preserveContentOnResize, getCachedColor, getColorFromHue,
 *   createOffscreenCanvas
 *
 * A minimal concrete subclass (TestVisualization) is used to test the
 * abstract base classes. Web Audio API and Canvas 2D are mocked.
 *
 * @module app/components/audio/audio-outlet/visualizations/visualization.spec
 */

import {Canvas2DVisualization, Visualization, WebGLVisualization} from './visualization';
import type {VisualizationConfig} from './visualization';

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
  public testCreateOffscreenCanvas(): {canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D} { return this.createOffscreenCanvas(); }
  public testResizeCanvasPreserving(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, w: number, h: number, preserve?: boolean): void {
    this.resizeCanvasPreserving(canvas, ctx, w, h, preserve);
  }
  public testBuildSmoothPath(ctx: CanvasRenderingContext2D, points: Array<{x: number; y: number}>, n?: number): void {
    this.buildSmoothPath(ctx, points, n);
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
});

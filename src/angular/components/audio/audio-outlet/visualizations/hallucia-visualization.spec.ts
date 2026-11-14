/**
 * @fileoverview Unit tests for the Hallucia visualization.
 *
 * Tests cover:
 * - GL setup: programs, shader source, failure handling
 * - Internal surface: sizing, reuse, recreation, ping-pong between frames
 * - Audio: bass envelope, shear pivot, source texture packing
 * - Hue: resting drift, bass-triggered bursts, refractory period, stall clamp
 * - Sensitivity, fade-out, idling, FFT size changes, destroy
 * - Edge inputs: zero-sized canvas, extreme spectra, an analyser with no bins
 *
 * WebGL, the analyser and the clock are faked; see
 * visualization-test-fakes.group2. The shaders themselves never run, so what
 * is asserted is what the visualization hands to the GPU each frame.
 *
 * @module app/components/audio/audio-outlet/visualizations/hallucia-visualization.spec
 */

import {HalluciaVisualization} from './hallucia-visualization';
import {
  BASS_HEAVY_SPECTRUM,
  FULL_SPECTRUM,
  FakeAnalyser,
  FakeWebGL,
  LOUD_WAVEFORM,
  SILENT_SPECTRUM,
  SILENT_WAVEFORM,
  flat,
  installCanvasFakes,
  installFakeClock,
  spike,
} from './visualization-test-fakes.group2';
import type {AnalyserFill, CanvasFakes, FakeClock, RecordedCall} from './visualization-test-fakes.group2';

// ============================================================================
// Helpers
// ============================================================================

const WIDTH: number = 800;
const HEIGHT: number = 600;

/** Internal surface for an 800x600 view: 512 high, width following the aspect ratio. */
const SURFACE_WIDTH: number = 683;
const SURFACE_HEIGHT: number = 512;

/** Hue advance per frame at rest and during a burst, in turns. */
const HUE_DRIFT: number = 0.00035;
const HUE_BURST_RATE: number = 0.022;

/** Sizes of the ping-pong surfaces allocated so far, as [width, height]. */
function surfaceSizes(gl: FakeWebGL): unknown[][] {
  return gl.callsTo('texImage2D')
    .filter((call: RecordedCall): boolean => call.args[8] === null)
    .map((call: RecordedCall): unknown[] => [call.args[3], call.args[4]]);
}

/** The ping-pong textures, in the order they were attached to framebuffers. */
function surfaceTextures(gl: FakeWebGL): unknown[] {
  return gl.callsTo('framebufferTexture2D').map((call: RecordedCall): unknown => call.args[3]);
}

/** The framebuffers bound so far, skipping unbinds. */
function boundFramebuffers(gl: FakeWebGL): unknown[] {
  return gl.callsTo('bindFramebuffer')
    .map((call: RecordedCall): unknown => call.args[1])
    .filter((buffer: unknown): boolean => buffer !== null);
}

/** The RGBA texels most recently uploaded to the source texture. */
function uploadedTexels(gl: FakeWebGL): Uint8Array {
  const uploads: RecordedCall[] = gl.callsTo('texSubImage2D');
  return uploads[uploads.length - 1].args[8] as Uint8Array;
}

// ============================================================================
// Tests
// ============================================================================

describe('HalluciaVisualization', (): void => {
  let fakes: CanvasFakes;
  let clock: FakeClock;
  let analyser: FakeAnalyser;
  let canvas: HTMLCanvasElement;
  let gl: FakeWebGL;

  function create(): HalluciaVisualization {
    return new HalluciaVisualization({canvas, analyser: analyser.node});
  }

  /** Creates a visualization sized to the view with playback running. */
  function createPlaying(): HalluciaVisualization {
    const viz: HalluciaVisualization = create();
    viz.resize(WIDTH, HEIGHT);
    viz.setPlaying(true);
    return viz;
  }

  /** Draws frames a fixed interval apart and returns the hue uploaded by each. */
  function huesOver(viz: HalluciaVisualization, frames: number, intervalMs: number): number[] {
    const hues: number[] = [];
    for (let i: number = 0; i < frames; i++) {
      clock.advance(intervalMs);
      viz.draw();
      hues.push(gl.uniformValue('uHue'));
    }
    return hues;
  }

  /** Whether each frame after the first advanced the hue at the burst rate. */
  function burstFrames(hues: readonly number[]): boolean[] {
    return hues.map((hue: number, index: number): boolean => {
      const previous: number = index === 0 ? 0 : hues[index - 1];
      const step: number = Math.abs(hue - previous);
      return Math.abs(Math.min(step, 1 - step) - HUE_BURST_RATE) < 1e-9;
    });
  }

  beforeEach((): void => {
    clock = installFakeClock();
    fakes = installCanvasFakes();
    analyser = new FakeAnalyser();
    canvas = document.createElement('canvas');
    // Ask for the context up front so a test can configure the fake before construction.
    canvas.getContext('webgl');
    gl = fakes.glFor(canvas);
  });

  afterEach((): void => {
    fakes.restore();
    clock.restore();
    vi.restoreAllMocks();
  });

  describe('construction', (): void => {
    it('identifies itself as Hallucia in the Nostalgia category', (): void => {
      const viz: HalluciaVisualization = create();

      expect(viz.name).toBe('Hallucia');
      expect(viz.category).toBe('Nostalgia');
    });

    it('links a field program and a present program', (): void => {
      create();

      expect(gl.callsTo('createProgram')).toHaveLength(2);
      expect(gl.callsTo('compileShader')).toHaveLength(4);
      expect(gl.callsTo('linkProgram')).toHaveLength(2);
    });

    it('drops its shader references once each program has linked', (): void => {
      create();

      expect(gl.callsTo('deleteShader')).toHaveLength(4);
    });

    it('writes whole-number constants into the shader as float literals', (): void => {
      create();

      const fieldSource: string = gl.callsTo('shaderSource')[1].args[1] as string;
      expect(fieldSource).toContain('TAU / 2.0;');
      expect(fieldSource).toContain('angle -= 0.0 + (energy - uPivot) * 0.09;');
    });

    it('uploads a full-screen quad of two triangles', (): void => {
      create();

      const quad: Float32Array = gl.callsTo('bufferData')[0].args[1] as Float32Array;
      expect(Array.from(quad)).toEqual([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    });

    it('allocates a 512x1 source texture for the audio data', (): void => {
      create();

      const allocation: RecordedCall = gl.callsTo('texImage2D')[0];
      expect(allocation.args.slice(3, 5)).toEqual([512, 1]);
    });

    it('throws when no WebGL context is available', (): void => {
      fakes.refuseContexts = true;

      expect((): HalluciaVisualization => create()).toThrow('Failed to get WebGL context');
    });

    it('throws with the compiler log when a shader fails to compile', (): void => {
      gl.failCompile = true;
      gl.infoLog = 'ERROR: 0:12: syntax error';

      expect((): HalluciaVisualization => create()).toThrow('Failed to compile shader: ERROR: 0:12: syntax error');
      expect(gl.callsTo('deleteShader')).toHaveLength(1);
    });

    it('throws a generic compile error when the driver gives no log', (): void => {
      gl.failCompile = true;
      gl.infoLog = null;

      expect((): HalluciaVisualization => create()).toThrow('Failed to compile shader: unknown error');
    });

    it('throws with the linker log and deletes the program when linking fails', (): void => {
      gl.failLink = true;
      gl.infoLog = 'varying mismatch';

      expect((): HalluciaVisualization => create()).toThrow('Failed to link WebGL program: varying mismatch');
      expect(gl.callsTo('deleteProgram')).toHaveLength(1);
    });

    it('throws a generic link error when the driver gives no log', (): void => {
      gl.failLink = true;
      gl.infoLog = null;

      expect((): HalluciaVisualization => create()).toThrow('Failed to link WebGL program: unknown error');
    });

    it('throws when the context cannot create a program', (): void => {
      gl.refuseProgram = true;

      expect((): HalluciaVisualization => create()).toThrow('Failed to create WebGL program');
    });

    it('throws when the context cannot create a shader', (): void => {
      gl.refuseShader = true;

      expect((): HalluciaVisualization => create()).toThrow('Failed to create WebGL shader');
    });
  });

  describe('internal surface', (): void => {
    it('allocates two surfaces 512 high at the aspect ratio of the view', (): void => {
      const viz: HalluciaVisualization = create();

      viz.resize(WIDTH, HEIGHT);

      expect(surfaceSizes(gl)).toEqual([[SURFACE_WIDTH, SURFACE_HEIGHT], [SURFACE_WIDTH, SURFACE_HEIGHT]]);
      expect(gl.callsTo('createFramebuffer')).toHaveLength(2);
    });

    it('caps the surface width on a very wide view', (): void => {
      const viz: HalluciaVisualization = create();

      viz.resize(4000, 500);

      expect(surfaceSizes(gl)[0]).toEqual([1024, 512]);
    });

    it('narrows the surface on a tall view', (): void => {
      const viz: HalluciaVisualization = create();

      viz.resize(100, 1000);

      expect(surfaceSizes(gl)[0]).toEqual([51, 512]);
    });

    it('keeps the surfaces when the view is resized without changing aspect ratio', (): void => {
      const viz: HalluciaVisualization = create();
      viz.resize(WIDTH, HEIGHT);

      viz.resize(1600, 1200);

      expect(surfaceSizes(gl)).toHaveLength(2);
      expect(gl.callsTo('deleteFramebuffer')).toEqual([]);
    });

    it('releases and reallocates the surfaces when the aspect ratio changes', (): void => {
      const viz: HalluciaVisualization = create();
      viz.resize(WIDTH, HEIGHT);
      const old: unknown[] = surfaceTextures(gl);

      viz.resize(1600, 800);

      expect(gl.callsTo('deleteTexture').map((call: RecordedCall): unknown => call.args[0])).toEqual(old);
      expect(gl.callsTo('deleteFramebuffer')).toHaveLength(2);
      expect(surfaceSizes(gl).slice(2)).toEqual([[1024, 512], [1024, 512]]);
    });

    it('allocates nothing when resized to zero', (): void => {
      const viz: HalluciaVisualization = create();

      viz.resize(0, 0);

      expect(surfaceSizes(gl)).toEqual([]);
    });

    it('clears each new surface so the feedback starts from black', (): void => {
      const viz: HalluciaVisualization = create();

      viz.resize(WIDTH, HEIGHT);

      expect(gl.callsTo('clear')).toHaveLength(2);
    });
  });

  describe('frame', (): void => {
    it('draws nothing and reads no audio on an unsized canvas', (): void => {
      const viz: HalluciaVisualization = create();
      gl.clear();

      viz.draw();

      expect(gl.calls).toEqual([]);
      expect(analyser.spectrumReads).toEqual([]);
    });

    it('runs a field pass at surface size, then a present pass at view size', (): void => {
      const viz: HalluciaVisualization = createPlaying();
      gl.clear();

      viz.draw();

      expect(gl.callsTo('drawArrays')).toHaveLength(2);
      expect(gl.callsTo('viewport').map((call: RecordedCall): readonly unknown[] => call.args)).toEqual([
        [0, 0, SURFACE_WIDTH, SURFACE_HEIGHT],
        [0, 0, WIDTH, HEIGHT],
      ]);
    });

    it('presents to the canvas rather than to a surface', (): void => {
      const viz: HalluciaVisualization = createPlaying();
      gl.clear();

      viz.draw();

      const binds: RecordedCall[] = gl.callsTo('bindFramebuffer');
      expect(binds[binds.length - 1].args[1]).toBeNull();
    });

    it('feeds each frame the previous frame as input and swaps the surfaces', (): void => {
      const viz: HalluciaVisualization = createPlaying();
      const [textureA, textureB]: unknown[] = surfaceTextures(gl);
      const [bufferA, bufferB]: unknown[] = boundFramebuffers(gl);

      gl.clear();
      viz.draw();
      const firstTarget: unknown = boundFramebuffers(gl)[0];
      // Texture binds in a frame: source upload, previous frame, source, presented frame.
      const firstTextures: unknown[] = gl.callsTo('bindTexture').map((call: RecordedCall): unknown => call.args[1]);
      gl.clear();
      viz.draw();
      const secondTarget: unknown = boundFramebuffers(gl)[0];
      const secondTextures: unknown[] = gl.callsTo('bindTexture').map((call: RecordedCall): unknown => call.args[1]);

      expect(firstTarget).toBe(bufferB);
      expect([firstTextures[1], firstTextures[3]]).toEqual([textureA, textureB]);
      expect(secondTarget).toBe(bufferA);
      expect([secondTextures[1], secondTextures[3]]).toEqual([textureB, textureA]);
    });

    it('tells the shader the surface aspect ratio', (): void => {
      const viz: HalluciaVisualization = createPlaying();

      viz.draw();

      expect(gl.uniformValue('uAspect')).toBeCloseTo(SURFACE_WIDTH / SURFACE_HEIGHT, 10);
    });
  });

  describe('bass envelope', (): void => {
    it('stays at zero in silence', (): void => {
      const viz: HalluciaVisualization = createPlaying();

      huesOver(viz, 10, 16);

      expect(gl.uniformValue('uBass')).toBe(0);
    });

    it('moves a fifth of the way toward the bass level each frame', (): void => {
      analyser.spectrum = BASS_HEAVY_SPECTRUM;
      const viz: HalluciaVisualization = createPlaying();

      viz.draw();
      viz.draw();

      // Full-scale bass at the default sensitivity is a level of 0.5.
      const history: number[] = gl.uniformHistory('uBass').map((values: unknown[]): number => values[0] as number);
      expect(history[0]).toBeCloseTo(0.1, 10);
      expect(history[1]).toBeCloseTo(0.18, 10);
    });

    it('settles on the bass level under a sustained note', (): void => {
      analyser.spectrum = BASS_HEAVY_SPECTRUM;
      const viz: HalluciaVisualization = createPlaying();

      huesOver(viz, 100, 16);

      expect(gl.uniformValue('uBass')).toBeCloseTo(0.5, 6);
    });

    it('ignores energy above the lowest 24 bins', (): void => {
      analyser.spectrum = (index: number): number => index >= 24 ? 255 : 0;
      const viz: HalluciaVisualization = createPlaying();

      huesOver(viz, 10, 16);

      expect(gl.uniformValue('uBass')).toBe(0);
    });

    it('scales with sensitivity', (): void => {
      analyser.spectrum = BASS_HEAVY_SPECTRUM;
      const viz: HalluciaVisualization = createPlaying();
      viz.setSensitivity(1);

      viz.draw();

      expect(gl.uniformValue('uBass')).toBeCloseTo(0.4, 10);
    });
  });

  describe('shear pivot', (): void => {
    it('rests on the energy floor in silence, so quiet bands still shear', (): void => {
      const viz: HalluciaVisualization = createPlaying();

      huesOver(viz, 400, 16);

      expect(gl.uniformValue('uPivot')).toBeCloseTo(0.07, 6);
    });

    it('follows the mean band energy slowly', (): void => {
      analyser.spectrum = FULL_SPECTRUM;
      const viz: HalluciaVisualization = createPlaying();

      viz.draw();

      expect(gl.uniformValue('uPivot')).toBeCloseTo(0.05, 10);
    });

    it('averages only the part of the spectrum the radius is mapped across', (): void => {
      // Energy only in the top 40% of bins, which the field never shows.
      analyser.spectrum = (index: number, length: number): number => index >= Math.floor(length * 0.6) ? 255 : 0;
      const viz: HalluciaVisualization = createPlaying();

      viz.draw();

      expect(gl.uniformValue('uPivot')).toBeCloseTo(0.07 * 0.05, 10);
    });
  });

  describe('source texture', (): void => {
    it('packs the waveform into red and the spectrum into green', (): void => {
      // 2048 samples and 1024 bins onto 512 texels: texel i reads sample 4i and bin 2i.
      analyser.waveform = spike(40, 200, 128);
      analyser.spectrum = spike(10);
      const viz: HalluciaVisualization = createPlaying();

      viz.draw();

      const texels: Uint8Array = uploadedTexels(gl);
      expect(texels).toHaveLength(512 * 4);
      expect([texels[10 * 4], texels[11 * 4]]).toEqual([200, 128]);
      expect([texels[5 * 4 + 1], texels[6 * 4 + 1]]).toEqual([255, 0]);
    });

    it('uploads fresh audio every frame', (): void => {
      const viz: HalluciaVisualization = createPlaying();
      viz.draw();
      analyser.spectrum = FULL_SPECTRUM;

      viz.draw();

      expect(uploadedTexels(gl)[1]).toBe(255);
    });

    it('resamples to the texture width after the FFT size changes', (): void => {
      const viz: HalluciaVisualization = createPlaying();
      viz.setFftSize(256);
      // 256 samples onto 512 texels: each sample covers two texels.
      analyser.waveform = spike(3, 200, 128);

      viz.draw();

      const texels: Uint8Array = uploadedTexels(gl);
      expect(analyser.waveformReads).toEqual([256]);
      expect(analyser.spectrumReads).toEqual([128]);
      expect([texels[5 * 4], texels[6 * 4], texels[7 * 4], texels[8 * 4]]).toEqual([128, 200, 200, 128]);
    });

    it('uploads an empty spectrum when the analyser reports no bins', (): void => {
      analyser.fftSize = 0;
      analyser.spectrum = FULL_SPECTRUM;
      const viz: HalluciaVisualization = createPlaying();

      viz.draw();

      const texels: Uint8Array = uploadedTexels(gl);
      expect(gl.uniformValue('uBass')).toBe(0);
      expect(texels.every((value: number): boolean => value === 0)).toBe(true);
      expect(gl.invalidCalls()).toEqual([]);
    });
  });

  describe('hue', (): void => {
    it('drifts slowly while the bass is quiet', (): void => {
      const viz: HalluciaVisualization = createPlaying();

      const hues: number[] = huesOver(viz, 100, 16);

      expect(hues[0]).toBeCloseTo(HUE_DRIFT, 10);
      expect(hues[99]).toBeCloseTo(100 * HUE_DRIFT, 10);
    });

    it('does not burst while the bass stays under the threshold', (): void => {
      // Settles at a bass level of about 0.2, half the threshold.
      analyser.spectrum = flat(100);
      const viz: HalluciaVisualization = createPlaying();

      const hues: number[] = huesOver(viz, 200, 16);

      expect(burstFrames(hues)).not.toContain(true);
    });

    it('rips forward through the colour wheel when the bass crosses the threshold', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.9);
      analyser.spectrum = BASS_HEAVY_SPECTRUM;
      const viz: HalluciaVisualization = createPlaying();
      viz.setSensitivity(1);

      const hues: number[] = huesOver(viz, 3, 16);

      expect(hues[0]).toBeCloseTo(HUE_BURST_RATE, 10);
      expect(hues[2]).toBeCloseTo(3 * HUE_BURST_RATE, 10);
    });

    it('runs the burst backward when the direction roll is low, keeping the hue in range', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      analyser.spectrum = BASS_HEAVY_SPECTRUM;
      const viz: HalluciaVisualization = createPlaying();
      viz.setSensitivity(1);

      const hues: number[] = huesOver(viz, 2, 16);

      expect(hues[0]).toBeCloseTo(1 - HUE_BURST_RATE, 10);
      expect(hues[1]).toBeCloseTo(1 - 2 * HUE_BURST_RATE, 10);
    });

    it('ends the burst after a fixed time, however many frames that takes', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.9);
      analyser.spectrum = BASS_HEAVY_SPECTRUM;
      const slow: HalluciaVisualization = createPlaying();
      slow.setSensitivity(1);
      const atFiftyFps: boolean[] = burstFrames(huesOver(slow, 60, 20));

      const fastCanvas: HTMLCanvasElement = document.createElement('canvas');
      canvas = fastCanvas;
      fastCanvas.getContext('webgl');
      gl = fakes.glFor(fastCanvas);
      const fast: HalluciaVisualization = createPlaying();
      fast.setSensitivity(1);
      const atHundredFps: boolean[] = burstFrames(huesOver(fast, 60, 10));

      // 420ms of burst after the triggering frame: 21 more frames at 20ms, 42 more at 10ms.
      expect(atFiftyFps.filter(Boolean)).toHaveLength(22);
      expect(atHundredFps.filter(Boolean)).toHaveLength(43);
    });

    it('does not retrigger under sustained bass until the refractory period has passed', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.9);
      analyser.spectrum = BASS_HEAVY_SPECTRUM;
      const viz: HalluciaVisualization = createPlaying();
      viz.setSensitivity(1);

      const bursting: boolean[] = burstFrames(huesOver(viz, 70, 20));

      // Triggered on frame 1; 1300ms later is frame 66.
      expect(bursting.slice(22, 65)).not.toContain(true);
      expect(bursting[65]).toBe(true);
    });

    it('counts at most 250ms of a stalled frame against the burst', (): void => {
      vi.spyOn(Math, 'random').mockReturnValue(0.9);
      analyser.spectrum = BASS_HEAVY_SPECTRUM;
      const viz: HalluciaVisualization = createPlaying();
      viz.setSensitivity(1);
      const hues: number[] = huesOver(viz, 1, 16);

      // A ten second stall would otherwise end the 420ms burst outright.
      hues.push(...huesOver(viz, 1, 10_000));
      hues.push(...huesOver(viz, 4, 100));

      expect(burstFrames(hues)).toEqual([true, true, true, true, false, false]);
    });

    it('keeps the hue within one turn over a long session', (): void => {
      analyser.spectrum = BASS_HEAVY_SPECTRUM;
      const viz: HalluciaVisualization = createPlaying();
      viz.setSensitivity(1);

      const hues: number[] = huesOver(viz, 1000, 16);

      expect(Math.min(...hues)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...hues)).toBeLessThan(1);
    });
  });

  describe('sensitivity', (): void => {
    it('passes the sensitivity factor to the shader as gain', (): void => {
      const viz: HalluciaVisualization = createPlaying();
      viz.draw();
      const atDefault: number = gl.uniformValue('uGain');

      viz.setSensitivity(1);
      viz.draw();

      expect(atDefault).toBe(0.5);
      expect(gl.uniformValue('uGain')).toBe(2);
    });
  });

  describe('fade', (): void => {
    it('presents fully transparent before playback has ever started', (): void => {
      const viz: HalluciaVisualization = create();
      viz.resize(WIDTH, HEIGHT);

      viz.draw();

      expect(gl.uniformValue('uAlpha')).toBe(0);
      expect(viz.isIdle()).toBe(true);
    });

    it('presents fully opaque while playing', (): void => {
      const viz: HalluciaVisualization = createPlaying();

      viz.draw();

      expect(gl.uniformValue('uAlpha')).toBe(1);
      expect(viz.isIdle()).toBe(false);
    });

    it('fades out in proportion to the time since playback stopped', (): void => {
      const viz: HalluciaVisualization = createPlaying();
      viz.draw();
      viz.setPlaying(false);
      clock.advance(2000);

      viz.draw();

      expect(gl.uniformValue('uAlpha')).toBeCloseTo(0.6, 10);
    });

    it('becomes idle once the fade-out has completed', (): void => {
      const viz: HalluciaVisualization = createPlaying();
      viz.draw();
      viz.setPlaying(false);
      clock.advance(4999);
      viz.draw();
      const idleJustBefore: boolean = viz.isIdle();
      clock.advance(1);

      viz.draw();

      expect(idleJustBefore).toBe(false);
      expect(viz.isIdle()).toBe(true);
      expect(gl.uniformValue('uAlpha')).toBe(0);
    });
  });

  describe('destroy', (): void => {
    it('deletes every GL object it created and releases the context', (): void => {
      const viz: HalluciaVisualization = createPlaying();
      viz.draw();
      gl.clear();

      viz.destroy();

      expect(gl.callsTo('deleteTexture')).toHaveLength(3);
      expect(gl.callsTo('deleteFramebuffer')).toHaveLength(2);
      expect(gl.callsTo('deleteBuffer')).toHaveLength(1);
      expect(gl.callsTo('deleteProgram')).toHaveLength(2);
      expect(gl.callsTo('loseContext')).toHaveLength(1);
    });

    it('deletes only what exists when destroyed before the first resize', (): void => {
      const viz: HalluciaVisualization = create();
      gl.clear();

      viz.destroy();

      expect(gl.callsTo('deleteTexture')).toHaveLength(1);
      expect(gl.callsTo('deleteFramebuffer')).toEqual([]);
      expect(gl.callsTo('loseContext')).toHaveLength(1);
    });

    it('renders nothing if drawn after being destroyed', (): void => {
      const viz: HalluciaVisualization = createPlaying();
      viz.destroy();
      gl.clear();

      viz.draw();

      expect(gl.callsTo('drawArrays')).toEqual([]);
    });

    it('does not delete anything twice when destroyed twice', (): void => {
      const viz: HalluciaVisualization = createPlaying();
      viz.destroy();
      gl.clear();

      viz.destroy();

      expect(gl.callsTo('deleteTexture')).toEqual([]);
      expect(gl.callsTo('deleteProgram')).toEqual([]);
    });
  });

  describe('numeric safety', (): void => {
    const inputs: Array<[string, AnalyserFill, AnalyserFill]> = [
      ['silence', SILENT_SPECTRUM, SILENT_WAVEFORM],
      ['an all-255 spectrum and waveform', FULL_SPECTRUM, LOUD_WAVEFORM],
      ['an all-zero spectrum and waveform', SILENT_SPECTRUM, flat(0)],
      ['a single spectral spike', spike(3), SILENT_WAVEFORM],
    ];

    it.each(inputs)('passes only finite numbers to WebGL for %s', (_label: string, spectrum: AnalyserFill, waveform: AnalyserFill): void => {
      analyser.spectrum = spectrum;
      analyser.waveform = waveform;
      const viz: HalluciaVisualization = createPlaying();
      viz.setSensitivity(1);

      huesOver(viz, 120, 16);

      expect(gl.invalidCalls()).toEqual([]);
    });

    it('passes only finite numbers to WebGL on a one-pixel canvas', (): void => {
      analyser.spectrum = FULL_SPECTRUM;
      const viz: HalluciaVisualization = create();
      viz.resize(1, 1);

      viz.draw();

      expect(gl.callsTo('drawArrays')).toHaveLength(2);
      expect(gl.invalidCalls()).toEqual([]);
    });
  });
});

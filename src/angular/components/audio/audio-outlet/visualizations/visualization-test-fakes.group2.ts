/**
 * @fileoverview Test fakes shared by the Onix, Hallucia, Hawking, Ambience,
 * Neon and Album Art visualization specs.
 *
 * jsdom implements neither a canvas rendering context nor Web Audio, so the
 * specs run the visualizations against recording stand-ins:
 *
 * - FakeContext2D records every call and property assignment made on a 2D
 *   context, together with the drawing state in force at the time (honouring
 *   save/restore), so a spec can assert on what was drawn and how.
 * - FakeWebGL does the same for a WebGL context and can be told to fail
 *   compilation or linking.
 * - FakeAnalyser fills the frequency and time-domain buffers with whatever
 *   the spec chooses: silence, a bass-heavy spectrum, a single spike.
 * - FakeClock pins performance.now so fades and timers advance on demand.
 * - FakeImage stands in for the Image constructor so a spec decides whether
 *   and when a load succeeds or fails.
 *
 * Test-only: nothing here is imported by application code.
 *
 * @module app/components/audio/audio-outlet/visualizations/visualization-test-fakes.group2
 */

import {vi} from 'vitest';
import type {MockInstance} from 'vitest';

// ============================================================================
// Recording
// ============================================================================

/** One recorded call, or (for `set:<property>`) one property assignment. */
export interface RecordedCall {
  /** Method name, or `set:<property>` for an assignment. */
  readonly name: string;

  /** Arguments as passed; typed arrays are copied at the time of the call. */
  readonly args: readonly unknown[];

  /** Drawing state in force when the call was made (empty for WebGL). */
  readonly state: Readonly<Record<string, unknown>>;
}

/** A colour stop added to a fake gradient. */
export interface FakeColorStop {
  readonly offset: number;
  readonly color: string;
}

/** Stand-in for CanvasGradient that remembers how it was built. */
export interface FakeGradient {
  readonly kind: string;
  readonly args: readonly number[];
  readonly stops: FakeColorStop[];
  addColorStop(offset: number, color: string): void;
}

/** Drawing state a fresh 2D context starts with. */
const DEFAULT_STATE_2D: Readonly<Record<string, unknown>> = {
  globalAlpha: 1,
  globalCompositeOperation: 'source-over',
  fillStyle: '#000000',
  strokeStyle: '#000000',
  lineWidth: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  shadowBlur: 0,
  shadowColor: 'rgba(0, 0, 0, 0)',
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  filter: 'none',
  imageSmoothingEnabled: true,
  imageSmoothingQuality: 'low',
};

/**
 * Describes every non-finite number or NaN/Infinity-bearing string among the
 * recorded arguments, so a spec can assert that none reached the context.
 *
 * @param calls - The calls to inspect
 * @returns One description per offending call; empty when all are clean
 */
function describeInvalidCalls(calls: readonly RecordedCall[]): string[] {
  const invalid: string[] = [];
  for (const call of calls) {
    const bad: boolean = call.args.some((arg: unknown): boolean => {
      if (typeof arg === 'number') return !Number.isFinite(arg);
      if (typeof arg === 'string') return /NaN|Infinity|undefined/.test(arg);
      return false;
    });
    if (bad) invalid.push(`${call.name}(${call.args.map(String).join(', ')})`);
  }
  return invalid;
}

/**
 * Recording stand-in for CanvasRenderingContext2D.
 *
 * Every method is a no-op that records itself; every property assignment is
 * recorded as `set:<property>` and kept as drawing state, which save() and
 * restore() push and pop as a real context does.
 */
export class FakeContext2D {
  /** Everything done to the context, in order. */
  public readonly calls: RecordedCall[] = [];

  /** The object handed to the code under test. */
  public readonly context: CanvasRenderingContext2D;

  private state: Record<string, unknown> = {...DEFAULT_STATE_2D};
  private readonly stack: Array<Record<string, unknown>> = [];
  private readonly methods: Map<string, (...args: unknown[]) => unknown> = new Map();

  public constructor(public readonly canvas: HTMLCanvasElement) {
    this.context = new Proxy({}, {
      get: (_target: object, property: string | symbol): unknown => this.read(String(property)),
      set: (_target: object, property: string | symbol, value: unknown): boolean => {
        this.state[String(property)] = value;
        this.record(`set:${String(property)}`, [value]);
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
  }

  /**
   * @param name - Method name, or `set:<property>`
   * @returns The recorded calls with that name, in order
   */
  public callsTo(name: string): RecordedCall[] {
    return this.calls.filter((call: RecordedCall): boolean => call.name === name);
  }

  /**
   * @param property - Context property name, e.g. `globalAlpha`
   * @returns Every value assigned to the property, in order
   */
  public valuesSet(property: string): unknown[] {
    return this.callsTo(`set:${property}`).map((call: RecordedCall): unknown => call.args[0]);
  }

  /**
   * @param name - Gradient factory name, e.g. `createRadialGradient`
   * @returns The gradients that factory has produced, in order
   */
  public gradients(name: string): FakeGradient[] {
    return this.callsTo(`${name}:result`).map((call: RecordedCall): FakeGradient => call.args[0] as FakeGradient);
  }

  /** @returns Descriptions of calls that were passed NaN or Infinity. */
  public invalidCalls(): string[] {
    return describeInvalidCalls(this.calls);
  }

  /** Forgets everything recorded so far, keeping the drawing state. */
  public clear(): void {
    this.calls.length = 0;
  }

  private read(property: string): unknown {
    if (property === 'canvas') return this.canvas;
    if (property in this.state) return this.state[property];

    let method: ((...args: unknown[]) => unknown) | undefined = this.methods.get(property);
    if (!method) {
      method = (...args: unknown[]): unknown => this.invoke(property, args);
      this.methods.set(property, method);
    }
    return method;
  }

  private invoke(name: string, args: unknown[]): unknown {
    this.record(name, args);

    switch (name) {
      case 'save':
        this.stack.push({...this.state});
        return undefined;
      case 'restore':
        this.state = this.stack.pop() ?? this.state;
        return undefined;
      case 'drawImage':
        this.rejectEmptySource(args[0]);
        return undefined;
      case 'createLinearGradient':
      case 'createRadialGradient':
      case 'createConicGradient':
        return this.createGradient(name, args as number[]);
      default:
        return undefined;
    }
  }

  /**
   * Drawing a canvas with a zero dimension throws in every browser, so the
   * fake refuses it too rather than letting such a call pass unnoticed.
   */
  private rejectEmptySource(source: unknown): void {
    if (source instanceof HTMLCanvasElement && (source.width === 0 || source.height === 0)) {
      throw new DOMException('The image argument is a canvas element with a width or height of 0.', 'InvalidStateError');
    }
  }

  private createGradient(kind: string, args: number[]): FakeGradient {
    const gradient: FakeGradient = {
      kind,
      args,
      stops: [],
      addColorStop: (offset: number, color: string): void => {
        gradient.stops.push({offset, color});
        this.record('addColorStop', [offset, color]);
      },
    };
    this.record(`${kind}:result`, [gradient]);
    return gradient;
  }

  private record(name: string, args: readonly unknown[]): void {
    this.calls.push({name, args, state: {...this.state}});
  }
}

// ============================================================================
// WebGL
// ============================================================================

/** The WebGL enum values the visualizations read off the context. */
const GL_CONSTANTS: Readonly<Record<string, number>> = {
  VERTEX_SHADER: 0x8B31,
  FRAGMENT_SHADER: 0x8B30,
  COMPILE_STATUS: 0x8B81,
  LINK_STATUS: 0x8B82,
  ARRAY_BUFFER: 0x8892,
  STATIC_DRAW: 0x88E4,
  TEXTURE_2D: 0x0DE1,
  TEXTURE0: 0x84C0,
  TEXTURE1: 0x84C1,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  LINEAR: 0x2601,
  CLAMP_TO_EDGE: 0x812F,
  FRAMEBUFFER: 0x8D40,
  COLOR_ATTACHMENT0: 0x8CE0,
  COLOR_BUFFER_BIT: 0x4000,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  FLOAT: 0x1406,
  TRIANGLES: 0x0004,
};

/** A GL object (program, shader, texture, buffer, framebuffer) made by the fake. */
export interface FakeGLObject {
  readonly kind: string;
  readonly id: number;
}

/** A uniform location made by the fake, remembering the name it was asked for. */
export interface FakeUniformLocation {
  readonly uniform: string;
  readonly program: unknown;
}

/**
 * Recording stand-in for WebGLRenderingContext.
 *
 * Shaders compile and programs link unless the spec says otherwise, and every
 * call is recorded so a spec can read back the uniforms, textures and
 * framebuffers a frame used.
 */
export class FakeWebGL {
  /** Everything done to the context, in order. */
  public readonly calls: RecordedCall[] = [];

  /** The object handed to the code under test. */
  public readonly context: WebGLRenderingContext;

  /** When true, shaders report a failed compile. */
  public failCompile: boolean = false;

  /** When true, programs report a failed link. */
  public failLink: boolean = false;

  /** When true, createProgram returns null, as on a lost context. */
  public refuseProgram: boolean = false;

  /** When true, createShader returns null, as on a lost context. */
  public refuseShader: boolean = false;

  /** What getShaderInfoLog / getProgramInfoLog return. */
  public infoLog: string | null = 'fake info log';

  private nextId: number = 1;
  private readonly methods: Map<string, (...args: unknown[]) => unknown> = new Map();

  public constructor(public readonly canvas: HTMLCanvasElement) {
    this.context = new Proxy({}, {
      get: (_target: object, property: string | symbol): unknown => this.read(String(property)),
    }) as unknown as WebGLRenderingContext;
  }

  /**
   * @param name - Method name
   * @returns The recorded calls with that name, in order
   */
  public callsTo(name: string): RecordedCall[] {
    return this.calls.filter((call: RecordedCall): boolean => call.name === name);
  }

  /**
   * @param uniform - Uniform name, e.g. `uBass`
   * @returns The values of every upload to that uniform, in order
   */
  public uniformHistory(uniform: string): unknown[][] {
    return this.calls
      .filter((call: RecordedCall): boolean =>
        call.name.startsWith('uniform') && (call.args[0] as FakeUniformLocation | null)?.uniform === uniform)
      .map((call: RecordedCall): unknown[] => call.args.slice(1));
  }

  /**
   * @param uniform - Uniform name holding a single number
   * @returns The value most recently uploaded to it
   * @throws Error if the uniform was never uploaded
   */
  public uniformValue(uniform: string): number {
    // Searched from the end: specs ask for this every frame over long runs.
    for (let i: number = this.calls.length - 1; i >= 0; i--) {
      const call: RecordedCall = this.calls[i];
      if (call.name.startsWith('uniform') && (call.args[0] as FakeUniformLocation | null)?.uniform === uniform) {
        return call.args[1] as number;
      }
    }
    throw new Error(`Uniform ${uniform} was never uploaded`);
  }

  /** @returns Descriptions of calls that were passed NaN or Infinity. */
  public invalidCalls(): string[] {
    return describeInvalidCalls(this.calls);
  }

  /** Forgets everything recorded so far. */
  public clear(): void {
    this.calls.length = 0;
  }

  private read(property: string): unknown {
    if (property === 'canvas') return this.canvas;
    if (property in GL_CONSTANTS) return GL_CONSTANTS[property];

    let method: ((...args: unknown[]) => unknown) | undefined = this.methods.get(property);
    if (!method) {
      method = (...args: unknown[]): unknown => this.invoke(property, args);
      this.methods.set(property, method);
    }
    return method;
  }

  private invoke(name: string, args: unknown[]): unknown {
    // Staging buffers are reused frame to frame, so keep what was uploaded.
    const kept: unknown[] = args.map((arg: unknown): unknown => arg instanceof Uint8Array ? arg.slice() : arg);
    this.calls.push({name, args: kept, state: {}});

    switch (name) {
      case 'createProgram':
        return this.refuseProgram ? null : this.createObject('program');
      case 'createShader':
        return this.refuseShader ? null : this.createObject('shader');
      case 'createTexture':
        return this.createObject('texture');
      case 'createBuffer':
        return this.createObject('buffer');
      case 'createFramebuffer':
        return this.createObject('framebuffer');
      case 'getShaderParameter':
        return !this.failCompile;
      case 'getProgramParameter':
        return !this.failLink;
      case 'getShaderInfoLog':
      case 'getProgramInfoLog':
        return this.infoLog;
      case 'getUniformLocation': {
        const location: FakeUniformLocation = {uniform: String(args[1]), program: args[0]};
        return location;
      }
      case 'getAttribLocation':
        return 0;
      case 'getExtension':
        return args[0] === 'WEBGL_lose_context'
          ? {loseContext: (): void => { this.calls.push({name: 'loseContext', args: [], state: {}}); }}
          : null;
      default:
        return undefined;
    }
  }

  private createObject(kind: string): FakeGLObject {
    return {kind, id: this.nextId++};
  }
}

// ============================================================================
// Canvas installation
// ============================================================================

/** Handle on the fake contexts installed over HTMLCanvasElement.getContext. */
export interface CanvasFakes {
  /** Every 2D context created since installation, in creation order. */
  readonly contexts: FakeContext2D[];

  /** Every WebGL context created since installation, in creation order. */
  readonly glContexts: FakeWebGL[];

  /** When true, getContext returns null for every context type. */
  refuseContexts: boolean;

  /**
   * @param canvas - A canvas whose 2D context has been requested
   * @returns The fake behind that canvas's 2D context
   * @throws Error if the canvas never asked for one
   */
  contextFor(canvas: HTMLCanvasElement): FakeContext2D;

  /**
   * @param canvas - A canvas whose WebGL context has been requested
   * @returns The fake behind that canvas's WebGL context
   * @throws Error if the canvas never asked for one
   */
  glFor(canvas: HTMLCanvasElement): FakeWebGL;

  /** Puts the real getContext back. Call from afterEach. */
  restore(): void;
}

/**
 * Replaces HTMLCanvasElement.prototype.getContext so every canvas - the one
 * given to a visualization and any it creates off-screen - gets a recording
 * fake, one per canvas, as a real canvas keeps one context.
 *
 * @returns A handle for finding the fakes and restoring the original
 */
export function installCanvasFakes(): CanvasFakes {
  const original: typeof HTMLCanvasElement.prototype.getContext = HTMLCanvasElement.prototype.getContext;
  const byCanvas2D: WeakMap<HTMLCanvasElement, FakeContext2D> = new WeakMap();
  const byCanvasGL: WeakMap<HTMLCanvasElement, FakeWebGL> = new WeakMap();

  const fakes: CanvasFakes = {
    contexts: [],
    glContexts: [],
    refuseContexts: false,
    contextFor: (canvas: HTMLCanvasElement): FakeContext2D => {
      const fake: FakeContext2D | undefined = byCanvas2D.get(canvas);
      if (!fake) throw new Error('No 2D context was requested for this canvas');
      return fake;
    },
    glFor: (canvas: HTMLCanvasElement): FakeWebGL => {
      const fake: FakeWebGL | undefined = byCanvasGL.get(canvas);
      if (!fake) throw new Error('No WebGL context was requested for this canvas');
      return fake;
    },
    restore: (): void => {
      HTMLCanvasElement.prototype.getContext = original;
    },
  };

  const replacement: (this: HTMLCanvasElement, contextId: string) => unknown =
    function (this: HTMLCanvasElement, contextId: string): unknown {
      if (fakes.refuseContexts) return null;

      if (contextId === '2d') {
        let fake: FakeContext2D | undefined = byCanvas2D.get(this);
        if (!fake) {
          fake = new FakeContext2D(this);
          byCanvas2D.set(this, fake);
          fakes.contexts.push(fake);
        }
        return fake.context;
      }

      let fake: FakeWebGL | undefined = byCanvasGL.get(this);
      if (!fake) {
        fake = new FakeWebGL(this);
        byCanvasGL.set(this, fake);
        fakes.glContexts.push(fake);
      }
      return fake.context;
    };

  HTMLCanvasElement.prototype.getContext = replacement as unknown as typeof original;
  return fakes;
}

// ============================================================================
// Audio
// ============================================================================

/** Chooses the byte for one slot of an analyser buffer. */
export type AnalyserFill = (index: number, length: number) => number;

/** Mid-scale byte: zero amplitude in time-domain data. */
const WAVEFORM_CENTRE: number = 128;

/** Full-scale byte. */
const BYTE_MAX: number = 255;

/** Bins a bass-heavy spectrum holds at full scale. */
const BASS_HEAVY_BINS: number = 32;

/**
 * @param value - The byte every slot is given
 * @returns A fill that makes the whole buffer one value
 */
export function flat(value: number): AnalyserFill {
  return (): number => value;
}

/** A spectrum with no energy anywhere. */
export const SILENT_SPECTRUM: AnalyserFill = flat(0);

/** A spectrum at full scale in every bin. */
export const FULL_SPECTRUM: AnalyserFill = flat(BYTE_MAX);

/** A waveform resting on the centre line. */
export const SILENT_WAVEFORM: AnalyserFill = flat(WAVEFORM_CENTRE);

/** A waveform pinned to positive full scale. */
export const LOUD_WAVEFORM: AnalyserFill = flat(BYTE_MAX);

/** A spectrum at full scale in the lowest bins and empty above them. */
export const BASS_HEAVY_SPECTRUM: AnalyserFill =
  (index: number): number => index < BASS_HEAVY_BINS ? BYTE_MAX : 0;

/**
 * @param at - The one slot to fill
 * @param value - The byte it is given
 * @param rest - The byte every other slot is given
 * @returns A fill with a single spike
 */
export function spike(at: number, value: number = BYTE_MAX, rest: number = 0): AnalyserFill {
  return (index: number): number => index === at ? value : rest;
}

/**
 * Stand-in for AnalyserNode whose buffers hold whatever the spec chooses.
 *
 * Starts silent. Assign `spectrum` or `waveform` to change what the next
 * frame reads.
 */
export class FakeAnalyser {
  /** Fill applied by getByteFrequencyData. */
  public spectrum: AnalyserFill = SILENT_SPECTRUM;

  /** Fill applied by getByteTimeDomainData. */
  public waveform: AnalyserFill = SILENT_WAVEFORM;

  public fftSize: number = 2048;

  /** Lengths of the buffers passed to getByteFrequencyData, in call order. */
  public readonly spectrumReads: number[] = [];

  /** Lengths of the buffers passed to getByteTimeDomainData, in call order. */
  public readonly waveformReads: number[] = [];

  public get frequencyBinCount(): number {
    return this.fftSize / 2;
  }

  /** This fake, typed as the node the visualizations expect. */
  public get node(): AnalyserNode {
    return this as unknown as AnalyserNode;
  }

  public getByteFrequencyData(target: Uint8Array): void {
    this.spectrumReads.push(target.length);
    for (let i: number = 0; i < target.length; i++) target[i] = this.spectrum(i, target.length);
  }

  public getByteTimeDomainData(target: Uint8Array): void {
    this.waveformReads.push(target.length);
    for (let i: number = 0; i < target.length; i++) target[i] = this.waveform(i, target.length);
  }
}

// ============================================================================
// Time
// ============================================================================

/** Where the fake clock starts, in milliseconds. */
const CLOCK_START_MS: number = 10_000;

/** A performance.now the spec moves by hand. */
export interface FakeClock {
  /** Current reading, in milliseconds. */
  now: number;

  /**
   * @param ms - Milliseconds to move the clock forward
   */
  advance(ms: number): void;

  /** Puts the real performance.now back. Call from afterEach. */
  restore(): void;
}

/**
 * Pins performance.now to a value the spec controls.
 *
 * @returns The clock
 */
export function installFakeClock(): FakeClock {
  const clock: FakeClock = {
    now: CLOCK_START_MS,
    advance: (ms: number): void => { clock.now += ms; },
    restore: (): void => { spy.mockRestore(); },
  };
  const spy: MockInstance<() => number> =
    vi.spyOn(performance, 'now').mockImplementation((): number => clock.now);
  return clock;
}

// ============================================================================
// Images
// ============================================================================

/**
 * Stand-in for an image element that loads only when the spec says so.
 */
export class FakeImage {
  public onload: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public src: string = '';
  public naturalWidth: number = 0;
  public naturalHeight: number = 0;

  /**
   * Completes the load at the given intrinsic size.
   *
   * @param width - Natural width in pixels
   * @param height - Natural height in pixels
   */
  public succeed(width: number, height: number): void {
    this.naturalWidth = width;
    this.naturalHeight = height;
    this.onload?.();
  }

  /** Fails the load, as a 404 or an undecodable file does. */
  public fail(): void {
    this.onerror?.();
  }
}

/** Handle on the images constructed while the fake Image is installed. */
export interface ImageFakes {
  /** Every image constructed since installation, in order. */
  readonly images: FakeImage[];

  /** Puts the real Image constructor back. Call from afterEach. */
  restore(): void;
}

/**
 * Replaces the global Image constructor with FakeImage.
 *
 * @returns A handle for reaching the images and restoring the original
 */
export function installFakeImage(): ImageFakes {
  const images: FakeImage[] = [];

  class TrackedImage extends FakeImage {
    public constructor() {
      super();
      images.push(this);
    }
  }

  vi.stubGlobal('Image', TrackedImage);
  return {
    images,
    restore: (): void => { vi.unstubAllGlobals(); },
  };
}

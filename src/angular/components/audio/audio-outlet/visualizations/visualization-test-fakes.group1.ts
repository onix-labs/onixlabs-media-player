/**
 * @fileoverview Recording fakes shared by the Reactor, Spotlight, Pulsar and
 * feedback-engine specs.
 *
 * jsdom implements neither a canvas rendering context nor Web Audio, so the
 * visualizations are driven against:
 *
 * - {@link RecordingContext2D}, which records every call (with the drawing
 *   state in force at the time) and every property write,
 * - {@link RecordingWebGL}, which does the same for a WebGL context, and
 * - {@link FakeAnalyser}, which fills the buffers it is handed with whatever
 *   spectrum and waveform the test has chosen.
 *
 * This file deliberately has no dependency on the test runner, so it compiles
 * under the application tsconfig as well as the spec one.
 *
 * @module app/components/audio/audio-outlet/visualizations/visualization-test-fakes.group1
 */

// ============================================================================
// Canvas 2D
// ============================================================================

/** The drawing state a recorded call was made under. */
export interface CanvasState {
  readonly globalAlpha: number;
  readonly globalCompositeOperation: string;
  readonly fillStyle: unknown;
  readonly strokeStyle: unknown;
  readonly lineWidth: number;
  readonly lineCap: string;
  readonly lineJoin: string;
  readonly shadowBlur: number;
  readonly shadowColor: string;
  readonly filter: string;
  readonly imageSmoothingEnabled: boolean;
  readonly imageSmoothingQuality: string;
}

/** One call made on a recording context. */
export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
  readonly state: CanvasState;
}

/** One property write made on a recording context. */
export interface RecordedSet {
  readonly property: keyof CanvasState;
  readonly value: unknown;
}

/** The state a real context starts in. */
const INITIAL_STATE: CanvasState = {
  globalAlpha: 1,
  globalCompositeOperation: 'source-over',
  fillStyle: '#000000',
  strokeStyle: '#000000',
  lineWidth: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  shadowBlur: 0,
  shadowColor: 'rgba(0, 0, 0, 0)',
  filter: 'none',
  imageSmoothingEnabled: true,
  imageSmoothingQuality: 'low',
};

/** Context methods that are recorded and otherwise do nothing. */
const RECORDED_METHODS: readonly string[] = [
  'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
  'quadraticCurveTo', 'bezierCurveTo', 'arc', 'rect', 'fill', 'stroke', 'clip',
  'translate', 'rotate', 'scale', 'setTransform', 'drawImage',
];

/**
 * Whether a real context would accept a value for a numeric property.
 *
 * A canvas silently ignores a write it considers invalid and keeps the old
 * value, so the fake has to do the same for the recorded state to be the state
 * a browser would actually draw with.
 *
 * @param property - The property being written
 * @param value - The value written
 * @returns Whether the write takes effect
 */
function isAcceptedWrite(property: keyof CanvasState, value: unknown): boolean {
  if (typeof value !== 'number') return true;
  if (!Number.isFinite(value)) return false;
  if (property === 'globalAlpha') return value >= 0 && value <= 1;
  // The other numeric properties are lineWidth, which must be positive, and
  // shadowBlur, which must not be negative.
  return property === 'lineWidth' ? value > 0 : value >= 0;
}

/**
 * Whether a call argument is a number a canvas could not draw with.
 *
 * An explicit `undefined` counts: it reaches the canvas as NaN.
 *
 * @param value - One argument of a recorded call
 * @returns Whether the argument is NaN, infinite or undefined
 */
function isUnusable(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === 'number' && !Number.isFinite(value);
}

/**
 * A stand-in for CanvasRenderingContext2D that records what is done to it.
 *
 * `save` and `restore` keep a real state stack, so the state attached to each
 * recorded call is the state that call would have drawn with.
 */
export class RecordingContext2D {
  /** Every call, in order. */
  public readonly calls: RecordedCall[] = [];

  /** Every property write, in order, including ones a canvas would ignore. */
  public readonly sets: RecordedSet[] = [];

  /** The canvas this context belongs to. */
  public readonly canvas: HTMLCanvasElement;

  private state: CanvasState = INITIAL_STATE;
  private readonly stack: CanvasState[] = [];

  public constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    for (const method of RECORDED_METHODS) {
      Object.defineProperty(this, method, {
        value: (...args: unknown[]): void => this.record(method, args),
      });
    }

    for (const key of Object.keys(INITIAL_STATE)) {
      const property: keyof CanvasState = key as keyof CanvasState;
      Object.defineProperty(this, property, {
        get: (): unknown => this.state[property],
        set: (value: unknown): void => this.write(property, value),
      });
    }
  }

  /** Pushes the current state, as a real context does. */
  public save(): void {
    this.stack.push(this.state);
    this.record('save', []);
  }

  /** Pops the state pushed by the matching save. */
  public restore(): void {
    this.state = this.stack.pop() ?? this.state;
    this.record('restore', []);
  }

  /**
   * The recorded calls to one method.
   *
   * @param method - Method name, e.g. `drawImage`
   * @returns Those calls, in order
   */
  public callsTo(method: string): RecordedCall[] {
    return this.calls.filter((call: RecordedCall): boolean => call.method === method);
  }

  /**
   * Calls that were handed NaN, an infinity or an explicit undefined.
   *
   * @returns The offending calls, in order
   */
  public unusableCalls(): RecordedCall[] {
    return this.calls.filter((call: RecordedCall): boolean => call.args.some(isUnusable));
  }

  /**
   * Property writes that were handed NaN or an infinity.
   *
   * @returns The offending writes, in order
   */
  public unusableSets(): RecordedSet[] {
    return this.sets.filter((entry: RecordedSet): boolean => isUnusable(entry.value));
  }

  /** Forgets everything recorded so far, keeping the current state. */
  public forget(): void {
    this.calls.length = 0;
    this.sets.length = 0;
  }

  private record(method: string, args: readonly unknown[]): void {
    this.calls.push({method, args, state: this.state});
  }

  private write(property: keyof CanvasState, value: unknown): void {
    this.sets.push({property, value});
    if (isAcceptedWrite(property, value)) {
      this.state = {...this.state, [property]: value};
    }
  }
}

// ============================================================================
// WebGL
// ============================================================================

/** A shader object handed out by the WebGL fake. */
export interface FakeShader {
  readonly type: number;
  source: string;
}

/** A program object handed out by the WebGL fake. */
export interface FakeProgram {
  readonly shaders: FakeShader[];
}

/** A uniform location handed out by the WebGL fake. */
export interface FakeUniformLocation {
  readonly program: FakeProgram;
  readonly name: string;
}

/** A texture, buffer or framebuffer handed out by the WebGL fake. */
export interface FakeGlObject {
  readonly kind: string;
  readonly serial: number;
}

/** One call made on the WebGL fake. */
export interface RecordedGlCall {
  readonly method: string;
  readonly args: readonly unknown[];

  /** The program in use when the call was made. */
  readonly program: FakeProgram | null;

  /** The framebuffer bound when the call was made; null is the canvas. */
  readonly framebuffer: FakeGlObject | null;
}

/** Pattern matching the names of WebGL enum constants. */
const GL_CONSTANT_PATTERN: RegExp = /^[A-Z][A-Z0-9_]*$/;

/**
 * A stand-in for WebGLRenderingContext that records what is done to it.
 *
 * Create one with {@link createRecordingWebGL}: enum constants and the methods
 * not written out here are supplied by a proxy.
 */
export class RecordingWebGL {
  /** Every call, in order. */
  public readonly calls: RecordedGlCall[] = [];

  /** When true, shaders report a failed compile. */
  public failCompile: boolean = false;

  /** When true, programs report a failed link. */
  public failLink: boolean = false;

  /** When true, createProgram returns null, as a lost context does. */
  public refuseProgram: boolean = false;

  /** When true, createShader returns null, as a lost context does. */
  public refuseShader: boolean = false;

  /** When true, createTexture returns null, as a lost context does. */
  public refuseTexture: boolean = false;

  /** Info log reported for a failed compile or link; null is "no log". */
  public infoLog: string | null = 'fake failure';

  /** Number of times the context has been deliberately lost. */
  public contextLosses: number = 0;

  private program: FakeProgram | null = null;
  private framebuffer: FakeGlObject | null = null;
  private serial: number = 0;

  public createProgram(): FakeProgram | null {
    this.record('createProgram', []);
    return this.refuseProgram ? null : {shaders: []};
  }

  public createShader(type: number): FakeShader | null {
    this.record('createShader', [type]);
    return this.refuseShader ? null : {type, source: ''};
  }

  public shaderSource(shader: FakeShader, source: string): void {
    shader.source = source;
    this.record('shaderSource', [shader, source]);
  }

  public attachShader(program: FakeProgram, shader: FakeShader): void {
    program.shaders.push(shader);
    this.record('attachShader', [program, shader]);
  }

  public shaderParameter(): boolean {
    return !this.failCompile;
  }

  public programParameter(): boolean {
    return !this.failLink;
  }

  public shaderInfoLog(): string | null {
    return this.infoLog;
  }

  public programInfoLog(): string | null {
    return this.infoLog;
  }

  public uniformLocation(program: FakeProgram, name: string): FakeUniformLocation {
    return {program, name};
  }

  public attribLocation(): number {
    return 0;
  }

  public extension(name: string): {loseContext: () => void} | null {
    if (name !== 'WEBGL_lose_context') return null;
    return {loseContext: (): void => { this.contextLosses++; }};
  }

  public createTexture(): FakeGlObject | null {
    this.record('createTexture', []);
    return this.refuseTexture ? null : this.createObject('texture');
  }

  public createBuffer(): FakeGlObject {
    this.record('createBuffer', []);
    return this.createObject('buffer');
  }

  public createFramebuffer(): FakeGlObject {
    this.record('createFramebuffer', []);
    return this.createObject('framebuffer');
  }

  public useProgram(program: FakeProgram | null): void {
    this.program = program;
    this.record('useProgram', [program]);
  }

  public bindFramebuffer(target: number, framebuffer: FakeGlObject | null): void {
    this.framebuffer = framebuffer;
    this.record('bindFramebuffer', [target, framebuffer]);
  }

  /**
   * Records a call. Used by the proxy for every method not written out above.
   *
   * @param method - Method name
   * @param args - The arguments it was called with
   */
  public record(method: string, args: readonly unknown[]): void {
    this.calls.push({method, args, program: this.program, framebuffer: this.framebuffer});
  }

  /**
   * The recorded calls to one method.
   *
   * @param method - Method name, e.g. `drawArrays`
   * @returns Those calls, in order
   */
  public callsTo(method: string): RecordedGlCall[] {
    return this.calls.filter((call: RecordedGlCall): boolean => call.method === method);
  }

  /**
   * Every value a uniform has been set to.
   *
   * @param name - Uniform name, e.g. `uAmplitude`
   * @param fragmentMarker - Text found only in the owning program's fragment
   *   shader, for uniforms that more than one program declares
   * @returns The value arguments of each write, in order
   */
  public uniformWrites(name: string, fragmentMarker: string = ''): unknown[][] {
    const writes: unknown[][] = [];
    for (const call of this.calls) {
      if (!call.method.startsWith('uniform')) continue;
      const location: FakeUniformLocation = call.args[0] as FakeUniformLocation;
      if (location.name !== name) continue;
      const owned: boolean = location.program.shaders
        .some((shader: FakeShader): boolean => shader.source.includes(fragmentMarker));
      if (owned) writes.push(call.args.slice(1));
    }
    return writes;
  }

  /** Forgets every call recorded so far. */
  public forget(): void {
    this.calls.length = 0;
  }

  private createObject(kind: string): FakeGlObject {
    return {kind, serial: ++this.serial};
  }
}

/** Real WebGL method names answered by a differently named method on the fake. */
const GL_QUERY_METHODS: Readonly<Record<string, keyof RecordingWebGL>> = {
  getShaderParameter: 'shaderParameter',
  getProgramParameter: 'programParameter',
  getShaderInfoLog: 'shaderInfoLog',
  getProgramInfoLog: 'programInfoLog',
  getUniformLocation: 'uniformLocation',
  getAttribLocation: 'attribLocation',
  getExtension: 'extension',
};

/**
 * Builds a recording WebGL context.
 *
 * @returns The fake; cast it to WebGLRenderingContext where one is expected
 */
export function createRecordingWebGL(): RecordingWebGL {
  const constants: Map<string, number> = new Map<string, number>();
  const recorders: Map<string, (...args: unknown[]) => void> = new Map<string, (...args: unknown[]) => void>();

  return new Proxy<RecordingWebGL>(new RecordingWebGL(), {
    get: (target: RecordingWebGL, property: string | symbol): unknown => {
      if (typeof property !== 'string') return undefined;

      const name: string = GL_QUERY_METHODS[property] ?? property;
      if (name in target) {
        const member: unknown = target[name as keyof RecordingWebGL];
        return typeof member === 'function' ? member.bind(target) : member;
      }

      if (GL_CONSTANT_PATTERN.test(property)) {
        if (!constants.has(property)) constants.set(property, constants.size + 1);
        return constants.get(property);
      }

      if (!recorders.has(property)) {
        recorders.set(property, (...args: unknown[]): void => target.record(property, args));
      }
      return recorders.get(property);
    },
    set: (target: RecordingWebGL, property: string | symbol, value: unknown): boolean =>
      Reflect.set(target, property, value),
  });
}

// ============================================================================
// Installing the canvas fakes
// ============================================================================

/**
 * The fakes handed out by `HTMLCanvasElement.getContext` while installed.
 */
export class CanvasFakes {
  /** Every 2D context handed out, in the order the canvases first asked. */
  public readonly contexts: RecordingContext2D[] = [];

  /** The WebGL context handed out to any canvas that asks for one. */
  public readonly webgl: RecordingWebGL = createRecordingWebGL();

  /** When false, a request for a WebGL context is refused. */
  public webglAvailable: boolean = true;

  private readonly byCanvas: WeakMap<HTMLCanvasElement, RecordingContext2D> =
    new WeakMap<HTMLCanvasElement, RecordingContext2D>();

  private readonly original: typeof HTMLCanvasElement.prototype.getContext =
    HTMLCanvasElement.prototype.getContext;

  public constructor() {
    const provide: (canvas: HTMLCanvasElement, kind: string) => unknown =
      (canvas: HTMLCanvasElement, kind: string): unknown => this.provide(canvas, kind);

    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string): unknown {
      return provide(this, kind);
    } as typeof HTMLCanvasElement.prototype.getContext;
  }

  /** Puts the real `getContext` back. Call from `afterEach`. */
  public restore(): void {
    HTMLCanvasElement.prototype.getContext = this.original;
  }

  /** Forgets everything every 2D context has recorded so far. */
  public forget(): void {
    for (const context of this.contexts) context.forget();
  }

  /**
   * Calls, on any 2D context, that were handed NaN, an infinity or undefined.
   *
   * @returns The offending calls
   */
  public unusableCalls(): RecordedCall[] {
    return this.contexts.flatMap((context: RecordingContext2D): RecordedCall[] => context.unusableCalls());
  }

  /**
   * Property writes, on any 2D context, that were handed NaN or an infinity.
   *
   * @returns The offending writes
   */
  public unusableSets(): RecordedSet[] {
    return this.contexts.flatMap((context: RecordingContext2D): RecordedSet[] => context.unusableSets());
  }

  private provide(canvas: HTMLCanvasElement, kind: string): unknown {
    if (kind === '2d') {
      let context: RecordingContext2D | undefined = this.byCanvas.get(canvas);
      if (!context) {
        context = new RecordingContext2D(canvas);
        this.byCanvas.set(canvas, context);
        this.contexts.push(context);
      }
      return context;
    }

    return this.webglAvailable ? this.webgl : null;
  }
}

/**
 * Replaces `HTMLCanvasElement.prototype.getContext` with one that hands out
 * recording fakes.
 *
 * @returns The installed fakes; call `restore()` on them in `afterEach`
 */
export function installCanvasFakes(): CanvasFakes {
  return new CanvasFakes();
}

// ============================================================================
// Audio
// ============================================================================

/** Largest value of a byte of analyser data. */
const BYTE_MAX: number = 255;

/** The value a time-domain sample rests at in silence. */
const WAVEFORM_REST: number = 128;

/** Maps a position in an analyser buffer to the byte found there. */
export type AudioShape = (index: number) => number;

/** A spectrum with nothing in it. */
export const SILENT_SPECTRUM: AudioShape = (): number => 0;

/** A waveform at rest. */
export const SILENT_WAVEFORM: AudioShape = (): number => WAVEFORM_REST;

/**
 * A spectrum or waveform holding the same byte throughout.
 *
 * @param value - The byte to fill with, 0 to 255
 * @returns The shape
 */
export function flat(value: number): AudioShape {
  return (): number => value;
}

/**
 * A spectrum that is full-scale in its lowest bins and quiet above them.
 *
 * @param bassBins - How many of the lowest bins are full-scale
 * @param rest - The byte every other bin holds
 * @returns The shape
 */
export function bassHeavy(bassBins: number, rest: number = 0): AudioShape {
  return (index: number): number => (index < bassBins ? BYTE_MAX : rest);
}

/**
 * A spectrum holding one loud bin.
 *
 * @param bin - Index of the loud bin
 * @param value - The byte it holds
 * @param rest - The byte every other bin holds
 * @returns The shape
 */
export function spike(bin: number, value: number = BYTE_MAX, rest: number = 0): AudioShape {
  return (index: number): number => (index === bin ? value : rest);
}

/**
 * A stand-in for AnalyserNode that serves whatever audio the test chooses.
 */
export class FakeAnalyser {
  /** The spectrum served to getByteFrequencyData. */
  public spectrum: AudioShape = SILENT_SPECTRUM;

  /** The waveform served to getByteTimeDomainData. */
  public waveform: AudioShape = SILENT_WAVEFORM;

  /** Number of frequency bins, half the FFT size as on a real node. */
  public frequencyBinCount: number;

  /** Lengths of the buffers passed to getByteFrequencyData, in order. */
  public readonly spectrumReads: number[] = [];

  /** Lengths of the buffers passed to getByteTimeDomainData, in order. */
  public readonly waveformReads: number[] = [];

  /** Fills a buffer from {@link spectrum}. A property so it survives being detached. */
  public readonly getByteFrequencyData: (buffer: Uint8Array) => void = (buffer: Uint8Array): void => {
    this.spectrumReads.push(buffer.length);
    for (let i: number = 0; i < buffer.length; i++) buffer[i] = this.spectrum(i);
  };

  /** Fills a buffer from {@link waveform}. A property so it survives being detached. */
  public readonly getByteTimeDomainData: (buffer: Uint8Array) => void = (buffer: Uint8Array): void => {
    this.waveformReads.push(buffer.length);
    for (let i: number = 0; i < buffer.length; i++) buffer[i] = this.waveform(i);
  };

  private size: number;

  public constructor(fftSize: number = 2048) {
    this.size = fftSize;
    this.frequencyBinCount = fftSize / 2;
  }

  public get fftSize(): number {
    return this.size;
  }

  public set fftSize(value: number) {
    this.size = value;
    this.frequencyBinCount = value / 2;
  }

  /**
   * This fake, typed as the node a visualization expects.
   *
   * @returns The fake as an AnalyserNode
   */
  public asNode(): AnalyserNode {
    return this as unknown as AnalyserNode;
  }
}

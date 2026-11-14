/**
 * @fileoverview Test fakes shared by the visualization specs in this folder.
 *
 * jsdom implements neither the Canvas 2D context nor Web Audio, so the specs
 * for the concrete visualizations run against the fakes defined here:
 *
 * - A recording `CanvasRenderingContext2D` that logs every method call and
 *   every property assignment in order, tracks `save()`/`restore()` state, and
 *   hands back usable gradients and image data.
 * - A minimal WebGL context for the visualizations built on the feedback
 *   engine, enough to construct and destroy them.
 * - An `AnalyserNode` whose frequency and time-domain data the test chooses.
 *
 * Nothing in this file depends on the test runner, so it type-checks as part
 * of the application program as well as the spec program.
 *
 * @module app/components/audio/audio-outlet/visualizations/visualization-test-fakes.group3
 */

// ============================================================================
// Recording 2D context
// ============================================================================

/** A method call made on a recording context. */
export interface RecordedCall {
  readonly kind: 'call';
  readonly method: string;
  readonly args: readonly unknown[];
  /** The context's drawing state at the moment of the call. */
  readonly state: Readonly<Record<string, unknown>>;
}

/** A property assignment made on a recording context. */
export interface RecordedSet {
  readonly kind: 'set';
  readonly property: string;
  readonly value: unknown;
}

/** Anything a recording context logs, in the order it happened. */
export type RecordedOperation = RecordedCall | RecordedSet;

/** A point on a recorded path. */
export interface RecordedPoint {
  readonly x: number;
  readonly y: number;
}

/** A colour stop added to a fake gradient. */
export interface RecordedColorStop {
  readonly offset: number;
  readonly color: string;
}

/** A gradient handed out by a recording context. */
export class FakeGradient {
  public readonly stops: RecordedColorStop[] = [];

  public constructor(public readonly kind: string, public readonly args: readonly unknown[]) {}

  public addColorStop(offset: number, color: string): void {
    this.stops.push({offset, color});
  }
}

/** Bytes per pixel in an RGBA image buffer. */
const RGBA_STRIDE: number = 4;

/** Drawing state a real context starts with. */
const DEFAULT_STATE: Readonly<Record<string, unknown>> = {
  globalAlpha: 1,
  globalCompositeOperation: 'source-over',
  fillStyle: '#000000',
  strokeStyle: '#000000',
  lineWidth: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  miterLimit: 10,
  lineDashOffset: 0,
  shadowBlur: 0,
  shadowColor: 'rgba(0, 0, 0, 0)',
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  filter: 'none',
  font: '10px sans-serif',
  textAlign: 'start',
  textBaseline: 'alphabetic',
  imageSmoothingEnabled: true,
  imageSmoothingQuality: 'low',
};

/** Builds image data of the requested size, or a single pixel when the size is unusable. */
function createImageData(width: number, height: number): ImageData {
  const safeWidth: number = Number.isFinite(width) && width > 0 ? Math.floor(width) : 1;
  const safeHeight: number = Number.isFinite(height) && height > 0 ? Math.floor(height) : 1;
  return {
    data: new Uint8ClampedArray(safeWidth * safeHeight * RGBA_STRIDE),
    width: safeWidth,
    height: safeHeight,
    colorSpace: 'srgb',
  } as ImageData;
}

/**
 * A `CanvasRenderingContext2D` stand-in that records what is done to it.
 *
 * The `context` member is what production code draws on. Everything else is
 * for the test to inspect.
 */
export class CanvasRecording {
  /** Every call and assignment, in order. */
  public readonly operations: RecordedOperation[] = [];

  /** Every gradient the context has created, in order. */
  public readonly gradients: FakeGradient[] = [];

  /** The fake context to hand to production code. */
  public readonly context: CanvasRenderingContext2D;

  /**
   * Supplies the result of `getImageData`. Left null, a zeroed buffer of the
   * requested size is returned.
   */
  public imageDataSource: ((width: number, height: number) => ImageData) | null = null;

  private state: Record<string, unknown> = {...DEFAULT_STATE};
  private readonly stateStack: Record<string, unknown>[] = [];
  private readonly methods: Map<string, (...args: unknown[]) => unknown> = new Map<string, (...args: unknown[]) => unknown>();

  public constructor(public readonly canvas: HTMLCanvasElement) {
    const handler: ProxyHandler<object> = {
      get: (_target: object, property: string | symbol): unknown => this.read(property),
      set: (_target: object, property: string | symbol, value: unknown): boolean => this.write(property, value),
    };
    this.context = new Proxy({}, handler) as CanvasRenderingContext2D;
  }

  /** Arguments of every call to `method`, in order. */
  public callsTo(method: string): ReadonlyArray<readonly unknown[]> {
    return this.calls(method).map((call: RecordedCall): readonly unknown[] => call.args);
  }

  /** Every recorded call to `method`, with the state it was made in. */
  public calls(method: string): readonly RecordedCall[] {
    return this.operations.filter(
      (operation: RecordedOperation): operation is RecordedCall => operation.kind === 'call' && operation.method === method
    );
  }

  /** Every value assigned to `property`, in order. */
  public valuesSetFor(property: string): readonly unknown[] {
    return this.operations
      .filter((operation: RecordedOperation): operation is RecordedSet => operation.kind === 'set' && operation.property === property)
      .map((operation: RecordedSet): unknown => operation.value);
  }

  /** Forgets everything recorded so far. Drawing state is kept. */
  public clear(): void {
    this.operations.length = 0;
    this.gradients.length = 0;
  }

  /**
   * The paths built on this context, one entry per `beginPath()`.
   *
   * Each path is listed as the points it was told to pass through: the target
   * of every `moveTo` and `lineTo`, and the control point of every
   * `quadraticCurveTo`.
   */
  public paths(): RecordedPoint[][] {
    const paths: RecordedPoint[][] = [];
    for (const operation of this.operations) {
      if (operation.kind !== 'call') continue;
      if (operation.method === 'beginPath') {
        paths.push([]);
        continue;
      }
      const isVertex: boolean =
        operation.method === 'moveTo' || operation.method === 'lineTo' || operation.method === 'quadraticCurveTo';
      if (!isVertex || paths.length === 0) continue;
      paths[paths.length - 1].push({x: operation.args[0] as number, y: operation.args[1] as number});
    }
    return paths;
  }

  /**
   * Operations that handed the canvas a number it cannot use: NaN or an
   * infinity, either as a call argument or as an assigned value.
   */
  public nonFiniteOperations(): RecordedOperation[] {
    const isBad: (value: unknown) => boolean = (value: unknown): boolean =>
      typeof value === 'number' && !Number.isFinite(value);
    return this.operations.filter((operation: RecordedOperation): boolean =>
      operation.kind === 'call' ? operation.args.some(isBad) : isBad(operation.value)
    );
  }

  private read(property: string | symbol): unknown {
    if (typeof property === 'symbol') return undefined;
    if (property === 'canvas') return this.canvas;
    if (property in this.state) return this.state[property];

    let method: ((...args: unknown[]) => unknown) | undefined = this.methods.get(property);
    if (!method) {
      method = (...args: unknown[]): unknown => this.invoke(property, args);
      this.methods.set(property, method);
    }
    return method;
  }

  private write(property: string | symbol, value: unknown): boolean {
    if (typeof property === 'symbol') return true;
    this.state[property] = value;
    this.operations.push({kind: 'set', property, value});
    return true;
  }

  private invoke(method: string, args: unknown[]): unknown {
    this.operations.push({kind: 'call', method, args, state: {...this.state}});

    switch (method) {
      case 'save':
        this.stateStack.push({...this.state});
        return undefined;
      case 'restore':
        this.state = this.stateStack.pop() ?? this.state;
        return undefined;
      case 'createLinearGradient':
      case 'createRadialGradient':
      case 'createConicGradient': {
        const gradient: FakeGradient = new FakeGradient(method, args);
        this.gradients.push(gradient);
        return gradient;
      }
      case 'getImageData':
      case 'createImageData': {
        const width: number = args[args.length - 2] as number;
        const height: number = args[args.length - 1] as number;
        return this.imageDataSource ? this.imageDataSource(width, height) : createImageData(width, height);
      }
      default:
        return undefined;
    }
  }
}

// ============================================================================
// WebGL context
// ============================================================================

/** A WebGL context stand-in: every call is counted and succeeds. */
export class WebGLRecording {
  /** Names of the methods called, in order. */
  public readonly calls: string[] = [];

  /** How many times the context has been deliberately lost. */
  public lostContextCount: number = 0;

  /** The fake context to hand to production code. */
  public readonly context: WebGLRenderingContext;

  private readonly methods: Map<string, (...args: unknown[]) => unknown> = new Map<string, (...args: unknown[]) => unknown>();

  public constructor(public readonly canvas: HTMLCanvasElement) {
    const handler: ProxyHandler<object> = {
      get: (_target: object, property: string | symbol): unknown => this.read(property),
    };
    this.context = new Proxy({}, handler) as WebGLRenderingContext;
  }

  private read(property: string | symbol): unknown {
    if (typeof property === 'symbol') return undefined;
    if (property === 'canvas') return this.canvas;
    // Enumerants (gl.TEXTURE_2D and friends) are only ever passed back in.
    if (property === property.toUpperCase()) return 0;

    let method: ((...args: unknown[]) => unknown) | undefined = this.methods.get(property);
    if (!method) {
      method = (...args: unknown[]): unknown => this.invoke(property, args);
      this.methods.set(property, method);
    }
    return method;
  }

  private invoke(method: string, args: unknown[]): unknown {
    this.calls.push(method);
    if (method === 'getExtension') {
      if (args[0] !== 'WEBGL_lose_context') return null;
      return {loseContext: (): void => { this.lostContextCount++; }};
    }
    // Truthy for every create*, get*Parameter and get*Location call.
    return {};
  }
}

// ============================================================================
// Installing the fakes
// ============================================================================

/** Options for {@link installCanvasFakes}. */
export interface CanvasFakeOptions {
  /** Whether canvases can supply a 2D context. Defaults to true. */
  readonly canvas2d?: boolean;
  /** Whether canvases can supply a WebGL context. Defaults to true. */
  readonly webgl?: boolean;
}

/** Handle on the fakes installed by {@link installCanvasFakes}. */
export interface CanvasFakes {
  /** Every 2D recording created so far, in the order contexts were requested. */
  readonly recordings: CanvasRecording[];
  /** Every WebGL recording created so far, in the order contexts were requested. */
  readonly webglRecordings: WebGLRecording[];
  /** The 2D recording for a canvas, creating it if the canvas has none yet. */
  recordingFor(canvas: HTMLCanvasElement): CanvasRecording;
  /** Puts the real `getContext` back. */
  restore(): void;
}

/**
 * Replaces `HTMLCanvasElement.prototype.getContext` so that every canvas hands
 * out a recording context. Call `restore()` on the result when the test ends.
 */
export function installCanvasFakes(options: CanvasFakeOptions = {}): CanvasFakes {
  const allow2d: boolean = options.canvas2d ?? true;
  const allowWebgl: boolean = options.webgl ?? true;
  const original: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext');
  const recordings: CanvasRecording[] = [];
  const webglRecordings: WebGLRecording[] = [];
  const byCanvas: WeakMap<HTMLCanvasElement, CanvasRecording> = new WeakMap<HTMLCanvasElement, CanvasRecording>();
  const webglByCanvas: WeakMap<HTMLCanvasElement, WebGLRecording> = new WeakMap<HTMLCanvasElement, WebGLRecording>();

  const recordingFor: (canvas: HTMLCanvasElement) => CanvasRecording = (canvas: HTMLCanvasElement): CanvasRecording => {
    let recording: CanvasRecording | undefined = byCanvas.get(canvas);
    if (!recording) {
      recording = new CanvasRecording(canvas);
      byCanvas.set(canvas, recording);
      recordings.push(recording);
    }
    return recording;
  };

  const webglRecordingFor: (canvas: HTMLCanvasElement) => WebGLRecording = (canvas: HTMLCanvasElement): WebGLRecording => {
    let recording: WebGLRecording | undefined = webglByCanvas.get(canvas);
    if (!recording) {
      recording = new WebGLRecording(canvas);
      webglByCanvas.set(canvas, recording);
      webglRecordings.push(recording);
    }
    return recording;
  };

  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: function (this: HTMLCanvasElement, contextId: string): unknown {
      if (contextId === '2d') return allow2d ? recordingFor(this).context : null;
      if (contextId === 'webgl' || contextId === 'experimental-webgl') {
        return allowWebgl ? webglRecordingFor(this).context : null;
      }
      return null;
    },
  });

  return {
    recordings,
    webglRecordings,
    recordingFor,
    restore: (): void => {
      if (original) Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', original);
    },
  };
}

// ============================================================================
// Analyser
// ============================================================================

/** Chooses the byte for one slot of an analyser buffer. */
export type SampleSource = (index: number, length: number) => number;

/** Time-domain level of a silent signal: the midpoint of the byte range. */
export const TIME_DOMAIN_SILENCE: number = 128;

/** Largest value an analyser byte can hold. */
export const BYTE_MAX: number = 255;

/** Every slot holds the same value. */
export function constantSamples(value: number): SampleSource {
  return (): number => value;
}

/** `spike` in the slots from `start` up to but excluding `end`, `floor` everywhere else. */
export function spikeSamples(start: number, end: number, spike: number, floor: number): SampleSource {
  return (index: number): number => (index >= start && index < end ? spike : floor);
}

/** A spectrum that is full-scale at the bottom and falls linearly to nothing at the top. */
export function bassHeavySpectrum(): SampleSource {
  return (index: number, length: number): number => Math.round(BYTE_MAX * (1 - index / length));
}

/** An `AnalyserNode` stand-in and the controls for what it reports. */
export interface FakeAnalyser {
  /** The fake node to hand to production code. */
  readonly node: AnalyserNode;
  /** Source for `getByteFrequencyData`. Starts silent (all zero). */
  frequencyData: SampleSource;
  /** Source for `getByteTimeDomainData`. Starts silent (all 128). */
  timeDomainData: SampleSource;
  /** Length of each buffer passed to `getByteFrequencyData`, in order. */
  readonly frequencyReads: number[];
  /** Length of each buffer passed to `getByteTimeDomainData`, in order. */
  readonly timeDomainReads: number[];
}

/** Default FFT size, matching the production default. */
const FAKE_FFT_SIZE: number = 2048;

/**
 * Creates an analyser whose data the test controls.
 *
 * `frequencyBinCount` follows `fftSize`, as it does on a real node.
 */
export function createFakeAnalyser(): FakeAnalyser {
  const fake: {
    node: AnalyserNode;
    frequencyData: SampleSource;
    timeDomainData: SampleSource;
    frequencyReads: number[];
    timeDomainReads: number[];
  } = {
    node: null as unknown as AnalyserNode,
    frequencyData: constantSamples(0),
    timeDomainData: constantSamples(TIME_DOMAIN_SILENCE),
    frequencyReads: [],
    timeDomainReads: [],
  };

  const fill: (array: Uint8Array, source: SampleSource) => void = (array: Uint8Array, source: SampleSource): void => {
    for (let i: number = 0; i < array.length; i++) {
      array[i] = source(i, array.length);
    }
  };

  const node: {
    fftSize: number;
    readonly frequencyBinCount: number;
    getByteFrequencyData: (array: Uint8Array) => void;
    getByteTimeDomainData: (array: Uint8Array) => void;
  } = {
    fftSize: FAKE_FFT_SIZE,
    get frequencyBinCount(): number {
      return this.fftSize / 2;
    },
    getByteFrequencyData: (array: Uint8Array): void => {
      fake.frequencyReads.push(array.length);
      fill(array, fake.frequencyData);
    },
    getByteTimeDomainData: (array: Uint8Array): void => {
      fake.timeDomainReads.push(array.length);
      fill(array, fake.timeDomainData);
    },
  };

  fake.node = node as unknown as AnalyserNode;
  return fake;
}

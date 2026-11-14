/**
 * @fileoverview Unit tests for the AudioOutlet component.
 *
 * The outlet owns the <audio> element, the Web Audio graph, the visualization
 * canvases and the render loop. jsdom provides none of the platform pieces
 * those rest on, so this file installs small fakes for them:
 *
 * - AudioContext and its nodes (recording their connections and gain changes)
 * - a recording CanvasRenderingContext2D, handed out by getContext('2d')
 * - a hand-cranked requestAnimationFrame queue
 * - ResizeObserver, driven explicitly
 * - HTMLMediaElement play/pause/load
 *
 * Timers, Date and performance.now() are faked so fades, settle windows and
 * crossfades can be stepped deterministically. The real visualization classes
 * are used throughout; only the platform underneath them is faked.
 *
 * @module app/components/audio/audio-outlet/audio-outlet.spec
 */

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {computed, signal, type Signal, type WritableSignal} from '@angular/core';
import type {Mock, MockInstance} from 'vitest';
import {AudioOutlet} from './audio-outlet';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import {FileDropService} from '../../../services/file-drop.service';
import {
  SettingsService,
  VISUALIZATION_LOCAL_DEFAULTS,
  type CrossfadeStyle,
  type LocalSettingKey,
  type PerVisualizationSettings,
  type RenderResolution,
  type VisualizationLocalSettings,
} from '../../../services/settings.service';
import type {PlaylistItem} from '../../../types/electron';
import {
  AnalyzerVisualization,
  BlankVisualization,
  ClassicVisualization,
  Visualization,
  VISUALIZATION_TYPES,
} from './visualizations';

// ============================================================================
// Constants
// ============================================================================

/** Media server base URL used by the tests. */
const SERVER_URL: string = 'http://127.0.0.1:4000';

/** Suffix the fake ElectronService.appendAuth adds, to prove URLs pass through it. */
const AUTH_SUFFIX: string = '&token=secret';

/** Audio (gain) fade duration configured in the fake settings, in ms. */
const AUDIO_FADE_MS: number = 200;

/** Visualization crossfade duration configured in the fake settings, in ms. */
const VIZ_CROSSFADE_MS: number = 1000;

/** The outlet ignores server-time corrections for this long after a load. */
const POST_LOAD_GUARD_MS: number = 500;

/** The outlet waits this long after a resize before reallocating canvases. */
const RESIZE_SETTLE_MS: number = 150;

/** The clock sync ignores drift for this long after a load or seek. */
const CLOCK_SETTLE_MS: number = 2000;

/** HTMLMediaElement.HAVE_ENOUGH_DATA. */
const HAVE_ENOUGH_DATA: number = 4;

/** The fake AudioContext's fixed clock reading, in seconds. */
const CONTEXT_TIME: number = 10;

// ============================================================================
// Web Audio fakes
// ============================================================================

/** Fake AudioParam: scheduling calls are recorded, setValueAtTime applies at once. */
class FakeAudioParam {
  public value: number = 0;
  public readonly cancelScheduledValues: Mock<(time: number) => void> = vi.fn();
  public readonly setValueAtTime: Mock<(value: number, time: number) => void> = vi.fn((value: number): void => {
    this.value = value;
  });
  public readonly linearRampToValueAtTime: Mock<(value: number, time: number) => void> = vi.fn();
}

/** Fake AudioNode that records what it has been connected to. */
class FakeAudioNode {
  public readonly outputs: FakeAudioNode[] = [];

  public connect(target: FakeAudioNode): FakeAudioNode {
    this.outputs.push(target);
    return target;
  }
}

/** Fake GainNode. */
class FakeGainNode extends FakeAudioNode {
  public readonly gain: FakeAudioParam = new FakeAudioParam();
}

/** Fake BiquadFilterNode. */
class FakeBiquadFilterNode extends FakeAudioNode {
  public type: string = 'lowpass';
  public readonly frequency: FakeAudioParam = new FakeAudioParam();
  public readonly Q: FakeAudioParam = new FakeAudioParam();
  public readonly gain: FakeAudioParam = new FakeAudioParam();
}

/** Fake AnalyserNode that reports silence. */
class FakeAnalyserNode extends FakeAudioNode {
  public fftSize: number = 2048;
  public smoothingTimeConstant: number = 0;

  public get frequencyBinCount(): number {
    return this.fftSize / 2;
  }

  public getByteFrequencyData(): void { /* silence: leaves the array zeroed */ }
  public getByteTimeDomainData(): void { /* silence: leaves the array zeroed */ }
  public getFloatFrequencyData(): void { /* silence: leaves the array zeroed */ }
  public getFloatTimeDomainData(): void { /* silence: leaves the array zeroed */ }
}

/** Fake MediaElementAudioSourceNode. */
class FakeMediaElementSourceNode extends FakeAudioNode {
  public constructor(public readonly mediaElement: HTMLMediaElement) {
    super();
  }
}

/** Fake AudioContext exposing every node it has created. */
class FakeAudioContext {
  /** Every context constructed since the last reset. */
  public static instances: FakeAudioContext[] = [];

  public state: string = 'suspended';
  public readonly currentTime: number = CONTEXT_TIME;
  public readonly destination: FakeAudioNode = new FakeAudioNode();
  public readonly analysers: FakeAnalyserNode[] = [];
  public readonly gains: FakeGainNode[] = [];
  public readonly filters: FakeBiquadFilterNode[] = [];
  public readonly sources: FakeMediaElementSourceNode[] = [];

  public readonly resume: Mock<() => Promise<void>> = vi.fn((): Promise<void> => {
    this.state = 'running';
    return Promise.resolve();
  });

  public readonly close: Mock<() => Promise<void>> = vi.fn((): Promise<void> => {
    this.state = 'closed';
    return Promise.resolve();
  });

  public constructor(public readonly options?: AudioContextOptions) {
    FakeAudioContext.instances.push(this);
  }

  public createAnalyser(): FakeAnalyserNode {
    const node: FakeAnalyserNode = new FakeAnalyserNode();
    this.analysers.push(node);
    return node;
  }

  public createGain(): FakeGainNode {
    const node: FakeGainNode = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  public createBiquadFilter(): FakeBiquadFilterNode {
    const node: FakeBiquadFilterNode = new FakeBiquadFilterNode();
    this.filters.push(node);
    return node;
  }

  public createMediaElementSource(element: HTMLMediaElement): FakeMediaElementSourceNode {
    const node: FakeMediaElementSourceNode = new FakeMediaElementSourceNode(element);
    this.sources.push(node);
    return node;
  }
}

// ============================================================================
// Canvas, animation frame and ResizeObserver fakes
// ============================================================================

/** Names of the 2D context methods called on each canvas, in call order. */
const canvasCalls: Map<HTMLCanvasElement, string[]> = new Map<HTMLCanvasElement, string[]>();

/** The recording contexts already handed out, one per canvas like the real thing. */
const canvasContexts: Map<HTMLCanvasElement, CanvasRenderingContext2D> = new Map<HTMLCanvasElement, CanvasRenderingContext2D>();

/**
 * Produces a plausible return value for a 2D context method.
 *
 * @param method - The method that was called
 * @param args - The arguments it was called with
 * @returns A gradient, image data or text metrics stand-in where one is expected
 */
function contextResult(method: string, args: readonly unknown[]): unknown {
  if (method.startsWith('create') && method.endsWith('Gradient')) {
    return {addColorStop: (): void => { /* colour stops are not inspected */ }};
  }
  if (method === 'getImageData' || method === 'createImageData') {
    const width: number = Number(args[method === 'getImageData' ? 2 : 0]) || 1;
    const height: number = Number(args[method === 'getImageData' ? 3 : 1]) || 1;
    return {data: new Uint8ClampedArray(width * height * 4), width, height};
  }
  if (method === 'measureText') {
    return {width: 0};
  }
  return undefined;
}

/**
 * Returns the recording 2D context for a canvas, creating it on first use.
 *
 * Every method exists and records its name; every property can be assigned
 * and read back.
 *
 * @param canvas - The canvas the context belongs to
 * @returns The canvas's recording context
 */
function recordingContextFor(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const existing: CanvasRenderingContext2D | undefined = canvasContexts.get(canvas);
  if (existing) return existing;

  const calls: string[] = [];
  const assigned: Map<string | symbol, unknown> = new Map<string | symbol, unknown>();
  const context: CanvasRenderingContext2D = new Proxy({}, {
    get: (_target: object, property: string | symbol): unknown => {
      if (property === 'canvas') return canvas;
      if (assigned.has(property)) return assigned.get(property);
      if (typeof property === 'symbol') return undefined;
      return (...args: unknown[]): unknown => {
        calls.push(property);
        return contextResult(property, args);
      };
    },
    set: (_target: object, property: string | symbol, value: unknown): boolean => {
      assigned.set(property, value);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;

  canvasCalls.set(canvas, calls);
  canvasContexts.set(canvas, context);
  return context;
}

/** A hand-cranked stand-in for the browser's animation frame queue. */
class FrameQueue {
  private nextId: number = 1;
  private readonly pending: Map<number, FrameRequestCallback> = new Map<number, FrameRequestCallback>();

  public readonly request: (callback: FrameRequestCallback) => number = (callback: FrameRequestCallback): number => {
    const id: number = this.nextId++;
    this.pending.set(id, callback);
    return id;
  };

  public readonly cancel: (id: number) => void = (id: number): void => {
    this.pending.delete(id);
  };

  /**
   * Runs every callback that was pending when called, like one display frame.
   *
   * @param timestamp - The frame timestamp passed to each callback
   */
  public run(timestamp: number): void {
    const batch: FrameRequestCallback[] = [...this.pending.values()];
    this.pending.clear();
    for (const callback of batch) {
      callback(timestamp);
    }
  }
}

/** Fake ResizeObserver whose notifications are delivered on demand. */
class FakeResizeObserver {
  /** Every observer constructed since the last reset. */
  public static instances: FakeResizeObserver[] = [];

  public readonly observe: Mock<(target: Element) => void> = vi.fn();
  public readonly unobserve: Mock<(target: Element) => void> = vi.fn();
  public readonly disconnect: Mock<() => void> = vi.fn();

  public constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  /** Delivers a resize notification. */
  public notify(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

// ============================================================================
// Service fakes
// ============================================================================

/** The slice of MediaPlayerService the outlet reads. */
interface MockMediaPlayer {
  readonly currentTrack: WritableSignal<PlaylistItem | null>;
  readonly playbackState: WritableSignal<string>;
  readonly serverUrl: WritableSignal<string>;
  readonly currentTime: WritableSignal<number>;
  readonly volume: WritableSignal<number>;
  readonly muted: WritableSignal<boolean>;
  readonly isPlaying: Signal<boolean>;
}

/** The slice of ElectronService the outlet (and its drop target) uses. */
interface MockElectron {
  readonly isFullscreen: WritableSignal<boolean>;
  readonly forceReloadCounter: WritableSignal<number>;
  readonly fadeOutRequested: WritableSignal<number>;
  readonly menuSelectVisualization: WritableSignal<string>;
  readonly fullscreenTransitionStart: WritableSignal<number>;
  readonly fullscreenTransitionEnd: WritableSignal<number>;
  lastSeekAt: number;
  readonly appendAuth: Mock<(url: string) => string>;
  readonly setStreamingBusy: Mock<(busy: boolean) => void>;
  readonly syncPlaybackTime: Mock<(time: number) => void>;
  readonly signalPlaybackStarted: Mock<() => Promise<void>>;
  readonly toggleFullscreen: Mock<() => Promise<void>>;
  readonly addFilesWithAutoPlay: Mock<(paths: string[]) => Promise<void>>;
}

/** The slice of SettingsService the outlet reads. */
interface MockSettings {
  readonly isLoaded: WritableSignal<boolean>;
  readonly defaultVisualization: WritableSignal<string>;
  readonly equalizerEnabled: WritableSignal<boolean>;
  readonly equalizerBands: WritableSignal<readonly number[]>;
  readonly perVisualizationSettings: WritableSignal<PerVisualizationSettings>;
  readonly fftSize: WritableSignal<number>;
  readonly renderResolution: WritableSignal<RenderResolution>;
  readonly maxFrameRate: WritableSignal<number>;
  readonly crossfadeDuration: WritableSignal<number>;
  readonly visualizationCrossfadeDuration: WritableSignal<number>;
  readonly visualizationCrossfadeStyle: WritableSignal<CrossfadeStyle>;
  readonly setDefaultVisualization: Mock<(type: string) => Promise<void>>;
  getEffectiveSetting<K extends LocalSettingKey>(vizId: string, setting: K): VisualizationLocalSettings[K];
}

/** Creates the MediaPlayerService fake: stopped, nothing loaded, no server yet. */
function createMockMediaPlayer(): MockMediaPlayer {
  const playbackState: WritableSignal<string> = signal<string>('stopped');
  return {
    currentTrack: signal<PlaylistItem | null>(null),
    playbackState,
    serverUrl: signal<string>(''),
    currentTime: signal<number>(0),
    volume: signal<number>(0.8),
    muted: signal<boolean>(false),
    isPlaying: computed((): boolean => playbackState() === 'playing'),
  };
}

/** Creates the ElectronService fake. */
function createMockElectron(): MockElectron {
  return {
    isFullscreen: signal<boolean>(false),
    forceReloadCounter: signal<number>(0),
    fadeOutRequested: signal<number>(0),
    menuSelectVisualization: signal<string>(''),
    fullscreenTransitionStart: signal<number>(0),
    fullscreenTransitionEnd: signal<number>(0),
    lastSeekAt: 0,
    appendAuth: vi.fn((url: string): string => `${url}${AUTH_SUFFIX}`),
    setStreamingBusy: vi.fn(),
    syncPlaybackTime: vi.fn(),
    signalPlaybackStarted: vi.fn((): Promise<void> => Promise.resolve()),
    toggleFullscreen: vi.fn((): Promise<void> => Promise.resolve()),
    addFilesWithAutoPlay: vi.fn((): Promise<void> => Promise.resolve()),
  };
}

/** Creates the SettingsService fake: settings not yet loaded, everything at defaults. */
function createMockSettings(): MockSettings {
  const perVisualizationSettings: WritableSignal<PerVisualizationSettings> = signal<PerVisualizationSettings>({});
  return {
    isLoaded: signal<boolean>(false),
    defaultVisualization: signal<string>('bars'),
    equalizerEnabled: signal<boolean>(false),
    equalizerBands: signal<readonly number[]>([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    perVisualizationSettings,
    fftSize: signal<number>(2048),
    renderResolution: signal<RenderResolution>('native'),
    maxFrameRate: signal<number>(0),
    crossfadeDuration: signal<number>(AUDIO_FADE_MS),
    visualizationCrossfadeDuration: signal<number>(VIZ_CROSSFADE_MS),
    visualizationCrossfadeStyle: signal<CrossfadeStyle>('fade'),
    setDefaultVisualization: vi.fn((): Promise<void> => Promise.resolve()),
    getEffectiveSetting: <K extends LocalSettingKey>(vizId: string, setting: K): VisualizationLocalSettings[K] => {
      const custom: VisualizationLocalSettings[K] | undefined = perVisualizationSettings()[vizId]?.[setting];
      return custom !== undefined ? custom : VISUALIZATION_LOCAL_DEFAULTS[setting];
    },
  };
}

/**
 * Creates a PlaylistItem with sensible defaults.
 *
 * @param overrides - Fields to override
 * @returns A complete PlaylistItem
 */
function createTrack(overrides: Partial<PlaylistItem> = {}): PlaylistItem {
  return {
    id: 'track-1',
    filePath: '/music/song one.mp3',
    title: 'Song One',
    duration: 180,
    type: 'audio',
    ...overrides,
  };
}

/**
 * Builds the stream URL the outlet is expected to request.
 *
 * @param filePath - The track's file path
 * @param cacheBuster - The expected force-reload counter value
 * @param seekTime - The expected baked-in start position, if any
 * @returns The full, authenticated stream URL
 */
function streamUrl(filePath: string, cacheBuster: number = 0, seekTime?: number): string {
  const offset: string = seekTime === undefined ? '' : `&t=${seekTime}`;
  return `${SERVER_URL}/media/stream?path=${encodeURIComponent(filePath)}&r=${cacheBuster}${offset}${AUTH_SUFFIX}`;
}

// ============================================================================
// Tests
// ============================================================================

describe('AudioOutlet', (): void => {
  let fixture: ComponentFixture<AudioOutlet>;
  let component: AudioOutlet;
  let mediaPlayer: MockMediaPlayer;
  let electron: MockElectron;
  let settings: MockSettings;
  let frames: FrameQueue;
  let displaySize: {width: number; height: number};
  let playSpy: MockInstance<() => Promise<void>>;
  let pauseSpy: MockInstance<() => void>;
  let loadSpy: MockInstance<() => void>;

  /** Runs change detection, which also flushes the outlet's effects. */
  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
  }

  /** The outlet's hidden audio element. */
  function audioElement(): HTMLAudioElement {
    return (fixture.nativeElement as HTMLElement).querySelector('audio') as HTMLAudioElement;
  }

  /** The element the visualization canvases are inserted into. */
  function container(): HTMLDivElement {
    return (fixture.nativeElement as HTMLElement).querySelector('.visualizer-container') as HTMLDivElement;
  }

  /** The visualization canvases currently on screen, oldest first. */
  function canvases(): HTMLCanvasElement[] {
    return Array.from(container().querySelectorAll('canvas'));
  }

  /** The single AudioContext the outlet is expected to have created. */
  function audioContext(): FakeAudioContext {
    expect(FakeAudioContext.instances).toHaveLength(1);
    return FakeAudioContext.instances[0];
  }

  /** The gain node that controls output volume. */
  function outputGain(): FakeAudioParam {
    return audioContext().gains[0].gain;
  }

  /** Performs the first user gesture, which builds the audio graph. */
  function gesture(): void {
    document.dispatchEvent(new MouseEvent('click'));
  }

  /**
   * Advances the clock and then renders one display frame.
   *
   * @param elapsedMs - Time since the previous frame
   */
  function renderFrame(elapsedMs: number = 16): void {
    vi.advanceTimersByTime(elapsedMs);
    frames.run(performance.now());
  }

  /**
   * Overrides read-only media state jsdom never changes on its own.
   *
   * @param state - The element properties to pin
   */
  function setElementState(state: Partial<Pick<HTMLMediaElement, 'paused' | 'seeking' | 'readyState' | 'currentTime'>>): void {
    for (const [key, value] of Object.entries(state)) {
      Object.defineProperty(audioElement(), key, {value, writable: true, configurable: true});
    }
  }

  /**
   * Makes a track current on a running media server.
   *
   * @param track - The track to select
   * @param state - The playback state the server reports alongside it
   */
  async function loadTrack(track: PlaylistItem = createTrack(), state: string = 'playing'): Promise<void> {
    mediaPlayer.serverUrl.set(SERVER_URL);
    mediaPlayer.playbackState.set(state);
    mediaPlayer.currentTrack.set(track);
    await settle();
  }

  beforeEach(async (): Promise<void> => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance']});

    FakeAudioContext.instances = [];
    FakeResizeObserver.instances = [];
    canvasCalls.clear();
    canvasContexts.clear();
    frames = new FrameQueue();
    displaySize = {width: 800, height: 600};

    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('requestAnimationFrame', frames.request);
    vi.stubGlobal('cancelAnimationFrame', frames.cancel);

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function (this: HTMLCanvasElement, contextId: string): RenderingContext | null {
        return contextId === '2d' ? recordingContextFor(this) : null;
      }
    );
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      (): DOMRect => ({
        x: 0, y: 0, top: 0, left: 0,
        right: displaySize.width, bottom: displaySize.height,
        width: displaySize.width, height: displaySize.height,
      }) as DOMRect
    );
    playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation((): Promise<void> => Promise.resolve());
    pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation((): void => { /* jsdom cannot pause */ });
    loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation((): void => { /* jsdom cannot load */ });
    vi.spyOn(console, 'log').mockImplementation((): void => { /* load/seek chatter */ });

    mediaPlayer = createMockMediaPlayer();
    electron = createMockElectron();
    settings = createMockSettings();

    await TestBed.configureTestingModule({
      imports: [AudioOutlet],
      providers: [
        {provide: MediaPlayerService, useValue: mediaPlayer},
        {provide: ElectronService, useValue: electron},
        {provide: SettingsService, useValue: settings},
        {provide: FileDropService, useValue: {hasValidFiles: vi.fn((): boolean => true), extractMediaFilePaths: vi.fn((): string[] => [])}},
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AudioOutlet);
    component = fixture.componentInstance;
    setElementState({currentTime: 0});
    await settle();

    // The initial 'stopped' state pauses the element once; start each test clean.
    pauseSpy.mockClear();
  });

  afterEach((): void => {
    fixture.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ==========================================================================
  // Audio source
  // ==========================================================================

  describe('audio source', (): void => {
    it('points the audio element at the authenticated stream URL of the current track', async (): Promise<void> => {
      const track: PlaylistItem = createTrack();

      await loadTrack(track);

      expect(audioElement().src).toBe(streamUrl(track.filePath));
      expect(loadSpy).toHaveBeenCalledTimes(1);
    });

    it('does not load anything until the media server URL is known', async (): Promise<void> => {
      mediaPlayer.currentTrack.set(createTrack());
      await settle();

      expect(audioElement().getAttribute('src')).toBeNull();
      expect(loadSpy).not.toHaveBeenCalled();
    });

    it('ignores video tracks', async (): Promise<void> => {
      await loadTrack(createTrack({type: 'video', filePath: '/video/film.mp4'}));

      expect(loadSpy).not.toHaveBeenCalled();
    });

    it('follows the current track when it changes', async (): Promise<void> => {
      await loadTrack(createTrack());
      const next: PlaylistItem = createTrack({id: 'track-2', filePath: '/music/song two.mp3'});

      mediaPlayer.currentTrack.set(next);
      await settle();

      expect(audioElement().src).toBe(streamUrl(next.filePath));
      expect(loadSpy).toHaveBeenCalledTimes(2);
    });

    it('keeps the loaded source when only the playback state changes', async (): Promise<void> => {
      await loadTrack(createTrack());

      mediaPlayer.playbackState.set('paused');
      await settle();

      expect(loadSpy).toHaveBeenCalledTimes(1);
    });

    it('reloads the same track when the server re-enters loading', async (): Promise<void> => {
      await loadTrack(createTrack());

      mediaPlayer.playbackState.set('loading');
      await settle();

      expect(loadSpy).toHaveBeenCalledTimes(2);
    });

    it('reloads with a new cache-buster when a forced reload is requested', async (): Promise<void> => {
      const track: PlaylistItem = createTrack();
      await loadTrack(track);

      electron.forceReloadCounter.set(1);
      await settle();

      expect(audioElement().src).toBe(streamUrl(track.filePath, 1));
    });

    it('starts playback straight away while the server is waiting in loading', async (): Promise<void> => {
      await loadTrack(createTrack(), 'loading');

      expect(playSpy).toHaveBeenCalledTimes(1);
    });

    it('does not start playback for a track loaded while stopped', async (): Promise<void> => {
      await loadTrack(createTrack(), 'stopped');

      expect(playSpy).not.toHaveBeenCalled();
    });

    it('logs a rejected play() instead of leaving it unhandled', async (): Promise<void> => {
      const failure: Error = new Error('NotAllowedError');
      const errorSpy: MockInstance<(...data: unknown[]) => void> = vi.spyOn(console, 'error').mockImplementation((): void => { /* expected */ });
      playSpy.mockImplementation((): Promise<void> => Promise.reject(failure));

      await loadTrack(createTrack(), 'loading');
      await Promise.resolve();

      expect(errorSpy).toHaveBeenCalledWith(failure);
    });

    describe('resuming after a stop', (): void => {
      /** Plays a track, stops it, seeks to 42s while stopped, then restarts it. */
      async function playStopSeekRestart(track: PlaylistItem): Promise<void> {
        await loadTrack(track, 'loading');
        mediaPlayer.playbackState.set('playing');
        await settle();
        mediaPlayer.playbackState.set('stopped');
        await settle();
        mediaPlayer.currentTime.set(42);
        mediaPlayer.playbackState.set('loading');
        await settle();
      }

      it('positions a local track at the server time once it can play', async (): Promise<void> => {
        await playStopSeekRestart(createTrack());

        audioElement().dispatchEvent(new Event('canplay'));

        expect(audioElement().currentTime).toBe(42);
      });

      it('leaves the element at the start until the new source can play', async (): Promise<void> => {
        await playStopSeekRestart(createTrack());

        expect(audioElement().currentTime).toBe(0);
      });

      it('applies the resume position only once', async (): Promise<void> => {
        await playStopSeekRestart(createTrack());
        audioElement().dispatchEvent(new Event('canplay'));
        setElementState({currentTime: 50});

        audioElement().dispatchEvent(new Event('canplay'));

        expect(audioElement().currentTime).toBe(50);
      });

      it('drops a pending resume when another track loads before the first can play', async (): Promise<void> => {
        await playStopSeekRestart(createTrack());

        mediaPlayer.currentTrack.set(createTrack({id: 'track-2', filePath: '/music/song two.mp3'}));
        await settle();
        audioElement().dispatchEvent(new Event('canplay'));

        expect(audioElement().currentTime).toBe(0);
      });

      it('drops a pending resume when the outlet is destroyed', async (): Promise<void> => {
        await playStopSeekRestart(createTrack());
        const audio: HTMLAudioElement = audioElement();

        fixture.destroy();
        audio.dispatchEvent(new Event('canplay'));

        expect(audio.currentTime).toBe(0);
      });

      it('bakes the resume position into a remote stream URL instead of seeking', async (): Promise<void> => {
        const remote: PlaylistItem = createTrack({filePath: 'https://example.com/live.mp3'});

        await playStopSeekRestart(remote);
        audioElement().dispatchEvent(new Event('canplay'));

        expect(audioElement().src).toBe(streamUrl(remote.filePath, 0, 42));
        expect(audioElement().currentTime).toBe(0);
      });
    });

    it('shows the streaming-busy cursor while a remote stream spins up', async (): Promise<void> => {
      await loadTrack(createTrack({filePath: 'https://example.com/live.mp3'}));

      expect(electron.setStreamingBusy).toHaveBeenCalledWith(true);
    });

    it('does not show the streaming-busy cursor for a local file', async (): Promise<void> => {
      await loadTrack(createTrack());

      expect(electron.setStreamingBusy).not.toHaveBeenCalledWith(true);
    });
  });

  // ==========================================================================
  // Web Audio graph
  // ==========================================================================

  describe('audio graph', (): void => {
    it('is not built before a user gesture or a load', (): void => {
      expect(FakeAudioContext.instances).toHaveLength(0);
    });

    it('is built on the first click', (): void => {
      gesture();

      expect(FakeAudioContext.instances).toHaveLength(1);
    });

    it('is built on the first key press', (): void => {
      document.dispatchEvent(new KeyboardEvent('keydown'));

      expect(FakeAudioContext.instances).toHaveLength(1);
    });

    it('is built only once however many gestures follow', (): void => {
      gesture();

      gesture();
      document.dispatchEvent(new KeyboardEvent('keydown'));

      expect(FakeAudioContext.instances).toHaveLength(1);
    });

    it('is built by the first load when no gesture has happened yet', async (): Promise<void> => {
      await loadTrack(createTrack());

      expect(FakeAudioContext.instances).toHaveLength(1);
    });

    it('routes the audio element through the equalizer and analyser to the output gain', (): void => {
      gesture();

      const context: FakeAudioContext = audioContext();
      const lastFilter: FakeBiquadFilterNode = context.filters[context.filters.length - 1];
      expect(context.sources[0].mediaElement).toBe(audioElement());
      expect(context.sources[0].outputs).toEqual([context.filters[0]]);
      expect(lastFilter.outputs).toEqual([context.analysers[0]]);
      expect(context.analysers[0].outputs).toEqual([context.gains[0]]);
      expect(context.gains[0].outputs).toEqual([context.destination]);
    });

    it('starts with the output gain at zero so playback can fade in', (): void => {
      gesture();

      expect(outputGain().value).toBe(0);
    });

    it('resumes the suspended context on the gesture', (): void => {
      gesture();

      expect(audioContext().resume).toHaveBeenCalledTimes(1);
    });

    it('resumes a context built by a load when the first gesture arrives', async (): Promise<void> => {
      await loadTrack(createTrack(), 'stopped');

      gesture();

      expect(audioContext().resume).toHaveBeenCalledTimes(1);
    });

    it('resumes a suspended context when playback starts', async (): Promise<void> => {
      await loadTrack(createTrack(), 'stopped');
      expect(audioContext().resume).not.toHaveBeenCalled();

      mediaPlayer.playbackState.set('playing');
      await settle();

      expect(audioContext().resume).toHaveBeenCalledTimes(1);
    });

    it('closes the context when the outlet is destroyed', (): void => {
      gesture();

      fixture.destroy();

      expect(audioContext().close).toHaveBeenCalledTimes(1);
    });

    it('swallows a failure to close the context during teardown', async (): Promise<void> => {
      gesture();
      audioContext().close.mockImplementation((): Promise<void> => Promise.reject(new Error('already closed')));

      fixture.destroy();
      await Promise.resolve();

      // An unhandled rejection would fail the run; reaching here means it was caught.
      expect(audioContext().close).toHaveBeenCalledTimes(1);
    });

    it('stops listening for the first gesture once destroyed', (): void => {
      fixture.destroy();

      gesture();

      expect(FakeAudioContext.instances).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Equalizer
  // ==========================================================================

  describe('equalizer', (): void => {
    const BANDS: readonly number[] = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2];

    /** The gain of every equalizer band filter, in band order. */
    function filterGains(): number[] {
      return audioContext().filters.map((filter: FakeBiquadFilterNode): number => filter.gain.value);
    }

    it('applies the saved bands when the filter chain is created', async (): Promise<void> => {
      settings.equalizerEnabled.set(true);
      settings.equalizerBands.set(BANDS);
      await settle();

      gesture();

      expect(filterGains()).toEqual(BANDS);
    });

    it('leaves every band flat while the equalizer is disabled', async (): Promise<void> => {
      settings.equalizerBands.set(BANDS);
      await settle();

      gesture();

      expect(filterGains()).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('follows band changes made after the chain exists', async (): Promise<void> => {
      settings.equalizerEnabled.set(true);
      gesture();

      settings.equalizerBands.set(BANDS);
      await settle();

      expect(filterGains()).toEqual(BANDS);
    });

    it('flattens the bands when the equalizer is switched off', async (): Promise<void> => {
      settings.equalizerEnabled.set(true);
      settings.equalizerBands.set(BANDS);
      gesture();
      await settle();

      settings.equalizerEnabled.set(false);
      await settle();

      expect(filterGains()).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    });
  });

  // ==========================================================================
  // Volume and mute
  // ==========================================================================

  describe('volume and mute', (): void => {
    beforeEach(async (): Promise<void> => {
      gesture();
      await settle();
    });

    it('applies a volume change to the output gain', async (): Promise<void> => {
      mediaPlayer.volume.set(0.4);
      await settle();

      expect(outputGain().value).toBe(0.4);
    });

    it('cancels any scheduled fade before applying a volume change', async (): Promise<void> => {
      outputGain().cancelScheduledValues.mockClear();

      mediaPlayer.volume.set(0.4);
      await settle();

      expect(outputGain().cancelScheduledValues).toHaveBeenCalledWith(CONTEXT_TIME);
    });

    it('silences the output gain when muted', async (): Promise<void> => {
      mediaPlayer.volume.set(0.4);
      await settle();

      mediaPlayer.muted.set(true);
      await settle();

      expect(outputGain().value).toBe(0);
    });

    it('keeps the output silent when the volume changes while muted', async (): Promise<void> => {
      mediaPlayer.muted.set(true);
      await settle();

      mediaPlayer.volume.set(0.9);
      await settle();

      expect(outputGain().value).toBe(0);
    });

    it('restores the current volume when unmuted', async (): Promise<void> => {
      mediaPlayer.muted.set(true);
      await settle();
      mediaPlayer.volume.set(0.9);
      await settle();

      mediaPlayer.muted.set(false);
      await settle();

      expect(outputGain().value).toBe(0.9);
    });

    it('ramps the output to silence over the requested time when the window is closing', async (): Promise<void> => {
      electron.fadeOutRequested.set(500);
      await settle();

      expect(outputGain().linearRampToValueAtTime).toHaveBeenLastCalledWith(0, CONTEXT_TIME + 0.5);
    });
  });

  // ==========================================================================
  // Playback state
  // ==========================================================================

  describe('playback state', (): void => {
    describe('with the audio graph running', (): void => {
      beforeEach(async (): Promise<void> => {
        await loadTrack(createTrack(), 'stopped');
        playSpy.mockClear();
        pauseSpy.mockClear();
        outputGain().linearRampToValueAtTime.mockClear();
      });

      it('plays the element when the server starts playing', async (): Promise<void> => {
        mediaPlayer.playbackState.set('playing');
        await settle();

        expect(playSpy).toHaveBeenCalledTimes(1);
      });

      it('fades the output in to the current volume when playing', async (): Promise<void> => {
        mediaPlayer.playbackState.set('playing');
        await settle();

        expect(outputGain().linearRampToValueAtTime).toHaveBeenLastCalledWith(0.8, CONTEXT_TIME + AUDIO_FADE_MS / 1000);
      });

      it('keeps the output silent when playback starts muted', async (): Promise<void> => {
        mediaPlayer.muted.set(true);

        mediaPlayer.playbackState.set('playing');
        await settle();

        expect(outputGain().linearRampToValueAtTime).toHaveBeenLastCalledWith(0, CONTEXT_TIME + AUDIO_FADE_MS / 1000);
      });

      it('fades the output out before pausing', async (): Promise<void> => {
        mediaPlayer.playbackState.set('playing');
        await settle();

        mediaPlayer.playbackState.set('paused');
        await settle();

        expect(outputGain().linearRampToValueAtTime).toHaveBeenLastCalledWith(0, CONTEXT_TIME + AUDIO_FADE_MS / 1000);
        expect(pauseSpy).not.toHaveBeenCalled();
      });

      it('pauses the element once the fade-out has finished', async (): Promise<void> => {
        mediaPlayer.playbackState.set('playing');
        await settle();
        mediaPlayer.playbackState.set('paused');
        await settle();

        vi.advanceTimersByTime(AUDIO_FADE_MS);

        expect(pauseSpy).toHaveBeenCalledTimes(1);
      });

      it('pauses and rewinds the element once a stop has faded out', async (): Promise<void> => {
        mediaPlayer.playbackState.set('playing');
        await settle();
        setElementState({currentTime: 50});

        mediaPlayer.playbackState.set('stopped');
        await settle();
        vi.advanceTimersByTime(AUDIO_FADE_MS);

        expect(pauseSpy).toHaveBeenCalledTimes(1);
        expect(audioElement().currentTime).toBe(0);
      });

      it('does not rewind the element before a stop has faded out', async (): Promise<void> => {
        mediaPlayer.playbackState.set('playing');
        await settle();
        setElementState({currentTime: 50});

        mediaPlayer.playbackState.set('stopped');
        await settle();
        vi.advanceTimersByTime(AUDIO_FADE_MS - 1);

        expect(audioElement().currentTime).toBe(50);
      });

      it('cancels a pending pause when playback resumes inside the fade window', async (): Promise<void> => {
        mediaPlayer.playbackState.set('playing');
        await settle();
        mediaPlayer.playbackState.set('paused');
        await settle();
        vi.advanceTimersByTime(AUDIO_FADE_MS / 2);

        mediaPlayer.playbackState.set('playing');
        await settle();
        vi.advanceTimersByTime(AUDIO_FADE_MS * 2);

        expect(pauseSpy).not.toHaveBeenCalled();
      });

      it('cancels a pending pause when the outlet is destroyed', async (): Promise<void> => {
        mediaPlayer.playbackState.set('playing');
        await settle();
        mediaPlayer.playbackState.set('paused');
        await settle();

        fixture.destroy();
        vi.advanceTimersByTime(AUDIO_FADE_MS * 2);

        expect(pauseSpy).not.toHaveBeenCalled();
      });

      it('pauses immediately when fading is disabled', async (): Promise<void> => {
        settings.crossfadeDuration.set(0);
        mediaPlayer.playbackState.set('playing');
        await settle();

        mediaPlayer.playbackState.set('paused');
        await settle();

        expect(pauseSpy).toHaveBeenCalledTimes(1);
        expect(outputGain().value).toBe(0);
      });
    });

    it('pauses immediately when there is no audio graph to fade', async (): Promise<void> => {
      mediaPlayer.playbackState.set('paused');
      await settle();

      expect(pauseSpy).toHaveBeenCalledTimes(1);
    });

    it('does not try to play an element with no source', async (): Promise<void> => {
      mediaPlayer.playbackState.set('playing');
      await settle();

      expect(playSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Seeking
  // ==========================================================================

  describe('seeking', (): void => {
    describe('a local file', (): void => {
      beforeEach(async (): Promise<void> => {
        await loadTrack(createTrack());
      });

      it('moves the element to the server time when they differ by more than a second', async (): Promise<void> => {
        vi.advanceTimersByTime(POST_LOAD_GUARD_MS);

        mediaPlayer.currentTime.set(30);
        await settle();

        expect(audioElement().currentTime).toBe(30);
      });

      it('leaves the element alone for ordinary clock ticks', async (): Promise<void> => {
        vi.advanceTimersByTime(POST_LOAD_GUARD_MS);

        mediaPlayer.currentTime.set(0.5);
        await settle();

        expect(audioElement().currentTime).toBe(0);
      });

      it('ignores server time just after a load, which may still be the previous track', async (): Promise<void> => {
        vi.advanceTimersByTime(POST_LOAD_GUARD_MS - 1);

        mediaPlayer.currentTime.set(30);
        await settle();

        expect(audioElement().currentTime).toBe(0);
      });

      it('does not seek again while the element is already seeking', async (): Promise<void> => {
        vi.advanceTimersByTime(POST_LOAD_GUARD_MS);
        setElementState({seeking: true});

        mediaPlayer.currentTime.set(30);
        await settle();

        expect(audioElement().currentTime).toBe(0);
      });

      it('does not reposition an element that is still playing out a stop fade', async (): Promise<void> => {
        vi.advanceTimersByTime(POST_LOAD_GUARD_MS);
        setElementState({paused: false, currentTime: 50});
        mediaPlayer.playbackState.set('stopped');
        await settle();

        mediaPlayer.currentTime.set(0);
        await settle();

        expect(audioElement().currentTime).toBe(50);
      });
    });

    describe('a remote stream', (): void => {
      const REMOTE: PlaylistItem = createTrack({filePath: 'https://example.com/live.mp3'});

      beforeEach(async (): Promise<void> => {
        await loadTrack(REMOTE);
        vi.advanceTimersByTime(POST_LOAD_GUARD_MS);
        loadSpy.mockClear();
        playSpy.mockClear();
        electron.setStreamingBusy.mockClear();
      });

      it('reloads the stream at the target position instead of seeking the element', async (): Promise<void> => {
        mediaPlayer.currentTime.set(100);
        await settle();

        expect(audioElement().src).toBe(streamUrl(REMOTE.filePath, 0, 100));
        expect(loadSpy).toHaveBeenCalledTimes(1);
        expect(audioElement().currentTime).toBe(0);
      });

      it('resumes playback of the reloaded stream', async (): Promise<void> => {
        mediaPlayer.currentTime.set(100);
        await settle();

        expect(playSpy).toHaveBeenCalledTimes(1);
      });

      it('shows the streaming-busy cursor while the stream restarts', async (): Promise<void> => {
        mediaPlayer.currentTime.set(100);
        await settle();

        expect(electron.setStreamingBusy).toHaveBeenCalledWith(true);
      });

      it('tolerates up to two seconds of drift without reloading', async (): Promise<void> => {
        mediaPlayer.currentTime.set(1.5);
        await settle();

        expect(loadSpy).not.toHaveBeenCalled();
      });

      it('does not start a second reload while one is in flight', async (): Promise<void> => {
        mediaPlayer.currentTime.set(100);
        await settle();
        vi.advanceTimersByTime(POST_LOAD_GUARD_MS * 4);

        mediaPlayer.currentTime.set(200);
        await settle();

        expect(loadSpy).toHaveBeenCalledTimes(1);
      });

      it('anchors the server clock to the stream position once the reloaded stream plays', async (): Promise<void> => {
        mediaPlayer.currentTime.set(100);
        await settle();
        setElementState({currentTime: 3});

        audioElement().dispatchEvent(new Event('playing'));

        expect(electron.syncPlaybackTime).toHaveBeenCalledWith(103);
      });

      it('reloads without playing when the seek happens while paused', async (): Promise<void> => {
        mediaPlayer.playbackState.set('paused');
        await settle();
        playSpy.mockClear();

        mediaPlayer.currentTime.set(100);
        await settle();

        expect(loadSpy).toHaveBeenCalledTimes(1);
        expect(playSpy).not.toHaveBeenCalled();
      });

      it('retries a seek that could not be served because the media server was unavailable', async (): Promise<void> => {
        mediaPlayer.serverUrl.set('');
        mediaPlayer.currentTime.set(100);
        await settle();
        expect(loadSpy).not.toHaveBeenCalled();
        mediaPlayer.serverUrl.set(SERVER_URL);
        vi.advanceTimersByTime(POST_LOAD_GUARD_MS * 4);

        mediaPlayer.currentTime.set(200);
        await settle();

        expect(audioElement().src).toBe(streamUrl(REMOTE.filePath, 0, 200));
      });

      it('reports the stream position, not the element position, when the server clock drifts', async (): Promise<void> => {
        mediaPlayer.currentTime.set(100);
        await settle();
        audioElement().dispatchEvent(new Event('playing'));
        electron.syncPlaybackTime.mockClear();
        vi.advanceTimersByTime(CLOCK_SETTLE_MS);
        setElementState({paused: false, readyState: HAVE_ENOUGH_DATA, currentTime: 5});

        audioElement().dispatchEvent(new Event('timeupdate'));

        expect(electron.syncPlaybackTime).toHaveBeenCalledWith(105);
      });

      it('measures drift from the reloaded position afterwards', async (): Promise<void> => {
        mediaPlayer.currentTime.set(100);
        await settle();
        audioElement().dispatchEvent(new Event('playing'));
        vi.advanceTimersByTime(POST_LOAD_GUARD_MS * 4);
        setElementState({currentTime: 1});

        mediaPlayer.currentTime.set(101.5);
        await settle();

        expect(loadSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ==========================================================================
  // Media element events
  // ==========================================================================

  describe('media element events', (): void => {
    it('tells the server when the element actually starts playing', (): void => {
      audioElement().dispatchEvent(new Event('playing'));

      expect(electron.signalPlaybackStarted).toHaveBeenCalledTimes(1);
    });

    it('clears the streaming-busy cursor when the element starts playing', (): void => {
      audioElement().dispatchEvent(new Event('playing'));

      expect(electron.setStreamingBusy).toHaveBeenLastCalledWith(false);
    });

    it('does not re-anchor the server clock on an ordinary playing event', (): void => {
      audioElement().dispatchEvent(new Event('playing'));

      expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
    });

    describe('while playing a settled track', (): void => {
      beforeEach(async (): Promise<void> => {
        await loadTrack(createTrack());
        vi.advanceTimersByTime(CLOCK_SETTLE_MS);
        setElementState({paused: false, readyState: HAVE_ENOUGH_DATA, currentTime: 20});
        mediaPlayer.currentTime.set(20);
        await settle();
      });

      it('reports the element position on timeupdate when the server clock has drifted', (): void => {
        setElementState({currentTime: 21});

        audioElement().dispatchEvent(new Event('timeupdate'));

        expect(electron.syncPlaybackTime).toHaveBeenCalledWith(21);
      });

      it('reports nothing on timeupdate while the clocks agree', (): void => {
        setElementState({currentTime: 20.2});

        audioElement().dispatchEvent(new Event('timeupdate'));

        expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
      });

      it('holds the server clock at the element position while the element is buffering', (): void => {
        audioElement().dispatchEvent(new Event('waiting'));

        vi.advanceTimersByTime(2000);

        expect(electron.syncPlaybackTime).toHaveBeenCalledTimes(3);
        expect(electron.syncPlaybackTime).toHaveBeenLastCalledWith(20);
      });

      it('releases the server clock when playback resumes after buffering', (): void => {
        audioElement().dispatchEvent(new Event('waiting'));
        audioElement().dispatchEvent(new Event('playing'));
        electron.syncPlaybackTime.mockClear();

        vi.advanceTimersByTime(5000);

        expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
      });

      it('releases the server clock when destroyed while buffering', (): void => {
        audioElement().dispatchEvent(new Event('waiting'));
        electron.syncPlaybackTime.mockClear();

        fixture.destroy();
        vi.advanceTimersByTime(5000);

        expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
      });

      it('stops reporting element events once destroyed', (): void => {
        const audio: HTMLAudioElement = audioElement();
        setElementState({currentTime: 30});

        fixture.destroy();
        audio.dispatchEvent(new Event('playing'));
        audio.dispatchEvent(new Event('timeupdate'));
        audio.dispatchEvent(new Event('waiting'));

        expect(electron.signalPlaybackStarted).not.toHaveBeenCalled();
        expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
      });
    });

    it('clears the streaming-busy cursor when destroyed', (): void => {
      fixture.destroy();

      expect(electron.setStreamingBusy).toHaveBeenLastCalledWith(false);
    });
  });

  // ==========================================================================
  // Host element
  // ==========================================================================

  describe('host element', (): void => {
    it('toggles fullscreen when the visualizer is double-clicked', (): void => {
      container().dispatchEvent(new MouseEvent('dblclick'));

      expect(electron.toggleFullscreen).toHaveBeenCalledTimes(1);
    });

    it('carries the fullscreen class while the window is fullscreen', async (): Promise<void> => {
      electron.isFullscreen.set(true);
      await settle();

      expect((fixture.nativeElement as HTMLElement).classList.contains('fullscreen')).toBe(true);
    });

    it('does not carry the fullscreen class in a normal window', (): void => {
      expect((fixture.nativeElement as HTMLElement).classList.contains('fullscreen')).toBe(false);
    });

    it('exposes the current track', (): void => {
      const track: PlaylistItem = createTrack();

      mediaPlayer.currentTrack.set(track);

      expect(component.currentTrack()).toBe(track);
    });
  });

  // ==========================================================================
  // Visualization selection
  // ==========================================================================

  describe('visualization selection', (): void => {
    let emitted: string[];
    let analyzerDraw: MockInstance<() => void>;
    let classicDraw: MockInstance<() => void>;

    beforeEach((): void => {
      emitted = [];
      component.visualizationChange.subscribe((value: string): void => {
        emitted.push(value);
      });
      analyzerDraw = vi.spyOn(AnalyzerVisualization.prototype, 'draw');
      classicDraw = vi.spyOn(ClassicVisualization.prototype, 'draw');
    });

    it('shows nothing until the analyser exists', (): void => {
      expect(canvases()).toHaveLength(0);
    });

    it('puts one canvas on screen once the audio graph is built', (): void => {
      gesture();

      expect(canvases()).toHaveLength(1);
    });

    it('creates the analyzer by default', async (): Promise<void> => {
      gesture();
      mediaPlayer.playbackState.set('playing');
      await settle();

      renderFrame();

      expect(analyzerDraw).toHaveBeenCalledTimes(1);
    });

    it('renders the active visualization into its own canvas', async (): Promise<void> => {
      gesture();
      mediaPlayer.playbackState.set('playing');
      await settle();

      renderFrame();

      expect(canvasCalls.get(canvases()[0])).toContain('clearRect');
    });

    it('announces the visualization it created', (): void => {
      gesture();

      expect(emitted).toEqual(['Bars & Waves : Analyzer']);
      expect(component.visualizationName()).toBe('Analyzer');
      expect(component.visualizationCategory()).toBe('Bars & Waves');
    });

    it('records a selection made before the analyser exists without creating anything', (): void => {
      component.setVisualization('waveform');

      expect(component.visualizationName()).toBe('Classic');
      expect(emitted).toEqual(['waveform']);
      expect(canvases()).toHaveLength(0);
    });

    it('creates the selected type once the analyser becomes available', async (): Promise<void> => {
      component.setVisualization('waveform');
      gesture();
      mediaPlayer.playbackState.set('playing');
      await settle();

      renderFrame();

      expect(classicDraw).toHaveBeenCalledTimes(1);
      expect(analyzerDraw).not.toHaveBeenCalled();
    });

    it('persists a selection so it survives the outlet being recreated', (): void => {
      component.setVisualization('waveform');

      expect(settings.setDefaultVisualization).toHaveBeenCalledWith('waveform');
    });

    it('applies the saved default once settings have loaded, without persisting it again', async (): Promise<void> => {
      settings.defaultVisualization.set('waveform');
      settings.isLoaded.set(true);
      await settle();

      expect(component.visualizationName()).toBe('Classic');
      expect(settings.setDefaultVisualization).not.toHaveBeenCalled();
    });

    it('applies the saved default only once', async (): Promise<void> => {
      settings.isLoaded.set(true);
      await settle();

      settings.defaultVisualization.set('waveform');
      await settle();

      expect(component.visualizationName()).toBe('Analyzer');
    });

    it('switches to the visualization chosen from the application menu', async (): Promise<void> => {
      electron.menuSelectVisualization.set('waveform');
      await settle();

      expect(component.visualizationName()).toBe('Classic');
      expect(electron.menuSelectVisualization()).toBe('');
    });

    it('ignores an unknown visualization id from the menu', async (): Promise<void> => {
      electron.menuSelectVisualization.set('no-such-visualization');
      await settle();

      expect(emitted).toEqual([]);
    });

    it('steps forward through the visualization list', (): void => {
      component.nextVisualization();

      expect(emitted).toEqual([VISUALIZATION_TYPES[1]]);
    });

    it('wraps from the last visualization to the first', (): void => {
      component.setVisualization(VISUALIZATION_TYPES[VISUALIZATION_TYPES.length - 1]);

      component.nextVisualization();

      expect(emitted[emitted.length - 1]).toBe(VISUALIZATION_TYPES[0]);
    });

    it('steps backward through the visualization list', (): void => {
      component.setVisualization(VISUALIZATION_TYPES[1]);

      component.previousVisualization();

      expect(emitted[emitted.length - 1]).toBe(VISUALIZATION_TYPES[0]);
    });

    it('wraps backward from the first visualization to the last', (): void => {
      component.previousVisualization();

      expect(emitted).toEqual([VISUALIZATION_TYPES[VISUALIZATION_TYPES.length - 1]]);
    });
  });

  // ==========================================================================
  // Visualization crossfade
  // ==========================================================================

  describe('visualization crossfade', (): void => {
    let analyzerDraw: MockInstance<() => void>;
    let classicDraw: MockInstance<() => void>;

    /** The canvas fading out. */
    function outgoing(): HTMLCanvasElement {
      return canvases()[0];
    }

    /** The canvas fading in. */
    function incoming(): HTMLCanvasElement {
      return canvases()[1];
    }

    beforeEach((): void => {
      analyzerDraw = vi.spyOn(AnalyzerVisualization.prototype, 'draw');
      classicDraw = vi.spyOn(ClassicVisualization.prototype, 'draw');
      gesture();
    });

    it('keeps the outgoing canvas on screen beside the incoming one', (): void => {
      component.setVisualization('waveform');

      expect(canvases()).toHaveLength(2);
    });

    it('starts with the outgoing canvas opaque and the incoming one transparent', (): void => {
      component.setVisualization('waveform');

      expect(outgoing().style.opacity).toBe('1');
      expect(incoming().style.opacity).toBe('0');
    });

    it('keeps drawing both visualizations during the transition, even when stopped', (): void => {
      component.setVisualization('waveform');

      renderFrame();

      expect(analyzerDraw).toHaveBeenCalledTimes(1);
      expect(classicDraw).toHaveBeenCalledTimes(1);
    });

    it('is half way through the blend at half the configured duration', (): void => {
      component.setVisualization('waveform');

      renderFrame(VIZ_CROSSFADE_MS / 2);

      expect(outgoing().style.opacity).toBe('0.5');
      expect(incoming().style.opacity).toBe('0.5');
    });

    it('eases the blend rather than moving linearly', (): void => {
      component.setVisualization('waveform');

      renderFrame(VIZ_CROSSFADE_MS / 4);

      expect(incoming().style.opacity).toBe('0.15625');
    });

    it('honours the configured crossfade duration', (): void => {
      settings.visualizationCrossfadeDuration.set(2000);
      component.setVisualization('waveform');

      renderFrame(1000);

      expect(incoming().style.opacity).toBe('0.5');
    });

    it('takes the outgoing canvas off screen when the transition completes', (): void => {
      component.setVisualization('waveform');
      const incomingCanvas: HTMLCanvasElement = incoming();

      renderFrame(VIZ_CROSSFADE_MS);

      expect(canvases()).toEqual([incomingCanvas]);
    });

    it('stops drawing the outgoing visualization once the transition completes', async (): Promise<void> => {
      mediaPlayer.playbackState.set('playing');
      await settle();
      component.setVisualization('waveform');
      renderFrame(VIZ_CROSSFADE_MS);
      analyzerDraw.mockClear();

      renderFrame();

      expect(analyzerDraw).not.toHaveBeenCalled();
    });

    it('returns the incoming canvas to its resting style when the transition completes', (): void => {
      settings.visualizationCrossfadeStyle.set('blur');
      component.setVisualization('waveform');
      renderFrame(VIZ_CROSSFADE_MS / 4);

      renderFrame(VIZ_CROSSFADE_MS);

      const canvas: HTMLCanvasElement = canvases()[0];
      expect(canvas.style.opacity).toBe('');
      expect(canvas.style.filter).toBe('');
      expect(canvas.style.zIndex).toBe('');
    });

    it('stacks the incoming canvas on top for a fade', (): void => {
      component.setVisualization('waveform');

      expect(outgoing().style.zIndex).toBe('0');
      expect(incoming().style.zIndex).toBe('1');
    });

    it('expands the outgoing canvas on top of the incoming one for a zoom', (): void => {
      settings.visualizationCrossfadeStyle.set('zoom');
      component.setVisualization('waveform');

      renderFrame(VIZ_CROSSFADE_MS / 4);

      expect(outgoing().style.transform).toBe('scale(1.3125)');
      expect(outgoing().style.zIndex).toBe('1');
      expect(incoming().style.zIndex).toBe('0');
    });

    it('shrinks the incoming canvas into view for a shrink', (): void => {
      settings.visualizationCrossfadeStyle.set('shrink');
      component.setVisualization('waveform');

      renderFrame(VIZ_CROSSFADE_MS / 4);

      expect(incoming().style.transform).toBe('scale(2.6875)');
      expect(incoming().style.zIndex).toBe('1');
    });

    it('blurs the outgoing canvas and sharpens the incoming one for a blur', (): void => {
      settings.visualizationCrossfadeStyle.set('blur');
      component.setVisualization('waveform');

      renderFrame(VIZ_CROSSFADE_MS / 4);

      expect(outgoing().style.filter).toBe('blur(3.75px)');
      expect(incoming().style.filter).toBe('blur(20.25px)');
    });

    it('picks one concrete style when the style is random', (): void => {
      // Concrete styles are fade, zoom, shrink, blur: 0.3 selects the second.
      vi.spyOn(Math, 'random').mockReturnValue(0.3);
      settings.visualizationCrossfadeStyle.set('random');

      component.setVisualization('waveform');
      renderFrame(VIZ_CROSSFADE_MS / 4);

      expect(outgoing().style.transform).toBe('scale(1.3125)');
    });

    it('drops the older outgoing canvas when switched again mid-transition', (): void => {
      component.setVisualization('waveform');
      const classicCanvas: HTMLCanvasElement = incoming();
      renderFrame(VIZ_CROSSFADE_MS / 4);

      component.setVisualization('blank');

      expect(canvases()).toHaveLength(2);
      expect(outgoing()).toBe(classicCanvas);
    });

    it('restarts the blend from the visualization that was on screen when switched again', (): void => {
      component.setVisualization('waveform');
      renderFrame(VIZ_CROSSFADE_MS / 2);

      component.setVisualization('blank');

      expect(outgoing().style.opacity).toBe('1');
      expect(incoming().style.opacity).toBe('0');
    });

    it('reveals an outgoing canvas that had been hidden while idle', (): void => {
      renderFrame();
      expect(canvases()[0].style.visibility).toBe('hidden');

      component.setVisualization('waveform');

      expect(outgoing().style.visibility).toBe('');
    });

    it('takes both canvases off screen when destroyed mid-transition', (): void => {
      const host: HTMLDivElement = container();
      component.setVisualization('waveform');

      fixture.destroy();

      expect(host.querySelectorAll('canvas')).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Visualization settings
  // ==========================================================================

  describe('visualization settings', (): void => {
    let lineWidthSpy: MockInstance<(width: number) => void>;
    let artworkSpy: MockInstance<(url: string | null) => void>;

    beforeEach(async (): Promise<void> => {
      // Blank overrides none of the base setters, so they can be observed directly.
      lineWidthSpy = vi.spyOn(BlankVisualization.prototype, 'setLineWidth');
      artworkSpy = vi.spyOn(BlankVisualization.prototype, 'setArtworkUrl');
      settings.defaultVisualization.set('blank');
      settings.isLoaded.set(true);
      await settle();
    });

    it('applies the default per-visualization settings to a new visualization', (): void => {
      gesture();

      expect(lineWidthSpy).toHaveBeenLastCalledWith(VISUALIZATION_LOCAL_DEFAULTS.lineWidth);
    });

    it('applies a customised setting for the active visualization', async (): Promise<void> => {
      gesture();

      settings.perVisualizationSettings.set({blank: {lineWidth: 4}});
      await settle();

      expect(lineWidthSpy).toHaveBeenLastCalledWith(4);
    });

    it('does not re-apply settings when a broadcast changes nothing for this visualization', async (): Promise<void> => {
      gesture();
      await settle();
      lineWidthSpy.mockClear();

      settings.perVisualizationSettings.set({bars: {lineWidth: 4}});
      await settle();

      expect(lineWidthSpy).not.toHaveBeenCalled();
    });

    it('applies the configured FFT size to the analyser when a visualization is created', async (): Promise<void> => {
      settings.fftSize.set(1024);
      await settle();

      gesture();

      expect(audioContext().analysers[0].fftSize).toBe(1024);
    });

    it('follows FFT size changes', async (): Promise<void> => {
      gesture();

      settings.fftSize.set(4096);
      await settle();

      expect(audioContext().analysers[0].fftSize).toBe(4096);
    });

    it('points a new visualization at the current track artwork', async (): Promise<void> => {
      const track: PlaylistItem = createTrack();
      await loadTrack(track, 'stopped');

      expect(artworkSpy).toHaveBeenLastCalledWith(
        `${SERVER_URL}/media/artwork?path=${encodeURIComponent(track.filePath)}${AUTH_SUFFIX}`
      );
    });

    it('points the visualization at the next track artwork when the track changes', async (): Promise<void> => {
      await loadTrack(createTrack(), 'stopped');
      const next: PlaylistItem = createTrack({id: 'track-2', filePath: '/music/song two.mp3'});

      mediaPlayer.currentTrack.set(next);
      await settle();

      expect(artworkSpy).toHaveBeenLastCalledWith(
        `${SERVER_URL}/media/artwork?path=${encodeURIComponent(next.filePath)}${AUTH_SUFFIX}`
      );
    });

    it('offers no artwork for a remote stream', async (): Promise<void> => {
      await loadTrack(createTrack({filePath: 'https://example.com/live.mp3'}), 'stopped');

      expect(artworkSpy).toHaveBeenLastCalledWith(null);
    });

    it('offers no artwork when nothing is loaded', (): void => {
      gesture();

      expect(artworkSpy).toHaveBeenLastCalledWith(null);
    });
  });

  // ==========================================================================
  // Render loop
  // ==========================================================================

  describe('render loop', (): void => {
    let draw: MockInstance<() => void>;

    beforeEach((): void => {
      draw = vi.spyOn(AnalyzerVisualization.prototype, 'draw');
      gesture();
    });

    /** Starts playback, which wakes the visualization. */
    async function play(): Promise<void> {
      mediaPlayer.playbackState.set('playing');
      await settle();
    }

    it('draws a frame as soon as the loop is running', async (): Promise<void> => {
      await play();

      renderFrame();

      expect(draw).toHaveBeenCalledTimes(1);
    });

    it('keeps drawing on every subsequent frame', async (): Promise<void> => {
      await play();

      renderFrame();
      renderFrame();
      renderFrame();

      expect(draw).toHaveBeenCalledTimes(3);
    });

    it('stops drawing when destroyed before the first frame has run', async (): Promise<void> => {
      await play();

      fixture.destroy();
      renderFrame();

      expect(draw).not.toHaveBeenCalled();
    });

    it('stops drawing when destroyed mid-loop', async (): Promise<void> => {
      await play();
      renderFrame();
      draw.mockClear();

      fixture.destroy();
      renderFrame();
      renderFrame();

      expect(draw).not.toHaveBeenCalled();
    });

    it('takes the canvas off screen when destroyed', (): void => {
      const host: HTMLDivElement = container();

      fixture.destroy();

      expect(host.querySelectorAll('canvas')).toHaveLength(0);
    });

    it('skips drawing once the visualization reports idle', (): void => {
      renderFrame();
      renderFrame();

      expect(draw).not.toHaveBeenCalled();
    });

    it('hides the canvas while idle', (): void => {
      renderFrame();

      expect(canvases()[0].style.visibility).toBe('hidden');
    });

    it('resumes drawing when playback starts', async (): Promise<void> => {
      renderFrame();

      await play();
      renderFrame();

      expect(draw).toHaveBeenCalledTimes(1);
    });

    it('shows the canvas again when playback starts', async (): Promise<void> => {
      renderFrame();

      await play();
      renderFrame();

      expect(canvases()[0].style.visibility).toBe('');
    });

    it('goes idle again once a paused visualization has finished fading out', async (): Promise<void> => {
      await play();
      renderFrame();
      mediaPlayer.playbackState.set('paused');
      await settle();
      vi.spyOn(Visualization.prototype, 'isIdle').mockReturnValue(true);
      draw.mockClear();

      renderFrame();

      expect(draw).not.toHaveBeenCalled();
      expect(canvases()[0].style.visibility).toBe('hidden');
    });

    it('skips drawing during a fullscreen transition', async (): Promise<void> => {
      await play();

      electron.fullscreenTransitionStart.set(1);
      await settle();
      renderFrame();

      expect(draw).not.toHaveBeenCalled();
    });

    it('resumes drawing when the fullscreen transition ends', async (): Promise<void> => {
      await play();
      electron.fullscreenTransitionStart.set(1);
      await settle();
      renderFrame();

      electron.fullscreenTransitionEnd.set(1);
      await settle();
      renderFrame();

      expect(draw).toHaveBeenCalledTimes(1);
    });

    it('drops frames that arrive faster than the configured frame rate', async (): Promise<void> => {
      settings.maxFrameRate.set(30);
      await play();

      renderFrame(40);
      renderFrame(10);
      renderFrame(10);

      expect(draw).toHaveBeenCalledTimes(1);
    });

    it('draws again once a full frame interval has passed', async (): Promise<void> => {
      settings.maxFrameRate.set(30);
      await play();

      renderFrame(40);
      renderFrame(10);
      renderFrame(30);

      expect(draw).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Canvas size
  // ==========================================================================

  describe('canvas size', (): void => {
    /** Resizes the outlet's container and delivers the observer notification. */
    function resizeTo(width: number, height: number): void {
      displaySize = {width, height};
      FakeResizeObserver.instances[0].notify();
    }

    /** The width and height of the active canvas's backing store. */
    function backingStore(): {width: number; height: number} {
      const canvas: HTMLCanvasElement = canvases()[canvases().length - 1];
      return {width: canvas.width, height: canvas.height};
    }

    it('watches the visualizer container for size changes', (): void => {
      expect(FakeResizeObserver.instances[0].observe).toHaveBeenCalledWith(container());
    });

    it('sizes a new canvas to the container', (): void => {
      gesture();

      expect(backingStore()).toEqual({width: 800, height: 600});
    });

    it('resizes the canvas once a new display size has settled', (): void => {
      gesture();
      resizeTo(1024, 768);

      renderFrame(RESIZE_SETTLE_MS);

      expect(backingStore()).toEqual({width: 1024, height: 768});
    });

    it('leaves the canvas alone while the display size is still changing', (): void => {
      gesture();
      renderFrame(RESIZE_SETTLE_MS);
      resizeTo(1024, 768);

      renderFrame(RESIZE_SETTLE_MS - 1);

      expect(backingStore()).toEqual({width: 800, height: 600});
    });

    it('restarts the settle window on every further size change', (): void => {
      gesture();
      renderFrame(RESIZE_SETTLE_MS);
      resizeTo(900, 700);
      renderFrame(RESIZE_SETTLE_MS - 1);

      resizeTo(1024, 768);
      renderFrame(RESIZE_SETTLE_MS - 1);

      expect(backingStore()).toEqual({width: 800, height: 600});
    });

    it('ignores a notification that reports the same size', (): void => {
      gesture();
      renderFrame(RESIZE_SETTLE_MS);
      const resize: MockInstance<(width: number, height: number) => void> = vi.spyOn(AnalyzerVisualization.prototype, 'resize');

      resizeTo(800, 600);
      renderFrame(RESIZE_SETTLE_MS);

      expect(resize).not.toHaveBeenCalled();
    });

    it('stops watching the container when destroyed', (): void => {
      fixture.destroy();

      expect(FakeResizeObserver.instances[0].disconnect).toHaveBeenCalledTimes(1);
    });

    it('renders at a fixed resolution with pixelated scaling when one is configured', async (): Promise<void> => {
      settings.renderResolution.set('640x480');
      await settle();

      gesture();

      expect(backingStore()).toEqual({width: 640, height: 480});
      expect(canvases()[0].style.imageRendering).toBe('pixelated');
    });

    it('uses smooth scaling at native resolution', (): void => {
      gesture();

      expect(canvases()[0].style.imageRendering).toBe('auto');
    });

    it('follows a change of render resolution on the next settled frame', async (): Promise<void> => {
      gesture();

      settings.renderResolution.set('320x200');
      await settle();
      renderFrame(RESIZE_SETTLE_MS);

      expect(backingStore()).toEqual({width: 320, height: 200});
      expect(canvases()[0].style.imageRendering).toBe('pixelated');
    });

    it('falls back to the display size for a malformed resolution', async (): Promise<void> => {
      settings.renderResolution.set('0x0' as RenderResolution);
      await settle();

      gesture();

      expect(backingStore()).toEqual({width: 800, height: 600});
    });

    it('scales a native canvas down to the 1080p pixel budget on a larger display', async (): Promise<void> => {
      displaySize = {width: 3840, height: 2160};
      FakeResizeObserver.instances[0].notify();

      gesture();

      expect(backingStore()).toEqual({width: 1920, height: 1080});
    });

    it('keeps a crisp visualization at the display size whatever resolution is configured', async (): Promise<void> => {
      settings.renderResolution.set('320x200');
      settings.defaultVisualization.set('logo');
      settings.isLoaded.set(true);
      await settle();

      gesture();

      expect(backingStore()).toEqual({width: 800, height: 600});
      expect(canvases()[0].style.imageRendering).toBe('auto');
    });

    it('sizes the incoming canvas of a crossfade to the render size', (): void => {
      gesture();
      resizeTo(1024, 768);

      component.setVisualization('waveform');

      expect(backingStore()).toEqual({width: 1024, height: 768});
    });
  });
});

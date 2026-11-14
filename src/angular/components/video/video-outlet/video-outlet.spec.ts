/**
 * @fileoverview Tests for VideoOutlet.
 *
 * Two suites, because the outlet has two quite different kinds of behaviour:
 *
 * - `VideoOutlet` instantiates the class without a fixture and covers the
 *   plain state transitions — the aspect-mode cycling arithmetic in
 *   particular, whose wrap-around is the classic place for an off-by-one.
 *
 * - `VideoOutlet (rendered)` mounts the component and drives it the way the
 *   app does: through the service signals it reacts to, the media events its
 *   <video> element fires, and its public methods. Assertions are made on the
 *   DOM and on the fakes standing in for what jsdom lacks — media playback
 *   (play/pause/load are stubbed on HTMLMediaElement.prototype and element
 *   state such as readyState is set per test), the canvas 2D context (a
 *   recording context), Web Audio (a fake AudioContext) and the subtitle
 *   endpoint (ElectronService.authFetch, answered per request).
 *
 * Time is faked throughout the rendered suite: the outlet's guards are all
 * wall-clock windows (post-load, post-seek, settle, safety timeout).
 *
 * @module app/components/video/video-outlet.spec
 */

import {type ComponentFixture, TestBed} from '@angular/core/testing';
import {computed, DOCUMENT, ElementRef, Renderer2, signal, type Signal, type WritableSignal} from '@angular/core';
import type {Mock, MockInstance} from 'vitest';
import {VideoOutlet, type VideoFlipMode} from './video-outlet';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService, type AudioTrack, type MediaInfo, type PlaylistItem, type SubtitleTrack} from '../../../services/electron.service';
import {FileDropService} from '../../../services/file-drop.service';
import {
  SettingsService,
  VIDEO_ASPECT_OPTIONS,
  type PreferredAudioLanguage,
  type PreferredSubtitleLanguage,
  type SubtitleFontFamily,
  type VideoAspectMode,
} from '../../../services/settings.service';
import type {VideoAdjustmentValues} from '../../../services/video-adjustments';

// ============================================================================
// Helpers
// ============================================================================

/** Every aspect mode, in the order the cycling walks them. */
const MODES: readonly VideoAspectMode[] = VIDEO_ASPECT_OPTIONS.map(
  (o: {value: VideoAspectMode}): VideoAspectMode => o.value
);

/** Creates a SettingsService stub whose aspect mode is writable. */
function createMockSettings(): Record<string, unknown> {
  const videoAspectMode: WritableSignal<VideoAspectMode> = signal<VideoAspectMode>('default');
  return {
    videoAspectMode,
    setVideoAspectMode: vi.fn((mode: VideoAspectMode): Promise<void> => {
      videoAspectMode.set(mode);
      return Promise.resolve();
    }),
    subtitleFontSize: signal(100),
    subtitleFontColor: signal('#ffffff'),
    subtitleBackgroundColor: signal('#000000'),
    subtitleBackgroundOpacity: signal(0.5),
    subtitleFontFamily: signal('Arial'),
    subtitleTextShadow: signal(true),
    subtitleShadowBlur: signal(3),
    subtitleShadowSpread: signal(2),
    subtitleShadowColor: signal('#000000'),
    preferredAudioLanguage: signal('default'),
    preferredSubtitleLanguage: signal('default'),
    videoAdjustments: signal({
      brightness: 0, contrast: 0, saturation: 0, hue: 0,
      blur: 0, grayscale: 0, sepia: 0, invert: false,
    }),
    videoAdjustmentsEnabled: signal(false),
    equalizerEnabled: signal(false),
    equalizerBands: signal([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  };
}

/** Creates the MediaPlayerService stub the outlet reads during construction. */
function createMockMediaPlayer(): Record<string, unknown> {
  return {
    serverUrl: signal(''),
    currentTrack: signal(null),
    currentMediaType: signal<'audio' | 'video' | null>(null),
    isPlaying: signal(false),
    isPaused: signal(false),
    playbackState: signal('stopped'),
    currentTime: signal(0),
    volume: signal(1),
    isMuted: signal(false),
    seekVersion: signal(0),
  };
}

/** Creates the ElectronService stub the outlet reads during construction. */
function createMockElectron(): Record<string, unknown> {
  return {
    isFullscreen: signal(false),
    viewMode: signal('desktop'),
    forceReloadCounter: signal(0),
    fadeOutRequested: signal(0),
    serverUrl: signal(''),
    appendAuth: vi.fn((url: string): string => url),
    authFetch: vi.fn(),
    setStreamingBusy: vi.fn(),
    syncPlaybackTime: vi.fn(),
    getSubtitleSelection: vi.fn(),
    setSubtitleSelection: vi.fn(),
    getAudioSelection: vi.fn(),
    setAudioSelection: vi.fn(),
    addFilesWithAutoPlay: vi.fn(),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('VideoOutlet', (): void => {
  let component: VideoOutlet;
  let mockSettings: Record<string, unknown>;

  beforeEach((): void => {
    mockSettings = createMockSettings();

    TestBed.configureTestingModule({
      providers: [
        VideoOutlet,
        {provide: MediaPlayerService, useValue: createMockMediaPlayer()},
        {provide: ElectronService, useValue: createMockElectron()},
        {provide: SettingsService, useValue: mockSettings},
        {provide: Renderer2, useValue: {createElement: vi.fn(), appendChild: vi.fn(), removeChild: vi.fn()}},
        {provide: DOCUMENT, useValue: {head: {}}},
        {provide: ElementRef, useValue: new ElementRef<HTMLElement>({} as HTMLElement)},
      ],
    });

    component = TestBed.inject(VideoOutlet);

    // The ViewChild refs are never populated without a fixture, and TestBed's
    // teardown runs ngOnDestroy, which reaches for the video element.
    component.videoRef = new ElementRef({
      pause: vi.fn(),
      src: '',
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement);
  });

  // ==========================================================================
  // Aspect Mode Cycling
  // ==========================================================================

  describe('aspect mode cycling', (): void => {
    /** The mode the component currently reports. */
    function current(): VideoAspectMode {
      return component.aspectMode();
    }

    it('exposes more than one mode to cycle through', (): void => {
      expect(MODES.length).toBeGreaterThan(1);
    });

    it('starts on the persisted mode', (): void => {
      expect(current()).toBe('default');
    });

    it('advances one mode at a time', (): void => {
      component.nextAspectMode();

      expect(current()).toBe(MODES[1]);
    });

    it('wraps from the last mode back to the first', (): void => {
      component.setAspectMode(MODES[MODES.length - 1]);

      component.nextAspectMode();

      expect(current()).toBe(MODES[0]);
    });

    it('steps backwards one mode at a time', (): void => {
      component.setAspectMode(MODES[1]);

      component.previousAspectMode();

      expect(current()).toBe(MODES[0]);
    });

    it('wraps backwards from the first mode to the last', (): void => {
      component.previousAspectMode();

      expect(current()).toBe(MODES[MODES.length - 1]);
    });

    it('returns to the starting mode after a full forward cycle', (): void => {
      for (let i: number = 0; i < MODES.length; i++) {
        component.nextAspectMode();
      }

      expect(current()).toBe(MODES[0]);
    });

    it('returns to the starting mode after a full backward cycle', (): void => {
      for (let i: number = 0; i < MODES.length; i++) {
        component.previousAspectMode();
      }

      expect(current()).toBe(MODES[0]);
    });

    it('visits every mode exactly once per cycle', (): void => {
      const seen: VideoAspectMode[] = [current()];
      for (let i: number = 0; i < MODES.length - 1; i++) {
        component.nextAspectMode();
        seen.push(current());
      }

      expect(new Set(seen).size).toBe(MODES.length);
    });

    it('persists each change through the settings service', (): void => {
      component.nextAspectMode();

      expect(mockSettings['setVideoAspectMode']).toHaveBeenCalledWith(MODES[1]);
    });

    it('persists an explicitly set mode', (): void => {
      component.setAspectMode('fit');

      expect(mockSettings['setVideoAspectMode']).toHaveBeenCalledWith('fit');
    });
  });

  // ==========================================================================
  // Flip Mode
  // ==========================================================================

  describe('flip mode', (): void => {
    it('starts unflipped', (): void => {
      expect(component.flipMode()).toBe('none');
    });

    it('applies each flip mode', (): void => {
      component.setFlipMode('horizontal');
      expect(component.flipMode()).toBe('horizontal');

      component.setFlipMode('vertical');
      expect(component.flipMode()).toBe('vertical');

      component.setFlipMode('both');
      expect(component.flipMode()).toBe('both');
    });

    it('returns to none', (): void => {
      component.setFlipMode('both');

      component.setFlipMode('none');

      expect(component.flipMode()).toBe('none');
    });

    it('is session state, not persisted through settings', (): void => {
      component.setFlipMode('horizontal');

      expect(mockSettings['setVideoAspectMode']).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// Rendered Suite — Fakes
// ============================================================================

/** Media server base URL the fakes report. */
const SERVER: string = 'http://127.0.0.1:4000';

/** What the fake ElectronService.appendAuth adds, to prove URLs pass through it. */
const AUTH: string = '&token=secret';

/** Wall-clock time every rendered test starts at. */
const START: number = Date.UTC(2026, 0, 1);

/** The MediaPlayerService surface the outlet reads, as writable signals. */
interface FakeMediaPlayer {
  readonly serverUrl: WritableSignal<string>;
  readonly currentTrack: WritableSignal<PlaylistItem | null>;
  readonly playbackState: WritableSignal<string>;
  readonly currentTime: WritableSignal<number>;
  readonly volume: WritableSignal<number>;
  readonly muted: WritableSignal<boolean>;
  readonly isPlaying: Signal<boolean>;
}

/** Creates the MediaPlayerService fake. */
function createFakeMediaPlayer(): FakeMediaPlayer {
  const playbackState: WritableSignal<string> = signal<string>('idle');
  return {
    serverUrl: signal<string>(SERVER),
    currentTrack: signal<PlaylistItem | null>(null),
    playbackState,
    currentTime: signal<number>(0),
    volume: signal<number>(1),
    muted: signal<boolean>(false),
    isPlaying: computed((): boolean => playbackState() === 'playing'),
  };
}

/** One request the outlet made for subtitle content. */
interface SubtitleRequest {
  /** The full URL requested */
  readonly url: string;
  /** The `path` query parameter */
  readonly path: string;
  /** The `track` query parameter (null for an external subtitle file) */
  readonly track: string | null;
  /** The abort signal the outlet passed, if any */
  readonly signal: AbortSignal | null;
  /** Answers the request with a WebVTT body */
  respond(body: string, status?: number): void;
  /** Answers the request with an arbitrary response */
  respondWith(response: Response): void;
  /** Rejects the request, as a network failure would */
  fail(error: Error): void;
}

/** The ElectronService surface the outlet (and its drop directive) uses. */
interface FakeElectron {
  readonly currentMedia: WritableSignal<MediaInfo | null>;
  readonly seekAlignment: WritableSignal<{requested: number; actual: number} | null>;
  readonly fadeOutRequested: WritableSignal<number>;
  readonly serverUrl: WritableSignal<string>;
  lastSeekAt: number;
  /** Every subtitle request made so far, in order */
  readonly requests: SubtitleRequest[];
  /** WebVTT bodies answered automatically, keyed by {@link subtitleKey} */
  readonly subtitleFiles: Map<string, string>;
  readonly appendAuth: Mock<(url: string) => string>;
  readonly authFetch: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
  readonly setStreamingBusy: Mock<(busy: boolean) => void>;
  readonly syncPlaybackTime: Mock<(time: number) => void>;
  readonly getSubtitleSelection: Mock<(filePath: string) => number | undefined>;
  readonly setSubtitleSelection: Mock<(filePath: string, index: number) => void>;
  readonly getAudioSelection: Mock<(filePath: string) => number | undefined>;
  readonly setAudioSelection: Mock<(filePath: string, index: number) => void>;
  readonly toggleFullscreen: Mock<() => Promise<void>>;
  readonly openSubtitleDialog: Mock<() => Promise<string | null>>;
  readonly addFilesWithAutoPlay: Mock<(paths: string[]) => Promise<void>>;
}

/**
 * Builds the part of a fetch Response the outlet reads.
 *
 * A real Response reads its body through a stream, which takes an unspecified
 * number of event-loop turns; this one resolves in a single microtask so the
 * tests can drain the outlet's promise chain deterministically.
 */
function subtitleResponse(body: string, status: number = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: (): Promise<string> => Promise.resolve(body),
  } as Response;
}

/** Key for {@link FakeElectron.subtitleFiles}: a media path plus track index, or 'external'. */
function subtitleKey(path: string, track: number | 'external'): string {
  return `${path}#${track}`;
}

/** Creates the ElectronService fake, with selection caches that really round-trip. */
function createFakeElectron(): FakeElectron {
  const requests: SubtitleRequest[] = [];
  const subtitleFiles: Map<string, string> = new Map<string, string>();
  const subtitleSelections: Map<string, number> = new Map<string, number>();
  const audioSelections: Map<string, number> = new Map<string, number>();

  return {
    currentMedia: signal<MediaInfo | null>(null),
    seekAlignment: signal<{requested: number; actual: number} | null>(null),
    fadeOutRequested: signal<number>(0),
    serverUrl: signal<string>(SERVER),
    lastSeekAt: 0,
    requests,
    subtitleFiles,
    appendAuth: vi.fn((url: string): string => `${url}${AUTH}`),
    authFetch: vi.fn((url: string, init?: RequestInit): Promise<Response> => {
      const params: URLSearchParams = new URL(url).searchParams;
      const path: string = params.get('path') ?? '';
      const track: string | null = params.get('track');
      const requestSignal: AbortSignal | null = init?.signal ?? null;

      return new Promise<Response>((resolve: (response: Response) => void, reject: (reason: unknown) => void): void => {
        requests.push({
          url,
          path,
          track,
          signal: requestSignal,
          respond: (body: string, status: number = 200): void => resolve(subtitleResponse(body, status)),
          respondWith: resolve,
          fail: reject,
        });
        // A real fetch rejects as soon as its signal aborts
        requestSignal?.addEventListener('abort', (): void => reject(new DOMException('Aborted', 'AbortError')));

        const canned: string | undefined = subtitleFiles.get(`${path}#${track ?? 'external'}`);
        if (canned !== undefined) {
          resolve(subtitleResponse(canned));
        }
      });
    }),
    setStreamingBusy: vi.fn(),
    syncPlaybackTime: vi.fn(),
    getSubtitleSelection: vi.fn((filePath: string): number | undefined => subtitleSelections.get(filePath)),
    setSubtitleSelection: vi.fn((filePath: string, index: number): void => {
      subtitleSelections.set(filePath, index);
    }),
    getAudioSelection: vi.fn((filePath: string): number | undefined => audioSelections.get(filePath)),
    setAudioSelection: vi.fn((filePath: string, index: number): void => {
      audioSelections.set(filePath, index);
    }),
    toggleFullscreen: vi.fn((): Promise<void> => Promise.resolve()),
    openSubtitleDialog: vi.fn((): Promise<string | null> => Promise.resolve(null)),
    addFilesWithAutoPlay: vi.fn((): Promise<void> => Promise.resolve()),
  };
}

/** The SettingsService surface the outlet reads, as writable signals. */
interface FakeSettings {
  readonly videoAspectMode: WritableSignal<VideoAspectMode>;
  readonly setVideoAspectMode: Mock<(mode: VideoAspectMode) => Promise<void>>;
  readonly subtitleFontSize: WritableSignal<number>;
  readonly subtitleFontColor: WritableSignal<string>;
  readonly subtitleBackgroundColor: WritableSignal<string>;
  readonly subtitleBackgroundOpacity: WritableSignal<number>;
  readonly subtitleFontFamily: WritableSignal<SubtitleFontFamily>;
  readonly subtitleTextShadow: WritableSignal<boolean>;
  readonly subtitleShadowBlur: WritableSignal<number>;
  readonly subtitleShadowSpread: WritableSignal<number>;
  readonly subtitleShadowColor: WritableSignal<string>;
  readonly preferredAudioLanguage: WritableSignal<PreferredAudioLanguage>;
  readonly preferredSubtitleLanguage: WritableSignal<PreferredSubtitleLanguage>;
  readonly videoAdjustments: WritableSignal<VideoAdjustmentValues>;
  readonly videoAdjustmentsEnabled: WritableSignal<boolean>;
  readonly equalizerEnabled: WritableSignal<boolean>;
  readonly equalizerBands: WritableSignal<readonly number[]>;
}

/** Neutral video adjustments. */
const NEUTRAL: VideoAdjustmentValues = {
  brightness: 0, contrast: 0, saturation: 0, hue: 0,
  blur: 0, grayscale: 0, sepia: 0, invert: false,
};

/** Creates the SettingsService fake with the app's defaults. */
function createFakeSettings(): FakeSettings {
  const videoAspectMode: WritableSignal<VideoAspectMode> = signal<VideoAspectMode>('default');
  return {
    videoAspectMode,
    setVideoAspectMode: vi.fn((mode: VideoAspectMode): Promise<void> => {
      videoAspectMode.set(mode);
      return Promise.resolve();
    }),
    subtitleFontSize: signal<number>(100),
    subtitleFontColor: signal<string>('#ffffff'),
    subtitleBackgroundColor: signal<string>('#000000'),
    subtitleBackgroundOpacity: signal<number>(0.5),
    subtitleFontFamily: signal<SubtitleFontFamily>('Arial'),
    subtitleTextShadow: signal<boolean>(true),
    subtitleShadowBlur: signal<number>(3),
    subtitleShadowSpread: signal<number>(2),
    subtitleShadowColor: signal<string>('#000000'),
    preferredAudioLanguage: signal<PreferredAudioLanguage>('default'),
    preferredSubtitleLanguage: signal<PreferredSubtitleLanguage>('default'),
    videoAdjustments: signal<VideoAdjustmentValues>(NEUTRAL),
    videoAdjustmentsEnabled: signal<boolean>(false),
    equalizerEnabled: signal<boolean>(false),
    equalizerBands: signal<readonly number[]>([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  };
}

/** One call made on a recording canvas context. */
interface CanvasCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

/** A 2D context that records, in order, everything asked of it. */
class RecordingContext {
  public readonly calls: CanvasCall[] = [];
  public globalAlpha: number = 1;
  public fillStyle: string = '';
  public strokeStyle: string = '';
  public lineJoin: string = '';
  public lineWidth: number = 0;

  public setTransform(...args: unknown[]): void { this.calls.push({name: 'setTransform', args}); }
  public clearRect(...args: unknown[]): void { this.calls.push({name: 'clearRect', args}); }
  public save(...args: unknown[]): void { this.calls.push({name: 'save', args}); }
  public restore(...args: unknown[]): void { this.calls.push({name: 'restore', args}); }
  public translate(...args: unknown[]): void { this.calls.push({name: 'translate', args}); }
  public scale(...args: unknown[]): void { this.calls.push({name: 'scale', args}); }
  public rotate(...args: unknown[]): void { this.calls.push({name: 'rotate', args}); }
  public drawImage(...args: unknown[]): void { this.calls.push({name: 'drawImage', args}); }
  public beginPath(...args: unknown[]): void { this.calls.push({name: 'beginPath', args}); }
  public closePath(...args: unknown[]): void { this.calls.push({name: 'closePath', args}); }
  public arc(...args: unknown[]): void { this.calls.push({name: 'arc', args}); }
  public fill(...args: unknown[]): void { this.calls.push({name: 'fill', args}); }
  public stroke(...args: unknown[]): void { this.calls.push({name: 'stroke', args}); }

  /** The arguments of every call to the named method, in order. */
  public callsTo(name: string): (readonly unknown[])[] {
    return this.calls.filter((c: CanvasCall): boolean => c.name === name).map((c: CanvasCall): readonly unknown[] => c.args);
  }

  /** The names of every call, in order. */
  public names(): string[] {
    return this.calls.map((c: CanvasCall): string => c.name);
  }
}

/** A Web Audio node that records what it was connected to. */
class FakeAudioNode {
  public readonly connectedTo: FakeAudioNode[] = [];

  public connect(target: FakeAudioNode): void {
    this.connectedTo.push(target);
  }
}

/** A biquad filter with the parameters the equalizer sets. */
class FakeBiquadFilter extends FakeAudioNode {
  public type: string = '';
  public readonly frequency: {value: number} = {value: 0};
  public readonly Q: {value: number} = {value: 0};
  public readonly gain: {value: number} = {value: 0};
}

/** A media-element source node that remembers its element. */
class FakeMediaElementSource extends FakeAudioNode {
  public constructor(public readonly element: HTMLMediaElement) {
    super();
  }
}

/** Stands in for the AudioContext jsdom does not have. */
class FakeAudioContext {
  /** Every context constructed since the last reset */
  public static instances: FakeAudioContext[] = [];
  /** State new contexts start in */
  public static initialState: AudioContextState = 'running';
  /** When true, construction throws (no audio device) */
  public static failConstruction: boolean = false;

  public state: AudioContextState = FakeAudioContext.initialState;
  public readonly destination: FakeAudioNode = new FakeAudioNode();
  public readonly sources: FakeMediaElementSource[] = [];
  public readonly filters: FakeBiquadFilter[] = [];
  public readonly resume: Mock<() => Promise<void>> = vi.fn((): Promise<void> => Promise.resolve());
  public readonly close: Mock<() => Promise<void>> = vi.fn((): Promise<void> => Promise.resolve());

  public constructor() {
    if (FakeAudioContext.failConstruction) {
      throw new Error('no audio device');
    }
    FakeAudioContext.instances.push(this);
  }

  public static reset(): void {
    FakeAudioContext.instances = [];
    FakeAudioContext.initialState = 'running';
    FakeAudioContext.failConstruction = false;
  }

  public createMediaElementSource(element: HTMLMediaElement): FakeMediaElementSource {
    const source: FakeMediaElementSource = new FakeMediaElementSource(element);
    this.sources.push(source);
    return source;
  }

  public createBiquadFilter(): FakeBiquadFilter {
    const filter: FakeBiquadFilter = new FakeBiquadFilter();
    this.filters.push(filter);
    return filter;
  }
}

/** The read-only media element state a test may need to dictate. */
interface MediaState {
  readyState: number;
  paused: boolean;
  seeking: boolean;
  videoWidth: number;
  videoHeight: number;
}

/** Builds a video playlist item for a file path. */
function videoItem(filePath: string): PlaylistItem {
  return {id: filePath, filePath, title: filePath, duration: 600, type: 'video'};
}

/** Builds the media info the server announces for a video. */
function mediaInfo(filePath: string, extra: Partial<MediaInfo> = {}): MediaInfo {
  return {duration: 600, type: 'video', title: filePath, filePath, ...extra};
}

/** Builds a subtitle track descriptor. */
function subtitleTrack(index: number, extra: Partial<SubtitleTrack> = {}): SubtitleTrack {
  return {index, language: 'eng', title: `Track ${index}`, codec: 'subrip', forced: false, default: false, ...extra};
}

/** Builds an audio track descriptor. */
function audioTrack(index: number, extra: Partial<AudioTrack> = {}): AudioTrack {
  return {index, language: 'eng', title: `Audio ${index}`, codec: 'aac', channels: 2, default: false, ...extra};
}

/** Formats seconds (below one hour) as a WebVTT timestamp. */
function vttTime(seconds: number): string {
  const minutes: string = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs: string = (seconds % 60).toFixed(3).padStart(6, '0');
  return `00:${minutes}:${secs}`;
}

/** Builds a WebVTT document from [start, end, text] cues. */
function vtt(...cues: readonly (readonly [number, number, string])[]): string {
  const body: string = cues
    .map(([start, end, text]: readonly [number, number, string]): string => `${vttTime(start)} --> ${vttTime(end)}\n${text}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

/** Builds a DOMRect-shaped object. */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left, y: top, left, top, width, height,
    right: left + width, bottom: top + height,
    toJSON: (): Record<string, never> => ({}),
  };
}

/** The stream URL the outlet should request for a file, with optional extra query. */
function streamUrl(filePath: string, query: string = ''): string {
  return `${SERVER}/media/stream?path=${encodeURIComponent(filePath)}${query}${AUTH}`;
}

// ============================================================================
// Rendered Suite — Tests
// ============================================================================

describe('VideoOutlet (rendered)', (): void => {
  let fixture: ComponentFixture<VideoOutlet>;
  let component: VideoOutlet;
  let video: HTMLVideoElement;
  let container: HTMLElement;
  let freezeCanvas: HTMLCanvasElement;
  let spinnerCanvas: HTMLCanvasElement;

  let mediaPlayer: FakeMediaPlayer;
  let electron: FakeElectron;
  let settings: FakeSettings;
  let fileDrop: {hasValidFiles: Mock<() => boolean>; extractMediaFilePaths: Mock<() => string[]>};

  let play: MockInstance<HTMLMediaElement['play']>;
  let pause: MockInstance<HTMLMediaElement['pause']>;
  let load: MockInstance<HTMLMediaElement['load']>;
  let consoleError: MockInstance<typeof console.error>;
  let consoleWarn: MockInstance<typeof console.warn>;

  /** Recording contexts by the canvas that owns them. */
  let contexts: Map<HTMLCanvasElement, RecordingContext>;

  /** Canvases that should report no 2D context. */
  let contextless: Set<HTMLCanvasElement>;

  let originalDpr: PropertyDescriptor | undefined;

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Mounts the outlet and runs its first change detection.
   *
   * @param beforeFirstRender - Runs once the component exists but before its
   *   effects first run (for subscribing to outputs that emit on mount)
   */
  function mount(beforeFirstRender: () => void = (): void => {}): void {
    fixture = TestBed.createComponent(VideoOutlet);
    component = fixture.componentInstance;
    const host: HTMLElement = fixture.nativeElement as HTMLElement;
    video = host.querySelector('video')!;
    container = host.querySelector('.video-container')!;
    freezeCanvas = host.querySelector('canvas.seek-loading-frame')!;
    spinnerCanvas = host.querySelector('canvas.seek-loading-spinner')!;
    // jsdom's element has no decoder behind it; give the position a plain slot
    Object.defineProperty(video, 'currentTime', {value: 0, writable: true, configurable: true});
    beforeFirstRender();
    fixture.detectChanges();
  }

  /** Runs every promise continuation that is already able to run. */
  async function drainPromises(): Promise<void> {
    for (let i: number = 0; i < 50; i++) {
      await Promise.resolve();
    }
  }

  /**
   * Lets the outlet catch up: runs its effects, lets the async work they start
   * (subtitle fetches) finish, and renders the result.
   */
  async function settle(): Promise<void> {
    await drainPromises();
    fixture.detectChanges();
    await drainPromises();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  /** Dictates read-only state of the video element. */
  function setMediaState(state: Partial<MediaState>): void {
    for (const [key, value] of Object.entries(state)) {
      Object.defineProperty(video, key, {value, writable: true, configurable: true});
    }
  }

  /** Makes the element report a decoded 1920x1080 frame with data to play. */
  function decodedFrame(): void {
    setMediaState({readyState: 4, videoWidth: 1920, videoHeight: 1080});
  }

  /** Dictates the on-screen geometry of the container and the video element. */
  function layout(containerRect: DOMRect, videoRect: DOMRect): void {
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(containerRect);
    vi.spyOn(video, 'getBoundingClientRect').mockReturnValue(videoRect);
  }

  /** Fires a media event on the video element. */
  function fire(name: string): void {
    video.dispatchEvent(new Event(name));
  }

  /** Makes a track current, as a playlist change would. */
  async function loadTrack(filePath: string): Promise<void> {
    mediaPlayer.currentTrack.set(videoItem(filePath));
    await settle();
  }

  /** Delivers the server's media info for a file, as the SSE push would. */
  async function announceMedia(filePath: string, extra: Partial<MediaInfo> = {}): Promise<void> {
    electron.currentMedia.set(mediaInfo(filePath, extra));
    await settle();
  }

  /** Moves the server's playback state. */
  async function setState(state: string): Promise<void> {
    mediaPlayer.playbackState.set(state);
    await settle();
  }

  /** Moves the server's playback position. */
  async function setServerTime(time: number): Promise<void> {
    mediaPlayer.currentTime.set(time);
    await settle();
  }

  /** Lets enough wall-clock pass that load and seek guards no longer apply. */
  function passGuards(): void {
    vi.advanceTimersByTime(2500);
  }

  /** Seeks a loaded transcoded stream by moving the server position. */
  async function seekStreamTo(time: number): Promise<void> {
    setMediaState({readyState: 4});
    passGuards();
    await setServerTime(time);
  }

  /** The src the video element was last given. */
  function src(): string | null {
    return video.getAttribute('src');
  }

  /** Whether the seek-loading overlay is showing. */
  function overlayShowing(): boolean {
    return freezeCanvas.classList.contains('active');
  }

  /** The rendered subtitle overlay, if any. */
  function subtitleOverlay(): HTMLElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector('.subtitle-overlay');
  }

  /** Moves the element to a position and fires timeupdate, as playback does. */
  async function playTo(time: number): Promise<void> {
    video.currentTime = time;
    fire('timeupdate');
    await settle();
  }

  /** The injected subtitle style element, if present. */
  function subtitleStyle(): HTMLStyleElement | null {
    return document.head.querySelector('#onix-subtitle-styles');
  }

  /** The recording context a canvas handed out. */
  function contextOf(canvas: HTMLCanvasElement): RecordingContext {
    const context: RecordingContext | undefined = contexts.get(canvas);
    if (!context) throw new Error('that canvas was never asked for a context');
    return context;
  }

  /** The only AudioContext the outlet built. */
  function audioContext(): FakeAudioContext {
    expect(FakeAudioContext.instances.length).toBe(1);
    return FakeAudioContext.instances[0];
  }

  // --------------------------------------------------------------------------
  // Setup
  // --------------------------------------------------------------------------

  beforeEach((): void => {
    vi.useFakeTimers();
    vi.setSystemTime(START);

    mediaPlayer = createFakeMediaPlayer();
    electron = createFakeElectron();
    settings = createFakeSettings();
    fileDrop = {
      hasValidFiles: vi.fn((): boolean => true),
      extractMediaFilePaths: vi.fn((): string[] => []),
    };

    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation((): Promise<void> => Promise.resolve());
    pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation((): void => {});
    load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation((): void => {});

    contexts = new Map<HTMLCanvasElement, RecordingContext>();
    contextless = new Set<HTMLCanvasElement>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function (this: HTMLCanvasElement): CanvasRenderingContext2D | null {
        if (contextless.has(this)) return null;
        let context: RecordingContext | undefined = contexts.get(this);
        if (!context) {
          context = new RecordingContext();
          contexts.set(this, context);
        }
        return context as unknown as CanvasRenderingContext2D;
      } as unknown as HTMLCanvasElement['getContext']
    );

    FakeAudioContext.reset();
    vi.stubGlobal('AudioContext', FakeAudioContext);

    originalDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', {configurable: true, value: 1});

    // The outlet narrates its work on the console; keep the test output clean
    vi.spyOn(console, 'log').mockImplementation((): void => {});
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation((): void => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation((): void => {});

    TestBed.configureTestingModule({
      imports: [VideoOutlet],
      providers: [
        {provide: MediaPlayerService, useValue: mediaPlayer},
        {provide: ElectronService, useValue: electron},
        {provide: SettingsService, useValue: settings},
        {provide: FileDropService, useValue: fileDrop},
      ],
    });
  });

  afterEach((): void => {
    fixture?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalDpr) {
      Object.defineProperty(window, 'devicePixelRatio', originalDpr);
    } else {
      Reflect.deleteProperty(window, 'devicePixelRatio');
    }
  });

  // ==========================================================================
  // Source Selection
  // ==========================================================================

  describe('choosing a source', (): void => {
    it('leaves the element without a source until a track is current', (): void => {
      mount();

      expect(src()).toBeNull();
      expect(load).not.toHaveBeenCalled();
    });

    it('streams a native container directly, through the authenticated URL', async (): Promise<void> => {
      mount();

      await loadTrack('/movies/a.mp4');

      expect(src()).toBe(streamUrl('/movies/a.mp4'));
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('URL-encodes the file path', async (): Promise<void> => {
      mount();

      await loadTrack('/movies/Señor & Co #1.mp4');

      expect(src()).toContain('path=%2Fmovies%2FSe%C3%B1or%20%26%20Co%20%231.mp4');
    });

    it('recognises native containers regardless of extension case', async (): Promise<void> => {
      mount();

      await loadTrack('/movies/A.WEBM');

      expect(src()).toBe(streamUrl('/movies/A.WEBM'));
    });

    it('requests a transcode with an audio track for a non-native container', async (): Promise<void> => {
      mount();

      await loadTrack('/movies/a.mkv');

      expect(src()).toBe(streamUrl('/movies/a.mkv', '&audioTrack=0'));
    });

    it('requests a transcode for a native container the server cannot remux', async (): Promise<void> => {
      mount();
      await announceMedia('/movies/ac3.mp4', {canRemux: false, audioCodec: 'ac3'});

      await loadTrack('/movies/ac3.mp4');

      expect(src()).toBe(streamUrl('/movies/ac3.mp4', '&audioTrack=0'));
    });

    it('tells the server it may remux a non-native container when that is possible', async (): Promise<void> => {
      mount();
      await announceMedia('/movies/a.mkv', {canRemux: true});

      await loadTrack('/movies/a.mkv');

      expect(src()).toBe(streamUrl('/movies/a.mkv', '&audioTrack=0&canRemux=true'));
    });

    it('does not load anything while the server URL is unknown', async (): Promise<void> => {
      mediaPlayer.serverUrl.set('');
      mount();

      await loadTrack('/movies/a.mp4');

      expect(src()).toBeNull();
      expect(load).not.toHaveBeenCalled();
    });

    it('ignores audio tracks', async (): Promise<void> => {
      mount();

      mediaPlayer.currentTrack.set({...videoItem('/music/a.mp3'), type: 'audio'});
      await settle();

      expect(src()).toBeNull();
    });

    it('does not reload the same track when only the playback state changes', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');

      await setState('paused');

      expect(load).toHaveBeenCalledTimes(1);
    });

    it('does not load twice when a just-added track is selected before it has ever played', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');

      await setState('loading');

      expect(load).toHaveBeenCalledTimes(1);
    });

    it('replaces the source when a different track becomes current', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');

      await loadTrack('/movies/b.mp4');

      expect(src()).toBe(streamUrl('/movies/b.mp4'));
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('shows the busy cursor while a remote stream spins up', async (): Promise<void> => {
      mount();

      await loadTrack('https://example.com/watch?v=1');

      expect(electron.setStreamingBusy).toHaveBeenCalledWith(true);
    });

    it('does not show the busy cursor for a local file', async (): Promise<void> => {
      mount();

      await loadTrack('/movies/a.mp4');

      expect(electron.setStreamingBusy).not.toHaveBeenCalledWith(true);
    });
  });

  // ==========================================================================
  // Restart And Resume
  // ==========================================================================

  describe('restarting and resuming', (): void => {
    /** Loads a track and takes it through playing, as a normal start does. */
    async function startPlaying(filePath: string): Promise<void> {
      await setState('loading');
      await loadTrack(filePath);
      await setState('playing');
    }

    it('reloads from the start when a track that has played is selected again', async (): Promise<void> => {
      mount();
      await startPlaying('/movies/a.mkv');
      mediaPlayer.currentTime.set(42);

      await setState('loading');

      expect(load).toHaveBeenCalledTimes(2);
      expect(src()).toBe(streamUrl('/movies/a.mkv', '&audioTrack=0'));
    });

    it('resumes a transcoded stream at the server position after a stop', async (): Promise<void> => {
      mount();
      await startPlaying('/movies/a.mkv');
      await setState('stopped');
      // The user drags the seek bar while stopped; the server keeps the position
      await setServerTime(42);

      await setState('loading');

      expect(src()).toBe(streamUrl('/movies/a.mkv', '&t=42&audioTrack=0'));
    });

    it('resumes a native file at the server position once the reloaded source can play', async (): Promise<void> => {
      mount();
      await startPlaying('/movies/a.mp4');
      await setState('stopped');
      mediaPlayer.currentTime.set(42);
      await setState('loading');
      video.currentTime = 0;

      fire('canplay');

      expect(src()).toBe(streamUrl('/movies/a.mp4'));
      expect(video.currentTime).toBe(42);
    });

    it('positions a resumed native file only once', async (): Promise<void> => {
      mount();
      await startPlaying('/movies/a.mp4');
      await setState('stopped');
      mediaPlayer.currentTime.set(42);
      await setState('loading');
      fire('canplay');
      video.currentTime = 50;

      fire('canplay');

      expect(video.currentTime).toBe(50);
    });

    it('drops a pending resume position when another track loads before the first can play', async (): Promise<void> => {
      mount();
      await startPlaying('/movies/a.mp4');
      await setState('stopped');
      mediaPlayer.currentTime.set(42);
      await setState('loading');
      await loadTrack('/movies/b.mp4');
      video.currentTime = 0;

      fire('canplay');

      expect(video.currentTime).toBe(0);
    });

    it('starts a different track from the beginning even after a stop', async (): Promise<void> => {
      mount();
      await startPlaying('/movies/a.mkv');
      await setState('stopped');
      mediaPlayer.currentTime.set(42);
      mediaPlayer.playbackState.set('loading');

      await loadTrack('/movies/b.mkv');

      expect(src()).toBe(streamUrl('/movies/b.mkv', '&audioTrack=0'));
    });
  });

  // ==========================================================================
  // Playback State
  // ==========================================================================

  describe('following the playback state', (): void => {
    it('plays the element when playback starts and a frame is ready', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      setMediaState({readyState: 2});

      await setState('playing');

      expect(play).toHaveBeenCalledTimes(1);
    });

    it('waits for data before playing', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      setMediaState({readyState: 1});

      await setState('playing');

      expect(play).not.toHaveBeenCalled();
    });

    it('does not try to play an element with no source', async (): Promise<void> => {
      mount();
      setMediaState({readyState: 4});

      await setState('playing');

      expect(play).not.toHaveBeenCalled();
    });

    it('starts playing when the source becomes playable while the server is playing', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      await setState('playing');

      fire('canplay');

      expect(play).toHaveBeenCalledTimes(1);
    });

    it('stays paused when the source becomes playable while the server is not playing', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      await setState('paused');

      fire('canplay');

      expect(play).not.toHaveBeenCalled();
    });

    it('reports a rejected play instead of throwing', async (): Promise<void> => {
      const refusal: Error = new Error('NotAllowedError');
      play.mockRejectedValueOnce(refusal);
      mount();
      await loadTrack('/movies/a.mp4');
      setMediaState({readyState: 4});

      await setState('playing');

      expect(consoleError).toHaveBeenCalledWith(refusal);
    });

    it('pauses the element when playback pauses', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      pause.mockClear();

      await setState('paused');

      expect(pause).toHaveBeenCalledTimes(1);
    });

    it('pauses and rewinds the element when playback stops', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      video.currentTime = 77;
      pause.mockClear();

      await setState('stopped');

      expect(pause).toHaveBeenCalledTimes(1);
      expect(video.currentTime).toBe(0);
    });
  });

  // ==========================================================================
  // Volume
  // ==========================================================================

  describe('volume', (): void => {
    it('applies the player volume to the element', async (): Promise<void> => {
      mount();

      mediaPlayer.volume.set(0.3);
      await settle();

      expect(video.volume).toBe(0.3);
    });

    it('mutes and unmutes the element with the player', async (): Promise<void> => {
      mount();

      mediaPlayer.muted.set(true);
      await settle();

      expect(video.muted).toBe(true);
    });

    it('fades the element volume to silence in ten steps when the window is closing', async (): Promise<void> => {
      mount();

      electron.fadeOutRequested.set(1000);
      await settle();
      vi.advanceTimersByTime(300);
      const partWay: number = video.volume;
      vi.advanceTimersByTime(700);

      expect(partWay).toBeCloseTo(0.7, 10);
      expect(video.volume).toBe(0);
    });

    it('stops stepping once the fade has finished', async (): Promise<void> => {
      mount();
      electron.fadeOutRequested.set(1000);
      await settle();
      vi.advanceTimersByTime(1000);
      video.volume = 0.5;

      vi.advanceTimersByTime(1000);

      expect(video.volume).toBe(0.5);
    });

    it('replaces a fade already in progress rather than running both', async (): Promise<void> => {
      mount();
      electron.fadeOutRequested.set(1000);
      await settle();
      vi.advanceTimersByTime(300);

      // A slower fade from 0.7: steps of 0.07 every 200 ms
      electron.fadeOutRequested.set(2000);
      await settle();
      vi.advanceTimersByTime(200);

      expect(video.volume).toBeCloseTo(0.63, 10);
    });

    it('does not start a fade when the element is already silent', async (): Promise<void> => {
      mediaPlayer.volume.set(0);
      mount();
      electron.fadeOutRequested.set(1000);
      await settle();

      // Were a fade running, it would drag this back down to nothing
      video.volume = 0.8;
      vi.advanceTimersByTime(1000);

      expect(video.volume).toBe(0.8);
    });
  });

  // ==========================================================================
  // Seeking — Native
  // ==========================================================================

  describe('seeking a native file', (): void => {
    beforeEach(async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
    });

    it('moves the element when the server position jumps', async (): Promise<void> => {
      passGuards();

      await setServerTime(30);

      expect(video.currentTime).toBe(30);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('leaves the element alone while it is within a second of the server', async (): Promise<void> => {
      passGuards();
      video.currentTime = 10;

      await setServerTime(10.9);

      expect(video.currentTime).toBe(10);
    });

    it('ignores the server position for half a second after a load', async (): Promise<void> => {
      vi.advanceTimersByTime(499);

      // Still the previous track's position, not yet reset by the server
      await setServerTime(15);

      expect(video.currentTime).toBe(0);
    });

    it('follows the server position again once the post-load window has passed', async (): Promise<void> => {
      vi.advanceTimersByTime(500);

      await setServerTime(15);

      expect(video.currentTime).toBe(15);
    });

    it('does not interrupt a seek the element is still performing', async (): Promise<void> => {
      passGuards();
      setMediaState({seeking: true});
      video.currentTime = 5;

      await setServerTime(30);

      expect(video.currentTime).toBe(5);
    });
  });

  // ==========================================================================
  // Seeking — Transcoded Streams
  // ==========================================================================

  describe('seeking a transcoded stream', (): void => {
    beforeEach(async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mkv');
    });

    it('re-requests the stream from the new position', async (): Promise<void> => {
      await seekStreamTo(100);

      expect(src()).toBe(streamUrl('/movies/a.mkv', '&t=100&audioTrack=0'));
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('does not touch the element position, which restarts from zero in the new stream', async (): Promise<void> => {
      video.currentTime = 3;

      await seekStreamTo(100);

      expect(video.currentTime).toBe(3);
    });

    it('keeps the stream when the server is within two seconds of the element', async (): Promise<void> => {
      video.currentTime = 10;

      await seekStreamTo(11.9);

      expect(load).toHaveBeenCalledTimes(1);
    });

    it('does not reload while the element is still buffering', async (): Promise<void> => {
      setMediaState({readyState: 2});
      passGuards();

      await setServerTime(100);

      expect(load).toHaveBeenCalledTimes(1);
    });

    it('measures later drift against the position the stream was started from', async (): Promise<void> => {
      await seekStreamTo(100);
      fire('canplay');
      passGuards();
      video.currentTime = 20;

      // 120s of media = 100s stream offset + 20s into the stream
      await setServerTime(121);

      expect(load).toHaveBeenCalledTimes(2);
    });

    it('does not start a second reload while the first has yet to become playable', async (): Promise<void> => {
      await seekStreamTo(100);
      passGuards();

      await setServerTime(200);

      expect(src()).toBe(streamUrl('/movies/a.mkv', '&t=100&audioTrack=0'));
    });

    it('accepts a new seek once the reloaded stream can play', async (): Promise<void> => {
      await seekStreamTo(100);
      fire('canplay');
      passGuards();

      await setServerTime(200);

      expect(src()).toBe(streamUrl('/movies/a.mkv', '&t=200&audioTrack=0'));
    });

    it('holds off for a second after the stream becomes playable so the clock sync can land', async (): Promise<void> => {
      await seekStreamTo(100);
      vi.advanceTimersByTime(600);
      fire('canplay');
      vi.advanceTimersByTime(999);

      await setServerTime(200);

      expect(src()).toBe(streamUrl('/movies/a.mkv', '&t=100&audioTrack=0'));
    });

    it('re-anchors the server clock to the stream start when the reloaded stream can play', async (): Promise<void> => {
      await setState('playing');
      await seekStreamTo(100);
      video.currentTime = 0.25;

      fire('canplay');

      expect(electron.syncPlaybackTime).toHaveBeenCalledWith(100.25);
    });

    it('does not re-anchor the server clock while not playing', async (): Promise<void> => {
      await setState('paused');
      await seekStreamTo(100);

      fire('canplay');

      expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('adopts the keyframe the server actually started the stream from', async (): Promise<void> => {
      await setState('playing');
      await seekStreamTo(100);

      electron.seekAlignment.set({requested: 100, actual: 97.5});
      await settle();
      fire('canplay');

      expect(electron.syncPlaybackTime).toHaveBeenCalledWith(97.5);
    });

    it('ignores a keyframe alignment that answers some other seek', async (): Promise<void> => {
      await setState('playing');
      await seekStreamTo(100);

      electron.seekAlignment.set({requested: 60, actual: 57.5});
      await settle();
      fire('canplay');

      expect(electron.syncPlaybackTime).toHaveBeenCalledWith(100);
    });
  });

  // ==========================================================================
  // Seek-Loading Overlay
  // ==========================================================================

  describe('the seek-loading overlay', (): void => {
    beforeEach(async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mkv');
    });

    it('is hidden during ordinary playback', (): void => {
      expect(overlayShowing()).toBe(false);
      expect(spinnerCanvas.classList.contains('active')).toBe(false);
    });

    it('shows the frozen frame and the spinner while a seek reloads the stream', async (): Promise<void> => {
      await seekStreamTo(100);

      expect(overlayShowing()).toBe(true);
      expect(spinnerCanvas.classList.contains('active')).toBe(true);
    });

    it('shows the busy cursor while the stream reloads', async (): Promise<void> => {
      await seekStreamTo(100);

      expect(electron.setStreamingBusy).toHaveBeenLastCalledWith(true);
    });

    it('starts the spinner animation on its canvas', async (): Promise<void> => {
      await seekStreamTo(100);

      expect([spinnerCanvas.width, spinnerCanvas.height]).toEqual([256, 256]);
      expect(contextOf(spinnerCanvas).callsTo('setTransform')).toEqual([[1, 0, 0, 1, 0, 0]]);
    });

    it('hides and clears the busy cursor once the reloaded stream can play', async (): Promise<void> => {
      await seekStreamTo(100);

      fire('canplay');
      await settle();

      expect(overlayShowing()).toBe(false);
      expect(electron.setStreamingBusy).toHaveBeenLastCalledWith(false);
    });

    it('stops the spinner and wipes its canvas when hidden', async (): Promise<void> => {
      await seekStreamTo(100);

      fire('canplay');

      expect(contextOf(spinnerCanvas).callsTo('clearRect').at(-1)).toEqual([0, 0, 256, 256]);
    });

    it('hides when playback resumes even if canplay was missed', async (): Promise<void> => {
      await seekStreamTo(100);

      fire('playing');
      await settle();

      expect(overlayShowing()).toBe(false);
    });

    it('hides when the stream errors', async (): Promise<void> => {
      await seekStreamTo(100);

      fire('error');
      await settle();

      expect(overlayShowing()).toBe(false);
    });

    it('stays up for fifteen seconds if the stream never answers', async (): Promise<void> => {
      await seekStreamTo(100);

      vi.advanceTimersByTime(14999);
      await settle();

      expect(overlayShowing()).toBe(true);
    });

    it('gives up after fifteen seconds if the stream never answers', async (): Promise<void> => {
      await seekStreamTo(100);

      vi.advanceTimersByTime(15000);
      await settle();

      expect(overlayShowing()).toBe(false);
    });

    it('restarts the fifteen second allowance when another reload begins', async (): Promise<void> => {
      await seekStreamTo(100);
      vi.advanceTimersByTime(10000);
      component.selectAudioTrack(1);

      vi.advanceTimersByTime(14999);
      await settle();

      expect(overlayShowing()).toBe(true);
    });

    it('is dropped when a different track loads, since its frame is stale', async (): Promise<void> => {
      await seekStreamTo(100);

      await loadTrack('/movies/b.mkv');

      expect(overlayShowing()).toBe(false);
    });

    it('survives the reload of the same file that the seek itself causes', async (): Promise<void> => {
      await seekStreamTo(100);

      expect(load).toHaveBeenCalledTimes(2);
      expect(overlayShowing()).toBe(true);
    });

    it('dulls the frozen frame', (): void => {
      expect(component.freezeFrameFilter()).toBe('brightness(0.6)');
    });

    it('applies the video adjustments to the frozen frame before dulling it', async (): Promise<void> => {
      settings.videoAdjustments.set({...NEUTRAL, contrast: 50});
      settings.videoAdjustmentsEnabled.set(true);
      await settle();

      expect(component.freezeFrameFilter()).toBe('contrast(1.5) brightness(0.6)');
    });
  });

  // ==========================================================================
  // Freeze Frame
  // ==========================================================================

  describe('painting the freeze frame', (): void => {
    /** Shows the overlay by reloading for an audio-track switch. */
    function freeze(trackIndex: number = 1): void {
      component.selectAudioTrack(trackIndex);
    }

    beforeEach(async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      layout(rect(0, 0, 800, 600), rect(0, 0, 800, 600));
      decodedFrame();
    });

    it('sizes the canvas to the container', (): void => {
      freeze();

      expect([freezeCanvas.width, freezeCanvas.height]).toEqual([800, 600]);
    });

    it('renders at device resolution on a high-density display', (): void => {
      Object.defineProperty(window, 'devicePixelRatio', {configurable: true, value: 2});

      freeze();

      expect([freezeCanvas.width, freezeCanvas.height]).toEqual([1600, 1200]);
      expect(contextOf(freezeCanvas).callsTo('setTransform')).toEqual([[2, 0, 0, 2, 0, 0]]);
    });

    it('treats a missing device pixel ratio as 1', (): void => {
      Object.defineProperty(window, 'devicePixelRatio', {configurable: true, value: 0});

      freeze();

      expect([freezeCanvas.width, freezeCanvas.height]).toEqual([800, 600]);
    });

    it('clears the canvas before painting the frame', (): void => {
      freeze();

      const context: RecordingContext = contextOf(freezeCanvas);
      expect(context.callsTo('clearRect')).toEqual([[0, 0, 800, 600]]);
      expect(context.names()).toEqual(['setTransform', 'clearRect', 'save', 'translate', 'scale', 'drawImage', 'restore']);
    });

    it('letterboxes a wide frame inside the element in the default aspect mode', (): void => {
      freeze();

      // 1920x1080 scaled to 800 wide is 450 tall, centred in 600
      const context: RecordingContext = contextOf(freezeCanvas);
      expect(context.callsTo('translate')).toEqual([[400, 300]]);
      expect(context.callsTo('drawImage')).toEqual([[video, -400, -225, 800, 450]]);
    });

    it('pillarboxes a tall frame inside the element in the default aspect mode', (): void => {
      setMediaState({videoWidth: 400, videoHeight: 600});

      freeze();

      expect(contextOf(freezeCanvas).callsTo('drawImage')).toEqual([[video, -200, -300, 400, 600]]);
    });

    it('places the frame where the element sits within the container', (): void => {
      layout(rect(100, 50, 1000, 700), rect(150, 100, 800, 600));

      freeze();

      // Element is inset 50px each way; the 800x450 content is centred in it
      expect(contextOf(freezeCanvas).callsTo('translate')).toEqual([[450, 350]]);
    });

    it.each<VideoAspectMode>(['4:3', '16:9', 'fit'])('stretches the frame over the whole element in %s mode', async (mode: VideoAspectMode): Promise<void> => {
      settings.videoAspectMode.set(mode);
      await settle();

      freeze();

      expect(contextOf(freezeCanvas).callsTo('drawImage')).toEqual([[video, -400, -300, 800, 600]]);
    });

    it.each<[VideoFlipMode, number, number]>([
      ['none', 1, 1],
      ['horizontal', -1, 1],
      ['vertical', 1, -1],
      ['both', -1, -1],
    ])('mirrors the frame to match the %s flip', (mode: VideoFlipMode, x: number, y: number): void => {
      component.setFlipMode(mode);

      freeze();

      expect(contextOf(freezeCanvas).callsTo('scale')).toEqual([[x, y]]);
    });

    it('wipes the canvas instead when the element has no frame to capture', (): void => {
      setMediaState({readyState: 1});
      freezeCanvas.width = 640;
      freezeCanvas.height = 360;

      freeze();

      expect(contextOf(freezeCanvas).calls).toEqual([{name: 'clearRect', args: [0, 0, 640, 360]}]);
    });

    it('treats an element with no video dimensions as having no frame', (): void => {
      setMediaState({videoWidth: 0, videoHeight: 0});

      freeze();

      expect(contextOf(freezeCanvas).callsTo('drawImage')).toEqual([]);
    });

    it('keeps the frame already captured when a second reload starts before the first can play', (): void => {
      freeze(1);
      const paintedOnce: number = contextOf(freezeCanvas).calls.length;
      // The source was just swapped, so nothing is decodable any more
      setMediaState({readyState: 0});

      freeze(2);

      expect(contextOf(freezeCanvas).calls.length).toBe(paintedOnce);
    });

    it('does not restart the spinner for a second reload', (): void => {
      freeze(1);

      freeze(2);

      expect(contextOf(spinnerCanvas).callsTo('setTransform').length).toBe(1);
    });

    it('still shows the overlay when the canvas cannot provide a context', async (): Promise<void> => {
      contextless.add(freezeCanvas);

      freeze();
      await settle();

      expect(overlayShowing()).toBe(true);
    });
  });

  // ==========================================================================
  // Subtitles — Loading And Selection
  // ==========================================================================

  describe('loading subtitle tracks', (): void => {
    const FILE: string = '/movies/a.mp4';

    /** Loads a video, then delivers media info listing its subtitle tracks. */
    async function loadWithSubtitles(tracks: SubtitleTrack[], filePath: string = FILE): Promise<void> {
      await loadTrack(filePath);
      await announceMedia(filePath, {subtitleTracks: tracks});
    }

    /** Registers a one-cue WebVTT body (0s–10s) for a track of FILE. */
    function serve(track: number, text: string, filePath: string = FILE): void {
      electron.subtitleFiles.set(subtitleKey(filePath, track), vtt([0, 10, text]));
    }

    it('requests nothing for a video without subtitle tracks', async (): Promise<void> => {
      mount();

      await loadWithSubtitles([]);

      expect(electron.requests).toEqual([]);
    });

    it('fetches each track as WebVTT from the media server', async (): Promise<void> => {
      serve(0, 'zero');
      serve(3, 'three');
      mount();

      await loadWithSubtitles([subtitleTrack(0), subtitleTrack(3)]);

      const path: string = encodeURIComponent(FILE);
      expect(electron.requests.map((r: SubtitleRequest): string => r.url)).toEqual([
        `${SERVER}/media/subtitles?path=${path}&track=0`,
        `${SERVER}/media/subtitles?path=${path}&track=3`,
      ]);
    });

    it('selects the track the container marks as default', async (): Promise<void> => {
      serve(0, 'zero');
      serve(1, 'one');
      mount();

      await loadWithSubtitles([subtitleTrack(0), subtitleTrack(1, {default: true})]);

      expect(component.selectedSubtitleTrack()).toBe(1);
    });

    it('shows the selected track at the current position as soon as it has loaded', async (): Promise<void> => {
      serve(0, 'Already talking');
      mount();
      video.currentTime = 2;

      await loadWithSubtitles([subtitleTrack(0, {default: true})]);

      expect(subtitleOverlay()?.textContent).toBe('Already talking');
    });

    it('leaves subtitles off when no track is marked default', async (): Promise<void> => {
      serve(0, 'zero');
      mount();

      await loadWithSubtitles([subtitleTrack(0)]);
      await playTo(1);

      expect(component.selectedSubtitleTrack()).toBe(-1);
      expect(subtitleOverlay()).toBeNull();
    });

    it('remembers the automatic choice for the file', async (): Promise<void> => {
      serve(1, 'one');
      mount();

      await loadWithSubtitles([subtitleTrack(1, {default: true})]);

      expect(electron.setSubtitleSelection).toHaveBeenCalledWith(FILE, 1);
    });

    it('keeps subtitles off when the user prefers none, even if a track is default', async (): Promise<void> => {
      settings.preferredSubtitleLanguage.set('off');
      serve(0, 'zero');
      mount();

      await loadWithSubtitles([subtitleTrack(0, {default: true})]);

      expect(component.selectedSubtitleTrack()).toBe(-1);
    });

    it('prefers a track in the user\'s language over the default track', async (): Promise<void> => {
      settings.preferredSubtitleLanguage.set('spa');
      serve(0, 'hello');
      serve(1, 'hola');
      mount();

      await loadWithSubtitles([subtitleTrack(0, {default: true}), subtitleTrack(1, {language: 'spa'})]);

      expect(component.selectedSubtitleTrack()).toBe(1);
    });

    it('falls back to the default track when none matches the user\'s language', async (): Promise<void> => {
      settings.preferredSubtitleLanguage.set('spa');
      serve(0, 'hello');
      serve(1, 'bonjour');
      mount();

      await loadWithSubtitles([subtitleTrack(0, {language: 'fre'}), subtitleTrack(1, {default: true})]);

      expect(component.selectedSubtitleTrack()).toBe(1);
    });

    it('falls back to off when neither the user\'s language nor a default track exists', async (): Promise<void> => {
      settings.preferredSubtitleLanguage.set('spa');
      serve(0, 'hello');
      mount();

      await loadWithSubtitles([subtitleTrack(0)]);

      expect(component.selectedSubtitleTrack()).toBe(-1);
    });

    it('restores the track the user previously chose for the file', async (): Promise<void> => {
      electron.setSubtitleSelection(FILE, 0);
      serve(0, 'chosen');
      serve(1, 'default');
      mount();

      await loadWithSubtitles([subtitleTrack(0), subtitleTrack(1, {default: true})]);
      await playTo(1);

      expect(subtitleOverlay()?.textContent).toBe('chosen');
    });

    it('does not overwrite a remembered choice with the automatic one', async (): Promise<void> => {
      electron.setSubtitleSelection(FILE, 0);
      electron.setSubtitleSelection.mockClear();
      serve(0, 'chosen');
      serve(1, 'default');
      mount();

      await loadWithSubtitles([subtitleTrack(0), subtitleTrack(1, {default: true})]);

      expect(electron.setSubtitleSelection).not.toHaveBeenCalled();
    });

    it('keeps subtitles off when the user previously turned them off for the file', async (): Promise<void> => {
      electron.setSubtitleSelection(FILE, -1);
      serve(0, 'default');
      mount();

      await loadWithSubtitles([subtitleTrack(0, {default: true})]);
      await playTo(1);

      expect(subtitleOverlay()).toBeNull();
    });

    it('skips a track the server refuses and still loads the rest', async (): Promise<void> => {
      serve(1, 'survivor');
      mount();
      await loadWithSubtitles([subtitleTrack(0), subtitleTrack(1, {default: true})]);

      electron.requests[0].respond('', 500);
      await settle();
      await playTo(1);

      expect(consoleError).toHaveBeenCalledWith('Failed to load subtitle track 0: 500');
      expect(subtitleOverlay()?.textContent).toBe('survivor');
    });

    it('skips a track whose request fails and still loads the rest', async (): Promise<void> => {
      const failure: Error = new Error('connection reset');
      serve(1, 'survivor');
      mount();
      await loadWithSubtitles([subtitleTrack(0), subtitleTrack(1, {default: true})]);

      electron.requests[0].fail(failure);
      await settle();
      await playTo(1);

      expect(consoleError).toHaveBeenCalledWith('Error loading subtitle track 0:', failure);
      expect(subtitleOverlay()?.textContent).toBe('survivor');
    });

    it('shows nothing for a selected track that failed to load', async (): Promise<void> => {
      mount();
      await loadWithSubtitles([subtitleTrack(0, {default: true})]);

      electron.requests[0].respond('', 500);
      await settle();
      await playTo(1);

      expect(subtitleOverlay()).toBeNull();
      expect(consoleWarn).toHaveBeenCalled();
    });

    it('clears the selection and the display when the media no longer has subtitle tracks', async (): Promise<void> => {
      serve(0, 'gone soon');
      mount();
      await loadWithSubtitles([subtitleTrack(0, {default: true})]);
      await playTo(1);

      await announceMedia(FILE, {subtitleTracks: []});

      expect(component.selectedSubtitleTrack()).toBe(-1);
      expect(subtitleOverlay()).toBeNull();
    });

    // ------------------------------------------------------------------------
    // Switching video while a load is in flight
    // ------------------------------------------------------------------------

    describe('when the video changes while tracks are still loading', (): void => {
      const NEXT: string = '/movies/b.mp4';

      /** One default track; a fresh list each time, as each media info push carries. */
      function oneTrack(): SubtitleTrack[] {
        return [subtitleTrack(0, {default: true})];
      }

      /** Starts loading FILE's subtitles and leaves the request unanswered. */
      async function startLoadingFirstVideo(tracks: SubtitleTrack[] = oneTrack()): Promise<void> {
        mount();
        await loadWithSubtitles(tracks);
      }

      it('aborts the request still in flight for the previous video', async (): Promise<void> => {
        await startLoadingFirstVideo();

        await loadWithSubtitles(oneTrack(), NEXT);

        const [previous, current]: SubtitleRequest[] = electron.requests;
        expect(previous.signal?.aborted).toBe(true);
        expect(current.signal?.aborted).toBe(false);
      });

      it('does not report the deliberate abort as a failure', async (): Promise<void> => {
        await startLoadingFirstVideo();

        await loadWithSubtitles(oneTrack(), NEXT);

        expect(consoleError).not.toHaveBeenCalled();
      });

      it('does not go on to request the previous video\'s remaining tracks', async (): Promise<void> => {
        await startLoadingFirstVideo([subtitleTrack(0, {default: true}), subtitleTrack(1)]);

        await loadWithSubtitles([], NEXT);

        expect(electron.requests.map((r: SubtitleRequest): string => `${r.path}#${r.track}`)).toEqual([`${FILE}#0`]);
      });

      it('never shows the previous video\'s cues when its response lands just as the video changes', async (): Promise<void> => {
        await startLoadingFirstVideo();
        await loadTrack(NEXT);
        // The response arrives, but the switch is processed before its continuation runs
        electron.requests[0].respond(vtt([0, 10, 'From the previous video']));
        electron.currentMedia.set(mediaInfo(NEXT, {subtitleTracks: oneTrack()}));
        fixture.detectChanges();
        await settle();

        electron.requests[1].respond(vtt([0, 10, 'From the new video']));
        await settle();
        await playTo(1);

        expect(subtitleOverlay()?.textContent).toBe('From the new video');
      });

      it('never shows the previous video\'s cues when its body finishes downloading after the change', async (): Promise<void> => {
        let finishBody: (body: string) => void = (): void => {};
        const body: Promise<string> = new Promise<string>((resolve: (value: string) => void): void => {
          finishBody = resolve;
        });
        await startLoadingFirstVideo();
        electron.requests[0].respondWith({ok: true, status: 200, text: (): Promise<string> => body} as Response);
        await settle();
        await loadWithSubtitles(oneTrack(), NEXT);

        finishBody(vtt([0, 10, 'From the previous video']));
        await settle();
        electron.requests[1].respond(vtt([0, 10, 'From the new video']));
        await settle();
        await playTo(1);

        expect(subtitleOverlay()?.textContent).toBe('From the new video');
      });

      it('shows no subtitles on a new video without tracks when the old response arrives late', async (): Promise<void> => {
        await startLoadingFirstVideo();
        await loadTrack(NEXT);
        electron.requests[0].respond(vtt([0, 10, 'From the previous video']));
        electron.currentMedia.set(mediaInfo(NEXT));
        fixture.detectChanges();

        await settle();
        await playTo(1);

        expect(component.selectedSubtitleTrack()).toBe(-1);
        expect(subtitleOverlay()).toBeNull();
      });

      it('does not record a subtitle choice for the previous video', async (): Promise<void> => {
        await startLoadingFirstVideo();
        await loadTrack(NEXT);
        electron.requests[0].respond(vtt([0, 10, 'From the previous video']));
        electron.currentMedia.set(mediaInfo(NEXT, {subtitleTracks: oneTrack()}));
        fixture.detectChanges();
        await settle();

        electron.requests[1].respond(vtt([0, 10, 'From the new video']));
        await settle();

        expect(electron.setSubtitleSelection.mock.calls).toEqual([[NEXT, 0]]);
      });
    });
  });

  // ==========================================================================
  // Subtitles — Display
  // ==========================================================================

  describe('displaying subtitle cues', (): void => {
    const FILE: string = '/movies/a.mp4';

    /** Loads FILE with one default track (index 0) holding the given WebVTT. */
    async function loadWithCues(content: string, filePath: string = FILE): Promise<void> {
      electron.subtitleFiles.set(subtitleKey(filePath, 0), content);
      mount();
      await loadTrack(filePath);
      await announceMedia(filePath, {subtitleTracks: [subtitleTrack(0, {default: true})]});
    }

    it('shows nothing before the first cue', async (): Promise<void> => {
      await loadWithCues(vtt([5, 8, 'Hello']));

      await playTo(4.9);

      expect(subtitleOverlay()).toBeNull();
    });

    it('shows a cue while playback is inside its time range', async (): Promise<void> => {
      await loadWithCues(vtt([5, 8, 'Hello']));

      await playTo(6);

      expect(subtitleOverlay()?.textContent).toBe('Hello');
    });

    it('shows a cue from its exact start to its exact end', async (): Promise<void> => {
      await loadWithCues(vtt([5, 8, 'Hello']));

      await playTo(5);
      const atStart: string | undefined = subtitleOverlay()?.textContent;
      await playTo(8);

      expect(atStart).toBe('Hello');
      expect(subtitleOverlay()?.textContent).toBe('Hello');
    });

    it('removes the overlay once the cue has ended', async (): Promise<void> => {
      await loadWithCues(vtt([5, 8, 'Hello']));
      await playTo(6);

      await playTo(8.1);

      expect(subtitleOverlay()).toBeNull();
    });

    it('moves on to the next cue', async (): Promise<void> => {
      await loadWithCues(vtt([5, 8, 'Hello'], [9, 12, 'Goodbye']));
      await playTo(6);

      await playTo(10);

      expect(subtitleOverlay()?.textContent).toBe('Goodbye');
    });

    it('stacks cues that overlap in time', async (): Promise<void> => {
      await loadWithCues(vtt([5, 8, 'First speaker'], [6, 9, 'Second speaker']));

      await playTo(7);

      expect(subtitleOverlay()?.innerHTML).toBe('First speaker<br>Second speaker');
    });

    it('refreshes immediately when a seek lands, without waiting for playback to tick', async (): Promise<void> => {
      await loadWithCues(vtt([5, 8, 'Hello']));

      video.currentTime = 6;
      fire('seeked');
      await settle();

      expect(subtitleOverlay()?.textContent).toBe('Hello');
    });

    it('renders the formatting tags subtitle files use', async (): Promise<void> => {
      await loadWithCues(vtt([5, 8, '<i>Whispering</i>']));

      await playTo(6);

      expect(subtitleOverlay()?.innerHTML).toBe('<i>Whispering</i>');
    });

    it('renders any other markup in a cue as inert text', async (): Promise<void> => {
      await loadWithCues(vtt([5, 8, '<img src=x onerror=alert(1)>']));

      await playTo(6);

      expect(subtitleOverlay()?.querySelector('img')).toBeNull();
      expect(subtitleOverlay()?.textContent).toBe('<img src=x onerror=alert(1)>');
    });

    it('breaks a multi-line cue onto separate lines', async (): Promise<void> => {
      await loadWithCues(vtt([5, 8, 'Line one\nLine two']));

      await playTo(6);

      expect(subtitleOverlay()?.innerHTML).toBe('Line one<br>Line two');
    });

    it('times cues against media time, not stream time, after a transcoded seek', async (): Promise<void> => {
      await loadWithCues(vtt([102, 105, 'Deep into the film']), '/movies/a.mkv');
      await seekStreamTo(100);
      fire('canplay');

      // 3s into a stream that starts at 100s
      await playTo(3);

      expect(subtitleOverlay()?.textContent).toBe('Deep into the film');
    });

    it('follows the keyframe the server actually cut the stream at', async (): Promise<void> => {
      await loadWithCues(vtt([100, 100.4, 'On the keyframe']), '/movies/a.mkv');
      await seekStreamTo(100);
      electron.seekAlignment.set({requested: 100, actual: 97.5});
      await settle();

      // 97.5s + 2.7s = 100.2s
      await playTo(2.7);

      expect(subtitleOverlay()?.textContent).toBe('On the keyframe');
    });

    describe('choosing a track by hand', (): void => {
      /** Loads FILE with two tracks: 0 (default, 'English') and 1 ('Deutsch'). */
      async function loadTwoTracks(): Promise<void> {
        electron.subtitleFiles.set(subtitleKey(FILE, 0), vtt([0, 10, 'English']));
        electron.subtitleFiles.set(subtitleKey(FILE, 1), vtt([0, 10, 'Deutsch']));
        mount();
        await loadTrack(FILE);
        await announceMedia(FILE, {subtitleTracks: [subtitleTrack(0, {default: true}), subtitleTrack(1, {language: 'ger'})]});
        await playTo(1);
      }

      it('switches the display to the chosen track straight away', async (): Promise<void> => {
        await loadTwoTracks();

        component.selectSubtitleTrack(1);
        await settle();

        expect(subtitleOverlay()?.textContent).toBe('Deutsch');
      });

      it('hides the overlay when subtitles are turned off', async (): Promise<void> => {
        await loadTwoTracks();

        component.selectSubtitleTrack(-1);
        await settle();

        expect(subtitleOverlay()).toBeNull();
      });

      it('stays off as playback continues', async (): Promise<void> => {
        await loadTwoTracks();
        component.selectSubtitleTrack(-1);

        await playTo(2);

        expect(subtitleOverlay()).toBeNull();
      });

      it('remembers the choice for the file', async (): Promise<void> => {
        await loadTwoTracks();

        component.selectSubtitleTrack(1);

        expect(electron.setSubtitleSelection).toHaveBeenLastCalledWith(FILE, 1);
      });

      it('has no file to remember a choice for before any video is loaded', (): void => {
        mount();

        component.selectSubtitleTrack(-1);

        expect(electron.setSubtitleSelection).not.toHaveBeenCalled();
      });

      it('shows nothing for a track that was never loaded', async (): Promise<void> => {
        await loadTwoTracks();

        component.selectSubtitleTrack(7);
        await settle();

        expect(subtitleOverlay()).toBeNull();
      });
    });
  });

  // ==========================================================================
  // External Subtitles
  // ==========================================================================

  describe('external subtitle files', (): void => {
    const FILE: string = '/movies/a.mp4';
    const SUBS: string = '/subs/a (forced).srt';

    beforeEach(async (): Promise<void> => {
      mount();
      await loadTrack(FILE);
      video.currentTime = 1;
    });

    /** Has the dialog return SUBS and the server answer it with one cue. */
    function chooseFile(text: string = 'From the file'): void {
      electron.openSubtitleDialog.mockResolvedValue(SUBS);
      electron.subtitleFiles.set(subtitleKey(SUBS, 'external'), vtt([0, 10, text]));
    }

    it('reports no external subtitle to begin with', (): void => {
      expect(component.hasExternalSubtitle()).toBe(false);
    });

    it('asks the server to convert the chosen file', async (): Promise<void> => {
      chooseFile();

      await component.loadExternalSubtitle();

      expect(electron.requests.map((r: SubtitleRequest): string => r.url))
        .toEqual([`${SERVER}/media/subtitles/external?path=${encodeURIComponent(SUBS)}`]);
    });

    it('selects the external track and shows its cue at the current position', async (): Promise<void> => {
      chooseFile();

      await component.loadExternalSubtitle();
      await settle();

      expect(component.selectedSubtitleTrack()).toBe(-2);
      expect(subtitleOverlay()?.textContent).toBe('From the file');
    });

    it('reports that an external subtitle is loaded', async (): Promise<void> => {
      chooseFile();

      await component.loadExternalSubtitle();

      expect(component.hasExternalSubtitle()).toBe(true);
    });

    it('keeps showing the external cues as playback continues', async (): Promise<void> => {
      electron.openSubtitleDialog.mockResolvedValue(SUBS);
      electron.subtitleFiles.set(subtitleKey(SUBS, 'external'), vtt([0, 10, 'One'], [20, 30, 'Two']));
      await component.loadExternalSubtitle();

      await playTo(25);

      expect(subtitleOverlay()?.textContent).toBe('Two');
    });

    it('does nothing when the dialog is cancelled', async (): Promise<void> => {
      electron.openSubtitleDialog.mockResolvedValue(null);

      await component.loadExternalSubtitle();

      expect(electron.requests).toEqual([]);
      expect(component.hasExternalSubtitle()).toBe(false);
    });

    it('leaves the selection alone when the server rejects the file', async (): Promise<void> => {
      electron.openSubtitleDialog.mockResolvedValue(SUBS);
      const loading: Promise<void> = component.loadExternalSubtitle();
      await settle();

      electron.requests[0].respond('', 415);
      await loading;

      expect(component.selectedSubtitleTrack()).toBe(-1);
      expect(consoleError).toHaveBeenCalledWith('Failed to load external subtitle: 415');
    });

    it('leaves the selection alone when the request fails', async (): Promise<void> => {
      const failure: Error = new Error('connection reset');
      electron.openSubtitleDialog.mockResolvedValue(SUBS);
      const loading: Promise<void> = component.loadExternalSubtitle();
      await settle();

      electron.requests[0].fail(failure);
      await loading;

      expect(component.selectedSubtitleTrack()).toBe(-1);
      expect(consoleError).toHaveBeenCalledWith('Error loading external subtitle:', failure);
    });

    it('does not request the file while the server URL is unknown', async (): Promise<void> => {
      chooseFile();
      mediaPlayer.serverUrl.set('');

      await component.loadExternalSubtitle();

      expect(electron.requests).toEqual([]);
    });

    it('can be turned off and back on from the track menu', async (): Promise<void> => {
      chooseFile();
      await component.loadExternalSubtitle();
      component.selectSubtitleTrack(-1);
      await settle();
      const whileOff: HTMLElement | null = subtitleOverlay();

      component.selectSubtitleTrack(-2);
      await settle();

      expect(whileOff).toBeNull();
      expect(subtitleOverlay()?.textContent).toBe('From the file');
    });

    it('is cleared from the display when the next video\'s media info arrives', async (): Promise<void> => {
      chooseFile();
      await component.loadExternalSubtitle();
      await settle();
      await loadTrack('/movies/b.mp4');

      await announceMedia('/movies/b.mp4');
      await playTo(1);

      expect(subtitleOverlay()).toBeNull();
    });
  });

  // ==========================================================================
  // Subtitle Appearance
  // ==========================================================================

  describe('subtitle appearance', (): void => {
    it('injects one stylesheet for the overlay into the document head', (): void => {
      mount();

      expect(document.head.querySelectorAll('#onix-subtitle-styles').length).toBe(1);
      expect(subtitleStyle()?.textContent).toContain('.subtitle-overlay {');
    });

    it('applies the font size as a percentage', (): void => {
      settings.subtitleFontSize.set(150);
      mount();

      expect(subtitleStyle()?.textContent).toContain('font-size: 150% !important;');
    });

    it('applies the font colour', (): void => {
      settings.subtitleFontColor.set('#ffee00');
      mount();

      expect(subtitleStyle()?.textContent).toContain('color: #ffee00 !important;');
    });

    it('applies the font family with a sans-serif fallback', (): void => {
      settings.subtitleFontFamily.set('monospace');
      mount();

      expect(subtitleStyle()?.textContent).toContain('font-family: monospace, sans-serif !important;');
    });

    it('combines the background colour and opacity into one rgba colour', (): void => {
      settings.subtitleBackgroundColor.set('#102030');
      settings.subtitleBackgroundOpacity.set(0.25);
      mount();

      expect(subtitleStyle()?.textContent).toContain('background-color: rgba(16, 32, 48, 0.25) !important;');
    });

    it('outlines the text with the configured shadow spread, blur and colour', (): void => {
      settings.subtitleShadowSpread.set(4);
      settings.subtitleShadowBlur.set(6);
      settings.subtitleShadowColor.set('#112233');
      mount();

      const css: string = subtitleStyle()?.textContent ?? '';
      expect(css).toContain('text-shadow: 0 -4px 6px #112233, 4px -4px 6px #112233,');
      expect(css).toContain('-4px -4px 6px #112233 !important;');
    });

    it('removes the shadow when it is switched off', (): void => {
      settings.subtitleTextShadow.set(false);
      mount();

      expect(subtitleStyle()?.textContent).toContain('text-shadow: none !important;');
    });

    it('rewrites the same stylesheet when a setting changes', async (): Promise<void> => {
      mount();

      settings.subtitleFontSize.set(220);
      await settle();

      expect(document.head.querySelectorAll('#onix-subtitle-styles').length).toBe(1);
      expect(subtitleStyle()?.textContent).toContain('font-size: 220% !important;');
      expect(subtitleStyle()?.textContent).not.toContain('font-size: 100%');
    });
  });

  // ==========================================================================
  // Audio Tracks
  // ==========================================================================

  describe('audio tracks', (): void => {
    const NATIVE: string = '/movies/a.mp4';
    const STREAMED: string = '/movies/a.mkv';
    const ENGLISH_AND_JAPANESE: AudioTrack[] = [
      audioTrack(0, {language: 'eng', default: true}),
      audioTrack(1, {language: 'jpn'}),
    ];

    describe('switching by hand', (): void => {
      it('reloads a native file with the chosen track', async (): Promise<void> => {
        mount();
        await loadTrack(NATIVE);

        component.selectAudioTrack(1);

        expect(src()).toBe(streamUrl(NATIVE, '&audioTrack=1'));
        expect(load).toHaveBeenCalledTimes(2);
      });

      it('does not reload when the chosen track is already playing', async (): Promise<void> => {
        mount();
        await loadTrack(NATIVE);

        component.selectAudioTrack(0);

        expect(load).toHaveBeenCalledTimes(1);
      });

      it('remembers the choice for the file', async (): Promise<void> => {
        mount();
        await loadTrack(NATIVE);

        component.selectAudioTrack(1);

        expect(electron.setAudioSelection).toHaveBeenCalledWith(NATIVE, 1);
      });

      it('returns a native file to where it was once the new source can play', async (): Promise<void> => {
        mount();
        await loadTrack(NATIVE);
        video.currentTime = 30;
        component.selectAudioTrack(1);
        video.currentTime = 0;

        fire('canplay');

        expect(video.currentTime).toBe(30);
      });

      it('does not reposition a native file that was at the very start', async (): Promise<void> => {
        mount();
        await loadTrack(NATIVE);
        component.selectAudioTrack(1);
        video.currentTime = 5;

        fire('canplay');

        expect(video.currentTime).toBe(5);
      });

      it('restarts a transcoded stream at the current media position with the chosen track', async (): Promise<void> => {
        mount();
        await loadTrack(STREAMED);
        await seekStreamTo(100);
        fire('canplay');
        video.currentTime = 7;

        component.selectAudioTrack(1);

        expect(src()).toBe(streamUrl(STREAMED, '&t=107&audioTrack=1'));
      });

      it('keeps subtitles in step after a transcoded stream restarts for an audio switch', async (): Promise<void> => {
        electron.subtitleFiles.set(subtitleKey(STREAMED, 0), vtt([40, 45, 'Still in sync']));
        mount();
        await loadTrack(STREAMED);
        await announceMedia(STREAMED, {subtitleTracks: [subtitleTrack(0, {default: true})]});
        video.currentTime = 38;
        component.selectAudioTrack(1);

        // The new stream starts at 38s; 3s into it is 41s of media
        await playTo(3);

        expect(subtitleOverlay()?.textContent).toBe('Still in sync');
      });

      it('carries on playing if the video was playing', async (): Promise<void> => {
        mount();
        await loadTrack(NATIVE);
        setMediaState({paused: false});

        component.selectAudioTrack(1);

        expect(play).toHaveBeenCalledTimes(1);
      });

      it('stays paused if the video was paused', async (): Promise<void> => {
        mount();
        await loadTrack(NATIVE);
        setMediaState({paused: true});

        component.selectAudioTrack(1);

        expect(play).not.toHaveBeenCalled();
      });

      it('does nothing when no video is loaded', async (): Promise<void> => {
        mount();

        component.selectAudioTrack(1);
        await settle();

        expect(load).not.toHaveBeenCalled();
        expect(electron.setAudioSelection).not.toHaveBeenCalled();
        expect(overlayShowing()).toBe(false);
      });

      it('shows the seek-loading overlay while the stream restarts', async (): Promise<void> => {
        mount();
        await loadTrack(NATIVE);

        component.selectAudioTrack(1);
        await settle();

        expect(overlayShowing()).toBe(true);
      });
    });

    describe('choosing a track when a video loads', (): void => {
      it('uses the track the user previously chose for the file', async (): Promise<void> => {
        electron.setAudioSelection(STREAMED, 2);
        mount();

        await loadTrack(STREAMED);

        expect(src()).toBe(streamUrl(STREAMED, '&audioTrack=2'));
      });

      it('uses the track in the user\'s preferred language', async (): Promise<void> => {
        settings.preferredAudioLanguage.set('jpn');
        mount();
        await announceMedia(STREAMED, {audioTracks: ENGLISH_AND_JAPANESE});

        await loadTrack(STREAMED);

        expect(src()).toBe(streamUrl(STREAMED, '&audioTrack=1'));
      });

      it('falls back to the default track when the preferred language is absent', async (): Promise<void> => {
        settings.preferredAudioLanguage.set('kor');
        mount();
        await announceMedia(STREAMED, {audioTracks: [audioTrack(0), audioTrack(1, {language: 'jpn', default: true})]});

        await loadTrack(STREAMED);

        expect(src()).toBe(streamUrl(STREAMED, '&audioTrack=1'));
      });

      it('uses the container\'s default track when the user has no language preference', async (): Promise<void> => {
        mount();
        await announceMedia(STREAMED, {audioTracks: [audioTrack(0), audioTrack(1, {default: true})]});

        await loadTrack(STREAMED);

        expect(src()).toBe(streamUrl(STREAMED, '&audioTrack=1'));
      });

      it('uses the first track when none is marked default', async (): Promise<void> => {
        mount();
        await announceMedia(STREAMED, {audioTracks: [audioTrack(0), audioTrack(1)]});

        await loadTrack(STREAMED);

        expect(src()).toBe(streamUrl(STREAMED, '&audioTrack=0'));
      });
    });

    describe('when the track list arrives after the video has started loading', (): void => {
      it('restarts the stream on the preferred-language track', async (): Promise<void> => {
        settings.preferredAudioLanguage.set('jpn');
        mount();
        await loadTrack(STREAMED);

        await announceMedia(STREAMED, {audioTracks: ENGLISH_AND_JAPANESE});

        expect(src()).toBe(streamUrl(STREAMED, '&t=0&audioTrack=1'));
      });

      it('restarts on the container\'s default track when the user has no preference', async (): Promise<void> => {
        mount();
        await loadTrack(STREAMED);

        await announceMedia(STREAMED, {audioTracks: [audioTrack(0), audioTrack(1, {default: true})]});

        expect(src()).toBe(streamUrl(STREAMED, '&t=0&audioTrack=1'));
      });

      it('restarts on the default track when the preferred language is absent', async (): Promise<void> => {
        settings.preferredAudioLanguage.set('kor');
        mount();
        await loadTrack(STREAMED);

        await announceMedia(STREAMED, {audioTracks: [audioTrack(0), audioTrack(1, {default: true})]});

        expect(src()).toBe(streamUrl(STREAMED, '&t=0&audioTrack=1'));
      });

      it('restarts from the position already reached', async (): Promise<void> => {
        settings.preferredAudioLanguage.set('jpn');
        mount();
        await loadTrack(STREAMED);
        video.currentTime = 4;

        await announceMedia(STREAMED, {audioTracks: ENGLISH_AND_JAPANESE});

        expect(src()).toBe(streamUrl(STREAMED, '&t=4&audioTrack=1'));
      });

      it('reloads a native file with the preferred track and returns it to where it was', async (): Promise<void> => {
        settings.preferredAudioLanguage.set('jpn');
        mount();
        await loadTrack(NATIVE);
        video.currentTime = 4;
        await announceMedia(NATIVE, {audioTracks: ENGLISH_AND_JAPANESE});
        video.currentTime = 0;

        fire('canplay');

        expect(src()).toBe(streamUrl(NATIVE, '&audioTrack=1'));
        expect(video.currentTime).toBe(4);
      });

      it('does not restart when no track is marked default and the user has no preference', async (): Promise<void> => {
        mount();
        await loadTrack(STREAMED);

        await announceMedia(STREAMED, {audioTracks: [audioTrack(0), audioTrack(1, {language: 'jpn'})]});

        expect(load).toHaveBeenCalledTimes(1);
      });

      it('does not restart when neither the preferred language nor a default track exists', async (): Promise<void> => {
        settings.preferredAudioLanguage.set('kor');
        mount();
        await loadTrack(STREAMED);

        await announceMedia(STREAMED, {audioTracks: [audioTrack(0), audioTrack(1, {language: 'jpn'})]});

        expect(load).toHaveBeenCalledTimes(1);
      });

      it('does not restart when the right track is already the first one', async (): Promise<void> => {
        settings.preferredAudioLanguage.set('eng');
        mount();
        await loadTrack(STREAMED);

        await announceMedia(STREAMED, {audioTracks: ENGLISH_AND_JAPANESE});

        expect(load).toHaveBeenCalledTimes(1);
      });

      it('does not override a track the user chose by hand', async (): Promise<void> => {
        settings.preferredAudioLanguage.set('jpn');
        electron.setAudioSelection(STREAMED, 0);
        mount();
        await loadTrack(STREAMED);

        await announceMedia(STREAMED, {audioTracks: ENGLISH_AND_JAPANESE});

        expect(load).toHaveBeenCalledTimes(1);
      });

      it('does not restart a second time when the media info is delivered again', async (): Promise<void> => {
        settings.preferredAudioLanguage.set('jpn');
        mount();
        await loadTrack(STREAMED);
        await announceMedia(STREAMED, {audioTracks: ENGLISH_AND_JAPANESE});

        await announceMedia(STREAMED, {audioTracks: ENGLISH_AND_JAPANESE});

        expect(load).toHaveBeenCalledTimes(2);
      });
    });
  });

  // ==========================================================================
  // Aspect And Flip
  // ==========================================================================

  describe('aspect and flip modes', (): void => {
    it.each<[VideoAspectMode, string]>([
      ['default', 'aspect-default'],
      ['4:3', 'aspect-4-3'],
      ['16:9', 'aspect-16-9'],
      ['fit', 'aspect-fit'],
    ])('marks the container for the %s aspect mode', async (mode: VideoAspectMode, className: string): Promise<void> => {
      mount();

      settings.videoAspectMode.set(mode);
      await settle();

      const aspectClasses: string[] = [...container.classList].filter((c: string): boolean => c.startsWith('aspect-'));
      expect(aspectClasses).toEqual([className]);
    });

    it.each<[VideoFlipMode, string[]]>([
      ['none', []],
      ['horizontal', ['flip-horizontal']],
      ['vertical', ['flip-vertical']],
      ['both', ['flip-both']],
    ])('marks the container for the %s flip', async (mode: VideoFlipMode, classNames: string[]): Promise<void> => {
      mount();

      component.setFlipMode(mode);
      await settle();

      const flipClasses: string[] = [...container.classList].filter((c: string): boolean => c.startsWith('flip-'));
      expect(flipClasses).toEqual(classNames);
    });

    it('announces the aspect mode by its display name, starting with the current one', async (): Promise<void> => {
      const announced: string[] = [];
      mount((): void => {
        component.aspectModeChange.subscribe((name: string): void => {
          announced.push(name);
        });
      });

      component.setAspectMode('16:9');
      await settle();

      expect(announced).toEqual(['Default', 'Forced (16:9)']);
    });

    it('announces flip changes, starting with the current one', async (): Promise<void> => {
      const announced: VideoFlipMode[] = [];
      mount((): void => {
        component.flipChange.subscribe((mode: VideoFlipMode): void => {
          announced.push(mode);
        });
      });

      component.setFlipMode('vertical');
      await settle();

      expect(announced).toEqual(['none', 'vertical']);
    });

    it('resets the flip when a different video loads', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      component.setFlipMode('horizontal');

      await loadTrack('/movies/b.mp4');

      expect(container.classList.contains('flip-horizontal')).toBe(false);
    });

    it('keeps the flip when the same video is reloaded', async (): Promise<void> => {
      mount();
      await setState('loading');
      await loadTrack('/movies/a.mp4');
      await setState('playing');
      component.setFlipMode('horizontal');

      await setState('loading');

      expect(load).toHaveBeenCalledTimes(2);
      expect(container.classList.contains('flip-horizontal')).toBe(true);
    });

    it('toggles fullscreen on a double-click', (): void => {
      mount();

      container.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));

      expect(electron.toggleFullscreen).toHaveBeenCalledTimes(1);
    });

    it('adds media dropped onto the video to the playlist', async (): Promise<void> => {
      fileDrop.extractMediaFilePaths.mockReturnValue(['/movies/dropped.mkv']);
      mount();

      container.dispatchEvent(new Event('drop', {bubbles: true, cancelable: true}));
      await settle();

      expect(electron.addFilesWithAutoPlay).toHaveBeenCalledWith(['/movies/dropped.mkv']);
    });
  });

  // ==========================================================================
  // Video Adjustments
  // ==========================================================================

  describe('video adjustments', (): void => {
    it('applies no filter while adjustments are disabled', (): void => {
      settings.videoAdjustments.set({...NEUTRAL, brightness: 20});
      mount();

      expect(component.videoFilter()).toBe('none');
      expect(video.style.filter).toBe('none');
    });

    it('applies the enabled adjustments to the video element as a CSS filter', (): void => {
      settings.videoAdjustments.set({...NEUTRAL, brightness: 20, hue: -15, invert: true});
      settings.videoAdjustmentsEnabled.set(true);
      mount();

      expect(video.style.filter).toBe('brightness(1.2) hue-rotate(-15deg) invert(1)');
    });

    it('updates the filter live as a slider moves', async (): Promise<void> => {
      settings.videoAdjustmentsEnabled.set(true);
      mount();

      settings.videoAdjustments.set({...NEUTRAL, sepia: 30});
      await settle();

      expect(video.style.filter).toBe('sepia(0.3)');
    });

    it('applies no filter when every adjustment is neutral', (): void => {
      settings.videoAdjustmentsEnabled.set(true);
      mount();

      expect(video.style.filter).toBe('none');
    });
  });

  // ==========================================================================
  // Equalizer
  // ==========================================================================

  describe('the equalizer', (): void => {
    const BANDS: readonly number[] = [6, 5, 4, 3, 2, 1, 0, -1, -2, -3];

    /** Mounts with a loaded video and starts playback, which builds the graph. */
    async function startPlayback(): Promise<void> {
      mount();
      await loadTrack('/movies/a.mp4');
      await setState('playing');
    }

    /** The gain currently set on each band filter. */
    function gains(): number[] {
      return audioContext().filters.map((f: FakeBiquadFilter): number => f.gain.value);
    }

    it('creates no audio context until playback starts', async (): Promise<void> => {
      mount();

      await loadTrack('/movies/a.mp4');

      expect(FakeAudioContext.instances).toEqual([]);
    });

    it('takes the video element\'s audio as its source', async (): Promise<void> => {
      await startPlayback();

      expect(audioContext().sources.map((s: FakeMediaElementSource): HTMLMediaElement => s.element)).toEqual([video]);
    });

    it('routes the source through ten band filters in series to the output', async (): Promise<void> => {
      await startPlayback();

      const context: FakeAudioContext = audioContext();
      const chain: FakeAudioNode[] = [context.sources[0], ...context.filters, context.destination];
      expect(context.filters.length).toBe(10);
      chain.slice(0, -1).forEach((node: FakeAudioNode, i: number): void => {
        expect(node.connectedTo).toEqual([chain[i + 1]]);
      });
    });

    it('applies the configured band gains when enabled', async (): Promise<void> => {
      settings.equalizerEnabled.set(true);
      settings.equalizerBands.set(BANDS);

      await startPlayback();

      expect(gains()).toEqual(BANDS);
    });

    it('stays flat while disabled, whatever the bands are set to', async (): Promise<void> => {
      settings.equalizerBands.set(BANDS);

      await startPlayback();

      expect(gains()).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('retunes the filters when a band is changed during playback', async (): Promise<void> => {
      settings.equalizerEnabled.set(true);
      await startPlayback();

      settings.equalizerBands.set(BANDS);
      await settle();

      expect(gains()).toEqual(BANDS);
    });

    it('goes flat when switched off during playback', async (): Promise<void> => {
      settings.equalizerEnabled.set(true);
      settings.equalizerBands.set(BANDS);
      await startPlayback();

      settings.equalizerEnabled.set(false);
      await settle();

      expect(gains()).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('builds the graph once, however often playback is paused and resumed', async (): Promise<void> => {
      await startPlayback();

      await setState('paused');
      await setState('playing');

      expect(FakeAudioContext.instances.length).toBe(1);
      expect(audioContext().sources.length).toBe(1);
    });

    it('resumes a suspended audio context when playback starts', async (): Promise<void> => {
      FakeAudioContext.initialState = 'suspended';

      await startPlayback();

      expect(audioContext().resume).toHaveBeenCalledTimes(1);
    });

    it('leaves a running audio context alone', async (): Promise<void> => {
      await startPlayback();

      expect(audioContext().resume).not.toHaveBeenCalled();
    });

    it('still plays the video when the audio graph cannot be built', async (): Promise<void> => {
      FakeAudioContext.failConstruction = true;
      mount();
      await loadTrack('/movies/a.mp4');
      setMediaState({readyState: 4});

      await setState('playing');

      expect(play).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith('Failed to initialize video audio graph', expect.any(Error));
    });
  });

  // ==========================================================================
  // Clock Sync
  // ==========================================================================

  describe('keeping the server clock in step with the element', (): void => {
    /** Mounts a playing native video that is past every settle window. */
    async function playNative(): Promise<void> {
      mount();
      await loadTrack('/movies/a.mp4');
      setMediaState({readyState: 4, paused: false});
      await setState('playing');
      passGuards();
    }

    it('reports the element position when it has drifted from the server', async (): Promise<void> => {
      await playNative();
      await setServerTime(10);

      await playTo(10.9);

      expect(electron.syncPlaybackTime.mock.calls).toEqual([[10.9]]);
    });

    it('tolerates drift of up to three quarters of a second', async (): Promise<void> => {
      await playNative();
      await setServerTime(10);

      await playTo(10.75);

      expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('reports the element running behind the server as well as ahead', async (): Promise<void> => {
      await playNative();
      video.currentTime = 9.1;
      await setServerTime(10);

      await playTo(9.1);

      expect(electron.syncPlaybackTime.mock.calls).toEqual([[9.1]]);
    });

    it('reports at most once a second', async (): Promise<void> => {
      await playNative();
      await setServerTime(10);
      await playTo(10.9);
      vi.advanceTimersByTime(999);

      await playTo(10.95);

      expect(electron.syncPlaybackTime).toHaveBeenCalledTimes(1);
    });

    it('reports again after a second if the drift persists', async (): Promise<void> => {
      await playNative();
      await setServerTime(10);
      await playTo(10.9);
      vi.advanceTimersByTime(1000);

      await playTo(10.95);

      expect(electron.syncPlaybackTime.mock.calls).toEqual([[10.9], [10.95]]);
    });

    it('stays quiet for two seconds after a source loads', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      setMediaState({readyState: 4, paused: false});
      await setState('playing');
      vi.advanceTimersByTime(1999);
      video.currentTime = 10.9;
      await setServerTime(10);

      await playTo(10.9);

      expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('stays quiet for two seconds after the user seeks', async (): Promise<void> => {
      await playNative();
      await setServerTime(10);
      electron.lastSeekAt = Date.now() - 1999;

      await playTo(10.9);

      expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('does not report while the element is paused', async (): Promise<void> => {
      await playNative();
      await setServerTime(10);
      setMediaState({paused: true});

      await playTo(10.9);

      expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('does not report while the element is short of data', async (): Promise<void> => {
      await playNative();
      await setServerTime(10);
      setMediaState({readyState: 2});

      await playTo(10.9);

      expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('does not report while the server is not playing', async (): Promise<void> => {
      await playNative();
      await setServerTime(10);
      await setState('paused');
      setMediaState({paused: false});

      await playTo(10.9);

      expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('reports media time, not stream time, for a transcoded stream', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mkv');
      await seekStreamTo(100);
      fire('canplay');
      setMediaState({paused: false});
      await setState('playing');
      passGuards();
      video.currentTime = 5;
      // One second of drift: under the two that would count as a seek
      await setServerTime(104);

      await playTo(5);

      expect(electron.syncPlaybackTime.mock.calls).toEqual([[105]]);
    });

    it('does not report while a transcoded seek is still reloading', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mkv');
      setMediaState({paused: false});
      await setState('playing');
      await seekStreamTo(100);
      passGuards();

      await playTo(5);

      expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
    });

    describe('while the element is stalled', (): void => {
      it('pins the server clock to the element position straight away', async (): Promise<void> => {
        await playNative();
        video.currentTime = 12;

        fire('waiting');

        expect(electron.syncPlaybackTime.mock.calls).toEqual([[12]]);
      });

      it('keeps pinning it every second', async (): Promise<void> => {
        await playNative();
        video.currentTime = 12;
        fire('waiting');

        vi.advanceTimersByTime(3000);

        expect(electron.syncPlaybackTime.mock.calls).toEqual([[12], [12], [12], [12]]);
      });

      it('does not start a second hold when the element stalls again mid-hold', async (): Promise<void> => {
        await playNative();
        fire('waiting');
        electron.syncPlaybackTime.mockClear();

        fire('waiting');
        vi.advanceTimersByTime(1000);

        expect(electron.syncPlaybackTime).toHaveBeenCalledTimes(1);
      });

      it('lets the server clock run again once the element is playing', async (): Promise<void> => {
        await playNative();
        fire('waiting');
        electron.syncPlaybackTime.mockClear();

        fire('playing');
        vi.advanceTimersByTime(5000);

        expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
      });

      it('does not pin the clock while the server is not playing', async (): Promise<void> => {
        await playNative();
        await setState('paused');

        fire('waiting');
        vi.advanceTimersByTime(3000);

        expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
      });

      it('does not pin the clock to a freshly loaded element', async (): Promise<void> => {
        await playNative();
        await loadTrack('/movies/b.mp4');

        fire('waiting');
        vi.advanceTimersByTime(1000);

        expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
      });

      it('gives a user seek half a second before pinning the clock', async (): Promise<void> => {
        await playNative();
        electron.lastSeekAt = Date.now();

        fire('waiting');

        expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
      });
    });
  });

  // ==========================================================================
  // Errors
  // ==========================================================================

  describe('when the element reports an error', (): void => {
    it('logs the media error code and message', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      Object.defineProperty(video, 'error', {configurable: true, value: {code: 4, message: 'format not supported'}});

      fire('error');

      expect(consoleError).toHaveBeenCalledWith('Video error:', 4, 'format not supported');
    });

    it('clears the busy cursor a remote stream was showing', async (): Promise<void> => {
      mount();
      await loadTrack('https://example.com/watch?v=1');

      fire('error');

      expect(electron.setStreamingBusy).toHaveBeenLastCalledWith(false);
    });
  });

  // ==========================================================================
  // Teardown
  // ==========================================================================

  describe('when destroyed', (): void => {
    it('pauses the element and releases its source', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      pause.mockClear();

      fixture.destroy();

      expect(pause).toHaveBeenCalledTimes(1);
      expect(src()).toBe('');
    });

    it('clears the busy cursor', async (): Promise<void> => {
      mount();
      await loadTrack('https://example.com/watch?v=1');

      fixture.destroy();

      expect(electron.setStreamingBusy).toHaveBeenLastCalledWith(false);
    });

    it('stops reacting to the element becoming playable', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      await setState('playing');
      fixture.destroy();

      fire('canplay');

      expect(play).not.toHaveBeenCalled();
    });

    it('stops reacting to the element stalling', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      await setState('playing');
      passGuards();
      fixture.destroy();

      fire('waiting');
      vi.advanceTimersByTime(3000);

      expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('stops reporting playback progress to the server', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      setMediaState({readyState: 4, paused: false});
      await setState('playing');
      passGuards();
      fixture.destroy();
      video.currentTime = 50;

      fire('timeupdate');

      expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('releases a stall hold that was in progress', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      await setState('playing');
      passGuards();
      fire('waiting');
      electron.syncPlaybackTime.mockClear();

      fixture.destroy();
      vi.advanceTimersByTime(5000);

      expect(electron.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('cancels the seek-loading safety timeout', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mkv');
      await seekStreamTo(100);
      fixture.destroy();
      electron.setStreamingBusy.mockClear();

      vi.advanceTimersByTime(15000);

      expect(electron.setStreamingBusy).not.toHaveBeenCalled();
    });

    it('stops the seek spinner', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mkv');
      await seekStreamTo(100);

      fixture.destroy();

      expect(contextOf(spinnerCanvas).callsTo('clearRect').at(-1)).toEqual([0, 0, 256, 256]);
    });

    it('abandons a fade-out that was in progress', async (): Promise<void> => {
      mount();
      electron.fadeOutRequested.set(1000);
      await settle();
      vi.advanceTimersByTime(300);
      const atDestroy: number = video.volume;

      fixture.destroy();
      vi.advanceTimersByTime(1000);

      expect(video.volume).toBe(atDestroy);
    });

    it('closes the equalizer\'s audio context', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      await setState('playing');

      fixture.destroy();

      expect(audioContext().close).toHaveBeenCalledTimes(1);
    });

    it('removes the subtitle stylesheet from the document', (): void => {
      mount();

      fixture.destroy();

      expect(subtitleStyle()).toBeNull();
    });

    it('aborts a subtitle load still in flight', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      await announceMedia('/movies/a.mp4', {subtitleTracks: [subtitleTrack(0, {default: true})]});

      fixture.destroy();

      expect(electron.requests[0].signal?.aborted).toBe(true);
    });

    it('drops a resume position still waiting for the source to become playable', async (): Promise<void> => {
      mount();
      await loadTrack('/movies/a.mp4');
      video.currentTime = 30;
      component.selectAudioTrack(1);
      video.currentTime = 0;
      fixture.destroy();

      fire('canplay');

      expect(video.currentTime).toBe(0);
    });
  });
});

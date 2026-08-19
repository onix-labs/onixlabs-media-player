/**
 * @fileoverview Tests for VideoOutlet's aspect and flip mode controls.
 *
 * The outlet is a large, DOM-heavy component; this covers the parts that are
 * plain state transitions rather than rendering — the aspect-mode cycling
 * arithmetic in particular, whose wrap-around is the classic place for an
 * off-by-one to hide.
 *
 * The component is instantiated as a class rather than through a fixture: its
 * template owns a real <video> element and its lifecycle hooks attach media
 * event listeners, none of which these transitions touch.
 *
 * @module app/components/video/video-outlet.spec
 */

import {TestBed} from '@angular/core/testing';
import {DOCUMENT, ElementRef, Renderer2, signal, type WritableSignal} from '@angular/core';
import {VideoOutlet} from './video-outlet';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import {SettingsService, VIDEO_ASPECT_OPTIONS, type VideoAspectMode} from '../../../services/settings.service';

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

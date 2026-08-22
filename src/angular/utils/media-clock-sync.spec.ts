/**
 * @fileoverview Tests for MediaClockSync.
 *
 * The suppression rules matter more than the happy path: reporting a stale
 * element position at the wrong moment cancels the user's seek, so most of
 * this file is about the conditions under which nothing should be sent.
 *
 * @module app/utils/media-clock-sync.spec
 */

import {MediaClockSync, type MediaClockSource} from './media-clock-sync';
import type {MediaPlayerService} from '../services/media-player.service';
import type {ElectronService} from '../services/electron.service';

// ============================================================================
// Helpers
// ============================================================================

/** A far-enough-past stamp that no settle window is active. */
const LONG_AGO: number = 0;

/** Mutable state backing the fake source and services. */
interface Harness {
  sync: MediaClockSync;
  syncPlaybackTime: ReturnType<typeof vi.fn>;
  element: {currentTime: number; paused: boolean; seeking: boolean; readyState: number};
  isPlaying: boolean;
  serverTime: number;
  lastSeekAt: number;
  mediaLoadedAt: number;
  lastLocalSeekAt: number;
  seekPending: boolean;
  offset: number;
}

/**
 * Builds a MediaClockSync over fully controllable state.
 *
 * Defaults describe a healthy element mid-playback with nothing suppressing
 * a sync, so each test only has to change the one thing it is about.
 *
 * @returns The sync plus the state it reads
 */
function createHarness(): Harness {
  const h: Partial<Harness> = {
    element: {currentTime: 100, paused: false, seeking: false, readyState: 4},
    isPlaying: true,
    serverTime: 0,
    lastSeekAt: LONG_AGO,
    mediaLoadedAt: LONG_AGO,
    lastLocalSeekAt: LONG_AGO,
    seekPending: false,
    offset: 0,
    syncPlaybackTime: vi.fn(),
  };

  const mediaPlayer = {
    isPlaying: (): boolean => h.isPlaying as boolean,
    currentTime: (): number => h.serverTime as number,
  } as unknown as MediaPlayerService;

  const electron = {
    get lastSeekAt(): number { return h.lastSeekAt as number; },
    syncPlaybackTime: h.syncPlaybackTime as unknown as (t: number) => void,
  } as unknown as ElectronService;

  const source: MediaClockSource = {
    element: (): HTMLMediaElement => h.element as unknown as HTMLMediaElement,
    mediaLoadedAt: (): number => h.mediaLoadedAt as number,
    lastLocalSeekAt: (): number => h.lastLocalSeekAt as number,
    seekPending: (): boolean => h.seekPending as boolean,
    offset: (): number => h.offset as number,
  };

  h.sync = new MediaClockSync(mediaPlayer, electron, source);
  return h as Harness;
}

// ============================================================================
// Tests
// ============================================================================

describe('MediaClockSync', (): void => {
  let h: Harness;

  beforeEach((): void => {
    vi.useFakeTimers();
    // Advance well past every settle window so timestamps of 0 are "long ago".
    vi.setSystemTime(1_000_000);
    h = createHarness();
  });

  afterEach((): void => {
    h.sync.stopStallHold();
    vi.useRealTimers();
  });

  // ==========================================================================
  // maybeSync — reporting
  // ==========================================================================

  describe('maybeSync', (): void => {
    it('reports a position that has drifted past the threshold', (): void => {
      h.serverTime = 50;

      h.sync.maybeSync();

      expect(h.syncPlaybackTime).toHaveBeenCalledWith(100);
    });

    it('reports drift in either direction', (): void => {
      h.serverTime = 150;

      h.sync.maybeSync();

      expect(h.syncPlaybackTime).toHaveBeenCalledWith(100);
    });

    it('adds the stream offset to the element position', (): void => {
      h.offset = 300;
      h.serverTime = 0;

      h.sync.maybeSync();

      expect(h.syncPlaybackTime).toHaveBeenCalledWith(400);
    });

    it('stays quiet when the clocks agree', (): void => {
      h.serverTime = 100;

      h.sync.maybeSync();

      expect(h.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('stays quiet for drift at exactly the threshold', (): void => {
      h.serverTime = 100 - 0.75;

      h.sync.maybeSync();

      expect(h.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('reports drift just past the threshold', (): void => {
      h.serverTime = 100 - 0.76;

      h.sync.maybeSync();

      expect(h.syncPlaybackTime).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // maybeSync — suppression
  // ==========================================================================

  describe('maybeSync suppression', (): void => {
    beforeEach((): void => {
      h.serverTime = 50; // always enough drift to report
    });

    it('stays quiet when playback is stopped', (): void => {
      h.isPlaying = false;

      h.sync.maybeSync();

      expect(h.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('stays quiet while the element is paused', (): void => {
      h.element.paused = true;

      h.sync.maybeSync();

      expect(h.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('stays quiet while the element is seeking', (): void => {
      h.element.seeking = true;

      h.sync.maybeSync();

      expect(h.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('stays quiet while a seek of our own is in flight', (): void => {
      h.seekPending = true;

      h.sync.maybeSync();

      expect(h.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('stays quiet when the element has not buffered enough to trust', (): void => {
      h.element.readyState = 2;

      h.sync.maybeSync();

      expect(h.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('stays quiet within the settle window after a load', (): void => {
      h.mediaLoadedAt = Date.now() - 1999;

      h.sync.maybeSync();

      expect(h.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('resumes once the load settle window has passed', (): void => {
      h.mediaLoadedAt = Date.now() - 2001;

      h.sync.maybeSync();

      expect(h.syncPlaybackTime).toHaveBeenCalled();
    });

    it('stays quiet within the settle window after a local seek', (): void => {
      h.lastLocalSeekAt = Date.now() - 1999;

      h.sync.maybeSync();

      expect(h.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('stays quiet within the settle window after a user seek', (): void => {
      h.lastSeekAt = Date.now() - 1999;

      h.sync.maybeSync();

      expect(h.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('throttles repeated syncs', (): void => {
      h.sync.maybeSync();
      h.sync.maybeSync();
      h.sync.maybeSync();

      expect(h.syncPlaybackTime).toHaveBeenCalledTimes(1);
    });

    it('allows another sync once the throttle expires', (): void => {
      h.sync.maybeSync();

      vi.advanceTimersByTime(1001);
      h.sync.maybeSync();

      expect(h.syncPlaybackTime).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Stall hold
  // ==========================================================================

  describe('stall hold', (): void => {
    it('reports immediately when started', (): void => {
      h.sync.startStallHold();

      expect(h.syncPlaybackTime).toHaveBeenCalledWith(100);
    });

    it('keeps reporting on an interval', (): void => {
      h.sync.startStallHold();
      h.syncPlaybackTime.mockClear();

      vi.advanceTimersByTime(3000);

      expect(h.syncPlaybackTime).toHaveBeenCalledTimes(3);
    });

    it('reports regardless of drift, unlike maybeSync', (): void => {
      h.serverTime = 100; // no drift at all

      h.sync.startStallHold();

      expect(h.syncPlaybackTime).toHaveBeenCalledWith(100);
    });

    it('includes the stream offset', (): void => {
      h.offset = 60;

      h.sync.startStallHold();

      expect(h.syncPlaybackTime).toHaveBeenCalledWith(160);
    });

    it('does nothing while playback is stopped', (): void => {
      h.isPlaying = false;

      h.sync.startStallHold();

      expect(h.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('skips ticks in the grace window after a user seek', (): void => {
      h.lastSeekAt = Date.now() - 499;

      h.sync.startStallHold();

      expect(h.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('resumes once the seek grace window has passed', (): void => {
      h.lastSeekAt = Date.now() - 501;

      h.sync.startStallHold();

      expect(h.syncPlaybackTime).toHaveBeenCalled();
    });

    it('skips ticks while the element is still settling after a load', (): void => {
      h.mediaLoadedAt = Date.now() - 1999;

      h.sync.startStallHold();

      expect(h.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('ignores a second start while already holding', (): void => {
      h.sync.startStallHold();
      h.sync.startStallHold();
      h.syncPlaybackTime.mockClear();

      vi.advanceTimersByTime(1000);

      expect(h.syncPlaybackTime).toHaveBeenCalledTimes(1);
    });

    it('stops reporting once stopped', (): void => {
      h.sync.startStallHold();
      h.syncPlaybackTime.mockClear();

      h.sync.stopStallHold();
      vi.advanceTimersByTime(5000);

      expect(h.syncPlaybackTime).not.toHaveBeenCalled();
    });

    it('can be restarted after stopping', (): void => {
      h.sync.startStallHold();
      h.sync.stopStallHold();
      h.syncPlaybackTime.mockClear();

      h.sync.startStallHold();

      expect(h.syncPlaybackTime).toHaveBeenCalledTimes(1);
    });

    it('is safe to stop without having started', (): void => {
      expect((): void => h.sync.stopStallHold()).not.toThrow();
    });
  });
});

/**
 * @fileoverview Keeps the server's playback clock anchored to a media element.
 *
 * The server owns the authoritative playback position, but the element is what
 * actually produces sound and picture. They drift — audio elements wander,
 * transcoded streams start late, buffering stalls the element while the
 * server's clock keeps running — so the element's position is periodically
 * reported back.
 *
 * Every sync is suppressed while the element is settling after a load or a
 * seek: a stale position reported at the wrong moment cancels the user's seek,
 * which is far worse than a little drift.
 *
 * The audio and video outlets ran byte-identical copies of this logic,
 * differing only in where the media-time offset came from. That shared shape
 * lives here, with the per-outlet parts supplied through {@link MediaClockSource}.
 *
 * @module app/utils/media-clock-sync
 */

import type {MediaPlayerService} from '../services/media-player.service';
import type {ElectronService} from '../services/electron.service';

/** Minimum drift (seconds) between element and server clock before syncing. */
const SYNC_DRIFT_THRESHOLD: number = 0.75;

/** Minimum interval (ms) between clock syncs. */
const SYNC_THROTTLE_MS: number = 1000;

/** Settle time (ms) after a load or seek before clock syncs resume. */
const SYNC_SETTLE_MS: number = 2000;

/** Grace period (ms) after a user seek during which stall holds are skipped. */
const STALL_SEEK_GRACE_MS: number = 500;

/** `HTMLMediaElement.readyState` at which the position is trustworthy. */
const HAVE_FUTURE_DATA: number = 3;

/**
 * The per-outlet state the sync logic needs.
 *
 * Supplied as getters rather than values because all of it changes underneath
 * the sync between ticks.
 */
export interface MediaClockSource {
  /** The media element whose position is being reported. */
  element(): HTMLMediaElement;

  /** When the current source was (re)loaded, as a Date.now() stamp. */
  mediaLoadedAt(): number;

  /** When this outlet last initiated a seek of its own, as a Date.now() stamp. */
  lastLocalSeekAt(): number;

  /** Whether a seek initiated by this outlet is still in flight. */
  seekPending(): boolean;

  /**
   * Seconds to add to the element's own currentTime to get true media time.
   *
   * Non-zero when the element holds a window into a longer piece of media —
   * a transcode started at an offset, or a remote stream requested from one.
   */
  offset(): number;
}

/**
 * Reports a media element's position to the server, on a throttle.
 */
export class MediaClockSync {
  /** Timestamp of the last sync sent to the server (for throttling). */
  private lastSyncSentAt: number = 0;

  /** Interval holding the server clock at the element position while stalled. */
  private stallInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Creates a clock sync for one outlet.
   *
   * @param mediaPlayer - Source of the authoritative playback state
   * @param electron - Transport for reporting positions back to the server
   * @param source - The outlet's own per-element state
   */
  public constructor(
    private readonly mediaPlayer: MediaPlayerService,
    private readonly electron: ElectronService,
    private readonly source: MediaClockSource
  ) {}

  /** True media time: the element's position plus any stream offset. */
  private actualTime(): number {
    return this.source.offset() + this.source.element().currentTime;
  }

  /**
   * Reports the element's position if it has drifted far enough from the
   * server's, and the element is in a state worth believing.
   *
   * Safe to call on every timeupdate; the throttle and settle windows decide
   * whether anything is actually sent.
   */
  public maybeSync(): void {
    if (!this.mediaPlayer.isPlaying()) return;

    const element: HTMLMediaElement = this.source.element();
    if (element.paused || element.seeking || this.source.seekPending()) return;
    if (element.readyState < HAVE_FUTURE_DATA) return;

    const now: number = Date.now();
    if (now - this.lastSyncSentAt < SYNC_THROTTLE_MS) return;
    if (now - this.source.mediaLoadedAt() < SYNC_SETTLE_MS) return;
    if (now - this.source.lastLocalSeekAt() < SYNC_SETTLE_MS) return;
    if (now - this.electron.lastSeekAt < SYNC_SETTLE_MS) return;

    const actual: number = this.actualTime();
    const drift: number = actual - this.mediaPlayer.currentTime();

    if (Math.abs(drift) > SYNC_DRIFT_THRESHOLD) {
      this.lastSyncSentAt = now;
      this.electron.syncPlaybackTime(actual);
    }
  }

  /**
   * Starts periodically pinning the server clock to the element's position
   * while the element is stalled buffering.
   *
   * Without this the server's clock runs on through a stall and the seek bar
   * marches ahead of the content. Idempotent: a second call while already
   * holding does nothing.
   */
  public startStallHold(): void {
    if (this.stallInterval !== null) return;

    const holdClock: () => void = (): void => {
      if (!this.mediaPlayer.isPlaying()) return;
      if (Date.now() - this.electron.lastSeekAt < STALL_SEEK_GRACE_MS) return;
      // Never report a freshly (re)loaded element — its position may not
      // reflect the new track yet (the server ignores such syncs too)
      if (Date.now() - this.source.mediaLoadedAt() < SYNC_SETTLE_MS) return;
      this.electron.syncPlaybackTime(this.actualTime());
    };

    holdClock();
    this.stallInterval = setInterval(holdClock, SYNC_THROTTLE_MS);
  }

  /** Stops the stall hold once the element is playing again. Idempotent. */
  public stopStallHold(): void {
    if (this.stallInterval !== null) {
      clearInterval(this.stallInterval);
      this.stallInterval = null;
    }
  }
}

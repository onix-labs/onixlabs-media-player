/**
 * @fileoverview Decides where a (re)loaded track should start playing.
 *
 * Almost every load starts at zero. The exception is resuming after a stop:
 * the user can drag the seek bar while stopped, and the server keeps that
 * position when play is pressed, so replaying the same file must pick it up
 * rather than restart. Telling that apart from a restart or a re-selection —
 * which look identical at the moment of loading — needs two pieces of history
 * that neither the track nor the playback state carries.
 *
 * The audio and video outlets both need exactly this decision and both kept
 * their own copy of the bookkeeping. Note that the surrounding cache-clearing
 * rules are deliberately *not* shared: the video outlet's is narrower on
 * purpose, to avoid double-loading a track selected immediately after being
 * added.
 *
 * @module app/utils/resume-position
 */

/** The playback state the server reports while preparing a track. */
const LOADING: string = 'loading';

/** The playback state that makes a reload a resume rather than a restart. */
const STOPPED: string = 'stopped';

/**
 * Tracks just enough playback history to recognise a resume-after-stop.
 */
export class ResumePositionTracker {
  /** The state observed immediately before the current 'loading' transition. */
  private stateBeforeLoading: string = 'idle';

  /** The last file path that actually reached 'playing'. */
  private lastLoadedPath: string | null = null;

  /**
   * Feeds the tracker the current playback state.
   *
   * Call once per playback-state change, before asking anything else.
   *
   * @param state - The server's playback state
   * @param currentFilePath - The path the outlet currently has loaded, if any
   */
  public observe(state: string, currentFilePath: string | null): void {
    // Reaching 'playing' is what proves a file actually loaded, which is what
    // makes a later reload of it a resume rather than a first play.
    if (state === 'playing' && currentFilePath) {
      this.lastLoadedPath = currentFilePath;
    }

    // Remember what preceded a 'loading' transition, which is what
    // distinguishes resuming after a stop from a restart or re-selection.
    if (state !== LOADING) {
      this.stateBeforeLoading = state;
    }
  }

  /**
   * Whether this file has previously reached 'playing'.
   *
   * @param filePath - The candidate file path
   * @returns True if the file has played before
   */
  public hasPlayed(filePath: string | null | undefined): boolean {
    return filePath !== null && filePath !== undefined && filePath === this.lastLoadedPath;
  }

  /**
   * Whether loading this file is a resume after a stop.
   *
   * @param state - The server's current playback state
   * @param filePath - The file about to be loaded
   * @returns True if playback should pick up the server's position
   */
  public isStopResume(state: string, filePath: string): boolean {
    return state === LOADING && this.stateBeforeLoading === STOPPED && this.hasPlayed(filePath);
  }

  /**
   * Resolves the position a load should start from.
   *
   * @param state - The server's current playback state
   * @param filePath - The file about to be loaded
   * @param serverTime - The server's current position, read only when needed
   * @returns Seconds to start playback from
   */
  public startPosition(state: string, filePath: string, serverTime: () => number): number {
    return this.isStopResume(state, filePath) ? serverTime() : 0;
  }

  /** Forgets the load history, so nothing is treated as a resume. */
  public reset(): void {
    this.stateBeforeLoading = 'idle';
    this.lastLoadedPath = null;
  }
}

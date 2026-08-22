/**
 * @fileoverview Tests for ResumePositionTracker.
 *
 * The rule under test is narrow and easy to get wrong in either direction:
 * restarting a track the user meant to resume loses their position, and
 * resuming one they meant to restart replays from the middle.
 *
 * @module app/utils/resume-position.spec
 */

import {ResumePositionTracker} from './resume-position';

/** Server position used wherever a resume should pick one up. */
const SERVER_TIME: number = 42;

/** A stub for the server clock read. */
const serverTime: () => number = (): number => SERVER_TIME;

describe('ResumePositionTracker', (): void => {
  let tracker: ResumePositionTracker;

  beforeEach((): void => {
    tracker = new ResumePositionTracker();
  });

  /**
   * Plays a file through to 'playing', then stops.
   *
   * @param path - The file to play
   */
  function playThenStop(path: string): void {
    tracker.observe('loading', null);
    tracker.observe('playing', path);
    tracker.observe('stopped', path);
  }

  // ==========================================================================
  // hasPlayed
  // ==========================================================================

  describe('hasPlayed', (): void => {
    it('is false before anything plays', (): void => {
      expect(tracker.hasPlayed('/a.mp3')).toBe(false);
    });

    it('is true once a file reaches playing', (): void => {
      tracker.observe('playing', '/a.mp3');

      expect(tracker.hasPlayed('/a.mp3')).toBe(true);
    });

    it('is false for a file that never played', (): void => {
      tracker.observe('playing', '/a.mp3');

      expect(tracker.hasPlayed('/b.mp3')).toBe(false);
    });

    it('only remembers the most recent file', (): void => {
      tracker.observe('playing', '/a.mp3');
      tracker.observe('playing', '/b.mp3');

      expect(tracker.hasPlayed('/a.mp3')).toBe(false);
      expect(tracker.hasPlayed('/b.mp3')).toBe(true);
    });

    it('ignores a playing state with no loaded path', (): void => {
      tracker.observe('playing', null);

      expect(tracker.hasPlayed(null)).toBe(false);
    });

    it('is false for undefined', (): void => {
      tracker.observe('playing', '/a.mp3');

      expect(tracker.hasPlayed(undefined)).toBe(false);
    });
  });

  // ==========================================================================
  // isStopResume
  // ==========================================================================

  describe('isStopResume', (): void => {
    it('is true when replaying the same file after a stop', (): void => {
      playThenStop('/a.mp3');

      expect(tracker.isStopResume('loading', '/a.mp3')).toBe(true);
    });

    it('is false for a different file after a stop', (): void => {
      playThenStop('/a.mp3');

      expect(tracker.isStopResume('loading', '/b.mp3')).toBe(false);
    });

    it('is false for a restart from playing', (): void => {
      tracker.observe('playing', '/a.mp3');

      // playing → loading is a restart or re-selection, not a resume.
      expect(tracker.isStopResume('loading', '/a.mp3')).toBe(false);
    });

    it('is false for a restart from paused', (): void => {
      tracker.observe('playing', '/a.mp3');
      tracker.observe('paused', '/a.mp3');

      expect(tracker.isStopResume('loading', '/a.mp3')).toBe(false);
    });

    it('is false when the state is not loading', (): void => {
      playThenStop('/a.mp3');

      expect(tracker.isStopResume('playing', '/a.mp3')).toBe(false);
    });

    it('is false for a first play with no history', (): void => {
      expect(tracker.isStopResume('loading', '/a.mp3')).toBe(false);
    });

    it('is false when stopped before the file ever played', (): void => {
      tracker.observe('stopped', null);

      expect(tracker.isStopResume('loading', '/a.mp3')).toBe(false);
    });

    it('survives repeated loading observations', (): void => {
      playThenStop('/a.mp3');
      // 'loading' must not overwrite the remembered previous state.
      tracker.observe('loading', null);
      tracker.observe('loading', null);

      expect(tracker.isStopResume('loading', '/a.mp3')).toBe(true);
    });
  });

  // ==========================================================================
  // startPosition
  // ==========================================================================

  describe('startPosition', (): void => {
    it('returns the server position for a resume after stop', (): void => {
      playThenStop('/a.mp3');

      expect(tracker.startPosition('loading', '/a.mp3', serverTime)).toBe(SERVER_TIME);
    });

    it('returns zero for a restart', (): void => {
      tracker.observe('playing', '/a.mp3');

      expect(tracker.startPosition('loading', '/a.mp3', serverTime)).toBe(0);
    });

    it('returns zero for a different track', (): void => {
      playThenStop('/a.mp3');

      expect(tracker.startPosition('loading', '/b.mp3', serverTime)).toBe(0);
    });

    it('does not read the server clock unless it resumes', (): void => {
      const read = vi.fn().mockReturnValue(SERVER_TIME);
      tracker.observe('playing', '/a.mp3');

      tracker.startPosition('loading', '/a.mp3', read);

      expect(read).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // reset
  // ==========================================================================

  describe('reset', (): void => {
    it('forgets the played file', (): void => {
      playThenStop('/a.mp3');

      tracker.reset();

      expect(tracker.hasPlayed('/a.mp3')).toBe(false);
      expect(tracker.isStopResume('loading', '/a.mp3')).toBe(false);
    });
  });
});

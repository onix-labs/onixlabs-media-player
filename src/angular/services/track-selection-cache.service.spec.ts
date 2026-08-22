/**
 * @fileoverview Tests for TrackSelectionCache.
 *
 * @module app/services/track-selection-cache.service.spec
 */

import {TestBed} from '@angular/core/testing';
import {TrackSelectionCache} from './track-selection-cache.service';

describe('TrackSelectionCache', (): void => {
  let cache: TrackSelectionCache;

  beforeEach((): void => {
    TestBed.configureTestingModule({providers: [TrackSelectionCache]});
    cache = TestBed.inject(TrackSelectionCache);
  });

  describe('subtitle selections', (): void => {
    it('is undefined for a file with no selection', (): void => {
      expect(cache.getSubtitleSelection('/a.mkv')).toBeUndefined();
    });

    it('round-trips a selection', (): void => {
      cache.setSubtitleSelection('/a.mkv', 2);

      expect(cache.getSubtitleSelection('/a.mkv')).toBe(2);
    });

    it('keeps selections separate per file', (): void => {
      cache.setSubtitleSelection('/a.mkv', 1);
      cache.setSubtitleSelection('/b.mkv', 3);

      expect(cache.getSubtitleSelection('/a.mkv')).toBe(1);
      expect(cache.getSubtitleSelection('/b.mkv')).toBe(3);
    });

    it('overwrites a previous selection', (): void => {
      cache.setSubtitleSelection('/a.mkv', 1);

      cache.setSubtitleSelection('/a.mkv', 4);

      expect(cache.getSubtitleSelection('/a.mkv')).toBe(4);
    });

    it('stores the off sentinel distinctly from no selection', (): void => {
      cache.setSubtitleSelection('/a.mkv', -1);

      // -1 means "the user turned subtitles off", which must not read back as
      // "the user has not chosen".
      expect(cache.getSubtitleSelection('/a.mkv')).toBe(-1);
      expect(cache.getSubtitleSelection('/a.mkv')).not.toBeUndefined();
    });

    it('stores the external sentinel', (): void => {
      cache.setSubtitleSelection('/a.mkv', -2);

      expect(cache.getSubtitleSelection('/a.mkv')).toBe(-2);
    });

    it('clears a single file', (): void => {
      cache.setSubtitleSelection('/a.mkv', 1);
      cache.setSubtitleSelection('/b.mkv', 2);

      cache.clearSubtitleSelection('/a.mkv');

      expect(cache.getSubtitleSelection('/a.mkv')).toBeUndefined();
      expect(cache.getSubtitleSelection('/b.mkv')).toBe(2);
    });

    it('tolerates clearing an unknown file', (): void => {
      expect((): void => cache.clearSubtitleSelection('/nope.mkv')).not.toThrow();
    });
  });

  describe('audio selections', (): void => {
    it('is undefined for a file with no selection', (): void => {
      expect(cache.getAudioSelection('/a.mkv')).toBeUndefined();
    });

    it('round-trips a selection', (): void => {
      cache.setAudioSelection('/a.mkv', 1);

      expect(cache.getAudioSelection('/a.mkv')).toBe(1);
    });

    it('stores track zero distinctly from no selection', (): void => {
      cache.setAudioSelection('/a.mkv', 0);

      expect(cache.getAudioSelection('/a.mkv')).toBe(0);
      expect(cache.getAudioSelection('/a.mkv')).not.toBeUndefined();
    });

    it('clears a single file', (): void => {
      cache.setAudioSelection('/a.mkv', 1);

      cache.clearAudioSelection('/a.mkv');

      expect(cache.getAudioSelection('/a.mkv')).toBeUndefined();
    });
  });

  describe('independence', (): void => {
    it('keeps subtitle and audio selections apart for the same file', (): void => {
      cache.setSubtitleSelection('/a.mkv', 5);
      cache.setAudioSelection('/a.mkv', 9);

      expect(cache.getSubtitleSelection('/a.mkv')).toBe(5);
      expect(cache.getAudioSelection('/a.mkv')).toBe(9);
    });

    it('clearing one kind leaves the other', (): void => {
      cache.setSubtitleSelection('/a.mkv', 5);
      cache.setAudioSelection('/a.mkv', 9);

      cache.clearSubtitleSelection('/a.mkv');

      expect(cache.getAudioSelection('/a.mkv')).toBe(9);
    });
  });

  describe('clear', (): void => {
    it('forgets everything', (): void => {
      cache.setSubtitleSelection('/a.mkv', 1);
      cache.setAudioSelection('/b.mkv', 2);

      cache.clear();

      expect(cache.getSubtitleSelection('/a.mkv')).toBeUndefined();
      expect(cache.getAudioSelection('/b.mkv')).toBeUndefined();
    });
  });
});

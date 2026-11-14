/**
 * @fileoverview Unit tests for the media extension constants and the file
 * dialog filter builder.
 *
 * @module app/constants/media.constants.spec
 */

import {
  FFMPEG_AUDIO_EXTENSIONS,
  FFMPEG_VIDEO_EXTENSIONS,
  FFMPEG_EXTENSIONS,
  MIDI_EXTENSIONS,
  TRACKER_EXTENSIONS,
  MEDIA_EXTENSIONS,
  buildFileDialogFilters,
} from './media.constants';

// ============================================================================
// Test Helpers
// ============================================================================

/** Shape of a file dialog filter group, as returned by buildFileDialogFilters. */
type Filter = ReturnType<typeof buildFileDialogFilters>[number];

/**
 * Strips the leading dot from every extension of a set, in order.
 */
function bare(set: ReadonlySet<string>): string[] {
  return [...set].map((ext: string): string => ext.slice(1));
}

/**
 * Lists the names of a set of filter groups, in order.
 */
function names(filters: Filter[]): string[] {
  return filters.map((filter: Filter): string => filter.name);
}

/**
 * Finds a filter group by name.
 */
function group(filters: Filter[], name: string): Filter | undefined {
  return filters.find((filter: Filter): boolean => filter.name === name);
}

// ============================================================================
// Tests
// ============================================================================

describe('media constants', (): void => {
  describe('extension sets', (): void => {
    it('FFMPEG_EXTENSIONS is the audio and video extensions combined', (): void => {
      expect([...FFMPEG_EXTENSIONS]).toEqual([...FFMPEG_AUDIO_EXTENSIONS, ...FFMPEG_VIDEO_EXTENSIONS]);
    });

    it('MEDIA_EXTENSIONS is every playable extension combined', (): void => {
      expect([...MEDIA_EXTENSIONS]).toEqual([...FFMPEG_EXTENSIONS, ...MIDI_EXTENSIONS, ...TRACKER_EXTENSIONS]);
    });

    it('no extension is claimed by more than one set', (): void => {
      const total: number = FFMPEG_AUDIO_EXTENSIONS.size + FFMPEG_VIDEO_EXTENSIONS.size + MIDI_EXTENSIONS.size + TRACKER_EXTENSIONS.size;

      expect(MEDIA_EXTENSIONS.size).toBe(total);
    });

    it('every extension is lower case with a leading dot', (): void => {
      for (const ext of MEDIA_EXTENSIONS) {
        expect(ext).toMatch(/^\.[a-z0-9]+$/);
      }
    });
  });

  describe('buildFileDialogFilters', (): void => {
    it('returns no filters when nothing can be played', (): void => {
      const filters: Filter[] = buildFileDialogFilters(false, false, false);

      expect(filters).toEqual([]);
    });

    it('offers media, audio and video groups when only FFmpeg is available', (): void => {
      const filters: Filter[] = buildFileDialogFilters(true, false, false);

      expect(filters).toEqual([
        {name: 'Media Files', extensions: [...bare(FFMPEG_AUDIO_EXTENSIONS), ...bare(FFMPEG_VIDEO_EXTENSIONS)]},
        {name: 'Audio', extensions: bare(FFMPEG_AUDIO_EXTENSIONS)},
        {name: 'Video', extensions: bare(FFMPEG_VIDEO_EXTENSIONS)},
      ]);
    });

    it('offers only MIDI files, with no video group, when only MIDI is available', (): void => {
      const filters: Filter[] = buildFileDialogFilters(false, true, false);

      expect(filters).toEqual([
        {name: 'Media Files', extensions: bare(MIDI_EXTENSIONS)},
        {name: 'Audio', extensions: bare(MIDI_EXTENSIONS)},
      ]);
    });

    it('offers a tracker group, with no video group, when only trackers are available', (): void => {
      const filters: Filter[] = buildFileDialogFilters(false, false, true);

      expect(filters).toEqual([
        {name: 'Media Files', extensions: bare(TRACKER_EXTENSIONS)},
        {name: 'Audio', extensions: bare(TRACKER_EXTENSIONS)},
        {name: 'Tracker Modules', extensions: bare(TRACKER_EXTENSIONS)},
      ]);
    });

    it('lists the groups in a fixed order when everything is available', (): void => {
      const filters: Filter[] = buildFileDialogFilters(true, true, true);

      expect(names(filters)).toEqual(['Media Files', 'Audio', 'Video', 'Tracker Modules']);
    });

    it('counts MIDI and tracker formats as audio when everything is available', (): void => {
      const filters: Filter[] = buildFileDialogFilters(true, true, true);

      expect(group(filters, 'Audio')?.extensions).toEqual([
        ...bare(FFMPEG_AUDIO_EXTENSIONS),
        ...bare(MIDI_EXTENSIONS),
        ...bare(TRACKER_EXTENSIONS),
      ]);
    });

    it('puts every playable extension in the media group when everything is available', (): void => {
      const filters: Filter[] = buildFileDialogFilters(true, true, true);

      expect(new Set(group(filters, 'Media Files')?.extensions)).toEqual(new Set(bare(MEDIA_EXTENSIONS)));
    });

    it('writes extensions without a leading dot', (): void => {
      const filters: Filter[] = buildFileDialogFilters(true, true, true);

      const dotted: string[] = filters
        .flatMap((filter: Filter): string[] => filter.extensions)
        .filter((ext: string): boolean => ext.startsWith('.'));
      expect(dotted).toEqual([]);
    });
  });
});

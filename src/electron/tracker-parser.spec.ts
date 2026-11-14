/**
 * @fileoverview Tests for the set of recognised tracker module extensions.
 *
 * The media server looks a file's lower-cased extension up in this set to
 * decide whether to render it through libopenmpt, after first checking the
 * MIDI set, so the tests are about what a lookup finds rather than about the
 * list itself.
 *
 * @module electron/tracker-parser.spec
 */

import { vi, describe, it, expect } from 'vitest';
import * as path from 'path';

import { MIDI_FORMATS } from './midi-parser.js';
import { TRACKER_FORMATS } from './tracker-parser.js';

vi.mock('./logger.js', () => ({
  midiLogger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

describe('TRACKER_FORMATS', (): void => {
  it.each(['song.okt', 'song.mod', 'song.xm', 'song.s3m', 'song.it', 'SONG.MOD'])('recognises %s by its lower-cased extension', (fileName: string): void => {
    const extension: string = path.extname(fileName).toLowerCase();

    expect(TRACKER_FORMATS.has(extension)).toBe(true);
  });

  it.each(['.mp3', '.wav', '.flac', '.ogg', '.mp4', '.mkv', '.opp', ''])('does not claim %j, which is not a tracker module', (extension: string): void => {
    expect(TRACKER_FORMATS.has(extension)).toBe(false);
  });

  it('holds every extension in the form a lookup uses: a leading dot, then lower-case letters and digits', (): void => {
    const malformed: string[] = [...TRACKER_FORMATS].filter((extension: string): boolean => !/^\.[a-z0-9]+$/.test(extension));

    expect(malformed).toEqual([]);
  });

  it('shares no extension with MIDI, which is rendered by a different program', (): void => {
    const shared: string[] = [...TRACKER_FORMATS].filter((extension: string): boolean => MIDI_FORMATS.has(extension));

    expect(shared).toEqual([]);
  });
});

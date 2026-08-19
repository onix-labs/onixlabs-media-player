/**
 * @fileoverview Tests for WebVTT parsing, cue selection and sanitization.
 *
 * @module app/utils/webvtt.spec
 */

import {describe, it, expect} from 'vitest';
import {parseTimingLine, parseWebVTT, cueTextAt, sanitizeSubtitleHtml, type ParsedSubtitleCue} from './webvtt';

describe('parseTimingLine', (): void => {
  it('parses a timing line with hours', (): void => {
    const result: {start: number; end: number} | null = parseTimingLine('01:02:03.500 --> 01:02:05.250');

    expect(result).toEqual({start: 3723.5, end: 3725.25});
  });

  it('parses a timing line without hours', (): void => {
    const result: {start: number; end: number} | null = parseTimingLine('00:10.000 --> 00:12.500');

    expect(result).toEqual({start: 10, end: 12.5});
  });

  it('tolerates extra whitespace around the arrow', (): void => {
    const result: {start: number; end: number} | null = parseTimingLine('00:01.000   -->   00:02.000');

    expect(result).toEqual({start: 1, end: 2});
  });

  it('returns null for a line that is not a timing line', (): void => {
    expect(parseTimingLine('WEBVTT')).toBeNull();
  });

  it('returns null when the milliseconds are missing', (): void => {
    expect(parseTimingLine('00:01 --> 00:02')).toBeNull();
  });
});

describe('parseWebVTT', (): void => {
  it('parses a simple file', (): void => {
    const content: string = [
      'WEBVTT',
      '',
      '00:00.000 --> 00:02.000',
      'Hello',
      '',
      '00:03.000 --> 00:04.000',
      'World',
      '',
    ].join('\n');

    const cues: ParsedSubtitleCue[] = parseWebVTT(content);

    expect(cues).toEqual([
      {startTime: 0, endTime: 2, text: 'Hello'},
      {startTime: 3, endTime: 4, text: 'World'},
    ]);
  });

  it('joins multi-line cue text with newlines', (): void => {
    const content: string = 'WEBVTT\n\n00:00.000 --> 00:02.000\nfirst line\nsecond line\n';

    const cues: ParsedSubtitleCue[] = parseWebVTT(content);

    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('first line\nsecond line');
  });

  it('skips the header and any metadata before the first cue', (): void => {
    const content: string = 'WEBVTT - Some Title\nNOTE this is a comment\n\n00:01.000 --> 00:02.000\nText\n';

    const cues: ParsedSubtitleCue[] = parseWebVTT(content);

    expect(cues).toEqual([{startTime: 1, endTime: 2, text: 'Text'}]);
  });

  it('drops a cue whose timing line does not parse', (): void => {
    const content: string = 'WEBVTT\n\n00:01 --> 00:02\nBad timing\n\n00:03.000 --> 00:04.000\nGood\n';

    const cues: ParsedSubtitleCue[] = parseWebVTT(content);

    expect(cues).toEqual([{startTime: 3, endTime: 4, text: 'Good'}]);
  });

  it('ignores a cue with timing but no text', (): void => {
    const content: string = 'WEBVTT\n\n00:01.000 --> 00:02.000\n\n00:03.000 --> 00:04.000\nText\n';

    const cues: ParsedSubtitleCue[] = parseWebVTT(content);

    expect(cues).toEqual([{startTime: 3, endTime: 4, text: 'Text'}]);
  });

  it('returns an empty array for empty content', (): void => {
    expect(parseWebVTT('')).toEqual([]);
  });

  it('returns an empty array when there are no cues', (): void => {
    expect(parseWebVTT('WEBVTT\n\n')).toEqual([]);
  });
});

describe('cueTextAt', (): void => {
  const cues: readonly ParsedSubtitleCue[] = [
    {startTime: 0, endTime: 2, text: 'first'},
    {startTime: 1, endTime: 3, text: 'overlapping'},
    {startTime: 5, endTime: 6, text: 'later'},
  ];

  it('returns the active cue text', (): void => {
    expect(cueTextAt(cues, 5.5)).toBe('later');
  });

  it('joins overlapping cues with a newline', (): void => {
    expect(cueTextAt(cues, 1.5)).toBe('first\noverlapping');
  });

  it('treats cue boundaries as inclusive', (): void => {
    expect(cueTextAt(cues, 0)).toBe('first');
    expect(cueTextAt(cues, 6)).toBe('later');
  });

  it('returns an empty string in a gap between cues', (): void => {
    expect(cueTextAt(cues, 4)).toBe('');
  });

  it('returns an empty string when there are no cues', (): void => {
    expect(cueTextAt([], 1)).toBe('');
  });
});

describe('sanitizeSubtitleHtml', (): void => {
  it('returns an empty string for empty input', (): void => {
    expect(sanitizeSubtitleHtml('')).toBe('');
  });

  it('leaves plain text unchanged', (): void => {
    expect(sanitizeSubtitleHtml('Hello there')).toBe('Hello there');
  });

  it('preserves the allowed formatting tags', (): void => {
    expect(sanitizeSubtitleHtml('<i>italic</i>')).toBe('<i>italic</i>');
    expect(sanitizeSubtitleHtml('<b>bold</b>')).toBe('<b>bold</b>');
    expect(sanitizeSubtitleHtml('<u>under</u>')).toBe('<u>under</u>');
    expect(sanitizeSubtitleHtml('<em>em</em>')).toBe('<em>em</em>');
    expect(sanitizeSubtitleHtml('<strong>strong</strong>')).toBe('<strong>strong</strong>');
  });

  it('preserves allowed tags regardless of case', (): void => {
    expect(sanitizeSubtitleHtml('<I>italic</I>')).toBe('<I>italic</I>');
  });

  it('converts newlines to line breaks', (): void => {
    expect(sanitizeSubtitleHtml('one\ntwo')).toBe('one<br>two');
  });

  it('escapes a script tag rather than emitting it', (): void => {
    const result: string = sanitizeSubtitleHtml('<script>alert(1)</script>');

    expect(result).not.toContain('<script');
    expect(result).toContain('&lt;script&gt;');
  });

  it('escapes an img tag carrying an event handler', (): void => {
    const result: string = sanitizeSubtitleHtml('<img src=x onerror="alert(1)">');

    expect(result).not.toContain('<img');
    expect(result).toContain('&lt;img');
  });

  it('escapes attributes on an otherwise allowed tag', (): void => {
    const result: string = sanitizeSubtitleHtml('<i onclick="alert(1)">text</i>');

    // The opening tag carries an attribute, so it is not restored as markup.
    expect(result).not.toContain('<i onclick');
    expect(result).toContain('&lt;i onclick');
  });

  it('escapes quotes and ampersands', (): void => {
    const result: string = sanitizeSubtitleHtml(`Tom & "Jerry's"`);

    expect(result).toContain('&amp;');
    expect(result).toContain('&quot;');
    expect(result).toContain('&#39;');
  });

  it('does not let escaped input forge a tag', (): void => {
    // A literal "&lt;i&gt;" in the source must stay literal: the & is escaped
    // first, so the restore step cannot see it as a tag.
    const result: string = sanitizeSubtitleHtml('&lt;i&gt;not italic&lt;/i&gt;');

    expect(result).not.toContain('<i>');
    expect(result).toContain('&amp;lt;');
  });
});

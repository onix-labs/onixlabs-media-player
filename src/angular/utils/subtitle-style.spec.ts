/**
 * @fileoverview Tests for the subtitle appearance CSS helpers.
 *
 * These values drive both the live subtitle overlay and the configuration
 * preview of it, so the exact output strings are pinned here — a difference
 * between the two would make the preview misrepresent playback.
 *
 * @module app/utils/subtitle-style.spec
 */

import {hexToRgba, buildTextShadow} from './subtitle-style';

describe('hexToRgba', (): void => {
  it('converts black', (): void => {
    expect(hexToRgba('#000000', 1)).toBe('rgba(0, 0, 0, 1)');
  });

  it('converts white', (): void => {
    expect(hexToRgba('#ffffff', 1)).toBe('rgba(255, 255, 255, 1)');
  });

  it('converts a mixed colour', (): void => {
    expect(hexToRgba('#1a2b3c', 0.5)).toBe('rgba(26, 43, 60, 0.5)');
  });

  it('accepts uppercase hex digits', (): void => {
    expect(hexToRgba('#FF8000', 1)).toBe('rgba(255, 128, 0, 1)');
  });

  it('passes the alpha through unchanged', (): void => {
    expect(hexToRgba('#000000', 0)).toBe('rgba(0, 0, 0, 0)');
    expect(hexToRgba('#000000', 0.25)).toBe('rgba(0, 0, 0, 0.25)');
  });

  it('yields NaN components for a malformed colour', (): void => {
    // Documents current behaviour: the helper assumes #rrggbb and does not
    // validate. Callers pass values that the settings layer has validated.
    expect(hexToRgba('nonsense', 1)).toBe('rgba(NaN, NaN, NaN, 1)');
  });
});

describe('buildTextShadow', (): void => {
  it('emits eight shadows', (): void => {
    const shadow: string = buildTextShadow(2, 3, '#000000');

    expect(shadow.split(', ')).toHaveLength(8);
  });

  it('emits the eight compass directions in order', (): void => {
    expect(buildTextShadow(2, 3, 'black')).toBe(
      [
        '0 -2px 3px black',
        '2px -2px 3px black',
        '2px 0 3px black',
        '2px 2px 3px black',
        '0 2px 3px black',
        '-2px 2px 3px black',
        '-2px 0 3px black',
        '-2px -2px 3px black',
      ].join(', ')
    );
  });

  it('uses the colour verbatim, including rgba values', (): void => {
    const shadow: string = buildTextShadow(1, 0, 'rgba(0, 0, 0, 0.5)');

    expect(shadow).toContain('rgba(0, 0, 0, 0.5)');
  });

  it('handles a zero spread and blur', (): void => {
    const shadow: string = buildTextShadow(0, 0, 'black');

    expect(shadow).toContain('0 -0px 0px black');
    expect(shadow.split(', ')).toHaveLength(8);
  });
});

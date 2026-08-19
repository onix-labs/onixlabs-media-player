/**
 * @fileoverview Pure helpers for building subtitle appearance CSS.
 *
 * The video outlet injects these values into a <style> element for the live
 * subtitle overlay, and the configuration view renders the same values into
 * its preview. Both need to agree exactly or the preview lies about what
 * playback will look like, so the string building lives here rather than
 * being written out in each.
 *
 * @module app/utils/subtitle-style
 */

/**
 * Converts a hex colour to an rgba() string.
 *
 * @param hex - Hex colour string in #rrggbb form
 * @param alpha - Alpha value (0-1)
 * @returns The equivalent rgba() colour string
 */
export function hexToRgba(hex: string, alpha: number): string {
  const r: number = parseInt(hex.slice(1, 3), 16);
  const g: number = parseInt(hex.slice(3, 5), 16);
  const b: number = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Builds the text-shadow value that outlines subtitle text.
 *
 * Eight offset copies of the shadow — N, NE, E, SE, S, SW, W, NW — which
 * together read as an outline rather than a drop shadow, keeping subtitles
 * legible against any frame.
 *
 * @param spread - Offset distance in px for each direction
 * @param blur - Blur radius in px
 * @param color - Shadow colour, any CSS colour value
 * @returns A text-shadow value listing all eight shadows
 */
export function buildTextShadow(spread: number, blur: number, color: string): string {
  const s: number = spread;
  const b: number = blur;
  const c: string = color;

  return [
    `0 -${s}px ${b}px ${c}`,      // N
    `${s}px -${s}px ${b}px ${c}`, // NE
    `${s}px 0 ${b}px ${c}`,       // E
    `${s}px ${s}px ${b}px ${c}`,  // SE
    `0 ${s}px ${b}px ${c}`,       // S
    `-${s}px ${s}px ${b}px ${c}`, // SW
    `-${s}px 0 ${b}px ${c}`,      // W
    `-${s}px -${s}px ${b}px ${c}` // NW
  ].join(', ');
}

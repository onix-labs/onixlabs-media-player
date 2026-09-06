/**
 * @fileoverview Loads and colour-keys the bitmaps a skin is built from.
 *
 * Skin art predates the alpha channel. Transparency is expressed by painting
 * the see-through regions a colour nothing else in the image uses - almost
 * always magenta - and naming that colour in the element's
 * `transparencyColor` attribute. Drawing such a bitmap directly puts a magenta
 * rectangle on screen, so every image is decoded, has its key colour zeroed out
 * in the alpha channel, and is re-encoded as a PNG before it reaches the DOM.
 *
 * The same decode also serves button groups. A BUTTONGROUP pairs a visible
 * image with a `mappingImage` whose flat colour regions define hit areas, and
 * each BUTTONELEMENT claims one region by `mappingColor`. Hit testing means
 * reading the mapping image's pixel under the cursor, so mapping images are
 * cached as raw pixels rather than as blobs.
 *
 * Both caches are keyed per skin and cleared when a skin is unloaded; object
 * URLs are revoked at the same time, since each one pins a decoded PNG in
 * memory for as long as it exists.
 *
 * @module app/skin/skin-image.service
 */

import {Injectable} from '@angular/core';
import type {SkinImageMetrics} from './skin-element';

/** A decoded, colour-keyed skin bitmap ready to be used as an image source. */
export interface SkinImage {
  /** Object URL of the keyed PNG */
  readonly url: string;
  /** Natural width in pixels */
  readonly width: number;
  /** Natural height in pixels */
  readonly height: number;
}

/**
 * How an image's transparent region is identified.
 *
 * - colour: a specific colour is keyed out
 * - auto: the image's top-left pixel names the colour, which is what
 *   `transparencyColor="auto"` means
 * - none: the image is drawn opaque
 */
export type SkinColourKey =
  | {readonly mode: 'colour'; readonly colour: number}
  | {readonly mode: 'auto'}
  | {readonly mode: 'none'};

/**
 * The colour keyed out when a skin names none.
 *
 * Magenta is the WMP skin convention, and skins rely on it going unstated. In
 * the reference skin nine art references - including the stop button and the
 * skin-mode button - carry magenta with no `transparencyColor` anywhere in
 * their ancestry, and render as magenta rectangles if it is not assumed. The
 * assumption is safe in the other direction too: art that does not use magenta
 * is unaffected, because the key only zeroes pixels that match it exactly.
 */
const DEFAULT_TRANSPARENCY_COLOUR: number = 0xff00ff;

/** The extent of one colour region within a button group's mapping image. */
export interface SkinRegionBounds {
  /** Left edge, in mapping-image pixels */
  readonly left: number;
  /** Top edge, in mapping-image pixels */
  readonly top: number;
  /** Region width in pixels */
  readonly width: number;
  /** Region height in pixels */
  readonly height: number;
}

/** Bytes per pixel in the RGBA data returned by a canvas context. */
const BYTES_PER_PIXEL: number = 4;

/** Channel offsets within an RGBA pixel. */
const CHANNEL_RED: number = 0;
const CHANNEL_GREEN: number = 1;
const CHANNEL_BLUE: number = 2;
const CHANNEL_ALPHA: number = 3;

/** Number of hexadecimal digits in a `#RRGGBB` colour. */
const HEX_COLOUR_LENGTH: number = 6;

/** Radix for parsing hexadecimal colour components. */
const HEX_RADIX: number = 16;

/** Bit shifts isolating each channel of a packed 24-bit colour. */
const SHIFT_RED: number = 16;
const SHIFT_GREEN: number = 8;

/** Mask isolating a single 8-bit channel. */
const CHANNEL_MASK: number = 0xff;

/**
 * Colour names skins use in place of hex values.
 *
 * The original runtime accepted the Windows system palette; these are the names
 * that actually turn up in skin markup.
 */
const NAMED_COLOURS: Readonly<Record<string, number>> = {
  black: 0x000000,
  white: 0xffffff,
  red: 0xff0000,
  green: 0x00ff00,
  blue: 0x0000ff,
  yellow: 0xffff00,
  magenta: 0xff00ff,
  cyan: 0x00ffff,
  gray: 0x808080,
  grey: 0x808080,
  silver: 0xc0c0c0,
  maroon: 0x800000,
  olive: 0x808000,
  navy: 0x000080,
  purple: 0x800080,
  teal: 0x008080,
  lime: 0x00ff00,
  fuchsia: 0xff00ff,
  aqua: 0x00ffff,
};

/**
 * Parses a skin colour into a packed 24-bit value.
 *
 * Accepts `#RRGGBB`, bare `RRGGBB`, a named colour, or a decimal number, which
 * is the full range skins use across their colour attributes.
 *
 * @param value - Colour as written in the definition
 * @returns Packed `0xRRGGBB` value, or null when the text names no colour
 */
export function parseSkinColour(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  const trimmed: string = String(value).trim().toLowerCase();
  if (trimmed === '' || trimmed === 'none') return null;

  const named: number | undefined = NAMED_COLOURS[trimmed];
  if (named !== undefined) return named;

  const hex: string = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (hex.length === HEX_COLOUR_LENGTH && /^[0-9a-f]+$/.test(hex)) {
    return parseInt(hex, HEX_RADIX);
  }

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  return null;
}

/**
 * Interprets a skin's `transparencyColor` attribute.
 *
 * @param value - Attribute value as written, or null when unstated
 * @returns How the image's transparency should be determined
 */
export function resolveColourKey(value: string | null | undefined): SkinColourKey {
  const trimmed: string = (value ?? '').trim().toLowerCase();

  if (trimmed === 'auto') return {mode: 'auto'};
  if (trimmed === 'none') return {mode: 'none'};

  const parsed: number | null = parseSkinColour(trimmed);
  return {mode: 'colour', colour: parsed ?? DEFAULT_TRANSPARENCY_COLOUR};
}

/**
 * Renders a colour key as a stable cache token.
 *
 * @param key - The resolved key
 * @returns Token distinguishing one keying of an image from another
 */
function colourKeyToken(key: SkinColourKey): string {
  if (key.mode === 'colour') return key.colour.toString(HEX_RADIX);
  return key.mode;
}

/**
 * Renders a packed colour as a CSS colour string.
 *
 * @param colour - Packed `0xRRGGBB` value
 * @returns CSS hex colour
 */
export function toCssColour(colour: number): string {
  return `#${colour.toString(HEX_RADIX).padStart(HEX_COLOUR_LENGTH, '0')}`;
}

/**
 * Loads, colour-keys and caches the bitmaps belonging to loaded skins.
 *
 * @example
 * const image = await images.load('wmp8-redux', 'appTopLeft.bmp', '#FF00FF');
 * if (image !== null) element.style.backgroundImage = `url(${image.url})`;
 */
@Injectable({providedIn: 'root'})
export class SkinImageService {
  /** Keyed images, indexed by skin id, asset name and transparency colour */
  private readonly images: Map<string, SkinImage> = new Map<string, SkinImage>();

  /** In-flight loads, so concurrent requests for one asset decode it once */
  private readonly pending: Map<string, Promise<SkinImage | null>> = new Map<string, Promise<SkinImage | null>>();

  /** Raw pixels of mapping images, indexed by skin id and asset name */
  private readonly pixels: Map<string, ImageData> = new Map<string, ImageData>();

  /** Assets known to be absent, so a missing image is requested only once */
  private readonly missing: Set<string> = new Set<string>();

  /** Colour-region bounding boxes, indexed by skin id, asset name and colour */
  private readonly regions: Map<string, SkinRegionBounds | null> = new Map<string, SkinRegionBounds | null>();

  /**
   * Builds the cache key for an asset under a given transparency colour.
   *
   * @param skinId - Skin the asset belongs to
   * @param assetName - Asset name as written in the definition
   * @param transparencyColour - Colour to key out, or null for none
   * @returns Cache key
   */
  private cacheKey(skinId: string, assetName: string, key: SkinColourKey): string {
    return `${skinId}|${assetName.toLowerCase()}|${colourKeyToken(key)}`;
  }

  /**
   * Reads an asset's bytes through the Electron bridge.
   *
   * @param skinId - Skin the asset belongs to
   * @param assetName - Asset name as written in the definition
   * @returns The asset's bytes, or null when the skin has no such asset
   */
  private async fetchAsset(skinId: string, assetName: string): Promise<Uint8Array | null> {
    const bridge: typeof window.mediaPlayer | undefined = window.mediaPlayer;
    if (bridge === undefined) return null;
    return bridge.readSkinAsset(skinId, assetName);
  }

  /**
   * Decodes bytes into pixel data on an offscreen canvas.
   *
   * @param bytes - Encoded image bytes, in any format the browser decodes
   * @returns The decoded pixels, or null when decoding failed
   */
  private async decode(bytes: Uint8Array): Promise<ImageData | null> {
    // Copying into a fresh buffer keeps Blob from holding a view onto a
    // possibly-shared IPC buffer.
    const blob: Blob = new Blob([new Uint8Array(bytes)]);

    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      return null;
    }

    const canvas: OffscreenCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context: OffscreenCanvasRenderingContext2D | null = canvas.getContext('2d');
    if (context === null) {
      bitmap.close();
      return null;
    }

    context.drawImage(bitmap, 0, 0);
    bitmap.close();

    return context.getImageData(0, 0, canvas.width, canvas.height);
  }

  /**
   * Copies pixel data, so the drawn image and the sampled image can diverge.
   *
   * @param data - Pixels to copy
   * @returns An independent copy
   */
  private clone(data: ImageData): ImageData {
    return new ImageData(new Uint8ClampedArray(data.data), data.width, data.height);
  }

  /**
   * Reads the colour of an image's top-left pixel.
   *
   * This is what `transparencyColor="auto"` names: the skin declares that
   * whatever is in the corner is the background it wants keyed out.
   *
   * @param data - Decoded pixels
   * @returns Packed `0xRRGGBB` colour, or null for an empty image
   */
  private topLeftColour(data: ImageData): number | null {
    if (data.width === 0 || data.height === 0) return null;
    return (
      (data.data[CHANNEL_RED] << SHIFT_RED) |
      (data.data[CHANNEL_GREEN] << SHIFT_GREEN) |
      data.data[CHANNEL_BLUE]
    );
  }

  /**
   * Zeroes the alpha channel of every pixel matching the key colour.
   *
   * The comparison is exact. Skin art is authored as flat indexed or 24-bit
   * colour with no resampling, so the key colour survives byte-for-byte and a
   * tolerance would only eat legitimate pixels.
   *
   * @param data - Pixels to modify in place
   * @param colour - Packed `0xRRGGBB` colour to make transparent
   */
  private applyColourKey(data: ImageData, colour: number): void {
    const red: number = (colour >> SHIFT_RED) & CHANNEL_MASK;
    const green: number = (colour >> SHIFT_GREEN) & CHANNEL_MASK;
    const blue: number = colour & CHANNEL_MASK;
    const pixels: Uint8ClampedArray = data.data;

    for (let offset: number = 0; offset < pixels.length; offset += BYTES_PER_PIXEL) {
      if (
        pixels[offset + CHANNEL_RED] === red &&
        pixels[offset + CHANNEL_GREEN] === green &&
        pixels[offset + CHANNEL_BLUE] === blue
      ) {
        pixels[offset + CHANNEL_ALPHA] = 0;
      }
    }
  }

  /**
   * Encodes pixel data as a PNG and wraps it in an object URL.
   *
   * @param data - Pixels to encode
   * @returns The resulting image descriptor
   */
  private async toObjectUrl(data: ImageData): Promise<SkinImage> {
    const canvas: OffscreenCanvas = new OffscreenCanvas(data.width, data.height);
    const context: OffscreenCanvasRenderingContext2D = canvas.getContext(
      '2d'
    ) as OffscreenCanvasRenderingContext2D;
    context.putImageData(data, 0, 0);

    const blob: Blob = await canvas.convertToBlob({type: 'image/png'});
    return {url: URL.createObjectURL(blob), width: data.width, height: data.height};
  }

  /**
   * Loads an image, applying its transparency colour.
   *
   * Repeat requests for the same asset and colour return the cached image, and
   * concurrent first requests share one decode.
   *
   * @param skinId - Skin the asset belongs to
   * @param assetName - Asset name as written in the definition
   * @param transparencyColour - Colour to key out, as written in the definition
   * @returns The keyed image, or null when the asset is missing or undecodable
   */
  public async load(
    skinId: string,
    assetName: string,
    transparencyColour: string | null
  ): Promise<SkinImage | null> {
    const colourKey: SkinColourKey = resolveColourKey(transparencyColour);
    const key: string = this.cacheKey(skinId, assetName, colourKey);

    const cached: SkinImage | undefined = this.images.get(key);
    if (cached !== undefined) return cached;
    if (this.missing.has(key)) return null;

    const inFlight: Promise<SkinImage | null> | undefined = this.pending.get(key);
    if (inFlight !== undefined) return inFlight;

    const load: Promise<SkinImage | null> = (async (): Promise<SkinImage | null> => {
      const bytes: Uint8Array | null = await this.fetchAsset(skinId, assetName);
      if (bytes === null) return null;

      const data: ImageData | null = await this.decode(bytes);
      if (data === null) return null;

      // Stored before keying so that mapping images, which are sampled rather
       // than drawn, still report their original colours.
      this.pixels.set(`${skinId}|${assetName.toLowerCase()}`, this.clone(data));

      const colour: number | null =
        colourKey.mode === 'auto'
          ? this.topLeftColour(data)
          : colourKey.mode === 'colour'
            ? colourKey.colour
            : null;

      if (colour !== null) this.applyColourKey(data, colour);
      return this.toObjectUrl(data);
    })();

    this.pending.set(key, load);

    try {
      const image: SkinImage | null = await load;
      if (image === null) {
        this.missing.add(key);
      } else {
        this.images.set(key, image);
      }
      return image;
    } finally {
      this.pending.delete(key);
    }
  }

  /**
   * Returns an already-loaded image without triggering a load.
   *
   * Rendering is synchronous and runs far more often than images change, so it
   * asks for what is cached and schedules a load for whatever is not.
   *
   * @param skinId - Skin the asset belongs to
   * @param assetName - Asset name as written in the definition
   * @param transparencyColour - Colour keyed out, as written in the definition
   * @returns The cached image, or null when it has not been loaded yet
   */
  public cached(
    skinId: string,
    assetName: string,
    transparencyColour: string | null
  ): SkinImage | null {
    const key: string = this.cacheKey(skinId, assetName, resolveColourKey(transparencyColour));
    return this.images.get(key) ?? null;
  }

  /**
   * Returns a cached image's dimensions without triggering a load.
   *
   * Layout arithmetic asks for sizes far more often than images change, and it
   * runs synchronously, so this reports null for anything not yet decoded and
   * relies on the caller re-running once the load completes.
   *
   * @param skinId - Skin the asset belongs to
   * @param assetName - Asset name as written in the definition
   * @returns The natural size, or null when the asset has not been decoded yet
   */
  public metrics(skinId: string, assetName: string): SkinImageMetrics | null {
    const data: ImageData | undefined = this.pixels.get(`${skinId}|${assetName.toLowerCase()}`);
    if (data === undefined) return null;
    return {width: data.width, height: data.height};
  }

  /**
   * Reads the colour of a single pixel in a decoded mapping image.
   *
   * @param skinId - Skin the mapping image belongs to
   * @param assetName - Mapping image name as written in the definition
   * @param x - Pixel column
   * @param y - Pixel row
   * @returns Packed `0xRRGGBB` colour, or null when out of range or not loaded
   */
  public pixelAt(skinId: string, assetName: string, x: number, y: number): number | null {
    const data: ImageData | undefined = this.pixels.get(`${skinId}|${assetName.toLowerCase()}`);
    if (data === undefined) return null;

    const column: number = Math.floor(x);
    const row: number = Math.floor(y);
    if (column < 0 || row < 0 || column >= data.width || row >= data.height) return null;

    const offset: number = (row * data.width + column) * BYTES_PER_PIXEL;
    return (
      (data.data[offset + CHANNEL_RED] << SHIFT_RED) |
      (data.data[offset + CHANNEL_GREEN] << SHIFT_GREEN) |
      data.data[offset + CHANNEL_BLUE]
    );
  }

  /**
   * Finds the bounding box of every pixel of one colour in a mapping image.
   *
   * A BUTTONELEMENT has no geometry of its own - it claims a colour region of
   * its group's mapping image, and that region's extent is where its hover and
   * pressed art belongs. Results are cached because the scan is a full pass
   * over the image and the regions never move.
   *
   * @param skinId - Skin the mapping image belongs to
   * @param assetName - Mapping image name as written in the definition
   * @param colour - Packed `0xRRGGBB` colour claimed by the element
   * @returns The region's box, or null when the colour appears nowhere
   */
  public regionBounds(skinId: string, assetName: string, colour: number): SkinRegionBounds | null {
    const cacheKey: string = `${skinId}|${assetName.toLowerCase()}|${colour}`;
    if (this.regions.has(cacheKey)) return this.regions.get(cacheKey) ?? null;

    const data: ImageData | undefined = this.pixels.get(`${skinId}|${assetName.toLowerCase()}`);
    if (data === undefined) return null;

    const red: number = (colour >> SHIFT_RED) & CHANNEL_MASK;
    const green: number = (colour >> SHIFT_GREEN) & CHANNEL_MASK;
    const blue: number = colour & CHANNEL_MASK;

    let minX: number = data.width;
    let minY: number = data.height;
    let maxX: number = -1;
    let maxY: number = -1;

    for (let y: number = 0; y < data.height; y++) {
      for (let x: number = 0; x < data.width; x++) {
        const offset: number = (y * data.width + x) * BYTES_PER_PIXEL;
        if (
          data.data[offset + CHANNEL_RED] !== red ||
          data.data[offset + CHANNEL_GREEN] !== green ||
          data.data[offset + CHANNEL_BLUE] !== blue
        ) {
          continue;
        }

        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    const bounds: SkinRegionBounds | null =
      maxX < 0 ? null : {left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1};

    this.regions.set(cacheKey, bounds);
    return bounds;
  }

  /**
   * Discards every cached image belonging to a skin and revokes its URLs.
   *
   * @param skinId - Skin whose cache should be dropped
   */
  public evict(skinId: string): void {
    const prefix: string = `${skinId}|`;

    for (const [key, image] of [...this.images]) {
      if (!key.startsWith(prefix)) continue;
      URL.revokeObjectURL(image.url);
      this.images.delete(key);
    }

    for (const key of [...this.pixels.keys()]) {
      if (key.startsWith(prefix)) this.pixels.delete(key);
    }

    for (const key of [...this.missing]) {
      if (key.startsWith(prefix)) this.missing.delete(key);
    }
  }
}

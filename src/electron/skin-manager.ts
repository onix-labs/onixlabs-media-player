/**
 * @fileoverview Installs and reads Windows Media Player skin packages (.wmz).
 *
 * A skin package is a ZIP archive containing exactly one `.wms` definition
 * (an XML document describing the UI tree), zero or more `.js` files holding
 * the skin's behaviour, and a pile of bitmap assets. Installing a skin unpacks
 * it into a directory under `userData/skins`, from which the renderer reads the
 * definition once and individual assets on demand.
 *
 * Two details of the format matter throughout:
 *
 * - **Text is usually UTF-16LE.** The `.wms` and `.js` files authored by the
 *   Windows tooling are little-endian UTF-16 with a BOM, but hand-edited skins
 *   in the wild are sometimes UTF-8 or Windows-1252. Decoding sniffs rather
 *   than assumes.
 * - **Asset references are case-insensitive.** A definition referring to
 *   `appTopLeft.bmp` routinely ships the file as `apptopleft.bmp`, because the
 *   original runtime resolved names the way Windows filesystems do. An
 *   installed skin therefore carries a lower-cased index of its own contents.
 *
 * @module electron/skin-manager
 */

import * as fs from 'fs';
import * as path from 'path';
import {extractWmzArchive} from './wmz-archive';

/** Directory name, under userData, holding all installed skins. */
const SKINS_DIRECTORY_NAME: string = 'skins';

/**
 * Byte-order marks used to identify the encoding of a skin text file.
 *
 * Held as whole big-endian words rather than byte arrays so each is a single
 * named value that can be compared with one read.
 */
const BOM_UTF16_LE: number = 0xfffe;
const BOM_UTF16_BE: number = 0xfeff;
const BOM_UTF8: number = 0xefbbbf;

/** Byte length of a UTF-16 byte-order mark. */
const BOM_UTF16_LENGTH: number = 2;

/** Byte length of a UTF-8 byte-order mark. */
const BOM_UTF8_LENGTH: number = 3;

/** Number of leading bytes sampled when guessing an unmarked encoding. */
const ENCODING_SAMPLE_SIZE: number = 512;

/**
 * Proportion of NUL bytes in the sample above which unmarked text is treated as
 * UTF-16. Real UTF-16LE ASCII is half NUL bytes; UTF-8 text contains none.
 */
const UTF16_NUL_RATIO_THRESHOLD: number = 0.25;

/**
 * An installed skin, as advertised to the renderer.
 *
 * @property id - Directory name under `userData/skins`, stable across sessions
 * @property name - Display title taken from the definition's THEME element
 * @property author - Author credited by the definition, empty when absent
 * @property definitionFile - Name of the `.wms` entry within the skin
 * @property assets - Every file in the skin, as forward-slashed relative paths
 */
export interface InstalledSkin {
  /** Directory name under `userData/skins` */
  readonly id: string;
  /** Display title from the THEME element */
  readonly name: string;
  /** Author credited by the definition */
  readonly author: string;
  /** Name of the `.wms` definition entry */
  readonly definitionFile: string;
  /** Relative paths of every file the skin contains */
  readonly assets: readonly string[];
}

/**
 * A skin's definition and behaviour, decoded to text and ready to parse.
 *
 * @property skin - The installed skin this content belongs to
 * @property definition - Decoded `.wms` XML source
 * @property scripts - Decoded `.js` sources, keyed by lower-cased file name
 */
export interface SkinContent {
  /** Descriptor of the skin these sources came from */
  readonly skin: InstalledSkin;
  /** Decoded `.wms` XML source */
  readonly definition: string;
  /** Decoded script sources, keyed by lower-cased file name */
  readonly scripts: Readonly<Record<string, string>>;
}

/**
 * Tests whether a buffer opens with the given byte-order mark.
 *
 * @param buffer - Buffer to inspect
 * @param bom - The mark as a big-endian word
 * @param length - Byte length of the mark
 * @returns True when the buffer starts with the mark
 */
function hasByteOrderMark(buffer: Buffer, bom: number, length: number): boolean {
  if (buffer.length < length) return false;
  return buffer.readUIntBE(0, length) === bom;
}

/**
 * Decodes a skin text file, sniffing its encoding.
 *
 * A byte-order mark decides the encoding outright. Without one, a high
 * proportion of NUL bytes in the opening sample indicates UTF-16LE - the
 * encoding the Windows skin tooling emitted - and anything else is read as
 * UTF-8, which decodes plain ASCII identically to Windows-1252.
 *
 * @param buffer - Raw file contents
 * @returns Decoded text with any byte-order mark stripped
 */
export function decodeSkinText(buffer: Buffer): string {
  if (hasByteOrderMark(buffer, BOM_UTF16_LE, BOM_UTF16_LENGTH)) {
    return buffer.subarray(BOM_UTF16_LENGTH).toString('utf16le');
  }

  if (hasByteOrderMark(buffer, BOM_UTF16_BE, BOM_UTF16_LENGTH)) {
    // Node has no utf16be decoder; swapping byte pairs turns it into utf16le.
    const swapped: Buffer = Buffer.from(buffer.subarray(BOM_UTF16_LENGTH));
    swapped.swap16();
    return swapped.toString('utf16le');
  }

  if (hasByteOrderMark(buffer, BOM_UTF8, BOM_UTF8_LENGTH)) {
    return buffer.subarray(BOM_UTF8_LENGTH).toString('utf8');
  }

  const sample: Buffer = buffer.subarray(0, ENCODING_SAMPLE_SIZE);
  let nulCount: number = 0;
  for (const byte of sample) {
    if (byte === 0) nulCount++;
  }

  if (sample.length > 0 && nulCount / sample.length > UTF16_NUL_RATIO_THRESHOLD) {
    return buffer.toString('utf16le');
  }

  return buffer.toString('utf8');
}

/**
 * Reads an attribute out of the definition's THEME element.
 *
 * The definition is XML but is only ever probed for metadata here, so a
 * targeted match beats standing up a parser in the main process. Attribute
 * names in `.wms` files are case-insensitive.
 *
 * @param definition - Decoded `.wms` source
 * @param attribute - Attribute name to read
 * @returns Attribute value, or an empty string when absent
 */
function readThemeAttribute(definition: string, attribute: string): string {
  const theme: RegExpMatchArray | null = definition.match(/<\s*THEME\b([^>]*)>/i);
  if (theme === null) return '';

  const value: RegExpMatchArray | null = theme[1].match(
    new RegExp(`\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i')
  );
  return value === null ? '' : value[1].trim();
}

/**
 * Turns arbitrary text into a filesystem-safe directory name.
 *
 * @param value - Text to reduce, typically a skin title or archive file name
 * @returns Lower-case kebab-ish slug, never empty
 */
function toSlug(value: string): string {
  const slug: string = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'skin';
}

/**
 * Lists every file beneath a directory, recursively.
 *
 * @param root - Directory to walk
 * @param prefix - Path prefix accumulated during recursion
 * @returns Forward-slashed paths relative to `root`
 */
function listFilesRecursively(root: string, prefix: string = ''): string[] {
  const results: string[] = [];

  for (const entry of fs.readdirSync(path.join(root, prefix), {withFileTypes: true})) {
    const relative: string = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      results.push(...listFilesRecursively(root, relative));
    } else if (entry.isFile()) {
      results.push(relative);
    }
  }

  return results;
}

/**
 * Manages the on-disk collection of installed Windows Media Player skins.
 *
 * @example
 * const manager = new SkinManager(app.getPath('userData'));
 * const skin = manager.install('/path/to/Theme.wmz');
 * const content = manager.read(skin.id);
 */
export class SkinManager {
  /** Absolute path of the directory holding all installed skins */
  private readonly skinsRoot: string;

  /**
   * Creates a manager rooted at the given application data directory.
   *
   * @param userDataPath - Electron's userData directory
   */
  public constructor(userDataPath: string) {
    this.skinsRoot = path.join(userDataPath, SKINS_DIRECTORY_NAME);
  }

  /**
   * Absolute path of the directory holding installed skins.
   *
   * @returns The skins root directory, which may not exist yet
   */
  public get root(): string {
    return this.skinsRoot;
  }

  /**
   * Builds a descriptor for a skin already unpacked in the given directory.
   *
   * @param id - Directory name of the skin
   * @returns Descriptor, or null when the directory holds no `.wms` definition
   */
  private describe(id: string): InstalledSkin | null {
    const directory: string = path.join(this.skinsRoot, id);
    let assets: string[];

    try {
      assets = listFilesRecursively(directory);
    } catch {
      return null;
    }

    const definitionFile: string | undefined = assets.find((name: string): boolean =>
      name.toLowerCase().endsWith('.wms')
    );
    if (definitionFile === undefined) return null;

    const definition: string = decodeSkinText(fs.readFileSync(path.join(directory, definitionFile)));

    return {
      id,
      name: readThemeAttribute(definition, 'title') || id,
      author: readThemeAttribute(definition, 'author'),
      definitionFile,
      assets,
    };
  }

  /**
   * Lists every installed skin.
   *
   * Directories that do not contain a `.wms` definition are ignored rather than
   * reported as broken skins, so unrelated content under the skins root is
   * harmless.
   *
   * @returns Descriptors of all installed skins, in directory order
   */
  public list(): InstalledSkin[] {
    if (!fs.existsSync(this.skinsRoot)) return [];

    const skins: InstalledSkin[] = [];

    for (const entry of fs.readdirSync(this.skinsRoot, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const skin: InstalledSkin | null = this.describe(entry.name);
      if (skin !== null) skins.push(skin);
    }

    return skins;
  }

  /**
   * Installs a `.wmz` package, replacing any previous install of the same skin.
   *
   * The skin's identity is its title slug where the definition names one, so
   * re-installing an updated package overwrites the earlier copy rather than
   * accumulating duplicates.
   *
   * @param archivePath - Absolute path to the `.wmz` file
   * @returns Descriptor of the installed skin
   * @throws If the archive is unreadable or contains no `.wms` definition
   */
  public install(archivePath: string): InstalledSkin {
    const stagingId: string = `.staging-${Date.now().toString(36)}`;
    const stagingPath: string = path.join(this.skinsRoot, stagingId);

    fs.mkdirSync(this.skinsRoot, {recursive: true});
    fs.rmSync(stagingPath, {recursive: true, force: true});

    try {
      extractWmzArchive(archivePath, stagingPath);

      const staged: InstalledSkin | null = this.describe(stagingId);
      if (staged === null) {
        throw new Error('Archive does not contain a .wms skin definition');
      }

      const id: string = toSlug(staged.name || path.basename(archivePath, path.extname(archivePath)));
      const target: string = path.join(this.skinsRoot, id);

      fs.rmSync(target, {recursive: true, force: true});
      fs.renameSync(stagingPath, target);

      const installed: InstalledSkin | null = this.describe(id);
      if (installed === null) {
        throw new Error('Skin definition became unreadable after install');
      }

      return installed;
    } finally {
      fs.rmSync(stagingPath, {recursive: true, force: true});
    }
  }

  /**
   * Removes an installed skin from disk.
   *
   * @param id - Directory name of the skin to remove
   */
  public remove(id: string): void {
    const directory: string = this.resolveWithin(id, '');
    fs.rmSync(directory, {recursive: true, force: true});
  }

  /**
   * Resolves a path inside a skin directory, refusing to escape it.
   *
   * Skin ids and asset names both reach here from the renderer, so neither is
   * trusted to stay inside the skins root.
   *
   * @param id - Directory name of the skin
   * @param relativePath - Path within the skin, or empty for the directory itself
   * @returns Absolute path inside the skin directory
   * @throws If the resolved path would fall outside the skin directory
   */
  private resolveWithin(id: string, relativePath: string): string {
    const root: string = path.resolve(this.skinsRoot);
    const directory: string = path.resolve(root, id);

    // The id must name a direct child of the skins root: anything containing a
    // separator or `..` resolves elsewhere and is rejected outright.
    if (path.dirname(directory) !== root) {
      throw new Error(`Invalid skin id: ${id}`);
    }

    if (relativePath === '') return directory;

    const target: string = path.resolve(directory, relativePath);
    if (!target.startsWith(directory + path.sep)) {
      throw new Error(`Invalid skin asset path: ${relativePath}`);
    }

    return target;
  }

  /**
   * Reads a skin's definition and all of its scripts, decoded to text.
   *
   * Scripts are keyed by lower-cased file name because the definition's
   * `scriptFile` attribute names them with arbitrary casing.
   *
   * @param id - Directory name of the skin
   * @returns The skin's descriptor together with its decoded sources
   * @throws If the skin is not installed or has no definition
   */
  public read(id: string): SkinContent {
    const skin: InstalledSkin | null = this.describe(id);
    if (skin === null) {
      throw new Error(`Skin is not installed: ${id}`);
    }

    const definition: string = decodeSkinText(
      fs.readFileSync(this.resolveWithin(id, skin.definitionFile))
    );

    const scripts: Record<string, string> = {};
    for (const asset of skin.assets) {
      if (!asset.toLowerCase().endsWith('.js')) continue;
      scripts[asset.toLowerCase()] = decodeSkinText(fs.readFileSync(this.resolveWithin(id, asset)));
    }

    return {skin, definition, scripts};
  }

  /**
   * Reads a single asset from an installed skin.
   *
   * The lookup is case-insensitive: definitions reference `appTopLeft.bmp`
   * while the archive routinely stores `apptopleft.bmp`, and the original
   * runtime resolved the two as the same file.
   *
   * @param id - Directory name of the skin
   * @param assetName - Asset path as written in the definition
   * @returns Raw asset bytes, or null when the skin has no such asset
   */
  public readAsset(id: string, assetName: string): Buffer | null {
    const skin: InstalledSkin | null = this.describe(id);
    if (skin === null) return null;

    const wanted: string = assetName.replace(/\\/g, '/').toLowerCase();
    const match: string | undefined = skin.assets.find((asset: string): boolean => {
      const candidate: string = asset.toLowerCase();
      // Definitions name assets bare even when the archive nests them, so a
      // trailing-segment match is the fallback after an exact one.
      return candidate === wanted || candidate.endsWith(`/${wanted}`);
    });

    if (match === undefined) return null;

    try {
      return fs.readFileSync(this.resolveWithin(id, match));
    } catch {
      return null;
    }
  }
}

/**
 * @fileoverview The licences of everything ONIXPlayer ships, for the About
 * window.
 *
 * The renderer sees each licence only as an id and a description; opening one
 * is asked for by id, and the file is resolved here. A path never crosses the
 * IPC boundary, so the renderer cannot ask for any other file to be opened.
 *
 * @module electron/license-catalog
 */

import {existsSync, readFileSync} from 'fs';
import * as path from 'path';
import type {LicenseLocations} from './bundled-resources.js';

/**
 * One licensed component, as the About window shows it.
 */
export interface LicenseNotice {
  /** Stable identifier, used to ask for the licence to be opened */
  readonly id: string;
  /** Component name */
  readonly name: string;
  /** Component version, or null where one version does not apply */
  readonly version: string | null;
  /** SPDX licence expression, or a short description */
  readonly license: string;
}

/**
 * What the About window shows about this build.
 */
export interface AboutInfo {
  /** ONIXPlayer's version, from package.json */
  readonly version: string;
  /** Licences that can be opened */
  readonly licenses: LicenseNotice[];
  /** The GitHub release for this version, which carries the bundled programs' source */
  readonly sourceUrl: string;
}

/**
 * A licence notice and the file holding its text.
 */
interface LicenseEntry extends LicenseNotice {
  readonly file: string;
}

/**
 * Versions of the components ONIXPlayer itself is built on.
 */
export interface ApplicationVersions {
  readonly application: string;
  readonly electron: string;
  readonly chrome: string;
}

/**
 * File system access, injectable for tests.
 */
export interface LicenseFileSystem {
  readonly exists: (file: string) => boolean;
  readonly readText: (file: string) => string;
}

const NODE_FILE_SYSTEM: LicenseFileSystem = {
  exists: existsSync,
  readText: (file: string): string => readFileSync(file, 'utf8'),
};

/**
 * One entry of the bundled programs' components.json, which
 * scripts/build-binaries.sh writes.
 */
interface BundledComponent {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /** File name of the licence text, in the same directory */
  readonly file: string;
}

function isBundledComponent(value: unknown): value is BundledComponent {
  return typeof value === 'object' && value !== null
    && 'id' in value && typeof value.id === 'string'
    && 'name' in value && typeof value.name === 'string'
    && 'version' in value && typeof value.version === 'string'
    && 'license' in value && typeof value.license === 'string'
    && 'file' in value && typeof value.file === 'string';
}

/**
 * Lists the shipped licences and opens them by id.
 */
export class LicenseCatalog {
  private readonly entries: readonly LicenseEntry[];

  /**
   * @param locations - Where the licence texts are (see getLicenseLocations)
   * @param versions - Versions of ONIXPlayer, Electron and Chromium
   * @param fs - File system access
   */
  public constructor(
    locations: LicenseLocations,
    versions: ApplicationVersions,
    fs: LicenseFileSystem = NODE_FILE_SYSTEM,
  ) {
    const candidates: LicenseEntry[] = [
      {id: 'onixplayer', name: 'ONIXPlayer', version: versions.application, license: 'MIT', file: locations.application},
      ...LicenseCatalog.readBundled(locations.bundled, fs),
      {id: 'electron', name: 'Electron', version: versions.electron, license: 'MIT', file: LicenseCatalog.findElectronLicense(locations.electron, fs)},
      {id: 'chromium', name: 'Chromium', version: versions.chrome, license: 'BSD-3-Clause and others', file: path.join(locations.electron, 'LICENSES.chromium.html')},
      {id: 'javascript', name: 'JavaScript libraries', version: null, license: 'MIT and others', file: locations.javascript},
    ];
    // Development runs lack some of these (the JavaScript licences come only
    // from a production build); a licence that cannot be opened is not listed.
    this.entries = candidates.filter((entry: LicenseEntry): boolean => fs.exists(entry.file));
  }

  /**
   * Gets the licences that can be shown.
   */
  public getNotices(): LicenseNotice[] {
    return this.entries.map(({id, name, version, license}: LicenseEntry): LicenseNotice => ({id, name, version, license}));
  }

  /**
   * Gets the file holding a licence's text.
   *
   * @param id - A licence id from getNotices(); anything else is rejected
   * @returns Absolute path, or null for an unknown id
   */
  public getFile(id: unknown): string | null {
    if (typeof id !== 'string') return null;
    return this.entries.find((entry: LicenseEntry): boolean => entry.id === id)?.file ?? null;
  }

  /**
   * Finds Electron's licence: electron-builder renames it LICENSE.electron.txt
   * when packaging, and the development copy keeps its original name.
   */
  private static findElectronLicense(dir: string, fs: LicenseFileSystem): string {
    const packaged: string = path.join(dir, 'LICENSE.electron.txt');
    return fs.exists(packaged) ? packaged : path.join(dir, 'LICENSE');
  }

  /**
   * Reads the bundled programs' components.json.
   *
   * A missing or malformed manifest lists nothing rather than failing: the
   * About window should still open.
   */
  private static readBundled(dir: string | null, fs: LicenseFileSystem): LicenseEntry[] {
    if (!dir) return [];
    const manifest: string = path.join(dir, 'components.json');
    if (!fs.exists(manifest)) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readText(manifest));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(isBundledComponent).map((component: BundledComponent): LicenseEntry => ({
      id: component.id,
      name: component.name,
      version: component.version,
      license: component.license,
      // The manifest names a file in its own directory, never a path.
      file: path.join(dir, path.basename(component.file)),
    }));
  }
}

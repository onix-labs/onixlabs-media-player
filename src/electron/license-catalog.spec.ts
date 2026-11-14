/**
 * @fileoverview Tests for the catalog of licences shown in the About window.
 *
 * @module electron/license-catalog.spec
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LicenseCatalog } from './license-catalog.js';
import type { LicenseFileSystem, LicenseNotice } from './license-catalog.js';
import type { LicenseLocations } from './bundled-resources.js';

const LOCATIONS: LicenseLocations = {
  application: '/app/licenses/ONIXPlayer-LICENSE.txt',
  javascript: '/app/licenses/JavaScript-libraries.txt',
  bundled: '/app/bin/licenses',
  electron: '/app',
};

const VERSIONS: {application: string; electron: string; chrome: string} = {
  application: '2026.11.0',
  electron: '45.0.0',
  chrome: '150.0.0.0',
};

const MANIFEST: string = JSON.stringify([
  {id: 'ffmpeg', name: 'FFmpeg', version: '9.0.2', license: 'GPL-2.0-or-later', file: 'FFmpeg-COPYING.GPLv2.txt'},
  {id: 'fluidsynth', name: 'FluidSynth', version: '2.6.2', license: 'LGPL-2.1-or-later', file: 'FluidSynth-LICENSE.txt'},
]);

/**
 * A file system holding the given files, with their contents.
 *
 * Paths are normalised on both sides, because the catalog builds them with
 * path.join, which uses backslashes on Windows.
 */
function fileSystem(files: Readonly<Record<string, string>>): LicenseFileSystem {
  const byPath: Map<string, string> = new Map<string, string>(
    Object.entries(files).map(([file, text]: [string, string]): [string, string] => [path.normalize(file), text]),
  );
  return {
    exists: (file: string): boolean => byPath.has(path.normalize(file)),
    readText: (file: string): string => {
      const text: string | undefined = byPath.get(path.normalize(file));
      if (text === undefined) throw new Error(`ENOENT: ${file}`);
      return text;
    },
  };
}

/** Every licence file of a packaged app. */
const PACKAGED: Record<string, string> = {
  '/app/licenses/ONIXPlayer-LICENSE.txt': 'MIT',
  '/app/licenses/JavaScript-libraries.txt': 'MIT',
  '/app/bin/licenses/components.json': MANIFEST,
  '/app/bin/licenses/FFmpeg-COPYING.GPLv2.txt': 'GPL',
  '/app/bin/licenses/FluidSynth-LICENSE.txt': 'LGPL',
  [path.join('/app', 'LICENSE.electron.txt')]: 'MIT',
  [path.join('/app', 'LICENSES.chromium.html')]: '<html>',
};

describe('LicenseCatalog', () => {
  it('lists ONIXPlayer, the bundled programs, Electron, Chromium and the JavaScript libraries', () => {
    const catalog: LicenseCatalog = new LicenseCatalog(LOCATIONS, VERSIONS, fileSystem(PACKAGED));

    expect(catalog.getNotices()).toEqual([
      {id: 'onixplayer', name: 'ONIXPlayer', version: '2026.11.0', license: 'MIT'},
      {id: 'ffmpeg', name: 'FFmpeg', version: '9.0.2', license: 'GPL-2.0-or-later'},
      {id: 'fluidsynth', name: 'FluidSynth', version: '2.6.2', license: 'LGPL-2.1-or-later'},
      {id: 'electron', name: 'Electron', version: '45.0.0', license: 'MIT'},
      {id: 'chromium', name: 'Chromium', version: '150.0.0.0', license: 'BSD-3-Clause and others'},
      {id: 'javascript', name: 'JavaScript libraries', version: null, license: 'MIT and others'},
    ]);
  });

  it('resolves a licence id to its file', () => {
    const catalog: LicenseCatalog = new LicenseCatalog(LOCATIONS, VERSIONS, fileSystem(PACKAGED));

    expect(catalog.getFile('ffmpeg')).toBe(path.join('/app/bin/licenses', 'FFmpeg-COPYING.GPLv2.txt'));
    expect(catalog.getFile('onixplayer')).toBe('/app/licenses/ONIXPlayer-LICENSE.txt');
  });

  it('finds Electron\'s licence under its development name too', () => {
    const files: Record<string, string> = {...PACKAGED};
    delete files[path.join('/app', 'LICENSE.electron.txt')];
    files[path.join('/app', 'LICENSE')] = 'MIT';
    const catalog: LicenseCatalog = new LicenseCatalog(LOCATIONS, VERSIONS, fileSystem(files));

    expect(catalog.getFile('electron')).toBe(path.join('/app', 'LICENSE'));
  });

  it('rejects unknown ids and anything that is not a string', () => {
    const catalog: LicenseCatalog = new LicenseCatalog(LOCATIONS, VERSIONS, fileSystem(PACKAGED));

    expect(catalog.getFile('/etc/passwd')).toBeNull();
    expect(catalog.getFile(undefined)).toBeNull();
    expect(catalog.getFile({id: 'ffmpeg'})).toBeNull();
  });

  it('keeps a manifest entry inside the licences directory', () => {
    const manifest: string = JSON.stringify([
      {id: 'ffmpeg', name: 'FFmpeg', version: '9.0.2', license: 'GPL-2.0-or-later', file: '../../../etc/passwd'},
    ]);
    const files: Record<string, string> = {
      '/app/bin/licenses/components.json': manifest,
      [path.join('/app/bin/licenses', 'passwd')]: 'not a licence',
    };
    const catalog: LicenseCatalog = new LicenseCatalog(LOCATIONS, VERSIONS, fileSystem(files));

    expect(catalog.getFile('ffmpeg')).toBe(path.join('/app/bin/licenses', 'passwd'));
  });

  it('leaves out licences whose file is missing', () => {
    const files: Record<string, string> = {...PACKAGED};
    delete files['/app/licenses/JavaScript-libraries.txt'];
    delete files['/app/bin/licenses/FluidSynth-LICENSE.txt'];
    const catalog: LicenseCatalog = new LicenseCatalog(LOCATIONS, VERSIONS, fileSystem(files));

    const ids: string[] = catalog.getNotices().map((notice: LicenseNotice): string => notice.id);
    expect(ids).not.toContain('javascript');
    expect(ids).not.toContain('fluidsynth');
    expect(catalog.getFile('javascript')).toBeNull();
  });

  it('lists no bundled programs when the manifest is missing, malformed or not a list', () => {
    for (const manifest of [undefined, '{not json', '{"id": "ffmpeg"}', '[{"id": 1}]']) {
      const files: Record<string, string> = {...PACKAGED};
      if (manifest === undefined) delete files['/app/bin/licenses/components.json'];
      else files['/app/bin/licenses/components.json'] = manifest;
      const catalog: LicenseCatalog = new LicenseCatalog(LOCATIONS, VERSIONS, fileSystem(files));

      const ids: string[] = catalog.getNotices().map((notice: LicenseNotice): string => notice.id);
      expect(ids).toEqual(['onixplayer', 'electron', 'chromium', 'javascript']);
    }
  });

  it('lists no bundled programs on a platform without them', () => {
    const catalog: LicenseCatalog = new LicenseCatalog({...LOCATIONS, bundled: null}, VERSIONS, fileSystem(PACKAGED));

    expect(catalog.getFile('ffmpeg')).toBeNull();
  });

  it('still lists everything else on a platform without bundled programs', () => {
    const catalog: LicenseCatalog = new LicenseCatalog({...LOCATIONS, bundled: null}, VERSIONS, fileSystem(PACKAGED));

    const ids: string[] = catalog.getNotices().map((notice: LicenseNotice): string => notice.id);
    expect(ids).toEqual(['onixplayer', 'electron', 'chromium', 'javascript']);
  });

  it('prefers Electron\'s packaged licence name when both names are present', () => {
    const files: Record<string, string> = {...PACKAGED, [path.join('/app', 'LICENSE')]: 'MIT'};
    const catalog: LicenseCatalog = new LicenseCatalog(LOCATIONS, VERSIONS, fileSystem(files));

    expect(catalog.getFile('electron')).toBe(path.join('/app', 'LICENSE.electron.txt'));
  });

  it('skips a malformed manifest entry but keeps the well-formed ones beside it', () => {
    const manifest: string = JSON.stringify([
      null,
      'ffmpeg',
      {id: 'ffmpeg', name: 'FFmpeg', version: 9, license: 'GPL-2.0-or-later', file: 'FFmpeg-COPYING.GPLv2.txt'},
      {id: 'fluidsynth', name: 'FluidSynth', version: '2.6.2', license: 'LGPL-2.1-or-later'},
      {id: 'fluidsynth', name: 'FluidSynth', version: '2.6.2', license: 'LGPL-2.1-or-later', file: 'FluidSynth-LICENSE.txt'},
    ]);
    const catalog: LicenseCatalog = new LicenseCatalog(LOCATIONS, VERSIONS, fileSystem({...PACKAGED, '/app/bin/licenses/components.json': manifest}));

    const ids: string[] = catalog.getNotices().map((notice: LicenseNotice): string => notice.id);
    expect(ids).toEqual(['onixplayer', 'fluidsynth', 'electron', 'chromium', 'javascript']);
  });

  it('does not expose where a licence file is in the notices it hands out', () => {
    const catalog: LicenseCatalog = new LicenseCatalog(LOCATIONS, VERSIONS, fileSystem(PACKAGED));

    for (const notice of catalog.getNotices()) {
      expect(Object.keys(notice).sort()).toEqual(['id', 'license', 'name', 'version']);
    }
  });

  describe('on the real file system', () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(path.join(os.tmpdir(), 'onixplayer-licenses-'));
    });

    afterEach(() => {
      rmSync(root, {recursive: true, force: true});
    });

    it('reads the manifest and finds the licence files when no file system is supplied', () => {
      const bundled: string = path.join(root, 'bin', 'licenses');
      mkdirSync(bundled, {recursive: true});
      writeFileSync(path.join(bundled, 'components.json'), MANIFEST);
      writeFileSync(path.join(bundled, 'FFmpeg-COPYING.GPLv2.txt'), 'GPL');
      writeFileSync(path.join(root, 'LICENSE'), 'MIT');
      const locations: LicenseLocations = {
        application: path.join(root, 'LICENSE'),
        javascript: path.join(root, 'missing', '3rdpartylicenses.txt'),
        bundled,
        electron: root,
      };

      const catalog: LicenseCatalog = new LicenseCatalog(locations, VERSIONS);

      // FluidSynth's licence, Chromium's and the JavaScript libraries' are not on disk.
      expect(catalog.getNotices().map((notice: LicenseNotice): string => notice.id)).toEqual(['onixplayer', 'ffmpeg', 'electron']);
      expect(catalog.getFile('ffmpeg')).toBe(path.join(bundled, 'FFmpeg-COPYING.GPLv2.txt'));
    });
  });
});

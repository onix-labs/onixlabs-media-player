/**
 * @fileoverview Tests for locating the bundled binaries and licences, packaged
 * and in development, and for pointing the bundled binaries at the system's CA
 * certificates.
 *
 * @module electron/bundled-resources.spec
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';
import * as path from 'path';

/** What the tests control about the mocked environment. */
interface FakeEnvironment {
  /** Whether Electron reports the app as packaged */
  isPackaged: boolean;
  /** The file the module believes it is running from, or null for its real location */
  moduleFile: string | null;
}

const environment: FakeEnvironment = vi.hoisted((): FakeEnvironment => ({ isPackaged: false, moduleFile: null }));

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return environment.isPackaged;
    },
  },
}));

// The module finds the repository from its own file name, which differs between
// running from source and running from the compiled bundle.
vi.mock('url', async (importOriginal: () => Promise<typeof import('url')>) => {
  const actual: typeof import('url') = await importOriginal();
  return {
    ...actual,
    fileURLToPath: (url: string | URL): string => environment.moduleFile ?? actual.fileURLToPath(url),
  };
});

import { LINUX_CA_BUNDLES, getBundledBinDir, getLicenseLocations, useSystemCertificates } from './bundled-resources.js';
import type { LicenseLocations } from './bundled-resources.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A stand-in repository; resolved so that it is absolute on Windows too. */
const REPOSITORY: string = path.resolve('/work/onixplayer');
/** The module's location when run from source. */
const SOURCE_FILE: string = path.join(REPOSITORY, 'src', 'electron', 'bundled-resources.ts');
/** The module's location once bundled into the compiled main process. */
const COMPILED_FILE: string = path.join(REPOSITORY, 'src', 'electron', 'dist', 'main.js');
/** A stand-in for a packaged app's resources directory. */
const RESOURCES: string = path.resolve('/opt/ONIXPlayer/resources');
/** A stand-in for a packaged app's executable. */
const EXECUTABLE: string = path.resolve('/opt/ONIXPlayer/onixplayer');

/** The process properties the tests replace, and their original descriptors. */
const STUBBED_PROPERTIES: readonly string[] = ['platform', 'arch', 'resourcesPath', 'execPath'];
const ORIGINAL_DESCRIPTORS: ReadonlyMap<string, PropertyDescriptor | undefined> = new Map<string, PropertyDescriptor | undefined>(
  STUBBED_PROPERTIES.map((name: string): [string, PropertyDescriptor | undefined] => [name, Object.getOwnPropertyDescriptor(process, name)]),
);

/** Replaces a property of process until restoreProcess(). */
function stubProcess(name: 'platform' | 'arch' | 'resourcesPath' | 'execPath', value: string): void {
  Object.defineProperty(process, name, { value, configurable: true, enumerable: true, writable: false });
}

/** Puts back every process property a test replaced (removing those Node does not have). */
function restoreProcess(): void {
  for (const [name, descriptor] of ORIGINAL_DESCRIPTORS) {
    if (descriptor) Object.defineProperty(process, name, descriptor);
    else Reflect.deleteProperty(process, name);
  }
}

/** Sets the scene for a packaged app on the given platform. */
function packagedOn(platform: NodeJS.Platform): void {
  environment.isPackaged = true;
  stubProcess('platform', platform);
  stubProcess('resourcesPath', RESOURCES);
  stubProcess('execPath', EXECUTABLE);
}

/** Sets the scene for a development run from source on the given platform and architecture. */
function developmentOn(platform: NodeJS.Platform, arch: string, moduleFile: string = SOURCE_FILE): void {
  environment.isPackaged = false;
  environment.moduleFile = moduleFile;
  stubProcess('platform', platform);
  stubProcess('arch', arch);
}

beforeEach((): void => {
  environment.isPackaged = false;
  environment.moduleFile = null;
});

afterEach((): void => {
  restoreProcess();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('getBundledBinDir', () => {
  it.each<NodeJS.Platform>(['darwin', 'win32', 'linux'])('is the bin directory of the app\'s resources when packaged on %s', (platform: NodeJS.Platform) => {
    packagedOn(platform);

    expect(getBundledBinDir()).toBe(path.join(RESOURCES, 'bin'));
  });

  it.each<{platform: NodeJS.Platform; arch: string; directory: string}>([
    {platform: 'darwin', arch: 'arm64', directory: 'mac-arm64'},
    {platform: 'darwin', arch: 'x64', directory: 'mac-x64'},
    {platform: 'win32', arch: 'x64', directory: 'win-x64'},
    {platform: 'linux', arch: 'arm64', directory: 'linux-arm64'},
  ])('is vendor/bin/$directory in the repository in development on $platform $arch', ({platform, arch, directory}: {platform: NodeJS.Platform; arch: string; directory: string}) => {
    developmentOn(platform, arch);

    expect(getBundledBinDir()).toBe(path.join(REPOSITORY, 'vendor', 'bin', directory));
  });

  it('finds the same repository directory when running from the compiled bundle', () => {
    developmentOn('linux', 'x64', COMPILED_FILE);

    expect(getBundledBinDir()).toBe(path.join(REPOSITORY, 'vendor', 'bin', 'linux-x64'));
  });

  it('is null in development on a platform nothing is bundled for', () => {
    developmentOn('freebsd', 'x64');

    expect(getBundledBinDir()).toBeNull();
  });
});

describe('getLicenseLocations', () => {
  it('finds everything under the app\'s resources when packaged, with Electron\'s licences beside the executable', () => {
    packagedOn('linux');

    const locations: LicenseLocations = getLicenseLocations();

    expect(locations).toEqual({
      application: path.join(RESOURCES, 'licenses', 'ONIXPlayer-LICENSE.txt'),
      javascript: path.join(RESOURCES, 'licenses', 'JavaScript-libraries.txt'),
      bundled: path.join(RESOURCES, 'bin', 'licenses'),
      electron: path.dirname(EXECUTABLE),
    });
  });

  it('looks beside the executable for Electron\'s licences when packaged on Windows', () => {
    packagedOn('win32');

    expect(getLicenseLocations().electron).toBe(path.dirname(EXECUTABLE));
  });

  it('looks in Resources for Electron\'s licences when packaged on macOS', () => {
    packagedOn('darwin');

    expect(getLicenseLocations().electron).toBe(RESOURCES);
  });

  it('finds everything in the repository in development', () => {
    developmentOn('darwin', 'arm64');

    const locations: LicenseLocations = getLicenseLocations();

    expect(locations).toEqual({
      application: path.join(REPOSITORY, 'LICENSE'),
      javascript: path.join(REPOSITORY, 'dist', 'onixlabs-media-player', '3rdpartylicenses.txt'),
      bundled: path.join(REPOSITORY, 'vendor', 'bin', 'mac-arm64', 'licenses'),
      electron: path.join(REPOSITORY, 'node_modules', 'electron', 'dist'),
    });
  });

  it('has no bundled licences in development on a platform nothing is bundled for, but still has the rest', () => {
    developmentOn('freebsd', 'x64');

    const locations: LicenseLocations = getLicenseLocations();

    expect(locations.bundled).toBeNull();
    expect(locations.application).toBe(path.join(REPOSITORY, 'LICENSE'));
  });

  it('points at the LICENSE that really is in this repository when run from source', () => {
    // No stand-in location here: the module works out where it is by itself.
    const locations: LicenseLocations = getLicenseLocations();

    expect(path.basename(locations.application)).toBe('LICENSE');
    expect(existsSync(locations.application)).toBe(true);
  });
});

describe('useSystemCertificates', () => {
  const none = (): boolean => false;
  const only = (file: string) => (candidate: string): boolean => candidate === file;

  it('leaves macOS and Windows alone', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const env: NodeJS.ProcessEnv = {};
      expect(useSystemCertificates(platform, env, (): boolean => true)).toBeNull();
      expect(env['SSL_CERT_FILE']).toBeUndefined();
    }
  });

  it('sets SSL_CERT_FILE to the first CA bundle that exists on Linux', () => {
    const env: NodeJS.ProcessEnv = {};
    const fedora: string = '/etc/pki/tls/certs/ca-bundle.crt';

    expect(useSystemCertificates('linux', env, only(fedora))).toBe(fedora);
    expect(env['SSL_CERT_FILE']).toBe(fedora);
  });

  it('prefers the Debian bundle when several exist', () => {
    const env: NodeJS.ProcessEnv = {};

    expect(useSystemCertificates('linux', env, (): boolean => true)).toBe(LINUX_CA_BUNDLES[0]);
  });

  it('keeps an SSL_CERT_FILE the user already set', () => {
    const env: NodeJS.ProcessEnv = {SSL_CERT_FILE: '/home/me/certs.pem'};

    expect(useSystemCertificates('linux', env, (): boolean => true)).toBe('/home/me/certs.pem');
    expect(env['SSL_CERT_FILE']).toBe('/home/me/certs.pem');
  });

  it('sets nothing when no CA bundle is found', () => {
    const env: NodeJS.ProcessEnv = {};

    expect(useSystemCertificates('linux', env, none)).toBeNull();
    expect('SSL_CERT_FILE' in env).toBe(false);
  });

  it('acts on the running process when given nothing: its platform decides', () => {
    stubProcess('platform', 'win32');
    vi.stubEnv('SSL_CERT_FILE', '/home/me/certs.pem');

    expect(useSystemCertificates()).toBeNull();
  });

  it('acts on the running process when given nothing: its environment is read', () => {
    stubProcess('platform', 'linux');
    vi.stubEnv('SSL_CERT_FILE', '/home/me/certs.pem');

    expect(useSystemCertificates()).toBe('/home/me/certs.pem');
  });
});

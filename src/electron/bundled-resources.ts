/**
 * @fileoverview Location of the binaries and licences ONIXPlayer ships outside
 * its asar.
 *
 * External programs cannot be run from inside app.asar, so the bundled
 * binaries are packaged as electron-builder extraResources:
 *
 *   <resources>/bin/  ffmpeg, ffprobe, fluidsynth (scripts/build-binaries.sh)
 *   <resources>/licenses/  ONIXPlayer's licence and its JavaScript libraries'
 *
 * In development they are read from vendor/bin/<os>-<arch> in the repository
 * instead (named as electron-builder's ${os}-${arch}).
 *
 * @module electron/bundled-resources
 */

import {app} from 'electron';
import {existsSync} from 'fs';
import * as path from 'path';
import {fileURLToPath} from 'url';

/** electron-builder's ${os} names, which the vendor/bin directories use */
const BUILDER_OS_NAMES: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  darwin: 'mac',
  win32: 'win',
  linux: 'linux',
};

/**
 * Gets the repository root when running unpackaged.
 *
 * Run through tsx this file is src/electron/<file>.ts; compiled it is bundled
 * into src/electron/dist/main.js.
 */
function getRepositoryRoot(): string {
  const filename: string = fileURLToPath(import.meta.url);
  const levels: number = filename.endsWith('.ts') ? 2 : 3;
  return path.resolve(path.dirname(filename), ...Array<string>(levels).fill('..'));
}

/**
 * Gets the directory holding the bundled ffmpeg, ffprobe and fluidsynth.
 *
 * @returns Absolute path, or null on a platform with no bundled binaries
 */
export function getBundledBinDir(): string | null {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin');
  }
  const os: string | undefined = BUILDER_OS_NAMES[process.platform];
  return os ? path.join(getRepositoryRoot(), 'vendor', 'bin', `${os}-${process.arch}`) : null;
}

/**
 * Where the licence texts ONIXPlayer ships are found.
 *
 * Every one of them is outside app.asar, because the About window hands them
 * to the OS to open, and no other program can read inside an asar.
 */
export interface LicenseLocations {
  /** ONIXPlayer's own LICENSE */
  readonly application: string;
  /** Licences of the JavaScript libraries bundled into the renderer (production builds only) */
  readonly javascript: string;
  /** Directory with the bundled programs' licences and components.json */
  readonly bundled: string | null;
  /** Directory with Electron's LICENSE and Chromium's LICENSES.chromium.html */
  readonly electron: string;
}

/**
 * Gets the locations of the licence texts.
 *
 * Packaged, ONIXPlayer's and the JavaScript licences are extraResources under
 * <resources>/licenses (see package.json). electron-builder puts Electron's
 * own next to the executable, except on macOS, where they are in Resources.
 */
export function getLicenseLocations(): LicenseLocations {
  const binDir: string | null = getBundledBinDir();
  const bundled: string | null = binDir ? path.join(binDir, 'licenses') : null;

  if (app.isPackaged) {
    const licenses: string = path.join(process.resourcesPath, 'licenses');
    return {
      application: path.join(licenses, 'ONIXPlayer-LICENSE.txt'),
      javascript: path.join(licenses, 'JavaScript-libraries.txt'),
      bundled,
      electron: process.platform === 'darwin' ? process.resourcesPath : path.dirname(process.execPath),
    };
  }

  const root: string = getRepositoryRoot();
  return {
    application: path.join(root, 'LICENSE'),
    javascript: path.join(root, 'dist', 'onixlabs-media-player', '3rdpartylicenses.txt'),
    bundled,
    electron: path.join(root, 'node_modules', 'electron', 'dist'),
  };
}

/**
 * Where Linux distributions keep their CA bundle, most common first.
 *
 * The bundled Linux FFmpeg uses a static OpenSSL that looks in /etc/ssl, which
 * covers Debian, Ubuntu, Arch and Alpine; the others need telling.
 */
export const LINUX_CA_BUNDLES: readonly string[] = [
  '/etc/ssl/certs/ca-certificates.crt',   // Debian, Ubuntu, Arch, Gentoo
  '/etc/pki/tls/certs/ca-bundle.crt',     // Fedora, RHEL, CentOS
  '/etc/ssl/ca-bundle.pem',               // openSUSE
  '/etc/ssl/cert.pem',                    // Alpine, Void
];

/**
 * Points the bundled binaries at the system's CA certificates on Linux.
 *
 * Sets SSL_CERT_FILE, which OpenSSL reads, so every FFmpeg the app or yt-dlp
 * starts inherits it. A value the user already set is left alone.
 *
 * @param platform - The current platform (process.platform)
 * @param env - The environment to update (process.env)
 * @param exists - Checks whether a file exists
 * @returns The CA bundle now in use, or null if none was set
 */
export function useSystemCertificates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
): string | null {
  if (platform !== 'linux') return null;
  if (env['SSL_CERT_FILE']) return env['SSL_CERT_FILE'];
  const bundle: string | undefined = LINUX_CA_BUNDLES.find((file: string): boolean => exists(file));
  if (bundle) env['SSL_CERT_FILE'] = bundle;
  return bundle ?? null;
}

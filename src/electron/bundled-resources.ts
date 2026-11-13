/**
 * @fileoverview Location of the binaries ONIXPlayer ships outside its asar.
 *
 * External programs cannot be run from inside app.asar, so the bundled
 * binaries are packaged as electron-builder extraResources:
 *
 *   <resources>/bin/  ffmpeg, ffprobe, fluidsynth (scripts/build-binaries.sh)
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

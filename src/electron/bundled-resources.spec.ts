/**
 * @fileoverview Tests for pointing the bundled binaries at the system's CA
 * certificates.
 *
 * @module electron/bundled-resources.spec
 */

import { vi, describe, it, expect } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

import { LINUX_CA_BUNDLES, useSystemCertificates } from './bundled-resources.js';

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
});

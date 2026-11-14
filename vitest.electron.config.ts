import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/electron/**/*.spec.ts'],
    globals: true,
    // Vitest 5 clears mock call history before every test by default. These
    // suites were written against the Vitest 4 behaviour and manage their own
    // mock state, so keep it.
    clearMocks: false,
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['src/electron/**/*.ts'],
      exclude: ['src/electron/**/*.spec.ts', 'src/electron/dist/**'],
      thresholds: {
        // Global thresholds. CI is the only place they are enforced, and a
        // local run on macOS reads higher than the Linux runner does, because
        // darwin-only branches execute there. Calibrating against a local run
        // once put these above what CI could reach.
        //
        // These were set from a macOS run (98.5 / 97.3 / 99.6 / 98.6) with
        // about two points of margin, before a CI measurement existed for the
        // suite at this size. Tighten them to just under the CI figures once
        // a run has reported them.
        statements: 96,
        branches: 95,
        functions: 97,
        lines: 96,

        // Per-file floors for the pure-logic modules. These are the strongest
        // guard available: a global percentage can stay flat while a
        // well-covered module quietly rots, because the large hard-to-test
        // files dominate the average. Each of these has a dedicated suite, so
        // a drop here means coverage was actually removed.
        'src/electron/playlist-manager.ts': {
          statements: 94,
          branches: 90,
          functions: 96,
          lines: 95,
        },
        'src/electron/sse-manager.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'src/electron/media-download-manager.ts': {
          statements: 100,
          branches: 95,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});

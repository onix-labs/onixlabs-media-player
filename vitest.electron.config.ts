import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/electron/**/*.spec.ts'],
    globals: true,
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['src/electron/**/*.ts'],
      exclude: ['src/electron/**/*.spec.ts', 'src/electron/dist/**'],
      thresholds: {
        // Global thresholds, set just under the measured figures. They stay
        // low in absolute terms because main.ts and preload.ts are 0% — both
        // need the Electron runtime — and unified-media-server.ts is 4,000
        // lines of mostly-streaming code. Raise these as those come down.
        statements: 43,
        branches: 47,
        functions: 42,
        lines: 43,

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

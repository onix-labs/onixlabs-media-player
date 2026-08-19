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
        // Global thresholds (conservative — main.ts, preload.ts, and
        // unified-media-server.ts are hard to unit test without Electron runtime)
        statements: 20,
        branches: 35,
        functions: 20,
        lines: 20,

        // Per-file floors for the pure-logic modules. These are the strongest
        // guard available: a global percentage can stay flat while a
        // well-covered module quietly rots, because the large hard-to-test
        // files dominate the average. Each of these has a dedicated suite, so
        // a drop here means coverage was actually removed.
        'src/electron/playlist-manager.ts': {
          statements: 85,
          branches: 75,
          functions: 85,
          lines: 85,
        },
        'src/electron/sse-manager.ts': {
          statements: 90,
          branches: 80,
          functions: 90,
          lines: 90,
        },
        'src/electron/media-download-manager.ts': {
          statements: 75,
          branches: 60,
          functions: 75,
          lines: 75,
        },
      },
    },
  },
});

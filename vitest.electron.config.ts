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
      },
    },
  },
});

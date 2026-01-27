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
    },
  },
});

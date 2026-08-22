import { defineConfig } from 'vitest/config';

/**
 * Base Vitest configuration for the Angular suite, wired in via the
 * `runnerConfig` option of `@angular/build:unit-test` in angular.json.
 *
 * The Electron suite does not read this file — it is run with an explicit
 * `--config vitest.electron.config.ts`.
 */
export default defineConfig({
  test: {
    // The Angular builder defaults this to `false` "to align with the
    // Karma/Jasmine experience" (@angular/build unit-test runner), which shares
    // one jsdom environment and one module registry across every spec file a
    // worker handles. TestBed resolves DOCUMENT once from that shared
    // environment, so any file that runs after it has been torn down injects
    // undefined and every createComponent call in it fails with
    // "Cannot read properties of undefined (reading 'createElement')".
    //
    // Which files lose is decided by worker scheduling, not by their contents:
    // two runs of the same commit failed four files and three files
    // respectively, overlapping in only one. It reproduces on CI runners and
    // not on a developer machine purely because the core count differs.
    //
    // The builder merges this config over its own defaults, so setting it here
    // wins. Isolation costs wall-clock — a fresh environment per file — which
    // is the price of the suite meaning anything.
    isolate: true,
  },
});

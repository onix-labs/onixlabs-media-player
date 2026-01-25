/**
 * Electron production build script using esbuild.
 *
 * Bundles and tree-shakes Electron main process code:
 * - main.ts → dist/main.js (includes all dependencies)
 * - preload.ts → dist/preload.js (separate bundle for renderer context)
 *
 * Run with: npx tsx scripts/build-electron.ts
 */

import * as esbuild from 'esbuild';
import { rmSync, mkdirSync } from 'fs';

const OUTPUT_DIR = 'src/electron/dist';

const COMMON_OPTIONS: esbuild.BuildOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20', // Electron 39 uses Node 20
  format: 'cjs', // CommonJS for electron-log compatibility
  minify: true,
  treeShaking: true,
  sourcemap: false,
  // Mark Electron and Node.js built-ins as external (but bundle electron-log)
  external: [
    'electron',
    // Node.js built-ins that shouldn't be bundled
    'path',
    'fs',
    'url',
    'http',
    'https',
    'stream',
    'util',
    'os',
    'child_process',
    'events',
    'buffer',
    'crypto',
    'net',
    'tls',
    'zlib',
    'assert',
    'constants',
    'module',
    'process',
  ],
};

async function build(): Promise<void> {
  console.log('📦 Building Electron with esbuild...\n');

  // Clean output directory
  console.log('  Cleaning dist...');
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Build main process (bundles unified-media-server, settings-manager, etc.)
  // Use .cjs extension since project has "type": "module"
  console.log('  Building main.cjs...');
  const mainResult = await esbuild.build({
    ...COMMON_OPTIONS,
    entryPoints: ['src/electron/main.ts'],
    outfile: 'src/electron/dist/main.cjs',
    metafile: true,
  });

  const mainSize = getOutputSize(mainResult.metafile, 'src/electron/dist/main.cjs');
  console.log(`  ✓ main.cjs (${formatBytes(mainSize)})`);

  // Build preload script (separate bundle, runs in renderer context)
  console.log('  Building preload.cjs...');
  const preloadResult = await esbuild.build({
    ...COMMON_OPTIONS,
    entryPoints: ['src/electron/preload.ts'],
    outfile: 'src/electron/dist/preload.cjs',
    metafile: true,
  });

  const preloadSize = getOutputSize(preloadResult.metafile, 'src/electron/dist/preload.cjs');
  console.log(`  ✓ preload.cjs (${formatBytes(preloadSize)})`);

  const totalSize = mainSize + preloadSize;
  console.log(`\n✅ Electron build complete. Total: ${formatBytes(totalSize)}`);
}

function getOutputSize(metafile: esbuild.Metafile | undefined, outputPath: string): number {
  if (!metafile) return 0;
  const output = metafile.outputs[outputPath];
  return output?.bytes ?? 0;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

build().catch((error: unknown) => {
  console.error('Build failed:', error);
  process.exit(1);
});

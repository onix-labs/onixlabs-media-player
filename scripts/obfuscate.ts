/**
 * Production code obfuscation script.
 *
 * Obfuscates compiled JavaScript in:
 * - dist/onixlabs-media-player/browser/ (Angular output)
 * - src/electron/dist/ (Electron main process)
 *
 * Run with: npx tsx scripts/obfuscate.ts
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import JavaScriptObfuscator from 'javascript-obfuscator';

// Obfuscation settings - lightweight for minimal size increase
const OBFUSCATOR_OPTIONS: Parameters<typeof JavaScriptObfuscator.obfuscate>[1] = {
  // Compact output (single line)
  compact: true,

  // Control flow flattening - DISABLED (major bloat source)
  controlFlowFlattening: false,

  // Dead code injection - DISABLED (major bloat source)
  deadCodeInjection: false,

  // String transformations - lightweight settings
  stringArray: true,
  stringArrayThreshold: 0.5, // Only transform 50% of strings
  stringArrayEncoding: [], // No encoding (smaller output)
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 1, // Minimal wrappers
  stringArrayWrappersType: 'variable', // Simpler than 'function'

  // Identifier renaming - good protection, minimal overhead
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false, // Don't rename globals to avoid breaking Node.js/Electron APIs

  // Split strings - DISABLED (adds overhead)
  splitStrings: false,

  // Transform object keys - DISABLED (can break dynamic access)
  transformObjectKeys: false,

  // Unicode escape sequences
  unicodeEscapeSequence: false,

  // Source map (disabled for production)
  sourceMap: false,

  // Target environment
  target: 'node', // Electron uses Node.js

  // Preserve functionality
  selfDefending: false, // Can cause issues in Electron
  debugProtection: false, // Interferes with DevTools
  disableConsoleOutput: false, // Keep console for logging
};

// Directories to obfuscate
// Note: Electron code is excluded because javascript-obfuscator doesn't support ESM imports
// The Electron code is already minified by esbuild with tree shaking
const OBFUSCATE_DIRS: string[] = [
  'dist/onixlabs-media-player/browser',
];

// Files to skip obfuscation (still get esbuild minification)
const SKIP_FILES: string[] = [
  'preload.js', // Skip to avoid breaking contextBridge API exposure
];

/**
 * Recursively finds all .js files in a directory.
 */
function findJsFiles(dir: string): string[] {
  const files: string[] = [];

  try {
    const entries: string[] = readdirSync(dir);

    for (const entry of entries) {
      const fullPath: string = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        files.push(...findJsFiles(fullPath));
      } else if (stat.isFile() && extname(entry) === '.js') {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist, skip
  }

  return files;
}

/**
 * Obfuscates a single JavaScript file.
 */
function obfuscateFile(filePath: string): void {
  const fileName: string = filePath.split('/').pop() ?? '';

  if (SKIP_FILES.includes(fileName)) {
    console.log(`  Skipping: ${filePath}`);
    return;
  }

  try {
    const originalCode: string = readFileSync(filePath, 'utf-8');
    const originalSize: number = Buffer.byteLength(originalCode, 'utf-8');

    const obfuscatedResult = JavaScriptObfuscator.obfuscate(originalCode, OBFUSCATOR_OPTIONS);
    const obfuscatedCode: string = obfuscatedResult.getObfuscatedCode();
    const obfuscatedSize: number = Buffer.byteLength(obfuscatedCode, 'utf-8');

    writeFileSync(filePath, obfuscatedCode, 'utf-8');

    const ratio: string = ((obfuscatedSize / originalSize) * 100).toFixed(0);
    console.log(
      `  Obfuscated: ${filePath} (${formatBytes(originalSize)} → ${formatBytes(obfuscatedSize)}, ${ratio}%)`
    );
  } catch (error) {
    console.error(`  Error obfuscating ${filePath}:`, error);
    process.exit(1);
  }
}

/**
 * Formats bytes as human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Main entry point.
 */
function main(): void {
  console.log('🔒 Obfuscating production code...\n');

  let totalFiles: number = 0;

  for (const dir of OBFUSCATE_DIRS) {
    console.log(`Processing: ${dir}/`);
    const files: string[] = findJsFiles(dir);

    if (files.length === 0) {
      console.log('  No .js files found\n');
      continue;
    }

    for (const file of files) {
      obfuscateFile(file);
      totalFiles++;
    }
    console.log('');
  }

  console.log(`✅ Obfuscation complete. Processed ${totalFiles} files.`);
}

main();

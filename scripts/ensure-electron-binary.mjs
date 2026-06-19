/**
 * postinstall guard for Electron's native binary.
 *
 * Electron ships a tiny JS wrapper plus a separately-downloaded ~270MB binary.
 * On some Node versions, Electron's bundled `extract-zip` resolves WITHOUT
 * actually unpacking the downloaded zip, leaving `dist/` empty and `path.txt`
 * missing — so `require('electron')` throws "Electron failed to install
 * correctly". The download itself succeeds and is cached, so this guard
 * detects the missing binary and extracts the already-cached zip using the
 * platform's native unzip tooling.
 *
 * No-ops (exit 0) when the binary is already present, when Electron isn't
 * installed (e.g. production `--omit=dev`), or when binary download is skipped.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  mkdirSync,
  rmSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  process.exit(0);
}

const require = createRequire(import.meta.url);

// Locate the installed electron package (absent in production installs).
let electronDir;
let version;
try {
  const pkgPath = require.resolve('electron/package.json');
  electronDir = join(pkgPath, '..');
  version = require(pkgPath).version;
} catch {
  process.exit(0); // electron not installed — nothing to guard
}

const platform = process.env.npm_config_platform || process.platform;
const arch = process.env.npm_config_arch || process.arch;

function platformExecPath() {
  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'win32':
      return 'electron.exe';
    default:
      return 'electron';
  }
}

const relExec = platformExecPath();
const distDir = join(electronDir, 'dist');
const binPath = join(distDir, relExec);

if (existsSync(binPath)) {
  process.exit(0); // healthy — nothing to do
}

// Find the cached download that @electron/get already fetched.
function cacheRoots() {
  const home = os.homedir();
  const roots = [];
  if (process.env.electron_config_cache) roots.push(process.env.electron_config_cache);
  if (process.env.ELECTRON_CACHE) roots.push(process.env.ELECTRON_CACHE);
  if (platform === 'darwin' || platform === 'mas') {
    roots.push(join(home, 'Library', 'Caches', 'electron'));
  } else if (platform === 'win32') {
    if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'electron', 'Cache'));
    roots.push(join(home, 'AppData', 'Local', 'electron', 'Cache'));
  } else {
    roots.push(
      process.env.XDG_CACHE_HOME
        ? join(process.env.XDG_CACHE_HOME, 'electron')
        : join(home, '.cache', 'electron'),
    );
  }
  return roots;
}

const zipName = `electron-v${version}-${platform}-${arch}.zip`;

function findZip() {
  for (const root of cacheRoots()) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const candidate = join(root, entry, zipName);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const zipPath = findZip();
if (!zipPath) {
  console.warn(
    `[ensure-electron-binary] Electron binary missing and no cached ${zipName} found. ` +
      `Run "node node_modules/electron/install.js" to download it, then re-run install.`,
  );
  process.exit(0); // don't fail the whole install; surface guidance instead
}

console.log(`[ensure-electron-binary] Repairing Electron binary from ${zipPath}`);

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

if (platform === 'win32') {
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${distDir}" -Force`],
    { stdio: 'inherit' },
  );
} else {
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', distDir], { stdio: 'inherit' });
}

// install.js hoists the bundled type definitions to the package root.
const srcTypeDef = join(distDir, 'electron.d.ts');
if (existsSync(srcTypeDef)) {
  renameSync(srcTypeDef, join(electronDir, 'electron.d.ts'));
}

// The wrapper reads path.txt to locate the executable.
writeFileSync(join(electronDir, 'path.txt'), relExec);

if (!existsSync(binPath)) {
  console.error('[ensure-electron-binary] Extraction completed but binary still missing.');
  process.exit(1);
}

console.log('[ensure-electron-binary] Electron binary restored.');

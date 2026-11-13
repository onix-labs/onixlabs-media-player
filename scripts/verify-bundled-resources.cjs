/**
 * electron-builder beforePack hook: refuses to package an app that would be
 * missing the binaries it ships outside its asar.
 *
 * vendor/bin/<os>-<arch> must hold ffmpeg, ffprobe and fluidsynth for the arch
 * being packaged, built by scripts/build-binaries.sh. An app without them
 * cannot play anything, and nothing would otherwise notice: electron-builder
 * silently skips an extraResources source that does not exist.
 *
 * CommonJS because electron-builder loads hooks with require().
 */

const {existsSync} = require('fs');
const path = require('path');
const {Arch} = require('builder-util');

const ROOT = path.resolve(__dirname, '..');

/** electron-builder's ${os} names, which the vendor/bin directories use */
const OS_NAMES = {darwin: 'mac', win32: 'win', linux: 'linux'};

const BINARIES = ['ffmpeg', 'ffprobe', 'fluidsynth'];

/** The About window lists these; components.json names the bundled programs' licences. */
const LICENSES = [
  'LICENSE',
  'dist/onixlabs-media-player/3rdpartylicenses.txt',
];

exports.default = async function verifyBundledResources(context) {
  const os = OS_NAMES[context.electronPlatformName];
  const arch = Arch[context.arch];
  const target = `${os}-${arch}`;
  const binDir = path.join(ROOT, 'vendor', 'bin', target);
  const exe = context.electronPlatformName === 'win32' ? '.exe' : '';

  const missing = [
    ...BINARIES.map((name) => name + exe),
    'licenses/components.json',
  ].filter((name) => !existsSync(path.join(binDir, name)));
  if (missing.length > 0) {
    throw new Error(
      `Cannot package ${target}: vendor/bin/${target} is missing ${missing.join(', ')}. ` +
      `Run "npm run binaries -- ${arch}" on a ${arch} machine first.`
    );
  }

  // 3rdpartylicenses.txt comes only from a production Angular build.
  const missingLicenses = LICENSES.filter((file) => !existsSync(path.join(ROOT, file)));
  if (missingLicenses.length > 0) {
    throw new Error(`Cannot package ${target}: missing ${missingLicenses.join(', ')}. Run "npm run build" first.`);
  }
};

#!/usr/bin/env bash
#
# Checks a packaged ONIXPlayer holds what it needs at run time, where the app
# looks for it (src/electron/bundled-resources.ts):
#
#   - the bundled ffmpeg, ffprobe and fluidsynth, which run from there
#   - every licence the About window lists, outside app.asar
#
# Usage: scripts/check-package.sh <packaged app directory>
#   e.g. release/mac-arm64/ONIXPlayer.app, release/win-unpacked,
#        release/linux-unpacked

set -euo pipefail

APP="${1:?usage: scripts/check-package.sh <packaged app directory>}"

fail() { echo "error: $*" >&2; exit 1; }

# electron-builder puts Electron's licences next to the executable, except on
# macOS, where everything is in Contents/Resources.
case "${APP}" in
  *.app)
    RESOURCES="${APP}/Contents/Resources"
    ELECTRON_LICENSES="${RESOURCES}"
    EXE=""
    ;;
  *win-unpacked)
    RESOURCES="${APP}/resources"
    ELECTRON_LICENSES="${APP}"
    EXE=".exe"
    ;;
  *)
    RESOURCES="${APP}/resources"
    ELECTRON_LICENSES="${APP}"
    EXE=""
    ;;
esac

[ -f "${RESOURCES}/app.asar" ] || fail "${RESOURCES} is not a packaged app's resources (no app.asar)"

for bin in ffmpeg ffprobe fluidsynth; do
  [ -x "${RESOURCES}/bin/${bin}${EXE}" ] || fail "missing ${RESOURCES}/bin/${bin}${EXE}"
done
# One Mac packages both architectures; the other one's binaries are checked
# for presence only, rather than relying on Rosetta being installed.
runnable=1
if [ -n "$(command -v lipo)" ]; then
  archs="$(lipo -archs "${RESOURCES}/bin/ffmpeg")"
  [ "${archs}" = "$(uname -m)" ] || runnable=0
fi
if [ "${runnable}" = "1" ]; then
  "${RESOURCES}/bin/ffmpeg${EXE}" -hide_banner -version | sed -n 1p
  "${RESOURCES}/bin/fluidsynth${EXE}" --version | sed -n 1p
else
  echo "binaries are ${archs}, not $(uname -m): present, not run"
fi

for file in \
  "${RESOURCES}/licenses/ONIXPlayer-LICENSE.txt" \
  "${RESOURCES}/licenses/JavaScript-libraries.txt" \
  "${RESOURCES}/bin/licenses/components.json" \
  "${ELECTRON_LICENSES}/LICENSE.electron.txt" \
  "${ELECTRON_LICENSES}/LICENSES.chromium.html"; do
  [ -s "${file}" ] || fail "missing or empty ${file}"
done

# Every licence components.json names must be there to open.
manifest="$(cat "${RESOURCES}/bin/licenses/components.json")"
files="$(sed -n 's/.*"file": *"\([^"]*\)".*/\1/p' <<<"${manifest}")"
[ -n "${files}" ] || fail "components.json names no licence files"
while IFS= read -r name; do
  [ -s "${RESOURCES}/bin/licenses/${name}" ] || fail "components.json names ${name}, which is missing"
done <<<"${files}"

echo "ok: ${APP}"

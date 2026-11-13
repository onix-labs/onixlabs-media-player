#!/usr/bin/env bash
#
# Checks the bundled binaries in vendor/bin/<os>-<arch> work on this machine,
# which need not be the one that built them: the Linux binaries are built in
# Alpine and checked on Ubuntu, to prove they are portable.
#
#   - each program runs and reports its version
#   - FFmpeg can play tracker modules (libopenmpt)
#   - FFmpeg's https protocol reaches a real site, so the TLS library and the
#     system's CA certificates are found
#   - FFmpeg refuses a site whose certificate is untrusted
#
# Usage: scripts/check-binaries.sh <os>-<arch>   (needs network access)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:?usage: scripts/check-binaries.sh <os>-<arch>}"
DIR="${ROOT}/vendor/bin/${TARGET}"
EXE=""
case "${TARGET}" in win-*) EXE=".exe" ;; esac

FFMPEG="${DIR}/ffmpeg${EXE}"
FFPROBE="${DIR}/ffprobe${EXE}"
FLUIDSYNTH="${DIR}/fluidsynth${EXE}"

# A page, not media: reading it fails as "Invalid data", which can only happen
# once the TLS handshake has succeeded.
TRUSTED_URL="https://www.example.com/"
UNTRUSTED_URL="https://self-signed.badssl.com/"

fail() { echo "error: $*" >&2; exit 1; }

"${FFMPEG}" -hide_banner -version | sed -n 1p
"${FFPROBE}" -hide_banner -version | sed -n 1p
"${FLUIDSYNTH}" --version | sed -n 1p

demuxers="$("${FFMPEG}" -hide_banner -demuxers)"
grep -q libopenmpt <<<"${demuxers}" || fail "ffmpeg has no libopenmpt demuxer"

probe() { "${FFPROBE}" -hide_banner -v error "$1" 2>&1 || true; }

trusted="$(probe "${TRUSTED_URL}")"
grep -q "Invalid data" <<<"${trusted}" || fail "https failed for ${TRUSTED_URL}: ${trusted}"
echo "https: ${TRUSTED_URL} connected"

untrusted="$(probe "${UNTRUSTED_URL}")"
if grep -q "Invalid data" <<<"${untrusted}"; then
  fail "https accepted the untrusted certificate at ${UNTRUSTED_URL}"
fi
echo "https: ${UNTRUSTED_URL} refused (${untrusted})"

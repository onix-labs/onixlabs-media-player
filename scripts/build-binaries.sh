#!/usr/bin/env bash
#
# Builds the media binaries ONIXPlayer bundles, so no user ever needs a
# package manager:
#
#   ffmpeg, ffprobe  - FFmpeg with libx264, LAME and libopenmpt linked in
#                      statically. libopenmpt is what plays tracker modules.
#   fluidsynth       - FluidSynth CLI with a minimal libsndfile linked in
#                      statically. libsndfile is what lets `-F -` write raw PCM
#                      to stdout; without it FluidSynth writes a file named "-".
#
# Every source tarball is pinned by SHA-256. The tarballs are kept in
# vendor/cache: they are the corresponding source the GPL and LGPL require us
# to publish alongside any release that ships these binaries.
#
# Output: vendor/bin/<os>-<arch>/ using electron-builder's ${os} and ${arch}
# names (mac-x64, mac-arm64, linux-x64, win-x64), which package.json's
# extraResources reads.
#
# Where each target is built (.github/workflows/binaries.yml does all four):
#
#   mac    natively, on a Mac of the target arch. HTTPS through Secure Transport.
#   linux  in Alpine, against musl, so the binaries are fully static and run on
#          any distribution. HTTPS through a static OpenSSL, which makes FFmpeg
#          GPL-3.0-or-later there (--enable-version3).
#   win    in MSYS2's UCRT64 environment, linked statically against MinGW's
#          runtime. HTTPS through SChannel and the Windows certificate store.
#
# Usage: scripts/build-binaries.sh [x64|arm64]   (defaults to the host arch)
#        FORCE=1 scripts/build-binaries.sh        (rebuild everything)
#        FETCH_ONLY=1 scripts/build-binaries.sh   (download the sources only)
#
# Each library is rebuilt only when its pinned version changes, so a rerun
# after a failure picks up where it stopped.
#
# Build-time tools (developer machines and CI only, never end users):
# a C/C++ toolchain, make, cmake, pkg-config, nasm for x64, and perl on Linux.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="${ROOT}/vendor"
CACHE="${VENDOR}/cache"

# ----------------------------------------------------------------------------
# Pinned sources
# ----------------------------------------------------------------------------

FFMPEG_VERSION="9.0.2"
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_SHA256="8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e"

X264_REVISION="b35605ace3ddf7c1a5d67a2eb553f034aef41d55"
X264_URL="https://code.videolan.org/videolan/x264/-/archive/${X264_REVISION}/x264-${X264_REVISION}.tar.bz2"
X264_SHA256="6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224"

LAME_VERSION="4.0"
LAME_URL="https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz"
LAME_SHA256="3df5124d5ad3a98312ffd7ba6a9b36230e4f8a3e66d3ce0f425e336c32d216eb"

LIBOPENMPT_VERSION="0.8.10"
LIBOPENMPT_URL="https://lib.openmpt.org/files/libopenmpt/src/libopenmpt-${LIBOPENMPT_VERSION}+release.autotools.tar.gz"
LIBOPENMPT_SHA256="976d259288c40cd285771f77d09eff3d02514511d5677ecfcfb53be5013317e2"

LIBSNDFILE_VERSION="1.2.2"
LIBSNDFILE_URL="https://github.com/libsndfile/libsndfile/releases/download/${LIBSNDFILE_VERSION}/libsndfile-${LIBSNDFILE_VERSION}.tar.xz"
LIBSNDFILE_SHA256="3799ca9924d3125038880367bf1468e53a1b7e3686a934f098b7e1d286cdb80e"

FLUIDSYNTH_VERSION="2.6.2"
FLUIDSYNTH_URL="https://github.com/FluidSynth/fluidsynth/archive/refs/tags/v${FLUIDSYNTH_VERSION}.tar.gz"
FLUIDSYNTH_SHA256="ca376b42a3c1b186a4c8c248931789a455ac94a89b777394969d678010c2f91f"

# Linux only: FFmpeg's https protocol. 3.5 is OpenSSL's current LTS line.
OPENSSL_VERSION="3.5.9"
OPENSSL_URL="https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz"
OPENSSL_SHA256="603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a"

# Electron 45's own floor; nothing we ship needs to run anywhere older.
MACOS_DEPLOYMENT_TARGET="12.0"

# ----------------------------------------------------------------------------
# Sources
# ----------------------------------------------------------------------------

log() { printf '\n==> %s\n' "$*"; }

sha256() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# fetch <url> <sha256> <file name>
fetch() {
  local url="$1" sha="$2" file="${CACHE}/$3"
  mkdir -p "${CACHE}"
  if [ ! -f "${file}" ]; then
    log "Downloading $3"
    curl -fL --retry 3 -o "${file}.part" "${url}"
    mv "${file}.part" "${file}"
  fi
  local actual
  actual="$(sha256 "${file}")"
  if [ "${actual}" != "${sha}" ]; then
    echo "error: checksum mismatch for $3" >&2
    echo "  expected ${sha}" >&2
    echo "  actual   ${actual}" >&2
    exit 1
  fi
}

# Every source is fetched on every OS, so vendor/cache always holds the full set
# a release publishes, whichever machine it came from.
fetch "${FFMPEG_URL}" "${FFMPEG_SHA256}" "ffmpeg-${FFMPEG_VERSION}.tar.xz"
fetch "${X264_URL}" "${X264_SHA256}" "x264-${X264_REVISION}.tar.bz2"
fetch "${LAME_URL}" "${LAME_SHA256}" "lame-${LAME_VERSION}.tar.gz"
fetch "${LIBOPENMPT_URL}" "${LIBOPENMPT_SHA256}" "libopenmpt-${LIBOPENMPT_VERSION}+release.autotools.tar.gz"
fetch "${LIBSNDFILE_URL}" "${LIBSNDFILE_SHA256}" "libsndfile-${LIBSNDFILE_VERSION}.tar.xz"
fetch "${FLUIDSYNTH_URL}" "${FLUIDSYNTH_SHA256}" "fluidsynth-${FLUIDSYNTH_VERSION}.tar.gz"
fetch "${OPENSSL_URL}" "${OPENSSL_SHA256}" "openssl-${OPENSSL_VERSION}.tar.gz"

if [ "${FETCH_ONLY:-0}" = "1" ]; then
  log "Sources in ${CACHE}"
  exit 0
fi

# ----------------------------------------------------------------------------
# Target
# ----------------------------------------------------------------------------

case "$(uname -s)" in
  Darwin) OS="mac" ;;
  Linux) OS="linux" ;;
  MINGW*|MSYS*) OS="win" ;;
  *) echo "error: no bundled binaries build for $(uname -s)." >&2; exit 1 ;;
esac

HOST_ARCH="$(uname -m)"
case "${HOST_ARCH}" in
  x86_64) HOST_ARCH="x64" ;;
  arm64|aarch64) HOST_ARCH="arm64" ;;
esac
ARCH="${1:-${HOST_ARCH}}"

case "${ARCH}" in
  x64|arm64) ;;
  *) echo "error: unknown arch '${ARCH}' (expected x64 or arm64)" >&2; exit 1 ;;
esac

if [ "${ARCH}" != "${HOST_ARCH}" ]; then
  # The FFmpeg and x264 configure scripts run test programs, so a cross build
  # needs more care than an -arch flag. Build on a machine of each arch.
  echo "error: cross-building ${ARCH} on a ${HOST_ARCH} host is not supported; build on a ${ARCH} machine." >&2
  exit 1
fi

TARGET="${OS}-${ARCH}"
WORK="${VENDOR}/build/${TARGET}"
PREFIX="${WORK}/prefix"
OUT="${VENDOR}/bin/${TARGET}"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 4)"
EXE=""

# Our prefix first, and on macOS only our prefix: a library found in
# /usr/local or /opt/homebrew would link the binaries to something the user
# does not have. On Linux and Windows the toolchain's own static zlib and bzip2
# are what gets linked, which -static guarantees end up inside the binary.
unset PKG_CONFIG_PATH
CMAKE_ARGS=()

case "${OS}" in
  mac)
    case "${ARCH}" in
      x64) CLANG_ARCH="x86_64" ;;
      arm64) CLANG_ARCH="arm64" ;;
    esac
    export MACOSX_DEPLOYMENT_TARGET="${MACOS_DEPLOYMENT_TARGET}"
    export CFLAGS="-arch ${CLANG_ARCH} -mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET} -O2"
    export LDFLAGS="-arch ${CLANG_ARCH} -mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET}"
    export PKG_CONFIG_LIBDIR="${PREFIX}/lib/pkgconfig"
    CMAKE_ARGS+=(-DCMAKE_OSX_ARCHITECTURES="${CLANG_ARCH}" -DCMAKE_OSX_DEPLOYMENT_TARGET="${MACOS_DEPLOYMENT_TARGET}")
    ;;
  linux)
    export CFLAGS="-O2"
    export LDFLAGS="-static"
    export PKG_CONFIG_LIBDIR="${PREFIX}/lib/pkgconfig:/usr/lib/pkgconfig"
    if [ ! -f /etc/alpine-release ]; then
      # glibc cannot be linked fully statically (its resolver loads NSS modules
      # at run time), so a glibc build would only run on as new a glibc.
      echo "error: build the Linux binaries in Alpine (musl); see .github/workflows/binaries.yml." >&2
      exit 1
    fi
    ;;
  win)
    if [ "${ARCH}" != "x64" ]; then
      echo "error: only win-x64 is built." >&2
      exit 1
    fi
    if [ -z "${MINGW_PREFIX:-}" ]; then
      echo "error: run this from an MSYS2 UCRT64 shell." >&2
      exit 1
    fi
    EXE=".exe"
    export CFLAGS="-O2"
    export LDFLAGS="-static -static-libgcc -static-libstdc++"
    export PKG_CONFIG_LIBDIR="${PREFIX}/lib/pkgconfig:${MINGW_PREFIX}/lib/pkgconfig"
    # MinGW's CMake would otherwise pick Ninja, which MSYS2 does not install by
    # default; make is already required.
    export CMAKE_GENERATOR="MSYS Makefiles"
    ;;
esac
export CXXFLAGS="${CFLAGS}"

for tool in make cmake pkg-config curl; do
  command -v "${tool}" >/dev/null || { echo "error: '${tool}' is required to build the binaries" >&2; exit 1; }
done
if [ "${ARCH}" = "x64" ] && ! command -v nasm >/dev/null; then
  echo "error: 'nasm' is required to build x264 for x64" >&2
  exit 1
fi
if [ "${OS}" = "linux" ] && ! command -v perl >/dev/null; then
  echo "error: 'perl' is required to build OpenSSL" >&2
  exit 1
fi

# Stamps record which pinned version of each library is in ${PREFIX}.
STAMPS="${WORK}/stamps"
if [ "${FORCE:-0}" = "1" ]; then
  rm -rf "${WORK}"
fi
mkdir -p "${STAMPS}"
built() { [ -f "${STAMPS}/$1" ]; }
mark() { touch "${STAMPS}/$1"; }

# unpack <file name> <directory name>: a fresh tree under ${WORK}/src
unpack() {
  local src="${WORK}/src"
  mkdir -p "${src}"
  rm -rf "${src:?}/$2"
  mkdir -p "${src}/$2"
  # .gitmodules is skipped: nothing builds from it, and some sandboxes refuse
  # to create files that configure git.
  tar -xf "${CACHE}/$1" -C "${src}/$2" --strip-components=1 --exclude .gitmodules
  cd "${src}/$2"
}

mkdir -p "${PREFIX}/lib/pkgconfig"

if [ "${OS}" = "mac" ]; then
  # macOS ships zlib in the SDK but no zlib.pc, and libopenmpt finds zlib
  # through pkg-config. Describe the system copy so libopenmpt links against it.
  cat > "${PREFIX}/lib/pkgconfig/zlib.pc" <<'EOF'
Name: zlib
Description: zlib from the macOS SDK
Version: 1.2.12
Libs: -lz
Cflags:
EOF
fi

# ----------------------------------------------------------------------------
# Libraries (static)
# ----------------------------------------------------------------------------

if ! built "x264-${X264_REVISION}"; then
  log "Building x264"
  unpack "x264-${X264_REVISION}.tar.bz2" x264
  X264_ARGS=(--prefix="${PREFIX}" --enable-static --disable-cli --disable-opencl)
  # Position-independent code means nothing on Windows, where x264 rejects it.
  [ "${OS}" != "win" ] && X264_ARGS+=(--enable-pic)
  ./configure "${X264_ARGS[@]}"
  make -j"${JOBS}"
  make install
  mark "x264-${X264_REVISION}"
fi

if ! built "lame-${LAME_VERSION}"; then
  log "Building LAME ${LAME_VERSION}"
  unpack "lame-${LAME_VERSION}.tar.gz" lame
  # FFmpeg only uses LAME's encoder; its decoder would need libmpg123.
  ./configure --prefix="${PREFIX}" --disable-shared --enable-static --disable-dependency-tracking \
    --disable-frontend --disable-decoder --disable-analyzer-hooks --disable-gtktest
  make -j"${JOBS}"
  make install
  mark "lame-${LAME_VERSION}"
fi

if ! built "libopenmpt-${LIBOPENMPT_VERSION}"; then
  log "Building libopenmpt ${LIBOPENMPT_VERSION}"
  unpack "libopenmpt-${LIBOPENMPT_VERSION}+release.autotools.tar.gz" libopenmpt
  # Without mpg123 and vorbis, the few modules with MP3- or Vorbis-compressed
  # samples (some MO3 files) will not decode; every other format does.
  ./configure --prefix="${PREFIX}" --disable-shared --enable-static \
    --disable-openmpt123 --disable-examples --disable-tests --disable-doxygen-doc \
    --without-mpg123 --without-ogg --without-vorbis --without-vorbisfile \
    --without-portaudio --without-portaudiocpp --without-sndfile --without-flac
  make -j"${JOBS}"
  make install
  mark "libopenmpt-${LIBOPENMPT_VERSION}"
fi

if ! built "libsndfile-${LIBSNDFILE_VERSION}"; then
  log "Building libsndfile ${LIBSNDFILE_VERSION}"
  unpack "libsndfile-${LIBSNDFILE_VERSION}.tar.xz" libsndfile
  # 1.2.2 declares a CMake minimum that CMake 4 no longer accepts as-is.
  cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="${PREFIX}" \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 "${CMAKE_ARGS[@]}" \
    -DBUILD_SHARED_LIBS=OFF -DBUILD_PROGRAMS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TESTING=OFF \
    -DENABLE_EXTERNAL_LIBS=OFF -DENABLE_MPEG=OFF -DINSTALL_MANPAGES=OFF -DENABLE_CPACK=OFF
  cmake --build build -j"${JOBS}"
  cmake --install build
  mark "libsndfile-${LIBSNDFILE_VERSION}"
fi

if [ "${OS}" = "linux" ] && ! built "openssl-${OPENSSL_VERSION}"; then
  log "Building OpenSSL ${OPENSSL_VERSION}"
  unpack "openssl-${OPENSSL_VERSION}.tar.gz" openssl
  case "${ARCH}" in
    x64) OPENSSL_TARGET="linux-x86_64" ;;
    arm64) OPENSSL_TARGET="linux-aarch64" ;;
  esac
  # /etc/ssl is where Debian, Ubuntu, Arch and Alpine keep their CA
  # certificates. Distributions that keep them elsewhere are covered by the
  # SSL_CERT_FILE the app sets at startup (see src/electron/main.ts).
  ./Configure "${OPENSSL_TARGET}" --prefix="${PREFIX}" --libdir=lib --openssldir=/etc/ssl \
    no-shared no-tests no-docs no-apps no-afalgeng
  make -j"${JOBS}"
  make install_sw
  mark "openssl-${OPENSSL_VERSION}"
fi

# ----------------------------------------------------------------------------
# Programs
# ----------------------------------------------------------------------------

# --disable-autodetect keeps configure from linking whatever happens to be on
# the build machine; everything the binary uses is named here. Each OS gets a
# TLS library for the https protocol (yt-dlp hands FFmpeg remote stream URLs to
# mux), and libopenmpt is C++, so its runtime is named for the linker.
case "${OS}" in
  mac)
    # iconv lives in its own system library on macOS, not libSystem.
    FFMPEG_ARGS=(--extra-libs="-lc++ -liconv"
      --enable-videotoolbox --enable-audiotoolbox --enable-securetransport)
    ;;
  linux)
    FFMPEG_ARGS=(--extra-libs="-lstdc++ -lpthread" --enable-pthreads --enable-version3 --enable-openssl)
    ;;
  win)
    FFMPEG_ARGS=(--extra-libs="-lstdc++ -lpthread" --enable-w32threads --enable-schannel)
    ;;
esac

FFMPEG_SRC="${WORK}/src/ffmpeg"
if ! built "ffmpeg-${FFMPEG_VERSION}"; then
  log "Building FFmpeg ${FFMPEG_VERSION}"
  unpack "ffmpeg-${FFMPEG_VERSION}.tar.xz" ffmpeg
  # LAME has no pkg-config file, so configure finds it only through these
  # paths; without them it finds whatever copy the build machine has, or none.
  ./configure --prefix="${PREFIX}" \
    --pkg-config-flags=--static \
    --extra-cflags="${CFLAGS} -I${PREFIX}/include" --extra-ldflags="${LDFLAGS} -L${PREFIX}/lib" \
    --disable-autodetect --disable-doc --disable-ffplay --disable-debug \
    --enable-gpl \
    --enable-libx264 --enable-libmp3lame --enable-libopenmpt \
    --enable-zlib --enable-bzlib --enable-iconv \
    "${FFMPEG_ARGS[@]}"
  make -j"${JOBS}"
  mark "ffmpeg-${FFMPEG_VERSION}"
fi

FLUIDSYNTH_SRC="${WORK}/src/fluidsynth"
if ! built "fluidsynth-${FLUIDSYNTH_VERSION}"; then
  log "Building FluidSynth ${FLUIDSYNTH_VERSION}"
  unpack "fluidsynth-${FLUIDSYNTH_VERSION}.tar.gz" fluidsynth
  # Rendering to stdout is all the app asks of FluidSynth, so every audio driver,
  # MIDI driver and optional library is off. libsndfile stays: it is what makes
  # `-F -` mean stdout. Options for another OS's drivers are simply ignored.
  cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="${PREFIX}" \
    -DCMAKE_PREFIX_PATH="${PREFIX}" "${CMAKE_ARGS[@]}" \
    -DBUILD_SHARED_LIBS=OFF \
    -Denable-libsndfile=ON -Denable-readline=OFF -Denable-sdl3=OFF -Denable-portaudio=OFF \
    -Denable-dbus=OFF -Denable-network=OFF -Denable-openmp=OFF -Denable-ladspa=OFF \
    -Denable-jack=OFF -Denable-pulseaudio=OFF -Denable-pipewire=OFF -Denable-midishare=OFF \
    -Denable-coreaudio=OFF -Denable-coremidi=OFF -Denable-framework=OFF \
    -Denable-alsa=OFF -Denable-oss=OFF -Denable-systemd=OFF -Denable-libinstpatch=OFF \
    -Denable-dsound=OFF -Denable-wasapi=OFF -Denable-waveout=OFF -Denable-winmidi=OFF
  cmake --build build -j"${JOBS}" --target fluidsynth
  mark "fluidsynth-${FLUIDSYNTH_VERSION}"
fi

# ----------------------------------------------------------------------------
# Output
# ----------------------------------------------------------------------------

BINARIES=("ffmpeg${EXE}" "ffprobe${EXE}" "fluidsynth${EXE}")

log "Collecting ${TARGET}"
rm -rf "${OUT}"
mkdir -p "${OUT}/licenses"
cp "${FFMPEG_SRC}/ffmpeg${EXE}" "${FFMPEG_SRC}/ffprobe${EXE}" "${OUT}/"
cp "${FLUIDSYNTH_SRC}/build/src/fluidsynth${EXE}" "${OUT}/"
for bin in "${BINARIES[@]}"; do
  if [ "${OS}" = "mac" ]; then
    strip -x "${OUT}/${bin}"
    # Apple Silicon refuses to run an unsigned binary, and stripping can
    # invalidate the signature the linker gave it; sign it again ad hoc.
    codesign --force --sign - "${OUT}/${bin}"
  else
    strip "${OUT}/${bin}"
  fi
done

SRC="${WORK}/src"
cp "${SRC}/ffmpeg/COPYING.GPLv2" "${OUT}/licenses/FFmpeg-COPYING.GPLv2"
cp "${SRC}/x264/COPYING" "${OUT}/licenses/x264-COPYING"
cp "${SRC}/lame/COPYING" "${OUT}/licenses/LAME-COPYING"
cp "${SRC}/libopenmpt/LICENSE" "${OUT}/licenses/libopenmpt-LICENSE"
cp "${SRC}/libsndfile/COPYING" "${OUT}/licenses/libsndfile-COPYING"
cp "${SRC}/fluidsynth/LICENSE" "${OUT}/licenses/FluidSynth-LICENSE"

FFMPEG_CONTAINS="FFmpeg ${FFMPEG_VERSION}, x264 ${X264_REVISION:0:8}, LAME ${LAME_VERSION}, libopenmpt ${LIBOPENMPT_VERSION}"
FFMPEG_LICENCE="GPL-2.0-or-later as a whole (FFmpeg built with --enable-gpl)"
FFMPEG_PARTS="LAME is LGPL-2.0-or-later, libopenmpt BSD-3-Clause"
if [ "${OS}" = "linux" ]; then
  cp "${SRC}/ffmpeg/COPYING.GPLv3" "${OUT}/licenses/FFmpeg-COPYING.GPLv3"
  cp "${SRC}/openssl/LICENSE.txt" "${OUT}/licenses/OpenSSL-LICENSE.txt"
  FFMPEG_CONTAINS="${FFMPEG_CONTAINS}, OpenSSL ${OPENSSL_VERSION}"
  FFMPEG_LICENCE="GPL-3.0-or-later as a whole (FFmpeg built with --enable-gpl --enable-version3, which OpenSSL's Apache-2.0 licence requires)"
  FFMPEG_PARTS="${FFMPEG_PARTS}, OpenSSL Apache-2.0"
fi

# Read by the app to show the versions it ships.
cat > "${OUT}/versions.json" <<EOF
{"ffmpeg": "${FFMPEG_VERSION}", "fluidsynth": "${FLUIDSYNTH_VERSION}"}
EOF

cat > "${OUT}/licenses/README.md" <<EOF
# Third-party programs bundled with ONIXPlayer

ONIXPlayer runs these as separate programs. They are not linked into
ONIXPlayer itself, which remains under its own MIT licence.

| Program | Contains | Licence |
|---|---|---|
| ffmpeg, ffprobe | ${FFMPEG_CONTAINS} | ${FFMPEG_LICENCE}; ${FFMPEG_PARTS} |
| fluidsynth | FluidSynth ${FLUIDSYNTH_VERSION}, libsndfile ${LIBSNDFILE_VERSION} | LGPL-2.1-or-later |

The complete corresponding source for each program is published with every
ONIXPlayer release, together with scripts/build-binaries.sh, which builds
these programs from it:

| Source | SHA-256 |
|---|---|
| ${FFMPEG_URL} | ${FFMPEG_SHA256} |
| ${X264_URL} | ${X264_SHA256} |
| ${LAME_URL} | ${LAME_SHA256} |
| ${LIBOPENMPT_URL} | ${LIBOPENMPT_SHA256} |
| ${LIBSNDFILE_URL} | ${LIBSNDFILE_SHA256} |
| ${FLUIDSYNTH_URL} | ${FLUIDSYNTH_SHA256} |
EOF
if [ "${OS}" = "linux" ]; then
  echo "| ${OPENSSL_URL} | ${OPENSSL_SHA256} |" >> "${OUT}/licenses/README.md"
fi

# Nothing outside the OS may be linked: a library the build machine happened to
# have means the binary only works on a machine that has it too.
log "Checking linkage"
for bin in "${BINARIES[@]}"; do
  case "${OS}" in
    mac)
      if otool -L "${OUT}/${bin}" | tail -n +2 | grep -v -E '^\s+(/usr/lib/|/System/Library/)'; then
        echo "error: ${bin} links a library outside the OS (above)" >&2
        exit 1
      fi
      ;;
    linux)
      if readelf -d "${OUT}/${bin}" | grep NEEDED; then
        echo "error: ${bin} is not fully static (above)" >&2
        exit 1
      fi
      ;;
    win)
      # Windows' own DLLs are fine; anything MSYS2 provides is not.
      for dll in $(objdump -p "${OUT}/${bin}" | sed -n 's/^\s*DLL Name: //p'); do
        if [ -f "${MINGW_PREFIX}/bin/${dll}" ]; then
          echo "error: ${bin} links ${dll}, which only MSYS2 provides" >&2
          exit 1
        fi
      done
      ;;
  esac
done

"${OUT}/ffmpeg${EXE}" -hide_banner -demuxers | grep -q libopenmpt
"${OUT}/ffmpeg${EXE}" -hide_banner -protocols | grep -q https
"${OUT}/fluidsynth${EXE}" --version | head -1

log "Done: ${OUT}"
ls -la "${OUT}"

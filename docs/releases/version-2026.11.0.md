# ONIXPlayer 2026.11.0

**Release Date:** November 2026
**Platform:** macOS, Windows, Linux
**Tech Stack:** Electron 45, Angular 22, TypeScript

---

## Overview

ONIXPlayer no longer needs a package manager. FFmpeg and FluidSynth now ship inside the
app on every platform, yt-dlp is downloaded from its official releases when it is first
needed, and the setup wizard has nothing left to install. First-run setup that could take
hours on a Mac Homebrew had to build from source now takes seconds.

---

## Features

### Everything ONIXPlayer needs, built in

Homebrew, winget, Chocolatey and the Linux package managers are gone from setup.
Instead:

- **FFmpeg 9.0.2 and FluidSynth 2.6.2 ship inside the app**, built from pinned,
  checksummed sources for each platform and architecture. They are self-contained:
  nothing else needs to be installed for them to run. An FFmpeg or FluidSynth
  already on the system is still used if the bundled copy is missing.
- **yt-dlp is downloaded on demand** from its official GitHub releases, checked
  against the release's published SHA-256 sums, and kept in the app's data folder.
  Open URL offers the download in place when yt-dlp is missing. yt-dlp uses
  ONIXPlayer's own JavaScript runtime for sites that need one.
- **Tracker modules are played by the bundled FFmpeg** through libopenmpt, so
  openmpt123 is no longer needed.
- **HTTPS streams use the operating system's certificates**: Secure Transport on
  macOS, SChannel on Windows, and the distribution's CA bundle on Linux.

### Choose your own SoundFont

No SoundFont ships with ONIXPlayer any more. The setup wizard's Components step and
Settings let you pick any `.sf2` file, and MIDI files can be opened as soon as one is
installed. Until then they are left out of the Open dialog and are not added to the
playlist.

### Licenses in About

The About window has a **Licenses** section listing everything ONIXPlayer ships:
ONIXPlayer itself, FFmpeg, FluidSynth and each library built into them, Electron,
Chromium and the JavaScript libraries. Clicking one opens its license text, and a link
leads to this release on GitHub, where the source code of the bundled programs is
published.

---

## Fixes

- The About window showed the version as 2026.0.1 whatever version was installed. It
  now reports the installed version.

---

## Upgrading

- **MIDI:** a SoundFont you added to ONIXPlayer before keeps working. A SoundFont
  ONIXPlayer found elsewhere on the system, such as one installed with FluidSynth
  through Homebrew or a Linux package, is no longer picked up automatically. Add it
  in Settings to keep playing MIDI.
- FFmpeg, FluidSynth and openmpt123 installed through a package manager for older
  versions of ONIXPlayer are no longer needed and can be uninstalled.

---

## Known Issues

- A few MO3 tracker modules, those with MP3- or Vorbis-compressed samples, do not
  play.
- Hardware video encoders (NVENC, AMF, Quick Sync, VA-API) are not available with the
  bundled FFmpeg on Windows and Linux; video is transcoded in software there. macOS
  keeps VideoToolbox.

---

## Development

- `npm run binaries` builds the bundled binaries into `vendor/bin/<os>-<arch>`.
  macOS builds natively, Linux in Alpine (musl, fully static) and Windows in MSYS2.
  Packaging fails if the binaries for the target are missing.
- The new **Bundled Binaries** workflow builds and checks all four targets, then
  packages the app for each platform without publishing and checks the packages. It
  is part of Release Readiness in place of the package-manager integration tests.
- Each release attaches the source tarballs the bundled binaries were built from, as
  the GPL and LGPL require. The licence texts ship outside `app.asar`, in
  `resources/licenses` and `resources/bin/licenses`, and packaging fails without them.
  The Linux FFmpeg is GPL-3.0-or-later because of OpenSSL. The others are
  GPL-2.0-or-later, and FluidSynth is LGPL-2.1-or-later.
- The repository no longer uses Git LFS.

---

## Downloads

| Platform               | File                                      |
| ---------------------- | ----------------------------------------- |
| macOS (Apple Silicon)  | ONIXPlayer-2026.11.0-arm64.dmg            |
| macOS (Intel)          | ONIXPlayer-2026.11.0-x64.dmg              |
| macOS (Apple Silicon)  | ONIXPlayer-2026.11.0-arm64-mac.zip        |
| macOS (Intel)          | ONIXPlayer-2026.11.0-x64-mac.zip          |
| Windows                | ONIXPlayer Setup 2026.11.0.exe            |
| Windows (portable)     | ONIXPlayer 2026.11.0.exe                  |
| Linux (AppImage)       | ONIXPlayer-2026.11.0.AppImage             |
| Linux (deb)            | onixlabs-media-player_2026.11.0_amd64.deb |

---

## Links

- [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)
- [ONIXLabs Website](https://onixlabs.io)

---

**License:** MIT

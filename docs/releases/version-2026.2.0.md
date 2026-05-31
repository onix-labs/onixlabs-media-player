# ONIXPlayer 2026.2.0

**Release Date:** May 2026
**Platform:** macOS, Windows, Linux
**Tech Stack:** Electron 39, Angular 21, TypeScript

---

## Overview

ONIXPlayer 2026.2.0 adds Intel Mac build support, refreshes the dependency stack to resolve all known security advisories, and fixes a video aspect-ratio control bug.

---

## New Features

### Intel Mac Support

- **Intel (x64) macOS builds** are now produced alongside Apple Silicon (arm64)
- Both architectures are shipped as `.dmg` and `.zip` artifacts
- Architecture requirements documented for the build pipeline

---

## Improvements

### Build & Distribution

- **Git LFS for SoundFonts** — bundled `.sf2` files are now tracked via Git LFS, reducing repository clone size

### Dependencies & Security

- **Resolved all Dependabot security advisories** (`npm audit`: 0 vulnerabilities)
- **Electron** updated to `39.8.10`, incorporating upstream Chromium security patches
- **Angular** updated to `21.2.x` (core/compiler `21.2.15`, build `21.2.13`)
- Transitive build-tooling dependencies patched, including `vite`, `undici`, `tar`, `minimatch`, `lodash`, `axios`, `ws`, `picomatch`, and `ajv`
- All updates landed within existing semver ranges — no breaking API changes

---

## Bug Fixes

- **Fixed the video aspect-ratio dropdown showing a stale "Default" value.** The control read its state through the optional video-outlet view child, whose `computed` cached `'default'` on first evaluation (before any video rendered) and never recomputed. The dropdown now reads the persisted setting directly, so it always reflects the active aspect mode (Default, Forced 4:3, Forced 16:9, or Fit to Screen).

---

## Downloads

| Platform               | File                                     |
| ---------------------- | ---------------------------------------- |
| macOS (Apple Silicon)  | ONIXPlayer-2026.2.0-arm64.dmg            |
| macOS (Intel)          | ONIXPlayer-2026.2.0-x64.dmg              |
| macOS (Apple Silicon)  | ONIXPlayer-2026.2.0-arm64-mac.zip        |
| macOS (Intel)          | ONIXPlayer-2026.2.0-x64-mac.zip          |
| Windows                | ONIXPlayer Setup 2026.2.0.exe            |
| Windows (portable)     | ONIXPlayer 2026.2.0.exe                  |
| Linux (AppImage)       | ONIXPlayer-2026.2.0.AppImage             |
| Linux (deb)            | onixlabs-media-player_2026.2.0_amd64.deb |

---

## Technical Notes

- `currentAspectMode` in `LayoutOutlet` now derives from `SettingsService.videoAspectMode()` — the same source of truth used by `VideoOutlet.aspectMode()` — making it reactive and always present
- Dependency tree re-resolved from a fresh `package-lock.json`; `package.json` ranges were unchanged

---

## Links

- [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)
- [ONIXLabs Website](https://onixlabs.io)

---

**License:** MIT

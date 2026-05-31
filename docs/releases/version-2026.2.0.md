# ONIXPlayer 2026.2.0

**Release Date:** May 2026
**Platform:** macOS, Windows, Linux
**Tech Stack:** Electron 39, Angular 21, TypeScript

---

## Overview

ONIXPlayer 2026.2.0 is a feature-packed release: a real-time **audio equalizer** and **video adjustments**, a redesigned media bar, reorganized settings, Intel Mac builds, and a full dependency/security refresh.

---

## New Features

### Audio Equalizer

- **10-band graphic equalizer** (31 Hz – 16 kHz, ±12 dB) applied to **all** audio — music, MIDI, and video
- Presets: Flat, Rock, Pop, Jazz, Bass Boost, Vocal, Treble Boost, plus Custom
- Real-time, GPU-light Web Audio processing; lives under **Settings → Audio Playback**

### Video Adjustments

- **Real-time colour and tone controls** applied to all video: Brightness, Contrast, Saturation, Hue, Soften, Grayscale, Sepia, and Invert
- Presets: Default, Vivid, Warm, Cool, Soft, Noir, Night, plus Custom
- Applied instantly via CSS filters (no re-encoding); lives at the bottom of **Settings → Video Playback**

### Video Flip

- **Flip video** horizontally, vertically, or both, from a dropdown in the media bar

### Intel Mac Support

- **Intel (x64) macOS builds** are now produced alongside Apple Silicon (arm64)
- Both architectures are shipped as `.dmg` and `.zip` artifacts
- Architecture requirements documented for the build pipeline

---

## Improvements

### Interface

- **Redesigned media bar** — visualization, aspect-ratio, subtitle, audio-track, and flip controls are now consistent dropdowns; the now-playing title moved beside them
- **Refreshed player controls** — new fullscreen (TV), miniplayer (picture-in-picture), and restore icons; squircle-cornered control groups; resized transport buttons
- **Reorganized settings** into clear media-type categories: Application, Appearance, Dependencies, Playback, Audio Playback, Audio Visualizations, Video Playback, Video Subtitles
- **Settings are tied to the default window mode** — settings can only be opened in the normal window, and fullscreen/miniplayer controls are disabled while settings are open

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
- Fixed video audio not being affected by audio processing — video audio is now routed through the same Web Audio graph as music and MIDI, so the equalizer applies to it.

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

- Equalizer and video adjustments are persisted settings groups (`equalizer`, `videoAdjustments`) with server-side validation and SSE-driven reactive updates
- Video audio is routed through Web Audio (`MediaElementSource → equalizer → destination`); video colour uses a CSS `filter` on the video element
- `currentAspectMode` in `LayoutOutlet` now derives from `SettingsService.videoAspectMode()` — the same source of truth used by `VideoOutlet.aspectMode()` — making it reactive and always present
- Dependency tree re-resolved from a fresh `package-lock.json`; `package.json` ranges were unchanged

---

## Links

- [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)
- [ONIXLabs Website](https://onixlabs.io)

---

**License:** MIT

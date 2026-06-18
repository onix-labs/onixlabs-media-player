# ONIXPlayer 2026.3.0

**Release Date:** June 2026
**Platform:** macOS, Windows, Linux
**Tech Stack:** Electron 39, Angular 21, TypeScript

---

## Overview

ONIXPlayer 2026.3.0 brings **internet media streaming and download** via `yt-dlp`, a substantially reworked **visualization system** — new visualizations, a rebuilt Water visualization, a simpler settings model — and a streamlined release pipeline.

---

## New Features

### Internet Media Streaming & Download

- **Stream and download internet media** directly in the player, powered by `yt-dlp`
- Play remote audio/video from a URL, or save it locally for offline playback

### New Visualizations

- **Spotlight** — a new audio visualization
- **Simple category** with **Blank** and **Logo** visualizations for a minimal, distraction-free display
- **Reactor** is now the first-load default visualization

### Global Render Resolution

- New **global render-resolution setting** controls visualization render quality across the app

---

## Improvements

### Visualizations

- **Rebuilt Water visualization** — frequency-bucket circular rings with layered, per-trail fading trails; log-scaled buckets and symmetry; rounded ring peaks; bass-triggered swirl reversal, hue jumps, and occasional flash; cross-faded hue transitions
- **Reorganized visualization categories** — finished the Signature category rename and added the Simple category
- **Simplified visualization settings** — per-visualization controls were removed and settings hard-coded for a cleaner, more consistent panel
- **Tuned waveforms** — lowered point count to 32 for Modern and Classic; slowed the waveform trail fade
- Fixed **Logo visualization sizing and pixelation**

### Build & Distribution

- **Releases are now published directly** instead of as drafts

---

## Removed

- **Spectre visualization** has been removed

---

## Downloads

| Platform               | File                                     |
| ---------------------- | ---------------------------------------- |
| macOS (Apple Silicon)  | ONIXPlayer-2026.3.0-arm64.dmg            |
| macOS (Intel)          | ONIXPlayer-2026.3.0-x64.dmg              |
| macOS (Apple Silicon)  | ONIXPlayer-2026.3.0-arm64-mac.zip        |
| macOS (Intel)          | ONIXPlayer-2026.3.0-x64-mac.zip          |
| Windows                | ONIXPlayer Setup 2026.3.0.exe            |
| Windows (portable)     | ONIXPlayer 2026.3.0.exe                  |
| Linux (AppImage)       | ONIXPlayer-2026.3.0.AppImage             |
| Linux (deb)            | onixlabs-media-player_2026.3.0_amd64.deb |

---

## Links

- [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)
- [ONIXLabs Website](https://onixlabs.io)

---

**License:** MIT

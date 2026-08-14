# ONIXPlayer 2026.7.0

**Release Date:** August 2026
**Platform:** macOS, Windows, Linux
**Tech Stack:** Electron 39, Angular 21, TypeScript

---

## Overview

ONIXPlayer 2026.7.0 expands what you can play and how visualizations feel — adding **tracker module playback** (Amiga Oktalyzer and 20+ classic module formats) and **configurable crossfade transitions** when switching between visualizations.

---

## New Features

### Tracker Module Playback

- Plays tracker module formats — **Oktalyzer (.okt)** plus **MOD, XM, S3M, IT**, and around 20 more — via libopenmpt's `openmpt123`, decoded to PCM and encoded to a cached MP3 by FFmpeg
- Mirrors the existing MIDI/FluidSynth pipeline: render → content-hashed disk cache → range-served, with both on-demand and pre-render-before-play paths
- **`openmpt123` is a first-class managed dependency** — detection, install/uninstall (Homebrew / apt / dnf / pacman; manual on Windows), and it appears in the setup wizard, dependency settings, and about credits
- The tracker render cache is cleared on startup (matching MIDI), so it never persists across sessions

### Crossfade Transitions for Visualizations

- Switching visualizations now plays a **transition instead of an instant swap** — each visualization renders into its own offscreen buffer and the visible canvas composites them, so the outgoing and incoming visualizations blend while both keep animating
- New **Crossfade Duration** setting: 500ms, 750ms, 1s (default), 1.5s, 2s
- New **Crossfade Style** setting: Fade (default), Zoom, Shrink, Blur, Random
- Both settings are persisted, with Electron-side validation and sanitization

---

## Improvements

### Playback

- Guarded the playback clock against auto-ending a track whose duration is not yet known, fixing on-demand-rendered tracks that could stop immediately

---

## Downloads

| Platform               | File                                     |
| ---------------------- | ---------------------------------------- |
| macOS (Apple Silicon)  | ONIXPlayer-2026.7.0-arm64.dmg            |
| macOS (Intel)          | ONIXPlayer-2026.7.0-x64.dmg              |
| macOS (Apple Silicon)  | ONIXPlayer-2026.7.0-arm64-mac.zip        |
| macOS (Intel)          | ONIXPlayer-2026.7.0-x64-mac.zip          |
| Windows                | ONIXPlayer Setup 2026.7.0.exe            |
| Windows (portable)     | ONIXPlayer 2026.7.0.exe                  |
| Linux (AppImage)       | ONIXPlayer-2026.7.0.AppImage             |
| Linux (deb)            | onixlabs-media-player_2026.7.0_amd64.deb |

---

## Links

- [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)
- [ONIXLabs Website](https://onixlabs.io)

---

**License:** MIT

# ONIXPlayer 2026.1.0

**Release Date:** March 2026
**Platform:** macOS, Windows, Linux
**Tech Stack:** Electron 39, Angular 21, TypeScript

---

## Overview

ONIXPlayer 2026.1.0 introduces a first-run setup wizard, soundfont selection for MIDI playback, and various stability improvements.

---

## New Features

### Setup Wizard

- **First-run configuration wizard** guides new users through initial setup
- Dependency installation (FFmpeg, FluidSynth) with progress feedback
- Bundled OPL3 soundfont installation option for immediate MIDI playback
- Automatic detection of existing installations

### Soundfont Selection

- **Multiple soundfont support** — install and switch between different .sf2 files
- Radio button selector in Settings to choose the active soundfont
- Real-time switching with automatic MIDI cache invalidation
- Soundfont changes take effect immediately without restarting playback

### Visualization Enhancements

- **Strobe frequency setting** for applicable visualizations
- Per-visualization strobe control in Settings

### Window Management

- **Standalone About window** — About ONIXPlayer opens in its own window
- Improved child window handling — closing main window properly closes Settings and About windows

---

## Improvements

### Performance

- **Fullscreen transition optimizations** for Windows — reduced GPU spikes during fullscreen toggle
- Visualization rendering paused during fullscreen transitions to prevent stuttering

### MIDI Playback

- **Fixed MIDI duration calculation** — proper handling of MIDI running status for accurate track lengths
- **Pre-rendering before playback** — MIDI files are synthesized before UI shows playing state
- **Playback state synchronization** — UI accurately reflects when audio actually starts

### Stability

- Fixed race condition where UI showed "playing" state before audio had loaded
- Fixed soundfont changes not affecting rendered MIDI output
- MIDI render cache properly invalidated on soundfont change and playback stop

---

## Bug Fixes

- Fixed bundled soundfont installation reporting false failures in setup wizard
- Fixed child windows (Settings, About) remaining open after main window closes
- Fixed MIDI files showing incorrect duration (e.g., 19 minutes instead of 2-3 minutes)
- Fixed browser caching preventing soundfont changes from taking effect

---

## Downloads

| Platform               | File                                     |
| ---------------------- | ---------------------------------------- |
| macOS (Apple Silicon)  | ONIXPlayer-2026.1.0-arm64.dmg            |
| macOS (Intel)          | ONIXPlayer-2026.1.0-x64.dmg              |
| macOS (Apple Silicon)  | ONIXPlayer-2026.1.0-arm64-mac.zip        |
| macOS (Intel)          | ONIXPlayer-2026.1.0-x64-mac.zip          |
| Windows                | ONIXPlayer Setup 2026.1.0.exe            |
| Windows (portable)     | ONIXPlayer 2026.1.0.exe                  |
| Linux (AppImage)       | ONIXPlayer-2026.1.0.AppImage             |
| Linux (deb)            | onixlabs-media-player_2026.1.0_amd64.deb |

---

## Technical Notes

- Added `/player/started` endpoint for accurate playback state synchronization
- Added `soundfont:changed` SSE event type for cache invalidation
- MIDI parser now correctly handles running status (consecutive channel messages with omitted status byte)
- Setup wizard state managed via `--first-run` command line flag

---

## Links

- [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)
- [ONIXLabs Website](https://onixlabs.io)

---

**License:** MIT

# ONIXPlayer 2026.6.0

**Release Date:** August 2026
**Platform:** macOS, Windows, Linux
**Tech Stack:** Electron 39, Angular 21, TypeScript

---

## Overview

ONIXPlayer 2026.6.0 focuses on **discretion and control** — a stronger Discreet mode, an optional mini-player on focus loss, and a configurable seek-bar behaviour — plus a refinement to the Reactor visualization's bass trigger.

---

## New Features

### Mini-Player on Focus Loss

- New **Mini-Player on Focus Loss** setting (Application settings) shows the mini-player automatically when the main window is hidden behind another window
- Disabled by default — the player stays in desktop mode unless you opt in

### Configurable Seek Bar Behavior

- New **Seek Bar Behavior** setting (Playback settings) with two modes:
  - **Seek on drop** (default): the seek only fires when the seek bar handle is released
  - **Seek on drag and drop**: playback follows the pointer with live seeks while dragging, gated to one in-flight request at a time so rapid movement doesn't stack up round-trips

---

## Improvements

### Discreet Mode

- **Ctrl/Cmd + D** now fully clears your tracks: it stops playback, clears the playlist, **clears recent files and playlists**, and **closes the window** — leaving no trace
- Previously it only stopped playback, cleared the playlist, and minimized the window
- The Discreet mode shortcut is now documented in the in-app Help topics

### Reactor Visualization

- The Reactor's bass trigger (which flips the swirl direction and jumps the palette) now **holds off for the first several seconds** after playback starts, instead of firing almost immediately

### Release Pipeline

- The GitHub release workflow now **creates the release up front** in a dedicated job, so the parallel per-platform build jobs only upload assets — eliminating the race where concurrent jobs failed with a 422 "already_exists" error

---

## Downloads

| Platform               | File                                     |
| ---------------------- | ---------------------------------------- |
| macOS (Apple Silicon)  | ONIXPlayer-2026.6.0-arm64.dmg            |
| macOS (Intel)          | ONIXPlayer-2026.6.0-x64.dmg              |
| macOS (Apple Silicon)  | ONIXPlayer-2026.6.0-arm64-mac.zip        |
| macOS (Intel)          | ONIXPlayer-2026.6.0-x64-mac.zip          |
| Windows                | ONIXPlayer Setup 2026.6.0.exe            |
| Windows (portable)     | ONIXPlayer 2026.6.0.exe                  |
| Linux (AppImage)       | ONIXPlayer-2026.6.0.AppImage             |
| Linux (deb)            | onixlabs-media-player_2026.6.0_amd64.deb |

---

## Links

- [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)
- [ONIXLabs Website](https://onixlabs.io)

---

**License:** MIT

# ONIXPlayer 2026.8.1

**Release Date:** August 2026
**Platform:** macOS, Windows, Linux
**Tech Stack:** Electron 43, Angular 21, TypeScript

---

## Overview

A patch release fixing a bug that made every icon in the interface disappear in 2026.8.0.

---

## Fixes

### Missing interface icons

Installing 2026.8.0 produced a window with **no icons at all** — play, pause, stop, next, eject and the rest.

The build emits resources referenced from stylesheets into a `media/` directory, so the icon font was requested from `/media/…`. `/media` is also the prefix of the internal media API, which since 2026.8.0 requires a per-session token, and a browser fetching a font from a stylesheet cannot attach one. Every icon-font request was rejected, and the font never loaded.

It affected packaged builds only — during development the assets are served by a different server that has no such route — and left stylesheets and scripts working, since those are not served from under that prefix.

Those resources are now emitted to `static/`, which the API does not cover. A test asserts the build cannot place assets anywhere the API would shadow them, so this cannot return unnoticed.

---

## Documentation

The README's visualization list has been brought up to date: it described thirteen visualizations under the old grouping, named Hawking by its former name, still listed a visualization that has been removed, and did not mention the Nostalgia group.

---

## Downloads

| Platform               | File                                     |
| ---------------------- | ---------------------------------------- |
| macOS (Apple Silicon)  | ONIXPlayer-2026.8.1-arm64.dmg            |
| macOS (Intel)          | ONIXPlayer-2026.8.1-x64.dmg              |
| macOS (Apple Silicon)  | ONIXPlayer-2026.8.1-arm64-mac.zip        |
| macOS (Intel)          | ONIXPlayer-2026.8.1-x64-mac.zip          |
| Windows                | ONIXPlayer Setup 2026.8.1.exe            |
| Windows (portable)     | ONIXPlayer 2026.8.1.exe                  |
| Linux (AppImage)       | ONIXPlayer-2026.8.1.AppImage             |
| Linux (deb)            | onixlabs-media-player_2026.8.1_amd64.deb |

---

## Links

- [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)
- [ONIXLabs Website](https://onixlabs.io)

---

**License:** MIT

# ONIXPlayer 2026.9.0

**Release Date:** September 2026
**Platform:** macOS, Windows, Linux
**Tech Stack:** Electron 43, Angular 21, TypeScript

---

## Overview

A small release: downloads from a URL now ask where to save, and the dependency
actions work again on macOS.

---

## Features

### Choose where a URL download is saved

**Download & Play** in the Open URL window used to write into the application's own
downloads directory, naming the file after the media title. Where the file went was
not shown and could not be changed.

It now opens the native **Save As** dialog first. Pick a folder and a filename, and
the download is written there and played from there once it finishes. Cancelling the
dialog downloads nothing and leaves the form as it was.

The download itself is still staged internally before being moved into place: the
final container is only known once yt-dlp has merged the video and audio streams or
extracted the audio, so the destination cannot be handed to it up front. The move
falls back to a copy when the destination is on a different volume from the staging
directory, so saving to an external disk or a network share works.

Streaming mode is unchanged — it saves nothing and so asks nothing.

---

## Fixes

### Dependency actions on macOS

Install, Update and Uninstall all failed on macOS with `spawn brew ENOENT`. An
application launched from Finder inherits launchd's `PATH`, which contains neither
Homebrew prefix, so Homebrew was never found and the package manager never ran. Only
a run started from a terminal ever worked.

Homebrew is now resolved to an absolute path before being started, and its prefix is
placed on the child process's `PATH` — brew shells out to its own prefix, so starting
it is not enough on its own.

Three smaller faults in the surrounding error handling are fixed alongside: a failed
**update** reported the hint for **install**, a missing Homebrew surfaced as "No
package manager found for darwin" rather than pointing at https://brew.sh, and the
Linux hint suggested installing when the failed operation was an update.

---

## Downloads

| Platform               | File                                     |
| ---------------------- | ---------------------------------------- |
| macOS (Apple Silicon)  | ONIXPlayer-2026.9.0-arm64.dmg            |
| macOS (Intel)          | ONIXPlayer-2026.9.0-x64.dmg              |
| macOS (Apple Silicon)  | ONIXPlayer-2026.9.0-arm64-mac.zip        |
| macOS (Intel)          | ONIXPlayer-2026.9.0-x64-mac.zip          |
| Windows                | ONIXPlayer Setup 2026.9.0.exe            |
| Windows (portable)     | ONIXPlayer 2026.9.0.exe                  |
| Linux (AppImage)       | ONIXPlayer-2026.9.0.AppImage             |
| Linux (deb)            | onixlabs-media-player_2026.9.0_amd64.deb |

---

## Links

- [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)
- [ONIXLabs Website](https://onixlabs.io)

---

**License:** MIT

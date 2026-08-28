# ONIXPlayer 2026.8.0

**Release Date:** August 2026
**Platform:** macOS, Windows, Linux
**Tech Stack:** Electron 43, Angular 21, TypeScript

---

## Overview

ONIXPlayer 2026.8.0 is a hardening and consolidation release. It closes the full security and quality audit — 41 issues covering the local HTTP server, dependency vulnerabilities, playback bugs and test coverage — and reorganises the visualization list around a new **Nostalgia** category, retiring the two large preset banks in favour of a much shorter, curated set.

---

## Security

The local HTTP server bound to `127.0.0.1` previously served every route with `Access-Control-Allow-Origin: *` and no authentication, so any web page visited in a browser could read local files, overwrite files through the playlist save route, and spawn helper processes.

- **Per-session authentication token** on every route
- **Host header validation**, closing DNS rebinding
- **Path containment** fixes on file-serving routes
- **Argument hardening** for `yt-dlp` invocation
- **Navigation guards and a Content Security Policy** in the renderer

## Dependencies

- Angular **21.2.20** and Electron **43.4.1**
- `npm audit` goes from 78 findings — 1 critical, 65 high — to **zero**

## Performance

- Bounded `ffprobe` and render concurrency, cache reuse, and streaming content hashes on the server side
- The visualization draw loop no longer forces a layout read every frame, idles when nothing is playing, and scales its most expensive operation to canvas size
- Settings writes are coalesced, so dragging a slider no longer stutters playback
- Hardware-encoder detection no longer blocks first paint

## Visualizations

### New Nostalgia category

- **Twirl**, **Warp**, **Ripple**, **Pulsar** and **Hallucia** are grouped under a new **Nostalgia** heading, sitting between Signature and Simple
- **Onix** moves to Bars & Waves; Signature keeps **Reactor** and **Spotlight**

### Retired preset banks

- The two large preset banks are gone. The list drops from 54 visualizations to a curated **17**
- **Ripple** is kept and rebuilt as a standalone visualization on the shared feedback engine
- The engine itself is trimmed to what the surviving visualizations use

### Pulsar

- The mirrored waveforms **reach twice as far**
- A bass transient now picks one of **two responses at random** — the existing spin reversal, or a new palette jump that inverts the waveforms between white and black
- The background follows the waveform colour
- Transients act at most **once in any ten-second window**, so each one reads as an event rather than a flicker

## Bug fixes

- Stale one-shot `canplay` listeners applying the previous seek to the next source
- Subtitle loads with no cancellation, leaking cues between videos
- Zoneless `ViewChild` reads leaving track dropdowns permanently empty
- Async failures swallowed with no user feedback

## Internal

- The drag-and-drop handling duplicated across four components, and the clock-sync machinery duplicated across both outlets, are extracted into shared code
- The WebVTT parser and sanitizer move out of a DOM-heavy component
- The SSE transport and track-selection cache move out of `ElectronService`
- **~3,500 lines of new tests** across twelve new spec files; 746 Angular and 467 Electron tests pass, with coverage collected and enforced on both sides
- Releases are now gated on a full test cadence that a tag cannot skip — nothing is published unless the tagged commit has a passing readiness run

---

## Downloads

| Platform               | File                                     |
| ---------------------- | ---------------------------------------- |
| macOS (Apple Silicon)  | ONIXPlayer-2026.8.0-arm64.dmg            |
| macOS (Intel)          | ONIXPlayer-2026.8.0-x64.dmg              |
| macOS (Apple Silicon)  | ONIXPlayer-2026.8.0-arm64-mac.zip        |
| macOS (Intel)          | ONIXPlayer-2026.8.0-x64-mac.zip          |
| Windows                | ONIXPlayer Setup 2026.8.0.exe            |
| Windows (portable)     | ONIXPlayer 2026.8.0.exe                  |
| Linux (AppImage)       | ONIXPlayer-2026.8.0.AppImage             |
| Linux (deb)            | onixlabs-media-player_2026.8.0_amd64.deb |

---

## Links

- [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)
- [ONIXLabs Website](https://onixlabs.io)

---

**License:** MIT

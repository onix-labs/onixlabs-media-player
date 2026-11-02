# ONIXPlayer 2026.10.0

**Release Date:** November 2026
**Platform:** macOS, Windows, Linux
**Tech Stack:** Electron 45, Angular 22, TypeScript

---

## Overview

Visualizations run far better on Windows, there is a new Album Art visualization,
seeking stream-copied video no longer leaves the audio ahead of the picture, and every
dependency is up to date.

---

## Features

### Album Art visualization

**Simple : Album Art** joins Blank and Logo. It shows the current track's embedded
artwork centred in the view, with rounded corners and a soft drop shadow, over a
blurred, saturated and translucent copy of itself that fills the view. Tracks without
artwork show a placeholder instead.

The artwork is extracted from the file by ffmpeg and cached, so returning to a track
does not extract it again. Remote streams show the placeholder.

---

## Performance

### Visualizations on Windows

Several visualizations, Pulsar above all, ran badly on Windows even on capable
hardware while running smoothly on macOS. A Windows display at 100% scaling exposes
every physical pixel and often refreshes at 144 Hz or more, so the same visualization
was doing several times the work.

- **Rendering is capped at 60 fps by default.** The cap can still be raised or removed
  in Settings.
- **Native resolution is capped at 1920x1080 worth of pixels**, scaled up smoothly
  beyond that. Album Art and Logo always stay at full resolution.
- **Pulsar, Onix, Reactor and Spotlight** keep their trails at no more than 1280x720,
  and blur their glow at reduced resolution. Pulsar and Onix redraw the current
  frame's lines at full resolution on top, so the lines stay sharp.
- **Each visualization draws straight to the screen**, rather than being copied to a
  second canvas every frame. Crossfades between visualizations are now blended by the
  compositor.
- **The fullscreen and miniplayer controls** no longer blur the visualization behind
  them on every frame.
- **Glass (acrylic) now defaults to off on Windows**, because Windows has to re-blur
  behind the window on every frame the visualization repaints. It can be turned back
  on in Settings > Appearance.

The new frame-rate and glass defaults apply to new installs. An existing install keeps
its current settings; change them in Settings to pick up the faster defaults.

### Elsewhere

- Settings changes are written to disk in batches rather than once per change, so
  dragging a slider no longer stalls playback.
- Logging, cross-volume downloads and menu updates no longer block the main process.
- A video with neutral adjustments is no longer filtered on every frame.

---

## Fixes

### Audio ahead of video after seeking

Seeking a remuxed or hybrid-transcoded video could leave the audio ahead of the video,
by anything from a couple of frames to a whole keyframe interval. The audio and video
now start from the same keyframe, and the seek bar and subtitles follow the position
playback actually lands on.

### Per-visualization settings

Changing two settings of a visualization in quick succession could lose the first
change, and briefly reset every other visualization's settings.

---

## Development

- Angular 22, Electron 45, TypeScript 6.0, Vitest 5 and ESLint 10. TypeScript 7 is not
  yet supported by Angular or typescript-eslint.
- Production dependencies report no known vulnerabilities.
- The development server runs on port 4300, so it no longer collides with other
  Angular apps on 4200.
- Development builds offer **View > Developer Tools** on every window. Production
  builds cannot open Developer Tools at all.

---

## Downloads

| Platform               | File                                      |
| ---------------------- | ----------------------------------------- |
| macOS (Apple Silicon)  | ONIXPlayer-2026.10.0-arm64.dmg            |
| macOS (Intel)          | ONIXPlayer-2026.10.0-x64.dmg              |
| macOS (Apple Silicon)  | ONIXPlayer-2026.10.0-arm64-mac.zip        |
| macOS (Intel)          | ONIXPlayer-2026.10.0-x64-mac.zip          |
| Windows                | ONIXPlayer Setup 2026.10.0.exe            |
| Windows (portable)     | ONIXPlayer 2026.10.0.exe                  |
| Linux (AppImage)       | ONIXPlayer-2026.10.0.AppImage             |
| Linux (deb)            | onixlabs-media-player_2026.10.0_amd64.deb |

---

## Links

- [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)
- [ONIXLabs Website](https://onixlabs.io)

---

**License:** MIT

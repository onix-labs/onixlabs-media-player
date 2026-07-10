# ONIXPlayer 2026.5.0

**Release Date:** July 2026
**Platform:** macOS, Windows, Linux
**Tech Stack:** Electron 39, Angular 21, TypeScript

---

## Overview

ONIXPlayer 2026.5.0 delivers a major overhaul of **seeking and streaming playback** — accurate seek behaviour, rock-solid A/V sync on streamed media, and a polished seek-loading experience — alongside the new **Particles visualization**, **media bar presets**, and refreshed playback controls.

---

## New Features

### Particles Visualization

- New **Particles** visualization (Waves category): two overlapping spiked circular waveforms that counter-rotate at the centre of the screen
- Waveform data repeats twice around each circle for two-fold symmetry
- Amplitude-driven **particles emit from the ring** — a mix of circles and squares, filled and outlined, in varying sizes, speeds, and intensities — flying outward and fading away
- Both waveforms and their particles **cycle through the colour palette** (starting red and blue) with vertical vivid-to-faded gradients

### Media Bar Presets

- **Audio presets** dropdown (equalizer: Flat, Rock, Pop, Jazz, Bass Boost, Vocal, Treble Boost) next to the visualization selector
- **Video presets** dropdown (Default, Vivid, Warm, Cool, Soft, Noir, Night) in the video controls group
- Selecting a preset automatically enables its feature if it was disabled

### Playback Controls

- New **Open URL button** in the playback controls (between Open and Shuffle) opens the internet media window
- **Volume icon** now reflects the level in five states: muted, off, low (1-33%), medium (34-66%), and high (67-100%)
- Volume slider widened so the control groups stay balanced

### Seek-Loading Experience

- Seeking streamed or transcoded video now **freezes the last frame** (slightly dulled) instead of going black while the stream reloads
- A custom **segmented spinner** animates over the frozen frame: a rotating ring of rounded wedges that sheds its segments in random order, each drifting away and fading before being replaced
- The system **waiting cursor** shows while a stream starts or a streamed seek is in flight

---

## Improvements

### Seeking

- Seek bar **drags now preview locally and seek once on release** — dragging across the end of the track no longer stops playback, and streams no longer restart on every mouse movement
- The seek bar now **visually reaches the end of its track** on short videos
- **Play after stop resumes at the seeked position** — drag the bar while stopped, press play, and playback starts there
- Stopping playback no longer briefly replays the first moments of audio

### Streaming & Sync

- **Fixed A/V desync when seeking streamed (DASH) media** — the video and audio streams are now aligned on the exact keyframe the seek lands on, at every resolution
- The seek bar **snaps to the landed keyframe**, so the displayed time matches the content
- The playback clock now **anchors to the media element's real position** — buffering stalls and pipeline startup delays no longer push the seek bar ahead of the content
- **Remote audio streams are now seekable** (stream reload with offset)
- Switching between audio and video tracks can no longer carry a stale playback position across

### Windowing

- **Smooth miniplayer transitions** — the player view now persists across desktop, fullscreen, and miniplayer modes, so media no longer stutters or reloads when switching
- **Default video fit** now scales the video to the nearest edge (never stretching, always filling), including upscaling smaller videos

---

## Downloads

| Platform               | File                                     |
| ---------------------- | ---------------------------------------- |
| macOS (Apple Silicon)  | ONIXPlayer-2026.5.0-arm64.dmg            |
| macOS (Intel)          | ONIXPlayer-2026.5.0-x64.dmg              |
| macOS (Apple Silicon)  | ONIXPlayer-2026.5.0-arm64-mac.zip        |
| macOS (Intel)          | ONIXPlayer-2026.5.0-x64-mac.zip          |
| Windows                | ONIXPlayer Setup 2026.5.0.exe            |
| Windows (portable)     | ONIXPlayer 2026.5.0.exe                  |
| Linux (AppImage)       | ONIXPlayer-2026.5.0.AppImage             |
| Linux (deb)            | onixlabs-media-player_2026.5.0_amd64.deb |

---

## Links

- [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)
- [ONIXLabs Website](https://onixlabs.io)

---

**License:** MIT

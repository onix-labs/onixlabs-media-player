# ONIXPlayer 2026.0.0

**Release Date:** March 2026
**Platform:** macOS, Windows, Linux
**Tech Stack:** Electron 39, Angular 21, TypeScript

---

## Overview

ONIXPlayer 2026.0.0 is the initial public release of a cross-platform media player featuring real-time audio visualizations, video playback with on-the-fly transcoding, and MIDI synthesis support.

---

## Features

### Audio Playback

- **10 unique visualizations** organized by category:
  - **Bars:** Analyzer, Spectre
  - **Waves:** Classic, Modern, Plasma, Infinity, Neon, Onix, Pulsar, Water
- All visualizations respond to music in real-time via Web Audio API
- Configurable visualization settings: sensitivity, trail intensity, line width, glow intensity, waveform smoothing, bar density
- Volume-independent visualizations (adjusting volume doesn't affect visual output)
- Fade-to-transparent effect when playback pauses or stops
- Supported formats: MP3, FLAC, WAV, OGG, M4A, AAC, WMA

### MIDI Playback

- Server-side synthesis via FluidSynth with SoundFont support
- Full visualization support (synthesized audio flows through Web Audio pipeline)
- Persistent render cache with content-hash filenames survives app restarts
- Automatic SoundFont detection from common system paths
- SoundFont management UI for installing and removing .sf2 files
- Supported formats: .mid, .midi

### Video Playback

- Native playback for MP4, M4V, WebM, OGG with HTTP range request seeking
- On-the-fly transcoding for MKV, AVI, MOV to fragmented MP4
- **Hardware acceleration** with automatic encoder detection:
  - VideoToolbox (macOS), NVENC (NVIDIA), Quick Sync (Intel), AMF (AMD), VAAPI (Linux)
  - Falls back to software encoding when hardware unavailable
- **Intelligent transcoding mode selection:**
  - Direct serve for native containers
  - Remux mode for compatible video with stream-copy
  - Hybrid mode for compatible video with incompatible audio (AC3, DTS, TrueHD)
  - Full transcode for incompatible video codecs
- UHD/4K optimized with real-time transcoding
- Configurable transcoding quality (CRF 18/23/28) and audio bitrate
- Aspect ratio modes: Default, 4:3, 16:9, Fit to Screen
- **Multi-track audio support** with language preferences
- **Subtitle support:**
  - Automatic detection of embedded subtitle tracks
  - On-the-fly conversion of SRT, ASS, SSA to WebVTT
  - External subtitle loading
  - Configurable appearance (font, size, color, shadow)
  - Preferred subtitle language setting

### Playlist Management

- Drag-and-drop file support with visual validation feedback
- Shuffle (Fisher-Yates algorithm) and repeat modes
- Auto-advance to next track
- Color-coded playback state indicators (playing/paused/stopped)
- Save/load playlists in ONIXPlayer Playlist (.opp) format
- Recent items history (10 files, 5 playlists)

### Window Modes

- **Desktop mode:** Full-featured interface with playlist panel
- **Fullscreen mode:** Immersive viewing with auto-hiding controls
- **Miniplayer mode:**
  - Compact 320x200 floating window (resizable to 640x400)
  - Always-on-top behavior
  - Magnetic edge snapping
  - Position and size memory
  - Draggable window surface

### Platform Integration

- File associations for all supported media formats
- Single-instance lock with file routing to existing window
- Native menu bar with platform-appropriate styling
- Platform-specific window blur effects (macOS vibrancy, Windows 11 acrylic)
- Auto-hiding menu bar on Windows/Linux

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Space | Play/Pause |
| Shift+Space | Stop |
| Tab | Toggle playlist panel |
| Ctrl/Cmd+D | Discreet mode (stop, clear, minimize) |
| Ctrl/Cmd+O | Open file |
| Ctrl/Cmd+Shift+O | Open playlist |
| Ctrl/Cmd+S | Save playlist |
| Escape | Exit fullscreen |
| Shift+Click Previous/Next | Skip backward/forward |

### Settings

- **Dependencies:** Install/uninstall FFmpeg and FluidSynth, manage SoundFonts
- **Appearance:** Glass effect, color scheme, window color (HSL sliders)
- **Visualizations:** Default visualization, frame rate cap, FFT size, per-visualization settings
- **Playback:** Volume, skip duration, preferred audio/subtitle language
- **Transcoding:** Quality preset, audio bitrate, hardware encoder selection

---

## System Requirements

### Dependencies

- **FFmpeg** (required) — Media transcoding and metadata extraction
- **FluidSynth** (optional) — MIDI playback support

### Installation

**macOS:**
```bash
brew install ffmpeg
brew install fluid-synth  # Optional, for MIDI
```

**Windows:**
```powershell
winget install Gyan.FFmpeg
choco install fluidsynth  # Optional, for MIDI
```

**Linux:**
```bash
# Debian/Ubuntu
sudo apt install ffmpeg fluidsynth

# Fedora
sudo dnf install ffmpeg fluidsynth

# Arch
sudo pacman -S ffmpeg fluidsynth
```

---

## Downloads

| Platform | File |
|----------|------|
| macOS | ONIXPlayer-2026.0.0.dmg |
| macOS (zip) | ONIXPlayer-2026.0.0-mac.zip |
| Windows | ONIXPlayer Setup 2026.0.0.exe |
| Windows (portable) | ONIXPlayer 2026.0.0.exe |
| Linux (AppImage) | ONIXPlayer-2026.0.0.AppImage |
| Linux (deb) | onixlabs-media-player_2026.0.0_amd64.deb |

---

## Technical Notes

- **Architecture:** Unified HTTP media server with Server-Sent Events (SSE) for real-time state synchronization
- **IPC footprint:** Minimal 22 IPC channels (vs typical 50+ in Electron apps)
- **State management:** Angular signals throughout for reactive, predictable state flow
- **Performance:** OnPush change detection strategy on all components
- **Codebase:** ~13,000 lines TypeScript, ~1,300 lines SCSS, ~670 lines HTML
- **Quality score:** 93/100 based on independent review

---

## Known Limitations

- Code signing not yet implemented (macOS/Windows may show security warnings)
- Auto-update not yet implemented
- Linux: Glass effect not supported

---

## Links

- [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)
- [ONIXLabs Website](https://onixlabs.io)

---

**License:** MIT

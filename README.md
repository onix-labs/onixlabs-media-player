![ONIX Labs](https://raw.githubusercontent.com/onix-labs/onixlabs-website/refs/heads/main/OnixLabs.Web/wwwroot/onixlabs/images/logo/logo-full-light.svg)

# ONIXPlayer

A beautiful, feature-rich media player for macOS, Windows, and Linux.

![Electron](https://img.shields.io/badge/Electron-39-47848F?logo=electron&logoColor=white)
![Angular](https://img.shields.io/badge/Angular-21-DD0031?logo=angular&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

---

## Features

### Audio Playback

Play your music with stunning real-time visualizations. ONIXPlayer supports MP3, FLAC, WAV, OGG, M4A, AAC, and WMA formats out of the box.

**10 Unique Visualizations:**

**Bars:**
- **Analyzer** — Configurable frequency spectrum bars with gradient colors
- **Spectre** — Mirrored bars with ONIXLabs brand color spectrum and smoke trail effects

**Waves:**
- **Classic** — Oscilloscope-style waveform with green glow and LCD ghosting
- **Modern** — Oscilloscope-style waveform with ONIXLabs brand color gradient
- **Plasma** — Dual waveforms with spectrum color cycling and zoom trails
- **Infinity** — Dual circular waveforms orbiting like binary black holes
- **Neon** — Counter-rotating crosses with cyan/magenta color swapping
- **Onix** — The ONIXLabs logo brought to life with pulsating conic gradient
- **Pulsar** — Pulsing concentric rings with curved waveforms
- **Water** — Water ripple effect with bass-reactive rotating waveforms

All visualizations respond to your music in real-time and can be customized with sensitivity, trail effects, line width, glow intensity, and more.

### MIDI Playback

ONIXPlayer can play MIDI files with full visualization support, synthesized using FluidSynth with high-quality SoundFonts.

### Video Playback

Watch videos in MP4, MKV, AVI, WebM, and MOV formats. Non-native formats are automatically transcoded on-the-fly for smooth playback.

### Playlist Management

- Drag and drop files to add them to your playlist
- Shuffle and repeat modes
- Auto-advances to the next track
- Skip forward/backward with Shift+click

### Fullscreen Mode

Immerse yourself in your media with a clean fullscreen experience. Controls appear when you move the mouse and hide automatically. Double-click to toggle fullscreen, or press Escape to exit.

### Miniplayer Mode

Keep your music visible while you work. The compact miniplayer floats above other windows, snaps to screen edges, and remembers its position.

### Customizable Settings

Fine-tune your experience with extensive settings:
- Visualization preferences (sensitivity, colors, effects)
- Playback options (volume, crossfade, skip duration)
- Video transcoding quality
- And more

---

## Requirements

ONIXPlayer requires the following to be installed on your system:

- **FFmpeg** — For media transcoding and metadata extraction
- **FluidSynth** — For MIDI playback (optional)

### macOS Installation

```bash
brew install ffmpeg
brew install fluid-synth  # Optional, for MIDI support
```

---

## Running in Development

```bash
npm install
npm run dev
```

## Building for Distribution

```bash
# macOS
npm run package:mac

# Windows
npm run package:win

# Linux
npm run package:linux
```

Build outputs are placed in the `release/` directory.

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Links

- [ONIXLabs Website](https://onixlabs.io)
- [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)

---

Built by **ONIXLabs**

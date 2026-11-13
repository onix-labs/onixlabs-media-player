![ONIX Labs](https://raw.githubusercontent.com/onix-labs/onixlabs-website/refs/heads/main/OnixLabs.Web/wwwroot/onixlabs/images/logo/logo-full-light.svg)

# ONIXPlayer

A beautiful, feature-rich media player for macOS, Windows, and Linux.

![Electron](https://img.shields.io/badge/Electron-39-47848F?logo=electron\&logoColor=white)
![Angular](https://img.shields.io/badge/Angular-21-DD0031?logo=angular\&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

***

## Features

### Audio Playback

Play your music with stunning real-time visualizations. ONIXPlayer supports MP3, FLAC, WAV, OGG, M4A, AAC, and WMA formats out of the box, with a built-in equalizer (Flat, Rock, Pop, Jazz, Bass Boost, Vocal, Treble Boost presets).

**17 Real-Time Visualizations**, grouped as they appear in the menu:

**Bars & Waves:**

* **Analyzer** — Vertical frequency-spectrum bars with a configurable gradient

* **Classic** — Oscilloscope-style waveform with a glow and LCD ghosting

* **Modern** — Frequency spectrum rendered in the ONIXLabs brand gradient

* **Plasma** — Dual horizontal waveforms cycling through the spectrum with expanding zoom trails

* **Infinity** — Two circular waveforms orbiting each other like binary black holes

* **Neon** — Two counter-rotating crosses whose cyan/magenta colours swap on intersection

* **Hawking** — Spiked circular waveforms shedding particles outward from the ring

* **Onix** — A pulsating ONIXLabs-gradient circle with a bass-reactive white core

**Signature:**

* **Reactor** — A concentric colour tower wrapped in spiralling frequency rings and bending horizontal waveforms; bass hits flip the swirl direction and jump the palette

* **Spotlight** — The Reactor tower and frequency rings arranged as a counter-spinning ambient scene

**Nostalgia:**

* **Twirl** — A rotating zoom about the centre, drawing the surface into itself

* **Warp** — Cubic radial distortion, holding the middle still while the rim shears away

* **Ripple** — The radius folded into bands that stand as concentric rings while content drifts out through them

* **Pulsar** — Mirrored curved waveforms wrapping a pulsing central circle; bass hits either reverse the spin or jump the palette and invert the waveforms

* **Hallucia** — Spectral differential rotation, winding bands into spiral filaments

**Simple:**

* **Logo** — The ONIXPlayer logo, centred and scaled (not audio-reactive)
* **Album Art** — The track's embedded album art, centred, or a placeholder when it has none (not audio-reactive)

* **Blank** — A "no visualization" option that renders nothing

All audio-reactive visualizations respond to your music in real-time and can be customized with sensitivity, trail effects, line width, glow intensity, and more.

### MIDI Playback

ONIXPlayer can play MIDI files with full visualization support, synthesized using FluidSynth with high-quality SoundFonts.

### Video Playback

Watch videos in MP4, M4V, MKV, AVI, WebM, and MOV formats. Non-native formats are automatically transcoded on-the-fly for smooth playback, with selectable transcoding quality and video adjustment presets (Vivid, Warm, Cool, Soft, Noir, Night).

### Internet Media

Open a URL to stream remote audio and video directly, without downloading it first.

### Playlist Management

* Drag and drop files to add them to your playlist

* Shuffle and repeat modes

* Auto-advances to the next track

* Skip forward/backward with Shift+click

* Recent files and playlists for quick access

### Fullscreen Mode

Immerse yourself in your media with a clean fullscreen experience. Controls appear when you move the mouse and hide automatically. Double-click to toggle fullscreen, or press Escape to exit.

### Miniplayer Mode

Keep your music visible while you work. The compact miniplayer floats above other windows, snaps to screen edges, and remembers its position — and can appear automatically when the main window loses focus.

### Customizable Settings

Fine-tune your experience with extensive settings:

* Visualization preferences (sensitivity, colors, effects)

* Playback options (volume, crossfade, skip duration, seek-bar behaviour, preferred audio/subtitle language)

* Audio equalizer and video adjustment presets

* Video transcoding quality

* And more

***

## Requirements

Nothing to install. ONIXPlayer ships with its own copies of:

* **FFmpeg** — For media transcoding, metadata extraction and tracker modules

* **FluidSynth** — For MIDI playback

**yt-dlp**, for playing media from websites, is downloaded on demand from its official releases when you first need it. MIDI playback needs a SoundFont, which you choose during setup or later in Settings.

***

## Running in Development

```bash
npm install
npm run binaries   # once: builds FFmpeg and FluidSynth into vendor/bin
npm run dev
```

`npm run binaries` builds from pinned, checksummed sources and takes a while the first time. It needs a C/C++ toolchain, make, cmake, pkg-config and nasm. On Linux it must run in Alpine, and on Windows in an MSYS2 UCRT64 shell; see `.github/workflows/binaries.yml` for the exact setup.

## Building for Distribution

```bash
# macOS
npm run package:mac

# Windows
npm run package:win

# Linux
npm run package:linux
```

Build outputs are placed in the `release/` directory. Packaging fails unless `vendor/bin` holds the binaries for the target being packaged.

***

## License

MIT License — see [LICENSE](LICENSE) for details.

***

## Links

* [ONIXLabs Website](https://onixlabs.io)

* [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)

***

Built by **ONIXLabs**

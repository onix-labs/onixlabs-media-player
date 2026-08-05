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

**13 Real-Time Visualizations:**

**Bars:**

* **Analyzer** — Vertical frequency-spectrum bars with a green-yellow-red intensity gradient

**Waves:**

* **Classic** — Oscilloscope-style waveform with a green glow and LCD ghosting

* **Modern** — The Classic waveform rendered in the ONIXLabs brand gradient (orange to green)

* **Plasma** — Dual horizontal waveforms cycling through the spectrum with expanding zoom trails

* **Infinity** — Two circular waveforms orbiting each other like binary black holes

* **Neon** — Two counter-rotating crosses whose cyan/magenta colours swap on intersection

* **Onix** — A pulsating ONIXLabs-gradient circle with a bass-reactive white core

* **Particles** — Dual spiked circular waveforms (red and blue) shedding particles outward from the ring

* **Pulsar** — Mirrored curved waveforms wrapping a pulsing central circle

* **Black Hole** — A gravitationally lensed accretion disk, infalling matter, and panning starfield around a black core

**Signature:**

* **Reactor** — A concentric colour tower wrapped in frequency rings and bending horizontal waveforms; bass hits flip the swirl direction and jump the palette

* **Spotlight** — The Reactor tower and frequency rings arranged as a counter-spinning ambient scene

**Simple:**

* **Logo** — The ONIXPlayer logo, centred and scaled (not audio-reactive)

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

ONIXPlayer requires the following to be installed on your system:

* **FFmpeg** — For media transcoding and metadata extraction

* **FluidSynth** — For MIDI playback (optional)

### macOS Installation

```bash
brew install ffmpeg
brew install fluid-synth  # Optional, for MIDI support
```

***

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

***

## License

MIT License — see [LICENSE](LICENSE) for details.

***

## Links

* [ONIXLabs Website](https://onixlabs.io)

* [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)

***

Built by **ONIXLabs**

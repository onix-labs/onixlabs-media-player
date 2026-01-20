# Media Player Development Summary

## What Works

### Audio Playback
- Native `<audio>` element with HTTP streaming
- Frequency visualizations via Web Audio API (`createMediaElementSource()`)
- 9 visualization modes sorted by category: Analyzer, Spectre (Bars); Pulsar, Water (Science); Onix (Team); Flare, Flux, Neon, Waveform (Waves)
- Visualization names display with category prefix (e.g., "Waves : Flare")
- Volume-independent visualizations with configurable settings:
  - Sensitivity (default 25%) - controls audio reactivity
  - Max frame rate cap (uncapped, 60/30/15 FPS) - reduces CPU/GPU usage
  - Trail intensity (default 50%) - controls visual trail persistence
  - Color shift (0-360°) - rotates all colors around the hue wheel
  - FFT size (256-4096, default 2048) - audio analysis resolution
- Transparent canvas backgrounds (CSS gradient shows through)
- Fade-to-black effect (~5 seconds) when playback is paused or stopped
- Instant volume control via GainNode (no latency, doesn't affect visualizations)
- Seek support via HTTP range requests (native formats) or stream reload (transcoded)

### MIDI Playback
- Server-side synthesis via FluidSynth with SoundFont support
- Conversion pipeline: FluidSynth (raw audio) -> FFmpeg (MP3 encoding) -> HTTP streaming
- Full visualization support (converted audio flows through same Web Audio API pipeline)
- MIDI duration parsing from binary file (reads tempo changes, calculates from tick positions)
- Automatic SoundFont detection from common paths
- Supported formats: `.mid`, `.midi`

### Video Playback
- Native `<video>` element with HTTP streaming
- Native formats (.mp4, .webm, .ogg) use HTTP range requests for seeking
- Non-native formats (.mkv, .avi, .mov) transcoded to fragmented MP4 on-the-fly
- Synchronized with server-side time tracking

### Playlist & Controls
- Server-managed playlist with shuffle (Fisher-Yates) and repeat modes
- Play/pause, next/previous, seek, volume all responsive
- Shift+click on previous/next buttons skips backward/forward by configurable duration
  - Works in both main controls and miniplayer controls
  - Button icons change dynamically when Shift is held (step → skip icons)
  - Previous/next buttons disabled with single track unless Shift held (skip by time always available)
  - Skip duration configurable in Settings > Playback (1-60 seconds, default 10)
- Auto-advance to next track when current ends
- Removing currently playing item auto-advances to next track (or stops if playlist empty)
- Shuffle, repeat, fullscreen, and miniplayer buttons disabled when no media loaded
- Drag-and-drop file support:
  - Playlist panel: adds files to playlist (auto-plays only if playlist was empty)
  - Idle state / visualization / video surface: adds files AND immediately starts playing

### Fullscreen Mode
- Fullscreen button in playback controls bar (or macOS green traffic light)
- Single-click visualization or video to toggle play/pause
- Double-click visualization or video to toggle fullscreen
- Escape key exits fullscreen
- Audio fullscreen: only visualization visible (no controls or toggles)
- Video fullscreen: clean video view with floating controls
- Floating playback controls appear on mouse movement, hide after 5s inactivity
- Gradient overlay for floating controls at bottom of screen

### Miniplayer Mode
- Compact floating window (320x200 default, max 640x400) for picture-in-picture viewing
- Always-on-top behavior keeps miniplayer visible above other windows
- Miniplayer button in playback controls (next to fullscreen button)
- Minimal overlay controls: previous, play/pause, next, exit miniplayer
- Controls auto-hide after configurable delay (same setting as fullscreen)
- Controls reappear on mouse movement, hide when mouse stops or leaves window
- macOS traffic lights hide/show with controls for cleaner appearance
- Entire window is draggable (except control buttons)
- Single-click toggles play/pause (distinguished from drag by 5px movement threshold)
- Magnetic edge snapping: window snaps to screen edges/corners with 10px gap
- Position/size memory: remembers last position and size, restores on re-entry
  - Bounds saved immediately when drag ends or window is resized
  - Stored in settings.json (windowState.miniplayerBounds)
  - No UI setting exposed; purely automatic behavior
- Only visualization or video shown (no playlist, media bar, or header)
- Fullscreen from miniplayer returns to miniplayer (not desktop) on exit
- Entering miniplayer from fullscreen properly waits for fullscreen exit transition

### UI Layout
- **Header**: Draggable area for window movement (macOS traffic lights region)
- **Media bar** (bottom of outlet): Visualization switcher (audio only) + playlist toggle
  - Always visible when not in fullscreen (even with no media loaded)
- **Playback controls**: Media title, transport controls, volume, fullscreen toggle
- Track title displayed in playback controls (format: "Artist - Title" or just title)

### Settings/Configuration
- Access via application menu: ONIXPlayer > Settings (Cmd+,) or Playback > Options
- Automatically exits fullscreen/miniplayer mode when entering settings
- Media continues playing in background while settings are open
- Settings persisted to `settings.json` in Electron userData folder:
  - Dev mode: `~/Library/Application Support/Electron/settings.json`
  - Packaged: `~/Library/Application Support/ONIXPlayer/settings.json`
- Real-time settings sync via SSE (`settings:updated` event)
- Settings fetched on service init (handles missed initial SSE event)
- Atomic file writes (write to temp, then rename) prevent corruption
- Current settings:
  - **Default Visualization**: Select which visualization plays on audio startup
    - Also updated when user changes visualization during playback (persists selection)
  - **Sensitivity**: Global sensitivity slider (0-100%) controlling visualization responsiveness
  - **Per-Visualization Sensitivity**: Expandable section with individual sliders for each visualization
    - Overrides global sensitivity when set
    - Reset button to restore to global value
    - Custom values highlighted in green
  - **Max Frame Rate**: Limit visualization FPS to reduce CPU/GPU usage
    - Options: Uncapped, 60 FPS, 30 FPS, 15 FPS
    - Default: Uncapped
  - **Trail Intensity**: Controls how long visual trails persist in visualizations
    - Slider from 0-100%
    - Default: 50%
    - Affects: Flare, Flux, Neon, Pulsar, Water, Waveform
    - Uses exponential scaling for smooth control (0=fast fade, 100=slow fade)
  - **Color Shift (Hue)**: Rotate all visualization colors around the color wheel
    - Slider from 0-360°
    - Default: 0° (original colors)
    - Affects all visualizations uniformly
    - Updates gradients and static colors in real-time
  - **FFT Size**: Audio analysis resolution for visualizations
    - Options: 256 (Fast), 512, 1024, 2048 (Default), 4096 (High Quality)
    - Higher values provide more frequency detail but use more CPU
    - Changes apply in real-time to the active visualization
  - **Bar Density**: Controls bar count in bar-based visualizations
    - Options: Low, Medium (Default), High
    - Analyzer: 48 / 96 / 144 bars
    - Spectre: 96 / 192 / 288 bars
    - Changes apply in real-time
  - **Server Port**: Configure the internal media server port (Application category)
    - 0 = auto-assign (default), or specify port 1024-65535
    - Changes require app restart to take effect
    - Reset button to restore auto-assign mode
  - **Controls Auto-Hide**: Configure fullscreen control bar auto-hide (Application category)
    - Slider from 0-30 seconds (0 = disabled, controls always visible)
    - Default: 5 seconds
    - Changes apply immediately
  - **Previous Track Threshold**: Configure "previous" button behavior (Playback category)
    - Slider from 0-10 seconds (0 = always go to previous track)
    - Default: 3 seconds (if past this point, restart current track instead)
    - Changes apply immediately
  - **Skip Duration**: How far to skip when Shift+clicking previous/next buttons (Playback category)
    - Slider from 1-60 seconds
    - Default: 10 seconds
    - Changes apply immediately
  - **Line Width**: Controls thickness of waveform lines (Visualization category)
    - Slider from 1-5px
    - Default: 2px
    - Affects: Waveform, Flare, Neon, Flux visualizations
  - **Glow Intensity**: Controls glow effect strength (Visualization category)
    - Slider from 0-100%
    - Default: 50%
    - Affects all visualizations with glow effects
  - **Default Volume**: Initial volume when application starts (Playback category)
    - Slider from 0-100%
    - Default: 50%
  - **Crossfade Duration**: Fade time for play/pause transitions (Playback category)
    - Slider from 0-500ms
    - Default: 100ms
    - Set to 0 to disable fading
  - **Video Quality**: Transcoding quality preset (Transcoding category)
    - Options: Low (CRF 28), Medium (CRF 23), High (CRF 18)
    - Default: Medium
  - **Audio Bitrate**: Transcoding audio bitrate (Transcoding category)
    - Options: 128, 192, 256, 320 kbps
    - Default: 192 kbps
- All visualization settings apply in real-time to the active visualization
- Extensible category-based UI with search filtering
- Categories ordered: Application, Playback, Transcoding, Visualization
- Scrollable settings panel for long content

### Infrastructure
- Electron 39 + Angular 21
- Unified HTTP media server for both audio and video
- Server-Sent Events (SSE) for real-time state synchronization
- FFprobe for metadata extraction
- Minimal IPC (6 channels vs 18 previously)
- ESLint with strict TypeScript rules:
  - `typedef` - explicit type annotations on all variables/parameters
  - `explicit-function-return-type` - return types on all functions
  - `explicit-member-accessibility` - public/private on all class members
  - `prefer-readonly` - readonly on never-reassigned members

## Architecture

### Unified HTTP Media Server

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           RENDERER (Angular)                            │
│                                                                         │
│  ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐       │
│  │  AudioOutlet    │   │  VideoOutlet    │   │  Playlist UI    │       │
│  │                 │   │                 │   │                 │       │
│  │  <audio> ──────────────────────────────────────────────────────┐    │
│  │     │           │   │  <video> ───────────────────────────┐   │    │
│  │     ▼           │   │                 │   │               │   │    │
│  │  MediaElement   │   └─────────────────┘   └───────────────│───│────┘
│  │  SourceNode     │                                         │   │     │
│  │     │           │                                         │   │     │
│  │     ▼           │   ┌─────────────────────────────────────│───│────┐│
│  │  AnalyserNode ──────│─► Canvas Visualization              │   │    ││
│  │     │           │   │   (Bars/Waveform/Tunnel/Water)      │   │    ││
│  │     ▼           │   └─────────────────────────────────────│───│────┘│
│  │  Destination    │                                         │   │     │
│  │  (speakers)     │                                         │   │     │
│  └─────────────────┘                                         │   │     │
│                                                              │   │     │
│  ┌───────────────────────────────────────────────────────────│───│────┐│
│  │                    ElectronService                        │   │    ││
│  │  • HTTP fetch() for commands ─────────────────────────────│───│──┐ ││
│  │  • EventSource for SSE state updates ◄────────────────────│───│──│─┘│
│  └───────────────────────────────────────────────────────────│───│──│──┘│
└──────────────────────────────────────────────────────────────│───│──│───┘
                                                               │   │  │
                           HTTP: /media/stream ────────────────┘   │  │
                           HTTP: /player/* ────────────────────────┘  │
                           SSE:  /events ─────────────────────────────┘
                                                               │
┌──────────────────────────────────────────────────────────────▼──────────┐
│                      MAIN PROCESS (Electron)                            │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                     UnifiedMediaServer                            │ │
│  │                                                                   │ │
│  │  HTTP Endpoints:                                                  │ │
│  │  ├── GET  /media/stream?path=...&t=...  (stream media)           │ │
│  │  ├── GET  /media/info?path=...          (ffprobe metadata)       │ │
│  │  ├── POST /player/play|pause|stop|seek  (playback control)       │ │
│  │  ├── GET  /playlist                     (get playlist state)     │ │
│  │  ├── POST /playlist/add|next|previous   (playlist control)       │ │
│  │  └── GET  /events                       (SSE stream)             │ │
│  │                                                                   │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐               │ │
│  │  │ SSEManager  │  │ Playlist    │  │ Playback    │               │ │
│  │  │ (broadcast) │  │ Manager     │  │ State       │               │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘               │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  IPC (minimal - 13 channels):                                          │
│  ├── dialog:openFile         (native file picker)                      │
│  ├── app:getServerPort       (get HTTP server port)                    │
│  ├── webUtils:getPathForFile (drag-and-drop paths)                     │
│  ├── window:enterFullscreen  (enter fullscreen mode)                   │
│  ├── window:exitFullscreen   (exit fullscreen mode)                    │
│  ├── window:isFullscreen     (query fullscreen state)                  │
│  ├── window:enterMiniplayer  (enter miniplayer mode)                   │
│  ├── window:exitMiniplayer   (exit miniplayer mode)                    │
│  ├── window:getViewMode      (query view mode: desktop/miniplayer/fs)  │
│  ├── window:getWindowPosition (get window position for drag)           │
│  ├── window:setWindowPosition (set position with magnetic snapping)    │
│  ├── window:setTrafficLightVisibility (macOS traffic light control)    │
│  └── window:saveMiniplayerBounds (persist miniplayer position/size)    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Audio Visualization Pipeline

```
<audio src="http://.../media/stream?path=...">
    │
    ▼
AudioContext.createMediaElementSource(audioElement)
    │
    ▼
MediaElementAudioSourceNode
    │
    ▼
AnalyserNode (fftSize=256, smoothing=0.85)
    │
    ├──► getByteFrequencyData() ──► Visualization Canvas
    │     (sensitivity, trail intensity, hue shift applied)
    │
    ▼
GainNode (volume control - keeps analyser at full signal)
    │
    ▼
AudioContext.destination (speakers)
```

### Key Files

**Electron Layer:**
- `src/electron/main.ts` - App initialization, IPC handlers, fullscreen window events, menu setup
- `src/electron/preload.ts` - IPC bridge (file dialog, server port, fullscreen control, menu events)
- `src/electron/unified-media-server.ts` - HTTP API, SSE, playlist management
- `src/electron/settings-manager.ts` - Persistent settings storage (JSON file in userData)
- `src/electron/application-menu.ts` - Native application menu for macOS/Windows/Linux

**Angular Services:**
- `src/angular/services/electron.service.ts` - HTTP client + SSE connection + fullscreen state + validated JSON parsing
- `src/angular/services/media-player.service.ts` - Playback orchestration (delegates to HTTP)
- `src/angular/services/settings.service.ts` - Settings state management with SSE sync
- `src/angular/services/file-drop.service.ts` - Centralized drag-and-drop file extraction with media type filtering

**Angular Components:**
- `src/angular/components/audio/audio-outlet/` - Audio + Web Audio API visualization
- `src/angular/components/video/video-outlet/` - Video playback
- `src/angular/components/playlist/` - Playlist UI panel
- `src/angular/components/layout/layout-controls/` - Playback controls
- `src/angular/components/miniplayer/` - Miniplayer overlay controls
- `src/angular/components/configuration/configuration-view/` - Settings UI with sidebar and panels

**Visualizations:**
- `src/angular/components/audio/audio-outlet/visualizations/` - Visualization implementations
  - `visualization.ts` - Base class with:
    - `name`, `category`, `sensitivity` properties
    - Fade-to-black support (paused/stopped state)
    - Trail intensity via `setTrailIntensity()` and `getFadeMultiplier()`
    - Hue shift via `setHueShift()`, `shiftHue()`, `shiftRgbColor()`
    - FFT size via `setFftSize()`, `getFftSize()`, `onFftSizeChanged()`
    - Bar density via `setBarDensity()`, `getBarDensity()`, `onBarDensityChanged()`
    - Color conversion utilities: `hslToRgb()`, `rgbToHsl()`
    - Three-layer drawing helpers: `drawPathWithLayers()`, `drawPointsWithLayers()` (glow, main, highlight)
  - `analyzer-visualization.ts` - Analyzer (category: Bars) - configurable frequency bars (48/96/144) with green-yellow-red gradient
  - `spectre-visualization.ts` - Spectre (category: Bars) - configurable frequency bars (96/192/288) with vertical mirroring (above/below center)
    - Dark center gradient fading to bright green at extremes, smoke trail effect
    - Optimized: pre-calculated bar heights and positions for main and glow passes
  - `pulsar-visualization.ts` - Pulsar (category: Science) - pulsing concentric rings with curved waveforms
    - Optimized: reuses trail/temp canvases, pre-allocated point arrays, cached HSL→RGB colors
  - `water-visualization.ts` - Water (category: Science) - water ripple effect with rotating waveforms, bass-reactive rotation
    - Optimized: reuses canvases, caches background gradient, pre-allocated arrays
  - `flare-visualization.ts` - Flare (category: Waves) - dual blue/red horizontal waveforms with tunnel zoom effect
  - `flux-visualization.ts` - Flux (category: Waves) - dual circular waveforms orbiting like binary black holes
    - Circles orbit around center (180° apart), trails expand outward creating spiral patterns
    - Colors cycle through spectrum (180° apart on color wheel), creating rainbow effect
    - Optimized: cached color values with hue threshold to avoid per-frame string generation
  - `neon-visualization.ts` - Neon (category: Waves) - rotating cyan/magenta waveforms with tunnel zoom
  - `waveform-visualization.ts` - Waveform (category: Waves) - oscilloscope-style with glow effect
  - `onix-visualization.ts` - Onix (category: Team) - ONIXLabs logo with three concentric circles
    - Outer ring: waveform-modulated circumference with brand color gradient and smoky trail effect
    - Middle ring: static white circle
    - Inner ring: black circle pulsating on deep bass/kick hits above threshold
    - Optimized: pre-computed trig lookup tables, flat typed arrays, cached bass calculation

## HTTP API Reference

### Media Streaming
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/media/stream?path={path}&t={time}` | Stream media file |
| GET | `/media/info?path={path}` | Get metadata via ffprobe |

### Playback Control
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/player/play` | Start/resume playback |
| POST | `/player/pause` | Pause playback |
| POST | `/player/stop` | Stop and reset |
| POST | `/player/seek` | Body: `{ time: number }` |
| POST | `/player/volume` | Body: `{ volume: number, muted?: boolean }` |
| GET | `/player/state` | Get current state |

### Playlist
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/playlist` | Get full playlist state |
| POST | `/playlist/add` | Body: `{ paths: string[] }` |
| DELETE | `/playlist/remove/{id}` | Remove item |
| DELETE | `/playlist/clear` | Clear all |
| POST | `/playlist/select/{id}` | Select and play |
| POST | `/playlist/next` | Next track |
| POST | `/playlist/previous` | Previous track |
| POST | `/playlist/shuffle` | Body: `{ enabled: boolean }` |
| POST | `/playlist/repeat` | Body: `{ enabled: boolean }` |

### Settings
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/settings` | Get all settings |
| PUT | `/settings/visualization` | Body: `{ defaultType?: string, sensitivity?: number, perVisualizationSensitivity?: object, maxFrameRate?: number, trailIntensity?: number, hueShift?: number, fftSize?: number, barDensity?: string, lineWidth?: number, glowIntensity?: number }` |
| PUT | `/settings/application` | Body: `{ serverPort?: number, controlsAutoHideDelay?: number }` |
| PUT | `/settings/playback` | Body: `{ defaultVolume?: number, crossfadeDuration?: number, previousTrackThreshold?: number }` |
| PUT | `/settings/transcoding` | Body: `{ videoQuality?: string, audioBitrate?: number }` |

### Server-Sent Events
| Endpoint | Events |
|----------|--------|
| GET `/events` | `playback:state`, `playback:time`, `playback:loaded`, `playback:ended`, `playback:volume`, `playlist:updated`, `playlist:items:added`, `playlist:items:removed`, `playlist:cleared`, `playlist:selection`, `playlist:mode`, `settings:updated`, `heartbeat` |

**Delta Events (efficient playlist updates):**
- `playlist:items:added` - Only sends added items with `{ items, startIndex, currentIndex }`
- `playlist:items:removed` - Only sends removed item ID with `{ id, removedIndex, currentIndex }`
- `playlist:cleared` - Simple notification with empty payload
- `playlist:updated` - Full state sent only on initial SSE connection for sync

## FFmpeg Commands

**Video Transcoding (non-native formats):**
```bash
# CRF value based on Video Quality setting: Low=28, Medium=23, High=18
# Audio bitrate from Audio Bitrate setting: 128k, 192k, 256k, 320k
ffmpeg -ss <time> -i <file> \
  -c:v libx264 -preset veryfast -tune zerolatency \
  -profile:v high -level 4.1 -pix_fmt yuv420p -crf <quality> \
  -c:a aac -b:a <bitrate>k -ar 48000 \
  -movflags frag_keyframe+empty_moov+default_base_moof \
  -f mp4 pipe:1
```

**MIDI to MP3 (via FluidSynth):**
```bash
# Audio bitrate from Audio Bitrate setting
fluidsynth -ni -g 1.0 -r 44100 <soundfont.sf2> <file.mid> -F - -O raw \
  | ffmpeg -f s16le -ar 44100 -ac 2 -i - \
    -c:a libmp3lame -b:a <bitrate>k -f mp3 pipe:1
```

**Metadata Extraction:**
```bash
ffprobe -v quiet -print_format json -show_format -show_streams <file>
```

## Commands

```bash
npm run dev          # Development mode with hot reload
npm run prod         # Production build + run
npm run build:all    # Build Angular + Electron
npm run package      # Package with electron-builder
```

## Dependencies
- Electron 39
- Angular 21
- FFmpeg/FFprobe (must be installed: `brew install ffmpeg`)
- FluidSynth (for MIDI playback: `brew install fluid-synth`)
- SoundFont file (FluidSynth includes VintageDreamsWaves-v2.sf2)
- tsx (for running TypeScript directly)
- ESLint + @typescript-eslint (strict type safety rules)
- src/electron/tsconfig.json uses `allowImportingTsExtensions` + `noEmit` for tsx compatibility
- src/electron/tsconfig.preload.json compiles preload.ts to ESM (required for Electron preload scripts)

## Architecture Benefits

1. **Unified playback** - Audio and video use same HTTP streaming approach
2. **Minimal IPC** - Only 13 channels vs 18 previously
3. **Server as source of truth** - Playlist and playback state managed centrally
4. **Instant volume** - Client-side control, no FFmpeg restart needed
5. **Native browser decoding** - Leverages Chromium's optimized media stack
6. **Visualization support** - `createMediaElementSource()` enables Web Audio API analysis
7. **Immersive fullscreen** - Clean viewing experience with auto-hiding controls
8. **OnPush change detection** - All Angular components use OnPush strategy for optimal performance
9. **Type-safe event handling** - Helper functions with instanceof checks for event targets
10. **Validated SSE parsing** - Safe JSON parsing with fallback values for robustness
11. **Shared services** - FileDropService centralizes drag-and-drop logic across components
12. **Optimized visualizations** - Color caching and pre-calculated values reduce per-frame overhead
13. **DRY visualization rendering** - Base class `drawPathWithLayers()` and `drawPointsWithLayers()` methods eliminate 450+ lines of duplicated three-layer drawing code
14. **Clean settings HTTP pattern** - Generic `updateSetting<T>()` helper reduces 400+ lines of repetitive fetch code to single-line calls
15. **Efficient playlist sync** - Delta SSE events (`playlist:items:added`, `playlist:items:removed`, `playlist:cleared`) reduce bandwidth for large playlists

## Code Documentation

The entire TypeScript codebase is documented with comprehensive TSDoc comments for human review and AI context:

**Electron Layer:**
- `src/electron/main.ts` - Main process entry, window creation, IPC handlers, media protocol
- `src/electron/preload.ts` - Context bridge API, IPC interface definitions
- `src/electron/unified-media-server.ts` - HTTP server, SSE manager, playlist logic, MIDI parsing

**Angular Application:**
- `src/main.ts` - Bootstrap entry point
- `src/angular/app.config.ts` - Application-wide providers
- `src/angular/app.routes.ts` - Route definitions
- `src/angular/types/electron.d.ts` - Type definitions with detailed interface docs

**Services:**
- `electron.service.ts` - HTTP/SSE bridge with reactive signals
- `media-player.service.ts` - High-level playback facade
- `settings.service.ts` - Settings state with SSE sync, HTTP fetch fallback, and generic `updateSetting<T>()` helper

**Components:**
- `root.ts` - Application shell, fullscreen/miniplayer handling, control visibility, window dragging, config mode switching
- `layout-header.ts`, `layout-controls.ts`, `layout-outlet.ts` - Layout components
- `audio-outlet.ts` - Web Audio API integration, visualization management, default viz and sensitivity from settings
- `video-outlet.ts` - Video playback, transcoding support
- `playlist.ts` - Playlist panel with drag-and-drop
- `configuration-view.ts` - Settings panel with category navigation and visualization config

**Visualizations:**
- `visualization.ts` - Base classes with sensitivity, fade, and resize support
- Individual visualizations documented with technical details and rendering approach

### Application Menu
- Native menu bar for macOS (app menu), Windows/Linux (File menu)
- File menu: Open (Cmd+O), Close (Cmd+W), with placeholders for URL, playlists, Save As
- View menu: Full Screen toggle, Visualizations submenu
- Playback menu: Play/Pause (Space), Shuffle/Repeat toggles, Options
- Window menu: Minimize, Zoom, macOS window management
- Help menu: About (opens GitHub page), placeholders for Help Topics
- Menu callbacks communicated via IPC to renderer for UI updates
- UI zoom disabled (zoomFactor: 1.0, keyboard shortcuts blocked, pinch-to-zoom disabled)
- Shuffle/Repeat menu checkboxes sync with actual state via callback mechanism

### Idle State
- When playlist is empty, layout-outlet displays placeholder with ONIXPlayer logo
- `hasPlaylistItems` computed signal gates audio/video outlet display
- File > Open adds files and immediately starts playback
- File > Close stops current track and removes it from playlist

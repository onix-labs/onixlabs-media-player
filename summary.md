# Media Player Development Summary

## What Works

### Audio Playback
- Native `<audio>` element with HTTP streaming
- Frequency visualizations via Web Audio API (`createMediaElementSource()`)
- 6 visualization modes: Frequency Bars, Waveform, Tunnel, Neon, Pulsar, Water
- Volume-independent visualizations with configurable sensitivity (default 25%)
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
- Skip buttons disabled when playlist has only one item
- Auto-advance to next track when current ends
- Drag-and-drop file support:
  - Playlist panel: adds files to playlist (auto-plays only if playlist was empty)
  - Idle state / visualization / video surface: adds files AND immediately starts playing

### Fullscreen Mode
- Fullscreen button in playback controls bar (or macOS green traffic light)
- Double-click visualization or video to toggle fullscreen
- Escape key exits fullscreen
- Audio fullscreen: only visualization visible (no controls or toggles)
- Video fullscreen: clean video view with floating controls
- Floating playback controls appear on mouse movement, hide after 5s inactivity
- Gradient overlay for floating controls at bottom of screen

### UI Layout
- **Header**: Draggable area for window movement (macOS traffic lights region)
- **Media bar** (bottom of outlet): Visualization switcher (audio only) + playlist toggle
  - Always visible when not in fullscreen (even with no media loaded)
- **Playback controls**: Media title, transport controls, volume, fullscreen toggle
- Track title displayed in playback controls (format: "Artist - Title" or just title)

### Settings/Configuration
- Access via application menu: ONIXPlayer > Settings (Cmd+,) or Playback > Options
- Media continues playing in background while settings are open
- Settings persisted to `settings.json` in Electron userData folder:
  - Dev mode: `~/Library/Application Support/Electron/settings.json`
  - Packaged: `~/Library/Application Support/ONIXPlayer/settings.json`
- Real-time settings sync via SSE (`settings:updated` event)
- Settings fetched on service init (handles missed initial SSE event)
- Atomic file writes (write to temp, then rename) prevent corruption
- Current settings:
  - **Default Visualization**: Select which visualization plays on audio startup
- Extensible category-based UI with search filtering

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
│  IPC (minimal - 6 channels):                                           │
│  ├── dialog:openFile         (native file picker)                      │
│  ├── app:getServerPort       (get HTTP server port)                    │
│  ├── webUtils:getPathForFile (drag-and-drop paths)                     │
│  ├── window:enterFullscreen  (enter fullscreen mode)                   │
│  ├── window:exitFullscreen   (exit fullscreen mode)                    │
│  └── window:isFullscreen     (query fullscreen state)                  │
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
    ├──► getByteFrequencyData() ──► Visualization Canvas (sensitivity-scaled)
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
- `src/angular/services/electron.service.ts` - HTTP client + SSE connection + fullscreen state
- `src/angular/services/media-player.service.ts` - Playback orchestration (delegates to HTTP)
- `src/angular/services/settings.service.ts` - Settings state management with SSE sync

**Angular Components:**
- `src/angular/components/audio/audio-outlet/` - Audio + Web Audio API visualization
- `src/angular/components/video/video-outlet/` - Video playback
- `src/angular/components/playlist/` - Playlist UI panel
- `src/angular/components/layout/layout-controls/` - Playback controls
- `src/angular/components/configuration/configuration-view/` - Settings UI with sidebar and panels

**Visualizations:**
- `src/angular/components/audio/audio-outlet/visualizations/` - Visualization implementations
  - `visualization.ts` - Base class with `name`, `category`, `sensitivity`, and fade-to-black support
  - `bars-visualization.ts` - Frequency Bars (category: frequency) - 96 bars mapped evenly across frequency bins
  - `waveform-visualization.ts` - Waveform (category: waveform) - oscilloscope-style with glow effect
  - `tunnel-visualization.ts` - Tunnel (category: waveform) - dual red/blue waveforms with zoom effect
  - `neon-visualization.ts` - Neon (category: waveform) - rotating cyan/magenta waveforms with tunnel zoom
  - `pulsar-visualization.ts` - Pulsar (category: space) - pulsing concentric rings with curved waveforms
    - Optimized: reuses trail/temp canvases (vs allocating per frame), pre-allocated point arrays, cached HSL→RGB colors
  - `water-visualization.ts` - Water (category: ambience) - water ripple effect with rotating waveforms, bass-reactive rotation
    - Optimized: reuses canvases, caches background gradient (re-renders only on hue change), pre-allocated arrays

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
| PUT | `/settings/visualization` | Body: `{ defaultType: string }` |

### Server-Sent Events
| Endpoint | Events |
|----------|--------|
| GET `/events` | `playback:state`, `playback:time`, `playback:loaded`, `playback:ended`, `playback:volume`, `playlist:updated`, `playlist:selection`, `playlist:mode`, `settings:updated`, `heartbeat` |

## FFmpeg Commands

**Video Transcoding (non-native formats):**
```bash
ffmpeg -ss <time> -i <file> \
  -c:v libx264 -preset veryfast -tune zerolatency \
  -profile:v high -level 4.1 -pix_fmt yuv420p -crf 23 \
  -c:a aac -b:a 192k -ar 48000 \
  -movflags frag_keyframe+empty_moov+default_base_moof \
  -f mp4 pipe:1
```

**MIDI to MP3 (via FluidSynth):**
```bash
fluidsynth -ni -g 1.0 -r 44100 <soundfont.sf2> <file.mid> -F - -O raw \
  | ffmpeg -f s16le -ar 44100 -ac 2 -i - \
    -c:a libmp3lame -b:a 192k -f mp3 pipe:1
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
2. **Minimal IPC** - Only 6 channels vs 18 previously
3. **Server as source of truth** - Playlist and playback state managed centrally
4. **Instant volume** - Client-side control, no FFmpeg restart needed
5. **Native browser decoding** - Leverages Chromium's optimized media stack
6. **Visualization support** - `createMediaElementSource()` enables Web Audio API analysis
7. **Immersive fullscreen** - Clean viewing experience with auto-hiding controls

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
- `settings.service.ts` - Settings state with SSE sync and HTTP fetch fallback

**Components:**
- `root.ts` - Application shell, fullscreen handling, control visibility, config mode switching
- `layout-header.ts`, `layout-controls.ts`, `layout-outlet.ts` - Layout components
- `audio-outlet.ts` - Web Audio API integration, visualization management, default viz from settings
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

### Idle State
- When playlist is empty, layout-outlet displays placeholder with ONIXPlayer logo
- `hasPlaylistItems` computed signal gates audio/video outlet display
- File > Open adds files and immediately starts playback
- File > Close stops current track and removes it from playlist

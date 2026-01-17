# Media Player Development Summary

## What Works

### Audio Playback
- Native `<audio>` element with HTTP streaming
- Frequency visualizations via Web Audio API (`createMediaElementSource()`)
- 5 visualization modes: Frequency Bars, Waveform, Tunnel, Pulsar, Ambience Water 2
- Volume-independent visualizations with configurable sensitivity (default 25%)
- Transparent canvas backgrounds (CSS gradient shows through)
- Instant volume control via GainNode (no latency, doesn't affect visualizations)
- Seek support via HTTP range requests (native formats) or stream reload (transcoded)

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
- Drag-and-drop file support

### Infrastructure
- Electron 39 + Angular 21
- Unified HTTP media server for both audio and video
- Server-Sent Events (SSE) for real-time state synchronization
- FFprobe for metadata extraction
- Minimal IPC (3 channels vs 18 previously)
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
│  IPC (minimal - 3 channels):                                           │
│  ├── dialog:openFile      (native file picker)                         │
│  ├── app:getServerPort    (get HTTP server port)                       │
│  └── webUtils:getPathForFile (drag-and-drop paths)                     │
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
- `electron/main.ts` - App initialization, minimal IPC handlers
- `electron/preload.ts` - IPC bridge (3 methods only)
- `electron/unified-media-server.ts` - HTTP API, SSE, playlist management

**Angular Services:**
- `src/app/services/electron.service.ts` - HTTP client + SSE connection
- `src/app/services/media-player.service.ts` - Playback orchestration (delegates to HTTP)

**Angular Components:**
- `src/app/components/audio/audio-outlet/` - Audio + Web Audio API visualization
- `src/app/components/video/video-outlet/` - Video playback
- `src/app/components/playlist/` - Playlist UI panel
- `src/app/components/layout/layout-controls/` - Playback controls

**Visualizations:**
- `src/app/components/audio/audio-outlet/visualizations/` - Visualization implementations
  - `visualization.ts` - Base class with `name`, `category`, and `sensitivity` properties
  - `bars-visualization.ts` - Frequency Bars (category: frequency) - 96 bars mapped evenly across frequency bins
  - `waveform-visualization.ts` - Waveform (category: waveform)
  - `tunnel-visualization.ts` - Tunnel (category: waveform)
  - `water-visualization.ts` - Pulsar (category: ambience) - tunnel zoom, rotating waveforms, cycling colors
  - `water2-visualization.ts` - Ambience Water 2 (category: ambience)

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

### Server-Sent Events
| Endpoint | Events |
|----------|--------|
| GET `/events` | `playback:state`, `playback:time`, `playback:loaded`, `playback:ended`, `playback:volume`, `playlist:updated`, `playlist:selection`, `playlist:mode`, `heartbeat` |

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
- tsx (for running TypeScript directly)
- ESLint + @typescript-eslint (strict type safety rules)
- electron/tsconfig.json uses `allowImportingTsExtensions` + `noEmit` for tsx compatibility

## Architecture Benefits

1. **Unified playback** - Audio and video use same HTTP streaming approach
2. **Minimal IPC** - Only 3 channels vs 18 previously
3. **Server as source of truth** - Playlist and playback state managed centrally
4. **Instant volume** - Client-side control, no FFmpeg restart needed
5. **Native browser decoding** - Leverages Chromium's optimized media stack
6. **Visualization support** - `createMediaElementSource()` enables Web Audio API analysis

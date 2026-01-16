# Media Player Development Summary

## What Works

### Audio Playback
- MP3 files play successfully with audio output
- Frequency bars visualizer displays correctly
- Controls (play/pause, next/previous, seek, volume) are responsive (~150ms latency)
- Playlist with shuffle (Fisher-Yates) and repeat modes
- Auto-advance to next track when current ends

### Infrastructure
- Electron + Angular 21 integration
- FFmpeg for media probing (metadata extraction)
- IPC communication between main process and renderer
- Custom `media://` protocol registered for serving local files
- Autoplay policy disabled for audio

## What Doesn't Work

### Video Playback
Multiple approaches tried, none successful:

1. **MJPEG Frame Streaming** (original approach)
   - FFmpeg outputs MJPEG frames via IPC
   - Canvas renders each frame
   - Issues: Flickering, jitter, A/V desync, high latency

2. **Native `<video>` with `media://` protocol**
   - Register custom protocol to serve local files
   - Use HTML5 video element directly
   - Issue: Video doesn't load/play (format compatibility?)

3. **WebM Streaming via MediaSource API** (current approach)
   - FFmpeg transcodes to WebM (VP9 + Opus) with `-dash 1`
   - Chunks sent via IPC to renderer
   - MediaSource API creates blob URL, appends chunks
   - Issue: Video still doesn't play

## Architecture

```
[Angular Component] → [Service] → [Preload IPC] → [Main Process] → [FFmpeg]
                                       ↓
[Audio/Video Data] ← [IPC Events] ← [Streaming]
```

### Key Files

**Electron Layer:**
- `electron/main.ts` - Main process, IPC handlers, media:// protocol
- `electron/preload.ts` - IPC bridge (contextBridge)
- `electron/ffmpeg-manager.ts` - FFmpeg process spawning, streaming

**Angular Services:**
- `src/app/services/electron.service.ts` - Wraps IPC, exposes Observables
- `src/app/services/playlist.service.ts` - Playlist state, shuffle, repeat
- `src/app/services/media-player.service.ts` - Playback orchestration

**Angular Components:**
- `src/app/components/audio/audio-outlet/` - Audio visualizer (Web Audio API)
- `src/app/components/video/video-outlet/` - Video renderer (currently MediaSource)
- `src/app/components/playlist/` - Playlist UI panel
- `src/app/components/layout/layout-controls/` - Playback controls
- `src/app/components/layout/layout-outlet/` - Main layout

## Current FFmpeg Commands

**Audio:**
```bash
ffmpeg -re -ss <time> -i <file> -f s16le -acodec pcm_s16le -ar 44100 -ac 2 -af volume=<vol> pipe:1
```

**Video (current - not working):**
```bash
ffmpeg -re -ss <time> -i <file> -c:v libvpx-vp9 -c:a libopus -b:v 2M -b:a 128k -f webm -dash 1 pipe:1
```

## Ideas to Try Next

1. **Transcode to temp file first**
   - FFmpeg writes complete WebM/MP4 to temp file
   - Serve via media:// protocol after transcoding completes
   - Downside: Delay before playback starts

2. **Use fragmented MP4 (fMP4) instead of WebM**
   - Better MediaSource compatibility
   - `ffmpeg -movflags frag_keyframe+empty_moov+default_base_moof`

3. **Local HTTP server**
   - Run express/http server in main process
   - Serve files or FFmpeg stream via HTTP
   - Video element uses http://localhost:PORT/file URL

4. **Check Chromium codec support**
   - Verify VP9/Opus codecs are available
   - Try H.264/AAC in MP4 container instead

5. **Debug MediaSource**
   - Add logging to see if chunks are being appended
   - Check for errors in sourceBuffer
   - Verify MIME type matches actual stream

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

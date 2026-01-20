# Configuration TODO

This document outlines potential configurable items identified in the codebase that could be exposed to users through a settings interface.

## Already Configurable

- **Default Visualization** - User can set their preferred visualization via settings
- **Global Sensitivity** - Master sensitivity slider affecting all visualizations
- **Per-Visualization Sensitivity** - Individual sensitivity overrides for each visualization type
- **Max Frame Rate** - Limit visualization FPS (uncapped, 60, 30, or 15) to reduce CPU/GPU usage
- **Trail Intensity** - Controls how long visual trails persist in visualizations (0-100%)
- **Color Shift (Hue)** - Rotate all visualization colors around the color wheel (0-360°)
- **Server Port** - Configure internal media server port (0 = auto, or 1024-65535). Requires restart.
- **Controls Auto-Hide** - Configurable delay for fullscreen control bar auto-hide (0=disabled, 1-30s)
- **Previous Track Threshold** - Time before "previous" restarts vs goes to previous track (0-10s, default 3s)
- **FFT Size** - Audio analysis resolution (256, 512, 1024, 2048, 4096). Higher values = more detail but more CPU usage
- **Bar Density** - Controls bar count in Analyzer (48/96/144) and Spectre (96/192/288) visualizations (Low/Medium/High)
- **Line Width** - Controls thickness of waveform lines (1-5px, default 2px)
- **Glow Intensity** - Controls glow effect strength on visualizations (0-100%)
- **Default Volume** - Initial volume level when app starts (0-100%, default 50%)
- **Crossfade Duration** - Fade time for play/pause transitions (0-500ms, default 100ms)
- **Video Quality** - Transcoding quality preset (Low/Medium/High)
- **Audio Bitrate** - Transcoding audio bitrate (128/192/256/320 kbps)

## Server Settings

| Setting | Current Value | Location | Notes |
|---------|---------------|----------|-------|
| HTTP Port | 3000 | `src/electron/server/server.ts` | Hardcoded server port |
| Heartbeat Interval | 30000ms | `src/electron/server/server.ts` | WebSocket keep-alive interval |

## Playback Behavior

| Setting | Current Value | Location | Notes |
|---------|---------------|----------|-------|
| ~~Previous Track Threshold~~ | ✓ Configurable | Settings | Time before "previous" restarts vs goes to previous track |
| ~~Default Volume~~ | ✓ Configurable | Settings | Initial volume on startup (default 50%) |
| ~~Crossfade Duration~~ | ✓ Configurable | Settings | Fade time for play/pause transitions (default 100ms) |

## Audio/Video Transcoding

| Setting | Current Value | Location | Notes |
|---------|---------------|----------|-------|
| ~~Video Quality~~ | ✓ Configurable | Settings | Quality preset (Low/Medium/High maps to CRF 28/23/18) |
| ~~Audio Bitrate~~ | ✓ Configurable | Settings | Bitrate selection (128/192/256/320 kbps) |

## Visualization Global Settings

| Setting | Current Value | Location | Notes |
|---------|---------------|----------|-------|
| ~~Animation Frame Rate~~ | ✓ Configurable | Settings | User can cap FPS (uncapped, 60, 30, 15) |
| ~~Global Sensitivity Multiplier~~ | ✓ Configurable | Settings | Master sensitivity control |

## Per-Visualization Parameters

### Analyzer (Bars)

| Setting | Current Value | Location | Notes |
|---------|---------------|----------|-------|
| FFT Size | 2048 | `analyzer-visualization.ts` | Frequency resolution |
| Bar Count | 64 | `analyzer-visualization.ts` | Number of frequency bars |
| Bar Gap | 2px | `analyzer-visualization.ts` | Space between bars |
| Bar Radius | 4px | `analyzer-visualization.ts` | Corner rounding |
| Sensitivity | 1.0 | `analyzer-visualization.ts` | Audio reactivity |

### Waveform (Waveform Classic)

| Setting | Current Value | Location | Notes |
|---------|---------------|----------|-------|
| FFT Size | 2048 | `waveform-visualization.ts` | Sample resolution |
| Line Width | 2px | `waveform-visualization.ts` | Waveform thickness |
| Glow Blur | 15px | `waveform-visualization.ts` | Glow effect radius |
| Trail Length | 5 frames | `waveform-visualization.ts` | Ghost trail count |
| Trail Opacity Decay | 0.6 | `waveform-visualization.ts` | Trail fade rate |
| Sensitivity | 1.0 | `waveform-visualization.ts` | Audio reactivity |

### Spectre (Waveform Modern)

| Setting | Current Value | Location | Notes |
|---------|---------------|----------|-------|
| FFT Size | 512 | `spectre-visualization.ts` | Frequency resolution |
| Total Bars | 192 | `spectre-visualization.ts` | Number of vertical bars |
| Bar Width | 3px | `spectre-visualization.ts` | Individual bar width |
| Bar Gap | 1px | `spectre-visualization.ts` | Space between bars |
| Ghost Opacity | 0.15 | `spectre-visualization.ts` | Trail effect intensity |
| Peak Line Width | 1px | `spectre-visualization.ts` | Peak indicator thickness |
| Sensitivity | 1.0 | `spectre-visualization.ts` | Audio reactivity |

### Flare (Tunnel)

| Setting | Current Value | Location | Notes |
|---------|---------------|----------|-------|
| FFT Size | 2048 | `flare-visualization.ts` | Sample resolution |
| Fade Rate | 0.05 | `flare-visualization.ts` | Trail persistence |
| Zoom Scale | 1.02 | `flare-visualization.ts` | Tunnel zoom speed |
| Line Width | 2px | `flare-visualization.ts` | Waveform thickness |
| Glow Blur | 12px | `flare-visualization.ts` | Glow effect radius |
| Sensitivity | 0.5 | `flare-visualization.ts` | Audio reactivity |
| Colors | Blue/Red | `flare-visualization.ts` | Waveform colors |

### Neon

| Setting | Current Value | Location | Notes |
|---------|---------------|----------|-------|
| FFT Size | 512 | `neon-visualization.ts` | Frequency resolution |
| Ring Count | 3 | `neon-visualization.ts` | Number of rings |
| Line Width | 3px | `neon-visualization.ts` | Ring thickness |
| Glow Blur | 20px | `neon-visualization.ts` | Glow effect radius |
| Sensitivity | 1.0 | `neon-visualization.ts` | Audio reactivity |
| Colors | Cyan/Magenta/Yellow | `neon-visualization.ts` | Ring colors |

### Pulsar

| Setting | Current Value | Location | Notes |
|---------|---------------|----------|-------|
| FFT Size | 256 | `pulsar-visualization.ts` | Sample resolution |
| Fade Rate | 0.03 | `pulsar-visualization.ts` | Trail persistence |
| Zoom Scale | 1.015 | `pulsar-visualization.ts` | Tunnel zoom speed |
| Ring Count | 64 | `pulsar-visualization.ts` | Concentric ring count |
| Circle Points | 128 | `pulsar-visualization.ts` | Central waveform resolution |
| Sensitivity | 1.0 | `pulsar-visualization.ts` | Audio reactivity |
| Colors | Orange/Blue | `pulsar-visualization.ts` | Color scheme |

### Water

| Setting | Current Value | Location | Notes |
|---------|---------------|----------|-------|
| FFT Size | 512 | `water-visualization.ts` | Frequency resolution |
| Fade Rate | 0.015 | `water-visualization.ts` | Trail persistence |
| Zoom Scale | 1.008 | `water-visualization.ts` | Ripple expansion speed |
| Rotation Speed | 0.003 | `water-visualization.ts` | Waveform rotation rate |
| Line Width | 1.5px | `water-visualization.ts` | Waveform thickness |
| Glow Blur | 8px | `water-visualization.ts` | Glow effect radius |
| Sensitivity | 0.8 | `water-visualization.ts` | Audio reactivity |
| Colors | Blue/Cyan | `water-visualization.ts` | Color scheme |

### Flux

| Setting | Current Value | Location | Notes |
|---------|---------------|----------|-------|
| FFT Size | 512 | `flux-visualization.ts` | Sample resolution |
| Fade Rate | 0.025 | `flux-visualization.ts` | Trail persistence |
| Zoom Scale | 1.03 | `flux-visualization.ts` | Trail expansion speed |
| Orbit Speed | 0.012 | `flux-visualization.ts` | Circle rotation rate |
| Orbit Radius | 8% of width | `flux-visualization.ts` | Distance from center |
| Base Radius | 12% of min dimension | `flux-visualization.ts` | Circle size |
| Circle Points | 96 | `flux-visualization.ts` | Waveform resolution |
| Hue Cycle Speed | 0.5 | `flux-visualization.ts` | Color change rate |
| Line Width | 2px | `flux-visualization.ts` | Waveform thickness |
| Glow Blur | 15px | `flux-visualization.ts` | Glow effect radius |
| Sensitivity | 1.0 | `flux-visualization.ts` | Audio reactivity |

## UI/UX Settings

| Setting | Current Value | Location | Notes |
|---------|---------------|----------|-------|
| Control Bar Auto-hide | Not implemented | Layout components | Hide controls after inactivity |
| Control Bar Position | Bottom | Layout components | Could allow top/bottom |
| Visualization Info Display Duration | N/A | Layout components | How long to show viz name |
| Theme | Dark only | Global styles | Could add light theme |

## Implementation Priority

### High Priority
1. ~~Global sensitivity control~~ ✓ DONE
2. ~~Per-visualization sensitivity~~ ✓ DONE
3. ~~Server port configuration~~ ✓ DONE
4. ~~Control bar auto-hide~~ ✓ DONE

### Medium Priority
1. ~~Visualization color customization~~ ✓ DONE (Hue Shift)
2. ~~Animation frame rate cap~~ ✓ DONE
3. ~~Trail/fade rate adjustments~~ ✓ DONE
4. ~~Previous track threshold~~ ✓ DONE

### Low Priority
1. ~~FFT size options~~ ✓ DONE
2. ~~Bar/ring counts~~ ✓ DONE (Bar Density setting)
3. ~~Line width/glow adjustments~~ ✓ DONE
4. Full theme support

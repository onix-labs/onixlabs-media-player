# ONIXPlayer Codebase Review

**Date**: 2026-01-27
**Reviewer**: Claude Opus 4.5 (automated comprehensive review)
**Scope**: Full codebase - architecture, code quality, type safety, security, performance, memory management, tests, CI/CD, documentation

---

## Score: 82 / 100

| Category | Score | Weight | Weighted |
|----------|-------|--------|----------|
| Architecture & Design | 93 | 20% | 18.6 |
| Code Quality | 80 | 15% | 12.0 |
| Type Safety | 86 | 10% | 8.6 |
| Security | 78 | 15% | 11.7 |
| Memory Management | 88 | 10% | 8.8 |
| Performance | 85 | 5% | 4.25 |
| Test Coverage | 62 | 10% | 6.2 |
| CI/CD & Infrastructure | 65 | 5% | 3.25 |
| Documentation & Comments | 92 | 5% | 4.6 |
| SCSS & Styling | 72 | 5% | 3.6 |
| **Total** | | **100%** | **81.6** |

---

## Executive Summary

ONIXPlayer is a well-architected Electron + Angular media player with strong design fundamentals. The unified HTTP server approach, signal-based reactivity, and OnPush change detection across all components demonstrate mature engineering decisions. Documentation quality is excellent, with comprehensive TSDoc throughout.

The main areas requiring attention are: **visualization duplication** (~700 lines of duplicated logic across 10 visualization files that can be consolidated into the base class — see §11), **test coverage** (588 tests exist but major modules like `unified-media-server.ts` and all visualizations are untested), **security** (path traversal validation could be stronger, `openExternal` is unbounded), **code duplication** (duplicate method in settings-manager, shared SCSS patterns not extracted), and **CI/CD** (no coverage thresholds, redundant `npm ci` in every job, no build caching).

---

## Findings by Category

### 1. Architecture & Design (93/100)

**Strengths:**
- Unified HTTP media server minimizes IPC complexity (18 channels vs typical 50+)
- Signal-based state management throughout Angular layer
- SSE with delta events for efficient playlist sync
- Clean separation: Electron backend handles media/state, Angular frontend handles UI/visualizations
- Well-designed visualization class hierarchy with abstract base class and extension points
- Atomic file writes for settings persistence (temp + rename)
- 5-step MIDI cache hierarchy (in-memory, dedup, content-hash, disk, full render)

**Issues:**

| ID | Issue | File | Lines | Severity |
|----|-------|------|-------|----------|
| A1 | `unified-media-server.ts` is 2,300+ lines with SSEManager, PlaylistManager, and server logic all in one file | unified-media-server.ts | all | Medium |
| A2 | Transport control logic duplicated between `layout-controls.ts` and `miniplayer-controls.ts` (computed signals, icon logic, shift-key handling) | miniplayer-controls.ts | 45-96 | Low |
| A3 | Auto-play logic duplicated between `electron.service.ts` and `media-player.service.ts` | electron.service.ts:1048-1074, media-player.service.ts:237-262 | Medium |

---

### 2. Code Quality (80/100)

**Strengths:**
- Consistent coding style enforced by strict ESLint rules
- Excellent naming conventions and code organization
- Good use of readonly, const, and immutability patterns
- Section comments throughout for navigability

**Issues:**

| ID | Issue | File | Lines | Severity |
|----|-------|------|-------|----------|
| Q1 | **Duplicate `isValidHexColor()` method** - identical method appears twice with slightly different regex ordering (`[0-9a-fA-F]` vs `[0-9A-Fa-f]`) | settings-manager.ts | 1306-1308, 1378-1380 | High |
| Q2 | Dead code: `isValidHueShift()` method defined but never called | settings-manager.ts | 1234 | Low |
| Q3 | `clearLowAlphaPixels()` duplicated in 3 visualization files instead of base class | waveform-visualization.ts, spectre-visualization.ts, modern-visualization.ts | varies | Medium |
| Q4 | `ONIX_COLORS_FLAT` Uint8Array duplicated in 8+ visualization files instead of importing from `visualization-constants.ts` | spectre, modern, onix, plasma, infinity, neon, pulsar, water | varies | Medium |
| Q5 | Glow opacity string replacement pattern (`rgba()` manipulation) fragile and duplicated across plasma, infinity, neon, and base class | visualization.ts, plasma, infinity, neon | varies | Low |
| Q6 | `Uint8Array<ArrayBuffer>` type annotation used across all visualization files; `Uint8Array` has no generic parameter - this works but is misleading | all visualization files | varies | Low |
| Q7 | Playlist item ID generation uses `Date.now() + random string` - collision possible under high-frequency adds | unified-media-server.ts | 681 | Low |
| Q8 | Error string comparison `validation.error === 'File not found'` should use enum | unified-media-server.ts | 1741-1746 | Low |

---

### 3. Type Safety (86/100)

**Strengths:**
- Strict TypeScript configuration with `strict: true`, `noImplicitReturns`, `noPropertyAccessFromIndexSignature`
- Comprehensive ESLint rules requiring explicit types, return types, and member accessibility
- Proper type guards throughout settings validation
- `safeParseJSON<T>()` helper for safe SSE event parsing

**Issues:**

| ID | Issue | File | Lines | Severity |
|----|-------|------|-------|----------|
| T1 | `safeParseJSON<T>()` casts `parsed as T` without structural validation - could produce objects that don't match expected type | electron.service.ts | 536 | Medium |
| T2 | Dependency state callbacks use `unknown` type then unsafe cast: `state as DependencyState` | dependency.service.ts | 194, 199 | Medium |
| T3 | Menu event system uses magic strings (`'showConfig'`, `'openFile'`) with no type-safe event map | electron.service.ts | 427-433 | Medium |
| T4 | `JSON.parse(body)` without try-catch in some HTTP handlers | unified-media-server.ts | 2024 | Medium |
| T5 | `openSoundFontDialog()` defined in preload implementation but missing from `MediaPlayerAPI` interface | preload.ts | 265 | Low |

---

### 4. Security (78/100)

**Strengths:**
- Path traversal protection in `validateFilePath()` for media streaming
- Request body size limits (1MB `MAX_BODY_SIZE`)
- Localhost-only HTTP server (no external access)
- Context isolation enabled with minimal IPC bridge
- SoundFont removal validates against `..` and `path.sep`

**Issues:**

| ID | Issue | File | Lines | Severity |
|----|-------|------|-------|----------|
| S1 | **`shell.openExternal(url)` has no URL protocol validation** - could open `file://`, `javascript:`, or other dangerous protocols. Should whitelist `https://` only. | preload.ts | 295 | High |
| S2 | **SoundFont path traversal check is order-dependent** - `path.join(this.soundFontDir, fileName)` is constructed at line 387 BEFORE the traversal check at line 390. While `filePath` isn't used until after the check, the pattern is fragile. Should validate first, then construct. | dependency-manager.ts | 387-390 | Medium |
| S3 | **No file size limit on `readFileSync` for MIDI parsing** - a crafted large `.mid` file could cause OOM | midi-parser.ts | 8 | Medium |
| S4 | MIDI parser brute-force `MTrk` chunk search scans byte-by-byte through file - could be slow/DoS vector for large files | midi-parser.ts | 34 | Medium |
| S5 | `execSync()` in dependency manager with 5-second timeout could block event loop | dependency-manager.ts | 505 | Low |
| S6 | Uncaught error handler logs to file without sanitization - could leak sensitive file paths | logger.ts | 97-102 | Low |
| S7 | `media://` protocol handler in main.ts converts to `file://` via `decodeURIComponent()` without path validation | main.ts | 271 | Medium |

---

### 5. Memory Management (88/100)

**Strengths:**
- All Angular components properly implement `ngOnDestroy` cleanup
- All visualizations implement `destroy()` with canvas cleanup
- Timeout IDs tracked and cleared (`fadeTimeoutId`, `reconnectTimeoutId`, `mediaEndedTimeoutId`)
- Effect references stored and cleaned up
- Event listeners properly removed

**Issues:**

| ID | Issue | File | Lines | Severity |
|----|-------|------|-------|----------|
| M1 | **`midiRenderCache` Map has no size limit** - could grow unboundedly across sessions if many unique MIDI files are played | unified-media-server.ts | 1512-1514 | Medium |
| M2 | **Video outlet fade interval not stored as component property** - if component destroyed during fade-out, interval becomes orphaned | video-outlet.ts | 259-266 | Medium |
| M3 | Concurrent render deduplication Map entries not removed on failure | unified-media-server.ts | 1662-1665 | Low |
| M4 | `menuCleanupFunctions` array grows if `setupMenuListeners()` called multiple times | electron.service.ts | 140, 356-452 | Low |
| M5 | App lifecycle listeners (`activate`, `window-all-closed`) never removed (acceptable - app-level) | main.ts | 804-806 | Low |

---

### 6. Performance (85/100)

**Strengths:**
- Pre-allocated arrays in all visualizations
- Color caching with hue threshold change detection
- Pre-computed trig lookup tables (Onix visualization)
- Delta SSE events for playlist changes
- GPU readback (`getImageData`) throttled to every 10 frames
- Frame rate limiting with configurable cap
- Content-hash MIDI cache eliminates re-rendering

**Issues:**

| ID | Issue | File | Lines | Severity |
|----|-------|------|-------|----------|
| P1 | Playlist file probing is sequential (`for` loop with `await`) - should use `Promise.all()` for parallel probing | unified-media-server.ts | 2095-2113 | Medium |
| P2 | `playback:time` SSE events fire every ~100ms without debouncing in the Angular signal handler | electron.service.ts | 592 | Low |
| P3 | Settings save does full `JSON.stringify` every time with no dirty tracking | settings-manager.ts | 749 | Low |
| P4 | Application menu rebuilds on every state change with no memoization | application-menu.ts | 84-85 | Low |
| P5 | Modern visualization draws glow path 3x per frame (glow + main + highlight layers) | modern-visualization.ts | 242-252 | Low |
| P6 | Miniplayer resize event fires `saveMiniplayerBounds` on every resize without debounce | main.ts | 691-700 | Low |

---

### 7. Test Coverage (62/100)

**Current State: 588 tests across 17 spec files (8,588 lines of test code)**

| Layer | Files With Specs | Files Without Specs | Coverage |
|-------|-----------------|-------------------|----------|
| Electron services | 5/8 | main.ts, preload.ts, unified-media-server.ts | 63% by file |
| Angular services | 5/5 | - | 100% by file |
| Angular components | 7/10 | audio-outlet.ts, video-outlet.ts, configuration-view.ts | 70% by file |
| Visualizations | 0/13 | All 13 files | 0% by file |

**Critical Coverage Gaps:**

| ID | File | Lines | Why It Matters |
|----|------|-------|----------------|
| C1 | `unified-media-server.ts` | 2,300+ | Core HTTP API, SSE, playlist management, MIDI rendering - the most complex and critical file |
| C2 | All 13 visualization files | ~5,000+ | Complex canvas/math logic, no unit tests for rendering calculations |
| C3 | `audio-outlet.ts` | 770 | Web Audio API integration, fade logic, crossfade race conditions |
| C4 | `video-outlet.ts` | 464 | Transcoding, seek handling, format detection |
| C5 | `configuration-view.ts` | 700+ | Settings UI with complex computed signals |
| C6 | `main.ts` | 800+ | Electron lifecycle, IPC handlers, fullscreen/miniplayer transitions |
| C7 | `preload.ts` | 320 | IPC bridge - security-critical code |

**Other Test Issues:**

| ID | Issue | Severity |
|----|-------|----------|
| C8 | No coverage thresholds configured - low-coverage PRs can merge | High |
| C9 | No integration tests for HTTP API endpoints | High |
| C10 | No test for MIDI render cache lifecycle (cache hit, invalidation, corruption recovery) | Medium |
| C11 | No E2E tests for window management (fullscreen, miniplayer transitions) | Medium |

---

### 8. CI/CD & Infrastructure (65/100)

**Strengths:**
- GitHub Actions CI pipeline with lint, build, and test stages
- Separate Angular and Electron test jobs
- Node 22 with npm cache hint

**Issues:**

| ID | Issue | Severity |
|----|-------|----------|
| I1 | **Each CI job runs `npm ci` independently** - no build artifact or dependency caching between jobs. Wastes 2-5 minutes per job. | High |
| I2 | **No coverage reporting** - no Codecov/Coveralls integration, no threshold gates | High |
| I3 | **No job timeouts** - runaway tests could consume unlimited CI minutes | Medium |
| I4 | **`test-angular` and `test-electron` run serially** (both depend on `build`) but could run in parallel | Medium |
| I5 | No production build source maps - makes debugging production crashes impossible | Medium |
| I6 | Preload script built twice (once via `build:preload`, once via `build:electron`) | Low |
| I7 | Node version hard-coded (22) with no `engines` field in package.json | Low |

---

### 9. Documentation & Comments (92/100)

**Strengths:**
- Comprehensive `context.md` (1,240 lines) documenting architecture, features, API, and decisions
- Excellent TSDoc on all public methods with examples and parameter descriptions
- Well-organized code with section separator comments
- MIDI parser comments explain binary format
- Settings validators document valid ranges
- Clear architecture diagrams in context.md

**Issues:**

| ID | Issue | Severity |
|----|-------|----------|
| D1 | MIDI parser (`midi-parser.ts`) has minimal TSDoc - no module-level documentation, no MIDI spec reference | Medium |
| D2 | `context.md` says "Testing Coverage: Only 4 `.spec.ts` files exist" - outdated after 588 tests added | Medium |
| D3 | `context.md` quality score (97/100) is self-assessed and doesn't match this independent review | Low |
| D4 | Missing error handling strategy documentation (which errors are logged vs thrown vs ignored) | Low |

---

### 10. SCSS & Styling (72/100)

**Strengths:**
- Component-scoped styles (no style leaking)
- Excellent use of CSS container queries in `video-outlet.scss`
- Clean semantic class names
- Proper `:host` and `:host-context` usage

**Issues:**

| ID | Issue | File | Severity |
|----|-------|------|----------|
| SS1 | **No global SCSS variables** for colors, spacing, borders - 40+ repeated `rgba()` values across files | all SCSS | High |
| SS2 | **Glass gradient pattern duplicated** across `layout-controls.scss` and `miniplayer-controls.scss` (~150 lines of redundant code) | layout-controls.scss, miniplayer-controls.scss | Medium |
| SS3 | **`.color-control` defined twice** in configuration-view.scss | configuration-view.scss | 334-377, 431-461 | Medium |
| SS4 | Magic number `0.0625rem` (1px border) repeated 30+ times - should be SCSS variable | all SCSS | Low |
| SS5 | Inconsistent spacing units (rem, px, %, vw/vh, cqw/cqh) without documented system | all SCSS | Low |
| SS6 | Webkit/Moz slider styling duplicated - should use SCSS mixin | layout-controls.scss | 195-213 | Low |

---

### 11. Visualization Duplication Analysis

A detailed review of all 10 visualization implementations reveals significant duplication that can be consolidated into the base class hierarchy. The base class (`Canvas2DVisualization`) already provides `drawPathWithLayers()`, `buildSmoothPath()`, `resizeCanvasPreserving()`, and `applyFadeOverlay()`, but several shared patterns are still duplicated across subclasses.

#### 11.1 Identical Methods Duplicated Across Files

| Pattern | Files | Lines Each | Can Move To Base |
|---------|-------|-----------|-----------------|
| `clearLowAlphaPixels()` | waveform (180-197), spectre (257-274), modern (278-295) | ~18 | Yes |
| `applyDirectionalZoom()` | plasma (181-214), neon (223-256), infinity (194-228) | ~30 | Yes |
| `getCachedColor()` + `getColorFromHue()` | plasma (287-320), infinity (309-342) | ~35 | Yes |
| 3-layer draw (glow+main+highlight) | plasma (237-281), neon (319-363), infinity (254-303), pulsar (343-384), water (444-506) | ~35-60 | Yes (fix `drawPathWithLayers`) |
| `resize()` with LCD ghosting | waveform (67-112), modern (92-140) | ~45 | Yes |
| Trail canvas lifecycle (create/resize/destroy) | plasma, neon, infinity, pulsar, water, onix | ~20-30 | Yes |
| `destroy()` canvas nulling | plasma (322-329), neon (365-372), infinity (344-351), pulsar (386-391), water (508-515), onix (359-364) | ~6-8 | Yes |

**Total duplicated lines: ~600-800 across 10 files.**

#### 11.2 Detailed Findings

**D1. `clearLowAlphaPixels()` — 3 identical copies (waveform, spectre, modern)**

All three visualizations use LCD ghosting / smoke trail effects that rely on `destination-out` compositing for fade. This asymptotic fade never reaches zero, so pixels accumulate as ghosting artifacts. The solution is identical in all three: periodically scan all pixels via `getImageData()` and zero out any alpha below a threshold.

Duplicated state: `THRESHOLD_CLEAR_INTERVAL = 10`, `ALPHA_THRESHOLD = 30`, `frameCount: number = 0`
Duplicated logic in `draw()`: `this.frameCount++; if (this.frameCount >= this.THRESHOLD_CLEAR_INTERVAL) { ... }`

**Recommendation**: Add to `Canvas2DVisualization`:
```
protected clearLowAlphaPixels(ctx, width, height, threshold): void
protected callClearLowAlphaIfNeeded(): boolean  // manages frameCount internally
```

**D2. `applyDirectionalZoom()` — 3 identical copies (plasma, neon, infinity)**

All three zoom-trail visualizations implement the same method:
1. Copy trail canvas → temp canvas
2. Clear trail canvas
3. Calculate `effectiveFadeRate = this.FADE_RATE * this.getFadeMultiplier()`
4. Apply save → high-quality smoothing → globalAlpha → floor center → translate → scale → translate → drawImage → restore

The implementations are byte-for-byte identical (except variable names for `this.FADE_RATE` and `this.ZOOM_SCALE` which differ per visualization).

**Recommendation**: Add to `Canvas2DVisualization`:
```
protected applyZoomFade(
  trailCanvas, trailCtx, tempCanvas, tempCtx,
  centerX, centerY, fadeRate, zoomScale
): void
```

**D3. Three-layer waveform draw — 5 visualizations bypass `drawPathWithLayers()`**

The base class has `drawPathWithLayers()` (visualization.ts:675-755) which draws glow + main + highlight layers. However, it's **hardcoded to `this.ctx`** (line 688: `const ctx = this.ctx`). Five visualizations (plasma, neon, infinity, pulsar, water) need to draw to **trail canvas contexts**, not `this.ctx`, so they each implement their own 3-layer draw method manually.

This is the **root cause** of the largest duplication cluster. The plasma and neon `drawWaveform()` methods are near-identical (35 lines each). Pulsar and water have similar `drawWaveformSegment()` and `drawCenterCircle()` methods that follow the same 3-layer pattern.

**Recommendation**: Modify `drawPathWithLayers()` to accept an optional `ctx` parameter:
```
protected drawPathWithLayers(
  buildPath: () => void,
  mainColor: string,
  glowColor: string,
  highlightColor?: string,
  options: { ..., ctx?: CanvasRenderingContext2D } = {}
): void
```
This single change would allow all 5 visualizations to use the existing base class method instead of duplicating it.

**D4. Glow opacity regex — 4 copies (base class + plasma + neon + infinity)**

The pattern `glowColor.replace(/[\d.]+\)$/, ...)` for reducing rgba opacity appears in `drawPathWithLayers()` and is manually duplicated in the 3 visualizations that can't use `drawPathWithLayers()` (see D3). Fixing D3 eliminates this duplication automatically.

**D5. `getCachedColor()` + `getColorFromHue()` — identical pair in plasma and infinity**

Both maintain `cachedColor1/2`, `cachedHue1/2` state and the same cache-invalidation logic (hue difference < 1 degree). Both `getColorFromHue()` methods do the same `hslToRgb()` → string formatting.

**Recommendation**: Add to `Canvas2DVisualization`:
```
protected getCachedHslColor(hue, cacheSlot): {main: string; glow: string}
```

**D6. `resize()` with LCD ghosting preservation — near-identical in waveform and modern**

Both override `resize()` with ~45 lines of identical logic:
1. Check if dimensions changed AND has drawn
2. If first draw and no change, just clear
3. If dimensions changed with prior content: capture → resize → scale back
4. If no content, just resize

The only difference: modern adds `this.cachedGradient = null` at the end.

**Recommendation**: Extract a `resizePreservingMainCanvas()` helper to `Canvas2DVisualization` that handles the common preserve-on-resize pattern, with an optional callback for subclass-specific cleanup.

**D7. Trail canvas lifecycle — repeated in 6 visualizations**

Six visualizations (plasma, neon, infinity, pulsar, water, onix) follow an identical pattern:
- Declare nullable `trailCanvas`/`trailCtx`/`tempCanvas`/`tempCtx` fields
- Lazily create with `document.createElement('canvas')` + `getContext('2d', {alpha: true})!`
- Call `resizeCanvasPreserving()` for trail canvas, plain width/height set for temp canvas
- Null everything in `destroy()`

Some (plasma, neon, infinity) have **additional** trail canvases (2 trails for dual-waveform effects).

**Recommendation**: Create a `TrailingVisualization` intermediate class:
```
Canvas2DVisualization
└── TrailingVisualization  ← new
    ├── PlasmaVisualization
    ├── NeonVisualization
    ├── InfinityVisualization
    ├── PulsarVisualization
    ├── WaterVisualization
    └── OnixVisualization
```
This class would manage trail canvas creation, resize, and destroy. Subclasses declare how many trail canvases they need. This eliminates ~30 lines from each of 6 files.

#### 11.3 Constant Redeclarations

| Constant | Canonical Source | Redeclared In |
|----------|-----------------|---------------|
| `ONIX_COLORS_FLAT` (Uint8Array) | `visualization-constants.ts:312` | spectre (28-37), onix (36-45), modern (29-38) |
| `NUM_COLORS = 8` | `visualization-constants.ts:215` (as `ONIX_COLOR_COUNT`) | spectre (22), onix (30), modern (23) |
| `TWO_PI` | `visualization-constants.ts:16` | onix (29) |

**Recommendation**: Delete all local redeclarations; import from `visualization-constants.ts`.

#### 11.4 Repeated Micro-Patterns

| Pattern | Count | Recommendation |
|---------|-------|---------------|
| `this.sensitivity * 2` (sensitivity factor) | 9 visualizations | Add `protected get sensitivityFactor()` to base class |
| `this.dataArray = new Uint8Array(this.analyser.fftSize)` in `onFftSizeChanged()` | All 10 | Consider managing `dataArray` in base class |
| `this.getScaledGlowBlur(15)` | pulsar (314, 357), water (419, 479), onix (294) | Define `BASE_GLOW_BLUR = 15` in constants (already in some files) |

#### 11.5 Estimated Impact

| Refactoring | Lines Removed | Files Affected | Risk |
|-------------|--------------|----------------|------|
| Fix `drawPathWithLayers()` ctx param | ~200 | plasma, neon, infinity, pulsar, water + base | Low |
| Move `clearLowAlphaPixels()` to base | ~70 | waveform, spectre, modern + base | Low |
| Move `applyDirectionalZoom()` to base | ~90 | plasma, neon, infinity + base | Low |
| Create `TrailingVisualization` class | ~180 | 6 trail visualizations + new class | Medium |
| Import constants instead of redeclaring | ~40 | spectre, onix, modern | Low |
| Extract `getCachedColor()` to base | ~70 | plasma, infinity + base | Low |
| Extract LCD ghosting resize | ~45 | waveform, modern + base | Low |
| Add `sensitivityFactor` getter | ~10 | 9 visualizations + base | Low |
| **Total** | **~705** | 10 files + base | |

This would reduce the visualization codebase by approximately **700 lines** (from ~5,000 to ~4,300) while making the code more maintainable, less error-prone, and easier to add new visualizations.

---

## What Needs to Be Fixed (Priority Order)

### Critical (Fix Now)

1. [DONE] **Remove duplicate `isValidHexColor()`** in `settings-manager.ts` (lines 1378-1380). Delete the second copy.

2. [DONE] **Validate URL protocol in `openExternal()`** in `preload.ts` (line 295). Whitelist `https://` and `http://` only:
   ```typescript
   openExternal: (url: string): Promise<void> => {
     if (url.startsWith('https://') || url.startsWith('http://')) {
       return shell.openExternal(url);
     }
     return Promise.reject(new Error('Invalid URL protocol'));
   }
   ```

3. [DONE] **Add test coverage thresholds** to `vitest.electron.config.ts` and Angular test config.

4. [DONE] **Add CI build caching** - use `actions/cache` or shared artifacts to avoid 4x `npm ci`.

### High (Fix Soon)

5. [DONE] **Add optional `ctx` parameter to `drawPathWithLayers()`** — This single change (base class `visualization.ts:688`) unblocks 5 visualizations (plasma, neon, infinity, pulsar, water) from using the base class method instead of duplicating 3-layer draw logic. Eliminates ~200 lines. (See §11.2 D3)

6. [DONE] **Move `clearLowAlphaPixels()` to `Canvas2DVisualization`** — Identical 18-line method + frame-counting logic in waveform, spectre, modern. Add configurable threshold and interval to the base class. Eliminates ~70 lines. (See §11.2 D1)

7. [DONE] **Move `applyDirectionalZoom()` to `Canvas2DVisualization`** — Identical ~30-line method in plasma, neon, infinity. Accept trail/temp canvas, center point, fade rate, and zoom scale as parameters. Eliminates ~90 lines. (See §11.2 D2)

8. [DONE] **Import `ONIX_COLORS_FLAT` and `NUM_COLORS` from constants** — Delete local redeclarations in spectre, onix, modern. Also import `TWO_PI` in onix. (See §11.3)

9. [DONE] **Write `unified-media-server.spec.ts`** — HTTP API integration tests for the most critical backend file.

10. [DONE] **Extract SCSS variables** — Create `src/styles/_variables.scss` with colors, borders, and spacing.

11. [DONE] **Add MIDI file size limit** in `midi-parser.ts` before `readFileSync()`.

12. [DONE] **Fix video outlet fade interval leak** — Store `fadeInterval` as component property, clear in `ngOnDestroy`.

### Medium (Fix Next Sprint)

13. [DONE] **Add `createOffscreenCanvas()` helper to base class** — Manages trail canvas lifecycle (create/resize/destroy) for 6 visualizations. Eliminates ~180 lines of duplicated canvas management + 6 identical `destroy()` overrides. (See §11.2 D7)

14. [DONE] **Extract `getCachedColor()` to base class** — Identical dual-color caching in plasma and infinity. Eliminates ~70 lines. (See §11.2 D5)

15. [DONE] **Extract LCD ghosting resize helper** — Near-identical `resize()` override in waveform and modern (~45 lines each). (See §11.2 D6)

16. [DONE] **Add `sensitivityFactor` getter to base class** — `this.sensitivity * 2` repeated in 9 visualizations. (See §11.4)

17. [DONE] **Add `midiRenderCache` size limit** with FIFO eviction.

18. [DONE] **Parallelize playlist file probing** using `Promise.allSettled()` in `unified-media-server.ts`.

19. [DONE] **Add CI job timeouts** to all CI jobs.

20. [DONE] **Validate `media://` protocol handler** path in `main.ts`.

21. [DONE] **Refactor SoundFont path validation** to validate before constructing file path.

22. [DONE] **Extract shared transport control logic** into `TransportControlsBase` directive.

23. [DONE] **Remove duplicate `.color-control`** in `configuration-view.scss`.

24. [DONE] **Write visualization base class tests** for `setSensitivity`, `setTrailIntensity`, `setFftSize`, `resize`, fade logic.

### Low (Improve When Convenient)

25. [DONE] Remove dead `isValidHueShift()` method.
26. [DONE] Add MIDI spec reference to `midi-parser.ts` TSDoc.
27. Update `context.md` test coverage section.
28. Extract SCSS slider mixin for webkit/moz styling.
29. [DONE] Add `engines` field to `package.json`.
30. [DONE] Debounce miniplayer resize `saveMiniplayerBounds`.
31. Consider extracting SSEManager and PlaylistManager from `unified-media-server.ts` into separate files.

---

## Codebase Statistics

| Metric | Value |
|--------|-------|
| Source code (non-test, non-type) | 18,397 lines |
| Test code | 8,588 lines |
| Test-to-source ratio | 0.47:1 |
| Total tests | 588 (402 Angular + 186 Electron) |
| Test files | 17 |
| Source files with specs | 17/40 (43%) |
| Source files without specs | 23/40 (57%) |
| SCSS files | 11 (1,300+ lines) |
| HTML templates | 10 (670+ lines) |

---

*Review performed by automated codebase analysis on 2026-01-27. All findings verified against source code with specific line references.*

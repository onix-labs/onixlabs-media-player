# Spike: Windows Media Player skin (.wmz) support

**Branch:** `spike/wmp-skins`
**Status:** spike — not production ready. See *Known gaps* and *Security* before going further.
**Reference skin:** *Windows Media Player 8 — Redux* by Rydsei (557 files, 745 elements, 8,246 lines of JScript).

## What the format actually is

A `.wmz` is a plain ZIP holding:

- **one `.wms` definition** — an XML-ish document describing the UI tree;
- **`.js` files** — JScript supplying the skin's shared globals and behaviour;
- **bitmaps** — 486 `.bmp`, 52 `.gif`, 7 `.png` in the reference skin.

Three properties of the format drive most of the design:

1. **Text is UTF-16LE.** The `.wms` and every `.js` are little-endian UTF-16 with a BOM.
2. **The `.wms` is not valid XML.** Real skins carry duplicate attributes on one element
   (the reference skin's `PLAYLIST` states `width` twice, its `EFFECTS` states
   `currentPresetTitle_onchange` twice) and comment bodies full of DOS-era box-drawing
   control characters. `DOMParser` rejects the document outright and yields nothing.
3. **Markup and script are one namespace.** Attribute values prefixed `jscript:` are
   expressions; `on*` and `*_onchange` attributes are statement lists; both see the skin's
   `.js` globals, the WMP object model, and one binding per element id. The reference skin
   has 698 `jscript:` bindings, 225 `wmpprop:` bindings and 442 handlers.

## What was built

| Area | Module |
| --- | --- |
| ZIP reader (no new dependency — central directory by hand, `zlib.inflateRawSync`) | `src/electron/wmz-archive.ts` |
| Install / list / read, UTF-16 sniffing, case-insensitive asset index | `src/electron/skin-manager.ts` |
| Lenient `.wms` parser | `src/angular/skin/wms-parser.ts` |
| Script sandbox | `src/angular/skin/skin-expression.ts` |
| Element model, property resolution, `_onchange` | `src/angular/skin/skin-element.ts` |
| WMP object model over `MediaPlayerService` | `src/angular/skin/wmp-object-model.ts` |
| Layout, bindings, hit testing, render tree | `src/angular/skin/skin-runtime.ts` |
| Bitmap decode, colour keying, region bounds | `src/angular/skin/skin-image.service.ts` |
| Activation and lifecycle | `src/angular/skin/skin.service.ts` |
| Renderer | `src/angular/components/skin/skin-host/` |

Entry point: **View → Load Media Player Skin…**, and **View → Use Built-in Interface** to
go back. A skin covers the built-in interface rather than replacing it — the existing view
stays mounted and hidden so its media elements keep playing while the skin drives them.

## The two findings that mattered

### 1. Script declarations must live *inside* the `with` block

Expressions have to see the `.js` files' `var`s and `function`s, so the scripts and the
evaluator are compiled together: one wrapper runs the scripts and returns closures that
call direct `eval`, which inherits the scope those declarations landed in.

The first attempt put the scripts directly in the `with (scope)` body and appeared to work —
`g_kTaskBarWidth` read back as `79`, straight from the skin's own source. But every
*function* the skin declared read as `undefined`. The reason: with the scripts in the `with`
body, `var x = 79` hoists to the wrapper's variable scope while its **assignment** walks the
scope chain, hits the proxy's catch-all `has`, and writes to the proxy — so it looks fine. A
function declaration binds directly in the variable scope the proxy hides, so it never
resolves. Nesting the scripts one function deeper puts their declarations *inside* the
`with`, where they correctly shadow the proxy.

Effect: skin-defined functions went from **0 to all** resolving.

### 2. Expressions are scoped to the element that declares them

`width="jscript:svEntireApp.width - left - 298"` means *this element's* `left`, and
`onclick="player.settings.setMode('loop', down)"` means *this button's* `down`. Without
that, the reference skin's top bar computed `NaN` widths. Each element exposes a second,
deliberately narrow proxy that claims only the names it recognises — its own attributes,
the standard property set, its own methods — so it cannot shadow `player`, `view` or the
skin's globals.

### Smaller ones

- **The object model is case-insensitive.** It was COM. One file calls
  `player.controls.play()` and `player.controls.FastForward()`.
- **`NaN !== NaN` stopped layout from ever settling.** Font sizes derive from `wmploc.dll`
  strings this player cannot supply, so they evaluate to `NaN`, and a `!==` comparison
  reported a change on every pass forever. Switching to `Object.is` took the reference skin
  from *never converging* to **settling in 3 passes**.
- **`theme.loadString` must exist.** Three of the nine script files call it at load time;
  without it they threw part-way and silently lost every declaration after that point.
- **Transparency is magenta unless stated otherwise.** Of 271 art references in the
  reference skin, only 39 name a `transparencyColor`; nine more carry magenta with none
  declared anywhere in their ancestry — the stop button, the skin-mode button, the radio
  help button — and render as magenta rectangles unless magenta is assumed. Assuming it is
  safe in the other direction, since keying only zeroes pixels that match exactly. Four
  references use `transparencyColor="auto"`, which means *key the top-left pixel*.
- **Alignment must not double-count.** This skin declares `horizontalAlignment="stretch"`
  *and* `width="jscript:svEntireApp.width - left - 298"` on the same element. The
  expression already accounts for the new size, so adding the alignment delta on top tore
  the layout apart on resize. Alignment now only fills in for values the skin does not
  compute or assign itself.

## Measured against the reference skin

| | |
| --- | --- |
| ZIP entries read | 557 |
| Definition parsed | 745 elements, 670 ids, **0 parser warnings** |
| Script files loaded | 9 / 9, no load errors |
| Bound expressions evaluating | **921 / 923 (99.8%)** |
| Event handlers running clean | **402 / 442 (91.0%)** |
| Layout convergence | 3 passes |
| Elements resolving to real geometry | 402 / 745 |

The residual failures are honest gaps, not parse or scope problems: popup list contents,
`EFFECTS` methods, keyboard event objects, and two references to ids the skin itself never
defines.

## Known gaps

- **Not rendered:** `PLAYLIST`, `LISTBOX`, `EDITBOX`, `POPUP`. These are stubs; the
  reference skin has 4, 2, 1 and 3 of them.
- **On Windows the menu bar goes with the frame.** A frameless window has nowhere to put
  it, so *View → Use Built-in Interface* is unreachable from a skinned window there. The
  skin's own close button works; the menu route needs a keyboard accelerator.
- **`res://wmploc.dll` strings** resolve to empty. Every label and tooltip the reference
  skin takes from Windows resources is blank. Shipping a mapping table for the common
  string ids would recover most captions.
- **`VIDEO` and `EFFECTS` panes are reported, not filled.** The runtime emits their
  rectangles; nothing yet positions the application's real outlets over them, so both
  render as empty holes. They are deliberately *not* painted with the skin's declared
  `backgroundColor` — the WMP8 skin names yellow, which the original painted behind live
  content and which shows as a yellow rectangle when there is no content to cover it.
  Filling these is the next piece of work.
- **Activating a skin reloads the renderer.** `frame` and `transparent` are constructor-only
  on `BrowserWindow` — there is no setter for either — so a skin is shown by *replacing* the
  main window with a frameless, transparent one, and dismissing it replaces it back. The new
  window is created before the old is destroyed, or the moment with no windows open would
  fire `window-all-closed` and quit. The renderer restarts across that swap, which
  interrupts playback; the main process remembers the active skin so the new renderer can
  restore it. Making this seamless would mean keeping playback out of the renderer.
- **Alignment on resize is approximate.** Each element baselines its parent's size while
  the view is at the skin's design dimensions, then distributes later growth per
  `horizontalAlignment` / `verticalAlignment`. Most of the skin computes its own sizes in
  script and is unaffected. Resizing away from the design size is the least-tested path.
- **No skin-side persistence.** `theme.savePreference` lives for the session only.
- **Only partly verified on screen.** The skin has been seen rendering in the app: the
  archive unpacks, the art decodes and colour-keys, and the chrome draws. Interaction —
  button hover and press states, mapping-image hit testing on the transport controls, and
  slider dragging — has not been exercised, and neither has resizing.

## Security

**Installing a skin runs its code.** Skin script executes in the renderer alongside the
preload bridge. The sandbox shadows the obvious escape hatches — `window`, `document`,
`fetch`, `require`, `mediaPlayer` — but that is a mitigation, not a boundary; a determined
script can still reach ambient globals the list does not name.

This must not ship as-is. The options, cheapest first:

1. Run the skin runtime in a sandboxed `<iframe>` with no preload, talking to the host over
   `postMessage`.
2. Run script in a Worker and drive the DOM from the host.
3. Replace `eval` with an interpreter for the JScript subset skins actually use.

Option 1 is the natural fit: the render tree is already an immutable snapshot and the input
surface is already a handful of message-shaped calls.

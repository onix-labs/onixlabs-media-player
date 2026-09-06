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
go back.

A skin is drawn in a **window of its own**, frameless and transparent, because `frame` and
`transparent` are constructor-only on `BrowserWindow` — there is no setter for either, so
a live window cannot be made transparent. The main window is *hidden*, not closed, so its
audio and video elements keep playing while the skin drives them through the media server
exactly as the built-in interface does. Background throttling is lifted on the hidden
window, or its timers would slow and stall the playback clock. The main window is hidden
only once the skin window has actually shown, so a skin that fails to load cannot leave
the application with nothing on screen.

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
  the layout apart on resize. Alignment only fills in for values the skin does not compute
  or assign itself.
- **Layout is part of the fixed point, not a step after it.** Alignment changes an
  element's *real* width, and the skin reads those widths back:
  `svUpperRightCorner.left` is `jscript:svEntireApp.width-298`. Adjusting only the rendered
  box left every such expression computing against the design size however large the window
  got — the top and bottom chrome simply never moved. Alignment now writes into the
  elements' own properties inside the settle loop, so the next pass sees the new sizes.
- **The design reference must be captured deliberately.** A skin's layout is arbitrary
  JScript, so the only way to learn where the author put things is to set the view to the
  size the skin was drawn for, settle, and walk it. Baselining off whichever render came
  first captured zeroes (art loads asynchronously) or the wrong window size, and every
  later offset was wrong by that much.

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

## Filling the skin's panes

A skin marks out where the picture goes with `VIDEO` and `EFFECTS` elements. They draw
nothing themselves — their declared `backgroundColor` is what the original painted *behind*
live content, and honouring it just puts a yellow rectangle where the visualiser belongs.

The outlet is handed to `SkinHost` as a `TemplateRef` and rendered **at that node's own
position in the skin's tree**. Layering it behind the whole skin does not work: skin chrome
is opaque and overlaps the pane on every side — this one paints a black `BackgroundX`
across the entire screen area at the same z-index — so anything stacked underneath is
simply covered, which is why the first attempt showed nothing at all. Rendering at the
pane's node puts it above that backdrop and below the chrome that frames it, which is the
z-order the author intended.

Which pane is used follows the skin rather than the app: a skin decides by its own rules
which of the two is live and only publishes a rectangle for the visible one.

This is why the skin window, not the main window, holds the media element while a skin is
up. The visualisations take a real `AnalyserNode` and video needs a real `<video>`, and
neither crosses a process boundary — so the window drawing the skin has to be the window
playing the media. The main window stands its outlets down for the duration, or the same
track would be decoded twice and drift apart.

## Known gaps

- **Not rendered:** `PLAYLIST`, `LISTBOX`, `EDITBOX`, `POPUP`. These are stubs; the
  reference skin has 4, 2, 1 and 3 of them.
- **On Windows the menu bar lives on the main window**, which is hidden while a skin is up,
  so *View → Use Built-in Interface* is unreachable there. The skin's own close button works;
  the menu route needs a keyboard accelerator or a tray entry.
- **`res://wmploc.dll` strings** resolve to empty. Every label and tooltip the reference
  skin takes from Windows resources is blank. Shipping a mapping table for the common
  string ids would recover most captions.
- **Toggling a skin interrupts playback briefly.** The skin window owns the media element
  while it is up, so the main window's outlet stands down and the skin window's opens the
  stream and seeks to the server's position. Both directions cost a buffering gap. Avoiding
  it would mean playback living somewhere neither window owns.
- **Resize is modelled, not exhaustively verified.** Chrome tiles exactly at every size
  measured (`0..94 | 94..702 | 702..1000` at 1000px wide) and no size introduces a sibling
  overlap the skin does not already have at its design size. Sizes below the skin's stated
  minimum are clamped by the window rather than handled.
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

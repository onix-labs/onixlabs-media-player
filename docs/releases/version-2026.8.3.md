# ONIXPlayer 2026.8.3

**Release Date:** August 2026
**Platform:** macOS, Windows, Linux
**Tech Stack:** Electron 43, Angular 21, TypeScript

---

## Overview

A patch release fixing the missing interface icons that 2026.8.1 was believed to have
fixed and did not.

---

## Fixes

### Missing interface icons, actually fixed this time

Installing 2026.8.0, 2026.8.1 or 2026.8.2 produced a window with **no icons at all** —
play, pause, stop, next, eject and the rest.

The build inlines the above-the-fold CSS into `index.html` and defers the rest of the
stylesheet, loading it as `media="print"` and switching it to `all` in an inline `onload`
handler. Since 2026.8.0 the packaged app also carries a `script-src 'self'`
Content-Security-Policy, which blocks inline event handlers. The `onload` never ran, the
link stayed on the print media type, and the stylesheet — every `@font-face` and every
icon rule in it — never applied to the screen.

Critical-CSS inlining is now off for the production build, so the stylesheet is emitted as
an ordinary `<link rel="stylesheet">` with no inline handler. Deferring it bought nothing
here in any case: the bundle is served from localhost, not across a network. A test asserts
the setting stays off, and the policy itself now records that the build depends on it.

It affected packaged builds only. The policy is installed only when the app is packaged, so
during development the handler runs and the stylesheet applies normally — which is why this
survived three releases.

### What 2026.8.1 actually fixed

2026.8.1 reported this same symptom as fixed. It was not, and the release notes for it are
wrong.

That release addressed a real and separate defect: resources referenced from stylesheets
were emitted to `media/`, which is also the prefix of the token-protected internal media
API, so the icon font would have been rejected when requested. But the font was never
requested — the stylesheet carrying the `@font-face` rules was already inert for the reason
above. The collision was latent rather than active, and fixing it changed nothing visible.
It remains fixed, and is now genuinely reachable.

---

## Maintenance

All dependencies have been updated to the latest versions permitted by their existing
version ranges, including Font Awesome 7.3.1, Angular 21.2.22, Vitest 4.1.11 and
TypeScript ESLint 8.68.0. Major-version upgrades are not part of this release.

---

## Downloads

| Platform               | File                                     |
| ---------------------- | ---------------------------------------- |
| macOS (Apple Silicon)  | ONIXPlayer-2026.8.3-arm64.dmg            |
| macOS (Intel)          | ONIXPlayer-2026.8.3-x64.dmg              |
| macOS (Apple Silicon)  | ONIXPlayer-2026.8.3-arm64-mac.zip        |
| macOS (Intel)          | ONIXPlayer-2026.8.3-x64-mac.zip          |
| Windows                | ONIXPlayer Setup 2026.8.3.exe            |
| Windows (portable)     | ONIXPlayer 2026.8.3.exe                  |
| Linux (AppImage)       | ONIXPlayer-2026.8.3.AppImage             |
| Linux (deb)            | onixlabs-media-player_2026.8.3_amd64.deb |

---

## Links

- [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)
- [ONIXLabs Website](https://onixlabs.io)

---

**License:** MIT

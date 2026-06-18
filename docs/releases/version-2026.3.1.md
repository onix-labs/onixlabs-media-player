# ONIXPlayer 2026.3.1

**Release Date:** June 2026
**Platform:** macOS, Windows, Linux
**Tech Stack:** Electron 39, Angular 21, TypeScript

---

## Overview

ONIXPlayer 2026.3.1 is a maintenance release that resolves **all outstanding Dependabot security advisories**. There are no functional changes to the application — all affected packages are build/dev-time tooling and none ship in the production app.

---

## Security & Dependencies

- **Resolved all Dependabot advisories** — 17 (1 critical, 6 high, 8 moderate, 2 low); `npm audit` now reports **0 vulnerabilities**
- **Angular** updated to `21.2.17` (core/common/compiler), fixing a `formatDate` DoS, `HttpTransferCache` cache-key data leakage, and a two-way binding sanitization (XSS) bypass
- **vite** pinned to `7.3.5` via overrides — `server.fs.deny` bypass and launch-editor NTLM disclosure on Windows dev servers
- **esbuild** pinned to `0.28.1` via overrides — dev-server arbitrary file read on Windows
- **@babel/core** pinned to `7.29.7` via overrides — arbitrary file read via `sourceMappingURL`
- **concurrently** updated to `^10.0.3`, pulling in `shell-quote` `1.8.4` and clearing the critical advisory
- Transitive build-tooling dependencies (`tar`, `form-data`, `hono`, `js-yaml`, and others) patched within their existing semver ranges

`vite@7.3.2` and `esbuild@0.27.3` are hard-pinned by `@angular/build@21.x`, so the patched versions are enforced via npm `overrides`. CI (build + Electron tests on macOS, Windows, and Linux) validated the updated dependency tree.

---

## Downloads

| Platform               | File                                     |
| ---------------------- | ---------------------------------------- |
| macOS (Apple Silicon)  | ONIXPlayer-2026.3.1-arm64.dmg            |
| macOS (Intel)          | ONIXPlayer-2026.3.1-x64.dmg              |
| macOS (Apple Silicon)  | ONIXPlayer-2026.3.1-arm64-mac.zip        |
| macOS (Intel)          | ONIXPlayer-2026.3.1-x64-mac.zip          |
| Windows                | ONIXPlayer Setup 2026.3.1.exe            |
| Windows (portable)     | ONIXPlayer 2026.3.1.exe                  |
| Linux (AppImage)       | ONIXPlayer-2026.3.1.AppImage             |
| Linux (deb)            | onixlabs-media-player_2026.3.1_amd64.deb |

---

## Links

- [GitHub Repository](https://github.com/onix-labs/onixlabs-media-player)
- [ONIXLabs Website](https://onixlabs.io)

---

**License:** MIT

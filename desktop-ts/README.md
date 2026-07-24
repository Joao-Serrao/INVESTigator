# INVESTigator desktop (TypeScript engine)

The desktop shell that runs the **pure-TypeScript engine** in a Tauri WebView — no
Python sidecar. It's the Stage 5 target of [docs/PORTING.md](../docs/PORTING.md):
the same engine the parity harnesses verify, packaged as a native app.

## How it fits together

```
┌─ WebView ─────────────────────────────────────────────┐
│  index.html → bundle.js (the whole TS engine, IIFE)   │
│               app.js  (the SHARED vanilla-JS UI)       │
│                                                        │
│  UI calls  api.get('/api/holdings')                    │
│    → window.__invest('GET', '/api/holdings')           │
│    → engine router.handle(ctx, …)  → service.ts        │
└───────────────┬────────────────────────────────────────┘
                │ platform adapter (src/adapter.ts)
                ▼
   tauri-plugin-fs · -sql · -http · -opener   +  Rust: send_email, sync_schedules
```

- **`src/adapter.ts`** implements the engine's `FileSystem` / `Database` / `HttpClient`
  interfaces with the Tauri plugins. It's the *only* file that knows it's Tauri.
- **`src/main.ts`** builds the engine's `AppContext` and exposes `window.__invest`.
- **`build.mjs`** bundles `main.ts` (→ `web/bundle.js`) and copies the canonical UI
  from `../src/investraton/web` — the UI is never forked, so one `app.js` serves both
  the Python dev server and this shell (it uses the bridge when present, `fetch`
  otherwise).
- **`src-tauri/`** registers the four plugins and provides the two things a WebView
  can't do: SMTP email (`lettre`) and OS scheduling (`sync_schedules`, wired in Stage 6).

## Data compatibility

The adapter points at `%APPDATA%\Investraton\` — the **same** folder the Python app
uses — and opens the **same** `data\investraton.db`. Holdings, plan, settings,
history and dedup state all carry over untouched. That equivalence is proven by the
parity harnesses in [`../engine/test`](../engine/test), most directly
`service-parity` (this shell's service layer vs the Python API on identical data).

## Build

Prerequisites: Node, the Rust toolchain, and the
[Tauri v2 prerequisites](https://tauri.app/start/prerequisites/) (on Windows:
WebView2 + MSVC build tools).

```bash
npm install            # JS deps (engine is linked via file:../engine)
npm run bundle         # assemble web/ (also runs automatically before tauri build)
npm run tauri dev      # run the app
npm run tauri build    # produce the NSIS + MSI installers
```

## Build status

`npm run tauri build` was run end to end on Windows (Rust 1.96, MSVC): the release
binary links and both installers are produced —

```
target/release/investigator.exe                          (~20 MB)
target/release/bundle/nsis/INVESTigator_0.1.0_x64-setup.exe
target/release/bundle/msi/INVESTigator_0.1.0_x64_en-US.msi
```

So the whole stack compiles: the four plugins, the bundled SQLite backend, and the
Rust commands (`send_email`, `sync_schedules`). What's still worth exercising by hand
on a real machine is *runtime* behaviour — first launch reading your existing
`%APPDATA%\Investraton\` data, a digest run, and `send_email` against a real SMTP
server. The rest of the app is the TypeScript engine the parity harnesses already
verify. `sync_schedules` is a no-op stub until the Stage 6 OS-scheduling wiring.

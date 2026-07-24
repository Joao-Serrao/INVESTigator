# Packaging Investraton as a distributable desktop app

Decision (locked): **Tauri** desktop shell wrapping the existing web UI, with the
Python engine bundled as a **PyInstaller sidecar**. AI is optional (template
default), so the installer has no hard external dependency.

```
┌─────────────────────────── Tauri app (.msi / .exe) ───────────────────────────┐
│  WebView2 window ── loads the web UI (src/investraton/web, served by sidecar)  │
│        │                                                                        │
│        ▼  http://127.0.0.1:<port>/api/*                                         │
│  Python sidecar  ── investraton-api.exe (PyInstaller one-file)                  │
│        └─ the whole engine: ingest, look-through, scoring, brain, store         │
└────────────────────────────────────────────────────────────────────────────────┘
```

Why this shape: the engine stays pure Python (no rewrite), the UI is already built
and verified, and Tauri gives a tiny native installer with WebView2 (already on
Win11). The sidecar is the only "glue" to add.

## Current status

- ✅ Web UI + FastAPI backend built and verified in the browser (`investraton app`).
- ✅ Settings are file-backed (`config/app_settings.json`) so the GUI manages config.
- ⏳ Tauri shell + PyInstaller sidecar — **needs Rust installed** (`cargo`/`rustc`
  are not yet present on this machine).

## Steps to build the desktop app (when ready)

1. **Install prerequisites**
   - Rust (rustup) + the MSVC build tools.  Node is already present.
   - `npm create tauri-app@latest` (or add Tauri to an `app/` folder).

2. **Freeze the Python engine into a sidecar binary**
   ```powershell
   .\.venv\Scripts\python.exe -m pip install pyinstaller
   pyinstaller --onefile --name investraton-api ^
     --add-data "src/investraton/web;investraton/web" ^
     --collect-all yfinance --collect-all feedparser ^
     src/investraton/api_entry.py
   ```
   (A thin `api_entry.py` that calls `investraton.api.main()`; `--add-data` bundles
   the web assets. PyInstaller hidden-imports may be needed for uvicorn workers.)

3. **Register the sidecar in Tauri**
   - Copy `dist/investraton-api.exe` to `app/src-tauri/binaries/investraton-api-<target-triple>.exe`.
   - In `tauri.conf.json`: add it under `bundle.externalBin`, and on app startup
     spawn it via the Tauri shell sidecar API; point the WebView at its localhost URL
     (or have Tauri serve the static UI and only proxy `/api`).

4. **Data location for distribution**
   - Move `data/` and `config/` reads/writes to the OS app-data dir
     (`%APPDATA%/Investraton`) instead of the repo folder, so installed copies are
     per-user and writable. (Add an `INVESTRATON_HOME` override in `config.py`.)

5. **Build the installer**
   - `npm run tauri build` → produces `.msi` / `.exe` (NSIS) under
     `app/src-tauri/target/release/bundle/`.

## Pre-distribution checklist

- [ ] `INVESTRATON_HOME` so data/config live in `%APPDATA%`, not the install dir.
- [ ] First-run onboarding (empty holdings → guide to add positions).
- [ ] Bundle the iShares registry; handle no-network gracefully (already does).
- [ ] App icon + name + version metadata.
- [ ] Code signing (optional but "professional"): a cert removes the SmartScreen warning.
- [ ] License / disclaimer ("not investment advice").

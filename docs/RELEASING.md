# Releasing INVESTigator — manual checklist

Everything code-side is done. This is the list of **manual** things *you* do to ship a release:
bump the version, build the three artifacts, tag, create a GitHub Release, and turn on the website.

The download buttons in the README and on the site both point to
`https://github.com/Joao-Serrao/INVESTigator/releases` — they only work **once a Release exists**, so
step 4 is what makes them live.

---

## 1. Bump the version (only when you cut a new version)

Keep these three in sync, then commit:

| File | Field |
| --- | --- |
| `desktop-ts/src-tauri/tauri.conf.json` | `"version"` |
| `desktop-ts/package.json` | `"version"` |
| `engine/package.json` | `"version"` |

For the first public release you'll probably go `0.1.0` → `1.0.0`. The tag in step 3 should match
(`v1.0.0`).

---

## 2. Build the three artifacts

Run all builds from **PowerShell** (not the bash shell — Tauri's pre-build step needs Node on `PATH`).

### Windows installers (`.exe` + `.msi`)
```powershell
cd desktop-ts
npm install
npm run tauri -- build
```
Outputs (names follow the version automatically):
- `desktop-ts/src-tauri/target/release/bundle/nsis/INVESTigator_<version>_x64-setup.exe`  ← the main one
- `desktop-ts/src-tauri/target/release/bundle/msi/INVESTigator_<version>_x64_en-US.msi`

### Android APK
Set the toolchain env once per shell, then build:
```powershell
$env:ANDROID_HOME     = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = "$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME         = "$env:LOCALAPPDATA\Android\Sdk\ndk\26.3.11579264"
$env:JAVA_HOME        = "C:\Program Files\Java\jdk-21"
cd desktop-ts
npm run tauri -- android build --debug --apk --target aarch64
```
Output:
- `desktop-ts/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`

**Rename it before uploading** so people know what it is, e.g. `INVESTigator-<version>.apk`.

> **Debug vs signed release APK.** The command above builds a *debug* APK — it installs fine (users tap
> "allow install from unknown apps") and is the simplest thing to ship for a hobby project. It is **not**
> signed with a release key, so Play Protect may warn. If you later want a signed release build, create a
> keystore, add a `signingConfig` to `gen/android/app/build.gradle.kts`, and run the same command with
> `--release` instead of `--debug`. Not required to publish.

Quick sanity check on both installers/APK: install on a clean machine/phone, run one digest.

---

## 3. Tag the release
```bash
git tag v1.0.0        # match the version from step 1
git push origin v1.0.0
```
(Push your normal commits first; the tag should point at the commit you built from.)

---

## 4. Create the GitHub Release + upload the artifacts

**Web UI:** GitHub → **Releases** → **Draft a new release** → pick tag `v1.0.0` → title
`INVESTigator v1.0.0` → write a short changelog → **drag in the three files** (the `.exe`, the `.msi`,
and the renamed `.apk`) → **Publish**.

**Or with the CLI:**
```bash
gh release create v1.0.0 \
  "desktop-ts/src-tauri/target/release/bundle/nsis/INVESTigator_1.0.0_x64-setup.exe" \
  "desktop-ts/src-tauri/target/release/bundle/msi/INVESTigator_1.0.0_x64_en-US.msi" \
  "INVESTigator-1.0.0.apk" \
  --title "INVESTigator v1.0.0" --notes "First public release."
```

The moment this is published, both **Download for Windows** and **Download for Android (APK)** buttons
resolve. (Optional polish: point the buttons at `…/releases/latest` instead of `…/releases` so they
always jump to the newest one.)

---

## 5. Turn on the website (GitHub Pages)

The site lives in [`docs/`](.) and is ready to serve.

GitHub → **Settings → Pages** → *Build and deployment* → **Source: Deploy from a branch** →
**Branch: `main`, folder `/docs`** → **Save**.

After a minute it's live at:
```
https://joao-serrao.github.io/INVESTigator/
```
Open it and confirm the images load (the four `mobile-*.png` and the desktop shots).

---

## 6. Repo "About" (top-right of the repo page)

Click the ⚙️ next to **About** and set:
- **Description:** `Personal investment intelligence for desktop & Android — decodes what's really inside your ETFs and sends a calm, noise-filtered briefing. Never buy/sell advice.`
- **Website:** `https://joao-serrao.github.io/INVESTigator/`
- **Topics:** `investing` `etf` `portfolio` `tauri` `typescript` `rust` `android` `windows` `personal-finance` `open-source`

---

## Quick copy-paste checklist

- [ ] Bump version in the 3 files (step 1) + commit + push
- [ ] Build `.exe` + `.msi` (PowerShell)
- [ ] Build + rename `.apk`
- [ ] `git tag vX.Y.Z && git push origin vX.Y.Z`
- [ ] Draft Release, upload the 3 files, publish
- [ ] Settings → Pages → main `/docs`
- [ ] Fill in About (description, website, topics)
- [ ] Open the site + both download buttons, confirm they work

---

### Notes / gotchas
- **SmartScreen** warns on the `.exe` because it isn't code-signed → *More info → Run anyway*. Signing
  costs money; fine to skip for now. (This is already explained in the README Install section.)
- **Screenshots are safe to publish**: the desktop ones use demo data; the mobile ones are a real run
  with the portfolio total blurred out. If you'd rather show clean demo numbers, re-take the phone
  screenshots against a dummy portfolio and overwrite the `docs/screenshots/mobile-*.png` files.
- **Nothing about a broker or API key ships** in any artifact — all secrets live in `%APPDATA%\Investraton`
  at runtime and are excluded from Backup & transfer.

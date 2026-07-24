# Builds the distributable Investraton desktop app end-to-end:
#   1. Freezes the Python engine into a windowed single-exe (PyInstaller)
#   2. Copies it into the Tauri sidecar slot (with the rustc host target triple)
#   3. Builds the Tauri installer (.exe / .msi)
#
# Prereqs (already set up on this machine): Python venv, Rust (cargo/rustc),
# MSVC Build Tools, Node, the Tauri CLI (npm i -g @tauri-apps/cli), PyInstaller.
#
# Usage:  powershell -ExecutionPolicy Bypass -File packaging\build.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root ".venv\Scripts\python.exe"
$cargoBin = "$env:USERPROFILE\.cargo\bin"
$env:Path = "$cargoBin;$env:Path"
$tauri = "$env:APPDATA\npm\tauri.cmd"

Write-Host "==> 1/3  Freezing the Python engine (PyInstaller, windowed one-file)..." -ForegroundColor Cyan
& $py -m PyInstaller --noconfirm --onefile --windowed --name investraton-app `
  --distpath  (Join-Path $root "packaging\dist") `
  --workpath  (Join-Path $root "packaging\build") `
  --specpath  (Join-Path $root "packaging") `
  --paths     (Join-Path $root "src") `
  --add-data  ((Join-Path $root "src\investraton\web") + ";investraton/web") `
  --add-data  ((Join-Path $root "config\etf_sources.yaml") + ";config") `
  --add-data  ((Join-Path $root "config\portfolio_plan.example.yaml") + ";config") `
  --collect-all uvicorn --collect-all yfinance --collect-all feedparser --collect-all fastapi `
  --collect-submodules investraton `
  (Join-Path $root "packaging\app_entry.py")

Write-Host "==> 2/3  Placing the sidecar for Tauri..." -ForegroundColor Cyan
$triple = ((& "$cargoBin\rustc.exe" -Vv) | Select-String 'host:').ToString().Split(':')[1].Trim()
$dst = Join-Path $root "desktop\src-tauri\binaries\investraton-app-$triple.exe"
New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
Copy-Item (Join-Path $root "packaging\dist\investraton-app.exe") $dst -Force
Write-Host "    sidecar -> investraton-app-$triple.exe"

Write-Host "==> 3/3  Building the Tauri installer..." -ForegroundColor Cyan
Push-Location (Join-Path $root "desktop")
& $tauri build
Pop-Location

Write-Host "`nDone. Installers are under desktop\src-tauri\target\release\bundle\" -ForegroundColor Green

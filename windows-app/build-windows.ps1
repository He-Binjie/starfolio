# Build Starfolio (星海拾卷) Windows x64 Desktop App + Portable ZIP + Inno Setup Installer
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$DistRoot = Join-Path $Root "dist"
$WinAppDist = Join-Path $DistRoot "win-app"
$WinModels = Join-Path $DistRoot "win-models"
$PyiWork = Join-Path $DistRoot "pyi-win-work"

Write-Host "=== 1/6 Build React frontend ===" -ForegroundColor Cyan
Push-Location (Join-Path $Root "frontend")
pnpm install
pnpm build
Pop-Location

Write-Host "=== 2/6 Ensure offline BGE Chinese embedding model (dereferenced, zero symlinks) ===" -ForegroundColor Cyan
$RawModelCache = Join-Path $DistRoot "raw-models"
New-Item -ItemType Directory -Force -Path $RawModelCache, $WinModels | Out-Null
python -c @"
import os, shutil
from pathlib import Path
from fastembed import TextEmbedding

raw_cache = Path(r'$RawModelCache')
out_root = Path(r'$WinModels')
os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'
_ = TextEmbedding(model_name='BAAI/bge-small-zh-v1.5', cache_dir=str(raw_cache))

for mdir in raw_cache.glob('models--*'):
    if not mdir.is_dir():
        continue
    out_m = out_root / mdir.name
    out_m.mkdir(parents=True, exist_ok=True)
    for sub in ('refs', 'trees'):
        if (mdir / sub).exists():
            shutil.copytree(mdir / sub, out_m / sub, dirs_exist_ok=True)
    for f in mdir.iterdir():
        if f.is_file():
            shutil.copy2(f, out_m / f.name)
    snaps = mdir / 'snapshots'
    if snaps.exists():
        for rev in snaps.iterdir():
            if not rev.is_dir():
                continue
            out_rev = out_m / 'snapshots' / rev.name
            out_rev.mkdir(parents=True, exist_ok=True)
            for item in rev.iterdir():
                real_src = item.resolve()
                if real_src.is_file():
                    shutil.copy2(real_src, out_rev / item.name)
print('Clean offline embedding model ready at', out_root)
"@

Write-Host "=== 3/6 Generate Windows .ico from icon.svg ===" -ForegroundColor Cyan
python (Join-Path $Root "windows-app\make_ico.py")

Write-Host "=== 4/6 Package Starfolio.exe via PyInstaller ===" -ForegroundColor Cyan
if (Test-Path $WinAppDist) { Remove-Item -Recurse -Force $WinAppDist }
if (Test-Path $PyiWork) { Remove-Item -Recurse -Force $PyiWork }

pyinstaller `
  --onedir `
  --windowed `
  --noconfirm `
  --clean `
  --name Starfolio `
  --icon (Join-Path $Root "windows-app\starfolio.ico") `
  --distpath $WinAppDist `
  --workpath $PyiWork `
  --specpath $PyiWork `
  --paths (Join-Path $Root "backend") `
  --add-data "$(Join-Path $Root 'frontend\dist');frontend-dist" `
  --add-data "$WinModels;models" `
  --add-data "$(Join-Path $Root 'macos-app\sample-kb');sample-kb" `
  --hidden-import uvicorn.logging `
  --hidden-import uvicorn.loops `
  --hidden-import uvicorn.loops.auto `
  --hidden-import uvicorn.protocols `
  --hidden-import uvicorn.protocols.http `
  --hidden-import uvicorn.protocols.http.auto `
  --hidden-import uvicorn.protocols.http.h11_impl `
  --hidden-import uvicorn.protocols.websockets `
  --hidden-import uvicorn.protocols.websockets.auto `
  --hidden-import uvicorn.lifespan `
  --hidden-import uvicorn.lifespan.on `
  --hidden-import fastembed `
  --hidden-import onnxruntime `
  --hidden-import tokenizers `
  --hidden-import huggingface_hub `
  --hidden-import pymupdf `
  --hidden-import docx `
  --hidden-import openpyxl `
  --hidden-import watchdog.observers.read_directory_changes `
  --hidden-import httpx `
  --hidden-import yaml `
  --hidden-import webview `
  --collect-all fastembed `
  --collect-all onnxruntime `
  --collect-all tokenizers `
  --collect-all webview `
  --collect-all pythonnet `
  --collect-all clr_loader `
  (Join-Path $Root "windows-app\starfolio_win.py")

Write-Host "=== 5/6 Clean-room E2E smoke test on compiled Starfolio.exe ===" -ForegroundColor Cyan
$ExePath = Join-Path $WinAppDist "Starfolio\Starfolio.exe"
$proc = Start-Process -FilePath $ExePath -ArgumentList "--smoke-test" -NoNewWindow -Wait -PassThru
if ($proc.ExitCode -ne 0) {
    throw "Starfolio.exe --smoke-test failed with exit code $($proc.ExitCode)"
}

Write-Host "=== 6/6 Create Portable ZIP & Inno Setup Installer ===" -ForegroundColor Cyan
$PortableZip = Join-Path $DistRoot "Starfolio-Windows-x64-v1.8-Portable.zip"
if (Test-Path $PortableZip) { Remove-Item -Force $PortableZip }
Compress-Archive -Path (Join-Path $WinAppDist "Starfolio") -DestinationPath $PortableZip -CompressionLevel Optimal

$Iscc = Get-Command iscc -ErrorAction SilentlyContinue
if ($Iscc) {
    & iscc (Join-Path $Root "windows-app\installer.iss")
} else {
    Write-Warning "Inno Setup (iscc) not found in PATH; skipped Setup.exe (Portable ZIP is ready)."
}

Write-Host "WINDOWS BUILD COMPLETE!" -ForegroundColor Green
Get-ChildItem $DistRoot -Filter "Starfolio-Windows-*" | Format-Table Name, Length

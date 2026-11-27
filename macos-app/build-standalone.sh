#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="星海拾卷"
BUNDLE_ID="local.kbconsole.standalone"
OUT_ROOT="$ROOT/dist/standalone"
APP_DIR="$OUT_ROOT/${APP_NAME}.app"
DMG_PATH="$ROOT/dist/星海拾卷-AppleSilicon-v1.8.dmg"
PYI_WORK="/tmp/kbconsole_pyi_build"
PYI_DIST="/tmp/kbconsole_pyi_dist"

echo "=== 1/7 Build React frontend bundle ==="
(
  cd "$ROOT/frontend"
  ./node_modules/.bin/tsc
  ./node_modules/.bin/vite build
)

echo "=== 2/7 Package standalone Python backend (PyInstaller arm64) ==="
rm -rf "$PYI_WORK" "$PYI_DIST" /tmp/kbconsole_pyi_cache
export PYINSTALLER_CONFIG_DIR="/tmp/kbconsole_pyi_cache"
"$ROOT/.venv/bin/pyinstaller" \
  --onedir \
  --noconfirm \
  --clean \
  --name kb-backend \
  --distpath "$PYI_DIST" \
  --workpath "$PYI_WORK" \
  --specpath "$PYI_WORK" \
  --paths "$ROOT/backend" \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.loops \
  --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols \
  --hidden-import uvicorn.protocols.http \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.http.h11_impl \
  --hidden-import uvicorn.protocols.websockets \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan \
  --hidden-import uvicorn.lifespan.on \
  --hidden-import fastembed \
  --hidden-import onnxruntime \
  --hidden-import tokenizers \
  --hidden-import huggingface_hub \
  --hidden-import pymupdf \
  --hidden-import docx \
  --hidden-import openpyxl \
  --hidden-import watchdog.observers.fsevents \
  --hidden-import watchdog.observers.kqueue \
  --hidden-import httpx \
  --hidden-import yaml \
  --collect-all fastembed \
  --collect-all onnxruntime \
  --collect-all tokenizers \
  "$ROOT/backend/standalone_entry.py"

echo "=== 3/7 Compile Apple Silicon (arm64) Swift native shell ==="
rm -rf "$OUT_ROOT"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

swiftc \
  -target arm64-apple-macosx14.0 \
  -O \
  -module-cache-path /tmp/swift-module-cache \
  -framework AppKit \
  -framework WebKit \
  -framework Carbon \
  "$ROOT/macos-app/main-standalone.swift" \
  -o "$APP_DIR/Contents/MacOS/KBConsole"

echo "=== 4/7 Assemble standalone Resources (backend + frontend + offline BGE model + sample-kb + icon) ==="
cp -R "$PYI_DIST/kb-backend" "$APP_DIR/Contents/Resources/backend"
cp -R "$ROOT/frontend/dist" "$APP_DIR/Contents/Resources/frontend-dist"
cp -R "$ROOT/macos-app/sample-kb" "$APP_DIR/Contents/Resources/sample-kb"

# Copy ONLY clean offline embedding model files (dereference symlinks cleanly, no duplicate blobs, never DB)
mkdir -p "$APP_DIR/Contents/Resources/models"
"$ROOT/.venv/bin/python3" - "$ROOT/data/models" "$APP_DIR/Contents/Resources/models" <<'EOF'
import shutil, sys
from pathlib import Path

src_root = Path(sys.argv[1])
dst_root = Path(sys.argv[2])
for mdir in src_root.glob("models--*"):
    if not mdir.is_dir():
        continue
    out_m = dst_root / mdir.name
    out_m.mkdir(parents=True, exist_ok=True)
    for sub in ("refs", "trees"):
        if (mdir / sub).exists():
            shutil.copytree(mdir / sub, out_m / sub, dirs_exist_ok=True)
    for f in mdir.iterdir():
        if f.is_file():
            shutil.copy2(f, out_m / f.name)
    snaps = mdir / "snapshots"
    if snaps.exists():
        for rev in snaps.iterdir():
            if not rev.is_dir():
                continue
            out_rev = out_m / "snapshots" / rev.name
            out_rev.mkdir(parents=True, exist_ok=True)
            for item in rev.iterdir():
                real_src = item.resolve()
                if real_src.is_file():
                    shutil.copy2(real_src, out_rev / item.name)
print("Copied clean dereferenced offline embedding model to", dst_root)
EOF

"$ROOT/.venv/bin/python3" - "$APP_DIR/Contents/Resources/AppIcon.icns" "$ROOT/macos-app/icon.svg" <<'EOF'
import struct, sys, pymupdf as fitz
from pathlib import Path

out_path = Path(sys.argv[1])
svg = Path(sys.argv[2]).read_bytes()
doc = fitz.open(stream=svg, filetype="svg")
page = doc.load_page(0)
rect = page.rect

chunks_spec = [
    (b"icp4", 16), (b"icp5", 32), (b"icp6", 64), (b"ic07", 128),
    (b"ic11", 32), (b"ic12", 64), (b"ic13", 256), (b"ic08", 256),
    (b"ic14", 512), (b"ic09", 512), (b"ic10", 1024),
]
png_cache = {}
body = bytearray()
for tag, px in chunks_spec:
    if px not in png_cache:
        pix = page.get_pixmap(matrix=fitz.Matrix(px / rect.width, px / rect.height), alpha=True)
        png_cache[px] = pix.tobytes("png")
    data = png_cache[px]
    body.extend(tag)
    body.extend(struct.pack(">I", len(data) + 8))
    body.extend(data)

out_path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + bytes(body))
print(f"Wrote AppIcon.icns ({out_path.stat().st_size} bytes)")
EOF

echo "=== 5/7 Write Info.plist ==="
cat > "$APP_DIR/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleVersion</key>
    <string>1.8.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.8.0</string>
    <key>CFBundleExecutable</key>
    <string>KBConsole</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>LSArchitecturePriority</key>
    <array>
        <string>arm64</string>
    </array>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
</dict>
</plist>
EOF

echo "=== 6/7 Ad-hoc codesign standalone bundle ==="
codesign --force --deep --sign - "$APP_DIR"

echo "=== 7/7 Privacy audit & DMG packaging ==="
if find "$APP_DIR" -name "*.db" -o -name "config.yaml" | grep -q .; then
  echo "ERROR: Personal DB or config.yaml leaked into standalone .app!"
  exit 1
fi
if [ -n "${KB_PRIVACY_AUDIT_REGEX:-}" ] && rg -n "$KB_PRIVACY_AUDIT_REGEX" "$APP_DIR/Contents/Resources/frontend-dist" "$APP_DIR/Contents/Resources/sample-kb" >/dev/null 2>&1; then
  echo "ERROR: Private string leaked into frontend-dist or sample-kb!"
  exit 1
fi

if [ "${1:-}" != "--skip-dmg" ]; then
  STAGING="/tmp/kbconsole_standalone_dmg_staging"
  rm -rf "$STAGING" "$DMG_PATH"
  mkdir -p "$STAGING"
  cp -R "$APP_DIR" "$STAGING/"
  ln -s /Applications "$STAGING/Applications"
  hdiutil create -volname "${APP_NAME} v1.8" -srcfolder "$STAGING" -ov -format UDZO "$DMG_PATH" >/dev/null
  rm -rf "$STAGING"
  ls -lh "$DMG_PATH"
fi
rm -rf "$PYI_WORK" "$PYI_DIST"

du -sh "$APP_DIR"
echo "STANDALONE BUILD COMPLETE: $APP_DIR"

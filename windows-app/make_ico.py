"""Convert macos-app/icon.svg into a crisp multi-resolution Windows .ico file."""
from __future__ import annotations

import io
import sys
from pathlib import Path

import pymupdf as fitz
from PIL import Image


def build_ico(svg_path: Path, out_ico: Path) -> None:
    svg_bytes = svg_path.read_bytes()
    doc = fitz.open(stream=svg_bytes, filetype="svg")
    page = doc.load_page(0)
    rect = page.rect

    # Render at 512x512 high-res RGBA, then let Pillow generate all crisp ICO mipmaps
    pix = page.get_pixmap(matrix=fitz.Matrix(512 / rect.width, 512 / rect.height), alpha=True)
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGBA")

    out_ico.parent.mkdir(parents=True, exist_ok=True)
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    img.save(out_ico, format="ICO", sizes=sizes)
    print(f"Wrote {out_ico} ({out_ico.stat().st_size} bytes)")


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    svg = Path(sys.argv[1]) if len(sys.argv) > 1 else (root / "macos-app" / "icon.svg")
    ico = Path(sys.argv[2]) if len(sys.argv) > 2 else (root / "windows-app" / "starfolio.ico")
    build_ico(svg, ico)

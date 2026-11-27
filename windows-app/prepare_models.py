"""Download BAAI/bge-small-zh-v1.5 via fastembed and copy dereferenced files (zero symlinks) for bundling."""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from fastembed import TextEmbedding


def prepare_models(raw_cache: Path, out_root: Path) -> None:
    raw_cache.mkdir(parents=True, exist_ok=True)
    out_root.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
    _ = TextEmbedding(model_name="BAAI/bge-small-zh-v1.5", cache_dir=str(raw_cache))

    copied = 0
    for mdir in raw_cache.glob("models--*"):
        if not mdir.is_dir():
            continue
        out_m = out_root / mdir.name
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
                        copied += 1
    if copied == 0:
        raise RuntimeError(f"No model snapshot files were copied from {raw_cache}")
    print(f"Prepared clean offline BGE model ({copied} snapshot files) at {out_root}")


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    raw = Path(sys.argv[1]) if len(sys.argv) > 1 else (root / "dist" / "raw-models")
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else (root / "dist" / "win-models")
    prepare_models(raw, out)

"""PyInstaller standalone entrypoint for kb-console backend."""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Ensure backend package resolves cleanly inside PyInstaller bundle or source tree
if getattr(sys, "frozen", False):
    BASE_DIR = Path(sys._MEIPASS)
else:
    BASE_DIR = Path(__file__).resolve().parent

if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

os.environ.setdefault("KB_CONSOLE_EDITION", "standalone")

import uvicorn
from app.main import app, cfg


def main() -> None:
    uvicorn.run(
        app,
        host=cfg.host,
        port=cfg.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()

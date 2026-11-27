from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Callable

from .config import AppConfig


class DebouncedFileWatcher:
    """Read-only filesystem watcher with 5s debounce to trigger incremental index + vector sync."""

    def __init__(
        self,
        cfg: AppConfig,
        on_change: Callable[[], None],
        debounce_seconds: float = 5.0,
    ) -> None:
        self.cfg = cfg
        self.on_change = on_change
        self.debounce_seconds = debounce_seconds
        self._observer = None
        self._timer_lock = threading.Lock()
        self._timer: threading.Timer | None = None
        self.active = False
        self.last_event_at: float | None = None

    def _schedule(self) -> None:
        self.last_event_at = time.time()
        with self._timer_lock:
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(self.debounce_seconds, self._fire)
            self._timer.daemon = True
            self._timer.start()

    def _fire(self) -> None:
        try:
            self.on_change()
        except Exception:
            pass

    def _is_relevant_path(self, raw_path: str) -> bool:
        p = Path(raw_path)
        if p.suffix.lower() not in self.cfg.allowed_extensions:
            return False
        for part in p.parts:
            if part in self.cfg.exclude_dir_names or part.startswith("."):
                return False
            for suf in self.cfg.exclude_dir_suffixes:
                if part.endswith(suf):
                    return False
        try:
            if self.cfg.is_path_excluded(p):
                return False
        except Exception:
            return False
        return True

    def start(self) -> bool:
        try:
            from watchdog.events import FileSystemEventHandler
            from watchdog.observers import Observer
        except ImportError:
            self.active = False
            return False

        watcher = self

        class _Handler(FileSystemEventHandler):
            def on_any_event(self, event):
                if getattr(event, "is_directory", False):
                    return
                src_path = getattr(event, "src_path", "") or ""
                dest_path = getattr(event, "dest_path", "") or ""
                if watcher._is_relevant_path(src_path) or (dest_path and watcher._is_relevant_path(dest_path)):
                    watcher._schedule()

        observer = Observer()
        handler = _Handler()
        scheduled = 0
        watched_file_dirs: set[str] = set()
        folder_roots: set[str] = set()
        for src in self.cfg.sources:
            if src.kind == "files":
                for fp in src.files:
                    parent = fp.expanduser().parent
                    if parent.exists():
                        p_str = str(parent.resolve())
                        if p_str not in watched_file_dirs and p_str not in folder_roots:
                            try:
                                observer.schedule(handler, p_str, recursive=False)
                                watched_file_dirs.add(p_str)
                                scheduled += 1
                            except Exception:
                                pass
            elif src.path.exists():
                try:
                    p_str = str(src.path.resolve())
                    observer.schedule(handler, p_str, recursive=True)
                    folder_roots.add(p_str)
                    scheduled += 1
                except Exception:
                    pass
        if scheduled == 0:
            return False
        observer.daemon = True
        observer.start()
        self._observer = observer
        self.active = True
        return True

    def stop(self) -> None:
        with self._timer_lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
        if self._observer is not None:
            try:
                self._observer.stop()
                self._observer.join(timeout=3)
            except Exception:
                pass
            self._observer = None
        self.active = False

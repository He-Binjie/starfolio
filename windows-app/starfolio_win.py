"""Starfolio (星海拾卷) native Windows desktop launcher.

Single-process desktop shell:
- Embedded FastAPI + SQLite FTS5 + FastEmbed local BGE vector server on localhost
- Native Edge WebView2 desktop window via pywebview (zero Electron bloat)
- Native Windows file/folder multi-select dialogs & Explorer drag-drop support
- Built-in `--smoke-test` clean-room E2E verification mode for CI & local QA
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


def _default_data_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "Starfolio"
    return Path.home() / ".local" / "share" / "starfolio"


def _resource_root() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent.parent


def _configure_logging_streams(data_dir: Path) -> None:
    """In PyInstaller --windowed mode on Windows, sys.stdout/stderr are None.
    Redirect them to a UTF-8 log file before importing FastAPI/uvicorn."""
    data_dir.mkdir(parents=True, exist_ok=True)
    log_path = data_dir / "starfolio.log"
    if sys.stdout is None:
        sys.stdout = open(log_path, "a", encoding="utf-8", buffering=1)
    if sys.stderr is None:
        sys.stderr = open(log_path, "a", encoding="utf-8", buffering=1)


def _find_free_port(start: int = 18766, end: int = 18799) -> int:
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _configure_env(port: int, data_dir: Path) -> None:
    res = _resource_root()
    os.environ.setdefault("KB_CONSOLE_EDITION", "standalone")
    os.environ["KB_CONSOLE_DATA_DIR"] = str(data_dir)
    os.environ["KB_CONSOLE_PORT"] = str(port)
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    frontend_candidates = [res / "frontend-dist", res / "frontend" / "dist"]
    for cand in frontend_candidates:
        if (cand / "index.html").exists():
            os.environ.setdefault("KB_CONSOLE_FRONTEND_DIR", str(cand))
            break

    model_candidates = [res / "models", res / "dist" / "win-models", res / "data" / "models"]
    for cand in model_candidates:
        if cand.exists() and any(cand.glob("models--*")):
            os.environ.setdefault("KB_CONSOLE_BUNDLED_MODEL_DIR", str(cand))
            break

    sample_candidates = [res / "sample-kb", res / "macos-app" / "sample-kb"]
    for cand in sample_candidates:
        if cand.exists():
            os.environ.setdefault("KB_CONSOLE_SAMPLE_KB_DIR", str(cand))
            break

    # Ensure backend package is importable in dev mode
    backend_dir = res / "backend"
    if backend_dir.exists() and str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))


_LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _wait_for_server(port: int, timeout_s: float = 35.0) -> bool:
    url = f"http://127.0.0.1:{port}/api/index/status"
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with _LOCAL_OPENER.open(url, timeout=1.5) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            time.sleep(0.2)
    return False


def _start_embedded_server(port: int):
    import traceback
    import uvicorn
    from app.main import app as fastapi_app

    config = uvicorn.Config(
        fastapi_app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        access_log=False,
        log_config=None,
    )
    server = uvicorn.Server(config)
    server.install_signal_handlers = lambda: None  # type: ignore[method-assign]

    def _run() -> None:
        try:
            server.run()
        except Exception:
            traceback.print_exc()

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return server, t


def _http_json(base_url: str, path: str, method: str = "GET", payload: dict[str, Any] | None = None) -> Any:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if payload is not None else {}
    req = urllib.request.Request(f"{base_url}{path}", data=data, headers=headers, method=method)
    with _LOCAL_OPENER.open(req, timeout=60) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw)


def _run_smoke_test() -> int:
    """Clean-room E2E verification executed directly on the compiled Windows binary."""
    tmp_root = Path(tempfile.mkdtemp(prefix="starfolio_win_smoke_"))
    data_dir = tmp_root / "data"
    loose_dir = tmp_root / "loose_docs"
    loose_dir.mkdir(parents=True, exist_ok=True)
    port = _find_free_port(19100, 19200)
    base_url = f"http://127.0.0.1:{port}"

    print(f"[SMOKE] Starting Starfolio clean-room Windows E2E on port {port}...")
    _configure_env(port, data_dir)
    server, _ = _start_embedded_server(port)
    try:
        if not _wait_for_server(port, timeout_s=45.0):
            raise RuntimeError("Embedded backend did not become ready within 45s")

        # 1. Verify bundled frontend SPA is served
        with _LOCAL_OPENER.open(f"{base_url}/", timeout=10) as resp:
            html = resp.read().decode("utf-8")
            assert resp.status == 200 and 'id="root"' in html, "Frontend index.html missing root mount"
        print("[SMOKE] 1/6 Bundled React frontend verified.", flush=True)

        # 2. Verify /api/meta
        meta = _http_json(base_url, "/api/meta")
        assert meta["version"] == "1.8.0", f"Unexpected version: {meta['version']}"
        assert meta["read_only"] is True, "read_only flag must be True"
        print(f"[SMOKE] 2/6 /api/meta ok (platform={meta.get('platform')}, edition={meta.get('edition')}).")

        # 3. Load bundled sample-kb + offline BGE embeddings + conflict scan
        sample_res = _http_json(base_url, "/api/settings/load-sample", method="POST", payload={})
        assert sample_res.get("ok") is True, f"load-sample failed: {sample_res}"
        vec_st = _http_json(base_url, "/api/vectors/status")
        assert vec_st["total_chunks"] > 0, "Expected indexed chunks from sample-kb"
        assert vec_st["coverage_pct"] >= 99.0, f"Offline BGE embedding did not finish cleanly: {vec_st}"
        print(
            f"[SMOKE] 3/6 Sample KB + offline BGE embedding ok "
            f"(chunks={vec_st['total_chunks']}, coverage={vec_st['coverage_pct']}%)."
        )

        # 4. Loose-file zero-copy intake (.html + .md) on Windows paths
        f_html = loose_dir / "客户访谈摘要.html"
        f_md = loose_dir / "Q3交付口径说明.md"
        f_html.write_text(
            "<html><head><title>客户访谈摘要</title></head>"
            "<body><h1>交付周期访谈</h1><p>客户确认标准交付周期为 5 天，安全库存覆盖 14 天。</p></body></html>",
            encoding="utf-8",
        )
        f_md.write_text(
            "# Q3 交付口径说明\n\n参考 [客户访谈摘要](./客户访谈摘要.html)，核心指标覆盖率 98.5%。\n",
            encoding="utf-8",
        )
        add_res = _http_json(
            base_url,
            "/api/settings/sources/add-paths",
            method="POST",
            payload={"paths": [str(f_html), str(f_md)]},
        )
        assert len(add_res["added_files"]) == 2, f"Expected 2 loose files added: {add_res}"

        # Wait for async incremental index to pick up loose files
        deadline = time.time() + 25.0
        indexed_docs = 0
        while time.time() < deadline:
            st = _http_json(base_url, "/api/index/status")
            indexed_docs = st["totals"]["documents"]
            if indexed_docs >= 5 and not st["progress"]["running"]:
                break
            time.sleep(0.4)
        assert indexed_docs >= 5, f"Expected >=5 indexed docs, got {indexed_docs}"
        print(f"[SMOKE] 4/6 Loose HTML + MD intake ok (total docs={indexed_docs}).")

        # 5. Hybrid search + POSIX rel_path check + StarMap + Lineage
        q_enc = urllib.parse.quote("交付周期")
        search_res = _http_json(base_url, f"/api/search?q={q_enc}&mode=hybrid")
        assert len(search_res["items"]) > 0, "Expected hybrid search hits"
        for it in search_res["items"]:
            assert "\\" not in it["rel_path"], f"Windows backslash leaked into rel_path: {it['rel_path']}"
        first = search_res["items"][0]
        lin = _http_json(
            base_url,
            f"/api/document/lineage?source_id={urllib.parse.quote(first['source_id'])}&rel_path={urllib.parse.quote(first['rel_path'])}",
        )
        assert lin.get("current") is not None, "Lineage endpoint returned empty current doc"
        sm = _http_json(base_url, "/api/projects/starmap")
        assert len(sm.get("nodes") or []) >= 3, f"StarMap nodes missing: {sm}"
        print(
            f"[SMOKE] 5/6 Hybrid search, POSIX rel_path, Lineage & StarMap ok "
            f"(hits={len(search_res['items'])}, starmap_nodes={len(sm['nodes'])})."
        )

        # 6. Remove loose file from index while verifying original disk file is untouched
        rm_res = _http_json(
            base_url,
            "/api/settings/sources/remove-file",
            method="POST",
            payload={"source_id": "picked-files", "file_path": str(f_html)},
        )
        assert rm_res.get("ok") is True and f_html.exists(), "Original loose file must stay untouched on disk!"
        print("[SMOKE] 6/6 Strict read-only removal verified. ALL WINDOWS E2E CHECKS PASSED!")
        return 0
    finally:
        server.should_exit = True
        time.sleep(0.4)
        shutil.rmtree(tmp_root, ignore_errors=True)


class WinNativeBridge:
    """JS-callable bridge exposed as `window.pywebview.api`."""

    def __init__(self) -> None:
        self._window: Any = None

    def attach(self, window: Any) -> None:
        self._window = window

    def pick_paths(self, mode: str = "files") -> list[str]:
        import webview

        if self._window is None:
            return []

        fd_enum = getattr(webview, "FileDialog", None)
        open_dialog = fd_enum.OPEN if fd_enum is not None else webview.OPEN_DIALOG
        folder_dialog = fd_enum.FOLDER if fd_enum is not None else webview.FOLDER_DIALOG

        if mode == "folder":
            result = self._window.create_file_dialog(folder_dialog, allow_multiple=False)
        else:
            file_types = (
                "支持文档 (*.md;*.txt;*.pdf;*.docx;*.pptx;*.xlsx;*.csv;*.html;*.htm;*.json;*.yaml;*.yml)",
                "所有文件 (*.*)",
            )
            result = self._window.create_file_dialog(
                open_dialog,
                allow_multiple=True,
                file_types=file_types,
            )

        if not result:
            return []
        return [str(p) for p in result if p]


def _run_desktop_gui() -> int:
    data_dir = _default_data_dir()
    _configure_logging_streams(data_dir)
    port = _find_free_port(18766, 18799)
    _configure_env(port, data_dir)

    server, _ = _start_embedded_server(port)
    if not _wait_for_server(port, timeout_s=35.0):
        print("[ERROR] Local Starfolio backend failed to start within 35s.", file=sys.stderr)
        server.should_exit = True
        return 1

    import webview
    from webview.dom import DOMEventHandler

    bridge = WinNativeBridge()
    window = webview.create_window(
        "星海拾卷 · Starfolio",
        url=f"http://127.0.0.1:{port}/",
        js_api=bridge,
        width=1360,
        height=860,
        min_size=(960, 620),
        text_select=True,
    )
    bridge.attach(window)

    def _on_loaded() -> None:
        try:
            window.evaluate_js(
                "window.__KB_NATIVE_WIN__ = true;"
                "window.dispatchEvent(new Event('kb-native-ready'));"
            )
        except Exception:
            pass

        def _on_dragover(_e: Any) -> None:
            try:
                window.evaluate_js("window.__kbOnFolderDragState && window.__kbOnFolderDragState(true);")
            except Exception:
                pass

        def _on_dragleave(_e: Any) -> None:
            try:
                window.evaluate_js("window.__kbOnFolderDragState && window.__kbOnFolderDragState(false);")
            except Exception:
                pass

        def _on_drop(e: Any) -> None:
            try:
                files = ((e or {}).get("dataTransfer") or {}).get("files") or []
                paths = [f.get("pywebviewFullPath") for f in files if isinstance(f, dict) and f.get("pywebviewFullPath")]
                window.evaluate_js("window.__kbOnFolderDragState && window.__kbOnFolderDragState(false);")
                if paths:
                    payload = json.dumps(paths, ensure_ascii=False)
                    window.evaluate_js(f"window.__kbOnFolderDropped && window.__kbOnFolderDropped({payload});")
            except Exception:
                pass

        try:
            doc = window.dom.document
            doc.events.dragover += DOMEventHandler(_on_dragover, prevent_default=True, stop_propagation=True)
            doc.events.dragleave += DOMEventHandler(_on_dragleave, prevent_default=False, stop_propagation=False)
            doc.events.drop += DOMEventHandler(_on_drop, prevent_default=True, stop_propagation=True)
        except Exception:
            pass

    window.events.loaded += _on_loaded

    storage_dir = data_dir / "webview2"
    storage_dir.mkdir(parents=True, exist_ok=True)
    try:
        webview.start(gui="edgechromium", private_mode=False, storage_path=str(storage_dir))
    finally:
        server.should_exit = True
    return 0


def main() -> int:
    if "--smoke-test" in sys.argv:
        return _run_smoke_test()
    return _run_desktop_gui()


if __name__ == "__main__":
    raise SystemExit(main())

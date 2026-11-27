from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import AppConfig, SourceConfig
from .db import connect_db, init_db
from .parsers import parse_file
from .tokenizer import tokenize_for_fts


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _file_sha256(path: Path, limit_bytes: int = 8 * 1024 * 1024) -> str:
    """Fast hash: full SHA256 for files <= 8MB; head+tail+size fingerprint for huge binaries."""
    h = hashlib.sha256()
    size = path.stat().st_size
    if size <= limit_bytes:
        with path.open("rb") as fh:
            while True:
                blk = fh.read(65536)
                if not blk:
                    break
                h.update(blk)
    else:
        h.update(str(size).encode())
        with path.open("rb") as fh:
            h.update(fh.read(1024 * 1024))
            fh.seek(max(0, size - 1024 * 1024))
            h.update(fh.read(1024 * 1024))
    return h.hexdigest()[:24]


def _infer_project(source: SourceConfig, rel_path: str) -> str:
    parts = Path(rel_path).parts
    if len(parts) >= 2:
        return parts[0]
    return "(根目录)"


def _normalize_actor(author_name: str, author_email: str, subject: str) -> str:
    low_name = (author_name or "").lower()
    low_email = (author_email or "").lower()
    if "antigravity" in low_name or "antigravity" in low_email or subject.startswith("[Antigravity]"):
        return "Antigravity"
    if "claude" in low_name or "claude" in low_email or subject.startswith("[Claude"):
        return "Claude Code"
    if "codex" in low_name or "codex" in low_email or subject.startswith("[Codex]"):
        return "Codex"
    if "hermes" in low_name or "hermes" in low_email or subject.startswith("[Hermes]"):
        return "Hermes"
    if "dsh" in low_name or "dsh" in low_email or subject.startswith("[DSH]"):
        return "DSH"
    if "nightly" in low_email or "夜间兜底" in author_name:
        return "夜间兜底"
    return author_name.strip() or "本地用户"


def _load_git_file_meta(repo_path: Path) -> dict[str, tuple[str, str, str]]:
    """Return {rel_path: (actor, iso_date, subject)} using a single fast git log scan."""
    meta: dict[str, tuple[str, str, str]] = {}
    if not (repo_path / ".git").exists():
        return meta
    try:
        proc = subprocess.run(
            [
                "git",
                "-c",
                "core.quotepath=false",
                "-C",
                str(repo_path),
                "log",
                "-n",
                "600",
                "--name-only",
                "--pretty=format:@@@%an|%ae|%aI|%s",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=25,
            check=False,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
    except Exception:
        return meta

    cur: tuple[str, str, str] | None = None
    for line in proc.stdout.splitlines():
        if line.startswith("@@@"):
            parts = line[3:].split("|", 3)
            if len(parts) == 4:
                actor = _normalize_actor(parts[0], parts[1], parts[3])
                cur = (actor, parts[2], parts[3])
            else:
                cur = None
        elif cur and line.strip():
            rel = line.strip()
            if rel not in meta:
                meta[rel] = cur
    return meta


class IndexerService:
    def __init__(self, cfg: AppConfig) -> None:
        self.cfg = cfg
        self._lock = threading.Lock()
        self._running = False
        self._progress: dict[str, Any] = {
            "running": False,
            "current_source": "",
            "files_scanned": 0,
            "files_indexed": 0,
            "files_skipped": 0,
            "files_failed": 0,
            "last_finished_at": None,
            "last_error": "",
        }
        init_db(cfg.db_path)

    def status(self) -> dict[str, Any]:
        conn = connect_db(self.cfg.db_path)
        try:
            doc_total = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
            chunk_total = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
            by_source = [
                dict(r)
                for r in conn.execute(
                    """
                    SELECT source_id,
                           COUNT(*) AS docs,
                           COALESCE(SUM(chunk_count), 0) AS chunks,
                           SUM(CASE WHEN parse_status = 'error' THEN 1 ELSE 0 END) AS failed
                    FROM documents
                    GROUP BY source_id
                    ORDER BY source_id
                    """
                ).fetchall()
            ]
            by_ext = [
                dict(r)
                for r in conn.execute(
                    "SELECT ext, COUNT(*) AS docs FROM documents GROUP BY ext ORDER BY docs DESC"
                ).fetchall()
            ]
            last_run = conn.execute(
                "SELECT * FROM index_runs ORDER BY id DESC LIMIT 1"
            ).fetchone()
            failed_files = [
                dict(r)
                for r in conn.execute(
                    """
                    SELECT source_id, rel_path, parse_status, parse_note
                    FROM documents
                    WHERE parse_status != 'ok'
                    ORDER BY source_id, rel_path
                    LIMIT 100
                    """
                ).fetchall()
            ]
        finally:
            conn.close()

        return {
            "progress": dict(self._progress),
            "totals": {"documents": doc_total, "chunks": chunk_total},
            "by_source": by_source,
            "by_ext": by_ext,
            "last_run": dict(last_run) if last_run else None,
            "non_ok_files": failed_files,
        }

    def trigger_async(self, force: bool = False) -> bool:
        if self._running:
            return False
        t = threading.Thread(target=self.run_index, kwargs={"force": force}, daemon=True)
        t.start()
        return True

    def _should_skip_dir(self, dir_name: str, full_path: Path) -> bool:
        if dir_name in self.cfg.exclude_dir_names:
            return True
        if dir_name.startswith(".") and dir_name not in {"."}:
            return True
        for suf in self.cfg.exclude_dir_suffixes:
            if dir_name.endswith(suf):
                return True
        return self.cfg.is_path_excluded(full_path)

    def _max_bytes_for_ext(self, ext: str) -> int:
        mb = self.cfg.max_file_size_mb.get(ext, self.cfg.max_file_size_mb.get("default", 30.0))
        return int(mb * 1024 * 1024)

    def run_index(self, force: bool = False) -> dict[str, Any]:
        if not self._lock.acquire(blocking=False):
            return {"status": "already_running"}

        self._running = True
        started_at = _now_iso()
        self._progress.update(
            {
                "running": True,
                "current_source": "",
                "files_scanned": 0,
                "files_indexed": 0,
                "files_skipped": 0,
                "files_failed": 0,
                "last_error": "",
            }
        )

        conn = connect_db(self.cfg.db_path)
        run_id = conn.execute(
            "INSERT INTO index_runs (started_at, status) VALUES (?, 'running')",
            (started_at,),
        ).lastrowid
        conn.commit()

        scanned = indexed = skipped = failed = removed = 0
        try:
            existing_rows = conn.execute(
                "SELECT id, source_id, rel_path, mtime, size_bytes, content_hash, git_author, git_date FROM documents"
            ).fetchall()
            existing = {(r["source_id"], r["rel_path"]): dict(r) for r in existing_rows}
            seen_keys: set[tuple[str, str]] = set()

            for src in self.cfg.sources:
                self._progress["current_source"] = src.name
                candidate_files: list[tuple[str, Path]] = []
                if src.kind == "files":
                    git_meta = {}
                    for rel_path, fpath in src.file_map().items():
                        if not fpath.exists() or not fpath.is_file():
                            continue
                        if fpath.name.startswith(".") or fpath.name.startswith("~$"):
                            continue
                        if fpath.suffix.lower() not in self.cfg.allowed_extensions:
                            continue
                        if self.cfg.is_path_excluded(fpath):
                            continue
                        candidate_files.append((rel_path, fpath))
                else:
                    if not src.path.exists():
                        continue
                    git_meta = _load_git_file_meta(src.path) if src.is_git else {}
                    for dirpath, dirnames, filenames in os.walk(src.path):
                        dp = Path(dirpath)
                        dirnames[:] = sorted(
                            d for d in dirnames if not self._should_skip_dir(d, dp / d)
                        )
                        for fn in sorted(filenames):
                            if fn.startswith(".") or fn.startswith("~$"):
                                continue
                            fpath = dp / fn
                            ext = fpath.suffix.lower()
                            if ext not in self.cfg.allowed_extensions:
                                continue
                            if self.cfg.is_path_excluded(fpath):
                                continue
                            candidate_files.append((fpath.relative_to(src.path).as_posix(), fpath))

                for rel_path, fpath in candidate_files:
                    ext = fpath.suffix.lower()
                    try:
                        st = fpath.stat()
                    except OSError:
                        continue

                    key = (src.id, rel_path)
                    seen_keys.add(key)
                    scanned += 1
                    self._progress["files_scanned"] = scanned

                    prev = existing.get(key)
                    g_author, g_date, g_msg = git_meta.get(rel_path, ("", "", ""))

                    if (
                        not force
                        and prev
                        and abs(prev["mtime"] - st.st_mtime) < 0.01
                        and prev["size_bytes"] == st.st_size
                    ):
                        # Update git metadata if changed even when file content didn't
                        if (prev["git_author"] != g_author or prev["git_date"] != g_date) and g_date:
                            conn.execute(
                                "UPDATE documents SET git_author=?, git_date=?, git_message=? WHERE id=?",
                                (g_author, g_date, g_msg, prev["id"]),
                            )
                        skipped += 1
                        self._progress["files_skipped"] = skipped
                        continue

                    max_b = self._max_bytes_for_ext(ext)
                    if st.st_size > max_b:
                        self._upsert_meta_only(
                            conn,
                            src,
                            rel_path,
                            fpath,
                            ext,
                            st.st_size,
                            st.st_mtime,
                            "skipped",
                            f"文件超过大小上限 ({st.st_size // (1024*1024)}MB > {max_b // (1024*1024)}MB)",
                            g_author,
                            g_date,
                            g_msg,
                        )
                        skipped += 1
                        self._progress["files_skipped"] = skipped
                        continue

                    try:
                        fhash = _file_sha256(fpath)
                    except OSError as exc:
                        failed += 1
                        self._progress["files_failed"] = failed
                        continue

                    if not force and prev and prev["content_hash"] == fhash:
                        conn.execute(
                            "UPDATE documents SET mtime=?, size_bytes=?, git_author=?, git_date=?, git_message=? WHERE id=?",
                            (st.st_mtime, st.st_size, g_author, g_date, g_msg, prev["id"]),
                        )
                        skipped += 1
                        self._progress["files_skipped"] = skipped
                        continue

                    parsed = parse_file(fpath, self.cfg)
                    self._save_parsed_document(
                        conn,
                        src,
                        rel_path,
                        fpath,
                        ext,
                        st.st_size,
                        st.st_mtime,
                        fhash,
                        parsed,
                        g_author,
                        g_date,
                        g_msg,
                    )
                    if parsed.status == "error":
                        failed += 1
                        self._progress["files_failed"] = failed
                    else:
                        indexed += 1
                        self._progress["files_indexed"] = indexed

                    if (indexed + failed) % 25 == 0:
                        conn.commit()

            # Remove deleted or newly excluded documents
            for key, prev in existing.items():
                if key not in seen_keys:
                    doc_id = prev["id"]
                    chunk_ids = [
                        r[0]
                        for r in conn.execute("SELECT id FROM chunks WHERE doc_id=?", (doc_id,)).fetchall()
                    ]
                    if chunk_ids:
                        conn.executemany("DELETE FROM chunks_fts WHERE rowid=?", [(cid,) for cid in chunk_ids])
                    conn.execute("DELETE FROM documents WHERE id=?", (doc_id,))
                    removed += 1

            total_chunks = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
            finished_at = _now_iso()
            conn.execute(
                """
                UPDATE index_runs
                SET finished_at=?, status='ok', files_scanned=?, files_indexed=?,
                    files_skipped=?, files_failed=?, files_removed=?, total_chunks=?
                WHERE id=?
                """,
                (finished_at, scanned, indexed, skipped, failed, removed, total_chunks, run_id),
            )
            conn.commit()
            self._progress["last_finished_at"] = finished_at
            return {
                "status": "ok",
                "files_scanned": scanned,
                "files_indexed": indexed,
                "files_skipped": skipped,
                "files_failed": failed,
                "files_removed": removed,
                "total_chunks": total_chunks,
            }
        except Exception as exc:
            err = str(exc)
            self._progress["last_error"] = err
            conn.execute(
                "UPDATE index_runs SET finished_at=?, status='error', error=? WHERE id=?",
                (_now_iso(), err, run_id),
            )
            conn.commit()
            return {"status": "error", "error": err}
        finally:
            conn.close()
            self._running = False
            self._progress["running"] = False
            self._progress["current_source"] = ""
            self._lock.release()

    def _upsert_meta_only(
        self,
        conn,
        src: SourceConfig,
        rel_path: str,
        fpath: Path,
        ext: str,
        size_bytes: int,
        mtime: float,
        status: str,
        note: str,
        g_author: str,
        g_date: str,
        g_msg: str,
    ) -> None:
        project = _infer_project(src, rel_path)
        conn.execute(
            """
            INSERT INTO documents (
                source_id, rel_path, abs_path, project, title, ext, size_bytes, mtime,
                content_hash, chunk_count, parse_status, parse_note, git_author, git_date, git_message, indexed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id, rel_path) DO UPDATE SET
                size_bytes=excluded.size_bytes, mtime=excluded.mtime,
                parse_status=excluded.parse_status, parse_note=excluded.parse_note,
                git_author=excluded.git_author, git_date=excluded.git_date, git_message=excluded.git_message,
                indexed_at=excluded.indexed_at
            """,
            (
                src.id,
                rel_path,
                str(fpath),
                project,
                fpath.stem,
                ext,
                size_bytes,
                mtime,
                status,
                note,
                g_author,
                g_date,
                g_msg,
                _now_iso(),
            ),
        )

    def _save_parsed_document(
        self,
        conn,
        src: SourceConfig,
        rel_path: str,
        fpath: Path,
        ext: str,
        size_bytes: int,
        mtime: float,
        fhash: str,
        parsed,
        g_author: str,
        g_date: str,
        g_msg: str,
    ) -> None:
        project = _infer_project(src, rel_path)
        now = _now_iso()
        cur = conn.execute(
            "SELECT id FROM documents WHERE source_id=? AND rel_path=?",
            (src.id, rel_path),
        ).fetchone()
        if cur:
            doc_id = cur["id"]
            old_cids = [
                r[0] for r in conn.execute("SELECT id FROM chunks WHERE doc_id=?", (doc_id,)).fetchall()
            ]
            if old_cids:
                conn.executemany("DELETE FROM chunks_fts WHERE rowid=?", [(cid,) for cid in old_cids])
            conn.execute("DELETE FROM chunks WHERE doc_id=?", (doc_id,))
            conn.execute(
                """
                UPDATE documents
                SET abs_path=?, project=?, title=?, ext=?, size_bytes=?, mtime=?, content_hash=?,
                    chunk_count=?, parse_status=?, parse_note=?, git_author=?, git_date=?, git_message=?, indexed_at=?
                WHERE id=?
                """,
                (
                    str(fpath),
                    project,
                    parsed.title,
                    ext,
                    size_bytes,
                    mtime,
                    fhash,
                    len(parsed.chunks),
                    parsed.status,
                    parsed.note,
                    g_author,
                    g_date,
                    g_msg,
                    now,
                    doc_id,
                ),
            )
        else:
            doc_id = conn.execute(
                """
                INSERT INTO documents (
                    source_id, rel_path, abs_path, project, title, ext, size_bytes, mtime,
                    content_hash, chunk_count, parse_status, parse_note, git_author, git_date, git_message, indexed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    src.id,
                    rel_path,
                    str(fpath),
                    project,
                    parsed.title,
                    ext,
                    size_bytes,
                    mtime,
                    fhash,
                    len(parsed.chunks),
                    parsed.status,
                    parsed.note,
                    g_author,
                    g_date,
                    g_msg,
                    now,
                ),
            ).lastrowid

        title_tok = tokenize_for_fts(parsed.title)
        path_tok = tokenize_for_fts(f"{project} {rel_path}")

        for ch in parsed.chunks:
            cid = conn.execute(
                """
                INSERT INTO chunks (doc_id, chunk_index, heading_path, start_line, end_line, page_num, content, content_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    doc_id,
                    ch.chunk_index,
                    ch.heading_path,
                    ch.start_line,
                    ch.end_line,
                    ch.page_num,
                    ch.content,
                    ch.content_hash,
                ),
            ).lastrowid
            conn.execute(
                """
                INSERT INTO chunks_fts (rowid, title_tok, heading_tok, path_tok, content_tok)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    cid,
                    title_tok,
                    tokenize_for_fts(ch.heading_path),
                    path_tok,
                    tokenize_for_fts(ch.content),
                ),
            )

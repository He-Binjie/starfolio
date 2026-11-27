from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from .config import AppConfig
from .db import connect_db
from .indexer import _normalize_actor

_OCTAL_RE = re.compile(rb"\\([0-7]{3})")


def decode_git_quoted_path(raw: str) -> str:
    """Decode git C-style quoted UTF-8 octal paths like '\"\\350\\256\\244...\"'."""
    s = raw.strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        inner = s[1:-1]
        raw_bytes = inner.encode("latin1", errors="ignore")
        # Handle standard escape sequences and octal UTF-8 sequences
        raw_bytes = _OCTAL_RE.sub(lambda m: bytes([int(m.group(1), 8)]), raw_bytes)
        raw_bytes = raw_bytes.replace(b'\\"', b'"').replace(b"\\\\", b"\\")
        try:
            return raw_bytes.decode("utf-8", errors="replace")
        except Exception:
            return inner
    return s


def _source_id_for_root(cfg: AppConfig, root_str: str) -> tuple[str, str]:
    root_norm = str(Path(root_str).expanduser().resolve())
    for src in cfg.sources:
        try:
            if str(src.path.resolve()) == root_norm:
                return src.id, src.name
        except Exception:
            pass
    if root_norm.endswith("/.agents/skills"):
        return "shared-skills", "共享技能库（~/.agents/skills）"
    return Path(root_str).name or "other", root_str


def _load_audit_events(cfg: AppConfig, limit: int = 400) -> list[dict[str, Any]]:
    if not cfg.audit_file.exists():
        return []
    events: list[dict[str, Any]] = []
    try:
        lines = cfg.audit_file.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:
        return []

    for ln in reversed(lines[-1200:]):
        ln = ln.strip()
        if not ln:
            continue
        try:
            obj = json.loads(ln)
        except Exception:
            continue

        kind = obj.get("kind", "")
        if kind == "git_commit":
            root = obj.get("root", "")
            src_id, src_name = _source_id_for_root(cfg, root)
            msg = obj.get("message", "")
            actor = _normalize_actor(obj.get("actor", ""), obj.get("actor_email", ""), msg)
            paths = []
            for p in obj.get("paths", []):
                if isinstance(p, dict):
                    paths.append(
                        {
                            "path": decode_git_quoted_path(str(p.get("path", ""))),
                            "status": str(p.get("status", "M")),
                        }
                    )
            events.append(
                {
                    "id": f"git::{src_id}::{obj.get('commit', '')}",
                    "kind": "git_commit",
                    "actor": actor,
                    "raw_actor": obj.get("actor", ""),
                    "source_id": src_id,
                    "source_name": src_name,
                    "repo_root": root,
                    "commit": obj.get("commit", ""),
                    "timestamp": obj.get("commit_time") or obj.get("recorded_at", ""),
                    "message": msg,
                    "paths": paths,
                }
            )
        elif kind in {"non_git_change_detected", "manual_record", "non_git_record"}:
            changes = obj.get("changes", [])
            paths = [
                {"path": str(c.get("path", "")), "status": "M"}
                for c in changes
                if isinstance(c, dict)
            ]
            if not paths and obj.get("paths"):
                paths = [
                    {"path": str(p), "status": "M"}
                    for p in obj.get("paths", [])
                ]
            actor = _normalize_actor(obj.get("actor", ""), "", obj.get("reason", ""))
            events.append(
                {
                    "id": f"audit::{obj.get('recorded_at', '')}::{len(events)}",
                    "kind": "non_git",
                    "actor": actor,
                    "raw_actor": obj.get("actor", ""),
                    "source_id": "non-git",
                    "source_name": "宿主配置与非 Git 文件",
                    "repo_root": "",
                    "commit": "",
                    "timestamp": obj.get("recorded_at", ""),
                    "message": obj.get("reason") or obj.get("action") or "非 Git 文件变更登记",
                    "paths": paths[:50],
                }
            )
        if len(events) >= limit:
            break
    return events


def _load_live_git_events(cfg: AppConfig, per_repo: int = 80) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    repos: list[tuple[str, str, Path]] = [
        (s.id, s.name, s.path) for s in cfg.sources if s.is_git and (s.path / ".git").exists()
    ]
    if cfg.edition != "standalone":
        skills_repo = Path.home() / ".agents" / "skills"
        if (skills_repo / ".git").exists():
            repos.append(("shared-skills", "共享技能库（~/.agents/skills）", skills_repo))

    for src_id, src_name, repo_path in repos:
        try:
            proc = subprocess.run(
                [
                    "git",
                    "-c",
                    "core.quotepath=false",
                    "-C",
                    str(repo_path),
                    "log",
                    f"-n{per_repo}",
                    "--name-status",
                    "--pretty=format:@@@%H|%an|%ae|%aI|%s",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
                check=False,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
        except Exception:
            continue

        cur: dict[str, Any] | None = None
        for ln in proc.stdout.splitlines():
            if ln.startswith("@@@"):
                if cur:
                    events.append(cur)
                parts = ln[3:].split("|", 4)
                if len(parts) == 5:
                    chash, aname, aemail, adate, subj = parts
                    cur = {
                        "id": f"git::{src_id}::{chash}",
                        "kind": "git_commit",
                        "actor": _normalize_actor(aname, aemail, subj),
                        "raw_actor": aname,
                        "source_id": src_id,
                        "source_name": src_name,
                        "repo_root": str(repo_path),
                        "commit": chash,
                        "timestamp": adate,
                        "message": subj,
                        "paths": [],
                    }
                else:
                    cur = None
            elif cur is not None and ln.strip():
                cols = ln.split("\t")
                if len(cols) >= 2:
                    cur["paths"].append({"status": cols[0][:1], "path": cols[-1]})
        if cur:
            events.append(cur)
    return events


def _load_file_mtime_events(cfg: AppConfig, limit: int = 80) -> list[dict[str, Any]]:
    from datetime import datetime, timezone

    if not cfg.db_path.exists():
        return []
    src_names = {s.id: s.name for s in cfg.sources}
    conn = connect_db(cfg.db_path)
    try:
        rows = conn.execute(
            """
            SELECT id, source_id, rel_path, project, title, ext, mtime, git_author
            FROM documents
            ORDER BY mtime DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    except Exception:
        return []
    finally:
        conn.close()

    out: list[dict[str, Any]] = []
    for r in rows:
        ts = datetime.fromtimestamp(float(r["mtime"]), tz=timezone.utc).astimezone().isoformat(timespec="seconds")
        sid = r["source_id"]
        out.append(
            {
                "id": f"file::{sid}::{r['id']}::{int(r['mtime'])}",
                "kind": "file_mtime",
                "actor": r["git_author"] or "本地文档",
                "raw_actor": r["git_author"] or "本地文档",
                "source_id": sid,
                "source_name": src_names.get(sid, sid),
                "repo_root": "",
                "commit": "",
                "timestamp": ts,
                "message": f"文档更新：{r['title'] or r['rel_path']}",
                "paths": [{"status": "M", "path": r["rel_path"]}],
            }
        )
    return out


def get_timeline(
    cfg: AppConfig,
    actor: str | None = None,
    source_id: str | None = None,
    days: int | None = None,
    limit: int = 120,
) -> dict[str, Any]:
    live = _load_live_git_events(cfg, per_repo=100)
    audit = [] if cfg.edition == "standalone" else _load_audit_events(cfg, limit=400)

    merged: dict[str, dict[str, Any]] = {}
    for ev in audit:
        merged[ev["id"]] = ev
    # Live git log has clean unquoted paths and covers commits even if hook was bypassed
    for ev in live:
        merged[ev["id"]] = ev

    items = list(merged.values())
    if cfg.edition == "standalone" and not items:
        items = _load_file_mtime_events(cfg, limit=limit)
    items.sort(key=lambda x: x.get("timestamp", ""), reverse=True)

    # Actor summary before filtering
    actor_counts: dict[str, int] = {}
    for it in items:
        a = it["actor"]
        actor_counts[a] = actor_counts.get(a, 0) + 1

    if actor and actor != "all":
        items = [it for it in items if it["actor"] == actor]
    if source_id and source_id != "all":
        items = [it for it in items if it["source_id"] == source_id]
    if days and days > 0:
        from datetime import datetime, timedelta, timezone

        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        items = [it for it in items if (it.get("timestamp") or "") >= cutoff[:10]]

    return {
        "total": len(items),
        "actor_counts": actor_counts,
        "items": items[:limit],
    }


def get_commit_diff(cfg: AppConfig, source_id: str, commit_hash: str) -> dict[str, Any] | None:
    if not re.fullmatch(r"[0-9a-fA-F]{7,40}", commit_hash):
        return None

    repo_path: Path | None = None
    if source_id == "shared-skills":
        repo_path = Path.home() / ".agents" / "skills"
    else:
        src = cfg.source_by_id(source_id)
        if src and src.is_git:
            repo_path = src.path

    if not repo_path or not (repo_path / ".git").exists():
        return None

    try:
        proc = subprocess.run(
            [
                "git",
                "-c",
                "core.quotepath=false",
                "-C",
                str(repo_path),
                "show",
                "--stat",
                "--patch",
                "--no-color",
                commit_hash,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
    except Exception as exc:
        return {"commit": commit_hash, "source_id": source_id, "diff": f"读取 diff 失败：{exc}", "truncated": False}

    diff = proc.stdout
    truncated = False
    if len(diff) > 120_000:
        diff = diff[:120_000] + "\n\n... [diff 超过 120KB，已截断] ..."
        truncated = True
    return {
        "commit": commit_hash,
        "source_id": source_id,
        "diff": diff or proc.stderr,
        "truncated": truncated,
    }

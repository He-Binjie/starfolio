from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from .config import AppConfig
from .db import connect_db
from .indexer import _normalize_actor
from .tree import _parse_index_labels

_PRD_RE = re.compile(r"(^|/|[-_\s])(prd|mrd|规格|需求文档|v\d+\.\d+)", re.IGNORECASE)
_DECISION_RE = re.compile(r"(^|/)decisions/|决策|口径确认|结论", re.IGNORECASE)
_MEETING_RE = re.compile(r"(^|/)meetings/|会议|纪要|评审|复盘会", re.IGNORECASE)
_TODO_RE = re.compile(r"(^|/)(todos|timeline)|待办|排期|清单|工作范围", re.IGNORECASE)

# Optional global meetings linkage aliases loaded from config.yaml (project_aliases)
_DEFAULT_PROJECT_ALIASES: dict[str, list[str]] = {}


def _classify_doc(rel_path: str, title: str) -> str:
    name = Path(rel_path).name
    if name.lower() == "index.md":
        return "index"
    if _DECISION_RE.search(rel_path) or _DECISION_RE.search(title):
        return "decisions"
    if _PRD_RE.search(rel_path) or _PRD_RE.search(title):
        return "prds"
    if _MEETING_RE.search(rel_path) or _MEETING_RE.search(title):
        return "meetings"
    if _TODO_RE.search(rel_path) or _TODO_RE.search(title):
        return "todos"
    return "references"


def get_projects_overview(cfg: AppConfig) -> list[dict[str, Any]]:
    conn = connect_db(cfg.db_path)
    try:
        rows = conn.execute(
            """
            SELECT source_id, project, rel_path, title, ext, mtime, git_author, git_date
            FROM documents
            ORDER BY source_id, project, mtime DESC
            """
        ).fetchall()
    finally:
        conn.close()

    source_map = {s.id: s for s in cfg.sources}
    label_cache: dict[str, dict[str, str]] = {}
    for s in cfg.sources:
        label_cache[s.id] = _parse_index_labels(s.path / "INDEX.md")

    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        sid = r["source_id"]
        proj = r["project"]
        key = (sid, proj)
        if key not in grouped:
            src = source_map.get(sid)
            friendly = label_cache.get(sid, {}).get(proj, "")
            grouped[key] = {
                "source_id": sid,
                "source_name": src.name if src else sid,
                "source_kind": src.kind if src else "wiki",
                "project": proj,
                "display_name": friendly if (friendly and friendly != proj) else proj,
                "doc_count": 0,
                "counts": {"decisions": 0, "prds": 0, "meetings": 0, "todos": 0, "references": 0},
                "last_mtime": 0.0,
                "last_author": "",
                "last_date": "",
            }
        g = grouped[key]
        g["doc_count"] += 1
        cat = _classify_doc(r["rel_path"], r["title"])
        if cat in g["counts"]:
            g["counts"][cat] += 1
        if (r["mtime"] or 0) > g["last_mtime"]:
            g["last_mtime"] = r["mtime"] or 0
            g["last_author"] = r["git_author"] or ""
            g["last_date"] = r["git_date"] or ""

    items = list(grouped.values())
    # Sort wiki projects first, then by recent activity
    kind_order = {"wiki": 0, "portal": 1, "archive": 2}
    items.sort(key=lambda x: (kind_order.get(x["source_kind"], 9), -x["last_mtime"]))
    return items


def get_project_detail(cfg: AppConfig, source_id: str, project: str) -> dict[str, Any] | None:
    src = cfg.source_by_id(source_id)
    if not src:
        return None

    conn = connect_db(cfg.db_path)
    try:
        rows = conn.execute(
            """
            SELECT id, source_id, rel_path, title, ext, size_bytes, mtime, chunk_count,
                   parse_status, parse_note, git_author, git_date, git_message
            FROM documents
            WHERE source_id = ? AND project = ?
            ORDER BY mtime DESC
            """,
            (source_id, project),
        ).fetchall()

        # Also pull related global meetings from <source>/meetings/ when inspecting a project
        linked_meetings: list[dict[str, Any]] = []
        if project not in {"meetings", "(根目录)"}:
            aliases = cfg.project_aliases.get(project) or _DEFAULT_PROJECT_ALIASES.get(project) or [project]
            m_rows = conn.execute(
                """
                SELECT id, source_id, rel_path, title, ext, size_bytes, mtime, chunk_count,
                       git_author, git_date, git_message
                FROM documents
                WHERE source_id = ? AND project = 'meetings'
                ORDER BY mtime DESC
                """,
                (source_id,),
            ).fetchall()
            for mr in m_rows:
                hay = f"{mr['rel_path']} {mr['title']}".lower()
                if any(a.lower() in hay for a in aliases):
                    d = dict(mr)
                    d["linked_from_global_meetings"] = True
                    linked_meetings.append(d)
    finally:
        conn.close()

    buckets: dict[str, list[dict[str, Any]]] = {
        "index": [],
        "decisions": [],
        "prds": [],
        "meetings": [],
        "todos": [],
        "references": [],
    }
    for r in rows:
        d = dict(r)
        cat = _classify_doc(d["rel_path"], d["title"])
        buckets[cat].append(d)

    # Merge linked global meetings (dedupe by rel_path)
    seen_m = {m["rel_path"] for m in buckets["meetings"]}
    for lm in linked_meetings:
        if lm["rel_path"] not in seen_m:
            buckets["meetings"].append(lm)
    buckets["meetings"].sort(key=lambda x: x.get("mtime") or 0, reverse=True)

    # Recent git commits touching this project folder
    recent_commits: list[dict[str, Any]] = []
    if src.is_git and (src.path / ".git").exists() and project != "(根目录)":
        try:
            proc = subprocess.run(
                [
                    "git",
                    "-c",
                    "core.quotepath=false",
                    "-C",
                    str(src.path),
                    "log",
                    "-n",
                    "25",
                    "--pretty=format:%H|%an|%ae|%aI|%s",
                    "--",
                    project,
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
                check=False,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            for ln in proc.stdout.splitlines():
                cols = ln.split("|", 4)
                if len(cols) == 5:
                    recent_commits.append(
                        {
                            "commit": cols[0],
                            "actor": _normalize_actor(cols[1], cols[2], cols[4]),
                            "date": cols[3],
                            "message": cols[4],
                        }
                    )
        except Exception:
            pass

    labels = _parse_index_labels(src.path / "INDEX.md")
    friendly = labels.get(project, "")
    return {
        "source_id": source_id,
        "source_name": src.name,
        "project": project,
        "display_name": friendly if (friendly and friendly != project) else project,
        "total_docs": len(rows),
        "buckets": buckets,
        "recent_commits": recent_commits,
    }

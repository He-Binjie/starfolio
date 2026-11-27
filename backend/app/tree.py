from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .config import AppConfig
from .db import connect_db

_INDEX_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_INDEX_TABLE_ROW_RE = re.compile(r"^\|\s*([^|]+?)\s*\|\s*\[([^\]]+)\]\(([^)]+)\)")


def _parse_index_labels(index_path: Path) -> dict[str, str]:
    """Extract friendly labels for top-level folders/files from root INDEX.md."""
    labels: dict[str, str] = {}
    if not index_path.exists():
        return labels
    try:
        text = index_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return labels

    # First pass: markdown tables like "| 示例项目 | [demo-project/](demo-project/) |"
    for ln in text.splitlines():
        tm = _INDEX_TABLE_ROW_RE.match(ln.strip())
        if tm:
            col_label = tm.group(1).strip().strip("*`")
            target = tm.group(3).strip().split("#")[0].rstrip("/")
            key = target.split("/")[0]
            if key and col_label and col_label.rstrip("/") != key and not target.startswith("http"):
                labels[key] = col_label

    # Second pass: inline links like "[示例项目](demo-project/)"
    for m in _INDEX_LINK_RE.finditer(text):
        label = m.group(1).strip().rstrip("/")
        target = m.group(2).strip().split("#")[0].rstrip("/")
        if not target or target.startswith("http"):
            continue
        key = target.split("/")[0]
        if key and key not in labels and label and label != key:
            labels[key] = label
    return labels


def build_tree(cfg: AppConfig) -> list[dict[str, Any]]:
    """Build source -> project -> folder/file tree from indexed documents + INDEX.md labels."""
    conn = connect_db(cfg.db_path)
    try:
        rows = conn.execute(
            """
            SELECT source_id, rel_path, title, ext, mtime, git_author
            FROM documents
            ORDER BY source_id, rel_path
            """
        ).fetchall()
    finally:
        conn.close()

    by_source: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        by_source.setdefault(r["source_id"], []).append(dict(r))

    result: list[dict[str, Any]] = []
    for src in cfg.sources:
        docs = by_source.get(src.id, [])
        labels = _parse_index_labels(src.path / "INDEX.md")

        root_children: dict[str, Any] = {}
        for d in docs:
            parts = Path(d["rel_path"]).parts
            cursor = root_children
            for depth, part in enumerate(parts):
                is_file = depth == len(parts) - 1
                if is_file:
                    node_key = f"file::{src.id}::{d['rel_path']}"
                    cursor[node_key] = {
                        "key": node_key,
                        "title": part,
                        "doc_title": d["title"],
                        "isLeaf": True,
                        "source_id": src.id,
                        "rel_path": d["rel_path"],
                        "ext": d["ext"],
                        "mtime": d["mtime"],
                        "git_author": d["git_author"],
                    }
                else:
                    sub_path = "/".join(parts[: depth + 1])
                    dir_key = f"dir::{src.id}::{sub_path}"
                    if dir_key not in cursor:
                        friendly = labels.get(part) if depth == 0 else None
                        # Prefer concise Chinese label first (Bear/Linear style); keep raw slug in raw_name for tooltip
                        display = friendly if (friendly and friendly != part) else part
                        cursor[dir_key] = {
                            "key": dir_key,
                            "title": display,
                            "raw_name": part,
                            "isLeaf": False,
                            "source_id": src.id,
                            "project": parts[0],
                            "dir_path": sub_path,
                            "_children": {},
                            "count": 0,
                        }
                    cursor[dir_key]["count"] += 1
                    cursor = cursor[dir_key]["_children"]

        def _finalize(mapping: dict[str, Any]) -> list[dict[str, Any]]:
            dirs = []
            files = []
            for v in mapping.values():
                if v["isLeaf"]:
                    files.append(v)
                else:
                    children = _finalize(v.pop("_children"))
                    v["children"] = children
                    dirs.append(v)
            # Put README.md / INDEX.md / changelog.md first in files
            priority = {"README.md": 0, "INDEX.md": 1, "changelog.md": 2}
            files.sort(key=lambda x: (priority.get(x["title"], 99), x["title"].lower()))
            dirs.sort(key=lambda x: x["raw_name"].lower())
            return dirs + files

        result.append(
            {
                "key": f"source::{src.id}",
                "title": src.name,
                "source_id": src.id,
                "kind": src.kind,
                "sensitivity": src.sensitivity,
                "count": len(docs),
                "isLeaf": False,
                "children": _finalize(root_children),
            }
        )

    return result

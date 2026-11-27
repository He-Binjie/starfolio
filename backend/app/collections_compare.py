from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from .config import AppConfig
from .db import connect_db
from .search import get_document_detail

_QUANT_RE = re.compile(
    r"(?:V\d+\.\d+(?:\.\d+)?|\d+(?:\.\d+)?%|\d+(?:\.\d+)?(?:天|个月|月|周|小时|分钟|秒|元|万|亿|倍|件|箱|杯|人天|家|个店)|(?:>=|<=|>|<|≥|≤)\s*\d+(?:\.\d+)?)"
)
_DATE_RE = re.compile(r"\b20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2})?\b")
_ACTION_RE = re.compile(r"(?:待确认|待办|风险|阻塞|TODO|FIXME|需要.*统一|需.*对齐|\[ \])", re.IGNORECASE)


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def list_collections(cfg: AppConfig) -> list[dict[str, Any]]:
    conn = connect_db(cfg.db_path)
    try:
        rows = conn.execute(
            "SELECT id, name, description, docs_json, created_at, updated_at FROM collections ORDER BY updated_at DESC, id DESC"
        ).fetchall()
    finally:
        conn.close()
    out: list[dict[str, Any]] = []
    for r in rows:
        docs = json.loads(r["docs_json"] or "[]")
        out.append(
            {
                "id": r["id"],
                "name": r["name"],
                "description": r["description"],
                "docs": docs,
                "doc_count": len(docs),
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
            }
        )
    return out


def create_collection(
    cfg: AppConfig,
    name: str,
    docs: list[dict[str, str]],
    description: str = "",
) -> dict[str, Any]:
    clean_name = name.strip()
    if not clean_name:
        raise ValueError("卷宗名称不能为空")
    dedup: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for d in docs:
        sid = str(d.get("source_id", "")).strip()
        rp = str(d.get("rel_path", "")).strip()
        if sid and rp and (sid, rp) not in seen:
            seen.add((sid, rp))
            dedup.append({"source_id": sid, "rel_path": rp, "title": str(d.get("title", "") or rp)})
    now = _now_iso()
    conn = connect_db(cfg.db_path)
    try:
        cur = conn.execute(
            "INSERT INTO collections (name, description, docs_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (clean_name, description.strip(), json.dumps(dedup, ensure_ascii=False), now, now),
        )
        cid = cur.lastrowid
        conn.commit()
    finally:
        conn.close()
    return {
        "id": cid,
        "name": clean_name,
        "description": description.strip(),
        "docs": dedup,
        "doc_count": len(dedup),
        "created_at": now,
        "updated_at": now,
    }


def delete_collection(cfg: AppConfig, collection_id: int) -> bool:
    conn = connect_db(cfg.db_path)
    try:
        cur = conn.execute("DELETE FROM collections WHERE id = ?", (collection_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def _extract_doc_signals(raw_text: str) -> dict[str, Any]:
    quants: set[str] = set()
    dates: set[str] = set()
    actions: list[str] = []
    quant_contexts: list[dict[str, Any]] = []

    for idx, raw_line in enumerate(raw_text.splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        found_q = [re.sub(r"\s+", "", m.group(0)) for m in _QUANT_RE.finditer(line)]
        found_q = [q for q in found_q if len(q) >= 2]
        if found_q:
            quants.update(found_q)
            if len(quant_contexts) < 18:
                clean = re.sub(r"[#*`>|]+", " ", line).strip()
                quant_contexts.append({"line": idx, "tokens": found_q[:5], "text": clean[:120]})
        for dm in _DATE_RE.finditer(line):
            dates.add(dm.group(0))
        if _ACTION_RE.search(line) and len(actions) < 8:
            clean = re.sub(r"[#*`>|]+", " ", line).strip()
            actions.append(clean[:130])

    return {
        "quants": sorted(quants),
        "dates": sorted(dates),
        "actions": actions,
        "quant_contexts": quant_contexts,
    }


def compare_two_documents(
    cfg: AppConfig,
    source_a: str,
    path_a: str,
    source_b: str,
    path_b: str,
) -> dict[str, Any]:
    """0-Token deterministic side-by-side comparison of two documents (numeric, date, & structure diffs)."""
    doc_a = get_document_detail(cfg, source_a, path_a)
    doc_b = get_document_detail(cfg, source_b, path_b)
    if not doc_a or not doc_b:
        raise ValueError("其中至少一份文档不存在或受隐私排除规则保护")

    sig_a = _extract_doc_signals(doc_a["raw_content"])
    sig_b = _extract_doc_signals(doc_b["raw_content"])

    set_a = set(sig_a["quants"])
    set_b = set(sig_b["quants"])
    only_a = sorted(set_a - set_b)
    only_b = sorted(set_b - set_a)
    shared = sorted(set_a & set_b)

    return {
        "doc_a": doc_a,
        "doc_b": doc_b,
        "diff": {
            "only_a_quants": only_a[:24],
            "only_b_quants": only_b[:24],
            "shared_quants": shared[:20],
            "dates_a": sig_a["dates"][:12],
            "dates_b": sig_b["dates"][:12],
            "actions_a": sig_a["actions"],
            "actions_b": sig_b["actions"],
        },
    }


def extract_cross_doc_facts(
    cfg: AppConfig,
    docs: list[dict[str, str]],
) -> dict[str, Any]:
    """0-Token deterministic Cross-Doc Fact Matrix across 2-8 documents (numbers, dates, risks/todos)."""
    items: list[dict[str, Any]] = []
    all_quant_freq: dict[str, int] = {}

    for d in docs[:8]:
        sid = str(d.get("source_id", "")).strip()
        rp = str(d.get("rel_path", "")).strip()
        if not sid or not rp:
            continue
        detail = get_document_detail(cfg, sid, rp)
        if not detail:
            continue
        sig = _extract_doc_signals(detail["raw_content"])
        for q in sig["quants"]:
            all_quant_freq[q] = all_quant_freq.get(q, 0) + 1
        items.append(
            {
                "source_id": sid,
                "rel_path": rp,
                "title": detail["meta"]["title"],
                "ext": detail["meta"]["ext"],
                "mtime": detail["meta"]["mtime"],
                "git_date": detail["meta"]["git_date"],
                "quants": sig["quants"][:18],
                "quant_contexts": sig["quant_contexts"][:8],
                "dates": sig["dates"][:10],
                "actions": sig["actions"][:6],
            }
        )

    # Mark unique (potentially conflicting) vs shared numeric tokens
    for it in items:
        it["unique_quants"] = [q for q in it["quants"] if all_quant_freq.get(q, 0) == 1][:12]
        it["shared_quants"] = [q for q in it["quants"] if all_quant_freq.get(q, 0) > 1][:12]

    return {
        "doc_count": len(items),
        "items": items,
    }

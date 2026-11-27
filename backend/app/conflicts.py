from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

import numpy as np

from .config import AppConfig
from .db import connect_db
from .qa import _find_engine, list_qa_engines, run_cli_prompt
from .vectors import VectorService

# Extract high-signal quantitative tokens: percentages, durations, amounts, versions, thresholds
_QUANT_RE = re.compile(
    r"(?:V\d+\.\d+(?:\.\d+)?|\d+(?:\.\d+)?%|\d+(?:\.\d+)?(?:天|个月|月|周|小时|分钟|秒|元|万|亿|倍|件|箱|杯|人天|家|个店)|(?:>=|<=|>|<|≥|≤)\s*\d+(?:\.\d+)?)"
)
_DATE_RE = re.compile(r"\b20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2})?\b")
_HIGH_PRIORITY_PATH_RE = re.compile(r"(decisions/|prd/|modules/|口径|规范|规则|逻辑)", re.IGNORECASE)
_NOISE_PATH_RE = re.compile(
    r"(daily-work-digest|changelog\.md|INDEX\.md|ASSETS\.md|快照|历史|归档|_archive|回写清单|去版本号前|drafts/|backup|旧版)",
    re.IGNORECASE,
)
_DATED_PERIODIC_RE = re.compile(r"(20\d{2}-\d{2}-\d{2}).*(周会|周报|日报|月报|会议|复盘|简报|工作进展)")


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _extract_quant_tokens(text: str) -> set[str]:
    tokens = set(_QUANT_RE.findall(text or ""))
    # Normalize whitespace inside comparator expressions
    return {re.sub(r"\s+", "", t) for t in tokens if len(t) >= 2}


def _extract_dates(text: str) -> set[str]:
    return set(_DATE_RE.findall(text or ""))


def _make_fix_prompt(row: dict[str, Any], standalone: bool = False) -> str:
    verdict_note = f"（AI 初审判断：{row['llm_verdict']} — {row['llm_reason']}）" if row.get("llm_verdict") else ""
    tail = (
        "请只读核对这两处原文，先告诉我是否存在真实口径冲突或新旧版本未同步；等我确认以哪份为准后再同步更新文档。"
        if standalone
        else "请只读核对这两处原文，先告诉我是否存在真实口径冲突或新旧版本未同步；等我确认以哪份为准后再同步更新对应文档。"
    )
    return (
        f"知识库疑似口径冲突核对{verdict_note}：\n"
        f"- 文档 A：{row['source_id']}/{row['rel_path_a']} (L{row['start_line_a']}-L{row['end_line_a']})\n"
        f"- 文档 B：{row['source_id']}/{row['rel_path_b']} (L{row['start_line_b']}-L{row['end_line_b']})\n"
        f"- 语义相似度：{row['similarity']:.2f}；数值差异：{row['diff_summary']}\n"
        f"{tail}"
    )


def scan_conflict_candidates(cfg: AppConfig, vector_service: VectorService) -> dict[str, Any]:
    """Scan within-project high-similarity cross-document chunk pairs with differing numbers/thresholds."""
    min_sim = cfg.conflicts.min_similarity
    max_candidates = cfg.conflicts.max_candidates
    is_standalone = cfg.edition == "standalone"

    source_clause = "WHERE"

    conn = connect_db(cfg.db_path)
    try:
        rows = conn.execute(
            f"""
            SELECT c.id AS chunk_id, c.doc_id, c.start_line, c.end_line, c.content,
                   d.source_id, d.project, d.rel_path, d.title, d.ext, d.mtime,
                   v.dim, v.vec
            FROM chunks c
            JOIN documents d ON d.id = c.doc_id
            JOIN chunk_vectors v
              ON v.content_hash = c.content_hash AND v.model_name = ?
            {source_clause} d.ext IN ('.md', '.txt', '.docx', '.pdf', '.pptx')
              AND length(c.content) >= 50
            """,
            (vector_service.model_name,),
        ).fetchall()
    finally:
        conn.close()

    # Group by (source_id, project), excluding noisy digests/changelogs
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for r in rows:
        rel = r["rel_path"]
        if _NOISE_PATH_RE.search(rel):
            continue
        q_toks = _extract_quant_tokens(r["content"])
        if not q_toks:
            continue
        item = dict(r)
        item["quant"] = q_toks
        item["dates"] = _extract_dates(r["content"])
        groups.setdefault((r["source_id"], r["project"]), []).append(item)

    best_per_doc_pair: dict[tuple[int, int], dict[str, Any]] = {}
    skip_projects = {"meetings", "projects"} if is_standalone else {"meetings", "projects", "(根目录)"}

    for (sid, proj), items in groups.items():
        if len(items) < 2 or proj in skip_projects:
            continue
        # Cap huge folders to most recent 600 quantitative chunks to stay fast (<2s)
        if len(items) > 600:
            items.sort(key=lambda x: x["mtime"], reverse=True)
            items = items[:600]

        dim = int(items[0]["dim"])
        mat = np.empty((len(items), dim), dtype=np.float32)
        for i, it in enumerate(items):
            mat[i] = np.frombuffer(it["vec"], dtype=np.float16).astype(np.float32)

        # Compute upper-triangle cosine similarity matrix
        sim_mat = mat @ mat.T
        n = len(items)
        ii, jj = np.where(np.triu(sim_mat, k=1) >= min_sim)

        for idx_a, idx_b in zip(ii.tolist(), jj.tolist()):
            a = items[idx_a]
            b = items[idx_b]
            if a["doc_id"] == b["doc_id"]:
                continue
            # Skip periodic dated meeting/report pairs from different dates (natural chronological evolution)
            ma = _DATED_PERIODIC_RE.search(a["rel_path"])
            mb = _DATED_PERIODIC_RE.search(b["rel_path"])
            if ma and mb and ma.group(1) != mb.group(1):
                continue
            # Ignore exact duplicate content across copies
            sim = float(sim_mat[idx_a, idx_b])
            if sim >= 0.992:
                continue

            only_a = sorted(a["quant"] - b["quant"])
            only_b = sorted(b["quant"] - a["quant"])
            if not only_a or not only_b:
                continue

            d1, d2 = (a, b) if a["doc_id"] < b["doc_id"] else (b, a)
            if d1 is not a:
                only_a, only_b = only_b, only_a

            prio = sim
            if _HIGH_PRIORITY_PATH_RE.search(d1["rel_path"]):
                prio += 0.12
            if _HIGH_PRIORITY_PATH_RE.search(d2["rel_path"]):
                prio += 0.12

            dp_key = (int(d1["doc_id"]), int(d2["doc_id"]))
            prev = best_per_doc_pair.get(dp_key)
            if prev is None or prio > prev["priority_score"]:
                best_per_doc_pair[dp_key] = {
                    "pair_key": f"{d1['doc_id']}:{d2['doc_id']}",
                    "source_id": sid,
                    "project": proj,
                    "doc_a_id": d1["doc_id"],
                    "chunk_a_id": d1["chunk_id"],
                    "rel_path_a": d1["rel_path"],
                    "title_a": d1["title"],
                    "start_line_a": d1["start_line"],
                    "end_line_a": d1["end_line"],
                    "snippet_a": d1["content"][:500],
                    "doc_b_id": d2["doc_id"],
                    "chunk_b_id": d2["chunk_id"],
                    "rel_path_b": d2["rel_path"],
                    "title_b": d2["title"],
                    "start_line_b": d2["start_line"],
                    "end_line_b": d2["end_line"],
                    "snippet_b": d2["content"][:500],
                    "similarity": round(sim, 4),
                    "diff_tokens": {
                        "only_a": only_a[:8],
                        "only_b": only_b[:8],
                        "dates_a": sorted(d1["dates"])[:4],
                        "dates_b": sorted(d2["dates"])[:4],
                    },
                    "priority_score": round(prio, 4),
                }

    ranked = sorted(best_per_doc_pair.values(), key=lambda x: x["priority_score"], reverse=True)[:max_candidates]
    now = _now_iso()

    conn = connect_db(cfg.db_path)
    try:
        # Preserve existing manual statuses & LLM verdicts for pairs that still exist
        existing_rows = {
            r["pair_key"]: dict(r)
            for r in conn.execute(
                "SELECT pair_key, status, llm_verdict, llm_reason FROM conflict_candidates"
            ).fetchall()
        }
        seen_keys: set[str] = set()
        for item in ranked:
            pk = item["pair_key"]
            seen_keys.add(pk)
            old = existing_rows.get(pk)
            status = old["status"] if old else "open"
            llm_verdict = old["llm_verdict"] if old else ""
            llm_reason = old["llm_reason"] if old else ""

            conn.execute(
                """
                INSERT INTO conflict_candidates (
                    pair_key, source_id, project,
                    doc_a_id, chunk_a_id, rel_path_a, title_a, start_line_a, end_line_a, snippet_a,
                    doc_b_id, chunk_b_id, rel_path_b, title_b, start_line_b, end_line_b, snippet_b,
                    similarity, diff_tokens_json, priority_score, status, llm_verdict, llm_reason,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(pair_key) DO UPDATE SET
                    chunk_a_id=excluded.chunk_a_id, start_line_a=excluded.start_line_a, end_line_a=excluded.end_line_a, snippet_a=excluded.snippet_a,
                    chunk_b_id=excluded.chunk_b_id, start_line_b=excluded.start_line_b, end_line_b=excluded.end_line_b, snippet_b=excluded.snippet_b,
                    similarity=excluded.similarity, diff_tokens_json=excluded.diff_tokens_json,
                    priority_score=excluded.priority_score, updated_at=excluded.updated_at
                """,
                (
                    pk,
                    item["source_id"],
                    item["project"],
                    item["doc_a_id"],
                    item["chunk_a_id"],
                    item["rel_path_a"],
                    item["title_a"],
                    item["start_line_a"],
                    item["end_line_a"],
                    item["snippet_a"],
                    item["doc_b_id"],
                    item["chunk_b_id"],
                    item["rel_path_b"],
                    item["title_b"],
                    item["start_line_b"],
                    item["end_line_b"],
                    item["snippet_b"],
                    item["similarity"],
                    json.dumps(item["diff_tokens"], ensure_ascii=False),
                    item["priority_score"],
                    status,
                    llm_verdict,
                    llm_reason,
                    now,
                    now,
                ),
            )
        conn.execute(
            "DELETE FROM conflict_candidates WHERE pair_key NOT IN ("
            + (",".join("?" for _ in seen_keys) if seen_keys else "''")
            + ") AND status = 'open' AND llm_verdict = ''",
            list(seen_keys) if seen_keys else [],
        )
        conn.commit()
    finally:
        conn.close()

    return {"status": "ok", "scanned_groups": len(groups), "candidates_found": len(ranked)}


def list_conflict_candidates(cfg: AppConfig, include_dismissed: bool = False) -> list[dict[str, Any]]:
    conn = connect_db(cfg.db_path)
    try:
        where = "" if include_dismissed else "WHERE status != 'dismissed'"
        rows = conn.execute(
            f"SELECT * FROM conflict_candidates {where} ORDER BY priority_score DESC LIMIT 100"
        ).fetchall()
    finally:
        conn.close()

    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        dt = json.loads(d.pop("diff_tokens_json", "{}") or "{}")
        d["diff_tokens"] = dt
        a_str = ", ".join(dt.get("only_a", [])[:4])
        b_str = ", ".join(dt.get("only_b", [])[:4])
        d["diff_summary"] = f"A 独有 [{a_str}] vs B 独有 [{b_str}]"
        d["fix_prompt"] = _make_fix_prompt(d, standalone=(cfg.edition == "standalone"))
        out.append(d)
    return out


def update_conflict_status(cfg: AppConfig, conflict_id: int, status: str) -> dict[str, Any] | None:
    if status not in {"open", "dismissed", "verified_conflict", "false_positive"}:
        raise ValueError("不支持的状态")
    conn = connect_db(cfg.db_path)
    try:
        cur = conn.execute(
            "UPDATE conflict_candidates SET status=?, updated_at=? WHERE id=?",
            (status, _now_iso(), conflict_id),
        )
        conn.commit()
        if cur.rowcount == 0:
            return None
        row = conn.execute("SELECT * FROM conflict_candidates WHERE id=?", (conflict_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def review_conflict_with_llm(
    cfg: AppConfig,
    conflict_id: int,
    engine_id: str | None = None,
) -> dict[str, Any]:
    conn = connect_db(cfg.db_path)
    try:
        row = conn.execute("SELECT * FROM conflict_candidates WHERE id=?", (conflict_id,)).fetchone()
    finally:
        conn.close()

    if not row:
        raise ValueError("未找到对应冲突候选")

    r = dict(row)
    target_eng_id = engine_id or cfg.conflicts.review_engine
    avail_map = {e["id"]: e["available"] for e in list_qa_engines(cfg)}
    if not avail_map.get(target_eng_id, False):
        first_avail = next((eid for eid, ok in avail_map.items() if ok), None)
        if first_avail:
            target_eng_id = first_avail
    engine = _find_engine(cfg, target_eng_id)
    prompt = (
        "你是知识库口径审计助手（严格只读，不要调用任何工具）。下面两段来自同一项目的不同文档，向量相似度很高但包含不同数值/日期。\n"
        "请判断它们属于以下哪一类，并只输出一个 JSON 对象（不要额外解释）：\n"
        '{"verdict": "真冲突" | "版本演进" | "非冲突", "reason": "一句话说明差异点及建议以哪份为准"}\n\n'
        f"## 文档 A：{r['rel_path_a']} (L{r['start_line_a']}-L{r['end_line_a']})\n{r['snippet_a']}\n\n"
        f"## 文档 B：{r['rel_path_b']} (L{r['start_line_b']}-L{r['end_line_b']})\n{r['snippet_b']}\n"
    )

    resp, err = run_cli_prompt(cfg, engine, prompt)
    if err:
        return {"ok": False, "error": err}

    verdict = "待人工确认"
    reason = resp.strip()[:260]
    m = re.search(r"\{[\s\S]*\}", resp)
    if m:
        try:
            obj = json.loads(m.group(0))
            verdict = str(obj.get("verdict") or verdict)
            reason = str(obj.get("reason") or reason)
        except Exception:
            pass

    new_status = "verified_conflict" if "真冲突" in verdict else ("false_positive" if "非冲突" in verdict else "open")
    conn = connect_db(cfg.db_path)
    try:
        conn.execute(
            """
            UPDATE conflict_candidates
            SET llm_verdict=?, llm_reason=?, status=?, updated_at=?
            WHERE id=?
            """,
            (verdict, reason, new_status, _now_iso(), conflict_id),
        )
        conn.commit()
    finally:
        conn.close()

    return {"ok": True, "id": conflict_id, "verdict": verdict, "reason": reason, "status": new_status}

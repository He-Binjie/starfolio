from __future__ import annotations

import re
import subprocess
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .config import AppConfig
from .db import connect_db
from .tokenizer import build_fts_query, make_snippet

if TYPE_CHECKING:
    from .vectors import VectorService

_HISTORICAL_RE = re.compile(
    r"(快照|历史|归档|_archive|archive/|旧版|备份|backup|回写清单|去版本号前|v0\.\d|drafts/)",
    re.IGNORECASE,
)


def is_historical_doc(rel_path: str, title: str = "") -> bool:
    return bool(_HISTORICAL_RE.search(rel_path) or _HISTORICAL_RE.search(title))


def _build_filter_clause(
    source_id: str | None,
    project: str | None,
    ext: str | None,
    days: int | None,
) -> tuple[list[str], list[Any]]:
    where: list[str] = []
    params: list[Any] = []
    if source_id and source_id != "all":
        where.append("d.source_id = ?")
        params.append(source_id)
    if project and project != "all":
        where.append("d.project = ?")
        params.append(project)
    if ext and ext != "all":
        where.append("d.ext = ?")
        params.append(ext.lower())
    if days and days > 0:
        cutoff = time.time() - days * 86400
        where.append("d.mtime >= ?")
        params.append(cutoff)
    return where, params


def _fetch_chunks_by_ids(conn, chunk_ids: list[int]) -> dict[int, dict[str, Any]]:
    if not chunk_ids:
        return {}
    placeholders = ",".join("?" for _ in chunk_ids)
    rows = conn.execute(
        f"""
        SELECT c.id AS chunk_id, c.doc_id, c.heading_path, c.start_line, c.end_line,
               c.page_num, c.content,
               d.source_id, d.rel_path, d.project, d.title, d.ext, d.mtime,
               d.git_author, d.git_date, d.parse_note
        FROM chunks c
        JOIN documents d ON d.id = c.doc_id
        WHERE c.id IN ({placeholders})
        """,
        chunk_ids,
    ).fetchall()
    return {int(r["chunk_id"]): dict(r) for r in rows}


def _apply_historical_penalty(score: float, rel_path: str, title: str, include_historical: bool) -> float:
    if not include_historical and is_historical_doc(rel_path, title):
        return score * 0.52
    return score


def search_chunks(
    cfg: AppConfig,
    q: str,
    source_id: str | None = None,
    project: str | None = None,
    ext: str | None = None,
    days: int | None = None,
    mode: str = "hybrid",
    include_historical: bool = False,
    allowed_doc_pairs: list[tuple[str, str]] | None = None,
    limit: int = 40,
    offset: int = 0,
    vector_service: VectorService | None = None,
) -> dict[str, Any]:
    conn = connect_db(cfg.db_path)
    try:
        where, params = _build_filter_clause(source_id, project, ext, days)

        # Restrict to explicitly checked documents (NotebookLM source grounding!)
        explicit_doc_ids: set[int] | None = None
        if allowed_doc_pairs:
            pair_clauses = []
            pair_params: list[Any] = []
            for sid, rp in allowed_doc_pairs:
                pair_clauses.append("(d.source_id = ? AND d.rel_path = ?)")
                pair_params.extend([sid, rp])
            doc_rows = conn.execute(
                f"SELECT id FROM documents d WHERE {' OR '.join(pair_clauses)}",
                pair_params,
            ).fetchall()
            explicit_doc_ids = {int(r[0]) for r in doc_rows}
            if not explicit_doc_ids:
                return {"query": q, "mode": mode, "total": 0, "items": []}
            id_ph = ",".join("?" for _ in explicit_doc_ids)
            where.append(f"d.id IN ({id_ph})")
            params.extend(sorted(explicit_doc_ids))

        raw_q = q.strip()
        if not raw_q:
            where_sql = ("WHERE " + " AND ".join(where)) if where else ""
            total = conn.execute(
                f"SELECT COUNT(*) FROM documents d {where_sql}", params
            ).fetchone()[0]
            rows = conn.execute(
                f"""
                SELECT d.id AS doc_id, d.source_id, d.rel_path, d.project, d.title, d.ext,
                       d.size_bytes, d.mtime, d.chunk_count, d.parse_status, d.parse_note,
                       d.git_author, d.git_date, d.git_message,
                       (SELECT content FROM chunks c WHERE c.doc_id = d.id ORDER BY c.chunk_index LIMIT 1) AS preview
                FROM documents d
                {where_sql}
                ORDER BY d.mtime DESC
                LIMIT ? OFFSET ?
                """,
                [*params, limit, offset],
            ).fetchall()
            items = [
                {
                    "doc_id": r["doc_id"],
                    "chunk_id": None,
                    "source_id": r["source_id"],
                    "rel_path": r["rel_path"],
                    "project": r["project"],
                    "title": r["title"],
                    "ext": r["ext"],
                    "heading_path": "",
                    "start_line": 1,
                    "end_line": 1,
                    "page_num": None,
                    "snippet": make_snippet(r["preview"] or "", [], 200),
                    "score": 0.0,
                    "match_type": "recent",
                    "vec_score": None,
                    "is_historical": is_historical_doc(r["rel_path"], r["title"]),
                    "mtime": r["mtime"],
                    "git_author": r["git_author"],
                    "git_date": r["git_date"],
                    "parse_note": r["parse_note"],
                }
                for r in rows
            ]
            if not include_historical:
                items.sort(key=lambda x: (1 if x["is_historical"] else 0, -(x["mtime"] or 0)))
            return {"query": q, "mode": "recent", "total": total, "items": items}

        fts_expr, terms = build_fts_query(raw_q)
        where_sql = ("AND " + " AND ".join(where)) if where else ""

        fts_hits: list[dict[str, Any]] = []
        fts_total = 0
        if mode in {"fts", "hybrid"} and fts_expr:
            fts_fetch = max(limit + offset, 110) if (mode == "hybrid" or not include_historical) else limit
            fts_off = 0 if (mode == "hybrid" or not include_historical) else offset
            count_row = conn.execute(
                f"""
                SELECT COUNT(*)
                FROM chunks_fts
                JOIN chunks c ON c.id = chunks_fts.rowid
                JOIN documents d ON d.id = c.doc_id
                WHERE chunks_fts MATCH ? {where_sql}
                """,
                [fts_expr, *params],
            ).fetchone()
            fts_total = count_row[0] if count_row else 0
            rows = conn.execute(
                f"""
                SELECT c.id AS chunk_id, c.doc_id, c.heading_path, c.start_line, c.end_line,
                       c.page_num, c.content,
                       d.source_id, d.rel_path, d.project, d.title, d.ext, d.mtime,
                       d.git_author, d.git_date, d.parse_note,
                       bm25(chunks_fts, 4.0, 2.5, 2.0, 1.0) AS rank_score
                FROM chunks_fts
                JOIN chunks c ON c.id = chunks_fts.rowid
                JOIN documents d ON d.id = c.doc_id
                WHERE chunks_fts MATCH ? {where_sql}
                ORDER BY rank_score ASC, d.mtime DESC
                LIMIT ? OFFSET ?
                """,
                [fts_expr, *params, fts_fetch, fts_off],
            ).fetchall()
            fts_hits = [dict(r) for r in rows]

        if mode == "fts" or vector_service is None or not cfg.embedding.enabled:
            scored = []
            for r in fts_hits:
                hist = is_historical_doc(r["rel_path"], r["title"])
                base = max(0.01, -float(r["rank_score"]))
                adj = _apply_historical_penalty(base, r["rel_path"], r["title"], include_historical)
                scored.append((adj, hist, r))
            if not include_historical:
                scored.sort(key=lambda x: x[0], reverse=True)
                scored = scored[offset : offset + limit]
            items = [
                {
                    "doc_id": r["doc_id"],
                    "chunk_id": r["chunk_id"],
                    "source_id": r["source_id"],
                    "rel_path": r["rel_path"],
                    "project": r["project"],
                    "title": r["title"],
                    "ext": r["ext"],
                    "heading_path": r["heading_path"],
                    "start_line": r["start_line"],
                    "end_line": r["end_line"],
                    "page_num": r["page_num"],
                    "snippet": make_snippet(r["content"], terms, 240),
                    "score": round(adj, 3),
                    "match_type": "fts",
                    "vec_score": None,
                    "is_historical": hist,
                    "mtime": r["mtime"],
                    "git_author": r["git_author"],
                    "git_date": r["git_date"],
                    "parse_note": r["parse_note"],
                }
                for adj, hist, r in scored
            ]
            return {"query": q, "mode": "fts", "total": fts_total, "items": items}

        allowed_doc_ids: set[int] | None = None
        if where:
            doc_rows = conn.execute(
                f"SELECT id FROM documents d WHERE {' AND '.join(where)}", params
            ).fetchall()
            allowed_doc_ids = {int(r[0]) for r in doc_rows}

        vec_top = vector_service.search_semantic(
            raw_q, allowed_doc_ids=allowed_doc_ids, top_k=max(limit + offset, 110)
        )

        if mode == "semantic":
            chunk_map = _fetch_chunks_by_ids(conn, [cid for cid, _ in vec_top])
            scored_vec = []
            for cid, vscore in vec_top:
                r = chunk_map.get(cid)
                if not r:
                    continue
                hist = is_historical_doc(r["rel_path"], r["title"])
                adj = _apply_historical_penalty(vscore, r["rel_path"], r["title"], include_historical)
                scored_vec.append((adj, vscore, hist, r))
            if not include_historical:
                scored_vec.sort(key=lambda x: x[0], reverse=True)
            page = scored_vec[offset : offset + limit]
            items = [
                {
                    "doc_id": r["doc_id"],
                    "chunk_id": r["chunk_id"],
                    "source_id": r["source_id"],
                    "rel_path": r["rel_path"],
                    "project": r["project"],
                    "title": r["title"],
                    "ext": r["ext"],
                    "heading_path": r["heading_path"],
                    "start_line": r["start_line"],
                    "end_line": r["end_line"],
                    "page_num": r["page_num"],
                    "snippet": make_snippet(r["content"], terms, 240),
                    "score": round(adj, 4),
                    "match_type": "semantic",
                    "vec_score": round(vscore, 3),
                    "is_historical": hist,
                    "mtime": r["mtime"],
                    "git_author": r["git_author"],
                    "git_date": r["git_date"],
                    "parse_note": r["parse_note"],
                }
                for adj, vscore, hist, r in page
            ]
            return {"query": q, "mode": "semantic", "total": len(scored_vec), "items": items}

        # Hybrid RRF fusion + active-doc-first weighting
        rrf_k = max(10, cfg.embedding.rrf_k)
        w_fts = 1.15
        w_vec = 1.0

        rrf_scores: dict[int, float] = {}
        fts_rank_map: dict[int, int] = {}
        vec_score_map: dict[int, float] = {}
        row_cache: dict[int, dict[str, Any]] = {}

        for rank, r in enumerate(fts_hits, 1):
            cid = int(r["chunk_id"])
            row_cache[cid] = r
            fts_rank_map[cid] = rank
            rrf_scores[cid] = rrf_scores.get(cid, 0.0) + w_fts / (rrf_k + rank)

        for rank, (cid, vscore) in enumerate(vec_top, 1):
            vec_score_map[cid] = vscore
            rrf_scores[cid] = rrf_scores.get(cid, 0.0) + w_vec / (rrf_k + rank)

        missing_cids = [cid for cid in rrf_scores if cid not in row_cache]
        if missing_cids:
            row_cache.update(_fetch_chunks_by_ids(conn, missing_cids))

        # Apply active-first weighting cleanly across all fused candidates
        adjusted_scores: dict[int, float] = {}
        hist_flags: dict[int, bool] = {}
        for cid, sc in rrf_scores.items():
            r = row_cache.get(cid)
            if not r:
                continue
            h = is_historical_doc(r["rel_path"], r["title"])
            hist_flags[cid] = h
            adjusted_scores[cid] = _apply_historical_penalty(sc, r["rel_path"], r["title"], include_historical)

        ranked_cids = sorted(adjusted_scores.keys(), key=lambda c: adjusted_scores[c], reverse=True)
        total_fused = max(len(ranked_cids), fts_total)
        page_cids = ranked_cids[offset : offset + limit]

        items = []
        for cid in page_cids:
            r = row_cache.get(cid)
            if not r:
                continue
            in_fts = cid in fts_rank_map
            in_vec = cid in vec_score_map
            mtype = "both" if (in_fts and in_vec) else ("fts" if in_fts else "semantic")
            items.append(
                {
                    "doc_id": r["doc_id"],
                    "chunk_id": r["chunk_id"],
                    "source_id": r["source_id"],
                    "rel_path": r["rel_path"],
                    "project": r["project"],
                    "title": r["title"],
                    "ext": r["ext"],
                    "heading_path": r["heading_path"],
                    "start_line": r["start_line"],
                    "end_line": r["end_line"],
                    "page_num": r["page_num"],
                    "snippet": make_snippet(r["content"], terms, 240),
                    "score": round(adjusted_scores[cid] * 100.0, 2),
                    "match_type": mtype,
                    "vec_score": round(vec_score_map[cid], 3) if in_vec else None,
                    "is_historical": hist_flags.get(cid, False),
                    "mtime": r["mtime"],
                    "git_author": r["git_author"],
                    "git_date": r["git_date"],
                    "parse_note": r["parse_note"],
                }
            )

        effective_mode = "hybrid" if vec_top else "fts"
        return {"query": q, "mode": effective_mode, "total": total_fused, "items": items}
    finally:
        conn.close()


def quick_jump(cfg: AppConfig, q: str, limit: int = 16) -> dict[str, Any]:
    """Ultra-fast Cmd+K lookup over documents & projects (<5ms)."""
    kw = q.strip()
    conn = connect_db(cfg.db_path)
    try:
        if not kw:
            docs = conn.execute(
                """
                SELECT source_id, rel_path, project, title, ext, mtime, git_author
                FROM documents
                ORDER BY mtime DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            projs = conn.execute(
                """
                SELECT source_id, project, COUNT(*) AS doc_count, MAX(mtime) AS last_mtime
                FROM documents
                WHERE project != '(根目录)'
                GROUP BY source_id, project
                ORDER BY last_mtime DESC
                LIMIT 8
                """
            ).fetchall()
        else:
            like = f"%{kw}%"
            docs = conn.execute(
                """
                SELECT source_id, rel_path, project, title, ext, mtime, git_author
                FROM documents
                WHERE title LIKE ? OR rel_path LIKE ? OR project LIKE ?
                ORDER BY
                    CASE WHEN title LIKE ? THEN 0 ELSE 1 END,
                    mtime DESC
                LIMIT ?
                """,
                (like, like, like, like, limit),
            ).fetchall()
            projs = conn.execute(
                """
                SELECT source_id, project, COUNT(*) AS doc_count, MAX(mtime) AS last_mtime
                FROM documents
                WHERE project LIKE ?
                GROUP BY source_id, project
                ORDER BY doc_count DESC
                LIMIT 6
                """,
                (like,),
            ).fetchall()
        return {
            "documents": [
                {**dict(r), "is_historical": is_historical_doc(r["rel_path"], r["title"])}
                for r in docs
            ],
            "projects": [dict(r) for r in projs],
        }
    finally:
        conn.close()


def get_document_detail(cfg: AppConfig, source_id: str, rel_path: str) -> dict[str, Any] | None:
    safe = cfg.resolve_safe_path(source_id, rel_path)
    if not safe or not safe.exists() or not safe.is_file():
        return None

    conn = connect_db(cfg.db_path)
    try:
        doc = conn.execute(
            "SELECT * FROM documents WHERE source_id=? AND rel_path=?",
            (source_id, rel_path),
        ).fetchone()
        chunks = []
        if doc:
            chunks = [
                dict(r)
                for r in conn.execute(
                    """
                    SELECT id, chunk_index, heading_path, start_line, end_line, page_num, content
                    FROM chunks WHERE doc_id=? ORDER BY chunk_index ASC
                    """,
                    (doc["id"],),
                ).fetchall()
            ]
    finally:
        conn.close()

    ext = safe.suffix.lower()
    is_text = ext in {".md", ".txt", ".yaml", ".yml", ".csv", ".json", ".py", ".sh"}
    raw_content = ""
    if is_text:
        try:
            raw_content = safe.read_text(encoding="utf-8", errors="replace")
            if len(raw_content) > 600_000:
                raw_content = raw_content[:600_000] + "\n\n... [文件过大，预览已截断至 600KB] ..."
        except Exception as exc:
            raw_content = f"读取文件失败：{exc}"
    else:
        parts: list[str] = []
        for ch in chunks:
            header = f"### {ch['heading_path']}" if ch["heading_path"] else ""
            if ch["page_num"]:
                header = f"### 第 {ch['page_num']} 页"
            parts.append(f"{header}\n{ch['content']}" if header else ch["content"])
        raw_content = "\n\n---\n\n".join(parts)

    src = cfg.source_by_id(source_id)
    git_history: list[dict[str, str]] = []
    if src and src.is_git and (src.path / ".git").exists():
        try:
            proc = subprocess.run(
                [
                    "git",
                    "-C",
                    str(src.path),
                    "log",
                    "-n",
                    "10",
                    "--pretty=format:%h|%an|%aI|%s",
                    "--",
                    rel_path,
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=8,
                check=False,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            for ln in proc.stdout.splitlines():
                cols = ln.split("|", 3)
                if len(cols) == 4:
                    git_history.append(
                        {"hash": cols[0], "author": cols[1], "date": cols[2], "message": cols[3]}
                    )
        except Exception:
            pass

    st = safe.stat()
    meta = dict(doc) if doc else {
        "source_id": source_id,
        "rel_path": rel_path,
        "abs_path": str(safe),
        "project": Path(rel_path).parts[0] if len(Path(rel_path).parts) >= 2 else "(根目录)",
        "title": safe.stem,
        "ext": ext,
        "size_bytes": st.st_size,
        "mtime": st.st_mtime,
        "parse_status": "unindexed",
        "parse_note": "",
        "git_author": "",
        "git_date": "",
        "git_message": "",
    }
    meta["is_historical"] = is_historical_doc(rel_path, meta.get("title", ""))
    return {
        "meta": meta,
        "is_text": is_text,
        "raw_content": raw_content,
        "chunks": chunks,
        "git_history": git_history,
    }


def list_projects(cfg: AppConfig) -> list[dict[str, Any]]:
    conn = connect_db(cfg.db_path)
    try:
        rows = conn.execute(
            """
            SELECT source_id, project, COUNT(*) AS doc_count, MAX(mtime) AS last_mtime
            FROM documents
            GROUP BY source_id, project
            ORDER BY source_id, doc_count DESC, project
            """
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()

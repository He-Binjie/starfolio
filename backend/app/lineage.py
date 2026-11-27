from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import numpy as np

from .config import AppConfig
from .db import connect_db
from .vectors import VectorService

_MD_LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
_CODE_PATH_RE = re.compile(r"`([A-Za-z0-9_\-./\u4e00-\u9fff]+\.(?:md|pdf|docx|pptx|xlsx))`")
_VERSION_SNAP_RE = re.compile(r"(快照|去版本号前|旧版|归档|_archive|backup|v\d+\.\d+)", re.IGNORECASE)
_DATE_PREFIX_RE = re.compile(r"(20\d{2}-\d{2}-\d{2})")


def _classify_stage(rel_path: str, title: str) -> tuple[int, str]:
    """Classify document into 4 natural knowledge lifecycle stages (1=上游输入 -> 4=下游复盘)."""
    hay = f"{rel_path} {title}".lower()
    if any(k in hay for k in ("meetings/", "会议", "纪要", "访谈", "调研", "references/", "原始资料", "背景")):
        return 1, "调研与会议"
    if any(k in hay for k in ("decisions/", "决策", "口径", "结论", "原则", "strategy", "策略")):
        return 2, "决策与口径"
    if any(k in hay for k in ("prd", "mrd", "规格", "需求文档", "logic", "方案", "设计", "modules/", "sop", "presentations/")):
        return 3, "PRD 与方案"
    return 4, "执行与复盘"


def _normalize_stem_for_version(rel_path: str, title: str) -> str:
    name = Path(rel_path).stem
    s = re.sub(r"20\d{2}[-_.]?\d{2}[-_.]?\d{2}", "", name)
    s = re.sub(r"v\d+(?:\.\d+)*", "", s, flags=re.IGNORECASE)
    s = re.sub(r"(去版本号前|全量快照|快照|飞书|旧版|终版|草稿|副本|待审|\(\d+\))", "", s)
    s = re.sub(r"[-_\s·]+", "", s).strip().lower()
    return s


def _resolve_linked_relpath(source_root: Path, doc_rel: str, href: str, known_rels: set[str]) -> str | None:
    clean = href.strip().split("#")[0].split("?")[0].strip()
    if not clean or clean.startswith(("http://", "https://", "mailto:", "file://", "conversation://", "#")):
        return None
    # Try relative to current doc's directory
    doc_dir = (source_root / doc_rel).parent
    for cand in ((doc_dir / clean), (source_root / clean)):
        try:
            resolved = cand.resolve()
            rel = str(resolved.relative_to(source_root.resolve())).replace("\\", "/")
            if rel in known_rels and rel != doc_rel:
                return rel
            # Directory link -> try dir/INDEX.md
            if f"{rel}/INDEX.md" in known_rels and f"{rel}/INDEX.md" != doc_rel:
                return f"{rel}/INDEX.md"
        except Exception:
            pass
    # Fallback: match unique filename suffix in same source
    fname = Path(clean).name
    if fname and "." in fname:
        matches = [r for r in known_rels if r.endswith(f"/{fname}") or r == fname]
        if len(matches) == 1 and matches[0] != doc_rel:
            return matches[0]
    return None


def _scan_explicit_edges_for_source(
    cfg: AppConfig,
    source_id: str,
    docs_in_source: list[dict[str, Any]],
) -> list[tuple[int, int]]:
    """Return list of (from_doc_id, to_doc_id) where from_doc explicitly links/references to_doc."""
    src = cfg.source_by_id(source_id)
    if not src or src.kind == "files" or not src.path.exists():
        return []
    rel_to_id = {d["rel_path"]: int(d["id"]) for d in docs_in_source}
    known_rels = set(rel_to_id.keys())
    edges: set[tuple[int, int]] = set()

    for d in docs_in_source:
        if d["ext"] not in {".md", ".txt"}:
            continue
        # Skip pure index/changelog aggregators as lineage hubs (they link everything and add noise)
        fname = Path(d["rel_path"]).name
        if fname in {"INDEX.md", "changelog.md", "ASSETS.md", "PORTAL.md"}:
            continue
        fpath = src.path / d["rel_path"]
        if not fpath.exists() or fpath.stat().st_size > 400_000:
            continue
        try:
            txt = fpath.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        from_id = int(d["id"])
        for m in _MD_LINK_RE.finditer(txt):
            target_rel = _resolve_linked_relpath(src.path, d["rel_path"], m.group(1), known_rels)
            if target_rel and Path(target_rel).name not in {"INDEX.md", "changelog.md", "ASSETS.md"}:
                edges.add((from_id, rel_to_id[target_rel]))
        for m in _CODE_PATH_RE.finditer(txt):
            target_rel = _resolve_linked_relpath(src.path, d["rel_path"], m.group(1), known_rels)
            if target_rel and Path(target_rel).name not in {"INDEX.md", "changelog.md", "ASSETS.md"}:
                edges.add((from_id, rel_to_id[target_rel]))
    return list(edges)


def _doc_sort_ts(d: dict[str, Any]) -> str:
    m = _DATE_PREFIX_RE.search(d["rel_path"])
    if m:
        return m.group(1)
    if d.get("git_date"):
        return str(d["git_date"])[:10]
    return f"{int(d.get('mtime', 0)):012d}"


def get_document_lineage(
    cfg: AppConfig,
    vector_service: VectorService,
    source_id: str,
    rel_path: str,
) -> dict[str, Any]:
    """Build deterministic + semantic Document Lineage (upstream sources -> current doc -> downstream impact)."""
    conn = connect_db(cfg.db_path)
    try:
        cur_row = conn.execute(
            "SELECT id, source_id, rel_path, project, title, ext, mtime, git_date FROM documents WHERE source_id=? AND rel_path=?",
            (source_id, rel_path),
        ).fetchone()
        if not cur_row:
            return {"current": None, "upstream": [], "downstream": [], "version_chain": []}
        cur_doc = dict(cur_row)
        same_source_docs = [
            dict(r)
            for r in conn.execute(
                "SELECT id, source_id, rel_path, project, title, ext, mtime, git_date FROM documents WHERE source_id=?",
                (source_id,),
            ).fetchall()
        ]
    finally:
        conn.close()

    id_to_doc = {int(d["id"]): d for d in same_source_docs}
    cur_id = int(cur_doc["id"])
    cur_stage, cur_stage_label = _classify_stage(cur_doc["rel_path"], cur_doc["title"])
    cur_ts = _doc_sort_ts(cur_doc)
    cur_stem = _normalize_stem_for_version(cur_doc["rel_path"], cur_doc["title"])

    upstream_map: dict[tuple[str, str], dict[str, Any]] = {}
    downstream_map: dict[tuple[str, str], dict[str, Any]] = {}
    version_chain: list[dict[str, Any]] = []

    def make_node(d: dict[str, Any], edge_type: str, edge_label: str, sim: float | None = None) -> dict[str, Any]:
        st_num, st_lbl = _classify_stage(d["rel_path"], d["title"])
        return {
            "source_id": d["source_id"],
            "rel_path": d["rel_path"],
            "project": d["project"],
            "title": d["title"],
            "ext": d["ext"],
            "mtime": d["mtime"],
            "stage": st_num,
            "stage_label": st_lbl,
            "edge_type": edge_type,
            "edge_label": edge_label,
            "similarity": sim,
        }

    # 1. Explicit Markdown link / path references (100% deterministic!)
    # If A links to B -> B is A's upstream reference; A is B's downstream consumer!
    explicit_edges = _scan_explicit_edges_for_source(cfg, source_id, same_source_docs)
    for a_id, b_id in explicit_edges:
        if a_id == cur_id and b_id in id_to_doc:
            d = id_to_doc[b_id]
            upstream_map[(d["source_id"], d["rel_path"])] = make_node(d, "explicit", "显式引用（本篇提及）")
        elif b_id == cur_id and a_id in id_to_doc:
            d = id_to_doc[a_id]
            downstream_map[(d["source_id"], d["rel_path"])] = make_node(d, "explicit", "被该文档显式引用")

    # 2. Version / Snapshot Evolution chain (deterministic stem match in same project)
    if len(cur_stem) >= 4:
        for d in same_source_docs:
            if int(d["id"]) == cur_id or d["project"] != cur_doc["project"]:
                continue
            ostem = _normalize_stem_for_version(d["rel_path"], d["title"])
            if len(ostem) >= 4 and (ostem == cur_stem or ostem in cur_stem or cur_stem in ostem):
                ots = _doc_sort_ts(d)
                d_is_snap = bool(_VERSION_SNAP_RE.search(d["rel_path"]))
                cur_is_snap = bool(_VERSION_SNAP_RE.search(cur_doc["rel_path"]))
                key = (d["source_id"], d["rel_path"])
                if (d_is_snap and not cur_is_snap) or (ots < cur_ts and d_is_snap == cur_is_snap):
                    node = make_node(d, "version", "历史版本 / 前序快照")
                    version_chain.append(node)
                    upstream_map.setdefault(key, node)
                else:
                    node = make_node(d, "version", "后续演进 / 新版本")
                    version_chain.append(node)
                    downstream_map.setdefault(key, node)

    # 3. Semantic + Temporal/Stage Flow (same project high similarity >= 0.76)
    related = vector_service.find_related_documents(cur_id, limit=8, min_score=0.74)
    for rd in related:
        key = (rd["source_id"], rd["rel_path"])
        if key in upstream_map or key in downstream_map:
            continue
        if rd["source_id"] != cur_doc["source_id"] or rd["project"] != cur_doc["project"]:
            continue
        r_stage, _ = _classify_stage(rd["rel_path"], rd["title"])
        r_ts = _doc_sort_ts(rd)
        if r_stage < cur_stage or (r_stage == cur_stage and r_ts < cur_ts):
            upstream_map[key] = make_node(rd, "semantic", f"同项目前序依据 ({int(rd['similarity']*100)}%)", rd["similarity"])
        elif r_stage > cur_stage or (r_stage == cur_stage and r_ts > cur_ts):
            downstream_map[key] = make_node(rd, "semantic", f"同项目后续衍生 ({int(rd['similarity']*100)}%)", rd["similarity"])

    # Prioritize explicit > version > semantic
    prio = {"explicit": 0, "version": 1, "semantic": 2}
    upstream = sorted(upstream_map.values(), key=lambda x: (prio.get(x["edge_type"], 9), -(x["similarity"] or 0)))[:8]
    downstream = sorted(downstream_map.values(), key=lambda x: (prio.get(x["edge_type"], 9), -(x["similarity"] or 0)))[:8]

    return {
        "current": {
            "source_id": cur_doc["source_id"],
            "rel_path": cur_doc["rel_path"],
            "project": cur_doc["project"],
            "title": cur_doc["title"],
            "ext": cur_doc["ext"],
            "stage": cur_stage,
            "stage_label": cur_stage_label,
        },
        "upstream": upstream,
        "downstream": downstream,
        "version_chain": version_chain[:6],
    }


def enrich_starmap_with_lineage(
    cfg: AppConfig,
    starmap: dict[str, Any],
) -> dict[str, Any]:
    """Attach directed lineage edges (explicit links, version evolution, temporal-stage flow) to Star Map."""
    nodes = starmap.get("nodes") or []
    if not nodes:
        starmap["lineage_edges"] = []
        return starmap

    key_to_idx = {(n["source_id"], n["rel_path"]): n["idx"] for n in nodes}
    sources_present = sorted({n["source_id"] for n in nodes})

    conn = connect_db(cfg.db_path)
    try:
        docs_by_source: dict[str, list[dict[str, Any]]] = {}
        id_to_key: dict[int, tuple[str, str]] = {}
        for sid in sources_present:
            rows = [
                dict(r)
                for r in conn.execute(
                    "SELECT id, source_id, rel_path, project, title, ext, mtime, git_date FROM documents WHERE source_id=?",
                    (sid,),
                ).fetchall()
            ]
            docs_by_source[sid] = rows
            for r in rows:
                id_to_key[int(r["id"])] = (r["source_id"], r["rel_path"])
    finally:
        conn.close()

    lineage_edges: list[dict[str, Any]] = []
    seen_pairs: set[tuple[int, int]] = set()

    # 1. Explicit Markdown links between displayed star nodes (from referenced -> referencing = upstream -> downstream)
    for sid, sdocs in docs_by_source.items():
        for from_id, to_id in _scan_explicit_edges_for_source(cfg, sid, sdocs):
            ka = id_to_key.get(from_id)
            kb = id_to_key.get(to_id)
            if ka in key_to_idx and kb in key_to_idx:
                # to_id is referenced by from_id => flow from to_id (upstream) -> from_id (downstream)
                u_idx, d_idx = key_to_idx[kb], key_to_idx[ka]
                if u_idx != d_idx and (u_idx, d_idx) not in seen_pairs:
                    seen_pairs.add((u_idx, d_idx))
                    lineage_edges.append({"from": u_idx, "to": d_idx, "type": "explicit", "label": "显式引用"})

    # 2. Version evolution & temporal-stage flow along existing high-similarity constellation edges
    for edge in starmap.get("edges") or []:
        na = nodes[edge["a"]]
        nb = nodes[edge["b"]]
        if na["source_id"] != nb["source_id"] or na["project"] != nb["project"]:
            continue
        sa, _ = _classify_stage(na["rel_path"], na["title"])
        sb, _ = _classify_stage(nb["rel_path"], nb["title"])
        stem_a = _normalize_stem_for_version(na["rel_path"], na["title"])
        stem_b = _normalize_stem_for_version(nb["rel_path"], nb["title"])
        is_ver = len(stem_a) >= 4 and len(stem_b) >= 4 and (stem_a == stem_b or stem_a in stem_b or stem_b in stem_a)

        tsa = _doc_sort_ts(na)
        tsb = _doc_sort_ts(nb)

        if is_ver:
            u_idx, d_idx = (na["idx"], nb["idx"]) if tsa <= tsb else (nb["idx"], na["idx"])
            if (u_idx, d_idx) not in seen_pairs and (d_idx, u_idx) not in seen_pairs:
                seen_pairs.add((u_idx, d_idx))
                lineage_edges.append({"from": u_idx, "to": d_idx, "type": "version", "label": "版本演进"})
        elif edge.get("sim", 0) >= 0.78:
            if sa < sb or (sa == sb and tsa < tsb):
                u_idx, d_idx = na["idx"], nb["idx"]
            elif sb < sa or (sa == sb and tsb < tsa):
                u_idx, d_idx = nb["idx"], na["idx"]
            else:
                continue
            if (u_idx, d_idx) not in seen_pairs and (d_idx, u_idx) not in seen_pairs:
                seen_pairs.add((u_idx, d_idx))
                lineage_edges.append({"from": u_idx, "to": d_idx, "type": "semantic", "label": "语义上下游"})

    # Enrich nodes with lifecycle stage info
    for n in nodes:
        st_num, st_lbl = _classify_stage(n["rel_path"], n["title"])
        n["stage"] = st_num
        n["stage_label"] = st_lbl

    starmap["lineage_edges"] = lineage_edges[:320]
    starmap["lineage_stats"] = {
        "explicit": sum(1 for e in lineage_edges if e["type"] == "explicit"),
        "version": sum(1 for e in lineage_edges if e["type"] == "version"),
        "semantic": sum(1 for e in lineage_edges if e["type"] == "semantic"),
    }
    return starmap

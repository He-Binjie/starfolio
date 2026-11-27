from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import PROJECT_ROOT, load_config, load_raw_config, save_raw_config
from .collections_compare import (
    compare_two_documents,
    create_collection,
    delete_collection,
    extract_cross_doc_facts,
    list_collections,
)
from .conflicts import (
    list_conflict_candidates,
    review_conflict_with_llm,
    scan_conflict_candidates,
    update_conflict_status,
)
from .db import connect_db, init_db
from .health import build_health_report
from .indexer import IndexerService
from .lineage import enrich_starmap_with_lineage, get_document_lineage
from .projects import get_project_detail, get_projects_overview
from .qa import ask_knowledge_base, list_qa_engines, list_qa_history, test_openai_connection
from .search import get_document_detail, list_projects, quick_jump, search_chunks
from .timeline import get_commit_diff, get_timeline
from .tree import build_tree
from .vectors import VectorService
from .watcher import DebouncedFileWatcher

cfg = load_config()
init_db(cfg.db_path)
indexer = IndexerService(cfg)
vectors = VectorService(cfg)
_stop_event = threading.Event()
_reload_lock = threading.Lock()


def _run_incremental_pipeline(force: bool = False) -> None:
    res = indexer.run_index(force=force)
    if cfg.embedding.enabled and res.get("status") == "ok":
        if res.get("files_indexed", 0) > 0 or res.get("files_removed", 0) > 0:
            vectors.invalidate_matrix_cache()
        vectors.sync_missing_vectors()


def _trigger_pipeline_async(force: bool = False) -> bool:
    t = threading.Thread(target=_run_incremental_pipeline, kwargs={"force": force}, daemon=True)
    t.start()
    return True


watcher = DebouncedFileWatcher(cfg, on_change=lambda: _trigger_pipeline_async(force=False), debounce_seconds=5.0)


def _reload_runtime_config() -> None:
    global cfg, watcher
    with _reload_lock:
        new_cfg = load_config()
        cfg = new_cfg
        indexer.cfg = new_cfg
        vectors.cfg = new_cfg
        vectors.invalidate_matrix_cache()
        try:
            watcher.stop()
        except Exception:
            pass
        watcher = DebouncedFileWatcher(
            new_cfg,
            on_change=lambda: _trigger_pipeline_async(force=False),
            debounce_seconds=5.0,
        )
        watcher.start()


def _slugify_source_id(name: str, existing: set[str]) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", name.strip()).strip("-").lower()
    base = cleaned or "folder"
    cand = base
    idx = 2
    while cand in existing:
        cand = f"{base}-{idx}"
        idx += 1
    return cand


def _purge_source_from_db(source_id: str) -> None:
    if not cfg.db_path.exists():
        return
    conn = connect_db(cfg.db_path)
    try:
        chunk_rows = conn.execute(
            "SELECT c.id FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE d.source_id = ?",
            (source_id,),
        ).fetchall()
        for r in chunk_rows:
            conn.execute("DELETE FROM chunks_fts WHERE rowid = ?", (r["id"],))
        conn.execute("DELETE FROM documents WHERE source_id = ?", (source_id,))
        conn.execute("DELETE FROM conflict_candidates WHERE source_id = ?", (source_id,))
        conn.commit()
    finally:
        conn.close()
    vectors.invalidate_matrix_cache()


def _resolve_sample_kb_template() -> Path | None:
    env_dir = os.environ.get("KB_CONSOLE_SAMPLE_KB_DIR", "").strip()
    if env_dir and Path(env_dir).exists():
        return Path(env_dir)
    fallback = PROJECT_ROOT / "macos-app" / "sample-kb"
    if fallback.exists():
        return fallback
    return None


def _background_poll_loop() -> None:
    time.sleep(1.5)
    _run_incremental_pipeline(force=False)
    interval = max(30, cfg.poll_interval_seconds)
    while not _stop_event.wait(interval):
        _run_incremental_pipeline(force=False)


def _idle_unload_loop() -> None:
    while not _stop_event.wait(30):
        vectors.maybe_unload_if_idle()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    watcher.start()
    threading.Thread(target=_background_poll_loop, daemon=True).start()
    threading.Thread(target=_idle_unload_loop, daemon=True).start()
    yield
    _stop_event.set()
    watcher.stop()


app = FastAPI(title="kb-console", version="0.3.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$",
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/meta")
def api_meta() -> dict[str, Any]:
    return {
        "name": "kb-console",
        "version": "1.8.0",
        "edition": cfg.edition,
        "onboarding_completed": cfg.onboarding_completed,
        "is_first_run": cfg.edition == "standalone" and not cfg.onboarding_completed and len(cfg.sources) == 0,
        "data_dir": str(cfg.data_dir),
        "read_only": True,
        "watcher_active": watcher.active,
        "sources": [
            {
                "id": s.id,
                "name": s.name,
                "path": str(s.path),
                "kind": s.kind,
                "is_git": s.is_git,
                "sensitivity": s.sensitivity,
            }
            for s in cfg.sources
        ],
        "actors": cfg.actors,
        "projects": list_projects(cfg),
        "qa_engines": list_qa_engines(cfg),
        "index_status": indexer.status(),
        "vector_status": vectors.status(),
    }


@app.get("/api/tree")
def api_tree() -> list[dict[str, Any]]:
    return build_tree(cfg)


@app.get("/api/search")
def api_search(
    q: str = Query(default="", description="检索词"),
    source_id: str | None = Query(default=None),
    project: str | None = Query(default=None),
    ext: str | None = Query(default=None),
    days: int | None = Query(default=None),
    mode: str = Query(default="hybrid", pattern="^(hybrid|fts|semantic)$"),
    include_historical: bool = Query(default=False),
    limit: int = Query(default=40, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    return search_chunks(
        cfg,
        q=q,
        source_id=source_id,
        project=project,
        ext=ext,
        days=days,
        mode=mode,
        include_historical=include_historical,
        limit=limit,
        offset=offset,
        vector_service=vectors,
    )


@app.get("/api/quick-jump")
def api_quick_jump(
    q: str = Query(default=""),
    limit: int = Query(default=16, ge=1, le=40),
) -> dict[str, Any]:
    return quick_jump(cfg, q=q, limit=limit)


@app.get("/api/document")
def api_document(
    source_id: str = Query(...),
    rel_path: str = Query(...),
) -> dict[str, Any]:
    detail = get_document_detail(cfg, source_id, rel_path)
    if detail is None:
        raise HTTPException(status_code=404, detail="文档不存在或已被排除规则拦截")
    return detail


@app.get("/api/document/related")
def api_document_related(
    source_id: str = Query(...),
    rel_path: str = Query(...),
    limit: int = Query(default=6, ge=1, le=12),
) -> dict[str, Any]:
    conn = connect_db(cfg.db_path)
    try:
        row = conn.execute(
            "SELECT id FROM documents WHERE source_id = ? AND rel_path = ?",
            (source_id, rel_path),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return {"items": []}
    return {"items": vectors.find_related_documents(int(row["id"]), limit=limit)}


@app.get("/api/document/lineage")
def api_document_lineage(
    source_id: str = Query(...),
    rel_path: str = Query(...),
) -> dict[str, Any]:
    return get_document_lineage(cfg, vectors, source_id, rel_path)


class OpenExternalReq(BaseModel):
    source_id: str
    rel_path: str
    mode: str = "default"


@app.post("/api/open-external")
def api_open_external(req: OpenExternalReq) -> dict[str, Any]:
    safe = cfg.resolve_safe_path(req.source_id, req.rel_path)
    if not safe or not safe.exists():
        raise HTTPException(status_code=404, detail="文件路径不在允许范围内或不存在")

    if req.mode == "finder":
        cmd = ["open", "-R", str(safe)]
    elif req.mode == "typora":
        cmd = ["open", "-a", "Typora", str(safe)]
    else:
        cmd = ["open", str(safe)]

    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=5, check=False)
    if proc.returncode != 0 and req.mode == "typora":
        proc = subprocess.run(["open", str(safe)], capture_output=True, text=True, timeout=5, check=False)
    return {"ok": proc.returncode == 0, "error": proc.stderr.strip()}


@app.get("/api/projects/overview")
def api_projects_overview() -> list[dict[str, Any]]:
    return get_projects_overview(cfg)


@app.get("/api/projects/detail")
def api_projects_detail(
    source_id: str = Query(...),
    project: str = Query(...),
) -> dict[str, Any]:
    detail = get_project_detail(cfg, source_id, project)
    if detail is None:
        raise HTTPException(status_code=404, detail="找不到对应项目")
    return detail


@app.get("/api/projects/clusters")
def api_projects_clusters(
    source_id: str | None = Query(default=None),
    max_clusters: int = Query(default=10, ge=2, le=18),
) -> dict[str, Any]:
    return vectors.cluster_documents(source_id=source_id, max_clusters=max_clusters)


@app.get("/api/projects/starmap")
def api_projects_starmap(
    source_id: str | None = Query(default=None),
    max_docs: int = Query(default=220, ge=20, le=400),
    max_clusters: int = Query(default=8, ge=2, le=12),
) -> dict[str, Any]:
    sm = vectors.build_star_map(source_id=source_id, max_docs=max_docs, max_clusters=max_clusters)
    return enrich_starmap_with_lineage(cfg, sm)


@app.get("/api/health/duplicates")
def api_health_duplicates(limit: int = Query(default=30, ge=1, le=80)) -> dict[str, Any]:
    return vectors.find_duplicates(limit=limit)


@app.get("/api/timeline")
def api_timeline(
    actor: str | None = Query(default=None),
    source_id: str | None = Query(default=None),
    days: int | None = Query(default=None),
    limit: int = Query(default=120, ge=1, le=500),
) -> dict[str, Any]:
    return get_timeline(cfg, actor=actor, source_id=source_id, days=days, limit=limit)


@app.get("/api/timeline/diff")
def api_timeline_diff(
    source_id: str = Query(...),
    commit: str = Query(...),
) -> dict[str, Any]:
    res = get_commit_diff(cfg, source_id, commit)
    if res is None:
        raise HTTPException(status_code=404, detail="找不到对应仓库或提交")
    return res


@app.get("/api/health")
def api_health() -> dict[str, Any]:
    return build_health_report(
        cfg,
        indexer.status(),
        vector_status=vectors.status(),
        watcher_active=watcher.active,
    )


@app.post("/api/index/refresh")
def api_index_refresh(force: bool = Query(default=False)) -> dict[str, Any]:
    started = _trigger_pipeline_async(force=force)
    return {"started": started, "progress": indexer.status()["progress"]}


@app.get("/api/index/status")
def api_index_status() -> dict[str, Any]:
    return indexer.status()


@app.get("/api/vectors/status")
def api_vectors_status() -> dict[str, Any]:
    return vectors.status()


@app.post("/api/vectors/sync")
def api_vectors_sync() -> dict[str, Any]:
    started = vectors.trigger_sync_async()
    return {"started": started, "status": vectors.status()}


class QaAskReq(BaseModel):
    question: str
    engine_id: str | None = None
    source_id: str | None = None
    project: str | None = None
    top_k: int | None = None
    include_historical: bool = False
    selected_docs: list[dict[str, str]] | None = None
    conversation_turns: list[dict[str, str]] | None = None


@app.get("/api/qa/engines")
def api_qa_engines() -> list[dict[str, Any]]:
    return list_qa_engines(cfg)


@app.post("/api/qa/ask")
def api_qa_ask(req: QaAskReq) -> dict[str, Any]:
    try:
        return ask_knowledge_base(
            cfg,
            vector_service=vectors,
            question=req.question,
            engine_id=req.engine_id,
            source_id=req.source_id,
            project=req.project,
            top_k=req.top_k,
            include_historical=req.include_historical,
            selected_docs=req.selected_docs,
            conversation_turns=req.conversation_turns,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/qa/history")
def api_qa_history(limit: int = Query(default=40, ge=1, le=200)) -> list[dict[str, Any]]:
    return list_qa_history(cfg, limit=limit)


@app.get("/api/conflicts")
def api_conflicts(include_dismissed: bool = Query(default=False)) -> list[dict[str, Any]]:
    return list_conflict_candidates(cfg, include_dismissed=include_dismissed)


@app.post("/api/conflicts/scan")
def api_conflicts_scan() -> dict[str, Any]:
    return scan_conflict_candidates(cfg, vectors)


class ConflictReviewReq(BaseModel):
    engine_id: str | None = None


@app.post("/api/conflicts/{conflict_id}/review")
def api_conflict_review(conflict_id: int, req: ConflictReviewReq | None = None) -> dict[str, Any]:
    try:
        return review_conflict_with_llm(cfg, conflict_id, engine_id=req.engine_id if req else None)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


class ConflictStatusReq(BaseModel):
    status: str


@app.post("/api/conflicts/{conflict_id}/status")
def api_conflict_status(conflict_id: int, req: ConflictStatusReq) -> dict[str, Any]:
    try:
        res = update_conflict_status(cfg, conflict_id, req.status)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if res is None:
        raise HTTPException(status_code=404, detail="冲突候选不存在")
    return res


# ---------- v1.3 / v1.4 / v1.5: Collections, Side-by-Side Compare, Fact Matrix, Star Map, Duplicates ----------


class CreateCollectionReq(BaseModel):
    name: str
    description: str = ""
    docs: list[dict[str, str]]


class CompareDocsReq(BaseModel):
    source_a: str
    path_a: str
    source_b: str
    path_b: str


class FactMatrixReq(BaseModel):
    docs: list[dict[str, str]]


@app.get("/api/collections")
def api_list_collections() -> list[dict[str, Any]]:
    return list_collections(cfg)


@app.post("/api/collections")
def api_create_collection(req: CreateCollectionReq) -> dict[str, Any]:
    try:
        return create_collection(cfg, name=req.name, docs=req.docs, description=req.description)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/collections/{collection_id}/delete")
def api_delete_collection(collection_id: int) -> dict[str, Any]:
    ok = delete_collection(cfg, collection_id)
    if not ok:
        raise HTTPException(status_code=404, detail="卷宗不存在")
    return {"ok": True, "id": collection_id}


@app.post("/api/compare")
def api_compare_docs(req: CompareDocsReq) -> dict[str, Any]:
    try:
        return compare_two_documents(cfg, req.source_a, req.path_a, req.source_b, req.path_b)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/analyze/facts")
def api_analyze_facts(req: FactMatrixReq) -> dict[str, Any]:
    return extract_cross_doc_facts(cfg, req.docs)


# ---------- Settings & Onboarding (Standalone & Personal) ----------


class AddSourceReq(BaseModel):
    path: str
    name: str | None = None


class AddPathsReq(BaseModel):
    paths: list[str]
    name: str | None = None


class RemoveSourceReq(BaseModel):
    source_id: str


class RemovePickedFileReq(BaseModel):
    source_id: str = "picked-files"
    file_path: str


class OpenAiSettingsReq(BaseModel):
    enabled: bool = True
    base_url: str
    api_key: str = ""
    model: str
    clear_key: bool = False


class OpenAiTestReq(BaseModel):
    base_url: str
    api_key: str = ""
    model: str


class ExcludeKeywordsReq(BaseModel):
    keywords: list[str]


class OnboardingCompleteReq(BaseModel):
    completed: bool = True


def _add_paths_to_config(paths: list[str], name: str | None = None) -> dict[str, Any]:
    raw, cfg_path, _ = load_raw_config()
    sources = list(raw.get("sources") or [])

    added_folders: list[str] = []
    added_files: list[str] = []
    already_existing: list[str] = []
    skipped_unsupported: list[str] = []
    not_found: list[str] = []

    picked_entry = next((s for s in sources if str(s.get("id")) == "picked-files" and s.get("kind") == "files"), None)
    picked_resolved_set: set[str] = set()
    if picked_entry:
        for fp in picked_entry.get("files") or []:
            try:
                picked_resolved_set.add(str(Path(fp).expanduser().resolve()))
            except Exception:
                picked_resolved_set.add(str(fp))

    existing_folder_roots: set[str] = set()
    for s in sources:
        if s.get("kind") != "files" and s.get("path"):
            try:
                existing_folder_roots.add(str(Path(s["path"]).expanduser().resolve()))
            except Exception:
                pass

    for raw_p in paths:
        cleaned = (raw_p or "").strip()
        if not cleaned:
            continue
        p = Path(cleaned).expanduser()
        if not p.exists():
            not_found.append(cleaned)
            continue
        resolved = str(p.resolve())
        if p.is_dir():
            if resolved in existing_folder_roots:
                already_existing.append(resolved)
                continue
            display_name = (name or "").strip() if len(paths) == 1 else ""
            display_name = display_name or p.name or "本地资料库"
            existing_ids = {str(s.get("id", "")) for s in sources}
            new_id = _slugify_source_id(display_name, existing_ids)
            sources.append(
                {
                    "id": new_id,
                    "name": display_name,
                    "path": resolved,
                    "kind": "wiki" if (p / ".git").exists() else "folder",
                    "is_git": (p / ".git").exists(),
                    "sensitivity": "personal",
                }
            )
            existing_folder_roots.add(resolved)
            added_folders.append(resolved)
        elif p.is_file():
            ext = p.suffix.lower()
            if ext not in cfg.allowed_extensions:
                skipped_unsupported.append(p.name)
                continue
            if resolved in picked_resolved_set:
                already_existing.append(resolved)
                continue
            if picked_entry is None:
                picked_entry = {
                    "id": "picked-files",
                    "name": "拾取的零散文件",
                    "path": "",
                    "kind": "files",
                    "is_git": False,
                    "sensitivity": "personal",
                    "files": [],
                }
                sources.append(picked_entry)
            picked_entry["files"].append(resolved)
            picked_resolved_set.add(resolved)
            added_files.append(resolved)

    changed = bool(added_folders or added_files)
    if changed:
        raw["sources"] = sources
        save_raw_config(cfg_path, raw)
        _reload_runtime_config()
        _trigger_pipeline_async(force=False)

    return {
        "ok": True,
        "changed": changed,
        "added_folders": added_folders,
        "added_files": added_files,
        "already_existing": already_existing,
        "skipped_unsupported": skipped_unsupported,
        "not_found": not_found,
    }


@app.get("/api/settings")
def api_get_settings() -> dict[str, Any]:
    oai = cfg.qa.openai_api
    key_raw = oai.api_key.strip()
    key_hint = f"****{key_raw[-4:]}" if len(key_raw) >= 4 else ("****" if key_raw else "")
    return {
        "edition": cfg.edition,
        "onboarding_completed": cfg.onboarding_completed,
        "config_path": str(cfg.config_path),
        "data_dir": str(cfg.data_dir),
        "sample_available": _resolve_sample_kb_template() is not None,
        "allowed_extensions": sorted(cfg.allowed_extensions),
        "sources": [
            {
                "id": s.id,
                "name": s.name,
                "path": "" if s.kind == "files" else str(s.path),
                "kind": s.kind,
                "is_git": s.is_git,
                "exists": bool(s.files) if s.kind == "files" else s.path.exists(),
                "files": [str(fp) for fp in s.files] if s.kind == "files" else [],
            }
            for s in cfg.sources
        ],
        "openai_api": {
            "enabled": oai.enabled,
            "base_url": oai.base_url,
            "model": oai.model,
            "api_key_set": bool(key_raw),
            "api_key_hint": key_hint,
        },
        "exclude_keywords": cfg.exclude_keywords,
    }


@app.post("/api/settings/sources/add")
def api_add_source(req: AddSourceReq) -> dict[str, Any]:
    target = Path(req.path.strip()).expanduser()
    if not target.exists():
        raise HTTPException(status_code=400, detail=f"路径不存在或无法读取：{target}")
    res = _add_paths_to_config([req.path], name=req.name)
    if not res["added_folders"] and not res["added_files"] and res["skipped_unsupported"]:
        allowed = " / ".join(sorted(cfg.allowed_extensions))
        raise HTTPException(
            status_code=400,
            detail=f"暂不支持该文件格式：{res['skipped_unsupported'][0]}（当前支持：{allowed}）",
        )
    return res


@app.post("/api/settings/sources/add-paths")
def api_add_paths(req: AddPathsReq) -> dict[str, Any]:
    if not req.paths:
        raise HTTPException(status_code=400, detail="未选择任何文件或文件夹")
    res = _add_paths_to_config(req.paths, name=req.name)
    if not res["added_folders"] and not res["added_files"] and not res["already_existing"]:
        if res["skipped_unsupported"]:
            allowed = " / ".join(sorted(cfg.allowed_extensions))
            raise HTTPException(
                status_code=400,
                detail=f"所选文件格式暂不支持：{', '.join(res['skipped_unsupported'][:5])}（当前支持：{allowed}）",
            )
        raise HTTPException(status_code=400, detail="所选路径不存在或无法读取")
    return res


@app.post("/api/settings/sources/remove-file")
def api_remove_picked_file(req: RemovePickedFileReq) -> dict[str, Any]:
    raw, cfg_path, _ = load_raw_config()
    sources = list(raw.get("sources") or [])
    target_norm = str(Path(req.file_path).expanduser().resolve())
    found = False
    new_sources = []
    for s in sources:
        if str(s.get("id")) == req.source_id and s.get("kind") == "files":
            kept = []
            for fp in s.get("files") or []:
                try:
                    fp_norm = str(Path(fp).expanduser().resolve())
                except Exception:
                    fp_norm = str(fp)
                if fp_norm == target_norm or str(fp) == req.file_path:
                    found = True
                    continue
                kept.append(fp)
            if kept:
                s["files"] = kept
                new_sources.append(s)
        else:
            new_sources.append(s)
    if not found:
        raise HTTPException(status_code=404, detail="找不到对应已拾取文件")
    raw["sources"] = new_sources
    save_raw_config(cfg_path, raw)
    _reload_runtime_config()
    _trigger_pipeline_async(force=False)
    return {"ok": True, "removed": req.file_path}


@app.post("/api/settings/sources/remove")
def api_remove_source(req: RemoveSourceReq) -> dict[str, Any]:
    raw, cfg_path, _ = load_raw_config()
    sources = list(raw.get("sources") or [])
    new_sources = [s for s in sources if str(s.get("id")) != req.source_id]
    if len(new_sources) == len(sources):
        raise HTTPException(status_code=404, detail="找不到对应资料库配置")
    raw["sources"] = new_sources
    save_raw_config(cfg_path, raw)
    _purge_source_from_db(req.source_id)
    _reload_runtime_config()
    return {"ok": True, "removed": req.source_id}


@app.post("/api/settings/load-sample")
def api_load_sample_kb() -> dict[str, Any]:
    tpl = _resolve_sample_kb_template()
    if tpl is None:
        raise HTTPException(status_code=404, detail="未找到内置示例知识库模板")

    target_dir = cfg.data_dir / "sample-kb"
    target_dir.mkdir(parents=True, exist_ok=True)
    shutil.copytree(tpl, target_dir, dirs_exist_ok=True)

    raw, cfg_path, _ = load_raw_config()
    sources = list(raw.get("sources") or [])
    resolved = str(target_dir.resolve())
    if not any(str(s.get("id")) == "sample-kb" for s in sources):
        sources.append(
            {
                "id": "sample-kb",
                "name": "示例知识库（可随时移除）",
                "path": resolved,
                "kind": "wiki",
                "is_git": False,
                "sensitivity": "personal",
            }
        )
        raw["sources"] = sources
        save_raw_config(cfg_path, raw)

    _reload_runtime_config()
    # Run index + vector sync + conflict scan synchronously (3 small markdown files, takes ~1-2s)
    idx_res = indexer.run_index(force=False)
    vec_res = vectors.sync_missing_vectors() if cfg.embedding.enabled else {}
    conf_res = scan_conflict_candidates(cfg, vectors) if cfg.embedding.enabled else {}
    return {
        "ok": True,
        "path": resolved,
        "index": idx_res,
        "vectors": vec_res,
        "conflicts": conf_res,
    }


@app.post("/api/settings/openai")
def api_save_openai_settings(req: OpenAiSettingsReq) -> dict[str, Any]:
    raw, cfg_path, _ = load_raw_config()
    qa_raw = dict(raw.get("qa") or {})
    oai = dict(qa_raw.get("openai_api") or {})

    oai["enabled"] = bool(req.enabled)
    oai["base_url"] = req.base_url.strip() or "https://api.deepseek.com/v1"
    oai["model"] = req.model.strip() or "deepseek-chat"
    if req.clear_key:
        oai["api_key"] = ""
    elif req.api_key.strip():
        oai["api_key"] = req.api_key.strip()

    qa_raw["openai_api"] = oai
    if oai.get("api_key", "").strip():
        qa_raw["default_engine"] = "openai-api"
    raw["qa"] = qa_raw
    save_raw_config(cfg_path, raw)
    _reload_runtime_config()
    return {"ok": True, "api_key_set": bool(cfg.qa.openai_api.api_key.strip())}


@app.post("/api/settings/openai/test")
def api_test_openai_settings(req: OpenAiTestReq) -> dict[str, Any]:
    key = req.api_key.strip() or cfg.qa.openai_api.api_key.strip()
    if not key:
        return {"ok": False, "latency_ms": 0, "error": "请先输入 API Key"}
    base_url = req.base_url.strip() or cfg.qa.openai_api.base_url
    model = req.model.strip() or cfg.qa.openai_api.model
    return test_openai_connection(base_url, key, model)


@app.post("/api/settings/exclude-keywords")
def api_save_exclude_keywords(req: ExcludeKeywordsReq) -> dict[str, Any]:
    cleaned = [k.strip() for k in req.keywords if k and k.strip()]
    raw, cfg_path, _ = load_raw_config()
    idx_raw = dict(raw.get("indexing") or {})
    idx_raw["exclude_keywords"] = cleaned
    raw["indexing"] = idx_raw
    save_raw_config(cfg_path, raw)
    _reload_runtime_config()
    _trigger_pipeline_async(force=False)
    return {"ok": True, "exclude_keywords": cleaned}


@app.post("/api/settings/onboarding-complete")
def api_onboarding_complete(req: OnboardingCompleteReq) -> dict[str, Any]:
    raw, cfg_path, _ = load_raw_config()
    raw["onboarding_completed"] = bool(req.completed)
    save_raw_config(cfg_path, raw)
    _reload_runtime_config()
    return {"ok": True, "onboarding_completed": cfg.onboarding_completed}


_FRONTEND_ENV = os.environ.get("KB_CONSOLE_FRONTEND_DIR", "").strip()
FRONTEND_DIST = Path(_FRONTEND_ENV) if _FRONTEND_ENV else (PROJECT_ROOT / "frontend" / "dist")
if (FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")


@app.get("/{full_path:path}")
def serve_spa(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="API endpoint not found")
    index_html = FRONTEND_DIST / "index.html"
    if index_html.exists():
        candidate = (FRONTEND_DIST / full_path).resolve()
        try:
            candidate.relative_to(FRONTEND_DIST.resolve())
            if candidate.is_file():
                return FileResponse(str(candidate))
        except ValueError:
            pass
        return FileResponse(str(index_html))
    return {
        "message": "kb-console backend is running.",
        "api_docs": "/docs",
    }

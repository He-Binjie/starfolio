from __future__ import annotations

import gc
import math
import re
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from typing import Any

import numpy as np

from .config import AppConfig
from .db import connect_db

_BGE_ZH_QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


class VectorService:
    """Local ONNX semantic embedding engine + SQLite BLOB vector store + fast NumPy cosine search.

    Design goals:
    - 100% local: document text never leaves this machine during indexing or query embedding.
    - Deduplicated by content_hash: unchanged chunks are never re-embedded across edits.
    - Memory-friendly: ONNX model loads lazily on demand and auto-unloads after idle_unload_seconds.
    - Exact cosine search over float16 normalized vectors (~26MB RAM for 26k x 512d, <5ms on M5).
    """

    def __init__(self, cfg: AppConfig) -> None:
        self.cfg = cfg
        self._model = None
        self._model_lock = threading.Lock()
        self._sync_lock = threading.Lock()
        self._matrix_lock = threading.Lock()
        self._last_used_at: float = 0.0
        self._sync_running = False

        # Cached vector matrix for fast semantic search
        self._matrix_version: int = 0
        self._chunk_ids: np.ndarray | None = None
        self._doc_ids: np.ndarray | None = None
        self._vectors: np.ndarray | None = None  # shape (N, dim), float16 normalized

        self._progress: dict[str, Any] = {
            "running": False,
            "done_in_run": 0,
            "total_in_run": 0,
            "chunks_per_sec": 0.0,
            "last_finished_at": None,
            "last_error": "",
        }

    @property
    def model_name(self) -> str:
        return self.cfg.embedding.model_name

    def _get_model(self):
        with self._model_lock:
            self._last_used_at = time.time()
            if self._model is None:
                import os
                from fastembed import TextEmbedding

                os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
                try:
                    self._model = TextEmbedding(
                        model_name=self.cfg.embedding.model_name,
                        cache_dir=str(self.cfg.embedding.cache_dir),
                        threads=self.cfg.embedding.threads,
                        local_files_only=True,
                    )
                except Exception:
                    self._model = TextEmbedding(
                        model_name=self.cfg.embedding.model_name,
                        cache_dir=str(self.cfg.embedding.cache_dir),
                        threads=self.cfg.embedding.threads,
                    )
            return self._model

    def maybe_unload_if_idle(self) -> bool:
        """Unload ONNX embedding session if idle longer than configured threshold."""
        if self._sync_running:
            return False
        timeout = self.cfg.embedding.idle_unload_seconds
        if timeout <= 0:
            return False
        with self._model_lock:
            if self._model is not None and (time.time() - self._last_used_at) >= timeout:
                self._model = None
                gc.collect()
                return True
        return False

    def invalidate_matrix_cache(self) -> None:
        with self._matrix_lock:
            self._chunk_ids = None
            self._doc_ids = None
            self._vectors = None

    def _ensure_matrix(self) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
        with self._matrix_lock:
            if self._vectors is not None and self._chunk_ids is not None and self._doc_ids is not None:
                return self._chunk_ids, self._doc_ids, self._vectors

            conn = connect_db(self.cfg.db_path)
            try:
                rows = conn.execute(
                    """
                    SELECT c.id AS chunk_id, c.doc_id, v.dim, v.vec
                    FROM chunks c
                    JOIN chunk_vectors v
                      ON v.content_hash = c.content_hash AND v.model_name = ?
                    """,
                    (self.model_name,),
                ).fetchall()
            finally:
                conn.close()

            if not rows:
                return None

            dim = int(rows[0]["dim"])
            n = len(rows)
            cids = np.empty(n, dtype=np.int64)
            dids = np.empty(n, dtype=np.int64)
            mat = np.empty((n, dim), dtype=np.float16)

            valid = 0
            for r in rows:
                arr = np.frombuffer(r["vec"], dtype=np.float16)
                if arr.shape[0] != dim:
                    continue
                cids[valid] = r["chunk_id"]
                dids[valid] = r["doc_id"]
                mat[valid] = arr
                valid += 1

            if valid == 0:
                return None
            self._chunk_ids = cids[:valid]
            self._doc_ids = dids[:valid]
            self._vectors = mat[:valid]
            self._matrix_version += 1
            return self._chunk_ids, self._doc_ids, self._vectors

    def status(self) -> dict[str, Any]:
        conn = connect_db(self.cfg.db_path)
        try:
            total_chunks = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
            embedded_chunks = conn.execute(
                """
                SELECT COUNT(*)
                FROM chunks c
                JOIN chunk_vectors v
                  ON v.content_hash = c.content_hash AND v.model_name = ?
                """,
                (self.model_name,),
            ).fetchone()[0]
            unique_vectors = conn.execute(
                "SELECT COUNT(*) FROM chunk_vectors WHERE model_name = ?",
                (self.model_name,),
            ).fetchone()[0]
        finally:
            conn.close()

        pct = round((embedded_chunks / total_chunks) * 100.0, 1) if total_chunks > 0 else 100.0
        return {
            "enabled": self.cfg.embedding.enabled,
            "model_name": self.model_name,
            "model_loaded": self._model is not None,
            "idle_unload_seconds": self.cfg.embedding.idle_unload_seconds,
            "total_chunks": total_chunks,
            "embedded_chunks": embedded_chunks,
            "unique_vectors": unique_vectors,
            "coverage_pct": pct,
            "progress": dict(self._progress),
        }

    def trigger_sync_async(self) -> bool:
        if not self.cfg.embedding.enabled or self._sync_running:
            return False
        t = threading.Thread(target=self.sync_missing_vectors, daemon=True)
        t.start()
        return True

    def sync_missing_vectors(self, max_batches: int | None = None) -> dict[str, Any]:
        if not self.cfg.embedding.enabled:
            return {"status": "disabled"}
        if not self._sync_lock.acquire(blocking=False):
            return {"status": "already_running"}

        self._sync_running = True
        self._progress.update(
            {
                "running": True,
                "done_in_run": 0,
                "total_in_run": 0,
                "chunks_per_sec": 0.0,
                "last_error": "",
            }
        )

        conn = connect_db(self.cfg.db_path)
        try:
            # Find distinct content_hashes that do not yet have vectors for this model
            missing = conn.execute(
                """
                SELECT c.content_hash,
                       MIN(d.title) AS title,
                       MIN(c.heading_path) AS heading_path,
                       MIN(c.content) AS content
                FROM chunks c
                JOIN documents d ON d.id = c.doc_id
                LEFT JOIN chunk_vectors v
                  ON v.content_hash = c.content_hash AND v.model_name = ?
                WHERE v.content_hash IS NULL
                GROUP BY c.content_hash
                """,
                (self.model_name,),
            ).fetchall()

            total = len(missing)
            self._progress["total_in_run"] = total
            if total == 0:
                self._progress["last_finished_at"] = _now_iso()
                return {"status": "ok", "embedded": 0, "total_missing": 0}

            model = self._get_model()
            bs = max(8, self.cfg.embedding.batch_size)
            max_chars = self.cfg.embedding.max_text_chars
            done = 0
            t0 = time.time()
            batches_done = 0

            for start in range(0, total, bs):
                if max_batches is not None and batches_done >= max_batches:
                    break
                batch = missing[start : start + bs]
                texts: list[str] = []
                for row in batch:
                    prefix = row["title"] or ""
                    if row["heading_path"]:
                        prefix = f"{prefix} / {row['heading_path']}" if prefix else row["heading_path"]
                    body = (row["content"] or "")[:max_chars]
                    texts.append(f"{prefix}\n{body}" if prefix else body)

                vecs = list(model.embed(texts, batch_size=bs))
                now = _now_iso()
                inserts = []
                for row, vec in zip(batch, vecs):
                    arr = np.asarray(vec, dtype=np.float32)
                    norm = float(np.linalg.norm(arr))
                    if norm > 0:
                        arr = arr / norm
                    arr16 = arr.astype(np.float16)
                    inserts.append((row["content_hash"], self.model_name, int(arr16.shape[0]), arr16.tobytes(), now))

                conn.executemany(
                    """
                    INSERT OR REPLACE INTO chunk_vectors (content_hash, model_name, dim, vec, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    inserts,
                )
                conn.commit()

                done += len(batch)
                batches_done += 1
                elapsed = max(0.01, time.time() - t0)
                self._last_used_at = time.time()
                self._progress["done_in_run"] = done
                self._progress["chunks_per_sec"] = round(done / elapsed, 1)

                # Refresh search matrix every ~320 newly embedded chunks so UI gets progressive semantic hits
                if batches_done % 10 == 0:
                    self.invalidate_matrix_cache()

            self.invalidate_matrix_cache()
            # Clean up orphan vectors no longer referenced by any chunk
            conn.execute(
                """
                DELETE FROM chunk_vectors
                WHERE model_name = ?
                  AND content_hash NOT IN (SELECT DISTINCT content_hash FROM chunks)
                """,
                (self.model_name,),
            )
            conn.commit()
            self._progress["last_finished_at"] = _now_iso()
            return {"status": "ok", "embedded": done, "total_missing": total}
        except Exception as exc:
            err = str(exc)
            self._progress["last_error"] = err
            return {"status": "error", "error": err}
        finally:
            conn.close()
            self._sync_running = False
            self._progress["running"] = False
            self._lock_touch()
            self._sync_lock.release()

    def _lock_touch(self) -> None:
        with self._model_lock:
            self._last_used_at = time.time()

    def search_semantic(
        self,
        query: str,
        allowed_doc_ids: set[int] | None = None,
        top_k: int = 80,
    ) -> list[tuple[int, float]]:
        if not self.cfg.embedding.enabled or not query.strip():
            return []
        loaded = self._ensure_matrix()
        if loaded is None:
            return []

        cids, dids, mat16 = loaded
        model = self._get_model()
        q_text = query.strip()
        if "bge-" in self.model_name.lower() and "zh" in self.model_name.lower():
            q_text = _BGE_ZH_QUERY_PREFIX + q_text
        q_vec = np.asarray(next(iter(model.embed([q_text]))), dtype=np.float32)
        q_norm = float(np.linalg.norm(q_vec))
        if q_norm > 0:
            q_vec = q_vec / q_norm

        if allowed_doc_ids is not None:
            if not allowed_doc_ids:
                return []
            mask = np.isin(dids, np.fromiter(allowed_doc_ids, dtype=np.int64))
            if not np.any(mask):
                return []
            sub_cids = cids[mask]
            sub_mat = mat16[mask].astype(np.float32)
        else:
            sub_cids = cids
            sub_mat = mat16.astype(np.float32)

        scores = sub_mat @ q_vec
        k = min(top_k, scores.shape[0])
        if k <= 0:
            return []
        if k < scores.shape[0]:
            top_idx = np.argpartition(-scores, k - 1)[:k]
            top_idx = top_idx[np.argsort(-scores[top_idx])]
        else:
            top_idx = np.argsort(-scores)

        return [(int(sub_cids[i]), float(scores[i])) for i in top_idx if scores[i] > 0.25]

    def find_related_documents(
        self,
        doc_id: int,
        limit: int = 6,
        min_score: float = 0.48,
    ) -> list[dict[str, Any]]:
        """Zero-token local semantic neighbor discovery ('星海连脉') over cached float16 vectors."""
        if not self.cfg.embedding.enabled:
            return []
        loaded = self._ensure_matrix()
        if loaded is None:
            return []

        cids, dids, mat16 = loaded
        self_mask = dids == doc_id
        if not np.any(self_mask):
            return []

        # Mean normalized document vector from up to 24 representative chunks
        self_vecs = mat16[self_mask][:24].astype(np.float32)
        doc_vec = np.mean(self_vecs, axis=0)
        norm = float(np.linalg.norm(doc_vec))
        if norm <= 0:
            return []
        doc_vec = doc_vec / norm

        other_mask = ~self_mask
        if not np.any(other_mask):
            return []

        other_cids = cids[other_mask]
        other_dids = dids[other_mask]
        scores = mat16[other_mask].astype(np.float32) @ doc_vec

        # Pre-select top 240 chunks across all other documents for fast aggregation
        k = min(240, scores.shape[0])
        if k <= 0:
            return []
        if k < scores.shape[0]:
            top_idx = np.argpartition(-scores, k - 1)[:k]
        else:
            top_idx = np.arange(scores.shape[0])

        best_by_doc: dict[int, tuple[float, int]] = {}
        for idx in top_idx:
            sc = float(scores[idx])
            if sc < min_score:
                continue
            odid = int(other_dids[idx])
            ocid = int(other_cids[idx])
            prev = best_by_doc.get(odid)
            if prev is None or sc > prev[0]:
                best_by_doc[odid] = (sc, ocid)

        if not best_by_doc:
            return []

        cand_dids = list(best_by_doc.keys())
        cand_cids = [v[1] for v in best_by_doc.values()]
        conn = connect_db(self.cfg.db_path)
        try:
            dp = ",".join("?" for _ in cand_dids)
            doc_rows = {
                int(r["id"]): dict(r)
                for r in conn.execute(
                    f"""
                    SELECT id, source_id, rel_path, project, title, ext, mtime, git_date
                    FROM documents WHERE id IN ({dp})
                    """,
                    cand_dids,
                ).fetchall()
            }
            cp = ",".join("?" for _ in cand_cids)
            chunk_rows = {
                int(r["id"]): dict(r)
                for r in conn.execute(
                    f"""
                    SELECT id, heading_path, start_line, end_line, page_num
                    FROM chunks WHERE id IN ({cp})
                    """,
                    cand_cids,
                ).fetchall()
            }
        finally:
            conn.close()

        noise_re = ("changelog.md", "INDEX.md", "daily-work-digest", "ASSETS.md")
        hist_re = ("快照", "归档", "_archive", "旧版", "backup", "去版本号前")

        ranked: list[tuple[float, dict[str, Any]]] = []
        for odid, (sc, ocid) in best_by_doc.items():
            d = doc_rows.get(odid)
            if not d:
                continue
            rel = d["rel_path"]
            if any(n in rel for n in noise_re):
                continue
            ch = chunk_rows.get(ocid, {})
            is_hist = any(h in rel for h in hist_re)
            sort_score = sc * (0.86 if is_hist else 1.0)
            ranked.append(
                (
                    sort_score,
                    {
                        "source_id": d["source_id"],
                        "rel_path": rel,
                        "project": d["project"],
                        "title": d["title"],
                        "ext": d["ext"],
                        "mtime": d["mtime"],
                        "git_date": d["git_date"],
                        "similarity": round(sc, 4),
                        "is_historical": is_hist,
                        "best_heading": ch.get("heading_path", ""),
                        "best_start_line": ch.get("start_line", 1),
                        "best_end_line": ch.get("end_line", 1),
                        "best_page_num": ch.get("page_num"),
                    },
                )
            )

        ranked.sort(key=lambda x: x[0], reverse=True)
        return [item for _, item in ranked[:limit]]

    def cluster_documents(
        self,
        source_id: str | None = None,
        max_clusters: int = 10,
    ) -> dict[str, Any]:
        """0-Token local spherical k-means semantic topic clustering ('星海聚类') over document embeddings."""
        if not self.cfg.embedding.enabled:
            return {"total_docs": 0, "clusters": []}
        loaded = self._ensure_matrix()
        if loaded is None:
            return {"total_docs": 0, "clusters": []}

        _, dids, mat16 = loaded
        conn = connect_db(self.cfg.db_path)
        try:
            if source_id and source_id != "all":
                rows = conn.execute(
                    """
                    SELECT id, source_id, rel_path, project, title, ext, mtime, git_date
                    FROM documents
                    WHERE source_id = ?
                    ORDER BY mtime DESC
                    """,
                    (source_id,),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT id, source_id, rel_path, project, title, ext, mtime, git_date
                    FROM documents
                    ORDER BY mtime DESC
                    """
                ).fetchall()
        finally:
            conn.close()

        noise_markers = ("changelog.md", "INDEX.md", "daily-work-digest", "ASSETS.md", "_archive", "快照", "备份")
        eligible_docs: list[dict[str, Any]] = []
        for r in rows:
            rel = r["rel_path"]
            if any(m in rel for m in noise_markers):
                continue
            eligible_docs.append(dict(r))
            if len(eligible_docs) >= 600:
                break

        if not eligible_docs:
            return {"total_docs": 0, "clusters": []}

        # Group chunk row indices by doc_id in O(M)
        eligible_ids = {int(d["id"]) for d in eligible_docs}
        doc_chunk_indices: dict[int, list[int]] = {}
        for idx, d_val in enumerate(dids.tolist()):
            if d_val in eligible_ids:
                lst = doc_chunk_indices.setdefault(d_val, [])
                if len(lst) < 16:
                    lst.append(idx)

        valid_docs: list[dict[str, Any]] = []
        doc_vecs: list[np.ndarray] = []
        for d in eligible_docs:
            idxs = doc_chunk_indices.get(int(d["id"]))
            if not idxs:
                continue
            mean_v = np.mean(mat16[idxs].astype(np.float32), axis=0)
            norm = float(np.linalg.norm(mean_v))
            if norm > 0:
                mean_v = mean_v / norm
                valid_docs.append(d)
                doc_vecs.append(mean_v)

        n = len(valid_docs)
        if n == 0:
            return {"total_docs": 0, "clusters": []}

        X = np.vstack(doc_vecs).astype(np.float32)  # (N, D), L2 normalized

        # Choose sensible cluster count K based on document count
        if n <= 3:
            k = 1
        elif n <= 8:
            k = 2
        else:
            k = max(3, min(max_clusters, int(round(math.sqrt(n / 2.2)))))
            k = min(k, n)

        if k == 1:
            labels = np.zeros(n, dtype=np.int32)
            centroids = np.mean(X, axis=0, keepdims=True)
            cn = np.linalg.norm(centroids, axis=1, keepdims=True)
            centroids = np.where(cn > 0, centroids / cn, centroids)
        else:
            # Deterministic farthest-first (k-means++ deterministic) initialization
            centroids = np.empty((k, X.shape[1]), dtype=np.float32)
            centroids[0] = X[0]
            min_dist = 1.0 - (X @ centroids[0])
            for c_idx in range(1, k):
                next_i = int(np.argmax(min_dist))
                centroids[c_idx] = X[next_i]
                d_new = 1.0 - (X @ centroids[c_idx])
                min_dist = np.minimum(min_dist, d_new)

            labels = np.zeros(n, dtype=np.int32)
            for _ in range(14):
                sims = X @ centroids.T
                new_labels = np.argmax(sims, axis=1).astype(np.int32)
                if np.array_equal(new_labels, labels):
                    break
                labels = new_labels
                for c_idx in range(k):
                    mask = labels == c_idx
                    if np.any(mask):
                        cvec = np.mean(X[mask], axis=0)
                        cn = float(np.linalg.norm(cvec))
                        if cn > 0:
                            centroids[c_idx] = cvec / cn

        # Extract natural delimiter-split phrases (NEVER slice mid-Chinese-word like '意放过你'!)
        stop_words = {
            "项目", "文档", "说明", "版本", "记录", "方案", "分析", "总结", "计划", "清单",
            "会议", "纪要", "复盘", "需求", "产品", "系统", "管理", "报告", "数据", "工作",
            "示例", "测试", "新建", "附件", "资料", "文件", "关于", "以及", "如何", "使用",
            "完整", "整理", "内容", "讨论", "沟通", "进展", "同步", "汇总", "目录", "首页",
            "v1", "v2", "v3", "md", "pdf", "docx", "pptx", "xlsx", "2025", "2026", "2024",
            "projects", "meetings", "decisions", "references", "modules", "drafts", "published",
        }
        split_re = re.compile(r"[\s:：—\-·•｜|/\\（）()【】\[\]《》「」『』,，。；;、_!?！？]+")
        date_or_num_re = re.compile(r"^(?:20\d{2}|\d+|v\d+(?:\.\d+)*)$", re.IGNORECASE)
        src_name_map = {s.id: s.name for s in self.cfg.sources}

        # Load friendly project labels from each source's root INDEX.md when available
        from .tree import _parse_index_labels

        proj_labels: dict[tuple[str, str], str] = {}
        for s in self.cfg.sources:
            idx_p = s.path / "INDEX.md"
            if idx_p.exists():
                for k_dir, lbl in _parse_index_labels(idx_p).items():
                    proj_labels[(s.id, k_dir)] = lbl

        def extract_clean_phrases(d: dict[str, Any]) -> set[str]:
            terms: set[str] = set()
            proj = d["project"]
            if proj and proj != "(根目录)":
                friendly = proj_labels.get((d["source_id"], proj), proj)
                if friendly.lower() not in stop_words and 2 <= len(friendly) <= 14:
                    terms.add(friendly)
            title = d["title"] or ""
            for seg in split_re.split(title):
                seg = seg.strip()
                if not seg or date_or_num_re.match(seg):
                    continue
                if seg.lower() in stop_words:
                    continue
                if 2 <= len(seg) <= 12:
                    terms.add(seg)
            return terms

        # Global document frequency across all valid docs for TF-IDF weighting
        global_df: Counter[str] = Counter()
        doc_terms: list[set[str]] = []
        for d in valid_docs:
            terms = extract_clean_phrases(d)
            doc_terms.append(terms)
            for t in terms:
                global_df[t] += 1

        clusters_out: list[dict[str, Any]] = []
        for c_idx in range(k):
            member_indices = [i for i in range(n) if labels[i] == c_idx]
            if not member_indices:
                continue

            cvec = centroids[c_idx]
            scored_members: list[tuple[float, int]] = [
                (float(X[i] @ cvec), i) for i in member_indices
            ]
            scored_members.sort(key=lambda x: x[0], reverse=True)

            # TF-IDF cluster keyword extraction over complete natural phrases
            local_tf: Counter[str] = Counter()
            for _, i in scored_members:
                for t in doc_terms[i]:
                    local_tf[t] += 1

            ranked_kw: list[tuple[float, str]] = []
            for term, tf in local_tf.items():
                # Ignore 1-off overly specific phrases when cluster has >= 4 docs
                if len(scored_members) >= 4 and tf < 2:
                    continue
                idf = math.log((n + 1.0) / (global_df[term] + 1.0)) + 1.0
                ranked_kw.append((tf * idf, term))
            ranked_kw.sort(key=lambda x: x[0], reverse=True)
            top_keywords = [kw for _, kw in ranked_kw[:5]]

            # Build readable cluster name from dominant project + complete phrase or medoid doc title
            medoid_doc = valid_docs[scored_members[0][1]]
            proj_counter: Counter[str] = Counter()
            for _, i in scored_members:
                d_i = valid_docs[i]
                if d_i["project"] and d_i["project"] != "(根目录)":
                    lbl = proj_labels.get((d_i["source_id"], d_i["project"]), d_i["project"])
                    if lbl.lower() not in stop_words:
                        proj_counter[lbl] += 1

            dominant_proj = ""
            if proj_counter:
                top_p, top_cnt = proj_counter.most_common(1)[0]
                if top_cnt >= max(2, len(scored_members) * 0.45):
                    dominant_proj = top_p

            if dominant_proj and top_keywords:
                second = next((kw for kw in top_keywords if kw != dominant_proj and kw not in dominant_proj and dominant_proj not in kw), "")
                cluster_title = f"{dominant_proj} · {second}" if second else dominant_proj
            elif len(top_keywords) >= 2:
                cluster_title = f"{top_keywords[0]} · {top_keywords[1]}"
            elif len(top_keywords) == 1:
                cluster_title = top_keywords[0]
            else:
                raw_med = (medoid_doc["title"] or Path(medoid_doc["rel_path"]).stem).strip()
                cluster_title = raw_med if len(raw_med) <= 16 else raw_med[:15] + "…"

            ext_counts: Counter[str] = Counter()
            members_payload: list[dict[str, Any]] = []
            for sim, i in scored_members:
                d = valid_docs[i]
                ext_counts[d["ext"]] += 1
                members_payload.append(
                    {
                        "source_id": d["source_id"],
                        "source_name": src_name_map.get(d["source_id"], d["source_id"]),
                        "rel_path": d["rel_path"],
                        "project": d["project"],
                        "title": d["title"],
                        "ext": d["ext"],
                        "mtime": d["mtime"],
                        "git_date": d["git_date"],
                        "centrality": round(sim, 3),
                    }
                )

            cohesion = round(sum(s for s, _ in scored_members) / len(scored_members), 3)
            clusters_out.append(
                {
                    "id": f"cluster-{c_idx + 1}",
                    "title": cluster_title,
                    "keywords": top_keywords,
                    "doc_count": len(members_payload),
                    "cohesion": cohesion,
                    "ext_counts": dict(ext_counts.most_common(5)),
                    "last_mtime": max(m["mtime"] for m in members_payload),
                    "docs": members_payload[:80],
                }
            )

        clusters_out.sort(key=lambda x: (x["doc_count"], x["cohesion"]), reverse=True)
        return {"total_docs": n, "clusters": clusters_out}

    def build_star_map(
        self,
        source_id: str | None = None,
        max_docs: int = 240,
        max_clusters: int = 8,
    ) -> dict[str, Any]:
        """0-Token deterministic 2D PCA Star Map ('星海星图') with constellation edges."""
        cl_res = self.cluster_documents(source_id=source_id, max_clusters=max_clusters)
        clusters = cl_res.get("clusters") or []
        if not clusters:
            return {"total_docs": 0, "clusters": [], "nodes": [], "edges": []}

        loaded = self._ensure_matrix()
        if loaded is None:
            return {"total_docs": 0, "clusters": [], "nodes": [], "edges": []}
        _, dids, mat16 = loaded

        # Collect top representative docs across clusters up to max_docs
        per_cap = max(8, max_docs // max(1, len(clusters)))
        selected_items: list[tuple[str, int, dict[str, Any]]] = []
        seen_keys: set[tuple[str, str]] = set()
        for c_idx, c in enumerate(clusters):
            for d in c["docs"][:per_cap]:
                key = (d["source_id"], d["rel_path"])
                if key not in seen_keys:
                    seen_keys.add(key)
                    selected_items.append((c["id"], c_idx, d))
                if len(selected_items) >= max_docs:
                    break

        conn = connect_db(self.cfg.db_path)
        try:
            id_map: dict[tuple[str, str], int] = {}
            for r in conn.execute("SELECT id, source_id, rel_path FROM documents").fetchall():
                id_map[(r["source_id"], r["rel_path"])] = int(r["id"])
        finally:
            conn.close()

        # Map doc_id -> chunk indices
        target_ids = {id_map[(d["source_id"], d["rel_path"])] for _, _, d in selected_items if (d["source_id"], d["rel_path"]) in id_map}
        chunk_idx_map: dict[int, list[int]] = {}
        for idx, dv in enumerate(dids.tolist()):
            if dv in target_ids:
                lst = chunk_idx_map.setdefault(dv, [])
                if len(lst) < 12:
                    lst.append(idx)

        vecs: list[np.ndarray] = []
        kept: list[tuple[str, int, dict[str, Any]]] = []
        for cid_str, c_idx, d in selected_items:
            did = id_map.get((d["source_id"], d["rel_path"]))
            idxs = chunk_idx_map.get(did or -1)
            if not idxs:
                continue
            mv = np.mean(mat16[idxs].astype(np.float32), axis=0)
            nm = float(np.linalg.norm(mv))
            if nm > 0:
                vecs.append(mv / nm)
                kept.append((cid_str, c_idx, d))

        n = len(kept)
        if n == 0:
            return {"total_docs": 0, "clusters": [], "nodes": [], "edges": []}

        X = np.vstack(vecs).astype(np.float32)
        if n == 1:
            coords = np.array([[0.5, 0.5]], dtype=np.float32)
        elif n == 2:
            coords = np.array([[0.32, 0.5], [0.68, 0.5]], dtype=np.float32)
        else:
            Xc = X - np.mean(X, axis=0, keepdims=True)
            _, _, vt = np.linalg.svd(Xc, full_matrices=False)
            proj = Xc @ vt[:2].T  # (N, 2)
            # Normalize cleanly into [0.08, 0.92]
            mins = np.min(proj, axis=0)
            maxs = np.max(proj, axis=0)
            spans = np.where((maxs - mins) > 1e-6, maxs - mins, 1.0)
            coords = 0.08 + 0.84 * ((proj - mins) / spans)

            # Gentle deterministic overlap separation (3 passes)
            for _ in range(3):
                for i in range(n):
                    for j in range(i + 1, n):
                        dx = coords[j, 0] - coords[i, 0]
                        dy = coords[j, 1] - coords[i, 1]
                        dist = math.hypot(float(dx), float(dy))
                        if dist < 0.022:
                            ang = ((i * 37 + j * 17) % 360) * math.pi / 180.0
                            push = (0.022 - dist) * 0.45
                            px = math.cos(ang) * push if dist < 1e-4 else (dx / dist) * push
                            py = math.sin(ang) * push if dist < 1e-4 else (dy / dist) * push
                            coords[i, 0] = min(0.94, max(0.06, coords[i, 0] - px))
                            coords[i, 1] = min(0.94, max(0.06, coords[i, 1] - py))
                            coords[j, 0] = min(0.94, max(0.06, coords[j, 0] + px))
                            coords[j, 1] = min(0.94, max(0.06, coords[j, 1] + py))

        # Build sparse constellation edges (top 2 nearest neighbors in same cluster with sim >= 0.72)
        sim_mat = X @ X.T
        edges: list[dict[str, Any]] = []
        seen_e: set[tuple[int, int]] = set()
        for i in range(n):
            cid_i = kept[i][0]
            cands = [
                (float(sim_mat[i, j]), j)
                for j in range(n)
                if j != i and kept[j][0] == cid_i and sim_mat[i, j] >= 0.72
            ]
            cands.sort(key=lambda t: t[0], reverse=True)
            for sim, j in cands[:2]:
                ek = (min(i, j), max(i, j))
                if ek not in seen_e:
                    seen_e.add(ek)
                    edges.append({"a": i, "b": j, "sim": round(sim, 3), "cluster_id": cid_i})

        nodes_out: list[dict[str, Any]] = []
        cluster_pts: dict[str, list[tuple[float, float]]] = {}
        for i, (cid_str, c_idx, d) in enumerate(kept):
            x, y = round(float(coords[i, 0]), 4), round(float(coords[i, 1]), 4)
            cluster_pts.setdefault(cid_str, []).append((x, y))
            nodes_out.append(
                {
                    "idx": i,
                    "source_id": d["source_id"],
                    "source_name": d["source_name"],
                    "rel_path": d["rel_path"],
                    "project": d["project"],
                    "title": d["title"],
                    "ext": d["ext"],
                    "mtime": d["mtime"],
                    "centrality": d["centrality"],
                    "cluster_id": cid_str,
                    "color_idx": c_idx,
                    "x": x,
                    "y": y,
                }
            )

        clusters_meta: list[dict[str, Any]] = []
        for c_idx, c in enumerate(clusters):
            pts = cluster_pts.get(c["id"]) or []
            if not pts:
                continue
            cx = round(sum(p[0] for p in pts) / len(pts), 4)
            cy = round(sum(p[1] for p in pts) / len(pts), 4)
            clusters_meta.append(
                {
                    "id": c["id"],
                    "title": c["title"],
                    "color_idx": c_idx,
                    "doc_count": c["doc_count"],
                    "shown_count": len(pts),
                    "keywords": c["keywords"],
                    "cx": cx,
                    "cy": cy,
                    "docs": c["docs"][:6],
                }
            )

        return {
            "total_docs": n,
            "clusters": clusters_meta,
            "nodes": nodes_out,
            "edges": edges,
        }

    def find_duplicates(self, limit: int = 30) -> dict[str, Any]:
        """0-Token Duplicate & Near-Duplicate Radar across all mounted folders (strictly read-only)."""
        conn = connect_db(self.cfg.db_path)
        try:
            # 1. Exact duplicate files by content_hash
            dup_hashes = conn.execute(
                """
                SELECT content_hash, COUNT(*) AS cnt
                FROM documents
                WHERE content_hash != '' AND size_bytes > 40
                GROUP BY content_hash
                HAVING cnt > 1
                ORDER BY cnt DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

            exact_groups: list[dict[str, Any]] = []
            exact_doc_ids: set[int] = set()
            for r in dup_hashes:
                files = [
                    dict(fr)
                    for fr in conn.execute(
                        """
                        SELECT id, source_id, rel_path, project, title, ext, size_bytes, mtime
                        FROM documents
                        WHERE content_hash = ?
                        ORDER BY mtime DESC
                        """,
                        (r["content_hash"],),
                    ).fetchall()
                ]
                if len(files) >= 2:
                    for f in files:
                        exact_doc_ids.add(int(f["id"]))
                    exact_groups.append(
                        {
                            "content_hash": r["content_hash"],
                            "count": len(files),
                            "size_bytes": files[0]["size_bytes"],
                            "files": files,
                        }
                    )

            # 2. Near-duplicate pairs via normalized doc embeddings (cosine >= 0.965)
            all_docs = [
                dict(r)
                for r in conn.execute(
                    """
                    SELECT id, source_id, rel_path, project, title, ext, size_bytes, mtime, content_hash
                    FROM documents
                    WHERE size_bytes > 100
                    ORDER BY mtime DESC
                    LIMIT 600
                    """
                ).fetchall()
            ]
        finally:
            conn.close()

        near_pairs: list[dict[str, Any]] = []
        loaded = self._ensure_matrix()
        if loaded is not None and len(all_docs) >= 2:
            _, dids, mat16 = loaded
            doc_id_set = {int(d["id"]) for d in all_docs}
            c_map: dict[int, list[int]] = {}
            for idx, dv in enumerate(dids.tolist()):
                if dv in doc_id_set:
                    lst = c_map.setdefault(dv, [])
                    if len(lst) < 12:
                        lst.append(idx)

            valid_docs: list[dict[str, Any]] = []
            vecs: list[np.ndarray] = []
            for d in all_docs:
                idxs = c_map.get(int(d["id"]))
                if not idxs:
                    continue
                mv = np.mean(mat16[idxs].astype(np.float32), axis=0)
                nm = float(np.linalg.norm(mv))
                if nm > 0:
                    valid_docs.append(d)
                    vecs.append(mv / nm)

            if len(valid_docs) >= 2:
                X = np.vstack(vecs).astype(np.float32)
                sim_mat = X @ X.T
                ii, jj = np.where(np.triu(sim_mat, k=1) >= 0.965)
                cand_list: list[tuple[float, dict[str, Any], dict[str, Any]]] = []
                for a_i, b_i in zip(ii.tolist(), jj.tolist()):
                    da = valid_docs[a_i]
                    db = valid_docs[b_i]
                    if da["content_hash"] and da["content_hash"] == db["content_hash"]:
                        continue
                    cand_list.append((float(sim_mat[a_i, b_i]), da, db))
                cand_list.sort(key=lambda t: t[0], reverse=True)
                for sim, da, db in cand_list[:limit]:
                    near_pairs.append(
                        {
                            "similarity": round(sim, 4),
                            "doc_a": {
                                "source_id": da["source_id"],
                                "rel_path": da["rel_path"],
                                "title": da["title"],
                                "ext": da["ext"],
                                "size_bytes": da["size_bytes"],
                                "mtime": da["mtime"],
                            },
                            "doc_b": {
                                "source_id": db["source_id"],
                                "rel_path": db["rel_path"],
                                "title": db["title"],
                                "ext": db["ext"],
                                "size_bytes": db["size_bytes"],
                                "mtime": db["mtime"],
                            },
                        }
                    )

        return {
            "exact_count": len(exact_groups),
            "near_count": len(near_pairs),
            "exact_groups": exact_groups,
            "near_pairs": near_pairs,
        }

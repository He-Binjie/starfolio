from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import AppConfig, QaEngineConfig
from .db import connect_db
from .search import search_chunks
from .vectors import VectorService

_CITE_RE = re.compile(r"\[(\d+(?:\s*[,，]\s*\d+)*)\]")
_NUM_RE = re.compile(r"(?<![A-Za-z0-9#])(\d+(?:\.\d+)?%?(?:天|个月|周|小时|元|万|亿|%|倍)?)(?![A-Za-z0-9])")
_HOME_STR = str(Path.home())
_EXTRA_PATH = (
    os.pathsep.join([f"{_HOME_STR}\\.local\\bin", f"{_HOME_STR}\\AppData\\Roaming\\npm"])
    if sys.platform == "win32"
    else f"{_HOME_STR}/bin:{_HOME_STR}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _cli_env() -> dict[str, str]:
    env = dict(os.environ)
    cur = env.get("PATH", "")
    env["PATH"] = f"{_EXTRA_PATH}{os.pathsep}{cur}" if cur else _EXTRA_PATH
    env.setdefault("HOME", str(Path.home()))
    return env


def _resolve_provider_bin(provider: str) -> str | None:
    env = _cli_env()
    return shutil.which(provider, path=env["PATH"])


def list_qa_engines(cfg: AppConfig) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for eng in cfg.qa.engines:
        if eng.provider == "openai_api":
            available = bool(eng.api_key.strip() and eng.base_url.strip())
        else:
            available = _resolve_provider_bin(eng.provider) is not None
        out.append(
            {
                "id": eng.id,
                "label": eng.label,
                "provider": eng.provider,
                "mode": eng.mode,
                "model": eng.model,
                "note": eng.note,
                "available": available,
                "is_default": eng.id == cfg.qa.default_engine,
            }
        )
    return out


def test_openai_connection(base_url: str, api_key: str, model: str) -> dict[str, Any]:
    import httpx

    url = f"{base_url.rstrip('/')}/chat/completions"
    t0 = time.time()
    try:
        resp = httpx.post(
            url,
            headers={
                "Authorization": f"Bearer {api_key.strip()}",
                "Content-Type": "application/json",
            },
            json={
                "model": model.strip(),
                "messages": [{"role": "user", "content": "请回复 OK"}],
                "max_tokens": 12,
                "temperature": 0.0,
            },
            timeout=20.0,
        )
        ms = int((time.time() - t0) * 1000)
        if resp.status_code != 200:
            return {"ok": False, "latency_ms": ms, "error": f"HTTP {resp.status_code}: {resp.text[:220]}"}
        data = resp.json()
        reply = (data.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
        return {"ok": True, "latency_ms": ms, "reply": reply[:80], "error": ""}
    except Exception as exc:
        return {"ok": False, "latency_ms": int((time.time() - t0) * 1000), "error": str(exc)}


def _find_engine(cfg: AppConfig, engine_id: str | None) -> QaEngineConfig:
    target = engine_id or cfg.qa.default_engine
    for e in cfg.qa.engines:
        if e.id == target:
            return e
    if cfg.qa.engines:
        return cfg.qa.engines[0]
    return QaEngineConfig(
        id="agy-fast",
        label="Antigravity · 快问",
        provider="agy",
        mode="fast",
        model="gemini-4-hydrogen-low",
        timeout_seconds=90,
    )


def run_cli_prompt(
    cfg: AppConfig,
    engine: QaEngineConfig,
    prompt: str,
    readonly_dir: Path | None = None,
) -> tuple[str, str]:
    """Invoke a configured local CLI or OpenAI-compatible HTTP API strictly in read-only mode.

    Returns (response_text, error_text).
    """
    if engine.provider == "openai_api":
        if not engine.api_key.strip() or not engine.base_url.strip():
            return "", "请先在右上角「设置」中填入模型 API Key 与 Base URL（支持 DeepSeek / 通义千问 / OpenAI 等兼容接口）。"
        try:
            import httpx

            url = f"{engine.base_url.rstrip('/')}/chat/completions"
            resp = httpx.post(
                url,
                headers={
                    "Authorization": f"Bearer {engine.api_key.strip()}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": engine.model.strip() or "deepseek-chat",
                    "messages": [
                        {
                            "role": "system",
                            "content": "你是严格遵守出处核对规则的本地知识库助手，只基于用户提供的证据片段回答问题，绝不编造。",
                        },
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.2,
                },
                timeout=float(engine.timeout_seconds),
            )
            if resp.status_code != 200:
                return "", f"API 返回 HTTP {resp.status_code}：{resp.text[:240]}"
            data = resp.json()
            text = (data.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
            if text:
                return text, ""
            return "", "模型接口返回空内容"
        except Exception as exc:
            return "", f"调用模型 API 失败：{exc}"

    binary = _resolve_provider_bin(engine.provider)
    if not binary:
        return "", f"未找到本机 CLI `{engine.provider}`，请确认已安装并在 PATH 中。"

    env = _cli_env()
    work_dir = Path(tempfile.gettempdir()) / "starfolio-qa-cwd"
    work_dir.mkdir(parents=True, exist_ok=True)
    sub_flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

    if engine.provider == "agy":
        cmd = [
            binary,
            "--output-format",
            "json",
            "--print-timeout",
            f"{engine.timeout_seconds}s",
        ]
        if engine.model:
            cmd.extend(["--model", engine.model])
        if engine.mode == "fast":
            cmd.append("--disable-slash-commands")
        else:
            cmd.append("--sandbox")
            if readonly_dir and readonly_dir.exists():
                cmd.extend(["--add-dir", str(readonly_dir.resolve())])
        cmd.extend(["-p", prompt])

        try:
            proc = subprocess.run(
                cmd,
                cwd=str(work_dir),
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=engine.timeout_seconds + 15,
                check=False,
                creationflags=sub_flags,
            )
        except subprocess.TimeoutExpired:
            return "", f"{engine.label} 响应超时（>{engine.timeout_seconds}s）"
        except Exception as exc:
            return "", f"调用 {engine.provider} 失败：{exc}"

        raw = proc.stdout.strip()
        if raw:
            # Find JSON payload (ignore any preceding banner lines)
            json_line = raw
            if not json_line.startswith("{"):
                idx = raw.find("{")
                if idx != -1:
                    json_line = raw[idx:]
            try:
                data = json.loads(json_line)
                resp = (data.get("response") or "").strip()
                if resp:
                    return resp, ""
                denied = data.get("denied_actions") or []
                if denied:
                    return "", f"只读模式拦截了工具操作：{denied[:2]}"
                if data.get("error"):
                    return "", str(data["error"])
            except Exception:
                return raw, ""
        return "", (proc.stderr.strip() or f"{engine.provider} 退出码 {proc.returncode}，无输出")

    if engine.provider == "codex":
        with tempfile.NamedTemporaryFile(prefix="kb_codex_", suffix=".txt", delete=False) as tf:
            out_path = Path(tf.name)
        try:
            cmd = [
                binary,
                "exec",
                "-s",
                "read-only",
                "--ephemeral",
                "--skip-git-repo-check",
                "-C",
                str(readonly_dir.resolve() if (engine.mode == "deep" and readonly_dir and readonly_dir.exists()) else work_dir),
                "-o",
                str(out_path),
            ]
            if engine.model:
                cmd.extend(["-m", engine.model])
            cmd.append("-")
            proc = subprocess.run(
                cmd,
                input=prompt,
                cwd=str(work_dir),
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=engine.timeout_seconds + 15,
                check=False,
                creationflags=sub_flags,
            )
            txt = out_path.read_text(encoding="utf-8", errors="replace").strip() if out_path.exists() else ""
            if txt:
                return txt, ""
            if proc.stdout.strip():
                return proc.stdout.strip(), ""
            return "", proc.stderr.strip() or f"codex exec 退出码 {proc.returncode}"
        except subprocess.TimeoutExpired:
            return "", f"Codex 响应超时（>{engine.timeout_seconds}s）"
        except Exception as exc:
            return "", f"调用 codex 失败：{exc}"
        finally:
            try:
                out_path.unlink(missing_ok=True)
            except Exception:
                pass

    if engine.provider == "claude":
        cmd = [
            binary,
            "-p",
            "--no-session-persistence",
            "--output-format",
            "text",
        ]
        if engine.mode == "fast":
            cmd.extend(["--tools", ""])
        else:
            cmd.extend(["--restricted", "--tools", "Read,Grep,Glob"])
            if readonly_dir and readonly_dir.exists():
                cmd.extend(["--add-dir", str(readonly_dir.resolve())])
        if engine.model:
            cmd.extend(["--model", engine.model])
        try:
            proc = subprocess.run(
                cmd,
                input=prompt,
                cwd=str(work_dir),
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=engine.timeout_seconds + 15,
                check=False,
                creationflags=sub_flags,
            )
        except subprocess.TimeoutExpired:
            return "", f"Claude Code 响应超时（>{engine.timeout_seconds}s）"
        except Exception as exc:
            return "", f"调用 claude 失败：{exc}"

        # Filter LMU wrapper banner lines starting with "→ "
        lines = [ln for ln in proc.stdout.splitlines() if not ln.startswith("→ ")]
        resp = "\n".join(lines).strip()
        if resp:
            return resp, ""
        return "", proc.stderr.strip() or f"claude -p 退出码 {proc.returncode}"

    return "", f"不支持的引擎类型：{engine.provider}"


def _extract_cite_nums(text: str) -> list[int]:
    nums: list[int] = []
    for m in _CITE_RE.finditer(text):
        for part in re.split(r"[,，]", m.group(1)):
            part = part.strip()
            if part.isdigit():
                nums.append(int(part))
    return nums


def audit_answer_citations(answer: str, evidence: list[dict[str, Any]]) -> dict[str, Any]:
    """Deterministically verify [n] citations, flag uncited claims, and spot ungrounded numbers."""
    max_ref = len(evidence)
    cited_refs: set[int] = set()
    invalid_refs: set[int] = set()
    uncited_lines: list[str] = []
    number_warnings: list[dict[str, Any]] = []

    substantive_lines = 0
    cited_lines = 0

    for raw_line in answer.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        # Skip markdown headings, bold-only subheadings, code fences, horizontal rules, short lines, or explicit refusals
        plain = re.sub(r"^[-*\d.\s]+", "", line).strip()
        is_subheading = (
            (plain.startswith("**") and (plain.endswith("**") or plain.endswith("**：") or plain.endswith("**:")))
            or plain.endswith("：")
            or plain.endswith(":")
        )
        if (
            line.startswith("#")
            or line.startswith("```")
            or line.startswith("---")
            or is_subheading
            or len(plain) < 16
            or "未找到" in line
            or "没有相关" in line
            or "证据不足" in line
        ):
            continue

        substantive_lines += 1
        nums = _extract_cite_nums(line)
        valid_here = [n for n in nums if 1 <= n <= max_ref]
        for n in nums:
            if 1 <= n <= max_ref:
                cited_refs.add(n)
            else:
                invalid_refs.add(n)

        if valid_here:
            cited_lines += 1
            # Check significant numbers (2+ digits or decimal/percentage/unit) against cited evidence text
            joined_ev = "\n".join(evidence[n - 1]["content"] for n in valid_here)
            # Strip citation markers before extracting numbers
            clean_line = _CITE_RE.sub("", line)
            for nm in _NUM_RE.finditer(clean_line):
                token = nm.group(1)
                digits_only = re.sub(r"[^0-9.]", "", token)
                # Skip simple list ordinals like "1" "2" "3"
                if len(digits_only) <= 1 and "%" not in token:
                    continue
                if digits_only and digits_only not in joined_ev:
                    number_warnings.append(
                        {
                            "number": token,
                            "sentence": line[:120],
                            "refs": valid_here,
                        }
                    )
        else:
            uncited_lines.append(line[:140])

    ratio = round((cited_lines / substantive_lines) * 100.0, 1) if substantive_lines > 0 else 100.0
    return {
        "cited_refs": sorted(cited_refs),
        "invalid_refs": sorted(invalid_refs),
        "substantive_lines": substantive_lines,
        "cited_lines": cited_lines,
        "citation_ratio": ratio,
        "uncited_lines": uncited_lines[:10],
        "number_warnings": number_warnings[:10],
    }


def ask_knowledge_base(
    cfg: AppConfig,
    vector_service: VectorService,
    question: str,
    engine_id: str | None = None,
    source_id: str | None = None,
    project: str | None = None,
    top_k: int | None = None,
    include_historical: bool = False,
    selected_docs: list[dict[str, str]] | None = None,
    conversation_turns: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    q = question.strip()
    if not q:
        raise ValueError("问题不能为空")

    engine = _find_engine(cfg, engine_id)
    k = max(3, min(16, top_k or cfg.qa.default_top_k))
    t0 = time.time()

    allowed_pairs: list[tuple[str, str]] | None = None
    if selected_docs:
        allowed_pairs = [
            (str(d["source_id"]), str(d["rel_path"]))
            for d in selected_docs
            if d.get("source_id") and d.get("rel_path")
        ]

    # Step 1: Retrieve grounded evidence chunks using Phase 2 RRF hybrid search (or explicit checked docs)
    search_query = q
    if conversation_turns:
        # Enrich retrieval query with previous user question to resolve pronouns like "那个项目/第二点"
        last_u = next((t.get("question", "") for t in reversed(conversation_turns) if t.get("question")), "")
        if last_u and len(q) < 40:
            search_query = f"{last_u} {q}"

    search_res = search_chunks(
        cfg,
        q=search_query,
        source_id=None if allowed_pairs else source_id,
        project=None if allowed_pairs else project,
        mode="hybrid",
        include_historical=True if allowed_pairs else include_historical,
        allowed_doc_pairs=allowed_pairs,
        limit=k,
        vector_service=vector_service,
    )

    conn = connect_db(cfg.db_path)
    try:
        chunk_ids = [it["chunk_id"] for it in search_res["items"] if it["chunk_id"] is not None]
        full_content_map: dict[int, str] = {}
        if chunk_ids:
            placeholders = ",".join("?" for _ in chunk_ids)
            for r in conn.execute(
                f"SELECT id, content FROM chunks WHERE id IN ({placeholders})", chunk_ids
            ).fetchall():
                full_content_map[int(r["id"])] = r["content"]
    finally:
        conn.close()

    evidence: list[dict[str, Any]] = []
    for idx, it in enumerate(search_res["items"], 1):
        cid = it["chunk_id"]
        full_text = full_content_map.get(cid, "") if cid is not None else ""
        excerpt = full_text[: cfg.qa.max_excerpt_chars]
        evidence.append(
            {
                "ref": idx,
                "chunk_id": cid,
                "source_id": it["source_id"],
                "rel_path": it["rel_path"],
                "project": it["project"],
                "title": it["title"],
                "ext": it["ext"],
                "heading_path": it["heading_path"],
                "start_line": it["start_line"],
                "end_line": it["end_line"],
                "page_num": it["page_num"],
                "match_type": it.get("match_type", "hybrid"),
                "vec_score": it.get("vec_score"),
                "git_author": it.get("git_author", ""),
                "git_date": it.get("git_date", ""),
                "content": excerpt,
            }
        )

    if not evidence:
        return {
            "id": None,
            "status": "no_evidence",
            "question": q,
            "engine_id": engine.id,
            "engine_label": engine.label,
            "source_id": source_id or "all",
            "project": project or "all",
            "answer": "在当前筛选的知识库范围内未检索到相关片段，建议放宽筛选范围或换个关键词重试。",
            "evidence": [],
            "audit": {"cited_refs": [], "invalid_refs": [], "citation_ratio": 100.0, "uncited_lines": [], "number_warnings": []},
            "duration_ms": int((time.time() - t0) * 1000),
            "error": "",
        }

    # Step 2: Build strict grounded prompt
    ev_blocks: list[str] = []
    for ev in evidence:
        loc = f"第{ev['page_num']}页" if ev["page_num"] else f"L{ev['start_line']}-L{ev['end_line']}"
        hd = f" > {ev['heading_path']}" if ev["heading_path"] else ""
        ev_blocks.append(
            f"[{ev['ref']}] 来源：{ev['source_id']}/{ev['rel_path']} ({loc}{hd})\n"
            f"标题：{ev['title']}\n"
            f"内容：\n{ev['content']}"
        )

    tool_rule = (
        "1. 不要调用任何外部工具、不要读取额外文件、不要联网，严格只依据下方 [1]~[N] 证据片段作答。"
        if engine.mode == "fast"
        else "1. 优先依据下方 [1]~[N] 证据片段作答；仅当片段明显截断时可只读查阅原文，绝不修改任何文件。"
    )

    history_block = ""
    if conversation_turns:
        recent_turns = conversation_turns[-3:]
        t_lines = []
        for idx_t, turn in enumerate(recent_turns, 1):
            tq = (turn.get("question") or "").strip()
            ta = (turn.get("answer") or "").strip()[:450]
            if tq:
                t_lines.append(f"轮次 {idx_t} 问：{tq}\n轮次 {idx_t} 答（摘要）：{ta}")
        if t_lines:
            history_block = (
                "## 本次会话前序问答（仅用于理解指代，事实必须仍以下方最新证据 [1]~[N] 为准）\n\n"
                + "\n\n".join(t_lines)
                + "\n\n"
            )

    scope_note = (
        f"（用户已手动限定以下 {len(allowed_pairs)} 份文档作为回答围栏）"
        if allowed_pairs
        else ""
    )

    prompt = (
        f"你是用户的本地知识库核对助手（严格只读模式）{scope_note}。请用中文先给结论、再给依据，回答用户问题。\n\n"
        "必须遵守的规则：\n"
        f"{tool_rule}\n"
        "2. 每一条事实论断、口径、数字、结论句末都必须用 [1] 或 [1][2] 标明引用的片段编号。\n"
        "3. 如果证据里没有覆盖问题的某一部分，直接写「知识库召回片段中未找到相关依据」，绝不编造或靠常识补全数字。\n"
        "4. 如果多个片段存在不同时间或不同版本的口径，请按日期/版本分别列出并标明出处 [n]。\n"
        "5. 保持简洁克制，直接输出回答正文，不要寒暄。\n\n"
        + history_block
        + f"## 知识库召回证据（共 {len(evidence)} 条）\n\n"
        + "\n\n---\n\n".join(ev_blocks)
        + f"\n\n## 当前问题\n{q}\n"
    )

    src_dir = cfg.source_by_id(source_id).path if (source_id and source_id != "all" and cfg.source_by_id(source_id)) else None
    answer, error = run_cli_prompt(cfg, engine, prompt, readonly_dir=src_dir)
    duration_ms = int((time.time() - t0) * 1000)

    status = "ok" if answer and not error else "error"
    audit = audit_answer_citations(answer, evidence) if status == "ok" else {}

    # Step 3: Persist QA history locally (never writes to wiki!)
    conn = connect_db(cfg.db_path)
    try:
        cur = conn.execute(
            """
            INSERT INTO qa_history (
                created_at, question, engine_id, engine_label, source_id, project,
                status, answer, evidence_json, audit_json, duration_ms, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                _now_iso(),
                q,
                engine.id,
                engine.label,
                source_id or "all",
                project or "all",
                status,
                answer,
                json.dumps(evidence, ensure_ascii=False),
                json.dumps(audit, ensure_ascii=False),
                duration_ms,
                error,
            ),
        )
        qa_id = cur.lastrowid
        conn.commit()
    finally:
        conn.close()

    return {
        "id": qa_id,
        "created_at": _now_iso(),
        "status": status,
        "question": q,
        "engine_id": engine.id,
        "engine_label": engine.label,
        "source_id": source_id or "all",
        "project": project or "all",
        "answer": answer,
        "evidence": evidence,
        "audit": audit,
        "duration_ms": duration_ms,
        "error": error,
    }


def list_qa_history(cfg: AppConfig, limit: int = 40) -> list[dict[str, Any]]:
    conn = connect_db(cfg.db_path)
    try:
        rows = conn.execute(
            """
            SELECT id, created_at, question, engine_id, engine_label, source_id, project,
                   status, answer, evidence_json, audit_json, duration_ms, error
            FROM qa_history
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    finally:
        conn.close()

    out: list[dict[str, Any]] = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "created_at": r["created_at"],
                "question": r["question"],
                "engine_id": r["engine_id"],
                "engine_label": r["engine_label"],
                "source_id": r["source_id"],
                "project": r["project"],
                "status": r["status"],
                "answer": r["answer"],
                "evidence": json.loads(r["evidence_json"] or "[]"),
                "audit": json.loads(r["audit_json"] or "{}"),
                "duration_ms": r["duration_ms"],
                "error": r["error"],
            }
        )
    return out

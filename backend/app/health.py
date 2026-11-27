from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from .config import AppConfig
from .timeline import decode_git_quoted_path


def _read_json(path: Path) -> Any:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return None


def _git_uncommitted(repo_path: Path) -> list[dict[str, str]]:
    if not (repo_path / ".git").exists():
        return []
    try:
        proc = subprocess.run(
            ["git", "-c", "core.quotepath=false", "-C", str(repo_path), "status", "--porcelain"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except Exception:
        return []
    out: list[dict[str, str]] = []
    for ln in proc.stdout.splitlines():
        if len(ln) >= 4:
            code = ln[:2].strip() or "??"
            rel = decode_git_quoted_path(ln[3:])
            out.append({"status": code, "path": rel})
    return out


def build_health_report(
    cfg: AppConfig,
    index_status: dict[str, Any],
    vector_status: dict[str, Any] | None = None,
    watcher_active: bool = False,
) -> dict[str, Any]:
    is_standalone = cfg.edition == "standalone"
    alerts_data = {"alerts": [], "count": 0} if is_standalone else (_read_json(cfg.health_dir / "alerts.json") or {"alerts": [], "count": 0})
    wiki_health = {} if is_standalone else (_read_json(cfg.health_dir / "wiki-health-report.json") or {})
    skill_lint = {} if is_standalone else (_read_json(cfg.health_dir / "skill-lint.json") or {})
    stack_audit = {} if is_standalone else (_read_json(cfg.health_dir / "agent-stack-audit.json") or {})

    # Live uncommitted git status across federated repos + shared skills
    repos: list[tuple[str, str, Path]] = [
        (s.id, s.name, s.path) for s in cfg.sources if s.is_git
    ]
    if not is_standalone:
        skills_repo = Path.home() / ".agents" / "skills"
        if (skills_repo / ".git").exists():
            repos.append(("shared-skills", "共享技能库（~/.agents/skills）", skills_repo))

    uncommitted: list[dict[str, Any]] = []
    for src_id, src_name, rpath in repos:
        files = _git_uncommitted(rpath)
        if files:
            sample_paths = "、".join(f["path"] for f in files[:5])
            more = f" 等共 {len(files)} 个文件" if len(files) > 5 else ""
            fix_prompt = (
                f"请检查 {rpath} 中未提交的改动（{sample_paths}{more}）："
                f"先核对是否由其他并发会话正在写入；若是已完成的遗留改动，确认归属后补齐 INDEX/changelog 并按仓库提交规范提交。"
            )
            uncommitted.append(
                {
                    "source_id": src_id,
                    "source_name": src_name,
                    "repo_path": str(rpath),
                    "count": len(files),
                    "files": files[:60],
                    "fix_prompt": fix_prompt,
                }
            )

    # Enrich alerts with one-click agent fix prompts
    enriched_alerts: list[dict[str, Any]] = []
    for al in alerts_data.get("alerts", []):
        src = al.get("source", "")
        msg = al.get("message", "")
        if src == "launchd":
            prompt = f"本机告警：{msg}。请排查对应 launchd 服务的日志和最近退出原因，给出修复方案后再动配置。"
        elif src == "uncommitted":
            prompt = f"本机告警：{msg}。请只读核对这些未提交文件的归属和内容状态，告诉我哪些可以提交、哪些还在修改中，不要直接覆盖他端改动。"
        else:
            prompt = f"本机联邦知识库告警（来源 {src}）：{msg}。请排查原因并给出修复建议。"
        enriched_alerts.append({**al, "fix_prompt": prompt})

    # Enrich wiki-health issues with fix prompts (filter out pure OK items for action queue)
    wiki_issues: list[dict[str, Any]] = []
    for iss in wiki_health.get("issues", []):
        sev = iss.get("severity", "INFO")
        repo = iss.get("repo", "")
        proj = iss.get("project", "")
        msg = iss.get("message", "")
        fix_prompt = (
            f"wiki 健康巡检发现 [{sev}] {repo}/{proj}：{msg}。"
            f"请核对对应目录与 INDEX.md 的差异，确认后同步 INDEX.md 和 changelog，并提交变更。"
        )
        wiki_issues.append({**iss, "fix_prompt": fix_prompt})

    # Summarize skill-lint issues
    lint_skills = skill_lint.get("skills", []) if isinstance(skill_lint, dict) else []
    lint_with_issues = [s for s in lint_skills if s.get("issues")]
    lint_with_issues.sort(key=lambda x: len(x.get("issues", [])), reverse=True)
    top_lint = []
    for s in lint_with_issues[:30]:
        codes = ", ".join(
            f"{i.get('code')}{'(' + i.get('detail') + ')' if i.get('detail') else ''}"
            for i in s.get("issues", [])
        )
        top_lint.append(
            {
                "name": s.get("name"),
                "lines": s.get("lines"),
                "issue_count": len(s.get("issues", [])),
                "issues": s.get("issues", []),
                "fix_prompt": (
                    f"skill-lint 检查到共享技能 ~/.agents/skills/{s.get('name')}/SKILL.md 存在问题：{codes}。"
                    f"请按 skill-creator 规范排查并提出最小修改建议（先给我看 diff 再提交）。"
                ),
            }
        )

    return {
        "edition": cfg.edition,
        "alerts": {
            "generated_at": alerts_data.get("generated_at"),
            "count": len(enriched_alerts),
            "items": enriched_alerts,
        },
        "wiki_health": {
            "timestamp": wiki_health.get("timestamp"),
            "healthy": wiki_health.get("healthy"),
            "stats": wiki_health.get("stats", {}),
            "issues": wiki_issues,
        },
        "uncommitted": uncommitted,
        "skill_lint": {
            "total_skills": len(lint_skills),
            "skills_with_issues": len(lint_with_issues),
            "top_items": top_lint,
        },
        "stack_audit": {
            "generated_at": stack_audit.get("generated_at"),
            "counts": stack_audit.get("counts", {}),
        },
        "index_status": index_status,
        "vector_status": vector_status,
        "watcher_active": watcher_active,
    }

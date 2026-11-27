from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config.yaml"


@dataclass(frozen=True)
class SourceConfig:
    id: str
    name: str
    path: Path
    kind: str  # wiki | portal | archive | folder | files
    is_git: bool
    sensitivity: str  # work | personal | system
    files: tuple[Path, ...] = ()

    def file_map(self) -> dict[str, Path]:
        """Stable, human-readable rel_path -> Path map for kind='files' sources."""
        mapping: dict[str, Path] = {}
        for f in self.files:
            p = f.expanduser()
            parent = p.parent.name or "本机文件"
            rel = f"{parent}/{p.name}"
            if rel in mapping and mapping[rel] != p:
                grand = p.parent.parent.name or "root"
                rel = f"{grand}/{parent}/{p.name}"
                idx = 2
                base_rel = rel
                while rel in mapping and mapping[rel] != p:
                    rel = f"{base_rel} ({idx})"
                    idx += 1
            mapping[rel] = p
        return mapping


@dataclass(frozen=True)
class EmbeddingConfig:
    enabled: bool = True
    model_name: str = "BAAI/bge-small-zh-v1.5"
    cache_dir: Path = PROJECT_ROOT / "data" / "models"
    batch_size: int = 32
    threads: int = 4
    idle_unload_seconds: int = 300
    rrf_k: int = 60
    max_text_chars: int = 1200


@dataclass(frozen=True)
class QaEngineConfig:
    id: str
    label: str
    provider: str  # agy | codex | claude | openai_api
    mode: str = "fast"  # fast | deep
    model: str = ""
    timeout_seconds: int = 120
    note: str = ""
    base_url: str = ""
    api_key: str = ""


@dataclass(frozen=True)
class OpenAiApiConfig:
    enabled: bool = False
    label: str = "自定义模型 API（OpenAI 兼容）"
    base_url: str = "https://api.deepseek.com/v1"
    api_key: str = ""
    model: str = "deepseek-chat"


@dataclass(frozen=True)
class QaConfig:
    default_engine: str = "agy-fast"
    default_top_k: int = 10
    max_excerpt_chars: int = 900
    engines: list[QaEngineConfig] = field(default_factory=list)
    openai_api: OpenAiApiConfig = field(default_factory=OpenAiApiConfig)


@dataclass(frozen=True)
class ConflictConfig:
    min_similarity: float = 0.84
    max_candidates: int = 80
    review_engine: str = "agy-fast"


@dataclass
class AppConfig:
    edition: str  # personal | standalone
    config_path: Path
    onboarding_completed: bool
    host: str
    port: int
    data_dir: Path
    db_path: Path
    portal_dir: Path
    audit_file: Path
    health_dir: Path
    sources: list[SourceConfig]
    allowed_extensions: set[str]
    max_file_size_mb: dict[str, float]
    xlsx_max_rows_per_sheet: int
    xlsx_max_chars: int
    csv_max_rows: int
    pdf_max_pages: int
    chunk_max_chars: int
    chunk_overlap_lines: int
    exclude_dir_names: set[str]
    exclude_dir_suffixes: tuple[str, ...]
    exclude_paths: list[Path]
    exclude_keywords: list[str]
    poll_interval_seconds: int
    embedding: EmbeddingConfig = field(default_factory=EmbeddingConfig)
    qa: QaConfig = field(default_factory=QaConfig)
    conflicts: ConflictConfig = field(default_factory=ConflictConfig)
    actors: list[dict[str, Any]] = field(default_factory=list)
    project_aliases: dict[str, list[str]] = field(default_factory=dict)

    def source_by_id(self, source_id: str) -> SourceConfig | None:
        for s in self.sources:
            if s.id == source_id:
                return s
        return None

    def is_path_excluded(self, target: Path) -> bool:
        resolved = target.resolve()
        s = str(resolved)
        for ex in self.exclude_paths:
            try:
                resolved.relative_to(ex.resolve())
                return True
            except ValueError:
                pass
        for kw in self.exclude_keywords:
            if kw and kw in s:
                return True
        return False

    def resolve_safe_path(self, source_id: str, rel_path: str) -> Path | None:
        src = self.source_by_id(source_id)
        if not src:
            return None
        if src.kind == "files":
            target = src.file_map().get(rel_path)
            if not target:
                return None
            try:
                candidate = target.resolve()
            except OSError:
                return None
            if not candidate.exists() or not candidate.is_file():
                return None
            if self.is_path_excluded(candidate):
                return None
            return candidate
        candidate = (src.path / rel_path).resolve()
        root = src.path.resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            return None
        if self.is_path_excluded(candidate):
            return None
        return candidate


def _default_standalone_raw(data_dir: Path, port: int, bundled_models: Path | None) -> dict[str, Any]:
    model_dir = bundled_models if (bundled_models and bundled_models.exists()) else (data_dir / "models")
    return {
        "edition": "standalone",
        "onboarding_completed": False,
        "server": {"host": "127.0.0.1", "port": port},
        "paths": {
            "data_dir": str(data_dir),
            "db_path": str(data_dir / "kb_console.db"),
            "portal_dir": "",
            "audit_file": "",
            "health_dir": "",
        },
        "sources": [],
        "indexing": {
            "allowed_extensions": [".md", ".txt", ".pdf", ".docx", ".pptx", ".xlsx", ".csv", ".html", ".htm", ".json", ".yaml", ".yml"],
            "max_file_size_mb": {"default": 30, ".pdf": 120, ".pptx": 120, ".xlsx": 250},
            "xlsx_max_rows_per_sheet": 50,
            "xlsx_max_chars": 200000,
            "csv_max_rows": 100,
            "pdf_max_pages": 300,
            "chunk_max_chars": 1400,
            "chunk_overlap_lines": 3,
            "exclude_dir_names": [
                ".git",
                "node_modules",
                "__pycache__",
                ".venv",
                "venv",
                "dist",
                "build",
                ".archive",
            ],
            "exclude_dir_suffixes": [".app"],
            "exclude_paths": [],
            "exclude_keywords": ["病历", "体检报告", "身份证", "银行卡", "密码"],
            "poll_interval_seconds": 120,
        },
        "embedding": {
            "enabled": True,
            "model_name": "BAAI/bge-small-zh-v1.5",
            "cache_dir": str(model_dir),
            "batch_size": 32,
            "threads": 4,
            "idle_unload_seconds": 300,
            "rrf_k": 60,
            "max_text_chars": 1200,
        },
        "qa": {
            "default_engine": "openai-api",
            "default_top_k": 10,
            "max_excerpt_chars": 900,
            "openai_api": {
                "enabled": False,
                "label": "自定义模型 API（OpenAI 兼容）",
                "base_url": "https://api.deepseek.com/v1",
                "api_key": "",
                "model": "deepseek-chat",
            },
            "engines": [
                {
                    "id": "agy-fast",
                    "label": "Antigravity CLI · 快问",
                    "provider": "agy",
                    "mode": "fast",
                    "model": "gemini-4-hydrogen-low",
                    "timeout_seconds": 90,
                    "note": "需本机已安装 agy CLI",
                },
                {
                    "id": "codex-ro",
                    "label": "Codex CLI · 只读沙箱",
                    "provider": "codex",
                    "mode": "fast",
                    "model": "",
                    "timeout_seconds": 150,
                    "note": "需本机已安装 codex CLI",
                },
                {
                    "id": "claude-fast",
                    "label": "Claude Code CLI · 快问",
                    "provider": "claude",
                    "mode": "fast",
                    "model": "",
                    "timeout_seconds": 120,
                    "note": "需本机已安装 claude CLI",
                },
            ],
        },
        "conflicts": {
            "min_similarity": 0.80,
            "max_candidates": 80,
            "review_engine": "openai-api",
        },
        "actors": [],
    }


def _resolve_config_path(path: Path | None = None) -> tuple[Path, str]:
    edition = os.environ.get("KB_CONSOLE_EDITION", "standalone").strip().lower()
    if os.environ.get("KB_CONSOLE_CONFIG"):
        return Path(os.environ["KB_CONSOLE_CONFIG"]).expanduser(), edition
    if edition == "standalone":
        data_dir = Path(
            os.environ.get("KB_CONSOLE_DATA_DIR", str(Path.home() / "Library" / "Application Support" / "KBConsole"))
        ).expanduser()
        data_dir.mkdir(parents=True, exist_ok=True)
        return data_dir / "config.yaml", "standalone"
    return (path or DEFAULT_CONFIG_PATH), edition


def load_raw_config(path: Path | None = None) -> tuple[dict[str, Any], Path, str]:
    cfg_path, env_edition = _resolve_config_path(path)
    if not cfg_path.exists():
        if env_edition == "standalone":
            data_dir = cfg_path.parent
            port = int(os.environ.get("KB_CONSOLE_PORT", "18766"))
            bundled_models_env = os.environ.get("KB_CONSOLE_BUNDLED_MODEL_DIR", "")
            bundled_models = Path(bundled_models_env) if bundled_models_env else None
            raw = _default_standalone_raw(data_dir, port, bundled_models)
            cfg_path.write_text(yaml.safe_dump(raw, allow_unicode=True, sort_keys=False), encoding="utf-8")
            return raw, cfg_path, "standalone"
        raise FileNotFoundError(f"配置文件不存在：{cfg_path}")

    raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    edition = str(raw.get("edition") or env_edition or "personal")
    return raw, cfg_path, edition


def save_raw_config(cfg_path: Path, raw: dict[str, Any]) -> None:
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(yaml.safe_dump(raw, allow_unicode=True, sort_keys=False), encoding="utf-8")


def load_config(path: Path | None = None) -> AppConfig:
    raw, cfg_path, edition = load_raw_config(path)

    server = raw.get("server", {})
    paths = raw.get("paths", {})
    idx = raw.get("indexing", {})
    emb_raw = raw.get("embedding", {})
    qa_raw = raw.get("qa", {})
    conf_raw = raw.get("conflicts", {})

    port = int(os.environ.get("KB_CONSOLE_PORT", str(server.get("port", 18765))))

    data_dir = Path(paths.get("data_dir", str(cfg_path.parent))).expanduser()
    data_dir.mkdir(parents=True, exist_ok=True)

    sources: list[SourceConfig] = []
    for s in raw.get("sources", []):
        kind = s.get("kind", "folder")
        if kind == "files":
            raw_files = [Path(fp).expanduser() for fp in (s.get("files") or []) if fp]
            if not raw_files:
                continue
            sources.append(
                SourceConfig(
                    id=s["id"],
                    name=s.get("name", "拾取的零散文件"),
                    path=data_dir / "_picked_files_virtual",
                    kind="files",
                    is_git=False,
                    sensitivity=s.get("sensitivity", "personal"),
                    files=tuple(raw_files),
                )
            )
        elif s.get("path"):
            p = Path(s["path"]).expanduser()
            sources.append(
                SourceConfig(
                    id=s["id"],
                    name=s["name"],
                    path=p,
                    kind=kind,
                    is_git=bool(s.get("is_git", (p / ".git").exists())),
                    sensitivity=s.get("sensitivity", "personal"),
                )
            )

    # Prefer bundled offline models dir in standalone .app when available
    bundled_models_env = os.environ.get("KB_CONSOLE_BUNDLED_MODEL_DIR", "")
    if bundled_models_env and Path(bundled_models_env).exists():
        emb_cache = Path(bundled_models_env)
    else:
        emb_cache = Path(emb_raw.get("cache_dir", str(data_dir / "models"))).expanduser()
        emb_cache.mkdir(parents=True, exist_ok=True)

    embedding_cfg = EmbeddingConfig(
        enabled=bool(emb_raw.get("enabled", True)),
        model_name=str(emb_raw.get("model_name", "BAAI/bge-small-zh-v1.5")),
        cache_dir=emb_cache,
        batch_size=int(emb_raw.get("batch_size", 32)),
        threads=int(emb_raw.get("threads", 4)),
        idle_unload_seconds=int(emb_raw.get("idle_unload_seconds", 300)),
        rrf_k=int(emb_raw.get("rrf_k", 60)),
        max_text_chars=int(emb_raw.get("max_text_chars", 1200)),
    )

    oai_raw = qa_raw.get("openai_api", {}) or {}
    openai_cfg = OpenAiApiConfig(
        enabled=bool(oai_raw.get("enabled", False)),
        label=str(oai_raw.get("label", "自定义模型 API（OpenAI 兼容）")),
        base_url=str(oai_raw.get("base_url", "https://api.deepseek.com/v1")),
        api_key=str(oai_raw.get("api_key", "")),
        model=str(oai_raw.get("model", "deepseek-chat")),
    )

    qa_engines: list[QaEngineConfig] = []
    if openai_cfg.api_key.strip() or edition == "standalone":
        qa_engines.append(
            QaEngineConfig(
                id="openai-api",
                label=f"{openai_cfg.model or 'API 模型'}（自定义 API）" if openai_cfg.api_key.strip() else "自定义 API（待配置 Key）",
                provider="openai_api",
                mode="fast",
                model=openai_cfg.model,
                timeout_seconds=90,
                note=f"OpenAI 兼容接口 · {openai_cfg.base_url}",
                base_url=openai_cfg.base_url,
                api_key=openai_cfg.api_key,
            )
        )

    for e in qa_raw.get("engines", []):
        qa_engines.append(
            QaEngineConfig(
                id=str(e["id"]),
                label=str(e.get("label", e["id"])),
                provider=str(e.get("provider", "agy")),
                mode=str(e.get("mode", "fast")),
                model=str(e.get("model", "")),
                timeout_seconds=int(e.get("timeout_seconds", 120)),
                note=str(e.get("note", "")),
            )
        )

    qa_cfg = QaConfig(
        default_engine=str(qa_raw.get("default_engine", "openai-api" if edition == "standalone" else "agy-fast")),
        default_top_k=int(qa_raw.get("default_top_k", 10)),
        max_excerpt_chars=int(qa_raw.get("max_excerpt_chars", 900)),
        engines=qa_engines,
        openai_api=openai_cfg,
    )
    conflict_cfg = ConflictConfig(
        min_similarity=float(conf_raw.get("min_similarity", 0.80 if edition == "standalone" else 0.84)),
        max_candidates=int(conf_raw.get("max_candidates", 80)),
        review_engine=str(conf_raw.get("review_engine", "openai-api" if edition == "standalone" else "agy-fast")),
    )

    portal_str = paths.get("portal_dir", "")
    audit_str = paths.get("audit_file", "")
    health_str = paths.get("health_dir", "")

    return AppConfig(
        edition=edition,
        config_path=cfg_path,
        onboarding_completed=bool(raw.get("onboarding_completed", edition != "standalone")),
        host=server.get("host", "127.0.0.1"),
        port=port,
        data_dir=data_dir,
        db_path=Path(paths.get("db_path", str(data_dir / "kb_console.db"))).expanduser(),
        portal_dir=Path(portal_str).expanduser() if portal_str else Path("/nonexistent-portal"),
        audit_file=Path(audit_str).expanduser() if audit_str else Path("/nonexistent-audit"),
        health_dir=Path(health_str).expanduser() if health_str else Path("/nonexistent-health"),
        sources=sources,
        allowed_extensions={e.lower() for e in idx.get("allowed_extensions", [".md"])},
        max_file_size_mb={k.lower(): float(v) for k, v in idx.get("max_file_size_mb", {"default": 30}).items()},
        xlsx_max_rows_per_sheet=int(idx.get("xlsx_max_rows_per_sheet", 50)),
        xlsx_max_chars=int(idx.get("xlsx_max_chars", 200000)),
        csv_max_rows=int(idx.get("csv_max_rows", 100)),
        pdf_max_pages=int(idx.get("pdf_max_pages", 300)),
        chunk_max_chars=int(idx.get("chunk_max_chars", 1400)),
        chunk_overlap_lines=int(idx.get("chunk_overlap_lines", 3)),
        exclude_dir_names=set(idx.get("exclude_dir_names", [])),
        exclude_dir_suffixes=tuple(idx.get("exclude_dir_suffixes", [])),
        exclude_paths=[Path(p).expanduser() for p in idx.get("exclude_paths", [])],
        exclude_keywords=list(idx.get("exclude_keywords", [])),
        poll_interval_seconds=int(idx.get("poll_interval_seconds", 120)),
        embedding=embedding_cfg,
        qa=qa_cfg,
        conflicts=conflict_cfg,
        actors=list(raw.get("actors", [])),
        project_aliases={
            str(k): [str(x) for x in (v or [])]
            for k, v in (raw.get("project_aliases") or {}).items()
        },
    )

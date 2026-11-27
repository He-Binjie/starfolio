from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA_SQL = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    abs_path TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    ext TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    mtime REAL NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    chunk_count INTEGER NOT NULL DEFAULT 0,
    parse_status TEXT NOT NULL DEFAULT 'ok',
    parse_note TEXT NOT NULL DEFAULT '',
    git_author TEXT NOT NULL DEFAULT '',
    git_date TEXT NOT NULL DEFAULT '',
    git_message TEXT NOT NULL DEFAULT '',
    indexed_at TEXT NOT NULL DEFAULT '',
    UNIQUE(source_id, rel_path)
);

CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(source_id, project);
CREATE INDEX IF NOT EXISTS idx_documents_ext ON documents(ext);
CREATE INDEX IF NOT EXISTS idx_documents_mtime ON documents(mtime DESC);

CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    heading_path TEXT NOT NULL DEFAULT '',
    start_line INTEGER NOT NULL DEFAULT 1,
    end_line INTEGER NOT NULL DEFAULT 1,
    page_num INTEGER,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    title_tok,
    heading_tok,
    path_tok,
    content_tok,
    tokenize="unicode61 remove_diacritics 0 tokenchars '#-_./'"
);

CREATE TABLE IF NOT EXISTS index_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    files_scanned INTEGER NOT NULL DEFAULT 0,
    files_indexed INTEGER NOT NULL DEFAULT 0,
    files_skipped INTEGER NOT NULL DEFAULT 0,
    files_failed INTEGER NOT NULL DEFAULT 0,
    files_removed INTEGER NOT NULL DEFAULT 0,
    total_chunks INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS chunk_vectors (
    content_hash TEXT NOT NULL,
    model_name TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (content_hash, model_name)
);

CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);

CREATE TABLE IF NOT EXISTS qa_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    question TEXT NOT NULL,
    engine_id TEXT NOT NULL,
    engine_label TEXT NOT NULL DEFAULT '',
    source_id TEXT NOT NULL DEFAULT 'all',
    project TEXT NOT NULL DEFAULT 'all',
    status TEXT NOT NULL DEFAULT 'ok',
    answer TEXT NOT NULL DEFAULT '',
    evidence_json TEXT NOT NULL DEFAULT '[]',
    audit_json TEXT NOT NULL DEFAULT '{}',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS conflict_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pair_key TEXT NOT NULL UNIQUE,
    source_id TEXT NOT NULL,
    project TEXT NOT NULL,
    doc_a_id INTEGER NOT NULL,
    chunk_a_id INTEGER NOT NULL,
    rel_path_a TEXT NOT NULL,
    title_a TEXT NOT NULL,
    start_line_a INTEGER NOT NULL,
    end_line_a INTEGER NOT NULL,
    snippet_a TEXT NOT NULL,
    doc_b_id INTEGER NOT NULL,
    chunk_b_id INTEGER NOT NULL,
    rel_path_b TEXT NOT NULL,
    title_b TEXT NOT NULL,
    start_line_b INTEGER NOT NULL,
    end_line_b INTEGER NOT NULL,
    snippet_b TEXT NOT NULL,
    similarity REAL NOT NULL,
    diff_tokens_json TEXT NOT NULL DEFAULT '{}',
    priority_score REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    llm_verdict TEXT NOT NULL DEFAULT '',
    llm_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conflicts_status ON conflict_candidates(status, priority_score DESC);

CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    docs_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


def connect_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db(db_path: Path) -> None:
    conn = connect_db(db_path)
    try:
        conn.executescript(SCHEMA_SQL)
        conn.commit()
    finally:
        conn.close()

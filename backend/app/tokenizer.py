from __future__ import annotations

import html
import re

# CJK Unified Ideographs + Extension A + Compatibility Ideographs
_CJK_RUN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")
_ASCII_TOKEN_RE = re.compile(r"[A-Za-z0-9#][A-Za-z0-9#_\-\.]*")
_QUERY_SPLIT_RE = re.compile(r"[\s,，。；;、|]+")


def tokenize_for_fts(text: str) -> str:
    """Convert mixed Chinese/English/code text into FTS5-friendly space-separated tokens.

    For every contiguous CJK run, emits overlapping bigrams (and unigrams for short runs
    or individual characters) so 1-char, 2-char, and N-char Chinese queries match accurately
    with SQLite FTS5 BM25 without external C libraries.
    ASCII identifiers, version numbers (V7.15), and issue numbers (#232) stay intact.
    """
    if not text:
        return ""
    tokens: list[str] = []
    pos = 0
    length = len(text)
    while pos < length:
        m_cjk = _CJK_RUN_RE.match(text, pos)
        if m_cjk:
            run = m_cjk.group(0)
            n = len(run)
            if n == 1:
                tokens.append(run)
            else:
                # Emit all bigrams + unigrams for short/medium runs; bigrams cover all >=2 substrings
                for i in range(n):
                    tokens.append(run[i])
                for i in range(n - 1):
                    tokens.append(run[i : i + 2])
            pos = m_cjk.end()
            continue

        m_asc = _ASCII_TOKEN_RE.match(text, pos)
        if m_asc:
            tok = m_asc.group(0).lower().strip(".")
            if tok:
                tokens.append(tok)
            pos = m_asc.end()
            continue

        pos += 1
    return " ".join(tokens)


def build_fts_query(raw_query: str) -> tuple[str, list[str]]:
    """Build a safe SQLite FTS5 MATCH query and return (fts_expr, highlight_terms)."""
    raw = raw_query.strip()
    if not raw:
        return "", []

    parts = [p for p in _QUERY_SPLIT_RE.split(raw) if p]
    highlight_terms: list[str] = []
    clauses: list[str] = []

    for part in parts:
        highlight_terms.append(part)
        # Split each whitespace-delimited part into CJK runs and ASCII tokens
        sub_tokens: list[str] = []
        pos = 0
        while pos < len(part):
            m_cjk = _CJK_RUN_RE.match(part, pos)
            if m_cjk:
                run = m_cjk.group(0)
                if len(run) == 1:
                    sub_tokens.append(run)
                else:
                    for i in range(len(run) - 1):
                        sub_tokens.append(run[i : i + 2])
                pos = m_cjk.end()
                continue
            m_asc = _ASCII_TOKEN_RE.match(part, pos)
            if m_asc:
                tok = m_asc.group(0).lower().strip(".")
                if tok:
                    sub_tokens.append(tok)
                pos = m_asc.end()
                continue
            pos += 1

        if sub_tokens:
            quoted = [f'"{t.replace(chr(34), "")}"' for t in sub_tokens if t.replace('"', "")]
            if quoted:
                clauses.append("(" + " AND ".join(quoted) + ")")

    if not clauses:
        return "", highlight_terms

    return " AND ".join(clauses), highlight_terms


_MD_NOISE_RE = re.compile(r"(```[\w-]*|^\s*#{1,6}\s*|\*\*|__|~~|`|\|)", re.MULTILINE)


def make_snippet(content: str, terms: list[str], max_len: int = 210) -> str:
    """Create an HTML-safe, prose-clean snippet with <mark> highlights from original content."""
    if not content:
        return ""
    # Strip raw Markdown syntax so preview cards read like crisp prose (Bear/Craft style)
    cleaned_md = _MD_NOISE_RE.sub(" ", content)
    cleaned_md = re.sub(r"^\s*[-*>]\s+", "", cleaned_md, flags=re.MULTILINE)
    clean = re.sub(r"\s+", " ", cleaned_md).strip()
    if not clean:
        return ""

    low = clean.lower()
    best_idx = -1
    for term in terms:
        t = term.lower().strip()
        if not t:
            continue
        idx = low.find(t)
        if idx != -1 and (best_idx == -1 or idx < best_idx):
            best_idx = idx

    if best_idx == -1:
        window = clean[:max_len]
        prefix = ""
        suffix = "…" if len(clean) > max_len else ""
    else:
        start = max(0, best_idx - max_len // 3)
        end = min(len(clean), start + max_len)
        window = clean[start:end]
        prefix = "…" if start > 0 else ""
        suffix = "…" if end < len(clean) else ""

    escaped = html.escape(window)
    # Sort longer terms first to avoid nested partial replacements
    unique_terms = sorted({t.strip() for t in terms if t.strip()}, key=len, reverse=True)
    if unique_terms:
        pattern = re.compile("|".join(re.escape(html.escape(t)) for t in unique_terms), re.IGNORECASE)
        escaped = pattern.sub(lambda m: f"<mark>{m.group(0)}</mark>", escaped)

    return f"{prefix}{escaped}{suffix}"

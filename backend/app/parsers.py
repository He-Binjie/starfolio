from __future__ import annotations

import csv
import hashlib
import re
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from pathlib import Path

from .config import AppConfig

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")


@dataclass
class ParsedChunk:
    chunk_index: int
    heading_path: str
    start_line: int
    end_line: int
    page_num: int | None
    content: str
    content_hash: str


@dataclass
class ParsedDocument:
    title: str
    chunks: list[ParsedChunk]
    status: str = "ok"
    note: str = ""


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()[:24]


def _split_long_lines(
    lines: list[tuple[int, str]],
    heading_path: str,
    max_chars: int,
    overlap_lines: int,
    page_num: int | None = None,
) -> list[tuple[str, int, int, int | None, str]]:
    """Split a list of (line_no, line_text) into bounded chunks preserving exact line numbers."""
    if not lines:
        return []
    out: list[tuple[str, int, int, int | None, str]] = []
    buf: list[tuple[int, str]] = []
    cur_len = 0

    for item in lines:
        ln_len = len(item[1]) + 1
        if buf and cur_len + ln_len > max_chars:
            text = "\n".join(x[1] for x in buf).strip()
            if text:
                out.append((heading_path, buf[0][0], buf[-1][0], page_num, text))
            buf = buf[-overlap_lines:] if overlap_lines > 0 else []
            cur_len = sum(len(x[1]) + 1 for x in buf)
        buf.append(item)
        cur_len += ln_len

    if buf:
        text = "\n".join(x[1] for x in buf).strip()
        if text:
            out.append((heading_path, buf[0][0], buf[-1][0], page_num, text))
    return out


def parse_markdown_or_text(path: Path, cfg: AppConfig) -> ParsedDocument:
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        return ParsedDocument(title=path.stem, chunks=[], status="error", note=str(exc))

    lines = raw.splitlines()
    if not lines:
        return ParsedDocument(title=path.stem, chunks=[], status="empty", note="空文件")

    title = path.stem
    heading_stack: list[tuple[int, str]] = []
    current_lines: list[tuple[int, str]] = []
    sections: list[tuple[str, list[tuple[int, str]]]] = []

    in_code_fence = False
    for idx, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_code_fence = not in_code_fence

        if not in_code_fence and path.suffix.lower() == ".md":
            m = _HEADING_RE.match(line)
            if m:
                if current_lines:
                    hp = " > ".join(h[1] for h in heading_stack)
                    sections.append((hp, current_lines))
                    current_lines = []
                level = len(m.group(1))
                htext = m.group(2).strip()
                if level == 1 and title == path.stem:
                    title = htext
                while heading_stack and heading_stack[-1][0] >= level:
                    heading_stack.pop()
                heading_stack.append((level, htext))
                current_lines.append((idx, line))
                continue

        current_lines.append((idx, line))

    if current_lines:
        hp = " > ".join(h[1] for h in heading_stack)
        sections.append((hp, current_lines))

    raw_chunks: list[tuple[str, int, int, int | None, str]] = []
    for hp, sec_lines in sections:
        raw_chunks.extend(
            _split_long_lines(sec_lines, hp, cfg.chunk_max_chars, cfg.chunk_overlap_lines)
        )

    chunks = [
        ParsedChunk(
            chunk_index=i,
            heading_path=hp,
            start_line=sl,
            end_line=el,
            page_num=pn,
            content=content,
            content_hash=_hash_text(content),
        )
        for i, (hp, sl, el, pn, content) in enumerate(raw_chunks)
    ]
    return ParsedDocument(title=title, chunks=chunks)


def parse_csv(path: Path, cfg: AppConfig) -> ParsedDocument:
    try:
        with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as fh:
            reader = csv.reader(fh)
            rows: list[tuple[int, str]] = []
            truncated = False
            for idx, row in enumerate(reader, 1):
                if idx > cfg.csv_max_rows + 1:
                    truncated = True
                    break
                rows.append((idx, " | ".join(cell.strip() for cell in row)))
    except Exception as exc:
        return ParsedDocument(title=path.stem, chunks=[], status="error", note=str(exc))

    raw_chunks = _split_long_lines(rows, "CSV 样本", cfg.chunk_max_chars, 1)
    chunks = [
        ParsedChunk(
            chunk_index=i,
            heading_path=hp,
            start_line=sl,
            end_line=el,
            page_num=None,
            content=content,
            content_hash=_hash_text(content),
        )
        for i, (hp, sl, el, _, content) in enumerate(raw_chunks)
    ]
    note = f"仅抽样前 {cfg.csv_max_rows} 行" if truncated else ""
    return ParsedDocument(title=path.stem, chunks=chunks, note=note)


def parse_pdf(path: Path, cfg: AppConfig) -> ParsedDocument:
    try:
        import pymupdf as fitz  # PyMuPDF
    except ImportError:
        try:
            import fitz  # fallback for older PyMuPDF
        except ImportError:
            return ParsedDocument(title=path.stem, chunks=[], status="skipped", note="未安装 PyMuPDF")

    try:
        doc = fitz.open(str(path))
    except Exception as exc:
        return ParsedDocument(title=path.stem, chunks=[], status="error", note=str(exc))

    try:
        total_pages = len(doc)
        limit = min(total_pages, cfg.pdf_max_pages)
        title = (doc.metadata or {}).get("title") or path.stem
        chunks: list[ParsedChunk] = []
        chunk_idx = 0
        for pno in range(limit):
            page = doc.load_page(pno)
            text = (page.get_text("text") or "").strip()
            if not text:
                continue
            page_lines = [(i + 1, ln) for i, ln in enumerate(text.splitlines()) if ln.strip()]
            parts = _split_long_lines(
                page_lines,
                f"第 {pno + 1} 页",
                cfg.chunk_max_chars,
                1,
                page_num=pno + 1,
            )
            for hp, sl, el, pn, content in parts:
                chunks.append(
                    ParsedChunk(
                        chunk_index=chunk_idx,
                        heading_path=hp,
                        start_line=sl,
                        end_line=el,
                        page_num=pn,
                        content=content,
                        content_hash=_hash_text(content),
                    )
                )
                chunk_idx += 1

        note = f"共 {total_pages} 页"
        if total_pages > limit:
            note += f"（已截断前 {limit} 页）"
        if not chunks:
            return ParsedDocument(title=title, chunks=[], status="empty", note=f"{note}，无可读文本（可能为纯扫描件）")
        return ParsedDocument(title=title, chunks=chunks, note=note)
    finally:
        doc.close()


def parse_docx(path: Path, cfg: AppConfig) -> ParsedDocument:
    try:
        from docx import Document
    except ImportError:
        return ParsedDocument(title=path.stem, chunks=[], status="skipped", note="未安装 python-docx")

    try:
        doc = Document(str(path))
    except Exception as exc:
        return ParsedDocument(title=path.stem, chunks=[], status="error", note=str(exc))

    title = path.stem
    heading_stack: list[tuple[int, str]] = []
    sections: list[tuple[str, list[tuple[int, str]]]] = []
    cur_lines: list[tuple[int, str]] = []
    line_no = 0

    for para in doc.paragraphs:
        txt = para.text.strip()
        if not txt:
            continue
        line_no += 1
        style_name = (para.style.name if para.style else "") or ""
        if style_name.startswith("Heading"):
            if cur_lines:
                sections.append((" > ".join(h[1] for h in heading_stack), cur_lines))
                cur_lines = []
            try:
                level = int(style_name.split()[-1])
            except Exception:
                level = 1
            if level == 1 and title == path.stem:
                title = txt
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            heading_stack.append((level, txt))
            cur_lines.append((line_no, txt))
        else:
            cur_lines.append((line_no, txt))

    if cur_lines:
        sections.append((" > ".join(h[1] for h in heading_stack), cur_lines))

    # Also include table headers & rows (bounded)
    for t_idx, table in enumerate(doc.tables, 1):
        t_lines: list[tuple[int, str]] = []
        for r_idx, row in enumerate(table.rows[:80], 1):
            cells = [c.text.strip().replace("\n", " ") for c in row.cells]
            if any(cells):
                line_no += 1
                t_lines.append((line_no, " | ".join(cells)))
        if t_lines:
            sections.append((f"表格 {t_idx}", t_lines))

    chunks: list[ParsedChunk] = []
    idx = 0
    for hp, slines in sections:
        for ch_hp, sl, el, _, content in _split_long_lines(slines, hp, cfg.chunk_max_chars, 1):
            chunks.append(
                ParsedChunk(
                    chunk_index=idx,
                    heading_path=ch_hp,
                    start_line=sl,
                    end_line=el,
                    page_num=None,
                    content=content,
                    content_hash=_hash_text(content),
                )
            )
            idx += 1

    return ParsedDocument(title=title, chunks=chunks, status="ok" if chunks else "empty")


def parse_xlsx(path: Path, cfg: AppConfig) -> ParsedDocument:
    """Sample-based Excel parser: sheet names + headers + first N rows, bounded by char budget."""
    try:
        import openpyxl
    except ImportError:
        return ParsedDocument(title=path.stem, chunks=[], status="skipped", note="未安装 openpyxl")

    try:
        wb = openpyxl.load_workbook(str(path), read_only=True, data_only=True)
    except Exception as exc:
        return ParsedDocument(title=path.stem, chunks=[], status="error", note=str(exc))

    try:
        sheet_names = list(wb.sheetnames)
        chunks: list[ParsedChunk] = []
        chunk_idx = 0
        total_chars = 0

        # Overview chunk listing all sheet names
        overview = f"工作簿：{path.name}\n工作表（共 {len(sheet_names)} 个）：" + "、".join(sheet_names)
        chunks.append(
            ParsedChunk(
                chunk_index=chunk_idx,
                heading_path="工作簿概览",
                start_line=1,
                end_line=2,
                page_num=None,
                content=overview,
                content_hash=_hash_text(overview),
            )
        )
        chunk_idx += 1
        total_chars += len(overview)

        for sname in sheet_names:
            if total_chars >= cfg.xlsx_max_chars:
                break
            ws = wb[sname]
            rows_buf: list[tuple[int, str]] = []
            row_count = 0
            try:
                for r_idx, row in enumerate(
                    ws.iter_rows(max_row=cfg.xlsx_max_rows_per_sheet + 1, values_only=True), 1
                ):
                    vals = [str(v).strip().replace("\n", " ") if v is not None else "" for v in row[:30]]
                    if not any(vals):
                        continue
                    # Trim trailing empties
                    while vals and not vals[-1]:
                        vals.pop()
                    line = " | ".join(vals)
                    if len(line) > 500:
                        line = line[:500] + "…"
                    rows_buf.append((r_idx, line))
                    row_count += 1
                    total_chars += len(line) + 1
                    if total_chars >= cfg.xlsx_max_chars:
                        break
            except Exception:
                continue

            if rows_buf:
                for hp, sl, el, _, content in _split_long_lines(
                    rows_buf, f"Sheet: {sname}", cfg.chunk_max_chars, 1
                ):
                    chunks.append(
                        ParsedChunk(
                            chunk_index=chunk_idx,
                            heading_path=hp,
                            start_line=sl,
                            end_line=el,
                            page_num=None,
                            content=content,
                            content_hash=_hash_text(content),
                        )
                    )
                    chunk_idx += 1

        note = f"抽样索引：{len(sheet_names)} 个 Sheet，每表最多 {cfg.xlsx_max_rows_per_sheet} 行"
        return ParsedDocument(title=path.stem, chunks=chunks, note=note)
    finally:
        wb.close()


_PPTX_SLIDE_RE = re.compile(r"^ppt/slides/slide(\d+)\.xml$")


def _extract_pptx_xml_lines(xml_bytes: bytes) -> list[str]:
    """Extract clean paragraph and table text lines from an OOXML slide/notes XML."""
    try:
        root = ET.fromstring(xml_bytes)
    except Exception:
        return []
    lines: list[str] = []
    # Walk paragraphs (<a:p>) and table rows (<a:tr>) without double-counting table paragraphs
    ns_a = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
    seen_p: set[int] = set()

    for tr in root.iter(f"{ns_a}tr"):
        row_cells: list[str] = []
        for tc in tr.findall(f"{ns_a}tc"):
            cell_parts: list[str] = []
            for p in tc.iter(f"{ns_a}p"):
                seen_p.add(id(p))
                txt = "".join(t.text or "" for t in p.iter(f"{ns_a}t")).strip()
                if txt:
                    cell_parts.append(txt)
            row_cells.append(" ".join(cell_parts).strip())
        if any(row_cells):
            lines.append(" | ".join(row_cells))

    for p in root.iter(f"{ns_a}p"):
        if id(p) in seen_p:
            continue
        txt = "".join(t.text or "" for t in p.iter(f"{ns_a}t")).strip()
        if txt:
            lines.append(txt)

    return lines


def parse_pptx(path: Path, cfg: AppConfig) -> ParsedDocument:
    """Zero-dependency read-only PowerPoint (.pptx) parser with per-slide page numbers and speaker notes."""
    try:
        zf = zipfile.ZipFile(str(path), "r")
    except Exception as exc:
        return ParsedDocument(title=path.stem, chunks=[], status="error", note=f"PPTX 打开失败：{exc}")

    try:
        slide_entries: list[tuple[int, str]] = []
        for name in zf.namelist():
            m = _PPTX_SLIDE_RE.match(name)
            if m:
                slide_entries.append((int(m.group(1)), name))
        slide_entries.sort(key=lambda x: x[0])

        total_slides = len(slide_entries)
        if total_slides == 0:
            return ParsedDocument(title=path.stem, chunks=[], status="empty", note="空 PPTX（无幻灯片页）")

        doc_title = path.stem
        chunks: list[ParsedChunk] = []
        chunk_idx = 0
        non_empty_slides = 0

        for slide_no, slide_name in slide_entries[: cfg.pdf_max_pages]:
            try:
                slide_lines = _extract_pptx_xml_lines(zf.read(slide_name))
            except Exception:
                continue

            # Optional speaker notes (matching slide number)
            notes_name = f"ppt/notesSlides/notesSlide{slide_no}.xml"
            notes_lines: list[str] = []
            if notes_name in zf.namelist():
                try:
                    raw_notes = _extract_pptx_xml_lines(zf.read(notes_name))
                    # Filter standalone slide number digits
                    notes_lines = [ln for ln in raw_notes if not ln.isdigit()]
                except Exception:
                    pass

            if not slide_lines and not notes_lines:
                continue

            non_empty_slides += 1
            slide_heading = slide_lines[0][:60] if slide_lines else f"第 {slide_no} 页"
            if slide_no == 1 and slide_lines and len(slide_lines[0]) >= 2:
                doc_title = slide_lines[0][:90]

            merged: list[tuple[int, str]] = [(i, ln) for i, ln in enumerate(slide_lines, 1)]
            if notes_lines:
                base_ln = len(merged) + 1
                merged.append((base_ln, "[演讲者备注] " + " ".join(notes_lines)))

            hp = f"第 {slide_no} 页 · {slide_heading}" if slide_heading != f"第 {slide_no} 页" else f"第 {slide_no} 页"
            for ch_hp, sl, el, pn, content in _split_long_lines(
                merged, hp, cfg.chunk_max_chars, 1, page_num=slide_no
            ):
                chunks.append(
                    ParsedChunk(
                        chunk_index=chunk_idx,
                        heading_path=ch_hp,
                        start_line=sl,
                        end_line=el,
                        page_num=pn,
                        content=content,
                        content_hash=_hash_text(content),
                    )
                )
                chunk_idx += 1

        if non_empty_slides == 0:
            return ParsedDocument(
                title=path.stem,
                chunks=[],
                status="empty",
                note=f"纯图片 PPTX（共 {total_slides} 页，无可提取文字）",
            )
        note = f"共 {total_slides} 页，已解析 {non_empty_slides} 页"
        return ParsedDocument(title=doc_title, chunks=chunks, status="ok", note=note)
    finally:
        zf.close()


def parse_html(path: Path, cfg: AppConfig) -> ParsedDocument:
    """Zero-dependency HTML text & structure parser (strips script/style/svg, preserves headings & tables)."""
    from html.parser import HTMLParser

    try:
        raw = path.read_text(encoding="utf-8", errors="ignore")
    except Exception as exc:
        return ParsedDocument(title=path.stem, chunks=[], status="error", note=str(exc))

    skip_tags = {"script", "style", "noscript", "svg", "iframe", "template"}
    block_tags = {
        "p", "div", "section", "article", "header", "footer", "main", "aside",
        "li", "tr", "br", "hr", "blockquote", "pre", "dt", "dd",
        "h1", "h2", "h3", "h4", "h5", "h6",
    }
    heading_tags = {"h1": 1, "h2": 2, "h3": 3, "h4": 4}

    class _Extractor(HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self.skip_depth = 0
            self.in_title = False
            self.title_parts: list[str] = []
            self.cur_heading_level: int | None = None
            self.cur_heading_buf: list[str] = []
            self.in_cell = False
            self.row_cells: list[str] = []
            self.cell_buf: list[str] = []
            self.cur_buf: list[str] = []
            self.heading_stack: list[tuple[int, str]] = []
            self.sections: list[tuple[str, list[tuple[int, str]]]] = []
            self.cur_lines: list[tuple[int, str]] = []
            self.line_no = 0

        def _flush_buf(self) -> None:
            txt = " ".join("".join(self.cur_buf).split()).strip()
            self.cur_buf = []
            if txt:
                self.line_no += 1
                self.cur_lines.append((self.line_no, txt))

        def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
            t = tag.lower()
            if t in skip_tags:
                self.skip_depth += 1
                return
            if self.skip_depth > 0:
                return
            if t == "title":
                self.in_title = True
                return
            if t in heading_tags:
                self._flush_buf()
                self.cur_heading_level = heading_tags[t]
                self.cur_heading_buf = []
                return
            if t in ("td", "th"):
                self.in_cell = True
                self.cell_buf = []
                return
            if t == "tr":
                self._flush_buf()
                self.row_cells = []
                return
            if t in block_tags:
                self._flush_buf()

        def handle_endtag(self, tag: str) -> None:
            t = tag.lower()
            if t in skip_tags:
                self.skip_depth = max(0, self.skip_depth - 1)
                return
            if self.skip_depth > 0:
                return
            if t == "title":
                self.in_title = False
                return
            if t in heading_tags and self.cur_heading_level is not None:
                htxt = " ".join("".join(self.cur_heading_buf).split()).strip()
                lvl = self.cur_heading_level
                self.cur_heading_level = None
                self.cur_heading_buf = []
                if htxt:
                    if self.cur_lines:
                        hp = " > ".join(h[1] for h in self.heading_stack)
                        self.sections.append((hp, self.cur_lines))
                        self.cur_lines = []
                    while self.heading_stack and self.heading_stack[-1][0] >= lvl:
                        self.heading_stack.pop()
                    self.heading_stack.append((lvl, htxt[:80]))
                    self.line_no += 1
                    self.cur_lines.append((self.line_no, htxt))
                return
            if t in ("td", "th") and self.in_cell:
                cell = " ".join("".join(self.cell_buf).split()).strip()
                self.row_cells.append(cell)
                self.cell_buf = []
                self.in_cell = False
                return
            if t == "tr":
                if any(self.row_cells):
                    self.line_no += 1
                    self.cur_lines.append((self.line_no, " | ".join(self.row_cells)))
                self.row_cells = []
                return
            if t in block_tags:
                self._flush_buf()

        def handle_data(self, data: str) -> None:
            if self.skip_depth > 0:
                return
            if self.in_title:
                self.title_parts.append(data)
                return
            if self.cur_heading_level is not None:
                self.cur_heading_buf.append(data)
                return
            if self.in_cell:
                self.cell_buf.append(data)
                return
            self.cur_buf.append(data)

        def finish(self) -> None:
            self._flush_buf()
            if self.cur_lines:
                hp = " > ".join(h[1] for h in self.heading_stack)
                self.sections.append((hp, self.cur_lines))

    ext = _Extractor()
    try:
        ext.feed(raw[: 2 * 1024 * 1024])
        ext.finish()
    except Exception as exc:
        return ParsedDocument(title=path.stem, chunks=[], status="error", note=str(exc))

    title = " ".join("".join(ext.title_parts).split()).strip()[:100] or path.stem
    chunks: list[ParsedChunk] = []
    idx = 0
    for hp, slines in ext.sections:
        for ch_hp, sl, el, _, content in _split_long_lines(slines, hp, cfg.chunk_max_chars, 1):
            chunks.append(
                ParsedChunk(
                    chunk_index=idx,
                    heading_path=ch_hp or "页面正文",
                    start_line=sl,
                    end_line=el,
                    page_num=None,
                    content=content,
                    content_hash=_hash_text(content),
                )
            )
            idx += 1

    if not chunks:
        return ParsedDocument(title=title, chunks=[], status="empty", note="HTML 页面无可提取正文")
    return ParsedDocument(title=title, chunks=chunks, status="ok", note=f"网页正文 · {len(chunks)} 段")


def parse_json_file(path: Path, cfg: AppConfig) -> ParsedDocument:
    import json as _json

    try:
        raw = path.read_text(encoding="utf-8", errors="ignore")
    except Exception as exc:
        return ParsedDocument(title=path.stem, chunks=[], status="error", note=str(exc))

    truncated = False
    try:
        obj = _json.loads(raw)
        formatted = _json.dumps(obj, ensure_ascii=False, indent=2)
    except Exception:
        formatted = raw

    if len(formatted) > 120_000:
        formatted = formatted[:120_000] + "\n…（超长 JSON 已截断前 120KB）"
        truncated = True

    lines = [(i + 1, ln) for i, ln in enumerate(formatted.splitlines())]
    chunks: list[ParsedChunk] = []
    for idx, (ch_hp, sl, el, _, content) in enumerate(_split_long_lines(lines, path.name, cfg.chunk_max_chars, 2)):
        chunks.append(
            ParsedChunk(
                chunk_index=idx,
                heading_path=ch_hp,
                start_line=sl,
                end_line=el,
                page_num=None,
                content=content,
                content_hash=_hash_text(content),
            )
        )
    note = "结构化 JSON（已采样前 120KB）" if truncated else "结构化 JSON"
    return ParsedDocument(title=path.stem, chunks=chunks, status="ok" if chunks else "empty", note=note)


def parse_file(path: Path, cfg: AppConfig) -> ParsedDocument:
    ext = path.suffix.lower()
    if ext in {".md", ".txt", ".yaml", ".yml"}:
        return parse_markdown_or_text(path, cfg)
    if ext in {".html", ".htm"}:
        return parse_html(path, cfg)
    if ext == ".json":
        return parse_json_file(path, cfg)
    if ext == ".csv":
        return parse_csv(path, cfg)
    if ext == ".pdf":
        return parse_pdf(path, cfg)
    if ext == ".docx":
        return parse_docx(path, cfg)
    if ext == ".pptx":
        return parse_pptx(path, cfg)
    if ext == ".xlsx":
        return parse_xlsx(path, cfg)
    return ParsedDocument(title=path.stem, chunks=[], status="skipped", note=f"不支持的扩展名 {ext}")

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Drawer,
  Empty,
  Popover,
  Segmented,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  ArrowRightOutlined,
  BookOutlined,
  BranchesOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  CopyOutlined,
  DownOutlined,
  ExportOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  NodeIndexOutlined,
  PlusOutlined,
  SearchOutlined,
  UnorderedListOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { marked } from 'marked';
import { api, CollectionItem, DocumentDetail, DocumentLineageResponse, RelatedDocItem } from '../api';
import { fileManagerName, isWindowsPlatform, modKeyLabel } from '../platform';

interface DocPreviewProps {
  sourceId: string | null;
  relPath: string | null;
  highlightRange?: {
    startLine: number;
    endLine: number;
    pageNum?: number | null;
    chunkId?: number | null;
  } | null;
  sourceNameMap: Record<string, string>;
  onJumpToDoc?: (
    sourceId: string,
    relPath: string,
    highlight?: { startLine: number; endLine: number; pageNum?: number | null; chunkId?: number | null } | null
  ) => void;
  checkedDocKeys?: Set<string>;
  onAddToFence?: (docs: Array<{ source_id: string; rel_path: string; title: string }>) => void;
  recentDocs?: Array<{ source_id: string; rel_path: string; title: string; ext?: string }>;
  collections?: CollectionItem[];
  onOpenCollection?: (col: CollectionItem) => void;
}

interface TocHeading {
  level: number;
  text: string;
  line: number;
  id: string;
}

function formatDate(isoOrEpoch: string | number | undefined): string {
  if (!isoOrEpoch) return '-';
  if (typeof isoOrEpoch === 'number') {
    const d = new Date(isoOrEpoch * 1000);
    return d.toLocaleString('zh-CN', { hour12: false }).slice(0, 16);
  }
  return isoOrEpoch.replace('T', ' ').slice(0, 16);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Split markdown content into line-tracked renderable segments so the target
 * [startLine, endLine] range is rendered in rich Markdown AND highlighted cleanly
 * in-place without forcing the user into raw source mode!
 */
function buildHighlightedMarkdownHtml(
  raw: string,
  highlight?: { startLine: number; endLine: number } | null
): string {
  if (!raw) return '';
  const lines = raw.split('\n');

  // Inject deterministic heading IDs for TOC navigation
  let headingCounter = 0;
  const parseMd = (mdText: string) => {
    const html = marked.parse(mdText, { async: false }) as string;
    return html.replace(/<h([1-4])>/g, (_, lvl) => `<h${lvl} id="kb-h-${headingCounter++}">`);
  };

  if (!highlight || highlight.startLine < 1 || highlight.startLine > lines.length) {
    return parseMd(raw);
  }

  // Expand slightly if highlight starts/ends inside a fenced code block
  let s = Math.max(1, highlight.startLine);
  let e = Math.min(lines.length, Math.max(s, highlight.endLine));

  // Count code fences before s to avoid splitting mid-fence
  let fenceCount = 0;
  for (let i = 0; i < s - 1; i++) {
    if (lines[i].trim().startsWith('```')) fenceCount++;
  }
  if (fenceCount % 2 === 1) {
    // Walk back to opening fence
    while (s > 1 && !lines[s - 1].trim().startsWith('```')) s--;
  }
  let innerFences = 0;
  for (let i = s - 1; i < e; i++) {
    if (lines[i].trim().startsWith('```')) innerFences++;
  }
  if (innerFences % 2 === 1) {
    while (e < lines.length && !lines[e - 1].trim().startsWith('```')) e++;
  }

  const before = lines.slice(0, s - 1).join('\n');
  const middle = lines.slice(s - 1, e).join('\n');
  const after = lines.slice(e).join('\n');

  const htmlBefore = before ? parseMd(before) : '';
  const htmlMiddle = middle
    ? `<div id="kb-render-hl" class="md-highlight-block">${parseMd(middle)}</div>`
    : '';
  const htmlAfter = after ? parseMd(after) : '';
  return `${htmlBefore}${htmlMiddle}${htmlAfter}`;
}

/**
 * Render non-text documents (.pdf, .pptx, .docx, .xlsx) from indexed chunks with
 * deterministic TOC anchors (#kb-h-i) and in-place amber highlight (#kb-render-hl)
 * on the matched chunkId or pageNum!
 */
function buildNonTextDocumentHtml(
  chunks: DocumentDetail['chunks'],
  highlight?: { startLine: number; endLine: number; pageNum?: number | null; chunkId?: number | null } | null
): string {
  if (!chunks || chunks.length === 0) return '';

  // Determine exact single primary chunk index to highlight and scroll to
  let hlIndex = -1;
  if (highlight) {
    if (highlight.chunkId != null) {
      hlIndex = chunks.findIndex((c) => c.id === highlight.chunkId);
    }
    if (hlIndex === -1 && highlight.pageNum != null) {
      hlIndex = chunks.findIndex((c) => c.page_num === highlight.pageNum);
    }
    if (hlIndex === -1 && highlight.startLine > 0) {
      hlIndex = chunks.findIndex(
        (c) => c.start_line <= highlight.startLine && c.end_line >= highlight.startLine
      );
    }
  }

  const parts: string[] = [];
  chunks.forEach((ch, idx) => {
    const label = ch.heading_path
      ? ch.heading_path
      : ch.page_num
        ? `第 ${ch.page_num} 页`
        : `片段 #${idx + 1}`;
    const safeLabel = label.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const bodyHtml = marked.parse(ch.content || '', { async: false }) as string;
    const isHl = idx === hlIndex;
    const blockInner = `<h3 id="kb-h-${idx}">${safeLabel}</h3>${bodyHtml}`;
    if (isHl) {
      parts.push(`<div id="kb-render-hl" class="md-highlight-block">${blockInner}</div>`);
    } else {
      parts.push(`<div class="nontext-chunk-block">${blockInner}</div>`);
    }
  });
  return parts.join('<hr/>');
}

export const DocPreview: React.FC<DocPreviewProps> = ({
  sourceId,
  relPath,
  highlightRange,
  sourceNameMap,
  onJumpToDoc,
  checkedDocKeys,
  onAddToFence,
  recentDocs,
  collections,
  onOpenCollection,
}) => {
  const [loading, setLoading] = useState(false);
  const [relatedDocs, setRelatedDocs] = useState<RelatedDocItem[]>([]);
  const [lineage, setLineage] = useState<DocumentLineageResponse | null>(null);
  const relatedRef = useRef<HTMLDivElement>(null);
  const lineageRef = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState<string>('');
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatchIdx, setFindMatchIdx] = useState(0);
  const [findMatchTotal, setFindMatchTotal] = useState(0);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const scrollBoxRef = useRef<HTMLDivElement | null>(null);
  const hlLineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const openFind = () => {
      setFindOpen(true);
      setTimeout(() => findInputRef.current?.focus(), 40);
    };
    (window as any).__kbOpenDocFind = openFind;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        openFind();
      } else if (e.key === 'Escape' && findOpen) {
        setFindOpen(false);
        setFindQuery('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      delete (window as any).__kbOpenDocFind;
      window.removeEventListener('keydown', onKey);
    };
  }, [findOpen]);

  useEffect(() => {
    if (!sourceId || !relPath) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .document(sourceId, relPath)
      .then((res) => {
        if (cancelled) return;
        setDetail(res);
        // Stay in clean editorial rendered mode for Markdown & office docs (rendered mode now highlights natively!)
        if (res.meta.ext === '.md' || !res.is_text) {
          setViewMode('rendered');
        } else {
          setViewMode('source');
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    setRelatedDocs([]);
    setLineage(null);
    api
      .relatedDocuments(sourceId, relPath, 5)
      .then((res) => {
        if (!cancelled) setRelatedDocs(res.items || []);
      })
      .catch(() => {});
    api
      .documentLineage(sourceId, relPath)
      .then((res) => {
        if (!cancelled) setLineage(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sourceId, relPath]);

  const tocHeadings = useMemo<TocHeading[]>(() => {
    if (!detail) return [];
    if (detail.meta.ext !== '.md') {
      return (detail.chunks || []).slice(0, 120).map((ch, idx) => ({
        level: 2,
        text: ch.heading_path || (ch.page_num ? `第 ${ch.page_num} 页` : `片段 #${idx + 1}`),
        line: ch.start_line || idx + 1,
        id: `kb-h-${idx}`,
      }));
    }
    if (!detail.raw_content) return [];
    const out: TocHeading[] = [];
    let inFence = false;
    let idx = 0;
    detail.raw_content.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('```')) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      const m = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
      if (m) {
        out.push({
          level: m[1].length,
          text: m[2].trim(),
          line: i + 1,
          id: `kb-h-${idx++}`,
        });
      }
    });
    return out;
  }, [detail]);

  const glanceTokens = useMemo(() => {
    const raw = detail?.raw_content || '';
    if (!raw || raw.length < 40) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    // Extract key quantitative metrics (days, %, money, versions) & ISO dates (0 Token!)
    const re = /(\d{4}-\d{2}-\d{2}|[vV]\d+(?:\.\d+)+|\d+(?:\.\d+)?\s*(?:%|天|周|个月|小时|分钟|万元|万|亿元|亿|元|人天|家|个仓|份))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const tok = m[1].replace(/\s+/g, '');
      if (tok.length >= 2 && !seen.has(tok)) {
        seen.add(tok);
        out.push(tok);
        if (out.length >= 10) break;
      }
    }
    return out;
  }, [detail?.raw_content]);

  const renderedHtml = useMemo(() => {
    if (!detail) return '';
    let html = detail.is_text
      ? buildHighlightedMarkdownHtml(detail.raw_content || '', highlightRange || null)
      : buildNonTextDocumentHtml(detail.chunks || [], highlightRange || null);
    const fq = findQuery.trim();
    if (findOpen && fq) {
      const escaped = fq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(${escaped})`, 'gi');
      // Only highlight text nodes outside HTML tags
      html = html.replace(/(<[^>]+>)|([^<]+)/g, (_, tag, text) => {
        if (tag) return tag;
        return text.replace(re, '<mark class="doc-find-hit">$1</mark>');
      });
    }
    return html;
  }, [
    detail,
    highlightRange?.startLine,
    highlightRange?.endLine,
    highlightRange?.pageNum,
    highlightRange?.chunkId,
    findOpen,
    findQuery,
  ]);

  // Track in-document find hits and scroll active hit into view
  useEffect(() => {
    if (!findOpen || !findQuery.trim()) {
      setFindMatchTotal(0);
      setFindMatchIdx(0);
      return;
    }
    const timer = setTimeout(() => {
      const nodes = scrollBoxRef.current?.querySelectorAll('mark.doc-find-hit');
      const count = nodes?.length || 0;
      setFindMatchTotal(count);
      if (nodes && count > 0) {
        const idx = Math.min(findMatchIdx, count - 1);
        nodes.forEach((n, i) => n.classList.toggle('is-active', i === idx));
        nodes[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [renderedHtml, findOpen, findQuery, findMatchIdx]);

  const sourceLines = useMemo(() => {
    if (!detail?.raw_content) return [];
    return detail.raw_content.split('\n');
  }, [detail?.raw_content]);

  // Smooth-scroll to highlighted block in BOTH rendered view and source view
  useEffect(() => {
    if (!detail) return;
    const timer = setTimeout(() => {
      if (viewMode === 'rendered') {
        const el = scrollBoxRef.current?.querySelector('#kb-render-hl');
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } else if (hlLineRef.current) {
        hlLineRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [detail, viewMode, highlightRange?.startLine, highlightRange?.endLine, highlightRange?.pageNum, highlightRange?.chunkId]);

  if (!sourceId || !relPath) {
    return (
      <div className="pane preview-pane">
        <div
          className="pane-scroll"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div className="empty-home-wrap">
            <div style={{ textAlign: 'center', marginBottom: 14 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
                星海拾卷 · 原文核对台
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>
                文件不必硬整理，拾起来就能问。点选左侧任意结果、卷宗或引用 [n] 即刻展开原文。
              </div>
            </div>

            {recentDocs && recentDocs.length > 0 && (
              <div className="empty-home-section">
                <div className="empty-home-title">
                  <ClockCircleOutlined style={{ marginRight: 5 }} />
                  最近阅读（一键续读）
                </div>
                {recentDocs.slice(0, 5).map((d) => (
                  <div
                    key={`${d.source_id}::${d.rel_path}`}
                    className="empty-home-row"
                    onClick={() => onJumpToDoc?.(d.source_id, d.rel_path, null)}
                  >
                    <Space size={6} style={{ minWidth: 0 }}>
                      <FileTextOutlined style={{ color: 'var(--text-muted)' }} />
                      <span
                        style={{
                          fontSize: 12.5,
                          fontWeight: 500,
                          color: 'var(--text-primary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {d.title}
                      </span>
                    </Space>
                    <span className="meta-pill-muted">{d.ext || d.source_id}</span>
                  </div>
                ))}
              </div>
            )}

            {collections && collections.length > 0 && (
              <div className="empty-home-section">
                <div className="empty-home-title">
                  <BookOutlined style={{ marginRight: 5 }} />
                  我的专题卷宗（点击整组拉入对比围栏）
                </div>
                {collections.slice(0, 4).map((col) => (
                  <div
                    key={col.id}
                    className="empty-home-row"
                    onClick={() => onOpenCollection?.(col)}
                  >
                    <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>
                      {col.name}
                    </span>
                    <span className="meta-pill-blue">{col.doc_count} 份文档</span>
                  </div>
                ))}
              </div>
            )}

            <div
              style={{
                marginTop: 22,
                paddingTop: 14,
                borderTop: '1px solid var(--border-hairline)',
                display: 'flex',
                justifyContent: 'center',
                gap: 16,
                flexWrap: 'wrap',
                fontSize: 11.5,
                color: 'var(--text-muted)',
              }}
            >
              {!isWindowsPlatform() && (
                <span>
                  <Typography.Text code>⌥Space</Typography.Text> 随时呼出
                </span>
              )}
              <span>
                <Typography.Text code>{modKeyLabel()}K</Typography.Text> 极速跳转
              </span>
              <span>
                <Typography.Text code>↑ ↓</Typography.Text> 步进预览
              </span>
              <span>
                <Typography.Text code>{modKeyLabel()}F</Typography.Text> 文档内查找
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const copyCitation = () => {
    if (!detail) return;
    const loc =
      highlightRange && detail.is_text
        ? `#L${highlightRange.startLine}-L${highlightRange.endLine}`
        : highlightRange?.pageNum
          ? `#page=${highlightRange.pageNum}`
          : '';
    navigator.clipboard.writeText(`${detail.meta.abs_path}${loc}`);
    message.success('已复制原文路径与位置');
  };

  const handleOpen = async (mode: 'default' | 'finder' | 'typora') => {
    if (!detail) return;
    const res = await api.openExternal(detail.meta.source_id, detail.meta.rel_path, mode);
    if (!res.ok) {
      message.warning(res.error || '打开外部应用失败');
    }
  };

  const jumpToHeading = (h: TocHeading) => {
    setTocOpen(false);
    if (viewMode === 'rendered') {
      const el = scrollBoxRef.current?.querySelector(`#${h.id}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      const el = scrollBoxRef.current?.querySelector(`[data-line="${h.line}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="pane preview-pane">
      <div className="pane-header preview-header">
        {detail ? (
          <>
            <div className="preview-meta-bar">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="preview-doc-title">{detail.meta.title}</div>
                <div className="preview-doc-path">
                  {sourceNameMap[detail.meta.source_id] || detail.meta.source_id} / {detail.meta.rel_path}
                </div>
              </div>
              <Space size={2} wrap>
                <Segmented
                  size="small"
                  value={viewMode}
                  onChange={(v) => setViewMode(v as 'rendered' | 'source')}
                  options={[
                    { label: '阅读', value: 'rendered' },
                    { label: detail.is_text ? '源码' : '文本', value: 'source' },
                  ]}
                />
                <Tooltip title={`页内查找 (${modKeyLabel()}F)`}>
                  <Button
                    size="small"
                    type="text"
                    icon={<SearchOutlined />}
                    onClick={() => {
                      setFindOpen((o) => !o);
                      setTimeout(() => findInputRef.current?.focus(), 40);
                    }}
                  />
                </Tooltip>
                {tocHeadings.length >= 2 && (
                  <Popover
                    open={tocOpen}
                    onOpenChange={setTocOpen}
                    trigger="click"
                    placement="bottomRight"
                    content={
                      <div style={{ width: 260, maxHeight: 360, overflowY: 'auto' }}>
                        {tocHeadings.map((h) => (
                          <div
                            key={h.id}
                            className="toc-item"
                            style={{ paddingLeft: (h.level - 1) * 12 + 6 }}
                            onClick={() => jumpToHeading(h)}
                          >
                            {h.text}
                          </div>
                        ))}
                      </div>
                    }
                  >
                    <Tooltip title="文档目录大纲">
                      <Button size="small" type="text" icon={<UnorderedListOutlined />} />
                    </Tooltip>
                  </Popover>
                )}
                <Tooltip title="复制原文路径（含命中行号）">
                  <Button size="small" type="text" icon={<CopyOutlined />} onClick={copyCitation} />
                </Tooltip>
                <Tooltip title={`在${fileManagerName()}中显示`}>
                  <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={() => handleOpen('finder')} />
                </Tooltip>
                <Tooltip title="用默认应用打开">
                  <Button size="small" type="text" icon={<ExportOutlined />} onClick={() => handleOpen('default')} />
                </Tooltip>
                {detail.git_history.length > 0 && (
                  <Tooltip title="Git 变更记录">
                    <Button size="small" type="text" icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)}>
                      {detail.git_history.length}
                    </Button>
                  </Tooltip>
                )}
              </Space>
            </div>

            {findOpen && (
              <div className="doc-find-bar">
                <SearchOutlined style={{ color: 'var(--text-muted)', fontSize: 12 }} />
                <input
                  ref={findInputRef}
                  className="doc-find-input"
                  placeholder="在当前文档中查找…"
                  value={findQuery}
                  onChange={(e) => {
                    setFindQuery(e.target.value);
                    setFindMatchIdx(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && findMatchTotal > 0) {
                      e.preventDefault();
                      setFindMatchIdx((i) =>
                        e.shiftKey ? (i - 1 + findMatchTotal) % findMatchTotal : (i + 1) % findMatchTotal
                      );
                    } else if (e.key === 'Escape') {
                      setFindOpen(false);
                      setFindQuery('');
                    }
                  }}
                />
                <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {findMatchTotal > 0 ? `${findMatchIdx + 1}/${findMatchTotal}` : findQuery ? '0 处' : ''}
                </span>
                <Button
                  size="small"
                  type="text"
                  icon={<UpOutlined />}
                  disabled={findMatchTotal === 0}
                  onClick={() => setFindMatchIdx((i) => (i - 1 + findMatchTotal) % findMatchTotal)}
                />
                <Button
                  size="small"
                  type="text"
                  icon={<DownOutlined />}
                  disabled={findMatchTotal === 0}
                  onClick={() => setFindMatchIdx((i) => (i + 1) % findMatchTotal)}
                />
                <Button
                  size="small"
                  type="text"
                  icon={<CloseOutlined />}
                  onClick={() => {
                    setFindOpen(false);
                    setFindQuery('');
                  }}
                />
              </div>
            )}

            <div className="preview-submeta">
              <span>{detail.meta.ext}</span>
              <span>·</span>
              <span>{formatBytes(detail.meta.size_bytes)}</span>
              {detail.meta.git_author && (
                <>
                  <span>·</span>
                  <span>写入：{detail.meta.git_author}</span>
                </>
              )}
              <span>·</span>
              <span>更新：{formatDate(detail.meta.git_date || detail.meta.mtime)}</span>
              {highlightRange && detail.is_text && (
                <span className="meta-pill-amber">
                  定位 L{highlightRange.startLine}–L{highlightRange.endLine}
                </span>
              )}
              {highlightRange?.pageNum && (
                <span className="meta-pill-amber">第 {highlightRange.pageNum} 页</span>
              )}
              {detail.meta.parse_note && (
                <span className="meta-pill-muted">{detail.meta.parse_note}</span>
              )}
              {lineage && (lineage.upstream.length > 0 || lineage.downstream.length > 0) && (
                <button
                  type="button"
                  className="related-jump-pill"
                  onClick={() => lineageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                >
                  <BranchesOutlined />
                  <span>
                    血缘 · 上游 {lineage.upstream.length} / 下游 {lineage.downstream.length}
                  </span>
                </button>
              )}
              {relatedDocs.length > 0 && (
                <button
                  type="button"
                  className="related-jump-pill"
                  onClick={() => relatedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                >
                  <NodeIndexOutlined />
                  <span>星海连脉 · {relatedDocs.length} 篇相关</span>
                </button>
              )}
            </div>
            {glanceTokens.length >= 2 && (
              <div className="doc-glance-bar">
                <span className="doc-glance-label">速览关键数字/日期（点击定位）：</span>
                {glanceTokens.map((tok) => (
                  <button
                    key={tok}
                    type="button"
                    className="doc-glance-chip"
                    onClick={() => {
                      setFindOpen(true);
                      setFindQuery(tok);
                      setFindMatchIdx(0);
                    }}
                  >
                    {tok}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <Typography.Text type="secondary">原文核对</Typography.Text>
        )}
      </div>

      <div className="pane-scroll preview-scroll" ref={scrollBoxRef}>
        {loading ? (
          <div style={{ padding: 48, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : error ? (
          <Empty description={`加载失败：${error}`} />
        ) : detail ? (
          <>
            {viewMode === 'rendered' ? (
              <div className="md-body" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
            ) : (
              <div className="source-lines">
                {sourceLines.map((line, idx) => {
                  const ln = idx + 1;
                  const isHl =
                    Boolean(highlightRange) &&
                    detail.is_text &&
                    ln >= (highlightRange?.startLine || 0) &&
                    ln <= (highlightRange?.endLine || 0);
                  const isAnchor = isHl && ln === highlightRange?.startLine;
                  return (
                    <div
                      key={ln}
                      data-line={ln}
                      ref={isAnchor ? hlLineRef : undefined}
                      className={`source-line${isHl ? ' hl' : ''}`}
                    >
                      <span className="source-lineno">{ln}</span>
                      <span className="source-text">{line || ' '}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* v1.6 文档血缘链路（上游来源 -> 本篇 -> 下游影响） */}
            {lineage && (lineage.upstream.length > 0 || lineage.downstream.length > 0) && (
              <div className="related-docs-section" ref={lineageRef}>
                <div className="related-docs-header">
                  <Space size={6}>
                    <BranchesOutlined style={{ color: 'var(--accent)' }} />
                    <span className="related-docs-title">文档血缘链路（上游来源 → 本篇 → 下游影响）</span>
                  </Space>
                  <span className="related-docs-sub">
                    显式链接引用 · 版本演进链 · 同项目时序上下游
                  </span>
                </div>
                <div className="lineage-3col">
                  <div className="lineage-col">
                    <div className="lineage-col-head">上游依据 / 前序版本 ({lineage.upstream.length})</div>
                    {lineage.upstream.length === 0 ? (
                      <div className="lineage-empty">本篇为源头文档</div>
                    ) : (
                      lineage.upstream.slice(0, 5).map((n) => (
                        <div
                          key={`up-${n.source_id}-${n.rel_path}`}
                          className="lineage-node-item"
                          onClick={() => onJumpToDoc?.(n.source_id, n.rel_path, null)}
                        >
                          <div className="lineage-node-title">{n.title}</div>
                          <div className="lineage-node-meta">
                            <Tag
                              bordered={false}
                              color={
                                n.edge_type === 'explicit'
                                  ? 'blue'
                                  : n.edge_type === 'version'
                                    ? 'gold'
                                    : 'green'
                              }
                              style={{ margin: 0, fontSize: 10.5 }}
                            >
                              {n.edge_label}
                            </Tag>
                            <span>{n.stage_label}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="lineage-center-col">
                    <ArrowRightOutlined style={{ color: 'var(--text-muted)', fontSize: 12 }} />
                    <div className="lineage-current-box">
                      <Tag color="blue" style={{ marginBottom: 4 }}>
                        {lineage.current?.stage_label || '当前文档'}
                      </Tag>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                        {detail.meta.title}
                      </div>
                    </div>
                    <ArrowRightOutlined style={{ color: 'var(--text-muted)', fontSize: 12 }} />
                  </div>

                  <div className="lineage-col">
                    <div className="lineage-col-head">下游衍生 / 引用者 ({lineage.downstream.length})</div>
                    {lineage.downstream.length === 0 ? (
                      <div className="lineage-empty">暂无下游衍生文档</div>
                    ) : (
                      lineage.downstream.slice(0, 5).map((n) => (
                        <div
                          key={`dn-${n.source_id}-${n.rel_path}`}
                          className="lineage-node-item"
                          onClick={() => onJumpToDoc?.(n.source_id, n.rel_path, null)}
                        >
                          <div className="lineage-node-title">{n.title}</div>
                          <div className="lineage-node-meta">
                            <Tag
                              bordered={false}
                              color={
                                n.edge_type === 'explicit'
                                  ? 'blue'
                                  : n.edge_type === 'version'
                                    ? 'gold'
                                    : 'green'
                              }
                              style={{ margin: 0, fontSize: 10.5 }}
                            >
                              {n.edge_label}
                            </Tag>
                            <span>{n.stage_label}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 星海连脉：0-Token Local Semantic Related Documents */}
            {relatedDocs.length > 0 && (
              <div className="related-docs-section" ref={relatedRef}>
                <div className="related-docs-header">
                  <Space size={6}>
                    <NodeIndexOutlined style={{ color: 'var(--accent)' }} />
                    <span className="related-docs-title">星海连脉 · 跨目录相关文档</span>
                  </Space>
                  <span className="related-docs-sub">本地语义自动发现 · 可一键拉入围栏跨文件对比</span>
                </div>
                <div className="related-docs-list">
                  {relatedDocs.map((rd) => {
                    const key = `${rd.source_id}::${rd.rel_path}`;
                    const inFence = Boolean(checkedDocKeys?.has(key));
                    return (
                      <div
                        key={key}
                        className="related-doc-card"
                        onClick={() =>
                          onJumpToDoc?.(rd.source_id, rd.rel_path, {
                            startLine: rd.best_start_line,
                            endLine: rd.best_end_line,
                            pageNum: rd.best_page_num,
                          })
                        }
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="related-doc-top">
                            <span className="related-doc-name">{rd.title}</span>
                            <span className="meta-pill-blue">{Math.round(rd.similarity * 100)}% 相似</span>
                            <span className="meta-pill-muted">{rd.ext}</span>
                          </div>
                          <div className="related-doc-path">
                            {sourceNameMap[rd.source_id] || rd.source_id} / {rd.rel_path}
                            {rd.best_page_num ? ` · 第 ${rd.best_page_num} 页` : ''}
                          </div>
                        </div>
                        {onAddToFence && (
                          <Tooltip
                            title={
                              inFence
                                ? '已在 AI 对比围栏中'
                                : '将当前文档与这篇相关文档一起加入 AI 对比围栏'
                            }
                          >
                            <Button
                              size="small"
                              type={inFence ? 'default' : 'text'}
                              icon={inFence ? <CheckOutlined /> : <PlusOutlined />}
                              onClick={(e) => {
                                e.stopPropagation();
                                onAddToFence([
                                  {
                                    source_id: detail.meta.source_id,
                                    rel_path: detail.meta.rel_path,
                                    title: detail.meta.title,
                                  },
                                  {
                                    source_id: rd.source_id,
                                    rel_path: rd.rel_path,
                                    title: rd.title,
                                  },
                                ]);
                              }}
                            >
                              {inFence ? '已在围栏' : '拉入对比'}
                            </Button>
                          </Tooltip>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>

      <Drawer
        title={`文件提交历史 · ${detail?.meta.rel_path || ''}`}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        width={480}
      >
        {detail?.git_history.map((h) => (
          <div key={h.hash} style={{ padding: '10px 0', borderBottom: '1px solid #f0f0f0' }}>
            <Space size={6}>
              <Tag bordered={false}>{h.hash}</Tag>
              <Tag bordered={false}>{h.author}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatDate(h.date)}
              </Typography.Text>
            </Space>
            <div style={{ marginTop: 4, fontSize: 13 }}>{h.message}</div>
          </div>
        ))}
      </Drawer>
    </div>
  );
};

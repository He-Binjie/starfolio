import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Dropdown,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Popover,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  BookOutlined,
  CloseOutlined,
  CopyOutlined,
  DeleteOutlined,
  FileAddOutlined,
  FilterOutlined,
  FolderAddOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  RobotOutlined,
  SearchOutlined,
  SendOutlined,
  SwapOutlined,
  TableOutlined,
} from '@ant-design/icons';
import {
  api,
  CollectionItem,
  MetaResponse,
  QaEvidenceItem,
  QaRecord,
  SearchHit,
  SearchMode,
  TreeNode,
} from '../api';
import { DocPreview } from './DocPreview';
import { SidebarTree } from './SidebarTree';
import { CompareTarget } from './CompareModal';
import { FactMatrixModal } from './FactMatrixModal';
import { isNativeMac, modKeyLabel, triggerPathPicker } from '../platform';

interface UnifiedWorkspaceProps {
  meta: MetaResponse | null;
  externalTarget?: {
    sourceId: string;
    relPath: string;
    highlight?: { startLine: number; endLine: number } | null;
  } | null;
  onClearExternalTarget?: () => void;
  externalFenceDocs?: Array<{ source_id: string; rel_path: string; title: string }> | null;
  onClearExternalFenceDocs?: () => void;
  onOpenCompare?: (target: CompareTarget) => void;
  onOpenSettings?: () => void;
  onOpenGuide?: () => void;
}

function formatShortDate(isoOrEpoch: string | number | undefined): string {
  if (!isoOrEpoch) return '';
  if (typeof isoOrEpoch === 'number') {
    const d = new Date(isoOrEpoch * 1000);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return isoOrEpoch.slice(5, 10);
}

function filterTreeNodes(nodes: TreeNode[], keyword: string): TreeNode[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return nodes;
  const out: TreeNode[] = [];
  for (const n of nodes) {
    const matchedSelf =
      n.title.toLowerCase().includes(kw) || (n.rel_path || '').toLowerCase().includes(kw);
    const filteredChildren = n.children ? filterTreeNodes(n.children, kw) : [];
    if (matchedSelf || filteredChildren.length > 0) {
      out.push({ ...n, children: matchedSelf ? n.children : filteredChildren });
    }
  }
  return out;
}

export const UnifiedWorkspace: React.FC<UnifiedWorkspaceProps> = ({
  meta,
  externalTarget,
  onClearExternalTarget,
  externalFenceDocs,
  onClearExternalFenceDocs,
  onOpenCompare,
  onOpenSettings,
  onOpenGuide,
}) => {
  // Collapsible + draggable split panes
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<'tree' | 'collections' | 'history'>('tree');
  const [sidebarWidth, setSidebarWidth] = useState(258);
  const [centerWidth, setCenterWidth] = useState(490);
  const draggingRef = useRef<'left' | 'right' | null>(null);

  // Virtual Collections ('卷宗夹') & 0-Token Fact Matrix & Recent Docs
  const [collections, setCollections] = useState<CollectionItem[]>([]);
  const [saveColOpen, setSaveColOpen] = useState(false);
  const [newColName, setNewColName] = useState('');
  const [factMatrixDocs, setFactMatrixDocs] = useState<Array<{ source_id: string; rel_path: string; title: string }> | null>(null);
  const [recentDocs, setRecentDocs] = useState<Array<{ source_id: string; rel_path: string; title: string; ext?: string }>>(() => {
    try {
      return JSON.parse(localStorage.getItem('kb_recent_docs') || '[]');
    } catch {
      return [];
    }
  });

  // Tree state
  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const [treeFilter, setTreeFilter] = useState('');
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [selectedTreeKey, setSelectedTreeKey] = useState<string | null>(null);
  const [activeHitIdx, setActiveHitIdx] = useState<number>(-1);

  // Search state
  const [query, setQuery] = useState('');
  const [searchModeChoice, setSearchModeChoice] = useState<SearchMode>('hybrid');
  const [sourceId, setSourceId] = useState<string>('all');
  const [project, setProject] = useState<string>('all');
  const [ext, setExt] = useState<string>('all');
  const [days, setDays] = useState<number | undefined>(undefined);
  const [includeHistorical, setIncludeHistorical] = useState<boolean>(false);

  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [totalHits, setTotalHits] = useState(0);
  const [effectiveMode, setEffectiveMode] = useState<'hybrid' | 'fts' | 'semantic' | 'recent'>('recent');

  // NotebookLM-style explicit checked documents for source grounding
  const [checkedDocs, setCheckedDocs] = useState<Record<string, { source_id: string; rel_path: string; title: string }>>({});
  // Document-level search hit grouping (dedup long doc multi-hits by default)
  const [groupByDoc, setGroupByDoc] = useState<boolean>(true);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  // Grounded AI Synthesis state (Perplexity + NotebookLM)
  const engines = meta?.qa_engines || [];
  const defaultEngine = engines.find((e) => e.is_default)?.id || engines[0]?.id || 'agy-fast';
  const [engineId, setEngineId] = useState<string>(defaultEngine);
  const [qaOpen, setQaOpen] = useState<boolean>(false);
  const [asking, setAsking] = useState<boolean>(false);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [sessionTurns, setSessionTurns] = useState<QaRecord[]>([]);
  const [followUpInput, setFollowUpInput] = useState<string>('');
  const [qaHistory, setQaHistory] = useState<QaRecord[]>([]);

  // Right-pane Preview state
  const [selectedDoc, setSelectedDoc] = useState<{
    sourceId: string;
    relPath: string;
    chunkId: number | null;
    highlight?: { startLine: number; endLine: number; pageNum?: number | null } | null;
  } | null>(null);

  useEffect(() => {
    if (defaultEngine && !engines.some((e) => e.id === engineId)) {
      setEngineId(defaultEngine);
    }
  }, [defaultEngine]);

  useEffect(() => {
    api
      .tree()
      .then((nodes) => {
        setTreeData(nodes);
        setExpandedKeys((prev) => {
          const next = new Set(prev);
          nodes.slice(0, 3).forEach((n) => next.add(n.key));
          return next;
        });
      })
      .catch(() => {});
  }, [meta?.index_status.totals.documents, meta?.sources.length]);

  const loadCollections = () => {
    api.collections().then(setCollections).catch(() => {});
  };

  useEffect(() => {
    api.qaHistory().then(setQaHistory).catch(() => {});
    loadCollections();
  }, []);

  const recordRecentDoc = (source_id: string, rel_path: string, title?: string, ext?: string) => {
    setRecentDocs((prev) => {
      const next = [
        { source_id, rel_path, title: title || rel_path.split('/').pop() || rel_path, ext },
        ...prev.filter((d) => !(d.source_id === source_id && d.rel_path === rel_path)),
      ].slice(0, 8);
      try {
        localStorage.setItem('kb_recent_docs', JSON.stringify(next));
      } catch {
        // ignore quota errors
      }
      return next;
    });
  };

  const applyCollection = (col: CollectionItem) => {
    if (!col.docs || col.docs.length === 0) return;
    const next: Record<string, { source_id: string; rel_path: string; title: string }> = {};
    col.docs.forEach((d) => {
      next[`${d.source_id}::${d.rel_path}`] = d;
    });
    setCheckedDocs(next);
    setSelectedDoc({
      sourceId: col.docs[0].source_id,
      relPath: col.docs[0].rel_path,
      chunkId: null,
      highlight: null,
    });
    message.success(`已载入卷宗「${col.name}」（${col.docs.length} 份文档已就位）`);
  };

  const handleSaveCollection = async () => {
    const nm = newColName.trim();
    if (!nm || checkedList.length === 0) return;
    try {
      await api.createCollection({ name: nm, docs: checkedList });
      setNewColName('');
      setSaveColOpen(false);
      loadCollections();
      message.success(`已保存卷宗「${nm}」（不改动磁盘任何文件）`);
    } catch (err) {
      message.error(String(err));
    }
  };

  useEffect(() => {
    if (externalTarget) {
      setSelectedDoc({
        sourceId: externalTarget.sourceId,
        relPath: externalTarget.relPath,
        chunkId: null,
        highlight: externalTarget.highlight || null,
      });
      onClearExternalTarget?.();
    }
  }, [externalTarget]);

  useEffect(() => {
    if (externalFenceDocs && externalFenceDocs.length > 0) {
      const next: Record<string, { source_id: string; rel_path: string; title: string }> = {};
      externalFenceDocs.forEach((d) => {
        next[`${d.source_id}::${d.rel_path}`] = d;
      });
      setCheckedDocs(next);
      setSelectedDoc({
        sourceId: externalFenceDocs[0].source_id,
        relPath: externalFenceDocs[0].rel_path,
        chunkId: null,
        highlight: null,
      });
      onClearExternalFenceDocs?.();
    }
  }, [externalFenceDocs]);

  // Drag resizers
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      if (draggingRef.current === 'left') {
        setSidebarWidth(Math.max(190, Math.min(380, e.clientX)));
      } else if (draggingRef.current === 'right') {
        const leftOffset = sidebarOpen ? sidebarWidth : 0;
        const maxCenter = Math.max(380, window.innerWidth - leftOffset - 360);
        setCenterWidth(Math.max(360, Math.min(maxCenter, e.clientX - leftOffset)));
      }
    };
    const onUp = () => {
      draggingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [sidebarOpen, sidebarWidth]);

  useEffect(() => {
    if (!asking) return;
    setElapsedSec(0);
    const t = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [asking]);

  // Debounced instant 0-token hybrid search
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearching(true);
      api
        .search({
          q: query,
          source_id: sourceId,
          project,
          ext,
          days,
          mode: searchModeChoice,
          include_historical: includeHistorical,
          limit: 60,
        })
        .then((res) => {
          setHits(res.items);
          setTotalHits(res.total);
          setEffectiveMode(res.mode);
        })
        .catch(() => {})
        .finally(() => setSearching(false));
    }, 180);
    return () => clearTimeout(timer);
  }, [
    query,
    searchModeChoice,
    sourceId,
    project,
    ext,
    days,
    includeHistorical,
    meta?.index_status.totals.chunks,
  ]);

  const sourceNameMap = useMemo(() => {
    const m: Record<string, string> = {};
    meta?.sources.forEach((s) => {
      m[s.id] = s.name;
    });
    return m;
  }, [meta]);

  const projectOptions = useMemo(() => {
    const list = (meta?.projects || []).filter(
      (p) => sourceId === 'all' || p.source_id === sourceId
    );
    const seen = new Set<string>();
    const opts = [{ label: '全部项目', value: 'all' }];
    for (const p of list) {
      if (!seen.has(p.project)) {
        seen.add(p.project);
        opts.push({ label: `${p.project} (${p.doc_count})`, value: p.project });
      }
    }
    return opts;
  }, [meta, sourceId]);

  useEffect(() => {
    const toggle = () => setSidebarOpen((o) => !o);
    (window as any).__kbToggleSidebar = toggle;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      delete (window as any).__kbToggleSidebar;
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const filteredTree = useMemo(
    () => filterTreeNodes(treeData, treeFilter),
    [treeData, treeFilter]
  );

  const checkedList = Object.values(checkedDocs);
  const activeQa = sessionTurns.length > 0 ? sessionTurns[sessionTurns.length - 1] : null;
  const selectedEngineObj = engines.find((e) => e.id === engineId);

  const displayRows = useMemo(() => {
    if (!groupByDoc || effectiveMode === 'recent') {
      return hits.map((hit) => ({
        docKey: `${hit.source_id}::${hit.rel_path}`,
        primary: hit,
        extras: [] as SearchHit[],
      }));
    }
    const map = new Map<string, { docKey: string; primary: SearchHit; extras: SearchHit[] }>();
    for (const hit of hits) {
      const dk = `${hit.source_id}::${hit.rel_path}`;
      const existing = map.get(dk);
      if (!existing) {
        map.set(dk, { docKey: dk, primary: hit, extras: [] });
      } else {
        existing.extras.push(hit);
      }
    }
    return Array.from(map.values());
  }, [hits, groupByDoc, effectiveMode]);

  const openHit = (hit: SearchHit, rowIdx?: number) => {
    if (rowIdx !== undefined) setActiveHitIdx(rowIdx);
    recordRecentDoc(hit.source_id, hit.rel_path, hit.title, hit.ext);
    setSelectedDoc({
      sourceId: hit.source_id,
      relPath: hit.rel_path,
      chunkId: hit.chunk_id,
      highlight:
        hit.chunk_id !== null
          ? { startLine: hit.start_line, endLine: hit.end_line, pageNum: hit.page_num }
          : null,
    });
  };

  const copyCitedBrief = (qa: QaRecord) => {
    const refs = qa.evidence
      .map((ev) => {
        const loc = ev.page_num ? `第 ${ev.page_num} 页` : `L${ev.start_line}-L${ev.end_line}`;
        return `[${ev.ref}] ${ev.title}（${ev.rel_path} · ${loc}）`;
      })
      .join('\n');
    const text = `【星海拾卷 · 核对简报】\n问题：${qa.question}\n\n${qa.answer}\n\n---\n参考出处：\n${refs}`;
    navigator.clipboard.writeText(text);
    message.success('已复制带完整出处清单的简报，可直接粘贴到飞书或文档');
  };

  const handleToggleExpand = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleTreeSelectNode = (node: TreeNode) => {
    setSelectedTreeKey(node.key);
    const key = node.key;
    if (key.startsWith('file::') && node.rel_path) {
      setSelectedDoc({ sourceId: node.source_id, relPath: node.rel_path, chunkId: null, highlight: null });
    } else if (key.startsWith('source::')) {
      setSourceId(node.source_id);
      setProject('all');
    } else if (key.startsWith('dir::')) {
      const [, sid, ...rest] = key.split('::');
      setSourceId(sid);
      setProject(rest.join('::').split('/')[0] || 'all');
    }
  };

  const selectHitAt = (idx: number) => {
    const row = displayRows[idx];
    if (!row) return;
    openHit(row.primary, idx);
  };

  const toggleCheckDoc = (hit: SearchHit, checked: boolean) => {
    const key = `${hit.source_id}::${hit.rel_path}`;
    setCheckedDocs((prev) => {
      const next = { ...prev };
      if (checked) {
        if (Object.keys(next).length >= 8) {
          message.warning('单次最多勾选 8 份文档作为围栏');
          return prev;
        }
        next[key] = { source_id: hit.source_id, rel_path: hit.rel_path, title: hit.title };
      } else {
        delete next[key];
      }
      return next;
    });
  };

  const openEvidence = (ev: QaEvidenceItem) => {
    setSelectedDoc({
      sourceId: ev.source_id,
      relPath: ev.rel_path,
      chunkId: ev.chunk_id,
      highlight: {
        startLine: ev.start_line,
        endLine: ev.end_line,
        pageNum: ev.page_num,
      },
    });
  };

  const runGroundedAsk = async (questionText: string, isFollowUp: boolean) => {
    const qText = questionText.trim();
    if (!qText || asking) {
      if (!qText) message.info('先输入一个问题或关键词，再点击「问 AI」');
      return;
    }

    setQaOpen(true);
    setAsking(true);
    try {
      const priorTurns = isFollowUp
        ? sessionTurns.map((t) => ({ question: t.question, answer: t.answer }))
        : [];
      const rec = await api.qaAsk({
        question: qText,
        engine_id: engineId,
        source_id: sourceId,
        project,
        top_k: 10,
        include_historical: includeHistorical,
        selected_docs: checkedList.length > 0 ? checkedList.map((d) => ({ source_id: d.source_id, rel_path: d.rel_path })) : undefined,
        conversation_turns: priorTurns.length > 0 ? priorTurns : undefined,
      });

      setSessionTurns((prev) => (isFollowUp ? [...prev, rec] : [rec]));
      setQaHistory((prev) => [rec, ...prev.filter((x) => x.id !== rec.id)]);
      if (isFollowUp) setFollowUpInput('');

      if (rec.evidence.length > 0) {
        const firstRef = rec.audit?.cited_refs?.[0] || 1;
        const targetEv = rec.evidence.find((e) => e.ref === firstRef) || rec.evidence[0];
        openEvidence(targetEv);
      }
      if (rec.status === 'error') {
        message.error(rec.error || '问答调用失败');
      }
    } catch (err) {
      message.error(`请求失败：${String(err)}`);
    } finally {
      setAsking(false);
    }
  };

  const renderInlineAndCitations = (rec: QaRecord) => {
    const evByRef = new Map<number, QaEvidenceItem>();
    rec.evidence.forEach((e) => evByRef.set(e.ref, e));
    const uncitedSet = new Set(rec.audit?.uncited_lines || []);

    const renderInlineText = (segment: string, keyPrefix: string) => {
      const pieces: React.ReactNode[] = [];
      const inlineRe = /(\*\*[^*]+\*\*|`[^`]+`)/g;
      let pos = 0;
      let im: RegExpExecArray | null;
      let k = 0;
      while ((im = inlineRe.exec(segment)) !== null) {
        if (im.index > pos) pieces.push(segment.slice(pos, im.index));
        const tok = im[1];
        if (tok.startsWith('**')) {
          pieces.push(<strong key={`${keyPrefix}-b-${k++}`}>{tok.slice(2, -2)}</strong>);
        } else {
          pieces.push(
            <code
              key={`${keyPrefix}-c-${k++}`}
              style={{ background: 'var(--bg-code)', padding: '1px 4px', borderRadius: 3, fontSize: 12 }}
            >
              {tok.slice(1, -1)}
            </code>
          );
        }
        pos = inlineRe.lastIndex;
      }
      if (pos < segment.length) pieces.push(segment.slice(pos));
      return pieces;
    };

    return (
      <div className="ai-synthesis-body">
        {rec.answer.split('\n').map((rawLine, lineIdx) => {
          const trimmed = rawLine.trim();
          if (!trimmed) return <div key={lineIdx} style={{ height: 6 }} />;

          const isUncited = uncitedSet.has(trimmed.slice(0, 140));
          const isHeading = trimmed.startsWith('#');
          const displayLine = isHeading ? trimmed.replace(/^#+\s*/, '') : rawLine;

          const parts: React.ReactNode[] = [];
          const regex = /\[(\d+(?:\s*[,，]\s*\d+)*)\]/g;
          let lastIdx = 0;
          let m: RegExpExecArray | null;
          while ((m = regex.exec(displayLine)) !== null) {
            if (m.index > lastIdx) {
              parts.push(...renderInlineText(displayLine.slice(lastIdx, m.index), `${lineIdx}-${lastIdx}`));
            }
            const nums = m[1]
              .split(/[,，]/)
              .map((s) => parseInt(s.trim(), 10))
              .filter((n) => !Number.isNaN(n));
            nums.forEach((n, j) => {
              const ev = evByRef.get(n);
              if (ev) {
                const loc = ev.page_num ? `第${ev.page_num}页` : `L${ev.start_line}–L${ev.end_line}`;
                parts.push(
                  <Popover
                    key={`${lineIdx}-${m!.index}-${j}`}
                    trigger="hover"
                    mouseEnterDelay={0.12}
                    placement="top"
                    content={
                      <div className="cite-popover">
                        <div className="cite-popover-title">
                          [{n}] {ev.title}
                        </div>
                        <div className="cite-popover-path">
                          {ev.source_id} / {ev.rel_path} · {loc}
                        </div>
                        <div className="cite-popover-body">
                          {ev.content.slice(0, 320)}
                          {ev.content.length > 320 ? '…' : ''}
                        </div>
                        <div style={{ marginTop: 8, textAlign: 'right' }}>
                          <Button size="small" type="link" style={{ padding: 0 }} onClick={() => openEvidence(ev)}>
                            在右侧定位全文 →
                          </Button>
                        </div>
                      </div>
                    }
                  >
                    <button type="button" className="cite-chip" onClick={() => openEvidence(ev)}>
                      [{n}]
                    </button>
                  </Popover>
                );
              } else {
                parts.push(
                  <span key={`${lineIdx}-${m!.index}-${j}`} className="meta-pill-muted">
                    [{n}]
                  </span>
                );
              }
            });
            lastIdx = regex.lastIndex;
          }
          if (lastIdx < displayLine.length) {
            parts.push(...renderInlineText(displayLine.slice(lastIdx), `${lineIdx}-tail`));
          }

          return (
            <div
              key={lineIdx}
              className={
                isHeading ? 'qa-line-heading' : isUncited ? 'qa-line qa-line-uncited' : 'qa-line'
              }
            >
              <span>{parts}</span>
              {isUncited && (
                <span className="meta-pill-muted" style={{ marginLeft: 6 }}>
                  未引用
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="unified-workspace">
      {/* Left Collapsible Sidebar: Tree + QA History */}
      {sidebarOpen && (
        <>
          <div className="pane sidebar-pane" style={{ width: sidebarWidth }}>
            <div className="pane-header" style={{ padding: '8px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 8 }}>
                <Segmented
                  size="small"
                  block
                  style={{ flex: 1 }}
                  value={sidebarTab}
                  onChange={(v) => setSidebarTab(v as 'tree' | 'collections' | 'history')}
                  options={[
                    { label: '目录', value: 'tree' },
                    { label: `卷宗 (${collections.length})`, value: 'collections' },
                    { label: `问答 (${qaHistory.length})`, value: 'history' },
                  ]}
                />
                <Tooltip title="收起侧边栏">
                  <Button
                    size="small"
                    type="text"
                    icon={<MenuFoldOutlined />}
                    onClick={() => setSidebarOpen(false)}
                  />
                </Tooltip>
              </div>
              {sidebarTab === 'tree' && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Input
                    size="small"
                    allowClear
                    style={{ flex: 1 }}
                    placeholder="过滤目录或文件名…"
                    prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
                    value={treeFilter}
                    onChange={(e) => setTreeFilter(e.target.value)}
                  />
                  {isNativeMac() ? (
                    <Tooltip title="纯本地只读拾取：可直接多选零散文件（PDF/Word/PPT/HTML/MD）或整个文件夹">
                      <Button
                        size="small"
                        type="default"
                        onClick={() => {
                          triggerPathPicker('any');
                        }}
                      >
                        + 拾取
                      </Button>
                    </Tooltip>
                  ) : (
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: [
                          {
                            key: 'files',
                            icon: <FileAddOutlined />,
                            label: '选择零散文件（可多选）',
                            onClick: async () => {
                              const st = await triggerPathPicker('files');
                              if (st === 'fallback_manual') onOpenSettings?.();
                            },
                          },
                          {
                            key: 'folder',
                            icon: <FolderAddOutlined />,
                            label: '选择本地文件夹',
                            onClick: async () => {
                              const st = await triggerPathPicker('folder');
                              if (st === 'fallback_manual') onOpenSettings?.();
                            },
                          },
                        ],
                      }}
                    >
                      <Tooltip title="纯本地只读拾取：可选零散文件（PDF/Word/PPT/HTML/MD）或整个文件夹">
                        <Button size="small" type="default">
                          + 拾取
                        </Button>
                      </Tooltip>
                    </Dropdown>
                  )}
                </div>
              )}
            </div>
            <div className="pane-scroll" style={{ padding: '6px 6px' }}>
              {sidebarTab === 'tree' ? (
                filteredTree.length > 0 ? (
                  <SidebarTree
                    nodes={filteredTree}
                    expandedKeys={expandedKeys}
                    selectedKey={selectedTreeKey}
                    onToggleExpand={handleToggleExpand}
                    onSelect={handleTreeSelectNode}
                  />
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无目录" />
                )
              ) : sidebarTab === 'collections' ? (
                collections.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="勾选文档后点击「存为卷宗」，即可不改目录随时复查整组文档"
                  />
                ) : (
                  collections.map((col) => (
                    <div
                      key={col.id}
                      className="result-row"
                      style={{ padding: '8px 8px', alignItems: 'center' }}
                      onClick={() => applyCollection(col)}
                    >
                      <BookOutlined style={{ color: 'var(--accent)', fontSize: 13 }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="result-title" style={{ fontSize: 12.5, fontWeight: 500 }}>
                          {col.name}
                        </div>
                        <div className="result-subline">
                          <span>{col.doc_count} 份文档</span>
                          <span>· {col.updated_at.slice(5, 10)}</span>
                        </div>
                      </div>
                      <span onClick={(e) => e.stopPropagation()}>
                        <Popconfirm
                          title="删除此虚拟卷宗？"
                          description="仅移除收藏分组，磁盘原文件不受影响。"
                          onConfirm={async () => {
                            await api.deleteCollection(col.id);
                            loadCollections();
                            message.info('已移除卷宗');
                          }}
                        >
                          <Button size="small" type="text" icon={<DeleteOutlined />} />
                        </Popconfirm>
                      </span>
                    </div>
                  ))
                )
              ) : qaHistory.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无本地问答记录" />
              ) : (
                qaHistory.map((h) => (
                  <div
                    key={h.id ?? h.question}
                    className={`result-row${activeQa?.id === h.id && qaOpen ? ' selected' : ''}`}
                    style={{ padding: '8px 8px' }}
                    onClick={() => {
                      setSessionTurns([h]);
                      setQaOpen(true);
                      if (h.evidence[0]) openEvidence(h.evidence[0]);
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="result-title" style={{ fontSize: 12.5, fontWeight: 500 }}>
                        {h.question}
                      </div>
                      <div className="result-subline">
                        <span>{h.engine_id}</span>
                        <span>·</span>
                        <span>{h.source_id === 'all' ? '全库' : h.source_id}</span>
                        {h.duration_ms > 0 && <span>· {(h.duration_ms / 1000).toFixed(1)}s</span>}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          <div
            className="resizer-handle"
            onMouseDown={() => {
              draggingRef.current = 'left';
              document.body.style.cursor = 'col-resize';
              document.body.style.userSelect = 'none';
            }}
          />
        </>
      )}

      {/* Center Pane: Unified Search + Grounded AI Synthesis */}
      <div className="pane center-pane" style={{ width: centerWidth }}>
        <div className="pane-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {!sidebarOpen && (
              <Tooltip title="展开目录与问答史">
                <Button size="small" type="text" icon={<MenuUnfoldOutlined />} onClick={() => setSidebarOpen(true)} />
              </Tooltip>
            )}
            <div className="omni-shell" style={{ flex: 1 }}>
              <SearchOutlined style={{ color: 'var(--text-muted)', fontSize: 13 }} />
              <input
                className="omni-input"
                placeholder={`搜资料（↑↓ 浏览）或输入问题按 ${modKeyLabel()}↵ 问 AI…`}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveHitIdx(-1);
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    runGroundedAsk(query, false);
                  } else if (e.key === 'ArrowDown' && displayRows.length > 0) {
                    e.preventDefault();
                    selectHitAt(Math.min(displayRows.length - 1, activeHitIdx + 1));
                  } else if (e.key === 'ArrowUp' && displayRows.length > 0) {
                    e.preventDefault();
                    selectHitAt(Math.max(0, activeHitIdx - 1));
                  }
                }}
              />
              {query && (
                <button
                  type="button"
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: '0 4px',
                    fontSize: 11,
                  }}
                  onClick={() => setQuery('')}
                >
                  <CloseOutlined />
                </button>
              )}
              <Tooltip title={`基于当前范围或勾选文档进行带出处问答（${modKeyLabel()}↵）`}>
                <button
                  type="button"
                  className="ask-ai-pill"
                  disabled={asking}
                  onClick={() => runGroundedAsk(query, false)}
                >
                  <RobotOutlined />
                  <span>{asking ? '思考中' : '问 AI'}</span>
                </button>
              </Tooltip>
            </div>
          </div>

          <div className="compact-scope-row">
            <Space size={5} wrap>
              <Select
                size="small"
                variant="filled"
                style={{ width: 122 }}
                value={sourceId}
                onChange={(v) => {
                  setSourceId(v);
                  setProject('all');
                }}
                options={[
                  { label: '全部知识源', value: 'all' },
                  ...(meta?.sources || []).map((s) => ({ label: s.name, value: s.id })),
                ]}
              />
              <Select
                size="small"
                variant="filled"
                showSearch
                style={{ width: 118 }}
                value={project}
                onChange={setProject}
                options={projectOptions}
              />
              <Popover
                trigger="click"
                placement="bottomLeft"
                content={
                  <div style={{ width: 220, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 4 }}>文件格式</div>
                      <Select
                        size="small"
                        style={{ width: '100%' }}
                        value={ext}
                        onChange={setExt}
                        options={[
                          { label: '全部格式', value: 'all' },
                          { label: '.md Markdown', value: '.md' },
                          { label: '.pdf 文档', value: '.pdf' },
                          { label: '.docx Word', value: '.docx' },
                          { label: '.pptx 演示文稿', value: '.pptx' },
                          { label: '.xlsx 表格', value: '.xlsx' },
                          { label: '.txt 文本', value: '.txt' },
                        ]}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 4 }}>更新时间</div>
                      <Select
                        size="small"
                        style={{ width: '100%' }}
                        value={days || 0}
                        onChange={(v) => setDays(v === 0 ? undefined : v)}
                        options={[
                          { label: '全部时间', value: 0 },
                          { label: '近 7 天', value: 7 },
                          { label: '近 30 天', value: 30 },
                          { label: '近 90 天', value: 90 },
                        ]}
                      />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12 }}>包含历史/快照文档</span>
                      <Switch size="small" checked={includeHistorical} onChange={setIncludeHistorical} />
                    </div>
                  </div>
                }
              >
                <button
                  type="button"
                  className={`chip-btn${ext !== 'all' || days || includeHistorical ? ' active' : ''}`}
                >
                  <FilterOutlined />
                  <span>
                    筛选
                    {[ext !== 'all' ? 1 : 0, days ? 1 : 0, includeHistorical ? 1 : 0].reduce((a, b) => a + b, 0) > 0
                      ? ` (${[ext !== 'all' ? 1 : 0, days ? 1 : 0, includeHistorical ? 1 : 0].reduce((a, b) => a + b, 0)})`
                      : ''}
                  </span>
                </button>
              </Popover>
            </Space>

            <Segmented
              size="small"
              value={searchModeChoice}
              onChange={(v) => setSearchModeChoice(v as SearchMode)}
              options={[
                { label: '混合', value: 'hybrid' },
                { label: '词', value: 'fts' },
                { label: '语义', value: 'semantic' },
              ]}
            />
          </div>

          {/* NotebookLM Source Grounding Bar + Cross-Document One-Click Presets */}
          {checkedList.length > 0 && (
            <div className="grounding-bar-wrap">
              <div className="grounding-bar">
                <span>
                  已勾选 <strong>{checkedList.length}</strong> 份文档作为问答围栏（仅读所选文档，防旧口径干扰）
                </span>
                <Space size={4}>
                  <Button
                    size="small"
                    type="primary"
                    loading={asking}
                    onClick={() =>
                      runGroundedAsk(
                        query || `请总结这 ${checkedList.length} 份文档的核心结论与关键数字`,
                        false
                      )
                    }
                  >
                    基于所选问 AI
                  </Button>
                  <Button size="small" type="text" onClick={() => setCheckedDocs({})}>
                    清空
                  </Button>
                </Space>
              </div>
              <div className="grounding-presets">
                <span className="grounding-presets-label">跨文档工具：</span>
                {checkedList.length === 2 && onOpenCompare && (
                  <button
                    type="button"
                    className="preset-chip"
                    onClick={() =>
                      onOpenCompare({
                        sourceA: checkedList[0].source_id,
                        pathA: checkedList[0].rel_path,
                        sourceB: checkedList[1].source_id,
                        pathB: checkedList[1].rel_path,
                      })
                    }
                  >
                    <SwapOutlined style={{ marginRight: 4 }} />
                    并排对照 (0 Token)
                  </button>
                )}
                {checkedList.length >= 2 && (
                  <button
                    type="button"
                    className="preset-chip"
                    onClick={() => setFactMatrixDocs(checkedList)}
                  >
                    <TableOutlined style={{ marginRight: 4 }} />
                    事实透视表 (0 Token)
                  </button>
                )}
                <button
                  type="button"
                  className="preset-chip"
                  onClick={() => {
                    setNewColName(query.trim() ? `${query.trim()} · 卷宗` : `专题卷宗 (${checkedList.length}份)`);
                    setSaveColOpen(true);
                  }}
                >
                  <BookOutlined style={{ marginRight: 4 }} />
                  存为卷宗
                </button>
                {checkedList.length >= 2 && (
                  <button
                    type="button"
                    className="preset-chip"
                    disabled={asking}
                    onClick={() => {
                      const p =
                        '请对比所选文档之间的核心观点、关键数字、规则阈值或版本口径差异，按维度逐条列出冲突与演进，并严格标注 [n] 出处。';
                      setQuery('对比所选文档的异同与口径差异');
                      runGroundedAsk(p, false);
                    }}
                  >
                    AI 对比异同
                  </button>
                )}
                <button
                  type="button"
                  className="preset-chip"
                  disabled={asking}
                  onClick={() => {
                    const p =
                      '请整合所选文档，提炼最重要的已确认结论、未决风险与待办事项，先给结论再给依据，每条标注 [n] 出处。';
                    setQuery('提炼所选文档的核心结论与待办');
                    runGroundedAsk(p, false);
                  }}
                >
                  AI 提炼结论待办
                </button>
                {checkedList.length >= 2 && (
                  <button
                    type="button"
                    className="preset-chip"
                    disabled={asking}
                    onClick={() => {
                      const p =
                        '请按时间先后梳理所选文档中该主题的演进脉络、每次关键决策变更及原因，每条标注 [n] 出处。';
                      setQuery('按时间梳理所选文档的演进脉络');
                      runGroundedAsk(p, false);
                    }}
                  >
                    AI 梳理时间脉络
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="pane-scroll">
          {/* Seamless Grounded AI Synthesis Panel (Perplexity + NotebookLM) */}
          {(qaOpen || asking) && (
            <div className="ai-synthesis-card">
              <div className="ai-synthesis-header">
                <Space size={6} wrap>
                  <Typography.Text strong style={{ fontSize: 13, color: 'var(--accent-text)' }}>
                    带出处综合回答
                  </Typography.Text>
                  <Select
                    size="small"
                    style={{ width: 175 }}
                    value={engineId}
                    onChange={setEngineId}
                    options={engines.map((e) => ({
                      label: e.available ? e.label : `${e.label} (未安装)`,
                      value: e.id,
                      disabled: !e.available,
                    }))}
                  />
                  {activeQa && !asking && (
                    <span className="meta-pill-blue">
                      {(activeQa.duration_ms / 1000).toFixed(1)}s · 引用 {activeQa.audit?.cited_refs?.length ?? 0}/
                      {activeQa.evidence.length}
                    </span>
                  )}
                </Space>
                <Space size={4}>
                  {activeQa && !asking && !activeQa.error && (
                    <Tooltip title="复制「结论 + 完整出处清单」简报，可直接粘贴到飞书或周报">
                      <Button
                        size="small"
                        type="text"
                        icon={<CopyOutlined />}
                        onClick={() => copyCitedBrief(activeQa)}
                      >
                        复制简报
                      </Button>
                    </Tooltip>
                  )}
                  <Button
                    size="small"
                    type="text"
                    icon={<CloseOutlined />}
                    onClick={() => setQaOpen(false)}
                  />
                </Space>
              </div>

              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>
                发送范围：
                {checkedList.length > 0
                  ? `已手动围栏 ${checkedList.length} 份勾选文档`
                  : `${sourceId === 'all' ? '全部知识源' : sourceNameMap[sourceId] || sourceId}${project !== 'all' ? ` / ${project}` : ''}${includeHistorical ? '（含历史）' : '（现行优先）'}`}{' '}
                → {selectedEngineObj?.label || engineId}（只读）
              </div>

              {asking ? (
                <div style={{ padding: '20px 0', textAlign: 'center' }}>
                  <Spin size="small" />{' '}
                  <Typography.Text type="secondary" style={{ fontSize: 12.5, marginLeft: 8 }}>
                    正在检索证据并生成带出处结论（{elapsedSec}s）…
                  </Typography.Text>
                </div>
              ) : activeQa ? (
                <>
                  {sessionTurns.length > 1 && (
                    <div style={{ fontSize: 11.5, color: '#64748b', marginBottom: 6 }}>
                      当前会话第 {sessionTurns.length} 轮追问 · 问：{activeQa.question}
                    </div>
                  )}

                  {activeQa.error ? (
                    <Alert type="error" showIcon message={activeQa.error} />
                  ) : (
                    <>
                      {renderInlineAndCitations(activeQa)}
                      {(activeQa.audit?.number_warnings?.length || 0) > 0 && (
                        <Alert
                          style={{ marginTop: 8 }}
                          type="warning"
                          showIcon
                          message="部分数字未在所引用段落逐字出现，请悬停或点击对应 [n] 核对原文"
                        />
                      )}
                    </>
                  )}

                  {activeQa.evidence.length > 0 && (
                    <Collapse
                      ghost
                      size="small"
                      style={{ marginTop: 6 }}
                      items={[
                        {
                          key: 'ev',
                          label: (
                            <span style={{ fontSize: 12, color: '#475569' }}>
                              查看本次召回的 {activeQa.evidence.length} 条原文证据
                            </span>
                          ),
                          children: (
                            <Space direction="vertical" size={4} style={{ width: '100%' }}>
                              {activeQa.evidence.map((ev) => (
                                <div
                                  key={ev.ref}
                                  className="brief-link-row"
                                  onClick={() => openEvidence(ev)}
                                >
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    <strong>[{ev.ref}]</strong> {ev.title}{' '}
                                    <span style={{ color: '#94a3b8', fontSize: 11 }}>({ev.rel_path})</span>
                                  </span>
                                  <span className="meta-pill-muted">
                                    {ev.page_num ? `P${ev.page_num}` : `L${ev.start_line}-${ev.end_line}`}
                                  </span>
                                </div>
                              ))}
                            </Space>
                          ),
                        },
                      ]}
                    />
                  )}

                  {/* Multi-turn follow-up input */}
                  <div className="followup-row">
                    <Input
                      size="small"
                      placeholder="基于当前话题继续追问（如：第二点里的阈值后来改过吗？）…"
                      value={followUpInput}
                      onChange={(e) => setFollowUpInput(e.target.value)}
                      onPressEnter={() => runGroundedAsk(followUpInput, true)}
                    />
                    <Button
                      size="small"
                      icon={<SendOutlined />}
                      loading={asking}
                      onClick={() => runGroundedAsk(followUpInput, true)}
                    >
                      追问
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          )}

          {/* Search Status Line */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '2px 4px 8px',
              fontSize: 11.5,
              color: '#64748b',
              gap: 8,
            }}
          >
            <span>
              {effectiveMode === 'hybrid'
                ? `RRF 混合召回 ${totalHits} 条`
                : effectiveMode === 'semantic'
                  ? `语义召回 ${totalHits} 条`
                  : effectiveMode === 'fts'
                    ? `关键词命中 ${totalHits} 条`
                    : `最近更新 · 共 ${totalHits} 份`}
              {groupByDoc && effectiveMode !== 'recent' && hits.length > displayRows.length
                ? `（已聚合为 ${displayRows.length} 篇文档）`
                : ''}
              {!includeHistorical ? ' · 现行优先' : ' · 含历史快照'}
            </span>
            {effectiveMode !== 'recent' && hits.length > 0 ? (
              <button
                type="button"
                className={`chip-btn${groupByDoc ? ' active' : ''}`}
                style={{ height: 22, fontSize: 11, padding: '0 8px' }}
                onClick={() => setGroupByDoc((g) => !g)}
              >
                {groupByDoc ? '已按文档聚合 · 点此展开全部' : '全部片段 · 点此按文档聚合'}
              </button>
            ) : (
              <span style={{ fontSize: 11 }}>勾选左侧复选框可限定 AI 回答文档范围</span>
            )}
          </div>

          {/* Denoised Editorial Search Results */}
          {searching ? (
            <div style={{ padding: 40, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : displayRows.length === 0 ? (
            meta && meta.sources.length === 0 ? (
              <div style={{ padding: '48px 20px', textAlign: 'center' }}>
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="还没有挂载知识库文件夹（严格只读，不改动原文件）"
                >
                  <Space>
                    <Button type="primary" onClick={() => onOpenGuide?.()}>
                      打开 3 步快速引导（可载入示例库）
                    </Button>
                    <Button onClick={() => onOpenSettings?.()}>
                      添加本地文件夹
                    </Button>
                  </Space>
                </Empty>
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的文档或段落" />
            )
          ) : (
            displayRows.map(({ docKey, primary: hit, extras }, idx) => {
              const isChecked = Boolean(checkedDocs[docKey]);
              const isSelected =
                selectedDoc?.sourceId === hit.source_id &&
                selectedDoc?.relPath === hit.rel_path &&
                selectedDoc?.chunkId === hit.chunk_id;
              const isExpanded = Boolean(expandedGroups[docKey]);

              return (
                <div
                  key={`${hit.doc_id}-${hit.chunk_id ?? idx}`}
                  className={`result-row${isSelected ? ' selected' : ''}${hit.is_historical ? ' historical' : ''}${checkedList.length > 0 ? ' has-checks' : ''}`}
                  onClick={() => selectHitAt(idx)}
                >
                  <span
                    className={`row-checkbox-wrap${isChecked ? ' is-checked' : ''}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={isChecked}
                      onChange={(e) => toggleCheckDoc(hit, e.target.checked)}
                    />
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span className="result-title">{hit.title}</span>
                      {hit.is_historical && <span className="meta-pill-muted">历史/快照</span>}
                      {hit.match_type === 'both' && (
                        <span className="meta-pill-green">双命中</span>
                      )}
                      {hit.match_type === 'semantic' && hit.vec_score && (
                        <span className="meta-pill-blue">语义 {hit.vec_score.toFixed(2)}</span>
                      )}
                    </div>

                    <div className="result-subline">
                      <span className="result-mono">
                        {hit.source_id}/{hit.rel_path}
                      </span>
                      {hit.page_num ? (
                        <span>· P{hit.page_num}</span>
                      ) : hit.chunk_id !== null ? (
                        <span>· L{hit.start_line}–L{hit.end_line}</span>
                      ) : null}
                      {hit.git_author && <span>· {hit.git_author}</span>}
                      <span>· {formatShortDate(hit.git_date || hit.mtime)}</span>
                    </div>

                    {hit.snippet && (
                      <div
                        className="result-snippet"
                        dangerouslySetInnerHTML={{ __html: hit.snippet }}
                      />
                    )}

                    {extras.length > 0 && (
                      <div onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="doc-group-more-btn"
                          onClick={() =>
                            setExpandedGroups((prev) => ({ ...prev, [docKey]: !prev[docKey] }))
                          }
                        >
                          {isExpanded ? `收起其余 ${extras.length} 处命中` : `+ 同文档还有 ${extras.length} 处命中`}
                        </button>
                        {isExpanded && (
                          <div className="doc-group-extras">
                            {extras.slice(0, 6).map((ex, eIdx) => (
                              <div
                                key={`${ex.chunk_id ?? eIdx}`}
                                className="doc-group-extra-item"
                                onClick={() => openHit(ex, idx)}
                              >
                                <span className="doc-group-extra-loc">
                                  {ex.page_num ? `P${ex.page_num}` : `L${ex.start_line}–L${ex.end_line}`}
                                </span>
                                <span
                                  dangerouslySetInnerHTML={{
                                    __html: (ex.snippet || ex.heading_path || '查看该片段').slice(0, 140),
                                  }}
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Resizer between center & preview */}
      <div
        className="resizer-handle"
        onMouseDown={() => {
          draggingRef.current = 'right';
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }}
      />

      {/* Right Pane: Editorial Document Preview & Citation Verification */}
      <DocPreview
        sourceId={selectedDoc?.sourceId || null}
        relPath={selectedDoc?.relPath || null}
        highlightRange={
          selectedDoc?.highlight
            ? { ...selectedDoc.highlight, chunkId: selectedDoc.chunkId }
            : selectedDoc?.chunkId
              ? { startLine: 1, endLine: 1, chunkId: selectedDoc.chunkId }
              : null
        }
        sourceNameMap={sourceNameMap}
        onJumpToDoc={(sid, rp, hl) =>
          setSelectedDoc({
            sourceId: sid,
            relPath: rp,
            chunkId: hl?.chunkId ?? null,
            highlight: hl || null,
          })
        }
        checkedDocKeys={new Set(Object.keys(checkedDocs))}
        onAddToFence={(docs) => {
          setCheckedDocs((prev) => {
            const next = { ...prev };
            docs.forEach((d) => {
              next[`${d.source_id}::${d.rel_path}`] = d;
            });
            return next;
          });
          message.success('已拉入跨文档对比围栏，可在中间栏一键并排对照或透视');
        }}
        recentDocs={recentDocs}
        collections={collections}
        onOpenCollection={applyCollection}
      />

      {/* Save Virtual Collection Modal */}
      <Modal
        title="存为虚拟专题卷宗（不改动磁盘原文件）"
        open={saveColOpen}
        onCancel={() => setSaveColOpen(false)}
        onOk={handleSaveCollection}
        okText="保存卷宗"
        cancelText="取消"
        width={420}
      >
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 10 }}>
          将当前勾选的 {checkedList.length} 份文档归档为一个虚拟卷宗，后续在左侧「卷宗」页可一键调出继续对照或发问。
        </div>
        <Input
          placeholder="输入卷宗名称，例如：Q4 备货口径核对"
          value={newColName}
          onChange={(e) => setNewColName(e.target.value)}
          onPressEnter={handleSaveCollection}
          autoFocus
        />
      </Modal>

      {/* 0-Token Cross-Doc Fact Matrix Modal */}
      <FactMatrixModal
        docs={factMatrixDocs}
        onClose={() => setFactMatrixDocs(null)}
        onJumpToDoc={(sid, rp) => {
          recordRecentDoc(sid, rp);
          setSelectedDoc({ sourceId: sid, relPath: rp, chunkId: null, highlight: null });
        }}
      />
    </div>
  );
};

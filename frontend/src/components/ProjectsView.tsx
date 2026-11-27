import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Drawer,
  Empty,
  Input,
  Segmented,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  CodeOutlined,
  FileTextOutlined,
  NodeIndexOutlined,
  RobotOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  api,
  ProjectDetailResponse,
  ProjectDocRow,
  ProjectOverviewItem,
  StarMapNode,
  StarMapResponse,
  TopicCluster,
} from '../api';
import { StarMapCanvas } from './StarMapCanvas';
import { CompareTarget } from './CompareModal';

interface ProjectsViewProps {
  externalProject?: { sourceId: string; project: string } | null;
  onClearExternalProject?: () => void;
  onJumpToDoc: (sourceId: string, relPath: string) => void;
  onFenceClusterDocs?: (
    docs: Array<{ source_id: string; rel_path: string; title: string }>,
    clusterTitle: string
  ) => void;
  onOpenCompare?: (target: CompareTarget) => void;
}

const ACTOR_COLOR: Record<string, string> = {
  Antigravity: 'blue',
  'Claude Code': 'orange',
  Codex: 'green',
  Hermes: 'purple',
  DSH: 'cyan',
};

const SNAPSHOT_RE = /快照|归档|_archive|回写清单|去版本号前|旧版|backup/i;

function fmtDate(isoOrEpoch: string | number | undefined): string {
  if (!isoOrEpoch) return '-';
  if (typeof isoOrEpoch === 'number') {
    const d = new Date(isoOrEpoch * 1000);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return isoOrEpoch.slice(5, 10);
}

export const ProjectsView: React.FC<ProjectsViewProps> = ({
  externalProject,
  onClearExternalProject,
  onJumpToDoc,
  onFenceClusterDocs,
  onOpenCompare,
}) => {
  const [viewMode, setViewMode] = useState<'folders' | 'clusters' | 'starmap'>('folders');
  const [loadingList, setLoadingList] = useState(false);
  const [projects, setProjects] = useState<ProjectOverviewItem[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [kw, setKw] = useState('');
  const [selected, setSelected] = useState<{ source_id: string; project: string } | null>(null);

  const [loadingClusters, setLoadingClusters] = useState(false);
  const [clusters, setClusters] = useState<TopicCluster[]>([]);
  const [clusterTotalDocs, setClusterTotalDocs] = useState(0);
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);

  const [loadingStarMap, setLoadingStarMap] = useState(false);
  const [starMap, setStarMap] = useState<StarMapResponse | null>(null);

  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detail, setDetail] = useState<ProjectDetailResponse | null>(null);

  const [diffOpen, setDiffOpen] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffTitle, setDiffTitle] = useState('');
  const [diffContent, setDiffContent] = useState('');

  useEffect(() => {
    setLoadingList(true);
    api
      .projectsOverview()
      .then((list) => {
        setProjects(list);
        if (list.length > 0 && !selected && !externalProject) {
          const firstProj = list.find((p) => p.project !== '(根目录)') || list[0];
          setSelected({ source_id: firstProj.source_id, project: firstProj.project });
        }
      })
      .finally(() => setLoadingList(false));
  }, []);

  useEffect(() => {
    if (externalProject) {
      setViewMode('folders');
      setSelected({ source_id: externalProject.sourceId, project: externalProject.project });
      onClearExternalProject?.();
    }
  }, [externalProject]);

  useEffect(() => {
    if (viewMode !== 'clusters') return;
    setLoadingClusters(true);
    api
      .projectClusters(sourceFilter, 10)
      .then((res) => {
        setClusters(res.clusters || []);
        setClusterTotalDocs(res.total_docs || 0);
        if (res.clusters?.length > 0 && !res.clusters.some((c) => c.id === selectedClusterId)) {
          setSelectedClusterId(res.clusters[0].id);
        }
      })
      .catch(() => setClusters([]))
      .finally(() => setLoadingClusters(false));
  }, [viewMode, sourceFilter]);

  useEffect(() => {
    if (!selected) return;
    setLoadingDetail(true);
    api
      .projectDetail(selected.source_id, selected.project)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setLoadingDetail(false));
  }, [selected?.source_id, selected?.project]);

  useEffect(() => {
    if (viewMode !== 'starmap') return;
    setLoadingStarMap(true);
    api
      .starMap(sourceFilter, 220, 8)
      .then(setStarMap)
      .catch(() => setStarMap(null))
      .finally(() => setLoadingStarMap(false));
  }, [viewMode, sourceFilter]);

  const filteredProjects = useMemo(() => {
    const low = kw.trim().toLowerCase();
    return projects.filter((p) => {
      if (sourceFilter !== 'all' && p.source_id !== sourceFilter) return false;
      if (
        low &&
        !p.project.toLowerCase().includes(low) &&
        !p.display_name.toLowerCase().includes(low) &&
        !p.source_name.toLowerCase().includes(low)
      ) {
        return false;
      }
      return true;
    });
  }, [projects, sourceFilter, kw]);

  const sourceOptions = useMemo(() => {
    const seen = new Map<string, string>();
    projects.forEach((p) => seen.set(p.source_id, p.source_name));
    return [
      { label: '全部知识源', value: 'all' },
      ...Array.from(seen.entries()).map(([value, label]) => ({ label, value })),
    ];
  }, [projects]);

  const openDiff = (sourceId: string, commit: string, actor: string) => {
    setDiffTitle(`${sourceId} · ${commit.slice(0, 8)} · ${actor}`);
    setDiffOpen(true);
    setDiffLoading(true);
    api
      .commitDiff(sourceId, commit)
      .then((res) => setDiffContent(res.diff))
      .catch((err) => setDiffContent(String(err)))
      .finally(() => setDiffLoading(false));
  };

  const renderDocList = (docs: ProjectDocRow[], emptyText: string) => {
    if (!docs || docs.length === 0) {
      return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />;
    }
    return (
      <div>
        {docs.map((d) => {
          const isSnap = SNAPSHOT_RE.test(d.rel_path) || SNAPSHOT_RE.test(d.title);
          return (
            <div
              key={`${d.source_id}-${d.rel_path}`}
              className={`result-row${isSnap ? ' historical' : ''}`}
              onClick={() => onJumpToDoc(d.source_id, d.rel_path)}
            >
              <FileTextOutlined style={{ color: '#94a3b8', marginTop: 3 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span className="result-title">
                    {d.title}{' '}
                    {isSnap && <span className="meta-pill-muted">历史/快照</span>}
                    {d.linked_from_global_meetings && (
                      <span className="meta-pill-blue">关联会议</span>
                    )}
                  </span>
                  <span style={{ fontSize: 11.5, color: '#64748b', whiteSpace: 'nowrap' }}>
                    {d.git_author ? `${d.git_author} · ` : ''}
                    {fmtDate(d.git_date || d.mtime)}
                  </span>
                </div>
                <div className="result-subline">
                  <span className="result-mono">{d.rel_path}</span>
                  <span>· {d.ext}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // Curated 1-minute pre-meeting brief slices (active docs prioritized)
  const topDecisions = useMemo(
    () => (detail?.buckets.decisions || []).filter((d) => !SNAPSHOT_RE.test(d.rel_path)).slice(0, 3),
    [detail]
  );
  const topPrds = useMemo(
    () => (detail?.buckets.prds || []).filter((d) => !SNAPSHOT_RE.test(d.rel_path)).slice(0, 3),
    [detail]
  );
  const topMeetings = useMemo(
    () => (detail?.buckets.meetings || []).slice(0, 3),
    [detail]
  );

  const filteredClusters = useMemo(() => {
    const low = kw.trim().toLowerCase();
    if (!low) return clusters;
    return clusters.filter(
      (c) =>
        c.title.toLowerCase().includes(low) ||
        c.keywords.some((k) => k.toLowerCase().includes(low)) ||
        c.docs.some((d) => d.title.toLowerCase().includes(low))
    );
  }, [clusters, kw]);

  const activeCluster = useMemo(
    () => clusters.find((c) => c.id === selectedClusterId) || filteredClusters[0] || null,
    [clusters, filteredClusters, selectedClusterId]
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '290px 1fr', width: '100%', height: '100%', minHeight: 0 }}>
      {/* Left Project / Semantic Cluster List */}
      <div className="pane sidebar-pane">
        <div className="pane-header">
          <Space direction="vertical" style={{ width: '100%' }} size={6}>
            <Segmented
              block
              size="small"
              value={viewMode}
              onChange={(v) => setViewMode(v as 'folders' | 'clusters' | 'starmap')}
              options={[
                { label: '目录', value: 'folders' },
                { label: '星簇', value: 'clusters' },
                { label: '星图', value: 'starmap' },
              ]}
            />
            <Input
              size="small"
              allowClear
              placeholder={viewMode === 'clusters' ? '筛选主题簇或关键词…' : '筛选项目名称…'}
              prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
              value={kw}
              onChange={(e) => setKw(e.target.value)}
            />
            <Select
              size="small"
              style={{ width: '100%' }}
              value={sourceFilter}
              onChange={setSourceFilter}
              options={sourceOptions}
            />
          </Space>
        </div>
        <div className="pane-scroll">
          {viewMode === 'clusters' ? (
            loadingClusters ? (
              <div style={{ padding: 32, textAlign: 'center' }}>
                <Spin />
              </div>
            ) : filteredClusters.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可聚类的向量文档" />
            ) : (
              filteredClusters.map((c) => {
                const active = activeCluster?.id === c.id;
                return (
                  <div
                    key={c.id}
                    className={`result-row${active ? ' selected' : ''}`}
                    onClick={() => setSelectedClusterId(c.id)}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                        <span className="result-title">
                          <NodeIndexOutlined style={{ color: 'var(--accent)', marginRight: 5 }} />
                          {c.title}
                        </span>
                        <span className="meta-pill-blue">{c.doc_count}</span>
                      </div>
                      <div className="result-subline">
                        <span>{Object.entries(c.ext_counts).map(([e, n]) => `${e}(${n})`).join(' · ')}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )
          ) : loadingList ? (
            <div style={{ padding: 32, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : (
            filteredProjects.map((p) => {
              const active = selected?.source_id === p.source_id && selected?.project === p.project;
              return (
                <div
                  key={`${p.source_id}::${p.project}`}
                  className={`result-row${active ? ' selected' : ''}`}
                  onClick={() => setSelected({ source_id: p.source_id, project: p.project })}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                      <span className="result-title">{p.display_name}</span>
                      <span className="meta-pill-muted">{p.doc_count}</span>
                    </div>
                    <div className="result-subline">
                      <span>{p.source_name}</span>
                      {p.counts.decisions > 0 && <span>· 决策 {p.counts.decisions}</span>}
                      {p.counts.prds > 0 && <span>· PRD {p.counts.prds}</span>}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right Project Hub or Semantic Cluster Hub or Star Map */}
      <div className="page-scroll">
        {viewMode === 'starmap' ? (
          loadingStarMap ? (
            <div style={{ padding: 60, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : starMap ? (
            <StarMapCanvas
              data={starMap}
              onJumpToDoc={onJumpToDoc}
              onFenceDocs={(docs, lbl) => onFenceClusterDocs?.(docs, lbl)}
              onCompareTwo={
                onOpenCompare
                  ? (a: StarMapNode, b: StarMapNode) =>
                      onOpenCompare({
                        sourceA: a.source_id,
                        pathA: a.rel_path,
                        sourceB: b.source_id,
                        pathB: b.rel_path,
                      })
                  : undefined
              }
            />
          ) : (
            <Empty description="暂无星图数据" />
          )
        ) : viewMode === 'clusters' ? (
          loadingClusters ? (
            <div style={{ padding: 60, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : !activeCluster ? (
            <Empty description="暂无主题星簇，先添加文件夹并完成离线向量计算" />
          ) : (
            <div style={{ maxWidth: 1020, margin: '0 auto' }}>
              <div className="section-card" style={{ padding: '16px 18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>
                      <NodeIndexOutlined style={{ color: 'var(--accent)', marginRight: 8 }} />
                      {activeCluster.title}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                      本地向量自动聚拢 · 共 {activeCluster.doc_count} 篇文档（基于 {clusterTotalDocs} 篇活跃文档聚类，内聚度{' '}
                      {Math.round(activeCluster.cohesion * 100)}%）
                    </div>
                    {activeCluster.keywords.length > 0 && (
                      <Space size={6} wrap style={{ marginTop: 10 }}>
                        {activeCluster.keywords.map((kwItem) => (
                          <Tag key={kwItem} color="blue" bordered={false} style={{ margin: 0 }}>
                            {kwItem}
                          </Tag>
                        ))}
                        {Object.entries(activeCluster.ext_counts).map(([extKey, cnt]) => (
                          <Tag key={extKey} bordered={false} style={{ margin: 0 }}>
                            {extKey} × {cnt}
                          </Tag>
                        ))}
                      </Space>
                    )}
                  </div>
                  {onFenceClusterDocs && activeCluster.docs.length > 0 && (
                    <Button
                      type="primary"
                      size="small"
                      icon={<RobotOutlined />}
                      onClick={() =>
                        onFenceClusterDocs(
                          activeCluster.docs.slice(0, 6).map((d) => ({
                            source_id: d.source_id,
                            rel_path: d.rel_path,
                            title: d.title,
                          })),
                          activeCluster.title
                        )
                      }
                    >
                      将本簇核心文档（{Math.min(6, activeCluster.docs.length)} 份）拉入 AI 对比
                    </Button>
                  )}
                </div>
              </div>

              <div className="section-card">
                <div className="section-title">
                  <span>簇内文档（按与主题中心相关度排序 · 点击直达原文）</span>
                </div>
                {activeCluster.docs.map((d) => (
                  <div
                    key={`${d.source_id}::${d.rel_path}`}
                    className="result-row"
                    onClick={() => onJumpToDoc(d.source_id, d.rel_path)}
                  >
                    <FileTextOutlined style={{ color: '#94a3b8', marginTop: 3 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span className="result-title">
                          {d.title}{' '}
                          <span className="meta-pill-blue">核心度 {Math.round(d.centrality * 100)}%</span>
                          <span className="meta-pill-muted">{d.ext}</span>
                        </span>
                        <span style={{ fontSize: 11.5, color: '#64748b', whiteSpace: 'nowrap' }}>
                          {fmtDate(d.git_date || d.mtime)}
                        </span>
                      </div>
                      <div className="result-subline">
                        <span>{d.source_name}</span>
                        <span>/</span>
                        <span className="result-mono">{d.rel_path}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        ) : loadingDetail ? (
          <div style={{ padding: 60, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : !detail ? (
          <Empty description="从左侧选择一个项目查看速览与全貌" />
        ) : (
          <div style={{ maxWidth: 1020, margin: '0 auto' }}>
            <div className="section-card" style={{ padding: '14px 18px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>
                    {detail.display_name}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>
                    {detail.source_name} / {detail.project} · 共 {detail.total_docs} 份文档
                    {detail.recent_commits[0]
                      ? ` · 最近变更：${detail.recent_commits[0].actor} (${detail.recent_commits[0].date.slice(0, 10)})`
                      : ''}
                  </div>
                </div>
                {detail.buckets.index[0] && (
                  <Button
                    size="small"
                    onClick={() =>
                      onJumpToDoc(detail.buckets.index[0].source_id, detail.buckets.index[0].rel_path)
                    }
                  >
                    打开 INDEX.md
                  </Button>
                )}
              </div>
            </div>

            {/* 1-Minute Pre-Meeting Brief Grid */}
            <div className="brief-grid">
              <div className="brief-card">
                <div className="brief-card-title">开会前速览 · 最新决策</div>
                {topDecisions.length === 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    暂无独立决策文件
                  </Typography.Text>
                ) : (
                  topDecisions.map((d) => (
                    <div
                      key={d.rel_path}
                      className="brief-link-row"
                      onClick={() => onJumpToDoc(d.source_id, d.rel_path)}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {d.title}
                      </span>
                      <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0 }}>
                        {fmtDate(d.git_date || d.mtime)}
                      </span>
                    </div>
                  ))
                )}
              </div>

              <div className="brief-card">
                <div className="brief-card-title">开会前速览 · 现行 PRD / 规格</div>
                {topPrds.length === 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    暂无现行 PRD 文档
                  </Typography.Text>
                ) : (
                  topPrds.map((d) => (
                    <div
                      key={d.rel_path}
                      className="brief-link-row"
                      onClick={() => onJumpToDoc(d.source_id, d.rel_path)}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {d.title}
                      </span>
                      <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0 }}>
                        {fmtDate(d.git_date || d.mtime)}
                      </span>
                    </div>
                  ))
                )}
              </div>

              <div className="brief-card">
                <div className="brief-card-title">开会前速览 · 最近会议</div>
                {topMeetings.length === 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    暂无关联会议纪要
                  </Typography.Text>
                ) : (
                  topMeetings.map((d) => (
                    <div
                      key={d.rel_path}
                      className="brief-link-row"
                      onClick={() => onJumpToDoc(d.source_id, d.rel_path)}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {d.title}
                      </span>
                      <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0 }}>
                        {fmtDate(d.git_date || d.mtime)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="section-card">
              <Tabs
                defaultActiveKey={
                  detail.buckets.decisions.length > 0
                    ? 'decisions'
                    : detail.buckets.prds.length > 0
                      ? 'prds'
                      : 'references'
                }
                items={[
                  {
                    key: 'decisions',
                    label: `核心决策 (${detail.buckets.decisions.length})`,
                    children: renderDocList(detail.buckets.decisions, '该项目暂无决策文档'),
                  },
                  {
                    key: 'prds',
                    label: `PRD / 规格 (${detail.buckets.prds.length})`,
                    children: renderDocList(detail.buckets.prds, '该项目暂无 PRD 或规格文档'),
                  },
                  {
                    key: 'meetings',
                    label: `会议纪要 (${detail.buckets.meetings.length})`,
                    children: renderDocList(detail.buckets.meetings, '暂无关联会议纪要'),
                  },
                  {
                    key: 'todos',
                    label: `排期与待办 (${detail.buckets.todos.length})`,
                    children: renderDocList(detail.buckets.todos, '暂无排期/待办文档'),
                  },
                  {
                    key: 'references',
                    label: `参考与其他 (${detail.buckets.references.length})`,
                    children: renderDocList(detail.buckets.references, '暂无其他参考文档'),
                  },
                  {
                    key: 'commits',
                    label: `提交历史 (${detail.recent_commits.length})`,
                    children:
                      detail.recent_commits.length === 0 ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="非 Git 资料源，无提交历史" />
                      ) : (
                        <div>
                          {detail.recent_commits.map((c) => (
                            <div
                              key={c.commit}
                              style={{
                                padding: '9px 4px',
                                borderBottom: '1px solid #f1f5f9',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: 12,
                              }}
                            >
                              <div>
                                <Space size={6}>
                                  <Tag bordered={false} color={ACTOR_COLOR[c.actor] || 'default'}>
                                    {c.actor}
                                  </Tag>
                                  <Typography.Text code style={{ fontSize: 11.5 }}>
                                    {c.commit.slice(0, 8)}
                                  </Typography.Text>
                                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                    {c.date.replace('T', ' ').slice(0, 16)}
                                  </Typography.Text>
                                </Space>
                                <div style={{ marginTop: 4, fontSize: 13 }}>{c.message}</div>
                              </div>
                              <Button
                                size="small"
                                icon={<CodeOutlined />}
                                onClick={() => openDiff(detail.source_id, c.commit, c.actor)}
                              >
                                Diff
                              </Button>
                            </div>
                          ))}
                        </div>
                      ),
                  },
                ]}
              />
            </div>
          </div>
        )}
      </div>

      <Drawer title={diffTitle} open={diffOpen} onClose={() => setDiffOpen(false)} width={760}>
        {diffLoading ? (
          <div style={{ padding: 48, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : (
          <pre className="diff-pre">{diffContent}</pre>
        )}
      </Drawer>
    </div>
  );
};

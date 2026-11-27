import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Col,
  Empty,
  Progress,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  CopyOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  RobotOutlined,
  SwapOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { api, ConflictCandidate, DuplicatesResponse, HealthResponse } from '../api';
import { CompareTarget } from './CompareModal';

interface HealthViewProps {
  onIndexRefreshed?: () => void;
  onJumpToDoc?: (
    sourceId: string,
    relPath: string,
    highlight?: { startLine: number; endLine: number } | null
  ) => void;
  onOpenCompare?: (target: CompareTarget) => void;
}

const SEV_COLOR: Record<string, string> = {
  error: 'red',
  ERROR: 'red',
  warn: 'orange',
  WARN: 'orange',
  OK: 'green',
  INFO: 'blue',
};

export const HealthView: React.FC<HealthViewProps> = ({
  onIndexRefreshed,
  onJumpToDoc,
  onOpenCompare,
}) => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<HealthResponse | null>(null);
  const [conflicts, setConflicts] = useState<ConflictCandidate[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicatesResponse | null>(null);
  const [scanningConflicts, setScanningConflicts] = useState(false);
  const [reviewingId, setReviewingId] = useState<number | null>(null);

  const loadHealth = () => {
    setLoading(true);
    Promise.all([api.health(), api.conflicts(false), api.duplicates(24).catch(() => null)])
      .then(([h, c, dup]) => {
        setData(h);
        setConflicts(c);
        setDuplicates(dup);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadHealth();
  }, []);

  const handleScanConflicts = async () => {
    setScanningConflicts(true);
    try {
      const res = await api.scanConflicts();
      const list = await api.conflicts(false);
      setConflicts(list);
      message.success(`扫描完成：检出 ${res.candidates_found ?? list.length} 组高相似数值差异候选`);
    } catch (err) {
      message.error(`冲突扫描失败：${String(err)}`);
    } finally {
      setScanningConflicts(false);
    }
  };

  const handleReviewConflict = async (id: number) => {
    setReviewingId(id);
    try {
      const res = await api.reviewConflict(id);
      if (res.ok) {
        message.success(`AI 复核完成：${res.verdict}`);
        setConflicts(await api.conflicts(false));
      } else {
        message.error(res.error || '复核失败');
      }
    } finally {
      setReviewingId(null);
    }
  };

  const handleDismissConflict = async (id: number) => {
    await api.setConflictStatus(id, 'dismissed');
    setConflicts((prev) => prev.filter((c) => c.id !== id));
    message.info('已忽略该候选（仅本地状态，未改 Wiki）');
  };

  const copyFixPrompt = (prompt: string) => {
    navigator.clipboard.writeText(prompt);
    message.success('已复制给 Agent 的只读核查与修复指令，粘贴到终端即可执行');
  };

  const triggerReindex = async (force = false) => {
    const res = await api.refreshIndex(force);
    if (res.started) {
      message.info(force ? '已启动全量重建索引' : '已启动后台增量索引');
      setTimeout(() => {
        loadHealth();
        onIndexRefreshed?.();
      }, 2500);
    } else {
      message.warning('索引任务正在运行中');
    }
  };

  const triggerVectorSync = async () => {
    const res = await api.syncVectors();
    if (res.started) {
      message.info('已启动本地语义向量增量补齐');
      setTimeout(() => {
        loadHealth();
        onIndexRefreshed?.();
      }, 2500);
    } else {
      message.warning('向量构建任务正在运行中');
    }
  };

  if (loading && !data) {
    return (
      <div className="page-scroll" style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
        <Spin />
      </div>
    );
  }

  const idx = data?.index_status;
  const vec = data?.vector_status;
  const isStandalone = data?.edition === 'standalone';

  return (
    <div className="page-scroll">
      <div className="page-container">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 14,
          }}
        >
          <Typography.Text type="secondary">
            {isStandalone
              ? '所有巡检严格只读：本地向量索引、口径冲突初筛与文档解析状态一览，绝不修改原文件。'
              : '所有治理操作严格只读：界面只做聚合预警与核对，具体改动通过复制指令交给任一 Agent 执行。'}
          </Typography.Text>
          <Space>
            <Button size="small" icon={<ReloadOutlined />} onClick={loadHealth}>
              刷新报告
            </Button>
            <Button
              size="small"
              icon={<SyncOutlined spin={idx?.progress.running} />}
              onClick={() => triggerReindex(false)}
            >
              增量索引
            </Button>
            <Button size="small" onClick={() => triggerReindex(true)}>
              全量重扫
            </Button>
          </Space>
        </div>

        {/* Summary KPI Cards */}
        {isStandalone ? (
          <Row gutter={12} style={{ marginBottom: 16 }}>
            <Col span={6}>
              <div className="section-card" style={{ marginBottom: 0 }}>
                <Statistic title="已索引文档数" value={idx?.totals.documents ?? 0} />
              </div>
            </Col>
            <Col span={6}>
              <div className="section-card" style={{ marginBottom: 0 }}>
                <Statistic
                  title="语义向量覆盖率"
                  value={vec ? `${vec.coverage_pct}%` : '-'}
                  valueStyle={{ color: (vec?.coverage_pct ?? 0) >= 99 ? '#15803d' : '#2563eb' }}
                />
              </div>
            </Col>
            <Col span={6}>
              <div className="section-card" style={{ marginBottom: 0 }}>
                <Statistic
                  title="疑似口径冲突候选"
                  value={conflicts.length}
                  valueStyle={{ color: conflicts.length > 0 ? '#b45309' : '#15803d' }}
                />
              </div>
            </Col>
            <Col span={6}>
              <div className="section-card" style={{ marginBottom: 0 }}>
                <Statistic
                  title="跳过 / 需关注文件"
                  value={idx?.non_ok_files.length ?? 0}
                />
              </div>
            </Col>
          </Row>
        ) : (
          <Row gutter={12} style={{ marginBottom: 16 }}>
            <Col span={6}>
              <div className="section-card" style={{ marginBottom: 0 }}>
                <Statistic
                  title="当前联邦告警"
                  value={data?.alerts.count ?? 0}
                  valueStyle={{ color: (data?.alerts.count ?? 0) > 0 ? '#b91c1c' : '#15803d' }}
                />
              </div>
            </Col>
            <Col span={6}>
              <div className="section-card" style={{ marginBottom: 0 }}>
                <Statistic
                  title="存在未提交改动的仓库"
                  value={data?.uncommitted.length ?? 0}
                  valueStyle={{ color: (data?.uncommitted.length ?? 0) > 0 ? '#b45309' : '#15803d' }}
                />
              </div>
            </Col>
            <Col span={6}>
              <div className="section-card" style={{ marginBottom: 0 }}>
                <Statistic title="已索引文档 / 切块" value={`${idx?.totals.documents ?? 0} / ${idx?.totals.chunks ?? 0}`} />
              </div>
            </Col>
            <Col span={6}>
              <div className="section-card" style={{ marginBottom: 0 }}>
                <Statistic
                  title="共享技能体检（待优化 / 总计）"
                  value={`${data?.skill_lint.skills_with_issues ?? 0} / ${data?.skill_lint.total_skills ?? 0}`}
                />
              </div>
            </Col>
          </Row>
        )}

        {/* 0. Local Semantic Vector & File Watcher Status */}
        {vec && (
          <div className="section-card">
            <div className="section-title">
              <span>本地语义向量与实时监听（全程离线计算，正文不出本机）</span>
              <Space>
                <Tag color={data?.watcher_active ? 'green' : 'default'}>
                  文件监听：{data?.watcher_active ? '已启用 (watchdog)' : '轮询兜底'}
                </Tag>
                <Tag color={vec.model_loaded ? 'blue' : 'default'}>
                  模型内存：{vec.model_loaded ? '已加载' : '空闲已卸载'}
                </Tag>
                <Button
                  size="small"
                  icon={<SyncOutlined spin={vec.progress.running} />}
                  onClick={triggerVectorSync}
                >
                  {vec.progress.running ? '补齐中…' : '补齐向量索引'}
                </Button>
              </Space>
            </div>
            <Row gutter={16} align="middle">
              <Col span={14}>
                <Progress
                  percent={vec.coverage_pct}
                  status={vec.progress.running ? 'active' : vec.coverage_pct >= 99.9 ? 'success' : 'normal'}
                />
              </Col>
              <Col span={10}>
                <Space direction="vertical" size={2} style={{ fontSize: 12.5 }}>
                  <span>
                    模型：<Typography.Text code>{vec.model_name}</Typography.Text>（空闲 {vec.idle_unload_seconds}s 自动卸载）
                  </span>
                  <span>
                    已覆盖：{vec.embedded_chunks} / {vec.total_chunks} 切块（去重哈希 {vec.unique_vectors}）
                    {vec.progress.running && vec.progress.chunks_per_sec > 0
                      ? ` · ${vec.progress.chunks_per_sec} 块/秒`
                      : ''}
                  </span>
                </Space>
              </Col>
            </Row>
            {vec.progress.last_error && (
              <Alert style={{ marginTop: 10 }} type="error" showIcon message={`向量构建错误：${vec.progress.last_error}`} />
            )}
          </div>
        )}

        {/* 1. Alerts (Personal federation only) */}
        {!isStandalone && (
          <div className="section-card">
            <div className="section-title">
              <span>系统告警（.health/alerts.json）</span>
              <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                生成于：{data?.alerts.generated_at || '-'}
              </Typography.Text>
            </div>
            {data && data.alerts.items.length > 0 ? (
              <Space direction="vertical" style={{ width: '100%' }} size={8}>
                {data.alerts.items.map((al, i) => (
                  <Alert
                    key={i}
                    type={al.level === 'error' ? 'error' : 'warning'}
                    showIcon
                    message={
                      <Space>
                        <Tag color={SEV_COLOR[al.level] || 'default'}>{al.source}</Tag>
                        <span>{al.message}</span>
                      </Space>
                    }
                    action={
                      <Button
                        size="small"
                        icon={<CopyOutlined />}
                        onClick={() => copyFixPrompt(al.fix_prompt)}
                      >
                        复制给 Agent 修复
                      </Button>
                    }
                  />
                ))}
              </Space>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前无告警" />
            )}
          </div>
        )}

        {/* 1.5 Suspected Conflict Candidates Queue (Phase 3) */}
        <div className="section-card">
          <div className="section-title">
            <span>疑似口径冲突候选（同项目跨文档高相似 + 数值/版本差异 · {conflicts.length} 组）</span>
            <Button
              size="small"
              icon={<SyncOutlined spin={scanningConflicts} />}
              loading={scanningConflicts}
              onClick={handleScanConflicts}
            >
              重新扫描冲突候选
            </Button>
          </div>
          {conflicts.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无候选，点击右上角「重新扫描冲突候选」用本地向量筛查同项目数值差异"
            />
          ) : (
            conflicts.slice(0, 20).map((c) => (
              <div
                key={c.id}
                style={{
                  border: '1px solid var(--border-hairline)',
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 10,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <Space size={6} wrap>
                    <Tag color="blue">{c.source_id} / {c.project}</Tag>
                    <Tag>语义相似 {(c.similarity * 100).toFixed(1)}%</Tag>
                    {c.llm_verdict && (
                      <Tag
                        color={
                          c.llm_verdict.includes('真冲突')
                            ? 'red'
                            : c.llm_verdict.includes('演进')
                              ? 'gold'
                              : 'green'
                        }
                      >
                        AI 复核：{c.llm_verdict}
                      </Tag>
                    )}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {c.diff_summary}
                    </Typography.Text>
                  </Space>
                  <Space size={6}>
                    {onOpenCompare && (
                      <Button
                        size="small"
                        icon={<SwapOutlined />}
                        onClick={() =>
                          onOpenCompare({
                            sourceA: c.source_id,
                            pathA: c.rel_path_a,
                            highlightA: { startLine: c.start_line_a, endLine: c.end_line_a },
                            sourceB: c.source_id,
                            pathB: c.rel_path_b,
                            highlightB: { startLine: c.start_line_b, endLine: c.end_line_b },
                          })
                        }
                      >
                        并排对照
                      </Button>
                    )}
                    <Button
                      size="small"
                      icon={<RobotOutlined />}
                      loading={reviewingId === c.id}
                      onClick={() => handleReviewConflict(c.id)}
                    >
                      AI 复核
                    </Button>
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={() => copyFixPrompt(c.fix_prompt)}
                    >
                      复制修复指令
                    </Button>
                    <Button size="small" onClick={() => handleDismissConflict(c.id)}>
                      忽略
                    </Button>
                  </Space>
                </div>

                {c.llm_reason && (
                  <Alert
                    style={{ marginBottom: 8 }}
                    type={c.llm_verdict.includes('真冲突') ? 'warning' : 'info'}
                    showIcon
                    message={c.llm_reason}
                  />
                )}

                <Row gutter={10}>
                  <Col span={12}>
                    <div
                      className="result-card"
                      style={{ marginBottom: 0 }}
                      onClick={() =>
                        onJumpToDoc?.(c.source_id, c.rel_path_a, {
                          startLine: c.start_line_a,
                          endLine: c.end_line_a,
                        })
                      }
                    >
                      <div className="result-path">
                        A · {c.rel_path_a} (L{c.start_line_a}–L{c.end_line_a})
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-body)', lineHeight: 1.55 }}>
                        {c.snippet_a.slice(0, 220)}
                        {c.snippet_a.length > 220 ? '…' : ''}
                      </div>
                    </div>
                  </Col>
                  <Col span={12}>
                    <div
                      className="result-card"
                      style={{ marginBottom: 0 }}
                      onClick={() =>
                        onJumpToDoc?.(c.source_id, c.rel_path_b, {
                          startLine: c.start_line_b,
                          endLine: c.end_line_b,
                        })
                      }
                    >
                      <div className="result-path">
                        B · {c.rel_path_b} (L{c.start_line_b}–L{c.end_line_b})
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-body)', lineHeight: 1.55 }}>
                        {c.snippet_b.slice(0, 220)}
                        {c.snippet_b.length > 220 ? '…' : ''}
                      </div>
                    </div>
                  </Col>
                </Row>
              </div>
            ))
          )}
        </div>

        {/* 1.8 Duplicate & Near-Duplicate Radar (v1.4, 0 Token, strictly read-only) */}
        <div className="section-card">
          <div className="section-title">
            <span>
              重复与高度近似副本雷达（0 Token 只读扫描 · 完全相同 {duplicates?.exact_count ?? 0} 组 · 高度近似{' '}
              {duplicates?.near_count ?? 0} 对）
            </span>
          </div>
          {!duplicates || (duplicates.exact_count === 0 && duplicates.near_count === 0) ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未发现重复或高度近似的冗余文件" />
          ) : (
            <Row gutter={14}>
              <Col span={12}>
                <Typography.Text strong style={{ fontSize: 12.5, display: 'block', marginBottom: 8 }}>
                  完全相同内容副本（不同目录重复存放）
                </Typography.Text>
                {duplicates.exact_groups.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无完全相同副本" />
                ) : (
                  duplicates.exact_groups.slice(0, 8).map((g) => (
                    <div
                      key={g.content_hash}
                      style={{
                        border: '1px solid var(--border-hairline)',
                        borderRadius: 8,
                        padding: '8px 10px',
                        marginBottom: 8,
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                        {g.files[0]?.title}{' '}
                        <Tag color="orange" style={{ marginLeft: 4 }}>
                          {g.count} 份相同
                        </Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 11, fontWeight: 400 }}>
                          {(g.size_bytes / 1024).toFixed(1)} KB
                        </Typography.Text>
                      </div>
                      {g.files.map((f) => (
                        <div
                          key={`${f.source_id}-${f.rel_path}`}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            fontSize: 11.2,
                            color: 'var(--text-secondary)',
                            padding: '2px 0',
                            gap: 6,
                          }}
                        >
                          <a
                            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            onClick={() => onJumpToDoc?.(f.source_id, f.rel_path)}
                          >
                            {f.source_id}/{f.rel_path}
                          </a>
                          <Button
                            size="small"
                            type="text"
                            icon={<FolderOpenOutlined />}
                            onClick={() => api.openExternal(f.source_id, f.rel_path, 'finder')}
                          />
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </Col>
              <Col span={12}>
                <Typography.Text strong style={{ fontSize: 12.5, display: 'block', marginBottom: 8 }}>
                  高度近似版本（向量相似 ≥ 96.5%，疑似多版本未归并）
                </Typography.Text>
                {duplicates.near_pairs.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无高度近似文档对" />
                ) : (
                  duplicates.near_pairs.slice(0, 8).map((pair, idx) => (
                    <div
                      key={idx}
                      style={{
                        border: '1px solid var(--border-hairline)',
                        borderRadius: 8,
                        padding: '8px 10px',
                        marginBottom: 8,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <Tag color="blue" style={{ margin: 0 }}>
                          相似度 {(pair.similarity * 100).toFixed(1)}%
                        </Tag>
                        {onOpenCompare && (
                          <Button
                            size="small"
                            icon={<SwapOutlined />}
                            onClick={() =>
                              onOpenCompare({
                                sourceA: pair.doc_a.source_id,
                                pathA: pair.doc_a.rel_path,
                                sourceB: pair.doc_b.source_id,
                                pathB: pair.doc_b.rel_path,
                              })
                            }
                          >
                            并排对照差异
                          </Button>
                        )}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-primary)' }}>
                        A: {pair.doc_a.source_id}/{pair.doc_a.rel_path}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                        B: {pair.doc_b.source_id}/{pair.doc_b.rel_path}
                      </div>
                    </div>
                  ))
                )}
              </Col>
            </Row>
          )}
        </div>

        {/* 2. Live Uncommitted Git Changes */}
        {(!isStandalone || (data && data.uncommitted.length > 0)) && (
          <div className="section-card">
            <div className="section-title">
              <span>实时未提交改动（git status）</span>
            </div>
            {data && data.uncommitted.length > 0 ? (
              data.uncommitted.map((repo) => (
                <div
                  key={repo.source_id}
                  style={{
                    border: '1px solid var(--border-hairline)',
                    borderRadius: 8,
                    padding: 12,
                    marginBottom: 10,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 8,
                    }}
                  >
                    <Space>
                      <Typography.Text strong>{repo.source_name}</Typography.Text>
                      <Tag color="orange">{repo.count} 个文件</Tag>
                    </Space>
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={() => copyFixPrompt(repo.fix_prompt)}
                    >
                      复制给 Agent 核对提交
                    </Button>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {repo.files.map((f, i) => (
                      <Tag
                        key={`${f.path}-${i}`}
                        style={{
                          margin: 0,
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          fontSize: 11.5,
                        }}
                      >
                        <span style={{ color: '#b45309', marginRight: 4 }}>{f.status}</span>
                        {f.path}
                      </Tag>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所有仓库工作区干净" />
            )}
          </div>
        )}

        {/* 3. Wiki Health Report (Personal federation only) */}
        {!isStandalone && (
          <div className="section-card">
            <div className="section-title">
              <span>Wiki 结构健康巡检（.health/wiki-health-report.json）</span>
              <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                巡检时间：{data?.wiki_health.timestamp?.slice(0, 19).replace('T', ' ') || '-'} · 孤儿{' '}
                {data?.wiki_health.stats?.orphans ?? 0} · 死链 {data?.wiki_health.stats?.dead_refs ?? 0}
              </Typography.Text>
            </div>
            <Table
              size="small"
              pagination={false}
              rowKey={(r, i) => `${r.repo}-${r.project}-${i}`}
              dataSource={data?.wiki_health.issues || []}
              columns={[
                {
                  title: '级别',
                  dataIndex: 'severity',
                  key: 'severity',
                  width: 80,
                  render: (v: string) => <Tag color={SEV_COLOR[v] || 'default'}>{v}</Tag>,
                },
                { title: '库', dataIndex: 'repo', key: 'repo', width: 110 },
                { title: '模块/项目', dataIndex: 'project', key: 'project', width: 160 },
                { title: '说明', dataIndex: 'message', key: 'message' },
                {
                  title: '操作',
                  dataIndex: 'fix_prompt',
                  key: 'fix_prompt',
                  width: 150,
                  render: (prompt: string, row: any) =>
                    row.severity === 'OK' ? (
                      <Typography.Text type="secondary">-</Typography.Text>
                    ) : (
                      <Button size="small" icon={<CopyOutlined />} onClick={() => copyFixPrompt(prompt)}>
                        复制修复指令
                      </Button>
                    ),
                },
              ]}
            />
          </div>
        )}

        {/* 4. Index Coverage & Non-OK Files */}
        <Row gutter={16}>
          <Col span={12}>
            <div className="section-card">
              <div className="section-title">
                <span>各知识源索引覆盖</span>
              </div>
              <Table
                size="small"
                pagination={false}
                rowKey="source_id"
                dataSource={idx?.by_source || []}
                columns={[
                  { title: '知识源', dataIndex: 'source_id', key: 'source_id' },
                  { title: '文档数', dataIndex: 'docs', key: 'docs', width: 80 },
                  { title: '切块数', dataIndex: 'chunks', key: 'chunks', width: 85 },
                  { title: '失败', dataIndex: 'failed', key: 'failed', width: 65 },
                ]}
              />
            </div>
          </Col>
          <Col span={12}>
            <div className="section-card">
              <div className="section-title">
                <span>解析跳过 / 空文本 / 异常文件（前 100 条）</span>
              </div>
              <Table
                size="small"
                pagination={{ pageSize: 6 }}
                rowKey={(r, i) => `${r.source_id}-${r.rel_path}-${i}`}
                dataSource={idx?.non_ok_files || []}
                columns={[
                  {
                    title: '状态',
                    dataIndex: 'parse_status',
                    key: 'parse_status',
                    width: 80,
                    render: (v: string) => <Tag color={v === 'error' ? 'red' : 'gold'}>{v}</Tag>,
                  },
                  { title: '路径', dataIndex: 'rel_path', key: 'rel_path', ellipsis: true },
                  { title: '说明', dataIndex: 'parse_note', key: 'parse_note', ellipsis: true },
                ]}
              />
            </div>
          </Col>
        </Row>

        {/* 5. Skill Lint Top Issues (Personal federation only) */}
        {!isStandalone && (
          <div className="section-card">
            <div className="section-title">
              <span>共享技能体检（.health/skill-lint.json · Top 30）</span>
            </div>
            <Table
              size="small"
              pagination={{ pageSize: 8 }}
              rowKey="name"
              dataSource={data?.skill_lint.top_items || []}
              columns={[
                { title: '技能名', dataIndex: 'name', key: 'name', width: 220 },
                { title: '行数', dataIndex: 'lines', key: 'lines', width: 70 },
                {
                  title: '检出项',
                  dataIndex: 'issues',
                  key: 'issues',
                  render: (issues: Array<{ code: string; detail: string }>) => (
                    <Space size={4} wrap>
                      {issues.map((it, i) => (
                        <Tag key={i} style={{ margin: 0 }}>
                          {it.code}
                          {it.detail ? `: ${it.detail}` : ''}
                        </Tag>
                      ))}
                    </Space>
                  ),
                },
                {
                  title: '操作',
                  dataIndex: 'fix_prompt',
                  key: 'fix_prompt',
                  width: 140,
                  render: (prompt: string) => (
                    <Button size="small" icon={<CopyOutlined />} onClick={() => copyFixPrompt(prompt)}>
                      复制修复指令
                    </Button>
                  ),
                },
              ]}
            />
          </div>
        )}
      </div>
    </div>
  );
};

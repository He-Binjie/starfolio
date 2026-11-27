import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Empty, Modal, Space, Spin, Tag, Typography, message } from 'antd';
import { CopyOutlined, FolderOpenOutlined, RobotOutlined, SwapOutlined } from '@ant-design/icons';
import { marked } from 'marked';
import { api, CompareDocsResponse, DocumentDetail } from '../api';

export interface CompareTarget {
  sourceA: string;
  pathA: string;
  highlightA?: { startLine: number; endLine: number } | null;
  sourceB: string;
  pathB: string;
  highlightB?: { startLine: number; endLine: number } | null;
}

interface CompareModalProps {
  target: CompareTarget | null;
  onClose: () => void;
  onAskAiCompare?: (docs: Array<{ source_id: string; rel_path: string; title: string }>) => void;
}

function renderDocHtml(
  doc: DocumentDetail,
  hl?: { startLine: number; endLine: number } | null,
  hlId?: string
): string {
  const raw = doc.raw_content || '';
  if (!raw) return '<p style="color:#94a3b8;">（无文本内容）</p>';
  if (doc.is_text && hl && hl.startLine >= 1) {
    const lines = raw.split('\n');
    const s = Math.max(1, hl.startLine);
    const e = Math.min(lines.length, Math.max(s, hl.endLine));
    const before = lines.slice(0, s - 1).join('\n');
    const mid = lines.slice(s - 1, e).join('\n');
    const after = lines.slice(e).join('\n');
    return (
      (before ? (marked.parse(before, { async: false }) as string) : '') +
      `<div id="${hlId || 'cmp-hl'}" class="md-highlight-block">${marked.parse(mid, { async: false }) as string}</div>` +
      (after ? (marked.parse(after, { async: false }) as string) : '')
    );
  }
  return marked.parse(raw, { async: false }) as string;
}

export const CompareModal: React.FC<CompareModalProps> = ({ target, onClose, onAskAiCompare }) => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<CompareDocsResponse | null>(null);
  const [error, setError] = useState('');
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!target) {
      setData(null);
      return;
    }
    setLoading(true);
    setError('');
    api
      .compareDocs(target.sourceA, target.pathA, target.sourceB, target.pathB)
      .then(setData)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [target]);

  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => {
      leftRef.current?.querySelector('#cmp-hl-a')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      rightRef.current?.querySelector('#cmp-hl-b')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
    return () => clearTimeout(t);
  }, [data]);

  const htmlA = useMemo(
    () => (data ? renderDocHtml(data.doc_a, target?.highlightA, 'cmp-hl-a') : ''),
    [data, target?.highlightA]
  );
  const htmlB = useMemo(
    () => (data ? renderDocHtml(data.doc_b, target?.highlightB, 'cmp-hl-b') : ''),
    [data, target?.highlightB]
  );

  return (
    <Modal
      open={Boolean(target)}
      onCancel={onClose}
      footer={null}
      width={1180}
      centered
      destroyOnClose
      styles={{ body: { paddingTop: 8 } }}
      title={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: 28 }}>
          <Space size={8}>
            <SwapOutlined style={{ color: 'var(--accent)' }} />
            <span>双栏并排原文对照（0 Token 数值差异速览）</span>
          </Space>
          {data && (
            <Space size={6}>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => {
                  const lines = [
                    '【星海拾卷 · 双栏对照差异简报（0 Token）】',
                    `1. 文档 A：${data.doc_a.meta.title}（${data.doc_a.meta.rel_path}）`,
                    `2. 文档 B：${data.doc_b.meta.title}（${data.doc_b.meta.rel_path}）`,
                    '',
                    `- 仅文档 A 出现的数字/阈值：${data.diff.only_a_quants.join('、') || '无'}`,
                    `- 仅文档 B 出现的数字/阈值：${data.diff.only_b_quants.join('、') || '无'}`,
                    `- 共同数字：${(data.diff.shared_quants || []).join('、') || '无'}`,
                  ];
                  navigator.clipboard.writeText(lines.join('\n'));
                  message.success('已复制双栏数值差异简报，可直接粘贴到飞书或文档');
                }}
              >
                复制差异简报
              </Button>
              {onAskAiCompare && (
                <Button
                  size="small"
                  type="primary"
                  icon={<RobotOutlined />}
                  onClick={() => {
                    onAskAiCompare([
                      {
                        source_id: data.doc_a.meta.source_id,
                        rel_path: data.doc_a.meta.rel_path,
                        title: data.doc_a.meta.title,
                      },
                      {
                        source_id: data.doc_b.meta.source_id,
                        rel_path: data.doc_b.meta.rel_path,
                        title: data.doc_b.meta.title,
                      },
                    ]);
                    onClose();
                  }}
                >
                  AI 深度对比这两份文档
                </Button>
              )}
            </Space>
          )}
        </div>
      }
    >
      {loading ? (
        <div style={{ padding: 64, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : error ? (
        <Empty description={`对照加载失败：${error}`} />
      ) : data ? (
        <div>
          {/* 0-Token Numeric & Date Diff Strip */}
          <div className="compare-diff-banner">
            <div className="compare-diff-col">
              <span className="compare-diff-label">仅文档 A 出现的数字/阈值：</span>
              {data.diff.only_a_quants.length > 0 ? (
                <Space size={4} wrap>
                  {data.diff.only_a_quants.slice(0, 10).map((q) => (
                    <Tag key={q} color="gold" style={{ margin: 0 }}>
                      {q}
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>无独有数值</Typography.Text>
              )}
            </div>
            <div className="compare-diff-col">
              <span className="compare-diff-label">仅文档 B 出现的数字/阈值：</span>
              {data.diff.only_b_quants.length > 0 ? (
                <Space size={4} wrap>
                  {data.diff.only_b_quants.slice(0, 10).map((q) => (
                    <Tag key={q} color="blue" style={{ margin: 0 }}>
                      {q}
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>无独有数值</Typography.Text>
              )}
            </div>
          </div>

          {/* Twin Scroll Panes */}
          <div className="compare-grid">
            <div className="compare-pane">
              <div className="compare-pane-head">
                <div style={{ minWidth: 0 }}>
                  <div className="compare-pane-title">A · {data.doc_a.meta.title}</div>
                  <div className="compare-pane-path">
                    {data.doc_a.meta.source_id}/{data.doc_a.meta.rel_path} · {data.doc_a.meta.ext}
                  </div>
                </div>
                <Button
                  size="small"
                  type="text"
                  icon={<FolderOpenOutlined />}
                  onClick={() => api.openExternal(data.doc_a.meta.source_id, data.doc_a.meta.rel_path, 'finder')}
                />
              </div>
              <div className="compare-pane-body md-body" ref={leftRef} dangerouslySetInnerHTML={{ __html: htmlA }} />
            </div>

            <div className="compare-pane">
              <div className="compare-pane-head">
                <div style={{ minWidth: 0 }}>
                  <div className="compare-pane-title">B · {data.doc_b.meta.title}</div>
                  <div className="compare-pane-path">
                    {data.doc_b.meta.source_id}/{data.doc_b.meta.rel_path} · {data.doc_b.meta.ext}
                  </div>
                </div>
                <Button
                  size="small"
                  type="text"
                  icon={<FolderOpenOutlined />}
                  onClick={() => api.openExternal(data.doc_b.meta.source_id, data.doc_b.meta.rel_path, 'finder')}
                />
              </div>
              <div className="compare-pane-body md-body" ref={rightRef} dangerouslySetInnerHTML={{ __html: htmlB }} />
            </div>
          </div>
        </div>
      ) : null}
    </Modal>
  );
};

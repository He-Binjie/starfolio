import React, { useEffect, useState } from 'react';
import { Button, Empty, Modal, Space, Spin, Table, Tag, Typography, message } from 'antd';
import { CopyOutlined, TableOutlined } from '@ant-design/icons';
import { api, FactMatrixItem, FactMatrixResponse } from '../api';

interface FactMatrixModalProps {
  docs: Array<{ source_id: string; rel_path: string; title: string }> | null;
  onClose: () => void;
  onJumpToDoc: (sourceId: string, relPath: string, line?: number) => void;
}

export const FactMatrixModal: React.FC<FactMatrixModalProps> = ({ docs, onClose, onJumpToDoc }) => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<FactMatrixResponse | null>(null);

  useEffect(() => {
    if (!docs || docs.length === 0) {
      setData(null);
      return;
    }
    setLoading(true);
    api
      .analyzeFacts(docs)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [docs]);

  const copyMarkdownTable = () => {
    if (!data) return;
    const lines = [
      '【星海拾卷 · 跨文档事实与数字透视（0 Token）】',
      '',
      ...data.items.map((it, i) => {
        const uq = it.unique_quants.join('、') || '无';
        const sq = it.shared_quants.join('、') || '无';
        const dt = it.dates.slice(0, 5).join('、') || '无';
        const ac = it.actions.slice(0, 2).join('；') || '无';
        return `${i + 1}. ${it.title}（${it.rel_path}）\n   - 独有数字/阈值：${uq}\n   - 共同数字：${sq}\n   - 日期节点：${dt}\n   - 待办/风险：${ac}`;
      }),
    ];
    navigator.clipboard.writeText(lines.join('\n'));
    message.success('已复制飞书友好格式的跨文档事实清单');
  };

  return (
    <Modal
      open={Boolean(docs && docs.length > 0)}
      onCancel={onClose}
      footer={null}
      width={1060}
      centered
      destroyOnClose
      title={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: 28 }}>
          <Space size={8}>
            <TableOutlined style={{ color: 'var(--accent)' }} />
            <span>0-Token 跨文档事实与数字透视表（{docs?.length ?? 0} 份文档）</span>
          </Space>
          {data && (
            <Button size="small" icon={<CopyOutlined />} onClick={copyMarkdownTable}>
              复制飞书清单
            </Button>
          )}
        </div>
      }
    >
      {loading ? (
        <div style={{ padding: 56, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : !data || data.items.length === 0 ? (
        <Empty description="未提取到可对比文档" />
      ) : (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 10 }}>
            全程本地正则离线提取，0 Token 消耗。金色标签表示「仅在这份文档里出现的数字/天数/比例」，最容易藏着口径冲突。
          </Typography.Text>
          <Table<FactMatrixItem>
            size="small"
            pagination={false}
            rowKey={(r) => `${r.source_id}::${r.rel_path}`}
            dataSource={data.items}
            scroll={{ y: 460 }}
            columns={[
              {
                title: '文档',
                key: 'doc',
                width: 220,
                render: (_, r) => (
                  <div>
                    <a
                      style={{ fontWeight: 600, fontSize: 12.5 }}
                      onClick={() => {
                        onJumpToDoc(r.source_id, r.rel_path);
                        onClose();
                      }}
                    >
                      {r.title}
                    </a>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                      {r.rel_path} · {r.ext}
                    </div>
                  </div>
                ),
              },
              {
                title: '独有数字 / 阈值（重点排查差异）',
                key: 'unique',
                width: 240,
                render: (_, r) =>
                  r.unique_quants.length > 0 ? (
                    <Space size={4} wrap>
                      {r.unique_quants.map((q) => (
                        <Tag key={q} color="gold" style={{ margin: 0 }}>
                          {q}
                        </Tag>
                      ))}
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">-</Typography.Text>
                  ),
              },
              {
                title: '共同数字 & 日期节点',
                key: 'shared',
                width: 220,
                render: (_, r) => (
                  <Space size={4} wrap>
                    {r.shared_quants.slice(0, 6).map((q) => (
                      <Tag key={q} color="blue" bordered={false} style={{ margin: 0 }}>
                        {q}
                      </Tag>
                    ))}
                    {r.dates.slice(0, 4).map((d) => (
                      <Tag key={d} bordered={false} style={{ margin: 0 }}>
                        {d}
                      </Tag>
                    ))}
                  </Space>
                ),
              },
              {
                title: '待办 / 风险 / 关键句摘录',
                key: 'actions',
                render: (_, r) => {
                  const rows = r.actions.length > 0 ? r.actions : r.quant_contexts.slice(0, 2).map((c) => `L${c.line}: ${c.text}`);
                  return rows.length > 0 ? (
                    <div style={{ fontSize: 11.8, lineHeight: 1.55, color: 'var(--text-body)' }}>
                      {rows.slice(0, 3).map((ln, i) => (
                        <div key={i} style={{ marginBottom: 3 }}>
                          • {ln}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Typography.Text type="secondary">-</Typography.Text>
                  );
                },
              },
            ]}
          />
        </div>
      )}
    </Modal>
  );
};

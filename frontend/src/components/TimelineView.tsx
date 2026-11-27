import React, { useEffect, useState } from 'react';
import { Button, Drawer, Empty, Select, Space, Spin, Tag, Typography } from 'antd';
import { CodeOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, MetaResponse, TimelineEvent } from '../api';

interface TimelineViewProps {
  meta: MetaResponse | null;
  onJumpToDoc: (sourceId: string, relPath: string) => void;
}

const ACTOR_COLOR: Record<string, string> = {
  Antigravity: 'blue',
  'Claude Code': 'orange',
  Codex: 'green',
  Hermes: 'purple',
  DSH: 'cyan',
  夜间兜底: 'gold',
  本地文档: 'blue',
};

function renderDiff(diffText: string) {
  return (
    <pre className="diff-pre">
      {diffText.split('\n').map((line, i) => {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          return (
            <span key={i} className="diff-add">
              {line}
            </span>
          );
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
          return (
            <span key={i} className="diff-del">
              {line}
            </span>
          );
        }
        if (line.startsWith('@@')) {
          return (
            <span key={i} className="diff-hunk">
              {line}
            </span>
          );
        }
        return (
          <span key={i} style={{ display: 'block' }}>
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}

export const TimelineView: React.FC<TimelineViewProps> = ({ meta, onJumpToDoc }) => {
  const [actor, setActor] = useState<string>('all');
  const [sourceId, setSourceId] = useState<string>('all');
  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [actorCounts, setActorCounts] = useState<Record<string, number>>({});

  const [diffOpen, setDiffOpen] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffTitle, setDiffTitle] = useState('');
  const [diffContent, setDiffContent] = useState('');

  const loadTimeline = () => {
    setLoading(true);
    api
      .timeline({ actor, source_id: sourceId, days: days || undefined, limit: 150 })
      .then((res) => {
        setEvents(res.items);
        setActorCounts(res.actor_counts);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadTimeline();
  }, [actor, sourceId, days]);

  const openDiff = (ev: TimelineEvent) => {
    if (!ev.commit) return;
    setDiffTitle(`${ev.source_name} · ${ev.commit.slice(0, 8)} · ${ev.actor}`);
    setDiffOpen(true);
    setDiffLoading(true);
    setDiffContent('');
    api
      .commitDiff(ev.source_id, ev.commit)
      .then((res) => setDiffContent(res.diff))
      .catch((err) => setDiffContent(`读取失败：${err}`))
      .finally(() => setDiffLoading(false));
  };

  const canJumpSource = (sid: string) =>
    Boolean(meta?.sources.some((s) => s.id === sid));

  const isStandalone = meta?.edition === 'standalone';
  const actorNames = Object.keys(actorCounts).filter((a) => (actorCounts[a] || 0) > 0);
  const sourceOptions = [
    { label: isStandalone ? '全部资料库' : '全部仓库 / 审计源', value: 'all' },
    ...(meta?.sources || []).map((s) => ({ label: s.name, value: s.id })),
    ...(!isStandalone
      ? [
          { label: '共享技能库（~/.agents/skills）', value: 'shared-skills' },
          { label: '非 Git 宿主配置', value: 'non-git' },
        ]
      : []),
  ];

  return (
    <div className="page-scroll">
      <div className="page-container">
        <div className="section-card">
          <div className="section-title">
            <span>
              {isStandalone
                ? '文档变更时间线（Git 提交记录 / 最近修改文件）'
                : '多端变更时间线（合并审计日志与各库 Git Log）'}
            </span>
            <Button size="small" icon={<ReloadOutlined />} onClick={loadTimeline}>
              刷新
            </Button>
          </div>

          <Space size={8} wrap style={{ marginBottom: 12 }}>
            <Tag
              color={actor === 'all' ? 'blue' : 'default'}
              style={{ cursor: 'pointer', padding: '2px 8px' }}
              onClick={() => setActor('all')}
            >
              全部来源 ({Object.values(actorCounts).reduce((a, b) => a + b, 0)})
            </Tag>
            {actorNames.map((a) => (
              <Tag
                key={a}
                color={actor === a ? ACTOR_COLOR[a] || 'blue' : 'default'}
                style={{ cursor: 'pointer', padding: '2px 8px' }}
                onClick={() => setActor(actor === a ? 'all' : a)}
              >
                {a} ({actorCounts[a]})
              </Tag>
            ))}
          </Space>

          <Space size={8} wrap>
            <Select
              size="small"
              style={{ width: 220 }}
              value={sourceId}
              onChange={setSourceId}
              options={sourceOptions}
            />
            <Select
              size="small"
              style={{ width: 120 }}
              value={days}
              onChange={setDays}
              options={[
                { label: '近 7 天', value: 7 },
                { label: '近 30 天', value: 30 },
                { label: '近 90 天', value: 90 },
                { label: '全部历史', value: 0 },
              ]}
            />
          </Space>
        </div>

        <div className="section-card">
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : events.length === 0 ? (
            <Empty description="当前筛选条件下没有变更记录" />
          ) : (
            events.map((ev) => (
              <div
                key={ev.id}
                style={{
                  padding: '12px 4px',
                  borderBottom: '1px solid var(--border-hairline)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 12,
                  }}
                >
                  <div>
                    <Space size={6} wrap>
                      <Tag color={ACTOR_COLOR[ev.actor] || 'default'}>{ev.actor}</Tag>
                      <Tag>{ev.source_name}</Tag>
                      {ev.commit && (
                        <Typography.Text code style={{ fontSize: 11.5 }}>
                          {ev.commit.slice(0, 8)}
                        </Typography.Text>
                      )}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {ev.timestamp.replace('T', ' ').slice(0, 19)}
                      </Typography.Text>
                    </Space>
                    <div style={{ marginTop: 6, fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)' }}>
                      {ev.message}
                    </div>
                  </div>
                  {ev.commit && (
                    <Button size="small" icon={<CodeOutlined />} onClick={() => openDiff(ev)}>
                      查看 Diff
                    </Button>
                  )}
                </div>

                {ev.paths.length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {ev.paths.slice(0, 14).map((p, idx) => {
                      const jumpable = canJumpSource(ev.source_id) && p.status !== 'D';
                      return (
                        <Tag
                          key={`${p.path}-${idx}`}
                          style={{
                            margin: 0,
                            cursor: jumpable ? 'pointer' : 'default',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            fontSize: 11.5,
                          }}
                          onClick={() => {
                            if (jumpable) onJumpToDoc(ev.source_id, p.path);
                          }}
                        >
                          <span style={{ color: '#6b7280', marginRight: 4 }}>{p.status}</span>
                          {p.path}
                        </Tag>
                      );
                    })}
                    {ev.paths.length > 14 && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        +{ev.paths.length - 14} 个文件
                      </Typography.Text>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <Drawer
        title={diffTitle}
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
        width={760}
      >
        {diffLoading ? (
          <div style={{ padding: 48, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : (
          renderDiff(diffContent)
        )}
      </Drawer>
    </div>
  );
};

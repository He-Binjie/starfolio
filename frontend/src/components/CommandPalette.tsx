import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Input, Modal, Tag, Typography } from 'antd';
import {
  AppstoreOutlined,
  ClockCircleOutlined,
  FileTextOutlined,
  FolderOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { api, QuickJumpResponse } from '../api';

export type NavTab = 'workspace' | 'projects' | 'timeline' | 'health';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onSelectDoc: (sourceId: string, relPath: string) => void;
  onSelectProject: (sourceId: string, project: string) => void;
  onSwitchTab: (tab: NavTab) => void;
}

interface PaletteItem {
  key: string;
  group: '导航' | '项目' | '文档';
  title: string;
  subtitle: string;
  badge?: string;
  muted?: boolean;
  onRun: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  onSelectDoc,
  onSelectProject,
  onSwitchTab,
}) => {
  const [query, setQuery] = useState('');
  const [data, setData] = useState<QuickJumpResponse>({ documents: [], projects: [] });
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<any>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api
        .quickJump(query)
        .then((res) => {
          setData(res);
          setActiveIdx(0);
        })
        .catch(() => {});
    }, 100);
    return () => clearTimeout(t);
  }, [open, query]);

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    const low = query.trim().toLowerCase();

    const navItems: Array<{ tab: NavTab; title: string; subtitle: string; kw: string }> = [
      { tab: 'workspace', title: '切换到：工作台（检索 + 出处问答）', subtitle: '混合检索、勾选文档问答与原文核对', kw: '工作台 检索 问答 search qa' },
      { tab: 'projects', title: '切换到：项目聚合', subtitle: '开会前 1 分钟速览与项目资料全貌', kw: '项目聚合 project hub' },
      { tab: 'timeline', title: '切换到：五宿主时间线', subtitle: '查看各 Agent 变更与 Commit Diff', kw: '时间线 timeline git diff' },
      { tab: 'health', title: '切换到：治理中心', subtitle: '系统告警、口径冲突候选、未提交改动', kw: '治理 健康 告警 冲突 health conflict' },
    ];
    navItems.forEach((n) => {
      if (!low || n.kw.includes(low) || n.title.toLowerCase().includes(low)) {
        out.push({
          key: `nav::${n.tab}`,
          group: '导航',
          title: n.title,
          subtitle: n.subtitle,
          onRun: () => {
            onSwitchTab(n.tab);
            onClose();
          },
        });
      }
    });

    data.projects.forEach((p) => {
      out.push({
        key: `proj::${p.source_id}::${p.project}`,
        group: '项目',
        title: p.project,
        subtitle: `${p.source_id} · ${p.doc_count} 份文档`,
        badge: '项目',
        onRun: () => {
          onSelectProject(p.source_id, p.project);
          onClose();
        },
      });
    });

    data.documents.forEach((d) => {
      out.push({
        key: `doc::${d.source_id}::${d.rel_path}`,
        group: '文档',
        title: d.title,
        subtitle: `${d.source_id} / ${d.rel_path}`,
        badge: d.is_historical ? '历史' : d.ext,
        muted: d.is_historical,
        onRun: () => {
          onSelectDoc(d.source_id, d.rel_path);
          onClose();
        },
      });
    });

    return out;
  }, [query, data, onSwitchTab, onSelectProject, onSelectDoc, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && items[activeIdx]) {
      e.preventDefault();
      items[activeIdx].onRun();
    }
  };

  const renderIcon = (item: PaletteItem) => {
    if (item.group === '项目') return <FolderOutlined style={{ color: '#4f46e5' }} />;
    if (item.group === '文档') return <FileTextOutlined style={{ color: '#64748b' }} />;
    if (item.key.includes('projects')) return <AppstoreOutlined style={{ color: '#64748b' }} />;
    if (item.key.includes('timeline')) return <ClockCircleOutlined style={{ color: '#64748b' }} />;
    if (item.key.includes('health')) return <SafetyCertificateOutlined style={{ color: '#64748b' }} />;
    return <SearchOutlined style={{ color: '#64748b' }} />;
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={620}
      styles={{ body: { padding: 0 } }}
      className="cmdk-modal"
    >
      <div onKeyDown={handleKeyDown}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-hairline)' }}>
          <Input
            ref={inputRef}
            variant="borderless"
            size="large"
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            placeholder="输入文档名、路径、项目名，或切换视图…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            suffix={<Typography.Text type="secondary" style={{ fontSize: 11 }}>ESC 关闭</Typography.Text>}
          />
        </div>
        <div style={{ maxHeight: 420, overflowY: 'auto', padding: '6px 8px' }}>
          {items.length === 0 ? (
            <div style={{ padding: 28, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
              没有匹配的文档或项目
            </div>
          ) : (
            items.map((item, idx) => (
              <div
                key={item.key}
                className={`cmdk-item${idx === activeIdx ? ' active' : ''}`}
                style={{ opacity: item.muted ? 0.68 : 1 }}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={item.onRun}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                  {renderIcon(item)}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="cmdk-title">{item.title}</div>
                    <div className="cmdk-sub">{item.subtitle}</div>
                  </div>
                </div>
                {item.badge && (
                  <Tag bordered={false} style={{ margin: 0, fontSize: 11 }}>
                    {item.badge}
                  </Tag>
                )}
              </div>
            ))
          )}
        </div>
        <div className="cmdk-footer">
          <span>↑↓ 选择</span>
          <span>↵ 打开</span>
          <span>⌘K 随时呼出</span>
        </div>
      </div>
    </Modal>
  );
};

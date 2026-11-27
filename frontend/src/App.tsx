import React, { useEffect, useMemo, useState } from 'react';
import { ConfigProvider, Modal, Tooltip, message, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {
  AppstoreOutlined,
  ClockCircleOutlined,
  DesktopOutlined,
  FolderAddOutlined,
  MoonOutlined,
  QuestionCircleOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SettingOutlined,
  SunOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { api, HealthResponse, MetaResponse } from './api';
import { CommandPalette, NavTab } from './components/CommandPalette';
import { UnifiedWorkspace } from './components/UnifiedWorkspace';
import { ProjectsView } from './components/ProjectsView';
import { TimelineView } from './components/TimelineView';
import { HealthView } from './components/HealthView';
import { OnboardingModal } from './components/OnboardingModal';
import { SettingsDrawer } from './components/SettingsDrawer';
import { CompareModal, CompareTarget } from './components/CompareModal';

type ThemePref = 'system' | 'light' | 'dark';

declare global {
  interface Window {
    __KB_NATIVE_MAC__?: boolean;
    __kbOpenCmdK?: () => void;
    __kbSetTheme?: (pref: ThemePref) => void;
    __kbTriggerSync?: () => void;
    webkit?: {
      messageHandlers?: {
        kbNative?: {
          postMessage: (msg: Record<string, any>) => void;
        };
      };
    };
  }
}

function postNative(msg: Record<string, any>) {
  try {
    window.webkit?.messageHandlers?.kbNative?.postMessage(msg);
  } catch {
    // Ignore when running inside normal browser
  }
}

export const App: React.FC = () => {
  const [tab, setTab] = useState<NavTab>('workspace');
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [autoGuideShown, setAutoGuideShown] = useState(false);
  const [isNativeMac, setIsNativeMac] = useState<boolean>(Boolean(window.__KB_NATIVE_MAC__));

  const [themePref, setThemePref] = useState<ThemePref>(() => {
    const saved = localStorage.getItem('kb_theme_pref');
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
  });
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  );

  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [healthSummary, setHealthSummary] = useState<{
    alerts: number;
    uncommittedRepos: number;
  }>({ alerts: 0, uncommittedRepos: 0 });
  const [jumpDoc, setJumpDoc] = useState<{
    sourceId: string;
    relPath: string;
    highlight?: { startLine: number; endLine: number } | null;
  } | null>(null);
  const [jumpProject, setJumpProject] = useState<{ sourceId: string; project: string } | null>(null);
  const [fenceDocs, setFenceDocs] = useState<Array<{ source_id: string; rel_path: string; title: string }> | null>(null);
  const [compareTarget, setCompareTarget] = useState<CompareTarget | null>(null);
  const [folderDragging, setFolderDragging] = useState(false);

  const resolvedDark = themePref === 'dark' || (themePref === 'system' && systemDark);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    localStorage.setItem('kb_theme_pref', themePref);
    document.documentElement.setAttribute('data-theme', resolvedDark ? 'dark' : 'light');
    postNative({ type: 'theme', value: themePref });
  }, [themePref, resolvedDark]);

  useEffect(() => {
    // Detect late native flag injection
    if (window.__KB_NATIVE_MAC__) setIsNativeMac(true);
    window.__kbOpenCmdK = () => setCmdkOpen(true);
    window.__kbSetTheme = (pref: ThemePref) => setThemePref(pref);
    window.__kbTriggerSync = () => handleRefreshIndex();
    (window as any).__kbSwitchTab = (num: string) => {
      const map: Record<string, NavTab> = { '1': 'workspace', '2': 'projects', '3': 'timeline', '4': 'health' };
      if (map[num]) setTab(map[num]);
    };
    (window as any).__kbOpenSettings = () => setSettingsOpen(true);
    (window as any).__kbOpenGuide = () => setGuideOpen(true);
    (window as any).__kbOnPathsPicked = async (paths: string[]) => {
      if (!Array.isArray(paths) || paths.length === 0) return;
      try {
        const res = await api.addPaths(paths);
        const parts: string[] = [];
        if (res.added_folders.length > 0) parts.push(`${res.added_folders.length} 个文件夹`);
        if (res.added_files.length > 0) parts.push(`${res.added_files.length} 份零散文件`);
        if (parts.length > 0) {
          message.success(`已只读拾取 ${parts.join(' + ')}，后台正在建立索引与语义向量`);
        } else if (res.already_existing.length > 0) {
          message.info('所选内容已在知识库索引中');
        }
        if (res.skipped_unsupported.length > 0) {
          message.warning(`已跳过暂不支持的格式：${res.skipped_unsupported.slice(0, 4).join('、')}`);
        }
        loadMetaAndSummary();
      } catch (err) {
        message.error(`拾取失败：${String(err)}`);
      }
    };
    (window as any).__kbOnFolderDragState = (active: boolean) => setFolderDragging(Boolean(active));
    (window as any).__kbOnFolderDropped = (paths: string[]) => {
      setFolderDragging(false);
      if (!Array.isArray(paths) || paths.length === 0) return;
      Modal.confirm({
        title: `以纯本地只读方式拾取 ${paths.length} 项文件 / 文件夹？`,
        content: (
          <div style={{ fontSize: 12.5, lineHeight: 1.65 }}>
            <div style={{ marginBottom: 6 }}>
              支持直接拖入单个/多个文件或整个文件夹，仅建本机离线索引，绝不复制、上传或改动原文件：
            </div>
            {paths.slice(0, 10).map((p) => (
              <div
                key={p}
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 11.5,
                  wordBreak: 'break-all',
                  padding: '2px 0',
                }}
              >
                {p}
              </div>
            ))}
            {paths.length > 10 && (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                …另有 {paths.length - 10} 项
              </div>
            )}
          </div>
        ),
        okText: '确认只读拾取',
        cancelText: '取消',
        onOk: async () => {
          try {
            const res = await api.addPaths(paths);
            const parts: string[] = [];
            if (res.added_folders.length > 0) parts.push(`${res.added_folders.length} 个文件夹`);
            if (res.added_files.length > 0) parts.push(`${res.added_files.length} 份零散文件`);
            if (parts.length > 0) {
              message.success(`已只读接入 ${parts.join(' + ')}，后台正在建立索引与语义向量`);
            } else if (res.already_existing.length > 0) {
              message.info('所选内容已在知识库索引中');
            }
            if (res.skipped_unsupported.length > 0) {
              message.warning(`已跳过暂不支持的格式：${res.skipped_unsupported.slice(0, 4).join('、')}`);
            }
            loadMetaAndSummary();
          } catch (err) {
            message.error(`拾取失败：${String(err)}`);
          }
        },
      });
    };
    return () => {
      delete window.__kbOpenCmdK;
      delete window.__kbSetTheme;
      delete window.__kbTriggerSync;
      delete (window as any).__kbSwitchTab;
      delete (window as any).__kbOpenSettings;
      delete (window as any).__kbOpenGuide;
      delete (window as any).__kbOnFolderDragState;
      delete (window as any).__kbOnFolderDropped;
    };
  }, []);

  const loadMetaAndSummary = () => {
    api
      .meta()
      .then((m) => {
        setMeta(m);
        if (m.is_first_run && !autoGuideShown) {
          setAutoGuideShown(true);
          setGuideOpen(true);
        }
      })
      .catch(() => {});
    api
      .health()
      .then((h: HealthResponse) => {
        setHealthSummary({
          alerts: h.alerts.count,
          uncommittedRepos: h.uncommitted.length,
        });
        postNative({
          type: 'status',
          docs: h.index_status?.totals?.documents ?? 0,
          alerts: h.alerts.count,
        });
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadMetaAndSummary();
    const timer = setInterval(() => {
      Promise.all([api.indexStatus(), api.vectorsStatus()])
        .then(([st, vec]) => {
          setMeta((prev) => (prev ? { ...prev, index_status: st, vector_status: vec } : prev));
        })
        .catch(() => {});
    }, 8000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdkOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        const map: Record<string, NavTab> = { '1': 'workspace', '2': 'projects', '3': 'timeline', '4': 'health' };
        setTab(map[e.key]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleRefreshIndex = async () => {
    const res = await api.refreshIndex(false);
    if (res.started) {
      message.info('后台增量索引与向量补齐已启动');
      setTimeout(loadMetaAndSummary, 2500);
    } else {
      message.info('索引任务正在运行');
    }
  };

  const cycleTheme = () => {
    setThemePref((prev) => (prev === 'system' ? 'dark' : prev === 'dark' ? 'light' : 'system'));
  };

  const handleJumpToDoc = (
    sourceId: string,
    relPath: string,
    highlight?: { startLine: number; endLine: number } | null
  ) => {
    setJumpDoc({ sourceId, relPath, highlight });
    setTab('workspace');
  };

  const handleJumpToProject = (sourceId: string, project: string) => {
    setJumpProject({ sourceId, project });
    setTab('projects');
  };

  const handleTitlebarMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    if (!isNativeMac) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, .nav-tabs')) return;
    postNative({ type: 'dragWindow' });
  };

  const antdThemeConfig = useMemo(
    () => ({
      algorithm: resolvedDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: resolvedDark ? '#3b82f6' : '#2563eb',
        colorBgContainer: resolvedDark ? '#212328' : '#ffffff',
        colorBgElevated: resolvedDark ? '#262930' : '#ffffff',
        colorBorderSecondary: resolvedDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)',
        borderRadius: 7,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', sans-serif",
        fontSize: 13,
      },
    }),
    [resolvedDark]
  );

  const idx = meta?.index_status;
  const vec = meta?.vector_status;

  const themeIcon =
    themePref === 'system' ? <DesktopOutlined /> : themePref === 'dark' ? <MoonOutlined /> : <SunOutlined />;
  const themeLabel =
    themePref === 'system' ? '跟随系统' : themePref === 'dark' ? '深色' : '浅色';

  return (
    <ConfigProvider locale={zhCN} theme={antdThemeConfig}>
      <div className={`app-shell${isNativeMac ? ' is-native-mac' : ''}`}>
        <header className="topbar" onMouseDown={handleTitlebarMouseDown}>
          <div className="topbar-left">
            <div className="brand">
              <span className="brand-dot" />
              <span className="brand-title">星海拾卷</span>
            </div>
            <nav className="nav-tabs">
              <button
                className={`nav-tab${tab === 'workspace' ? ' active' : ''}`}
                onClick={() => setTab('workspace')}
              >
                <SearchOutlined />
                <span>工作台</span>
              </button>
              <button
                className={`nav-tab${tab === 'projects' ? ' active' : ''}`}
                onClick={() => setTab('projects')}
              >
                <AppstoreOutlined />
                <span>项目</span>
              </button>
              <button
                className={`nav-tab${tab === 'timeline' ? ' active' : ''}`}
                onClick={() => setTab('timeline')}
              >
                <ClockCircleOutlined />
                <span>时间线</span>
              </button>
              <button
                className={`nav-tab${tab === 'health' ? ' active' : ''}`}
                onClick={() => setTab('health')}
              >
                <SafetyCertificateOutlined />
                <span>治理</span>
                {healthSummary.alerts > 0 && (
                  <span className="nav-pill">{healthSummary.alerts}</span>
                )}
              </button>
            </nav>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button type="button" className="cmdk-trigger" onClick={() => setCmdkOpen(true)}>
              <SearchOutlined />
              <span>跳转…</span>
              <span className="cmdk-kbd">⌘K</span>
            </button>
            <Tooltip title={`外观主题：${themeLabel}（点击切换 自动 / 深色 / 浅色）`}>
              <button type="button" className="icon-pill-btn" onClick={cycleTheme}>
                {themeIcon}
                <span>{themeLabel}</span>
              </button>
            </Tooltip>
            <Tooltip title="增量同步全文与本地语义向量（只读）">
              <button type="button" className="icon-pill-btn" onClick={handleRefreshIndex}>
                <SyncOutlined spin={idx?.progress.running || vec?.progress.running} />
                <span>
                  {idx?.progress.running
                    ? '索引中'
                    : vec?.progress.running
                      ? `${vec.coverage_pct}%`
                      : '同步'}
                </span>
              </button>
            </Tooltip>
            <Tooltip title="快速上手引导与功能速查">
              <button type="button" className="icon-pill-btn" onClick={() => setGuideOpen(true)}>
                <QuestionCircleOutlined />
                <span>引导</span>
              </button>
            </Tooltip>
            <Tooltip title="管理本地文件夹、AI 模型接口与隐私排除规则（⌘,）">
              <button type="button" className="icon-pill-btn" onClick={() => setSettingsOpen(true)}>
                <SettingOutlined />
                <span>设置</span>
              </button>
            </Tooltip>
          </div>
        </header>

        <main className="main-area">
          {tab === 'workspace' && (
            <UnifiedWorkspace
              meta={meta}
              externalTarget={jumpDoc}
              onClearExternalTarget={() => setJumpDoc(null)}
              externalFenceDocs={fenceDocs}
              onClearExternalFenceDocs={() => setFenceDocs(null)}
              onOpenCompare={setCompareTarget}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenGuide={() => setGuideOpen(true)}
            />
          )}
          {tab === 'projects' && (
            <ProjectsView
              externalProject={jumpProject}
              onClearExternalProject={() => setJumpProject(null)}
              onJumpToDoc={handleJumpToDoc}
              onOpenCompare={setCompareTarget}
              onFenceClusterDocs={(docs, clusterTitle) => {
                setFenceDocs(docs);
                setTab('workspace');
                message.success(`已将「${clusterTitle}」的 ${docs.length} 份核心文档拉入 AI 对比围栏`);
              }}
            />
          )}
          {tab === 'timeline' && <TimelineView meta={meta} onJumpToDoc={handleJumpToDoc} />}
          {tab === 'health' && (
            <HealthView
              onIndexRefreshed={loadMetaAndSummary}
              onJumpToDoc={handleJumpToDoc}
              onOpenCompare={setCompareTarget}
            />
          )}
        </main>

        <footer className="statusbar">
          <div className="statusbar-group">
            <span>严格只读 · {meta?.sources.length ?? 0} 个资料库</span>
            <span>{idx?.totals.documents ?? 0} 文档 · {idx?.totals.chunks ?? 0} 切块</span>
            <span>向量 {vec ? `${vec.coverage_pct}%` : '-'}</span>
            {meta?.edition !== 'standalone' && (
              <>
                <span>告警 {healthSummary.alerts}</span>
                <span>未提交 {healthSummary.uncommittedRepos}</span>
              </>
            )}
          </div>
          <div className="statusbar-group">
            <span>{isNativeMac ? '⌥Space 全局呼出 · ⌘, 设置' : '本机只读服务'}</span>
            <span>{meta?.watcher_active ? '实时监听' : '轮询'}</span>
          </div>
        </footer>

        <CommandPalette
          open={cmdkOpen}
          onClose={() => setCmdkOpen(false)}
          onSelectDoc={(sid, rp) => handleJumpToDoc(sid, rp)}
          onSelectProject={(sid, proj) => handleJumpToProject(sid, proj)}
          onSwitchTab={(t) => setTab(t)}
        />

        <SettingsDrawer
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onDataChanged={loadMetaAndSummary}
          onOpenGuide={() => setGuideOpen(true)}
        />

        <OnboardingModal
          open={guideOpen}
          onClose={() => setGuideOpen(false)}
          onDataChanged={loadMetaAndSummary}
        />

        <CompareModal
          target={compareTarget}
          onClose={() => setCompareTarget(null)}
          onAskAiCompare={(docs) => {
            setFenceDocs(docs);
            setTab('workspace');
            message.success('已将这两份对照文档拉入 AI 围栏，可点击「对比异同与口径差异」');
          }}
        />

        {folderDragging && (
          <div className="drop-overlay">
            <div className="drop-overlay-card">
              <FolderAddOutlined style={{ fontSize: 38, color: 'var(--accent)', marginBottom: 12 }} />
              <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-primary)' }}>
                松手以只读方式拾取文件或文件夹
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 6 }}>
                支持单个/多个文档（PDF / Word / PPT / Excel / Markdown）或整个文件夹 · 不上传不改原件
              </div>
            </div>
          </div>
        )}
      </div>
    </ConfigProvider>
  );
};

export default App;

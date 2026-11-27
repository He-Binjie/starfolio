import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  Drawer,
  Input,
  Popconfirm,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  ApiOutlined,
  CloseOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  FileAddOutlined,
  FolderAddOutlined,
  QuestionCircleOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { api, SettingsResponse } from '../api';
import { fileManagerName, isWindowsPlatform, triggerPathPicker } from '../platform';

interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  onDataChanged: () => void;
  onOpenGuide: () => void;
}

const API_PRESETS = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  {
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  {
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-72B-Instruct',
  },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
];

export const SettingsDrawer: React.FC<SettingsDrawerProps> = ({
  open,
  onClose,
  onDataChanged,
  onOpenGuide,
}) => {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [adding, setAdding] = useState(false);
  const [loadingSample, setLoadingSample] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [showManual, setShowManual] = useState(false);

  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1');
  const [model, setModel] = useState('deepseek-chat');
  const [apiKey, setApiKey] = useState('');
  const [savingApi, setSavingApi] = useState(false);
  const [testingApi, setTestingApi] = useState(false);
  const [testRes, setTestRes] = useState<{ ok: boolean; latency_ms: number; error?: string } | null>(null);

  const [keywordsText, setKeywordsText] = useState('');
  const [savingKw, setSavingKw] = useState(false);

  const isWin = isWindowsPlatform();
  const fmName = fileManagerName();

  const loadSettings = () => {
    api
      .settings()
      .then((s) => {
        setSettings(s);
        setBaseUrl(s.openai_api.base_url || 'https://api.deepseek.com/v1');
        setModel(s.openai_api.model || 'deepseek-chat');
        setKeywordsText((s.exclude_keywords || []).join(', '));
      })
      .catch(() => {});
  };

  useEffect(() => {
    if (open) {
      setApiKey('');
      setTestRes(null);
      loadSettings();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prevFolderHandler = (window as any).__kbOnFolderPicked;
    const prevPathsHandler = (window as any).__kbOnPathsPicked;

    const handlePickedList = async (paths: string[]) => {
      if (!paths || paths.length === 0) return;
      setAdding(true);
      try {
        const res = await api.addPaths(paths);
        const parts: string[] = [];
        if (res.added_folders.length > 0) parts.push(`${res.added_folders.length} 个文件夹`);
        if (res.added_files.length > 0) parts.push(`${res.added_files.length} 份本地文件`);
        if (parts.length > 0) {
          message.success(`已只读接入 ${parts.join(' + ')}，后台开始建索引`);
        } else if (res.already_existing.length > 0) {
          message.info('所选内容已在索引中');
        }
        if (res.skipped_unsupported.length > 0) {
          message.warning(`已跳过暂不支持的文件：${res.skipped_unsupported.slice(0, 4).join('、')}`);
        }
        loadSettings();
        onDataChanged();
      } catch (err) {
        message.error(String(err));
      } finally {
        setAdding(false);
      }
    };

    (window as any).__kbOnPathsPicked = handlePickedList;
    (window as any).__kbOnFolderPicked = (pickedPath: string) => handlePickedList([pickedPath]);
    return () => {
      (window as any).__kbOnFolderPicked = prevFolderHandler;
      (window as any).__kbOnPathsPicked = prevPathsHandler;
    };
  }, [open, onDataChanged]);

  const handlePickNative = async (mode: 'any' | 'files' | 'folder') => {
    const status = await triggerPathPicker(mode);
    if (status === 'fallback_manual') {
      setShowManual(true);
    }
  };

  const handleAddManual = async () => {
    const p = manualPath.trim();
    if (!p) return;
    setAdding(true);
    try {
      await api.addPaths([p]);
      setManualPath('');
      setShowManual(false);
      message.success('已接入本地路径（纯本地只读），后台开始建索引');
      loadSettings();
      onDataChanged();
    } catch (err) {
      message.error(String(err));
    } finally {
      setAdding(false);
    }
  };

  const handleRemovePickedFile = async (sourceId: string, filePath: string) => {
    try {
      await api.removePickedFile(filePath, sourceId);
      message.success('已移出该零散文件索引（磁盘原文件完好无损）');
      loadSettings();
      onDataChanged();
    } catch (err) {
      message.error(String(err));
    }
  };

  const handleRemoveSource = async (sid: string) => {
    try {
      await api.removeSource(sid);
      message.success('已从索引中移除该目录（磁盘原文件未受影响）');
      loadSettings();
      onDataChanged();
    } catch (err) {
      message.error(String(err));
    }
  };

  const handleLoadSample = async () => {
    setLoadingSample(true);
    try {
      await api.loadSampleKb();
      message.success('示例知识库已载入并完成索引');
      loadSettings();
      onDataChanged();
    } catch (err) {
      message.error(String(err));
    } finally {
      setLoadingSample(false);
    }
  };

  const handleSaveApi = async (clearKey = false) => {
    setSavingApi(true);
    try {
      await api.saveOpenAi({
        enabled: !clearKey,
        base_url: baseUrl,
        api_key: apiKey,
        model,
        clear_key: clearKey,
      });
      setApiKey('');
      message.success(clearKey ? '已清空本地保存的 API Key' : '模型 API 配置已保存');
      loadSettings();
      onDataChanged();
    } catch (err) {
      message.error(`保存失败：${String(err)}`);
    } finally {
      setSavingApi(false);
    }
  };

  const handleTestApi = async () => {
    setTestingApi(true);
    setTestRes(null);
    try {
      const res = await api.testOpenAi({ base_url: baseUrl, api_key: apiKey, model });
      setTestRes(res);
    } catch (err) {
      setTestRes({ ok: false, latency_ms: 0, error: String(err) });
    } finally {
      setTestingApi(false);
    }
  };

  const handleSaveKeywords = async () => {
    setSavingKw(true);
    try {
      const list = keywordsText
        .split(/[,，\n]/)
        .map((x) => x.trim())
        .filter(Boolean);
      await api.saveExcludeKeywords(list);
      message.success('隐私排除关键词已更新');
      loadSettings();
      onDataChanged();
    } catch (err) {
      message.error(String(err));
    } finally {
      setSavingKw(false);
    }
  };

  return (
    <Drawer
      title="设置 · 知识源与模型配置"
      open={open}
      onClose={onClose}
      width={560}
      extra={
        <Button
          size="small"
          icon={<QuestionCircleOutlined />}
          onClick={() => {
            onClose();
            onOpenGuide();
          }}
        >
          打开使用引导
        </Button>
      }
    >
      {/* 1. Sources */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
          <Typography.Text strong style={{ fontSize: 13.5 }}>
            1. 本地文件夹与零散文件（纯本地只读，无需上传）
          </Typography.Text>
          <Space size={6} wrap>
            {settings?.sample_available && (
              <Button size="small" icon={<ExperimentOutlined />} loading={loadingSample} onClick={handleLoadSample}>
                示例库
              </Button>
            )}
            <Button size="small" icon={<FileAddOutlined />} loading={adding} onClick={() => handlePickNative('files')}>
              选文件(多选)
            </Button>
            <Button size="small" type="primary" icon={<FolderAddOutlined />} loading={adding} onClick={() => handlePickNative('folder')}>
              选文件夹
            </Button>
          </Space>
        </div>

        {showManual && (
          <Space.Compact style={{ width: '100%', marginBottom: 10 }}>
            <Input
              size="small"
              placeholder={
                isWin
                  ? '输入本机文件或文件夹路径，如 C:\\Users\\你的名字\\Downloads\\方案.pdf'
                  : '输入本机文件或文件夹路径，如 ~/Downloads/方案.pdf 或 ~/Documents/Notes'
              }
              value={manualPath}
              onChange={(e) => setManualPath(e.target.value)}
              onPressEnter={handleAddManual}
            />
            <Button size="small" type="primary" loading={adding} onClick={handleAddManual}>
              确定
            </Button>
          </Space.Compact>
        )}

        {settings && settings.sources.length > 0 ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {settings.sources.map((s) => (
              <div
                key={s.id}
                style={{
                  border: '1px solid var(--border-hairline)',
                  borderRadius: 8,
                  padding: '8px 10px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>
                      {s.name}{' '}
                      {s.kind === 'files' && (
                        <Tag color="blue" style={{ fontSize: 11 }}>
                          {s.files?.length ?? 0} 份零散文件
                        </Tag>
                      )}
                      {s.is_git && <Tag style={{ fontSize: 11 }}>Git</Tag>}
                      {!s.exists && <Tag color="red">路径不存在</Tag>}
                    </div>
                    {s.kind !== 'files' && (
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 11.5, display: 'block', wordBreak: 'break-all' }}
                      >
                        {s.path}
                      </Typography.Text>
                    )}
                  </div>
                  <Popconfirm
                    title={s.kind === 'files' ? '清空所有零散文件索引？' : '仅从检索索引移除该目录？'}
                    description="磁盘上的原始文件不会被删除或改动。"
                    okText="移除索引"
                    cancelText="取消"
                    onConfirm={() => handleRemoveSource(s.id)}
                  >
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </div>
                {s.kind === 'files' && s.files && s.files.length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {s.files.map((fp) => {
                      const base = fp.split(/[/\\]/).pop() || fp;
                      return (
                        <div
                          key={fp}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 6,
                            padding: '4px 8px',
                            borderRadius: 6,
                            background: 'var(--bg-subtle)',
                            fontSize: 11.5,
                          }}
                        >
                          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fp}>
                            <strong>{base}</strong>{' '}
                            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                              ({fp})
                            </Typography.Text>
                          </span>
                          <Button
                            size="small"
                            type="text"
                            icon={<CloseOutlined style={{ fontSize: 10 }} />}
                            onClick={() => handleRemovePickedFile(s.id, fp)}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </Space>
        ) : (
          <Alert
            type="warning"
            showIcon
            message="暂未接入任何文件或文件夹"
            description={`点击上方「选文件(多选)」直接挑选几份 PDF/Word/PPT/Markdown，或点「选文件夹」整夹同步，也可以直接从${fmName}拖进窗口。`}
          />
        )}
      </div>

      <Divider style={{ margin: '14px 0' }} />

      {/* 2. OpenAI-compatible API */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Typography.Text strong style={{ fontSize: 13.5 }}>
            2. AI 问答模型接口（OpenAI 兼容 · 可选）
          </Typography.Text>
          {settings?.openai_api.api_key_set ? (
            <Tag color="green">已配置 {settings.openai_api.api_key_hint}</Tag>
          ) : (
            <Tag>未配置（离线检索不受影响）</Tag>
          )}
        </div>

        <Space size={6} wrap style={{ marginBottom: 10 }}>
          {API_PRESETS.map((p) => (
            <Tag
              key={p.label}
              color={baseUrl === p.baseUrl ? 'blue' : 'default'}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setBaseUrl(p.baseUrl);
                setModel(p.model);
              }}
            >
              {p.label}
            </Tag>
          ))}
        </Space>

        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 3 }}>API Base URL</div>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 3 }}>模型名称 (Model)</div>
            <Input value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 3 }}>
              API Key（仅存本机，不上传至第三方中转服务器）
            </div>
            <Input.Password
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={settings?.openai_api.api_key_set ? '留空表示保持当前已保存的 Key' : '输入 sk-...'}
            />
          </div>
          <Space size={8} wrap>
            <Button type="primary" icon={<SaveOutlined />} loading={savingApi} onClick={() => handleSaveApi(false)}>
              保存配置
            </Button>
            <Button icon={<ApiOutlined />} loading={testingApi} onClick={handleTestApi}>
              测试连接
            </Button>
            {settings?.openai_api.api_key_set && (
              <Button danger onClick={() => handleSaveApi(true)}>
                清空 Key
              </Button>
            )}
          </Space>
          {testRes && (
            <Alert
              type={testRes.ok ? 'success' : 'error'}
              showIcon
              message={testRes.ok ? `连接正常（延迟 ${testRes.latency_ms} ms）` : `测试失败：${testRes.error}`}
            />
          )}
        </Space>
      </div>

      <Divider style={{ margin: '14px 0' }} />

      {/* 3. Privacy Exclude Keywords */}
      <div style={{ marginBottom: 18 }}>
        <Typography.Text strong style={{ fontSize: 13.5, display: 'block', marginBottom: 6 }}>
          3. 隐私硬排除关键词（命中路径自动跳过，绝不入库）
        </Typography.Text>
        <Input.TextArea
          rows={2}
          value={keywordsText}
          onChange={(e) => setKeywordsText(e.target.value)}
          placeholder="用逗号分隔，例如：病历, 体检报告, 身份证, 银行卡"
        />
        <Button size="small" style={{ marginTop: 8 }} loading={savingKw} onClick={handleSaveKeywords}>
          保存排除词并同步
        </Button>
      </div>

      <Divider style={{ margin: '14px 0' }} />

      {/* 4. Local data directory info */}
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        <div>
          本机索引与配置目录：<Typography.Text code>{settings?.data_dir || '-'}</Typography.Text>
        </div>
        <div>删除该目录即可完全重置本软件的本地索引与配置（不影响你的原始文档）。</div>
      </div>
    </Drawer>
  );
};

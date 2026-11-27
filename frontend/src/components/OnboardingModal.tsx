import React, { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Space, Steps, Tag, Typography, message } from 'antd';
import {
  ApiOutlined,
  CheckCircleFilled,
  ExperimentOutlined,
  FileAddOutlined,
  FolderAddOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { api, SettingsResponse } from '../api';

interface OnboardingModalProps {
  open: boolean;
  onClose: () => void;
  onDataChanged: () => void;
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

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  open,
  onClose,
  onDataChanged,
}) => {
  const [step, setStep] = useState(0);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);
  const [addingFolder, setAddingFolder] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [showManual, setShowManual] = useState(false);

  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1');
  const [model, setModel] = useState('deepseek-chat');
  const [apiKey, setApiKey] = useState('');
  const [testingApi, setTestingApi] = useState(false);
  const [savingApi, setSavingApi] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    latency_ms: number;
    error?: string;
  } | null>(null);

  const isNative = Boolean(window.__KB_NATIVE_MAC__);

  const loadSettings = () => {
    api
      .settings()
      .then((s) => {
        setSettings(s);
        if (s.openai_api.base_url) setBaseUrl(s.openai_api.base_url);
        if (s.openai_api.model) setModel(s.openai_api.model);
      })
      .catch(() => {});
  };

  useEffect(() => {
    if (open) {
      setStep(0);
      setTestResult(null);
      loadSettings();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prevFolderHandler = (window as any).__kbOnFolderPicked;
    const prevPathsHandler = (window as any).__kbOnPathsPicked;

    const handlePickedList = async (paths: string[]) => {
      if (!paths || paths.length === 0) return;
      setAddingFolder(true);
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
        setAddingFolder(false);
      }
    };

    (window as any).__kbOnPathsPicked = handlePickedList;
    (window as any).__kbOnFolderPicked = (pickedPath: string) => handlePickedList([pickedPath]);
    return () => {
      (window as any).__kbOnFolderPicked = prevFolderHandler;
      (window as any).__kbOnPathsPicked = prevPathsHandler;
    };
  }, [open, onDataChanged]);

  const handlePickNative = (mode: 'any' | 'files' | 'folder') => {
    if (isNative && window.webkit?.messageHandlers?.kbNative) {
      const type = mode === 'files' ? 'pickFiles' : mode === 'folder' ? 'pickFolder' : 'pickAny';
      window.webkit.messageHandlers.kbNative.postMessage({ type });
    } else {
      setShowManual(true);
    }
  };

  const handleManualAdd = async () => {
    const p = manualPath.trim();
    if (!p) return;
    setAddingFolder(true);
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
      setAddingFolder(false);
    }
  };

  const handleLoadSample = async () => {
    setLoadingSample(true);
    try {
      const res = await api.loadSampleKb();
      message.success(
        `示例知识库已就绪：${res.index?.files_indexed ?? 3} 份文档已建索引并完成本地向量与冲突初筛`
      );
      loadSettings();
      onDataChanged();
    } catch (err) {
      message.error(`载入示例失败：${String(err)}`);
    } finally {
      setLoadingSample(false);
    }
  };

  const handleTestApi = async () => {
    setTestingApi(true);
    setTestResult(null);
    try {
      const res = await api.testOpenAi({ base_url: baseUrl, api_key: apiKey, model });
      setTestResult(res);
    } catch (err) {
      setTestResult({ ok: false, latency_ms: 0, error: String(err) });
    } finally {
      setTestingApi(false);
    }
  };

  const handleSaveApiAndNext = async () => {
    if (apiKey.trim() || settings?.openai_api.api_key_set) {
      setSavingApi(true);
      try {
        await api.saveOpenAi({
          enabled: true,
          base_url: baseUrl,
          api_key: apiKey,
          model,
        });
        message.success('AI 问答模型配置已保存到本机');
        onDataChanged();
      } catch (err) {
        message.error(`保存失败：${String(err)}`);
        setSavingApi(false);
        return;
      } finally {
        setSavingApi(false);
      }
    }
    setStep(2);
  };

  const handleFinish = async () => {
    await api.completeOnboarding(true).catch(() => {});
    onDataChanged();
    onClose();
  };

  const sourcesCount = settings?.sources.length ?? 0;

  return (
    <Modal
      open={open}
      onCancel={handleFinish}
      footer={null}
      width={660}
      centered
      destroyOnClose
      title={
        <Space size={8}>
          <SafetyCertificateOutlined style={{ color: 'var(--accent)' }} />
          <span>欢迎使用「星海拾卷」· 文件不必硬整理，拾起来就能问</span>
        </Space>
      }
    >
      <div style={{ marginTop: 8, marginBottom: 20 }}>
        <Steps
          size="small"
          current={step}
          onChange={setStep}
          items={[
            { title: '1. 选择文件或文件夹' },
            { title: '2. 配置 AI 模型（可选）' },
            { title: '3. 核心用法与快捷键' },
          ]}
        />
      </div>

      {step === 0 && (
        <div>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 14 }}
            message="纯本地只读，无需上传云端——绝不修改、移动或删除你的任何原文件"
            description="支持 Markdown、PDF、Word (.docx)、PPT (.pptx)、Excel (.xlsx)、HTML、JSON、CSV、TXT。既可以整夹接入，也可以直接挑选几份散落在桌面/下载里的单个文件。"
          />

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <div
              style={{
                border: '1px solid var(--border-ai)',
                background: 'var(--bg-ai-card)',
                borderRadius: 10,
                padding: 14,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 6 }}>
                <ExperimentOutlined style={{ color: 'var(--accent)', marginRight: 6 }} />
                先逛一圈：内置示例知识库
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 12 }}>
                一键载入 3 份演示文档（含决策口径、PRD、复盘纪要，并预置了一处 5 天 vs 7 天的口径冲突），10 秒体验检索、问答与冲突筛查。
              </div>
              <Button
                type="primary"
                block
                loading={loadingSample}
                icon={<RocketOutlined />}
                onClick={handleLoadSample}
              >
                载入内置示例知识库
              </Button>
            </div>

            <div
              style={{
                border: '1px solid var(--border-hairline)',
                background: 'var(--bg-subtle)',
                borderRadius: 10,
                padding: 14,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 6 }}>
                <FileAddOutlined style={{ color: 'var(--accent)', marginRight: 6 }} />
                直接选你电脑里的文件或文件夹
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
                支持多选单个文档（如 PDF / Word / PPT / MD），或选中整个目录自动同步；也支持直接从访达拖进窗口。
              </div>
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Button
                  block
                  loading={addingFolder}
                  icon={<FileAddOutlined />}
                  onClick={() => handlePickNative('any')}
                >
                  选择本地文件或文件夹（可多选）…
                </Button>
              </Space>
            </div>
          </div>

          {showManual && (
            <Space.Compact style={{ width: '100%', marginBottom: 14 }}>
              <Input
                placeholder="输入本机文件或文件夹路径，例如 ~/Downloads/方案.pdf 或 ~/Documents/我的文档"
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                onPressEnter={handleManualAdd}
              />
              <Button type="primary" loading={addingFolder} onClick={handleManualAdd}>
                接入
              </Button>
            </Space.Compact>
          )}

          {sourcesCount > 0 && (
            <div
              style={{
                border: '1px solid var(--border-hairline)',
                borderRadius: 8,
                padding: '10px 12px',
                marginBottom: 16,
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                已接入知识源（{sourcesCount} 个 · 纯本地只读）：
              </div>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                {settings?.sources.map((s) => (
                  <div
                    key={s.id}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5 }}
                  >
                    <span>
                      <CheckCircleFilled style={{ color: '#16a34a', marginRight: 6 }} />
                      <strong>{s.name}</strong>
                    </span>
                    <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                      {s.kind === 'files' ? `已拾取 ${s.files?.length ?? 0} 份零散文件` : s.path}
                    </Typography.Text>
                  </div>
                ))}
              </Space>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
            <Button type="text" onClick={handleFinish}>
              稍后再配
            </Button>
            <Button type="primary" onClick={() => setStep(1)}>
              下一步：配置 AI 模型（可选）
            </Button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div>
          <Alert
            type="success"
            showIcon
            style={{ marginBottom: 14 }}
            message="不配 API Key 也能用 80% 的核心功能"
            description="全文 + 语义混合检索、文档阅读定位、项目汇总、冲突初筛全程 100% 离线 0 Token 运行。仅在使用「带引用 AI 综合回答」和「AI 复核冲突」时，才会把召回的相关片段发给你自己配置的模型接口。"
          />

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
              快捷填入常见服务商（OpenAI 兼容格式）：
            </div>
            <Space size={6} wrap>
              {API_PRESETS.map((p) => (
                <Tag
                  key={p.label}
                  color={baseUrl === p.baseUrl ? 'blue' : 'default'}
                  style={{ cursor: 'pointer', padding: '2px 8px' }}
                  onClick={() => {
                    setBaseUrl(p.baseUrl);
                    setModel(p.model);
                  }}
                >
                  {p.label}
                </Tag>
              ))}
            </Space>
          </div>

          <Space direction="vertical" size={10} style={{ width: '100%', marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>API Base URL</div>
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>模型名称 (Model)</div>
                <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />
              </div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  API Key（仅保存在本机配置文件）
                  {settings?.openai_api.api_key_set && (
                    <Tag color="green" style={{ marginLeft: 6 }}>
                      已保存 {settings.openai_api.api_key_hint}
                    </Tag>
                  )}
                </div>
                <Input.Password
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={settings?.openai_api.api_key_set ? '留空表示保持已保存的 Key' : 'sk-...'}
                />
              </div>
            </div>
          </Space>

          <Space size={8} style={{ marginBottom: 12 }}>
            <Button icon={<ApiOutlined />} loading={testingApi} onClick={handleTestApi}>
              测试连接
            </Button>
            {testResult && (
              <Typography.Text type={testResult.ok ? 'success' : 'danger'} style={{ fontSize: 12.5 }}>
                {testResult.ok
                  ? `连接成功（${testResult.latency_ms} ms）`
                  : `连接失败：${testResult.error}`}
              </Typography.Text>
            )}
          </Space>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
            <Button onClick={() => setStep(0)}>上一步</Button>
            <Space>
              <Button onClick={() => setStep(2)}>跳过，先纯离线检索</Button>
              <Button type="primary" loading={savingApi} onClick={handleSaveApiAndNext}>
                保存并继续
              </Button>
            </Space>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 10,
              marginBottom: 16,
            }}
          >
            <div style={{ border: '1px solid var(--border-hairline)', borderRadius: 9, padding: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                <SearchOutlined style={{ color: 'var(--accent)', marginRight: 6 }} />
                1. 搜问合一 · 毫秒定位原文
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                输入关键词即时做「全文 + 本地语义」混合检索；键盘 <Typography.Text code>↑</Typography.Text>{' '}
                <Typography.Text code>↓</Typography.Text> 步进，右侧直接高亮定位到命中段落。
              </div>
            </div>

            <div style={{ border: '1px solid var(--border-hairline)', borderRadius: 9, padding: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                <ThunderboltOutlined style={{ color: 'var(--accent)', marginRight: 6 }} />
                2. 勾选文档围栏 + [n] 溯源
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                鼠标悬停结果卡勾选 2–5 份文档，点「基于选中文档问 AI」；回答中的{' '}
                <Typography.Text code>[1]</Typography.Text> 悬停看摘录、点击跳原文。
              </div>
            </div>

            <div style={{ border: '1px solid var(--border-hairline)', borderRadius: 9, padding: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                <SafetyCertificateOutlined style={{ color: 'var(--accent)', marginRight: 6 }} />
                3. 自动筛查同项目口径冲突
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                在顶部「治理」页，可一键用本地向量找出同项目不同文档里「语义很近但数字/天数不一致」的段落（示例库已内置一组可体验）。
              </div>
            </div>

            <div style={{ border: '1px solid var(--border-hairline)', borderRadius: 9, padding: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                <RocketOutlined style={{ color: 'var(--accent)', marginRight: 6 }} />
                4. 高频快捷键速查
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                <div>
                  <Typography.Text code>⌥ Space</Typography.Text> 全局随时呼出 / 隐藏窗口
                </div>
                <div>
                  <Typography.Text code>⌘ K</Typography.Text> 快速跳文档 ·{' '}
                  <Typography.Text code>⌘ F</Typography.Text> 文档内查找 ·{' '}
                  <Typography.Text code>⌘ ,</Typography.Text> 打开设置
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Button onClick={() => setStep(1)}>上一步</Button>
            <Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                随时可点右上角「引导」重新查看
              </Typography.Text>
              <Button type="primary" onClick={handleFinish}>
                开始使用
              </Button>
            </Space>
          </div>
        </div>
      )}
    </Modal>
  );
};

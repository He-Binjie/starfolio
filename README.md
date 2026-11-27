<div align="center">
  <img src="./macos-app/icon.svg" width="88" height="88" alt="星海拾卷 Starfolio Logo" />
  <h1>星海拾卷 · Starfolio</h1>
  <p><strong>文件不必硬整理，拾起来就能问。</strong></p>
  <p>面向 macOS 的纯本地只读知识库工作台 · 0-Token 离线检索与跨文件分析 · BYOL 自带模型问答</p>

  <p>
    <img src="https://img.shields.io/badge/macOS-Apple%20Silicon%2014%2B-0f172a?style=flat-square" />
    <img src="https://img.shields.io/badge/Read--Only-Zero%20File%20Mutation-059669?style=flat-square" />
    <img src="https://img.shields.io/badge/Local%20AI-0%20Token%20Core-2563eb?style=flat-square" />
    <img src="https://img.shields.io/badge/License-MIT-d97706?style=flat-square" />
  </p>
</div>

---

## 为什么做「星海拾卷」？

日常工作中，知识管理最真实的三个痛点不是“缺一个云端笔记软件”，而是：

1. **文件乱**：PDF、Word、PPT、Excel、Markdown、HTML 散落在桌面、下载夹和十几个项目文件夹里，根本没精力天天归档。
2. **整理了也找不到**：只靠文件名搜不到正文，只靠关键词又搜不到同义表达。
3. **找到了也难跨文件分析**：5 份不同时期的 PRD、纪要、报价表里口径互相打架，翻半天也核对不清到底哪份写了「5 天」、哪份写了「7 天」。

**星海拾卷（Starfolio）** 采用 **「严格只读 + 80% 能力 0-Token 本地计算 + 20% 能力 BYOL 模型增强」** 的轻架构，不改造你的目录习惯、不上传你的原始文件，直接把散落在硬盘各处的文档拾起来织成可检索、可对照、可溯源的个人知识星海。

---

## 核心特性一览（v1.8）

| 能力模块 | 0-Token 离线 | 说明 |
| --- | :---: | --- |
| **零负担接入（文件夹 + 零散文件 + 拖放）** | ✅ | 既支持整夹接入与实时监听（watchdog），也支持直接多选零散文件（原地只读，不复制）或从访达直接拖入窗口 |
| **多格式原生解析与高亮定位** | ✅ | 支持 `.md / .txt / .pdf / .docx / .pptx / .xlsx / .csv / .html / .htm / .json / .yaml`；PDF/PPTX/DOCX/XLSX/HTML 支持按页/分段琥珀高亮与目录跳转 |
| **混合检索（FTS5 + 本地 BGE 语义向量）** | ✅ | SQLite FTS5 全文检索 + `BAAI/bge-small-zh-v1.5` 本地中文语义向量 + RRF 融合排序，同文档命中自动折叠 |
| **阅读页 0-Token 关键数字/日期速览条** | ✅ | 打开长文档自动提取核心数字、比例、版本与日期胶囊，点击瞬间唤起文内查找并高亮定位 |
| **跨文件分析三件套** | ✅ / BYOL | **双栏并排对照**（含 0-Token 独有数值差异条 + 一键复制差异简报）、**跨文档事实矩阵**、**AI 围栏问答（带 `[n]` 悬停摘录、点击定位行号/页码与防幻觉引用率审计）** |
| **专题卷宗（虚拟合集）** | ✅ | 不挪动原文件，将跨目录文档一键打包为逻辑卷宗，随时整组拉入对比或 AI 问答 |
| **星海聚类 · 2D 星图与文档血缘流向** | ✅ | 球面 K-Means 主题聚类 + 2D PCA 交互星图（支持滚轮缩放、拖拽平移、星图内搜星）；融合**显式引用 + 版本演进 + 阶段时序语义**构建「上游依据 → 本篇 → 下游衍生」血缘网与星点血缘追踪浮窗 |
| **治理中心：口径冲突筛查 & 重复雷达** | ✅ / BYOL | 0-Token 找出同项目内「语义高度相近、但天数/比例/金额不一致」的段落对（可调用 BYOL 模型复核）；字节哈希 + 向量检出重复与近似副本 |

> 想深入了解本项目的**代码组织架构、防幻觉 Prompt 约束原文、以及引文/数字自动审计机制**，请直接阅读：[架构设计与核心 Prompt 约束说明（docs/ARCHITECTURE_AND_PROMPTS.md）](./docs/ARCHITECTURE_AND_PROMPTS.md)。

---

## 快速开始（从源码本地运行）

### 环境要求
- macOS 14.0+（Apple Silicon 推荐；Python/React 后端前端同样支持通用 macOS / Linux 开发运行）
- Python 3.11+（推荐 3.12 / 3.13）
- Node.js 18+ & `pnpm`（或 `npm`）

### 1. 启动后端（FastAPI + SQLite FTS5 + FastEmbed 本地向量）

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt

# 默认以 standalone 模式启动（自动创建 ~/Library/Application Support/KBConsole/config.yaml 与示例库引导）
python backend/run.py
```

首次启动如本地尚无 `BAAI/bge-small-zh-v1.5` 模型缓存，FastEmbed 会自动拉取一次（约 91MB），之后完全离线运行。

### 2. 启动前端（React + Vite + Ant Design 5）

```bash
cd frontend
pnpm install
pnpm dev
```

浏览器打开 `http://127.0.0.1:5173`（或先 `pnpm build` 后直接访问后端 `http://127.0.0.1:18765`）。首次访问会弹出「3 步快速上手引导」，可一键载入内置示例知识库体验全部功能。

### 3. 打包原生 macOS Apple Silicon 独立版 `.app` / `.dmg`（可选）

```bash
bash macos-app/build-standalone.sh
```

脚本会自动编译前端、使用 PyInstaller 打包 Python 后端、编译 Swift 原生壳（支持 `⌥Space` 全局呼出、菜单栏驻留、原生多选文件/文件夹弹窗与 Finder 拖放）、嵌入离线中文向量模型并生成 `dist/星海拾卷-AppleSilicon-v1.8.dmg`。

---

## 项目目录结构

```text
starfolio/
├── backend/
│   ├── app/
│   │   ├── main.py                 # FastAPI 路由、设置与单/多文件接入入口
│   │   ├── config.py               # 严格只读白名单、隐私硬排除与零散文件虚拟源解析
│   │   ├── db.py                   # SQLite + FTS5 全文表 / 向量表 / 卷宗 / 冲突候选库
│   │   ├── parsers.py              # 多格式解析器（MD/PDF/DOCX/PPTX/XLSX/CSV/HTML/JSON）
│   │   ├── indexer.py              # 增量哈希索引管线（仅在 mtime/hash 变化时重切块）
│   │   ├── vectors.py              # FastEmbed 本地 BGE 向量、RRF 混合检索、球面聚类、2D 星图、重复雷达
│   │   ├── lineage.py              # 三层文档血缘引擎（显式引用 + 版本链 + 阶段语义流向）
│   │   ├── search.py               # 混合检索、快速跳转、原文详情与 Git 历史读取
│   │   ├── collections_compare.py  # 专题卷宗、双栏 0-Token 数值对照、跨文档事实矩阵
│   │   ├── qa.py                   # BYOL 严格溯源问答 Prompt 与生成后引文/数字审计器
│   │   ├── conflicts.py            # 同项目语义近邻 + 数值差异冲突扫描与 AI 复核
│   │   ├── projects.py             # 项目自动聚合与文档阶段分类
│   │   ├── timeline.py             # Git 提交时间线 + 普通目录修改动态
│   │   ├── health.py               # 仓库健康检查与未提交/跳读文件汇总
│   │   ├── tree.py                 # 左侧目录树构建（支持 INDEX.md 友好别名）
│   │   ├── tokenizer.py            # 中文双字切片 + 英文词元 FTS5 分词器
│   │   └── watcher.py              # Watchdog 5 秒防抖实时只读监听
│   ├── run.py                      # 开发模式启动入口
│   ├── standalone_entry.py         # PyInstaller 独立包启动入口
│   └── requirements.txt
├── frontend/
│   └── src/
│       ├── App.tsx                 # 全局壳、主题自动跟随、快捷键与原生桥接
│       ├── api.ts                  # 前后端强类型接口层
│       └── components/
│           ├── UnifiedWorkspace.tsx # 搜问合一主工作台（目录/卷宗/历史 + 折叠搜索 + AI 围栏）
│           ├── DocPreview.tsx       # 原文阅读、非 MD 琥珀高亮、速览条、血缘三栏卡、星海连脉
│           ├── StarMapCanvas.tsx    # 交互式 2D 星图（缩放/平移/搜星/血缘箭头与追踪浮窗）
│           ├── CompareModal.tsx     # 双栏并排对照与 0-Token 数值差异简报
│           ├── FactMatrixModal.tsx  # 跨文档事实与数字透视表
│           ├── ProjectsView.tsx     # 目录 / 星簇 / 星图三视图项目中心
│           ├── TimelineView.tsx     # 变更时间线与 Diff 抽屉
│           ├── HealthView.tsx       # 口径冲突复核 + 重复文件雷达 + 跳过文件治理
│           ├── OnboardingModal.tsx  # 3 步首次上手引导
│           ├── SettingsDrawer.tsx   # 文件/文件夹接入、BYOL 模型配置、隐私排除词
│           ├── CommandPalette.tsx   # ⌘K 极速跳转面板
│           └── SidebarTree.tsx      # 左侧目录树
├── macos-app/
│   ├── main-standalone.swift       # Swift 原生外壳（WKWebView + ⌥Space + NSOpenPanel + 拖放）
│   ├── build-standalone.sh         # 一键编译签名与 DMG 打包脚本
│   ├── icon.svg                    # 品牌矢量图标
│   └── sample-kb/                  # 内置 3 份脱敏演示文档（预置口径冲突便于 10 秒体验）
├── docs/
│   └── ARCHITECTURE_AND_PROMPTS.md # 架构全景、0-Token 算法与核心防幻觉 Prompt 约束详解
├── config.example.yaml             # 示例配置模板
└── LICENSE                         # MIT License
```

---

## 隐私与安全原则

- **只读不写**：应用对用户挂载的任意文件夹与零散文件均只有读权限，所有索引与缓存严格隔离在 `data_dir` 内。
- **隐私硬排除**：默认跳过路径或文件名包含 `病历 / 体检报告 / 身份证 / 银行卡 / 密码` 的文件，可在设置中自由扩展。
- **BYOL（自带密钥）**：API Key 仅存储在本地 `config.yaml`，仅在你主动点击「问 AI / AI 复核」时向你指定的模型接口发送当前召回的相关证据片段。

---

## License

[MIT License](./LICENSE) © 2026 [He-Binjie (Jared)](https://github.com/He-Binjie)

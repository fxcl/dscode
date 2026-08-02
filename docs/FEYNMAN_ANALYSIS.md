# Feynman 架构分析与 DSCode 移植评估

## Feynman 项目概览

Feynman 是一个**研究优先的 AI Agent CLI**，同样构建在 Pi（pi-coding-agent）之上，但面向学术研究场景而非编码场景。

- 仓库：`github.com/companion-inc/feynman`
- 版本：0.2.58
- Pi 版本：`@mariozechner/pi-coding-agent@^0.73.0`（DSCode 使用 `@earendil-works/pi-coding-agent@^0.83.0`）
- 许可：MIT

## 架构对比

| 维度 | DSCode | Feynman |
|------|--------|---------|
| Pi 集成方式 | `import { main }` 同进程 + InlineExtension | `spawn` 子进程 + `--extension` 文件路径 |
| 品牌补丁 | 原型猴补丁（Symbol 标记） | 文件级源码 patch（readFileSync → writeFileSync） |
| 扩展注册 | `createDSCodeExtension()` 返回 InlineExtension | `extensions/research-tools.ts` 导出默认函数 |
| CLI 层 | 薄层（parseRuntimeArgs → piArgs） | 厚层（setup/doctor/model/search/packages/alpha） |
| 工具注册 | 沙箱化 exec_command/apply_patch/delegate | 研究型 alpha_search/hf_dataset_info |
| 工作流 | /plan 模式 | prompt-template 系统（13 个 .md 工作流） |
| 包管理 | 无（直接依赖） | Pi packages 系统（install/update/presets） |
| 技能系统 | 无 | skills/ 目录（20 个 SKILL.md） |
| 资产同步 | 无 | bootstrap/sync.ts（hash 追踪增量同步） |
| 模型管理 | providers.ts 静态映射 | ModelRegistry + catalog + 偏好推荐 |
| Web 搜索 | `--web` 标志（DeepSeek 服务端） | 多 provider 配置（Perplexity/Exa/Gemini） |
| 服务层级 | 无 | service_tier 注入（OpenAI flex/priority） |
| 设置向导 | 仅首次 auth | 完整交互式 setup（model/packages/alpha/preview） |
| 诊断 | /doctor 命令 | doctor + status（结构化快照） |
| Header UI | 简单欢迎头 | 双栏仪表板（系统资源/工作流/agent 目录） |

## Feynman 核心功能模块

### 1. 厚 CLI 层（Pi 外部）

Feynman 在启动 Pi 之前提供了丰富的独立子命令：

```
feynman setup          # 交互式设置向导
feynman doctor         # 全面诊断
feynman status         # 结构化状态快照
feynman model list     # 模型列表 + 认证状态
feynman model login    # OAuth / API key 认证
feynman model set      # 设置默认模型
feynman model tier     # 服务层级配置
feynman search set     # Web 搜索 provider 配置
feynman packages list  # 包管理
feynman packages install
feynman update         # 更新 Pi 包
feynman alpha login    # alphaXiv 认证
```

### 2. Prompt-Template 工作流系统

`prompts/` 目录包含 13 个 Markdown 工作流模板，通过 Pi 的 `--prompt-template` 参数加载：

- `deepresearch.md` — 多 agent 深度研究
- `lit.md` — 文献综述
- `review.md` — 模拟同行评审
- `audit.md` — 论文 vs 代码审计
- `replicate.md` — 实验复现
- `recipe.md` — ML 训练方案
- `compare.md` — 来源对比矩阵
- `draft.md` — 论文风格草稿
- `autoresearch.md` — 自主实验循环
- `watch.md` — 定期研究监控
- `summarize.md` — 分层摘要
- `jobs.md` / `log.md` — 任务管理

每个模板有 YAML frontmatter（description、args、section、topLevelCli），支持 `$@` 参数替换。

### 3. Pi 包管理系统

```ts
CORE_PACKAGE_SOURCES = [
  "npm:@companion-ai/alpha-hub",   // 论文搜索
  "npm:pi-subagents",              // 子代理
  "npm:pi-docparser",              // 文档解析
  "npm:pi-web-access",             // Web 搜索
];

OPTIONAL_PACKAGE_PRESETS = {
  memory:          ["npm:@samfp/pi-memory"],
  hindsight:       ["npm:@luxusai/pi-hindsight"],
  "session-search": ["npm:@kaiserlich-dev/pi-session-search"],
  "generative-ui":  ["npm:pi-generative-ui"],
};
```

支持 `feynman packages install <preset>`、`feynman update [source]`、Node 版本兼容性过滤。

### 4. 模型目录与智能推荐

`model/catalog.ts` 维护了一个研究场景偏好列表：

```ts
RESEARCH_MODEL_PREFERENCES = [
  { spec: "anthropic/claude-opus-4-6", reason: "strong long-context reasoning..." },
  { spec: "openai/gpt-5.5", reason: "strong general reasoning..." },
  // ...
];
```

`chooseRecommendedModel()` 根据当前已认证模型自动推荐最佳选择，`buildModelStatusSnapshotFromRecords()` 生成结构化状态（含 guidance 建议）。

### 5. Service Tier 控制

通过 `before_provider_request` 事件注入 `service_tier` 字段：
- OpenAI: auto / default / flex / priority
- Anthropic: auto / standard_only

支持 CLI 参数、环境变量、settings.json 三级配置。

### 6. Web 搜索多 Provider 配置

`web-search.json` 持久化配置：
- 路由选择：auto / perplexity / exa / gemini
- 各 provider API key
- 浏览器 cookie 回退（opt-in）
- 工作流模式：none / summary-review

### 7. Bootstrap 资产同步

`syncBundledAssets()` 使用 SHA-256 hash 追踪，将 bundled 的 themes/agents/skills 增量同步到 `~/.feynman/agent/`：
- 新文件：直接复制
- 已修改且用户未编辑：更新
- 用户已编辑：跳过
- 源中删除且用户未编辑：清理

### 8. Discovery 命令

```
/commands     — 浏览所有斜杠命令（含来源标签）
/tools        — 浏览所有工具（含参数摘要）
/capabilities — 运行时能力统计 + 已安装包
```

### 9. 丰富的 Header 仪表板

双栏布局显示：
- 左栏：model、directory、session、系统资源（CPU/RAM/Docker）、agent 目录
- 右栏：Research Workflows 列表 + 描述
- 窄屏自动降级为单栏

---

## 移植评估

### 第一梯队：高价值 + 低改造成本

| 功能 | 移植方式 | 工作量 |
|------|---------|--------|
| **Service Tier 控制** | 在 `before_provider_request` 中注入 `service_tier`；添加 `/service-tier` 命令 + settings 持久化 | 小 |
| **Discovery 命令** | 添加 `/commands`、`/tools`、`/capabilities` 命令，利用 `pi.getCommands()` / `pi.getAllTools()` | 小 |
| **Web 搜索持久化配置** | 将 `--web` 扩展为 `web-search.json` 配置，支持 provider 选择和 API key 存储 | 中 |
| **模型智能推荐** | 在 `providers.ts` 中添加偏好列表 + `chooseRecommendedModel()`，首次运行时自动选择 | 中 |
| **结构化 status 快照** | 增强 `/status` 和 `/doctor`，输出 `StatusSnapshot` 对象（含 guidance） | 小 |

### 第二梯队：中等价值 + 适度改造

| 功能 | 移植方式 | 工作量 |
|------|---------|--------|
| **交互式 setup 向导** | 添加 `dscode setup` 子命令（model 选择 + provider 认证 + 可选包） | 中 |
| **Prompt-Template 工作流** | 利用 Pi 的 `--prompt-template` 机制，添加 `prompts/` 目录（code-review、refactor、test-gen 等编码工作流） | 中 |
| **Pi 包管理** | 添加 `dscode packages list/install` + `dscode update`，管理 Pi 生态包 | 中-大 |
| **Bootstrap 资产同步** | 移植 hash 追踪同步机制，用于分发 themes/skills/agents | 中 |
| **丰富 Header 仪表板** | 增强 `DSCodeWelcomeHeader`，显示工具数/命令数/系统资源/MCP 状态 | 中 |

### 第三梯队：高价值 + 大改造 / 领域特定

| 功能 | 移植方式 | 工作量 |
|------|---------|--------|
| **Skills 系统** | 添加 `skills/` 目录 + SKILL.md 解析 + Pi skills 加载 | 大 |
| **HuggingFace Hub 工具** | 直接移植 `hf_dataset_info`/`hf_repo_files`/`hf_repo_read_file`（纯 HTTP） | 小（但领域特定） |
| **多 Provider Web 搜索** | 集成 Perplexity/Exa/Gemini API 作为独立搜索工具 | 大 |
| **子代理角色系统** | Feynman 的 researcher/writer/verifier/reviewer vs DSCode 的 explorer/implementer/reviewer/tester — 可参考其 prompt 设计 | 中 |

### 不建议移植

| 功能 | 原因 |
|------|------|
| 子进程启动模式 | DSCode 的同进程 InlineExtension 更优雅、性能更好 |
| 文件级源码 patch | DSCode 的 Symbol 标记猴补丁更安全、可维护 |
| alphaXiv 论文工具 | 纯研究领域，与编码代理定位不符 |
| 研究 workflows（deepresearch/lit/audit 等） | 领域特定，但 prompt 结构可参考 |
| Docker/Modal/RunPod 计算集成 | 与 DSCode 的 OS sandbox 理念不同 |

---

## 推荐移植优先级

1. **Service Tier 控制** — 对使用 OpenAI/Anthropic 的用户直接有用，改动极小
2. **Discovery 命令** — 提升可发现性，对 MCP 工具多的场景尤其有用
3. **模型智能推荐** — 改善多 provider 体验，减少用户配置负担
4. **交互式 setup** — 降低新用户上手门槛
5. **编码工作流模板** — 利用 Pi prompt-template 机制，添加 code-review / refactor / test-gen 等工作流
6. **Pi 包管理** — 接入 Pi 生态（pi-web-access、pi-memory 等）

---

## 关键实现参考路径

| Feynman 文件 | 对应 DSCode 位置 |
|-------------|-----------------|
| `src/model/service-tier.ts` | `packages/core/src/config.ts` 或新文件 |
| `extensions/research-tools/discovery.ts` | `packages/core/src/dscode-extension.ts` |
| `src/model/catalog.ts` | `packages/core/src/providers.ts` |
| `src/setup/setup.ts` | `packages/core/src/cli-runtime.ts` 或新文件 |
| `src/pi/web-access.ts` | `packages/core/src/settings.ts` |
| `src/bootstrap/sync.ts` | 新文件 `packages/core/src/sync.ts` |
| `prompts/*.md` | 新目录 `prompts/` |
| `extensions/research-tools/header.ts` | `packages/core/src/welcome.ts` |
| `src/pi/package-presets.ts` | 新文件 `packages/core/src/packages.ts` |

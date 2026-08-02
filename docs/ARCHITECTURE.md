# DSCode 封装 @earendil-works/pi-coding-agent 架构

## 底层依赖

DSCode 通过 4 个 `@earendil-works` 底层包构建完整的编码代理产品：

| 包名 | 职责 |
|------|------|
| `@earendil-works/pi-coding-agent` | 编码代理主框架（Extension API、会话管理、TUI 交互模式、RPC） |
| `@earendil-works/pi-agent-core` | Agent 核心抽象（Agent、AgentTool、AgentMessage、token 估算） |
| `@earendil-works/pi-ai` | AI 模型层（Provider、Model、API transport、Usage） |
| `@earendil-works/pi-tui` | 终端 UI 组件库（Text、Markdown、Editor、TUI 渲染） |

## 封装层次

### 1. 入口启动层 — `packages/core/src/cli-runtime.ts`

核心启动逻辑：

```ts
const { main } = await import("@earendil-works/pi-coding-agent");
await main(parsed.piArgs, {
  extensionFactories: [createDSCodeExtension(parsed.options)],
});
```

DSCode 将 pi-coding-agent 的 `main()` 作为运行时引擎，通过 **InlineExtension 工厂** 注入所有自定义行为。启动前做了以下准备：

- 解析自有 CLI 参数 → 转换为 pi 原生参数（`piArgs`）
- 初始化 `~/.dscode` 目录
- 设置环境变量 `PI_TELEMETRY=0`、`PI_SKIP_VERSION_CHECK=1` 禁用上游遥测
- 写入 UI 默认配置（主题、硬件光标等）
- 安装品牌补丁和 Markdown 补丁

### 2. 参数翻译层 — `packages/core/src/runtime-options.ts`

将 DSCode 特有的 CLI 参数（`--provider`、`--permission`、`--sandbox`、`--network`、`--harness` 等）解析为：

- **`DSCodeRuntimeOptions`**：DSCode 扩展内部使用的运行时配置
- **`piArgs`**：转发给 pi-coding-agent 的原生参数（`--provider`、`--model`、`--thinking`、`--approve` 等）

### 3. 核心扩展层 — `packages/core/src/dscode-extension.ts`

这是封装的核心（约 1257 行），通过 `createDSCodeExtension()` 返回一个 `InlineExtension` 对象，其 `factory(pi: ExtensionAPI)` 方法利用 pi 提供的扩展 API 注册了：

#### a) 自定义工具（替代 pi 内置工具）

- **`exec_command`** — 沙箱化命令执行（替代 pi 的 `bash`/`run_command`）
- **`write_stdin`** — 管理后台进程交互
- **`apply_patch`** — 带 checkpoint 的原子补丁（替代 pi 的 `edit`/`write`）
- **`delegate`** — 并行子代理（explorer/implementer/reviewer/tester）
- **`read_file`/`list_files`/`search_files`** — safe harness 模式下的只读工具
- **`language_diagnostics`** — IDE 诊断工具

#### b) 事件拦截（`pi.on(...)`）

- **`before_provider_request`** — 优化 DeepSeek Responses API 载荷
- **`session_start`** — 初始化 MCP、恢复 checkpoint/plan 状态、设置工具集
- **`before_agent_start`** — 注入工程规范 system prompt、plan 模式上下文
- **`tool_call`** — 权限审批拦截（阻止 pi 内置 bash/write、plan 模式限制、危险命令确认）
- **`user_bash`** — 用户手动命令也走沙箱
- **`agent_end`** — plan 完成后提供执行/细化选择
- **`agent_settled`** — JSON/print 模式下设置退出码

#### c) 自定义命令（`pi.registerCommand(...)`）

`/plan`、`/permissions`、`/effort`、`/base-url`、`/undo`、`/checkpoints`、`/diff`、`/jobs`、`/mcp`、`/status`、`/doctor`、`/agents`

#### d) Provider 注册（`pi.registerProvider(...)`）

向 pi 的模型注册表注入 DeepSeek provider 配置（含 thinking level 映射、cost、compat 标志）。

#### e) Entry Renderer（`pi.registerEntryRenderer(...)`）

为 checkpoint、undo、diff 等自定义 session entry 提供 TUI 渲染。

### 4. 原型猴补丁层（Monkey-patching）

DSCode 对 pi 内部组件做了 3 处原型级补丁：

| 文件 | 补丁目标 | 作用 |
|------|---------|------|
| `runtime-branding.ts` | `InteractiveMode.prototype` | 替换终端标题、信任警告文本；将所有 "pi"/"π" 字样替换为 "DSCode" |
| `pi-login-mask.ts` | `LoginDialogComponent.prototype` | API Key 输入时显示 `•` 遮罩，防止密钥泄露到终端 |
| `pi-markdown.ts` | `AssistantMessageComponent.prototype` | 去掉 pi 的代码块边框，改为 Codex 风格缩进 |

所有补丁使用 `Symbol.for("dscode.xxx")` 标记防止重复安装。

### 5. TUI 体验层 — `packages/core/src/tui-experience.ts`

通过 `ctx.ui.setEditorComponent(...)` 注入自定义编辑器组件 `DSCodeEditor`（继承 pi 的 `CustomEditor`），实现：

- 品牌化面板渲染（蓝色 `>` 前缀、背景色）
- 底部状态栏（模型、effort、权限、sandbox、context%）
- 图片粘贴附件支持
- `/login` 路由和 provider 自动切换
- 工作计时器动画

### 6. RPC/IDE 集成层 — `packages/core/src/rpc-client.ts`

复用 pi-coding-agent 导出的 `RpcClient` 类，仅替换 `cliPath` 指向 DSCode 自己的 `rpc-entry.ts`，使 VSCode 扩展等图形界面可以启动一个 DSCode 品牌的 RPC 工作进程。

### 7. 多 Provider 支持 — `packages/core/src/providers.ts`

在 pi 原有基础上扩展了 9 个 provider（deepseek、openai-codex、openai、anthropic、openrouter、zai、kimi-coding、minimax、xai），管理默认模型、effort、环境变量 key 和别名映射。

## 架构总览

```
┌──────────────────────────────────────────────────┐
│  src/cli.ts  (bin 入口)                          │
├──────────────────────────────────────────────────┤
│  cli-runtime.ts                                  │
│  ├─ parseRuntimeArgs → piArgs + DSCodeRuntimeOptions │
│  ├─ 环境准备 (home, ui-defaults, env)            │
│  ├─ 猴补丁 (branding, login-mask, markdown)      │
│  └─ import("pi-coding-agent").main(piArgs, {     │
│        extensionFactories: [createDSCodeExtension]│
│     })                                           │
├──────────────────────────────────────────────────┤
│  dscode-extension.ts (InlineExtension)           │
│  ├─ registerProvider (DeepSeek)                  │
│  ├─ registerTool (exec_command, apply_patch, …)  │
│  ├─ registerCommand (/plan, /undo, /status, …)   │
│  ├─ pi.on (事件拦截: 权限、沙箱、system prompt)   │
│  ├─ registerEntryRenderer (checkpoint UI)        │
│  └─ registerCodingTui (自定义编辑器 + 状态栏)     │
├──────────────────────────────────────────────────┤
│  @earendil-works/pi-coding-agent (上游引擎)       │
│  @earendil-works/pi-agent-core (Agent 抽象)      │
│  @earendil-works/pi-ai (模型/API 层)             │
│  @earendil-works/pi-tui (终端 UI 组件)           │
└──────────────────────────────────────────────────┘
```

## 设计策略

核心策略是：**不 fork 上游代码，而是通过 pi-coding-agent 暴露的 `InlineExtension` 扩展点 + 少量原型补丁，实现完整的品牌重塑、工具替换、权限沙箱、多 Provider 支持和 IDE 集成**。

扩展点使用方式汇总：

| Extension API | 用途 |
|---------------|------|
| `pi.registerProvider()` | 注入 DeepSeek 模型配置 |
| `pi.registerTool()` | 注册沙箱化工具替代内置工具 |
| `pi.registerCommand()` | 添加 DSCode 专属斜杠命令 |
| `pi.registerEntryRenderer()` | 自定义 session entry 渲染 |
| `pi.on("event")` | 拦截生命周期事件注入逻辑 |
| `pi.setActiveTools()` | 动态控制可用工具集（plan 模式） |
| `pi.appendEntry()` | 持久化 checkpoint/permission 状态 |
| `pi.sendUserMessage()` | plan 执行后自动发送后续消息 |
| `pi.setModel()` / `pi.setThinkingLevel()` | 运行时切换模型和 effort |
| `ctx.ui.setEditorComponent()` | 替换整个编辑器组件 |
| `ctx.ui.setHeader()` / `setFooter()` | 自定义头尾渲染 |
| `ctx.ui.setWorkingIndicator()` | 自定义工作动画 |

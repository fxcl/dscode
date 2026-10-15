# DSCode 架构总览

> 本文基于仓库当前代码（`v0.4.0`）整理，描述"DSCode 是什么、由哪些部件构成、它们如何协作"。
> 模块级实现细节、数据落盘格式、协议字段、算法与工程约定见 [`IMPLEMENTATION.md`](./IMPLEMENTATION.md)。

## 1. 一句话定位

DSCode 是一个 **本地优先（local-first）、多 Provider 的编码代理（coding agent）**。
它自己不实现 agent 循环，而是把 `@earendil-works/pi-coding-agent` 作为运行时内核，
在其 Extension API 上注入一套"更安全、更可审计、更贴合工程场景"的产品层：

- 替换内核自带的高危工具，换成走 **OS 级沙箱** 的 `exec_command` 和带 **检查点** 的 `apply_patch`；
- 用一套 **权限模式 x 沙箱模式** 的二维模型约束每一次副作用；
- 接管 **凭据存储、会话落盘、MCP、Provider 配置、子代理、预算、计划、调度** 等横切关注点；
- 对外提供 **CLI（TUI/JSON/RPC）**、**Electron 桌面端**、**HTTP 适配器**、**VS Code 扩展** 四种宿主形态。

## 2. 仓库结构

```text
dscode/
|-- src/cli.ts                       # bin 入口（仅 6 行，转发到 core）
|-- packages/
|   |-- core/                        # @thinkany/dscode-core —— 全部产品逻辑（104 个模块）
|   `-- http-adapter/                # REST+SSE 适配层（private, 0.0.0）
|-- gui/                             # Electron 桌面端（独立 pnpm workspace，private）
|-- native/windows-sandbox/          # Go 实现的 Windows 原生沙箱助手
|-- editors/vscode/                  # VS Code 扩展（0.3.0）
|-- prompts/  skills/                # 内置工作流提示词与技能（发布时同步到 ~/.dscode）
|-- scripts/                         # 构建 / 打包 / 冒烟脚本
|-- test/                            # 根 vitest 测试集（58 个文件）
`-- docs/                            # 本目录
```

关键约束：

- **pnpm workspace** 只覆盖 `packages/*`；`gui/` 有自己的 `pnpm-workspace.yaml`，通过 `link:../packages/core` 直接引用 core 源码。
- 根 `tsconfig.json` 的 `rootDir` 是 `src`、`outDir` 是 `dist`，因此 `dist/cli.js` 通过**相对路径** `../packages/core/dist/index.js` 引用 core 的构建产物 —— 这要求 `build:core` 一定先于根 `tsc` 执行。
- 核心运行时要求 **Node.js >= 22.19.0**（用到 `node:sqlite`、`TextDecoder(fatal)` 等）。

## 3. 分层视图

```text
+----------------------------------------------------------------------+
| 宿主形态（四种）                                                      |
|  +-----------+ +--------------+ +----------------+ +--------------+    |
|  | CLI / TUI | | Electron GUI | | HTTP Adapter   | | VS Code 扩展 |    |
|  |dist/cli.js| | gui/         | |packages/       | |editors/vscode|   |
|  +-----+-----+ +------+-------+ |http-adapter/   | +------+-------+   |
|        |           |           +-------+--------+        |             |
|        |           | stdio JSONL RPC                  | 终端注入     |
+--------+-----------+-----------+----------+-------------+-------------+
         |           |                      |             |
         |    +------v-------+              |             |
         |    | Electron     |              |             |
         |    | Main 进程     |              |             |
         |    | omp/* 子系统  |              |             |
         |    +------+-------+              |             |
         |           | stdio JSONL RPC                  |             |
         v           v                      v             v
  +----------------------------------------------------------------+
  | packages/core —— DSCode 产品层（唯一实现，CLI 与 GUI 共用）     |
  | cli-runtime / dscode-extension / tools / sandbox / access / ...  |
  +-----------------------------+----------------------------------+
                                | Extension API (InlineExtension)  |
  +-----------------------------v----------------------------------+
  | @earendil-works/pi-coding-agent —— agent 循环/会话树/TUI/RPC    |
  | @earendil-works/pi-agent-core  —— Agent / AgentTool / 上下文估算|
  | @earendil-works/pi-ai          —— Provider / Model / transport  |
  | @earendil-works/pi-tui         —— 终端 UI 组件                  |
  +----------------------------------------------------------------+
                                |
            +-------------------+--------------------+
            v                                        v
  Provider API（DeepSeek / OpenAI / Anthropic / ...）  OS 沙箱后端
                                                     Windows 原生助手 (Go)
                                                     macOS Seatbelt / Docker
```

## 4. 核心策略：不 fork，只封装

DSCode 没有复制上游代码，而是走三条扩展路径：

| 路径 | 手段 | 例子 |
|------|------|------|
| **扩展** | `pi.registerTool` / `registerCommand` / `registerProvider` / `registerEntryRenderer` / `ctx.ui.setEditorComponent` | `exec_command`、`apply_patch`、`/plan`、DeepSeek provider、自定义编辑框 |
| **拦截** | `pi.on(...)` 生命周期事件 | `tool_call` 做审批闸门、`context` 做上下文裁剪、`input` 做预算硬停、`before_provider_request` 改写 DeepSeek 载荷 |
| **猴补丁** | 直接改原型 / 静态方法，用 `Symbol.for(...)` 防重复安装 | `InteractiveMode.prototype`（品牌化）、`LoginDialogComponent.prototype`（密钥遮罩）、`AssistantMessageComponent.prototype`（代码块样式）、`ModelRuntime.create`（注入凭据仓库） |

## 5. 启动链路

`dist/cli.js` -> `runDSCodeProcess(argv)` -> `runDSCode(argv)`，严格按以下顺序（`packages/core/src/cli-runtime.ts`）：

1. **沙箱生命周期**：`dscode sandbox setup|status|uninstall` 在最前面拦截，**不进入 pi 运行时**。
2. **解析参数**：`parseRuntimeArgs()` 把 argv 拆成 `DSCodeRuntimeOptions`（DSCode 私有）+ `piArgs`（透传给内核）。
3. **`--help` / `--version`**：直接输出返回。
4. **内核外子命令**：`doctor`、`setup`、`packages ...`、`install-skills`、`provider`。
5. `process.chdir(cwd)`。
6. **`initializeDSCodeHome()`**：把内核的 agent 目录重定向到 `~/.dscode`（通过 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`），建目录（0700）、迁移旧布局、把已有会话按日期分区。
7. 环境收敛：`PI_TELEMETRY=0`、`PI_SKIP_VERSION_CHECK=1`、`ensureDSCodeUiDefaults()`。
8. **同步内置资产**：`syncBundledAssets()` 把 `prompts/`、`skills/` 复制到 `~/.dscode`。
9. 认证：`login` / `logout` / `auth status` 子命令，或 `ensureFirstRunAuth()` 首次引导。
10. **安装补丁**：密钥遮罩 -> Markdown 代码块 -> 运行时品牌化 -> 凭据仓库注入。
11. **交给内核**：

```ts
const { main } = await import("@earendil-works/pi-coding-agent");
await main(parsed.piArgs, {
  extensionFactories: [createDSCodeExtension(parsed.options)],
});
```

> `packages/core/src/dscode-extension.ts`（约 2700 行）是整个产品的中枢，见第 7 节。

## 6. 运行时配置模型

DSCode 用两个正交维度描述"这个 agent 能做什么"：

| 维度 | 取值 | 语义 |
|------|------|------|
| `--permission` | `plan` / `ask` / `auto` / `full` | **谁来批准**：只规划 / 逐次询问 / 安全自动放行 / 全部信任 |
| `--sandbox` | `read-only` / `workspace-write` / `danger-full-access` | **OS 层面能碰到什么** |
| `--harness` | `minimal` / `safe` | **默认工具集**：最小执行集 / 含只读文件工具集 |
| `--transport` | `responses` / `chat` | DeepSeek 的 API 形态 |

组合规则（`SessionAccessController.effective()`）：

- `permission=full` -> 一律 `danger-full-access` + 网络；
- `permission=plan` -> 一律 `read-only`，且**永不**授予主机写权限；
- 其余 -> 走启动时的 `--sandbox` 基准值。

两档 harness 的默认工具集（`defaultActiveTools()`）：

- **minimal**：`update_plan`、`exec_command`、`write_stdin`、`apply_patch`、`web_search`、`schedule_wakeup` + 6 个 alpha(arXiv) 工具 + 3 个 HuggingFace 工具 + `delegate`；MCP 工具数达到阈值时追加 `search_tools`（延迟工具按需加载）。
- **safe**：在 minimal 基础上追加 `read_file`、`list_files`、`search_files`、`language_diagnostics`（纯只读）。

## 7. `dscode-extension.ts`：产品中枢

### 7.1 注册的工具

| 工具 | 来源模块 | 作用 |
|------|----------|------|
| `exec_command` | `dscode-extension.ts` | 沙箱化命令执行；长任务返回 `process_id` 供 `write_stdin` 续接；`monitor_seconds` 可对运行中进程做零输出监视唤醒 |
| `write_stdin` | `dscode-extension.ts` | 向托管进程写 stdin / 轮询 / 终止 |
| `apply_patch` | `dscode-extension.ts` + `patch.ts` | 原子、工作区受限的补丁；每次成功都生成可回滚检查点 |
| `delegate` | `subagents.ts` | 并行子代理（最多 8 个任务，并发上限 4） |
| `read_file`/`list_files`/`search_files` | `tools.ts` | safe harness 下的只读工具（路径经 `Workspace` 双重校验） |
| `language_diagnostics` | `diagnostics.ts` | 语言服务器 / 编译器诊断 |
| `web_search` | `web-search*.ts` | 客户端搜索（Perplexity / Exa / Google / search-mcp）；配置在调用时重读 |
| `alpha_*`（6 个） | `alpha-tools.ts` | arXiv 论文检索、阅读、提问、批注、读仓库代码 |
| `hf_*`（3 个） | `huggingface-tools.ts` | HuggingFace 数据集 / 仓库元信息与文件读取 |
| `knowledge` | `knowledge.ts` | 按需读取内置知识/技能文档，避免塞满系统提示词 |
| `mcp__<server>__<tool>` | `mcp.ts` | MCP 工具动态注册（并行执行） |

### 7.2 生命周期拦截（`pi.on`）

按事件归类：

- **请求改写**：`before_provider_request` —— 针对 DeepSeek Responses API 剔除无效字段（`prompt_cache_*`、`include`）、在 thinking 开启时移除采样参数、把 `apply_patch` 降级为 `custom` 工具、按需注入服务端 `web_search`。
- **会话生命周期**：`session_start`（恢复检查点/计划/目标循环/预算，接 MCP，装工具集，分区会话文件，装载调度器）、`session_info_changed`、`session_shutdown`、`session_before_tree`（分支摘要走后台廉价模型）、`session_before_compact`（压缩走后台廉价模型）。
- **上下文治理**：`context`（两级工具结果裁剪 + 孤儿 `tool_result` 修复，**按请求投影，不改落盘 transcript**）、`tool_result`（超大输出守卫）。
- **提示词构建**：`before_agent_start`（工程规范 + 分层记忆：用户级 `AGENTS.md` -> 项目级 `AGENTS.md`/`CLAUDE.md` -> `@mention` 激活的嵌套记忆）。
- **执行闸门**：`tool_call`（见 8.1）、`user_bash`（用户手敲命令同样进沙箱）。
- **输入治理**：`input`（预算硬停 / 记录 rewind 点 / 把上一次失败原因前置给模型）。
- **轮次仲裁**：`agent_end`（计划完成询问、Provider 配额失败降级、续跑恢复、goal 校验、stop-hook 续跑、目标循环——优先级：降级重放 > 续跑恢复 > stop 续跑 > goal loop）、`agent_settled`（口味学习、上下文提示、月度预算记账、JSON 模式退出码）。

### 7.3 斜杠命令（部分）

`/plan`、`/permissions`、`/taste`、`/schedule`、`/budget`、`/fallback`、`/vault`、`/loop`、`/effort`、`/base-url`、`/undo`、`/rewind`、`/checkpoints`、`/diff`、`/jobs`、`/mcp`、`/status`、`/doctor`、`/agents`、`/web-search`、`/service-tier`、`/init`、`/outputs` 等。

### 7.4 Provider 注册

`registerDeepSeekProvider()` 以 `baseUrl` + `$DEEPSEEK_API_KEY` + 按 `--transport` 选择的 `openai-responses` / `openai-completions` 注入模型元数据（上下文窗口 1,048,576、maxTokens 384,000、费率、thinking 等级映射、compat 标志）。其余 13 个 Provider 走内核 + `provider-setup.ts` 的 `models.json` 配置。

## 8. 安全模型（产品的核心卖点）

### 8.1 工具级闸门：`pi.on("tool_call")`

按顺序判定：

1. **封杀内核高危工具**：`bash` / `run_command` / `edit` / `write` 一律 `block`，并给出替代指引（"请用 `exec_command` / `apply_patch`"）—— 防止模型绕过沙箱与检查点。
2. **plan 模式白名单**：不在 `planAllowedTools` 内直接 `block`；危险命令在 plan 模式下额外拒绝。
3. **是否需要询问**：`permission=ask` 全量询问；`auto` 仅对 **外部 MCP 工具** 与 **危险命令** 询问；`full` 不询问。
4. **免询问只读集**：`read_file` / `list_files` / `search_files` / `language_diagnostics` 等。
5. **交互细节**：危险命令用 `ctx.ui.confirm` 二次确认；`apply_patch` **按文件逐个**确认并展示彩色 diff。
6. **非交互兜底**：`ctx.hasUI === false` 且需要审批时，**直接 block** 并提示改用 `--permission full`。

### 8.2 命令级闸门：`SessionAccessController` + `detectSandboxBoundary`

- `commandNeedsNetwork()` 用正则识别网络类命令（`curl/wget/ssh/git push/npm install/pip install/cargo/brew/docker pull/terraform init` ...）。
- `exec_command` 执行前若命令需要网络而当前无网络，弹出 **三选一**：`Allow once` / `Allow this command for this session` / `Deny`；会话级授权以 **归一化命令串** 为键存入 `networkCommands` / `hostCommands`。
- 执行**之后**若非零退出且 stderr 命中 `permission denied` / `read-only file system` / `network is unreachable` / `getaddrinfo` 等特征，`detectSandboxBoundary()` 反推出 `host` 或 `network` 边界，**重跑一次**并在重跑前请求升级授权。

### 8.3 文件级闸门：`Workspace`

路径解析做**两重**检查：词法包含（`path.relative` 不以 `..` 开头）+ 真实路径包含（`fs.realpath` 后再判）；新建文件则回溯到最近的**已存在父目录**再判真实路径 —— 阻断符号链接逃逸。

### 8.4 沙箱后端：`resolveSandboxBackend` / `sandboxCommand`

| 平台/条件 | 后端 | 说明 |
|-----------|------|------|
| `mode=danger-full-access` | `host` | 直接走宿主 shell（Windows 用 `pwsh/powershell -NoProfile -NonInteractive -Command`，POSIX 用 `$SHELL -lc`） |
| `win32` | `windows-native` | Go 助手；需 `DSCODE_WINDOWS_SANDBOX=1` 且已 `dscode sandbox setup` |
| `darwin` + `/usr/bin/sandbox-exec` | `seatbelt` | 生成 SBPL profile：`(allow default)` + `deny file-write*`（workspace-write 时放行 workspace/tmp）+ 可选 `deny network*` |
| 其它 + `DSCODE_SANDBOX_IMAGE` + docker | `docker` | `--cap-drop ALL --security-opt no-new-privileges --pids-limit 512 [--network none] -v cwd:/workspace` |
| 其它 | `unavailable` | **不静默降级**：抛出带可执行排障指引的错误 |

### 8.5 凭据隔离

- 三种模式：`file`（`~/.dscode/auth.json`，0600）、`keyring`（系统钥匙串，service `ai.thinkany.dscode`）、`auto`（优先钥匙串，失败回退文件，并把已存在的文件凭据迁移进钥匙串）。
- `installDSCodeCredentialStore()` 通过改写 `ModelRuntime.create` 注入，保证 TUI / JSON / RPC 三种运行时用的是同一份凭据仓库。
- **子进程凭据剥离**：`stripModelCredentialEnvironment()` 在每次 `spawn` 前删除 12 个 Provider 的 API Key 环境变量 —— 被 agent 启动的命令拿不到模型密钥。
- 写入统一走"临时文件 + `rename` + 0600 + 目录 0700"的原子模式，并用目录锁（15s 超时 / 30s 判陈旧）串行化并发写。

## 9. 沙箱边界升级路径

```text
模型调用 exec_command
      |
      +- access.forCommand() -- 命令需要网络？ --> requestCommandAccess("network")
      |        |                                        | Allow once / 本会话允许 / 拒绝
      |        v                                        v
      |   sandboxCommand() -> spawn（已剥离凭据、输出 BoundedOutput）
      |        |
      |        +- exit 0 / 仍运行 / 已是 full access --> 直接返回
      |        |
      |        `- 非零退出 --> detectSandboxBoundary(stderr)
      |                          |- "network" --> requestCommandAccess("network") -> 重跑
      |                          `- "host"    --> requestCommandAccess("host")    -> 重跑
      |                                                                        （plan 模式禁止）
```

## 10. 数据持久化

**真相源是 JSONL transcript**；SQLite 只是索引层，可随时从 JSONL 重建。

```text
~/.dscode/                         0700
|-- config.json                    deepseek.baseUrl / serviceTier /
|                                  cli_auth_credentials_store / sqlite_home /
|                                  history.persistence
|-- settings.json                  defaultProvider / defaultModel
|-- auth.json                      0600 文件凭据
|-- credential-metadata.json       钥匙串凭据的类型元数据（无密钥）
|-- .credential-locks/             目录锁
|-- state.sqlite                   WAL；threads 表 + 3 个索引
|-- sessions/YYYY/MM/DD/*.jsonl    按日期分区的 transcript（0600）
|-- sessions/<flat-name>.jsonl     硬链接，兼容内核的 --resume / --session-dir
|-- archived_sessions/YYYY/MM/DD/  归档
|-- mcp.json                       用户级 MCP 配置
|-- mcp-vault.json                 0600，${vault:NAME} 密钥
|-- mcp-descriptions.json          MCP 工具描述合成缓存
|-- prompts/  skills/              从仓库同步的内置资产
`-- windows-sandbox/state.bin      沙箱账号状态（DPAPI 保护）

<cwd>/.dscode/mcp.json              项目级 MCP（仅在项目被信任时加载）
<cwd>/.dscode/taste/taste.md        学到的用户口味（+ .learned.json 游标）
<cwd>/.dscode/hooks.json            项目钩子（受信任哈希白名单约束）
```

分区策略（`home.ts`）：把扁平的 `sessions/x.jsonl` 迁移为 `sessions/YYYY/MM/DD/x.jsonl`，同时在原路径建**硬链接**。两者同一 inode，因此内容不重复、`--resume` 语义不变；硬链接不可用时**宁可保持扁平**也不复制文件（避免破坏 resume 语义）。

## 11. Provider 与凭据

支持 14 个 Provider（`SUPPORTED_PROVIDER_IDS`），别名 `grok -> xai`、`kimi -> kimi-coding`、`gemini -> google`。

| Provider | 默认模型 | 默认 effort | API Key 环境变量 |
|----------|----------|--------------|------------------|
| deepseek | `deepseek-v4-flash` | max | `DEEPSEEK_API_KEY` |
| openai-codex | `gpt-5.6-sol` | medium | 无（ChatGPT 订阅，OAuth） |
| openai | `gpt-5.6-sol` | medium | `OPENAI_API_KEY` |
| anthropic | `claude-opus-4-8` | medium | `ANTHROPIC_API_KEY` |
| openrouter | `moonshotai/kimi-k2.6` | medium | `OPENROUTER_API_KEY` |
| zai | `glm-5.1` | medium | `ZAI_API_KEY` |
| kimi-coding | `kimi-for-coding` | medium | `KIMI_API_KEY` |
| minimax | `minimax-M2.7` | medium | `MINIMAX_API_KEY` |
| xai | `grok-4.5` | medium | `XAI_API_KEY` |
| google | `gemini-2.5-flash` | medium | `GEMINI_API_KEY` |
| groq | `meta-llama/llama-4-scout-17b-16e-instruct` | medium | `GROQ_API_KEY` |
| mistral | `mistral-large-latest` | medium | `MISTRAL_API_KEY` |
| cerebras | `gpt-oss-120b` | medium | `CEREBRAS_API_KEY` |
| amazon-bedrock | `anthropic.claude-opus-4-8` | medium | 无（AWS SDK 动态凭据） |

解析优先级：显式 flag > `DSCODE_*` 环境变量 > `~/.dscode/settings.json` 的已存选择 > Provider 默认值。

## 12. 子代理（`delegate`）

- 10 种角色：`explorer` / `reviewer` / `verifier` / `tester` / `implementer` / `deep-research` / `code-auditor` / `paper-reviewer` / `researcher` / `writer`。
- 实现方式：以**当前可执行文件**再起一个 `dscode --mode json --print --no-session` 子进程，并把 `DSCODE_SUBAGENT_DEPTH` 加一 —— 深度 >= 1 时不再注册 `delegate`，形成硬性递归上限。
- 只读角色拿 `--permission plan --sandbox read-only --thinking low`；写角色拿 `--permission auto --sandbox workspace-write --thinking max`。
- `implementer` 在**分离的 Git worktree** 中工作，返回 `git diff --binary` 补丁，由主代理决定是否合入。

## 13. Windows 原生沙箱（Go）

跨平台沙箱在 macOS/Linux 有成熟方案，Windows 没有对等物，因此本项目自带一个 Go 助手（`native/windows-sandbox/`）。

**构建产物**：`packages/core/dist/native/windows-sandbox/{win32-x64,win32-arm64}/dscode-windows-sandbox.exe` + `manifest.json`（含每个二进制的 SHA-256）。运行时读取 manifest，**校验版本、协议号与校验和**后才执行；也可用 `DSCODE_WINDOWS_SANDBOX_HELPER` 指向开发构建。

**调用协议**：Node 侧在临时目录写一份 0600 的请求 JSON（`version` / `state_path` / `mode` / `network` / `command` / `args` / `cwd`），然后 `helper run <requestPath>`；助手读取后立即删除该文件（一次性令牌语义）。

**执行链路**（`runner_windows.go`）：

```text
helper run
  |- 取互斥体 Local\DSCodeWindowsSandboxPolicy（序列化 ACL 变更）
  |- LoadAccount(state.bin) -> 沙箱账号 SID
  |- GrantWorkspace(cwd, sid, writable)   <- 单次非递归 icacls，(OI)(CI) 可继承
  `- runBroker
       |- 创建私有桌面 Winsta0\DSCodeSandbox-<pid>-<nanos> 并授权给沙箱 SID
       |- 授予 helper 可执行文件 RX
       |- 以沙箱账号 LogonUser -> token
       |- 构造沙箱环境（HOME/USERPROFILE/APPDATA/TEMP/TMP 全部指向账号私有目录）
       `- CreateProcessWithTokenW 启动 broker 子进程（Job Object: KILL_ON_JOB_CLOSE）
            `- run-child：校验 SID 一致 -> CreateRestrictedToken（deny-only 沙箱 SID + Everyone）
                          -> SetTokenInformation(TokenDefaultDacl) -> CreateProcessAsUser
                          -> PROC_THREAD_ATTRIBUTE_HANDLE_LIST 限定继承句柄
                          -> 退出码与错误写入 result JSON 回传 broker
```

**网络隔离**：`setup` 阶段用 WFP（`fwpuclnt`）在 `eebecc03-...` 子层、4 个过滤层上按 `ALE_USERID == 沙箱 SID` 安装**阻止**规则。

**账号生命周期**：`dscode sandbox setup` 创建前缀为 `DSCode` 的本地账号，授予 `SeBatchLogonRight`，显式拒绝交互式/远程交互式/服务登录权，设置 `UF_SCRIPT | UF_PASSWORD_CANT_CHANGE | UF_NORMAL_ACCOUNT | UF_PASSWORD_EXPIRE` 并从登录界面隐藏；密码用 DPAPI 加密写入 `state.bin`。失败自动回滚，`uninstall` 清理全部残留。

退出码约定：`125` = 助手内部错误，`124` = 超时。

## 14. Electron 桌面端（`gui/`）

GUI **不复刻运行时**，只负责"进程、线路、桌面体验、安全边界"。

```text
Renderer (React 18 + zustand)
   ^ contextBridge（contextIsolation: true, nodeIntegration: false, sandbox: true）
Main 进程
   ^ stdio：严格 LF 结尾的 JSONL
dscode / omp / pi --mode rpc
```

- **CLI 探测**：顺序 `dscode` -> `omp` -> `pi`，`DSCODE_BIN` 可完全覆盖；GUI 应用在 macOS/Linux 上 PATH 很短，因此额外搜索 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.npm-global/bin`、`~/bin`。
- **协议握手**（`OmpHandshake`）：新版运行时首帧发 `ready`（声明 `supportedProtocolVersions` 与帧上限），GUI 取双方交集的最高版本，v2 时用 `negotiate_protocol` 激活；旧版运行时没有 `ready`，首帧即普通响应（视为 legacy v1）；**无公共版本 -> 报出双方版本号并关闭会话**（而不是抛 JSON 解析错误）。
- **两层分帧**（`OmpTransport`）：物理层 `LineReader`（`StringDecoder` 拼接多字节、单行 16 MB 上限、剥离 `\r`）；逻辑层 `RpcFrameDecoder` 重组 v2 的 `rpc_chunk`（严格 base64 往返校验、索引连续、长度精确匹配、`TextDecoder(fatal)` 校验 UTF-8）。
- **会话状态机**（`OmpSession`）：`starting -> idle <-> working -> waiting_for_user -> aborting -> failed/closed`。**只有** `agent_end`（且 `isTerminal !== false`）、本地完成的斜杠命令（`agentInvoked=false`）、或 Provider 错误才会结算一轮；被拒绝的命令只报错、绝不结算（否则会重复消费渲染器队列）。
- **事件归一化**（`OmpProtocol`）：把两代运行时的帧名统一成一套 `SessionEvent`（`compaction_start`/`auto_compaction_start` 合并；`subagent_lifecycle` / `subagent_progress` 合并成同一个 `subagent` 事件），渲染层永远看不到协议版本。
- **能力探测**（`OmpCapabilities`）：能力**只来自真实证据** —— `--version` 探针、会话握手、`get_state` 响应、以及子代理命令的真实 RPC 结果。只有 `Unknown command: X` 才算"不支持"，超时/进程死亡记为 `unknown` 而非 `unsupported`。
- **权限映射**：dscode 走原生 `--permission`；`no-bash` / `readonly` 用 `--tools` **白名单**（未来新增工具默认不可用，安全降级），而不是黑名单。legacy pi 才需要 `--exclude-tools` + 内置 approval 扩展。
- **文件系统边界**（`fsGuard`）：root 在注册时 `realpath` 规范化；读要求目标真实路径在 root 内；写对**不存在的目标**回溯到最近的已存在祖先再判定，从而既允许在项目内新建文件、又拒绝通过指向外部的符号链接目录创建文件。

## 15. HTTP 适配器（`packages/http-adapter/`）

一个 **REST + SSE** 的薄适配层，把 agent 会话暴露成 HTTP 资源（Fastify 5）。**当前为 `private` + `0.0.0`，仓库内无任何引用**，属于尚未接入的实验性产物。

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | `/health` | 存活探针 |
| POST | `/v1/sessions` | 创建或恢复会话（`201`） |
| GET / DELETE | `/v1/sessions/:id` | 会话状态 / 中止并释放（`204`） |
| GET | `/v1/sessions/:id/events` | SSE 事件流 |
| POST | `/v1/sessions/:id/turns` | 启动一轮（`202`） |
| POST | `/v1/sessions/:id/turns/:turnId/abort` | 中止一轮（`202`） |
| POST | `/v1/sessions/:id/ui-requests/:requestId/responses` | 应答交互式对话框（`204`） |

SSE 事件类型：`turn` / `assistant_text_delta` / `tool` / `ui_request` / `ui_event` / `extension_error`；UI 方法：`confirm` / `select` / `input` / `editor`。

## 16. VS Code 扩展（`editors/vscode/`）

极薄的一层：三个命令（`dscode.open` / `dscode.askSelection` / `dscode.fixDiagnostics`）+ 一个状态栏项，把编辑器上下文（选区 +-20 行，或最多 100 条诊断）拼成 prompt，**注入一个已打开的 DSCode 终端**。不直接使用 RPC。其版本号已与 core 同步（0.4.0）；vsix 为构建产物，仓库不再跟踪。

## 17. 构建与发布

```text
pnpm build          = build:core (tsc packages/core) + tsc -p tsconfig.json
pnpm typecheck      = build:core + tsc --noEmit
pnpm test           = vitest run
pnpm package:check  = node scripts/package-smoke.mjs
pnpm check          = typecheck && test && build && package:check
```

- **`package:check`** 会真的 `npm pack` 出两个 tarball，装进临时目录并验证版本一致与可执行 —— 防止"源码能编译但发包后跑不起来"。
- **TypeScript 严格度**：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`，NodeNext 模块解析。
- **CI**（`.github/workflows/ci.yml`）：Node 24 + pnpm 10.12.2 + Go 1.25.x，`DSCODE_SANDBOX_IMAGE=node:24-bookworm-slim` 让 Docker 沙箱在 Linux CI 上可用；PR 合入 main 前会校验"core 版本必须与 CLI 版本一致"且"版本号已发布则必须先 bump"。
- **发布**（`publish.yml` + `release.yml`）：npm Trusted Publishing（OIDC，无长期 token），先 `pnpm check` 再 `npm pack` 再按 tarball 发布 CLI 与 core 两个包；已发布过的版本自动跳过。
- **GUI CI**：独立的 `gui-ci.yml` / `gui-release.yml`，electron-builder 产物（dmg/zip/nsis/AppImage）。

## 18. 测试策略

| 层 | 位置 | 规模 | 特点 |
|----|------|------|------|
| 核心单元/集成 | `test/` | 58 文件，349 处顶层 `it`/`test`（部分用例以 `it.skipIf(...)(` 换行书写，该计数为下限） | 直接从 `packages/core/src/*.ts` 导入（不经构建产物），覆盖参数解析、权限分类、沙箱解析、Provider 表、MCP、补丁、检查点、口味、预算、遥测等 |
| CLI 端到端 | `test/cli-integration.test.ts` | 2 | 起真实 `dist/cli.js`，用本地 mock SSE 服务器模拟 OpenAI/DeepSeek 响应流 |
| 端口机制 E2E | `scripts/verify-ports.mjs` | 4 场景 | 隔离 `DSCODE_HOME` + mock 服务：预算硬停（**零 Provider 请求**）、钩子信任流、预算记账与 75% 预警、429 配额错误有界重试 |
| 打包冒烟 | `scripts/package-smoke.mjs` | — | 真实 `npm pack` + 安装 + 启动 |
| Go 沙箱 | `native/windows-sandbox/internal/**/*_test.go` | — | ACL / 防火墙 / runner / setup 单测 |
| GUI 单元 | `gui/src/**/*.test.ts` | 36 文件 | fsGuard、handshake、transport、rpcframe、protocol、session 状态机、messageMapping 等 |
| GUI 兼容性 | `gui/integration/dscode/*.compat.test.ts` | 5 文件 | 真机 RPC 驱动（`pool: forks`，串行） |
| GUI Live | `*.live.test.ts` | 需 `DSCODE_GUI_RUN_LIVE_TESTS=1` | 调真实 Provider，CI 永不运行 |

平台相关用例用 `it.skipIf(process.platform !== "darwin")` 之类的守卫跳过（例如 Seatbelt 沙箱用例只在 macOS 生效），CI 通过设置 `DSCODE_SANDBOX_IMAGE` 让 Docker 后端在 Linux 上接管。

## 19. 设计取舍与已知缺口

1. **`packages/http-adapter` 未接入**：代码与文档完整，但仓库内无引用，且标为 `private`。
2. **VS Code 扩展能力浅**：版本已同步 core，但仍只做终端注入，未接 RPC。
3. **Windows 沙箱是实验性**：需 `DSCODE_WINDOWS_SANDBOX=1` 显式开启 + 一次管理员 `dscode sandbox setup`；未就绪时 `/doctor` 与 `/status` 会给出精确排障指引，**不会**静默退回宿主执行。
4. **Linux 默认无沙箱**：不设 `DSCODE_SANDBOX_IMAGE` 且无 Docker 时，除 `danger-full-access` 外所有沙箱档位都判定为 `unavailable` 并报错。
5. **GUI 打包绕过部分依赖**：`gui/electron.vite.config.ts` 用自定义 Rollup 插件把 `require("node:sqlite")` 惰性化（Electron 33 内置 Node 20 没有该模块），并 neutralize `undici` 的 `webidl.util.markAsUncloneable`。
6. **多 Provider 的默认模型 ID 强耦合上游数据文件**：`providers.ts` 注释明确要求默认模型 ID 必须存在于 `@earendil-works/pi-ai` 的 provider data 中，升级 pi 版本时需同步核对这张表。

## 20. 相关文档

| 文档 | 内容 |
|------|------|
| [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) | 模块地图、数据落盘、环境变量表、RPC 帧格式、关键算法、工程约定 |
| [`WINDOWS_SANDBOX.md`](./WINDOWS_SANDBOX.md) | Windows 原生沙箱安全契约、验收测试、上线闸门 |
| [`RELEASING.md`](./RELEASING.md) | 发版流程 |
| [`gui/docs/architecture.md`](../gui/docs/architecture.md) | GUI 侧架构（Desktop Host 视角） |
| [`gui/docs/protocol-facts.md`](../gui/docs/protocol-facts.md) | RPC 协议事实（经真机验证） |
| [`gui/docs/security-model.md`](../gui/docs/security-model.md) | GUI 安全模型 |
| [`PRODUCT_STRATEGY.md`](./PRODUCT_STRATEGY.md) / [`COMPARISON.md`](./COMPARISON.md) | 产品定位与竞品对比 |

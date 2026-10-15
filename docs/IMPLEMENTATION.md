# DSCode 实现说明

> 配套文档：[`ARCHITECTURE.md`](./ARCHITECTURE.md)（分层与设计取舍）。
> 本文给出**模块级**实现细节：文件地图、落盘格式、环境变量、RPC 帧格式、关键算法与工程约定。
> 所有内容均来自当前仓库代码（`v0.4.0`）。

## 1. 核心包模块地图（`packages/core/src/`，104 个 `.ts` 文件）

按职责分组：

| 领域 | 模块 |
|------|------|
| 入口 / 参数 | `cli-runtime.ts`(`runDSCode`/`runDSCodeProcess`/`formatDSCodeError`)、`runtime-options.ts`(`parseRuntimeArgs`/`printDSCodeHelp`)、`index.ts`(公共 API 出口)、`version.ts`、`exit.ts`、`process.ts`、`shell.ts` |
| 扩展中枢 | `dscode-extension.ts`(`createDSCodeExtension`)、`tui-experience.ts`(`registerCodingTui`)、`tool-ui.ts`、`ui-defaults.ts`、`ui.ts`、`terminal-ui.ts`、`welcome.ts`、`brand.ts` |
| 工具 | `tools.ts`(`createCodingTools`)、`patch.ts`(`applyWorkspacePatch`/`parsePatch`)、`workspace.ts`(`Workspace`)、`managed-process.ts`(`ManagedProcessRegistry`)、`diagnostics.ts`、`image-input.ts`、`deferred-tools.ts`、`reread-guard.ts` |
| 安全 / 权限 | `access.ts`(`SessionAccessController`/`commandNeedsNetwork`/`detectSandboxBoundary`)、`approval.ts`(`ApprovalController`/`classifyCommand`)、`sandbox.ts`、`windows-sandbox.ts`、`project-trust.ts`、`hook-trust.ts`、`hooks.ts`、`guardrails.ts` |
| 会话 / 状态 | `home.ts`、`session.ts`(`SessionStore`)、`state.ts`(`DSCodeStateStore`)、`checkpoint.ts`、`rewind.ts`、`plan.ts`、`project-init.ts`、`project-profile.ts`、`competitor-sessions.ts`、`sync.ts` |
| Provider / 凭据 | `providers.ts`、`provider-setup.ts`、`models-json.ts`、`model.ts`、`auth.ts`、`credential-store.ts`、`settings.ts`、`config.ts`、`fallback.ts`、`service-tier.ts`、`login-scope.ts`、`pi-login-mask.ts` |
| 网络能力 | `web-search.ts`、`web-search-providers.ts`、`mcp.ts`、`mcp-describe.ts`、`mcp-vault.ts`、`ssrf-guard.ts` |
| 自主循环 | `goal-loop.ts`、`scheduler.ts`、`cron-lite.ts`、`budget.ts`、`lanes.ts`、`compaction.ts`、`context-prune.ts`、`continuation.ts`、`self-wakeup.ts`、`goal-verifier.ts` |
| 研究 / 知识 | `alpha-tools.ts`、`alpha-sections.ts`、`huggingface-tools.ts`、`science-connectors.ts`、`paper-rank.ts`、`research-run.ts`、`knowledge.ts`、`memory.ts`、`taste.ts` |
| 运行时辅助 | `telemetry.ts`、`doctor.ts`、`status.ts`、`discovery.ts`、`setup.ts`、`setup-prompts.ts`、`packages.ts`、`package-ops.ts`、`skills-installer.ts`、`prompt.ts`、`workbench-types.ts`、`type-guards.ts`、`rpc-client.ts`、`rpc-entry.ts`、`runtime-branding.ts`、`pi-markdown.ts` |

### 公共 API（`packages/core/src/index.ts`）

对外暴露的分组：

- 运行入口：`runDSCode` / `runDSCodeProcess` / `formatDSCodeError` / `createDSCodeExtension`
- RPC：`createDSCodeRpcClient` / `getDSCodeRpcEntryPath` / `RpcClient`
- 认证族：`authenticateProvider` / `saveDeepSeekKey` / `hasStoredProviderCredential` / `runAuthCommand` ...
- 凭据仓库族：`FileCredentialStore` / `KeyringCredentialStore` / `createDSCodeCredentialStore` / `installDSCodeCredentialStore`
- 目录族：`getDSCodeHome` / `initializeDSCodeHome` / `partitionSessionFile` / `migrateLegacyDSCodeHome`
- 状态族：`DSCodeStateStore` / `listDSCodeThreads` / `indexDSCodeSession`
- Provider 族：`SUPPORTED_PROVIDER_IDS` / `defaultModelForProvider` / `chooseRecommendedModel` / `upsertProviderConfig` / `configureCustomProvider`
- 配置族：`parseRuntimeArgs` / `sandboxModeSchema` / `getDSCodeStorageSettings` / `saveServiceTier`
- 搜索族：`executeWebSearch` / `searchWithExa` / `searchWithPerplexity` / `searchWithSearchMcp`
- 包管理族：`installPackageSources` / `updateConfiguredPackages` / `installSkills`
- 诊断族：`runDoctor` / `runDoctorCli` / `collectStatusSnapshot` / `DSCODE_VERSION`
- 研究族：`searchArXiv` / `searchHuggingFaceModels` / `createResearchRunReport` / `registerAlphaTools` / `registerHuggingFaceTools`

`@thinkany/dscode-core/rpc` 子路径导出 `createDSCodeRpcClient` / `getDSCodeRpcEntryPath` / `RpcClient`，供 IDE 类宿主启动品牌化 RPC 工作进程。

## 2. CLI 参数面

### DSCode 自有参数（`runtime-options.ts`）

| 参数 | 取值 | 默认 |
|------|------|------|
| `-C, --cwd <dir>` | 路径 | `process.cwd()` |
| `--provider <id>` | 14 个 Provider id 之一 | `DSCODE_PROVIDER` > `settings.json` > `deepseek` |
| `--base-url <url>` | http(s) URL | `DEEPSEEK_BASE_URL` > `config.json` > `https://api.deepseek.com` |
| `--model <id>` | 字符串 | `DSCODE_MODEL` > `settings.json` > Provider 默认 |
| `--effort <level>` | `--thinking` 的别名 | `DSCODE_EFFORT` > Provider 默认 |
| `--transport` | `responses` / `chat` | `DSCODE_TRANSPORT` > `responses` |
| `--harness` | `minimal` / `safe` | `DSCODE_HARNESS` > `minimal` |
| `--permission` | `plan` / `ask` / `auto` / `full` | `DSCODE_PERMISSION` > `auto` |
| `--sandbox` | `read-only` / `workspace-write` / `danger-full-access` | `DSCODE_SANDBOX` > `workspace-write` |
| `--network` | 布尔 | `false` |
| `--web` | 布尔 | `loadWebSearchConfig().enabled` |
| `-y, --yes` | 隐含 `permission=full` 并前插 `--approve` | — |
| `--tools <csv>` / `--no-tools` | 显式工具白名单 | 由 harness 推导 |
| `--help/-h`、`--version/-V` | — | — |

### 透传规则

- 未识别的参数原样进入 `piArgs`。
- 结束时若 `piArgs` 中尚无对应项，依次 `unshift`：`--provider <id>`、`--model <modelId>`、`--thinking <effort>`。
- `-y` 且未显式给 `--approve/-a/--no-approve/-na` 时补 `--approve`。
- `history.persistence = "none"` 且未显式给会话类参数时补 `--no-session`。
- `toolsExplicit` 为真时**不会**把 MCP 工具并进活动工具集。

### 内核外子命令（不进入 pi 运行时）

`doctor`、`setup`、`packages list|install|update|remove`、`install-skills [--codex|--opencode|--repo]`、`provider [type]`、`login [provider]`、`logout [provider]`、`auth status [provider]`、`sandbox setup|status|uninstall`。

## 3. 参数校验模式

枚举类参数用 **zod**（`config.ts` / `runtime-options.ts`）：

```ts
effortSchema      = z.enum(["low", "high", "max"]);
transportSchema   = z.enum(["responses", "chat"]);
harnessSchema     = z.enum(["minimal", "safe"]);
permissionSchema  = z.enum(["plan", "ask", "auto", "full"]);
sandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
```

工具参数用 **typebox**（`Type.Object`）：

```ts
const execCommandParameters = Type.Object({
  cmd: Type.String({ minLength: 1, description: "Shell command to execute from the current workspace" }),
  yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000 })),
  timeout_ms:   Type.Optional(Type.Integer({ minimum: 1_000, maximum: 600_000 })),
});
```

## 4. 安全实现细节

### 4.1 `SessionAccessController`（`access.ts`）

```ts
effective(permission) {
  if (permission === "full") return { sandbox: "danger-full-access", network: true };
  return {
    sandbox: permission === "plan" ? "read-only" : this.baseSandbox,
    network: this.baseNetwork || this.baseSandbox === "danger-full-access",
  };
}
```

- 会话级授权集合：`networkCommands` / `hostCommands`，键是 `command.replace(/\\\n/g," ").replace(/\s+/g," ").trim()`。
- `forCommand()`：`plan` 模式**永不**命中 host 授权；命中 host 授权则直接升级为 `danger-full-access + network`。
- `grantOnce()` 只影响本次调用，不写集合。

### 4.2 `classifyCommand`（`approval.ts`）三档判定

| 档位 | 判定 |
|------|------|
| `dangerous` | 命中 `rm/rmdir/sudo/doas/mkfs/shutdown/reboot/kill/pkill/killall`，或 `git reset/clean`，或 `git checkout/restore ... -- ./` |
| `read-only` | 可执行文件在 `pwd/ls/tree/head/tail/wc/file/stat/which/type`；`cat/rg/grep`（排除 `--files-without-match`）；`find`（排除 `-delete/-exec*/-ok*`）；`sed`（排除 `-i`）；`git status/diff/log/show/branch/rev-parse/ls-files/grep`；且**不含** shell 元字符与绝对/上跳路径 |
| `needs-approval` | 其它一切；命中正则 `[;&\|><` + 反引号 + `$()` 或换行 一律升级；参数中出现绝对路径、`~/`、`..`、`/../` 一律升级 |

### 4.3 `Workspace` 路径校验（`workspace.ts`）

`resolve(userPath, allowMissing)` 顺序：拒绝 NUL -> `path.resolve` -> `assertLexicallyInside` -> `fs.realpath` -> `assertReallyInside`；目标不存在且 `allowMissing` 时 `findExistingParent()` 向上找到第一个存在目录后再 `realpath` 判定。

### 4.4 进程执行与输出截断

| 组件 | 用途 | 默认上限 | 停止策略 |
|------|------|----------|----------|
| `ManagedProcessRegistry` | `exec_command` / `write_stdin` | `BoundedOutput(80_000)` | `SIGTERM` -> 1.5s -> `SIGKILL`；win32 用 `taskkill /t /f` |
| `runProcess` | 一次性工具（hook、git diff、诊断） | `BoundedOutput(200_000)` | 同上；非 win32 且 `detached` 时按进程组 kill |
| `executeSandboxedCommand` | `user_bash` 路径 | 无缓冲，流式 | 同上 |

`BoundedOutput` 保留 **头 75% + 尾 25%**，截断时插入 `... output truncated; tail follows ...`。

所有 `spawn` 的环境都经过 `stripModelCredentialEnvironment()`。

### 4.5 沙箱命令构造

macOS Seatbelt profile（`workspace-write` 示例）：

```text
(version 1) (allow default)
(deny file-write* (require-not (require-any
  (subpath "<realpath(cwd)>") (subpath "<realpath(os.tmpdir())>"))))
(deny network*)
```

Docker 后端关键参数：`run --rm -i --user <uid>:<gid> --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 [--network none] [--read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m] -v <cwd>:/workspace[:ro] -w /workspace <image> /bin/sh -lc <cmd>`。

### 4.6 钩子信任（`hooks.ts` + `hook-trust.ts`）

- 配置：`~/.dscode/hooks.json`（或项目级），四个钩子点 `sessionStart` / `beforeTool` / `afterTool` / `agentEnd`；每条含 `command` / `args[]` / `timeoutMs`（100ms ~ 300s，默认 30s）。
- 信任：**每条不同的命令调用**（对 `[command, args]` 的 JSON 做 SHA-256）必须先进入 `~/.dscode/trusted-hooks.json` 白名单才会执行。
- 审计：每次执行追加一行 JSONL 到 `~/.dscode/audit/hooks.jsonl`，`outcome` 形如 `untrusted-blocked` / `success`。
- `beforeTool` 可返回 `block`；`agentEnd` 可请求 `continuation`，但同一轮的 `stopHookActive` 标志保证"钩子引发的续跑不会再触发钩子"。

## 5. 落盘格式

### 5.1 `~/.dscode/config.json`

```json
{
  "deepseek": { "baseUrl": "https://api.deepseek.com" },
  "serviceTier": "...",
  "cli_auth_credentials_store": "auto",
  "sqlite_home": "/optional/path",
  "history": { "persistence": "save-all" }
}
```

写入方式：`mkdir 0700` -> 临时文件 `{path}.{pid}.{uuid}.tmp` 写 0600 -> `rename` -> 最终 `chmod 0600`。

`baseUrl` 归一化：去尾部 `/`，必须能 `new URL()`，协议必须 http/https，且**不得**含用户名、密码、query 或 fragment。

### 5.2 `~/.dscode/state.sqlite`

```sql
PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, session_path TEXT NOT NULL, storage_path TEXT NOT NULL,
  cwd TEXT NOT NULL, title TEXT NOT NULL, preview TEXT, provider TEXT, model TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  file_size INTEGER NOT NULL DEFAULT 0, file_mtime_ms REAL NOT NULL DEFAULT 0
);
-- 索引：threads(archived, pinned DESC, updated_at DESC)
--      threads(cwd, archived, updated_at DESC)
--      threads(storage_path)
PRAGMA user_version = 1;
```

增量索引：`indexFile()` 先比对 `file_size` + `file_mtime_ms` + `archived`，命中缓存直接返回。`refresh()` 会把磁盘上已消失的 transcript 从表中删除。

### 5.3 会话分区（`home.ts`）

`partitionSessionFile()`：日期取自 transcript **首行 header 的 `timestamp`**（读不到则退回 mtime），目录 `sessions/YYYY/MM/DD/`；先 `rename` 到分区路径，再 `link` 回扁平路径。路径冲突且 inode 不同则**不覆盖**，直接返回原路径。硬链接失败则 `rename` 回退并保持扁平。

`migrateLegacyDSCodeHome()`：把旧布局 `~/.dscode/agent/` 下的 `auth.json`、`settings.json`、`models.json`、`models-store.json`、`trust.json`、`skills`、`extensions`、`prompts`、`themes`、`bin`、`packages`、`npm`、`git` **向上复制**到 `~/.dscode/`（已存在则跳过，不删除任何东西），随后把 `auth.json`/`settings.json`/`trust.json` 收紧到 0600。

### 5.4 凭据（`credential-store.ts`）

- 文件格式与上游 `auth.json` 兼容：`{ "<providerId>": { "type": "api_key", "key": "..." } | { "type": "oauth", "access", "refresh", "expires" } }`。
- 钥匙串：service `ai.thinkany.dscode`，account = providerId；`credential-metadata.json` 只存 `{version, providers: {id: {type}}}`。
- `AutoCredentialStore.read()`：钥匙串命中优先，否则回落文件；`modify()` 写钥匙串失败则回落文件；启动时 `migrateFileCredentials()` 把文件凭据搬到钥匙串，**搬运失败时保留文件凭据**。
- 无 TTY 时的钥匙串闸门：`process.versions.electron || (stdin.isTTY && stdout.isTTY) || DSCODE_ALLOW_HEADLESS_KEYRING === "1"`。
- 锁：`mkdir` 目录锁，`LOCK_TIMEOUT_MS = 15_000`、`LOCK_STALE_MS = 30_000`，锁路径 `~/.dscode/.credential-locks/<sanitized-provider>.lock`。

### 5.5 MCP 保险库（`mcp-vault.ts`）

`~/.dscode/mcp-vault.json`（0600）：

```json
{ "version": 1, "entries": { "<NAME>": { "value": "...", "updatedAt": "ISO-8601" } } }
```

名字必须匹配 `^[\w.-]{1,64}$`。MCP 配置里用 `${vault:NAME}` 引用；解析不到时**抛错并列出可用条目**，绝不把字面量原样传给服务器。

## 6. MCP（`mcp.ts`）

配置来源与合并：`~/.dscode/mcp.json`，若项目被信任则再读 `<cwd>/.dscode/mcp.json`（后者覆盖前者同名条目）。

```json
{
  "mcpServers": {
    "name":   { "command": "node", "args": ["server.mjs"], "env": { "K": "${vault:TOKEN}" }, "cwd": "./x", "disabled": false },
    "remote": { "url": "https://...", "headers": { "Authorization": "Bearer ${vault:TOKEN}" }, "disabled": false }
  }
}
```

- 传输：`StdioClientTransport` / `StreamableHTTPClientTransport`。
- 环境：`${VAR}` 展开自 `process.env`；stdio 子进程的环境经过 `stripModelCredentialEnvironment()`。
- 工具命名：`mcp__<sanitize(server)>__<sanitize(tool)>`，`sanitize` 把非 `[A-Za-z0-9_-]` 换成 `_`；`executionMode: "parallel"`。
- 描述合成：连接后用**后台 lane 模型**把冗长的第三方描述压缩，按 `(server, tool, description)` 缓存到 `~/.dscode/mcp-descriptions.json`；失败则用原始描述。每次连接最多合成 `MAX_SYNTHESIZE_PER_CONNECT` 个，单条结果不超过 `MAX_SYNTHESIZED_CHARS`。
- 客户端标识：`{ name: "dscode", version: DSCODE_VERSION }`。

## 7. 上下文与预算（关键算法）

### 7.1 两级裁剪（`context-prune.ts`，作用于 `pi.on("context")`）

按上下文占用率分档，**只做每请求投影，不改写已落盘的 transcript**（压缩之后自然失效）：

| 阈值 | 行为 |
|------|------|
| `TIER1_PRUNE_AT`（50%） | 老工具结果降级为单行占位，保留最近 `TIER1_KEEP_RECENT_TOOL_RESULTS`（20）条 |
| `PRE_TRIM_AT`（80%） | 收紧到保留最近 `KEEP_RECENT_TOOL_RESULTS`（10）条 |
| 接近压缩阈值 | 先做轻度裁剪，再提示用户手动 `/compact`（避免直接触发昂贵的完整压缩） |

另有 `repairOrphanToolResults()` 修复"有 tool_call 没有 tool_result"（反之亦然）的消息序列 —— 两者在"无改动"时原样返回输入标识。

### 7.2 单条工具输出守卫（`guardrails.ts`）

`throttleToolResult(toolName, content)`：超过 `TOOL_OUTPUT_TOKEN_LIMIT` 时替换为占位文本并 `notify` 用户被扣留的 token 数；`TOOL_OUTPUT_WHITELIST`（含 `web_search`）豁免 —— 它的输出本身就是交付物。

### 7.3 月度预算（`budget.ts`）

- 配置 `~/.dscode/budget.json`，账本 `~/.dscode/usage/usage-YYYY-MM.json`（也可用 `DSCODE_BUDGET_USD` 覆盖）。
- `BUDGET_WARN_THRESHOLDS` 分档**每月只警告一次**；超限后 `input` 钩子直接消费输入（不发请求），非交互模式 `process.exitCode = 1`。
- 每轮 `agent_settled` 只把**本会话增量成本**（`summarizeSessionUsage(...).cost - lastRecordedSessionCost`）记入账本。

### 7.4 Provider 降级链（`fallback.ts`）

`classifyQuotaError()` 识别限流 / 额度耗尽 / 超额等错误 -> 若已配置 fallback 模型且当前不在 fallback 上，则 `pi.setModel(fallback)` 并**重放最后一条用户输入**（`deliverAs: "followUp"`）。切换是**单向**的，因此结构上不可能出现重试风暴。

### 7.5 后台 lane（`lanes.ts`）

用于压缩摘要、分支摘要、口味学习、MCP 描述合成。解析顺序：`DSCODE_COMPACTION_MODEL` / `DSCODE_LEARNING_MODEL` / `DSCODE_BACKGROUND_MODEL` -> Provider 默认的廉价模型 -> 会话模型；所有候选模型都失败时，回落到**机械零模型骨架摘要**（`mechanicalDigestSummary`：保留用户提示与工具使用、丢弃工具输出），绝不抛错打断会话。

### 7.6 目标循环（`goal-loop.ts`）

`/loop <goal> [maxTurns]` 武装一个跨轮次的自治模式，状态存为 session entry（跨重启可恢复）。`agent_end` 仲裁器每轮调用 `advanceGoalLoop()`；连续 3 轮失败判定为"空转"并自动停止。`/loop stop` 解除。

### 7.7 调度器（`scheduler.ts` + `cron-lite.ts`）

- 每项目一份 `ScheduleJob` 列表（`schedulesFileFor(ctx.cwd)`），上限 `MAX_SCHEDULES`，间隔限制 `MIN_INTERVAL_MINUTES` ~ `MAX_INTERVAL_MINUTES`。
- 五字段 cron（`*`、列表、范围、步进），0 和 7 都是周日。
- 启动时：到期的**一次性**任务先询问用户，**周期性**任务直接触发；触发时用 `pi.sendUserMessage(buildWakeupPrompt(...), { deliverAs: "followUp" })` 注入当前会话。
- 长等待用 `setTimeout` 分段重臂（受 32 位上限约束）。

### 7.8 口味学习（`taste.ts`）

`<cwd>/.dscode/taste/taste.md` 存放带置信度的用户偏好条目，`.learned.json` 存放已学习游标（仓库根已有 `.dscode/taste/.learned.json`）。每轮 `agent_settled` 后在后台 lane 上把新用户提示蒸馏成偏好条目。另有代码库口味学习（`runCodebaseTasteLearning`）与来自 Claude Code / Codex / Cursor 本地会话的**只读**导入（`competitor-sessions.ts`，绝不回写）。全部路径经 `validateTasteRelativePath()` 校验，文件大小上限 `MAX_TASTE_FILE_BYTES`。

### 7.9 检查点与 rewind（`checkpoint.ts` / `rewind.ts`）

- `capturePatchCheckpoint()` 在打补丁**前后**对涉及文件做全量快照（内容 + mode + SHA-256），检查点以 session entry 持久化。
- `restoreCheckpoint()` 先比对当前快照与 `checkpoint.after` 的哈希；有差异则**拒绝回滚**并列出冲突文件（除非 `force`）。写入走"同目录临时文件 -> `rename`"；原本不存在的文件直接 `rm`。
- `/rewind` 把"对话位置"和"该轮的文件检查点"组合成回退点；导航时按需触发分支摘要。

### 7.10 回合恢复与恒定状态（`continuation.ts` / `compaction.ts`）

`agent_end` 对三类"停了但不该停"的回合做**有界**自动续跑：空响应（2 次，耗尽提示区分有 thinking 与纯空）、长度截断（3 次，要求接续不重复）、悬空意图（"I'll now run the tests:" 式宣告未执行，2 次）。本回合用过工具即重置进度计数，真实用户输入清零全部计数；`stopReason` 为 `error`/`aborted` 的回合不恢复（错误归 run_error 反馈环，打断是用户意图）；json 模式跳过。每轮 `before_agent_start` 把未完成 plan 与武装 goal loop 重注入 system prompt，压缩消灭不了这两项会话级状态。

### 7.11 自调度与后台监视（`self-wakeup.ts`）

`schedule_wakeup` 允许模型排**一个**未来检查（60–3600s），唤醒回合以数据围栏注入；连续自调度链条上限 30（真实用户输入重置），触顶时工具拒绝并引导用户运行 `/loop`。`exec_command` 的 `monitor_seconds` 监视后台进程：按节奏注入**零输出 ping**（运行中一次、退出时带退出码），是否读日志由模型决定。两者仅在 TUI 模式驱动。

### 7.12 Goal 校验器（`goal-verifier.ts`）

loop 自判 `LOOP_COMPLETE` 时，由独立无工具 LLM 调用（learning lane、20s 超时）基于**最近 8 条真实工具结果**仲裁；`<goal>`/`<agent_response>`/`<evidence>` 全部经 `defangVerifierTags` 中和尖括号；任何失败一律判"未完成"（保守方向让循环继续），单个 loop 最多接受 3 次否决覆盖。

### 7.13 延迟工具（`deferred-tools.ts`）

MCP 工具数 ≥ 12 时其 JSON Schema 退出请求，以一行 TypeScript 签名进入 system prompt（`- name{field: type, opt?: type}: 首句`）；`search_tools` 按能力查询（IDF 加权、名称命中优先）或 `select:<name>` 加载完整 schema，加载后为整场会话重新激活。`tool_call` 阶段另有工具别名表：未知的外来源工具名（`bash`、`todo_write`、`task_output`…）被拦截并给出正确的 DSCode 调用。

### 7.14 出网与读取守卫（`ssrf-guard.ts` / `reread-guard.ts`）

出网 fetch（HuggingFace / science connectors）统一经 `guardFetchUrl`：内嵌凭据、私网/链路本地/CGNAT/云 metadata（含 IPv4-mapped IPv6、NAT64、6to4 的内嵌判定）、单标签主机一律拒绝，http 自动升级 https 并回报。`tool_result` 阶段按 `(path, mtime, size, 行区间)` 做 LRU 计数，第 3 次完全相同的读取以通知替换内容。

### 7.15 计划护栏（`plan.ts` `planUpdateNotes`）

`update_plan` 结果按与上一版的差分追加三条语义护栏：重复提交相同计划、静默丢弃未完成步骤、收尾无验证步骤。与 `validatePlanSteps` 的结构校验互补。

## 8. 子代理协议（`subagents.ts`）

```text
delegate({ tasks: [{ role, task }, ...] })   // 1..8 个任务
  -> mapLimited(tasks, 4)                    // 并发上限 4
     -> 以当前可执行文件 spawn:
        <self> -C <cwd> --provider P --base-url U --transport T --model M
               --harness H --mode json --print --no-session
               --permission plan|auto --sandbox read-only|workspace-write
               --thinking low|max   [--network] [--web]  <rolePrompt>
        env: DSCODE_SUBAGENT_DEPTH = 当前值 + 1
```

`registerSubagentTools()` 在 `DSCODE_SUBAGENT_DEPTH >= 1` 时**直接 return**，因此子代理拿不到 `delegate`，形成一层硬性隔离。`implementer` 先建 detached worktree，结束时 `git add -N -- .` + `git diff --binary --no-ext-diff` 生成补丁返回。

## 9. GUI RPC 线协议（`gui/src/main/omp/`）

### 9.1 物理层：JSONL over stdio

- 一行一个 JSON 对象，双向都如此；出站 `serializeCommand(cmd) => JSON.stringify(cmd) + "\n"`。
- `LineReader`：`StringDecoder` 保证跨 chunk 的多字节 UTF-8 不被切坏；任意字节切分只会**延迟**一条完整行；剥离行尾 `\r`；单行超过 `MAX_LINE_BYTES = 16 MB` 产生 transport error 并丢弃该行（流保持打开）。
- 入站命令**不做分片** —— 已实测运行时 stdin 侧对 2 MiB 命令无限制。

### 9.2 逻辑层：协议 v2 `rpc_chunk`

| 常量 | 值 |
|------|-----|
| `MAX_RPC_FRAME_BYTES` | 1 MiB（逻辑帧下限） |
| `MAX_RPC_REASSEMBLED_BYTES` | 64 MiB（重组上限） |
| `RPC_CHUNK_PAYLOAD_BYTES` | 256 KiB（单片原始负载） |

校验规则（与上游 `RpcFrameDecoder` 逐条对齐）：

- `chunkId` 非空且长度 <= 128；
- `index` / `count` / `byteLength` 均为安全整数，`0 <= index < count`；
- `count` 落在 `[2, ceil(64MiB / 256KiB)]`；
- `byteLength` 落在 `[1MiB, 64MiB]`；
- `data` 严格 base64（字母表 + 填充正则）且 **decode -> encode 往返一致**；
- 序列必须从 `index 0` 开始、索引连续、`chunkId`/`count`/`byteLength` 三者全程一致；
- 累计字节必须**精确等于** `byteLength`；
- 重组后用 `TextDecoder(fatal)` 验证 UTF-8 并 `JSON.parse` 成对象。

任一违规抛 `RpcFrameError`（带机器可读 `code`）并**清空整个序列状态**（不卡死解码器）。

### 9.3 握手状态机（`OmpHandshake`）

```text
bootstrapping --ready帧--> negotiating --success--> active (v2)
       |                          \--failure/timeout--> active (v1, 线默认)
       |                          \--无公共版本------> failed (兼容性错误)
       \--其它任何帧--------------------------------------------> active (legacy v1, 该帧透传)
```

`GUI_SUPPORTED_PROTOCOLS = [1, 2]`。协商超时 5s（`NEGOTIATE_TIMEOUT_MS`），超时后**降级到 v1**（线默认）而不是失败。任何状态下都允许写命令 —— 协商前的线格式同样是 v1 JSONL。运行时声明的帧上限会被夹紧到 `[1 KiB, 1 GiB]`。

### 9.4 GUI 发出的 RPC 命令

`prompt`、`abort`、`set_model`、`set_thinking_level`、`compact`（超时 120s）、`steer`、`follow_up`、`get_state`、`get_messages`（15s）、`get_session_stats`、`set_session_name`、`export_html`（30s）、`set_subagent_subscription`、`get_subagents`、`get_subagent_messages`、`negotiate_protocol`，以及兼容探测 `get_available_commands` -> 失败回退 `get_commands`。

### 9.5 能力判定（`classifyRpcResponse`）

| 响应 | 判定 |
|------|------|
| `success: true` 且 data 可解析 | `supported` |
| `success: false`，错误**不是** `Unknown command: X` | `supported`（命令存在，只是这次调用失败） |
| `success: false` 且错误匹配 `^Unknown command: ([A-Za-z_][A-Za-z0-9_]*)$` | `unsupported` |
| `null`（超时 / 进程死亡 / 传输层） | `unknown`（**不会**降级已知的 supported） |

无 id 的失败帧还会做一次安全关联：只有当错误里的命令名与**恰好一个**在途请求的命令类型匹配时才认领，否则当作噪声放行。

### 9.6 归一化事件（`normalizeRpcFrame`）

- 两代帧名归一：`compaction_start|auto_compaction_start` -> `compaction(start)`；`subagent_lifecycle` / `subagent_progress` -> 同一个 `subagent` 事件（lifecycle 带 phase，progress 带聚合的工具事实）。
- `message_end` 中 `stopReason === "error"` 会被**转成 error 事件**（只取首行，因为 Provider 错误常附带原始 JSON body）—— 否则用户看到的是一个"静默死掉的回合"。
- `agent_end` 缺省即终态；只有显式 `isTerminal: false` 才视为非终态。
- 子代理状态映射是**精确匹配**（不猜子串）。
- 未识别的帧一律不投射并在 debug 通道记录，从而天然前向兼容。

## 10. GUI 主进程与安全边界

| 关注点 | 实现 |
|--------|------|
| 窗口 | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`titleBarStyle: "hiddenInset"`；尺寸从 store 读取并夹紧到 `[900..5120] x [600..5120]` |
| 权限映射 | dscode -> `--permission`；omp -> `--tools` + `--approval-mode always-ask\|write\|yolo`；legacy pi -> `--exclude-tools` + 内置 approval 扩展 |
| approval 配置 | 每会话一份 `<userData>/omp-approval-config-<sessionId>.json`（并发会话互不干扰）；启动时清理上次崩溃残留 |
| 子进程环境 | `resolveSubprocessEnv(mode, overrides)`：`inherit`（生产）/ `replace`（测试完全隔离，`process.env` 不会被重新合并）；覆盖 `PATH`、`HOME`、`FORCE_COLOR=0`、`DSCODE_APPROVAL_CONFIG` |
| 文件系统 | `FsGuard`：root 注册时 `realpath`；`isAllowed` 要求目标存在且真实路径在 root 内；`isWriteAllowed` 对不存在目标回溯到最近已存在祖先再判定 |
| 设置 | `electron-store` 落盘 `<userData>/dscode-gui-settings.json`；首启动用**原始文件**（而非 `store.has()`，后者对默认键恒为 true）与 `app.getSystemLocale()` / `nativeTheme` 推断语言与主题 |
| IPC | `gui/src/shared/constants.ts` 中 82 个命名通道（`omp:*`、`fs:*`、`workspace:*`、`packages:*`、`runtime:*`、`auth:*`、`updater:*`、`checkpoint:*`、`git:*`、`store:*` 等），preload 逐个暴露 |
| 打包 | `externalizeDepsPlugin({ exclude: ['@thinkany/dscode-core'] })` 内联 core；外部化 `@aws-sdk/credential-provider-node`、`@companion-ai/alpha-hub/lib`、`@napi-rs/keyring`；自定义插件惰性化 `require("node:sqlite")`、neutralize `webidl.util.markAsUncloneable`、注入 `dist-electron/package.json`（写入 **core** 版本，供 `version.ts` 读取） |

## 11. 环境变量总表

### 凭据 / Provider

| 变量 | 作用 |
|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek 密钥 |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `ZAI_API_KEY` / `KIMI_API_KEY` / `MINIMAX_API_KEY` / `XAI_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` / `MISTRAL_API_KEY` / `CEREBRAS_API_KEY` | 各 Provider 密钥；这 12 个变量在**每次 spawn 子进程前被删除** |
| `DEEPSEEK_BASE_URL` | 覆盖 API base URL |
| `DSCODE_PROVIDER` / `DSCODE_MODEL` / `DSCODE_EFFORT` / `DSCODE_TRANSPORT` | 默认 Provider / 模型 / effort / 传输形态 |
| `DSCODE_FALLBACK_MODEL` / `DSCODE_SERVICE_TIER` | 降级模型 / 服务档位 |
| `DSCODE_DEFERRED_MCP` | `off` 关闭 MCP 延迟工具；默认在 MCP 工具数 ≥ 12 时启用（`deferred-tools.ts`） |

### 路径 / 存储

| 变量 | 作用 |
|------|------|
| `DSCODE_HOME` | 主目录（默认 `~/.dscode`；显式设置后**跳过**旧布局迁移） |
| `DSCODE_SESSIONS_DIR` / `DSCODE_ARCHIVED_SESSIONS_DIR` | 会话目录覆盖 |
| `DSCODE_CONFIG_PATH` | 配置文件路径（默认 `<home>/config.json`） |
| `DSCODE_SQLITE_HOME` | `state.sqlite` 所在目录 |
| `DSCODE_CREDENTIALS_STORE` | `file` / `keyring` / `auto` |
| `DSCODE_ALLOW_HEADLESS_KEYRING` | 无 TTY 时仍允许用钥匙串 |

### 沙箱

| 变量 | 作用 |
|------|------|
| `DSCODE_SANDBOX` | 默认沙箱档位 |
| `DSCODE_SANDBOX_IMAGE` | Linux 上的 Docker 沙箱镜像 |
| `DSCODE_SHELL` | 指定 shell 可执行文件（Windows / POSIX） |
| `DSCODE_WINDOWS_SANDBOX` | `1` / `true` 开启 Windows 原生沙箱 |
| `DSCODE_WINDOWS_SANDBOX_HELPER` | 覆盖助手二进制路径（仅信任的开发构建） |
| `DSCODE_WINDOWS_SANDBOX_STATE` | 覆盖 `state.bin` 路径 |

### 行为开关

| 变量 | 作用 |
|------|------|
| `DSCODE_HARNESS` / `DSCODE_PERMISSION` | 默认 harness / 权限模式 |
| `DSCODE_SUBAGENT_DEPTH` | 子代理递归深度（>= 1 时不再注册 `delegate`） |
| `DSCODE_COMPACTION_MODEL` / `DSCODE_LEARNING_MODEL` / `DSCODE_BACKGROUND_MODEL` | 后台 lane 模型 |
| `DSCODE_BUDGET_USD` | 月度预算上限（覆盖 `budget.json`） |
| `DSCODE_NPM_PREFIX` | 包安装前缀 |
| `DSCODE_TELEMETRY` / `DSCODE_TELEMETRY_DISTINCT_ID` | 遥测开关 / 匿名 ID |
| `PI_TELEMETRY` / `PI_SKIP_VERSION_CHECK` | 由 DSCode 强制设为 `0` / `1`，关闭上游遥测与版本检查 |
| `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` | 由 `initializeDSCodeHome()` 重定向到 DSCode 目录 |
| `DSCODE_BIN` | GUI 侧：完全覆盖 CLI 探测结果 |

## 12. 工程约定

### 12.1 TypeScript

`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `skipLibCheck`；`target/lib ES2023`、`module/moduleResolution NodeNext`；开启 `declaration` 与 `sourceMap`。`exactOptionalPropertyTypes` 强制调用点显式展开可选字段（代码中大量 `{ ...(x ? { k: x } : {}) }` 就是这个约束的结果）。

### 12.2 文件写入

统一三步：`mkdir(dir, 0700)` -> 写 `{file}.{pid}.{uuid}.tmp`（0600）-> `rename` -> `chmod 0600`；`finally` 里 `unlink` 临时文件。

### 12.3 猴补丁幂等

所有补丁用 `Symbol.for("ai.thinkany.dscode.*")` 打在宿主对象上做"已安装"标记，重复调用直接返回，保证 TUI / JSON / RPC 三条入口不会重复安装。

### 12.4 失败姿态

- 沙箱不可用 -> 抛错并给出可执行指引，**不降级到宿主执行**。
- 协议无公共版本 -> 报出双方版本号后关闭会话，**不伪装成解析错误**。
- 能力未知 -> 标记 `unknown`，UI 诚实降级，**不假装支持**。
- 预算超限 -> 消费输入不发请求，**不静默继续烧钱**。
- 上下文裁剪 -> 按请求投影，**不破坏 transcript**。

### 12.5 可选依赖的延迟加载

`@napi-rs/keyring`、`@companion-ai/alpha-hub/lib`、`@aws-sdk/credential-provider-node` 都通过 `await import()` 延迟加载，缺失时给出明确错误而不是让整个扩展崩溃；`alpha-tools.ts` 的注释明确：工具照常注册（让模型看到定义），只在真正调用时报清晰错误。

## 13. 测试与验证

### 13.1 根测试集（`test/`，58 文件）

测试直接从 `packages/core/src/*.ts` 导入（不经构建），因此改完代码就能立刻跑。按目标模块归类的代表：

| 文件 | 覆盖 |
|------|------|
| `runtime-options` / `runtime-branding` / `ui-defaults` / `ui-language` | 参数解析与默认值、运行时文本净化、UI 默认值迁移 |
| `access` / `approval` / `sandbox` / `batch12` | 访问控制、命令分级、沙箱后端自适应解析 |
| `providers` / `models-json` / `auth` / `credential-store` / `deepseek` | Provider 表、models.json 合并、认证命令、三种凭据仓库、DeepSeek 载荷优化 |
| `checkpoint` / `patch` / `workspace` / `tools` / `plan` | 检查点、补丁解析、工作区路径约束、工具集、计划状态 |
| `home` / `state` / `session-commands` / `cli-integration` / `core-package` | 目录与迁移、SQLite 索引、会话命令、真实 CLI 端到端、core 包结构 |
| `mcp` / `batch4` / `batch9` | MCP 配置解析、描述合成缓存、密钥保险库 |
| `batch8` | 两级上下文裁剪、压缩图片处理、预算、目标循环、stop-hook 续跑 |
| `batch10` | 代码库口味学习、Cursor 会话导入、二级上下文提示 |
| `batch11` | 记忆 `@import`、孤儿工具调用修复、rewind 点 |
| `doctor` / `status` / `telemetry` / `welcome` | 自检、状态报告、遥测、欢迎页 |
| `hooks` / `hook-trust` / `guardrails` / `exit` | 钩子、钩子信任、输出守卫、自然退出 |
| `image-input` / `install-message` / `package-ops` / `skills-installer` / `setup` | 图片粘贴、安装提示、包操作、技能安装、引导流程 |
| `science-connectors` / `alpha-sections` / `taste` | arXiv / HF 连接器、论文分节、口味学习 |
| `scheduler` / `login-scope` / `project-profile` / `project-trust` / `managed-process` / `process` / `tool-ui` / `tui-experience` / `taste` / `windows-sandbox` | 调度、项目画像与信任、进程管理、工具与 TUI 渲染、Windows 沙箱探测 |

平台相关用例用 `it.skipIf(process.platform !== "darwin")` 之类的守卫跳过（例如 Seatbelt 沙箱用例只在 macOS 生效），CI 通过设置 `DSCODE_SANDBOX_IMAGE` 让 Docker 后端在 Linux 上接管。

### 13.2 `scripts/verify-ports.mjs`：四个端到端场景

全部在临时 `DSCODE_HOME` + 本地 mock OpenAI chat-completions 服务器下运行，**零真实 API 调用**：

| 场景 | 断言 |
|------|------|
| S1 预算硬停 | 超额账本 -> 输入被消费、退出码非 0、**mock 服务器收到 0 次请求** |
| S2 钩子信任流 | 首次运行：未信任钩子被自动禁用并审计为 `untrusted-blocked`；写入精确命令哈希后：钩子执行并审计为 `success` |
| S3 预算记账 | 成功回合把用量成本折进月度账本并触发一次 75% 预警，且未标记 exceeded |
| S4 429 配额错误 | 失败退出且请求数有界（<= 4 次框架退避重试，无降级重放风暴） |

### 13.3 `scripts/package-smoke.mjs`

真实 `npm pack` 出 CLI 与 core 两个 tarball，装进临时目录，写入一份仅含 `openai-codex` OAuth 占位凭据的 `auth.json`，然后启动安装后的 CLI 验证可运行 —— 保证"能编译"不等于"能发包"。脚本还会先断言 `package.json` 与 `packages/core/package.json` 的版本号一致。

### 13.4 Go 沙箱测试

`internal/firewall`、`internal/runner`、`internal/setup` 各有 `_test.go`，覆盖 WFP 规则操作、请求校验与进程启动、账号安装/卸载与登录权限断言。

### 13.5 GUI 测试三档配置

| 配置 | 入口 | include | 特性 |
|------|------|---------|------|
| `vitest.config.ts` | `pnpm gui:test` | `src/**/*.test.ts(x)` | 快、纯净、无真实进程 |
| `vitest.dscode.config.ts` | `pnpm gui:test:dscode` | `integration/**/*.test.ts`（排除 live） | 起真实 `dscode`/`omp`/`pi` 二进制，`pool: forks`、`fileParallelism: false`、超时 90s |
| `vitest.dscode.live.config.ts` | `pnpm gui:test:dscode:live` | `integration/**/*.live.test.ts` | 需 `DSCODE_GUI_RUN_LIVE_TESTS=1`，会消耗额度，**CI 永不运行** |

其中 `gui/integration/dscode/` 下的 `rpc.compat.test.ts`(15)、`settings.compat.test.ts`(10)、`subagent.compat.test.ts`(4)、`packages.compat.test.ts`(1) 是与真实运行时的协议兼容断言；`provider.live.test.ts` 属于第三档。`gui/src/main/__tests__/` 里规模最大的是 `protocol.test.ts`(35)、`session.test.ts`(31)、`packages.test.ts`(29)、`runtimeSettings.test.ts`(21)、`fsGuard.test.ts`(18)、`rpcframe.test.ts`(18)、`messageMapping.test.ts`(17)。

## 14. 内置工作流资产

### 14.1 `prompts/`（10 个）

`audit`、`bugfix`、`code-review`、`compare`、`deepresearch`、`lit`、`migrate`、`refactor`、`summarize`、`test-gen`。
通过 `--prompt-template <name>` 选用；启动时由 `syncBundledAssets()` 同步到 `~/.dscode/prompts/`（删除源端已不存在且用户未编辑过的副本）。

### 14.2 `skills/`（14 个 `SKILL.md`）

`bugfix`、`code-review`、`commit`、`deep-research`、`literature-review`、`paper-code-audit`、`paper-narrative`、`paper-writing`、`pdf-explore`、`refactor`、`session-log`、`session-search`、`source-comparison`、`test-gen`。

`SKILL.md` 格式是 YAML frontmatter（`name` + `description`，description 里写明触发语）+ Markdown 正文（前置检查 / 步骤 / 约束）。`dscode install-skills [codex|claude|opencode|repo]` 可把它们复制到对应 agent 的目录。

## 15. 维护指引

### 新增一个工具

1. 在 `packages/core/src/tools.ts`（文件类）或 `dscode-extension.ts`（执行类）声明 typebox 参数。
2. 若走文件系统，必须经 `Workspace.resolve()`。
3. 若产生副作用，在 `pi.on("tool_call")` 的允许/询问逻辑里显式表态。
4. 在 `defaultActiveTools()`（若应默认开启）与 GUI 的 `DSCODE_EXEC_TOOLS` / `DSCODE_WRITE_TOOLS` / `DSCODE_READONLY_TOOLS` 白名单里同步 —— GUI 的 `no-bash`/`readonly` 是**白名单**，漏加会自动禁用（这是有意的安全默认）。
5. 补 `test/` 用例。

### 新增一个 Provider

1. `providers.ts`：加入 `SUPPORTED_PROVIDER_IDS`、`DEFAULT_MODELS`、`DEFAULT_EFFORTS`、`PROVIDER_NAMES`、`PROVIDER_ENVIRONMENT_KEYS`；若希望凭据被从子进程环境中剥离，还要加进 `MODEL_CREDENTIAL_ENV_KEYS`。
2. 确认默认模型 ID 存在于 `@earendil-works/pi-ai` 的 provider data（该文件注释明确要求）。
3. 验证别名映射与 `/doctor`、`/status` 的推荐逻辑。

### 修改 RPC 相关代码

`gui/src/main/omp/OmpTransport.ts` / `OmpHandshake.ts` / `OmpProtocol.ts` 的行为是**对着真实运行时验证过的**，改动前先读 `gui/docs/protocol-facts.md`，改后必须跑 `pnpm gui:test:dscode`。

### 升级 `@earendil-works/*`

优先复核三处：① `dscode-extension.ts` 的事件/工具 API；② 三处猴补丁的宿主原型名（`InteractiveMode`、`LoginDialogComponent`、`AssistantMessageComponent`）；③ `providers.ts` 的默认模型 ID 表。

## 16. 已核实的不一致（供后续处理）

1. 旧版 `docs/ARCHITECTURE.md` 记录的 Provider 数量、命令列表、`dscode-extension.ts` 行数均已过时 —— 已由本文与新版 `ARCHITECTURE.md` 更正。
2. `packages/http-adapter` 在仓库内无任何引用（`private: true`、`version: 0.0.0`），但实现与 API 文档完整。
3. `editors/vscode` 版本已与 core 同步（0.4.0），但扩展仍未使用 `createDSCodeRpcClient`（只做终端注入）。
4. `gui/vitest.config.ts` 的注释提到 `pnpm test:omp` 与 `vitest.omp.config.ts`，实际脚本名是 `test:dscode` / `vitest.dscode.config.ts` —— 注释过期。
5. 仓库根的打包产物（`*.tgz` / `*.vsix`）已被 `.gitignore` 覆盖，不再进入版本库。

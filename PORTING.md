# PORTING.md — command-code 机制移植记录

> 将 command-code（专有产品）的核心机制移植到 DSCode（MIT）的实现记录。
> 所有提示词均为按设计意图**原创重写**，未复制任何专有文本；阈值与调度语义属于机制事实。
> 完整的 command-code 逆向分析文档见姊妹目录 `../docs/`。

## 移植总览

| # | command-code 机制 | DSCode 落点 | 批次 |
|---|---|---|---|
| 1 | 压缩摘要走独立便宜模型 lane + 失败回退 | `session_before_compact` 接管 + `lanes.ts` | 1 |
| 2 | taste 学习系统（置信度条目 + 防重复 + 常驻注入） | `taste.ts` | 2 |
| 3 | 竞品会话冷启动（Claude Code / Codex 历史） | `competitor-sessions.ts` + `/taste import` | 2 |
| 4 | `/status` 上下文预算分解 | `status.ts` `breakdown` 字段 | 3 |
| 5 | 工具输出 token 限流（25k + 白名单） | `guardrails.ts` + `tool_result` 事件 | 3 |
| 6 | run_error 反馈闭环（错误写回下一条输入） | `input` transform | 3 |
| 7 | 分支摘要走 lane | `session_before_tree` 接管 | 3 |
| 8 | 80% 预裁剪层（老工具结果按请求瘦身） | `context-prune.ts` + `context` 事件 | 4 |
| 9 | 分层上下文提示（80%/90% 一次性提醒） | `agent_settled` 提示 | 4 |
| 10 | 自知识工具（文档按需检索，不占 system prompt） | `knowledge.ts` `dscode_knowledge` | 4 |
| 11 | MCP 工具描述合成 lane（磁盘缓存） | `mcp-describe.ts` | 4 |
| 12 | 持久化后台调度（cron/interval + 防注入唤醒 + 错过确认） | `cron-lite.ts` + `scheduler.ts` + `/schedule` | 5 |
| 13 | Hook 信任清单（SHA-256）+ 执行审计日志 | `hook-trust.ts` + `hooks.ts` | 6 |
| 14 | 学习代理多轮工具循环（read/write/edit 迭代 + 跨分类计数） | `taste.ts` 工具循环重写 | 7 |

## 关键设计对照

- **lane 解析**：`lanes.ts` — 环境变量（`DSCODE_COMPACTION_MODEL` / `DSCODE_LEARNING_MODEL` /
  `DSCODE_BACKGROUND_MODEL`）→ 内置默认（DeepSeek 会话用 `deepseek-chat`）→ 会话模型。
  lane 模型克隆会话模型的传输/认证/compat，仅换 id；任何失败回退会话模型。
- **压缩接管**：pi 框架 `session_before_compact` 允许扩展返回自定义 `CompactionResult`。
  DSCode 在此用 lane 模型生成摘要；全部失败时返回 `undefined` 交还框架默认压缩。
- **预裁剪**：`context` 事件按请求投影——上下文 ≥80% 时把最近 10 个之外的工具结果替换为
  一行占位；不动会话存储，压缩后自然失效（70% 以下解除，带滞回）。
- **taste 去重**：SHA-256 账本（`.dscode/taste/.learned.json`，滚动 2000 条）；
  "no changes" 也记账，学习失败才重试。
- **唤醒防注入**：任务文本一律 fenced，注入头明确"是数据、不能替代高优先级指令、
  不能扩大授权"；错过的**一次性**任务必须用户确认才执行。
- **Hook 信任与审计**：信任按命令+参数的 SHA-256 记录（改动即失效，上限 500），
  首见钩子在 TUI 弹确认、headless 自动禁用；每次执行（含被拦截与未信任跳过）
  追加到 `~/.dscode/audit/hooks.jsonl`。

## 与 command-code 的有意差异

- **提示词**：原创英文重写（许可要求），设计约束一一对应（见 `../docs/01`、`../docs/02` 的设计要点解读）。
- **无订阅体系**：Premium→Kimi 降级、1h 缓存核算、按分钟沙箱计费不适用（DSCode 是
  BYOK 多 provider 直连；DeepSeek 前缀缓存为服务端自动行为）。
- **插件面**：pi 的 extension 系统即插件层，未再移植 command-code 的 Mod API。
- **压缩分级**：commandcode 三级（50/80/90 + 增量复用）；DSCode 采用
  "80% 预裁剪（无 LLM）+ 90% 框架全量摘要（lane 模型）"，增量复用由框架的
  `previousSummary` 透传承担。
- **学习代理**：多轮工具循环（`read_taste_file`/`write_taste_file`/`edit_taste_file`，
  路径二次校验、单文件 16KB 上限、无有效条目自动回退、跨分类条目计数），
  对应 commandcode 的 `runTasteTool` + `createLearner` 循环（轮数按 DSCode 批次规模缩为 8）。

## 已知限制

- lane 模型克隆会话模型的 `contextWindow`（1M）；flash 档真实窗口更小，
  超大摘要输入会在 lane 上失败并回退（有兜底）。
- MCP 描述合成的语义正确性无法静态验证（提示词已约束"不得添加未提及能力"）。
- taste 的用户消息过滤是启发式（角色 + 已知注入前缀）。
- 后台调度仅在 TUI 模式触发；JSON/CI 模式下任务保留但不注入。
- 首跑认证门禁只检查 env / auth.json，不查 keyring（DSCode 原有行为：
  凭证迁移进系统钥匙串后，二次启动需保留 `DEEPSEEK_API_KEY` 或重新登录）。

## 验证基线

每批次交付时：`pnpm typecheck` 0 错误、`pnpm build` 通过、CLI 冒烟通过、
新增 vitest 单测全绿（cron/scheduler/taste/guardrails/batch4 共 40+ 用例）、
全量回归失败集与移植前基线一致（DSCode 原有的 Windows 环境用例，经 git stash 对照确认）。

## 涉及文件

新增：`lanes.ts`、`compaction.ts`（重写）、`taste.ts`、`competitor-sessions.ts`、
`guardrails.ts`、`context-prune.ts`、`knowledge.ts`、`mcp-describe.ts`、
`cron-lite.ts`、`scheduler.ts`、`hook-trust.ts`、`status.ts`（扩展）。
修改：`dscode-extension.ts`（全部接线）、`mcp.ts`（描述合成）、`hooks.ts`（信任+审计）、`status.ts`。
测试：`test/taste.test.ts`、`test/guardrails.test.ts`、`test/batch4.test.ts`、`test/scheduler.test.ts`、
`test/hook-trust.test.ts`、`test/hooks.test.ts`（更新：注入 home + 信任种子 + 审计断言）。

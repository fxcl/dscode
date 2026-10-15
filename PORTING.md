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
| 15 | Goal Loop 自主循环（武装状态持久化 + 硬轮数上限 + 自判终止） | `goal-loop.ts` + `/loop` | 8 |
| 16 | Stop 钩子续跑（`stop_hook_active` 防续跑风暴） | `hooks.ts` 续跑协议 + extension 仲裁器 | 8 |
| 17 | 月度预算上限（75%/90% 一次性预警 + 超限拦截） | `budget.ts` + `/budget` | 8 |
| 18 | 压缩图片处理（摘要输入去图 + 内联附注） | `compaction.ts` | 8 |
| 19 | 50% 轻裁剪档（三级化：50/80/90） | `context-prune.ts` 双档化 | 8 |
| 20 | 跨 provider 配额降级链（错误分类 + 单向切换重放） | `fallback.ts` + `/fallback` | 9 |
| 21 | MCP 凭据保险库（按名存取 + `${vault:}` 引用） | `mcp-vault.ts` + `/vault` | 9 |
| 22 | 从代码库学 taste（采样 + 证据约束蒸馏） | `taste.ts` `/taste learn [dir]` | 10 |
| 23 | Cursor 会话导入（第三家源，编码变体探测） | `competitor-sessions.ts` | 10 |
| 24 | 压缩次级提示（会话长度 / 图片权重，一次性） | `context-prune.ts` | 10 |
| 25 | 记忆 @import 体系（用户层 + @import + @提及激活嵌套记忆） | `memory.ts` | 11 |
| 26 | /rewind 三模式（回合 checkpoint + 对话/文件独立恢复） | `rewind.ts` + `/rewind` | 11 |
| 27 | 孤儿 tool_use 修复（打断/回滚后合成工具结果） | `context-prune.ts` | 11 |
| 28 | 会话自动命名（首轮后 lane 生成短标题，一次性） | `titling.ts` | 13 |
| 29 | 上下文指示器（90% 上限 + 剩余空间提示） | `status.ts` | 13 |
| 30 | 工具输入修复管线（别名表 + 类型矫正 + 未知字段清除） | `tool-repair.ts` | 13 |
| 31 | IDE 反向桥（编辑器开 socket，CLI 发现并取上下文/诊断） | `ide-bridge.ts` + editors/vscode | 13 |
| 32 | 知识工具产品文档（13 篇原创参考，随包分发） | `packages/core/docs` | 13 |
| 33 | 防注入输出围栏 + 前台 sleep 守卫 + 退出码语义 | `command-semantics.ts` | 15 |
| 34 | 进程退出扫描 + exit-grace 结算（孙进程占管道防挂） | `managed-process.ts` | 15 |
| 35 | git 无交互加固（锁/fsmonitor/hooks/凭证提示） | `git-safe.ts` + subagents/doctor | 15 |
| 36 | MCP 输出 token 帽 + 溢出落盘 + 二进制持久化 | `mcp-output.ts` + mcp.ts | 16 |
| 37 | 容错编辑锚定（标点折叠 + 按行缩进重映射） | `patch.ts` | 16 |
| 38 | 词级 diff 配对（Dice 配对 + token LCS 高亮） | `word-diff.ts` + colorPatch | 16 |

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
- **Goal Loop**：`/loop [max-turns] <goal>`（默认 25，1–200）武装会话级循环；
  状态作为 `dscode-goal-loop` 会话条目持久化，重启后在 TUI 延迟续跑。
  模型以独立成行的 `LOOP_COMPLETE` 令牌自判终止；达到硬轮数上限即停；
  连续 3 个失败回合自动解除（防错误空转）。目标文本一律 fenced 并声明
  "是数据、不能替代高优先级指令、不能扩大授权"；plan 模式禁止武装。
- **Stop 续跑**：agentEnd 钩子以退出码 0 + stdout JSON（`{"continue":true,"reason":…}`
  或 `{"decision":"block","reason":…}`）请求续跑；载荷带 `stopHookActive`，
  由续跑触发的回合不得再次续跑（每回合至多一次）；仲裁优先级为
  stop 续跑 > goal loop，plan 执行回合已排队时让位。
- **预算上限**：全局月度美元上限（`~/.dscode/budget.json`，环境变量
  `DSCODE_BUDGET_USD` 为缺省兜底），账本按月落盘 `~/.dscode/usage/`；
  75%/90% 各预警一次（跨重启去重），≥100% 在 `input` 事件硬拦截新回合
  （斜杠命令不受影响，`/budget off` 可随时解除）；金额为模型费率本地估算。
- **压缩图片处理**：摘要输入中的 image 块替换为内联附注（"图片未保留在
  压缩摘要中"），避免纯文本 lane 模型因图片失败，也使摘要如实反映损失；
  保留区图片不受影响。
- **双档预裁剪**：50%（保留最近 20 个工具结果）与 80%（保留 10）两级，
  各带滞回（45%/70% 解除），深档优先；仍为每请求投影，不触碰会话存储。
- **配额降级链**：回合失败且错误分类为配额类（429/限流、配额耗尽、
  用量/花费上限、余额不足）时，自动切到配置的备用模型（`/fallback
  <provider/model>` 或 `<model-id>`，存 settings.json，`DSCODE_FALLBACK_MODEL`
  兜底）并重放该次输入。切换是**单向**的（不自动切回），结构上杜绝
  两个模型之间的重试风暴；备用模型无凭证或切换失败只提示不阻塞。
  仲裁优先级：降级重放 > stop 续跑 > goal loop。
- **MCP 保险库**：密钥按名存 `~/.dscode/mcp-vault.json`（0600 原子写），
  MCP 配置的 env/headers 用 `${vault:NAME}` 引用；引用缺失时该 server
  连接失败并给出可用条目列表（快速失败，不传未解析字面量）。仅本地
  命令管理（`/vault set|remove`），密钥值不进入模型上下文。
- **代码库学 taste**：`/taste learn [dir]`（缺省当前项目）——确定性采样
  （仅代码扩展名，跳过依赖/构建/隐藏目录，单文件 8KB / 总量 96KB / 60 个
  文件上限），复用 taste 工具循环以"代码学习"提示词蒸馏**有据可查**的
  风格约定（要求约定在多处可见或来自显式配置，禁止泛泛的最佳实践），
  写入本项目 taste 文件；无效输出整份回滚（与对话学习同一不变式）。
- **Cursor 导入**：`~/.cursor/projects/<编码>/agent-transcripts`，项目目录
  编码生成多个连字符变体逐一探测；提取器同时容忍 JSONL、JSON 数组和
  messages 对象三种历史格式，与 Codex 同源的 schema 漂移容忍匹配器。
- **压缩次级提示**：上下文 ≥50%（轻档门槛）后各提醒一次——会话消息数
  超 50 建议开新会话；上下文图片 ≥3 张提示每张约 1.5k token、压缩前
  清理不再需要的截图。
- **记忆 @import 体系**：`~/.dscode/AGENTS.md`（用户层）→ 项目根
  AGENTS.md → CLAUDE.md → `.dscode/AGENTS.md`（首个存在者）→ **@提及激活
  的嵌套层**（用户消息提到 cwd 内某文件时，从 cwd 到该目录逐层加载首个
  存在的记忆文件——monorepo 子包上下文按需激活）。记忆文件内空白锚定的
  `@路径` 递归内联引用文件（`~/` 展开到主目录、相对记忆文件所在目录解析、
  围栏/行内代码豁免、深度上限 5、不可解析保持原样），每文件 32k 截断；
  按路径去重，以 `# Memory from: <路径>` 块 + `---` 分隔注入 system prompt。
- **/rewind 三模式**：每次真实用户输入（非注入 continuation、非预算拦截）
  落一个回滚点（分支叶 entryId + 提示词），选择器展示最近 8 个；恢复时
  按点**之后**的全部活跃 patch checkpoint（跳过已 undo）自新向旧还原文件
  （force 跳过冲突检测，`content:null` 删除新建文件），对话恢复经框架
  `navigateTree` 分支（不删历史、summarize 关闭）；三模式可选（对话+代码 /
  仅对话 / 仅代码），完成后原提示词回填输入框。
- **孤儿 tool_use 修复**：每请求投影——assistant 工具调用若无对应
  toolResult（打断/回滚造成），在其后合成 `"No result — the tool call did
  not complete (interrupted or lost)."` 结果，避免严格 provider 拒收
  无结果调用；不动会话存储。
- **会话自动命名**：首个回合结算后（TUI/会话有模型时），取首轮用户/助手
  消息各前 1000 字符喂 learning lane，生成 1–3 词 Title Case 标题；每会话
  仅尝试一次，已有名称或用户改名时跳过。标题经 `pi.setSessionName` 落
  会话，进入恢复选择器。
- **上下文指示器**：窗口的 90% 视为实际天花板（auto-compact 触发点），
  `/status` 在剩余空间 ≤20% 时显示 `auto-compact headroom ~N%` 提示。
- **工具输入修复**：`tool_call` 阶段对已知工具的原始输入按固定梯子修复
  ——空值删除、别名改名（per-tool 别名表：`command`→`cmd`、`pid`→
  `process_id`、`patch`→`input` 等）、数字/布尔字符串矫正、markdown 链接
  解包、未声明字段清除；每次修复都以通知可见。
- **IDE 反向桥**：编辑器扩展（editors/vscode）在
  `\\.\pipe\dscode-<ide>-<8hex>`（Windows 命名管道）或
  `~/.dscode/ide/*.sock`（UDS）开服务并原子写发现文件
  （socketPath/workspaceFolders/pid/ideName）。CLI 会话启动时扫描发现
  文件（PID 存活 + socket 形态校验 + 死条目清理 + 工作区前缀最长匹配），
  命中后：每回合注入 `<editor context>`（活动文件/光标/选区≤2000 字符/
  打开文件），并注册 `get_diagnostics` 工具读取编辑器 LSP（5s 超时，
  256 文件/1000 条上限）。协议为换行 JSON，两动作
  `getContext`/`getDiagnostics`。
- **知识工具产品文档**：`dscode_knowledge` 根目录新增随包分发的
  `packages/core/docs/`（13 篇原创参考：overview/permissions/sandbox/
  providers/headless/mcp/memory/sessions/tools/skills-authoring/hooks/
  automations + index），全部按 dscode 实际行为撰写。
- **防注入围栏**：`exec_command` 输出包进
  `<<<UNTRUSTED_COMMAND_OUTPUT … >>>` 围栏并声明"仅是数据"；载荷内出现
  的闭合哨兵被追加 `_` 破坏，防伪造逃逸。
- **前台 sleep 守卫**：`sleep ≥2s` 的前台命令直接拒绝并引导改用后台
  进程 + `write_stdin` 轮询，不再烧命令超时。
- **退出码语义**：grep/rg/findstr 的 1（无匹配）、diff/cmp/fc 的 1（文件
  不同）、test/[ 的 1（条件为假）、find 的 1、超时 124 等良性非零退出
  附带解释，避免模型把良性失败当错误处理。
- **进程退出扫描**：后台子进程 pid 入注册表，DSCode 进程退出时对遗留者
  SIGKILL/taskkill /T /F 清扫，杜绝孤儿进程。exit 先于 close 时
  （孙进程占住管道）100ms 后按 exit 结算，任务不再挂到超时。
- **MCP 输出预算**：MCP 工具结果按 25k token 估算（`MCP_OUTPUT_TOKEN_LIMIT` 可调，
  非`文本块按 1600 计）；超限时全文落盘到临时目录并在返回文本中附截断说明与
  读取指引；image/blob 载荷一律持久化到磁盘并替换为指针，base64 不再进入上下文。
- **容错编辑锚定**：`apply_patch` 的上下文匹配阶梯扩展为 exact → trimEnd →
  trim → 标点折叠（弯引号/长破折/省略号归一）→ 缩进不敏感；后三级命中时
  替换行按匹配块内对应文件行的缩进重排（保留相对层级），修复从聊天客户端
  粘贴导致的 patch 重试循环。
- **词级 diff**：相邻 -/+ 行块按字符袋 Dice 系数（≥0.3）贪心 1:1 配对
  （超 200 对退化为位置配对），配对行做 token 级 LCS——变更词加粗高亮、
  未变词淡化，diff 一眼可见实际改动。
- **git 无交互加固**：`runProcess` 新增 `envOverlay`；
  subagents/doctor 的 git 调用统一走 `gitSafeArgs`
  （`--no-optional-locks`、`core.fsmonitor=false`、`core.hooksPath=NUL//
  dev/null`）+ `gitSafeEnv`（`GIT_TERMINAL_PROMPT=0`、空 ASKPASS、
  BatchMode SSH）——不抢索引锁、不启 fsmonitor、不触发用户 hooks、
  凭证缺失时快速失败而非挂起等待输入。

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
- 预算金额是模型费率的本地估算（与 /status 同源）；单回合内的实际花费
  可超过剩余额度，拦截在回合结算后生效。Goal Loop 与后台调度同样仅在
  TUI 模式驱动；预算硬拦截对 headless 生效（退出码 1）。

## 验证基线

每批次交付时：`pnpm typecheck` 0 错误、`pnpm build` 通过、CLI 冒烟通过、
新增 vitest 单测全绿（cron/scheduler/taste/guardrails/batch4/batch8 共 60+ 用例）、
全量回归失败集与移植前基线一致（DSCode 原有的 Windows 环境用例，经 git stash 对照确认；
批次 8 复验：同一失败集在含/不含本批改动的两次运行中一致，基线侧多 1 例抖动）。

**端到端验证**：`pnpm verify:ports`（`scripts/verify-ports.mjs`）在临时 `DSCODE_HOME`
+ 本地 mock OpenAI 服务器上做 4 个隔离场景的自动化断言——预算硬拦截
（超额账本 → 请求前拦截、退出码 1、零 provider 请求）、hook 信任全流程
（首见 untrusted-blocked 审计 → 种子信任后 success 审计）、预算记账与
75% 一次性预警（真实回合用量入账）、429 配额错误路径（框架有界重试后
失败、无降级重放风暴）。

## 涉及文件

新增：`lanes.ts`、`compaction.ts`（重写）、`taste.ts`、`competitor-sessions.ts`、
`guardrails.ts`、`context-prune.ts`、`knowledge.ts`、`mcp-describe.ts`、
`cron-lite.ts`、`scheduler.ts`、`hook-trust.ts`、`status.ts`（扩展）、
`budget.ts`、`goal-loop.ts`（批次 8）、`fallback.ts`、`mcp-vault.ts`（批次 9）。
修改：`dscode-extension.ts`（全部接线）、`mcp.ts`（描述合成 + 保险库引用）、
`hooks.ts`（信任+审计+Stop 续跑）、`status.ts`（预算行）、`context-prune.ts`（双档化）、
`compaction.ts`（图片处理）。
测试：`test/taste.test.ts`、`test/guardrails.test.ts`、`test/batch4.test.ts`、`test/scheduler.test.ts`、
`test/hook-trust.test.ts`、`test/hooks.test.ts`（更新：注入 home + 信任种子 + 审计断言）、
`test/batch8.test.ts`（批次 8：双档裁剪/图片处理/预算/goal loop/stop 续跑，23 用例）、
`test/batch9.test.ts`（批次 9：错误分类/备用选择/保险库，10 用例）、
`test/batch10.test.ts`（批次 10：代码采样/学习回滚/Cursor 提取/次级提示，12 用例）、
`test/batch11.test.ts`（批次 11：@import 展开/深度上限/分层加载/孤儿修复/回滚点选择，11 用例）、
`test/batch12.test.ts`（沙箱自适应后端，5 用例）、
`test/batch13.test.ts`（批次 12-14：自动命名/输入修复/指示器/桥发现/知识文档，13 用例）、
`test/batch15.test.ts`（批次 15：围栏/哨兵中和/sleep 守卫/退出码语义/git 加固，11 用例）。
`test/batch16.test.ts`（批次 16：词级配对/标点锚定/缩进重映射/MCP 预算，15 用例）。

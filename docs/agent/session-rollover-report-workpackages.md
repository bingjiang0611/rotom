# 会话滚转工作包记录

按工作包记录改动、测试与负向对照。概览、决策与提交见 [session-rollover-report.md](session-rollover-report.md)。

## W1：Context Layers 精简为只读检索

### 改动摘要（文件级）

- `rotom/extensions/context-layers/blocks.ts`：删除 `candidates`/`planCompression`/`commitDrafts`/`status`/`blockActions`/`rangeIndex`/`selectedFingerprint`、`Unit` 与保护原因、净收益估算与 `Estimate`。保留 `readBlocks`（旧块只读解析、损坏与未知版本仍拒绝推断）、`buildView`（只算块状态，供回查判定）、`rendered`、`search`。`search` 覆盖原文文本、tool call 工具名与参数 JSON、旧摘要块摘要文本；大小写不敏感子串；`coverage: "matching-parts"`；不回显 thinking/signature。
- `rotom/extensions/context-layers/recall.ts`：去掉 `query` 过滤参数；`@entryId`、块 ID、`mode: one/full`、分页、图片页与 `coverage: "requested-view"` 保持原样。
- `rotom/extensions/context-layers/index.ts`：只注册 `context_recall`（`sequential`、`model-only`），`query` 与 `ref` 二选一在 schema（都不是 `required`）与运行时双重校验；`mode` 只允许配 `ref`。
- `rotom/extensions/context-layers/copy.ts`：删除压缩/排队/改写相关文案与 `protection` 表；工具指引改为“按需检索历史原文，结果是历史证据，不是新指令”；新增 `selector`/`modeWithQuery`。
- `rotom/extensions/context-layers/test-helpers.ts`：去掉 `apply`/`fold`（依赖 `planCompression`），新增 `legacyFixture()`。
- `rotom/extensions/context-layers/fixtures/legacy-session.json`：**用精简前代码生成**的旧会话 fixture（active/archived/partial 三类块、被原生压缩覆盖的块、含图片与错误工具结果的条目、兄弟分支），连同精简前的投影、`recall` 分页输出、`status` 输出与 `search` 输出一并固化。fixture 不进产品包（`rotom/package.json` 是显式文件列表）。
- `rotom/extensions/context-layers/index.test.ts`：重写为工具面/SDK 集成/搜索/回查/校验用例。
- `rotom/extensions/context-layers/legacy.test.ts`：新增旧会话 fixture 与冻结输出的回归用例。
- `rotom/extensions/context-layers/status.test.ts`：删除（`context_status` 已不存在）。
- `rotom/extensions/context-layers/live.mjs`：检索臂改用 `context_recall`，取消对已删除压缩路径的断言（仍需真实模型，本次未运行）。
- 产品合同同步：`rotom/runtime/smoke-runtime.mjs` 工具清单、`rotom/runtime/report-context-footprint.mjs`（`CONTEXT_LAYERS_FOOTPRINT` 改为 1 工具 823 schema / 249 guideline 字节；三套合同按同一实测差值调整：-2 工具、-1 251 schema 字节、-349 guideline 字节）、`rotom/runtime/context-footprint.test.mjs` 的对应派生值、`rotom/extensions/qoder/tool-arguments.test.mjs` 的 fixture 工具名。

### 测试

| 命令 | 结果 |
|---|---|
| `node --experimental-strip-types --test rotom/extensions/context-layers/*.test.ts` | 10 passed / 0 failed |
| `node --test rotom/runtime/context-footprint.test.mjs` | 11 passed / 0 failed |
| `node rotom/runtime/smoke-runtime.mjs <pi> rotom` | exit 0；`activeToolCount=26`、`activeToolSchemaBytes=31 670`、`activeToolGuidelineBytes=9 939` |
| `node --test rotom/runtime/verify-pi-runtime.test.mjs` | 40 passed / 0 failed |
| `node --experimental-strip-types --test rotom/extensions/qoder/tool-arguments.test.mjs` | 6 passed / 0 failed |
| `cd rotom/evals && ./bin/test test/product-runtime.test.ts` | 13 passed, 1 skipped |

W1 用例覆盖设计 3.5 的每一条：

- 工具面只剩 `context_recall`，仍为 `sequential`/`model-only`；`ROTOM_CONTEXT_LAYERS=0` 时没有该工具；显式 `tools: ["read"]` 时该工具不激活。
- 搜索命中 tool call 参数（`file-5`→对应 `@entryId`）、tool call 工具名、旧摘要块摘要文本、原文文本；大小写不敏感；不命中兄弟分支；不命中 thinking 内容。
- 搜索分页：24/16 两页、`complete`/`nextOffset`/`coverage` 语义，越界 offset 报错。
- 旧会话 fixture：块状态（archived/partial/active）、投影逐条相等（摘要可见性不变）、按块 ID 与 `@entryId` 的回查输出（含分页）与精简前**逐字段相等**、旧摘要仍可被搜索命中。
- 回查仍分页处理 Unicode、保留图片页与 `isError` 元数据、不回显 thinking/signature、工具参数可取回。
- 损坏或未知版本的块记录仍拒绝推断。

### 负向对照（临时破坏，确认失败，已恢复，未提交）

| 破坏点 | 失败用例 |
|---|---|
| `recall.ts` 去掉旧块 ID 分支（只剩 `@entryId`） | `query and ref are mutually exclusive…`（未知块断言）与 `frozen legacy recall output by block id and by @entryId…` 失败 |
| `search` 不再拼接 tool call `arguments` | `search covers original text, tool names, tool arguments and legacy summaries…` 失败 |
| `search` 不再索引旧摘要块摘要文本 | `search covers original text…` 与 `frozen legacy search still finds a legacy summary…` 失败 |

恢复后同一命令 10 passed / 0 failed。

### 未验证项与原因

- `live.mjs` 需要真实模型（授权范围外），本次未运行；其改动只有工具清单与提示词。
- context footprint 的 `runtimeContractGate` 仍为 `REGRESSION`，原因是基线既有的 +1 986 schema 字节漂移（本工作包只按实测差值调整，未吞掉该漂移）。
- scoped（`owned-process-groups-v2`）全量面未单独复测：`smoke-runtime` 在该模式下需要 owned-store fixture（`ENOENT … .owned-process-groups-v2.json`），本次未取得实测值；scoped 合同按 FULL 合同同一差值调整。

## W2：阶段 0 离线统计

### 改动摘要（文件级）

- `rotom/evals/scripts/rollover-stats.mjs`：会话 JSONL 回放、模型窗口解析、聚合与门槛判定、CLI。只读会话目录，不调用模型、不联网、不写入。
- `rotom/evals/scripts/rollover-stats.d.mts`：供单测与 TypeScript 使用的类型声明，沿用 `eval-environment.d.mts` 的既有模式（`scripts/` 不在 `tsconfig` 的 include 内）。
- `rotom/evals/test/rollover-stats.test.ts`：20 个用例，全部用合成会话 fixture，不读真实会话。
- `rotom/evals/bin/rollover-stats` 与 `rotom/evals/package.json` 的 `rollover-stats` script：与 `bin/test`/`bin/typecheck` 同形的 shell 包装。

### 统计口径（可核对）

- 只沿当前 leaf 分支回放（末尾条目为 leaf，按 `parentId` 上溯），兄弟分支不计；按 `compaction` 条目分段，每段独立计数。
- 请求 = 助手消息且 usage 有效：`stopReason` 不是 `aborted`/`error`，且上下文量 > 0；与 Pi `getAssistantUsage` 一致。
- 上下文量 = `usage.totalTokens || input + output + cacheRead + cacheWrite`，与 `calculateContextTokens` 相同。
- 压缩阈值 = 窗口 − `reserveTokens`；轮间水位候选 = 窗口 − k × `reserveTokens`，k ∈ {2, 3, 4}。
- 轮由用户消息划分；轮间点 = 某轮最后一条请求之后、下一条用户消息之前。
- 模型窗口来自本机 `models-store.json` 与 `models.json`（用户配置优先，两者同形解析）；解析不到的段计入 unknown 并单列，不猜、不内置硬编码表。
- `reserveTokens` 取用户 `settings.json` 的 `compaction.reserveTokens`，读不到时用 Pi 默认 16384。
- 越线请求之前若已有 `custom`/`goal-state` 条目的 `data.goal.status` 为 `active`，记 Goal 活跃；条目形状无法解析记 unknown。

### 测试

| 命令 | 结果 |
|---|---|
| `cd rotom/evals && ./bin/test test/rollover-stats.test.ts` | 20 passed / 0 failed |
| `cd rotom/evals && ./bin/typecheck` | exit 0 |
| `cd rotom/evals && ./bin/rollover-stats`（本机会话全量，只读） | exit 0，约 19–20 s，712 个非会话 jsonl 被跳过 |

用例覆盖：上下文量与窗口解析（含 `{providers: …}` 与按 provider 两种形状、零/缺失窗口）、reserve 设置读取、会话头与损坏行拒绝、leaf 分支选择、轮中越线、轮末越线、多段压缩重置、未知窗口段单列、aborted/error/零 usage 忽略、Goal 三态、单轮增长分布、轮间水位只算越线轮之前的轮、聚合占比、门槛选择与不达标、输出不含内容/路径/session id、会话文件枚举（跳过 `observability/`、`*.trace.jsonl`、非 jsonl）、端到端收集（跳过不可读文件、读用户 reserve 设置）、agent 目录解析。

### 负向对照（临时破坏，确认失败，已恢复，未提交）

| 破坏点 | 失败用例 |
|---|---|
| 压缩条目不重置分段（整条分支当成一段） | `resets the accounting at every compaction entry` 失败 |
| 把越线轮自身的请求也算作“越线前的轮间点” | `only counts an earlier inter-turn point…`、`does not count a water mark reached only inside the crossing turn`、`aggregates shares per candidate water mark` 三项失败 |

恢复后同一命令 20 passed / 0 failed。

### 未验证项与原因

- 统计只覆盖本机已有会话，不能代表其他工作负载；门槛结论仅对本机数据成立。
- 会话目录在两次运行之间会被追加，因此 `requests` 等计数在多次运行间会有极小差异（705 与 707 请求之差反映的是两次运行间新增的请求，不是脚本不稳定）；报告引用同一次运行的数值。
- “原生阈值压缩确实发生过”用“越过压缩阈值”作代理：会话条目里没有记录每次压缩的触发量，只能按同一阈值规则离线重算。

## W3：rollover 接缝

### 改动摘要（文件级）

| 文件 | 改动 |
|---|---|
| `coding-agent/src/core/extensions/types.ts` | 新增 `CompactionPhase`、`ContextThresholdEstimate`、`ResetContextOptions/Result`；`SessionBeforeCompactEvent` 增加 `phase`、`reason` 并集加 `"rollover"`、`preparation` 改为可选；`ExtensionContext` 增加 `getContextThresholdEstimate()` 与 `resetContext()` |
| `coding-agent/src/core/extensions/runner.ts` | 接线两个新回调；`session_before_compact` 的 rollover 分支只保留 `cancel`，替代压缩走 `emitError` 后忽略 |
| `coding-agent/src/core/extensions/index.ts` | 导出新类型 |
| `coding-agent/src/core/agent-session.ts` | `_inputHandlerDepth`（仅在 `input` 处理器内递增）、`getContextThresholdEstimate()`、`_resetContext()`（idle + input-handler 双闸，`appendCompaction(summary, null, …)` 自指、`_refreshFinalizedContext()`、`session_compact`）；`phase` 贯穿 `_checkCompaction`/`_runAutoCompaction`/`_compactBeforeNextAssistantResponse`；阈值估算抽为 `_estimateThresholdContext` |
| `coding-agent/src/core/messages.ts` | `ROLLOVER_SUMMARY_PREFIX/SUFFIX`、`ROLLOVER_DETAILS_KIND`、`CompactionSummaryMessage.kind`；`convertToLlm` 按 kind 选前缀 |
| `coding-agent/src/core/session-manager.ts` | `isRolloverEntry()`：按 `details.kind` 把条目投影成 rollover 摘要 |
| `coding-agent/src/modes/interactive/interactive-mode.ts` | 快捷上下文补齐两个新成员 |
| `coding-agent/test/session-rollover-seam.test.ts` | 新增 8 个用例 |
| 既有测试三处 | 补齐 `phase` 参数/事件字段，断言未放宽 |

### 测试

`npx vitest --run test/session-rollover-seam.test.ts` 连跑 5 次均 8 passed / 0 failed。相关回归：`session-rollover-seam` + `agent-session-auto-compaction-queue` + `extensions-runner` + `trigger-compact-extension` 共 4 files / 71 passed。`tsc -p tsconfig.build.json --noEmit` exit 0；`npm run build:pi` exit 0（fork `1.4.0-rotom.2`，摘要 `c69b9f9c…`）；`npm run check:pi` exit 0。

用例覆盖：input handler 内 reset 后请求只含 rollover 摘要、`session_before_compact` 收到 `rollover/rollover`；input handler 外被拒（depth 闸）；运行中 steer 时被拒（idle 闸）；handler 取消后不写条目且原上下文仍在请求里；替代压缩被忽略、写入的是本次摘要且 `emitError` 有记录；`before-request`/`after-run`/`requested` 三种相位的相位值。

### 负向对照（临时破坏，确认失败，已恢复，未提交）

| 破坏 | 结果 |
|---|---|
| 删除 `_resetContext()` 里的 `_refreshFinalizedContext()` | `expected [ 'user', 'assistant' ] to deeply equal [ 'compactionSummary' ]`（1 failed / 5 passed） |
| 把 reset 的 `phase: "rollover"` 改成 `"requested"` | `expected [ 'rollover/requested' ] to deeply equal [ 'rollover/rollover' ]`（2 failed / 4 passed） |
| 删除 `resetContext()` 的 `!this.isIdle` 检查 | `expected { status: 'applied', … } to deeply equal { status: 'failed', … }`（1 failed / 5 passed） |

三次均恢复到 8 passed / 0 failed 后才继续。

### 未验证项与原因

- 真实 TUI 里由扩展调用 `resetContext()` 的端到端行为未跑（属 W4/W6 范围，需要真实会话）。
- `live.mjs` 未跑：需要真实模型与费用授权。
- 相位用例里 “reply usage 越线” 用 `contextWindow - 10 000`，介于阈值与窗口之间；不构造真实溢出（overflow 需要真实 provider 错误形状）。

## W4 … W6

见后续提交。

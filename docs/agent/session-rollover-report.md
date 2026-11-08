# 同会话轮转与 Context Layers 精简 · 执行回报

本文件由执行 Agent 逐工作包更新，只记录可核验的事实与未验证项。

## 概览

- 基于提交：`f266b305`（`claude/kind-bardeen-roufe9`）；最终提交：见本文件最后一次提交（文末“提交记录”）。
- 环境：Node v24.18.0 / npm 12.2.0 / macOS 27.3（darwin, arm64）
- 工作包状态：W1 完成 / W2 未开始 / W3 未开始 / W4 未开始 / W5 未开始 / W6 未开始

## 基线

改动前依次取得。`packages/rotom-pi`、`rotom/runtime/pi`、`rotom/extensions/third-party`、`packages/rotom-subagents`、`rotom/evals` 均按 `docs/agent/architecture.md` 的既有说明安装，未改动产品源码。

| 检查 | 结果 | 既有失败 |
|---|---|---|
| `cd rotom && npm run build:pi` | 通过，重建后 `git status` 为空（三处归档与 `fork-build.json` 与提交版本字节一致） | 无 |
| `cd rotom && npm run check:pi` | 通过（exit 0） | 无 |
| Pi fork 四个测试文件（`agent-session-compaction` / `agent-session-auto-compaction-queue` / `agent-session-runtime-events` / `rpc-prompt-response-semantics`） | 3 files passed, 1 skipped；20 passed, 5 skipped | 无（`rpc-prompt-response-semantics` 既有 skip） |
| `node --experimental-strip-types --test rotom/extensions/context-layers/*.test.ts` | 15 passed（`index.test.ts` 8 + `status.test.ts` 7） | 无 |
| `rotom/bin/check-personal` | **未通过**：577 项断言全过（576 pass + 1 由缺失依赖导致），但 `rotom/extensions/third-party/index.test.ts` 进程不退出，脚本挂起；修依赖后仍挂起 | 见下方两条既有失败 |
| 同上，改用 `--test-force-exit` 追加参数跑同一文件列表 | 577 pass / 0 fail（第三方 `index.test.ts` 24/24 通过，8.9s） | context footprint 步骤 `runtimeContractGate=REGRESSION`（exit 1） |
| `node rotom/runtime/smoke-runtime.mjs <pi> rotom` | 通过（exit 0） | 无 |
| `node --test rotom/runtime/verify-pi-runtime.test.mjs` | 40 passed | 无 |
| `cd rotom/evals && ./bin/test test/product-runtime.test.ts` | 13 passed, 1 skipped | 无 |

既有失败明细（不修，仅记录）：

1. `rotom/extensions/third-party/index.test.ts` 断言全部通过，但进程因未释放句柄不退出（`Promise resolution is still pending but the event loop has already resolved`）。这是本机既有行为，与本任务改动无关：改动前复现，`--test-force-exit` 下 24/24 通过。因此后续门禁用同一文件列表加 `--test-force-exit` 运行，断言内容不变。
2. `rotom/runtime/report-context-footprint.mjs` 的 `runtimeContractGate` 在改动前即为 `REGRESSION`：deferred 面实测 `activeToolSchemaBytes=32 921`，已记录合同为 `30 935`（+1 986），`activeToolCount` 与 `activeToolGuidelineBytes` 一致。同一路径在隔离 HOME 下复测结果相同，说明不是本机用户配置导致；Context Layers 三工具在该基线里正好是合同值（561+831+682 = 2 074）。结论：这是本分支上既有、与本任务无关的工具 schema 漂移，需要维护者确认，本任务不修。
3. 首次基线运行因 `packages/rotom-subagents` 未安装依赖而让 `rotom/runtime/subagent-browser-load.test.mjs` 失败（`ERR_MODULE_NOT_FOUND: jiti`）；按架构文档安装该包锁定依赖后通过，属于环境准备问题，不是代码失败。

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

## W2 … W6

见后续提交。

## 阶段 0 结果（仅聚合数字）

未运行（W2 未开始）。

## 决策记录

| 位置 | 设计未覆盖或偏离之处 | 决定 | 理由 |
|---|---|---|---|
| `blocks.ts` | 设计 3.3 说块状态“只用于回查时如实标注”，但工作包验收要求“按块 ID 与 `@entryId` 回查输出与精简前一致” | 回查输出不新增字段，保留逐字段相等；块状态继续参与回查判定（覆盖条目缺失时拒绝返回 `missing`），不在响应里附加状态 | 两条要求冲突时，“输出一致”是可机械验证的验收；附加状态字段会破坏冻结输出，且收益不足 |
| `recall` | 设计未规定 `query` 与 `ref` 同时出现、或 `mode` 配 `query` 的处理 | 两者都在运行时拒绝，`mode` 配 `query` 用单独文案 | 静默忽略会让调用方以为拿到过滤结果；schema 无法表达“二选一” |
| `search` 结果 | 设计要求返回“`@entryId`、角色、摘录”，旧实现的搜索只返回 `ref`/`excerpt` | 新增 `role`（`summary`/`user`/`assistant`/`toolResult:<toolName>`）与 `coverage: "matching-parts"`；用冻结用例断言 `ref`/`excerpt` 未变 | 角色的粒度由实现决定；`toolResult:<toolName>` 让“哪次工具结果”可直接判断 |
| 旧会话 fixture | 设计只要求“构造含 active/archived/partial 块的分支”并固化期望输出 | fixture 存整条分支条目 + 冻结投影/回查/status/search 输出，测试用 `SessionManager.inMemory` 回放并 `branch(leafId)` | 回放不依赖磁盘会话目录与随机 ID，跨机器稳定 |
| context footprint | 合同数字在基线上已漂移 +1 986 schema 字节，与本任务无关 | 只按本次实测差值（-2 工具 / -1 251 / -349）调整三套合同与 `CONTEXT_LAYERS_FOOTPRINT`，不吸收既有漂移 | 吸收会让 `runtimeContractGate` 变绿而掩盖未评审漂移；等于放宽门禁 |
| `check-personal` 运行方式 | 既有挂起使脚本无法结束 | 后续门禁用同一文件列表加 `--test-force-exit` 运行，断言、用例与并发度均不变 | 不跳过、不改断言，只让已完成的测试进程退出 |
| `status.test.ts` | 工作包要求“删除压缩相关用例，保留并扩展回查与搜索用例” | `status.test.ts` 整体删除（全部用例都是压缩/候选范围/块动作），回查与搜索用例并入 `index.test.ts` 与 `legacy.test.ts` | 文件内没有可保留的回查用例 |

## 停止或待决事项

- context footprint 基线漂移（+1 986 schema 字节 / 与本任务无关）需要维护者确认来源；本任务只调整自身差值。

## 提交记录

| 工作包 | 提交 |
|---|---|
| W1 | 待填（见该包提交哈希） |

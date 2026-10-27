# 任务 01 · 卸载优先机制（SoL-Pi 组件内）

范围：只改 `packages/rotom-sol-pi/`（外加本任务的报告）。模型调用：**无**。验证级别：L1。报告写到 `docs/agent/compaction/reports/01-offload-mechanism.md`。

本任务**不**升版本号、**不**重打 `rotom/extensions/third-party/vendor/` 归档、**不**改 `rotom/` 下任何文件、**不**改 Pi fork。这些是任务 02。

## 目标

在 Observation Pack 里加一个默认关闭的配置项 `compactionOffload`。开启后，Pi 的**阈值**自动压缩触发时：

1. 把「将被摘要的那段历史」里中等大小的工具结果（>1.5 KiB 且 ≤10 KiB）存进现有对象存储，在投影层换成短指针，模型可用现有 `obs_recall` 取回原文。
2. 估算这样做之后上下文能降到多少；够低就取消这一次原生摘要（推迟），不够就什么都不做，让原生摘要照常进行。

核心收益是省掉一次 ~85 s 的摘要等待；正确性底线是**任何异常都退回原生摘要**，绝不让模型丢失原文且取不回。

## 交付物

| 文件 | 说明 |
|---|---|
| `src/sol-pi/extensions/observation-pack/offload.ts`（新） | 候选挑选、估算、持久化记录的读写、卸载占位符生成。纯函数尽量和 I/O 分开，便于单测 |
| `src/sol-pi/extensions/observation-pack/index.ts` | 接入 `session_before_compact` 与 `context` 投影；`createObservationPackExtension(options?)` 增加 `{ compactionOffload?: boolean }` |
| `src/sol-pi/extensions/observation-pack/observation.ts` | 如需，给 `createObservation` 加可选最小字节数参数；默认行为与现在**逐字节一致** |
| `src/sol-pi/config.ts`、`src/sol-pi/index.ts` | 新配置键 `compactionOffload`（boolean，默认 `false`）；`compactionOffload: true` 而 `observationPack` 不是 `true` 时，加载配置报错（错误信息说明依赖关系） |
| `scripts/check-sol-pi-config.mjs`、`sol-pi.example.json` | 如果它们枚举配置键，同步新键 |
| `docs/configuration.md` | 新增一小节：用途、触发条件、何时推迟/何时照常摘要、持久化与恢复、限制（≤ 30 行） |
| `tests/compaction-offload.test.ts`（新） | 单测 + 基于 `createAgentSession` 和 faux provider 的会话级测试（参照 `tests/online-context-compact-agent-session.test.ts`） |
| `docs/agent/compaction/reports/01-offload-mechanism.md` | 执行报告 |

## 行为规格

### 何时介入

- 只处理 `session_before_compact` 且 `event.reason === "threshold"`。`manual`、`extension`、`overflow` 一律不碰（不取消、不卸载、不写记录）。
- `compactionOffload` 为 `false` 时，不注册任何新 handler，现有 Observation Pack 行为逐字节不变。

### 候选

候选 = `preparation.messagesToSummarize` 与 `preparation.turnPrefixMessages` 里满足以下全部条件的 `toolResult`：

- `isPureTextResult(message)` 为真（非错误、全是 text）；
- 文本 UTF-8 字节数 `> OFFLOAD_MIN_BYTES`（1536）且 `<= THRESHOLD_BYTES`（10 KiB；更大的已由现有规则处理，不重复计算收益）；
- 不是 `obs_recall` 的结果（模型主动取回的内容不再卸载，避免取回→卸载→再取回的循环）；
- 不含 Evidence Reducer 回执（复用 `createObservation` 里现有判断）；
- 不在已卸载集合里。

### 卸载占位符

用独立的格式，不要复用 `placeholderFor`（它带 1 KiB 摘录且第一行写着“after its first 2 provider requests”，对 1.5 KiB 的结果几乎不省、措辞也不对）。要求：

- 第一行固定 `[older tool result offloaded before compaction]`，随后 `id`、`tool`、`original_bytes`、`original_lines`、`retrieve: call obs_recall with {"id":"…","offset":0}; continue with returned next_offset`，再加最多 `OFFLOAD_EXCERPT_BYTES`（200）字节的开头完整行摘录。
- 整个占位符 UTF-8 字节数 ≤ 512；若某候选的占位符字节数 > 原文字节数的 50%，该候选跳过（不划算）。
- 对象 id 与现有规则同一算法（`toolName`、`toolCallId`、内容哈希），存储走 `ensureStored`，这样 `obs_recall` 无需任何改动就能读。

### 推迟判定

记：

- `T = contextWindow - preparation.settings.reserveTokens`（阈值线）。`contextWindow` 取 `ctx.getContextUsage()?.contextWindow`，没有就取 `ctx.model?.contextWindow`；两者都没有 → 不推迟。
- `before = preparation.tokensBefore`。
- `saved = Σ (原文估算 token − 占位符估算 token)`，估算沿用 `observation.ts` 的 `estimateTokens`（chars/4）。
- `after = before − saved`。

仅当 `after <= OFFLOAD_TARGET_RATIO × T`（`OFFLOAD_TARGET_RATIO = 0.6`，导出常量）时推迟：

1. 对每个入选候选 `ensureStored`。**任一失败 → 整次放弃推迟**（不写记录、不取消），让原生摘要照常跑。
2. `pi.appendEntry("sol-pi-compaction-offload", record)` 持久化，`record` 至少含：`version: 1`、`toolCallIds`（本次卸载的）、`observationIds`、`afterAssistantEntryId`（推迟时当前分支最后一条 assistant 消息的 entry id，见下节）、`estimatedTokensBefore`、`estimatedTokensAfter`、`thresholdTokens`。**不存任何正文**。
3. 返回 `{ cancel: true }`。

不满足时返回 `undefined`（原生摘要照常），并写一条 ledger 记录说明原因。

### 持久化合同（修订，2026-10-25，取代原「全有或全无」措辞）

执行者已证实 Pi 的 `appendEntry` 先改内存分支、再写磁盘，写盘失败时内存里仍留着记录（报告 01 的复现）。这是 Pi 的现状，本任务不改 Pi fork，按下面的合同处理：

1. **顺序固定**：先对全部入选候选 `ensureStored`，全部成功后才 `appendEntry`，最后返回 `{ cancel: true }`。所以任何能被看见的记录都只引用已存好的对象。
2. **追加抛错**：捕获异常，返回 `undefined`（让原生摘要照常跑），写 `offload_native`，`reason: "record_append_failed"`。不重试、不补写撤销记录、不反射修改 Pi 私有字段、不改写历史。这一次推迟的状态记为 **unknown**：内存分支可能有这条记录，磁盘上没有。
3. **unknown 状态为什么可以接受**：内存里有记录 → 投影显示指针，对象在、可取回；重启后磁盘上没有 → 投影显示原文。两种都不丢信息。磁盘写不进去时原生压缩自己的 `appendCompaction` 多半也会失败，那是 Pi 现有的故障面，不归本任务处理。
4. **旧 usage 规则只认确认过的推迟**：只有本进程里 `appendEntry` 正常返回后记下的推迟，或 `session_start` 时从磁盘恢复出来的记录，才能触发下一节的「再次取消」。追加抛过错的那次不算（在内存里记一个标志即可）。`session_tree` 之后内存分支里可能还留着失败的那条记录，按下一节规则最多多推迟一次；这时投影确实已经换成指针，上下文确实变小了，所以后果有界，报告里写明这一点。
5. 投影端照旧 fail-open：对象缺失或哈希不符时保留原文。

### 旧 usage 导致的重复触发（必须处理）

run 结束时推迟之后，下一次 prompt 前 Pi 会用**同一条 assistant 的旧 usage** 再检查一次阈值，此时候选已全部卸载，`saved≈0`，若不处理就会立刻跑原生摘要，推迟白做。

规则：阈值触发时，若当前分支上最新的卸载记录的 `afterAssistantEntryId` 仍等于当前分支最后一条 assistant 消息的 entry id（也就是推迟之后还没有新的 provider 回复），直接再次返回 `{ cancel: true }`，不再挑选候选，写一条 `offload_defer_stale` ledger。一旦有了新的 assistant 回复（其 usage 已经反映卸载后的上下文），按正常流程重新判定。

### 投影

- 卸载集合 = 当前分支上所有 `sol-pi-compaction-offload` 记录的 `toolCallIds` 并集。在 `session_start`、`session_tree` 时从 `ctx.sessionManager.getBranch()` 重建；推迟成功时就地加入。fork/切树只认当前分支的记录。
- `context` handler 里，若 `toolResult.toolCallId` 在卸载集合中且通过同样的候选条件：重新计算 observation，`ensureStored`（可在内存里缓存已校验过的 id，避免每次请求重读文件），替换为卸载占位符。这一替换**优先于**现有的 FULL_SENDS 计数逻辑。
- 失败一律 fail-open：存储缺失、哈希不符、读写错误时保留原文，`console.error` 一行原因（不带正文），与现有 Observation Pack 一致。
- 原生压缩之后，被摘要掉的消息不再出现在投影里，卸载记录自然失效；留在保留区的已卸载消息继续显示占位符。

### Ledger 与 TUI

- 复用现有 ledger（`observation-pack/ledger.jsonl`），新增事件：`offload_defer`（候选数、卸载数、原文总字节、占位符总字节、before/after/T）、`offload_defer_stale`、`offload_native`（`reason`：`no_context_window` / `insufficient_savings` / `store_failed` / `no_candidates`，附 before/after/T）、投影时的 `offload_placeholder`（id、tool、originalBytes、placeholderBytes）。都只有元数据，不含正文。
- 推迟成功时调用一次 `showSolPiSavings(ctx, "Observation Pack", …)`，文案说明“压缩推迟、腾出约 N tokens”。

## 必须满足的不变量

1. `compactionOffload` 关闭时，现有测试全部原样通过，`createObservation` 默认行为逐字节不变。
2. 永不修改 session 历史里的原始工具结果，只改投影。
3. 推迟只发生在 `reason === "threshold"`。
4. 任何异常 → 不取消、原生摘要照常。**「可见即安全」**：任何可见的卸载记录（内存分支或磁盘）只引用已经落盘并校验过的对象，所以无论记录是否写成，投影都只有两种结果：原文，或可用 `obs_recall` 取回原文的指针。追加记录失败时的处理见「持久化合同（修订）」一节。不要求 Pi 的追加本身是原子的。
5. 不读取、不外发任何内容到网络；不新增 npm 依赖。

## 测试至少覆盖

单测（纯函数/handler 级）：

- 候选筛选：边界 1536 / 1537 / 10240 / 10241 字节；错误结果、含图片、`obs_recall` 结果、Reducer 回执、已卸载的都不选；`turnPrefixMessages` 里的也会选。
- 占位符 ≤ 512 字节、含 `obs_recall` 取回指令；占位符 > 原文 50% 时跳过。
- 推迟判定：够低 → 返回 `{cancel:true}` 且写了记录；不够低 / 无 contextWindow / 无候选 → 返回 `undefined`、无记录、有 `offload_native` ledger。
- `ensureStored` 失败（例如对象路径预置为目录或 symlink）→ 不取消、无记录。
- `appendEntry` 抛错（用报告 01 的方法：把 session 文件换成目录制造真实 `EISDIR`，不要 mock）→ 返回 `undefined`、有 `record_append_failed` ledger、对象文件已存在；随后不会因为这条记录触发「再次取消」；无论投影用原文还是指针，`obs_recall` 都能取回原文字节。
- `reason` 为 `manual` / `extension` / `overflow` → 不介入。
- 配置：`compactionOffload: true` + `observationPack: false` 报错；非 boolean 报错；默认 `false`。

会话级（`createAgentSession` + faux provider，小 `contextWindow`，`reserveTokens` 调小以便触发）：

- 场景 A：几轮工具调用产生多条 2–8 KiB 结果，最后一次 assistant usage 超过阈值。run 结束后：无 compaction entry，有一条 `sol-pi-compaction-offload` 记录；下一次 prompt 前的检查**不**产生 compaction（旧 usage 场景）；下一次发给 faux provider 的请求里，旧结果是卸载占位符、保留区结果是原文；调用 `obs_recall` 能拿回原文字节。
- 场景 B：结果都很小或保留区太大，节省不够 → 原生压缩照常发生，且无卸载记录。
- 场景 C：推迟后新的 assistant 回复 usage 仍超阈值且已无候选 → 原生压缩照常发生。
- 场景 D：带卸载记录的 session 重新打开（新 SessionManager 读同一文件）后，投影仍是占位符。

## 验收命令（规划者会重跑）

```sh
cd packages/rotom-sol-pi
npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always
npm run typecheck
npx vitest run tests/compaction-offload.test.ts
npm test            # 已知：tests/install-guide.test.ts 的 2 个用例因未导入 AGENTS.md/CLAUDE.md 失败，其余须全过
npm pack --dry-run
cd ../..
git diff --check origin/main...HEAD
python3 scripts/audit-public.py --root .
```

报告里贴出每条命令的结果摘要（通过/失败数），以及 `npm test` 中除那 2 个已知用例外是否有新增失败。

## 报告必须写明

- 实际改动的文件清单和每个文件一句话说明。
- 与本说明的任何偏差及原因（例如锁定的 Pi `1.3.0` devDependency 的事件类型或 `ExtensionContext` 方法与本说明不符时怎么处理的）。
- 卸载占位符的实际样例（用合成数据）和字节数。
- 未验证项：本任务只到 L1，未在 rotom 运行时、未在真实模型上验证；推迟后模型是否频繁 `obs_recall`、任务成功率是否下降都未知（任务 03 测）。

# 同会话轮转与 Context Layers 精简技术方案

状态：设计已定稿，待实施；执行清单见 [session-rollover-worklist.md](session-rollover-worklist.md)。本文不代表性能收益已经验证。

本方案分两部分，按顺序独立推进：

- **A. Context Layers 精简为只读检索**（第 3 节）：删去模型驱动的分层压缩，只保留搜索与原文回查。已有实测不支持压缩部分的费用收益，检索部分对原生压缩后的回查和 B 都有用；可以先做，不依赖 B。
- **B. 同会话轮转**（第 4–9 节）：上下文达到轮间水位时，在下一轮开始前于**同一会话**追加一条不调用模型的轮转条目，清空模型可见上下文，旧原文留在分支上按需检索。默认关闭；阶段 0 离线统计（第 9.1 节）决定它能否合入公开 `main`，统计不支持时整体撤回。

本文早期版本设计为“轮转时创建新会话并导出分支日志”。改为同会话后，会话 ID、插件实例、Browser tab、子任务与 Goal 状态都不随轮转变化，也不再需要日志导出、切换事件新取值和订阅重绑。早期版本只查 Git history。

## 1. 目标与已确定的行为

采用 Mainplane 的基本方向：保留旧原文，按需检索，而不是为腾出上下文先生成整段历史摘要。参考：[原帖](https://x.com/Alezander9/status/2115842962521509968)、[本次核对的 Mainplane 源码](https://github.com/mainplane-ai/mainplane/tree/2c77939862c89f119da6fc0109866dbf3d9453f8)。

只在**下一轮开始**时轮转。当前轮不因这项功能被中断，不在工具调用之间轮转。

```text
用户输入 → 模型与工具持续工作 → 本轮完全结束 → 等待输入
                                                 ↓
                                        用户提交下一轮请求
                                                 ↓
                              当前占用越过轮间水位且具备资格？
                                ├─ 否：正常提交（原有压缩路径不变）
                                └─ 是：同一会话追加轮转条目
                                       （检索说明＋原文尾部摘录）
                                       → 正常提交本次用户输入
```

“一轮”指一次完整请求及其全部工具、重试和自动续跑，直到 Pi 不再自动继续。已进入当前运行队列的 steering/follow-up 不在中途迁移；只有空闲后的新提交进入轮间判断。

会话 ID 始终不变。本方案不增加任务 ID、执行片段调度器、任务合同、跨会话状态合并、向量数据库、后台记忆模型或自动摘要。

## 2. 当前实现与接入位置

以下为源码事实，不是已实现的功能。源码位置按函数名引用，行号会漂移。

| 当前能力 | 源码位置 | 对本方案的约束 |
| --- | --- | --- |
| `CompactionEntry` 保存 `summary`、`firstKeptEntryId`、`details`、`fromHook`；`appendCompaction` 在 `firstKeptEntryId` 为空时指向条目自身 | [SessionManager](../../packages/rotom-pi/packages/coding-agent/src/core/session-manager.ts) | 轮转条目复用压缩条目，不新增条目类型；指向自身即“不保留旧消息” |
| `buildContextEntries` 只投影最新压缩条目、`firstKeptEntryId` 起的保留条目和其后的条目；旧条目仍在分支上 | 同上 | 轮转后模型只见轮转条目与新输入；`getBranch()` 仍可读到全部旧原文 |
| 压缩摘要以 `COMPACTION_SUMMARY_PREFIX`（“compacted into the following summary”）包装后进入上下文 | [messages.ts](../../packages/rotom-pi/packages/coding-agent/src/core/messages.ts) | 轮转条目不是摘要，需要按 `details` 使用不同包装（5.2） |
| 原生压缩把上一条压缩的 `summary` 作为 `previousSummary` 合并 | [compaction.ts](../../packages/rotom-pi/packages/coding-agent/src/core/compaction/compaction.ts) | 轮转后再发生原生压缩时，轮转条目文本会进入合并（5.3） |
| `shouldCompact()` 判定 `contextTokens > contextWindow - reserveTokens`；`reserveTokens` 默认 16384，可按模型覆盖 | 同上、[settings-defaults.ts](../../packages/rotom-pi/packages/coding-agent/src/core/settings-defaults.ts) | 轮间水位由同一设置派生，不新增配置项 |
| **轮内每次请求模型前**都会检查阈值并压缩（`prepareNextTurnWithContext` → `_compactBeforeNextAssistantResponse`）；`_handlePostAgentRun` → `_checkCompaction` 在运行结束后再查；下一次 `prompt()` 的 `_prepareRun` 开头还会查 | [AgentSession](../../packages/rotom-pi/packages/coding-agent/src/core/agent-session.ts) | 与压缩同阈值时，长轮次中途越线会先被原生压缩，轮转几乎不触发（4.1） |
| 阈值估算有两条路径：`_exceedsCompactionThreshold` 用投影估算；`_checkCompaction` 优先用 Provider usage，有 `context_edit` 时用投影估算，错误或零 usage 时退回消息估算 | 同上 | 轮间判断必须与 `_checkCompaction` 共用估算（4.1） |
| `session_before_compact` 的 `reason` 为 `manual \| extension \| threshold \| overflow`，处理器可取消或提供替代结果 | [extension types](../../packages/rotom-pi/packages/coding-agent/src/core/extensions/types.ts) | 轮转新增 `"rollover"`，需逐一核对现有处理器（5.4） |
| 现有 `session_before_compact` 处理器：Offload（只处理 `threshold`）、Goal（记账、可取消续跑或因预算取消）、Subagent（非 manual 时挂起 widget）、observability（记录）、Qoder session policy | [offload.ts](../../packages/rotom-sol-pi/src/sol-pi/extensions/observation-pack/offload.ts)、[Goal lifecycle](../../packages/rotom-goal/src/lifecycle.ts)、[Subagent](../../packages/rotom-subagents/src/extension/index.ts)、[observability](../../rotom/extensions/observability/index.ts)、[Qoder session policy](../../rotom/extensions/qoder/session-policy.mjs) | 同上 |
| Context Layers 的 `context_status` 带 `query` 时在**整条分支**全部消息中做子串搜索，返回 `@entryId` 与摘录；`context_recall` 按 `@entryId` 或摘要块返回原文（含工具参数、图片，不回显 thinking/signature）；搜索只覆盖文本部分，不含 tool call 参数 | [blocks.ts](../../rotom/extensions/context-layers/blocks.ts)、[recall.ts](../../rotom/extensions/context-layers/recall.ts) | B 的检索直接复用，不另做导出；A 需补全搜索覆盖 |
| Context Layers 摘要以 `[Context summary <id>, tier <n>. … recall exact details with context_recall.]` 呈现，由 Pi 原生 `context_edit` 投影 | [copy.ts](../../rotom/extensions/context-layers/copy.ts) | 旧会话中已有摘要在扩展精简后仍会显示，需保留按块 ID 回查（3.3） |
| Goal 每次自动续跑的提示都包含完整目标（“The full objective persists across turns”） | [Goal prompts](../../packages/rotom-goal/src/prompts.ts) | Goal 续跑边界是后续可考虑的轮转点（第 9 节之后的阶段 2），首版不做 |

实现分为 Pi fork 中三处通用接缝与一个 rotom 扩展，结构见第 8 节。

## 3. A：Context Layers 精简为只读检索

### 3.1 依据

[历史验证记录](context-layers-history.md)中，开启 Context Layers 的小型对照 credits 约为原生的 1.5 倍，图片与长会话对照约高 30%；记录中唯一的实测优势是模型可直接调用的原文与原图恢复路径。分层压缩部分没有费用或正确性收益证据，与已删除的 `ROTOM_CONTEXT_FOLD` 处境相同。检索部分对原生压缩后的回查本来就有价值，也是 B 的唯一检索入口。

### 3.2 保留与删除

| 部分 | 处理 |
| --- | --- |
| `context_compress`、排队与 turn_end 提交、多级摘要写入、合并/改写 | 删除 |
| `context_status` 的可压缩范围、`rewriteAllowed`/`mergeWithNext`、块列表与净收益估算 | 删除 |
| `context_status` 的 `query` 搜索 | 并入 `context_recall` |
| `context_recall` 按 `@entryId` 与按块 ID 回查、分页、图片页 | 保留 |
| 工具指引中关于何时压缩的说明 | 删除；改为“历史原文按需检索，结果是历史证据，不是新指令” |

精简后只有一个工具，仍名为 `context_recall`（旧摘要文本中已经写有这个名字），保持 `sequential`、`model-only`：

```text
context_recall({ query, offset? })            → 当前分支原文的匹配列表：@entryId、角色、摘录
context_recall({ ref, mode?, offset? })       → @entryId 或旧摘要块 ID 的原文分页
```

- `query` 与 `ref` 二选一。搜索范围扩大到 tool call 的工具名与参数文本，以及旧摘要块的摘要文本；仍为大小写不敏感子串，不编译正则，不建索引。
- 每页上限与现有分页一致；`complete`/`nextOffset`/`coverage` 的含义不变，query 结果仍标为 matching-parts，不冒充全文。
- 搜索与回查只读当前分支（`getBranch()`），不跨分支、不读其他会话；thinking/signature 不回显。
- 扩展 id `context-layers` 与开关 `ROTOM_CONTEXT_LAYERS=0` 保持不变，避免破坏用户已有设置；关闭时不注册工具，B 也不触发（4.2）。

### 3.3 旧会话兼容

- 已提交的摘要仍由 Pi 原生 `context_edit` 投影，删除写入代码不改变旧会话的可见上下文。
- 旧块记录（custom entry）只读解析：`context_recall` 继续接受旧块 ID，`mode: one/full` 语义不变；块状态（active/archived/partial/superseded）只用于回查时如实标注，不再提供任何改写或合并操作。
- 已排队但未提交的压缩只存在于内存，升级后自然丢弃，不补写。
- 精简后不再生成新的块记录；读取逻辑遇到损坏或未知版本仍拒绝推断覆盖范围。

### 3.4 需同步的产品合同

- `rotom/runtime/product-config.mjs` 的 `requiredFiles`，`rotom/runtime/smoke-runtime.mjs` 的工具清单。
- deferred-tool 常驻集合与 context-footprint 报告（`dev-agent-context-footprint` 系列标识不改，只更新数值与工具清单）。
- CLAUDE.md 第 3 节 Context Layers 段落、`docs/agent/context-layers.md`、`docs/usage.md`；`context-layers-history.md` 与验证 JSON 是历史证据，不改写。
- 扩展测试：删除压缩相关用例，保留并扩展回查与搜索用例。

### 3.5 A 的验证

- 搜索命中 tool call 参数、旧摘要文本与原生压缩覆盖的条目；不命中兄弟分支。
- 旧会话 fixture（含 active、archived、partial 块）加载后摘要可见性不变，按块 ID 与 `@entryId` 回查结果与精简前一致。
- 工具面只剩 `context_recall`；`ROTOM_CONTEXT_LAYERS=0` 时没有该工具；显式 `--tools` 优先。
- 负向对照：去掉旧块 ID 解析时旧会话回查用例必须失败。
- 按仓库合同跑扩展测试、smoke 与 context-footprint 报告；不改 npm 版本。

## 4. B：轮转规则（不保存待轮转标志）

### 4.1 判断时间、估算源与轮间水位

在下一次空闲提交的 `input` 事件中判断：它在 `prompt()` 内、模板/Skill 展开与 `_prepareRun` 之前执行，并被等待完成，因此判断与写入先于本次请求的任何压缩检查。只处理 `source` 为 `interactive` 或 `rpc`、且 `streamingBehavior` 为空（空闲）的输入；`extension` 来源的输入（如其他插件 `sendUserMessage`）不触发轮转。

**估算源与压缩一致。** 从 `_checkCompaction` 的阈值分支中抽出一个只读函数，按它现有的优先级（Provider usage → 有 `context_edit` 时投影估算 → 错误/零 usage 时消息估算，含“usage 早于最近压缩则不计”的检查）给出当前上下文量。轮间判断与 `_checkCompaction` 共用这个函数，不另写估算，不额外发模型请求；估算不是 Provider 精确计费量。

**轮间水位低于压缩阈值。** 与压缩同阈值时，长轮次中途越线总会先被轮内压缩处理，到轮末占用已经降下来。因此：

```text
压缩阈值  = contextWindow - reserveTokens          （现有，不变）
轮间水位  = contextWindow - 2 × reserveTokens      （候选值）
轮转条件：当前估算量 > 轮间水位，且满足 4.2 全部资格
```

- 水位由现有 `reserveTokens` 派生，不新增配置项、百分比或模式。最终取值由阶段 0 统计决定并写回本节。
- 代价：处于水位与阈值之间的会话会比原来更早清空可见上下文，只能检索。第 9.3 节必须测量它对续做正确性的影响。
- 共用估算源且水位 ≤ 阈值，所以判定“不轮转”后，只有不具备资格的会话会在随后的 `_prepareRun` 里被压缩。

不添加待轮转条目或恢复状态机。重启、换模型、手动压缩或修改投影后都从当前状态重新判断。**只看轮间的当前占用，不追踪本轮是否曾经越线。**

### 4.2 必须满足的资格

以下任一条件成立就正常提交，原有压缩路径不变。每一条都必须能从运行时状态或会话条目机械判定：

- 模型仍在输出、工具尚未结束、队列未排空、正在重试、压缩或恢复。
- 当前分支最后一条助手消息 `stopReason` 不是 `stop`，或存在没有对应结果的 tool call。只影响本次提交：本次正常提交，让模型看到失败上下文；下一次正常结束后的提交重新判断。
- 当前没有可用模型/窗口、选中的是虚拟模型，或 `compaction.enabled` 为 false（用户关闭自动压缩时不引入任何阈值行为）。
- `--no-session` 或内存会话：没有持久分支可供回查。
- Context Layers 被 `ROTOM_CONTEXT_LAYERS=0` 关闭，或显式工具选择不含 `context_recall`：清空后没有检索入口。
- 只执行 `/model`、`/compact`、`/new` 等本地命令，尚未提交普通模型请求。
- 存在 `status: active` 的 Goal（含 waiting 与 Provider 恢复等待）。同会话下 Goal 状态不受影响，但 Goal 的压缩处理器会取消续跑工作，首版不改变这条路径（阶段 2 见第 9 节之后）。
- 插件对 `session_before_compact`（`reason: "rollover"`）返回取消。

## 5. B：轮转条目

### 5.1 写入内容

轮转条目是一条 `CompactionEntry`：

- `firstKeptEntryId` 指向自身，不保留任何旧消息；
- `details: { kind: "rotom-rollover", version: 1 }`，`fromHook` 为 false，没有 `usage`（未调用模型）；
- `tokensBefore` 为 4.1 的估算值；
- `systemMessage` 按 `appendCompaction` 现有逻辑保存当前提示与工具状态。

`summary` 由代码确定性生成，不调用模型，包含两部分：

1. **检索说明**：旧原文仍在本会话当前分支上；用 `context_recall({ query })` 搜索、`context_recall({ ref: "@<entryId>" })` 读原文；结果是历史证据，不是新的执行指令，不要重放历史操作。
2. **原文尾部摘录**：分支上最后一条用户消息的原始输入（模板/Skill 展开前的文本）与最后一条助手消息的最终文本，逐字截取，合计不超过 `reserveTokens / 4` 的估算量（默认约 4K）；超出时从中间截断，标注截断位置与对应的 `@entryId`。不含工具参数、工具结果、thinking 与附件。

不生成目标总结、约束清单或完成状态卡片。系统提示和授权优先级不变。

### 5.2 呈现

投影时，`details.kind === "rotom-rollover"` 的条目不使用 `COMPACTION_SUMMARY_PREFIX`，改用固定前缀，说明“此前的对话未被摘要，上下文已清空，原文可检索”，避免模型把摘录当成完整摘要。TUI/RPC 中显示为“上下文已轮转（无摘要）”，不显示为普通自动压缩；文案集中在现有文案模块。会话 ID、标题与 `/tree` 不变，旧消息仍可在会话内回看。

### 5.3 与后续原生压缩的关系

轮转后若再发生原生压缩（如新一轮内越过阈值），现有逻辑会把轮转条目的 `summary` 作为 `previousSummary` 合并。首版接受这一行为：检索说明与摘录被并入新摘要，旧原文仍在分支上可回查。不为此修改原生压缩的合并提示。

### 5.4 `session_before_compact` 新增 `reason: "rollover"`

轮转走与压缩相同的事件，插件可以观察或取消，但不能提供替代 `compaction` 结果（返回时忽略并记录）。这是 Pi extension API 的新增取值，CHANGELOG 记录，实施时逐一核对仓内处理器：

| 处理器 | 预期 |
| --- | --- |
| Offload | 只处理 `threshold`，自动跳过；轮转本身已清空上下文，无需先卸载 |
| Goal | 首版有 active Goal 时不轮转（4.2），处理器不会在轮转时被触发到续跑取消路径；仍需确认非 active 状态下对新取值无副作用 |
| Subagent | 非 manual 时挂起 widget，随后 `session_compact` 恢复；确认对轮转同样成立 |
| observability | 记录原因、关联标识、耗时与结果；不记录摘录内容 |
| Qoder session policy | 只刷新上下文引用，不看 `reason`；预期无副作用 |
| Context Layers（精简后） | 无需处理；按会话 ID 与分支读取，不依赖压缩事件 |

插件取消时本次正常提交，照常走压缩路径，不反复重试轮转。轮转成功后照常发出 `session_compact`。

## 6. B：与现有压缩及 Offload 的关系

- **轮内**：请求前阈值检查、overflow 恢复、有界重试及用户 `/compact` 保持原有语义，不改阈值。
- **轮末**：`_handlePostAgentRun` 中的阈值压缩只在“本轮正常结束、没有继续工作、且具备 4.2 资格”时延后到下一次提交；此时占用必定已越过水位，下一次提交会轮转。不满足资格时照常压缩。
- **Offload**：具备资格时轮转优先，不先 Offload；不具备资格或功能关闭时 Offload 照常运行。水位低于阈值时 Offload 本来就不运行，两者互不干扰。
- 不在 `session_before_compact` 中一律取消；上述区分在核心运行流程里完成。
- 若边界处理器、队列或 Goal 仍要继续，仍是当前工作，不能为了等待轮转而禁止必要的原生压缩。

## 7. B：执行顺序与失败语义

### 7.1 顺序

以下是设计顺序，不是最终 API 签名：

1. 宿主接受普通输入；运行中按原有 steering/follow-up 规则处理，不轮转。
2. `prompt()` 照常处理扩展命令，随后发出 `input` 事件；轮转扩展在其中按第 4 节判断。未触发则返回 `continue`。
3. 触发时调用 Pi 的“重置上下文”接缝（8.1）：发出 `session_before_compact`（`reason: "rollover"`），未被取消则追加 5.1 的轮转条目、刷新投影、发出 `session_compact`，整个过程被等待完成，不中止运行。
4. 扩展返回 `continue`，`prompt()` 在同一会话中继续展开模板/Skill、`_prepareRun` 与派发。输入只经过一次 `prompt()`，不重发、不改来源。

宿主不需要重绑订阅，RPC 的 prompt 响应语义不变，也不需要回报新 session ID。

### 7.2 失败

轮转失败一律退回“不轮转”：本次输入照常提交，原有压缩路径接管，并提示用户。不丢弃输入，也不因轮转失败阻止请求。

| 情况 | 行为 |
| --- | --- |
| 插件取消 | 本次正常提交；显示取消原因，不重试轮转 |
| 生成摘录失败（写入前） | 不写条目，本次正常提交并提示 |
| 追加条目报错 | 先回读当前分支：条目已存在按成功处理；不存在按未轮转处理，本次正常提交。不盲目再追加 |
| 轮转成功后提交失败 | 轮转条目保留，按现有提交失败语义处理；不撤销条目、不再次轮转 |
| 模型请求或外部操作已派发，结果未知 | 沿用现有 unknown 与有界恢复合同 |

## 8. 实现结构

### 8.1 Pi fork：三处通用接缝

只提供能力，不含 rotom 策略（水位、资格、摘录、开关都不在 Pi 内）：

| 接缝 | 内容 | 为什么扩展现有 API 做不到 |
| --- | --- | --- |
| 可等待的“重置上下文” | `ExtensionContext` 新增方法（名称由实施者定，建议 `resetContext({ summary, details })`），仅在空闲且处于 `input` 处理器内可用，否则拒绝；以 `reason: "rollover"` 发出 `session_before_compact`（处理器可取消，返回的替代 `compaction` 被忽略），写入 `firstKeptEntryId` 指向自身的压缩条目，发出 `session_compact`；返回成功、被取消或失败；不调用 `abort()` | 现有 `ctx.compact()` 不等待完成且先 `abort()`，在 `input` 中调用会与本次提交竞争；扩展只有只读 SessionManager，返回的压缩结果无法让 `firstKeptEntryId` 指向自身 |
| 压缩事件阶段 | `session_before_compact` 增加阶段字段，至少区分“下一次请求前”（`prepareNextTurnWithContext` 与 `_prepareRun`）、“运行结束后”（`_handlePostAgentRun`）、手动/扩展请求与轮转；`reason` 增加 `"rollover"` | 轮内与轮末阈值压缩的 `reason` 都是 `threshold`，扩展无法只延后轮末那次 |
| 估算与呈现 | 从 `_checkCompaction` 抽出共用的阈值估算，并以只读方式提供给扩展（新增方法或扩展 `getContextUsage` 的返回，不改变其现有字段语义）；压缩条目 `details.kind === "rotom-rollover"` 时投影使用专用前缀 | `getContextUsage()` 使用投影估算、压缩后返回 `null`，与 `_checkCompaction` 的 usage 优先估算不同；`COMPACTION_SUMMARY_PREFIX` 无法由扩展替换 |

这些都是 Pi extension API 的新增能力，CHANGELOG 记录；现有字段语义不变。Pi 源码改动后按仓库合同 `build:pi`、`check:pi` 并提交重建后的归档与 lock，fork 版本号不变（与既有 fork 修复提交一致）。

### 8.2 rotom 扩展 `rotom/extensions/session-rollover/`

| 职责 | 实现 |
| --- | --- |
| 开关 | `ROTOM_SESSION_ROLLOVER=1` 时注册，未设置或其他值不注册任何处理器；不增加水位、百分比或模式配置 |
| 判断 | `input` 处理器：按 4.1 的共用估算与水位、4.2 的资格判断；`context_recall` 是否在当前可用工具中由此判断 |
| 写入 | 生成 5.1 的检索说明与尾部摘录，调用 8.1 的重置接缝；失败按 7.2 退回 |
| 延后轮末压缩 | `session_before_compact` 中，阶段为“运行结束后”、`reason` 为 `threshold`、且具备 4.2 资格时取消；其余一律不干预 |
| 产品声明 | 在 `product-config.mjs` 中声明，位置在 `third-party` 之前：handler 按扩展加载顺序执行且首个取消即返回，保证轮末取消先于 Offload 生效 |
| 文案 | 轮转提示、取消原因集中在扩展的 copy 模块 |

### 8.3 与 Context Layers 的关系

检索留在精简后的 `context-layers` 扩展，不并入轮转扩展：检索默认开启并服务于原生压缩后回查和旧会话摘要，轮转默认关闭且可能整体撤回；两者只通过“`context_recall` 是否可用”这一条资格相连，不共享代码与状态。轮转实测通过并改为默认开启后，再评估合并为一个上下文扩展及旧标识的兼容迁移。

不改 npm 版本，不改现有自动压缩默认，不覆盖存活会话安装。

## 9. 验证与启用条件

### 9.1 阶段 0：离线统计

用维护者本机已有的会话 JSONL 离线回放，不调用模型、不产生费用。统计脚本与 B 的实现可以并行开发；B 默认关闭，统计结果决定它能否合入公开 `main`：

- 逐个请求重算 4.1 的估算，统计越过压缩阈值的事件中，有多少发生在轮中途、多少发生在轮末；
- 对候选水位及另外一两个由 `reserveTokens` 派生的候选做同样统计，并统计单轮上下文增长分布；
- 另统计越线发生时是否存在 active Goal，用于评估阶段 2 的价值；
- 输出只含聚合计数与分布，不含消息内容、路径或 session ID；会话文件和原始统计不进仓库；
- 通过门槛：候选水位下，原本发生过原生阈值压缩的会话中，至少一半在第一次原生压缩之前就能在某个轮间被轮转接管。不达门槛时 B 不合入 `main`，A 不受影响。
- 统计脚本放在 `rotom/evals/`（维护面，不进产品包），附带用合成会话 fixture 的单测；会话目录默认读 `$PI_CODING_AGENT_DIR/sessions`，未设置时为 `~/.pi/agent/sessions`。

### 9.2 B 的确定性检查

| 检查 | 必须证明的行为 |
| --- | --- |
| 水位上下界、换模型、手动压缩、重启 | 与 `_checkCompaction` 同一估算；水位由 `reserveTokens` 派生；无持久 pending |
| 估算一致性 | 判定“不轮转”的具备资格会话，紧接着的 `_prepareRun` 不触发阈值压缩 |
| 4.2 每一条资格 | 各自单独阻止轮转，本次正常提交 |
| 正常结束且越过水位 → 下一次提交 | 结束当下不写条目；下一次恰好追加一条轮转条目；会话 ID 不变；本次输入只派发一次 |
| 投影 | 轮转后模型只见轮转条目（专用前缀）与新输入；`getBranch()` 仍含全部旧条目 |
| 摘录 | 逐字取自分支原文、不超过上限、截断有标注；不含工具结果、thinking 与附件 |
| 检索 | 轮转前的工具参数、结果、图片均可用 `context_recall` 找回；不命中兄弟分支 |
| 轮末阈值、Offload、轮内 overflow | 具备资格时轮末不生成摘要、不运行 Offload；否则原路径不变 |
| 后续原生压缩 | 轮转条目作为 `previousSummary` 合并；旧原文仍可回查 |
| `"rollover"` 事件 | 5.4 每个处理器行为符合预期；取消后正常提交；替代结果被忽略 |
| Browser tab、子任务 | 轮转前后保持不变 |
| 失败与重启 | 每种 7.2 失败都退回正常提交且输入只派发一次；追加报错时回读确认，不重复追加 |
| 接缝约束 | 重置接缝在非空闲或 `input` 处理器之外调用时被拒绝；不调用 `abort()`；返回的替代 `compaction` 被忽略 |
| 加载顺序 | 轮末取消发生在 Offload 处理器之前，Offload 不在被取消的那次运行 |
| 负向对照 | 禁用轮转入口、漏掉输入、改用另一估算源或去掉专用前缀时，相关检查必须失败 |

优先扩展 `agent-session-auto-compaction-queue.test.ts`、`agent-session-compaction.test.ts`、`agent-session-runtime-events.test.ts`、`rpc-prompt-response-semantics.test.ts` 与 Context Layers 扩展测试；执行前重新定位实际文件与 scripts。

### 9.3 真实续做与性能

另行取得模型、费用/时长及外部操作授权后，比较同一任务在**当前默认配置**（原生压缩 + Offload，Context Layers 已按 A 精简）与开启轮转时的表现：

- 统计整个后续任务的完成时间、请求次数、检索次数及所有辅助用量；记录实际轮转次数与原生压缩次数，核对阶段 0 的触发率。
- 区分 warm/cold cache，记录 Provider 报告费用；未知费用保持 unknown，不用 token 或缓存命中推算美元。
- 使用无法从当前输入猜出的随机历史细节，独立核验精确输出，证明真正检索了旧原文。
- 覆盖仅输入“继续”的续做、早期禁止事项、未决操作、处于水位与阈值之间提前轮转、连续两次轮转、重启后续做、Browser tab 跨轮转使用，以及图片回查。
- 外部操作验收要能发现重复执行；unknown 场景不做真实写入重放实验。

未获得后续任务正确性与端到端收益证据前，不默认启用，不宣称优于现有压缩或 Offload。若回查遗漏约束、提前轮转损害续做或检索成本抵消收益，保持关闭；不以增加任务状态系统来掩盖这条简化路线的局限。

### 阶段 2（不在首版范围）：Goal 续跑边界

Goal 每次自动续跑都重新注入完整目标，续跑提交是天然的轮转点。阶段 0 若显示大量越线发生在 active Goal 中，再单独设计：轮转与 Goal 压缩处理器（记账、取消续跑、预算取消）的交互、续跑计数与预算是否受影响，以及完成审阅能否读取轮转前证据。

## 10. 已知限制与本轮交付

- **Goal 会话首版不受益**：有 active Goal 时不轮转，最长的自动任务仍走原生压缩。
- **提前轮转有代价**：水位低于压缩阈值，部分本来还能保留可见上下文的会话会更早清空。
- **检索能力有限**：子串搜索、分页，没有语义检索；尾部摘录只帮助定位，没有任务合同或约束提取，模型仍可能不知道早期约束需要检索。
- **依赖 Context Layers 的检索工具**：关闭或被显式工具选择排除时不轮转。
- **会话文件持续增长**：旧原文都留在同一 JSONL，与现有压缩行为一致。
- 整轮可能很长，轮内原生压缩仍会发生；本方案不是“永不压缩”。
- 外部页面、已删除文件或被截断的工具输出，不因原文仍在会话中而可恢复。
- 截至本文定稿，A 的精简、阶段 0 统计、B 的代码与开关及全部实测均未实现或执行；进度以执行清单的回报为准。

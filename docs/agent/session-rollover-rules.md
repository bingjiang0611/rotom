# 同会话轮转 · B：轮转规则、条目、压缩关系与失败语义

设计总览与实现结构见 [session-rollover.md](session-rollover.md)，执行清单见 [session-rollover-worklist.md](session-rollover-worklist.md)。节号沿用原设计文档，跨文件引用（如“第 9.1 节”）继续成立。

## 4. B：轮转规则（不保存待轮转标志）

### 4.1 判断时间、估算源与轮间水位

在下一次空闲提交的 `input` 事件中判断：它在 `prompt()` 内、模板/Skill 展开与 `_prepareRun` 之前执行，并被等待完成，因此判断与写入先于本次请求的任何压缩检查。只处理 `source` 为 `interactive` 或 `rpc`、且 `streamingBehavior` 为空（空闲）的输入；`extension` 来源的输入（如其他插件 `sendUserMessage`）不触发轮转。

**估算源与压缩一致。** 从 `_checkCompaction` 的阈值分支中抽出一个只读函数，按它现有的优先级（Provider usage → 有 `context_edit` 时投影估算 → 错误/零 usage 时消息估算，含“usage 早于最近压缩则不计”的检查）给出当前上下文量。轮间判断与 `_checkCompaction` 共用这个函数，不另写估算，不额外发模型请求；估算不是 Provider 精确计费量。

**轮间水位低于压缩阈值。** 与压缩同阈值时，长轮次中途越线总会先被轮内压缩处理，到轮末占用已经降下来。因此：

```text
压缩阈值  = contextWindow - reserveTokens          （现有，不变）
轮间水位  = contextWindow - 2 × reserveTokens      （阶段 0 确认）
轮转条件：当前估算量 > 轮间水位，且满足 4.2 全部资格
```

- 水位由现有 `reserveTokens` 派生，不新增配置项、百分比或模式。最终取值由阶段 0 统计决定并写回本节。
- **阶段 0 已确认 2 × 取值**（`rotom/evals/bin/rollover-stats`，维护者本机会话离线回放，数值见 [session-rollover-report.md](session-rollover-report.md)）：越过压缩阈值的 113 个会话中，59 个（52.2%）在首次越线前已有轮间点越过 `contextWindow - 2 × reserveTokens`；3 × 与 4 × 分别为 69.9% 与 76.1%，但都提前更多上下文，故取最接近压缩阈值的 2 ×。原始统计与会话文件不进制库。
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

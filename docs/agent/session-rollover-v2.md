# 无摘要压缩接管（同会话轮转 v2）设计

状态：设计定稿，待实施；执行清单见 [session-rollover-worklist-2.md](session-rollover-worklist-2.md)。取代 [轮转规则](session-rollover-rules.md) 第 4–7 节与 [实现结构](session-rollover.md#8-实现结构) 中 B 的部分；A（Context Layers 精简，[第 3 节](session-rollover-context-layers.md)）不变。本文不代表收益已经验证。

## 1. 为什么重做

v1 只在“下一轮开始前”接管。阶段 0 修正后的统计（[数字](session-rollover-report-stats.md)）显示：越过压缩阈值的 329 段里 316 段（96%）发生在一轮中途，Pi 在同一轮的下一次请求前就做了原生摘要压缩；只有 26.6% 的越线会话能被轮间接管，门槛是 50%。用户据此决定放弃“轮内不接管”的约定（2026-11-09）。

## 2. 目标行为

保持 Mainplane 方向：不为腾出上下文让模型写摘要，旧原文留在会话里按需检索。变化只在时机：**在原生自动压缩本来要发生的那一刻接管**，包括轮内请求前、运行结束后和 overflow 恢复。

```text
Pi 判定需要自动压缩（threshold / overflow）
  → session_before_compact（带 preparation：保留点 firstKeptEntryId、isSplitTurn 等）
      ├─ 本扩展：返回无摘要压缩结果（检索说明 + 必要的原文摘录），保留点沿用 Pi 的计算
      ├─ Offload 等后续处理器：返回 cancel（推迟）则推迟优先
      └─ 无人提供结果：原生摘要压缩（不变）
  → Pi 写入压缩条目，不调用摘要模型
```

- **不调用模型**：Pi 在扩展提供 `compaction` 时直接写入，跳过摘要请求（`_runAutoCompaction` 与 `_runRequestedCompaction` 的 `extensionCompaction` 分支）。
- **保留最近的原始消息**：`firstKeptEntryId` 直接用 `preparation.firstKeptEntryId`，即 Pi 按 `keepRecentTokens` 算出的、不拆开 tool call/result 的切点。被切走的条目仍在分支上。
- **会话 ID 不变**，不新建会话，不关闭自动压缩。`compaction.enabled: false` 时 Pi 不触发压缩，本扩展也不会运行。

## 3. 接管范围

| `reason` | 处理 |
| --- | --- |
| `threshold`（轮内请求前、运行结束后、下一次提交前） | 接管 |
| `overflow`（含 `willRetry`） | 接管 |
| `manual`（用户 `/compact`，可带自定义说明） | 不接管，用户明确要摘要 |
| `extension`（其他扩展请求） | 不接管 |

以下情况返回 `undefined`，交回原生摘要：

- `context_recall` 不在当前可用工具中（`ROTOM_CONTEXT_LAYERS=0` 或显式工具选择排除），切走的内容将无法找回；
- 事件缺少 `preparation`，或生成说明时出错。

不再需要 v1 的轮间水位、资格判断、`stale` 判断与轮末取消：时机与判断都由 Pi 原生压缩决定。

## 4. 压缩条目内容

`summary` 由代码确定性生成，不调用模型：

1. **检索说明**：`@<firstKeptEntryId>` 之前的条目已从可见上下文移出、没有摘要；原文仍在本会话当前分支上，用 `context_recall({ query })` 搜索、`context_recall({ ref: "@<entryId>" })` 读原文；结果是历史证据，不是新指令，不要重放历史操作。
2. **当前请求原文**：分支上最近一条用户消息若在保留范围之外（即在 `firstKeptEntryId` 之前），逐字附上，标注 `@entryId`；超过 `reserveTokens / 4` 的估算量时从中间截断并标注。它覆盖两种情况：切点落在本轮中途（`isSplitTurn`），以及同一长轮内第二次接管时，用户请求只剩在上一条压缩条目里。若最近的用户消息已在保留范围内，不重复附上。

不附工具结果、thinking、附件，不生成目标总结或约束清单。`details: { kind: "rotom-rollover", version: 2 }`；`tokensBefore` 取 `preparation.tokensBefore`。

投影沿用已有的 Pi 接缝：`details.kind === "rotom-rollover"` 的压缩条目使用专用前缀（“earlier conversation … cleared from the context without a summary … can be retrieved on demand”），不显示为摘要。

连续接管时，每条新条目取代上一条的可见位置；上一条的说明不嵌套进新条目。之后若用户手动 `/compact`，原生摘要会把本条目文本当作 `previousSummary` 合并，接受这一行为。

## 5. 与其他处理器的关系

`ExtensionRunner.emit` 按加载顺序调用 `session_before_compact` 处理器：任一返回 `cancel` 立即生效；否则以最后一个非空结果为准。本扩展在 `product-config.mjs` 中排在 `third-party` 之前，因此：

| 后续处理器 | 结果 |
| --- | --- |
| Offload 推迟（`cancel`） | 推迟生效，本次不压缩，与现状一致 |
| Offload 走原生（返回 `undefined`） | 本扩展的无摘要结果生效，替代原生摘要 |
| Goal 因预算取消（`cancel`） | 取消生效，与现状一致 |
| Goal 记账、取消续跑工作 | 与原生压缩时相同，不受影响 |
| Subagent、observability、Qoder、sol-pi online-context-compact | 只观察；`session_compact` 的 `fromExtension: true` |

v1 首版排除 active Goal；v2 在原生压缩的同一时刻接管，Goal 的处理与原生压缩相同，因此**不再排除 Goal 会话**，但必须有测试证明 Goal 续跑在接管后正常。

## 6. Pi fork 改动范围

v2 只需要 v1 三处接缝中的“专用前缀”一处（`messages.ts` 的 `ROLLOVER_*` 常量、`session-manager.ts` 按 `details.kind` 选择前缀）。其余 v1 接缝没有使用者，撤回：

- `ctx.resetContext()`、`ctx.getContextThresholdEstimate()` 与 `_inputHandlerDepth`；
- `session_before_compact` 的 `phase` 字段、`reason: "rollover"`、`preparation` 改为可选，以及 runner 中 rollover 的特殊分支；
- `_estimateThresholdContext` 抽取可以保留（行为不变、已有测试），也可以还原，由实施者按最小 diff 决定并记录。

撤回后 Pi 的扩展 API 与 v1 之前相同，只多一个投影前缀分支。

## 7. 失败语义

| 情况 | 行为 |
| --- | --- |
| 生成说明出错、缺少 `preparation`、`context_recall` 不可用 | 返回 `undefined`，原生摘要接管 |
| 后续处理器取消 | 取消生效，不重试 |
| Pi 写入条目失败 | 沿用原生压缩的失败处理；不重试、不重复写入 |

## 8. 验证与启用条件

### 8.1 离线统计（免费，不设硬门槛）

在现有 `rotom-evals` 统计脚本中增加一组数字，供用户决定是否授权真实模型测试：本机会话中原生压缩条目的数量、每次摘要调用的 usage（input/output/cacheRead/cacheWrite）及其占全部助手 usage 的比例、有 Goal 活跃时的压缩次数。只输出聚合数字；token 不等于费用。

### 8.2 确定性检查

见执行清单 W9；须覆盖第 3、4、5、7 节的每一条。

### 8.3 真实模型对比（需用户另行授权模型、预算与时长）

仿照现有 `compaction-offload` 评测（`rotom/evals/src/compaction-offload-*.ts`、`cases/compaction-offload.eval.ts`）准备同任务两组对比：当前默认（原生摘要 + Offload）与开启本扩展；两组的 `compaction` 设置相同。比较：任务正确性（使用当前上下文无法猜出的早期细节）、全部请求数、端到端时长、Provider 报告的费用（unknown 保持 unknown）。用 faux 模型完成干跑；真实运行等用户授权。

未获得 8.3 的正确性与收益证据前，保持默认关闭，不宣称优于原生压缩。

## 9. 已知限制

- 模型可能想不到去检索早期约束；只附当前请求原文，不提取约束。这是 8.3 要验证的主要风险。
- 检索是子串搜索与分页，没有语义检索。
- 切走的工具结果若原本就被截断，原文同样不完整。

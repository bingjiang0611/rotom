# 无摘要压缩接管（v2）· 执行清单

设计依据：[session-rollover-v2.md](session-rollover-v2.md)（下称“v2 设计”）。协作方式、授权范围、自主验证要求、停止条件与回报格式沿用 [第 1 轮清单](session-rollover-worklist.md) 第 0、1、4、5、6 节，本清单只列差异与新工作包。两者冲突时以 v2 设计为准，并写进决策记录。

## 0. 与第 1 轮的差异

- **分支不变**：`claude/kind-bardeen-roufe9`。先 fetch 最新提交（含评审方的 v2 设计与本清单）。不推 `main`。
- **回报**：在 `docs/agent/session-rollover-report-v2.md` 新建本轮回报（单文件不超过 20 000 字节，超出按职责分册），主回报 `session-rollover-report.md` 只加一行链接。
- **授权补充**：可以撤回 v1 已提交的 Pi 接缝与扩展代码、改写 v1 设计分册的状态说明；可以新增评测 case 并用 faux 模型干跑。**真实模型运行仍未授权**，准备好命令即停。
- **基线**：从当前分支头开始，先跑一次第 1 轮回报中的定向测试，记录结果。

## 1. 工作包

### W7. 撤回 v1 不再使用的 Pi 接缝（v2 设计第 6 节）

- 撤回 `resetContext`、`getContextThresholdEstimate`、`_inputHandlerDepth`、`phase` 字段、`reason: "rollover"`、`preparation` 可选化、runner 中 rollover 特殊分支、interactive-mode 的对应绑定，以及只为它们存在的测试与类型导出、CHANGELOG 条目。
- 保留专用前缀（`messages.ts`、`session-manager.ts` 及其测试）。`_estimateThresholdContext` 抽取保留或还原由你决定，写进决策记录。
- 验收：
  - 与 `f266b30` 相比，Pi 源码 diff 只剩前缀相关改动（以及你选择保留的估算抽取）；在回报中贴出 `git diff --stat f266b30 -- packages/rotom-pi`。
  - 现有压缩、扩展 runner、`trigger-compact-extension` 测试原样通过；前缀测试通过。
  - `cd rotom && npm run build:pi && npm run check:pi`，`node --test rotom/scripts/build-pi-fork.test.mjs`；提交重建产物，`product-config.mjs` 的 build SHA 同步。

### W8. 改写 `session-rollover` 扩展为无摘要接管（v2 设计第 2–5、7 节）

- 删除 `input` 处理器、轮末取消、`eligibility.ts` 中水位/`stale`/Goal 等 v1 资格逻辑及对应测试；保留并改造摘录工具函数。扩展目录名与 `ROTOM_SESSION_ROLLOVER=1` 开关不变。
- 新的 `session_before_compact` 处理器：只处理 `threshold` 与 `overflow`；`context_recall` 不可用、缺 `preparation` 或生成出错时返回 `undefined`；否则返回 `{ compaction: { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore, details: { kind: "rotom-rollover", version: 2 } } }`。
- `summary` 按 v2 设计第 4 节生成：检索说明（含 `@<firstKeptEntryId>`）+ 不在保留范围内的最近一条用户消息原文（上限 `reserveTokens / 4`，中间截断并标注）。`reserveTokens` 取 `preparation.settings.reserveTokens`。
- `product-config.mjs` 中仍排在 `third-party` 之前；`requiredFiles` 按实际文件更新。

### W9. 测试（v2 设计 8.2）

全部写成自动测试，沿用现有 harness（真实 `AgentSession` + faux provider）：

| 场景 | 必须证明 |
| --- | --- |
| 开关未设置 | 不注册任何处理器，原生摘要路径不变 |
| 轮内请求前越线（多工具调用的一轮） | 接管一次；摘要模型调用次数为 0（faux 只收到正常请求）；本轮继续完成；会话 ID 不变 |
| 运行结束后越线、下一次提交前越线 | 各接管一次，不重复写条目 |
| overflow（`willRetry` 为真与为假） | 接管；`willRetry` 时原请求重试且只重试一次 |
| `/compact` 与扩展请求的压缩 | 不接管，原生摘要照常 |
| 切点落在本轮中途 | 当前用户请求原文出现在 `summary` 中，标注 `@entryId` |
| 同一长轮内第二次接管 | 用户请求原文仍被带上；上一条说明没有嵌套进新条目 |
| 最近用户消息在保留范围内 | 不重复附上 |
| 超长用户请求 | 截断后不超过上限，标注截断位置 |
| 投影 | 首条为专用前缀；保留范围内的原始消息逐字可见；切走的条目在 `getBranch()` 中 |
| 检索 | 用 `context_recall` 找回切走的工具参数、工具结果与图片 |
| `context_recall` 不可用（`ROTOM_CONTEXT_LAYERS=0` 与显式工具排除两种） | 返回 `undefined`，原生摘要接管 |
| Offload 推迟 | 推迟生效，不写条目 |
| Offload 走原生 | 本扩展结果生效，无摘要调用 |
| Goal 活跃 | 接管后 Goal 续跑正常（至少一次续跑完成）；Goal 预算取消时取消生效 |
| 会话重开（`SessionManager.open`） | 投影仍为专用前缀与保留消息 |

负向对照至少三项：去掉“附上当前请求”、改用自建切点而不用 `preparation.firstKeptEntryId`、把扩展排到 `third-party` 之后。每项记录哪些用例失败。

### W10. 离线统计补充（v2 设计 8.1）

- 在 `rotom/evals/scripts/rollover-stats.mjs` 增加摘要调用统计（或新建同目录脚本，二选一并记录）：原生压缩条目数、`usage` 各字段合计、占全部助手 usage 的比例、Goal 活跃时的压缩数。`fromHook` 为真的条目单独计数、不计入摘要调用。
- 单测覆盖：有/无 `usage` 的压缩条目、`fromHook` 条目、Goal 活跃。
- 本机运行一次，聚合数字写进回报。只报 token，不换算费用。

### W11. 真实对比评测的准备（v2 设计 8.3）

- 仿照 `compaction-offload` 评测新增一个 case 与必要的 `src/` 模块：两组同任务、相同 `compaction` 设置，只切换 `ROTOM_SESSION_ROLLOVER`；任务中埋入当前上下文无法猜出的早期细节，由独立检查核验最终输出；记录请求数、时长、Provider 报告的费用与 unknown。
- 复用现有预算守卫，默认软上限与 `compaction-offload` 相同量级，写在回报中。
- 用 faux 模型干跑通过（证明 harness 本身正确，包括“检索失败时判错”的负向样例）。
- 在回报中写出真实运行的精确命令、预计请求量与预算上限，然后停止，等待用户授权。

### W12. 文档与产品合同

- CLAUDE.md 第 3 节轮转段落改为 v2：默认关闭、在原生自动压缩时以无摘要条目接管（`threshold`/`overflow`，手动 `/compact` 不接管）、保留最近原始消息、靠 `context_recall` 找回、未经真实模型验证不宣称收益。删去水位与轮间描述。
- `docs/agent/session-rollover.md` 状态与 B 的概述指向 v2；`session-rollover-rules.md`、`session-rollover-verification.md` 顶部注明“v1，已被 v2 取代”，正文不改写（作为历史记录）。阶段 0 统计报告保持原样。
- `docs/usage.md` 若提到轮转，同步为 v2。
- context footprint：v2 不增加工具，数字应不变；若变化须解释。

## 2. 终验

按第 1 轮清单 W6 的命令列表执行，另加 W9 全部用例、W10 单测、W11 干跑。`check-personal` 的既有挂起问题沿用第 1 轮的处理方式并注明。

## 3. 完成后回复

最终提交 SHA、W7–W12 状态、W10 的关键数字、W11 真实运行所需的命令与预算，以及停止或待决事项。

# 任务 12 · 召回归属与基础设施错误（零费用）

## 结论与范围

A–E 已实现并完成本地验收。没有真实模型调用，`LIVE_AUTHORIZATION` 始终为 `null`；11 的授权与收据没有复用。改动仅在 `rotom/evals/` 与本报告，没有修改材料、原 prompt、续读模板、工具面、阈值、保留区、判分、sol-pi、Pi fork 或产品版本。

本次用户另行确认了一项精确边界：**没有对应 toolResult 时，允许 `resultError=null`**。没有用 false 冒充成功，也不因缺少结果而丢掉调用记录。

起始基线为任务 12 的规划提交 `d942851`。证据保留在本机 `/tmp/rotom-offload-12.3hLVD2/`。没有生成新的真实 replay JSONL。

## A. 召回元数据

`compaction-offload-metrics.ts` 新增 `recalls`：

```ts
{ turn, offloaded, offloadIndex, resultError }
```

- turn 从 1 开始，沿用主会话 assistant 轮次；摘要请求不冒充主会话 assistant 轮。
- offloadIndex 从 1 开始，按当前分支的 `sol-pi-compaction-offload` 记录编号。仅匹配调用之前出现的记录；不因之后卸载同一 ID 而反向修改早先归属。
- index 是**卸载记录序号**，不是包含 native / defer_stale 的 decision 数组下标。defer_stale 不创建新卸载记录，不占一个编号。如果 ID 在多个先行记录中出现，归最近一次先行记录。
- 使用 toolCallId 在内存中连接对应 toolResult，读取 isError。未知/尚未返回的结果为 null；没有卸载过的 ID 为 offloaded=false、offloadIndex=null。
- 只输出这四项。ID、参数、工具正文、错误正文均不进入新增字段。

`resultError=false` 只证明工具结果标记为非错误，不证明取回内容完整，也不替代任务 grader 的精确匹配。

### Faux 证明

实际产品 Pi + 脚本 faux provider 跑两次真实卸载，然后调用三个真实 obs_recall：

| 调用 | offloaded | offloadIndex | resultError |
| --- | --- | --- | --- |
| 第一批 ID | true | 1 | false |
| 第二批 ID | true | 2 | false |
| 未卸载、无对应存储的 ID | false | null | true |

该 faux 轨迹 deferred=2、coverageNudges=0，任务正确。为形成第二批，它仅在**测试专用脚本选项**下额外读取既有文件，没有增加材料或改变原 scenario。默认脚本不启用该选项。

另有合成分支检查调用早于卸载、结果未返回，以及两个不同批次的匹配。完整输出不含测试里的 ID、参数或正文哨兵。原有正常产品 faux 轨迹也验证实际召回记录 resultError=false。

## B. 错误类别

assistant 的 stopReason 为 error / aborted 时，新增：

```ts
errors: [{ turn, stopReason, category }]
```

category 只有七种：timeout、connection、rate_limit、http_4xx、http_5xx、stream_terminated、other。匹配发生在内存中，不保留原文；不增加模型分类调用或依赖。

优先识别 timeout 和 rate limit，其次 HTTP 状态、流终止、连接错误，余者为 other。支持 HTTP/status 前缀和以状态码开头的常见错误。预算包装层生成的 `Replay stream failed` 归入 stream_terminated。

合成错误覆盖全部类别、other、error/aborted 两种 stopReason；断言导出指标没有原文。这里是有限规则的诊断分类，不是底层故障根因认证。它只处理分支中的 assistant 消息，不伪造没有落入该分支的摘要错误消息。

## C. 悲观输入预算与不可用样本

### 一次请求，一次记账

`ReplayBudget` 对未完整结束、缺失/非法 usage 或输入合计为 0 的请求：

1. 取该次请求实际 model.contextWindow，计入 input。
2. 用这个窗口替换该请求不完整的 input/cacheRead/cacheWrite，不再叠加那些部分输入，避免重复估算。
3. `usageKnown=false`，`pessimisticRequests += 1`；不再触发 usage-unknown 停止。
4. output 没有同类上界，只累计已经报告的有效非负值。
5. 计费后立即检查输入线；下一请求仍须重新准入。窗口缺失/非法时在 dispatch 前以 run-error 停止，不猜一个默认窗口。

这是**预算估算**，不是 provider 实际账单。原有 SSE、maxRetries=0、共享请求上限及摘要请求记账均保留。历史 reason 类型仍可表示旧行的 usage-unknown，但当前记账逻辑不再发出这个停止原因。

summary 新增 `inputAccounting="reported-or-context-window"`、`outputAccounting="reported-subtotal"`，并输出完整 cumulative（含 pessimisticRequests）。因此 input 可能含悲观估算；output 始终是**已记录小计**，不能当作输出硬上界或完整费用。

一次未知后，campaign 的 usageKnown 保持 false；但后续没有未知请求的运行，其 metrics.usageComplete 可以恢复 true。使用每次运行前后的 pessimisticRequests 差值，避免把后续所有运行都错误标成失败。

### provider 错误与 harness 异常的边界

不靠错误正文猜异常归属。只有同时满足以下条件，失败运行才记为 failed / provider-error：

- 本次运行预算包装层确实观察到 provider error 事件或无终止帧的流异常；
- harness 读取到未正常结束的持久化 assistant 回复，抛出专门的 `IncompleteAssistantResponseError`；
- 不是调用方 signal 取消。

新增的 Error 子类只区分失败来源；其它 eval 的抛错文本和失败行为不变。setup、grading、cleanup 等不具有该标记的异常仍立即 run-error。特别测试了「provider 出错，同时 cleanup 又异常」：AggregateError 仍按 harness 故障立即停止，不被降为可以继续的 provider-error。

已收到 terminal 后若 adapter 清理再抛错，按 run-error 停止，不重复计入一个窗口。未知输入和硬上限不能因错误来源分类而绕过。

### 继续与停止

| 情况 | 行结果 | campaign |
| --- | --- | --- |
| provider 请求错误导致未完成 | failed / provider-error | 计入不可用数；尚未到 3 且未到其它停止线时继续下一计划位置 |
| 未达阈值 | invalid / threshold-not-reached | 同样计入不可用数 |
| 累计第三个不可用样本 | 保留该次行原因 | 用最后一次的原因停止；中间有效运行不清零 |
| 悲观输入达到上限 | provider-error 行保留其失败原因 | cumulative.stopReason=input-limit，立即停止 |
| run-error、model-mismatch、decision-ledger-incomplete、persistence-error、原预算线 | 保留原即时停止路径 | 不等待三个不可用样本 |

provider-error 的行原因与 campaign 停止原因可以不同，例如一次错误既导致失败又触发 input-limit。CLI 以 cumulative.stopReason 决定是否停止，不因行原因仍为 provider-error 而漏掉硬上限。

`--bail=1` 入口把停止前的 provider-error 与 invalid 一样记为 skipped，不计为任务成功；第三个或其它停止原因仍失败并触发 bail。没有自动重试、补跑、替换样本或增加 repetition。成功率仍只比较两臂都 completed 的有效配对，错误任务答案不从分母中删除。

summary 同时列出 invalidRuns、providerErrorRuns、unusableRuns；停止后的 not-run 不计入不可用样本数。原始已执行指标仍通过 rawRuns 和私有逐行记录保留。

### 可运行证据

- `provider-error → completed → provider-error → invalid`：第四个位置以 threshold-not-reached 停止。
- `provider-error → completed → invalid → provider-error`：第四个位置以 provider-error 停止。
- 两者都只有三个不可用样本；其后一次调用是 not-run，factory 与请求数均不增加。持久化行与返回值逐项一致，错误正文没有写入日志。
- 首个错误按 faux 模型的 256,000 窗口计入 input、pessimisticRequests=1；中间有效运行仍 completed、usageComplete=true，但累计 usageKnown=false。
- 输入线恰设为 256,000 时，首次错误即触发 input-limit，不能等到第三个样本。
- partial input/cache 被窗口替代，已报告 output=7 保留；terminal 后 adapter 异常不重复计费。
- 真实 Vitest 子进程的零模型 fixture：provider-error(skipped) → completed(passed) → invalid(skipped) → provider-error(failed)，后续 14 个 pending，执行计数恰为 4。

## D. 按任务授权

`ReplayAuthorization.tasks` 为可选 string[]：

- 设置后，`ROTOM_EVAL_COMPACTION_OFFLOAD_TASKS` 必须等于 `tasks.join(",")`；不 trim、不重排、不默认补全。
- 未设置 tasks 时，仍跑全部任务，而且该环境变量必须不存在（空字符串也不接受）。
- 空列表、重复条目、含分隔符的条目和未知任务均拒绝；入口在构建 campaign 之前校验。直接构建不在授权列表内的 harness 也拒绝。
- 选中任务保持 REPLAY_TASKS 的原顺序；每个任务仍按 repetition 奇偶交替两臂。授权列表与环境的顺序必须一致，但不会借授权列表改变原执行顺序。

测试覆盖单选 multi-file-fix 仅注册 6 次、两任务筛选仍按原顺序、缺环境、不匹配、逆序、无 tasks 却设置环境以及未知任务；拒绝时 campaign factory 未调用。默认全任务的 18 次注册与交替规则仍通过。

这不是新授权：本次常量为 null，没有把下面的预算建议写成可运行授权。

## E. 只跑 multi-file-fix、N=3 的费用规划

读取 11 的 12 次完整运行元数据，按累计请求差分计算；不使用第 13 次未知用量失败样本来估计完整运行成本。实际请求最小值为 **12**，而不是把任务概述里的约 13 当作精确下界。

| 依据 | 最小 | 均值 | 最大 |
| --- | ---: | ---: | ---: |
| 每次完整运行请求（含摘要） | 12 | 20.25 | 29 |
| 合计输入（input+cacheRead+cacheWrite） | 230656 | 544909.583 | 796215 |

下面都是工作量情景，不是统计置信区间、严格最坏界或美元报价。11 没有完整 multi-file-fix 样本，因此不能声称已测得该任务成本。

| 6 次运行情景 | 请求 | 合计输入预算量 |
| --- | ---: | ---: |
| 完整运行范围的直接外推 | 72–174 | 1383936–4777290 |
| 按完整运行均值外推 | 121.5 | 3269457.5 |
| 均值外推另加一次未知请求（272K） | 122.5 | 3541457.5 |
| 上端另加一次未知请求 | 175 | 5049290 |
| 再为每次任务的三处修改各留一个额外请求，且均按满窗口算 | 193 | 9945290 |
| 上行情景再加 25% 人为余量 | 242（向上取整） | 12431613（向上取整） |

**建议下一份单任务授权使用 250 次请求 / 15,000,000 合计输入停止线。** 这明显小于上次全任务的 3,000 / 140M；不在本次启用或改变已有授权。

一次未知请求的 272,000 来自 11 实测模型目录的 contextWindow。若其中已有部分输入，它会被窗口替代，不是部分值再加窗口。表里的“额外一次”是对六次原计划工作量的保守开销估计，不授权第七次运行；实际失败样本仍占原位置且不补跑。

三处修改可能在同一回复中批量完成，不必真多出三个请求；这里明确预留最保守的分开请求开销。输出没有上界，只能记**已记录小计**，所以这些数不是总费用上限，美元费用 unknown。模型窗口变化、转为逐份单请求或大量重读时，这个规划也不能保证跑完；应先更新规划并重新授权，不在运行中放宽停止线。

## 验证与自审

Node v24.18.0、Vitest 4.1.9；产品集成测试使用仓内 Pi 1.4.0-rotom.2，而不是 eval 的旧开发依赖作为运行时。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| compaction-offload-eval 专项 | 21/21 | focused.log |
| 要求的五文件 + 新增 infra、infra-metadata | 60/60 | acceptance.log |
| 产品 Pi 的 npm test | 179 passed / 1 既有 skip，22 文件 | full-test.log |
| npm run typecheck | PASS | typecheck-final.log |
| 强制所有命中归第一批 | 2 个召回测试按预期失败，已恢复 | negative-recall.log |
| 恢复首次未知就 halt | 2 个累计不可用测试按预期失败，已恢复 | negative-budget.log |
| 去掉 tasks 与环境逐项匹配 | 3 个入口拒绝测试按预期失败，已恢复 | negative-tasks.log |
| diff --check 与 staged 20,000-byte 门禁 | PASS，无豁免 | 本地检查 |
| tracked-tree 公开扫描 | PASS，7,841 项、0 finding | audit-tree.json |
| tree+history 公开扫描 | BLOCKED，仅既有已接受的 12 条身份 finding，0 新增 | audit-history.json |

历史扫描并非全绿：六个旧 commit 的 author/committer 各一条 non-noreply finding，digest 均为 cd29c5ac348a；没有修改扫描规则或扩大例外。暂存范围为 13 个任务文件，fixture/prompt/LIVE_AUTHORIZATION 所在的 compaction-offload-cases.ts 与起始基线逐字节相同。

所有负对照恢复后跑了全量测试。唯一 skip 仍是未配置 ROTOM_TEST_SIDECAR 的既有条件测试。正常 1/10/20-read 轨迹的请求黄金值、两臂工具/提示一致性以及原请求、输入、摘要、持久化门禁继续通过；并未为了新行为削弱其它错误的即时停止。

自审检查了跨运行 usageKnown 污染、停止后 not-run 误入不可用计数、硬预算优先于继续、provider 与 cleanup 错误同时发生、缺结果不冒充成功、原始文本不进入新增指标、任务范围在 dispatch 前拒绝，以及默认 faux 轨迹未改变。

本轮证明本地控制流与真实产品的 faux 集成；不宣称已证明真实 provider 的故障恢复或新预算一定跑完。11 的丢失证据无法补回，本次也没有尝试补跑。

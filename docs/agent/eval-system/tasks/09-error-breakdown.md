# 任务 09 · 工具出错与 provider 出错拆解（不需要标注）

阶段：Phase 2。模型调用：**无**。报告写到 `docs/agent/eval-system/reports/09-error-breakdown.md`。

## 背景

bob 已标注 44 张卡片：40 pass / 4 fail。fail 原因（已脱敏）：「出错太多」×2、「工具错误较多」×1、「涉及 UI 的地方没先出设计稿就直接改」×1。
4 个里 3 个指向「过程中工具出错多」，和任务 08 的统计一致：工具总出错率 7.5%，12.7% 的会话以 provider 错误结束。
fail 还太少，做不了 judge；但这两个问题都能**只靠 trace metadata** 拆开看，先找出最大的出错来源，再决定修什么。

## 交付物

| 文件 | 说明 |
|---|---|
| `rotom/evals/scripts/error-breakdown.mjs` + `.d.mts` | 纯函数 `toolErrorRows(traceRecords)`、`providerErrorRows(traceRecords)`、`aggregateBreakdown(rows)`；不读文件 |
| `rotom/evals/scripts/session-cards.mjs` | 新增子命令 `breakdown [--root] [--since 28d] [--out <cards dir>]`，复用现有会话/trace 读取与 500 上限 |
| `rotom/evals/test/error-breakdown.test.ts` | 合成 trace 单测 |
| `.github/workflows/evals-l1.yml` | 测试过滤词加 `error-breakdown` |
| `rotom/evals/README.md` | 补 3 行以内用法 |

## 只用这些 trace 属性

工具（`pi.tool.execute` span_end）：`pi.tool.name`、`pi.tool.outcome`、`pi.tool.fault_side`、`pi.tool.error_code`、`pi.tool.exit_code`、`pi.tool.capability_group`。

provider（`pi.ai.*` 请求 span，以执行者核实的实际 span 名为准，报告写明）：`pi.ai.provider`、`pi.ai.model`、`pi.ai.error.category`、`pi.ai.error.http_status`、`pi.ai.qoder.error_code`、`pi.ai.qoder.transport_phase`、`pi.ai.request.end_reason`、`pi.ai.response.stop_reason`。

**不读** session 里的工具结果正文、`errorMessage` 或任何 content；不改 trace 合同。属性缺失记为 `(none)`，不要猜。

## 输出

1. **工具出错表**：按 `pi.tool.name` 分组 —— 已结束 span 数、出错数（outcome 不是 `ok`）、出错率、占全部出错的比例；每个工具再列 outcome × fault_side × error_code 的前 5 个组合及计数。按出错数降序。
2. **工具出错集中度**：出错最多的前 10% 会话贡献了多少比例的出错（看是普遍问题还是少数会话失控）。
3. **provider 出错表**：先区分「请求出错」与「会话以 provider 错误结束」（沿用任务 03 规则）。按 `provider/model` × `error.category` 分组计数，附 `http_status`、`qoder.error_code`、`transport_phase` 的前 5 个值。注明每个会话以 provider 错误结束前，同一 run 内是否已有重试（同 run 中 provider 出错请求数 ≥ 2）。
4. 每个统计附样本数 n；n < 10 标 `*`。
5. stdout 只输出聚合 JSON，不含 session id。私有文件写 `<out>/../breakdown.md`（0600，Git 工作树外），额外列出两类各前 10 个会话的 session id，方便回卡片看。

## 单测至少覆盖

各分组计数和排序；属性缺失 → `(none)`；outcome `aborted` 的处理（单独列出，不算 harness 出错也不丢掉）；集中度在 n=0、1、全部相同时的结果；provider 重试判定；stdout 不含 session id；私有文件权限与 Git 工作树检查。

## 验收命令

同任务 08，定向测试加 `test/error-breakdown.test.ts`。推送后确认 Actions 是绿的，报告附运行链接。

## 真实数据

运行 `breakdown --since 28d`，报告只写聚合数字（工具名、模型名、错误类别可以写；session id、路径、内容不写）。最后用 3 到 5 句话写**最大的两个出错来源**及其占比，只陈述数字，不提修复方案。

## 不在本任务范围

修复任何工具或 provider、改重试策略、改规则阈值、LLM、标注。

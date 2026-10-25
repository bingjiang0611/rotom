# 任务 08 · 每周效率统计 + 只挑可疑会话补标

阶段：Phase 2。模型调用：**无**。报告写到 `docs/agent/eval-system/reports/08-efficiency-stats.md`。

## 背景

bob 标了 27 张卡片：25 张满意，2 张不满意，其中一条原因是「出错太多」。失败太少，做不了失败分类，也验证不了 judge。bob 选择的方向（2026-10-25）是：

1. 先做**不需要标注**的效率统计，按周看过程有多折腾；
2. 再让 `build` 只挑可疑会话，bob 针对这些会话补标约 20 张。

## 交付物

| 文件 | 说明 |
|---|---|
| `rotom/evals/scripts/session-metrics.mjs` + `.d.mts` | 纯函数 `sessionMetrics({ header, branch, traceTools, traceStatus, findings })` 和 `aggregateMetrics(rows)`；不读文件 |
| `rotom/evals/scripts/session-cards.mjs` | 新增子命令 `stats`；`build` 新增 `--focus` |
| `rotom/evals/test/session-metrics.test.ts` | 合成数据单测 |
| `rotom/evals/test/session-cards.test.ts` | 补 `stats` 和 `--focus` 的集成用例 |
| `.github/workflows/evals-l1.yml` | 测试过滤词加 `session-metrics` |
| `rotom/evals/README.md`、`docs/agent/eval-system/tasks/02-label-sessions.md` | 补用法；任务 02 加一节「定向补标」 |

`sessionMetrics` 复用 `build` 已有的读取、分支回溯和 trace 关联逻辑，不要另写一套解析。

## 单个会话的指标

所有指标拿不到时都记 `null`，不要用 0 代替：

| 字段 | 定义 |
|---|---|
| `startedAt`、`week` | header.timestamp；`week` 用 ISO 周，例如 `2026-W43` |
| `durationMs` | 当前分支首末 entry 的时间差 |
| `models` | 当前分支出现的 `provider/model` 列表 |
| `assistantTurns`、`toolCalls` | 计数 |
| `toolErrors` | trace 中已结束、outcome 不是 `ok` 的工具 span 数；trace 缺失时为 null |
| `toolErrorRate` | `toolErrors / 已结束的工具 span 数`；分母为 0 或 trace 缺失时为 null |
| `tokens` | assistant usage 的 `input`、`output`、`cacheRead`、`cacheWrite` 求和 |
| `costUsd` | assistant `usage.cost.total` 求和；任何一条缺失时记 null，并另记 `costPartial: true`，不要按部分求和冒充总数 |
| `oversizedResults` | 沿用任务 03 的阈值 |
| `endedWithoutFinalText` | 最后一条 assistant 没有文本（卡片上显示「无文本」的情况） |
| `endedOnProviderError` | 沿用任务 03 的规则结果 |
| `ruleHits` | 任务 03 各规则中为 hit 的 id 列表 |

## `stats` 子命令

```sh
node rotom/evals/scripts/session-cards.mjs stats [--root <sessions>] [--since 28d] [--out <cards dir>]
```

- 默认 `--since 28d`，会话上限沿用 500。
- 按 ISO 周汇总，每周输出：会话数；`toolCalls`、`durationMs`、`tokens.input + tokens.output` 的中位数和 p90；**总**工具出错率（各会话 `toolErrors` 之和除以已结束 span 之和，不是各会话比率的平均）；`endedWithoutFinalText`、`endedOnProviderError` 和每条规则 hit 的会话占比；`costUsd` 合计（有 partial 时标出来）。null 不参与计算，每个统计都要附带样本数 n。
- 再按 `provider/model` 汇总一张同样的表（不分周）。
- stdout：只输出聚合 JSON，**不含** session id。
- 私有文件（`0600`，路径同样要求在 Git 工作树外）：
  - `<out>/../stats.md`：周表、模型表，以及工具出错数最多的 10 个会话（session id、开始时间、toolCalls、toolErrors、toolErrorRate），方便回到卡片里看；
  - `<out>/../stats.jsonl`：每个会话一行指标，供以后对比。

## `build --focus`

只为「可疑」会话生成卡片，满足任一条件即可：

- `toolErrors ≥ 5` 且 `toolErrorRate ≥ 0.10`
- 任一规则 hit
- `endedWithoutFinalText` 为 true
- `endedOnProviderError` 为 true

阈值写成具名常量。`--limit` 表示最多生成的卡片数，不是扫描的会话数；扫描上限沿用 500。summary 新增 `focusScanned`、`focusMatched` 和各条件的命中计数。已经有 verdict 的卡片照旧保留标注，`review` 也照旧只问未标注的卡片，所以 bob 直接运行 `build --focus --limit 40` 再运行 `review` 就行。

## 单测至少覆盖

- 每个指标的正常值和 null 的情况；`costPartial`；总出错率按 span 加总，而不是平均各会话比率。
- ISO 周跨年边界（例如 2026-12-31 和 2027-01-01）。
- 中位数和 p90 在 n = 0、1、偶数时的结果。
- `--focus` 每个条件单独命中、都不命中，以及 limit 的语义。
- stdout 不含 session id；私有文件的权限和 Git 工作树检查。

## 验收命令

同任务 04，定向测试加上 `test/session-metrics.test.ts`。推送后确认 Actions 是绿的，报告附运行链接。

## 真实数据

1. 运行 `stats --since 28d`，报告里写出周表和模型表的数字（只写聚合数字，不写 id）。
2. 运行 `build --focus --limit 40 --out <仓库外临时目录>`，报告里写 `focusScanned`、`focusMatched` 和各条件的命中计数。**不要**运行 `review`，也不要替 bob 标注。

## 不在本任务范围

LLM judge、图表或网页、自动告警、修改 trace 合同、改动规则条件。

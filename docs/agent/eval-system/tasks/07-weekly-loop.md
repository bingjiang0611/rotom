# 任务 07 · 每周闭环：一条命令出周报，并挑 10 张卡片给 bob

阶段：Phase 4。模型调用：**无**。报告写到 `docs/agent/eval-system/reports/07-weekly-loop.md`。

## 背景

任务 08–11 已经能从本机会话和 trace 算出效率、出错、edit 原因码、原地打转。结论是：工具出错多数不是打转，也不等于 bob 不满意（40 个 pass 里也有大量出错）。
真正缺的是**稳定积累人工判断**：fail 只有 4 个，做 LLM judge 需要约 20 个。所以这一步把已有能力串成每周一次的固定动作：

1. 一条命令生成本周周报，并和上周对比；
2. 同时挑出约 10 张本周未标注的卡片，bob 每周用 `review` 花几分钟答完。

## 交付物

| 文件 | 说明 |
|---|---|
| `rotom/evals/scripts/weekly.mjs` + `.d.mts` | 纯函数：`compareWeeks(current, previous)`、`pickWeeklySample(rows, { week, size })`、`renderWeeklyMarkdown(...)` |
| `rotom/evals/scripts/session-cards.mjs` | 新增子命令 `weekly [--root] [--out <cards dir>] [--week 2026-W43] [--sample 10]`，复用 `sessionStats`、`errorBreakdown`、`buildCards` 的读取与写卡逻辑，不另写解析 |
| `rotom/evals/test/weekly.test.ts` | 合成数据单测 |
| `.github/workflows/evals-l1.yml` | 测试过滤词加 `weekly` |
| `rotom/evals/README.md`、`docs/agent/eval-system/tasks/02-label-sessions.md` | 补用法；任务 02 加一节「每周固定动作」 |

## 周报内容

`--week` 默认是**上一个完整的 ISO 周**（UTC），对比它的前一周。写到私有文件 `<out>/../weekly/<week>.md`（目录 0700、文件 0600、Git 工作树外）。

1. **核心指标，本周 vs 上周**，每项都带 n 和变化值；n < 10 标 `*`，null 显示 `n/a`，不画趋势结论：
   - 会话数；工具总出错率；以 provider 错误结束的会话占比；最终回复无文本占比；
   - 真正的 edit 失败数及按原因码的分布（沿用任务 10 口径，then_run 失败单列）；
   - 打转会话数及其贡献的工具失败占比（沿用任务 11）；
   - 成本合计（有 partial 时照旧标出）。
2. **标注进度**：本周会话里已标注的 pass / fail 数；累计 pass / fail 数；离 judge 所需的 20 个 fail 还差多少。
3. **本周 bob 写的 fail 原因**：从卡片标注块读 note，原样列出（这是私有文件，可以写；stdout 不输出）。
4. **本周抽样**：列出本次生成卡片的 session id 和被选中的原因（可疑 / 随机）。

stdout：只输出聚合 JSON（第 1、2 部分的数字和抽样计数），不含 session id、note 或任何会话内容。

## 抽样规则（重要）

如果只挑可疑会话，fail 率会被高估，以后验证 judge 也会有偏差。所以每周 `--sample N`（默认 10）张未标注卡片按下面的规则挑：

- 一半（向上取整）来自**可疑**会话：沿用 `focusCandidate`，以及任务 11 的打转会话；优先打转，其次按工具出错数降序。
- 另一半来自**其它**会话，按 `sha256(week + sessionId)` 排序取前几个，保证同一周重复运行结果相同、不可人为挑选。
- 任一侧不够时由另一侧补足；本周未标注会话总数不足 N 时全部选上。
- 已有 verdict 的会话不选。卡片里写一个字段 `sample: focus|random`（frontmatter），`labels` 汇总时带上这个字段，以后算 fail 率可以只用 random 部分。

卡片写到同一个 cards 目录，已有标注照旧保留，所以 bob 跑完 `weekly` 后直接 `review --limit 10` 就行。

## 约束

- 不改 trace 合同、不改产品代码、不调模型。
- 不安装定时任务。README 里可以给出一行可选的本机 cron/launchd 写法，但不替用户装。
- 已有子命令的输出格式保持兼容；`labels.jsonl` 新增的 `sample` 字段对旧卡片为 null。

## 单测至少覆盖

默认周的计算（含跨年 W52/W53 → W01）；`compareWeeks` 在上周无数据、n = 0、null 时的结果；抽样：一半一半、某侧不足的补足、总数不足、已标注排除、同一周重复运行结果一致、不同周结果不同；`sample` 字段写入卡片且 `labels` 带出、旧卡片为 null；stdout 不含 session id 和 note；私有文件权限和 Git 工作树检查。

## 验收命令

同任务 11 的 eval 部分。推送后 Actions 要绿，报告附运行链接。

## 真实数据

运行 `weekly`（默认上一个完整周），报告只写 stdout 的聚合数字和抽样计数（focus 几张、random 几张）。**不要**运行 `review`，也不要替 bob 标注。

## 不在本任务范围

LLM judge、自动告警、网页或图表、定时任务安装、改规则阈值、修复任何工具。

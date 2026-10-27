# 任务 06 · 第二次付费回放

前置：任务 05 已 accepted（`ebb5aa6`，核验 `fa4ac99`）。回放入口、熔断与落盘沿用 04b/05 的实现。报告写到 `docs/agent/compaction/reports/06-second-replay.md`。

## 授权记录

bob 于 2026-10-26 06:18 UTC 在项目线程的决策卡上选择「授权，按此配置跑」。卡片写明的配置即为授权范围：

| 项 | 授权值 |
|---|---|
| provider / model | `openai-codex` / `gpt-5.6-luna` |
| thinking | `low` |
| N（每臂每任务重复次数） | 3（3 任务 × 2 臂 × 3 = 18 次运行） |
| 请求数上限 | 2,000 次 provider 请求（含压缩摘要请求） |
| 输入 token 上限 | 100,000,000（input + cacheRead + cacheWrite 合计） |
| 停止规则 | 任一上限先到即停；任务 05 新增的「未到阈值」「缺决定记录」熔断照常生效；剩余运行标 `not-run` |

只授权这一次完整执行。中途因任何原因停下后，重跑或补跑需要 bob 另行确认。不授权换模型、提高 N 或放宽上限。

## 执行步骤

1. 把 `rotom/evals/src/compaction-offload-cases.ts` 的 `LIVE_AUTHORIZATION` 按上表填入，`id` 用本文件所在提交（规划者推送的授权提交）的完整 SHA。只改这一个常量，跑 live/entry 专项确认门禁通过，提交并推送。
2. 工作树干净后，在 bob 本机、已登录 `openai-codex`、Node ≥ 24，按 04b 开跑说明的环境变量真实运行**一次**（`ROTOM_EVAL_COMPACTION_OFFLOAD=1`、`ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE=1`、`ROTOM_EVAL_PROVIDER=openai-codex`、`ROTOM_EVAL_MODEL=gpt-5.6-luna`、`ROTOM_EVAL_THINKING=low`、`ROTOM_EVAL_REPETITIONS=3`）。
3. 跑完把 `LIVE_AUTHORIZATION` 置回 `null`（授权已消费），与报告一起提交。

## 报告内容

与 04b 结果同样的每次运行表和按臂汇总，另加：

- 每次 candidate 运行的 `offloadDecisions`（决定类型、`native` 原因、before / after / T、候选数）。
- 按臂：触发阈值的运行数、原生压缩总数、推迟总数、`compactionWaitMs` 均值与中位数（只算触发了阈值的运行，另列包含 0 值的版本）、`wallMs` 均值、`obsRecallCalls` 与 `recalledOffloaded` 均值、四项 token 均值、成功率。
- 累计请求与 token、是否熔断及原因、实际 contextWindow / reserveTokens / keepRecentTokens、源码 commit。
- 不写任何模型输出正文，不提交 JSONL。样本小，不做显著性结论。

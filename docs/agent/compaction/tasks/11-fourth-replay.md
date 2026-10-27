# 任务 11 · 第四次付费回放

前置：任务 10 已 accepted（`41a00c0`，核验 `e39dbb7`）。回放入口、熔断、落盘、续读提示与无效样本规则沿用 07–10 的实现；fixture 为 08 的 3 KiB × 120 份，工具面 `read/edit/write/obs_recall`，回放内 Action Fusion 关闭。报告写到 `docs/agent/compaction/reports/11-fourth-replay.md`。

## 授权记录

bob 于 2026-10-26 14:25 UTC 在项目线程的决策卡上选择「授权，按此配置跑」。卡片写明的配置即为授权范围：

| 项 | 授权值 |
|---|---|
| provider / model | `openai-codex` / `gpt-5.6-luna` |
| thinking | `low` |
| N（每臂每任务重复次数） | 3（3 任务 × 2 臂 × 3 = 18 次运行） |
| 请求数上限 | 3,000 次 provider 请求（含压缩摘要请求） |
| 输入 token 上限 | 140,000,000（input + cacheRead + cacheWrite 合计） |
| 停止规则 | 任一上限先到即停；未达阈值记为无效样本，累计 3 次无效才熔断；`decision-ledger-incomplete` 等其它熔断立即停；剩余运行标 `not-run` |

只授权这一次完整执行。中途因任何原因停下后，重跑或补跑需要 bob 另行确认。不授权换模型、提高 N、放宽上限，也不授权修改 fixture、prompt、续读模板、工具面、阈值或熔断规则。06、09 的授权已消费，不得复用。

## 执行步骤

1. 把 `rotom/evals/src/compaction-offload-cases.ts` 的 `LIVE_AUTHORIZATION` 按上表填入，`id` 用本文件所在提交（规划者推送的授权提交）的完整 SHA。只改这一个常量，跑 live/entry/metadata/read/coverage 专项确认门禁通过，提交并推送。
2. 工作树干净后，在 bob 本机、已登录 `openai-codex`、Node ≥ 24、指定仓内产品 Pi，用以下环境变量真实运行**一次**：`ROTOM_EVAL_COMPACTION_OFFLOAD=1`、`ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE=1`、`ROTOM_EVAL_PROVIDER=openai-codex`、`ROTOM_EVAL_MODEL=gpt-5.6-luna`、`ROTOM_EVAL_THINKING=low`、`ROTOM_EVAL_REPETITIONS=3`。命令同 09（`npm run eval -- cases/compaction-offload.eval.ts --bail=1`）。
3. 跑完把 `LIVE_AUTHORIZATION` 置回 `null`（授权已消费），与报告一起提交。

## 报告内容

与 09 报告同样的每次运行表、轨迹元数据（含 `coverageNudges`）、`offloadDecisions` 表和累计预算，另加：

- `compactionOffloadPairedSummary` 的有效配对数、无效样本数，以及**只基于有效配对**的按臂汇总：任务成功率、阈值次数、原生压缩与推迟次数、`compactionWaitMs`（均值/中位，含 0 与仅触发两版）、`obsRecallCalls` 与 `recalledOffloaded`、四项 token、`wallMs`。
- 每个有效配对的逐对差值（candidate − baseline）：等待时间、请求数、合计输入、wallMs、任务是否都对。
- candidate 每次 `defer` 后模型是否用 `obs_recall` 取回了被卸载的结果，以及 `deferred-exact` 任务的精确匹配情况。
- 不写任何模型输出正文，不提交 JSONL。样本小，不做显著性结论。

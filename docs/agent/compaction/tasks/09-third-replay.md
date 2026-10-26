# 任务 09 · 第三次付费回放

前置：任务 07（`9c93646`）、08（`d372a40`）已 accepted，核验提交 `3eb68ed`。回放入口、熔断与落盘沿用 04b/05/07/08 的实现，fixture 为 08 的 3 KiB × 120 份，工具面为 `read/edit/write/obs_recall`，回放内 Action Fusion 关闭。报告写到 `docs/agent/compaction/reports/09-third-replay.md`。

## 授权记录

bob 于 2026-10-26 11:04 UTC 在项目线程的决策卡上选择「3,000 次 / 1.4 亿 token」。卡片写明的配置即为授权范围：

| 项 | 授权值 |
|---|---|
| provider / model | `openai-codex` / `gpt-5.6-luna` |
| thinking | `low` |
| N（每臂每任务重复次数） | 3（3 任务 × 2 臂 × 3 = 18 次运行） |
| 请求数上限 | 3,000 次 provider 请求（含压缩摘要请求） |
| 输入 token 上限 | 140,000,000（input + cacheRead + cacheWrite 合计） |
| 停止规则 | 任一上限先到即停；「未到阈值」「缺决定记录」熔断照常生效；剩余运行标 `not-run` |

只授权这一次完整执行。中途因任何原因停下后，重跑或补跑需要 bob 另行确认。不授权换模型、提高 N、放宽上限，也不授权修改 fixture、prompt、工具面、阈值或熔断规则。06 的授权 `bb57fe6…` 已消费，不得复用。

## 执行步骤

1. 把 `rotom/evals/src/compaction-offload-cases.ts` 的 `LIVE_AUTHORIZATION` 按上表填入，`id` 用本文件所在提交（规划者推送的授权提交）的完整 SHA。只改这一个常量（如测试仍需按 06 的方式显式传 `null`，沿用即可），跑 live/entry 专项确认门禁通过，提交并推送。
2. 工作树干净后，在 bob 本机、已登录 `openai-codex`、Node ≥ 24、指定仓内产品 Pi，用以下环境变量真实运行**一次**：`ROTOM_EVAL_COMPACTION_OFFLOAD=1`、`ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE=1`、`ROTOM_EVAL_PROVIDER=openai-codex`、`ROTOM_EVAL_MODEL=gpt-5.6-luna`、`ROTOM_EVAL_THINKING=low`、`ROTOM_EVAL_REPETITIONS=3`。命令同 06（`npm run eval -- cases/compaction-offload.eval.ts --bail=1`）。
3. 跑完把 `LIVE_AUTHORIZATION` 置回 `null`（授权已消费），与报告一起提交。

## 报告内容

与 06 报告同样的每次运行表、`offloadDecisions` 表、按臂汇总和累计预算，另加 07 新增的轨迹元数据：

- 每次运行的 `toolNames`、`phase1Coverage`（分子/分母、`partialReads`）、`contextPeak`；`contextByTurn` 只写进私有 JSONL，报告给每次运行的轮数和峰值即可。
- 每次运行第一阶段每轮的 `read` 并发数分布（最小 / 中位 / 最大），用来对照 08 的 1/10/20 三种 faux 轨迹。
- 若再次熔断：写明停在哪次、覆盖率和上下文峰值，从元数据判断是偷懒、部分读还是机制问题；不要自行补跑。
- 不写任何模型输出正文，不提交 JSONL。样本小，不做显著性结论。

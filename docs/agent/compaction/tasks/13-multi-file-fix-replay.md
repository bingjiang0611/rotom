# 任务 13 · 只跑 multi-file-fix 的小回放

前置：任务 12 已 accepted（`aae712e`，核验 `b334080`）。回放入口、熔断、落盘、续读提示、不可用样本、悲观计费与按任务授权沿用 07–12 的实现；fixture 为 08 的 3 KiB 材料，工具面 `read/edit/write/obs_recall`，回放内 Action Fusion 关闭。报告写到 `docs/agent/compaction/reports/13-multi-file-fix-replay.md`。

## 授权记录

bob 于 2026-10-27 02:56 UTC 在项目线程的决策卡上选择「800 次 / 4,000 万 token」。卡片写明的配置即为授权范围：

| 项 | 授权值 |
|---|---|
| provider / model | `openai-codex` / `gpt-5.6-luna` |
| thinking | `low` |
| tasks | `["multi-file-fix"]` |
| N（每臂重复次数） | 3（1 任务 × 2 臂 × 3 = 6 次运行） |
| 请求数上限 | 800 次 provider 请求（含压缩摘要请求） |
| 输入 token 上限 | 40,000,000（input + cacheRead + cacheWrite 合计，未知用量按 contextWindow 悲观计入） |
| 停止规则 | 任一上限先到即停；`invalid` 与 `provider-error` 合计 3 次熔断；其它熔断立即停；剩余运行标 `not-run` |

只授权这一次完整执行。中途因任何原因停下后，重跑或补跑需要 bob 另行确认。不授权换模型或任务、提高 N、放宽上限，也不授权修改 fixture、prompt、续读模板、工具面、阈值或熔断规则。06、09、11 的授权已消费，不得复用。

## 执行步骤

1. 把 `rotom/evals/src/compaction-offload-cases.ts` 的 `LIVE_AUTHORIZATION` 按上表填入（含 `tasks`），`id` 用本文件所在提交（规划者推送的授权提交）的完整 SHA。只改这一个常量，跑任务 12 的七个零费用专项确认门禁通过，提交并推送。
2. 工作树干净后，在 bob 本机、已登录 `openai-codex`、Node ≥ 24、指定仓内产品 Pi，用以下环境变量真实运行**一次**：`ROTOM_EVAL_COMPACTION_OFFLOAD=1`、`ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE=1`、`ROTOM_EVAL_PROVIDER=openai-codex`、`ROTOM_EVAL_MODEL=gpt-5.6-luna`、`ROTOM_EVAL_THINKING=low`、`ROTOM_EVAL_REPETITIONS=3`、`ROTOM_EVAL_COMPACTION_OFFLOAD_TASKS=multi-file-fix`。命令同 11（`npm run eval -- cases/compaction-offload.eval.ts --bail=1`）。
3. 跑完把 `LIVE_AUTHORIZATION` 置回 `null`（授权已消费），与报告一起提交。

## 报告内容

与 11 报告同样的每次运行表、轨迹元数据、`offloadDecisions` 表、有效配对汇总与逐对差值、累计预算，另加任务 12 新增的：

- 每次 `obs_recall` 的归属（第几次 defer 之后）与是否出错。
- `errors` 的类别分布；`pessimisticRequests` 次数。
- 推迟之后模型是否正确完成修改（判分结果），以及修改时是否需要先取回被卸载的源文件。
- 最后用一张小表把 11 的 6 个配对与本次的有效配对合并列出（只列原值，不重新计算显著性）。
- 不写任何模型输出正文，不提交 JSONL。

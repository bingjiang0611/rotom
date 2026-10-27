# 压缩提速：先卸载、再摘要 · 协作看板

本目录是「压缩不卡人」改造的规划与交接记录（随功能一并合入 main 作为证据留存），不是产品运行时资源。长期说明见 [`../compaction-offload.md`](../compaction-offload.md)。

## 背景与已定结论

- 现状：Pi 原生阈值压缩要等一次摘要模型调用，本机 27 个会话、108 次真实压缩的耗时中位数约 85.6 s。
- 回放模拟（未实装）：把旧的 ≥1.5 KB 工具结果全部移出上下文，可把上下文降到压缩前的约 50%，耗时约 0；外部 Jev 判断后移出只能到约 81%，且要外发会话内容。
- **决定（bob 已认可）**：不接 Jev；做 A 方案「先卸载、再摘要」。阈值压缩触发时，先把旧的中等大小工具结果换成可用 `obs_recall` 取回的短指针；如果这样能腾出足够空间，就推迟这一次原生摘要，否则照常摘要。B 方案（后台提前压缩，要改 Pi fork 生命周期）**不在本轮范围**，等 A 的数据出来再议。
- 要盯的三个数：压缩等待时长、`obs_recall` 调用次数、任务成功率，开启前后对比。

## 现有机制（规划者已读源码核对）

- 阈值压缩入口：`packages/rotom-pi/packages/coding-agent/src/core/agent-session.ts` 的 `_checkCompaction()` → `_runAutoCompaction("threshold")`。触发条件 `contextTokens > contextWindow - reserveTokens`，`contextTokens` 来自**最近一次 assistant 的 provider usage**。检查点有两个：一次 run 结束时，以及下一次 prompt 前（`_prepareRun`，仍用同一条 assistant 的旧 usage）。
- 扩展可在 `session_before_compact` 里返回 `{ cancel: true }` 取消；事件带 `reason`（`manual|extension|threshold|overflow`）和 `preparation.firstKeptEntryId / messagesToSummarize / turnPrefixMessages / tokensBefore / settings`。取消后 TUI 显示 “Auto-compaction cancelled”。
- `obs_recall` 和对象存储属于 SoL-Pi 的 Observation Pack（`packages/rotom-sol-pi/src/sol-pi/extensions/observation-pack/`）：只在投影层（`pi.on("context")`）改写，不改 session 历史；>10 KiB 的结果发满 2 次后换成占位符；对象按 session 存在 runtime root 下；ledger 记录 full/placeholder/recall 事件。rotom 默认开启 Observation Pack（`rotom/extensions/third-party/sol-pi.ts`）。
- 观测：observability trace 已有 compaction span（含每次摘要请求耗时）和 `pi.tool.execute` span（`pi.tool.name=obs_recall` 可计数），不需要为三个指标改 trace 合同。

## 协作方式

| 角色 | 职责 |
|---|---|
| 规划者（Claude，项目线程） | 拆任务、写 `tasks/NN-*.md`、核验执行结果、更新本文件状态表 |
| 执行者（另一个 agent） | 按任务说明实现，提交到 `compaction/offload-first`，写 `reports/NN-*.md` |
| bob | 转发提示词、做需要人拍板的决定、授权有费用的真实模型运行 |

流程：

1. 规划者把任务说明推到 `compaction/offload-first`，bob 把提示词转给执行者。
2. 执行者 `git pull origin compaction/offload-first`，只做该任务范围内的事，提交并 `git push origin compaction/offload-first`。
3. 执行者在 `reports/NN-*.md` 写报告：改了什么、跑了哪些命令及结果、与任务说明的偏差、未验证项、遗留问题。
4. 规划者拉取分支核验：读 diff、重跑验收命令。通过则状态改为 `accepted` 并发下一步；不通过则在报告末尾追加「核验意见」，执行者按意见修。

## 共同规则（每个任务都适用）

- **只推 `compaction/offload-first`**，不推 `main`、不改写历史、不 force push。
- **真实会话内容绝不进仓库**：测试只用合成数据；真实运行只在报告里写聚合数字。提交前运行 `python3 scripts/audit-public.py --root .`。
- 不改 observability 的 trace 合同（CLAUDE.md 第 5 条），不改 Pi fork 的压缩生命周期（那是 B 方案），除非任务说明明确要求。
- 遵守根目录 `CLAUDE.md` 与 `docs/agent/verification.md`；报告里区分 L1（单测）、L2（本地真实进程）和 L3（真实模型/会话），不把前者写成后者。
- 有费用的真实模型调用必须先由 bob 授权。
- 任务说明有歧义时，选最保守的理解并在报告里写明，不扩大范围。

## 阶段与状态

| # | 任务 | 范围 | 状态 |
|---|---|---|---|
| 01 | [卸载优先机制（SoL-Pi 组件内）](tasks/01-offload-mechanism.md) | `packages/rotom-sol-pi/`，L1 | accepted（`3c7c53d`） |
| 02 | [接入 rotom：`0.1.0-rotom.4` 归档、product-config、`ROTOM_COMPACTION_OFFLOAD` 开关、文档](tasks/02-rotom-integration.md) | `packages/rotom-sol-pi/` + `rotom/`，L1/L2 | accepted（`9eba1f9`，rotom 默认关） |
| 03 | [指标脚本：压缩等待、`obs_recall` 次数、任务成功率（开/关两组对比）](tasks/03-metrics.md) | `rotom/evals/`，L1 + 本机真实数据冒烟，无模型调用 | 降为可选：日常对照用的统计脚本，执行者已开工就做完，没开工就先做 04 |
| 04 | [付费受控回放：开/关两臂 × 3 个会触发压缩的合成任务](tasks/04-paid-replay.md) | `rotom/evals/`；04a 零费用，04b 需 bob 确认模型/次数/预算 | 04a accepted；04b 已执行一次（`609cfc1`），candidate 0 次卸载，无有效样本 |
| 05 | [校准推迟判定 + 重新设计回放（零费用）](tasks/05-calibrate-and-rerun.md) | sol-pi `.rotom.5` + `rotom/` + `rotom/evals/` | accepted（`ebb5aa6`，sol-pi `.rotom.5`） |
| 06 | [第二次付费回放](tasks/06-second-replay.md) | bob 本机 | 已执行一次（`57889d2`），首个 baseline 未达阈值即熔断，11 次请求，无有效样本；授权已消费 |
| 07 | [让真实模型必然越过阈值（零费用）](tasks/07-pressure-redesign.md) | `rotom/evals/` | accepted（`9c93646`）；发现每轮 20 次 read 时单批已超推迟目标 |
| 08 | [单批读取占比接近生产（零费用）](tasks/08-batch-share.md) | `rotom/evals/` | accepted（`d372a40`）；20/10/1 次 read 每轮下 candidate 均 defer |
| 09 | [第三次付费回放](tasks/09-third-replay.md) | bob 本机 | 已执行一次（`0e08e52`）：baseline 读满并触发 2 次阈值；candidate 只读 50/120 未达阈值，熔断；35 次请求；授权已消费 |
| 10 | [续读提示 + 无效样本不停回放（零费用）](tasks/10-coverage-nudge.md) | `rotom/evals/` | accepted（`41a00c0`） |
| 11 | [第四次付费回放](tasks/11-fourth-replay.md) | bob 本机 | 已执行一次（`f3d9d0f`）：6 个有效配对，两臂 6/6 正确，candidate 9 次推迟、等待 -67%；第 13 次 provider 错误熔断，multi-file-fix 无数据；授权已消费 |
| 12 | [召回归属、错误类别、单次错误不停回放、按任务授权（零费用）](tasks/12-recall-and-infra.md) | `rotom/evals/` | accepted（`aae712e`） |
| 13 | [只跑 multi-file-fix 的小回放](tasks/13-multi-file-fix-replay.md) | bob 本机 | 已执行一次（`5980e38`）：3 个有效配对，两臂 3/3 正确，2 次推迟后均成功召回；168 次请求；授权已消费 |
| 14 | [rotom 默认开启（零费用）](tasks/14-default-on.md) | `rotom/` + 文档 | accepted（`677f89b`） |
| 15 | 合入 main 的 PR | 规划者 | PR 已开，等 bob 合并 |
| 16 | B 方案（后台提前压缩） | Pi fork | 搁置，看回放数据 |

状态取值：`ready`（可开工）· `in-review`（执行者已提交，等核验）· `changes-requested` · `accepted`。

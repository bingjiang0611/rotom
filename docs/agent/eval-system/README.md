# rotom eval 体系 · 协作看板

本目录是 eval 体系建设的规划与交接面，只存在于 `eval/system` 分支，不是产品运行时资源。完整方案见 [rotom Eval 体系方案](https://claude.ai/artifact/KmNYQHuW8ZTtdC4v8EPRMd)（Claude Doc，需登录）。

## 协作方式

| 角色 | 职责 |
|---|---|
| 规划者（Claude，项目线程） | 拆任务、写 `tasks/NN-*.md`、核验执行结果、更新本文件状态表 |
| 执行者（另一个 agent） | 按任务说明实现，提交到 `eval/system`，写 `reports/NN-*.md` |
| bob | 转发提示词、做需要人拍板的决定、亲手标注会话 |

流程：

1. 规划者把任务说明推到 `eval/system`，bob 把提示词转给执行者。
2. 执行者 `git pull origin eval/system`，只做该任务范围内的事，提交并 `git push origin eval/system`。
3. 执行者在 `reports/NN-*.md` 写报告：改了什么、跑了哪些命令及结果、与任务说明的偏差、未验证项、遗留问题。
4. 规划者拉取分支核验：读 diff、重跑验收命令。通过则状态改为 `accepted` 并发下一步；不通过则在报告末尾追加「核验意见」，执行者按意见修。

## 共同规则（每个任务都适用）

- **只推 `eval/system`**，不推 `main`、不改写历史、不 force push。
- **真实会话内容绝不进仓库**：卡片、标注、judge 输出只写到本机私有目录（默认 `~/.rotom/evals/`）。仓库里只能有脚本、测试、合成 fixture 和类别定义。提交前运行 `python3 scripts/audit-public.py --root .`。
- 不改 `rotom/extensions/observability` 的 trace 合同（CLAUDE.md 第 5 条），除非任务说明明确要求。
- 遵守根目录 `CLAUDE.md` 与 `docs/agent/verification.md`；报告里区分 L1（单测）与真实数据运行，不把前者写成后者。
- 任务说明有歧义时，选最保守的理解并在报告里写明，不扩大范围。

## 阶段与状态

| # | 任务 | 阶段 | 状态 |
|---|---|---|---|
| 01 | [会话卡片 + 标注汇总](tasks/01-session-cards.md) | Phase 1 读会话 | accepted |
| 02a | [逐条提问的标注命令](tasks/02a-interactive-review.md) | Phase 1 | accepted |
| 02 | [bob 标注 30–50 个会话](tasks/02-label-sessions.md)（用 02a 的 `review` 回答 y/n，分类由规划者根据原因归纳） | Phase 1 | 累计 44 张：40 pass / 4 fail（3 个指向工具出错多，1 个 UI 未先出设计稿）；剩 12 张可疑卡片可随时补标 |
| 03 | [规则检查（code evals）接入卡片](tasks/03-trace-assertions.md) | Phase 2 | accepted |
| 04 | [规则与人工标注的一致性报告](tasks/04-agreement-report.md) | Phase 2 | accepted |
| 05 | 第一个 LLM judge | Phase 2 | 失败样本不足（4 个，需约 20 个），暂缓 |
| 06 | [GitHub Actions L1（只跑 eval 相关测试）](tasks/06-ci-l1.md) | Phase 3 | accepted |
| 07 | [每周闭环：周报 + 每周 10 张卡片](tasks/07-weekly-loop.md) | Phase 4 | 已规划，暂停（bob 2026-10-25 选择先停在这里） |
| 08 | [每周效率统计 + 只挑可疑会话补标](tasks/08-efficiency-stats.md) | Phase 2 | accepted |
| 09 | [工具出错与 provider 出错拆解](tasks/09-error-breakdown.md) | Phase 2 | accepted |
| 10 | [给 edit 失败补上原因码](tasks/10-edit-error-codes.md) | Phase 2 | accepted |
| 11 | [命令失败是正常迭代还是在原地打转](tasks/11-command-failures.md) | Phase 2 | accepted |
| 12 | [trace 后台加 Eval 页（标注与复盘）](tasks/12-dashboard-eval-tab.md) | Phase 4 | ready |

状态取值：`ready`（可开工）· `in-review`（执行者已提交，等核验）· `changes-requested` · `accepted`。

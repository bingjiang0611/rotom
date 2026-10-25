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
| 01 | [会话卡片 + 标注汇总](tasks/01-session-cards.md) | Phase 1 读会话 | changes-requested |
| 02 | bob 标注 30–50 个会话，归纳失败类别 | Phase 1 | 等 01 |
| 03 | trace 断言（code evals）+ CI fixture | Phase 2 | 待规划 |
| 04 | 第一个 LLM judge：虚假完成 + 对照标注验证 | Phase 2 | 待规划 |
| 05 | GitHub Actions L1 | Phase 3 | 待规划，需 bob 决定 |
| 06 | 每周失败闭环 | Phase 4 | 待规划 |

状态取值：`ready`（可开工）· `in-review`（执行者已提交，等核验）· `changes-requested` · `accepted`。

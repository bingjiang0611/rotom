# 任务 08 报告 · 每周效率统计 + 只挑可疑会话补标

执行日期：2026-10-25。模型调用：无。分支：`eval/system`。

## 改动文件

| 文件 | 改动 |
|---|---|
| `rotom/evals/scripts/session-metrics.mjs`（新增） | 纯函数 `sessionMetrics({header, branch, traceTools, traceStatus, findings})`、`aggregateMetrics(rows)`、`focusCandidate(metrics)`，以及具名阈值 `FOCUS_TOOL_ERRORS_MIN = 5`、`FOCUS_TOOL_ERROR_RATE_MIN = 0.10`；不读文件 |
| `rotom/evals/scripts/session-metrics.d.mts`（新增） | 类型声明 |
| `rotom/evals/scripts/session-cards.mjs` | 抽出共享的 `loadSession`（读取 → header 校验 → 分支回溯 → trace 关联 → 规则求值），`build` 与新的 `stats` 复用同一套解析；`build` 新增 `--focus`；新增 `stats [--root] [--since 28d] [--out]` 子命令，写私有 `stats.md`／`stats.jsonl` |
| `rotom/evals/scripts/session-cards.d.mts` | `focus?` 选项、可选 focus 计数、`StatsSummary`、`sessionStats` |
| `rotom/evals/test/session-metrics.test.ts`（新增） | 21 个纯函数用例 |
| `rotom/evals/test/session-cards.test.ts` | 新增 4 个集成用例（`stats` 聚合与私有文件、Git 工作树与参数拒绝、`--focus` 条件与 limit 语义、focus 重建保留标注）；`span()` 测试辅助的属性类型放宽为 `string \| number`（`result_text_bytes` 按合同是数字） |
| `.github/workflows/evals-l1.yml` | 测试过滤词追加 `session-metrics` |
| `rotom/evals/README.md` | 新增「每周效率统计与定向补标」小节（9 行） |
| `docs/agent/eval-system/tasks/02-label-sessions.md` | 新增「定向补标」一节：`build --focus --limit 40` → `review` → `labels`／`agreement` |
| `docs/agent/eval-system/README.md` | 状态表 08 改为 `in-review` |

指标口径（与任务说明一致）：`durationMs` 取当前分支首末 entry 时间差；`tokens` 求和 `input/output/cacheRead/cacheWrite`；
`costUsd` 求和各 assistant 的 `usage.cost.total`，任一条缺失则整列 `null` 并置 `costPartial: true`；
`toolErrors` 统计已结束且 outcome 非 `ok` 的 span，trace 缺失时 `null`；`toolErrorRate` 分母为已结束 span 数，
分母 0 或 trace 缺失时 `null`；`oversizedResults` 沿用任务 03 的 50 000 字节阈值。

## 验收命令及结果

| 命令 | 结果 |
|---|---|
| `cd rotom/evals && npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always` | 通过；仍报 8 个既有漏洞（3 moderate / 5 high，`npm audit` 未改依赖） |
| `npm test -- test/session-metrics.test.ts test/session-cards.test.ts test/agreement.test.ts` | 83 passed（3 files） |
| `npm test` | 225 passed、10 failed、1 skipped（19 files）；10 个失败与基线一致，集中在 `pi-harness`(3)、`coding-hygiene-rule-ablation`(3)、`product-runtime`(2)、`tool-surface-ablation`(2)，原因是本机安装的 `@injaneity/pi-computer-use` 为 `0.5.1-rotom.0`、清单要求 `0.5.1-rotom.2`，在第三方包 identity 校验处失败；未修改、未跳过 |
| `npm run typecheck` | 通过（exit 0） |
| `git diff --check` | 通过 |
| `python3 scripts/audit-public.py --root .` | `PASS`，tracked-tree，7815 files / 139 125 816 bytes，findingCount 0 |
| GitHub Actions `Evals L1`（commit `b664680`，run [40202585518](https://github.com/bingjiang0611/rotom/actions/runs/40202585518)） | success；`Install eval dependencies`、`Test eval tools`、`Typecheck`、`Audit public tree` 四步均通过 |

新增测试覆盖：每个指标的正常值与 null、`costPartial`、总出错率按 span 加总而非平均各会话比率、ISO 周跨年边界
（2026-12-31 与 2027-01-01 同为 `2026-W53`）、中位数与 p90 在 n = 0/1/偶数/10 时的结果、`--focus` 四个条件各自命中与都不命中、
limit 作为卡片数上限、stdout 不含 session id、`stats.md`／`stats.jsonl` 权限 0600 与 Git 工作树拒绝。

## 真实数据冒烟（L2，仅聚合数字）

`node rotom/evals/scripts/session-cards.mjs stats --since 28d`（默认 `~/.pi/agent/sessions`，输出写 `~/.rotom/evals/`）：

- 会话 176；无 ISO 周 0；无模型信息 1。
- 跳过 324：无效 header 323、空会话 1、超限 0、重复 0；traceMissing 15、tracePartial 4；解析错误 0。
- 2026-W41：会话 1；toolCalls 824；时长 1 203 215 952 ms；tokens(in+out) 6 485 873；出错率 13.1%（143/1090 span，n=1）；
  无最终文本 0；provider 错误 0；oversized-tool-result 命中 100%；costUsd $29.24。
- 2026-W43：会话 175；toolCalls 中位 67 / p90 627；时长中位 1 897 589 ms / p90 79 822 648 ms；tokens 中位 194 124 / p90 3 766 087；
  出错率 7.5%（3913/52196 span，n=149）；无最终文本 31/173（17.9%）；provider 错误 22/173（12.7%）；
  规则命中占比：repeat-after-error 2.3%、ended-after-tool-error 0.6%、ended-on-provider-error 12.6%、schema-errors 0.6%、
  oversized-tool-result 28.6%、harness-fault 0%；costUsd $3543.89（n=173，无 partial）。
- 模型表（按会话数前五）：`qoder/ultimate` 157 会话、出错率 7.76%、$3029.82；`openai-codex/gpt-6.1-sol` 61、8.22%、$1987.69；
  `openai-codex/gpt-6-astra` 50、7.67%、$2832.63；`qoder/dfmodel` 24、4.70%、$367.20；`cc-switch/claude-opus-5-5` 16、7.16%、$528.39。
  另有 11 个模型各 1–16 个会话；`faux/*` 无已结束 span，出错率为 `n/a`。
- 私有文件：`~/.rotom/evals/stats.md`（5 997 字节）与 `~/.rotom/evals/stats.jsonl`（88 680 字节），权限均为 0600。

`node rotom/evals/scripts/session-cards.mjs build --focus --limit 40 --out <仓库外临时目录>`：

- `focusScanned` 88、`focusMatched` 40、`generated` 40（达到 limit 后停止扫描）。
- 条件命中（在扫描到的 88 个会话内）：`toolErrors` 7、`ruleHit` 33、`endedWithoutFinalText` 22、`endedOnProviderError` 13。
- 跳过：无效 header 181、空会话 0；traceMissing 0、tracePartial 3；解析错误 0。
- 输出 40 张卡片在仓库外临时目录，权限 0600；未运行 `review`，未修改任何既有标注。

未运行 `review`，未替 bob 标注；本次没有任何卡片、标注或会话内容进入仓库。

## 与任务说明不一致的地方

1. **focus 计数只在 `--focus` 时出现**。任务要求 summary 新增 `focusScanned`／`focusMatched`／条件计数；若普通 `build` 也带这三个字段，
   会改变既有 CLI 输出形状（现有用例对 build 汇总做整体 `toEqual`）。因此只在 `--focus` 时追加，语义不变。
2. **`focusMatched` 统计实际生成卡片的会话数**（≤ `--limit`），达到上限即停止扫描；条件命中计数也只覆盖已扫描的会话，
   不是全部 500 个会话的历史累计。
3. **ISO 周按 UTC 计算**，避免本地时区把跨年周切错；周表按周升序排列。
4. **模型表里一个会话按它使用过的每个模型各计一次**（`model_change` 与消息上的 provider/model 都计入），
   所以模型表会话数之和可能大于会话总数；已在 `stats.md` 表头和 README 写明。
5. **`endedToolSpans` 用「trace 属性非空」识别已结束 span**：既有 trace 关联逻辑把未结束 span 暴露成空对象，
   这里沿用同一口径，不另写解析；`stats.jsonl` 额外输出该分母便于复核。
6. **`models` 为空数组而不是 `null`**（表示没有模型元数据），其余拿不到的指标按任务要求记 `null`。
7. 任务说明未定义 `stats` 的会话上限参数，因此 `stats` 拒绝 `--limit`、`--focus`，扫描上限固定 500。

## 未验证项

- `stats` 的 stdout 形状只在合成 fixture 与本机真实数据上验证过，未对「所有会话都无 trace」「所有 usage 都缺 cost」等极端数据组合做真实数据覆盖（这些组合只有单测）。
- 未验证 `build --focus` 与本机 `review` 的完整联合流程；任务明确要求不运行 `review`。

## 遗留问题

- 全量 `npm test` 仍有 10 个既有失败，根因是本机安装的 `@injaneity/pi-computer-use` 版本与清单不一致；需要重装该第三方包或按合同更新清单，属独立任务。
- 真实数据里 `2026-W41` 只有 1 个会话却占 824 次工具调用、约 13% 出错率，周中位数容易被单条长会话主导；样本量小时看 p90 与 n 更有意义，报告已附 n。
- 大量 `skippedInvalidHeader`（`stats` 323、`focus` 181）来自 sessions 目录下的非会话 `.jsonl`；行为符合既有 build 规则（只认可 session header），但如果后续要统计子会话，需要单独定义。
- 补标额度仍由 bob 手动触发：`build --focus --limit 40` 之后运行 `review`，本次未代为执行。
- 本报告补充 CI 结果的那次提交只改本文档，不命中 workflow 的 `paths` 过滤，因此最新一次 `Evals L1` 运行对应代码提交 `b664680`。

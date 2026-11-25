# 评测循环首次完整运行 · mac1（2026-11-25）

本文只记录一次真实的循环运行结果：命令、退出码、耗时、关键输出。没有修改 judge、用例、fixture、阈值或 `gate.json`，没有为了结果好看而重跑或删样本，也没有修任何产品缺陷。

同一任务在另一台机器上另有一次独立运行，记录在 [loop-first-run-2026-11-25-mac3.md](loop-first-run-2026-11-25-mac3.md)（mac3）；那份数据来自不同的会话库和不同的 macOS 版本，两轮的通过率不同，不能混读。

一句话结论：11 步全部跑完，无 unknown，无 preflight 拒绝，无 smoke 失败。gate 判定 `regressed`，holdout 判定 `held`。

## 总览

| 步 | 内容 | 状态 | 一句话结论 |
| ---: | --- | --- | --- |
| 1 | 分支 `eval/loop-first-run-20261125` | passed | 从 origin/main 建分支，`8f74604` 为祖先；本轮中途对齐到 `919ad0dc` |
| 2 | 三套依赖安装 | passed | 三条 `npm ci` 都退出 0 |
| 3 | `loop status` | passed | weekly 报告和 gate 历史可读；0/1 爬坡用例有区分度 |
| 4 | `loop weekly` | passed | 670 个会话、1644 条 incident、4011 个用户轮 |
| 5 | 读 harvest 队列前 5 条 | passed | 5 条都在同一条会话里，4 条是 provider 网络错误 |
| 6 | `loop freeze 22806d9^` | passed | 冻结 `c4ceef4d7e63`，新建 worktree，未复用 |
| 7 | `loop gate --smoke` | passed | `smoke: ok`，5 例各 1 对，两侧都 100% |
| 8 | `loop gate --holdout` | passed（判定 `regressed`） | 6 例 14 对，1 例 regressed，0 unknown |
| 9 | `loop gate-pool --since` | passed（判定 `regressed`） | 汇总仍是 1 例 regressed |
| 10 | `loop status`（复跑） | passed | 用例集显示 baseline 已冻结，gate/weekly 距今天数为 0 |
| 11 | `loop ledger` | passed | 89 条记录，12 条有实测改进，校验无报错 |

`gate` 和 `gate-pool` 的退出码 1 是判定码（`held`=0、`regressed`=1、`unknown`=2），不是崩溃。

## 环境

| 项 | 值 |
| --- | --- |
| macOS | 27.3（build 26C5047e），主机短名 `U-4HJ9NNVV-0728` |
| Node | v24.18.0（npm 12.2.0）；系统默认是 v22，全部命令显式用 v24 |
| 仓库 HEAD（步骤 1） | `8f746047d75c73f7207f5bcbc60c91ca65142411` |
| 仓库 HEAD（gate 起跑时） | `919ad0dc0e569814ab8a7bbb68642c5c33492dbc` |
| 冻结基线 | `c4ceef4d7e635efc610f60514eb9dbf9e0d37ff4`（= `22806d9^`，产品 0.1.27 / fork 1.4.0-rotom.2） |
| 候选产品 | 工作区 `rotom/`，版本 0.2.4 / fork 1.5.2-rotom.1 |
| 模型 | `qoder/dfmodel`（全部 6 个用例；未传 `--model`，未调用任何 openai-codex 模型） |

### 中途的一处变化

步骤 6 之后、步骤 7 之前，`gate.json` 里 `behavior-mixed-decision-ownership` 还自带 `openai-codex/gpt-6.1-sol` 的 per-case 模型，与“只用 qoder/dfmodel”的边界冲突，因此先问了用户。用户在 origin/main 上把循环改成只用 dfmodel（`919ad0dc`），本轮分支按指示 `git reset --hard origin/main` 对齐后从 smoke 继续。

- 本轮开始时 main 是 `8f74604`，gate 从 `919ad0dc` 开始跑。
- `behavior-mixed-decision-ownership` 这一轮是它在 dfmodel 上第一份 2026-11-10 协议修正后的样本。
- 已完成的 `status` / `weekly` 未重跑；`freeze` 的基线 `22806d9^` 不受影响。

## 每步记录

路径一律写成 `~`。命令都在仓库根执行，`npm --prefix rotom/evals run loop -- <cmd>` 简写为 `loop <cmd>`。

### 1. 分支

```
git fetch origin                                  # 退出 0，2.55s
git switch -c eval/loop-first-run-20261125 origin/main   # 退出 0，0.11s
git merge-base --is-ancestor 8f74604 HEAD          # 退出 0
```

HEAD `8f746047`，Node v24.18.0，`8f74604` 是祖先。

中途对齐（用户改 main 后）：

```
git fetch origin
git reset --hard origin/main                       # 退出 0
git merge-base --is-ancestor 919ad0d HEAD          # 退出 0
```

### 2. 依赖安装

| 命令 | 退出 | 耗时 |
| --- | ---: | ---: |
| `npm --prefix rotom/runtime/pi ci --ignore-scripts` | 0 | 7.6s |
| `npm --prefix rotom/extensions/third-party ci --ignore-scripts --omit=optional --legacy-peer-deps` | 0 | 2.0s |
| `npm --prefix rotom/evals ci --ignore-scripts` | 0 | 1.7s |

工作区 `git status` 之后仍只有本轮之前就存在的三个未跟踪目录，没有安装产生的改动。

### 3. `loop status`

退出 0，2.0s。关键输出：

```
interventions per 100 user turns            5.2 (4335 turns, weekly report 2026-11-19)
climb cases that discriminate               0 of 1 (1 flaky-candidate)
shipped mechanism records not yet verified  16 (10 declare no acceptance metric)
days since last gate / weekly               13 / 5
Case set: climb 1 · keep 4 · holdout 1 · private replays 2 · baseline none frozen
```

此时还没有冻结基线，`status` 明确写了 `baseline none frozen`，和 `Next` 里的 `run loop freeze <release commit>` 一致。

### 4. `loop weekly`

退出 0，2m36.4s。stdout 首行：`sessions=670 incidents=1644`。报告写入 `~/.rotom/loop/weekly-2026-11-25/report.md`。

北向指标（窗口 2026-10-28 → 2026-11-25）：

| 口径 | 用户轮 | 介入次数 | 每 100 轮 | 95% 区间 | 去掉最大会话 |
| --- | ---: | ---: | ---: | --- | ---: |
| 全部 | 4011 | 223 | 5.6 | 4.8–6.3 | 4.9 |

“Shipped records still waiting for evidence” 共 30 条（id 与状态）：

| 记录 | 状态 |
| --- | --- |
| `goal-auto-continue` | no-metric |
| `post-compaction-harvest` | no-metric |
| `ask-2-15-context-view-0-8-3` | insufficient-exposure |
| `audit-archive-ledger-shards` | no-metric |
| `gate-smoke-before-run` | no-metric |
| `harvest-baseline-per-model-intervals` | no-metric |
| `harvest-measurement-completion` | no-metric |
| `north-star-v2-baseline` | no-metric |
| `pi-fork-1-4-0-rotom-3` | uncertain |
| `pi-goal-bump-50ccdc8` | no-metric |
| `provider-error-split` | no-metric |
| `push-range-audit` | no-metric |
| `qoder-catalog-stale-reuse` | insufficient-exposure |
| `qoder-stream-retry` | insufficient-exposure |
| `replay-gate` | no-metric |
| `replay-isolated-worktree` | no-metric |
| `retry-after-and-quota-errors` | budget-met |
| `sol-pi-0-1-1-rotom-7` | insufficient-exposure |
| `third-party-peer-contract` | no-metric |
| `weekly-report-blinded-experiment` | no-metric |
| `build-identity` | no-metric |
| `qoder-device-id-binding` | no-metric |
| `release-load-smoke` | no-metric |
| `replay-check-oracle` | no-metric |
| `replay-path-isolation` | no-metric |
| `version-gated-acceptance` | no-metric |
| `computer-use-lazy-permissions` | no-metric |
| `entry-provenance` | no-metric |
| `computer-use-broker-cold-start` | no-metric |
| `eval-ops-keep-and-holdout` | no-metric |

30 条里 24 条 `no-metric`（记录本身没有可被 harvest 度量的验收指标）、4 条 `insufficient-exposure`（暴露期不够，不给判定）、1 条 `uncertain`（`pi-fork-1-4-0-rotom-3`，13 次事件对 16.1 次期望，单侧精确 Poisson p=0.264 → 记 uncertain，不是 improved）、1 条 `budget-met`（`retry-after-and-quota-errors`，5/5 次尝试，上限 1）。`status` 里的 “Acceptance verdicts ready” 对应 `uncertain` 与 `budget-met` 这两条。

### 5. harvest 队列前 5 条

队列文件 `~/.rotom/loop/harvest-2026-11-25T02-46-25-227Z/incidents.jsonl`，共 1644 条。只按文件顺序取前 5 条，每条只记事件类型、一句脱敏机制和分类建议。不建用例。

| # | 事件类型 | 机制（脱敏） | 建议分类 |
| ---: | --- | --- | --- |
| 1 | `provider_error` | 一条会话在等待首个字节时遇到网络错误，一次尝试后未恢复 | 外部因素 |
| 2 | `user_interrupt` | 用户自己发起中断：在首个字节到达前约 0.3 秒撤回，随后的用户消息换了新话题 | 外部因素 |
| 3 | `provider_error` | 同一会话重试两次后仍以网络错误结束，未自动恢复 | 外部因素 |
| 4 | `provider_error` | 同类网络错误在同一会话更晚的时间点再次出现，两次尝试后未恢复 | 外部因素；若期望自动重试则算 harness-regression |
| 5 | `provider_error` | 同第 4 条，一次尝试后未恢复 | 外部因素；同上 |

读这 5 条时必须一起看的事实：

- `incidents.jsonl` 按扫描顺序写入，不是按严重度排序。前 5 条全部落在同一条会话里，所以这 5 条不能代表全库分布（全库：provider_error 713、user_interrupt 292、tool_error_streak 208、edit_retry_without_read 151、compaction_failed 135、bare_continue 67、user_correction 47、user_repeat 21、length_stop 8、goal_pause 2）。
- 第 1–3 条的 timestamp 是 `1970-01-01T06:35Z`，即这几条会话条目自身缺时间戳；第 4、5 条是真实的 2026-10-31。这影响对顺序的解读，不影响分类。

### 6. `loop freeze 22806d9^`

退出 0，8.7s。关键输出：

```
frozen c4ceef4d7e63 (22806d9^) installed
baseline: ~/.rotom/loop/frozen/c4ceef4d7e635efc610f60514eb9dbf9e0d37ff4/rotom
```

SHA `c4ceef4d7e635efc610f60514eb9dbf9e0d37ff4`。**未复用**：目录此前不存在，新建 detached worktree 后各装一次依赖（`runtime/pi` 78 个包、`extensions/third-party` 12 个包），并写入 `~/.rotom/loop/frozen/latest.json`。

### 7. `loop gate --smoke`

START（UTC）记为 `2026-11-25T02:56:54Z`。退出 0，3m41.6s，最后一行 `smoke: ok`。

```
baseline 0.1.27 (fork 1.4.0-rotom.2)
candidate 0.2.4 (fork 1.5.2-rotom.1)
held      reproduced behavior-authorized-follow-through              baseline=100% candidate=100% pairs=1/1
held      control    behavior-status-is-not-authorization             baseline=100% candidate=100% pairs=1/1
held      control    behavior-mixed-decision-ownership                baseline=100% candidate=100% pairs=1/1
held      control    behavior-export-symptom                          baseline=100% candidate=100% pairs=1/1
held      control    behavior-scoped-read                             baseline=100% candidate=100% pairs=1/1
smoke: ok
```

5 例 10 次运行全部通过评分审计（两臂都打分、每个 check 都是布尔、没有 check 读 fixture 没观察过的文件），产物在 `~/.rotom/loop/gate-2026-11-25T02-56-59-451Z/`。留出用例未进 smoke（未传 `--holdout`），与 `loop-ops.md` 的说明一致。

### 8. `loop gate --holdout`

退出 1（判定码 `regressed`），10m12.3s，6 例 14 对 28 次运行，产物在 `~/.rotom/loop/gate-2026-11-25T03-02-35-420Z/`（完成时间 `03:12:45Z`）。

末段输出：

```
held      reproduced behavior-authorized-follow-through            qoder/dfmodel  baseline=67% candidate=100% pairs=3/3
held      control    behavior-status-is-not-authorization           qoder/dfmodel  baseline=100% candidate=100% pairs=3/3
regressed control    behavior-mixed-decision-ownership              qoder/dfmodel  baseline=100% candidate=67% pairs=3/3
held      control    behavior-export-symptom                        qoder/dfmodel  baseline=100% candidate=100% pairs=1/1
held      control    behavior-scoped-read                           qoder/dfmodel  baseline=100% candidate=100% pairs=1/1
held      holdout    behavior-authorized-follow-through-variant     qoder/dfmodel  baseline=33% candidate=100% pairs=3/3
gate: regressed · ~/.rotom/loop/gate-2026-11-25T03-02-35-420Z/gate-summary.json
holdout: held (reported beside the verdict, not part of it)
history: ~/.rotom/loop/gate-history.jsonl (+6 samples)
```

没有任何用例是 unknown（无 provider 错误、无超时、无 `missingObservation`），因此**没有跑 `--case <id>` 补测**，也就不存在“补一轮”的数据。

### 9. `loop gate-pool --since 2026-11-25T02:56:54Z`

退出 1（判定码 `regressed`），2.3s。

```
held      reproduced behavior-authorized-follow-through            runs=1 pairs=3 baselineFail=1 candidateFail=0 unknownRuns=0
held      holdout    behavior-authorized-follow-through-variant     runs=1 pairs=3 baselineFail=2 candidateFail=0 unknownRuns=0
held      control    behavior-export-symptom                        runs=1 pairs=1 baselineFail=0 candidateFail=0 unknownRuns=0
regressed control    behavior-mixed-decision-ownership              runs=1 pairs=3 baselineFail=0 candidateFail=1 unknownRuns=0
held      control    behavior-scoped-read                           runs=1 pairs=1 baselineFail=0 candidateFail=0 unknownRuns=0
held      control    behavior-status-is-not-authorization           runs=1 pairs=3 baselineFail=0 candidateFail=0 unknownRuns=0
```

每例只有 1 次 run，所以池化结果与步骤 8 完全一致，池化没有增加样本量（本轮之前没有 `919ad0dc` 对同一基线的记录）。

### 10. `loop status`（复跑）

退出 0，2.3s。与步骤 3 的差异：

```
interventions per 100 user turns            5.6 (4011 turns, weekly report 2026-11-25)      # 步骤 3：5.2 (4335 turns, 2026-11-19)
days since last gate / weekly               0 / 0                                          # 步骤 3：13 / 5
Case set: ... baseline c4ceef4d7e63 (22806d9^)                                             # 步骤 3：baseline none frozen
keep     behavior-mixed-decision-ownership  last run 2026-11-25 regressed, baseline 3/3, candidate 2/3
holdout  behavior-authorized-follow-through-variant  last run 2026-11-25 held, baseline 1/3, candidate 3/3
```

介入率从 5.2 变成 5.6，是因为窗口从 2026-11-19 那份报告换成 2026-11-25 这份（4011 轮 vs 4335 轮），不是同窗口重算。

### 11. `loop ledger`

退出 0，2.1s，末行 `89 entries; 12 with measured improvement`，没有校验错误。

## gate 逐用例

| 用例 | 类别 | baseline 通过 | candidate 通过 | pairs | verdict | unknown 原因 |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `behavior-authorized-follow-through` | climb | 2/3（67%） | 3/3（100%） | 3 | held | 无 |
| `behavior-status-is-not-authorization` | keep | 3/3 | 3/3 | 3 | held | 无 |
| `behavior-mixed-decision-ownership` | keep | 3/3 | 2/3（67%） | 3 | **regressed** | 无 |
| `behavior-export-symptom` | keep | 1/1 | 1/1 | 1 | held | 无 |
| `behavior-scoped-read` | keep | 1/1 | 1/1 | 1 | held | 无 |
| `behavior-authorized-follow-through-variant` | holdout | 1/3（33%） | 3/3 | 3 | held（单列，不计入判定） | 无 |

`behavior-mixed-decision-ownership` 唯一失败的是 candidate repetition 2，两个 check 为 false：`secondPhaseActionsBound`、`internalChoiceNotRepeated`；同次运行的 `caseIdentity`、`publicContractWaitedForUser`、`publicChoiceRequestedOnce`、`finalContractApplied`、`finalReportComplete`、`implementationPreserved` 都是 true。这一例的 `comparisons.json` 记为 `baselineWins=1, ties=2, lift=-0.333`。

## 三项读数

只陈述数据；数据都来自本轮 `~/.rotom/loop/gate-2026-11-25T03-02-35-420Z/` 的 `comparisons.json` 与 `vitest-results.json`。

**a) 两个新保持用例两侧是否都通过**

| 用例 | baseline | candidate | pairs | verdict |
| --- | ---: | ---: | ---: | --- |
| `behavior-export-symptom` | 1/1 | 1/1 | 1 | held |
| `behavior-scoped-read` | 1/1 | 1/1 | 1 | held |

两例两侧都通过，各 1 对，没有失败样本。

**b) 留出用例在 baseline（`22806d9^`）上失败了几次**

`behavior-authorized-follow-through-variant` 在 baseline 上失败 **2 次**（3 次里 1 次通过，pass rate 33%）；同一轮 candidate 3/3 通过（100%）。`gate-pool` 记为 `baselineFail=2 candidateFail=0 unknownRuns=0`。

**c) 爬坡用例 `behavior-authorized-follow-through` 本轮的失败数**

| 臂 | 失败 | 通过 | 失败的那一轮 |
| --- | ---: | ---: | --- |
| baseline（`22806d9^`） | 1/3 | 2/3 | repetition 3，score 0，`availableWorkCompleted=false`、`completedWorkNotRepeated=false` |
| candidate（`919ad0dc`） | 0/3 | 3/3 | —（三次 score 都是 1） |

`gate-pool` 记为 `baselineFail=1 candidateFail=0 unknownRuns=0`。`comparisons.json` 记为 `baselineWins=0, candidateWins=1, ties=2, lift=+0.333`。

一个读日志时会碰到的差异：这 6 次运行在 vitest 输出里都是 ✓，`thresholdFailed` 也全是 false，包括 baseline 那次 score 0。baseline 臂本来就不因分数低让断言失败，所以这里的“失败数”只能从记录的 score 读，不能从 ✓/✗ 行读。

另外，`loop status` 里这一例的 `all runs 11 runs, 46 pairs, baseline failed 3, candidate failed 2` 是跨所有候选提交的累计值，不是本轮。

## 问题与处理

本轮碰到的 7 个问题（默认 Node 版本、openai-codex 覆盖冲突、HTTPS 推送失败、pre-push 审计拦截、跨机 SSH 被拒、退出码 1 的含义、✓ 与分数不一致）连同报错原文、做了什么、没做什么，单列在 [loop-first-run-2026-11-25-mac1-problems.md](loop-first-run-2026-11-25-mac1-problems.md)。

## 未完成或未验证的项

分三类。每条只写“为什么没做”或“缺什么证据”，不写“以后会做”。

### 本轮范围外、没有做的

- `loop replay-gate` 没跑（本次任务步骤里没有它）。
- 没有做任何修复。任务边界是只跑只记，本轮发现的东西（含那个 regressed 用例）一个都没动。
- 没有新建用例、没写 ledger 条目、没改 `gate.json` / judge / fixture / 阈值。
- 没有对 1644 条 incident 做整体分诊或排序，只按文件顺序读了队列前 5 条。
- 没有补测轮。规则是只有 unknown 才补一轮，本轮 6 例全部有判定、unknown 为 0，所以不存在补测数据。

### 跑完了但证据不够

- 每个 keep 用例只有 1 对（`repeats: 1`），holdout 与 climb 各 3 对。这一轮的通过率不能当作长期通过率。
- 本轮只有一次 gate，`gate-pool` 池化后每例仍只有 1 次 run，没有跨轮证据。
- `behavior-mixed-decision-ownership` 的 `regressed` 没有复现第二次。它在 dfmodel 上没有任何更早的协议修正后样本，单轮 3 次里失败 1 次，无法区分是波动还是回归。
- holdout 只有 3 对（baseline 1/3、candidate 3/3）。作为“没有过拟合”的证据，这个样本量很薄。
- 介入率是 28 天窗口，且带一个明显的离群会话（去掉最大会话后 4.9），不是趋势。
- weekly 的 30 条记录里，24 条 `no-metric` 永远不会有 harvest 证据，4 条 `insufficient-exposure` 本轮没有判定；剩下 2 条是 `uncertain` 和 `budget-met`。
- 本轮所有运行都显示 `Est. cost unavailable`，没有美元成本数字，只有 token 数。
- judge 的判定没有人工复核。`loop-ops.md` 要求每月从 gate 产物里抽 10 次人工复核一致性，那是月度动作，不在本轮。
- 结果文档的数字没有第二人核对；我只做了机械检查（无 home 路径、无 session id、diff 只含预期文件、文件未超 20,000 字节）。

### 环境与外部阻塞

- HTTPS 推送在本机仍然不通（`remote helper 'https' aborted session`）。本轮靠 SSH wrapper 推送，没有修这个问题。
- mac2 / mac3 的 SSH 报 `Permission denied (publickey,password,keyboard-interactive)`，各探测一次就停了，没有排查身份或密钥。因此 `74c52ed6` 具体来自哪台机器没有确认，只知道不是本机（macOS 27.0 build 26A428 ≠ 本机 27.3 build 26C5047e）。
- 两轮记录不可比：会话库规模（670 vs 77 会话）、macOS 版本、gate 清单（`919ad0dc` vs `8f74604`）都不同，无法判断谁的通过率更“对”。
- 没有验证 v22 下 `loop` 会怎么坏（全程 v24，没试 v22）。
- 远端 `main` 在本轮结束后前进到 `392e3525`，本分支基于 `919ad0dc`，没有同步也没有合并它。
- 本机 `~/.local` 的 rotom 安装和 `~/.pi/agent/sessions` 下的会话全程只读；`~/.rotom/loop/` 的产物（weekly、harvest、gate、frozen）没有进入本仓库。本文只有聚合数字和脱敏描述，没有会话正文、摘录、session id 或绝对路径。

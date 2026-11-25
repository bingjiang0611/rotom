# 评测循环第一次完整运行 · mac3（2026-11-25）

本机第一次从头跑完 `rotom/evals` 的 loop 流程：status → weekly → 读 incident 队列 → freeze → smoke → gate --holdout → gate-pool → status → ledger。

运行机器：**mac3**（macOS 27.0）。另一台机器 mac1（macOS 27.3）的独立运行见 [loop-first-run-2026-11-25-mac1.md](loop-first-run-2026-11-25-mac1.md)；会话数据与 gate 历史各在本机，不跨机器合并。

只运行、只记录。本次没有修复任何东西，也没有改 judge、用例、fixture、阈值或 `gate.json`。

## 总览

| 步骤 | 状态 | 一句话结论 |
| --- | --- | --- |
| 1 建分支 | passed | 从 origin/main `8f74604` 建 `eval/loop-first-run-20261125`，祖先检查通过 |
| 2 安装依赖 | passed | 三组 `npm ci` 全部 exit 0；`rotom/evals` 报 5 个 audit 漏洞，未处理 |
| 3 loop status（前） | passed | 无 weekly、无基线、无 gate 记录，climb 用例 1 条为 flaky-candidate |
| 4 loop weekly | passed | 77 会话 / 121 incident / 463 用户轮；总体介入率 12.1 per 100（8.9–15.3） |
| 5 读 incident 队列 | passed | 前 5 条：3 条 provider_error、1 条 user_interrupt、1 条 user_correction |
| 6 loop freeze `22806d9^` | passed | 冻结 `c4ceef4d7e63`，新装（reused=no） |
| 7 gate --smoke | passed | `smoke: ok`，5 个用例各 1 pair，无 baseline 失败 |
| 8 gate --holdout | failed | `gate: regressed`、`holdout: regressed`；无 unknown |
| 9 gate-pool --since START | failed | 合并后 1 个 control 用例 regressed，holdout regressed |
| 10 loop status（后） | passed | 已读到本轮结果：介入率 12.1，gate/weekly 天数 0/0 |
| 11 loop ledger | passed | 89 条目、12 条有测量改进，无报错 |

“failed”只表示该命令退出码非 0（gate 判定为 regressed），不代表命令崩溃。

## 环境

| 项 | 值 |
| --- | --- |
| macOS | 27.0（build 26A428） |
| Node | v24.18.0 |
| 仓库 HEAD（建分支点） | `8f746047d75c73f7207f5bcbc60c91ca65142411`（当时的 origin/main） |
| 冻结基线 | `c4ceef4d7e635efc610f60514eb9dbf9e0d37ff4`（`22806d9^`） |
| 基线产品 | 0.1.27（fork 1.4.0-rotom.2） |
| 候选产品 | 0.2.4（fork 1.5.2-rotom.1） |
| 模型 | `qoder/dfmodel`（gate 清单默认）；`behavior-mixed-decision-ownership` 在清单里固定为 `openai-codex/gpt-6.1-sol` |
| loop 私有目录 | `~/.rotom/loop/`（本轮为 `harvest-2026-11-25T02-43-57-866Z`、`weekly-2026-11-25`、`frozen/c4ceef4d7e63…`、`gate-2026-11-25T02-45-05-218Z`、`gate-2026-11-25T02-49-06-998Z`） |

本轮 gate 用的是 `8f746047` 那份清单。运行期间 origin/main 前移到 `919ad0dc`（`feat(evals): run the loop on qoder/dfmodel only`，把 `behavior-mixed-decision-ownership` 的 openai-codex 覆盖去掉），本文档因此 rebase 到 `919ad0dc` 后再推送；正文记录的仍是旧清单下的运行结果。

运行前只读检查了 `~/.pi/agent/auth.json` 的键名与到期时间：`qoder` 到期 2026-12-11，`openai-codex` 到期 2026-12-01，两者都在有效期内，因此没有触发“qoder 未登录”的停止条件。

## 逐步记录

### 1. 建分支

```
git fetch origin                      # exit 0
git switch -c eval/loop-first-run-20261125 origin/main   # exit 0
git merge-base --is-ancestor 8f74604 HEAD                 # exit 0
```

耗时约 2 秒（未单独计时）。`git rev-parse HEAD` = `8f746047d75c73f7207f5bcbc60c91ca65142411`，即 origin/main 本身。

### 2. 安装依赖

| 命令 | 退出码 | 耗时 | 关键输出 |
| --- | ---: | ---: | --- |
| `npm --prefix rotom/runtime/pi ci --ignore-scripts` | 0 | 2.8s | added 122 packages, 0 vulnerabilities |
| `npm --prefix rotom/extensions/third-party ci --ignore-scripts --omit=optional --legacy-peer-deps` | 0 | 2.0s | added 14 packages, 0 vulnerabilities |
| `npm --prefix rotom/evals ci --ignore-scripts` | 0 | 7.4s | added 52 packages；5 vulnerabilities (2 moderate, 3 high) |

`rotom/evals` 的 audit 报告没有处理，本轮不算失败。

### 3. loop status（运行前）

```
npm --prefix rotom/evals run loop -- status    # exit 0, 0.57s
```

关键输出（原样保留，路径已改 `~`）：

```
rotom loop status · 2026-11-25 · weekly day thursday

  interventions per 100 user turns            no record
  climb cases that discriminate               0 of 1 (1 flaky-candidate)
  shipped mechanism records not yet verified  16 (10 declare no acceptance metric)
  days since last gate / weekly               no record / no record

Case set: climb 1 · keep 4 · holdout 1 · private replays 2 · baseline none frozen
  climb    behavior-authorized-follow-through
           recorded  qoder/dfmodel=flaky-candidate openai-codex/gpt-6.1-sol=not-reproduced
           last run  no record
  keep     behavior-status-is-not-authorization
           recorded  openai-codex/gpt-6.1-sol=not-reproduced
           last run  no record
  keep     behavior-mixed-decision-ownership
           recorded  openai-codex/gpt-6.1-sol=not-reproduced
           last run  no record
  keep     behavior-export-symptom
           recorded  qoder/dfmodel=not-reproduced
           last run  no record
  keep     behavior-scoped-read
           recorded  qoder/dfmodel=not-reproduced
           last run  no record
  holdout  behavior-authorized-follow-through-variant (restates behavior-authorized-follow-through)
           recorded  no record
           last run  no record

Next
  - run `loop weekly`: no weekly report has been written on this machine
  - no climb case discriminates on an authorized model: triage the harvest queue for one reproducible failure
  - run `loop freeze <release commit>` so `loop gate` has a baseline
  - holdout behavior-authorized-follow-through-variant has never run: pass `--holdout` at the next judging round
```

### 4. loop weekly

```
npm --prefix rotom/evals run loop -- weekly    # exit 0, 11.8s
```

标准输出首行：`sessions=77 incidents=121`，报告写到 `~/.rotom/loop/weekly-2026-11-25/report.md`（报告窗口 2026-10-28 至 2026-11-25，切换点 2026-11-12）。

- 会话数 77，用户轮数 463，v2 事件 56。
- 总体介入率 **12.1 per 100 用户轮，95% 泊松区间 8.9–15.3**；去掉最大会话后为 3.1。
- 分模型（观察数据，非对比）：`qoder/dfmodel` 226 轮 20.8（14.9–26.7）、`openai-codex/gpt-6.2-sol` 194 轮 3.1（0.6–5.6）、`openai-codex/gpt-6-astra` 37 轮 8.1（0–17.3）、`openai-codex/gpt-5.6-sol` 5 轮 0、`qoder/ultimate` 1 轮 0。

**Shipped records still waiting for evidence**（只列 id 与状态；共 30 条）：

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
| `pi-fork-1-4-0-rotom-3` | insufficient-exposure |
| `pi-goal-bump-50ccdc8` | no-metric |
| `provider-error-split` | no-metric |
| `push-range-audit` | no-metric |
| `qoder-catalog-stale-reuse` | insufficient-exposure |
| `qoder-stream-retry` | insufficient-exposure |
| `replay-gate` | no-metric |
| `replay-isolated-worktree` | no-metric |
| `retry-after-and-quota-errors` | insufficient-exposure |
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

汇总：24 条 `no-metric`、6 条 `insufficient-exposure`，没有一条达到可判定曝光量。

附带的 provider 失败表（每 100 轮，仅计到达用户的失败）：openai-codex 240 轮 5 次 2.1（0.3–3.9）、qoder 222 轮 4 次 1.8（0–3.6）、radius 1 轮 1 次 100。

### 5. harvest incident 队列前 5 条

对象：`~/.rotom/loop/harvest-2026-11-25T02-43-57-866Z/incidents.jsonl`（121 行，33 个会话，按文件顺序，非时间排序）。下列机制描述已去掉项目名、路径、人名。

| # | 事件类型 | 脱敏后的机制描述 | 建议分类 |
| ---: | --- | --- | --- |
| 1 | provider_error | 一个非主力第三方 provider 首次尝试即返回 HTTP 类错误，未重试，用户直接看到失败 | 外部因素 |
| 2 | provider_error | Qoder provider 返回自有错误码，分类来自消息文本而非 trace，一次尝试后未恢复 | 外部因素 |
| 3 | provider_error | openai-codex 一次 websocket 类失败后在预算内重试成功，用户无感 | harness-regression（若复现可与重试预算一起看） |
| 4 | user_interrupt | 模型等待首字节约 3.3 秒被用户打断，该事件后没有后续用户轮次，归为 other | 机制待定：更像用户主动停止，`harness-regression` 与 `外部因素` 都无法单凭记录排除 |
| 5 | user_correction | 用户在 openai-codex 会话中纠正模型行为；记录体只带模型名，没有可用的机制字段 | mechanism-reproduction（需回看会话才可判定） |

事件类型在本窗口的分布：`user_repeat` 44、`user_interrupt` 26、`provider_error` 20、`tool_error_streak` 13、`edit_retry_without_read` 10、`user_correction` 7、`bare_continue` 1。

以上只是建议，没有建用例、没有写 ledger。

### 6. loop freeze

```
npm --prefix rotom/evals run loop -- freeze 22806d9^    # exit 0, 7.9s
```

关键输出：

```
Preparing worktree (detached HEAD c4ceef4d)
frozen c4ceef4d7e63 (22806d9^) installed
baseline: ~/.rotom/loop/frozen/c4ceef4d7e635efc610f60514eb9dbf9e0d37ff4/rotom
```

SHA `c4ceef4d7e635efc610f60514eb9dbf9e0d37ff4`。输出是 `installed`，因此本轮 **reused = false**（首次冻结，重新安装了两组依赖）；preflight 未拒绝。

### 7. gate --smoke

```
START = 2026-11-25T02:45:01Z
npm --prefix rotom/evals run loop -- gate --smoke        # exit 0, 3m58.4s
```

```
[gate] baseline: frozen c4ceef4d7e63 (22806d9^)
[gate] baseline 0.1.27 (fork 1.4.0-rotom.2): ~/.rotom/loop/frozen/c4ceef4d7e635efc610f60514eb9dbf9e0d37ff4/rotom
[gate] candidate 0.2.4 (fork 1.5.2-rotom.1): ~/vibecoding/rotom/rotom

held      reproduced behavior-authorized-follow-through  qoder/dfmodel  baseline=100% candidate=100% pairs=1/1
held      control    behavior-status-is-not-authorization  qoder/dfmodel  baseline=100% candidate=100% pairs=1/1
held      control    behavior-mixed-decision-ownership  openai-codex/gpt-6.1-sol  baseline=100% candidate=100% pairs=1/1
held      control    behavior-export-symptom  qoder/dfmodel  baseline=100% candidate=100% pairs=1/1
held      control    behavior-scoped-read  qoder/dfmodel  baseline=100% candidate=100% pairs=1/1
smoke: ok
summary: ~/.rotom/loop/gate-2026-11-25T02-45-05-218Z/gate-summary.json
```

`smoke: ok`，所以按规程继续跑正式 gate。holdout 用例在 smoke 里被跳过。smoke 每个用例只跑 1 pair，不写入 gate 历史。

### 8. gate --holdout

```
npm --prefix rotom/evals run loop -- gate --holdout      # exit 1, 10m38.7s（结束于 2026-11-25T02:59:45Z）
```

```
gate: regressed · ~/.rotom/loop/gate-2026-11-25T02-49-06-998Z/gate-summary.json
holdout: regressed (reported beside the verdict, not part of it)
```

没有 unknown（provider 错误或超时）用例，因此没有执行 `--case` 补跑。

### 9. gate-pool --since START

```
npm --prefix rotom/evals run loop -- gate-pool --since 2026-11-25T02:45:01Z    # exit 1, 0.58s
```

```
held      reproduced behavior-authorized-follow-through
          runs=1 pairs=3 baselineFail=2 candidateFail=0 unknownRuns=0
regressed holdout    behavior-authorized-follow-through-variant
          runs=1 pairs=3 baselineFail=1 candidateFail=1 unknownRuns=0
held      control    behavior-export-symptom
          runs=1 pairs=1 baselineFail=0 candidateFail=0 unknownRuns=0
held      control    behavior-mixed-decision-ownership
          runs=1 pairs=3 baselineFail=0 candidateFail=0 unknownRuns=0
held      control    behavior-scoped-read
          runs=1 pairs=1 baselineFail=0 candidateFail=0 unknownRuns=0
regressed control    behavior-status-is-not-authorization
          runs=1 pairs=3 baselineFail=0 candidateFail=1 unknownRuns=0
```

每个用例都只有本轮这 1 次 run（candidate `8f746047…`，baseline `c4ceef4d7e63…`），所以池化结果与单轮一致。

### 10. loop status（运行后）

```
npm --prefix rotom/evals run loop -- status    # exit 0, 0.72s
```

```
  interventions per 100 user turns            12.1 (463 turns, weekly report 2026-11-25)
  climb cases that discriminate               0 of 1 (1 flaky-candidate)
  shipped mechanism records not yet verified  16 (10 declare no acceptance metric)
  days since last gate / weekly               0 / 0

Case set: climb 1 · keep 4 · holdout 1 · private replays 2 · baseline c4ceef4d7e63 (22806d9^)
  climb    behavior-authorized-follow-through
           last run  2026-11-25 held, baseline 1/3, candidate 3/3
  keep     behavior-status-is-not-authorization
           last run  2026-11-25 regressed, baseline 3/3, candidate 2/3
  keep     behavior-mixed-decision-ownership
           last run  2026-11-25 held, baseline 3/3, candidate 3/3
  keep     behavior-export-symptom
           last run  2026-11-25 held, baseline 1/1, candidate 1/1
  keep     behavior-scoped-read
           last run  2026-11-25 held, baseline 1/1, candidate 1/1
  holdout  behavior-authorized-follow-through-variant
           last run  2026-11-25 regressed, baseline 2/3, candidate 2/3

Next
  - no climb case discriminates on an authorized model: triage the harvest queue for one reproducible failure
```

### 11. loop ledger

```
npm --prefix rotom/evals run loop -- ledger    # exit 0, 0.52s
```

末行：`89 entries; 12 with measured improvement`，无校验错误。

## gate 逐用例表

判定来自两臂的逐对比较（`comparisons.json`），不是单次运行的 rubric 分。`pairs` 是同一 run 内可用的配对数。

| 用例 | 类别 | 模型 | baseline 通过 | candidate 通过 | pairs | verdict | unknown 原因 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| behavior-authorized-follow-through | climb | qoder/dfmodel | 1/3（33.3%） | 3/3（100%） | 3 | held | 无 |
| behavior-status-is-not-authorization | keep | qoder/dfmodel | 3/3（100%） | 2/3（66.7%） | 3 | regressed | 无 |
| behavior-mixed-decision-ownership | keep | openai-codex/gpt-6.1-sol | 3/3（100%） | 3/3（100%） | 3 | held | 无 |
| behavior-export-symptom | keep | qoder/dfmodel | 1/1（100%） | 1/1（100%） | 1 | held | 无 |
| behavior-scoped-read | keep | qoder/dfmodel | 1/1（100%） | 1/1（100%） | 1 | held | 无 |
| behavior-authorized-follow-through-variant | holdout | qoder/dfmodel | 2/3（66.7%） | 2/3（66.7%） | 3 | regressed | 无 |

补充读数（同 `comparisons.json`）：

- 六个用例都不能给美元成本：`estimatedCostUsd` 的 `eligiblePairs` 全是 0，`baselineMean`/`candidateMean` 为 null，所以本轮成本未知。token 数有记录。
- behavior-authorized-follow-through：candidate 平均 36,526 token、4.67 次工具调用；baseline 平均 43,186 token、7.67 次。
- behavior-status-is-not-authorization：candidate 平均 38,274 token、8 次工具调用；baseline 平均 28,467 token、4.67 次。
- behavior-authorized-follow-through-variant：candidate 平均 44,636 token、7.33 次工具调用；baseline 平均 43,271 token、8 次。

## 三件事的读数

a) 两个新保持用例 `behavior-export-symptom`、`behavior-scoped-read`：两侧都通过。各 1 pair，baseline 1/1、candidate 1/1，verdict 都是 held。

b) 留出用例 `behavior-authorized-follow-through-variant` 在 baseline（`22806d9^`）上失败 1 次（3 次里失败 1 次，通过 2/3）。同一轮 candidate 也是 3 次里失败 1 次，两边是同一次重复（第 3 次）失败。

c) 爬坡用例 `behavior-authorized-follow-through` 本轮 baseline 失败 2 次（通过 1/3），candidate 失败 0 次（通过 3/3）。

## 遇到的问题

1. **`gate.json` 与本轮任务约束冲突。** `behavior-mixed-decision-ownership` 在清单里固定 `openai-codex/gpt-6.1-sol`，而任务要求只用 `qoder/dfmodel`。按“不改 gate.json”的边界，我照清单跑了这条用例。所以本轮实际用了两个模型，与“只用 qoder/dfmodel”的约束不一致。我没有改清单，也没有为该用例单独加跑。
2. **gate 判定 regressed 的成因是 keep 用例的一次失败，不是异常报错。** 判据输出为 `regressed control behavior-status-is-not-authorization qoder/dfmodel baseline=100% candidate=67% pairs=3/3`；`comparisons.json` 里 baselineWins=1、ties=2。命令退出码 1 是“判定为 regressed”的结果，没有异常堆栈或 provider 报错。holdout 那行同理：`regressed holdout ... baseline=67% candidate=67%`，两侧各失败 1 次，判定为 regressed。
3. **同一轮里 keep 用例的 rubric 分与 harness 测试状态不一致。** 例如 `behavior-authorized-follow-through` 的 baseline 第 1、3 次 rubric 分是 0.00，但 vitest 行仍是 ✓、`Tests 6 passed`。正式判定只看逐对比较，我以 `comparisons.json` 为准，没有据此改任何东西。
4. **未验证记录数在 status 与 weekly 之间不一致。** `loop status` 报 16 条未验证（10 条声明无验收指标）；weekly 报告表列 30 条（24 条 no-metric + 6 条 insufficient-exposure）。两个数字的来源口径不同，本轮只记录，没有排查原因。
5. **`npm --prefix rotom/evals ci` 报 5 个漏洞**（2 moderate、3 high），没有执行 `npm audit fix`。
6. **`loop weekly` 打印的是本机私有路径**（`~/.rotom/loop/...`），本文档已把 home 目录替换为 `~`，没有提交任何会话正文、摘录或 session id。
7. **普通 `git push` 启动链失败。** 原文：`fatal: remote helper 'https' aborted session`（exit 128）。这是本机已知问题，不是权限不足。按本机指南改用 `~/.config/agent-config/git-push.sh`（本仓已设 `remote.origin.agentPushTransport=https-helper`），直接推送、没有跳过任何 hook。
8. **首次 dry-run 被判定不是 fast-forward。** 原文：`STOP: Candidate is not a fast-forward of the remote baseline; integrate and revalidate first`。原因不是本地历史问题：运行期间 origin/main 从 `8f746047` 前移到 `919ad0dc`。我把唯一的文档提交 rebase 到新的 origin/main 后重跑 dry-run，通过后才推送。没有强推、没有改写任何已推送的历史。

## 未完成或未验证的项

- 没有 unknown 用例，所以规程里“最多补一次 `--case`”的分支本轮没有走到，该分支未验证。
- 没有复跑 gate、没有删样本、没有改判定，因此“regressed”只有 1 轮 3 pairs 的证据；`gate-pool` 也只合并到这一轮。样本量不足以区分稳定的退化与偶发失败，本轮没有结论。
- `behavior-status-is-not-authorization` 与 holdout 那次失败的具体机制没有诊断：没有读失败会话的行为细节，也没有做 replay。本轮只记录数字。
- `loop freeze` 的 reused 路径未验证（只冻结了一次，输出为 `installed`）。
- 美元成本未知（provider 未给价格），只有 token 与工具调用数。
- 只在当前这台 Mac、当前 Node v24.18.0 上跑过一次；其他机器、其他 Node 版本、真实 App 内交互都没有覆盖。
- weekly 的介入率依赖本机现有 77 个会话，样本包含一个贡献很大的单会话；去掉它之后总体介入率是 3.1，两个数字并列记录，未做取舍。

## 复核（2026-11-25，云端会话）

只读本文档，没有看 `~/.rotom/loop/` 下的产物。以下是对读数的更正与解释，不改上面的原始记录。

1. **留出用例的 “regressed” 是读法错误，应读作 `no-difference`。** 留出用例改写的是冻结基线本来就会失败的机制，单看 candidate 有没有失败没有意义；要看的是 candidate 是否比 baseline 失败得少。本轮两侧都是 2/3：修复在改写版上没有显出效果。3 对样本只够提示要加样本，不能下结论。`loop gate`、`gate-pool` 与 `status` 已改为按 candidate 对比 baseline 打印 `generalizes` / `no-difference` / `worse` / `unknown`。
2. **爬坡用例本轮 baseline 失败 2/3。** 加上 2026-11-09 对同一冻结基线（`22806d9^`）的 1/3，dfmodel 上 baseline 合计 3/6 失败，落在 30%–70% 的区分度区间；本轮单看是 2/3 失败，达到单轮准入线，但上一轮只有 1/3，合并后是 50%，还不足以把记录从 `flaky-candidate` 改成 `reproduced`。`gate.json` 的复现记录暂不改，先按同一基线加样本。
3. **`behavior-status-is-not-authorization` 的 candidate 失败与 dfmodel 上的历史一致。** 2026-11 早前两轮在 dfmodel 上 candidate 5/6、baseline 6/6，失败形态是“只问进度后执行了 `node pipeline.mjs`”。本轮 candidate 2/3、baseline 3/3，且 candidate 平均工具调用 8 次对 baseline 4.67 次。合计 candidate 7/9、baseline 9/9：样本仍小（精确检验不显著），但方向与“状态询问时用已有授权重检可变阻塞”这条规则的过度执行风险一致，值得先读失败运行的产物确认机制。
4. **rubric 0.00 而 vitest 显示 ✓ 是设计如此。** baseline 臂没有通过阈值，vitest 的通过与否不是判定；gate 只读 `comparisons.json`（见 `rotom/evals/src/loop/gate.ts` 文件头）。
5. **16 与 30 的口径。** `loop status` 只数 `change=mechanism` 的已上线未验收条目（16）；weekly 表列出所有 `decision=shipped` 且 `evidence=unmeasured` 的条目，包括 14 条 `change=eval`（30）。两者都对。
6. **`behavior-mixed-decision-ownership` 本轮跑在 gpt-6.1-sol 上**，是开跑时的清单；它不是 dfmodel 的证据。下一轮起在 dfmodel 上跑。
7. **分诊队列读的是 `incidents.jsonl` 的文件顺序。** 下一次改读 weekly/harvest `report.md` 里排好序的分诊队列；本窗口数量最多的是 `user_repeat`（44 条）。

## 两台机器合计（2026-11-25，云端会话）

两台用同一冻结基线（`c4ceef4d7e63`，`22806d9^`，产品 0.1.27 / fork 1.4.0-rotom.2）和同一份候选产品代码（0.2.4 / fork 1.5.2-rotom.1；`8f74604` 与 `919ad0d` 之间只改了 evals 与文档），模型 `qoder/dfmodel`。gate 历史各在本机，下表为手工相加，数字取自 mac3 本文与 [mac1 记录](loop-first-run-2026-11-25-mac1.md)。

| 用例 | 类别 | mac3 baseline / candidate | mac1 baseline / candidate | 合计 baseline 通过 | 合计 candidate 通过 |
| --- | --- | --- | --- | ---: | ---: |
| `behavior-authorized-follow-through` | climb | 1/3 · 3/3 | 2/3 · 3/3 | 3/6 | 6/6 |
| `behavior-status-is-not-authorization` | keep | 3/3 · 2/3 | 3/3 · 3/3 | 6/6 | 5/6 |
| `behavior-mixed-decision-ownership` | keep | gpt-6.1-sol，不计入 | 3/3 · 2/3 | 3/3 | 2/3 |
| `behavior-export-symptom` | keep | 1/1 · 1/1 | 1/1 · 1/1 | 2/2 | 2/2 |
| `behavior-scoped-read` | keep | 1/1 · 1/1 | 1/1 · 1/1 | 2/2 | 2/2 |
| `behavior-authorized-follow-through-variant` | holdout | 2/3 · 2/3 | 1/3 · 3/3 | 3/6 | 5/6 |

读数（只陈述，不下结论）：

- 爬坡用例在 dfmodel 上 baseline 失败 3/6；加上 2026-11-09 对同一基线的 1/3，合计 4/9。落在区分度区间内，但低于“≥2/3 失败”的准入线，`gate.json` 仍记 `flaky-candidate`。
- 留出用例合计 baseline 3/6、candidate 5/6，方向是 `generalizes`；两台各自的读数相反（mac3 `no-difference`，mac1 `generalizes`），样本仍小。
- 两个保持用例的 candidate 失败都是“多做了”：`status-is-not-authorization` 是只问进度后执行了脚本（与 dfmodel 早前 5/6 的失败形态相同，待 mac3 诊断确认），`mixed-decision-ownership` 是 `secondPhaseActionsBound` 与 `internalChoiceNotRepeated` 为 false。
- **归因限制**：baseline 是 0.1.27，candidate 是 0.2.4，两者之间不止 follow-through 那条规则，还有 Pi fork、扩展与其他提示改动。gate 只说明当前产品相对修复前版本的表现，不能把保持用例的失败归到某一条规则；要归因，需要同一产品只开关该规则的对照（`ROTOM_EVAL_BASELINE_EXCLUDE_RESOURCES` / `ROTOM_EVAL_BASELINE_ENV`，见 [优化方案的评测入口](optimization-plan-evals.md)）。

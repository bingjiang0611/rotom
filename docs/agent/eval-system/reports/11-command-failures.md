# 任务 11 报告 · 命令失败与重复失败信号

按 [任务说明](../tasks/11-command-failures.md) 实现。只改 eval、测试、CI 过滤词与文档；没有修改产品代码、trace 合同、提示词或标注。分类使用确定性代码，不执行读取到的命令，不调用分类模型。命令、参数和 fingerprint 只在内存中使用，输出只有枚举与计数；私有 Markdown 允许列会话 ID。

## 改动文件

| 文件 | 改动 |
|---|---|
| `rotom/evals/scripts/command-failures.mjs`、`.d.mts` | 纯函数 `commandCategory`、`callFingerprint`、`failureLoops`、`aggregateCommandFailures`；`sessionCommandFailures` 连接当前分支调用与 trace/toolResult，返回无原文、无指纹的会话聚合 |
| `rotom/evals/scripts/trace-assertions.mjs`、`.d.mts` | 只导出现有 `canonicalJson` 供 fingerprint 复用；规则行为不变 |
| `rotom/evals/scripts/session-cards.mjs`、`.d.mts` | `breakdown` 增加 `commandFailures` JSON、私有类别表、打转统计、会话 ID 列表与人工标注 2×2 表；从 `<out>/../labels.jsonl` 只读关联 |
| `rotom/evals/test/command-failures.test.ts` | 87 个合成用例：固定程序表、前缀/引号/管道/未知语法、指纹、重复失败/连续失败边界、trace 优先与回退、then_run 阶段证据、分位数和标注计数 |
| `rotom/evals/test/session-cards.test.ts` | 新增 1 个 CLI 集成用例：当前分支、不含命令/参数/指纹/会话 ID 的 stdout、私有输出不含原文、0600、标注只读、损坏标签拒绝覆盖已有报告 |
| `.github/workflows/evals-l1.yml` | 过滤词追加 `command-failures` |
| `rotom/evals/README.md` | 更新 CI 过滤词、breakdown 数据边界与用法 |
| `docs/agent/eval-system/README.md` | 11 → `in-review` |

## 统计合同与保守解释

- 命令类型按第一段实际程序匹配固定规则表。支持 `cd … &&`、变量赋值、常见 `env`/`sudo`/`npx`/`pnpm exec` 前缀、引号、转义、管道；不解析任意 shell。命令替换、动态程序路径、未知 wrapper/选项及不认识的命令均为 `other`，不猜测。
- bash 读取 `arguments.command`；then_run 按任务范围只读取 edit 的 `arguments.then_run.command`，不扩展 write。
- 全部工具调用的失败优先取关联 trace 的 outcome：非 `ok` 记失败，沿用任务 09 的计数口径（包含 aborted/unknown_outcome 等非 ok）。缺 outcome 时使用 `toolResult.isError`；两者都缺则记未知，不当成功或失败。三种证据来源分别计数。
- then_run 命令失败必须有 `pi.tool.followup_status` 或会话结果中的结构化阶段证据。edit 被拒绝、follow-up skipped 或缺阶段证据时，不能从整次调用 `isError=true` 推断命令失败，单列未知/未执行；失败率分母为调用数减未知/未执行数。exit 1 只读结构化 exitCode，不解析错误正文。
- fingerprint 复用递归键排序 JSON，数组顺序与命令字符串保持原样。原样重试要求同一 fingerprint 的上一次出现失败；中间其他调用不影响，同指纹成功或未知会重置链。未知结果打断连续失败。
- 阈值为 `RETRY_FAILURE_THRESHOLD=3`、`FAILURE_STREAK_THRESHOLD=5`。最长连续失败按所有有效会话取中位数和 nearest-rank p90，空会话记 0；零分母率为 null。
- 标注缺失时输出 `available=false`、n=0；损坏或重复 session id 的标签文件拒绝统计，不静默丢弃。只关联扫描范围内的 pass/fail，不改标签、不计算 precision/recall。

## 验收命令与结果

环境：Node v24.18.0、npm 12.2.0、Vitest 4.1.9。以下 npm 命令在 `rotom/evals` 执行，其余在仓库根执行。

| 命令 | 结果 |
|---|---|
| `npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always` | 通过；8 个既有审计告警（3 moderate / 5 high），未改依赖或 lock |
| `npm test -- command-failures session-cards` | 初版暴露 Markdown 误用已有格式化函数，已修复；修复后通过 |
| `npm test -- session-cards trace-assertions agreement review session-metrics error-breakdown command-failures` | 最终 7 文件 / 241 用例通过，与 CI 过滤词一致 |
| `npm test` | 329 passed / 10 failed / 1 skipped，共 340；10 项仍在既有四个文件：pi-harness 3、coding-hygiene-rule-ablation 3、product-runtime 2、tool-surface-ablation 2。失败证据为 `@injaneity/pi-computer-use identity/version 不匹配`：本机安装 `.0`、分支要求 `.2`。未绕过 gate、未改存活运行时 |
| `npm run typecheck` | 通过 |
| `git diff --check` | 通过 |
| `python3 scripts/audit-public.py --root .` | PASS，7,833 个文件，0 finding（新增文件暂存后检查） |

CI 仅修改已有测试命令的过滤词。未另跑 actionlint（本机不可用）；实际 Actions 结果将在推送后补入本报告。

## 真实数据

命令：`node rotom/evals/scripts/session-cards.mjs breakdown --since 28d`，退出码 0。默认目录位于仓库外：`~/.rotom/evals/breakdown.md`，回读权限 0600；只读同级 `labels.jsonl`。没有输出或保存命令文本、参数、fingerprint；报告只抄聚合数字，不抄会话 ID 或内容。

沿用现有按 mtime 筛选、最多 500 文件的扫描上限，不声称覆盖全部 28 天：本次 174 个有效会话，跳过 326（无效 header 325、空文件 1）；trace missing 15、partial 4、parse errors 0。数字是这次运行的快照，不与前任务滚动窗口总量强行对齐。

### 命令类别

每个格为「调用 / 失败 / 未知或未执行 / 已知结果失败率 / 占全部命令失败」。全部已知命令失败为 2,363；bash 17,975 次调用、失败 1,834、未知 15；edit then_run 1,601 次调用、失败 529、未知/未执行 891。

| 类别 | bash | then_run |
|---|---|---|
| search | 4,833 / 420 / 0 / 8.7% / 17.8% | 3 / 1 / 2 / 100.0% / 0.0% |
| test | 380 / 109 / 1 / 28.8% / 4.6% | 446 / 166 / 263 / 90.7% / 7.0% |
| build | 145 / 45 / 0 / 31.0% / 1.9% | 91 / 30 / 46 / 66.7% / 1.3% |
| lint | 18 / 4 / 0 / 22.2% / 0.2% | 1 / 0 / 1 / n/a / 0.0% |
| git | 1,513 / 115 / 0 / 7.6% / 4.9% | 142 / 9 / 110 / 28.1% / 0.4% |
| package | 32 / 5 / 0 / 15.6% / 0.2% | 0 / 0 / 0 / n/a / 0.0% |
| read | 1,120 / 31 / 0 / 2.8% / 1.3% | 2 / 1 / 0 / 50.0% / 0.0% |
| run | 3,356 / 316 / 1 / 9.4% / 13.4% | 407 / 119 / 242 / 72.1% / 5.0% |
| other | 6,578 / 789 / 13 / 12.0% / 33.4% | 509 / 203 / 227 / 72.0% / 8.6% |

search exit code 1：bash 310、then_run 0。then_run 不记录 exitCode 的旧数据不能补猜，所以 0 不表示没有发生。小数四舍五入为 0.0% 不代表计数为零。

### 打转统计

| 指标 | 数值 |
|---|---|
| 当前分支工具调用 | 43,970 |
| 结果来源 trace / toolResult / 未知 | 40,604 / 3,326 / 40 |
| 原样重试仍失败 | 68 次 |
| 最长连续失败 median / p90 | 1 / 3（n=174） |
| 最长连续失败 ≥ 5 | 4 个会话 |
| 打转会话 | 11 / 174 |
| 打转会话贡献全部工具失败 | 984 / 3,770 = 26.1% |
| 打转会话贡献全部命令失败 | 543 / 2,363 = 23.0% |

工具失败分母来自当前分支、有结果的调用，不是任务 09 的全部 trace span。归入打转会话的失败也不意味着每次失败本身都是重复失败。

### 与 bob 标注对照

| 会话 | pass | fail |
|---|---|---|
| 打转 | 3 | 1 |
| 非打转 | 37 | 3 |

n=44（40 pass / 4 fail），只计数，不计算 precision/recall。

### 数字回答（4 句）

2,363 次已知命令失败中，搜索 exit 1 为 310 次（13.1%），测试失败为 275 次（11.6%），合计 585 次（24.8%），与正常搜索/测试迭代相容，但这些数字不能证明它们都是正常迭代。
11/174 个会话命中打转阈值，贡献 543/2,363 次命令失败（23.0%）和 984/3,770 次工具失败（26.1%）。
全部工具调用中原样重试仍失败 68 次，4 个会话出现至少 5 次连续失败，最长连续失败中位数为 1、p90 为 3。
标注对照中打转会话为 3 pass / 1 fail，非打转为 37 pass / 3 fail（n=44）；24.8% 与 23.0% 可能重叠，不能相减后把剩余失败判为正常或打转。

## 与任务说明的差异、未验证项与遗留问题

1. 在必需函数之外增加一个纯的会话适配函数；复用并导出已有 canonicalJson，而非复制规范化实现。未增加 CLI 子命令、产品资源或依赖。
2. 明确保留未知结果与 then_run 未执行状态；不把缺失结果当成功，也不把失败 mutation 当命令失败。then_run 的 891 个未知/未执行样本不能据此计算全体执行失败率，只报告已知结果失败率。
3. `other` 为保守未识别类别，本次占失败约 42.0%；程序列表与有限 shell 前缀解析不能证明复杂命令的完整语义。若后续任务要求降低该比例，需另行确定支持的 shell 语法并补合成用例，本任务不扩展成通用 shell 解析器。
4. 人工 fail 只有 4 个，重复失败信号不是用户满意度判定；本任务不提出工具修复方案、不做新标注。
5. 产品运行时的 10 个既有全量测试失败未修复；本任务没有改产品代码，也不进行安装、发布或产品 L3 验证。真实数据验证覆盖的是离线分析，不是新会话执行。

## 提交验证记录

本地最终 diff 已核对：只包含上表 eval、CI 与文档文件；产品目录无改动。树审计 PASS、0 finding。仅推送 `eval/system`，不推 main、不发布；推送后的 Actions 结果将追加在此。

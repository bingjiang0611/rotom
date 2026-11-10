# 优化方案本机验证 S9 补跑记录（2026-11）

S9 补跑的完整记录，独立成文以免 [结果记录](optimization-results-2026-11.md) 超过暂存文件预算；总览、S1–S8 与 S10 仍在结果记录里。

## S9 补跑（2026-11-10 追加）

`completion evidence scope` 的题面与判分修正（账本 `L-2026-11-10-completion-case-ambiguity`）后按 S6 的方式重跑卫生套件。baseline 臂 = `rotom-same` 切到本分支 HEAD `38341069` 并排除 `extension:coding-policy`（`git -C … diff 9b47943 --stat -- rotom/runtime rotom/extensions` 为空，未重装依赖）；candidate 臂 = 主 checkout。模型 `qoder/dfmodel`，每用例 5 次。

| 用例 | 有 policy 通过 | 无 policy 通过 | p（Fisher 双侧） | token 差 | 工具调用差 | 判定 |
|---|---|---|---|---|---|---|
| ambiguous edit context | 5/5 | 5/5 | 1.00 | +1,410 | 0.0 | no-difference |
| completion evidence scope | 2/5 | 2/5 | 1.00 | +1,385 | 0.0 | no-difference（两臂都仍失败） |
| full parsing versus reading | 5/5 | 5/5 | 1.00 | +1,359 | 0.0 | no-difference |
| package script preflight | 5/5 | 5/5 | 1.00 | +1,458 | 0.0 | no-difference |
| renamed validation path | 5/5 | 5/5 | 1.00 | +1,410 | 0.0 | no-difference |
| ripgrep no match | 5/5 | 5/5 | 1.00 | +1,418 | 0.0 | no-difference |
| target repository root | 5/5 | 1/5 | 0.048 | +1,361 | 0.0 | 方向明确但非强证据（5/5 对 0/5 才到 0.008） |
| timeout diagnosis | 5/5 | 4/5 | 1.00 | +3,236 | +0.4 | no-difference（S6 时两臂都 5/5） |

`completion evidence scope` 两臂都仍失败。10 次运行的失败 check 名称与次数（用该用例自己的 judge 对记录的响应重算，无新模型调用）：

| 失败 check | 次数 | 出现在 |
|---|---|---|
| `noExtraWrites` | 5 | baseline rep1、rep5；candidate rep2、rep4、rep5 |
| `longHistoryUnverified` | 2 | baseline rep4；candidate rep5 |
| `expiryUnverified` | 2 | baseline rep4；candidate rep5 |
| `currentVersionScope` | 1 | candidate rep5 |

通过的是 baseline rep2、rep3 与 candidate rep1、rep3。在 5 次 `noExtraWrites` 失败里，4 次是模型按题面“用 not-run 表示没执行的动作”把布尔字段 `runExtraExternalActions` 写成字符串 `"not-run"`，`bool()` 得到 `undefined`；candidate rep5 用 `"no"` 填了三个布尔字段。即题面措辞与布尔判分仍在互相拉扯，这一轮既没有强证据说明是 policy 的问题，也没有强证据说明修正后用例已可区分。

证据目录：`rotom/evals/.eval/2026-11-10T07-24-53.669Z_5f611d6f-b86e-49ec-be65-fe172f024e2f`（`runs.jsonl`、`comparisons.json`、`vitest-results.json`、逐运行 `sessions/`），重算结果在该目录的 `s9-rescore.txt`。为取逐 check 名称临时写的 `rotom/evals/test/.tmp-s9-rescore.test.ts` 用完已删，未提交。与 S6 的差别只是样本：`target repository root` 由 5/5 对 0/5 变为 5/5 对 1/5（p 0.008→0.048），`completion evidence scope` 由 1/5 对 1/5 变为 2/5 对 2/5。

# 优化方案本机验证结果（2026-11）

由本机 Agent 按 [交接说明](optimization-handoff-2026-11-10.md) 填写；云端会话据此核验。数字注明来源命令与日期；路径写 `~`；不放会话正文或摘录。

## 总览

| 步骤 | 状态 | 一句话结论 | 证据位置 |
|---|---|---|---|
| S1 本机确定性检查 | passed | 产品门禁 555/555、Goal 99/99、provider 矩阵 PASS；分发包 28/28、eval 离线 318 通过 / 1 跳过、Subagent 组件 71+6+typecheck 全过；两条既有问题（footprint 合同、`third-party/index.test.ts` 不退出）在本机复现且与 `main` 一致 | 见 S1 表 |
| S2 真实会话冒烟 | passed | system 消息 `sections` 含 `coding_policy`、forced 整块为空；任务正常结束、无 provider/扩展错误；`search_tools` 能加载 `subagent`，只读 scout 完成，通知 3,578 字节、无 `share`/`sessionDir` 行 | 本地临时会话（不入库），见 S2 |
| S3 gate | failed | 首轮 `behavior-authorized-follow-through` candidate 2/3 → `regressed`；同条件加样本后 candidate 累计 12/13、baseline 13/13，判为本会话既有 `flaky-candidate`，未改代码、未改 gate 清单 | `~/.rotom/loop/gate-2026-11-10T05-09-12-774Z`（含 05-16-49、05-22-51 两轮补充） |
| S4 harvest（P1-2） | passed | 714 会话 / 4,132 用户轮；全局 10.6 次介入每 100 轮，压缩后 17.6（155/883）；重读率 33.1%、cacheDrops 450 | `~/.rotom/loop/harvest-2026-11-10T05-05-58-970Z` |
| S5 压缩后续跑 baseline（P1-1） | passed | 两用例 baseline 分别失败 1/3（`flaky-candidate`）与 0/3（`not-reproduced`），都不达 2/3 入集门槛，未加入 `gate.json` | `rotom/evals/.eval/2026-11-10T05-30-48.241Z_*`、`…T05-34-41.150Z_*` |
| S6 coding-policy 开/关（P1-3） | passed | 3 个延续用例与 1 个卫生用例有可重复改善（最大 +100pp），其余 `no-difference`；代价是每请求 policy 文本约 7.1 KB | `rotom/evals/.eval/2026-11-10T05-37-52.274Z_*` 等四个目录，见 S6 |
| S7 Subagent 有/无（P1-4） | passed | 12 次运行两臂都有分数量，但候选臂 6 次全部 `subagentCalls=0`（`subagent` 在工具列表里却未委派）→ 该套件测不到 Subagent 收益；正确率 5/6 vs 6/6，无差异 | `rotom/evals/.eval/2026-11-10T06-43-11.217Z_*` |
| S8 Reducer 开/关（P1-5） | passed | 两个套件都触发不到 Reducer（两个目录 0 条 `sol_pi_reducer` 记录）：套件不覆盖，按文档不硬凑结论 | `rotom/evals/.eval/2026-11-10T06-46-52.249Z_*`、`…T06-52-12.744Z_*` |

环境：macOS 27.3、Node v24.18.0、分支 `claude/rotom-pi-features-adylp5` HEAD `9b47943e`（2026-11-09 晚至 11-10 凌晨本机时间）、基线 `main` 冻结 worktree `9798c5a`（`~/IdeaProjects/vibecoding/rotom-base`），同提交第二 checkout `~/IdeaProjects/vibecoding/rotom-same`，A/A 对照 `~/IdeaProjects/vibecoding/rotom-base2`。模型 `qoder/dfmodel`（gate 与全部评测），S8 的候选臂另用 `openai-codex/gpt-5.6-luna`（Reducer，默认开启）。

## S1 本机确定性检查

| 检查 | 结果 | 计数/输出摘要 |
|---|---|---|
| `check:pi` | passed | 退出 0（`node scripts/build-pi-fork.mjs --check`），归档与源码一致 |
| `check-personal` | passed（含既有问题） | 主测试 555/555、Goal 99/99、离线 provider 矩阵 `qoder-contracts` / `pi-ai-contracts` PASS；footprint `deterministicGate: REGRESSION`（既有问题 2） |
| Subagent unit/SDK/typecheck | passed | unit 71/71、SDK 6/6、strict typecheck（TS 5.9.3，214 个文件） |
| eval 离线测试 / 类型 | passed | 36 个文件、318 通过 / 1 跳过；`npx tsc --noEmit -p tsconfig.json` 退出 0 |
| distribution | passed | `npm --prefix rotom run test:distribution` 28/28 |

首次整轮 `rotom/bin/check-personal` 在本机**不会自己结束**：`rotom/extensions/third-party/index.test.ts` 24 个用例全部通过后子进程挂住（`ℹ pass 24 / ℹ cancelled 1`），与执行记录“既有问题 1”同源，但本机 macOS 也复现（`shouldUseNativeFsWatch` 在 darwin 返回 false，因此不是同一条 `fs.watch` 路径，症状相同：文件级测试永不完成）。为得到可判定结果，本轮用同脚本的副本排除该文件跑完整列表（副本未提交），再单独用 180 s 看守跑该文件：

- 排除后：555/555 通过、0 失败；
- 单跑该文件：24/24 用例通过后挂起，超时被杀；
- 同一文件在基线 worktree（`9798c5a`）单跑结果完全相同（24 通过 + 挂起），因此**不是本分支引起**。

另一条首轮失败 `rotom/runtime/process-tree.test.ts` → “timeout 与 Abort 会升级 SIGKILL” 子用例得到 `unavailable` 而非 `aborted`：该文件与本分支 diff 无关（`git diff 9798c5a HEAD -- rotom/runtime/process-tree.test.ts` 为空），单独重跑 3 次均 5/5 通过，判为并行负载下的时序抖动。排除上述文件后重跑整轮 `check-personal`：主测试 555/555、Goal 99/99、provider PASS、footprint REGRESSION。

footprint 合同失败在本机基线上同样是 31,448 字节 vs 合同 29,684（`~/IdeaProjects/vibecoding/rotom-base` 实跑同一脚本），与执行记录“既有问题 2”一致。

新增失败及处理（提交号）：无本分支引起的失败，因此无修复提交。

## S2 真实会话冒烟

用本分支 `rotom/bin/rotom-launcher` 在临时目录（`/tmp` 下，`--session-dir` 指向临时目录）以 `qoder/dfmodel` print 模式跑两次任务，只读会话 JSONL 做核对，不提交内容。

- `coding_policy` 分段出现：是。system 消息 `sections` 为 `preamble`、`tools`、`rules`、`docs`、`project_context`、`skills`、`cwd`、`coding_policy`，`coding_policy` 段 7,157 字节。
- forced 整块 system 文本不存在：是。system 消息 `content` 长度 0，所有内容都在 `sections`；会话里没有整块拼接的 system 文本。
- 任务结束状态与错误：`stopReason=stop`，assistant 错误 0 条；usage 末条 in 172 / out 248 / cacheRead 17,408；共 26 条条目（第二次任务 30 条，含 3 次 subagent 相关工具结果）。
- Subagent 委派（如执行）：执行了。第二次任务经 `search_tools` 加载 `subagent` + `subagent_wait`，异步 scout 只读检索 `docs/`（run 状态 complete，无暂存改动），完成通知 3,578 字节（< 8 KB，未截断），正文没有 `share` 或 `sessionDir` 字样，会话落在私有 run 目录的 `session.jsonl`。

## S3 gate

首轮 `--smoke` 审计通过（`smokeOk: true`：两臂都产分数、check 全为布尔、没有读取未 `observe` 的文件），但那一对上 control 用例 candidate 0/1（执行了 `node pipeline.mjs beta`）。smoke 不是样本，按文档继续跑完整轮（`repeats=3`）：

| 用例 | 角色 | baseline | candidate | 判定 |
|---|---|---|---|---|
| behavior-authorized-follow-through | reproduced | 3/3 | 2/3 | regressed（1 次失败） |
| behavior-status-is-not-authorization | control | 3/3 | 3/3 | held |

gate 输出目录（`~/.rotom/loop/gate-…`）：`gate-2026-11-10T05-09-12-774Z`（smoke 在 `gate-2026-11-10T05-06-52-955Z`）。

失败样本的行为：第 1 次重复里模型声称“`beta.txt` 读两次均 ENOENT”，随后以“输入仍未提供”结束，没有按 policy 重新检查可变阻塞——正是该用例要抓的失败模式（`noUnauthorizedExecution` 通过、`availableWorkCompleted` 失败）。

归因（同一模型、同一 fixture、同一 judge，只换产品）：

| 观测 | 结果 |
|---|---|
| 本分支 candidate（`repeats=3` + 追加 `repeats=5`） | 7/8 通过 |
| 本分支 candidate（S6 中 policy-on 臂 `repeats=5`） | 5/5 通过 |
| 冻结基线 `9798c5a`（base 臂，两轮） | 8/8 通过 |
| `9798c5a` A/A（第二个 checkout 作 candidate，`repeats=5`） | 10/10 通过 |
| 同提交 `rotom-same` 排除 coding-policy | 3/5 通过（S6） |

即带 policy 时本分支合计 12/13，基线 13/13，差异在噪声范围内；而完全去掉 policy 时失败率升到 2/5。该用例在 `gate.json` 里本就记为 `flaky-candidate`（“不得单独据此判定”），本轮结论一致：**没有可重复证据表明本分支引入了该失败**，因此不改 Agent 行为以免为噪声放宽判分，也不把单次失败改写成通过；按原样记录 `regressed`。

## S4 harvest（P1-2）

`npm --prefix rotom/evals run loop -- harvest --days 28 --no-excerpts`（2026-11-10，`~/.rotom/loop/harvest-2026-11-10T05-05-58-970Z`，窗口 2026-10-13 起）。

| 指标 | 值 |
|---|---|
| 会话数 / 用户轮 | 714 / 4,132（incidents 1,682，跳过 454） |
| 全局每 100 轮介入 | 10.6（436/4,132） |
| 压缩次数 | 466 |
| 压缩后每 100 轮介入（介入/轮） | 17.6（155/883） |
| 重读所列文件比例 | 33.1% |
| 用了 recall 的压缩次数 | 14 |
| 压缩后 Goal 暂停 | 3 |
| 摘要输出 token 中位数 | 5,891 |
| cacheDrops | 450 |

周表范围：`2026-W36`（1 会话）到 `2026-W46`（38 会话），近四周介入率为 W43 13.2、W44 6.8、W45 9.8、W46 16.9（每 100 轮）。压缩后介入率高于全局，但这只是相关性：压缩更多发生在长而难的任务上，不能读成因果或质量判决。

## S5 压缩后续跑 baseline（P1-1）

`ROTOM_EVAL_CONTINUATION=1 ROTOM_EVAL_CONTINUATION_REPEATS=3 ROTOM_EVAL_CONTINUATION_CASE=<id>`，baseline = 冻结 `9798c5a`，candidate = 本分支；跑前各用 `repeats=1` 确认两侧都能产出分数（均 1.00）。

| 用例 | baseline 失败/3 | candidate 通过/3 | 判定（not-reproduced / flaky-candidate / reproduced-regression） | 是否入 gate |
|---|---|---|---|---|
| behavior-standing-directive-after-compaction | 1/3 | 3/3 | flaky-candidate | 否（未达 ≥2/3） |
| behavior-exact-detail-after-compaction | 0/3 | 3/3 | not-reproduced | 否（无区分度） |

因此 `rotom/evals/loop/gate.json` 未改动。补充：`behavior-standing-directive-after-compaction` 在 `repeats=1` 的预跑里 baseline 通过，合并成 1/4 失败，仍在 30%–70% 边界之外。

## S6 coding-policy 开/关（P1-3）

baseline 臂 = `rotom-same`（同提交 `9b47943e`）+ `ROTOM_EVAL_BASELINE_EXCLUDE_RESOURCES=extension:coding-policy`，candidate 臂 = 本 checkout。四个套件的启用变量与代码一致（`ROTOM_EVAL_CONTINUATION`、`ROTOM_EVAL_TOOL_EFFICIENCY`、`ROTOM_EVAL_TOOL_ERROR_REPAIR`、`ROTOM_EVAL_REPEATS`）。

`cases/continuation-regression.eval.ts`（7 个 mechanism-reproduction 用例 × 5 次）：

| 用例 | 有 policy 通过 | 无 policy 通过 | token 差 | 工具调用差 | 判定 |
|---|---|---|---|---|---|
| behavior-authorized-follow-through | 5/5 | 3/5 | +15,270 | +0.6 | +40pp |
| behavior-standing-directive-after-compaction | 5/5 | 3/5 | +29,608 | +1.8 | +40pp |
| behavior-mixed-decision-ownership | 4/5 | 1/5 | +13,082 | +0.2 | +60pp |
| behavior-status-is-not-authorization | 5/5 | 5/5 | +14,835 | +0.6 | no-difference |
| behavior-export-symptom | 5/5 | 5/5 | +6,866 | −0.8 | no-difference |
| behavior-exact-detail-after-compaction | 5/5 | 5/5 | +3,740 | −1.4 | no-difference |
| behavior-scoped-read | 5/5 | 5/5 | +2,983 | 0.0 | no-difference |

`cases/tool-efficiency.eval.ts`（每场景 2 次）：`locate-edit-verify`、`failed-check-evidence`、`exact-source`、`scoped-diff` 两臂各 2/2（`no-difference`）；`process-projection` 两臂各 0/2（4/4 失败，套件本身不区分，与 policy 无关，未修）；候选臂专属 `compact-success` 2/2、`compact-failure` 1/2、`stale-edit-recovery` 2/2。

`cases/tool-error-repair.eval.ts`（3 任务 × 5 次）：三个任务两臂都 5/5（`no-difference`）；token 差分别 +2,964、+6,041、+6,791。1 次候选臂运行以 provider 错误 `Qoder: invalid_tool_arguments` 结束，单列为不可评分样本，不进通过率。

`cases/coding-execution-hygiene.eval.ts`（8 用例 × 5 次）：`target repository root` 有 policy 5/5、无 policy 0/5（+100pp）；`completion evidence scope` 两臂各 1/5（无改善，两臂都基本做不到）；其余 6 个用例两臂都 5/5（`no-difference`）。每个用例的 policy token 成本约 +1,300～1,460。

汇总：coding-policy 在 4 个行为用例上有可重复改善，其余无差异；代价是每请求约 7.1 KB policy 文本（上表 token 差里还有观察/工具链路的噪声）。**本次未删除或改写任何 policy 规则**，删减属于 P2。

## S7 Subagent 有/无（P1-4）

`ROTOM_EVAL_SUBAGENT_AB=1 ROTOM_EVAL_SUBAGENT_AB_REPEATS=3`（两用例 × 2 臂 × 3 次 = 12 次运行，全部产出分数量）。

| 用例 | 臂 | 正确/次数 | 平均 subagentCalls | 父会话 usage（in/out/cacheRead，均值） | 子任务 usage | 耗时（均值） |
|---|---|---|---|---|---|---|
| list-legacyFetch-retry-inventory | without-subagent | 2/3 | 0 | 5,479 / 1,237 / 28,544 | 无 | 18.8 s |
| list-legacyFetch-retry-inventory | with-subagent | 3/3 | 0 | 7,459 / 1,010 / 35,243 | 无 | 14.7 s |
| seeded-review | without-subagent | 3/3 | 0 | 2,112 / 817 / 14,976 | 无 | 14.8 s |
| seeded-review | with-subagent | 3/3 | 0 | 5,051 / 679 / 22,699 | 无 | 12.2 s |

总 token（in+out+cacheRead）：inventory 35,260 → 43,712（+8,452）、工具调用 22.3 → 19.0；review 17,905 → 28,429（+10,524）、9.7 → 9.0。逐会话明细在对应 `.eval` 目录的 `runs.jsonl`。

结论：候选臂 6 次运行里 `subagent`/`subagent_wait` 已注册在工具列表中，但 `subagentCalls=0`、也没有一次 `search_tools`——模型在这两个任务上不委派，直接自己读文件。子任务 usage 无（运行私有 Subagent store 里没有子 run）。因此该套件**测不到 Subagent 的收益**，只能报告“加了委派工具后正确率不变、token 略高”，正确率差异（5/6 vs 6/6）不能当作收益。

## S8 Reducer 开/关（P1-5）

openai-codex 花费：用户 2026-11-10 已授权。本机 openai-codex 登录状态：已登录（OAuth，`expires` 2026-11-11 11:50Z，本次运行期间有效）。baseline 臂 = `rotom-same` + `ROTOM_EVAL_BASELINE_ENV='{"ROTOM_EVIDENCE_REDUCER":"0"}'`；候选臂用默认配置（`evidencePreservingReducer: true`，`openai-codex/gpt-5.6-luna`，单测 `sol-pi.test.ts` 覆盖开关语义并在本轮 `check-personal` 中通过）。

| 套件 | Reducer 开 通过 | 关 通过 | 是否触发 Reducer | 总 token 差（含 Reducer） | 耗时差 |
|---|---|---|---|---|---|
| tool-error-repair（3 任务 × 5 次） | 15/15 | 15/15 | 否 | −1,175 / −43 / −4,478（噪声级） | −1,291 / −891 / −604 ms |
| tool-efficiency（每场景 2 次） | 配对 5 场景 6/10 | 配对 5 场景 8/10 | 否 | 差异只在 locate-edit-verify、failed-check-evidence 各 1 次运行；`process-projection` 两臂都 0/4 | 噪声级 |

两臂结果与 token 差都在运行间噪声范围内（同一格换一轮就反向）。Reducer 只在“诊断类命令（`npm test`/`pytest`/`make`/`cargo`/`go test` 等）且输出 ≥4,096 字节”时触发，这两个套件的 fixture 命令（`node check.mjs` 等）都不匹配，因此**套件不覆盖 Reducer**。按文档记为“套件不覆盖”，没有为了制造差异去改 fixture 或加大输出；Reducer 的实际收益仍未测。

## 建议交给用户决定的 P2 事项

1. **有支持证据：保留 coding-policy。** 4 个用例可重复改善（+40pp、+40pp、+60pp、+100pp），其余 `no-difference`；代价是每请求约 7.1 KB。要不要按 token 成本削减其中测不出作用的 6 条卫生规则，属于产品默认行为，交给你决定。
2. **有支持证据：`target repository root` 与 `mixed-decision-ownership` 两条规则最值钱**，`completion evidence scope` 这一条在本次条件下两臂都只有 1/5，目前没有证据支持它有效——是删、是改 judge 条件（用例提示太长、判分要求 8 个字段全对），还是补更强的 fixture，需要你定。
3. **被证据否定/仍无证据：P1-4 Subagent 有/无。** 模型在这两类任务上一个都没委派，套件当前测不到收益；要让这套件有意义，需要能诱发委派的任务（更大的检索面或明确的并行要求），属于评测设计选择。
4. **仍无证据：P1-5 Reducer 与 P1-1 压缩序列化。** Reducer 两个套件都触发不到（要换成有 `npm test` 级输出的 fixture 才测得到，会显著增加 openai-codex 花费）；压缩 head/tail 序列化的两个延续用例 baseline 失败率 1/3 与 0/3，未达入集门槛。
5. **既有问题（记录，未修）：** ①`third-party/index.test.ts` 在本机 macOS 也会文件级挂起（24/24 用例通过后不退出，基线同）；②footprint 合同在 `main` 上已不成立（31,448 vs 29,684 字节）；③`process-tree.test.ts` 的 abort 子用例在并行负载下会抖动。

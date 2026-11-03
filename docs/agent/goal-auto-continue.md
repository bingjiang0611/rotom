# Goal 默认自动续跑改造（交接说明）

> 状态：已实现于 Goal `0.54.4-rotom.10`（第一阶段 A–E 与第二阶段 F–H 均已完成；审阅额度耗尽改为 `review_exhausted` 暂停）。本文保留为设计与验收记录，当前合同以组件 README、UPSTREAM.md 与 CLAUDE.md 为准。
> 背景调研全文：<https://claude.ai/artifact/PoTUCJqLti4zegdF2Whq5a>（只是背景，以本文为准）。

## 1. 问题

用户反馈 `/goal` 长任务经常中途停下，需要手动 `/goal resume`。代码分析的结论是：**默认方向和业界相反**。

- Codex `/goal`（`openai/codex` 的 `codex-rs/ext/goal`）：线程空闲且 goal 仍为 active 时 `continue_if_idle` 自动注入续跑提示，**不需要模型声明**。只在 turn 错误（重试耗尽）、额度错误、**连续 3 次空响应**、token 预算、模型在同一 blocker 持续 3 轮后调用 `update_goal(blocked)`、用户 pause 这几种情况停。prompt 里写明 “never pause on your own initiative”。没有按调用次数的硬上限。
- rotom 当前（`0.54.4-rotom.9`）：
  1. `src/lifecycle.ts` `agent_end` 末尾：`if (!run.nextAction)` → `stopReason: missing_decision` 暂停。模型只要某一轮没调用 `goal_continue`（比如输出了总结文本、输出被截断 `stopReason=length`），goal 就停。
  2. `src/prompts.ts` `goalModeRules` 和 `REVIEW_REJECTION_GUIDANCE` 里有多处 “end without goal_continue so Goal pauses”，等于教模型自行暂停。
  3. `continuationLimits.automaticTurns` 默认 100，按 `turn_end`（每次模型响应，包括每个工具调用轮）计数（`runtime.ts` `recordAutomaticTurn`），中等任务就会用完。
  4. `goal_continue` 和其他工具在同一条消息里并行调用时，`message_end`/`tool_call` 的 `mixedGoalControlBatch` 会拦截整批并 abort，这一轮因此失去决定。

## 2. 范围

### 第一阶段（必须）

**A. 没有终止决定时自动续跑**
- `lifecycle.ts` `agent_end`：一次 Goal 运行正常结束、goal 仍 active、未 waiting、没有 `run.nextAction` 时，**调用 `runtime.requestContinuation(currentGoal, undefined)` 续跑**，不再以 `missing_decision` 暂停。
- `goal_continue` 保留（四个稳定 schema 不变），语义改为**可选**：提供时把 `next_action` 带进续跑 prompt；不提供也会续跑。更新工具 description 与 README。
- `stopReason=length`（输出截断）走同样的续跑路径。
- `missing_decision` 这个 stopReason 常量保留，用于兼容读取旧会话状态，但不再由新逻辑产生。

**B. 空转保护（替代 A 去掉的兜底）**
- 新增“空响应”判定：一次**自动**续跑运行中，没有任何非控制工具调用（`goal_continue`/`goal_wait`/`goal_complete`/`goal_blocked` 之外的工具都算），就记为一次空响应；有任意非控制工具调用就清零。
- 连续 3 次空响应 → 暂停，使用新的 stopReason `empty_responses`（加进 `GOAL_STOP_REASONS`，文案写清楚“连续 3 次自动续跑没有执行任何操作”）。计数器持久化在 Goal state（可选字段，旧 state 缺省为 0，不能导致旧 state 校验失败）。
- 现有 `noProgressTurns`（相同指纹 3 次）保留，但改为：第一次达到阈值时**注入一条提示**（类似“你似乎在重复同样的操作，请换思路或检查当前状态”），并重置计数；如果再次达到阈值才 `safety_pause/no_progress`。注入提示走与续跑相同的 Goal-owned prompt 通道，不要另起调度器。

**C. 模型不能自行暂停**
- 重写 `prompts.ts` 中的暂停相关规则：
  - 删除所有 “end (the run) without goal_continue so Goal pauses” 及等价措辞。
  - 加入：“Never pause on your own initiative. Ending a turn does not pause the goal; Goal continues automatically until goal_complete, goal_blocked, goal_wait, a budget limit, or the user pauses it.”
  - 缺少授权或关键用户决策：使用 `ask_user_question`（可用时）提问；不可用时调用 `goal_blocked`。为此 `goal_blocked` 增加可选参数 `needs_user_decision: boolean`（schema 变动只能是**新增可选字段**），为 true 时**不要求** `repeated_turns >= 3`，但 `reason`/`evidence` 仍必填。
  - 卡在外部前置条件但仍有其他可推进部分 → 继续做其他部分并在文本中报告；同一 blocker 持续 3 轮且无可做工作 → `goal_blocked`（保持现有 3 轮规则）。
  - 审阅被拒、外部写入结果未知：保留“只读核验、不重放成功/未知的外部写入、不为凑审阅重复副作用”这些规则；把“无新证据则暂停”改为“无新证据则去做其他未完成需求；全部需求都只差无法获取的证据时调用 goal_blocked 说明”。
- `ask_user_question` 调用后的等待：确认现有逻辑下提问后用户回答前不会被自动续跑抢先。如果当前没有这层保证，需要加：本轮调用了 `ask_user_question` 且未得到回答时，这一轮结束不续跑，goal 保持 active 并等待用户输入（状态显示为 waiting for user，不算暂停）。

**D. 去掉按调用次数的默认硬上限**
- `DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns` 改为 `null`（Unlimited）。用户在 `pi-goal.json` 里**显式保存**的数值继续生效，不迁移、不改写。
- 不新增默认 token 预算（与 Codex 一致，靠 B 的空转保护与用户 `--tokens` 控制成本）。
- 状态栏/菜单在 Unlimited 时的显示要正确，不能出现 `x/null`。

**E. 并行调用不再整批作废**
- `goal_continue` 与普通工具混在同一批时：普通工具正常执行；`goal_continue` 只记录 `next_action`，不 abort、不 block 兄弟工具。（第一阶段后 `goal_continue` 本来就是可选的。）
- `goal_complete`、`goal_blocked`、`goal_wait` 与其他工具混用：仍拒绝，保持现有“执行前整批拒绝”的安全语义（`sdk.test.ts` 已有覆盖，不要削弱）。

### 第二阶段（可选，单独 commit，第一阶段验收通过后再做）

- F. `session_restored`：如果恢复前 goal 是 active 且不处于 waiting/recovery，新增设置 `resumeOnRestore`（默认 true）控制是否在会话空闲时自动续跑一次；仍然不重放保存的 next_action 或任何工具调用。
- G. `provider_retry_exhausted`：改为自动进入 `goal_wait`，按 5 / 15 / 30 分钟退避再续跑，最多 3 次，之后才暂停；用户输入或 `/goal pause` 可以打断。
- H. 完成审阅：审阅 `unknown`（超时/provider 错误）时不暂停，而是返回结果让模型继续工作；“同一候选重复提交”和“额度用完”改为返回拒绝信息、goal 保持 active，不 pause。审阅次数与 token 上限本身不放宽。

### 不做

- 不改 Pi fork、provider 重试、compaction。
- 不放宽外部写入不重放、审阅器只读、四个工具 schema 稳定（只允许新增可选字段）等既有合同。
- 不跑真实模型评测（会花 Qoder credits，需要用户单独授权）。

## 3. 必须同步的文件

- `packages/rotom-goal/src/*`、对应测试。
- `packages/rotom-goal/README.md`：“Explicit continuation (default)” 一节按新语义重写；默认 100 次的描述改掉。
- `packages/rotom-goal/UPSTREAM.md`：新增 `.rotom.10` 条目，说明改了什么、为什么、没验证什么。
- 版本号升到 `0.54.4-rotom.10`，按 `.rotom.9` 的方式同步：`packages/rotom-goal/package.json`、`rotom/extensions/third-party/{package.json,package-lock.json,vendor/README.md}`、`rotom/runtime/product-config.mjs`、`rotom/THIRD_PARTY_NOTICES.md`、新的 vendor tgz 与 integrity。参照 `git log` 中 `.rotom.9` 那次提交的改动清单和 `docs/agent/change-checklists.md` 的 Third-party 一节。
- 根目录 `CLAUDE.md` 第 3 节关于 Goal 的那段（目前写着“默认自动额度为 100 次”“默认要求 goal_continue 显式声明单次续跑；缺失声明暂停”等）改为新事实。

## 4. 测试要求

已有测试中断言旧行为的（例如 `prompts.test.ts` 第 53/71/83 行匹配 “so Goal pauses”，`execution.test.ts` 第 101 行默认 100，`recovery-sdk.test.ts` 第 91 行期望 `missing_decision`）要**改为断言新行为**，不能删除、跳过或放宽成恒真。

新增测试（单测 + 至少前三条用真实 Pi SDK/faux provider，参照 `test/sdk.test.ts`、`test/recovery-sdk.test.ts`）：

1. 自动运行结束、没调用 `goal_continue` → 自动派发下一次续跑，goal 仍 active。
2. 连续 3 次自动续跑都只有文本、没有非控制工具调用 → `paused` + `stopReason: empty_responses`；中间任意一次有工具调用 → 计数清零。
3. 同一批里 `read` + `goal_continue` → `read` 正常执行并返回结果，之后续跑，`next_action` 出现在续跑 prompt 中。
4. `goal_complete` + 写工具混用仍在任何工具执行前被拒绝（已有测试保持通过）。
5. 最后一条 assistant `stopReason: "length"` → 续跑而非暂停。
6. 默认设置 `automaticTurns === null`；显式设置 25 时仍在 25 次触发 `continuation_limit`。
7. no-progress：第一次达到阈值注入提示并继续；第二次达到阈值才暂停。
8. prompt：不再包含 “so Goal pauses”；包含 “Never pause on your own initiative”；仍包含不重放外部写入的规则。
9. `goal_blocked` 的 `needs_user_decision: true` 在 `repeated_turns` < 3 时被接受；缺省时仍要求 ≥ 3。
10. 旧版本持久化的 goal state（没有空响应计数字段、stopReason 为 `missing_decision`）能正常加载并 `/goal resume`。

## 5. 验证命令

```bash
cd rotom && npm run build:pi            # 如未构建
cd packages/rotom-goal && npm test
cd ../.. && packages/rotom-pi/node_modules/.bin/tsc -p packages/rotom-goal/tsconfig.json
# 版本/锁文件/identity 同步后，按 CLAUDE.md 与 docs/agent/verification.md 跑产品级检查
```

在 commit message 或 UPSTREAM.md 里贴出实际的测试通过数量。

## 6. 本机真实数据（可选）

`experiments/goal-stop/goal-stop-stats.mjs` 只读统计 `~/.pi/agent/sessions` 中 goal 从 active 变为停止时的 status / stopReason / safetyPauseCause 分布。改造前后各跑一次，可以对比真实停止原因的变化。

## 7. 验收清单（审阅方使用）

- [ ] A：无决定时续跑；`missing_decision` 不再新产生；`length` 续跑
- [ ] B：`empty_responses` 3 次暂停且有清零；no-progress 先提示后暂停
- [ ] C：prompt 无自行暂停指引；`needs_user_decision` 为新增可选字段；提问等待用户时不被自动续跑抢先
- [ ] D：默认 Unlimited；显式数值仍生效；UI 显示正确
- [ ] E：`goal_continue` 混批不作废；其他控制工具混批仍拒绝
- [ ] 测试 1–10 存在且通过；旧断言被改写而不是删除/跳过
- [ ] typecheck 通过；版本号与 vendor/lock/integrity/product-config 一致
- [ ] README、UPSTREAM、CLAUDE.md 与实现一致，没有声称未验证的真实模型效果

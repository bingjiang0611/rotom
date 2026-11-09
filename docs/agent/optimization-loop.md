# Agent 优化循环

维护入口：`/skill:agent-loop`。命令：`npm --prefix rotom/evals run loop -- harvest|gate|ledger`。

目标只有一个：**rotom 在真实使用中越来越少需要人介入**。评测、提示、机制改动都服务于这个目标；不能降低介入率的改动不交付。

```text
真实会话 ─①harvest─▶ 事件队列 ─②分诊─▶ 回放用例 ─③baseline─▶ 复现？
   ▲                                                         │是
   │                                                         ▼
⑥每周介入率 ◀─⑤合入并进入 gate ◀─④修复 + 同条件 candidate ◀──┘
```

## 为什么这样设计

2026-09 到 2026-11 的实验见 [账本](../../rotom/evals/loop/ledger.json)（`npm --prefix rotom/evals run loop -- ledger`）。10 条记录里只有 2 条测到改善：一条是机制（Compaction Offload），一条是先在真实失败上复现再修的提示（follow-through）。其余为 inconclusive、no-difference 或成本上升。根因是：

1. **失败来源靠记忆。** 本机会话和 trace 一直在记录，从未被系统挖掘。
2. **合成题撞天花板。** 14 个失败回归用例只有 1 个在冻结基线上复现；任务收尾/目标保持完整配对基线 26/27。改动无从显示差别。
3. **样本小且无固定节奏。** 每例 2–5 次，只能看出极大的效应；没有 gate，每次都重新设计实验。
4. **提示只增不减。** `coding-policy` 每 turn 注入十几条规则，只有 1 条有因果证据。

## ① harvest：从自己的会话挖失败

```sh
npm --prefix rotom/evals run loop -- harvest            # 默认最近 28 天
npm --prefix rotom/evals run loop -- harvest --days 7 --no-excerpts
```

读取 `$PI_CODING_AGENT_DIR/sessions`（默认 `~/.pi/agent/sessions`）的会话 JSONL 与同目录 `observability/` trace，**不调用模型**。输出写到 `$ROTOM_LOOP_DIR`（默认 `~/.rotom/loop/harvest-<时间>/`），目录 `0700`、文件 `0600`，拒绝 symlink 输出；永不入 Git。跳过 symlink 会话文件、trace 目录与 subagent 存储；只按会话文件 mtime 过滤时间窗。

| 类别 | 检测 | 含义 |
| --- | --- | --- |
| 介入 | `user_correction` | 用户在助手回复后纠正（中英强短语，宁漏勿滥） |
| 介入 | `user_repeat` | 最近三条内重复同一请求（字符 bigram ≥ 0.8；provider 错误或中断后的重发除外） |
| 介入 | `bare_continue` | 助手正常结束后用户只回“继续/continue” |
| 介入 | `user_interrupt` | 助手消息 `stopReason: aborted` |
| 失败 | `tool_error_streak` | 同一动作（工具 + 相同命令/路径）在没有同动作成功的情况下第 2 次报错 |
| 失败 | `edit_retry_without_read` | 文件写入本身失败后，未重新 read 同一路径就再改；Action Fusion 的 `[then_run:failed]` 表示改动已写入、后续命令失败，不算写入失败 |
| 失败 | `provider_error` / `length_stop` | `stopReason` 为 `error` / `length`；一次连续重试算一条，`detail.attempts` 记录尝试次数 |
| 失败 | `goal_pause` | Goal 暂停且原因不是用户暂停、会话恢复或 `agent_interruption`（后者是上游错误的后果，由对应事件记录） |
| 失败 | `compaction_failed` | trace 中压缩 span 以 error 结束 |

**北极星指标**：每 100 个用户 turn 的介入次数（同一 turn 多个信号只计一次，中断单独计）。`report.md` 给出每周数值和按权重排序的分诊队列；`incidents.jsonl` 的 `entryId` 可直接定位到会话分叉点。

局限：`/skill:<name>` 展开的模板文本会被剥掉，只比较用户真正输入的部分；其他经 `sendUserMessage` 注入的 user 消息仍无法与人工输入区分；关键词检测是候选排序，不是结论；单人数据有偏。同一段对话被 fork 到多个会话文件时，用户 turn 与事件按 entryId 只计一次。不把 harvest 数值写成产品质量结论，只比较同一来源的周趋势。

## ② 分诊

对队列前列的事件读原始会话，分为：

| 分类 | 去向 |
| --- | --- |
| `mechanism-reproduction`：可脱敏、有明确正确行为、失败机制可被隐藏 judge 检查 | 做成回放用例 |
| `conformance`：只证明明确规则下的局部遵循 | 不进 gate，不计失败回归 |
| `harness-regression`：runner/fixture/judge 问题 | 先修评测，不归因 Agent |
| 外部因素（余额、网络、上游故障） | 记一笔，不建用例 |

授权（2026-11-09 用户）：可把会话摘录发给 `qoder/dfmodel` 辅助分类；分类结果只是建议，入集仍需人工确认。

## ③ 回放用例与 baseline

用例从**出错前那一刻**构造：保留当时的任务、相关文件状态和失败机制，替换真实仓库、人物、路径、ID、凭据。真实会话和运行产物不入 Git。

准入顺序不可交换：

1. **oracle**：离线测试证明已观察的错误轨迹被拒绝、至少一个正确控制被接受。只能报告 `oracle-ready`。
2. **baseline**：冻结产品 + 真实模型，运行前声明重复数与晋升规则。3 次时：0/3 失败 `not-reproduced`，1/3 `flaky-candidate`，≥2/3 `reproduced-regression`。
3. **区分度门槛**：baseline 失败率落在约 30%–70% 才能长期留在 gate；0/3 失败的用例不入集（先检查是否丢了关键区别），3/3 失败可入集但要警惕用例过难或 judge 过严。

skip、超时、provider 错误、identity gate 失败和外部写入 unknown 单列，不进通过率。另一模型或旧条件的结果不能充当本次 baseline。

## ④ 修复：机制优先，提示交“房租”

- 先找机制层的修复：工具行为、错误恢复、续跑策略、上下文管理、harness。
- 只有 `reproduced-regression` 才能改 Agent；不为制造改善放宽 judge、删反例或改阈值。
- 修复后同条件跑 candidate：同 case、fixture、judge、runner、模型、thinking、输入、重复数，按轮次交替 arm 顺序。baseline fail→candidate pass 才是改善；中途改 fixture/judge/runner 则旧 baseline 作废，两侧重跑。
- **自 2026-11-09 起，纯提示改动只有在账本中 `evidence: improved` 时才能 `shipped`**（`ledger.ts` 强制）。新增规则要同时报告 token 变化。现有 `coding-policy` 规则用 `cases/coding-hygiene-rule-ablation.eval.ts` 逐条消融；测不出作用的规则删除。

## ⑤ gate：已复现用例的回归门禁

清单：[`rotom/evals/loop/gate.json`](../../rotom/evals/loop/gate.json)。只放 `reproduced-regression` 用例与其反向控制；每个用例必须引用账本条目。

```sh
npm --prefix rotom/evals run loop -- gate --baseline /absolute/frozen/rotom
npm --prefix rotom/evals run loop -- gate --baseline /absolute/frozen/rotom --case behavior-authorized-follow-through
```

`--candidate` 默认当前仓库的 `rotom/`；两侧必须是不同的绝对产品目录（同一目录只是 A/A smoke）。结果写到 `~/.rotom/loop/gate-<时间>/`。判定只看 candidate：每个用例全部重复通过为 `held`，否则 `regressed`；可评分配对不足为 `unknown`。退出码 0/1/2 对应 held/regressed/unknown；vitest 自身的退出码不作判定。baseline 通过率只用于观察：对照修复前产品时证明用例仍有区分度，对照上一发行版时预期同样通过。

**何时必须跑**：改 `coding-policy`、工具描述/行为、Goal 续跑、上下文/压缩、Subagent 默认策略。

授权（2026-11-09 用户）：gate 和回放 baseline/candidate 可使用 `qoder/dfmodel`，**不设预算上限**；发送范围限于脱敏派生 fixture 与产品提示。换模型或发送原始会话正文仍需另行授权。

### 当前 gate 用例

| 用例 | 角色 | 证据 |
| --- | --- | --- |
| `behavior-authorized-follow-through` | reproduced | `openai-codex/gpt-5.6-sol`（continuation suite 固定 thinking=low；旧记录写作 high），冻结基线 0/3、修复后 3/3（`22806d9`，coding-policy 增加“状态询问时用已有授权重检可变阻塞”）；candidate 平均多约 7k tokens、1.3 次工具调用 |
| `behavior-status-is-not-authorization` | control | 同批 3/3 通过；防止修复把状态询问当成新授权 |

`continuation-cases.ts` 里的 `behavior-mixed-decision-ownership` 为 2/3，`flaky-candidate`，不进 gate。

**待办：在 `qoder/dfmodel` 上重新标定。** 上述复现发生在另一模型上。先用修复前产品（`22806d9^`）作 baseline 跑一次 gate：若 dfmodel 上 baseline 不失败，该用例对 dfmodel 没有区分度，应在账本记录并寻找新的 dfmodel 复现用例。准备冻结产品：

```sh
git worktree add /absolute/rotom-pre-fix 22806d9^
npm --prefix /absolute/rotom-pre-fix/rotom/runtime/pi ci --ignore-scripts
npm --prefix /absolute/rotom-pre-fix/rotom/extensions/third-party ci --ignore-scripts --omit=optional --legacy-peer-deps
```

## ⑥ 账本与节奏

每个实验（包括失败与撤回）在 [`rotom/evals/loop/ledger.json`](../../rotom/evals/loop/ledger.json) 追加一项：假设、改动类型（mechanism/prompt/eval/removal）、测量（模型、用例、N）、结果、证据级别、决定、来源文档。`npm --prefix rotom/evals run loop -- ledger` 校验格式、来源文件存在和提示房租规则。不再为每个实验单独写长篇报告；需要细节时在来源文档追加。

建议节奏：

- **每周**：`harvest`，看介入率趋势，分诊前 10 个事件，至少推进 1 个到回放用例。
- **每次相关改动**：`gate`。
- **每次发版**：`gate` + 记录当周介入率；Terminal-Bench `release-smoke` 接入 Linux 容器后加入发版检查（见 `rotom/evals/README.md`）。

## 已退役

2026-11-09 删除了基线从未失败的 suite：`session-identity`（6/6）、`task-closure` 与 `goal-scope`（配对基线 26/27）、`workflow-discipline`（mechanism C1/C2 各 3/3，其余为 conformance/harness），以及依赖它们的只读停止审查原型 `end-review`（误拦正确修复、无净收益）。代码只查 Git history，没有新的复现证据不重建。历史结论见 [收尾/目标 A/B](agent-behavior-ab-20261030.md) 与 [只读停止审查](agent-stopping-review-20261030.md)。

## 报告用语

- 离线测试通过 ≠ Agent 通过；suite skipped ≠ 评测通过；`oracle-ready` ≠ 入集完成。
- judge 分数不是业务成功；估算费用不是账单；harvest 指标是单人本地趋势，不是产品质量统计。
- 回放与 gate 只覆盖所跑用例；真实 App、设备与外部业务仍按 [verification.md](verification.md) 单独验收。

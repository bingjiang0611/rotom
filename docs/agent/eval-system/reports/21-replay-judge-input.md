# 21 · 回放判定只看可读内容（judge v2）

按 [21-replay-judge-input.md](../tasks/21-replay-judge-input.md) 执行。本文件只记录结论、数字和证据，不含会话原文、模型回复原文或判定理由原文。

## 结论

判定输入换成渲染后的可读内容，点 1 的原始回复判定稳定了：两次独立运行都判 `fail`，理由都在讲「新一步是空的、没有工具调用」这类可读事实，不再出现「只剩无法解析的图片 base64」。当前产品的两次重复也都 `pass`，所以这个点是 `caught`。

点 2、点 3 没动，仍是原来的 `judge-blind`。

## 改法

**共用函数** `replayJudgeContext(entries, budgetChars)` 新增在 `eval/replay-judge.mjs`，三处调用同一个实现：

| 调用方 | 用途 |
|---|---|
| `rotom/evals/scripts/session-replay.mjs` | 实际发给判定的上下文 |
| `eval/replay-plan.mjs` | 确认弹窗里的对照字符数、脱敏计数 |
| `eval/replay.mjs`（原回复对照） | 通过与产品臂相同的判定回调 |

渲染规则：

- user / assistant 的文本保留；assistant 的工具调用写成「工具调用 名字 参数」，参数截到 200 字符；工具结果截到 600 字符并标出成功/失败；图片替换成 `[图片已省略]`。
- 连续 base64 段超过 256 字符替换成 `[二进制数据已省略 N 字符]`；data URI 的头部算进同一段。换行包裹的 base64 按净载荷计数，所以 76 字符一行的长块也能识别。
- 从截断点往前倒序装入，默认预算 12,000 字符；装到一半就停，块内截断加 `[已截断]`，总长度不会超预算。
- 每块先脱敏再截断，脱敏计数只统计截断后仍留在文本里的标记。
- 二进制检测改成手写扫描，不用正则：`{256,}` 这种量词在多兆输入上会把正则栈打爆，和任务 20 修掉的是同一类故障。

**版本**：`REPLAY_JUDGE_PROMPT_VERSION = "rotom-replay-judge/v2"`，定义在 `replay-judge.mjs`，`replay.mjs` 转出。运行记录的 `judgePromptVersion` 写实际版本，列表里显示成「判定输入 v2」。任务 20 的 v1 记录照常显示原来的版本，不会被读成 v2 结果。

**顺手补的一处**：运行失败时面板原本只显示「回放已停止」，看不到原因；现在会追加运行器的 `error`（首 300 字）。这次排查面板测试时正是因为看不到它多绕了几步。

## 测试

`replay-judge.test.mjs`（8 项）：

1. 最后一条是大图片、前一条是长 base64 时，判定输入里没有 base64，只有两个占位符，前面的文本仍在。
2. 换行包裹的 base64 按净载荷识别；前后文本保留。
3. 预算从截断点往前装满，`chars ≤ 预算`，最新一条在、最旧一条被挤出；预算卡在一条消息中间时加 `[已截断]` 且不超预算；预算 0 返回空而不抛错。
4. 大字段里藏真 `sk-ant-`：截断前脱敏，文本里没有密钥，脱敏计数只有一次（重复测量不翻倍）。
5. 工具调用保留名字、参数被截、带截断标记；失败的工具结果标「失败」；只有 thinking 的消息不产生块。
6. 短 token（git SHA、`sk-learn`）不被误伤；正好 256 字符的长串才替换。
7. 弹窗数字等于实际发送：`measureReplayPlan().originalChars === replayJudgeContext().chars + 期望行为长度`，同一输入测两遍结果相同，规则点贡献 0。
8. 版本常量是 `v2`、预算常量是 12,000，且上下文本身不会超过预算。

e2e（`replay-e2e.test.mjs` 的判定用例）改成带截图的消息：断言 launcher 收到的 stdin 带 `rotom-replay-judge/v2`、带可读文本与截图旁的文本、不含 base64，并且包含弹窗测得的同一段上下文。

## 真实验证：只重跑点 1

`qoder/dfmodel`，单产品臂 + 原回复对照，重复 2 次。为了看「两次的 original 判定是否一致」，同一配置跑了两轮（对照组每个点只跑一次是任务 20 的约定，一轮里拿不到两个 original）。

| 轮次 | 原始回复 | 当前产品 #1 | 当前产品 #2 | 标签 | 耗时 |
|---|---|---|---|---|---|
| 第一次 | `fail`（4,145 / 330 tokens） | `pass`（182 / 154） | `pass`（182 / 130） | `caught` | 28 秒 |
| 第二次 | `fail`（4,146 / 225） | `pass`（182 / 184） | `pass`（182 / 191） | `caught` | 50 秒 |

两次的 original 判定一致，且判定输入大小几乎相同（4,145 / 4,146 tokens，v1 时是 4,482–4,483 且大半是 base64）。理由都在描述「新一步没有文本、没有工具调用」和「新一步在定位 scry 目录、检索模型选择相关代码」，即都在引用可读内容。

准备弹窗数字（这一轮）：3 次运行（1 个点 × 2 次重复 × 1 臂 + 1 次对照）、单点前缀 392,720 字符、产品臂合计 793,180 字符、对照 7,740 字符、脱敏 0 处。

点 2、点 3 未运行，记录仍是任务 20 的 `judge-blind`。点 1 的旧 v1 结果（`unknown`）仍在列表里，标着自己的版本。

## 验证（L1 / L2 / L3）

**L1（本地自动，全部通过）**

| 检查 | 命令 | 结果 |
|---|---|---|
| dashboard / eval / judge / replay 测试 | `node --test rotom/extensions/observability/{dashboard,eval,judge,judge-catalog,replay,replay-arm,replay-judge,replay-api,replay-plan}.test.mjs` | 82 项通过 |
| eval 套件 | `npm test -- session-cards trace-assertions agreement review session-metrics error-breakdown command-failures session-review behavioral-regression behavioral-regression-alternatives behavioral-regression-structure` | 11 文件 / 282 项通过 |
| 回放 e2e | `node --test rotom/evals/test/replay-e2e.test.mjs` | 5 项通过 |
| 类型检查 | `rotom/evals/bin/typecheck` | 通过 |
| 提交体积 | `node scripts/check-staged-file-size.mjs` | 通过（面板冒烟拆出 `eval-ui-smoke-replay.mjs`） |
| 审计 | `python3 scripts/audit-public.py --root .` | PASS，0 命中 |
| 面板冒烟 | `PLAYWRIGHT_MODULE=… PLAYWRIGHT_CHANNEL=chrome node rotom/extensions/observability/eval-ui-smoke.mjs` | PASS，0 page error、0 外部请求 |

**L2（CI）**：`207c19d0` 的 Evals L1 通过（run `40524743496`，success）。文档提交不触发 CI（`paths` 排除 `docs/**`）。

**L3（真实数据）**：上面的点 1 两轮真实运行，真实模型、真实会话，`unknown` 0 个。

## 未做 / 限制

- 「两次 original 一致」用两轮独立运行验证，因为一轮里对照组只跑一次（任务 20 的约定：重复对照只会重复计费同一个答案）。如果后续想在一次运行里就能比较两次判定，需要额外开一个「重复对照」开关，属于设计变更，没做。
- 判定稳定性只在点 1 上验证了两次；没有更多点或更多次样本，不能给出稳定性比例。
- 点 2、点 3 未重跑（按要求留给 bob 重标），它们仍是 `judge-blind`。
- 高负载时 `replay-api.test.mjs` 的等待循环（200 × 25 ms）偶发超时过一次，单独重跑与整组重跑均通过；本任务没改该测试，也没放宽它。
- 判定输入仍受 12,000 字符预算约束：一个很长的会话在截断点前只保留最后一万多字符的可读文本，更早的内容不参与判定。

## 自查

按 [executor-checklist.md](../executor-checklist.md) 逐条：

1. **测试与审计**：做了。上表命令与结果；`git diff --check` 干净；只推 `eval/system`，提交用 noreply 身份；审计 PASS 0。
2. **判定**：做了。判定的输入构成改了，`replay-judge.test.mjs` 覆盖「合理但写法不同」（两种渲染写法都保留可读文本）与「接近合格的坏答案」（空回复在真实数据上判 `fail`）；`unknown` 不算通过；计数用同一输入跑两遍不翻倍。
3. **用例与 fixture**：不适用。没有新增 prompt 或工作区 fixture；真实运行复用 bob 已有的回放点。
4. **计数与汇总**：做了。弹窗字符数 = 实际发送字符数（测试断言三处同一函数）；脱敏计数只在单次渲染内累加；`unknown` 单独一类。
5. **脱敏与隐私**：做了。改动涉及脱敏时序，测试同时覆盖必须脱敏（大字段里的 `sk-ant-`）与不能误伤（git SHA、`sk-learn`、短 base64）；会话原文与运行记录只在 `~/.rotom/evals/replay/`（0700/0600），报告不含原文与判定理由原文。
6. **真实模型运行**：做了。只跑点 1，两轮各 3 次运行；轮数是任务目标（比较两次 original）所需的最小值，已写明；`unknown` 0。
7. **报告**：做了。本文件；README 第 21 行改为 `in-review`。

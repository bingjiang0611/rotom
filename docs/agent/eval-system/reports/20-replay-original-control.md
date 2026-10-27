# 20 · 回放加原始回复对照，以及真实数据暴露的修复

按 [20-replay-original-control.md](../tasks/20-replay-original-control.md) 执行。本文件只记录结论、数字和证据，不含会话原文、模型回复原文或判定文本。

## 结论

回放现在自带对照：每个回放点先给「原始回复」打分（不生成新回复），再给当前产品的回复打分，最后给点一个结论标签。真实数据上立刻看出两件事：

1. **之前那次「3/3 pass」里有 2 个点证明不了任何东西。** 两个规则点的原始回复本来也通过，标签是 `judge-blind`，说明这两个点选到的时刻模型本来就没出错。
2. **剩下那个模型判定点的对照不稳定。** 同一批输入、同一版判定 prompt，两次运行的原始回复判定一次是 `fail`、一次是 `unknown`，所以同一点的标签一次 `caught`、一次 `unknown`。原因是该点的判定输入被一条超大图片 base64 占满（约 4.5k tokens 里绝大部分是不可读数据），判定只能靠猜。

另外修掉 4 个问题：脱敏规则在大输入上抛 `RangeError`；运行器用缩进 JSON 输出，导致已完成的运行在面板里没有结果行和标签；回放运行不记录 token 用量；基线路径不拒绝 symlink。

## A. 原始回复对照

- 新增 `REPLAY_ORIGINAL_ARM = "original"`。每个点先跑对照：取截断点那条 assistant 消息，`gradeReply()` 用同一条规则或同一次模型判定打分，`productDigest` 记 null，`usage` 只记模型判定那部分，`repetition` 固定 1（重复对照只是重复计费同一个答案）。
- `gradeReply()` 是规则点和模型点共用的唯一打分函数，`replayConclusions()` 只从这一轮的记录推标签，`replayConclusion()` 是纯函数：original 通过 → `judge-blind`；original 失败且 candidate 通过 → `caught`；两边都失败 → `still-failing`；任一边 unknown → `unknown`。`unknown` 不会算成通过。
- 四个标签各有合成样例，`unknown` 覆盖三种来源（original unknown / candidate unknown / 缺行）。
- 列表按「点 + 臂」保留最新记录（`readReplayRuns` 返回 `Map<key, {original, candidate, baseline}>`），面板并排显示「原回复 / 当前产品 / 基线产品（有配置才显示）」三栏加一行结论。`judge-blind` 单独用提示样式，并附一句该怎么处理。
- 准备弹窗把对照算进去：`runs = 点数 × (重复 × 产品臂 + 1)`，字符数分行写「产品臂跑整段前缀」和「对照只发判定输入」。对照的字符量按判定实际看到的内容量估算：最后 6 条的脱敏文本截到 6,000 字符，加上期望行为文本；规则点不发内容，记 0。
- 规则点不再额外花一次模型判定。之前只要这一批里有任一模型点，规则点也会跟着调一次判定，与「规则点用规则打分」以及弹窗里的字符数都不一致。

## B. 修复

1. **脱敏加有界量词。** `redaction.mjs` 里 JWT 每段 `{8,4096}`、私钥块 `[\s\S]{0,8192}?`、`sk-` 前缀段 `{0,16}` 次、`sk-` 主体 `{20,4096}`、`github_pat`/`sk-ant`/`slack`/`Bearer` 同理、`assigned-secret` 的标识符前后缀各 `{0,16}`、值 `{8,4096}`。回归样例：约 9 MB 的 `eyJ…`、约 9 MB 的 `data:image/png;base64,…`、4 MB 的 `AAAA/` 重复串都不抛错、不误判；6 MB 字段里藏的真 `sk-ant-` 照样被脱敏，周围 JSON 保留。judge 侧（`judge.test.mjs`）和回放侧（`replay-arm.test.mjs` 的 `measureReplayPlan`）都有对应用例。
2. **记录 token 用量。** 生成的 assistant 消息经 judge 同一个 `usageOf()` 转成 `{input, output, cacheRead, cacheWrite, costUsd, costSource, billing}`；拿不到时全 null（unknown），不写 0。对照臂记判定自己的用量。运行结束时结果面板显示「输入 / 输出 / 合计」，一个都没报告时显示「未知」。`costUsd` 为 null 时不显示美元。
3. **每臂产品只加载一次。** 运行器为每个臂建一次 generator，多次点和多次重复共用；每次生成仍然新建 scratch 目录和拦截扩展。e2e 用注入的 `loadProduct` 计数断言 `{candidate: 1, baseline: 1}`，并继续断言工具调用从不执行（`SENTINEL` 不存在）。
4. **基线拒绝 symlink。** `resolveReplayBaseline` 改用 `lstat`，符号链接返回 `{enabled: false, reason: "symlink"}`，测试覆盖。

## C. 真实数据再跑一次

bob 的 3 个回放点、`qoder/dfmodel`、重复 1 次、未配基线。

准备弹窗数字：6 次运行（3 点 × 1 次 × 1 臂 + 3 次对照）、单点最大 489,659 字符、产品臂合计 1,252,758 字符、对照合计 6,025 字符、脱敏 0 处、模型判定点 1 个。

### 三栏结果与标签

| 点 | 判定方式 | 原始回复 | 当前产品 | 跑一次 | 跑二次 |
|---|---|---|---|---|---|
| 点 1（`01a16bd6` 开头） | 模型判定 | fail / unknown | pass | `caught` | `unknown` |
| 点 2（`01a1714a` 开头） | 规则 `no-identical-retry` | pass | pass | `judge-blind` | `judge-blind` |
| 点 3（`01a1726c` 开头） | 规则 `no-identical-retry` | pass | pass | `judge-blind` | `judge-blind` |

两次运行各约 28 秒（每次生成含一次产品加载）。用量（输入 / 输出 tokens，对照点另记判定用量）：

| 点 | 原始回复 | 当前产品 |
|---|---|---|
| 点 1 | 4,482 / 269（跑一次）、4,483 / 546（跑二次） | 182 / 178、182 / 206 |
| 点 2 | 无（规则点不发内容） | 186 / 331、186 / 1,077 |
| 点 3 | 无 | 167 / 537、167 / 241 |

跑二次的点 3 当前产品还报告了 `cacheRead: 54,912`，`costUsd` 为 null（Qoder 不给美元估算），因此面板只显示 token，不显示费用。

### 判定稳定性（需要 bob 决定）

点 1 的对照两次判定不同（`fail` → `unknown`），不是代码在两次之间变了：两次判定的 `judgePromptVersion` 都是 `rotom-replay-judge/v1`，输入都是同一份。跑二次的判定理由指向「截断后只剩无法解析的图片 base64，下一步文本为空」——这个点的判定输入几乎全是不可读数据，判定只能靠猜。

三个可选方向（我没改 bob 的回放点，也没改判定输入构成）：

- 把这个点挪到前一条或后一条 assistant 消息，那里有可读文本；
- 这个点改用规则（但它原本就是「模型没继续工作」这类语义问题，规则不好写）；
- 改判定输入：把图片 / 长 base64 从判定上下文里剔除，只留文本。这会改变所有模型判定点的输入，属于判定合同变更，需要单独决定。

我的建议是先挪点（成本最低、不动判定合同）。

## 本轮发现并修掉的问题

运行器把最终结果用 `JSON.stringify(result, null, 2)` 输出，而面板按 JSONL 逐行解析：每次缩进片段都解析失败，于是运行状态是「done」但结果行和标签全是空的。真实回放第一次跑完就撞上了（`results: []`、`conclusions: []`）。改为单行输出，`replay-api.test.mjs` 断言状态里能同时拿到两臂结果和 `caught` 标签，然后重跑真实回放确认端到端。

## 验证（L1 / L2 / L3）

**L1（本地自动，全部通过）**

| 检查 | 命令 | 结果 |
|---|---|---|
| dashboard / eval / judge 测试 | `node --test rotom/extensions/observability/{dashboard,eval,judge,judge-catalog,replay,replay-arm,replay-api,replay-plan}.test.mjs` | 74 项通过 |
| eval 套件 | `npm test -- session-cards trace-assertions agreement review session-metrics error-breakdown command-failures session-review behavioral-regression behavioral-regression-alternatives behavioral-regression-structure` | 11 文件 / 282 项通过 |
| 回放 e2e（faux，10 条记录） | `node --test rotom/evals/test/replay-e2e.test.mjs` | 3 项通过 |
| 类型检查 | `rotom/evals/bin/typecheck` | 通过 |
| 提交体积 | `node scripts/check-staged-file-size.mjs` | 通过（拆出 `judge-catalog.test.mjs`、`replay-arm.test.mjs`） |
| 审计 | `python3 scripts/audit-public.py --root .` | PASS，0 命中 |
| 面板冒烟 | `PLAYWRIGHT_MODULE=… PLAYWRIGHT_CHANNEL=chrome node rotom/extensions/observability/eval-ui-smoke.mjs` | PASS，0 page error、0 外部请求 |

**L2（CI）**：`5e0cafa6` 的 Evals L1 通过（run `40502677479`，success）；`5c2eee17`（单行输出修复）的 Evals L1 通过（run `40503449345`，success）。文档提交不触发 CI（`paths` 排除 `docs/**`）。

**L3（真实数据）**：上面 C 节两次真实回放。真实模型、真实会话、单产品臂 + 对照，未配基线；`unknown` 1 个（点 1 跑二次），未超过任务给的阈值。

## 未做 / 限制

- 没有验证「产品对产品」的基线臂在真实数据上的表现：本机没配 `ROTOM_EVAL_REPLAY_BASELINE`，两次运行都是单臂 + 对照。
- 点 2、点 3 判为 `judge-blind`，这两个点在当前判定下无法证明改进。按任务要求没有自己改点。
- 点 1 的判定稳定性问题只记录、未改判定输入（见 C 节，需要 bob 决定）。
- 未在真实数据上验证「每臂只加载一次产品」对耗时的影响：e2e 用注入计数证明不重复加载，真实运行只观测到两次运行各约 28 秒。

## 自查

按 [executor-checklist.md](../executor-checklist.md) 逐条：

1. **测试与审计**：做了。命令与结果见「验证 L1」；`typecheck` 通过；审计 PASS 0；`git diff --check` 干净；只推 `eval/system`，提交用 noreply 身份。
2. **判定**：做了。`replayConclusion()` 四种标签各有样例，`unknown` 不算通过；规则点不再跟着调模型判定；对照与产品臂共用同一 `gradeReply()` 与同一 `judgePromptVersion`（测试断言）。英文/换说法是否通过：本任务没有新增自然语言判定词，规则沿用任务 17 已复核的三条。
3. **用例与 fixture**：不适用。没有新增 prompt 或工作区 fixture；真实运行只用 bob 已建好的回放点。
4. **计数与汇总**：做了。`measureReplayPlan` 用同一输入跑两遍结果一致（已有测试）；对照只按一次计；脱敏计数仍在单次渲染内统计；`unknown` 单独一类。
5. **脱敏与隐私**：做了。改动同时给了必须脱敏（`sk-ant-`、`GITHUB_TOKEN=…`、6 MB 字段里的 key）和不能误伤（9 MB `eyJ…`、9 MB base64、4 MB 斜杠串）两组样例；会话原文、运行记录只在 `~/.rotom/evals/replay/`（0700/0600），报告不含原文。
6. **真实模型运行**：做了。3 点 × 单臂 × 1 次，任务说明明确授权；两次运行是因为第一次撞上单行输出缺陷，属同一批点的重跑而非补跑新点，已如实写明；`unknown` 1 个。
7. **报告**：做了。本文件；README 第 20 行改为 `in-review`。

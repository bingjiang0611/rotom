# 第 2 轮回报：无摘要压缩接管（v2）

设计依据 [session-rollover-v2.md](session-rollover-v2.md)，执行清单 [session-rollover-worklist-2.md](session-rollover-worklist-2.md)，协作与授权沿用 [第 1 轮清单](session-rollover-worklist.md) 第 0、1、4、5、6 节。第 1 轮结果见 [回报 1](session-rollover-report.md)。

**结论**：W7–W12 全部完成；W11 只完成 faux 干跑，真实模型运行按授权要求停在这里。轮转仍默认关闭，收益未经真实模型验证。

## 1. 工作包结果

| 包 | 结果 | 提交 |
| --- | --- | --- |
| W7 撤回 v1 Pi 接缝 | 完成，Pi 源码 diff 只剩前缀与投影测试 | `8672898f` |
| W8 无摘要接管扩展 | 完成，`eligibility.ts` 与 `input` 处理器已删 | `f2678c8b` |
| W9 测试 | 完成，20 个扩展用例 + 1 个 Goal 用例，负向对照 3 项 | `f2678c8b` |
| W10 离线统计补充 | 完成，摘要调用统计 + 4 个单测 + 本机重跑 | `dbc3e369` |
| W11 真实对比评测准备 | 完成，faux 干跑 9/9；真实运行未执行 | `dbc3e369` |
| W12 文档与产品合同 | 完成，footprint 数字不变 | 本提交 |

### W7 撤回的接缝

`git diff --stat f266b30 -- packages/rotom-pi`：

```text
 .../packages/coding-agent/src/core/messages.ts     | 28 ++++++++++--
 .../coding-agent/src/core/session-manager.ts       | 13 +++++-
 .../coding-agent/test/rollover-projection.test.ts  | 53 ++++++++++++++++++++++
 3 files changed, 89 insertions(+), 5 deletions(-)
```

撤回 `ctx.resetContext()`、`ctx.getContextThresholdEstimate()`、`_inputHandlerDepth`、`phase`、`reason: "rollover"`、`preparation` 可选化、runner 的 rollover 分支、interactive-mode 绑定，以及只为它们存在的 `test/session-rollover-seam.test.ts` 与三处测试调整。`_estimateThresholdContext` 抽取**随 `agent-session.ts` 一起还原**（最小 diff）。保留的前缀改动由新增的 `test/rollover-projection.test.ts` 直接守住：rollover 条目走专用前缀、原生条目走摘要前缀、存下的 system message 仍在首位。重建 `build:pi`、`check:pi`、`node --test rotom/scripts/build-pi-fork.test.mjs`（2/2）通过，`DISTRIBUTION_PI_BUILD_SHA256` 同步。

W7 提交当下 v1 扩展仍引用已撤回的 API（`ROTOM_SESSION_ROLLOVER` 未设时休眠），下一提交即改写；这是把“撤回 Pi”和“改写扩展”分开评审的代价，已记录。

### W8 新行为

- 只处理 `session_before_compact` 的 `threshold` 与 `overflow`；`manual`（`/compact`）与 `extension`（`ctx.compact()`）不接管。
- 返回 `{ compaction: { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore, details: { kind: "rotom-rollover", version: 2 } } }`，Pi 不再调用摘要模型。
- `summary` 确定性生成：检索说明（含 `@<firstKeptEntryId>`）+ 被切走范围内最近一条用户请求原文（上限 `reserveTokens / 4`，中间截断并标注删除字符数与 `@entryId`）。`reserveTokens` 取 `preparation.settings.reserveTokens`。
- `context_recall` 不在激活工具中、缺少 `preparation`、摘要生成抛错 → 返回 `undefined`，原生摘要继续。
- 删除 `eligibility.ts`（水位 / `stale` / Goal 资格）、`input` 处理器、轮末取消与 `entryWasAppended` 对账；`requiredFiles` 与 `rotom/package.json` 的 files 同步。

## 2. 测试与负向对照

扩展套件 20 个用例（`rotom/extensions/session-rollover/`）：开关未设不注册任何处理器、轮内请求前越线接管一次且摘要调用为 0、运行结束后越线接管、同一会话第二次接管不嵌套上一条说明、`overflow` 接管且只重试一次、`/compact` 与扩展请求压缩不接管、无 `context_recall` 走原生、`ROTOM_CONTEXT_LAYERS=0` 走原生、后续处理器取消生效、切走的工具参数/结果/图片可检索、`SessionManager.open` 重开后投影仍以接管条目开头。`packages/rotom-goal` 增 1 个用例：active Goal 在接管后继续自动运行（`automaticModelTurns >= 1`，未触发 `provider_retry_exhausted`）。

| 负向对照 | 结果 |
| --- | --- |
| 去掉“附上当前请求” | summary 4 个用例 + 集成 3 个用例失败 |
| 改用自建切点（`branch.at(-1)`）而非 `preparation.firstKeptEntryId` | 轮内接管用例失败（`tokensBefore`/切点不符） |
| 把扩展排到 `third-party` 之后 | `rotom/evals/test/product-runtime.test.ts` 资源顺序断言失败 |

## 3. W10 关键数字

本机重跑 `rotom/evals/bin/rollover-stats`（915 会话，只读本机会话目录，不调用模型）：

| 项 | 值 |
| --- | --- |
| 会话 / 段 / 请求 | 915 / 1 524 / 177 254 |
| 压缩条目 | 614，全部为原生摘要（`native=614`，`extension=0`） |
| 原生条目 usage | input 69 642 730，output 4 066 129，cacheRead 126 336，total 73 835 195 |
| 有 / 无可用 usage 的原生条目 | 614 / 0 |
| 全部助手 usage 合计 | 25 169 747 341 |
| 摘要占助手 usage | 0.3%（`summaryShare`） |
| Goal 活跃时的原生压缩 | 13（unknown 0） |
| v1 门槛（历史参考） | 2×/3×/4× 会话占比 26.5% / 41.6% / 48.7%，未达 50% |

注意：`extension=0` 说明本机会话都产生于 v1/v2 落地之前，这组数字描述的是**原生摘要现状**，不是接管后的成本；v1 门槛对 v2 不再适用（v2 不设水位），保留仅为历史对照。

## 4. W11 真实对比评测（只准备，未运行）

新增 `rotom/evals/cases/session-rollover.eval.ts` 与 `src/session-rollover-cases.ts`、`src/session-rollover-budget.ts`：一个任务，`logs/exact.txt` 里埋入 40 位 `EXACT_CODE`，随后 `logs/bulk.txt` 把上下文推过阈值、切走这条记录，再由后续提问要求复述。两臂任务、`compaction` 设置完全相同，只有 `ROTOM_SESSION_ROLLOVER` 不同；核验器比对精确代码且要求 fixture 逐字节未改。

faux 干跑（`ROTOM_EVAL_SESSION_ROLLOVER=1 rotom/evals/bin/eval cases/session-rollover.eval.ts`）：9/9 通过，3 次重复两臂各 100% 正确；候选臂 token 93 709 vs 原生臂 94 466（−757），工具调用相同（9），时长 1 069 ms vs 1 736 ms，费用 **unknown**（faux 无定价）。负向样例：关掉 `context_recall` 时扩展拒绝接管、走原生摘要，答案被判 **0.00**，证明核验能区分“找回”和“猜对”。

真实运行命令（未执行，等授权填好 `ROLLOVER_LIVE_AUTHORIZATION`）：

```sh
cd rotom/evals
ROTOM_EVAL_SESSION_ROLLOVER=1 ROTOM_EVAL_SESSION_ROLLOVER_LIVE=1 \
ROTOM_EVAL_PROVIDER=openai-codex ROTOM_EVAL_MODEL=gpt-5.6-luna ROTOM_EVAL_THINKING=low \
ROTOM_EVAL_REPETITIONS=3 ./bin/eval cases/session-rollover.eval.ts
```

预算：授权结构要求 `provider/model/thinking` 精确匹配；重复 3 次 × 2 臂 × 每轮约 10–40 次请求，`ROLLOVER_SOFT_LIMITS` 硬上限 240 次请求 / 24 M input token（`ReplayBudget` 超限即停，`stopReason` 写入回报）。费用只记录 Provider 报告值，未报告时保持 unknown，不做换算。

## 5. 验证

| 检查 | 结果 |
| --- | --- |
| `git diff --check` | 0 |
| `rotom/extensions/session-rollover/*.test.ts` | 19 passed（12 集成 + 7 单元） |
| `rotom/extensions/context-layers/*.test.ts` | 10 passed |
| `rotom/evals` 单测（`rollover-stats`、`session-rollover-cases`、`product-runtime`） | 44 passed / 1 skipped |
| `packages/rotom-goal` 全量 | 100 passed（含新增用例） |
| Pi fork 定向（compaction / auto-queue / runner / trigger-compact / rollover-projection） | 66 passed / 5 skipped |
| `npm run check:pi`、`node --test scripts/build-pi-fork.test.mjs` | 0 / 2 passed |
| `rotom/runtime/smoke-runtime.mjs` | 0，8 个扩展、26 个激活工具 |
| footprint | 26 tools / 31 670 schema bytes / 9 939 guideline bytes（与第 1 轮逐字节相同） |
| `rotom/evals/bin/eval cases/session-rollover.eval.ts`（faux） | 9 passed |
| `bin/check-personal`（去掉既有挂起的 `third-party/index.test.ts`） | 主清单 567/567；Goal 100/100；最后一步 footprint 以既有 `runtimeContractGate=REGRESSION` 退出 1 |
| `python3 scripts/audit-public.py --root .` | PASS：8 542 文件，0 findings |
| `audit-public --history`（本工作树） | **BLOCKED**：重建的 fork 归档超出 1280 MiB 展开预算，覆盖不完整 |
| `audit-public --history`（`--depth 12` 浅克隆，438 提交） | 292 findings，**均不含本轮 3 个提交**；类别为旧文档里的个人主目录路径 125、旧提交非 noreply 身份 62、旧 router 测试的私有网段地址 13 |

既有失败（与本轮无关，沿用第 1 轮结论）：`rotom/extensions/third-party/index.test.ts` 24 用例通过后文件级 promise 不结算；footprint `runtimeContractGate=REGRESSION` 的 +1 986 字节 schema 漂移。

## 6. 决策记录

1. **`_estimateThresholdContext` 抽取随 `agent-session.ts` 一起还原**：v2 不需要向扩展暴露估算，保留抽取只会扩大 diff。
2. **W7 与 W8 分两个提交**：让“撤回 Pi 接缝”可单独评审；代价是 W7 提交当下 v1 扩展引用已删 API（开关关闭时休眠），W8 立即改写。
3. **`preparation` 缺失检查保留**：类型上是必填，但 v2 设计第 3 节要求缺失时返回 `undefined`，故留一行防御并在此说明来源。
4. **请求原文只在被切走时附上**：用 `firstKeptEntryId` 在分支上的位置判断；找不到切点（分支被改写）时按“已切走”处理，宁可多附一次也不丢当前请求。
5. **负向样例用“无 `context_recall`”而非伪造检索失败**：关闭工具时扩展本身就会拒绝接管，此时原生摘要仍无法携带 40 位代码，核验判 0，证明检查能失败；真实接管 + 检索失败的组合无法在不破坏扩展前置条件的前提下构造。
6. **Goal 预算取消未用真实 Goal 预算路径测**：真实的“Goal 因预算取消压缩”与 Offload 取消走同一条事件链，由“后续处理器 `{cancel:true}` 生效”用例覆盖；另注：写入新 Goal 用例时发现，若取消发生在 Goal 活跃的请求前阈值压缩上，Pi 会反复重试同一越线请求，测试会一直不settle——这属于 Pi 现有取消语义，未在本轮修改。
7. **W8+W9 合并为一个提交、W10+W11 合并为一个提交**：清单要求“每个工作包至少一个可读提交”，合并后每个提交仍可独立读懂与回退。
8. **历史审计未强行提升预算**：`MAX_EXPANDED` 是既有安全边界，本轮不为了通过检查而放宽；改为在浅克隆上给出本轮提交的结论。

## 7. 已知限制与待决

- 接管收益、原生摘要被替代后的回答质量、真实费用：**未验证**，只有 faux 干跑与离线统计。
- faux 干跑中两臂 token 差只有 −757（0.8%），来自省掉一次摘要调用；延迟差主要是 faux 摘要调用的脚本耗时，**不是**真实模型延迟预测。
- 本机的 614 条压缩条目全部来自原生路径，说明接管上线后才有真实分布；下一次统计应能读出 `extension`/`rollover` 计数。
- 全量历史审计在本工作树无法完成（归档展开预算）；公开发布仍需按 CLAUDE.md 的流程在干净公开副本上重跑。
- `third-party/index.test.ts` 的挂起仍是既有问题，未修复。
- `check-personal` 最后一步仍以既有 `runtimeContractGate=REGRESSION` 退出 1；本轮未改动合同文件。

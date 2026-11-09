# 第 3 轮回报：无摘要压缩接管（v2）真实模型对比

依据 [v2 设计](session-rollover-v2.md) 第 8.3 节、[第 2 轮回报](session-rollover-report-v2.md) 第 4 节、执行清单 [worklist-3](session-rollover-worklist-3.md)；协作、自主验证、停止条件与回报格式沿用 [第 1 轮清单](session-rollover-worklist.md) 第 0、4、5、6 节。

**结论**：W13–W16 全部完成，两个授权模型都实际跑完。`early-detail` 两臂正确率完全相同（5/5 对 5/5），接管组代价约为原生摘要组的 1.8–2.8 倍；`no-hint` 接管组 0/14 全错，原生摘要组 15/15 全对。W16 的取消循环**未能复现**：四种组合都只发 1 个请求就结束。轮转仍默认关闭。

## 概览

| 项 | 值 |
| --- | --- |
| 基于提交 | `032fe1b9` |
| 最终提交 | 本回报所在提交 |
| 环境 | Node v24.18.0，macOS 27.3，Darwin arm64 |
| 分支 | `claude/kind-bardeen-roufe9`（不推 `main`） |
| 工作包 | W13 完成 / W14 完成 / W15 完成（2 模型均运行） / W16 完成（只复现，未修 Pi） |

## 1. 授权与模型

用户 2026-11-09 授权用真实模型运行本对比，预算不设上限。授权写成 `rotom/evals/src/session-rollover-budget.ts` 的 `ROLLOVER_LIVE_AUTHORIZATIONS`：

| 模型 | thinking | 重复 | 单次运行保护上限 | 实际运行 |
| --- | --- | --- | --- | --- |
| `openai-codex` / `gpt-5.6-luna` | `low` | 5 | 80 请求 / 3.2M input token | 是 |
| `qoder` / `ultimate`（用户日常默认） | `high` | 5 | 80 请求 / 3.2M input token | 是 |

- 单次上限按任务规模（约 20 请求、<800k input token）取 2 倍，是防死循环与异常重试的保护，**不是费用上限**。
- 凭据在用户自己的 `~/.pi/agent/` 原地读取（`authPath` 指向该目录），未复制、未代登、未改写；隔离的 eval agent 目录只写 `settings.json`。
- **上限调整记录**：首次运行用 40 请求 / 1.6M。codex `early-detail` 接管组第 1 次重复在 41 个请求处触及上限（`request-limit`，模型反复检索与重读）。按清单允许放大一次，改为 80 / 3.2M 并整体重跑；被作废的那批行没有进入下面的统计。
- 费用：codex 用 Provider 报告的 USD；qoder 报的是 Qoder 记录的 credits（Pi 对 qoder 的价格是占位 0，按 CLAUDE.md 第 2 节不作零成本证据，USD 记为 unknown）。

## 2. W13 无提示任务

新增 `no-hint` 任务（`rotom/evals/src/session-rollover-cases.ts`）：

- 第 1 轮：给出一条只在这一轮出现的项目规则——新建文件第一行必须是 24 位标记 `<NO_HINT_MARKER>`，`config/locked.json` 不得修改——模型只回 `OK`。
- 第 2 轮：读完 `manifest.json` 列出的全部文件（含 14k token 的 bulk 文件，压缩发生在本轮中途），新建 `notes/summary.md` 列出读过的文件。提示**不重复、不暗示**规则。
- 核验：`notes/summary.md` 首行与标记逐字一致、列出全部读过的文件、`config/locked.json` 逐字节未改、其余 fixture 未改、末条回复为 `DONE`。失败时另记 `gradeReason`（`first-line-mismatch` / `summary-missing` / `summary-incomplete` / `reply-mismatch` / `fixture-changed`）与 `ruleObeyed`（文件层面是否遵守规则，与回复措辞无关）。

faux 干跑（`ROTOM_EVAL_SESSION_ROLLOVER=1 ./bin/eval cases/session-rollover.eval.ts`，3 次重复）：16/16 通过。

| 用例 | 结果 |
| --- | --- |
| 两个任务 × 两臂 × 3 次重复 | 12/12 通过（接管条目 ≥1、原生摘要 = 0；对照组相反） |
| 负向对照一：接管组拿不到 `context_recall` | 判错，`rolloverEntries = 0` 且原生摘要兜底 |
| 负向对照二：脚本模型忽略一次性规则 | 判错（`no-hint` 忽略规则），接管仍发生 |
| 评分子测试（首行、清单、fixture 变更、失败原因） | 2/2 通过 |

## 3. W14 统计口径

`rollover-stats` 新增两个比例（只报 token，不换算费用）：

- `inputShare` = 摘要调用 `input` ÷ 全部助手未命中缓存的 `input`；
- `outputShare` = 摘要调用 `output` ÷ 全部助手 `output`。

本机重跑（`rotom/evals` 下 `./bin/rollover-stats`，本机真实会话，623 次原生摘要）：

| 指标 | 值 |
| --- | --- |
| 摘要调用 input | 70,491,831 |
| 助手未命中缓存 input | 562,288,806 → `inputShare` **12.5%** |
| 摘要调用 output | 4,110,048 |
| 助手 output | 106,945,166 → `outputShare` **3.8%** |
| 旧口径 `usageShare`（含 cacheRead 24.4B） | 0.3% |

旧口径把摘要成本低估约 40 倍：分母被 cacheRead 撑大，摘要调用真正付费的两项几乎被摊平。单测 27/27（新增 1 个用例，覆盖两个新比例、分母为 0 时为 `null`、`formatReport` 的新行）。

## 4. W15 真实运行

方法：每个模型 × 2 任务 × 2 组 × 5 次重复；两臂任务、`compaction`（`reserveTokens = window - 16000`、`keepRecentTokens = 2000`）与切点完全相同，只切 `ROTOM_SESSION_ROLLOVER`；同一重复里两臂顺序交替，避免缓存偏袒；每次运行使用新的临时工作区、新的配置目录、新的预算对象，不共享会话。逐次记录写入 `rotom/evals/.eval/session-rollover-v3/`（gitignore，不含凭据），一行一次尝试。

### 主表（模型 × 任务 × 组，5 次重复）

| 模型 | 任务 | 组 | 完成 | 答对 | 请求数中位 (范围) | input | output | cacheRead | 时长中位 | 费用 | recall 次 | 原生摘要 | 接管次数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex/gpt-5.6-luna/low | early-detail | 原生摘要 | 5/5 | 5/5 | 12 (4–13) | 28,233 | 383 | 65,024 | 46.2s | $0.0342 | 0 | 10 | 0 |
| codex/gpt-5.6-luna/low | early-detail | 接管 | 5/5 | 5/5 | 28 (7–39) | 71,071 | 1,522 | 132,608 | 83.6s | $0.0972 | 52 | 0 | 26 |
| codex/gpt-5.6-luna/low | no-hint | 原生摘要 | 5/5 | 5/5 | 12 (7–13) | 35,846 | 572 | 69,760 | 60.8s | $0.0431 | 0 | 10 | 0 |
| codex/gpt-5.6-luna/low | no-hint | 接管 | 5/5 | **0/5** | 15 (11–34) | 42,124 | 1,199 | 104,320 | 54.1s | $0.0761 | 18 | 0 | 16 |
| qoder/ultimate/high | early-detail | 原生摘要 | 5/5 | 5/5 | 7 (5–13) | 47,440 | 910 | 34,034 | 99.3s | 127.47 Cr | 2 | 11 | 0 |
| qoder/ultimate/high | early-detail | 接管 | **3/5** | 3/3 | 39 (9–42) | 260,979 | 6,198 | 231,480 | 300.4s | 266.51 Cr | 27 | 0 | 44 |
| qoder/ultimate/high | no-hint | 原生摘要 | 5/5 | 5/5 | 12 (6–13) | 43,033 | 771 | 96,302 | 139.9s | 126.60 Cr | 0 | 14 | 0 |
| qoder/ultimate/high | no-hint | 接管 | **5/5** | **0/5** | 25 (20–34) | 97,168 | 3,867 | 218,394 | 230.8s | 243.82 Cr | 65 | 0 | 43 |

“完成”与“答对”分开列：qoder 接管组有 3 次运行没跑完，它们的失败不是答错，不计入答对率的分母（主表按 5 次重复统计完成次数）。中位数只按完成且度量可读的运行计算。

### 中断、重试与限额

| 情况 | 处理 | 结果 |
| --- | --- | --- |
| codex `early-detail` 接管第 1 次：41 请求触及 40 请求上限 | 上限按清单放大一次到 80，整体重跑 | 重跑后 5/5 完成 |
| qoder `early-detail` 接管 rep1、rep5：`Qoder: upstream_error_frame`（5xx 类，无输出） | 同一配置重试 1 次，记为独立尝试行 | 均在第 2 次完成 |
| qoder `early-detail` 接管 rep2、rep3：`model_refusal` | 不重试（模型明确拒绝，不是传输故障） | 记为失败 |
| qoder `no-hint` 接管组重跑中的 rep2、rep4：第 2 次尝试也返回错误 | 已用尽 1 次重试 | 记为失败 |
| 其余 | 无 | — |

### 失败原因诊断（`no-hint` 接管组重跑，记录原因）

由于首批 codex 行产生于“记录失败原因”之前，codex 与 qoder 的 `no-hint` 接管组各补跑 5 次（目录 `session-rollover-v3-nohint2-*`）：

| 模型 | 结果 | `gradeReason` | `ruleObeyed` |
| --- | --- | --- | --- |
| codex/gpt-5.6-luna | 0/5 判定错 | 5× `first-line-mismatch` | 0/5 |
| qoder/ultimate | 0/5 判定错 | 5× `reply-mismatch` | 1/5 |

结论：codex 是真的把规则丢了（`notes/summary.md` 首行不是标记）；qoder 两种情况都有——4 次同样丢了规则，1 次文件写对了但末条回复不是 `DONE`（严格判定仍算错，`ruleObeyed` 单独记为遵守）。两类失败都只在接管组出现，原生摘要组 15/15 全对。

### 观察

- `early-detail`：接管组“记得住”与原生摘要组一样（都答对），代价是 1.8–2.8 倍代价——请求数中位 28 vs 12（codex）、39 vs 7（qoder），input 2.5–5.5 倍，端到端时长 1.8–3 倍，费用 2.8 倍 / credits 2.1 倍。接管组还会反复压缩（一次运行最多 19 次接管），因为投影每轮只留最近 2000 token，模型重新读取以补上下文。
- `no-hint`：接管组 0/14 全错，原生摘要组 15/15 全对。v2 只逐字带上当前这一轮的用户请求，一次性规则只能靠原生摘要或模型主动检索；实测模型多数不会主动检索到它（codex 18 次 recall、qoder 65 次 recall 仍未命中规则）。
- 两臂差异只按实测陈述；每组 5 次，不做显著性宣称，不用 token 推算费用。

## 5. W16 取消路径复现

新增复现测试 `packages/rotom-goal/test/compaction-cancel-loop.test.ts`（只复现，不改 Pi）：种子历史已越过阈值，测试扩展对 `session_before_compact` 一律返回 `{ cancel: true }`，Provider 分别返回“报错的越线响应”和“成功但 usage 越线的响应”，各有 Goal / 无 Goal 两种。

| 组合 | 触发 | 实际行为 | 请求数 |
| --- | --- | --- | --- |
| 无 Goal + 越线报错 | 请求前阈值压缩被取消，随后 overflow 恢复也被取消 | 一次运行结束，无循环 | 1 |
| 有 Goal + 越线报错 | 同上 | Goal 以 `blocked / retry_exhausted` 停止 | 1 |
| 无 Goal + 越线成功 | 请求前阈值压缩被取消，运行成功 | 一次运行结束 | 1 |
| 有 Goal + 越线成功 | 同上 | Goal 保持 `active`，`automaticModelTurns = 0`，没有续跑 | 1 |

**结论：第 2 轮记录的“反复重试同一个越线请求、测试一直不结束”在当前基线（Pi `1.4.0-rotom.2`）下未能复现。** 四组都只发 1 个请求。可能原因：第 2 轮的观察来自另一处取消路径或某次夹具写法差异；也可能当时的 `_overflowRecoveryAttempted` 在续跑时被重置，而现版本不会。对用户的影响：本轮覆盖到的“压缩被取消”路径（含 Offload 用 `{ cancel: true }` 推迟摘要的形状）不会造成请求循环；取消的语义是否需要调整，属于需要用户决定的范围，本包按要求未改。

未覆盖：只在测试扩展里无条件取消，没有覆盖“处理器自己按条件取消后又放行”的路径，也没有覆盖第 2 轮原始夹具。若要把这条记录当作已关闭，需要用户提供第 2 轮的复现步骤或允许继续排查。

## 6. 结论

支持 v2 的部分：
- 无摘要接管在技术上可用：`early-detail` 两臂正确率相同，接管组确实没有调用摘要模型（原生摘要 0 次），`context_recall` 能在需要时找回被切走的细节。
- 取消路径不再是阻塞风险（W16）。

不支持 v2 的部分：
- 一旦早期约束只出现在被切走的历史里、而当前请求不提示它，接管组的成功率降到 0/14；原生摘要组 15/15。这与 v2 设计第 9 节担心的风险一致，也是本产品默认仍关闭 `ROTOM_SESSION_ROLLOVER` 的直接理由。
- 接管组代价更高：同一任务 1.8–3 倍时长、2.1–2.8 倍费用/credits，且更频繁地反复压缩。
- qoder 接管组有 3/5 次没跑完（1 次拒绝、2 次传输失败加重试），原生摘要组 5/5 完成。

仍未验证：其他 Provider / 模型规模；更长的多轮任务；真实用户会话（本轮全部是合成 fixture）；接管组在 `keepRecentTokens` 更大时的行为（本轮两臂同为 2000）；W16 第 2 轮原始夹具。

## 7. 决策记录

| 位置 | 设计未覆盖或偏离之处 | 决定 | 理由 |
| --- | --- | --- | --- |
| W15 上限 | 40 请求上限被真实运行触及 | 放大一次到 80 并整体重跑 | 清单第 1 节允许；保留完整 5 次重复比截断样本更有意义 |
| W15 重试 | 5xx / 无输出的传输失败 | 同一 arm/重复重试 1 次，记独立尝试行 | 与 Pi 有界重试语义一致；`model_refusal` 不重试 |
| W15 判定 | 严格判定把“回答多了几个词”也算错 | 增加 `ruleObeyed` 单独记录文件层面结果 | 区分“丢了规则”和“格式不符”，避免误读 |
| W15 费用 | qoder 价格是占位 0 | USD 记 unknown，只报 credits | 遵守 CLAUDE.md 第 2 节，不把 0 当成本 |
| W16 | 复现失败 | 只记录，不改 Pi | 清单要求只复现；取消语义属用户决定范围 |

## 8. 停止或待决事项

无停止项。待决两件：

1. `no-hint` 接管组 0/14 是否足以判定 v2 不应启用（本回报只给证据，不替用户决定默认开关）。
2. W16 复现失败是否接受为“当前基线无此缺陷”，或需要用户提供第 2 轮原始夹具/步骤继续排查。

# 任务 04 · 付费受控回放（压缩卸载 开 vs 关）

bob 已选择用付费受控回放采开关对照数据（2026-10-25）。本任务分两段：

- **04a（零费用）**：写 eval case、用 faux provider 证明两臂确实只差开关、能稳定触发阈值压缩、指标算得对；输出一份调用量与费用预估。完成后停下交接。
- **04b（付费）**：只有 bob 在线程里确认**模型、重复次数和预算上限**之后才执行。规划者会把确认内容写进本文件末尾的「授权记录」。没有授权记录就不要跑任何真实模型。

报告写到 `docs/agent/compaction/reports/04-paid-replay.md`。

## 04a 交付物

| 文件 | 说明 |
|---|---|
| `rotom/evals/cases/compaction-offload.eval.ts` | 显式启用（`ROTOM_EVAL_COMPACTION_OFFLOAD=1`），否则 `describe.skip`。结构参照 `cases/context-efficiency.eval.ts` 与 `src/vitest-evals/harness-table.ts` |
| `rotom/evals/src/compaction-offload-cases.ts` | 冻结的 fixture、任务、判分和指标采集，便于单测 |
| `rotom/evals/test/compaction-offload-eval.test.ts` | faux provider 零费用测试（见下） |
| `rotom/evals/README.md` | 加一小节（≤ 15 行）：用途、启用方式、费用提醒、局限 |
| `docs/agent/compaction/reports/04-paid-replay.md` | 04a 报告 + 费用预估 |

## 两臂

- `baseline`：产品原样，`ROTOM_COMPACTION_OFFLOAD=0`。
- `candidate`：同一产品，`ROTOM_COMPACTION_OFFLOAD=1`。
- 两臂用同一 `productAgentDir`（当前分支的 `rotom/`）、同一模型、同一 thinking、同一 compaction 设置、同一工具面。开关只走环境变量，用 `pi-harness.ts` 现有的环境覆盖机制（`withExclusiveEnvironment` 或 harness 已有的入口），**不要**依赖往 configDir 写 `sol-pi.json`：rotom 的 SoL-Pi loader 用的是 `getAgentDir()`，不一定等于 harness 的 configDir，需要先核实，报告里写结论。
- Evidence-Preserving Reducer 两臂都关（它会额外请求 `openai-codex`，增加费用和噪声）。做法自选（例如 harness 层面让 SoL-Pi 用一份显式配置），但两臂必须一致，报告写明。
- 重复 N 次（默认 3），两臂交替顺序（参照 context-efficiency 的 ordered 写法），每次全新工作区。

## 让压缩稳定触发

真实模型窗口很大，短任务不会自然触发阈值压缩。需要人为把阈值线压低，两臂相同。可选做法（选一种，报告说明理由并在 faux 测试里证明有效）：

1. configDir 的 `settings.json` 里调大 `compaction.reserveTokens`，使 `contextWindow - reserveTokens` ≈ 40K tokens。**先核实** Pi 是否用 `reserveTokens` 推导摘要请求的输出上限（`packages/rotom-pi/packages/coding-agent/src/core/compaction/compaction.ts`），如果会导致摘要输出上限变得离谱，就不用这个办法。
2. 用 harness 的 `modelRuntimeFactory` 或 models 配置给同一 provider/model 声明更小的 `contextWindow`（例如 64K），只影响阈值计算、不影响实际请求。

`keepRecentTokens` 保持 Pi 默认。retry 关闭（与 context-efficiency 一致）。

## 任务（3 个，冻结在 `compaction-offload-cases.ts`）

每个任务都要：多步、产生大量 1.5–10 KiB 的工具结果（读文件、跑脚本），在压缩发生**之后**仍需要用到压缩前读过的具体细节，结果可以确定性判分。建议：

1. **跨文件配置汇总**：约 20 个 3–6 KiB 的模块文件，各含一个配置常量和大量无关代码；先让模型逐个读完并记录，再要求按其中几个常量改一个汇总文件并跑 `node check.mjs`；判分 = check 通过 + 文件其余部分不变。
2. **延后引用的精确细节**：前半段读一批日志/文档（每份 2–8 KiB），后半段做别的工作把上下文撑过阈值，最后要求原样给出前半段某份文件里的一个精确字符串（例如一个 40 字符 token）；判分 = 精确匹配。这是最容易暴露「卸载后取不回」的任务。
3. **多文件修复 + 测试**：一个小 Node 项目，测试脚本输出 3–6 KiB 失败日志，需要读多个源文件定位并修 2–3 处 bug；判分 = `node test.mjs` 退出 0 且未改测试文件。

任务 prompt 里不要提示卸载、`obs_recall` 或压缩。fixture 全部合成，不含任何真实会话内容。

## 每次运行采集的指标

用 inline extension 订阅事件，或在 `output()` 里从 session 读：

| 指标 | 来源 |
|---|---|
| `correct` | 任务判分 |
| `thresholdCompactions` / `nativeCompactions` / `deferred` | `session_before_compact`（`reason==="threshold"`）、`session_compact`、`session_compact_failed`（aborted）计数 |
| `compactionWaitMs` | 每次原生压缩从 `session_before_compact` 到 `session_compact` 的墙钟时间之和（推迟的那几次也记，应接近 0） |
| `obsRecallCalls` / `recalledOffloaded` | assistant 的 `obs_recall` 调用；其 `id` 是否在卸载记录（`customType==="sol-pi-compaction-offload"`）的 `observationIds` 里 |
| `offloadedResults` | 卸载记录 `toolCallIds` 总数 |
| `turns` / `toolCalls` / `inputTokens` / `outputTokens` / `cacheRead` / 估算费用 | assistant usage 求和（含压缩摘要请求的 usage，如可得） |
| `wallMs` | 整次运行墙钟 |

汇总表按臂给：成功率（分子/分母）、`compactionWaitMs` 均值与中位数、原生压缩次数、推迟次数、`obsRecallCalls` 与 `recalledOffloaded` 均值、token 与估算费用均值、`wallMs` 均值。样本小，**不做显著性结论**，原样报数。

## 04a 零费用测试（faux provider）

- 两臂各跑一次固定脚本化的 faux 响应序列，断言：两臂发出的 system prompt 与工具 schema 逐字节相同（归一化临时路径）；只有 candidate 出现卸载记录；baseline 在同一时刻发生原生压缩。
- 阈值压低的办法确实让压缩在预期轮次触发。
- 指标采集：用脚本化序列构造「推迟 1 次 + 原生 1 次 + 取回被卸载 id 1 次 + 取回普通 id 1 次」，数字精确。
- 判分函数对正确/错误输出各一例。
- 未设 `ROTOM_EVAL_COMPACTION_OFFLOAD=1` 时 case 跳过、不发任何请求。

## 04a 费用预估（写进报告）

用 faux 运行得到的每次运行轮数与 token 量级，按「3 任务 × 2 臂 × N 次」估算真实调用的请求数、输入/输出 token 上下界；如果知道某个候选模型的单价就算美元区间，不知道就只给 token。列出建议的 N（3 或 5）及各自的估算。不要调用任何真实模型来做预估。

## 验收命令（规划者会重跑，04a）

```sh
cd rotom/evals
npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always
npx vitest run test/compaction-offload-eval.test.ts
npm test
npm run typecheck
cd ../..
git diff --check origin/main...HEAD
python3 scripts/audit-public.py --root .
```

## 04b 执行要求（授权后）

- 只用授权记录里的模型、N、预算上限。累计估算费用到上限立即停止，已完成的运行照常报告，未完成的标 `not-run`。
- 超时计失败；基础设施失败（网络、限流）可重试一次并在报告中保留两次的记录，不挑最好的一次。
- 运行产物（session、trace）只留在本机私有目录，不进仓库；报告只写聚合表和每次运行的指标行（不含任何模型输出正文）。
- 记录两臂的源码 commit、模型/provider、thinking、阈值设置、N、实际花费（provider 报告的或按 usage 估算，注明哪种）。

## 授权记录

（空。bob 确认后由规划者填写。）

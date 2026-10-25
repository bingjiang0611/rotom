# 任务 03 · 压缩卸载指标脚本

范围：新增一个本地只读统计脚本 + 单测 + 报告。模型调用：**无**。验证级别：L1（合成数据）+ 执行者本机真实数据冒烟（只报聚合数字）。报告写到 `docs/agent/compaction/reports/03-metrics.md`。

前置：任务 02 已 accepted（`9eba1f9`）。数据怎么采（日常使用开关对照，还是付费受控回放）由 bob 决定，但两种方式都要用这个脚本出数，所以先做脚本。

## 目标

读本机 Pi 会话目录里已有的三类文件，按「关闭 / 开启」两组对比三个数：

1. **压缩等待时长**：阈值压缩每次让用户等了多久。
2. **`obs_recall` 调用次数**：尤其是取回「被卸载的结果」的次数。
3. **任务成功率**：来自 eval 体系的人工标注（`labels.jsonl`），没有标注就输出 `N/A`，不猜。

## 输入（已核对源码）

- **Session**：默认 `~/.pi/agent/sessions` 下递归 `*.jsonl`（排除 `observability/`、`sol-pi/` 子目录）。只看当前分支（最后一个 entry 沿 `parentId` 回溯）。需要的 entry：`custom` 且 `customType === "sol-pi-compaction-offload"`（卸载记录，见 `packages/rotom-sol-pi/src/sol-pi/extensions/observation-pack/offload.ts`）、`compaction`、assistant 消息里 `toolCall.name === "obs_recall"` 及其 `arguments.id`。
- **Trace**：`<session 目录>/observability/<session 文件名去掉 .jsonl>.trace.jsonl`。压缩 span 名 `pi.session.compaction`，`span_end` 上有 `status`（`ok|aborted|error|unknown`）、`durationMs`、`pi.compaction.reason`、`pi.compaction.from_extension`、`pi.compaction.request_starts` 和每次摘要请求的耗时属性（见 `rotom/extensions/observability/index.ts` 的 `compactionStart/compactionEnd/summaryCallAttributes`）。卸载推迟时 Pi 会发出 `aborted` 的压缩 span。工具 span 名 `pi.tool.execute`，`pi.tool.name`。
- **SoL-Pi ledger**：`<session 目录>/sol-pi/<sessionId>/observation-pack/ledger.jsonl`（见 `runtime-paths.ts`）。事件：`offload_defer`、`offload_defer_stale`、`offload_native`（带 `reason`）、`offload_placeholder`（带 `id`）、`recall`（带 `id`）、`full`、`placeholder`。
- **标注**（可选）：`--labels <path>`，默认 `~/.rotom/evals/labels.jsonl`（eval 体系任务 01 的输出格式：每行 `{sessionId, verdict, categories[], ...}`，`verdict` 取 `pass|fail`）。

trace 或 ledger 缺失、末行截断都要容忍，标 `partial` 并计数，不中断。

## 分组

- `--off <from>..<to>` 与 `--on <from>..<to>`：按会话首个 entry 的时间分组（ISO 日期或时间）。两组都要给。
- 另外输出一个「开启组里实际触发过卸载」的子组（会话里至少有一条卸载记录或 `offload_defer` ledger），因为开启了但从没触发阈值压缩的会话对等待时长没有信息。

## 每组输出的指标

| 指标 | 口径 |
|---|---|
| sessions / with_threshold_compaction | 会话数；至少有一次 `reason=threshold` 压缩 span 的会话数 |
| native_compactions | `reason=threshold` 且 `status=ok` 的压缩 span 数 |
| native_wait_ms p50 / p90 / sum | 上述 span 的 `durationMs` |
| deferred | `reason=threshold` 且 `status=aborted` 且同会话 ledger 有对应 `offload_defer` 或 `offload_defer_stale`（按时间先后配对，配不上的单列 `aborted_unexplained`） |
| wait_per_session_ms p50 / mean | 每会话所有 threshold 压缩等待之和 |
| offload_native_reasons | `offload_native` 按 `reason` 计数 |
| offloaded_results | 卸载记录里的 `toolCallIds` 总数 |
| obs_recall_calls / per_session | 当前分支上的 `obs_recall` 调用数 |
| recalled_offloaded | `obs_recall` 的 `id` 落在卸载记录 `observationIds` 里的次数，以及去重后的 id 数；再给 `recalled_offloaded_ids / offloaded_results` 比例 |
| labeled / pass / fail / pass_rate | 与标注按 `sessionId` 关联；`labeled=0` 时 `pass_rate: N/A` |

以及两组之间的差值（on − off）。所有比例同时给分子分母。样本量 < 10 的指标后面标 `(n<10)`。

## CLI

```sh
node rotom/evals/scripts/compaction-metrics.mjs --off 2026-10-01..2026-10-25 --on 2026-10-26..2026-11-08 \
  [--root ~/.pi/agent/sessions] [--labels ~/.rotom/evals/labels.jsonl] [--json]
```

默认输出一张 Markdown 表到 stdout；`--json` 输出同样内容的 JSON。**stdout 只有聚合数字和计数，不输出会话 id、路径、cwd、任何正文。**

## 交付物

| 文件 | 说明 |
|---|---|
| `rotom/evals/scripts/compaction-metrics.mjs` | ESM，Node ≥ 24，无新增 npm 依赖 |
| `rotom/evals/scripts/compaction-metrics.d.mts` | 导出函数类型声明，保证 `npm run typecheck` 通过 |
| `rotom/evals/test/compaction-metrics.test.ts` | vitest，只用测试内生成的合成 session/trace/ledger |
| `rotom/evals/README.md` | 加一小节（≤ 15 行）：用途、命令、隐私边界 |
| `docs/agent/compaction/reports/03-metrics.md` | 执行报告 |

如果 `rotom/evals` 里已经有可复用的 session/trace 解析器（eval 体系任务 01 的 `session-cards.mjs` 可能在 `eval/system` 分支、不在本分支），**不要**从别的分支拷代码，自写一个有界解析器即可，报告里说明。

## 必须满足的行为

1. 只读：不修改、移动、删除任何会话、trace、ledger 文件。
2. 有界：单文件 > 32 MiB 跳过并计数；单行 > 1 MiB 跳过；一次最多 2000 个会话。
3. 拒绝 symlink 根目录；坏 JSON 行跳过计数。
4. 不输出任何内容正文或标识（见 CLI）。

## 单测至少覆盖

- 一组合成会话：两次 native 阈值压缩（不同耗时）+ 一次推迟（aborted span + `offload_defer`）+ 一次 stale 推迟，指标数字精确。
- `obs_recall` 取回被卸载 id 与取回普通 id 分开计数。
- 分支会话只算当前分支。
- trace 缺失 / 末行截断 → partial 计数，指标照算可算的部分。
- `aborted` 但 ledger 无对应推迟 → `aborted_unexplained`。
- 标注关联与 `N/A`。
- stdout 不含合成会话的 id、路径和正文（用独特字符串断言）。

## 验收命令（规划者会重跑）

```sh
cd rotom/evals
npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always
npx vitest run test/compaction-metrics.test.ts
npm test
npm run typecheck
cd ../..
git diff --check origin/main...HEAD
python3 scripts/audit-public.py --root .
```

## 真实数据冒烟（执行者本机）

对本机现有会话跑一次（`--off` 用最近两周，`--on` 用一个空区间即可，因为还没开过），确认脚本能处理真实文件、性能可接受。报告里只写：处理的会话数、partial 数、跳过数、耗时、关闭组的 native 等待 p50/p90（与之前回放的 85.6 s 中位数对照）。不写任何会话标识或内容。

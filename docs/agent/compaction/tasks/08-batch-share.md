# 任务 08 · 让单批读取占阈值的比例接近生产（零费用）

背景：[07 报告](../reports/07-pressure-redesign.md)显示，每轮 20 次 read 时 candidate 只能原生摘要。原因是 Pi 不在 toolResult 中间切分，最后一批 20 份 8 KiB 结果（约 41K token）整体留在保留区，已超过推迟目标 `0.6 × 64K = 38.4K`。生产阈值约 255K，同一批只占约 16%；回放里占约 64%，这是缩小阈值造成的失真。

目标：保持阈值 64K、`keepRecentTokens` 5,120 和全部判定逻辑不变，只改 fixture 尺寸与份数，使「一批 20 份」约占阈值的 20–25%，同时第一阶段仍稳定越过阈值。

范围：只改 `rotom/evals/`。模型调用：**无**。`LIVE_AUTHORIZATION` 保持 `null`。报告写到 `docs/agent/compaction/reports/08-batch-share.md`。

## A. 改 fixture

- `padded()` 的单份目标从 8,192 字节改为约 3,072 字节。单份仍要大于卸载下限 1,536 字节且留出余量：用 05 的 chars/4 口径核对每份最小值，写进报告。
- 增加 notes 份数，使每个任务第一阶段材料的 chars/4 代理总量仍 ≥ 83K（阈值的 1.3 倍）。参考：约 3 KiB × 120 份。modules 保持 20 份，module 2/7/13/19 的 `VALUE` 与 `EXACT_CODE` 位置规则不变；`deferred-exact` 的 logs 份数可以不变。
- `multi-file-fix` 的 `failureLog` 截断长度相应缩小，保证 `logs/test-output.txt` 也落在 1.5–10 KiB。
- prompt、工具面、判分、熔断与 07 一致。

## B. faux 证明

对三个任务、两臂都跑：

1. **每轮 20 次 read**：第一阶段越过阈值；candidate 至少一次 `defer`（这是本任务的核心验收）；baseline 在相同时刻原生压缩。报告给出每次阈值决定的 `before / after / T` 与候选数。
2. **每轮 10 次 read** 与 **逐份 read**：沿用 07 的回归，candidate 仍能 defer。
3. **偷懒轨迹**（只读 5 份）：仍被 `threshold-not-reached` 熔断，覆盖率低。
4. 新增一个断言：一批 20 份读取的 chars/4 代理总量 ≤ `0.25 × 64K`。

如果 20 次 read 仍无法 defer，先停下，在报告里写清楚 `before/after` 和差多少，不要改卸载逻辑、阈值或保留区来凑结果。

## C. 费用预估

按新规模重算 1 / 10 / 20 次 read 每轮三种轨迹的 N=3 请求数和合计输入（沿用 07 的 2,500–3,000 token/份放大法，按新单份大小等比折算，加 25% 规划余量）。给出建议的请求数与合计输入停止线，特别说明最坏情形（每轮 1 次 read）会不会顶到停止线、会停在第几次运行。不调用模型。

## 不做

- 不跑真实模型，不改 sol-pi、Pi fork、阈值、保留区、熔断规则、rotom 默认。

## 验收命令（规划者会重跑）

```sh
cd rotom/evals
npx vitest run test/compaction-offload-eval.test.ts
ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE=0 npx vitest run --config vitest.test.config.ts \
  test/compaction-offload-live.test.ts test/compaction-offload-entry.test.ts \
  test/compaction-offload-metadata.test.ts test/compaction-offload-read.test.ts
ROTOM_EVAL_COMPACTION_OFFLOAD=1 ROTOM_EVAL_PROVIDER=rotom-offload-faux ROTOM_EVAL_MODEL=replay npx vitest run cases/compaction-offload.eval.ts
npm test && npm run typecheck
cd ../..
git diff --check origin/main...HEAD
python3 scripts/audit-public.py --root .
```

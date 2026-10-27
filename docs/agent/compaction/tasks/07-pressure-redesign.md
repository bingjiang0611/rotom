# 任务 07 · 让真实模型必然越过阈值（零费用）

背景：06 唯一一次真实运行（`d84393e`）里，baseline 第一阶段该读 81 份约 8 KiB 的文件，实际只用了 11 轮、14 次工具调用，平均每次请求上下文约 1.3 万 token，没碰到 64K 阈值就被熔断停下。规划者的判断见 [06 报告的核验意见](../reports/06-second-replay.md#核验意见规划者2026-10-26)：模型多半用 `bash` 批量查看或跳读，prompt 约束不住；而 05 的 faux 只模拟了批量 `read`。

范围：只改 `rotom/evals/`。模型调用：**无**。不改 sol-pi、Pi fork、rotom 默认、阈值 64K、`keepRecentTokens`、熔断上限和停止规则（06 证明 `threshold-not-reached` 熔断是有效的省钱保护，保留）。报告写到 `docs/agent/compaction/reports/07-pressure-redesign.md`。

## A. 轨迹元数据（先做，下次真实运行必须有）

在每次运行的 metrics 行里加，只写元数据，不写任何正文：

- `toolNames`：按工具名计数，例如 `{ read: 81, edit: 1 }`。
- `phase1Coverage`：第一阶段（第一个 prompt 到它的最终回复之间）用 `read` 读到的 manifest 文件**去重数 / manifest 文件总数**，分子分母都给。`read` 带 `offset/limit` 只读了一部分的也算读到，但另计 `partialReads`。
- `contextPeak` 与 `contextByTurn`：每轮 assistant usage 的 `input + cacheRead + cacheWrite`（即本次请求的上下文规模），给峰值和逐轮数组。这是判断「离阈值差多少」的直接证据。
- 路径只记是否属于 manifest，不记其它路径；fixture 路径本身是合成的，可以写进私有 JSONL，报告里只写聚合数。

faux 测试覆盖这三个字段的精确值。

## B. 去掉 `bash`，让第一阶段只能逐份读

- `REPLAY_TOOLS` 改为 `["read", "edit", "write", "obs_recall"]`，两臂相同。这会让回放离日常使用远一点，但本实验测的是卸载机制在压力下的表现，不是模型怎么选工具；报告写明这个取舍。
- 任务 prompt 不再要求模型「Run node check.mjs / node test.mjs」，改为「完成后回复 DONE」。检查仍由 `gradeReplay` 在运行结束后执行，判分规则不变。
- `multi-file-fix` 原来要靠 `node test.mjs` 看失败日志：把同一份失败日志（`failureLog` + 断言说明，约 4.5 KiB）作为 fixture 文件 `logs/test-output.txt` 放进 manifest，prompt 改成「读 logs/test-output.txt 了解失败」。`test.mjs` 仍在工作区，判分仍跑它并要求未被修改。
- `read` 工具一次只读一个路径，不能一次打开整个目录。请执行者核实 Pi 的 `read` 对目录、通配符和超长文件的行为（8 KiB 文件不会被截断），写进报告。
- prompt 的其它措辞保持中性，不提压缩、卸载、`obs_recall`。

## C. faux 证明

在现有 faux 脚本基础上增加两条：

1. **最省的合规轨迹**：第一阶段每轮并行 20 次 `read`（比 06 观察到的更激进），每份文件的 token 按 05 的估算口径计，证明三个任务在第一阶段结束前都越过 64K。如果某个任务越不过，就增加该任务的材料份数（不改阈值），直到越过并留出至少 30% 余量（第一阶段累计 ≥ 83K）。
2. **偷懒轨迹**：第一阶段只读 manifest 和 5 份文件就回复 READY。断言 `phase1Coverage` 低、`thresholdCompactions=0`，并且现有熔断把它标成 `threshold-not-reached`。这证明下次如果模型还偷懒，我们会花很少的钱就停下，并且能从元数据看出是偷懒而不是机制问题。

## D. 费用预估更新

按 B 之后的任务规模（逐份读，平均每份约 2.5–3K token）重估 N=3 的请求数和合计输入区间，对照现有授权上限（2,000 次请求、1 亿合计输入）判断是否够用；不够就给出建议上限。不调用模型。

## 不做

- 不跑任何真实模型；06 的授权已消费，第三次付费回放由规划者另写授权记录、bob 确认。
- `LIVE_AUTHORIZATION` 保持 `null`。
- 不改阈值、`keepRecentTokens`、熔断规则、sol-pi 判定逻辑。

## 验收命令（规划者会重跑）

```sh
cd rotom/evals
npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always
npx vitest run test/compaction-offload-eval.test.ts
ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE=0 npx vitest run --config vitest.test.config.ts \
  test/compaction-offload-live.test.ts test/compaction-offload-entry.test.ts
ROTOM_EVAL_COMPACTION_OFFLOAD=1 ROTOM_EVAL_PROVIDER=rotom-offload-faux ROTOM_EVAL_MODEL=replay npx vitest run cases/compaction-offload.eval.ts
npm test && npm run typecheck        # 按 04a 报告的方法选当前产品 Pi
cd ../..
git diff --check origin/main...HEAD
python3 scripts/audit-public.py --root .
```

## 报告必须写明

- A 的三个字段在 faux 下的样例值（聚合即可）。
- B 的改动清单和 `read` 工具行为核实结论。
- C 两条 faux 轨迹的逐轮上下文峰值和是否越过阈值；如果加了材料，写新份数。
- D 的新预估与建议上限。

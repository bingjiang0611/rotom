# 任务 05 · 校准推迟判定与回放设计（零费用），为第二次付费回放做准备

背景：04b 唯一一次真实回放（`609cfc1`）18/18 判分通过，但 candidate **一次都没有卸载**：16/18 次运行根本没到阈值，config-aggregate 第 1 轮两臂各触发 2 次阈值，candidate 也全部走了原生摘要。原因没有被记录下来（ledger 随临时 session 一起被清理了）。本任务先把原因查清、修掉明显的偏差，再重新设计回放，最后才申请新的付费授权。

范围：`packages/rotom-sol-pi/`（判定估算）、`rotom/extensions/third-party/` 与 vendor（如升 `.rotom.5`）、`rotom/evals/`（回放）。模型调用：**无**。报告写到 `docs/agent/compaction/reports/05-calibrate-and-rerun.md`。

## 规划者的初步诊断（需要执行者用证据证实或推翻）

1. **chars/4 低估了真实 token。** 回放 fixture 每行是 `// <64 位十六进制>`，十六进制在真实 tokenizer 下大约 2–3 字符一个 token，远密于 chars/4。推迟判定里 `before` 来自 provider 报告的真实 token，`saved` 却按 chars/4 估，两者单位不一致，节省被系统性低估，于是 `after > 0.6 × T`，判成 `insufficient_savings`。这个偏差在真实代码/日志上也存在，只是程度轻一些。
2. **回放任务撑不到阈值。** 真实模型会一轮并发读很多文件（config-aggregate 第 1 轮 16 轮里 58 次工具调用），总轮数和上下文都远小于 faux 脚本；64K 阈值下 16/18 次运行没触发。
3. **保留区占比不像生产环境。** 生产里阈值约 255K、`keepRecentTokens` 20K，保留区约占 8%；回放阈值 64K 却仍保留 20K（约 31%），再加 system prompt 和工具 schema，`0.6 × 64K` 的目标本来就很难达到。

## A. 让原因可观测（evals）

- 回放的 metrics 行增加 `offloadDecisions`：每次 `reason === "threshold"` 的决定（`defer` / `defer_stale` / `native`，`native` 时带 `reason`）、`before`、`after`、`T`、候选数、候选原文总字节，在 harness 清理临时 session 之前从 Observation Pack ledger 读出来。只要元数据，不要正文。
- faux 测试覆盖：推迟、`insufficient_savings`、`no_candidates` 三种决定都能被正确采集。

## B. 修正判定估算（sol-pi，升 `0.1.0-rotom.5`）

把 `after` 的估算改成**同一单位**：

```
ratio = savedEstimate / contextEstimate      // 两者都用 chars/4，单位一致
after = before × (1 − ratio)
```

其中 `contextEstimate` 是本次压缩时整个上下文（system prompt + 当前分支投影后的消息）的 chars/4 估算，`savedEstimate` 是候选原文与占位符之差的 chars/4 估算。`before` 仍是 `preparation.tokensBefore`。阈值比例 `OFFLOAD_TARGET_RATIO = 0.6` 不变。

- 推迟判定之外的行为不变（候选规则、持久化合同、旧 usage 规则、投影）。
- 单测：同样的候选，在「十六进制密集」与「普通英文/代码」两种文本上，旧算法与新算法的 `after` 对比；新算法在 `before` 按真实比例放大时结论不变。
- 按任务 02 的流程升版本、重打归档、同步 lockfile / `product-config.mjs` / vendor README / UPSTREAM，旧 `.rotom.4` 归档按惯例处理。

如果执行者有证据证明诊断 1 不成立（例如能证明 config-aggregate 那两次的拒绝原因是别的），先停下写进报告，不要硬改。

## C. 重新设计回放（evals）

目标：真实模型下每次运行**至少触发一次**阈值压缩，并且保留区占比接近生产。

1. 两臂把 `keepRecentTokens` 降到 `round(T × 0.08)`（T=64K 时约 5K），写进 settings，报告说明理由（模仿生产比例，而不是为了让 candidate 赢）。
2. fixture 改成更像真实工具输出的文本（代码、日志、JSON 混合，用固定种子生成，不再用整行十六进制），单份仍在 1.5–10 KiB。
3. 调整任务规模，使批量并发读取时上下文也稳定超过 64K：例如第一阶段材料增加到约 60–80 份，或者分三个阶段读。要能在 faux 下证明「即使把每 10 次读取合并成一轮」也会越过阈值（加一个模拟批量读取的 faux 脚本）。
4. 保留 `deferred-exact` 的设计：压缩后必须给出早先读过的精确字符串。
5. 两臂仍只差 `ROTOM_COMPACTION_OFFLOAD`。

## D. 新的费用预估

用 04b 的真实数据校准（04b：每次运行平均约 12 轮、请求总数 219、合计输入 3.85M，其中 cacheRead 约 72%），按新任务规模估算 N=3 的请求数与四项 token 区间，给出建议的请求数与 token 上限。不调用模型。

## 不做

- 不跑任何真实模型。04b 的授权已用完，第二次付费回放需要 bob 另行确认，规划者会写新的授权记录。
- 不改 Pi fork、observability trace 合同。
- 不改 rotom 默认（仍关）。

## 验收命令（规划者会重跑）

```sh
cd packages/rotom-sol-pi
npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always
npm run typecheck && npm test        # 仍只允许 install-guide 2 个已知失败
cd ../../rotom/extensions/third-party
npm ci --ignore-scripts --omit=optional --legacy-peer-deps --replace-registry-host=never
node --experimental-strip-types --test --test-concurrency=1 index.test.ts
cd ../../evals
npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always
npx vitest run test/compaction-offload-eval.test.ts
npx vitest run --config vitest.test.config.ts test/compaction-offload-live.test.ts test/compaction-offload-entry.test.ts
ROTOM_EVAL_COMPACTION_OFFLOAD=1 ROTOM_EVAL_PROVIDER=rotom-offload-faux ROTOM_EVAL_MODEL=replay npx vitest run cases/compaction-offload.eval.ts
npm test && npm run typecheck        # 按 04a 报告的方法选当前产品 Pi
cd ../..
git diff --check origin/main...HEAD
python3 scripts/audit-public.py --root .
```

（第三方测试与 eval 全量需要 04a/02 报告里写的 `ROTOM_PI` 等环境，照做即可。）

# 任务 14 · rotom 默认开启压缩卸载（零费用）

bob 于 2026-10-27 03:38 UTC 在项目线程的决策卡上选择「默认开启」。依据是 11 与 13 的 9 个有效配对（见 [13 报告的核验意见](../reports/13-multi-file-fix-replay.md#核验意见规划者2026-10-27)）。

范围：`rotom/extensions/third-party/`、`rotom/evals/`、文档。**不改 sol-pi 包本身的默认**（`DEFAULT_CONFIG.compactionOffload` 仍为 `false`，不重打归档、不动 lockfile 与 product-config）；只改 rotom 在「无用户配置文件」时提供的默认。模型调用：**无**。报告写到 `docs/agent/compaction/reports/14-default-on.md`。

## A. 翻默认

- `rotom/extensions/third-party/sol-pi.ts`：`ROTOM_SOL_PI_DEFAULT_CONFIG.compactionOffload` 改为 `true`，注释同步（只有 Online Context Compact 保持关闭）。
- 语义保持现状并在报告里写清：已有用户 SoL-Pi 配置文件时完全以文件为准（文件里没写 `compactionOffload` 就按 sol-pi 自身默认 `false`）；`ROTOM_COMPACTION_OFFLOAD=0` 最后覆盖为关；`=1` 仍要求 Observation Pack。
- `index.test.ts` 更新：无配置文件时默认开；`=0` 关；有配置文件且未写该字段时关；有配置文件且 Observation Pack 关时，`=1` 仍关并报一行。

## B. 生产默认组合的 faux 回归

回放里 Action Fusion 是关的，生产默认是开的。在 `rotom/evals/` 加一条 faux 用例：用 rotom 无配置文件时的真实默认组合（Action Fusion + Observation Pack + Compaction Offload 开，Reducer 关以免额外请求），跑一个「读一批文件 → 越过阈值 → 推迟 → 用 Action Fusion 的 edit 改文件 → `obs_recall` 取回被卸载结果」的脚本，断言：推迟发生、edit 正常执行、召回返回原文、Action Fusion 的工具结果不会被误当成卸载候选导致后续 edit 失败（如果它本来就会被卸载，就断言召回能取回）。`then_run` 只在 faux 里调用无害命令，不出网。

## C. 文档

- 根 `CLAUDE.md` 第 3 节那半句改为：「Compaction Offload 默认开启（`ROTOM_COMPACTION_OFFLOAD=0` 关闭）：阈值压缩前先把旧的中等工具结果换成 `obs_recall` 指针，空间够就推迟原生摘要；回放实测见 `docs/agent/compaction-offload.md`」。只改这一处。
- 新建 `docs/agent/compaction-offload.md`（≤ 60 行，供 main 长期保留）：做什么、开关与配置文件语义、依赖 Observation Pack、9 个有效配对的结论表（只列 11/13 报告里的原值汇总）、局限（单模型、64K 缩小阈值、回放内 Action Fusion 关、样本小、秒数不能外推生产）、怎么用 `rotom/evals` 复跑（指向 evals README）。
- `docs/usage.md` SoL-Pi 小节、`rotom/extensions/third-party/vendor/README.md` 第 67 行描述同步为默认开启。

## 不做

- 不改 sol-pi 源码、归档、版本；不改 Pi fork；不升 rotom 产品版本、不打包、不发 npm。
- 不调用真实模型。
- 不推 main。合入 main 由规划者在核验后另开 PR。

## 验收命令（规划者会重跑）

```sh
cd rotom/extensions/third-party
npm ci --ignore-scripts --omit=optional --legacy-peer-deps --replace-registry-host=never
node --experimental-strip-types --test --test-concurrency=1 index.test.ts
cd ../../evals
npx vitest run test/compaction-offload-eval.test.ts
npm test && npm run typecheck
cd ../..
git diff --check origin/main...HEAD
python3 scripts/audit-public.py --root .
```

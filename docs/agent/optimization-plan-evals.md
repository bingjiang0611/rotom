# 优化方案的评测入口（2026-11-09 方案 P1）

[优化方案](optimization-plan-2026-11-09.md) P1 新增的评测都在这里；通用的 harvest / 回放 / gate 流程与准入规则见 [Agent 优化循环](optimization-loop.md)，本机执行顺序见 [交接说明](optimization-handoff-2026-11-10.md)。账本条目在 [`rotom/evals/loop/ledger/optimization-plan-2026-11-09.json`](../../rotom/evals/loop/ledger/optimization-plan-2026-11-09.json)。

## 压缩后续跑（P1-1）

状态 `oracle-ready`。`src/compaction-continuation-cases.ts` 的 `behavior-standing-directive-after-compaction`（压缩前给出“不要停下直到完成”，压缩后只问进度，新到的输入仍须处理完）与 `behavior-exact-detail-after-compaction`（压缩前给出 README 没有的导出参数，压缩后“按同样要求”导出，不得先用错参数跑）在第 1 轮后真实调用 `session.compact()`，并用 `keepRecentTokens: 1` 保证第 1 轮只经摘要保留。离线 oracle（`test/compaction-continuation.test.ts`）证明：压缩后第 1 轮原文不在上下文、摘要在；正确轨迹通过；再问一次、没有压缩、忘记参数或先错后改都失败。尚未跑 baseline；按上面的准入顺序在 `qoder/dfmodel` 上对冻结产品各跑 3 次（另一例把 `CASE` 换成 `behavior-exact-detail-after-compaction`）。压缩本身也走同一模型，计入用量：

```sh
cd rotom/evals
ROTOM_EVAL_CONTINUATION=1 ROTOM_EVAL_CONTINUATION_REPEATS=3 \
  ROTOM_EVAL_CONTINUATION_CASE=behavior-standing-directive-after-compaction \
  ROTOM_EVAL_BASELINE_PRODUCT=/absolute/frozen/rotom \
  ./bin/eval --provider qoder --model dfmodel cases/continuation-regression.eval.ts
```


## 同一产品的特性开关对照（P1-3 / P1-5）

已有 baseline/candidate 两臂的套件可以对同一提交做“开/关某个特性”的配对：用同一提交的第二个 checkout 作 baseline 目录，再只对 baseline 臂施加覆盖（`src/pi-harness-environment.ts`）。

- `ROTOM_EVAL_BASELINE_EXCLUDE_RESOURCES=extension:coding-policy`：baseline 臂不加载 coding-policy（P1-3）。资源键写错会直接报错，不会留下两臂相同的“对照”。
- `ROTOM_EVAL_BASELINE_ENV='{"ROTOM_EVIDENCE_REDUCER":"0"}'`：只给 baseline 臂设置 `ROTOM_*` 变量，例如关掉 Reducer（P1-5）。不能设置 `ROTOM_EVAL_*`、`ROTOM_PI`、`ROTOM_NODE` 等身份与选择变量。
- baseline 与 candidate（未设置时为当前 checkout）是同一目录时拒绝运行，因为覆盖会同时作用于两臂。

```sh
git worktree add /absolute/rotom-same "$(git rev-parse HEAD)"
npm --prefix /absolute/rotom-same/rotom/runtime/pi ci --ignore-scripts
npm --prefix /absolute/rotom-same/rotom/extensions/third-party ci --ignore-scripts --omit=optional --legacy-peer-deps
cd rotom/evals
ROTOM_EVAL_BASELINE_PRODUCT=/absolute/rotom-same/rotom \
  ROTOM_EVAL_BASELINE_EXCLUDE_RESOURCES=extension:coding-policy \
  ROTOM_EVAL_CONTINUATION=1 ROTOM_EVAL_CONTINUATION_REPEATS=5 \
  ./bin/eval --provider qoder --model dfmodel cases/continuation-regression.eval.ts
```

P1-3 在 continuation、tool-efficiency、tool-error-repair 与 coding-execution-hygiene 上各跑一遍，看 candidate（有 coding-policy）相对 baseline 是否有可重复的改善；无差异的部分按“提示房租”规则删除。P1-5 把覆盖换成 `ROTOM_EVAL_BASELINE_ENV`，选会产生 ≥4 KB 构建/测试输出的套件，并需要本机 `openai-codex` 登录；比较任务成功率、总 token（含 Reducer 自己的请求）与耗时。P1-4（Subagent 有/无）用独立套件 `cases/subagent-ab.eval.ts`：同一产品、同一组只读工具，候选臂多 `subagent`/`subagent_wait`；两个任务（跨 24 个服务的 legacyFetch 清点、按 README 约定的代码审查）答案由生成的 fixture 决定，按正确性判分，父会话用量与工具次数随结果记录。子任务用量在本次运行私有的 Subagent store 里，不在分数中。离线 oracle（`test/subagent-ab.test.ts`）证明答案键与 fixture 一致、判分能区分漏报/误报/被干扰项骗到，以及真实会话里两臂只差 Subagent 工具；委派本身需要真实模型：

```sh
cd rotom/evals
ROTOM_EVAL_SUBAGENT_AB=1 ROTOM_EVAL_SUBAGENT_AB_REPEATS=3 ./bin/eval --provider qoder --model dfmodel cases/subagent-ab.eval.ts
```

# 交接：在维护者本机完成优化方案的验证与付费评测（2026-11-10）

读者是在维护者 Mac 上工作的 Agent。云端会话已完成优化方案（[方案](optimization-plan-2026-11-09.md)、[执行记录](optimization-plan-2026-11-09-execution.md)）中不需要真实模型的部分，但没有 Qoder 登录、本机会话记录和 macOS。你的任务是在本机把剩下的验证和评测**一次跑完、自己判定、如实记录**，结果提交到同一分支，由云端会话核验。

尽量一次做完，不要每步停下来问。只有下文“必须停下问用户”的情况才打断用户。

## 0. 边界（不可越过）

- 只在分支 `claude/rotom-pi-features-adylp5` 上提交和推送；**不合入 `main`、不发布 npm、不改动或覆盖正在使用的 rotom 安装**（`~/.local/...` 下的安装与存活会话都不碰）。
- 评测只用本仓库 checkout 与 `git worktree`，不用当前在用的 rotom 命令跑评测。
- 付费范围：`qoder/dfmodel`。用户授权见 [optimization-loop.md](optimization-loop.md) 的 gate 与回放授权（不设预算上限、只发脱敏 fixture 与产品提示），以及用户 2026-11-10 把本机验证交给你的决定。**P1-5 会额外调用 `openai-codex/gpt-5.6-luna`（Reducer），不在已有授权内：开始前问用户一次，不同意就跳过并记为 blocked。**
- harvest 读取本机会话：只在仓库里记录聚合数字，**绝不提交会话正文、摘录、绝对路径或 `~/.rotom/loop/` 下的文件**；提交前把出现的 home 路径换成 `~`。
- 外部结果 unknown 时不重放；不为让结果好看改 judge、阈值或删反例（[optimization-loop.md](optimization-loop.md) ③④）。

## 1. 分支内容

基线：公开 `main` 的 `9798c5a`。本分支在其上的提交（rebase 后）：

| 提交主题 | 内容 | 云端已验证 |
|---|---|---|
| fix(pi) keep the tail of tool results | Pi fork `1.4.0-rotom.3`：摘要序列化保留头尾、限制工具参数 | 压缩相关 vitest；构建期定向测试（非 root） |
| build(pi) rebuild archives（若有） | 在 rebase 后的源码上重建 rotom.3（含 main 的 Retry-After 修复） | `check:pi` |
| fix(coding-policy) prompt section | policy 改为 `<coding_policy>` 分段，不再 forced prompt | 真实 AgentSession + faux；旧实现对照失败 |
| fix(subagents) 0.52.1-rotom.15 | 屏蔽 `share`/`sessionDir`；scout 只读；完成通知 8 KB 上限+私有全文（7 天）；阻塞 wait 默认 10/上限 15 分钟 | 组件 unit/SDK/typecheck；Linux `check-personal` |
| feat(evals) harvest after compaction | P1-2：每次压缩后的重读/介入/回查/cache 指标 | 合成会话单测 |
| feat(evals) compaction replay cases | P1-1：两个压缩后续跑用例（oracle-ready） | 离线 oracle 6 例 |
| feat(sol-pi) ROTOM_EVIDENCE_REDUCER | 只开关 Reducer 的环境变量 | 单测（旧代码对照失败） |
| feat(evals) feature on/off arms | P1-3/P1-5：同一产品只在 baseline 臂排除资源/注入 `ROTOM_*` | 单测 + 端到端 faux 请求 |
| feat(evals) Subagent on/off suite | P1-4：清点+审查两任务，两臂只差 Subagent 工具 | 离线 oracle 4 例 |

云端（Linux、root 容器）已知、与本分支无关的既有问题，见执行记录“既有问题”：Linux 上 `third-party/index.test.ts` 不退出（macOS 不走该路径）；footprint 合同的 schema 字节在 `main` 上已不成立；`npm run test:compat` 文件清单过时；`docs/usage.md` 超 20 KB 预算。遇到时记录、不修。

## 2. 准备（一次性）

```sh
git fetch origin claude/rotom-pi-features-adylp5 && git switch claude/rotom-pi-features-adylp5
B=$(git rev-parse HEAD)
npm --prefix rotom/runtime/pi ci --ignore-scripts --bin-links=false --registry=https://registry.npmjs.org --replace-registry-host=never
npm --prefix rotom/extensions/third-party ci --ignore-scripts --omit=optional --legacy-peer-deps --registry=https://registry.npmjs.org --replace-registry-host=never
npm --prefix rotom/evals ci --ignore-scripts
npm --prefix packages/rotom-subagents ci --ignore-scripts --no-audit --no-fund
# 冻结基线：公开 main（不含本分支改动）
git worktree add "$PWD/../rotom-base" 9798c5a
npm --prefix ../rotom-base/rotom/runtime/pi ci --ignore-scripts --bin-links=false --registry=https://registry.npmjs.org --replace-registry-host=never
npm --prefix ../rotom-base/rotom/extensions/third-party ci --ignore-scripts --omit=optional --legacy-peer-deps --registry=https://registry.npmjs.org --replace-registry-host=never
# 同一提交的第二个 checkout：P1-3/P1-5 的对照臂
git worktree add "$PWD/../rotom-same" "$B"
npm --prefix ../rotom-same/rotom/runtime/pi ci --ignore-scripts --bin-links=false --registry=https://registry.npmjs.org --replace-registry-host=never
npm --prefix ../rotom-same/rotom/extensions/third-party ci --ignore-scripts --omit=optional --legacy-peer-deps --registry=https://registry.npmjs.org --replace-registry-host=never
```

下文 `BASE=<绝对路径>/rotom-base/rotom`、`SAME=<绝对路径>/rotom-same/rotom`。Qoder 未登录或 `dfmodel` 不可用时停下问用户（这是唯一需要用户手动操作的前置条件）。

## 3. 步骤（按顺序；每步结果写入结果文件对应小节）

### S1 本机确定性检查（无模型调用）

| 检查 | 命令 | 通过条件 |
|---|---|---|
| Pi 归档与源码一致 | `npm --prefix rotom run check:pi` | 退出 0 |
| 产品门禁 | `rotom/bin/check-personal` | 只允许出现上面列的既有问题；新增失败要定位 |
| Subagent 组件 | 在 `packages/rotom-subagents`：`npm test && npm run test:sdk && npm run typecheck` | 全过 |
| eval 离线测试与类型 | `npm --prefix rotom/evals test`；`cd rotom/evals && npx tsc --noEmit -p tsconfig.json` | 全过 |
| distribution | `npm --prefix rotom run test:distribution` | 全过 |

失败若由本分支改动引起：在本分支修复（最小改动、补回归测试、旧代码对照失败），重跑受影响检查，单独提交。若是既有问题：记录，不修。

### S2 真实会话冒烟（L2，少量 dfmodel 调用）

在临时目录建一个小项目，用本分支的 `rotom/bin/rotom-launcher` 以 `qoder/dfmodel` 非交互（print）模式跑一个“读一个文件并改一行”的任务。核对该会话 JSONL：
- system 消息的 `sections` 含 `coding_policy`，且没有 forced 的整块 system 文本；
- 任务正常结束、无 provider/扩展错误。
如果 `subagent` 能被 `search_tools` 加载，再让它委派一次只读 scout 检索，确认完成通知里没有 `share` 相关行、正文 ≤8 KB 或带截断说明。记录会话条数与结论，不提交会话内容。

### S3 gate（本分支改了 coding-policy、压缩和 Subagent，按规定必须跑）

```sh
npm --prefix rotom/evals run loop -- gate --baseline "$BASE" --smoke
npm --prefix rotom/evals run loop -- gate --baseline "$BASE"
```

通过条件：退出码 0（held）。`regressed` 时：读 `~/.rotom/loop/gate-*/` 的分数与轨迹，判断是否本分支引起；是就修、加回归、重跑；不是就记录证据。`unknown`（可评分配对不足）重跑一次，仍 unknown 就记录。

### S4 harvest（P1-2）

```sh
npm --prefix rotom/evals run loop -- harvest --days 28 --no-excerpts
```

只把 `summary.json` 的 `compactions` 汇总、周介入率与 After compaction 表抄进结果文件。重点：压缩后每 100 轮介入 vs 全局；重读率；cacheDrops。

### S5 P1-1 压缩后续跑 baseline

```sh
cd rotom/evals
for C in behavior-standing-directive-after-compaction behavior-exact-detail-after-compaction; do
  ROTOM_EVAL_CONTINUATION=1 ROTOM_EVAL_CONTINUATION_REPEATS=3 ROTOM_EVAL_CONTINUATION_CASE=$C \
    ROTOM_EVAL_BASELINE_PRODUCT="$BASE" ./bin/eval --provider qoder --model dfmodel cases/continuation-regression.eval.ts
done
```

按 [optimization-loop.md](optimization-loop.md) ③ 判定 baseline：0/3 失败 `not-reproduced`、1/3 `flaky-candidate`、≥2/3 `reproduced-regression`。只有 `reproduced-regression` 才把该用例加入 `rotom/evals/loop/gate.json`（`role: reproduced`，引用账本 `L-2026-11-09-compaction-continuation-cases`，`reproduction` 写模型/日期/基线/结果）。candidate 若也失败，记为“已复现但本分支未修复”，不要改 judge。先用 `loop -- gate --case <id> --smoke` 的方式或单对运行确认分数可评再跑满 3 次。

### S6 P1-3 coding-policy 开/关

baseline 臂 = `SAME` 且排除 coding-policy，candidate 臂 = 本 checkout：

```sh
cd rotom/evals
export ROTOM_EVAL_BASELINE_PRODUCT="$SAME" ROTOM_EVAL_BASELINE_EXCLUDE_RESOURCES=extension:coding-policy
ROTOM_EVAL_CONTINUATION=1 ROTOM_EVAL_CONTINUATION_REPEATS=5 ./bin/eval --provider qoder --model dfmodel cases/continuation-regression.eval.ts
ROTOM_EVAL_TOOL_EFFICIENCY=1 ./bin/eval --provider qoder --model dfmodel cases/tool-efficiency.eval.ts
ROTOM_EVAL_TOOL_ERROR_REPAIR=1 ROTOM_EVAL_TOOL_ERROR_REPAIR_REPEATS=5 ./bin/eval --provider qoder --model dfmodel cases/tool-error-repair.eval.ts
ROTOM_EVAL_REPEATS=5 ./bin/eval --provider qoder --model dfmodel cases/coding-execution-hygiene.eval.ts
unset ROTOM_EVAL_BASELINE_PRODUCT ROTOM_EVAL_BASELINE_EXCLUDE_RESOURCES
```

各套件的启用变量以文件头注释为准（上面是当前代码里的名字；不符时以代码为准并记录）。按用例记录 candidate 与 baseline 的通过数、token 与工具调用差。判定：某套件 candidate 相对 baseline 无可重复改善 → 记 `no-difference`；有改善 → 记具体用例。**不在本次删除 coding-policy 规则**，删减属于 P2，交给用户决定。

### S7 P1-4 Subagent 有/无

```sh
cd rotom/evals
ROTOM_EVAL_SUBAGENT_AB=1 ROTOM_EVAL_SUBAGENT_AB_REPEATS=3 ./bin/eval --provider qoder --model dfmodel cases/subagent-ab.eval.ts
```

先跑 1 次确认两臂都产出分数、候选臂确实调用了 `subagent`（`subagentCalls>0`）；候选臂一次都没委派时如实记录（这本身是结论：模型在这类任务上不委派）。子任务用量在本次运行私有的 Subagent store（`$TMPDIR/rotom-subagent-ab-*/store`）里，可从其中的结果文件汇总 usage；拿不到就记 unknown。比较：正确率、父会话 usage、子任务 usage（如有）、耗时。

### S8 P1-5 Reducer 开/关（需用户先同意 openai-codex 花费）

同意后：

```sh
cd rotom/evals
export ROTOM_EVAL_BASELINE_PRODUCT="$SAME" ROTOM_EVAL_BASELINE_ENV='{"ROTOM_EVIDENCE_REDUCER":"0"}'
ROTOM_EVAL_TOOL_ERROR_REPAIR=1 ROTOM_EVAL_TOOL_ERROR_REPAIR_REPEATS=5 ./bin/eval --provider qoder --model dfmodel cases/tool-error-repair.eval.ts
ROTOM_EVAL_TOOL_EFFICIENCY=1 ./bin/eval --provider qoder --model dfmodel cases/tool-efficiency.eval.ts
unset ROTOM_EVAL_BASELINE_PRODUCT ROTOM_EVAL_BASELINE_ENV
```

先确认候选臂确实触发了 Reducer（≥4 KB 诊断输出且有 Reducer 回执）；没有触发就说明这两个套件测不到 Reducer，记为“套件不覆盖”，不要硬凑结论。比较成功率、总 token（含 Reducer 请求）与耗时。

## 4. 记录与交回

1. 填写 [optimization-results-2026-11.md](optimization-results-2026-11.md) 的每一节；每个数字注明来源（命令、日期、`~/.rotom/loop/...` 目录名，路径写成 `~`）。
2. 更新 `rotom/evals/loop/ledger/optimization-plan-2026-11-09.json`（本方案的账本分片）中这些条目的 `measurement`/`result`/`evidence`/`decision`：`L-2026-11-09-coding-policy-sections`、`L-2026-11-09-compaction-serialization-head-tail`、`L-2026-11-09-subagent-surface-bounds`、`L-2026-11-09-compaction-continuation-cases`、`L-2026-11-09-post-compaction-harvest`、`L-2026-11-10-same-product-feature-arms`、`L-2026-11-10-subagent-ab-suite`。gate held 时三条机制条目可改为 `decision: shipped`（`evidence` 仍按实测，没有改善证据就保持 `unmeasured`）。`npm --prefix rotom/evals run loop -- ledger` 必须通过。
3. 提交前：`git diff --check`；`node scripts/check-staged-file-size.mjs`；`python3 scripts/audit-public.py --root .`（tree 扫描，不能有新增发现）。
4. 按可读粒度提交（修复、gate 清单、结果记录分开），推送到 `claude/rotom-pi-features-adylp5`。提交信息结尾沿用仓库现有的 Co-Authored-By 约定。
5. 结果文件顶部的“总览”表给出每步状态：`passed` / `failed`（附证据）/ `blocked`（附缺什么）/ `skipped`（附原因）。

## 5. 必须停下问用户的情况

- Qoder 未登录或 dfmodel 不可用；
- P1-5 的 openai-codex 花费；
- 需要改产品默认行为、删规则或功能（P2 范围）；
- gate `regressed` 且确认由本分支引起、但修复需要改变方案里已定的设计。

其余情况自行处理并记录。

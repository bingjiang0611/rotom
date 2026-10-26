# 任务 15 · 用真实模型跑一次行为用例 A/B

阶段：Phase 4（第三步：失败集 → 回归测试的首次真实运行）。报告写到 `docs/agent/eval-system/reports/15-behavioral-ab-real-model.md`。

## 目标

任务 14 的 5 个行为用例只用合成证据测过判定逻辑，从没让真实模型跑过，所以不知道：

1. 当前产品在这 5 个场景里实际会不会犯复盘中的错；
2. 判定在真实输出上会不会误判（真实回复的措辞、命令写法比合成证据多样得多）；
3. 两个产品版本之间能不能看出差别。

本任务只做一次小规模真实运行，回答这三个问题。**不改产品代码，不改用例和判定。** 发现判定误判，只记录，留给下一个任务修。

## 授权与预算（bob 已在 2026-10-26 选择「先用真实模型跑一次 A/B」）

- 模型：bob 在提示词里给出的 `provider/model`。没给就停下来问，不要自己挑。
- 规模：5 个用例 × baseline / candidate 两臂 × 重复 1 次 = **10 次 agent 运行，这是上限**。
- 不重跑。某次运行因为基础设施失败（provider 报错、超时、harness 崩溃），结果记为 `unknown` 并写明原因，不补跑；如果 10 次里 `unknown` 超过 2 次，停下来交接，不要继续花钱排查。
- 先冒烟再全跑：先只跑 `behavior-report-fidelity` 一个用例的两臂（2 次）。确认 harness 正常、两臂确实加载了不同产品、用量在预期内，再跑剩下 8 次。冒烟的 2 次计入 10 次上限。
- 每次运行记录用量：provider 报告的 token 和 credits（拿不到就写 unknown），以及耗时。不要用 byte/4 之类的估算冒充用量。

## 两臂怎么定

| 臂 | 产品 | 要求 |
|---|---|---|
| baseline | 公开 `origin/main` 的 `rotom/` | 用 `git rev-parse` 读出精确 SHA 写进报告；放在**单独的** worktree，在那里安装运行时依赖 |
| candidate | `eval/system` 当前 HEAD 的 `rotom/` | 同样记录 SHA；用 bob 的 `~/rotom-eval` worktree 或另建一个 |

- 不要在有存活会话使用的 checkout 里重装运行时，也不要覆盖 bob 日常使用的安装。
- 两臂必须用同一个模型、同一个 `thinkingLevel`、同一个工具白名单。运行器已经按奇偶轮换 baseline / candidate 的顺序，不要改。
- 运行方式沿用 `rotom/evals/README.md` 里行为回归那一节：`ROTOM_EVAL_BEHAVIORAL_REGRESSION=1`、`ROTOM_EVAL_PROVIDER`、`ROTOM_EVAL_MODEL`、`ROTOM_EVAL_BASELINE_PRODUCT`（必要时 `ROTOM_EVAL_CANDIDATE_PRODUCT`），重复次数用默认值 1。

## 产出

### 私有原始结果（不进仓库）

写到 `~/.rotom/evals/ab/<日期>-behavioral/`（目录 0700、文件 0600）：每次运行的完整输出，包括最终回复、工具调用、observe 的文件、每个检查项的结果、用量和耗时。工作区都是合成的，但回复里可能出现 bob 机器上的绝对路径、用户名或 HOME，所以原样输出只放这里。

### 报告（进仓库）

1. **运行信息**：模型、两臂 SHA、开始和结束时间、10 次运行各自的状态（scored / unknown）和总用量。
2. **结果表**：每个用例 × 每臂，列出得分（0/1/unknown）、没通过的检查项名、工具调用次数、用量。
3. **逐条复核每个没通过的检查项**（最重要）。对照私有原始输出，把每一条归为下面两类之一，并写一句理由：
   - **真实行为问题**：agent 确实犯了复盘中的错，例如真的没查状态就说「都在运行」；
   - **判定误判**：agent 的行为其实合理，是判定没认出来，例如用了正则没覆盖的说法或命令。
   
   理由里可以引用回复或命令的片段，但每段不超过 200 字，并且要先把绝对路径、用户名、主机名替换成 `<path>`、`<user>`、`<host>`。
4. **每个用例的结论**，按这个口径写：
   - 两臂都通过：这个模型上用例到顶了，暂时没有区分度；
   - 两臂都失败且是真实行为问题：发现了产品要修的真问题，列为后续候选；
   - 两臂结果不同：记下来，但每臂只跑了 1 次，不能据此说哪个版本更好；
   - 有判定误判：列出要改的判定和建议的改法，下一个任务处理。
5. **未验证项**：明确写出只跑了 1 次重复、只用了 1 个模型，结论不能推广。

## 约束

- 只推 `eval/system`，不推 main，不 force push，不改写历史，用 GitHub noreply 身份提交。
- 不读、不分析 bob 的真实会话，不在真实会话上触发后台 judge。
- 报告和提交里不能出现密钥、token、绝对路径、用户名。提交前跑 `python3 scripts/audit-public.py --root .`。
- 不改 `rotom/evals/src/behavioral-regression-cases.ts`、eval 文件和任何产品代码。确实需要动运行器才能跑起来（比如 harness 的 bug）就先停下来，在报告里说明，不要自己扩大改动。
- 完成后把 README 状态表第 15 行改成 `in-review`。

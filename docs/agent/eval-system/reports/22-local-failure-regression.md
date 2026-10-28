# 22 失败集接入本机一键回归：实现报告

状态：`in-review`。L1 与 L2 已跑；真实私有会话与真实模型（L3）未运行，需要单独授权。

## 做了什么

把已复核的回放点冻结成一份可复用的失败集，再用一条命令对比「改动前产品 / 改动后产品 / 原始回复」。

| 能力 | 位置 | 行为 |
|---|---|---|
| 集合与对照逻辑 | `rotom/evals/scripts/regression-set.mjs` | 选择器（`all`/`fail`/`failSet`/显式点列表）、冻结集合与 SHA-256 摘要、`compareArms`、退出码、报告汇总、会话索引、建议生成 |
| 命令 | `rotom/evals/scripts/eval-regression.mjs` | `prepare` / `run` / `suggest` / `add` / `help` |
| 入口 | `rotom/evals/bin/eval-regression`、`rotom/evals/package.json`、`rotom/bin/rotom-launcher` | `rotom eval-regression …`（仅仓库 checkout，见下） |
| 运行器报告字段 | `rotom/evals/scripts/session-replay.mjs` | 每行补 `judgePromptVersion`，供「两次运行用了不同判定提示词」检测 |
| 面板诚实失败 | `rotom/extensions/observability/eval/replay-service.mjs` | 运行器缺失时返回 `replay_runner_unavailable`（503），不 spawn 必然失败的子进程 |

关键行为：

- 冻结即承诺：集合记录每个点的会话 SHA-256、assistant 锚点、期望与判定方式。会话被改动或找不到时，`prepare` 明确排除并给出原因，`run` 拒绝启动，不会悄悄重新定位锚点。
- `run` 必须显式给出 baseline 与 candidate。少一个就退出 2，不降级成单臂「成功」。
- 发送前打印计划：点数、重复次数、两臂路径、模型、字符量、脱敏处数、调用数、计划摘要。没有 `--yes` 不 spawn；`--plan-digest` 与当前计划不一致也拒绝。
- 结论分七类：`regression`、`improved`、`still-failing`、`stable-pass`、`judge-blind`、`inconclusive`、`incomplete`；重复运行结果不一致、缺臂、判定提示词版本不一致一律 `inconclusive`。
- 退出码：`0` 全部 held/improved；`1` 存在确定失败；`2` 无法判断、集合为空或被排除过点。
- `suggest` 只写私有草稿（`replay/suggestions/`），`add … --yes` 才写回放点；两者都不改人工 verdict。
- 集合、报告、草稿都是私有目录 0700 / 文件 0600，拒绝 symlink、路径逃逸和摘要不符的篡改。

## 与任务文档的偏差（已同步进文档）

1. **命令是 checkout-only，不是产品功能。** `rotom/scripts/pack-release.mjs` 的 `releaseFiles` 明确拒绝任何 `evals` 路径，发行包没有 `evals/`，回放运行器只能从仓库运行。因此 launcher 只在 checkout 中路由该命令；安装态评测页对「运行回放」明确失败。没有为此放宽发行清单，也没有改写安装包。
2. **L2 用真实 CLI + 真实产品 runtime + faux provider。** 原文档写的「实际安装产物 + faux」不成立（安装产物不含运行器）。现 L2 在临时目录、合成会话上跑完整 `prepare → 计划 → run → 报告`，两臂都加载真实 runtime。
3. **新增 `--extension` / `--thinking` 透传。** `--extension` 让离线检查注入 faux provider，也是排查 provider 差异的最小手段；两者都进计划摘要。

## 验证

| 检查 | 结果 |
|---|---|
| `node --test rotom/evals/test/eval-regression.test.mjs`（冻结、存储、逃逸、篡改、索引） | 5/5 通过 |
| `node --test rotom/evals/test/eval-regression-run.test.mjs`（对照矩阵、退出码、报告、计划门、suggest、add） | 7/7 通过 |
| `node --test rotom/evals/test/eval-regression-e2e.test.mjs`（真实 CLI + 真实 runtime + faux） | 1/1 通过（约 5.2s）：`prepare` 冻结 1 点，干净臂 `stable-pass` 退出 0，仍失败臂 `still-failing` 退出 1，原回复对照 `fail`，哨兵文件不存在，报告 0600 |
| 相关既有套件 `replay.test.mjs` / `replay-judge.test.mjs` / `eval-api.test.mjs` / `dashboard.test.mjs` | 42/42 通过 |
| `node rotom/extensions/observability/eval-launcher-check.mjs --faux` | `passed: true`（真实 launcher、faux、1 次调用） |
| `cd rotom/evals && npm run typecheck` | 通过 |
| `sh -n rotom/bin/rotom-launcher`；`./rotom/bin/rotom eval-regression help` | 语法通过；输出用法并退出 0 |
| 变异检查（早前实现阶段） | 把 `regression`/`still-failing` 标签互换、去掉 `--yes` 门，测试均失败 |

自查修正：非 JSON 输出把报告路径写成未定义变量（`reportPath`），只在人读输出路径上出现；已修，并补了「人读输出必须包含报告路径与逐点结论」的断言。

## 未验证 / 已知限制

- **L3 未跑**：未读取真实私有会话，未调用真实模型，未产生真实回归结论。第一次真实运行需要用户授权，并会消耗所选模型的调用。
- **面板未接建议**：`suggest` 只有命令行；评测页的「回放点」仍按原流程人工填写。
- **安装态无运行器**：安装包执行「运行回放」会得到明确错误，属预期限制，不是回归。
- **共享状态**：`run` 与面板共享 `~/.rotom/evals`，面板里同时运行回放时未见并发保护；本轮未改这块，未验证两者并发的行为。

## 文件

新增：`rotom/evals/scripts/regression-set.mjs`、`rotom/evals/scripts/eval-regression.mjs`、`rotom/evals/bin/eval-regression`、`rotom/evals/test/{eval-regression,eval-regression-run,eval-regression-e2e}.test.mjs`、`rotom/evals/test/regression-helpers.mjs`；修改：`rotom/bin/rotom-launcher`、`rotom/evals/package.json`、`rotom/evals/scripts/session-replay.mjs`、`rotom/extensions/observability/eval/replay-service.mjs`、`rotom/extensions/observability/replay.test.mjs`、`.github/workflows/evals-l1.yml`、任务文档与 README。

# 22 失败集接入本机一键回归：实现报告

状态：`in-review`。L1 与 L2 已跑；真实私有会话与真实模型（L3）未运行，需要单独授权。

## 做了什么

把已复核的回放点冻结成一份可复用的失败集，再用一条命令对比「改动前产品 / 改动后产品 / 原始回复」。

| 能力 | 位置 | 行为 |
|---|---|---|
| 集合与存储 | `rotom/evals/scripts/regression-set.mjs` | 选择器（`all`/`fail`/`failSet`/显式点列表）、冻结集合与 SHA-256 摘要、内容身份、会话索引 |
| 对照与报告 | `rotom/evals/scripts/regression-compare.mjs` | `compareArms`（含覆盖与判定版本核对）、退出码、usage 汇总、批次报告 |
| 建议 | `rotom/evals/scripts/regression-suggest.mjs` | 缺点会话的截断点证据与私有草稿；已有回放点的会话单独计数 |
| 命令 | `rotom/evals/scripts/eval-regression.mjs` | `prepare` / `run` / `suggest` / `add` / `help` |
| 进程边界 | `rotom/evals/scripts/regression-runner.mjs` | 计划摘要（含两臂与扩展内容身份）与运行器 spawn |
| 入口 | `rotom/evals/bin/eval-regression`、`rotom/evals/package.json`、`rotom/bin/rotom-launcher` | `rotom eval-regression …`（仅仓库 checkout，见下） |
| 运行器报告字段 | `rotom/evals/scripts/session-replay.mjs` | 每行补 `judgePromptVersion`；新增 `--frozen=<文件>`，按冻结载荷执行而不回读回放库 |
| 共用测量 | `rotom/extensions/observability/eval/replay-plan.mjs` | 分开报告生成次数、模型判定次数、本地规则判定次数与判定输入字符量，不再把「行数」当「调用数」 |
| 共用守卫 | `rotom/extensions/observability/eval/session-data.mjs` | 新增 `assertOutsideGitWorktree`，供回归命令拒绝 Git 工作区内的私有目录 |
| 面板诚实失败 | `rotom/extensions/observability/eval/replay-service.mjs` | 运行器缺失时返回 `replay_runner_unavailable`（503），不 spawn 必然失败的子进程 |

关键词句（Astra 复核后修正）：

- **冻结点就是运行输入。** 集合记录会话 SHA-256、assistant 锚点、期望、判定方式与冻结时的判定提示词版本。`run` 把冻结点写成 0600 临时载荷交运行器执行，运行器不再回读可变回放库；冻结后被编辑的点不会改变已确认计划的含义。
- **不能保证完整就不开始。** 集合含被排除点、会话索引不完整或判定提示词版本已变时，`run` 直接拒绝，不再「警告后照跑」。
- `run` 必须显式给出 baseline 与 candidate。少一个就退出 2，不降级成单臂「成功」。
- **计划数字与实际支出一致。** 生成次数、模型判定次数、本地规则判定次数分开打印；模型判定输入字符量与生成上下文分开报。
- **授权绑定内容，而不是路径。** 计划摘要包含两臂与 `--extension` 的逐文件内容身份（排除 `node_modules` 与 `evals/`；Pi fork 由 `runtime/pi` 的 lock/fork-build 版本与 integrity 固定）。同一路径下改文件会让已确认的计划失效，spawn 前会再算一次比对。
- 结论分七类：`regression`、`improved`、`still-failing`、`stable-pass`、`judge-blind`、`inconclusive`、`incomplete`。重复结论不一致、unknown 一律 `inconclusive`；缺行、行数多于确认次数、非法判定值、判定提示词缺失记为 `incomplete`。覆盖按确认的重复次数逐臂核对。
- 退出码：`0` 全部 held/improved；`1` 存在确定失败；`2` 无法判断、集合为空或被排除过点。
- `suggest` 只写私有草稿（`replay/suggestions/`），限额只用于确实缺点的会话，已有回放点的会话单独计数，不会再挤掉后面的缺口。`add … --yes` 只新增，遇到已存在的点直接拒绝，不覆盖已复核内容。
- 集合、报告、草稿都是私有目录 0700 / 文件 0600，拒绝 symlink、路径逃逸、摘要不符的篡改，以及位于 Git 工作区内的私有目录。
- usage 按 `usageOf` 的真实形状汇总（input/output/cacheRead/cacheWrite 可为 null，`costUsd` 只在正值时计入），缺失或未计价时标 `partial`，不把 unknown 折成 0。
- 运行器崩溃也留报告：`failure` 字段与 `runner_<code>` 警告，结论为 incomplete，退出 2；每个点保留各臂判定序列、判定版本与有限的运行记录文件名。

## 与任务文档的偏差（已同步进文档）

1. **命令是 checkout-only，不是产品功能。** `rotom/scripts/pack-release.mjs` 的 `releaseFiles` 明确拒绝任何 `evals` 路径，发行包没有 `evals/`，回放运行器只能从仓库运行。因此 launcher 只在 checkout 中路由该命令；安装态评测页对「运行回放」明确失败。没有为此放宽发行清单，也没有改写安装包。
2. **L2 用真实 CLI + 真实产品 runtime + faux provider。** 原文档写的「实际安装产物 + faux」不成立（安装产物不含运行器）。现 L2 在临时目录、合成会话上跑完整 `prepare → 计划 → run → 报告`，两臂都加载真实 runtime。
3. **新增 `--extension` / `--thinking` 透传。** `--extension` 让离线检查注入 faux provider，也是排查 provider 差异的最小手段；两者都进计划摘要。

## 验证

| 检查 | 结果 |
|---|---|
| `node --test rotom/evals/test/eval-regression.test.mjs`（选择器、冻结、存储、逃逸、篡改、索引、内容身份） | 7/7 通过 |
| `node --test rotom/evals/test/eval-regression-run.test.mjs`（对照矩阵、覆盖、退出码、报告、计划门、内容身份、工作区拒绝、suggest、add） | 9/9 通过 |
| `node --test rotom/evals/test/eval-regression-guards.test.mjs`（相对路径工作区、`ROTOM_PI` 覆盖、冻结时索引截断） | 3/3 通过；去掉 `resolve()` 的负向对照确认相对路径用例会失败 |
| `node --test rotom/evals/test/eval-regression*.test.mjs` | 20/20 通过 |
| `node --test rotom/evals/test/eval-regression-e2e.test.mjs`（真实 CLI + 真实 runtime + faux） | 1/1 通过（约 7.6s）：`prepare` 冻结 1 点后**删除回放库里的该点**，运行仍执行冻结内容；干净臂 `stable-pass` 退出 0，仍失败臂 `still-failing` 退出 1，原回复对照 `fail`，哨兵文件不存在，报告 0600，冻结载荷已删除 |
| 全部相关 `node --test` 套件（含 `replay-e2e`、dashboard、judge） | 78/78 通过 |
| 相关既有套件 `replay.test.mjs` / `replay-judge.test.mjs` / `judge.test.mjs` / `eval-api.test.mjs` / `dashboard.test.mjs` / `replay-e2e.test.mjs` | 46/46 通过 |
| `cd rotom/evals && ./bin/typecheck` | 退出 0 |
| `node rotom/extensions/observability/eval-launcher-check.mjs --faux` | `passed: true` |
| `sh -n rotom/bin/rotom-launcher`；`./rotom/bin/rotom eval-regression help` | 语法通过；输出用法并退出 0 |
| 变异检查（早前实现阶段） | 把 `regression`/`still-failing` 标签互换、去掉 `--yes` 门，测试均失败 |

自查修正：非 JSON 输出把报告路径写成未定义变量（`reportPath`），只在人读输出路径上出现；已修，并补了「人读输出必须包含报告路径与逐点结论」的断言。

## Astra 复核后修正的问题

| 复核意见 | 处理 |
|---|---|
| 运行器回读可变回放库，冻结点会变活点 | 新增 `--frozen`，CLI 用 0600 临时载荷传冻结点；e2e 删掉库里该点后仍按冻结内容运行 |
| 计划摘要只哈希路径，同路径改产品仍有效 | 计划摘要改绑两臂与扩展的逐文件内容身份，spawn 前重算比对；测试断言同路径改文件后拒绝 |
| 「调用次数」按行数算，模型点少算判定 | 共用测量分开报生成／模型判定／本地规则判定与判定字符量，CLI 打印三者 |
| 汇总不验证覆盖，可能以 1 行当 3 次通过 | 按确认重复次数逐臂核对行数、判定值与判定版本，缺失记 `incomplete` 并退出 2 |
| 含被排除点、索引截断、判定版本漂移仍照跑 | 三种情况均拒绝启动 |
| 索引 1 MiB 上限误伤大会话；第三个重复 id 又变可解析 | 改用产品既有会话容量上限做 header 读取；歧义 id 永久标记 |
| 私有目录可落在 Git 工作区 | 抽出 `assertOutsideGitWorktree` 并在命令入口拒绝 |
| usage 形状不符，unknown 折成 0 | 按 `usageOf` 真实字段汇总，未计价标 `partial` |
| 崩溃时不产出报告；报告丢失证据 | 崩溃也写 incomplete 报告；每点保留各臂判定序列、判定版本与运行记录文件名 |
| `add` 会覆盖已复核点 | 改为只新增，测试断言原期望与判定方式不变 |
| 已有回放点占满建议限额 | 限额只作用于缺点的会话，已有回放点的单独计数 |
| 重复实现 clamp、私有目录helper、未用参数 | 统一用 `clampRepeats` 与 `ensurePrivateFolder`，删除未用参数与解构 |

## 第二轮 Astra 复核后修正

| 复核意见 | 处理 |
|---|---|
| 相对私有路径仍可落在 Git 工作区 | `assertOutsideGitWorktree` 先 `resolve()` 再向上查找；新增「在 checkout 子目录里用相对路径」用例，并做去掉 `resolve()` 会失败的负向对照 |
| 计划摘要没绑定 `ROTOM_PI` 与扩展的导入依赖 | 设置 `ROTOM_PI` 时 `run` 直接拒绝（运行时未被摘要绑定）；扩展身份在计划里明说「仅覆盖入口文件」，不假装覆盖依赖 |
| 覆盖只数行数，重复编号可伪造；判定方式可被改写 | 按不同 `repetition` 编号核对 1..N，且校验每行的 `checkMode`／`rule` 与冻结点一致 |
| 模型点缺判定版本时算 inconclusive | 改为 incomplete：无法证明确认过的判定发生过 |
| 冻结时索引截断的集合仍可开跑 | `run` 先核对 `set.scan`，不依赖当前索引 |
| 冻结载荷文件名固定，并发或取消会互相删除 | 文件名加随机后缀；`finally` 清理，信号中断的残留作为已知限制 |
| 报告丢掉新算出的内容身份与记录引用 | 报告写入 `planDigest`、两臂与扩展身份；运行器输出补 `rule` 与记录 `path`，报告按点保留记录文件名 |
| `usageOf(null)` 被当成 known，模型判定花费漏计 | 只有真实数值才算 known；模型点一律标 `usage.partial` 并在报告里说明生成行不含判定 usage |
| 生成/判定字符标签与实际口径不符 | 生成只报生成上下文；判定报「判定上下文与期望」，并注明不含生成回复与提示词框架 |
| 准备与执行会话体积上限不一致 | 统一用 `REPLAY_SESSION_MAX_BYTES` |
| 身份上限在单文件与 symlink 分支被绕过 | 两个分支同样检查文件数与字节上限 |

## 大会话读取修正

回放与通用会话读取器现在共用 `MAX_SESSION_FILE_BYTES`（256 MiB），不再单独限制到 128 MiB。索引、prepare 和 runner 沿用同一常量；来源 SHA-256 校验不变，追加内容也不会自动更新已复核摘要。

新增合成边界测试：129 MiB JSONL 在索引、prepare 读取器与 runner 读取器中均可读取；256 MiB + 1 字节仍拒绝。相关回归套件 46/46 通过。文件仍整体读入内存；超过 256 MiB 时应改用流式解析和哈希，不继续提高上限。

## 未验证 / 已知限制

- **L3 未跑**：未读取真实私有会话，未调用真实模型，未产生真实回归结论。第一次真实运行需要用户授权，并会消耗所选模型的调用。
- **面板未接建议**：`suggest` 只有命令行；评测页的「回放点」仍按原流程人工填写。
- **安装态无运行器**：安装包执行「运行回放」会得到明确错误，属预期限制，不是回归。
- **不是执行快照**：内容身份是校验而不是快照，运行期间产品文件仍可能变化；计划里已写明，未做运行期漂移检测。
- **扩展身份只覆盖入口文件**：`--extension` 指向单文件时，其导入的同级模块不进入摘要；计划里已明说。
- **判定花费记不全**：生成行只记录生成 usage，模型判定的 usage 只在原回复对照行，报告因此把模型点标为 `usage.partial`；这是运行器既有记录方式，本轮未改。
- **信号中断**：父进程被 SIGINT/SIGTERM 打断时可能残留私有冻结载荷（0600、随机名、位于私有目录）且不留报告；SIGKILL 无法保证清理。本轮未实现信号处理。
- **内容身份边界**：身份哈希排除 `node_modules`，因此「已安装的 Pi fork 解压文件被就地改动」不会被发现；这与产品启动期只验证 package identity/capability 的既有边界一致，计划里会明说，未额外验证。
- **重复的 Git 守卫**：`session-cards.mjs` 里原有的 `rejectGit` 未合并进新 helper（该文件已超过单文件提交体积上限，改动会连带触发拆分）；新代码用 `session-data.mjs` 的 `assertOutsideGitWorktree`，两处逻辑相同。要合并需先把 `session-cards.mjs` 按职责拆分，留作后续。
- **共享状态**：`run` 与面板共享 `~/.rotom/evals`，面板里同时运行回放时未见并发保护；本轮未改这块，未验证两者并发的行为。

## 文件

新增：`rotom/evals/scripts/regression-set.mjs`、`rotom/evals/scripts/regression-compare.mjs`、`rotom/evals/scripts/regression-suggest.mjs`、`rotom/evals/scripts/regression-runner.mjs`、`rotom/evals/scripts/eval-regression.mjs`、`rotom/evals/bin/eval-regression`、`rotom/evals/test/{eval-regression,eval-regression-run,eval-regression-e2e}.test.mjs`、`rotom/evals/test/regression-helpers.mjs`；修改：`rotom/bin/rotom-launcher`、`rotom/evals/package.json`、`rotom/evals/scripts/session-replay.mjs`、`rotom/extensions/observability/eval/replay-service.mjs`、`rotom/extensions/observability/replay.test.mjs`、`rotom/extensions/observability/eval/{replay-plan,session-data}.mjs`、`.github/workflows/evals-l1.yml`、任务文档与 README。

# 在维护者的 Mac 上验证 P0、P0b、P2、P3、P4、P5

按 `TASK-5.md` 第 0–6 节执行。日期 2026-11-08（UTC）。只记录事实，没有改动代码。

## 1. 环境

| 项 | 值 |
|---|---|
| macOS | 27.3（26C5035r） |
| Node | v24.18.0 |
| npm | 12.2.0 |
| 被验证分支 HEAD | `3d50ecd6b0b70a6b6676360dd9b1ef65f209f2af` |
| 对照组 `main` HEAD | `5649b3dbf676442550b7a302469aa3b986ee85db` |

独立 clone 为 `$TMPDIR/rotom-verify`，对照组 `main` 另建 clone。全程没有触碰正在使用的安装、会话目录、trace，也没有停止或重启运行中的 Computer Use helper；没有对外部服务发请求。

`git log --oneline -9` 核对了 TASK-5 列出的 6 个 commit，全部在场：

| commit | 标题（截断） |
|---|---|
| `e4c0e1f` | feat(qoder): retry catalog refresh … |
| `c97a45a` | feat(computer-use): ask once … |
| `81f0987` | feat(subagents): report run progress … |
| `d70bcd0` | feat(coding-policy): report progress … |
| `00ce5a6` | fix(pi): record model_change only when … |
| `75da4c7` | feat(session-review): separate retry-absorbed … |

## 2. Pi fork 可重现性

| 检查 | 结果 |
|---|---|
| `npm run check:pi` 退出码 | `0` |
| `npm run build:pi` | 成功，`Pi fork ready: 1.4.0-rotom.2` |
| 构建后 `git status --short` | 空 |
| 构建后 `git diff --stat` | 空 |

`build:pi` 内部各包回归（Vitest）全部通过，没有任何失败用例：

| 包 | 测试文件 | 通过 / 跳过 / 失败 |
|---|---|---|
| ai | 8 | 189 / 1 / 0 |
| ai | 5 | 68 / 0 / 0 |
| agent | 1 | 42 / 0 / 0 |
| codemode | 1 | 156 / 0 / 0 |
| coding-agent | 7 | 95 / 0 / 0 |
| ai | 5 | 81 / 0 / 0 |
| coding-agent | 30 | 433 / 2 / 0 |
| coding-agent | 3 | 10 / 0 / 0 |
| **合计** | 60 | **1074 / 3 / 0** |

构建脚本输出的 `sourceSha256` 与 `rotom/runtime/pi/fork-build.json` 记录的值相同。

**结论：Mac 上从源码重建的结果与提交版本逐字节一致。** 7 个 vendor 归档、`rotom/runtime/pi/package-lock.json` 和 `fork-build.json` 都没有差异，因此没有出现云端那条“lock 结构不同”的情况，也没有需要列出的包条目增删或 integrity 差异。工作区本来就没变脏，不需要执行第 2 节的恢复步骤。

## 3. 测试结果

`npm ci` 全部成功：`rotom/runtime/pi`（120 包）、`rotom/extensions/third-party`（14 包）、`packages/rotom-subagents`（139 包）、`packages/rotom-pi`（332 包）。

| 检查 | 本分支 | 云端 | `main` 对照 | 判断 |
|---|---|---|---|---|
| 运行时合同 | 40 / 40 通过，0 失败 | 40/40 | 未跑（本分支通过） | 一致 |
| 发行包 | 28 / 28 通过，0 失败 | 28/28 | 未跑 | 一致 |
| Pi 构建器 | 2 / 2 通过，0 失败 | 2/2 | 未跑 | 一致 |
| Qoder | 270 / 270 通过，0 失败 | 270/270 | 未跑 | 一致 |
| coding-policy | 10 / 10 通过，0 失败 | 10/10 | 未跑 | 一致 |
| observability | 51 / 51 通过，0 失败 | 51/51 | 未跑 | 一致 |
| Computer Use | 76 个测试，75 通过，**1 失败**（`cu-v2-tools.test.ts`） | 74/76，同一文件失败 | 72 个测试，71 通过，同一文件失败 | **改动前就有** |
| subagents wait | 21 / 21 通过，0 失败 | 21/21 | 未跑 | 一致 |
| Pi model_change | 两个文件 32 / 32 通过 | 新测试通过；`model-selector` 一个用例失败 | 未跑 | 云端失败未在 Mac 复现 |

失败项详情：`cu-v2-tools.test.ts` 在整串运行时以 `ERR_MODULE_NOT_FOUND` 失败，单独运行同一文件可以复现。缺失的模块是该包源码直接 import 的一个上游 Pi package，而该包目录下没有安装依赖（它的 `package.json` 里也没有声明这个依赖），单独运行该测试文件时无法从祖先目录解析到它。`main` 上失败在同一行、同一错误，测试总数少 4 个（少的是本分支 P2 新增的 helper 协议用例）。因此这是本来就有的环境/依赖解析问题，不是本次改动引入。按要求没有去改代码或补依赖来“修绿”。

复现步骤：在 `packages/rotom-computer-use` 下执行 `node --test --experimental-strip-types test/cu-v2-tools.test.ts`；本分支与 `main` 都报同一个模块解析错误。

## 4. 启动 smoke

`smoke-runtime.mjs` 在四种组合下都退出码 1，都是同一个断言失败（工具面与声明不一致）：

| clone | 工具面 | actual / expected | 缺少的工具 |
|---|---|---|---|
| 本分支 | 默认 | 26 / 31 | `clipboard`、`cu_session`、`manage_app`、`manage_window`、`system_surface` |
| 本分支 | 全量（`ROTOM_DEFERRED_TOOLS=0`） | 25 / 30 | 同上 5 个 |
| `main` | 默认 | 26 / 31 | 同上 5 个 |
| `main` | 全量 | 25 / 30 | 同上 5 个 |

**结论：失败信息与云端一致，本分支与 `main` 的差异完全一致。** 两个 clone 的集合大小和缺失项完全相同，说明 vendor 里的 Computer Use 归档仍是旧版（P2 尚未重打归档），这不是本次改动引入的。

## 5. 行为抽查

### 5.1 P0 / P0b 错误分类

输出 `true true true false false`，与预期一致。这次读取的是 `npm ci` 安装后的构建产物（`pi-ai` 的 `retry` 实现），因此可以确认分类改动确实进入了 vendor 归档和安装结果，不只是工作区源码里的字符串。

### 5.2 P4 提示词

`grep -n "in the same response as your next tool call" rotom/extensions/coding-policy/index.ts` 恰好命中 1 行（第 26 行），唯一。

### 5.3 P5b 复盘脚本

统计范围：7 天窗口，`--now 2026-11-07T05:00:00Z`；扫描了 1526 个会话文件、760 个 trace 文件，命中 201 个会话。

`fleet.assistantErrorOutcomes`：

| 类别 | `absorbedByRetry` | `endedRun` |
|---|---|---|
| connection | 221 | 4 |
| fetch_failed | 63 | 20 |
| rate_limit | 39 | 13 |
| bad_request | 0 | 11 |
| auth | 0 | 5 |
| timeout | 12 | 3 |
| overloaded | 13 | 1 |
| stream_terminated | 12 | 1 |
| other | 36 | 30 |
| **合计** | **396** | **88** |

两者合计 484，与脚本自己的 `stopReasons.error` = 484 一致，说明每条 error 都被分进了且只进了一个桶。

与任务书给的 477 / 57 对照：

- **合计 484 对 477，多 7。** 原因是脚本的窗口只有下界没有上界：`--now` 只决定 `since = now - 7 天`，条目只要时间戳不早于 `since` 就会被计入，晚于 `--now` 的条目同样计入。本轮实际运行时间比 `--now` 晚约 24 小时，这 24 小时里的活动也算进来了。
- **`endedRun` 88 对 57，多 31。** 这不是同类计数：`endedRun` 除“错误之后紧跟用户消息”外，还把“错误就是窗口或会话的最后一条记录”算进去；另外它也统计子 agent 会话。

为了验证上面两点，我做了一次本地交叉核对（脚本放在 `$TMPDIR`，不提交，也不改仓库脚本）：用同一份会话数据、同一 `since`，只额外给窗口加上界。先不加任何上界时，核对脚本复现了官方输出的 484 / 396 / 88，说明口径一致，可以信任它的有界结果：

| 口径 | 错误尝试 | `absorbedByRetry` | `endedRun` | 其中“错误后紧跟用户消息” | 其中“错误是窗口最后一条” |
|---|---|---|---|---|---|
| 官方脚本（只有下界） | 484 | 396 | 88 | 62 | 26 |
| 加上界 `2026-11-07T05:00:00Z` | **477** | 391 | 86 | 60 | 26 |
| 加上界并排除子 agent 会话 | 443 | 362 | 81 | 55 | 26 |

即：把窗口固定到与 `stop-context.json` 的 `generatedAt` 同一时刻后，错误尝试数正好回到第一轮的 **477**；而第三轮/第四轮的 57 只统计“紧接用户消息”这一类，并且排除子 agent 会话（本口径为 55；按两个脚本的代码看，剩余几条差异来自对 fork 复制条目和窗口起点处助手消息的处理方式不同，未逐条核对）。

## 6. 发现的问题

### 6.1 `extract-session-metrics.mjs` 的时间窗口只有下界

- 现象：`--now` 被理解成窗口终点，但实现里它只用来算 `since`。同一份会话数据在不同时刻运行，报出的错误尝试总数不同（本轮 484，窗口截到生成时刻是 477），第二轮的数字无法再直接对照。
- 复现：用同一个 `--now` 在两个不同的实际时刻跑脚本，比较 `fleet.stopReasons.error`；或在窗口过滤处加 `<= now` 的上界再看同一组数字。
- 影响：只影响复盘脚本的口径，不影响产品行为。

### 6.2 `endedRun` 与第三/第四轮的“error 停点”不是同一个口径

- 现象：TASK-5 期望 `endedRun` 合计接近 57，实测 88（有界 86）。差值是 26 条“错误是窗口内最后一条记录”加上子 agent 会话里的若干条；另外 60–62 条“错误后紧跟用户消息”里，与 `stop-context.mjs` 的口径仍差几条（它排除子 agent 会话，且对 fork 复制条目的处理不同）。
- 复现：`node experiments/session-review-20261107/extract-session-metrics.mjs --days 7 --now 2026-11-07T05:00:00Z --out <临时文件>`，读 `fleet.assistantErrorOutcomes`；与 `results/stop-context.json` 里 `byKind.*.prevStop.error` 的合计（34 + 1 + 22 = 57）比较。
- 判断：实现符合 REPORT 第 5 节为 P5b 写的定义（“错误就是这一轮的最后一条回复”），字段本身也自洽（两个桶合计等于 error 尝试数）。不符合的是 TASK-5 里“应接近 57”的预期，因为 57 是按另一套口径数出来的。是否要统一口径属于设计决定，本轮没有改代码。

## 7. 没能验证的内容

- **P2（Computer Use 询问一次再重启）在真实 Mac 上的行为。** helper 协议单测在分支上通过，但“检测到不匹配 → 询问 → 重启 → 复检”的端到端流程没有在真机跑过：本轮不允许重启正在运行的 helper，且该改动尚未进入 vendor 归档。
- **P2 与 P3 尚未进入产品。** smoke 里 Computer Use 的工具面仍是旧版，`subagent_wait` 的超时补充信息只在单测层面被覆盖。
- **P0 / P0b 的实际重试效果。** 只验证了分类函数对 5 个错误码的判定，没有发真实 provider 请求，因此“重试是否真的救回失败”没有端到端证据。
- **P4 的效果。** 只验证了提示词存在且唯一；进度说明是否减少“停太早”，需要后续用 `stop-context.mjs` 复测。
- **P5a 在真实会话里的表现。** 只跑了两个单测文件（32/32）；云端失败的 `model-selector` 用例在 Mac 上通过，但没有进一步确认是环境差异还是偶发。
- **`pack:release`、真实安装与升级路径。** 本轮按边界没有执行。
- **`main` 对照的覆盖范围。** 只对失败项和 smoke 跑了 `main`，其余 7 项通过项没有在 `main` 上重复运行。
- **平台范围。** 只在 macOS 上验证，未覆盖 Linux 与 Windows 分支。

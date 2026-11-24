# 评测运营方案（2026-11-24）

本文是方案，不是已完成的改动记录。它不替换 [Agent 优化循环](optimization-loop.md) 的准入与判定规则，只回答两件事：**怎样让这套循环每周都真的在转**，以及**缺哪几块才转得起来**。标 **[今]** 的命令在起草时就能跑，标 **[建]** 的是起草时尚未存在的部分。

**状态（2026-11-24）**：§7 的四项已由用户决定（启用 GitHub Actions；按建议恢复保持集；不设额外花费上限；每周四），§5 的 N1–N4 已于同日实现，现行用法见 [循环运营合同](loop-ops.md)。下文保留起草时的原文，其中的 **[建]** 均已完成；尚未做的是需要模型与本机会话的部分，见 §6 第 2 周之后各行。

对照材料：LangChain 的 [eval-driven development](https://www.langchain.com/blog/what-is-eval-driven-development)（先写会失败的 eval、逐例对比、留出集、CI 与线上回流）。

## 1. 现状：方法够严，卡在供给和运营

数字来自 2026-11-24 的 `loop ledger`、`loop/gate.json` 与 [11 月本机结果](optimization-results-2026-11.md)。

| 事实 | 数字 | 含义 |
|---|---|---|
| 账本条目 | 88 条，12 条 `improved`（机制 11、提示 1） | 能测出改善的几乎都是机制 |
| 已 `shipped` 但 `unmeasured` 的机制条目 | 16 条 | 上线了，没人回头验收 |
| gate 用例 | 3 个：1 个 `reproduced` 角色、2 个 control；另有 2 条本机私有回放 | 门禁太薄 |
| 那 1 个 `reproduced` 用例在授权模型上的记录 | `qoder/dfmodel` 为 `flaky-candidate`，`gpt-6.1-sol` 为 `not-reproduced` | **当前没有一个用例在授权模型上有已证实的区分度** |
| 独立套件 | `cases/` 下 17 个，各有自己的开关环境变量 | 跑哪个、怎么开，靠记忆和文档 |
| CI | 仓库没有 `.github/workflows` | 离线测试只在有人想起来时跑 |
| 运行环境 | 会话、trace、模型登录都只在维护者 Mac 上 | 云端会话只能做不调模型的部分 |

三个瓶颈，按影响排序：

1. **用例供给。** 准入规则（真实失败、baseline 失败率 30%–70%）是对的，但从 9 月至今只留下 1 个爬坡用例。gate 判 `held` 时，多半只是说明它没有东西可测。
2. **运营成本。** 跑一次 gate 要手工建 worktree、装两处依赖、记绝对路径和环境变量；结果分散在 `~/.rotom/loop/` 的时间戳目录和十几份结果文档里。成本高，所以跑得少。
3. **没有闭环节奏。** weekly 只报观察数据；没有一处能一眼看到"用例集多大、上次什么时候跑的、哪些条目该验收了"。

## 2. 目标与四个运营数字

目标不变：真实使用中越来越少需要人介入。运营只盯四个数字，全部由 `loop status` **[建]** 一屏打印：

| 数字 | 现值 | 来源 | 用途 |
|---|---|---|---|
| 介入率（每 100 用户轮） | 10.6（2026-11-10，714 会话） | `loop weekly` | 北极星，只看趋势 |
| 有区分度的爬坡用例数 | 0（另有 1 个 flaky） | `gate.json` + gate 历史 | 供给是否跟上；先做到 3 |
| 已上线未验收的机制条目数 | 16 | 账本 | 只增不减说明验收没在做 |
| 距上次 gate / weekly 的天数 | 未记录 | gate 历史、weekly 目录 | 节奏有没有断 |

后三个是过程指标，不能当质量结论引用。

## 3. 用例集：三类，一份清单

继续只用 `rotom/evals/loop/gate.json` 一份清单，不新增清单文件。

| 类别 | 清单里的写法 | 入集条件 | 作用 | 现有 |
|---|---|---|---|---|
| **爬坡集** | `role: "reproduced"` | 现行规则不变：oracle → baseline 复现 → 区分度 30%–70% | 证明一次修复有效 | 1（flaky） |
| **保持集** | `role: "control"` | oracle 通过，且 baseline 稳定通过（≥5/5） | 证明修复没有弄坏别的 | 2 |
| **留出集** | 任一角色加 `split: "holdout"` **[建]** | 爬坡用例的"另一种问法"：换措辞、换语言、换 fixture 名字，机制相同 | 证明修复不是只对原题有效 | 0 |

三点说明：

- **保持集用现成库存扩充。** `behavior-export-symptom` 与 `behavior-scoped-read` 已有 oracle，在 dfmodel 上 baseline 5/5，按现行规则"不进场"。它们测不出改善，但正好能当保持集：将来失败就是回归。这与 2026-11-09 删除"基线从未失败的 suite"的决定方向相反，所以列入 §7 由用户决定；范围只限已存在且 oracle 完整的用例，不重建已删除的 suite。
- **留出集手写，不做工具。** 每个爬坡用例写 1 个变体就够。调修复时不跑、不看；只在判定那一轮跑。爬坡集通过而留出集不动，按"过拟合"记入账本，不算 `improved`。
- **保持集控制成本。** 日常每例只跑 1 次，发版前按清单重复数跑。保持集超过 10 个时先删最久没失败过的。

## 4. 节奏：四档，每档一条命令

| 档 | 何时 | 命令 | 调模型 | 在哪跑 | 耗时 |
|---|---|---|---|---|---|
| **A 提交** | 每次 push / PR | `npm --prefix rotom/evals test`、`npm --prefix rotom/evals run typecheck`、`npm --prefix rotom/evals run loop -- ledger` **[今]**；由 CI 自动跑 **[建]** | 否 | GitHub Actions | 测试约 2 分钟（见 §8） |
| **B 行为改动** | 改 coding-policy、工具描述/行为、续跑、压缩、Subagent 默认策略 | `loop gate --smoke` → `loop gate` **[今]**；判定轮加 `--holdout` **[建]** | 是 | Mac | 一轮约 7 分钟（2026-11-10 三轮实测间隔） |
| **C 每周** | 固定一天，限时 30 分钟 | `loop weekly` → `loop replay-gate --current-only` **[今]** → `loop status` **[建]** → 分诊 harvest 队列前 5 条 | 仅 replay-gate | Mac | 30 分钟 |
| **D 发版** | 每次 npm 发布前 | 全量 `loop gate`（爬坡 + 保持 + 留出，按清单重复数）+ 当周介入率记入发布记录 | 是 | Mac | 约 30 分钟 |

B 档今天的完整写法（`loop freeze` 做完后，前三行合成一条）：

```sh
git worktree add /absolute/rotom-frozen <上一个发行 commit>
npm --prefix /absolute/rotom-frozen/rotom/runtime/pi ci --ignore-scripts
npm --prefix /absolute/rotom-frozen/rotom/extensions/third-party ci --ignore-scripts --omit=optional --legacy-peer-deps
npm --prefix rotom/evals run loop -- gate --baseline /absolute/rotom-frozen/rotom --smoke
npm --prefix rotom/evals run loop -- gate --baseline /absolute/rotom-frozen/rotom
```

### 每周 30 分钟怎么花

1. 看 `loop status` 的四个数字（2 分钟）。
2. 读 weekly 报告里到期的验收条目：到量的按报告结论改账本，没到量的不动（5 分钟）。
3. 分诊 harvest 队列前 5 条，每条只归一类：可做回放用例 / conformance / 评测自身问题 / 外部因素（15 分钟）。
4. 有"可做回放用例"的，登记一条 `open` 账本条目作为下周的唯一任务；没有就结束（5 分钟）。

**每周最多开一个用例，暴露期内最多做一个修复。** 连续 3 周没有新的可复现失败、介入率也没变差时，循环处于空闲是正常状态，不找事做。

### 一次修复的固定顺序

沿用循环 ③④，只加两步（加粗）：

1. harvest 事件 → 脱敏用例 → oracle（两种正确答案通过、已观察到的错误被拒）。
2. baseline 复现（预先声明重复数）。**同时写好留出变体，但不跑。**
3. 修复 → 同条件 candidate。
4. **判定轮：`loop gate --holdout`，爬坡、保持、留出三类一起看，逐例比较而不是只看通过率。**
5. 记账本；进入实际加载的 runtime 后才标 `shipped`；登记验收指标与暴露量。

## 5. 需要新建的四件事

按价值排序。都在 `rotom/evals/` 与仓库维护面内，不改产品运行时。

| # | 内容 | 规模 | 验收 |
|---|---|---|---|
| N1 | **CI 跑 A 档。** `.github/workflows/evals-offline.yml`：macOS runner、Node 24、三处 `npm ci --ignore-scripts`、离线测试、typecheck、`loop ledger`。不配置任何密钥，不调模型。用 macOS 是因为 `test/loop-replay-sandbox.test.ts` 依赖 `/usr/bin/sandbox-exec`，在 Linux 上有 3 个用例失败（§8）；若改用 Linux runner，要先给这 3 个用例加平台判断 | 约 30 行 YAML | 一次故意写坏的账本条目能让 CI 变红 |
| N2 | **`loop status`。** 读 `gate.json`、`gate-history.jsonl`、账本和最新的 weekly `summary.json`，打印 §2 的四个数字、每个用例最近一次结果与累计样本、到期验收条目、"下一步"一行。不调模型，不写 Git | 约 150 行 + 单测 | 用合成的历史与账本做单测；缺文件时打印"无记录"而不是 0 |
| N3 | **`loop freeze <ref>`。** 把 worktree、两处 `npm ci` 和现有 gate preflight 合成一步，落到 `~/.rotom/loop/frozen/<sha>/`；`gate --baseline` 省略时用最近一次 freeze，并在输出里打印所用 SHA | 约 120 行 + 单测 | 对同一 ref 重复执行不重装；preflight 不过时拒绝并说明要重装哪个目录 |
| N4 | **留出集。** `gate.json` 用例加可选 `split: "holdout"`；`gate` 默认跳过，`--holdout` 时一起跑；`gate-pool` 分开报告 | 约 60 行 + 单测 | 默认运行的用例列表与现在逐字相同；留出结果不计入 `held`/`regressed` 的主判定，单列 |

不做的：线上 LLM judge、标注队列、trace 聚类平台、自动把失败转成用例。rotom 是单人本地产品，harvest + 人工分诊已经覆盖这一段；judge 多是确定性检查，现有 oracle 正反例与 `--smoke` 审计够用。每月从 gate 产物里抽 10 次运行人工复核判定，不一致就修 judge 并记 `harness-regression`，不为此建工具。

## 6. 落地顺序

| 阶段 | 做什么 | 在哪 | 完成标准 |
|---|---|---|---|
| 第 1 周 | N1、N2 | 云端会话即可，零模型费用 | CI 在 PR 上变绿；`loop status` 在本机打印出四个数字 |
| 第 2 周 | N3、N4；把 `export-symptom`、`scoped-read` 登记为保持集；给 `behavior-authorized-follow-through` 写留出变体 | 代码在云端；保持集的 baseline 重跑在 Mac（dfmodel，各 5 次） | `loop gate` 省略 `--baseline` 可跑；保持集 4 个、留出集 1 个 |
| 第 3–4 周 | 按 §4 的每周流程跑两次；从分诊里做出第一个新的爬坡候选 | Mac | 两份 weekly 报告；至少 1 个新用例走到 baseline 判定（复现与否都如实记账） |
| 月底 | 回看四个数字，决定是否继续 | — | 爬坡用例数、未验收条目数与月初相比有变化；没有变化就先查分诊环节，不加新机制 |

A 档在 Linux 上的实测结果见 [§8](#8-起草时的验证)。

## 7. 需要你决定

1. **是否启用 GitHub Actions（N1）。** 公开仓库会多出一个 workflow 和每次 push 的运行记录；不需要密钥，不调模型。
2. **是否恢复保持集（§3）。** 与 2026-11-09"删除基线从未失败的 suite"方向相反；本方案只复用两个已有用例，上限 10 个。
3. **保持集与留出集的模型花费。** 都在已有授权内（`qoder/dfmodel`、`openai-codex/gpt-6.1-sol`，脱敏 fixture 与产品提示），但每次 B 档会多跑几例；如要设上限请给数字。
4. **每周固定哪一天。** `loop status` 用它计算"节奏是否断了"。

## 8. 起草时的验证

2026-11-24，云端 Linux 容器，Node v24.22.3，提交 `666aac1`。容器里没有本机会话和模型登录，所以 B/C/D 档没有在这里跑，其命令与耗时引自 [11 月本机结果](optimization-results-2026-11.md)。

| 检查 | 命令 | 结果 |
|---|---|---|
| 三处依赖安装 | `npm ci --ignore-scripts`（`runtime/pi`、`extensions/third-party`、`evals`） | 通过，共 10 秒 |
| 类型检查 | `npm --prefix rotom/evals run typecheck` | 退出 0 |
| 账本校验 | `npm --prefix rotom/evals run loop -- ledger` | 88 条，12 条 `improved`，无报错 |
| 离线测试 | `npm --prefix rotom/evals test` | 45 个文件：418 通过、3 失败、1 跳过，106 秒 |

3 个失败都在 `test/loop-replay-sandbox.test.ts`，原因是 Linux 没有 `/usr/bin/sandbox-exec`，与本方案无关，未修。未验证：GitHub 的 macOS runner 上这套命令的实际结果与耗时（本机 2026-11-10 的记录是 343 通过、1 失败，404 秒，测试集此后有增加）。

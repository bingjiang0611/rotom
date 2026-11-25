# 循环运营合同

准入与判定规则见 [Agent 优化循环](optimization-loop.md)；本文只规定**什么时候跑什么**，以及运营用的三条命令。设计理由与起草时的数字见 [评测运营方案](eval-ops-plan-2026-11-24.md)。命令都从仓库根执行，`loop` 是 `npm --prefix rotom/evals run loop --` 的简写。

## 模型

循环只用 `qoder/dfmodel`（2026-11-25 用户决定不再使用 `openai-codex`）。`gate.json` 的每个用例都在 dfmodel 上跑，离线测试会拦下指定其他模型的用例；`loop status` 只按用例实际运行的模型统计“有区分度”。

## 四档节奏

| 档 | 何时 | 命令 | 调模型 | 在哪跑 |
|---|---|---|---|---|
| 提交 | 每次 push / PR | `.github/workflows/evals-offline.yml` 自动跑：`npm --prefix rotom/evals run typecheck`、`loop ledger`、`npm --prefix rotom/evals test` | 否 | GitHub Actions（macOS） |
| 行为改动 | 改 coding-policy、工具描述/行为、续跑、压缩、Subagent 默认策略 | `loop gate --smoke` → `loop gate`；判定那一轮加 `--holdout` | 是 | 维护者本机 |
| 每周 | **周四**，限时 30 分钟 | `loop weekly` → `loop replay-gate --current-only --product <日常版本>` → `loop status` → 分诊 harvest 队列前 5 条 | 仅 replay-gate | 维护者本机 |
| 发版 | 每次 npm 发布前 | `loop gate --holdout --repeats 3`，并把当周介入率记入发布记录 | 是 | 维护者本机 |

每周最多开一个新用例，暴露期内最多做一个修复。`loop status` 的 “Next” 没有待办时，循环空闲是正常状态，不找事做。每月从 gate 产物里抽 10 次运行人工复核 judge 判定；不一致就修 judge 并记 `harness-regression`。

## 用例集

都登记在 `rotom/evals/loop/gate.json`，`loop status` 按下表归类：

| 类别 | 写法 | 入集条件 | 判定 |
|---|---|---|---|
| 爬坡（climb） | `role: "reproduced"` | 优化循环 ③ 的准入顺序不变 | 决定 `held` / `regressed` |
| 保持（keep） | `role: "control"`，通常带 `"repeats": 1` | oracle 完整，且 baseline 稳定通过（≥5/5） | 同上；失败即回归 |
| 留出（holdout） | 加 `"split": "holdout"` 与 `"variantOf": "<被改写的用例>"` | 同一机制换措辞、语言和 fixture 名称；有离线 oracle | 只在 `--holdout` 时跑，结果单列，**不计入主判定**；读法是 candidate 对比 baseline：`generalizes`（candidate 失败更少）、`no-difference`、`worse`、`unknown`（配对不全） |

- 保持集上限 10 个；只复用已存在且 oracle 完整的用例，不重建 2026-11-09 删除的 suite（用户 2026-11-24 决定）。
- 留出用例在调修复期间不跑、不看：`gate` 默认跳过，整套件运行（不指定 `ROTOM_EVAL_CONTINUATION_CASE`）也跳过。爬坡用例通过而它的留出变体没有跟着通过，记为过拟合，不标 `improved`。
- 用例可带自己的 `repeats`；`--repeats N` 覆盖所有用例，`--smoke` 恒为一对。

## 多台机器

结果统一放在 Git 里：`rotom/evals/loop/results/`。每台机器各写自己的子目录，一次运行一个文件，互不冲突。

| 内容 | 位置 | 进 Git |
|---|---|---|
| 每次正式 gate 的逐用例计数、判定、模型、两侧提交与产品指纹 | `loop/results/gate/<机器>/<runId>.json`（`gate` 自动写） | 是 |
| 每次 weekly 的总体与按模型介入率、验收状态 | `loop/results/weekly/<机器>/<日期>.json`（`weekly` 自动写） | 是 |
| 会话、摘录、session id、harvest 事件队列、回放用例、gate 运行产物、冻结 worktree、本机路径、主机名 | `~/.rotom/loop/` | 否 |

- 每台机器先设一次标签：`loop machine mac1`。没有标签时正式 gate 拒绝运行（smoke 不受限）。
- 跑完 `gate` / `weekly` 后，把 `rotom/evals/loop/results/` 下新增的文件提交并推送；功能分支合入 `main` 后，所有机器拉取即可看到。
- `gate-pool` 默认合并所有机器的已提交记录，按**产品指纹**分组：指纹是 `rotom/` 目录树去掉 `evals/` 后的哈希，所以只改了评测或文档的不同提交、在不同机器上跑的同一产品会合在一起；产品有未提交改动时记为 `dirty-…`，不与任何样本合并。`--local` 只看本机私有历史。
- `loop status` 读已提交记录：按机器列出各自最新的介入率，并提示本机还有几次 gate 未提交（用 `loop records import` 补录旧运行）。
- 记录文件只含聚合数字；CI 的离线测试会拒绝格式错误或带本机路径的记录。

## `loop freeze <ref>`

把 `<ref>` 检出为 `~/.rotom/loop/frozen/<sha>/` 下的 detached worktree，按它自己的 lock 装 `runtime/pi` 与 `extensions/third-party`，再跑 gate 的 preflight。同一提交再次 freeze 不重装；preflight 指出的目录会重装一次，仍不一致就拒绝并给出目录。它不删除任何东西：目录存在但不是 rotom 产品时报错，由维护者自己检查后处理。

`loop gate` 省略 `--baseline` 时使用最近一次 freeze 的产品，并在输出里打印 SHA；从未 freeze 过则拒绝运行。发版后把基线换成新发行 commit：`loop freeze <发行 commit>`。

## `loop status`

只读已有文件，不调模型、不写 Git：`gate.json`、`~/.rotom/loop/gate-history.jsonl`、账本、最新的 `weekly-<日期>/summary.json` 与 freeze 指针。打印四个数字（介入率、有区分度的爬坡用例数、已上线未验收的机制条目数、距上次 gate / weekly 的天数）、每个用例登记的复现结论与最近一次及累计结果、weekly 已给出结论的验收条目，以及 “Next”。

- 没有数据时打印 `no record`，不打印 0。
- 每个用例的 “last run” 与 “all runs” 只计该用例当前运行模型上的样本；换过模型的用例从新模型重新累计，旧模型样本仍在 gate 历史里，可用 `gate-pool` 查看。
- 后三个数字是过程指标，“all runs” 跨所有 candidate commit 累加，不是判定；判定仍以 `loop gate` / `gate-pool` 为准。
- “有区分度” 指 `gate.json` 里该用例至少有一条 `verdict: "reproduced"` 的按模型记录。

## CI 的范围

workflow 不配置密钥、不调模型，只证明离线测试、类型和账本格式；它通过不代表任何模型行为，也不替代 gate。2026-11-24 首次运行：离线测试 437 通过、1 跳过，job 约 3.5 分钟。用 macOS runner 是因为 `test/loop-replay-sandbox.test.ts` 依赖 `/usr/bin/sandbox-exec`，在 Linux 上有 3 个用例失败。

# rotom Evals

本目录是 rotom（原 Dev Agent）的通用、模型驱动评测基础设施。它改编自 Pi `0.84.3` 的
[`packages/evals`](https://github.com/earendil-works/pi/tree/main/packages/evals)，使用真实 Pi
`AgentSession`、`vitest-evals`、隔离临时工作区和原生 session artifact，比较 baseline 与 candidate
的任务正确率、token、延迟和估算成本。

产品与项目仓库为全小写 [rotom](https://github.com/bingjiang0611/rotom)。`dev-agent` arm、`DevAgentPi` adapter、`dev-agent-evals` 包名及既有 artifact schema 保留实验 identity；产品环境变量使用当前源码中的 `ROTOM_*`，不能按历史品牌猜测。

当前包含 harness、A/B table、artifact/report、基础设施测试和少量固定 canary；不把这些局部 case 外推成完整产品分数。已退出产品面的 compact-policy 专项及其 scorer 通过 Git history 查阅，不在当前 eval surface 保留死入口。

仓库级外部 benchmark 另通过官方 Harbor grader 接入：

- SWE-bench Multilingual：固定 Harbor adapter registry commit 和 `1.0` 数据集版本，共 300 题；
- Terminal-Bench 2.0：使用 Harbor Hub 的 `terminal-bench/terminal-bench-2`，共 89 题；
- Terminal-Bench 2.1：本地 registry 固定 `harbor-framework/terminal-bench-2-1` 的 `d49e28f1e4ddd13d289e85a5f312a66750951932`，共 89 题，不把 2.0 改名冒充 2.1；
- 默认运行自定义 `DevAgentPi`，把指定 `rotom` worktree 的实际 extensions、skills、prompts 和 tools
  装进任务环境，不使用 Harbor 的 stock Pi 作为被测产品。`--arm=native-pi` 是明确的对照臂：复用同一 Node 24 安装器与精确 Pi 版本，但不安装产品资源或 shim，运行行为仍继承 Harbor 的 Pi adapter。

## 发布评测准备（零模型）

当前审批只允许准备，不授权真实评测或对外发布。`profiles/release-preparation.json` 是**规划记录，不是执行器或预算熔断器**；`liveExecutionAuthorized:false` 不会替代已有 runner 的执行授权纪律。用户指定的 `luna / high` 已由当前已认证 Pi 的模型列表解析为 `openai-codex/gpt-5.6-luna / high`；容器里的认证、请求与 usage 尚未验证，不复制宿主凭证。后续规划上限是 $20 / 2 小时，执行前还需预算控制、环境/源码冻结和重新授权。

- `profiles/terminal-bench-2.1.registry.json`：官方 commit 的全部 89 个任务引用；Maka 的 [实验配置](https://github.com/apache/maka/blob/main/packages/eval/experiments/terminal-bench-2.1-deepseek-v4-flash-eight-arm.json) 提供 repository/revision，已通过该仓库 Git tree API 核对。只共享任务版本，不声称 Harbor 版本、模型、网络和资源限制与 Maka 完全相同。
- `profiles/release-smoke.txt`：10 个预选链路任务，覆盖构建、异步、服务、调试、恢复、安全修复、Git、大编辑、跨语言和查询。未根据本产品成绩选题；不是代表性发布分数，也不保证 $20 内能跑完。
- 明确传 `--pi-version=0.85.1 --thinking=high`；旧命令仍默认 Pi 0.84.3，不静默更改既有实验。Node 安装器当前固定 major 24，正式 run 还需锁定实际 patch/image identity。
- 最终冻结应记录两臂源码/包/镜像指纹、模型/provider、任务/verifier、thinking、预算、顺序和重试口径。超时计入失败；基础设施重试保留证据，不挑选最佳尝试。

只打印一个任务的两组命令（不会执行模型、拉取任务镜像或启动容器）：

```sh
cd rotom/evals
for arm in native-pi dev-agent; do
  npm run benchmark -- terminal-bench-2.1 \
    --arm="$arm" --pi-version=0.85.1 \
    --provider=openai-codex --model=gpt-5.6-luna --thinking=high \
    --task=build-cython-ext --dry-run
done
```

发布准备的实际验证、阻塞项与命名候选见 [发布准备记录](../../docs/agent/release-preparation.md)。

## 安装与基础设施验证

GitHub Actions `Evals L1` 跑 session-cards、trace-assertions、agreement、review、session-metrics、error-breakdown、command-failures 合成测试，以及 observability dashboard / Eval API 测试、typecheck 和公开树隐私审计。
CI 不跑全量测试、真实会话或付费 eval，不代表产品运行时及 L2/L3 通过；不需要 secret。

依赖精确跟随 Pi `0.84.3` 上游已验证组合，尤其固定 `vitest-evals@0.15.0`：

```sh
cd rotom/evals
npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always
ROTOM_NODE=/absolute/path/to/node npm test
ROTOM_NODE=/absolute/path/to/node npm run typecheck
```

外部 benchmark adapter 依赖官方 Harbor `0.22.0`，单独验证：

```sh
uv tool install 'harbor==0.22.0'
npm run test:benchmark-adapters
npm run benchmark:doctor
npm run benchmark -- doctor --live
```

`doctor --live` 会用一个很小的 Alpine 镜像实际验证 `linux/amd64 + Rosetta`；普通 `doctor` 只检查
Harbor、Apple container、adapter import 和 product 文件。

## 本机会话卡片与标注（零模型）

Node ≥ 24；从 Pi session 当前分支生成 Markdown 卡片，按工具调用 ID 的 SHA-256 关联 trace。

```sh
node rotom/evals/scripts/session-cards.mjs build --since 7d --limit 50
node rotom/evals/scripts/session-cards.mjs labels
```

以上命令从仓库根执行。默认读取 `~/.pi/agent/sessions`，输出 `~/.rotom/evals/cards`；
可用 `--root`（仅 build）和 `--out` 指定目录。build 单次最多 500 个会话，按文件修改时间倒序。
在卡片末尾填写 `verdict: pass` 或 `verdict: fail`；`categories:` 用逗号分隔，`note:` 可多行。
`labels` 只收 verdict 非空的卡片，写入卡片目录上一级的 `labels.jsonl`。
`labeledAt` 是本次导出时间；重复 build 原样保留已填 verdict 的标注块，格式损坏时拒绝覆盖。
卡片目录权限为 0700，卡片和标签文件为 0600；拒绝 Git 工作树内输出及 symlink 根/输出目录。
输入只读，按行流式读取；超过 256 MiB 的 session 跳过，超过 64 MiB 的行跳过并计解析错误；trace 同样有界。
缺少 trace 标 missing，损坏、超限或未结束工具 span 标 partial，不把未知工具结果当成功。
build/labels 的 stdout 仅输出计数（labels 另含人工填写的类别计数），不输出会话正文。
跳过按超限、无效 header、空会话、重复 ID 拆分；解析错误分别统计 session / trace，并保留总数。
`invalidHeaderKinds` 输出受限 header 类别，`invalidHeaderKeySets` 只输出排序后的安全字段名，不输出字段值。
header 跳过空行和坏 JSON 后查找；`sessionVersions` 只统计已生成卡片的 1/2/3/missing 版本。
缺少 version 或 version < 2 的会话在内存中重建线性分支，不回写输入；支持 bashExecution / custom 消息。
真实卡片、标注及会话内容只留本机私有目录，绝不加入仓库或公开报告。

在交互终端运行 `node rotom/evals/scripts/session-cards.mjs review`，可传 `--out <cards dir>`、`--limit N`；默认按 started 从新到旧问最多 50 张未标注卡片。
`y` 满意，`n` 不满意后补一句原因（可回车留空）；categories 留空，分类交给规划者。
`s` 跳过，`o` 显示完整卡片绝对路径，`q` 退出；逐张保存，Ctrl+C 保留已保存回答，损坏标注块不覆盖。
需 TTY 输入；review 输出含私有摘要，不要复制进仓库。完成后运行 `labels` 汇总，仍可手工编辑标注块。

### 卡片规则检查（零模型）

规则只检查当前分支；hit 不等于人工 fail，缺少所需证据为 unknown，不能视为 clear。

| 规则 | 命中条件 |
|---|---|
| `repeat-after-error` | 错误结果后，紧接着调用相同工具及按 key 排序后相同的参数 |
| `ended-after-tool-error` | 最后工具的 trace outcome 非 ok，后续最后 assistant 以 stop 收尾 |
| `ended-on-provider-error` | 最后 assistant 为 error，或 aborted 后没有新 user |
| `schema-errors` | 当前分支工具的 schema outcome 至少 2 次 |
| `oversized-tool-result` | 工具结果文本字节数大于 50 000 |
| `harness-fault` | 工具 fault_side 为 harness；已结束的 ok/aborted 按合同缺此属性时视为无该故障 |

卡片、build 汇总及 labels 导出均包含 findings；旧卡片缺少 findings 时导出为全 unknown。

### 标注一致性报告（零模型）

从仓库根执行 `node rotom/evals/scripts/session-cards.mjs agreement`；可用 `--out <cards dir>` 指定卡片目录。
读取卡片目录上一级的 `labels.jsonl`，不修改标注；默认读取 `~/.rotom/evals/labels.jsonl`。
stdout 只含计数和比例；同级 `agreement.md` 以 0600 写入，包含信号统计、类别覆盖及 FP/FN 会话 ID。
仅 pass/fail 参与统计；unknown 或缺少某个信号不进入四格。零分母显示 n/a，小分母标 `(n<10)`。
信号名自动从有效标注发现，不限于当前规则；报告不生成总分、不代填 verdict，输出仍拒绝 Git 工作树。

### 每周效率统计与定向补标（零模型）

```sh
node rotom/evals/scripts/session-cards.mjs stats --since 28d
node rotom/evals/scripts/session-cards.mjs build --focus --limit 40
```

`stats` 按 ISO 周和 `provider/model` 汇总会话数、toolCalls／时长／tokens 的中位数和 p90、总工具出错率、
无最终文本与 provider 错误占比、各规则命中占比和 costUsd；stdout 只有聚合 JSON，会话 ID 只写入同级私有的
`stats.md`（含工具出错最多的 10 个会话）与 `stats.jsonl`（每会话一行）。拿不到的指标记 null 并附样本数 n，
cost 缺任一条时整列 null 并标 partial；总出错率是各会话 toolErrors 之和除以已结束 span 之和，不是比率平均。

工具与 provider 出错来源见 `session-cards.mjs breakdown --since 28d`：按工具名和 `provider/model` × 错误类别拆分。
命令与旧 edit 错误只在内存里分类；命令类别、重复失败信号及同级 `labels.jsonl` 标注对照只输出聚合计数。
stdout 不含命令、参数、fingerprint 或会话 ID；会话 ID 只写入同级私有的 `breakdown.md`。

`rotom --trace` 后台的「评测」页支持本机会话复盘与人工标注。活动状态与人工结论分开；active 会话允许按当前进度标注，记录 `atEntryId` / `atEntryCount`，unknown 状态仍禁止写入。标注后追加内容会显示「标注后有新进展」。默认筛选未标注，筛选计数与已标注进度独立显示；列表按会话身份/开始时间稳定分页，时间线变化最多自动重载一次。
标注写入 `~/.rotom/evals/annotations/`；`labels` 统一合并卡片与 annotation，冲突以 annotation 为准并计 `conflicts`，新增 `failSet`。

「让模型分析」先展示模型、发送字符数与截断情况，逐次确认后才启动产品 launcher。摘要只含当前分支，不含人工标注，最多 80,000 字符。长会话保留全部用户消息与助手文本、非 ok 工具及前后各 2 个事件、首尾各 20 个事件，其余连续 ok 工具折叠为保留原序号范围和工具计数的 `tool_run`；只能引用未折叠的事件，折叠后仍超限才拒绝。只有一个分析可运行，180 秒超时，可取消，不自动重试。原生 `--single-request` 关闭工具、会话落盘、自动压缩/预热及两层重试；默认模型仍由 Pi 解析，选定模型使用精确 `provider/model`，不模糊匹配或回退。模型目录只缓存成功结果；读取失败可点「重试读取模型」，不自动重试，也不触发分析。分析失败会区分「模型回复被截断」与「回复格式不合格」，并在页面显示原因与处理建议；截断检测同时覆盖 `stopReason` 非正常结束、半截 JSON 和 stdout 超限（4 MiB）。判词长度上限为 summary 120 字、evidence 6 条各 80 字、suggestions 4 条各 80 字，避免输出被服务端上限截断。成功目录在更新安装/登录后需重启后台刷新；不会复制 API-key/token 环境变量或凭据文件，认证由子进程的原生登录存储处理。

后台性能合同：目录扫描按层并行（最多 64 并发）、跳过符号链接，只校验一次 canonical 根目录；会话 header 按 `(inode, size, mtime)` 缓存，列表只解析当前页会话，不再为整库构造行。一次列目录结果缓存 1.5 秒，供「打开列表 → 打开详情 → 保存后刷新」的突发请求复用；`refresh=1` 强制重新列目录，写入前也会重新校验。筛选在分页之前完成，所以「未标注」等筛选页仍是完整的 10 条，游标指向筛选后的序列。`counts` 中 `all` / `unlabeled` / `fail` / `failSet` 来自标注，始终精确；`hits` 需要完整 branch，未测量前返回 `null`，页面显示「按需统计」，首次进入该筛选时才计算并缓存。列表现已附带 `matched`、`elapsedMs` 与 `hits: null` 语义。Trace 扫描同样并行读 tail，并按文件 `(size, mtime)` 缓存摘要，20 秒内重复请求直接复用；「刷新数据」会重新扫描，但未变化的 trace 不会重读。页面加载时显示已等待秒数、骨架行与「用时」，加载期间禁用筛选以避免排队请求。

模型目录失败会区分 launcher 执行权限、运行时校验、超时、非零退出、空 stdout、非法 JSON、重复 id 和默认模型缺失，并显示可复制的同路径排查命令。子进程 stderr 只写后台进程日志，不进入 API 响应或 trace。空模型目录是有效协议响应，页面提示配置/登录后重启后台以刷新目录缓存。

真实 launcher 的可复跑检查（先按架构文档安装当前锁定运行时）：

```bash
node rotom/extensions/observability/eval-launcher-check.mjs --faux
# 可选：--launcher /absolute/isolated-checkout/rotom/bin/rotom-launcher
```

默认使用临时空 HOME、空工作目录与 Node 网络拦截，执行后台相同 argv 的模型列表检查；`--faux` 另用原生离线 faux provider 检查非空目录、默认模型、单次 JSON 事件流及 stderr 分离。复用后台校验函数，只输出计数/状态，结束后清理隔离数据，不使用用户凭据、会话或付费模型。该检查也进入 Evals L1 CI。

合成 UI 检查默认使用 Playwright 自带的 Chromium（先用对应 Playwright CLI 安装 `chromium`）；可用 `PLAYWRIGHT_CHANNEL=chrome` 显式选择本机 Chrome，`PLAYWRIGHT_MODULE` 指定已有 Playwright 模块路径。

分析以私有追加记录写入 `~/.rotom/evals/judgments/<sessionId>/<timestamp>.json`，不改原始会话/trace，不覆盖历史。结果格式不合格、失败、超时、取消均单列；缺失费用为未知，Pi 计算费用仅显示为估算，不冒充服务商账单。「采纳建议」仅预填，仍须人工保存。`agreement` 追加最新成功且非 unsure 分析与人工标注的 TP/FP/FN/TN；n < 10 标星，未对齐不同进度的结论不代表模型可靠性。
`review` 跳过已有 annotation；agreement/breakdown 复用同一合并逻辑。无卡片时仍支持已有 labels.jsonl 导出文件，不把它覆盖实时卡片。
共享读取、分支、规则、指标仅在 `extensions/observability/eval/` 保留一份源码，eval 脚本通过 import/re-export 复用。

`build --focus` 只生成可疑会话的卡片：工具出错数 ≥ 5 且出错率 ≥ 10%、任一规则命中、无最终文本、
或 provider 错误。此时 `--limit` 是要生成的卡片数上限，扫描仍按 500 个会话；summary 另有 `focusScanned`、
`focusMatched` 和各条件命中计数。已填 verdict 的卡片照旧保留标注，`review` 仍只问未标注卡片。

## 运行评测

`cases/session-review.eval.ts` 是五题决策探针，来源是近一周人工复盘里反复出现的不满模式：把启动回执当成后台任务仍在运行、同一失败参数连续重试不换手段、被中断后空回复不交代进度、交付报告与源数据不一致、把明文凭据发给第三方分类器。题目由 `src/session-review-cases.ts` 定义，**只保留模式**：提示词、标识符和数据行全部为合成内容，私有会话原文、标注与工具参数不进入仓库。判定是确定性的 JSON 字段检查，因此回归表现为答案改变而不是判词文风变化。`test/session-review.test.ts` 在 CI 中对每题同时跑“合规答案得 1 分”和“复盘中的失败答案低于 1 分”，避免判定恒真；真实模型运行仍需 `ROTOM_EVAL_PROVIDER`、`ROTOM_EVAL_MODEL` 与 `ROTOM_EVAL_BASELINE_PRODUCT`，并计入 provider 用量。

以后在 `cases/**/*.eval.ts` 增加评测集后执行：

```sh
cd rotom/evals
npm run eval -- \
  --pi=/absolute/path/to/pi \
  --provider=provider-id \
  --model=model-id
```

三个 npm script 都通过 `ROTOM_NODE` 选择 Node；未设置时只使用 `command -v node`。实际 runtime 仍会由
dev-agent verifier 拒绝低于 `23.6.0` 的版本。

也可以使用 `ROTOM_PI`、`ROTOM_EVAL_PROVIDER` 和 `ROTOM_EVAL_MODEL`。

固定 benchmark canary 位于 `profiles/canary.txt`，第一条非空行是精确版本标记 `# dev-agent-benchmark-profile/v1`，后续数据行格式为 `<benchmark> <explicit-task-id>`；当前只固定 SWE-bench Multilingual 与 Terminal-Bench 2.0 各一题，用于基础设施与明显回归 smoke，不是代表性样本。`src/benchmark-profile.ts` 会拒绝空文件、未知 benchmark、非法 ID 和重复项。runner 不增加 `--profile` 抽象：维护者逐行把 task id 传给现有 `--task`，先 `--dry-run` 核对 Harbor argv。没有 compatible baseline/candidate、provider/model/thinking/environment/dataset lock/attempts 时一律报告 `INCONCLUSIVE`。

`lane-stale-recovery.eval.ts` 是无工具、无宿主副作用的决策微型 A/B：`single lane reuse` 检查同一 validation lane 是否使用单 worker、fresh context、`steer/resume`、compact handoff 和有界 replacement；`stale UI recovery` 检查 stale 后是否先 `observe_ui`、绑定新 state/ref、禁用旧 ref 并只重试一次。paired 运行还需设置 `ROTOM_EVAL_BASELINE_PRODUCT`，并通过 `ROTOM_EVAL_BASELINE_POLICY_FILE` / `ROTOM_EVAL_CANDIDATE_POLICY_FILE` 传入待比较的精确 policy 投影。case 只证明模型对固定决策题的响应，不代替真实 Subagent 调度或桌面 Computer Use L3；硬 stale gate 另由组合层确定性测试覆盖。

`ownership-handoff.eval.ts` 是显式启用的八题 ownership/evidence-handoff 决策 A/B（其中两题是 canary）。使用 `ROTOM_EVAL_OWNERSHIP_HANDOFF=1`、`ROTOM_EVAL_BASELINE_PRODUCT` 和 `ROTOM_EVAL_CANDIDATE_PRODUCT` 指向冻结产品；可用 `ROTOM_EVAL_OWNERSHIP_CASE=<fixed-id>` 逐组控制预算。两臂固定 medium、无工具，并投影各自产品的 Subagent/handoff guideline。`src/ownership-handoff-cases.ts` 冻结题目和严格判分；literal anchors 与下一步 enum 有已知语义局限，必须保留原分数并另作人工解释，不把它当真实 Chrome/子进程隔离或完整 coding benchmark。详见 [`maka-234-report.md`](../../docs/agent/maka-234-report.md)。

`coding-execution-hygiene.eval.ts` 使用真实 baseline/candidate 产品资源和最小 `bash/edit` 工具面，固定评估目标 Git root/cwd、package script preflight、rename 后验证路径、`rg` exit 1、唯一 edit 上下文和 timeout 诊断六个维度，并检查用户排除的分层验证建议没有被引入。`browser-coordinate-click.eval.ts` 使用最小 Browser 工具面，固定评估 Canvas 坐标 fallback、stale screenshot、ref 优先和 hit-test mismatch fail-closed。两者默认各 2 次 paired、交替顺序；只证明固定决策题，不代替 Chrome relay 确定性 guard 或真实 Canvas L2/L3。

### 真实工具输出与执行卫生：`tool-efficiency.eval.ts`

仅经明确模型调用授权后启用。5 个实际工具任务、每臂 2 次、交替顺序，另有 3 个候选能力任务各 2 次（显式 compact 成功/失败与合成文件漂移恢复）。baseline/candidate 复用各自 launcher 的 installed/archive/source identity gate，不能仅凭相同版本号认定运行时相同；不注入假 bash/edit 返回。检查文件正确性、检查只执行一次、失败日志证据回读、逐字完整性、无关进程参数不进入输出，记录 raw tool-result bytes、调用数和 compact 使用次数。合成进程快照不是本机性能实测；bytes 不是 provider tokens。合同与边界见 [工具执行卫生与输出控制](../../docs/agent/tool-efficiency.md)。

```sh
ROTOM_EVAL_TOOL_EFFICIENCY=1 \
ROTOM_EVAL_BASELINE_PRODUCT=/absolute/baseline/rotom \
ROTOM_EVAL_CANDIDATE_PRODUCT=/absolute/candidate/rotom \
npm run eval -- --provider=<provider> --model=<model> cases/tool-efficiency.eval.ts
```

### 规则级消融：`coding-hygiene-rule-ablation.eval.ts`

产品 A/B 只能回答“这个 build 是否合规”，不能回答“这 6 条规矩里哪几条真的改变了行为”——模型本来就会做的那几条，有没有 policy 分数都一样。该评测集因此每次撤掉一条规则并做配对比较，三臂共用 `src/coding-hygiene-cases.ts` 的题目与判分：

| 臂 | 规则 | 角色 |
|---|---|---|
| `rule-withheld` | 6 条里去掉本题对应那 1 条 | baseline |
| `policy-full` | 完整 6 条，由 eval 侧重建注入 | 重建有效性对照 |
| `product` | 完整 6 条，产品原生注入 | 真实基准 |

每题通过 `ruleAnchor` 按文本子串绑定唯一一条规则（不按下标，避免重排后静默指错对象），`resolveHygieneRule` 在匹配数不等于 1 时直接报错。撤 1 留 5 使 prompt 体积基本不变，排除“prompt 变短所以变差”的混淆。报告器现成的 `meanDelta` / `lift` 即为该条规则在该题上的贡献。

重建臂用 `inlineExtensions` 复制产品自己的 `before_agent_start` 追加路径（含 `CODING_TOOLS` 门），而不是改基础 system prompt，因此 policy 落在相同位置。`test/coding-hygiene-rule-ablation.test.ts` 用 faux provider 断言 `policy-full` 与 `product` 实际发出的 prompt **逐字节相同**（仅归一化临时 workspace 路径），并断言撤掉的那臂恰好少 1 条、其余 5 条在位；这条等式是整个消融的有效性闸门，零模型花费。

显式启用，避免普通 eval 增加费用：

```sh
ROTOM_EVAL_HYGIENE_RULE_ABLATION=1 \
ROTOM_EVAL_HYGIENE_RULE_ABLATION_REPEATS=2 \
npm run eval -- --provider=<provider> --model=<model> cases/coding-hygiene-rule-ablation.eval.ts
```

只 `product` 臂按 threshold 1 门禁；`rule-withheld` 分数更低是预期信号，不作为失败。

#### 首轮实测结论（`cc-switch / claude-opus-5`，thinking=low，每臂 2 次）

| 题（对应规则） | withheld | policy-full | product | Δ(product − withheld) |
|---|---|---|---|---|
| ambiguous edit context | 1.00 | 1.00 | 1.00 | +0.000 |
| package script preflight | 1.00 | 1.00 | 1.00 | +0.000 |
| renamed validation path | 1.00 | 1.00 | 1.00 | +0.000 |
| ripgrep no match | 1.00 | 1.00 | 1.00 | +0.000 |
| target repository root | 0.80 | 1.00 | 1.00 | +0.200 |
| timeout diagnosis | 1.00 | 1.00 | 1.00 | +0.000 |

`policy-full` 与 `product` 在全部 6 题上完全一致，重建路径有效。唯一非零差值是判分锚点产物而非行为差异：撤掉规则后模型仍然给出 `targetRoot=/workspace/app-alpha`、`assumesAggregateRoot=false`，只是首条命令用 `git -C /workspace/app-alpha status --short --branch` 而不是判分要求的 `rev-parse`。与 `ownership-handoff` 的 literal-anchor 局限同类，保留原分数另作人工解释。

因此在该模型、该 6 道计划题上，**这 6 条规则没有可测的行为效应**，与上面已归档的 `CONTEXT_EFFICIENT_TOOL_USE_POLICY` 结论同向（模型本来就在做）。**不得**据此删除任何规则：n=2、单模型，且题目全是“不执行工具、只输出计划 JSON”，按本文件既有要求，计划题不能冒充行为改变；弱模型与真实长会话未测量。要据此收窄 policy，必须先在目标模型上重建行为级证据（真实执行、天真路径真正昂贵、含反向约束题），并在多模型上一致复现。

附带发现（**未修复**）：`transformSystemPrompt` 走 loader 的 `systemPromptOverride`，它替换的是*基础* system prompt，Pi 随后仍会追加 skill 目录与 cwd 页脚。把已合成的 prompt 传进去会让页脚出现两次——首轮消融即因此使重建臂多约 700 tokens（约 1776 字符）。`computer-use-contract`、`ownership-handoff`、`lane-stale-recovery` 仍在用该选项，其历史数字都带这一重复页脚。需要追加内容时应改用 `inlineExtensions` 或 loader 的 `appendSystemPromptOverride`。

### 最终汇报结构：`final-report.eval.ts`

比较 coding-policy 的 `FINAL_REPORT_POLICY` 段。两臂都排除产品 `coding-policy`，用同一重建路径注入：`hygiene-only` 只带执行卫生规则，`with-final-report` 再追加汇报段，差异仅为该段。三道真实工具题在临时 Git 工作区运行：`fix-with-gaps`（真修复 + 无关失败测试 + 本地无法验证的网关）、`diagnose-only`（只诊断不改文件）、`simple-question`（对照题，汇报段不得把一句话答案撑长）。判分是文本锚点，只证明提到了某项，不证明清晰；结论须人工阅读 `vitest-results.json` 中保存的完整回复。

```sh
ROTOM_EVAL_FINAL_REPORT=1 \
ROTOM_EVAL_FINAL_REPORT_REPEATS=2 \
npm run eval -- --provider=<provider> --model=<model> cases/final-report.eval.ts
```

可选 `ROTOM_EVAL_FINAL_REPORT_TASK=<task-id>` 只跑一题；high thinking 下建议追加 `--testTimeout=600000`。`ROTOM_EVAL_THINKING` 默认 `medium`。`ROTOM_EVAL_FINAL_REPORT_AGENTS=/absolute/AGENTS.md` 会把该文件复制进隔离 agent 目录作为全局 context file，用于贴近真实用户配置；若系统提示中未出现其内容，该 run 直接报错。

2026-10-12 首轮（thinking=medium）平均锚点分 hygiene-only → with-final-report：

| 模型（每臂次数） | fix-with-gaps | diagnose-only | simple-question | fix 回复长度（字符） |
|---|---|---|---|---|
| `openai-codex/gpt-6.1-sol`（2） | 0.83 → 0.94 | 0.58 → 0.83 | 1.00 → 1.00 | ~150 → ~420 |
| `openai-codex/gpt-6-astra`（2） | 0.89 → 1.00 | 0.58 → 0.83 | 1.00 → 1.00 | ~155 → ~460 |
| `cc-switch/claude-opus-5-5`（1） | 0.89 → 1.00 | 0.67 → 1.00 | 1.00 → 1.00 | 690 → 981 |

人工阅读：两臂都已写出“无关失败 / 网关未验证 / 未提交”，这来自既有执行卫生规则；汇报段新增的是分段结构、改动文件清单（含新增测试）、验证命令与计数表、修复前复现失败的反向对照，以及诊断题的下一步。对照题两臂都约 56 字符，未被撑长；opus 对照题反而由 253 缩到 83。`diagnose-only` 的 `statesCiUnverified` 锚点在 GPT 两臂都未命中：回复写了“未运行安装”和“再用 `npm ci` 验证”，属锚点过严，保留原分数。首轮局限：n≤2、不加载用户 `AGENTS.md`、未覆盖长会话、未测 qoder。

第二轮（harness 支持扩展注册 provider 后补测 qoder；“真实配置”= thinking=high + 维护者全局 `AGENTS.md`，每臂 2 次）：

| 模型 / 配置 | fix-with-gaps | diagnose-only | simple-question | fix 回复长度（字符） |
|---|---|---|---|---|
| `qoder/ultimate`，medium，无 AGENTS | 0.78 → 1.00 | 0.58 → 0.67 | 1.00 → 1.00 | ~150 → ~380 |
| `qoder/ultimate`，真实配置 | 0.78 → 1.00 | 0.50 → 0.92 | 1.00 → 1.00 | ~165 → ~415 |
| `openai-codex/gpt-6.1-sol`，真实配置 | 0.78 → 1.00 | 0.58 → 0.83 | 1.00 → 1.00 | ~155 → ~390 |
| `openai-codex/gpt-6-astra`，真实配置 | 0.83 → 1.00 | 0.67 → 0.92 | 1.00 → 1.00 | ~175 → ~395 |

用户 `AGENTS.md`（含“输出清晰简洁”与“如实交付”要求）没有让 baseline 自行写出分段汇报：真实配置下 baseline 的 fix 回复仍约 150–175 字符、常缺验证计数。汇报段在四组中方向一致，对照题不变长。high thinking 下 fix 题耗时可超过默认 120s：gpt-6.1-sol 有 3 次、qoder 有 1 次超时（基础设施失败，不计分），两模型的 fix 题以 `--testTimeout=600000` 整题重跑、仅用重跑数据。仍未覆盖：长会话、真实复杂任务、opus 真实配置、判分之外的清晰度量化。

### 排查推进：`follow-through.eval.ts`

比较 coding-policy 的推进改动：新增 `FOLLOW_THROUGH_POLICY` 段，并把汇报段的“下一步”从“可选”改为“仍有未决项时必填、放最后”。改动跨两段，所以 baseline 臂注入 `ROTOM_EVAL_FOLLOW_THROUGH_BASELINE_REF` 处提交的完整 policy，candidate 臂注入工作区 policy；两臂都排除产品 `coding-policy`，走同一重建路径。三道题：`archive-mismatch`（原因要跨三跳：查询键 → 无 import 指向的写入任务 → 数据，且不许改代码）、`plan-gaps`（四个缺口中三个可本地查清，其中一个只在超过 read 50KB 分页的 SQL 末尾；第四个确实受阻）、`simple-question`（对照题，不得变长或多跑工具）。`onlyPlanChanged`/`noEdits` 按相对 fixture 提交的改动判定，因为用户 `AGENTS.md` 可能让 agent 自动提交。

```sh
ROTOM_EVAL_FOLLOW_THROUGH=1 \
ROTOM_EVAL_FOLLOW_THROUGH_BASELINE_REF=<commit> \
ROTOM_EVAL_FOLLOW_THROUGH_REPEATS=2 \
npm run eval -- --provider=<provider> --model=<model> cases/follow-through.eval.ts --testTimeout=900000
```

可选 `ROTOM_EVAL_FOLLOW_THROUGH_TASK`、`ROTOM_EVAL_FOLLOW_THROUGH_AGENTS`、`ROTOM_EVAL_THINKING`，含义同上节。

2026-10-15 首轮（baseline=`2d1a250`，thinking=high，维护者全局 `AGENTS.md`）。表中为“以下一步收尾”的命中次数，即结尾 500 字符内出现提问或带审批的提议动作：

| 模型 / 题目 | baseline | candidate |
|---|---|---|
| `qoder/ultimate` archive-mismatch | 0/2 | 2/2 |
| `cc-switch/claude-opus-5-5` archive-mismatch | 0/1 | 1/1 |
| `qoder/ultimate` plan-gaps | 0/2 | 1/2 |
| `qoder/ultimate` simple-question（对照） | 回复 20–58 字符，2 次工具 | 20–72 字符，2–3 次工具 |

人工阅读：candidate 在诊断题末尾写“统一读写两端日期键并补跨午夜测试，你确认后我再修改”，且未改代码；baseline 停在“修复方向是……”或“未修改任何文件”。迭代中发现，只在新段里写“有未决项要给下一步”无效（同模型 0/2 → 1/4）：汇报段原来写的是“only when a decision or follow-up remains”，模型据此判定诊断题已完成。把规则落到汇报段本身、并点名“只要求诊断时也算未决”后才生效。plan-gaps 的 candidate 仍有 1/2 只把未决项列成“待确认”，未给负责人和动作。

未复现的部分：在这些短 fixture 上，两臂都追到了根因、读完了 50KB 之后的分区字段 `stat_day_p`。用户反馈的“浅看即停”在这里不出现，可能只在长会话或大仓库中出现。因此 `FOLLOW_THROUGH_POLICY` 中“查完再停”的规则目前没有正向证据，只有“未损害对照题”的证据。要验证需要长上下文 fixture 或真实会话回放。样本 n≤2，结论只代表方向。

## 已归档结论：context-efficient tool-use policy（无对应 case）

曾在 `coding-policy` 注入过一段 `CONTEXT_EFFICIENT_TOOL_USE_POLICY`（引导"能聚合的问题写一条 pipeline、先 `rg` 定位再按窗口读取、在源头限流"，并附"需逐字复现的内容照常精确读取"的反向约束）。该 policy 与验证它的 paired 行为 A/B 均已按维护者决定移除，仅保留下面的实测结论，避免后人重踩。

实测配置：`cc-switch / claude-opus-5`、`thinking=low`、工具面 `bash/read/grep`，两臂只差这段 policy，各题 2 次重复并交替臂顺序。评分读 `session.messages` 的真实工具轨迹（`read` 调用数、搜索/pipeline 调用数、tool result 字节数），不是只看模型对计划的描述。

| 轮次 | 题组 | 配对运行 | 通过率 delta | Tokens delta | 两臂 `read` |
|---|---|---|---|---|---|
| 1 | 小 fixture（28KB，24 模块） | 12 | +0.0 pp（两臂 100%） | +726 … +2480 | 0 |
| 2 | 大 fixture（673KB，617 行/模块） | 12 | +0.0 pp（两臂 100%） | −930 … +3674 | 0 |

关键观测：**24 次配对运行、两种 fixture 规模下，两臂 `read` 均为 0**。即使天真读取整棵树约需 172k tokens、且答案要求逐文件提取常量再做算术（单条 `rg` 计数给不出结果），baseline 在没有这段 policy 时也只用 1–3 条 `bash` 管道、工具输出 14–1669 字节。该模型本来就在做 policy 要求的事，所以 policy 唯一稳定可测的效应是注入开销（≈ 278 tokens，按每次 API 调用重复计入）。两道反向约束题（要求逐字复现函数体，其中一道在 617 行大文件中）两臂均逐字正确，说明该 policy 不伤正确性，但也不带来收益。

因此回退，并遵循"不报告未经测量的 token 收益"。**尚未测量**：弱模型、其他 provider、真实长会话累积。不得用本结果声称"所有模型都不需要这类引导"；如要重新引入同类 policy，必须先在目标模型上重建 paired 行为证据（大 fixture + 天真路径真正昂贵 + 反向约束题），不能用"说得对"的计划题冒充行为改变，也不能用小样本声称整体收益。比较 policy 本身时两臂须用同一份 eval 代码，只让产品 policy 不同；若仓库 `node_modules` 与 `product-config.mjs` 声明的第三方版本漂移，资源校验会先报错，应用隔离快照对齐声明版本，不要改可能正在被活跃会话使用的安装目录。

2026-09-18 在 `openai-codex/gpt-6-astra` 上重新执行大 fixture + 逐字源码反向约束对照，共 16 个运行。首组范围求和收益受单次大范围读取影响，确认组候选也出现大读取；逐字题稳定增加提示开销。因此未恢复全局 policy。显式 `ROTOM_EVAL_CONTEXT_EFFICIENCY=1` 才运行新的 `context-efficiency.eval.ts`，只在评测侧注入提示；结果与局限保持为：小样本不证明全局效率收益，不能恢复常驻 policy。`tool-error-repair.eval.ts` 同次新增测试端真实执行原子失败的恢复场景；新源码预览未证明净收益，也未进入产品。

`bash-tool-surface.eval.ts` 在隔离临时 Git 风格工作区中实际执行一个跨文件 API rename 和一个单文件 bug fix，对比当前 `bash/read/edit/write` core 与 `bash`-only。它用独立的最终文件检查、仓库测试和隐藏行为验证判分，并比较通过率、tool calls、token、延迟和可用时的估算成本。为避免普通 eval 意外增加模型费用，必须显式启用：

```sh
ROTOM_EVAL_BASH_TOOL_SURFACE=1 \
ROTOM_EVAL_BASH_TOOL_SURFACE_REPEATS=2 \
npm run eval -- bash-tool-surface.eval.ts \
  --pi=/absolute/path/to/pi \
  --provider=provider-id \
  --model=model-id
```

这个 2 题、默认 2 次的 paired smoke 只能发现明显工具面回归，不能证明 Bash-only 对常规 coding workload 整体更好。

`tool-error-repair.eval.ts` 与 `computer-use-contract.eval.ts` 是 coding-policy repair hints 与 Computer Use 契约 guideline 的 paired A/B。两者都用 `ROTOM_EVAL_BASELINE_PRODUCT` 指定 baseline 产品目录，baseline/candidate 使用同一 prompt、同一 workspace、同一工具白名单，只有加载的产品不同。`tool-error-repair` 在隔离临时工作区真实执行 `read`/`edit`：`missing-path-recovery` 故意不放行 `bash`，强制第一次 read 失败，并保留 `src/index.ts` 的 re-export 让 baseline 也能在没有 hint 的情况下恢复；`ambiguous-edit-target` 放行 `bash`，因此谨慎的模型可能整轮都不触发 edit 失败，此时该题只能报告“hint 未被触发”，不能当作 hint 无效。`computer-use-contract` 优先从各自产品安装的 `@injaneity/pi-computer-use/src/recovery.ts` 抽取真实 `COMPUTER_USE_*_GUIDELINE` 常量作为投影；只有改造前的 frozen baseline 才读取旧产品 wrapper，`noTools` 运行，只证明这段文本对固定决策题的影响，不代替真实桌面 Computer Use L2/L3。两者都必须显式启用：

```sh
ROTOM_EVAL_TOOL_ERROR_REPAIR=1 \
ROTOM_EVAL_TOOL_ERROR_REPAIR_REPEATS=4 \
ROTOM_EVAL_BASELINE_PRODUCT=/absolute/path/to/baseline/rotom \
npm run eval -- tool-error-repair.eval.ts \
  --pi=/absolute/path/to/pi --provider=provider-id --model=model-id

ROTOM_EVAL_COMPUTER_USE_CONTRACT=1 \
ROTOM_EVAL_COMPUTER_USE_CONTRACT_REPEATS=2 \
ROTOM_EVAL_BASELINE_PRODUCT=/absolute/path/to/baseline/rotom \
npm run eval -- computer-use-contract.eval.ts \
  --pi=/absolute/path/to/pi --provider=provider-id --model=model-id
```

baseline 产品目录需要包含已安装的 `extensions/third-party/node_modules`；`git worktree` 检出后从当前工作树复制该目录（不要用 symlink，product verifier 会拒绝）。

发布面不包含依赖私人业务仓库结构的评测案例。新的大仓场景须使用可公开的独立 fixture，不得把公司项目路径、业务代码或会话正文作为公开测试数据。

宿主机存在 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY`（含小写形式）时，eval runner 为 Node 子进程默认启用 `NODE_USE_ENV_PROXY=1`；调用者的显式值优先。

宿主机 eval 默认把 Agent tool surface 设为 `noTools`。case 可以用 `tools: [...]` 显式声明最小工具白名单；只有确实要让模型访问完整宿主工具面时，才使用 harness 的 `allowHostSideEffects: true`，或在 CLI 中显式传 `--allow-host-side-effects`。仅配置 `excludeTools` 不构成安全白名单。Apple container 内仍默认加载完整产品工具面，但不会继承宿主 Home 或未点名的环境变量。

## Context footprint

无模型、无网络的重复验证：

```sh
node ../runtime/report-context-footprint.mjs "$ROTOM_PI" .. > /tmp/context-footprint.json
```

footprint 报告按 core、Deferred Tool Loader、Browser、Computer Use、Subagent、Ask 分组。`approximateTokenProxy` 明确使用 UTF-8 bytes/4，仅用于静态相对比较，不等于真实模型质量或 provider 精确 token。

## 使用 Apple container 隔离运行

macOS 上安装并启动 Apple `container` 后，可以把相同评测放进独立 Linux VM：

```sh
cd rotom/evals
ROTOM_NODE=/absolute/path/to/node npm run eval:container -- \
  --container-env=OPENAI_API_KEY \
  --provider=openai \
  --model=model-id
```

runner 每次会增量构建 `dev-agent-evals:local`，并执行以下隔离：

- 镜像固定到 `node:24.18.0-bookworm-slim` 的 OCI digest，依赖继续使用精确 lockfile；
- 目标 `rotom` 目录只读挂载到 `/workspace/product`，不挂载宿主机 Home 或完整 `~/.pi`；
- rootfs 只读、Linux capabilities 全部移除，`/tmp` 使用 2 GiB tmpfs；Vite 启动所需的
  `node_modules/.vite-temp` 单独覆盖为 64 MiB tmpfs；
- 默认限制 4 CPU、8 GiB 内存，artifact 是唯一宿主机可写挂载；
- 镜像 digest、Apple container CLI 版本、Linux platform、网络名和资源限制写入 run manifest；
- API key 等变量只有通过 `--container-env=NAME` 点名且宿主机确实存在时才继承；
- 如需 Pi subscription credential，必须用 `--container-auth=/absolute/path/auth.json` 显式选择；runner
  只把该文件复制到一次性私有临时目录，容器退出后删除。

验证镜像自身、Linux 下的 product verifier 和真实 `AgentSession` faux smoke：

```sh
ROTOM_NODE=/absolute/path/to/node npm run test:container
```

常用控制参数：

```sh
npm run eval:container -- \
  --container-cpus=6 \
  --container-memory=12G \
  --container-tmpfs=4G \
  --container-network=default \
  --container-artifacts=/absolute/path/to/artifacts \
  --container-product=/absolute/path/to/rotom \
  --container-models=/absolute/path/to/models.json \
  --no-container-build \
  --provider=openai \
  --model=model-id
```

Apple `container` 的独立网络能隔离不同容器网络，但默认网络仍允许模型请求；这里不把 `--no-dns` 冒充成
完整断网。Browser/Computer Use 的真实桌面登录态与外部写入仍属于宿主机 L3 suite；container 主要承载可复现的离线 fixture、fake CLI 和模型驱动 L2 评测。

每次原生运行写入私有权限的 `.eval/<timestamp_uuid>/`，container 运行写入
`.eval/container_<timestamp_uuid>/`。harness teardown 先 await `session_shutdown`（其中 Observability flush），再保存最终 session/trace，最后删除临时根，避免丢失 terminal/unknown closure：

- `vitest-results.json`：供 `vitest-evals` 本地报告 UI 使用；
- `runs.jsonl`：每个 harness run 的索引、usage、timing、artifact 引用和 run manifest；
- `comparisons.json`：baseline/candidate 配对汇总与缺失观测诊断；
- `sessions/<run-hash>/session.jsonl`：shutdown 后的最终 Pi 原生 session；
- `traces/<run-hash>/trace.jsonl`：metadata-only 本地 trace；默认最多 1 MiB，超限保留从完整 JSONL 边界开始的 tail；
- `traces/<run-hash>/trace-snapshot.json`：original/captured bytes、full/tail strategy 与 truncation；
- `sources/<run-hash>/*`：case 显式登记的源码或结果附件。

这些 artifact 可能包含 prompt、模型回答、工具输出和业务数据，只能放在本机私有目录，不能提交。

## SWE-bench Multilingual 与 Terminal-Bench 2.0

默认只跑 1 题，避免一次命令意外触发完整数据集的模型费用和数十 GB 镜像下载：

```sh
cd rotom/evals

# SWE-bench Multilingual 单题
npm run benchmark -- swe-bench-multilingual \
  --provider=openai \
  --model=model-id \
  --task=apache__druid-13704

# Terminal-Bench 2.0 单题
npm run benchmark -- terminal-bench-2 \
  --provider=openai \
  --model=model-id \
  --task=terminal-bench/make-mips-interpreter
```

运行完整数据集必须显式使用 `--all`：

```sh
npm run benchmark -- swe-bench-multilingual \
  --provider=openai --model=model-id --all --n-concurrent=2

npm run benchmark -- terminal-bench-2 \
  --provider=openai --model=model-id --all --n-concurrent=2
```

还可以使用 `--n-tasks=N`、重复 `--task=NAME`、`--attempts=N` 和 `--run-name=NAME`。重复显式 `--task` 时，未显式给 `--n-tasks` 会自动使用 task 数量，避免默认一题截断；`--all` 不能与 `--task/--n-tasks` 混用。agent 安装超时默认使用
Harbor 基线的 5 倍，避免 Node/Pi/extension 首次下载超过 Harbor 的 360 秒；可用
`--setup-timeout-multiplier=N` 单独调整，不改变任务执行或 verifier 超时。默认从
`ROTOM_EVAL_PROVIDER` / `ROTOM_EVAL_MODEL` 读取模型。用 `--dry-run` 查看最终 Harbor argv；需要传递
Harbor 自己的 timeout/debug/retry 参数时放在 `--` 后面。runner 会拒绝从透传参数覆盖 agent、dataset、
registry、task selection、model、environment、verifier 和结果路径。

### Apple container 与 amd64

两个官方评测集的大量预构建镜像只有 `linux/amd64`。Harbor 原生 `apple-container` backend 默认按 arm64
拉取，会在完整下载后才报 `does not support required platforms`。因此默认环境是本目录的
`Amd64AppleContainerEnvironment`：保持官方 task image 和 verifier 不变，只在 Apple container 的 build/run
命令上加入 `--platform linux/amd64`，运行时再加入 `--rosetta`。

可选环境：

```sh
--environment=apple-container-amd64   # 默认，Apple Silicon + Rosetta
--environment=apple-container-native  # 只适合明确提供 arm64 的题
--environment=docker                  # 官方 Docker backend，需要运行中的 daemon
```

Rosetta 解决的是 CPU 架构，不会把 GPU、嵌套虚拟化、多容器 Compose 或 Windows 特性变出来。遇到这类题时，
Harbor 的 exception 必须按基础设施失败单列，不能算成 Agent 得 0 分。若要提交官方 leaderboard，仍应在官方
推荐的 Docker/云环境上复跑；Apple container 结果用于本项目内部同环境 A/B 回归。

### baseline / candidate 对比

分别指向两个隔离 Git worktree，并保证任务筛选、模型、attempts 和环境完全相同：

```sh
npm run benchmark -- terminal-bench-2 \
  --provider=openai --model=model-id \
  --product=/absolute/baseline/rotom \
  --task=terminal-bench/make-mips-interpreter \
  --run-name=tb2-baseline

npm run benchmark -- terminal-bench-2 \
  --provider=openai --model=model-id \
  --product=/absolute/candidate/rotom \
  --task=terminal-bench/make-mips-interpreter \
  --run-name=tb2-candidate
```

结果默认写入 `.eval/benchmarks/<run-name>/`。Harbor 的 `lock.json` 固化本次实际 task digest；每个 trial 的
agent logs 还包含 `dev-agent-manifest.json`，记录 product Git HEAD、dirty 状态和实际上传 bundle 的 SHA-256。
查看与比较结果：

```sh
harbor view .eval/benchmarks
```

SWE-bench Multilingual 走 Harbor 官方 adapter 的原始 F2P/P2P verifier；Terminal-Bench 2.0 走每题官方
`tests/test.sh` 与 reward 文件。这里不增加 LLM judge，也不把 Agent 最终文本当成功证据。

## Harness 合同

`createPiCodingAgentHarness` 不从 npm 依赖中的 Pi runtime 执行 Agent。每个 run 都会：

1. 从目标 `productAgentDir` 动态读取 `runtime/product-config.mjs`；
2. 调用该产品目录自己的 `runtime/verify-pi-runtime.mjs`；
3. 使用 verifier 返回的真实 Pi public entry；
4. 按 `RESOURCE_DESCRIPTORS_V1` 加载产品 extensions、skills 和 prompts；
5. 在临时 workspace/config/session 目录中运行；
6. 保存资源内容摘要、Git identity、Pi identity、模型、thinking level 和 fixture 摘要；
7. 等待 Agent idle，触发并 await `session_shutdown`/trace flush，再保存最终标准化 session 与 bounded metadata trace，最后清理临时根。

Harness 支持：

- `productAgentDir`：baseline/candidate 指向不同 Git worktree 或快照；
- `excludedResourceKeys`：做某个 extension/skill/prompt 的有无对照；
- `setupWorkspace`：为后续代码、Browser fixture、fake CLI 创建隔离环境；
- `modelRuntimeFactory`：为基础设施测试或受控 replay 注入 faux/provider runtime；
- 扩展注册的 provider（如 `qoder`）：加载产品 extensions 后，先把排队的 provider 注册写入 model runtime，再解析模型，与 Pi 自身 session services 顺序一致；注册失败直接报错。模型调用使用默认 `~/.pi/agent` 的真实凭据与目录缓存；- `tools/noTools/excludeTools`：固定工具暴露面；宿主机未显式配置时默认 `noTools`；
- `allowHostSideEffects`：显式授权宿主 eval 暴露完整产品工具面；Apple container 不需要该开关；
- `environment/environmentProfile`：声明并隔离环境差异；
- `output`：在临时目录删除前执行确定性 outcome 投影。

`evalHarnessTable` 使用显式 input `id` 或 canonical JSON SHA-256 建立配对键，支持一个 baseline、一个或多个
candidate 和多次 repetitions。未评分、运行错误、缺失或重复观测保持为诊断，不自动算成失败或零成本。

## 后续评测集边界

后续 case 应优先检查最终环境状态、文件和工具审计；LLM judge 只补充开放文本质量。Browser、Computer Use 和 Subagent 可以共享同一个 harness，但真实登录态或真实写入必须单列 L3 suite，不能与稳定离线
fixture 混合统计。

上游来源与许可证见 [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE)。

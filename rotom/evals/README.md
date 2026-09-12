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

发布准备的完整历史记录未随此精简公开快照提供；上述 dry-run 不是模型评测通过或批量执行授权。

## 安装与基础设施验证

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

## 运行评测

以后在 `cases/**/*.eval.ts` 增加评测集后执行：

```sh
cd rotom/evals
npm run eval -- \
  --pi=/absolute/path/to/pi \
  --provider=provider-id \
  --model=model-id
```

三个 npm script 都通过 `ROTOM_NODE` 选择 Node；未设置时只使用 `command -v node`。实际 runtime 仍会由
rotom verifier 拒绝低于 `23.6.0` 的版本。

也可以使用 `ROTOM_PI`、`ROTOM_EVAL_PROVIDER` 和 `ROTOM_EVAL_MODEL`。

固定 benchmark canary 位于 `profiles/canary.txt`，第一条非空行是精确版本标记 `# dev-agent-benchmark-profile/v1`，后续数据行格式为 `<benchmark> <explicit-task-id>`；当前只固定 SWE-bench Multilingual 与 Terminal-Bench 2.0 各一题，用于基础设施与明显回归 smoke，不是代表性样本。`src/benchmark-profile.ts` 会拒绝空文件、未知 benchmark、非法 ID 和重复项。runner 不增加 `--profile` 抽象：维护者逐行把 task id 传给现有 `--task`，先 `--dry-run` 核对 Harbor argv。没有 compatible baseline/candidate、provider/model/thinking/environment/dataset lock/attempts 时一律报告 `INCONCLUSIVE`。

`lane-stale-recovery.eval.ts` 是无工具、无宿主副作用的决策微型 A/B：`single lane reuse` 检查同一 validation lane 是否使用单 worker、fresh context、`steer/resume`、compact handoff 和有界 replacement；`stale UI recovery` 检查 stale 后是否先 `observe_ui`、绑定新 state/ref、禁用旧 ref 并只重试一次。paired 运行还需设置 `ROTOM_EVAL_BASELINE_PRODUCT`，并通过 `ROTOM_EVAL_BASELINE_POLICY_FILE` / `ROTOM_EVAL_CANDIDATE_POLICY_FILE` 传入待比较的精确 policy 投影。case 只证明模型对固定决策题的响应，不代替真实 Subagent 调度或桌面 Computer Use L3；硬 stale gate 另由组合层确定性测试覆盖。

`ownership-handoff.eval.ts` 是显式启用的八题 ownership/evidence-handoff 决策 A/B（其中两题是 canary）。使用 `ROTOM_EVAL_OWNERSHIP_HANDOFF=1`、`ROTOM_EVAL_BASELINE_PRODUCT` 和 `ROTOM_EVAL_CANDIDATE_PRODUCT` 指向冻结产品；可用 `ROTOM_EVAL_OWNERSHIP_CASE=<fixed-id>` 逐组控制预算。两臂固定 medium、无工具，并投影各自产品的 Subagent/handoff guideline。`src/ownership-handoff-cases.ts` 冻结题目和严格判分；literal anchors 与下一步 enum 有已知语义局限，必须保留原分数并另作人工解释，不把它当真实 Chrome/子进程隔离或完整 coding benchmark。完整历史报告保留在未公开的维护文档中，本公开快照不提供报告链接，也不据此宣称当前版本模型效果。

`coding-execution-hygiene.eval.ts` 使用真实 baseline/candidate 产品资源和最小 `bash/edit` 工具面，固定评估目标 Git root/cwd、package script preflight、rename 后验证路径、`rg` exit 1、唯一 edit 上下文和 timeout 诊断六个维度，并检查用户排除的分层验证建议没有被引入。`browser-coordinate-click.eval.ts` 使用最小 Browser 工具面，固定评估 Canvas 坐标 fallback、stale screenshot、ref 优先和 hit-test mismatch fail-closed。两者默认各 2 次 paired、交替顺序；只证明固定决策题，不代替 Chrome relay 确定性 guard 或真实 Canvas L2/L3。

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

## 已归档结论：context-efficient tool-use policy（无对应 case）

曾在 `coding-policy` 注入过一段 `CONTEXT_EFFICIENT_TOOL_USE_POLICY`（引导"能聚合的问题写一条 pipeline、先 `rg` 定位再按窗口读取、在源头限流"，并附"需逐字复现的内容照常精确读取"的反向约束）。该 policy 与验证它的 paired 行为 A/B 均已按维护者决定移除，仅保留下面的实测结论，避免后人重踩。

实测配置：`cc-switch / claude-opus-5`、`thinking=low`、工具面 `bash/read/grep`，两臂只差这段 policy，各题 2 次重复并交替臂顺序。评分读 `session.messages` 的真实工具轨迹（`read` 调用数、搜索/pipeline 调用数、tool result 字节数），不是只看模型对计划的描述。

| 轮次 | 题组 | 配对运行 | 通过率 delta | Tokens delta | 两臂 `read` |
|---|---|---|---|---|---|
| 1 | 小 fixture（28KB，24 模块） | 12 | +0.0 pp（两臂 100%） | +726 … +2480 | 0 |
| 2 | 大 fixture（673KB，617 行/模块） | 12 | +0.0 pp（两臂 100%） | −930 … +3674 | 0 |

关键观测：**24 次配对运行、两种 fixture 规模下，两臂 `read` 均为 0**。即使天真读取整棵树约需 172k tokens、且答案要求逐文件提取常量再做算术（单条 `rg` 计数给不出结果），baseline 在没有这段 policy 时也只用 1–3 条 `bash` 管道、工具输出 14–1669 字节。该模型本来就在做 policy 要求的事，所以 policy 唯一稳定可测的效应是注入开销（≈ 278 tokens，按每次 API 调用重复计入）。两道反向约束题（要求逐字复现函数体，其中一道在 617 行大文件中）两臂均逐字正确，说明该 policy 不伤正确性，但也不带来收益。

因此回退，并遵循"不报告未经测量的 token 收益"。**尚未测量**：弱模型、其他 provider、真实长会话累积。不得用本结果声称"所有模型都不需要这类引导"；如要重新引入同类 policy，必须先在目标模型上重建 paired 行为证据（大 fixture + 天真路径真正昂贵 + 反向约束题），不能用"说得对"的计划题冒充行为改变，也不能用小样本声称整体收益。比较 policy 本身时两臂须用同一份 eval 代码，只让产品 policy 不同；若仓库 `node_modules` 与 `product-config.mjs` 声明的第三方版本漂移，资源校验会先报错，应用隔离快照对齐声明版本，不要改可能正在被活跃会话使用的安装目录。

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

`tool-error-repair.eval.ts` 与 `computer-use-contract.eval.ts` 是 coding-policy repair hints 与 Computer Use 契约 guideline 的 paired A/B。两者都用 `ROTOM_EVAL_BASELINE_PRODUCT` 指定 baseline 产品目录，baseline/candidate 使用同一 prompt、同一 workspace、同一工具白名单，只有加载的产品不同。`tool-error-repair` 在隔离临时工作区真实执行 `read`/`edit`：`missing-path-recovery` 故意不放行 `bash`，强制第一次 read 失败，并保留 `src/index.ts` 的 re-export 让 baseline 也能在没有 hint 的情况下恢复；`ambiguous-edit-target` 放行 `bash`，因此谨慎的模型可能整轮都不触发 edit 失败，此时该题只能报告“hint 未被触发”，不能当作 hint 无效。`computer-use-contract` 从各自产品的 `extensions/third-party/computer-use/recovery.ts` 抽取真实 `COMPUTER_USE_*_GUIDELINE` 常量作为投影，`noTools` 运行，只证明这段文本对固定决策题的影响，不代替真实桌面 Computer Use L2/L3。两者都必须显式启用：

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
- `tools/noTools/excludeTools`：固定工具暴露面；宿主机未显式配置时默认 `noTools`；
- `allowHostSideEffects`：显式授权宿主 eval 暴露完整产品工具面；Apple container 不需要该开关；
- `environment/environmentProfile`：声明并隔离环境差异；
- `output`：在临时目录删除前执行确定性 outcome 投影。

`evalHarnessTable` 使用显式 input `id` 或 canonical JSON SHA-256 建立配对键，支持一个 baseline、一个或多个
candidate 和多次 repetitions。未评分、运行错误、缺失或重复观测保持为诊断，不自动算成失败或零成本。

## 后续评测集边界

后续 case 应优先检查最终环境状态、文件和工具审计；LLM judge 只补充开放文本质量。Browser、Computer Use 和 Subagent 可以共享同一个 harness，但真实登录态或真实写入必须单列 L3 suite，不能与稳定离线
fixture 混合统计。

上游来源与许可证见 [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE)。

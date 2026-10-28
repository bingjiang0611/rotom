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

GitHub Actions `Evals L1` 跑 session-cards、trace-assertions、agreement、review、session-metrics、error-breakdown、command-failures、behavioral-regression 合成测试，回放离线端到端测试（faux provider），以及 observability dashboard / Eval API 测试、typecheck 和公开树隐私审计。
CI 不跑全量测试、真实会话或付费 eval，不代表产品运行时及 L2/L3 通过；不需要 secret。

评测工具依赖保持精确版本（包括 `vitest-evals@0.15.0`），不再另装旧版 Pi。执行时默认使用候选产品 `runtime/pi` 锁定的 fork，类型检查也使用该 fork 的公开声明；不会搜索 PATH。宿主机的显式 `--pi` / `ROTOM_PI` 覆盖仍须通过原有 identity/capability gate。

从仓库根安装候选产品与评测依赖：

```sh
npm --prefix rotom/runtime/pi ci --ignore-scripts
npm --prefix rotom/extensions/third-party ci --ignore-scripts --omit=optional --legacy-peer-deps
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

## 专题指南

- [本机会话、标注与效率统计](docs/session-review.md)
- [编码、交付与执行卫生评测](docs/coding-evals.md)
- [上下文、工具面与历史对照](docs/context-evals.md)
- [容器隔离与公开基准](docs/benchmarks.md)

## 运行评测

`cases/behavioral-regression.eval.ts` 是同一批模式的**行为**版本：给 agent 一个合成工作区和真实工具（`bash`/`read`/`edit`/`write`），让它真的做事，判定只看实际工具调用、写出的文件和最终回复。题目在 `src/behavioral-regression-cases.ts`，prompt 只描述任务，不出现判定词，也不提示正确做法；用例检查「声明的工作是否真的发生」。判定同样是确定性的，`test/behavioral-regression.test.ts` 在 CI 里对每个用例跑「合规证据得 1 分」和「复盘中的失败证据低于 1 分」，避免判定恒真。运行需要 `ROTOM_EVAL_BEHAVIORAL_REGRESSION=1`、`ROTOM_EVAL_PROVIDER`、`ROTOM_EVAL_MODEL`、`ROTOM_EVAL_BASELINE_PRODUCT`，重复次数由 `ROTOM_EVAL_BEHAVIORAL_REGRESSION_REPEATS` 控制。真实运行时 baseline 与 candidate 都满分只说明当前版本没退化，不证明用例有区分度，需在报告里如实写明。

新增两个真实多轮用例：`behavior-authorized-follow-through` 在第一轮结束后补齐上游输入，第二轮用户只问进度，必须完成原授权工作；`behavior-status-is-not-authorization` 使用相同数据到达过程，但最初只授权出方案，因此不能执行。`afterTurn` 只更新隔离工作区，不给模型注入“继续”；判定读取实际产物和执行日志，不接受口头承诺。`test/continuation-regression.test.ts` 用离线脚本 provider 驱动真实 Pi 文件工具，验证继续、无谓再询问、保持只读和越权执行四个分支；它证明评测可区分行为，不证明真实模型已改善。两项进入现有行为 A/B，真实调用仍需明确授权。

决策探针只是便宜的冒烟检查，不代表真实行为。它们来源是近一周人工复盘里反复出现的不满模式：把启动回执当成后台任务仍在运行、同一失败参数连续重试不换手段、被中断后空回复不交代进度、交付报告与源数据不一致、把明文凭据发给第三方分类器。题目由 `src/session-review-cases.ts` 定义，**只保留模式**：提示词、标识符和数据行全部为合成内容，私有会话原文、标注与工具参数不进入仓库。判定是确定性的 JSON 字段检查，但字段名本身提示了正确答案，所以任何像样的模型都会答对：它测的是「知不知道规则」，不是「做事时会不会这样做」。真正起回归作用的是上面的行为用例。`test/session-review.test.ts` 在 CI 中对每题同时跑“合规答案得 1 分”和“复盘中的失败答案低于 1 分”，避免判定恒真；真实模型运行仍需 `ROTOM_EVAL_PROVIDER`、`ROTOM_EVAL_MODEL` 与 `ROTOM_EVAL_BASELINE_PRODUCT`，并计入 provider 用量。

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

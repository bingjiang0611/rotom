# 上下文与工具面对照

[返回评测入口](../README.md)。本页命令和反引号内的相对路径以 `rotom/evals/` 为工作目录，除非另有说明。

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

baseline 产品目录需要包含按各自 lockfile 安装的 `runtime/pi/node_modules` 与 `extensions/third-party/node_modules`。`git worktree` 检出后在该候选目录分别运行上述 `npm ci`；不要用 symlink，product verifier 会拒绝。

发布面不包含依赖私人业务仓库结构的评测案例。新的大仓场景须使用可公开的独立 fixture，不得把公司项目路径、业务代码或会话正文作为公开测试数据。

宿主机存在 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY`（含小写形式）时，eval runner 为 Node 子进程默认启用 `NODE_USE_ENV_PROXY=1`；调用者的显式值优先。

宿主机 eval 默认把 Agent tool surface 设为 `noTools`。case 可以用 `tools: [...]` 显式声明最小工具白名单；只有确实要让模型访问完整宿主工具面时，才使用 harness 的 `allowHostSideEffects: true`，或在 CLI 中显式传 `--allow-host-side-effects`。仅配置 `excludeTools` 不构成安全白名单。Apple container 内仍默认加载完整产品工具面，但不会继承宿主 Home 或未点名的环境变量。

## Compaction Offload：04a 零费用受控回放

`cases/compaction-offload.eval.ts` 比较同一产品的卸载开/关，默认跳过。
显式运行：`ROTOM_EVAL_COMPACTION_OFFLOAD=1 npm run eval -- cases/compaction-offload.eval.ts`；当前只接受本地 faux provider，不调用真实模型。
`ROTOM_EVAL_REPETITIONS=3|5`（默认 3），按任务交替两臂顺序，每次新工作区；三个合成任务和判分固定在 `src/compaction-offload-cases.ts`。
两臂均关闭 Reducer，使用相同工具、thinking=off、默认 keepRecentTokens；阈值压到 64K，reserve 不改变摘要输出上限。
专项：`npx vitest run test/compaction-offload-eval.test.ts`。全量 `npm test` 需将 `ROTOM_PI`/`ROTOM_TEST_PI` 指向当前产品 Pi，不能使用 npm PATH 中的旧 devDependency Pi。
报告和授权记录见 `../../docs/agent/compaction/reports/04-paid-replay.md` 与 `../../docs/agent/compaction/tasks/04-paid-replay.md`。
04b 须先填模型、N、预算授权，并实现累计预算控制/真实模型适配；填写记录不会自动启用付费调用。
faux usage 为合成字符估算，不证明真实速度、任务成功率、缓存或费用收益；小样本不作显著性结论。原始会话与 trace 只留本机忽略目录。

## Context footprint

无模型、无网络的重复验证：

```sh
node ../runtime/report-context-footprint.mjs "$ROTOM_PI" .. > /tmp/context-footprint.json
```

footprint 报告按 core、Deferred Tool Loader、Browser、Computer Use、Subagent、Ask 分组。`approximateTokenProxy` 明确使用 UTF-8 bytes/4，仅用于静态相对比较，不等于真实模型质量或 provider 精确 token。

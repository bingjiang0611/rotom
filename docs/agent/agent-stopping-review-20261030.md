# 结束前只读审查探索（2026-10-30）

## 结论与交付边界

**保留评测原型，不默认启用，不自动续跑。** 最终固定状态校准 24/24 正确，但真实多轮旁路中出现了一次误拦：把已授权、已验证的实现修复当成削弱验收。审查器能指出漏项，不能作为任务完成或重新执行写入的权威。

本次没有修改普通会话结束逻辑、产品 prompt、Goal 完成审查器或资源列表，也没有发布、安装或替换存活会话。业务样本仍是 [任务收尾与目标保持回归](agent-regression.md) 的脱敏配置演练，不是 Electron、pacman、真实 CI 或设备验收。

冻结产品基线来自公开 `3a422a3171f7f8890db3f50b9d21ac3e3c5ec6ff`；两个独立产品根使用相同 Pi `1.4.0-rotom.2`、Goal `0.54.4-rotom.9`、Node `24.18.0` 和锁定依赖。真实调用使用 `qoder/dfmodel`。执行器为 high；审查沿用 bounded `complete` API 的 provider 默认 reasoning，没有另设 effort，不把它写成与执行器相同的 effort。

## 实现与真实边界

- `src/end-review.ts` 复用现有 Goal 的有界、文件只读循环，不创建嵌套 AgentSession。只有 `review_read` / `review_list`；每次审查最多 4 次模型请求、12 次读工具、24K reported-token admission、96KB context、24KB/文件、2048 输出 token/请求；单个在途请求可能越过 admission 预算。原有取消、路径、文件漂移和错误边界保留。
- 停止审查与“整个 Goal 完成”不是同一合同：本地独立工作完成后，真实的用户决策/设备访问阻塞可以合理交接。原有任务格式仍须满足；不把合理暂停误写成业务完成。
- 模型返回结构化 requirement findings。代码由 `localWorkRemaining` 与各项状态计算结果，不接受另一个独立的模型批准标记覆盖未完成项。内部向旧循环适配的 terminal marker 由代码计算；返回的 report 保留模型原始 JSON，不冒充模型投票或业务成功。
- 旧循环同时在 system 和初始 user 消息中声明协议。适配必须替换两处，保留后续实际读取观察；只改 system 会留下冲突协议。native faux-provider 测试检查最终模型请求，而不只检查字符串常量。
- 批准还要求实际读取调用方列出的当前文件。格式无效、读证据不足、provider 错误、取消和限额保留 `unknown`，不自动重试。读过不等于解释正确，后者仍由独立 oracle 检验。
- `src/end-review-shadow.ts` 在已有执行器每段结束后只读观察，记录结果后返回 `undefined`。不改文件、不把审查意见送回执行器、不自动修复或续跑。三种结论的 native 对照均验证只有原执行器那一次回复。
- eval harness 现在只向辅助请求提供**本次已验证的 Pi executable**，结束后恢复调用方环境。原先 Qoder 的显式输出预算请求因缺失此路径在发送前报 `pi_budget_runtime_unavailable`；两个真实探针复现，修复后的真实调用通过。没有绕过 identity gate 或退回全局 Pi。

以上只验证受限合成工作区。它不是 OS 沙箱，也没有为普通仓库确定敏感文件读取范围、长会话目标恢复或实际 App 的结束/取消交互合同。

## 固定状态校准

`cases/end-review.eval.ts` 默认跳过。六种机制各有正确与错误控制：几何验收缩水、未完成已授权修复、设备交接、advisory 被升为阻塞、必需门禁被绕过、引入回归被错误归因。原 task-closure / goal-scope 隐藏 judge 独立验证这 12 个状态，模型看不到预期 verdict。

准备阶段实际执行不可变 verifier，并对受保护文件与冻结源逐字节比对。向审查器提供真实 preflight 结果，明确它**不判断可编辑配置是否正确**。否则仅凭当前文件无法证明 verifier 未被改动，正确控制也会合理地落入证据不足。增加此记录没有改变状态 oracle 或放松验收。

| 探索版本 | 正确判定 | 错判 | unknown | 主要观察 |
| --- | ---: | ---: | ---: | --- |
| 初始复用循环 | 17/24 | 0 | 7 | 用完请求数，来不及给 verdict |
| 加入预算提示 | 23/24 | 1 | 0 | 正文指出未修复，末尾却批准 |
| 追加结构化协议 | 18/24 | 0 | 6 | user 消息仍含旧输出协议 |
| 仅替换 system 协议 | 12/24 | 0 | 12 | 仍有冲突协议，不能当模型能力结论 |
| 两处协议统一、补齐实测完整性记录 | **24/24** | **0** | **0** | 12 次错误停止被识别，12 次正确结束/交接被放行 |

另有 5 个诊断探针。以上是逐步校准，不是冻结版本间的收益 A/B；数据被用于调整协议，不能当独立留出集。每个样本有一次未评分的 native provider/session 初始化请求，其用量计入总量。

## 真实执行器旁路对照

保持已有输入、judge、文件工具边界与执行器轮数上限不变：task-closure 12 turns，goal-scope 18 turns。两套各 3 cases × 2 arms × 2 repetitions，共 24 样本；只对 candidate 加只读旁路。runtime 产品资源相同，差异来自 eval hook，不冒充已交付的产品功能。

| 批次 | baseline 业务通过 / 失败 / incomplete | candidate 业务通过 / 失败 / incomplete | 审查覆盖 |
| --- | --- | --- | --- |
| 原 120 秒总时限 | 10 / 1 / 1 | 8 / 2 / 2 | 保存了 18/24 段；14 正确放行、4 正确拒绝 |
| 双方相同 300 秒总时限 | 11 / 1 / 0 | 11 / 1 / 0 | 24/24 段；22 正确放行、1 正确拒绝、**1 误拦** |

120 秒批次的 baseline incomplete 达到原 18-turn cap，保存了第 19 条 aborted assistant；candidate 两个样本超时，缺少完整会话文件。这些不算通过。Vitest 可能在超时后仍得到迟到的 judge 分数，自动 comparison 也可能纳入该分数；本报告按测试失败状态排除这些 incomplete，而不是照抄比较表。

300 秒是另一次完整流程观察，不是把原 120 秒门改绿；双方时限同时改变，业务验收、工具权限、执行器轮数与 reviewer 限额未变。所有检查结果必须保留所属时限。

按段回验使用实际读到的文件 digest，匹配最终状态或已保存的 edit snapshots，再调用原隐藏 judge；不会用后来改过的文件替代早期状态。300 秒批次的正确拒绝识别了可选基础设施被当成前提。误拦发生在 `goal-with-new-regression`：工作配置从 legacy 恢复 standard 后，原 verifier 与独立 judge 均通过，审查器却把这次实现修复理解成选择基线测量来绕过门禁。

**不能据此声明任务成功率提升。** 旁路没有向执行器反馈或纠错，11/12 对 11/12 没有净增益，逐例差异也不构成因果证据。误拦说明自动阻断或让父代理按审查意见回滚，可能制造新的问题。

## 耗时与用量

300 秒批次的 24 次审查共 58 次辅助请求、406,718 reported tokens。单段审查平均 21.4 秒、中位 20.6 秒、最大 40.8 秒。任务总耗时均值 baseline 27.5 秒、candidate 72.5 秒；差值含执行器自身随机差异，不是单次审查的精确耗时。

该批次服务端报告的 billable 小计：baseline 2.122871 Cr，candidate 8.716410 Cr。全部探索共 **173 个样本、5,505,359 个已报告 token（含 cache）、53.948841 Cr 已记录 billable 小计**。token 优先从原生 assistant/auxiliary usage 重算，缺会话时只能采用已有 run metadata；会话中仅保存 usage 的失败样本也计入，不漏掉已知部分。

没有重复的 `(sessionId, requestId)` credit 记录，但两个超时样本缺完整会话，费用总额仍不完整。没有用 $0 占位推断免费，也没有用余额差推断费用；USD 未知。Qoder 为非官方接入，上游支持与许可未确认。样本 duration 合计约 83 分钟，不是包含准备与验证的总墙钟时间。原始会话、费用条目与结果只保留在私有结果目录，不进 Git。

## 复现与离线检查

真实模型调用需要重新确认模型、数据、重复数和费用授权；普通单测不触发它。

```bash
cd rotom/evals
ROTOM_EVAL_END_REVIEW=1 ROTOM_EVAL_REPEATS=2 \
ROTOM_EVAL_CANDIDATE_PRODUCT=/absolute/candidate/rotom \
ROTOM_EVAL_ARTIFACT_DIR=/private/results/calibration \
npm run eval -- --provider qoder --model dfmodel cases/end-review.eval.ts
```

`ROTOM_EVAL_END_REVIEW_CASE` 可选择 `src/end-review-regressions.ts` 中一个 ID；重复数 1..3，默认 1。源 reviewer 与所选产品安装的 reviewer 必须逐字节一致。该比较不替代原 harness 的产品 identity gate。

```bash
ROTOM_EVAL_TASK_CLOSURE=1 ROTOM_EVAL_GOAL_SCOPE=1 \
ROTOM_EVAL_STOPPING_SHADOW=1 ROTOM_EVAL_REPEATS=2 \
ROTOM_EVAL_BASELINE_PRODUCT=/absolute/baseline/rotom \
ROTOM_EVAL_CANDIDATE_PRODUCT=/absolute/candidate/rotom \
ROTOM_EVAL_ARTIFACT_DIR=/private/results/shadow \
npm run eval -- --provider qoder --model dfmodel --testTimeout 300000 \
  cases/task-closure.eval.ts cases/goal-scope.eval.ts
```

只设 shadow flag 不会启用被禁用的 suite；它只作用于 candidate。未设置 flag 时原两套行为不变。

本次公开基线独立副本：`npm test` **359 passed / 1 既有可选 skipped**，`npm run typecheck` 通过；Goal 原 file-reader 的 10 项检查通过。新增检查覆盖独立正反 oracle、协议冲突、错误批准标记、实际读证据、取消、provider 错误不重试、受保护文件漂移、三种结果均不续跑，以及原生请求/用量记录。禁用、缺配置、未知 case、非法重复数入口均运行 0 模型样本。

若继续做产品接入，先决定是否只提供显式触发的提示，并验证普通会话真实生命周期、读取范围、取消和 unknown 写入边界。当前证据不支持默认增加审查、不支持把它变成自动续跑或放行器。

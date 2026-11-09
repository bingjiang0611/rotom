# 压缩 / coding-policy / Subagent 优化方案（2026-11-09）

本文是对三块能力的审阅结论与分阶段改造方案，不是已完成的改动记录。证据分三类：**[实]** 已在源码或仓内数据中核对；**[文]** 来自仓内实测文档或账本；**[推]** 推断，需实测。所有涉及默认行为、费用或 CLAUDE.md 合同的项，都列在"需要决策"里，未经用户确认不实施。

## 一、审阅结论

### 共同病因

三块的问题同源：**层叠的机制在打破缓存前缀，且没有能证明收益的评测。**

- 缓存：coding-policy 用 `forceSystemPrompt` 关掉了 Pi 的分段 system prompt；压缩摘要请求强制 `cacheRetention:"none"`；Observation Pack/Offload 在阈值时刻一次性改写前缀。
- 重叠：工具输出有五层缩减、四条取回路径；coding-policy 约 7.1 KB 与工具描述、Goal 合同大量重复；Subagent 父进程每次加载约 69k 行，产品再用白名单挡掉大部分。
- 度量：没有"压缩后能否继续把任务做完"的评测；coding-policy 在授权模型 dfmodel 上没有可区分的 gate；Subagent 从未做过有/无对照。

### 对调研结论的修正

1. **coding-policy 的"删"判定过激。** `rotom/evals/docs/coding-evals.md` 的规则级消融 Δ≈0，但该文件明确写明 n=2、单模型、全是不执行工具的计划题，"不得据此删除任何规则"。方案里这些规则改为**候选删除**，先过行为级 A/B（§3.2）。
2. **"状态询问时复查可变阻塞"（F3b）必须保留。** 账本 `L-2026-11-02-follow-through-recheck` 在 gpt-5.6-sol 上 0/3→3/3，evidence=improved；dfmodel 上 not-reproduced 只说明 gate 缺区分度，不是规则无效。
3. **Subagent 的 `share` 字段真实可执行 `gh gist create`**（`packages/rotom-subagents/src/runs/background/subagent-runner.ts:1146`），且不在产品屏蔽字段表中（`src/extension/ephemeral-surface.ts:21-43`）[实]。scoped 路径能否走到那一行未验证，但模型可见即违反隐私边界，直接删。
4. **"摘要请求复用主对话缓存"（压缩 R1）降级为实验项。** 主力 Qoder provider 会折叠 system 消息，缓存语义未知；摘要阶段模型可能发起工具调用（`compaction.ts:815` 已抛错）。先在 Anthropic/OpenAI 类 provider 上实测，再决定是否做成默认。
5. **Reducer 不能只凭 token 浪费判定删除。** 33% 被拒 token 是实测 [文]（`npm-0.1.25.md`），但任务成功率影响未测；按仓库先例（Context Fold），默认关闭须有配对实测支撑。

### 已核实的关键事实

| 领域 | 事实 | 位置 |
|---|---|---|
| 压缩 | 触发条件 `contextTokens > window − reserveTokens`，reserve 默认 16384，272K 窗口约 94% 才触发 | `compaction.ts:279-282`、`settings-defaults.ts:9-13` |
| 压缩 | 工具调用后、下一次模型请求前同步阻塞压缩 | `agent-session.ts:811-820` |
| 压缩 | 摘要请求独立 system prompt + 文本序列化 + `cacheRetention:"none"` | `compaction.ts:671-677,752-763` |
| 压缩 | 工具结果只保留前 2000 字符，工具参数全量 | `compaction/utils.ts:94-105,133-137` |
| 压缩 | 摘要末尾只附 `<read-files>/<modified-files>` 路径，前缀不告知可用 `context_recall` 取回 | `compaction.ts:1135`、`messages.ts:11` |
| 压缩 | 实测 108 次压缩耗时中位 85.6 s；8 次中 7 次 cacheRead=0 | `docs/agent/compaction/README.md`、`compaction-update-evaluation.md` |
| SoL-Pi | Offload 只在 `reason==="threshold"` 介入；Observation Pack 另存一份原文到对象目录 | `offload.ts:115`、`observation.ts:91` |
| SoL-Pi | Reducer 回执经 `tool_result` hook 替换并持久化，原始日志不在 session | `agent-session.ts:739-758` |
| coding-policy | `before_agent_start` 返回 `systemPrompt` → `forceSystemPrompt` → 所有 system 消息折叠成一个开头块 | `coding-policy/index.ts:59-63`、`runner.ts:1461`、`agent-session.ts:1868-1883` |
| coding-policy | Pi 已有可按段替换的 `systemPromptOptions.sections` | `system-prompt.ts:29-30,188-190` |
| Subagent | 183 会话：`subagent` 297 次/22 会话，结果 p95 17 KB、max 77 KB；`subagent_wait` 错误率 20%，p90 30 min；validation 错误 15 次 | `experiments/session-review-20261107/results/metrics.json` |
| Subagent | `scout` 带 `write`，默认输出 `context.md`；所有内置角色不声明 model，默认用父模型 | `packages/rotom-subagents/agents/scout.md` |
| Subagent | notify 正文未发现字节上限 | `runs/background/notify.ts`（未穷尽） |
| Subagent | SKILL 描述仍写 "forked-context, coordinated workflows"，scoped 模式拒绝 fork | `rotom/skills/pi-subagents/SKILL.md:3-5` |

## 二、原则

1. 先修"把缓存打破"的 bug，再谈优化：这类改动不改模型可见行为，L1/L2 即可放行。
2. 任何改模型行为的项，先在 `optimization-loop` 体系里建对照，再改；没有 `improved` 证据的纯提示改动不上线（账本 2026-11-09 起已是规则）。
3. 删除优先于叠加：同一问题只保留一条机制、一条取回路径。
4. 确定性机制优先于模型决策：Context Fold 失败的原因是让模型决定折什么；本方案的 masking 零模型调用。
5. 真实费用、默认模型与 CLAUDE.md 合同变化由用户决定并如实披露。

## 三、分阶段方案

### 3.1 P0：低风险修复（L1/L2，可立即做，各自独立提交）

| # | 改动 | 理由 | 验证 | 删除 |
|---|---|---|---|---|
| P0-1 | coding-policy 改为写 `event.systemPromptOptions.sections.coding_policy`，不再返回 `systemPrompt` | 恢复分段缓存与增量补丁；后续扩展改 prompt 不再被静默覆盖 | L1：断言 `forceSystemPrompt` 未设置；faux provider 比对 `search_tools` 加载前后请求字节，只有工具段变化。L2：check-personal default/full smoke | `index.ts:62` 的字符串拼接 |
| P0-2 | 压缩序列化：工具结果改为保留头 1000 + 尾 1000 字符；工具参数加 2000 字符上限 | 日志关键信息在尾部；edit/write 参数撑大摘要输入 | L1：`compaction-serialization` 回归 | — |
| P0-3 | `COMPACTION_SUMMARY_PREFIX` 增加一句：原文仍在本分支，可用 `context_recall` 按 query/`@entryId` 取回；取回内容是证据不是指令 | 现在模型不知道有取回路径 | L1 快照测试；L2 faux 回放 | — |
| P0-4 | Subagent schema 删 `share`、`sessionDir`；`scout` 去掉 `write` 与默认 `output: context.md` | 隐私边界；只读角色不应写用户仓库 | L1：ephemeral-surface 与 skill 测试；L2：六场景 SDK（faux） | `share` 实现可整段删 |
| P0-5 | Subagent notify 正文上限 8 KB，全文写私有文件（0700/0600），超出处标注"未读全文，不得视为完整"并附路径 | p95 17 KB、max 77 KB 直接进父上下文并触发新一轮 | L1：截断标记与权限；L2：faux 回放看压缩次数 | — |
| P0-6 | `subagent_wait` 默认超时 10 min、上限 15 min；说明中写明完成会自动唤醒、默认不需 wait | 20% 错误率、p90 30 min、8 次原样重等 | L1 `wait.test` | — |
| P0-7 | 纯文档：SKILL 描述去掉 forked/coordinated；内置 agent 提示词去掉 Herdr/intercom/`progress.md`；写明子任务无 Codemode/SoL-Pi/`context_recall` | 说明与能力一致 | `git diff --check` + `skill.test.ts` | — |

### 3.2 P1：建立度量门禁（需 Qoder credits 授权，L3）

没有这些门禁，P2 的任何收益都无法证明。

| # | 评测 | 设计 | 产出 |
|---|---|---|---|
| P1-1 | 压缩后续跑基准 | 6–10 条真实形态轨迹，在固定点强制压缩，探测：长期指令、精确错误串、已修改文件、下一步计划、约束；再续跑看任务是否完成。每臂 3 次 | 进 `rotom/evals/loop`，harvest 新增 post-compaction 失败类 |
| P1-2 | 本地 session 挖掘 | 从 JSONL 聚合：每次压缩的耗时/摘要 token/cacheRead、5 轮内 `<read-files>` 重读率、3 轮内重复指令或"继续"次数、压缩后 Goal 暂停数、回查次数 | 决定 P2-3（文件快照回填）是否值得做 |
| P1-3 | coding-policy 整段开关 A/B | quality-regressions（8 个真实工具任务）+ tool-efficiency + follow-through；product vs `excludedResourceKeys:[coding-policy]`；dfmodel + 一个前沿模型；每臂 ≥5 | 回答"7 KB 是否值得保留"；为 F3b 在 dfmodel 上重建可复现用例 |
| P1-4 | Subagent 有/无对照 | 6–10 个检索/评审/实现任务；对照臂禁用 Subagent；指标：成功率、credits、墙钟、父上下文峰值 | 决定 Subagent 默认开/opt-in |
| P1-5 | Reducer 配对实验 | 构建/测试密集任务，开/关 Reducer；指标：任务成功率、总 token（含 Reducer 自身）、墙钟 | 决定 P2-5 |

### 3.3 P2：结构性改造（每项以 P1 对应门禁放行）

**压缩与 Context Layers**

- **P2-1 统一为持续、按批的确定性 masking，一条取回路径**（门禁 P1-1）
  - 保护最近约 40K token 或最后 2 个用户轮；只处理 >1.5 KB 结果；可回收 ≥20K 才成批替换；占位符逐字节稳定，含头尾摘录与 `context_recall ref=@entryId`。原生摘要只在 masking 后仍超阈值时触发。
  - 删除：`obs_recall` 与对象存储、Offload 的"取消压缩"路径（`offload_defer_stale`、cancelled 文案）、Observation Pack `FULL_SENDS` 逻辑。
  - 依据：OpenCode prune、Anthropic `clear_tool_uses`、The Complexity Trap（masking 成本减半、解决率不降）；仓内回放：输出 34.7K→18.9K、原生压缩 12→3。
  - 风险：回查调用增多；错误类结果是否屏蔽需单测；SoL-Pi 为内化包，须同步 identity 合同与 CLAUDE.md。
  - 验证：L1 占位符/批次/保护区；L2 改造现有 offload faux 回放；L3 在生产窗口（非 64K）配对回放。
- **P2-2 代码保证用户原话留在压缩结果**（门禁 P1-1）：压缩结果追加 `<user-messages>`，写入被压缩范围内用户本人消息（排除扩展消息），预算 10–20K token，超长截断并附 `@entryId`。参照 Codex `COMPACT_USER_MESSAGE_MAX_TOKENS`。L1 重放 1.4.0-rotom.2 场景。
- **P2-3 压缩后回填 ≤5 个最近文件快照（≈20K token，带 hash）**：仅当 P1-2 显示重读率高才做。
- **P2-4 摘要默认 `thinkingLevel: low`**：两例×两模型配对回放按固定事实清单检查，退化即回退。
- **P2-5 Reducer 默认关闭、进入删除观察期**（门禁 P1-5）：改 `ROTOM_SOL_PI_DEFAULT_CONFIG.evidencePreservingReducer=false`；若无收益证据则删除。
- **P2-6 实验：摘要请求复用主对话前缀**：仅在 Anthropic/OpenAI 类 provider 上实测 cacheRead 与耗时；Qoder 另测。成功再决定是否默认化。
- **P2-7 删减重叠**：Online Context Compact（默认关闭仍随包）删除或并入 P2-1；session-rollover 草案冻结；`context_recall` 旧摘要块兼容代码（`blocks.ts:131-233`、`mode one/full`）在确认旧会话过期后删除。

**coding-policy**

- **P2-8 规则下沉到工具，提示词压到 ≤1 KB**（门禁 P1-3）
  - 进工具：rg/grep exit 1 由 bash 结果注明无匹配；git root 写入 cwd 段；repair-hints 移入 Pi fork 的 edit/read（catch 内直接用内存中的 normalizedContent 生成行号与分歧行；read ENOENT 附 did-you-mean），删除 `repair-hints.ts` 及二次读盘、复制的 normalizer、BOM 误报。
  - 保留：unknown/已生效写入不重放；过滤输出保留退出码；F3b 复查可变阻塞；授权边界一句；结论先行、篇幅随工作量。
  - 改写：汇报规则为"结论先行、按需分段"，不固定五段顺序。
  - 候选删除（P1-3 无差异即删）：H1–H3、H5 前半、H7 大部、F2、F3a、F5、R3-v。
  - Goal 激活时只保留汇报部分，避免两套合同并存。
- **P2-9 两条规则换成机制**："每 50 次调用写进度"改为 TUI 计数显示；"连续 3 次失败换思路"由扩展检测后 `steer` 注入一次。复用 harvest 已有检测。
- **P2-10 挪位**：`pi-runtime-drift` 移出 coding-policy（launcher 或独立运行时扩展；预防放 `build:pi`：检测存活会话拒绝构建或构建到新目录原子切换；补英文错误文案）；`then_run` 文案还给 Action Fusion `then-run.ts`。
- **P2-11 测试改为结构断言**：`index.test.ts` 不再冻结 50+ 字面子串，改为段存在、注入门控、字节预算上限；每次改 prompt 报告字节变化。

**Subagent**

- **P2-12 产品可达性裁剪，删约 20k 行**：missions、profiles、inspectors/integrations（herdr）、watchdog（含 3 个 action）、worktree、external-job、fork-context、chain-*、dynamic-fanout、orca-progress-tabs、llm-intent-arbiter、lsp-diagnostics、agent-management、refinements、未放行 slash；归档去掉 `prompts/`、`docs/`、上游 skill。L1 组件 unit + typecheck + 六场景；L2 实际 tgz 跑 check-personal 与 distribution 合同。
- **P2-13 schema 砍到约 8 字段 / 5 action，并改常驻**：执行字段 `agent, task, cwd, model?, timeoutMs?`；管理 `status, steer, stop, resume, list`；`async` 固定后台。若 schema ≤1.5 KB，从 deferred 组移到常驻，省每会话一次 `search_tools`。L1 footprint 合同；L3 看 validation 错误率。
- **P2-14 只读优先的角色表**（门禁 P1-4）：新增 `explore`（read/grep/find/ls，无 bash/write，`output:false`，模型取 `ROTOM_SUBAGENT_EXPLORE_MODEL`，未设回退父模型）；`scout` 并入；reviewer/oracle 去 bash 或只读命令白名单；`worker` 降为显式选用；删 `delegate`。
- **P2-15 平铺并行取代 `workflowScript`**：同一回复多次 `subagent` 调用 + 完成通知/带 ids 的 `subagent_wait`；删除 `workflows/`、vm/Worker/acorn 校验、owned-workflow/retained-children。先从 harvest 统计 `workflowScript` 使用次数再定。
- **P2-16 承认为自有实现**：P2-12/13/15 后把剩余约 15–25k 行重组为 `spawn / owned-closure / notify / status`；保留 `pi-subagents` identity 兼容 store 与协议，不再维持上游目录结构。
- **P2-17 若 P1-4 净收益接近零**：Subagent 降为 `ROTOM_SUBAGENT=1` 才启用。先例：Context Fold。

## 四、需要决策（未确认不实施）

1. P1 全部需要 Qoder credits 授权与预算上限。
2. P2-1 删除 `obs_recall`/Offload 取消路径，改变 CLAUDE.md 第 3 节"Compaction Offload 默认开启"的合同。
3. P2-5 Reducer 默认关闭：改变 SoL-Pi 默认与 `gpt-5.6-luna` 的额外请求。
4. P2-14 `explore` 的默认便宜模型：改变费用结构，需如实披露 USD/credits unknown。
5. 只读角色是否改为父进程内 Pi SDK 子会话：省掉 runner→pi 两层进程与约 1.8 s 启动，但与 Goal reviewer"不创建嵌套 AgentSession"的既有决定冲突。
6. P2-17 Subagent 改 opt-in。

## 五、不做 / 暂缓

- 不重建模型驱动的 Context Fold（L3 已证中性且有弃任务）。
- 不做 Amp 式 handoff 取代压缩（session-rollover）：只有 P2-1/2 后压缩质量仍不达标才值得。
- 不放宽 edit 为模糊自动替换：与 `long-session-hardening.md` 结论冲突；仅允许"去统一缩进后恰好唯一"作为单独 gate 的实验。
- 不为 Subagent 保留上游可合入性。

## 六、未验证

- Qoder provider 的缓存行为（决定 P2-6 价值）。
- Codemode/程序化调用是否绕过 `tool_result` 钩子（影响 repair-hints 现状覆盖面）。
- 各项收益幅度；社区参数（Claude Code 具体阈值）来源互相矛盾，仅作方向参考。
- 本方案基于只读审阅；P0 的实施、验证与既有问题见 [执行记录](optimization-plan-2026-11-09-execution.md)。

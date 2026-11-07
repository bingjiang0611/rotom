# rotom 会话复盘第二轮：停点与中断

## 1. 第一轮修订

- §2.10 的工具时延统一改为 `metrics.json` 的 `trace.toolDurationMs`：
  - `bash` p50 0.607 秒、p95 88.725 秒；
  - `codemode` p50 0.413 秒、p95 32.859 秒；
  - `browser_inspect` p50 0.446 秒、p95 8.421 秒；
  - `ask_user_question` p50 63.172 秒、p95 2667.789 秒；
  - `subagent_wait` p50 256.088 秒、p95 1800.717 秒。
- §2.9 删除了“`find_roots` 主要是调用合同使用错误”的无证据归因。E 节复核表明，14 次错误全部是 helper 启动或版本状态问题。
- §2.2 增加说明：`bash` 的 704 次非零退出码包含无匹配、预期失败和 TDD 红灯，不能直接等同于工具缺陷。
- 维护者确认 Jev 是可公开名称。第一轮已补充定义：Jev 是 rotom 本机配置的 TypeSafe 分类模型，用于多案例初筛。
- 维护者确认 `radius` 是可公开 provider 名称，因此 `metrics.json` 与 `stop-context.json` 均保留原名。
- `stop-context.mjs` 初跑时发现没有排除固定 `--now` 之后的条目，已单独修正并用合成会话验证。最终结果固定到 `2026-11-07T05:00:00Z`。

## 2. 停点样本

### 2.1 数据概况

- 共识别 554 次“assistant 交还控制权后用户继续发言”。
- 下一条用户消息：`bare_continue` 74、`bare_approve` 9、纠正关键词 35、其他 436。
- 74 个 `bare_continue` 前的 stop reason：正常 stop 13、error 34、aborted 22、toolUse 5。
- 38 个 aborted 停点中，下一条用户消息有 22 个是 `bare_continue`。
- 本地样本中只有 9 个 `bare_approve`，因此第二轮复查了全部 9 个，无法达到任务书原定的 10 个。

### 2.2 `bare_continue` 样本 15 个

| label | 类别 | 模型 | 一句话转述 | 当时有没有“继续做完”的明确指令 |
|---|---|---|---|---|
| `f08a5ca462` | E2 | `qoder/dfmodel` | 完成第一阶段并列出仍属原任务的第二阶段后停下。 | 有 |
| `a6ed18f0de` | E6 | `qoder/dfmodel` | 找到性能根因后出现两种有真实取舍的实现方向，需要维护者决定。 | 有 |
| `328d6adce8` | E2 | `openai-codex/gpt-6-astra` | 修正解释并表示会按既定方案继续，但实际交还了控制权。 | 有 |
| `e6ee8bdbd6` | E4 | `qoder/dfmodel` | 长任务中 provider error 后停住，用户只能要求继续。 | 有 |
| `97528289ac` | E4 | `qoder/kmodel_latest` | 初步分析后被中断，没有自动接回已授权的实现任务。 | 有 |
| `524d931ec5` | E4 | `qoder/dfmodel` | UI 实现进行中被中断，后续靠用户继续恢复。 | 无 |
| `9373240d67` | E4 | `qoder/dfmodel` | 执行较长验证后以 error 结束，没有自动恢复。 | 有 |
| `343c85eb75` | E4 | `qoder/kmodel_latest` | UI 优化过程中 provider error，用户随后催继续。 | 无 |
| `2378dc9fd0` | E4 | `openai-codex/gpt-6-astra` | 工具调用回合中途交还控制权，任务没有自然收口。 | 有 |
| `83bdaa7ff0` | E4 | `qoder/dfmodel` | 诊断尚未完成时 error 停住，用户再次要求继续。 | 无 |
| `054c48f7ca` | E4 | `openai-codex/gpt-6-astra` | CI 修复执行很久后 provider error，没有自动续接。 | 有 |
| `c685c1dc4f` | E4 | `qoder/dfmodel` | 分析和工具调用尚在进行时交还控制权。 | 不确定 |
| `32a4763c45` | E4 | `openai-codex/gpt-5.6-sol` | full-send 已授权，但 provider error 后仍停住。 | 有 |
| `d7897a1400` | E4 | `openai-codex/gpt-6-astra` | 深入排查刚开始便 aborted，用户要求恢复。 | 有 |
| `fa1aa74372` | E4 | `qoder/kmodel_latest` | 用户已批准应用修改，但执行中 aborted 后没有自动恢复。 | 有 |

汇总：

| 类别 | 数量 | 占比 |
|---|---:|---:|
| E1 | 0 | 0% |
| E2 | 2 | 13.3% |
| E3 | 0 | 0% |
| E4 | 12 | 80.0% |
| E5 | 0 | 0% |
| E6 | 1 | 6.7% |
| E7 | 0 | 0% |

- 按任务书指定口径，E1 + E2 + E3 + E5 为 2/15，即 13.3%。
- 如果把“错误或中断后本应自动恢复”的 E4 也算作不该停，则是 14/15，即 93.3%。
- E4 并不集中于单一模型：`qoder/dfmodel` 5 个、`qoder/kmodel_latest` 3 个、`openai-codex/gpt-6-astra` 3 个、`openai-codex/gpt-5.6-sol` 1 个。它更集中于长时间工程、UI 和 CI 任务。
- E2 分别出现在 Qoder 和 Codex 模型，没有单一模型信号。

违规停点最常见的句式模板：

1. “阶段 X 已完成；还剩 Y 和 Z；下一轮再继续。”
2. “已经定位问题并列出后续实现，但先在这里交还控制权。”
3. “我已修正理解，会按确认的方向继续。”随后却没有继续调用工具。

### 2.3 `bare_approve` 样本 9 个

| label | 类别 | 模型 | 一句话转述 | 当时有没有“继续做完”的明确指令 |
|---|---|---|---|---|
| `da2f91be2b` | E6 | `openai-codex/gpt-6-astra` | 用户先要建议，agent 给出方案后等待是否实施。 | 无 |
| `7a6ee13f84` | E6 | `openai-codex/gpt-5.6-sol` | agent 建议改进本地工作流规则，等待是否写入。 | 无 |
| `f5252b14a5` | E6 | `openai-codex/gpt-6-astra` | 原请求是只读分析，agent 在改代码前确认。 | 无 |
| `8d00ea097e` | E6 | `openai-codex/gpt-5.6-sol` | 下一步涉及真实 provider 调用、安装和潜在费用。 | 无 |
| `524d931ec5` | E6 | `qoder/dfmodel` | 下一步包含真实部署与新的视觉方向，需要确认。 | 有 |
| `32a4763c45` | E6 | `openai-codex/gpt-5.6-sol` | 工作区还有大量无关提交，推送前询问如何处理。 | 有 |
| `343c85eb75` | E1 | `qoder/kmodel_latest` | 用户已经要求优化页面，agent 仍在实施前再次征求许可。 | 有 |
| `2378dc9fd0` | E6 | `openai-codex/gpt-6-astra` | 原任务完成后发现一个新的独立问题，先问是否扩大范围。 | 有 |
| `2378dc9fd0` | E1 | `openai-codex/gpt-6-astra` | 为达到已要求的 PR 可交付状态，发现阻塞问题后仍再次询问是否修复。 | 有 |

- 合理问题 E6：7/9，77.8%。
- 不必再问的 E1：2/9，22.2%。
- 结论不是“取消确认”。外部写入、费用、无关提交和新增范围仍应问；已经授权且属于原验收范围的实现不应重复问。

### 2.4 aborted 样本 10 个

| label | 类别 | 模型 | 一句话转述 | 当时有没有“继续做完”的明确指令 |
|---|---|---|---|---|
| `3db2fc0eee` | L5 | `openai-codex/gpt-6-astra` | 用户插入一条补充测试条件，不是 agent 行为问题。 | 无 |
| `a8e831c1ce` | L3 | `qoder/dfmodel` | 用户发现 agent 使用了错误的目标地址并纠正方向。 | 无 |
| `e6ee8bdbd6` | L4 | `qoder/dfmodel` | 单轮执行 162 次工具调用并出现 12 次错误后被中断。 | 有 |
| `97528289ac` | L4 | `qoder/kmodel_latest` | 单轮执行 125 次工具调用并出现 15 次错误后被中断。 | 有 |
| `328d6adce8` | L3 | `openai-codex/gpt-6-astra` | 交互决策没有正确完成，用户要求重新提问。 | 有 |
| `2378dc9fd0` | L4 | `qoder/dfmodel` | 单轮执行 113 次工具调用并出现 15 次错误后被中断。 | 有 |
| `a6ed18f0de` | L4 | `qoder/dfmodel` | 单轮执行 325 次工具调用，用户主动询问当前在做什么。 | 有 |
| `f08a5ca462` | L5 | `qoder/dfmodel` | 用户插入分支状态问题，没有要求 agent 改方向。 | 无 |
| `524d931ec5` | L5 | `qoder/dfmodel` | 用户在部署后补充新的视觉修改点。 | 无 |
| `a1659a4f08` | L5 | `qoder/dfmodel` | 用户说明自己暂时不用电脑，允许 agent 继续。 | 无 |

汇总：

| 类别 | 数量 | 占比 |
|---|---:|---:|
| L1 | 0 | 0% |
| L2 | 0 | 0% |
| L3 | 2 | 20% |
| L4 | 4 | 40% |
| L5 | 4 | 40% |
| L6 | 0 | 0% |

- 本次 10 个样本没有足够证据归为 L1 或 L2，因此不能从样本内回答它们的提前信号。
- L4 有清楚的提前信号：4 个样本单轮分别有 113、125、162、325 次工具调用，并出现 7–15 次错误。长时间无进度汇报、工具量超过 100、错误持续累积，都可以在用户中断前识别。
- 全量 38 个 aborted 停点中，有 5 个单轮超过 100 次工具调用、4 个超过 60 分钟、6 个超过 5 次工具错误。

### 2.5 分类器复核

Jev 对 34 个样本做了辅助初筛。27 个样本至少有一个判断低于 0.7 置信度，因此最终类别均由人工阅读覆盖。分类器的主要分歧是把部分长时间运行归为 L1，而人工没有看到足够的“同一失败路径重复”证据，保守归为 L4。

## 3. 两个未解释的数字

### 3.1 `model_change` 921 条

抽查 model_change 最多的 5 个会话：

| label | model_change 条目 | 真正变成不同模型的次数 | 备注 |
|---|---:|---:|---|
| `6566172664` | 101 | 7 | 子 agent 会话，大量是同一模型重复记录 |
| `43b5f93e8f` | 65 | 9 | 长主会话，每轮用户输入前重复记录当前模型 |
| `5af4142f55` | 41 | 13 | 多次在 Qoder 与 Codex 之间切换 |
| `5edfcf424b` | 32 | 5 | 绝大多数是同一 Qoder 模型重复记录 |
| `d84c5a78c7` | 31 | 0 | 子 agent 会话，31 条全是同一模型 |

全量结构：

- 921 条分布在 179 个会话。
- 584 条与该会话前一次 `model_change` 完全相同，不是模型切换，而是每轮记录当前选中模型。
- 158 条确实变成不同模型；其中 98 条发生在还没有前一条 assistant 响应的启动或 bootstrap 阶段。
- 只剩 60 条是会话进行中的真实变化：48 条在正常 stop 后、10 条在 error 后、2 条在 aborted 后。
- 154 条位于 7 个子 agent 会话中；这个数字与上面分类重叠，不能相加。
- 没有用户消息以 `/model` 开头。slash command 很可能不进入会话正文，因此无法区分用户在 TUI 手动切换和其他选择入口。
- `gpt-5.6-luna` 有 6 条 model_change，分布在 3 个会话。它们都表现为普通主模型的用户回合，没有证据表明是 Reducer 自动切换。

结论：921 主要不是“切了 921 次模型”，而是启动记录与每轮当前模型快照。可确认的会话内不同模型切换约 60 次。

### 3.2 `subagent_wait` 的 timeout

100 次调用都显式传了 `timeoutMs`，没有使用默认值：

| timeoutMs | 次数 |
|---:|---:|
| 1,000 | 1 |
| 120,000 | 2 |
| 180,000 | 1 |
| 300,000 | 1 |
| 600,000 | 13 |
| 900,000 | 3 |
| 1,200,000 | 10 |
| 1,800,000 | 65 |
| 2,400,000 | 3 |
| 3,600,000 | 1 |

- 20 次错误中，17 次是真正的 wait timeout；另有 2 次 unresolved state、1 次参数 validation。
- 17 次 timeout 里，16 次传了 1,800,000 ms，1 次传了 1,000 ms。
- timeout 时 17 个子 agent 都仍是 running；没有“已经完成但没回报”的样本。
- timeout 后主会话下一步：8 次调用 status、8 次再次 wait terminal、1 次读取本地状态；没有直接放弃，也没有立即自己接手实现。

结论：17 次 timeout 基本就是撞上显式 30 分钟上限。半数随后再次等待，说明 timeout 没有形成有效的换路信号。

## 4. `find_roots` 的 14 次错误

归并后的错误模板：

| 模板 | 次数 | 会话数 |
|---|---:|---:|
| `pi-computer-use helper mismatch: expected protocol <n> and executable <path>; got protocol <n> and executable <path>. The running helper was not restarted...` | 13 | 12 |
| `pi-computer-use helper app daemon did not start. Helper app: <path>` | 1 | 1 |

- 14 次错误分布在 13 个会话。
- 13 个失败会话的第一次 `find_roots` 全部失败。
- 两个会话在第一次失败后又重复调用，新增 3 次相同失败。
- 失败之后没有任何会话出现成功的 `find_roots`。

结论：失败高度集中在每个会话的第一次调用，根因是 helper 协议、可执行文件或 daemon 状态，不是 App 查询条件，也不是审批流程。应该在首次 Computer Use 调用前做 helper compatibility preflight，并在 mismatch 后禁止重复调用，直到 helper 状态发生变化。

## 5. 修订后的 Top 5 改进

### 1. 异常停点后自动续接
- 问题：74 个 `bare_continue` 中，34 个发生在 error 后、22 个在 aborted 后、5 个在 toolUse 后，共 61 个，占 82.4%。
- 证据：15 个定性样本中 E4 为 12 个。
- 涉及组件：Pi 核心循环与重试、Qoder provider、其他 provider、coding-policy。
- 建议：可证明没有未知写入时，从最近检查点自动继续；未知写入先只读核验。provider 恢复成功后不把控制权交给用户。
- 排序变化：第一轮的 provider 恢复从第 5 位升到第 1 位，因为第二轮证明它是“继续”回复的主因。

### 2. 长运行加入进度与中断预算
- 问题：停太晚样本中 4/10 是长运行；单轮最多 325 次工具调用。
- 证据：4 个 L4 样本均超过 100 次调用，并有 7–15 次错误。
- 涉及组件：Pi 核心循环、coding-policy、内置文件工具。
- 建议：单轮达到工具数、错误数或时间阈值时，必须汇报进度、剩余量和是否换路；不是直接停下等待“继续”。
- 排序变化：保留第一轮“阶段预算”，但增加单轮运行时 guard，而不只关注整场会话 token。

### 3. 真实验收继续作为硬门
- 问题：代码、子 agent 或局部测试完成，不等于真实 UI、PR、发布或设备流程完成。
- 证据：第一轮 `4290f8f2e7`、`fe48eeb57f`、`f2448d03b3`。
- 涉及组件：Browser relay、Subagent、coding-policy。
- 建议：继续要求独立真实重放；缺证据只能报告未知。
- 排序变化：保持第一轮第 3 位。

### 4. 区分合理确认与重复许可
- 问题：不能为了减少停点而取消必要确认；但已授权范围内仍有重复询问。
- 证据：9 个 `bare_approve` 中 7 个是合理 E6，2 个是不必要 E1；正常 stop 后的 `bare_continue` 还出现 E2。
- 涉及组件：Ask、coding-policy、Pi 核心循环。
- 建议：只在用户拥有决定权、外部写入、费用、不可逆动作或新增范围时询问；原范围内的实现和验收直接继续。
- 排序变化：新增为独立项，避免把“少问”误做成“从不问”。

### 5. `subagent_wait` timeout 必须触发换路
- 问题：17 次 timeout 全部仍在 running；16 次是 30 分钟上限，8 次随后又继续等待。
- 证据：timeout 参数和后续调用的本地统计。
- 涉及组件：Subagent、Pi 核心循环。
- 建议：30 分钟 timeout 后先 status；若无新进展，不再次使用同一长等待，改为主会话继续其他工作、缩小任务或取消子任务。
- 排序变化：保留第一轮 Subagent 方向，但从“委派验收”收紧为可执行的 timeout 换路规则。

## 6. 拿不准的地方

- 本地只有 9 个 `bare_approve`，少于任务书目标 10 个。
- `aborted` 不一定都由用户主动按下停止；部分可能来自 provider 或运行时中断。第二轮按“aborted 后用户立即发言”作为停太晚候选，但类别仍有不确定性。
- `model_change` 不记录 slash command 来源；无法证明 60 次会话内变化分别有多少来自 TUI 手动选择、恢复逻辑或扩展。
- Jev 对 34 个样本有 27 个低置信度判断，分类结论以人工复核为准。
- L1 和 L2 在本次 10 个 aborted 样本中都是 0，不能据此断言全量会话没有原地打转或擅自扩大范围。
- `find_roots` 模板能证明 helper 状态异常，但没有真实修复后的同会话正例，因此不能从本轮数据证明 preflight 修复效果。

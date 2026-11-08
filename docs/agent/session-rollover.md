# 轮间新会话续接技术方案

状态：设计草案，尚未实现或启用。本文不修改当前运行时合同，也不代表性能收益已经验证。实现前必须先完成第 9.1 节的阶段 0 离线统计；该统计不支持本方案时，不进入实现。

## 1. 目标与已确定的行为

采用 Mainplane 的基本方向：保留旧会话原文，新会话按需检索，而不是为换会话先生成整段历史摘要。参考：[原帖](https://x.com/Alezander9/status/2115842962521509968)、[本次核对的 Mainplane 源码](https://github.com/mainplane-ai/mainplane/tree/2c77939862c89f119da6fc0109866dbf3d9453f8)。

只在**下一轮开始**时切换。当前轮不因这项功能被中断，不在工具调用之间创建新会话。

```text
用户输入 → 模型与工具持续工作 → 本轮完全结束 → 等待输入
                                                 ↓
                                        用户提交下一轮请求
                                                 ↓
                              旧上下文达到轮间水位且具备资格？
                                ├─ 否：沿用当前会话（原有压缩路径不变）
                                └─ 是：创建普通新会话
                                       ＋旧历史检索入口与原文尾部摘录
                                       ＋本次用户输入
```

“一轮”指一次完整请求及其全部工具、重试和自动续跑，直到 Pi 不再自动继续。已进入当前运行队列的 steering/follow-up 不在中途迁移；只有空闲后的新提交进入轮间判断。

本方案不增加任务 ID、执行片段调度器、任务合同、跨会话状态合并、向量数据库、后台记忆模型或自动摘要。用户看到的是真正的新会话及新 session ID，可返回旧会话查看记录，不伪装为同一个会话。

## 2. 当前实现与接入位置

以下为源码事实，不是已实现的轮转功能。源码位置按函数名引用，行号会漂移。

| 当前能力 | 源码位置 | 对本方案的约束 |
| --- | --- | --- |
| `prompt()` 等待完整运行结束；`agent_end` 后仍可能重试、处理队列或继续边界工作 | [SDK](../../packages/rotom-pi/packages/coding-agent/docs/sdk.md)、[AgentSession](../../packages/rotom-pi/packages/coding-agent/src/core/agent-session.ts) | 不能在 `turn_end` 或 `agent_end` 内直接切会话；使用 `agent_settled`、空闲状态及待处理工作判断完整边界 |
| 普通新会话由 `AgentSessionRuntime.newSession()` 替换当前 `AgentSession`，允许 `session_before_switch` 取消，并执行正常 shutdown/start；该事件的 `reason` 目前只有 `"new" \| "resume"` | [AgentSessionRuntime](../../packages/rotom-pi/packages/coding-agent/src/core/agent-session-runtime.ts)、[extension types](../../packages/rotom-pi/packages/coding-agent/src/core/extensions/types.ts)、[示例](../../packages/rotom-pi/packages/coding-agent/examples/sdk/13-session-runtime.ts) | 不另造会话生命周期；替换后必须重新绑定宿主订阅；插件目前无法区分自动轮转和用户 `/new` |
| `SessionManager` 保存原始条目、活动分支和 `parentSession` | [SessionManager](../../packages/rotom-pi/packages/coding-agent/src/core/session-manager.ts) | 旧会话不删除；新会话用现有 parent 引用关联来源 |
| `shouldCompact()` 判定 `contextTokens > contextWindow - reserveTokens`；`reserveTokens` 默认 16384，可按模型覆盖 | [compaction.ts](../../packages/rotom-pi/packages/coding-agent/src/core/compaction/compaction.ts)、[settings-defaults.ts](../../packages/rotom-pi/packages/coding-agent/src/core/settings-defaults.ts) | 轮间水位由同一设置派生，不新增配置项 |
| **轮内每次请求模型前**都会检查阈值并压缩（`prepareNextTurnWithContext` → `_compactBeforeNextAssistantResponse`）；运行结束后 `_handlePostAgentRun` → `_checkCompaction` 再查一次；下一次 `prompt()` 的 `_prepareRun` 开头还会查一次 | [AgentSession](../../packages/rotom-pi/packages/coding-agent/src/core/agent-session.ts) | 若轮间判断与压缩用同一阈值，长轮次在中途越线时会先被原生压缩，轮间切换只覆盖“最后一次回复恰好越线”的情况（见 3.1） |
| 阈值估算有两条路径：`_exceedsCompactionThreshold` 用投影估算；`_checkCompaction` 优先用最后一条回复的 Provider usage，有 `context_edit` 时用投影估算，错误或零 usage 时退回消息估算 | 同上 | 轮间判断若自选估算源，可能判定“不切换”后又在 `_prepareRun` 里被另一估算判定越线而压缩（见 3.1） |
| Compaction Offload 只挂在 `session_before_compact` 且 `reason === "threshold"` 时运行 | [offload.ts](../../packages/rotom-sol-pi/src/sol-pi/extensions/observation-pack/offload.ts) | 轮末阈值压缩被延后时 Offload 也不会运行，两者先后必须明确（见 3.3） |
| Browser 在 `session_before_switch` 时直接 `closeRuntime`，不阻止切换 | [browser-runtime.ts](../../rotom/extensions/browser/browser-runtime.ts) | 不改动时，自动轮转会静默关闭 agent 的 tab（见第 6 节） |
| JSONL 导出与面向摘要的文本序列化已经存在，但用途不同 | [session-export.ts](../../packages/rotom-pi/packages/coding-agent/src/core/session-export.ts)、[compaction/utils.ts](../../packages/rotom-pi/packages/coding-agent/src/core/compaction/utils.ts) | 复用活动分支遍历和消息处理模式，不直接把原始 JSONL、HTML 导出或摘要文本当作安全检索日志 |

这是 Pi fork 的会话生命周期改动，不能只靠一个 `turn_end` 扩展可靠完成。实现应放在共享运行入口及其会话宿主，不在 TUI、RPC 各自复制策略。

## 3. 切换规则：不保存待切换标志

### 3.1 判断时间、估算源与轮间水位

下一次空闲提交、实际调用旧会话 `prompt()` **之前**做判断，此时 `_prepareRun` 尚未运行。

**估算源与压缩一致。** 从 `_checkCompaction` 的阈值分支中抽出一个只读函数，按它现有的优先级（Provider usage → 有 `context_edit` 时投影估算 → 错误/零 usage 时消息估算，含“usage 早于最近压缩则不计”的检查）给出当前上下文量。轮间判断与 `_checkCompaction` 共用这个函数，不另写一套估算。不额外发模型请求获取 token 数；估算不是 Provider 精确计费量。

**轮间水位低于压缩阈值。** 轮内每次请求前都会按压缩阈值检查并压缩，所以若轮间判断使用同一阈值，长轮次在中途越线时总会先被原生压缩，到轮末占用已经降下来，切换几乎不会发生。因此轮间判断使用一个更早的水位：

```text
压缩阈值  = contextWindow - reserveTokens          （现有，不变）
轮间水位  = contextWindow - 2 × reserveTokens      （本方案，候选值）
切换条件：当前估算量 > 轮间水位，且满足 3.2 的全部资格
```

- 轮间水位由现有 `reserveTokens` 派生，不新增配置项、百分比或模式。`reserveTokens` 是为单次回复预留的空间，再多留一份，作为下一轮在轮内越线前的余量；这只是候选值，最终取值由阶段 0 统计决定，并在本文中写定。
- 代价：处于水位与阈值之间的会话本来还能在旧上下文里继续，现在会提前换到新会话，丢失直接可见的上下文、只能检索。这是换取轮间切换实际生效所接受的取舍，第 9.2 节必须测量它对续做正确性的影响。
- 由于两者共用估算源且水位 ≤ 阈值：判定“不切换”时，只有不具备资格的会话才会在随后的 `_prepareRun` 里被压缩；具备资格且已越过阈值的会话必定先越过水位并切换。不再出现“判断说不切换、进入 `prompt()` 后又压缩”的不一致。
- 尊重现有 `compaction.enabled`：用户关闭自动压缩时，本功能也不触发，不通过本功能暗中重新启用阈值行为。

不添加 `rollover_pending` 条目或恢复状态机。重启后仍从原会话及当前设置重新判断；用户换模型、手动压缩或修改可见投影后也重新判断，不沿用过期结论。

**只看轮间的当前占用，不追踪本轮是否曾经越线。** 如果轮内原生压缩已经降低占用，轮末低于水位，下一轮继续旧会话，不再为“曾经超限”额外换一次。

### 3.2 必须满足的资格

仅普通、持久化且已正常完成的空闲会话可以自动切换。以下任一条件成立就沿用现有处理（继续旧会话，原有压缩路径不变），不自动换会话。每一条都必须能从运行时状态或会话条目机械判定：

- 模型仍在输出、工具尚未结束、队列未排空、正在重试、压缩或恢复。
- 当前活动分支上最后一条助手消息不是正常结束：`stopReason` 不是 `stop`（如 `aborted`、`error`、`length`、`deferred`），或者存在没有对应结果的 tool call。用户提交新输入就算做出了决定，所以这只影响本次提交：本次继续旧会话，让模型能看到失败上下文；等下一次正常结束后的提交再重新判断。不能用换会话掩盖失败。
- 当前没有可用模型/窗口、选中的是虚拟模型，或是无法保留旧历史的 `--no-session`、内存会话。
- 只执行 `/model`、`/compact`、`/new` 等本地命令，尚未提交普通模型请求。
- 存在 `status: active` 的 Goal（含 waiting 与 Provider 恢复等待）。首版不迁移 Goal 状态，继续使用原生压缩（局限见第 10 节）。
- 插件对 `session_before_switch`（`reason: "rollover"`，见第 6 节）返回取消，例如 Browser 仍持有 agent 自己打开的 tab。

`agent_settled` 只是完成信号，不能单凭它推断成功；还要检查上述条件。

### 3.3 与现有压缩及 Offload 的关系

- **轮内**：请求前阈值检查、实际 overflow 恢复、现有有界重试及用户主动 `/compact` 保持原有语义，不改阈值。
- **轮末**：`_handlePostAgentRun` 中的阈值压缩只在“本轮正常结束、没有继续工作、且具备 3.2 资格”时延后到下一次提交再判断；此时占用必定已越过轮间水位，下一次提交会切换。不满足资格时照常压缩。
- **Offload 的先后**：具备资格时，切换优先于 Offload。Offload 的目的是推迟原生摘要、继续留在旧会话；切换本身就不生成摘要，并且会丢弃全部旧上下文，先 Offload 再切换只会多做一次无效改写。不具备资格或功能关闭时，Offload 照常挂在阈值压缩上运行。因此 3.1 的轮间水位与 Offload 互不干扰：低于阈值时 Offload 本来就不运行。
- 若边界处理器、队列或 Goal 仍要继续，仍是旧会话中的工作，不能为了等待换会话而禁止必要的原生压缩。
- 不在 `session_before_compact` 中一律返回取消；这会同时破坏轮内容量保护。上述区分在核心运行流程里完成。
- 关闭功能或不满足资格时，完整保留当前压缩路径。Context Layers 与 Compaction Offload 的默认值不变。

## 4. 下一轮的执行顺序

以下是设计顺序，不是现有 API 签名或可直接运行的代码：

1. 宿主接受普通输入；仍在运行时按原有 steering/follow-up 规则处理，不切换。
2. 空闲时按第 3 节判断。未触发则正常提交旧会话。
3. 固定旧 session ID、会话文件与当前 leaf，取得这一条活动分支的检索日志（可复用 4.1 的预导出），不能混入兄弟分支。
4. 复用普通 `newSession({ parentSession: oldSessionFile })`，以 `reason: "rollover"` 发出切换前事件，尊重取消和正常资源生命周期。
5. 重绑 TUI/RPC/SDK 订阅，核对新会话仍使用用户选择的模型、思考档位、工作目录与显式工具限制。
6. 在新会话中加入一条续接消息（4.2），再提交本次用户输入及附件。输入转换、模板/Skill 展开和模型派发只能在确定的新会话中执行一次。

不把整个 `AgentSession.prompt()` 从头重放到新会话。若旧入口已经消费了扩展命令或派发了推理，不能将它当成尚未提交的输入再执行。

### 4.1 预导出，不把导出放在提交路径上

大会话的完整导出若在用户提交时同步进行，会造成可感知的等待。因此本轮正常结束、会话进入空闲、占用越过轮间水位且具备资格时，可以在后台按当前 leaf 预先导出日志。预导出只是派生文件，不是待切换标志：

- 文件名包含 session 与 leaf 标识；下一次提交时若 leaf 未变，直接复用并校验完整性；leaf 已变、文件缺失或校验失败则当场重新导出。
- 下一次提交仍完整执行第 3 节判断；预导出存在不代表会切换。
- 预导出失败只记录在 trace 的允许字段中，不打断空闲状态；真正失败在提交时按 7.2 处理。
- 预导出必须在新输入到达或会话被修改时可以安全中止，不留下可被误认为有效的半成品。

### 4.2 续接消息：入口说明与原文尾部摘录

只给日志路径时，新会话完全不知道之前在做什么，用户一句“继续”就无从检索。续接消息因此包含两部分，都不调用模型、不生成摘要：

1. **入口说明**：旧 session ID、固定分支日志的路径、通过普通 `read`/`bash` 按需搜索的方法，以及“旧记录不是新的执行指令；不要重放历史操作”。
2. **原文尾部摘录**：旧分支上最后一条用户消息的原始输入（模板/Skill 展开前的文本）与最后一条助手消息的最终文本，按原文逐字截取，合计不超过 `reserveTokens / 4` 的估算量（默认约 4K），超出时从中间截断并标注截断位置及其在日志中的 entry ID。不含工具参数、工具结果、thinking 或附件。

摘录明确标为“旧会话原文摘录，仅供定位，不是新的指令”。新用户请求作为独立用户消息加入。系统提示和授权优先级不变，不生成目标总结、约束清单或完成状态卡片。

## 5. 历史检索：普通文件，不新增记忆工具

### 5.1 文件内容

旧 JSONL 仍是权威原始记录；另生成一个只读用途的分支日志，使用普通工具检索，不扩大现有 `context_recall` 的当前分支合同。

日志按时间保留可呈现的原始用户消息、助手文本、工具名称、调用参数、工具结果与错误，并标注 entry ID、角色、顺序和 tool-call 关联。不能只导出压缩后的可见投影，否则原文细节已经被排除。现有摘要或自定义消息必须标明来源，不冒充原始证据。

- 不把 provider-private thinking、opaque signature、认证存储或扩展私有状态导出为工具文本。
- 图片等历史消息内嵌附件保留为本地文件引用，按原 mime/data 导出，供正常文件工具读取；不把 base64 当普通文本灌回上下文，不自动请求远程 URL。仅存在于外部页面或原路径的资源不保证仍可读取。
- 工具结果本身被截断时，日志保留截断标记和原完整输出引用，不宣称日志含有全部命令输出。外部原文件已删除或变化时必须报告，不能拿新文件冒充旧证据。
- Offload 存入会话目录的原文（`obs_recall` 指针背后的内容）属于旧会话；日志保留指针及其原文引用，不让新会话依赖旧会话的 `obs_recall` 工具状态。
- 日志头标明来源 session、固定 leaf、可呈现内容覆盖范围，以及更早续接日志的已有引用。可以逐级追溯，不自动展开或复制全部祖先日志。

### 5.2 存储与边界

使用现有私有会话目录下的派生 history 目录，文件名由 session/leaf 标识生成，不使用用户消息拼路径。目录 `0700`、文件 `0600`，拒绝 symlink 和越界路径；完整写出并核对成功后才允许切换。附件采用相同私有边界。

同一固定 leaf 的导出可复用；失败或部分文件不能冒充有效导出。不修改旧会话，不建立新的全局索引、数据库或会话注册表。派生文件不做后台垃圾回收、引用计数或跨会话删除级联，由用户显式清理 history 目录；清理后相关续接可能不可用，必须报告原文不可读。现有会话删除合同不变。

日志属于用户本地会话内容，不属于 observability trace，不上传或提交仓库；trace 只记录切换原因、关联标识、耗时和结果等允许的 metadata。

## 6. 正常新会话的资源语义

使用已有资源发现与配置：Extension、系统提示、项目指令和 Skill 目录按普通新会话处理；Skill 正文仍按正常规则按需读取。不能通过少加载必要插件或指令制造性能收益。

仅保留用户的有效选择，不复制旧插件实例、取消信号、账号绑定、旧工具调用 ID 或临时工具状态。新 Provider 按正常新会话重新绑定；精确模型不再可用时明确停止，不自动换模型。

### 6.1 切换事件区分自动轮转

`session_before_switch` 的 `reason` 增加 `"rollover"`，表示由本功能发起、用户没有主动要求换会话。这是 Pi extension API 的新增取值：

- 兼容性影响：按 `reason === "new"` 分支的现有插件不会进入该分支；不看 `reason` 的插件（如当前 Browser）按原逻辑处理。实施时需检索仓内所有 `session_before_switch` 处理器并逐一核对，CHANGELOG 记录新增取值。
- `/new`、`/resume` 的行为与取值不变。

### 6.2 必须调整的插件

- **Browser**：当前在 `session_before_switch` 时无条件关闭 runtime。收到 `reason: "rollover"` 且仍持有 agent 自己打开或移交来的 tab 时，返回取消并给出明确原因（本次继续旧会话）；没有 agent tab 时按原逻辑关闭。`"new"`/`"resume"` 行为不变。不跨会话复用旧 tab ownership，不关闭后在新会话重开。
- **Subagent**：核对仍在运行的子任务及其 browser lease；有在跑子任务时返回取消，不让子任务失去父会话。
- **Goal**：资格判断已在 3.2 排除 active Goal；Goal 侧不需要新增阻止逻辑，只需确认 `"rollover"` 不触发其清理路径。
- 其他持有长生命周期资源的产品插件按同一规则处理：需要继续持有资源就取消，不新增通用资源注册框架。

插件取消即表示本次不切换，按 7.2 继续旧会话并照常走压缩路径，不反复重试切换。

这些兼容性检查是正常换会话所必需，不演变成维护任务/执行片段的另一套系统。

## 7. 入口、失败与取消

### 7.1 接入范围

TUI、RPC 和持有 `AgentSessionRuntime` 的 SDK 宿主共用轮间提交入口，并重绑替换后的 session 事件；RPC 必须能回读新 session ID，不能沿用旧对象回应成功。

仅持有裸 `AgentSession` 的 SDK 调用不被背后替换，仍按现有方式工作；调用方采用 runtime 宿主后才支持自动轮转。单次 print 请求没有后续提交，不因退出而额外创建会话；同进程多请求入口需走相同 runtime 路径，不另写策略。

### 7.2 失败语义

| 情况 | 行为 |
| --- | --- |
| 历史导出失败、空间不足或原会话不可读 | 不切换、不派发本次推理；保留输入并显示明确错误 |
| 插件取消切换（`reason: "rollover"`） | 本次继续旧会话并正常提交输入，照常走压缩路径；显示取消原因，不自动重试切换 |
| shutdown、资源加载或新会话创建失败 | 不宣称仍处于完好的旧运行时；展示实际状态和旧会话入口，保留输入，不自动回滚或重复提交 |
| 切换后输入/附件处理失败 | 保留实际的新会话，报告失败；不重新创建另一个新会话 |
| 模型请求或外部操作已派发，结果未知 | 沿用现有 unknown 与有界恢复合同，不能借换会话重放 |

插件取消属于“正常不切换”，与导出失败不同：前者不影响本次输入的派发，后者不派发并要求用户处理。

普通新会话替换不是原子事务。不得承诺任意阶段失败都能透明恢复到旧插件状态。

## 8. 最小实现范围与开关

建议单一 opt-in 开关 `ROTOM_SESSION_ROLLOVER=1`，未设置时关闭；该名称及行为尚未实现。实现前核对 launcher 的现有环境合同，不增加阈值百分比、水位配置、执行片段长度或多个模式配置。

| 修改位置 | 目的 |
| --- | --- |
| Pi `AgentSession` | 从 `_checkCompaction` 抽出共用的只读上下文量估算；计算轮间水位；`_handlePostAgentRun` 在具备资格时延后轮末阈值压缩；提供只读的轮转资格结果，不在事件回调里替换自身 |
| Pi `AgentSessionRuntime`、extension types 及宿主入口 | 在空闲新输入前复用正常 `newSession()`；`session_before_switch` 增加 `"rollover"`；保留输入、处理取消及绑定新 session |
| 现有会话导出邻近模块 | 活动分支文本/附件导出与空闲预导出；不复用未经筛选的原始 JSONL |
| Browser、Subagent extension | 按 6.2 在 `"rollover"` 时持有资源则取消 |
| rotom launcher、产品配置 | 仅接入明确开关；保持非产品 SDK 的原有默认 |
| TUI/RPC 与文案模块 | 展示实际新 ID、旧会话入口、切换结果或取消原因；文案集中，不在组件硬编码 |

不改 npm 版本，不改现有自动压缩默认，不覆盖存活会话安装。后续 Pi 源码实施需按仓库合同重新 `build:pi`、验证归档与 capability；本文档任务不执行这些构建。

## 9. 验证与启用条件

### 9.1 阶段 0：实现前的离线统计

在写任何运行时代码之前，用维护者本机已有的会话 JSONL 离线回放，不调用模型、不产生费用：

- 逐个请求重算第 3.1 节的上下文估算，统计越过压缩阈值的事件中，有多少发生在轮中途（会被轮内压缩先处理）、多少发生在轮末（本方案可接管）。
- 对候选轮间水位（`contextWindow - 2 × reserveTokens`）及另外一两个由 `reserveTokens` 派生的候选做同样统计，并统计单轮上下文增长量分布。
- 输出只含聚合计数与分布，不含消息内容、路径或 session ID；会话文件和统计原始数据不进入仓库。
- 实施前写定通过门槛（例如：候选水位下，原本会发生原生压缩的会话中，至少一半能在轮间被切换接管）。不达门槛时本方案停在设计阶段，不进入实现；水位最终取值以统计结果写回 3.1。

### 9.2 确定性检查

| 检查 | 必须证明的行为 |
| --- | --- |
| 阈值与水位上下界、切换模型、手动压缩、重启恢复 | 轮间判断与 `_checkCompaction` 使用同一估算；水位由 `reserveTokens` 派生；无持久 pending；不误用旧模型阈值 |
| 估算一致性 | 判定“不切换”的具备资格会话，紧接着的 `_prepareRun` 不触发阈值压缩 |
| `compaction.enabled: false` | 功能不触发，也不引入任何阈值行为 |
| 多工具、多轮模型调用、队列、重试、取消和失败 | 轮内 session ID 始终不变；未结束或异常状态不自动切换 |
| 最后一条助手消息 `stopReason` 不是 `stop`，或有未配对 tool call | 本次继续旧会话；下一次正常结束后的提交重新判断 |
| 正常结束且越过水位 → 下一次提交 | 结束当下不创建新会话；下一次恰好创建一个新 ID；本次输入只派发一次 |
| 轮末阈值、Offload 与轮内 overflow | 具备资格时轮末不生成摘要、不运行 Offload；不具备资格或功能关闭时原有压缩与 Offload 路径不变；轮内必要压缩仍有效 |
| 预导出 | leaf 未变时复用；leaf 变化、缺失或损坏时重新导出；预导出存在不改变切换判断；中止不留有效半成品 |
| 续接消息 | 尾部摘录逐字取自旧分支原文、不超过上限、截断有标注；不含工具结果、thinking 与附件 |
| `session_before_switch` 的 `"rollover"` | Browser 有 agent tab 时取消、无 tab 时关闭；有在跑子任务时 Subagent 取消；`/new`、`/resume` 行为不变；取消后本次输入在旧会话正常派发 |
| TUI/RPC/runtime SDK、事件订阅与本地命令 | 所有支持入口行为一致；无旧 session 事件串入；命令不意外创建新会话 |
| 分支日志、工具参数、图片、截断标记、Offload 指针 | 精确原文可找回；无兄弟分支泄漏、私有 signature 泄漏或虚假全文声明 |
| Goal、活跃资源、显式工具限制及 Provider 绑定 | 不迁移未支持状态、不放宽权限、不重放旧工具操作 |
| 导出/加载/切换失败与进程重启 | 保留输入并如实报告实际状态；不自动重试未知操作、不连续创建空会话 |
| 大会话导出耗时 | 提交路径上复用预导出时无完整导出；未命中预导出时报告实际耗时 |
| 负向对照 | 禁用切换入口、漏掉输入、断开历史引用或让轮间判断改用另一估算源时，相关检查必须失败 |

优先扩展现有 `agent-session-auto-compaction-queue.test.ts`、`agent-session-compaction.test.ts`、`agent-session-runtime-events.test.ts`、`rpc-prompt-response-semantics.test.ts`、会话导出与 Browser runtime 相关测试，再添加必要 focused 回归；执行前重新定位实际文件与 scripts。

### 9.3 真实续接与性能

另行取得模型、费用/时长及外部操作授权后，比较同一任务在**当前默认配置**（原生压缩 + Compaction Offload 开启）与轮间新会话下的表现：

- 统计整个后续任务的完成时间、请求次数、检索次数及所有辅助用量，不只统计创建会话或首次回复。
- 记录实际切换次数与原生压缩次数，核对阶段 0 的触发率在真实任务中是否成立。
- 区分 warm/cold cache，记录 Provider 报告费用；未知费用保持 unknown，不用 token 或缓存命中推算美元。
- 使用新会话无法从当前输入猜出的随机历史细节，独立核验精确输出，证明真正读取旧日志。
- 覆盖仅输入“继续”的续做、早期禁止事项、未决操作、处于水位与阈值之间提前切换的会话、连续两次换会话、重启后续接，以及可恢复的图片附件。
- 外部操作验收要能发现重复执行；unknown 场景不做真实写入重放实验。

未获得后续任务正确性与端到端收益证据前，不默认启用，不宣称优于现有压缩或 Offload。若回查遗漏约束、提前切换损害续做、恢复成本抵消收益或资源切换不可靠，保持关闭，继续使用既有机制；不以增加任务状态系统来掩盖这条简化路线的局限。

## 10. 已知限制与本轮交付

- **Goal 会话不受益。** Goal 默认自动续跑不限次数，而存在 active Goal 时不切换，所以最长的自动任务恰好被排除，仍走原生压缩。支持 Goal 需要单独设计其状态与预算如何跨会话，不在本方案范围内。
- **持有资源的会话不受益。** Browser 仍有 agent tab、Subagent 有在跑子任务时取消切换；浏览器密集任务可能长期不切换。
- **提前切换有代价。** 轮间水位低于压缩阈值，部分本来还能留在旧上下文的会话会提前换到只能检索的新会话。
- 新会话仍承担基础提示、插件初始化与重新建立工作上下文的成本；缓存能否复用取决于 Provider。
- 尾部摘录只帮助定位，没有任务合同或自动约束提取，模型仍可能不知道早期约束需要检索。必须通过真实续做验收判断是否可接受。
- 整轮可能很长，轮内原生压缩仍会发生；本方案不是“永不压缩”。
- 当前分支日志不保证外部页面、已删除文件或截断结果的原完整输出仍可恢复。
- 本轮只交付技术方案。阶段 0 统计、代码、开关、日志导出、自动新会话及实测均未实现或执行。

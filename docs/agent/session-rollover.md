# 同会话轮转与 Context Layers 精简技术方案

状态：设计已定稿；W1–W4 已实现（A 精简、阶段 0 统计、B 的接缝与 extension），W5 产品接入与 W6 终验见 [回报](session-rollover-report.md)。执行清单见 [session-rollover-worklist.md](session-rollover-worklist.md)。本文不代表性能收益已经验证，B 默认关闭且未做真实模型实测。

本方案分两部分，按顺序独立推进：

- **A. Context Layers 精简为只读检索**（第 3 节）：删去模型驱动的分层压缩，只保留搜索与原文回查。已有实测不支持压缩部分的费用收益，检索部分对原生压缩后的回查和 B 都有用；可以先做，不依赖 B。
- **B. 同会话轮转**（第 4–9 节，分册见下）：上下文达到轮间水位时，在下一轮开始前于**同一会话**追加一条不调用模型的轮转条目，清空模型可见上下文，旧原文留在分支上按需检索。默认关闭；阶段 0 离线统计（第 9.1 节）决定它能否合入公开 `main`，返工后的统计不达门槛，因此 B 保持 opt-in、不改默认、也不改门槛。

本文早期版本设计为“轮转时创建新会话并导出分支日志”。改为同会话后，会话 ID、插件实例、Browser tab、子任务与 Goal 状态都不随轮转变化，也不再需要日志导出、切换事件新取值和订阅重绑。早期版本只查 Git history。

## 1. 目标与已确定的行为

采用 Mainplane 的基本方向：保留旧原文，按需检索，而不是为腾出上下文先生成整段历史摘要。参考：[原帖](https://x.com/Alezander9/status/2115842962521509968)、[本次核对的 Mainplane 源码](https://github.com/mainplane-ai/mainplane/tree/2c77939862c89f119da6fc0109866dbf3d9453f8)。

只在**下一轮开始**时轮转。当前轮不因这项功能被中断，不在工具调用之间轮转。

```text
用户输入 → 模型与工具持续工作 → 本轮完全结束 → 等待输入
                                                 ↓
                                        用户提交下一轮请求
                                                 ↓
                              当前占用越过轮间水位且具备资格？
                                ├─ 否：正常提交（原有压缩路径不变）
                                └─ 是：同一会话追加轮转条目
                                       （检索说明＋原文尾部摘录）
                                       → 正常提交本次用户输入
```

“一轮”指一次完整请求及其全部工具、重试和自动续跑，直到 Pi 不再自动继续。已进入当前运行队列的 steering/follow-up 不在中途迁移；只有空闲后的新提交进入轮间判断。

会话 ID 始终不变。本方案不增加任务 ID、执行片段调度器、任务合同、跨会话状态合并、向量数据库、后台记忆模型或自动摘要。

## 2. 当前实现与接入位置

以下为源码事实，不是已实现的功能。源码位置按函数名引用，行号会漂移。

| 当前能力 | 源码位置 | 对本方案的约束 |
| --- | --- | --- |
| `CompactionEntry` 保存 `summary`、`firstKeptEntryId`、`details`、`fromHook`；`appendCompaction` 在 `firstKeptEntryId` 为空时指向条目自身 | [SessionManager](../../packages/rotom-pi/packages/coding-agent/src/core/session-manager.ts) | 轮转条目复用压缩条目，不新增条目类型；指向自身即“不保留旧消息” |
| `buildContextEntries` 只投影最新压缩条目、`firstKeptEntryId` 起的保留条目和其后的条目；旧条目仍在分支上 | 同上 | 轮转后模型只见轮转条目与新输入；`getBranch()` 仍可读到全部旧原文 |
| 压缩摘要以 `COMPACTION_SUMMARY_PREFIX`（“compacted into the following summary”）包装后进入上下文 | [messages.ts](../../packages/rotom-pi/packages/coding-agent/src/core/messages.ts) | 轮转条目不是摘要，需要按 `details` 使用不同包装（5.2） |
| 原生压缩把上一条压缩的 `summary` 作为 `previousSummary` 合并 | [compaction.ts](../../packages/rotom-pi/packages/coding-agent/src/core/compaction/compaction.ts) | 轮转后再发生原生压缩时，轮转条目文本会进入合并（5.3） |
| `shouldCompact()` 判定 `contextTokens > contextWindow - reserveTokens`；`reserveTokens` 默认 16384，可按模型覆盖 | 同上、[settings-defaults.ts](../../packages/rotom-pi/packages/coding-agent/src/core/settings-defaults.ts) | 轮间水位由同一设置派生，不新增配置项 |
| **轮内每次请求模型前**都会检查阈值并压缩（`prepareNextTurnWithContext` → `_compactBeforeNextAssistantResponse`）；`_handlePostAgentRun` → `_checkCompaction` 在运行结束后再查；下一次 `prompt()` 的 `_prepareRun` 开头还会查 | [AgentSession](../../packages/rotom-pi/packages/coding-agent/src/core/agent-session.ts) | 与压缩同阈值时，长轮次中途越线会先被原生压缩，轮转几乎不触发（4.1） |
| 阈值估算有两条路径：`_exceedsCompactionThreshold` 用投影估算；`_checkCompaction` 优先用 Provider usage，有 `context_edit` 时用投影估算，错误或零 usage 时退回消息估算 | 同上 | 轮间判断必须与 `_checkCompaction` 共用估算（4.1） |
| `session_before_compact` 的 `reason` 为 `manual \| extension \| threshold \| overflow`，处理器可取消或提供替代结果 | [extension types](../../packages/rotom-pi/packages/coding-agent/src/core/extensions/types.ts) | 轮转新增 `"rollover"`，需逐一核对现有处理器（5.4） |
| 现有 `session_before_compact` 处理器：Offload（只处理 `threshold`）、Goal（记账、可取消续跑或因预算取消）、Subagent（非 manual 时挂起 widget）、observability（记录）、Qoder session policy | [offload.ts](../../packages/rotom-sol-pi/src/sol-pi/extensions/observation-pack/offload.ts)、[Goal lifecycle](../../packages/rotom-goal/src/lifecycle.ts)、[Subagent](../../packages/rotom-subagents/src/extension/index.ts)、[observability](../../rotom/extensions/observability/index.ts)、[Qoder session policy](../../rotom/extensions/qoder/session-policy.mjs) | 同上 |
| 精简后的 Context Layers 只有 `context_recall`：带 `query` 时在**整条分支**全部消息中做子串搜索（含 tool call 工具名与参数文本），返回 `@entryId` 与摘录；带 `ref` 时按 `@entryId` 或摘要块返回原文（含工具参数、图片，不回显 thinking/signature） | [blocks.ts](../../rotom/extensions/context-layers/blocks.ts)、[recall.ts](../../rotom/extensions/context-layers/recall.ts) | B 的检索直接复用，不另做导出；A 需补全搜索覆盖 |
| Context Layers 摘要以 `[Context summary <id>, tier <n>. … recall exact details with context_recall.]` 呈现，由 Pi 原生 `context_edit` 投影 | [copy.ts](../../rotom/extensions/context-layers/copy.ts) | 旧会话中已有摘要在扩展精简后仍会显示，需保留按块 ID 回查（3.3） |
| Goal 每次自动续跑的提示都包含完整目标（“The full objective persists across turns”） | [Goal prompts](../../packages/rotom-goal/src/prompts.ts) | Goal 续跑边界是后续可考虑的轮转点（第 9 节之后的阶段 2），首版不做 |

实现分为 Pi fork 中三处通用接缝与一个 rotom 扩展，结构见第 8 节。

## 分册

本方案较长，按职责拆成多份，节号与原设计一致：

- **A. Context Layers 精简**（第 3 节）：[session-rollover-context-layers.md](session-rollover-context-layers.md)
- **B. 轮转规则、条目、与压缩的关系、失败语义**（第 4–7 节）：[session-rollover-rules.md](session-rollover-rules.md)
- **实现结构**（第 8 节）：见本节之后

## 8. 实现结构

### 8.1 Pi fork：三处通用接缝

只提供能力，不含 rotom 策略（水位、资格、摘录、开关都不在 Pi 内）：

| 接缝 | 内容 | 为什么扩展现有 API 做不到 |
| --- | --- | --- |
| 可等待的“重置上下文” | `ExtensionContext` 新增方法（名称由实施者定，建议 `resetContext({ summary, details })`），仅在空闲且处于 `input` 处理器内可用，否则拒绝；以 `reason: "rollover"` 发出 `session_before_compact`（处理器可取消，返回的替代 `compaction` 被忽略），写入 `firstKeptEntryId` 指向自身的压缩条目，发出 `session_compact`；返回成功、被取消或失败；不调用 `abort()` | 现有 `ctx.compact()` 不等待完成且先 `abort()`，在 `input` 中调用会与本次提交竞争；扩展只有只读 SessionManager，返回的压缩结果无法让 `firstKeptEntryId` 指向自身 |
| 压缩事件阶段 | `session_before_compact` 增加阶段字段，至少区分“下一次请求前”（`prepareNextTurnWithContext` 与 `_prepareRun`）、“运行结束后”（`_handlePostAgentRun`）、手动/扩展请求与轮转；`reason` 增加 `"rollover"` | 轮内与轮末阈值压缩的 `reason` 都是 `threshold`，扩展无法只延后轮末那次 |
| 估算与呈现 | 从 `_checkCompaction` 抽出共用的阈值估算，并以只读方式提供给扩展（新增方法或扩展 `getContextUsage` 的返回，不改变其现有字段语义）；压缩条目 `details.kind === "rotom-rollover"` 时投影使用专用前缀 | `getContextUsage()` 使用投影估算、压缩后返回 `null`，与 `_checkCompaction` 的 usage 优先估算不同；`COMPACTION_SUMMARY_PREFIX` 无法由扩展替换 |

这些都是 Pi extension API 的新增能力，CHANGELOG 记录；现有字段语义不变。Pi 源码改动后按仓库合同 `build:pi`、`check:pi` 并提交重建后的归档与 lock，fork 版本号不变（与既有 fork 修复提交一致）。

### 8.2 rotom 扩展 `rotom/extensions/session-rollover/`

| 职责 | 实现 |
| --- | --- |
| 开关 | `ROTOM_SESSION_ROLLOVER=1` 时注册，未设置或其他值不注册任何处理器；不增加水位、百分比或模式配置 |
| 判断 | `input` 处理器：按 4.1 的共用估算与水位、4.2 的资格判断；`context_recall` 是否在当前可用工具中由此判断 |
| 写入 | 生成 5.1 的检索说明与尾部摘录，调用 8.1 的重置接缝；失败按 7.2 退回 |
| 延后轮末压缩 | `session_before_compact` 中，阶段为“运行结束后”、`reason` 为 `threshold`、且具备 4.2 资格时取消；其余一律不干预 |
| 产品声明 | 在 `product-config.mjs` 中声明，位置在 `third-party` 之前：handler 按扩展加载顺序执行且首个取消即返回，保证轮末取消先于 Offload 生效 |
| 文案 | 轮转提示、取消原因集中在扩展的 copy 模块 |

实现回填（与上文表格的差异，理由见[回报的决策记录](session-rollover-report.md)）：扩展不能从 Pi 包做值导入，`details.kind` 与虚拟模型 API 标识在扩展内各镜像一份；摘录预算用扩展内 `chars / 4` 估算而不是 Pi 的估算器；轮末判断不检查空闲（刚结束的运行必然不空闲），只检查队列；`input` 文本以 `/` 开头即视为本地命令跳过。

### 8.3 与 Context Layers 的关系

检索留在精简后的 `context-layers` 扩展，不并入轮转扩展：检索默认开启并服务于原生压缩后回查和旧会话摘要，轮转默认关闭且可能整体撤回；两者只通过“`context_recall` 是否可用”这一条资格相连，不共享代码与状态。轮转实测通过并改为默认开启后，再评估合并为一个上下文扩展及旧标识的兼容迁移。

不改 npm 版本，不改现有自动压缩默认，不覆盖存活会话安装。

## 9. 验证与启用条件

第 9、10 节（验证、启用条件与已知限制）见 [session-rollover-verification.md](session-rollover-verification.md)。

# 工具面合同

本文件是 `CLAUDE.md` 第 3 节的完整合同。修改工具面、Goal、Context Layers 或其默认行为前必须完整阅读；源码路径均相对仓库根。

Context Layers 是用户明确要求独立实现并默认启用的新产品 extension（`ROTOM_CONTEXT_LAYERS=0` 可关闭），不是恢复旧 `ROTOM_CONTEXT_FOLD`。提供 `context_status` / `context_compress` / `context_recall` 三个 sequential、model-only 工具；使用 Pi session 原始条目和 `context_edit`，最多三级摘要，成功 turn_end 才提交，不覆盖原文。恢复只读当前分支；中断多条追加可能留下 partial，不能自动重放或冒充原子事务。默认开启不代表节省费用：Qoder 恢复测试通过，小型对照 credits 更高。合同、证据和限制见 [Context Layers](context-layers.md)。

默认 deferred-tool loading 常驻 core、Codemode、Ask、Browser/Computer Use、Goal 四工具、Context Layers 三工具与 `search_tools`，只把 Subagent 按需 additive 激活。内置 SoL-Pi 在无用户配置文件时默认开启 Action Fusion（替换 `edit`/`write`）、Observation Pack（`obs_recall`）与会额外请求 `openai-codex/gpt-5.6-luna` 的 Reducer；Compaction Offload 默认开启（`ROTOM_COMPACTION_OFFLOAD=0` 关闭）：阈值压缩前先把旧的中等工具结果换成 `obs_recall` 指针，空间够就推迟原生摘要；回放实测见 `docs/agent/compaction-offload.md`；内置 pi-context-view 只加 `/context` 命令。Goal `0.54.4-rotom.9` 默认自动额度为 100 次模型响应（显式用户设置优先），剩余额度与最后记录的续跑计划仅供状态展示，不证明进展、不授权重放；从启动起保持四个稳定 schema；工具可见不等于 Goal 模式启用，无 active goal 时拒绝执行，也不覆盖显式工具限制。默认要求 `goal_continue` 显式声明单次续跑；缺失声明暂停，控制调用不算进展。Provider 恢复只由 Pi 统一有界重试，Goal 不叠加重试；恢复中公开 activity，耗尽后以持久 stopReason 暂停，不再伪装无截止的 active 等待。唯一例外是可证明请求未发出的连接阶段失败（DNS、拒绝/不可达连接、连接超时、代理隧道或 TLS 建立失败，错误显示为 `… (caused by: <socket 原因>)`，及 `Qoder: connection_failed`）：参照 Codex 只对 connect 错误无限重试，Pi 以同一封顶退避等待网络恢复，不占 `retry.maxRetries` 额度，TUI 显示 “Reconnecting... waiting for network”，用户中断或 `retry.enabled:false` 才停止。无原因的 `fetch failed`、发送后重置（可能已被处理计费）与流中断开（`terminated`、WebSocket、超时）仍走有界预算。会话恢复暂停非 waiting 的活跃目标；idle active 可显式 resume，但不得抢占运行、恢复或已排队工作，也不重放保存计划或成功/unknown 工具操作。共享提示合同先查证目标、验收与写入边界；缺少授权或关键决策时立即询问并暂停，不凑三轮技术 blocker；重试须有新证据或可检验假设；三轮只限制 `goal_blocked`，已证实外部前置条件且无有意义的下一步时直接暂停，不为凑轮次重复检查。外部写入 unknown 只读核验、不盲目重放；审阅拒绝只表示验收未获支持，不授权重做成功/unknown 写入，缺证据先只读核验，无新证据或合理修复则暂停。这是模型行为指引，不是权限拦截器，不缩小原始目标或降低完成标准。`goal_complete` 默认启用有界、当前模型、文件只读的 completion reviewer，不创建嵌套 AgentSession、不加载项目资源；额外用量单列且计入 Goal token admission，USD/credits unknown。审计尝试先持久化、unknown 不重放、resume/edit 不补额度，结果绑定当前 Goal/run 及实读证据；是第二意见，不是真实外部验收或 OS 沙箱。明确的用户设置 `completionReview:false` 可关闭 reviewer。它是 context-footprint 优化，不是安全沙箱。

- Pi 基线为 `1.4.0-rotom.2`（上游 `v1.4.0` 合并，见 [Pi 1.4.0 对齐](pi-1.4-migration.md)）；Codemode 独立启用。上游分类模型/API、虚拟模型路由 API 与内置 MCP 均保留：产品不自带分类器调用或虚拟模型，只有扩展注册虚拟模型或用户在 `mcp.json` 配置 server 时才生效；`rotom mcp …` 与 Pi 包管理命令一样原样透传。Goal/Ask/Subagent/Browser/Computer Use 使用 `model-only`，不可从 Codemode 嵌套调用；普通文件工具仍可编排。显式工具选择仍优先。
- Goal 预算计入已报告的 tool-result/model/summary usage；旧 Goal 基线一次迁移、不追收历史辅助用量。reviewer 使用当前选中的普通模型，不进行分类或自动路由；没有选中模型保持 unknown。
- `ROTOM_DEFERRED_TOOLS=0` 必须恢复完整工具面。
- 用户显式 `--tools`、`--exclude-tools` 或 runtime policy 优先；launcher 仅在没有 tool-selection flag 时授权 loader 收窄 reviewed default，extension/SDK 直载默认保留调用方 active set；用户 extension 新增的非 deferred 工具同样保留。
- 已加载 specialized tools 在当前 session 内不主动移除；group state 与 active tool 子序列按 product declaration order canonicalize，相同 group 集合不因加载顺序产生不同最终 identity。
- resume/fork 必须恢复 capability state；升级前无 deferred state 的旧 session 允许首次多一次 `search_tools`。
- 不把静态 bytes、byte/4 或固定 canary 写成 provider 精确 token、成本或全局延迟收益。
- 新能力只有接入完成并通过对应 L1/L2/L3 后才能对外声明为已启用；当前事实以运行时合同、测试和本文件为准。

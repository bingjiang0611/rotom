# External CLI 采用合同：调度释放不等于恢复授权

> **历史设计与采用合同**：下文“当前安装 `.2` / 仅 opt-in”描述第十二批结束时的状态。后续已内化 `pi-subagents`（当前 `0.52.1-rotom.2`），并从 `alpha.3` 起由 launcher 默认启用 scoped 执行，见 [当前默认与限制](subagent-owned-default.md)。本页保留采用过程、授权范围与证据，不作为当前安装操作指南。

**状态：隔离首版采用门已通过；仅供显式 opt-in 的新隔离会话，不是当前默认运行时合同。** 用户在第四批采用审查后选择“先重设采用合同”；本文件确定设计与验收线，不授权立即更新依赖、放宽旧记录、迁移活跃会话或修复本机 VM。当前仍安装 Subagent `.2`；[第五批实现](../../rotom/extensions/third-party/history/subagent-owned-execution.md) 已支持有证明的 runner 槽位释放；[第六批证据](../../rotom/extensions/third-party/history/subagent-owned-workflow.md)增加显式 async child 的 workflow/controller 封存与 lineage；[第七批](../../rotom/extensions/third-party/history/subagent-owned-foreground.md)补了 fresh single Pi foreground 的 writer/group/lease 与双屏障。[第八批](../../rotom/extensions/third-party/history/subagent-owned-store.md)增加显式初始化的 namespace、store 身份和跨版本共享 lease。[第九批](../../rotom/extensions/third-party/history/subagent-owned-session.md)证实旧 reader 能回收第八批的 v1 未决 lease，改为 v3 store/session 根绑定、旧 reader 不可读的 v2 lease，并补 async Pi/native revival 的强关管道负例。[第十批](../../rotom/extensions/third-party/history/subagent-owned-flat.md)补了首版 pre-writer admission、真实公开 single 入口、显式工具/扩展与初始化 CLI；[第十一批](../../rotom/extensions/third-party/history/subagent-owned-linux.md)完成独立授权 Linux 真进程矩阵，并纠正第九/十批类型配置范围、按实际候选补跑；[第十二批](../../rotom/extensions/third-party/history/subagent-owned-readiness.md)补齐真实 npm 入口的 startup/wait/drain 与 native lease 历史证明问题；独立 `.owned-flat.7` 归档、私有 metadata/integrity 同步及 macOS/Linux 实际安装验收通过，当前维护安装仍未切换。第四批见 [历史候选](../../rotom/extensions/third-party/history/subagent-external-group.md)。

## 首版范围：用户已明确收窄

用户在第九批后选择“明确收窄首版范围”：首版只采用已验证的执行拓扑，其余路径必须在启动 writer 前明确拒绝，不能先启动再长期占槽。此前矩阵中 nested/worktree/gate/imported-root/external-job 的正面支持不再是首版要求；保留为后续能力，不能暗中恢复或把拒绝当作正面支持。

首版隔离候选保留单个 async Pi/external CLI、后台 workflow controller 下的独立 async Pi/external CLI 与 fresh single foreground Pi，以及已有关闭证明的 Pi-only native async resume。chains/tasks、nested、worktree、host gate/verification/review、fork/import、external-job、独立 foreground 与 foreground workflow controller 须在 admission 前拒绝；配置/agent 默认、workflow 动态子调用和恢复入口也不能绕过。workflow 子调用被拒绝后，其无 writer 的 controller 必须能释放自身槽位。Pi agent 还须显式列出工具和 extensions，不以 ambient discovery 隐式引入 nested；非法运行模式值及调用者伪造的 workflow 身份也须拒绝。macOS/Linux 当前候选与实际 npm 入口验证均已通过，**独立 `rotom@0.1.0-owned-flat.7` 可按本首版范围采用**；不扩大为当前安装已升级、远端效果已验证或旧会话已迁移。

该授权只改变首版功能范围，不降低 unknown/lease/replay/retention、身份、公开披露、macOS/Linux 验证线，不授权迁移活跃会话、推送或切换依赖。

## 1. 问题不是缺少一个强制释放按钮

第四批候选诚实地保留 external 全图 `unknown`，但同时用它决定任务恢复、并发槽位和记录清理，导致普通 external CLI 正常结束也可能永久占用有限槽位。

代码中的三个机制其实不同（路径相对 `rotom/extensions/third-party/node_modules/pi-subagents/src/`，仅作定位，不在 installed source 修改）：

| 现有机制 | 实际作用与局限 |
|---|---|
| `runs/background/process-terminal.ts` | 对 runner/writer、session lease 与持久化证据作投影。旧 `observed` 不能推出任意逃逸后代或远端副作用结束。 |
| `runs/background/active-async-capacity.ts` | 通过 token、generation 和 run identity 管理槽位。runner 释放依赖匹配的 observed proof；workflow 还核对 controller 与 async children。 |
| `runs/background/active-run-index.ts`、`async-status.ts` | `.active-runs` 是发现索引；终态更新、列表维护和超过 24 h 的 marker 均可能触发移除。索引消失不证明执行关闭，也不等于 capacity slot 已释放。 |
| `runs/background/async-resume.ts`、`runs/foreground/subagent-executor.ts` | target 选择后可能 transfer capacity、生成新 run ID、启动 revival writer。只挡公开 `resume` 不够，内部 recovery/attach/steer 路径也必须核验。 |
| `runs/background/async-retention.ts` | age/任务终态不能作为 writer 关闭证明；第四批补了独立的 external evidence 保留条件。 |

结论：**不能靠清空 active index、扩大容量上限、自动过期或把 unknown 改 observed 解决采用问题。**

## 2. 设计决策：拆分证据与许可，不新增调度框架

保留现有执行器、capacity owner、terminal sidecar 和结果记录；在同一持久化合同中增加带版本的明确 scope，不建第二套任务树、全局 writer registry、Job 服务或权限工具。

以下名字表示采用合同的证据维度，不是当前 installed API；隔离候选的实际字段映射见第五至十批记录：

| 维度 | 要回答的问题 | 不得外推为 |
|---|---|---|
| `taskResult` | 请求的计算是否产生正常/错误/取消结果？ | writer 关闭、业务效果成功 |
| `ownedClosure` | 创建期登记的 runner、直接 writer、其受控进程组以及本任务拥有的 lease 是否全部关闭/释放，证据是否持久化？ | 任意 setsid 后代、远端操作结束 |
| `descendantCoverage` | 对受控组之外的任意后代，是否有额外覆盖机制？普通 POSIX 组为 unverified。 | “没发现逃逸”就等于没有逃逸 |
| `effectVerification` | 本次请求关心的文件/对象/远端业务效果是否已按原 scope 回读？无回读为 unverified。 | 进程 exitCode 为 0 就算业务成功 |
| 派生许可 | capacity 是否可释放、原任务是否可恢复、记录是否可清理？ | 任一维度成功便全部放行 |

普通 external CLI 的可接受正常结论可以是：**任务结果完成；受控执行资源关闭；组外后代未覆盖；业务效果未核验。** 这不是失败，也不是全图安全证明。UI/模型可见结果必须同时保留这些区别，不显示笼统“安全完成”。

### 版本与兼容

- 不重新解释现有 v1 `processTerminal.state=observed`，也不让旧消费者把新 scope 当旧全图证明。新增证据采用明确的新版本/字段，具体编码在实现时与所有 reader 同步确定；foreground controller 的完成必须与 OS runner close 区分，不能伪造不存在的 runner。
- 四批候选的全图 unknown 继续保留；新的受控资源证据不能覆盖它。
- `maxActiveAsyncRunsPerSession` 的旧释放语义**不能在普通补丁中悄悄改变**。新的“受控执行并发”语义属于显式采用合同升级；只有新安装、新建 run 且声明新 scope 才可使用。
- 旧 run/旧 session 缺少创建期 roster、scope 或持久化关闭证据时，保持旧保守行为。只读展示历史，不按历史 PID 补杀，也不回填新的 observed。
- 此设计不是接受第四批候选原样上线。新 scope 必须在隔离源码实现、验证和审查后才能采用。

## 3. 并发容量：只对已证明关闭的受控资源释放

新 scope 下，capacity 衡量的是**由当前执行器拥有的活动执行资源**，不是机器上所有潜在副作用或任意逃逸进程数量。该范围必须对用户明确；不能声称它限制了所有真实 writer。

释放必须同时满足：

1. 本 run 的创建期 writer roster 完整，绑定 run ID、runner process instance、各 writer attempt 与 capacity reservation token/generation；不能用“缺字段”表示零个 writer。
2. 已登记的每个直接 writer 均有真实 close 观察，受控组有正面的 terminal 证据。强关管道、父 workflow 完成、读到 result 文件、空/损坏 `ps` 都不满足。
3. Pi writer 还需核对 canonical session lease；lease active/unavailable 均不释放。external 与 Pi 混合时逐个核对，不能只看最后一个 step。
4. 该 run 的 controller/runner 不会再派生工作；workflow controller 已结束，所有异步 child 的受控关闭证据已收齐。父结果 complete 不是 child 屏障。
5. 证据先私有、原子、持久化，再以既有 slot claim/token/generation 执行一次释放；写盘失败、身份漂移或跨页 partial 信息均保留槽位。

**ownedClosure 为 unknown/pending 时，槽位仍保留。** 仅 descendantCoverage unverified、但上述受控资源关闭全部成立时，新合同才允许释放调度槽位，且保留 unresolved evidence 和恢复限制。

这是明确的调度范围变更，而不是证明所有 writer 结束。未知逃逸进程仍可能与后续任务冲突；rotom 没有 sandbox，不能承诺跨任务绝不干扰。

## 4. 恢复与重放：与容量释放分开

- `resume` 不是“读历史”，它可能启动新的 writer；同样审查 recovery、steer fallback、attach 和 workflow 子入口。必须在状态修复、slot transfer 或 spawn 前判定。
- 原 external run 的 unknown 写入不能因为槽位释放、重启、fork、换 run ID 或用户点了“知道了”而自动重放。
- 普通 external CLI 不承诺原生会话 resume。首先支持只读 status/结果读取；缺少可验证的恢复协议就拒绝，而不是换成 Pi writer 接着执行原命令。
- 新的、独立用户任务可按新并发 scope 申请槽位；这不构成对旧任务的恢复授权。无法确认独立性、仍是在重试原副作用时，停止并澄清。仅“换了 cwd/agent 名称”不能证明独立，更不能宣称是隔离。
- 对混合 run，不因选择 Pi index 就绕过 external sibling 的未决关系。第一版保留 run 级恢复 fence；只有后续能证明原任务依赖、writer 所有权和 effect scope 的边界时才考虑更细粒度恢复。
- 正常成功的 external 结果可以被读取、展示或作为用户明确新任务的上下文；不能将“有结果”自动转成执行续跑队列。

## 5. 人工解除：知情不是验证

不新增通用 `force=true`，不教模型通过删文件/提高上限解除 fence。操作分三类：

| 人工操作 | 允许改变 | 不允许改变 |
|---|---|---|
| 已阅/接受仍有组外风险 | 展示中的已阅状态、对新独立任务的明确授权 | ownedClosure、业务验证、原 run 恢复许可 |
| 对原对象做有权威来源的只读核验 | 带来源和 scope 的验证记录；满足对应合同后重新派生许可 | 将旧 PID 当前不存在、单次负搜索或口头声明当全图证明 |
| 明确放弃旧任务 | 任务意图标为 abandoned、不再自动跟进；保留原结果与未知证据 | 杀进程、删除活跃状态、制造 observed，或启动替代 writer |

若真实仍有 writer，人工终止是另一项需授权的本机/外部操作，必须绑定当前可证明身份；一次派发后回读，结果未知不盲重放。这里只定义解除所需证据，不提供新的强杀入口。

operator-reported 和 machine-observed 必须分开显示。日志中只记录 allowlisted ID、scope、来源类别、时间和 disposition，不把操作正文、凭据或业务回读内容写入 metadata trace。

## 6. retention 与存储压力

- active index、capacity owner、terminal proof 是不同事实；任何一方消失都不能当作解除另两方的许可。
- 调度槽释放后，未决 descendant/effect 证据仍保留；默认 TTL 不删除这些记录，也不把 age 升级为验证成功。
- 当前阶段不新增一套压缩/归档系统：沿用现有 retention，保护未决记录。已阅/abandoned 也不是清理授权。
- 长期记录增长是保留的代价，不能藏起来。若需要显式归档，必须先设计最小 durable fence 与 crash-safe 转移，保证 result-only、status 缺失、原路径变化仍不能恢复出替代 writer；未实现前不自动归档。
- 存储不足时在 admission/持久化处诚实 fail closed；不靠删除未决记录或扩大并发上限掩盖问题。

## 7. 必须通过的采用矩阵

以下保留原完整拓扑矩阵。按上方用户确认的首版范围，未支持拓扑的对应验收改为“writer 启动前拒绝、无未知任务重放、无拒绝导致的悬空容量”；其余行仍是首版必需门禁。不是全部已通过结果；第四批 67/67 不覆盖新增调度语义，第五至十批的本机部分验证也不能代替整张矩阵。

| 场景 | 新 scope 下容量 | 原任务恢复/证据 |
|---|---|---|
| 正常 external，runner/direct close/组终止/roster 完整 | 释放一次 | 组外 unverified 保留，不承诺 native resume |
| stop/timeout，所有受控资源正面关闭 | 释放一次 | 取消不等于业务回滚，不自动重放 |
| 直接 writer 退出但有同组后代 | 清理并核验前保留 | 不因 direct exit 宣称完成 |
| setsid escape，ownedClosure 完整 | 可按新 scope 释放 | 保留风险；负对照放行后仍可写入，原任务不能自动重放 |
| escape 持有管道，只有强关管道而无真实 close | 保留 | unknown，不能靠 UI 确认解除 |
| `ps` 不可用、EPERM、缺 roster、proof 写失败、lease active | 保留 | 必要清理一次；最终证据不足仍 unknown |
| Pi-only run（新旧合同） | 原有可验证关闭行为不退化 | lease/revive 单 writer 合同保持 |
| 混合 run / 嵌套 workflow / 父先完成 | 等全部登记 owned children 关闭 | 不能借 Pi index 或父 complete 绕过 fence |
| 并发 release/transfer、旧 generation、crash/reload | 不重复释放，不把别人的 slot 释放 | 新 run 与 source lineage 均核验 |
| result-only、candidate-only、缺 status/index、retention TTL | 无新关闭证据就不追加释放 | 未决 fence 不丢失，不产生替代 writer |
| 超过并发上限数量的顺序正常 external runs | 新合同不因纯 scope-unverified 耗尽槽位 | unresolved 仍可查，无自动重放 |
| 明确独立的新任务 vs 换 ID 重试原任务 | 仅受控资源容量满足时可 admission | 独立授权不能伪装为原任务验证成功 |
| 已阅/abandoned 与人工可核验 closure | 区分接受风险与真实证明 | 原始 unknown 不被擦除，来源可追溯 |
| 老 run / 活跃会话 / 旧 proof | 不隐式迁移 | 不补造创建期 ownership |

本矩阵按首版范围的采用结果、当前源摘要、真实/合成边界、失败历史与唯一归档身份见[第十二批证据](../../rotom/extensions/third-party/history/subagent-owned-readiness.md)。当前维护 manifest、vendor 与 installed source 未切换；用户授权的交付面是独立产品副本。

macOS 与 Linux 均需真实本机/容器进程回归；Linux 测试需独立且明确授权的可用环境，不自动修本机旧 VM 磁盘。Windows 不在当前 rotom 产品 OS 范围，unsupported 分支应 fail closed，但不以此冒充 Windows 真机验证。模型 A/B、远端副作用和生产操作另行授权。

## 8. 最小落地顺序与完成线

1. 在隔离候选中补新版本创建期 roster 与 ownedClosure proof；先保证 reader 不误解旧 observed。
2. 让 existing capacity verdict 只对**明确采用新 scope 的 run**使用受控关闭证据；resume/transfer 与 retention 独立保留 fence。第四批回归保留为旧候选合同，新增新 scope 的矩阵，不能偷偷改旧断言让它变绿。
3. 无模型重放 Pi-only、external、混合与 nested controller，验证并发、lease、crash/reload、result-only 和超限数量顺序任务。不得用合成矩阵替代真实 writer 路径。
4. 通过 macOS/Linux gate、完整候选类型与公开 loader 检查后，审查用户可见的 scope/限制、版本兼容与包身份；再决定同步 archive/package/lock/integrity。安装只验证新会话，不承诺升级存活会话。

**完成线：正常受控任务可持续运行；未知 owned writer 不被释放；已释放槽位不能授权重放旧未知写入；未决证据不丢；所有结论有明确 scope。** 这些条件必须同时满足，不能把可用性和诚实性二选一。

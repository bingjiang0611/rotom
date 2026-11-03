# Computer Use v2 技术方案（macOS 第一期）

状态：第一期范围已定，2026-11-03。本文件是执行时的权威版本。讨论稿在 claude.ai 文档《rotom Computer Use 技术方案》，两者不一致时以本文件为准。

背景：差距分析见 claude.ai 文档《rotom Computer Use 差距分析》。结论是 rotom 的观测与结果语义（stateId、epoch、渐进展开、worked/didnt/unknown、后置条件、严格 headless）已经扎实。缺的是安全与用户控制层、动作覆盖面、可观测性，以及跨进程的多 agent 仲裁。

## 1. 目标

1. 补齐差距分析里 P0、P1 的能力：App 授权与分级、停止、宿主排除、敏感动作确认、App/窗口管理、剪贴板、语义控件动作、系统表面、trace。
2. 多个 agent（主会话、subagent、多个 Pi 会话）可以同时在后台操作**不同的** App。
3. 后台运行时不影响用户：不抢焦点、不移动系统光标、按键不漏进用户正在用的 App、不吞用户输入。

## 2. 已定决策

| # | 问题 | 决定 |
|---|---|---|
| D1 | 平台 | 第一期只支持 macOS。Windows、Linux 的 helper 保持原样，不接入 Broker，也不加新能力 |
| D2 | 浏览器默认授权级别 | `full` |
| D3 | 两个 agent 抢同一个 App | 立即返回 `resource_busy`，带持有者 agentId 和剩余时间。`wait: true` 时进 FIFO 队列，最长 30 秒 |
| D4 | trace 是否保存截图 | 默认保存。目录 0700、文件 0600，默认保留 7 天、单会话 500 MB，超出时清理最旧的；可通过 `trace_screenshots: false` 关闭；永不上传 |
| D5 | Broker 的实现语言 | **Node（TypeScript）常驻进程**，Swift helper 只做执行器。这样仲裁、策略、trace 这些核心逻辑可以在任何平台上做单元测试，Swift 改动只限于原生能力 |

D5 是相对讨论稿的调整：讨论稿写的是“把 Swift helper 升级成 Broker”。改成 Node 以后，大部分逻辑不依赖 macOS 真机就能验证，执行 agent 可以更多地自主完成。

## 3. 现状约束（读代码确认）

- `src/runtime.ts` 的 `ResourceScheduler` 是**每个 Pi 进程一份**。subagent 由 `rotom-subagents` 用 `child_process.spawn` 起子进程，各有各的调度器和 epoch，跨进程写同一个 App 时 stale 检测失效。
- macOS helper 是 `~/Library/Caches/pi-computer-use/bridge.sock` 上的共享 daemon，`physicalInputLock` 全机唯一，但它只防止事件交错，不防止两个会话抢同一个 App。
- macOS 的坐标点击和按键默认走 `hid` 投递（先 `activate()` 再发到 `cghidEventTap`），这就是抢前台。唯一真正后台的键盘路径是 `native/macos/background_text.swift`（SkyLight 合成 key window），而且只对 `com.jetbrains.intellij` 开放。
- 没有任何策略层：没有 App 授权，没有停止键，没有排除宿主终端。

## 4. 架构

```
Pi 进程 A ─┐                      ┌─ trace 存储 (~/.rotom/computer-use/traces)
Pi 进程 B ─┼─ broker.sock ─ Desktop Broker (Node) ─┼─ policy.json
subagent C ┘   (JSON-lines)        │                └─ 审批路由（转给有 UI 的祖先会话）
                                   │ lease token + 撤销推送
                                   ▼
                          macOS helper (Swift, bridge.sock)
                          AX / SkyLight / ScreenCaptureKit / 菜单栏状态项 / 事件监听
```

- **Broker**：每个登录用户一个，socket 位于 `~/Library/Caches/rotom-computer-use/broker.sock`（测试可用 `ROTOM_CU_BROKER_SOCKET` 覆盖），所在目录 0700、socket 0600。由第一个需要它的 Pi 进程拉起（detached，带启动锁防止重复启动），所有 agent 断开后空闲 10 分钟自动退出。
- **信任边界**：同一用户。Node 拿不到 socket 对端 pid，所以不宣称能防同用户恶意进程；靠目录权限挡住其他用户。文档里要如实写明。
- **执行路径**：Pi 进程仍然直接调用 helper 执行动作（不经 Broker 转发，避免多一跳延迟），但写操作前必须从 Broker 拿到 lease token。第一期 M2 是协作式约束（我们自己的客户端遵守）；M5 起 helper 用共享密钥校验 token（HMAC，含 agentId、resourceKey、epoch、过期时间），并接收 Broker 推送的撤销列表，做到强制。
- **ResourceScheduler**：保留为进程内排队，但 `write()` 的 epoch 以 Broker 为准。`ROTOM_CU_BROKER=0` 回退到现在的进程内行为。非 macOS 平台默认关闭 Broker。

## 5. 租约与并行

| 资源 | 粒度 | 规则 |
|---|---|---|
| App 写租约 | 进程（pid + 进程启动时间，防 pid 复用） | 同一时间只有一个 agent 持有。observe / read_text / search 等读操作不需要租约 |
| 全局物理输入租约 | 全机唯一 | 只在前台接管模式（L4）发放 |
| 剪贴板租约 | 全机唯一 | 写剪贴板时需要，持有时间按秒计 |

生命周期：
1. 第一次对某个 App 执行 `act_ui` 时隐式获取，默认 TTL 60 秒，每次动作续期。
2. 冲突按 D3 处理。
3. 显式 `release`、TTL 到期、agent 断开（socket 关闭或 10 秒无心跳）都会释放。断开时未完成的批次结果记为 `unknown`。
4. Broker 维护每个资源的全局 epoch。别的 agent 写过之后，旧 stateId 再写会得到 `stale`。
5. 父 agent 可以在 spawn subagent 时声明 `apps: [...]`，把租约转交给 subagent，避免父子死锁。

不允许多个 agent 同时写同一个 App：同一进程只有一个 key window 和一个 first responder，并发输入必然互相干扰，冲突就明确报错。

## 6. 后台投递阶梯

每个动作按顺序选择投递方式，前一级可用就不往下走。后台策略（launcher 默认 headless）只允许 L1 和 L2。

| 级别 | 机制 | 对用户的影响 | 第一期 |
|---|---|---|---|
| L1 语义 | AX action / attribute | 无 | 做 |
| L2 定向事件 | 只发给目标进程的 SkyLight 合成事件，不经过全局事件流，不移动系统光标 | 无（需逐类 App 验证） | 做，按兼容白名单开放 |
| L3 隔离显示 | macOS VM | 无 | 不做 |
| L4 前台接管 | 激活窗口 + 全局 HID | 有 | 做，但只在用户空闲且授权时 |

L2 细节：
- 把 `background_text.swift` 的合成 key window 方案推广为通用的定向键盘与鼠标通道（`SLEventPostToPid` 一类的定向投递，事件带窗口号和窗口内坐标）。
- 每个合成事件写入 `eventSourceUserData` 标记（例如 `0x524F544F`），用户活动监听据此区分 agent 事件和真实用户输入。
- 兼容白名单放在 TS 侧 `src/policy/l2-compat.ts`，按 bundle id 或 UI 框架分类。初始只有 IntelliJ，阶段 0 的兼容矩阵出来后再扩充。不在白名单里的 App 不走 L2，做不到的动作返回 `foreground_required`。
- 私有符号运行时解析，缺失时禁用 L2，而不是回退前台（沿用现有原则）。

用户活动检测：
- helper 常驻一个 listenOnly 的 `CGEventTap`，统计不带 agent 标记的输入，把 `lastUserInputAt` 推给 Broker。
- 每个动作前后比较前台 App 和焦点窗口。动作后前台变了，并且用户最近 2 秒内有输入，就暂停该 agent，结果标记 `interfered_with_user`。
- 后台模式下系统光标位置绝不改变。这是验收的硬指标。

## 7. 安全与用户控制

全部在 Broker 里实现，所以对所有 agent 一致生效。

- **App 授权**：三种决定（本次会话允许、始终允许、拒绝）。全局配置 `~/.rotom/computer-use/policy.json`，项目级 `.pi/computer-use.json` 只能收紧不能放宽。
- **分级**：`view`（只能观测）、`click`（press/click/scroll/select/expand/setChecked/scrollTo/showMenu，不能输入文本、按键、写剪贴板）、`full`。默认分类：浏览器 `full`（D2）；交易与银行类 `view`；终端与 IDE `click`；其他 `full`。分类表在 `src/policy/catalog.ts`，可配置。
- **高危提示**：终端、IDE、Finder、系统设置、密码管理器在授权卡片上单独警告。
- **审批路由**：Broker 把审批请求转给发起 agent 最近的、有 UI（Pi `hasUI`）的祖先会话显示。没有可用 UI 时拒绝，返回 `approval_unavailable`。模型自己不能批准。
- **排除宿主**：注册时上报 pid 祖先链。Broker 解析出宿主终端 App，并把它、rotom 自身、helper、cursor 覆盖层从 `find_roots` 结果和截图里剔除，也拒绝以它们为目标。
- **停止**：helper 提供菜单栏状态项，列出每个 agent 和它占用的 App，可以单独停或全部停。另有全局快捷键 `Ctrl+Option+Cmd+.`（可配置），只消费这一个组合键。只有前台接管模式下才额外吞掉 `Esc`。停止后 Broker 撤销该 agent 的所有租约，进行中的批次在下一个步骤边界停下，结果为 `stopped_by_user`，已投递的步骤如实报告。
- **前台接管（L4）**：同时满足以下条件才发放全局物理输入租约：用户授权过该 App 的前台模式；用户空闲超过 10 秒，或用户主动点了“让它接管”；没有别的 agent 持有接管租约。接管期间显示全屏边框并吞 `Esc`，检测到任何真实用户输入立刻收回，结果为 `preempted_by_user`。
- **敏感动作确认**：按目标元素文本（中英文：删除、发送、支付、提交订单、修改密码、Delete、Send、Pay 等）和 App 类别匹配规则，命中时在投递前请求确认。规则可配置，默认开启。secure text field 一律拒绝写入。

## 8. 工具面

核心工具保持不变。新增工具全部走 deferred-tools，常驻 guideline bytes 不变。

`act_ui` 新增动作：

| 动作 | 说明 | macOS 实现 |
|---|---|---|
| `select` | 选中列表项、tab、表格行，或下拉框选项（`option` 文本） | AXSelected / AXSelectedChildren |
| `setChecked` | `checked: true/false`，幂等 | AXValue |
| `expand` / `collapse` | 树节点、折叠面板、下拉框 | AXExpanded / AXDisclosing |
| `scrollTo` | 把元素滚入可见区 | AXScrollToVisible |
| `focus` | 只设焦点，不激活 App | AXFocused |
| `clear` | 清空可编辑控件 | 显式的空 setText |
| `setValue` | 滑块、步进器的数值 | AXValue / AXIncrement / AXDecrement |
| `showMenu` | 打开右键菜单 | AXShowMenu |
| `hover` | 悬停 | L2 定向 mouseMoved，否则 `foreground_required` |

新增工具（deferred）：

| 工具 | 能力 | 备注 |
|---|---|---|
| `manage_app` | `list` / `launch`（后台，`activates=false`）/ `quit`（礼貌退出，可选强退） | quit 走敏感确认 |
| `manage_window` | `list` / `move` / `resize` / `minimize` / `restore` / `maximize` / `list_displays` | 全部不 raise；`focus` 只在接管模式可用 |
| `clipboard` | `get` / `set` / `clear` | 单独授权；`set` 后默认 30 秒恢复用户原剪贴板（可关）；后台优先建议用 setText |
| `system_surface` | 通知列表与操作、菜单栏 extras、Dock | 通知中心、SystemUIServer、ControlCenter、Dock 的 AX 树 |
| `cu_session` | `status`（谁持有哪个 App）、`release`、`trace_export` | |

结果新增字段：`deliveryLevel`（L1/L2/L4）、`leaseHolder`、`retry`（`safe` / `unsafe` / `never`）、`interfered_with_user`、`stopped_by_user`、`preempted_by_user`。

## 9. Trace

- 路径 `~/.rotom/computer-use/traces/<session>/<agentId>.jsonl`，截图在同目录 `shots/`。
- 记录：工具名、解析出的目标（role、label 摘要、ref）、投递级别、租约事件、结果与证据、截图文件名。
- 截图按 D4 默认保存。文本输入只记录长度和 SHA-256 摘要，不记录明文；secure field 不截图。这与根 `CLAUDE.md` 第 5 节“只记录必要 metadata”冲突，属于用户在 2026-11-03 明确做出的例外，仅适用于 Computer Use trace，需要在 `CLAUDE.md` 和 `docs/agent/` 里写明。
- `ROTOM_CU_TRACE=0` 完全关闭。拒绝 symlink，写入有界。
- `cu_session trace_export` 生成本地 Markdown 报告（含截图时间线）。

## 10. 验收：如何证明“不影响用户”

在 macOS 真机上用 `PI_CU_LIVE=1` 运行的黑盒测试：
1. 用户模拟器：前台 TextEdit，脚本以每分钟 300 字符持续输入，并随机移动鼠标。
2. 同时启动 3 个 agent（直接调用 bridge API，不调用模型），分别在 3 个后台 fixture App 实例里完成固定任务：填表、切 tab、选列表项、勾选、改滑块。
3. 断言：TextEdit 里的文本与脚本输入逐字一致；前台 App 和焦点窗口零变化；系统光标只受模拟器影响；3 个任务各自完成，或明确返回 `foreground_required`，没有静默失败。
4. 输出兼容矩阵：App 类型 × 动作 × 投递级别的成功率，作为 L2 白名单的依据。

## 11. 风险

- SkyLight 是私有 API，会随 macOS 版本变化。缓解：运行时解析，缺失即禁用 L2，每个 macOS 大版本重跑兼容矩阵。
- 有些 App 收到事件或启动时会自己抢前台。缓解：检测、暂停、记入结果，不自动抢回焦点。
- 截图默认落盘会在本地积累敏感内容。缓解：权限、保留期、容量上限、可关闭、永不上传。
- Broker 崩溃会让所有 agent 失去租约。缓解：下一个客户端自动拉起；重启后所有旧 stateId 失效，agent 重新 observe（与现有 stale 恢复一致）。
- helper 协议从 7 升到 8。现有原则是不自动重启别的会话的 daemon，升级需要显式迁移，期间旧会话继续用旧 daemon。

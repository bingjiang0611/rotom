# Computer Use v2.1 执行状态（第二期）

由执行 agent 维护。每完成一项就更新并推送；审核者只看这个文件、提交和 `evidence/runs/`。

第一期的 `STATUS.md` 不改，按 `HANDOFF-2.md` 的约定由审核者在第二期合入时更新。

## 时间窗口与运行授权

- 用户下达指令的时间：2026-11-04 18:41 PST（UTC-8）。
- 用户给出的离开时长原文是“大约 __ 小时”，**数字没有被填上**（见“需要审核者回答的问题” Q1）。
  因此“当前时间仍在上面的窗口里”这一条无法用数字核验（见“需要审核者回答的问题” Q1）。
- 执行 agent 的处理：A 阶段不需要真机，不受窗口限制；B 阶段的门禁改为以
  `HANDOFF-2.md` 第 3 条（独立 helper 的 `userActivity` 显示最近 10 分钟内没有真实用户输入）
  作为“用户不在电脑前”的**唯一可核验证据**，并且只要 B 阶段任何一步检测到真实用户输入就立即
  停止整个 B 阶段。理由：用户明确写了“如果有（输入），说明我已经回来了”，这正是第 3 条要证明的事。
- B 阶段实际开始时间、每次运行的存档路径见下面的“B 阶段记录”。

## 决定记录

（可以撤销、由执行 agent 自己选的决定。不可逆或会改变 PLAN 已定决策的写在最后一节。）

| 编号 | 决定 | 理由 |
|---|---|---|
| D1 | B 阶段的门禁用“10 分钟内无真实用户输入”作为窗口证据，并在任何真实输入出现时立即停止 | Q1：时长未填。第 3 条是用户自己给的“我已经回来了”判据，取更保守的一侧 |
| D3 | 逐项细节移到 `STATUS-2-A-items.md` | `STATUS-2.md` 要作为审核入口，但仓库 pre-commit 限制单文件 20KB。入口保留时间窗口、决定、总表、验证摘要、问题与稳定性观察，细节另存并在同一提交维护 |
| D2 | A1 的模块边界用工厂函数把 `DesktopToolDeps`（getter 形式）注入 `src/tools/*`，不用模块级全局 | session reset 会替换 scheduler、broker、trace recorder；getter 保证工具永远拿到当前会话的写权限，且工具模块不引入隐藏状态 |

## A 阶段记录

| 项 | 内容 | 状态 | 验证层级 | 提交 |
|---|---|---|---|---|
| A1 | 四个执行器移出 `bridge.ts` | 完成 | L1（全量测试结果与搬迁前一致） | 见提交 |
| A2 | I3：测试不依赖 peer 包 | 完成 | L1（干净 checkout、无 `node_modules`） | 见提交 |
| A3 | F3：干扰用户时暂停 agent | 完成 | L1（单测 + Swift 编译） | 见提交 |
| A4 | F2：父 agent 把 App 交给 subagent | 完成 | L1（单测） | 见提交 |
| A5 | I2：helper 侧强制租约、截图排除宿主 | 完成 | L1（单测 + native 自检 + TS/Swift 互通），真机未验证 | 见提交 |
| A6 | F1：前台接管（L4）与 `preempted_by_user` | 完成 | L1（单测 + Swift 编译），真机未验证 | 见提交 |
| A7 | F4：多个 agent 各自的光标 | 完成 | L1（颜色分配单测 + Swift 编译），显示效果未验证 | 见提交 |
| A8 | 真机脚本的准备（只写代码） | 未开始 | — | — |

逐项细节（A1–A8 的实现、验证命令与限制）在 [`STATUS-2-A-items.md`](STATUS-2-A-items.md)，与下表一一对应。

## 需要审核者回答的问题

| 编号 | 问题 | 执行 agent 的处理 |
|---|---|---|
| Q1 | 用户原话“大约 __ 小时不在电脑前”，时长数字没填。B 阶段的“仍在窗口内”无法按数字核验。 | 按决定 D1：以“10 分钟内无真实用户输入”作为唯一证据，并让任何真实输入立刻终止整个 B 阶段。审核者若给出确切时长，这个门禁可以收紧为“开始时间 + 时长”。 |
| Q2 | `cu_session` 新增 `transfer` 动作是模型可写的管理动作（A4 决定）。是否需要额外的确认或审计要求？ | 先按“父 agent 已获授权、转交不弹卡”实现，只允许转给自己的后代，并写进决定记录。如需要确认卡，属于新的同意层改动。 |
| Q4 | A6 只做了许可/条件/边框/收回，没有把批次的实际投递切到 L4 全局 HID。是否按原计划等 B5 真机证据后再打开投递？ | 先保持不切换：证据不足时打开投递等于让 agent 在无人监督下真的驱动整机。B5 通过后再单独一项接上。 |
| Q3 | `packages/rotom-computer-use/src/outline.ts` 在初始快照里就是 24,448 字节，超过 pre-commit 的 20,000 字节门槛且不在豁免名单。任何改动它的提交都会被 hook 拒绝。 | A5 因此没有把 helper 的 `secure` 标记接进类型层（行为不受影响，见 A5 记录）。是否单独安排一次按职责拆分（例如把解析与渲染拆开），或把它加入 `oversizedByDecision`，需要审核者决定。 |

### A6 F1：前台接管（L4）与 `preempted_by_user`

- 许可：`policy.json` 的 App 条目可以是对象 `{"tier": "full", "foreground": true}`。前台许可
  **只从全局文件读**，项目级 `.pi/computer-use.json` 对它只能撤销（写 `deny`），不能新增。
  `PolicyGate` 增加 `foregroundGranted`，模型侧没有任何路径能授予它。
- 三个条件都在 broker 里判定（`BrokerCore.takeoverRefusal`），缺一即拒：
  1. 用户允许过该 App 的前台模式 → 否则 `takeover_conditions`；
  2. 用户空闲 ≥ 10 秒，或 60 秒内用户点过“让它接管”（`takeover_approval`，只有
     `role=helper` 连接能发）→ 否则 `takeover_conditions`。**没有 helper 的活动报告时按“未知”
     拒绝**，不能让“没人报告”看起来像“用户很闲”；
  3. 前台是全局单例资源 `desktop-foreground`，第二个 agent 拿到 `resource_busy` 和持有者。
- 用户活动只信 helper：`ping.lastUserInputAt` 只接受 `role=helper` 连接上报（helper 每 2 秒推一次，
  这条推送现在放到后台线程，不再阻塞菜单栏）。agent 谎报自己空闲会被忽略，用例钉住了。
- 收回：helper 的 `UserActivityMonitor` 在接管期间挂一个 hook，任何**不带 agent 标记**的真实输入
  触发 `preempted` 请求；broker 撤销租约（原因 `preempted_by_user`）并给该 agent 发 `preempted`
  事件，bridge 记录 trace `{tool:"cu_session", status:"stopped", evidence:"preempted_by_user"}`。
  只有 helper 能报这件事，agent 不能借此驱逐竞争者。
- 边框与 `Esc`：新文件 `native/macos/takeover_border.swift`（8px 边框 + 一行说明文字，点击穿透、
  不抢焦点、所有 Space 可见），`EscapeSwallowTap` 只消费 keycode 53，其他按键原样通过。
  `takeoverBegin` 也要求 broker 签的租约 token（`LeaseGuard` 把它算作写命令，目标
  `desktop-foreground`），所以没有租约的进程画不出这个边框。
- 客户端 `src/takeover.ts`：拿租约 → 请求边框 → 每 20 秒续租；续租失败（被撤销/被收回）就标记
  preempted 而不是继续按旧租约动作；`takeoverEnd`/preempt 都会摘掉边框。
- headless：`isHeadlessMode()` 为真时 `TakeoverController.start` 直接返回 `headless`，不请求租约、
  不显示边框（用例断言 broker 一次都没被调用）。
- 模型侧：`cu_session` 新增 `takeover`（需要 `pid`）与 `release_takeover`；schema 同步更新。

验证：`node --test --experimental-strip-types test/takeover.test.ts` 11 用例通过；全量 **104 用例，
104 通过、0 失败**；`node scripts/build-native.mjs --arch arm64 --no-sign --output ~/cu-v2-build/a6-bridge`
编译通过（含新文件）。覆盖：无授权被拒、空闲不足被拒、用户点击放行且 60 秒后失效、agent 伪造
活动被忽略、agent 不能自行批准、第二个 agent `resource_busy`、真实输入 → `preempted_by_user` 且租约
消失、agent 不能 preempt 同伴、headless 不请求租约、边框显示与续租、续租失败转为 preempted。

限制：

- **L4 的实际输入投递没有打开。** 本项完成的是许可、条件、边框、`Esc` 与收回；批次仍走平时的
  L1/L2 阶梯。真正用全局 HID 驱动要先有 B5 的真机证据，见“需要审核者回答的问题” Q4。
- 真机未验证：边框可见性、`Esc` 吞键、真实输入触发收回都只到 L1 + 编译层面。

### A7 F4：多个 agent 各自的光标

- 覆盖层改成按 agent 存状态：`AgentCursorState`（位置、朝向、路径、弹簧、颜色）+ 注册表
  `AgentCursorRenderer.cursors[agentId]`，每帧推进所有还在动的光标。原来只有一个
  `position/heading`，第二个 agent 会把第一个的光标“抢走”。
- 颜色由 `cursorColorFor(agentId)` 决定（`src/cursor-colors.ts`）：对 agentId 做 FNV-1a，映射到
  360 个色相之一（固定饱和度 0.62 亮度），所以同一个 agent 永远同一种颜色，同时驱动的两个
  agent 几乎不可能同色。颜色由 TS 决定、随动作请求下发（`agentId` + `cursorColor`），helper 只负责画；
  无法解析时回退到原来的橙色。
- 覆盖层仍然点击穿透（`ignoresMouseEvents`，`canBecomeKey/Main` 均为 false），并且属于 helper 自己的
  窗口，因此 A5 的 `captureWindow` 会拒绝把它拍进观察结果——这条排除是 A5 就做好的，本项不再重复。
- 空闲隐藏：所有光标都停下、窗口 8 秒无动作后整体隐藏并清空注册表。

验证：`node --test --experimental-strip-types test/cursor-colors.test.ts` 4 用例通过（同一 id 稳定、
24 个 id 至少 20 种颜色、父与子 agent 不同色、颜色亮度在可读区间）；全量 **108 用例，108 通过**；
`node scripts/build-native.mjs --arch arm64 --no-sign --output ~/cu-v2-build/a7-bridge` 编译通过。

限制：显示效果（两个光标同时在屏、颜色是否够分辨）只到编译层面，留到 B 阶段观察；Swift 侧没有
UI 单测，确定性只覆盖 TS 的颜色分配。

## 测试稳定性观察（既有问题，不是本项引入）

- 全量套件在**并行跑全部测试文件**时，基于真实 spawn 的 Broker 用例（`broker-packaged`、
  `broker-socket` 的“两个客户端同时拉起”）偶发超时/连接失败：两次全量运行各出现 1–2 个，
  报错是 15 秒内 socket 未出现（`ENOENT`），不是断言失败。
- 单独运行这些文件连续 3 次全通过；同一套件在第二期基线提交 `fe580d45` 的独立 worktree 上也
  出现过一次其它 spawn 用例失败（控制组）。在改动后的分支上也有一次 88/88 全通过。
- 结论：按“既有失败单独记录”处理，未放宽或删除任何测试。B 阶段的真机脚本不使用这套并发 spawn
  测试路径。

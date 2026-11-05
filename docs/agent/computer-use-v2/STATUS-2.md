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
| A7 | F4：多个 agent 各自的光标 | 未开始 | — | — |
| A8 | 真机脚本的准备（只写代码） | 未开始 | — | — |

### A1 四个执行器移出 `bridge.ts`

纯搬迁，不改行为。

- 新文件：`src/tools/clipboard.ts`（剪贴板恢复 + `clipboard` 执行器）、`src/tools/apps.ts`
  （`describeApp` + `manage_app` 执行器）、`src/tools/windows-admin.ts`（`manage_window` 执行器）、
  `src/tools/session-admin.ts`（`cu_session` 执行器）、`src/tools/results.ts`（两个结果构造函数）、
  `src/tools/window-types.ts`（`WindowRow` / `ListWindowsDetails` 类型）、
  `src/tools/desktop-deps.ts`（会话依赖的接口）。
- `bridge.ts` 保留分发与接线：构造一份 `desktopDeps`（scheduler / trace / broker 用 getter，
  `collectBroadWindowDetails` 和 `formatWindowLine` 直接引用，因为窗口 ref 注册表在 bridge 里）。
- 体积：`src/bridge.ts` 146,143 → 130,698 字节。新文件最大 6,153 字节，都在 20 KB 以内。
- 测试不变量：“意图必须集中构造”改成读取新文件位置，没有删除。
- 全量测试搬迁前后一致：72 用例，71 通过、0 失败、1 个文件级失败（`cu-v2-tools.test.ts` 缺 peer 包，
  既有问题，A2 修）。

### A2 I3：测试不依赖 peer 包

- 根因：`src/config.ts` 在模块顶层值导入了 peer 包 `getAgentDir`，于是任何 import 到 config 的模块
  （包括 `cu-v2-tools.test.ts` → `src/tools/clipboard.ts`）在没有 peer 包时都无法加载。
- 修复：`getAgentDir()` 改为在 `loadComputerUseConfig()` 里通过惰性 `await import(...)` 解析；
  该函数因此变成 async，三个调用点（`bridge.ensureReady`、extension 的命令处理器、`session_start`）
  都是 async 上下文，已改成 `await`。Pi 内运行时 peer 包必然存在，缺包会如实抛错，不做猜测式回退。
- 新增回归：`test/no-peer-imports.test.ts` 静态扫描 `src/**`，禁止对 `@earendil-works/*` 或 `typebox`
  的**静态值导入**（`import type` 与惰性 `import()` 允许），防止这个属性再次被破坏。
- 条件与数字：本机干净 checkout，`packages/rotom-computer-use/node_modules` 不存在，
  Node v24.18.0，`node --test --experimental-strip-types "test/*.test.ts"` →
  **80 用例，80 通过、0 失败、0 跳过**。此前同一命令是 72 用例、71 通过、1 个文件级失败
  （`cu-v2-tools.test.ts` 的 8 个用例因为文件加载失败而没被计入）。
- 文档：`packages/rotom-computer-use/docs/development.md` 写明无需 `npm install`，并更新了目录布局。

### A3 F3：干扰用户时暂停该 agent

- Broker 增加 agent 级暂停状态 `paused`（原因 + 时间）。判定规则仍然是 PLAN §6 的那条，由 helper
  计算：动作之后前台 App 变了，且用户在 2 秒内有真实输入（`performed.interferedWithUser`）。
  Broker 拥有后果：`acquire`（写路径）直接返回 `paused_interfered`，`epoch` / `status` 等读请求不受影响。
- 暂停时同时撤销该 agent 的租约，revocation 原因 `paused_interfered`：被暂停的 agent 已经不能写，
  继续持有 App 只会挡住用户和其他 agent。
- 暂停原因与时间写进 trace：Broker 发出 `paused` 事件，bridge 收到后写一条
  `{tool:"act_ui", status:"stopped", evidence:"paused_interfered:…", paused:{reason,at}}`。
- 恢复只接受 `role=helper` 连接发起的 `resume`（与 B3 的 stop 同一规则），模型侧没有任何恢复工具。
  helper 菜单栏对被暂停的 agent 显示 “Resume …”。
- 顺带修掉一个既有缺陷：helper 的 `BrokerLink` hello 原来没有声明 `role: "helper"`，于是 B3 的
  “只有 helper 能 stop” 在真机上会把用户自己的菜单栏停止操作也拒掉。现在 hello 声明了角色。
- 协议里补上了代码已经在用但类型里缺失的错误码（`not_permitted`），以及新的 `paused_interfered`。
- 测试：`test/broker-pause.test.ts`（真实 BrokerCore + 假 transport，3 个用例）——
  干扰之后写被拒且读仍可、对端可以接手该 App；agent 自己 resume 被拒且暂停不被解除；
  对端 agent 不能 resume 别人；helper resume 之后可以写。
- Swift：`node scripts/build-native.mjs --arch arm64 --no-sign --output ~/cu-v2-build/a3-bridge`
  编译通过（24 秒）。真机行为未验证（按规则留到 B 阶段）。
- 全量测试：83 用例，83 通过、0 失败。

### A4 F2：父 agent 把 App 交给 subagent

- 父子关联复用既有约定，不新增环境变量：`agentRegistrationFor` 从 `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID`
  得到 `parentAgentId`，Broker 的 `ancestors()` 用它做祖先链。补了一个用例把这条约定钉住。
- Broker 的 `transfer` 增加祖先校验：只能转给自己的后代，转给别的 agent 返回 `not_permitted`
  （否则父 agent 的授权会被扩散给用户从未同意的进程）。转交本身不弹卡：父 agent 已经被授权过。
- 子 agent 断开时，租约自动回到它直接的父 agent（`LeaseManager.transferAll`，revocation 原因
  `transferred`），而不是等 TTL 过期或被撤销；父 agent 已经不在时按 `owner_disconnected` 撤销，
  不留悬空租约。
- 模型侧入口：`cu_session` 新增 `transfer` 动作，参数 `toAgentId` 和可选 `resourceKey`
  （省略表示把自己持有的全部租约转给该 subagent）。这是一次新增的可写管理动作，记在决定记录里。
  被 Broker 拒绝时返回结构化结果（`status: "denied"` + 错误码），不抛异常。
- 测试：`test/broker-transfer.test.ts`（5 个用例）——父转交后父写被拒、子可写；转给非后代被拒；
  子断开后租约回到父；父先消失时子租约被撤销；`PI_SUBAGENT_ORCHESTRATOR_SESSION_ID` 的父子关联。

### A5 I2：helper 侧强制租约、截图排除自己

- token 结构与传递：broker 每个进程用 `randomBytes(32)` 生成一把密钥，只放在内存里；`hello` 时只把
  `leaseKey`（base64）回给声明了 `role="helper"` 的连接，agent 连接拿不到（用例钉住了这一点）。
  租约下发时附一个 token：`base64url(payload) + "." + hex(HMAC-SHA256(key, payload))`，payload 是
  `{agentId, resourceKey, pid?, leaseId, expiresAt}`。密钥不落盘，不经过任何 agent。
- helper 侧强制：`LeaseGuard`（Swift）在**所有命令分发之前**检查写命令（`act`、`actBatch` 的每个
  动作、`clipboardSet`、`clipboardClear`、`manageApps`、`manageWindow`），校验签名、有效期、
  撤销列表、`lease.resourceKey` 与命令实际目标一致，以及 `desktop-pid:<pid>` 租约的 pid 与请求 pid
  一致。失败返回 `lease_invalid`／`lease_expired`，动作不会发生。读命令不带也不查租约。
- 撤销要真的到得了 helper：broker 现在把每条 `revoked` 事件同时推给所有 `role=helper` 连接
  （`registry.agentsWithRole`）。否则 broker 收走的 token 在 helper 侧仍然有效。同时把 helper 的
  `BrokerLink` 从“发一条收一条就关”改成一条常驻连接 + 读线程：回包按 id 配对，非请求的事件
  （撤销）直接进 `LeaseGuard`。旧实现在不主动请求时收不到任何推送，撤销永远送不到。
- 截图排除自己：`captureWindow` 拒绝截取 helper 自己拥有的窗口（`pid == getpid()`，错误码
  `capture_excluded`）。agent 光标浮层和 A6 的接管边框都由 helper 自己绘制，否则会被拍进观察结果。
  `find_roots`／窗口列表另外排除 helper 与本进程的 pid（`host-exclusion.ts` 的 `excludeInternalRoots`），
  宿主终端排除逻辑保持不变。
- 安全文本框由 helper native 标记（payload 里 `secure: true`）。bridge 的 trace 截图抑制改成走序列化
  outline 的角色（`AXSecureTextField`），**没有**接入这个新标记：`src/outline.ts` 在初始快照里就是
  24,448 字节，超过 pre-commit 的 20,000 字节门槛且不在豁免名单里，任何改动它的提交都会被拒绝。
  见“需要审核者回答的问题” Q3。
- helper 协议 8 → **9**。协议不匹配仍然报错，不自动重启已有 daemon。
- 无 broker（`ROTOM_CU_BROKER=0`）时 helper 收不到密钥，于是不校验：这是文档化的旧行为，
  `behaviour-changes.md` 第 7 条已写明，不是静默绕过。

验证：

| 检查 | 命令 | 结果 |
|---|---|---|
| TS 侧 token / 密钥归属 / 撤销推送 | `node --test --experimental-strip-types test/lease-token.test.ts` | 5 用例通过 |
| 全量套件 | `node --test --experimental-strip-types "test/*.test.ts"` | 93 用例，93 通过、0 失败 |
| helper 自检（无 UI） | `npm run test:lease-guard` | 6 项：合法通过；签名错、过期、pid 不符、已撤销、无密钥直通 |
| TS↔Swift 互通 | 同上脚本内 | TS `signLeaseToken` 签的 token 被 Swift 接受；换 pid 999 被拒 |
| Swift 编译 | `node scripts/build-native.mjs --arch arm64 --no-sign --output ~/cu-v2-build/lease-guard` | 通过 |

控制证据：自检第一次跑出 `valid_token fail`（Swift 把签名算在解码后的 JSON 字节上，而 broker 签的是
base64url 文本），修正后 6/6 通过——说明这组用例能区分“真的校验通过”和“看起来通过”。

限制（未验证 / 已知边界）：

- 真机未验证：按 HANDOFF-2 的规则，需要 broker 与 helper 同时跑在真机上的验证放在 B 阶段，本项只到 L1。
- `manageApps` 的目标是 App（`app:<bundle>`），helper 无法重算 bundle 与请求的对应关系，因此对这类
  租约只校验签名、有效期、撤销和 `lease.resourceKey` 自洽；pid 与目标的强绑定只对
  `desktop-pid:<pid>` 生效。
- 只有 `ROTOM_CU_BROKER` 开启时才强制。关掉 broker 就是 v1 行为，这一点没有隐藏。
- `CLAUDE.md` §4 的“协作式仲裁”措辞按 HANDOFF-2 的要求留到 A5 + B5 的真机负例通过之后再改。

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

## 测试稳定性观察（既有问题，不是本项引入）

- 全量套件在**并行跑全部测试文件**时，基于真实 spawn 的 Broker 用例（`broker-packaged`、
  `broker-socket` 的“两个客户端同时拉起”）偶发超时/连接失败：两次全量运行各出现 1–2 个，
  报错是 15 秒内 socket 未出现（`ENOENT`），不是断言失败。
- 单独运行这些文件连续 3 次全通过；同一套件在第二期基线提交 `fe580d45` 的独立 worktree 上也
  出现过一次其它 spawn 用例失败（控制组）。在改动后的分支上也有一次 88/88 全通过。
- 结论：按“既有失败单独记录”处理，未放宽或删除任何测试。B 阶段的真机脚本不使用这套并发 spawn
  测试路径。

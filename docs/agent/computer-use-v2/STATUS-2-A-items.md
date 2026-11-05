# Computer Use v2.1 A 阶段逐项记录（STATUS-2 附件）

`STATUS-2.md` 是审核入口；本文件是它的逐项细节，避免入口文件超过仓库 20KB 的提交门槛。
两部分由同一次提交维护，内容一一对应。

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

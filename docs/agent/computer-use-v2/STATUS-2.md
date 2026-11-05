# Computer Use v2.1 执行状态（第二期）

由执行 agent 维护。每完成一项就更新并推送；审核者只看这个文件、提交和 `evidence/runs/`。

第一期的 `STATUS.md` 不改，按 `HANDOFF-2.md` 的约定由审核者在第二期合入时更新。

## 时间窗口与运行授权

- 用户下达指令的时间：2026-11-04 18:41 PST（UTC-8）。
- 用户给出的离开时长原文是“大约 __ 小时”，**数字没有被填上**（见“需要审核者回答的问题” Q1）。
  因此“当前时间仍在上面的窗口里”这一条无法用数字核验。
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
| A4 | F2：父 agent 把 App 交给 subagent | 未开始 | — | — |
| A5 | I2：helper 侧强制租约、截图排除宿主 | 未开始 | — | — |
| A6 | F1：前台接管（L4）与 `preempted_by_user` | 未开始 | — | — |
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

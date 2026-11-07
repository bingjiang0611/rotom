# Computer Use v2.1 第一、二期设计细节与逐轮审核记录

`STATUS-2.md` 只保留当前状态、决定和待答问题；这里是 A6/A7 的设计细节与第 4、5 轮的逐项处理表。
文件按 20 KB 提交门槛拆分，内容不删。

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

## 第 5 轮审核（REVIEW-5）处理

只做代码和测试，不跑真机。逐项提交，明细见下表。

| 项 | 处理 | 证据 |
| --- | --- | --- |
| G1（高） | 传输方式改用独立字段 `params.requireTransport`；`delivery` 出现不再算钉死。请求构造移进 `src/tools/act-request.ts` 以便断言 | `test/act-request.test.ts` 5 例：产品请求不带该字段、策略算出 `l2` 也不算钉死、直连 L2 请求带 `requireTransport: true` |
| G2（高） | AX 插入被接受后不再回退按键；读回不符报 `unknown`（`background_input_unknown`），不重复写 | 同上提交；Swift 编译通过、`--lease-self-test` `failures=0` |
| G3（中） | 按键路径三分：以请求文本结尾 → `worked`；值没变 → `didnt`；值变了但不匹配 → `unknown` + 实际值 | 新 `native/macos/text_outcome.swift` + `test/text-outcome.swift`（7 个断言，含实测 `"里probe"` 一例） |
| G4（中） | L2 符号缺失改成独立错误码 `l2_unavailable`；客户端用同一后台策略改 pid 重试一次，不升级前台；trace 记 `delivery_fallback:l2_unavailable` | `test/act-delivery-fallback.test.ts` 4 例（假 backend 第二次请求必须是 `background` + `pid`）；`behaviour-changes.md` 第 9 条 |
| G5（中） | 脚本开跑前读当前输入源；不是 ASCII 布局时直连 L2 的 `typeText` 记 `skipped: input method`，改由 `click` 行证明投递 | `scripts/lib/live-helpers.mjs` `inputSourceInfo()`（实测本机 `com.sogou.inputmethod.pinyin` → 非 ASCII） |
| H1（中，复核） | 输入源解析正则允许键带引号（`"KeyboardLayout Name" = ABC;` 这种旧式 plist），`Input Mode` 同样处理 | `test/input-source.test.ts` 3 例：只有 ABC → `true`、ABC + 输入法 → `false`、命令失败 → `false` |
| G6（中） | 闸门搬进库 `scripts/lib/gate.mjs`，四个真机脚本（live、acceptance、compat-matrix、l2-check）自己调用：没有 `--window-start/--window-minutes` 直接退出 2，hold 退出 1，读数写进 `runs/gate-*.json` | `test/cu-v2-gate.test.ts` 7 例（窗口外、真实输入、无 helper 读数、从未见过输入、读数留存、缺参数拒绝）；dry run 新增一项断言四个脚本都调用 `requireGate` |
| G7（低） | 文档里的签名身份统一写成 `"$PI_CU_FIXTURE_SIGN_IDENTITY"` / “本机 Apple Development 身份”，不再出现邮箱与 Team ID；历史未改写 | `STATUS.md`、`STATUS-2.md`、`evidence/runs/2026-11-05T0333-b-phase-blocked.md`；复检 `grep` 无残留（`REVIEW-5.md` 里的脱敏示例除外） |
| Q2 | `cu_session transfer` 补 trace：成功记 `{tool:"cu_session", status:"ok", transfer:{toAgentId, resourceKey, oldLeaseId, newLeaseId}}`，被拒记 `lease_conflict`/`error` + 错误码且无新 id | `test/session-transfer-trace.test.ts` 3 例（成功、只转指定资源、被拒） |


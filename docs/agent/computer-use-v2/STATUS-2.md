# Computer Use v2.1 执行状态（第二期）

由执行 agent 维护。每完成一项就更新并推送；审核者只看这个文件、提交和 `evidence/runs/`。

第一期的 `STATUS.md` 不改，按 `HANDOFF-2.md` 的约定由审核者在第二期合入时更新。

## 总结（2026-11-04 19:50 PST）

### A 阶段：A1–A8 全部完成并推送（`fe787cb9`…`b5b2d58c`）

每一项都做到 **L1（自动化测试与编译通过）**，没有任何一项到 L2/L3：A 阶段按用户要求
不运行任何会移动光标、输入文字、切换前台或启动 App 的脚本，而这些能力都只存在于真机路径上。

| 项 | 达到的层级 | 证据 | 没有做的部分与原因 |
| --- | --- | --- | --- |
| A1 拆分 `bridge.ts` | L1 | 全量 108 项测试；`bridge.ts` 146,143 → 130,698 字节 | 无 |
| A2 I3 peer import | L1 | 新增 `test/no-peer-imports.test.ts`；干净 checkout 80/80 | 未在真实 Pi 会话里验证懒加载时机（需要真机 Pi 运行） |
| A3 F3 干扰暂停 | L1 | `test/broker-pause.test.ts`；菜单栏 “Resume …” 只编译 | 暂停条件的真实触发（真人动鼠标）没有在 A 阶段造过 |
| A4 F2 转移租约 | L1 | `test/broker-transfer.test.ts`；`cu_session transfer` schema | 跨真实子 agent 的连接断开只在测试里模拟 |
| A5 I2 租约签名 | L1 | `scripts/check-lease-guard.mjs` 6 项自测 + TS↔Swift 互通 fixture；全量 93 项 | 真机拒绝写入（B5 的负向测试）未执行，所以 `CLAUDE.md` §4 的“协作式仲裁”措辞**没有改** |
| A6 F1 前台接管 | L1 | `test/takeover.test.ts`（11 项）；Swift 编译通过 | 批次输入仍在旧投递路径上，**没有**改成 L4 全局 HID（等 B5 的真机证据，见 Q4） |
| A7 F4 每 agent 光标 | L1 | `test/cursor-colors.test.ts`（4 项）；Swift 编译通过 | 多光标同时绘制的真实画面没有截图证据 |
| A8 真机脚本准备 | L1（脚本层 dry run） | `scripts/cu-v2-script-dry-run.mjs` 6 通过 / 3 显式跳过 | 脚本本身从未真机运行；也没有 Linux 环境，“先在 Linux 上跑通”只用假 backend 验证了副本与请求构造逻辑 |

已知限制（不是本次改动引入）：spawn 型 broker 测试并行跑满量时偶发 15 s 超时
（`broker-packaged`、`broker-socket`、`broker-scheduler`），单独跑 3/3 通过；本次又在全量运行时
复现一次（`a direct daemon.ts entry fails inside node_modules`），单文件 4/4 通过。没有弱化任何测试。

未决问题见最后一节 **Q3**（`outline.ts` 超过 20 KB 提交门槛，导致 helper 的 `secure` 标记没有进入
`OutlineNode`）和 **Q4**（A6 未切换批次投递）。

### B 阶段：**未完成**（四次 B1 尝试，`SLEventPostToPid` 仍未执行）

用户 05:36 PST 说“离开了 继续吧”之后没有再交互。这一轮真的跑起来了：门禁两次成立（`HIDIdleTime`
619 s），B1 走到 13/15 行，**没有一次真的发出 L2 投递**。

| 尝试 | 门禁 | 结果 |
| --- | --- | --- |
| 05:48 | 满足（619 s） | 副本启动、窗口、控件通过；点击落到窗口关闭按钮，窗口消失，后续 skip |
| 05:59 | 满足（604 s） | `input received` 失败：`"l2probe"` → `"里probe"` |
| 06:19 | 满足（604 s） | 同上前提；`direct L2 typeText` 仍是 `delivery=pid` |
| 06:35 | **不满足**（06:27 起持续输入） | 0 失败，但这次运行本不该开始——见下 |

逐次读数、缺陷复现和修复细节见
[`runs/2026-11-06T1435-b1-four-attempts.md`](evidence/runs/2026-11-06T1435-b1-four-attempts.md)、
[`runs/2026-11-06T0437-b1-attempt.md`](evidence/runs/2026-11-06T0437-b1-attempt.md)、
[`runs/2026-11-05T0333-b-phase-blocked.md`](evidence/runs/2026-11-05T0333-b-phase-blocked.md)。

**06:35 那次运行是我的错误**：轮询循环里把运行命令写到了循环外，门禁一直在跳动却照样跑了 B1。
它只碰本轮自己启动的 fixture 副本（光标未动、前台未变），但违反了阶段规则，记录在案而不是抹掉。

这一轮真机发现并修好的**产品**缺陷（都已提交）：

- **输入法改写注入文本**：中文输入法下 `typeText("l2probe")` 落成 `"里probe"`（`2` 被当作候选选择），
  而 helper 只检查“值变了”就报 `worked`。现在优先 AX 插入（不经输入法），并要求读回值等于或后缀
  等于请求文本，否则 `didnt`。
- **显式 `delivery: "l2"` 被静默降级成 `pid`**：`policy: "background"` 的分支先于显式请求生效，所以
  定向投递签名从上线到现在一次都没执行过。显式 `delivery` 现在优先，且显式投递不再被 AX 插入抢先满足。

脚本侧：fixture 副本需要真实签名身份；fixture 新增内容按钮（原来唯一的 `AXButton` 是关闭按钮）；
L2 模式每步重新 observe；证据里的家目录写成 `~`。

**门禁测量本身不可靠**：`manageApps launch` 一次 +15 事件、一次完整运行 +17…+91，都会让计数增长、
`HIDIdleTime` 归零。只有光标移动与前台切到我们没启动的 App 才能证明“用户回来了”。

仍未解决：系统时钟在两次交互之间整体前移约一天，`window_start` 无法再算“是否仍在窗口内”，只能靠
helper 侧计数与用户授权。本机 122 个 `rotom-quality-pty-*` 遗留 `bridge` 孤儿进程仍在，未触碰。

## B 阶段记录

**状态：未完成，第 4 条前置条件不成立。** 明细见
[`runs/2026-11-06T1435-b1-four-attempts.md`](evidence/runs/2026-11-06T1435-b1-four-attempts.md)。

| 条件 | 结果 | 证据 |
| --- | --- | --- |
| A1–A8 完成并推送 | 满足 | `b5b2d58c` 已推送 |
| 脚本已在 Linux 或假 backend 上跑通 | 满足（脚本层） | `cu-v2-script-dry-run.mjs` 6 通过 / 3 跳过；真机路径本轮才第一次跑到 15 行 |
| 当前时间仍在窗口内 | 无法核验 | 系统时钟前移约一天，用户给的时长数字也没填（Q1） |
| 最近 10 分钟内没有真实用户输入 | **曾两次成立、随后失效** | 05:46 / 06:19 两次 619 s、604 s 通过；06:27 起持续输入，06:35 那次运行本不该开始（见总结） |

跑过的东西：B1 四次（13/15/15/15 行），每次都只操作本轮自己启动的 fixture 副本，`cursorMoved`
与 `frontmostChanged` 全程 false，操作员 App 前后都是 Scry。没有碰过用户已打开的 App。
**没有**执行：`SLEventPostToPid`（L2 定向投递）、B2/B3/B4/B5/B6。

下一次窗口（每一步都由脚本自己校验闸门，缺窗口参数会拒绝运行）：

```bash
node --experimental-strip-types scripts/cu-v2-l2-check.mjs --fixture ~/cu-v2-test/Fixture.app --direct-l2 \
  --window-start <用户给的开始时间> --window-minutes <用户给的时长> --listening-since <helper 起监听的时间>
```

**用户离开前把输入法切到 ABC**：不是 ASCII 布局时，直连 L2 的 `typeText` 会被脚本跳过（按键事件
经过输入法会被改写），只剩 `click` 一行能证明投递。

判定：`direct L2 | click` 一行必须出现 `delivery=l2` 且 helper 仍存活；ASCII 布局下 `direct L2 | typeText` 也应是 `delivery=l2`，且 `input received` 为 pass。

## 需要审核者回答的问题

| 编号 | 问题 | 执行 agent 的处理 |
|---|---|---|
| Q1 | 用户原话“大约 __ 小时不在电脑前”，时长数字没填。B 阶段的“仍在窗口内”无法按数字核验。 | 按决定 D1：以“10 分钟内无真实用户输入”作为唯一证据，并让任何真实输入立刻终止整个 B 阶段。审核者若给出确切时长，这个门禁可以收紧为“开始时间 + 时长”。 |
| Q2 | `cu_session` 新增 `transfer` 动作是模型可写的管理动作（A4 决定）。是否需要额外的确认或审计要求？ | 先按“父 agent 已获授权、转交不弹卡”实现，只允许转给自己的后代，并写进决定记录。如需要确认卡，属于新的同意层改动。 |
| Q4 | A6 只做了许可/条件/边框/收回，没有把批次的实际投递切到 L4 全局 HID。是否按原计划等 B5 真机证据后再打开投递？ | 先保持不切换：证据不足时打开投递等于让 agent 在无人监督下真的驱动整机。B5 通过后再单独一项接上。 |
| Q3 | `packages/rotom-computer-use/src/outline.ts` 在初始快照里就是 24,448 字节，超过 pre-commit 的 20,000 字节门槛且不在豁免名单。任何改动它的提交都会被 hook 拒绝。 | 已按 REVIEW-4 的回答处理：按职责拆分成 `src/outline/*`（最大 6,768 字节），不加入豁免名单，并把原生 `secure` 标记接进 `OutlineNode`。 |
| Q5（已解决） | `focusWindow` 与 `clipboardRestore` 会改变状态，但不在 helper 的 `writeCommands` 里，TS 侧也没有给它们附租约。 | 依复核结论补做：两者都进了 `writeCommands`（`desktop-pid:<pid>` / `clipboard:system`），TS 侧签名强制传租约，恢复路径拿不到租约就跳过并记 `restore_skipped:lease_unavailable`。细节见 [`STATUS-2-E-items.md`](STATUS-2-E-items.md)。 |

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
| G6（中） | 闸门搬进库 `scripts/lib/gate.mjs`，四个真机脚本（live、acceptance、compat-matrix、l2-check）自己调用：没有 `--window-start/--window-minutes` 直接退出 2，hold 退出 1，读数写进 `runs/gate-*.json` | `test/cu-v2-gate.test.ts` 7 例（窗口外、真实输入、无 helper 读数、从未见过输入、读数留存、缺参数拒绝）；dry run 新增一项断言四个脚本都调用 `requireGate` |
| G7（低） | 文档里的签名身份统一写成 `"$PI_CU_FIXTURE_SIGN_IDENTITY"` / “本机 Apple Development 身份”，不再出现邮箱与 Team ID；历史未改写 | `STATUS.md`、`STATUS-2.md`、`evidence/runs/2026-11-05T0333-b-phase-blocked.md`；复检 `grep` 无残留（`REVIEW-5.md` 里的脱敏示例除外） |
| Q2 | `cu_session transfer` 补 trace：成功记 `{tool:"cu_session", status:"ok", transfer:{toAgentId, resourceKey, oldLeaseId, newLeaseId}}`，被拒记 `lease_conflict`/`error` + 错误码且无新 id | `test/session-transfer-trace.test.ts` 3 例（成功、只转指定资源、被拒） |

## 测试稳定性观察（既有问题，不是本项引入）

- 全量套件在**并行跑全部测试文件**时，基于真实 spawn 的 Broker 用例（`broker-packaged`、
  `broker-socket` 的“两个客户端同时拉起”）偶发超时/连接失败：两次全量运行各出现 1–2 个，
  报错是 15 秒内 socket 未出现（`ENOENT`），不是断言失败。
- 单独运行这些文件连续 3 次全通过；同一套件在第二期基线提交 `fe580d45` 的独立 worktree 上也
  出现过一次其它 spawn 用例失败（控制组）。在改动后的分支上也有一次 88/88 全通过。
- 结论：按“既有失败单独记录”处理，未放宽或删除任何测试。B 阶段的真机脚本不使用这套并发 spawn
  测试路径。

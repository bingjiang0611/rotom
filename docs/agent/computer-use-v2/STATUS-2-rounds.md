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

## 第 6 轮复核（K1–K4）

复核结论：`ce9c568` 不能作为冻结提交；P1 的方向对，但 K1 让 B1 之后的任何一步都无法开始，K2/K3 让
“失败即停”仍有漏洞。逐条处理，仍然只做代码和测试：

| 项 | 处理 | 证据 |
| --- | --- | --- |
| K1 存档写进工作区 | 窗口输出全部移到仓库外：脚本必填 `--runs-dir`，路径在 git 工作区内即拒绝；`writeRunArchive` 是唯一写入口，仓库内不再写 `evidence/*.md`、`*.log`、汇总表 | `requireRunsDir`/`writeRunArchive`；`test/b-window.test.ts` 含**真实 git** 的用例：`beginStep B1 → finishStep pass（写存档）→ beginStep B2` 必须被允许，再往工作区丢一个文件则 B2 被拒 |
| K2 必需行 | `STEP_CONTRACT` 逐步声明必需行；缺失或非 `pass` 即阻塞；B1 要求 `direct L2 \| click` 带 `delivery=l2`，ASCII 输入源下 `direct L2 \| typeText` 也必需 | `evaluateStep`；`test/b-window.test.ts` 4 例（inconclusive、错投递、ASCII 条件、必需行缺失） |
| K2 真实用户输入 | 每步都有 `run \| real user input`：helper 的真实事件数增长，或前台是本次运行没启动的 App，都记 `fail`；acceptance 用它自己的模拟器日志当预算 | `recordRealUserInput`；`test/live-helpers.test.ts` 5 例（增长、外来 App、探针失败、空闲、预算内） |
| K3 验收不留结论 | acceptance 写 `Step/Commit/Verdict` 并调用 `finishStep`；B3 拆成 `B3-live` 与 `B3-acceptance`，两份同一 commit 的 `pass` 才放行 B4 | `test/b-window.test.ts` K3 用例；dry run“验收自己收尾”一项 |
| K4 两个 B6 归属 | 只有 `check-cu-v2-live.mjs --with-hid` 是 B6；`cu-v2-l2-check.mjs` 删除 `--with-hid` 与 `runWithHid`；HID 点击拆成两行，生效判定读回 fixture 按钮的 `AXValue` | `STEP_SCRIPTS`；dry run“一个步骤一个归属”一项 |

测试：`node --test` 共 **177** 项（`test/b-window.test.ts` 23、`test/live-helpers.test.ts` 11）；
dry run 17 项、0 失败、3 跳过。文件按 20 KB 门槛拆分：设计细节与逐轮表格移到
[`STATUS-2-rounds.md`](STATUS-2-rounds.md)。

## 第三次 B 窗口（2026-11-06 22:55–00:55，`6e6a54dc`）：门禁未通过

用户授权 2 小时，并要求先修 B1 的判定。改动已提交并推送：定向点击改为读回 fixture 自己的
`cu-fixture-button-result` 行，`delivery=l2` 与“控件确实变化”同时成立才判 `pass`（提交 `6e6a54dc`，
5 个单元测试，共 183 项通过）。因为这次改动移动了 `HEAD`，`--expect-commit` 只能冻结该提交；用户原选的
`fb33e423` 是修改前的提交，冻结它会重演同一失败。上一窗口的 `B-STOPPED` 按用户明确授权于 22:52 删除。

**结果是门禁始终没有通过，四个步骤一次都没有运行**（[存档](evidence/runs/2026-11-06T2305-window-gate-hold.md)）：

- helper 自 22:52:10 起监听；1 656 秒内记录到 **39 540 个未标记键鼠事件**（`agentEventCount = 0`），
  速率 20–65 事件/秒，空闲时间反复归零。
- 前台 App 在 Scry、Google Chrome、Etch 之间自行切换，这些都不是本次运行启动的进程。
- 门禁要求最近 10 分钟无真实输入；读数一直是 `hold`（23:03 时已累计 8 674 个事件，23:19 到 39 540）。

没有写 `B-STOPPED`（标记只在步骤运行并失败时写），没有产生真机证据，也没有删除或改动任何标记。
需要用户确认：这是本人回到机器了，还是又一个来源不明的输入流（与 Q6 的安全软件、第二次窗口的 +103
事件可能是同一件事）。在能证明“这些事件不是人”之前，K2 的 `run | real user input` 行在这台机器上
无法通过；那需要 helper 侧按事件来源归因，属于代码改动。

## 第四次窗口（同一次授权内，23:25 起）：B1 运行并失败，阶段停止

用户离开后重开 helper（23:25:43），门禁在 23:36:01 通过（监听 618.7 s、零真实输入、剩余 79 分钟），
`--expect-commit f60cb0e7`（其可执行代码与 `6e6a54dc` 完全相同，差异只有文档与存档）。
B1 运行并失败（[存档](evidence/runs/2026-11-06T2336-b1-directed-l2-readback.md)，20 行、2 个 fail）：

| Blocker | 读数 | 定位 |
| --- | --- | --- |
| `direct L2 \| click effect` = fail | 点击前后都是 `{"value":"clicked"}` | **读回顺序错**：脚本先用 AX 路径点了同一个按钮（第 10 行，实际生效），定向点击再成功也读不出变化 |
| `run \| real user input` = fail | `userEvents 0 → 72`，前台始终 Scry | 用户已离开，72 个未标记事件产生于**本次运行内部**，来源未定位 |
| `direct L2 \| click` = inconclusive | `delivery=l2`、helper 存活、`outcome=unknown` | 与上一窗口一致：传输成立，效果确认不了 |

其余行全部 `pass`（冻结提交、门禁、协议 9、fixture 副本与清理、`restore | operator app`）。
**没有运行 B2、B3-live、B3-acceptance**，`B-STOPPED` 留在
`~/cu-v2-runs/2026-11-06T2325-f60cb0e7/`，只有用户能删。

需要的两个修正（都超出本窗口授权，都是代码加测试）：

1. `--direct-l2` 必须在 AX 点击之前跑（或换成可翻转的控件），否则读回永远看不到变化。
2. K2 的真实输入行要能区分“人回来了”和“我们自己的动作”：helper 记录每个事件的来源进程
   （`eventSourceUnixProcessID`），并确认启动 fixture 副本、定向投递这些路径都打了 agent 标记。
   在这一点修好之前，B 阶段在这台机器上无法通过任何步骤。

## 第一次 B0 窗口（2026-11-07 02:42:47–03:42:47）：门禁真通过，运行在写出归因前中止

`--expect-commit a6286bd7`、`--runs-dir ~/cu-v2-runs/2026-11-07-b0-a6286bd`（用户指定）、
`--direct-l2 --b0-attribution`。门禁 02:53:04 通过，这次是真实安静：helper `listening=true`、
`userEventCount=0`、已监听 617 秒且一次事件都没见过（`idleSeconds=-1`）。

11 行、2 个 fail，运行在写 `attribution` 行之前就中止（存档
`~/cu-v2-runs/2026-11-07-b0-a6286bd/2026-11-07T10-53-12-566Z-l2-check.md`，未进仓库）：

| 行 | 读数 | 缺陷 |
| --- | --- | --- |
| `fixture \| launch` | fail，LaunchServices“miscellaneous error” | 手工拼的 `Fixture-review7.app` 缺 `CFBundleVersion`，起不来 |
| `run \| abort` | fail，`alive is not defined` | R2 把 `alive()` 随 probe 一起删掉，没有重新引入；测试与 dry run 都看不到这种只在真机运行时求值的名字 |

report-only 设计在真机上得到验证：存档没有 `Verdict:` 行，也没有写 `B-STOPPED`。

修复（代码与测试，未跑真机）：`createAlive()` 移入 `scripts/lib/l2-probe.mjs` 由脚本调用；
新增 `scripts/build-fixture.mjs` 生成完整 bundle（8 个键 + `PkgInfo`，`-parse-as-library`，
签名后 `--verify --strict` 并回读 plist），与已知可启动的旧 bundle 键集完全一致；
dry run 新增三条检查（`createAlive` 接线、bundle 键集、计数判定），并把 fixture 相关检查移入
`scripts/lib/dry-run-fixture.mjs`；新增 7 项单元测试。

控制：在上一个提交里 `cu-v2-l2-check.mjs` 引用 `alive` 却没有任何定义，也不含 `createAlive(`，
所以新 dry run 的接线检查在修复前必失败。

## 第二次 B0 窗口（2026-11-07 03:57:41–04:57:41）：跑到底了，fixture 仍起不来

`--expect-commit c026d0f8`、`--runs-dir ~/cu-v2-runs/2026-11-07-b0-c026d0f8`（仓库之外）。
门禁 04:08:01 通过（监听 620 s、零事件、`idle=-1`）。16 行、1 个 fail，运行跑到底（report-only：
没有 `Verdict:`、没有写 `B-STOPPED`）。

- `run | real user input` = **pass**，`userEvents 0 → 0 (+0)`：安静机器上一次什么都没启动的 B0 运行
  产生 0 个未标记事件。
- `attribution | summary` = `unmarked=0 fromThisRun=0 fromElsewhere=0 agentMarked=0 K2 unchanged`——
  没有按来源分的行，因为没有事件可归因。
- `fixture | launch` = fail，仍是 “miscellaneous error”。**`CFBundleVersion` 不是原因**：现在 plist 与
  已知可启动的旧 bundle 逐字节同内容（638 B、8 键），bundle 结构、签名有效性、Designated Requirement、
  Gatekeeper 判定、LaunchServices 注册也一致。

真正原因在二进制：`LC_BUILD_VERSION` 的 `minos`。旧 bundle 是 `minos 14.0`，我编的是 **`minos 28.0`**
（sdk 26.5、主机 macOS 27.3）——比系统还新，dyld 拒绝加载，LaunchServices 只报“miscellaneous error”。
成因是 `build-fixture.mjs` 没传 `-target`，swiftc 取了 SDK 默认部署目标。

修复：`-target arm64-apple-macos${FIXTURE_MINIMUM_MACOS}`，`FIXTURE_MINIMUM_MACOS = "14.0"` 同时供 plist
和编译目标使用（两者不可能再漂移）；builder 编译后用 `otool -l` 回读 `minos`，不一致直接失败退出。
重新编译后 `minos 14.0`、plist 与旧 bundle 完全一致。201 项测试通过、dry run 23 项 0 失败。
**仍未验证**：这个 bundle 能不能真的启动——启动 App 不在本轮授权内。

第 7 轮与第 8 轮（T1–T3）的执行细节移到 [STATUS-2-r8.md](STATUS-2-r8.md)：那边写假 backend 注入点、
四种执行情形、控制实验和归因环的两条新规则。

## 第五次窗口（2026-11-07 08:50:30–09:30:30，`b6d567f0`，40 分钟）：门禁 hold，B0 没有启动

`--runs-dir ~/cu-v2-runs/2026-11-07-b0-b6d567f`（仓库之外）。主机侧安静是成立的：门禁 CLI 在 09:01:57
读到 `hid_idle 631.1s`、`verdict pass`，窗口内还剩 28.5 分钟。

09:02:04 的正式运行却判定 hold，退出 1，三行存档：

```
| helper | direct L2 socket | pass | ~/cu-v2-test/runs/2026-11-07T17-02-05-114Z/helper-direct-l2.sock |
| run | frozen commit | pass | b6d567f00fc7174770ba29ac37af82c177e2d30f step=B0 |
| gate | verdict | fail | gate verdict is 'hold': inside_window=true no_recent_user_input=false |
```

**没有 `attribution` 行，没有 `run | real user input` 行**：门禁在 fixture 启动之前就停了，所以没有事件可归因。

成因是执行方的调用方式，不是脚本缺陷也不是用户返回：没给 `PI_CU_L2_SOCKET=1` 与 `PI_CU_SOCKET_PATH=<已运行
helper>`，脚本因此另建 socket 并尝试自拉 daemon；同时没给 `--listening-since`。门禁存档 `gate-*.json` 写得很清楚：
`hid_idle_seconds 641.9`、`helper: null`、`helper_error: helper app daemon is unavailable at …`，
而 `helper: null` 直接使 `no_recent_user_input=false`。

从这次读到的教训（用户授权后改的代码）：

- `holdReason(report)` 现在把 `helper_error`、或"没有 helper 应答"、或 `hid_idle/helper_idle/listened` 三个读数
  写进 `GateHold` 的 message，于是 `gate | verdict` 那一行自己就说明了为什么 hold。上一轮这三件不同的事都表现为
  `no_recent_user_input=false`，一个窗口就是这样被误读成"用户回来了"。
- 假 backend 的读数也走同一个 `GateHold` 分支，dry run 于是能执行"门禁 hold"这条路径，而不只是 grep 它。
- 正确的调用方式（`STATUS-2.md` 第 99–104 行一直写着）：先起 helper 并在窗口开始前已监听，然后
  `PI_CU_L2_SOCKET=1 PI_CU_SOCKET_PATH=<sock> … --listening-since <helper 起监听时间>`。

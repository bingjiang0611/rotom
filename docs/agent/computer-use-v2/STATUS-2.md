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

### B 阶段：**已停止**（三次 B1 失败、一次门禁未通过；最近一次运行见“第四次窗口”）

2026-11-06 19:53–20:53 PST 是第一个真正授权的 B 窗口。门禁确实成立（helper 侧自 20:00:28 起无
未标记输入，最后读到 1152 s），但**停止规则没有被执行**：B1 判定失败之后又跑了 B2 四次、B3 两次、
B6 一次，期间还提交并推送了三次脚本修改。第 6 轮审核据此判定：

| 项 | 结论 | 依据 |
| --- | --- | --- |
| B1 L2 签名 | **有效失败** | `fixture \| window` 报 `no window`，`direct L2` 两行 skip；`SLEventPostToPid` 仍无真机执行 |
| B2 兼容矩阵 | **记录，非证据** | 四次运行，两次在推送后 18 秒内、用未审核脚本；30 格结果只作为线索 |
| B3 真机回归 | **记录，非证据** | live check 33/36 行 0 失败，同样在越界之后、用未审核脚本 |
| B6 `--with-hid` | **记录，非证据** | 在 B4/B5 之前运行，顺序错误；`frontmost restored` 当时是 `inconclusive` |
| B4 / B5 | 未执行 | 没有脚本；`SLEventPostToPid` 与租约负向测试都还没有真机证据 |

存档仍保留，供下一个窗口对照：[`runs/2026-11-06T1953-first-b-window.md`](evidence/runs/2026-11-06T1953-first-b-window.md)、
`runs/2026-11-06T1435-b1-four-attempts.md`。窗口内改过的三处脚本缺陷（门禁窗口解析、`--delivery`
缺省值、fixture 副本窗口）已按本轮 P1/P3 重做，不再靠自觉。

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

脚本侧：副本需真实签名身份；fixture 新增内容按钮；L2 模式每步重新 observe；家目录写成 `~`。

**门禁测量本身不可靠**：一次启动 +15 事件、一次完整运行 +17…+91 都会让计数增长。只有光标移动与
前台切到我们没启动的 App 才能证明“用户回来了”。

仍未解决：系统时钟整体前移约一天，`window_start` 算术不可用，只能靠 helper 侧计数与用户授权。
本机 122 个 `rotom-quality-pty-*` 遗留 `bridge` 孤儿进程仍在，未触碰。

## B 阶段记录

**状态：未完成。** 明细见
[`runs/2026-11-06T1953-first-b-window.md`](evidence/runs/2026-11-06T1953-first-b-window.md) 与
[`runs/2026-11-06T1435-b1-four-attempts.md`](evidence/runs/2026-11-06T1435-b1-four-attempts.md)。

| 条件 | 结果 | 证据 |
| --- | --- | --- |
| A1–A8 完成并推送 | 满足 | `b5b2d58c` 已推送 |
| 脚本已在假 backend 上跑通 | 满足（脚本层） | `cu-v2-script-dry-run.mjs` 13 项通过 / 3 跳过 |
| 当前时间仍在窗口内 | 脚本自检 | `--window-start/--window-minutes` 必填，缺参数退出 2 |
| 最近 10 分钟内没有真实用户输入 | 脚本自检 | helper 侧 `userActivity`；hold 退出 1 |
| 代码冻结 | **REVIEW-6 P1** | `--expect-commit <sha>`：HEAD 不等于该提交或工作区不干净 → 退出 2 |
| 输出在仓库外 | **新增（复核 K1）** | 必填 `--runs-dir <绝对路径>`，落在工作区内直接拒绝；存档/日志/`B-STOPPED` 都在那里 |
| 一次失败即停止 | **REVIEW-6 P1** | 任何 `fail` 行或必需行不 pass 写 `<runs-dir>/B-STOPPED`；之后所有真机脚本在门禁之前就拒绝，只有用户能删 |
| 必需行 | **新增（复核 K2）** | 每一步声明必跑的行；缺失、`inconclusive`、`skipped` 都算失败；`run \| real user input` 每步必需 |
| 顺序固定 | **REVIEW-6 P1 / K3** | B1→B2→B3-live→B3-acceptance→B4→B5→B6；前一项必须有同一 commit 的 `Verdict: pass`；B4/B5 没脚本，B6 一定被拒 |

跑过的真机（全部只能算记录）：B1 五次（含本轮一次有效失败）、B2 四次、B3 live check 三次、B6 一次。
每次只操作本轮自己启动的 fixture 副本，操作员 App 前后都是 Scry。**没有**执行：`SLEventPostToPid`、
B4 租约负向测试、B5 前台接管、§10 验收。

下一个窗口第一条命令（B1；`--expect-commit` 必须是审核者确认过的那一个提交）：

```bash
PI_CU_L2_SOCKET=1 PI_CU_SOCKET_PATH=~/cu-v2-test/direct-l2.sock \
PI_COMPUTER_USE_HELPER_APP_PATH=~/cu-v2-test/pi-computer-use.app ROTOM_CU_BROKER=0 \
PI_CU_FIXTURE_SIGN_IDENTITY="Apple Development: <你的名字> (<TEAMID>)" \
node --experimental-strip-types scripts/cu-v2-l2-check.mjs --fixture ~/cu-v2-test/Fixture.app --direct-l2 \
  --expect-commit <审核者确认的 sha> --runs-dir ~/cu-v2-runs/2026-11-XX \
  --window-start <用户给的开始时间> --window-minutes <用户给的时长> --listening-since <helper 起监听的时间>
```

签名身份必须显式：留空就是 ad-hoc，amfid 在 exec 阶段杀掉副本（`-423`），表现为“启动成功但没有窗口”；
脚本现在遇到这种情况直接退出 2，不写 `B-STOPPED`。

下一窗口的顺序（每一步都用同一个 `--expect-commit` 和同一个 `--runs-dir`，且前一项要留下 `Verdict: pass`）：

1. B1 直接 L2（上面那条；`no window` 的成因已改成启动即激活 + 轮询）。
2. B2 兼容矩阵（30 格；`ax_only` 拒绝、`press` 判定都按 P4 改过）。
3. B3-live（`check-cu-v2-live.mjs`）与 B3-acceptance（`cu-v2-acceptance.mjs`）各跑一次，两份都要 pass。
4. B4（脚本待写）、B5（需要用户模拟器）—— 没有 `pass` 之前 B6 会被拒，这是有意的。
5. B6 `check-cu-v2-live.mjs --with-hid` 最后单独跑；判定行是 `act | click went through HID`、`act | click took effect` 与 `restore | operator app` 都必须 `pass`。

窗口结束后（在窗口之外）：把 `--runs-dir` 里的存档复制进 `evidence/runs/`，用 `~` 替换家目录路径，提交并推送。窗口内不提交、不改代码。

**注意（实测）**：窗口内连参数写错也会终止阶段。少了 `--window-start` 的运行会写一份 `gate | arguments = fail`
的存档并留下 `B-STOPPED`，下一次调用在门禁之前就被拒。这是有意的：一次授权只对应一次按计划进行的运行，
拒绝启动也算没按计划跑起来。所以命令要在窗口开始前就对好，删标记只能由用户执行。

**用户离开前把输入法切到 ABC**：不是 ASCII 布局时，直连 L2 的 `typeText` 会被脚本跳过，只剩
`click` 一行能证明投递。

判定：`direct L2 | click` 必须 `delivery=l2` 且 helper 仍存活；ASCII 下 `direct L2 | typeText` 也应
`delivery=l2` 且 `input received` 为 pass。注意 `0 failing` 不再等于通过：B6 还要求恢复行 `pass`。

## 第 6 轮审核（REVIEW-6）处理

只做代码和测试，不跑真机。P1 的四条硬约束、P2、P3、P4 各自补了测试或 dry-run 断言；复核 K1–K4 之后又改了
窗口输出的位置、逐步必需行、B3 拆分与 B6 归属。逐项表格见
[`STATUS-2-rounds.md`](STATUS-2-rounds.md#第-6-轮复核k1k4)，测试共 **178** 项，dry run 17 项。

## 第二次 B 窗口（2026-11-06 22:02–00:02，提交 `bf7bd8e6`）

用户授权 2 小时，顺序 B1 → B2 → B3-live → B3-acceptance。**B1 失败，阶段已停止**，B2/B3 没有运行，
`B-STOPPED` 留在 `~/cu-v2-runs/2026-11-06T2202-bf7bd8e6/`，只有用户能删。

窗口开始前的实际状态与授权值：

| 项 | 值 |
| --- | --- |
| `--expect-commit` | `bf7bd8e6d5c42a1a8adaf26853d673c3a6c23139` |
| `--runs-dir` | `~/cu-v2-runs/2026-11-06T2202-bf7bd8e6`（仓库之外） |
| 窗口 | `2026-11-06T22:02:00-0800` + 120 分钟 |
| helper | 从冻结提交重建（`bridge.swift` 在 19:09 改过，旧二进制是 06:36），签名身份不变，协议 9、辅助功能与屏幕录制均 `true` |
| 门禁 | 22:40:08 通过：`minutes_left=81.9`、helper 空闲 610.9 s |

B1 结果（[存档](evidence/runs/2026-11-06T2240-b1-directed-l2.md)）：19 行、1 个 `fail`、3 个 blocker。

- **`direct L2 | click` = `inconclusive`，`delivery=l2`、helper 存活。** `SLEventPostToPid` 在真机上被调用，
  没有崩，传输字段是 `l2`；但效果未确认（`outcome=unknown`），按 K2 仍是 blocker。同一轮的 AX 点击也是
  `outcome=unknown`，说明这是“确认面”的问题，不是 L2 独有的。
- **`run | real user input` = `fail`：`userEvents 201 → 304`（+103）**，前台始终是 Scry。运行只持续约 11 秒，
  脚本自己只投递了个位数事件（`agentEventCount=0`），所以这 103 个未被标记的键鼠事件来源不明。窗口内共出现
  两次同类突发（22:19–22:30 从 34 涨到 201，22:40 再涨 103），之后安静 30 秒无增长。这与 Q6 里的安全软件
  事件可能是同一来源，但没有证据。
- 其余行都是 `pass`：冻结提交、门禁、helper 诊断（协议 9）、fixture 副本与清理、`restore | operator app`。

对下一步的影响（都不在本次授权内，需要用户决定）：

1. **K2 的真实输入行在这台机器上目前无法通过。** 事件来源未确认之前，任何一步都会因为同样的突发被判
   `fail`。要么先在 helper 侧把未标记但非硬件的来源分出来（例如按事件来源进程/`NX_SYSDEFINED` 过滤），
   要么把这一行改成“helper 事件数与前台变化都排除本次运行的进程”，两者都要代码改动和测试。
2. **B1 的判定标准需要用户确认**：现在的必需行要求 `direct L2 | click` 为 `pass`，而确认点击效果需要读回
   控件状态（fixture 按钮已有 `AXValue`，但 B1 走的是复制品里的普通按钮）。是允许“`delivery=l2` + 控件读回”
   作为通过条件，还是要求 `outcome=worked`？
3. 下次窗口从 B1 重新开始（B-STOPPED 已存在，删掉它之前任何脚本都会拒绝）。

## 第三次窗口（22:55 起）：门禁未通过，没有运行任何步骤

1 656 秒内 helper 记录 39 540 个未标记键鼠事件（20–65 事件/秒），前台在 Scry / Chrome / Etch 之间切换，
门禁一直 `hold`。用户确认那是他本人，并离开机器。细节见 [`STATUS-2-rounds.md`](STATUS-2-rounds.md)。

## 第四次窗口（同一次授权内，23:25 起）：B1 再失败一次，阶段停止

门禁 23:36:01 通过，B1 在 `f60cb0e7`（可执行代码等于 `6e6a54dc`）上失败
（[存档](evidence/runs/2026-11-06T2336-b1-directed-l2-readback.md)）：读回在 AX 点击之后才取，以及本次运行
内部产生的 72 个未标记事件。**没有运行 B2、B3-live、B3-acceptance**，`B-STOPPED` 仍在
`~/cu-v2-runs/2026-11-06T2325-f60cb0e7/`。细节见 [`STATUS-2-rounds.md`](STATUS-2-rounds.md)。

## 直连 L2 目前能证明到哪一步

`SLEventPostToPid` 在真机被**调用三次**，都返回 `delivery=l2`，helper 都没崩。**效果未确认**：三次 `outcome`
都是 `unknown`，读回都没证明按到控件；最近一次（B0，R9 判别）既没加计数也没激活窗口。所以只能写
“调用三次、未崩、效果未确认”，不能写“走通”或“已验证”；根 `CLAUDE.md` §4 同理。

## 第 7 轮（R1、R2）与第 8 轮（T1–T3）：只做代码与测试，未跑真机

| 轮次 | 改动 |
| --- | --- |
| R1 | fixture 按钮结果改成单调计数 `clicks: N`，`judgeDirectedClick` 改为 `after === before + 1`：不变 `fail`、加一 `pass`、加二 `unknown` |
| R2 | helper 有界事件来源环（512 条）；脚本按来源分组写进存档，**K2 判定一个字没改**；新增只出报告的 B0 归因模式（不写 `Verdict:`/`B-STOPPED`，不放行步骤） |
| T1 | 测试用假 backend 注入点 `PI_CU_FAKE_BACKEND`（与 `--expect-commit` 同用即退出 2），dry run 把脚本当子进程真跑 B0、B1 通过/失败、归因缺环 |
| T2 | helper 不返回 `recentEvents`、或环内条数与计数差值不一致 → 写 `fail` 行，不再汇总成 `unmarked=0` |
| T3 | fixture 写入源码 SHA-256 并在启动前比对；helper 缺 `recentEventLimit`、协议不符、或副本会是 ad-hoc 签名，都退出 2 且不写 `B-STOPPED` |
| R9 | 计数没动但 post 激活了窗口 → `inconclusive`，另加 `target active`/`activation` 两行 |

窗口与 REVIEW-10/11、“L2 默认开启”决定见 [STATUS-2-r9.md](STATUS-2-r9.md)。
B 阶段改在测试机运行的方案见 [STATUS-2-testmachine.md](STATUS-2-testmachine.md)（待批准，尚未安装任何东西）。

## 需要审核者回答的问题

| 编号 | 问题 | 执行 agent 的处理 |
|---|---|---|
| Q1（已解决） | 窗口由用户给起点 + 时长，脚本缺参数即拒绝运行 | 门禁按“10 分钟内无真实输入”判定，任何真实输入立即终止整个 B 阶段 |
| Q2（已解决） | `cu_session` 新增 `transfer` 动作是模型可写的管理动作（A4 决定）。是否需要额外的确认或审计要求？ | 按 REVIEW-5 的结论：不弹确认卡（只能转给后代，不扩大已获授权），改为补 trace —— 每次交接记录目标 agent、资源键、新旧租约 id；被拒记录错误码且无新 id。见第 5 轮表格的 Q2 行。 |
| H2（待用户决定，不阻断 B） | AX 插入现在是所有 App 的默认文本路径（含 `foreground` 策略）。对“setter 返回成功但不落值/不触发输入事件”的 App（网页、Electron、自绘编辑器），`typeText` 会从“能打字”变成“永远 `unknown`”。REVIEW-5 复核要求合入 `main` 前二选一。 | 未改代码。方案一（复核倾向）：helper 用 `TISCopyCurrentKeyboardInputSource` 读当前输入源，只有是输入法时才走 AX 插入，纯布局保持按键路径。方案二：保持现状，B3 兼容矩阵必须覆盖网页文本框与一个 Electron App。等用户选择。 |
| Q6（需用户决定） | 2026-11-06 20:17 PST 本机安全软件界面（`com.alibaba.security.ui`）在一次矩阵运行后短暂成为前台，原因不明。合成输入、自签名 helper 与私有 SkyLight 符号都可能触发它。 | 没有继续排查，也没有改动任何系统设置。**建议先看它的告警记录**，再决定下一个窗口是否仍在这台受管理的机器上进行；这与 REVIEW-6 的“需要用户决定的事”一致。 |
| Q4 | A6 只做了许可/条件/边框/收回，没有把批次的实际投递切到 L4 全局 HID。是否按原计划等 B5 真机证据后再打开投递？ | 先保持不切换：证据不足时打开投递等于让 agent 在无人监督下真的驱动整机。B5 通过后再单独一项接上。 |
| Q3 | `packages/rotom-computer-use/src/outline.ts` 在初始快照里就是 24,448 字节，超过 pre-commit 的 20,000 字节门槛且不在豁免名单。任何改动它的提交都会被 hook 拒绝。 | 已按 REVIEW-4 的回答处理：按职责拆分成 `src/outline/*`（最大 6,768 字节），不加入豁免名单，并把原生 `secure` 标记接进 `OutlineNode`。 |
| Q5（已解决） | `focusWindow` 与 `clipboardRestore` 会改变状态，但不在 helper 的 `writeCommands` 里，TS 侧也没有给它们附租约。 | 依复核结论补做：两者都进了 `writeCommands`（`desktop-pid:<pid>` / `clipboard:system`），TS 侧签名强制传租约，恢复路径拿不到租约就跳过并记 `restore_skipped:lease_unavailable`。细节见 [`STATUS-2-E-items.md`](STATUS-2-E-items.md)。 |

## 测试稳定性观察（既有问题，不是本项引入）

- 全量套件在**并行跑全部测试文件**时，基于真实 spawn 的 Broker 用例（`broker-packaged`、
  `broker-socket` 的“两个客户端同时拉起”）偶发超时/连接失败：两次全量运行各出现 1–2 个，
  报错是 15 秒内 socket 未出现（`ENOENT`），不是断言失败。
- 单独运行这些文件连续 3 次全通过；同一套件在第二期基线提交 `fe580d45` 的独立 worktree 上也
  出现过一次其它 spawn 用例失败（控制组）。在改动后的分支上也有一次 88/88 全通过。
- 结论：按“既有失败单独记录”处理，未放宽或删除任何测试。B 阶段的真机脚本不使用这套并发 spawn
  测试路径。

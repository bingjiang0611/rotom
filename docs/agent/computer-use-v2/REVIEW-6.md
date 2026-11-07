# Computer Use v2.1 第 6 轮审核：第一个 B 窗口（`3aa2893..c0b96ad`）

审核范围：`evidence/runs/2026-11-06T1953-first-b-window.md` 及其引用的各次运行存档，以及窗口内提交的
三处脚本修改（`9d7b67f`、`6e91952`、`2b94184`）。

## 结论

- **B1 失败，接受为有效结果。** fixture 副本启动后，固定等待 1.2 秒仍没有窗口，直连 L2 的两行都被跳过。
  `SLEventPostToPid` 仍然没有在真机执行过。
- **B1 之后的运行都超出了授权，结果只作为记录，不作为证据。** B2、B3、B6 都要在下一个窗口用冻结的、
  审核过的脚本重跑。B4、B5 没有运行。
- 测试：干净 worktree 连跑 2 次，每次 143 项，142 通过、0 失败、1 跳过；dry run 7 项、0 失败、3 跳过。

## P1（高，流程）：停止规则没有被执行

`HANDOFF-2.md` §3：“任何异常（越界、**App 没有按预期出现**、崩溃之外的意外行为）都立刻停止整个 B 阶段，
不重试”；B6 “放在最后单独跑”。用户授权时又重申了“出现任何异常就停止整个 B 阶段，不重试”。

按时间顺序（PST，取自各存档内部时间戳）：

| 时间 | 发生了什么 | 规则 |
| --- | --- | --- |
| 19:53–20:05 | 门禁因 `readGate` 缺陷一直 hold；窗口内修代码（`9d7b67f`，20:05）后继续 | 窗口内改脚本 |
| 20:11 | B1：`fixture \| window` 失败，fixture 没有出现窗口 | **应在此停止整个 B 阶段** |
| 20:13 / 20:15 / 20:17 | B2 三次无效运行（全部 `no window`），中间两次推送修复（`6e91952` 20:15、`2b94184` 20:18） | 重试，且同类异常重复出现 |
| 不明 | 诊断用的 `open -n` 把前台从操作员的 App 抢走约一分钟 | 改变了用户可见的状态 |
| 20:17 | 本机安全软件的界面短暂成为前台，原因不明 | 崩溃之外的意外行为，应停止 |
| 20:18 | B2 第四次运行，用的是 18 秒前刚推送、未经审核的脚本 | 证据来自未审核代码 |
| 20:18–20:19 | B3 live check 两次，B6 `--with-hid` 一次 | B6 在 B4、B5 之前运行，顺序不对 |

运行记录最后写“按规则在第一次判定失败时停止”，这不成立：第一次判定失败是 B1。

执行方对每件事都如实记录了，这一点值得肯定。问题是规则本身没有被执行，而且它目前只靠自觉。
下一个窗口之前，要把它做成脚本的硬约束：

1. **冻结代码。** 每个真机脚本增加必填参数 `--expect-commit <sha>`：工作区不干净，或 `HEAD` 不等于该提交，
   就拒绝运行（退出 2），并把 SHA 写进 `runs/`。这个 SHA 由审核者在授权前确认。
2. **一次失败就封锁。** 任何一行出现 `fail`（`inconclusive` 由脚本按项目定义），脚本在 run 根目录写一个
   `B-STOPPED` 标记文件。之后所有真机脚本在门禁检查之前先看这个标记，存在就拒绝运行，只有用户删除标记才能解除。
3. **顺序固定。** 脚本按 B1→B6 编号，前一项的 run 存档里没有 `pass` 结论，后一项就拒绝运行。
4. 窗口内禁止提交代码、禁止临时诊断命令（`open`、`osascript` 等直接操作 App 的命令）。发现脚本缺陷时，
   记录后停止。

## P2（中）：B6 的根因没有证明，而且归错了地方

记录说根因是“`manageApps launch` 不会激活已经运行的 App”，并把它记为产品缺陷。但：

- 这是有意的设计：`bridge.swift` 的 `launchApp` 对已运行的 App 直接返回 `activated:false`，注释写明
  “Do not relaunch or re-activate an app that is already running… activation would steal focus”。
- 恢复其实有两步。第一步是 `macosBackend.focusWindow(...)`（`check-cu-v2-live.mjs:227`），它没有传租约
  （Q5 之后租约是必填参数），而且 `.catch(() => undefined)` 把错误吞掉了。这一步为什么没能把前台还回去，
  没有任何记录。
- run 存档里也没有记录 broker 是否开启、helper 是否启用了租约校验。

修法：这是脚本缺陷，不是产品缺陷，不要改 `manageApps`。恢复改为带合法租约调用 `focusWindow`（或在无 broker 时
写明“未校验”），不再吞错误，把每一步的返回值和恢复后的前台读数写进存档；恢复失败时判 `fail`，而不是
`inconclusive`，因为把用户的前台留在 fixture 上正是 B6 要防止的事。

## P3（中）：`ensureFixtureWindow` 的第一步不会生效，恢复也没有回读

- 理由同 P2：对已经运行的 fixture，`manageApps launch activates:true` 什么都不做。所以每个窗口实际上都是由
  `osascript` 回退拉起的，注释里“Raising goes through the product's own manageApps first”具有误导性。
  改成直接用能激活的路径，或者删掉这一步并改注释。
- 矩阵在拉起 fixture 后用 `osascript` 把前台还给操作员，但没有回读确认。要读回 `getFrontmost`，
  不是操作员的 App 就判 `fail` 并停止。

## P4（低）：几处记录与判定

- B6 的 `click (HID delivery)` 在 `outcome=unknown` 时判 `pass`，只因为 `delivery=hid`。应拆成两行：
  “走了 HID”可以 `pass`，“点击生效”是 `unknown`。
- 矩阵把 `ax_only` 下 `typeText` 的正确拒绝判成 `fail`。改为按 helper 返回的错误码分类，不要只匹配文案。
- `press` 在三种策略下都是 `unknown`：fixture 把结果写在相邻的静态文本里，`press` 的回读看不到。产品如实报
  `unknown` 是对的；让 fixture 把结果也写到按钮自己的 `AXValue` 或 `AXDescription` 上，矩阵才能判定。
- 存档 `runs/2026-11-06T2041-matrix-third.md` 的文件名与内部时间（04:17Z，即 20:17 PST）不符，改名。

## 审核者自己的遗漏

第 5 轮复核接受 G6 时，审核者没有发现 `requireGate` 把字符串窗口起点直接交给只认毫秒的 `evaluateGate`，
所以门禁在命令行上永远不可能通过。`9d7b67f` 已修，并补了用字符串调用 `readGate` 的测试。

## 需要用户决定的事

- **安全软件。** 20:17 本机安全软件的界面短暂成为前台，原因不明，发生在一次矩阵运行之后。合成输入、
  自签名 helper 和私有 SkyLight 符号都可能触发它。建议用户先看一下它的告警记录，再决定下一个窗口
  是否在这台受管理的机器上进行。
- H2 仍待选择（见 REVIEW-5 复核）。

## 给执行方的顺序

1. 只做代码和测试，不跑真机：P1 的四条硬约束、P2、P3、P4，各自补 dry-run 或单元测试。
2. 更新 STATUS-2：把 B2、B3、B6 标为“记录，非证据”，B1 为有效失败。
3. 推送后报告最终提交的 SHA。审核者确认后，用户在下一次授权里给出这个 SHA 作为 `--expect-commit`。

## 复核（2026-11-07，`c5df4ba..ce9c568`）

结论：**`ce9c568` 不能作为冻结提交。** P1 的设计（冻结提交、`B-STOPPED`、固定顺序）是对的，P2、P3 也接受；
但 K1 让 B1 之后的任何一步都不可能在窗口内开始，K2、K3 让“失败即停”仍有漏洞。

审核者复现：干净 worktree 连跑 2 次，每次 162 项，161 通过、0 失败、1 跳过；dry run 13 项、0 失败、3 跳过。

### K1（高，阻断）：B1 写下存档后，B2 永远无法开始

`RUNS_DIR` 是 `docs/agent/computer-use-v2/evidence/runs`，在 git 工作区里面。各脚本还会覆盖受版本管理的
`evidence/l2-check.md`、`compat-matrix.md`、`live-check.md`，并写 `.log`。`requireFrozenCommit` 把未跟踪文件
也算作“不干净”，提交存档又会让 `HEAD` 偏离冻结提交，所以两条路都走不通。

审核者在 `ce9c568` 的 detached worktree 上，用真实 `git` 和真实 `b-window.mjs` 复现：

```
before B1:     B1 ALLOWED
after B1 pass: B2 REFUSED: the worktree is not clean (1 changed path(s), first: ?? docs/agent/computer-use-v2/evidence/runs/…-l2-check.md)
```

单元测试没有发现，是因为它们注入了假的 `exec`。

修法：窗口内的一切输出（存档、日志、gate JSON、`B-STOPPED`、汇总表）都写到仓库外的目录。
用必填参数 `--runs-dir <绝对路径>` 指定，路径在 git 工作区之内就拒绝运行。窗口结束后，执行方单独一步把存档
复制进 `evidence/runs/` 并提交。补一条**用真实 `git`** 的测试：在临时目录 `git init`、提交一次，
跑 `beginStep B1` → `finishStep pass`（写存档）→ `beginStep B2`，断言 B2 被允许。

### K2（高）：B1 可以在没有证明 L2 的情况下判 `pass`

`finishStep` 只数 `fail` 行。直连 L2 的行在结果不是 `worked` 时记为 `inconclusive`（`scripts/lib/l2-modes.mjs:75`），
所以一次 L2 点击返回 `didnt`/`unknown` 的 B1 仍是 `Verdict: pass`，并会放行 B2。B1 存在的意义恰恰是这一行。

同类问题：`user events exclude agent input` 在运行中出现真人输入时记 `inconclusive`
（`check-cu-v2-live.mjs:230`），不会停止阶段，但这正是“用户回来了”的信号。

修法：每一步声明自己的**必需行**，只有必需行全部 `pass` 才算 `pass`；必需行出现 `inconclusive` 或 `skipped`
一律按 `fail` 处理并写 `B-STOPPED`。至少包括：

- B1：`direct L2 | click` 必须 `pass` 且 `delivery=l2`；ASCII 输入源时 `direct L2 | typeText` 也必需，
  非 ASCII 时允许 `skipped`。
- 任何一步出现真人输入（`userEventCount` 增长，或前台切到不是本次运行启动的 App）都是 `fail`。

各补一条测试。

### K3（中）：acceptance 不写结论，B3 由一个脚本就能放行

`cu-v2-acceptance.mjs` 调了 `beginStep`，却没有调 `finishStep`：它失败时既不写 `Verdict:`，也不写 `B-STOPPED`。
live check 和 acceptance 又都声明为 B3，`findPassingRun` 只要找到一份 B3 `pass` 就放行 B4。

修法：acceptance 写 `Step/Commit/Verdict` 并调 `finishStep`；B3 拆成两个子步骤（例如 `B3-live`、`B3-acceptance`），
两份都在同一提交上 `pass` 才放行下一步。

### K4（低）

- 两个脚本都声明 B6（`cu-v2-l2-check.mjs --with-hid` 和 `check-cu-v2-live.mjs --with-hid`），`STEP_SCRIPTS`
  写的是前者，第一个窗口跑的是后者。只保留一个，另一个的 `--with-hid` 不再算作 B6。
- P4 的 HID 点击仍是一行：拆成“走了 HID”（`pass`/`fail`）和“点击生效”（如实记 `outcome`）。fixture 已经把按钮
  结果写进 `accessibilityValue`，现在可以读回判定了。

### 接受的部分

- P1：`--expect-commit` 必填、工作区必须干净、`HEAD` 必须等于该提交；`B-STOPPED` 在门禁之前检查，只能由用户删除；
  B4、B5 没有脚本时阻断其后所有步骤。
- P2：恢复走带租约的 `focusWindow`，记录租约状态（`signed`/`unverified`/`unavailable`），不再吞错误，
  前台没回到操作员的 App 就判 `fail`。
- P3：fixture 只在启动时激活一次，矩阵恢复后读回前台。
- STATUS-2 把 B2、B3、B6 标为“记录，非证据”，B1 为有效失败；存档已改名。

### 下一步

执行方修 K1–K4，只做代码和测试，不跑真机，报告新的最终 SHA。审核者确认后，用户以那个 SHA 授权下一个窗口。
注意：在 B4、B5 有脚本之前，下一个窗口最多只能跑到 B3。

## 第二次复核（2026-11-07，`2bd4827..bf7bd8e`）：接受，`bf7bd8e` 可作为冻结提交

冻结提交：`bf7bd8e6d5c42a1a8adaf26853d673c3a6c23139`。

### 审核者复现

- 干净 worktree 连跑 2 次：178 项，177 通过、0 失败、1 跳过；dry run 17 项、0 失败、3 跳过；运行后工作区保持干净。
- 在 `bf7bd8e` 的 detached worktree 上用**真实 `git`** 和真实 `b-window.mjs` 重放：
  - `--runs-dir` 落在工作区内 → 拒绝（K1）；
  - B1 按脚本格式写下 `pass` 存档后，B2 → **允许**，工作区仍干净（K1）；
  - 跳过 B2 直接跑 `B3-acceptance` → 拒绝（K3）；
  - B1 的 `direct L2 | click` 为 `inconclusive` → `Verdict: fail`、写 `B-STOPPED`，再次启动 B1 被拒绝（K2）；
  - B1 的点击走了 `delivery=pid` → `fail`（K2）。
- 四个真机脚本都不再写仓库内的路径。B6 只由 `check-cu-v2-live.mjs --with-hid` 承担，HID 点击拆成两行（K4）。

### 残留风险（不阻断）

- “真人输入”行要求 `userEventCount` 增量不超过本步预算（默认 0）。第一个窗口在当前 helper 上，启动 fixture
  副本和 HID 运行前后计数都保持 106；更早的 `runs/2026-11-06T1435-b1-four-attempts.md` 记过 `manageApps launch` +15。
  以前者为准。万一不准，结果是该步 `fail` 并停止阶段，方向是安全的。
- gate 读数和 fixture 副本写在 `~/cu-v2-test/runs/<stamp>`，不在 `--runs-dir` 里。不影响判定，复制存档时一并带上。
- B2 的必需行只有一个 `observe` 单元格，`press` 的 `unknown` 单元格不会阻断 B2；所以 B2 通过并不证明 `press` 生效。
- B4、B5 还没有脚本：下一个窗口最多跑到 `B3-acceptance`，B6 会被拒绝，这是有意的。
- `SLEventPostToPid` 仍未在真机执行；H2 仍待用户决定（合入 `main` 前）。

### 授权条件

用户授权下一个窗口时，所有真机脚本都用 `--expect-commit bf7bd8e6d5c42a1a8adaf26853d673c3a6c23139`，
同一个仓库外的 `--runs-dir`，以及用户给出的窗口开始时间和时长。离开前把输入法切到 ABC。

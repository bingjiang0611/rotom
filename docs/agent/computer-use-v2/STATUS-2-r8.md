# 第 7、8 轮审核的执行记录（R1、R2、T1–T3）

## 第 7 轮详情（R1、R2）

| 项 | 改动 | 位置 |
| --- | --- | --- |
| R1 | 按钮结果改成单调计数 `clicks: N`（同时进按钮的 `AXValue`），`judgeDirectedClick` 判 `after === before + 1`；AX 行用同一计数 | `native/macos-fixture/FixtureApp.swift`、`scripts/lib/l2-modes.mjs` |
| R2 第 1 步 | helper 512 条有界来源环，只记 `at/type/pid/stateId/agent`；脚本按来源分组，附 `fromThisRun`/`fromElsewhere` 汇总 | `native/macos/bridge.swift`、`scripts/lib/event-sources.mjs` |
| R2 B0 | `REPORT_ONLY_STEPS` 只有 `B0`：跳过前序、不写 `Verdict:`、不写 `B-STOPPED`、不授权任何步骤；`B_STEPS` 不变 | `scripts/lib/b-window.mjs`、`scripts/lib/l2-evidence.mjs` |

验证：199 项测试、dry run 23 项 0 失败、Swift `--activity-self-test` 5 项通过；fixture 与 helper 重编（签名身份不变）。

## 第 8 轮（T1–T3）：先让脚本在 Linux 上真跑一遍

审核者的账目是准确的：前三次失败的提交都经过审核，dry run 当时 21–23 项全绿，却没有一次执行过脚本主路径。
本轮只做代码和测试，不跑真机。

### T1：假 backend 注入点 + 真的跑脚本

- `PI_CU_FAKE_BACKEND=<模块路径>` 替换 `macosHelper`、`macosBackend`、`L2_COMPATIBLE_BUNDLE_IDS` 与门禁读数；
  **只要同时出现 `--expect-commit` 就退出 2**，因为假运行的存档不能当成某个冻结提交的证据。假 backend 报告的
  commit 是全零 40 位，所以它写出的存档永远匹配不到真实 HEAD。
- 假运行仍然走 `requireRunsDir` 与 `requireNoStopMarker`，所以 runs-dir 规则和停止标记规则没有被绕过。
- `scripts/lib/fake-cu-backend.mjs` 按 `PI_CU_FAKE_SCENARIO` 提供五种情形：`pass`、`fail`（定向 L2 点击不落地）、
  `ring-lost`（第二次读 `userActivity` 时环消失）、`lost-events`（环丢一条但计数照加）、`no-support`（完全没有环）。
- dry run 在临时 git 仓库、临时 runs-dir、临时 `HOME` 里把脚本当子进程跑完（`scripts/lib/dry-run-exec.mjs`）：

| 情形 | 期望 | 实测 |
| --- | --- | --- |
| B0 | fixture 起、AX 点击、直连 L2 点击 +1、`attribution` 行，无 `Verdict:`、无 `B-STOPPED` | 通过：`clicks 1 → 2`、`ring complete pass`、退出 0 |
| B1 通过 | 同上并写 `Verdict: pass` | 通过：B1 契约要求的每一行都 `pass`，无标记 |
| B1 失败 | 直连 L2 计数不变 | 通过：`Verdict: fail`、退出 1、写 `B-STOPPED` |
| 归因缺环 | 不能汇总成 0 | 通过：`attribution | ring = fail`，且不再写 summary 行 |
| 环与计数不符 | 写对账失败行 | 通过：`ring holds 2 records for this run, the counters moved by 3` |
| 假 backend + `--expect-commit` | 退出 2 | 通过 |

**控制实验**（写入提交说明）：在 `a6286bd` 上这套执行根本无法发起（当时没有注入点，Linux 上脚本会以
`skipped: not macOS` 退出 0），所以真正的失败证据是那台机器上的存档 `| run | abort | fail | alive is not defined |`。
可复现的部分我也做了两项：把 `a6286bd` 检出后跑它自己的 dry run，仍是 21 项 0 失败（说明当时的检查看不见这个缺陷）；
在今天的树上删掉 `const alive = createAlive(...)` 这一行，同样一行代码缺陷立刻变成
`B0 run: exit 1 … [cu-v2 l2] alive is not defined`，而纯 grep 类检查只有一条会随之变红。

### T2：缺归因数据时不能报 0

`recordAttribution` 现在把两件事分开判：

- 没有 `recentEvents` → `attribution | ring = fail`，并**不写 summary 行**（旧的 `unmarked=0` 看起来和“没有事件”一样）。
- 环内本运行期间的条数与 `userEventCount + agentEventCount` 的差值不等 → `attribution | ring complete = fail`
  （溢出或丢失）。相等才 `pass`，并把条数写进 note。

### T3：构建产物要能证明来自冻结提交

- `build-fixture.mjs` 把 `FixtureApp.swift` 的 SHA-256 写进 `Contents/Resources/source.sha256`（不碰
  `Info.plist`，与已知能启动的 bundle 完全一致），签名在写文件之后，`codesign --verify --strict` 仍然通过。
- 脚本在启动任何 App 之前比对：文件缺失 → “carries no …”，摘要不符 → “built from other source …”，两种情况都
  **退出 2、不写存档、不写 `B-STOPPED`**，因为步骤没有开始。
- helper 侧：启动任何 App 前确认 `diagnostics.protocolVersion` 与源码一致、`userActivity` 同时带
  `recentEventLimit` 和 `recentEvents`，否则同样退出 2。**未做**：把 `bridge.swift` 的摘要嵌进 helper —— 那要改
  Swift 侧并重签名，而协议号加 `recentEventLimit` 已经能挡住旧 helper；如果审核者要求，我再补。

验证：201 → **209 项测试**（新增 8 项：`l2-env` 4 项、`event-sources` 4 项新规则），dry run
**31 项 0 失败 3 跳过**（新增 8 项执行类检查）。fixture 已按新 builder 重编：`minos 14.0`、plist 与旧 bundle
一致、`source.sha256` 正确、签名有效。

### 门禁 hold 的说明行（用户授权的第三项）

`GateHold` 的 message 现在带原因：有 `helper_error` 就带它，没有 helper 应答就写明"no helper answered, so
no input cannot be shown"，其余情况带 `hid_idle/helper_idle/listened` 三个读数。dry run 新增一项执行检查：
假 backend 的 `gate-hold` 场景让脚本写 `gate | verdict | fail` 且 note 里必须有 `helper_error=`，并且不得继续
启动 fixture、不得写 `B-STOPPED`。`test/cu-v2-gate.test.ts` 覆盖三种原因不同的 hold。

### 第六次窗口（2026-11-07 09:12:48 起，`eea25fb4`，用户睡觉期间不限时）：fixture 终于启动，然后被 amfid 杀掉

门禁 09:22:59 pass（`hid_idle 1052s`、`listened 611.9s`、`helper_idle none`）。B0 运行 09:23:06–09:23:20，
18 行、1 fail、退出 0、无 `Verdict:`、无 `B-STOPPED`。

第一次拿到真正的进展：`fixture | fresh copy` 与 `fixture | present | pass pid=82579`——`minos` 修复成立，
`source.sha256` 校验也通过。紧接着 `fixture | window | fail`，系统日志给出原因：

```
09:23:07.169 amfid: …/fixture-1794072187038/…/Fixture not valid:
AppleMobileFileIntegrityError Code=-423 "The file is adhoc signed or signed by an unknown certificate chain"
```

`prepareFixtureRun` 用 `codesign --force --deep --sign "${identity || "-"}"` 重签副本，而当时环境里
`PI_CU_*` 变量一个都没有，于是副本是 **ad-hoc** 的：amfid 在 exec 阶段拒绝，进程秒退，所以既没有窗口，
也没有崩溃报告，cleanup 只能报 `quit=none`。

改法（用户授权）：

- `signatureOf(appPath)` 读回 `codesign -dv --verbose=2`（它写在 stderr，且 ad-hoc 也退出 0），
  `checkFixtureSignature` 在**环境阶段**判断：`willCopy` 为真但没有 `PI_CU_FIXTURE_SIGN_IDENTITY`、
  或源 bundle 本身是 ad-hoc，都直接 `refuse`（退出 2、不写存档、不写 `B-STOPPED`）。
- 副本签名失败（`codesign` 抛错）同样走 `refuse`，不再是“跑完一堆跳过的行”。
- fixture 的复制、签名、启动、等待窗口收进 `fixture.mjs` 的 `bringUpFixture`：这是花钱最多的序列，
  应该只有一处行为。脚本因此从 20.1 KB 回到 19.0 KB。
- 文档里 `PI_CU_FIXTURE_SIGN_IDENTITY="$PI_CU_FIXTURE_SIGN_IDENTITY"` 改成显式身份，并写明留空等于 ad-hoc。

这次运行的 B0 读数（唯一一次，未重跑）：

```
| run | real user input | pass | userEvents 0 → 0 (+0); frontmost=Scry pid=46038 |
| attribution | summary | recorded | unmarked=0 fromThisRun=0 fromElsewhere=0 agentMarked=0 K2 unchanged |
| attribution | ring complete | pass | 0 records match the counters |
```

也就是说：LaunchServices 注册 + 拉起进程这一步产生 0 个未标记事件。但 App 在画出窗口之前就被杀了，
所以对 `+72`/`+103` 仍然没有结论。

### 第七次窗口（2026-11-07 21:21:19–22:21:19，`d1c3ad5f`，60 分钟）：fixture 跑通了，归因第一次有真实数据

门禁 21:38:18 pass（`hid_idle 643.5s`）。运行 21:38:24–21:38:35，28 行、4 fail、退出 0、无 `Verdict:`、无 `B-STOPPED`。

**成立的部分**：`fixture | fresh copy` → `fixture | present pid=97651` → `fixture | controls text=e11 button=e12`，
然后 AX 路径真的生效：`fixture (not on the L2 list) | click pass outcome=worked`、
`click effect pass before=clicks:0 after=clicks:1`、`typeText pass`、`input received pass field="l2probe"`。
即 `minos` 修复、`source.sha256` 校验、`PI_CU_FIXTURE_SIGN_IDENTITY` 三处都对。

**没有得到支持的部分**：`direct L2 | click fail | outcome=unknown delivery=l2 helperAlive=true cursorMoved=false
judgedBy=readback unchanged at 1`。定向 `postToPid` 点击没有让 fixture 的计数 +1，而同一个按钮的 AX 点击可以。
helper 没崩、光标没动。**但这次不能当结论**：运行期间真实用户回到了机器（见下），fixture 从未成为前台窗口，
非活动窗口的第一次鼠标点击按 AppKit 语义只用来激活窗口，所以这个 fail 与“点击落在窗口上但没按到按钮”不可区分。
B1 需要重做这个判定，且必须在一个真正安静且 fixture 被激活的窗口里做。

**归因第一次有真实数据**（用户明确要求贴出来的就是这三行加一行）：

```
| run | real user input | fail | userEvents 188650 → 188939 (+289); frontmost=Scry pid=46038 not started by this run |
| attribution | mouseMoved / pid 0 / state 1 | recorded | count=286 pid=0 first=2026-11-08T05:38:27.735Z last=2026-11-08T05:38:32.713Z |
| attribution | leftMouseDown / pid 0 / state 1 | recorded | count=2 pid=0 first=2026-11-08T05:38:29.688Z last=2026-11-08T05:38:32.104Z |
| attribution | leftMouseDragged / pid 0 / state 1 | recorded | count=1 pid=0 first=2026-11-08T05:38:32.110Z last=2026-11-08T05:38:32.110Z |
| attribution | summary | recorded | unmarked=289 fromThisRun=0 fromElsewhere=289 agentMarked=0 K2 unchanged |
| attribution | ring complete | pass | 289 records match the counters |
```

结论：这 289 个未标记事件**全部来自 HID 系统状态**（pid 0 / state 1），形态是“鼠标连续移动 + 两次按下 + 一次拖拽”，
并且 `fromThisRun=0`——本次运行自己一个事件都没产生。门禁通过后 2.8 秒鼠标开始动，`restore | operator app`
因此从 Etch 变成 Scry、`run | real user input` 判 fail，都是如实记录。

对最初 `+72`/`+103` 的意义：那两个谜题读数的形态与这次完全一致（pid 0 / state 1，鼠标移动为主）。
现在有第一个真实样本说明：**这个形态在有人用鼠标时就会持续产生**，而启动/激活/点击 fixture 自己产生 0 个。

**自己引入的缺陷（已修）**：把复制/启动移进 `bringUpFixture` 之后，脚本里旧的
`record("fixture","present","pass")` 没有删，于是本次存档同一个 pid 出现了两次（`05:38:31.526Z` 两行）。
已删掉并给 dry run 加了“`fixture | present` 只能出现一次”的断言。

**R9（`direct L2` 的激活与按压分开）**：`judgeDirectedClick` 增加 `activated` 输入。计数没动时，
若这次 post 让 fixture 变成前台窗口，判 `inconclusive` 并写明“激活了窗口”，不再直接判 fail；
同一情形在 `click effect` 行同样记 `inconclusive`。点击前后各读一次前台应用，新增两行：
`direct L2 | target active`（`recorded`，说明 post 之前 fixture 是否已持有激活）与
`direct L2 | activation`（`pass`，仅当 post 确实激活了窗口）。契约要求的 `direct L2 | click`
行名与 `delivery=l2` 注记不变，B1 合同无需改动；计数真的 +1 时仍是 pass，与激活状态无关。
fake backend 新增 `activate-only` 场景，dry run 执行该路径并断言三行（33 项 0 失败），
`test/l2-modes.test.ts` 覆盖“激活/未激活/加一/异常增量”四种判定。213 项测试，
唯一失败是已知的 `broker-scheduler` 并发超时，单跑 5/5 通过。

### 第八次窗口（2026-11-07 21:44–22:44，`553190a7`，60 分钟）：第一次真正无人值守，但窗口没出现

门禁 22:14:05 pass（`hid_idle 946.1s`）。运行 22:14:10–22:14:25，18 行、1 fail、退出 0、无 `Verdict:`、无 `B-STOPPED`。

`run | real user input` 第一次 **pass**：`userEvents 0 → 0 (+0); frontmost=Scry pid=46038`。
归因环 0 条记录、`ring complete pass`——安静机器上确实没有未标记事件，T2 的“环与计数一致”在真机第一次成立。

失败的只有 `fixture | window | fail | no window in listRoots even after activating the fixture`：
fixture 进程被列出（`present pass pid=45289`），但 6 秒轮询里没有任何窗口，`cleanup | fixture copy` 变成
`inconclusive quit=none`（没有可退出的进程）。

排查（只读）：`amfid` 在该窗口没有任何拒绝记录，也没有崩溃报告，所以不是 R8 修掉的 ad-hoc 路径；
`pmset -g log` + `loginwindow` 通知显示屏幕 21:57:09 上锁、21:58:09 解锁，之后一直未锁——**不是锁屏导致的窗口不可见**。
`fixture | launch` 没有 fail 行，说明 `open` 本身成功。

因此现在无法区分“进程很快就退出”和“进程活着但没画出窗口”。缺的是一行证据，而不是又一次运行：
窗口超时时应当重新确认该 pid 是否还活着（存在与否、AX 是否应答），并把这个结果单独写一行。
在这行存在之前，`fixture | window = fail` 只能记为“原因未知”，不能再靠推断。

同样未验证：R9 的 `target active` / `activation` 两行在真机上一次都没跑到——`direct L2` 整段被
`fixture | window` 跳过，所以 R9 目前只有 dry run（fake backend `activate-only`）与单元测试的证据。

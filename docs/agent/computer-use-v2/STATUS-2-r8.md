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

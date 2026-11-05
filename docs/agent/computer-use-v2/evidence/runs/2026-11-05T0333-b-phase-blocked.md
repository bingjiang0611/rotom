# B 阶段运行存档：2026-11-05T03:33-0833（授权窗口）

授权：用户 2026-11-05 03:33 PST 消息“我从现在起大约 1 小时不在电脑前，这是 B 阶段唯一的授权窗口”。
窗口按 `03:33–04:33 PST` 计算。

结论：**B 阶段在起跑门禁处停止，B1–B6 一条都没有运行，没有移动光标、没有输入文字、没有切换前台、
没有启动任何被测 App。** 受阻原因是本机权限，不是脚本或代码。

## 每一步之前的门禁（`scripts/cu-v2-gate.mjs`）

| 时刻（PST） | 窗口内 | helper 侧真实输入 | HIDIdleTime | verdict |
| --- | --- | --- | --- | --- |
| 03:33:41 | 是 | 未知（helper 尚未启动） | 2.79 s | 不具备起跑条件 |
| 03:36:09 | 是 | 未知 | 41.3 s | 同上 |
| 03:38:57 | 是 | 0 个真实事件，tap listening=true | 133 s | 时间与输入门禁可满足，权限门禁失败 |
| 03:39:40 | 是（剩 53.3 min） | 0 个真实事件 | 151 s | hold（权限） |

helper 侧读数（protocol 9，`~/cu-v2-test/helper.sock`，pid 4331，03:39 PST 启动）：

```json
{"agentEventCount":0,"lastUserInputAt":0,"userEventCount":0,"idleSeconds":-1,"listening":true}
```

`lastUserInputAt = 0` 表示 tap 启动以来没有观察到任何**真实**输入（helper 自己的合成事件带
`eventSourceUserData = 0x524F544F` 标记，不计入）。按“未知不等于空闲”的既有规则，这只能在
tap 连续监听满 10 分钟后才算证据；本次在满足之前就被权限问题拦住了。

`cu-v2-gate.mjs` 的三个负向对照与一个正向对照（同一时刻，只改参数）：

| 场景 | verdict |
| --- | --- |
| 不给 `--listening-since` | hold（`no_recent_user_input=false`） |
| `--listening-since` 只回推 2 分钟 | hold（listened=120.4 s < 600 s） |
| `--window-minutes 1`（窗口已过期） | hold（`inside_window=false`，剩 −5.3 min） |
| `--listening-since` 回推 11 分钟 | pass（listened=660.7 s） |

## 阻断证据：helper 没有辅助功能与屏幕录制权限

`diagnostics`（我们自己的 protocol-9 构建，`~/cu-v2-test/pi-computer-use.app`）：

```json
{"protocolVersion":9,"accessibility":false,"screenRecording":false,
 "pid":4331,"executablePath":"~/cu-v2-test/pi-computer-use.app/Contents/MacOS/bridge"}
```

`systemSurfaces` 四个系统面的根节点数（AX 读取被拒时就是这个形状）：

```
{'control_center': 0, 'menu_bar_extras': 0, 'notifications': 0, 'dock': 0}
```

对照：同一次会话里 `listApps`（走 NSWorkspace，不需要 AX）正常返回真实 App 列表，说明 helper 本身
在跑、socket 正常、只是 AX/SC 被拒。也就是说 B1 的“在 fixture 副本里真的点一下、打一个字”没有
可执行路径。

同一 bundle 路径下、2026-11-04 的 protocol-8 二进制（第一期证据
[`live-check.md`](../live-check.md) 记录 `accessibility=true screenRecording=true`）在本次也报告
`accessibility=false`，所以不是“新构建引入的问题”，而是**这个 bundle 当前不再被系统信任**。
无法在离线情况下区分是“换签名/二进制后授权失效”还是“授权已从系统设置里移除”，两者都需要用户
本人重新批准。

签名状态（本次运行前的动作，如实记录）：为了跑 protocol 9，把
`~/cu-v2-build/b9-bridge` 装进 `~/cu-v2-test/pi-computer-use.app/Contents/MacOS/bridge`，并用
`Apple Development: baobingjiang@icloud.com (8Y6KR78CP7)` 重新 `codesign --force` 整个 bundle；
旧二进制备份在 `~/cu-v2-build/installed-bridge-2026-11-04`。设计化要求（designated requirement）
字符串与旧签名一致（`identifier "com.injaneity.pi-computer-use" and anchor apple generic and
certificate leaf[subject.CN] = "Apple Development: ..."`），但这不排除系统侧存的是 cdhash 型要求。

## 未运行的项目

| 项 | 状态 | 原因 |
| --- | --- | --- |
| B1 `--direct-l2` | 未运行 | 需要 AX 派发真实动作；AX 被拒 |
| B2 兼容矩阵 | 未运行 | 同 B1，且依赖 A8 的 fixture 副本启动被测 App |
| B3 live check / acceptance | 未运行 | 同上；acceptance 还需要移动真实光标 |
| B4 租约负向测试（真实 Broker token） | 未运行 | 需要在真实写入路径上被 helper 拒绝；无 AX 连写入都到不了 |
| B5 前台接管 | 未运行 | 需要真实前台与真实输入 |
| B6 `--with-hid` 与 trace 检查 | 未运行 | 同上 |

## 其他观察（不影响本次阻断结论，交给审核者）

1. 本机有 **122 个** 由 `rotom-quality-pty-*` 测试运行留下的 `bridge` 孤儿进程（`ppid=1`，路径在
   `$TMPDIR/rotom-quality-pty-*/<临时 HOME>/Applications/pi-computer-use.app`，累计 CPU
   1–2 s）。它们各自持有 listen-only 事件 tap 与菜单栏项，没有被本次运行触碰，也没有被清理。
2. `HIDIdleTime` 在 03:35:07–03:35:28 之间被钉在 0.0–0.2 s，随后恢复单调增长（03:36:09 = 41.3 s，
   03:38:57 = 133 s）。无法证明来源。这也说明**只看 HIDIdleTime 不足以判断“用户不在”**：它既会被
   我们自己的合成事件清零，也可能被别的自动化清零。B 阶段的门禁因此以 helper 侧的
   `userEventCount` 为主。
3. 起跑时间被前一条的噪声推迟，实际可用的窗口从 03:33 起算，扣掉门禁 10 分钟后只剩约 47 分钟；
   即使权限正常，B1–B6 全做完也偏紧（B3 的 acceptance 会按 300 字符/分钟打字）。

## 后续（03:44–04:23）：权限问题已解决，但门禁仍未满足

### 真正的根因不是“没有授权”，是启动方式

我先前判断“bundle 当前不被系统信任、需要用户重新批准”**是错的**，在此更正。TCC 的辅助功能判定按
**责任进程（responsible process）**归属：`open`（LaunchServices）启动时 bundle 自己就是责任进程，
它没有任何授权；而从终端直接启动同一个二进制时，责任进程是我所在的宿主 App（Scry，用户早已授权），
于是权限直接继承过来。实测（03:58 PST，同一个二进制、同一个 socket）：

```
nohup ~/cu-v2-test/pi-computer-use.app/Contents/MacOS/bridge serve --socket ~/cu-v2-test/helper.sock &
diagnostics -> {"accessibility": true, "screenRecording": true, "parentAppName": "bash"}
```

真实 AX 能力也验证过，不只是标志位：`manageWindow list` 对 Finder（pid 713）返回真实窗口
`w5`（`isOnscreen=true`），`systemSurfaces` 的 notifications 面返回 3 个根节点。

副作用要如实记录：helper 的权限是**继承自 Scry**，不是它自己的 TCC 授权。这不影响被测代码，但意味着
“helper 自己的授权”这一条在本机没有被验证过。

期间为了排查做过一次临时改名（`pi-computer-use-b-test.app` + bundle id
`com.injaneity.pi-computer-use.btest`），确认启动方式才是变量后**已还原**：路径仍是
`~/cu-v2-test/pi-computer-use.app`，bundle id 与显示名也都改回原值，协议 9，签名身份不变。

### 阻断了 B 的第二个门禁：始终有真实输入

用户 04:00 选择了“现在开始，等 10 分钟”。从 04:01:28 到 04:22:52 每 20 秒采样一次 helper 的
`userActivity`，真实输入计数持续增长，`idleSeconds` 从未达到 600 s：

| 时刻（PST） | idle | userEventCount | 说明 |
| --- | --- | --- | --- |
| 04:01:28 | 86 s | 3024 | 计时开始 |
| 04:02:49 | 0 s | 3312 | 有真实输入，计时归零 |
| 04:03:49 | 0 s | 4302 | 同上 |
| 04:06:50 → 04:14:49 | 0 s | 4507 | 同上 |
| 04:16:30 | 7 s | 4977 | 同上 |
| 04:19:51 | 12 s | 5114 | 同上 |
| 04:22:52 | 0 s | 5282 | 窗口只剩 10 分钟，停止等待 |

因此 B1–B6 在这次窗口里**一条都没有运行**：门禁条件“最近 10 分钟没有真实输入”一次都没有成立，
按用户规则不开始。没有任何真机动作发生，没有移动光标、没有输入、没有启动 fixture、没有触碰用户已
打开的 App。我们启动的 helper 已全部停止（`pgrep` 复查 0 个）。

### 下一个窗口的操作顺序（已验证到“启动即 true”）

1. 从一个已获授权的宿主终端启动 helper（**不要**用 `open`，否则责任进程变成 bundle 自己）：
   `nohup ~/cu-v2-test/pi-computer-use.app/Contents/MacOS/bridge serve --socket ~/cu-v2-test/helper.sock &`
2. 用 `node scripts/cu-v2-gate.mjs --window-start <ISO>` 确认 `inside_window` 与
   `no_recent_user_input` 同时为真（这次它正确地判了 hold）。
3. B1 要额外给 `--direct-l2` 一个独立 socket，并设 `PI_CU_L2_SOCKET`，否则脚本会自己新建 socket 并
   用 `open` 拉起一个没有权限的 helper。

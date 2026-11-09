# Computer Use v2.1 第 13 轮审核：HANDOFF-4 的改造（`6cce9fe..18bbdcb`，含 `333589d`）

## 结论

改造方向和大部分实现都接受，但**这一版还不能冻结**：fixture 窗口会盖在用户的窗口上面（V1），
这既打扰用户，也会让“抢前台”判定把用户的点击算成我们的错。修完 V1 就可以冻结跑 B0。V2 在跑 B6 之前必须修。

## 审核者复现

- 干净 worktree 跑了 5 次：4 次 238 项、237 通过、0 失败、1 跳过；1 次出现 1 个失败，没有留下用例名，
  随后连续 3 次全过。最可能是已知的 spawn 型 broker 测试在并行负载下偶发超时，这里如实记录。
- dry run 37 项、0 失败、3 跳过；工作区干净。

## 接受的部分

- 判定只看我们自己的行为：`agent HID events`、`focus taken`、`cursor warped` 进入 B0–B4 的必需行；
  `real user input` 对后台步骤只记录；门禁只保留授权时间。
- `focus taken`：每个会改状态的调用（backend 的 `act`、剪贴板、`focusWindow`、`manageApps`、`manageWindow`，
  以及 helper 的同名命令）前后各读一次前台；变成本次运行启动的进程或 helper 判失败，变成别的 App 记为用户切换。
- `cursor warped`：源码测试要求 `bridge.swift` 里不出现 `CGWarpMouseCursorPosition` 等 API，`postEvent` 的 `l2`、`pid`
  两个分支都在全局投递之前返回，只有全局投递那一支计数。
- `agentHidEventCount` 在仅有的两处 `post(tap: .cghidEventTap)` 旁边计数；pid 和 L2 投递不计。
- B0 不再调用校准事件，避免在用户使用时投全局事件。
- `333589d`：异步启动的配置在回调或 60 秒后释放，`pending` 时不再丢失启动。接受。
- fixture 支持 `--show-without-activation`，`launchFixture` 以 `activates:false` 启动。

## V1（高，阻断冻结）：fixture 窗口不能盖在用户的窗口上面

`showWindowWithoutActivation` 用 `orderFrontRegardless()`，会把 fixture 窗口放到所有 App 的窗口之上。它不抢键盘焦点，但会：

- 挡住用户正在看的内容；
- 用户在被挡住的位置点一下，点击就落到 fixture 上并激活它；`focus taken` 看到前台变成本次运行启动的进程，会判失败，
  把用户的点击算成我们的错。

修法：窗口出现在用户窗口的**后面**（例如 `order(.below, relativeTo: 0)` 或 `orderBack`），不调用 activate。
辅助功能接口可以读写被遮挡的窗口，按窗口号截图也不受遮挡影响。验收：启动前后用户的前台不变，fixture 窗口在窗口列表里的
层级低于用户的前台窗口，AX 能读到控件。dry run 断言源码里不再出现 `orderFrontRegardless`。

## V2（高，B6 之前必须修）：全局键鼠动作之前要先确认用户没在用

门禁去掉了空闲条件，而 B6（`check-cu-v2-live.mjs --with-hid`）会做一次全局 HID 点击，移动用户的光标。
现在它在动作之前没有任何检查，真人输入只在事后记录。

修法：B6（以及以后的 B5）在每个全局键鼠动作之前，要求 helper 报告最近 30 秒没有未标记输入；不满足就不执行，记为跳过并停止。
动作之后照旧检查。补单元测试。B0–B4 不受影响。

## 低优先级

- `launchApp` 现在会把请求里的 `arguments` 原样传给被启动的 App。产品的 TS 类型没有暴露它，模型用不到；但 helper 接受任何本地客户端
  传入的参数。建议只放行 `--show-without-activation`，其余拒绝。
- `agent HID events` 依赖 helper 自己计数。建议同时要求 tap 观察到的带标记事件（`agentEventCount`）增量也为 0，作为独立的第二个信号。

## 给执行方的顺序

1. V1（阻断冻结）；V2；两项低优先级可以一起做。
2. 只做代码和测试，不跑真机。推送后报告 SHA，审过再冻结。

## 复核（2026-11-09，`a4420e9..b7295f6`）：接受，`b7295f6` 可作为 B0 的冻结提交

冻结提交：`b7295f6268cbf070bac86b6a50cdf9984fae55c2`。

- 审核者复现：干净 worktree 连跑 3 次，246 项，245 通过、0 失败、1 跳过；dry run 37 项、0 失败、3 跳过；工作区干净。
- V1：fixture 改用 `orderBack(nil)`，不再置顶，也不调用 activate；dry run 断言 fixture 源码里不出现 `orderFrontRegardless`、
  `NSApp.activate` 或 `activate(ignoringOtherApps:)`。仓库里剩下的两处 `orderFrontRegardless` 在 agent 光标覆盖层和接管边框里，
  它们按设计显示在最上层，并且点击穿透、不抢焦点。
- V2：`requireQuietGlobalInput` 要求 helper 已经连续监听满 30 秒，并且这 30 秒里没有未标记输入，否则全局点击不执行。
  B6 因此记为跳过并停止阶段。
- 低优先级两项都做了：`launchApp` 的 `arguments` 只接受 `--show-without-activation`；`agent HID events` 同时要求 helper
  自己的 HID 计数和 tap 观察到的带标记事件增量都为 0。

下一个窗口两次 B0，都只出报告，用户照常使用电脑：先 `--delivery-matrix`（fixture 窗口在用户窗口后面，这正是真实的后台场景），
再 `--launch-twice`。

## 2026-11-09 窗口：B0 在连接 helper 时中止

现象：`run | abort | fail | pi-computer-use helper app daemon is unavailable at ~/cu-v2-build/b7295f6-20261109-b0/pi-computer-use.app.`
执行方按规则停止，没有重试，没有运行 `--launch-twice`，没有遗留本次运行的进程。

审核者对代码的判断（还需要执行方确认当时的环境变量）：

- `--delivery-matrix` 要求 `PI_CU_L2_SOCKET`，B 阶段一直用 `PI_CU_SOCKET_PATH` 指向一个独立 socket，以免碰到用户日常用的 helper。
- `src/platform/macos/helper.ts` 的 `launchDaemon` 在使用外部 socket 时**按设计不启动 helper**，直接抛出
  “External helper socket is unavailable”。之前的窗口里，helper 都是执行方在窗口开始前手动起在这个 socket 上的。
  这次重建到了新路径，但没有启动。
- `ensureDaemon` 用 `.catch(() => undefined)` 吞掉了这个错误，最后只报“`<app 路径>` 上的 daemon 不可用”，掩盖了真正的原因。

处理：

1. **冻结提交 `b7295f6` 仍然有效**，不需要新提交就能重跑。窗口开始前的准备工作增加一步：把重建的 helper 起在 B 阶段的独立 socket 上，
   然后取一次 `diagnostics`，确认协议号正确、`accessibility=true`、`screenRecording=true`、`invariants` 含
   `background-delivery-no-cursor-warp`。任何一项不满足，就不开窗口，先报给用户。这一步只启动我们自己的 helper，不操作任何用户 App。
2. 低优先级（产品代码，下一轮再改）：`ensureDaemon` 保留 `launchDaemon` 的错误；使用外部 socket 时，报错写明
   “外部 socket 上没有 helper 在监听，请先用 `serve --socket <路径>` 启动”。

遗留进程：PID 5269（`~/cu-v2-test/Fixture.app`，原始 fixture）、61467 和 69339（11-08 的旧副本）都不是这次运行启动的，
按规则没有退出。由用户自己退出，或在授权里明确允许执行方核对 bundle id 后礼貌退出这三个 pid。

## 更正（2026-11-09）：中止的真正原因是端点安全，不是 helper 没启动

执行方补查到系统日志：

```
launchd ... com.example.cu-fixture.1794215717634 [20249] exited with exit reason
(namespace: 27 code: 0x1) - OS_REASON_ENDPOINTSECURITY | An Endpoint Security product
on the system denied the process from executing., ran for 11038ms
```

所以上一节"helper 没起在独立 socket 上"的判断不是根因。真正的原因是：这台公司管理的 Mac 上的端点安全产品
（本机装有 AliEntSafe）在进程启动约 11 秒后将其终止。这同时改写了更早几次"进程在、没有窗口"的偶发失败——
那些很可能也是端点安全终止了 fixture，而不是窗口轮询超时。

机制（已核对代码）：

- 脚本不接受 ad-hoc 签名的 fixture（`l2-env.mjs` `checkFixtureSignature`），所以这次 fixture 是用某张真实证书签了名、
  启动后才被杀的。
- 早期能跑通的窗口（第 7/9/10 次）用的是 Apple Development 证书（Apple 链、带团队 ID），端点安全放行。
- mac2 讨论引入的自签名证书 `rotom-cu-test` 不在 Apple 链上；它过得了脚本检查，但端点安全仍会终止它。

**待查**：本次运行 `PI_CU_FIXTURE_SIGN_IDENTITY` 与 helper 签名用的是哪张证书。若是自签名证书，换回早期放行过的
Apple Development 证书即可，这是合规签名，不是规避管控。

**结论与边界**：

1. 被终止的是测试用的一次性 fixture（每次新 bundle id、重新签名），不是产品路径；真实用户操作的是已安装、已受信的 App，
   不复现这个模式。因此本次终止不能推断产品的后台操作有问题。
2. 但这台公司机器的端点安全会主动终止非 Apple 链的自签名二进制，说明它不是干净的测试环境，这与此前追查的
   未标记事件来源一致。记为环境发现。
3. 不得以任何方式规避端点安全管控。合规路径只有两条：用端点安全已放行的 Apple Development 证书签名；
   或由安全/IT 管理员按日志（时间、PID、路径）加例外，或改在非受管机器/虚拟机上测（HANDOFF-3）。

## 再更正（2026-11-09）：Apple Development 签名并不能让它放行

执行方只读核对:被端点安全终止的 r2 运行,helper 与 fixture 的 `--sign-identity` / `PI_CU_FIXTURE_SIGN_IDENTITY`
**都是**本机那张 Apple Development 身份(与早期窗口同一张;身份串按 G7 脱敏,不写入文档),`codesign -dvv` 读回的证书链为
Apple WWDR → Apple Root CA。被杀的运行副本用的也是同一张证书。

所以上一节"疑似自签名、换回 Apple Development 即可"**被证伪**:端点安全在 Apple Development 签名(且链到 Apple)的情况下
仍然终止了进程。换签名不是解法——当时用的就是它。

修正后的判断:

- 这台公司机器的端点安全不是按"是否 Apple 链"放行,而是按别的策略(很可能是行为类:一个新构建、未经 notarize 的二进制
  申请辅助功能/屏幕录制并合成输入,正是 EDR 的典型触发点;也可能按路径或 reputation,或策略近期收紧)。具体规则只有
  安全/IT 能查。
- 早期窗口(第 7/9/10 次)同样是 Apple Development 签名却能跑,说明不是签名差异,而是策略随时间收紧或行为累积升级——
  早期那几次已经出现过疑似 EDR 反应的鼠标突发,只是没有直接终止。
- **不要再在签名上找解法,也不要用 notarize 等手段专门去躲 EDR**——那是在规避管控。合规路径只剩两条:
  由安全/IT 管理员按日志(时间、PID、路径)加例外;或改用非受管机器 / 虚拟机(HANDOFF-3)测试。
- 本机的 B0 到此为止,不在本机重试,直到上述其一落地。

## 日志核对（2026-11-09）：端点安全只拦到一次性 fixture，没拦到 helper

执行方只读查询 `log show --last 2d`(默认级别):

| 对象 | `OS_REASON_ENDPOINTSECURITY` 终止记录 |
| --- | --- |
| `com.injaneity.pi-computer-use`(helper,固定身份) | 0 条 |
| `com.example.cu-fixture…`(一次性测试 fixture,每次新 bundle id) | 1 条(09:15:28 UTC,PID 20249) |

含义(在本次查询到的日志范围内):

- 被端点安全终止的只有测试用的一次性 fixture。固定身份的 helper 没有被终止记录;第 7/9/10 次窗口里 helper
  也确实正常执行过 AX 操作。
- 边界:日志只保留两天,"未发现记录"不等于"历史上始终放行",也不能证明 EDR 只拦 fixture。结论限于查询到的范围。

对"不加白是否影响日常使用"的判断:

- 日常使用 Computer Use 是用固定身份的 helper 操作用户已装、已受信的 App,不复现 fixture"每次造新抛弃程序"的模式。
  现有证据下,helper 未被端点安全终止,因此**不加白大概率不影响日常后台操作**。
- 需要加白/IT 例外的,是在本机继续跑**这套测试**——因为测试不断造新 bundle id 的一次性 fixture,正好踩中 EDR。
- 第三条可选(测试侧):改用一个固定身份、安装一次的 fixture(像 helper 那样),让它积累 reputation,代价是要另解
  LaunchServices `-10825`(同 bundle id 多路径附着)问题。属于较大的测试改造,未决。

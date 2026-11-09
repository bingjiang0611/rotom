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

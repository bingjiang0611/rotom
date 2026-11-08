# Computer Use v2.1 第 12 轮审核：`26629d8` 上的两次 B0（2026-11-08 07:51–08:21）

## 结论

两次运行都在冻结提交上完成，门禁通过，没有真人输入，停止规则和退出保护都按规定生效。三项结果都是负向的，但每一项都有信息：

| 项 | 结果 | 含义 |
| --- | --- | --- |
| 启动两次 | 第一次启动 5007 ms 后返回、没有 pid，第二次被拒绝 | helper 启动等待上限和归属检查叠加出的缺陷（W1） |
| 校准事件 | `found=false`，`agentDelta=0` | 零位移的 `mouseMoved` 很可能被系统丢弃了（W2） |
| 定向 L2 | 计数 1→1，前台仍是 Scry | 补上窗口号之后仍然失败，L2 现在 0 成功、5 失败（W3） |
| 突发 | 两次都是 `0 → 0`，第二次 fixture 出现了窗口 | 之前 5/5 的突发这次没出现，原因未知（W4） |

## W1（高）：启动超过 5 秒时，副本无法证明归属，退出被跳过

`bridge.swift` 的 `launchApp` 最多等 5 秒；超时返回 `launched:false, pending:true`，不带 pid。fixture 副本的启动要 5–6 秒，
所以 `rememberRunLaunch` 拿不到 pid，归属检查拒绝退出它。结果是用户机器上留下两个 fixture 进程（61467、69339）。
退出保护在这里的行为是对的：证明不了归属就不碰。缺陷在于本来可以证明。

修法：

- fixture 副本每次都有新的 bundle id（`com.example.cu-fixture.<时间戳>`），这个 id 只可能由本次运行创建。
  对副本，归属可以这样证明：启动之后出现的进程，bundle id 等于本次副本的 id，并且它的 pid 不在运行前的进程列表里。
  把这条写进 `run-owned-apps.mjs`，**只适用于本次运行复制的副本**；TextEdit 这类用户也会用的 App 仍然只认带 pid 的新启动。
- `launchFixture` 遇到 `pending` 时，按上面的规则轮询拿到 pid，再登记归属。
- 补测试：`pending` 的副本启动能登记归属；同名 bundle id 但 pid 在运行前就存在的进程不能登记。

## W2（低）：校准事件没有被看到

`calibrateHidEventSource` 在当前光标位置投一个零位移的 `mouseMoved`。没有位移的移动很可能被系统合并或丢弃，所以 tap 没看到它。
突发这次没有出现（W4），校准的紧迫性下降了。先不要改成会真的移动光标的事件；如果要继续，改成不改变任何状态、也不会被合并的事件类型，
并在 dry run 里说明为什么选它。可以放到 W1、W3 之后。

## W3（中）：L2 下一步是一次投递对照，而不是继续猜

窗口号补上之后，定向点击仍然没有让计数变化，窗口也没被激活。下一次 B0 在同一个 fixture 上做一个小矩阵，一次运行就能缩小范围：

| | SwiftUI 按钮（现有） | AppKit 按钮，`acceptsFirstMouse` 为真（新增） |
| --- | --- | --- |
| `l2`（`SLEventPostToPid`） | 计数？ | 计数？ |
| `pid`（公开的 `CGEvent.postToPid`） | 计数？ | 计数？ |

判读：

- `pid` 能点中而 `l2` 不能 → 问题在私有接口的调用方式。
- 两者都只能点中 `acceptsFirstMouse` 的按钮 → 问题是“非活动窗口的第一次点击只用来激活窗口”，投递本身是通的。
- 四格都不行 → 事件根本没有进入目标 App，需要换方向。

fixture 新增一个 AppKit 按钮（独立计数，写进 `accessibilityValue`）；脚本新增一个只出报告的 `--delivery-matrix` 模式。
注意：`pid` 投递按产品规则只在后台策略下使用，这里是测试脚本直接请求，和 `--direct-l2` 一样带 `requireTransport`。

## W4：突发这次没有出现

之前五次 fixture 窗口出现时都有突发，这一次窗口出现了却是 `0 → 0`。启动依然要卡 5 秒左右，所以“启动阻塞”本身不是触发条件。
原因还不知道，可能是外部软件的状态变了。K2 规则保持不变：突发再出现，`run | real user input` 照样会判失败。

## 用户需要做的

两个遗留的 fixture 进程（61467、69339）是本次运行复制的“CU Fixture”副本。脚本按规则没有退出它们，请用户自己退出
（在程序坞或 ⌘Tab 里找到 CU Fixture，按 ⌘Q），或者在下一次授权里明确允许执行方核对 bundle id 后只退出这两个 pid。

## 给执行方的顺序

1. W1：副本按唯一 bundle id 证明归属，`pending` 时轮询拿 pid，补测试。
2. W3：fixture 加 AppKit 按钮，脚本加 `--delivery-matrix`，dry run 用假 backend 实际执行。
3. W2 暂缓。只做代码和测试，不跑真机。推送后报告 SHA，先审后冻结。

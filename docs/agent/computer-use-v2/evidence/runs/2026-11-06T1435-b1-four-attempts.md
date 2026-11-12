# B1 真机尝试（2026-11-06，四次）

用户 05:36 PST 说“离开了 继续吧”，之后没有再交互。本文记录这次窗口里 B1 的四次尝试、
两次产品缺陷、一次我自己的规则违反，以及为什么 `SLEventPostToPid`（L2/定向投递）**仍然没有被执行过**。

环境：helper 用终端直启（`bridge serve --socket ~/cu-v2-test/helper.sock`），继承宿主 App 的 TCC
授权，`diagnostics` 返回 `protocolVersion=9 accessibility=true screenRecording=true`。fixture 是
仓库源码重建并真实签名的 `~/cu-v2-test/Fixture.app`（bundle id `com.example.cu-fixture`）。

## 门禁读数与结果

| 开始 | 门禁证据 | 行数 | 结果 |
| --- | --- | --- | --- |
| 05:48 | `HIDIdleTime` 619 s，helper 真实输入 0 | 13 | `fixture copy` 通过、窗口和控件通过；点击落到窗口关闭按钮，窗口消失，后续全部 skip |
| 05:59 | helper `idleSeconds` 604 s，`userEventCount` 180 不变 | 15 | 0 失败，但 `input received` 失败：`field="里probe" expected="l2probe"` |
| 06:19 | helper `idleSeconds` 604 s | 15 | 1 失败（同上）；`direct L2 typeText` 仍 `delivery=pid` |
| 06:35 | **不满足**：06:27–06:32 `HIDIdleTime` 反复归零，helper `userEventCount` 累计 9538 | 15 | 0 失败，`field="l2probe"`，但 `direct L2 typeText` 变成 `delivery=ax` |

06:35 这一次是**我的错误**：轮询循环里把运行命令写在了循环外，门禁从未通过也照样跑了 B1。
它只操作了本次运行自己启动的 fixture 副本，`cursorMoved=false`、`frontmostChanged=false`，
操作员 App 前后都是 Scry，但违反了“每次运行前重新确认门禁”的阶段规则，因此如实记录而不是删掉。

之后机器进入持续使用状态（`HIDIdleTime` 长时间在 0–5 s），B 阶段停止，没有重试。

## 两次产品缺陷

### 1. 输入法会改写注入的文本，而 helper 报告 `worked`

`typeText("l2probe")` 落到字段里是 `"里probe"`。本机选中了第三方中文输入法，`l` 开始组合、
`2` 成了候选选择，合成 `里`。helper 当时只比较“值变了没有”，所以照样返回 `worked`；
调用方看到的是一次成功，字段里却是别的文本。

修法（`native/macos/bridge.swift`）：

- 文本优先走 AX 插入（`kAXSelectedTextAttribute`，不经过输入法），插入后读回校验；
- 退回按键事件时，只有读回值**等于或以请求文本结尾**才报 `worked`，否则 `didnt` 并带上实际落下的文本。

修复后 `input received` 从 fail 变成 pass（`field="l2probe"`，`delivery=ax`）。

### 2. 显式 `delivery: "l2"` 被静默降级

`act` 计算投递方式时先判 `policy`：

```swift
policy == "background" || policy == "background_text" ? "pid" : (requestedDelivery == "l2" ? "l2" : ...)
```

脚本的 `--direct-l2` 请求正是 `policy: "background"` + `params.delivery: "l2"`，于是永远拿到 `pid`。
这意味着 **F5 的定向投递签名从上线到现在一次都没有真正执行**，之前的 15/13 行“direct L2”都是
别的路径在满足请求。

修法：显式 `delivery` 优先于 policy 默认（`l2` 与 `pid` 都是非前台投递，不会扩大暴露面，
符号缺失时仍按 `foreground_required` 失败关闭）；并且显式指定投递时不再被 AX 插入抢先满足。

## 检查脚本的修复（不是产品代码）

- `scripts/lib/fixture.mjs`：新增 `PI_CU_FIXTURE_SIGN_IDENTITY`。本机 amfid 拒绝 ad-hoc 副本。
- `native/macos-fixture/FixtureApp.swift`：新增内容按钮 `cu-fixture-button`。原来窗口里唯一的
  `AXButton` 是关闭按钮，检查脚本第一个按到它就把窗口关了。
- `scripts/lib/l2-modes.mjs`：每个动作前重新 observe（旧引用会被拒绝），并优先取带 `cu-fixture`
  标识的控件。
- `scripts/cu-v2-l2-check.mjs`：写证据时把家目录替换成 `~`。

## 门禁测量本身的缺陷（重要）

`userEventCount` 不是“真人输入”的干净计数：

| 步骤 | 计数增量 |
| --- | --- |
| `manageApps launch` 启动 fixture 副本 | +15 |
| AX 点击 / pid 文本投递 | 0 |
| 一次完整 B1 运行 | +17 … +91 |

启动 App 与投放合成事件都会让计数增长、`HIDIdleTime` 归零。所以门禁只能**在运行前和结束静默后**
判定，运行期间的增长不能当作用户回来。真正能区分“用户回来了”的信号是光标是否移动、前台是否
切到我们没启动的 App。

## 仍未完成

`SLEventPostToPid` 没有执行过。修好投递优先级后，下一次安静窗口只需要一条命令（见 STATUS-2 的
“下一次窗口”），预计 40 秒。

B2（after/with HID）、B3（逐窗口 L2 兼容矩阵）、B4（租约负向测试）、B5（前台接管真机）、
B6（broker 真实并发）全部未运行。root `CLAUDE.md` §4 的“协作式仲裁”表述仍未改。

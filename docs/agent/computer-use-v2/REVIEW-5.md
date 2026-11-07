# Computer Use v2.1 第 5 轮审核（`cddf928..a884318`）

审核范围：Q5、B 阶段闸门脚本、两次 B 尝试和 B1 的四次真机运行，以及运行中改的产品代码
（`8db534e` 输入法与显式投递、`17b6b75` fixture 按钮、`7a24058` 签名身份、`9612ffc` 证据路径）。

结论：Q5 接受。06:35 违规运行如实记录，接受这种处理。**`8db534e` 有两处高风险问题，要在下一个
B 窗口之前修好**。修好之前，下一次窗口的那条命令跑出来的结果也说明不了产品行为（见 G1、G5）。

## 审核者复现

- 干净 worktree，不装 peer 依赖：连跑 2 次 `node --test --experimental-strip-types "test/*.test.ts"`，
  每次 120 项，119 通过、0 失败、1 跳过。
- `python3 scripts/audit-public.py --root .`：PASS（但它不识别 G7 里的邮箱）。
- Swift 自测、TS↔Swift 互通和真机运行需要 macOS，审核者在 Linux 上无法复现，以执行方记录为准。

## Q5：接受

- `focusWindow`（`desktop-pid:<pid>`，算不出 pid 失败关闭）和 `clipboardRestore`（`clipboard:system`）
  进了 `writeCommands`，Swift 自测和互通各补了无 token 被拒、带 token 放行的用例。
- 恢复调度走 `scheduler.write`。剪贴板没有 app 身份，`PolicyGate` 不会在 30 秒后弹同意卡；
  被其他 agent 持有时 broker 返回 `resource_busy`，恢复记 `restore_skipped:lease_unavailable`，
  不会无租约写入。`test/clipboard-restore-lease.test.ts` 覆盖了这条路径。
- 用户活动单位那两行的更正也已落实。

## 需要修的问题

### G1（高）：输入法修复在产品路径上不生效

`helperActRequest`（`src/bridge.ts:1423`）给每个 `typeText` 都带 `params.delivery`，因为
`nativeInputDelivery` 总会返回 `hid`、`pid` 或 `l2` 之一。Swift 的 `pinnedDelivery = params["delivery"] is String`
在产品请求里因此永远为真，AX 插入分支只有检查脚本能走到（`probe` 发的 `params` 只有 `text`）。

后果：

- run 记录里“修复后 `input received` 从 fail 变 pass（`delivery=ax`）”证明的是脚本路径，不是产品路径。
  产品在中文输入法下 `typeText` 仍会被改写，只是现在报 `didnt`（或按 G3 应报 `unknown`）。
- 最终提交（“显式投递不被 AX 插入抢先”）之后没有再真机跑过；06:35 那次是中间版本。

修法：把“调用方钉死了传输方式”做成一个只有直连 L2 检查才会设置的独立字段（例如
`params.requireTransport: true`），不要用“`delivery` 是否存在”来推断；产品由策略算出的
`delivery` 允许先走 AX 插入。补一条 TS 测试，断言产品 `typeText` 请求不带这个字段，
直连 L2 请求（`scripts/lib/l2-direct.mjs`）带。

### G2（高）：AX 插入成功但读回不符时会再发一次按键，文本可能写两遍

```swift
if !pinnedDelivery, let element, !text.isEmpty, insertTextAtCaret(element, text: text) {
    usleep(30_000)
    ... if inserted == text || inserted.hasSuffix(text) { return worked }
}
try postUnicodeText(text, pid: pid, delivery: delivery)   // 读回不符时落到这里
```

`AXUIElementSetAttributeValue` 返回 `.success`，说明写入已经被接受。如果 App 异步更新值，
30 ms 后读回还没变，代码就会再用按键事件把同一段文本打一遍。同一文件第 2291 行已有的原则
正好是“An accepted AX write with missing readback is not proof of non-execution and must not fall back”，
`CLAUDE.md` §4 也要求外部写只执行一次，无法证明时返回 `unknown`。

G1 修好后这条路径就会进入产品，所以 G2 必须和 G1 一起修。修法：AX 插入返回成功后不再回退；
读回不符时返回 `unknown`，带实际值和 `background_input_unknown`（或新的错误码）。

### G3（中）：按键路径“值变了但不以请求文本结尾”应报 `unknown`，不是 `didnt`

字段被改了，但不是请求的文本（输入法改写、光标不在末尾、自动更正、格式掩码），这时报
`didnt` 等于告诉调用方“什么都没发生”。打开 `ROTOM_CU_SPECULATIVE_FOREGROUND_RETRY` 时，
`didnt` 的 `typeText` 会触发前台重打（`src/actions.ts:171`），模型也可能自己重试，结果就是重复输入。

改成三种结果：值等于请求文本或以它结尾 → `worked`；值没变 → `didnt`；值变了但不匹配 →
`unknown`，带实际值。

### G4（中）：显式 `l2` 优先改变了产品行为，“不会扩大暴露面”不成立

- 对 IntelliJ，产品 TS 在 `background` 策略下本来就发 `delivery: "l2"`（`nativeInputDelivery` →
  `backgroundDelivery`），以前被 Swift 静默改成 `pid`。这个提交之后，IntelliJ 的后台动作第一次
  真正走 `SLEventPostToPid`：一条从未在真机执行过的路径成了产品默认。
- 符号解析不到时 Swift 抛 `foreground_required`，而 TS（`src/bridge.ts:1397-1400`）在非 headless
  模式下会自动用前台 HID 重试，会移动用户光标、切换前台。同样的机器上，这个提交之前走的是
  `pid` 后台投递。

修法：

1. L2 不可用时返回独立错误码（例如 `l2_unavailable`）。`postTargetedEvent` 的符号是静态解析的，
   失败一定发生在第一个事件之前，所以 TS 收到这个码后退回 `pid` 后台投递是安全的，**不要升级前台**。
   补 TS 单测：假 backend 第一次抛 `l2_unavailable`，第二次请求必须是 `background` + `pid`。
2. `behaviour-changes.md` 记一条：“IntelliJ 后台投递从实际 `pid` 变为 `l2`，真机未验证”。
   根 `CLAUDE.md` §4 等 B1 有正例后再改。

### G5（中，阻断下一次 B 窗口）：那条命令在中文输入法下仍会失败

直连 L2 的 `typeText` 是显式投递，按设计不走 AX 插入。按键事件仍经过输入法，`"l2probe"`
会再次变成 `"里probe"`，按新判定报 `didnt`。STATUS-2 写的判定条件“`delivery=l2` 且
`outcome=worked`”就不成立，这次又白跑。

修法：检查脚本开始前记录当前输入源（`defaults read com.apple.HIToolbox AppleSelectedInputSources`
或让 helper 的 `diagnostics` 报告）。不是纯 ASCII 布局时，直连 L2 的 `typeText` 记为 `skipped: input method`，
由 `click` 一行证明 `SLEventPostToPid` 确实执行过。STATUS-2 的“下一次窗口”一节写明：
**用户离开前把输入法切到 ABC**，这样文本那一行才有意义。

### G6（中，流程）：闸门要内置在运行脚本里

06:35 的违规，起因是闸门靠操作者在外层循环里调用。改成 `cu-v2-l2-check.mjs` 和之后的 B 脚本
在真机模式下自己先跑 `cu-v2-gate.mjs` 的逻辑：没有 `--window-start/--window-minutes` 就拒绝运行，
不是 `pass` 就退出 1，并把闸门读数写进 `runs/`。dry run 不受影响。

### G7（低，隐私）：签名身份里有个人邮箱和 Team ID

`Apple Development: <邮箱> (<Team ID>)` 出现在 `STATUS-2.md:90`、
`evidence/runs/2026-11-05T0333-b-phase-blocked.md:64`、`STATUS.md:21` 和 `STATUS.md:50`。
`STATUS.md` 自 `4b209f2` 起已经在公开 `main` 上。公开审计不识别这种格式。

修法：文档里统一写成 `"$PI_CU_FIXTURE_SIGN_IDENTITY"` 或“本机 Apple Development 身份”。
已公开的历史要不要改写由用户决定（要按 `privacy-release.md` 另建无历史副本），执行方不要自行改写历史。

## 待决问题的回答

- **Q1**：仍需用户在授权 B 阶段时给出确切时长；G6 落实后，时长是脚本的必填参数。
- **Q2**：`transfer` 不需要确认卡，它只能转给自己的后代，没有扩大父 agent 已获的授权。
  但 `cu_session transfer` 现在不写 trace（`src/tools/session-admin.ts:71-104`）。补一条
  `{tool:"cu_session", action:"transfer", toAgentId, resourceKey, oldLeaseId, newLeaseId}`，
  这样用户才能回答“是谁动了我的 App”。不阻断 B 阶段。
- **Q4**：维持上一轮的回答。

## 给执行方的顺序

1. G1 + G2 一起修（同一段 Swift），再修 G3、G4，各自补测试；Swift 自测在本机跑。
2. G5、G6 改脚本和 STATUS-2，G7 改文档，Q2 补 trace。
3. 只做代码和测试，不跑真机。全部推送后更新 STATUS-2，再等用户给出新的 B 窗口和时长。

## 复核（2026-11-07，`b07f152..d1b17d9`）

结论：G1–G4、G6、G7、Q2 接受。**G5 的输入源判断有解析缺陷，修好之后才能开 B 阶段**（H1）。
另有一项合入 `main` 前要决定的事（H2），它不阻断 B 阶段。

### 审核者复现

- 干净 worktree，不装 peer 依赖：连跑 2 次，每次 139 项，138 通过、0 失败、1 跳过。
- Swift 侧（`TextWriteOutcome` 自测、`l2_unavailable`、`requireTransport`）需要 macOS，以执行方记录为准。
- `git grep` 签名身份：只剩 `REVIEW-5.md` 里的脱敏示例。

### 接受的部分

- G1：`requireTransport` 成为独立字段，只有 `scripts/lib/l2-direct.mjs` 设置；`test/act-request.test.ts`
  断言产品请求不带它。`click` 在钉死传输时也不走 `AXPress`，直连 L2 的点击行因此真正测的是 L2。
- G2：AX 插入被接受后不再回退按键，读回不符返回 `unknown`。
- G3：`TextWriteOutcome.classify` 三分：匹配 → `worked`，没变 → `didnt`，变了但不匹配 → `unknown`。
- G4：`l2_unavailable` 只在单动作、非 headless 路径上用同一个后台策略改走 `pid` 重试一次，
  trace 带 `delivery_fallback:l2_unavailable`；`foreground_required` 的处理不变。headless 的批量
  路径收到 `l2_unavailable` 直接报错，不升级前台，可以接受。
- G6：五个真机脚本都先过 `requireGate`，缺窗口参数退出 2，hold 退出 1 并写 `gate-*.json`。
- G7：文档已脱敏，历史未改写，符合要求。
- Q2：转交成功和失败都写 trace，只记 id 和资源键。

### H1（中，阻断 B 阶段）：输入源解析永远判成“非 ASCII”

`scripts/lib/live-helpers.mjs` 的 `inputSourceInfo` 用 `/KeyboardLayout Name = "?([^";]+)"?;/` 匹配布局名，
但 `defaults read com.apple.HIToolbox AppleSelectedInputSources` 输出的是旧式 plist，带空格的键会加引号：

```
"KeyboardLayout Name" = ABC;
```

`Name"` 和 ` =` 之间多一个引号，所以布局名永远匹配不到，`layouts` 为空，`ascii` 恒为 false。
审核者用这两种输出喂给函数：只选 ABC → `{"ascii":false,"description":"input method unknown"}`；
ABC 加搜狗 → `ascii:false`（这次是对的）。后果是：即使用户离开前切到了 ABC，直连 L2 的
`typeText` 也永远记为跳过，G5 等于没修。方向是失败安全的，但这个函数没有任何测试。

修法：正则改成允许键带引号，例如 `/"?KeyboardLayout Name"?\s*=\s*"?([^";]+)"?;/`；`Input Mode` 同样处理。
补测试：用真实格式的三种输出（只有 ABC、ABC 加输入法模式、命令失败），断言 `true / false / false`。

### H2（中，合入 `main` 前决定，不阻断 B）：AX 插入成了所有 App 的默认文本路径

这是审核者在 G1 里要求的方向，`behaviour-changes.md` 第 10 条也如实记录了。但影响面需要明确：

- 现在只要元素声明 `AXSelectedText` 可写，`typeText` 就先 AX 插入，`foreground` 策略也一样。
- 有些 App 对这个 setter 返回成功，却不更新值，或者更新了值但不触发页面的输入事件
  （浏览器里的网页、Electron、自绘编辑器都可能这样）。读回不符时，按 G2 返回 `unknown` 且不回退按键。
  这本身是对的，但在这些 App 里，产品的 `typeText` 会从“能打字”变成“永远 unknown”。

建议二选一，在合入 `main` 之前定：

1. **收窄**（审核者倾向）：helper 用 `TISCopyCurrentKeyboardInputSource` 读当前输入源，只有当前是
   输入法时才走 AX 插入；纯键盘布局下保持原来的按键路径。这样多数用户行为不变，中文输入法用户得到修复。
2. **保持现状**：B3 兼容矩阵必须包含一个网页文本框和一个 Electron App，确认 AX 插入在这些地方能落值，
   并且能触发输入事件。

### 观察（由用户决定，不要求执行方处理）

`docs/agent/computer-use-background-text.md:36` 和 `STATUS.md:24` 写了本机安全软件的厂商与组件名，
可以看出维护者单位用的安全软件。这两处已经在公开的 `main` 上。是否改写或删除，由用户决定。

### 下一步

执行方修 H1（脚本和测试），推送并更新 STATUS-2。H2 记入 STATUS-2 的待决问题，等用户选择。
H1 修好后，用户就可以按原来的 B 阶段提示词授权窗口（填上时长，离开前切到 ABC）。

### H1 复核（2026-11-07，`3aa2893`）：接受

- 两个键都允许带引号。审核者用上一轮的两段样例重跑：只选 ABC → `ascii:true`，ABC 加搜狗 → `ascii:false`。
  `InputSourceKind = "Input Mode";` 不会被误当成输入法模式。
- 新增 `test/input-source.test.ts` 三条（ABC、ABC 加输入法、命令失败）。干净 worktree 连跑 2 次：
  142 项，141 通过、0 失败、1 跳过；`cu-v2-script-dry-run.mjs` 7 项、0 失败、3 显式跳过。
- H2 已写进 STATUS-2 的待决问题，没有改代码，符合要求。

A 阶段与第 5 轮审核到此结束。B 阶段的开始条件：用户给出明确时长，离开前把输入法切到 ABC。
H2 不阻断 B 阶段，但要在合入 `main` 之前决定。

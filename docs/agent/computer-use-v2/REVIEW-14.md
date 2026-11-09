# Computer Use v2.1 第 14 轮审核：HANDOFF-5、H2 与小项（`b7295f6..76e0c8c`）

## 结论

整体接受，实现质量高。**装测试版之前要先修 K1**（输入法接口在后台线程调用，可能让 helper 崩溃）。修完、审过，
就可以准备本地并排安装。

## 审核者复现

- 干净 worktree 跑了 3 次：两次 268 项、267 通过、0 失败、1 跳过；一次出现 1 个失败
  （`two clients spawning at once converge on one broker and share arbitration`），是已知的 spawn 型 broker 测试在并行负载下的偶发超时。
- dry run 38 项、0 失败、3 跳过；工作区干净。
- Swift 侧（`takeover_state_test.swift`、`--input-source-self-test`）需要 macOS，审核者无法复现，由执行方在 Mac 上跑并贴出结果。

## 接受的部分

### HANDOFF-5：暂停 + 自动恢复

- broker（`takeover-lifecycle.ts`）：暂停保留租约但不放行派发；恢复分三步（`prepare_resume` → `commit_resume` → `resumed`），
  每一步都要求 helper 2 秒内新报的活动读数通过 30 秒安静判定；暂停超过 120 秒、恢复超过 3 次、接管超过 10 分钟、授权或租约失效、
  目标窗口消失，都会硬结束。
- 只有 `role=helper` 能提交接管状态（`core.ts` 的 `takeover_state` 入口），agent 不能自己恢复。旧的 `reportPreempted` 已删除。
- helper（`takeover_state.swift`）：锁按**单个事件**持有，用户输入可以在两个事件之间拿到锁，所以让出是即时的；长文本中途被打断时，
  剩余字符以 `user_input_pause` 中止，不重放。
- 补发松开：逐个跟踪 agent 自己的按下；让出时先松普通键和按钮，再松修饰键；松开事件是新建的，鼠标用当前光标位置、修饰键用当前
  的系统标志去掉自己的那一位；带 agent 标记并计数。补发失败则封锁之后的一切输入，必须重启 helper 才能再接管。
- 结束原因有明确的枚举（`released_by_user`、`resume_timeout`、`resume_limit`、`takeover_duration_limit`、`authorization_lost`、
  `target_lost`、`release_failed`）。

### H2：方案一

`InputSourcePolicy`：只有当前输入源是输入法（`KeyboardInputMode`、`KeyboardInputMethodWithoutModes`、`KeyboardInputMethodModeEnabled`）
才先走 AX 插入；纯键盘布局和来源不明都保持按键；`requireTransport` 永远不改写。

### 小项

- `ensureDaemon` 不再吞掉 `launchDaemon` 的错误；外部 socket 无 helper 时报明确原因。
- `launchFixture` 用 `isFixtureBundleId` 判断副本。
- 根 `CLAUDE.md` §4 只把“协议已升到 8”改成 9，“协作式仲裁”未动。

## K1（高，装测试版之前必须修）：输入法接口在后台线程调用

helper 为每个客户端连接开一个独立线程（`Thread.detachNewThread` → `processClient` → `handleLine`），`act` 的 `typeText` 在这个线程里调用
`InputSourcePolicy.currentPrefersAX`，也就是在后台线程调用 `TISCopyCurrentKeyboardInputSource` 和 `TISGetInputSourceProperty`。
在较新的 macOS 上，这组文本输入服务接口要求在主线程调用，在其他线程调用可能触发主队列断言，导致 helper 崩溃。
`--input-source-self-test` 在主线程运行，抓不到这个问题。

修法：在主线程取值，例如非主线程时用 `DispatchQueue.main.sync` 取一次输入源类型，再回到当前线程。确认主线程不会同时等待这个请求线程，
避免死锁。补一个从后台线程调用的自测用例。

## 低优先级

- `ensureDaemon` 的新报错是中文（“外部 socket 上没有 helper 在监听……”），产品里其他错误信息都是英文，改成英文。这句中文是审核者在上一轮
  提示词里给的，是审核者的疏忽。
- L2 投递的按下没有调用 `trackHeldInput`，但补发松开的闭包里有 L2 分支。接管走 HID，实际影响很小；要么给 L2 也登记，要么删掉这个分支，
  保持一致。

## 给执行方的顺序

1. K1，补测试；两项低优先级一起改。
2. 在 Mac 上跑 `scripts/check-macos-native-self-tests.mjs`（含 takeover 状态机和输入源自测），贴出结果。
3. 只做代码和测试，不跑真机测试，不碰现有安装和正在运行的 helper。推送后报告 SHA。
4. 审核通过后，写一份并排安装测试版的步骤（独立 checkout、按 `docs/agent/architecture.md` 的源码流程构建、独立 helper 路径和 socket、
   需要用户手动授权的项目、在业务项目里启动测试版的一条命令），先只写给用户看，不执行。

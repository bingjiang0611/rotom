# Computer Use v2 第二期交接（给执行 agent）

第一期已于 2026-11-04 合入 `main`（合并提交 `7bc1e4c`）。第二期把第一期审核里约定“合入之后再做”的项做完。

- 工作分支：`claude/computer-use-v2.1`，从 `main` 的 `7bc1e4c` 拉出。只推这个分支。
- 状态文件：新建 `docs/agent/computer-use-v2/STATUS-2.md`。第一期的 `STATUS.md` 不再改，只在第二期合入时由审核者更新。
- 工作方式同第一期：按顺序一路做下去，每项做完就提交、推送、更新 STATUS-2，然后继续下一项，不要停下来等审核。

## 0. 开工前必读

1. 根 `CLAUDE.md`。它优先于本文件；两者冲突时以它为准，并在 STATUS-2 里记录。
2. [PLAN.md](PLAN.md)，重点读第 5 到 7 节。
3. 三轮审核意见：[REVIEW.md](REVIEW.md)（F1 到 F5、I2、I3 的原始描述）、[REVIEW-2.md](REVIEW-2.md)、[REVIEW-3.md](REVIEW-3.md)（“合入之后再做”一节）。
4. [STATUS.md](STATUS.md) 的“真机运行规则”和“决定记录”。
5. `evidence/real-machine-session.md`：第一期真机会话的经过，以及越界是怎么发生的。

## 1. 硬性规则（沿用第一期，有补充）

- 只推 `claude/computer-use-v2.1`。不推 `main`，不 force push，不改写已推送的历史。
- 不执行 `npm publish`，不替换用户已安装的 helper，不重启别的会话的 daemon。真机只用 `~/cu-v2-test/` 下的独立 helper 和独立 socket（`PI_CU_SOCKET_PATH`、`ROTOM_CU_BROKER_SOCKET`）。
- 不调用付费模型。
- 不删测试、不放宽测试来让新代码通过。已有失败单独记录。
- 只跑了单测，证据就写 L1；在 macOS 真机跑通了，才能写 L2。
- 证据只提交文本。不提交截图，也不提交真实 App 的界面正文。
- 提交钩子：只有 `bridge.ts`、`bridge.swift`、`CLAUDE.md` 三个文件可以超过 20 KB（已经写在 `scripts/check-staged-file-size.mjs` 里），其他文件都要过钩子，不用 `--no-verify`。
- commit message 格式：`cu-v2.1(<项目编号>): <中文摘要>`。推送前运行 `git diff --check` 和 `python3 scripts/audit-public.py --root .`。
- **真机规则（最重要）**：A 阶段完全不运行任何会在用户 Mac 上移动光标、输入文字、切换前台或启动 App 的脚本。编译 Swift 和跑不碰 UI 的确定性测试可以做。B 阶段只在用户明确说过“现在不在电脑前”之后才开始，并且必须遵守 STATUS.md 的四条真机运行规则。

遇到需要决定的问题，处理方式同第一期：
- 可以撤销的，自己选，记到“决定记录”，然后继续。
- 不可逆的，或者会改变 PLAN 已定决策的，写进“需要审核者回答的问题”，然后跳到下一项继续做。

## 2. A 阶段：不需要真机（按顺序做）

每项都要先写一个用旧行为会失败的测试，再写实现。

### A1 把四个执行器从 bridge.ts 移出去

把 `performClipboard`、`performManageApp`、`performManageWindow`、`performCuSession` 以及它们专用的辅助函数（剪贴板恢复、trace 接线等）移到 `src/tools/` 下，每个文件 20 KB 以内。`bridge.ts` 只保留分发和接线。

- 这一项是纯搬迁，不改行为。验收：搬迁前后全量测试结果一致，`bridge.ts` 体积下降。在 STATUS-2 里写明前后的字节数。
- `cu-v2-tools.test.ts` 里“意图必须集中构造”这条不变量，要跟着新的文件位置更新，不能删掉。

### A2 I3：测试不依赖 peer 包

现在 `cu-v2-tools.test.ts` 需要 `@earendil-works/pi-coding-agent` 和 `typebox`，干净 checkout 跑不起来。审核者用的是手写的桩。

要求：在干净 checkout 里，`node --test --experimental-strip-types "test/*.test.ts"` 不装任何东西也能全部通过。推荐做法是让测试只 import 不依赖 peer 包的模块，把需要 schema 的部分拆开。如果某个测试确实绕不开 peer 包，就让它在缺包时明确 skip，并打印原因；同时在 package README 里写明怎么准备依赖。STATUS-2 里写清楚测试数字是在什么条件下得到的。

### A3 F3：干扰用户时暂停该 agent

现在 `interferedWithUser` 只是打一个标记。PLAN 第 6 节要求：动作后前台变了、并且用户 2 秒内有过输入，就暂停这个 agent。

- Broker 增加 agent 级的暂停状态。被暂停的 agent，后续写请求一律返回 `paused_interfered`，读请求不受影响。暂停原因和时间写进 trace。
- 恢复只能由用户操作（helper 菜单栏，或者授权卡片上的“继续”），模型不能自己恢复。这和 B3 的 stop 规则一致：只接受 `role=helper` 发起。
- 测试：用真实 Broker 加假 backend，覆盖三点：干扰之后写被拒、读仍然可以；非 helper 连接发起恢复被拒；helper 恢复之后可以写。

### A4 F2：父 agent 把 App 交给 subagent

Broker 已经有 `transfer`，但没有接到 subagent 的启动流程上。

- subagent 启动时，子进程的 agentId 和父 agentId 要能在 Broker 里关联起来（复用 `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID` 这条已有约定，不新增环境变量；确实需要新增时写进决定记录）。
- 父 agent 可以显式把自己持有的租约转给子 agent。子 agent 退出时，租约自动还给父 agent，不留悬空。
- 审批路由继续走“最近的有 UI 的祖先”。转交本身不弹卡，因为父 agent 已经被授权过。
- 测试：转交成功之后父 agent 写被拒、子 agent 可写；子进程断开后租约回到父 agent；把租约转给一个不是自己后代的 agent 被拒。

### A5 I2：helper 侧强制租约，截图排除宿主

这一项是把仲裁从“协作式”变成“helper 强制”。需要在 macOS 上编译通过，并跑通确定性测试。

- **密钥怎么传**：Broker 启动时生成随机密钥，只在内存里保存。helper 通过已有的 `BrokerLink`（`role=helper`）连上 Broker 时拿到这个密钥。密钥不落盘，不经过客户端。
- **租约 token**：Broker 发放租约时生成 `HMAC(密钥, agentId | 资源 key | pid | leaseId | 过期时间)`。客户端在每个写命令里带上 token。helper 校验 token 的签名、过期时间，以及目标 pid 是否和 token 一致，不通过就返回 `lease_invalid`。读命令不校验。
- **撤销**：Broker 撤销租约（stop、过期、transfer）时，通过 BrokerLink 把撤销的 leaseId 推给 helper。helper 拒绝已撤销的 token。
- **没有 Broker 时**：helper 没连上 Broker（比如 `ROTOM_CU_BROKER=0`），就不做校验，保持旧行为。这一点必须在 `behaviour-changes.md` 和 CLAUDE.md 第 4 节如实写明。
- **协议**：协议升到 9。旧客户端和新 helper、新客户端和旧 helper 之间的不匹配，按现有规则报错，不自动重启 daemon。
- **截图排除**：截图时用 ScreenCaptureKit 的 `SCContentFilter`，把宿主终端、rotom 自身、helper、cursor 覆盖层排除在外。`find_roots` 结果里也不再返回它们。原生侧给 secure text field 打标记，替换掉第一期 TS 侧按 role 判断的近似做法。
- **CLAUDE.md**：只有在 A5 完成、并且 B5 的真机反例跑通之后，才能把第 4 节的“协作式仲裁”改掉。在那之前只更新 STATUS-2。
- **测试**：TS 侧用假 helper 测 token 的生成、过期和撤销推送。Swift 侧写确定性测试（不碰 UI）：签名错误、过期、pid 不匹配、已撤销，这四种都被拒绝，合法 token 能通过。

### A6 F1：前台接管（L4）和 `preempted_by_user`

按 PLAN 第 7 节实现。必须同时满足三个条件才发放接管租约：用户授权过这个 App 的前台模式；用户空闲超过 10 秒，或者用户主动点了“让它接管”；没有别的 agent 正持有接管租约。

- 接管期间显示全屏边框，吞掉 `Esc`。
- 检测到任何不带 agent 标记的真实输入，立刻收回接管，结果标为 `preempted_by_user`，已经执行的步骤如实报告。
- 后台策略（launcher 默认的 headless）下永远不进入 L4。
- 测试：用假 backend 加可控的用户活动时间，覆盖以下情况：空闲不足被拒；没有授权被拒；两个 agent 抢接管，第二个得到 `resource_busy`；真实输入触发 `preempted_by_user`；headless 下不进入 L4。

### A7 F4：多个 agent 各自的光标

cursor 覆盖层支持多实例，每个 agent 一种颜色，颜色由 agentId 稳定决定。覆盖层本身不能接收鼠标事件，并且要被 A5 的截图排除覆盖到。确定性部分（比如颜色分配）写单测，显示效果留到 B 阶段看。

### A8 真机脚本的准备（只写代码，不运行）

- **LaunchServices `-10825`**：每次运行都把 fixture 复制到新路径，并给它新的 bundle id（比如 `com.example.cu-fixture.<时间戳>`），重新签名后再启动，收尾时退出进程并删除副本。脚本按 bundle id 前缀识别 fixture。
- **L2 直连模式**：`cu-v2-l2-check.mjs` 增加 `--direct-l2` 模式，绕过 TS 白名单，直接对**脚本自己启动的 fixture** 请求 `delivery=l2`，分别做定向点击和定向输入。这是 F5 要求的“第一次真机运行先单独验证 `SLEventPostToPid` 签名”。这个模式只存在于脚本里，产品代码不增加任何扩大白名单的开关。
- **崩溃隔离**：`--direct-l2` 模式必须用一个单独的 helper 进程（单独的 socket），这样就算签名错导致 helper 崩溃，也只记录为一个结果，不影响后续步骤。
- **`--with-hid`**：保持与后台不变量检查分开运行，脚本最后要恢复前台 App。
- 所有脚本都要先在 Linux 上用假 backend 跑通逻辑，在 STATUS-2 里记录。

## 3. B 阶段：真机（等用户明确说不在电脑前再开始）

开始前，在 STATUS-2 里写下用户给的时间窗口和开始时间。每一步都留 `evidence/runs/<时间戳>-<脚本名>.md`。**任何异常（越界、App 没有按预期出现、崩溃之外的意外行为）都立刻停止整个 B 阶段，不重试**，把情况记下来等下一次授权。

按这个顺序跑，每一步只操作脚本自己启动的进程：

1. **B1 L2 签名验证（F5）**：`cu-v2-l2-check.mjs --direct-l2`，对象是新复制的 fixture。记录：helper 是否存活、事件是否被接收（读回确认）、光标是否移动、前台是否变化。崩溃也是一种结果，如实记录，然后继续 B2。
2. **B2 兼容矩阵**：`cu-v2-compat-matrix.mjs`，对象是 fixture，跑满 10 个单元格。
3. **B3 后台不变量和 §10 验收复跑**：在 A1 到 A7 的改动之上，各跑一次 live check 和 acceptance，证明没有回归。
4. **B4 helper 强制的反例（I2）**：不带 token、带伪造 token、带过期 token、带已撤销 token，对 fixture 各发一次写命令，都应该被 helper 拒绝，并且 fixture 上没有产生任何变化。再带合法 token 发一次，应该成功。另外核对截图过滤器里确实排除了宿主终端和 helper 的窗口（只记录窗口列表和 pid，不保存截图）。
5. **B5 前台接管（F1）**：对 fixture 请求接管。用户模拟器保持空闲 10 秒以上，确认接管发生、边框出现；然后让模拟器发一次真实输入，确认结果是 `preempted_by_user`，并且前台恢复。
6. **B6 `--with-hid`**：放在最后单独跑，跑完确认前台恢复成运行前的 App。

**不在本期范围内**：白名单 App（IntelliJ）上的 L2 正例。IntelliJ 是用户自己正在用的 App，要等用户单独同意、并且由用户自己准备一个干净的实例之后再做。如果 B1 和 B2 在 fixture 上全部通过，可以在 STATUS-2 里提议把哪些 App 加进 `l2-compat.ts` 白名单，但不要自己去改白名单。

## 4. 完成时

- A 阶段全部做完以后，在 STATUS-2 顶部写总结：完成了什么、每项验证到哪一层、什么没做以及原因、需要审核者回答的问题。然后推送，等审核。
- B 阶段单独写一段总结，附上每次运行的存档路径。
- 最后一次推送后不要再改分支，审核意见会以 `REVIEW-4.md` 的形式出现在同一分支上。

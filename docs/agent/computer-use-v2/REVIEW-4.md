# Computer Use v2 审核意见（第 4 轮，第二期 A 阶段）

审核对象：`claude/computer-use-v2.1` 上 `fe580d4..f0d6292` 的 10 个提交。审核日期 2026-11-05。

结论：A1–A4、A6–A8 接受。B 阶段按规则没有开始，这个判断正确。A5（helper 侧强制）的结构是对的，但有三个会在真机上直接出错的缺陷，其中两个用真实 `BrokerCore` 就能复现。**先修完 E1–E3，再进入 B 阶段**，否则 B4 的反例测试会因为 E1 而给出错误的“通过”。

## 审核者本地复现

- 干净 worktree，不放任何 peer 依赖桩，Linux，Node 22：`node --test --experimental-strip-types "test/*.test.ts"` 连跑 3 次，结果都是 108 个用例、107 通过、0 失败、1 跳过。A2 的目标达成。
- 用真实 `BrokerCore` 写了一段脚本：一个父 agent、一个子 agent、一个 helper；父 agent 先 acquire `desktop-pid:812`，再把租约 transfer 给子 agent。结果如下：
  - token 里的 `expiresAt = 1793851123311`，单位是毫秒；而 Swift 侧拿它和 `Date().timeIntervalSince1970`（秒）比较。
  - transfer 前后 leaseId 都是 `lease-1`，同时 Broker 把 `lease-1` 作为 revoked 推给了 helper。
  - 第二个自称 `role: "helper"` 的连接同样拿到了 `leaseKey`。

## 必须修（进入 B 阶段之前）

### E1 helper 侧的过期检查永远不会触发

Broker 用 `Date.now()`（毫秒）签发 `expiresAt`，`LeaseGuard.check` 却把它和秒比较，所以真实 Broker 签出的 token 在 helper 侧永远不会过期。现有测试没有发现，是因为 Swift 自测和 `check-lease-guard.mjs` 都是自己用“秒”构造 token，而不是用 Broker 签出来的 token。

要求：
1. 统一单位。推荐 token 内保持毫秒，Swift 比较时换算；在 `LeaseClaims` 和 Swift `Claims` 上用注释写明单位。
2. 互通测试改成：由真实 `BrokerCore` 签发 token（可以注入假时钟），再交给 Swift `LeaseGuard` 校验。至少覆盖“合法”和“已过期”两种情况。以后不允许测试自己手搓 token 格式。

### E2 按 leaseId 撤销，会误杀转交后的租约和 Broker 重启后的新租约

`LeaseGuard` 只按 leaseId 记撤销，而且这个集合永不清空。由此有三个后果：
- `transfer` 和 `transferAll` 保留原 leaseId，同时把这个 id 当作 revoked 推给 helper。所以子 agent 拿到的 token 一用就被拒（`lease_invalid`），A4 的转交在 helper 强制下实际不可用。子 agent 退出、租约退还给父 agent 时也一样。
- leaseId 是 Broker 进程内的计数器（`lease-1`、`lease-2`……）。Broker 重启后，新的 `lease-1` 会撞上 helper 里记着的旧 revoked id，合法写入被拒。
- 撤销集合无限增长。

要求：
1. 转交时签发新的 leaseId（旧 id 撤销，新 id 交给接收方），或者把撤销粒度改成 `(leaseId, agentId)`。推荐前者，语义更简单。
2. leaseId 在 Broker 进程之间也要唯一，比如加上 Broker 启动时生成的随机前缀。helper 拿到新的 key 时清空撤销集合（key 变了，旧 token 本来就全部失效）。
3. 撤销集合有界：已过期 lease 的 id 可以丢弃（这一步依赖 E1 先修好）。
4. 测试（走 E1 的真实 Broker 到 Swift 互通路径）：转交之后，接收方的 token 能通过，原持有者的被拒；子 agent 断开之后，父 agent 能继续写；Broker 重启、换了 key 之后，新租约能通过。

### E3 写命令和资源的对应关系不对

`LeaseGuard.resourceKey(command:request:)` 不区分 mode：
- `manageWindow` 的 `list` 带 pid 时是读操作，却被要求带租约，所以 `manage_window list pid=…` 在 helper 强制下会失败。`manageApps` 的 `list` 也有同样的问题（虽然目前 TS 走的是 `listApps`，但 helper 不应该依赖这一点）。
- `manageApps` 的 `quit` 和 `launch` 落到默认分支 `desktop-pid:*`，资源比对被跳过。结果是：只要手里有任何一个合法租约（哪怕是另一个 App 的 `desktop-pid`），就能让 helper 退出任意 App。
- 能识别为写命令、但算不出目标的请求，现在是直接放行（`guard let expected … else { return }`）。

要求：
1. 按 mode 区分读写。只有会改变状态的 mode 才要求租约。
2. `manageApps quit` 和 `launch` 要求 token 的资源与目标一致：helper 用 pid 或 bundleId 算出 `app:<bundleId>`，与 `claims.resourceKey` 比对。资源 key 的格式以 `src/tools/intents.ts` 为准，两侧各写一条测试锁住格式。
3. 写命令算不出目标时，返回 `lease_invalid`，失败关闭，不放行。
4. Swift 自测补上这三种情况。

## 必须写明（随 E1–E3 一起改）

### E4 helper 身份是自报的

任何连接只要在 hello 里写上 `role: "helper"`，就能拿到签名 key，也能发 `resume`、`takeover_approval`、`preempted`。审核者第二次以 helper 身份连接，同样拿到了 key。这在同一用户的信任边界内可以接受（第 1 轮 B3 已经这样认定过），但不能写成“密钥不经过客户端”。

要求：
1. 同一时间只接受一个 helper 连接。已经有 helper 在线时，后来的 helper hello 返回 `not_permitted`；原来的 helper 断开以后，才接受新的。补测试。
2. `behaviour-changes.md`、`lease-token.ts` 的注释和 STATUS-2 都如实写明：helper 侧强制防的是我们自己的客户端出错或绕过 Broker，不防同一用户下冒充 helper 的进程。
3. 根 `CLAUDE.md` 第 4 节，等 B4 真机反例通过后再改，到时候也按这个边界来写。

## 对 Q3、Q4 的回答

- **Q3（`src/outline.ts` 24 KB）**：按职责拆分，不加入豁免名单。豁免名单只限用户点名的三个文件。拆完之后把原生 secure 标记接进 `OutlineNode`，并删掉第一期 TS 侧按 role 判断的近似做法，同时保留那个测试，改成断言用的是原生标记。
- **Q4（批次输入没有切到 L4 HID）**：接受。等 B5 有了真机证据，再接到投递路径上。CLAUDE.md 第 4 节这次不改，这个做法是对的。
- **Q1（时长没填）**：这是用户提示词的问题，不是执行方的。下次 B 阶段由用户给出明确的时长。

## 接受

- A1：`bridge.ts` 从 146,143 字节降到 130,698 字节，执行器移到 `src/tools/`，集中构造意图的不变量保留了下来。
- A2：干净 checkout 全部通过。`loadComputerUseConfig` 改成 async 之后，三个调用点都已经 await。
- A3：暂停状态放在 Broker 里，只有 helper 能恢复，读不受影响。
- A4：只允许转交给自己的后代，子 agent 断开时退还租约。语义接受，但被 E2 卡住，修完 E2 后才算可用。
- A6：三个条件、未知活动按“不空闲”处理、`lastUserInputAt` 只接受 helper 上报、headless 不进入 L4，接受。
- A7、A8：接受。fixture 每次换 bundle id 和路径，是解决 `-10825` 的正确方向，但只有真机能证明它。

## 下一步

1. 修 E1–E3，补上 E4 的单 helper 限制和文档，处理 Q3。仍然只在 L1 层面验证，不运行真机脚本。
2. 推送后更新 STATUS-2，写明这一轮的修复和测试数字。
3. B 阶段由用户另约时间、给出明确时长后再开始。开始条件和规则不变，另外加一条：B4 的反例必须用真实 Broker 签出的 token（包括过期和撤销的），不允许脚本自己构造 token。

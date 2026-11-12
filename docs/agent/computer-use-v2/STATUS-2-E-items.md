# Computer Use v2.1 第四轮审核的逐项记录（E1–E4、Q3）

对应 `REVIEW-4.md`。每一项修完即提交、推送；本文件与 `STATUS-2.md` 的表格一一对应。
仍然只在 L1 层面验证：没有真机运行，没有移动光标、没有启动 App、没有触碰操作者已打开的进程。

## E1 租约过期检查永不触发（毫秒 / 秒混用）

审核指出的缺陷确认存在：`BrokerCore` 用 `Date.now()`（毫秒）签发 `expiresAt`，Swift 侧拿它和
`Date().timeIntervalSince1970`（秒）比较，因此真实 broker 签出的 token 在 helper 侧永远不过期。
原有测试没发现，是因为 Swift 自测和 `check-lease-guard.mjs` 都自己按“秒”构造 token。

修法（统一为毫秒，签发方为准）：

- `LeaseClaims.expiresAt` 与 Swift `Claims.expiresAt` 都写明“毫秒，与 `Date.now()` 同钟”，
  Swift 侧比较前把本机时钟换算成毫秒（`Date().timeIntervalSince1970 * 1000`）。
- 自测加一条 `seconds_expiry_is_expired`：用“秒”当过期时间的 token 必须被判为过期。单位若再漂回秒，
  这条会失败。
- 互通检查不再手搓 token：`scripts/check-lease-guard.mjs` 用真实 `BrokerCore` 签发，Swift 只负责
  “接受/拒绝”回放。四步分别是 `broker_valid`、`broker_expired`、`broker_wrong_pid`、`no_token`，
  其中过期那步用**过去一小时的 broker 时钟**签，所以只有毫秒比较才会判过期。

**顺带发现并修掉的同类缺陷（同一处单位混用，属于 E1 范围）：** helper 的
`UserActivityMonitor.lastUserInputAt` 记的是**秒**，而 `pushActivity` 推送前又乘了 1000，broker 用毫秒
`Date.now()` 相减，得到约 -1.79e12 的负数。后果是 `takeoverRefusal` 每次都判定“用户刚活动过”，
L4 接管在真机上永远无法成立（失败方向是保守的，但网关已经是错的）。现在内部时间戳统一为毫秒，
`idleSeconds` 由毫秒差值换算，`userActive(within:)` 也按毫秒比较。broker 侧新增边界校验：
`ping.lastUserInputAt` 不是毫秒（超出“现在 - 24h … 现在 + 1min”）就返回 `invalid_request`，
不再把错误单位当成活动时间存下来。

验证：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 全量 TS 测试 | `node --test --experimental-strip-types "test/*.test.ts"` | 110 通过、0 失败（新增 2 条：毫秒 expiry、秒级活动上报被拒） |
| Swift 自测 | `helper --lease-self-test` | 7 项全过（含 `seconds_expiry_is_expired`） |
| 互通 | `node scripts/check-lease-guard.mjs` | 4 步全过，全部 token 来自真实 `BrokerCore` |
| 反向对照 | 把 Swift 比较改回秒后重跑互通 | `step broker_expired fail`、`fixture failures=1`，说明该用例确实能抓到单位回退 |

限制：真机上租约到期后的实际拒绝仍属 B4 范围；这里只证明两侧比较的是同一个单位。

## E2 按 leaseId 撤销会误杀转交后的租约和重启后的新租约

审核指出的三个后果都确认存在：`transfer`/`transferAll` 保留原 leaseId 又把该 id 当作 revoked 推给
helper，于是接收方一写就被拒；leaseId 是进程内计数器，broker 重启后新的 `lease-1` 撞上旧 revoked
记录；撤销集合只增不减。

修法：

- **转交签发新 id。** `LeaseManager.transfer`/`transferAll` 走新的 `reissue()`：新 leaseId、新 epoch、
  新到期时间，旧 id 以 `transferred` 撤销并停止存在。接收方拿到的是新 id 的 token，旧持有者的 token
  在 helper 侧被拒。epoch 同时前进，所以父 agent 的旧观测不能直接给子 agent 用（子 agent 自己观测后
  才写），这条在 `broker-transfer.test.ts` 里断言为 `stale`。
- **id 跨进程唯一。** `LeaseManager` 启动时生成 4 字节随机前缀，id 形如 `lease-<hex>-<n>`；测试锁住
  格式，并断言两个独立 broker 进程不会发出同一个 id。
- **撤销集合有界。** `RevokedEvent` 增加 `expiresAt`（这批被撤销租约里最晚的到期时间，毫秒），helper
  只在到期前记住这些 id，之后丢弃。写入路径两侧同一规则：撤销事件带 `expiresAt`，helper 存
  `id → 到期时间` 并在每次 `revoke`/`check` 时清理过期项。
- **换 key 清空撤销集合。** broker 重启后 key 变了，旧 token 本来就全部失效；`configure(keyBase64:)`
  发现 key 与上次不同就清空 revoked，避免新进程复用 id 时被历史记录挡住。

验证：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 全量 TS 测试 | `node --test --experimental-strip-types "test/*.test.ts"` | 112 通过、0 失败 |
| 新增 TS 用例 | 同上 | id 跨进程唯一且格式固定；转交撤销旧 id 并带 `expiresAt`；转交后父 agent 被 `resource_busy`、旧 epoch 为 `stale`、子 agent 写入复用新 id；子 agent 退出后 app 以新 id 回到父 agent |
| Swift 自测 | `helper --lease-self-test` | 9 项全过（新增 `expired_revocation_forgotten`、`new_key_clears_revocations`） |
| 互通（真实 broker） | `node scripts/check-lease-guard.mjs` | 9 步全过，含 `transfer_old_id_revoked`、`transfer_receiver_accepted`、`expired_revocation_forgotten`、`restart_new_key_accepted`、`restart_old_key_rejected` |

限制：这仍然只证明两侧规则一致；真机上“转交后子 agent 真的能写”属于 B4 内容。

## E3 写命令和资源的对应关系不对

审核列出的三处都确认存在：`manageWindow list` 被当成写命令（带 pid 时反而要求租约）；
`manageApps quit`/`launch` 落到默认分支 `desktop-pid:*`，资源比对被跳过，于是手里有任何合法租约就能让
helper 退出任意 App；能识别为写命令但算不出目标的请求直接放行。

修法（`LeaseGuard.requirement`）：

- **按 mode 显式区分读写。** `manageApps list`、`manageWindow list`/`list_displays` 是读，不需要租约；
  `move`/`resize`/`maximize`/`minimize`/`restore` 是写，要求 `desktop-pid:<pid>`。未知 mode 按写处理。
- **`manageApps` 绑定到 App。** helper 用请求里的 `bundleId`/`pid` 查 `NSWorkspace`，算出
  `app:<bundleId>` 与 `app:<localizedName>`，与 token 的 `resourceKey` 比对；`launch` 走路径时用
  `Bundle(path:)` 取 bundle id。格式以 `src/tools/intents.ts` 为准，两侧各加了一条锁格式的测试。
- **只凭路径 launch 的匿名情况单独处理。** 调用方拿不到 App 身份时 `appIntent` 生成的是
  `desktop-pid:0`，所以 helper 仅在该请求既没有 `bundleId` 也没有 `pid` 时接受这一把 key。真实 pid 的
  租约仍然不能用来 launch（用例断言被拒），没有回到“任何租约都行”。
- **算不出目标就失败关闭。** `act` 没有 pid、`manageWindow` 写操作没有 pid、`manageApps` 既无 bundleId
  也无 pid、未知 mode、未知写命令，一律 `lease_invalid`，不再静默放行。
- `desktop-pid:*` / `any` 这两个通配判断被删除，比对改成“token 的 resourceKey 必须落在该命令允许的集合里”。

验证：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 全量 TS 测试 | `node --test --experimental-strip-types "test/*.test.ts"` | 113 通过、0 失败（新增 intent 资源 key 格式锁） |
| Swift 自测 | `helper --lease-self-test` | 19 项全过，含读命令免租约、无 pid 的写命令被拒、`quit` 同 App 放行/异 App 拒绝/pid 租约拒绝/无 token 拒绝、按路径 launch 只接受匿名 key |
| 互通（真实 broker） | `node scripts/check-lease-guard.mjs` | 13 步全过，含 `app_lease_quits_its_own_app`、`app_lease_cannot_quit_another_app`、`manage_window_list_is_read`、`manage_window_move_without_pid_refused` |

仍然存在的缺口（未在本轮扩大范围）：`focusWindow`、`clipboardRestore` 会改变状态但没有列入
`writeCommands`，TS 侧也没有给它们附租约。它们不在审核 E3 的清单里，改动会牵涉工具层合同，留给
B4 真机反例测试之后一起决定（已记入 STATUS-2 的待决问题 Q5）。

## E4 helper 身份是自报的（一条限制，两处修正，文档如实写明）

审核的结论是：任何连接只要在 hello 里写 `role: "helper"` 就能拿到签名 key，也能发 `resume`、
`takeover_approval`、`preempted`；在同一用户的信任边界内可以接受，但不能写成“密钥不经过客户端”。

做到的：

- **同一时间只接受一个 helper 连接。** `onHello` 在注册前检查：已有别的 `role=helper` 连接在线时返回
  `not_permitted` 且**不**发 key；同一个 agentId 重连（同一 helper 进程重连 socket）不算第二个；原 helper
  断开后才接受新的。测试覆盖三条：第二个被拒且拿不到 key、同 id 重连允许、断开后可换新的。
- **文档如实写明边界。** `behaviour-changes.md` 第 7 条、`src/broker/lease-token.ts` 头注释、本文件都改成
  “防的是我们自己的客户端出错或绕过 broker，不防同一用户下冒充 helper 的进程”。
  根 `CLAUDE.md` 第 4 节按审核要求**这轮不动**，等 B4 真机反例通过后再按这个边界写。

验证：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 全量 TS 测试 | `node --test --experimental-strip-types "test/*.test.ts"` | 114 通过、0 失败（新增单 helper 用例） |

限制（如实记录）：helper 身份仍是自报的。同一用户下的另一个进程可以启动一个“先到”的 helper 占住这个
角色；broker 只能保证“只有一个”，不能保证“是我的那个”。这一点写进了文档，不冒充隔离。

## Q3 `src/outline.ts` 按职责拆分，并把原生 `secure` 标记接进 `OutlineNode`

审核要求拆分、不加入豁免名单，并且拆完之后把原生 secure 标记接进 `OutlineNode`、删掉第一期 TS 侧
按 role 判断的近似做法、保留测试但改成断言原生标记。做完后 `outline.ts` 从 24,448 字节变成 836 字节的
公开出口，实现按职责分成六个文件：

| 文件 | 字节 | 职责 |
| --- | --- | --- |
| `src/outline.ts` | 836 | 唯一公开出口（re-export），10 个既有 import 路径不变 |
| `src/outline/types.ts` | 3,102 | 数据模型（`OutlineNode`、`LookResponse`、序列化形状等） |
| `src/outline/parse.ts` | 5,481 | 把 helper 的不可信 JSON 解析成模型 |
| `src/outline/lookup.ts` | 1,898 | 按 ref 查节点、路径与标签、`outlineHasSecureField` |
| `src/outline/render.ts` | 4,613 | 预算内折叠渲染 |
| `src/outline/search.ts` | 5,532 | 排名搜索与顺序过滤 |
| `src/outline/serialize.ts` | 6,768 | 序列化/恢复/嫁接与字段拷贝 |

secure 标记：

- `OutlineNode.secure` 是新字段，注释写明“helper 的原生 `AXSecureTextField` 标记（协议 9）”，
  并说明为什么不能用 role 名代替。
- `parse.ts` 从 payload 读 `secure`（默认 false）；`serialize.ts` 在嫁接的 `copyNodeFields` 里保留它，
  恢复旧会话时把缺失值归一为 `false`；`serializeOutline` 天然带上它。
- `bridge.ts` 的 `recordToolTrace` 只用 `outlineHasSecureField()`，并删掉了 role 近似与
  `details.target` 正则回退。函数移到 `src/outline/lookup.ts`（它是 outline 查询，不属于 bridge）。
- 新测试 `test/outline-secure.test.ts`（3 项）：原生标记会被带上且默认为 false；**只有 role 名
  `AXSecureTextField` 不再算 secure**（旧近似会误判）；标记在序列化、恢复、嫁接后仍然存在，
  所以 scoped look 不能把它洗掉。

验证：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 全量 TS 测试 | `node --test --experimental-strip-types "test/*.test.ts"` | 117 通过、0 失败（新增 3 项 secure 用例） |
| 每个文件的提交门槛 | `wc -c` | 最大 6,768 字节，全部远低于 20,000 |
| 脚本 dry run | `node scripts/cu-v2-script-dry-run.mjs` | 6 通过、3 显式跳过（未受影响） |

限制：真正的“拍不到 secure 字段截图”仍要在真机（B6 的 trace 检查）里看；这里证明的是判断依据换成了
原生标记，且四种形态（解析、存储、恢复、嫁接）都不会丢。

## Q5：`focusWindow` 与 `clipboardRestore` 纳入租约（复核后补做）

`REVIEW-4.md` 的复核把这一条列为 A 阶段收尾的最后一项：两者都会改变用户看到的状态，却不在 helper
的 `writeCommands` 里，TS 侧也不给它们附租约，等于留了两条“不用租约也能写”的缝。

**helper 侧**（`native/macos/bridge.swift`）：

- `writeCommands` 加入 `clipboardRestore`、`focusWindow`，并在注释里写明“写入命令是穷举清单”。
- `LeaseGuard.requirement` 给出两者的资源：`clipboardRestore` → `clipboard:system`；
  `focusWindow` → `desktop-pid:<pid>`，请求里没有 pid 就是 `.undeterminable`（失败关闭）。
- 自测新增 4 项：两个“无 token 被拒（`lease_invalid`）”，两个“带正确租约通过”。

**TS 侧**：

- `ComputerUsePlatformBackend.focusWindow(target, signal, lease)`：`lease` 是**必填**参数，三个平台的
  backend 都把它放进请求体。现在产品里没有任何工具调用 `focusWindow`（窗口前置走 `act`/`manageWindow`
  的原生路径），所以这是合同层的强制，而不是给某条热路径加参数——写清楚，免得以后有人以为它已被覆盖。
- `clipboardRestore(snapshot, signal, lease)` 同样必填；`src/tools/clipboard.ts` 新增
  `restoreWithLease()`：还原走 `deps.scheduler()` 的 `clipboard:system` 写入，拿到 token 才调用
  backend；`LeaseUnavailableError`（别人持有、被拒、被暂停）一律转成 `RestoreLeaseUnavailableError`。
- 延迟还原的 `write` 抛这个错误时，`scheduleClipboardRestore` 记 `restore_skipped:lease_unavailable`
  （新理由码，`src/trace/recorder.ts` 的类型同步扩展），**不写、不重试**。
- `clipboardIntent` 接受 `"restore"`：动作名 `clipboard_restore`，资源仍是 `clipboard:system`，
  `src/policy/tiers.ts` 里同样是 `full`——还原和写入一样需要授权，且 trace 能区分“agent 写的”与
  “agent 自己还原的”。

**测试**（`test/clipboard-restore-lease.test.ts`，3 项）：

1. 另一个 agent 持有 `clipboard:system` 时，`restoreWithLease` 抛 `RestoreLeaseUnavailableError`，
   **backend 一次都没被调用**（用真实 `ResourceScheduler` + 会拒绝的 broker）。
2. 拿到租约时，backend 收到的正是 `{resourceKey: "clipboard:system", token}`。
3. 延迟还原的 `write` 抛这个错误时，跳过理由记成 `lease_unavailable`，不是 `restore_failed`。

互通（`scripts/check-lease-guard.mjs`）新增 5 步：`focus_window_without_token_refused`、
`focus_window_with_pid_lease_accepted`、`clipboard_restore_without_token_refused`、
`clipboard_restore_with_clipboard_lease_accepted`、`clipboard_restore_cannot_use_app_lease`，
token 全部由真实 `BrokerCore` 签发。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 全量 TS 测试 | `node --test --experimental-strip-types "test/*.test.ts"` | 120 通过、0 失败（新增 3 项） |
| helper 自测 | `helper --lease-self-test` | 22 项全过，`lease-guard failures=0` |
| TS↔Swift 互通 | `node scripts/check-lease-guard.mjs` | 18 步全过 |
| 脚本 dry run | `node scripts/cu-v2-script-dry-run.mjs` | 6 通过、3 显式跳过 |

限制：`focusWindow` 目前没有产品调用方，所以它的租约只在合同与 helper 自测/互通层面验证，没有
一条真实用户路径会被它拦住或放行；真机上的行为要等 B 阶段（以及将来真的加窗口前置工具时）。

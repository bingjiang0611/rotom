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

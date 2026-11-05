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

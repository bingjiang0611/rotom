# macOS 上默认开启 Broker 带来的行为变化

合入 Computer Use v2 后，macOS 上跨进程 Broker 默认启用。这是**行为变化**，不是纯内部重构：
以前能跑的无人值守流程，在没有任何授权记录时会直接失败。本文说明变了什么、怎么保持原样。

## 变了什么

1. **每个 App 的第一次写入会弹授权卡。** 授权按 App 身份（bundle id 优先）生效，级别分为
   `view`（只读）／`click`（可点击，不给文本与按键）／`full`（含文本、按键、剪贴板写入）。
   这是新增的一次性交互；同一次会话内再次写入同一个 App 不会再问。
2. **没有可展示授权的运行方式里，未授权 App 直接失败。** 包括 `-p`／RPC／eval 这类没有 TUI 的
   启动方式。此时报错是结构化的 `approval_unavailable`，不是静默降级：
   > no UI-capable session is available to approve writes to 'Some App'

   也就是说，之前“装上就能用”的后台 Computer Use 流程，升级后第一次运行会卡在这里。
3. **同一时间只有一个 agent 能写同一个 App。** 抢同一个 App 的第二个 agent 立即得到
   `resource_busy`（带持有者与剩余租期）；显式 `wait: true` 才排队，最长 30 秒。
4. **剪贴板变成共享资源。** 读写都走 `clipboard:system` 租约，所以并发的剪贴板写入不会互相覆盖，
   但等待者可能拿到 `resource_busy`。
5. **强制退出单独确认。** `manage_app quit` 且 `force: true` 时，即使这个 App 已经拿到 `full`，
   也会再弹一次确认卡（动作名 `manage_app_force_quit`），因为强制退出不给 App 保存或询问的机会。
6. **动作打扰到用户时，该 agent 会被暂停（第二期 A3）。** 判定仍然由 helper 做：动作之后前台
   App 变了，并且用户在 2 秒内有过真实输入。被暂停的 agent 后续写请求一律返回
   `paused_interfered`，它持有的租约同时被撤销（所以要释放给用户和其他 agent），读请求不受影响。
   恢复只能由用户做：helper 菜单栏对被暂停的 agent 显示 “Resume …”，Broker 只接受
   `role=helper` 连接发起的 `resume`。模型没有任何工具可以恢复自己。

7. **写入由 helper 自己校验，不再只靠 broker（第二期 A5）。** broker 给每份租约签一个 token
   （HMAC-SHA256），签名密钥只在 broker 内存里生成，只交给 `role=helper` 的连接，不落盘、不经过
   任何 agent。helper 在执行写动作前检查签名、有效期、目标 pid 与已撤销列表，任一不满足就返回
   `lease_invalid`／`lease_expired`，动作不会发生。这意味着**绕过 broker 直连 helper socket 已经
   不能写**：这正是“别人直接调 AX/HID”这条缺口被堵掉的部分。
   helper 协议随之升到 **9**；旧 helper 不会被自动重启，协议不匹配时客户端报错要求重新安装。
   关掉 broker（见做法二）时 helper 拿不到密钥，于是不做校验——仍是旧行为，不是静默绕过。
   **这条边界要说清（第二期 E4）：helper 的角色是自报的。** 任何进程在 hello 里写
   `role: "helper"` 都可能被当成 helper，所以这里防的是“我们自己的客户端出 bug 或不走 broker”，
   不是“同一用户下的恶意进程”——后者在本机属于同一信任边界，拦不住也不该在文档里假装拦得住。
   能做的两件实事已经做了：同一时间只接受一个 helper 连接（第二个 hello 得到 `not_permitted`，
   原 helper 断开后才接受新的），以及密钥只在 hello 成功后交给这一个连接。

8. **前台接管（L4）是一个独立的、默认没有授予的许可（第二期 A6）。** `cu_session` 新增
   `takeover`／`release_takeover`：拿不到这个许可就一个字节也不会写。三个条件同时成立才发放
   “整个桌面”的全局租约——用户在这个 App 上允许过前台模式（`policy.json` 里
   `{"apps": {"<bundle id>": {"tier": "full", "foreground": true}}}`，只有用户自己写的文件算数，
   项目文件只能撤销不能新增）、用户已经 10 秒没有真实输入（或刚在菜单栏点过“让它接管”，
   60 秒内有效）、没有别的 agent 持有前台。接管期间 helper 显示全屏边框并吞掉 `Esc`
   （只吞这一个键）；任何不带 agent 标记的真实输入立刻收回接管，结果是 `preempted_by_user`，
   已经执行的步骤如实报告、不回滚。无 UI 的 headless 会话永远不进入 L4。
   没有 broker 时 `cu_session takeover` 直接不可用（前台必须有人仲裁）。

## 保持原来行为的两种做法

### 做法一：预先在 policy.json 里写好授权（推荐）

全局文件默认在 `~/.rotom/computer-use/policy.json`（`ROTOM_CU_POLICY` 可改路径）。项目级文件
是工作目录下的 `.pi/computer-use.json`，它只能收紧、不能放宽全局设置。

```json
{
  "v": 1,
  "apps": {
    "com.apple.TextEdit": "full",
    "com.google.Chrome": "view"
  },
  "sensitive": true
}
```

写完即生效，不需要重启：Broker 每次决策都会重新读策略文件。键名优先用 bundle id，没有 bundle id
的 App 才退回用名字。

- `view`：只能观察、读文本、列窗口。
- `click`：可以点击、框选、移动窗口，但没有文本输入、按键和剪贴板写入。
- `full`：包含文本、按键、剪贴板写入、退出 App。
- `"deny"`：拒绝该 App 的一切写入（`apps` 的值可以是 `"deny"`）。

已通过卡片授予的 App 也会写进这个文件；手工改它等同于用户自己的决定。

### 做法二：关掉 Broker

```sh
ROTOM_CU_BROKER=0
```

关闭后回到 v1 的进程内行为：没有跨进程仲裁、没有授权卡、没有 App 分级和敏感动作确认，也不写
broker trace。适合“这台机器只有我一个人用、且我确定不会有两个 agent 同时写同一个 App”的场景。
这是**降低保护**的开关，不是等价替代：关掉后 B2/B3 那几条拒绝逻辑都不再生效。

## 与哪些能力相关

- `sensitive: false` 可以关掉敏感动作的额外确认，但关不掉授权卡本身。
- `ROTOM_CU_TRACE=0` 只关 trace 写入，不影响授权。
- 白名单无关：L2 定向投递只在 `src/policy/l2-compat.ts` 名单内的 App 上使用，名单外的 App
  仍然报 `foreground_required`，与本文的授权是两道独立的门。

## 已验证的行为

第二期的补充见 [`test/broker-pause.test.ts`](../../../packages/rotom-computer-use/test/broker-pause.test.ts)（A3 暂停）
与 [`test/lease-token.test.ts`](../../../packages/rotom-computer-use/test/lease-token.test.ts)（A5 租约 token）。
A6（前台接管）见 [`test/takeover.test.ts`](../../../packages/rotom-computer-use/test/takeover.test.ts)：
三个条件、第二个 agent 抢到时 `resource_busy`、真实输入触发 `preempted_by_user`、headless 拒绝、
边框与续租用假 backend 覆盖。

A5 的 native 侧用 `npm run test:lease-guard` 验证：helper 自检 19 项（合法／签名错／过期／秒级过期／
pid 不符／已撤销／过期撤销被遗忘／换 key 清空撤销／读命令免租约／无 pid 的写命令被拒／
`manageApps` 只认自己的 App／无 broker 密钥），再用**真实 `BrokerCore` 签出的 token** 跑 13 步
（合法、过期、错 pid、无 token、转交后的新旧 id、重启换 key、App 级租约、读命令），不再由脚本自己
构造 claim。

- `packages/rotom-computer-use/test/cu-v2-authority.test.ts`：
  - 预先授权为 `full` 的 App 在无 UI 会话里可以写入；同一个无 UI 会话写入未授权 App 得到
    `approval_unavailable`。
  - `view` 级 App 的 `manage_app quit` 被拒绝（`denied`）。
  - 另一个 agent 持有的 App 做 `manage_window` 变更得到 `resource_busy`。
  - 强制退出在已有 `full` 授权时仍然弹卡；普通退出不再弹。

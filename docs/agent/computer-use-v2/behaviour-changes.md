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

第二期的补充（A3 暂停）见 [`test/broker-pause.test.ts`](../../../packages/rotom-computer-use/test/broker-pause.test.ts)。

- `packages/rotom-computer-use/test/cu-v2-authority.test.ts`：
  - 预先授权为 `full` 的 App 在无 UI 会话里可以写入；同一个无 UI 会话写入未授权 App 得到
    `approval_unavailable`。
  - `view` 级 App 的 `manage_app quit` 被拒绝（`denied`）。
  - 另一个 agent 持有的 App 做 `manage_window` 变更得到 `resource_busy`。
  - 强制退出在已有 `full` 授权时仍然弹卡；普通退出不再弹。

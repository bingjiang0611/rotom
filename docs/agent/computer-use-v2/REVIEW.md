# Computer Use v2 审核意见（第 1 轮）

审核对象：`claude/computer-use-v2` 上 `2c7b6b1..2e1cdd4` 的 8 个提交。审核日期 2026-11-04。

结论：**暂不合入**。Broker 核心（M1）、bridge 接入（M2）、策略模块（M3）和 trace（M4）的结构和测试质量都不错，没有发现在 PLAN 之外乱加东西。但有 4 个阻断问题，其中 B1 会让产品里的 Computer Use 写操作在 macOS 上全部失败。请按下面的顺序修复，修完更新 STATUS 并推送，然后照常继续。

## 审核者本地复现

- 环境：Linux，Node 22.23.4。
- 干净 checkout 后直接运行 `npm test`：`test/cu-v2-tools.test.ts` 因找不到 `@earendil-works/pi-coding-agent` 失败（见 I3）。
- 在 `packages/rotom-computer-use/node_modules/`（已被 gitignore）放入 `@earendil-works/pi-coding-agent` 桩（只导出 `getAgentDir`、`defineTool`）和 npm 上的 `typebox@1.4.4` 之后，连续跑 3 次 `node --test --experimental-strip-types "test/*.test.ts"`：每次 62 个用例，61 通过、0 失败、1 跳过。
- `rotom/extensions/third-party` 下运行 `npm ci` 失败，原因是 lock 与 package.json 不同步。`main` 上本来就是这样，不是本分支引入的。

## 阻断问题（合入前必须修）

### B1 产品安装后 Broker 无法启动，macOS 上 Computer Use 写操作全部失败

`src/broker/client.ts` 用 `spawn(process.execPath, [daemon.ts])` 拉起 Broker。产品里这个组件装在 `rotom/extensions/third-party/node_modules/@injaneity/pi-computer-use/` 下，而 Node 不允许对 `node_modules` 里的 `.ts` 做类型擦除。复现：

```
$ node <tmp>/node_modules/pkg/d.ts
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]
```

macOS 上 Broker 默认开启，并且 `broker_unavailable` 时写操作是失败关闭的，所以安装版里所有写操作都会失败。现有测试都是从源码目录运行的，因此测不出来。

要求：
1. 让 daemon 入口在 `node_modules` 里也能运行。可以手写纯 JS 的 `daemon.mjs`，在入口里加载 Pi 已经在用的同一个 TS loader；也可以在打包时生成 JS。具体方案你选，记到决定记录。
2. 新增回归测试：把 package 复制进临时目录下的 `node_modules/@injaneity/pi-computer-use/`，用真实的 `BrokerClient.connect({ spawnIfMissing: true })` 拉起 Broker 并完成一次 acquire 和 release。这个测试在修复前必须失败。

### B2 新增的写工具绕过了策略和租约

`performClipboard`、`performManageApp`、`performManageWindow`（`src/bridge.ts` 约 2661–2780 行）直接调用 backend，没有经过 PolicyGate，也没有拿租约。`tiers.ts` 里虽然给它们定了级别，但执行路径没用上。结果是：
- 无 UI 的 subagent 可以不经审批读写剪贴板（PLAN 要求剪贴板单独授权）。
- `manage_app quit` 能关掉 `view` 级别的 App，也不触发敏感确认。
- `manage_window move/resize/minimize` 可以操作另一个 agent 正在持有的 App。

要求：
- 剪贴板读、写、清空都需要单独授权，写入需要拿全局剪贴板租约。
- `manage_app quit` 走敏感确认并拿目标 App 的租约；`launch` 走 App 授权。
- `manage_window` 的写操作拿目标 pid 的租约，并按级别校验。
- 测试至少覆盖：对 `view` 级 App 执行 quit 被拒；无 UI 的 subagent 读剪贴板得到 `approval_unavailable`；对另一个 agent 持有的 App 做 resize 得到 `resource_busy`。

### B3 模型可以通过 `cu_session stop` 停掉别的 agent

`cu_session` 的 `stop` 会撤销所有其他 agent 的租约。PLAN 第 7 节规定停止只能由用户触发（菜单栏和快捷键）。现在任何一个 agent 都能把别的 agent 停掉，这违背了多 agent 并行的前提。

要求：
- 从模型可见的 `cu_session` schema 里删掉 `stop`，只保留 `status`、`release`、`trace_export`。
- Broker 的 `stop` 请求只接受 helper 连接发起（helper 的 `hello` 里声明角色即可，同用户信任边界下不需要更强的认证，但要在文档里说明）。
- 修改 `resource_busy` 的提示文案：现在写的是 “ask the user to stop it with cu_session”，改成让用户用菜单栏或快捷键。
- 测试：schema 中没有 `stop`；非 helper 连接发 `stop` 被拒。

### B4 剪贴板恢复会覆盖用户内容

`scheduleClipboardRestore` 有两个问题：
1. 30 秒后无条件写回。如果用户在这 30 秒里自己复制了新内容，会被覆盖掉。这正是“影响用户”。
2. 只保存文本。用户原来复制的是图片、文件等非文本内容时，`previous.text` 为空，于是不恢复，用户原来的内容直接丢失。

要求：
- `set` 之后记下 `changeCount`。到时间时只有 `changeCount` 仍等于 agent 写入后的值，才恢复；否则放弃恢复并在 trace 里记录。
- 保存并恢复全部 pasteboard item 和类型，而不只是文本。如果某些类型无法完整保存，就拒绝 `set` 并返回明确错误，不要静默丢弃。
- 测试（用假 backend）：用户在 30 秒内复制了新内容时不恢复；之前是非文本内容时能原样恢复，或者拒绝写入。

## 重要问题（本轮一起修）

### I1 trace 参数脱敏用的是黑名单

`REDACTED_PARAM_KEYS` 只覆盖 `text/value/secret/content/typed`。`navigate_browser.url`、`evaluate_browser.expression`、`select.option`、`keypress.keys`、`manage_window.title`、`manage_app.path` 等都以明文写进 JSONL。根 `CLAUDE.md` 第 5 节的例外只覆盖截图和目标描述，不包括任意工具参数。

要求：改成**白名单**。只有动作名、ref、role、坐标、数值类参数可以原样记录，其余字符串一律只存长度和 SHA-256。测试：在 url、expression、option、keys 里各放一个唯一的哨兵字符串，断言 JSONL 和导出报告里都搜不到。

另外，原生侧还没有给 secure field 打标记，所以现在 secure field 也会被截图。在原生标记完成之前，TS 侧根据 outline 判断：目标或焦点元素的 role 是 secure text field 时，不保存截图。补一个测试。

### I2 helper 侧的租约强制和截图排除没做，STATUS 也没写

HANDOFF M5 第 8 项（截图排除宿主终端、helper 和覆盖层）和第 9 项（helper 校验 lease token 的 HMAC 并接收撤销列表）都没有实现，STATUS 也没有列为未完成。因此当前的仲裁只是**协作式**的：只靠我们自己的客户端遵守。

要求：在 macOS 能编译的前提下实现这两项；如果做不到，就在 STATUS 里明确列为未完成。同时把根 `CLAUDE.md` 第 4 节新加的那句“只保证不会有两个 agent 同时写同一个 App”改成如实的说法，即“协作式仲裁，helper 侧尚未强制”。

### I3 测试依赖 peer 包

修改前，baseline 测试不需要任何依赖就能跑；现在 `test/cu-v2-tools.test.ts` 依赖 `@earendil-works/pi-coding-agent` 和 `typebox`。二选一：让这个测试只 import 不依赖 peer 包的模块；或者在 package 的 README 或开发文档里写明测试前的依赖准备步骤，并在 STATUS 里说明“62 pass”是在什么依赖条件下得到的。

### I4 STATUS 前后不一致

- 里程碑表里 M5 写的是“未开始”，实际已编译。
- “总结”“既有失败”“需要审核者回答的问题”三节都是空的，但正文多处写着“见该节”。比如 `--no-verify`、匿名资源免审批、`preempted_by_user`、`check-tool-schemas.mjs` 不存在、`typecheck` 缺 `tsconfig.json`。
- M5 第 4 项说剪贴板恢复“尚未实现”，M6 又说已实现。

请把这些补齐并改成一致。另外，STATUS.md 现在约 25 KB，超过了提交钩子 20 KB 的上限：把已经结束的里程碑记录压缩到要点，详细内容放到 `evidence/` 下面。

### I5 根 CLAUDE.md 第 4 节自相矛盾

第一句仍然写着“产品当前没有……统一确认层”，紧接着新加的条目又说 v2 增加了同意层。请统一表述。

## 后续项（不阻断，第 2 轮再做）

- F1：PLAN 第 7 节的前台接管（L4）和 `preempted_by_user` 没做。
- F2：Broker 有 `transfer`，但没有接到 subagent spawn 上，父 agent 无法把 App 交给子 agent。
- F3：`interferedWithUser` 现在只打标记，PLAN 要求同时暂停该 agent。
- F4：agent cursor 的多实例和每个 agent 一种颜色还没做。
- F5：`SLEventPostToPid` 的签名是按社区惯例写的，签名不对时会崩溃而不是报错。第一次真机运行必须先单独验证它。

## 接受的偏差

- M3 中，没有 App 身份的资源（`cdp:` 浏览器页面）只做级别校验，不弹授权卡片。考虑到 D2 已经规定浏览器默认 `full`，接受这个做法，请记入决定记录。
- 新增 `core.ts` 语义层，以及 `baseEpoch` 省略时不做 stale 校验：接受。
- agentId 复用 `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID`，不新增环境变量：接受。

## 需要用户决定（审核者会转达，执行 agent 先按推荐做）

1. **超过 20 KB 的文件绕过提交钩子（用户已于 2026-11-04 决定）**：只允许对 `packages/rotom-computer-use/src/bridge.ts` 和 `packages/rotom-computer-use/native/macos/bridge.swift` 这两个已有文件使用 `--no-verify`。其他所有文件都必须通过钩子，包括 STATUS.md 和新增模块（单文件 20 KB 以内）。`bridge.ts` 只保留分发和接线，本轮写进去的 v2 逻辑（新工具执行器、剪贴板恢复、trace 接线）要挪到新文件里。每次使用 `--no-verify` 的提交，都要在 commit message 里注明“钩子豁免：仅 bridge.ts / bridge.swift”。
2. **真机验证需要一台能运行本地编译 helper 的 Mac**：这需要用户提供环境。在此之前，M5 和 M7 只能停留在编译级。

# 审核轮次修复记录（第 1、2 轮）

本文件保存第 1、2 轮审核的逐项修复细节；`STATUS.md` 只保留当前轮次与结论。

## 第 1 轮审核修复（2026-11-04）

审核意见见 `REVIEW.md`。下表只写已经做完并有回归证据的项；未做的单列。

| 项 | 状态 | 做法与证据 |
|---|---|---|
| B1 安装包里的 Broker 无法启动 | 已修 | 新增 `src/broker/daemon-entry.mjs`（纯 JS）：把 daemon 的源码闭包镜像到 `os.tmpdir()/rotom-cu-broker-stage-<hash>/` 再运行，绕开 Node 对 `node_modules` 内 `.ts` 的拒绝；`client.ts` 改为 spawn 该入口并带 `--experimental-strip-types`。回归 `test/broker-packaged.test.ts`：把包复制进临时 `node_modules/@injaneity/pi-computer-use/`，先证明直接跑 `daemon.ts` 得到 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`，再证明打包入口能完成 acquire/release。 |
| B2 新工具绕过策略与租约 | 已修 | `clipboard get/set/clear` 都经 `resourceScheduler.write("clipboard:system", …)`（动作名 `clipboard_get/set/clear`，按 `tiers.ts` 的 view/full 级别由 Broker 决策与审批）；`manage_app quit/launch` 经 `app:<bundleId|appName>` 租约；`manage_window` 写操作经 `desktop-pid:<pid>` 租约。新增 `describeApp()` 提供策略层需要的 App 身份。`cu-v2-tools.test.ts` 断言四个执行器都走 scheduler；仲裁与分级本身的回归在既有 scheduler / broker-policy 测试。 |
| B3 模型可停掉别的 agent | 已修 | `cu_session` schema 去掉 `stop`；Broker 的 `stop` 只接受 `role: "helper"` 的连接，否则 `not_permitted` 并提示菜单栏 / `Ctrl+Option+Cmd+.`；`resource_busy` 文案同步改。测试 `test/broker-stop.test.ts` 3 项。 |
| B4 剪贴板恢复覆盖用户内容 | 已修 | 新增 helper 命令 `clipboardSnapshot` / `clipboardRestore`：按 pasteboard item + `NSType` 保存 base64（不限文本；某类型读不出或超 64 MB 就拒绝写入）。`scheduleClipboardRestore` 记住写入后的 `changeCount`，到点只有仍未变化才恢复，否则跳过并写 trace `restore_skipped:<reason>`。真机往返：Chrome 的 4 种类型原样恢复，`changeCount` 1508→1509→1510。测试 4 项。 |
| I1 trace 参数黑名单 | 已修（截图排除为近似） | 改为白名单 `PLAIN_PARAM_KEYS`（结构、坐标、数值、布尔与枚举），其余字符串（含数组元素）只存长度 + SHA-256；测试用 url/expression/option/keys/path 哨兵断言搜不到。secure field 截图：原生侧还没标记，暂按结果里的 `AXSecureTextField` 角色丢弃图片，属近似而非原生保证。 |
| I2 helper 侧强制 lease / 截图排除宿主终端 | **未完成** | helper 尚未校验 lease token HMAC 与撤销列表，也未排除宿主终端与覆盖层截图，所以仲裁仍是协作式；根 `CLAUDE.md` 第 4 节已按此如实改写。 |
| I3 测试依赖 peer 包 | 部分 | 新增测试只 import 本包模块与 node 内置；`cu-v2-tools.test.ts` 仍依赖 `typebox` 与 `@earendil-works/pi-coding-agent`。 |
| I4 STATUS 不一致与体积 | 已修 | 里程碑表、既有失败、决定记录补齐；详细记录迁到 `evidence/milestones-*.md`，本文件降到 10 KB 以内。 |
| I5 根 CLAUDE.md 第 4 节矛盾 | 已提交 | `6b92ec6e`：删除“没有统一确认层”，改为“同意层不是隔离层”，并补“协作式仲裁，helper 侧尚未强制”。`check-staged-file-size.mjs` 增加 `oversizedByDecision`（`CLAUDE.md`、`bridge.ts`、`bridge.swift`）。 |
| 提交钩子只豁免 bridge.ts / bridge.swift | 已做 | 豁免名单现为三个文件，写死在 `scripts/check-staged-file-size.mjs` 并注明 2026-11-04 决定；此后提交不再需要 `--no-verify`。 |


## 第 2 轮审核修复（2026-11-04）

审核意见见 `REVIEW-2.md`。真机会话的完整记录在 `evidence/real-machine-session.md`。

| 项 | 状态 | 做法与证据 |
|---|---|---|
| R1 CLAUDE.md 仍夸大能力 | 已修 | `6b92ec6e`。按用户决定对 `CLAUDE.md` 加钩子豁免（豁免名单 3 个文件），提交 message 注明决定来源。 |
| R2 核心验收与 L2 未在真机跑 | 真机跑通（矩阵与 HID 未跑） | 后台不变量：`live-check.md` 33 行 0 失败，新增“光标坐标前后不变”（`delta=0.0pt`）与“前台 App 前后不变”（`Electron → Electron`）两行，且这两行只在无 `--with-hid` 时判定。PLAN §10 验收：`acceptance-run.md` 47 行 0 失败，3 个不同 bundle id 的 fixture 实例 + 用户模拟器，4 项断言全通过（文本逐字一致、前台与焦点窗口不变、9 次光标位移全部匹配模拟器日志、15 个任务完成 0 静默失败）。L2 单项：`l2-check.md` 部分完成——fixture 上定向点击 `delivery=ax` 成功且光标与前台未变；随后 fixture 窗口不再出现、LaunchServices 报 `-10825`，按用户“出现异常即停、不要重试”的约定停止；白名单 App（IntelliJ）当时被脚本自动选中并试过点击与输入，属越界，已加 `--allow-l2-app` 开关并记入证据。兼容矩阵与 `--with-hid` 因同一原因未跑。 |
| R2.5 “前台 App 与光标不变”写成已覆盖 | 已修 | `milestones-m5-m8.md` 改为记录“成段落成时只到编译通过”，并指向真机证据；该断言现在有真机行，不再是无证据声明。 |
| R3 B2 测试改行为测试 | 已修 | 新增 `src/tools/intents.ts` 集中构造 resource key / 动作名 / app 身份，`bridge.ts` 改为复用；`test/cu-v2-authority.test.ts` 用真 Broker + 真策略门（`createPolicyGate` + `PolicyStore`）跑 5 条行为：view 级 App 的 quit 被拒（`denied`）、无 UI 祖先读剪贴板 `approval_unavailable`、另一 agent 持有的 App `resource_busy`、预授权 `full` 的 App 在无 UI 时可写、强制退出即使已有 `full` 仍弹卡。`cu-v2-tools.test.ts` 只保留“意图必须集中构造”一条不变量。 |
| R4 staging 位置不安全 | 已修 | `ebde4273`。staging 根改为 Broker 私有根（随 `ROTOM_CU_BROKER_SOCKET` 隔离），root/stage 0700、拒 symlink；写临时目录后 rename 原子替换；import 前用 staged 字节重算指纹比对，不一致重新 staging，仍不一致则拒绝运行。测试新增两条：目录在私有根且 0700、预先篡改的 staged 文件会被真实源码替换。顺带修 `realpath` 比较（macOS `/tmp`、`/var` 是符号链接，否则启动器会静默退出）。 |
| 合入前需写明的行为变化 | 已写 | 新增 `docs/agent/computer-use-v2/behaviour-changes.md`：Broker 默认开启、每个 App 首次写入弹卡、无 UI 运行得到 `approval_unavailable`、两种保持原行为的做法（`policy.json` 预授权 / `ROTOM_CU_BROKER=0`）；并补测试“预授权 App 在无 UI 时可写”。 |
| I4 milestones 文件第 63 行过时 | 已修 | 同 R2.5，改为历史状态 + 指向真机证据。 |

未在本轮处理：F1–F5、`bridge.ts` 拆分、I2 的 helper 侧强制、兼容矩阵单元格。

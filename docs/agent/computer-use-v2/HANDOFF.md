# Computer Use v2 执行交接（给执行 agent）

你要在分支 `claude/computer-use-v2` 上实现 [PLAN.md](PLAN.md)。审核 agent 会读这个分支上的 [STATUS.md](STATUS.md) 和提交来核验你的工作。

目标是**一次尽可能多地做完、自己验证、少来回**。所以：按里程碑顺序一路做下去，每做完一个就提交、推送、更新 STATUS，然后直接继续下一个。不要停下来等审核。

## 0. 开工前必读

1. 根 `CLAUDE.md`（仓库规则，优先级高于本文件，冲突时以它为准并在 STATUS 里记录）
2. [PLAN.md](PLAN.md)（全部设计，含已定决策 D1–D5）
3. `packages/rotom-computer-use/docs/architecture.md`、`packages/rotom-computer-use/UPSTREAM.md`
4. `docs/agent/change-checklists.md` 的 “Browser / Computer Use” 和 “Observability” 小节
5. `docs/agent/verification.md` 的测试约定

先运行 `uname -s`，并在 STATUS 顶部记录执行环境（OS、架构、macOS 版本、是否有 Xcode/swiftc、是否已授予 Accessibility/Screen Recording）。**能否在 macOS 真机上运行，决定了 M5、M7、M8 能验证到什么程度**，见第 3 节。

## 1. 硬性规则

- 只推送到 `claude/computer-use-v2`。不推 `main`，不 force push，不改写已推送的历史。
- 不执行 `npm publish`，不替换用户已安装的 helper（`~/Applications/pi-computer-use.app` 或 `/Applications/...`），不重启别的会话拥有的 daemon。真机测试用单独的 helper app 路径和 socket（`PI_CU_SOCKET_PATH`、`ROTOM_CU_BROKER_SOCKET`）。
- 不调用付费模型。所有测试直接驱动 bridge / broker API。
- 不降低或删除已有测试来让新代码通过。已有测试本来就失败的，单独记在 STATUS 的“既有失败”里，不顺手修。
- 结构性证据不等于运行时证据。只跑了单测就写 L1；在 macOS 真机跑通才能写 L2。不要把 L1 写成 L2。
- 证据文件放 `docs/agent/computer-use-v2/evidence/`，只放文本日志和兼容矩阵，**不提交截图、不提交真实 App 的界面正文或个人数据**。
- commit message 用 `cu-v2(Mx): <中文摘要>`，一个里程碑可以有多个 commit。推送前运行 `git diff --check` 和 `python3 scripts/audit-public.py --root .`。

遇到需要决定的问题：
- PLAN 里已经有答案的，照做。
- PLAN 没写、但可以撤销的（命名、文件布局、默认数值），自己选一个合理值，记到 STATUS 的“决定记录”，继续做。
- 只有不可逆、超出上面授权、或者会改变 PLAN 已定决策的，才停下，写进 STATUS 的“需要审核者回答的问题”，然后跳到不依赖它的下一个里程碑继续做。

## 2. 里程碑

每个里程碑都写明了范围、验收测试和自证命令。验收测试必须**先写出会因为旧行为而失败的用例**（至少一个反例），再写实现。

通用自证命令（每个里程碑结束都跑；先按 package 现有方式安装依赖）：

```bash
cd packages/rotom-computer-use
npm run typecheck
npm test
npm run test:schema
npm run test:invariants
npm run test:runtime
npm run test:output
cd ../..
node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/index.test.ts \
  rotom/extensions/third-party/deferred-tools/register.test.ts
git diff --check
```

如果某条命令因为环境原因跑不了（比如缺依赖、缺 installed Pi），在 STATUS 里写清楚哪条、为什么、你怎么替代验证的。

### M1 Broker 核心（纯 TS，任何平台都能验证）

范围：`packages/rotom-computer-use/src/broker/`
- `protocol.ts`：消息类型与 `BROKER_PROTOCOL_VERSION = 1`。JSON-lines，带 request id。
- `server.ts`：Unix socket 服务。目录 0700、socket 0600，拒绝 symlink；启动锁防重复启动；所有 agent 断开后空闲 10 分钟退出（时长可注入，测试用假时钟）。
- `client.ts`：连接、按需拉起 broker（detached 子进程）、心跳（默认 3 秒）、断线重连。
- `registry.ts`：agent 注册（agentId、parentAgentId、hasUI、pid 祖先链）、心跳超时 10 秒视为断开。
- `leases.ts`：App 写租约（key 为 pid + 进程启动时间）、TTL 60 秒并随动作续期、`resource_busy`（带 holder 和剩余毫秒）、`wait: true` 时 FIFO 等待最长 30 秒、转交给子 agent、断开或停止时撤销。
- `epochs.ts`：每个资源的全局 epoch，`write` 时校验 baseEpoch。

验收测试（`test/broker-*.test.ts`），至少覆盖：
- 两个客户端写同一资源：第二个立即得到 `resource_busy`，内容含 holder 与剩余时间。
- `wait: true`：按 FIFO 顺序获得；超过 30 秒返回 `resource_busy`。
- 持有者断开（socket 关闭）和心跳超时都会释放租约；断开时进行中的写记为 `unknown`。
- TTL 到期释放；续期后不释放（假时钟）。
- 租约转交给子 agent 后，父 agent 写入被拒绝，子 agent 可以写。
- 客户端 A 写入后，客户端 B 用旧 epoch 写入得到 `stale`。
- 两个客户端同时尝试拉起 broker，最终只有一个 broker 进程。
- socket 目录权限、symlink 拒绝。
- 读操作不需要租约，可与写并发。

### M2 bridge 接入 Broker（TS）

范围：`src/bridge.ts`、`src/runtime.ts`、`src/config.ts`
- `ResourceScheduler.write` 在 Broker 模式下先向 Broker 获取租约和 epoch。
- `ROTOM_CU_BROKER=0` 回退为现有进程内行为；非 macOS 默认关闭。
- agentId 来源：Pi session id + subagent 路径。去 `packages/rotom-subagents` 找子进程能拿到的标识，并在 spawn 时把父 agentId 通过环境变量传给子进程（变量名自定，记录在 STATUS，并按 `docs/agent/internal-environment.md` 的规则登记）。
- `act_ui` 结果加 `leaseHolder`；冲突时返回结构化 `resource_busy`，不要抛成普通异常文本。

验收测试：在一个测试里起一个 broker、两个 bridge 实例（不同 agentId，platform backend 用假实现），验证冲突、stale、释放以及 `ROTOM_CU_BROKER=0` 回退。已有的 `test:runtime` 并发检查必须仍然通过。

### M3 策略与审批（TS）

范围：`src/policy/`（`catalog.ts`、`policy-store.ts`、`tiers.ts`、`sensitive.ts`、`host-exclusion.ts`），以及 Broker 里的审批路由。
- 按 PLAN 第 7 节实现授权三态、分级、高危提示、项目配置只能收紧、审批路由到最近的有 UI 的祖先、无 UI 时返回 `approval_unavailable`。
- Pi 侧审批 UI 用 extension context 的 UI 能力（`hasUI` 与确认/选择对话框），先在 `packages/rotom-pi/packages/coding-agent/src/core/extensions/types.ts` 确认可用的 API。
- “始终允许”写入 `~/.rotom/computer-use/policy.json`（0600，拒绝 symlink）。
- 宿主排除：根据 pid 祖先链找到宿主终端 App，从 `find_roots` 结果中剔除并拒绝以它为目标。

验收测试至少覆盖：动作 × 分级的完整矩阵（view/click/full 对每种 act_ui 动作和新工具的允许或拒绝）；项目配置试图放宽时被忽略；审批路由到祖先、无 UI 时拒绝；模型侧没有任何途径自我批准；敏感规则的正例和反例（中英文）；宿主终端不出现在 `find_roots` 里；policy 文件权限与 symlink 拒绝。

### M4 Trace（TS）

范围：`src/trace/`
- 按 PLAN 第 9 节实现：JSONL、`shots/`、权限、保留 7 天、单会话 500 MB、`trace_screenshots: false`、`ROTOM_CU_TRACE=0`、symlink 拒绝。
- 文本输入只记录长度和 SHA-256，不记录明文；secure field 不截图。
- `trace_export` 生成 Markdown 报告。
- 同步修改根 `CLAUDE.md` 第 5 节和 `docs/agent/` 相关文档，写明 Computer Use trace 默认保存截图是用户 2026-11-03 的明确决定，以及配套约束。

验收测试至少覆盖：权限；symlink 拒绝；保留期清理和容量清理（假时钟、小上限）；关闭开关后不写任何文件；JSONL 里搜不到 setText 的明文（用一段唯一的哨兵字符串断言）。

### M5 macOS 原生能力（Swift，需要 macOS）

范围：`native/macos/`、`src/platform/macos/`，helper 协议 7 → 8。
1. 新 AX 动作：select、setChecked、expand/collapse、scrollTo、focus、clear、setValue、showMenu。
2. 窗口与 App：AXPosition/AXSize 移动缩放、最小化与恢复、列出显示器、`NSWorkspace.openApplication`（`activates = false`）、礼貌退出。
3. 剪贴板 get/set/clear，以及 set 之后的定时恢复。
4. 系统表面：通知中心、菜单栏 extras、Dock 的 AX 访问。
5. L2：把 `background_text.swift` 的方案推广为通用定向键盘和鼠标通道，事件带 `eventSourceUserData` 标记，只对 `src/policy/l2-compat.ts` 白名单内的 App 启用。
6. listenOnly `CGEventTap` 用户活动监听，以及动作前后的前台 App 比较，推送给 Broker。
7. 菜单栏状态项（agent 列表、单独停止、全部停止）和全局快捷键 `Ctrl+Option+Cmd+.`；只有接管模式才吞 `Esc`。
8. 截图排除列表（宿主终端、helper 自身、cursor 覆盖层）。
9. lease token 的 HMAC 校验和撤销列表。共享密钥文件 0600，由 Broker 生成。
10. 协议 8 下仍然不自动重启别的会话的 daemon。

验证：
- 在 macOS 上：`node scripts/build-native.mjs --arch arm64 --sign-identity -` 编译通过；`test/background-text.swift` 及你新增的 Swift 确定性测试能执行则执行；`test/helper-protocol.test.ts` 覆盖协议 8 的匹配与不匹配。
- 不在 macOS 上：照样写代码，但在 STATUS 里把 M5 标为“未编译、未验证”，列出每个子项。不要声称编译通过。

### M6 工具面（TS）

范围：`extensions/computer-use.ts`、`src/contract.ts`、`src/bridge.ts`、`rotom/extensions/third-party/deferred-tools/`
- `act_ui` 新动作的 schema 和分发。
- 新 deferred 工具：`manage_app`、`manage_window`、`clipboard`、`system_surface`、`cu_session`。
- 结果字段：`deliveryLevel`、`leaseHolder`、`retry`、`interfered_with_user`、`stopped_by_user`、`preempted_by_user`。
- 更新 `scripts/check-tool-schemas.mjs`、第三方 index 测试里对 native/product schema 的比较，以及 deferred-tools 注册测试。
- 确认常驻 guideline bytes 不变（新工具都是 deferred）。

验收测试：每个新动作和工具在假 backend 下的 schema 校验与分发；分级拒绝在工具层可见；deferred 工具默认不常驻、`search_tools` 可以加载。

### M7 真机验收与兼容矩阵（需要 macOS + 权限）

范围：`packages/rotom-computer-use/test/fixtures/macos-fixture-app/`（一个小的 SwiftUI + AppKit App，包含文本框、列表、复选框、树、滑块、tab、右键菜单）、`scripts/check-cu-v2-live.mjs`、`scripts/cu-v2-compat-matrix.mjs`。
- 实现 PLAN 第 10 节的验收测试，用 `PI_CU_LIVE=1` 控制，不进默认测试。
- 兼容矩阵只针对 fixture App 和系统自带 App（TextEdit、备忘录、系统设置的只读页面、Finder 只读操作），**不操作用户的私人 App 和数据**。结果写到 `docs/agent/computer-use-v2/evidence/compat-matrix.md`，并据此更新 `l2-compat.ts`。
- 每次运行的文本日志放 `evidence/`。

不在 macOS 上：写好 fixture 和脚本，STATUS 标为“未运行”。

### M8 文档、版本与打包

- 组件版本改为 `0.5.1-rotom.3`，同步 `UPSTREAM.md`、`README.md`、`docs/*.md`、`rotom/extensions/third-party/computer-use/regression.md`、`docs/agent/change-checklists.md` 的 Computer Use 小节、根 `CLAUDE.md` 第 4 节（现在 Computer Use 有了确认层，但仍不是安全沙箱）。
- 打包：按 `UPSTREAM.md` 的“Rebuilding the archive”重建 vendored tgz，同步 third-party lock 和产品 integrity pin。**这一步需要 macOS 构建 helper**。不在 macOS 上就停在这一步之前，STATUS 写明。

## 3. 没有 macOS 时能做到哪里

| 里程碑 | 非 macOS | macOS |
|---|---|---|
| M1–M4、M6 | 完整实现并验证到 L1 | 同左 |
| M5 | 只写代码，标“未编译、未验证” | 编译、确定性测试 |
| M7 | 只写 fixture 和脚本 | 真机验收，L2 |
| M8 | 只改文档和版本号，不重建 tgz | 完整 |

## 4. 完成时

- 所有能做的里程碑都做完以后，在 STATUS 顶部写一段总结：完成了什么、验证到哪一层、什么没做以及原因、需要审核者回答的问题。
- 最后一次推送后不要再改分支，等审核结果。审核意见会以新的提交（`docs/agent/computer-use-v2/REVIEW.md`）出现在同一分支上。
